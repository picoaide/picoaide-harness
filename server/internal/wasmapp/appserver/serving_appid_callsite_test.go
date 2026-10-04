package appserver

import (
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	wasmregistry "github.com/picoaide/picoaide/internal/wasmapp/registry"
)

// 本文件是审计 S7-R §3.4「顺带发现」的判据化（2026-10-04，修复代理 P2）：
//
//	`internal/wasmapp/appserver/serve.go:60` 直呼 `registry.ValidateAppIDForServing`，
//	而**全仓没有钉它的调用点判据** ⇒ 把服务侧口径改回**写侧**口径（`registry.ValidateAppID`）
//	不会红。
//
// # 为什么这条口径重要（改回写侧 = 存量应用升级后直接 404）
//
// 两侧的差别只有一条规则：**"与平台路由静态段同名"**（`uploads` / `open` / `rows` /
// `releases` …，由 `internal/router` 从真实路由表派生后注入 `registry`）。
//
//   - **写侧**（`registry.ValidateAppID`，发布链路用）必须套用它：否则新发布的应用会落进
//     "建得成、永远打不开"的名字（X4-1 的缺陷形态）；
//   - **服务侧**（`registry.ValidateAppIDForServing`，`serve.go` 用）**刻意不套用**：
//     存量库里可能已经有这类名字的行（`rows` 这类合法英文词是真实存在的），套用会把
//     **本来正常服务**的应用在升级后直接变成 404（第二十四轮复审的裁定）。
//
// 两侧其余规则（形态、纯数字、`xn--`、平台保留字 `limits.ReservedAppIDs`、部署期注入的
// 企业既有主机名）**完全一致** —— 所以本文件的正向判据必须同时钉住"服务侧确实放行静态段名"
// 与"服务侧仍然拦平台保留字"两半，避免把"服务侧被放宽成什么都不查"当成通过。
//
// # 判据两半（各自独立）
//
//   - **行为面**（`TestServingSideAcceptsRouteStaticSegmentsButStillBlocksReserved`）：
//     注入路由静态段（`rows`）之后，该名字的应用仍能服务（200），而平台保留字（`admin`）
//     仍 404。把 `serve.go` 的服务侧入口换成写侧变体 ⇒ ①变 404 ⇒ 红。
//   - **调用点面**（`TestAppServerOnlyCallsServingVariant`）：包内**全部非测试 .go** 里，
//     `registry.ValidateAppIDForServing` 恰好一次、`registry.ValidateAppID` 零次
//     （用 AST 选择器解析，不是字符串 contains —— 迁到别的文件、换个包装函数都会红）。
//
// 为什么还要调用点面：行为面只覆盖 `serveApp` 这一条路径；新增第二处校验（例如某个新的
// 早退分支、或某个 helper）时行为面可能看不见它。
//
// 变异验证（实跑见交付报告 temp/audit-v282/fixes/P2.md）：把 `serve.go` 的
// `registry.ValidateAppIDForServing` 改成 `registry.ValidateAppID` ⇒ 两半同时红。

// routeStaticSegmentProbe 是被注入的"路由静态段"名字（真实取自 WASM 操作面的静态段：
// `POST /apps/wasm/:app_id/rows` 等）。用真实的段名而不是造一个假名字：判据要证明的正是
// "**这一批**名字在服务侧必须放行"。
const routeStaticSegmentProbe = "rows"

// platformReservedProbe 是平台保留字（`limits.ReservedAppIDs`，域名资产语义）——
// 服务侧**仍然**要拦它（这一条与"路由遮蔽"无关）。
//
// 为什么用 `portal` 而不是 `admin`：本包全部用例共用同一个 DataRoot（`sharedDataRoot`），
// 而 `pipeline_test.go` 已经发布过 `admin@1.0.0` —— 再用同名同版本会让 `publishApp` 撞
// "版本已存在"。换一个**同样在保留集合里、但本包没人用过**的名字，判据就与用例执行顺序无关。
const platformReservedProbe = "portal"

// TestServingSideAcceptsRouteStaticSegmentsButStillBlocksReserved 是服务侧口径的**行为面**判据。
func TestServingSideAcceptsRouteStaticSegmentsButStillBlocksReserved(t *testing.T) {
	// 注入"当前生效的路由静态段集合"（生产里由 `internal/router.Register` 在注册完路由表
	// 之后调用一次；测试里显式注入，并用 t.Cleanup 还原 —— 包级状态必须复位，
	// 否则会污染同包其它用例的判据面）。
	wasmregistry.SetRouteReservedAppIDs([]string{routeStaticSegmentProbe, "uploads"})
	t.Cleanup(func() { wasmregistry.SetRouteReservedAppIDs(nil) })

	// 自校准①：注入的名字**真的**在写侧保留集合里。没有这条，"服务侧放行"可能只是因为
	// 注入没生效（那时两侧都放行，判据退化成恒真）。
	if aerr := wasmregistry.ValidateAppID(routeStaticSegmentProbe, nil); aerr == nil {
		t.Fatalf("自校准失败：注入路由静态段之后，写侧 `ValidateAppID(%q)` 仍然放行 —— "+
			"注入没生效（或写侧规则被删），本用例的放行断言没有判别力", routeStaticSegmentProbe)
	}
	// 自校准②：同一个注入下，服务侧规则对**平台保留字**仍然拒绝（证明服务侧不是"什么都不查"）。
	if aerr := wasmregistry.ValidateAppIDForServing(platformReservedProbe, nil); aerr == nil {
		t.Fatalf("自校准失败：服务侧对平台保留字 %q 竟然放行", platformReservedProbe)
	}

	e := newEnv(t)
	e.publishApp(appSpec{appID: routeStaticSegmentProbe})

	rec := e.get(routeStaticSegmentProbe, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("服务侧把路由静态段名字（%q）当成写侧保留字拒了：%d body=%s\n"+
			"  `appserver/serve.go` 的服务侧校验必须是 `registry.ValidateAppIDForServing`"+
			"（不含「与平台路由静态段同名」这条**写侧**规则）—— 套用写侧规则会把存量库里"+
			"这类名字的应用在升级后直接变成 404（第二十四轮复审的裁定）。",
			routeStaticSegmentProbe, rec.Code, rec.Body.String())
	}

	// 反向：平台保留字即使库里有行也必须 404（服务侧没有把判据放宽成"全放行"）。
	e.publishApp(appSpec{appID: platformReservedProbe})
	if rec := e.get(platformReservedProbe, "/"); rec.Code != http.StatusNotFound {
		t.Errorf("平台保留字（%q）应 404（纵深防御：保留名是平台资产），得到 %d",
			platformReservedProbe, rec.Code)
	}
}

// TestAppServerOnlyCallsServingVariant 是**调用点面**判据：包内每个非测试 .go 文件里，
// 指向 `internal/wasmapp/registry` 的调用只能是 `ValidateAppIDForServing`（恰好一次），
// 不得出现写侧入口 `ValidateAppID`。
//
// 判据解析 **AST 选择器**并**按 import 解析**（不是 `strings.Contains`）：
//   - 字符串判据会被"换个包装函数名转发"绕过（本仓已登记的假绿形态）；
//   - 按 import 解析能覆盖 `import x ".../registry"` 这类别名写法。
//
// 扫不到 registry import / 一个调用点都没有 ⇒ **Fatal**（判据的扫描面缺失不得静默通过）。
func TestAppServerOnlyCallsServingVariant(t *testing.T) {
	const registryImport = "github.com/picoaide/picoaide/internal/wasmapp/registry"
	const servingSel = "ValidateAppIDForServing"
	const writeSel = "ValidateAppID"

	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录失败: %v（判据的扫描面缺失，拒绝静默通过）", err)
	}
	fset := token.NewFileSet()
	files, imports, servingSites, writeSites := 0, 0, 0, 0
	writeWhere := []string{}
	for _, ent := range entries {
		name := ent.Name()
		if ent.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, perr := parser.ParseFile(fset, filepath.Join(".", name), nil, 0)
		if perr != nil {
			t.Fatalf("解析 %s 失败（判据的扫描面缺失，拒绝静默通过）: %v", name, perr)
		}
		files++
		// 解析该文件里 registry 包的**本地名字**（别名/默认名/点导入）。
		localNames := map[string]bool{}
		for _, imp := range file.Imports {
			if imp.Path == nil || strings.Trim(imp.Path.Value, `"`) != registryImport {
				continue
			}
			imports++
			alias := "registry"
			if imp.Name != nil {
				alias = imp.Name.Name
			}
			localNames[alias] = true
		}
		if len(localNames) == 0 {
			continue
		}
		ast.Inspect(file, func(n ast.Node) bool {
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			ident, ok := sel.X.(*ast.Ident)
			if !ok || !localNames[ident.Name] {
				return true
			}
			switch sel.Sel.Name {
			case servingSel:
				servingSites++
			case writeSel:
				writeSites++
				writeWhere = append(writeWhere, name+":"+fset.Position(sel.Pos()).String())
			}
			return true
		})
	}
	if files == 0 {
		t.Fatalf("包目录下没有非测试 .go 文件（判据的扫描面为空，拒绝静默通过）")
	}
	if imports == 0 {
		t.Fatalf("包内没有任何文件 import %s —— 服务侧校验点消失了？"+
			"（判据的扫描面缺失，拒绝静默通过）", registryImport)
	}
	if servingSites != 1 {
		t.Errorf("包内 `%s.%s` 调用点 = %d, want 恰好 1（`serve.go` 的 serveApp 入口）。\n"+
			"  多一处 = 多一条判据看不见的分叉；少一处 = 服务侧校验被绕过。"+
			"（行为面判据 TestServingSideAcceptsRouteStaticSegmentsButStillBlocksReserved 只覆盖"+
			" serveApp 这一条路径。）", "registry", servingSel, servingSites)
	}
	if writeSites != 0 {
		t.Errorf("包内出现了**写侧**入口 `registry.%s`（%d 处：%v）：服务侧校验必须用 "+
			"`registry.ValidateAppIDForServing` —— 写侧规则含「与平台路由静态段同名」，"+
			"套在服务侧会把存量应用（例如名字叫 `rows`）在升级后直接变成 404。"+
			"（第二十四轮复审的裁定；行为面判据会同时红。）", writeSel, writeSites, writeWhere)
	}
}
