package api

// audit_s4_budget_wiring_test.go —— v2.8.1→HEAD 回归审计 S4-01/S4-02 的**缺口 A** 判据：
// 「有能力、没接线」在两个 `runtime.Request{}` 构造点上的**双向绑定**。
//
// ## 缺陷形态（对抗验证实测，可复跑）
//
// 仓库里有**两处**生产构造点把预算交给运行时：
//
//	干跑（发布/预检）：internal/wasmapp/api/publish.go        Budgets: dryRunBudgets(dryRun)
//	线上执行：        internal/wasmapp/appserver/serve.go     Budgets: s.requestBudgets()
//
// S4-01 的修法为两处都补了 `HostCallBudget`，但干跑那处的判据
// （`TestDryRunBudgetsCarryEffectiveBudgets`）**只直接调 `dryRunBudgets()`** —— 与真正的
// 调用点没有任何绑定。实测：把 publish.go 的 `Budgets:` 换回修前的"只传 Guest"形态后，
// api 包 `-run 'DryRun|Limits|Publish|Validate'` 全集（269.75 s）**零红**，
// 即 S4-01 自身缺陷形态（"能力有、调用路径没接线"）在第二个构造点上重演。
//
// ## 为什么判据落在**源码结构**上，而不是行为上
//
// 干跑的能力面是**空的**（`hostcap.Capabilities{AppID, Version}`，只有 `abi.ping` 探针），
// 所以 `HostCallBudget` 在干跑路径上**结构不可达**：没有任何宿主调用会走到"预算到点"
// 那条分支。行为级判据只能观测 guest 预算，而 guest 与宿主预算是**同一个字面量里的两个
// 字段** —— 把 `Budgets:` 整条换掉/换形态时，guest 那半仍可能照常工作，行为面咬不住
// "宿主调用预算没接线"。（这是"退回首选的源码级断言"的理由，不是偷懒。）
//
// 判据的实现方式：go/ast 解析生产源码，枚举**每一处** `runtime.Request{}` 复合字面量
// （按 import 路径解析类型，不认标识符拼写），取出 `Budgets` 取值表达式并**跟随仓内
// helper 调用**（最多 3 层，同包方法/函数与跨包函数都跟），直到看见真正的
// `runtime.InstanceLimits{...}` 字面量，然后断言：
//
//	① 构造点条数与位置 == 登记表（新构造点未登记即红 / 登记了却不存在也红）；
//	② 每个构造点都必须有 `Budgets` 字段；
//	③ 解析出的预算字段集合必须**同时**含 `GuestBudget` 与 `HostCallBudget`；
//	④ 这两个字段的取值必须是"取来的"（拒绝 `5 * time.Second` 这类常量形状）——
//	   写死的数在控制台改过之后就是一条静默的旧行为。
//
// 为什么不是"文件里出现过某字符串"：文本判据对本仓已登记的假绿形态无效 —— 把调用挪进
// 死代码分支、给 helper 改名再包一层、或把整段删掉只留注释，都能让文本匹配失真。
// 这里判的是**解析结果**（复合字面量的键集合 + 真实调用链），与文本形态无关；
// helper 改名/加一层包装/改成跨包函数都不会假红。
//
// ## 覆盖边界（如实登记）
//
//   - 覆盖：构造点的位置与条数、`Budgets` 字段存在性、预算字段集合覆盖两项、
//     取值不是常量形状。
//   - 不覆盖：数值是否等于控制台**当前值**（那是 TestDryRunBudgetsCarryEffectiveBudgets
//     / TestServe_ConsoleHostCallBudgetReachesRuntime / TestBudgetFieldsAreClampedNotWidened
//     的取值域 —— 本判据钉接线，那几条钉取值，两者互补）；
//     也不覆盖"用**具名常量**写死"（`const hc = 10 * time.Second` 再赋进去），
//     那种形态与"取来的"在语法同形，只能靠行为级用例兜。
//   - 扫描面 = `internal/`、`cmd/`、`scripts/` 三个登记根下的**非测试** `.go` 文件里的
//     **限定名**构造点（`<rt>.Request{}`）。runtime 包内部若用非限定 `Request{}` 构造，
//     不在本判据取值域内（今天没有这种生产构造点；有的话会在同一包内自证）。
//
// 变异验证（实跑，2026-10-04，隔离副本）：
//   - 抽掉 publish.go 的干跑接线（换回 `runtime.InstanceLimits{GuestBudget: …}`）⇒ 本用例红；
//   - 抽掉 serve.go `requestBudgets()` 里的 `HostCallBudget` 一行 ⇒ 本用例红；
//   - 掏空判定（要求字段清空 / 解析恒成功）⇒ TestAuditS4BudgetWiringSelfCheck 的负例红。

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const (
	// wasmRuntimeImportPath 是 `runtime.Request` / `runtime.InstanceLimits` 的类型来源。
	wasmRuntimeImportPath = "github.com/picoaide/picoaide/internal/wasmapp/runtime"
	// wasmModuleImportPrefix 用来把跨包调用映射回仓内目录（只跟本仓实现，外部包 fail-loud）。
	wasmModuleImportPrefix = "github.com/picoaide/picoaide/"
	// maxBudgetCallDepth 是"预算来源"允许的包装层数（helper → helper → 字面量）。
	maxBudgetCallDepth = 3
)

// budgetWiringRegistry 是**登记表**：生产代码里每一处 `runtime.Request{}` 构造点都要在这里
// 登记（文件 → 条数）。双向对拍：实际存在却没登记 ⇒ 红；登记了却不存在/条数不符 ⇒ 红。
//
// 新增构造点时**必须**同时回答"这一处的预算从哪来"（判据会解析并检查两个字段）。
var budgetWiringRegistry = map[string]int{
	"internal/wasmapp/api/publish.go":     1, // 干跑：Budgets: dryRunBudgets(dryRun)
	"internal/wasmapp/appserver/serve.go": 1, // 执行：Budgets: s.requestBudgets()
}

// budgetWiringScanRoots 是判据的扫描面（相对 server 模块根）。缺失即红 ——
// 扫描面缩水不得静默通过（本仓已登记的守卫教训）。
var budgetWiringScanRoots = []string{"internal", "cmd", "scripts"}

// budgetWiringRequiredFields 是每个构造点必须覆盖的预算字段（缺任一项 ⇒ 那条调用路径
// 回落到编译期常量，控制台改动静默失效）。
var budgetWiringRequiredFields = []string{"GuestBudget", "HostCallBudget"}

// ---------------------------------------------------------------------------
// 解析核心（可被合成夹具驱动 ⇒ 判据自身可自检）
// ---------------------------------------------------------------------------

type parsedPackage struct {
	dir     string
	fset    *token.FileSet
	files   map[string]*ast.File
	imports map[string]map[string]string // 文件 → (本地包名 → import path)
	funcs   map[string][]*ast.FuncDecl   // 包级函数
	methods map[string][]*ast.FuncDecl   // 方法（按方法名索引）
	fileOf  map[*ast.FuncDecl]string     // 声明 → 所在文件
}

func parsePackageSources(dir string, sources map[string]string) (*parsedPackage, error) {
	p := &parsedPackage{
		dir:     dir,
		fset:    token.NewFileSet(),
		files:   map[string]*ast.File{},
		imports: map[string]map[string]string{},
		funcs:   map[string][]*ast.FuncDecl{},
		methods: map[string][]*ast.FuncDecl{},
		fileOf:  map[*ast.FuncDecl]string{},
	}
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		f, err := parser.ParseFile(p.fset, name, sources[name], parser.SkipObjectResolution)
		if err != nil {
			return nil, fmt.Errorf("解析 %s/%s 失败: %w", dir, name, err)
		}
		p.files[name] = f
		imp := map[string]string{}
		for _, spec := range f.Imports {
			path := strings.Trim(spec.Path.Value, `"`)
			local := path
			if i := strings.LastIndex(path, "/"); i >= 0 {
				local = path[i+1:]
			}
			if spec.Name != nil {
				local = spec.Name.Name
			}
			if local == "_" || local == "." {
				continue
			}
			imp[local] = path
		}
		p.imports[name] = imp
		for _, decl := range f.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok {
				continue
			}
			p.fileOf[fd] = name
			if fd.Recv == nil {
				p.funcs[fd.Name.Name] = append(p.funcs[fd.Name.Name], fd)
			} else {
				p.methods[fd.Name.Name] = append(p.methods[fd.Name.Name], fd)
			}
		}
	}
	return p, nil
}

func parsePackageDir(dir string) (*parsedPackage, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	sources := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".go") || strings.HasSuffix(e.Name(), "_test.go") {
			continue
		}
		b, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			return nil, err
		}
		sources[e.Name()] = string(b)
	}
	if len(sources) == 0 {
		return nil, fmt.Errorf("包目录 %s 里没有非测试 .go 文件（扫描面缩水）", dir)
	}
	return parsePackageSources(dir, sources)
}

// isInstanceLimits 判断复合字面量的类型是不是本仓 runtime 包的 InstanceLimits
// （按 import 路径解析 ⇒ 别名/改名都不影响）。
func (p *parsedPackage) isInstanceLimits(cl *ast.CompositeLit, fileKey string) bool {
	sel, ok := cl.Type.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "InstanceLimits" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	if !ok {
		return false
	}
	return p.imports[fileKey][id.Name] == wasmRuntimeImportPath
}

type wiringSite struct {
	fileRel string // 相对 server 模块根
	fileKey string // 包内文件名
	pkg     *parsedPackage
	lit     *ast.CompositeLit
	line    int
}

type budgetResolution struct {
	fields  map[string]ast.Expr
	imports map[string]string // 字面量所在文件的 import 表（判常量形状要用）
	trace   []string          // 解析链路（失败信息里给出，便于定位）
}

type pkgCache struct {
	moduleRoot string
	pkgs       map[string]*parsedPackage
}

func (c *pkgCache) dirPackage(dir string) (*parsedPackage, error) {
	if p, ok := c.pkgs[dir]; ok {
		return p, nil
	}
	p, err := parsePackageDir(dir)
	if err != nil {
		return nil, err
	}
	c.pkgs[dir] = p
	return p, nil
}

// enumerateWiringSites 扫登记根，找出所有 `<runtime 包名>.Request{}` 复合字面量。
func enumerateWiringSites(moduleRoot string) ([]wiringSite, error) {
	cache := &pkgCache{moduleRoot: moduleRoot, pkgs: map[string]*parsedPackage{}}
	var sites []wiringSite
	for _, root := range budgetWiringScanRoots {
		abs := filepath.Join(moduleRoot, filepath.FromSlash(root))
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			return nil, fmt.Errorf("登记扫描根 %s 不可用（扫描面缩水必须 fail-loud）: %v", root, err)
		}
		parsedFiles := 0
		err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, werr error) error {
			if werr != nil {
				return werr
			}
			if d.IsDir() {
				base := d.Name()
				if base == "testdata" || base == "node_modules" || strings.HasPrefix(base, ".") {
					return fs.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			dir := filepath.Dir(path)
			pkg, perr := cache.dirPackage(dir)
			if perr != nil {
				return perr
			}
			name := filepath.Base(path)
			f, ok := pkg.files[name]
			if !ok {
				return nil
			}
			parsedFiles++
			rtLocal := ""
			for local, ip := range pkg.imports[name] {
				if ip == wasmRuntimeImportPath {
					rtLocal = local
				}
			}
			if rtLocal == "" {
				return nil
			}
			rel, rerr := filepath.Rel(moduleRoot, path)
			if rerr != nil {
				return rerr
			}
			ast.Inspect(f, func(n ast.Node) bool {
				cl, ok := n.(*ast.CompositeLit)
				if !ok {
					return true
				}
				sel, ok := cl.Type.(*ast.SelectorExpr)
				if !ok || sel.Sel.Name != "Request" {
					return true
				}
				id, ok := sel.X.(*ast.Ident)
				if !ok || id.Name != rtLocal {
					return true
				}
				sites = append(sites, wiringSite{
					fileRel: filepath.ToSlash(rel),
					fileKey: name,
					pkg:     pkg,
					lit:     cl,
					line:    pkg.fset.Position(cl.Pos()).Line,
				})
				return true
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
		if parsedFiles == 0 {
			return nil, fmt.Errorf("登记扫描根 %s 里没有一个可解析的非测试 .go 文件（扫描面缩水必须 fail-loud）", root)
		}
	}
	return sites, nil
}

// resolveSite 解析一个构造点的 `Budgets` 取值，得到"实际被填的字段集合"。
func (c *pkgCache) resolveSite(site wiringSite) (*budgetResolution, error) {
	var expr ast.Expr
	for _, elt := range site.lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		if id, ok := kv.Key.(*ast.Ident); ok && id.Name == "Budgets" {
			expr = kv.Value
			break
		}
	}
	if expr == nil {
		return nil, fmt.Errorf("runtime.Request 字面量里没有 Budgets 字段 —— 这条调用路径的预算全部回落到编译期常量")
	}
	return c.resolve(expr, site.pkg, site.fileKey, maxBudgetCallDepth)
}

func (c *pkgCache) resolve(expr ast.Expr, pkg *parsedPackage, fileKey string, depth int) (*budgetResolution, error) {
	expr = unwrapBudgetExpr(expr)
	switch e := expr.(type) {
	case *ast.CompositeLit:
		if !pkg.isInstanceLimits(e, fileKey) {
			return nil, fmt.Errorf("预算字面量不是 runtime.InstanceLimits：%s", describeExpr(e))
		}
		res := &budgetResolution{fields: map[string]ast.Expr{}, imports: pkg.imports[fileKey]}
		for _, elt := range e.Elts {
			kv, ok := elt.(*ast.KeyValueExpr)
			if !ok {
				continue
			}
			id, ok := kv.Key.(*ast.Ident)
			if !ok {
				continue
			}
			res.fields[id.Name] = kv.Value
		}
		res.trace = []string{fmt.Sprintf("%s: runtime.InstanceLimits 字面量", fileKey)}
		return res, nil
	case *ast.CallExpr:
		if depth <= 0 {
			return nil, fmt.Errorf("预算来源的包装层数超过 %d 层，判据无法解析", maxBudgetCallDepth)
		}
		decl, dpkg, dfile, label, err := c.resolveCallee(e, pkg, fileKey)
		if err != nil {
			return nil, err
		}
		return c.resolveReturns(decl, dpkg, dfile, depth-1, label)
	default:
		return nil, fmt.Errorf("预算来源既不是 runtime.InstanceLimits 字面量也不是仓内函数调用：%s", describeExpr(expr))
	}
}

func (c *pkgCache) resolveReturns(decl *ast.FuncDecl, pkg *parsedPackage, fileKey string, depth int, label string) (*budgetResolution, error) {
	if decl.Body == nil {
		return nil, fmt.Errorf("%s 没有函数体，判据无法解析它的预算", label)
	}
	var out *budgetResolution
	returns := 0
	var problems []string
	ast.Inspect(decl.Body, func(n ast.Node) bool {
		if _, ok := n.(*ast.FuncLit); ok {
			return false // 闭包里的 return 不是这条函数的返回值
		}
		rs, ok := n.(*ast.ReturnStmt)
		if !ok || len(rs.Results) == 0 {
			return true
		}
		returns++
		res, err := c.resolve(rs.Results[0], pkg, fileKey, depth)
		if err != nil {
			problems = append(problems, err.Error())
			return true
		}
		if out == nil {
			res.trace = append([]string{label}, res.trace...)
			out = res
			return true
		}
		for k, v := range res.fields {
			out.fields[k] = v
		}
		return true
	})
	if returns == 0 {
		return nil, fmt.Errorf("%s 里没有 return 语句，判据无法解析它的预算", label)
	}
	if len(problems) > 0 {
		return nil, fmt.Errorf("%s 的返回点无法解析：%s", label, strings.Join(problems, "；"))
	}
	return out, nil
}

func (c *pkgCache) resolveCallee(call *ast.CallExpr, pkg *parsedPackage, fileKey string) (*ast.FuncDecl, *parsedPackage, string, string, error) {
	imports := pkg.imports[fileKey]
	switch fn := unwrapBudgetExpr(call.Fun).(type) {
	case *ast.Ident:
		if ds := pkg.funcs[fn.Name]; len(ds) == 1 {
			return ds[0], pkg, pkg.fileOf[ds[0]], "函数 " + fn.Name, nil
		}
		return nil, nil, "", "", fmt.Errorf("包内函数 %s 找不到或不唯一（判据要求预算由仓内唯一实现构造）", fn.Name)
	case *ast.SelectorExpr:
		name := fn.Sel.Name
		id, ok := fn.X.(*ast.Ident)
		if !ok {
			return nil, nil, "", "", fmt.Errorf("无法解析预算来源 %s（接收者不是标识符）", name)
		}
		if ip, isImport := imports[id.Name]; isImport {
			if !strings.HasPrefix(ip, wasmModuleImportPrefix) {
				return nil, nil, "", "", fmt.Errorf("预算来源指向本仓之外的包 %s，判据的取值域只覆盖本仓实现", ip)
			}
			dir := filepath.Join(c.moduleRoot, filepath.FromSlash(strings.TrimPrefix(ip, wasmModuleImportPrefix)))
			dpkg, err := c.dirPackage(dir)
			if err != nil {
				return nil, nil, "", "", fmt.Errorf("解析 %s 失败: %w", ip, err)
			}
			if ds := dpkg.funcs[name]; len(ds) == 1 {
				return ds[0], dpkg, dpkg.fileOf[ds[0]], ip + "." + name, nil
			}
			return nil, nil, "", "", fmt.Errorf("跨包函数 %s.%s 找不到或不唯一", ip, name)
		}
		if ds := pkg.methods[name]; len(ds) >= 1 {
			return ds[0], pkg, pkg.fileOf[ds[0]], "方法 " + name, nil
		}
		return nil, nil, "", "", fmt.Errorf("方法 %s 不在包 %s 里（判据无法解析预算来源）", name, pkg.dir)
	default:
		return nil, nil, "", "", fmt.Errorf("预算来源的调用目标无法解析（%T）", call.Fun)
	}
}

func unwrapBudgetExpr(expr ast.Expr) ast.Expr {
	for {
		switch e := expr.(type) {
		case *ast.ParenExpr:
			expr = e.X
		case *ast.UnaryExpr:
			if e.Op == token.AND {
				expr = e.X
				continue
			}
			return expr
		default:
			return expr
		}
	}
}

// constantShaped 判断表达式是不是"写死的常量形状"：字面量、常量算术、以及
// 导入包上的选择子（`time.Second` 这类）。`l.HostCallBudget()` 是调用，不算常量。
func constantShaped(expr ast.Expr, imports map[string]string) bool {
	expr = unwrapBudgetExpr(expr)
	switch e := expr.(type) {
	case *ast.BasicLit:
		return true
	case *ast.ParenExpr:
		return constantShaped(e.X, imports)
	case *ast.UnaryExpr:
		return constantShaped(e.X, imports)
	case *ast.BinaryExpr:
		return constantShaped(e.X, imports) && constantShaped(e.Y, imports)
	case *ast.SelectorExpr:
		if id, ok := e.X.(*ast.Ident); ok {
			if _, isPkg := imports[id.Name]; isPkg {
				return true
			}
		}
		return false
	}
	return false
}

// budgetWiringProblems 是**判定函数**（判据本体）：返回空 = 这一处的接线合格。
func budgetWiringProblems(res *budgetResolution) []string {
	if res == nil {
		return []string{"预算来源无法解析"}
	}
	var problems []string
	for _, field := range budgetWiringRequiredFields {
		v, ok := res.fields[field]
		if !ok {
			problems = append(problems, fmt.Sprintf("预算没有覆盖 %s（解析到的字段：%s）",
				field, strings.Join(sortedFieldNames(res.fields), ", ")))
			continue
		}
		if constantShaped(v, res.imports) {
			problems = append(problems, fmt.Sprintf("%s 是写死的常量（%s）—— 预算必须取自当前生效的限制项", field, describeExpr(v)))
		}
	}
	return problems
}

func sortedFieldNames(fields map[string]ast.Expr) []string {
	names := make([]string, 0, len(fields))
	for name := range fields {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func describeExpr(expr ast.Expr) string {
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, token.NewFileSet(), expr); err != nil {
		return fmt.Sprintf("%T", expr)
	}
	s := buf.String()
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

// serverModuleRoot 从当前测试目录上溯到含 go.mod 的 server 模块根。
func serverModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录失败: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("从 %s 上溯没有找到 go.mod（server 模块根）", dir)
		}
		dir = parent
	}
}

// ---------------------------------------------------------------------------
// 判据本体
// ---------------------------------------------------------------------------

func TestAuditS4RuntimeRequestBudgetWiring(t *testing.T) {
	root := serverModuleRoot(t)
	sites, err := enumerateWiringSites(root)
	if err != nil {
		t.Fatalf("枚举 runtime.Request 构造点失败（扫描面/解析面 fail-loud）: %v", err)
	}
	if len(sites) == 0 {
		t.Fatalf("一个 runtime.Request 构造点都没找到 —— 判据的扫描面与真实构造面不重合（缩面不得静默通过）")
	}

	// ① 登记表双向对拍：实际 ↔ 登记。
	got := map[string]int{}
	for _, s := range sites {
		got[s.fileRel]++
	}
	for file, want := range budgetWiringRegistry {
		if n := got[file]; n != want {
			t.Errorf("登记表说 %s 有 %d 处 runtime.Request 构造点，实际 %d 处 —— 构造点增删必须同步登记表（否则新构造点会绕过预算判据）",
				file, want, n)
		}
	}
	var unregistered []string
	for file, n := range got {
		if _, ok := budgetWiringRegistry[file]; !ok {
			unregistered = append(unregistered, fmt.Sprintf("%s（%d 处）", file, n))
		}
	}
	sort.Strings(unregistered)
	if len(unregistered) > 0 {
		t.Errorf("发现未登记的 runtime.Request 构造点：%s —— 每一处都必须自带完整预算（%s）并登记进 budgetWiringRegistry",
			strings.Join(unregistered, ", "), strings.Join(budgetWiringRequiredFields, " + "))
	}

	// ② 每一处的预算接线：解析取值表达式（跟随仓内 helper）并判定。
	cache := &pkgCache{moduleRoot: root, pkgs: map[string]*parsedPackage{}}
	for _, site := range sites {
		res, rerr := cache.resolveSite(site)
		if rerr != nil {
			t.Errorf("%s:%d 的运行时预算来源无法解析：%v", site.fileRel, site.line, rerr)
			continue
		}
		if problems := budgetWiringProblems(res); len(problems) > 0 {
			t.Errorf("%s:%d 的运行时预算接线不完整：%s\n（解析链路：%s）",
				site.fileRel, site.line, strings.Join(problems, "；"), strings.Join(res.trace, " → "))
			continue
		}
		t.Logf("OK %s:%d 预算接线：%s → 字段 %v",
			site.fileRel, site.line, strings.Join(res.trace, " → "), sortedFieldNames(res.fields))
	}
}

// TestAuditS4BudgetWiringSelfCheck 是**量具自检**：同一套解析/判定核心必须能区分
// "接了线"与三种"没接线/写死"的形态。没有它，把 budgetWiringProblems 掏空成恒返回 nil
// 也能让主用例全绿（本仓已登记的"恒真断言"假绿形态）。
func TestAuditS4BudgetWiringSelfCheck(t *testing.T) {
	const fixture = `package fixture

import (
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

func use(l applimits.Limits) {
	_ = runtime.Request{ %s }
}

func budgets(l applimits.Limits) runtime.InstanceLimits {
	return runtime.InstanceLimits{
		GuestBudget:    l.DryRunBudget(),
		HostCallBudget: l.HostCallBudget(),
	}
}
`

	cases := []struct {
		name        string
		fields      string
		wantErr     string // 非空 = 期望解析阶段就报错且含该子串
		wantProblem string // 非空 = 期望判定出问题且含该子串
	}{
		{
			name:   "接了线（helper 里两个字段都从生效限制项取）",
			fields: "Budgets: budgets(l), Funcs: nil",
		},
		{
			name:        "修前的只传 Guest 形态（干跑接线被抽掉）",
			fields:      "Budgets: runtime.InstanceLimits{GuestBudget: l.DryRunBudget()}, Funcs: nil",
			wantProblem: "HostCallBudget",
		},
		{
			name:    "整个 Budgets 字段缺席",
			fields:  "Funcs: nil",
			wantErr: "Budgets",
		},
		{
			name:        "两个字段都在但写死成常量",
			fields:      "Budgets: runtime.InstanceLimits{GuestBudget: 30 * time.Second, HostCallBudget: 5 * time.Second}, Funcs: nil",
			wantProblem: "常量",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := resolveSyntheticSite(t, fmt.Sprintf(fixture, tc.fields))
			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("期望解析阶段报错（含 %q），实际解析成功（字段：%v）—— 量具咬不住这种形态", tc.wantErr, sortedFieldNames(res.fields))
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("解析错误 %q 不含期望子串 %q", err.Error(), tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("解析失败: %v", err)
			}
			problems := budgetWiringProblems(res)
			if tc.wantProblem == "" {
				if len(problems) > 0 {
					t.Fatalf("这个形态应当判定合格，实际报出：%v", problems)
				}
				return
			}
			joined := strings.Join(problems, "；")
			if !strings.Contains(joined, tc.wantProblem) {
				t.Fatalf("判定结果 %q 不含期望子串 %q —— 量具咬不住这种形态", joined, tc.wantProblem)
			}
		})
	}
}

func resolveSyntheticSite(t *testing.T, src string) (*budgetResolution, error) {
	t.Helper()
	pkg, err := parsePackageSources("synthetic", map[string]string{"fixture.go": src})
	if err != nil {
		t.Fatalf("合成夹具自身解析失败（判据的解析核心有问题）: %v", err)
	}
	var (
		site    *ast.CompositeLit
		fileKey string
	)
	for name, f := range pkg.files {
		rtLocal := ""
		for local, ip := range pkg.imports[name] {
			if ip == wasmRuntimeImportPath {
				rtLocal = local
			}
		}
		if rtLocal == "" {
			continue
		}
		ast.Inspect(f, func(n ast.Node) bool {
			cl, ok := n.(*ast.CompositeLit)
			if !ok || site != nil {
				return true
			}
			sel, ok := cl.Type.(*ast.SelectorExpr)
			if !ok || sel.Sel.Name != "Request" {
				return true
			}
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == rtLocal {
				site = cl
				fileKey = name
			}
			return true
		})
	}
	if site == nil {
		t.Fatalf("合成夹具里没有 runtime.Request 构造点（判据的解析核心有问题）")
	}
	cache := &pkgCache{moduleRoot: t.TempDir(), pkgs: map[string]*parsedPackage{"synthetic": pkg}}
	return cache.resolveSite(wiringSite{fileRel: "synthetic/fixture.go", fileKey: fileKey, pkg: pkg, lit: site})
}
