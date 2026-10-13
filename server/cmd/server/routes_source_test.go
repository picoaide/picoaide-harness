package main

// 路由装配真源守卫（2026-09-19 P0 审计）。
//
// 缺陷现场：上一个提交把生产路由装配抽成了 `registerProductionRoutes`
// （main.go，注释自称"唯一真源"），但只有 `main()` 在用它 —— 测试侧的
// `buildRouter` 仍然自己抄了一份 `router.Register` 的 Deps，并且**不传**
// Wasm，也没有 /healthz、/readyz。后果不是"少测几条"，而是
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
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/features"
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

// routePath 从 `"GET /api/client/v2/…"` 形态的路由键里取出路径部分。
func routePath(key string) string {
	if _, path, ok := strings.Cut(key, " "); ok {
		return path
	}
	return key
}

// routesUnderPrefixes 返回 keys 里路径命中 prefixes 任一条的路由键（升序）。
//
// **按路径前缀判、不看 method**：关闭态的承诺是"这一整片命名空间从路由树上消失"，
// 而越权形态恰恰爱用被漏掉的那些 method（`DELETE`/`PUT`）绕过 method 白名单式的扫描。
func routesUnderPrefixes(keys map[string]bool, prefixes []string) []string {
	var out []string
	for key := range keys {
		path := routePath(key)
		for _, prefix := range prefixes {
			if strings.HasPrefix(path, prefix) {
				out = append(out, key)
				break
			}
		}
	}
	sort.Strings(out)
	return out
}

// optionalModuleRoutePrefixes：可选模块 → 它在路由树上的**全部命名空间前缀**
// （路径前缀，覆盖所有 method）。
//
// 为什么是"登记级"而不是旧形态那 4 条子串（P1 第三片，2026-10-14 独立审计 P1-3 实测）：
// 旧形态只匹配 `GET|POST /api/client/v2/apps/wasm`、`/admin/wasm-apps`、`/marketplace/`、
// `/admin/connectors` —— 于是"在关闭态用**真** BearerAuth 注册三条技能面路由
// （未认证响应与真端点逐字同形）"实测**全绿**：它既不含 `DELETE`/`PUT` method 前缀，
// 也不含 `/skills`、`/shared-skills`、`/agent-presets`、`/capabilities` 这一整批技能面路径。
// 关闭态的承诺是"路由树上不存在"，扫描面就必须覆盖**整片命名空间与全部 method**。
//
// 这张表自己也被双向判着（不是靠注释说它对）：
//   - 键集合必须等于 `features.AllModules()`（多一个/少一个都红 —— 新增可选模块忘登记
//     ⇒ 关闭态反向断言静默漏掉一整片）；
//   - 每条前缀必须是非空 `/api/…` 形态，且不得跨模块重复（重复 ⇒ "该不该在树上"没有唯一答案）；
//   - **关闭**的模块：命中它的路由必须 0 条；**开启**的模块：必须 ≥1 条
//     （0 条说明这张表过期，或该模块的路由面真的整片没了 —— 两种都得红）。
//
// 前缀在这里是"该模块独占的命名空间"，所以**基础面（任何变体都在的路由）不得落在任何
// 前缀之下** —— 否则关闭态断言会把基础路由判成泄漏。这条不另立判据：由下面"前缀不得
// 跨模块互相遮盖"的自证 + ②③ 两个方向共同兜住（真把基础路由放进某个模块的命名空间，
// ② 会在该模块关闭的变体上当场红 —— fail-closed 的方向，不会静默）。
var optionalModuleRoutePrefixes = map[string][]string{
	// 技能面：技能商城、组织共享技能、智能体共享、能力中心、内置技能下发。
	features.ModuleSkills: {
		"/api/client/v2/agent-presets",
		"/api/client/v2/capabilities",
		"/api/client/v2/marketplace/skills",
		"/api/client/v2/shared-skills",
		"/api/client/v2/skills/builtin",
		"/api/server/admin/agent-presets",
		"/api/server/admin/agents",
		"/api/server/admin/capabilities/approvals",
		"/api/server/admin/capability-locks",
		"/api/server/admin/shared-skills",
		"/api/server/admin/skills",
	},
	// 应用面：WASM 应用平台的客户端请求入口与管理端操作面。
	features.ModuleApps: {
		"/api/client/v2/apps/wasm",
		"/api/server/admin/wasm-apps",
	},
	// 连接器面：连接器目录的管理端写面（客户端目录读面属基础面，随 bootstrap 下发）。
	features.ModuleConnectors: {
		"/api/server/admin/connectors",
	},
}

// assertOptionalModuleRouteSurface 是**每个变体都跑**的登记级双向断言：
// 关闭的模块在树上一条都不许有（全部 method），开启的模块必须至少有一条。
func assertOptionalModuleRouteSurface(t *testing.T, full map[string]bool) {
	t.Helper()
	modules := features.AllModules()

	// ① 登记表自证：扫描面与模块清单同源（键集合从 features 派生，不是第二份清单）。
	if len(optionalModuleRoutePrefixes) != len(modules) {
		t.Fatalf("optionalModuleRoutePrefixes 登记了 %d 个模块，features.AllModules() 有 %d 个 —— "+
			"新增/删除可选模块必须同步这张前缀表（它是关闭态反向断言的**全部**扫描面）",
			len(optionalModuleRoutePrefixes), len(modules))
	}
	owner := map[string]string{}
	for _, module := range modules {
		prefixes, ok := optionalModuleRoutePrefixes[module]
		if !ok {
			t.Fatalf("optionalModuleRoutePrefixes 缺少模块 %s —— 关闭态反向断言会静默漏掉它的整片路由", module)
		}
		if len(prefixes) == 0 {
			t.Fatalf("模块 %s 的前缀表是空的 —— 空扫描面等于把关闭态判据关掉", module)
		}
		for _, prefix := range prefixes {
			if !strings.HasPrefix(prefix, "/api/") {
				t.Fatalf("模块 %s 的前缀 %q 不是 `/api/…` 形态 —— 本表判的是路由路径前缀", module, prefix)
			}
			if previous, dup := owner[prefix]; dup {
				t.Fatalf("前缀 %q 同时登记在模块 %s 与 %s 名下 —— 关闭态断言会出现两种答案", prefix, previous, module)
			}
			owner[prefix] = module
		}
	}
	// 前缀跨模块不得互相遮盖（`/api/server/admin/skills` 与 `/api/server/admin/skills/builtin`
	// 同模块内重复是良性的；跨模块遮盖会让"哪个模块该在树上"出现两种答案）。
	// 这一条同时**蕴含**"同一条路由最多命中一个模块"：若两条前缀都是某条路径的前缀，
	// 短的那条必然是长的那条的前缀。
	for prefix, module := range owner {
		for other, otherModule := range owner {
			if module == otherModule || prefix == other {
				continue
			}
			if strings.HasPrefix(other, prefix) {
				t.Fatalf("前缀 %q（模块 %s）遮盖了 %q（模块 %s）—— 跨模块的命名空间必须互不相交",
					prefix, module, other, otherModule)
			}
		}
	}

	// ② 关闭的模块：树上必须**一条都没有**。
	for _, module := range modules {
		if features.Has(module) {
			continue
		}
		if leaked := routesUnderPrefixes(full, optionalModuleRoutePrefixes[module]); len(leaked) > 0 {
			t.Errorf("模块 %s 未编入本变体（features.Enabled()=%v），但它名下仍有 %d 条路由在树上：\n  %s\n"+
				"  关闭态语义 = 整片命名空间从产物里消失（编译期 no-op），不是「仍在树上但返回 404/500」；"+
				"见 docs/decisions/2026-10-14-server-build-tags.md。",
				module, features.Enabled(), len(leaked), strings.Join(leaked, "\n  "))
		}
	}

	// ③ 开启的模块：前缀必须至少命中一条 —— 否则这张表已经过期（模块改名/路由搬家），
	//    ② 会跟着退化成"永远为真"的空断言。
	for _, module := range modules {
		if !features.Has(module) {
			continue
		}
		if hit := routesUnderPrefixes(full, optionalModuleRoutePrefixes[module]); len(hit) == 0 {
			t.Errorf("模块 %s 编进了本变体，但前缀表 %v 在路由树上一条都没命中 —— "+
				"前缀表已过期（改名/搬家），或该模块的路由面整片消失了；两条都得先修这里",
				module, optionalModuleRoutePrefixes[module])
		}
	}
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

// minimalDepsTree 用"最小依赖"建树：Wasm 为 nil（= 改前测试装配
// 的真实形态），其余字段照旧。用来枚举"哪些路由是条件注册的"。
func minimalDepsTree(t *testing.T) *gin.Engine {
	t.Helper()
	deps := testProductionDeps(t, nil)
	deps.Wasm = nil
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
//
// ⚠️ 唯一判据是**本提交的** router.go：本表必须与已提交的路由逐条相等。
// 共享工作目录里别人**未提交**的新路由不要登记进来 —— 那会让"提交态"必红
// （2026-09-19 实测踩到：表里混进了其它会话工作树里的 5 条 wasm 管理路由，
// 于是干净提交上 TestRouteAssemblyGatedSlicesAreDeclared 直接失败）。
// 反过来，**你新加了一条条件注册路由就必须把它登记进来**：失败信息会逐条
// 列出"消失了却没声明"的路由，照着补一行即可。

// ⚠️ `sessionGatedRoutes` 已随 W4 删除：它登记的是"`d.WasmSession != nil` 时才注册"
// 的五条员工浏览器 HTML 面（`/login`、`/logout`、`/app-ticket`）—— 那套入口与
// session 包一起消失，`Deps` 里也不再该字段。

// TestRouteAssemblyGatedSlicesAreDeclared：条件注册的路由必须与声明表逐条相等。
func TestRouteAssemblyGatedSlicesAreDeclared(t *testing.T) {
	full := routeKeys(buildRouter(t))
	minimal := routeKeys(minimalDepsTree(t))

	// 只应有"最小树缺、完整树有"这一个方向：完整树不该多出别的差异。
	if extra := diffKeys(minimal, full); len(extra) > 0 {
		t.Fatalf("最小依赖树出现了完整树没有的路由（不应存在）：%v", extra)
	}
	gated := diffKeys(full, minimal)

	declared := make(map[string]bool, len(wasmGatedRoutes))
	for _, k := range wasmGatedRoutes {
		if declared[k] {
			t.Fatalf("声明表里重复登记：%s", k)
		}
		declared[k] = true
	}

	undeclared := diffKeys(keysToSet(gated), declared)
	stale := diffKeys(declared, keysToSet(gated))

	if len(undeclared) > 0 {
		t.Errorf("有路由因依赖为 nil 而消失却没有登记（新增了条件注册却没人更新声明表）：\n  %s\n"+
			"修法：把上面每条按原样加进 wasmGatedRoutes。", strings.Join(undeclared, "\n  "))
	}
	if len(stale) > 0 {
		t.Errorf("声明表里的路由并未消失（依赖不再影响它，或路由被删）：\n  %s\n"+
			"⚠️ 两种情形要分清：\n"+
			"  1. 本提交里这些路由真的被删/不再依赖该字段 ⇒ 从声明表里删掉；\n"+
			"  2. 共享工作目录里别人有**未提交**的 router.go 改动、而你看的是干净提交态\n"+
			"     ⇒ **不要**为了让它变绿而把「别人未提交的路由」写进本表：那会让本提交\n"+
			"     自己必红（本表只与**已提交**的 router.go 对齐），等它们被提交后再登记。",
			strings.Join(stale, "\n  "))
	}
	if len(undeclared) > 0 || len(stale) > 0 {
		t.FailNow()
	}

	t.Logf("条件注册路由共 %d 条（Wasm=%d），与声明表逐条一致",
		len(gated), len(wasmGatedRoutes))
}

// TestRouteAssemblyProbesAndHTMLFacesPresent：改前"测试树缺、生产有"的另一半。
//
// /healthz、/readyz 不在 router.Register 里（它们是 registerProductionRoutes 末尾
// 单独挂的）。这两条最容易在重构里被漏掉 —— 它们既不属于两个 API 命名空间，
// 也不在 router 包内。
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

	// 探针的失效形态（2026-09-19 实测 → 当日改为 fail-fast）：productionDeps.Ready
	// 为 nil 时 /readyz 曾**仍然注册**（gin.WrapH(nil) 在注册期不 panic），每个请求
	// panic → Recovery → 500 INTERNAL —— 路由表上完全看不出来。现在
	// registerProductionRoutes 在装配期直接 panic（见 TestReadyDepMissingFailsFast），
	// 不再有"看起来正常、探针一直红"的形态。
	// 仍有**接线断言**兜"字段漏填"（见下一条用例），但它只能发现"没写这个字段"，
	// 发现不了"传了一个必崩的值" —— 值层面的判据在下一条用例里。
}

// TestRouteAssemblyHasExactlyOneEntryPoint：全仓只允许一个装配入口。
//
// 运行期守卫能发现"两棵树不一致"，但发现不了"两处都抄成一样"。这条静态断言把
// 入口本身钉死：生产侧 router.Register 只能出现在 registerProductionRoutes 体内
// （main() 里出现第二个调用点 = 又一片路由游离在真源之外）；测试侧**零个**
// （测试必须走生产函数，不许自建）。
//
// ⚠️ 能力边界（2026-09-19 第四轮审计逐条实测，不夸大）：判据是**字面文本**
// `router.Register` + `(`（本文件里一律这样拼接书写 —— 见下方"会误报"一条），因此
//   - 可被绕过：别名导入（`rt.Register(`）、取函数值（`f := router.Register`）
//     都能编译出第二棵装配树而这里看不见 —— 它拦的是"顺手再抄一份 Deps"，
//     不是蓄意规避；
//   - 会误报：注释或字符串里出现该字面量也算命中（代价可接受：本包的注释里
//     刻意写成 "router.Register" + "(" 拼接，正是为了不自己举报自己）；
//   - 范围：只扫生产文件（`_test.go` 一律不看）+ `cmd/`、`internal/`；
//     `testdata/`、`node_modules/`、点目录与 `temp/` 被跳过 —— 前几类 Go 工具链
//     自己就忽略，`server/temp/` 虽会被 `go list ./...` 编译但它是 gitignored 的
//     探针区（进不了发布面）。别的包的 `_test.go` 自建最小树是不可避免的
//     （够不到 main 包函数），它们由运行期守卫负责。
func TestRouteAssemblyHasExactlyOneEntryPoint(t *testing.T) {
	// ---- 生产侧：整个服务端源码树（cmd/ + internal/ …），非测试文件 ----
	//
	// 扫描面在 2026-09-19 第三轮审计后从"本包 *.go"扩到**整个 server 树**：
	// 旧实现的注释写着"全仓"，实际只 Glob 了 cmd/server 一个目录 ——
	// internal/ 下若有人再抄一份 router.Register 的 Deps（生产或测试），
	// 这条守卫根本看不见（实测 internal/reports 的测试里就有一处自建装配）。
	prodRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatalf("解析服务端源码根: %v", err)
	}
	prodFiles, err := collectGoFiles(prodRoot)
	if err != nil {
		t.Fatalf("列举服务端源码树: %v", err)
	}
	// 字面量拼接：本文件自己也不能出现该调用形态（否则这条守卫会举报自己）。
	const marker = "router.Register" + "("
	prodHits := 0
	prodFile := ""
	for _, f := range prodFiles {
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
			if rel, rerr := filepath.Rel(prodRoot, f); rerr == nil {
				prodFile = filepath.ToSlash(rel)
			}
		}
	}
	if prodHits != 1 {
		t.Fatalf("生产代码(server 树内非测试文件)里 %q 出现 %d 次，必须恰好 1 次（唯一真源）", marker, prodHits)
	}
	if prodFile != "cmd/server/main.go" {
		t.Fatalf("router.Register 出现在 %s，预期只在 cmd/server/main.go 的 registerProductionRoutes 体内", prodFile)
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

	// ---- 测试侧：本包的测试文件都不得自建路由树 ----
	//
	// 范围**只到 cmd/server 这一个包**（不夸大）：本包能直接调
	// registerProductionRoutes，所以"自建装配"在这里没有任何正当理由。
	// 别的包（例：internal/reports 的凭据读侧用例）**够不到**这个 main 包里的
	// 函数，它们为本地断言自建一棵最小树是不可避免的 —— 那些树的漂移由
	// 运行期守卫（测试树 vs 生产装配树）与各自用例负责，不由这条静态断言负责。
	localTests, err := filepath.Glob("*_test.go")
	if err != nil {
		t.Fatalf("列举本包测试文件: %v", err)
	}
	for _, f := range localTests {
		src, err := os.ReadFile(f)
		if err != nil {
			t.Fatalf("读 %s: %v", f, err)
		}
		if strings.Contains(string(src), marker) {
			t.Errorf("%s 里出现了 %q：本包测试必须经 registerProductionRoutes 建树"+
				"（自建装配正是「测试树少一整片」的成因）", f, marker)
		}
	}
}

// collectGoFiles 递归收集 root 下的 .go 文件（返回**绝对**路径，便于调用方
// 直接 os.ReadFile，不受测试 cwd 影响）。
//
// 跳过：testdata/、node_modules/、以 . 开头的目录、以及 temp/（那是探针与
// 一次性脚本的地盘，不属于生产源码面）。
func collectGoFiles(root string) ([]string, error) {
	base, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	var out []string
	err = filepath.WalkDir(base, func(path string, d fs.DirEntry, werr error) error {
		if werr != nil {
			return werr
		}
		if d.IsDir() {
			name := d.Name()
			if path != base && (name == "testdata" || name == "node_modules" || name == "temp" || strings.HasPrefix(name, ".")) {
				return fs.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") {
			return nil
		}
		out = append(out, path)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// TestProductionAssemblyPassesEveryDep：main() 的 productionDeps 字面量必须把
// **每一个**字段都传上。
//
// 为什么需要它：运行期守卫证明的是"给定同一组依赖，测试树 == 生产函数输出"，
// 它管不到 main() 自己漏填依赖 —— 而那正是本次 P0 的成因（旧 buildRouter 漏传
// Wasm）。生产侧漏填一整片路由的失败形态是静默的（没有编译错误、
// 路由表少几条、日志里没有一行）。
//
// 2026-09-23 审计 T-01/T-02 把它从「源码文本 strings.Contains」升级为
// 「AST 解析 + reflect 派生字段清单」：
//   - 旧判据下，把 main.go 的 `Wasm: wasmPlat.API,` **整行注释掉**，8 条路由守卫
//     全部 PASS（生产静默丢 39 条路由）；`Wasm: nil,` 同样通过（文本里仍有
//     "Wasm:"）；
//   - 字段清单是**手写的 9 个名字**（而日志写着"10 个"）—— 给 productionDeps
//     加第 10 个字段并漏传，也没有任何判据会红。
//
// 现在：字段清单由 `reflect` 从结构体派生（新增字段自动进入判据），字面量由
// `go/parser` 解析成 key → 表达式（注释/字符串不再算数），并逐字段拒绝 nil/空字面量。
//
// ⚠️ 能力边界（不夸大）：值层面的判据只覆盖"一眼可判的零值形态"（`nil`、`""`），
// 语义级判据（例如 `Wasm: maybeNil()`）与 Ready 传了必崩 handler 这类形态，靠
// TestProductionDepsNilGatesDeclaredSlices 与 TestReadyDepMissingFailsFast。
func TestProductionAssemblyPassesEveryDep(t *testing.T) {
	fields := productionDepsFieldNames(t)
	assigned := mainProductionDepsLiteral(t)

	// 方向 1：结构体的每个字段都必须在字面量里被赋值（注释掉 = 不在 AST 里 = 红）。
	var missing []string
	for _, name := range fields {
		if _, ok := assigned[name]; !ok {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		t.Errorf("main() 的 productionDeps 漏传 %s —— 依赖漏填会让对应路由整片消失"+
			"（或探针注册了却必崩），且在路由表上完全看不出来。\n"+
			"⚠️ 判据解析的是 AST：把该行**注释掉**与**删掉**在这里是同一件事。",
			strings.Join(missing, ", "))
	}

	// 方向 2：字面量里的键必须是结构体字段（改名/拼错当场红）。
	for _, name := range fields {
		_ = assigned[name]
	}
	var unknown []string
	for name := range assigned {
		known := false
		for _, field := range fields {
			if field == name {
				known = true
				break
			}
		}
		if !known {
			unknown = append(unknown, name)
		}
	}
	if len(unknown) > 0 {
		sort.Strings(unknown)
		t.Errorf("main() 的 productionDeps 字面量里有 productionDeps 结构体不存在的字段：%s"+
			"（拼错字段名在当前判据下不再是静默的）", strings.Join(unknown, ", "))
	}

	// 方向 3：值不得是零值形态（T-01 的第二个变体 `Wasm: nil,`：文本里仍有 "Wasm:"，
	// 旧判据照绿，而 registerWasm 首行 `if d.Wasm == nil { return }` 会整片跳过）。
	for _, name := range fields {
		expr, ok := assigned[name]
		if !ok {
			continue
		}
		if nilValueExpression(expr) {
			t.Errorf("main() 的 productionDeps.%s 被赋成零值表达式（%s）—— 与漏传等价："+
				"nil 依赖会让对应路由整片消失（registerWasm 静默 return），空字符串会让"+
				"依赖该取值的装配面静默退化", name, expressionText(expr))
		}
	}
	t.Logf("生产装配调用点已传入全部 %d 个依赖字段（字段清单由 reflect 从结构体派生）", len(fields))
}

// TestProductionDepsNilGatesDeclaredSlices：**逐字段置零实跑路由树**（运行期事实）。
//
// 为什么需要它：AST 判据能发现"字段没写/写了 nil"，但"这个字段到底管不管路由"只有
// 跑一遍才知道 —— 而 main() 漏填的后果恰恰是"运行期整片路由消失"。
// 这里对 productionDeps 的**每个**字段（清单由 reflect 派生）构造一份"只有该字段为
// 零值"的依赖并实跑 registerProductionRoutes，断言：
//   - 消失的路由集合与声明表（wasmGatedRoutes）**逐条相等** —— 新增一片条件注册
//     而没人更新声明表 ⇒ 红；声明了却不再消失 ⇒ 反方向也红；
//   - 置零会丢路由的字段，在 main() 的字面量里必须是**非零值表达式**
//     （把上面那条 AST 判据绑到"运行期证明它有后果"上）；
//   - 置零即**装配期 fail-loud**（panic）的字段，必须登记进
//     productionDepsFailFastFields —— fail-loud 是可接受的失效形态（比静默丢路由
//     好），但同样不许是"没人知道"的隐式行为；
//   - 其余字段置零不得让任何路由消失（新增条件注册必须显式登记）；
//   - **关闭态的整片命名空间不得在树上**（`assertOptionalModuleRouteSurface`，登记级、
//     覆盖全部 method、每个变体都跑）—— 这一条与 productionDeps 无关，是本用例里
//     唯一直接判"关闭态承诺"的断言，见它的注释与
//     `internal/router/optional_*_off_registration_test.go` 的位置级判据。
func TestProductionDepsNilGatesDeclaredSlices(t *testing.T) {
	full := routeKeys(productionReferenceTree(t))
	fields := productionDepsFieldNames(t)
	gatingFields := map[string]map[string]bool{}
	failFastSeen := map[string]bool{}

	for _, name := range fields {
		gated, panicMsg := treeWithZeroedField(t, name)
		if panicMsg != "" {
			reason, declaredFailFast := productionDepsFailFastFields[name]
			if !declaredFailFast {
				t.Errorf("productionDeps.%s 置零后装配期 panic（%s）—— 请把它登记进 "+
					"productionDepsFailFastFields：fail-loud 可接受，但不许是没人知道的隐式行为",
					name, panicMsg)
				continue
			}
			failFastSeen[name] = true
			if name == "Ready" && !strings.Contains(panicMsg, "Ready") {
				t.Errorf("Ready 的 fail-fast 消息必须点名 Ready，实得 panic=%q", panicMsg)
			}
			t.Logf("productionDeps.%s 置零 ⇒ 装配期 fail-loud（%s）", name, reason)
			continue
		}
		disappeared := diffKeys(full, gated)
		if len(disappeared) == 0 {
			continue
		}
		gatingFields[name] = keysToSet(disappeared)
	}

	// 登记表不得留死条目：写了"某字段 fail-loud"但它其实不 panic（会被下面
	// gating/静默分支抓到，这里再对一次，避免登记表本身变成装饰）。
	for name, reason := range productionDepsFailFastFields {
		if !failFastSeen[name] {
			t.Errorf("productionDepsFailFastFields 登记了 %s（%s），但该字段置零后并没有 fail-loud "+
				"—— 失效形态变了，请更新登记", name, reason)
		}
	}

	// 关闭态的"路由树上不存在"承诺：**登记级双向断言，每个变体都跑**（P1 第三片，
	// 2026-10-14）。它不再依附于下面那条"本变体没有运行期 nil 门"的分支 —— 旧形态把
	// 反向断言塞在 `len(features.Enabled()) == 0` 里，于是
	//   ① 只有"全关"那一个变体真的扫过树，
	//   ② 扫的还是 4 条子串（漏 method、漏整批技能面路径）。
	// 两者叠加的实测后果：在关闭态注册三条技能面路由、判据全绿。
	assertOptionalModuleRouteSurface(t, full)

	// 变体自证（P1 第二片 2026-10-14；P1 第三片同日按"哪些模块有运行期 nil 门"重写）：
	// 本变体里**没有任何"由 productionDeps 字段在运行期门控"的可选模块**编进来时，
	// 字段置零当然不会让路由消失 —— 这是关闭态的正确形态（没有可选路由可丢），
	// 不是判据空转。
	//
	// 哪两个模块有运行期 nil 门：apps ⇒ `productionDeps.Wasm`（`registerWasm` 的
	// `d.Wasm == nil` 守卫）；skills ⇒ `productionDeps.SkillSeed`。**connectors 没有**
	// —— 它的 handler 在 `cmd/server/optional_connectors_on.go` 里由 `d.DB` 现造
	// （`applyConnectorDeps`），既不占 productionDeps 字段、也就没有可门控面。
	//
	// 旧形态的条件是 `len(features.Enabled()) == 0`，于是 `-tags=connectors` 这条
	// **合法变体**自己红在下面那句 Fatal 上（"没有任何字段置零会让路由消失"），
	// 而变体矩阵又恰好漏了它 ⇒ 这条红在任何入口都不会出现。见
	// server/scripts/check-go-build-tags.mjs 的 COMBOS（现已从
	// `channelFeaturesVariant` 的取值域穷尽派生）。
	if !features.HasApps() && !features.HasSkills() {
		if len(wasmGatedRoutes) != 0 {
			t.Fatalf("apps 未编入本变体，但 wasmGatedRoutes 登记了 %d 条 —— 关闭态的声明表必须为空",
				len(wasmGatedRoutes))
		}
		// 自证的反方向：条件放宽了，就必须证明"放宽"没有盖住真存在的门 ——
		// 万一有人给 connectors 补上 productionDeps 字段并据此条件注册路由，
		// 这里会红，而不是让这条分支继续替它兜着。
		if len(gatingFields) != 0 {
			names := make([]string, 0, len(gatingFields))
			for name := range gatingFields {
				names = append(names, name)
			}
			sort.Strings(names)
			t.Fatalf("本变体（features.Enabled()=%v）没有 apps/skills，却仍有 %d 个 productionDeps 字段"+
				"置零会让路由消失（%s）—— 说明新增了运行期 nil 门；请把对应模块加进这条自证分支的条件，"+
				"别让这条分支继续替它兜着", features.Enabled(), len(gatingFields), strings.Join(names, "、"))
		}
		t.Logf("本变体（features.Enabled()=%v）里没有由 productionDeps 字段运行期门控的可选模块："+
			"没有可选路由可被 nil 依赖门控（判据按变体自证）", features.Enabled())
		return
	}

	if len(gatingFields) == 0 {
		t.Fatal("没有任何字段置零会让路由消失 —— 判据空转（productionReferenceTree 或 productionDeps 已变）")
	}
	if features.HasApps() {
		wasmGated, hasWasm := gatingFields["Wasm"]
		if !hasWasm {
			t.Fatalf("productionDeps.Wasm 置零后没有路由消失（registerWasm 的 `d.Wasm == nil` 守卫变了？）")
		}
		declared := make(map[string]bool, len(wasmGatedRoutes))
		for _, key := range wasmGatedRoutes {
			declared[key] = true
		}
		if undeclared := diffKeys(wasmGated, declared); len(undeclared) > 0 {
			t.Errorf("d.Wasm == nil 时有路由消失却没有登记（新增条件注册却没人更新声明表）：\n  %s",
				strings.Join(undeclared, "\n  "))
		}
		if stale := diffKeys(declared, wasmGated); len(stale) > 0 {
			t.Errorf("声明表里的路由在 d.Wasm == nil 时并未消失（路由被删/不再条件注册）：\n  %s",
				strings.Join(stale, "\n  "))
		}
	} else if len(wasmGatedRoutes) != 0 {
		t.Fatalf("apps 未编入本变体，但 wasmGatedRoutes 登记了 %d 条 —— 关闭态的声明表必须为空", len(wasmGatedRoutes))
	}

	// 把"运行期证明会丢路由的字段"绑回 main() 的字面量：漏填/写 nil 都是真事故。
	assigned := mainProductionDepsLiteral(t)
	for name := range gatingFields {
		expr, ok := assigned[name]
		if !ok {
			t.Errorf("运行期证明 productionDeps.%s 置零会丢 %d 条路由，而 main() 的字面量里没有这个字段",
				name, len(gatingFields[name]))
			continue
		}
		if nilValueExpression(expr) {
			t.Errorf("运行期证明 productionDeps.%s 置零会丢 %d 条路由，而 main() 把它赋成了零值表达式（%s）",
				name, len(gatingFields[name]), expressionText(expr))
		}
	}
	t.Logf("逐字段置零实测：%d 个字段会条件注册路由（Wasm=%d 条），与声明表一致",
		len(gatingFields), len(gatingFields["Wasm"]))
}

// productionDepsFailFastFields：置零即**装配期 panic** 的字段（fail-loud，可接受，
// 但必须显式登记 —— 这份表由 TestProductionDepsNilGatesDeclaredSlices 双向对着
// 运行期事实校验：登记了却不 panic、或 panic 了却没登记，都红）。
//
// 与 wasmGatedRoutes 的区别：那些字段置零会**静默**丢路由（最危险的形态），
// 这些字段置零会当场炸掉装配（安全但需要人知道）。
var productionDepsFailFastFields = map[string]string{
	// gin.WrapH(nil) 注册期不 panic ⇒ 曾经表现为"每个 /readyz 请求 500"。
	"Ready": "装配期 panic 且点名 Ready（见 TestReadyDepMissingFailsFast）",
	// Auth / Admin 是两套 handler 集合，服务端路由注册期就会解引用它们。
	"Auth":  "装配期 panic（nil handler 集合在路由注册期被解引用）",
	"Admin": "装配期 panic（同上）",
}

// productionDepsFieldNames 返回 productionDeps 的字段名（**从结构体派生**）。
//
// T-02 实测：旧判据手写 9 个名字、日志却写"10 个"，给结构体加第 10 个字段并漏传时
// 全部守卫照绿 —— 手写清单会与结构体脱钩。reflect 派生后，新增字段自动进入判据。
func productionDepsFieldNames(t *testing.T) []string {
	t.Helper()
	typ := reflect.TypeOf(productionDeps{})
	if typ.Kind() != reflect.Struct {
		t.Fatalf("productionDeps 不是结构体（%s）", typ.Kind())
	}
	names := make([]string, 0, typ.NumField())
	for i := 0; i < typ.NumField(); i++ {
		names = append(names, typ.Field(i).Name)
	}
	return names
}

// mainProductionDepsLiteral 解析 main.go 里 `registerProductionRoutes(r, productionDeps{…})`
// 的复合字面量，返回 字段名 → 右侧表达式。
//
// 用 go/parser 而不是 strings.Contains：注释、字符串与其它函数体里的同名键都不再算数
// （T-01 的绕过形态就是一行 `// Wasm: wasmPlat.API,`）。
func mainProductionDepsLiteral(t *testing.T) map[string]ast.Expr {
	t.Helper()
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "main.go", nil, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 main.go: %v", err)
	}
	var literal *ast.CompositeLit
	ast.Inspect(file, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok || len(call.Args) != 2 {
			return true
		}
		ident, ok := call.Fun.(*ast.Ident)
		if !ok || ident.Name != "registerProductionRoutes" {
			return true
		}
		composite, ok := call.Args[1].(*ast.CompositeLit)
		if !ok {
			t.Fatalf("registerProductionRoutes 的第二个实参不是复合字面量（main.go:%d）",
				fset.Position(call.Pos()).Line)
		}
		literal = composite
		return false
	})
	if literal == nil {
		t.Fatal("main.go 里找不到 `registerProductionRoutes(…, productionDeps{…})` 调用点")
	}
	assigned := make(map[string]ast.Expr, len(literal.Elts))
	for index, elt := range literal.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			t.Fatalf("productionDeps 字面量第 %d 个元素不是 `字段: 值` 形态（位置 %s）——"+
				"位置形态无法与结构体字段对齐，判据会失去意义",
				index, fset.Position(elt.Pos()))
		}
		key, ok := kv.Key.(*ast.Ident)
		if !ok {
			t.Fatalf("productionDeps 字面量的键不是标识符（位置 %s）", fset.Position(kv.Key.Pos()))
		}
		if _, duplicate := assigned[key.Name]; duplicate {
			t.Fatalf("productionDeps 字面量里字段 %s 被赋值两次", key.Name)
		}
		assigned[key.Name] = kv.Value
	}
	return assigned
}

// nilValueExpression 判断表达式是否是"一眼可判的零值形态"：`nil`、`(nil)`、`""`。
// 只覆盖源码文本层面的形态；语义级判据（`Wasm: maybeNil()`）由运行期用例负责。
func nilValueExpression(expr ast.Expr) bool {
	switch node := expr.(type) {
	case *ast.Ident:
		return node.Name == "nil"
	case *ast.ParenExpr:
		return nilValueExpression(node.X)
	case *ast.BasicLit:
		return node.Kind == token.STRING && strings.Trim(node.Value, "`\"") == ""
	}
	return false
}

// expressionText 把表达式还原成源码片段（失败信息用）。
func expressionText(expr ast.Expr) string {
	var b strings.Builder
	if err := format.Node(&b, token.NewFileSet(), expr); err != nil {
		return "<无法格式化>"
	}
	return b.String()
}

// treeWithZeroedField 用"只有 name 字段为零值"的依赖实跑 registerProductionRoutes，
// 返回路由集合；装配期 panic 时返回 panic 文本（路由集合为 nil）。
func treeWithZeroedField(t *testing.T, name string) (map[string]bool, string) {
	t.Helper()
	deps := testProductionDeps(t, nil)
	value := reflect.ValueOf(&deps).Elem()
	field := value.FieldByName(name)
	if !field.IsValid() {
		t.Fatalf("productionDeps 没有字段 %s", name)
	}
	field.Set(reflect.Zero(field.Type()))

	gin.SetMode(gin.TestMode)
	r := newEngine()
	installAPIMiddleware(r)
	var panicMsg string
	func() {
		defer func() {
			if rec := recover(); rec != nil {
				panicMsg = fmt.Sprint(rec)
			}
		}()
		registerProductionRoutes(r, deps)
	}()
	if panicMsg != "" {
		return nil, panicMsg
	}
	return routeKeys(r), ""
}

// TestReadyDepMissingFailsFast：Ready 漏填必须在**装配期**炸掉，而不是变成
// "每个 /readyz 请求 500"。
//
// 为什么单独一条：Ready 是唯一"nil 也照注册"的依赖（`gin.WrapH(nil)` 注册期不
// panic）。改前的实测形态是路由表里有 GET /readyz、启动日志正常、`--version`
// 正常，只有运维发现健康检查一直红 —— 属于"静默降级成 500"的装配错误。
// 本用例把判据钉在"装配期 panic 且消息点名 Ready"上：若哪天有人把 fail-fast
// 删掉（回到运行期 500），这里必红。
func TestReadyDepMissingFailsFast(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer func() {
		rec := recover()
		if rec == nil {
			t.Fatal("Ready 为 nil 时装配没有 fail-fast —— /readyz 会注册成功并在每个请求上 panic→500，" +
				"路由表与启动日志都看不出异常")
		}
		msg := fmt.Sprint(rec)
		if !strings.Contains(msg, "Ready") {
			t.Fatalf("装配期 panic 的消息没有点名 Ready（运维拿不到可行动的线索）: %s", msg)
		}
		t.Logf("Ready 漏填在装配期 fail-fast: %s", msg)
	}()
	// 只传 nil Ready：守卫必须在读其它依赖之前就炸（其它字段留零值，正说明这一点）。
	registerProductionRoutes(newEngine(), productionDeps{})
	t.Fatal("registerProductionRoutes 未 panic")
}
