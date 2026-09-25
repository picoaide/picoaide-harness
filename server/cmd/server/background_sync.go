package main

// 模型同步 / 目录同步两条后台循环的装配接缝（R19B-05，审计 2026-09-25，P2）。
//
// 缺陷形态：这两行在 main() 里此前是**裸 goroutine + 不看 ctx 的 for 循环**：
//
//	go llmgateway.SyncLoop(db, time.Hour, nil)
//	go serverauth.SyncDirectoryLoop(db, serverauth.LDAPSyncInterval, nil)
//
// 它们是进程内**唯一**两条既没有 ctx/停止信号、也没有运行状态
// （started/runs/last_run_at/last_error）、也没进 scheduler_status.go、**且没有任何
// 装配断言**的后台循环 —— 同期兄弟（网关文件回收器 / reports / balance / audit 保留 /
// usage 保留 / token 保留 / 审计链）全部有"接缝 + 执行级判据 + 源码级判据"。
// 审计实测：把任一行 `go …Loop(` 删掉后 `go test ./cmd/server/` **整包仍绿**，
// 而后果分别是：
//
//   - 渠道模型同步死掉 ⇒ 上游新增/下架模型不再反映（管理员只能手点同步）；
//   - **`serverstore.CleanupPendingUsage` 的周期执行者一起消失** —— 它是中断流
//     0-token pending 行唯一的闸门（无界增长）；
//   - LDAP 目录同步死掉 ⇒ 离职账号不自动停用、入职不开通、组变化不反映。
//
// 因此与其它七条调度器同构：构造收进**可测接缝**（包级变量留替换点）、登记进
// scheduler_status.go 的运行状态表、Start(ctx) 拿启动期 ctx（关停可停），并由
// background_sync_test.go 的执行级 + 源码级判据钉住 main() 里那两行。
//
// 与 schedulers.go 的关系：那里是"构造器签名相同"的两个调度器（第三参是 nowFn），
// 复用 startObservedScheduler；这里两条循环的第三参分别是 fetchFn / runner，
// 所以构造在接缝内完成，共用 startObservedSchedulerWith 做"登记 + 启动"。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverauth"
)

// 两条循环的检查间隔（装配层唯一真源：判据断言装配传的就是这两个常量）。
const (
	// modelSyncTick：渠道模型自动同步 + pending usage 回收（保留原有 1 小时语义）。
	modelSyncTick = time.Hour
	// directorySyncTick：LDAP 目录全量同步（serverauth 包内的常量，语义"每小时"）。
	directorySyncTick = serverauth.LDAPSyncInterval
)

// newModelSyncScheduler 是建模同步调度器的装配接缝：生产恒为
// llmgateway.NewModelSyncScheduler（fetchFn=nil ⇒ 真实出站），仅测试替换。
var newModelSyncScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
	return llmgateway.NewModelSyncScheduler(db, tick, nil)
}

// newDirectorySyncScheduler 同上（runner=nil ⇒ 生产 LDAP 目录同步实现）。
var newDirectorySyncScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
	return serverauth.NewDirectorySyncScheduler(db, tick, nil)
}

// startModelSyncScheduler 启动渠道模型同步循环：构造 → 登记运行状态 → Start(ctx)
// （启动即跑一轮，之后每 tick 一次，ctx 取消即退出）。
func startModelSyncScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return // 与其它装配接缝同口径：测试路由树/无 DB 启动不 panic
	}
	startObservedSchedulerWith(ctx, schedulerModelSync, tick, newModelSyncScheduler(db, tick))
}

// startDirectorySyncScheduler 启动 LDAP 目录全量同步循环（同上）。
func startDirectorySyncScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return
	}
	startObservedSchedulerWith(ctx, schedulerDirectorySync, tick, newDirectorySyncScheduler(db, tick))
}
