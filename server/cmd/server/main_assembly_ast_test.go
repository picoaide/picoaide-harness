package main

// R21C-04（审计 2026-09-26，P3）的判据工具：`main()` 装配行的**可达性**判定。
//
// ## 缺陷形态
//
// 本包原有的 9 条"源码级判据"（schedulers / background_sync / gateway_reaper /
// audit_chain / audit_retention / token_retention / usage_retention / legacy_config）
// 都是 `strings.Index(text, "<调用字面量>")` 的存在性判定。存在性 ≠ 可达性：
// 把同一行包进 `if false { … }` 后字符串与位置**全部保持不变**，判据照样绿
// （审计实测 `m_modelsync_deadbranch` ⇒ `go test ./cmd/server/` exit=0），
// 而注释里却写着"挪进不执行的分支时这一条兜住"。
//
// ## 判据（AST 级"不在静态不可执行的构造里"）
//
// 解析 `main.go` 的 AST，在 `func main()` 的函数体里找**打印出来包含 match** 的
// 调用表达式 / 赋值语句，然后沿祖先链判定它有没有落在静态不可执行的构造里：
//
//   - `if <编译期常量假> { … }` 的 then 分支；
//   - `if <编译期常量真> { … } else { … }` 的 else 分支；
//   - 条件为编译期常量假的 `for`；
//   - 无 tag 的 `switch { case <编译期常量假>: … }` 的 case 体；
//   - range 一个空集合（`nil` / 空复合字面量）；
//   - 藏在**没有被装配到任何接缝上的**函数字面量里（不是赋值右侧、也不是立即调用）。
//
// 常量判定走 `go/constant`（支持 `false`/`true`、字面量、括号、`!`/一元负号、
// `&&`/`||`/比较/四则/移位/按位、内建 `len` 作用于常量字符串），**并且解析命名常量**
// （`const v3X = false` 之后的 `if v3X { … }`）—— 只钉字面量 `false` 的判据等于只挡一个
// 字符串（R22-V3-B3 实测：命名常量形态曾 exit=0）。
//
// ## 匹配必须先"看得见真调用点"（R23-V3-B4）
//
// 命中的判据不是"打印文本包含 match"，而是"**字符串字面量之外**的打印文本包含 match"
// （`printNodeWithoutStringLiterals`）：修前删掉真调用、改写
// `_ = "serverauth.SetBuildVersion(version)"`（同文本的字符串字面量）就能让判据照样
// `found=true`，而那一行什么都不会执行 —— 这正是 R21C-04 想消除的"存在性文本匹配"形状。
// 现在这类诱饵被判 `found=false`（= 装配行缺失 ⇒ 红）。
//
// ## 边界（诚实声明，不假装完备）
//
// `select` 的 case 体、`return` 之后的语句、`goto`、带 tag 的 `switch`（需要值流分析）、
// **包级 `var`**（可能被同包其它文件赋值，本判据只解析 main.go ⇒ 一律按运行期值处理）、
// 以及**调用方看不到的运行期条件**（`if os.Getenv("X") != ""`）都不在本判据的判别力内。
// 要挡这些形态需要真正的可达性分析（`go/types` + CFG），代价远超收益；本判据的目标是
// 审计登记的那一类"整行删掉/包进不执行分支仍绿"。
//
// 实测对照（temp/r21/fix-16/REPORT.md 与 temp/r21/fix-21/REPORT.md，漏杀形态逐条落盘 exit 码）：
//
//	`const v3X = false; if v3X { … }`        ⇒ **挡住**（解析命名常量）
//	`var x = false; if x { … }`（main 内）   ⇒ **挡住**（局部 var：初值可折且从未被写）
//	`const x = len("abc") == 0; if x { … }`  ⇒ **挡住**（内建 len 折叠，R23-V3-B6）
//	`const x = (1 << 62) < 0; if x { … }`    ⇒ **挡住**（移位/溢出语义走 go/constant）
//	`for range "" { … }` / `for range []int(nil) { … }` ⇒ **挡住**（R23-V3-B6）
//	同文本字符串字面量诱饵                        ⇒ **挡住**（诱饵不算命中，R23-V3-B4）
//	`switch { case 1 > 2: … }`               ⇒ **挡住**（无 tag switch 的恒假 case 体）
//	`if os.Getenv("…") != "" { … }`          ⇒ 挡不住（运行期条件；判据按"可达"处理，**不误杀**）
//	`switch <tag> { case …: … }`             ⇒ 挡不住（值流分析）
//	包级 `var x = false; if x { … }`          ⇒ 挡不住（跨文件赋值不可见）—— 见 escape matrix 里
//	                                            那条**如实登记为逃逸**的用例，通过行不得声称它被挡住

import (
	"go/ast"
	"go/constant"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
	"testing"
)

// assemblySite 是 `main()` 里某个装配点的判定结果。
type assemblySite struct {
	// Found 表示 main() 里存在"打印文本包含 match"的调用/赋值语句。
	Found bool
	// Matched 是命中的那段的打印文本（诊断用；Found=false 时为空）。
	Matched string
	// Dead 表示命中的那段落在静态不可执行的构造里。
	Dead bool
	// Why 是 Dead 的原因（也是 Found=false 之外的诊断信息）。
	Why string
}

// constEnv 是判据用的**编译期常量环境**：名字 → 值。
//
// 为什么需要它（R22-V3-B3，复审 2026-09-26，P3）：修前的 `constValue` 只认字面量，
// 于是 `const v3AuthBrowsersDisabled = false; if v3AuthBrowsersDisabled { … }` 这种
// **同一个编译期常量、换个写法**的形态实跑 exit=0 —— 而文件头自称"换个写法的一样
// 挡得住"。那正是本判据自己要守的那 7 行装配。
//
// 收集规则（保守优先：宁可漏杀，不可误杀活代码）：
//   - 顶层 `const` 声明块逐条折值入表（同块内前向引用可解析，`const ( a = false; b = a )`）；
//   - `main()` 体内的 `const` 声明同样入表（更内层的作用域）；
//   - **任何**把同名标识符当变量声明的形态（`x := …` / `var x …` / range 变量 / 形参）
//     一律把该名字从表里摘掉 —— 变量不是编译期常量，绝不能因为"包级有个同名常量"
//     就把活代码判死；
//   - **局部** `var x = <可折初值>` 在"该名字在 main() 里从未被写过、也没被取过地址"
//     时按常量处理（R23-V3-B5：`var x = false; if x { … }` 是命名常量的一 token 变体，
//     修前实跑 exit=0）；**包级 var 一律不折**（可能被同包其它文件赋值，本判据只解析
//     main.go ⇒ 如实登记为逃逸边界，见 escape matrix）；
//   - 同名不同值（真歧义）时整个名字失效（同样为了不误杀）。
type constEnv struct {
	values    map[string]constant.Value
	invisible map[string]bool
	// varFolds 是"待定"的 var 折叠（局部 var，初值可折）：只有在确认名字**从未被写**之后
	// 才提升进 values —— 否则 `var x = false; …; x = compute(); if x { … }` 会被误杀。
	varFolds map[string]constant.Value
	// written 是"被写过"的名字（`=` 赋值 / `++`·`--` / `&x` 取址 / range 赋值目标）。
	written map[string]bool
}

func newConstEnv(f *ast.File, body *ast.BlockStmt) constEnv {
	env := constEnv{
		values:    map[string]constant.Value{},
		invisible: map[string]bool{},
		varFolds:  map[string]constant.Value{},
		written:   map[string]bool{},
	}
	env.collectFileConsts(f)
	if body != nil {
		env.collectMainScoped(body)
	}
	return env
}

// collectFileConsts 收集**包级** `const` 声明。
func (e constEnv) collectFileConsts(f *ast.File) {
	for _, d := range f.Decls {
		gd, ok := d.(*ast.GenDecl)
		if !ok || gd.Tok != token.CONST {
			continue
		}
		e.collectConstSpecs(gd)
	}
}

// collectConstSpecs 逐条折值（`i >= len(Values)` = 继承上一行表达式，折不动 ⇒ 跳过）。
func (e constEnv) collectConstSpecs(gd *ast.GenDecl) {
	for _, spec := range gd.Specs {
		vs, ok := spec.(*ast.ValueSpec)
		if !ok {
			continue
		}
		for i, name := range vs.Names {
			if i >= len(vs.Values) {
				continue
			}
			e.put(name.Name, constValue(vs.Values[i], e))
		}
	}
}

// collectMainScoped 走两遍 main() 体：
//
//	第一遍：局部 const 入表；变量声明（`var` / `:=` / range 变量 / 形参）把名字摘掉，
//	        同时把"初值可折的局部 var"记进 varFolds 待定表；
//	第二遍：收集"被写过"的名字，再把从未被写的待定 var 提升为常量。
//
// 两遍是必需的：`var x = false; …; x = compute()` 与 `var x = false; if x {…}` 只在
// "有没有第二遍的写入检查"上不同（R23-V3-B5 的形态正是前者被当成后者的反面 ——
// 修前一律 `hide`，于是**后者也逃逸**）。
func (e constEnv) collectMainScoped(body *ast.BlockStmt) {
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.DeclStmt:
			gd, ok := x.Decl.(*ast.GenDecl)
			if !ok {
				return true
			}
			switch gd.Tok {
			case token.CONST:
				e.collectConstSpecs(gd)
			case token.VAR:
				for _, spec := range gd.Specs {
					vs, ok := spec.(*ast.ValueSpec)
					if !ok {
						continue
					}
					for i, name := range vs.Names {
						if i < len(vs.Values) {
							if v := constValue(vs.Values[i], e); v != nil {
								e.varFolds[name.Name] = v
								continue
							}
						}
						e.hide(name.Name)
					}
				}
			}
		case *ast.AssignStmt:
			if x.Tok == token.DEFINE {
				for _, lhs := range x.Lhs {
					if id, ok := lhs.(*ast.Ident); ok {
						e.hide(id.Name)
					}
				}
			}
		case *ast.RangeStmt:
			if x.Tok == token.DEFINE {
				for _, id := range []ast.Expr{x.Key, x.Value} {
					if ident, ok := id.(*ast.Ident); ok {
						e.hide(ident.Name)
					}
				}
			}
		case *ast.FuncLit:
			e.hideFields(x.Type.Params)
		case *ast.FuncDecl:
			e.hideFields(x.Type.Params)
		}
		return true
	})
	e.collectWrites(body)
	e.promoteVarFolds()
}

// collectWrites 收集 main() 里**被写过**的名字：`=` 赋值（含 range 的赋值形式）、
// `++`/`--`、以及 `&name` 取址（地址一旦外流，本判据就不再声称知道它的值）。
//
// 闭包内对捕获变量的赋值同样会被 `ast.Inspect` 走到（它下潜 FuncLit）⇒
// `x := false; f := func(){ x = true }; f(); if x {…}` 不会被误折。
func (e constEnv) collectWrites(body *ast.BlockStmt) {
	ast.Inspect(body, func(n ast.Node) bool {
		switch x := n.(type) {
		case *ast.AssignStmt:
			if x.Tok == token.DEFINE {
				return true // 声明不是写入（同名遮蔽由上一步的 hide 处理）
			}
			for _, lhs := range x.Lhs {
				if id, ok := lhs.(*ast.Ident); ok {
					e.written[id.Name] = true
				}
			}
		case *ast.IncDecStmt:
			if id, ok := x.X.(*ast.Ident); ok {
				e.written[id.Name] = true
			}
		case *ast.UnaryExpr:
			if x.Op == token.AND {
				if id, ok := x.X.(*ast.Ident); ok {
					e.written[id.Name] = true
				}
			}
		case *ast.RangeStmt:
			if x.Tok == token.ASSIGN {
				for _, id := range []ast.Expr{x.Key, x.Value} {
					if ident, ok := id.(*ast.Ident); ok {
						e.written[ident.Name] = true
					}
				}
			}
		}
		return true
	})
}

// promoteVarFolds 把"初值可折 + 从未被写 + 未被遮蔽"的局部 var 提升为常量。
func (e constEnv) promoteVarFolds() {
	for name, v := range e.varFolds {
		if e.written[name] || e.invisible[name] {
			continue
		}
		e.values[name] = v
	}
}

func (e constEnv) hideFields(fl *ast.FieldList) {
	if fl == nil {
		return
	}
	for _, f := range fl.List {
		for _, name := range f.Names {
			e.hide(name.Name)
		}
	}
}

// put 写一条（同名不同值 ⇒ 判为歧义，整个名字失效）。
func (e constEnv) put(name string, v constant.Value) {
	if v == nil || e.invisible[name] {
		return
	}
	if prev, ok := e.values[name]; ok {
		if prev.Kind() != v.Kind() || prev.String() != v.String() {
			e.hide(name)
		}
		return
	}
	e.values[name] = v
}

// hide 把名字从常量表里摘掉（此后按"运行期值"处理 ⇒ 判为可达）。
func (e constEnv) hide(name string) {
	delete(e.values, name)
	e.invisible[name] = true
}

// lookup 查一个标识符的编译期值（未知 = nil = 当作运行期值）。
func (e constEnv) lookup(name string) constant.Value {
	if e.invisible[name] {
		return nil
	}
	return e.values[name]
}

// findMainAssemblySite 在 src 的 `func main()` 函数体里查找装配点并判定可达性。
func findMainAssemblySite(src []byte, match string) (assemblySite, error) {
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "main.go", src, 0)
	if err != nil {
		return assemblySite{}, err
	}
	var body *ast.BlockStmt
	for _, d := range f.Decls {
		if fd, ok := d.(*ast.FuncDecl); ok && fd.Name != nil && fd.Name.Name == "main" && fd.Recv == nil {
			body = fd.Body
			break
		}
	}
	if body == nil {
		return assemblySite{}, nil // 没有 main()：Found=false（判据会红）
	}
	env := newConstEnv(f, body)

	var stack []ast.Node
	var found *assemblySite
	bestDepth := -1
	ast.Inspect(body, func(n ast.Node) bool {
		if n == nil {
			stack = stack[:len(stack)-1]
			return true
		}
		stack = append(stack, n)
		switch n.(type) {
		case *ast.CallExpr, *ast.AssignStmt:
			text := printNodeWithoutStringLiterals(fset, n)
			if !strings.Contains(text, match) {
				return true
			}
			// **最深命中优先**：外层语句的打印文本天然包含内层节点（例如
			// `_ = func(){ startThing() }` 这条赋值语句就包含内层调用），只取最外层
			// 会把"藏在未装配闭包里"的形态误判成可达。取最内层命中，才能让判定
			// 落在真正被匹配的那一段上。
			if len(stack) <= bestDepth {
				return true
			}
			bestDepth = len(stack)
			site := assemblySite{Found: true, Matched: text}
			if why := staticDeadReason(stack[:len(stack)-1], n, env); why != "" {
				site.Dead, site.Why = true, why
			}
			found = &site
		}
		return true
	})
	if found == nil {
		return assemblySite{}, nil
	}
	return *found, nil
}

// printNode 把 AST 节点打印成 gofmt 形状的源码（注释已在解析期丢弃）。
func printNode(fset *token.FileSet, n ast.Node) string {
	var b strings.Builder
	if err := printer.Fprint(&b, fset, n); err != nil {
		return ""
	}
	return b.String()
}

// printNodeWithoutStringLiterals 同 printNode，但把节点内的**字符串字面量**替换成 `"…"`。
//
// 为什么匹配必须先把字面量挖掉（R23-V3-B4，复审 2026-09-27，P3）：命中原先只看
// "打印文本包含 match"，于是删掉真调用、写一行同文本的字面量即可骗过判据 ——
// 真 `main.go` 实测：
//
//	_ = "serverauth.SetBuildVersion(version)"   ⇒ found=true dead=false（判据照样绿）
//
// 那一行什么都不会执行。挖掉字面量之后这类诱饵**不再算命中**（= 装配行缺失 ⇒ 红），
// 而正常的调用/赋值（含带字符串实参的调用）逐字不变。
//
// 实现是"打印后按字面量文本替换"而不是自写打印器：`printer` 对 BasicLit 原样输出
// `lit.Value`（含引号），所以逐个 ReplaceAll 即可精确挖掉它们；这比手写一份
// printer 更不容易与 gofmt 形状漂移。
func printNodeWithoutStringLiterals(fset *token.FileSet, n ast.Node) string {
	printed := printNode(fset, n)
	if printed == "" {
		return ""
	}
	lits := map[string]bool{}
	ast.Inspect(n, func(inner ast.Node) bool {
		lit, ok := inner.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING || lit.Value == "" {
			return true
		}
		lits[lit.Value] = true
		return true
	})
	for lit := range lits {
		printed = strings.ReplaceAll(printed, lit, `"…"`)
	}
	return printed
}

// requireAssemblyOnMainPath 断言 `main()` 里存在 match 对应的调用/赋值，且它不在
// 静态不可执行的构造里。why 用于解释"缺了它会怎样"（失败信息要能指导修复）。
func requireAssemblyOnMainPath(t *testing.T, match, why string) {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	site, err := findMainAssemblySite(src, match)
	if err != nil {
		t.Fatalf("parse main.go: %v", err)
	}
	if !site.Found {
		t.Fatalf("main() 里找不到装配调用 %q —— %s", match, why)
	}
	if site.Dead {
		t.Fatalf("main() 的装配调用 %q 落在静态不可执行的构造里（%s）—— %s\n"+
			"命中的语句：%s", match, site.Why, why, site.Matched)
	}
}

// staticDeadReason 沿祖先链判定 node 是否落在静态不可执行的构造里；返回原因
// （空串 = 可达）。node 必须是 ancestors 末元素的直接后代。
func staticDeadReason(ancestors []ast.Node, node ast.Node, env constEnv) string {
	for i := len(ancestors) - 1; i >= 0; i-- {
		switch a := ancestors[i].(type) {
		case *ast.IfStmt:
			if inSubtree(a.Body, node) {
				if v, ok := constBool(a.Cond, env); ok && !v {
					return "条件在编译期恒假（`if false { … }` 形态）"
				}
			}
			if a.Else != nil && inSubtree(a.Else, node) {
				if v, ok := constBool(a.Cond, env); ok && v {
					return "落在编译期恒真的 if 的 else 分支（永不执行）"
				}
			}
		case *ast.ForStmt:
			if a.Cond != nil && inSubtree(a.Body, node) {
				if v, ok := constBool(a.Cond, env); ok && !v {
					return "条件在编译期恒假的 for 循环体"
				}
			}
		case *ast.CaseClause:
			// 无 tag 的 `switch { case <编译期常量假>: … }`：case 体不可达。
			// 只认**无 tag** 形态（有 tag 的 `switch x { case … }` 需要值流分析，不在
			// 判别力内 —— 那种形态按可达处理，**不误杀**）；`select` 的 case 是通信操作，
			// 同样不在判别力内（TypeSwitchStmt 的 CaseClause 父节点不是 SwitchStmt）。
			// 向上找**本 case 所属的** switch：case 的父节点是 switch 的 Body 块，
			// 所以跳过 BlockStmt 再取第一个非块祖先（TypeSwitchStmt 不在判别力内）。
			var sw *ast.SwitchStmt
			for j := i - 1; j >= 0; j-- {
				if _, isBlock := ancestors[j].(*ast.BlockStmt); isBlock {
					continue
				}
				sw, _ = ancestors[j].(*ast.SwitchStmt)
				break
			}
			if sw == nil || sw.Tag != nil || len(a.List) == 0 || !inAnySubtree(a.Body, node) {
				continue
			}
			allFalse := true
			for _, cond := range a.List {
				if v, ok := constBool(cond, env); !ok || v {
					allFalse = false
					break
				}
			}
			if allFalse {
				return "无 tag 的 switch 里条件在编译期恒假的 case 体"
			}
		case *ast.RangeStmt:
			if inSubtree(a.Body, node) && rangeOverEmpty(a.X, env) {
				return "range 一个编译期为空的集合"
			}
		case *ast.FuncLit:
			// 函数字面量只有两种"被装配"的形态：赋值右侧（接缝闭包）或立即调用。
			// 其它形态（`var _ = func(){ … }`、塞进没人调用的容器）不会被启动路径执行。
			var parent ast.Node
			if i > 0 {
				parent = ancestors[i-1]
			}
			if !seamFuncLitParent(parent) {
				return "藏在未被装配的函数字面量里（既不是赋值右侧，也不是立即调用）"
			}
		}
	}
	return ""
}

// inSubtree 用位置区间判定 node 是否落在 outer 之内（Go 的 token 位置单调，足以
// 区分同一分支内的节点与外层 Init/Cond）。
func inSubtree(outer, node ast.Node) bool {
	if outer == nil || node == nil {
		return false
	}
	return outer.Pos() <= node.Pos() && node.End() <= outer.End()
}

// inAnySubtree 报告 node 是否落在 stmts 中某一条语句之内（case 体的判定用它，
// 避免把 case **条件表达式**里的节点也算进	case 体）。
func inAnySubtree(stmts []ast.Stmt, node ast.Node) bool {
	for _, st := range stmts {
		if inSubtree(st, node) {
			return true
		}
	}
	return false
}

// seamFuncLitParent 报告函数字面量的直接父节点是不是"**装配**"形态。
//
// 只放行两类（本仓既有的接缝形态）：
//   - 插到某个**接缝对象字段**上的赋值（`adminAPI.ReloadAuth = func(){ … }`、
//     `clientrelease.PublicBaseResolver = func(){ … }`）—— 字段本身就是被别人调用的入口；
//   - 立即调用（`func(){ … }()`）或作为参数交给会调用它的构造函数。
//
// **不放行**局部变量赋值（`f := func(){ … }`）与空白标识符（`_ = func(){ … }`）：
// 它们完全可能是"定义了却没人调用"，而"包装配进一个没人执行的闭包"正是本判据
// 要挡的形态之一（只放行字面量赋值会让 `_ = func(){ startThing() }` 静默通过）。
func seamFuncLitParent(parent ast.Node) bool {
	switch p := parent.(type) {
	case *ast.AssignStmt:
		if len(p.Lhs) != 1 {
			return false
		}
		sel, ok := p.Lhs[0].(*ast.SelectorExpr)
		return ok && sel.Sel != nil // `x.Field = func(){ … }`（接缝对象）
	case *ast.CallExpr:
		return true // 立即调用 / 作为参数交给会调用它的构造函数
	}
	return false
}

// rangeOverEmpty 报告 range 的对象是不是编译期已知为空。
//
// 覆盖面（R23-V3-B6 补后两条）：裸 `nil`、空复合字面量、`make([]T, 0)`、
// **空字符串字面量**（`for range "" { … }`）、整数常量 0（Go 1.22 起可 range int）、
// 以及**类型化 nil 转换**（`for range []int(nil) { … }`）。
// 判不了的形态一律返回 false（保守：宁可漏杀，不可误杀活代码）。
func rangeOverEmpty(x ast.Expr, env constEnv) bool {
	switch v := x.(type) {
	case *ast.Ident:
		return v.Name == "nil"
	case *ast.CompositeLit:
		return len(v.Elts) == 0
	case *ast.ParenExpr:
		return rangeOverEmpty(v.X, env)
	case *ast.BasicLit:
		switch v.Kind {
		case token.STRING:
			return v.Value == `""` || v.Value == "``"
		case token.INT:
			if n, ok := constInt(v, env); ok {
				return n == 0
			}
		}
		return false
	case *ast.CallExpr:
		// `make([]T, 0)`：长度实参折成 0 ⇒ 空。
		if id, ok := v.Fun.(*ast.Ident); ok && id.Name == "make" && len(v.Args) >= 2 {
			if n, ok := constInt(v.Args[1], env); ok && n == 0 {
				return true
			}
		}
		// `[]int(nil)` / `map[string]int(nil)` 之类的**类型转换**：Fun 是类型表达式
		// （不是标识符形状的调用），且唯一实参折成 nil / 空字面量 ⇒ 空。
		if len(v.Args) == 1 && isTypeExpr(v.Fun) {
			return rangeOverEmpty(v.Args[0], env)
		}
		return false
	}
	return false
}

// isTypeExpr 报告一个表达式是不是**类型**（而不是函数/方法调用）—— 只认无歧义的类型
// 语法形状：`[]T` / `[N]T` / `map[K]V` / `chan T` / `*T` / `func(...)` / `interface{}`。
//
// 刻意**不**认 `Ident`（`T(nil)` 无法与"函数调用 f(nil)"区分；保守方向是漏杀）。
func isTypeExpr(e ast.Expr) bool {
	switch e.(type) {
	case *ast.ArrayType, *ast.MapType, *ast.ChanType, *ast.StarExpr,
		*ast.FuncType, *ast.InterfaceType, *ast.StructType:
		return true
	}
	return false
}

// constBool 求表达式的编译期布尔值；非常量表达式返回 ok=false。
func constBool(e ast.Expr, env constEnv) (value bool, ok bool) {
	v := constValue(e, env)
	if v == nil || v.Kind() != constant.Bool {
		return false, false
	}
	return constant.BoolVal(v), true
}

// constInt 求表达式的编译期整数常量值。
func constInt(e ast.Expr, env constEnv) (int64, bool) {
	v := constValue(e, env)
	if v == nil || v.Kind() != constant.Int {
		return 0, false
	}
	n, exact := constant.Int64Val(v)
	return n, exact
}

// constValue 是**受控的**常量折叠：只处理"判据需要挡住的写法"，任何不确定的
// 形态一律返回 nil（= 当作运行期条件，判为可达）。折半途 panic 也吞掉转 nil ——
// 判据宁可漏杀一个畸形写法，也不能因为一个解析不了的表达式把整包测试打红。
//
// `env` 提供**命名常量**的取值（`const v3X = false` ⇒ `if v3X { … }` 判死）。
//
// R23-V3-B6 补的三类（修前实测都逃逸）：内建 `len` 作用于常量字符串（`len("abc") == 0`）、
// 移位（`(1 << 62) < 0`，含溢出语义 —— 交给 `go/constant` 的任意精度整数）、按位运算。
func constValue(e ast.Expr, env constEnv) (out constant.Value) {
	defer func() {
		if recover() != nil {
			out = nil
		}
	}()
	switch x := e.(type) {
	case *ast.Ident:
		switch x.Name {
		case "true":
			return constant.MakeBool(true)
		case "false":
			return constant.MakeBool(false)
		}
		return env.lookup(x.Name)
	case *ast.BasicLit:
		switch x.Kind {
		case token.INT, token.FLOAT, token.IMAG, token.CHAR, token.STRING:
			return constant.MakeFromLiteral(x.Value, x.Kind, 0)
		}
		return nil
	case *ast.ParenExpr:
		return constValue(x.X, env)
	case *ast.CallExpr:
		// 内建 `len(<常量字符串>)`。只认这一个内建、一个实参、String 常量 ——
		// 其余（cap / 自定义函数 / 多实参）判不了 ⇒ nil（保守）。
		if id, ok := x.Fun.(*ast.Ident); ok && id.Name == "len" && len(x.Args) == 1 {
			if v := constValue(x.Args[0], env); v != nil && v.Kind() == constant.String {
				return constant.MakeInt64(int64(len(constant.StringVal(v))))
			}
		}
		return nil
	case *ast.UnaryExpr:
		v := constValue(x.X, env)
		if v == nil {
			return nil
		}
		switch x.Op {
		case token.NOT, token.SUB, token.ADD, token.XOR:
			return constant.UnaryOp(x.Op, v, 0)
		}
		return nil
	case *ast.BinaryExpr:
		a, b := constValue(x.X, env), constValue(x.Y, env)
		if a == nil || b == nil {
			return nil
		}
		switch x.Op {
		case token.LAND, token.LOR:
			if a.Kind() != constant.Bool || b.Kind() != constant.Bool {
				return nil
			}
			return constant.BinaryOp(a, x.Op, b)
		case token.EQL, token.NEQ, token.LSS, token.GTR, token.LEQ, token.GEQ:
			if a.Kind() == constant.String && b.Kind() == constant.String {
				return constant.MakeBool(constant.Compare(a, x.Op, b))
			}
			if a.Kind() == constant.Int && b.Kind() == constant.Int {
				return constant.MakeBool(constant.Compare(a, x.Op, b))
			}
			if a.Kind() == constant.Bool && b.Kind() == constant.Bool &&
				(x.Op == token.EQL || x.Op == token.NEQ) {
				return constant.MakeBool(constant.Compare(a, x.Op, b))
			}
			return nil
		case token.ADD, token.SUB, token.MUL, token.QUO, token.REM,
			token.AND, token.OR, token.XOR, token.AND_NOT:
			if a.Kind() != constant.Int || b.Kind() != constant.Int {
				return nil
			}
			return constant.BinaryOp(a, x.Op, b)
		case token.SHL, token.SHR:
			if a.Kind() != constant.Int || b.Kind() != constant.Int {
				return nil
			}
			shift, ok := constant.Uint64Val(constant.ToInt(b))
			if !ok {
				return nil // 负移位/超界 ⇒ 判不了（真代码也编译不过）
			}
			return constant.Shift(a, x.Op, uint(shift))
		}
		return nil
	}
	return nil
}

// TestMainAssemblyCriterionBitesOnDeadWrapping 是本判据工具的**自证用例**：
// 它在合成源码上跑同一个判定函数，证明"包进不执行分支"这一形态真的被判死，
// 而合法的形态（顶层调用、if 初始化语句、条件分支里的装配）不被误杀。
//
// 没有这一条，`requireAssemblyOnMainPath` 只是个"看起来很严"的黑盒 ——
// 它自己也需要能被打坏的证据（判据的判据）。
func TestMainAssemblyCriterionBitesOnDeadWrapping(t *testing.T) {
	const live = `package main

import "context"

func main() {
	ctx := context.Background()
	startThing(ctx, nil)
}
`
	const deleted = `package main

import "context"

func main() {
	ctx := context.Background()
	_ = ctx
}
`
	const wrappedIfFalse = `package main

import "context"

func main() {
	ctx := context.Background()
	if false {
		startThing(ctx, nil)
	}
}
`
	const wrappedConstFold = `package main

import "context"

func main() {
	ctx := context.Background()
	if 1 > 2 {
		startThing(ctx, nil)
	}
}
`
	const wrappedForFalse = `package main

import "context"

func main() {
	ctx := context.Background()
	for false {
		startThing(ctx, nil)
	}
}
`
	const wrappedEmptyRange = `package main

import "context"

func main() {
	ctx := context.Background()
	for _, f := range []func(){ } {
		_ = f
	}
	startThing(ctx, nil)
}
`
	const wrappedLooseFuncLit = `package main

import "context"

func main() {
	ctx := context.Background()
	_ = func() {
		startThing(ctx, nil)
	}
}
`
	const wrappedLocalClosure = `package main

import "context"

func main() {
	ctx := context.Background()
	f := func() {
		startThing(ctx, nil)
	}
	_ = f
}
`
	const seamAssign = `package main

import "context"

func main() {
	ctx := context.Background()
	holder.Seam = func() {
		startThing(ctx, nil)
	}
}
`
	const conditionalButLive = `package main

import (
	"context"
	"os"
)

func main() {
	ctx := context.Background()
	if v := os.Getenv("X"); v != "" {
		startThing(ctx, nil)
	}
	if n, err := load(); err == nil {
		startThing(ctx, nil)
		_ = n
	}
}
`

	const namedConstFalse = `package main

import "context"

const v3AuthBrowsersDisabled = false

func main() {
	ctx := context.Background()
	if v3AuthBrowsersDisabled {
		startThing(ctx, nil)
	}
}
`
	const namedConstTrueElse = `package main

import "context"

const v3Always = true

func main() {
	ctx := context.Background()
	if v3Always {
		_ = ctx
	} else {
		startThing(ctx, nil)
	}
}
`
	const namedConstDerived = `package main

import "context"

const (
	v3Base     = false
	v3Disabled = v3Base || false
)

func main() {
	ctx := context.Background()
	if v3Disabled {
		startThing(ctx, nil)
	}
}
`
	const shadowedByLocalVar = `package main

import "context"

const v3Disabled = false

func main() {
	ctx := context.Background()
	v3Disabled := compute()
	if v3Disabled {
		startThing(ctx, nil)
	}
}
`
	const wrappedSwitchCaseFalse = `package main

import "context"

func main() {
	ctx := context.Background()
	switch {
	case 1 > 2:
		startThing(ctx, nil)
	}
}
`
	const switchCaseLive = `package main

import "context"
import "os"

func main() {
	ctx := context.Background()
	switch {
	case os.Getenv("V3") != "":
		startThing(ctx, nil)
	}
}
`
	const switchWithTagNotJudged = `package main

import "context"

func main() {
	ctx := context.Background()
	switch ctx {
	case nil:
		startThing(ctx, nil)
	}
}
`
	const match = "startThing(ctx, nil)"

	// —— R23-V3-B4/B5/B6 的逃逸形态（修前逐条实测 exit=0）——
	const stringDecoyOnly = `package main

import "context"

func main() {
	ctx := context.Background()
	_ = "startThing(ctx, nil)"
}
`
	const stringDecoyBesideRealCall = `package main

import "context"

func main() {
	ctx := context.Background()
	_ = "startThing(ctx, nil)"
	startThing(ctx, nil)
}
`
	const localVarFalse = `package main

import "context"

func main() {
	ctx := context.Background()
	var w3Disabled = false
	if w3Disabled {
		startThing(ctx, nil)
	}
}
`
	const localVarReassigned = `package main

import "context"

func main() {
	ctx := context.Background()
	var w3Disabled = false
	w3Disabled = compute()
	if w3Disabled {
		startThing(ctx, nil)
	}
}
`
	const localVarAddressTaken = `package main

import "context"

func main() {
	ctx := context.Background()
	var w3Disabled = false
	wire(&w3Disabled)
	if w3Disabled {
		startThing(ctx, nil)
	}
}
`
	const pkgVarFalse = `package main

import "context"

var w3Disabled = false

func main() {
	ctx := context.Background()
	if w3Disabled {
		startThing(ctx, nil)
	}
}
`
	const constLenFold = `package main

import "context"

func main() {
	ctx := context.Background()
	const empty = len("abc") == 0
	if empty {
		startThing(ctx, nil)
	}
}
`
	const constShiftFold = `package main

import "context"

func main() {
	ctx := context.Background()
	const overflowed = (1 << 62) < 0
	if overflowed {
		startThing(ctx, nil)
	}
}
`
	const rangeEmptyString = `package main

import "context"

func main() {
	ctx := context.Background()
	for range "" {
		startThing(ctx, nil)
	}
}
`
	const rangeTypedNil = `package main

import "context"

func main() {
	ctx := context.Background()
	for range []int(nil) {
		startThing(ctx, nil)
	}
}
`
	const rangeNonEmptyString = `package main

import "context"

func main() {
	ctx := context.Background()
	for range "x" {
		startThing(ctx, nil)
	}
}
`

	cases := []struct {
		name    string
		src     string
		found   bool
		dead    bool
		comment string
	}{
		{"顶层调用", live, true, false, "正常装配"},
		{"整行删掉", deleted, false, false, "存在性判据也能咬到"},
		{"包进 if false", wrappedIfFalse, true, true, "旧判据杀不死的那一类"},
		{"包进 if 1 > 2", wrappedConstFold, true, true, "换个写法的常量假条件"},
		{"包进 for false", wrappedForFalse, true, true, "恒假循环"},
		{"range 空集合里的装配", wrappedEmptyRange, true, false, "range 的对象非空 ⇒ 循环体可达"},
		{"空白标识符里的闭包", wrappedLooseFuncLit, true, true, "`_ = func(){ … }` 定义了却没人调用"},
		{"局部变量里的闭包", wrappedLocalClosure, true, true, "局部闭包可能没人调用（不是接缝）"},
		{"插到接缝字段上的闭包", seamAssign, true, false, "接缝形态（schedulers.go / auth_assembly.go 家族）必须放行"},
		{"条件分支但条件非常量", conditionalButLive, true, false, "运行期条件不得误杀（如 RebuildUsageLedger 的 err == nil）"},
		// R22-V3-B3：修前实测 exit=0 的四条形态（前两条现在必须挡住，后两条如实保留为边界）。
		{"包进命名常量假条件", namedConstFalse, true, true, "`const x = false; if x { … }` —— 换个写法的同一个编译期常量"},
		{"命名常量真条件的 else 分支", namedConstTrueElse, true, true, "命名常量同样要能判 else 分支"},
		{"命名常量派生自另一个常量", namedConstDerived, true, true, "同块内的常量表达式（`b = a || false`）也要折出来"},
		{"包进无 tag switch 的恒假 case", wrappedSwitchCaseFalse, true, true, "`switch { case 1 > 2: … }`（V3 的 m5）"},
		{"命名常量被同名局部变量遮蔽", shadowedByLocalVar, true, false, "同名局部变量不是常量 ⇒ 必须按可达处理（不误杀）"},
		{"switch 的 case 是运行期条件", switchCaseLive, true, false, "运行期条件的 case 体不得误杀"},
		{"带 tag 的 switch 不在判别力内", switchWithTagNotJudged, true, false, "值流分析范围外 —— 边界如实记在文件头，不假装挡住"},
		// —— R23-V3-B4/B5/B6：修前实测 exit=0 的逃逸形态（现在必须挡住，或如实登记为边界）。——
		{"同文本字符串字面量诱饵（真调用已删）", stringDecoyOnly, false, false,
			"★ B4：诱饵不算命中 ⇒ 判「装配行缺失」；修前这里是 found=true dead=false（假绿）"},
		{"诱饵 + 真调用并存", stringDecoyBesideRealCall, true, false,
			"诱饵不得让真调用被漏掉（两个节点各自匹配，命中的是调用那一个）"},
		{"局部 var 假条件", localVarFalse, true, true,
			"★ B5：`var x = false; if x { … }` 是命名常量的一 token 变体（初值可折 + 从未被写）"},
		{"局部 var 被重新赋值", localVarReassigned, true, false,
			"被写过的 var 不是常量 ⇒ 必须按可达处理（不误杀）"},
		{"局部 var 被取地址", localVarAddressTaken, true, false,
			"`&x` 后地址外流 ⇒ 不再声称知道它的值（不误杀）"},
		{"包级 var 假条件（已认账边界）", pkgVarFalse, true, false,
			"★ 如实登记：包级 var 可能被同包其它文件赋值，本判据只解析 main.go ⇒ 按可达处理，通过行不得声称挡住"},
		{"const 折叠 len(常量字符串)", constLenFold, true, true, "★ B6：内建 len 作用于常量字符串（go/constant 已支持）"},
		{"const 折叠移位溢出", constShiftFold, true, true, "★ B6：`(1 << 62) < 0` 走常量任意精度整数语义"},
		{"range 空字符串", rangeEmptyString, true, true, "★ B6：`for range \"\"` 的循环体不可达"},
		{"range 类型化 nil", rangeTypedNil, true, true, "★ B6：`for range []int(nil)` 的循环体不可达"},
		{"range 非空字符串", rangeNonEmptyString, true, false, "非空字符串必须按可达处理（不误杀）"},
	}
	for _, c := range cases {
		got, err := findMainAssemblySite([]byte(c.src), match)
		if err != nil {
			t.Fatalf("%s: parse: %v", c.name, err)
		}
		if got.Found != c.found || got.Dead != c.dead {
			t.Fatalf("%s（%s）: Found=%v Dead=%v（why=%q）, want Found=%v Dead=%v —— "+
				"判据工具的判别力不成立", c.name, c.comment, got.Found, got.Dead, got.Why, c.found, c.dead)
		}
		if c.dead && got.Why == "" {
			t.Fatalf("%s: 判死但没给原因", c.name)
		}
	}
}

// TestMainAssemblyCriterionIsNotVacuousOnRealMainGo 用**真实 main.go** 自证工具没有
// 恒真/恒假：一个必然不存在的装配字面量必须判 Found=false。
func TestMainAssemblyCriterionIsNotVacuousOnRealMainGo(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	site, err := findMainAssemblySite(src, "thisAssemblyCallDoesNotExistAnywhere(ctx, db)")
	if err != nil {
		t.Fatal(err)
	}
	if site.Found {
		t.Fatalf("不存在的装配字面量被判为存在（%q）—— 判据工具恒真", site.Matched)
	}
}

// TestMainAssemblyCriterionBitesOnRealMainGoDecoys 用**真 main.go** 证明 R23-V3-B4/B5
// 的两条逃逸形态已收口（修前实测：两条都 exit=0）。
//
// 做法与复审 W3 同形：在内存里改源码（不落盘），跑**同一个**判定函数：
//
//	① 诱饵：把 `serverauth.SetBuildVersion(version)` 换成同文本的字符串字面量
//	   ⇒ 必须 `Found=false`（= 判据报"装配行缺失"，红）；修前这里是 found=true（假绿）。
//	② var 包裹：把它包进 `var r23Disabled = false; if r23Disabled { … }`
//	   ⇒ 必须 `Found=true, Dead=true`；修前这里 dead=false（逃逸）。
func TestMainAssemblyCriterionBitesOnRealMainGoDecoys(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	const call = "serverauth.SetBuildVersion(version)"
	const match = "serverauth.SetBuildVersion(version)"
	if !strings.Contains(string(src), "\t"+call+"\n") {
		t.Fatalf("夹具前提不成立：main.go 里没有独立一行的 %q（装配行形状变了就更新本用例）", call)
	}

	decoy := strings.Replace(string(src), "\t"+call+"\n", "\t_ = \""+call+"\"\n", 1)
	if decoy == string(src) {
		t.Fatal("诱饵变异没有生效（夹具坏了）")
	}
	site, err := findMainAssemblySite([]byte(decoy), match)
	if err != nil {
		t.Fatalf("解析诱饵源码: %v", err)
	}
	if site.Found {
		t.Fatalf("同文本字符串字面量诱饵被判成真装配点（matched=%q）—— "+
			"判据仍是「文本包含」形状（R23-V3-B4）", site.Matched)
	}

	wrapped := strings.Replace(string(src), "\t"+call+"\n",
		"\tvar r23Disabled = false\n\tif r23Disabled {\n\t\t"+call+"\n\t}\n", 1)
	if wrapped == string(src) {
		t.Fatal("var 包裹变异没有生效（夹具坏了）")
	}
	site, err = findMainAssemblySite([]byte(wrapped), match)
	if err != nil {
		t.Fatalf("解析 var 包裹源码: %v", err)
	}
	if !site.Found {
		t.Fatalf("var 包裹后的装配点被判成缺失（Found=false）—— 判定器把真调用看丢了")
	}
	if !site.Dead {
		t.Fatalf("`var r23Disabled = false; if r23Disabled { … }` 没被判死（why=%q）—— "+
			"R23-V3-B5 的逃逸形态仍在（修前实测 exit=0）", site.Why)
	}
}

// TestOldIndexCriterionWasBlindToDeadWrapping 记录并复现 R21C-04 的**缺陷本体**：
// 旧的 `strings.Index` 判据在"包进 `if false { … }`"这一形态下**照样通过**。
//
// 这不是"再补一条判据"，而是判据升级的**必要性证明**：如果旧形态本来就咬得住，
// 那么 `requireAssemblyOnMainPath` 只是把同一件事写得更复杂（审计 R21C-04 的结论
// 正是"旧判据杀不死这个 mutant"，实测 `m_modelsync_deadbranch` 在修前
// `go test ./cmd/server/` exit=0）。
func TestOldIndexCriterionWasBlindToDeadWrapping(t *testing.T) {
	const deadSrc = `package main

import "context"

func main() {
	ctx := context.Background()
	if false {
		startThing(ctx, nil)
	}
}
`
	const call = "startThing(ctx, nil)"

	// 旧判据（存在性）：字面量还在 ⇒ 通过 —— 这正是缺陷本体。
	if strings.Index(deadSrc, call) < 0 {
		t.Fatal("旧判据在这个形态下本该通过（字面量仍在文件里）—— 说明本用例的前置不成立")
	}
	// 新判据（可达性）：必须判死。
	site, err := findMainAssemblySite([]byte(deadSrc), call)
	if err != nil {
		t.Fatal(err)
	}
	if !site.Found || !site.Dead {
		t.Fatalf("新判据没能判死 `if false { %s }`（Found=%v Dead=%v）—— "+
			"升级后的判据与旧判据一样没用", call, site.Found, site.Dead)
	}
}
