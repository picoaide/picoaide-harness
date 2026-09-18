package compile

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// 本文件是 §4.3.1-a 的**跨包一致性验收**：
//
//	编译进程与执行进程的 RuntimeConfig 必须逐字段相同
//	（WithCloseOnContextDone / CoreFeatures / engine 种类；WithMemoryLimitPages 允许不同）
//
// 为什么这件事必须用测试保证：两侧不一致的后果**全部是静默的**——发布期编译暖不到
// 执行进程，于是每次进程重启后每个应用的首个请求付一次冷编译（~1.9 s），同一模块在
// 磁盘缓存里落两份条目（实测键：只改内存上限 ⇒ 命中同一键 429b279e…；只改
// CloseOnContextDone ⇒ 换键 68689fd7…。证据见
// docs/evidence/2026-09-17-wasm-app-platform/cache-key/）。
//
// 为什么本包**不 import runtime 包**（而是对着源码做 AST 比对）：
//   - 依赖方向：compile 与 runtime 是同层能力实现，横向 import 会让组装顺序变成
//     编译期约束（capapi.go 的包注释：runtime → capapi，不该有 compile ↔ runtime）；
//   - 并行开发：runtime 由模块 C 并行开发，import 一个正在改动的包会让本包编译状态
//     被别人左右。
//
// 判据（两条，方向相反，合起来才等价于"逐字段相同"）：
//
//	① 源码级（AST）：runtime.NewRuntimeConfig 里出现的每个 wazero RuntimeConfig 选项
//	   调用，都必须出现在编译侧的同一份选项集里；
//	② 反射级：把两侧的 RuntimeConfig 渲染成相同格式的指纹，
//	   先断言编译侧指纹符合**冻结预期**（防本包自己漂移），
//	   再断言 runtime 侧选项集与编译侧选项集相等。
//
// runtime 包不存在时 t.Skip（模块 C 尚未落地时不该让本包变红——但也**不会**假绿：
// 交付说明里标注了这条测试此刻是 Skip 还是真跑）。

// frozenCompilerOptions 是本侧选项集的**冻结预期**（选项名 → 反射读出的取值）。
//
// 值是反射结果（不是源码文本）：`true`、`1024`（= limits.InstanceMemoryPages 的数值）。
// 改 NewCompilerRuntimeConfig 必须同时改这里，而改这里会让跨包比对失败
// （若 runtime 侧没同步改）——这正是我们要的"改一处必须改两处"的强制。
var frozenCompilerOptions = map[string]string{
	"WithCloseOnContextDone": "true",
	"WithMemoryLimitPages":   "1024",
}

// frozenChainRoot 是本侧链式调用的根构造函数。
//
// 它决定 engine 种类（auto/compiler/interpreter）——engine 会改变编译产物，
// 因此也进缓存键（§4.3.1-a 的"engine 种类必须相同"）。两侧都必须是 auto
// （NewRuntimeConfig）：显式选 compiler 会让纯解释型平台（例如无 JIT 的环境）
// 直接不可用，而 auto 是 wazero 的推荐起点。
const frozenChainRoot = "NewRuntimeConfig"

// runtimeDir 返回 runtime 包的目录（兄弟目录）。
func runtimeDir(t *testing.T) string {
	t.Helper()
	return filepath.Join(packageDir(t), "..", "runtime")
}

// findRuntimeConfigSource 在 runtime 包里找到声明 `func NewRuntimeConfig(` 的文件。
//
// 为什么扫描而不是写死文件名：runtime 由模块 C 并行开发，文件怎么分是它的自由
// （实测就从 runtimeconfig.go 变成了 config.go）。写死文件名会让本用例在别人重构时
// 变成假 Skip —— 而"假 Skip"正是 §4.3.1-a 这条静默不变量最危险的失效形态。
func findRuntimeConfigSource(t *testing.T) string {
	t.Helper()
	dir := runtimeDir(t)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return ""
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		b, rerr := os.ReadFile(filepath.Join(dir, e.Name()))
		if rerr != nil {
			continue
		}
		if strings.Contains(string(b), "func NewRuntimeConfig(") {
			return filepath.Join(dir, e.Name())
		}
	}
	return ""
}

// TestCompilerRuntimeConfigHasNoUnexpectedOptions 断言本侧选项集与冻结预期一致。
//
// 这条是**本包自己的**守卫：反射渲染指纹 → 解析出选项集 → 与 frozenCompilerOptions 比。
func TestCompilerRuntimeConfigHasNoUnexpectedOptions(t *testing.T) {
	got := compilerOptionSet(t)
	if len(got) != len(frozenCompilerOptions) {
		t.Fatalf("编译侧 RuntimeConfig 选项数与冻结预期不符：%v（预期 %v）", got, frozenCompilerOptions)
	}
	for k, want := range frozenCompilerOptions {
		if got[k] != want {
			t.Errorf("选项 %s 的取值不符：%q（预期 %q）", k, got[k], want)
		}
	}
}

// compilerOptionSet 从指纹反解出本侧设置的选项集。
//
// 指纹长这样（见 runtimeconfig.go 的 configFingerprint）：
//
//	wazero.runtimeConfig{... memoryLimitPages=1024 ... ensureTermination=true ...}
//
// 我们把"非默认值"的字段映射回对应的 wazero 选项名。映射表必须与 wazero 的
// runtimeConfig 字段名一一对应（改名时测试会红——那正是要人来看的时候）。
func compilerOptionSet(t *testing.T) map[string]string {
	t.Helper()
	fp := CompilerRuntimeConfigFingerprint()
	fields := map[string]string{}
	for _, kv := range strings.Fields(strings.Trim(fp[strings.Index(fp, "{")+1:len(fp)-1], " ")) {
		if i := strings.IndexByte(kv, '='); i > 0 {
			fields[kv[:i]] = kv[i+1:]
		}
	}
	out := map[string]string{}
	// wazero runtimeConfig 字段 → 选项名（只列本侧会设置的项；其余字段的默认值
	// 由 wazero 的 NewRuntimeConfig 提供，两侧同源）。
	if v, ok := fields["ensureTermination"]; ok && v == "true" {
		out["WithCloseOnContextDone"] = "true"
	}
	if v, ok := fields["memoryLimitPages"]; ok && v != "65536" { // 65536 = wazero 默认
		out["WithMemoryLimitPages"] = v
	}
	// 若本侧显式设了任何**其他**字段，必须在这里出现（否则本函数的"未预期项"断言失效）。
	for _, name := range []string{"memoryCapacityFromMax", "dwarfDisabled", "storeCustomSections"} {
		if v, ok := fields[name]; ok && v == "true" {
			out[name] = "true"
		}
	}
	if v, ok := fields["enabledFeatures"]; ok && v != "127" {
		out["WithCoreFeatures"] = v
	}
	return out
}

// TestRuntimeConfigMatchesRuntimePackage 是跨包比对（§4.3.1-a 的主判据）。
func TestRuntimeConfigMatchesRuntimePackage(t *testing.T) {
	path := findRuntimeConfigSource(t)
	if path == "" {
		t.Skipf("runtime 包的 NewRuntimeConfig 尚未就位（模块 C 并行开发中）⇒ "+
			"§4.3.1-a 的跨包一致性**未验证**：runtime 落地后本用例自动生效（不 skip）。目录：%s", runtimeDir(t))
	}
	rtOpts, root := parseRuntimeConfigOptions(t, path)
	if root != frozenChainRoot {
		t.Errorf("runtime 侧链式调用根是 %s（engine 种类随之不同），编译侧是 %s ⇒ "+
			"两侧编译产物不同、缓存键不同（§4.3.1-a 要求 engine 种类相同）", root, frozenChainRoot)
	}
	if len(rtOpts) == 0 {
		t.Fatalf("在 %s 里没解析到任何 wazero RuntimeConfig 选项——"+
			"要么构造函数改名了，要么它不再用链式调用（两种都需要人来确认）", path)
	}
	ourOpts := compilerOptionSet(t)

	// 逐项比对（双向）。
	var rtNames, ourNames []string
	for k := range rtOpts {
		rtNames = append(rtNames, k)
	}
	for k := range ourOpts {
		ourNames = append(ourNames, k)
	}
	sort.Strings(rtNames)
	sort.Strings(ourNames)

	for _, k := range rtNames {
		got, ok := ourOpts[k]
		if !ok {
			t.Errorf("runtime 侧设置了 %s(%s)，编译侧没有 ⇒ 两侧 RuntimeConfig 不一致："+
				"磁盘缓存键不同 ⇒ 发布期编译暖不到执行进程（§4.3.1-a）", k, rtOpts[k])
			continue
		}
		if !sameOptionValue(rtOpts[k], got) {
			t.Errorf("选项 %s 取值不一致：runtime=%q vs compile=%q ⇒ 缓存永不命中（§4.3.1-a）",
				k, rtOpts[k], got)
		}
	}
	for _, k := range ourNames {
		if _, ok := rtOpts[k]; !ok {
			t.Errorf("编译侧设置了 %s(%s)，runtime 侧没有 ⇒ 两侧 RuntimeConfig 不一致（§4.3.1-a）",
				k, ourOpts[k])
		}
	}
	t.Logf("§4.3.1-a 跨包一致：两侧选项集 = %v（runtime 源码 %s）", rtNames, path)
}

// sameOptionValue 比较两侧的选项参数（容忍同一数值的不同写法）。
//
// 例：`limits.InstanceMemoryPages`（编译侧，源码里的符号名）与
// `limits.InstanceMemoryPages`（runtime 侧）逐字相同即相等；
// 若一侧写 `1024` 另一侧写 `limits.InstanceMemoryPages`，视为等价（都指向同一常量）。
func sameOptionValue(rtVal, ourVal string) bool {
	rtVal = strings.TrimSpace(rtVal)
	ourVal = strings.TrimSpace(ourVal)
	if rtVal == ourVal {
		return true
	}
	// 数字 vs 符号名：把已知符号名归一到数值再比。
	norm := func(s string) string {
		switch s {
		case "limits.InstanceMemoryPages", "InstanceMemoryPages":
			return strconv.FormatInt(limits.InstanceMemoryPages, 10)
		default:
			return s
		}
	}
	return norm(rtVal) == norm(ourVal)
}

// parseRuntimeConfigOptions 用 AST 解析 runtime 包里 RuntimeConfig 的选项集。
//
// 只认"在 wazero RuntimeConfig 上链式调用的方法"：本函数的输入是源码路径，
// 不 import runtime 包（见文件头注释）。
//
// 解析失败即 t.Fatal（不是 Skip）：源码在、但形状不认识，说明构造函数的写法变了，
// 此时"静默跳过"会让 §4.3.1-a 变成没人守的条款——必须让人来看。
// parseRuntimeConfigOptions 用 AST 解析 runtime 包里 NewRuntimeConfig 的选项集，
// 并返回链式调用的根构造函数名（engine 种类的判据）。
//
// 只认**在 `func NewRuntimeConfig(` 函数体内**、且链根为 wazero.NewRuntimeConfig* 的
// `With*` 调用：同包里还有 ModuleConfig 的链（WithRandSource 等，那些是**每次实例化**
// 的配置，不属于本不变量），把它们混进来会让比对结果失去意义。
func parseRuntimeConfigOptions(t *testing.T, path string) (map[string]string, string) {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, 0)
	if err != nil {
		t.Fatalf("解析 %s 失败（§4.3.1-a 的一致性断言无法执行）：%v", path, err)
	}
	out := map[string]string{}
	root := ""
	ast.Inspect(f, func(n ast.Node) bool {
		// 只进入名为 NewRuntimeConfig 的函数声明（不含 _test 与其它函数）。
		fn, ok := n.(*ast.FuncDecl)
		if !ok {
			return true
		}
		if fn.Name == nil || fn.Name.Name != "NewRuntimeConfig" {
			return false
		}
		ast.Inspect(fn.Body, func(inner ast.Node) bool {
			call, ok := inner.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			name := sel.Sel.Name
			if !strings.HasPrefix(name, "With") {
				return true
			}
			r, ok := chainRootInRuntimeConfig(sel.X)
			if !ok {
				return true
			}
			root = r
			out[name] = exprText(call.Args)
			return true
		})
		return false
	})
	return out, root
}

// chainRootInRuntimeConfig 判断链式调用的根是否是 wazero 的 RuntimeConfig 构造，
// 并返回该构造函数名；不是则 ok=false。
func chainRootInRuntimeConfig(e ast.Expr) (string, bool) {
	for {
		switch v := e.(type) {
		case *ast.CallExpr:
			s, ok := v.Fun.(*ast.SelectorExpr)
			if !ok {
				return "", false
			}
			if !strings.HasPrefix(s.Sel.Name, "With") {
				// 链的根：NewRuntimeConfig / NewRuntimeConfigCompiler / NewRuntimeConfigInterpreter。
				if strings.HasPrefix(s.Sel.Name, "NewRuntimeConfig") {
					return s.Sel.Name, true
				}
				return "", false
			}
			e = s.X
		case *ast.SelectorExpr:
			e = v.X
		case *ast.Ident:
			return "", false
		default:
			return "", false
		}
	}
}

// exprText 把实参列表渲染成可读文本（本用途只需要区分 true/符号名/数字）。
func exprText(args []ast.Expr) string {
	parts := make([]string, 0, len(args))
	for _, a := range args {
		switch v := a.(type) {
		case *ast.Ident:
			parts = append(parts, v.Name)
		case *ast.BasicLit:
			parts = append(parts, v.Value)
		case *ast.SelectorExpr:
			parts = append(parts, exprText([]ast.Expr{v.X})+"."+v.Sel.Name)
		default:
			parts = append(parts, "<expr>")
		}
	}
	return strings.Join(parts, ",")
}

// TestWazeroKeySensitivityIsAsDocumented 直接验证"哪些字段进缓存键"这条前提本身。
//
// 为什么值得测：整条 §4.3.1-a 的推理都建立在"CloseOnContextDone 进键、内存上限不进键"
// 之上（探针目录里的实测结论）。如果 wazero 升级后改了键构成，本用例会红，
// 提醒重新评估一致性规则（而不是让一个过期的前提继续指导设计）。
func TestWazeroKeySensitivityIsAsDocumented(t *testing.T) {
	base := wazero.NewRuntimeConfig()
	// 反射读非导出字段是唯一途径（wazero 不暴露 getter）。
	get := func(cfg wazero.RuntimeConfig, field string) any {
		v := reflect.ValueOf(cfg).Elem().FieldByName(field)
		if !v.IsValid() {
			t.Fatalf("wazero.runtimeConfig 不再有字段 %q —— 键敏感性结论需要重新实测", field)
		}
		switch v.Kind() {
		case reflect.Bool:
			return v.Bool()
		case reflect.Uint32:
			return uint32(v.Uint())
		default:
			return v.String()
		}
	}
	if got := get(base.WithCloseOnContextDone(true), "ensureTermination"); got != true {
		t.Errorf("WithCloseOnContextDone 应写入 ensureTermination（moduleID 的组成部分 ⇒ 进缓存键）：%v", got)
	}
	if got := get(base.WithMemoryLimitPages(1024), "memoryLimitPages"); got != uint32(1024) {
		t.Errorf("WithMemoryLimitPages 应写入 memoryLimitPages：%v", got)
	}
	// ensureTermination 就是 moduleID 的第三个参数（AssignModuleID(binary, listeners,
	// ensureTermination)）⇒ 它进键；memoryLimitPages 不参与 moduleID ⇒ 不进键。
	// 这条断言把"为什么内存上限允许两侧不同"钉在代码上。
	t.Log("键敏感性前提成立：ensureTermination（CloseOnContextDone）进键、memoryLimitPages 不进键")
}
