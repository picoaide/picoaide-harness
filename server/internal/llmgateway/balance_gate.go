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
// 本闸门在原判据之外补三层（三层都在**转发之前**，所以被拒的请求不产生上游调用）：
//
//	① 最小计费额：`minBillableMicro` = 平台自己的 prompt 估算口径
//	   （estimatePromptTokensFromBody，与计量兜底**同一实现**）× 该模型的输入价。
//	   余额盖不住这个下界就不放行 —— 连"最便宜的这一次"都买不起，转发必然是白烧。
//	② 学到的下限（serverstore.RecordBalanceSettlementFailure）：任何一次结算因
//	   余额不足失败，都会把该账号的准入下限抬到当时余额之上（失败整笔回滚 ⇒ 余额
//	   不变 ⇒ 不会自我解除）。这一层是必需的：prompt 估算只是成本下界，输出侧长度
//	   事前不可知，只有它才能把"可无限重复"收成"每次充值最多漏一次"。
//	③ **未定价模型**（R17A-06，审计 2026-09-25，P1）：输入价 NULL 或 <= 0 的模型
//	   上 ①② 与"分位余额 <= 0"**同时失效** —— 成本侧按同一份 0 价算 cost=0 ⇒
//	   结算永不失败 ⇒ 下限永不置位、余额一分不减 ⇒ 分位余额永不 <= 0。实测余额
//	   0.01 的账号在 NULL 定价 / 0 定价模型上 20/20、25/25 全部交付且全部命中上游。
//	   因此默认策略（`reject`）对未定价模型**直接拒绝**（`MODEL_NOT_PRICED`），
//	   逃生门是网关设置 `gateway.unpriced_model_policy=allow`（见 serverstore 的
//	   UnpricedModelPolicyReject 注释：为什么默认必须是 reject、以及"兜底价"为什么
//	   闭合不了这个洞）。
//
// 三层判据的**顺序**是有意的：先判 0/未开通（最便宜、与历史行为逐字一致），再判
// 学到的下限（无需任何额外查询），再判"未定价"（一次 settings 读），最后才做需要
// 读模型定价的"最小计费额"。
//
// 拒绝的可观测痕迹有三处（证据可检索，且都不给攻击者开无界写入面）：
//   - 进程内计数 + 最近一条形状（serverstore.BalanceAdmissionStats）⇒ `/server-info`；
//   - 结构化日志（**按用户节流**，见 balanceRejectionLogInterval：拒绝是攻击者可无限
//     触发的事件，逐条打日志等于给日志面开 DoS 面；节流线里带 suppressed 计数，
//     信息不丢）。**这是唯一的日志出口** —— serverstore 侧不再无条件打日志
//     （R17A-07，见 RecordBalanceAdmissionRejection 的注释）；
//   - 结算侧失败另有 `RecordBalanceSettlementFailure` 的一行 "floor raised" 日志。

import (
	"database/sql"
	"log"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
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
// 此时本层不参与准入判定（宁可不拦，也不用一个假的下界误伤）。
//
// R17A-06 起"未定价"这条**不再靠本函数兜底**：算不出下界时准入侧的上一条判据
// （balanceAdmissionBlocked 的第 ③ 层）已经按 `gateway.unpriced_model_policy`
// 决定拒绝还是放行；本函数只在"策略=allow"或输入价 > 0 时才可能被问到。
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

// balanceAdmissionRefusal 是一条准入拒绝的对外形状：给客户端的错误码/文案 + 内部
// 记录用的 reason 与"要求金额"。
type balanceAdmissionRefusal struct {
	code          string // 对外 error.code
	message       string // 对外 error.message
	reason        string // 准入拒绝的判据标签（进计数/最近一条/日志）
	requiredMicro int64  // 本次要求的下限（微元；non_positive/unpriced 时为 0）
}

// balanceAdmissionBlocked 是网关准入侧的钱闸门（唯一实现，五个端点共用）。
//
// 参数 body 必须是**客户端原始请求体**（计量侧估算用的同一份字节）；where 是端点标签
// （chat / completions / embeddings / responses / messages），只进日志与计数。
//
// 与 `serverstore.BalanceBlocked` 的关系：那条"分位余额 <= 0 → 拒绝"的规则**逐字保留**
// （含未开通不拦、管理员豁免、读设置失败 fail-closed），本函数在它之后追加三条更严的
// 判据。旧函数仍被别的路径使用（如 bootstrap/账户卡读面），故不删除。
func (a *API) balanceAdmissionBlocked(user *serverstore.User, model string, body []byte, where string) (balanceAdmissionRefusal, bool) {
	if user == nil {
		return balanceAdmissionRefusal{}, false
	}
	if user.IsAdmin {
		return balanceAdmissionRefusal{}, false // 管理员豁免（与既有口径一致）
	}
	s, err := serverstore.GetBalanceSettings(a.DB)
	if err != nil {
		// fail-closed（与 BalanceBlocked 同口径）
		return balanceAdmissionRefusal{code: "BALANCE_EXHAUSTED", message: "余额校验暂不可用,请稍后再试", reason: "settings_unavailable"}, true
	}
	if !s.Enabled {
		return balanceAdmissionRefusal{}, false
	}
	if user.BalanceActivatedAt.IsZero() {
		return balanceAdmissionRefusal{}, false // 未开通余额账户:闸门不适用
	}
	balanceMicro := serverstore.MoneyToMicro(user.BalanceMoney)
	// ① 历史判据:分位余额 <= 0。文案逐字不变。
	if serverstore.QuantizeMoney(user.BalanceMoney) <= 0 {
		return balanceAdmissionRefusal{
			code: "BALANCE_EXHAUSTED", message: "账户余额不足,请联系管理员充值", reason: "non_positive",
		}, true
	}
	// ② 学到的下限:上次结算因余额不足失败,而余额一分没涨 ⇒ 直接拒绝,不转发。
	if floor, ok := serverstore.BalanceAdmissionFloor(user.ID); ok && balanceMicro <= floor {
		return balanceAdmissionRefusal{
			code: "BALANCE_EXHAUSTED", message: "账户余额不足以支付一次调用,请充值后重试",
			reason: "learned_floor", requiredMicro: floor,
		}, true
	}
	// ③ 未定价模型:成本侧恒为 0 ⇒ ①② 与"余额 <= 0"同时失效（见文件头注释）。
	// 默认策略 reject ⇒ 直接拒绝；allow 是显式逃生门（免费/内部模型）。
	if serverstore.UnpricedModelPolicy(a.DB) != serverstore.UnpricedModelPolicyAllow {
		if in, _, _ := serverstore.ModelPrices(a.DB, model); in <= 0 {
			return balanceAdmissionRefusal{
				code: "MODEL_NOT_PRICED",
				// 文案对员工可读、对管理员可执行（唯一的修法是给模型定价）。
				message: "该模型未配置价格,暂不可用(请联系管理员在网关的模型列表里为它填写价格)",
				reason:  "unpriced_model",
			}, true
		}
	}
	// ④ 最小计费额:连这次请求的成本下界都盖不住 ⇒ 转发必然是白烧上游额度。
	if need, ok := minBillableMicro(a.DB, model, body); ok && balanceMicro < need {
		return balanceAdmissionRefusal{
			code: "BALANCE_EXHAUSTED", message: "账户余额不足以支付本次请求,请充值后重试",
			reason: "min_billable", requiredMicro: need,
		}, true
	}
	return balanceAdmissionRefusal{}, false
}

// rejectBalanceAdmission 是五个网关端点共用的准入闸门出口：命中即写错误响应
// （429 + 该判据自己的 error.code）并返回 true，调用方**必须立即 return**
// （被拒请求不得转发上游）。
//
// 为什么把"写响应"也收在这里：五个端点原先各自写 `429 BALANCE_EXHAUSTED`，
// 新增"未定价模型"这条判据时若逐点改，很容易漏掉一处 —— 漏掉的那处就会用
// BALANCE_EXHAUSTED 报告一个与余额无关的原因（R17A-06 的修复面）。
func (a *API) rejectBalanceAdmission(c *gin.Context, user *serverstore.User, model string, body []byte, where string) bool {
	refusal, blocked := a.balanceAdmissionBlocked(user, model, body, where)
	if !blocked {
		return false
	}
	a.recordBalanceAdmissionRejection(user, model, where, refusal.reason, refusal.requiredMicro, serverstore.MoneyToMicro(user.BalanceMoney))
	// 状态码沿用 429（五个端点与客户端对"钱闸门拒绝"的既有约定）；区分靠 error.code。
	serverauth.WriteError(c, http.StatusTooManyRequests, refusal.code, refusal.message)
	return true
}

// recordBalanceAdmissionRejection 记录一次准入拒绝：进程内计数/最近一条（serverstore）
// + **按用户节流**的结构化日志（唯一日志出口，见 serverstore.RecordBalanceAdmissionRejection）。
func (a *API) recordBalanceAdmissionRejection(user *serverstore.User, model, where, reason string, requiredMicro, balanceMicro int64) {
	ev := serverstore.BalanceAdmissionRejection{
		UserID:   user.ID,
		Username: util.EscapeControlLimit(user.Username, serverstore.MaxUsernameBytes),
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
