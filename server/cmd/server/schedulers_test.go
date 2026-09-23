package main

// 装配级判据（R6-A-2，审计 2026-09-23，P1）：`reports` 与 `balance` 两个调度器
// 必须真的在**启动路径**上被构造并启动，且它们的运行状态必须是**可读的出口**
// （不是"死掉零可观测"）。
//
// 背景：这两行此前在 main() 里是裸调用（`reports.NewScheduler(db, time.Hour,
// nil).Start(ctx)` / `balance.NewScheduler(…).Start(ctx)`）。审计实测：把
// `.Start(ctx)` 摘掉后 `go test ./cmd/server/` **整包仍绿**（ok 100s），而
// balance 调度器是**唯一的自动发放路径**、reports 是月报唯一的触发者。
//
// 判据分四组，缺一不可：
//   - 执行级（TestReportsSchedulerWiring / TestBalanceSchedulerWiring）：把构造点
//     换成桩，断言启动路径用它构造了调度器并**调用了 Start**，参数是（启动期 ctx,
//     同一个 db, 装配间隔常量），且构造出的调度器被登记进可观测状态表；
//   - 观测级（TestSchedulerStatusExposesRealRunEvidence）：用**真实**调度器 +
//     不可达的 DSN 跑一轮，断言状态表里的 started/runs/last_run_at/last_error
//     真的被填上（不是恒空的结构体）；
//   - 日志级（TestSchedulerStatusLogLineIsGrepAble）：`logSchedulerStatuses` 的
//     一行必须字段齐全（name=/started=/runs=/last_run_at=/last_error=）；
//   - 源码级（TestStartupCallsReportsAndBalanceSchedulers）：断言 main() 里存在
//     两行装配调用、排在 signal ctx 之后、位于 main() 函数体内，且没有绕过接缝
//     的裸调用（整行删掉/挪进不执行的分支由这一条兜住）。

import (
	"bytes"
	"context"
	"database/sql"
	"log"
	"os"
	"strings"
	"testing"
	"time"
)

// stubObservableScheduler 是 observableScheduler 的测试桩：Start 时按真实调度器
// 的语义记账（started + 一轮 runs/lastRunAt/lastError），从而能断言"状态表真的
// 读到了调度器的账"，而不是断言一个恒空的结构体。
type stubObservableScheduler struct {
	db   *sql.DB
	tick time.Duration
	now  func() time.Time

	ctx   context.Context
	start chan struct{}

	runErr string
	runs   int64
}

func (s *stubObservableScheduler) Start(ctx context.Context) {
	s.ctx = ctx
	s.runs++
	close(s.start)
}

func (s *stubObservableScheduler) Started() bool        { return true }
func (s *stubObservableScheduler) StartedAt() time.Time { return time.Now() }
func (s *stubObservableScheduler) Runs() int64          { return s.runs }
func (s *stubObservableScheduler) Errors() int64        { return 0 }
func (s *stubObservableScheduler) LastRunAt() time.Time { return time.Now() }
func (s *stubObservableScheduler) LastError() string    { return s.runErr }
func (s *stubObservableScheduler) Tick() time.Duration  { return s.tick }

// resetSchedulerStatus 隔离进程内状态表（包级注册表；用例之间不能互相看见）。
func resetSchedulerStatus(t *testing.T) {
	t.Helper()
	schedulerStatusMu.Lock()
	prev := schedulerStatusEntries
	schedulerStatusEntries = nil
	schedulerStatusMu.Unlock()
	t.Cleanup(func() {
		schedulerStatusMu.Lock()
		schedulerStatusEntries = prev
		schedulerStatusMu.Unlock()
	})
}

// placeholderDB 返回一个非 nil、但连不上的 *sql.DB（判据只看装配参数，不碰真库）。
func placeholderDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestReportsSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *stubObservableScheduler, 1)
	prev := newReportsScheduler
	t.Cleanup(func() { newReportsScheduler = prev })
	newReportsScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) observableScheduler {
		s := &stubObservableScheduler{db: db, tick: tick, now: nowFn, start: make(chan struct{})}
		got <- s
		return s
	}

	db := placeholderDB(t)
	type ctxKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "startup"))
	defer cancel()

	startReportsScheduler(parent, db, reportsSchedulerTick)

	var s *stubObservableScheduler
	select {
	case s = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造 reports 调度器（装配接缝未被调用）—— 月报订阅永不触发")
	}
	select {
	case <-s.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了 reports 调度器但没有调用 Start（调度器不会运行）")
	}
	if s.db != db {
		t.Fatal("reports 调度器拿到的不是启动期的 db")
	}
	if s.tick != reportsSchedulerTick {
		t.Fatalf("tick = %v, want %v（装配必须传间隔常量）", s.tick, reportsSchedulerTick)
	}
	if s.now != nil {
		t.Fatal("装配不该注入 nowFn（生产用调度器自己的 time.Now）")
	}
	if s.ctx != parent || s.ctx.Value(ctxKey{}) != "startup" {
		t.Fatal("reports 调度器拿到的不是启动期 ctx（关停信号到不了它）")
	}
	assertRegistered(t, schedulerReports, reportsSchedulerTick)

	// nil db 必须静默跳过（与其它装配接缝同口径：无 DB 启动不 panic）。
	startReportsScheduler(context.Background(), nil, reportsSchedulerTick)
}

func TestBalanceSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *stubObservableScheduler, 1)
	prev := newBalanceScheduler
	t.Cleanup(func() { newBalanceScheduler = prev })
	newBalanceScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) observableScheduler {
		s := &stubObservableScheduler{db: db, tick: tick, now: nowFn, start: make(chan struct{})}
		got <- s
		return s
	}

	db := placeholderDB(t)
	type ctxKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "startup"))
	defer cancel()

	startBalanceScheduler(parent, db, balanceSchedulerTick)

	var s *stubObservableScheduler
	select {
	case s = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造 balance 调度器（装配接缝未被调用）—— 月度发放（唯一自动发放路径）永不执行")
	}
	select {
	case <-s.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了 balance 调度器但没有调用 Start（余额只减不增 ⇒ 全员 429 BALANCE_EXHAUSTED）")
	}
	if s.db != db {
		t.Fatal("balance 调度器拿到的不是启动期的 db")
	}
	if s.tick != balanceSchedulerTick {
		t.Fatalf("tick = %v, want %v（装配必须传间隔常量）", s.tick, balanceSchedulerTick)
	}
	if s.ctx != parent || s.ctx.Value(ctxKey{}) != "startup" {
		t.Fatal("balance 调度器拿到的不是启动期 ctx（关停信号到不了它）")
	}
	assertRegistered(t, schedulerBalance, balanceSchedulerTick)

	startBalanceScheduler(context.Background(), nil, balanceSchedulerTick)
}

// assertRegistered 断言装配把调度器登记进了可观测状态表（否则"可观测出口"是空壳）。
func assertRegistered(t *testing.T, name string, tick time.Duration) {
	t.Helper()
	for _, st := range schedulerStatuses() {
		if st.Name == name {
			if st.Tick != tick {
				t.Fatalf("状态表里 %s 的 tick = %v, want %v", name, st.Tick, tick)
			}
			return
		}
	}
	t.Fatalf("状态表里没有 %s —— 调度器运行状态不可读（可观测出口断链）", name)
}

// TestSchedulerStatusExposesRealRunEvidence 是"可观测出口不是恒空"的执行级判据：
// 用**真实**调度器（真实接缝 → reports/balance 包）跑一轮，断言四个读数真的被填上。
//
// 用不可达的 DSN：轮次会以错误结束（正是我们要观测的形态），无需真 PG，且
// "上一轮错误"这条读数在成功路径下本来就是空串 —— 这里刻意用一个必然失败的
// 轮次来证明**错误证据真的能出来**（恒空的结构体会在这里红）。
func TestSchedulerStatusExposesRealRunEvidence(t *testing.T) {
	resetSchedulerStatus(t)
	db := placeholderDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	startReportsScheduler(ctx, db, 20*time.Millisecond)
	startBalanceScheduler(ctx, db, 20*time.Millisecond)

	deadline := time.Now().Add(30 * time.Second)
	var statuses []schedulerStatus
	for time.Now().Before(deadline) {
		statuses = schedulerStatuses()
		if len(statuses) == 2 && allRoundsRan(statuses) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if len(statuses) != 2 {
		t.Fatalf("状态表条目数 = %d, want 2（reports + balance）", len(statuses))
	}
	for _, st := range statuses {
		if !st.Started {
			t.Fatalf("%s: started=false —— 装配没有真的把它启动（R6-A-2 的原缺陷形态）", st.Name)
		}
		if st.StartedAt.IsZero() {
			t.Fatalf("%s: started_at 为空 —— 启动时刻没记账", st.Name)
		}
		if st.Runs < 1 {
			t.Fatalf("%s: runs=%d —— 后台循环一轮都没跑（调度器没活）", st.Name, st.Runs)
		}
		if st.LastRunAt.IsZero() {
			t.Fatalf("%s: last_run_at 为空 —— 状态表是恒空结构体，不是真读数", st.Name)
		}
		if st.Errors < 1 {
			t.Fatalf("%s: errors=%d —— 不可达 DSN 下的失败轮次没有被记账", st.Name, st.Errors)
		}
		if strings.TrimSpace(st.LastError) == "" {
			t.Fatalf("%s: last_error 为空 —— 失败原因没有出口（运维看不到为什么没发放/没推送）", st.Name)
		}
	}
}

func allRoundsRan(statuses []schedulerStatus) bool {
	for _, st := range statuses {
		if st.Runs < 1 || st.Errors < 1 || strings.TrimSpace(st.LastError) == "" {
			return false
		}
	}
	return true
}

// TestSchedulerStatusLogLineIsGrepAble 断言启动/关停日志那一行字段齐全可 grep。
func TestSchedulerStatusLogLineIsGrepAble(t *testing.T) {
	resetSchedulerStatus(t)
	registerSchedulerStatus(schedulerBalance, balanceSchedulerTick, &stubObservableScheduler{
		tick: balanceSchedulerTick, runErr: "balance: settings lookup: boom", runs: 3,
	})

	prev := log.Writer()
	buf := &bytes.Buffer{}
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	logSchedulerStatuses("startup")

	out := buf.String()
	if !strings.Contains(out, "scheduler status (startup):") {
		t.Fatalf("没有状态行（可观测出口没有出口）:\n%s", out)
	}
	for _, want := range []string{"name=balance", "started=true", "tick=", "runs=3", "errors=", "last_run_at=", `last_error="balance: settings lookup: boom"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("状态行缺字段 %q（四个读数必须可 grep）:\n%s", want, out)
		}
	}
}

// TestStartupCallsReportsAndBalanceSchedulers 是源码级判据：整行删掉/挪进不执行
// 的分支时，执行级用例可能仍然绿（构造点还在），这一条兜住。
func TestStartupCallsReportsAndBalanceSchedulers(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	ctxIdx := strings.Index(text, "ctx, stop := signal.NotifyContext(")
	if ctxIdx < 0 {
		t.Fatal("main() 里找不到 signal ctx 的定义（判据锚点漂移）")
	}
	mainAt := strings.Index(text, "func main() {")
	if mainAt < 0 {
		t.Fatal("main.go 里找不到 func main()")
	}
	nextFuncAt := strings.Index(text[mainAt+1:], "\nfunc ")
	if nextFuncAt < 0 {
		nextFuncAt = len(text) - mainAt - 1
	}

	for _, tc := range []struct {
		call string
		why  string
	}{
		{"startReportsScheduler(ctx, db, reportsSchedulerTick)",
			"月报订阅在稳态下没有任何执行者（永不触发）"},
		{"startBalanceScheduler(ctx, db, balanceSchedulerTick)",
			"月度余额发放（唯一自动发放路径）在稳态下没有执行者 —— 余额只减不增，全员 429 BALANCE_EXHAUSTED"},
	} {
		idx := strings.Index(text, tc.call)
		if idx < 0 {
			t.Fatalf("main() 未调用 %s —— %s", tc.call, tc.why)
		}
		if idx < ctxIdx {
			t.Fatalf("%s 排在 signal ctx 之前（拿不到关停信号/编译不过）", tc.call)
		}
		if idx < mainAt || idx > mainAt+nextFuncAt {
			t.Fatalf("%s 不在 main() 函数体内 —— 进程启动路径不会执行到它", tc.call)
		}
	}

	// 不得绕过接缝自行构造（否则接缝的断言管不住第二条路径）。
	for _, banned := range []string{"reports.NewScheduler(", "balance.NewScheduler("} {
		if strings.Contains(text, banned) {
			t.Fatalf("main.go 里仍有直连 %s 的调用（应只走 schedulers.go 的装配接缝）", banned)
		}
	}
	seam, err := os.ReadFile("schedulers.go")
	if err != nil {
		t.Fatalf("read schedulers.go: %v", err)
	}
	for _, want := range []string{
		"return reports.NewScheduler(db, tick, nowFn)",
		"return balance.NewScheduler(db, tick, nowFn)",
		"registerSchedulerStatus(name, tick, s)",
	} {
		if !strings.Contains(string(seam), want) {
			t.Fatalf("装配接缝 schedulers.go 里找不到 %q（接缝被掏空）", want)
		}
	}

	// 可观测出口必须真的挂在启动路径上（启动行 + 关停行）。
	for _, want := range []string{`logSchedulerStatuses("startup")`, `logSchedulerStatuses("shutdown")`} {
		if !strings.Contains(text, want) {
			t.Fatalf("main.go 里找不到 %s —— 调度器运行状态没有出口（R6-A-2 的可观测要求）", want)
		}
	}
}
