package serverstore

// R14-O · VC-F2 的**尺子自检**：AST 尺子的每一条规则都必须能被"真形态"打中，
// 且不能误伤本仓的合法形态。
//
// 为什么需要它：V14-C 用六个变异证明**文本尺子**有三条未登记盲区（M3 多行实参 /
// M4 未枚举的开事务 helper / M5 规则二按参数名豁免），而"再加一条正则"并不闭合
// ——动态形态是开放集。本文件把这三条（以及 M1/M2/M6）**钉成可执行的夹具**：
// 尺子被改窄（漏掉某一形态）或改宽（把合法形态判成 hold-and-wait）都在这里当场红。
//
// 夹具里的每个函数名都对应一条变异（m1…m9 = 必须命中；n1…n7 = 必须不命中），
// 并与 temp/r14/laneO/run-f2.sh 的真源码变异一一对应。

import (
	"go/parser"
	"go/token"
	"testing"
)

// r14kSelfCheckPrelude 是被扫源码的"外部世界"：本仓那几个"参数被当连接用"的函数
// （`loadModelPriceInputs` / `usageRelationGone`）与"池只当缓存键"的函数
// （`getSettingQ`）——不动点必须能区分这两类。
const r14kSelfCheckPrelude = `package snippet

import "database/sql"

type rowQuerier interface{ QueryRow(string, ...any) *sql.Row }

type modelPriceInputs struct{}

func loadModelPriceInputs(db *sql.DB, providerID int64, model string) modelPriceInputs {
	_ = db.QueryRow("SELECT 1")
	return modelPriceInputs{}
}

func loadModelPriceInputsQ(q rowQuerier, scope *sql.DB, providerID int64, model string) modelPriceInputs {
	_ = q.QueryRow("SELECT 1")
	return modelPriceInputs{}
}

func usageRelationGone(db *sql.DB, rel string) bool {
	_ = db.QueryRow("SELECT 1")
	return false
}

func getSettingQ(q rowQuerier, scope *sql.DB, key string) (string, bool, error) {
	// scope 只当 TTL 缓存键用 —— 不取连接。
	_ = scope
	_ = q.QueryRow("SELECT 1")
	return "", false, nil
}

func openUsageTxV14C(db *sql.DB) (*sql.Tx, error) { return db.Begin() }

func helperFn(fn func() bool) bool { return fn() }
`

// r14kSelfCheckPositives 是"必须命中"的形态（每条对应一个变异/盲区）。
const r14kSelfCheckPositives = `
// m1：同一条语句里把事务内的取价换回池上入口（lane K 的 G1 对照）。
func m1(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	_ = loadModelPriceInputs(db, providerID, model)
	_ = tx.Commit()
}

// m2：池句柄先赋给别的变量名（盲区②：按名字豁免会漏）。
func m2(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	poolConn := db
	_ = loadModelPriceInputs(poolConn, providerID, model)
	_ = tx.Commit()
}

// m3：池句柄在**下一行**（多行实参；逐行匹配的尺子看不见）。
func m3(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_ = loadModelPriceInputs(
		db,
		providerID,
		model,
	)
	_ = tx.Commit()
}

// m4：开事务入口是**未被枚举**的 helper（返回类型推导，不靠硬编码名单）。
func m4(db *sql.DB, providerID int64, model string) {
	tx, err := openUsageTxV14C(db)
	if err != nil {
		return
	}
	_ = loadModelPriceInputs(db, providerID, model)
	_ = tx.Commit()
}

// m5：池在**第二个实参位**，且被调函数的首参是事务句柄（盲区③：按参数名豁免）。
func m5(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_ = priceInputsViaPoolV14C(tx, db, providerID, model)
	_ = tx.Commit()
}

func priceInputsViaPoolV14C(db *sql.Tx, pool *sql.DB, providerID int64, model string) modelPriceInputs {
	return loadModelPriceInputs(pool, providerID, model)
}

// m6：分支里"回滚后 return"（该分支终止 ⇒ 不关闭外层区域；盲区①的真形态）。
func m6(db *sql.DB, promptTokens, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	if promptTokens > 5000000 {
		_ = tx.Rollback()
		return
	}
	_ = loadModelPriceInputs(db, providerID, model)
	_ = tx.Commit()
}

// m7：「defer tx.Rollback()」不能关闭区域（它在函数返回时才跑）。
func m7(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	_ = loadModelPriceInputs(db, providerID, model)
	_ = tx.Commit()
}

// m8：句柄首参的函数（只有类型是事务句柄，名字无所谓）不得碰池。
func m8(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_ = txHolderTouchesPool(tx, db, providerID, model)
	_ = tx.Commit()
}

func txHolderTouchesPool(db *sql.Tx, pool *sql.DB, providerID int64, model string) modelPriceInputs {
	return loadModelPriceInputs(pool, providerID, model)
}

// m9：把取池包进闭包（闭包捕获事务 ⇒ 与直接调用同罪）。
func m9(db *sql.DB, rel string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	_ = helperFn(func() bool { return usageRelationGone(db, rel) })
	_ = tx.Commit()
}
`

// r14kSelfCheckNegatives 是"必须不命中"的合法形态（本仓真实存在的写法）。
const r14kSelfCheckNegatives = `
// n1：没有事务，随便用池。
func n1(db *sql.DB, providerID int64, model string) {
	_ = loadModelPriceInputs(db, providerID, model)
}

// n2：先回滚再取池（连接已归还）。
func n2(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_ = tx.Rollback()
	_ = loadModelPriceInputs(db, providerID, model)
}

// n3：提交之后再用池（连接已归还）。
func n3(db *sql.DB, providerID int64, model string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	_ = tx.Commit()
	_ = loadModelPriceInputs(db, providerID, model)
}

// n4：池句柄只当 TTL 缓存键传下去（getSettingQ 的 scope）—— 不动点必须认出
// "这个参数不被当连接用"。
func n4(tx *sql.Tx, scope *sql.DB, key string) (string, bool, error) {
	return getSettingQ(tx, scope, key)
}

// n5：本地 rollback 闭包先跑，再在闭包实参里取池（本仓 settleUsageReclaim 的形态）。
func n5(db *sql.DB, rel string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	rollback := func() { _ = tx.Rollback() }
	if _, err := tx.Exec("LOCK TABLE x"); err != nil {
		rollback()
		_ = helperFn(func() bool { return usageRelationGone(db, rel) })
		return
	}
	_ = tx.Commit()
}

// n6：先取池再开事务（顺序不构成 hold-and-wait）。
func n6(db *sql.DB, providerID int64, model string) {
	_ = loadModelPriceInputs(db, providerID, model)
	tx, err := db.Begin()
	if err != nil {
		return
	}
	_ = tx.Commit()
}

// n7：直接回滚之后在闭包里取池（回滚先于闭包求值）。
func n7(db *sql.DB, rel string) {
	tx, err := db.Begin()
	if err != nil {
		return
	}
	defer tx.Rollback()
	if _, err := tx.Exec("LOCK TABLE x"); err != nil {
		_ = tx.Rollback()
		_ = helperFn(func() bool { return usageRelationGone(db, rel) })
		return
	}
	_ = tx.Commit()
}
`

// r14kScanSelfCheck 解析一段夹具源码，返回每个函数的命中条数。
func r14kScanSelfCheck(t *testing.T, src string) map[string]int {
	t.Helper()
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "r14o_selfcheck/snippet.go", src, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析自检夹具失败: %v", err)
	}
	u := &r14kUnit{rel: "r14o_selfcheck/snippet.go", raw: []byte(src), fset: fset, file: f}
	ix := r14kBuildIndex(t, []*r14kUnit{u})
	out := map[string]int{}
	for _, fd := range collectDecls(f) {
		d := ix.declFor(u, fd)
		if d == nil {
			t.Fatalf("declFor(%s) 失败：索引与 AST 对不上", fd.Name.Name)
		}
		out[d.name] = len(ix.scanDecl(u, d))
	}
	return out
}

// TestAuditR14KPoolWaitASTRulerSelfCheck 是尺子的正/负向自检。
func TestAuditR14KPoolWaitASTRulerSelfCheck(t *testing.T) {
	hits := r14kScanSelfCheck(t, r14kSelfCheckPrelude+r14kSelfCheckPositives+r14kSelfCheckNegatives)

	// 正向：每一条变异形态都必须被咬住（少一条就是尺子被改窄）。
	positives := map[string]string{
		"m1": "语句内把事务内取价换回池上入口",
		"m2": "池句柄赋给别的变量名（别名）",
		"m3": "池句柄在下一行（多行实参）",
		"m4": "未被枚举的开事务 helper（按返回类型推导）",
		"m5": "池在第二个实参位（首参是事务句柄）",
		"m6": "分支里回滚后 return（不关闭外层区域）",
		"m7": "defer tx.Rollback() 不关闭区域",
		"m8": "句柄首参函数不得碰池（与名字无关）",
		"m9": "闭包捕获事务后取池",
	}
	for fn, why := range positives {
		if hits[fn] == 0 {
			t.Errorf("尺子漏掉了形态 %s（%s）—— 该形态在真源码里就是 hold-and-wait", fn, why)
		}
	}
	// 负向：合法形态必须不命中（多一条就是尺子被改宽 ⇒ 会逼人写认账条目）。
	negatives := map[string]string{
		"n1": "没有事务",
		"n2": "先回滚再取池",
		"n3": "提交之后再用池",
		"n4": "池句柄只当 TTL 缓存键（getSettingQ 的 scope）",
		"n5": "本地 rollback 闭包先跑，再在闭包实参里取池",
		"n6": "先取池再开事务",
		"n7": "直接回滚之后在闭包里取池",
	}
	for fn, why := range negatives {
		if hits[fn] != 0 {
			t.Errorf("尺子误伤了合法形态 %s（%s）：命中 %d 条", fn, why, hits[fn])
		}
	}
	if len(positives) < 8 || len(negatives) < 6 {
		t.Fatalf("自检夹具退化：正向 %d 条 / 负向 %d 条（下限 8 / 6）", len(positives), len(negatives))
	}
	t.Logf("AST 尺子自检：正向 %d 条全部命中（含 V14-C 的 M3/M4/M5 三条盲区），负向 %d 条零误伤",
		len(positives), len(negatives))
}
