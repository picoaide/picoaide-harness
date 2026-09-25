package reports

// 月报投递的**调度策略**（R19B-02 + R19A-S1-06/S1-07，审计 2026-09-25）。
//
// 三条判据面都在这里（唯一实现），调用方（scheduler.tryRun / DispatchAll）不得各写一份：
//
//	① **该投哪一期**：`duePeriod` —— 有 `pending_period` 就补那一期（跨月不跳期），
//	   否则是"当前北京月的上一月"。
//	② **该不该投**：`duePeriod` 同时看"本月内是否已成功投递过"（ShouldRunMonthly）
//	   与"退避窗口是否已过"（`next_attempt_at`）。修前没有退避：永久坏的 webhook
//	   每 tick 重投一次 = 24 次/天/实例（R19A-S1-06 实测 24 轮 = 24 次）。
//	③ **谁来投**：`claimReportDelivery` —— 跨实例互斥（PG advisory lock，按订阅 id）。
//	   修前两个实例同时 tick 会把同一期投两遍（R19A-S1-06 实测 2 次）。
//
// 为什么退避与期号要落库（迁移 0082）：内存态在多实例/重启后消失，而"这一期还没投出去"
// 是必须跨重启存活的**事实**。

import (
	"context"
	"database/sql"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const (
	// reportRetryFirstDelay 是**首次**失败后的快速重试等待（1 小时）。
	reportRetryFirstDelay = time.Hour
	// reportRetryMaxDelay 是持续失败后的重试间隔上界：**每天最多 1 次**。
	reportRetryMaxDelay = 24 * time.Hour
)

// reportPushLockClass 是投递认领的 advisory-lock 命名空间（int4 类号）。
//
// 取值刻意与既有锁键不同空间：本仓其它调用点用的是 int8 键（"Pico"/"PicT" 等）
// 或 hashtext(单键)，而 `pg_advisory_lock(int4,int4)` 会打包成
// `(classid << 32) | objid` ⇒ 只要 classid 不为 0 就不会撞上那些小整数键。
const reportPushLockClass = int32(0x52505431) // "RPT1"

// reportRetryDelay 返回"连续失败 failStreak 次之后"应等待多久再试。
//
// 形态 = **首次快速重试 + 之后按天**：failStreak=1 ⇒ 1 小时，≥2 ⇒ 24 小时。
//
// 为什么不是连续指数（1h/2h/4h/8h/1d）：① 月报是**月度**产物，管理端只承诺"失败会
// 自动重试"，首日多打 3 次对永久故障（地址写错/机器人被删）毫无价值；② 反过来，
// "管理员修好 webhook 后最多等 1 小时就补投"这条体验必须保住 ⇒ 首次 1 小时。
// 两段式正好同时满足两端：瞬时故障 1 小时内自愈，永久故障收敛到 **1 次/天/实例**
// （≈31 次/月，修前 = 每 tick 一次 ≈720 次/月）。
//
// 判据（report_delivery_policy_test.go）钉住"24 个 1 小时 tick 内 ≤2 次投递，且
// 首次重试落在第 2 个 tick"。
func reportRetryDelay(failStreak int) time.Duration {
	if failStreak <= 1 {
		return reportRetryFirstDelay
	}
	return reportRetryMaxDelay
}

// SubscriptionDuePeriod 返回该订阅这一轮应投递的期号与"是否欠投"（判据直接调用它）。
//
// 判定顺序（顺序本身就是语义）：
//  1. 订阅已禁用 ⇒ 不欠投；
//  2. 退避窗口内（next_attempt_at > now）⇒ 不欠投（S1-06 ①：失败必须有退避）；
//  3. `pending_period` 非空 ⇒ 补投**那一期**（S1-07：跨月不跳期）；
//  4. 否则"本月内还没成功投递过" ⇒ 投当前北京月的上一期（原语义）。
//
// 凡不欠投，返回的 period 都为空串（调用方不得据此生成报表）。
func SubscriptionDuePeriod(now time.Time, sub serverstore.ReportSubscription) (period string, due bool) {
	if !sub.Enabled {
		return "", false
	}
	if sub.NextAttemptAt != nil && sub.NextAttemptAt.After(now) {
		return "", false
	}
	if p := sub.PendingPeriod; p != "" {
		return p, true
	}
	if !ShouldRunMonthly(now, sub.LastRunAt) {
		return "", false
	}
	return CurrentPeriod(now), true
}

// CurrentPeriod 返回 now 所在北京月的**上一期**期号（`YYYY-MM`）—— 月报期号口径的唯一实现
// （与 `GenerateMonthlyReport` 的 `prev.Format("2006-01")` 同源同值）。
func CurrentPeriod(now time.Time) string {
	return serverstore.BeijingMonth(now).AddDate(0, -1, 0).Format("2006-01")
}

// nextAttemptAfterFailure 返回"第 failStreak 次连续失败之后"的最早重试时刻。
func nextAttemptAfterFailure(now time.Time, failStreak int) time.Time {
	return now.Add(reportRetryDelay(failStreak))
}

// claimReportDelivery 尝试为该订阅取得一次投递认领（跨实例互斥）。
//
// ⚠️ `pg_try_advisory_lock` 是**会话级**锁 ⇒ 加锁与解锁必须落在**同一个连接**上，
// 所以这里用 `*sql.Conn` 而不是 db.Exec（连接池会把两条语句派到不同会话，锁当场泄漏
// 到池里那条连接上，此后本进程的重入判断全部失真）。
// 调用方负责 defer unlock + conn.Close()。
func claimReportDelivery(ctx context.Context, db *sql.DB, subID int64) (*sql.Conn, bool, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, false, err
	}
	var ok bool
	if err := conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1, $2)`,
		reportPushLockClass, int32(subID)).Scan(&ok); err != nil {
		_ = conn.Close()
		return nil, false, err
	}
	if !ok {
		_ = conn.Close()
		return nil, false, nil
	}
	return conn, true, nil
}

// releaseReportDelivery 释放认领（与 claimReportDelivery 配对，必须同一个连接）。
func releaseReportDelivery(ctx context.Context, conn *sql.Conn, subID int64) {
	if conn == nil {
		return
	}
	_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock($1, $2)`, reportPushLockClass, int32(subID))
	_ = conn.Close() // 归还连接池（锁已释放；即便失败，归还也不会让别的会话拿到同一把会话锁）
}
