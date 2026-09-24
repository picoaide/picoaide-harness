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
	"sync"
	"time"
)

// 未回收原因（skip_reasons 的**封闭取值**，日志与 /readyz 共用同一份字面量）。
//
// 新增一类"没有回收"的关系时必须在这里加一个取值，并回答"谁在推进它"：
//   - descendant：多级布局的深层后代 —— 人工（拆分区树/等子树拆走）；
//   - subtree-retained：子树里还有保留期内的行 —— **自动**，等子树内最后一个
//     到期月被回收后本轮自然继续；
//   - detached-non-leaf：DETACH 之后留下的父表/带子关系 —— 人工；
//   - non-table：视图/物化视图/序列/外部表等非表对象占名 —— 人工。
const (
	usageSkipDescendant      = "descendant"
	usageSkipSubtreeRetained = "subtree-retained"
	usageSkipDetachedNonLeaf = "detached-non-leaf"
	usageSkipNonTable        = "non-table"
)

// usageRetentionUnreclaimedMax 是状态里保留的"未回收关系清单"长度上限：
// 计数是精确的（SkippedByReason），清单只是给人看的抽样（有界，避免无界增长）。
const usageRetentionUnreclaimedMax = 20

// usageRetentionRound 是一轮清理的过程事实（由 CleanupUsageRetention 填写）。
type usageRetentionRound struct {
	At                time.Time
	ConfiguredMonths  int
	CutoffMonth       string
	Relations         int
	ClearedPartitions int
	ClearedDetached   int
	Skipped           int
	Failures          int
	SkippedByReason   map[string]int
	Unreclaimed       []string
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
//	                                深后代永不回收从此是可判定的计数）
//	unreclaimed                     未回收的关系名（有界抽样，带原因）
type UsageRetentionStatus struct {
	ConfiguredMonths  int    `json:"configured_months"`
	RoundNumber       int64  `json:"rounds"`
	FailedRounds      int64  `json:"failed_rounds"`
	LastRoundAt       string `json:"last_round_at,omitempty"`
	LastError         string `json:"last_error,omitempty"`
	CutoffMonth       string `json:"cutoff_month,omitempty"`
	Relations         int    `json:"relations"`
	ClearedPartitions int    `json:"cleared_partitions"`
	ClearedDetached   int    `json:"cleared_detached"`
	Skipped           int    `json:"skipped"`
	Failures          int    `json:"failures"`
	// SkippedByReason 是"本轮没有回收"的**按原因计数**（精确，不受清单上限影响）。
	SkippedByReason map[string]int `json:"skipped_by_reason,omitempty"`
	// Unreclaimed 是未回收的关系名 + 原因（`usage_202607(descendant)`），有界。
	Unreclaimed []string `json:"unreclaimed,omitempty"`
	// UnreclaimedTruncated 报告清单是否被上限截断（计数仍是全量）。
	UnreclaimedTruncated bool `json:"unreclaimed_truncated,omitempty"`
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
	st.ConfiguredMonths = round.ConfiguredMonths
	st.RoundNumber++
	st.CutoffMonth = round.CutoffMonth
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
	if !round.At.IsZero() {
		st.LastRoundAt = round.At.UTC().Format(time.RFC3339)
	}
	if roundErr != nil {
		st.FailedRounds++
		st.LastError = roundErr.Error()
	} else {
		st.LastError = ""
	}
	usageRetentionStatusVal = st
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
	return st
}

// UsageRetentionUnreclaimableCount 返回**本轮**"点名但没有回收"的关系数与原因
// 计数——给断言与将来的 metric 面用的最小接口（避免调用方自己解析清单）。
func UsageRetentionUnreclaimableCount() (total int, byReason map[string]int) {
	st := CurrentUsageRetentionStatus()
	return st.Skipped, st.SkippedByReason
}

// resetUsageRetentionStatusForTest 清空进程内状态（仅测试；形态与
// resetSharedLimitersForTest 等既有测试钩子一致）。
func resetUsageRetentionStatusForTest() {
	usageRetentionStatusMu.Lock()
	defer usageRetentionStatusMu.Unlock()
	usageRetentionStatusVal = UsageRetentionStatus{}
}
