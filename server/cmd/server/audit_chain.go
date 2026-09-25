package main

// 审计链周期校验调度器的装配接缝（R16C-03，审计 2026-09-25，P2；与
// audit_retention.go / token_retention.go 同款）。
//
// 缺陷形态：`serverstore.VerifyAuditChain` 在生产代码里只有**启动路径**一个调用点
// （见本目录 main.go 的 `RunAndRecordAuditChainCheck`），而 `/server-info` 的
// `audit.chain_intact` 只是读那份缓存 ⇒ 长跑实例（容器几个月不重启）里，篡改审计
// 行**不重启就完全不告警**：`chain_intact` 还是 true、时间戳停在启动时刻。
//
// 修法是挂一个周期执行者（`internal/auditchain`），但"挂上去"这件事本身必须可被
// 判据观察到：只加一行 `.Start(ctx)` 时，把那一行删掉所有门禁依旧全绿（本仓已用
// 同一手法踩过：网关回收器 / 审计保留 / usage 保留三条都补了装配判据）。
//
// 因此与三个兄弟同构：
//  1. 调用收进**可测函数** `startAuditChainScheduler`，并用包级变量
//     （`newAuditChainScheduler`）留出替换点 ⇒ "参数是不是启动期 ctx / 同一个 db /
//     间隔常量"可以被执行级断言钉住；
//  2. `main()` 里必须真的调用它（cmd/server 的装配级用例同时读 main.go 源码断言
//     调用存在、排在 ctx 定义之后）；
//  3. 构造出的调度器登记进进程内状态表（scheduler_status.go），把"是否已启动 /
//     跑了几轮 / 上次何时 / 上次错误"变成可读出口。

import (
	"context"
	"database/sql"
	"log"
	"os"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/auditchain"
)

// auditChainIntervalEnv 是周期校验间隔的运维覆盖（Go duration 字面量，如 "15m"）。
//
// 为什么给它一个旋钮：间隔 = "篡改可见性的窗口"，而每一轮是**一次 audit_logs 全表
// 只读扫描** —— 两者的取舍随表大小与合规要求变化（默认 1 小时：窗口够短，代价是每
// 小时一次全表读）。非法值**响亮**回落默认值（打 WARNING），不静默 ——
// "未知 env 静默回落"本身是本仓登记过的审计缺陷类。
const auditChainIntervalEnv = "PICOAI_AUDIT_CHAIN_INTERVAL"

// resolveAuditChainTick 解析生效间隔：缺省/非法都用传入的常量（非法时告警）。
func resolveAuditChainTick(def time.Duration) time.Duration {
	raw := strings.TrimSpace(os.Getenv(auditChainIntervalEnv))
	if raw == "" {
		return def
	}
	d, err := time.ParseDuration(raw)
	if err != nil || d <= 0 {
		log.Printf("WARNING audit chain: ignoring invalid %s=%q (want a positive Go duration such as 15m or 1h); using default %s",
			auditChainIntervalEnv, raw, def)
		return def
	}
	log.Printf("audit chain: interval overridden by %s=%s (default %s)", auditChainIntervalEnv, d, def)
	return d
}

// schedulerAuditChain 是状态表里的登记名（日志与断言共用同一份字面量）。
const schedulerAuditChain = "audit-chain"

// newAuditChainScheduler 是调度器的装配接缝：生产恒为 auditchain.NewScheduler，
// 仅测试替换（断言启动路径确实构造并启动了它）。
var newAuditChainScheduler = func(db *sql.DB, tick time.Duration) observableScheduler {
	return auditchain.NewScheduler(db, tick)
}

// startAuditChainScheduler 启动审计链周期校验调度器：之后每 tick 校验一次，
// ctx 取消即退出（调度器内部自行处理）。
//
// 与三个兄弟的**有意差异**：这里第一轮在 tick 之后才跑，而不是启动先跑一轮 ——
// 启动路径刚刚做过同一次全表校验（main.go 的启动自检），立刻再扫一遍是纯重复开销。
func startAuditChainScheduler(ctx context.Context, db *sql.DB, tick time.Duration) {
	if db == nil {
		return
	}
	tick = resolveAuditChainTick(tick)
	s := newAuditChainScheduler(db, tick)
	registerSchedulerStatus(schedulerAuditChain, tick, s)
	s.Start(ctx)
}
