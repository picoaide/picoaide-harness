package main

// 路由装配真源守卫（2026-09-19 P0 审计）。
//
// 缺陷现场：上一个提交把生产路由装配抽成了 `registerProductionRoutes`
// （main.go，注释自称"唯一真源"），但只有 `main()` 在用它 —— 测试侧的
// `buildRouter` 仍然自己抄了一份 `router.Register` 的 Deps，并且**不传**
// Wasm / WasmSession，也没有 /healthz、/readyz。后果不是"少测几条"，而是
// 测试树比生产树少**一整片**（33 条 WASM 应用平台 + 员工登录 HTML 面 +
// 2 条探针），而"路由完整性"断言照样全绿。
//
// 本文件的三条守卫覆盖三种不同的漂移方式：
//
//	1. 装配漂移：测试树必须与"真实调用生产函数"得到的树**逐条相等**
//	   （数据来自 registerProductionRoutes 的运行时输出，不抄任何路由表）；
//	2. 依赖漂移：哪几条路由会因为某个依赖为 nil 而整片消失，必须**声明式**列清
//	   （新增一片"条件注册"却没人更新声明 ⇒ 红）；
//	3. 入口漂移：全仓只能有一个装配入口（生产侧唯一 router.Register 调用点、
//	   测试侧零个）—— 有人再抄一份 Deps 就会当场报出文件名。
//
// 三条都必须在"改回缺陷实现"时变红，变异验证见各自的注释。

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// routeKeys 提取一棵路由树的 (method, path) 集合。
func routeKeys(r *gin.Engine) map[string]bool {
	out := make(map[string]bool, len(r.Routes()))
	for _, rt := range r.Routes() {
		out[rt.Method+" "+rt.Path] = true
	}
	return out
}

// diffKeys 返回 a 有 b 没有的键。
func diffKeys(a, b map[string]bool) []string {
	var out []string
	for k := range a {
		if !b[k] {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

// keysToSet 把切片转成集合（声明表 ↔ 运行时集合互转）。
func keysToSet(keys []string) map[string]bool {
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out
}

// productionReferenceTree 独立调用**生产装配函数**构造参考树。
//
// 刻意不复用 buildRouter：守卫的价值全在"两条路径各自独立"——
// 若 buildRouter 退回自建装配，这里仍按生产函数建树，差集立刻现形。
func productionReferenceTree(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := newEngine()
	installAPIMiddleware(r)
	registerProductionRoutes(r, testProductionDeps(t, nil))
	return r
}

// minimalDepsTree 用"最小依赖"建树：Wasm / WasmSession 为 nil（= 改前测试装配
// 的真实形态），其余字段照旧。用来枚举"哪些路由是条件注册的"。
func minimalDepsTree(t *testing.T) *gin.Engine {
	t.Helper()
	deps := testProductionDeps(t, nil)
	deps.Wasm = nil
	deps.WasmSession = nil
	gin.SetMode(gin.TestMode)
	r := newEngine()
	installAPIMiddleware(r)
	registerProductionRoutes(r, deps)
	return r
}

// TestRouteAssemblyMatchesProductionSource：测试树 == 生产装配树（防漂移主守卫）。
//
// 判据：两条路径各自调用 registerProductionRoutes（同一份测试依赖构造函数），
// 路由集合必须逐条相等。任何一边退回自建装配 / 漏传依赖，差集非空即失败，
// 失败信息逐条打印 method+path 与方向（生产有测试缺 / 测试有生产缺）。
//
// 变异验证：把 buildRouter 改回旧的 `router.Register` 自建装配（手抄一份 Deps）
// ⇒ 本用例必红，差集恰为 35 条（33 条 WASM/登录面 + /healthz + /readyz）。
func TestRouteAssemblyMatchesProductionSource(t *testing.T) {
	testTree := routeKeys(buildRouter(t))
	prodTree := routeKeys(productionReferenceTree(t))

	prodOnly := diffKeys(prodTree, testTree)
	testOnly := diffKeys(testTree, prodTree)
	if len(prodOnly) == 0 && len(testOnly) == 0 {
		t.Logf("路由装配真源一致：%d 条路由（测试树 == registerProductionRoutes 输出）", len(testTree))
		return
	}

	var b strings.Builder
	fmt.Fprintf(&b, "测试路由树与生产装配(fn registerProductionRoutes)不一致：测试树 %d 条 / 生产树 %d 条。\n",
		len(testTree), len(prodTree))
	if len(prodOnly) > 0 {
		fmt.Fprintf(&b, "生产有、测试缺（%d 条）—— 这些路由从未进测试视野：\n", len(prodOnly))
		for _, k := range prodOnly {
			fmt.Fprintf(&b, "  + %s\n", k)
		}
	}
	if len(testOnly) > 0 {
		fmt.Fprintf(&b, "测试有、生产没有（%d 条）—— 测试树里有生产不存在的路由：\n", len(testOnly))
		for _, k := range testOnly {
			fmt.Fprintf(&b, "  - %s\n", k)
		}
	}
	t.Fatal(b.String())
}

// 条件注册声明表：某个依赖为 nil 时**整片**消失的路由。
//
// 这张表是"曾经发生过的静默漏测"的永久固化：改前测试树少的正是这 33 条。
// 它同时是双向断言 —— 声明了却没消失（注册不再依赖该字段）、或消失了却没声明
// （新增一片条件注册）都会红，逼着改动者把"哪片路由会被依赖漏掉"写清楚。

// wasmGatedRoutes：d.Wasm == nil 时整片消失（internal/router/registerWasm 的首行）。
var wasmGatedRoutes = []string{
	// 客户端面 /api/client/v2/apps/wasm（BearerAuth）
	"POST /api/client/v2/apps/wasm/validate",
	"POST /api/client/v2/apps/wasm/:app_id/releases",
	"POST /api/client/v2/apps/wasm/:app_id/publish",
	"POST /api/client/v2/apps/wasm/:app_id/unpublish",
	"POST /api/client/v2/apps/wasm/:app_id/freeze",
	"GET /api/client/v2/apps/wasm/:app_id/export",
	"DELETE /api/client/v2/apps/wasm/:app_id",
	"GET /api/client/v2/apps/wasm/:app_id/diagnostics",
	"GET /api/client/v2/apps/wasm/:app_id/schema",
	"GET /api/client/v2/apps/wasm/catalog",
	// 分片上传（§4.2）
	"POST /api/client/v2/apps/wasm/uploads",
	"PUT /api/client/v2/apps/wasm/uploads/:upload_id/chunks/:index",
	"GET /api/client/v2/apps/wasm/uploads/:upload_id",
	"POST /api/client/v2/apps/wasm/uploads/:upload_id/complete",
	"DELETE /api/client/v2/apps/wasm/uploads/:upload_id",
	// 管理面 /api/server/admin/wasm-apps（AdminRoute + RBAC 申报）
	"GET /api/server/admin/wasm-apps",
	"POST /api/server/admin/wasm-apps/:app_id/unpublish",
	"POST /api/server/admin/wasm-apps/:app_id/publish",
	"PUT /api/server/admin/wasm-apps/:app_id/owner",
	"POST /api/server/admin/wasm-apps/:app_id/freeze",
	"PUT /api/server/admin/wasm-apps/review",
	"GET /api/server/admin/wasm-apps/:app_id/releases",
	"POST /api/server/admin/wasm-apps/:app_id/releases/:version/approve",
	"POST /api/server/admin/wasm-apps/:app_id/releases/:version/reject",
	"GET /api/server/admin/wasm-apps/domain",
	"PUT /api/server/admin/wasm-apps/domain",
	"GET /api/server/admin/wasm-apps/limits",
	"PUT /api/server/admin/wasm-apps/limits",
}

// sessionGatedRoutes：d.WasmSession == nil 时消失（router.Register 的
// `if deps.WasmSession != nil`）—— 员工浏览器登录/换票 HTML 面。
var sessionGatedRoutes = []string{
	"GET /login",
	"POST /login",
	"POST /logout",
	"GET /app-ticket",
	"POST /app-ticket",
}

// TestRouteAssemblyGatedSlicesAreDeclared：条件注册的路由必须与声明表逐条相等。
func TestRouteAssemblyGatedSlicesAreDeclared(t *testing.T) {
	full := routeKeys(buildRouter(t))
	minimal := routeKeys(minimalDepsTree(t))

	// 只应有"最小树缺、完整树有"这一个方向：完整树不该多出别的差异。
	if extra := diffKeys(minimal, full); len(extra) > 0 {
		t.Fatalf("最小依赖树出现了完整树没有的路由（不应存在）：%v", extra)
	}
	gated := diffKeys(full, minimal)

	declared := make(map[string]bool, len(wasmGatedRoutes)+len(sessionGatedRoutes))
	for _, k := range wasmGatedRoutes {
		if declared[k] {
			t.Fatalf("声明表里重复登记：%s", k)
		}
		declared[k] = true
	}
	for _, k := range sessionGatedRoutes {
		if declared[k] {
			t.Fatalf("声明表里重复登记：%s", k)
		}
		declared[k] = true
	}

	undeclared := diffKeys(keysToSet(gated), declared)
	stale := diffKeys(declared, keysToSet(gated))

	if len(undeclared) > 0 {
		t.Errorf("有路由因依赖为 nil 而消失却没有登记（新增了条件注册却没人更新声明表）：\n  %s",
			strings.Join(undeclared, "\n  "))
	}
	if len(stale) > 0 {
		t.Errorf("声明表里的路由并未消失（依赖不再影响它，或路由被删）：\n  %s",
			strings.Join(stale, "\n  "))
	}
	if len(undeclared) > 0 || len(stale) > 0 {
		t.FailNow()
	}

	t.Logf("条件注册路由共 %d 条（Wasm=%d / WasmSession=%d），与声明表逐条一致",
		len(gated), len(wasmGatedRoutes), len(sessionGatedRoutes))
}

// TestRouteAssemblyProbesAndHTMLFacesPresent：改前"测试树缺、生产有"的另一半。
//
// /healthz、/readyz 不在 router.Register 里（它们是 registerProductionRoutes 末尾
// 单独挂的），因此"改前测试树少 35 条"里有 2 条是它们，另外 5 条是员工登录 HTML 面
// （/login、/logout、/app-ticket）。这 7 条最容易在重构里被漏掉——它们既不属于
// 两个 API 命名空间，也不在 router 包内。
func TestRouteAssemblyProbesAndHTMLFacesPresent(t *testing.T) {
	r := buildRouter(t)
	present := routeKeys(r)
	for _, want := range []string{
		"GET /healthz",
		"GET /readyz",
	} {
		if !present[want] {
			t.Errorf("测试路由树缺少探针 %s（registerProductionRoutes 末尾单独注册，重构时最易漏）", want)
		}
	}
	for _, want := range sessionGatedRoutes {
		if !present[want] {
			t.Errorf("测试路由树缺少员工 HTML 面 %s（WasmSession 为 nil 时整片消失）", want)
		}
	}

	// 探针的"注册了但请求必崩"形态（实测 2026-09-19）：productionDeps.Ready 为 nil
	// 时 /readyz **仍然注册**（gin.WrapH(nil) 在注册期不 panic），但每个请求都会
	// panic → Recovery → 500 INTERNAL。与 Wasm/WasmSession 的"整片不注册"不同，
	// 这种漏填在路由表上完全看不出来。因此装配侧要有**接线断言**（见下一条用例），
	// 而不是靠"路径在不在"判断探针可用性。
}

// TestRouteAssemblyHasExactlyOneEntryPoint：全仓只允许一个装配入口。
//
// 运行期守卫能发现"两棵树不一致"，但发现不了"两处都抄成一样"。这条静态断言把
// 入口本身钉死：生产侧 router.Register 只能出现在 registerProductionRoutes 体内
// （main() 里出现第二个调用点 = 又一片路由游离在真源之外）；测试侧**零个**
// （测试必须走生产函数，不许自建）。
func TestRouteAssemblyHasExactlyOneEntryPoint(t *testing.T) {
	// ---- 生产侧：main.go / wasmapp.go 等非测试文件 ----
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("列举包内文件: %v", err)
	}
	// 字面量拼接：本文件自己也不能出现该调用形态（否则这条守卫会举报自己）。
	const marker = "router.Register" + "("
	prodHits := 0
	prodFile := ""
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("读 %s: %v", f, err)
		}
		n := strings.Count(string(src), marker)
		prodHits += n
		if n > 0 {
			prodFile = f
		}
	}
	if prodHits != 1 {
		t.Fatalf("生产代码里 %q 出现 %d 次，必须恰好 1 次（唯一真源）", marker, prodHits)
	}
	if prodFile != "main.go" {
		t.Fatalf("router.Register 出现在 %s，预期在 main.go 的 registerProductionRoutes 体内", prodFile)
	}
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("读 main.go: %v", err)
	}
	lines := strings.Split(string(src), "\n")
	registerAt, entryAt := -1, -1
	for i, ln := range lines {
		if strings.HasPrefix(ln, "func registerProductionRoutes(") {
			entryAt = i
		}
		if strings.Contains(ln, marker) {
			registerAt = i
		}
	}
	if entryAt < 0 {
		t.Fatal("main.go 里找不到 registerProductionRoutes 的函数体")
	}
	if registerAt < entryAt {
		t.Fatalf("main.go:%d 的 router.Register 出现在 registerProductionRoutes（: %d）之前："+
			"那片路由游离在唯一真源之外", registerAt+1, entryAt+1)
	}

	// ---- 测试侧：任何测试文件都不得自建路由树 ----
	for _, f := range files {
		if !strings.HasSuffix(f, "_test.go") {
			continue
		}
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("读 %s: %v", f, err)
		}
		if strings.Contains(string(src), marker) {
			t.Errorf("%s 里出现了 %q：测试必须经 registerProductionRoutes 建树"+
				"（自建装配正是「测试树少一整片」的成因）", f, marker)
		}
	}
}

// TestProductionAssemblyPassesEveryDep：main() 的 productionDeps 字面量必须把
// **每一个**字段都传上。
//
// 为什么需要它：运行期守卫证明的是"给定同一组依赖，测试树 == 生产函数输出"，
// 它管不到 main() 自己漏填依赖 —— 而那正是本次 P0 的成因（旧 buildRouter 漏传
// Wasm / WasmSession）。生产侧漏填一整片路由的失败形态是静默的（没有编译错误、
// 路由表少几条、日志里没有一行）。
//
// ⚠️ 能力边界（不夸大）：这是**源码文本**断言 —— 它能发现"字段没传"，
// 不能发现"传错了值"（例如 Ready 传了一个必崩的 handler）。值层面的判据靠
// 装配级行为用例（如 TestUploadCleanupSchedulerIsWired、本文件上一条注释里的
// nil-Ready 实测事实）。
func TestProductionAssemblyPassesEveryDep(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("读 main.go: %v", err)
	}
	text := string(src)
	const call = "registerProductionRoutes(r, productionDeps{"
	start := strings.Index(text, call)
	if start < 0 {
		t.Fatalf("main.go 里找不到 %q 调用点", call)
	}
	rest := text[start+len(call):]
	// 取到该字面量的结尾（生产调用点是一段连续的 productionDeps{...} 字面量）。
	end := strings.Index(rest, "})")
	if end < 0 {
		t.Fatal("main.go 的 productionDeps 字面量没有闭合")
	}
	literal := rest[:end]

	// 字段清单来自 productionDeps 的结构体定义（新增字段会被强制登记）。
	for _, field := range []string{
		"DB:", "Auth:", "Admin:", "Wasm:", "WasmSession:", "Ready:",
		"SkillSeed:", "DataDir:", "Version:", "ChannelID:",
	} {
		if !strings.Contains(literal, field) {
			t.Errorf("main() 的 productionDeps 漏传 %s —— 依赖漏填会让对应路由整片消失"+
				"（或探针注册了却必崩），且在路由表上完全看不出来", field)
		}
	}
	t.Logf("生产装配调用点已传入全部 %d 个依赖字段", 10)
}
