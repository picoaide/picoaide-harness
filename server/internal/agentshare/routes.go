package agentshare

import (
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
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

// maxDescriptionLen bounds a preset's display description (both backends
// store it in an unbounded TEXT column; the bound protects every surface
// that renders it).
const maxDescriptionLen = 500

// maxReasonLen bounds the admin's rejection reason shown to the author.
const maxReasonLen = 500

var presetIDRe = regexp.MustCompile("^" + util.PresetIDPattern + "$")

// versionRe accepts semver-ish version strings (no path separators).
var versionRe = regexp.MustCompile(`^[0-9a-zA-Z.-]{1,64}$`)

type PresetArchivePreview struct {
	// Files is the sorted list of archive-relative paths (user files only).
	Files   []string `json:"files"`
	Content string   `json:"composition"`
}

// preview reads one stored archive and returns the top-level composition
// (agent.cordis.yml) plus the full file list for admin review.
func preview(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		p, err := serverstore.GetAgentPreset(db, name)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		archivePath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
		raw, err := os.ReadFile(archivePath)
		if err != nil {
			if os.IsNotExist(err) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档文件缺失")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		files, composition, err := ListArchiveContents(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}
		c.JSON(http.StatusOK, gin.H{"files": files, "composition": composition})
	}
}

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
	g.GET("/:name/preview", preview(db, cacheDir))
	g.POST("/:name/approve", decide(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	g.POST("/:name/reject", decide(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	g.DELETE("/:name", remove(db, cacheDir))
	// 授权(审核通过后仍需授权才可见可装):按 name 授权(同名多版本共享)。
	g.GET("/:name/grants", listPresetGrants(db))
	g.PUT("/:name/grants", replacePresetGrants(db))
	g.PUT("/:name/grant", setPresetGrant(db, true))
	g.DELETE("/:name/grant", setPresetGrant(db, false))
}

func presetJSON(p serverstore.AgentPreset) gin.H {
	return gin.H{
		"name":         p.Name,
		"display_name": p.DisplayName,
		"description":  p.Description,
		"version":      p.Version,
		"author":       p.Author,
		"status":       p.Status,
		// Rejection reason: exposed only for the author's own rows (the
		// employee list endpoint serves approved rows too, where it is "").
		"reason":     p.Reason,
		"created_at": p.CreatedAt,
		"updated_at": p.UpdatedAt,
	}
}

func listVisible(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		var list []serverstore.AgentPreset
		if u.IsAdmin {
			// 管理员恒全量(不落授权表);仅已审核通过的进入员工可见清单位。
			all, err := serverstore.ListAgentPresets(db, "")
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range all {
				if p.Status == serverstore.AgentPresetApproved {
					list = append(list, p)
				}
			}
		} else {
			groups, err := serverstore.UserEffectiveGroups(db, u.ID)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			granted, err := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedPresetGrantTable, u.Username, groups)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			list, err = serverstore.ListVisibleAgentPresets(db, u.Username, granted)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
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
			DisplayName string `json:"display_name"`
			Version     string `json:"version"`
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
		if req.Version == "" {
			req.Version = "1.0.0"
		}
		if !versionRe.MatchString(req.Version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本号不合法")
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
		existing, getErr := serverstore.GetAgentPresetByVersion(db, req.Name, req.Version)
		switch {
		case getErr == nil && existing.Status != serverstore.AgentPresetRejected:
			// Pending or approved for this name+version: occupied.
			serverauth.WriteError(c, http.StatusConflict, "NAME_TAKEN", "该预设版本已被占用(审核中或已共享)")
			return
		case getErr != nil && !errors.Is(getErr, serverstore.ErrNotFound):
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}

		desc := strings.TrimSpace(req.Description)
		if len([]rune(desc)) > maxDescriptionLen {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "描述过长(上限 500 字)")
			return
		}

		// Store the archive (a rejected resubmit replaces its old file).
		if err := os.MkdirAll(cacheDir, 0700); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "存储失败")
			return
		}
		archivePath := filepath.Join(cacheDir, safeName(req.Name, req.Version))
		if err := writeFileAtomic(archivePath, raw); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档写入失败")
			return
		}

		if getErr == nil { // rejected → resubmit: reset the row
			if err := serverstore.UpdateAgentPresetResubmitByVersion(db, req.Name, req.Version, strings.TrimSpace(req.DisplayName), desc, checksum); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
				return
			}
		} else {
			p := &serverstore.AgentPreset{
				Name:        req.Name,
				DisplayName: strings.TrimSpace(req.DisplayName),
				Description: desc,
				Version:     req.Version,
				Author:      u.Username,
				Checksum:    checksum,
				Status:      serverstore.AgentPresetPending,
			}
			// Atomic cap enforcement: the INSERT itself re-counts pending
			// rows, so concurrent uploads can never exceed pendingCap.
			if _, err := serverstore.CreateAgentPresetCapped(db, p, pendingCap); err != nil {
				if errors.Is(err, serverstore.ErrTooManyPending) {
					serverauth.WriteError(c, http.StatusTooManyRequests, "PENDING_LIMIT", "待审核数量已达上限,请等待审核")
					return
				}
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
				return
			}
		}
		_ = serverstore.AuditLog(db, u.Username, "agent_preset_upload", req.Name+"@"+req.Version)
		c.JSON(http.StatusCreated, gin.H{"preset": gin.H{"name": req.Name, "version": req.Version, "status": serverstore.AgentPresetPending}})
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
// preset to all employees; rejecting hides it from everyone but its author,
// storing the admin's reason so the author can fix and resubmit.
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
		var reason string
		if status == serverstore.AgentPresetRejected {
			var body struct {
				Reason string `json:"reason"`
			}
			if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
				return
			}
			reason = strings.TrimSpace(body.Reason)
			if len([]rune(reason)) > maxReasonLen {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "拒绝理由过长(上限 500 字)")
				return
			}
			if reason == "" {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请填写拒绝理由")
				return
			}
		}
		if err := serverstore.SetAgentPresetStatus(db, name, status, reason); err != nil {
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

// grantReq carries {username} or {group} (webadmin sends @group).
type grantReq struct {
	Username string `json:"username"`
	Group    string `json:"group"`
}

func grantSubject(req grantReq) (string, serverstore.GranteeType, bool) {
	if req.Username != "" {
		return req.Username, serverstore.GranteeUser, true
	}
	if req.Group != "" {
		return req.Group, serverstore.GranteeGroup, true
	}
	return "", "", false
}

// listPresetGrants returns the grants on one shared agent preset (by name).
func listPresetGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		grants, err := serverstore.ListSharedResourceGrants(db, serverstore.SharedPresetGrantTable, c.Param("name"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if grants == nil {
			grants = []serverstore.Grant{}
		}
		c.JSON(http.StatusOK, gin.H{"grants": grants})
	}
}

// replacePresetGrants sets the full group-grant set of a shared preset.
func replacePresetGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		var req struct {
			Groups []string `json:"groups"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if err := serverstore.ReplaceSharedGroups(db, serverstore.SharedPresetGrantTable, name, req.Groups); err != nil {
			if err == serverstore.ErrValidation {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门名不合法或不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_grant", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// setPresetGrant adds/removes one user or group grant (idempotent).
func setPresetGrant(db *sql.DB, grant bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		var req grantReq
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		subject, t, ok := grantSubject(req)
		if !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少授权主体")
			return
		}
		var err error
		if grant {
			err = serverstore.GrantSharedResource(db, serverstore.SharedPresetGrantTable, name, subject, t)
		} else {
			err = serverstore.RevokeSharedResource(db, serverstore.SharedPresetGrantTable, name, subject, t)
		}
		if err != nil {
			if err == serverstore.ErrValidation {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权主体不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		action := "agent_preset_grant"
		if !grant {
			action = "agent_preset_revoke"
		}
		_ = serverstore.AuditLog(db, adminUsername(c), action, name+"@"+string(t)+":"+subject)
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
		// 授权检查:非 admin 下载须已授权(或为作者本人);否则与不存在同 404。
		if !admin {
			u := serverauth.CurrentUser(c)
			if u == nil {
				serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
				return
			}
			isAuthor := u.Username == p.Author
			if !isAuthor {
				groups, gErr := serverstore.UserEffectiveGroups(db, u.ID)
				if gErr != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				names, gErr := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedPresetGrantTable, u.Username, groups)
				if gErr != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				granted := false
				for _, n := range names {
					if n == p.Name {
						granted = true
						break
					}
				}
				if !granted {
					serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
					return
				}
			}
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
