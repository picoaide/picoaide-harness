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
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/gin-gonic/gin"
	"golang.org/x/oauth2"
)

// errOIDCState is returned by HandleCallback for unknown or reused state.
var errOIDCState = errors.New("oidc: unknown state")

// oidcFlow holds the PKCE verifier and nonce bound to a state value.
// Stored in memory: flows are invalidated on restart (accepted per plan).
type oidcFlow struct {
	verifier  string
	nonce     string
	createdAt time.Time
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
type OIDCProvider struct {
	cfg      oauth2.Config
	verifier *oidc.IDTokenVerifier
	mu       sync.Mutex
	flows    map[string]*oidcFlow
}

func (p *OIDCProvider) Name() string { return "oidc" }

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
// URL carrying state, PKCE S256 challenge and nonce.
func (p *OIDCProvider) AuthURL(state string) (string, error) {
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
	p.flows[state] = &oidcFlow{verifier: verifier, nonce: nonce, createdAt: time.Now()}
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
func (a *API) handleOIDCLogin(c *gin.Context) {
	state, err := randomHex(16)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "状态生成失败")
		return
	}
	authURL, err := a.oidc.AuthURL(state)
	if err != nil {
		writeError(c, http.StatusBadGateway, "UPSTREAM", "OIDC 服务不可用")
		return
	}
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     oidcStateCookieName,
		Value:    state,
		Path:     "/api/auth/oidc",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secureCookieFor(c, a.DB),
		MaxAge:   int(oidcFlowTTL.Seconds()),
	})
	c.Redirect(http.StatusFound, authURL)
}

// handleOIDCCallback exchanges the code and redirects the client deep link
// with a signed-in api token.
func (a *API) handleOIDCCallback(c *gin.Context) {
	code, state := c.Query("code"), c.Query("state")
	if code == "" || state == "" {
		writeError(c, http.StatusBadRequest, "VALIDATION", "缺少 code 或 state")
		return
	}
	// login CSRF 绑定:回调必须回显 login 时签发的 state cookie
	stateCookie, err := c.Cookie(oidcStateCookieName)
	if err != nil || stateCookie == "" || subtle.ConstantTimeCompare([]byte(stateCookie), []byte(state)) != 1 {
		writeError(c, http.StatusBadRequest, "VALIDATION", "state 与登录浏览器不匹配")
		return
	}
	// 消费 cookie:流程单次有效
	http.SetCookie(c.Writer, &http.Cookie{Name: oidcStateCookieName, Value: "", Path: "/api/auth/oidc", MaxAge: -1})
	ui, err := a.oidc.HandleCallback(code, state)
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
	token, err := IssueToken(a.DB, user.ID)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "令牌签发失败")
		return
	}
	c.Redirect(http.StatusFound, fmt.Sprintf("picoaide://auth?token=%s", url.QueryEscape(token)))
}

func randomHex(n int) (string, error) {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
