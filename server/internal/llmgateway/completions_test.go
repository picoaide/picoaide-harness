package llmgateway

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
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
	// 语义等价 + 官方 create-response 的顶层 user 注入（审计 F 路 P1-1 修正：
	// 此前误按"官方无该字段"处理，实际字段名是 user 而不是 user_id）。
	forwardedBodyEqual(t, f.gotBody.Load().(string), body, platformUserID(aliceTestUserID(t, db)))
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

// G-04(审计 2026-09-23 P1):/v1/completions 与 /v1/responses 的流式上游请求必须
// 与 chat(/v1/chat/completions)**同一份口径** —— `context.WithoutCancel`(见
// forward()/forwardAnthropic()),客户端断连后继续 drain 上游直到拿到 usage
// chunk。旧实现沿用 c.Request.Context():断连立即取消上游(上游侧观测到 cancel)
// ⇒ 真实计量被 4 字节/token 的估算替换(实测输入侧 1234→12),断在正文之前更是
// 整笔零落账(usage_rows=0),而同一条流走 chat 却如实计费。
//
// drain 上限仍由 serveStream 的 streamDrainTimeout(2min)与 idle 看门狗兜住,
// 因此本用例同时断言"上游未被取消",即"没有变成无界 drain 的另一端"。
func TestStreamingEndpointsMatchChatBillingOnClientDisconnect(t *testing.T) {
	cases := []struct {
		name         string
		path         string
		body         string
		contentDelay time.Duration // 首个正文字节之前的延迟(0 = 立刻发正文)
	}{
		{"chat_after_content", "/v1/chat/completions",
			`{"model":"probe-m","messages":[{"role":"user","content":"hello"}],"stream":true}`, 0},
		{"responses_after_content", "/v1/responses",
			`{"model":"probe-m","input":"hello","stream":true}`, 0},
		{"completions_after_content", "/v1/completions",
			`{"model":"probe-m","prompt":"hello","stream":true}`, 0},
		{"chat_before_content", "/v1/chat/completions",
			`{"model":"probe-m","messages":[{"role":"user","content":"hello"}],"stream":true}`, 400 * time.Millisecond},
		{"responses_before_content", "/v1/responses",
			`{"model":"probe-m","input":"hello","stream":true}`, 400 * time.Millisecond},
		{"completions_before_content", "/v1/completions",
			`{"model":"probe-m","prompt":"hello","stream":true}`, 400 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var sawCancel atomic.Int64
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				w.WriteHeader(http.StatusOK)
				fl, _ := w.(http.Flusher)
				if tc.contentDelay > 0 {
					select {
					case <-time.After(tc.contentDelay):
					case <-r.Context().Done():
						sawCancel.Add(1)
						return
					}
				}
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n")
				if fl != nil {
					fl.Flush()
				}
				// usage 在上游"继续生成"之后才回来：客户端此时已断连。
				select {
				case <-time.After(250 * time.Millisecond):
				case <-r.Context().Done():
					sawCancel.Add(1)
					return
				}
				fmt.Fprint(w, "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1234,\"completion_tokens\":7}}\n\n")
				fmt.Fprint(w, "data: [DONE]\n\n")
				if fl != nil {
					fl.Flush()
				}
			}))
			t.Cleanup(srv.Close)

			r, db, token := newGateway(t, nil)
			defer db.Close()
			if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('fake', ?, ?, '["probe-m"]')`, srv.URL, upstreamKey); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(`INSERT INTO models (name, provider_id, input_price_per_1m, output_price_per_1m) VALUES ('probe-m', 1, 1, 1)`); err != nil {
				t.Fatal(err)
			}
			serverstore.InvalidateModelConfig()
			InvalidateUpstreams()

			ctx, cancel := context.WithCancel(context.Background())
			go func() {
				time.Sleep(60 * time.Millisecond) // 客户端在 usage 之前断连
				cancel()
			}()
			doPost(t, r, tc.path, tc.body, token, ctx)

			// 终态 = 上游真实计量已落账,或整行被删(旧行为:正文前断连 ⇒ 零落账)。
			var n, pt, ct int64
			var estimated bool
			deadline := time.Now().Add(5 * time.Second)
			for {
				if err := db.QueryRow(`SELECT count(*) FROM usage`).Scan(&n); err != nil {
					t.Fatal(err)
				}
				if n > 0 {
					if err := db.QueryRow(`SELECT prompt_tokens, completion_tokens, estimated FROM usage ORDER BY id DESC LIMIT 1`).
						Scan(&pt, &ct, &estimated); err != nil {
						t.Fatal(err)
					}
				}
				if n == 0 || (pt == 1234 && ct == 7 && !estimated) || time.Now().After(deadline) {
					break
				}
				time.Sleep(50 * time.Millisecond)
			}

			if saw := sawCancel.Load(); saw != 0 {
				t.Errorf("上游观测到 %d 次取消 —— 流式 ctx 未与客户端断开解耦(应与 chat 同用 context.WithoutCancel)", saw)
			}
			if n != 1 {
				t.Fatalf("usage rows = %d, want 1(断连后仍必须落账,0 = 整笔零落账)", n)
			}
			if pt != 1234 || ct != 7 || estimated {
				t.Fatalf("usage pt=%d ct=%d estimated=%v, want 1234/7/false(估算或 0 ⇒ 上游真实计量被断连丢弃)", pt, ct, estimated)
			}
		})
	}
}
