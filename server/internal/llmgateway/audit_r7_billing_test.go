package llmgateway

// 审计 r7 计费回归(srvbill-1 / srvbill-2,复核报告 VERIFY-A1-server-billing-store)。
//
//	srvbill-1(P1,既有/收口不完整):流式在余额不足时**完整交付 + 零落账零扣费 +
//	  可无限重复**。物理事实:SSE 的 usage chunk 按协议出现在流的末尾,余额判定
//	  发生在全部正文早已 Flush 给客户端之后;而"余额不够就整笔回滚(含 usage 行)"
//	  把这次真实消费变成 0 记账,闸门又只看分位余额 > 0 ⇒ 余额 0.01 元的账户可以
//	  每轮都拿到完整回答。
//	srvbill-2(P1):`stream_options.include_usage=false` 由客户端原样转发 ⇒ 上游
//	  按规范不发 usage chunk ⇒ 收尾兜底只估 completion(prompt 侧恒记 0)且被
//	  maxEstimatedCompletionTokens=65536 截顶。计量开关必须由服务端持有;整条流
//	  一个 usage 都没收到时,输入侧也要按请求体字节补估(estimated=true)。
//
// 两条不变量在每个用例里都要成立:
//
//	I1  users.balance_money == SUM(balance_ledger.amount)
//	I2  **已交付**的字节必须留下计费痕迹(usage 行 + consume 流水)—— 交付与
//	    落账不允许脱钩(srvbill-1 的教训:"fail-closed" 必须同时断言交付量)。

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// r7Upstream 是按 OpenAI 规范行为的最小上游:只有
// `stream_options.include_usage=true` 才在流末尾回 usage chunk(这样"客户端关掉
// 自己的计量表"的形态可以被忠实复刻),并记录网关**实际转发**的请求体。
type r7Upstream struct {
	srv *httptest.Server
	mu  sync.Mutex
	// calls / lastBody 是观测面:上游被调用几次、转发体长什么样。
	calls    int
	lastBody string

	chunks     int   // 正文 chunk 数
	chunkBytes int   // 每个正文 chunk 的填充字节
	usagePT    int64 // usage chunk 里回报的 prompt/completion
	usageCT    int64
	silent     bool // true = 无论客户端要什么,整条流都不回 usage(上游漏报)
	marker     string
}

func newR7Upstream(t *testing.T) *r7Upstream {
	t.Helper()
	u := &r7Upstream{chunks: 3, chunkBytes: 1200, usagePT: 500_000, usageCT: 500_000, marker: "R7CHUNK"}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		stream, _ := body["stream"].(bool)
		// OpenAI 语义:不显式要 include_usage 就不发 usage chunk。
		wantUsage := false
		if opts, ok := body["stream_options"].(map[string]any); ok {
			if v, has := opts["include_usage"].(bool); has {
				wantUsage = v
			}
		}
		u.mu.Lock()
		u.calls++
		u.lastBody = string(raw)
		chunks, chunkBytes, pt, ct, silent, marker := u.chunks, u.chunkBytes, u.usagePT, u.usageCT, u.silent, u.marker
		u.mu.Unlock()

		if !stream {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"id":"r7","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":%d,"completion_tokens":%d}}`, pt, ct)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl := w.(http.Flusher)
		payload := strings.Repeat("q", chunkBytes)
		for i := 0; i < chunks; i++ {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"%s-%03d-%s\"}}]}\n\n", marker, i, payload)
			fl.Flush()
		}
		if wantUsage && !silent {
			fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":%d,\"completion_tokens\":%d}}\n\n", pt, ct)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *r7Upstream) snapshot() (calls int, forwarded string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls, u.lastBody
}

// srvbill-1:流式余额不足 —— 已交付的正文必须如实落账(欠款可见),且不能再重复。
func TestR7StreamSettlementChargesDeliveredBodyOverdraft(t *testing.T) {
	u := newR7Upstream(t)
	// 余额 0.02 元过闸门(QuantizeMoney > 0),单次真实费用 8 元(500K+500K @ 8 元/1M)。
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 0.02, 8, 8, 0)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	body := w.Body.String()
	rows := r5UsageRows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)

	// (a) 拒绝发生**之前**已交付的正文量:usage chunk 在流末尾,全部正文早已
	// 交付 —— R3 的 fail-closed 用例只断言"error 事件存在 + usage 之后无内容",
	// 结构上看不见这一半。
	delivered := strings.Count(body, "R7CHUNK")
	t.Logf("srvbill-1 status=%d 交付 chunk=%d 字节=%d | rows=%d pt=%d ct=%d cost=%.6f balance=%.6f",
		w.Code, delivered, len(body), len(rows), rowPrompt(rows), rowCompletion(rows), rowCost(rows), s.balance)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if delivered != 3 {
		t.Fatalf("已交付正文 = %d 个 chunk, want 3", delivered)
	}
	if len(rows) != 1 {
		t.Fatalf("usage 行数 = %d, want 1(交付了就必须留下一行)", len(rows))
	}

	// (b) 欠款如实落账:token / 费用 / 余额 / 流水四者一致。
	got := rows[0]
	if got.Prompt != 500_000 || got.Completion != 500_000 {
		t.Fatalf("已交付调用的 token 未如实落账: pt=%d ct=%d, want 500000/500000(整笔回滚 = 零记账)", got.Prompt, got.Completion)
	}
	if want := 8.0; math.Abs(got.Cost-want) > 1e-9 {
		t.Fatalf("cost = %.9f, want %.9f", got.Cost, want)
	}
	if got.Estimated {
		t.Fatalf("上游已上报用量,不该走估算: %+v", got)
	}
	if !(s.balance < 0) {
		t.Fatalf("balance = %.6f, want < 0(先交付后结算 = 后付费,欠款必须走负)", s.balance)
	}
	if want := 0.02 - got.Cost; math.Abs(s.balance-want) > 1e-9 {
		t.Fatalf("balance = %.9f, want %.9f(欠款 = 余额 - 费用)", s.balance, want)
	}
	if s.kinds[serverstore.LedgerKindConsume] != 1 {
		t.Fatalf("consume 流水 = %v, want 恰好 1 笔(srvbill-1 的缺陷就是这笔流水缺失)", s.kinds)
	}
	checkLedgerInvariant(t, s, "srvbill-1 透支落账")
	var withUsage int
	if err := db.QueryRow(`SELECT count(*) FROM balance_ledger WHERE user_id = ? AND kind = ? AND usage_id IS NOT NULL`,
		uid, serverstore.LedgerKindConsume).Scan(&withUsage); err != nil {
		t.Fatal(err)
	}
	if withUsage != 1 {
		t.Fatalf("consume 流水未挂到 usage 行(usage_id 为空,无法逐笔对账): %d", withUsage)
	}

	// 排障线索:这条请求不得以 0-token pending 行的形态留着 —— 那会被启动期
	// CleanupPendingUsage 静默删掉(旧行为:连痕迹都没有)。
	if err := serverstore.CleanupPendingUsage(db, time.Now().Add(time.Hour)); err != nil {
		t.Fatalf("CleanupPendingUsage: %v", err)
	}
	if left := r5UsageRows(t, db, uid); len(left) != 1 || left[0].Cost <= 0 {
		t.Fatalf("已交付请求的 usage 行被 pending 清理删除/抹平: %+v", left)
	}

	// 欠款自然把后续请求拦在闸门上(余额分位 <= 0),不再"可无限重复"。
	w2 := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	calls, _ := u.snapshot()
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("欠款账户的后续请求 status = %d, want 429(余额闸门必须接手)", w2.Code)
	}
	if !strings.Contains(w2.Body.String(), "BALANCE_EXHAUSTED") {
		t.Fatalf("后续请求未按 BALANCE_EXHAUSTED 拒绝: %s", w2.Body.String())
	}
	if calls != 1 {
		t.Fatalf("欠款账户的后续请求仍然打到上游: calls = %d, want 1", calls)
	}
}

// srvbill-2①:计量开关只能由服务端持有 —— 客户端显式 include_usage=false 必须被覆盖。
func TestR7StreamClientCannotDisableUsageReporting(t *testing.T) {
	u := newR7Upstream(t)
	u.chunks, u.chunkBytes, u.usagePT, u.usageCT = 4, 800, 1_000_000, 1_000_000
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 1000, 8, 8, 0)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"r3-model","messages":[],"stream":true,"stream_options":{"include_usage":false}}`, token, nil)
	_, forwarded := u.snapshot()
	rows := r5UsageRows(t, db, uid)
	t.Logf("srvbill-2① 转发体=%s | rows=%d pt=%d ct=%d cost=%.6f", forwarded, len(rows), rowPrompt(rows), rowCompletion(rows), rowCost(rows))

	if !strings.Contains(forwarded, `"include_usage":true`) {
		t.Fatalf("转发体仍带客户端关闭的计量开关(上游据此不发 usage chunk): %s", forwarded)
	}
	if len(rows) != 1 {
		t.Fatalf("usage 行数 = %d, want 1", len(rows))
	}
	got := rows[0]
	if got.Prompt != 1_000_000 || got.Completion != 1_000_000 {
		t.Fatalf("上游上报的用量没有被如实落账: pt=%d ct=%d(客户端关表后只估 completion 且被 65536 截顶)",
			got.Prompt, got.Completion)
	}
	if want := 16.0; math.Abs(got.Cost-want) > 1e-9 {
		t.Fatalf("cost = %.9f, want %.9f(真实 16 元)", got.Cost, want)
	}
	if got.Estimated {
		t.Fatalf("上游已上报用量,不该走估算: %+v", got)
	}
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

// srvbill-2②:整条流一个 usage 都没收到时,prompt 侧也要补估(不能记 0)。
func TestR7StreamWithoutAnyUsageEstimatesPromptSide(t *testing.T) {
	u := newR7Upstream(t)
	u.silent = true
	u.chunks, u.chunkBytes = 16, 4096
	r, db, uid, token := newAuditR3GatewayAt(t, u.srv.URL, 1000, 2, 8, 0)

	prompt := strings.Repeat("P", 4000)
	reqBody := `{"model":"r3-model","messages":[{"role":"user","content":"` + prompt + `"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", reqBody, token, nil)
	rows := r5UsageRows(t, db, uid)
	s := auditR3Snapshot(t, db, uid)
	if len(rows) != 1 {
		t.Fatalf("usage 行数 = %d, want 1", len(rows))
	}
	got := rows[0]
	// 两侧都用同一把尺子(4 字节/token):输入侧按**已提交的请求体字节**,
	// 输出侧按**已交付的正文内容字节**(r7 r7f1-2:SSE 帧、usage 行、[DONE]
	// 都不是模型产出,旧的"整个响应体字节 ÷4"把帧也算成了 token)。
	wantPT := int64(len(reqBody)) / 4
	contentPerChunk := int64(len(u.marker) + len("-000-") + u.chunkBytes)
	wantCT := int64(u.chunks) * contentPerChunk / 4
	t.Logf("srvbill-2② 请求体=%d 字节 响应体=%d 字节 正文=%d 字节 | pt=%d(want %d) ct=%d(want %d) cost=%.6f estimated=%v",
		len(reqBody), len(w.Body.String()), int64(u.chunks)*contentPerChunk, got.Prompt, wantPT, got.Completion, wantCT, got.Cost, got.Estimated)

	if got.Prompt != wantPT {
		t.Fatalf("整条流没有任何 usage 时输入侧未补估: prompt=%d, want %d(记 0 = 输入侧完全免费)", got.Prompt, wantPT)
	}
	if got.Completion != wantCT {
		t.Fatalf("completion 侧估算口径变化: completion=%d, want %d", got.Completion, wantCT)
	}
	if !got.Estimated {
		t.Fatalf("估算出来的行必须打 estimated 标记(事后对账要能区分): %+v", got)
	}
	if want := (float64(got.Prompt)*2 + float64(got.Completion)*8) / 1e6; math.Abs(got.Cost-want) > 1e-9 {
		t.Fatalf("cost = %.9f, want %.9f(输入 2 元/1M + 输出 8 元/1M)", got.Cost, want)
	}
	checkLedgerInvariant(t, s, "srvbill-2 输入侧补估")
}

// row* 是小工具:日志里读一行 usage(测试失败信息也更直观)。
func rowPrompt(rows []r5UsageRow) int64 {
	if len(rows) == 0 {
		return -1
	}
	return rows[0].Prompt
}

func rowCompletion(rows []r5UsageRow) int64 {
	if len(rows) == 0 {
		return -1
	}
	return rows[0].Completion
}

func rowCost(rows []r5UsageRow) float64 {
	if len(rows) == 0 {
		return -1
	}
	return rows[0].Cost
}
