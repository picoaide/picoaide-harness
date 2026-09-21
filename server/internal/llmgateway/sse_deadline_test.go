package llmgateway

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestSSEWriteWindowIsBoundedAndAboveIdleWatchdog 钉住续期窗口(2026-09-21)的两个不变量:
// 缺省必须 = 2 × idle 看门狗;idle 窗口被测试调小时,窗口不得缩到比 flush 间隔还短。
func TestSSEWriteWindowIsBoundedAndAboveIdleWatchdog(t *testing.T) {
	if got, want := sseWriteWindow(), 2*STREAM_IDLE_TIMEOUT; got != want {
		t.Fatalf("缺省续期窗口 = %s, want %s(2 × idle 看门狗)", got, want)
	}
	if sseWriteWindow() <= streamIdleTimeout {
		t.Fatalf("续期窗口 %s 必须严格大于 idle 看门狗 %s", sseWriteWindow(), streamIdleTimeout)
	}

	defer func(prev time.Duration) { streamIdleTimeout = prev }(streamIdleTimeout)
	streamIdleTimeout = 5 * time.Millisecond // 既有用例会这样调小(见 failover_test.go)
	if got := sseWriteWindow(); got < time.Minute {
		t.Fatalf("idle 窗口调小后续期窗口 = %s, 不得低于下限 %s", got, time.Minute)
	}
}

// TestSSEActiveStreamSurvivesServerWriteTimeout 是本轮缺陷的回归判据。
//
// 现场(2026-09-21):http.Server 的 WriteTimeout 是**从读到请求头算起**的绝对写截止时间,
// 活跃的 SSE 流同样会在到点时被掐断 —— 客户端 `unexpected EOF`、服务端
// `write tcp …: i/o timeout`,流式对话单次生成超过 5 分钟就丢答案。
//
// 判据形态:服务端 WriteTimeout 压到 1s(真实 5 分钟按用例时长压缩),上游每 250ms
// 出一块、共 10 块(活跃 2.5s)。修复前:1s 后写入撞截止时间 ⇒ 块数不足且没有 [DONE];
// 修复后:每次 flush 前续期 ⇒ 全部块 + [DONE]。
func TestSSEActiveStreamSurvivesServerWriteTimeout(t *testing.T) {
	const (
		chunks = 10
		gap    = 250 * time.Millisecond
	)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		for i := 0; i < chunks; i++ {
			fmt.Fprintf(w, "data: {\"id\":\"p\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"t%d \"}}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n", i)
			fl.Flush()
			time.Sleep(gap)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	defer up.Close()

	engine, _, _, token := newAuditR3GatewayAt(t, up.URL, 0, 0, 0, 0)
	srv := httptest.NewUnstartedServer(engine)
	srv.Config.WriteTimeout = 1 * time.Second // 关键:远短于流的活跃时长
	srv.Start()
	defer srv.Close()

	req, err := http.NewRequest(http.MethodPost, srv.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"r3-model","stream":true,"messages":[{"role":"user","content":"hi"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	start := time.Now()
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer resp.Body.Close()
	raw, rerr := io.ReadAll(resp.Body)
	elapsed := time.Since(start)
	body := string(raw)
	if rerr != nil {
		t.Fatalf("读流失败(修复前即此形态:绝对写截止时间到点掐断): %v", rerr)
	}
	if got := strings.Count(body, "chat.completion.chunk"); got != chunks {
		t.Fatalf("收到 %d 块, want %d", got, chunks)
	}
	if !strings.Contains(body, "[DONE]") {
		tail := body
		if len(tail) > 160 {
			tail = tail[len(tail)-160:]
		}
		t.Fatalf("流被截断:没有 [DONE](尾部 %q)", tail)
	}
	// 防退化:若流其实瞬间就结束了,本用例证明不了"活跃流能活过 WriteTimeout"。
	if elapsed < time.Duration(chunks)*gap {
		t.Fatalf("流只持续了 %s, 短于预期的活跃时长 %s, 判据失效", elapsed, time.Duration(chunks)*gap)
	}
	t.Logf("活跃流完整收完:%d 块 / %s(服务端 WriteTimeout=1s)", chunks, elapsed)
}
