package main

// 装配级判据（R5-A-11）：usage 明细保留策略调度器必须真的在**启动路径**上被构造
// 并启动。
//
// 背景：`CleanupUsageRetention` 此前只有"启动时"与"保存保留期时"两个调用点 ⇒
// 稳态运行的实例只在启动那一刻清理（`usage.retention_months` 形同虚设，明细随
// 经过的月份单调增长）。修法是挂周期调度器，但"挂上去"必须可被判据观察 —— 只加
// 一行 `Start(ctx)` 时，删掉那一行所有门禁依旧全绿。
//
// 两条判据互补（与 audit_retention_test.go / gateway_reaper_test.go 同款）：
//   - 执行级（TestUsageRetentionSchedulerWiring）：把构造点换成桩，断言启动路径
//     用它构造了调度器并**调用了 Start**，参数是（启动期 ctx, 同一个 db, 间隔常量）；
//   - 源码级（TestStartupCallsUsageRetentionScheduler）：断言 main() 里存在
//     `startUsageRetentionScheduler(ctx, db, usageretention.DefaultTick)`，且在
//     signal ctx 之后、位于 main() 函数体内 —— 整行删掉/挪进不执行的分支由这一条
//     兜住。

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/usageretention"
)

// usageRetentionFakeScheduler 记录 Start 是否被调用、拿到哪个 ctx。
//
// 刻意**不复用** audit_retention_test.go 的 fakeScheduler：那个桩把 ctx 的哨兵值记在
// `auditRetentionCtxKey` 下，共用会让本用例的断言绑死在别人的键上（本次实测踩到：
// 用共享桩时 `f.key` 恒为 nil，看起来像"装配没传 ctx"）。这里直接记 ctx 本身并按
// **同一性**比较，比哨兵值更强。
type usageRetentionFakeScheduler struct {
	db    *sql.DB
	tick  time.Duration
	ctx   context.Context
	start chan struct{}
}

func (f *usageRetentionFakeScheduler) Start(ctx context.Context) {
	f.ctx = ctx
	close(f.start)
}

func TestUsageRetentionSchedulerWiring(t *testing.T) {
	got := make(chan *usageRetentionFakeScheduler, 1)
	prev := newUsageRetentionScheduler
	t.Cleanup(func() { newUsageRetentionScheduler = prev })
	newUsageRetentionScheduler = func(db *sql.DB, tick time.Duration) schedulerStarter {
		f := &usageRetentionFakeScheduler{db: db, tick: tick, start: make(chan struct{})}
		got <- f
		return f
	}

	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	defer db.Close()

	parent, cancel := context.WithCancel(context.WithValue(context.Background(), usageRetentionCtxKey{}, "startup"))
	defer cancel()
	startUsageRetentionScheduler(parent, db, usageretention.DefaultTick)

	var f *usageRetentionFakeScheduler
	select {
	case f = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造 usage 保留调度器（装配接缝未被调用）")
	}
	select {
	case <-f.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了调度器但没有调用 Start（调度器不会运行）")
	}
	if f.db != db {
		t.Fatal("调度器拿到的不是启动期的 db")
	}
	if f.tick != usageretention.DefaultTick {
		t.Fatalf("tick = %v, want %v（装配必须传默认间隔常量）", f.tick, usageretention.DefaultTick)
	}
	if f.ctx != parent {
		t.Fatalf("调度器拿到的不是启动期 ctx（同一性不成立）—— 关停信号到不了调度器")
	}
	if f.ctx.Value(usageRetentionCtxKey{}) != "startup" {
		t.Fatalf("ctx 被换掉了（哨兵 = %v）", f.ctx.Value(usageRetentionCtxKey{}))
	}
	// nil db 必须静默跳过（与其它装配接缝同口径：测试路由树/无 DB 启动不 panic）。
	startUsageRetentionScheduler(context.Background(), nil, usageretention.DefaultTick)
}

type usageRetentionCtxKey struct{}

func TestStartupCallsUsageRetentionScheduler(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	call := "startUsageRetentionScheduler(ctx, db, usageretention.DefaultTick)"
	idx := strings.Index(text, call)
	if idx < 0 {
		t.Fatalf("main() 未调用 %s —— usage 明细保留策略在稳态下没有执行者", call)
	}
	ctxIdx := strings.Index(text, "ctx, stop := signal.NotifyContext(")
	if ctxIdx < 0 {
		t.Fatal("main() 里找不到 signal ctx 的定义（判据锚点漂移）")
	}
	if idx < ctxIdx {
		t.Fatal("usage 保留调度器排在 signal ctx 之前（拿不到关停信号）")
	}
	mainAt := strings.Index(text, "func main() {")
	if mainAt < 0 {
		t.Fatal("main.go 里找不到 func main()")
	}
	nextFuncAt := strings.Index(text[mainAt+1:], "\nfunc ")
	if nextFuncAt < 0 {
		nextFuncAt = len(text) - mainAt - 1
	}
	if idx < mainAt || idx > mainAt+nextFuncAt {
		t.Fatal("usage 保留调度器装配不在 main() 函数体内 —— 进程启动路径不会执行到它")
	}
	// "启动时清理一次"的旧形态不得复活：它会让"稳态无执行者"重新成立，且与
	// 调度器的启动首轮重复。清理只允许出现在调度器与保存配置的路径上。
	if strings.Contains(text, "serverstore.CleanupUsageRetention(") {
		t.Fatal("main.go 里仍有直连 serverstore.CleanupUsageRetention 的调用（旧的一次性启动清理形态）")
	}
}
