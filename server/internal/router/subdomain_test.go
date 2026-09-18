package router

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// 本文件是 §10.1 第 13a–13d 项在生产路由树上的**结构断言**：
// 应用子域只挂应用路由树，主站路由在子域**不可达**（allow-list，而不是禁命中清单）。
//
// 为什么必须在**生产树**上测：清单式"禁命中"的失败方式恰恰是"路由表里多了一条
// 谁也没想到的路径"（`/`、`/portal` 在 NoRoute 分支、`/healthz` 在根引擎上）。
// 用一个手搭的小引擎测这件事只能证明小引擎是对的。
//
// 变异验证：把 HostGate 从 `HostUnknown`/`HostApp` 分支改成 `g.Main.ServeHTTP`，
// TestAppSubdomainCannotReachMainRoutes 必红。

// stubApps 记录被路由到应用侧的主机名并**故意返回 404**
// （模拟"这个 app_id 在库里不存在"的真实形态）。
type stubApps struct {
	labels []string
	paths  []string
}

func (s *stubApps) ServeApp(w http.ResponseWriter, r *http.Request, appLabel string) {
	s.labels = append(s.labels, appLabel)
	s.paths = append(s.paths, r.URL.Path)
	edge.WriteAppNotFound(w, r, appLabel)
}

const testAppBase = "apps.example.com"

// mainRoutePaths 是"绝不能在应用子域上被命中"的主站面（§4.8 至少覆盖清单）。
var mainRoutePaths = []string{
	"/",                               // 门户首页（NoRoute 分支）
	"/portal",                         // 门户页
	"/admin/",                         // webadmin SPA（带账密表单）
	"/admin/index.html",               // SPA 静态资源
	"/healthz",                        // 存活探针（根引擎上）
	"/readyz",                         // 运维水位探针
	"/updates/client/x.AppImage",      // 客户端安装包
	"/v1/models",                      // LLM 网关
	"/v1/chat/completions",            // 网关写面
	"/chat/completions",               // 官方原生端点
	"/api/server/admin/users",         // 管理面
	"/api/server/admin/login",         // 管理登录
	"/api/client/v2/config/bootstrap", // 员工面
	"/api/client/v2/auth/login",       // 员工登录
}

// TestAppSubdomainCannotReachMainRoutes 是 13a–13d 的合并断言。
func TestAppSubdomainCannotReachMainRoutes(t *testing.T) {
	main := buildTestRouter(t)
	apps := &stubApps{}
	gate := &edge.HostGate{BaseDomain: testAppBase, Main: main, Apps: apps}

	for _, p := range mainRoutePaths {
		host := "expense-note." + testAppBase
		method := http.MethodGet
		if p == "/v1/chat/completions" || p == "/chat/completions" ||
			p == "/api/server/admin/login" || p == "/api/client/v2/auth/login" {
			method = http.MethodPost
		}
		req := httptest.NewRequest(method, "https://"+host+p, nil)
		req.Host = host
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, req)

		if w.Code != http.StatusNotFound {
			t.Errorf("%s %s：应用子域必须 404（§10.1 13a–13d），got %d body=%.80q",
				method, p, w.Code, w.Body.String())
		}
		// 最强判据：响应体里不能出现主站特征（否则就是"回落主站"）。
		body := w.Body.String()
		for _, leak := range []string{"<!doctype html><html lang=\"zh", "webadmin", "__DSH_BOOT__", "vite"} {
			if strings.Contains(strings.ToLower(body), strings.ToLower(leak)) {
				t.Errorf("%s %s：子域响应里出现了主站内容特征 %q ⇒ 回落了主站", method, p, leak)
			}
		}
	}
	if len(apps.labels) != len(mainRoutePaths) {
		t.Fatalf("应用侧只被调用了 %d 次，want %d（有请求没进应用路由树）",
			len(apps.labels), len(mainRoutePaths))
	}
	for _, l := range apps.labels {
		if l != "expense-note" {
			t.Fatalf("门控解出的 app_id=%q，want expense-note", l)
		}
	}
}

// sentinelMain 记录"主站被命中"，用来断言门控有没有把主站挡掉
// （那是"修好漏洞、弄坏产品"的同族事故）。
type sentinelMain struct{ hits int }

func (s *sentinelMain) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.hits++
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("MAIN"))
}

// TestMainHostStillServesMainRoutes：基域本身、非本基域域名、IP 直连都必须照旧走主站。
func TestMainHostStillServesMainRoutes(t *testing.T) {
	main := &sentinelMain{}
	apps := &stubApps{}
	gate := &edge.HostGate{BaseDomain: testAppBase, Main: main, Apps: apps}

	for _, host := range []string{
		testAppBase,         // 基域本身
		"other.example.net", // 不是本基域（其它域名反代到同一进程）
		"127.0.0.1:8080",    // IP 直连
		"[::1]:8080",        // IPv6 直连
	} {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/healthz", nil)
		req.Host = host
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, req)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "MAIN") {
			t.Errorf("host=%q 应当走主站，got %d body=%.40q", host, w.Code, w.Body.String())
		}
	}
	if main.hits != 4 {
		t.Fatalf("主站被命中 %d 次，want 4", main.hits)
	}
	if len(apps.labels) != 0 {
		t.Fatalf("这些主机名不该进应用分支，got %v", apps.labels)
	}
}

// TestNestedLabelIs404：`a.b.<基域>` 既拿不到通配证书，也是绕过保留字的常见手法
// ⇒ 既不进应用也不回落主站（§4.8 / R29）。
func TestNestedLabelIs404(t *testing.T) {
	main := buildTestRouter(t)
	apps := &stubApps{}
	gate := &edge.HostGate{BaseDomain: testAppBase, Main: main, Apps: apps}

	req := httptest.NewRequest(http.MethodGet, "https://x.www."+testAppBase+"/", nil)
	req.Host = "x.www." + testAppBase
	w := httptest.NewRecorder()
	gate.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("多级子域必须 404，got %d", w.Code)
	}
	if len(apps.labels) != 0 {
		t.Fatalf("多级子域不该进应用路由树，got labels=%v", apps.labels)
	}
}

// TestReservedHostnamesAreNotMainSite：保留字主机名（如 admin.<基域>）
// **不得**自动成为主站主机名 —— 否则 `admin.<基域>` 会渲染管理台登录页，
// 正是 §10.1 第 13b 项要挡住的形态。它们走应用分支，库里查不到 ⇒ 404。
func TestReservedHostnamesAreNotMainSite(t *testing.T) {
	main := buildTestRouter(t)
	apps := &stubApps{}
	gate := &edge.HostGate{BaseDomain: testAppBase, Main: main, Apps: apps}

	for _, label := range []string{"admin", "www", "api", "login", "portal"} {
		host := label + "." + testAppBase
		req := httptest.NewRequest(http.MethodGet, "https://"+host+"/", nil)
		req.Host = host
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, req)
		if w.Code != http.StatusNotFound {
			t.Errorf("%s 必须 404（不得回落主站），got %d", host, w.Code)
		}
	}
	if len(apps.labels) != 5 {
		t.Fatalf("保留字主机名应进应用分支（由库查找决定 404），labels=%v", apps.labels)
	}
}

// TestDisabledSubdomainKeepsLegacyBehavior：未配置基域时 HostGate 不挂，
// 主站行为逐字不变（避免"配错一个字整站 404"）。
func TestDisabledSubdomainKeepsLegacyBehavior(t *testing.T) {
	main := &sentinelMain{}
	apps := &stubApps{}
	gate := &edge.HostGate{BaseDomain: "", Main: main, Apps: apps}

	for _, host := range []string{"anything.example.net", "a.b.example.net", "x.apps.example.com"} {
		req := httptest.NewRequest(http.MethodGet, "http://"+host+"/healthz", nil)
		req.Host = host
		w := httptest.NewRecorder()
		gate.ServeHTTP(w, req)
		if !strings.Contains(w.Body.String(), "MAIN") {
			t.Fatalf("未启用子域时 host=%q 必须走主站，got %d", host, w.Code)
		}
	}
	if len(apps.labels) != 0 {
		t.Fatalf("未启用子域时不该有请求进应用分支，got %v", apps.labels)
	}
}

// TestLargeBodyRoutesCoverWasmUploads：上传路由必须进豁免表
// （否则 48 MiB 的 base64 上传会被 1 MB 中间件先拦掉，错误还不可读）。
func TestLargeBodyRoutesCoverWasmUploads(t *testing.T) {
	r := buildTestRouter(t)
	routes := map[string]bool{}
	for _, rt := range r.Routes() {
		routes[rt.Method+" "+rt.Path] = true
	}
	for _, key := range []string{
		"POST " + NamespaceClientV2 + "/apps/wasm/validate",
		"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/releases",
		// 分片上传：单片可达 8 MiB（§4.2），没有这条豁免就会被 1 MiB 中间件先拦掉。
		"PUT " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id/chunks/:index",
	} {
		if !routes[key] {
			t.Errorf("%s 未注册（§8 操作面）", key)
		}
		if !bodyLimitExempt(splitKeyOrPanic(t, key)) {
			t.Errorf("%s 必须在 largeBodyRoutes 豁免表里（§4.2/R21 48 MiB）", key)
		}
	}
	// 非上传的 wasm 端点**不应**豁免（保持 1 MB 默认）。
	// 开会话与 complete 都是**小 JSON**：§4.2 明写不豁免（豁免面越小越好）。
	for _, key := range []string{
		"GET " + NamespaceClientV2 + "/apps/wasm/catalog",
		"GET " + NamespaceClientV2 + "/apps/wasm/:app_id/diagnostics",
		"POST " + NamespaceClientV2 + "/apps/wasm/uploads",
		"POST " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id/complete",
		"GET " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id",
		"DELETE " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id",
	} {
		if bodyLimitExempt(splitKeyOrPanic(t, key)) {
			t.Errorf("%s 不应豁免 1 MB 上限", key)
		}
	}
}

// TestWasmRoutesRegistered：§8 操作面清单的存在性断言。
func TestWasmRoutesRegistered(t *testing.T) {
	r := buildTestRouter(t)
	routes := map[string]bool{}
	for _, rt := range r.Routes() {
		routes[rt.Method+" "+rt.Path] = true
	}
	for _, key := range []string{
		"POST " + NamespaceClientV2 + "/apps/wasm/validate",
		"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/releases",
		"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/publish",
		"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/unpublish",
		"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/freeze",
		"GET " + NamespaceClientV2 + "/apps/wasm/:app_id/export",
		"DELETE " + NamespaceClientV2 + "/apps/wasm/:app_id",
		"GET " + NamespaceClientV2 + "/apps/wasm/:app_id/diagnostics",
		"GET " + NamespaceClientV2 + "/apps/wasm/:app_id/schema",
		"GET " + NamespaceClientV2 + "/apps/wasm/catalog",
		// 分片上传与续传（§4.2：>8 MiB 走分片 + 断线续传）
		"POST " + NamespaceClientV2 + "/apps/wasm/uploads",
		"PUT " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id/chunks/:index",
		"GET " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id",
		"POST " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id/complete",
		"DELETE " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id",
		// 管理面最小运维面（R23）
		"GET " + NamespaceServer + "/admin/wasm-apps",
		"POST " + NamespaceServer + "/admin/wasm-apps/:app_id/unpublish",
		"PUT " + NamespaceServer + "/admin/wasm-apps/:app_id/owner",
		"POST " + NamespaceServer + "/admin/wasm-apps/:app_id/freeze",
		"PUT " + NamespaceServer + "/admin/wasm-apps/review",
		// 员工浏览器会话与换票（R12/R16，主站 HTML 面）
		"GET /login",
		"POST /login",
		"POST /logout",
		"GET /app-ticket",
		"POST /app-ticket",
		// 注意：`/healthz` 与 `/readyz` 在 cmd/server/main.go 直接注册
		// （它们不属于两个 API 命名空间），因此不在本测试树里；
		// 由 cmd/server 的装配代码保证。
	} {
		if !routes[key] {
			t.Errorf("缺少路由 %s（§8 操作面）", key)
		}
	}
}

func splitKeyOrPanic(t *testing.T, key string) (string, string) {
	t.Helper()
	m, p := splitKey(key)
	return m, p
}
