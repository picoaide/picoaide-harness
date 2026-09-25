package main

// 装配级判据（R16C-03）：审计链的周期校验器必须真的在**启动路径**上被构造并启动。
//
// 背景：`VerifyAuditChain` 在生产代码里此前只有启动路径一个调用者 ⇒ 长跑实例里
// 篡改审计行**不重启就不告警**（`/server-info` 把启动那一刻的结论当当前状态）。
// 修法是挂周期执行者，但"挂上去"必须可被判据观察 —— 只加一行 `.Start(ctx)` 时，
// 删掉那一行所有门禁依旧全绿（本仓已用同一手法踩过三次：网关回收器 / 审计保留 /
// usage 保留 / 令牌回收）。
//
// 两条判据互补（与 audit_retention_test.go 同款）：
//   - 执行级（TestAuditChainSchedulerWiring）：把构造点换成桩，断言启动路径用它构造了
//     调度器并**调用了 Start**，参数是（启动期 ctx, 同一个 db, 间隔常量），且登记进了
//     调度器状态表；
//   - 源码级（TestStartupCallsAuditChainScheduler）：断言 main() 里存在
//     `startAuditChainScheduler(ctx, db, auditchain.DefaultTick)`，且在 signal ctx 之后
//     —— 整行删掉/挪进不执行的分支由这一条兜住。

import (
	"context"
	"database/sql"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/auditchain"
)

type auditChainCtxKey struct{}

func TestAuditChainSchedulerWiring(t *testing.T) {
	resetSchedulerStatus(t)
	got := make(chan *stubObservableScheduler, 1)
	prev := newAuditChainScheduler
	t.Cleanup(func() { newAuditChainScheduler = prev })
	newAuditChainScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
		s := &stubObservableScheduler{db: db, tick: tick, start: make(chan struct{})}
		got <- s
		return s
	}

	db, err := sql.Open("pgx", "postgres://user:pass@127.0.0.1:1/never-connected")
	if err != nil {
		t.Fatalf("open placeholder db: %v", err)
	}
	defer db.Close()

	parent, cancel := context.WithCancel(context.WithValue(context.Background(), auditChainCtxKey{}, "startup"))
	defer cancel()
	startAuditChainScheduler(parent, db, auditchain.DefaultTick)

	var s *stubObservableScheduler
	select {
	case s = <-got:
	case <-time.After(5 * time.Second):
		t.Fatal("启动路径没有构造审计链周期校验器（装配接缝未被调用）")
	}
	select {
	case <-s.start:
	case <-time.After(5 * time.Second):
		t.Fatal("构造了调度器但没有调用 Start（周期校验不会运行）")
	}
	if s.db != db {
		t.Fatal("调度器拿到的不是启动期的 db")
	}
	if s.tick != auditchain.DefaultTick {
		t.Fatalf("tick = %v, want %v（装配必须传默认间隔常量）", s.tick, auditchain.DefaultTick)
	}
	if s.ctx == nil || s.ctx.Value(auditChainCtxKey{}) != "startup" {
		t.Fatalf("调度器拿到的不是启动期 ctx（关停信号到不了调度器）: %v", s.ctx)
	}
	// 状态表登记：运维出口（启动/关停日志）必须看得到它。
	found := false
	for _, st := range schedulerStatuses() {
		if st.Name == schedulerAuditChain {
			found = true
		}
	}
	if !found {
		t.Fatalf("审计链调度器没有登记进调度器状态表（name=%s）", schedulerAuditChain)
	}
	// nil db 必须静默跳过（与其它装配接缝同口径：测试路由树/无 DB 启动不 panic）。
	startAuditChainScheduler(context.Background(), nil, auditchain.DefaultTick)
}

func TestStartupCallsAuditChainScheduler(t *testing.T) {
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatal(err)
	}
	text := string(src)
	call := "startAuditChainScheduler(ctx, db, auditchain.DefaultTick)"
	idx := strings.Index(text, call)
	if idx < 0 {
		t.Fatalf("main() 未调用 %s —— 审计链在稳态下没有执行者（篡改不重启就不告警）", call)
	}
	ctxIdx := strings.Index(text, "ctx, stop := signal.NotifyContext(")
	if ctxIdx < 0 {
		t.Fatal("main() 里找不到 signal ctx 的定义（判据锚点漂移）")
	}
	if idx < ctxIdx {
		t.Fatal("审计链周期校验排在 signal ctx 之前（拿不到关停信号）")
	}
}

// TestResolveAuditChainTickHonoursEnv 钉间隔覆盖：合法值生效、非法/非正/空白回落默认
// （非法值必须**响亮**回落 —— 打 WARNING，不静默）。
func TestResolveAuditChainTickHonoursEnv(t *testing.T) {
	if got := resolveAuditChainTick(auditchain.DefaultTick); got != auditchain.DefaultTick {
		t.Fatalf("未设置 env 时 tick = %v, want %v", got, auditchain.DefaultTick)
	}
	t.Setenv(auditChainIntervalEnv, "15m")
	if got := resolveAuditChainTick(auditchain.DefaultTick); got != 15*time.Minute {
		t.Fatalf("合法覆盖 tick = %v, want 15m", got)
	}
	for _, bad := range []string{"bogus", "0", "-5m", "  "} {
		t.Setenv(auditChainIntervalEnv, bad)
		if got := resolveAuditChainTick(auditchain.DefaultTick); got != auditchain.DefaultTick {
			t.Fatalf("非法值 %q 的 tick = %v, want 默认 %v（非法必须回落默认）", bad, got, auditchain.DefaultTick)
		}
	}
}
