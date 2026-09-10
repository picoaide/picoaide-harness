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
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	"github.com/picoaide/picoaide/internal/updatecheck"
	"github.com/picoaide/picoaide/webadmin"
)

// buildRouter 用与 main 相同的 Deps 组装完整路由树(nil DB)。
func buildRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 与生产同序(P1-2):中间件必须在路由注册之前安装,否则 panic 不返回
	// JSON 信封、也没有访问日志。
	installAPIMiddleware(r)
	router.Register(r, router.Deps{
		DB:            nil,
		Auth:          serverauth.New(nil).Handlers(),
		Admin:         (&serverauth.AdminAPI{}).Handlers(),
		Appstore:      appstore.NewHandlers(nil),
		Bootstrap:     bootstrap.NewHandlers(nil),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(nil),
		ClientRelease: clientrelease.NewHandlers(func() string { return "2.7.0" }, "official"),
		Market:        marketplace.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Agentshare:    agentshare.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Shared:        sharedskills.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Capability:    capabilities.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Connector:     connectors.NewHandlers(nil),
		Telemetry:     telemetry.NewHandlers(nil),
		Gateway:       llmgateway.NewHandlers(nil),
		Reports:       reports.NewHandlers(nil),
	})
	return r
}

// TestAdminRouterNoFallOpen: 每个 /api/server/admin/* 路由(除公开 login/
// auth/methods)都必须出现在 serverauth.AdminRoute registry 中。
func TestAdminRouterNoFallOpen(t *testing.T) {
	r := buildRouter(t)
	registered := map[string]bool{}
	for _, rr := range serverauth.AdminRoutePerms() {
		registered[rr.Method+" "+rr.Path] = true
	}
	public := map[string]bool{
		"POST /api/server/admin/login":       true,
		"POST /api/server/admin/login/mfa":   true,
		"GET /api/server/admin/auth/methods": true,
	}
	for _, rt := range r.Routes() {
		if len(rt.Path) < len("/api/server/admin/") || rt.Path[:len("/api/server/admin/")] != "/api/server/admin/" {
			continue
		}
		key := rt.Method + " " + rt.Path
		if public[key] {
			continue
		}
		if !registered[key] {
			t.Fatalf("fall-open: %s has no permission declared", key)
		}
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

func TestHTMLEscapes(t *testing.T) {
	if got := htmlEscape(`<script>alert("x")</script>`); got != "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;" {
		t.Fatalf("escape = %s", got)
	}
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
	if os.Getenv("PG_DSN_TEST") == "" {
		t.Skip("PG_DSN_TEST not set; skipping real-DB test")
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
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

// 依赖 PG_DSN_TEST, 无 PG 时跳过。
func TestV2RealDB(t *testing.T) {
	if os.Getenv("PG_DSN_TEST") == "" {
		t.Skip("PG_DSN_TEST not set; skipping real-DB test")
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 创建登录账号(测试库为空)。
	if _, err := serverstore.CreateUserWithPassword(db, "admin", "admin123456"); err != nil {
		t.Fatalf("create user: %v", err)
	}
	authCfg := serverauth.NewConfiguredAPI(db)
	router.Register(r, router.Deps{
		DB:            db,
		Auth:          authCfg.API.Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:      appstore.NewHandlers(db),
		Bootstrap:     bootstrap.NewHandlers(db),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(nil),
		ClientRelease: clientrelease.NewHandlers(func() string { return "dev" }, "official"),
		Market:        marketplace.NewHandlers(db, t.TempDir()),
		Agentshare:    agentshare.NewHandlers(db, t.TempDir()),
		Shared:        sharedskills.NewHandlers(db, t.TempDir()),
		Capability:    capabilities.NewHandlers(db, t.TempDir()),
		Connector:     connectors.NewHandlers(db),
		Telemetry:     telemetry.NewHandlers(db),
		Gateway:       llmgateway.NewHandlers(db),
		Reports:       reports.NewHandlers(db),
	})
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

// writeChannelDir 造一个只含 channel.json 的渠道目录。
func writeChannelDir(t *testing.T, channelID string) string {
	t.Helper()
	dir := t.TempDir()
	body := `{"schema":1,"channel_id":"` + channelID + `","identity":{"display_name":"X"}}`
	if err := os.WriteFile(filepath.Join(dir, "channel.json"), []byte(body), 0o644); err != nil {
		t.Fatalf("write channel.json: %v", err)
	}
	return dir
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
	dir := writeChannelDir(t, "acme")
	pointChannelDir(t, dir)
	t.Setenv(updatecheck.ChannelEnv, "")
	t.Setenv(updatecheck.EndpointEnv, "")
	if err := os.WriteFile(filepath.Join(dir, "CHANNEL"), []byte("acme\n"), 0o644); err != nil {
		t.Fatalf("write marker: %v", err)
	}

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
