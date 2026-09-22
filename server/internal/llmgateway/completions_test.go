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
	// 出站体语义等价（2026-09-22 起网关统一重编码：键序 + file_id 校验；
	// FIM 端点官方未文档化 user_id ⇒ 不注入）。
	forwardedBodyEqual(t, f.gotBody.Load().(string), body, "")
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
	// 语义等价；/responses 官方未文档化 user_id ⇒ 不注入
	forwardedBodyEqual(t, f.gotBody.Load().(string), body, "")
}

// TestVisionImageTokenBilling 验证图片请求(官方 Vision: 图片折算 token,
// 与文本一起计费, 上限 384/图)计费闭环: 上游返回的 usage.prompt_tokens
// 已含图片 token → 服务端按 token 落账, 金额=文本+图片 token 折算。
func TestVisionImageTokenBilling(t *testing.T) {
	f := newFakeUpstream(t)
	// 模拟上游返回: prompt_tokens 含图片 token(如 384 + 文本 20 = 404)。
	f.nonStream = `{"id":"x","object":"chat.completion","usage":{"prompt_tokens":404,"completion_tokens":3}}`
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":[{"type":"text","text":"what is this?"},{"type":"image_url","image_url":{"url":"data:image/jpeg;base64,QWJjZA=="}}]}]}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 404 || ct != 3 {
		t.Fatalf("usage pt=%d ct=%d (want image tokens in prompt)", pt, ct)
	}
	// 图片请求体语义等价转发(网关不改写/不拦截 image_url);chat 路径会注入 user_id。
	forwardedBodyEqual(t, f.gotBody.Load().(string), body, platformUserID(aliceTestUserID(t, db)))
}
