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

// R7-F3-N3(P2,复核 2026-09-13):`sameOriginAsLoginRequest` 的第一条分支把
// **客户端可伪造的 Host 头**当作来源证明(`hostPortKey(?server=) == hostPortKey(Host)`)。
//
// Host 是请求头而不是服务端配置:任何能决定"浏览器用哪个 Host 到达本服务端"的
// 入口(自有 vhost 的反代 `proxy_set_header Host $host`、共享 ingress、AI 网关、
// DNS 重绑定)都能同时把 `?server=` 设成同一个域名,于是第一轮修复宣称的
// "攻击者无法把任意域名塞进来"在这一支上不成立 —— 真实员工 token 仍会随深链
// 交给攻击者域名。回归判据:Host(可含 `X-Forwarded-*` 配合)本身不构成来源证明。
func TestOIDCLoginRejectsHostHeaderAloneAsOriginProof(t *testing.T) {
	idp := newFakeIDP(t)
	p := newOIDCProvider(t, idp)
	r := newOIDCLoginRouter(t, p)

	for _, tc := range []struct {
		name   string
		server string
		host   string
		xfp    string
	}{
		{"host-header-only", "https://attacker.example", "attacker.example", ""},
		{"host-header-with-port", "https://attacker.example:8443", "attacker.example:8443", ""},
		{"host-header-plus-forged-xfp", "https://attacker.example", "attacker.example", "https"},
	} {
		req := httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(tc.server), nil)
		req.Host = tc.host
		if tc.xfp != "" {
			req.Header.Set("X-Forwarded-Proto", tc.xfp)
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s: login = %d body=%s, want 400(Host 头不是来源证明,不得把真实 token 交给 ?server= 指定的其它服务端)",
				tc.name, w.Code, w.Body.String())
		}
		// 被拒的 login 不得下发 state cookie、也不得重定向到攻击者(连流程都不发起)。
		for _, c := range w.Result().Cookies() {
			if strings.HasPrefix(c.Name, oidcStateCookieName) {
				t.Fatalf("%s: 被拒的 login 下发了 state cookie(%s)", tc.name, c.Name)
			}
		}
		if loc := w.Header().Get("Location"); strings.Contains(loc, "attacker.example") {
			t.Fatalf("%s: 被拒的 login 仍重定向到攻击者: %q", tc.name, loc)
		}
	}
}

// 修复不得误伤合法流程:接受的来源必须是**服务端配置**里的对外来源 ——
// PICOAI_PUBLIC_BASE_URL(客户端下载地址的唯一权威)、OIDC redirect_url 的
// origin(IdP 把浏览器重定向回来的地址,必然是本服务的浏览器可达来源)、
// PICOAI_TRUSTED_HOSTS(多域名部署的显式补充清单)。
func TestOIDCLoginAcceptsServerConfiguredReturnOrigins(t *testing.T) {
	gin.SetMode(gin.TestMode)
	idp := newFakeIDP(t)

	t.Run("public_base_url", func(t *testing.T) {
		t.Setenv(clientrelease.PublicBaseURLEnv, "https://public.example.com")
		p := newOIDCProvider(t, idp)
		r := newOIDCLoginRouter(t, p)

		// 反代把 Host 改写成内部地址的正常部署:客户端传的还是对外域名。
		for _, variant := range []string{
			"https://public.example.com",
			"https://PUBLIC.example.com/",
			"https://public.example.com:443",
		} {
			req := httptest.NewRequest("GET",
				"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(variant), nil)
			req.Host = "internal-svc:8080"
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != http.StatusFound {
				t.Fatalf("configured origin %q = %d body=%s, want 302", variant, w.Code, w.Body.String())
			}
		}

		// 配置了对外来源 ≠ 任意域名放行(第一轮修好的那一半不得回退)。
		req := httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://other.example.com"), nil)
		req.Host = "internal-svc:8080"
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("foreign origin with configured base = %d, want 400", w.Code)
		}
	})

	t.Run("oidc_redirect_origin", func(t *testing.T) {
		// redirect_url 是服务端配置(webadmin 写入、IdP 注册),请求方改不了;
		// 它的 origin 就是本服务的浏览器可达来源,SSO 能走通就说明它真实可达。
		p := newOIDCProviderWithRedirect(t, idp,
			"https://sso.example.com/api/client/v2/auth/oidc/callback")
		r := newOIDCLoginRouter(t, p)

		req := httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://sso.example.com"), nil)
		req.Host = "10.0.0.7:8080" // 反代 Host:与 ?server= 无关
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusFound {
			t.Fatalf("redirect-url origin = %d body=%s, want 302", w.Code, w.Body.String())
		}

		// 同 host 不同端口不是同一个来源。
		req = httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://sso.example.com:8443"), nil)
		req.Host = "10.0.0.7:8080"
		w = httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("redirect-url origin with other port = %d, want 400", w.Code)
		}
	})

	t.Run("trusted_hosts_allowlist", func(t *testing.T) {
		// 多 vhost / 内外双域名部署:客户端填的地址既不是 Host 也不是
		// PICOAI_PUBLIC_BASE_URL(后者还要给客户端下载用,不能随便改),
		// 由运维在显式清单里声明。
		t.Setenv("PICOAI_TRUSTED_HOSTS", "internal.example.com, https://alt.example.com:8443")
		p := newOIDCProvider(t, idp)
		r := newOIDCLoginRouter(t, p)

		for _, origin := range []string{"https://internal.example.com", "https://alt.example.com:8443"} {
			req := httptest.NewRequest("GET",
				"/api/client/v2/auth/oidc/login?server="+url.QueryEscape(origin), nil)
			req.Host = "10.0.0.7:8080"
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != http.StatusFound {
				t.Fatalf("trusted host %q = %d body=%s, want 302", origin, w.Code, w.Body.String())
			}
		}

		req := httptest.NewRequest("GET",
			"/api/client/v2/auth/oidc/login?server="+url.QueryEscape("https://attacker.example"), nil)
		req.Host = "attacker.example" // 即便 Host 与 ?server= 一致,也不在清单里
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("unlisted host = %d, want 400", w.Code)
		}
	})
}

// newOIDCLoginRouter 建一个只注册 OIDC 登录路由的测试路由树。
func newOIDCLoginRouter(t *testing.T, p *OIDCProvider) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	api := New(db)
	api.RegisterOIDC(p)
	r := gin.New()
	api.RegisterRoutes(r)
	return r
}

// newOIDCProviderWithRedirect 用指定的 redirect_url 建 provider(测试部署来源配置)。
func newOIDCProviderWithRedirect(t *testing.T, idp *fakeIDP, redirect string) *OIDCProvider {
	t.Helper()
	p := &OIDCProvider{}
	if err := p.Configure(map[string]string{
		"issuer":        idp.srv.URL,
		"client_id":     "test-client",
		"client_secret": "secret",
		"redirect_url":  redirect,
	}); err != nil {
		t.Fatal(err)
	}
	return p
}
