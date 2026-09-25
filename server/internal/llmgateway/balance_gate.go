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
// R18C-01（审计 2026-09-25，P1）把 ③④ 的取价从**模型名**改到**候选 provider 维度**：
// 名字口径（`ModelPrices` = ORDER BY provider_id LIMIT 1）与结算口径
// （`ModelPricesForProvider(实际命中的 provider, name)`）在两个 provider 挂同名模型、
// 而实际服务的那家未定价时分叉 —— 闸门看到"别人的价"而放行，结算按 NULL 价算出
// cost=0。候选集合由 `MatchModelsByProtocol(model, protocol)` 定义（与路由/故障转移
// 同一份），见 `admissionPricing` 的注释。
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

// admissionPricing 是准入闸门在"**候选 provider** 维度"上需要的取价结果（R18C-01，
// 审计 2026-09-25，P1）。
//
// 为什么判据面必须与结算的取值面同形：结算按**实际命中的 provider** 取价
// （serverstore.ModelPricesForProvider），而"可能被命中"的集合 = 路由候选集合
// （`MatchModelsByProtocol`，handler 紧接着调用的就是它，同一份 LoadUpstreams 缓存 +
// 同一个 enabled/provider-JSON 口径，故障转移也只在这个集合内挑下一个）。
// 按**模型名**取一行（`ModelPrices` = `ORDER BY provider_id LIMIT 1`）会在
// "同名模型挂多个 provider、实际服务的那家未定价（渠道同步建 NULL 价行的常规路径）"
// 时给出**别人的价** ⇒ ③ 层以为已定价而放行，而结算对同一请求算出 cost = 0
// ⇒ 余额一分不减、学到的下限永不置位（R17A-06 要闭合的洞被"名字口径"重新打开）。
type admissionPricing struct {
	// candidates 是本端点协议下可路由的 provider 数（0 = 该名字在本端点不可路由，
	// 调用方会 404，不产生上游调用 ⇒ ③④ 都不需要参与）。
	candidates int
	// unpriced 是"取价/路由面读失败"（fail-closed：按未定价处置，与"取价失败曾经
	// 等于 0 价"的既有方向一致）。**"某一家的价算不算未定价"不在这里判** ——
	// 它与端点的计费面有关（有无补全侧），见 unpricedFor。
	lookupFailed bool
	// inputPer1M / outputPer1M 是各候选的生效（输入/输出）价，**顺序与路由候选一致**
	// （[0] = 正常路径的那一家）。
	inputPer1M  []float64
	outputPer1M []float64
}

// ⚠️ 判定记录（R19A-S1-04，审计 2026-09-25，P2）：`unpriced_model_policy=allow` 是
// **全局**逃生门，它在放行"整体未定价的免费/内部模型"的同时，也放行了"同名模型挂多
// provider、其中一家未定价"的混合候选集合（故障转移到那家即 cost=0）。本轮**保留**该
// 语义：它是上一轮 R18C-01 的显式产品决策，并由既有判据
// `TestBalanceAdmissionUnpricedPolicyAllowKeepsMultiProviderEscape` 钉住
//（"显式声明的免费模型不得被拦"）。若要让 allow 只覆盖"整体无价"的模型，需要把策略
// 改成**按模型**的名单（新 settings 形状 + 迁移），属产品决策，不在本轮。
// 本轮的处置是**披露**：webadmin 的策略说明与该策略的作用范围写清楚（见
// Gateway.tsx 的「未定价模型策略」说明），并在审计报告里登记为"判定保留"。

// unpricedFor 判断"**任一**候选在本端点口径下完全无法计费"（③ 层判据）。
//
// 为什么是"任一"而不是"第一个"：路由在候选集合内**故障转移**（handler 的
// `for i := range ups`），任何一家都可能真的服务这次请求；只要有一家完全无法计费，
// 落到它上面的那次调用就是 cost=0（R18C-01 实测的备用 provider 形态）。
//
// 为什么必须**分端点口径**（R19A-S1-03，审计 2026-09-25，P2 回归）：
//   - 有补全侧的端点（chat/completions/responses/messages）：计费 = 输入侧 + 输出侧，
//     只有**两侧都无价**才是真的"成本恒为 0"。修前只判输入价 ⇒ "输入价 0/极低 +
//     输出价正常"的合法模型（很多模型靠输出侧赚钱）每一笔都被 429 MODEL_NOT_PRICED，
//     而基线是 200 + 真计费（实测输入 0.01/输出 8 元/1M：基线 cost≈2.4e-5，第十八轮之后 429）；
//   - embeddings：没有补全侧 ⇒ 输入价 <= 0 就是无法计费。
func (p admissionPricing) unpricedFor(hasOutput bool) bool {
	if p.lookupFailed {
		return true
	}
	for i, in := range p.inputPer1M {
		out := 0.0
		if i < len(p.outputPer1M) {
			out = p.outputPer1M[i]
		}
		if in <= 0 && (!hasOutput || out <= 0) {
			return true
		}
	}
	return false
}

// unbillableCandidate 返回"按结算口径这次请求在它上面应付 0 微元"的候选下标
// （-1 = 每一家都能计费）。R18A-05（审计 2026-09-25，P1）：
//
// 价 > 0 但小到 `roundMicro(cost) == 0` 时，结算记的是 0 微元（账本按微元四舍五入
// 落账）⇒ 余额一分不减、下限永不置位 —— 与"未定价"逐字同形，只是入口从 NULL 价换成
// 了极小非零价（0.001 元/1M 实测 20/20 交付、20 次上游命中）。所以判据必须是
// "**这次请求**的最小应付额 > 0 微元"，而不是"单价 > 0"。
//
// cost 的两侧都算（R19A-S1-03）：有补全侧的端点按 1 个输出 token 的下界计入输出价，
// 否则"输入价 0/极低 + 输出价正常"的模型会被整体判死（见 unpricedFor）。embeddings
// 没有补全侧，只算输入侧。
//
// 与 ③ 的未定价判据同样取"任一候选"：故障转移到哪一家都可能发生。
func (p admissionPricing) unbillableCandidate(promptTokens int64, hasOutput bool) int {
	if promptTokens <= 0 {
		return -1 // 估不出 prompt ⇒ 判不了"这次请求的最小应付额"，本层不参与
	}
	for i, in := range p.inputPer1M {
		out := 0.0
		if i < len(p.outputPer1M) {
			out = p.outputPer1M[i]
		}
		if _, ok := billableMicroFor(promptTokens, in, hasOutput, out); !ok {
			return i
		}
	}
	return -1
}

// servingInputPer1M 是"将被路由到的那一家"（候选集合第一个）的生效输入价。
func (p admissionPricing) servingInputPer1M() float64 {
	if len(p.inputPer1M) == 0 {
		return 0
	}
	return p.inputPer1M[0]
}

// admissionPricingFor 读"这次请求可能被路由到的 provider 各自的生效价"。
//
// 逐项走 `serverstore.ModelPricesForProviders`（内部就是结算用的
// `modelPricesForProviderQ`，含"该 provider 下无此行 ⇒ 回落 name 口径"的语义）。
func (a *API) admissionPricingFor(model, protocol string) admissionPricing {
	ups, err := MatchModelsByProtocol(a.DB, model, protocol)
	if err != nil {
		// 路由面读不出来 ⇒ 无法证明"每个候选都已定价"，fail-closed。
		return admissionPricing{lookupFailed: true}
	}
	if len(ups) == 0 {
		return admissionPricing{}
	}
	ids := make([]int64, 0, len(ups))
	for _, u := range ups {
		ids = append(ids, u.ID)
	}
	prices, err := serverstore.ModelPricesForProviders(a.DB, ids, model)
	if err != nil {
		return admissionPricing{candidates: len(ids), lookupFailed: true}
	}
	p := admissionPricing{
		candidates:  len(ids),
		inputPer1M:  make([]float64, 0, len(ids)),
		outputPer1M: make([]float64, 0, len(ids)),
	}
	for _, id := range ids {
		// prices[id] = [输入价, 输出价, 缓存价]（与结算 `modelPricesForProviderQ` 同一份）。
		p.inputPer1M = append(p.inputPer1M, prices[id][0])
		p.outputPer1M = append(p.outputPer1M, prices[id][1])
	}
	return p
}

// billableMicro 是"按结算口径这次请求**至少**会被记多少微元"的唯一实现（R18A-05）。
//
// 与结算同一条实现链：
//
//	cost(元) = tokens/1e6 × 输入价        （completion = 0、不乘峰谷折扣 ⇒ 下界）
//	落账     = roundMicro(cost)           （账本按 moneyMicroScale = 1e6 折到微元）
//
// 这里直接复用 `serverstore.MoneyToMicro`（= `round(cost × 1e6)`，与账本的
// `roundMicro` 同一尺度与同一舍入），避免"闸门用 ceil、账本用 round"这种口径分叉
// ——旧实现用 `math.Ceil`，于是 tokens×单价 ∈ (0, 0.5) 微元时闸门以为"至少要付 1 微元"、
// 账本却落 0 微元（R18A-05 实测：0.001 元/1M × 15 token = 0.015 微元）。
//
// 返回 ok=false 表示"这次请求在这家候选上不可能被计费"（估不出 tokens / 价 <= 0 /
// 折到微元为 0）——调用方按"未定价"处置（策略 allow 时放行，见 ③ 层）。
func billableMicro(tokens int64, inputPer1M float64) (int64, bool) {
	// 只算输入侧（④"最小计费额"用的就是这个下界：输出侧 ≥ 0 ⇒ 它永远是成本下界）。
	return billableMicroFor(tokens, inputPer1M, false, 0)
}

// billableMicroFor 是"按结算口径这次请求**至少**会被记多少微元"的唯一实现
// （R18A-05 + R19A-S1-03）：
//
//	cost(元) = promptTokens/1e6×输入价 + minOutputTokens/1e6×输出价
//	落账     = roundMicro(cost)   （账本口径 = serverstore.MoneyToMicro）
//
// minOutputTokens：有补全侧的端点取 **1**（任何非空补全至少 1 个输出 token —— 取它
// 而不是 0，才不会把"输入价 0/极低、输出价正常"的合法模型判成不可计费）；
// embeddings（无补全侧）取 0。
//
// 返回 ok=false = "这次请求在这家候选上不可能被计费"（估不出 tokens / 两侧都无价 /
// 折到微元为 0）。**它必须与结算同源**：修前 embeddings 的闸门用客户端原始 body 的
// 字节数（含 JSON 外壳与任意客户端字段），而结算用 input 文本 —— 闸门看到的量更大
// ⇒ 价格落在 [0.5/est, 0.5/real) 时放行、账本落 0 微元（R19A-S1-01 实测 20/20 交付、
// 20 次真实上游命中、余额与账本一分未动）。所以 promptTokens 必须由调用方用**该端点
// 结算所用的同一个估算函数**给出（见 admissionTokensFromBody /
// admissionTokensFromEmbeddingInputs）。
func billableMicroFor(promptTokens int64, inputPer1M float64, hasOutput bool, outputPer1M float64) (int64, bool) {
	if promptTokens <= 0 {
		return 0, false
	}
	in := 0.0
	if inputPer1M > 0 {
		in = float64(promptTokens) / 1e6 * inputPer1M
	}
	out := 0.0
	if hasOutput && outputPer1M > 0 {
		out = 1 / 1e6 * outputPer1M // 输出侧下界 = 1 token
	}
	if in <= 0 && out <= 0 {
		return 0, false
	}
	micro := serverstore.MoneyToMicro(in + out)
	if micro <= 0 {
		return 0, false
	}
	return micro, true
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
// 高估）；**不乘**峰谷折扣（低谷期会打折，不打折是高估）；输入价取**将被路由到的
// 那一家候选**（`admissionPricing.servingInputPer1M`，正常路径 = 候选集合的第一个），
// 而不是按模型名取一行（那是 R18C-01 的分叉点）；金额经 `billableMicro`
// （= 账本的 `roundMicro` 口径）折到微元，不再用 `math.Ceil` 虚高 1 微元
// （那是 R18A-05 的分叉点：闸门说"至少 1 微元"、账本落 0）。
//
// 返回 ok=false 表示"算不出下界"（模型未定价 / 输入价 <= 0 / 估算为 0 / 折到微元为 0）——
// 此时本层不参与准入判定（宁可不拦，也不用一个假的下界误伤）。
//
// R17A-06/R18A-05 起"未定价 / 这次请求应付 0 微元"这两条**不再靠本函数兜底**：
// 算不出下界时准入侧的上一条判据（balanceAdmissionBlocked 的第 ③ 层）已经按
// `gateway.unpriced_model_policy` 决定拒绝还是放行；本函数只在"策略=allow"或
// 应付额 > 0 时才可能被问到。
func minBillableMicro(db *sql.DB, model string, pricing admissionPricing, tokens int64) (int64, bool) {
	if db == nil || strings.TrimSpace(model) == "" {
		return 0, false
	}
	inputPer1M := pricing.servingInputPer1M()
	if pricing.candidates == 0 {
		// 不可路由的名字（随后 404）：没有候选可谈"最低价"，保留历史判据（按名字取一行），
		// 不改变这条路径上的状态码与文案。
		inputPer1M, _, _ = serverstore.ModelPrices(db, model)
	}
	need, ok := billableMicro(tokens, inputPer1M)
	if !ok {
		return 0, false
	}
	return need, true
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
// 参数 promptTokens 是**这次请求的输入侧估量**，且必须与**结算将要使用的估算同一个
// 函数**（R19A-S1-01，审计 2026-09-25，P1）：
//   - chat/completions/responses/messages ⇒ `admissionTokensFromBody(客户端原始 body)`
//     （结算兜底 `estimatePromptFallback` 走的就是 `estimatePromptTokensFromBody`）；
//   - embeddings ⇒ `admissionTokensFromEmbeddingInputs(inputs)`
//     （结算走的是 `estimateEmbeddingPromptTokens(inputs)` —— embeddings 的出站体由
//     服务端自建 `{model,input}`，客户端 body **从不转发**，用 body 字节当 prompt 量
//     会让闸门看到的量比结算大一个 JSON 外壳，从而放行"账本必然落 0 微元"的请求）。
//
// where 是端点标签（chat / completions / embeddings / responses / messages），进日志与
// 计数，并决定**计费面的形状**（embeddings 没有补全侧 ⇒ ③③b 只看输入价）；
// protocol 是**本端点的路由协议**（openai / anthropic），必须与同一 handler 里
// `MatchModelsByProtocol(..., protocol)` 那一次调用逐字一致 —— 判据面 = 候选 provider
// 集合，而候选集合正是由它定义的（R18C-01）。
//
// 与 `serverstore.BalanceBlocked` 的关系：那条"分位余额 <= 0 → 拒绝"的规则**逐字保留**
// （含未开通不拦、管理员豁免、读设置失败 fail-closed），本函数在它之后追加三条更严的
// 判据。旧函数仍被别的路径使用（如 bootstrap/账户卡读面），故不删除。
func (a *API) balanceAdmissionBlocked(user *serverstore.User, model string, promptTokens int64, where, protocol string) (balanceAdmissionRefusal, bool) {
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
	// ③④ 共用一次"候选 provider 维度"的取价（R18C-01）与一次 prompt 估算
	// （R18A-05：③b 与 ④ 都要"这次请求"的量级）。放在 ①② 之后：那两条不需要任何
	// 取价（顺序与历史一致），且 policy=allow 时 ③ 不参与而 ④ 仍需要价。
	pricing := a.admissionPricingFor(model, protocol)
	tokens := promptTokens
	// 计费面的形状由端点决定：embeddings 没有补全侧（③③b 只看输入价）。
	hasOutput := where != "embeddings"
	// ③ 未定价模型:成本侧恒为 0 ⇒ ①② 与"余额 <= 0"同时失效（见文件头注释）。
	// 默认策略 reject ⇒ 直接拒绝；allow 是显式逃生门（免费/内部模型）。
	if serverstore.UnpricedModelPolicy(a.DB) != serverstore.UnpricedModelPolicyAllow {
		unpriced := pricing.unpricedFor(hasOutput)
		if pricing.candidates == 0 {
			// 该名字在本端点不可路由（handler 随后 404、不产生上游调用）⇒ 没有"候选价"
			// 可判，保留历史判据（按名字取一行）与它的状态码，不用 404 顶替 429。
			in, out, _ := serverstore.ModelPrices(a.DB, model)
			unpriced = in <= 0 && (!hasOutput || out <= 0)
		}
		if unpriced {
			return balanceAdmissionRefusal{
				code: "MODEL_NOT_PRICED",
				// 文案对员工可读、对管理员可执行（唯一的修法是给模型定价）。
				message: "该模型未配置价格,暂不可用(请联系管理员在网关的模型列表里为它填写价格)",
				reason:  "unpriced_model",
			}, true
		}
		// ③b 极小非零价（R18A-05，审计 2026-09-25，P1）：单价 > 0 但"这次请求"的最小
		// 应付额四舍五入到 **0 微元**（账本口径）⇒ 结算落 0、余额一分不减 —— 与未定价
		// 逐字同形。判据是"这次请求应付 > 0 微元"，不是"单价 > 0"。
		if idx := pricing.unbillableCandidate(tokens, hasOutput); idx >= 0 {
			return balanceAdmissionRefusal{
				code: "MODEL_NOT_PRICED",
				message: "该模型价格过低,单次调用计费不足最小单位,暂不可用" +
					"(请联系管理员调整模型价格;若它确实是免费/内部模型,请在网关配置里把未定价模型策略设为 allow)",
				reason: "unbillable_price",
			}, true
		}
	}
	// ④ 最小计费额:连这次请求的成本下界都盖不住 ⇒ 转发必然是白烧上游额度。
	if need, ok := minBillableMicro(a.DB, model, pricing, tokens); ok && balanceMicro < need {
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
func (a *API) rejectBalanceAdmission(c *gin.Context, user *serverstore.User, model string, promptTokens int64, where, protocol string) bool {
	refusal, blocked := a.balanceAdmissionBlocked(user, model, promptTokens, where, protocol)
	if !blocked {
		return false
	}
	a.recordBalanceAdmissionRejection(user, model, where, refusal.reason, refusal.requiredMicro, serverstore.MoneyToMicro(user.BalanceMoney))
	// 状态码沿用 429（五个端点与客户端对"钱闸门拒绝"的既有约定）；区分靠 error.code。
	serverauth.WriteError(c, http.StatusTooManyRequests, refusal.code, refusal.message)
	return true
}

// admissionTokensFromBody 是 chat/completions/responses/messages 四个端点的准入估量：
// 与结算兜底 `estimatePromptFallback` 用的是**同一个函数**（estimatePromptTokensFromBody，
// 含内联二进制封顶），所以"闸门看到的量"不会超过"结算会算的量"（R19A-S1-01 的判据面
// 同源要求）。传客户端原始请求体。
func admissionTokensFromBody(body []byte) int64 {
	tokens, _ := estimatePromptTokensFromBody(body)
	return tokens
}

// admissionTokensFromEmbeddingInputs 是 embeddings 端点的准入估量：与结算用的
// `estimateEmbeddingPromptTokens(inputs)` **同一个函数**（R19A-S1-01）。
//
// 为什么不能用客户端 body：embeddings 的出站体由服务端自建 `{model,input}`，客户端
// body 从不转发 ⇒ body 字节数（JSON 外壳 + 任意客户端字段）根本不是这次调用要付钱的
// 文本量。用它会让闸门判"应付 ≥1 微元"而账本 roundMicro 落 0（实测 0.1 元/1M、
// input=["hi"]：闸门 est=8、结算基准=1，20/20 交付、20 次真实上游命中、零扣费）。
func admissionTokensFromEmbeddingInputs(inputs []string) int64 {
	return estimateEmbeddingPromptTokens(inputs)
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
