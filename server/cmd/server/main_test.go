package main

// 服务端 API 工程化重构测试(2026-09):
//   - 路由完整性: 全部路由只存在于 /api/server 或 /api/client/v2 命名空间
//     (新架构), 旧命名空间(/api、/v1、/v2/api、/v2/v1)不得出现。
//   - fall-open 防护: 每个 /api/server/admin/* 路由(除公开 login/methods)
//     必须通过 AdminRoute 声明权限。
//   - API JSON 契约: 未匹配的 API 前缀路径一律 JSON 信封(非 HTML/空文本)。
//
// 注意: 路由注册不需要真实 DB(handler 闭包在请求时才查库), 传 nil *sql.DB
// 即可构建路由树做完整性断言。

import (
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/updatecheck"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
	"github.com/picoaide/picoaide/webadmin"
)

// ---------------------------------------------------------------------------
// 真实数据库用例的门禁(R7 srvcore-6)。
//
// 原来这两条用例写的是 `if os.Getenv("PG_DSN_TEST") == "" { t.Skip(...) }`:
// 本机 PostgreSQL 明明可用(serverstore.PgTestDSN 的默认 DSN 就是本机测试库),
// 只要没设 env 就 --- SKIP,而 `ok github.com/…/cmd/server` 会把 SKIP 盖成绿 ——
// 于是"门户转义 + 安全头"与"登录闭环"这两条回归在本地 `go test ./...` 里一次
// 都没跑过(CI 是 job 级 env,所以 CI 里其实会跑,问题在本地信任)。
//
// 现在与 serverstore.requireTestPG 同口径(探测式):
//   - 库可达 → 必须真跑(不再看 env);
//   - 库不可达且**没有**显式配置 DSN → 跳过,但把原因与 DSN 主机打出来;
//   - 库不可达但**显式**配了 PG_DSN_TEST → 直接失败(配置事故不许静默降级)。
// ---------------------------------------------------------------------------

// realDBGate 是门禁决策(抽成纯函数以便单测三种情形,见 TestRealDBGate...)。
type realDBGate int

const (
	// realDBRun 库可达:真实库用例必须执行。
	realDBRun realDBGate = iota
	// realDBSkip 库不可达且未显式配置:跳过(打印原因)。
	realDBSkip
	// realDBFail 显式配置了 DSN 却不可达:失败(不静默降级)。
	realDBFail
)

func realDBGateFor(explicitDSN, reachable bool) realDBGate {
	switch {
	case reachable:
		return realDBRun
	case explicitDSN:
		return realDBFail
	default:
		return realDBSkip
	}
}

// postgresReachable 探测 DSN 指向的 PostgreSQL 是否可用(3 秒超时)。
func postgresReachable(dsn string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return false
	}
	defer db.Close()
	return db.PingContext(ctx) == nil
}

// dsnTarget 只回显主机与库名(DSN 里可能有口令,不能进日志)。
func dsnTarget(dsn string) string {
	u, err := url.Parse(dsn)
	if err != nil {
		return "(DSN 无法解析)"
	}
	return u.Host + u.Path
}

// requireRealDB 返回一个隔离的真实测试库;不可用时按实情跳过或失败。
func requireRealDB(t *testing.T) *sql.DB {
	t.Helper()
	dsn := serverstore.PgTestDSN()
	explicit := os.Getenv("PG_DSN_TEST") != ""
	switch realDBGateFor(explicit, postgresReachable(dsn)) {
	case realDBRun:
		// 继续往下建库。
	case realDBFail:
		t.Fatalf("PG_DSN_TEST 指向的 PostgreSQL 不可达(%s):显式配置了真实数据库就不能静默跳过,请启动数据库或清掉该变量", dsnTarget(dsn))
		return nil
	default:
		t.Skipf("PostgreSQL 不可达(%s):跳过真实数据库用例;库可用时会自动执行(不再需要 PG_DSN_TEST)", dsnTarget(dsn))
		return nil
	}
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	return db
}

// buildRouter 用**生产装配真源**(registerProductionRoutes)组装完整路由树(nil DB)。
//
// 为什么必须走生产函数(2026-09-19 P0 审计):此前这里自己抄了一份 router.Register
// 的 Deps 且不传 Wasm —— 测试树因此比生产树少 33 条路由(33 条 WASM
// 应用平台 + /login /logout /app-ticket,外加 /healthz /readyz),而"路由完整性"
// 断言照样全绿:一整片路由从不进测试视野。测试装配现在与生产共用同一段装配代码,
// 差集由 routes_source_test.go 的守卫常驻断言(数据来自真实调用,不抄路由表)。
func buildRouter(t *testing.T) *gin.Engine {
	t.Helper()
	return buildRouterWithDB(t, nil)
}

// buildRouterWithDB 与 buildRouter 同源,只是把真实 DB 交给同一批 handler
// (全路由契约扫描要发真实请求;nil 只够注册路由 —— handler 在请求时才查库)。
func buildRouterWithDB(t *testing.T, db *sql.DB) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := newEngine() // 与生产同一构造函数(P3-1:RedirectTrailingSlash=false 也在此)
	// 与生产同序(P1-2):中间件必须在路由注册之前安装,否则 panic 不返回
	// JSON 信封、也没有访问日志。
	installAPIMiddleware(r)
	registerProductionRoutes(r, testProductionDeps(t, db))
	return r
}

// testProductionDeps 构造与 main() **同形**的 productionDeps:字段一一对应,
// 只有"真实资源"换成测试可构造的等价物(临时目录、可选的真实库)。
// 漏填的后果有守卫:Wasm 漏填 ⇒ 对应整片路由从测试树
// 里消失(routes_source_test.go 的差集断言会逐条报出);Ready 等字段漏填 ⇒ 路由仍在
// 但请求必崩(见 routes_source_test.go 里的 nil-Ready 实测事实与生产侧接线断言)。
func testProductionDeps(t *testing.T, db *sql.DB) productionDeps {
	t.Helper()
	// 与 main() 一致:认证 provider 按 ConfigureProviders 注册(真实库时才可查配置;
	// nil DB 只构造形状 —— 路由注册不依赖 provider,发请求的用例一律传真实库)。
	authAPI := serverauth.New(db)
	if db != nil {
		authAPI = serverauth.NewConfiguredAPI(db).API
	}
	dataDir := t.TempDir()
	return productionDeps{
		DB:    db,
		Auth:  authAPI.Handlers(),
		Admin: (&serverauth.AdminAPI{DB: db}).Handlers(),
		// 与 main() 同源:内置技能目录取 skillseed.Dir(镜像内 /opt/picoaide/skills;
		// 本机没有该目录时清单为空,与"二进制旁边没有技能资产"的生产行为一致)。
		SkillSeed: skillseed.NewHandlers(skillseed.New(skillseed.Dir)),
		// WASM 应用平台操作面 + 员工浏览器会话面:必须非 nil,否则 router.Register
		// 整片跳过(见 productionDeps.Wasm 的注释)。
		Wasm: wasmapi.NewHandlers(wasmapi.Options{DB: db, DataRoot: dataDir}),
		// /readyz 探针:与生产同形(真实库时带 Ping)。
		Ready:     readyz.New(readyz.Options{DataRoot: dataDir, Ping: pingFn(db)}).Handler(),
		DataDir:   dataDir,
		Version:   "2.7.0",
		ChannelID: "official",
	}
}

// pingFn 把可选的真实库变成 readyz 的探针函数(nil DB ⇒ nil = 不判)。
func pingFn(db *sql.DB) func() error {
	if db == nil {
		return nil
	}
	return db.Ping
}

// TestAdminRouterNoFallOpen: **管理面命名空间**下每条路由都必须申报（或在显式
// 公开豁免表里）。
//
// R4-C-2（审计 2026-09-23，P2）：判据从"字面量前缀 `/api/server/admin/`"改成
// **命名空间级**（`/api/server` 下的每一条），因为旧写法能被三种新写法绕过：
// `/api/server/admin-extra/*`、`/api/server/ops/*`、恰好 `/api/server/admin`
// —— 它们同时躲过本用例与 internal/router 的镜像对拍，在 `router.go`（§7.0 规定的
// 唯一落点）里新增这样的路由**没有任何红灯**。
//
// 判据实现是纯函数 `serverauth.AdminNamespaceViolations`（豁免表按 (method,path)
// 精确匹配，不用前缀包含放行；陈旧条目也判红），下面第 3 段用注入的路由集合自证
// 判别力（四种写法逐一必须被判红 + 申报过的路由必须放行 + 陈旧豁免必须判红）。
func TestAdminRouterNoFallOpen(t *testing.T) {
	r := buildRouter(t)
	routes := make([]string, 0, len(r.Routes()))
	for _, rt := range r.Routes() {
		routes = append(routes, rt.Method+" "+rt.Path)
	}
	declared := map[string]bool{}
	for _, rr := range serverauth.AdminRoutePerms() {
		declared[rr.Method+" "+rr.Path] = true
	}
	publicKeys := make([]string, 0, 4)
	exemptions := serverauth.PublicAdminRoutes()
	for _, e := range exemptions {
		if strings.TrimSpace(e.Reason) == "" {
			t.Fatalf("公开豁免 %s %s 没写理由（豁免是安全决策，必须逐条说明）", e.Method, e.Path)
		}
		publicKeys = append(publicKeys, e.Method+" "+e.Path)
	}
	public := serverauth.MethodPathSet(publicKeys)

	undeclared, stale := serverauth.AdminNamespaceViolations(routes, declared, public)
	if len(undeclared) > 0 {
		sort.Strings(undeclared)
		t.Fatalf("fall-open: 管理面命名空间 %s 下有 %d 条路由既未申报也未豁免：\n  %s\n"+
			"⇒ 管理面路由必须经 serverauth.AdminRoute 申报权限点（或在 PublicAdminRoutes 里逐条登记理由，仅限未认证的登录面）",
			serverauth.AdminNamespaceServer, len(undeclared), strings.Join(undeclared, "\n  "))
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Fatalf("申报表/豁免表里有 %d 条在路由表里不存在（改名/删除后没清理）：\n  %s",
			len(stale), strings.Join(stale, "\n  "))
	}

	// 3) 判据自带变异证明：三种"旧判据判不出来"的新写法 + 对照，逐一实跑。
	//
	// 探针路径必须带一个**保证不在申报表/豁免表里**的后缀：否则一旦真实树里存在同名
	// 已申报路由，注入形态会变成"已申报 ⇒ 不判红"，本段就会误报"判别力失效"（实测：
	// 在 router.go 里加一条经 AdminRoute 申报的 /admin/probe-x 时命中）。前缀形态的
	// 三种写法仍逐一构造，下面另有前置断言兜住"探针路径被真实条目污染"。
	const probeTail = "/zz-probe-never-declared"
	probes := []string{
		"GET " + serverauth.AdminNamespaceServer + "/admin" + probeTail,
		"GET " + serverauth.AdminNamespaceServer + "/admin-extra" + probeTail,
		"GET " + serverauth.AdminNamespaceServer + "/ops" + probeTail,
		"GET " + serverauth.AdminNamespaceServer + "/admin", // 恰好等于前缀去尾斜杠（形态本身没有可加后缀的位置）
	}
	for _, key := range probes {
		if declared[key] || public[key] {
			t.Fatalf("前置不成立：探针路径 %s 已在申报/豁免表里，判别力证明会被污染", key)
		}
	}
	base := append([]string{}, routes...)
	for _, tc := range []struct {
		key  string
		want bool // 是否必须被判红
	}{
		{probes[0], true}, // 对照：旧判据也抓得住
		{probes[1], true}, // 前缀近似 admin-extra
		{probes[2], true}, // 同命名空间另一分组 ops
		{probes[3], true}, // 恰好等于前缀去尾斜杠
		{"GET " + serverauth.AdminNamespaceServer + "/admin/users", false},  // 已申报 ⇒ 放行
		{"POST " + serverauth.AdminNamespaceServer + "/admin/login", false}, // 已豁免 ⇒ 放行
		{"GET " + serverauth.AdminNamespaceServer + "/admin/login", true},   // 豁免按 (method,path) 精确匹配：换个方法不再豁免
		{"GET /api/serverless/probe-x", false},                              // 裸前缀近似但**不属于**该命名空间
	} {
		got, _ := serverauth.AdminNamespaceViolations(append(append([]string{}, base...), tc.key), declared, public)
		caught := false
		for _, v := range got {
			if v == tc.key {
				caught = true
			}
		}
		if caught != tc.want {
			t.Fatalf("判据判别力失效：%s 期望被判红=%v，实得 %v（undeclared=%v）", tc.key, tc.want, caught, got)
		}
	}
	// 陈旧豁免条目同样必须判红（防"清单越长越像有守卫"）。
	if _, staleInjected := serverauth.AdminNamespaceViolations(
		base, declared, serverauth.MethodPathSet(append(publicKeys, "GET /api/server/admin/does-not-exist")),
	); len(staleInjected) == 0 {
		t.Fatal("判据没咬住陈旧的豁免条目（登记了却不存在必须判红）")
	}
}

// TestAdminNamespaceConstantMatchesRouterTruth 锁住"命名空间常量只有一份真源"：
// serverauth.AdminNamespaceServer 是 router.NamespaceServer 的副本（反向 import 会
// 成环），两者漂移必须判红 —— 否则判据会在错误的命名空间上"守卫"。
func TestAdminNamespaceConstantMatchesRouterTruth(t *testing.T) {
	if serverauth.AdminNamespaceServer != router.NamespaceServer {
		t.Fatalf("serverauth.AdminNamespaceServer=%q 与 router.NamespaceServer=%q 漂移",
			serverauth.AdminNamespaceServer, router.NamespaceServer)
	}
}

// TestRouterNamespaces: 全部路由只属于 /api/server 或 /api/client/v2;
// 旧命名空间不得出现(迁移式)。
func TestRouterNamespaces(t *testing.T) {
	r := buildRouter(t)
	checked := 0
	for _, rt := range r.Routes() {
		p := rt.Path
		if isLegacyPath(p) {
			t.Fatalf("legacy namespace still present: %s %s", rt.Method, p)
		}
		if strings.HasPrefix(p, router.NamespaceClientV2+"/") || strings.HasPrefix(p, router.NamespaceServer+"/") {
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no routes under new namespaces")
	}
	t.Logf("routes under new namespaces: %d", checked)
}

func isLegacyPath(p string) bool {
	if p == "/api" || p == "/v1" || p == "/v2" {
		return true
	}
	// DeepSeek 兼容 LLM 网关 /v1/* 是保留原样的独立命名空间(2026-09 定案)。
	if strings.HasPrefix(p, "/v1/") {
		return false
	}
	if strings.HasPrefix(p, "/v2/") {
		return true
	}
	if strings.HasPrefix(p, "/api/") &&
		!strings.HasPrefix(p, router.NamespaceServer+"/") &&
		!strings.HasPrefix(p, router.NamespaceClientV2+"/") {
		return true
	}
	return false
}

// 说明(2026-09-15 死代码审计):原 TestHTMLEscapes 断言的是 cmd/server 里
// 手写的 htmlEscape;门户 HTML 自 e972df79ed(2026-09-10 渠道配置承接对外
// 内容)起改由 internal/portal 的 html/template 渲染,转义是模板引擎的职责,
// 该断言与实现一起删除。门户转义回归见 internal/portal/portal_test.go
// (TestRenderEscapesChannelContent:文本/属性两个上下文分别断言)。

// 管理台 /admin/* 是与门户同级的 HTML 面,必须带上同级基础安全头。
//
// 缺陷语义(审计 R7 webadmin-branding-1):该分支此前只设 Cache-Control +
// Content-Type —— CSP / nosniff / X-Frame-Options / Referrer-Policy 四个头
// 全缺席(全仓唯一的 CSP 只在门户 /)。管理台是已登录管理员的会话面:
// 没有 frame-ancestors/X-Frame-Options 就可被跨站 iframe 套用(点击劫持),
// 没有 nosniff 则内容嗅探可执行伪装资源。
//
// 与门户不同,管理台是 React SPA:CSP 必须放行**同源脚本/样式**(否则白屏),
// 但不得放开 eval / 任意来源 / 内联脚本来源。
func TestAdminResponsesCarrySecurityHeaders(t *testing.T) {
	r := buildRouter(t)
	dist, err := fs.Sub(webadmin.FS, "dist")
	if err != nil {
		t.Fatalf("webadmin dist: %v", err)
	}
	fileServer := http.FileServer(http.FS(dist))
	mountAPIGuards(r, nil, fileServer, dist)

	// 构建产物名带内容哈希,不能写死;dist 未构建(CI 的 go test 早于
	// npm run build,只有 .gitkeep)时跳过该分支。
	assetPath := ""
	if entries, err := fs.ReadDir(dist, "assets"); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				assetPath = "/admin/assets/" + e.Name()
				break
			}
		}
	}
	preview, _ := dist.Open("index.html")
	distBuilt := preview != nil
	if preview != nil {
		preview.Close()
	}

	check := func(t *testing.T, w *httptest.ResponseRecorder, path string) {
		t.Helper()
		h := w.Header()
		if got := h.Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("GET %s X-Content-Type-Options = %q, want nosniff", path, got)
		}
		if got := h.Get("X-Frame-Options"); got != "DENY" {
			t.Errorf("GET %s X-Frame-Options = %q, want DENY(防点击劫持)", path, got)
		}
		if got := h.Get("Referrer-Policy"); got != "no-referrer" {
			t.Errorf("GET %s Referrer-Policy = %q, want no-referrer", path, got)
		}
		csp := h.Get("Content-Security-Policy")
		if csp == "" {
			t.Fatalf("GET %s 缺 Content-Security-Policy", path)
		}
		// SPA 需要同源脚本/样式;但不许放开 eval、任意来源或内联脚本来源。
		for _, want := range []string{"default-src 'self'", "script-src 'self'", "frame-ancestors 'none'", "object-src 'none'"} {
			if !strings.Contains(csp, want) {
				t.Errorf("GET %s CSP = %q, 缺 %q", path, csp, want)
			}
		}
		for _, banned := range []string{"unsafe-eval", "script-src *", "script-src 'unsafe-inline'"} {
			if strings.Contains(csp, banned) {
				t.Errorf("GET %s CSP = %q 不得包含 %q", path, csp, banned)
			}
		}
	}

	// SPA 入口与前端路由回退:无论 dist 是否构建,安全头都必须先于内容设置。
	for _, path := range []string{"/admin/", "/admin/usage/balance"} {
		t.Run(path, func(t *testing.T) {
			w := httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
			if distBuilt {
				if w.Code != http.StatusOK {
					t.Fatalf("GET %s = %d, want 200(webadmin 已构建); body=%s", path, w.Code, w.Body.String())
				}
				if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "no-store") {
					t.Errorf("GET %s Cache-Control = %q, want no-store(部署后立即生效)", path, cc)
				}
			} else {
				t.Logf("dist 未构建:GET %s 返回 %d(仅断言安全头)", path, w.Code)
			}
			check(t, w, path)
		})
	}

	t.Run("assets", func(t *testing.T) {
		if assetPath == "" {
			if distBuilt {
				t.Fatal("dist 已构建但 assets/ 为空")
			}
			t.Skip("dist 未构建,webadmin npm run build 后覆盖此分支")
		}
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, assetPath, nil))
		if w.Code != http.StatusOK {
			t.Fatalf("GET %s = %d, want 200", assetPath, w.Code)
		}
		if cc := w.Header().Get("Cache-Control"); !strings.Contains(cc, "immutable") {
			t.Errorf("GET %s Cache-Control = %q, want immutable(内容哈希)", assetPath, cc)
		}
		check(t, w, assetPath)
	})
}

// TestAPIJSONContract: 未匹配的 API 前缀(新命名空间)路径一律 JSON 错误信封。
func TestAPIJSONContract(t *testing.T) {
	r := buildRouter(t)
	dist, _ := fs.Sub(webadmin.FS, "dist")
	fileServer := http.FileServer(http.FS(dist))
	mountAPIGuards(r, nil, fileServer, dist)

	cases := []struct {
		method string
		path   string
	}{
		{"GET", "/api/client/v2/unknown-nothing"},
		{"POST", "/api/client/v2/unknown-nothing"},
		{"GET", "/api/client/v2/v1/unknown-x"},
		{"POST", "/api/client/v2/unknown/deep"},
		{"GET", "/api/server/unknown-nothing"},
		{"POST", "/api/server/admin/unknown-x"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			ct := w.Header().Get("Content-Type")
			if !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("%s %s: Content-Type = %q, want application/json; body=%s", tc.method, tc.path, ct, w.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("%s %s: body not JSON: %v; body=%s", tc.method, tc.path, err, w.Body.String())
			}
			if _, ok := body["error"]; !ok {
				t.Fatalf("%s %s: body missing error envelope: %s", tc.method, tc.path, w.Body.String())
			}
		})
	}

	// panic 场景: 中间件必须把 panic 恢复为 JSON 信封。
	t.Run("panic recovers to JSON", func(t *testing.T) {
		panicRouter := gin.New()
		// 生产顺序:先装中间件,再注册路由(P1-2)。此前的测试先 mount 后
		// 注册,恒绿,掩盖了生产路由无 Recovery 的真实缺陷。
		installAPIMiddleware(panicRouter)
		panicRouter.GET("/boom", func(c *gin.Context) { panic("boom") })
		w := httptest.NewRecorder()
		panicRouter.ServeHTTP(w, httptest.NewRequest("GET", "/boom", nil))
		if w.Code != http.StatusInternalServerError {
			t.Fatalf("panic: status = %d, want 500", w.Code)
		}
		if !strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
			t.Fatalf("panic: Content-Type = %q, want application/json; body=%s", w.Header().Get("Content-Type"), w.Body.String())
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("panic: body not JSON: %v; body=%s", err, w.Body.String())
		}
		if _, ok := body["error"]; !ok {
			t.Fatalf("panic: body missing error envelope: %s", w.Body.String())
		}
	})
}

// TestV2RealDB(真实 PG): 新命名空间公开端点用真实 DB 验证登录闭环。
// TestPortalEscaping: 门户页对其渲染的渠道内容做 HTML 转义且带基础安全头。
//
// 2026-09-10 变更:门户的名称/标语/欢迎语来源从 webadmin 设置(brand.login.*)
// 改为**渠道配置**(镜像内 channels/<id>/channel.json,由私有仓在构建期注入)。
// 该内容现在是编译期可信的,不再由管理员在线编辑;但转义要求不变 ——
// 渠道内容是文本,任何 < > " 都必须转义,否则渠道配置里一个尖括号就能
// 在未认证访客的门户页上注入脚本。
//
// 同时验证门户**不再读取**数据库里的 brand.* 设置(旧来源已下线)。
func TestPortalEscaping(t *testing.T) {
	db := requireRealDB(t)
	// 旧来源:即便有人在 settings 里塞了脚本,门户也不再读它
	if err := serverstore.SetSetting(db, "brand.login.display_name", `<script>alert(1)</script>`); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/", func(c *gin.Context) { servePortal(c, db) })
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/", w.Body))
	if w.Code != http.StatusOK {
		t.Fatalf("portal = %d", w.Code)
	}
	body := w.Body.String()
	if strings.Contains(body, "<script") {
		t.Fatalf("门户不得包含任何 <script(零脚本页面): %s", body)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" || w.Header().Get("Content-Security-Policy") == "" {
		t.Fatalf("portal must carry baseline security headers, got %v", w.Header())
	}
	// 门户对外是纯 HTML+CSS:CSP 不放开 script-src
	if csp := w.Header().Get("Content-Security-Policy"); strings.Contains(csp, "script-src") {
		t.Fatalf("CSP 不应放开 script-src(零脚本页面): %s", csp)
	}
}

// 真实 PG 用例:库可达时必跑,不可达时按 realDBGateFor 的口径跳过/失败。
func TestV2RealDB(t *testing.T) {
	db := requireRealDB(t)

	gin.SetMode(gin.TestMode)
	// 与生产同一棵路由树(生产装配真源)——登录闭环必须在**完整**路由上成立。
	r := buildRouterWithDB(t, db)
	// 创建登录账号(测试库为空)。
	if _, err := serverstore.CreateUserWithPassword(db, "admin", "admin123456"); err != nil {
		t.Fatalf("create user: %v", err)
	}
	dist, _ := fs.Sub(webadmin.FS, "dist")
	fileServer := http.FileServer(http.FS(dist))
	mountAPIGuards(r, db, fileServer, dist)

	// 客户登录闭环: /api/client/v2/auth/login → me。
	loginReq := httptest.NewRequest("POST", "/api/client/v2/auth/login", strings.NewReader(`{"username":"admin","password":"admin123456"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, loginReq)
	if w.Code != http.StatusOK {
		t.Fatalf("client login = %d, want 200; body=%s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("login body not JSON: %v", err)
	}
	token, _ := body["token"].(string)
	if token == "" {
		t.Fatal("login returned no token")
	}
	meReq := httptest.NewRequest("GET", "/api/client/v2/auth/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+token)
	w2 := httptest.NewRecorder()
	r.ServeHTTP(w2, meReq)
	if w2.Code != http.StatusOK {
		t.Fatalf("client me = %d, want 200; body=%s", w2.Code, w2.Body.String())
	}
}

// ---- 渠道启动校验(2026-09-10) ----
//
// 审计发现的两个入口都在**启动期**挡:①显式配置了渠道却解析不出来,回落
// official 会让渠道部署接受官方清单、把品牌洗掉;②镜像内的渠道内容与本进程
// 按的渠道不一致,典型成因是 .env/compose 覆盖了镜像自带的渠道声明
// (仓库自带 compose 曾把 PICOAI_CHANNEL 默认写死 official,正是这条)。

// ---- 缺陷 4 回归(2026-09-10):非官方渠道漏配 deep_link_scheme 必须启动期报错 ----
//
// DeepLinkScheme() 在缺字段/畸形时回落厂商 scheme(picoaide)—— 官方/beta 是
// 向后兼容;但品牌渠道漏配意味着客户在浏览器"打开 picoaide?"确认框里看到
// 厂商名(白标失败),必须在启动期 fail-loud。

// writeChannelDirRaw 造一个内容自定的渠道目录(带 desktop 段等)。
func writeChannelDirRaw(t *testing.T, body string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "channel.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write channel.json: %v", err)
	}
	return dir
}

// pointChannelMarker 造镜像标记文件(进程按哪个渠道跑)。
func pointChannelMarker(t *testing.T, dir, channelID string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, "CHANNEL"), []byte(channelID+"\n"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}
}

func TestResolveStartupChannelDeepLinkScheme(t *testing.T) {
	cases := []struct {
		name      string
		channelID string
		config    string // channel.json 内容(空=只有 identity)
		wantErr   bool
	}{
		{
			// ⚠️ 本用例回答的是 **deep_link_scheme** 的豁免（公共渠道不要求它）；
			// `app_origin_scheme` 是**全部渠道必填**（§8.3/§10，主控裁决不豁免 official/beta）
			// ⇒ 夹具必须带上它，否则会因为另一条独立的 fail-loud 提前失败（那不是本用例的问题）。
			name:      "官方缺 deep_link_scheme 通过",
			channelID: "official",
			config: `{"schema":1,"channel_id":"official","identity":{"display_name":"X"},
				"desktop":{"app_origin_scheme":"picoaide-app"}}`,
		},
		{
			name:      "beta 缺 deep_link_scheme 通过",
			channelID: "beta",
			config: `{"schema":1,"channel_id":"beta","identity":{"display_name":"X"},
				"desktop":{"app_origin_scheme":"picoaide-app"}}`,
		},
		{
			// app_origin_scheme 的**独立** fail-loud：公共渠道同样不豁免（§8.3）。
			name:      "官方缺 app_origin_scheme 报错",
			channelID: "official",
			config:    `{"schema":1,"channel_id":"official","identity":{"display_name":"X"}}`,
			wantErr:   true,
		},
		{
			name:      "品牌渠道缺字段报错",
			channelID: "acme",
			config:    `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme"}}`,
			wantErr:   true,
		},
		{
			name:      "品牌渠道畸形 scheme 报错",
			channelID: "acme",
			config: `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme"},
				"desktop":{"deep_link_scheme":"Acme AI","app_origin_scheme":"acme-app"}}`,
			wantErr: true,
		},
		{
			name:      "品牌渠道合法值通过",
			channelID: "acme",
			config: `{"schema":1,"channel_id":"acme","identity":{"display_name":"Acme"},
				"desktop":{"deep_link_scheme":"acme-ai","app_origin_scheme":"acme-ai-app"}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := writeChannelDirRaw(t, tc.config)
			pointChannelDir(t, dir)
			pointChannelMarker(t, dir, tc.channelID)
			t.Setenv(updatecheck.ChannelEnv, "")
			t.Setenv(updatecheck.EndpointEnv, "")

			got, err := resolveStartupChannel()
			if tc.wantErr {
				if err == nil {
					t.Fatalf("渠道 %s 漏配/畸形 deep_link_scheme 必须拒绝启动(实际通过,渠道 %q)", tc.channelID, got)
				}
				if !strings.Contains(err.Error(), "deep_link_scheme") {
					t.Fatalf("错误信息应点名 deep_link_scheme: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveStartupChannel() error = %v", err)
			}
			if got != tc.channelID {
				t.Fatalf("channel = %q, want %q", got, tc.channelID)
			}
		})
	}
}

// ---- 缺陷 1 回归(2026-09-10):门户下载入口与更新清单同一口径 ----
//
// 门户的内置下载地址只在能给出安全(https)来源时显示;否则不显示入口并把
// 原因写进下载区(运维据此配置 PICOAI_PUBLIC_BASE_URL)。管理员配置的
// portal.client_download_* 覆盖地址不受影响。

// withPortalReleaseDir 造一个带三平台资产的客户端资产目录。
func withPortalReleaseDir(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	info := `{"schema":1,"channel_id":"official","client":{"version":"2.7.0","assets":{
      "win-x64":{"file":"Setup.exe","sha256":"a","size":1},
      "mac-universal":{"file":"App.dmg","sha256":"b","size":2},
      "linux-x64":{"file":"App.AppImage","sha256":"c","size":3}}}}`
	if err := os.WriteFile(filepath.Join(dir, "CLIENT-RELEASE.json"), []byte(info), 0o644); err != nil {
		t.Fatal(err)
	}
	prev := clientrelease.Dir
	clientrelease.Dir = dir
	t.Cleanup(func() { clientrelease.Dir = prev })
}

func TestPortalDownloadsRequireSecureOrigin(t *testing.T) {
	withPortalReleaseDir(t)
	t.Setenv(clientrelease.PublicBaseURLEnv, "")

	serve := func(host, xfp string, settings map[string]string) ([]portal.Platform, string) {
		gin.SetMode(gin.TestMode)
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/portal", nil)
		c.Request.Host = host
		if xfp != "" {
			c.Request.Header.Set("X-Forwarded-Proto", xfp)
		}
		return portalDownloads(c, settings)
	}

	t.Run("安全来源显示内置入口", func(t *testing.T) {
		items, note := serve("ai.example.com", "https", nil)
		if note != "" {
			t.Fatalf("安全来源不该有说明: %q", note)
		}
		for i, want := range []string{"/updates/client/Setup.exe", "/updates/client/App.dmg", "/updates/client/App.AppImage"} {
			if items[i].URL != want {
				t.Errorf("%s url = %q, want %q", items[i].Name, items[i].URL, want)
			}
		}
	})

	t.Run("不安全来源不显示入口并说明原因", func(t *testing.T) {
		items, note := serve("10.0.0.9", "", nil)
		for _, p := range items {
			if p.URL != "" {
				t.Errorf("%s 不该有下载地址: %q", p.Name, p.URL)
			}
			if !strings.Contains(p.Meta, "暂无可用安装包") {
				t.Errorf("%s meta = %q", p.Name, p.Meta)
			}
		}
		if !strings.Contains(note, clientrelease.PublicBaseURLEnv) {
			t.Fatalf("说明应提示配置 %s: %q", clientrelease.PublicBaseURLEnv, note)
		}
	})

	t.Run("管理员配置的自有地址仍然生效", func(t *testing.T) {
		items, _ := serve("10.0.0.9", "", map[string]string{
			"portal.client_download_win": "https://cdn.example.com/win.exe",
		})
		if items[0].URL != "https://cdn.example.com/win.exe" {
			t.Errorf("管理员配置应优先: %q", items[0].URL)
		}
		if items[1].URL != "" {
			t.Errorf("未配置的平台不该有地址: %q", items[1].URL)
		}
	})
}

// writeChannelDir 造一个只含 channel.json 的渠道目录。
func writeChannelDir(t *testing.T, channelID string) string {
	t.Helper()
	// 公共渠道(official/beta)不要求 deep_link_scheme，但 **app_origin_scheme 全部渠道必填**
	//（§8.3/§10：CI 硬校验，服务端启动期 fail-loud）⇒ 夹具必须带上它。
	return writeChannelDirRaw(t, `{"schema":1,"channel_id":"`+channelID+`","identity":{"display_name":"X"},
		"desktop":{"app_origin_scheme":"harness-app"}}`)
}

// pointChannelDir 把渠道目录与镜像标记文件都指到临时目录(不碰 /opt)。
func pointChannelDir(t *testing.T, dir string) {
	t.Helper()
	restoreDir := channel.Dir
	channel.Dir = dir
	restoreFile := updatecheck.ChannelFile
	updatecheck.ChannelFile = filepath.Join(dir, "CHANNEL")
	t.Cleanup(func() {
		channel.Dir = restoreDir
		updatecheck.ChannelFile = restoreFile
	})
}

func TestResolveStartupChannelAcceptsMatchingImageChannel(t *testing.T) {
	// 品牌渠道必须自带 deep_link_scheme(见 TestResolveStartupChannelDeepLinkScheme)
	dir := writeChannelDirRaw(t, `{"schema":1,"channel_id":"acme","identity":{"display_name":"X"},
      "desktop":{"deep_link_scheme":"acme","app_origin_scheme":"acme-app"}}`)
	pointChannelDir(t, dir)
	t.Setenv(updatecheck.ChannelEnv, "")
	t.Setenv(updatecheck.EndpointEnv, "")
	pointChannelMarker(t, dir, "acme")

	got, err := resolveStartupChannel()
	if err != nil {
		t.Fatalf("resolveStartupChannel() error = %v", err)
	}
	if got != "acme" {
		t.Fatalf("resolveStartupChannel() = %q, want acme", got)
	}
}

// 这条就是 compose 覆盖场景:镜像是 acme,而部署侧(旧的 compose 默认值)
// 把 PICOAI_CHANNEL 设成了 official —— 必须拒绝启动,而不是按 official 跑。
func TestResolveStartupChannelRejectsDeployOverride(t *testing.T) {
	dir := writeChannelDir(t, "acme")
	pointChannelDir(t, dir)
	t.Setenv(updatecheck.ChannelEnv, "official")
	t.Setenv(updatecheck.EndpointEnv, "")

	_, err := resolveStartupChannel()
	if err == nil {
		t.Fatal("镜像渠道 acme + 部署覆盖 official 必须拒绝启动")
	}
	if !strings.Contains(err.Error(), "渠道不一致") {
		t.Fatalf("error = %v, want 渠道不一致", err)
	}
}

// 渠道非法(拼写错误)→ 拒绝启动,绝不静默回落 official。
func TestResolveStartupChannelRejectsInvalidChannel(t *testing.T) {
	dir := writeChannelDir(t, "acme")
	pointChannelDir(t, dir)
	t.Setenv(updatecheck.ChannelEnv, "Acme Corp")
	t.Setenv(updatecheck.EndpointEnv, "")

	if _, err := resolveStartupChannel(); err == nil {
		t.Fatal("非法渠道 id 必须拒绝启动")
	}
}

// ---------------------------------------------------------------------------
// 访问日志脱敏(审计 2026-09-12):OIDC/OpenID 回调把 IdP 授权码与 login-CSRF
// state 放在查询串上。gin.Logger() 记录的是 RequestURI(path+query),等于把
// 授权码写进容器日志。accessLogger() 必须只记 path。
// ---------------------------------------------------------------------------

func TestAccessLoggerDropsQueryString(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	var buf strings.Builder
	r.Use(accessLoggerTo(&buf))
	r.GET("/api/client/v2/auth/oidc/callback", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	w := httptest.NewRecorder()
	// 凭据模拟真实回调:授权码 + state。
	req := httptest.NewRequest(http.MethodGet,
		"/api/client/v2/auth/oidc/callback?code=SECRET-AUTH-CODE&state=SECRET-STATE", nil)
	r.ServeHTTP(w, req)

	logged := buf.String()
	if !strings.Contains(logged, "/api/client/v2/auth/oidc/callback") {
		t.Fatalf("path must still be logged (排障需要), got: %q", logged)
	}
	if strings.Contains(logged, "SECRET-AUTH-CODE") || strings.Contains(logged, "SECRET-STATE") {
		t.Fatalf("query credentials leaked into access log: %q", logged)
	}
	if strings.Contains(logged, "?") {
		t.Fatalf("query separator must not appear in access log: %q", logged)
	}
}

// TestAuditFixTrailingSlashNoRedirect(P3-1,审计 2026-09-13):
// 尾斜杠请求不得再走 gin 的 307 分支 —— 那条分支不执行路由中间件
// (实测 1MB bodyLimitMiddleware 完全没跑)。现在统一落到 NoRoute 的 JSON 404。
func TestAuditFixTrailingSlashNoRedirect(t *testing.T) {
	r := buildRouter(t)
	// 与 TestAPIJSONContract 同序:NoRoute 护栏是 404 JSON 契约的提供者。
	dist, _ := fs.Sub(webadmin.FS, "dist")
	mountAPIGuards(r, nil, http.FileServer(http.FS(dist)), dist)
	for _, tc := range []struct{ method, path string }{
		{"POST", "/api/client/v2/auth/login/"},
		{"POST", "/api/server/admin/login/"},
		{"GET", "/api/client/v2/config/bootstrap/"},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader("{}"))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code == http.StatusTemporaryRedirect || w.Code == http.StatusMovedPermanently {
			t.Fatalf("%s %s 仍返回重定向 %d(跳过中间件链)", tc.method, tc.path, w.Code)
		}
		if w.Code != http.StatusNotFound {
			t.Fatalf("%s %s = %d, want 404 JSON", tc.method, tc.path, w.Code)
		}
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("%s %s 非 JSON: %s", tc.method, tc.path, w.Body.String())
		}
		if _, ok := body["error"]; !ok {
			t.Fatalf("%s %s 缺少错误信封: %s", tc.method, tc.path, w.Body.String())
		}
	}
}

// 门禁决策的永久回归(R7 srvcore-6):库可达时**永远不能**跳过。
//
// 这是缺陷语义的最小固化:原来"跳过"只看 env 是否存在,与本机库是否可用无关,
// 于是本地 `go test ./...` 全绿而两条真库回归从未执行(`ok` 掩盖 SKIP)。
func TestRealDBGateNeverSilentlySkipsWhenReachable(t *testing.T) {
	cases := []struct {
		name        string
		explicitDSN bool
		reachable   bool
		want        realDBGate
	}{
		{"库可达 + 未设 env:必须真跑(旧行为是 SKIP)", false, true, realDBRun},
		{"库可达 + 设了 env:真跑", true, true, realDBRun},
		{"库不可达 + 设了 env:显式失败,不静默降级", true, false, realDBFail},
		{"库不可达 + 未设 env:跳过(打印原因)", false, false, realDBSkip},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := realDBGateFor(tc.explicitDSN, tc.reachable); got != tc.want {
				t.Fatalf("realDBGateFor(explicit=%v, reachable=%v) = %v, want %v", tc.explicitDSN, tc.reachable, got, tc.want)
			}
		})
	}
	// 跳过的理由必须带上 DSN 主机与库名(排障),且不得回显口令。
	got := dsnTarget("postgres://user:s3cret@db.example.com:5432/picoaide_test?sslmode=disable")
	if got != "db.example.com:5432/picoaide_test" {
		t.Fatalf("dsnTarget = %q, want 主机+库名", got)
	}
	if strings.Contains(got, "s3cret") {
		t.Fatal("dsnTarget 回显了口令")
	}
}
