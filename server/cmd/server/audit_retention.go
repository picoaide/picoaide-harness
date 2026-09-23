package main

// 审计保留策略调度器的装配接缝（R4-D-4，审计 2026-09-23，P2，与 gateway_reaper.go 同款）。
//
// 缺陷形态：`serverstore.PurgeOldAuditLogs` 只有"服务启动时"与"管理员保存配置时"两个
// 调用点 —— 稳态运行的实例只在启动那一刻按保留期清理，`audit.retention_days` 形同虚设
// （审计表随运行时长单调增长）。修法是挂一个周期调度器（`internal/auditretention`），
// 但"挂上去"这件事本身必须可被判据观察到：只加一行 `...Start(ctx)` 时，把那一行删掉
// 所有门禁依旧全绿（本仓已用同一手法踩过：网关回收器的装配漂移只能靠读装配源码发现）。
//
// 因此与回收器同构：
//  1. 调用收进**可测函数** `startAuditRetentionScheduler`，并用包级变量
//     （`newAuditRetentionScheduler`）留出替换点 ⇒ "参数是不是启动期 ctx / 同一个 db /
//     调度间隔常量"可以被执行级断言钉住；
//  2. `main()` 里必须真的调用它（cmd/server 的装配级用例同时读 main.go 源码断言调用
//     存在、且排在 ctx 定义之后）。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/auditretention"
)

// schedulerStarter 是"能被 Start(ctx)"的最小面（*auditretention.Scheduler 满足）。
// 抽出来只是为了让装配接缝可被测试替换（断言启动路径确实构造了调度器并调用了 Start）。
type schedulerStarter interface {
	Start(ctx context.Context)
}

// newAuditRetentionScheduler 是调度器的装配接缝：生产恒为
// auditretention.NewScheduler，仅测试替换（断言启动路径确实构造并启动了它）。
var newAuditRetentionScheduler = func(db *sql.DB, tick time.Duration, nowFn func() time.Time) schedulerStarter {
	return auditretention.NewScheduler(db, tick, nowFn)
}

// startAuditRetentionScheduler 启动审计保留策略调度器：启动先跑一轮（覆盖停机期间
// 到期的条目），之后每 tick 一次；ctx 取消即退出（调度器内部自行处理）。
func startAuditRetentionScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return
	}
	s := newAuditRetentionScheduler(db, tick, nil)
	s.Start(ctx)
}
