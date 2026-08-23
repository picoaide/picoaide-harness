package marketplace

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// API holds the marketplace handlers' dependencies.
type API struct {
	DB       *sql.DB
	CacheDir string

	// configRateLimit/rateWindow bound credential fetches per user
	// (defaults: 30/hour, see NewAPI).
	configRateLimit int
	rateWindow      time.Duration
	mu              sync.Mutex
	configHits      map[int64]*rateCounter
}

type rateCounter struct {
	windowStart time.Time
	count       int
}

// NewAPI creates the marketplace API with a 30/hour per-user config limit.
func NewAPI(db *sql.DB, cacheDir string) *API {
	return &API{
		DB:              db,
		CacheDir:        cacheDir,
		configRateLimit: 30,
		rateWindow:      time.Hour,
		configHits:      map[int64]*rateCounter{},
	}
}

// RegisterRoutes mounts the /api/marketplace endpoints. All require login.
func (a *API) RegisterRoutes(r *gin.Engine) {
	g := r.Group("/api/marketplace", serverauth.BearerAuth(a.DB))
	g.GET("/skills", a.listSkills)
	g.GET("/skills/updates", a.skillUpdates)
	g.GET("/skills/:name", a.getSkill)
	g.GET("/skills/:name/archive", a.downloadArchive)
	g.GET("/mcp", a.listMCP)
	g.GET("/mcp/:id/config", a.getMCPConfig)
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

// accessibleMCPs returns enabled MCP servers the caller may use (admin: all).
func (a *API) accessibleMCPs(u *serverstore.User, groups []string) ([]serverstore.MCPServer, error) {
	list, err := serverstore.ListMCPServers(a.DB, true)
	if err != nil {
		return nil, err
	}
	if u.IsAdmin {
		return list, nil
	}
	set, err := serverstore.AccessibleMCPSet(a.DB, u.Username, groups)
	if err != nil {
		return nil, err
	}
	out := make([]serverstore.MCPServer, 0, len(list))
	for _, m := range list {
		if set[m.ID] {
			out = append(out, m)
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

// parseInstalled parses the `installed` query param: "name:version" pairs
// separated by commas (URL-encoded). Bounds: ≤100 items, safe names.
func parseInstalled(v string) (map[string]string, error) {
	out := map[string]string{}
	if v == "" {
		return out, nil
	}
	items := strings.Split(v, ",")
	if len(items) > 100 {
		return nil, fmt.Errorf("installed 超过 100 项")
	}
	for _, it := range items {
		name, ver, ok := strings.Cut(it, ":")
		if !ok || name == "" || strings.TrimSpace(ver) == "" {
			return nil, fmt.Errorf("installed 格式错误(应为 name:version,逗号分隔)")
		}
		if !util.SafePathSegment(name) {
			return nil, fmt.Errorf("技能名不合法")
		}
		out[name] = strings.TrimSpace(ver)
	}
	return out, nil
}

// skillUpdates returns skills that have a newer version than the client's
// installed set (auto-upgrade detection for connecting clients). Permission
// model matches the catalog: admins see all enabled skills, everyone else
// only granted skills; disabled skills never appear.
func (a *API) skillUpdates(c *gin.Context) {
	u, groups, ok := a.viewer(c)
	if !ok {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	installed, err := parseInstalled(c.Query("installed"))
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
		return
	}
	if len(installed) == 0 {
		c.JSON(http.StatusOK, gin.H{"updates": []gin.H{}, "count": 0})
		return
	}
	list, err := a.accessibleSkills(u, groups)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能列表读取失败")
		return
	}
	updates := make([]gin.H, 0)
	for _, s := range list {
		clientVer, present := installed[s.Name]
		if !present || s.Version == clientVer {
			continue
		}
		updates = append(updates, gin.H{
			"name":        s.Name,
			"version":     s.Version,
			"description": s.Description,
			"author":      s.Author,
			"archive_url": "/api/marketplace/skills/" + s.Name + "/archive",
		})
	}
	c.JSON(http.StatusOK, gin.H{"updates": updates, "count": len(updates)})
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
	if err := os.MkdirAll(a.CacheDir, 0700); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "缓存目录创建失败")
		return
	}
	repoDir := filepath.Join(a.CacheDir, s.Name)
	if _, err := os.Stat(repoDir); os.IsNotExist(err) {
		if err := CloneRepo(s.GitURL, s.GitRef, repoDir); err != nil {
			serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "技能源克隆失败")
			return
		}
	}
	pkg, err := BuildPackage(repoDir, s.Name, s.Version)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "技能打包失败")
		return
	}
	// SHA-256 of the built archive: persisted once into the skills row and
	// served to clients so they can reject tampered/corrupt downloads.
	sum, err := fileSHA256(pkg)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "技能校验失败")
		return
	}
	if s.Checksum != sum {
		s.Checksum = sum
		// best effort: the header is authoritative for the bytes served;
		// the row is re-synced on the next download if this write fails.
		_ = serverstore.UpdateSkill(a.DB, s)
	}
	c.Header("Content-Type", "application/gzip")
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", s.Name+"-"+s.Version+".tar.gz"))
	c.Header("X-Skill-Version", s.Version)
	c.Header("X-Skill-Checksum", sum)
	c.File(pkg)
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
		"git_url":     s.GitURL,
		"git_ref":     s.GitRef,
		"checksum":    s.Checksum,
		"enabled":     s.Enabled == 1,
		"created_at":  s.CreatedAt,
		"updated_at":  s.UpdatedAt,
	}
}

func (a *API) listMCP(c *gin.Context) {
	u, groups, ok := a.viewer(c)
	if !ok {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	list, err := a.accessibleMCPs(u, groups)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "插件列表读取失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, m := range list {
		out = append(out, mcpJSON(m, maskValues(m.Env), maskValues(m.Headers)))
	}
	c.JSON(http.StatusOK, gin.H{"mcp": out})
}

func (a *API) getMCPConfig(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效的插件 ID")
		return
	}
	u := serverauth.CurrentUser(c)
	if u == nil {
		serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	m, err := serverstore.GetMCPServer(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "插件读取失败")
		return
	}
	if m.Enabled != 1 {
		// 建议安装制:下架即不可拉取,与不存在同响应
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件已下架")
		return
	}
	// 严格授权:未授权用户与不存在同响应,不泄露存在性。
	// 组解析必须用 effective groups(祖先链 + 主管子树 + 隐式全员),
	// 与列表/bootstrap 同口径——否则子部门成员看得到插件却拉不到配置。
	if !u.IsAdmin {
		groups, gerr := serverstore.UserEffectiveGroups(a.DB, u.ID)
		if gerr != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "插件读取失败")
			return
		}
		set, serr := serverstore.AccessibleMCPSet(a.DB, u.Username, groups)
		if serr != nil || !set[id] {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
			return
		}
	}
	if !a.configTake(u.ID) {
		serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "拉取过于频繁,请稍后再试")
		return
	}
	key, err := util.GetMasterKey()
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "主密钥未初始化")
		return
	}
	env, err := DecryptEnv(key, m.Env)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证解密失败")
		return
	}
	headers, err := DecryptEnv(key, m.Headers)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证解密失败")
		return
	}
	if err := serverstore.RecordDownload(a.DB, u.ID, m.ID); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "审计记录失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"config": mcpJSON(*m, env, headers)})
}

// configTake checks the per-user budget and records the take in one critical
// section (C-11: a split check-then-act would let concurrent requests blow
// past the limit). Stale windows are pruned on every take.
func (a *API) configTake(userID int64) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	// ponytail: map is bounded by the user count (small in practice), so
	// pruning on every take is fine; switch to a size threshold if it grows
	for id, rc := range a.configHits {
		if time.Since(rc.windowStart) > 2*a.rateWindow {
			delete(a.configHits, id)
		}
	}
	rc := a.configHits[userID]
	if rc != nil && time.Since(rc.windowStart) <= a.rateWindow && rc.count >= a.configRateLimit {
		return false
	}
	if rc == nil || time.Since(rc.windowStart) > a.rateWindow {
		rc = &rateCounter{windowStart: time.Now()}
		a.configHits[userID] = rc
	}
	rc.count++
	return true
}

func mcpJSON(m serverstore.MCPServer, env, headers map[string]string) gin.H {
	return gin.H{
		"id":          m.ID,
		"name":        m.Name,
		"description": m.Description,
		"transport":   m.Transport,
		"command":     m.Command,
		"args":        m.Args,
		"url":         m.URL,
		"env":         env,
		"headers":     headers,
		// 审计 A5-H1: 前端用 enabled 渲染上架/已下架徽标与下架/重新上架按钮,
		// 缺失该字段曾导致管理页所有插件恒显「已下架」且无法下架。
		"enabled": m.Enabled == 1,
	}
}

// maskValues masks every env/headers value ("***"). Used by the client-facing
// suggestion list: clients must not see any configured value.
func maskValues(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k := range m {
		out[k] = "***"
	}
	return out
}

// maskSensitiveValues masks only values under sensitive keys (credentials);
// non-sensitive values (TIMEOUT, URL, …) stay readable for admins, so the
// webadmin edit form can prefill them without re-typing secrets.
func maskSensitiveValues(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		if sensitiveEnvKey(k) {
			out[k] = "***"
		} else {
			out[k] = v
		}
	}
	return out
}
