package marketplace

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
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

// RegisterAdminRoutes mounts /api/admin/skills* behind AdminAuth + RBAC
// (v3b). cacheDir is the skill repo/archive cache, invalidated when a
// skill's source changes (C-6).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	base := "/api/server/admin"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "/skills", serverauth.PermMarketRead, func(c *gin.Context) { listSkillsAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/skills", serverauth.PermMarketWrite, func(c *gin.Context) { createSkillAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/skills/:name/archive", serverauth.PermMarketWrite, func(c *gin.Context) { uploadSkillArchiveAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name", serverauth.PermMarketWrite, func(c *gin.Context) { updateSkillAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "DELETE", "/skills/:name", serverauth.PermMarketWrite, func(c *gin.Context) { deleteSkillAdmin(c, db) })
	// 重新上架(审计 A5-M1: 下架不可逆曾导致误下架无法恢复)
	serverauth.AdminRoute(g, "POST", "/skills/:name/enable", serverauth.PermMarketWrite, func(c *gin.Context) { enableSkillAdmin(c, db) })
	// 审批预览(2026-09-01):管理员上架前后都要能看到包内到底是什么。
	serverauth.AdminRoute(g, "GET", "/skills/:name/preview", serverauth.PermMarketRead, func(c *gin.Context) { previewSkillAdmin(c, db, cacheDir) })
	serverauth.AdminRoute(g, "GET", "/skills/:name/file", serverauth.PermMarketRead, func(c *gin.Context) { fileContentSkillAdmin(c, db, cacheDir) })
	// 存量规范化(决策 2026-09-01 §八):产出符合发布契约的新版本(patch+1)。
	serverauth.AdminRoute(g, "POST", "/skills/:name/normalize", serverauth.PermMarketWrite, func(c *gin.Context) { normalizeSkillAdmin(c, db, cacheDir) })
	// 授权管理(严格默认:未授权不可见/不可下载)
	serverauth.AdminRoute(g, "GET", "/skills/:name/grants", serverauth.PermMarketRead, func(c *gin.Context) { listSkillGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name/grants", serverauth.PermMarketWrite, func(c *gin.Context) { replaceSkillGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/skills/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { setSkillGrant(c, db, true) })
	serverauth.AdminRoute(g, "DELETE", "/skills/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { setSkillGrant(c, db, false) })
	// 市场智能体(G4):与市场技能同构(与 router 包镜像)。
	serverauth.AdminRoute(g, "GET", "/agents", serverauth.PermMarketRead, func(c *gin.Context) { listAgentsAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents", serverauth.PermMarketWrite, func(c *gin.Context) { createAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents/:name/archive", serverauth.PermMarketWrite, func(c *gin.Context) { uploadAgentArchiveAdmin(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name", serverauth.PermMarketWrite, func(c *gin.Context) { updateAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "DELETE", "/agents/:name", serverauth.PermMarketWrite, func(c *gin.Context) { deleteAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/agents/:name/enable", serverauth.PermMarketWrite, func(c *gin.Context) { enableAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/preview", serverauth.PermMarketRead, func(c *gin.Context) { previewAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/file", serverauth.PermMarketRead, func(c *gin.Context) { fileContentAgentAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/agents/:name/grants", serverauth.PermMarketRead, func(c *gin.Context) { listAgentGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name/grants", serverauth.PermMarketWrite, func(c *gin.Context) { replaceAgentGrants(c, db) })
	serverauth.AdminRoute(g, "PUT", "/agents/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { applyAgentGrant(c, db, true) })
	serverauth.AdminRoute(g, "DELETE", "/agents/:name/grant", serverauth.PermMarketWrite, func(c *gin.Context) { applyAgentGrant(c, db, false) })
}

// grantReq carries a subject: {username} or {group} (webadmin sends @group).
type grantReq struct {
	Username string `json:"username"`
	Group    string `json:"group"`
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}

func parseGrantSubject(req grantReq) (string, serverstore.GranteeType, bool) {
	if req.Username != "" && req.Group == "" {
		return req.Username, serverstore.GranteeUser, true
	}
	if req.Group != "" && req.Username == "" {
		return req.Group, serverstore.GranteeGroup, true
	}
	return "", "", false
}

// strictBindJSON decodes the request body rejecting unknown fields, so a
// caller cannot silently send a body that this endpoint does not understand
// (审计 A5-M7: PUT grants 只接受 {groups:[...]})。
func strictBindJSON(c *gin.Context, v any) error {
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

func grantsJSON(grants []serverstore.Grant) gin.H {
	if grants == nil {
		grants = []serverstore.Grant{}
	}
	return gin.H{"grants": grants}
}

func listSkillGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	grants, err := serverstore.ListSkillGrants(db, name)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, grantsJSON(grants))
}

func setSkillGrant(c *gin.Context, db *sql.DB, grant bool) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	applyGrant(c, db, grant, "skill#"+name,
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.GrantSkill(db, name, subject, t)
		},
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.RevokeSkill(db, name, subject, t)
		},
		"skill_grant", "skill_revoke")
}

// applyGrant 是技能单条授权与撤销的公共实现(审计 A5-L1):解析请求体
// → 主体存在性校验(拼错的用户名/部门名不应静默落库)→ grant/revoke → 审计。
func applyGrant(c *gin.Context, db *sql.DB, grant bool, subjectLabel string,
	grantFn, revokeFn func(subject string, t serverstore.GranteeType) error,
	grantAudit, revokeAudit string) {
	var req grantReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	subject, t, ok := parseGrantSubject(req)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "username 或 group 必填且只能二选一")
		return
	}
	if t == serverstore.GranteeUser {
		if _, err := serverstore.GetUserByUsername(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "用户不存在: "+subject)
			return
		}
	} else if t == serverstore.GranteeGroup {
		if _, err := serverstore.GroupByName(db, subject); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "部门不存在: "+subject)
			return
		}
	}
	if grant {
		if err := grantFn(subject, t); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权对象不合法")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), grantAudit, subjectLabel+" "+string(t)+":"+subject)
	} else {
		if err := revokeFn(subject, t); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权对象不合法")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), revokeAudit, subjectLabel+" "+string(t)+":"+subject)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// invalidateSkillCache removes the cached repo clone and built archives for a
// skill (C-6): a version/git change must not keep serving the old package.
func invalidateSkillCache(cacheDir, name string) {
	// CodeQL path-injection sanitizer: 仅字母数字与 ._- 的合法 skill 名。
	if !util.SafePathSegment(name) || !skillNameRe.MatchString(name) {
		return
	}
	os.RemoveAll(filepath.Join(cacheDir, name))
	matches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.tar.gz"))
	zipMatches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.zip"))
	for _, m := range append(zipMatches, matches...) {
		os.Remove(m)
	}
}

// skillNameRe 白名单(与 SafePathSegment 双重防护): [A-Za-z0-9._-]+
var skillNameRe = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

func listSkillsAdmin(c *gin.Context, db *sql.DB) {
	list, err := serverstore.ListSkills(db, false)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, s := range list {
		out = append(out, skillJSON(s))
	}
	c.JSON(http.StatusOK, gin.H{"skills": out})
}

type skillReq struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Author      string `json:"author"`
}

func createSkillAdmin(c *gin.Context, db *sql.DB) {
	var req skillReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	if !util.SafePathSegment(req.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	// 0052:git 源模式已移除——创建只登记名称与元数据,内容一律由
	// POST /skills/:name/archive 上传(归档是唯一入口,发布期集中严格校验)。
	s := &serverstore.Skill{Name: req.Name, Version: req.Version, Description: req.Description,
		Author: req.Author, Enabled: 1}
	if _, err := serverstore.AddSkill(db, s); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能已存在")
			return
		}
		if errors.Is(err, serverstore.ErrConflict) {
			// 决策 2026-08-25:市场与组织合并为「市场」后,同名技能跨源互斥。
			// 共享库已存在同名技能(任意状态)时拒绝上架,要求管理员先处理共享库行。
			serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "名称与组织共享库技能冲突,请先在共享库处理同名技能")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_create", s.Name+" v"+s.Version)
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

// uploadSkillArchiveAdmin switches a skill to uploaded-archive mode: the
// admin submits a gzipped tar (base64 JSON, same envelope as shared-skills),
// it is validated structurally (SKILL.md at root) and stored directly in
// the DB row (0040). The git source is cleared — the archive is now the
// single source of truth. The version is taken from the request (must match
// the metadata inside, otherwise the client install fails cleanly).
func uploadSkillArchiveAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	// 归档以 base64 JSON 上传(base64 膨胀 ~33%):16MB 原始 → ≤24MB body。
	// marketplace 自建 /api/admin 组,不受 serverauth 1MB 中间件覆盖,此处
	// 显式限体(与 sharedskills.MaxBodyBytes 同值)。
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 24<<20)
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	// 存在性检查:上架前该 App 必须已登记(创建与内容分两步)。
	if _, err := serverstore.GetApp(db, serverstore.AppKindSkill, name); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req struct {
		Version string `json:"version"`
		Archive string `json:"archive"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Version == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "version 与 archive 必填")
		return
	}
	if strings.ContainsAny(req.Version, "/\\") || req.Version == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "版本不合法")
		return
	}
	raw, err := base64.StdEncoding.DecodeString(req.Archive)
	if err != nil || len(raw) == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归档编码错误或为空")
		return
	}
	if len(raw) > 16<<20 {
		serverauth.WriteError(c, http.StatusRequestEntityTooLarge, "VALIDATION", "归档过大(上限 16MB)")
		return
	}
	checksum, err := sharedskills.ValidateSkillArchive(raw)
	if err != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+err.Error())
		return
	}
	// 严格清单校验(决策 2026-09-01「包内即真相」):管理端上架与员工上传共用
	// 同一套规则——上游以 frontmatter 的 name 作运行时身份且强制 kebab-case,
	// 不合规的包上架后会被运行时静默忽略(2026-09-01 实测线上 30 个市场技能
	// 只有 3 个能被加载)。
	entries, skillMD, listErr := sharedskills.ListArchiveContents(raw)
	if listErr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档校验失败: "+listErr.Error())
		return
	}
	man, manErr := skillmanifest.Parse(entries, skillMD, name)
	if manErr != nil {
		var me *skillmanifest.Error
		if errors.As(manErr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "SKILL.md 校验失败")
		return
	}
	// 2026-09-01:管理端上架同样走统一发布内核——版本语义(不可复用/必须
	// 递增/内容未变更)、跨渠道同名互斥、changelog 规则与员工路径完全一致,
	// 差别只有 AdminPublish=true(跳过锁定与待审配额,且发布即 approved)。
	res, perr := appstore.Publish(db, appstore.PublishRequest{
		Kind:            serverstore.AppKindSkill,
		AppID:           name,
		Channel:         serverstore.AppChannelMarket,
		Archive:         raw,
		Publisher:       adminUsername(c),
		AdminPublish:    true,
		DeclaredVersion: req.Version,
		Manifest:        appstore.FromSkillManifest(man),
		Checksum:        checksum,
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
	_ = serverstore.SetSkillDisplayName(db, name, man.Title)
	// 上传模式不再依赖磁盘缓存:清掉旧 clone/包,避免误读。
	invalidateSkillCache(cacheDir, name)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_update",
		sharedskills.UploadAuditDetail(name, res.Version, man.Title, checksum))
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": res.Version, "checksum": checksum})
}

func updateSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	s, err := serverstore.GetSkill(db, name)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req skillReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	// 0052:版本号一律由「上传新版」端点与归档原子写入——元数据 PUT 改版本
	// 会造成行版本与归档内容失配(git 模式移除后不再有例外)。
	if req.Version != "" && req.Version != s.Version {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请用「上传新版」随归档一起更改版本")
		return
	}
	if req.Description != "" {
		s.Description = req.Description
	}
	if req.Author != "" {
		s.Author = req.Author
	}
	if err := serverstore.UpdateSkill(db, s); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_update", s.Name+" v"+s.Version)
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

func deleteSkillAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	// 下架 = 置 enabled=0(不删行,bootstrap 建议清单过滤)
	if _, err := serverstore.SetSkillEnabled(db, name, false); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "下架失败")
		return
	}
	// 审计 A5-M8: 技能下架必须留痕(可见性变更必审计)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_disable", name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// enableSkillAdmin 重新上架技能(审计 A5-M1):enabled=1,恢复员工建议清单可见性。
func enableSkillAdmin(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.SetSkillEnabled(db, name, true); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上架失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_enable", name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// replaceSkillGrants 整组替换技能的全部部门授权(原子;用户授权保留)。
func replaceSkillGrants(c *gin.Context, db *sql.DB) {
	name := c.Param("name")
	if _, err := serverstore.GetSkill(db, name); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	var req struct {
		Groups []string `json:"groups"`
	}
	// 审计 A5-M7: 未知字段(如 {username})必须报错而非静默忽略 ——
	// 此前误传 username 的请求会把部门授权清空成空组。
	if err := strictBindJSON(c, &req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误(仅接受 groups 字段)")
		return
	}
	if err := serverstore.ReplaceSkillGroupGrants(db, name, req.Groups); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "存在不认识的部门名称")
			return
		}
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权对象不合法")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_grants_replace", name+" "+strings.Join(req.Groups, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// maxFilePreviewBytes caps the inline text returned by the per-file review
// endpoint (与共享技能审核面一致)。
const maxFilePreviewBytes = 1 << 20

// skillArchiveForReview resolves the reviewable archive bytes of one market
// skill: 上传模式直接取 DB 归档;git 模式取磁盘上已构建的包(未构建则明确
// 告知,不静默回空)。
func skillArchiveForReview(s *serverstore.Skill, cacheDir string) ([]byte, string) {
	if len(s.Archive) > 0 {
		return s.Archive, ""
	}
	if !util.SafePathSegment(s.Name) {
		return nil, "技能名不合法"
	}
	for _, ext := range []string{".zip", ".tar.gz"} {
		p := filepath.Join(cacheDir, s.Name+"-"+s.Version+ext)
		if raw, err := os.ReadFile(p); err == nil {
			return raw, ""
		}
	}
	return nil, "该技能尚未上传归档,暂无法预览"
}

// previewSkillAdmin lists a market skill's archive entries and returns its
// SKILL.md inline —— 管理员审批前查看「到底上传了什么」的入口。
// 此前只有组织共享库有预览,管理后台上架的市场技能无从查看内容。
func previewSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	files, content, lerr := sharedskills.ListArchiveContents(raw)
	if lerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"files": files, "skill_md": content,
		"name": s.Name, "version": s.Version, "checksum": s.Checksum,
	})
}

// fileContentSkillAdmin returns one file's content from a market skill's
// archive (审批时逐文件查看)。契约与共享技能审核面完全一致,webadmin 复用
// 同一个预览组件。
func fileContentSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	target := c.Query("path")
	if target == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少文件路径")
		return
	}
	norm, nerr := archiveutil.NormalizePath(target)
	if nerr != nil || norm == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "文件路径不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	content, size, found, binary, tooLarge, xerr := archiveutil.ExtractFileContent(raw, norm, maxFilePreviewBytes)
	if xerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	if !found {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "归档中不存在该文件")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"path": norm, "size": size, "binary": binary, "too_large": tooLarge, "content": content,
	})
}

// normalizeSkillAdmin 一键规范化:把一个不合规的存量技能包改写成符合发布
// 契约的内容,并作为**新版本**(patch+1)入库。
//
// 决策 2026-09-01 §八:历史版本不可变,因此规范化不改写原版本,而是产出新
// 版本;规范化只做搬运与补齐(中文 name → title、剥 BOM、补 version/author/
// category),绝不编造 description —— 缺失时明确报错要人工补写。
func normalizeSkillAdmin(c *gin.Context, db *sql.DB, cacheDir string) {
	name := c.Param("name")
	if !util.SafePathSegment(name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	s, err := serverstore.GetSkill(db, name)
	if err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	raw, msg := skillArchiveForReview(s, cacheDir)
	if raw == nil {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", msg)
		return
	}
	files, rerr := archiveutil.ReadAll(raw, sharedskills.ArchiveLimits())
	if rerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档解析失败")
		return
	}
	skillMD, ok := files["SKILL.md"]
	if !ok {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "归档缺少 SKILL.md")
		return
	}
	// 幂等:已经合规的包不再空转升版本(否则重复点「规范化」会不断产生
	// 内容相同、版本号递增的噪音版本)。
	if curEntries, curMD, cerr := sharedskills.ListArchiveContents(raw); cerr == nil {
		if m0, perr := skillmanifest.Parse(curEntries, curMD, s.Name); perr == nil && m0.Version == s.Version {
			_ = serverstore.SetSkillDisplayName(db, s.Name, m0.Title)
			c.JSON(http.StatusOK, gin.H{
				"ok": true, "version": s.Version, "checksum": s.Checksum,
				"changes": []string{}, "already_compliant": true,
			})
			return
		}
	}
	nextVersion := skillmanifest.BumpPatch(s.Version)
	normalized, changes, nerr := skillmanifest.NormalizeSkillMD(string(skillMD), skillmanifest.NormalizeOptions{
		AppID:   s.Name,
		Version: nextVersion,
		Author:  s.Author,
	})
	if nerr != nil {
		var me *skillmanifest.Error
		if errors.As(nerr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code, me.Message)
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化失败")
		return
	}
	// 规范化产出的是新版本:版本号必须体现在包内(包内即真相)。
	normalized = forceVersion(normalized, nextVersion)
	files["SKILL.md"] = []byte(normalized)
	// 溯源目录是客户端本地产物,不应存在于归档中。
	for path := range files {
		if strings.HasPrefix(path, skillmanifest.ProvenanceDir) {
			delete(files, path)
		}
	}
	rebuilt, werr := archiveutil.WriteZip(files)
	if werr != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "重新打包失败")
		return
	}
	checksum, verr := sharedskills.ValidateSkillArchive(rebuilt)
	if verr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后归档校验失败")
		return
	}
	entries, md, lerr := sharedskills.ListArchiveContents(rebuilt)
	if lerr != nil {
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后归档解析失败")
		return
	}
	// 自检:规范化产物必须通过与上传同一套严格校验,否则不入库。
	if _, perr := skillmanifest.Parse(entries, md, s.Name); perr != nil {
		var me *skillmanifest.Error
		if errors.As(perr, &me) {
			serverauth.WriteError(c, skillmanifest.StatusFor(me.Code), me.Code,
				"规范化后仍不合规("+me.Message+"),需人工修正")
			return
		}
		serverauth.WriteError(c, http.StatusUnprocessableEntity, "ARCHIVE_INVALID", "规范化后仍不合规")
		return
	}
	if err := serverstore.ReplaceSkillArchive(db, s.Name, nextVersion, checksum, rebuilt); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	if m2, perr2 := skillmanifest.Parse(entries, md, s.Name); perr2 == nil {
		_ = serverstore.SetSkillDisplayName(db, s.Name, m2.Title)
	}
	invalidateSkillCache(cacheDir, s.Name)
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_normalize",
		s.Name+" v"+s.Version+" → v"+nextVersion+" ("+strings.Join(changes, "; ")+")")
	c.JSON(http.StatusOK, gin.H{"ok": true, "version": nextVersion, "checksum": checksum, "changes": changes})
}

// forceVersion 保证 frontmatter 的 version 与入库版本一致(规范化时旧包可能
// 自带一个较低的 version,不改会与新版本号失配)。
func forceVersion(skillMD, version string) string {
	lines := strings.Split(skillMD, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "version:") {
			lines[i] = "version: " + version
			return strings.Join(lines, "\n")
		}
		if i > 0 && line == "---" {
			break
		}
	}
	return skillMD
}
