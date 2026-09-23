// Package sharedskills implements the shared-skill store: employees upload
// local skills (SKILL.md bundles), admins review them, and every approved
// version is visible and installable by all employees. Mirrors agentshare
// with multi-version keying (name+version).
package sharedskills

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
	"github.com/picoaide/picoaide/internal/skillmanifest"
	"github.com/picoaide/picoaide/internal/util"
)

// Limits: the raw gzipped tar a client may upload, the total unpacked tree
// size, entry count, and the request body ceiling (base64 inflation).
//
// 2026-09-13:三个归档边界改为引用 archiveutil 的规范常量(全仓唯一一份数字,
// 见 archiveutil.DefaultLimits)。此前 sharedskills/agentshare/archiveutil
// 各写一份 16MB/64MB/10000,任一处调整都会让"四入口口径一致"悄悄失效 ——
// 现在由 TestArchiveLimitsSingleSource 锁住三处同值。
const (
	MaxArchiveBytes   = archiveutil.MaxArchiveBytes
	MaxUnpackedBytes  = archiveutil.MaxUnpackedBytes
	MaxArchiveEntries = archiveutil.MaxArchiveEntries
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
	// ErrDuplicateArchive: the archive repeats an entry (case-insensitive).
	ErrDuplicateArchive = errors.New("archive has duplicate entries")
)

// archiveLimits: 归档校验边界(取自 archiveutil 的规范常量;zip/tar.gz 双格式)。
var archiveLimits = archiveutil.DefaultLimits("SKILL.md")

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

// RegisterAdminRoutes mounts /api/server/admin/shared-skills (AdminAuth + RBAC v3b).
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
	// 组织共享技能上下架(与生产路由树同一路径,见 internal/router)。
	serverauth.AdminRoute(g, "PUT", "/:name/enabled", serverauth.PermCapabilityWrite, setEnabled(db))

	// 能力锁定(D4)挂在另一个基路径,与生产路由树一致(AGENTS.md:测试自建
	// 路由树的前缀必须与生产相同,否则测不出路径不匹配)。
	lg := r.Group("/api/server/admin/capability-locks", serverauth.AdminAuth(db))
	serverauth.AdminRoute(lg, "GET", "", serverauth.PermCapabilityRead, listLocks(db))
	serverauth.AdminRoute(lg, "PUT", "/:kind/:name", serverauth.PermCapabilityWrite, setLock(db))
	serverauth.AdminRoute(lg, "DELETE", "/:kind/:name", serverauth.PermCapabilityWrite, removeLock(db))
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
		// 上下架状态(App 级,2026-09-15):客户端面下架与不存在同语义,所以必须
		// **先取后分支**。审计 2026-09-15 S11-2:此前只在末尾取 enabled 当作
		// 响应字段,admin 分支只按审核状态过滤,而客户端下载路由恒以
		// admin=false 构造(routes.go:76,与调用者是否管理员无关),于是管理员
		// 在客户端看到的下架行点一次必 404 —— 管理面清单仍全量(见 listAll)。
		enabled, err := serverstore.EnabledAppIDs(db, serverstore.AppKindSkill)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		var list []serverstore.SharedSkill
		if u.IsAdmin {
			// Admins see everything already approved (admin 恒全量,不落授权表).
			// 下架行例外:与不存在同语义(对齐 agentshare.listVisible 的 `&& enabled[...]`)。
			all, err := serverstore.ListSharedSkills(db, "")
			if err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			for _, s := range all {
				if s.Status == serverstore.SharedSkillApproved && enabled[s.Name] {
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
		// enabled 字段保留(客户端不消费,审计 2026-09-15 S11-2):列出的行都已按
		// 上面那份 map 过滤,故此处恒为 true;管理端渲染「已下架」走 listAll。
		out := make([]gin.H, 0, len(list))
		for _, s := range list {
			row := rowJSON(s)
			row["enabled"] = enabled[s.Name]
			out = append(out, row)
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
		if !skillmanifest.IsAppID(req.Name) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
				"技能名不合法:必须是小写 kebab-case(如 my-skill),且与 SKILL.md 的 name 一致")
			return
		}
		// 版本不再取自请求:决策 2026-09-01「包内即真相」——版本/标题/描述
		// 一律以包内 SKILL.md frontmatter 为准。旧客户端硬编码发
		// version=1.0.0,此处忽略该字段(P1 客户端改为读本地 frontmatter)。
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
		// 严格清单校验:上游以 frontmatter 的 name 作运行时身份且强制
		// kebab-case,不合规的包装到磁盘后会被**静默忽略**。发布期不拦,
		// 用户就会拿到「上传成功但技能不存在」。
		entries, skillMD, listErr := ListArchiveContents(raw)
		if listErr != nil {
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", archiveErrorMessage(listErr))
			return
		}
		man, manErr := skillmanifest.Parse(entries, skillMD, req.Name)
		if manErr != nil {
			var me *skillmanifest.Error
			if errors.As(manErr, &me) {
				serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
				return
			}
			serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "SKILL.md 校验失败")
			return
		}

		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		// P2:锁定检查、版本语义(不可复用/必须递增/内容未变更)、跨渠道同名
		// 互斥、归属保护与待审配额全部收敛到统一发布内核——三条上传路径
		// (管理后台/能力中心/智能体预设)共用同一份实现,不再各写一遍。
		res, perr := appstore.Publish(db, appstore.PublishRequest{
			Kind:       serverstore.AppKindSkill,
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
		_ = serverstore.AuditLog(db, u.Username, "shared_skill_upload",
			UploadAuditDetail(req.Name, res.Version, man.Title, checksum))
		c.JSON(http.StatusCreated, gin.H{"skill": gin.H{"name": req.Name, "version": res.Version, "status": res.Status}})
	}
}

func listAll(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListSharedSkills(db, c.Query("status"))
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		// 上下架状态（App 级，2026-09-15）：管理端要据此渲染「已下架」与切换按钮，
		// 一次批量取，不逐行查 apps。
		enabled, err := serverstore.EnabledAppIDs(db, serverstore.AppKindSkill)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, s := range list {
			row := rowJSON(s)
			row["enabled"] = enabled[s.Name]
			out = append(out, row)
		}
		c.JSON(http.StatusOK, gin.H{"skills": out})
	}
}

// decide approves or rejects one shared skill row (admin only). Rejecting
// requires a reason, which the author sees and which is cleared on resubmit.
func decide(db *sql.DB, status serverstore.SharedSkillStatus, auditAction string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		row, err := serverstore.GetSharedSkill(db, name, version)
		if err != nil {
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
		// agentshare-3:共享库只审核组织渠道行。放在跨源冲突检测之后,让
		// 「approve 一个市场同名行」保持原有的 409 CONFLICT 语义(两者都是
		// 拒绝,只是码不同);reject 没有冲突检测,直接由这里 404。
		if !requireOrgSkill(c, db, name) {
			return
		}
		// F2-N3 / N-4 / ID-01(2026-09-23):与 agentshare 侧同一条不变量 ——
		// 审核通过意味着版本对员工可见可安装,必须有归档字节;而**审核拒绝
		// 只能作用于尚未生效的待审版本** —— approved 版本可能正在服务、也可能
		// 是唯一可回滚的历史版本,对它执行拒绝会在同一条 UPDATE 里永久释放
		// 归档字节并烧掉版本号(不可恢复)。
		//
		// 那条前置条件的**唯一实现**在 DAO(serverstore.SetReleaseStatusForReview
		// 的 `AND status <> 'approved'`),本函数不再自己判一遍状态位:三份
		// check-then-act 守卫正是 ID-01 的根因(只有 WASM 面写了那一份)。
		// 下面这个「归档为空」的预检只是**顺序路径**的友好 409 文案,并发下的
		// 真正防线是 DAO 的条件 UPDATE(见 apps.go)。
		// 拒绝不再单独调用 DeleteSharedSkillArchive:拒绝与释放归档已经在
		// 同一条 UPDATE 里完成(否则「置 rejected」与「清 archive」之间仍有
		// 一个可被并发 approve 穿过的窗口)。
		if status == serverstore.SharedSkillApproved && len(row.Archive) == 0 {
			serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED",
				"该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本")
			return
		}
		if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill, name, version, string(status), reason); err != nil {
			if errors.Is(err, serverstore.ErrReleaseArchiveCleared) {
				serverauth.WriteError(c, http.StatusConflict, "ARCHIVE_CLEARED",
					"该版本归档已在拒绝时清理,无法再通过审核(拒绝即释放存储):请让作者上传新版本")
				return
			}
			// ID-01:拒绝一个已通过审核的版本 = 销毁正在服务的归档字节,必须
			// 409 并指路(下架可逆)。文案取自 serverstore 的共享常量,与
			// agentshare / wasmapp 三面逐字一致。
			if errors.Is(err, serverstore.ErrReleaseApprovedNotRejectable) {
				serverauth.WriteError(c, http.StatusConflict, serverstore.CodeReleaseNotRejectable,
					serverstore.MsgReleaseNotRejectable+"。"+serverstore.HintReleaseNotRejectable)
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		// 审核落定之后把 apps 行的**展示投影**重算为"最新 approved 版本"
		// (审计 2026-09-23 G-P2-3):approve 让新版本生效 ⇒ 投影切到它;
		// reject 让被拒版本永不生效 ⇒ 投影恢复成仍在生效的那一版。漏掉这一步
		// 会让"待审时被刻意冻结的投影"永远停在旧值/脏值上(WASM 面早就有
		// recomputeProjection,本面从未接)。实现与理由见
		// serverstore.RecomputeAppProjection(app_releases 是三面共用的真相表)。
		//
		// 失败语义:状态已经落库,只是投影没跟上 —— 这不是"审核失败"而是平台侧
		// 写入故障,如实回 500 请管理员重试(重试会再次走到这里,幂等)。
		if _, perr := serverstore.RecomputeAppProjection(db, serverstore.AppKindSkill, name); perr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL",
				"审核结果已落库,但技能投影更新失败(请重试一次)")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), auditAction, name+"@"+version)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
func remove(db *sql.DB, cacheDir string) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !requireOrgSkill(c, db, name) {
			return
		}
		if err := serverstore.DeleteSharedSkill(db, name, version); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		_ = serverstore.DeleteSharedSkillArchive(db, name, version)
		// 授权清理:授权按 name 生效(同名多版本共享),因此只有该 name 下
		// **已无其它未删版本**时才清空——P2-10:此前删一个历史版本即静默
		// 撤销全员对剩余版本的访问。计数失败时保守跳过(不误撤销)。
		if n, err := serverstore.SharedSkillVersionCount(db, name); err == nil && n == 0 {
			_ = serverstore.DeleteSharedResourceGrants(db, serverstore.SharedSkillGrantTable, name)
		}
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
		if !requireOrgSkill(c, db, name) {
			return
		}
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
		if !requireOrgSkill(c, db, name) {
			return
		}
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
		if !requireOrgSkill(c, db, name) {
			return
		}
		var req struct {
			Quality string `json:"quality"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if !serverstore.ValidSharedQuality(req.Quality) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "质量标记不合法(空/featured;官方已移交归属官方操作)")
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
		if !requireOrgSkill(c, db, name) {
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

// setEnabled 组织共享技能上下架（2026-09-15）。语义与市场技能的
// marketplace /skills/:name 上下架完全一致（apps.enabled），但**只作用于
// 组织渠道行** —— 市场渠道行由 marketplace 端点管理，那边同样拒绝跨渠道写
// （marketplace-8），避免两个入口互相把对方的行置成下架。
//
// 效果（三处闸门都已就位）：员工目录不可见（ListVisibleSharedSkills 按
// EnabledAppIDs 过滤）、员工下载 404（download 的第三道闸门）、管理端照旧可
// 审核与预览。下架不删数据，重新上架即恢复。
func setEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		name := c.Param("name")
		if !skillNameRe.MatchString(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", `请求体格式错误(需要 {"enabled": true|false})`)
			return
		}
		if !requireOrgSkill(c, db, name) {
			return
		}
		if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, name, *req.Enabled); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "切换失败")
			return
		}
		// 可见性变更必审计（与市场技能的 skill_disable/skill_enable 同精神，
		// 动作名带 shared_ 前缀以便与市场域区分）。
		action := "shared_skill_disable"
		if *req.Enabled {
			action = "shared_skill_enable"
		}
		_ = serverstore.AuditLog(db, adminUsername(c), action, name)
		c.JSON(http.StatusOK, gin.H{"ok": true, "enabled": *req.Enabled})
	}
}

// download serves the stored archive. Employees may download only approved
// rows; admins any row.
//
// 员工面三重闸门(与 agentshare.serveArchive 同口径,技能侧 2026-09-15 补齐):
// 审核状态 / App 级上下架 / 授权,任一不过都与"不存在"同 404(不泄露存在性)。
// 管理面(admin=true)只读归档,便于审核与排查已下架内容。
func download(db *sql.DB, cacheDir string, admin bool) gin.HandlerFunc {
	return func(c *gin.Context) {
		name, version := c.Param("name"), c.Param("version")
		if !skillNameRe.MatchString(name) || !versionRe.MatchString(version) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		// agentshare-3:共享技能库的下载只服务组织渠道(市场技能走
		// /api/client/v2/marketplace/skills/:name/archive,客户端按来源路由)。
		if !requireOrgSkill(c, db, name) {
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
		// P2-1(2026-09-13 智能体面 / 2026-09-15 技能面):apps.enabled=0(下架)
		// 即不可下载——此前只查审核状态与授权,下架后员工仍能按名字取下归档。
		// 单个 App 一次查询,不引入逐行 N+1。
		if !admin {
			enabled, aerr := serverstore.AppEnabled(db, serverstore.AppKindSkill, name)
			if aerr != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
				return
			}
			if !enabled {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
				return
			}
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
		// 按归档实际格式回响应(zip 推荐 / tar.gz 兼容):文件名与 Content-Type
		// 跟随魔数嗅探,旧行(存库为 tar.gz)下载仍正确。
		dispName := safeName(s.Name, s.Version)
		contentType := "application/gzip"
		if archiveutil.Format(payload) == "zip" {
			dispName = name + "-" + s.Version + ".zip"
			contentType = "application/zip"
		}
		c.Header("Content-Type", contentType)
		c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", dispName))
		c.Header("X-Skill-Version", s.Version)
		c.Header("X-Skill-Checksum", s.Checksum)
		_, _ = serverstore.IncrementSharedSkillDownload(db, s.Name, s.Version)
		c.Data(http.StatusOK, contentType, payload)
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
		if !requireOrgSkill(c, db, name) {
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
//
// 审计 2026-09-12(FIX-01,P0):上限从 1 MB 降到 128 KB。这个常量同时是
// **解析入口的输入边界** —— ListArchiveContents 用它决定要不要把顶层
// SKILL.md 的原文取出来交给 skillmanifest.Parse(超出即返回空串 → 归档判定为
// 缺少 SKILL.md)。1 MB 上限等于允许 1 MB 的 YAML 深度炸弹进解析器,而
// goccy/go-yaml 解析 `[`×65536 就会 `fatal error: out of memory`(不可
// recover,直接打死服务端进程)。128 KB 与 skillmanifest.MaxSkillMDBytes 同值,
// 两层给出同一个边界。合法 SKILL.md 是几 KB 量级(2026-09-01 实测线上 30 个
// 技能),128 KB 留了两个数量级的余量。
const maxFilePreviewBytes = 128 << 10

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
		norm, err := archiveutil.NormalizePath(target)
		if err != nil || norm == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
			return
		}
		if !requireOrgSkill(c, db, name) {
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
	return archiveutil.ExtractFileContent(data, target, maxFilePreviewBytes)
}

// ValidateSkillArchive lists an archive (zip 推荐 / tar.gz 兼容) without
// extracting it, refusing unsafe entries, bounding size/entry count, and
// requiring a top-level SKILL.md. Returns the archive's sha256 hex.
func ValidateSkillArchive(data []byte) (string, error) {
	checksum, err := archiveutil.Validate(data, archiveLimits)
	switch {
	case errors.Is(err, archiveutil.ErrNoRequired):
		return "", ErrNoSkillMarkdown
	case errors.Is(err, archiveutil.ErrUnsafe):
		return "", ErrUnsafeArchive
	case errors.Is(err, archiveutil.ErrDuplicateEntry):
		// F2-N7:把「被判为同一个文件」的两个条目名留在错误链里,HTTP 层
		// 回显给上传者(installerKey 的折叠是宁严勿宽,用户需要知道改哪个名)。
		return "", errors.Join(ErrDuplicateArchive, err)
	case errors.Is(err, archiveutil.ErrInvalid), errors.Is(err, archiveutil.ErrTooMany):
		return "", ErrArchiveInvalid
	default:
		return checksum, err
	}
}

// ListArchiveContents lists non-directory entry paths (sorted, unique) and
// returns the top-level SKILL.md content for admin review.
func ListArchiveContents(data []byte) ([]string, string, error) {
	return archiveutil.ListContents(data, archiveLimits, maxFilePreviewBytes)
}

// archiveErrorMessage maps validation refusals to the client-facing message.
//
// 文案的**单一真源**是 archiveutil.ErrorText(archive.go:816):本函数只保留
// 两处特例,其余分支一律经 ErrorText 生成 ——
//   - ErrArchiveInvalid:原文案"归档过大或结构非法"不带上限,ErrorText 的
//     ErrInvalid 分支会附"(上限 NMB)";
//   - ErrCorrupt:本域按"条目解压或 CRC"描述,与 ErrorText 的"必填文件解压
//     或校验失败"不同,保留原文案。
//
// 其余本域哨兵(ErrNoSkillMarkdown/ErrUnsafeArchive/ErrDuplicateArchive)不
// 包装 archiveutil 哨兵,因此在这里显式映射到对应的 archiveutil 哨兵再交给
// ErrorText(输出与改前逐字相同);重复条目仍先用 DuplicateEntryNames 点出
// 两个折叠同名的条目(F2-N7),点不出来才用通用文案。
func archiveErrorMessage(err error) string {
	switch {
	case errors.Is(err, ErrNoSkillMarkdown):
		return archiveutil.ErrorText(archiveutil.ErrNoRequired, "SKILL.md", MaxArchiveBytes>>20)
	case errors.Is(err, ErrUnsafeArchive):
		return archiveutil.ErrorText(archiveutil.ErrUnsafe, "SKILL.md", MaxArchiveBytes>>20)
	case errors.Is(err, ErrDuplicateArchive):
		// F2-N7:列出被判为同一个文件的两个名字 —— installerKey 的折叠
		// (大小写/尾随点空格/NTFS 危险折叠)宁严勿宽,不点名的话用户无从改名。
		if first, second, ok := archiveutil.DuplicateEntryNames(err); ok {
			return fmt.Sprintf("归档含重复条目:%s 与 %s 在安装端是同一个文件(大小写/尾随点空格折叠),请改名后重新打包", first, second)
		}
		return archiveutil.ErrorText(archiveutil.ErrDuplicateEntry, "SKILL.md", MaxArchiveBytes>>20)
	case errors.Is(err, archiveutil.ErrCorrupt):
		return "归档内容损坏(条目解压或 CRC 校验失败)"
	case errors.Is(err, ErrArchiveInvalid):
		return "归档过大或结构非法"
	default:
		return archiveutil.ErrorText(err, "SKILL.md", MaxArchiveBytes>>20)
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

// UploadAuditDetail 组装上传类审计明细:审计页要能直接看清「谁上传了什么」
// ——名称@版本 + 展示名 + 校验和前 8 位(可与归档比对)。前缀固定为
// `name@version`,便于审计页据此解析出预览入口;市场域复用同一格式。
func UploadAuditDetail(name, version, title, checksum string) string {
	detail := name + "@" + version
	if title != "" {
		detail += " 「" + title + "」"
	}
	if len(checksum) >= 8 {
		detail += " sha256:" + checksum[:8]
	}
	return detail
}

// ---------------------------------------------------------------------------
// 能力锁定(决策 2026-09-01 D4):管理员把某个技能名标记为「仅管理员可发布」。
// 允许对尚不存在的名字预锁定(占名),因此不校验该技能是否已存在。
// ---------------------------------------------------------------------------

// ListLocks 返回全部锁定记录(管理端)。
func listLocks(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		list, err := serverstore.ListCapabilityLocks(db)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(list))
		for _, l := range list {
			out = append(out, gin.H{
				"kind": l.Kind, "name": l.Name, "reason": l.Reason,
				"locked_by": l.LockedBy, "created_at": l.CreatedAt,
			})
		}
		c.JSON(http.StatusOK, gin.H{"locks": out})
	}
}

// setLock 锁定一个能力名(幂等);body {reason} 会在员工被拒时原样回显。
func setLock(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		kind, name := c.Param("kind"), c.Param("name")
		if !serverstore.ValidCapabilityKind(kind) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "类型不合法(skill|agent)")
			return
		}
		if !skillmanifest.IsAppID(name) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
				"名称不合法:必须是小写 kebab-case")
			return
		}
		var req struct {
			Reason string `json:"reason"`
		}
		_ = c.ShouldBindJSON(&req)
		reason := strings.TrimSpace(req.Reason)
		if len([]rune(reason)) > maxDescriptionLen {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "理由过长(上限 500 字)")
			return
		}
		if err := serverstore.LockCapability(db, kind, name, reason, adminUsername(c)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "锁定失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "capability_lock", kind+":"+name+" "+reason)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// removeLock 解除锁定。
func removeLock(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		kind, name := c.Param("kind"), c.Param("name")
		if !serverstore.ValidCapabilityKind(kind) || !skillmanifest.IsAppID(name) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "参数不合法")
			return
		}
		if err := serverstore.UnlockCapability(db, kind, name); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "该名称未被锁定")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "解锁失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "capability_unlock", kind+":"+name)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

// ArchiveLimits 暴露归档安全边界,供同仓其他域(市场规范化)复用同一套上限。
func ArchiveLimits() archiveutil.Limits { return archiveLimits }
