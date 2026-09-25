package auditchain

// R16C-03（审计 2026-09-25，P2）的执行者判据。
//
// 缺陷形态：`VerifyAuditChain` 在生产代码里只有**启动路径**一个调用者，
// `/server-info` 的 `audit.chain_intact` 只是读那份缓存 ⇒ 篡改审计行后**不重启**
// 时仍是 `chain_intact: true`、`chain_checked_at` 停在启动时刻、日志零告警
// （容器化部署几个月不重启是常态）。
//
// 本文件钉三件事：
//  1. 周期执行者真的会**再跑**（`Runs()` 增长、结果缓存被刷新、执行者标识变 periodic）；
//  2. 篡改后**不重启**就能被发现：日志出现 `audit chain BROKEN`、结论变
//     `chain_intact:false` + `chain_broken_id != 0`；
//  3. 与 auditretention 的**有意差异**：第一轮在**一个 tick 之后**才跑（启动路径刚做过
//     同一次全表校验），以及"结论保质期 = 2 × 本间隔"这条与 serverstore 的常量契约。

import (
	"bytes"
	"context"
	"database/sql"
	"log"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// waitFor 轮询直到条件成立（避免用固定 sleep 写 flaky 用例）。
func waitFor(t *testing.T, what string, cond func() bool, budget time.Duration) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("等待超时（%s）: %s", budget, what)
}

// TestDefaultTickMatchesStaleAfter 钉两个常量的一致性：
// 结论保质期（serverstore.AuditChainStaleAfter）必须 = 2 × 本包的间隔。
// 两者不能互相 import（会成环），所以用断言而不是引用 —— 改任一侧忘改另一侧即红。
func TestDefaultTickMatchesStaleAfter(t *testing.T) {
	if 2*DefaultTick != serverstore.AuditChainStaleAfter {
		t.Fatalf("2*DefaultTick = %v, want serverstore.AuditChainStaleAfter = %v",
			2*DefaultTick, serverstore.AuditChainStaleAfter)
	}
}

// TestSchedulerFirstRunWaitsForTick 钉"第一轮在一个 tick 之后"（与 auditretention
// 的有意差异：启动路径已经校验过一次，立刻再扫一遍是纯重复开销）。
func TestSchedulerFirstRunWaitsForTick(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	s := NewScheduler(db, 5*time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)
	defer func() {
		cancel()
		select {
		case <-s.Stopped():
		case <-time.After(3 * time.Second):
			t.Error("调度器没有随 ctx 退出")
		}
	}()

	time.Sleep(150 * time.Millisecond)
	if n := s.Runs(); n != 0 {
		t.Fatalf("启动后立刻跑了 %d 轮 —— 启动路径已经校验过，不该重复付第一遍全表扫描", n)
	}
	if !s.Started() {
		t.Fatal("Started() = false（状态表读不到\"已启动\"）")
	}
	if s.Tick() != 5*time.Second {
		t.Fatalf("Tick() = %v, want 5s", s.Tick())
	}
}

// TestSchedulerDetectsTamperWithoutRestart 是 R16C-03 的核心判据。
func TestSchedulerDetectsTamperWithoutRestart(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	for i := 0; i < 3; i++ {
		if err := serverstore.AuditLog(db, "admin", "act_seed", "d"); err != nil {
			t.Fatal(err)
		}
	}
	// 先记一次"干净"的结论（模拟启动校验）：此时链是好的。
	if broken, err := serverstore.RunAndRecordAuditChainCheck(db); err != nil || broken != 0 {
		t.Fatalf("前置干净链校验: broken=%d err=%v", broken, err)
	}
	if d := serverstore.AuditChainStatusDetail(); !d.Intact {
		t.Fatalf("前置条件不成立: %+v", d)
	}

	// 篡改 2 行（与审计探针同一手法）。
	res, err := db.Exec(`UPDATE audit_logs SET detail = 'TAMPERED-BY-PROBE' WHERE action = 'act_seed'`)
	if err != nil {
		t.Fatal(err)
	}
	if n, _ := res.RowsAffected(); n != 3 {
		t.Fatalf("篡改行数 = %d, want 3", n)
	}

	// 捕获调度器的日志（周期结论必须留痕）。
	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) }()

	s := NewScheduler(db, 30*time.Millisecond)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)
	defer func() {
		cancel()
		select {
		case <-s.Stopped():
		case <-time.After(3 * time.Second):
			t.Error("调度器没有随 ctx 退出")
		}
	}()

	// 不重启：一个 tick 之内必须（a）跑过一轮、（b）结论变成"断链"。
	waitFor(t, "周期执行者跑过一轮", func() bool { return s.Runs() > 0 }, 5*time.Second)
	waitFor(t, "结论变成断链", func() bool {
		d := serverstore.AuditChainStatusDetail()
		return !d.Intact && d.BrokenID != 0
	}, 5*time.Second)

	d := serverstore.AuditChainStatusDetail()
	if d.Source != "periodic" {
		t.Fatalf("执行者标识 = %q, want periodic（结论必须知道是谁刷新的）", d.Source)
	}
	if d.Stale {
		t.Fatalf("刚刚校验过的结论不该 stale: %+v", d)
	}
	if d.Checks < 2 {
		t.Fatalf("校验次数 = %d, want >= 2（启动 1 次 + 周期至少 1 次）", d.Checks)
	}
	if !strings.Contains(buf.String(), "audit chain BROKEN") {
		t.Fatalf("周期校验发现断链却没有 `audit chain BROKEN` 日志:\n%s", buf.String())
	}
	if d.Rows == 0 {
		t.Fatal("Rows = 0：扫描规模必须如实上报（全表扫描的开销要可见）")
	}
	if s.LastBrokenID() == 0 {
		t.Fatal("LastBrokenID() = 0：调度器自己的读数没有反映断链")
	}
	// "断链"不算执行错误（它是校验成功得出的结论）。
	if s.Errors() != 0 {
		t.Fatalf("Errors = %d, want 0（断链是结论，不是执行失败）", s.Errors())
	}
}

// TestSchedulerRecordsVerifyFailureSeparately 钉"读不出来 ≠ 链是好的"：
// 校验本身失败时必须走另一条日志、计入 Errors，且结论 Intact=false。
func TestSchedulerRecordsVerifyFailureSeparately(t *testing.T) {
	// 监听一个连不上的地址：校验必然失败。
	db, err := sqlOpenUnreachable()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	var buf bytes.Buffer
	prevOut, prevFlags := log.Writer(), log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	defer func() { log.SetOutput(prevOut); log.SetFlags(prevFlags) }()

	s := NewScheduler(db, 20*time.Millisecond)
	waitFor(t, "出现一次校验失败", func() bool { s.TryRun(); return s.Errors() > 0 }, 5*time.Second)
	if !strings.Contains(buf.String(), "audit chain verify failed") {
		t.Fatalf("读不出来必须有自己的日志（不能与断链混为一谈）:\n%s", buf.String())
	}
	if strings.Contains(buf.String(), "audit chain BROKEN") {
		t.Fatalf("校验失败被误报成断链:\n%s", buf.String())
	}
	if d := serverstore.AuditChainStatusDetail(); d.Intact {
		t.Fatalf("校验失败时 Intact 必须为 false: %+v", d)
	}
	if s.LastError() == "" {
		t.Fatal("LastError() 为空：执行失败必须在状态表里可读")
	}
}

// sqlOpenUnreachable 返回一个连不上的 *sql.DB（校验必然失败；不依赖任何外部服务）。
func sqlOpenUnreachable() (*sql.DB, error) {
	return sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
}
