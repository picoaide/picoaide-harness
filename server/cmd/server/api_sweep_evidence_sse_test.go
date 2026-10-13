package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/llmgateway"
)

// 本文件是从 api_sweep_test.go 原样搬来的 SSE 举证（P1 第二片，2026-10-14）。
//
// **不带 build tag**：`POST /v1/chat/completions` 等四条流式端点是基础面（LLM 网关），
// 八种组合下都在 —— 搬出来只是为了让上面那条技能面的举证能单独带 tag。

func TestAPISweepExceptionEvidenceSSE(t *testing.T) {
	db := requireRealDB(t)

	// 假上游：按 OpenAI 流式形态吐两帧 + [DONE]。
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(upstream.Close)

	// 测试库里的 provider 密钥是明文（与 internal/llmgateway 的测试同口径：
	// 生产装配注入的是 AES-GCM 解密，测试里换成恒等函数）。
	prevDecrypt := llmgateway.DecryptSecret
	llmgateway.DecryptSecret = func(s string) (string, error) { return s, nil }
	// 上游路由有进程内缓存：造数据前后都必须失效，否则读到别的用例/上一步的集合。
	llmgateway.InvalidateUpstreams()
	t.Cleanup(func() {
		llmgateway.DecryptSecret = prevDecrypt
		llmgateway.InvalidateUpstreams()
	})

	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('sweep-fake', ?, 'k', '["sweep-model"]')`,
		upstream.URL); err != nil {
		t.Fatalf("插入上游: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO models (name, provider_id, display_name) VALUES ('sweep-model', 1, 'Sweep Model')`); err != nil {
		t.Fatalf("插入模型: %v", err)
	}

	// 例外表是**载荷**：同上，SSE 面必须登记在案。
	assertDeclaredNonJSON(t, "POST /v1/chat/completions", "text/event-stream")

	sweepSilenceAccessLog(t)
	r := sweepEngine(t, db)
	token := sweepIssueToken(t, db, "sweep-sse")

	body := `{"model":"sweep-model","messages":[{"role":"user","content":"hi"}],"stream":true}`
	req := httptest.NewRequest("POST", "/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	hit := sweepHit{method: "POST", route: "/v1/chat/completions", reqPath: "/v1/chat/completions",
		status: w.Code, ct: w.Header().Get("Content-Type"), header: w.Header(), body: w.Body.Bytes()}
	if hit.status != 200 {
		t.Fatalf("%s：status=%d want 200；content-type=%q body=%s",
			hit.label(), hit.status, hit.ct, hit.bodySummary())
	}
	if !strings.HasPrefix(hit.ct, "text/event-stream") {
		t.Fatalf("%s：content-type=%q want text/event-stream（例外登记里的流式面）",
			hit.label(), hit.ct)
	}
	if !strings.Contains(string(hit.body), "data: ") {
		t.Fatalf("%s：SSE 流里没有 data: 帧：%s", hit.label(), hit.bodySummary())
	}
	t.Logf("例外正向举证：%s（stream=true）⇒ %d %s（%d 字节）",
		hit.label(), hit.status, hit.ct, len(hit.body))
}
