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
const (
	usageSkipDescendant       = "descendant"
	usageSkipSubtreeRetained  = "subtree-retained"
	usageSkipDetachedNonLeaf  = "detached-non-leaf"
	usageSkipNonTable         = "non-table"
	usageSkipLockTimeout      = "lock-timeout"
	usageSkipStatementTimeout = "statement-timeout"
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
//   - 调度间隔是 6h（internal/usageretention.DefaultTick）⇒ 5 轮 ≈ 30 小时。
//     任何"读事务/VACUUM/管理员 DDL"都不可能自然持续这么久；反过来 1~2 轮
//     （6~12h）完全可能是正常的运维窗口，提前告警就是噪音。
//   - 管理端保存保留期会**额外**同步触发一轮（llmgateway/admin.go）⇒ 短时间内
//     可以连跑好几轮，阈值太小会让"连点几次保存"就升级成告警。
//   - 它也刻意大于复审判据（`TestV2B_DeferralLiveness` 3 轮）的视野：那条判据
//     编码的契约是"3 轮锁竞争都不得进失败面"，本阈值不改变那个契约。
const usageRetentionDeferredStallRounds = 5

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
	// 现在有两个累积量（读数由子系统自己记账，装配层只读）：
	//
	//	deferred_streak        关系名 → **连续**被延后的轮数（本轮被正常处理即清零）
	//	max_deferred_streak    上面那个 map 的最大值（告警规则可以直接用它）
	//	deferred_relations     本轮被延后的关系名（与 skipped_by_reason 的计数同源）
	//	last_deferred_at       最近一次出现延后的时刻
	//	deferred_stalled       **是否有关系连续 ≥ usageRetentionDeferredStallRounds 轮延后**
	//	                       —— 这是唯一需要进告警规则的那一位
	//	stalled_relations      连续延后达阈值的关系名（有界抽样）
	//	deferred_stalled_rounds 累计"出现过停摆关系"的轮数（计数，不因清零而回退）
	//
	// 消费口径（运维脚本/告警规则）：
	//
	//	deferred_stalled == true  ⇒ 保留策略**已经停摆**：某条到期关系连续
	//	                            ≥5 轮（6h/轮）既没被回收也没失败，必须人工看
	//	                            （stalled_relations 点名；write_blocked_* 说明
	//	                            是不是"当月写不进去"那一类）。
	//	deferred_stalled_rounds > 0 且持续增长 ⇒ 停摆在反复发生（即使当前这一轮
	//	                            deferred_stalled 已因关系被回收而清零）。
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
	st.DeferredStreak, st.MaxDeferredStreak, st.StalledRelations = advanceDeferredStreaks(st.DeferredStreak, round)
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

// advanceDeferredStreaks 按本轮的过程事实推进"同一关系连续被延后"的计数（R10-G3）。
//
// 语义（判据与危害同构：**保留策略有没有在推进**）：
//
//	streak 每轮按"本轮被延后（lock-timeout / statement-timeout）的关系"**重建**：
//	  本轮被延后的 +1；本轮出现但**没**被延后的（回收掉 / 仍在保留期 / 深后代
//	  只补账 / 非表对象…）自然落回 0 —— "这一轮它被正常处理了"不是停摆。
//
// 返回新的 streak、其中的最大值、以及达到阈值的关系名（升序，有界）。
// 关系名会随月份滚动而永久增加，而 streak 只含本轮的键 ⇒ 规模有界（≤ 本轮关系数）。
func advanceDeferredStreaks(prev map[string]int, round usageRetentionRound) (map[string]int, int, []string) {
	next := make(map[string]int, len(round.DeferredRelations))
	for _, rel := range round.DeferredRelations {
		next[rel] = prev[rel] + 1
	}
	if len(next) == 0 {
		next = nil
	}
	return next, maxDeferredStreak(next), stalledRelations(next)
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

// usageWriteBlockState 是"当月计量写入被分区布局挡住"的**进程内**过程事实
// （R9-D R9D-00）。子系统自己记账，装配层只读，不推断。
type usageWriteBlockState struct {
	Month  string // 被挡住的北京月（YYYYMM）
	Since  time.Time
	Kind   string
	Action string
	Err    string
	Count  int64
}

var usageWriteBlockVal atomic.Pointer[usageWriteBlockState]

// usageWriteErrorVal 是"未分类的**瞬时**写入失败"（kind="other"）的进程内过程事实
// （R10-A-06）。与 usageWriteBlockVal 分开存放：判据面不同（分区布局 vs 瞬时错误），
// 处置动作也不同（DDL vs 重试/看日志），混在一个字段里就是语义漂移。
var usageWriteErrorVal atomic.Pointer[usageWriteBlockState]

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

// storeWriteBlock 按"同月累加、跨月重置"的语义写入一份写入面状态。
func storeWriteBlock(slot *atomic.Pointer[usageWriteBlockState], key, kind, action, msg string) {
	prev := slot.Load()
	next := &usageWriteBlockState{Month: key, Since: time.Now(), Kind: kind, Action: action, Err: msg, Count: 1}
	if prev != nil && prev.Month == key {
		next.Since = prev.Since
		next.Count = prev.Count + 1
	}
	slot.Store(next)
}

// storeUsageWriteError 同上（write_error 面：无 action）。
func storeUsageWriteError(slot *atomic.Pointer[usageWriteBlockState], key, kind, msg string) {
	storeWriteBlock(slot, key, kind, "", msg)
}

// noteUsagePartitionWriteOK 在**成功**创建/确认当月分区后清掉挡住状态。
//
// 只在"确实记过同一个月的失败"时才做 CompareAndSwap（热路径是一次 atomic load，
// 没有互斥、没有分配）。两个面一起清：一次成功写入同时证明"分区布局可用"与
// "刚才那次瞬时失败已过去"。
func noteUsagePartitionWriteOK(month time.Time) {
	key := monthKey(BeijingMonth(month))
	if prev := usageWriteBlockVal.Load(); prev != nil && prev.Month == key {
		usageWriteBlockVal.CompareAndSwap(prev, nil)
	}
	if prev := usageWriteErrorVal.Load(); prev != nil && prev.Month == key {
		usageWriteErrorVal.CompareAndSwap(prev, nil)
	}
}

// usageWriteBlockForReadyz 返回**当月**的写入阻塞状态（别的月份的历史阻塞不冒充当月）。
func usageWriteBlockForReadyz() *usageWriteBlockState {
	return usageWriteStateForReadyz(&usageWriteBlockVal)
}

// usageWriteErrorForReadyz 返回**当月**的瞬时写入失败状态。
func usageWriteErrorForReadyz() *usageWriteBlockState {
	return usageWriteStateForReadyz(&usageWriteErrorVal)
}

func usageWriteStateForReadyz(slot *atomic.Pointer[usageWriteBlockState]) *usageWriteBlockState {
	prev := slot.Load()
	if prev == nil || prev.Month != monthKey(BeijingMonth(time.Now())) {
		return nil
	}
	cp := *prev
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
