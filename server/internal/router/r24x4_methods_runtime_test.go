package router

// R24-X4-B2 的判据(泳道 FIX-23):**两条** `/auth/methods` 路由(客户端员工面
// 与管理端公开面)的 `configured` 必须来自**运行期 provider 注册表**,而不是
// "settings 里三件套齐全"。
//
// 缺陷形态(审计 temp/r24/X4-fresh/REPORT.md B2):保存认证配置时 IdP discovery
// 失败 ⇒ 运行期 provider 被摘除,而 methods 仍回 `configured:true`、登录页照常
// 渲染可点击的 SSO 按钮 ⇒ 点下去 404(hide_local=true 的部署里员工端只剩它)。
//
// 变异(必须变红):
//   - `publicMethodsHandler` 改成一律返回 `d.Admin.PublicMethods`(或
//     `publicAuthMethods` 删掉 available 分支、退回"只看 settings")⇒ 判据 1 红;
//   - `ReloadProviders` 不再摘除被显式禁用的方式(把"保留旧实例"扩大成
//     "永不摘除")⇒ 判据 3 红。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// methodsNames 取某条 methods 路由返回的方式清单。
func methodsNames(t *testing.T, r *gin.Engine, path string) []string {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, w.Code, w.Body.String())
	}
	var out struct {
		Methods []struct {
			Name string `json:"name"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析 %s: %v", path, err)
	}
	names := make([]string, 0, len(out.Methods))
	for _, m := range out.Methods {
		names = append(names, m.Name)
	}
	return names
}

// methodsConfigured 取某条 methods 路由对该方式的 configured 判定
// (该方式必须出现在清单里)。
func methodsConfigured(t *testing.T, r *gin.Engine, path, name string) bool {
	t.Helper()
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("GET %s = %d %s", path, w.Code, w.Body.String())
	}
	var out struct {
		Methods []struct {
			Name       string `json:"name"`
			Configured bool   `json:"configured"`
		} `json:"methods"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析 %s: %v", path, err)
	}
	for _, m := range out.Methods {
		if m.Name == name {
			return m.Configured
		}
	}
	t.Fatalf("%s 的 methods 里没有 %s:%s", path, name, w.Body.String())
	return false
}

// TestMethodsConfiguredFollowsRuntimeRegistry 断言:
//  1. settings 声称 oidc 配置齐全、而运行期注册表里**没有**它 ⇒ 两条路由都回
//     `configured:false`("设置里配好了"不等于此刻可用);
//  2. 同一刻把 provider 注册进运行期注册表 ⇒ 两条路由立刻回 `configured:true`
//     (与 `/auth/{oidc,openid}/login` 解析 provider 的那张表同源);
//  3. 从 auth.enabled 移除后热重建 ⇒ 该方式从候选里消失(显式禁用照旧摘除 ——
//     "构建失败保留旧实例"不得被扩大成"永不摘除")。
func TestMethodsConfiguredFollowsRuntimeRegistry(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	// settings:oidc 三件套齐全 + 已启用(旧实现正是只看这里)
	for k, v := range map[string]string{
		"auth.enabled":       "local,oidc",
		"oidc.issuer":        "https://idp.example.com",
		"oidc.client_id":     "example-client",
		"oidc.redirect_url":  "https://harness.example.com/api/client/v2/auth/oidc/callback",
		"oidc.client_secret": "",
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatalf("写设置 %s: %v", k, err)
		}
	}

	// 与生产同形的装配:客户端认证 API 实例(有运行期视图)+ 管理端 handler。
	api := serverauth.New(db)
	api.RegisterProvider(serverauth.NewLocalProvider(db)) // 装载过注册表 ⇒ 有运行期视图
	api.SetEnabledProviders([]string{"local", "oidc"})

	// 其余依赖沿用包内的生产同形装配(nil DB 版),只把 DB/Auth/Admin 换成真库版。
	deps := testRouterDeps(t)
	deps.DB = db
	deps.Auth = api.Handlers()
	deps.Admin = (&serverauth.AdminAPI{DB: db}).Handlers()

	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r, deps)

	const clientPath = "/api/client/v2/auth/methods"
	const adminPath = "/api/server/admin/auth/methods"

	// 判据 1:settings 齐全但运行期没有 ⇒ 两条路由都必须 configured=false
	if methodsConfigured(t, r, clientPath, "oidc") {
		t.Fatalf("%s 对 oidc 回 configured=true —— 运行期并没有这个 provider,"+
			"登录页会渲染一颗点到 404 的 SSO 按钮(这正是 R24-X4-B2 的缺陷形态)", clientPath)
	}
	if methodsConfigured(t, r, adminPath, "oidc") {
		t.Fatalf("%s 对 oidc 回 configured=true(与 %s 口径不一致或都不是运行期真源)", adminPath, clientPath)
	}
	// local 恒可用(管理员回退),不受影响
	if !methodsConfigured(t, r, clientPath, "local") {
		t.Fatal("local 必须恒 configured(管理员回退入口)")
	}

	// 判据 2:把 provider 真正注册进运行期注册表 ⇒ 同一 handler 立刻回 true
	api.RegisterBrowser(&stubBrowser{name: "oidc"})
	if !methodsConfigured(t, r, clientPath, "oidc") || !methodsConfigured(t, r, adminPath, "oidc") {
		t.Fatal("运行期已注册 oidc,两条 methods 路由仍回 configured=false —— " +
			"运行期真源没接上(判定必须与登录路由解析 provider 的那张表同源)")
	}

	// 判据 3:显式禁用后热重建 ⇒ 该方式从候选里消失(照旧摘除)
	if err := serverstore.SetSetting(db, "auth.enabled", "local"); err != nil {
		t.Fatal(err)
	}
	if err := api.ReloadProviders(db); err != nil {
		t.Fatalf("ReloadProviders: %v", err)
	}
	if names := methodsNames(t, r, clientPath); slices.Contains(names, "oidc") {
		t.Fatalf("从 auth.enabled 移除 oidc 后仍出现在候选里:%v"+
			"(显式禁用必须照旧摘除 —— 不能因为「构建失败保留旧实例」就永不摘除)", names)
	}
}

// stubBrowser 是最小的 BrowserProvider(本用例只关心"注册表里有没有它")。
type stubBrowser struct{ name string }

func (s *stubBrowser) Name() string { return s.name }
func (s *stubBrowser) AuthURL(state, returnServer, clientIP string) (string, error) {
	return "https://idp.example.com/authorize?state=" + state, nil
}
func (s *stubBrowser) HandleCallback(code, state string) (serverauth.UserInfo, error) {
	return serverauth.UserInfo{}, nil
}
func (s *stubBrowser) Configure(map[string]string) error { return nil }
