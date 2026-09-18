// 本文件是 §5.5「自动化约束」的两条门禁：
//
//  1. **能力清单一致性**：注册的宿主函数集合必须与 §5.1 逐项一致，**多一个即红、
//     少一个也红**（模块 H 审计 P1-1：旧实现"用清单过滤注册表"，多一个的方向恒真）；
//  2. **无路径参数**：枚举 abi 包里全部 `*Params` 结构体字段（**整个包、含嵌套类型**），
//     断言没有任何字段的语义是宿主文件路径（唯一豁免 `assets.read` 的包内逻辑路径）。
//
// 变异验证方式：
//   - 往 `table` 里加一个 `abi.HostMethods` 之外的方法 → 第 1 条红（见
//     TestRegisteredMethodsEnumeratesTable）；
//   - 删掉 `table` 里的 `assets.read` → 第 1 条红（集合少一个）；
//   - 给某个 `*Params` 结构体（含**嵌套类型**或 abi 包的**第二个文件**）加一个 host
//     路径字段 → 第 2 条红（见 TestPathParamGateCatchesNestedAndSecondFile，
//     它用合成源码把两条判据本身钉住）。
package hostcap

import (
	"context"
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

func TestRegisteredMethodsMatchClosedList(t *testing.T) {
	got := append([]string(nil), RegisteredMethods()...)
	want := append([]string(nil), abi.HostMethods...)
	sort.Strings(got)
	sort.Strings(want)
	if len(got) != len(want) {
		t.Fatalf("注册方法数 = %d (%v), want %d (%v)", len(got), got, len(want), want)
	}
	// **双向**对拍（模块 H 审计 P1-1 的判据）：多一个、少一个、改名都在这里红。
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("方法集合不一致：注册 %v, 清单 %v（§5.5「多一个即测试红」要求双向）", got, want)
		}
	}
	// 返回值已排序且无重复（API 契约：调用方不得依赖注册顺序）。
	for i := 1; i < len(got); i++ {
		if got[i] <= got[i-1] {
			t.Fatalf("RegisteredMethods 必须有序且无重复：%v", got)
		}
	}
	// 清单里的每一个名字都必须在 table 里真的能分发（否则"注册"是假的）。
	for _, m := range abi.HostMethods {
		if _, ok := table[m]; !ok {
			t.Fatalf("清单里的 %q 不在 table 里（RegisteredMethods 与 Dispatch 真源必须同一份）", m)
		}
	}
	// abi.ping 是 validate 干跑探针，不属于能力面（abi 包自带说明）⇒ 不进清单。
	for _, m := range RegisteredMethods() {
		if m == abi.MethodPing {
			t.Fatalf("%s 不得出现在能力清单里（§5.1 封闭清单）", abi.MethodPing)
		}
	}
	// 七个原语 ↔ 九个方法：每个注册方法都能映射回一个 §5.1 原语。
	prims := map[string]bool{}
	for _, p := range abi.Primitives {
		prims[p] = true
	}
	for _, m := range RegisteredMethods() {
		if p := abi.PrimitiveOf(m); !prims[p] {
			t.Fatalf("方法 %q 映射到原语 %q，不在 §5.1 的七个原语里", m, p)
		}
	}
}

// TestRegisteredMethodsEnumeratesTable 是"多一个即红"的**结构性**判据：
// RegisteredMethods() 必须**恰好等于 table 的键集合**。
//
// 为什么单列一条：门禁（TestRegisteredMethodsMatchClosedList）比的是
// "注册集合 vs abi.HostMethods"，而只要 RegisteredMethods 的实现是"用清单过滤
// 注册表"，多出来的注册项就永远不出现在返回值里 ⇒ 门禁恒绿（模块 H 审计 P1-1）。
// 这条对拍把"实现必须枚举 table"钉死：往 table 里加任何影方法都会立刻红。
func TestRegisteredMethodsEnumeratesTable(t *testing.T) {
	want := make([]string, 0, len(table))
	for m := range table {
		want = append(want, m)
	}
	sort.Strings(want)
	got := RegisteredMethods()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("RegisteredMethods() = %v，但 table 的键集合 = %v；"+
			"实现必须**枚举 table**，不得用 abi.HostMethods 过滤（否则「多一个」方向恒真）", got, want)
	}
}

// 「多一个即测试红」的反向断言：未注册的名字一律拒，且**没有任何**未在清单里的
// 名字能被分发（逐个试分发，只有 unknown_method 之外的错误才算"认了它"）。
func TestNoExtraMethodsAccepted(t *testing.T) {
	c := &Capabilities{}
	hostile := []string{
		"db.attach", "db.detach", "db.pragma", "db.define_table", "db.tx",
		"ai.embed", "ai.models", "http.fetch", "net.dial", "fs.read", "fs.open",
		"env.get", "proc.spawn", "assets.write", "assets.list", "assets.readdir",
		"log.debug", "sql.raw", "", " ", "LOG", "db.query ", " db.query",
		"picoaide.app.json", "abi.pong",
	}
	for _, m := range hostile {
		_, e := c.Dispatch(context.Background(), m, nil)
		if e == nil {
			t.Fatalf("Dispatch(%q) 竟然成功：未注册即不存在（§10.6 第 68 项）", m)
		}
		if e.Code != apperr.CodeHostMethodUnknown {
			t.Fatalf("Dispatch(%q) code = %s, want HOST_METHOD_UNKNOWN", m, e.Code)
		}
		if e.Details["method"] != m {
			t.Fatalf("Dispatch(%q) details.method = %v（必须点名方法名）", m, e.Details["method"])
		}
		if e.Details["reason"] != "unknown_method" {
			t.Fatalf("Dispatch(%q) reason = %v, want unknown_method", m, e.Details["reason"])
		}
		if len(e.Hints) == 0 {
			t.Fatalf("Dispatch(%q) 必须给出可用能力清单（hints）", m)
		}
	}
	// 反过来：清单里的每一个方法都必须被"认下"（错误里不得出现 unknown_method）。
	for _, m := range RegisteredMethods() {
		_, e := c.Dispatch(context.Background(), m, json.RawMessage(`{}`))
		if e != nil && e.Details["reason"] == "unknown_method" {
			t.Fatalf("清单里的方法 %q 没有被分发（table 与清单漂移）", m)
		}
	}
}

// paramTypeRegistry 登记 abi 里全部 `*Params` 结构体（反射用）。
//
// 与源码扫描对拍：abi 里（**任意文件**）新增一个 `*Params` 类型而没登记 → 本用例红
// （否则"枚举全部 Params"就成了一句空话）。
var paramTypeRegistry = map[string]any{
	"DBDefineParams":   abi.DBDefineParams{},
	"SQLParams":        abi.SQLParams{},
	"TxParams":         abi.TxParams{},
	"AIChatParams":     abi.AIChatParams{},
	"LogParams":        abi.LogParams{},
	"AssetsReadParams": abi.AssetsReadParams{},
}

// pathParamExemptions 是"字段名看起来像路径、但语义不是宿主文件路径"的显式豁免。
//
// 键 = `<Params 类型名>.<字段链>`（嵌套类型也在这个命名空间里，如
// `DBDefineParams.Columns.Path`）。每条豁免都必须写明理由；豁免集合被断言为
// **恰好**下面这一条 —— 想再加一条就得改这个测试，评审时一眼可见。
var pathParamExemptions = map[string]string{
	"AssetsReadParams.Path": "assets.read 的 path 是**包内逻辑路径**（§5.1「无文件系统语义、无路径穿越」）：" +
		"它是作者在 wasm 自定义段里写下的资源名（如 index.html、static/app.css），" +
		"宿主从不把它当宿主路径用 —— assets.Store 先按逻辑规则逐段校验（拒绝对路径/`..`/`\\`/控制字符/超长），" +
		"再拼到「本应用 + 本版本」的抽取根下，最后用 EvalSymlinks + 前缀比对确认仍在根内。" +
		"guest 读不到宿主机文件、也构造不出宿主路径，因此它不是 §4.4 意义上的「文件路径参数」。",
}

var pathishRe = regexp.MustCompile(`(?i)(^|_)(path|paths|file|files|filename|filepath|dir|dirs|directory|root|roots|location|abspath)($|_)`)

// TestABIParamsCarryNoHostPath 是 §5.5 的「无路径参数」门禁。
//
// 枚举范围（模块 H 审计 P2-1 修的两处盲区）：
//   - abi 包的**全部源文件**（不再写死 abi.go）；
//   - **递归**展开嵌套类型（含 slice / map / 指针元素），不再只看 *Params 的顶层字段。
func TestABIParamsCarryNoHostPath(t *testing.T) {
	scan := scanABIPackage(t)

	// 覆盖性：扫到的文件集合必须等于 abi 包里的全部非测试 .go 文件
	// （把 parser.ParseFile("abi.go") 换回来这条立刻红）。
	onDisk := abiPackageGoFiles(t, scan.Dir)
	if strings.Join(scan.Files, ",") != strings.Join(onDisk, ",") {
		t.Fatalf("门禁扫描的 abi 文件 = %v，目录里实际有 %v（必须遍历整个包）", scan.Files, onDisk)
	}
	if len(scan.Files) == 0 {
		t.Fatal("没有扫到任何 abi 源文件（路径写错？门禁会静默失效）")
	}

	// 递归必须真的发生：嵌套类型的字段要在展开结果里出现。
	// 这两条是**正向对照** —— 去掉递归展开时它们先红，而不是让盲区悄悄回来。
	expanded := map[string]bool{}
	for _, f := range scan.Fields {
		expanded[f.Path] = true
	}
	for _, nested := range []string{
		"DBDefineParams.Columns.Name", // []ColumnDef 的元素字段
		"AIChatParams.Messages.Role",  // []ChatMessage 的元素字段
		"SQLParams.Args",              // []any：无嵌套结构体，但字段本身要在
	} {
		if !expanded[nested] {
			t.Fatalf("递归展开没有覆盖 %q（字段集合 = %v）—— 嵌套类型是路径参数的已知盲区", nested, sortedPaths(scan.Fields))
		}
	}

	// 与登记表对拍：abi 里新增/改名的 *Params 类型必须同步登记。
	registered := make([]string, 0, len(paramTypeRegistry))
	for name := range paramTypeRegistry {
		registered = append(registered, name)
	}
	sort.Strings(registered)
	if strings.Join(scan.Params, ",") != strings.Join(registered, ",") {
		t.Fatalf("abi 里的 *Params 类型 = %v，登记表 = %v；新增/改名类型必须同步登记（否则枚举不完整）",
			scan.Params, registered)
	}

	// 逐字段判定（含嵌套）：字段名或 json 名看起来像宿主路径 ⇒ 必须有显式豁免。
	used := map[string]bool{}
	for _, f := range scan.Fields {
		looksLikePath := pathishRe.MatchString(f.Name) || (f.JSONName != "" && pathishRe.MatchString(f.JSONName))
		if !looksLikePath {
			continue
		}
		if _, ok := pathParamExemptions[f.Path]; !ok {
			t.Fatalf("%s 的字段 %s（json:%q）看起来承载路径语义；"+
				"宿主函数不得接受文件路径（§4.4/§5.5）——若确实是包内逻辑路径，请在 pathParamExemptions 里显式登记理由",
				f.Path, f.Name, f.JSONName)
		}
		used[f.Path] = true
	}
	for key := range pathParamExemptions {
		if !used[key] {
			t.Fatalf("豁免 %q 已失效（字段改名/删除后必须同步清理），否则豁免表会变成永久白名单", key)
		}
	}
	if len(pathParamExemptions) != 1 {
		t.Fatalf("路径豁免集合 = %v, want 恰好 1 条（assets.read 的包内逻辑路径）", pathParamExemptions)
	}
}

// TestPathParamGateCatchesNestedAndSecondFile 用**合成源码**证明门禁的两条判据真的有效：
//
//	MUT4：给**嵌套类型**（`db.define` 参数里的 ColumnDef）加 `Path string`；
//	MUT5：在 abi 包的**第二个文件**里定义 `type SecretParams struct{ FilePath string }`。
//
// 为什么不用 `go test -overlay` 做这条变异：门禁在**运行期**用 parser 读磁盘上的
// 源码，而 `-overlay` 只影响 go 命令自身的编译读取，不会改写运行期 os.ReadFile
// 看到的内容（模块 H 实测）⇒ 合成源码是唯一可复现、可常驻的判据。真实文件的
// 变异（改完还原）另行手工跑过，见交付说明。
func TestPathParamGateCatchesNestedAndSecondFile(t *testing.T) {
	scan := scanABISources(t, map[string]string{
		"abi.go": `package abi

type ColumnDef struct {
	Name string ` + "`json:\"name\"`" + `
	Path string ` + "`json:\"path\"`" + `
}

type DBDefineParams struct {
	Table   string      ` + "`json:\"table\"`" + `
	Columns []ColumnDef ` + "`json:\"columns\"`" + `
}
`,
		// MUT5：同一个包的第二个文件 —— 旧门禁只 ParseFile("abi.go")，看不到它。
		"extra.go": `package abi

type SecretParams struct {
	FilePath string ` + "`json:\"file_path\"`" + `
}
`,
	})
	var nested, secondFile bool
	for _, f := range scan.Fields {
		switch f.Path {
		case "DBDefineParams.Columns.Path":
			nested = pathishRe.MatchString(f.Name)
		case "SecretParams.FilePath":
			secondFile = pathishRe.MatchString(f.Name)
		}
	}
	if !nested {
		t.Fatalf("嵌套类型字段 DBDefineParams.Columns.Path 没有被门禁看到（字段集合 = %v）", sortedPaths(scan.Fields))
	}
	if !secondFile {
		t.Fatalf("第二个文件的 SecretParams.FilePath 没有被门禁看到（字段集合 = %v）", sortedPaths(scan.Fields))
	}
	if len(scan.Params) != 2 || scan.Params[0] != "DBDefineParams" || scan.Params[1] != "SecretParams" {
		t.Fatalf("*Params 类型 = %v，want [DBDefineParams SecretParams]（跨文件）", scan.Params)
	}
}

// TestTxAllowedSetIsExactlyDBReadWrite 把 §4.4 的事务允许集钉成**恰好**
// 数据库读写 + 事务出口（模块 H 审计 P0-1 的核心判据）。
//
// 两个方向都有效：把 db.query/db.exec 从允许集里去掉（缺陷原状）⇒ 红；
// 把 tx_begin / db.define / ai.chat 之类加回允许集 ⇒ 红。
func TestTxAllowedSetIsExactlyDBReadWrite(t *testing.T) {
	want := map[string]bool{
		abi.MethodDBQuery:    true,
		abi.MethodDBExec:     true,
		abi.MethodTxCommit:   true,
		abi.MethodTxRollback: true,
	}
	for _, m := range abi.HostMethods {
		if got := abi.TxAllowedWhileInTx(m); got != want[m] {
			t.Fatalf("TxAllowedWhileInTx(%q) = %v, want %v（事务内只允许数据库读写 + 事务出口）", m, got, want[m])
		}
	}
	// 非能力面的协议内建方法也不在允许集里（abi.ping 同样受闸门约束，§4.4 无例外）。
	for _, m := range abi.ProbeMethods {
		if abi.TxAllowedWhileInTx(m) {
			t.Fatalf("%s 不得在事务允许集里（事务内只允许数据库读写）", m)
		}
	}
}

// TestTxDenialClassificationIsTotal：允许集之外的每个清单方法都必须有明确分类
// （nested_tx / blocking_capability / ddl）—— 新增宿主函数时不能静默回落成
// 一句笼统的 unknown（错误码的第一消费者是 AI，§8）。
func TestTxDenialClassificationIsTotal(t *testing.T) {
	for _, m := range abi.HostMethods {
		if abi.TxAllowedWhileInTx(m) {
			continue
		}
		switch k := txDeniedKind(m); k {
		case txDeniedNested, txDeniedBlocking, txDeniedDDL:
		default:
			t.Fatalf("被禁方法 %q 的事务拒绝分类 = %q，必须落到 nested_tx / blocking_capability / ddl 之一", m, k)
		}
	}
}

// ===== abi 包源码扫描（§5.5 无路径参数门禁的实现）=====

// abiField 是递归展开后的一个字段。
type abiField struct {
	// Path 是 `<Params 类型名>.<字段链>`（嵌套类型也在同一命名空间），
	// 它就是 pathParamExemptions 的键。
	Path     string
	Name     string
	JSONName string
}

// abiScan 是一次 abi 包源码扫描的结果。
type abiScan struct {
	Dir    string
	Files  []string // 参与扫描的非测试文件名（basename，排序）
	Params []string // *Params 结构体名（排序）
	Fields []abiField
}

// scanABIPackage 扫描**真实**的 abi 包目录（全部 .go，除 _test.go）。
func scanABIPackage(t *testing.T) abiScan {
	t.Helper()
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller 失败")
	}
	dir := filepath.Join(filepath.Dir(thisFile), "..", "abi")
	fset := token.NewFileSet()
	pkgs, err := parser.ParseDir(fset, dir, func(fi os.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatalf("解析 abi 包目录 %s: %v", dir, err)
	}
	files := map[string]*ast.File{}
	for _, pkg := range pkgs {
		for name, f := range pkg.Files {
			files[filepath.Base(name)] = f
		}
	}
	if len(pkgs) != 1 {
		t.Fatalf("abi 目录里有 %d 个包，want 恰好 1 个", len(pkgs))
	}
	scan := scanABIFiles(t, files)
	scan.Dir = dir
	return scan
}

// scanABISources 用合成源码扫描（判据自证用；不读磁盘）。
func scanABISources(t *testing.T, sources map[string]string) abiScan {
	t.Helper()
	fset := token.NewFileSet()
	files := map[string]*ast.File{}
	for name, src := range sources {
		f, err := parser.ParseFile(fset, name, src, 0)
		if err != nil {
			t.Fatalf("解析合成源码 %s: %v", name, err)
		}
		files[name] = f
	}
	return scanABIFiles(t, files)
}

// scanABIFiles 是纯函数形态的扫描器：给定一组已解析的 ast.File，输出类型与字段集合。
func scanABIFiles(_ *testing.T, files map[string]*ast.File) abiScan {
	structs := map[string]*ast.StructType{}
	fileNames := make([]string, 0, len(files))
	for name, f := range files {
		fileNames = append(fileNames, name)
		for _, decl := range f.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.TYPE {
				continue
			}
			for _, spec := range gd.Specs {
				ts, ok := spec.(*ast.TypeSpec)
				if !ok {
					continue
				}
				st, isStruct := ts.Type.(*ast.StructType)
				if !isStruct {
					continue
				}
				structs[ts.Name.Name] = st
			}
		}
	}
	sort.Strings(fileNames)

	params := make([]string, 0, len(structs))
	for name := range structs {
		if strings.HasSuffix(name, "Params") {
			params = append(params, name)
		}
	}
	sort.Strings(params)

	scan := abiScan{Files: fileNames, Params: params}
	seen := map[string]bool{}
	for _, p := range params {
		collectABIFields(structs, p, p, "", seen, &scan.Fields)
	}
	sort.Slice(scan.Fields, func(i, j int) bool { return scan.Fields[i].Path < scan.Fields[j].Path })
	return scan
}

// collectABIFields 递归展开 `*Params` 的字段（含 slice / map / 指针的元素类型）。
//
// root 恒为**根** `*Params` 类型名（豁免键永远以它开头，嵌套类型的字段也要能
// 定位到"是哪个宿主函数的参数"）；cur 是当前正在展开的结构体；prefix 是已走过的
// 字段链（`Columns` / `Columns.X`），同时用于拼键与防环。
func collectABIFields(structs map[string]*ast.StructType, root, cur, prefix string, seen map[string]bool, out *[]abiField) {
	st, ok := structs[cur]
	if !ok || st.Fields == nil {
		return
	}
	for _, f := range st.Fields.List {
		if len(f.Names) == 0 { // 内嵌字段：abi 里没有，遇到就跳过（不是参数面）
			continue
		}
		for _, name := range f.Names {
			path := name.Name
			if prefix != "" {
				path = prefix + "." + name.Name
			}
			key := root + "." + path
			if seen[key] {
				continue
			}
			seen[key] = true
			*out = append(*out, abiField{Path: key, Name: name.Name, JSONName: jsonNameOf(f)})
			// 递归进嵌套结构体（slice/map/指针都剥到元素类型为止）。
			if elem := namedStructType(f.Type, structs); elem != "" {
				collectABIFields(structs, root, elem, path, seen, out)
			}
		}
	}
}

// namedStructType 把字段类型剥到"abi 包里已声明的结构体名"（剥 []T / map[K]V / *T）。
func namedStructType(expr ast.Expr, structs map[string]*ast.StructType) string {
	switch t := expr.(type) {
	case *ast.ArrayType:
		return namedStructType(t.Elt, structs)
	case *ast.MapType:
		return namedStructType(t.Value, structs)
	case *ast.StarExpr:
		return namedStructType(t.X, structs)
	case *ast.Ident:
		if _, ok := structs[t.Name]; ok {
			return t.Name
		}
	}
	return ""
}

func jsonNameOf(f *ast.Field) string {
	if f.Tag == nil {
		return ""
	}
	tag := strings.Trim(f.Tag.Value, "`")
	const key = `json:"`
	i := strings.Index(tag, key)
	if i < 0 {
		return ""
	}
	rest := tag[i+len(key):]
	if j := strings.Index(rest, `"`); j >= 0 {
		rest = rest[:j]
	}
	return strings.Split(rest, ",")[0]
}

// abiPackageGoFiles 列出 abi 目录下的全部非测试 .go 文件（basename，排序）。
func abiPackageGoFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("读 abi 目录 %s: %v", dir, err)
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		out = append(out, e.Name())
	}
	sort.Strings(out)
	return out
}

func sortedPaths(fields []abiField) []string {
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}
