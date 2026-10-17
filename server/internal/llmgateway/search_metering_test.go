package llmgateway

import "testing"

func TestCountWebSearchesNonStream(t *testing.T) {
	body := `{"id":"msg_x","content":[
		{"type":"text","text":"hi"},
		{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]},
		{"type":"web_search_tool_result","content":[
			{"type":"web_search_result","url":"https://b.example"},
			{"type":"web_search_result","url":"https://c.example"}
		]}
	],"usage":{"input_tokens":10,"output_tokens":2}}`
	if got := countWebSearches([]byte(body)); got != 2 {
		t.Fatalf("countWebSearches = %d, want 2（一个结果块算一次，块内多条结果不重复计）", got)
	}
}

func TestCountWebSearchesIgnoresErrorAndEmpty(t *testing.T) {
	body := `{"content":[
		{"type":"web_search_tool_result","content":{"type":"web_search_tool_result_error","error_code":"unavailable"}},
		{"type":"web_search_tool_result","content":[]},
		{"type":"web_search_tool_result"},
		{"type":"text","text":"no search here"}
	],"usage":{"input_tokens":1,"output_tokens":1}}`
	if got := countWebSearches([]byte(body)); got != 0 {
		t.Fatalf("countWebSearches = %d, want 0（错误块/空结果不计费）", got)
	}
}

// 上游自报 usage.server_tool_use.web_search_requests 比结果块更权威：
// 两者都有时取较大值（不是相加，描述的是同一批搜索）。
func TestCountWebSearchesPrefersReported(t *testing.T) {
	body := `{"content":[
		{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]}
	],"usage":{"input_tokens":1,"output_tokens":1,"server_tool_use":{"web_search_requests":3}}}`
	if got := countWebSearches([]byte(body)); got != 3 {
		t.Fatalf("countWebSearches = %d, want 3（自报值优先）", got)
	}
}

func TestSearchMeterStreamEvents(t *testing.T) {
	lines := []string{
		`data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}`,
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]}}`,
		// 同一 index 重复出现（异常上游）：只算一次
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]}}`,
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","content":[]}}`,
		`data: {"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://b.example"}]}}`,
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5,"server_tool_use":{"web_search_requests":1}}}`,
		`data: [DONE]`,
	}
	var m searchMeter
	for _, line := range lines {
		m.observe([]byte(line))
	}
	if got := m.count(); got != 2 {
		t.Fatalf("stream count = %d, want 2（index 0 与 2 各一次；空结果与重复 index 不计）", got)
	}
}

// 负的自报次数（上游可控）不得产生负费用。
func TestSearchMeterNegativeReported(t *testing.T) {
	var m searchMeter
	m.observe([]byte(`{"usage":{"server_tool_use":{"web_search_requests":-5}}}`))
	if got := m.count(); got != 0 {
		t.Fatalf("negative reported count = %d, want 0", got)
	}
}
