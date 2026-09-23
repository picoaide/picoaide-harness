package router

import (
	"sort"
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

// adminRouteSet 枚举 engine 中**管理面命名空间**（/api/server）下的 (method, path)。
//
// R4-C-2（审计 2026-09-23，P2）：前缀从 `NamespaceServer+"/admin"` 放宽到整个命名空间
// ——旧前缀会把 `/api/server/ops/x` 挡在扫描面之外（生产独有 ⇒ 只 t.Logf ⇒ 两条守卫
// 全绿）。命名空间成员判定用 serverauth.InServerNamespace（与 fall-open 守卫同一实现，
// 不允许两侧各写一份前缀）。
func adminRouteSet(e *gin.Engine) map[string]bool {
	out := map[string]bool{}
	for _, r := range e.Routes() {
		if serverauth.InServerNamespace(r.Path) {
			out[r.Method+" "+r.Path] = true
		}
	}
	return out
}

// productionOnlyAdminRoutes 登记**生产路由表里有、测试镜像没有**的管理面路由。
//
// R4-C-2 修法 2：`prodOnly` 从"信息性 t.Logf"升为 **fail-loud + 逐条登记**。理由：
// 镜像（各业务包的 RegisterAdminRoutes）只覆盖一部分管理面，其余（appstore/reports/
// portal/skillseed 等）没有镜像注册函数 —— 这个差距本身是事实，但不该是**静默**的事实：
// 新增一条没有镜像的管理面路由时没人会去看日志，于是"镜像对拍"给人一种全覆盖的错觉。
// 登记表把差距变成**逐条申报**：新出现的生产独有路由不登记即红；登记了却不再独有
// （改名/被镜像覆盖/删除）也红（陈旧条目同样会假装有守卫）。
//
// 键 = "METHOD /api/server/…"；值 = 为什么这条路由没有镜像（该业务包只提供 Handlers
// 供给面 / 镜像只覆盖了该组的一部分）。
var productionOnlyAdminRoutes = map[string]string{
	"GET " + NamespaceServer + "/admin/providers/:id/balance":          "上游余额查询：llmgateway 镜像只覆盖 CRUD 组的一部分",
	"GET " + NamespaceServer + "/admin/concurrency":                    "按模型并发状态：同一镜像组之外的只读端点",
	"GET " + NamespaceServer + "/admin/users/:id/balance/ledger":       "余额流水对账：serverauth 镜像不建 AdminAuth 组",
	"PUT " + NamespaceServer + "/admin/apps/:kind/:app_id/owner":       "归属转移：appstore 只有 Handlers（无镜像函数）",
	"GET " + NamespaceServer + "/admin/skills/builtin":                 "平台内置技能只读面：skillseed 只有 Handlers",
	"GET " + NamespaceServer + "/admin/portal":                         "门户配置读：portal 只有 Handlers",
	"PUT " + NamespaceServer + "/admin/portal":                         "门户配置写（同上）",
	"GET " + NamespaceServer + "/admin/report-subscriptions":           "报表订阅：reports 只有 Handlers",
	"POST " + NamespaceServer + "/admin/report-subscriptions":          "报表订阅（同上）",
	"PUT " + NamespaceServer + "/admin/report-subscriptions/:id":       "报表订阅（同上）",
	"DELETE " + NamespaceServer + "/admin/report-subscriptions/:id":    "报表订阅（同上）",
	"POST " + NamespaceServer + "/admin/report-subscriptions/:id/test": "报表订阅（同上）",
}

// productionOnlyReasonFor 返回该生产独有路由的登记理由；未登记返回 ok=false（判红）。
func productionOnlyReasonFor(route string) (string, bool) {
	reason, ok := productionOnlyAdminRoutes[route]
	return reason, ok
}

// productionTestDeps 是 router 包内测试用的生产装配依赖（nil DB + 临时缓存目录）。
// 抽成一处，让下面几条"生产路由表 ↔ 业务包清单"的对拍用例共用同一份装配。
func productionTestDeps(t *testing.T) Deps {
	t.Helper()
	return Deps{
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
	}
}

// productionRoutesUnder 枚举**生产路由表**里某个路径前缀下的 "METHOD /path" 集合。
func productionRoutesUnder(t *testing.T, prefix string) []string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	prod := gin.New()
	Register(prod, productionTestDeps(t))
	out := []string{}
	for _, rt := range prod.Routes() {
		if strings.HasPrefix(rt.Path, prefix) {
			out = append(out, rt.Method+" "+rt.Path)
		}
	}
	return out
}

// TestProductionAgentRoutesMatchMarketplacePolicy 把**生产路由表**里
// `/api/server/admin/agents*` 的路由集合与 `marketplace` 的渠道口径清单对拍
// （独立复审 F1，2026-09-23）。
//
// 为什么必须在 router 包做这一条：A-8 的完整性守门
// （`marketplace.TestAgentAdminRoutesAreMarketOnlyOrRegistered`）枚举的是
// `marketplace.RegisterAdminRoutes` 建出的**测试镜像树**，而 server/AGENTS.md §7.0
// 规定"所有路由集中声明在 internal/router" —— 也就是说**新增路由的自然落点正是那个
// 不受守门保护的文件**。实测（复审 MG1）：只在 `router.go` 里加一条未登记路由
// `GET /agents/:name/audit-probe` 时，包内守门绿、本文件的「镜像 ⊆ 生产」子集断言绿
// （它只判一个方向）、`cmd/server` 的三条装配/扫描断言也绿，而该路由在生产树上**真实
// 可达**（返回 handler 的"智能体不存在"而非 NoRoute 的"接口不存在"）。所以
// "两条守卫组合即等价"不成立；把生产树本身纳入对拍面才能闭合。
//
// 判据的形状：**双向集合相等**（不是条数断言）⇒ 新增路由自动被覆盖；新增者必须在
// `marketplace/channel.go` 的 `marketAgentRoutePolicy` 里选口径（加守卫 / 登记为
// 跨渠道并写依据），否则这里红。
//
// 变异验证（MG1）：在 `internal/router/router.go` 的 agents 段加一条未登记
// AdminRoute ⇒ 本用例红，而包内守门与「镜像 ⊆ 生产」保持绿。
func TestProductionAgentRoutesMatchMarketplacePolicy(t *testing.T) {
	const prefix = NamespaceServer + "/admin/agents"
	routes := productionRoutesUnder(t, prefix)
	if len(routes) == 0 {
		t.Fatalf("生产路由表里没有 %s* 路由（枚举方式坏了，判据失效）", prefix)
	}
	if violations := marketplace.MarketAgentRouteViolations(routes); len(violations) > 0 {
		t.Fatalf("生产路由表与 marketplace 的渠道口径清单不一致（%d 条）：\n  %s\n"+
			"⇒ 新增/改名 agents 路由必须同步 internal/marketplace/channel.go 的 marketAgentRoutePolicy",
			len(violations), strings.Join(violations, "\n  "))
	}
	t.Logf("生产树 %s* 路由 %d 条，全部登记渠道口径", prefix, len(routes))
}

// TestMarketplaceAgentRoutePolicyJudgementHasTeeth 是上一条判据的**自带变异证明**：
// 在同一份生产路由集合上做两次注入，`MarketAgentRouteViolations` 必须变红。
//
// 为什么要它：跨包对拍的"绿"有一种假绿形态 —— 判据恒真（例如清单被清空、
// 前缀写错、集合永远是空）。这里用生产树自己的路由集合当基准，注入"多一条未登记"
// 与"少一条已登记"两种形态，把判据的判别力钉在同一个用例里（不依赖人工变异）。
//
// ① 多一条：复审 MG1 的形态（生产树里加一条路由，清单没跟上）；
// ② 少一条：清单陈旧（守卫类路由被删/改名，清单没跟上）。
func TestMarketplaceAgentRoutePolicyJudgementHasTeeth(t *testing.T) {
	const prefix = NamespaceServer + "/admin/agents"
	routes := productionRoutesUnder(t, prefix)
	if len(routes) == 0 {
		t.Fatalf("生产路由表里没有 %s* 路由（枚举方式坏了，判据失效）", prefix)
	}
	if violations := marketplace.MarketAgentRouteViolations(routes); len(violations) > 0 {
		t.Fatalf("前置不成立：未注入时生产树就已经有违规，本用例无法证明判别力：\n  %s",
			strings.Join(violations, "\n  "))
	}
	contains := func(violations []string, needle string) bool {
		for _, v := range violations {
			if strings.Contains(v, needle) {
				return true
			}
		}
		return false
	}

	// ① 多一条未登记路由。
	extra := "GET " + prefix + "/:name/audit-probe"
	injected := append(append([]string{}, routes...), extra)
	if violations := marketplace.MarketAgentRouteViolations(injected); !contains(violations, extra) {
		t.Fatalf("判据没有咬住「生产树多一条未登记路由」（复审 MG1 的形态）—— 违规=%v", violations)
	}

	// ② 清单里登记的守卫类路由在生产树上消失。
	const removed = "GET " + prefix + "/:name/preview"
	filtered := make([]string, 0, len(routes))
	for _, route := range routes {
		if route != removed {
			filtered = append(filtered, route)
		}
	}
	if violations := marketplace.MarketAgentRouteViolations(filtered); !contains(violations, removed) {
		t.Fatalf("判据没有咬住「清单登记了但运行时没有」（陈旧条目）—— 违规=%v", violations)
	}
}

// TestAdminRouteMirrorIsSubsetOfProduction 防止"双份真源"漂移(审计复核遗留项):
// 各业务包的 RegisterAdminRoutes 是测试自建路由树用的镜像,生产真源是
// internal/router。最危险的漂移方向是**镜像里有、生产没挂** —— 管理端功能
// 在测试里全绿、线上却 404。本测试要求镜像集合是生产集合的子集,并在日志
// 中列出生产独有路由(即当前测试镜像覆盖不到、只能靠生产冒烟/契约测试覆盖的部分)。
func TestAdminRouteMirrorIsSubsetOfProduction(t *testing.T) {
	gin.SetMode(gin.TestMode)

	prod := gin.New()
	Register(prod, productionTestDeps(t))

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
	// 生产独有（没有镜像注册函数）的路由：**必须逐条登记理由**（R4-C-2 修法 2）。
	// 旧实现只 t.Logf ⇒ 新增一条没有镜像的管理面路由时没有任何红灯。
	prodOnly := map[string]bool{}
	for route := range prodSet {
		if !mirrorSet[route] {
			prodOnly[route] = true
		}
	}
	var unregistered, stale []string
	for route := range prodOnly {
		if reason, ok := productionOnlyReasonFor(route); !ok || strings.TrimSpace(reason) == "" {
			unregistered = append(unregistered, route)
		}
	}
	for route := range productionOnlyAdminRoutes {
		if !prodOnly[route] {
			stale = append(stale, route)
		}
	}
	if len(unregistered) > 0 {
		sort.Strings(unregistered)
		t.Fatalf("生产路由表里有 %d 条管理面路由没有测试镜像、也未登记理由：\n  %s\n"+
			"⇒ 在 parity_test.go 的 productionOnlyAdminRoutes 里登记（写明为什么没有镜像），"+
			"或为该业务包补一个 RegisterAdminRoutes 镜像",
			len(unregistered), strings.Join(unregistered, "\n  "))
	}
	if len(stale) > 0 {
		sort.Strings(stale)
		t.Fatalf("productionOnlyAdminRoutes 里有 %d 条已经不是「生产独有」（改名/删除/已被镜像覆盖）：\n  %s\n"+
			"⇒ 清理登记表（陈旧条目会让这条守卫看起来在保护什么东西）",
			len(stale), strings.Join(stale, "\n  "))
	}
	t.Logf("production admin routes=%d, mirror routes=%d, production-only (登记)=%d",
		len(prodSet), len(mirrorSet), len(prodOnly))
}
