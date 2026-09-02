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
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/brand"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	"github.com/picoaide/picoaide/webadmin"
)

// buildRouter 用与 main 相同的 Deps 组装完整路由树(nil DB)。
func buildRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	router.Register(r, router.Deps{
		DB:         nil,
		Auth:       serverauth.New(nil).Handlers(),
		Admin:      (&serverauth.AdminAPI{}).Handlers(),
		Appstore:   appstore.NewHandlers(nil),
		Bootstrap:  bootstrap.NewHandlers(nil),
		Brand:      brand.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Market:     marketplace.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Agentshare: agentshare.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Shared:     sharedskills.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Capability: capabilities.NewHandlers(nil, "/tmp/picoaide-nonexistent-cache"),
		Connector:  connectors.NewHandlers(nil),
		Telemetry:  telemetry.NewHandlers(nil),
		Gateway:    llmgateway.NewHandlers(nil),
		Reports:    reports.NewHandlers(nil),
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
		mountAPIGuards(panicRouter, nil, fileServer, dist)
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
		DB:         db,
		Auth:       authCfg.API.Handlers(),
		Admin:      (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:   appstore.NewHandlers(db),
		Bootstrap:  bootstrap.NewHandlers(db),
		Brand:      brand.NewHandlers(db, t.TempDir()),
		Market:     marketplace.NewHandlers(db, t.TempDir()),
		Agentshare: agentshare.NewHandlers(db, t.TempDir()),
		Shared:     sharedskills.NewHandlers(db, t.TempDir()),
		Capability: capabilities.NewHandlers(db, t.TempDir()),
		Connector:  connectors.NewHandlers(db),
		Telemetry:  telemetry.NewHandlers(db),
		Gateway:    llmgateway.NewHandlers(db),
		Reports:    reports.NewHandlers(db),
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
