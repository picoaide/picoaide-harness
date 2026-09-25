package llmgateway

// 应用会话 id 的**解析唯一实现**（应用维度归因的入口，契约 §21.4 / §21.7⑤）。
//
// ## 为什么归因读会话 id 而不是自报头
//
// 设计总纲 §21.4 原本要求客户端在出站请求上带 `X-Pico-App-Id`。实施期实测发现那条路
// **走不通**（§21.7⑤）：chat 出站头的唯一构造点在上游 `llm-deepseek` 的 adapter 里，
// 而 `GenerateOptions` / `LlmCallConfig` / 深冻结的 `llm/stream` 都没有 header 通道 ⇒
// 在不改上游 submodule 的前提下这个头永远发不出去，管理端面板恒显示"无归因"。
//
// 替代路径（主控 2026-09-20 裁定）：**隐藏会话 id 本身就是身份**。应用 AI 的隐藏会话
// id 形如 `app:<app_id>…`，而出站头 `x-deepseek-harness-session-id` 由上游按
// `options.sessionId` **无条件**带上（`llm-deepseek` 的 chat-completions / messages
// 两个适配器都写它）⇒ 服务端按前缀派生 `app_id` 即可，不需要新头。
//
// 它同时把 §21.4 的另一半判据变成了可实现的东西：**非应用会话请求不得归因** ——
// 只有"会话 id 带 `app:` 前缀"这一条链路会产生标签，裸的自报头一律忽略（见
// `appIDFromRequest` 的 legacy 分支）。
//
// ⚠️ R14-K（D-04）口径订正：**前缀并不比自报头"更可信"** —— 它同样由客户端构造
// （隐藏会话 id 在客户端侧拼出，网关只看到一个请求头）。这条链路带来的是
// **可归因性**（有形状、可校验存在性），**不是**可信性：服务端到今天也没有
// "该会话确属该应用"的凭据链路可查。所以本文件的 `AppIDFromSessionID` 只回答
// "客户端声称是哪个应用"，不回答"这个声称是否真实"；真实的只有
// `usage.user_id`（来自鉴权中间件）。
//
// ## 单一真源
//
// id 的**形状**（前缀 / 作用域分隔符 / app_id 规则与上限 / 出站头名）唯一真源是本目录的
// `app-session-id.json`：本文件把它 `go:embed` 进来，在包初始化时**逐字**使用（正则也从
// 那里的字符串编译），所以 Go 侧不存在"另一份正则"可漂移。客户端（`ai-chat.ts`）是它的
// 镜像，由 `header-spec-parity.spec.ts` 同族的对拍用例 + 同一份 `build_cases` 语料钉住。
//
// ⚠️ 改形状 = 改跨端契约：必须同时改 JSON、重跑两端用例；`app-session-id-contract.spec.ts`
// （TS）与 `TestAppSessionIDContractCases`（Go）会各红一边（这是**有意**的红）。

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// appSessionIDContractJSON 是契约原文（单一真源）。schema 不匹配即 panic ——
// 契约变了就必须有人来对齐两端，绝不静默按旧规则解析（那正是"归因悄悄消失"的形状）。
//
//go:embed app-session-id.json
var appSessionIDContractJSON []byte

// appSessionIDContractSchema 是本文件能解析的契约版本。
const appSessionIDContractSchema = "picoaide-app-session-id/1"

// appSessionIDBuildCase 是"（账号, 服务端, 应用）⇒ 会话 id"的语料行（客户端构造方向）。
type appSessionIDBuildCase struct {
	User      string `json:"user"`
	ServerURL string `json:"server_url"`
	AppID     string `json:"app_id"`
	SessionID string `json:"session_id"`
}

// appSessionIDParseCase 是"会话 id ⇒ app_id"的语料行（服务端解析方向）。
//
// `app_id` 为空串 = **不得归因**（不是应用会话 / app_id 不合法）。
type appSessionIDParseCase struct {
	SessionID string `json:"session_id"`
	AppID     string `json:"app_id"`
	Note      string `json:"note"`
}

// appSessionIDContract 是 JSON 的结构投影（字段名与文件逐字对应）。
type appSessionIDContract struct {
	Schema          string                  `json:"schema"`
	Prefix          string                  `json:"prefix"`
	ScopeSeparator  string                  `json:"scope_separator"`
	AppIDPattern    string                  `json:"app_id_pattern"`
	AppIDMaxLength  int                     `json:"app_id_max_length"`
	SessionIDHeader string                  `json:"session_id_header"`
	LegacyForm      string                  `json:"legacy_form"`
	ScopeEncoding   string                  `json:"scope_encoding"`
	BuildCases      []appSessionIDBuildCase `json:"build_cases"`
	ParseCases      []appSessionIDParseCase `json:"parse_cases"`

	// appIDRe 由 AppIDPattern 编译而来（不来自 JSON 的第二个字段：正则只有一处）。
	appIDRe *regexp.Regexp
}

// appSessionID 是包级加载好的契约（初始化即校验，坏契约不让进程起来）。
var appSessionID = mustLoadAppSessionIDContract()

func mustLoadAppSessionIDContract() appSessionIDContract {
	var contract appSessionIDContract
	if err := json.Unmarshal(appSessionIDContractJSON, &contract); err != nil {
		panic(fmt.Sprintf("llmgateway: 应用会话 id 契约（app-session-id.json）不是合法 JSON: %v", err))
	}
	if contract.Schema != appSessionIDContractSchema {
		panic(fmt.Sprintf("llmgateway: 应用会话 id 契约 schema = %q，本文件只认 %q",
			contract.Schema, appSessionIDContractSchema))
	}
	for name, value := range map[string]string{
		"prefix":            contract.Prefix,
		"scope_separator":   contract.ScopeSeparator,
		"app_id_pattern":    contract.AppIDPattern,
		"session_id_header": contract.SessionIDHeader,
	} {
		if strings.TrimSpace(value) == "" {
			panic(fmt.Sprintf("llmgateway: 应用会话 id 契约缺 %s", name))
		}
	}
	if contract.AppIDMaxLength <= 0 {
		panic("llmgateway: 应用会话 id 契约缺 app_id_max_length")
	}
	compiled, err := regexp.Compile(contract.AppIDPattern)
	if err != nil {
		panic(fmt.Sprintf("llmgateway: 应用会话 id 契约的 app_id_pattern 不是合法正则: %v", err))
	}
	contract.appIDRe = compiled
	return contract
}

// AppIDFromSessionID 从句柄会话 id 派生**应用标识**（无归因时返回空串）。
//
// 形态（唯一真源 = `app-session-id.json`）：
//
//	app:<app_id>[#<账号作用域>]
//
// 三条规则：
//
//	① 前缀逐字匹配（大小写敏感）。普通会话（`session-…`）与任何别的 id 一律不归因；
//	② **app_id 是前缀之后到第一个作用域分隔符之间的那段**，所以账号作用域可以自由
//	   演化（加字段、换编码）而不会动摇归因口径 —— 这正是把 app_id 放在**前面**而不是
//	   `app:<user>:<app_id>` 的理由（那种形态需要"从右往左数第二段"，一旦用户名里出现
//	   分隔符就得靠猜）；
//	③ 取出来的那段必须**仍是平台认的 app_id**（长度 + 形状）：伪造一个
//	   `app:<任意串>` 的头不会产生任何标签，非法值退化成"无归因"而不是一行脏数据。
//
// 历史形态 `app:<app_id>`（无账号维度）**继续归因**：那是 2026-09-24 之前客户端写下的
// 会话 id（历史会话仍可诊断）以及还没升级的旧客户端；它与新形态是同一个应用，归因口径
// （每条 usage 本来就有 user_id）不受影响。
//
// @param sessionID 出站头 `x-deepseek-harness-session-id` 的值（会话 id 原文）。
// @return 合法则返回 app_id；否则空串（=无归因，绝不影响计费）。
func AppIDFromSessionID(sessionID string) string {
	contract := appSessionID
	if !strings.HasPrefix(sessionID, contract.Prefix) {
		return ""
	}
	rest := sessionID[len(contract.Prefix):]
	if index := strings.Index(rest, contract.ScopeSeparator); index >= 0 {
		rest = rest[:index]
	}
	if rest == "" || len(rest) > contract.AppIDMaxLength {
		return ""
	}
	if !contract.appIDRe.MatchString(rest) {
		return ""
	}
	return rest
}

// appSessionIDHeaderName 是出站会话 id 头名（真源在 JSON；这里只是取用）。
func appSessionIDHeaderName() string {
	return appSessionID.SessionIDHeader
}

// legacyAppIDHeader 是**已废弃**的自报归因头（§21.4 的初版设计）。见 `app_attribution.go`。
const legacyAppIDHeader = "X-Pico-App-Id"
