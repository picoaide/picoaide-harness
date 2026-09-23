// 官方归属不变量的**双侧源码判据**（R3-A 复审 M-A9b）。
//
// 背景：`official=1 ⇒ owner=”` 这条不变量在**两处**成立 ——
//
//	侧 1（纵深防御，api 层）：`wasmapp/api/publish.go` 的 `commitRelease` 显式分支
//	    `if in.existing != nil && in.existing.Official == 1 { owner = "" }`
//	侧 2（承重墙，DAO 层）：`serverstore/wasmapps.go` 的 `UpsertWasmApp`
//	    `owner = CASE WHEN apps.official = 1 THEN '' ELSE COALESCE(...) END`
//
// 复审实测：**删掉 api 层那一侧，全部行为用例仍然绿**（DAO 已经兜住，变异存活）。
// 这不是产品缺陷（不变量在唯一写入口成立），但"一行没有任何判据载体的纵深防御"在下一轮
// 审计里会再次以"存活变异"的形态出现，消耗审计预算；更糟的是它可以被静默删除而无人发现。
//
// 处置（复审建议 B：**保留**冗余 + 补源码级判据，而不是删掉冗余）：
//   - 两侧都保留（api 层表达意图、DAO 层保证"未来任何调用者都造不出禁止状态"）；
//   - 本文件用 **Go AST** 读两侧源码，断言两个守卫**作为带语义的语句**存在：
//     api 侧必须是"条件里比较 `in.existing.Official == 1` 且体内把 `owner` 置空"的 if；
//     DAO 侧必须是 `UpsertWasmApp` 的 `INSERT … ON CONFLICT DO UPDATE SET` 里那条
//     `owner = CASE WHEN apps.official = 1 THEN ” …`。
//
// 为什么用 AST 而不是 grep 字符串：判据要的是"这个分支真的在、语义没被改"，而不是
// "文件里出现过 `Official == 1`"（注释、日志文案、别的分支都能满足字符串匹配）。
// 归一化用 go/printer 去掉全部空白 ⇒ 判据对 gofmt/换行/缩进不敏感，但对**改判据本身**
// 敏感（改成 `== 2`、删掉置空、把 CASE 换回裸 COALESCE 都会红）。
//
// 变异验证（实跑对照见交付报告）：
//   - 删掉 api 层分支 ⇒ 本文件红（该变异此前**存活**，正是本条要消灭的形态）；
//   - 把 DAO 的 CASE 守卫换回裸 `COALESCE(NULLIF(apps.owner,”), excluded.owner)` ⇒ 本文件红
//     （同时 `TestOfficialWasmAppKeepsEmptyOwnerAfterPublish` 等行为用例也红）。
package api

import (
	"bytes"
	"go/ast"
	"go/format"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// 两侧守卫的**归一化**（去掉全部空白）形态。左侧是断言的目标，右侧是来源。
const (
	// apiGuardCondition 是 `commitRelease` 里的官方判定条件。
	apiGuardCondition = `in.existing!=nil&&in.existing.Official==1`
	// apiGuardEffect 是同一分支体内必须出现的赋值（归属置空）。
	apiGuardEffect = `owner=""`
	// daoGuard 是 `UpsertWasmApp` 的 ON CONFLICT 分支里 owner 列的 CASE 守卫。
	daoGuard = `owner=CASEWHENapps.official=1THEN''`
)

// TestOfficialOwnershipGuardExistsOnBothSides 断言两侧守卫都在、且判据未被改写。
func TestOfficialOwnershipGuardExistsOnBothSides(t *testing.T) {
	// ---- 侧 1：api 层（同包源码，publish.go 的 commitRelease）----
	fset, file := parseGoFile(t, "publish.go")
	fn := findFuncDecl(t, file, "commitRelease")
	found := false
	ast.Inspect(fn, func(n ast.Node) bool {
		ifs, ok := n.(*ast.IfStmt)
		if !ok {
			return true
		}
		cond := compactNode(t, fset, ifs.Cond)
		if !strings.Contains(cond, apiGuardCondition) {
			return true
		}
		if !strings.Contains(compactNode(t, fset, ifs.Body), apiGuardEffect) {
			return true
		}
		found = true
		return false
	})
	if !found {
		t.Fatalf("api 层（publish.go 的 commitRelease）缺少官方归属守卫：需要一个"+
			"条件含 `%s` 且体内含 `%s` 的分支。\n"+
			"这条分支是纵深防御（承重墙在 DAO），**不得静默删除** —— "+
			"删除它意味着将来 DAO 被重构/换写入口时 `official=1 ∧ owner≠''` 会静默复发",
			apiGuardCondition, apiGuardEffect)
	}

	// ---- 侧 2：DAO 层（相邻包源码，serverstore/wasmapps.go 的 UpsertWasmApp）----
	daoPath := filepath.Join("..", "..", "serverstore", "wasmapps.go")
	dfset, dfile := parseGoFile(t, daoPath)
	dfn := findFuncDecl(t, dfile, "UpsertWasmApp")
	sql := ""
	ast.Inspect(dfn, func(n ast.Node) bool {
		lit, ok := n.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			return true
		}
		if !strings.Contains(lit.Value, "ON CONFLICT") {
			return true
		}
		sql = compactNode(t, dfset, lit)
		return false
	})
	if sql == "" {
		t.Fatalf("在 %s 的 UpsertWasmApp 里找不到 `INSERT … ON CONFLICT` 的 SQL 字面量"+
			"（判据的扫描面缺失，拒绝宣称「DAO 守卫在」）", daoPath)
	}
	if !strings.Contains(sql, daoGuard) {
		t.Fatalf("DAO（%s 的 UpsertWasmApp）的 ON CONFLICT 分支缺少官方归属守卫：需要 `%s`。\n"+
			"裸 `COALESCE(NULLIF(apps.owner,''), excluded.owner)` 会把官方行的归属改写成发布者"+
			"（官方行 owner 本来是空串）—— 那正是 A-9 的缺陷本体", daoPath, daoGuard)
	}
}

// parseGoFile 解析源码文件（失败即 Fatal：判据的扫描面缺失不得静默通过）。
func parseGoFile(t *testing.T, path string) (*token.FileSet, *ast.File) {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, path, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("解析 %s 失败（判据的扫描面缺失，拒绝宣称「守卫在两侧都在」）: %v", path, err)
	}
	return fset, f
}

// findFuncDecl 按名字找函数/方法声明（找不到即 Fatal：改名会让判据失去扫描面）。
func findFuncDecl(t *testing.T, f *ast.File, name string) *ast.FuncDecl {
	t.Helper()
	for _, d := range f.Decls {
		fn, ok := d.(*ast.FuncDecl)
		if !ok || fn.Name == nil || fn.Name.Name != name {
			continue
		}
		return fn
	}
	t.Fatalf("在 %s 里找不到函数 %s（被改名/删除？判据的扫描面缺失）", f.Name.Name, name)
	return nil
}

// compactNode 用 go/printer 归一化 AST 节点并去掉**全部空白**。
//
// 目的：判据对 gofmt/缩进/换行不敏感（否则一句格式化就让守卫判据红，那是假信号），
// 但对判据本身敏感（`== 2`、删掉 `owner=""`、把 CASE 换成裸 COALESCE 都会变形）。
func compactNode(t *testing.T, fset *token.FileSet, n ast.Node) string {
	t.Helper()
	var buf bytes.Buffer
	if err := format.Node(&buf, fset, n); err != nil {
		t.Fatalf("归一化 AST 节点失败（判据无法判定）: %v", err)
	}
	return strings.Join(strings.Fields(buf.String()), "")
}
