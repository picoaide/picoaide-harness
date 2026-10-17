package llmgateway

import (
	"math"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestMessagesBillSearchRequests 端到端覆盖 0085 的非流式路径：
// 响应里两个成功的 web_search_tool_result → search_requests=2，
// cost = token 费用 + 2 × 5/1000。
func TestMessagesBillSearchRequests(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	f.nonStream = `{"id":"msg_x","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[
		{"type":"text","text":"hi"},
		{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]},
		{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://b.example"},{"type":"web_search_result","url":"https://c.example"}]}
	],"usage":{"input_tokens":1000,"output_tokens":100}}`
	r, db, token := newMessagesGateway(t, f)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 4, cache_input_price_per_1m = 1 WHERE name = 'deepseek-v4-flash'`); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateModelConfig()
	if err := serverstore.SetSetting(db, serverstore.SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"deepseek-v4-flash","max_tokens":1024,"messages":[{"role":"user","content":"search"}]}`
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var searches int64
	var cost float64
	if err := db.QueryRow(`SELECT search_requests, cost FROM usage`).Scan(&searches, &cost); err != nil {
		t.Fatalf("usage row: %v", err)
	}
	if searches != 2 {
		t.Fatalf("search_requests = %d, want 2", searches)
	}
	// 1000/1M×1 + 100/1M×4 + 2×(5/1000) = 0.001 + 0.0004 + 0.01
	const want = 0.0114
	if math.Abs(cost-want) > 1e-12 {
		t.Fatalf("cost = %v, want %v", cost, want)
	}
}

// TestMessagesBillSearchRequestsStream 覆盖流式路径：搜索结果块先于
// message_delta 到达，回填时必须把次数带进 usage 行。
func TestMessagesBillSearchRequestsStream(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	f.streamResp = `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://a.example"}]}}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","content":[]}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

`
	r, db, token := newMessagesGateway(t, f)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 4, cache_input_price_per_1m = 1 WHERE name = 'deepseek-v4-flash'`); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateModelConfig()
	if err := serverstore.SetSetting(db, serverstore.SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"deepseek-v4-flash","max_tokens":1024,"stream":true,"messages":[{"role":"user","content":"search"}]}`
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var searches int64
	var cost float64
	if err := db.QueryRow(`SELECT search_requests, cost FROM usage`).Scan(&searches, &cost); err != nil {
		t.Fatalf("usage row: %v", err)
	}
	if searches != 1 {
		t.Fatalf("search_requests = %d, want 1（空结果块不计费）", searches)
	}
	// 10/1M×1 + 5/1M×4 + 1×(5/1000) = 0.00001 + 0.00002 + 0.005
	const want = 0.00503
	if math.Abs(cost-want) > 1e-12 {
		t.Fatalf("cost = %v, want %v", cost, want)
	}
}

// TestMessagesSearchErrorNotBilled：上游返回搜索错误块时不计次、不加收，
// token 费用照常记。
func TestMessagesSearchErrorNotBilled(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	f.nonStream = `{"id":"msg_x","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[
		{"type":"web_search_tool_result","content":{"type":"web_search_tool_result_error","error_code":"unavailable"}}
	],"usage":{"input_tokens":1000,"output_tokens":100}}`
	r, db, token := newMessagesGateway(t, f)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 4, cache_input_price_per_1m = 1 WHERE name = 'deepseek-v4-flash'`); err != nil {
		t.Fatal(err)
	}
	serverstore.InvalidateModelConfig()
	if err := serverstore.SetSetting(db, serverstore.SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}

	body := `{"model":"deepseek-v4-flash","max_tokens":1024,"messages":[{"role":"user","content":"search"}]}`
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	var searches int64
	var cost float64
	if err := db.QueryRow(`SELECT search_requests, cost FROM usage`).Scan(&searches, &cost); err != nil {
		t.Fatalf("usage row: %v", err)
	}
	if searches != 0 {
		t.Fatalf("search_requests = %d, want 0（错误块不计费）", searches)
	}
	const want = 0.0014
	if math.Abs(cost-want) > 1e-12 {
		t.Fatalf("cost = %v, want %v", cost, want)
	}
}
