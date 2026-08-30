package llmgateway

import (
	"net/http"
	"testing"
)

// TestFIMRecordsUsage 验证 FIM completion(/v1/completions)计费闭环:
// 上游返回带 usage 的 JSON → usage 行记录 prompt/completion tokens。
// (映射/转发原样, 无模型名改写; 计费走 serveJSON → RecordUsageKindCached)
func TestFIMRecordsUsage(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","prompt":"def fib(x):"}`

	w := doPost(t, r, "/v1/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 8 || ct != 3 {
		t.Fatalf("usage pt=%d ct=%d", pt, ct)
	}
	// 请求体原样转发(不映射/不改写字段)。
	if got := f.gotBody.Load().(string); got != body {
		t.Fatalf("forwarded body = %s", got)
	}
}

// TestFIMPromptRequired FIM 无 prompt 字段 → 400(不落账)。
func TestFIMPromptRequired(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/completions", `{"model":"deepseek-chat"}`, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

// TestResponsesRecordsUsage 验证 Responses API(/v1/responses)计费闭环。
func TestResponsesRecordsUsage(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","input":"hi"}`

	w := doPost(t, r, "/v1/responses", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 8 || ct != 3 {
		t.Fatalf("usage pt=%d ct=%d", pt, ct)
	}
	if got := f.gotBody.Load().(string); got != body {
		t.Fatalf("forwarded body = %s", got)
	}
}
