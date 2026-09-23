package api

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ============================================================================
// 请求头白名单的**单一真源**（R1-CLI-5 / R2I-11）
// ============================================================================
//
// 问题（审计原文）：客户端转发哪些头、平台接受哪些头，两端各写了一份（客户端是
// 短黑名单、平台是长白名单），于是 Chromium 的 `sec-ch-ua*` / `priority` 这类头
// 会让**整次导航 400** —— 而两端的表都在自己那侧"看起来是对的"。
//
// 冻结做法（契约 §5.1 + §16 W1 第 ⑥ 条）：
//   - **Go 常量是本文件的唯一真源**（`EnvelopeRequestHeaders` 有序切片）；
//   - 生成 `wasm-app-headers.json` 供客户端（L2）对拍（生成器
//     `cmd/wasm-app-headers-gen`，`go generate ./internal/wasmapp/api`）；
//   - 对拍方向 = 客户端断言"我转发的集合 == 生成物里的集合"，多一个少一个都红。
//
// 为什么是**有序切片 + map 由它派生**（而不是直接写 map）：生成物必须稳定可比
// （map 迭代序随机），且报错提示里要能给出一个确定的清单（顺序 = 文档顺序）。

// EnvelopeRequestHeaders 是**客户端协议 handler 允许转发**的请求头（白名单，有序）。
//
// 与 `appserver.frameHeaderAllowlist` 的关系（两张表**不同**，刻意不合并）：
//   - frameHeaderAllowlist 决定**应用能看到什么**（只有 content-type/accept/accept-language）；
//   - 本表决定**平台能看到什么** —— 多出来的 `origin` 是跨源写判据的输入（由协议
//     handler **合成**，契约 §4.3），if-none-match/if-modified-since 是静态资源缓存
//     判据，user-agent/x-requested-with 只用于诊断。
//
// 为什么**没有** cookie / referer / sec-fetch-*（2026-09-19 契约 §3 的实测结论）：
// 自定义协议下浏览器一个都不发（Cookie 完全不落盘、Referer 与 Sec-Fetch-* 全为
// null），留在白名单里只会给"伪造一个不存在的头"留下面，而平台没有任何判据需要它们。
//
// ⚠️ 改这张表 = 改跨端契约：必须同时重跑生成器（`go generate ./internal/wasmapp/api`）
// 并把 `wasm-app-headers.json` 一起提交，否则客户端对拍会红（这是**有意**的红）。
var EnvelopeRequestHeaders = []string{
	"origin",
	"content-type",
	"accept",
	"accept-language",
	"if-none-match",
	"if-modified-since",
	"user-agent",
	"x-requested-with",
}

// clientRequestHeaders 是白名单的查询视图（由 EnvelopeRequestHeaders 派生）。
var clientRequestHeaders = func() map[string]struct{} {
	m := make(map[string]struct{}, len(EnvelopeRequestHeaders))
	for _, h := range EnvelopeRequestHeaders {
		m[h] = struct{}{}
	}
	return m
}()

// EnvelopeHeaderHint 返回给调用方看的白名单提示（顺序与真源一致）。
//
// 为什么要有它：400 的 hints 必须能**穷举**合法取值，否则作者只能二分试错
// （审计 CLI-5 的现场就是"少一个头就整次导航失败，且提示里看不出少了哪个"）。
func EnvelopeHeaderHint() string {
	return strings.Join(EnvelopeRequestHeaders, "/")
}

// ============================================================================
// 生成物（供客户端对拍）
// ============================================================================

// HeadersSpecSchema 是 wasm-app-headers.json 的格式版本（消费方据此判断能否解析）。
const HeadersSpecSchema = "picoaide-wasm-app-headers/1"

// HeadersLimits 是信封里与头相关的**传输层上限**（与 clientreq.go 的常量同源）。
type HeadersLimits struct {
	// HeaderCountMax 是信封 `headers` 的条数上限。
	HeaderCountMax int `json:"header_count_max"`
	// HeaderValueBytesMax 是单个头值的字节上限。
	HeaderValueBytesMax int `json:"header_value_bytes_max"`
	// HeaderNameBytesMax 是单个头名的字节上限。
	HeaderNameBytesMax int `json:"header_name_bytes_max"`
	// PathBytesMax / QueryBytesMax 是信封 path/query 的上限（同属"信封形状"契约）。
	PathBytesMax  int `json:"path_bytes_max"`
	QueryBytesMax int `json:"query_bytes_max"`
	// EnvelopeBytesMax 是信封请求体的上限（由应用请求体上限派生，见 clientreq.go）。
	EnvelopeBytesMax int64 `json:"envelope_bytes_max"`
	// RequestBodyBytesMax / ResponseBodyBytesMax 是应用请求/响应体的权威上限。
	RequestBodyBytesMax  int64 `json:"request_body_bytes_max"`
	ResponseBodyBytesMax int64 `json:"response_body_bytes_max"`
}

// HeadersPlatform 是**平台与协议 handler 之间**的头（不进应用信封）。
//
// 与 EnvelopeRequestHeaders 分开描述的理由：这两组头的消费者不同（前者是"应用能看到
// 什么"，这里是"平台看到什么/平台告诉客户端什么"），合并会让读者以为它们可以互换。
type HeadersPlatform struct {
	// ProofRequest 是持有性证明的携带头（契约 §20.1）。
	ProofRequest string `json:"proof_request"`
	// AppVersionResponse 是**生效版本**的响应头（缓存键的唯一来源，§5.1）。
	AppVersionResponse string `json:"app_version_response"`
	// RequestIDResponse 是关联标识的响应头（OPS-6 可观测性：日志与客户端对齐）。
	RequestIDResponse string `json:"request_id_response"`
}

// HeadersDoc 是 `wasm-app-headers.json` 的内容（生成器唯一的输入）。
type HeadersDoc struct {
	Schema string `json:"schema"`
	// Note 说明这份产物的用途与"谁是权威"，让读者不必翻代码。
	Note            string          `json:"note"`
	RequestHeaders  []string        `json:"request_headers"`
	Limits          HeadersLimits   `json:"limits"`
	PlatformHeaders HeadersPlatform `json:"platform_headers"`
}

// HeadersSpec 返回生成物的内容（**有序、可逐字节对拍**）。
func HeadersSpec() HeadersDoc {
	return HeadersDoc{
		Schema: HeadersSpecSchema,
		Note: "跨端请求头白名单（单一真源 = server/internal/wasmapp/api/headerspec.go）。" +
			"客户端必须转发且只转发 request_headers 里的头；多一个或少一个都会让导航/请求 400。" +
			"本文件由 go generate ./internal/wasmapp/api 生成，不要手改。" +
			"response_body_bytes_max 是**可交付**口径（= 单帧预算的一半，见 abi.MaxResponseBodyBytes）：" +
			"应用响应体必须装进一个协议帧（单帧负载上限 abi.MaxFrameBytes = 1 MiB），" +
			"所以 8 MiB 那类数字是不可达的（2026-09-23 审计 ABI-1）。",
		RequestHeaders: append([]string(nil), EnvelopeRequestHeaders...),
		Limits: HeadersLimits{
			HeaderCountMax:      maxClientHeaderCount,
			HeaderValueBytesMax: maxClientHeaderBytes,
			HeaderNameBytesMax:  maxClientHeaderNameSize,
			PathBytesMax:        maxClientPathBytes,
			QueryBytesMax:       maxClientQueryBytes,
			EnvelopeBytesMax:    maxClientEnvelopeBytes,
			RequestBodyBytesMax: limits.AppRequestBodyMaxBytes,
			// 真实口径（可交付）而不是 8 MiB：响应体必须装进一个帧。
			// 单一真源 = abi.MaxResponseBodyBytes（见那里的推导与实测）。
			ResponseBodyBytesMax: abi.MaxResponseBodyBytes,
		},
		PlatformHeaders: HeadersPlatform{
			ProofRequest:       proofHeader,
			AppVersionResponse: edge.AppVersionHeader,
			RequestIDResponse:  requestIDHeader,
		},
	}
}

// RenderHeadersJSON 渲染 `wasm-app-headers.json`（缩进 2 空格 + 末尾换行）。
//
// 用 json.MarshalIndent 而不是手写模板：字段顺序由结构体固定，与 limits 生成器
// 同一手法（可逐字节对拍）。
func RenderHeadersJSON() []byte {
	buf, err := json.MarshalIndent(HeadersSpec(), "", "  ")
	if err != nil {
		panic("api: 编码 wasm-app-headers.json: " + err.Error())
	}
	return append(buf, '\n')
}

// SortedEnvelopeHeaders 返回白名单的**排序副本**（供对拍用例做集合比较）。
func SortedEnvelopeHeaders() []string {
	out := append([]string(nil), EnvelopeRequestHeaders...)
	sort.Strings(out)
	return out
}
