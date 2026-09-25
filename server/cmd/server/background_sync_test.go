package main

// 装配级判据（R19B-05，审计 2026-09-25，P2）：渠道模型同步循环与 LDAP 目录同步循环
// 必须真的在**启动路径**上被构造并启动、必须拿启动期 ctx、且运行状态必须可读。
//
// 背景：这两行此前是 main() 里的裸 goroutine（`go llmgateway.SyncLoop(db, time.Hour, nil)`
// / `go serverauth.SyncDirectoryLoop(db, serverauth.LDAPSyncInterval, nil)`）——进程内
// **唯一**两条没有 ctx、没有运行状态、也没进 scheduler_status.go 的周期执行者。
// 审计实测：删掉任一行 `go …Loop(` 后 `go test ./cmd/server/` **整包仍绿**；而其中
// 模型同步循环还是 `serverstore.CleanupPendingUsage` 的**唯一周期执行者**。
//
// 判据四组，缺一不可（与 schedulers_test.go 同款）：
//   - 执行级：接缝被调用、构造参数是（同一个 db, 间隔常量）、Start 拿到启动期 ctx、
//     调度器登记进了状态表；
//   - 观测级：真实调度器 + 必然失败的一轮 ⇒ 状态表里 started/runs/last_run_at/
//     last_error 真的被填上（恒空结构体会红）；
//   - 源码级：main() 里两行装配调用存在、排在 signal ctx 之后、位于 main() 内、
//     且在 `logSchedulerStatuses("startup")` **之前**；不得再有裸 goroutine 形态；
//   - 结构级：旧的无 ctx 循环入口（llmgateway.SyncLoop / serverauth.SyncDirectoryLoop）
//     必须彻底消失 —— 否则存在第二条绕过可观测面的装配路径。

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverauth"
)

// mainGoCodeOnly 读取 main.go 并**剥掉注释**后返回源码文本。
//
// 为什么不能直接对原文做子串判据：注释里出现 `go llmgateway.SyncLoop(`（解释"修前是
// 什么样"）会让"不得再有裸循环"的判据假红；反过来，把装配调用**注释掉**也会让
// "必须存在这一行"的判据假绿。判据只看代码，不看散文。
func mainGoCodeOnly(t *testing.T) string {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	// 不传 parser.ParseComments ⇒ AST 里没有注释节点，打印出来就是纯代码。
	f, err := parser.ParseFile(fset, "main.go", src, 0)
	if err != nil {
		t.Fatalf("parse main.go: %v", err)
	}
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, f); err != nil {
		t.Fatalf("print main.go: %v", err)
	}
	return buf.String()
}

// failingDirRunner 是必然失败的目录同步器（生产 runner 在 LDAP 未启用时是 no-op，
// 观测不到错误读数；错误证据必须能出来才算"不是恒空结构体"）。
type failingDirRunner struct{}

func (failingDirRunner) Run(*sql.DB) (*serverauth.DirSyncResult, error) {
	return nil, errors.New("dirsync probe: boom")
}

func TestModelSyncSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *stubObservableScheduler, 1)
	prev := newModelSyncScheduler
	t.Cleanup(func() { newModelSyncScheduler = prev })
	newModelSyncScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
		s := &stubObservableScheduler{db: db, tick: tick, start: make(chan struct{})}
		got <- s
		return s
	}

	db := placeholderDB(t)
	type ctxKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "startup"))
	defer cancel()

	startModelSyncScheduler(parent, db, modelSyncTick)

	var s *stubObservableScheduler
	select {
	case s = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造模型同步调度器（装配接缝未被调用）—— 渠道模型不再同步、" +
			"且 CleanupPendingUsage 失去唯一周期执行者")
	}
	select {
	case <-s.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了模型同步调度器但没有调用 Start（循环不会运行）")
	}
	if s.db != db {
		t.Fatal("模型同步调度器拿到的不是启动期的 db")
	}
	if s.tick != modelSyncTick {
		t.Fatalf("tick = %v, want %v（装配必须传间隔常量）", s.tick, modelSyncTick)
	}
	if s.ctx != parent || s.ctx.Value(ctxKey{}) != "startup" {
		t.Fatal("模型同步调度器拿到的不是启动期 ctx（关停信号到不了它）")
	}
	var found bool
	for _, st := range schedulerStatuses() {
		if st.Name == schedulerModelSync {
			found = true
			if st.Tick != modelSyncTick {
				t.Fatalf("状态表 tick = %v, want %v", st.Tick, modelSyncTick)
			}
		}
	}
	if !found {
		t.Fatal("模型同步调度器没有登记进运行状态表（scheduler_status.go）—— 死了没人知道")
	}
}

func TestDirectorySyncSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *stubObservableScheduler, 1)
	prev := newDirectorySyncScheduler
	t.Cleanup(func() { newDirectorySyncScheduler = prev })
	newDirectorySyncScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
		s := &stubObservableScheduler{db: db, tick: tick, start: make(chan struct{})}
		got <- s
		return s
	}

	db := placeholderDB(t)
	type ctxKey struct{}
	parent, cancel := context.WithCancel(context.WithValue(context.Background(), ctxKey{}, "startup"))
	defer cancel()

	startDirectorySyncScheduler(parent, db, directorySyncTick)

	var s *stubObservableScheduler
	select {
	case s = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造目录同步调度器（装配接缝未被调用）—— 离职账号不自动停用")
	}
	select {
	case <-s.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了目录同步调度器但没有调用 Start（循环不会运行）")
	}
	if s.db != db {
		t.Fatalf("目录同步调度器拿到的不是启动期的 db")
	}
	if s.tick != directorySyncTick {
		t.Fatalf("tick = %v, want %v（装配必须传间隔常量）", s.tick, directorySyncTick)
	}
	if s.ctx != parent || s.ctx.Value(ctxKey{}) != "startup" {
		t.Fatal("目录同步调度器拿到的不是启动期 ctx（关停信号到不了它）")
	}
	var found bool
	for _, st := range schedulerStatuses() {
		if st.Name == schedulerDirectorySync {
			found = true
		}
	}
	if !found {
		t.Fatal("目录同步调度器没有登记进运行状态表（scheduler_status.go）—— 死了没人知道")
	}
}

// TestBackgroundLoopStatusExposesRealRunEvidence：真实调度器 + 必然失败的一轮
// ⇒ 四个读数必须真的被填上（started/startedAt/runs/lastRunAt/errors/lastError）。
func TestBackgroundLoopStatusExposesRealRunEvidence(t *testing.T) {
	resetSchedulerStatus(t)
	db := placeholderDB(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 模型同步：不可达 DSN ⇒ 回收与同步都失败。
	startObservedSchedulerWith(ctx, schedulerModelSync, 20*time.Millisecond,
		llmgateway.NewModelSyncScheduler(db, 20*time.Millisecond, nil))
	// 目录同步：注入必然失败的 runner（生产 runner 在 LDAP 未启用时是 no-op）。
	startObservedSchedulerWith(ctx, schedulerDirectorySync, 20*time.Millisecond,
		serverauth.NewDirectorySyncScheduler(db, 20*time.Millisecond, failingDirRunner{}))

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
		t.Fatalf("状态表条目数 = %d, want 2（model_sync + directory_sync）", len(statuses))
	}
	for _, st := range statuses {
		if !st.Started {
			t.Fatalf("%s: started=false —— 装配没有真的把它启动（R19B-05 的原缺陷形态）", st.Name)
		}
		if st.StartedAt.IsZero() {
			t.Fatalf("%s: started_at 为空 —— 启动时刻没记账", st.Name)
		}
		if st.Runs < 1 {
			t.Fatalf("%s: runs=%d —— 后台循环一轮都没跑", st.Name, st.Runs)
		}
		if st.LastRunAt.IsZero() {
			t.Fatalf("%s: last_run_at 为空 —— 状态表是恒空结构体，不是真读数", st.Name)
		}
		if st.Errors < 1 {
			t.Fatalf("%s: errors=%d —— 失败轮次没有被记账", st.Name, st.Errors)
		}
		if strings.TrimSpace(st.LastError) == "" {
			t.Fatalf("%s: last_error 为空 —— 失败原因没有出口（运维看不到循环为什么没干活）", st.Name)
		}
	}
}

// TestStartupCallsModelAndDirectorySyncSchedulers 是源码级判据：整行删掉/挪进不执行
// 的分支时，执行级用例可能仍然绿（构造点还在），这一条兜住。
func TestStartupCallsModelAndDirectorySyncSchedulers(t *testing.T) {
	text := mainGoCodeOnly(t)
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
	// 状态行必须在两条循环装配**之后** —— 否则启动日志漏掉它们（观测面正好丢掉要观测的东西）。
	statusAt := strings.Index(text, `logSchedulerStatuses("startup")`)
	if statusAt < 0 {
		t.Fatal("main.go 里找不到 logSchedulerStatuses(\"startup\")")
	}

	for _, tc := range []struct {
		call string
		why  string
	}{
		{"startModelSyncScheduler(ctx, db, modelSyncTick)",
			"渠道模型同步 + pending usage 回收（CleanupPendingUsage 的唯一周期执行者）在稳态下没有执行者"},
		{"startDirectorySyncScheduler(ctx, db, directorySyncTick)",
			"LDAP 目录同步在稳态下没有执行者（离职账号不自动停用、入职不开通）"},
	} {
		idx := strings.Index(text, tc.call)
		if idx < 0 {
			t.Fatalf("main() 未调用 %s —— %s", tc.call, tc.why)
		}
		if idx < ctxIdx {
			t.Fatalf("%s 排在 signal ctx 之前（拿不到关停信号）", tc.call)
		}
		if idx < mainAt || idx > mainAt+nextFuncAt {
			t.Fatalf("%s 不在 main() 函数体内 —— 进程启动路径不会执行到它", tc.call)
		}
		if idx > statusAt {
			t.Fatalf("%s 排在 logSchedulerStatuses(\"startup\") 之后 —— 启动状态行会漏掉它", tc.call)
		}
	}

	// 不得再有"裸 goroutine + 无 ctx 循环"的装配形态。
	for _, banned := range []string{
		"go llmgateway.SyncLoop(",
		"go serverauth.SyncDirectoryLoop(",
		"llmgateway.SyncLoop(",
		"serverauth.SyncDirectoryLoop(",
	} {
		if strings.Contains(text, banned) {
			t.Fatalf("main.go 里仍有裸循环调用 %s（应只走 background_sync.go 的装配接缝）", banned)
		}
	}
	seam, err := os.ReadFile("background_sync.go")
	if err != nil {
		t.Fatalf("read background_sync.go: %v", err)
	}
	for _, want := range []string{
		"return llmgateway.NewModelSyncScheduler(db, tick, nil)",
		"return serverauth.NewDirectorySyncScheduler(db, tick, nil)",
		"startObservedSchedulerWith(ctx, schedulerModelSync, tick, newModelSyncScheduler(db, tick))",
		"startObservedSchedulerWith(ctx, schedulerDirectorySync, tick, newDirectorySyncScheduler(db, tick))",
	} {
		if !strings.Contains(string(seam), want) {
			t.Fatalf("装配接缝 background_sync.go 里找不到 %q（接缝被掏空）", want)
		}
	}
	// 登记必须由共用装配体完成（"先登记后启动"）。
	schedSrc, err := os.ReadFile("schedulers.go")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(schedSrc), "registerSchedulerStatus(name, tick, sched)") {
		t.Fatal("schedulers.go 的 startObservedSchedulerWith 没有登记运行状态（可观测面丢一半）")
	}
}

// TestContextlessLoopsAreGone：旧的无 ctx 循环入口必须彻底删除。留着它就等于留着
// 第二条装配路径 —— 既看不到运行状态，也停不下来（关停时永远挂在 time.Sleep 上）。
func TestContextlessLoopsAreGone(t *testing.T) {
	for _, tc := range []struct{ path, banned string }{
		{"../../internal/llmgateway/sync.go", "func SyncLoop("},
		{"../../internal/serverauth/dirsync.go", "func SyncDirectoryLoop("},
	} {
		body, err := os.ReadFile(tc.path)
		if err != nil {
			t.Fatalf("read %s: %v", tc.path, err)
		}
		if strings.Contains(string(body), tc.banned) {
			t.Fatalf("%s 仍存在 %q —— 无 ctx/无停止/无状态记账的循环入口必须消失"+
				"（改用可观测调度器）", tc.path, tc.banned)
		}
	}
}
