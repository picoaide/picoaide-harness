package main

// API 令牌过期回收调度器的装配接缝（R15C-R-01 ①，审计 2026-09-25，P1；
// 与 audit_retention.go / usage_retention.go / gateway_reaper.go 同款）。
//
// 缺陷形态：`api_tokens` **没有任何回收者** —— 全仓对它的 DELETE 只有 4 处按
// user_id 的（改密/禁用/删用户），没有一处按 `expires_at`；迁移 0031 建的
// `idx_tokens_expires` 真 PG 实测 `idx_scan = 0`（建了从未被用过）。过期行永久
// 留在表里，而管理端令牌列表（修复前）无分页 ⇒ 单请求 130 MiB / 堆 +656 MB。
//
// 修法是挂一个周期调度器（`internal/tokenretention`），但"挂上去"这件事本身必须
// 可被判据观察：只加一行 `Start(ctx)` 时，把那一行删掉所有门禁依旧全绿（本仓已用
// 同一手法踩过：网关回收器与审计保留调度器的装配漂移都只能靠读装配源码发现）。
//
// 因此与审计/usage 保留调度器同构：
//  1. 调用收进**可测函数** `startTokenRetentionScheduler`，并用包级变量
//     （`newTokenRetentionScheduler`）留出替换点 ⇒ "参数是不是启动期 ctx /
//     同一个 db / 调度间隔常量"可以被执行级断言钉住；
//  2. 构造出的调度器**登记进调度器状态表**（`schedulerStatuses`）⇒ 启动/关停
//     日志里能读到 `name=token-retention started=… runs=… last_error=…`；
//  3. `main()` 里必须真的调用它（cmd/server 的装配级用例同时读 main.go 源码断言
//     调用存在、且排在 ctx 定义之后、位于 main() 函数体内）。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/tokenretention"
)

// schedulerTokenRetention 是状态表里的登记名（日志与断言共用同一份字面量）。
const schedulerTokenRetention = "token-retention"

// newTokenRetentionScheduler 是调度器的装配接缝：生产恒为
// tokenretention.NewScheduler，仅测试替换（断言启动路径确实构造并启动了它）。
var newTokenRetentionScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
	return tokenretention.NewScheduler(db, tick, nil)
}

// startTokenRetentionScheduler 启动令牌过期回收调度器：启动先跑一轮（覆盖停机
// 期间到期的行），之后每 tick 一次；ctx 取消即退出（调度器内部自行处理）。
func startTokenRetentionScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return
	}
	s := newTokenRetentionScheduler(db, tick)
	registerSchedulerStatus(schedulerTokenRetention, tick, s)
	s.Start(ctx)
}
