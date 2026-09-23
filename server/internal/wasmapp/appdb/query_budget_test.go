package appdb

import (
	"context"
	"runtime"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 WDB-1（P1，2026-09-23 独立审计）的回归门禁：
// `SQLMaxResultBytes`（8 MiB）的判定必须**前移到行物化过程中/之前**，而不是在
// "整行进入 Go 堆 + 每个 []byte 复制成 string"之后。
//
// 缺陷形态（修复前实测）：`SELECT zeroblob(1048576) ×128`（单行 128 MiB =
// SQLITE_LIMIT_COLUMN × SQLITE_LIMIT_LENGTH 的结构上界）一次查询
// **TotalAlloc 384 MiB / 446 ms**，而应用侧收益为零（0 行 + `Truncated=true`）。
// 可达链：任意应用 `db.query`（hostcap → appdb.Query）。
//
// 修复后的两条判据：
//  1. **结构化错误**：单行就吃掉整份结果预算时返回既有的 DB_LIMIT
//     （`details.reason = result_too_large`，§7.4 的"行数/结果超限"档），
//     而不是"0 行 + Truncated"这种应用无从判断的形态；
//  2. **分配有界**：整条查询的分配不超过"驱动单行物化的结构上界"
//     （COLUMN × LENGTH = 128 MiB）+ 余量 —— 修复前是它的 3 倍。
//
// 变异验证（实跑，见交付报告）：
//   - 把预算判定挪回 `[]byte→string` 之后（= 修复前形态）⇒
//     TestQuerySingleRowOverBudgetIsBounded 的分配断言红（实测 384 MiB > 144 MiB）；
//   - 删掉"单行超预算即报错"的分支（退回 `truncated=true; break`）⇒
//     同一用例的错误码断言红。

// TestQuerySingleRowOverBudgetIsBounded 是 WDB-1 的主判据（单行 128 列 × 1 MiB）。
func TestQuerySingleRowOverBudgetIsBounded(t *testing.T) {
	d := newTestDB(t, "budget-app")

	cols := make([]string, 0, limits.SQLLimitColumn)
	for i := 0; i < limits.SQLLimitColumn; i++ {
		cols = append(cols, "zeroblob(1048576)") // 每列恰好 = SQLITE_LIMIT_LENGTH
	}
	sql := "SELECT " + strings.Join(cols, ", ")

	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	res, err := d.Query(context.Background(), abi.SQLParams{SQL: sql})
	runtime.ReadMemStats(&after)
	delta := after.TotalAlloc - before.TotalAlloc

	// ① 结构化错误（既有码 DB_LIMIT + 具体 reason）。
	e := requireAppErr(t, err, apperr.CodeDBLimit)
	requireReason(t, e, "result_too_large")
	if got, _ := e.Details["max"].(int); got != limits.SQLMaxResultBytes {
		t.Fatalf("details.max = %v, want %d", e.Details["max"], limits.SQLMaxResultBytes)
	}
	if len(res.Rows) != 0 {
		t.Fatalf("超预算的单行不得进结果，实得 %d 行", len(res.Rows))
	}

	// ② 分配有界：结构上界（驱动单行物化 = COLUMN × LENGTH）+ 16 MiB 余量。
	structural := int64(limits.SQLLimitColumn) * int64(limits.SQLLimitLength)
	budget := uint64(structural) + 16<<20
	if delta > budget {
		t.Fatalf("单行超预算查询分配 %d MiB，超过预算 %d MiB（结构上界 %d MiB）——"+
			"结果预算判定没有前移到物化之前", delta>>20, budget>>20, structural>>20)
	}
	t.Logf("单行 %d 列 × 1 MiB：alloc=%d MiB（结构上界 %d MiB），err=%s/%s",
		limits.SQLLimitColumn, delta>>20, structural>>20, e.Code, e.Details["reason"])
}

// TestQueryOverBudgetStillTruncatesForMultiRow 钉住 §4.5 的**分页语义**不被误改：
// 多行累计超限仍走"截断 + Truncated"（设计一致性报告 D6 的有意偏离），
// 只有"单行就吃掉整份预算"才升级成错误。
func TestQueryOverBudgetStillTruncatesForMultiRow(t *testing.T) {
	d := newTestDB(t, "budget-multi")
	defineTable(t, d, "big", col("v", "text"))
	// 每行 32 KiB（**单行远小于预算**），12 行累计 384 KiB > SQLMaxResultBytes(168 KiB)
	// ⇒ 走"截断 + Truncated"而不是"单行超预算"那条错误路径。
	//
	// ⚠️ 2026-09-23 审计 A-1 把预算从 8 MiB 收到 168 KiB 后，本用例的夹具必须跟着改：
	// 原来用 900 KiB/行，收预算后**单行**就超过整份预算 ⇒ 走 DB_LIMIT，而本用例要钉的是
	// "多行累计超限仍截断"这条**分页语义**（两种形态各有专门用例，见
	// TestQueryOverBudgetSingleRowRejected）。
	chunk := strings.Repeat("x", 32*1024)
	for i := 0; i < 12; i++ {
		mustExec(t, d, "INSERT INTO big(v) VALUES (?)", chunk)
	}
	res, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT v FROM big"})
	if err != nil {
		t.Fatalf("多行累计超限必须走截断（分页语义），实得错误：%v", err)
	}
	if !res.Truncated {
		t.Fatal("累计超限必须置 Truncated=true")
	}
	if len(res.Rows) == 0 || len(res.Rows) >= 12 {
		t.Fatalf("应在预算处停下且至少保留一行，实得 %d 行", len(res.Rows))
	}
	var total int64
	for _, row := range res.Rows {
		total += valueBytes(row[0])
	}
	if total > limits.SQLMaxResultBytes {
		t.Fatalf("返回字节 %d 超过上限 %d", total, limits.SQLMaxResultBytes)
	}
}

// TestQueryKeepsLargeValuesIntact 是"省掉复制"这一刀的反向对照：
// 预算内的正常值（含 BLOB 转 string 的那条路径）必须逐字返回。
//
// 变异：rawCell.value() 丢掉 bin（或 Scan 里把 []byte 置空）⇒ 本用例红。
func TestQueryKeepsLargeValuesIntact(t *testing.T) {
	d := newTestDB(t, "budget-keep")
	ctx := context.Background()

	// 2026-09-23 审计 A-1：返回值预算收到 168 KiB（与单帧预算自洽）⇒ 夹具取 64 KiB，
	// 既在预算内、又足够大到真的走 []byte→string 那条复制路径。
	const blobBytes = 64 * 1024
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT zeroblob(65536)"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(res.Rows) != 1 || len(res.Rows[0]) != 1 {
		t.Fatalf("应返回 1 行 1 列，实得 %d 行", len(res.Rows))
	}
	s, ok := res.Rows[0][0].(string)
	if !ok {
		t.Fatalf("BLOB 必须归一成 string（避免 JSON base64），实得 %T", res.Rows[0][0])
	}
	if len(s) != blobBytes {
		t.Fatalf("BLOB 长度 %d，want %d（[]byte→string 复制路径被破坏）", len(s), blobBytes)
	}
	if res.Truncated {
		t.Fatal("200 KiB 单值远在预算内，不得截断")
	}

	// 文本 + 数值 + NULL + 布尔的混合行（覆盖 rawCell.Scan 的其它分支）。
	mixed, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 'txt', 42, 1.5, NULL, 1=1"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	row := mixed.Rows[0]
	if row[0] != "txt" {
		t.Fatalf("text 列 = %v", row[0])
	}
	if n, ok := row[1].(int64); !ok || n != 42 {
		t.Fatalf("int 列 = %#v", row[1])
	}
	if f, ok := row[2].(float64); !ok || f != 1.5 {
		t.Fatalf("float 列 = %#v", row[2])
	}
	if row[3] != nil {
		t.Fatalf("NULL 列 = %#v", row[3])
	}
	if b, ok := row[4].(int64); !ok || b != 1 {
		t.Fatalf("bool 表达式列 = %#v", row[4])
	}
	// 计量口径（valueBytes）必须与查询路径的累加一致。
	//
	// ⚠️ Stats() 是**句柄生命周期累计**（审计 WDB-2，本包已知项、不在本次修复范围），
	// 所以这里比的是**增量**：本次查询前后之差。
	beforeStats := d.Stats()
	mixed2, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 'txt', 42, 1.5, NULL, 1=1"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	afterStats := d.Stats()
	var want int64
	for _, v := range mixed2.Rows[0] {
		want += valueBytes(v)
	}
	if got := afterStats.Bytes - beforeStats.Bytes; got != want {
		t.Fatalf("本次查询 Stats.Bytes 增量 = %d，按 valueBytes 复算 = %d（计量口径漂移）", got, want)
	}
}
