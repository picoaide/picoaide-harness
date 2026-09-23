package main

// reports / balance 两个调度器的装配接缝（R6-A-2，审计 2026-09-23，P1；与
// gateway_reaper.go / audit_retention.go / usage_retention.go 同款）。
//
// 缺陷形态：这两行在 main() 里是**裸调用** ——
//
//	reports.NewScheduler(db, time.Hour, nil).Start(ctx)
//	balance.NewScheduler(db, time.Hour, nil).Start(ctx)
//
// 三个兄弟（网关回收器 / 审计保留 / usage 保留）都有"接缝 + 执行级判据 + 源码级
// 判据"，这两个一行都没有：把 `.Start(ctx)` 摘掉（或把整行挪进不执行的分支）时
// `go test ./cmd/server/` **整包仍绿**（审计实测 ok 100s）。后果分别是：
//
//   - `balance` 调度器是**唯一的自动发放路径**（另两个调用点是管理端手动
//     `PUT /balance` 与 `POST /balance/grant`）⇒ 它死掉时 `balance.enabled=true`
//     的部署里余额只减不增，员工最终全部 429 `BALANCE_EXHAUSTED`（全组织 AI
//     不可用），且**零可观测**；
//   - `reports` 调度器死掉 ⇒ 月报订阅永不触发，管理端只看得到 last_run 很旧。
//
// 因此与三个兄弟同构：
//  1. 调用收进**可测函数** `startReportsScheduler` / `startBalanceScheduler`，并用
//     包级变量（`newReportsScheduler` / `newBalanceScheduler`）留出替换点 ⇒
//     "参数是不是启动期 ctx / 同一个 db / 间隔常量"可以被执行级断言钉住；
//  2. `main()` 里必须真的调用它们（cmd/server 的装配级用例同时读 main.go 源码
//     断言调用存在、排在 ctx 定义之后、位于 main() 函数体内）；
//  3. 构造出的调度器同时登记进进程内状态表（scheduler_status.go），把
//     "是否已启动 / 跑了几轮 / 上次何时 / 上次错误"变成可读的出口。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/balance"
	"github.com/picoaide/picoaide/internal/reports"
)

// 两个调度器的检查间隔（装配层唯一真源：判据断言装配传的就是这两个常量）。
const (
	// reportsSchedulerTick：月报订阅的补跑检查间隔（保留原有 1 小时语义）。
	reportsSchedulerTick = time.Hour
	// balanceSchedulerTick：月度余额发放的检查间隔（保留原有 1 小时语义；
	// balance 包自己的缺省是 10 分钟，装配显式传值）。
	balanceSchedulerTick = time.Hour
)

// newReportsScheduler 是调度器的装配接缝：生产恒为 reports.NewScheduler，
// 仅测试替换（断言启动路径确实构造并启动了它）。
var newReportsScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) observableScheduler {
	return reports.NewScheduler(db, tick, nowFn)
}

// newBalanceScheduler 同上（生产恒为 balance.NewScheduler）。
var newBalanceScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) observableScheduler {
	return balance.NewScheduler(db, tick, nowFn)
}

// startReportsScheduler 启动月报推送调度器：构造后登记运行状态并交给它自己跑
// （启动即跑一轮——补跑上月报表；之后每 tick 一次；ctx 取消即退出）。
func startReportsScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	startObservedScheduler(ctx, schedulerReports, db, tick, newReportsScheduler)
}

// startBalanceScheduler 启动月度余额发放调度器（同上）。
func startBalanceScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	startObservedScheduler(ctx, schedulerBalance, db, tick, newBalanceScheduler)
}

// startObservedScheduler 是两条接缝共用的装配体：nil db 静默跳过（与其它装配
// 接缝同口径：测试路由树/无 DB 启动不 panic），否则构造 → 登记 → Start。
func startObservedScheduler(
	ctx context.Context,
	name string,
	db *sql.DB,
	tick time.Duration,
	newScheduler func(*sql.DB, time.Duration, func() time.Time) observableScheduler,
) {
	if db == nil {
		return
	}
	s := newScheduler(db, tick, nil)
	registerSchedulerStatus(name, tick, s)
	s.Start(ctx)
}
