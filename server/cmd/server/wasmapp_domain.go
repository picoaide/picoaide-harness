package main

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"strings"
	"sync/atomic"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// 本文件是「应用泛域名」的运行期配置（2026-09-18 用户要求：
// 「管理端支持应用域名的泛域名配置 —— 应用名 + 泛域名就是应用的访问路径」）。
//
// 改造前的形态是**启动期环境变量**（`PICOAI_APPS_BASE_DOMAIN`）：
//   - `edge.HostGate` / `session` / `appserver` / `api` 各持一份不可变字符串；
//   - 未配置时 HostGate 干脆不安装。
// 那样"改一次基域 = 重新部署"，而控制台里根本看不到这一项。现在：
//   - 解析优先级：**控制台保存过（含显式清空）> 环境变量**；
//   - 持有者是 baseDomainHolder（原子读）：HostGate 每请求判一次，写路径只有控制台；
//   - HostGate **无条件常挂**（空基域时 MatchHost 全判主站，等价于没挂）；
//   - 启用时（保存成非空）**照跑**启动期的两条 fail-closed 自检，不过就拒绝保存。

// baseDomainHolder 持有当前应用基域（原子读，控制台可运行期改）。
type baseDomainHolder struct {
	db  *sql.DB
	env string

	// plan 返回**当前生效**的内存四笔账计划（2026-09-19 注入 wasmLimitsHolder.Plan）。
	//
	// 为什么必须是函数而不是启动期快照：启用子域时的内存自检要与"限制项控制台保存的
	// 档位/设置"算同一份账，否则在 2 GB 机器上声明了 small 档、却因为这里仍按默认档
	// 的 2550 MiB 算账而开不了子域（两处判据分叉的经典形态）。
	plan func() readyz.MemoryPlan

	// startupErr 是**启动期**校验出的配置错误（env 或存量设置行非法）。
	//
	// 为什么要有它（2026-09-19 第三轮对抗审计 A-2）：环境变量路径此前**零校验**
	// （只 TrimSpace），`PICOAI_APPS_BASE_DOMAIN=intranet` 这类形态一路原样生效，
	// 直到第一次签发才以"浏览器丢弃 Cookie ⇒ 兑换恒失败"的形式暴露。现在两条配置
	// 路径共用 session.InspectAppBaseDomain 的判据，装配期（setupWasmPlatform）
	// 见到它就 log.Fatalf —— 拒绝启动，而不是带着一个写不出 Cookie 的基域对外服务。
	startupErr error

	value  atomic.Pointer[string]
	source atomic.Pointer[string]
}

// StartupError 返回启动期校验出的配置错误（nil = 可以启动）。
//
// 调用方（setupWasmPlatform）必须在装配期检查它并拒绝启动：这是"启动期 fail-loud"
// 的唯一落点，判据本身在 newBaseDomainHolder 里（env 与控制台设置同一份校验）。
// @returns 错误或 nil。
func (h *baseDomainHolder) StartupError() error {
	if h == nil {
		return nil
	}
	return h.startupErr
}

// SetPlanProvider 注入四笔账计划来源（装配期在 wasmLimitsHolder 建好后调用一次）。
func (h *baseDomainHolder) SetPlanProvider(fn func() readyz.MemoryPlan) {
	if h != nil {
		h.plan = fn
	}
}

// memoryPlan 返回当前计划（未注入 ⇒ 默认档，保持既有测试与最小装配的行为）。
func (h *baseDomainHolder) memoryPlan() readyz.MemoryPlan {
	if h != nil && h.plan != nil {
		return h.plan()
	}
	return readyz.DefaultMemoryPlan()
}

// newBaseDomainHolder 解析初始值：控制台设置 > 环境变量 > 空（未启用子域）。
//
// **两条配置路径共用同一份判据**（2026-09-19 第三轮对抗审计 A-2/A-6）：
//   - 环境变量：值过 normalizeBaseDomainEnv（= session.InspectAppBaseDomain 的**域名规则**
//     唯一真源，只是允许端口写法并把端口归一化掉）；
//   - 控制台设置行：值过同一个函数（控制台保存路径已校验，这里兜住手工改库/历史数据）。
//
// 任一路径非法 ⇒ 记进 startupErr（装配期拒绝启动），且**不**把非法值拿去用
// （Get() 返回空 = 子域关闭）——绝不"先把畸形基域用起来，等员工换票时才 500"。
//
// 读设置失败（DB 抖动）不算致命：回落环境变量并在日志里说清楚 —— 基域读不出来
// 不该让整个服务端起不来（与"未配置"同一条降级路径）。
// db 允许为 nil（测试/最小装配）：与 Apply 的 `h.db != nil` 同一约定，跳过设置读取。
// @param db - 平台 PG 连接（可为 nil）。
// @param envRaw - 环境变量取值（`PICOAI_APPS_BASE_DOMAIN`）。
// @returns 持有者（永远非 nil）。
func newBaseDomainHolder(db *sql.DB, envRaw string) *baseDomainHolder {
	h := &baseDomainHolder{db: db}
	if envValue, err := normalizeBaseDomainEnv(envRaw); err != nil {
		h.startupErr = fmt.Errorf("环境变量 %s=%q 非法：%w", EnvAppsBaseDomain, err.Value, err)
	} else {
		h.env = envValue
	}
	value, source := "", "none"
	var raw string
	var ok bool
	var err error
	if db != nil {
		raw, ok, err = serverstore.GetSetting(db, wasmapi.SettingAppsBaseDomain)
	}
	switch {
	case err != nil:
		log.Printf("wasm: 读应用基域设置失败（回落环境变量）：%v", err)
		if h.env != "" {
			value, source = h.env, "env"
		}
	case ok:
		// 控制台保存过（哪怕是显式清空）⇒ 以它为准，不再看环境变量。
		if settingValue, verr := normalizeBaseDomainEnv(raw); verr != nil {
			if h.startupErr == nil {
				h.startupErr = fmt.Errorf("控制台设置 %s=%q 非法：%w", wasmapi.SettingAppsBaseDomain, verr.Value, verr)
			}
		} else {
			value, source = settingValue, "setting"
		}
	case h.env != "":
		value, source = h.env, "env"
	}
	h.set(value, source)
	return h
}

// set 写入当前值（只在这里改，保证 value/source 成对更新）。
func (h *baseDomainHolder) set(value, source string) {
	v, s := value, source
	h.value.Store(&v)
	h.source.Store(&s)
}

// Get 返回当前应用基域（空 = 未启用应用子域）。HostGate 每请求调用，必须无锁快。
// @returns 当前基域（可能带 `http://` 前缀，见 normalizeBaseDomain）。
func (h *baseDomainHolder) Get() string {
	if p := h.value.Load(); p != nil {
		return *p
	}
	return ""
}

// Source 返回当前值的来源（"setting" / "env" / "none"），控制台展示用。
// @returns 来源标识。
func (h *baseDomainHolder) Source() string {
	if p := h.source.Load(); p != nil {
		return *p
	}
	return "none"
}

// Apply 保存应用基域：校验 → 启用时跑**三条** fail-closed 自检 → 落库 → 生效。
//
// 为什么自检放在**这里**而不是只在启动时：启动自检保护的是"启用子域之后的运行期
// 语义"（匿名流量不许坍缩进同一个限流桶、内存四笔账不许超），而控制台让"启用"这件
// 事可以在运行期发生 —— 只在启动时挡住等于给了一条绕过它们的路（先不配基域启动、
// 再从控制台打开）。因此保存路径复用**同一批**判据，不另写一套。
//
// 第三条自检（2026-09-19 第三轮对抗审计 A-6）：「基域真的能承载换票 nonce Cookie
// **且**与服务端对外地址同域」。判据 = session.CheckTicketNonceCapability ——
// 与运行期签发侧的 ticketNonceDecision **同一个函数**。缺了它，管理员能存下一个
// "登录可见应用必定 500"的组合，错误要等员工换票时才暴露。
// @param raw - 控制台提交的原始值（空串 = 关闭应用子域）。
// @returns nil 表示已生效；否则是可直接回给控制台的错误信封（带 hints）。
func (h *baseDomainHolder) Apply(raw string) *apperr.Error {
	next, aerr := normalizeBaseDomain(raw)
	if aerr != nil {
		return aerr
	}
	if next != "" {
		// R35：启用子域必须**显式**配置可信代理，否则全部匿名流量共用一个每 IP 桶。
		if err := anonlimit.CheckTrustedProxies(os.Getenv, true); err != nil {
			return apperr.From(err).WithDetail("field", "PICOAI_TRUSTED_PROXIES").
				WithHint("先在部署的 .env 里显式配置 PICOAI_TRUSTED_PROXIES（反代地址），再回来保存基域")
		}
		// §4.3：内存四笔账（实例池 + 编译峰值 + 上传峰值 + 缓存驻留）。
		if berr := checkStartupMemory(true, readMemoryAvailability(), h.memoryPlan(), log.Printf); berr != nil {
			return berr
		}
		// 第三条：基域可承载 Cookie 且与对外地址同域（判据与运行期签发侧同源）。
		if cap := session.CheckTicketNonceCapability(next, publicMainOrigin()); !cap.Usable {
			return baseDomainCapabilityError(next, cap)
		}
	}
	if h.db != nil {
		if err := serverstore.SetSetting(h.db, wasmapi.SettingAppsBaseDomain, next); err != nil {
			return apperr.New(apperr.CodeInternal, "保存应用基域失败").
				WithDetail("reason", err.Error()).
				WithHint("数据库写入失败；重试一次，仍失败请查看服务端日志")
		}
	}
	old := h.Get()
	h.set(next, "setting")
	log.Printf("wasm: 应用基域已更新 %q → %q（来源=控制台；应用访问地址 = 应用名 + %s）",
		old, next, domainSuffixForLog(next))
	return nil
}

// baseDomainCapabilityError 把"这条基域组合不可用"翻成控制台能直接展示的错误信封。
//
// 文案纪律：①说清**后果**（员工打开应用会 500 / 拒绝签发票），②给出**可执行动作**
// （cap.Remedy 是唯一真源，见 session 的 ticketNonceRemedy* 常量），
// ③绝不指向任何 Go 字段或平台不存在的开关。
// @param baseDomain - 待保存的基域（规范化后）。
// @param cap - 运行期同一判据给出的能力判定（Usable=false）。
// @returns 控制台错误信封。
func baseDomainCapabilityError(baseDomain string, cap session.TicketNonceCapability) *apperr.Error {
	message := "该应用基域无法承载换票 Cookie（浏览器会整条丢弃）"
	if strings.HasPrefix(cap.Reason, "main_origin_not_same_domain_as_base:") {
		message = "应用基域与服务端对外地址不同域"
	}
	return apperr.New(apperr.CodeValidation, message).
		WithDetail("reason", cap.Reason).
		WithDetail("base_domain", baseDomain).
		WithHint("保存后登录可见 / 白名单应用会**拒绝签发换票**（员工打开即 500，日志里 reason=" + cap.Reason + "）；" + cap.Remedy)
}

// domainSuffixForLog 把基域渲染成日志里的可读后缀（未启用时给一句说明）。
// @param baseDomain - 当前基域。
// @returns 日志片段。
func domainSuffixForLog(baseDomain string) string {
	if baseDomain == "" {
		return "（已关闭应用子域）"
	}
	host := strings.TrimPrefix(strings.TrimPrefix(baseDomain, "https://"), "http://")
	return "." + host
}

// normalizeBaseDomain 校验并规范化控制台提交的基域。
//
// **判据只有一份**：session.InspectAppBaseDomain（形状 + 策略，见 basedomain.go）——
// 控制台、环境变量、启动期、运行期签发闸门共用它。这里只做两件事：
//  1. 控制台额外的**拼写规则**：不接受端口写法。端口在域名规则里一律被忽略
//     （Cookie 的作用域不含端口），要求管理员写规范形态只是为了别让他以为端口有意义；
//  2. 把判定结果翻成控制台错误信封（`details.reason` + hints）。
//
// 接受：`example.com`、`apps.example.com`、`https://apps.example.com`、`http://…`
// （显式 http 表示明文部署，保留前缀）。空串 = 关闭应用子域（合法）。
// 拒绝：带端口/路径/查询、IP、单标签、公网后缀、localhost、多尾点、非法字符、
// 以及 `*.example.com`（通配符由证书与 DNS 侧配置，平台自己拼应用名）。
// @param raw - 原始输入。
// @returns 规范化后的值（可直接落库与解析）或错误信封。
func normalizeBaseDomain(raw string) (string, *apperr.Error) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	verdict := session.InspectAppBaseDomain(raw)
	if verdict.HadPort {
		return "", apperr.New(apperr.CodeValidation, "基域只能是域名本身").
			WithDetail("reason", "not_a_bare_host").
			WithHint("不要带端口、路径或查询串（只填域名，可带 http:// 前缀表示明文部署）；" +
				"端口不参与 Cookie 的作用域，写上去不会更精确")
	}
	if verdict.Reason != "" {
		return "", apperr.New(apperr.CodeValidation, verdict.Message).
			WithDetail("reason", verdict.Reason).
			WithHint(verdict.Hint)
	}
	return verdict.Value(), nil
}

// baseDomainEnvError 是启动期基域校验失败的错误（带稳定原因码与可行动作）。
//
// 为什么要类型而不是 fmt.Errorf 一句话：启动期失败信息要进日志、要能被测试逐条断言
// （原因码 + 可行动作），而且两种来源（环境变量 / 存量设置行）要给出同一份判据结论。
type baseDomainEnvError struct {
	// Value 是原始取值（原样回显，运维要能对上是哪一行配置）。
	Value string
	// Reason 是稳定原因码（与控制台 details.reason、运行期日志同一套）。
	Reason string
	// Message 是一句话说明。
	Message string
	// Hint 是可执行动作（运维能真的照着做的那种）。
	Hint string
}

// Error 实现 error（启动期日志就是这一行）。
func (e *baseDomainEnvError) Error() string {
	return e.Message + "（reason=" + e.Reason + "）⇒ " + e.Hint
}

// normalizeBaseDomainEnv 校验**启动期**的基域取值（环境变量 / 存量设置行）。
//
// 与 normalizeBaseDomain **同源**（同一个 session.InspectAppBaseDomain），差别只有拼写：
// 这里**接受**端口写法并把它归一化掉 —— 存量 `.env` 里写 `apps.example.com:8443` 是
// 常见形态，而运行期本来就忽略端口（见 session.canonicalHostOnly）⇒ 不该让升级后的
// 服务端起不来。控制台则要求规范写法（见上）。
//
// 为什么必须在启动期做（2026-09-19 第三轮对抗审计 A-2）：环境变量路径此前只 TrimSpace，
// 于是 `PICOAI_APPS_BASE_DOMAIN=intranet`（内网常见）一路原样生效 ⇒ 服务端 200 +
// `Domain=intranet`，而真 Chromium 不会把该 Cookie 交给 `my-app.intranet` ⇒ 兑换恒失败、
// 零 ERROR 零审计。现在这条判据在装配期就红灯（拒绝启动），而不是等第一次签发才发现。
// @param raw - 原始取值。
// @returns 规范化后的值（空 = 关闭子域）或带可行动作的错误。
func normalizeBaseDomainEnv(raw string) (string, *baseDomainEnvError) {
	if strings.TrimSpace(raw) == "" {
		return "", nil
	}
	verdict := session.InspectAppBaseDomain(raw)
	if verdict.Reason != "" {
		return "", &baseDomainEnvError{
			Value:   strings.TrimSpace(raw),
			Reason:  verdict.Reason,
			Message: verdict.Message,
			Hint:    verdict.Hint,
		}
	}
	return verdict.Value(), nil
}
