package marketplace

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
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
// default). Returns ok=false when unauthenticated.
func (a *API) viewer(c *gin.Context) (u *serverstore.User, groups []string, ok bool) {
	u = serverauth.CurrentUser(c)
	if u == nil {
		return nil, nil, false
	}
	// 有效组(部门树继承)
	groups, err := serverstore.UserEffectiveGroups(a.DB, u.ID)
	if err != nil {
		return nil, nil, false
	}
	return u, groups, true
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
	u, groups, ok := a.viewer(c)
	if !ok {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
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
	u, groups, ok := a.viewer(c)
	if !ok {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
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
	u, groups, ok := a.viewer(c)
	if !ok {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
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

	if len(s.Archive) == 0 {
		// 0052: git 源模式已移除,归档是唯一内容来源;尚未上传归档的技能
		// 明确 404,不再回退到克隆构建。
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "技能尚未上传归档")
		return
	}
	sum := s.Checksum
	if sum == "" {
		sum = sha256Hex(s.Archive)
	}
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
	_, _ = serverstore.IncrementSkillDownload(a.DB, s.Name)
	c.Data(http.StatusOK, contentType, s.Archive)
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
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
