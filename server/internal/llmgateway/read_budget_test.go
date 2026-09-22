package llmgateway

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// /v1 读预算与读失败分类的回归防线（2026-09-22）
// ---------------------------------------------------------------------------
//
// 现场：客户端上传一条长会话（≈3MiB）超过全局 ReadTimeout(60s) 时，旧实现把
// `i/o timeout` 写成 400「请求体格式错误」，而客户端把 400 映射成
// INVALID_REQUEST（不在重试策略里）⇒ 整轮对话报废。本文件钉住两件事：
//  1. 读预算确实放宽了（慢上传不再被 60s 判死）；
//  2. 真的到点时返回的是**可重试**的 503/SERVER，绝不是 400。

// slowBody 以固定间隔分块产出一个请求体，用来在真实 http.Server 上制造"上传慢"。
// 返回 (reader, 总字节数)；写入失败（服务端提前断开）时静默结束。
func slowBody(chunks, size int, delay time.Duration) (io.Reader, int) {
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		chunk := make([]byte, size)
		for i := 0; i < chunks; i++ {
			if _, err := pw.Write(chunk); err != nil {
				return
			}
			if i < chunks-1 {
				time.Sleep(delay)
			}
		}
	}()
	return pr, chunks * size
}

// newReadBudgetServer 起一个 ReadTimeout 被刻意压到很短的**真实** http.Server，
// handler 走 readRequestBody（与生产同一个读体入口）。
func newReadBudgetServer(t *testing.T, readTimeout time.Duration, limit int64) *httptest.Server {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/read", func(c *gin.Context) {
		raw, ok := readRequestBody(c, limit)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, gin.H{"bytes": len(raw)})
	})
	ts := httptest.NewUnstartedServer(r)
	ts.Config.ReadTimeout = readTimeout
	ts.Start()
	t.Cleanup(ts.Close)
	return ts
}

// setBodyReadBudget 注入读预算并在用例结束时还原（缺省 1h）。
func setBodyReadBudget(t *testing.T, d time.Duration) {
	t.Helper()
	prev := bodyReadBudget
	bodyReadBudget = d
	t.Cleanup(func() { bodyReadBudget = prev })
}

// setWriteBudget 注入写预算并在用例结束时还原（缺省 15m）。
func setWriteBudget(t *testing.T, d time.Duration) {
	t.Helper()
	prev := writeBudget
	writeBudget = d
	t.Cleanup(func() { writeBudget = prev })
}

// TestSlowUploadStillWritesResponseWithShortWriteTimeout：Go 的 WriteTimeout 是在
// **读完请求头那一刻**定死的绝对写截止时间 —— 一次 1.6s 的慢上传配 500ms 的
// WriteTimeout，若不续期，客户端会在服务端"已经成功"的情况下拿到 EOF。
//
// 变异验证：删掉 readRequestBody 成功分支里的 renewWriteDeadline ⇒ 本用例变红。
func TestSlowUploadStillWritesResponseWithShortWriteTimeout(t *testing.T) {
	setBodyReadBudget(t, 15*time.Second)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/read", func(c *gin.Context) {
		raw, ok := readRequestBody(c, 1<<20)
		if !ok {
			return
		}
		c.JSON(http.StatusOK, gin.H{"bytes": len(raw)})
	})
	ts := httptest.NewUnstartedServer(r)
	ts.Config.ReadTimeout = 400 * time.Millisecond
	ts.Config.WriteTimeout = 500 * time.Millisecond
	ts.Start()
	t.Cleanup(ts.Close)

	body, want := slowBody(8, 4096, 200*time.Millisecond) // ≈1.6s 上传 > WriteTimeout
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/read", body)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("写响应失败（客户端拿到 EOF 而服务端当成功）: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d (%s), want 200", resp.StatusCode, raw)
	}
	var out struct {
		Bytes int `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Bytes != want {
		t.Fatalf("响应体不完整: %s (err=%v)", raw, err)
	}
}

// TestZeroOrNegativeReadBudgetFallsBackToGlobalTimeout：注入 0/负数时**不延长**
// （退回全局 ReadTimeout），而不是把截止时间设到过去导致全站请求瞬间 503。
func TestZeroOrNegativeReadBudgetFallsBackToGlobalTimeout(t *testing.T) {
	for _, budget := range []time.Duration{0, -time.Second} {
		setBodyReadBudget(t, budget)
		ts := newReadBudgetServer(t, 5*time.Second, 1<<20)
		// 256KiB > bufio 缓冲：小体（如 7 字节）会整段落进缓冲，护栏失效时也测不出来
		// （审计 2026-09-22 指出作者原用例正是 7 字节体 ⇒ 变异全绿）。
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/read", strings.NewReader(strings.Repeat("h", 256<<10)))
		resp, err := ts.Client().Do(req)
		if err != nil {
			t.Fatalf("budget=%v 请求失败: %v", budget, err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("budget=%v status = %d (%s), want 200（应退回全局 ReadTimeout）", budget, resp.StatusCode, raw)
		}
	}
}

// TestSlowUploadSucceedsWithinBudget：全局 ReadTimeout 只有 400ms，但读预算被
// 放宽到 15s ⇒ 一个耗时约 2s 的慢上传必须成功。
//
// 变异验证：把 readRequestBody 里的 extendBodyReadDeadline 去掉 ⇒ 本用例变红
// （服务端 400，客户端拿到"请求体格式错误"）。
func TestSlowUploadSucceedsWithinBudget(t *testing.T) {
	setBodyReadBudget(t, 15*time.Second)
	ts := newReadBudgetServer(t, 400*time.Millisecond, 1<<20)

	body, want := slowBody(8, 4096, 250*time.Millisecond) // ≈2s 上传
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/read", body)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("slow upload failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("slow upload status = %d (%s), want 200 —— 读预算没有生效", resp.StatusCode, raw)
	}
	var out struct {
		Bytes int `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.Bytes != want {
		t.Fatalf("bytes = %d (err=%v), want %d", out.Bytes, err, want)
	}
}

// TestReadTimeoutReturnsServiceUnavailableNotBadRequest：读预算被压到 300ms 而
// 上传要 2s ⇒ 必然超时。此时必须是 **503 + code SERVER**（客户端重试策略认
// SERVER），**不是** 400「请求体格式错误」（会被归类 INVALID_REQUEST 且不重试）。
//
// 变异验证：把 readRequestBody 的超时分支改回 400「请求体格式错误」⇒ 本用例变红。
func TestReadTimeoutReturnsServiceUnavailableNotBadRequest(t *testing.T) {
	setBodyReadBudget(t, 300*time.Millisecond)
	ts := newReadBudgetServer(t, 5*time.Second, 1<<20)

	body, _ := slowBody(8, 4096, 250*time.Millisecond)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/read", body)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == http.StatusBadRequest {
		t.Fatalf("read timeout still reported as 400 (客户端会判成不可重试的 INVALID_REQUEST): %s", raw)
	}
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("read timeout status = %d (%s), want 503", resp.StatusCode, raw)
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatalf("error envelope is not JSON: %s", raw)
	}
	if envelope.Error.Code != "SERVER" {
		t.Fatalf("error code = %q (%s), want SERVER（客户端只对 EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT 重试）",
			envelope.Error.Code, raw)
	}
	if !strings.Contains(envelope.Error.Message, "超时") {
		t.Fatalf("error message = %q, want 明确说明是读超时", envelope.Error.Message)
	}
}

// TestReadBodyOverLimitReturns413：超过体积上限仍是 413「请求体过大」(未被
// 超时分类吞掉)。
func TestReadBodyOverLimitReturns413(t *testing.T) {
	setBodyReadBudget(t, 5*time.Second)
	ts := newReadBudgetServer(t, 5*time.Second, 1024)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/read", strings.NewReader(strings.Repeat("x", 4096)))
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("request failed: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d (%s), want 413", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "请求体过大") {
		t.Fatalf("body = %s, want 请求体过大", raw)
	}
}

// TestRateLimiterZeroMeansUnlimited：0/负数 = 不限制（与官方一致：官方只限
// 账号级并发，不设请求速率上限）。既是缺省值语义，也防"0 被当成 0 令牌桶"。
//
// 变异验证：删掉 allow() 开头的 `if rate <= 0 { return true }` ⇒ 本用例变红
// （第一个请求就被拒）。
func TestRateLimiterZeroMeansUnlimited(t *testing.T) {
	l := newRateLimiter()
	for i := 0; i < 500; i++ {
		if !l.allow(7, 0) {
			t.Fatalf("allow(uid, 0) 第 %d 次被拒 —— 0 必须表示不限制", i+1)
		}
		if !l.allow(7, -1) {
			t.Fatalf("allow(uid, -1) 第 %d 次被拒 —— 负数必须表示不限制", i+1)
		}
	}
	if len(l.buckets) != 0 {
		t.Fatalf("不限制路径不应建桶，实际 %d 个", len(l.buckets))
	}
	// 正数仍必须真的限流(不能为了"不限制"把限流器整个掏空)。
	l2 := newRateLimiter()
	allowed := 0
	for i := 0; i < 10; i++ {
		if l2.allow(9, 3) {
			allowed++
		}
	}
	if allowed != 3 {
		t.Fatalf("rate=3 时放行 %d 次, want 3", allowed)
	}
}

// TestEveryGatewayBodyReadUsesHelper：源码级收口 —— 除 read_budget.go 外，
// 网关包不得再出现裸读 `io.ReadAll(c.Request.Body)`，且每个读体 handler 都必须
// 走 readRequestBody。否则新端点会重新长出"60s 判死 + 400 误标"的老毛病。
func TestEveryGatewayBodyReadUsesHelper(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	handlers := map[string]bool{
		"handler.go":     false, // chat/completions
		"completions.go": false, // FIM
		"messages.go":    false, // Anthropic Messages
		"responses.go":   false, // Responses
		"embedding.go":   false, // embeddings
	}
	for _, name := range files {
		if strings.HasSuffix(name, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		src := string(raw)
		if name != "read_budget.go" && strings.Contains(src, "io.ReadAll(c.Request.Body)") {
			t.Errorf("%s 仍在裸读请求体：必须走 readRequestBody（见 read_budget.go）", name)
		}
		if _, ok := handlers[name]; ok && strings.Contains(src, "readRequestBody(c,") {
			handlers[name] = true
		}
	}
	for name, ok := range handlers {
		if !ok {
			t.Errorf("%s 未调用 readRequestBody —— 读预算/失败分类会在这条路径上失效", name)
		}
	}
}

// TestBodyReadTimeoutClassification 直测分类判据（不依赖网络时序）。
func TestBodyReadTimeoutClassification(t *testing.T) {
	if bodyReadTimeout(nil) {
		t.Fatal("nil 不应判为超时")
	}
	if bodyReadTimeout(fmt.Errorf("connection reset by peer")) {
		t.Fatal("普通错误不应判为超时")
	}
	// net.Error 形状（真实 server 的 i/o timeout 是 *net.OpError）
	if !bodyReadTimeout(fakeTimeoutErr{}) {
		t.Fatal("net.Error.Timeout()=true 必须判为超时")
	}
}

type fakeTimeoutErr struct{}

func (fakeTimeoutErr) Error() string   { return "i/o timeout" }
func (fakeTimeoutErr) Timeout() bool   { return true }
func (fakeTimeoutErr) Temporary() bool { return true }
