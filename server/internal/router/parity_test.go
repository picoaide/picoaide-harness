package router

import (
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
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
)

// adminRouteSet 枚举 engine 中 /api/server/admin 命名空间下的 (method, path)。
func adminRouteSet(e *gin.Engine) map[string]bool {
	out := map[string]bool{}
	for _, r := range e.Routes() {
		if strings.HasPrefix(r.Path, NamespaceServer+"/admin") {
			out[r.Method+" "+r.Path] = true
		}
	}
	return out
}

// TestAdminRouteMirrorIsSubsetOfProduction 防止"双份真源"漂移(审计复核遗留项):
// 各业务包的 RegisterAdminRoutes 是测试自建路由树用的镜像,生产真源是
// internal/router。最危险的漂移方向是**镜像里有、生产没挂** —— 管理端功能
// 在测试里全绿、线上却 404。本测试要求镜像集合是生产集合的子集,并在日志
// 中列出生产独有路由(即当前测试镜像覆盖不到、只能靠生产冒烟/契约测试覆盖的部分)。
func TestAdminRouteMirrorIsSubsetOfProduction(t *testing.T) {
	gin.SetMode(gin.TestMode)

	prod := gin.New()
	Register(prod, Deps{
		Auth:          serverauth.New(nil).Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: nil}).Handlers(),
		Appstore:      appstore.NewHandlers(nil),
		Bootstrap:     bootstrap.NewHandlers(nil),
		ClientRelease: clientrelease.NewHandlers(func() string { return "test" }, "official"),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(nil),
		Market:        marketplace.NewHandlers(nil, t.TempDir()),
		Agentshare:    agentshare.NewHandlers(nil, t.TempDir()),
		Shared:        sharedskills.NewHandlers(nil, t.TempDir()),
		Capability:    capabilities.NewHandlers(nil, t.TempDir()),
		Connector:     connectors.NewHandlers(nil),
		Telemetry:     telemetry.NewHandlers(nil),
		Gateway:       llmgateway.NewHandlers(nil),
		Reports:       reports.NewHandlers(nil),
	})

	mirror := gin.New()
	serverauth.RegisterAdminRoutes(mirror, nil)
	agentshare.RegisterAdminRoutes(mirror, nil, t.TempDir())
	connectors.RegisterAdminRoutes(mirror, nil)
	marketplace.RegisterAdminRoutes(mirror, nil, t.TempDir())
	capabilities.RegisterAdminRoutes(mirror, nil, t.TempDir())
	llmgateway.RegisterAdminRoutes(mirror, nil)
	sharedskills.RegisterAdminRoutes(mirror, nil, t.TempDir())

	prodSet := adminRouteSet(prod)
	mirrorSet := adminRouteSet(mirror)
	if len(mirrorSet) == 0 {
		t.Fatal("mirror registered no admin routes (refactor broke the test mirrors)")
	}
	var mirrorOnly []string
	for route := range mirrorSet {
		if !prodSet[route] {
			mirrorOnly = append(mirrorOnly, route)
		}
	}
	if len(mirrorOnly) > 0 {
		t.Fatalf("test mirrors register routes missing from production router (%d):\n  %s",
			len(mirrorOnly), strings.Join(mirrorOnly, "\n  "))
	}
	var prodOnly []string
	for route := range prodSet {
		if !mirrorSet[route] {
			prodOnly = append(prodOnly, route)
		}
	}
	t.Logf("production admin routes=%d, mirror routes=%d, production-only (no test mirror) = %d",
		len(prodSet), len(mirrorSet), len(prodOnly))
	if len(prodOnly) > 0 {
		// 信息性输出:这些路由没有镜像注册函数(reports/appstore 等),
		// 只能依靠 router 冒烟测试/客户端契约测试覆盖。
		t.Logf("production-only routes:\n  %s", strings.Join(prodOnly, "\n  "))
	}
}
