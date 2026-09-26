package main

// R21C-02（审计 2026-09-26，P2）的判据：`main()` 里 7 行此前**零判据**的装配。
//
// ## 缺陷形态
//
// `main()` 不在任何用例的执行路径上（测试走 `buildRouter` / 各自装配），这 7 行
// 逐条删掉后 `go test ./cmd/server/` 全部 `exit=0`（审计实测）。后果最重的是
// `assembleAuthAPI(authCfg)` 那一行：删掉 ⇒ 启动期 `API.browsers` 恒空 ⇒
// `/api/client/v2/auth/{oidc,openid}/login|callback` 恒 404「该登录方式未配置或
// 已禁用」（全组织 SSO 不可用），且只有管理员进 webadmin 保存一次认证配置才恢复。
//
// ## 判据（两层）
//
//  1. **源码级（AST 可达性）**：7 行都必须落在 `main()` 的静态可达路径上 ——
//     用 `requireAssemblyOnMainPath`（R21C-04 的工具，`strings.Index` 挡不住
//     "整行包进 `if false { … }`"）。
//  2. **行为级（前两条，审计建议的优先级）**：直接调用与 `main()` 共用的装配接缝
//     （`assembleAuthAPI` / `wireAuthReload`，见 auth_assembly.go），断言真实后果：
//     - 注册了 provider ⇒ 走**生产路由树**请求 `/api/client/v2/auth/oidc/login`
//       不再是 404「该登录方式未配置或已禁用」（对照：不注册时必须是 404）；
//     - `ReloadAuth` 闭包重建的是**同一个** API 实例的 provider 集合
//       （先清空、再按新 settings 热启用 OIDC，全程不重启、不重新构造 API）。

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestStartupCallsRemainingAssemblyLines 是 C-02 那 7 行的源码级判据（AST 可达性）。
func TestStartupCallsRemainingAssemblyLines(t *testing.T) {
	for _, tc := range []struct{ call, why string }{
		{"serverauth.SetBuildVersion(version)",
			"/server-info 的版本号恒为空（管理端看不到自己跑的是哪个版本）"},
		{"clientrelease.PublicBaseResolver = func() string {",
			"门户/下载链接失去「管理员配置的对外地址」权威，回落请求头（反代后会拼出内网地址）"},
		{"serverstore.RunAndRecordAuditChainCheck(db)",
			"启动期审计链校验消失：/server-info 的 chain_* 首值缺失，篡改要等到周期调度器那一轮才可能被发现"},
		{"serverstore.RebuildUsageLedger(db, from, time.Now())",
			"停机期间的日/月账不再自动补算（账本缺口只能靠人工 CLI）"},
		{"seedDemoApps(wasmCtx, db, *dataDir)",
			"内置演示应用不再随启动播种（新部署看不到任何示例应用）"},
		{"assembleAuthAPI(authCfg)",
			"`a.browsers` 启动期恒空 ⇒ /api/client/v2/auth/{oidc,openid}/login|callback 恒 404" +
				"「该登录方式未配置或已禁用」（全组织 SSO 不可用），只有管理员保存一次认证配置才恢复"},
		{"wireAuthReload(adminAPI, auth)",
			"保存认证配置不再热重建 provider（admin.go 的 `if a.ReloadAuth != nil` 静默跳过）⇒" +
				"「启用 OIDC/LDAP 立即生效」要重启才成立"},
	} {
		requireAssemblyOnMainPath(t, tc.call, tc.why)
	}
}

// stubBrowserProvider 是行为级判据用的最小 BrowserProvider（不碰网络）。
type stubBrowserProvider struct{ name string }

func (s *stubBrowserProvider) Name() string { return s.name }
func (s *stubBrowserProvider) AuthURL(state, returnServer, clientIP string) (string, error) {
	return "https://idp.example/authorize?state=" + state, nil
}
func (s *stubBrowserProvider) HandleCallback(code, state string) (serverauth.UserInfo, error) {
	return serverauth.UserInfo{}, nil
}
func (s *stubBrowserProvider) Configure(map[string]string) error { return nil }

// TestAssembleAuthAPIRegistersBrowserRoutes 是 `assembleAuthAPI` 那一行的**行为级**判据：
// 注册过的浏览器登录方式必须真的出现在生产路由树上、不再是 404。
//
// 变异（必须变红）：把 `assembleAuthAPI` 的循环掏空（= 删掉 main() 里那一行的后果）
// ⇒ 第一条断言红（404「该登录方式未配置或已禁用」），而对照断言仍然绿。
func TestAssembleAuthAPIRegistersBrowserRoutes(t *testing.T) {
	db := requireRealDB(t)

	browserLoginStatus := func(t *testing.T, browsers []serverauth.BrowserProvider) (int, string) {
		t.Helper()
		api := assembleAuthAPI(&serverauth.ConfiguredAPI{API: serverauth.New(db), Browsers: browsers})
		deps := testProductionDeps(t, db)
		deps.Auth = api.Handlers()
		r := newEngine()
		installAPIMiddleware(r)
		registerProductionRoutes(r, deps) // 生产路由真源（与 main() 同一段装配）

		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/client/v2/auth/oidc/login", nil)
		r.ServeHTTP(w, req)
		return w.Code, w.Body.String()
	}

	// 对照：没有 browser provider ⇒ 动态解析拿到 nil ⇒ 404 + 明确文案。
	code, body := browserLoginStatus(t, nil)
	if code != http.StatusNotFound || !strings.Contains(body, "该登录方式未配置或已禁用") {
		t.Fatalf("对照不成立：未注册 provider 时 /auth/oidc/login = %d %s, want 404「该登录方式未配置或已禁用」"+
			"（对照不成立说明本用例测的不是这条路径）", code, body)
	}

	// 判据：装配接缝注册过 ⇒ 请求进入真实的 OIDC 登录流程（不是 404）。
	code, body = browserLoginStatus(t, []serverauth.BrowserProvider{&stubBrowserProvider{name: "oidc"}})
	if code == http.StatusNotFound || strings.Contains(body, "该登录方式未配置或已禁用") {
		t.Fatalf("注册过 provider 的 OIDC 登录仍然 404（%d %s）—— "+
			"说明 main() 的 assembleAuthAPI(authCfg) 那一行没起作用（删掉它就是这个后果：全组织 SSO 恒 404）",
			code, body)
	}
	if code != http.StatusFound && code != http.StatusOK {
		t.Fatalf("OIDC 登录入口 = %d %s, want 302（重定向到 IdP）或 200", code, body)
	}
}

// TestWireAuthReloadRebuildsProvidersOnTheSameAPI 是 `wireAuthReload` 那一行的
// **行为级**判据：接上的闭包必须重建**同一个** API 实例的 provider 集合。
//
// 变异（必须变红）：把 `wireAuthReload` 改成空实现（= 删掉 main() 里那一行的后果）
// ⇒ `admin.ReloadAuth == nil` 红；把闭包改成对另一个 API 实例调用
// `ReloadProviders` ⇒ 第二条红（本实例的 provider 集合没变）。
func TestWireAuthReloadRebuildsProvidersOnTheSameAPI(t *testing.T) {
	db := requireRealDB(t)
	api := serverauth.New(db)
	admin := &serverauth.AdminAPI{DB: db}
	wireAuthReload(admin, api)
	if admin.ReloadAuth == nil {
		t.Fatal("wireAuthReload 没有接上 ReloadAuth —— 保存认证配置不再热重建 provider（F2 承诺失效）")
	}

	// ① 先挂一个 provider：热重建必须把它**清掉**（settings 里没有任何 browser 方式）
	//    —— 这一条同时证明闭包作用在**本实例**上，而不是另一个 API。
	assembleAuthAPI(&serverauth.ConfiguredAPI{API: api, Browsers: []serverauth.BrowserProvider{&stubBrowserProvider{name: "oidc"}}})
	if !handlersHaveBrowser(api, "oidc") {
		t.Fatal("前置不成立：注册到 API 的 provider 没有出现在 Handlers() 里")
	}
	if err := admin.ReloadAuth(); err != nil {
		t.Fatalf("ReloadAuth（空配置）: %v", err)
	}
	if handlersHaveBrowser(api, "oidc") {
		t.Fatal("ReloadAuth 之后本实例仍有 oidc —— 闭包没有作用在路由树持有的那个 API 实例上")
	}

	// ② 写入启用 OIDC 的 settings（配一个本机假 IdP 供 discovery），再热重建：
	//    必须**无需重启**就出现该登录方式（"启用 OIDC 立即生效"）。
	idp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/.well-known/openid-configuration" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"issuer":"` + "http://" + r.Host + `",` +
			`"authorization_endpoint":"http://` + r.Host + `/authorize",` +
			`"token_endpoint":"http://` + r.Host + `/token",` +
			`"jwks_uri":"http://` + r.Host + `/keys",` +
			`"response_types_supported":["code"],"subject_types_supported":["public"],` +
			`"id_token_signing_alg_values_supported":["RS256"]}`))
	}))
	defer idp.Close()

	for k, v := range map[string]string{
		"auth.enabled":       "oidc",
		"oidc.issuer":        idp.URL,
		"oidc.client_id":     "test-client",
		"oidc.redirect_url":  "http://127.0.0.1/callback",
		"oidc.client_secret": "",
		"auth.oidc.saved_at": time.Now().UTC().Format(time.RFC3339),
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatalf("写设置 %s: %v", k, err)
		}
	}
	if err := admin.ReloadAuth(); err != nil {
		t.Fatalf("ReloadAuth（启用 oidc）: %v", err)
	}
	if !handlersHaveBrowser(api, "oidc") {
		t.Fatal("启用 OIDC 后热重建没有生效 —— 「保存认证配置立即生效（无需重启）」这条承诺失效" +
			"（等价于 main() 里 wireAuthReload(...) 那一行被删掉）")
	}
}

// handlersHaveBrowser 报告 API 当前认得的浏览器登录方式里是否有 name
// （`Handlers().OIDC` 是按 browsers 快照生成的公开读出口）。
func handlersHaveBrowser(api *serverauth.API, name string) bool {
	for _, rt := range api.Handlers().OIDC {
		if rt.Name == name {
			return true
		}
	}
	return false
}
