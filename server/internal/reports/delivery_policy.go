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
// 另有一条**可信度**判定（R22-V3-B1/B2，复审 2026-09-26；R23-V3-B1 补下界）：
// `pending_period` 是库里的值，外部可以写坏。`classifyPendingPeriod` 是它的唯一判定点：
//
//	形态非法 / **早于该订阅可追认的最早期号** / **超出报表数据模型可表示的期号区间**
//	    ⇒ 本轮不投 + 记原因（fail-closed，**不设退避**）；
//	未来期号 ⇒ 忽略该格、走正常路径（不投幽灵空报表、不丢欠投期）。
//
// 下界的依据与边界见 `pendingPeriodFloor` / `earliestReportPeriod` 的注释 ——
// "上界（未来期号）有判据而下界没有"正是 R23 复审的最小反例：`pending_period='0001-01'`
// 形态合法、Go 与 PG 都接受 ⇒ 每轮投出一份公元 1 年的空报表、游标 +1 月，
// 真正欠投的期号一期都投不出去（见 classifyPendingPeriod 的注释）。
// 判定结果经 `SubscriptionDuePeriod` 的第三个返回值上抛给编排层。
//
// 为什么退避与期号要落库（迁移 0082）：内存态在多实例/重启后消失，而"这一期还没投出去"
// 是必须跨重启存活的**事实**。

import (
	"context"
	"database/sql"
	"fmt"
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

// SubscriptionDuePeriod 返回该订阅这一轮应投递的期号、是否欠投，以及
// `pending_period` 不可信时的**可诊断原因**（空串 = 游标可信）—— 判据直接调用它。
//
// 判定顺序（顺序本身就是语义）：
//  1. 订阅已禁用 ⇒ 不欠投；
//  2. 退避窗口内（next_attempt_at > now）⇒ 不欠投（S1-06 ①：失败必须有退避）；
//  3. `pending_period` 非空 ⇒ 先过 `classifyPendingPeriod`（**唯一判定点**）：
//     可信 ⇒ 补投那一期；形态非法 ⇒ fail-closed，本轮不投 + 给原因；未来期号 ⇒
//     忽略这一格、落到第 4 条走正常路径（理由见 classifyPendingPeriod 的注释）；
//  4. 否则"本月内还没成功投递过" ⇒ 投当前北京月的上一期（原语义）。
//
// 凡不欠投，返回的 period 都为空串（调用方不得据此生成报表）。anomaly 非空**且
// due=false** 时调用方要把它当成"这一条本轮失败"（failed++ + 落 last_error），
// 但不能据此生成任何报表 —— 那正是 R22-V3-B1/B2 要挡的形态。
func SubscriptionDuePeriod(now time.Time, sub serverstore.ReportSubscription) (period string, due bool, anomaly string) {
	if !sub.Enabled {
		return "", false, ""
	}
	if sub.NextAttemptAt != nil && sub.NextAttemptAt.After(now) {
		return "", false, ""
	}
	if p := sub.PendingPeriod; p != "" {
		switch class, reason := classifyPendingPeriod(now, sub.CreatedAt, p); class {
		case pendingMalformed, pendingUnreachable:
			// 形态非法 / 早于订阅可追认的最早期号（或超出数据模型可表示的区间）⇒
			// 无法知道欠投到哪一期 ⇒ **本轮不投**（fail-closed），绝不把这一格当合法期号
			// 去生成（修前它会让整批订阅停投；只有上界时它会让游标从公元 1 年起爬）。
			return "", false, reason
		case pendingFuture:
			// 未来期号 ⇒ 不可信输入，**忽略这一格**走正常路径：欠投期照常补投，
			// 投出的正是当前应投期，`nextPendingAfterDelivery` 随后把这一格清空（自愈）。
			if !ShouldRunMonthly(now, sub.LastRunAt) {
				return "", false, reason
			}
			return CurrentPeriod(now), true, reason
		}
		return p, true, ""
	}
	if !ShouldRunMonthly(now, sub.LastRunAt) {
		return "", false, ""
	}
	return CurrentPeriod(now), true, ""
}

// pendingPeriodClass 是 `pending_period` 这一格的可信度分类。
type pendingPeriodClass int

const (
	// pendingTrusted：形态合法、落在可表示区间内、且不早于该订阅可追认的最早期号、
	// 不晚于"当前应投期" ⇒ 可以据此生成报表。
	pendingTrusted pendingPeriodClass = iota
	// pendingMalformed：形态不是 `YYYY-MM`（外部 SQL 手改 / 半份备份恢复 / 旧格式遗留）。
	pendingMalformed
	// pendingFuture：形态合法但**晚于**"当前应投期" ⇒ 外部写入的未来期号。
	pendingFuture
	// pendingUnreachable：形态合法、也不晚于当前应投期，但它**早于该订阅可追认的
	// 最早期号**（`pendingPeriodFloor`），或落在**报表数据模型不能表示的期号区间**里
	// （`earliestReportPeriod`）。
	//
	// 处置与 pendingMalformed **同档**（fail-closed + 不设退避 + 修好即自愈）：两者
	// 都是"这一格不可能是产品写的"⇒ 无法据它推出欠投到哪一期。为什么必须单独一类
	// （R23-V3-B1，复审 2026-09-27，P2）：这一形态**形态合法**，`time.Parse` 与 PG 都
	// 接受，所以只判"是否晚于当前应投期"的修法**放它过去** —— 实测每轮投出一份公元 1 年的
	// 空报表、游标每轮 +1 月，真正欠投的 2026-06/07/08 一期都没投（要 2.4 万+ 轮才追上），
	// 且 `last_error` 全程为空（连痕迹都没有）。
	pendingUnreachable
)

// earliestReportPeriod 是**报表数据模型能表示的期号下界**（含）。
//
// 依据不是拍脑袋的常数，而是生成路径的算术：`GenerateMonthlyReportForPeriod(P)` 把 P
// 解析成月首后 **+1 月**喂给 `GenerateMonthlyReport`，后者取 `prev = 该月 -1` ⇒ 聚合窗口
// 的起点恒是 `P 的月首`，终点是 `P 的月末`。而 PostgreSQL 的 `date`/`timestamptz` 起点是
// **4713 BC**、没有公元 0 年 ⇒ `P = '0000-12'`（乃至任何 `0000-XX`）会让聚合 SQL 收到
// `"0000-12-01"` 这样的日期，PG 直接报 `date/time field value out of range`
// （**SQLSTATE 22008**），整条订阅卡在"一直欠投但永远生成失败"上。
//
// `'0001-01'` 因此是**闭区间**下界：它是 PG 能表示的最早月份，实测生成成功（正是这条
// 让修复前的 `0001-01` 形态每轮投出公元 1 年的空报表）。上界无需在此设防：
// `pending_period` 只要能解析就 ≤ `9999-12`（layout `2006` 要求 4 位年），聚合窗口
// 落在 PG 的表示范围内；而 > 当前应投期的值另有 `pendingFuture` 那一档处置。
const earliestReportPeriod = "0001-01"

// pendingPeriodFloor 返回该订阅**可追认的最早期号**（闭区间下界）—— 下界的唯一实现。
//
// ## 依据（"部署可追认"到底指什么）
//
// `pending_period` 产品自身只有两个写点，写进去的值恒是"写入那一刻的
// `CurrentPeriod(now)`"或它的**后继**：
//
//	MarkReportAttemptOn  的 period 形参（= 这一轮该投的期号，来自 duePeriod）
//	MarkReportDeliveredOn 的 nextPending（= `periodAfter(上一期)`）
//
// 而 `CurrentPeriod(t)` = t 所在北京月 **-1 月**。因此对一条 `created_at` 落在 M 月的
// 订阅行：产品**不可能**为它写下一个早于 `CurrentPeriod(created_at)` 的期号（写下那一刻
// 这行还不存在），且游标只前进（`nextPendingAfterDelivery` 只做 +1 月或清空）⇒
// 任何严格早于该下界的值都**不是产品写的**，与"形态非法"同一威胁模型（SQL 手改 /
// 半份备份恢复 / 旧格式遗留），必须按不可信档处置。
//
// 下界是**闭区间**：恰好等于 `CurrentPeriod(created_at)` 是合法边界 —— 订阅创建当月
// 第一次投递失败写下的正是它（实测用例见 report_pending_period_floor_test.go 的
// `TestPendingPeriodFloorIsInclusiveAtCreationBoundary`）。
//
// ## 为什么不用"倒退 N 期"这种纯常数下界
//
// 合法欠投可以很长：投递失败时游标**不动**（失败要重投同一期），所以 webhook 坏多久，
// 游标就可能被钉多久。任何"最多回溯 N 期"的常数都会把真实的长欠投误判成不可信（而
// 误判的代价是 fail-closed：真正欠投的期号一期都不投）。`created_at` 这个锚点没有这个
// 问题：它是**逐行的**、"这行什么时候存在"的事实，与欠投多久无关。
//
// ## 认账的边界：库钟与调度钟必须同源（都是墙钟）
//
// 下界用的是 `created_at`（DB 的 `now()`），而"当前应投期"用的是调度时钟（进程的
// `time.Now()`）。两者都是墙钟，正常部署下同源；只有在**DB 服务器时钟比应用服务器
// 快 ≥1 个月**这种极端错配下，产品自己刚写下的游标才会被判成"早于下界"。后果是
// fail-closed（不投）而不是误投，且文案直接给出恢复动作（改成 ≥ 下界的期号或清空该列，
// 下一轮自愈）—— 这里如实登记，不假装它不存在。
//
// ## 零值 `created_at` 的行为（诚实声明）
//
// 结构体零值（`time.Time{}` = 公元 1 年 1 月）会算出下界 `"0000-12"` ⇒ **等于没有下界**，
// 只剩 `earliestReportPeriod` 那一层。这在产品路径上不可达：`report_subscriptions.created_at`
// 是 `NOT NULL DEFAULT now()`（迁移 0056），`ListReportSubscriptions` /
// `GetReportSubscriptionOn` 两个读点都把它扫进结构体；只有"手写结构体字面量"的调用方
// （用例、将来新增的构造点）才会拿到零值。**新增读点时必须一起带上 created_at**。
func pendingPeriodFloor(createdAt time.Time) string {
	if createdAt.IsZero() {
		return "" // 无创建时间信息 ⇒ 只保留 earliestReportPeriod 那一层
	}
	return CurrentPeriod(createdAt)
}

// periodBeforeFloor 报告期号是否**严格早于**下界（空下界 = 无约束）。
//
// `YYYY-MM` 是定长零填充 ⇒ 字典序 = 时间序，直接比字符串即可（与
// `nextPendingAfterDelivery` 同一依据）。
func periodBeforeFloor(period, floor string) bool {
	return floor != "" && period < floor
}

// classifyPendingPeriod 判定 `pending_period` 这一格的可信度（返回分类 + 可诊断原因）。
// `createdAt` 是该订阅行的创建时刻，用来算**逐行下界**（见 `pendingPeriodFloor`）。
//
// ## 为什么外部写坏的值要当一等输入处理（R22-V3-B1/B2，复审 2026-09-26，P2/P3）
//
// `pending_period` 产品自身只写 `CurrentPeriod` 与它的后继，但它**存在库里** ⇒ 外部
// （SQL 手改、半份备份恢复、改过格式的旧版本）可以写进任意字符串，而它是投递路径的
// 唯一游标。三类形态各有独立的坏后果，且都在真 PG 上实测复现过：
//
//   - **形态非法**（`2026-99`）：`GenerateMonthlyReportForPeriod` 解析失败，而修前那
//     一行的失败是**整轮中止**（`return ok, failed, err`）⇒ 一条坏行让**全部订阅**停投，
//     且每轮都停在同一条上 ⇒ 不自愈（实测：健康订阅连续 5 轮 0 笔、从未被尝试）。
//   - **未来期号**（形态合法但晚于当前应投期）：修前被当成合法期号**真的投出去**一份
//     未来月的空报表，随后 `nextPendingAfterDelivery` 对"比当前应投期新"的期号一律
//     清空游标 ⇒ 真正欠投的那几期被永久跳过。
//   - **形态合法但早于该订阅可追认的最早期号**（`0001-01`，R23-V3-B1）：只判上界的修法
//     放它过去 ⇒ 每轮投出一份公元 1 年的空报表、`nextPendingAfterDelivery` 把游标推进
//     一格（0001-01 → 0001-02 → …）⇒ 真正欠投的期号被**饿死**，而且 `last_error`
//     全程为空（与形态非法档相反：这一档既不 fail-closed、也不留痕）。同一格里
//     `0000-01` 更坏一层：PG 表示不了公元 0 年 ⇒ 聚合 SQL 报 **22008** ⇒ 走的是
//     "生成失败"路径并**设了退避**（与形态非法档"不设退避、改好即自愈"的承诺相反，
//     人工改回合法值后要等自己设下的退避窗口）。
//
// ## 三类输入的处置为什么不同（可用信息不同，不是随意选择）
//
//   - 形态非法 / 早于下界 / 超出可表示区间 ⇒ 连"欠投到哪一期"都算不出来 ⇒
//     **本轮不投**（fail-closed）+ 记原因，等人工修库；**不设退避**，修好后下一轮自动恢复。
//   - 未来期号 ⇒ 欠投期仍可算（正常路径给出的 `CurrentPeriod`），只是那一格游标不可信
//     ⇒ **忽略它**继续补投（丢掉的是"外部写坏的那一格"，不是欠投期）。
//
// 严格性与 `parseBeijingPeriod` 逐字一致：`2026-6` / `2026-13` / `2026-02 ` / `2026-02-01`
// 全部落 `pendingMalformed`（首尾空白**不** Trim —— 期号是定长零填充的标签，容忍空白
// 就等于容忍"同一个月有两种字符串表示"）。
//
// 判定顺序（**顺序本身就是语义**）：形态 → 可表示区间（结构性的，与订阅无关）→
// 逐行下界（依赖 `created_at`）→ 上界（未来期号）。把区间判定放在下界之前，
// 是为了让 `0000-01` 无论 `created_at` 是什么都得到同一条"数据模型表示不了"的原因。
func classifyPendingPeriod(now, createdAt time.Time, pending string) (pendingPeriodClass, string) {
	if pending == "" {
		return pendingTrusted, ""
	}
	if _, err := parseBeijingPeriod(pending); err != nil {
		return pendingMalformed, clipDiagnostic(fmt.Sprintf(
			"pending_period 形态非法（want YYYY-MM）: %q —— 已 fail-closed 拒绝按它生成报表；"+
				"人工修好该列后下一轮自动恢复（无需重启）", pending))
	}
	if pending < earliestReportPeriod {
		return pendingUnreachable, clipDiagnostic(fmt.Sprintf(
			"pending_period %q 早于 %q（PostgreSQL 没有公元 0 年）⇒ 已 fail-closed 不投；"+
				"改回可表示的期号或清空该列后下一轮自愈", pending, earliestReportPeriod))
	}
	if floor := pendingPeriodFloor(createdAt); periodBeforeFloor(pending, floor) {
		return pendingUnreachable, clipDiagnostic(fmt.Sprintf(
			"pending_period %q 早于本订阅可追认的最早期号 %q（= 创建月的前一期）⇒ 已 fail-closed 不投；"+
				"改回 ≥ %q 或清空该列后下一轮自愈", pending, floor, floor))
	}
	if cur := CurrentPeriod(now); pending > cur {
		return pendingFuture, clipDiagnostic(fmt.Sprintf(
			"pending_period 是未来期号（%q 晚于当前应投期 %q）—— 视为不可信输入并忽略该游标，"+
				"本轮改走正常路径补投 %q", pending, cur, cur))
	}
	return pendingTrusted, ""
}

// clipDiagnostic 把诊断文案裁到 **190 字节以内**（< `serverstore.SanitizeReportError`
// 的 200 字节截断线），且**只按 rune 边界裁**。
//
// 为什么必须有上界（R22-V3-B1 的收尾细节）：文案里回显的 `pending_period` 是**外部
// 可控的任意字符串**，而 `SanitizeReportError` 超长时做的是 `msg[:200]` —— 直接切字节
// 会切断多字节字符，PG 的 text 列会以 `invalid byte sequence for encoding "UTF8"`
// **拒绝整条 UPDATE** ⇒ 该落库的诊断原因静默丢失（只剩日志）。裁到 190 字节以内还保证
// `SanitizeReportError` 原样返回它，于是"重复值只写一次"的去重比较是逐字节可判的。
func clipDiagnostic(s string) string {
	const maxBytes = 190
	if len(s) <= maxBytes {
		return s
	}
	cut := 0
	for i := range s { // range string 按 rune 边界给下标
		if i > maxBytes-3 { // 留出省略号的 3 字节
			break
		}
		cut = i
	}
	return s[:cut] + "…"
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
//
// ⚠️ `period >= CurrentPeriod(now)` 这条"清空游标"的分支只对**已经合法投出的**期号成立。
// 外部写进来的**未来期号**根本不是"投出的期号"，它现在在 `SubscriptionDuePeriod` /
// `classifyPendingPeriod` 那一层就被拦掉（不生成、不投递）⇒ 不会再出现"投出一份未来
// 空报表再把游标清空、欠投期永久跳过"的形态（R22-V3-B2，复审 2026-09-26）。
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
