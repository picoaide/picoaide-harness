package serverauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// errOIDCState is returned by HandleCallback for unknown or reused state.
var errOIDCState = errors.New("oidc: unknown state")

// oidcFlow holds the PKCE verifier and nonce bound to a state value.
// Stored in memory: flows are invalidated on restart (accepted per plan).
type oidcFlow struct {
	verifier  string
	nonce     string
	createdAt time.Time
	// returnServer:发起 login 的客户端填写的服务端地址(深链回跳用)。
	// 浏览器跳转完成后,桌面客户端深链需要知道 token 属于哪个服务端;
	// 为空 = 未指定(默认深链只带 token,由客户端用登录页 server 填充)。
	returnServer string
}

// oidcFlowTTL bounds how long a flow may sit before the callback arrives.
// oidcMaxFlows caps the in-memory map so unauthenticated /oidc/login spam
// cannot grow memory without bound.
const (
	oidcFlowTTL  = 10 * time.Minute
	oidcMaxFlows = 1000
)

// oidcExchangeTimeout bounds the IdP code exchange (C-14); a hung IdP token
// endpoint must not hold the callback goroutine forever. Test-injectable.
var oidcExchangeTimeout = 10 * time.Second

// OIDCProvider implements the authorization code + PKCE flow.
// Config keys: issuer, client_id, client_secret, redirect_url.
// name 用于区分两套独立 IdP 配置("oidc" / "openid"),决定路由前缀。
type OIDCProvider struct {
	cfg      oauth2.Config
	verifier *oidc.IDTokenVerifier
	mu       sync.Mutex
	flows    map[string]*oidcFlow
	name     string
}

func (p *OIDCProvider) Name() string {
	if p.name != "" {
		return p.name
	}
	return "oidc"
}

func (p *OIDCProvider) Configure(cfg map[string]string) error {
	issuer := cfg["issuer"]
	clientID := cfg["client_id"]
	redirect := cfg["redirect_url"]
	if issuer == "" || clientID == "" || redirect == "" {
		return errors.New("oidc: issuer, client_id and redirect_url are required")
	}
	// discovery 必须限时:不可达/挂起的 IdP 不得阻塞服务启动(审计2026-M4);
	// 失败视为 OIDC 未配置(降级,不阻断启动)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	provider, err := oidc.NewProvider(ctx, issuer)
	if err != nil {
		return err
	}
	p.cfg = oauth2.Config{
		ClientID:     clientID,
		ClientSecret: cfg["client_secret"],
		RedirectURL:  redirect,
		Endpoint:     provider.Endpoint(),
		Scopes:       []string{oidc.ScopeOpenID, "profile", "email"},
	}
	p.verifier = provider.Verifier(&oidc.Config{ClientID: clientID})
	p.flows = map[string]*oidcFlow{}
	return nil
}

// AuthURL starts a flow for the given state and returns the authorization
// URL carrying state, PKCE S256 challenge and nonce. `returnServer` (from the
// login page's `?server=` param) is bound to the flow so the callback deep
// link can carry it back to the initiating desktop client.
func (p *OIDCProvider) AuthURL(state, returnServer string) (string, error) {
	if state == "" {
		return "", errors.New("oidc: empty state")
	}
	nonce, err := randomHex(16)
	if err != nil {
		return "", err
	}
	verifier := oauth2.GenerateVerifier()
	p.mu.Lock()
	p.sweepFlowsLocked(time.Now())
	if len(p.flows) >= oidcMaxFlows { // still full: evict the oldest flow
		var oldest string
		var oldestAt time.Time
		for s, f := range p.flows {
			if oldest == "" || f.createdAt.Before(oldestAt) {
				oldest, oldestAt = s, f.createdAt
			}
		}
		delete(p.flows, oldest)
	}
	p.flows[state] = &oidcFlow{verifier: verifier, nonce: nonce, createdAt: time.Now(), returnServer: returnServer}
	p.mu.Unlock()
	return p.cfg.AuthCodeURL(state,
		oauth2.S256ChallengeOption(verifier),
		oidc.Nonce(nonce)), nil
}

// sweepFlowsLocked removes expired flows; caller holds p.mu.
func (p *OIDCProvider) sweepFlowsLocked(now time.Time) {
	cutoff := now.Add(-oidcFlowTTL)
	for s, f := range p.flows {
		if f.createdAt.Before(cutoff) {
			delete(p.flows, s)
		}
	}
}

// HandleCallback exchanges the code (validating PKCE, state and nonce) and
// returns the identity from the ID token. Each state is single-use.
func (p *OIDCProvider) HandleCallback(code, state string) (UserInfo, error) {
	p.mu.Lock()
	flow, ok := p.flows[state]
	delete(p.flows, state)
	p.mu.Unlock()
	if !ok || code == "" {
		return UserInfo{}, errOIDCState
	}
	ctx, cancel := context.WithTimeout(context.Background(), oidcExchangeTimeout)
	defer cancel()
	tok, err := p.cfg.Exchange(ctx, code, oauth2.VerifierOption(flow.verifier))
	if err != nil {
		return UserInfo{}, err
	}
	raw, ok := tok.Extra("id_token").(string)
	if !ok {
		return UserInfo{}, errors.New("oidc: no id_token in token response")
	}
	idt, err := p.verifier.Verify(ctx, raw)
	if err != nil {
		return UserInfo{}, err
	}
	var claims struct {
		Sub               string   `json:"sub"`
		PreferredUsername string   `json:"preferred_username"`
		Email             string   `json:"email"`
		Name              string   `json:"name"`
		Nonce             string   `json:"nonce"`
		Groups            []string `json:"groups"`
	}
	if err := idt.Claims(&claims); err != nil {
		return UserInfo{}, err
	}
	if subtle.ConstantTimeCompare([]byte(flow.nonce), []byte(claims.Nonce)) != 1 {
		return UserInfo{}, errors.New("oidc: nonce mismatch")
	}
	username := claims.PreferredUsername
	if username == "" {
		username = claims.Email
	}
	if username == "" {
		username = claims.Sub
	}
	return UserInfo{
		Username:    username,
		DisplayName: claims.Name,
		Email:       claims.Email,
		Groups:      claims.Groups,
		Source:      "external",
	}, nil
}

// oidcStateCookieName binds the OIDC login flow to the initiating browser:
// the state is written into a SameSite=Lax cookie at /oidc/login and must be
// echoed by the /oidc/callback request (login CSRF 防护:第三方页面不能在受害者
// 浏览器里发起登录流程并把自己的身份塞给受害者)。
const oidcStateCookieName = "picoaide_oidc_state"

// handleOIDCLogin redirects the browser to the IdP authorization URL.
// 兼容保留:使用第一个/默认 browser provider(oidc)。
func (a *API) handleOIDCLogin(c *gin.Context) {
	p := a.browsers["oidc"]
	if p == nil {
		p = a.browsers["openid"]
	}
	if p == nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "OIDC 未配置")
		return
	}
	a.handleOIDCLoginWith(p)(c)
}

// handleOIDCLoginWith runs the login flow for a specific browser provider.
// `?server=<url>` records the initiating client's server address, carried in
// the callback deep link so the desktop client knows which server to attach.
func (a *API) handleOIDCLoginWith(p BrowserProvider) gin.HandlerFunc {
	return func(c *gin.Context) {
		state, err := randomHex(16)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "状态生成失败")
			return
		}
		returnServer := strings.TrimSpace(c.Query("server"))
		if returnServer != "" {
			// 校验:仅接受 https 或 http 回环(与客户端 assertServerURLAllowed 同规),
			// 防止不可信 server 被带进深链重定向。
			u, perr := url.Parse(returnServer)
			if perr != nil {
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 参数格式错误")
				return
			}
			loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]"
			if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 必须为 https(或 http 回环)")
				return
			}
		}
		authURL, err := p.AuthURL(state, returnServer)
		if err != nil {
			writeError(c, http.StatusBadGateway, "UPSTREAM", "OIDC 服务不可用")
			return
		}
		name := p.Name()
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     oidcStateCookieName + "_" + name,
			Value:    state,
			Path:     "/api/auth/" + name,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
			MaxAge:   int(oidcFlowTTL.Seconds()),
		})
		c.Redirect(http.StatusFound, authURL)
	}
}

// handleOIDCCallback exchanges the code and redirects the client deep link
// with a signed-in api token. 兼容保留:用默认/第一个 browser provider。
func (a *API) handleOIDCCallback(c *gin.Context) {
	p := a.browsers["oidc"]
	if p == nil {
		p = a.browsers["openid"]
	}
	if p == nil {
		writeError(c, http.StatusNotFound, "NOT_FOUND", "OIDC 未配置")
		return
	}
	a.handleOIDCCallbackWith(p)(c)
}

// handleOIDCCallbackWith runs the callback for a specific browser provider.
func (a *API) handleOIDCCallbackWith(p BrowserProvider) gin.HandlerFunc {
	return func(c *gin.Context) {
		code, state := c.Query("code"), c.Query("state")
		if code == "" || state == "" {
			writeError(c, http.StatusBadRequest, "VALIDATION", "缺少 code 或 state")
			return
		}
		name := p.Name()
		// login CSRF 绑定:回调必须回显 login 时签发的 state cookie
		stateCookie, err := c.Cookie(oidcStateCookieName + "_" + name)
		if err != nil || stateCookie == "" || subtle.ConstantTimeCompare([]byte(stateCookie), []byte(state)) != 1 {
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 与登录浏览器不匹配")
			return
		}
		// 消费 cookie:流程单次有效
		// cookie-secure 修复(审计 2026-08-30 CodeQL go/cookie-secure-not-set):
		// 删除指令的 cookie 须声明与写入时一致的 Secure/SameSite/Path,
		// 否则非 HTTPS 部署下浏览器不发送删除指令, state 残留可被重放。
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     oidcStateCookieName + "_" + name,
			Value:    "",
			Path:     "/api/auth/" + name,
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
		})
		// 先取出 returnServer(HandleCallback 会删除 state,state 单次使用)
		rs := returnServerOf(p, state)
		ui, err := p.HandleCallback(code, state)
		if errors.Is(err, errOIDCState) {
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 无效或已过期")
			return
		}
		if err != nil {
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "OIDC 认证失败")
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
		// v3b: 审计账号禁止使用客户端——SSO 回调同样拒绝签发员工 token。
		if user.Role == serverstore.RoleAuditor {
			writeError(c, http.StatusUnauthorized, "AUDITOR_NOT_ALLOWED", "审计账号不可登录客户端,请使用管理后台")
			return
		}
		token, err := IssueToken(a.DB, user.ID)
		if err != nil {
			writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
			return
		}
		// 桌面客户端深链:携带 token + 发起 server + username(客户端拿到
		// 后直接构造 session,无需再调 /api/auth/me)。server 为 login 时
		// 记录的 returnServer;为空时客户端用其登录页输入的 server 兜底。
		ret := fmt.Sprintf("picoaide://auth?token=%s", url.QueryEscape(token))
		if rs != "" {
			ret += fmt.Sprintf("&server=%s", url.QueryEscape(rs))
		}
		if ui.Username != "" {
			ret += fmt.Sprintf("&user=%s", url.QueryEscape(ui.Username))
		}
		c.Redirect(http.StatusFound, ret)
	}
}

// returnServerOf 从具体 provider 类型读取该 state 绑定的 returnServer;
// 非 OIDCProvider 实现(测试桩)返回空串。
func returnServerOf(p BrowserProvider, state string) string {
	if o, ok := p.(*OIDCProvider); ok {
		return o.ReturnServer(state)
	}
	return ""
}

// ReturnServer 返回该 state 绑定的发起方服务端地址(login 时 ?server= 记录)。
func (p *OIDCProvider) ReturnServer(state string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	f := p.flows[state]
	if f == nil {
		return ""
	}
	return f.returnServer
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
