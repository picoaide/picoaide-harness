package llmgateway

import (
	"bytes"
	"encoding/json"
)

// searchMeter 统计一条 Anthropic Messages 响应里**成功返回网页结果的
// web_search 次数**（0085，DeepSeek Search 按次计费）。
//
// 两个来源，取较大值而不是相加（两者描述的是同一批搜索）：
//  1. 上游在 usage.server_tool_use.web_search_requests 里自报的次数 ——
//     这是最权威的口径（Anthropic 兼容协议的标准字段）；
//  2. 响应里的 web_search_tool_result 内容块 —— 上游没报 usage 时的兜底。
//
// 只统计**真的带回网页结果**的块：官方 Search API 的计费规则是"HTTP 200 且
// 产生结果才计费（results 必须非空）"，服务端工具调用沿用同一判据；错误块
// （content 是 web_search_tool_result_error 对象）与空结果块都不计费。
//
// 非流式：整份响应体调用一次 observe，content[] 里每个块按数组下标去重。
// 流式：每个 data: 行调用 observe，content_block_start 按 index 去重
// （同一 index 重复出现只算一次）。
type searchMeter struct {
	seen     map[int]struct{}
	blocks   int
	reported int64
}

// searchUsage 只取我们关心的 server_tool_use.web_search_requests。
type searchUsage struct {
	ServerToolUse *struct {
		WebSearchRequests *int64 `json:"web_search_requests"`
	} `json:"server_tool_use"`
}

// searchEvent 是**一份 JSON** 里可能出现的三种形状的并集：
// 非流式响应体（content[]）、流式 content_block_start（content_block + index）、
// 以及带 usage 的 message_start / message_delta（usage 或 message.usage）。
type searchEvent struct {
	Index        *int              `json:"index"`
	Content      []json.RawMessage `json:"content"`
	ContentBlock json.RawMessage   `json:"content_block"`
	Usage        *searchUsage      `json:"usage"`
	Message      *struct {
		Usage *searchUsage `json:"usage"`
	} `json:"message"`
}

// observe 解析一份响应体/SSE 行并累积计数。无法解析的输入直接忽略
// （计量不能因为上游多打一行日志就拒绝整条流）。
func (m *searchMeter) observe(raw []byte) {
	data := bytes.TrimSpace(raw)
	data = bytes.TrimSpace(bytes.TrimPrefix(data, []byte("data:")))
	if len(data) == 0 || bytes.Equal(data, []byte("[DONE]")) {
		return
	}
	var ev searchEvent
	if err := json.Unmarshal(data, &ev); err != nil {
		return
	}
	if ev.Usage != nil {
		m.noteReported(ev.Usage)
	}
	if ev.Message != nil && ev.Message.Usage != nil {
		m.noteReported(ev.Message.Usage)
	}
	// 非流式完整响应：content[] 的下标就是去重键。
	for i, block := range ev.Content {
		if webSearchResultBlockHasResults(block) {
			m.mark(i)
		}
	}
	// 流式 content_block_start：index 是协议里的块序号。
	if len(ev.ContentBlock) > 0 && webSearchResultBlockHasResults(ev.ContentBlock) {
		idx := 0
		if ev.Index != nil {
			idx = *ev.Index
		}
		m.mark(idx)
	}
}

func (m *searchMeter) noteReported(u *searchUsage) {
	if u == nil || u.ServerToolUse == nil || u.ServerToolUse.WebSearchRequests == nil {
		return
	}
	if n := *u.ServerToolUse.WebSearchRequests; n > m.reported {
		m.reported = n
	}
}

func (m *searchMeter) mark(index int) {
	if m.seen == nil {
		m.seen = make(map[int]struct{})
	}
	if _, ok := m.seen[index]; ok {
		return
	}
	m.seen[index] = struct{}{}
	m.blocks++
}

// count 返回本次请求应计费的搜索次数：自报值与结果块数取较大者。
// 负值（上游可控字段）一律按 0。
func (m *searchMeter) count() int64 {
	if m.reported < 0 {
		m.reported = 0
	}
	if m.reported > int64(m.blocks) {
		return m.reported
	}
	return int64(m.blocks)
}

// webSearchResultBlockHasResults 判断一个内容块是否是**带回至少一条网页结果**
// 的 web_search_tool_result。
//
// 错误结果是对象（{"type":"web_search_tool_result_error",…}）而不是数组，
// 反序列化到切片会失败 ⇒ 返回 false；空数组 / 只有非 web_search_result 项
// 的块同样不计费（与官方"results 必须非空才计费"同口径）。
func webSearchResultBlockHasResults(raw json.RawMessage) bool {
	var block struct {
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &block); err != nil {
		return false
	}
	if block.Type != "web_search_tool_result" || len(block.Content) == 0 {
		return false
	}
	var items []struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(block.Content, &items); err != nil {
		return false
	}
	for _, item := range items {
		if item.Type == "web_search_result" {
			return true
		}
	}
	return false
}

// countWebSearches 是一次性统计（非流式响应体）的入口。
func countWebSearches(body []byte) int64 {
	var m searchMeter
	m.observe(body)
	return m.count()
}
