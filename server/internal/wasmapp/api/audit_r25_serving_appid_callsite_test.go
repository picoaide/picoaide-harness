package api

// audit_r25_serving_appid_callsite_test.go —— 第二十五轮审计 Y3-1（P1）的
// **调用点级**判据；第二十七轮 FIX-34 第 2 条把它的**取值域**从"两个方法名字面量"
// 扩到"**任何**触达写侧校验入口的方法"。
//
// 缺陷形态（Y3 实测）：主控的修复把"服务侧不得套用写侧路由保留字"只接到了
// `appserver/serve.go:59` 一个调用点，而客户端面/管理面还有 7 处 handler 仍走写侧
// `h.validateAppID` ⇒ 存量应用（名字 ∈ 路由静态段，例如 `open` / `rows` / `releases`）
// 在 open/request/proof/ownedApp/admin/opens 上被 400 INVALID_APP_ID 拒掉，而同一条
// 链上的 serveApp 放行。
//
// 既有的 `registry` 包判据（TestR24X4ServeSideDoesNotApplyRouteStaticReserved）只钉
// **两个函数的语义**，不钉任何调用点 ⇒ 把 `serve.go` 或 api 层任一处改回写侧变体，
// 包级测试**全绿**（Y3 实跑证明）。
//
// ## 为什么取值域是"可达闭包"而不是"调用了某两个名字"（第二十七轮 FIX-34 第 2 条）
//
// 第一版判据把面钉在 `h.validateAppID` / `h.validateAppIDServing` 两个**字面量**上：
// 只有"方法体内直接出现这两个名字"才算命中。于是**第四种形态**——服务侧 handler 改调
// 写侧**入口** `h.validateRawAppID`（`validateAppID` 的唯一上游）——全绿不红：判据既
// 看不见 `validateRawAppID → validateAppID` 这条链，也看不见"经包内辅助方法间接抵达"
// （`adminDiagnostics → loadAdminApp → validateAppIDServing`）。这与本仓第二十六轮的
// 教训同形：**判据的取值域必须等于被守护方的真实解析面**。
//
// 现在的取值域 = 包内调用图上的**可达闭包**：
//
//	写侧入口   = {h.validateAppID, h.validateRawAppID}   ← "这个名字将进入库"
//	服务侧入口 = {h.validateAppIDServing}                ← "库里可能已经有这一行"
//
// 一个节点只要**能抵达**某个入口（直接调用、经包内方法转发、经包级函数或任意层包装）
// 就落进对应闭包。契约不认名字、只认"触没触达"：
//
//	A. 服务侧闭包必须**恰好**等于 servingAppIDCallers（登记了却不可达 / 可达却没登记
//	   都红）—— 新增服务侧 handler 换任何写法（调写侧入口、包一层 helper、另起名字）
//	   都会落进写侧闭包而没登记 ⇒ 当场红；
//	B. 写侧闭包必须**恰好**等于 writeSideAppIDCallers（同双向口径）；
//	C. 两个闭包**不得相交**（同一入口两套判据混用 = 语义不明；要例外必须显式登记）；
//	D. 两个转发方法各自只能转发到**对应**的 registry 变体，且 registry 直连不得出现在
//	   别处（多一个直连点 = 多一个判据看不见的分叉）。
//
// 为什么不写成"读源码字符串 contains"：那样钉的是文本而不是解析结果，把调用挪进
// 死代码分支、或用别名/包装转发都会让断言失去判别力（本仓已登记同类假绿形态）；
// "只钉两个方法名字面量"同样属于这一类。这里用 go/ast 解析**真实调用表达式**建图，
// 并在**两个方向**上收口。
//
// 建图的命名空间（避免"方法名与包级函数名同名"把两条链静默合并 —— 本包真实存在
// `h.currentVersionOf` 与包级 `currentVersionOf` 这一对，第一版"按裸名字建图"的实现
// 一跑就撞上）：
//
//	Handlers 方法 → `h.<name>`；包级函数 → `<name>`；其它接收者 → `<recv>.<name>`
//
// 边：`h.foo(…)`（接收者标识符来自声明）→ `h.foo`；`foo(…)` → 包级 `foo`；`X.foo(…)`
// 在 `foo` 只有一种含义时指向它，两种含义都存在且接收者名不匹配时**两条边都记**
// （保守近似：多记边只会让闭包更大，"可达却没登记"这一侧因此是 fail-closed 的）。

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// appIDWriteSideEntries 是写侧闸门的**入口节点**："这个名字将进入库"。
//
//   - `h.validateRawAppID`：发布链路与标识查重共用的原值校验；
//   - `h.validateAppID`：registry 写侧规则（`validateRawAppID` 的唯一上游，也是判据的
//     第二颗种子 —— 少了它，"绕过 validateRawAppID 直连写侧规则"就成了盲区）。
//
// 分片上传建立会话（upload.Store.Create）在 upload 包里直连 registry，不在本包。
var appIDWriteSideEntries = []string{"h.validateAppID", "h.validateRawAppID"}

// appIDServingEntries 是服务侧校验的**唯一入口节点**："库里可能已经有这一行"。
var appIDServingEntries = []string{"h.validateAppIDServing"}

// servingAppIDCallers 是**能抵达服务侧入口**的全部节点（反向可达闭包，含入口自身）。
//
// 每一行都写明它**怎么**抵达 —— 闭包是"可达"，不是"直呼"：新增服务侧 handler 只要
// 经这些辅助方法（`adminApp` / `loadAdminApp` / `ownedApp` / `reviewRelease`）装载
// app，就自动落进闭包；反过来，任何落在闭包外的新节点都会被 A 断言点名。
var servingAppIDCallers = []string{
	"h.validateAppIDServing", // 入口自身（registry.ValidateAppIDForServing 的唯一转发点）
	// —— 直接调用入口（7 个入口 handler，Y3-1 点名的那批）——
	"h.openApp",         // POST /apps/wasm/:app_id/open
	"h.clientRequest",   // POST /apps/wasm/:app_id/request
	"h.appProofIssue",   // POST /apps/wasm/proof（body 里的 app_id）
	"h.ownedApp",        // 作者面共用装载器（read.go/release.go/rows.go 都经它）
	"h.loadAdminApp",    // 管理面共用装载器
	"h.adminAppOpens",   // GET /api/server/admin/wasm-apps/:app_id/opens
	"h.adminAppAIUsage", // GET /api/server/admin/wasm-apps/:app_id/ai-usage
	// —— 经 h.loadAdminApp ——
	"h.adminApp",         // 管理面 app 装载包装（`h.loadAdminApp(c, appID, false)`）
	"h.adminDiagnostics", // 经 adminApp→loadAdminApp 或直接 loadAdminApp(allowDeleted)
	// —— 经 h.adminApp（→ loadAdminApp）——
	"h.adminReleases",
	"h.reviewRelease",
	"h.adminUnpublish",
	"h.adminPublish",
	"h.adminTransferOwner",
	"h.adminFreeze",
	"h.adminRows",
	"h.adminSchema",
	// —— 经 h.reviewRelease ——
	"h.adminApproveRelease",
	"h.adminRejectRelease",
	// —— 经 h.ownedApp ——
	"h.diagnostics",
	"h.schema",
	"h.myReleases",
	"h.export",
	"h.setPublished",
	"h.freeze",
	"h.deleteApp",
	"h.rows",
}

// writeSideAppIDCallers 是**能抵达写侧入口**的全部节点（反向可达闭包，含入口自身）。
var writeSideAppIDCallers = []string{
	"h.validateAppID",    // 入口自身（registry 写侧规则）
	"h.validateRawAppID", // 入口自身（原值校验；`validateAppID` 的唯一上游）
	"h.creationAppID",    // 创建路径的 app_id 解析（handlers.go:662 → validateRawAppID）
	"h.availability",     // 标识查重（read.go:523 → validateRawAppID）
	"h.validate",         // 发布预检（publish.go:548 → creationAppID）
	"h.publish",          // 发布（publish.go:724 → creationAppID）
}

// appIDCallSites 是解析结果：包内调用图 + registry 直连点。
type appIDCallSites struct {
	// nodes 是全部被解析到的节点 id。
	nodes map[string]bool
	// calls 记录每个节点体里调用了哪些包内节点。
	calls map[string]map[string]bool
	// registryByNode 记录每个节点体里直连的 `registry.<name>(…)`。
	registryByNode map[string]map[string]bool
	// parsed 是解析到的非测试文件数（0 ⇒ 判据失去对象）。
	parsed int
	// ambiguous 记录"同名两种含义都记了边"的调用点（保守近似透明化，测试里打印）。
	ambiguous []string
}

// parseAppIDCallSites 解析本包（不含测试文件）的全部方法体与包级函数体。
func parseAppIDCallSites(t *testing.T) appIDCallSites {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录失败: %v", err)
	}
	out := appIDCallSites{
		nodes:          map[string]bool{},
		calls:          map[string]map[string]bool{},
		registryByNode: map[string]map[string]bool{},
	}
	type decl struct {
		fn   *ast.FuncDecl
		node string
		recv string // 接收者标识符名（`h`），包级函数为 ""
	}
	decls := make([]decl, 0, 160)
	// 第一遍：登记全部节点（两个命名空间分开，重名不合并）。
	for _, en := range entries {
		name := en.Name()
		if en.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if perr != nil {
			t.Fatalf("解析 %s 失败: %v", name, perr)
		}
		out.parsed++
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil || fn.Name == nil {
				continue
			}
			space, recv := "", ""
			if fn.Recv != nil && len(fn.Recv.List) > 0 {
				recv = receiverName(fn)
				typ := receiverType(fn)
				space = typ + "."
				if typ == "Handlers" {
					space = "h."
				}
			}
			node := space + fn.Name.Name
			out.nodes[node] = true
			decls = append(decls, decl{fn: fn, node: node, recv: recv})
		}
	}
	if out.parsed == 0 {
		t.Fatal("一个非测试 .go 文件都没解析到 —— 判据失去对象（工作目录不对？）")
	}
	// 第二遍：建边。
	for _, d := range decls {
		called := map[string]bool{}
		registry := map[string]bool{}
		ast.Inspect(d.fn.Body, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			switch fun := call.Fun.(type) {
			case *ast.Ident:
				// 包级函数直呼（`helper(…)`）：只可能落在包级命名空间。
				if out.nodes[fun.Name] {
					called[fun.Name] = true
				}
			case *ast.SelectorExpr:
				qualifier, ok := fun.X.(*ast.Ident)
				if !ok {
					return true
				}
				// registry 直连（`registry.ValidateAppID(…)`）单独记一份：它只允许
				// 出现在两个转发方法里。
				if qualifier.Name == "registry" {
					registry[fun.Sel.Name] = true
					return true
				}
				// `X.<method>(…)`：判据看的是"触没触达那个方法"，不是"接收者必须叫 h"
				// —— 换接收者名、经形参转发（`func helper(h *Handlers) { h.x(…) }`）
				// 都必须落在同一张图里，否则就是下一个人绕过去的缺口。
				method, fnName := "h."+fun.Sel.Name, fun.Sel.Name
				switch {
				case d.recv != "" && qualifier.Name == d.recv && out.nodes[method]:
					// 接收者自己（最精确）：`h.foo` 只可能是方法。
					called[method] = true
				case out.nodes[method] && out.nodes[fnName]:
					// 方法名与包级函数名撞车且接收者名不匹配：两条边都记（保守）。
					called[method] = true
					called[fnName] = true
					out.ambiguous = append(out.ambiguous, d.node+" → "+method+"|"+fnName)
				case out.nodes[method]:
					called[method] = true
				case out.nodes[fnName]:
					called[fnName] = true
				}
			}
			return true
		})
		if len(called) > 0 {
			out.calls[d.node] = called
		}
		if len(registry) > 0 {
			out.registryByNode[d.node] = registry
		}
	}
	return out
}

// receiverName 返回方法的接收者标识符名（`func (h *Handlers) x()` → "h"）。
func receiverName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	for _, name := range fn.Recv.List[0].Names {
		if name != nil {
			return name.Name
		}
	}
	return ""
}

// receiverType 返回方法的接收者类型名（`*Handlers` → "Handlers"），包级函数返回 ""。
func receiverType(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	switch t := fn.Recv.List[0].Type.(type) {
	case *ast.StarExpr:
		if id, ok := t.X.(*ast.Ident); ok {
			return id.Name
		}
	case *ast.Ident:
		return t.Name
	}
	return "?"
}

// reaching 返回**能抵达** seeds 中任一节点的全部节点（反向可达，含 seeds 自身）。
//
// 方向很关键：要的是"谁触达了校验入口"（调用者的闭包），不是"入口还能调用谁"。
// 实现 = 在调用图上做反向 BFS（caller 索引）。
func (cs appIDCallSites) reaching(seeds []string) map[string]bool {
	// 反向边：callee → 调用它的节点。
	callers := map[string][]string{}
	for node, callees := range cs.calls {
		for callee := range callees {
			callers[callee] = append(callers[callee], node)
		}
	}
	seen := map[string]bool{}
	queue := append([]string{}, seeds...)
	for len(queue) > 0 {
		node := queue[0]
		queue = queue[1:]
		if seen[node] {
			continue
		}
		seen[node] = true
		for _, caller := range callers[node] {
			if !seen[caller] {
				queue = append(queue, caller)
			}
		}
	}
	return seen
}

// assertRegistryMatches 是双向完整性断言（登记了却不可达 / 可达却没登记都红）。
func assertRegistryMatches(t *testing.T, label string, got map[string]bool, declared []string, hint string) {
	t.Helper()
	want := map[string]bool{}
	for _, name := range declared {
		want[name] = true
	}
	for _, name := range sortedKeys(got) {
		if !want[name] {
			t.Errorf("%s：节点 %s 能触达该侧的 app_id 校验入口，但不在清单里。%s",
				label, name, hint)
		}
	}
	for _, name := range declared {
		if !got[name] {
			t.Errorf("%s：清单里登记了 %s，但它在本包里触达不到该侧入口（方法被删/被改名/"+
				"调用被挪走）—— 清单是判据的契约面，必须与实现同步", label, name)
		}
	}
}

// TestAuditR25ServingAppIDCallSitesAreBoundToServing 是 A + B + C。
func TestAuditR25ServingAppIDCallSitesAreBoundToServing(t *testing.T) {
	cs := parseAppIDCallSites(t)

	// 自校准：两颗种子与两份清单里的名字必须真的存在（改名/删除 ⇒ 判据失去对象，
	// 必须当场红并要求同步清单，而不是静默变成空转）。
	calibration := append(append(append([]string{},
		appIDWriteSideEntries...), appIDServingEntries...),
		append(append([]string{}, writeSideAppIDCallers...), servingAppIDCallers...)...)
	for _, name := range calibration {
		if !cs.nodes[name] {
			t.Fatalf("本包里找不到节点 %q —— 判据清单与实现脱节（改名的同时必须更新本文件的"+
				"入口/清单，否则这条判据会静默空转）", name)
		}
	}

	writeReach := cs.reaching(appIDWriteSideEntries)
	servingReach := cs.reaching(appIDServingEntries)
	t.Logf("servingReach=%v", sortedKeys(servingReach))
	t.Logf("writeReach=%v", sortedKeys(writeReach))
	t.Logf("ambiguous=%v", cs.ambiguous)

	// 防假绿：两侧都必须真的解析出东西来。
	if len(writeReach) < len(appIDWriteSideEntries) {
		t.Fatalf("写侧闭包异常小（%v）—— 图没建起来", sortedKeys(writeReach))
	}
	if len(servingReach) < 2 {
		t.Fatal("服务侧闭包只剩入口自己 —— 修复被整体撤销（没有任何 handler 走服务侧校验）")
	}

	// A/B：双向完整性。
	assertRegistryMatches(t, "servingAppIDCallers", servingReach, servingAppIDCallers,
		"若它是服务侧入口（作用于既有行 / 路径参数），把它登记进清单；"+
			"若它是写侧闸门，它不该出现在服务侧闭包里（见下一条 C）")
	assertRegistryMatches(t, "writeSideAppIDCallers", writeReach, writeSideAppIDCallers,
		"若它是服务侧入口（作用于既有行 / 路径参数），它必须改用 h.validateAppIDServing "+
			"（写侧规则含「与平台路由静态段同名」，套在既有行上会把本来正常服务的应用变成 400）；"+
			"若它确实是写侧闸门，把它加进 writeSideAppIDCallers 并说明判据")

	// C：两个闭包不得相交。同一入口既能到写侧又能到服务侧 = 两套判据混用 ⇒ 到底哪条
	// 规则生效取决于参数来源，判据与人都看不出来。要例外必须显式登记（当前没有例外）。
	mixed := map[string]bool{}
	for name := range writeReach {
		if servingReach[name] {
			mixed[name] = true
		}
	}
	if len(mixed) > 0 {
		t.Errorf("节点 %v 同时能触达写侧入口 %v 与服务侧入口 %v：同一个入口两套规则混用 ⇒ "+
			"「这个名字进不进库」的语义不明（而且两套规则的差别正是「与路由静态段同名」那一条）。"+
			"拆成两条调用链，或在此显式登记例外并说明为什么两套都要",
			sortedKeys(mixed), appIDWriteSideEntries, appIDServingEntries)
	}

	// 反向：Y3-1 点名的那批服务侧入口必须真的走服务侧（防"清单还在、调用被换成写侧
	// 入口"—— 那种漂移在上面 A/B 里会同时表现为"写侧闭包多一个"）。
	for _, name := range []string{"h.openApp", "h.clientRequest", "h.appProofIssue", "h.ownedApp", "h.loadAdminApp", "h.adminAppOpens", "h.adminAppAIUsage"} {
		if !servingReach[name] {
			t.Errorf("服务侧 handler %s 触达不到 h.validateAppIDServing：存量应用（名字 ∈ "+
				"路由静态段，例如 open/rows/releases）会在它的入口被 400 INVALID_APP_ID 拒掉 "+
				"—— 这正是 Y3-1 的缺陷形态", name)
		}
		if writeReach[name] {
			t.Errorf("服务侧 handler %s 能触达**写侧**入口 %v：写侧规则含「与平台路由静态段"+
				"同名」，套在既有行上会把本来正常服务的应用变成 400", name, appIDWriteSideEntries)
		}
	}
}

// TestAuditR25AppIDValidatorsForwardToMatchingRegistryVariant 是 D。
//
// 两个入口必须各自转发到**对应**的 registry 变体；且 registry 直连只能出现在
// 这两个方法里（多一处 = 多一个判据看不见的分叉点）。
func TestAuditR25AppIDValidatorsForwardToMatchingRegistryVariant(t *testing.T) {
	cs := parseAppIDCallSites(t)

	cases := []struct {
		method   string
		registry string
	}{
		{"h.validateAppID", "ValidateAppID"},
		{"h.validateAppIDServing", "ValidateAppIDForServing"},
	}
	for _, tc := range cases {
		got := cs.registryByNode[tc.method]
		if !got[tc.registry] {
			t.Errorf("%s 没有转发到 registry.%s（实得 %v）", tc.method, tc.registry, sortedKeys(got))
		}
		// 另一个变体不得出现在同一个方法里（两套判据混用 = 语义不明）。
		other := "ValidateAppID"
		if tc.registry == "ValidateAppID" {
			other = "ValidateAppIDForServing"
		}
		if got[other] {
			t.Errorf("%s 同时引用了 registry.%s（两个变体不得混用）", tc.method, other)
		}
	}

	allowed := map[string]bool{"h.validateAppID": true, "h.validateAppIDServing": true}
	for node, regs := range cs.registryByNode {
		for _, key := range []string{"ValidateAppID", "ValidateAppIDForServing"} {
			if !regs[key] {
				continue
			}
			if !allowed[node] {
				t.Errorf("节点 %s 直连 registry.%s：app_id 校验只允许经 h.validateAppID / "+
					"h.validateAppIDServing 两个入口（否则调用点判据看不见它）", node, key)
			}
		}
	}
}
