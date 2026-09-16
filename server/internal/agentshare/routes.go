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

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/skillmanifest"
	"github.com/picoaide/picoaide/internal/util"
)

// pendingCap is the per-author cap on rows awaiting review: an employee may
// not flood the review queue; resubmitting a rejected name is always allowed.
const pendingCap = 10

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
		// agentshare-2:审核预览只服务组织共享库。
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
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
		files, composition, err := ListArchiveContents(raw)
		if err != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(err))
			return
		}
		c.JSON(http.StatusOK, gin.H{"files": files, "composition": composition})
	}
}

// presetFileContent returns one file's content from a stored preset archive so
// admins can review every uploaded file (审核查看全部内容)。Text (UTF-8) files
// are returned inline capped at 1MB; binary or oversized entries are flagged
// for archive download. Admin-only; version-empty resolves the name's latest
// row (legacy callers).
func presetFileContent(db *sql.DB, cacheDir string) gin.HandlerFunc {
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
		target := c.Query("path")
		if target == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少文件路径")
			return
		}
		norm, err := archiveutil.NormalizePath(target)
		if err != nil || norm == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
			return
		}
		var p *serverstore.AgentPreset
		var gerr error
		if version != "" {
			p, gerr = serverstore.GetAgentPresetByVersion(db, name, version)
		} else {
			p, gerr = serverstore.GetAgentPreset(db, name)
		}
		if gerr != nil {
			if errors.Is(gerr, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// agentshare-2:逐文件审核只服务组织共享库。
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
		var raw []byte
		dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
		switch {
		case aerr == nil && dbRaw != nil:
			raw = dbRaw
		case aerr == nil:
			diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
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
		content, size, found, binary, tooLarge, xerr := ExtractFileContent(raw, norm)
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

// RegisterRoutes mounts /api/agent-presets (employee Bearer endpoints).
func RegisterRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/client/v2/agent-presets"
	g := r.Group(base, serverauth.BearerAuth(db))
	g.GET("", listVisible(db))
	g.POST("", upload(db, cacheDir))
	g.GET("/:name/archive", download(db, cacheDir, false))
	g.GET("/:name/:version/archive", downloadVersioned(db, cacheDir, false))
}

// RegisterAdminRoutes mounts /api/server/admin/agent-presets (AdminAuth + RBAC v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin/agent-presets"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "", serverauth.PermCapabilityRead, listAll(db))
	serverauth.AdminRoute(g, "GET", "/:name/archive", serverauth.PermCapabilityRead, download(db, cacheDir, true))
	serverauth.AdminRoute(g, "GET", "/:name/preview", serverauth.PermCapabilityRead, preview(db, cacheDir))
	serverauth.AdminRoute(g, "POST", "/:name/approve", serverauth.PermCapabilityWrite, decide(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	serverauth.AdminRoute(g, "POST", "/:name/reject", serverauth.PermCapabilityWrite, decide(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	serverauth.AdminRoute(g, "DELETE", "/:name", serverauth.PermCapabilityWrite, remove(db, cacheDir))
	// 多版本端点(审计 2026-08-25 D-1):按 name@version 精确寻址,避免
	// 旧「最新版本」语义与 hardcoded 1.0.0 文件名的断链。
	serverauth.AdminRoute(g, "GET", "/:name/:version/archive", serverauth.PermCapabilityRead, downloadVersioned(db, cacheDir, true))
	serverauth.AdminRoute(g, "GET", "/:name/:version/preview", serverauth.PermCapabilityRead, preview(db, cacheDir))
	serverauth.AdminRoute(g, "POST", "/:name/:version/approve", serverauth.PermCapabilityWrite, decideVersioned(db, serverstore.AgentPresetApproved, "agent_preset_approve"))
	serverauth.AdminRoute(g, "POST", "/:name/:version/reject", serverauth.PermCapabilityWrite, decideVersioned(db, serverstore.AgentPresetRejected, "agent_preset_reject"))
	serverauth.AdminRoute(g, "DELETE", "/:name/:version", serverauth.PermCapabilityWrite, removeVersioned(db, cacheDir))
	// 质量标记(0037):仅 approved 行可设置/清除(official/featured,互斥)。
	serverauth.AdminRoute(g, "PUT", "/:name/:version/quality", serverauth.PermCapabilityWrite, setPresetQuality(db))
	// 单文件内容(审核查看):从归档提取指定文件内容,支持文本/二进制/超大。
	serverauth.AdminRoute(g, "GET", "/:name/:version/file", serverauth.PermCapabilityRead, presetFileContent(db, cacheDir))
	// 授权(审核通过后仍需授权才可见可装):按 name 授权(同名多版本共享)。
	serverauth.AdminRoute(g, "GET", "/:name/grants", serverauth.PermCapabilityRead, listPresetGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grants", serverauth.PermCapabilityWrite, replacePresetGrants(db))
	serverauth.AdminRoute(g, "PUT", "/:name/grant", serverauth.PermCapabilityWrite, setPresetGrant(db, true))
	serverauth.AdminRoute(g, "DELETE", "/:name/grant", serverauth.PermCapabilityWrite, setPresetGrant(db, false))
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
		"quality":    p.Quality, // 0037 组织库质量标记(official/featured)
		"downloads":  p.Downloads,
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
		// agentshare-2:共享面只列组织渠道。市场渠道智能体由能力中心
		// (capabilities, source=market)呈现,不能在这里被当成「组织共享」
		// 内容(来源标注错误 + 市场下架失效)。
		org, oerr := orgAgentNames(db)
		if oerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
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
			// P2-1(审计 2026-09-13):客户端面只呈现**上架**内容——App 级
			// 下架(apps.enabled=0)与不存在同语义,管理员在客户端面也不该
			// 看到可点但下载必 404 的行(管理面清单仍全量,见 listAll)。
			enabled, err := serverstore.EnabledAppIDs(db, serverstore.AppKindAgent)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range all {
				// 两个闸门都要:渠道(只列组织共享面)+ 上架(apps.enabled)。
				if p.Status == serverstore.AgentPresetApproved && org[p.Name] && enabled[p.Name] {
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
			visible, err := serverstore.ListVisibleAgentPresets(db, u.Username, granted)
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, p := range visible {
				if org[p.Name] {
					list = append(list, p)
				}
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
		if !skillmanifest.IsVersion(req.Version) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidVersion,
				"版本号不合法:必须是 x.y.z(可带 -rc.1 预发布后缀)")
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
		// 2026-09-01:智能体对齐技能标准——展示元数据一律来自包内 preset.yml
		// (「包内即真相」),此前靠请求体手填,导致卡片只能显示目录名、版本
		// 永远是兜底的 1.0.0。
		entries, composition, listErr := ListArchiveContents(raw)
		if listErr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(listErr))
			return
		}
		// archupd-1②:编排必须可读(非空且在上限内)且可解析才能进入审核队列。
		// 此前 composition 被 `_` 丢弃,任何真实超过预览上限的编排都能发布成功,
		// 而管理员审核页只能看到空串——审核这一门形同虚设。
		if cerr := ValidateAgentComposition(composition); cerr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", cerr.Error())
			return
		}
		presetYML, _, found, _, _, xerr := archiveutil.ExtractFileContent(raw, skillmanifest.PresetMetaFile, maxFilePreviewBytes)
		if xerr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
			return
		}
		if !found {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, skillmanifest.CodeMissingField,
				"归档缺少 "+skillmanifest.PresetMetaFile+":展示名/版本/描述/作者/分类必须写在包内")
			return
		}
		man, manErr := skillmanifest.ParseAgent(entries, presetYML, req.Name)
		if manErr != nil {
			var me *skillmanifest.Error
			if errors.As(manErr, &me) {
				serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
				return
			}
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "预设元数据校验失败")
			return
		}
		// 锁定、版本语义(不可复用/必须递增/内容未变更)、归属保护与待审配额
		// 与技能共用同一个发布内核——此前智能体这条路径全都没有,管理员锁定
		// 对它不生效。
		res, perr := appstore.Publish(db, appstore.PublishRequest{
			Kind:       serverstore.AppKindAgent,
			AppID:      req.Name,
			Channel:    serverstore.AppChannelOrg,
			Archive:    raw,
			Publisher:  u.Username,
			PendingCap: pendingCap,
			Manifest:   appstore.FromSkillManifest(man),
			Checksum:   checksum,
		})
		if perr != nil {
			var ae *appstore.Error
			if errors.As(perr, &ae) {
				serverauth.WriteError(c, ae.Status, ae.Code, ae.Message)
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "发布失败")
			return
		}
		_ = serverstore.AuditLog(db, u.Username, "agent_preset_upload",
			sharedskills.UploadAuditDetail(req.Name, res.Version, man.Title, checksum))
		c.JSON(http.StatusCreated, gin.H{"preset": gin.H{"name": req.Name, "version": res.Version, "status": res.Status}})
	}
}

func listAll(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListAgentPresets(db, c.Query("status"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// agentshare-2:审批队列是共享库的队列 —— 市场渠道行由市场端点审核,
		// 混进来会让 webadmin 用 agentshare 的 base_path 渲染删除/审核按钮,
		// 一次点击即可销毁市场内容。
		org, oerr := orgAgentNames(db)
		if oerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, p := range list {
			if !org[p.Name] {
				continue
			}
			out = append(out, presetJSON(p))
		}
		c.JSON(http.StatusOK, gin.H{"presets": out})
	}
}

// decide approves or rejects one row (admin only). Legacy single-param form
// addresses the name's LATEST row (审计 2026-08-25 D-1:保留旧 UI/代理兼容,
// 但「最新」经 GetAgentPreset 的 semver 语义解析,非字符串排序)。
// P1-11:目标版本必须是「最高版本的非 approved 行」——已上架 1.0.0 + 待审
// 2.0.0 时,旧实现(GetAgentPreset = 最高 approved)会把 1.0.0 置 rejected
// (已上架版本从员工目录消失)而 2.0.0 仍 pending。按版本精确审核请用
// /:name/:version/{approve,reject}。
func decide(db *sql.DB, status serverstore.AgentPresetStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !presetIDRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "预设名不合法")
			return
		}
		p, err := serverstore.GetAgentPresetForReview(db, name)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !requireOrgAgent(c, db, p.Name) {
			return
		}
		if !decideBody(c, status) {
			return
		}
		// F2-N3 / N-4:拒绝已经释放了该版本的归档字节,再把它置成 approved
		// 只会得到「员工看得见、下载 500」的坏行。这里的预检只为了让**顺序**
		// 复现(误拒后点通过)拿到友好的 409 文案;真正的不变量由 DAO 的
		// 条件 UPDATE 保证(见 approveNeedsArchive 与 SetReleaseStatus)。
		if !approveNeedsArchive(c, db, status, p.Name, p.Version) {
			return
		}
		if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindAgent, p.Name, p.Version, string(status), reasonOf(c)); err != nil {
			writeDecideError(c, err)
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, p.Name+"@"+p.Version)
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
		if !requireOrgAgent(c, db, name) {
			return
		}
		if !decideBody(c, status) {
			return
		}
		// F2-N3 / N-4:与 decide 同守卫 —— 没有归档字节的版本不能置为 approved
		// (预检给友好文案,DAO 的条件 UPDATE 才是并发下的真正防线)。
		if !approveNeedsArchive(c, db, status, name, version) {
			return
		}
		if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindAgent, name, version, string(status), reasonOf(c)); err != nil {
			writeDecideError(c, err)
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

// approveNeedsArchive 是「通过审核」不变量的**顺序路径**守卫(F2-N3):
// 审核通过意味着这个版本要对员工可见、可安装,因此必须有归档字节。拒绝会
// 在 DAO 里把归档一并释放(agentshare-5 的存储上界),而 webadmin 对
// rejected 行同样渲染「通过」按钮 —— 没有这道守卫时,误拒后改判通过会得到
// status=approved + archive_bytes=0 的坏行:员工清单可见(授权仍在)、
// 下载 500「归档数据缺失」、管理员预览 404。
//
// N-4(2026-09-13):这个「先读归档长度、再写状态」的判定**不能**是唯一防线
// ——它是 check-then-act,两个管理员并发 approve/reject 时(实测 12 轮里
// 6~7 轮)会交错出坏行。这里只负责给出友好的 409 文案(顺序误拒后点通过,
// 用户看到的仍是 ARCHIVE_CLEARED 而不是 500);**并发下的真正防线是
// serverstore.SetReleaseStatus 的条件 UPDATE**(approved 与 archive 非空
// 在同一条语句里判定),写入失败时调用方经 writeDecideError 回同一个 409。
//
// 注意必须按版本取一份**带归档**的行来判断:审核清单走的 ListReleases 用
// releaseListColumns(不含 archive blob,清单查询不加载全部归档),拿它判断
// 会把刚上传的 pending 行误判成「没有归档」而挡住正常审核。
//
// 返回 false 表示已写出错误响应,调用方必须直接返回。
func approveNeedsArchive(c *gin.Context, db *sql.DB, status serverstore.AgentPresetStatus, name, version string) bool {
	if status != serverstore.AgentPresetApproved {
		return true
	}
	row, err := serverstore.GetAgentPresetByVersion(db, name, version)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return false
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return false
	}
	if len(row.Archive) > 0 {
		return true
	}
	serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED",
		"该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本")
	return false
}

// writeDecideError 把审核写入的错误映射成稳定的 HTTP 语义。N-4 的关键一条:
// 两个管理员并发 approve/reject 时,后来者可能在 DAO 的条件 UPDATE 上发现
// 「归档已经在上一个事务里被释放」—— 那不是服务器错误,而是「该版本已不可
// 通过」,必须回 409 ARCHIVE_CLEARED(与预检同码同文案),而不是 500。
func writeDecideError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, serverstore.ErrReleaseArchiveCleared):
		serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED",
			"该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本")
	case errors.Is(err, serverstore.ErrNotFound):
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
	default:
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
	}
}

// softDeleteAllPresetVersions 在**一条语句**里软删该 name 的全部未软删
// 版本,返回被删行数。name 级删除的契约就是「删全版本」(统一存储前是
// DELETE ... WHERE name=?),而 DAO 只有按版本软删:逐行调用一旦中途失败
// 就会留下「半删除」僵尸 approved 行(`DeleteAgentPreset` 只删最高 approved
// 一行),员工自视图与下载各自看到不同结论(agentshare-1)。单条 UPDATE
// 天然原子:全删或全不删。
func softDeleteAllPresetVersions(db *sql.DB, name string) (int64, error) {
	res, err := db.Exec(`UPDATE app_releases SET deleted_at = `+serverstore.NowExpr()+`, archive = NULL,
		updated_at = `+serverstore.NowExpr()+`
		WHERE kind = ? AND app_id = ? AND deleted_at IS NULL`, serverstore.AppKindAgent, name)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
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
		// agentshare-2:共享面的删除只作用于组织共享库,不能销毁市场内容。
		if !requireOrgAgent(c, db, name) {
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
		deleted, derr := softDeleteAllPresetVersions(db, name)
		if derr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		if deleted == 0 {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}
		// Best-effort archive cleanup:DB 归档列已由软删清空,这里只清磁盘
		// 回退缓存(pre-0041 行遗留的 tar.gz 文件)。
		for _, v := range versions {
			_ = os.Remove(filepath.Join(cacheDir, safeName(name, v)))
		}
		// 硬删全部行后清理该 name 的全部授权(资源级联;旧授权不复活重建资源)。
		_ = serverstore.DeleteSharedResourceGrants(db, serverstore.SharedPresetGrantTable, name)
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
		if !requireOrgAgent(c, db, name) {
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
		_ = serverstore.ClearAgentPresetArchive(db, name, version)
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
		// agentshare-2:授权读也只服务组织共享库(市场授权在 app_grants 里
		// 与共享库同名同 kind,不过滤渠道就会读出市场 ACL)。
		if !requireOrgAgent(c, db, c.Param("name")) {
			return
		}
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
		if !requireOrgAgent(c, db, name) {
			return
		}
		var req struct {
			Groups []string `json:"groups"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if err := serverstore.ReplaceSharedGroups(db, serverstore.SharedPresetGrantTable, name, req.Groups); err != nil {
			if err == serverstore.ErrValidation || err == serverstore.ErrNotFound {
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

// setPresetQuality sets/clears the quality tag of one approved shared agent
// (”|official|featured). Only approved rows may carry a tag; audit as
// agent_preset_qualify.
func setPresetQuality(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !requireOrgAgent(c, db, name) {
			return
		}
		var req struct {
			Quality string `json:"quality"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !serverstore.ValidAgentQuality(req.Quality) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法(空/featured;官方已移交归属官方操作)")
			return
		}
		if err := serverstore.SetAgentPresetQuality(db, name, version, req.Quality); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在或未通过审核")
				return
			}
			if errors.Is(err, serverstore.ErrValidation) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "agent_preset_qualify", name+"@"+version+"="+req.Quality)
		c.JSON(http.StatusOK, gin.H{"ok": true, "quality": req.Quality})
	}
}

// setPresetGrant adds/removes one user or group grant (idempotent).
func setPresetGrant(db *sql.DB, grant bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !requireOrgAgent(c, db, name) {
			return
		}
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
//
// admin=false 的两条路由 = 客户端(员工)面,三重闸门(审核状态 / App 级
// 上下架 / 授权)任一不过都与「不存在」同 404;admin=true 的管理面只读归档,
// 便于审核与排查已下架内容。
func serveArchive(c *gin.Context, db *sql.DB, cacheDir string, p *serverstore.AgentPreset, admin bool) {
	if !admin && p.Status != serverstore.AgentPresetApproved {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
		return
	}
	// agentshare-2:员工下载是市场智能体唯一的安装通路(CapabilityCenterPanel
	// 的 installEndpoint),因此共享面的下载端点**两种渠道都服务**(清单/审核
	// 等其它共享面端点则只服务 org,见 orgAgentNames)。
	// P2-1(审计 2026-09-13):apps.enabled=0(下架)即不可下载——此前只查
	// 审核状态与授权,管理员下架后员工仍能按名字取下归档。单个 App 一次
	// 查询,不引入逐行 N+1。两个闸门合起来即「市场下架必须生效」。
	if !admin {
		enabled, aerr := serverstore.AppEnabled(db, serverstore.AppKindAgent, p.Name)
		if aerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if !enabled {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "预设不存在")
			return
		}
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
	// 0041:归档直存 DB;pre-0041 行的磁盘回退(read-only)。
	var payload []byte
	dbRaw, aerr := serverstore.GetAgentPresetArchive(db, p.Name, p.Version)
	switch {
	case aerr == nil && dbRaw != nil:
		payload = dbRaw
	case aerr == nil:
		diskPath := filepath.Join(cacheDir, safeName(p.Name, p.Version))
		if r, rerr := os.ReadFile(diskPath); rerr == nil {
			payload = r
		} else {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档数据缺失")
			return
		}
	default:
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "归档读取失败")
		return
	}
	_, _ = serverstore.IncrementAgentPresetDownload(db, p.Name, p.Version)
	// 按归档实际格式回响应(zip 推荐 / tar.gz 兼容):文件名与 Content-Type
	// 跟随魔数嗅探,旧行(存库为 tar.gz)下载仍正确。
	dispName := safeName(p.Name, p.Version)
	contentType := "application/gzip"
	if archiveutil.Format(payload) == "zip" {
		dispName = p.Name + "-" + p.Version + ".zip"
		contentType = "application/zip"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", dispName))
	c.Header("X-Preset-Version", p.Version)
	c.Header("X-Preset-Checksum", p.Checksum)
	c.Data(http.StatusOK, contentType, payload)
}

// archiveErrorMessage maps validation refusals to the client-facing message.
//
// 文案的**单一真源**是 archiveutil.ErrorText(archive.go:816):本函数只保留
// 两处特例,其余分支一律经 ErrorText 生成 ——
//   - ErrArchiveTooLarge:本域把 ErrInvalid(空/超大)收敛成"过大",文案与
//     ErrorText 的 ErrInvalid 分支("归档过大或结构非法(上限 NMB)")不同;
//   - ErrCorrupt:本域按"条目解压或 CRC"描述,与 ErrorText 的"必填文件解压
//     或校验失败"不同,保留原文案。
//
// 其余本域哨兵(ErrNoComposition/ErrUnsafeArchive/ErrEntryLimit/
// ErrDuplicateEntry)不包装 archiveutil 哨兵,因此在这里显式映射到对应的
// archiveutil 哨兵再交给 ErrorText(输出与改前逐字相同);重复条目仍先用
// DuplicateEntryNames 点出两个折叠同名的条目(F2-N7),点不出来才用通用文案。
func archiveErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrArchiveTooLarge):
		return fmt.Sprintf("归档过大(上限 %dMB)", MaxArchiveBytes>>20)
	case errors.Is(err, ErrNoComposition):
		return archiveutil.ErrorText(archiveutil.ErrNoRequired, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrUnsafeArchive):
		return archiveutil.ErrorText(archiveutil.ErrUnsafe, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrEntryLimit):
		return archiveutil.ErrorText(archiveutil.ErrTooMany, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, ErrDuplicateEntry):
		// F2-N7:列出被判为同一个文件的两个名字 —— installerKey 的折叠
		// (大小写/尾随点空格/NTFS 危险折叠)宁严勿宽,不点名的话用户无从改名。
		if first, second, ok := archiveutil.DuplicateEntryNames(err); ok {
			return fmt.Sprintf("归档含重复条目:%s 与 %s 在安装端是同一个文件(大小写/尾随点空格折叠),请改名后重新打包", first, second)
		}
		return archiveutil.ErrorText(archiveutil.ErrDuplicateEntry, CompositionFile, MaxArchiveBytes>>20)
	case errors.Is(err, archiveutil.ErrCorrupt):
		return "归档内容损坏(条目解压或 CRC 校验失败)"
	default:
		return archiveutil.ErrorText(err, CompositionFile, MaxArchiveBytes>>20)
	}
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}
