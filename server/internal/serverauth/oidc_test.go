package serverauth

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// fakeIDP is an in-process OIDC identity provider: discovery, JWKS,
// authorize (issues single-use codes bound to PKCE challenge + nonce) and
// token (validates PKCE, returns a signed id_token with the nonce).
type fakeIDP struct {
	srv        *httptest.Server
	key        *rsa.PrivateKey
	kid        string
	codes      map[string]authReq
	tokenDelay time.Duration
}

type authReq struct {
	challenge string
	nonce     string
}

func newFakeIDP(t *testing.T) *fakeIDP {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIDP{key: key, kid: "test-key", codes: map[string]authReq{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeIDP) handle(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		json.NewEncoder(w).Encode(map[string]any{
			"issuer":                                f.srv.URL,
			"authorization_endpoint":                f.srv.URL + "/authorize",
			"token_endpoint":                        f.srv.URL + "/token",
			"jwks_uri":                              f.srv.URL + "/keys",
			"response_types_supported":              []string{"code"},
			"subject_types_supported":               []string{"public"},
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/keys":
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"keys":[{` +
			`"kty":"RSA","use":"sig","alg":"RS256","kid":"` + f.kid + `",` +
			`"n":"` + b64url(f.key.N.Bytes()) + `",` +
			`"e":"` + b64url([]byte{0x01, 0x00, 0x01}) + `"}]}`))
	case "/authorize":
		q := r.URL.Query()
		code, err := randomHex(8)
		if err != nil {
			http.Error(w, "rand error", http.StatusInternalServerError)
			return
		}
		f.codes[code] = authReq{challenge: q.Get("code_challenge"), nonce: q.Get("nonce")}
		redir := q.Get("redirect_uri")
		sep := "?"
		if strings.Contains(redir, "?") {
			sep = "&"
		}
		http.Redirect(w, r, redir+sep+"code="+url.QueryEscape(code)+"&state="+url.QueryEscape(q.Get("state")), http.StatusFound)
	case "/token":
		if f.tokenDelay > 0 {
			time.Sleep(f.tokenDelay)
		}
		if err := r.ParseForm(); err != nil {
			http.Error(w, "bad form", http.StatusBadRequest)
			return
		}
		req, ok := f.codes[r.Form.Get("code")]
		if !ok {
			http.Error(w, "bad code", http.StatusBadRequest)
			return
		}
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		got := base64.RawURLEncoding.EncodeToString(sum[:])
		if subtle.ConstantTimeCompare([]byte(got), []byte(req.challenge)) != 1 {
			http.Error(w, "pkce mismatch", http.StatusBadRequest)
			return
		}
		delete(f.codes, r.Form.Get("code"))
		now := time.Now()
		idt, err := f.signJWT(map[string]any{
			"iss": f.srv.URL, "sub": "user-1", "aud": "test-client",
			"exp": now.Add(time.Hour).Unix(), "iat": now.Unix(),
			"nonce":              req.nonce,
			"preferred_username": "alice",
			"email":              "alice@example.com",
			"name":               "Alice Smith",
			"groups":             []string{"admins", "devs"},
		})
		if err != nil {
			http.Error(w, "sign error", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at", "token_type": "Bearer", "expires_in": 3600, "id_token": idt,
		})
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeIDP) signJWT(claims map[string]any) (string, error) {
	header := `{"alg":"RS256","typ":"JWT","kid":"` + f.kid + `"}`
	h := b64url([]byte(header))
	payload, err := json.Marshal(claims)
	if err != nil {
		return "", err
	}
	p := b64url(payload)
	sum := sha256.Sum256([]byte(h + "." + p))
	sig, err := rsa.SignPKCS1v15(rand.Reader, f.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return h + "." + p + "." + b64url(sig), nil
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// authorize simulates the user completing the flow at the IdP: it performs
// the GET on the authorize URL and returns the issued code.
func authorize(t *testing.T, idp *fakeIDP, authURL string) string {
	t.Helper()
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	resp, err := client.Get(authURL)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("authorize status = %d", resp.StatusCode)
	}
	loc, err := url.Parse(resp.Header.Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := loc.Query().Get("code")
	if code == "" {
		t.Fatalf("no code in %s", resp.Header.Get("Location"))
	}
	return code
}

func urlParse(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

const testRedirectURI = "http://localhost/api/auth/oidc/callback"

func newOIDCProvider(t *testing.T, idp *fakeIDP) *OIDCProvider {
	t.Helper()
	p := &OIDCProvider{}
	if err := p.Configure(map[string]string{
		"issuer":        idp.srv.URL,
		"client_id":     "test-client",
		"client_secret": "secret",
		"redirect_url":  testRedirectURI,
	}); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestOIDCConfigure(t *testing.T) {
	if err := (&OIDCProvider{}).Configure(map[string]string{}); err == nil {
		t.Fatal("expected error with missing config")
	}
	idp := newFakeIDP(t)
	p := &OIDCProvider{}
	if err := p.Configure(map[string]string{
		"issuer": idp.srv.URL, "client_id": "c", "redirect_url": "http://x/cb",
	}); err != nil {
		t.Fatalf("configure: %v", err)
	}
	if p.Name() != "oidc" {
		t.Fatalf("name = %q", p.Name())
	}
}

func TestOIDCAuthURL(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	u, err := p.AuthURL("state-1", "")
	if err != nil {
		t.Fatal(err)
	}
	q := urlParse(t, u).Query()
	if q.Get("state") != "state-1" {
		t.Fatalf("state = %q", q.Get("state"))
	}
	if q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("pkce missing: %q", q.Get("code_challenge"))
	}
	if q.Get("nonce") == "" {
		t.Fatal("nonce missing")
	}
}

func TestOIDCHandleCallbackSuccess(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	state := "s1"
	authURL, err := p.AuthURL(state, "")
	if err != nil {
		t.Fatal(err)
	}
	code := authorize(t, idp, authURL)
	ui, err := p.HandleCallback(code, state)
	if err != nil {
		t.Fatalf("callback: %v", err)
	}
	if ui.Username != "alice" || ui.Email != "alice@example.com" || ui.DisplayName != "Alice Smith" {
		t.Fatalf("ui = %+v", ui)
	}
	if len(ui.Groups) != 2 || ui.Groups[0] != "admins" || ui.Groups[1] != "devs" {
		t.Fatalf("groups = %v", ui.Groups)
	}
}

func TestOIDCHandleCallbackWrongCode(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	state := "s2"
	authURL, err := p.AuthURL(state, "")
	if err != nil {
		t.Fatal(err)
	}
	code := authorize(t, idp, authURL)
	if _, err := p.HandleCallback(code, "wrong-state"); err == nil {
		t.Fatal("expected error on unknown state")
	}
	if _, err := p.HandleCallback("bogus-code", state); err == nil {
		t.Fatal("expected error on wrong code")
	}
	// code is single-use: replay must fail
	if _, err := p.HandleCallback(code, state); err == nil {
		t.Fatal("expected error on code replay")
	}
}

func TestOIDCHandleCallbackNonceMismatch(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	state := "s3"
	authURL, err := p.AuthURL(state, "")
	if err != nil {
		t.Fatal(err)
	}
	u := urlParse(t, authURL)
	q := u.Query()
	q.Set("nonce", "tampered")
	u.RawQuery = q.Encode()
	code := authorize(t, idp, u.String())
	if _, err := p.HandleCallback(code, state); err == nil {
		t.Fatal("expected nonce mismatch error")
	}
}

func TestOIDCRoutes(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	// login -> 302 to IdP with state + pkce
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/oidc/login", nil))
	if w.Code != http.StatusFound {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	authURL := w.Header().Get("Location")
	stateCookie := w.Result().Cookies()
	var stateCookieVal string
	for _, c := range stateCookie {
		if c.Name == "picoaide_oidc_state_oidc" {
			stateCookieVal = c.Value
		}
	}
	if stateCookieVal == "" {
		t.Fatal("login response lacks oidc state cookie (login-CSRF binding)")
	}
	q := urlParse(t, authURL).Query()
	if q.Get("code_challenge") == "" {
		t.Fatal("no pkce challenge in login redirect")
	}
	state := q.Get("state")
	if state == "" {
		t.Fatal("no state in login redirect")
	}

	// bad state -> 400 VALIDATION
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/oidc/callback?code=x&state=nope", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad state status = %d body=%s", w.Code, w.Body.String())
	}
	// missing params -> 400
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/oidc/callback", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("missing params status = %d", w.Code)
	}

	// 无 state cookie 的回调(第三方发起的 login CSRF)→ 400
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET",
		"/api/auth/oidc/callback?code=x&state="+url.QueryEscape(state), nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("callback without state cookie = %d, want 400", w.Code)
	}

	// full flow -> 302 picoaide://auth?token=...
	code := authorize(t, idp, authURL)
	w = httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/auth/oidc/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	req.AddCookie(&http.Cookie{Name: "picoaide_oidc_state_oidc", Value: stateCookieVal})
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("callback status = %d body=%s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "picoaide://auth?token=") {
		t.Fatalf("redirect = %q", loc)
	}
	// 解析深链参数(2026-09):回调携带 token + server(发起方地址)+ user
	dlink := urlParse(t, strings.Replace(loc, "picoaide://auth", "https://auth.example", 1))
	token := dlink.Query().Get("token")
	u, err := VerifyToken(db, token)
	if err != nil {
		t.Fatalf("issued token invalid: %v", err)
	}
	if u.Username != "alice" {
		t.Fatalf("provisioned user = %q", u.Username)
	}
	groups, err := serverstore.UserGroups(db, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 2 || groups[0] != "admins" {
		t.Fatalf("groups = %v", groups)
	}
}

// TestOIDCStateSingleUse: state 单次使用(回调后失效)。
func TestOIDCStateSingleUse(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	authURL, err := p.AuthURL("s4", "")
	if err != nil {
		t.Fatal(err)
	}
	code := authorize(t, idp, authURL)
	if _, err := p.HandleCallback(code, "s4"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.HandleCallback("x", "s4"); !errors.Is(err, errOIDCState) {
		t.Fatalf("err = %v, want errOIDCState", err)
	}
}

// TestOIDCLoginServerParam: `?server=` 发起方地址被深链带回(桌面客户端
// 用它在回调后构造 session,不必再询问 server 地址)。
func TestOIDCLoginServerParam(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	// 带 server 参数发起 login
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/oidc/login?server=https%3A%2F%2Fserver.example.com", nil))
	if w.Code != http.StatusFound {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	authURL := w.Header().Get("Location")
	state := urlParse(t, authURL).Query().Get("state")
	stateCookie := ""
	for _, c := range w.Result().Cookies() {
		if c.Name == "picoaide_oidc_state_oidc" {
			stateCookie = c.Value
		}
	}
	if stateCookie == "" {
		t.Fatal("missing state cookie")
	}
	code := authorize(t, idp, authURL)
	w = httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/auth/oidc/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	req.AddCookie(&http.Cookie{Name: "picoaide_oidc_state_oidc", Value: stateCookie})
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("callback status = %d body=%s", w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	dlink := urlParse(t, strings.Replace(loc, "picoaide://auth", "https://auth.example", 1))
	if got := dlink.Query().Get("server"); got != "https://server.example.com" {
		t.Fatalf("deep link server = %q, want server.example.com", got)
	}
	if got := dlink.Query().Get("user"); got != "alice" {
		t.Fatalf("deep link user = %q, want alice", got)
	}
	// 非法 server 参数 → 400
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/auth/oidc/login?server=ftp%3A%2F%2Fbad.example.com", nil))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad server param = %d, want 400", w.Code)
	}
}

// C-14: the OIDC code exchange must be bounded; a hung IdP token endpoint
// cannot hold the callback goroutine forever.
func TestOIDCExchangeTimeout(t *testing.T) {
	idp := newFakeIDP(t)
	idp.tokenDelay = 5 * time.Second // /token never answers in time
	p := newOIDCProvider(t, idp)

	prev := oidcExchangeTimeout
	oidcExchangeTimeout = 200 * time.Millisecond
	defer func() { oidcExchangeTimeout = prev }()

	state := "s-timeout"
	authURL, err := p.AuthURL(state, "")
	if err != nil {
		t.Fatal(err)
	}
	code := authorize(t, idp, authURL)
	start := time.Now()
	if _, err := p.HandleCallback(code, state); err == nil {
		t.Fatal("expected error from timed-out code exchange")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("exchange took %v, want ~%v timeout", d, oidcExchangeTimeout)
	}
}
