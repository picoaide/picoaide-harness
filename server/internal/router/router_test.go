package router

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/brand"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
)

// buildTestRouter 用 nil DB 组装 Deps(与 main 一致); handler 只有在请求
// 真正命中该路由且查库时才需要 DB,路由声明/完整性断言不触发 DB。
func buildTestRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	Register(r, Deps{
		DB:            nil,
		Auth:          serverauth.New(nil).Handlers(),
		Admin:         (&serverauth.AdminAPI{}).Handlers(),
		Appstore:      appstore.NewHandlers(nil),
		Bootstrap:     bootstrap.NewHandlers(nil),
		Brand:         brand.NewHandlers(nil, "/tmp/nonexistent"),
		ClientRelease: clientrelease.NewHandlers(func() string { return "2.7.0" }, "official"),
		Market:        marketplace.NewHandlers(nil, "/tmp/nonexistent"),
		Agentshare:    agentshare.NewHandlers(nil, "/tmp/nonexistent"),
		Shared:        sharedskills.NewHandlers(nil, "/tmp/nonexistent"),
		Capability:    capabilities.NewHandlers(nil, "/tmp/nonexistent"),
		Connector:     connectors.NewHandlers(nil),
		Telemetry:     telemetry.NewHandlers(nil),
		Gateway:       llmgateway.NewHandlers(nil),
		Reports:       reports.NewHandlers(nil),
	})
	return r
}

// TestNamespaces 验证: 全部路由只存在于 /api/client/v2 或 /api/server 下;
// 旧命名空间(/api、/v1、/v2/api、/v2/v1)不得出现(迁移式)。
func TestNamespaces(t *testing.T) {
	r := buildTestRouter(t)
	routes := map[string]bool{}
	for _, rt := range r.Routes() {
		routes[rt.Method+" "+rt.Path] = true
	}

	const (
		nsClient = NamespaceClientV2 // /api/client/v2
		nsServer = NamespaceServer   // /api/server
	)

	checked := 0
	for key := range routes {
		method, path := splitKey(key)
		_ = method
		if isLegacyPath(path) {
			t.Fatalf("legacy namespace still present: %s", key)
		}
		if strings.HasPrefix(path, nsClient+"/") || strings.HasPrefix(path, nsServer+"/") {
			checked++
		}
	}
	if checked == 0 {
		t.Fatal("no routes under new namespaces found")
	}
	t.Logf("routes under new namespaces: %d", checked)

	// 关键路径冒烟: 各命名空间核心端点必须存在。
	for _, want := range []string{
		"POST " + nsClient + "/auth/login",
		"GET " + nsClient + "/config/bootstrap",
		"GET " + nsClient + "/brand",
		"GET " + nsClient + "/marketplace/skills",
		"GET " + nsClient + "/shared-skills",
		"GET " + nsClient + "/agent-presets",
		"GET " + nsClient + "/capabilities",
		"POST " + nsServer + "/admin/login",
		"GET " + nsServer + "/admin/auth/methods",
		"GET " + nsServer + "/admin/users",
		"GET " + nsServer + "/admin/audit",
		"PUT " + nsServer + "/admin/audit/settings",
		"GET " + nsServer + "/admin/agents",
		"POST " + nsServer + "/admin/agents",
		"GET " + nsServer + "/admin/brand",
		"GET " + nsServer + "/admin/connectors",
		// 2026-08-31: 按模型并发状态(当前/峰值/目标,扩容申请)
		"GET " + nsServer + "/admin/concurrency",
		"PUT " + nsServer + "/admin/apps/:kind/:app_id/owner",
		// DeepSeek 兼容 LLM 网关(/v1 独立命名空间 + 官方原生端点, 原样保留)
		"GET /v1/models",
		"GET /models",
		"POST /v1/chat/completions",
		"POST /chat/completions",
		"POST /v1/embeddings",
		"POST /embeddings",
		"POST /v1/messages",
		"POST /messages",
		"POST /v1/completions",
		"POST /completions",
		"POST /v1/responses",
		"POST /responses",
	} {
		if !routes[want] {
			t.Fatalf("missing route: %s", want)
		}
	}
}

// TestNamespace404 验证旧路径在新路由树上 404(迁移式), 新路径命中认证中间件
// (401)而非 404(防止 nil DB 下的 handler panic 干扰断言)。
func TestNamespace404(t *testing.T) {
	r := buildTestRouter(t)
	cases := []struct {
		legacy string
		new_   string
	}{
		{"POST /api/auth/login", "GET /api/client/v2/auth/me"},
		{"GET /api/brand", "GET /api/client/v2/config/bootstrap"},
		{"GET /v2/api/brand", "GET /api/client/v2/auth/usage"},
		{"GET /api/admin/me", "GET /api/server/admin/me"},
	}
	for _, tc := range cases {
		// 旧路径 404
		w := httptest.NewRecorder()
		m, p := splitKey(tc.legacy)
		r.ServeHTTP(w, httptest.NewRequest(m, p, nil))
		if w.Code != http.StatusNotFound {
			t.Fatalf("legacy %s = %d, want 404", tc.legacy, w.Code)
		}
		// 新路径命中认证中间件(401)而非 404 —— 证明路由已注册且 Bearer 生效。
		w2 := httptest.NewRecorder()
		m2, p2 := splitKey(tc.new_)
		r.ServeHTTP(w2, httptest.NewRequest(m2, p2, nil))
		if w2.Code == http.StatusNotFound {
			t.Fatalf("new %s = 404, want registered route", tc.new_)
		}
		if w2.Code != http.StatusUnauthorized {
			t.Fatalf("new %s = %d, want 401 (bearer middleware)", tc.new_, w2.Code)
		}
	}
}

func splitKey(key string) (method, path string) {
	parts := strings.SplitN(key, " ", 2)
	if len(parts) != 2 {
		return "", ""
	}
	return parts[0], parts[1]
}

// isLegacyPath 判定是否为旧命名空间路径(迁移式应完全移除):
// /api/、(旧)/v1/、/v2/(旧双轨)。新 /api/server、/api/client 不算旧。
func isLegacyPath(p string) bool {
	if p == "/api" || p == "/v1" {
		return true
	}
	// DeepSeek 兼容 LLM 网关 /v1/* 是保留原样的独立命名空间(2026-09 定案),
	// 不是旧管理前缀——不视为 legacy。
	if strings.HasPrefix(p, "/v1/") {
		return false
	}
	if strings.HasPrefix(p, "/v2/") {
		return true
	}
	if strings.HasPrefix(p, "/api/") &&
		!strings.HasPrefix(p, NamespaceServer+"/") &&
		!strings.HasPrefix(p, NamespaceClientV2+"/") {
		return true
	}
	return false
}

// P2-17 回归:生产路由树上 1MB 请求体上限对客户端登录与管理面登录都生效
// (此前只有测试镜像挂了这层中间件,生产可推 8MB JSON)。
func TestProductionBodyLimitRejectsOversizedJSON(t *testing.T) {
	r := buildTestRouter(t)
	huge := strings.Repeat("a", 8<<20) // 8MB body
	for _, path := range []string{
		"/api/client/v2/auth/login",
		"/api/server/admin/login",
		"/api/server/admin/login/mfa",
	} {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{"username":"`+huge+`"}`))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("%s with 8MB body = %d, want 400 (body limit)", path, w.Code)
		}
		if !strings.Contains(w.Body.String(), `"error"`) {
			t.Fatalf("%s body = %s, want JSON error envelope", path, w.Body.String())
		}
	}
	// 网关命名空间(/v1/*)自带 16MB 上限,不受 1MB 中间件影响:未认证仍是 401
	// (而不是被 1MB 中间件拦成 400)。
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"model":"x","messages":[]}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("/v1/chat/completions = %d, want 401 (bearer before body limit)", w.Code)
	}
}

// 中间件行为单测:上限内放行、超限拒绝;自带更大上限的上传路由必须豁免
// (否则外层 1MB 先触发,内层 24MB/4MB 上限失效)。
func TestBodyLimitMiddlewareBoundsAndExempts(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	g := r.Group("/api/server", bodyLimitMiddleware())
	g.POST("/admin/login", func(c *gin.Context) {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	g.POST("/admin/skills/:name/archive", func(c *gin.Context) {
		if _, err := io.ReadAll(c.Request.Body); err != nil {
			c.JSON(http.StatusRequestEntityTooLarge, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	send := func(path, body string) int {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		r.ServeHTTP(w, req)
		return w.Code
	}
	if got := send("/api/server/admin/login", `{"username":"alice"}`); got != http.StatusOK {
		t.Fatalf("small body = %d, want 200", got)
	}
	if got := send("/api/server/admin/login", strings.Repeat("a", 2<<20)); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("2MB body = %d, want 413", got)
	}
	// 归档上传豁免:2MB > 1MB 仍放行(handler 内部自限 24MB)。
	if got := send("/api/server/admin/skills/demo/archive", strings.Repeat("a", 2<<20)); got != http.StatusOK {
		t.Fatalf("archive upload 2MB = %d, want 200 (exempt from 1MB limit)", got)
	}
}

// 豁免表必须与实际自带更大上限的路由一一对应。
func TestLargeBodyRoutesExemptions(t *testing.T) {
	for _, key := range []string{
		"POST " + NamespaceServer + "/admin/skills/:name/archive",
		"POST " + NamespaceServer + "/admin/agents/:name/archive",
		"POST " + NamespaceServer + "/admin/brand/logo",
		"POST " + NamespaceClientV2 + "/shared-skills",
		"POST " + NamespaceClientV2 + "/agent-presets",
	} {
		m, p := splitKey(key)
		if !bodyLimitExempt(m, p) {
			t.Fatalf("%s must be exempt from the 1MB body limit", key)
		}
	}
	for _, key := range []string{
		"POST " + NamespaceServer + "/admin/login",
		"POST " + NamespaceClientV2 + "/auth/login",
		"PUT " + NamespaceServer + "/admin/gateway",
		"POST " + NamespaceClientV2 + "/telemetry/skill-call",
	} {
		m, p := splitKey(key)
		if bodyLimitExempt(m, p) {
			t.Fatalf("%s must NOT be exempt from the 1MB body limit", key)
		}
	}
}

// 豁免表必须对应真实注册的路由(防路径写错导致豁免失效 → 上传被 1MB 拦)。
func TestLargeBodyRoutesExist(t *testing.T) {
	r := buildTestRouter(t)
	routes := map[string]bool{}
	for _, rt := range r.Routes() {
		routes[rt.Method+" "+rt.Path] = true
	}
	for key := range largeBodyRoutes {
		if !routes[key] {
			t.Fatalf("exempt route not registered in production tree: %s", key)
		}
	}
}
