package llmgateway

// 审计 2026-09-13 P0-1 / P2-10 的永久回归测试(取代临时探针)。
//
// P0-1:客户端传 stream_options.include_usage=false 时,服务端必须强制覆盖为
// true;即使上游仍然不回报 usage,结算也必须按请求体字节兜底估算 prompt 侧,
// 否则"输入免费"(旧实现:同一 prompt 默认记 1234 输入 token,关闭后记 0)。

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// usageRow 读一行 usage(按 id 升序),字段是本组用例的断言对象。
type usageRow struct {
	prompt, completion int64
	cost               float64
	estimated          bool
}

func TestStreamUsageCannotBeDisabledByClient(t *testing.T) {
	// 真实 OpenAI 语义:usage 块只在 include_usage=true 时下发。
	f := &fakeUpstream{status: http.StatusOK}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.gotBody.Store(string(body))
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		if strings.Contains(string(body), `"include_usage":true`) {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1234,\"completion_tokens\":5}}\n\n")
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL

	r, db, token := newGateway(t, f)
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m=10, output_price_per_1m=10 WHERE name='deepseek-chat'`); err != nil {
		t.Fatal(err)
	}

	// 攻击形态:客户端显式关闭 usage 回报
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"stream_options":{"include_usage":false},"messages":[{"role":"user","content":"你好"}]}`,
		token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if sent := f.gotBody.Load().(string); !strings.Contains(sent, `"include_usage":true`) {
		t.Fatalf("发往上游的请求体未强制 include_usage=true: %s", sent)
	}

	var prompt, completion int64
	var cost float64
	if err := db.QueryRow(`SELECT prompt_tokens, completion_tokens, cost FROM usage ORDER BY id DESC LIMIT 1`).
		Scan(&prompt, &completion, &cost); err != nil {
		t.Fatal(err)
	}
	if prompt <= 0 {
		t.Fatalf("prompt_tokens = %d, want > 0(客户端不得能关闭输入侧计量)", prompt)
	}
	if cost <= 0 {
		t.Fatalf("cost = %v, want > 0", cost)
	}
	t.Logf("客户端关闭 include_usage 后仍落账: prompt=%d completion=%d cost=%.6f", prompt, completion, cost)
}

// 上游完全忽略 include_usage(或流在 usage 行之前中断)时,prompt 侧也必须兜底。
func TestStreamPromptFallbackWhenUpstreamOmitsUsage(t *testing.T) {
	f := &fakeUpstream{status: http.StatusOK}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		// 永不回报 usage
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL

	r, db, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"请用一句话解释量子纠缠"}]}`,
		token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var prompt, completion int64
	var estimated bool
	if err := db.QueryRow(`SELECT prompt_tokens, completion_tokens, estimated FROM usage ORDER BY id DESC LIMIT 1`).
		Scan(&prompt, &completion, &estimated); err != nil {
		t.Fatal(err)
	}
	if prompt <= 0 {
		t.Fatalf("上游漏报 usage 时 prompt_tokens = %d, want > 0(按请求体兜底估算)", prompt)
	}
	if !estimated {
		t.Fatal("兜底估算的用量必须标记 estimated=true(对账可区分)")
	}
	t.Logf("上游漏报 usage 的兜底: prompt=%d completion=%d estimated=%v", prompt, completion, estimated)
}

// 非流式:上游 200 但不带 usage 时,prompt 侧同样兜底。
func TestNonStreamPromptFallbackWhenUsageMissing(t *testing.T) {
	f := &fakeUpstream{status: http.StatusOK, nonStream: `{"id":"x","object":"chat.completion","choices":[]}`}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, f.nonStream)
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL

	r, db, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[{"role":"user","content":"你好,请解释一下相对论"}]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var prompt int64
	var estimated bool
	if err := db.QueryRow(`SELECT prompt_tokens, estimated FROM usage ORDER BY id DESC LIMIT 1`).Scan(&prompt, &estimated); err != nil {
		t.Fatal(err)
	}
	if prompt <= 0 || !estimated {
		t.Fatalf("prompt=%d estimated=%v, want >0 且 estimated=true", prompt, estimated)
	}
}

// P2-10:上游 4xx 错误体只透传 message/type/code,内部字段不得下发。
func TestUpstreamErrorBodySanitized(t *testing.T) {
	f := &fakeUpstream{status: http.StatusBadRequest}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"context length exceeded","type":"invalid_request_error","code":"ctx_len",
			"internal_host":"llm-proxy.internal.corp:8080","stack":"goroutine 1 [running]: main.serve()"}}`)
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL

	r, _, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
	got := w.Body.String()
	if !strings.Contains(got, "context length exceeded") || !strings.Contains(got, "ctx_len") {
		t.Fatalf("可用错误信息丢失: %s", got)
	}
	for _, leak := range []string{"internal_host", "llm-proxy.internal.corp", "stack", "goroutine"} {
		if strings.Contains(got, leak) {
			t.Fatalf("上游内部信息泄漏(%s): %s", leak, got)
		}
	}

	// 非流式路径同源
	w2 := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`, token, nil)
	if w2.Code != http.StatusBadRequest {
		t.Fatalf("non-stream status = %d", w2.Code)
	}
	if strings.Contains(w2.Body.String(), "internal_host") {
		t.Fatalf("非流式错误体仍泄漏内部字段: %s", w2.Body.String())
	}
}

func TestSanitizeUpstreamErrorNonJSON(t *testing.T) {
	got := string(sanitizeUpstreamError([]byte("<html>502 Bad Gateway from nginx at 10.0.0.7</html>"), nil))
	if strings.Contains(got, "10.0.0.7") || strings.Contains(got, "nginx") {
		t.Fatalf("非 JSON 错误体未被收敛: %s", got)
	}
	if !strings.Contains(got, "UPSTREAM_ERROR") {
		t.Fatalf("缺少稳定错误码: %s", got)
	}
}
