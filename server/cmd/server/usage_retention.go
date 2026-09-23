package main

// usage 明细保留策略调度器的装配接缝（R5-A-11，审计 2026-09-23，P1；与
// audit_retention.go / gateway_reaper.go 同款）。
//
// 缺陷形态：`serverstore.CleanupUsageRetention` 只有"服务启动时"与"管理员保存
// 保留期时"两个调用点 —— 稳态运行的实例只在启动那一刻按保留期 DROP 过期分区
// （`usage.retention_months` 形同虚设，明细随经过的月份单调增长）。修法是挂一个
// 周期调度器（`internal/usageretention`），但"挂上去"这件事本身必须可被判据观察：
// 只加一行 `Start(ctx)` 时，把那一行删掉所有门禁依旧全绿（本仓已用同一手法踩过：
// 网关回收器与审计保留调度器的装配漂移都只能靠读装配源码发现）。
//
// 因此与审计保留调度器同构：
//  1. 调用收进**可测函数** `startUsageRetentionScheduler`，并用包级变量
//     （`newUsageRetentionScheduler`）留出替换点 ⇒ "参数是不是启动期 ctx /
//     同一个 db / 调度间隔常量"可以被执行级断言钉住；
//  2. `main()` 里必须真的调用它（cmd/server 的装配级用例同时读 main.go 源码断言
//     调用存在、且排在 ctx 定义之后、位于 main() 函数体内）。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/usageretention"
)

// newUsageRetentionScheduler 是调度器的装配接缝：生产恒为
// usageretention.NewScheduler，仅测试替换（断言启动路径确实构造并启动了它）。
var newUsageRetentionScheduler = func(db *sql.DB, tick time.Duration) schedulerStarter {
	return usageretention.NewScheduler(db, tick)
}

// startUsageRetentionScheduler 启动 usage 明细保留策略调度器：启动先跑一轮
// （覆盖停机期间到期的分区，同时取代原先"启动时清理一次"的那次调用），之后每
// tick 一次；ctx 取消即退出（调度器内部自行处理）。
func startUsageRetentionScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return
	}
	newUsageRetentionScheduler(db, tick).Start(ctx)
}
