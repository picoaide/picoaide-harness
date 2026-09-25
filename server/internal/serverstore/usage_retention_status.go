package serverstore

// 保留清理的**可观测面**（R8-A-3，审计 2026-09-24，P2）。
//
// 缺陷形态：多级布局下的深层后代分区**永不回收**（R7-A 的取舍：DETACH 只对 usage
// 的直接子分区有效，服务端不替管理员拆分区树），而这件事在此之前**只有一行日志**
// —— `/readyz` 零命中、没有任何 metric、管理端只显示"retention_months 已配置"。
// 于是"保留策略在这个月其实没有生效"与"一切正常"在运维面上逐字同形。
//
// 形态与本仓既有的同类出口一致（`serverstore.AuditWriteStats` / `AuditChainStatus`
// 由装配层读进 admin server-info；`cmd/server/scheduler_status.go` 的调度器状态表）：
// **子系统自己记账，装配层只读，不推断**。读数是过程事实（跑了几轮、清了几条、
// 哪几条没回收、为什么），不是从日志里猜。
//
// 出口：`cmd/server` 把它并入 `/readyz` 的 `usage_retention` 字段（R8-A-3 要求的
// 可判定计数面），并在每轮的 `usage retention: round summary …` 日志里带
// `skip_reasons=…`。

import (
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// 未回收原因（skip_reasons 的**封闭取值**，日志与 /readyz 共用同一份字面量）。
//
// 新增一类"没有回收"的关系时必须在这里加一个取值，并回答"谁在推进它"：
//   - descendant：多级布局的深层后代 —— 人工（拆分区树/等子树拆走）；
//   - subtree-retained：子树里还有保留期内的行 —— **自动**，等子树内最后一个
//     到期月被回收后本轮自然继续；
//   - detached-non-leaf：DETACH 之后留下的父表/带子关系 —— 人工；
//   - non-table：视图/物化视图/序列/外部表等非表对象占名 —— 人工；
//   - lock-timeout / statement-timeout（R10-A-03）：这一轮的某一处**等锁/语句**
//     超时 ⇒ 整事务回滚、一行数据没动、下一轮自动重试 —— **自动**。
//     与上面几类的区别是它**不是失败**：管理端保存保留期不得因此 500、
//     `/readyz` 的 failed_rounds 也不得把它记成故障（判据是 SQLSTATE
//     55P03/57014，见 usageFailureTimeoutReason）。
//   - settle-budget-timeout（R10-H3 · W3-1）：结算段/预补账的**整段总预算**
//     （ctx deadline，含 COMMIT）到点。它是"每语句上界挡不住多语句相加"那一层
//     上界，错误形态**不是 SQLSTATE**（`context deadline exceeded`，或 database/sql
//     在 ctx 到点后把后续语句拒成的 `sql: transaction has already been committed
//     or rolled back`）⇒ R10-G3 新增它时漏了分类，于是"预算不够"被记成真失败
//     （管理端保存保留期 500 + failed_rounds 增长，且预算不会自愈 ⇒ 每轮都失败）。
//     它与上面两类**同属"有界延后"**：一行数据没动、下一轮重试；单独给一个取值是
//     因为处置不同 —— 这一类的动作是"调大预算/减少该月行数"，不是"查谁占着锁"。
const (
	usageSkipDescendant          = "descendant"
	usageSkipSubtreeRetained     = "subtree-retained"
	usageSkipDetachedNonLeaf     = "detached-non-leaf"
	usageSkipNonTable            = "non-table"
	usageSkipLockTimeout         = "lock-timeout"
	usageSkipStatementTimeout    = "statement-timeout"
	usageSkipSettleBudgetTimeout = "settle-budget-timeout"
	// usageSkipOrphanRetained：名为 usage_<YYYYMM> 的关系**不在 usage 树里**、而名字的那
	// 个月**仍在保留期内**（R9-D R9D-07）。保留期内不能删它的明细，所以它不进回收面 ——
	// 但它占着当月分区名，写入路径要么把它领回去（自愈）、要么该月写入永久失败。
	// 旧实现直接 `continue`（零计数），于是"有一条关系在挡着当月写入"与"没有可回收的
	// 关系"在 skip_reasons 上逐字同形。谁在推进它：写路径（adopt 自愈）+ 人工。
	usageSkipOrphanRetained = "orphan-retained"
	// usageSkipFoldMisbounded：**相邻月并入失败**（R6-A-1 §1.5-B 的错界形态，R12-N2
	// P1-04）。语义：该月关系按**名义月**到期、但它的声明边界与名义北京月错位（典型是
	// 管理员按 UTC 自然月建的整段分区），于是"把边界外的那些行并入相邻月分区"这一步
	// 必然失败（PG 禁止分区区间重叠 ⇒ 目标窗口要么已被同名错界关系占着、要么覆盖不全）。
	//
	// 本类**不回收、也不 DROP**（DROP 会让相邻月的明细段永久少计），但：
	//   - 补账照做（窗口已扩到相邻月整月）⇒ **金额不丢**（R12-A 的 W1b 探针实测逐月守恒）；
	//   - 明细一行未删 ⇒ 这一条**不是**"本轮失败"，而是"需人工处置的形态"。
	//
	// 谁在推进它：人工（PG 禁止重叠 ⇒ 只有人能改边界/搬行；服务端不替管理员拆改分区树）。
	usageSkipFoldMisbounded = "fold-misbounded"
)

// usageReclaimBlockedFailed 是"真停摆账"里**真失败**那一类的原因字面量（不是 skip
// 取值：失败关系只出现在 FailedRelations 里，见 noteFailure）。
const usageReclaimBlockedFailed = "failed"

// usageSkipNeedsManual 报告某个 skip 原因是不是"服务端**按设计**不做、只能人工处置"
// 的一类（R12-N2 P1-01 的分类判据）。
//
// 为什么必须显式分类：`reclaim_stalled` 的立项语义是"保留策略**停摆**了吗"，
// 而下面这些形态**永远不会**被自动回收，却完全正常 —— 旧实现把它们当成"未回收月"，
// 于是宽/嵌套/多级布局（本项目**显式支持**的形态）的部署会**长期**挂着
// `reclaim_stalled=true`（R12-A P1-01 实测两轮同形）⇒ 真正的停摆被假阳性淹没。
// 它们的可观测面是 `skipped_by_reason` 与 `needs_manual_months`（各自点名），
// **不是**停摆位。
func usageSkipNeedsManual(reason string) bool {
	switch reason {
	case usageSkipDescendant, usageSkipSubtreeRetained, usageSkipDetachedNonLeaf,
		usageSkipNonTable, usageSkipOrphanRetained, usageSkipFoldMisbounded:
		return true
	}
	return false
}

// usageSkipIsDeferral 报告某个 skip 原因是不是"本轮**有界延后**、下一轮自动重试"
// 的一类（R10-A-03 / R10-H3 的三类超时）。
func usageSkipIsDeferral(reason string) bool {
	switch reason {
	case usageSkipLockTimeout, usageSkipStatementTimeout, usageSkipSettleBudgetTimeout:
		return true
	}
	return false
}

// usageRetentionUnreclaimedMax 是状态里保留的"未回收关系清单"长度上限：
// 计数是精确的（SkippedByReason），清单只是给人看的抽样（有界，避免无界增长）。
const usageRetentionUnreclaimedMax = 20

// usageRetentionDeferredStallRounds 是"同一关系**连续**多少轮被延后 ⇒ 升级为
// 可见告警"的阈值（R10-G3 · N2②）。
//
// 为什么必须存在：复审 N2 的实测 —— 20s 的"每语句"预算被补账吃到 94%，一旦超时
// 就被分类成"延后"，于是**每一轮都超时、该月永远不回收**，而
// `failed_rounds=0 / last_error=""`，从任何观测面都看不出来（磁盘按经过的月份
// 单调增长）。延后本身是对的（一次锁竞争不该变成管理端 500），但"延后"必须
// **有界**：同一关系连续若干轮还在延后，它已经不是一次竞争，而是停摆。
//
// 取 5 的理由：
//   - 调度间隔是 6h（internal/usageretention.DefaultTick）⇒ 5 个**计入 streak 的**
//     轮次 ≈ 24 小时（**首轮即计入**：`prevAt.IsZero()` ⇒ counts=true，所以第 5 个
//     调度轮次落在 t≈24h，30h 是"第 6 轮"的位置 —— R11-D-06 的注释口径勘误）。
//     任何"读事务/VACUUM/管理员 DDL"都不可能自然持续这么久；反过来 1~2 轮
//     （6~12h）完全可能是正常的运维窗口，提前告警就是噪音。
//   - 它也刻意大于复审判据（`TestV2B_DeferralLiveness` 3 轮）的视野：那条判据
//     编码的契约是"3 轮锁竞争都不得进失败面"，本阈值不改变那个契约。
//
// **计入 streak 的轮次 = 调度轮次（R10-H3 · W3-4；R11A-05 收口）**：管理端保存
// 保留期会**同步**多跑一轮（internal/llmgateway/admin.go 的
// `CleanupUsageRetention`），启动补跑也走同一个函数，连点几次保存就是几轮 ——
// 若按"调用次数"计数，分钟级就能把 streak 推到 5 ⇒ `deferred_stalled=true` 是
// **假告警**（与"≈24h 的真实停摆"不是一回事）。阈值语义因此收在**调度节奏**上：
// 只有距上一次计入的轮次 ≥ `usageRetentionSchedulerPeriodGap` 的轮次才推进计数
// （见 advanceDeferredStreaks）。
//
// 另一条**跨重启**的判据（R11-D-03）走**另一个字段** `reclaim_stalled`：最早未回收月
// 已经到期 ≥ usageReclaimStallAfter —— 它由 catalog 事实推导，不依赖进程内累积
// （判据在 usageReclaimDueSince 上）。两者不合并的理由见 UsageRetentionStatus.ReclaimStalled。
const usageRetentionDeferredStallRounds = 5

// usageRetentionSchedulerPeriod 是保留策略**周期执行者**的调度间隔
// （= internal/usageretention.DefaultTick）。
//
// 这里必须有一份值，因为 `advanceDeferredStreaks` 的"这一轮是不是调度轮次"判据
// 只能从**可观测的节奏**推：`internal/serverstore` 不能 import
// `internal/usageretention`（后者依赖前者，会成环），而服务端唯一的周期执行者
// 就是那个调度器（6h）。两份值的一致性由本包的门禁用例
// （audit_r11_i4 的 TestR11I4SchedulerPeriodMatchesUsageretentionTick，读对方源码）
// 钉住 —— 改任何一侧而不同步就会红。
const usageRetentionSchedulerPeriod = 6 * time.Hour

// usageRetentionSchedulerPeriodGap 是两次**计入 streak** 的轮次之间的最小间隔：
// 取调度周期本身。
//
// R11A-05（P3）的修法：旧判据是"间隔 ≥ 1h"，而 1h 只是"比连点保存的分钟级节奏
// 大"，并不能把**非调度轮次**排除掉 —— 实测 6 次相隔 65min 的启动/管理端轮次
// （累计墙钟 5.4h，远小于文档承诺的 ≈30h）就把 `deferred_stalled` 置真，读数
// 因此取决于"谁在调用清理"。
//
// 取 6h（= 调度周期）之后，判据变成**节奏 + 来源的双判据**：
//
//	6h 调度轮    —— 每轮间隔 ≥ 6h ⇒ 每轮都计入（阈值 5 轮 ≈ 24h 不变）；
//	管理端连点   —— 分钟级（或任何 < 6h 的间隔）⇒ 只把新关系记到 1，不推进；
//	启动/管理端夹在调度轮之间 —— 同理不推进；真正"调度器死了"时，那个夹进来的
//	                             轮次距离上一个计入轮次必然 ≥ 6h ⇒ 照样推进
//	                             （方向是"该报就报"，不会因为改了节奏而漏报停摆）。
const usageRetentionSchedulerPeriodGap = usageRetentionSchedulerPeriod

// usageReclaimStallAfter 是"某个到期月**应被回收**之后经过多久算停摆"的阈值
// （R11-D-03）。
//
// 为什么需要它：`deferred_stalled` 原来只由**进程内**累积的 streak 决定
// （`usageRetentionStatusVal` 是包级单例，无任何持久化）⇒ 任何重启节奏快于
// ≈24h 的部署（每次发版、容器重启、OOM 重启）都**永远看不到**
// `deferred_stalled=true`，而"磁盘按经过的月份单调增长"这件事就没有跨重启的
// 观测面了。
//
// 现在的判据是**可持久事实推导 + 分类**（R12-N2 P1-01 收口）：月 M 变成"应被回收"
// 的时刻是确定的（`BeijingDayInstant(M + retentionMonths + 1)`，见
// usageReclaimDueSince），所以"它已经到期多久还没被回收"是一个纯函数 —— 重启后
// 第一轮就能算出来。取 24h（= 5 个 6h 调度轮次）保持与 streak 阈值同量级。
//
// R12-N2 的**两条收口**（第十一轮版把"月龄"直接当成了"停摆时长"）：
//  1. 判据只作用在**真受阻**的月上（真失败 / 有界延后），**按设计**的跳过形态
//     （见 usageSkipNeedsManual）一律不进这个面 —— 它们各自有 skip_reasons 与
//     needs_manual_months 两个观测面；
//  2. "月龄 ≥ 24h"只对**真失败**类成立（失败是"这一轮真的做不成"的硬事实，且它是
//     R11-D-03 要的跨重启面）；**延后**类改用轮数判据
//     （usageReclaimStallRounds，同一关系连续 ≥4 个**调度轮次**），因为一次 5s 的
//     锁竞争也会让"月龄"远超 24h ⇒ 旧实现下一轮自愈的抖动也会告警（R12-A P1-01 ①）。
const usageReclaimStallAfter = 24 * time.Hour

// usageReclaimStallRounds 是**延后类**（lock/statement/settle-budget 超时）的轮数阈值
// （R12-N2 P1-01）。取 `usageReclaimStallAfter / usageRetentionSchedulerPeriod` = 4 个
// 调度轮次（6h/轮 ⇒ 约 24h），与上面那个时长阈值同一量级：
//
//	单次锁竞争      —— 1 个轮次被延后 ⇒ 1 < 4 ⇒ **不置真**（这是 P1-01 ① 的抖动）；
//	非调度轮次      —— 不计入（与 advanceDeferredStreaks 同一条节奏闸门，W3-4）；
//	真的持续停摆    —— 每个调度轮次都还在延后 ⇒ 4 轮后置真。
//
// 为什么不用"月龄"给延后类兜底：到期月的月龄天然就远超 24h（`due_since` 是保留期的
// 纯函数），拿它当判据等于"只要有一轮被延后就算停摆"。
const usageReclaimStallRounds = int64(usageReclaimStallAfter / usageRetentionSchedulerPeriod)

// usageRetentionRound 是一轮清理的过程事实（由 CleanupUsageRetention 填写）。
type usageRetentionRound struct {
	// EndedAt 是本轮**结束**的时刻（由 CleanupUsageRetention 的 defer 在记账前写入）：
	// `last_round_at` 的语义是"最近一轮何时跑完"，与 rounds/failed_rounds 一起回答
	// "调度器还活着吗"（R9C-4：此前它记的是**开始**时刻而注释写"结束"）。
	EndedAt          time.Time
	ConfiguredMonths int
	// ConfiguredMonthsKnown 报告 ConfiguredMonths 是否**读到过**（R9D-05：把"还没跑过"
	// 与"保留期已关"分开）。
	ConfiguredMonthsKnown bool
	CutoffMonth           string
	Relations             int
	ClearedPartitions     int
	ClearedDetached       int
	Skipped               int
	Failures              int
	SkippedByReason       map[string]int
	Unreclaimed           []string
	FailedRelations       []string
	// R10-G3（N2②/N3）：本轮**按超时延后**的关系（去重）—— "连续延后"计数的唯一输入。
	// 没出现在这里、但本轮被处理过的关系（回收/保留/深后代/非表对象…）在
	// advanceDeferredStreaks 里自然清零（streak 每轮按本清单重建）。
	DeferredRelations []string
	// Scanned 报告本轮**真的跑过**关系枚举（保留期读到 + catalog 扫描成功）。
	// R10-H3（W3-3）：早退轮（保留期=0 / 读配置失败 / 扫描失败）在证据面上与
	// "枚举完了、什么都在保留期内"完全不同 —— 前者不能清零 streak，也不能前移
	// `oldest_unreclaimed_month`（"没观测" ≠ "已回收"）。
	Scanned bool
	// ExistingMonths 是**本轮结束时仍然存在**的月关系名（YYYYMM，去重、升序）：
	// = 本轮 catalog 枚举到的集合 − 本轮真的删掉的那些（扫描发生在轮首，而只有
	// 回收会删除关系 ⇒ 折算不需要第二次扫描）。
	//
	// R11A-04（P2）：它是"写入面残留条目是否已经解决"的**唯一事实来源** ——
	// `usage_<YYYYMM>` 不在这个集合里 ⟺ 该月的分区关系此刻不存在 ⟺ 当初那条
	// "该月写不进去"的观测所描述的对象已经没了（被回收/被人工删除）。
	ExistingMonths []string
}

// UsageRetentionStatus 是保留清理的**过程事实**快照（JSON 进 /readyz）。
//
// 字段语义（每条都回答一个运维问题）：
//
//	rounds / failed_rounds          这个进程到底跑过几轮、失败几轮（"调度器死了"
//	                                与"跑了但没东西可清"必须能分开）
//	last_round_at / last_error      最近一轮何时结束、以什么错误结束
//	configured_months / cutoff_month 生效的保留期与它推出的清理边界
//	cleared_partitions/detached     本轮真正回收的关系数
//	skipped / skipped_by_reason     本轮**没有**回收的关系数与原因（R8-A-3 的核心：
//	                                深后代永不回收从此是可判定的计数；R10-A-03 起
//	                                "等锁/语句超时 ⇒ 本轮延后"也在这里，**不计失败**）
//	unreclaimed                     未回收的关系名（有界抽样，带原因）
//	failures / failed_relations     真失败的关系数与关系名（R10-A-05：关系名也要进
//	                                机器可读面，此前只出现在 last_error 的自由文本里）
type UsageRetentionStatus struct {
	ConfiguredMonths int   `json:"configured_months"`
	RoundNumber      int64 `json:"rounds"`
	FailedRounds     int64 `json:"failed_rounds"`
	// LastRoundAt 是最近一轮**结束**的时刻（R9C-4：此前实现记的是开始时刻）。
	LastRoundAt       string `json:"last_round_at,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	CutoffMonth       string `json:"cutoff_month,omitempty"`
	Relations         int    `json:"relations"`
	ClearedPartitions int    `json:"cleared_partitions"`
	ClearedDetached   int    `json:"cleared_detached"`
	Skipped           int    `json:"skipped"`
	Failures          int    `json:"failures"`
	// FailedRelations 是**真失败**的关系名（有界抽样，与 Unreclaimed 同形）。
	// R10-A-05（P3）：此前失败关系只出现在 LastError 的自由文本里，而机器可读面
	// （unreclaimed）只收 skipped ⇒ "哪条关系失败了"在读面上不可判定。
	FailedRelations []string `json:"failed_relations,omitempty"`
	// FailedRelationsTruncated 报告失败关系清单是否被上限截断（Failures 仍是全量）。
	FailedRelationsTruncated bool `json:"failed_relations_truncated,omitempty"`
	// SkippedByReason 是"本轮没有回收"的**按原因计数**（精确，不受清单上限影响）。
	SkippedByReason map[string]int `json:"skipped_by_reason,omitempty"`
	// Unreclaimed 是未回收的关系名 + 原因（`usage_202607(descendant)`），有界。
	Unreclaimed []string `json:"unreclaimed,omitempty"`
	// UnreclaimedTruncated 报告清单是否被上限截断（计数仍是全量）。
	UnreclaimedTruncated bool `json:"unreclaimed_truncated,omitempty"`
	// ConfiguredMonthsKnown 报告 ConfiguredMonths 是**观测值**还是**零值**（R9-D R9D-05）。
	//
	// configured_months 在本域里"0 = 永不删除"，而进程跑过第一轮之前它也是 0 —— 同一个
	// 字段承载"还没跑过"与"保留期已关"两种语义，只有 rounds=0 一个旁证。判据必须能
	// 区分这两件事，所以显式给出"这个 0 是观测"这一位。
	ConfiguredMonthsKnown bool `json:"configured_months_known"`

	// ---- 活性面（R10-G3 · N2②/N3）：保留策略到底有没有在推进 ----
	//
	// 缺陷形态（复审 N3 实测）：3 轮 × 6 关系全部 lock-timeout 延后，`cleared_*=0`，
	// 而 `failed_rounds=0 / last_error=""`；唯一的痕迹是**每轮被覆写**的
	// `skipped_by_reason` —— 它回答"这一轮为什么没回收"，回答不了"同一条关系已经
	// 连续多少轮没被回收"。于是"保留策略已经停摆"与"刚好有锁竞争"在运维面上同形。
	//
	// 现在有三个累积量（读数由子系统自己记账，装配层只读）：
	//
	//	deferred_streak        关系名 → **连续**被延后的轮数（本轮被正常处理即清零）
	//	max_deferred_streak    上面那个 map 的最大值（告警规则可以直接用它）
	//	deferred_relations     本轮被延后的关系名（与 skipped_by_reason 的计数同源）
	//	last_deferred_at       最近一次出现延后的时刻
	//	deferred_stalled       **是否有关系连续 ≥ usageRetentionDeferredStallRounds 轮延后**
	//	                       —— 这是唯一需要进告警规则的那一位
	//	stalled_relations      连续延后达阈值的关系名（有界抽样）
	//	deferred_stalled_rounds 累计"出现过停摆关系"的**轮数**（计数，不因清零而回退）
	//	oldest_unreclaimed_*   **最早未回收的到期月**（单调，见下）
	//
	// 消费口径（运维脚本/告警规则）：
	//
	//	deferred_stalled == true  ⇒ 保留策略**已经停摆**：某条到期关系连续
	//	                            ≥5 个**调度轮次**（6h/轮 ≈ 30h；管理端保存保留期
	//	                            触发的即时轮次不计入，见 W3-4）既没被回收也没
	//	                            失败，必须人工看（stalled_relations 点名；
	//	                            write_blocked_* 说明是不是"当月写不进去"那一类）。
	//	deferred_stalled_rounds > 0 且持续增长 ⇒ 停摆**轮数**在累积（同一次停摆持续
	//	                            N 轮即计 N —— 它不是"发生了几次"这个事件计数，
	//	                            W3-5）；即使当前 deferred_stalled 已因关系被回收
	//	                            而清零，它也不会回退。
	//	oldest_unreclaimed_month  ⇒ **长期没回收**的权威判据（W3-3）：最早那个"本轮
	//	                            枚举到、但既没回收也没失败之外"的到期月（YYYYMM），
	//	                            外加它被首次观测到的时刻与已持续轮数。它**单调**：
	//	                            早退轮/无证据轮不动它，单轮失败也不动它，只有该月
	//	                            真的被回收（或不再落在回收面内）才前移 ⇒ 告警规则
	//	                            与"改保留期"、"超时/失败交替"这些单轮动作无关。
	//	failed_rounds（真失败面，与上一条互补）不得用来做这条判断：按 R10-A-03 的
	//	                            契约，锁竞争/超时**不进**失败面。
	//
	// 为什么"停摆"不把整轮变成失败（即不让 CleanupUsageRetention 返回非 nil）：
	// 管理端保存保留期是**同步**调用它（llmgateway/admin.go），一次锁竞争就回
	// 500「保留清理失败」正是 R10-A-03 修掉的缺陷（配置其实已提交并已审计）。
	// 停摆是 **liveness** 事实而不是"本轮失败"，所以它走**专门的**入口：这两个字段
	// + 每次升级时的一行 `usage retention: STALLED …` 日志（可 grep、可告警）。
	DeferredStreak        map[string]int `json:"deferred_streak,omitempty"`
	MaxDeferredStreak     int            `json:"max_deferred_streak,omitempty"`
	DeferredRelations     []string       `json:"deferred_relations,omitempty"`
	LastDeferredAt        string         `json:"last_deferred_at,omitempty"`
	DeferredStalled       bool           `json:"deferred_stalled,omitempty"`
	StalledRelations      []string       `json:"stalled_relations,omitempty"`
	DeferredStalledRounds int64          `json:"deferred_stalled_rounds,omitempty"`
	// OldestUnreclaimedMonth 是"最早未回收的到期月"（YYYYMM，单调；R10-H3 · W3-3）。
	OldestUnreclaimedMonth  string `json:"oldest_unreclaimed_month,omitempty"`
	OldestUnreclaimedReason string `json:"oldest_unreclaimed_reason,omitempty"`
	OldestUnreclaimedSince  string `json:"oldest_unreclaimed_since,omitempty"`
	OldestUnreclaimedRounds int64  `json:"oldest_unreclaimed_rounds,omitempty"`
	// OldestUnreclaimedDueSince / OldestUnreclaimedAgeSeconds 是**跨重启可判**的那
	// 一半（R11-D-03）：该月从哪一刻起"应该"已经被回收（纯函数，由保留期推导，
	// 见 usageReclaimDueSince），以及到本轮结束为止它已经逾期多久。
	//
	// 为什么必须另给这两个字段：`deferred_streak` / `deferred_stalled_rounds` /
	// `oldest_unreclaimed_since|_rounds` 全是**进程内**累积（包级单例、无持久化）
	// ⇒ 重启即归零，任何重启节奏快于 ≈24h 的部署永远看不到"永久不回收"告警。
	// 这两位的判据是 catalog 事实 + 保留期设置，重启后第一轮就有值。
	OldestUnreclaimedDueSince   string `json:"oldest_unreclaimed_due_since,omitempty"`
	OldestUnreclaimedAgeSeconds int64  `json:"oldest_unreclaimed_age_seconds,omitempty"`
	// ReclaimStalled 是**跨重启可判**的那一位（R11-D-03，R12-N2 P1-01 收口语义）：
	// "保留策略**真的停摆**了吗"。
	//
	// R12-N2 的语义收口 —— 它**只**反映真受阻（下面的 reclaim_blocked_* 面），
	// 即"该回收但没回收成功，且不是因为按设计跳过、也不是单次锁竞争"：
	//
	//	① 真失败类：某个**已到期**的月本轮进了 failed_relations，且它的月龄
	//	   （reclaim_blocked_age_seconds，保留期的纯函数）≥ usageReclaimStallAfter
	//	   ⇒ 重启后第一轮就能成立（R11-D-03 的性质原样保留）；
	//	② 有界延后类：同一个已到期的月**连续 ≥ usageReclaimStallRounds 个调度轮次**
	//	   都只被延后 ⇒ 单次 5s 锁竞争（1 轮，下一轮自愈）**不可能**置真。
	//
	// **按设计跳过**的形态（descendant / subtree-retained / non-table /
	// detached-non-leaf / orphan-retained / fold-misbounded）不进这个判据 ⇒ 宽/嵌套/
	// 多级布局与错界分区不会长期挂着告警位；它们的可读面是 `skipped_by_reason`
	// 与 `needs_manual_months`。
	//
	// `oldest_unreclaimed_*` 与它**刻意不同口径**：那四个字段回答"最早那个没被回收的
	// 月是什么、持续多久"（**含**按设计跳过与保留期内被点名的形态），是给人看的
	// 现状清单；本字段回答"保留策略停摆了吗"，判据面只有真受阻的月。两者的差集
	// 就是"按设计不回收/需人工处置"的那一批（见 needs_manual_months）。
	//
	// 为什么**不**并进 `deferred_stalled`：`deferred_stalled` 的既有语义（第十轮
	// W3-4 的契约，由 `TestR10G2DeferralIsBoundedAndVisible` 钉住）是"**同一关系
	// 连续 ≥5 个调度轮次**被延后"，与它并列的还有"连点保存不得造成假告警"这条
	// 断言；把"逾期时长"OR 进去会让那一轮的分钟级连点在**月份本就逾期**的夹具上
	// 读成 true（实测：`max_deferred_streak=1` 而 `deferred_stalled=true`）。
	// 两位都是"保留策略有没有在推进"，运维口径 = `deferred_stalled || reclaim_stalled`，
	// 差别只在于**谁不依赖进程内累积**：`reclaim_stalled` 的①在重启后的第一轮就成立。
	ReclaimStalled bool `json:"reclaim_stalled,omitempty"`

	// ---- 真停摆账（R12-N2 P1-01）：把"按设计跳过"与"真受阻"分开记 ----
	//
	// 判据与危害同构：`reclaim_stalled` 要回答的是"保留策略停摆了吗"，所以它只能
	// 看**真受阻**的月 —— 下面五个字段就是那个面（最早的真受阻月 + 它的原因/轮数/
	// 逾期时长）。按设计跳过的形态**不进**这里（见 usageSkipNeedsManual），
	// 它们进 needs_manual_months。
	//
	//	reclaim_blocked_month        最早那个"已到期、该回收、但被真失败或超时挡住"的月
	//	                             （YYYYMM）；空 = 没有真受阻的月
	//	reclaim_blocked_reason       封闭取值：failed / lock-timeout / statement-timeout
	//	                             / settle-budget-timeout
	//	reclaim_blocked_rounds       它**连续**受阻的轮数（延后类 = 连续调度轮次；
	//	                             失败类 = 本进程内连续观测到的轮数，重启归零）
	//	reclaim_blocked_due_since    它"应被回收"的时刻（保留期纯函数，跨重启可判）
	//	reclaim_blocked_age_seconds  到本轮结束为止它已逾期多久（纯函数推导）
	ReclaimBlockedMonth      string `json:"reclaim_blocked_month,omitempty"`
	ReclaimBlockedReason     string `json:"reclaim_blocked_reason,omitempty"`
	ReclaimBlockedRounds     int64  `json:"reclaim_blocked_rounds,omitempty"`
	ReclaimBlockedDueSince   string `json:"reclaim_blocked_due_since,omitempty"`
	ReclaimBlockedAgeSeconds int64  `json:"reclaim_blocked_age_seconds,omitempty"`

	// ReclaimBlockedMonths 是**本轮全部**真受阻月（YYYYMM，升序、去重）。
	//
	// 为什么必须有这一面（R13-GE · V2-1 的残留缺口）：上面那五个字段只报**最早**
	// 那个受阻月，于是"更晚的一个月已经连续失败 5 轮、更早的一个月刚被第一次延后"
	// 这种序列里，真失败会被更早月的一次新延后从读数面（与停摆位）上顶掉 ——
	// A4 实测 `true→false`。停摆位现在按"**任一**受阻月达标"判定（见下方
	// usageReclaimStalledFor），而这一面把被顶掉的那些月也如实列出来：
	// 谁在场、各自连续受阻几轮，全部可见。
	ReclaimBlockedMonths []string `json:"reclaim_blocked_months,omitempty"`

	// ---- 写路径建分区 DDL 的等待账（R12-N2 P2-01）----
	//
	// 为什么必须有一面：月初第一次计量写入要建当月分区，而 `CREATE TABLE …
	// PARTITION OF usage` 需要 `usage` 的 ACCESS EXCLUSIVE —— 它与清理轮次的
	// 预补账/结算事务（读 `usage` 取**隐式** ACCESS SHARE、持到 COMMIT，提交期
	// 不受 statement_timeout 约束）相撞时，用户请求会同步等待整段（真 PG 实测
	// 5.18s/6s 注入，对照 15ms）。这条等待此前**没有任何可观测面**。
	//
	//	write_ddl_lock_waits            累计"命中等锁"次数（一次写入可能要退避重试多次）
	//	write_ddl_lock_wait_ms_max      单次写入**整段**等待的最大毫秒数（含退避重试）
	//	write_ddl_lock_budget_exhausted 总预算耗尽 ⇒ 该月写入被 fail-closed 拒掉的次数
	//
	// 判据与危害同构：这三个数非零 = "写路径真的被清理轮次挡过"，读法与
	// `write_blocked_*` 不同（后者是"布局挡住写入"，这里是"锁等待"）。
	WriteDDLLockWaits           int64 `json:"write_ddl_lock_waits,omitempty"`
	WriteDDLLockWaitMSMax       int64 `json:"write_ddl_lock_wait_ms_max,omitempty"`
	WriteDDLLockBudgetExhausted int64 `json:"write_ddl_lock_budget_exhausted,omitempty"`

	// NeedsManualMonths 是"**本轮**按设计没有回收、需要人工处置"的月关系
	// （`usage_<YYYYMM>(原因)`，有界、升序；原因见 usageSkipNeedsManual）。
	//
	// 为什么单列：按设计跳过的形态**不会**自己消失（多级布局的深层后代、
	// 错界分区的相邻月并入失败、被非表对象占名…），而它们各自的"谁在推进"
	// 是人。旧实现里这一批要么只出现在每轮被覆写的 skipped_by_reason 计数里
	// （答不了"是哪个月"），要么（R12-N2 P1-04 之前）被记成"整轮失败"⇒ 管理端
	// 每轮 500 + reclaim_stalled 永久为真。现在它们有一个**长期、可 grep、带关系名**
	// 的读数面：只要形态还在，每轮都会在这里点名。
	NeedsManualMonths []string `json:"needs_manual_months,omitempty"`
	NeedsManualCount  int      `json:"needs_manual_count,omitempty"`

	// deferredStreakAt 是"上一次**计入** streak 的轮次"的结束时刻（W3-4 的节奏判据，
	// 不进 JSON：它是内部账，对外只有 deferred_streak 的读数）。
	deferredStreakAt time.Time
	// oldestUnreclaimedAt 是"最早未回收月"首次被观测到的时刻（单调，见上）。
	oldestUnreclaimedAt time.Time
	// reclaimBlocked 是"真停摆账"的进程内部分（R12-N2 P1-01；不进 JSON，对外读数
	// 是 reclaim_blocked_* 五个字段）。**读数是"最早那个"**（最逾期者，给人看的
	// 现状清单），而停摆位按**全部**受阻月判定。
	reclaimBlocked usageReclaimBlocked
	// reclaimBlockedRounds 是"**每个**真受阻月各自连续受阻的轮数"（R13-GE · V2-1）。
	//
	// 单值账（reclaimBlocked.Rounds）只能记住**一个**月的连续性，于是"更晚月持续
	// 真失败"会被"更早月刚被延后"顶掉（A4 实测 true→false：真失败被掩盖）。这里
	// 按**月**记（而不是按关系名）—— 同一个月可能对应多个关系形态（孤儿表/分区），
	// 而停摆语义的单位是"月该不该被回收"。
	reclaimBlockedRounds map[string]int64

	// ---- 写入面（R9-D R9D-00，P0）：当月到底能不能落账 ----
	//
	// 缺陷形态：`ALTER TABLE usage DETACH PARTITION usage_<YYYY>` 之后，子树里仍在保留
	// 期内的同名孤儿让每一次计量写入失败 ⇒ 网关对**每一次对话**回 503 METERING_FAILED
	// （fail-closed，不交付），而清理三轮 err=nil/skipped=0、`/readyz` 的 usage_retention
	// 全绿 ⇒ 从任何观测面都看不出全站对话已经不可用。
	//
	// 判据必须与危害同构：**"这一笔计量落不了账"本身必须是一条可读的状态**。字段由写
	// 路径记账（serverstore.noteUsagePartitionWriteFailure / …OK），装配层只读、不推断。
	//
	//	write_blocked         当月（北京月）至少有一次计量写入被分区布局挡住 ——
	//	                      用户面后果 = 该月每一次对话 503 METERING_FAILED；
	//	write_blocked_month   被挡住的月份（YYYYMM）；
	//	write_blocked_kind    封闭取值，见 partitions.go 的 usagePartitionKind*；
	//	write_blocked_error   最近一次的原始错误（含人工处置文案）；
	//	write_blocked_action  **可执行的**运维动作（与错误文案同源，只有一份实现）；
	//	write_blocked_since   第一次失败的时刻；write_blocked_count 失败次数。
	WriteBlocked       bool   `json:"write_blocked"`
	WriteBlockedMonth  string `json:"write_blocked_month,omitempty"`
	WriteBlockedKind   string `json:"write_blocked_kind,omitempty"`
	WriteBlockedError  string `json:"write_blocked_error,omitempty"`
	WriteBlockedAction string `json:"write_blocked_action,omitempty"`
	WriteBlockedSince  string `json:"write_blocked_since,omitempty"`
	WriteBlockedCount  int64  `json:"write_blocked_count,omitempty"`
	// WriteBlockedOtherMonths 是**非当月**的布局型写失败（R10-H3 · W3-2）：
	//   - 触发面：回收一个到期月时 `[DETACH 提交, DROP 提交]` 那段窗口里，对该月
	//     （或任何迟到写入的月份）的 `ensureUsagePartition` 会以 `*partitionLayoutError`
	//     失败。**当月永不落在回收面里**（写路径的 created_at=now），所以这一整类
	//     事实既不在 `write_blocked_*`（只放行当月）里，也不在 `write_error_*`
	//     （那是未分类的瞬时失败）里 ⇒ 旧实现下 `/readyz` 全绿（W3-2 实测）。
	//   - 消费口径：非空 ⇒ 有**具体某个月**的分区布局挡住了写入，`relation` 就是
	//     该月的分区名；`count` 累计次数、`since` 首次发生时刻。月份升序、有界
	//     （上限见 usageRetentionUnreclaimedMax），总数在 WriteBlockedOtherCount。
	//   - 该月下一次成功写入清掉它自己那一条；当月面（write_blocked_*）的语义与
	//     告警口径**不因它改变**。
	WriteBlockedOtherMonths []UsageWriteBlockOtherMonth `json:"write_blocked_other_months,omitempty"`
	WriteBlockedOtherCount  int                         `json:"write_blocked_other_count,omitempty"`

	// ---- 写入面（非分区布局的瞬时失败）----
	//
	// R10-A-06（P3）：`write_blocked_*` 的文档语义是"当月计量写入被**分区布局**
	// 挡住"（用户面后果 = 每一次对话 503，且处置动作是分区 DDL）。而
	// noteUsagePartitionWriteFailure 对**任何** ensureUsagePartition 失败都置位，
	// 包括未分类的瞬时错误（连接/探测/DDL 失败，kind="other"）—— 语义漂移：
	// 运维会拿着 write_blocked_action 去核对一个可能完全正确的分区树，而
	// write_blocked_action 在 other 上本来就是空串。
	//
	// 现在按**判据面**分流：只有 partitionLayoutError 家族（有封闭 kind）进
	// write_blocked_*；未分类的瞬时失败单列 write_error_*（同样可读，但不冒充
	// "布局阻塞"，也没有分区动作）。两者都由一次成功写入清除。
	WriteError        bool   `json:"write_error,omitempty"`
	WriteErrorMonth   string `json:"write_error_month,omitempty"`
	WriteErrorMessage string `json:"write_error_message,omitempty"`
	WriteErrorSince   string `json:"write_error_since,omitempty"`
	WriteErrorCount   int64  `json:"write_error_count,omitempty"`
	// WriteErrorOtherMonths 是**非当月**的未分类瞬时写失败（与 W3-2 同因同形：
	// 单槽实现下"别的月份出错"在 `/readyz` 上不可见，且会把当月的状态顶掉）。
	WriteErrorOtherMonths []UsageWriteBlockOtherMonth `json:"write_error_other_months,omitempty"`
	WriteErrorOtherCount  int                         `json:"write_error_other_count,omitempty"`
}

var (
	usageRetentionStatusMu  sync.Mutex
	usageRetentionStatusVal UsageRetentionStatus
)

// recordUsageRetentionRound 记下一轮清理的过程事实（CleanupUsageRetention 的
// 唯一记账点；失败/早退也要记 —— "没跑"与"跑了没事"必须能分开）。
func recordUsageRetentionRound(round usageRetentionRound, roundErr error) {
	usageRetentionStatusMu.Lock()
	defer usageRetentionStatusMu.Unlock()
	st := usageRetentionStatusVal
	// R9D-05 / R9C-4：configured_months 的 0 在本域里等于"永不删除"，而**失败轮次**
	// （读不到生效保留期）此前也会把它写成 0 ⇒ 监视器读到与事实相反的结论。
	// 判据：只有本轮**真的观测到**（EffectiveRetentionMonths 成功返回）才覆盖这两个
	// 字段；观测不到时保留上一次的观测值，本轮失败由 failed_rounds / last_error 表达。
	if round.ConfiguredMonthsKnown {
		st.ConfiguredMonths = round.ConfiguredMonths
		st.ConfiguredMonthsKnown = true
		// 保留期关掉（0 = 永不删除）时 cutoff 本来就不存在 ⇒ 显式清空是对的。
		st.CutoffMonth = round.CutoffMonth
	}
	st.RoundNumber++
	st.Relations = round.Relations
	st.ClearedPartitions = round.ClearedPartitions
	st.ClearedDetached = round.ClearedDetached
	st.Skipped = round.Skipped
	st.Failures = round.Failures
	st.SkippedByReason = nil
	if len(round.SkippedByReason) > 0 {
		st.SkippedByReason = make(map[string]int, len(round.SkippedByReason))
		for k, v := range round.SkippedByReason {
			st.SkippedByReason[k] = v
		}
	}
	st.Unreclaimed = nil
	st.UnreclaimedTruncated = false
	if n := len(round.Unreclaimed); n > 0 {
		limit := n
		if limit > usageRetentionUnreclaimedMax {
			limit = usageRetentionUnreclaimedMax
			st.UnreclaimedTruncated = true
		}
		st.Unreclaimed = append([]string(nil), round.Unreclaimed[:limit]...)
	}
	// R10-A-05：失败关系用同一套有界抽样口径（计数 Failures 仍是全量）。
	st.FailedRelations = nil
	st.FailedRelationsTruncated = false
	if n := len(round.FailedRelations); n > 0 {
		limit := n
		if limit > usageRetentionUnreclaimedMax {
			limit = usageRetentionUnreclaimedMax
			st.FailedRelationsTruncated = true
		}
		st.FailedRelations = append([]string(nil), round.FailedRelations[:limit]...)
	}
	if !round.EndedAt.IsZero() {
		st.LastRoundAt = round.EndedAt.UTC().Format(time.RFC3339)
	}
	// R10-G3（N2②/N3）：推进/清零"连续延后"计数，并在达阈值时升级为可见告警。
	// R10-H3（W3-3/W3-4）：只认**有证据**的轮次（早退轮不清零），且只有距上一次
	// 计入 ≥ usageRetentionSchedulerPeriodGap 的轮次才推进（管理端连点保存不计入）。
	var deferredCounts bool
	st.DeferredStreak, st.MaxDeferredStreak, st.StalledRelations, st.deferredStreakAt, deferredCounts =
		advanceDeferredStreaks(st.DeferredStreak, st.deferredStreakAt, round)
	// R10-H3（W3-3）：**最早未回收的到期月** —— 单调面，"长期没回收"的权威判据。
	oldest := advanceOldestUnreclaimed(usageOldestUnreclaimed{
		Month:  st.OldestUnreclaimedMonth,
		Reason: st.OldestUnreclaimedReason,
		Since:  st.oldestUnreclaimedAt,
		Rounds: st.OldestUnreclaimedRounds,
	}, round)
	st.OldestUnreclaimedMonth, st.OldestUnreclaimedReason, st.OldestUnreclaimedRounds = oldest.Month, oldest.Reason, oldest.Rounds
	st.oldestUnreclaimedAt = oldest.Since
	st.OldestUnreclaimedSince = ""
	if !oldest.Since.IsZero() {
		st.OldestUnreclaimedSince = oldest.Since.UTC().Format(time.RFC3339)
	}
	st.DeferredRelations = append([]string(nil), round.DeferredRelations...)
	if len(round.DeferredRelations) > 0 && !round.EndedAt.IsZero() {
		st.LastDeferredAt = round.EndedAt.UTC().Format(time.RFC3339)
	}
	// R11-D-03（P2）：**跨重启可判**的停摆判据。
	//
	// streak 是进程内累积的（包级单例、无持久化）⇒ 重启后归零，任何重启节奏快于
	// ≈24h 的部署永远看不到 deferred_stalled。这里补一条**由 catalog 事实推导**的
	// 判据：oldest_unreclaimed_month 变成"应被回收"的时刻是确定的纯函数
	// （usageReclaimDueSince），所以"它已经到期多久还没被回收"重启后第一轮就能算。
	st.OldestUnreclaimedDueSince, st.OldestUnreclaimedAgeSeconds = "", 0
	if oldest.Month != "" && !round.EndedAt.IsZero() && round.ConfiguredMonthsKnown {
		if due, ok := usageReclaimDueSince(oldest.Month, round.ConfiguredMonths); ok {
			st.OldestUnreclaimedDueSince = due.UTC().Format(time.RFC3339)
			if age := round.EndedAt.Sub(due); age > 0 {
				st.OldestUnreclaimedAgeSeconds = int64(age / time.Second)
			}
		}
	}
	// R12-N2（P1-01）：**真停摆账** —— 只有"该回收但没回收成功、且不是因为按设计跳过"
	// 的月才进这个面（判据见 UsageRetentionStatus.ReclaimStalled 的注释）。
	blocked := advanceReclaimBlocked(st.reclaimBlocked, round, st.DeferredStreak, deferredCounts)
	st.reclaimBlocked = blocked
	// R13-GE（V2-1）：停摆位的判据面是**全部**受阻月（不是"最早那一条"）。
	blockedAll := usageReclaimBlockedAllInRound(round)
	st.reclaimBlockedRounds = advanceReclaimBlockedRounds(st.reclaimBlockedRounds, round, st.DeferredStreak, deferredCounts)
	st.ReclaimBlockedMonths = nil
	for _, b := range blockedAll {
		st.ReclaimBlockedMonths = append(st.ReclaimBlockedMonths, b.Month)
	}
	st.ReclaimBlockedMonth, st.ReclaimBlockedReason, st.ReclaimBlockedRounds = blocked.Month, blocked.Reason, blocked.Rounds
	st.ReclaimBlockedDueSince, st.ReclaimBlockedAgeSeconds = "", 0
	if blocked.Month != "" && !round.EndedAt.IsZero() && round.ConfiguredMonthsKnown {
		if due, ok := usageReclaimDueSince(blocked.Month, round.ConfiguredMonths); ok {
			st.ReclaimBlockedDueSince = due.UTC().Format(time.RFC3339)
			// 月龄的**唯一实现**（停摆判据 per-month 也用它，见 usageReclaimMonthAge），
			// 避免"读数一个口径、判据另一个口径"。
			if age, ok := usageReclaimMonthAge(blocked.Month, round); ok {
				st.ReclaimBlockedAgeSeconds = age
			}
		}
	}
	switch {
	case !round.Scanned || len(blockedAll) == 0:
		st.ReclaimStalled = false
	default:
		// R13-GE（V2-1）：**任一**受阻月达标即置位（旧实现只看最早那一条 ⇒ 更晚月的
		// 持续真失败会被更早月的一次新延后抹掉，A4 实测 true→false）。
		st.ReclaimStalled = usageReclaimStalledFor(blockedAll, st.reclaimBlockedRounds,
			func(m string) (int64, bool) { return usageReclaimMonthAge(m, round) })
	}
	// 按设计跳过、需人工处置的形态（R12-N2 P1-04 的错界分区并入失败等）：单列一面，
	// **不进**上面的停摆判据（它们永远不会自动消失，进停摆位就是长期假告警）。
	st.NeedsManualMonths, st.NeedsManualCount = needsManualMonthsInRound(round)
	if len(st.StalledRelations) > 0 {
		st.DeferredStalled = true
		st.DeferredStalledRounds++
		log.Printf("usage retention: STALLED %s —— 连续 ≥%d 轮被延后(每轮 6h)，既没被回收也没有真失败："+
			"这不是一次锁竞争，是保留策略停摆(N2:延后必须有界)。处置：核对 blocked/deferred 的原因"+
			"(skipped_by_reason=%s)与是否有长事务/管理员 DDL 长期占着 usage 或该月分区；"+
			"/readyz 的 usage_retention.deferred_stalled=true、stalled_relations 点名",
			strings.Join(st.StalledRelations, ","), usageRetentionDeferredStallRounds,
			formatRetentionSkipReasons(st.SkippedByReason))
	} else {
		st.DeferredStalled = false
	}
	if st.ReclaimStalled {
		// 与 streak 面**互相独立**（各自的字段都在 /readyz 上）；两位都是"保留策略有
		// 没有在推进"，但这一位**只反映真受阻**（R12-N2 P1-01：按设计跳过的形态不进
		// 这个面），且失败类不依赖进程内累积 ⇒ 重启后第一轮就成立。
		log.Printf("usage retention: STALLED(reclaim) %s 应回收时刻=%s 已逾期 %d 秒仍未被回收"+
			"(reason=%s rounds=%d；失败类阈值 %s / 延后类阈值 %d 个调度轮次)。"+
			"configured_months=%d；/readyz 的 usage_retention.reclaim_stalled=true、"+
			"reclaim_blocked_month/reason/rounds 点名",
			blocked.Month, st.ReclaimBlockedDueSince, st.ReclaimBlockedAgeSeconds,
			blocked.Reason, blocked.Rounds, usageReclaimStallAfter, usageReclaimStallRounds,
			st.ConfiguredMonths)
	}
	if st.NeedsManualCount > 0 {
		// 长期可观测（R12-N2 P1-04）：按设计不回收、需人工处置的月关系 —— 每轮点名，
		// 直到形态被人修掉。它**不是**停摆（服务端按设计不动手），所以不进
		// reclaim_stalled。
		log.Printf("usage retention: %d relation(s) need manual action (按设计不自动回收): %s"+
			"；处置见 skipped_by_reason 与各条 SKIP 日志的 reason=",
			st.NeedsManualCount, strings.Join(st.NeedsManualMonths, ","))
	}
	if round.Scanned {
		// R11A-04（P2）：把"已经解决"的非当月写入面条目收敛掉（见
		// clearResolvedUsageWriteState）。只在**有证据轮**做 —— 扫描失败的轮次
		// 没有"关系是否还在"的事实，不做任何猜测。
		clearResolvedUsageWriteState(&usageWriteBlockVal, round)
		clearResolvedUsageWriteState(&usageWriteErrorVal, round)
	}
	if roundErr != nil {
		st.FailedRounds++
		st.LastError = roundErr.Error()
	} else {
		st.LastError = ""
	}
	usageRetentionStatusVal = st
}

// usageReclaimDueSince 给出"月 <key>（YYYYMM）从哪一刻起**应该**已经被回收"
// （R11-D-03/R11A-05 的推导基准）。
//
// 保留 N 个月 = 删 created_at 早于 `BeijingMonth(now) - N` 的分区（见
// CleanupUsageRetention），所以月 M 到期 ⟺ `BeijingMonth(now) - N > M`
// ⟺ `BeijingMonth(now) ≥ M + N + 1` ⟺ `now ≥ 北京时 M+N+1 月 1 日 00:00`。
// 该时刻与进程状态无关 ⇒ 重启后照样能算，"长期没回收"因此有了跨重启的判据。
func usageReclaimDueSince(key string, retentionMonths int) (time.Time, bool) {
	if retentionMonths <= 0 {
		// 保留期=0 表示"永不删除"，不存在"应被回收"的时刻。
		return time.Time{}, false
	}
	m, err := time.Parse("200601", key)
	if err != nil {
		return time.Time{}, false
	}
	return BeijingDayInstant(dayKey(m).AddDate(0, retentionMonths+1, 0)), true
}

// advanceDeferredStreaks 按本轮的过程事实推进"同一关系连续被延后"的计数（R10-G3；
// R10-H3 修正了两条重置/推进路径）。
//
// 语义（判据与危害同构：**保留策略有没有在推进**）：
//
//	① 无证据轮（`!round.Scanned`：保留期=0 早退 / 读配置失败 / catalog 扫描失败）
//	   **一律不动** —— 旧实现按"本轮延后清单"重建 map，早退轮的空清单把 streak 清零，
//	   于是"两轮延后 + 一轮早退"永远到不了阈值（W3-3 ① 实测 `2 → 0`）。
//	② 有证据轮：streak 按"本轮被延后（lock-timeout / statement-timeout /
//	   settle-budget-timeout）的关系"**重建**；本轮枚举到但没被延后的关系
//	   （回收掉 / 仍在保留期 / 深后代只补账 / 非表对象…）落回 0 —— "这一轮它被
//	   正常处理了"不是停摆。
//	③ 推进（+1）只在**跨调度轮次**时发生（W3-4）：距上一次计入的轮次
//	   ≥ usageRetentionSchedulerPeriodGap 才 +1；管理端保存保留期同步触发的
//	   即时轮次（分钟级）只把新关系记到 1，不会把 streak 推过阈值。
//
// 返回新的 streak、其中的最大值、达到阈值的关系名（升序，有界）、以及新的"上次
// 计入时刻"。关系名会随月份滚动而永久增加，而 streak 只含本轮的键 ⇒ 规模有界。
// 第四个返回值是**本轮是否计入**（节奏闸门，W3-4）：R12-N2 P1-01 的真停摆账要用
// 同一条闸门推进"真失败类"的连续轮数 —— 否则管理端连点保存也能把轮数推上去。
func advanceDeferredStreaks(prev map[string]int, prevAt time.Time, round usageRetentionRound) (map[string]int, int, []string, time.Time, bool) {
	if !round.Scanned {
		// 无证据轮：不加、不清、不推进（W3-3 ①）。
		return prev, maxDeferredStreak(prev), stalledRelations(prev), prevAt, false
	}
	// 节奏判据（W3-4）：首轮/距上次计入 ≥ 间隔 ⇒ 本轮计入。
	counts := prevAt.IsZero() || round.EndedAt.Sub(prevAt) >= usageRetentionSchedulerPeriodGap
	next := make(map[string]int, len(round.DeferredRelations))
	for _, rel := range round.DeferredRelations {
		n := prev[rel]
		if counts {
			n++
		}
		if n < 1 {
			// 新的延后关系：即使这一轮不计入，也要让它从 1 起算（否则读作"没延后"）。
			n = 1
		}
		next[rel] = n
	}
	if len(next) == 0 {
		next = nil
	}
	at := prevAt
	if counts && len(round.DeferredRelations) > 0 {
		at = round.EndedAt
	}
	return next, maxDeferredStreak(next), stalledRelations(next), at, counts
}

// usageOldestUnreclaimed 是"最早未回收的到期月"的内部账（对外四个 JSON 字段）。
type usageOldestUnreclaimed struct {
	Month  string // YYYYMM
	Reason string // 该月这一轮没被回收的原因（skip_reasons 的封闭取值，或 failed）
	Since  time.Time
	Rounds int64
}

// usageReclaimBlocked 是"真停摆账"的读数（R12-N2 P1-01）：**最早**那个"已到期、
// 该回收、但被真失败或有界延后挡住"的月，以及它连续受阻的轮数。
//
// 它**不含**按设计跳过的形态（`usageSkipNeedsManual`）—— 那些月永远不会被自动回收，
// 把它们算进"停摆"就是长期假告警（R12-A P1-01 ②）。它们各自的可读面在
// `skipped_by_reason` 与 `needs_manual_months`。
type usageReclaimBlocked struct {
	Month  string
	Reason string
	Rounds int64
	// Rel 是代表这一个月受阻的关系名（点名用；同月多形态时取真失败优先的那个）。
	Rel string
}

// usageMonthDueInRound 报告某个月（YYYYMM）在**本轮**是不是"应被回收"。
//
// 判据与回收主循环**同源**：`!m.Before(cutoffMonth)` 表示"保留期内（名字合法但没到期）"
// 被主循环跳过，所以"未回收"只有在 `month < cutoff_month` 时才是"该回收而没回收"。
// `CutoffMonth` 为空（未观测到保留期/保留期=0）时**一律不算到期** —— 宁可不告警，
// 也不能把"保留期内、按设计不动它"的月读成停摆（R12-A 实测的抖动来源之一）。
func usageMonthDueInRound(month string, round usageRetentionRound) bool {
	return month != "" && round.CutoffMonth != "" && month < round.CutoffMonth
}

// usageReclaimBlockedInRound 从本轮的过程事实里挑出**最早的真受阻月**：
//
//	① FailedRelations（真失败，`noteFailure` 的失败面，只在这里出现）；
//	② Unreclaimed 里原因为**有界延后**（lock/statement/settle-budget 超时）的那些；
//
// 按设计跳过的原因（usageSkipNeedsManual）与未知原因**都不进**（后者是"判据面之外
// 的取值"，不允许靠猜把它算成停摆）。三个返回值分别是月、原因、关系名。
func usageReclaimBlockedInRound(round usageRetentionRound) (month, reason, rel string, ok bool) {
	all := usageReclaimBlockedAllInRound(round)
	if len(all) == 0 {
		return "", "", "", false
	}
	// 读数 = 最早那个（最逾期者）；**判据**用全部（见 usageReclaimStalledFor）。
	first := all[0]
	return first.Month, first.Reason, first.Rel, true
}

// usageReclaimMonthAge 返回某个月（YYYYMM）到本轮结束为止"已经逾期多久"（秒）。
//
// 判据与危害同构：真失败类的停摆阈值是**月龄**（保留期的纯函数 ⇒ 重启后第一轮就成立，
// R11-D-03 的性质）。它是月龄的**唯一实现**：`reclaim_blocked_age_seconds` 这个读数与
// `usageReclaimStalledFor` 的逐月判定都必须经它，不允许两处各推一遍。
func usageReclaimMonthAge(month string, round usageRetentionRound) (int64, bool) {
	if month == "" || round.EndedAt.IsZero() || !round.ConfiguredMonthsKnown {
		return 0, false
	}
	due, ok := usageReclaimDueSince(month, round.ConfiguredMonths)
	if !ok {
		return 0, false
	}
	age := round.EndedAt.Sub(due)
	if age <= 0 {
		return 0, false
	}
	return int64(age / time.Second), true
}

// usageReclaimBlockedAllInRound 返回本轮**全部**真受阻月（按月份升序、按月去重）。
//
// R13-GE（V2-1）：单值读数只能承载一个月，而"保留策略停摆了吗"这个问题的判据面
// 是**所有**该回收却没回收成功的月。同一个月可能有多个关系形态受阻（孤儿表 + 分区），
// 取其中任意一个代表即可（原因/关系名用于点名，不参与阈值判定）。
func usageReclaimBlockedAllInRound(round usageRetentionRound) []usageReclaimBlocked {
	byMonth := map[string]usageReclaimBlocked{}
	consider := func(r, why string) {
		m, mok := retentionMonthOfRelation(r)
		if !mok || !usageMonthDueInRound(m, round) {
			return
		}
		if _, seen := byMonth[m]; seen {
			// 同月多形态：真失败优先于延后（失败是更严重、也更需要点名的形态）。
			if byMonth[m].Reason == usageReclaimBlockedFailed {
				return
			}
			if why != usageReclaimBlockedFailed {
				return
			}
		}
		byMonth[m] = usageReclaimBlocked{Month: m, Reason: why, Rel: r}
	}
	for _, item := range round.Unreclaimed {
		r, why := item, "skipped"
		if i := strings.IndexByte(item, '('); i > 0 && strings.HasSuffix(item, ")") {
			r, why = item[:i], item[i+1:len(item)-1]
		}
		if !usageSkipIsDeferral(why) {
			continue
		}
		consider(r, why)
	}
	for _, r := range round.FailedRelations {
		consider(r, usageReclaimBlockedFailed)
	}
	if len(byMonth) == 0 {
		return nil
	}
	out := make([]usageReclaimBlocked, 0, len(byMonth))
	for _, b := range byMonth {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Month < out[j].Month })
	return out
}

// advanceReclaimBlocked 推进真停摆账（R12-N2 P1-01）。
//
// 语义与 advanceOldestUnreclaimed 同形（单调、无证据轮不动），差别只有两点：
//
//	① 输入只是**真受阻**的月（按设计跳过的不进）；
//	② 轮数的算法按原因分流：
//	     真失败类 —— 本进程内"同一个月连续受阻"的轮数（走 counts 节奏闸门，
//	                 管理端连点保存不推进）；
//	     延后类   —— 直接取 `DeferredStreak[rel]`（它本来就只在**调度轮次**上推进，
//	                 所以单次 5s 锁竞争恒为 1、不可能达阈值）。
func advanceReclaimBlocked(prev usageReclaimBlocked, round usageRetentionRound, streak map[string]int, counts bool) usageReclaimBlocked {
	if !round.Scanned {
		return prev // 无证据轮：不动（"没观测" ≠ "已解除"）
	}
	month, reason, rel, ok := usageReclaimBlockedInRound(round)
	if !ok {
		return usageReclaimBlocked{}
	}
	if reason != usageReclaimBlockedFailed {
		n := int64(streak[rel])
		if n < 1 {
			n = 1 // 至少记 1 轮（与 advanceDeferredStreaks 的"新关系从 1 起算"同口径）
		}
		return usageReclaimBlocked{Month: month, Reason: reason, Rounds: n}
	}
	if prev.Month == month {
		p := prev
		p.Reason = reason
		if counts {
			p.Rounds++
		}
		return p
	}
	return usageReclaimBlocked{Month: month, Reason: reason, Rounds: 1}
}

// advanceReclaimBlockedRounds 按**月**推进"连续受阻轮数"（R13-GE · V2-1）。
//
// 语义与 advanceReclaimBlocked 同一份节奏口径（无证据轮不动、真失败类走 counts
// 闸门、延后类直接取 DeferredStreak[rel]），区别只有"记账单位"：这里**每个月各记一份**，
// 所以更晚月的持续失败不会被更早月的一次新延后抹掉。
//
// 本轮没被枚举到（或本轮被正常处理了）的月**直接从账上删掉** —— 与
// advanceDeferredStreaks 的"重建而非累积"同一口径："这一轮它被正常处理了"不是停摆。
func advanceReclaimBlockedRounds(prev map[string]int64, round usageRetentionRound,
	streak map[string]int, counts bool) map[string]int64 {
	if !round.Scanned {
		return prev // 无证据轮：不动（"没观测" ≠ "已解除"）
	}
	all := usageReclaimBlockedAllInRound(round)
	if len(all) == 0 {
		return nil
	}
	next := make(map[string]int64, len(all))
	for _, b := range all {
		if b.Reason == usageReclaimBlockedFailed {
			n := prev[b.Month]
			if counts {
				n++
			}
			if n < 1 {
				// 未计入过（首轮 / counts=false 的第一次观测）：至少记 1 轮，
				// 与 advanceReclaimBlocked 的"新关系从 1 起算"同口径。
				n = 1
			}
			next[b.Month] = n
			continue
		}
		n := int64(streak[b.Rel])
		if n < 1 {
			n = 1
		}
		next[b.Month] = n
	}
	return next
}

// usageReclaimStalledFor 是**停摆位**的唯一判据（R13-GE · V2-1）：
// "**任一**受阻月满足阈值" ⇒ 停摆。
//
// 为什么不能只看最早那个月（被审形态）：读数面（reclaim_blocked_month）取最早受阻月
// 是**对的**（最逾期者最该被点名），但把停摆位也绑在它身上就错了 —— A4 实测的序列
//
//	第 1..5 轮：202606 真失败（stalled=true）
//	第 6 轮    ：202604 第一次被延后（lock-timeout，rounds=1）
//
// 会让停摆位**翻回 false**，而 202606 的失败一轮都没停过。停摆是"保留策略有没有在
// 推进"，只要**还有**一个月卡在阈值之上，策略就没有在推进。
//
// 阈值按原因分流（与旧口径逐字一致，只把"取最早那条"换成"扫全部"）：
//
//	真失败类 —— 逾期时长 ≥ usageReclaimStallAfter（保留期纯函数，跨重启可判）；
//	延后类   —— 该月连续受阻轮数 ≥ usageReclaimStallRounds（单次锁竞争恒为 1 轮）。
func usageReclaimStalledFor(all []usageReclaimBlocked, rounds map[string]int64,
	monthAge func(string) (int64, bool)) bool {
	for _, b := range all {
		if b.Reason == usageReclaimBlockedFailed {
			if age, ok := monthAge(b.Month); ok &&
				time.Duration(age)*time.Second >= usageReclaimStallAfter {
				return true
			}
			continue
		}
		if rounds[b.Month] >= usageReclaimStallRounds {
			return true
		}
	}
	return false
}

// needsManualMonthsInRound 收集本轮"按设计不回收、需人工处置"的月关系
// （`usage_<YYYYMM>(原因)`，去重、升序、有界；R12-N2 P1-04 的长期观测面）。
func needsManualMonthsInRound(round usageRetentionRound) ([]string, int) {
	if !round.Scanned {
		return nil, 0
	}
	seen := map[string]string{}
	for _, item := range round.Unreclaimed {
		r, why := item, "skipped"
		if i := strings.IndexByte(item, '('); i > 0 && strings.HasSuffix(item, ")") {
			r, why = item[:i], item[i+1:len(item)-1]
		}
		if !usageSkipNeedsManual(why) {
			continue
		}
		if m, mok := retentionMonthOfRelation(r); mok {
			seen[m] = why
		}
	}
	if len(seen) == 0 {
		return nil, 0
	}
	out := make([]string, 0, len(seen))
	for m, why := range seen {
		out = append(out, m+"("+why+")")
	}
	sort.Strings(out)
	total := len(out)
	if total > usageRetentionUnreclaimedMax {
		out = out[:usageRetentionUnreclaimedMax]
	}
	return out, total
}

// advanceOldestUnreclaimed 推进**单调**的"最早未回收月"（R10-H3 · W3-3）。
//
// 为什么需要它：`deferred_stalled` 表达的是"连续 N 轮**都因超时**没回收"，而"长期
// 没回收"还有两条它覆盖不到的形态 —— 超时轮与**真失败轮**交替（失败轮也把这月的
// 行留在盘上，却不进 streak），以及"改保留期"造成的轮次重置。于是"长期没回收"
// 不蕴含"必达 5 轮阈值"。这个字段直接回答"**最早那个没被回收的到期月是什么、已经
// 持续多久**"，判据与危害同构，且它是**单调**的：
//
//	无证据轮（!Scanned）        —— 不动（"没观测" ≠ "已回收"）；
//	本轮枚举到的未回收集合非空  —— 取其中**最早**的月；比当前更早则前移，
//	                             与当前同月则轮数 +1，比当前更晚则说明更早那个月
//	                             已经不在扫描面里（已被回收）⇒ 前移并重置起点；
//	本轮枚举到的全都回收了      —— 清空（真的没有未回收月了）。
//
// 未回收集合 = 本轮 Unreclaimed（本轮没回收的关系，含超时延后/深后代/保留期内/
// 非表对象…）∪ FailedRelations（真失败）。两条都取"名字 −> 月"（`usage_<YYYYMM>`
// 或中间父表 `usage_<YYYY>` 视作该年 1 月起）。
func advanceOldestUnreclaimed(prev usageOldestUnreclaimed, round usageRetentionRound) usageOldestUnreclaimed {
	if !round.Scanned {
		return prev
	}
	month, reason, ok := oldestUnreclaimedInRound(round)
	if !ok {
		return usageOldestUnreclaimed{}
	}
	switch {
	case prev.Month == "":
		return usageOldestUnreclaimed{Month: month, Reason: reason, Since: round.EndedAt, Rounds: 1}
	case month < prev.Month:
		// 出现了更早的未回收月（多级布局/更早年月的分区被枚举到）⇒ 前移。
		return usageOldestUnreclaimed{Month: month, Reason: reason, Since: round.EndedAt, Rounds: 1}
	case month == prev.Month:
		p := prev
		p.Reason = reason
		p.Rounds++
		return p
	default:
		// 更早的那个月已经不在这轮的未回收集合里 ⇒ 它被回收了 ⇒ 单调前移。
		return usageOldestUnreclaimed{Month: month, Reason: reason, Since: round.EndedAt, Rounds: 1}
	}
}

// oldestUnreclaimedInRound 从本轮的过程事实里取"最早未回收的到期月"（升序取首个）。
func oldestUnreclaimedInRound(round usageRetentionRound) (month, reason string, ok bool) {
	consider := func(rel, why string) {
		m, mok := retentionMonthOfRelation(rel)
		if !mok {
			return
		}
		if !ok || m < month {
			month, reason, ok = m, why, true
		}
	}
	for _, item := range round.Unreclaimed {
		rel, why := item, "skipped"
		if i := strings.IndexByte(item, '('); i > 0 && strings.HasSuffix(item, ")") {
			rel, why = item[:i], item[i+1:len(item)-1]
		}
		consider(rel, why)
	}
	for _, rel := range round.FailedRelations {
		consider(rel, "failed")
	}
	return month, reason, ok
}

// retentionMonthOfRelation 把关系名折算成"它覆盖的最早北京月"（YYYYMM）：
//
//	usage_202606   ⇒ 202606（月分区）
//	usage_2026     ⇒ 202601（中间父表：它覆盖的最早月是 1 月）
//	其它名字       ⇒ ok=false（不进"最早未回收月"的判据面）
func retentionMonthOfRelation(rel string) (string, bool) {
	if m, ok := usageMonthRelationOf(rel); ok {
		return monthKey(m), true
	}
	const prefix = "usage_"
	if !strings.HasPrefix(rel, prefix) {
		return "", false
	}
	key := rel[len(prefix):]
	if len(key) != 4 {
		return "", false
	}
	for i := 0; i < len(key); i++ {
		if key[i] < '0' || key[i] > '9' {
			return "", false
		}
	}
	return key + "01", true
}

func maxDeferredStreak(streak map[string]int) int {
	max := 0
	for _, n := range streak {
		if n > max {
			max = n
		}
	}
	return max
}

// stalledRelations 返回连续延后达到阈值的关系名（升序、有界）。
func stalledRelations(streak map[string]int) []string {
	var out []string
	for rel, n := range streak {
		if n >= usageRetentionDeferredStallRounds {
			out = append(out, rel)
		}
	}
	sort.Strings(out)
	if len(out) > usageRetentionUnreclaimedMax {
		out = out[:usageRetentionUnreclaimedMax]
	}
	return out
}

// formatRetentionSkipReasons 把 skip_reasons 渲染成稳定的日志字段（key 升序）；
// 与 usage_ledger.go 的 formatSkipReasons 同形，但这里只有 map（状态文件的记账
// 路径不该为了打一行日志依赖清理主循环的局部变量）。
func formatRetentionSkipReasons(reasons map[string]int) string {
	if len(reasons) == 0 {
		return "{}"
	}
	keys := make([]string, 0, len(reasons))
	for k := range reasons {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%d", k, reasons[k]))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

// usageWriteBlockState 是"某个月的计量写入被挡住"的**进程内**过程事实
// （R9-D R9D-00）。子系统自己记账，装配层只读，不推断。
type usageWriteBlockState struct {
	Month  string // 被挡住的北京月（YYYYMM）
	Since  time.Time
	Kind   string
	Action string
	Err    string
	Count  int64
}

// usageWriteStateTable 是"月 → 状态"的**不可变**快照（写时复制）。热路径（成功
// 写入）只做一次 atomic load；记账路径（失败）复制一份再整表 publish。
//
// R10-H3（W3-2）：此前这里是一个**单槽**（`atomic.Pointer[usageWriteBlockState]`），
// 槽里只留"最近一次失败的月份" ⇒ 两个洞：
//   - 非当月的失败在 `/readyz` 上完全不可见（`write_blocked_*` 只放行当月）；
//     而"回收一个到期月"的 `[DETACH, DROP]` 窗口里，唯一能撞上的**恰恰是到期月**
//     （W3-2 实测 `write_blocked=false`）；
//   - 反过来，一次非当月的失败会把**当月**的状态顶掉 ⇒ 当月不可写也会读成绿。
//
// 现在按月份分槽，出口同时给出"当月"（既有字段语义逐字保留）与"其它月份"。
type usageWriteStateTable map[string]usageWriteBlockState

// usageWriteStateMonthsMax 是写入面保留的月份上限（有界，避免被长期部署的月份数
// 撑大；超出时优先淘汰既不是当月、也不是本次写入的那个最早条目）。
const usageWriteStateMonthsMax = 12

var usageWriteBlockVal atomic.Pointer[usageWriteStateTable]

// 写路径建分区 DDL 的等待账（R12-N2 P2-01）：三个 atomic 计数器，热路径零分配、
// 零锁（只有"真的等过锁"的那次写入才会写它们）。
var (
	usageDDLLockWaitsVal     atomic.Int64
	usageDDLLockWaitMSMaxVal atomic.Int64
	usageDDLLockBudgetVal    atomic.Int64
)

// noteUsagePartitionDDLContention 记一次"写路径建分区 DDL 被锁挡住"。
//
//	waited   —— 本次写入**整段**等了多久（从第一次尝试到成功/放弃）
//	timedOut —— 本次写入命中 lock_timeout 的次数（≥1）
//	exhausted—— 是否因总预算耗尽而失败（写入会被 fail-closed 拒掉）
func noteUsagePartitionDDLContention(waited time.Duration, timedOut int, exhausted bool) {
	usageDDLLockWaitsVal.Add(int64(timedOut))
	ms := waited.Milliseconds()
	for {
		cur := usageDDLLockWaitMSMaxVal.Load()
		if ms <= cur || usageDDLLockWaitMSMaxVal.CompareAndSwap(cur, ms) {
			break
		}
	}
	if exhausted {
		usageDDLLockBudgetVal.Add(1)
	}
	log.Printf("usage partition: 建分区 DDL 遭遇锁等待（R12-N2 P2-01）：等待=%s 命中 lock_timeout=%d 次"+
		"预算耗尽=%v。挡住它的是持 `usage` ACCESS SHARE/EXCLUSIVE 的长事务（清理轮的预补账/结算段，"+
		"或另一条建分区 DDL）；/readyz 的 usage_retention.write_ddl_lock_* 是这条事实的读数",
		waited.Round(time.Millisecond), timedOut, exhausted)
}

// usageWriteErrorVal 是"未分类的**瞬时**写入失败"（kind="other"）的进程内过程事实
// （R10-A-06）。与 usageWriteBlockVal 分开存放：判据面不同（分区布局 vs 瞬时错误），
// 处置动作也不同（DDL vs 重试/看日志），混在一个字段里就是语义漂移。
var usageWriteErrorVal atomic.Pointer[usageWriteStateTable]

// noteUsagePartitionWriteFailure 记下"这一笔计量没能落账"（写路径唯一记账点）。
//
// 热路径成本：只在**失败**时进入（失败本身已经要打日志/返回 503），成功路径只做一次
// atomic load（见 noteUsagePartitionWriteOK），不引入互斥。
//
// R10-A-06（P3）：只有 `*partitionLayoutError`（分区布局结构性阻塞，带封闭 kind 与
// 可执行 action）才置 `write_blocked_*`；其余错误（连接/探测/DDL 的瞬时失败）进
// `write_error_*`。判据是结构化的（errors.As 命中），不靠 kind 字符串比对。
func noteUsagePartitionWriteFailure(month time.Time, err error) {
	key := monthKey(BeijingMonth(month))
	var le *partitionLayoutError
	if !errors.As(err, &le) {
		kind, _, msg := partitionLayoutFailure(err)
		storeUsageWriteError(&usageWriteErrorVal, key, kind, msg)
		return
	}
	kind, action, msg := partitionLayoutFailure(err)
	storeWriteBlock(&usageWriteBlockVal, key, kind, action, msg)
}

// storeWriteBlock 按"同月累加、跨月各留一份"的语义写入一份写入面状态。
func storeWriteBlock(slot *atomic.Pointer[usageWriteStateTable], key, kind, action, msg string) {
	prev := slot.Load()
	next := make(usageWriteStateTable, usageWriteStateMonthsMax)
	if prev != nil {
		for k, v := range *prev {
			next[k] = v
		}
	}
	st := usageWriteBlockState{Month: key, Since: time.Now(), Kind: kind, Action: action, Err: msg, Count: 1}
	if old, ok := next[key]; ok {
		st.Since = old.Since
		st.Count = old.Count + 1
	}
	next[key] = st
	evictOldestWriteState(next, key)
	slot.Store(&next)
}

// evictOldestWriteState 把表压回上限：先淘汰"最早的那条"里**既不是当月、也不是
// 本次写入**的月份（当月是消费面最要紧的一位，任何情况下都留）。
func evictOldestWriteState(table usageWriteStateTable, keep string) {
	if len(table) <= usageWriteStateMonthsMax {
		return
	}
	current := monthKey(BeijingMonth(time.Now()))
	victim, victimSince := "", time.Time{}
	for k, v := range table {
		if k == keep || k == current {
			continue
		}
		if victim == "" || v.Since.Before(victimSince) {
			victim, victimSince = k, v.Since
		}
	}
	if victim != "" {
		delete(table, victim)
	}
}

// storeUsageWriteError 同上（write_error 面：无 action）。
func storeUsageWriteError(slot *atomic.Pointer[usageWriteStateTable], key, kind, msg string) {
	storeWriteBlock(slot, key, kind, "", msg)
}

// noteUsagePartitionWriteOK 在**成功**创建/确认某月分区后清掉该月的挡住状态。
//
// 只在"确实记过同一个月的失败"时才做 CompareAndSwap（热路径是一次 atomic load，
// 没有互斥、没有分配）。两个面一起清：一次成功写入同时证明"分区布局可用"与
// "刚才那次瞬时失败已过去"。**别的月份**的读数不受影响（各月独立。
// 这正是 W3-2 要的：当月恢复正常不得抹掉"到期月写不进去"这条事实，
// 反之亦然）。
func noteUsagePartitionWriteOK(month time.Time) {
	key := monthKey(BeijingMonth(month))
	clearUsageWriteState(&usageWriteBlockVal, key)
	clearUsageWriteState(&usageWriteErrorVal, key)
}

// clearResolvedUsageWriteState 在**一轮有证据的清理结束之后**收敛"已经解决"的
// 非当月写入面条目（R11A-04 · P2）。
//
// 缺陷形态（第十轮第三波 W3-2 引入）：`write_blocked_other_months` 的条目只在
// "**该月**下一次成功写入"时清除（noteUsagePartitionWriteOK），而回收窗口里被挡住的
// 恰恰是**到期月** —— 写路径永不写它（写路径只写当月），于是条目**永久残留**，
// 消费口径"非空 ⇒ 有某个月写不进去"变成**单向棘轮**：一次历史事件之后永远为真，
// 只能靠 12 个月滚动自然淘汰。/readyz 的"新出现即告警"用法因此失效。
//
// 收敛判据（事实，不是时间窗猜测）：条目描述的对象是 `usage_<YYYYMM>`；所以当
// **本轮 catalog 枚举里没有这个月的关系**时，这条观测已经不可能再成立
// （关系没了 = 写不进去这件事没有载体了）⇒ 删掉它。反过来说，关系仍在的条目
// **一律保留** —— 那正是"现在还有个月写不进去"的真实读数。
//
// 只用**有证据轮**（round.Scanned）调用：早退轮（扫描失败/保留期读到 0）没有
// "关系是否还在"的事实，不做任何猜测（与 advanceDeferredStreaks 的同一条纪律）。
// 写时复制 + CAS（与 clearUsageWriteState 同形），成功路径不加锁。
func clearResolvedUsageWriteState(slot *atomic.Pointer[usageWriteStateTable], round usageRetentionRound) {
	if len(round.ExistingMonths) == 0 {
		// 本轮一条月关系都没枚举到 ⇒ 所有非当月条目描述的对象都不在了。
		// （当月条目不在本面里 —— 它在 write_blocked 的当月槽上。）
		clearAllUsageWriteState(slot)
		return
	}
	exists := make(map[string]bool, len(round.ExistingMonths))
	for _, key := range round.ExistingMonths {
		exists[key] = true
	}
	for {
		prev := slot.Load()
		if prev == nil || len(*prev) == 0 {
			return
		}
		next := make(usageWriteStateTable, len(*prev))
		removed := false
		for k, v := range *prev {
			if exists[v.Month] {
				next[k] = v
				continue
			}
			removed = true
		}
		if !removed {
			return
		}
		var ptr *usageWriteStateTable
		if len(next) > 0 {
			ptr = &next
		}
		if slot.CompareAndSwap(prev, ptr) {
			return
		}
	}
}

// clearAllUsageWriteState 清空整张写入面状态表（写时复制 + CAS）。
func clearAllUsageWriteState(slot *atomic.Pointer[usageWriteStateTable]) {
	for {
		prev := slot.Load()
		if prev == nil || len(*prev) == 0 {
			return
		}
		if slot.CompareAndSwap(prev, nil) {
			return
		}
	}
}

// clearUsageWriteState 从表里删掉某个月（写时复制 + CAS 重试，成功路径不加锁）。
func clearUsageWriteState(slot *atomic.Pointer[usageWriteStateTable], key string) {
	for {
		prev := slot.Load()
		if prev == nil {
			return
		}
		if _, ok := (*prev)[key]; !ok {
			return
		}
		next := make(usageWriteStateTable, len(*prev))
		for k, v := range *prev {
			if k == key {
				continue
			}
			next[k] = v
		}
		var ptr *usageWriteStateTable
		if len(next) > 0 {
			ptr = &next
		}
		if slot.CompareAndSwap(prev, ptr) {
			return
		}
	}
}

// UsageWriteBlockOtherMonth 是 `/readyz` 的"**非当月**写入被阻塞/失败"的一条读数
// （R10-H3 · W3-2）。
//
// 为什么必须单独给出来：`write_blocked_*` 的语义是"**当月**计量写入被分区布局挡住"
// （用户面后果 = 该月每一次对话 503），这个语义必须保留；但"回收一个到期月"的
// `[DETACH, DROP]` 窗口里，能撞上布局阻塞的恰恰是**到期月**（当月永不落在回收面里）
// ⇒ 只报当月等于把三段式新造的那个中间态的写失败整片藏起来。
//
// 消费口径：`write_blocked_other_months[]` 非空 ⇒ **有别的月份**（relation = 该月的
// 分区名）写不进去；`count` 是累计次数、`since` 是首次发生的时刻。判据边界：
//   - 它**不**改变 `write_blocked`（当月面）的语义与告警口径；
//   - 月份是**布局型**失败（有封闭 kind 与可执行 action 时才进这一面）；
//     未分类的瞬时失败走 `write_error_other_months`（同形）；
//   - 该月下一次成功写入会清掉它自己的那一条（与当月面同源）。
type UsageWriteBlockOtherMonth struct {
	Month    string `json:"month"`
	Relation string `json:"relation"`
	Kind     string `json:"kind,omitempty"`
	Count    int64  `json:"count"`
	Since    string `json:"since,omitempty"`
}

// usageWriteBlockForReadyz 返回**当月**的写入阻塞状态（别的月份的历史阻塞不冒充当月）。
func usageWriteBlockForReadyz() *usageWriteBlockState {
	return usageWriteStateForReadyz(&usageWriteBlockVal, monthKey(BeijingMonth(time.Now())))
}

// usageWriteErrorForReadyz 返回**当月**的瞬时写入失败状态。
func usageWriteErrorForReadyz() *usageWriteBlockState {
	return usageWriteStateForReadyz(&usageWriteErrorVal, monthKey(BeijingMonth(time.Now())))
}

// usageWriteOtherMonthsForReadyz 返回**非当月**的写入面读数（升序、有界；W3-2）。
func usageWriteOtherMonthsForReadyz(slot *atomic.Pointer[usageWriteStateTable]) ([]UsageWriteBlockOtherMonth, int) {
	prev := slot.Load()
	if prev == nil || len(*prev) == 0 {
		return nil, 0
	}
	current := monthKey(BeijingMonth(time.Now()))
	out := make([]UsageWriteBlockOtherMonth, 0, len(*prev))
	for k, v := range *prev {
		if k == current {
			continue
		}
		rel := "usage_" + v.Month
		if v.Month == "" {
			rel = ""
		}
		out = append(out, UsageWriteBlockOtherMonth{
			Month: v.Month, Relation: rel, Kind: v.Kind, Count: v.Count,
			Since: formatUsageWriteSince(v.Since),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Month < out[j].Month })
	total := len(out)
	if total > usageRetentionUnreclaimedMax {
		out = out[:usageRetentionUnreclaimedMax]
	}
	return out, total
}

func formatUsageWriteSince(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// usageWriteStateForReadyz 取某个槽位里**指定月份**的状态（副本；没有则 nil）。
func usageWriteStateForReadyz(slot *atomic.Pointer[usageWriteStateTable], month string) *usageWriteBlockState {
	prev := slot.Load()
	if prev == nil {
		return nil
	}
	st, ok := (*prev)[month]
	if !ok {
		return nil
	}
	cp := st
	return &cp
}

// resetUsageWriteBlockForTest 清空写入面状态（仅测试；与 resetUsageRetentionStatusForTest
// 同一约定，由 NewTestDB 调用）。
func resetUsageWriteBlockForTest() {
	usageWriteBlockVal.Store(nil)
	usageWriteErrorVal.Store(nil)
}

// CurrentUsageRetentionStatus 返回保留清理的过程事实快照（进程内；未跑过清理时
// 为零值，**不伪造**"一切正常"的读数 —— `rounds=0` 本身就说明这个进程还没跑过
// 一轮）。
//
// 装配层（cmd/server）把它并入 `/readyz` 的 `usage_retention` 字段。
func CurrentUsageRetentionStatus() UsageRetentionStatus {
	usageRetentionStatusMu.Lock()
	defer usageRetentionStatusMu.Unlock()
	st := usageRetentionStatusVal
	if len(st.SkippedByReason) > 0 {
		cp := make(map[string]int, len(st.SkippedByReason))
		for k, v := range st.SkippedByReason {
			cp[k] = v
		}
		st.SkippedByReason = cp
	}
	st.Unreclaimed = append([]string(nil), st.Unreclaimed...)
	// 写入面（R9D-00）：与保留清理同一个出口 —— "当月不可写"必须是可读状态，
	// 不允许"该月写入永久 503 而所有健康面报绿"。
	if wb := usageWriteBlockForReadyz(); wb != nil {
		st.WriteBlocked = true
		st.WriteBlockedMonth = wb.Month
		st.WriteBlockedKind = wb.Kind
		st.WriteBlockedError = wb.Err
		st.WriteBlockedAction = wb.Action
		st.WriteBlockedCount = wb.Count
		if !wb.Since.IsZero() {
			st.WriteBlockedSince = wb.Since.UTC().Format(time.RFC3339)
		}
	}
	// W3-2：**非当月**的布局型写失败也要可读（到期月的 `[DETACH, DROP]` 窗口是
	// 唯一能撞上它的地方，而它恰恰不是当月）。
	st.WriteBlockedOtherMonths, st.WriteBlockedOtherCount = usageWriteOtherMonthsForReadyz(&usageWriteBlockVal)
	// 未分类的瞬时写入失败（R10-A-06）：单列一面，不冒充"分区布局阻塞"。
	if we := usageWriteErrorForReadyz(); we != nil {
		st.WriteError = true
		st.WriteErrorMonth = we.Month
		st.WriteErrorMessage = we.Err
		st.WriteErrorCount = we.Count
		if !we.Since.IsZero() {
			st.WriteErrorSince = we.Since.UTC().Format(time.RFC3339)
		}
	}
	st.WriteErrorOtherMonths, st.WriteErrorOtherCount = usageWriteOtherMonthsForReadyz(&usageWriteErrorVal)
	// R12-N2（P2-01）：写路径建分区 DDL 的锁等待账（"月初写入被挡住多久"的读数）。
	st.WriteDDLLockWaits = usageDDLLockWaitsVal.Load()
	st.WriteDDLLockWaitMSMax = usageDDLLockWaitMSMaxVal.Load()
	st.WriteDDLLockBudgetExhausted = usageDDLLockBudgetVal.Load()
	return st
}

// resetUsageRetentionStatusForTest 清空进程内状态（仅测试；形态与
// resetSharedLimitersForTest 等既有测试钩子一致）。
func resetUsageRetentionStatusForTest() {
	usageRetentionStatusMu.Lock()
	defer usageRetentionStatusMu.Unlock()
	usageRetentionStatusVal = UsageRetentionStatus{}
	resetUsageWriteBlockForTest()
	usageDDLLockWaitsVal.Store(0)
	usageDDLLockWaitMSMaxVal.Store(0)
	usageDDLLockBudgetVal.Store(0)
}
