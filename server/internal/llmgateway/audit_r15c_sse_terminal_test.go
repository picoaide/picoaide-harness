package llmgateway

// R15C-R-02（审计 2026-09-25，P2）的判据：**上游在收尾标记之前断连必须显式收尾**。
//
// 修复前的实测形态（真 HTTP + 自写故障上游，子泳道 R 的 sse_fault_probe）：
// MODE:truncate（写完 3 块正文后断开 TCP，未发 [DONE]、未发 usage）→ 客户端拿到
// `HTTP 200 / 174 B`，body 里**既没有** `data: {"error":…}` **也没有** `data: [DONE]`，
// 服务端**新增日志 0 行**；而同函数里另外两条异常出口（idle 超时 / 单行过大）都写
// in-band error 事件。调用方因此无法区分"答完了"与"上游挂了"。
//
// 判据（变异即红）：
//   - 把 EOF 分支改回只置 lineEOF（拆掉修复）⇒
//     TestR15CUpstreamTruncationIsClosedExplicitly 红（body 里没有 error 事件）；
//   - 把"收尾标记"判据写成一律用 `[DONE]` ⇒ TestR15CNormalResponsesStreamIsNotFlagged 红
//     （正常的 Responses 流会被打成失败）；
//   - 把 finish_reason 也算收尾标记这条去掉 ⇒ TestR15CFinishReasonCountsAsTerminal 红。

import (
	"net/http"
	"strings"
	"testing"
)

// TestR15CUpstreamTruncationIsClosedExplicitly 是最核心的一条：中途断连必须给出
// in-band error 事件，且**保留**既有的"按已交付内容估算"结算语义。
func TestR15CUpstreamTruncationIsClosedExplicitly(t *testing.T) {
	f := newFakeUpstream(t)
	// 3 块正文后直接结束（没有 [DONE]、没有 usage）—— httptest 关闭响应体，
	// 网关这一侧看到的就是 EOF。
	f.streamResp = "data: {\"choices\":[{\"delta\":{\"content\":\"t0\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"t1\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\"t2\"}}]}\n\n"
	r, db, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)
	body := w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("流式响应状态 = %d, body=%q", w.Code, body)
	}
	if !strings.Contains(body, `"error"`) || !strings.Contains(body, `"UPSTREAM"`) {
		t.Fatalf("上游中途断连必须显式收尾（in-band error 事件）—— 拆掉 EOF 分支的修复即红。body=%q", body)
	}
	if !strings.Contains(body, "上游流在完成标记之前中断") {
		t.Fatalf("错误文案必须可检索, body=%q", body)
	}
	if strings.Contains(body, "[DONE]") {
		t.Fatal("被截断的流不得伪造 [DONE]（那会把失败伪装成正常收尾）")
	}
	// 已交付的正文必须原样送达（修复只加收尾信号，不改交付内容）。
	for _, want := range []string{"t0", "t1", "t2"} {
		if !strings.Contains(body, want) {
			t.Fatalf("已交付的正文 %q 丢了, body=%q", want, body)
		}
	}
	// 结算语义保留：仍按已交付内容估算（不是"删行免单"）。
	var rows int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows == 0 {
		t.Fatal("结算语义不得改变：已交付正文的被截断流仍要落一条 usage（修复只加收尾信号）")
	}
}

// TestR15CNormalStreamIsNotFlagged 是**反向对照**（判据的另一半）：正常以
// `data: [DONE]` 收尾的流**不得**出现 error 事件 —— 否则修复本身会把正常流判成失败。
func TestR15CNormalStreamIsNotFlagged(t *testing.T) {
	f := newFakeUpstream(t) // 缺省 streamResp 就是"正文 + usage + [DONE]"
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)
	body := w.Body.String()
	if !strings.Contains(body, "[DONE]") {
		t.Fatalf("正常流应带 [DONE], body=%q", body)
	}
	if strings.Contains(body, `"error"`) {
		t.Fatalf("正常收尾的流不得出现 error 事件, body=%q", body)
	}
}

// TestR15CNormalResponsesStreamIsNotFlagged：Responses 协议的收尾标记是
// `response.completed`（**不发** [DONE]）。拿 [DONE] 当唯一判据会把每一条正常
// Responses 流打成失败 —— 这一条就是那个假阳性的对照面。
func TestR15CNormalResponsesStreamIsNotFlagged(t *testing.T) {
	f := newFakeUpstream(t)
	f.streamResp = "event: response.output_text.delta\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\n\n" +
		"event: response.completed\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r1\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}}\n\n"
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/responses",
		`{"model":"deepseek-chat","stream":true,"input":"hi"}`, token, nil)
	body := w.Body.String()
	if strings.Contains(body, `"error"`) {
		t.Fatalf("以 response.completed 收尾的正常流被误判为截断（判据只认 [DONE] 就会这样）, body=%q", body)
	}
	if !strings.Contains(body, "response.completed") {
		t.Fatalf("正常 Responses 流的内容应原样送达, body=%q", body)
	}
}

// TestStreamTerminalMarkerSeen 是判据本身的单元面：哪些形态算"见过收尾标记"。
func TestStreamTerminalMarkerSeen(t *testing.T) {
	for _, tc := range []struct {
		line string
		want bool
		why  string
	}{
		{"data: [DONE]", true, "chat/completions 的哨兵"},
		{"data:[DONE]", true, "无空格的写法"},
		{"data: [DONE]\n", true, "带换行"},
		{`data: {"choices":[{"delta":{"content":"x"}}]}`, false, "正文增量"},
		{`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`, true, "模型声明收尾（兼容上游常不发 [DONE]）"},
		{`data: {"choices":[{"delta":{},"finish_reason":null}]}`, false, "finish_reason 为 null 不算"},
		{`data: {"usage":{"prompt_tokens":1,"completion_tokens":2}}`, false, "usage 行不是收尾标记"},
		{"event: response.completed", true, "Responses 终结事件"},
		{"event: message_stop", true, "Anthropic 终结事件"},
		{`data: {"type":"response.completed","response":{}}`, true, "Responses 终结事件（JSON type）"},
		{`data: {"type":"response.output_text.done"}`, false, "分段 .done 事件**不是**终结（后缀匹配即假绿）"},
		{": keep-alive", false, "注释/心跳"},
		{"", false, "空行"},
		{"id: 42", false, "id 行"},
		{`{"choices":[{"message":{"content":"whole"}}],"usage":{"prompt_tokens":1}}`, true, "整包 JSON（忽略 stream 的上游）"},
	} {
		if got := streamTerminalMarkerSeen(tc.line); got != tc.want {
			t.Errorf("streamTerminalMarkerSeen(%q) = %v, want %v（%s）", tc.line, got, tc.want, tc.why)
		}
	}
}

// TestR15CTruncationHappensOnlyWithoutMarker：把"见过标记但随后断连"与"没见标记就
// 断连"分开 —— 前者是上游少发哨兵（可容忍），后者是真截断（必须报）。
func TestR15CTruncationHappensOnlyWithoutMarker(t *testing.T) {
	f := newFakeUpstream(t)
	f.streamResp = "data: {\"choices\":[{\"delta\":{\"content\":\"t0\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2}}\n\n"
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`, token, nil)
	body := w.Body.String()
	if strings.Contains(body, `"error"`) {
		t.Fatalf("上游已用 finish_reason 声明收尾时不得判为截断, body=%q", body)
	}
	if !strings.Contains(body, `"finish_reason":"stop"`) || !strings.Contains(body, "t0") {
		t.Fatalf("正文与收尾块必须原样送达, body=%q", body)
	}
}

// TestR15CAnthropicTruncationIsClosedExplicitly：同一条缺陷在 `/v1/messages`
// （Anthropic 协议）上的同源出口（R15C-R-02 报告标注为"结构同源但未实测"）。
//
// 收尾标记必须按协议区分：Anthropic 是 `event: message_stop`，拿 `[DONE]` 判会把
// 每一条正常的 anthropic 流打成异常（反向对照见同文件的两个 Normal 用例）。
func TestR15CAnthropicTruncationIsClosedExplicitly(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	// 截断形态：message_start + 一块正文，**没有** message_delta / message_stop。
	f.streamResp = `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}

`
	r, _, token := newMessagesGateway(t, f)
	w := doMessagesPost(t, r, `{"model":"deepseek-v4-flash","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, token)
	body := w.Body.String()
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%q", w.Code, body)
	}
	if !strings.Contains(body, `"error"`) || !strings.Contains(body, "上游流在完成标记之前中断") {
		t.Fatalf("anthropic 流中途断连同样必须显式收尾（in-band error 事件）, body=%q", body)
	}
	if !strings.Contains(body, "hi") {
		t.Fatalf("已交付正文必须原样送达, body=%q", body)
	}

	// 反向对照：带 message_stop 的正常 anthropic 流不得出现 error 事件。
	f2 := newFakeAnthropicUpstream(t)
	r2, _, token2 := newMessagesGateway(t, f2)
	w2 := doMessagesPost(t, r2, `{"model":"deepseek-v4-flash","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"hi"}]}`, token2)
	if b := w2.Body.String(); strings.Contains(b, `"error"`) {
		t.Fatalf("以 message_stop 收尾的正常 anthropic 流不得被判为截断, body=%q", b)
	}
}
