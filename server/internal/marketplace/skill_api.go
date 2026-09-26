package marketplace

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/util"
)

// API holds the marketplace handlers' dependencies.
type API struct {
	DB       *sql.DB
	CacheDir string
}

// NewAPI creates the marketplace API.
func NewAPI(db *sql.DB, cacheDir string) *API {
	return &API{
		DB:       db,
		CacheDir: cacheDir,
	}
}

// RegisterRoutes mounts the /api/marketplace endpoints. All require login.
func (a *API) RegisterRoutes(r *gin.Engine) {
	base := "/api/client/v2/marketplace"
	g := r.Group(base, serverauth.BearerAuth(a.DB))
	g.GET("/skills", a.listSkills)
	g.GET("/skills/:name", a.getSkill)
	g.GET("/skills/:name/archive", a.downloadArchive)
}

// viewer resolves the calling user's permission view: admins are implicitly
// allowed everywhere; everyone else sees only granted resources (strict
// default).
//
// 三态契约（A2-01，审计 2026-09-26，P2）—— 实现委托给唯一真源
// `serverauth.ViewerGroups`：`u == nil` ⇒ 未认证（401）、`err != nil` ⇒ 依赖故障
// （**500**，不得回 401：401 会让客户端清会话并删掉磁盘令牌，一次 PG 抖动就把
// 全体在线员工登出）。
func (a *API) viewer(c *gin.Context) (*serverstore.User, []string, error) {
	return serverauth.ViewerGroups(c, a.DB)
}

// accessibleSkills returns enabled skills the caller may use (admin: all).
func (a *API) accessibleSkills(u *serverstore.User, groups []string) ([]serverstore.Skill, error) {
	return a.AccessibleSkills(u, groups)
}

// AccessibleSkills returns enabled skills the caller may use (admin: all).
// Exported for the capabilities aggregation facade (同一可见性语义,复用不复制)。
func (a *API) AccessibleSkills(u *serverstore.User, groups []string) ([]serverstore.Skill, error) {
	list, err := serverstore.ListSkills(a.DB, true)
	if err != nil {
		return nil, err
	}
	if u.IsAdmin {
		return list, nil
	}
	names, err := serverstore.AccessibleSkillNames(a.DB, u.Username, groups)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]bool, len(names))
	for _, n := range names {
		allowed[n] = true
	}
	out := make([]serverstore.Skill, 0, len(list))
	for _, s := range list {
		if allowed[s.Name] {
			out = append(out, s)
		}
	}
	return out, nil
}

func (a *API) listSkills(c *gin.Context) {
	u, groups, verr := a.viewer(c)
	if serverauth.WriteViewerError(c, u, verr) {
		return
	}
	list, err := a.accessibleSkills(u, groups)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能列表读取失败")
		return
	}
	skills := make([]gin.H, 0, len(list))
	for _, s := range list {
		skills = append(skills, skillJSON(s))
	}
	c.JSON(http.StatusOK, gin.H{"skills": skills})
}

func (a *API) getSkill(c *gin.Context) {
	u, groups, verr := a.viewer(c)
	if serverauth.WriteViewerError(c, u, verr) {
		return
	}
	s, err := serverstore.GetSkill(a.DB, c.Param("name"))
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能读取失败")
		return
	}
	// 授权检查先于下架检查(审计2026-L13):未授权用户对"存在但下架"与"不存在"
	// 必须得到同一 404,不得用消息区分资源状态
	if !u.IsAdmin {
		names, err := serverstore.AccessibleSkillNames(a.DB, u.Username, groups)
		if err != nil || !containsName(names, s.Name) {
			// 未授权与不存在同响应:不泄露资源存在性
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
	}
	if s.Enabled != 1 {
		// 与 downloadArchive 一致:下架即不可读,不泄露元数据
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能已下架")
		return
	}
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
}

func containsName(names []string, want string) bool {
	for _, n := range names {
		if n == want {
			return true
		}
	}
	return false
}

func (a *API) downloadArchive(c *gin.Context) {
	u, groups, verr := a.viewer(c)
	if serverauth.WriteViewerError(c, u, verr) {
		return
	}
	s, err := serverstore.GetSkill(a.DB, c.Param("name"))
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能读取失败")
		return
	}
	// 授权先于下架(审计2026-L13)
	if !u.IsAdmin {
		names, err := serverstore.AccessibleSkillNames(a.DB, u.Username, groups)
		if err != nil || !containsName(names, s.Name) {
			// 未授权与不存在/下架同响应:不泄露资源存在性
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能不存在")
			return
		}
	}
	if s.Enabled != 1 {
		// C-10: 下架即不可下载,与不存在同响应(与 MCP 插件一致)
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能已下架")
		return
	}
	if !util.SafePathSegment(s.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	serveSkillArchive(c, a.DB, s)
}

// serveSkillArchive 下发一个市场技能归档的字节流 —— **两个命名空间共用这一份实现**：
// 员工面 `GET /api/client/v2/marketplace/skills/:name/archive` 与管理面
// `GET /api/server/admin/skills/:name/archive`（后者是 webadmin 预览弹层
// 「文件过大 → 下载归档」的落点）。头集合只有一处真源：
//
//   - Content-Type / Content-Disposition 跟随归档**实际格式**（zip 推荐、tar.gz 兼容，
//     按魔数嗅探而不是按版本号猜）；
//   - X-Skill-Version / X-Skill-Checksum 是客户端安装器的完整性对照契约；
//   - 下载计数在这里（员工下载与管理端核查下载都算，与组织侧两条档案端点同口径：
//     sharedskills.download 与 agentshare.serveArchive 也不区分 admin）。
//
// 调用方各自负责"谁可以下"：员工面先过授权 + 上下架闸门，管理面不过闸门（管理员本就
// 能看全部内容，与组织侧的 DownloadAdmin 同形）。
func serveSkillArchive(c *gin.Context, db *sql.DB, s *serverstore.Skill) {
	if len(s.Archive) == 0 {
		// 0052: git 源模式已移除,归档是唯一内容来源;尚未上传归档的技能
		// 明确 404,不再回退到克隆构建。
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能尚未上传归档")
		return
	}
	// 空值兜底与组织面**共用一份实现**（sharedskills.ArchiveChecksum，A2-02）：
	// 这两个端点是同一份"员工安装通路"契约的两面，口径必须逐字一致
	// （判据：internal/marketplace 的跨面同一性用例）。
	sum := sharedskills.ArchiveChecksum(s.Checksum, s.Archive)
	// 按归档实际格式回响应(zip 推荐 / tar.gz 兼容)。
	dispName := s.Name + "-" + s.Version + ".tar.gz"
	contentType := "application/gzip"
	if archiveutil.Format(s.Archive) == "zip" {
		dispName = s.Name + "-" + s.Version + ".zip"
		contentType = "application/zip"
	}
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", "attachment; filename=\""+dispName+"\"")
	c.Header("X-Skill-Version", s.Version)
	c.Header("X-Skill-Checksum", sum)
	_, _ = serverstore.IncrementSkillDownload(db, s.Name)
	c.Data(http.StatusOK, contentType, s.Archive)
}

func skillJSON(s serverstore.Skill) gin.H {
	return gin.H{
		"id":          s.ID,
		"name":        s.Name,
		"version":     s.Version,
		"description": s.Description,
		"author":      s.Author,
		"checksum":    s.Checksum,
		"enabled":     s.Enabled == 1,
		"downloads":   s.Downloads,
		"calls":       s.Calls,
		"official":    s.Official == 1,
		"created_at":  s.CreatedAt,
		"updated_at":  s.UpdatedAt,
	}
}
