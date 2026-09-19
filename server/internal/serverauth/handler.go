package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// CtxUserKey is the gin context key for the authenticated user.
const CtxUserKey = "auth_user"

// notifyUserSessionsRevoked 触发"该用户全部会话已失效"的回调（nil 安全）。
//
// 单独包一层是为了让**四个吊销点**（自助改密 / 管理员改密 / 降权禁用删除 / 重置 MFA）
// 走同一个调用形状 —— 漏接一个点就是一处静默的"旧会话还能用"，而它有四个地方可以漏。
func (a *API) notifyUserSessionsRevoked(userID int64) {
	if a != nil && a.OnUserSessionsRevoked != nil {
		a.OnUserSessionsRevoked(userID)
	}
}

// CtxTokenKey is the gin context key for the raw bearer token.
const CtxTokenKey = "auth_token"

// API holds auth handler dependencies.
//
// F2(审计 2026-09-11): providers/browsers/enabledProviders 必须能在
// webadmin 保存认证配置后**热替换**(此前只在启动时构建一次:启用 LDAP
// 不生效、禁用 LDAP 后仍可登录)。所有读写经 mu 保护。
type API struct {
	DB      *sql.DB
	limiter *loginLimiter
	// loginIPLimiter:登录/回调的单 IP 失败预算桶(P1-2/P1-3 审计 2026-09-13)。
	loginIPLimiter *loginLimiter
	// callbackLimiter:OIDC 回调专用 IP 桶(2026-09-08 P0-2)。
	callbackLimiter *loginLimiter

	mu               sync.RWMutex
	providers        map[string]PasswordProvider
	browsers         map[string]BrowserProvider
	enabledProviders map[string]bool

	// OnSessionRevoked / OnUserSessionsRevoked 是**会话键失效**的回调
	// （契约 §8.2 / R1-SRV-5，2026-09-19）。
	//
	// 为什么需要：客户端专属模型下没有应用会话行，AI 的在手令牌按
	// `(user_id, sessionKey)` 缓存在进程内存里（sessionKey = bearer 的 SHA-256
	// 前 16 字节 hex）。bearer 被吊销后，那些**仍然有效**的在手令牌必须在同一时刻
	// 一起丢掉 —— 否则"登出/改密/禁用"只挡住了新请求，旧会话手里的 AI 令牌还能用到
	// 自然到期（最长 limits.AITokenTTL）。
	//
	//   OnSessionRevoked(key)     —— 登出：知道确切的那一把 bearer ⇒ 精确吊销一个键；
	//   OnUserSessionsRevoked(id) —— 改密/降权/禁用/删除/重置 MFA：该用户的**全部**
	//                                bearer 被清空 ⇒ 按用户维度批量吊销。
	//
	// 装配期设置、运行期只读（与 providers 的"热替换"不同：这两个钩子指向装配期
	// 就已存在的对象，没有运行期变更的需求）。nil = 不回调（最小装配/测试）。
	OnSessionRevoked      func(sessionKey string)
	OnUserSessionsRevoked func(userID int64)
}

// SessionKey 返回一把 bearer 对应的**会话键**（契约 §8.2）。
//
// 定义冻结为 `SHA-256(bearer)` 的**前 16 字节 hex**（= TokenHash 的前 32 个字符）。
// 唯一实现：wasmapi 的 clientRequest 入口与这里的吊销回调必须得出同一个键，
// 否则"吊销"会吊销一个不存在的键（静默无效）。
func SessionKey(rawToken string) string {
	h := serverstore.TokenHash(rawToken)
	const n = 32
	if len(h) < n {
		return h
	}
	return h[:n]
}

// New creates the auth API.
func New(db *sql.DB) *API {
	return &API{
		DB:               db,
		limiter:          sharedLoginLimiter(),
		loginIPLimiter:   sharedLoginIPLimiter(),
		callbackLimiter:  newCallbackLimiter(),
		providers:        map[string]PasswordProvider{},
		browsers:         map[string]BrowserProvider{},
		enabledProviders: map[string]bool{},
	}
}

// SetEnabledProviders records the client-facing provider set (auth.enabled).
func (a *API) SetEnabledProviders(names []string) {
	set := make(map[string]bool, len(names))
	for _, name := range names {
		set[name] = true
	}
	a.mu.Lock()
	a.enabledProviders = set
	a.mu.Unlock()
}

// ReloadProviders 用当前 settings 重建全部 provider/浏览器方式(F2)。
// 管理端保存认证配置后调用;GetAllSettings 失败时**保留旧集合**(不能把
// 一次 DB 抖动变成"所有登录方式消失")。
func (a *API) ReloadProviders(db *sql.DB) error {
	if _, err := serverstore.GetAllSettings(db); err != nil {
		return err
	}
	pwds, browsers := ConfigureProviders(db)
	providers := make(map[string]PasswordProvider, len(pwds))
	for _, p := range pwds {
		providers[p.Name()] = p
	}
	bs := make(map[string]BrowserProvider, len(browsers))
	for _, b := range browsers {
		bs[b.Name()] = b
	}
	enabled := make(map[string]bool)
	for _, n := range EnabledProviderNames(db) {
		enabled[n] = true
	}
	a.mu.Lock()
	a.providers = providers
	a.browsers = bs
	a.enabledProviders = enabled
	a.mu.Unlock()
	return nil
}

// clientPasswordOrder returns the provider names the CLIENT surface may use.
// auth.enabled is authoritative (2026-09-08 P1-5): the local provider stays
// registered for the admin surface, but a deployment that enables ldap/oidc
// only must not accept local passwords on the employee surface. An empty set
// (API built without ConfigureProviders, e.g. unit tests) keeps the legacy
// order so existing behaviour is preserved.
func (a *API) clientPasswordOrder() []string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	if len(a.enabledProviders) == 0 {
		return []string{"ldap", "local"}
	}
	order := make([]string, 0, 2)
	if a.enabledProviders["ldap"] {
		order = append(order, "ldap")
	}
	if a.enabledProviders["local"] {
		order = append(order, "local")
	}
	return order
}

// RegisterProvider adds a password provider (local/ldap).
func (a *API) RegisterProvider(p PasswordProvider) {
	a.mu.Lock()
	if a.providers == nil {
		a.providers = map[string]PasswordProvider{}
	}
	a.providers[p.Name()] = p
	a.mu.Unlock()
}

// RegisterOIDC adds a browser provider (legacy name, kept for compat).
func (a *API) RegisterOIDC(p BrowserProvider) { a.RegisterBrowser(p) }

// RegisterBrowser adds a browser provider by its Name (oidc/openid).
func (a *API) RegisterBrowser(p BrowserProvider) {
	a.mu.Lock()
	if a.browsers == nil {
		a.browsers = map[string]BrowserProvider{}
	}
	a.browsers[p.Name()] = p
	a.mu.Unlock()
}

// browserProvider 返回指定名称的浏览器登录 provider(nil = 未配置)。
func (a *API) browserProvider(name string) BrowserProvider {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.browsers[name]
}

// passwordProvider 返回已注册的密码 provider(仅用于内部读取)。
func (a *API) passwordProvider(name string) PasswordProvider {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.providers[name]
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
	if errors.Is(err, errPasswordVerifyBusy) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录请求过于频繁,请稍后再试")
		return
	}
	if err != nil {
		// 2026-09-08 P1-3:只有失败尝试才计入限流预算(此前成功也计数,
		// 正常用户第 11 次登录会被 429)。
		a.loginFailed(c, req.Username)
		// v3b 审计: 登录失败留痕(合规要求; 含来源 IP)。
		_ = serverstore.AuditLog(a.DB, req.Username, "login_fail", "ip="+c.ClientIP())
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "用户名或密码错误")
		return
	}
	// 认证成功即清空该账号的失败预算。
	a.loginSucceeded(c, req.Username)

	user, err := a.provisionUser(ui)
	if errors.Is(err, serverstore.ErrIdentityConflict) {
		// P2-9:同名但 IdP 主体不同 —— 明确的认证失败(不泄露对方身份细节),
		// 由管理员人工核对,绝不静默复用他人账号行。
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "该用户名已绑定到其它身份源账号,请联系管理员")
		return
	}
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "用户创建失败")
		return
	}
	if user.Status != 1 {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "账号已禁用")
		return
	}
	// v3b: 审计账号禁止使用客户端——员工面登录一律拒绝(审计员仅可经
	// /api/server/admin/login cookie 会话进 webadmin 只读工作台)。服务端强制,
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
	matched, ok := verifyPasswordGated(u.PasswordHash, req.OldPassword)
	if !ok {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁,请稍后再试")
		return
	}
	if !matched {
		writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "原密码错误")
		return
	}
	if same, ok := verifyPasswordGated(u.PasswordHash, req.NewPassword); !ok {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "请求过于频繁,请稍后再试")
		return
	} else if same {
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
	// 改密会吊销该用户**全部** api_tokens（serverstore.UpdateUserPassword 内 DELETE）
	// ⇒ 每个派生会话键都失效，按用户维度回调（契约 §8.2）。
	a.notifyUserSessionsRevoked(u.ID)
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
	if a.DB == nil {
		return nil
	}
	// F2: 以**当前 settings** 为准(禁用后即使注册表里还有旧实例也不得
	// 再登录),启用且未注册时按需构建并注册(兼容不走 ReloadProviders
	// 的调用方;GetAllSettings 有 30s TTL + 写失效,不会造成热路径压力)。
	settings, err := serverstore.GetAllSettings(a.DB)
	if err != nil {
		return nil
	}
	if !ldapEnabled(settings) {
		return nil
	}
	if p := a.passwordProvider("ldap"); p != nil {
		return p
	}
	// 不缓存:每次按当前 settings 构建(配置被清空/写坏时立即返回 nil,
	// 不会像缓存实例那样沿用旧配置)。对象本身很轻,真正的连接在
	// Authenticate 时才建立。
	return ldapFromSettings(settings)
}

// resolvePasswordProvider returns the configured password provider.
func (a *API) resolvePasswordProvider() PasswordProvider {
	if p := a.passwordProvider("local"); p != nil {
		return p
	}
	if p := a.ldapProvider(); p != nil {
		return p
	}
	return nil
}

// authenticate tries providers in the order the client surface is allowed to
// use (auth.enabled; ldap first in "both" mode, then local).
// LDAP provider 每次登录实时构建(见 ldapProvider)——配置热生效。
func (a *API) authenticate(username, password string) (UserInfo, error) {
	order := a.clientPasswordOrder()
	var lastErr error
	for _, name := range order {
		var p PasswordProvider
		if name == "ldap" {
			p = a.ldapProvider()
		} else {
			p = a.passwordProvider(name)
		}
		if p == nil {
			continue
		}
		// P1-2:本地 argon2id 校验(64MiB/次)过并发闸;LDAP bind 不在闸内
		// (它不吃内存,且大所早高峰的并发 bind 不应被本闸误伤成 429)。
		ui, err := func() (UserInfo, error) {
			if name != "local" {
				return p.Authenticate(username, password)
			}
			release, ok := acquirePasswordVerify()
			if !ok {
				return UserInfo{}, errPasswordVerifyBusy
			}
			defer release()
			return p.Authenticate(username, password)
		}()
		if err == nil {
			return ui, nil
		}
		lastErr = err
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
			Username:       ui.Username,
			DisplayName:    ui.DisplayName,
			Email:          ui.Email,
			Source:         ui.Source,
			Status:         1,
			ExternalID:     ui.ExternalID,
			ExternalSource: ui.ExternalSource,
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
	// P2-9(审计 2026-09-13):外部身份必须绑定到 **IdP 主体**(OIDC sub /
	// LDAP DN),而不是只按用户名 —— 否则两套 IdP 之间(或允许自选用户名的
	// IdP 内)同名身份会互相接管本地行(余额/授权/归属/用量历史)。
	//   1. 行未绑定(external_id='')⇒ 首次登录认领(存量行平滑迁移);
	//   2. 已绑定且与本次主体一致 ⇒ 正常登录;
	//   3. 已绑定但与本次主体不一致 ⇒ 拒绝(绝不静默改写别人的绑定)。
	if ui.Source == "external" && ui.ExternalID != "" {
		if err := serverstore.BindExternalIdentity(db, u.ID, ui.ExternalID, ui.ExternalSource); err != nil {
			return nil, err // ErrIdentityConflict → 上层映射 401
		}
	}
	// 同步组:仅当本次认证**确实拿到了组声明**(LDAP 恒真:目录是组的权威源,
	// 空组即回收;OIDC 只在 IdP 下发了 groups claim 时同步 —— 缺失声明时清空
	// 会误删 LDAP 同步来的组,审计 2026-09-13 P2-9)。
	if ui.Source == "external" && ui.GroupsPresent {
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
		// 会话级吊销（契约 §8.2 / R1-SRV-5）：这把 bearer 的会话键下的在手 AI 令牌
		// 必须立刻失效 —— 只吊销 bearer 的话，旧会话手里的 AI 令牌还能用到自然到期。
		if a.OnSessionRevoked != nil {
			a.OnSessionRevoked(SessionKey(s))
		}
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

// handleUsageSummary 返回员工用量概览(客户端账户卡/统计展示)。
//
// 2026-09-11 收敛:员工侧的"额度"只剩**账户余额** —— 部门预算、token 配额、
// 金额配额全部下线(设计文档 docs/planning/2026-09-11-balance-quota-consolidation.md)。
// 因此这里不再返回 quota_*/remaining_* 这类"月上限"字段,只返回余额与用量统计。
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
	balanceSettings, _ := serverstore.GetBalanceSettings(a.DB)
	// 未开通余额账户(从未入账)时,客户端不展示余额行 —— 与网关闸门同判据
	// (未开通不拦),避免出现"显示 ¥0.00 但能正常调用"的矛盾界面。
	activated := !u.BalanceActivatedAt.IsZero()

	c.JSON(http.StatusOK, gin.H{
		"balance_money":     serverstore.QuantizeMoney(u.BalanceMoney),
		"balance_activated": activated,
		"balance_enabled":   balanceSettings.Enabled,
		"balance_monthly":   balanceSettings.MonthlyAmount,
		"balance_mode":      balanceSettings.MonthlyMode,
		"is_admin":          u.IsAdmin,
		"monthly_usage":     s.MonthlyUsage,
		"monthly_cost":      s.MonthlyCost,
		"today_usage":       s.TodayUsage,
		"today_cost":        s.TodayCost,
		"yesterday_usage":   s.YesterdayUsage,
		"yesterday_cost":    s.YesterdayCost,
		"total_usage":       s.TotalUsage,
		"total_cost":        s.TotalCost,
	})
}

func userJSON(u *serverstore.User) gin.H {
	return gin.H{
		"id":       u.ID,
		"username": u.Username,
		// 显示名/邮箱此前缺失:更新显示名后响应不含新值,webadmin 回显丢失
		// (管理页编辑后看不到生效结果)。补全字段与 users 表列一一对应。
		"display_name": u.DisplayName,
		"email":        u.Email,
		"is_admin":     u.IsAdmin,
		// RBAC (v3b): role + permissions for the current user's role.
		"role":        u.Role,
		"permissions": PermissionsOf(u.Role),
		"status":      u.Status,
		// 0061/0062 员工余额(元,存量,分位口径):webadmin 用户列表/详情的数据源。
		// 2026-09-11:quota_tokens/quota_money 已下线,不再下发。
		"balance_money":     serverstore.QuantizeMoney(u.BalanceMoney),
		"balance_activated": !u.BalanceActivatedAt.IsZero(),
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

// AuthenticatePassword 供 WASM 应用平台的员工浏览器登录页复用同一套 provider 链
// （local/LDAP，顺序与客户端面一致）。不新增任何行为：只是 authenticate 的导出包装
// —— `authenticate` 未导出，而应用平台的登录页在另一个包（internal/wasmapp/session），
// 必须能走到同一条链路，否则两处登录会出现"客户端能登、应用平台登不上"的口径分叉。
//
// 调用方职责（本函数**不做**，与 handleLogin 一致的部分由调用方补齐）：
//   - 账号可用性判定（status != 1 / RoleAuditor 拒绝）；
//   - 外部身份建号（provisionUser 未导出）——需要时由调用方给出 users 行 id，
//     或留 0 让 wasmapp/session 按用户名解析既有行。
func (a *API) AuthenticatePassword(username, password string) (UserInfo, error) {
	return a.authenticate(username, password)
}
