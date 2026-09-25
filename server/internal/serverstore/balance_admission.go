package serverstore

// R16C-02（审计 2026-09-25，P1）：余额闸门准入侧的两块**共享状态**。
//
// 缺陷形态（修复前）：`BalanceBlocked` 只判"分位余额 > 0"，不预留任何最小计费额
// ⇒ 余额 0.01 元的账号可以**无限次**请求：每次都已真实调用上游（上游按平台的 key
// 计费），随后结算失败（`ErrInsufficientBalance`）整笔回滚 ⇒ `usage` /
// `usage_daily` / `usage_monthly` / `balance_ledger` 行数与金额一字不变，管理端
// 零痕迹；默认不限速（`gateway.rate_limit` 缺省 0）⇒ 循环没有终点。
//
// 修法分两层（本文件是第二层与两层的**证据出口**）：
//
//  1. **准入侧最小计费额**（`llmgateway.balanceAdmissionBlocked`）：按平台自己的
//     prompt 估算口径（`estimatePromptTokensFromBody`，与计量兜底同一实现）× 该模型
//     的输入价，算出"这次请求至少要花多少钱"，余额盖不住就不转发；
//  2. **学到的下限**（本文件）：任何一次"结算时钱不够"的**事实**都会把该账号的准入
//     下限抬到**当时余额之上** —— 余额不增长就一律在准入处拒绝，一次上游调用都不发。
//     依据：结算失败证明"这个余额买不起一次真实调用"，而失败会整笔回滚（余额不变）
//     ⇒ 不放行就是正确的产品语义（先充值）；一旦入账/退款让余额真的增长，下限自动失效。
//
// 为什么需要第 2 层（只做第 1 层不够）：prompt 估算只是**成本下界**，输出侧长度
// 事前不可知；余额 0.01 且单次实际 0.02 的账号仍能凭"最小计费额只有 0.0001"过闸，
// 进而反复真实调用上游（实测 10 次请求 = 10 次上游命中）。下限把"可重复放大的漏洞"
// 收成"每次充值最多漏一次"。
//
// 证据出口（第 2 层的可观测面）：进程内计数 + 最近一条拒绝的形状，经
// `serverauth` 的 `/server-info` 对外可读（不新增路由 —— 路由唯一真源是
// internal/router）。**故意不写 audit_logs**：拒绝是**攻击者可无限触发**的事件，
// 落库就是给审计表开了个无界写入面；而审计动作码是跨端契约（webadmin 的
// ACTION_LABEL 由服务端源码扫描对拍），新增动作码必须同步改 webadmin —— 那不在
// 本次改动的文件边界内。计数器 + 结构化日志（llmgateway 侧，按用户节流）已满足
// "被拒请求有可检索证据"。

import (
	"database/sql"
	"log"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// UnpricedModelPolicySetting 是「未定价模型」的准入策略 settings 键
// （R17A-06，审计 2026-09-25，P1）。
//
// 取值只有两个（见下面的常量）；**缺失/空/任何其它取值都回落 reject**。
const UnpricedModelPolicySetting = "gateway.unpriced_model_policy"

const (
	// UnpricedModelPolicyReject（**默认**）：输入价 NULL 或 <= 0 的模型对
	// "余额闸门适用"的账号一律在准入处拒绝（llmgateway 侧给
	// `MODEL_NOT_PRICED`），请求不转发上游。
	//
	// 为什么默认是它（而不是放行）：未定价模型的成本侧恒为 0 ⇒ 结算永远不会因
	// 余额不足失败 ⇒ R16C-02 的第 ② 层（学到的下限）永不置位、余额一分不减、
	// 第 ① 层（分位余额 <= 0）永不成立。也就是说三层钱闸门在未定价模型上**同时
	// 失效**，账号可以无限次真实调用上游（组织按平台的 key 付费）而平台零计费、
	// 零扣款、零痕迹。实测：余额 0.01 的账号在 NULL 定价与 0 定价模型上分别
	// 20/20、25/25 全部交付且全部命中上游。
	//
	// 为什么不是"按保守默认价算一个兜底最小计费额"：最小计费额 = prompt token ×
	// 单价，而余额可以是任意小的正数 —— 任何按 token 计的单价乘一个短 prompt 都
	// 远小于 0.01 元，闸门照样放行，而成本恒为 0 ⇒ 循环依旧无界。兜底价只能抬高
	// 放行门槛，闭合不了"余额永不减少"这个洞。
	UnpricedModelPolicyReject = "reject"
	// UnpricedModelPolicyAllow 是**显式逃生门**：本组织确实有免费/内部（自建、
	// 不计费）模型时，管理员把策略改成 allow，逐字回到历史行为（未定价模型照常
	// 放行、上游被真实调用、成本记 0）。
	//
	// 误伤面与代价都写在这里，改默认值前先读：allow 等于承认"这些模型的上游成本
	// 不进平台的账"，因此**只对确实不花钱的模型开**；开了之后余额闸门对这些模型
	// 没有任何下界，被滥用的唯一可见证据是上游账单与 usage 里 cost=0 的行数与
	// token 数（准入拒绝计数不会增长）。
	UnpricedModelPolicyAllow = "allow"
)

// UnpricedModelPolicy 读取未定价模型策略；缺失/非法取值一律回落 reject
// （fail-closed 方向：不允许一个错字把闸门关掉）。
func UnpricedModelPolicy(db *sql.DB) string {
	if db == nil {
		return UnpricedModelPolicyReject
	}
	v, ok, err := GetSetting(db, UnpricedModelPolicySetting)
	if err != nil || !ok {
		return UnpricedModelPolicyReject
	}
	if v == UnpricedModelPolicyAllow {
		return UnpricedModelPolicyAllow
	}
	return UnpricedModelPolicyReject
}

// MoneyToMicro 把元金额折算成**记账微元**（int64，四舍五入）。
// 与 roundMicro 同一精度口径（1e-6 元），是"分位余额"与"最小计费额"比较的唯一桥。
func MoneyToMicro(v float64) int64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return int64(math.Round(v * moneyMicroScale))
}

// MicroToMoney 是 MoneyToMicro 的逆（微元 → 元），用于对外展示与日志。
func MicroToMoney(m int64) float64 { return float64(m) / moneyMicroScale }

// BalanceAdmissionRejection 是一条"余额闸门在准入处拒绝"的形状（证据出口）。
// 只读投影，不含任何请求正文。
type BalanceAdmissionRejection struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	// Endpoint 是拒绝发生的端点标签（chat / completions / embeddings / responses / messages）。
	Endpoint string `json:"endpoint"`
	Model    string `json:"model"`
	// Reason 是拒绝依据（封闭集合）：non_positive（分位余额 <= 0）|
	// learned_floor（上次结算因余额不足失败，余额未增长）| min_billable（小于本次最小计费额）|
	// unpriced_model（候选 provider 里任一家的生效输入价 <= 0，R17A-06/R18C-01）|
	// unbillable_price（单价 > 0 但**这次请求**的最小应付额折到 0 微元，R18A-05）。
	Reason string `json:"reason"`
	// RequiredMoney 是本次要求的下限（元）；non_positive 时为 0。
	RequiredMoney float64 `json:"required_money"`
	// BalanceMoney 是**请求携带的那份**余额快照（元）。
	BalanceMoney float64 `json:"balance_money"`
	At           string  `json:"at"`
}

var (
	balanceAdmissionRejections atomic.Int64
	balanceAdmissionMu         sync.Mutex
	balanceAdmissionLast       BalanceAdmissionRejection
	balanceAdmissionHaveLast   bool

	// balanceAdmissionFloor 是"学到的下限"：userID -> 微元余额（该账号**上次结算因
	// 余额不足失败时**的余额）。准入时余额 <= 该值即拒绝。
	//
	// 进程内、不落库：它只是一条**保守的准入判定**，丢了最多让每个实例多漏一次上游
	// 调用（见包注释的诚实边界）；落库需要在 users 上加列/新表（迁移），代价与收益
	// 不成比例。
	balanceAdmissionFloor sync.Map // int64 -> int64（微元）
)

// RecordBalanceAdmissionRejection 记录一次准入拒绝（计数 + 最近一条）。返回累计
// 拒绝次数。
//
// **这里故意不打日志**（R17A-07，审计 2026-09-25，P2）：旧实现在这里无条件
// `log.Printf`，而拒绝是**攻击者可无限触发**的事件（拒绝路径不转发、默认不限速）
// ⇒ 一个余额耗尽的账号可以以任意速率让服务端写日志，把"按用户节流"的声称面
// （llmgateway 的 shouldLogBalanceRejection，1 分钟/用户）整体作废。实测 30 次
// 拒绝 = 30 行。现在日志只有一个出口：llmgateway 的**节流**日志（带 suppressed
// 累计计数，信息不丢），本函数只负责计数与"最近一条"投影，两者都不产生无界
// 写入面。
func RecordBalanceAdmissionRejection(ev BalanceAdmissionRejection) int64 {
	if ev.At == "" {
		ev.At = time.Now().UTC().Format(time.RFC3339)
	}
	n := balanceAdmissionRejections.Add(1)
	balanceAdmissionMu.Lock()
	balanceAdmissionLast = ev
	balanceAdmissionHaveLast = true
	balanceAdmissionMu.Unlock()
	return n
}

// BalanceAdmissionStats 返回累计准入拒绝次数与最近一条（ok=false = 本进程还没有过）。
func BalanceAdmissionStats() (count int64, last BalanceAdmissionRejection, ok bool) {
	balanceAdmissionMu.Lock()
	defer balanceAdmissionMu.Unlock()
	return balanceAdmissionRejections.Load(), balanceAdmissionLast, balanceAdmissionHaveLast
}

// RecordBalanceSettlementFailure 记下"这个账号在这个余额上已经买不起一次真实调用"
// 这一事实（R16C-02 第 2 层）。balanceMoney 是**当时**的余额（结算失败会整笔回滚，
// 所以它通常就是当前余额）。
//
// 只在**非流式**结算失败（`ErrInsufficientBalance`）时调用：流式走 allowOverdraft
// 后付费语义（余额允许走负），失败不是同一回事。
func RecordBalanceSettlementFailure(userID int64, balanceMoney float64) {
	if userID <= 0 {
		return
	}
	floor := MoneyToMicro(balanceMoney)
	if floor < 0 {
		floor = 0
	}
	// 只抬不降：并发/重试下取更高的下限（更保守 = 更不容易放行烧额度）。
	if prev, ok := balanceAdmissionFloor.Load(userID); ok {
		if p, _ := prev.(int64); p >= floor {
			return
		}
	}
	balanceAdmissionFloor.Store(userID, floor)
	log.Printf("gateway: balance admission floor raised user=%d floor_money=%.6f (settlement failed: insufficient balance; requests are refused until the balance grows)",
		userID, MicroToMoney(floor))
}

// BalanceAdmissionFloor 返回该账号学到的准入下限（微元）。ok=false = 没有记录。
func BalanceAdmissionFloor(userID int64) (int64, bool) {
	if v, ok := balanceAdmissionFloor.Load(userID); ok {
		f, _ := v.(int64)
		return f, true
	}
	return 0, false
}

// ResetBalanceAdmissionForTest 清空准入侧的两块进程内状态（计数/最近一条/下限）。
//
// 与 resetSharedLimitersForTest 同一纪律：**包级单例 + 进程级累积状态**必须给测试
// 一个重置入口，否则同一个 Go 进程里跑多个用例会互相污染（"单跑绿、整包红"）。
// 只在 _test.go 里被调用（生产代码不引用它，Go 不会因此多编译任何东西）。
func ResetBalanceAdmissionForTest() {
	balanceAdmissionRejections.Store(0)
	balanceAdmissionMu.Lock()
	balanceAdmissionLast = BalanceAdmissionRejection{}
	balanceAdmissionHaveLast = false
	balanceAdmissionMu.Unlock()
	balanceAdmissionFloor.Range(func(k, _ any) bool {
		balanceAdmissionFloor.Delete(k)
		return true
	})
}
