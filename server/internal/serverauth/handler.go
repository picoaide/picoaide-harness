package serverauth

import (
	"database/sql"
	"errors"
	"net/http"

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
	if len(h) > 7 && h[:7] == "Bearer " {
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
	u, err := serverstore.GetUserByUsername(a.DB, ui.Username)
	if errors.Is(err, serverstore.ErrNotFound) {
		id, err := serverstore.CreateUser(a.DB, &serverstore.User{
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
			u, err = serverstore.GetUserByUsername(a.DB, ui.Username)
			if err != nil {
				return nil, err
			}
		} else {
			u, err = serverstore.GetUserByID(a.DB, id)
			if err != nil {
				return nil, err
			}
		}
	}
	if err != nil && !errors.Is(err, serverstore.ErrNotFound) {
		return nil, err
	}
	// 防提权:外部身份不得接管本地账号行
	if ui.Source == "external" && u.Source != "external" {
		return nil, errors.New("username belongs to a local account")
	}
	// 同步组:外部(LDAP)身份每次登录全量对齐——组被移除或清空后,
	// user_groups 必须同步回收,否则 skill/mcp/kb 组授权永久生效
	if ui.Source == "external" {
		if err := serverstore.SyncUserGroups(a.DB, u.ID, ui.Groups); err != nil {
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

func userJSON(u *serverstore.User) gin.H {
	return gin.H{
		"id":       u.ID,
		"username": u.Username,
		"is_admin": u.IsAdmin,
		"status":   u.Status,
	}
}
