package serverauth

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
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
	oidc      BrowserProvider
}

// New creates the auth API.
func New(db *sql.DB) *API {
	return &API{
		DB:        db,
		limiter:   newLoginLimiter(),
		providers: map[string]PasswordProvider{},
	}
}

// RegisterProvider adds a password provider (local/ldap).
func (a *API) RegisterProvider(p PasswordProvider) {
	a.providers[p.Name()] = p
}

// RegisterOIDC adds the browser provider if configured.
func (a *API) RegisterOIDC(p BrowserProvider) {
	a.oidc = p
}

// WriteError writes the standard error envelope (contract §0.4.1).
func WriteError(c *gin.Context, status int, code, msg string) {
	c.AbortWithStatusJSON(status, gin.H{"error": gin.H{"code": code, "message": msg}})
}

// writeError is a short alias used within this package.
func writeError(c *gin.Context, status int, code, msg string) { WriteError(c, status, code, msg) }

// BearerAuth authenticates the request via Authorization: Bearer <token>.
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
		c.Set(CtxUserKey, u)
		c.Set(CtxTokenKey, raw)
		c.Next()
	}
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

// RegisterRoutes mounts /api/auth on the router.
func (a *API) RegisterRoutes(r *gin.Engine) {
	g := r.Group("/api/auth")
	g.POST("/login", a.handleLogin)
	g.POST("/logout", BearerAuth(a.DB), a.handleLogout)
	g.GET("/me", BearerAuth(a.DB), a.handleMe)
	g.GET("/usage", BearerAuth(a.DB), a.handleUsageSummary)
	if a.oidc != nil {
		g.GET("/oidc/login", a.handleOIDCLogin)
		g.GET("/oidc/callback", a.handleOIDCCallback)
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
	if !a.loginAllowed(c, req.Username) {
		return
	}

	auth := a.resolvePasswordProvider()
	if auth == nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "认证服务未配置")
		return
	}
	ui, err := a.authenticate(req.Username, req.Password)
	if err != nil {
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
	token, err := IssueToken(a.DB, user.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"token": token, "user": userJSON(user)})
}

// resolvePasswordProvider returns the configured password provider.
func (a *API) resolvePasswordProvider() PasswordProvider {
	if p, ok := a.providers["local"]; ok {
		return p
	}
	if p, ok := a.providers["ldap"]; ok {
		return p
	}
	return nil
}

// authenticate tries providers in order (ldap first in "both" mode, then local).
func (a *API) authenticate(username, password string) (UserInfo, error) {
	order := []string{"ldap", "local"}
	var lastErr error
	for _, name := range order {
		if p, ok := a.providers[name]; ok {
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
	// user_groups 必须同步回收,否则 skill/mcp/kb 组授权永久生效
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
		"id":           u.ID,
		"username":     u.Username,
		"is_admin":     u.IsAdmin,
		"status":       u.Status,
		"quota_tokens": quota,      // null = follow global default, 0 = unlimited, >0 = capped
		"quota_money":  quotaMoney, // null = follow global default, 0 = unlimited, >0 = capped (yuan)
	}
}
