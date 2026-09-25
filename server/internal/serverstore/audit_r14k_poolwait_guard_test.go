package serverstore

// R14-K · D-01 的**机械守卫**：`server/**` 里不允许"已开事务、再向池里要连接"
// （hold-and-wait —— 池上限 = 并发数时自锁且不可恢复）。
//
// 为什么需要它（而不只是三处已经修好的调用点 + 三条真 PG 回归用例）：
// 这一族的形态在本仓被记录过七次"以为只有一处、实际还有第二/第三处"（本轮就是：
// lane D 的两轮扫描只报了 `updateUsageTokensAtCached`，独立复扫又找出
// `DeleteDepartment` 与 `llmgateway.setGatewayConfig` 两处）。回归用例只能钉住
// **已知**的三个入口，"下一次新增一个在事务里顺手 `db.QueryRow` 的 helper"不会被
// 任何判据发现 —— 而它的后果是**整个池不可恢复**。
//
// ---------------------------------------------------------------------------
// R14-O · VC-F2：尺子从**文本**换成 **AST**（三条未登记盲区被收进判据）
// ---------------------------------------------------------------------------
//
// 复审泳道 V14-C 用六个变异证明：文本尺子（逐行正则）有三条**它自己没登记**的
// 盲区，且每条都能构造出"守卫绿 + 真 PG 自锁"的真形态（`temp/r14/v14C/guard-bypass.sh`）：
//
//	M3 池句柄出现在**下一行**（多行实参）      —— 逐行匹配看不见；
//	M4 开事务入口是**未被硬编码枚举**的 helper  —— 本仓今天就有一个：
//	   `internal/appstore/publish.go` 的 `beginPublishTx`（返回 `*sql.Tx`）；
//	M5 规则二**按参数名**豁免（`func f(db *sql.Tx, pool *sql.DB)`）—— 池在第 2 实参位。
//
// 结论（V14-C §5.1 ③ 与 §4）：动态/多行形态是**开放集**，"再加一条正则"不闭合。
// 所以本判据不再用正则推断区域，而是：
//
//	① **开事务点由返回类型推导**：任何本仓函数只要返回 `*sql.Tx` / `*sql.Conn` /
//	   名字以 `Tx` / `Conn` 结尾的句柄类型（`usageBoundedTx`、`usageReadConn`…），
//	   调用它就是一个"区域"的开始 —— helper 未枚举不影响（M4 收口）；
//	② **池句柄由声明类型识别**：参数 / 局部变量（含别名 `p := db`）/ 结构体
//	   `*sql.DB` 字段 / 包级变量（M2 收口）；
//	③ **区域用语句序列（含分支合并）推进**：同一层块里的 `tx.Commit()/Rollback()`
//	   或"本地 rollback 闭包"的调用才关闭区域；`defer tx.Rollback()` **不关闭**
//	   （它在函数返回时才跑）；分支里"回滚后 return"不关闭外层区域（M6 收口）；
//	④ **命中判据按类型与位置判定**：向"某个参数被当连接用"的本仓函数传池句柄，
//	   位置任意（M3/M5 收口）；判据里"参数是否被当连接用"由**不动点**推导
//	   （`scope *sql.DB` 只当 TTL 缓存键的形态不算 —— 见 `getSettingQ`）。
//
// 判据边界（如实登记，全部是"分析不跨过程/不跨动态派发"的固有边界）：
//
//	① 只认"本仓源码里看得见的调用"：反射 / 接口方法动态派发 / `database/sql` 驱动
//	   回调里再取连接，AST 看不见（本仓无此写法）；
//	② 池句柄经**结构体字段赋值**传出（`x.db = db; x.f()` 之后再取连接）不追踪；
//	   结构体**已有**的 `*sql.DB` 字段（`a.DB` / `store.db`）是认的（字段名表）；
//	③ "参数是否被当连接用"的不动点覆盖"直接对参数发语句"与"把参数继续传给另一个
//	   被当连接用的参数位（含多态句柄槽位）"；把池塞进容器（map/slice）**或塞进一个
//	   稍后才调用的闭包**里再取连接，不追踪；
//	④ 区域是**流敏感但非路径枚举**的：分支按"是否有 return/break 终止"合并，不做
//	   完整路径枚举（保守方向是"宁可多报"，报错信息里要求人工判定或登记认账）；
//	⑤ 认账表是**函数级**的（当前 2 条：迁移器与测试模板夹具，见 r14kPoolWaitAck）——
//	   会连带豁免该函数体内的其它池调用，所以那两条都写了"重审条件"。
//
// 变异验证（实跑，见 temp/r14/laneO/run-f2.sh；每条都是"拆掉被测物 ⇒ 守卫必红"）：
//   - M1 `loadModelPriceInputsQ(tx,…)` → `loadModelPriceInputs(db,…)` ⇒ 红；
//   - M2 `poolConn := db; f(poolConn, …)` ⇒ 红（类型识别别名）；
//   - M3 池句柄在**下一行**（多行实参）⇒ 红；
//   - M4 `tx, _ := openUsageTxV14C(db)` 这种未枚举的开事务 helper ⇒ 红（返回类型推导）；
//   - M5 `f(tx, db, …)`，`f(db *sql.Tx, pool *sql.DB, …)` ⇒ 红（类型 + 位置）；
//   - M6 分支内 `tx.Rollback(); return` 之后 `f(db, …)` ⇒ 红（分支终止不关闭区域）；
//   - G1 `departments.DeleteDepartment` 的 `groupByIDQ(tx, id)` → `GroupByID(db, id)` ⇒ 红
//     （**我在收紧过程中补的第二条缝**：`GroupByID` 只是把池句柄转发进一个多态槽位
//     `groupByIDQ(q rowQuerier, …)`，所以"参数是否被当连接用"的不动点必须同时覆盖
//     `*sql.DB` 与多态句柄参数，否则这条真形态会漏）；
//   - G2 `llmgateway.setGatewayConfig` 的 `GetSettingTx(tx, db, …)` → `GetSetting(db, …)` ⇒ 红；
//   - G3 `serverauth.setAuthConfig` 的 `UsageWriteTx(a.DB)` → `a.DB.Begin()` ⇒ 红
//     （**第三条缝**：开区域必须认"池句柄的**任意表达式**"，`a.DB.Begin()` 的接收者是
//     字段选择器而不是裸标识符 —— 只认标识符会让整个区域不开、后续池调用全漏）；
//   - ACK 表本身也双向核对：抽掉认账（ACK_dropped）/ 加幽灵认账（ACK_phantom）⇒ 红；
//   - 尺子自检的正/负向夹具（M 系列 9 条 + 合法形态 7 条）⇒ 见
//     `audit_r14k_poolwait_ast_selfcheck_test.go`（改窄/改宽都在那里当场红）。

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// r14kPoolWaitAck 是**显式认账**（键 `<包>.<函数>`）：每条都必须写清"为什么这里不是
// 不可恢复的 hold-and-wait"。两种合法用法：
//
//	① 判据边界的假阳性（AST 看不见的语义）；
//	② **当前接受的真实形态**（形态是真的，但结构上不可能自锁 —— 例如"advisory lock
//	   专用连接 + 池下限 2 + 只在 serve 之前跑"）。
//
// 登记而不是静默：`TestAuditR14KPoolWaitAckRegistry` 做**双向**核对（认账了却再也
// 扫不到 ⇒ 红，逼人收回口子）。⚠️ 认账是**函数级**的，会连带豁免该函数体内其它池
// 调用 —— 所以每条都要短、理由要能被独立复核。
var r14kPoolWaitAck = map[string]string{
	// 迁移器持有一条 advisory-lock **专用连接**（`db.Conn(ctx)`）之后继续用同一个
	// `db` 的池连接。产品池的下限是 2（db.go 的 `pgPoolMax` 把任何更小的配置夹到 2，
	// 注释逐字："发布路径的最小可用池:同一时刻 1 条连接即可,但 2 是安全地板"），
	// 迁移又跑在 serve 之前 ⇒ 持 1 条 + 取 1 条恒可满足，不存在"两边互等"。
	// 重审条件：池下限被去掉、或迁移进入请求路径。
	"internal/serverstore.ApplyMigrations": "advisory-lock 专用连接 + 产品池下限 2（pgPoolMax 夹取）+ 仅 serve 前执行 ⇒ 持 1 取 1 恒可满足",
	// 测试模板库夹具：`admin` 是 `requireTestPG` 用 `sql.Open` 直接开的**临时库管理
	// 句柄**（只做 CREATE/DROP DATABASE + advisory lock，不共享产品池上限，生产路径
	// 不可达 —— 仅 `NewTestDB` 调用）。
	"internal/serverstore.ensureTestDBTemplate": "测试模板库夹具：admin 是独立管理句柄（默认无上限），生产路径不可达",
}

// r14kPoolStatementMethods 是"拿到池句柄后真的会取一条连接"的方法名。
var r14kPoolStatementMethods = map[string]bool{
	"Query": true, "QueryRow": true, "Exec": true, "Prepare": true,
	"QueryContext": true, "QueryRowContext": true, "ExecContext": true, "PrepareContext": true,
	"Begin": true, "BeginTx": true, "Conn": true, "Ping": true, "PingContext": true,
}

// r14kTxCloseMethods 是"结束事务/归还连接"的方法名（大小写都收：本仓有两套命名）。
var r14kTxCloseMethods = map[string]bool{
	"Commit": true, "Rollback": true, "commit": true, "rollback": true,
	"Release": true, "release": true,
	// `Close()` 是本仓句柄类型的归还入口（`usageReadConn.Close` 回滚只读事务、
	// `sql.Conn.Close` 把连接还给池）—— 只在接收者是**已识别的句柄变量**时才生效。
	"Close": true,
}

// r14kHoldsConnType 判"这个类型名是一个持有连接/事务的句柄"。
func r14kHoldsConnType(t string) bool {
	if !strings.HasPrefix(t, "*") {
		return false
	}
	base := strings.TrimPrefix(t, "*")
	switch base {
	case "sql.Tx", "sql.Conn":
		return true
	}
	return strings.HasSuffix(base, "Tx") || strings.HasSuffix(base, "Conn")
}

// r14kIsPoolType 判"这个类型名是连接池句柄"。
func r14kIsPoolType(t string) bool { return t == "*sql.DB" }

// ---------------------------------------------------------------------------
// 索引：整个 server/ 的函数签名表 + 池句柄字段/包级变量
// ---------------------------------------------------------------------------

// r14kParamSig 是一个参数（多名字段会展开成多条）。
type r14kParamSig struct{ name, typ string }

// r14kDecl 是一个函数/方法声明（含它的"参数是否被当连接用"判定结果）。
type r14kDecl struct {
	key      string // `<包>.<函数名>`（报错用）
	name     string
	recv     string
	params   []r14kParamSig
	results  []string
	body     *ast.BlockStmt
	consumed map[int]bool    // 参数下标 → 该参数被当连接用（不动点结果）
	imports  map[string]bool // 本文件可用的包名（用于区分 `pkg.F()` 与 `x.f()`）
}

// r14kUnit 是一个被扫的源文件。
type r14kUnit struct {
	rel     string
	raw     []byte
	fset    *token.FileSet
	file    *ast.File
	imports map[string]bool // 本文件可用的包名（别名或路径末段）
}

// r14kIndex 是跨文件索引。
type r14kIndex struct {
	byName    map[string][]*r14kDecl
	decls     []*r14kDecl
	units     []*r14kUnit
	poolField map[string]bool // 结构体字段名（类型 *sql.DB）
	poolVar   map[string]bool // 包级变量名（类型 *sql.DB）
}

// r14kHit 是一条命中。
type r14kHit struct {
	key  string
	rel  string
	line int
	what string
}

// r14kBuildIndex 解析全部单元并完成"池参数被当连接用"的不动点。
func r14kBuildIndex(t *testing.T, units []*r14kUnit) *r14kIndex {
	t.Helper()
	ix := &r14kIndex{
		byName:    map[string][]*r14kDecl{},
		poolField: map[string]bool{},
		poolVar:   map[string]bool{},
		units:     units,
	}
	for _, u := range units {
		pkg := filepath.ToSlash(filepath.Dir(u.rel))
		u.imports = r14kImports(u.file)
		for _, f := range collectDecls(u.file) {
			d := &r14kDecl{
				key:      pkg + "." + f.Name.Name,
				name:     f.Name.Name,
				params:   r14kFieldSigs(f.Type.Params),
				results:  r14kResultSigs(f.Type.Results),
				body:     f.Body,
				consumed: map[int]bool{},
				imports:  u.imports,
			}
			if f.Recv != nil && len(f.Recv.List) > 0 {
				d.recv = types.ExprString(f.Recv.List[0].Type)
			}
			ix.decls = append(ix.decls, d)
			ix.byName[d.name] = append(ix.byName[d.name], d)
		}
		// 结构体 `*sql.DB` 字段（`a.DB` / `store.db` 形态）。
		ast.Inspect(u.file, func(n ast.Node) bool {
			st, ok := n.(*ast.StructType)
			if !ok {
				return true
			}
			for _, fld := range st.Fields.List {
				if r14kIsPoolType(types.ExprString(fld.Type)) {
					for _, nm := range fld.Names {
						ix.poolField[nm.Name] = true
					}
				}
			}
			return true
		})
		// 包级 `*sql.DB` 变量。
		for _, decl := range u.file.Decls {
			gd, ok := decl.(*ast.GenDecl)
			if !ok || gd.Tok != token.VAR {
				continue
			}
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok || !r14kIsPoolType(types.ExprString(vs.Type)) {
					continue
				}
				for _, nm := range vs.Names {
					ix.poolVar[nm.Name] = true
				}
			}
		}
	}
	ix.computeConsumed()
	return ix
}

// r14kImports 取文件里可用的包名（显式别名优先，否则路径末段）。
//
// 为什么要它：`settingsCache.get(scope, …)` 是**方法调用**，而
// `serverstore.GetSettingTx(tx, db, …)` 是**包调用** —— 只按末段名字解析会把
// 前者错误地解析成"某个同名方法"（本仓有 3 个 `get`），从而把"池只当缓存键"的
// 合法形态判成 hold-and-wait（实测 18 条假阳性）。
func r14kImports(f *ast.File) map[string]bool {
	out := map[string]bool{}
	for _, imp := range f.Imports {
		path := strings.Trim(imp.Path.Value, `"`)
		name := path
		if i := strings.LastIndex(path, "/"); i >= 0 {
			name = path[i+1:]
		}
		if imp.Name != nil {
			name = imp.Name.Name
		}
		out[name] = true
	}
	return out
}

// collectDecls 取文件里的全部函数/方法声明。
func collectDecls(f *ast.File) []*ast.FuncDecl {
	var out []*ast.FuncDecl
	for _, decl := range f.Decls {
		if fd, ok := decl.(*ast.FuncDecl); ok && fd.Body != nil {
			out = append(out, fd)
		}
	}
	return out
}

// r14kFieldSigs 展开参数表（`a, b *sql.DB` → 两条）。
func r14kFieldSigs(fl *ast.FieldList) []r14kParamSig {
	if fl == nil {
		return nil
	}
	var out []r14kParamSig
	for _, fld := range fl.List {
		t := types.ExprString(fld.Type)
		if len(fld.Names) == 0 {
			out = append(out, r14kParamSig{name: "", typ: t})
			continue
		}
		for _, nm := range fld.Names {
			out = append(out, r14kParamSig{name: nm.Name, typ: t})
		}
	}
	return out
}

// r14kResultSigs 展开返回值表。
func r14kResultSigs(fl *ast.FieldList) []string {
	if fl == nil {
		return nil
	}
	var out []string
	for _, fld := range fl.List {
		t := types.ExprString(fld.Type)
		n := len(fld.Names)
		if n == 0 {
			n = 1
		}
		for i := 0; i < n; i++ {
			out = append(out, t)
		}
	}
	return out
}

// computeConsumed 求不动点：参数 i 是否**被当连接用**（对它发语句，或继续传给另一个
// "被当连接用"的参数位）。
//
// 为什么需要它：本仓有一批"多态句柄 + 池只当缓存键"的形态
// （`getSettingQ(q rowQuerier, scope *sql.DB, key)` → `settingsCache.get(scope, …)`），
// 把 `scope` 当连接看会产出 18 条假阳性（V14-C 的 AST 扫描把它们全部人工判为良性）。
func (ix *r14kIndex) computeConsumed() {
	for changed := true; changed; {
		changed = false
		for _, d := range ix.decls {
			for i, p := range d.params {
				if d.consumed[i] || p.name == "" {
					continue
				}
				// 池句柄与**多态句柄**（`rowQuerier` / `usageExecer` …）都要算：
				// `GroupByID(db, id) { return groupByIDQ(db, id) }` 就是"把池句柄
				// 送进多态槽位、由被调方发语句"的形态 —— 只看 `*sql.DB` 参数会漏掉它。
				if !r14kIsPoolType(p.typ) && !r14kIsPolymorphicHandle(p.typ) {
					continue
				}
				if ix.paramUsedAsConn(d, p.name) {
					d.consumed[i] = true
					changed = true
				}
			}
		}
	}
}

// paramUsedAsConn 判"这个参数在函数体里被当连接用"。
func (ix *r14kIndex) paramUsedAsConn(d *r14kDecl, pname string) bool {
	found := false
	ast.Inspect(d.body, func(n ast.Node) bool {
		if found {
			return false
		}
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && id.Name == pname && r14kPoolStatementMethods[sel.Sel.Name] {
				found = true
				return false
			}
		}
		name, ok := r14kCalleeName(call.Fun, d.imports)
		if !ok {
			return true
		}
		for _, callee := range ix.byName[name] {
			for j, arg := range call.Args {
				if id, ok := arg.(*ast.Ident); !ok || id.Name != pname {
					continue
				}
				if j < len(callee.params) && callee.consumed[j] {
					found = true
					return false
				}
			}
		}
		return true
	})
	return found
}

// r14kCalleeName 取被调者的名字：本包函数（`f`）或包限定调用（`pkg.F`）。
// 方法调用（`x.f()`）返回 ok=false —— 见 r14kImports 的注释。
func r14kCalleeName(fun ast.Expr, imports map[string]bool) (string, bool) {
	switch f := fun.(type) {
	case *ast.Ident:
		return f.Name, true
	case *ast.SelectorExpr:
		if id, ok := f.X.(*ast.Ident); ok && imports[id.Name] {
			return f.Sel.Name, true
		}
	}
	return "", false
}

// ---------------------------------------------------------------------------
// 扫描：语句序列（含分支合并）推进"是否持有连接"
// ---------------------------------------------------------------------------

// r14kState 是扫描过程中的"持有点"状态。
type r14kState struct {
	open    bool            // 当前是否持有事务/连接
	txVars  map[string]bool // 事务句柄变量名
	closers map[string]bool // "本地 rollback 闭包"的名字（调用它 = 关闭区域）
}

func r14kStateClone(st r14kState) r14kState {
	out := r14kState{open: st.open, txVars: map[string]bool{}, closers: map[string]bool{}}
	for k := range st.txVars {
		out.txVars[k] = true
	}
	for k := range st.closers {
		out.closers[k] = true
	}
	return out
}

func r14kMerge(a, b r14kState) r14kState {
	out := r14kStateClone(a)
	out.open = a.open || b.open
	for k := range b.txVars {
		out.txVars[k] = true
	}
	for k := range b.closers {
		out.closers[k] = true
	}
	return out
}

// r14kScanner 扫一个函数体。
type r14kScanner struct {
	ix   *r14kIndex
	unit *r14kUnit
	decl *r14kDecl
	hits []r14kHit
	// poolLocals 是本函数内被识别为池句柄的局部名（含别名，M2 收口）。
	poolLocals map[string]bool
}

func (sc *r14kScanner) rel() string { return sc.unit.rel }

func (sc *r14kScanner) line(n ast.Node) int {
	return sc.unit.fset.Position(n.Pos()).Line
}

func (sc *r14kScanner) snippet(n ast.Node) string {
	start := sc.unit.fset.Position(n.Pos())
	end := sc.unit.fset.Position(n.End())
	raw := sc.unit.src()
	if start.Offset < 0 || end.Offset > len(raw) || start.Offset >= end.Offset {
		return ""
	}
	s := strings.TrimSpace(string(raw[start.Offset:end.Offset]))
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\t", " ")
	for strings.Contains(s, "  ") {
		s = strings.ReplaceAll(s, "  ", " ")
	}
	if len(s) > 120 {
		s = s[:120] + "…"
	}
	return s
}

// r14kUnit.src 返回源文件字节（扫描期用；索引阶段已读入）。
func (u *r14kUnit) src() []byte { return u.raw }

// r14kIsPoolExpr 判"这个表达式是池句柄"。
func (sc *r14kScanner) r14kIsPoolExpr(e ast.Expr) bool {
	switch v := e.(type) {
	case *ast.Ident:
		if v.Name == "nil" {
			return false
		}
		return sc.poolLocals[v.Name] || sc.ix.poolVar[v.Name]
	case *ast.SelectorExpr:
		// `a.DB` / `store.db`：字段名命中结构体 `*sql.DB` 字段表。
		if sc.ix.poolField[v.Sel.Name] {
			if _, ok := v.X.(*ast.Ident); ok {
				return true
			}
		}
		return false
	case *ast.ParenExpr:
		return sc.r14kIsPoolExpr(v.X)
	}
	return false
}

// r14kRecordHit 记一条命中（同一位置只记一次）。
func (sc *r14kScanner) r14kRecordHit(n ast.Node, what string) {
	line := sc.line(n)
	for _, h := range sc.hits {
		if h.line == line && h.what == what {
			return
		}
	}
	sc.hits = append(sc.hits, r14kHit{key: sc.decl.key, rel: sc.rel(), line: line, what: what})
}

// scanDecl 扫一个函数体，返回命中。
func (ix *r14kIndex) scanDecl(unit *r14kUnit, d *r14kDecl) []r14kHit {
	sc := &r14kScanner{ix: ix, unit: unit, decl: d, poolLocals: map[string]bool{}}
	st := r14kState{txVars: map[string]bool{}, closers: map[string]bool{}}
	// 规则二（类型化）：任何**事务/连接句柄参数**都意味着"调用方已经持有连接"，
	// 整个函数体都是区域 —— 与参数**名字**无关（M5 收口），也与是不是第一参数无关。
	for _, p := range d.params {
		if p.name == "" {
			continue
		}
		// 池句柄参数：`db` / `pool` / 任何名字的 `*sql.DB` 参数都是池句柄
		// （类型识别，不看名字）。
		if r14kIsPoolType(p.typ) {
			sc.poolLocals[p.name] = true
		}
		if p.typ == "*sql.Tx" || p.typ == "*sql.Conn" {
			st.open = true
			st.txVars[p.name] = true
		}
		// 多态句柄（`rowQuerier` / `usageExecer` …）：调用方可能传 tx，也可能传池。
		// 这里按"可能持有连接"处理（保守方向是多报），本仓这类函数不碰池。
		if r14kIsPolymorphicHandle(p.typ) {
			st.open = true
			st.txVars[p.name] = true
		}
	}
	sc.stmts(d.body.List, st)
	return sc.hits
}

// r14kIsPolymorphicHandle 判"多态句柄"类型（`*sql.DB` 与 `*sql.Tx` 都满足的接口）。
func r14kIsPolymorphicHandle(t string) bool {
	switch t {
	case "rowQuerier", "usageQuerier", "usageExecer", "usageQuerierExecer":
		return true
	}
	return false
}

// stmts 顺序扫描一串语句并按分支语义推进状态。
func (sc *r14kScanner) stmts(list []ast.Stmt, st r14kState) r14kState {
	cur := r14kStateClone(st)
	for _, s := range list {
		cur = sc.stmt(s, cur)
	}
	return cur
}

// r14kTerminates 判"这个语句块是否以终止语句结束"（return/break/continue/goto）。
// 终止的分支不参与状态合并 —— 这正是 M6（分支里回滚后 return）能被咬住的原因。
func r14kTerminates(list []ast.Stmt) bool {
	if len(list) == 0 {
		return false
	}
	switch list[len(list)-1].(type) {
	case *ast.ReturnStmt, *ast.BranchStmt:
		return true
	}
	return false
}

// stmt 扫一条语句。
func (sc *r14kScanner) stmt(s ast.Stmt, st r14kState) r14kState {
	switch v := s.(type) {
	case *ast.BlockStmt:
		return sc.stmts(v.List, st)
	case *ast.ExprStmt:
		sc.expr(v.X, st)
		return sc.advance(s, st)
	case *ast.AssignStmt:
		for _, r := range v.Rhs {
			sc.expr(r, st)
		}
		sc.noteAliases(v, st)
		return sc.advance(s, st)
	case *ast.DeclStmt:
		if gd, ok := v.Decl.(*ast.GenDecl); ok {
			for _, spec := range gd.Specs {
				vs, ok := spec.(*ast.ValueSpec)
				if !ok {
					continue
				}
				for _, val := range vs.Values {
					sc.expr(val, st)
				}
				// `var x *sql.DB` / `var tx *sql.Tx` 的生命周期从声明处开始。
				if r14kIsPoolType(types.ExprString(vs.Type)) {
					for _, nm := range vs.Names {
						sc.poolLocals[nm.Name] = true
					}
				}
			}
		}
		return sc.advance(s, st)
	case *ast.ReturnStmt:
		for _, r := range v.Results {
			sc.expr(r, st)
		}
		return st
	case *ast.DeferStmt:
		// defer 的实参在**注册时**求值：此时若持有事务，取连接就是 hold-and-wait。
		// 但 defer 的**关闭语义**不改变当前状态（它在函数返回时才跑）——
		// `defer tx.Rollback()` 之后仍然持有事务（G1 的经典形态就靠这条）。
		sc.expr(v.Call, st)
		return st
	case *ast.GoStmt:
		sc.expr(v.Call, st)
		return st
	case *ast.IfStmt:
		if v.Init != nil {
			st = sc.stmt(v.Init, st)
		}
		sc.expr(v.Cond, st)
		bodySt := sc.stmts(v.Body.List, st)
		states := []r14kState{}
		if !r14kTerminates(v.Body.List) {
			states = append(states, bodySt)
		}
		if v.Else != nil {
			elseSt := sc.stmt(v.Else, st)
			if !r14kTerminatesStmt(v.Else) {
				states = append(states, elseSt)
			}
		} else {
			states = append(states, st) // if 不成立的分支继续持有原来的状态
		}
		if len(states) == 0 {
			return st
		}
		out := states[0]
		for _, s2 := range states[1:] {
			out = r14kMerge(out, s2)
		}
		return out
	case *ast.ForStmt:
		if v.Init != nil {
			st = sc.stmt(v.Init, st)
		}
		if v.Cond != nil {
			sc.expr(v.Cond, st)
		}
		bodySt := sc.stmts(v.Body.List, st)
		if v.Post != nil {
			sc.stmt(v.Post, bodySt)
		}
		return r14kMerge(st, bodySt)
	case *ast.RangeStmt:
		sc.expr(v.X, st)
		bodySt := sc.stmts(v.Body.List, st)
		return r14kMerge(st, bodySt)
	case *ast.SwitchStmt:
		if v.Init != nil {
			st = sc.stmt(v.Init, st)
		}
		if v.Tag != nil {
			sc.expr(v.Tag, st)
		}
		out := st
		for _, c := range v.Body.List {
			cc, ok := c.(*ast.CaseClause)
			if !ok {
				continue
			}
			for _, e := range cc.List {
				sc.expr(e, st)
			}
			out = r14kMerge(out, sc.stmts(cc.Body, st))
		}
		return out
	case *ast.TypeSwitchStmt:
		if v.Init != nil {
			st = sc.stmt(v.Init, st)
		}
		if v.Assign != nil {
			st = sc.stmt(v.Assign, st)
		}
		out := st
		for _, c := range v.Body.List {
			cc, ok := c.(*ast.CaseClause)
			if !ok {
				continue
			}
			out = r14kMerge(out, sc.stmts(cc.Body, st))
		}
		return out
	case *ast.SelectStmt:
		out := st
		for _, c := range v.Body.List {
			cc, ok := c.(*ast.CommClause)
			if !ok {
				continue
			}
			if cc.Comm != nil {
				out = r14kMerge(out, sc.stmt(cc.Comm, st))
			}
			out = r14kMerge(out, sc.stmts(cc.Body, st))
		}
		return out
	case *ast.LabeledStmt:
		return sc.stmt(v.Stmt, st)
	case *ast.SendStmt:
		sc.expr(v.Chan, st)
		sc.expr(v.Value, st)
		return st
	case *ast.IncDecStmt:
		sc.expr(v.X, st)
		return st
	default:
		// 兜底：把语句里出现的表达式按当前状态扫一遍（不深入子语句树，避免重复计数）。
		ast.Inspect(s, func(n ast.Node) bool {
			if _, isStmt := n.(ast.Stmt); isStmt && n != s {
				return false
			}
			if e, ok := n.(ast.Expr); ok {
				sc.expr(e, st)
			}
			return true
		})
		return st
	}
}

// r14kTerminatesStmt 判 else 分支（语句形态）是否终止。
func r14kTerminatesStmt(s ast.Stmt) bool {
	switch v := s.(type) {
	case *ast.BlockStmt:
		return r14kTerminates(v.List)
	case *ast.ReturnStmt, *ast.BranchStmt:
		return true
	case *ast.IfStmt:
		if v.Else == nil {
			return false
		}
		return r14kTerminates(v.Body.List) && r14kTerminatesStmt(v.Else)
	}
	return false
}

// advance 处理"开区域 / 关区域"的状态跃迁（在表达式扫描之后调用）。
func (sc *r14kScanner) advance(s ast.Stmt, st r14kState) r14kState {
	out := r14kStateClone(st)
	// ① 关闭：直接对事务句柄 Commit/Rollback，或调用本地的 rollback 闭包。
	closed := false
	ast.Inspect(s, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); ok && out.closers[id.Name] {
			closed = true
			return false
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && out.txVars[id.Name] && r14kTxCloseMethods[sel.Sel.Name] {
				closed = true
				return false
			}
		}
		return true
	})
	if closed {
		out.open = false
	}
	// ② 打开：赋值/声明右侧是"持有连接的调用"。
	ast.Inspect(s, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, r := range as.Rhs {
			if i >= len(as.Lhs) {
				continue
			}
			id, ok := as.Lhs[i].(*ast.Ident)
			if !ok || id.Name == "_" {
				continue
			}
			call, ok := r.(*ast.CallExpr)
			if !ok || !sc.callHoldsConn(call) {
				continue
			}
			out.open = true
			out.txVars[id.Name] = true
		}
		return true
	})
	// ③ 登记"本地 rollback 闭包"（`rollback := func() { tx.Rollback() }`）。
	ast.Inspect(s, func(n ast.Node) bool {
		as, ok := n.(*ast.AssignStmt)
		if !ok {
			return true
		}
		for i, r := range as.Rhs {
			if i >= len(as.Lhs) {
				continue
			}
			id, ok := as.Lhs[i].(*ast.Ident)
			if !ok {
				continue
			}
			lit, ok := r.(*ast.FuncLit)
			if !ok {
				continue
			}
			if sc.funcLitCloses(lit, out) {
				out.closers[id.Name] = true
			}
		}
		return true
	})
	return out
}

// funcLitCloses 判"这个闭包会关闭当前事务/连接"。
func (sc *r14kScanner) funcLitCloses(lit *ast.FuncLit, st r14kState) bool {
	found := false
	ast.Inspect(lit.Body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); ok && st.closers[id.Name] {
			found = true
			return false
		}
		if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
			if id, ok := sel.X.(*ast.Ident); ok && st.txVars[id.Name] && r14kTxCloseMethods[sel.Sel.Name] {
				found = true
				return false
			}
		}
		return true
	})
	return found
}

// callHoldsConn 判"调用这个函数会拿到一条连接/一个事务"（开事务点由**返回类型**推导，
// 所以未枚举的 helper（M4 的 `openUsageTxV14C`、本仓的 `beginPublishTx`）同样算区域开始）。
func (sc *r14kScanner) callHoldsConn(call *ast.CallExpr) bool {
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
		if sc.r14kIsPoolExpr(sel.X) &&
			(sel.Sel.Name == "Begin" || sel.Sel.Name == "BeginTx" || sel.Sel.Name == "Conn") {
			return true
		}
	}
	name, ok := r14kCalleeName(call.Fun, sc.unit.imports)
	if !ok {
		return false
	}
	for _, d := range sc.ix.byName[name] {
		for _, rt := range d.results {
			if r14kHoldsConnType(rt) {
				return true
			}
		}
	}
	return false
}

// noteAliases 把"池句柄赋给别的变量"登记进 poolLocals（M2 收口；也让
// `var poolConn = db` 之后的 `poolConn.QueryRow(...)` 被认出来）。
func (sc *r14kScanner) noteAliases(as *ast.AssignStmt, st r14kState) {
	for i, r := range as.Rhs {
		if i >= len(as.Lhs) {
			continue
		}
		id, ok := as.Lhs[i].(*ast.Ident)
		if !ok {
			continue
		}
		if sc.r14kIsPoolExpr(r) {
			sc.poolLocals[id.Name] = true
		}
	}
}

// expr 扫一个表达式（命中判据都在这里）。
func (sc *r14kScanner) expr(e ast.Expr, st r14kState) {
	if e == nil {
		return
	}
	switch v := e.(type) {
	case *ast.CallExpr:
		if st.open {
			sc.judgeCall(v, st)
		}
		sc.expr(v.Fun, st)
		for _, a := range v.Args {
			sc.expr(a, st)
		}
	case *ast.FuncLit:
		// 闭包捕获外层的事务与池 ⇒ 用**当前状态**扫它的函数体。
		sc.stmts(v.Body.List, st)
	case *ast.BinaryExpr:
		sc.expr(v.X, st)
		sc.expr(v.Y, st)
	case *ast.UnaryExpr:
		sc.expr(v.X, st)
	case *ast.ParenExpr:
		sc.expr(v.X, st)
	case *ast.SelectorExpr:
		sc.expr(v.X, st)
	case *ast.IndexExpr:
		sc.expr(v.X, st)
		sc.expr(v.Index, st)
	case *ast.SliceExpr:
		sc.expr(v.X, st)
		sc.expr(v.Low, st)
		sc.expr(v.High, st)
		sc.expr(v.Max, st)
	case *ast.StarExpr:
		sc.expr(v.X, st)
	case *ast.KeyValueExpr:
		sc.expr(v.Key, st)
		sc.expr(v.Value, st)
	case *ast.CompositeLit:
		for _, el := range v.Elts {
			sc.expr(el, st)
		}
	case *ast.TypeAssertExpr:
		sc.expr(v.X, st)
	case *ast.ArrayType:
		sc.expr(v.Elt, st)
	case *ast.MapType:
		sc.expr(v.Key, st)
		sc.expr(v.Value, st)
	case *ast.ChanType:
		sc.expr(v.Value, st)
	}
}

// judgeCall 是命中判据主体（仅在"当前持有连接"时调用）。
func (sc *r14kScanner) judgeCall(call *ast.CallExpr, st r14kState) {
	// ① 直接对池句柄发语句。
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok {
		if sc.r14kIsPoolExpr(sel.X) && r14kPoolStatementMethods[sel.Sel.Name] {
			sc.r14kRecordHit(call, "直接对池发语句 "+sc.snippet(call))
			return
		}
	}
	// ② 把池句柄当实参传给"该参数会被当连接用"的本仓函数（位置任意：M3/M5 收口）。
	name, ok := r14kCalleeName(call.Fun, sc.unit.imports)
	if !ok {
		return
	}
	for _, d := range sc.ix.byName[name] {
		for j, arg := range call.Args {
			if j >= len(d.params) {
				continue
			}
			if !d.consumed[j] {
				continue
			}
			if !r14kIsPoolType(d.params[j].typ) && !r14kIsPolymorphicHandle(d.params[j].typ) {
				continue
			}
			if sc.r14kIsPoolExpr(arg) {
				sc.r14kRecordHit(call, name+"(池,…)：第 "+strconv.Itoa(j+1)+" 实参 "+sc.snippet(call))
				return
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 判据
// ---------------------------------------------------------------------------

// r14kScanTree 扫整个 server/ 树，返回**未过滤**的全部命中与扫描规模。
func r14kScanTree(t *testing.T) (hits []r14kHit, files, decls, poolParams int) {
	t.Helper()
	units := r14kLoadServerUnits(t)
	ix := r14kBuildIndex(t, units)
	for _, d := range ix.decls {
		for _, p := range d.params {
			if r14kIsPoolType(p.typ) {
				poolParams++
				break
			}
		}
	}
	if len(units) < 200 {
		t.Fatalf("只扫了 %d 个非测试源文件（下限 200）—— 判据面失效", len(units))
	}
	if poolParams < 100 {
		t.Fatalf("只扫到 %d 个含 `*sql.DB` 参数的函数（下限 100）—— 判据面失效", poolParams)
	}
	for _, u := range units {
		for _, d := range collectDecls(u.file) {
			decl := ix.declFor(u, d)
			if decl == nil {
				continue
			}
			hits = append(hits, ix.scanDecl(u, decl)...)
		}
	}
	return hits, len(units), len(ix.decls), poolParams
}

// TestAuditR14KNoPoolAcquisitionUnderTx 是 hold-and-wait 的机械判据（AST 级）。
func TestAuditR14KNoPoolAcquisitionUnderTx(t *testing.T) {
	allHits, files, decls, poolParams := r14kScanTree(t)
	var hits []r14kHit
	for _, h := range allHits {
		if _, ok := r14kPoolWaitAck[h.key]; ok {
			continue
		}
		hits = append(hits, h)
	}
	if len(hits) > 0 {
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].rel != hits[j].rel {
				return hits[i].rel < hits[j].rel
			}
			return hits[i].line < hits[j].line
		})
		var lines []string
		for _, h := range hits {
			lines = append(lines, h.key+" @"+h.rel+":"+strconv.Itoa(h.line)+" → "+h.what)
		}
		t.Errorf("这些位置在**已开事务**的情况下又向连接池要了一条连接（hold-and-wait）：\n  %s\n"+
			"⇒ 池上限 = 并发数时两边互等，而 `BeginTx(context.Background())` 没有 deadline、"+
			"`SetConnMaxLifetime` 对在用连接无效 ⇒ **池不可恢复**（db.go:158 记录过同形态的真实事故）。"+
			"修法：把池上入口换成同族的 `*Q` / `*Tx` 形态（`loadModelPriceInputsQ` / `getSettingQ` / "+
			"`GetSettingTx` / `groupByIDQ` / `SetSettingTx` / `settleUsageCostTx` …），或先提交事务再取连接。"+
			"确属判据边界的假阳性请登记到 r14kPoolWaitAck 并写明理由。", strings.Join(lines, "\n  "))
	}
	t.Logf("hold-and-wait（AST 级）：扫过 %d 个非测试源文件 / %d 个函数声明（其中 %d 个含 `*sql.DB` 参数），"+
		"0 处「已开事务再向池要连接」（另 %d 处已显式认账）", files, decls, poolParams, len(allHits)-len(hits))
}

// TestAuditR14KPoolWaitAckRegistry 是认账表的**双向**核对：认账了却再也扫不到 ⇒ 红
// （口子该收回），且登记项必须带可复核的理由。
func TestAuditR14KPoolWaitAckRegistry(t *testing.T) {
	allHits, _, _, _ := r14kScanTree(t)
	seen := map[string]int{}
	for _, h := range allHits {
		seen[h.key]++
	}
	for key, why := range r14kPoolWaitAck {
		if seen[key] == 0 {
			t.Errorf("r14kPoolWaitAck 登记了 %q，但判据面内再也扫不到它的命中 —— "+
				"该处已改写（或函数被改名/删除），请收回这条认账", key)
		}
		if len(strings.TrimSpace(why)) < 20 {
			t.Errorf("认账项 %q 的理由过短（%q）：必须写清为什么不是不可恢复的 hold-and-wait", key, why)
		}
	}
	t.Logf("认账表：%d 条，全部仍能扫到命中且都带理由", len(r14kPoolWaitAck))
}

// declFor 把 ast 声明对应回索引里的 decl（同一文件里按名字+行号唯一确定）。
func (ix *r14kIndex) declFor(u *r14kUnit, fd *ast.FuncDecl) *r14kDecl {
	pkg := filepath.ToSlash(filepath.Dir(u.rel))
	key := pkg + "." + fd.Name.Name
	var candidates []*r14kDecl
	for _, d := range ix.byName[fd.Name.Name] {
		if d.key == key {
			candidates = append(candidates, d)
		}
	}
	if len(candidates) == 1 {
		return candidates[0]
	}
	// 同名重载（不同接收者）：按函数体位置匹配。
	for _, d := range candidates {
		if d.body == fd.Body {
			return d
		}
	}
	return nil
}

// r14kLoadServerUnits 解析 `server/` 下全部非测试 Go 源。
func r14kLoadServerUnits(t *testing.T) []*r14kUnit {
	t.Helper()
	root := searchPathServerRoot(t)
	var units []*r14kUnit
	err := filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if _, skip := searchPathGuardSkippedDirs[d.Name()]; skip {
				return filepath.SkipDir
			}
			if strings.HasPrefix(d.Name(), ".") && d.Name() != "." {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
			return nil
		}
		raw, rerr := os.ReadFile(path)
		if rerr != nil {
			return rerr
		}
		rel, _ := filepath.Rel(root, path)
		units = append(units, &r14kUnit{rel: filepath.ToSlash(rel), raw: raw})
		return nil
	})
	if err != nil {
		t.Fatalf("遍历 server/ 失败: %v", err)
	}
	for _, u := range units {
		fset := token.NewFileSet()
		f, perr := parser.ParseFile(fset, u.rel, u.raw, parser.SkipObjectResolution)
		if perr != nil {
			t.Fatalf("解析 %s 失败: %v", u.rel, perr)
		}
		u.fset, u.file = fset, f
	}
	return units
}
