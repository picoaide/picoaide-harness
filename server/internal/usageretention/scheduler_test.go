package usageretention

// R5-A-11 的包级判据（审计 2026-09-23，P1）：usage 明细保留策略必须有一个
// **周期执行者**，而不是"只在启动那一刻 / 保存配置那一刻"生效。
//
// 三条判据：
//  1. 到期清理：不重启进程、不重新保存配置，超期月分区也必须被删掉；
//  2. 幂等：连续多轮不报错、不重复删（第二轮及以后是空转）；
//  3. 关闭退出：ctx 取消后后台循环退出（`Stopped()` 关闭），且**不再**跑新的一轮。

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// expiredMonthRelations 返回当前仍挂在 usage 下的、早于 cutoff 的叶子月分区名。
func expiredMonthRelations(t *testing.T, db *sql.DB, cutoff time.Time) []string {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_inherits i ON i.inhrelid = c.oid
		JOIN pg_class p ON p.oid = i.inhparent
		WHERE n.nspname = 'public' AND p.relname = 'usage' AND c.relispartition
		  AND c.relname ~ '^usage_[0-9]{6}$'
		ORDER BY c.relname`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	cutoffKey := cutoff.Format("200601")
	out := []string{}
	for rows.Next() {
		var rel string
		if err := rows.Scan(&rel); err != nil {
			t.Fatal(err)
		}
		if rel[len("usage_"):] < cutoffKey { // 关系名即 YYYYMM，字典序 = 时间序
			out = append(out, rel)
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// roundRecorder 记录轮次与错误（TryRun 跑在后台 goroutine 里，读写都要加锁）。
type roundRecorder struct {
	mu     sync.Mutex
	rounds int
	errs   []error
	ch     chan struct{}
}

func (r *roundRecorder) note(err error) {
	r.mu.Lock()
	r.rounds++
	if err != nil {
		r.errs = append(r.errs, err)
	}
	r.mu.Unlock()
	select {
	case r.ch <- struct{}{}:
	default:
	}
}

func (r *roundRecorder) snapshot() (int, []error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.rounds, append([]error(nil), r.errs...)
}

// waitRounds 等到记录到 n 轮（或超时失败）。
func waitRounds(t *testing.T, rec *roundRecorder, n int) {
	t.Helper()
	deadline := time.After(30 * time.Second)
	for {
		if got, _ := rec.snapshot(); got >= n {
			return
		}
		select {
		case <-rec.ch:
		case <-deadline:
			got, _ := rec.snapshot()
			t.Fatalf("等待 %d 轮超时（实际 %d 轮）", n, got)
		}
	}
}

// TestSchedulerDropsExpiredPartitionsIdempotentlyAndStops —— R5-A-11 的主判据。
func TestSchedulerDropsExpiredPartitionsIdempotentlyAndStops(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	// 保留 1 个月 ⇒ cutoff = 当前北京月 - 1；测试库预建窗口（2026-01 起）里
	// 早于它的月份必然存在（否则夹具失效，直接失败而不是静默跳过）。
	if err := serverstore.SetSetting(db, serverstore.RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	cutoff := serverstore.BeijingMonth(time.Now()).AddDate(0, -1, 0)
	before := expiredMonthRelations(t, db, cutoff)
	if len(before) == 0 {
		t.Fatalf("夹具无效：测试库里没有早于 cutoff %s 的月分区（预建窗口变了？）", cutoff.Format("200601"))
	}

	rec := &roundRecorder{ch: make(chan struct{}, 64)}
	// tick 取 20ms：判据不依赖具体间隔，只要求"周期执行者存在且按保留期清理"。
	s := NewScheduler(db, 20*time.Millisecond)
	s.onRun = rec.note

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)

	// ① 到期清理：至少两轮之后，早于 cutoff 的分区必须一个不剩。
	waitRounds(t, rec, 2)
	deadline := time.After(30 * time.Second)
	for len(expiredMonthRelations(t, db, cutoff)) > 0 {
		select {
		case <-rec.ch:
		case <-deadline:
			left := expiredMonthRelations(t, db, cutoff)
			t.Fatalf("周期调度器没有按保留期清理：仍有 %d 个超期分区（%v）", len(left), left)
		}
	}

	// ② 幂等：再跑若干轮不得报错（没有可删的分区时也必须是无害空转）。
	roundsBefore, _ := rec.snapshot()
	waitRounds(t, rec, roundsBefore+3)
	if _, errs := rec.snapshot(); len(errs) > 0 {
		t.Fatalf("周期清理报错（重复执行必须幂等）：%v", errs)
	}
	if left := expiredMonthRelations(t, db, cutoff); len(left) != 0 {
		t.Fatalf("幂等轮次后仍有超期分区：%v", left)
	}

	// ③ 关闭退出：ctx 取消后后台循环退出，且不再跑新的一轮。
	roundsAtStop, _ := rec.snapshot()
	cancel()
	select {
	case <-s.Stopped():
	case <-time.After(10 * time.Second):
		t.Fatal("ctx 取消后调度器没有退出（Stopped 未关闭）")
	}
	time.Sleep(100 * time.Millisecond) // ≥5 个 tick
	if after, _ := rec.snapshot(); after != roundsAtStop {
		t.Fatalf("调度器退出后仍跑了新的一轮：%d → %d", roundsAtStop, after)
	}
	t.Logf("周期执行者：清理 %d 个超期分区，%d 轮无错退出", len(before), roundsAtStop)
}

// TestSchedulerNilDBNeverPanics：nil db 必须静默跳过（与 auditretention 同口径：
// 测试路由树/无 DB 启动不 panic，也不启动 goroutine）。
func TestSchedulerNilDBNeverPanics(t *testing.T) {
	s := NewScheduler(nil, time.Millisecond)
	if err := s.TryRun(); err != nil {
		t.Fatalf("nil db 的 TryRun 应为无害空转，实际 %v", err)
	}
	s.Start(context.Background()) // 不 panic 即可（不启动循环、不关闭 Stopped）
	var nilScheduler *Scheduler
	if err := nilScheduler.TryRun(); err != nil {
		t.Fatalf("nil 调度器的 TryRun 应为无害空转，实际 %v", err)
	}
	nilScheduler.Start(context.Background())
}

// TestDefaultTickIsASaneInterval：间隔缺省值必须落在"远小于最小保留期(1 个月)"
// 的区间里 —— 间隔 >= 保留期会让"到期清理"在语义上失去意义。
func TestDefaultTickIsASaneInterval(t *testing.T) {
	if DefaultTick <= 0 || DefaultTick > 24*time.Hour {
		t.Fatalf("DefaultTick = %v，应在 (0, 24h] 内", DefaultTick)
	}
	if NewScheduler(nil, 0).tick != DefaultTick {
		t.Fatalf("tick<=0 必须回落 DefaultTick(%v)，实际 %v", DefaultTick, NewScheduler(nil, 0).tick)
	}
}
