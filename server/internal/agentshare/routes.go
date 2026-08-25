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
// (agent.cordis.yml) plus the full file list for admin review. When version
// is non-empty it addresses one row; empty addresses the name's latest row
// (legacy callers).
func preview(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		version := c.Param("version")
		if version != "" && !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本号不合法")
			return
		}
		var p *serverstore.AgentPreset
		var err error
		if version != "" {
			p, err = serverstore.GetAgentPresetByVersion(db, name, version)
		} else {
			p, err = serverstore.GetAgentPreset(db, name) // latest
		}
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
	g.GET("/:name/:version/archive", downloadVersioned(db, cacheDir, false))
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
	// 多版本端点(审计 2026-08-25 D-1):按 name@version 精确寻址,避免
	// 旧「最新版本」语义与 hardcoded 1.0.0 文件名的断链。
	g.GET("/:name/:version/archive", downloadVersioned(db, cacheDir, true))
	g.GET("/:name/:version/preview", preview(db, cacheDir))
	g.POST("/:name/:version/approve", decideVersioned(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	g.POST("/:name/:version/reject", decideVersioned(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	g.DELETE("/:name/:version", removeVersioned(db, cacheDir))
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

		// 作者校验(审计 2026-08-25 G1):rejected 行是某个作者上次提交的
		// 独占记录,只有其作者本人可以重提覆盖——否则任意用户可猜 name+version
		// 劫持他人提交并重置为 pending(内容替换 + 审核投毒 + 绕过 pendingCap)。
		if getErr == nil && existing.Author != u.Username {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}

		// 顺序约定(审计 2026-08-25 G4):DB 状态优先于文件落盘。
		// - 重提:先 DB 更新(作者校验在 SQL 内),成功后覆盖归档;DB 失败时
		//   旧归档原样保留,状态与文件始终一致(校验和失败方向 fail-closed)。
		// - 新建:先写文件再 INSERT 会造成 DB 失败(上限/冲突)时残留孤儿文件,
		//   因此在 INSERT 失败路径补偿删除刚写的文件。
		if err := os.MkdirAll(cacheDir, 0700); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "存储失败")
			return
		}
		archivePath := filepath.Join(cacheDir, safeName(req.Name, req.Version))
		if getErr == nil { // rejected → resubmit: reset the row (author-scoped)
			if err := serverstore.UpdateAgentPresetResubmitByVersion(db, req.Name, req.Version, strings.TrimSpace(req.DisplayName), desc, checksum, u.Username); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
				return
			}
			if err := writeFileAtomic(archivePath, raw); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档写入失败")
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
				// 补偿:INSERT 失败时删除刚写的归档,不留孤儿文件。
				_ = os.Remove(archivePath)
				if errors.Is(err, serverstore.ErrTooManyPending) {
					serverauth.WriteError(c, http.StatusTooManyRequests, "PENDING_LIMIT", "待审核数量已达上限,请等待审核")
					return
				}
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
				return
			}
			if err := writeFileAtomic(archivePath, raw); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档写入失败")
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

// decide approves or rejects one row (admin only). Legacy single-param form
// addresses the name's LATEST row (审计 2026-08-25 D-1:保留旧 UI 兼容,但
// 多版本端点 decideVersioned 应成为 webadmin 的首选)。
func decide(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		if _, err := serverstore.GetAgentPreset(db, name); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !decideBody(c, status) {
			return
		}
		if err := serverstore.SetAgentPresetStatus(db, name, status, reasonOf(c)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// decideVersioned approves or rejects one name@version row (admin only).
// 审计 2026-08-25 D-1:webadmin 多版本化后必须能按版本精确审核,
// 而不是只有「最新版本」行。
func decideVersioned(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if _, err := serverstore.GetAgentPresetByVersion(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !decideBody(c, status) {
			return
		}
		if err := serverstore.SetAgentPresetStatusByVersion(db, name, version, status, reasonOf(c)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, name+"@"+version)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// decideBody parses the optional rejection reason for a reject decision.
// Returns false (and writes the error response) when invalid.
func decideBody(c *gin.Context, status serverstore.AgentPresetStatus) bool {
	if status != serverstore.AgentPresetRejected {
		c.Set("preset_reason", "")
		return true
	}
	var body struct {
		Reason string `json:"reason"`
	}
	if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return false
	}
	reason := strings.TrimSpace(body.Reason)
	if len([]rune(reason)) > maxReasonLen {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "拒绝理由过长(上限 500 字)")
		return false
	}
	if reason == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请填写拒绝理由")
		return false
	}
	c.Set("preset_reason", reason)
	return true
}

// reasonOf reads the parsed rejection reason set by decideBody.
func reasonOf(c *gin.Context) string {
	if v, ok := c.Get("preset_reason"); ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

// remove deletes ALL rows of a name plus every archive file of that name
// (审计 2026-08-25 D-1:旧实现只删 1.0.0,遗留其它版本孤儿归档)。
func remove(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		rows, err := serverstore.ListAgentPresets(db, "")
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		versions := make([]string, 0, 4)
		for _, p := range rows {
			if p.Name == name {
				versions = append(versions, p.Version)
			}
		}
		if len(versions) == 0 {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}
		if err := serverstore.DeleteAgentPreset(db, name); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		// Best-effort archive cleanup: every version of the name.
		for _, v := range versions {
			_ = os.Remove(filepath.Join(cacheDir, safeName(name, v)))
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_delete", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// removeVersioned deletes one name@version row plus its archive.
func removeVersioned(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if err := serverstore.DeleteAgentPresetByVersion(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		_ = os.Remove(filepath.Join(cacheDir, safeName(name, version)))
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_delete", name+"@"+version)
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
		// 存在性校验(审计 2026-08-25 G5):与 marketplace 的 applyGrant 对齐,
		// 防拼错主体导致「资源永远对某人可见/不可见」的静默授权错误。
		if grant {
			exists := false
			if t == serverstore.GranteeUser {
				_, uErr := serverstore.GetUserByUsername(db, subject)
				exists = uErr == nil
			} else {
				_, gErr := serverstore.GroupByName(db, subject)
				exists = gErr == nil
			}
			if !exists {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权主体不存在")
				return
			}
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

// download serves the stored archive of the name's LATEST row (legacy
// single-param form). Employees may download only approved presets (anything
// else is the same 404 as "does not exist", so the review queue of other
// people is never leaked); admins may download any row.
func download(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
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
		serveArchive(c, db, cacheDir, p, admin)
	}
}

// downloadVersioned serves the stored archive of one name@version row.
func downloadVersioned(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !presetIDRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		p, err := serverstore.GetAgentPresetByVersion(db, name, version)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		serveArchive(c, db, cacheDir, p, admin)
	}
}

// serveArchive performs the status/auth checks and streams the archive for
// one resolved row; it writes the error response on any refusal.
// 审计 2026-08-25 D-1:文件路径用 p.Version(与上传一致),不再硬编码
// "1.0.0"(多版本下载曾必然 500「归档文件缺失」)。
func serveArchive(c *gin.Context, db *sql.DB, cacheDir string, p *serverstore.AgentPreset, admin bool) {
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
	archivePath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
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
