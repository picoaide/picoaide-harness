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
	g.POST("/login/mfa", a.handleLoginMFA)
	g.GET("/auth/methods", a.getPublicAuthMethods)
	// 管理会话内(AdminAuth 已校验 role != user + CSRF)。
	authed := g.Group("", AdminAuth(db))
	AdminRoute(authed, "GET", "/me", "", a.handleMe)
	AdminRoute(authed, "POST", "/logout", "", a.handleLogout)
	// 0057 密码/MFA 自助管理: 属于「自己的安全设置」, 与 /me 同权限档
	// (任意管理角色可用; 服务端守卫 = 有效会话 + CSRF + 旧密码/动态码双验)。
	AdminRoute(authed, "POST", "/me/password", "", a.handleMePassword)
	AdminRoute(authed, "GET", "/me/mfa", "", a.getMyMFA)
	AdminRoute(authed, "POST", "/me/mfa/enable", "", a.enableMyMFA)
	AdminRoute(authed, "POST", "/me/mfa/verify", "", a.verifyMyMFA)
	AdminRoute(authed, "POST", "/me/mfa/disable", "", a.disableMyMFA)
	// 用户/角色/部门(RBAC 管理)。
	AdminRoute(authed, "GET", "/users", PermUserRead, a.listUsers)
	AdminRoute(authed, "POST", "/users", PermUserWrite, a.createUser)
	AdminRoute(authed, "PUT", "/users/:id", PermUserWrite, a.updateUser)
	AdminRoute(authed, "DELETE", "/users/:id", PermUserWrite, a.deleteUser)
	// 0057: 管理员重置他人 MFA(不能对自己; 关闭后吊销其全部会话)。
	AdminRoute(authed, "PUT", "/users/:id/mfa", PermUserWrite, a.resetUserMFA)
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
	// 用量中心(2026-09 重构):总览聚合 + 请求级明细(与 router 包镜像)。
	AdminRoute(authed, "GET", "/usage/overview", PermUsageRead, a.usageOverview)
	AdminRoute(authed, "GET", "/usage/requests", PermUsageRead, a.usageRequests)
	// 服务器信息面板(系统 + 数据库统计)
	AdminRoute(authed, "GET", "/server-info", PermServerInfoRead, a.handleServerInfo)
	// 敏感操作审计日志(用户/部门/技能/令牌等)
	AdminRoute(authed, "GET", "/audit", PermAuditRead, a.listAuditLogs)
	// 审计保留策略(G13):读 auditor 可;写仅 super_admin(与 router 包镜像)。
	AdminRoute(authed, "GET", "/audit/settings", PermAuditRead, a.getAuditSettings)
	AdminRoute(authed, "PUT", "/audit/settings", PermAuditRetention, a.putAuditSettings)
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
		// 0057 强制改密守卫: password_must_change 期间仅放行改密/me/logout,
		// 其余管理端点一律 403(完成改密前不得操作管理后台任何功能)。
		if u.PasswordMustChange && !adminPasswordChangeAllowed(c.Request) {
			writeError(c, http.StatusForbidden, "PASSWORD_CHANGE_REQUIRED", "请先修改密码")
			return
		}
		c.Next()
	}
}

// adminPasswordChangeAllowed 是管理面强制改密态白名单。
func adminPasswordChangeAllowed(r *http.Request) bool {
	p := r.URL.Path
	if r.Method == http.MethodPost && p == "/api/server/admin/me/password" {
		return true
	}
	if r.Method == http.MethodGet && p == "/api/server/admin/me" {
		return true
	}
	if r.Method == http.MethodPost && p == "/api/server/admin/logout" {
		return true
	}
	return false
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
	// 0057: MFA 已开启 → 不建会话, 签发 5 分钟一次性挑战, 前端进入两步登录。
	if u.TotpEnabled {
		ticket, err := createMFAChallenge(a.DB, u.ID, "login", "", mfaTicketTTL)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "挑战创建失败")
			return
		}
		_ = serverstore.AuditLog(a.DB, u.Username, "admin_mfa_login", "challenge issued")
		c.JSON(http.StatusOK, gin.H{"mfa_required": true, "mfa_ticket": ticket})
		return
	}
	a.issueAdminSession(c, u)
}

// handleLoginMFA 两步登录第二步: 校验一次性挑战 + 动态码/主密码, 通过后建
// 管理会话(与一步登录相同响应; 含 must_change_password 标记)。
func (a *AdminAPI) handleLoginMFA(c *gin.Context) {
	var req struct {
		MFATicket string `json:"mfa_ticket"`
		Code      string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.MFATicket == "" || req.Code == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	// 挑战校验(未过期/未消费/未超次); 任何失败消息一致, 不泄露状态。
	ch, err := getMFAChallenge(a.DB, req.MFATicket)
	if err != nil || ch.Kind != "login" || ch.Attempts >= mfaChallengeMaxFailed || time.Now().After(ch.ExpiresAt) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "验证请求已失效,请重新登录")
		return
	}
	u, err := serverstore.GetUserByID(a.DB, ch.UserID)
	if err != nil || u == nil || u.TotpEnabled != true || u.Status != 1 || !u.HasManagementAccess() {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "验证请求已失效,请重新登录")
		return
	}
	secret, err := decryptMFASecret(u.TotpSecret)
	if err != nil || !totpValid(secret, req.Code) {
		_ = bumpMFAChallengeAttempts(a.DB, req.MFATicket)
		_ = serverstore.AuditLog(a.DB, u.Username, "admin_mfa_login", "fail ip="+c.ClientIP())
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "动态码错误或已失效")
		return
	}
	// 消费先于建会话: 重放同一 ticket 必须在第一次就被拒绝。
	if err := consumeMFAChallenge(a.DB, req.MFATicket); err != nil {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "验证请求已失效,请重新登录")
		return
	}
	_ = serverstore.AuditLog(a.DB, u.Username, "admin_mfa_login", "success ip="+c.ClientIP())
	a.issueAdminSession(c, u)
}

// issueAdminSession 创建管理会话并下发 cookie(handleLogin / handleLoginMFA
// 共用; 响应带 CSRF token 与强制改密标记)。
func (a *AdminAPI) issueAdminSession(c *gin.Context, u *serverstore.User) {
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
	c.JSON(http.StatusOK, gin.H{
		"csrf_token": csrf,
		"user":       userJSON(u),
		// 0057: 管理员重置密码后强制改密, 前端必须进入强制改密拦截。
		"must_change_password": u.PasswordMustChange,
	})
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

// ---- 0057 管理员密码自改 + MFA 自助管理 ----

// handleMePassword 管理员修改自己的密码: 旧密码校验 → 更新(事务内吊销其
// 全部 api_tokens 与 admin_sessions, 含当前会话 —— 安全决策: 改密后全部
// 踢掉, webadmin 前端收到响应后强制登出)。
func (a *AdminAPI) handleMePassword(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	var req struct {
		OldPassword string `json:"old_password"`
		NewPassword string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	if len(req.OldPassword) > 1024 || len(req.NewPassword) > 1024 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "密码过长")
		return
	}
	minLength := serverstore.AuthMinPasswordLength(a.DB)
	if utf8.RuneCountInString(req.NewPassword) < minLength {
		writeError(c, http.StatusBadRequest, "VALIDATION", fmt.Sprintf("密码至少 %d 位", minLength))
		return
	}
	// 管理后台登录 local-only, 正常路径必为本地账号; 防御性一致处理。
	if u.Source != "local" || u.PasswordHash == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "外部认证用户的密码由企业 IdP 管理,不能在此修改")
		return
	}
	if !util.VerifyPassword(u.PasswordHash, req.OldPassword) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "原密码错误")
		return
	}
	if util.VerifyPassword(u.PasswordHash, req.NewPassword) {
		writeError(c, http.StatusBadRequest, "VALIDATION", "新密码不能与原密码相同")
		return
	}
	hash, err := util.HashPassword(req.NewPassword)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "密码处理失败")
		return
	}
	if err := serverstore.UpdateUserPassword(a.DB, u.ID, hash, false); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "修改密码失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, u.Username, "admin_password_change", "self")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// getMyMFA 返回当前管理员的 MFA 状态(静默, 不返回任何密钥/URL)。
func (a *AdminAPI) getMyMFA(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	c.JSON(http.StatusOK, gin.H{"enabled": u.TotpEnabled})
}

// enableMyMFA 开启 MFA 第一步: 主密码校验 → 生成 TOTP 密钥(密钥经响应
// 一次性下发, 服务端仅存密文于 60s 挑战) → 前端展示二维码/文本并等待
// 用户输入动态码完成 verifyMyMFA。
func (a *AdminAPI) enableMyMFA(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	var req struct {
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	if u.Source != "local" || u.PasswordHash == "" || !util.VerifyPassword(u.PasswordHash, req.Password) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "主密码错误")
		return
	}
	secret, otpauthURL, err := genTOTPSecret(u.Username)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "密钥生成失败")
		return
	}
	cipher, err := encryptMFASecret(secret)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "密钥处理失败")
		return
	}
	ticket, err := createMFAChallenge(a.DB, u.ID, "enable", cipher, mfaEnableTicketTTL)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "挑战创建失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"secret": secret, "otpauth_url": otpauthURL, "ticket": ticket})
}

// verifyMyMFA 开启 MFA 第二步: 校验用户输入的动态码 → 加密落库 + enabled=1
// → 吊销该管理员其他已登录会话(当前保留)。
func (a *AdminAPI) verifyMyMFA(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	var req struct {
		Ticket string `json:"ticket"`
		Code   string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Ticket == "" || req.Code == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	ch, err := getMFAChallenge(a.DB, req.Ticket)
	if err != nil || ch.Kind != "enable" || ch.Attempts >= mfaChallengeMaxFailed || time.Now().After(ch.ExpiresAt) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "验证请求已失效,请重新开启")
		return
	}
	secret, err := decryptMFASecret(ch.Secret)
	if err != nil || !totpValid(secret, req.Code) {
		_ = bumpMFAChallengeAttempts(a.DB, req.Ticket)
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "动态码错误")
		return
	}
	if err := consumeMFAChallenge(a.DB, req.Ticket); err != nil {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "验证请求已失效,请重新开启")
		return
	}
	if err := serverstore.SetUserMFA(a.DB, u.ID, ch.Secret, true); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	// 开启即排除旧会话(防绕过 MFA 的存量登录继续使用)。
	if sid, ok := c.Get("admin_session"); ok {
		if s, ok := sid.(string); ok {
			_, _ = a.DB.Exec("DELETE FROM admin_sessions WHERE user_id = ? AND id <> ?", u.ID, s)
		}
	}
	_ = serverstore.AuditLog(a.DB, u.Username, "admin_mfa_enable", "self")
	c.JSON(http.StatusOK, gin.H{"enabled": true})
}

// disableMyMFA 关闭 MFA: 主密码 + 当前动态码双验(决策 2026-09-04) →
// 清空密钥 → 吊销该管理员其他已登录会话(当前保留, 且其登录不再要求动态码)。
func (a *AdminAPI) disableMyMFA(c *gin.Context) {
	u := currentAdmin(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
		return
	}
	var req struct {
		Password string `json:"password"`
		Code     string `json:"code"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	if !u.TotpEnabled {
		writeError(c, http.StatusBadRequest, "VALIDATION", "MFA 未开启")
		return
	}
	if u.Source != "local" || u.PasswordHash == "" || !util.VerifyPassword(u.PasswordHash, req.Password) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "主密码错误")
		return
	}
	secret, err := decryptMFASecret(u.TotpSecret)
	if err != nil || !totpValid(secret, req.Code) {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "动态码错误")
		return
	}
	if err := serverstore.ClearUserMFA(a.DB, u.ID); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "关闭失败")
		return
	}
	if sid, ok := c.Get("admin_session"); ok {
		if s, ok := sid.(string); ok {
			_, _ = a.DB.Exec("DELETE FROM admin_sessions WHERE user_id = ? AND id <> ?", u.ID, s)
		}
	}
	_ = serverstore.AuditLog(a.DB, u.Username, "admin_mfa_disable", "self")
	c.JSON(http.StatusOK, gin.H{"enabled": false})
}

// resetUserMFA 其他管理员直接关闭目标的 MFA(兜底: 无恢复码方案, 决策
// 2026-09-04): 清空密钥 + 吊销其全部会话(api_tokens + admin_sessions)。
// 禁止对自己操作(自己走 disableMyMFA 双验流程)。
func (a *AdminAPI) resetUserMFA(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "非法用户 ID")
		return
	}
	me := currentAdmin(c)
	if me != nil && me.ID == id {
		writeError(c, http.StatusBadRequest, "VALIDATION", "不能重置自己的 MFA,请在「安全设置」中关闭")
		return
	}
	target, err := serverstore.GetUserByID(a.DB, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "用户不存在")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	if err := serverstore.ClearUserMFA(a.DB, id); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "重置失败")
		return
	}
	if err := serverstore.RevokeAllUserSessions(a.DB, id); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "会话吊销失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "admin_mfa_reset", target.Username)
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
	minLength := serverstore.AuthMinPasswordLength(a.DB)
	if utf8.RuneCountInString(req.Password) < minLength {
		writeError(c, http.StatusBadRequest, "VALIDATION", fmt.Sprintf("密码至少 %d 位", minLength))
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
	// 配额审计基线(2026-09 P1):变更后写 quota_change(旧值→新值)
	wasTokens := u.QuotaTokens
	wasMoney := u.QuotaMoney
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
		if utf8.RuneCountInString(*req.Password) < serverstore.AuthMinPasswordLength(a.DB) {
			writeError(c, http.StatusBadRequest, "VALIDATION", fmt.Sprintf("密码至少 %d 位", serverstore.AuthMinPasswordLength(a.DB)))
			return
		}
		hash, err := util.HashPassword(*req.Password)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "密码处理失败")
			return
		}
		u.PasswordHash = hash
		// 0057: 管理员重置密码 → 该用户下次登录强制改密(改密成功清除)。
		u.PasswordMustChange = true
		u.PasswordChangedAt = time.Now()
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
	// 配额变更审计(2026-09 P1):null=跟随全局默认,0=不限
	if !quotaPtrEq(wasTokens, u.QuotaTokens) || !quotaMoneyPtrEq(wasMoney, u.QuotaMoney) {
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "quota_change",
			fmt.Sprintf("%s: token %s→%s, money %s→%s",
				u.Username, quotaLabel(wasTokens), quotaLabel(u.QuotaTokens),
				quotaMoneyLabel(wasMoney), quotaMoneyLabel(u.QuotaMoney)))
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
	from, to, ok := usageDateRange(c)
	if !ok {
		return
	}
	group := c.DefaultQuery("group", "day")
	if group != "day" && group != "week" && group != "month" && group != "model" &&
		group != "user" && group != "dept" && group != "provider" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "group 必须是 day|week|month|model|user|dept|provider")
		return
	}
	var opts []serverstore.UsageAggregateOption
	if username := c.Query("username"); username != "" {
		opts = append(opts, serverstore.WithUsername(username))
	}
	if dept := c.Query("dept"); dept != "" {
		opts = append(opts, serverstore.WithDept(dept))
	}
	// group=provider 为展示层归并(usage 无 provider 列,按 models 表模型→
	// 渠道映射近似归并,见 serverstore/usage_provider.go):聚合底层仍按 model。
	aggGroup := group
	if group == "provider" {
		aggGroup = "model"
	}
	rows, err := serverstore.UsageAggregateWithLedger(a.DB, from, to, aggGroup, opts...)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	if group == "provider" && len(rows) > 0 {
		mp, err := serverstore.ModelProviderMap(a.DB)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
			return
		}
		rows = serverstore.RegroupByProvider(rows, mp)
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

// GetAuditSettings 返回审计保留策略(auditor 只读; 写仅 super_admin, PermAuditRetention)。
func (a *AdminAPI) getAuditSettings(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"retention_days": serverstore.AuditRetentionDays(a.DB)})
}

// PutAuditSettings 写审计保留策略(1~3650 天),立即按新策略清理旧日志并审计留痕。
func (a *AdminAPI) putAuditSettings(c *gin.Context) {
	var req struct {
		RetentionDays *int `json:"retention_days"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.RetentionDays == nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "retention_days 必填")
		return
	}
	if *req.RetentionDays < 1 || *req.RetentionDays > 3650 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "retention_days 必须在 1~3650 天之间")
		return
	}
	old := serverstore.AuditRetentionDays(a.DB)
	if err := serverstore.SetSetting(a.DB, serverstore.AuditRetentionSetting, strconv.Itoa(*req.RetentionDays)); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	// 立即生效:启动清理兜底周期执行,此处主动触发一次。
	if err := serverstore.PurgeOldAuditLogs(a.DB, time.Now().Add(-time.Duration(*req.RetentionDays)*24*time.Hour)); err != nil {
		// 清理失败不影响保存(启动清理兜底); 审计中不落错误。
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "audit_retention_change", fmt.Sprintf("%d→%d", old, *req.RetentionDays))
	c.JSON(http.StatusOK, gin.H{"retention_days": *req.RetentionDays})
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
		"mode":                s["auth.mode"],
		"enabled":             s["auth.enabled"],
		"hide_local":          s["auth.hide_local"] == "true",
		"min_password_length": serverstore.AuthMinPasswordLength(a.DB),
		"ldap": gin.H{
			"server_url":    s["ldap.server_url"],
			"bind_dn":       s["ldap.bind_dn"],
			"bind_password": mask(s["ldap.bind_password"]),
			"base_dn":       s["ldap.base_dn"],
			"user_filter":   s["ldap.user_filter"],
			"user_attr":     s["ldap.user_attr"],
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
		// MinPasswordLength 密码最小长度(G14, 8~64; 缺省不覆盖, 默认 10)。
		MinPasswordLength *int `json:"min_password_length"`
		LDAP              struct {
			ServerURL    string `json:"server_url"`
			BindDN       string `json:"bind_dn"`
			BindPassword string `json:"bind_password"`
			BaseDN       string `json:"base_dn"`
			UserFilter   string `json:"user_filter"`
			UserAttr     string `json:"user_attr"`
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
	_ = upsert("ldap.user_attr", strings.TrimSpace(req.LDAP.UserAttr))
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
	if req.MinPasswordLength != nil {
		if *req.MinPasswordLength < serverstore.MinPasswordLengthLower || *req.MinPasswordLength > serverstore.MinPasswordLengthUpper {
			writeError(c, http.StatusBadRequest, "VALIDATION",
				fmt.Sprintf("min_password_length 必须在 %d~%d 之间", serverstore.MinPasswordLengthLower, serverstore.MinPasswordLengthUpper))
			return
		}
		_ = upsert(serverstore.AuthMinPasswordLengthSetting, strconv.Itoa(*req.MinPasswordLength))
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
	if req.MinPasswordLength != nil {
		changed = append(changed, "auth.min_password_length")
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
	// 预算审计基线:须在更新前捕获(UpdateDepartmentWithBudget 事务内已写新值)
	oldBudget, _ := serverstore.GetDeptBudget(a.DB, id)
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
	// 部门预算独立审计(2026-09 P1):预算口径单列动作,便于审计检索
	if req.BudgetMoney != nil && *req.BudgetMoney != oldBudget {
		_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "dept_budget_change",
			fmt.Sprintf("%s: 预算 %s→%s", req.Name, deptBudgetLabel(oldBudget), deptBudgetLabel(*req.BudgetMoney)))
	}
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

// setUserDepartment 设置用户部门归属(支持多部门,2026-09):
// 替换用户全部组为指定的部门集合。请求体 {group_ids:[n1,n2,...]}(空数组=
// 清空);兼容旧 {group_id:n} 单部门请求(旧 webadmin 客户端)。
// 预算语义(EffectiveDeptBudget)自然支持多部门:全部所属部门+祖先链的
// 预算同时生效,任一超限即拦截(与 LDAP/OIDC 组同步一致)。
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
		GroupIDs []int64 `json:"group_ids"`
		GroupID  int64   `json:"group_id"` // 旧单部门请求兼容
	}
	// 未知字段(如误传 department_id)必须报错,不能静默解析为默认值 ——
	// 否则 SyncUserGroups(nil) 会清空用户全部组归属(安全/健壮性)。
	dec := json.NewDecoder(c.Request.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误(仅接受 group_ids 数组或 group_id)")
		return
	}
	// 解析:group_ids 优先;否则回退旧的 group_id(单部门)
	ids := req.GroupIDs
	if len(ids) == 0 && req.GroupID > 0 {
		ids = []int64{req.GroupID}
	}
	// 校验 + 去重 + 保序(防重复部门)
	var names []string
	seen := map[int64]bool{}
	for _, gid := range ids {
		if seen[gid] || gid <= 0 {
			continue
		}
		seen[gid] = true
		g, err := serverstore.GroupByID(a.DB, gid)
		if err != nil {
			writeError(c, http.StatusBadRequest, "VALIDATION", "部门不存在")
			return
		}
		names = append(names, g.Name)
	}
	if err := serverstore.SyncUserGroups(a.DB, id, names); err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	_ = serverstore.AuditLog(a.DB, currentAdminUsername(c), "user_dept", u.Username+" → ["+strings.Join(names, ",")+"]")
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
			UserAttr     string `json:"user_attr"`
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
			UserAttr:     req.LDAP.UserAttr,
			GroupFilter:  req.LDAP.GroupFilter,
			GroupAttr:    req.LDAP.GroupAttr,
		}
		if err := prov.Configure(map[string]string{
			"server_url": req.LDAP.ServerURL, "bind_dn": req.LDAP.BindDN,
			"bind_password": password, "base_dn": req.LDAP.BaseDN,
			"user_filter": req.LDAP.UserFilter, "user_attr": req.LDAP.UserAttr,
			"group_filter": req.LDAP.GroupFilter, "group_attr": req.LDAP.GroupAttr,
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

// ---------------------------------------------------------------------------
// 配额/预算审计辅助(2026-09 P1)
// ---------------------------------------------------------------------------

// quotaPtrEq 指针配额相等(nil = 跟随全局默认,0 = 不限)。
func quotaPtrEq(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// quotaLabel 配额可读标签:null=跟随默认,0=不限,其余原值。
func quotaLabel(v *int64) string {
	if v == nil {
		return "默认"
	}
	if *v == 0 {
		return "0(不限)"
	}
	return strconv.FormatInt(*v, 10)
}

// deptBudgetLabel 部门预算可读标签:unset=未配置(不限),0=清除,其余金额。
func deptBudgetLabel(v float64) string {
	if v <= 0 {
		return "unset"
	}
	return fmt.Sprintf("%.2f", v)
}

// quotaMoneyPtrEq 金额配额指针相等(nil = 跟随全局默认,0 = 不限)。
func quotaMoneyPtrEq(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// quotaMoneyLabel 金额配额可读标签。
func quotaMoneyLabel(v *float64) string {
	if v == nil {
		return "默认"
	}
	if *v == 0 {
		return "0(不限)"
	}
	return fmt.Sprintf("%.2f", *v)
}
