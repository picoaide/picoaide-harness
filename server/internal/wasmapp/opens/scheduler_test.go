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
