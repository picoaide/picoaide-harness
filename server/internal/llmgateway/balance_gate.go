package llmgateway

// R16C-02（审计 2026-09-25，P1）：网关**准入侧**的钱闸门（唯一实现，五个端点共用）。
//
// 缺陷形态：修前准入只看"分位余额 > 0"（`serverstore.BalanceBlocked`），不预留任何
// 最小计费额 ⇒ 余额 0.01 元的账号可以**无限次**请求：每次都真实调用上游（组织按
// 平台的 key 付费），随后结算失败（钱不够）整笔回滚 ⇒ usage / usage_daily /
// usage_monthly / balance_ledger 一行不动、金额不变，管理端零痕迹；默认不限速
// （`defaultRateLimit = 0`）+ 只限并发 32 ⇒ 循环没有终点。实测：余额 0.01、
// 单次成本 0.02 的账号连发 10 次 = **10 次上游命中**（修后 = 0）。
//
// 本闸门在原判据之外补两层（两层都在**转发之前**，所以被拒的请求不产生上游调用）：
//
//	① 最小计费额：`minBillableMicro` = 平台自己的 prompt 估算口径
//	   （estimatePromptTokensFromBody，与计量兜底**同一实现**）× 该模型的输入价。
//	   余额盖不住这个下界就不放行 —— 连"最便宜的这一次"都买不起，转发必然是白烧。
//	② 学到的下限（serverstore.RecordBalanceSettlementFailure）：任何一次结算因
//	   余额不足失败，都会把该账号的准入下限抬到当时余额之上（失败整笔回滚 ⇒ 余额
//	   不变 ⇒ 不会自我解除）。这一层是必需的：prompt 估算只是成本下界，输出侧长度
//	   事前不可知，只有它才能把"可无限重复"收成"每次充值最多漏一次"。
//
// 三层判据的**顺序**是有意的：先判 0/未开通（最便宜、与历史行为逐字一致），再判
// 学到的下限（无需任何额外查询），最后才做需要读模型定价的"最小计费额"。
//
// 拒绝的可观测痕迹有三处（证据可检索，且都不给攻击者开无界写入面）：
//   - 进程内计数 + 最近一条形状（serverstore.BalanceAdmissionStats）⇒ `/server-info`；
//   - 结构化日志（**按用户节流**，见 balanceRejectionLogInterval：拒绝是攻击者可无限
//     触发的事件，逐条打日志等于给日志面开 DoS 面；节流线里带 suppressed 计数，
//     信息不丢）；
//   - 结算侧失败另有 `RecordBalanceSettlementFailure` 的一行 "floor raised" 日志。

import (
	"database/sql"
	"log"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// balanceRejectionLogInterval 是同一用户两次"余额准入拒绝"日志之间的最小间隔。
//
// 取值：1 分钟。理由：被拒请求**不产生任何成本**（不转发、不落库），日志只需要让
// 运维看见"谁在被拒、为什么"，1 分钟的粒度足够；而逐条打印会让一个循环请求把日志
// 写满（本仓已有"日志面上限"的先例：wasmapp 的 appLogLimiter）。被抑制的条数会
// 累计到下一次打印的 suppressed 字段里 —— 计数不丢。
const balanceRejectionLogInterval = time.Minute

// balanceRejectionLogState 是日志节流的进程内状态（userID -> 上次打印时刻 + 抑制计数）。
var (
	balanceRejectionLogMu    sync.Mutex
	balanceRejectionLogState = map[int64]*balanceRejectionLogEntry{}
)

type balanceRejectionLogEntry struct {
	at         time.Time
	suppressed int64
}

// shouldLogBalanceRejection 报告这次拒绝要不要打日志；返回自上次打印以来被抑制的条数。
func shouldLogBalanceRejection(userID int64, now time.Time) (bool, int64) {
	balanceRejectionLogMu.Lock()
	defer balanceRejectionLogMu.Unlock()
	e := balanceRejectionLogState[userID]
	if e == nil {
		balanceRejectionLogState[userID] = &balanceRejectionLogEntry{at: now}
		return true, 0
	}
	if now.Sub(e.at) < balanceRejectionLogInterval {
		e.suppressed++
		return false, 0
	}
	suppressed := e.suppressed
	e.suppressed = 0
	e.at = now
	return true, suppressed
}

// resetBalanceRejectionLogForTest 清空节流状态（仅测试；与 serverstore 的
// ResetBalanceAdmissionForTest 配对，避免"单跑绿、整包红"）。
func resetBalanceRejectionLogForTest() {
	balanceRejectionLogMu.Lock()
	balanceRejectionLogState = map[int64]*balanceRejectionLogEntry{}
	balanceRejectionLogMu.Unlock()
}

// minBillableMicro 是"本次请求的最小计费额"（微元）的唯一实现：
//
//	最小计费额 = prompt 估算 token × 输入价（元/1M token）
//
// 为什么这是**下界**（因而是安全的准入判据）：实际费用 =
// prompt×输入价 + completion×输出价（还有峰谷折扣 ≤1），prompt 侧只会比估算多
// （估算按 4 字节/token 的保守下限），completion ≥ 0 ⇒ 实际 ≥ 本值。
//
// 口径细节（都取保守侧）：用**输入价**而不是缓存价（缓存命中更便宜，用输入价是
// 高估）；**不乘**峰谷折扣（低谷期会打折，不打折是高估）。
//
// 返回 ok=false 表示"算不出下界"（模型未定价 / 输入价 <= 0 / 估算为 0）——
// 此时不参与准入判定（宁可不拦，也不用一个假的下界误伤）。
func minBillableMicro(db *sql.DB, model string, body []byte) (int64, bool) {
	if db == nil || strings.TrimSpace(model) == "" || len(body) == 0 {
		return 0, false
	}
	inputPer1M, _, _ := serverstore.ModelPrices(db, model)
	if inputPer1M <= 0 {
		return 0, false
	}
	tokens, _ := estimatePromptTokensFromBody(body)
	if tokens <= 0 {
		return 0, false
	}
	// 元 → 微元：cost(元) = tokens×price/1e6 ⇒ cost(微元) = tokens×price。
	micro := math.Ceil(float64(tokens) * inputPer1M)
	if micro <= 0 || math.IsInf(micro, 0) || math.IsNaN(micro) {
		return 0, false
	}
	return int64(micro), true
}

// balanceAdmissionBlocked 是网关准入侧的钱闸门（唯一实现，五个端点共用）。
//
// 参数 body 必须是**客户端原始请求体**（计量侧估算用的同一份字节）；where 是端点标签
// （chat / completions / embeddings / responses / messages），只进日志与计数。
//
// 与 `serverstore.BalanceBlocked` 的关系：那条"分位余额 <= 0 → 拒绝"的规则**逐字保留**
// （含未开通不拦、管理员豁免、读设置失败 fail-closed），本函数在它之后追加两条更严的
// 判据。旧函数仍被别的路径使用（如 bootstrap/账户卡读面），故不删除。
func (a *API) balanceAdmissionBlocked(user *serverstore.User, model string, body []byte, where string) (bool, string) {
	if user == nil {
		return false, ""
	}
	if user.IsAdmin {
		return false, "" // 管理员豁免（与既有口径一致）
	}
	s, err := serverstore.GetBalanceSettings(a.DB)
	if err != nil {
		return true, "余额校验暂不可用,请稍后再试" // fail-closed（与 BalanceBlocked 同口径）
	}
	if !s.Enabled {
		return false, ""
	}
	if user.BalanceActivatedAt.IsZero() {
		return false, "" // 未开通余额账户:闸门不适用
	}
	balanceMicro := serverstore.MoneyToMicro(user.BalanceMoney)
	// ① 历史判据:分位余额 <= 0。文案逐字不变。
	if serverstore.QuantizeMoney(user.BalanceMoney) <= 0 {
		a.recordBalanceAdmissionRejection(user, model, where, "non_positive", 0, balanceMicro)
		return true, "账户余额不足,请联系管理员充值"
	}
	// ② 学到的下限:上次结算因余额不足失败,而余额一分没涨 ⇒ 直接拒绝,不转发。
	if floor, ok := serverstore.BalanceAdmissionFloor(user.ID); ok && balanceMicro <= floor {
		a.recordBalanceAdmissionRejection(user, model, where, "learned_floor", floor, balanceMicro)
		return true, "账户余额不足以支付一次调用,请充值后重试"
	}
	// ③ 最小计费额:连这次请求的成本下界都盖不住 ⇒ 转发必然是白烧上游额度。
	if need, ok := minBillableMicro(a.DB, model, body); ok && balanceMicro < need {
		a.recordBalanceAdmissionRejection(user, model, where, "min_billable", need, balanceMicro)
		return true, "账户余额不足以支付本次请求,请充值后重试"
	}
	return false, ""
}

// recordBalanceAdmissionRejection 记录一次准入拒绝：进程内计数/最近一条（serverstore）
// + **按用户节流**的结构化日志。
func (a *API) recordBalanceAdmissionRejection(user *serverstore.User, model, where, reason string, requiredMicro, balanceMicro int64) {
	ev := serverstore.BalanceAdmissionRejection{
		UserID:   user.ID,
		Username: util.EscapeControlLimit(user.Username, 128),
		Endpoint: where,
		Model:    util.EscapeControlLimit(model, 128),
		Reason:   reason,
		// 对外/日志里一律用元（与账本、余额的展示口径一致）。
		RequiredMoney: serverstore.MicroToMoney(requiredMicro),
		BalanceMoney:  user.BalanceMoney,
	}
	serverstore.RecordBalanceAdmissionRejection(ev)
	// 日志节流:同一用户每分钟最多一条,被抑制的条数累计到下一次。
	shouldLog, suppressed := shouldLogBalanceRejection(user.ID, time.Now())
	if !shouldLog {
		return
	}
	log.Printf("gateway: balance admission refused (throttled log) user=%d username=%q endpoint=%s model=%q reason=%s required_money=%.6f balance_money=%.6f suppressed_since_last=%d upstream_hits=0",
		user.ID, ev.Username, where, ev.Model, reason, ev.RequiredMoney, ev.BalanceMoney, suppressed)
}

// recordBalanceSettlementFailure 在**非流式**结算因余额不足失败时抬高该账号的准入
// 下限（R16C-02 第 2 层）。balanceMoney 用当前的余额快照（失败会整笔回滚余额）。
func recordBalanceSettlementFailure(user *serverstore.User) {
	if user == nil || user.IsAdmin {
		return
	}
	serverstore.RecordBalanceSettlementFailure(user.ID, user.BalanceMoney)
}
