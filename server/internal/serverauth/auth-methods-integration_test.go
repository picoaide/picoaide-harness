package serverauth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestAllAuthMethodsEndToEnd:四种方式(local/ldap/openid/oidc)并存时的路由级
// 端到端验证——五类断言:
// 1. /api/admin/auth/methods 返回全部 4 种(local 恒在,其余按配置);
// 2. local 密码登录成功;
// 3. ldap 密码登录(经 LDAP provider);
// 4. oidc 浏览器流:login→fakeIdP→callback 深链 token+server+user;
// 5. openid 浏览器流(独立前缀 /api/auth/openid/*)。
func TestAllAuthMethodsEndToEnd(t *testing.T) {
	gin.SetMode(gin.TestMode)
	idp := newFakeIDP(t)

	// 注册两个 browser provider:oidc + openid(共用一个 fakeIdP)
	oidc := newOIDCProvider(t, idp)
	oidc.name = "oidc"
	openid := newOIDCProvider(t, idp)
	openid.name = "openid"

	// LDAP 假连接
	ldapFake := defaultFake()
	ldap := newLDAPProvider(t, ldapFake, nil)

	db := mustDB(t)
	// 本地用户(不与 ldap bob / oidc alice 冲突——provisionUser 拒绝外部
	// 身份采用已存在的 local 账号,这是安全边界,测试各方式用户独立)
	if _, err := createUserDB(db, "local-user", "pw123456", false); err != nil {
		t.Fatal(err)
	}
	// 写 auth.enabled(4 方式)+ openid/oidc 配置,让 methods 端点返回 4 个
	for key, value := range map[string]string{
		"auth.enabled":        "local,ldap,openid,oidc",
		"openid.issuer":       idp.srv.URL,
		"openid.client_id":    "openid-client",
		"openid.redirect_url": "http://localhost/api/auth/openid/callback",
		"oidc.issuer":         idp.srv.URL,
		"oidc.client_id":      "oidc-client",
		"oidc.redirect_url":   "http://localhost/api/auth/oidc/callback",
		"ldap.server_url":     "ldap://fake",
		"ldap.bind_dn":        "cn=svc,ou=system,dc=example",
		"ldap.bind_password":  "svcpass",
		"ldap.base_dn":        "ou=people,dc=example",
	} {
		if err := serverstore.SetSetting(db, key, value); err != nil {
			t.Fatal(err)
		}
	}

	api := New(db)
	api.RegisterProvider(NewLocalProvider(db)) // local 恒注册
	api.RegisterProvider(ldap)                  // ldap
	api.RegisterOIDC(oidc)                      // oidc
	api.RegisterOIDC(openid)                    // openid
	r := gin.New()
	api.RegisterRoutes(r)
	RegisterAdminRoutes(r, db) // /api/admin/auth/methods(公开无认证)

	// ---------- 1. methods ----------
	methods := getMethods(t, r)
	if len(methods) != 4 {
		t.Fatalf("methods = %v, want 4 (local/ldap/openid/oidc)", methods)
	}
	names := map[string]bool{}
	for _, m := range methods {
		names[m.Name] = true
	}
	for _, want := range []string{"local", "ldap", "openid", "oidc"} {
		if !names[want] {
			t.Fatalf("methods missing %s: %v", want, methods)
		}
	}
	// local 恒 configured
	for _, m := range methods {
		if m.Name == "local" && !m.Configured {
			t.Fatal("local should always be configured")
		}
	}

	// ---------- 2. local 密码登录 ----------
	tok := postLogin(t, r, "local-user", "pw123456")
	if tok == "" {
		t.Fatal("local login failed")
	}

	// ---------- 3. ldap 密码登录(独立用户 bob,不与 local 冲突) ----------
	// provisionUser 拒绝外部身份采用已存在的 local 账号(安全边界):
	// ldap 用户必须以不同 username 首次登录建立新行。
	if ui, err := ldap.Authenticate("bob", "pw"); err != nil {
		t.Fatalf("ldap provider direct failed: %v", err)
	} else if ui.Username != "bob" {
		t.Fatalf("ldap username = %q", ui.Username)
	}
	// fake 连接的用户 DN 固定为 alice;为 bob 登录注入对应 userDN。
	ldapFake.userDN = "uid=bob,ou=people,dc=example"
	ldapFake.passwords["uid=bob,ou=people,dc=example"] = "pw"
	tok = postLogin(t, r, "bob", "pw")
	if tok == "" {
		t.Fatal("ldap login failed")
	}

	// ---------- 4. oidc 浏览器流 ----------
	tok = browserLoginFlow(t, r, idp, "oidc", api)
	if tok == "" {
		t.Fatal("oidc login failed")
	}

	// ---------- 5. openid 浏览器流(独立前缀) ----------
	tok = browserLoginFlow(t, r, idp, "openid", api)
	if tok == "" {
		t.Fatal("openid login failed")
	}
}

// getMethods 请求公开 methods 端点(admin 路由组)。
func getMethods(t *testing.T, r http.Handler) []struct {
	Name       string `json:"name"`
	Configured bool   `json:"configured"`
} {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/api/admin/auth/methods", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("methods status = %d body=%s", w.Code, w.Body.String())
	}
	var out struct {
		Methods []struct {
			Name       string `json:"name"`
			Configured bool   `json:"configured"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Methods
}

// postLogin 发起密码登录,返回 token(空串表示失败)。
func postLogin(t *testing.T, r http.Handler, username, password string) string {
	t.Helper()
	w := httptest.NewRecorder()
	body := `{"username":"` + username + `","password":"` + password + `"}`
	req := httptest.NewRequest("POST", "/api/auth/login", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		return ""
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return out.Token
}

// browserLoginFlow 走一遍 OIDC/OpenID 登录:login→fakeIdP→callback。
func browserLoginFlow(t *testing.T, r http.Handler, idp *fakeIDP, name string, api *API) string {
	t.Helper()
	// login(带 server 参数)
	w := httptest.NewRecorder()
	loginPath := "/api/auth/" + name + "/login?server=https%3A%2F%2Fgw.example.com"
	r.ServeHTTP(w, httptest.NewRequest("GET", loginPath, nil))
	if w.Code != http.StatusFound {
		t.Fatalf("%s login status = %d body=%s", name, w.Code, w.Body.String())
	}
	authURL := w.Header().Get("Location")
	state := urlParse(t, authURL).Query().Get("state")
	stateCookie := ""
	for _, c := range w.Result().Cookies() {
		if c.Name == "picoaide_oidc_state_"+name {
			stateCookie = c.Value
		}
	}
	if stateCookie == "" {
		t.Fatalf("%s: missing state cookie", name)
	}
	code := authorize(t, idp, authURL)
	w = httptest.NewRecorder()
	cb := "/api/auth/" + name + "/callback?code=" + url.QueryEscape(code) + "&state=" + url.QueryEscape(state)
	req := httptest.NewRequest("GET", cb, nil)
	req.AddCookie(&http.Cookie{Name: "picoaide_oidc_state_" + name, Value: stateCookie})
	r.ServeHTTP(w, req)
	if w.Code != http.StatusFound {
		t.Fatalf("%s callback status = %d body=%s", name, w.Code, w.Body.String())
	}
	loc := w.Header().Get("Location")
	if !strings.HasPrefix(loc, "picoaide://auth?token=") {
		t.Fatalf("%s deep link = %q", name, loc)
	}
	dlink := urlParse(t, strings.Replace(loc, "picoaide://auth", "https://auth.example", 1))
	tok := dlink.Query().Get("token")
	if tok == "" {
		t.Fatalf("%s deep link lacks token: %s", name, loc)
	}
	if got := dlink.Query().Get("server"); got != "https://gw.example.com" {
		t.Fatalf("%s deep link server = %q, want gw.example.com", name, got)
	}
	if got := dlink.Query().Get("user"); got != "alice" {
		t.Fatalf("%s deep link user = %q, want alice", name, got)
	}
	return tok
}
