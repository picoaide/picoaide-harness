package agentshare

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// pendingCap is the per-author cap on rows awaiting review: an employee may
// not flood the review queue; resubmitting a rejected name is always allowed.
const pendingCap = 10

var presetIDRe = regexp.MustCompile("^" + util.PresetIDPattern + "$")

// RegisterRoutes mounts /api/agent-presets (employee Bearer endpoints).
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	g := r.Group("/api/agent-presets", serverauth.BearerAuth(db))
	g.GET("", listVisible(db))
	g.POST("", upload(db, cacheDir))
	g.GET("/:name/archive", download(db, cacheDir, false))
}

// RegisterAdminRoutes mounts /api/admin/agent-presets (AdminAuth endpoints).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	g := r.Group("/api/admin/agent-presets", serverauth.AdminAuth(db))
	g.GET("", listAll(db))
	g.GET("/:name/archive", download(db, cacheDir, true))
	g.POST("/:name/approve", decide(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	g.POST("/:name/reject", decide(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	g.DELETE("/:name", remove(db, cacheDir))
}

func presetJSON(p serverstore.AgentPreset) gin.H {
	return gin.H{
		"name":         p.Name,
		"display_name": p.DisplayName,
		"description":  p.Description,
		"version":      p.Version,
		"author":       p.Author,
		"status":       p.Status,
		"created_at":   p.CreatedAt,
		"updated_at":   p.UpdatedAt,
	}
}

func listVisible(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		list, err := serverstore.ListVisibleAgentPresets(db, u.Username)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, p := range list {
			out = append(out, presetJSON(p))
		}
		c.JSON(http.StatusOK, gin.H{"presets": out})
	}
}

// upload accepts one preset archive (base64 in JSON), validates it, stores
// it, and creates (or reuses on resubmit of a rejected name) a pending row.
// Semantics: a name already pending/approved is refused (409) — a rejected
// name may be resubmitted, which resets the row to pending with the new bytes.
func upload(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > MaxBodyBytes {
			serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "归档过大")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxBodyBytes)
		var req struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Archive     string `json:"archive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !presetIDRe.MatchString(req.Name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法(小写字母/数字/中划线)")
			return
		}
		if len(req.Archive) == 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少归档内容")
			return
		}
		raw, err := base64.StdEncoding.DecodeString(req.Archive)
		if err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归档编码错误")
			return
		}
		checksum, err := ValidatePresetArchive(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}

		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		existing, getErr := serverstore.GetAgentPreset(db, req.Name)
		switch {
		case getErr == nil && existing.Status != serverstore.AgentPresetRejected:
			// Pending or approved: the name is occupied.
			serverauth.WriteError(c, http.StatusConflict, "NAME_TAKEN", "该预设名已被占用(审核中或已共享)")
			return
		case getErr != nil && !errors.Is(getErr, serverstore.ErrNotFound):
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		case errors.Is(getErr, serverstore.ErrNotFound):
			// Fresh upload: enforce the per-author pending cap.
			n, err := countPending(db, u.Username)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			if n >= pendingCap {
				serverauth.WriteError(c, http.StatusTooManyRequests, "PENDING_LIMIT", "待审核数量已达上限,请等待审核")
				return
			}
		}

		// Store the archive (a rejected resubmit replaces its old file).
		if err := os.MkdirAll(cacheDir, 0700); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "存储失败")
			return
		}
		archivePath := filepath.Join(cacheDir, safeName(req.Name, "1.0.0"))
		if err := writeFileAtomic(archivePath, raw); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档写入失败")
			return
		}

		desc := strings.TrimSpace(req.Description)
		if getErr == nil { // rejected → resubmit: reset the row
			if err := serverstore.UpdateAgentPresetResubmit(db, req.Name, desc, checksum); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
				return
			}
		} else {
			p := &serverstore.AgentPreset{
				Name:        req.Name,
				Description: desc,
				Version:     "1.0.0",
				Author:      u.Username,
				Checksum:    checksum,
				Status:      serverstore.AgentPresetPending,
			}
			if _, err := serverstore.CreateAgentPreset(db, p); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
				return
			}
		}
		_ = serverstore.AuditLog(db, u.Username, "agent_preset_upload", req.Name)
		c.JSON(http.StatusCreated, gin.H{"preset": gin.H{"name": req.Name, "status": serverstore.AgentPresetPending}})
	}
}

func listAll(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListAgentPresets(db, c.Query("status"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, p := range list {
			out = append(out, presetJSON(p))
		}
		c.JSON(http.StatusOK, gin.H{"presets": out})
	}
}

// decide approves or rejects one row (admin only). Approving publishes the
// preset to all employees; rejecting hides it from everyone but its author.
func decide(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if _, err := serverstore.GetAgentPreset(db, name); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if err := serverstore.SetAgentPresetStatus(db, name, status); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func remove(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if err := serverstore.DeleteAgentPreset(db, name); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		// Best-effort archive cleanup; the row is the source of truth.
		_ = os.Remove(filepath.Join(cacheDir, safeName(name, "1.0.0")))
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_delete", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// download serves the stored archive. Employees may download only approved
// presets (anything else is the same 404 as "does not exist", so the review
// queue of other people is never leaked); admins may download any row.
func download(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		p, err := serverstore.GetAgentPreset(db, name)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !admin && p.Status != serverstore.AgentPresetApproved {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}
		if !presetIDRe.MatchString(p.Name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		archivePath := filepath.Join(cacheDir, safeName(p.Name, "1.0.0"))
		if _, err := os.Stat(archivePath); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档文件缺失")
			return
		}
		c.Header("Content-Type", "application/gzip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName(p.Name, p.Version)))
		c.Header("X-Preset-Version", p.Version)
		c.Header("X-Preset-Checksum", p.Checksum)
		c.File(archivePath)
	}
}

func countPending(db *sql.DB, author string) (int, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM agent_presets WHERE author=? AND status=?`, author, serverstore.AgentPresetPending).Scan(&n)
	return n, err
}

// archiveErrorMessage maps validation refusals to the client-facing message.
func archiveErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrArchiveTooLarge):
		return fmt.Sprintf("归档过大(上限 %dMB)", MaxArchiveBytes>>20)
	case errors.Is(err, ErrUnsafeArchive):
		return "归档内容不安全(路径越界或链接文件)"
	case errors.Is(err, ErrNoComposition):
		return "归档缺少 agent.cordis.yml"
	case errors.Is(err, ErrEntryLimit):
		return "归档条目过多"
	default:
		return "归档校验失败"
	}
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}

// writeFileAtomic writes data to path via a temp file + rename (0600).
func writeFileAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".upload-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
