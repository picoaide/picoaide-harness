package api

// audit_r25_serving_appid_callsite_test.go —— 第二十五轮审计 Y3-1（P1）的
// **调用点级**判据。
//
// 缺陷形态（Y3 实测）：主控的修复把"服务侧不得套用写侧路由保留字"只接到了
// `appserver/serve.go:59` 一个调用点，而客户端面/管理面还有 7 处 handler 仍走写侧
// `h.validateAppID` ⇒ 存量应用（名字 ∈ 路由静态段，例如 `open` / `rows` / `releases`）
// 在 open/request/proof/ownedApp/admin/opens 上被 400 INVALID_APP_ID 拒掉，而同一条
// 链上的 serveApp 放行。
//
// 既有的 `registry` 包判据（TestR24X4ServeSideDoesNotApplyRouteStaticReserved）只钉
// **两个函数的语义**，不钉任何调用点 ⇒ 把 `serve.go` 或 api 层任一处改回写侧变体，
// 包级测试**全绿**（Y3 实跑证明）。本文件补的正是那一层：
//
//	A. 服务侧 handler（枚举见 servingAppIDHandlers）必须解析到 h.validateAppIDServing；
//	B. 写侧闸门（validateRawAppID = 发布链路 + 标识查重）必须解析到 h.validateAppID；
//	C. **完整性**：全包不得出现第四种形态 —— 任何不在白名单里的方法调用
//	   h.validateAppID 都当场红（新增服务侧 handler 时判据跟着走，不允许静默漂移）；
//	D. 两个方法各自只能转发到**对应**的 registry 变体（写侧 → ValidateAppID、
//	   服务侧 → ValidateAppIDForServing），且 registry 直连不出现在别处。
//
// 为什么不写成"读源码字符串 contains"：那样钉的是文本而不是解析结果，把调用挪进
// 死代码分支、或用别名/包装转发都会让断言失去判别力（本仓已登记同类假绿形态）。
// 这里用 go/ast 解析**真实调用表达式**，并同时枚举"所有调用点"，两个方向都收口。

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// servingAppIDHandlers 是**服务侧** app_id 校验的全部调用点（方法名，不含接收者）。
//
// 判据来源（第二十五轮审计 Y3-1）：作用于"库里可能已经有这一行"的名字 ——
// 路径参数 `:app_id`、或请求体里指向既有应用的 app_id。它们的语义都是"这个应用
// 已经存在（或正在被访问）"，不是"这个名字要进库"。
var servingAppIDHandlers = []string{
	"openApp",         // POST /apps/wasm/:app_id/open
	"clientRequest",   // POST /apps/wasm/:app_id/request
	"appProofIssue",   // POST /apps/wasm/proof（body 里的 app_id）
	"ownedApp",        // 作者面：export/diagnostics/schema/rows/availability/releases/…
	"loadAdminApp",    // 管理面：unpublish/publish/freeze/owner/releases/diagnostics/…
	"adminAppOpens",   // GET /api/server/admin/wasm-apps/:app_id/opens
	"adminAppAIUsage", // GET /api/server/admin/wasm-apps/:app_id/ai-usage
}

// writeSideAppIDHandlers 是**写侧**闸门的全部调用点："这个名字将进入库"。
//
//   - validateRawAppID：发布链路（publish）与标识查重（availability）共用；
//   - 分片上传建立会话（upload.Store.Create）在 upload 包里直连 registry，不在本包。
var writeSideAppIDHandlers = []string{"validateRawAppID"}

// appIDCallSites 是解析结果：方法名 → 该方法体内出现的"方法调用"集合。
type appIDCallSites struct {
	// byMethod 记录每个方法体里调用了哪些 `h.<name>(...)`。
	byMethod map[string]map[string]bool
	// methods 是解析到的全部方法名（用于"函数被改名/删除"时 fail-loud）。
	methods map[string]bool
	// registryByMethod 记录每个方法体里直连的 `registry.<name>(...)`。
	registryByMethod map[string]map[string]bool
}

// parseAppIDCallSites 解析本包（不含测试文件）的全部方法体。
func parseAppIDCallSites(t *testing.T) appIDCallSites {
	t.Helper()
	fset := token.NewFileSet()
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录失败: %v", err)
	}
	out := appIDCallSites{
		byMethod:         map[string]map[string]bool{},
		methods:          map[string]bool{},
		registryByMethod: map[string]map[string]bool{},
	}
	parsed := 0
	for _, en := range entries {
		name := en.Name()
		if en.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		f, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if perr != nil {
			t.Fatalf("解析 %s 失败: %v", name, perr)
		}
		parsed++
		for _, decl := range f.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			method := methodName(fn)
			if method == "" {
				continue
			}
			out.methods[method] = true
			calls := map[string]bool{}
			registry := map[string]bool{}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				qualifier, ok := sel.X.(*ast.Ident)
				if !ok {
					return true
				}
				// registry 直连（`registry.ValidateAppID(…)`）单独记一份：它只允许
				// 出现在两个转发方法里。
				if qualifier.Name == "registry" {
					registry[sel.Sel.Name] = true
					return true
				}
				// 方法调用 `h.<method>(…)`：限定词必须就是本方法的接收者名，避免把
				// 别的对象的同名方法算进来（也避免漏掉换了接收者名的写法）。
				if qualifier.Name != receiverName(fn) {
					return true
				}
				switch sel.Sel.Name {
				case "validateAppID", "validateAppIDServing":
					calls[sel.Sel.Name] = true
				}
				return true
			})
			if len(calls) > 0 {
				out.byMethod[method] = calls
			}
			if len(registry) > 0 {
				out.registryByMethod[method] = registry
			}
		}
	}
	if parsed == 0 {
		t.Fatal("一个非测试 .go 文件都没解析到 —— 判据失去对象（工作目录不对？）")
	}
	return out
}

func methodName(fn *ast.FuncDecl) string {
	if fn.Recv == nil || len(fn.Recv.List) == 0 {
		return ""
	}
	if fn.Name == nil {
		return ""
	}
	return fn.Name.Name
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

// TestAuditR25ServingAppIDCallSitesAreBoundToServing 是 A + B + C。
func TestAuditR25ServingAppIDCallSitesAreBoundToServing(t *testing.T) {
	cs := parseAppIDCallSites(t)

	// 自校准：枚举清单里的方法必须真的存在（改名/删除 ⇒ 判据失去对象，
	// 必须当场红并要求同步清单，而不是静默变成空转）。
	for _, m := range append(append([]string{}, servingAppIDHandlers...), writeSideAppIDHandlers...) {
		if !cs.methods[m] {
			t.Fatalf("本包里找不到方法 %q —— 判据清单与实现脱节（改名的同时必须更新"+
				"servingAppIDHandlers / writeSideAppIDHandlers，否则这条判据会静默空转）", m)
		}
	}

	// A：每个服务侧 handler 必须解析到 h.validateAppIDServing。
	for _, m := range servingAppIDHandlers {
		calls := cs.byMethod[m]
		if !calls["validateAppIDServing"] {
			t.Errorf("服务侧 handler %s 没有调用 h.validateAppIDServing（实得 %v）："+
				"存量应用（名字 ∈ 路由静态段，例如 open/rows/releases）会在它的入口被 "+
				"400 INVALID_APP_ID 拒掉 —— 这正是 Y3-1 的缺陷形态", m, sortedKeys(calls))
		}
		if calls["validateAppID"] {
			t.Errorf("服务侧 handler %s 调用了**写侧** h.validateAppID：写侧规则含"+
				"「与平台路由静态段同名」，套在既有行上会把本来正常服务的应用变成 400", m)
		}
	}

	// B：写侧闸门必须解析到 h.validateAppID（不得被"顺手统一"成服务侧变体）。
	for _, m := range writeSideAppIDHandlers {
		calls := cs.byMethod[m]
		if !calls["validateAppID"] {
			t.Errorf("写侧闸门 %s 必须调用 h.validateAppID（实得 %v）：它是"+
				"「新名字进库」的唯一闸门，放松 = 路由静态段名字能再次被发布出来（X4-1 复发）",
				m, sortedKeys(calls))
		}
		if calls["validateAppIDServing"] {
			t.Errorf("写侧闸门 %s 调用了服务侧 h.validateAppIDServing：发布/查重会放行"+
				"与路由静态段同名的名字 ⇒ 应用建得成、但永远打不开", m)
		}
	}

	// C：完整性 —— 调用 h.validateAppID 的方法集合必须**恰好**等于写侧白名单。
	// 新增一个服务侧 handler 却用了写侧变体时，这里点名它。
	callersOfWriteSide := map[string]bool{}
	for m, calls := range cs.byMethod {
		if calls["validateAppID"] {
			callersOfWriteSide[m] = true
		}
	}
	wantWriteSide := map[string]bool{}
	for _, m := range writeSideAppIDHandlers {
		wantWriteSide[m] = true
	}
	for m := range callersOfWriteSide {
		if !wantWriteSide[m] {
			t.Errorf("方法 %s 调用了**写侧** h.validateAppID，但它不在白名单 %v 里："+
				"若它是服务侧入口（作用于既有行 / 路径参数），必须改用 h.validateAppIDServing；"+
				"若它确实是写侧闸门，把它加进 writeSideAppIDHandlers 并说明判据",
				m, writeSideAppIDHandlers)
		}
	}
	for m := range wantWriteSide {
		if !callersOfWriteSide[m] {
			t.Errorf("写侧白名单里的 %s 在本包里没有调用 h.validateAppID（闸门被删或换成了别的实现）", m)
		}
	}

	// C 的对偶：调用 h.validateAppIDServing 的方法集合必须恰好等于服务侧白名单
	// （多出来的 = 清单没跟上；少了的已由 A 覆盖）。
	callersOfServing := map[string]bool{}
	for m, calls := range cs.byMethod {
		if calls["validateAppIDServing"] {
			callersOfServing[m] = true
		}
	}
	wantServing := map[string]bool{}
	for _, m := range servingAppIDHandlers {
		wantServing[m] = true
	}
	for m := range callersOfServing {
		if !wantServing[m] {
			t.Errorf("方法 %s 调用了 h.validateAppIDServing，但不在 servingAppIDHandlers 里："+
				"把它登记进清单（服务侧调用点必须是**可枚举**的，否则下一个人看不出哪些入口受这条规则保护）", m)
		}
	}
	if len(callersOfServing) == 0 {
		t.Fatal("全包没有任何 h.validateAppIDServing 调用点 —— 修复被整体撤销")
	}
}

// TestAuditR25AppIDValidatorsForwardToMatchingRegistryVariant 是 D。
//
// 两个方法必须各自转发到**对应**的 registry 变体；且 registry 直连只能出现在
// 这两个方法里（多一处 = 多一个判据看不见的分叉点）。
func TestAuditR25AppIDValidatorsForwardToMatchingRegistryVariant(t *testing.T) {
	cs := parseAppIDCallSites(t)

	cases := []struct {
		method   string
		registry string
	}{
		{"validateAppID", "ValidateAppID"},
		{"validateAppIDServing", "ValidateAppIDForServing"},
	}
	for _, tc := range cases {
		got := cs.registryByMethod[tc.method]
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

	allowed := map[string]bool{"validateAppID": true, "validateAppIDServing": true}
	for m, regs := range cs.registryByMethod {
		for _, key := range []string{"ValidateAppID", "ValidateAppIDForServing"} {
			if !regs[key] {
				continue
			}
			if !allowed[m] {
				t.Errorf("方法 %s 直连 registry.%s：app_id 校验只允许经 h.validateAppID / "+
					"h.validateAppIDServing 两个入口（否则调用点判据看不见它）", m, key)
			}
		}
	}
}
