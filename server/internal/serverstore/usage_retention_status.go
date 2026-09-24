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
)

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
//     轮次 ≈ 30 小时。任何"读事务/VACUUM/管理员 DDL"都不可能自然持续这么久；
//     反过来 1~2 轮（6~12h）完全可能是正常的运维窗口，提前告警就是噪音。
//   - 它也刻意大于复审判据（`TestV2B_DeferralLiveness` 3 轮）的视野：那条判据
//     编码的契约是"3 轮锁竞争都不得进失败面"，本阈值不改变那个契约。
//
// **计入 streak 的轮次 = 调度轮次（R10-H3 · W3-4）**：管理端保存保留期会**同步**
// 多跑一轮（internal/llmgateway/admin.go 的 `CleanupUsageRetention`），连点几次
// 保存就是几轮 —— 若按"调用次数"计数，分钟级就能把 streak 推到 5 ⇒
// `deferred_stalled=true` 是**假告警**（与"≈30h 的真实停摆"不是一回事）。
// 阈值语义因此收在**调度节奏**上：只有距上一次计入的轮次
// ≥ usageRetentionDeferredStreakMinGap 的轮次才推进计数（见 advanceDeferredStreaks）。
const usageRetentionDeferredStallRounds = 5

// usageRetentionDeferredStreakMinGap 是两次**计入 streak** 的轮次之间的最小间隔
// （R10-H3 · W3-4）。判据不是"谁调用了清理"（服务端唯一的周期执行者是 6h 的
// usageretention.Scheduler，但管理端保存、启动补跑都走同一个函数），而是**节奏**：
//
//	6h 调度轮    —— 每轮都 ≥ 1h ⇒ 每轮都计入（阈值 5 轮 ≈ 30h 的语义保持不变）；
//	管理端连点   —— 分钟级 ⇒ 同一关系最多把 streak 推到 1，够不到阈值；
//	启动/管理端夹在调度轮之间 —— 最多让一小段停顿晚一轮被发现（≤1h，可接受，
//	                             方向是**少报**而不是多报）。
//
// 取 1h：远小于调度周期（6h，不会漏掉真实的调度轮），又远大于"连点保存"的
// 分钟级节奏（不会把运维动作读成停摆）。真实停摆的时间判据另有一条**单调**的
// `oldest_unreclaimed_month`（见下），它不受本间隔影响。
const usageRetentionDeferredStreakMinGap = time.Hour

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

	// deferredStreakAt 是"上一次**计入** streak 的轮次"的结束时刻（W3-4 的节奏判据，
	// 不进 JSON：它是内部账，对外只有 deferred_streak 的读数）。
	deferredStreakAt time.Time
	// oldestUnreclaimedAt 是"最早未回收月"首次被观测到的时刻（单调，见上）。
	oldestUnreclaimedAt time.Time

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
	// 计入 ≥ usageRetentionDeferredStreakMinGap 的轮次才推进（管理端连点保存不计入）。
	st.DeferredStreak, st.MaxDeferredStreak, st.StalledRelations, st.deferredStreakAt =
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
	if roundErr != nil {
		st.FailedRounds++
		st.LastError = roundErr.Error()
	} else {
		st.LastError = ""
	}
	usageRetentionStatusVal = st
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
//	   ≥ usageRetentionDeferredStreakMinGap 才 +1；管理端保存保留期同步触发的
//	   即时轮次（分钟级）只把新关系记到 1，不会把 streak 推过阈值。
//
// 返回新的 streak、其中的最大值、达到阈值的关系名（升序，有界）、以及新的"上次
// 计入时刻"。关系名会随月份滚动而永久增加，而 streak 只含本轮的键 ⇒ 规模有界。
func advanceDeferredStreaks(prev map[string]int, prevAt time.Time, round usageRetentionRound) (map[string]int, int, []string, time.Time) {
	if !round.Scanned {
		// 无证据轮：不加、不清、不推进（W3-3 ①）。
		return prev, maxDeferredStreak(prev), stalledRelations(prev), prevAt
	}
	// 节奏判据（W3-4）：首轮/距上次计入 ≥ 间隔 ⇒ 本轮计入。
	counts := prevAt.IsZero() || round.EndedAt.Sub(prevAt) >= usageRetentionDeferredStreakMinGap
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
	return next, maxDeferredStreak(next), stalledRelations(next), at
}

// usageOldestUnreclaimed 是"最早未回收的到期月"的内部账（对外四个 JSON 字段）。
type usageOldestUnreclaimed struct {
	Month  string // YYYYMM
	Reason string // 该月这一轮没被回收的原因（skip_reasons 的封闭取值，或 failed）
	Since  time.Time
	Rounds int64
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
	return st
}

// resetUsageRetentionStatusForTest 清空进程内状态（仅测试；形态与
// resetSharedLimitersForTest 等既有测试钩子一致）。
func resetUsageRetentionStatusForTest() {
	usageRetentionStatusMu.Lock()
	defer usageRetentionStatusMu.Unlock()
	usageRetentionStatusVal = UsageRetentionStatus{}
	resetUsageWriteBlockForTest()
}
