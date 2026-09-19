package diag

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 **R1-e2e-2** 的护栏：hints 里**不得**出现未被替换的格式动词。
//
// 现场：`hintTable` 的 RUNTIME_OUTPUT_OVERRUN 有一条字符串漏了 `fmt.Sprintf` ⇒
// AI/作者拿到的提示原样是 "应用响应体上限 %d MiB,超出的部分客户端也拿不到"。hints 是
// 产品的一部分（第一消费者是 AI，§4.9），带 `%d` 的提示会被二次格式化或原样转述给用户。
//
// 判据分两层（缺一不可）：
//
//	① 运行期：整张表（以及 HintsFor 的返回值）里每条提示都不得残留 `%<字母>`；
//	② 源码级（AST）：`hintTable` 里带格式动词的字符串字面量**必须**是某个 `fmt.Sprintf`
//	   的格式实参 —— 这一层才抓得住"新加一条又漏了 Sprintf"，而运行期扫描只抓得住
//	   已经被求值的那一条（两者互补，任一层都能单独把 R1-e2e-2 的缺陷判红）。
//
// 变异验证（实测）：把 diag.go:278 的 `fmt.Sprintf(...)` 改回裸字符串字面量 ⇒ ①②同时红。

// formatVerb 是"会被 fmt 消费的动词"的判据（%d/%s/%v/%q/%x…）。
// 中文句读（如 `50%。`）不会命中，因此"% 后面跟字母"就是安全的判据。
var formatVerb = regexp.MustCompile(`%[a-zA-Z]`)

// TestHintTableHasNoUnformattedVerbs 是①：整张 hints 表的运行期扫描。
func TestHintTableHasNoUnformattedVerbs(t *testing.T) {
	if len(hintTable) < 10 {
		t.Fatalf("hintTable 只有 %d 个错误码，扫描可能已失效（表被改名/搬走了？）", len(hintTable))
	}
	total := 0
	for code, hints := range hintTable {
		for _, h := range hints {
			total++
			if m := formatVerb.FindString(h); m != "" {
				t.Errorf("%s 的提示里残留未替换的格式动词 %q：%q", code, m, h)
			}
		}
		// HintsFor 的返回值同样扫（防止有人只在包装层做替换）。
		for _, h := range HintsFor(string(code)) {
			if m := formatVerb.FindString(h); m != "" {
				t.Errorf("HintsFor(%s) 的提示里残留格式动词 %q：%q", code, m, h)
			}
		}
	}
	if total < 25 {
		t.Fatalf("只扫到 %d 条提示，断言可能已失效", total)
	}
}

// TestHintLiteralsAreFormatted 是②：源码级判据 —— hintTable 里带格式动词的字面量
// 必须是 `fmt.Sprintf` 的格式实参（等价于人工判据 `grep -n '%[dsv]' diag.go | grep -v Sprintf`）。
func TestHintLiteralsAreFormatted(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("无法定位测试文件路径")
	}
	src := filepath.Join(filepath.Dir(file), "diag.go")
	fset := token.NewFileSet()
	parsed, err := parser.ParseFile(fset, src, nil, 0)
	if err != nil {
		t.Fatalf("解析 %s 失败：%v", src, err)
	}

	// ① 收集所有 `fmt.Sprintf(...)` 的**格式实参**位置。
	formatted := map[token.Pos]bool{}
	ast.Inspect(parsed, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || sel.Sel == nil || !isPrintfLike(sel.Sel.Name) || len(call.Args) == 0 {
			return true
		}
		if lit, ok := call.Args[0].(*ast.BasicLit); ok && lit.Kind == token.STRING {
			formatted[lit.Pos()] = true
		}
		return true
	})

	// ② 遍历 hintTable 复合字面量里的全部字符串字面量。
	var literals []*ast.BasicLit
	ast.Inspect(parsed, func(n ast.Node) bool {
		decl, ok := n.(*ast.GenDecl)
		if !ok {
			return true
		}
		for _, spec := range decl.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			named := false
			for _, id := range vs.Names {
				if id.Name == "hintTable" {
					named = true
				}
			}
			if !named {
				continue
			}
			for _, v := range vs.Values {
				ast.Inspect(v, func(inner ast.Node) bool {
					if lit, ok := inner.(*ast.BasicLit); ok && lit.Kind == token.STRING {
						literals = append(literals, lit)
					}
					return true
				})
			}
		}
		return true
	})
	if len(literals) < 25 {
		t.Fatalf("在 hintTable 里只找到 %d 个字符串字面量，判据可能已失效（表改名/换形状？）", len(literals))
	}

	offenders := 0
	for _, lit := range literals {
		raw := lit.Value
		if !formatVerb.MatchString(raw) {
			continue
		}
		if !formatted[lit.Pos()] {
			offenders++
			t.Errorf("%s: 这条提示带格式动词但不是 fmt.Sprintf 的格式实参（漏了 Sprintf）：%s",
				fset.Position(lit.Pos()), raw)
		}
	}
	if offenders > 0 {
		t.Fatalf("hintTable 里有 %d 条提示漏了格式化（R1-e2e-2 的缺陷形态）", offenders)
	}
}

// isPrintfLike 判断被调方法是否是"第一个实参是格式串"的格式化函数。
func isPrintfLike(name string) bool {
	switch name {
	case "Sprintf", "Errorf", "Fatalf", "Printf", "Fprintf", "Sprint":
		return true
	default:
		return false
	}
}

// TestMemoryHintFollowsEffectivePages：内存上限那条提示必须能按**生效值**渲染（R1-rt-25）。
//
// 默认（未注入生效值）仍渲染编译期默认 —— 与 HintsFor 的旧行为逐字一致（api 侧未接线时
// 不会出现"数字突然消失"）；装配侧注入后必须跟着变。
func TestMemoryHintFollowsEffectivePages(t *testing.T) {
	defMiB := limits.InstanceMemoryPages * limits.WasmPageSize >> 20
	def := HintsForMemoryPages(string(apperr.CodeRuntimeMemory), 0)
	if len(def) == 0 || !strings.Contains(def[0], "64 MiB") {
		t.Fatalf("未注入生效值时应渲染编译期默认 %d MiB，得到 %v", defMiB, def)
	}
	// 与静态表逐字一致：同一份文案只有一个真源（memoryLimitHintFormat）。
	table := hintTable[apperr.CodeRuntimeMemory]
	if len(table) == 0 || table[0] != def[0] {
		t.Fatalf("静态表第一条与 memoryLimitHint(0) 不一致：%q vs %q", table, def)
	}

	const pages128 = uint32(2048) // 128 MiB
	got := HintsForMemoryPages(string(apperr.CodeRuntimeMemory), pages128)
	if len(got) == 0 || !strings.Contains(got[0], "128 MiB") {
		t.Fatalf("注入 128 MiB 后内存提示必须写 128 MiB，得到 %v", got)
	}
	if strings.Contains(got[0], "64 MiB") {
		t.Fatalf("注入生效值后不得残留编译期默认 64 MiB：%v", got)
	}
	// 其余条目不受影响（只替换内存上限那一条）。
	for i := 1; i < len(got) && i < len(table); i++ {
		if got[i] != table[i] {
			t.Fatalf("第 %d 条提示不该随内存页数变化：%q vs %q", i, got[i], table[i])
		}
	}
	// 未覆盖的码仍返回 nil（不伪造 hints）。
	if h := HintsForMemoryPages("WEIRD_FAILURE", pages128); h != nil {
		t.Fatalf("未覆盖的错误码应返回 nil，得到 %v", h)
	}
	// 返回的是副本：调用方改它不能污染表（Summary 会把同一份表拼进多个应用的结果）。
	got[0] = "mutated"
	if again := HintsForMemoryPages(string(apperr.CodeRuntimeMemory), pages128); again[0] == "mutated" {
		t.Fatal("HintsForMemoryPages 必须返回副本（否则调用方会污染整张表）")
	}
}
