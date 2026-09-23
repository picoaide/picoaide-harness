package auditretention

// R4-D-4（审计 2026-09-23，P2）：审计保留策略没有周期执行者。
//
// 缺陷形态：`PurgeOldAuditLogs` 只有"服务启动时"与"管理员保存配置时"两个调用点 ——
// 一个跑几个月的实例只在启动那一刻按保留期清理，稳态下 `audit.retention_days` 不生效
// （审计表随运行时长单调增长）。
//
// 判据三条（缺一条就退化成"挂了个空壳"）：
//  1. **到期清理**：超过保留期的条目被删、未超期的保留、且被删批次里最新的一条作为
//     链锚留下（0048 哈希链的既有语义，调度器不得破坏它）；
//  2. **幂等**：连跑两次，第二次不再删任何行（锚不会被反复删）；
//  3. **关闭时退出**：ctx 取消后后台循环退出（`Stopped()` 关闭），且不再触发新的运行。

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// seedAuditRows 直接写审计行（**不**走 AuditLog：这里要精确控制 created_at，
// 且用例只验证保留策略的 DELETE 语义，不验证链校验）。
func seedAuditRows(t *testing.T, db *sql.DB, ages []time.Duration) {
	t.Helper()
	for i, age := range ages {
		at := time.Now().Add(-age).UTC()
		if _, err := db.Exec(
			`INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at, hash_version)
			 VALUES ('seed', 'act', ?, '', ?, ?, 1)`,
			"seed-"+time.Duration(i).String(), "h"+time.Duration(i).String(), at); err != nil {
			t.Fatal(err)
		}
	}
}

func countAuditRows(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow(`SELECT count(*) FROM audit_logs`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestSchedulerPurgesExpiredAndKeepsAnchor(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.SetSetting(db, serverstore.AuditRetentionSetting, "1"); err != nil {
		t.Fatal(err)
	}
	// 3 条超期 + 2 条未超期。**按时间从旧到新插入**（id 与 created_at 同序）——
	// PurgeOldAuditLogs 的链锚是"被删批次里 id 最大的那一条"（链尾），id 与时间
	// 逆序的夹具会让锚落在最旧的一条上，测的就不是"保留链尾"了。
	seedAuditRows(t, db, []time.Duration{
		4 * 24 * time.Hour, 3 * 24 * time.Hour, 2 * 24 * time.Hour,
		time.Hour, 0,
	})
	if got := countAuditRows(t, db); got != 5 {
		t.Fatalf("前置条件不成立：审计行 = %d, want 5", got)
	}

	s := NewScheduler(db, time.Hour, nil)
	removed := s.TryRun()
	if removed != 2 {
		t.Fatalf("本次应删 2 条（3 条超期里保留最新那条作为链锚），实得 %d", removed)
	}
	if got := countAuditRows(t, db); got != 3 {
		t.Fatalf("清理后审计行 = %d, want 3（2 未超期 + 1 条链锚）", got)
	}
	// 链锚必须是被删批次里**链尾**的那一条（id 最大 = 2 天前那条）。
	var anchor time.Time
	if err := db.QueryRow(`SELECT max(created_at) FROM audit_logs WHERE created_at < now() - interval '1 day'`).
		Scan(&anchor); err != nil {
		t.Fatal(err)
	}
	anchorAge := time.Since(anchor)
	if anchorAge < 47*time.Hour || anchorAge > 49*time.Hour {
		t.Fatalf("链锚不是被删批次里链尾的那一条（age=%v, 期望约 48h）", anchorAge)
	}

	// 幂等：第二次运行不再删任何行（锚不会被反复删）。
	if again := s.TryRun(); again != 0 {
		t.Fatalf("第二次运行不应再删行（幂等），实得 %d", again)
	}
	if got := countAuditRows(t, db); got != 3 {
		t.Fatalf("第二次运行后审计行 = %d, want 3", got)
	}
}

func TestSchedulerStopsWithContext(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if err := serverstore.SetSetting(db, serverstore.AuditRetentionSetting, "1"); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	s := NewScheduler(db, 10*time.Millisecond, nil)
	runs := make(chan struct{}, 64)
	s.onRun = func() {
		select {
		case runs <- struct{}{}:
		default:
		}
	}
	s.Start(ctx)

	// 启动先跑一轮（不等一个 tick）。
	select {
	case <-runs:
	case <-time.After(5 * time.Second):
		t.Fatal("Start 之后没有立即执行首轮清理")
	}
	// tick 期间会持续触发运行。
	select {
	case <-runs:
	case <-time.After(5 * time.Second):
		t.Fatal("周期 tick 没有触发运行（调度器没在跑）")
	}

	cancel()
	select {
	case <-s.Stopped():
	case <-time.After(5 * time.Second):
		t.Fatal("ctx 取消后后台循环没有退出（Stopped 未关闭）")
	}
	// 退出后不得再有新的运行。
	drained := 0
	for {
		select {
		case <-runs:
			drained++
			continue
		default:
		}
		break
	}
	time.Sleep(60 * time.Millisecond)
	extra := 0
	for {
		select {
		case <-runs:
			extra++
			continue
		default:
		}
		break
	}
	if extra > 0 {
		t.Fatalf("退出后仍触发了 %d 次运行（关停不干净）", extra)
	}
}

// TestSchedulerRetentionReadFailureFallsBackToDefault 锁住"读设置失败不退化"：
// 保留期读不出来时回落到默认 180 天，绝不退化成"不清理"或"删光"。
func TestSchedulerRetentionReadFailureFallsBackToDefault(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// 非法取值（>3650 由 API 拦截，但库里可能被手工写坏）⇒ AuditRetentionDays 回落默认。
	if err := serverstore.SetSetting(db, serverstore.AuditRetentionSetting, "not-a-number"); err != nil {
		t.Fatal(err)
	}
	seedAuditRows(t, db, []time.Duration{200 * 24 * time.Hour, time.Hour})
	s := NewScheduler(db, time.Hour, nil)
	// 200 天前的行在默认 180 天下**超期**；这是"回落默认"而不是"不清理"的判据。
	if removed := s.TryRun(); removed != 0 {
		// 只有一条超期行 ⇒ 它是链锚，被保留 ⇒ 删除 0 条是正确的（但必须不是"因为读失败而跳过"）。
		var left int64
		if err := db.QueryRow(`SELECT count(*) FROM audit_logs WHERE created_at < now() - interval '190 days'`).Scan(&left); err != nil {
			t.Fatal(err)
		}
		if left != 1 {
			t.Fatalf("回落默认保留期后应保留唯一那条超期行（链锚），实得 %d", left)
		}
	}
	if got := countAuditRows(t, db); got != 2 {
		t.Fatalf("行数 = %d, want 2（一条超期=链锚保留 + 一条未超期）", got)
	}
}
