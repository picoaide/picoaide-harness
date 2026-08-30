package main

// 跨包 admin 路由完整性断言(Phase 0 RBAC fall-open 防护):
// 全部业务包的 /api/admin/* 路由都必须通过 serverauth.AdminRoute 注册并
// 声明权限点。此测试在 cmd/server 层构建完整路由树(与 main 相同注册
// 序列), 用 gin.Routes() 对照 registry 断言无遗漏。
//
// 注意: RegisterAdminRoutes 注册时不需要真实 DB(handler 闭包在请求时
// 才查库), 传 nil *sql.DB 即可构建路由树。

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
)

func buildAdminRouter(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 与 main.go 相同的 admin 路由注册序列(全部业务包)。
	serverauth.RegisterAdminRoutes(r, nil)
	llmgateway.RegisterAdminRoutes(r, nil)
	marketplace.RegisterAdminRoutes(r, nil, "/tmp/picoaide-nonexistent-cache")
	agentshare.RegisterAdminRoutes(r, nil, "/tmp/picoaide-nonexistent-cache")
	sharedskills.RegisterAdminRoutes(r, nil, "/tmp/picoaide-nonexistent-cache")
	capabilities.RegisterAdminRoutes(r, nil, "/tmp/picoaide-nonexistent-cache")
	connectors.RegisterAdminRoutes(r, nil)
	return r
}

// TestAdminRouterNoFallOpen: 每个 /api/admin/* 路由(除公开 login/methods)
// 都必须出现在 registry 中。
func TestAdminRouterNoFallOpen(t *testing.T) {
	r := buildAdminRouter(t)
	registered := map[string]bool{}
	for _, rr := range serverauth.AdminRoutePerms() {
		registered[rr.Method+" "+rr.Path] = true
	}
	public := map[string]bool{
		"POST /api/admin/login":       true,
		"GET /api/admin/auth/methods": true,
	}
	for _, rt := range r.Routes() {
		if len(rt.Path) < 11 || rt.Path[:11] != "/api/admin/" {
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
	_ = http.StatusOK
}

func TestHTMLEscapes(t *testing.T) {
	if got := htmlEscape(`<script>alert("x")</script>`); got != "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;" {
		t.Fatalf("escape = %s", got)
	}
}
