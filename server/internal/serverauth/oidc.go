package serverauth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"

	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
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
		ClientSecret: decryptSettingSecret(cfg["client_secret"]),
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
			// 校验:格式 + scheme(仅 https 或 http 回环,与客户端
			// assertServerURLAllowed 同规)+ **命中服务端配置声明的对外来源**。
			// 深链里带的是刚签发的真实 token,`?server=` 决定客户端把 token
			// 发去哪台服务端;只校验 scheme 等于让任意 https 域名(攻击者域名)
			// 把员工 token 领走(P0,2026-09-13 srvcore-1)。合法客户端传的就是
			// 用户正在访问的这台服务端(auth-gate 登录页),而"用户正在访问的
			// 是哪台"只有服务端配置能证明 —— 请求 Host 不行(见
			// returnServerIsTrusted,R7-F3-N3)。
			u, perr := url.Parse(returnServer)
			if perr != nil || u.Host == "" {
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 参数格式错误")
				return
			}
			loopback := u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1" || u.Hostname() == "[::1]"
			if u.Scheme != "https" && !(u.Scheme == "http" && loopback) {
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 必须为 https(或 http 回环)")
				return
			}
			if !returnServerIsTrusted(p, u) {
				writeError(c, http.StatusBadRequest, "VALIDATION", "server 与本次登录的服务端不一致")
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
			Path:     "/api/client/v2/auth/" + name,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
			MaxAge:   int(oidcFlowTTL.Seconds()),
		})
		c.Redirect(http.StatusFound, authURL)
	}
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
			Path:     "/api/client/v2/auth/" + name,
			MaxAge:   -1,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureCookieFor(c, a.DB),
		})
		// v3b §2.6: OIDC 回调限流(按来源 IP; 防 IdP 妥协后暴力回调)。
		// 2026-09-08 P0-2:改用独立 IP 桶(不再占用全局 u:oidc-callback 登录桶,
		// 否则全组织 SSO 每 5 分钟只能登录 10 次),且只对失败回调计数。
		if !a.oidcCallbackAllowed(c) {
			_ = serverstore.AuditLog(a.DB, "oidc-callback", "login_fail", "rate_limited ip="+c.ClientIP())
			return
		}
		// 先取出 returnServer(HandleCallback 会删除 state,state 单次使用)
		rs := returnServerOf(p, state)
		ui, err := p.HandleCallback(code, state)
		if errors.Is(err, errOIDCState) {
			a.oidcCallbackFailed(c)
			writeError(c, http.StatusBadRequest, "VALIDATION", "state 无效或已过期")
			return
		}
		if err != nil {
			a.oidcCallbackFailed(c)
			// v3b 审计: OIDC 失败留痕。
			_ = serverstore.AuditLog(a.DB, "oidc", "login_fail", "ip="+c.ClientIP())
			writeError(c, http.StatusUnauthorized, "AUTH_FAILED", "OIDC 认证失败")
			return
		}
		a.oidcCallbackSucceeded(c)
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
		// v3b 审计: OIDC 成功留痕。
		_ = serverstore.AuditLog(a.DB, user.Username, "login_success", "oidc ip="+c.ClientIP())
		// 桌面客户端深链:携带 token + 发起 server + username(客户端拿到
		// 后直接构造 session,无需再调 /api/auth/me)。server 为 login 时
		// 记录的 returnServer;为空时客户端用其登录页输入的 server 兜底。
		// scheme 跟随渠道(见 channel.DeepLinkScheme):渠道构建用它自己的 scheme,
		// 浏览器跳回客户端时的确认框里不出现厂商名。三处必须一致 —— 客户端
		// protocols(打包)、客户端解析、以及这里。
		ret := fmt.Sprintf("%s://auth?token=%s", channel.DeepLinkScheme(), url.QueryEscape(token))
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

// TrustedReturnServerHostsEnv 是运维显式声明的**补充**对外来源清单(逗号分隔;
// 每项可为 `https://host[:port]` 或裸 `host[:port]`,裸主机按 https 解释)。
//
// 用途:多 vhost / 内外双域名部署 —— 客户端登录页填的地址既不是某次请求的 Host
// 依据,又不该占用 PICOAI_PUBLIC_BASE_URL(后者是客户端下载地址的唯一权威来源,
// 改它会影响下发)。请求方改不了这个环境变量,故它可以作为来源证明。
//
// 注意区分:这是 **OIDC 深链回跳地址** 的允许清单,与 `PICOAI_TRUSTED_PROXIES`
// (反代 IP,用于登录限流取真实客户端 IP)不是一回事;它也不是 HTTP Host 头的
// 允许清单 —— Host 头根本不参与来源判定(见 returnServerIsTrusted)。
const TrustedReturnServerHostsEnv = "PICOAI_TRUSTED_HOSTS"

// returnServerIsTrusted 判定 `?server=` 是否指向**服务端配置**声明的本服务对外
// 来源(scheme + host,默认端口/大小写/尾斜杠/子路径归一后比对)。
//
// 可信来源只有三类,都是请求方改不了的服务端配置:
//  1. OIDC `redirect_url` 的 origin —— IdP 把浏览器重定向回来的地址,SSO 能走通
//     就说明它是本服务的浏览器可达来源;
//  2. `PICOAI_PUBLIC_BASE_URL`(客户端下载地址的唯一权威,见 clientrelease);
//  3. `PICOAI_TRUSTED_HOSTS`(上面的显式补充清单)。
//
// R7-F3-N3(复核 2026-09-13):这里**刻意不看请求 Host**。Host 是请求头,不是
// 来源证明 —— 任何能决定"浏览器用哪个 Host 到达本服务端"的入口(自有 vhost 的
// 反代 `proxy_set_header Host $host`、共享 ingress、AI 网关、DNS 重绑定)都能同时
// 把 `?server=` 设成同一个域名,于是第一轮那句"攻击者无法把任意域名塞进来"对
// Host 侧并不成立:真实员工 token 仍会随深链交给攻击者域名。修法选择复核报告的
// 方案②("Host 必须命中服务端配置的允许清单")的更强形式:Host 完全不参与判定,
// 只用配置;未配置任何来源时 `?server=` 一律拒(不落回 Host 推断)。
func returnServerIsTrusted(p BrowserProvider, u *url.URL) bool {
	for _, origin := range returnServerTrustedOrigins(p) {
		if strings.EqualFold(u.Scheme, origin.Scheme) && hostPortKey(u) == hostPortKey(origin) {
			return true
		}
	}
	return false
}

// returnServerTrustedOrigins 汇总上面三类服务端配置来源(去重不做:数量个位数,
// 重复比对无副作用)。
func returnServerTrustedOrigins(p BrowserProvider) []*url.URL {
	var out []*url.URL
	add := func(raw string) {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			return
		}
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.Scheme == "" {
			return
		}
		out = append(out, &url.URL{Scheme: u.Scheme, Host: u.Host})
	}
	if o, ok := p.(*OIDCProvider); ok {
		add(o.cfg.RedirectURL)
	}
	add(os.Getenv(clientrelease.PublicBaseURLEnv))
	for _, entry := range strings.Split(os.Getenv(TrustedReturnServerHostsEnv), ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if !strings.Contains(entry, "://") {
			entry = "https://" + entry
		}
		add(entry)
	}
	return out
}

// hostPortKey 归一 authority:小写、去尾点、去默认端口(https:443 / http:80),
// IPv6 统一走 net.JoinHostPort(带方括号),使 `[::1]:8443` 与 `[::1]:8443`
// 这类书写差异不会造成误判。
func hostPortKey(u *url.URL) string {
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	port := u.Port()
	if (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80") {
		port = ""
	}
	if port == "" {
		return host
	}
	return net.JoinHostPort(host, port)
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
