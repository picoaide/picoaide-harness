package marketplace

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// RegisterAdminRoutes mounts /api/admin/skills, /api/admin/mcp and
// /api/admin/mcp-downloads behind AdminAuth. cacheDir is the skill repo/archive
// cache, invalidated when a skill's source changes (C-6).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB, cacheDir string) {
	g := r.Group("/api/admin", serverauth.AdminAuth(db))
	g.GET("/skills", func(c *gin.Context) { listSkillsAdmin(c, db) })
	g.POST("/skills", func(c *gin.Context) { createSkillAdmin(c, db) })
	g.PUT("/skills/:name", func(c *gin.Context) { updateSkillAdmin(c, db, cacheDir) })
	g.DELETE("/skills/:name", func(c *gin.Context) { deleteSkillAdmin(c, db) })
	// 重新上架(审计 A5-M1: 下架不可逆曾导致误下架无法恢复)
	g.POST("/skills/:name/enable", func(c *gin.Context) { enableSkillAdmin(c, db) })
	g.GET("/mcp", func(c *gin.Context) { listMCPAdmin(c, db) })
	g.POST("/mcp", func(c *gin.Context) { createMCPAdmin(c, db) })
	g.PUT("/mcp/:id", func(c *gin.Context) { updateMCPAdmin(c, db) })
	g.DELETE("/mcp/:id", func(c *gin.Context) { deleteMCPAdmin(c, db) })
	g.POST("/mcp/:id/enable", func(c *gin.Context) { enableMCPAdmin(c, db) })
	g.GET("/mcp-downloads", func(c *gin.Context) { listDownloads(c, db) })
	// 授权管理(严格默认:未授权不可见/不可下载)
	g.GET("/skills/:name/grants", func(c *gin.Context) { listSkillGrants(c, db) })
	g.PUT("/skills/:name/grants", func(c *gin.Context) { replaceSkillGrants(c, db) })
	g.PUT("/skills/:name/grant", func(c *gin.Context) { setSkillGrant(c, db, true) })
	g.DELETE("/skills/:name/grant", func(c *gin.Context) { setSkillGrant(c, db, false) })
	g.GET("/mcp/:id/grants", func(c *gin.Context) { listMCPGrants(c, db) })
	g.PUT("/mcp/:id/grants", func(c *gin.Context) { replaceMCPGrants(c, db) })
	g.PUT("/mcp/:id/grant", func(c *gin.Context) { setMCPGrant(c, db, true) })
	g.DELETE("/mcp/:id/grant", func(c *gin.Context) { setMCPGrant(c, db, false) })
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
	applyGrant(c, db, grant, name,
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.GrantSkill(db, name, subject, t)
		},
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.RevokeSkill(db, name, subject, t)
		},
		"skill_grant", "skill_revoke")
}

func listMCPGrants(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if _, err := serverstore.GetMCPServer(db, id); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	grants, err := serverstore.ListMCPGrants(db, id)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, grantsJSON(grants))
}

func setMCPGrant(c *gin.Context, db *sql.DB, grant bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if _, err := serverstore.GetMCPServer(db, id); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	label := "mcp#" + strconv.FormatInt(id, 10)
	applyGrant(c, db, grant, label,
		func(subject string, t serverstore.GranteeType) error { return serverstore.GrantMCP(db, id, subject, t) },
		func(subject string, t serverstore.GranteeType) error {
			return serverstore.RevokeMCP(db, id, subject, t)
		},
		"mcp_grant", "mcp_revoke")
}

// applyGrant 是 skill/mcp 单条授权与撤销的公共实现(审计 A5-L1):解析请求体
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
	if !util.SafePathSegment(name) {
		return
	}
	os.RemoveAll(filepath.Join(cacheDir, name))
	matches, _ := filepath.Glob(filepath.Join(cacheDir, name+"-*.tar.gz"))
	for _, m := range matches {
		os.Remove(m)
	}
}

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
	GitURL      string `json:"git_url"`
	GitRef      string `json:"git_ref"`
}

// validGitURL restricts skill git sources to http/https (审计 A5-L10):
// file://、ftp 与内网协议会让服务端按管理员输入主动出网克隆,扩大攻击面;
// 只放行可被 git 安全拉取的远程仓库地址。
func validGitURL(u string) bool {
	parsed, err := url.Parse(u)
	if err != nil {
		return false
	}
	return (parsed.Scheme == "http" || parsed.Scheme == "https") && parsed.Host != ""
}

func createSkillAdmin(c *gin.Context, db *sql.DB) {
	var req skillReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" || req.GitURL == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称和 Git 地址必填")
		return
	}
	if !util.SafePathSegment(req.Name) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能名不合法")
		return
	}
	if !validGitURL(req.GitURL) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "Git 地址必须是 http/https 远程仓库")
		return
	}
	if req.GitRef == "" {
		req.GitRef = "main"
	}
	s := &serverstore.Skill{Name: req.Name, Version: req.Version, Description: req.Description,
		Author: req.Author, GitURL: req.GitURL, GitRef: req.GitRef, Enabled: 1}
	if _, err := serverstore.AddSkill(db, s); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "技能已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "skill_create", s.Name+" v"+s.Version)
	c.JSON(http.StatusOK, gin.H{"skill": skillJSON(*s)})
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
	sourceChanged := false
	if req.Version != "" && req.Version != s.Version {
		s.Version = req.Version
		sourceChanged = true
	}
	if req.Description != "" {
		s.Description = req.Description
	}
	if req.Author != "" {
		s.Author = req.Author
	}
	if req.GitURL != "" && req.GitURL != s.GitURL {
		if !validGitURL(req.GitURL) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "Git 地址必须是 http/https 远程仓库")
			return
		}
		s.GitURL = req.GitURL
		sourceChanged = true
	}
	if req.GitRef != "" && req.GitRef != s.GitRef {
		s.GitRef = req.GitRef
		sourceChanged = true
	}
	if err := serverstore.UpdateSkill(db, s); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	// C-6: the cached repo/archive now describe a different source
	if sourceChanged {
		invalidateSkillCache(cacheDir, s.Name)
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
	// 审计 A5-M8: 技能下架与 mcp_disable 一致,必须留痕(可见性变更必审计)
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

func listMCPAdmin(c *gin.Context, db *sql.DB) {
	list, err := serverstore.ListMCPServers(db, false)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, m := range list {
		// 管理端视图:仅敏感 key 掩码,非敏感值(如 TIMEOUT)明文可见便于编辑回填
		out = append(out, mcpJSON(m, maskSensitiveValues(m.Env), maskSensitiveValues(m.Headers)))
	}
	c.JSON(http.StatusOK, gin.H{"mcp": out})
}

type mcpReq struct {
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Transport   string            `json:"transport"`
	Command     string            `json:"command"`
	Args        []string          `json:"args"`
	URL         string            `json:"url"`
	Env         map[string]string `json:"env"`
	Headers     map[string]string `json:"headers"`
}

// encryptMCPValues encrypts sensitive env/headers values in place.
func encryptMCPValues(req *mcpReq) error {
	key, err := util.GetMasterKey()
	if err != nil {
		return err
	}
	if req.Env != nil {
		req.Env = EncryptEnv(key, req.Env)
	}
	if req.Headers != nil {
		req.Headers = EncryptEnv(key, req.Headers)
	}
	return nil
}

func createMCPAdmin(c *gin.Context, db *sql.DB) {
	var req mcpReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称必填")
		return
	}
	if req.Transport == "" {
		req.Transport = "stdio"
	}
	if err := encryptMCPValues(&req); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证加密失败")
		return
	}
	m := &serverstore.MCPServer{Name: req.Name, Description: req.Description, Transport: req.Transport,
		Command: req.Command, Args: req.Args, URL: req.URL, Env: req.Env, Headers: req.Headers, Enabled: 1}
	if _, err := serverstore.AddMCPServer(db, m); err != nil {
		// 审计 A5-M9: 0026 迁移后 name 唯一,重名与技能一致返回 VALIDATION
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "插件名称已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "mcp_create", "mcp#"+strconv.FormatInt(m.ID, 10)+" "+m.Name)
	c.JSON(http.StatusOK, gin.H{"mcp": mcpJSON(*m, maskSensitiveValues(m.Env), maskSensitiveValues(m.Headers))})
}

func updateMCPAdmin(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	m, err := serverstore.GetMCPServer(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req mcpReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if req.Name != "" {
		m.Name = req.Name
	}
	if req.Description != "" {
		m.Description = req.Description
	}
	if req.Transport != "" {
		m.Transport = req.Transport
	}
	if req.Command != "" {
		m.Command = req.Command
	}
	if req.Args != nil {
		m.Args = req.Args
	}
	if req.URL != "" {
		m.URL = req.URL
	}
	// 凭证更新契约(审计 A5-H2):env/headers 为 nil 表示整体不变;传入的 map
	// 是期望的完整 key 集合 —— 掩码值 "***"/enc:v1: 前缀保持现有存储值,
	// 真实值覆盖(敏感 key 自动加密),未出现的 key 从存储中删除。
	if req.Env != nil || req.Headers != nil {
		key, err := util.GetMasterKey()
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "凭证加密失败")
			return
		}
		if req.Env != nil {
			m.Env = EncryptEnv(key, mergeEnvValues(m.Env, req.Env))
		}
		if req.Headers != nil {
			m.Headers = EncryptEnv(key, mergeEnvValues(m.Headers, req.Headers))
		}
	}
	if err := serverstore.UpdateMCPServer(db, m); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "mcp_update", "mcp#"+strconv.FormatInt(m.ID, 10)+" "+m.Name)
	c.JSON(http.StatusOK, gin.H{"mcp": mcpJSON(*m, maskSensitiveValues(m.Env), maskSensitiveValues(m.Headers))})
}

func deleteMCPAdmin(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// 下架 = 置 enabled=0
	if err := serverstore.SetMCPEnabled(db, id, false); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "下架失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "mcp_disable", "mcp#"+strconv.FormatInt(id, 10))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// enableMCPAdmin 重新上架 MCP 插件(审计 A5-M1):enabled=1,恢复可拉取凭证。
func enableMCPAdmin(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if err := serverstore.SetMCPEnabled(db, id, true); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "上架失败")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "mcp_enable", "mcp#"+strconv.FormatInt(id, 10))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func listDownloads(c *gin.Context, db *sql.DB) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 500 {
		size = 50
	}
	rows, total, err := serverstore.ListDownloadsPaged(db, (page-1)*size, size)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(rows))
	for _, d := range rows {
		out = append(out, gin.H{
			"id":         d.ID,
			"username":   d.Username,
			"mcp_id":     d.MCPID,
			"mcp_name":   d.MCPName,
			"created_at": d.CreatedAt.Format(time.RFC3339),
		})
	}
	c.JSON(http.StatusOK, gin.H{"downloads": out, "total": total})
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

// replaceMCPGrants 整组替换 MCP 的全部部门授权(原子;用户授权保留)。
func replaceMCPGrants(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if _, err := serverstore.GetMCPServer(db, id); errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "插件不存在")
		return
	}
	var req struct {
		Groups []string `json:"groups"`
	}
	if err := strictBindJSON(c, &req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误(仅接受 groups 字段)")
		return
	}
	if err := serverstore.ReplaceMCPGroupGrants(db, id, req.Groups); err != nil {
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "存在不认识的部门名称")
			return
		}
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "授权对象不合法")
		return
	}
	_ = serverstore.AuditLog(db, adminUsername(c), "mcp_grants_replace", "mcp#"+strconv.FormatInt(id, 10)+" "+strings.Join(req.Groups, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}
