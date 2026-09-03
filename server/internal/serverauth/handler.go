package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// CtxUserKey is the gin context key for the authenticated user.
const CtxUserKey = "auth_user"

// CtxTokenKey is the gin context key for the raw bearer token.
const CtxTokenKey = "auth_token"

// API holds auth handler dependencies.
type API struct {
	DB        *sql.DB
	limiter   *loginLimiter
	providers map[string]PasswordProvider
	browsers  map[string]BrowserProvider
}

// New creates the auth API.
func New(db *sql.DB) *API {
	return &API{
		DB:        db,
		limiter:   newLoginLimiter(),
		providers: map[string]PasswordProvider{},
		browsers:  map[string]BrowserProvider{},
	}
}

// RegisterProvider adds a password provider (local/ldap).
func (a *API) RegisterProvider(p PasswordProvider) {
	a.providers[p.Name()] = p
}

// RegisterOIDC adds a browser provider (legacy name, kept for compat).
func (a *API) RegisterOIDC(p BrowserProvider) {
	a.browsers[p.Name()] = p
}

// RegisterBrowser adds a browser provider by its Name (oidc/openid).
func (a *API) RegisterBrowser(p BrowserProvider) {
	a.browsers[p.Name()] = p
}

// WriteError writes the standard error envelope (contract §0.4.1).
func WriteError(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": msg}})
}

// writeError is a short alias used within this package.
func writeError(c *gin.Context, status int, code, msg string) { WriteError(c, status, code, msg) }

// BearerAuth authenticates the request via Authorization: Bearer <token>.
// 0057: 强制改密守卫 —— password_must_change 用户仅可调用改密/me/logout,
// 其余业务接口一律 403 PASSWORD_CHANGE_REQUIRED(客户端在完成改密前不得
// 使用任何业务能力, 防止绕过强制改密拦截直接使用)。
func BearerAuth(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		raw := bearerToken(c)
		if raw == "" {
			writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "缺少认证令牌")
			return
		}
		u, err := VerifyToken(db, raw)
		if err != nil {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "令牌无效或已过期")
			return
		}
		if u.PasswordMustChange && !passwordChangeAllowed(c.Request) {
			writeError(c, http.StatusForbidden, "PASSWORD_CHANGE_REQUIRED", "请先修改密码")
			return
		}
		c.Set(CtxUserKey, u)
		c.Set(CtxTokenKey, raw)
		c.Next()
	}
}

// passwordChangeAllowed 是强制改密态的白名单: 仅改密本身/查看自身信息/登出。
func passwordChangeAllowed(r *http.Request) bool {
	p := r.URL.Path
	if r.Method == http.MethodPost && p == "/api/client/v2/auth/password" {
		return true
	}
	if r.Method == http.MethodGet && p == "/api/client/v2/auth/me" {
		return true
	}
	if r.Method == http.MethodPost && p == "/api/client/v2/auth/logout" {
		return true
	}
	return false
}

func bearerToken(c *gin.Context) string {
	h := c.GetHeader("Authorization")
	// RFC 6750:scheme 大小写不敏感(审计2026-L5)
	if len(h) > 7 && strings.EqualFold(h[:7], "bearer ") {
		return h[7:]
	}
	return ""
}

// CurrentUser returns the authenticated user from context.
func CurrentUser(c *gin.Context) *serverstore.User {
	v, ok := c.Get(CtxUserKey)
	if !ok {
		return nil
	}
	u, _ := v.(*serverstore.User)
	return u
}

// RegisterRoutes mounts /api/client/v2/auth on the router (测试/自建路由辅助; 生产路由
// 由 internal/router 包集中声明)。
func (a *API) RegisterRoutes(r *gin.Engine) {
	base := "/api/client/v2/auth"
	g := r.Group(base)
	g.POST("/login", a.handleLogin)
	g.POST("/logout", BearerAuth(a.DB), a.handleLogout)
	g.GET("/me", BearerAuth(a.DB), a.handleMe)
	g.GET("/usage", BearerAuth(a.DB), a.handleUsageSummary)
	g.POST("/password", BearerAuth(a.DB), a.handleChangePassword)
	// 每套 browser provider(oidc/openid)独立路由前缀
	for _, p := range a.browsers {
		name := p.Name()
		g.GET("/"+name+"/login", a.handleOIDCLoginWith(p))
		g.GET("/"+name+"/callback", a.handleOIDCCallbackWith(p))
	}
}

func (a *API) handleLogin(c *gin.Context) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil || req.Username == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return
	}
	// P2: bound credential lengths — a multi-MB "username" would otherwise
	// reach the password provider (LDAP query / hash compare) as-is.
	if len(req.Username) > 128 || len(req.Password) > 1024 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "用户名或密码过长")
		return
	}
	if !a.loginAllowed(c, req.Username) {
		_ = serverstore.AuditLog(a.DB, req.Username, "login_fail", "rate_limited ip="+c.ClientIP())
		return
	}

	auth := a.resolvePasswordProvider()
	if auth == nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "认证服务未配置")
		return
	}
	ui, err := a.authenticate(req.Username, req.Password)
	if err != nil {
		// v3b 审计: 登录失败留痕(合规要求; 含来源 IP)。
		_ = serverstore.AuditLog(a.DB, req.Username, "login_fail", "ip="+c.ClientIP())
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "用户名或密码错误")
		return
	}

	user, err := a.provisionUser(ui)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "用户创建失败")
		return
	}
	if user.Status != 1 {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "账号已禁用")
		return
	}
	// v3b: 审计账号禁止使用客户端——员工面登录一律拒绝(审计员仅可经
	// /api/admin/login cookie 会话进 webadmin 只读工作台)。服务端强制,
	// 客户端即使收到 200 也不会被放行(无 token 可签发)。
	if user.Role == serverstore.RoleAuditor {
		writeError(c, http.StatusUnauthorized, "AUDITOR_NOT_ALLOWED", "审计账号不可登录客户端,请使用管理后台")
		return
	}
	token, err := IssueToken(a.DB, user.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
		return
	}
	// v3b 审计: 登录成功留痕。
	_ = serverstore.AuditLog(a.DB, user.Username, "login_success", "ip="+c.ClientIP())
	c.JSON(http.StatusOK, gin.H{
		"token": token, "user": userJSON(user),
		// 0057: 管理员重置密码后强制改密, 客户端须进入强制改密态。
		"must_change_password": user.PasswordMustChange,
	})
}

// handleChangePassword 员工自助改密(0057; 仅本地认证用户):
// 校验旧密码 → 更新密码(事务内吊销该用户全部 api_tokens 与 admin_sessions,
// 含当前 —— 改密后客户端必须重新登录) → 审计。
func (a *API) handleChangePassword(c *gin.Context) {
	u := CurrentUser(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
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
	if utf8.RuneCountInString(req.NewPassword) < serverstore.AuthMinPasswordLength(a.DB) {
		writeError(c, http.StatusBadRequest, "VALIDATION", fmt.Sprintf("密码至少 %d 位", serverstore.AuthMinPasswordLength(a.DB)))
		return
	}
	// 外部认证(LDAP/OIDC)用户的密码由企业 IdP 管理(与管理员重置同一口径)。
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
	_ = serverstore.AuditLog(a.DB, u.Username, "password_change", "self")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// ldapProvider returns the LDAP provider to use for this login attempt:
//  1. 显式注册的(测试通过 RegisterProvider 注入 fake);
//  2. 否则从 settings 实时构建(生产):LDAP 配置在 webadmin 保存后无需重启
//     即可生效——provider 此前在启动时构建一次,配置变更必须重启才能用
//     (用户 2026-09 报告"配置好了登录不能用"的根因之一)。
//     仅当 auth.enabled 含 ldap(或兼容 mode=ldap/both)时返回,绝不使
//     未启用的 LDAP 配置意外生效。
func (a *API) ldapProvider() PasswordProvider {
	if p, ok := a.providers["ldap"]; ok {
		return p
	}
	if a.DB == nil {
		return nil
	}
	settings, err := serverstore.GetAllSettings(a.DB)
	if err != nil {
		return nil
	}
	if !ldapEnabled(settings) {
		return nil
	}
	return ldapFromSettings(settings)
}

// resolvePasswordProvider returns the configured password provider.
func (a *API) resolvePasswordProvider() PasswordProvider {
	if p, ok := a.providers["local"]; ok {
		return p
	}
	if p := a.ldapProvider(); p != nil {
		return p
	}
	return nil
}

// authenticate tries providers in order (ldap first in "both" mode, then local).
// LDAP provider 每次登录实时构建(见 ldapProvider)——配置热生效。
func (a *API) authenticate(username, password string) (UserInfo, error) {
	order := []string{"ldap", "local"}
	var lastErr error
	for _, name := range order {
		var p PasswordProvider
		if name == "ldap" {
			p = a.ldapProvider()
		} else if p0, ok := a.providers[name]; ok {
			p = p0
		}
		if p != nil {
			ui, err := p.Authenticate(username, password)
			if err == nil {
				return ui, nil
			}
			lastErr = err
		}
	}
	if lastErr == nil {
		lastErr = errors.New("no provider")
	}
	return UserInfo{}, lastErr
}

// provisionUser creates a local users row for an external (ldap/oidc) identity
// on first login, and syncs group membership. An external identity whose
// username collides with an existing local account is rejected — it must never
// adopt the local row (which would inherit is_admin/status/credentials).
func (a *API) provisionUser(ui UserInfo) (*serverstore.User, error) {
	return provisionUser(a.DB, ui)
}

// provisionUser creates a local users row for an external (ldap/oidc) identity
// on first login, and syncs group membership. An external identity whose
// username collides with an existing local account is rejected — it must never
// adopt the local row (which would inherit is_admin/status/credentials).
func provisionUser(db *sql.DB, ui UserInfo) (*serverstore.User, error) {
	u, err := serverstore.GetUserByUsername(db, ui.Username)
	if errors.Is(err, serverstore.ErrNotFound) {
		id, err := serverstore.CreateUser(db, &serverstore.User{
			Username:    ui.Username,
			DisplayName: ui.DisplayName,
			Email:       ui.Email,
			Source:      ui.Source,
			Status:      1,
		})
		if err != nil {
			if !errors.Is(err, serverstore.ErrDuplicate) {
				return nil, err
			}
			// C-13: a concurrent first login inserted the row between our
			// lookup and INSERT; re-fetch it instead of failing with a 500.
			u, err = serverstore.GetUserByUsername(db, ui.Username)
			if err != nil {
				return nil, err
			}
		} else {
			u, err = serverstore.GetUserByID(db, id)
			if err != nil {
				return nil, err
			}
		}
	}
	if err != nil && !errors.Is(err, serverstore.ErrNotFound) {
		return nil, err
	}
	// 竞态兜底:行在 re-fetch 前被删,绝不空指针解引用(审计2026-L1)
	if u == nil {
		return nil, errors.New("user row disappeared during provisioning")
	}
	// 防提权:外部身份不得接管本地账号行
	if ui.Source == "external" && u.Source != "external" {
		return nil, errors.New("username belongs to a local account")
	}
	// 同步组:外部(LDAP)身份每次登录全量对齐——组被移除或清空后,
	// user_groups 必须同步回收,否则 skill 组授权永久生效
	if ui.Source == "external" {
		if err := serverstore.SyncUserGroups(db, u.ID, ui.Groups); err != nil {
			return nil, err
		}
	}
	return u, nil
}

func (a *API) handleLogout(c *gin.Context) {
	raw, _ := c.Get(CtxTokenKey)
	if s, ok := raw.(string); ok {
		_ = RevokeToken(a.DB, s)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (a *API) handleMe(c *gin.Context) {
	u := CurrentUser(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	c.JSON(http.StatusOK, gin.H{"user": userJSON(u)})
}

// handleUsageSummary 返回员工用量概览(客户端余额/统计展示):
// 有效配额(个人覆盖→全局默认)、剩余(配额-本月已用,0/不限→null)、
// 今日/昨日/本月/历史总 tokens 与费用、部门预算链、admin 豁免。
func (a *API) handleUsageSummary(c *gin.Context) {
	u := CurrentUser(c)
	if u == nil {
		writeError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
		return
	}
	s, err := serverstore.UserUsageSummary(a.DB, u.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败")
		return
	}
	// 有效配额(admin 恒 0 = 豁免/不限)
	quotaTokens, err := serverstore.EffectiveQuota(a.DB, u)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "配额查询失败")
		return
	}
	quotaMoney, err := serverstore.EffectiveMoneyQuota(a.DB, u)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "配额查询失败")
		return
	}
	// 剩余:配额-本月已用;0/不限 → null(前端显示「不限」)
	var remainingTokens any
	if quotaTokens > 0 {
		remainingTokens = quotaTokens - s.MonthlyUsage
	}
	var remainingMoney any
	if quotaMoney > 0 {
		remainingMoney = quotaMoney - s.MonthlyCost
	}
	// 部门预算链(归属部门+祖先,含预算与树费用)
	budgets, err := serverstore.EffectiveDeptBudget(a.DB, u.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "部门预算查询失败")
		return
	}
	deptBudgets := make([]gin.H, 0, len(budgets))
	for _, b := range budgets {
		used, err := serverstore.DeptMonthlyCost(a.DB, b.GroupID)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "部门预算查询失败")
			return
		}
		deptBudgets = append(deptBudgets, gin.H{"name": b.Name, "budget": b.Budget, "used": used})
	}
	c.JSON(http.StatusOK, gin.H{
		"is_admin":         u.IsAdmin,
		"quota_tokens":     quotaTokens,
		"quota_money":      quotaMoney,
		"monthly_usage":    s.MonthlyUsage,
		"monthly_cost":     s.MonthlyCost,
		"remaining_tokens": remainingTokens,
		"remaining_money":  remainingMoney,
		"today_usage":      s.TodayUsage,
		"today_cost":       s.TodayCost,
		"yesterday_usage":  s.YesterdayUsage,
		"yesterday_cost":   s.YesterdayCost,
		"total_usage":      s.TotalUsage,
		"total_cost":       s.TotalCost,
		"dept_budgets":     deptBudgets,
	})
}

func userJSON(u *serverstore.User) gin.H {
	var quota any
	if u.QuotaTokens != nil {
		quota = *u.QuotaTokens
	}
	var quotaMoney any
	if u.QuotaMoney != nil {
		quotaMoney = *u.QuotaMoney
	}
	return gin.H{
		"id":       u.ID,
		"username": u.Username,
		// 显示名/邮箱此前缺失:更新显示名后响应不含新值,webadmin 回显丢失
		// (管理页编辑后看不到生效结果)。补全字段与 users 表列一一对应。
		"display_name": u.DisplayName,
		"email":        u.Email,
		"is_admin":     u.IsAdmin,
		// RBAC (v3b): role + permissions for the current user's role.
		"role":         u.Role,
		"permissions":  PermissionsOf(u.Role),
		"status":       u.Status,
		"quota_tokens": quota,      // null = follow global default, 0 = unlimited, >0 = capped
		"quota_money":  quotaMoney, // null = follow global default, 0 = unlimited, >0 = capped (yuan)
		// 0057 密码/MFA: source 供客户端判断改密入口; password_changeable =
		// 本地认证且启用的账号; password_must_change = 下次登录强制改密;
		// mfa_enabled 供 webadmin 列表控制「重置 MFA」按钮。
		"source":               u.Source,
		"password_changeable":  u.Source == "local" && u.PasswordHash != "" && u.Status == 1,
		"password_must_change": u.PasswordMustChange,
		"password_changed_at":  u.PasswordChangedAt.Format(time.RFC3339),
		"mfa_enabled":          u.TotpEnabled,
	}
}
