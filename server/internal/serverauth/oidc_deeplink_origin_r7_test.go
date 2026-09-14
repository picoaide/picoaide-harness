package serverauth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// srvcore-1(P0,审计 2026-09-13):OIDC 深链把**刚签发的真实 token** 交给 login
// 请求里 `?server=` 指定的任意 https 服务端。旧实现只校验 scheme,于是
//
//	GET https://<真实服务端>/api/client/v2/auth/oidc/login?server=https://attacker.example
//
// 在受害者完成真实 SSO 后 302 到
// `picoaide://auth?token=<真token>&server=https://attacker.example`,
// 客户端会把 token 发往攻击者(90 天有效,等同该员工全部员工面权限)。
//
// 回归判据:`?server=` 必须与本次 login 请求自身的来源一致(scheme+host),
// 不一致直接 400,连流程都不发起(不签发 token、不写 state)。
func TestOIDCLoginRejectsForeignReturnServer(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	req := httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://attacker.example"), nil)
	req.Host = "gw.example.com" // 受害者实际访问的是真实服务端
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("login with foreign server = %d body=%s, want 400(不得把真实 token 交给 ?server= 指定的其它服务端)",
			w.Code, w.Body.String())
	}
	// 400 必须是 JSON 信封(server/AGENTS.md §7.0),且不得下发 state cookie。
	if ct := w.Header().Get("Content-Type"); !strings.Contains(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json", ct)
	}
	for _, c := range w.Result().Cookies() {
		if strings.HasPrefix(c.Name, oidcStateCookieName) {
			t.Fatalf("被拒的 login 不得下发 state cookie(%s)", c.Name)
		}
	}
	if loc := w.Header().Get("Location"); strings.Contains(loc, "attacker.example") {
		t.Fatalf("被拒的 login 仍重定向到攻击者: %q", loc)
	}

	// 攻击者用大小写/默认端口/尾斜杠变体也不得绕过(scheme+host 归一后比对)。
	for _, variant := range []string{
		"https://ATTACKER.example",
		"https://attacker.example:443",
		"https://attacker.example/",
		"https://attacker.example/gateway",
	} {
		req = httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(variant), nil)
		req.Host = "gw.example.com"
		w = httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("variant %q = %d, want 400", variant, w.Code)
		}
	}
}

// 反代改写了 Host 的正常部署:显式声明的对外来源(PICOAI_PUBLIC_BASE_URL,
// 与门户下载地址同一口径)必须照旧放行 —— 修复不得把这类部署的 SSO 打断;
// 同时也证明"配置了对外来源"不等于"任意域名放行"。
func TestOIDCLoginAcceptsConfiguredPublicOrigin(t *testing.T) {
	t.Setenv(clientrelease.PublicBaseURLEnv, "https://public.example.com")
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	req := httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://public.example.com"), nil)
	req.Host = "internal-svc:8080" // 反代把 Host 改写成了内部地址
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("public origin login = %d body=%s, want 302", w.Code, w.Body.String())
	}

	req = httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://attacker.example"), nil)
	req.Host = "internal-svc:8080"
	w = httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("attacker server with configured origin = %d, want 400", w.Code)
	}
}

// 合法流量:客户端登录页(auth-gate)传的 `?server=` 就是用户填写并用来打开
// login 地址的那台服务端;在正常部署里它等于服务端配置声明的对外来源。此用例
// 钉住"不误伤":命中配置来源的书写变体(大小写/默认端口/尾斜杠)必须照旧走通,
// 并且深链里带回的就是调用方给的值。
//
// R7-F3-N3(复核 2026-09-13):本用例原先断言"请求 Host 与 ?server= 相同即放行",
// 而那正是新发现的硬化缺口(Host 是请求头,不是来源证明)。现在改为按服务端配置
// (PICOAI_PUBLIC_BASE_URL / OIDC redirect_url / PICOAI_TRUSTED_HOSTS)判定;
// Host 单独不足以放行的回归见 oidc_login_origin_r7b_test.go。
func TestOIDCLoginAcceptsConfiguredReturnServer(t *testing.T) {
	t.Setenv(clientrelease.PublicBaseURLEnv, "https://gw.example.com")
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)

	// 只发起 login:命中外对来源的变体都必须 302 到 IdP(而不是 400)。
	for _, variant := range []string{
		"https://gw.example.com",
		"https://GW.Example.com/",
		"https://gw.example.com:443",
	} {
		req := httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(variant), nil)
		// 反代可以把 Host 改写成内部地址:判定只看服务端配置,不看 Host。
		req.Host = "internal-svc:8080"
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusFound {
			t.Fatalf("configured server %q = %d body=%s, want 302", variant, w.Code, w.Body.String())
		}
	}

	// 完整流程:深链必须带回真实服务端(而非被丢弃)。
	req := httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://gw.example.com"), nil)
	req.Host = "internal-svc:8080"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("login = %d body=%s", w.Code, w.Body.String())
	}
	authURL := w.Header().Get("Location")
	state := urlParse(t, authURL).Query().Get("state")
	cookieVal := ""
	for _, c := range w.Result().Cookies() {
		if c.Name == oidcStateCookieName+"_oidc" {
			cookieVal = c.Value
		}
	}
	if cookieVal == "" {
		t.Fatal("missing state cookie")
	}
	code := authorize(t, idp, authURL)
	cb := httptest.NewRequest("GET",
		"/api/client/v2/auth/oidc/callback?code="+url.QueryEscape(code)+"&state="+url.QueryEscape(state), nil)
	cb.Host = "gw.example.com"
	cb.AddCookie(&http.Cookie{Name: oidcStateCookieName + "_oidc", Value: cookieVal})
	w = httptest.NewRecorder()
	r.ServeHTTP(w, cb)
	if w.Code != http.StatusFound {
		t.Fatalf("callback = %d body=%s", w.Code, w.Body.String())
	}
	dlink := urlParse(t, strings.Replace(w.Header().Get("Location"), "picoaide://auth", "https://auth.example", 1))
	if got := dlink.Query().Get("server"); got != "https://gw.example.com" {
		t.Fatalf("deep link server = %q, want https://gw.example.com", got)
	}
	if dlink.Query().Get("token") == "" {
		t.Fatal("deep link 缺少 token")
	}
}
