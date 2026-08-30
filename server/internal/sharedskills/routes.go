// Package sharedskills implements the shared-skill store: employees upload
// local skills (SKILL.md bundles), admins review them, and every approved
// version is visible and installable by all employees. Mirrors agentshare
// with multi-version keying (name+version).
package sharedskills

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// Limits: the raw gzipped tar a client may upload, the total unpacked tree
// size, entry count, and the request body ceiling (base64 inflation).
const (
	MaxArchiveBytes   = 16 << 20
	MaxUnpackedBytes  = 64 << 20
	MaxArchiveEntries = 10000
	MaxBodyBytes      = 24 << 20
)

// pendingCap is the per-author cap on rows awaiting review.
const pendingCap = 10

// maxDescriptionLen bounds display metadata (both surfaces).
const maxDescriptionLen = 500

var (
	// ErrArchiveInvalid: the archive failed structural validation.
	ErrArchiveInvalid = errors.New("archive invalid")
	// ErrNoSkillMarkdown: the archive carries no top-level SKILL.md.
	ErrNoSkillMarkdown = errors.New("archive has no SKILL.md at its root")
	// ErrUnsafeArchive: entry path escapes or is a link.
	ErrUnsafeArchive = errors.New("unsafe archive")
)

// skillNameRe matches a single safe directory segment (mirrors the client
// installer's SKILL_NAME_PATTERN).
var skillNameRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// versionRe accepts semver-ish strings without path separators (1.0.0, v2).
var versionRe = regexp.MustCompile(`^[0-9a-zA-Z.-]{1,64}$`)

// RegisterRoutes mounts /api/shared-skills (employee Bearer endpoints).
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/client/v2/shared-skills"
	g := r.Group(base, serverauth.BearerAuth(db))
	g.GET("", listVisible(db))
	g.POST("", upload(db, cacheDir))
	g.GET("/:name/:version/archive", download(db, cacheDir, false))
}

// RegisterAdminRoutes mounts /api/admin/shared-skills (AdminAuth + RBAC v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin/shared-skills"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "", serverauth.PermCapabilityRead, listAll(db))
	serverauth.AdminRoute(g, "GET", "/:name/:version/archive", serverauth.PermCapabilityRead, download(db, cacheDir, true))
	serverauth.AdminRoute(g, "GET", "/:name/:version/preview", serverauth.PermCapabilityRead, preview(db, cacheDir))
	serverauth.AdminRoute(g, "POST", "/:name/:version/approve", serverauth.PermCapabilityWrite, decide(db, serverstore.SharedSkillApproved, "shared_skill_approve"))
	serverauth.AdminRoute(g, "POST", "/:name/:version/reject", serverauth.PermCapabilityWrite, decide(db, serverstore.SharedSkillRejected, "shared_skill_reject"))
	serverauth.AdminRoute(g, "DELETE", "/:name/:version", serverauth.PermCapabilityWrite, remove(db, cacheDir))
	// 质量标记(0037):仅 approved 行可设置/清除(official/featured,互斥)。
	serverauth.AdminRoute(g, "PUT", "/:name/:version/quality", serverauth.PermCapabilityWrite, setQuality(db))
	// 单文件内容(审核查看):从归档提取指定文件内容,支持文本/二进制/超大。
	serverauth.AdminRoute(g, "GET", "/:name/:version/file", serverauth.PermCapabilityRead, fileContent(db, cacheDir))
	// 授权(审核通过后仍需授权才可见可装):按 name 授权(同名多版本共享)。
	serverauth.AdminRoute(g, "GET", "/:name/grants", serverauth.PermCapabilityRead, listGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grants", serverauth.PermCapabilityWrite, replaceGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grant", serverauth.PermCapabilityWrite, setGrant(db, true))
	serverauth.AdminRoute(g, "DELETE", "/:name/grant", serverauth.PermCapabilityWrite, setGrant(db, false))
}

func rowJSON(s serverstore.SharedSkill) gin.H {
	return gin.H{
		"name":         s.Name,
		"display_name": s.DisplayName,
		"version":      s.Version,
		"description":  s.Description,
		"author":       s.Author,
		"status":       s.Status,
		"reason":       s.Reason,
		"quality":      s.Quality, // 0037 组织库质量标记(official/featured)
		"downloads":    s.Downloads,
		"calls":        s.Calls,
		"created_at":   s.CreatedAt,
		"updated_at":   s.UpdatedAt,
	}
}

// viewer resolves the calling user's effective groups (department tree) and
// admin flag. Returns ok=false when unauthenticated.
func viewer(c *gin.Context, db *sql.DB) (u *serverstore.User, groups []string, ok bool) {
	u = serverauth.CurrentUser(c)
	if u == nil {
		return nil, nil, false
	}
	groups, err := serverstore.UserEffectiveGroups(db, u.ID)
	if err != nil {
		return nil, nil, false
	}
	return u, groups, true
}

func listVisible(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		u, groups, ok := viewer(c, db)
		if !ok {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		var list []serverstore.SharedSkill
		if u.IsAdmin {
			// Admins see everything already approved (admin 恒全量,不落授权表).
			all, err := serverstore.ListSharedSkills(db, "")
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, s := range all {
				if s.Status == serverstore.SharedSkillApproved {
					list = append(list, s)
				}
			}
		} else {
			granted, err := serverstore.AccessibleSharedResourceNames(db, serverstore.SharedSkillGrantTable, u.Username, groups)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			list, err = serverstore.ListVisibleSharedSkills(db, u.Username, granted)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
		}
		out := make([]gin.H, 0, len(list))
		for _, s := range list {
			out = append(out, rowJSON(s))
		}
		c.JSON(http.StatusOK, gin.H{"skills": out})
	}
}

func upload(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > MaxBodyBytes {
			serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "PAYLOAD_TOO_LARGE", "归档过大")
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, MaxBodyBytes)
		var req struct {
			Name        string `json:"name"`
			DisplayName string `json:"display_name"`
			Version     string `json:"version"`
			Description string `json:"description"`
			Archive     string `json:"archive"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !skillNameRe.MatchString(req.Name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法(小写字母/数字/点/横线,以字母数字开头)")
			return
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
		checksum, err := ValidateSkillArchive(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}

		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		existing, getErr := serverstore.GetSharedSkill(db, req.Name, req.Version)
		switch {
		case getErr == nil && existing.Status != serverstore.SharedSkillRejected:
			serverauth.WriteError(c, http.StatusConflict, "NAME_TAKEN", "该技能版本已被占用(审核中或已共享)")
			return
		case getErr != nil && !errors.Is(getErr, serverstore.ErrNotFound):
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		desc := strings.TrimSpace(req.Description)
		display := strings.TrimSpace(req.DisplayName)
		if len([]rune(display)) > maxDescriptionLen || len([]rune(desc)) > maxDescriptionLen {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "描述过长(上限 500 字)")
			return
		}

		// 作者校验(审计 2026-08-25 G1):rejected 行是某作者上次提交的独占
		// 记录,只有作者本人可重提覆盖——防止他人劫持内容并重置为 pending。
		if getErr == nil && existing.Author != u.Username {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}

		// 顺序约定(审计 2026-08-25 G4):DB 状态优先于文件落盘。
		// 重提:先 DB(作者校验在 SQL 内)成功后覆盖归档;新建:DB 失败补偿删除。
		// 0040:归档直存 DB(共享技能上传不再落磁盘;pre-0040 行的磁盘回退
		// 只在下载/预览读取时触发,写路径一律 DB)。
		if getErr == nil {
			if err := serverstore.UpdateSharedSkillResubmit(db, req.Name, req.Version, display, desc, checksum, u.Username); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
				return
			}
			if err := serverstore.SetSharedSkillArchive(db, req.Name, req.Version, raw); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档写入失败")
				return
			}
		} else {
			s := &serverstore.SharedSkill{
				Name:        req.Name,
				DisplayName: display,
				Version:     req.Version,
				Description: desc,
				Author:      u.Username,
				Checksum:    checksum,
				Status:      serverstore.SharedSkillPending,
				Archive:     raw,
			}
			if _, err := serverstore.CreateSharedSkillCapped(db, s, pendingCap); err != nil {
				// 补偿:INSERT 失败时无归档落盘(DB 未写入即无孤儿对象)。
				if errors.Is(err, serverstore.ErrTooManyPending) {
					serverauth.WriteError(c, http.StatusTooManyRequests, "PENDING_LIMIT", "待审核数量已达上限,请等待审核")
					return
				}
				if errors.Is(err, serverstore.ErrConflict) {
					// 决策 2026-08-25:市场与组织合并为「市场」后,同名技能跨源
					// 互斥——市场技能表已有同名时,员工上传即阻断(409)。
					serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "名称与市场技能冲突,请换个名字或联系管理员")
					return
				}
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
				return
			}
		}
		_ = serverstore.AuditLog(db, u.Username, "shared_skill_upload", req.Name+"@"+req.Version)
		c.JSON(http.StatusCreated, gin.H{"skill": gin.H{"name": req.Name, "version": req.Version, "status": serverstore.SharedSkillPending}})
	}
}

func listAll(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListSharedSkills(db, c.Query("status"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, s := range list {
			out = append(out, rowJSON(s))
		}
		c.JSON(http.StatusOK, gin.H{"skills": out})
	}
}

// decide approves or rejects one shared skill row (admin only). Rejecting
// requires a reason, which the author sees and which is cleared on resubmit.
func decide(db *sql.DB, status serverstore.SharedSkillStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if _, err := serverstore.GetSharedSkill(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		var reason string
		if status == serverstore.SharedSkillRejected {
			var body struct {
				Reason string `json:"reason"`
			}
			if err := c.ShouldBindJSON(&body); err != nil && !errors.Is(err, io.EOF) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
				return
			}
			reason = strings.TrimSpace(body.Reason)
			if len([]rune(reason)) > maxDescriptionLen {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "拒绝理由过长(上限 500 字)")
				return
			}
			if reason == "" {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请填写拒绝理由")
				return
			}
		}
		// 决策 2026-08-25:审核通过前检测跨源同名——市场技能表已有同名技能
		// 时,approve 拒绝(409),要求管理员先处理市场技能或驳回该共享技能。
		if status == serverstore.SharedSkillApproved {
			conflict, err := serverstore.SkillNameExists(db, name)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			if conflict {
				serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "名称与市场技能冲突,请先处理市场技能或驳回该共享技能")
				return
			}
		}
		if err := serverstore.SetSharedSkillStatus(db, name, version, status, reason); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, name+"@"+version)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
func remove(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if err := serverstore.DeleteSharedSkill(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		_ = serverstore.DeleteSharedSkillArchive(db, name, version)
		// 硬删行后必须清理全部授权(资源级联;旧授权不得复活重建的资源)。
		_ = serverstore.DeleteSharedResourceGrants(db, serverstore.SharedSkillGrantTable, name)
		// path-injection 防护(审计 2026-08-30 CodeQL go/path-injection):
		// name/version 来自 URL 参数, safeName 只做字符串拼接; 此处补一道
		// SafePathSegment 校验, 非法段直接跳过文件删除(DB 行删除不受影响)。
		safe := safeName(name, version)
		if safe != "" && util.SafePathSegment(name) && util.SafePathSegment(version) {
			_ = os.Remove(filepath.Join(cacheDir, safe))
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "shared_skill_delete", name+"@"+version)
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

// listGrants returns the grants on one shared skill (by name).
func listGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		grants, err := serverstore.ListSharedResourceGrants(db, serverstore.SharedSkillGrantTable, name)
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

// replaceGrants sets the full group-grant set of a shared skill (user grants
// untouched), mirroring the marketplace contract.
func replaceGrants(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		var req struct {
			Groups []string `json:"groups"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if err := serverstore.ReplaceSharedGroups(db, serverstore.SharedSkillGrantTable, name, req.Groups); err != nil {
			if err == serverstore.ErrValidation || err == serverstore.ErrNotFound {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门名不合法或不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "shared_skill_grant", name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// setQuality sets/clears the quality tag of one approved shared skill
// (”|official|featured). Only approved rows may carry a tag; the tag is
// mutual-exclusive (one per row), and audit as shared_skill_qualify.
func setQuality(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		var req struct {
			Quality string `json:"quality"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !serverstore.ValidSharedQuality(req.Quality) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法(空/official/featured)")
			return
		}
		if err := serverstore.SetSharedSkillQuality(db, name, version, req.Quality); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在或未通过审核")
				return
			}
			if errors.Is(err, serverstore.ErrValidation) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "shared_skill_qualify", name+"@"+version+"="+req.Quality)
		c.JSON(http.StatusOK, gin.H{"ok": true, "quality": req.Quality})
	}
}

// setGrant adds/removes one user or group grant (idempotent).
func setGrant(db *sql.DB, grant bool) gin.HandlerFunc {
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
		// 存在性校验(审计 2026-08-25 G5):与 marketplace 对齐,防拼错主体。
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
			err = serverstore.GrantSharedResource(db, serverstore.SharedSkillGrantTable, name, subject, t)
		} else {
			err = serverstore.RevokeSharedResource(db, serverstore.SharedSkillGrantTable, name, subject, t)
		}
		if err != nil {
			if err == serverstore.ErrValidation {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权主体不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "授权失败")
			return
		}
		action := "shared_skill_grant"
		if !grant {
			action = "shared_skill_revoke"
		}
		_ = serverstore.AuditLog(db, adminUsername(c), action, name+"@"+string(t)+":"+subject)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// download serves the stored archive. Employees may download only approved
// rows; admins any row.
func download(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !skillNameRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		s, err := serverstore.GetSharedSkill(db, name, version)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !admin && s.Status != serverstore.SharedSkillApproved {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		// 授权检查:非 admin 下载须已授权(或为作者本人)。
		if !admin {
			u := serverauth.CurrentUser(c)
			if u == nil {
				serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
				return
			}
			isAuthor := u.Username == s.Author
			granted := false
			if !isAuthor {
				groups, err := serverstore.UserEffectiveGroups(db, u.ID)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				var names []string
				names, err = serverstore.AccessibleSharedResourceNames(db, serverstore.SharedSkillGrantTable, u.Username, groups)
				if err != nil {
					serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
					return
				}
				for _, n := range names {
					if n == s.Name {
						granted = true
						break
					}
				}
			}
			if !isAuthor && !granted {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
		}
		// 0040:归档直存 DB;pre-0040 行的磁盘回退(read-only)。
		var payload []byte
		dbRaw, err := serverstore.GetSharedSkillArchive(db, s.Name, s.Version)
		switch {
		case err == nil && dbRaw != nil:
			payload = dbRaw
		case err == nil && dbRaw == nil:
			// 老库行无 DB 归档:读磁盘(兼容迁移前的上传)。
			diskPath := filepath.Join(cacheDir, safeName(s.Name, s.Version))
			if raw, rerr := os.ReadFile(diskPath); rerr == nil {
				payload = raw
			} else {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档数据缺失")
				return
			}
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		c.Header("Content-Type", "application/gzip")
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", safeName(s.Name, s.Version)))
		c.Header("X-Skill-Version", s.Version)
		c.Header("X-Skill-Checksum", s.Checksum)
		_, _ = serverstore.IncrementSharedSkillDownload(db, s.Name, s.Version)
		c.Data(http.StatusOK, "application/gzip", payload)
	}
}

// preview returns the top-level SKILL.md content plus the full file list for
// admin review.
func preview(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !skillNameRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		s, err := serverstore.GetSharedSkill(db, name, version)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// 0040:归档直存 DB;老库行回退磁盘(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetSharedSkillArchive(db, s.Name, s.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(s.Name, s.Version))
			if r, rerr := os.ReadFile(diskPath); rerr == nil {
				raw = r
			} else {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档数据缺失")
				return
			}
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		files, content, err := ListArchiveContents(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}
		c.JSON(http.StatusOK, gin.H{"files": files, "skill_md": content})
	}
}

// maxFilePreviewBytes caps the inline text returned by the per-file review
// endpoint; larger files are flagged for archive download instead.
const maxFilePreviewBytes = 1 << 20

// fileContent returns one file's content from a stored archive so admins can
// review every uploaded file (审核查看全部内容)。Text (UTF-8) files are
// returned inline capped at 1MB; binary or oversized entries are flagged for
// archive download. Admin-only: the payload never leaves the review flow.
func fileContent(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !skillNameRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		target := c.Query("path")
		if target == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少文件路径")
			return
		}
		norm, err := posixNormalize(target)
		if err != nil || norm == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
			return
		}
		s, gerr := serverstore.GetSharedSkill(db, name, version)
		if gerr != nil {
			if errors.Is(gerr, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// 0040:归档直存 DB;pre-0040 行的磁盘回退(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetSharedSkillArchive(db, s.Name, s.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(s.Name, s.Version))
			if r, rerr := os.ReadFile(diskPath); rerr == nil {
				raw = r
			} else {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档数据缺失")
				return
			}
		default:
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
			return
		}
		content, size, found, binary, tooLarge, xerr := extractFileContent(raw, norm)
		if xerr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(xerr))
			return
		}
		if !found {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档中不存在该文件")
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"path":      norm,
			"size":      size,
			"binary":    binary,
			"too_large": tooLarge,
			"content":   content,
		})
	}
}

// extractFileContent finds one archive entry by normalized path and returns
// its text content. Binary (non-UTF-8) and oversized entries return flags
// instead of payload; the caller decides how to present them.
func extractFileContent(data []byte, target string) (content string, size int64, found, binary, tooLarge bool, err error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", 0, false, false, false, ErrUnsafeArchive
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, herr := tr.Next()
		if herr == io.EOF {
			break
		}
		if herr != nil {
			return "", 0, false, false, false, ErrUnsafeArchive
		}
		if hdr.Typeflag == tar.TypeDir || hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		name, nerr := posixNormalize(hdr.Name)
		if nerr != nil || name == "" {
			continue
		}
		if name != target {
			continue
		}
		size = hdr.Size
		if hdr.Size > maxFilePreviewBytes {
			return "", size, true, false, true, nil
		}
		buf := make([]byte, hdr.Size)
		if _, err := io.ReadFull(tr, buf); err != nil {
			return "", size, true, false, false, ErrUnsafeArchive
		}
		if !utf8.Valid(buf) {
			return "", size, true, true, false, nil
		}
		return string(buf), size, true, false, false, nil
	}
	return "", 0, false, false, false, nil
}

// ValidateSkillArchive lists a gzipped tar stream without extracting it,
// refusing unsafe entries, bounding size/entry count, and requiring a
// top-level SKILL.md. Returns the archive's sha256 hex.
func ValidateSkillArchive(data []byte) (string, error) {
	if len(data) == 0 || len(data) > MaxArchiveBytes {
		return "", ErrArchiveInvalid
	}
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	zr, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return "", ErrUnsafeArchive
	}
	tr := tar.NewReader(zr)
	var total int64
	entries := 0
	hasSkillMd := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", ErrUnsafeArchive
		}
		entries++
		if entries > MaxArchiveEntries {
			return "", ErrArchiveInvalid
		}
		name, err := posixNormalize(hdr.Name)
		if err != nil {
			return "", err
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return "", ErrUnsafeArchive
		}
		if name == "" {
			return "", ErrUnsafeArchive
		}
		total += hdr.Size
		if total > MaxUnpackedBytes {
			return "", ErrArchiveInvalid
		}
		if name == "SKILL.md" {
			hasSkillMd = true
		}
	}
	if !hasSkillMd {
		return "", ErrNoSkillMarkdown
	}
	return hexSum, nil
}

// ListArchiveContents lists non-directory entry paths (sorted, unique) and
// returns the top-level SKILL.md content for admin review.
func ListArchiveContents(data []byte) ([]string, string, error) {
	zr, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return nil, "", ErrUnsafeArchive
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	set := map[string]bool{}
	var skillMd string
	var order []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", ErrUnsafeArchive
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		name, err := posixNormalize(hdr.Name)
		if err != nil {
			return nil, "", ErrUnsafeArchive
		}
		if name == "" || hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		if name == "SKILL.md" && skillMd == "" && hdr.Size <= 1<<20 {
			buf := make([]byte, hdr.Size)
			if _, err := io.ReadFull(tr, buf); err != nil {
				return nil, "", ErrUnsafeArchive
			}
			skillMd = string(buf)
		}
		if !set[name] {
			set[name] = true
			order = append(order, name)
		}
	}
	// sort the file list
	for i := 1; i < len(order); i++ {
		for j := i; j > 0 && order[j] < order[j-1]; j-- {
			order[j], order[j-1] = order[j-1], order[j]
		}
	}
	return order, skillMd, nil
}

func posixNormalize(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if strings.HasPrefix(raw, "/") {
		return "", ErrUnsafeArchive
	}
	parts := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
	out := make([]string, 0, len(parts))
	for _, segment := range parts {
		switch segment {
		case "", ".":
			continue
		case "..":
			return "", ErrUnsafeArchive
		default:
			out = append(out, segment)
		}
	}
	return strings.Join(out, "/"), nil
}

func archiveErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrNoSkillMarkdown):
		return "归档缺少 SKILL.md"
	case errors.Is(err, ErrUnsafeArchive):
		return "归档内容不安全(路径越界或链接文件)"
	case errors.Is(err, ErrArchiveInvalid):
		return "归档过大或结构非法"
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

// safeName 构造归档文件名; 严格白名单(CodeQL path-injection sanitizer):
// name/version 仅允许 [A-Za-z0-9._-], 非法则返回空串(调用方跳过文件操作)。
var safeSeg = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func safeName(name, version string) string {
	if !safeSeg.MatchString(name) || !safeSeg.MatchString(version) {
		return ""
	}
	return fmt.Sprintf("%s-%s.tar.gz", name, version)
}
