package serverauth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/updatecheck"
	"github.com/picoaide/picoaide/internal/util"
)

const sessionCookieName = "picoaide_session"

// adminMaxBodyBytes bounds admin JSON request bodies (审计 2026-08-25 F-06).
const adminMaxBodyBytes = 1 << 20 // 1MB

// secureCookieFor reports whether the session cookie should carry Secure.
// Order: explicit server.secure_cookies setting → X-Forwarded-Proto: https
// (behind Caddy) → direct TLS. Never trusts a downgrade header.
func secureCookieFor(c *gin.Context, db *sql.DB) bool {
	if v, ok, err := serverstore.GetSetting(db, "server.secure_cookies"); err == nil && ok {
		return strings.TrimSpace(v) == "1"
	}
	if c.Request.TLS != nil {
		return true
	}
	// 反代标志:仅信任 "https",不信任任何显式 "0"/"off"(攻击者伪造只会
	// 增强而非削弱 cookie 安全)。
	return strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

// minPasswordLength is the minimum password length for admin-created users.
// Password expiry is deliberately out of scope for now.
const minPasswordLength = 10

// adminLoginLimiter bounds admin login attempts (ip+username) so the
// password is not brute-forceable without rate limiting.
// 延迟到首次登录调用时创建(惰性单例):newLoginLimiter 在包 init 时读
// PICOAI_LOGIN_MAX_ATTEMPTS,若包级立即初始化,测试 t.Setenv 来不及生效,
// 多用例登录同一用户会互相限流(审计2026-M10 后新增用例触发)。
var adminLoginLimiterOnce sync.Once
var adminLoginLimiterVal *loginLimiter

func adminLoginLimiter() *loginLimiter {
	adminLoginLimiterOnce.Do(func() {
		adminLoginLimiterVal = newLoginLimiter()
	})
	return adminLoginLimiterVal
}

// UpdateChecker 接口是版本检查的最小依赖(生产用 updatecheck.CachedChecker,
// 测试注入 fake 避免外网)。定义在 serverauth 以避免反向依赖。
type UpdateChecker interface {
	Check(ctx context.Context, current string) (*updatecheck.Result, error)
}

// AdminAPI holds the admin web handlers.
type AdminAPI struct {
	DB *sql.DB
	// UpdateChecker 是版本检查器(2026-08-31);nil 时 handler 用包级
	// 默认缓存 checker(生产),测试可注入 mock 避免打外网。
	UpdateChecker UpdateChecker
}

// issuerURLRe 校验测试连接 issuer(§1.2 SSRF; CodeQL regexp barrier):
// 仅 https://<host[:port]>/... 或 http://localhost[:port]/...;
// host 不允许 @(无 userinfo)、空白; 端口限定数字。
var issuerURLRe = regexp.MustCompile(`^(https)://[A-Za-z0-9.\-]+(:\d+)?(/[^\s]*)?$|^(http)://(localhost|127\.0\.0\.1)(:\d+)?(/[^\s]*)?$`)

// ldapProbeDialHook 是 testAuthConnection 的 LDAP dial 注入点(仅测试用;
// 生产 nil 走真实网络)。
var ldapProbeDialHook func(url string) (ldapConn, error)

// RegisterAdminRoutes mounts /api/admin/* with session+CSRF protection and
// RBAC permission checks (design v3b: every protected route declares its
// permission through AdminRoute; me/logout require only a valid session).
// 双轨镜像,handler/中间件与 /api 完全共享,只能增加不能减少)。
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	base := "/api/server/admin"
	a := &AdminAPI{DB: db}
	g := r.Group(base)
	// 管理端 JSON 请求体统一上限(审计 2026-08-25 F-06):admin 路由的
	// ShouldBindJSON 此前无 MaxBytesReader,被攻破/异常的管理会话可发起
	// 大 body 内存消耗;1MB 足够全部管理表单(含技能描述/理由上限 500 字)。
	g.Use(func(c *gin.Context) {
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, adminMaxBodyBytes)
		}
		c.Next()
	})
	// 公开:登录与登录方式发现(不经过 AdminAuth/RequirePermission)。
	g.POST("/login", a.handleLogin)
	g.GET("/auth/methods", a.getPublicAuthMethods)
	// 管理会话内(AdminAuth 已校验 role != user + CSRF)。
	authed := g.Group("", AdminAuth(db))
	AdminRoute(authed, "GET", "/me", "", a.handleMe)
	AdminRoute(authed, "POST", "/logout", "", a.handleLogout)
	// 用户/角色/部门(RBAC 管理)。
	AdminRoute(authed, "GET", "/users", PermUserRead, a.listUsers)
	AdminRoute(authed, "POST", "/users", PermUserWrite, a.createUser)
	AdminRoute(authed, "PUT", "/users/:id", PermUserWrite, a.updateUser)
	AdminRoute(authed, "DELETE", "/users/:id", PermUserWrite, a.deleteUser)
	AdminRoute(authed, "GET", "/users/:id/groups", PermUserRead, a.getUserGroups)
	// 单部门归属:多部门 set 端点已移除(与金字塔单部门模型冲突,审计2026-C6)
	AdminRoute(authed, "PUT", "/users/:id/department", PermDeptWrite, a.setUserDepartment)
	// 部门管理(金字塔组织架构)
	AdminRoute(authed, "GET", "/departments", PermDeptRead, a.listDepartments)
	AdminRoute(authed, "POST", "/departments", PermDeptWrite, a.createDepartment)
	AdminRoute(authed, "PUT", "/departments/:id", PermDeptWrite, a.updateDepartment)
	AdminRoute(authed, "DELETE", "/departments/:id", PermDeptWrite, a.deleteDepartment)
	AdminRoute(authed, "GET", "/users/:id/tokens", PermUserRead, a.listUserTokens)
	AdminRoute(authed, "POST", "/tokens/:id/revoke", PermUserWrite, a.revokeToken)
	AdminRoute(authed, "GET", "/usage", PermUsageRead, a.usage)
	// 服务器信息面板(系统 + 数据库统计)
	AdminRoute(authed, "GET", "/server-info", PermServerInfoRead, a.handleServerInfo)
	// 敏感操作审计日志(用户/部门/技能/令牌等)
	AdminRoute(authed, "GET", "/audit", PermAuditRead, a.listAuditLogs)
	// 认证配置(LDAP/OIDC):读 settings 脱敏返回;写时密码留空=不更换
	AdminRoute(authed, "GET", "/auth", PermAuthRead, a.getAuthConfig)
	AdminRoute(authed, "PUT", "/auth", PermAuthWrite, a.setAuthConfig)
	// v3b §1.2: 测试连接(LDAP bind / OIDC discovery, 不写配置)。
	AdminRoute(authed, "POST", "/auth/test", PermAuthWrite, a.testAuthConnection)
}

// AdminAuth validates the admin session cookie and (for non-GET) CSRF token.
// Export the current admin user via serverauth.AdminUser(c).
func AdminAuth(db *sql.DB) gin.HandlerFunc {
	a := &AdminAPI{DB: db}
	return a.adminAuth()
}

// AdminUser returns the admin user from the AdminAuth context.
func AdminUser(c *gin.Context) *serverstore.User { return currentAdmin(c) }

// adminAuth validates session cookie and CSRF token for state-changing methods.
func (a *AdminAPI) adminAuth() gin.HandlerFunc {
	return func(c *gin.Context) {
		cookie, err := c.Cookie(sessionCookieName)
		if err != nil || cookie == "" {
			writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
			return
		}
		u, err := ValidateAdminSession(a.DB, cookie)
		if err != nil {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "会话无效或已过期")
			return
		}
		c.Set("admin_user", u)
		c.Set("admin_session", cookie)
		if c.Request.Method != "GET" && c.Request.Method != "HEAD" {
			sess, err := GetAdminSession(a.DB, cookie)
			if err != nil || !VerifyCSRF(sess.CSRFKey, c.GetHeader("X-CSRF-Token"), time.Now()) {
				writeError(c, http.StatusForbidden, "FORBIDDEN", "CSRF 校验失败")
				return
			}
		}
		c.Next()
	}
}

// AuthenticateConfiguredAdmin authenticates an admin login (v3b: local-only).
// 管理后台仅本地账户:SSO(OIDC/OpenID)与 LDAP 一律不进后台——LDAP 仅员工面
// 可用(/api/auth/login 走 ConfigureProviders 的 ldap 员工认证),webadmin 的
// handleLogin 只接受 users 表本地账号。返回用户行,调用方仍需校验
// HasManagementAccess(super_admin/auditor 可入,user 拒绝)。
func AuthenticateConfiguredAdmin(db *sql.DB, username, password string) (*serverstore.User, error) {
	ui, err := NewLocalProvider(db).Authenticate(username, password)
	if err != nil {
		return nil, err
	}
	u, err := provisionUser(db, ui)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (a *AdminAPI) handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	// 双桶限流(审计 2026-08-25 F-02):ip|username 防单 IP 爆破;
	// username 桶防反代坍缩/分布式下的账号级 DoS。
	if !adminLoginLimiter().allow(loginKey(c, req.Username)) || !adminLoginLimiter().allow("u:"+req.Username) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return
	}
	u, err := AuthenticateConfiguredAdmin(a.DB, req.Username, req.Password)
	if err != nil || !u.HasManagementAccess() {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "用户名或密码错误或非管理员")
		return
	}
	sess, csrf, err := CreateAdminSession(a.DB, u.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "会话创建失败")
		return
	}
	// Secure cookie(审计 2026-08-25 F-01):显式配置 → X-Forwarded-Proto
	// (反代) → 直连 TLS;默认不再是「明文可绕」。
	secure := secureCookieFor(c, a.DB)
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sess.ID,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
		MaxAge:   int(AdminSessionTTL.Seconds()),
	})
	c.JSON(http.StatusOK, gin.H{"csrf_token": csrf, "user": userJSON(u)})
}

func (a *AdminAPI) handleMe(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	// 返回当前会话的 CSRF token:管理页刷新后(内存 token 丢失)可直接续用,无需重新登录
	sid, _ := c.Get("admin_session")
	csrf := ""
	if s, ok := sid.(string); ok {
		if sess, err := GetAdminSession(a.DB, s); err == nil {
			csrf = IssueCSRF(sess.CSRFKey, time.Now())
		}
	}
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u), "csrf_token": csrf})
}

func (a *AdminAPI) handleLogout(c *gin.Context) {
	if sid, ok := c.Get("admin_session"); ok {
		if s, ok := sid.(string); ok {
			_ = DeleteAdminSession(a.DB, s)
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *AdminAPI) listUsers(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	// 页数上限:超大 page 的 (page-1)*size 会 int 溢出/负偏移(审计2026-L9)
	if page > 100000 {
		page = 100000
	}
	if size < 1 || size > 200 {
		size = 20
	}
	users, total, err := serverstore.ListUsers(a.DB, (page-1)*size, size, c.Query("q"))
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// 批量附组(部门归属):单条 SQL 避免 N+1
	groupsByUser, err := serverstore.UserGroupsBatch(a.DB, users)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// 批量附本月流量用量(配额对照):单条 SQL 避免 N+1
	ids := make([]int64, 0, len(users))
	for i := range users {
		ids = append(ids, users[i].ID)
	}
	usageByUser, err := serverstore.UserMonthlyUsageBatch(a.DB, ids)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	costByUser, err := serverstore.UserMonthlyCostBatch(a.DB, ids)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(users))
	for _, u := range users {
		uj := userJSON(&u)
		uj["groups"] = groupsByUser[u.ID]
		if uj["groups"] == nil {
			uj["groups"] = []string{}
		}
		uj["monthly_usage"] = usageByUser[u.ID] // tokens used this calendar month (0 when none)
		uj["monthly_cost"] = costByUser[u.ID]   // yuan spent this calendar month (0 when none)
		// 生效配额(审计 M7):跟随默认时展示全局值,0 = 不限,admin 恒 0。
		// 与员工侧 GET /api/auth/usage 同口径(EffectiveQuota/EffectiveMoneyQuota)。
		if eq, err := serverstore.EffectiveQuota(a.DB, &u); err == nil {
			uj["effective_quota_tokens"] = eq
		}
		if em, err := serverstore.EffectiveMoneyQuota(a.DB, &u); err == nil {
			uj["effective_quota_money"] = em
		}
		out = append(out, uj)
	}
	c.JSON(http.StatusOK, gin.H{"users": out, "total": total, "page": page, "size": size})
}

// getUserGroups returns the group names a user belongs to.
func (a *AdminAPI) getUserGroups(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	if _, err := serverstore.GetUserByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	groups, err := serverstore.UserGroups(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if groups == nil {
		groups = []string{}
	}
	c.JSON(http.StatusOK, gin.H{"groups": groups})
}

func (a *AdminAPI) createUser(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		Role     string `json:"role"`
		// Back-compat alias: is_admin=true → role=super_admin.
		IsAdmin bool `json:"is_admin"`
		Status  int  `json:"status"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" || req.Password == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "用户名和密码必填")
		return
	}
	if utf8.RuneCountInString(req.Password) < minPasswordLength {
		writeError(c, http.StatusBadRequest, "VALIDATION", "密码至少 10 位")
		return
	}
	status := req.Status
	if status == 0 {
		status = 1
	}
	// status 只允许 0/1(审计2026-L6)
	if status != 0 && status != 1 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "status 只能是 0 或 1")
		return
	}
	role := req.Role
	if role == "" {
		if req.IsAdmin {
			role = serverstore.RoleSuperAdmin
		} else {
			role = serverstore.RoleUser
		}
	}
	if !serverstore.ValidRole(role) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "role 必须是 super_admin/auditor/user")
		return
	}
	id, err := serverstore.CreateUserWithPassword(a.DB, req.Username, req.Password)
	if errors.Is(err, serverstore.ErrDuplicate) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "用户名已存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	if role != serverstore.RoleUser || status != 1 {
		u.Role = role
		u.IsAdmin = role == serverstore.RoleSuperAdmin
		u.Status = status
		if err := serverstore.UpdateUser(a.DB, u); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_create", u.Username)
	c.JSON(http.StatusCreated, gin.H{"user": userJSON(u)}) // L6:创建返回 201
}

func (a *AdminAPI) updateUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req struct {
		DisplayName *string `json:"display_name"`
		Email       *string `json:"email"`
		Password    *string `json:"password"`
		Role        *string `json:"role"`
		// Back-compat alias: is_admin=false → role=user.
		IsAdmin         *bool    `json:"is_admin"`
		Status          *int     `json:"status"`
		QuotaTokens     *int64   `json:"quota_tokens"`
		QuotaClear      bool     `json:"quota_clear"` // reset quota_tokens to NULL (follow global default)
		QuotaMoney      *float64 `json:"quota_money"`
		QuotaMoneyClear bool     `json:"quota_money_clear"` // reset quota_money to NULL (follow global default)
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	me := currentAdmin(c)
	wasRole := u.Role
	wasStatus := u.Status
	wasSuperAdmin := u.IsSuperAdmin()
	// Resolve the new role: explicit role wins; is_admin alias maps to
	// super_admin/user; otherwise the current role is unchanged.
	newRole := u.Role
	if req.Role != nil {
		if !serverstore.ValidRole(*req.Role) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "role 必须是 super_admin/auditor/user")
			return
		}
		newRole = *req.Role
	} else if req.IsAdmin != nil {
		if *req.IsAdmin {
			newRole = serverstore.RoleSuperAdmin
		} else {
			newRole = serverstore.RoleUser
		}
	}
	// guard: cannot demote/disable yourself or the last super_admin.
	if newRole != serverstore.RoleSuperAdmin && wasSuperAdmin && me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能取消自己的管理员权限")
		return
	}
	if req.Status != nil && *req.Status != 1 && wasSuperAdmin && me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能禁用自己")
		return
	}
	if req.DisplayName != nil {
		u.DisplayName = *req.DisplayName
	}
	if req.Email != nil {
		u.Email = *req.Email
	}
	if req.Password != nil && *req.Password != "" {
		// 外部(LDAP/OIDC)用户的密码由 IdP 管理:改写本地密码并置 Source=local 会
		// 让该用户被永久踢出 IdP(provision 防接管守卫拒绝其再次登录)——直接拒绝
		if u.Source == "external" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "外部认证用户的密码由企业 IdP 管理,不能在此修改")
			return
		}
		if utf8.RuneCountInString(*req.Password) < minPasswordLength {
			writeError(c, http.StatusBadRequest, "VALIDATION", "密码至少 10 位")
			return
		}
		hash, err := util.HashPassword(*req.Password)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "密码处理失败")
			return
		}
		u.PasswordHash = hash
	}
	u.Role = newRole
	u.IsAdmin = newRole == serverstore.RoleSuperAdmin
	if req.Status != nil {
		u.Status = *req.Status
	}
	if req.QuotaClear {
		u.QuotaTokens = nil
	} else if req.QuotaTokens != nil {
		if *req.QuotaTokens < 0 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "quota_tokens 不能为负数")
			return
		}
		q := *req.QuotaTokens
		u.QuotaTokens = &q
	}
	if req.QuotaMoneyClear {
		u.QuotaMoney = nil
	} else if req.QuotaMoney != nil {
		if *req.QuotaMoney < 0 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "quota_money 不能为负数")
			return
		}
		q := *req.QuotaMoney
		u.QuotaMoney = &q
	}
	// 权限敏感变更:改密 / 降权(role 降级或取消管理员) / 禁用 → 吊销全部
	// API token,旧凭证立即失效(防已登录客户端继续以旧权限访问)。
	// 与用户更新同事务(审计2026-L16):更新成功但吊销失败不再留下旧凭证
	demoted := wasRole != serverstore.RoleUser && u.Role == serverstore.RoleUser
	demote := (req.Password != nil && *req.Password != "") || demoted ||
		(req.Status != nil && *req.Status != 1 && wasStatus == 1)
	if demote {
		if err := serverstore.UpdateUserRevokingTokens(a.DB, u); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_tokens_revoked", u.Username)
	} else if err := serverstore.UpdateUser(a.DB, u); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	if wasRole != u.Role {
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "role_change", u.Username+"@"+wasRole+"→"+u.Role)
	} else {
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_update", u.Username)
	}
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u)})
}

func (a *AdminAPI) deleteUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	me := currentAdmin(c)
	if me != nil && me.ID == u.ID {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能删除自己")
		return
	}
	// C-17: the last-admin guard runs inside the DeleteUser transaction;
	// the pre-check was removed to close the count-then-delete TOCTOU.
	if err := serverstore.DeleteUser(a.DB, id); err != nil {
		if errors.Is(err, serverstore.ErrLastAdmin) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "不能删除最后一个管理员")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_delete", u.Username)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// tokenJSON is the non-sensitive admin view of an API token.
type tokenJSON struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	CreatedAt  string `json:"created_at"`
	ExpiresAt  string `json:"expires_at"`
	LastUsedAt string `json:"last_used_at"`
	Revoked    int    `json:"revoked"`
}

func (a *AdminAPI) listUserTokens(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	if _, err := serverstore.GetUserByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	tokens, err := serverstore.ListTokensByUser(a.DB, id)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]tokenJSON, 0, len(tokens))
	for _, tk := range tokens {
		lastUsed := ""
		if !tk.LastUsedAt.IsZero() {
			lastUsed = tk.LastUsedAt.Format(time.RFC3339)
		}
		out = append(out, tokenJSON{
			ID: tk.ID, Name: tk.Name, CreatedAt: tk.CreatedAt,
			ExpiresAt: tk.ExpiresAt.Format(time.RFC3339), LastUsedAt: lastUsed, Revoked: tk.Revoked,
		})
	}
	c.JSON(http.StatusOK, gin.H{"tokens": out})
}

func (a *AdminAPI) revokeToken(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法令牌 ID")
		return
	}
	if err := serverstore.RevokeTokenByID(a.DB, id); errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "令牌不存在")
		return
	} else if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "撤销失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// usageDefaultWindowDays 是 /api/admin/usage 缺省 from/to 时的默认回溯窗口
// (天),防止无界全表聚合(审计中2)。
const usageDefaultWindowDays = 90

// maxUserUsageRows 是 group=user 聚合的最大返回行数,超出截断并置
// truncated=true(审计中2)。
const maxUserUsageRows = 500

func (a *AdminAPI) usage(c *gin.Context) {
	// 日期解析失败 → 400,而不是静默无界范围(审计2026-L7)
	fromRaw := c.DefaultQuery("from", "")
	toRaw := c.DefaultQuery("to", "")
	var from, to time.Time
	var err error
	if fromRaw != "" {
		if from, err = time.Parse("2006-01-02", fromRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "from 日期格式错误(YYYY-MM-DD)")
			return
		}
	}
	if toRaw != "" {
		if to, err = time.Parse("2006-01-02", toRaw); err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "to 日期格式错误(YYYY-MM-DD)")
			return
		}
	}
	// to < from → 400,拒绝静默空结果(审计中2)
	if !from.IsZero() && !to.IsZero() && from.After(to) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "起始日期不能晚于结束日期")
		return
	}
	// 缺省区间 → 服务端默认近 90 天窗口,避免无界全表聚合(审计中2)
	if from.IsZero() && to.IsZero() {
		to = time.Now()
		from = to.AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if from.IsZero() {
		from = to.AddDate(0, 0, -usageDefaultWindowDays+1)
	} else if to.IsZero() {
		to = from.AddDate(0, 0, usageDefaultWindowDays-1)
	}
	group := c.DefaultQuery("group", "day")
	if group != "day" && group != "week" && group != "month" && group != "model" && group != "user" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "group 必须是 day|week|month|model|user")
		return
	}
	var opts []serverstore.UsageAggregateOption
	if username := c.Query("username"); username != "" {
		opts = append(opts, serverstore.WithUsername(username))
	}
	rows, err := serverstore.UsageAggregateWithLedger(a.DB, from, to, group, opts...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	// group=user 行数上限:超出截断并置 truncated,避免超大响应拖垮
	// 前端渲染与网络(审计中2)
	truncated := false
	if group == "user" && len(rows) > maxUserUsageRows {
		rows = rows[:maxUserUsageRows]
		truncated = true
	}
	c.JSON(http.StatusOK, gin.H{"rows": rows, "group": group, "truncated": truncated})
}

// listAuditLogs 返回分页审计日志(新→旧),支持 action / username 过滤
// (审计 M8),总数一并返回用于分页。
func (a *AdminAPI) listAuditLogs(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 500 {
		size = 50
	}
	logs, total, err := serverstore.ListAuditLogsPagedFiltered(a.DB, (page-1)*size, size,
		c.Query("action"), c.Query("username"))
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if logs == nil {
		logs = []serverstore.AuditLogEntry{}
	}
	c.JSON(http.StatusOK, gin.H{"logs": logs, "total": total})
}

// getAuthConfig 返回认证配置(脱敏):auth.mode / auth.enabled / ldap.* / oidc.* / openid.*。
// 敏感值(bind_password / client_secret)以 "***" 掩码返回,write 时留空=不更换。
func (a *AdminAPI) getAuthConfig(c *gin.Context) {
	s, err := serverstore.GetAllSettings(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	mask := func(v string) string {
		if v == "" {
			return ""
		}
		return "***"
	}
	c.JSON(http.StatusOK, gin.H{"auth": gin.H{
		"mode":       s["auth.mode"],
		"enabled":    s["auth.enabled"],
		"hide_local": s["auth.hide_local"] == "true",
		"ldap": gin.H{
			"server_url":    s["ldap.server_url"],
			"bind_dn":       s["ldap.bind_dn"],
			"bind_password": mask(s["ldap.bind_password"]),
			"base_dn":       s["ldap.base_dn"],
			"user_filter":   s["ldap.user_filter"],
			"group_filter":  s["ldap.group_filter"],
			"group_attr":    s["ldap.group_attr"],
		},
		"oidc": gin.H{
			"issuer":        s["oidc.issuer"],
			"client_id":     s["oidc.client_id"],
			"client_secret": mask(s["oidc.client_secret"]),
			"redirect_url":  s["oidc.redirect_url"],
		},
		"openid": gin.H{
			"issuer":        s["openid.issuer"],
			"client_id":     s["openid.client_id"],
			"client_secret": mask(s["openid.client_secret"]),
			"redirect_url":  s["openid.redirect_url"],
		},
	}})
}

// setAuthConfig 保存认证配置。
// 契约:enabled 必填(逗号分隔: local,ldap,openid,oidc),未传时按 mode 推导
// (local→local / ldap→ldap / both→local,ldap / oidc→local,oidc / openid→local,openid)。
// 密码类字段(ldap.bind_password / oidc.client_secret / openid.client_secret)写入
// "***" = 保持现值,其余值(含空串)= 覆盖/清空;非密码字段左右 trim 后写入。
// ldap/openid/oidc 三方配置独立保存(互不覆盖),按 enabled 启用。
func (a *AdminAPI) setAuthConfig(c *gin.Context) {
	var req struct {
		Mode      string `json:"mode"`
		Enabled   string `json:"enabled"`
		HideLocal *bool  `json:"hide_local"`
		LDAP      struct {
			ServerURL    string `json:"server_url"`
			BindDN       string `json:"bind_dn"`
			BindPassword string `json:"bind_password"`
			BaseDN       string `json:"base_dn"`
			UserFilter   string `json:"user_filter"`
			GroupFilter  string `json:"group_filter"`
			GroupAttr    string `json:"group_attr"`
		} `json:"ldap"`
		OIDC struct {
			Issuer       string `json:"issuer"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			RedirectURL  string `json:"redirect_url"`
		} `json:"oidc"`
		OpenID struct {
			Issuer       string `json:"issuer"`
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
			RedirectURL  string `json:"redirect_url"`
		} `json:"openid"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	// mode 兼容校验:合法值 local|ldap|both|oidc|openid(可空=默认 local)
	if req.Mode != "" {
		switch req.Mode {
		case "local", "ldap", "both", "oidc", "openid":
		default:
			writeError(c, http.StatusBadRequest, "VALIDATION", "auth.mode 必须是 local|ldap|both|oidc|openid")
			return
		}
	}
	// enabled 推导:未传 enabled 时按 mode 兼容旧客户端
	enabled := req.Enabled
	if strings.TrimSpace(enabled) == "" {
		switch req.Mode {
		case "ldap", "both":
			enabled = "local,ldap"
		case "oidc":
			enabled = "local,oidc"
		case "openid":
			enabled = "local,openid"
		default:
			enabled = "local"
		}
	}
	// 校验 enabled 列表
	parts := strings.Split(enabled, ",")
	seen := map[string]bool{}
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		switch p {
		case "local", "ldap", "openid", "oidc":
		default:
			writeError(c, http.StatusBadRequest, "VALIDATION", "auth.enabled 只能包含 local|ldap|openid|oidc")
			return
		}
		if seen[p] {
			writeError(c, http.StatusBadRequest, "VALIDATION", "auth.enabled 不能重复")
			return
		}
		seen[p] = true
	}
	// 本地 admin 恒启用:enabled 里没有 local 也要强制加(admin 回退)
	// (不写回 auth.enabled,仅运行时生效——配置展示保持用户原意)
	upsert := func(key, val string) error { return serverstore.SetSetting(a.DB, key, val) }
	// v3b redirect_url 安全(§1.5):浏览器跳转方式的 redirect_url 必须
	// https(或 loopback http), 防 open redirect / 任意回调劫持。
	validateRedirect := func(prefix, value string) bool {
		if strings.TrimSpace(value) == "" {
			return true // 未配置允许(仅启用时校验必填)
		}
		u, err := url.Parse(strings.TrimSpace(value))
		if err != nil {
			return false
		}
		loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]"
		return u.Scheme == "https" || (u.Scheme == "http" && loopback)
	}
	for _, kv := range [][2]string{{"oidc", req.OIDC.RedirectURL}, {"openid", req.OpenID.RedirectURL}} {
		if !validateRedirect(kv[0], kv[1]) {
			writeError(c, http.StatusBadRequest, "VALIDATION", kv[0]+".redirect_url 必须是 https(或 http 回环)")
			return
		}
	}
	_ = upsert("auth.mode", req.Mode)
	_ = upsert("auth.enabled", enabled)
	// 保存各类配置(独立,互不清空——切到 ldap 不清 openid,反之亦然)
	_ = upsert("ldap.server_url", strings.TrimSpace(req.LDAP.ServerURL))
	_ = upsert("ldap.bind_dn", strings.TrimSpace(req.LDAP.BindDN))
	if req.LDAP.BindPassword != MaskSecret {
		_ = upsert("ldap.bind_password", req.LDAP.BindPassword)
	}
	_ = upsert("ldap.base_dn", strings.TrimSpace(req.LDAP.BaseDN))
	_ = upsert("ldap.user_filter", strings.TrimSpace(req.LDAP.UserFilter))
	_ = upsert("ldap.group_filter", strings.TrimSpace(req.LDAP.GroupFilter))
	_ = upsert("ldap.group_attr", strings.TrimSpace(req.LDAP.GroupAttr))
	_ = upsert("oidc.issuer", strings.TrimSpace(req.OIDC.Issuer))
	_ = upsert("oidc.client_id", strings.TrimSpace(req.OIDC.ClientID))
	if req.OIDC.ClientSecret != MaskSecret {
		_ = upsert("oidc.client_secret", req.OIDC.ClientSecret)
	}
	_ = upsert("oidc.redirect_url", strings.TrimSpace(req.OIDC.RedirectURL))
	_ = upsert("openid.issuer", strings.TrimSpace(req.OpenID.Issuer))
	_ = upsert("openid.client_id", strings.TrimSpace(req.OpenID.ClientID))
	if req.OpenID.ClientSecret != MaskSecret {
		_ = upsert("openid.client_secret", req.OpenID.ClientSecret)
	}
	_ = upsert("openid.redirect_url", strings.TrimSpace(req.OpenID.RedirectURL))
	if req.HideLocal != nil {
		// v3b: 仅客户端登录页隐藏本地账号入口; 管理后台恒本地登录不受影响。
		_ = upsert("auth.hide_local", strconv.FormatBool(*req.HideLocal))
	}
	// v3b 字段级审计(§2.5):记录本次变更的键集合(值脱敏, 不落密钥)。
	var changed []string
	for _, k := range []string{"auth.mode", "auth.enabled"} {
		changed = append(changed, k)
	}
	if req.LDAP.ServerURL != "" || req.LDAP.BindDN != "" || req.LDAP.BindPassword != MaskSecret && req.LDAP.BindPassword != "" {
		changed = append(changed, "ldap.*")
	}
	if req.OIDC.Issuer != "" || req.OIDC.ClientID != "" || req.OIDC.RedirectURL != "" || req.OIDC.ClientSecret != MaskSecret && req.OIDC.ClientSecret != "" {
		changed = append(changed, "oidc.*")
	}
	if req.OpenID.Issuer != "" || req.OpenID.ClientID != "" || req.OpenID.RedirectURL != "" || req.OpenID.ClientSecret != MaskSecret && req.OpenID.ClientSecret != "" {
		changed = append(changed, "openid.*")
	}
	if req.HideLocal != nil {
		changed = append(changed, "auth.hide_local")
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "auth_config", "changed:"+strings.Join(changed, ","))
	// LDAP 配置生效后立即同步一轮目录(用户要求:配置后自动同步用户/组)。
	// 异步执行:同步为网络 IO(LDAP bind+分页扫描),不应阻塞保存响应;
	// 失败仅记日志,不影响保存结果。
	ldapOn := false
	for _, p := range strings.Split(enabled, ",") {
		if strings.TrimSpace(p) == "ldap" {
			ldapOn = true
			break
		}
	}
	if ldapOn {
		go func() {
			if _, err := SyncDirectoryOnce(a.DB, nil); err != nil {
				_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "ldap_sync", "failed: "+err.Error())
			}
		}()
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// getPublicAuthMethods 返回登录页可用的认证方式(无认证要求):
// enabled 列表 + 各方式是否已配置(browser provider 需要配置齐全才可用)。
// 仅返回元信息,不含任何密码/密钥/URL 等敏感值。
func (a *AdminAPI) getPublicAuthMethods(c *gin.Context) {
	s, err := serverstore.GetAllSettings(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	// v3b 修复(2026-09):此前 configured 只判 oidc 三件套,LDAP 恒判
	// 未配置 → 客户端登录页 LDAP 按钮永久灰(禁用)。LDAP 的可配置性 =
	// server_url/bind_dn/base_dn 必填项齐全(与 webadmin REQUIRED 一致)。
	ldapConfigured := func() bool {
		return s["ldap.server_url"] != "" && s["ldap.base_dn"] != "" && s["ldap.bind_dn"] != ""
	}
	configured := func(prefix string) bool {
		// oidc/openid:browser 三件套齐全才可用
		return s[prefix+".issuer"] != "" && s[prefix+".client_id"] != "" && s[prefix+".redirect_url"] != ""
	}
	enabledRaw := s["auth.enabled"]
	var methods []string
	if strings.TrimSpace(enabledRaw) != "" {
		for _, p := range strings.Split(enabledRaw, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				methods = append(methods, p)
			}
		}
	} else {
		// 未设置 enabled:由 mode 推导
		switch s["auth.mode"] {
		case "ldap", "both":
			methods = []string{"local", "ldap"}
		case "oidc":
			methods = []string{"local", "oidc"}
		case "openid":
			methods = []string{"local", "openid"}
		default:
			methods = []string{"local"}
		}
	}
	// local 恒在(admin 回退)
	found := false
	for _, m := range methods {
		if m == "local" {
			found = true
		}
	}
	if !found {
		methods = append([]string{"local"}, methods...)
	}
	out := make([]gin.H, 0, len(methods))
	hideLocal := s["auth.hide_local"] == "true"
	for _, m := range methods {
		isConfigured := m == "local"
		switch m {
		case "ldap":
			isConfigured = ldapConfigured()
		case "oidc", "openid":
			isConfigured = configured(m)
		}
		out = append(out, gin.H{
			"name":       m,
			"configured": isConfigured,
			// v3b: browser = 浏览器跳转登录(openid/oidc); hidden 仅用于
			// 客户端登录页隐藏本地入口(管理后台恒本地,不消费该标记)。
			"browser": m == "openid" || m == "oidc",
			"hidden":  m == "local" && hideLocal,
		})
	}
	c.JSON(http.StatusOK, gin.H{"methods": out})
}

// MaskSecret 是 webadmin 回传敏感字段时的占位符("***"):服务端遇此值保持现值。
const MaskSecret = "***"

func currentAdmin(c *gin.Context) *serverstore.User {
	v, _ := c.Get("admin_user")
	u, _ := v.(*serverstore.User)
	return u
}

func currentAdminUsername(c *gin.Context) string {
	if u := currentAdmin(c); u != nil {
		return u.Username
	}
	return "admin"
}

// ---- 部门管理(金字塔组织架构) ----

type deptReq struct {
	Name        string `json:"name"`
	ParentID    int64  `json:"parent_id"`
	LeaderID    int64  `json:"leader_id"`
	Description string `json:"description"`
	// BudgetMoney 部门月度金额预算(元,0024):nil = 不变,0 = 清除(不限),>0 = 预算。
	BudgetMoney *float64 `json:"budget_money"`
}

// listDepartments 返回部门树平铺(含主管/成员数/子部门数/授权引用数)。
func (a *AdminAPI) listDepartments(c *gin.Context) {
	list, err := serverstore.ListDepartments(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if list == nil {
		list = []serverstore.DepartmentInfo{}
	}
	c.JSON(http.StatusOK, gin.H{"departments": list})
}

func (a *AdminAPI) createDepartment(c *gin.Context) {
	var req deptReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称必填")
		return
	}
	// 预算负值先于创建校验,避免创建成功后再失败留下无预算部门
	if req.BudgetMoney != nil && *req.BudgetMoney < 0 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "budget_money 不能为负数")
		return
	}
	id, err := serverstore.CreateDepartment(a.DB, strings.TrimSpace(req.Name), req.ParentID, req.LeaderID, req.Description)
	if err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称已存在")
			return
		}
		if errors.Is(err, serverstore.ErrNotFound) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门或主管不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	// 消费 budget_money(审计 H4:创建对话框提交的预算此前被静默丢弃)
	if req.BudgetMoney != nil {
		if err := serverstore.SetDeptBudget(a.DB, id, *req.BudgetMoney); err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "保存预算失败")
			return
		}
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_create", req.Name)
	c.JSON(http.StatusCreated, gin.H{"department": gin.H{"id": id, "name": req.Name}}) // L6:创建返回 201
}

func (a *AdminAPI) updateDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法部门 ID")
		return
	}
	var req deptReq
	if err := c.ShouldBindJSON(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称必填")
		return
	}
	before, err := serverstore.GroupByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "部门不存在")
		return
	}
	if req.BudgetMoney != nil && *req.BudgetMoney < 0 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "budget_money 不能为负数")
		return
	}
	// 预算与部门更新同一事务(审计 M2):预算失败整体回滚,不留半更新状态
	if err := serverstore.UpdateDepartmentWithBudget(a.DB, id, strings.TrimSpace(req.Name), req.ParentID, req.LeaderID, req.Description, req.BudgetMoney); err != nil {
		if errors.Is(err, serverstore.ErrValidation) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门不能是自身或子部门,或预算非法")
			return
		}
		if errors.Is(err, serverstore.ErrDuplicate) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门名称已存在")
			return
		}
		if errors.Is(err, serverstore.ErrNotFound) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "上级部门或主管不存在")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	detail := fmt.Sprintf("%s→%s parent:%d→%d leader:%d→%d",
		before.Name, req.Name, before.ParentID, req.ParentID, before.LeaderID, req.LeaderID)
	if req.BudgetMoney != nil {
		detail += fmt.Sprintf(" budget:%.2f", *req.BudgetMoney)
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_update", detail)
	// L6:返回资源对象,与 createDepartment 响应结构一致
	c.JSON(http.StatusOK, gin.H{"department": gin.H{"id": id, "name": req.Name}})
}

// 错误码口径(审计 L2):URL 主资源不存在 → 404 NOT_FOUND;
// 依赖资源(上级/主管/部门归属目标)不存在 → 400 VALIDATION。
func (a *AdminAPI) deleteDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法部门 ID")
		return
	}
	before, err := serverstore.GroupByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "部门不存在")
		return
	}
	if err := serverstore.DeleteDepartment(a.DB, id); err != nil {
		if errors.Is(err, serverstore.ErrDepartmentInUse) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门仍有关联(成员/子部门/授权),请先转移或清理")
			return
		}
		// 保留部门(全员)删除:此前落入 INTERNAL 500(审计 L1),应返回 400 VALIDATION
		if errors.Is(err, serverstore.ErrValidation) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "保留部门不可删除")
			return
		}
		writeError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_delete", before.Name)
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// setUserDepartment 单部门归属(员工金字塔单选):替换用户全部组为指定部门。
func (a *AdminAPI) setUserDepartment(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, id)
	if err != nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	var req struct {
		GroupID int64 `json:"group_id"`
	}
	// 未知字段(如误传 department_id)必须报错,不能静默解析为默认值 ——
	// 否则 SyncUserGroups(nil) 会清空用户全部组归属(安全/健壮性)。
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误(仅接受 group_id 字段)")
		return
	}
	var names []string
	if req.GroupID > 0 {
		g, err := serverstore.GroupByID(a.DB, req.GroupID)
		if err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门不存在")
			return
		}
		names = []string{g.Name}
	}
	if err := serverstore.SyncUserGroups(a.DB, id, names); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_dept", u.Username+" → "+strings.Join(names, ","))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// testAuthConnection 测试认证提供方连通性(v3b §1.2, 不写配置):
//   - ldap: 用配置的 bind_dn/密码做一次 bind
//   - oidc/openid: 拉取 issuer 的 /.well-known/openid-configuration
//
// 返回逐项结果; 失败仅报告该方式, 不中断其他。
func (a *AdminAPI) testAuthConnection(c *gin.Context) {
	var req struct {
		Type string `json:"type"` // ldap | oidc | openid
		LDAP struct {
			ServerURL    string `json:"server_url"`
			BindDN       string `json:"bind_dn"`
			BindPassword string `json:"bind_password"`
			BaseDN       string `json:"base_dn"`
			UserFilter   string `json:"user_filter"`
			GroupFilter  string `json:"group_filter"`
			GroupAttr    string `json:"group_attr"`
		} `json:"ldap"`
		OIDC struct {
			Issuer string `json:"issuer"`
		} `json:"oidc"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	results := gin.H{}
	switch req.Type {
	case "ldap":
		// 密码留空/掩码时回读已保存的 bind_password(webadmin 的「测试连接」
		// 必须能用已保存的密码测试,否则每次保存后密码「丢失」无法再验证)。
		password := req.LDAP.BindPassword
		if password == "" || password == MaskSecret {
			if saved, ok, err := serverstore.GetSetting(a.DB, "ldap.bind_password"); err == nil && ok {
				password = saved
			}
		}
		prov := &LDAPProvider{
			ServerURL:    req.LDAP.ServerURL,
			BindDN:       req.LDAP.BindDN,
			BindPassword: password,
			BaseDN:       req.LDAP.BaseDN,
			UserFilter:   req.LDAP.UserFilter,
			GroupFilter:  req.LDAP.GroupFilter,
			GroupAttr:    req.LDAP.GroupAttr,
		}
		if err := prov.Configure(map[string]string{
			"server_url": req.LDAP.ServerURL, "bind_dn": req.LDAP.BindDN,
			"bind_password": password, "base_dn": req.LDAP.BaseDN,
			"user_filter": req.LDAP.UserFilter, "group_filter": req.LDAP.GroupFilter,
			"group_attr": req.LDAP.GroupAttr,
		}); err != nil {
			results["ok"] = false
			results["message"] = "配置不完整: " + err.Error()
			break
		}
		// 目录探测(bind + 用户/组统计 + 前 5 样例):替代只 bind 的旧测试。
		// ldapProbeDialHook 是测试注入点(生产 nil,走真实 LDAP 连接)。
		if ldapProbeDialHook != nil {
			prov.dial = ldapProbeDialHook
		}
		report, err := prov.ProbeDirectory()
		if err != nil {
			results["ok"] = false
			results["message"] = err.Error()
			break
		}
		results["ok"] = true
		results["message"] = "LDAP 连接成功"
		results["users"] = report.Users
		results["groups"] = report.Groups
		results["sample"] = report.Sample
	case "oidc", "openid":
		if req.OIDC.Issuer == "" {
			results["ok"] = false
			results["message"] = "缺少 Issuer"
			break
		}
		issuer := strings.TrimRight(req.OIDC.Issuer, "/")
		// §1.2 SSRF 防护(CodeQL 认可的 regexp barrier guard):
		// issuer 整体与白名单匹配: 仅 https://<host>/ 或 http://localhost/ 形态,
		// host 段仅允许字母数字./-: 的 URL 字符(不包含 @, 防 userinfo 注入)。
		if !issuerURLRe.MatchString(issuer) {
			results["ok"] = false
			results["message"] = "Issuer 必须是合法 https URL(或 http://localhost)"
			break
		}
		iu, err := url.Parse(issuer)
		if err != nil || iu.Hostname() == "" {
			results["ok"] = false
			results["message"] = "Issuer 格式错误"
			break
		}
		if iu.Scheme == "http" && iu.Hostname() != "localhost" && iu.Hostname() != "127.0.0.1" {
			results["ok"] = false
			results["message"] = "Issuer http 仅允许 localhost 回环"
			break
		}
		client := &http.Client{Timeout: 10 * time.Second}
		r, err := client.Get(iu.String() + "/.well-known/openid-configuration")
		if err != nil {
			results["ok"] = false
			results["message"] = "无法连接 Issuer: " + err.Error()
			break
		}
		defer r.Body.Close()
		if r.StatusCode != 200 {
			results["ok"] = false
			results["message"] = fmt.Sprintf("Issuer 返回 %d", r.StatusCode)
			break
		}
		results["ok"] = true
		results["message"] = req.Type + " discovery 正常"
	default:
		writeError(c, http.StatusBadRequest, "VALIDATION", "type 必须是 ldap|oidc|openid")
		return
	}
	c.JSON(http.StatusOK, results)
}
