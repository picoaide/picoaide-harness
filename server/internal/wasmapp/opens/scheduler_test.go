package opens

// 打开计数维护调度（F16/§8.9）的判据。
//
// 三条不变量（每条的变异都能单独点红）：
//
//	① **先汇总后清理**：汇总失败时**绝不**清理明细 —— 先删后汇会让 UV 永久丢失
//	   （明细是 UV 的唯一来源）。变异：把 Purge 挪到 Aggregate 之前 / 忽略汇总错误 ⇒
//	   TestSchedulerDoesNotPurgeWhenAggregateFails 红；
//	② 日汇总长期保留、明细按 90 天清理（两者不同寿命）。变异：把汇总表也清了 ⇒
//	   TestSchedulerKeepsDailyRollup 红；
//	③ 汇总**幂等**（按天全量重算，不是增量累加）—— 漏跑一轮不会丢数据，
//	   多跑一轮不会翻倍。

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// testDB 建一个迁移到最新的临时库（无 PG 时由 serverstore.NewTestDB 自行 Skip）。
func testDB(t *testing.T) *sql.DB {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	return db
}

func TestSchedulerAggregatesAndPurges(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	userID := seedUser(t, db, "u-open")

	// 一条 100 天前的明细（**应当**被汇总后清理）与一条今天的明细（必须留下）。
	old := now.AddDate(0, 0, -100)
	if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: userID, At: old}); err != nil {
		t.Fatalf("写旧明细: %v", err)
	}
	if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: userID, At: now}); err != nil {
		t.Fatalf("写新明细: %v", err)
	}

	s := NewScheduler(db, time.Minute, func() time.Time { return now })
	s.TryRun(ctx)

	// ① 明细：过期的那条被删，今天的还在。
	var detail int64
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens`).Scan(&detail); err != nil {
		t.Fatalf("数明细: %v", err)
	}
	if detail != 1 {
		t.Fatalf("明细剩余 = %d, want 1（只清 90 天前的）", detail)
	}
	// ② 汇总：被清理的那一天必须先落进日汇总（先汇总后清理的**证据**）。
	series, err := serverstore.QueryWasmAppOpens(ctx, db, serverstore.WasmOpenQuery{
		AppID: "notes", From: old.AddDate(0, 0, -1), To: old.AddDate(0, 0, 1)})
	if err != nil {
		t.Fatalf("查汇总: %v", err)
	}
	if series.TotalPV != 1 {
		t.Fatalf("被清理日的日汇总 pv = %d, want 1（明细删了但汇总必须留下）", series.TotalPV)
	}
}

func TestSchedulerDoesNotPurgeWhenAggregateFails(t *testing.T) {
	// 变异：把 TryRun 里的"汇总失败即 return"删掉（继续清理）⇒ 本用例红。
	db := testDB(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	userID := seedUser(t, db, "u-nopurge")
	if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: userID, At: now.AddDate(0, 0, -100)}); err != nil {
		t.Fatalf("写明细: %v", err)
	}

	s := NewScheduler(db, time.Minute, func() time.Time { return now })
	// 让汇总必然失败：删掉汇总表（明细还在）。
	if _, err := db.Exec(`DROP TABLE wasm_app_opens_daily`); err != nil {
		t.Fatalf("删汇总表: %v", err)
	}
	s.TryRun(ctx)

	var detail int64
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens`).Scan(&detail); err != nil {
		t.Fatalf("数明细: %v", err)
	}
	if detail != 1 {
		t.Fatal("汇总失败时**不得**清理明细（先汇总后清理：先删后汇会让 UV 永久丢失）")
	}
}

func TestSchedulerAggregateIsIdempotent(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	userID := seedUser(t, db, "u-idem")
	for i := 0; i < 3; i++ {
		if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
			AppID: "notes", UserID: userID, At: now.Add(time.Duration(i) * time.Minute)}); err != nil {
			t.Fatalf("写明细: %v", err)
		}
	}
	s := NewScheduler(db, time.Minute, func() time.Time { return now })
	for i := 0; i < 3; i++ {
		s.TryRun(ctx)
	}
	series, err := serverstore.QueryWasmAppOpens(ctx, db, serverstore.WasmOpenQuery{
		AppID: "notes", From: now, To: now})
	if err != nil {
		t.Fatalf("查汇总: %v", err)
	}
	if series.TotalPV != 3 || series.TotalUV != 1 {
		t.Fatalf("三轮维护后 pv/uv = %d/%d, want 3/1（按天全量重算，不是累加）",
			series.TotalPV, series.TotalUV)
	}
}

// TestSchedulerKeepsLongLivedRollup 钉住"日汇总长期保留"：连续多轮维护 + 时间推进，
// 汇总行必须一直在（明细早已过期）。
func TestSchedulerKeepsLongLivedRollup(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	base := time.Date(2026, 1, 10, 12, 0, 0, 0, time.UTC)
	userID := seedUser(t, db, "u-long")
	if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: userID, At: base}); err != nil {
		t.Fatalf("写明细: %v", err)
	}
	// 半年后跑一轮维护：明细被清，但那一天（1-10）的汇总必须还在。
	later := base.AddDate(0, 6, 0)
	NewScheduler(db, time.Minute, func() time.Time { return later }).TryRun(ctx)
	series, err := serverstore.QueryWasmAppOpens(ctx, db, serverstore.WasmOpenQuery{
		AppID: "notes", From: base, To: base})
	if err != nil {
		t.Fatalf("查汇总: %v", err)
	}
	if series.TotalPV != 1 {
		t.Fatalf("半年后的日汇总 pv = %d, want 1（日汇总长期保留，不随明细过期消失）", series.TotalPV)
	}
	var detail int64
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens`).Scan(&detail); err != nil {
		t.Fatalf("数明细: %v", err)
	}
	if detail != 0 {
		t.Fatalf("明细剩余 = %d, want 0（超过 90 天必须清理）", detail)
	}
}

func seedUser(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := serverstore.CreateUser(db, &serverstore.User{
		Username: name, Source: "local", Status: 1, Role: serverstore.RoleUser})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	return id
}

// TestSchedulerKeepsDailyRollupAcrossRetentionBoundary 是 R19B-01（审计 2026-09-25，P1，
// **不可逆的数据损坏**）的判据。
//
// 缺陷形态（修前实测）：清理边界是**裸瞬时** now-90d（落在某一天的正中间），而日汇总
// 是**整日分桶 + 全量覆盖**（ON CONFLICT DO UPDATE SET pv = EXCLUDED.pv）⇒ 清理把边界
// 那一天只删一半后，下一轮从"剩下的那半天"重算并覆盖同一天，日汇总逐轮缩水；等边界扫过
// 该日，明细已删完 ⇒ 长期保留的日汇总永久停在"最后一个 5 分钟 tick 的量"。
// 一天 4 次打开 ⇒ 修前最终 pv=1（want 4），日志 `deleted=2 / 1 / 1`。
//
// 变异（必须变红）：把 TryRun 的 `purgeBefore` 换回裸瞬时
// `now.AddDate(0, 0, -serverstore.WasmAppOpensRetentionDays)`（汇总上界与清理边界一起
// 退回修前形态）⇒ 本用例在"日汇总缩水"那一条上报错，终值断言也会红（pv=1）。
//
// 两条断言，缺一条都咬不住：
//   - **单调性**：日汇总在维护过程中只能变大不能变小（明细只会被删；出现缩水必然是
//     "某一天被部分删除过"）；
//   - **终值 + 整日清理**：明细清空后该日 pv 仍是 4，且剩余明细不得落在被清那一天之内。
func TestSchedulerKeepsDailyRollupAcrossRetentionBoundary(t *testing.T) {
	db := testDB(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	// 边界日 = now-90d 那一天（cutoff 12:00 落在日中间，正是修前的形态）。
	boundary := serverstore.LocalDay(now.AddDate(0, 0, -serverstore.WasmAppOpensRetentionDays))
	userID := seedUser(t, db, "u-boundary")

	// 边界日里 4 次打开（00:30 / 06:00 / 12:30 / 18:00）——修前 00:30 与 06:00 先过期。
	for i, off := range []time.Duration{
		30 * time.Minute,
		6 * time.Hour,
		12*time.Hour + 30*time.Minute,
		18 * time.Hour,
	} {
		if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
			AppID: "notes", UserID: userID, At: boundary.Add(off)}); err != nil {
			t.Fatalf("写边界日明细 %d: %v", i, err)
		}
	}
	// 保留期内的另一天：它绝不能被算进"被清的那一天"，也必须原样留着（整日清理的反面判据）。
	kept := boundary.AddDate(0, 0, 2).Add(3 * time.Hour)
	if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
		AppID: "notes", UserID: userID, At: kept}); err != nil {
		t.Fatalf("写保留期内明细: %v", err)
	}

	clock := now
	s := NewScheduler(db, 5*time.Minute, func() time.Time { return clock })
	pvOf := func(day time.Time) int64 {
		series, err := serverstore.QueryWasmAppOpens(ctx, db, serverstore.WasmOpenQuery{
			AppID: "notes", From: day, To: day, Granularity: "day"})
		if err != nil {
			t.Fatalf("查汇总: %v", err)
		}
		var sum int64
		for _, pt := range series.Points {
			sum += pt.PV
		}
		return sum
	}
	if got := pvOf(boundary); got != 0 {
		t.Fatalf("前置条件不成立：维护开始前该日汇总应为 0，实得 %d", got)
	}

	prev := int64(-1)
	for i := 0; i < 400; i++ {
		s.TryRun(ctx)
		got := pvOf(boundary)
		if prev >= 0 && got < prev {
			t.Fatalf("第 %d 轮：日汇总由 %d 缩到 %d —— 日汇总被更小的值覆盖（"+
				"清理边界必须与汇总上界一起对齐到日边界）", i, prev, got)
		}
		if got > prev {
			prev = got
		}
		clock = clock.Add(5 * time.Minute)
		if clock.After(now.Add(30 * time.Hour)) {
			break
		}
	}

	if prev != 4 {
		t.Fatalf("明细过期后该日日汇总 pv = %d, want 4（明细已删 ⇒ 不可重算，这类损坏不可逆）", prev)
	}
	var leftBoundary, leftKept int64
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens
		WHERE app_id='notes' AND opened_at >= $1 AND opened_at < $2`,
		boundary.UTC(), boundary.AddDate(0, 0, 1).UTC()).Scan(&leftBoundary); err != nil {
		t.Fatalf("数边界日明细: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens
		WHERE app_id='notes' AND opened_at >= $1 AND opened_at < $2`,
		serverstore.LocalDay(kept).UTC(),
		serverstore.LocalDay(kept).AddDate(0, 0, 1).UTC()).Scan(&leftKept); err != nil {
		t.Fatalf("数保留期内明细: %v", err)
	}
	if leftBoundary != 0 {
		t.Fatalf("边界日明细剩余 = %d, want 0（超保留期必须整日清掉）", leftBoundary)
	}
	if leftKept != 1 {
		t.Fatalf("保留期内明细剩余 = %d, want 1（不得被提前清理）", leftKept)
	}
}
