package reports

// 月报投递的**调度策略**（R19B-02 + R19A-S1-06/S1-07，审计 2026-09-25）。
//
// 三条判据面都在这里（唯一实现），调用方（scheduler.tryRun / DispatchAll）不得各写一份：
//
//	① **该投哪一期**：`duePeriod` —— 有 `pending_period` 就补那一期（跨月不跳期），
//	   否则是"当前北京月的上一月"。`pending_period` 是**游标**而非单槽：每成功投出
//	   一期就推进一格（`nextPendingAfterDelivery`），所以跨月失败期间到期的中间各期
//	   会被逐 tick 补齐，不会因为游标被"最早那一期"钉住而永久丢失（R21C-01，P1）。
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
//  3. `pending_period` 非空 ⇒ 补投**那一期**（S1-07：跨月不跳期；R21C-01 起它是
//     "最早未投递期号"的**游标**，每成功投出一期由 `nextPendingAfterDelivery` 推进
//     一格 ⇒ 被它挡住的中间各期不会再被永久跳过）；
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

// nextPendingAfterDelivery 返回"成功投出 period 之后，订阅应继续钉住的欠投期号"
// （空 = 这一期之后不再欠投）—— R21C-01（审计 2026-09-26，**P1**）。
//
// 缺陷形态（修前：成功落账一律清空 `pending_period` 并把 `last_run_at` 推到当月）：
// `pending_period` 是**单槽**，webhook 连续失败跨过 N 个月界时，在这期间"轮到自己"
// 的期号既不进该列也不落任何痕迹；补投成功那一次还把 `last_run_at` 推到当月 ⇒
// `ShouldRunMonthly` 当月为 false，下一个月 `CurrentPeriod` 只给"上一个北京月"
// ⇒ 被挡住的中间各期**永久不投且无恢复路径**（真 PG 端到端实测
// delivered=[2026-06 2026-10]、never=[2026-07/08/09]）。
//
// 修后语义 = **游标逐期推进**（每个 tick 补一期、按序补齐）：
//   - 投出的期号 P 严格早于"当前应投期"（= 它后面还有已到期的期号）⇒ 游标推进到
//     P 的下一期，下一个 tick 接着补；
//   - 投出的正是当前应投期（或期号为空/不合法）⇒ 清空游标（欠投已补完）。
//
// `YYYY-MM` 是定长零填充 ⇒ 字典序 = 时间序，可以直接比大小。
func nextPendingAfterDelivery(now time.Time, period string) string {
	if period == "" {
		// 兼容入口（MarkReportRun 不带期号）无从判断游标该推进到哪 ⇒ 维持旧语义。
		return ""
	}
	if period >= CurrentPeriod(now) {
		return ""
	}
	return periodAfter(period)
}

// periodAfter 返回期号 period 的下一期（`YYYY-MM`）。
//
// 期号不合法（外部写坏的 `pending_period` 取值）时返回空串：**保守收口** —— 宁可
// 停止推进（这一期投完就清空游标、走 ShouldRunMonthly 的正常路径），也不要往库里
// 写一个解析不了的期号 —— 那会让 `GenerateMonthlyReportForPeriod` 每轮都失败，
// 把订阅卡死在"一直欠投但永远投不出去"。
//
// 解析与月算术**都不经过 `time.Local`**（R21F-05，审计 2026-09-26，P3）：期号是
// **标签**而不是时刻，游标推进只做"字面年月 + 1"。修前是
// `time.ParseInLocation("2006-01", period, time.Local)` + `start.AddDate(0,1,0)`，
// 而 `ParseInLocation` 会把**不存在的本地零点**归一化 —— 当部署时区的 DST 缺口
// 正好落在某月 1 日的本地零点时，月首被推到**上月最后一天 23:00**，`+1 月` 之后
// 仍格式化出**同一个月份** ⇒ 游标原地不动：那一期被反复投递（补投链断在原地，
// 这正是 R21C-01 修的"逐期推进"所依赖的函数）。
//
// 实测形态（探针 temp/r21/fix-10/probe/period_after_probe.go，逐字输出存
// probe/out.txt）：`TZ=America/Asuncion` 的 `periodAfter("2017-09") == "2017-09"`
// 与 `periodAfter("2023-09") == "2023-09"`（那两个月的 1 日零点不存在；
// 418 个时区 × 2015–2035 × 12 个月只命中这两组真形态，且都是历史日期 ——
// Asunción 2024 起已无 DST ⇒ 现有 tzdata 无未来命中，故定级 P3）。
//
// 修法与 `GenerateMonthlyReportForPeriod` **同一范式**：复用同包的
// `parseBeijingPeriod`（只取字面年月 → 重新锚成"北京日期值"= Location=UTC 的 1 日），
// 再在该日期值空间 +1 月（UTC 无 DST 缺口，且日=1 不会被 `AddDate` 归一化）。
// **不新写第二份期号解析**；形态校验的严格性与修前逐字一致（同一个 layout）。
func periodAfter(period string) string {
	start, err := parseBeijingPeriod(period)
	if err != nil {
		return ""
	}
	return start.AddDate(0, 1, 0).Format("2006-01")
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
