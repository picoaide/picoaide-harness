package llmgateway

// 审计 r3 计费回归(G5a / G5b / G7 / G12 + 同类未堵出口)。
//
// 全部用例都是**真实运行时**:真 PG(serverstore.NewTestDB → 临时库 + 全量
// 迁移)+ 真 gin 路由(RegisterRoutes,与生产同一张路由表)+ 真上游(httptest
// 假上游,按真实上游的报文形态应答:chat/completions、responses、messages、
// embeddings 四种报文 + SSE 事件形状)。
//
// 每个用例都同时钉住「钱」的三个不变量(与 serverstore 的账本契约一致):
//   I1  users.balance_money == SUM(balance_ledger.amount)
//   I2  已交付的响应必须留下计费痕迹(usage 行 + consume 流水)
//   I3  结算失败时不得交付上游内容(非流式明确错误码 / 流式 SSE error 并终止)

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// r3MeteringFailedCode 是结算期**非余额类**失败的对外错误码。
// 刻意在测试里写死字面量(不引用实现常量):这样本文件在修复前的树上也能编译
// 并**以断言失败**的方式变红,而不是编译错误 —— 红/绿都必须是真实运行结果。
const r3MeteringFailedCode = "METERING_FAILED"

// ---------------------------------------------------------------------------
// 假上游:行为与真实上游一致(按路径 + stream 标志分派报文形态)
// ---------------------------------------------------------------------------

type auditR3Upstream struct {
	srv    *httptest.Server
	mu     sync.Mutex
	non    string
	stream string
	embed  string
	calls  int
	paths  []string
}

func newAuditR3Upstream(t *testing.T) *auditR3Upstream {
	t.Helper()
	u := &auditR3Upstream{
		non:    `{"id":"r3","object":"chat.completion","choices":[{"message":{"content":"hi"}}],"usage":{"prompt_tokens":1000000,"completion_tokens":0}}`,
		stream: "data: [DONE]\n\n",
		embed:  `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.25]}],"model":"r3-model","usage":{"prompt_tokens":1000000,"total_tokens":1000000}}`,
	}
	u.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		u.mu.Lock()
		u.calls++
		u.paths = append(u.paths, r.URL.Path)
		u.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, "/embeddings"):
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, u.get(&u.embed))
		case strings.Contains(string(body), `"stream":true`):
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			fmt.Fprint(w, u.get(&u.stream))
		default:
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, u.get(&u.non))
		}
	}))
	t.Cleanup(u.srv.Close)
	return u
}

func (u *auditR3Upstream) get(field *string) string {
	u.mu.Lock()
	defer u.mu.Unlock()
	return *field
}

func (u *auditR3Upstream) setNon(body string)    { u.set(&u.non, body) }
func (u *auditR3Upstream) setStream(body string) { u.set(&u.stream, body) }

func (u *auditR3Upstream) set(field *string, body string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	*field = body
}

func (u *auditR3Upstream) callCount() int {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.calls
}

func (u *auditR3Upstream) lastPath() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if len(u.paths) == 0 {
		return ""
	}
	return u.paths[len(u.paths)-1]
}

// ---------------------------------------------------------------------------
// 真 PG + 真路由
// ---------------------------------------------------------------------------

// newAuditR3Gateway 建一张真实网关路由树 + 独立临时 PG 库 + 已开通余额账户。
// 定价参数直接写入 models(不事后 UPDATE:价格有进程内缓存,事后改价不生效)。
// cachePrice<=0 表示未配置缓存价(按输入价计)。
func newAuditR3Gateway(t *testing.T, u *auditR3Upstream, balance, inPrice, outPrice, cachePrice float64) (*gin.Engine, *sql.DB, int64, string) {
	t.Helper()
	DecryptSecret = func(s string) (string, error) { return s, nil }
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "r3gw", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	// protocol=both:一个上游同时服务 openai(chat/responses/embeddings)
	// 与 anthropic(messages)路由 —— 与真实部署里的 "both" 上游一致。
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol) VALUES ('r3p', ?, 'sk-r3', '["r3-model"]', 'both')`, u.srv.URL); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m, output_price_per_1m, cache_input_price_per_1m) VALUES ('r3-model', 1, 'R3', ?, ?, ?)`,
		inPrice, outPrice, cachePrice); err != nil {
		t.Fatal(err)
	}
	if balance > 0 {
		if _, err := serverstore.SetUserBalance(db, uid, balance, "seed", "r3test"); err != nil {
			t.Fatal(err)
		}
	}
	enableBalanceGate(t, db, true)
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, uid, token
}

// auditR3State 是一次请求后的账本快照。
type auditR3State struct {
	balance   float64
	ledgerSum float64
	usageRows int
	tokens    int64
	cost      float64
	kinds     map[string]int
}

func auditR3Snapshot(t *testing.T, db *sql.DB, uid int64) auditR3State {
	t.Helper()
	var s auditR3State
	if err := db.QueryRow(`SELECT balance_money FROM users WHERE id = ?`, uid).Scan(&s.balance); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COALESCE(SUM(amount),0) FROM balance_ledger WHERE user_id = ?`, uid).Scan(&s.ledgerSum); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(prompt_tokens+completion_tokens),0), COALESCE(SUM(cost),0) FROM usage WHERE user_id = ?`, uid).
		Scan(&s.usageRows, &s.tokens, &s.cost); err != nil {
		t.Fatal(err)
	}
	s.kinds = map[string]int{}
	rows, err := db.Query(`SELECT kind, COUNT(*) FROM balance_ledger WHERE user_id = ? GROUP BY kind`, uid)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var k string
		var n int
		if err := rows.Scan(&k, &n); err != nil {
			t.Fatal(err)
		}
		s.kinds[k] = n
	}
	return s
}

// checkLedgerInvariant 钉住 I1(balance == SUM(ledger.amount))。
func checkLedgerInvariant(t *testing.T, s auditR3State, where string) {
	t.Helper()
	if math.Abs(s.balance-s.ledgerSum) > 1e-6 {
		t.Fatalf("%s: I1 被破坏 balance=%.6f SUM(ledger)=%.6f", where, s.balance, s.ledgerSum)
	}
}

func bodyHead(w *httptest.ResponseRecorder) string {
	b := w.Body.String()
	if len(b) > 240 {
		b = b[:240] + "…"
	}
	return strings.ReplaceAll(b, "\n", "\\n")
}

// breakLedgerInserts 用**真实 PG 错误**制造结算期失败:CHECK(false) 约束
// (NOT VALID:放过历史行,只拦新插入)让 balance_ledger 的任何流水写入都以
// SQLSTATE 23514 失败。这是"非余额类结算错误"的确定性版本(审计的 G5b 用
// 超大金额触发 pgx int4 编码错误,机理相同:结算语句在真实 PG 上失败)。
func breakLedgerInserts(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`ALTER TABLE balance_ledger ADD CONSTRAINT r3_settle_fail CHECK (false) NOT VALID`); err != nil {
		t.Fatal(err)
	}
}

// failFirstLedgerInsert 让**第一次** balance_ledger 插入以真实 PG 异常失败,
// 之后恢复正常(序号的 nextval 不随事务回滚,所以计数能跨回滚存活)——
// 用来模拟"可恢复的瞬时结算错误"(死锁/连接抖动)。
func failFirstLedgerInsert(t *testing.T, db *sql.DB) {
	t.Helper()
	stmt := []string{
		`CREATE SEQUENCE IF NOT EXISTS r3_fail_seq START 1`,
		`CREATE OR REPLACE FUNCTION r3_fail_first() RETURNS trigger AS $$
BEGIN
  IF nextval('r3_fail_seq') = 1 THEN
    RAISE EXCEPTION 'r3 transient settlement failure';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql`,
		`CREATE TRIGGER r3_fail_first_trg BEFORE INSERT ON balance_ledger FOR EACH ROW EXECUTE FUNCTION r3_fail_first()`,
	}
	for _, q := range stmt {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("inject transient failure: %v", err)
		}
	}
}

// ---------------------------------------------------------------------------
// G7:/v1/responses 按 OpenAI Responses 官方字段名上报 usage 时一分不扣
// ---------------------------------------------------------------------------

// TestParseUsageAcceptsResponsesFieldNames 钉住解析器本身:同一个解析器必须
// 同时认 chat(prompt/completion_tokens)与 Responses(input/output_tokens)
// 两套字段名,并把 input_tokens_details.cached_tokens 等价映射到缓存命中;
// 字段缺失时保持原语义(ok=true 且各项为 0),负值仍归零。
func TestParseUsageAcceptsResponsesFieldNames(t *testing.T) {
	cases := []struct {
		name       string
		raw        string
		pt, ct, ch int64
		ok         bool
	}{
		{
			name: "chat字段名不变",
			raw:  `data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":30}}`,
			pt:   100, ct: 20, ch: 30, ok: true,
		},
		{
			name: "chat_miss推算不变",
			raw:  `{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_miss_tokens":70}}`,
			pt:   100, ct: 20, ch: 30, ok: true,
		},
		{
			name: "Responses官方字段名",
			raw:  `{"usage":{"input_tokens":8000000,"output_tokens":1000000,"total_tokens":9000000}}`,
			pt:   8000000, ct: 1000000, ch: 0, ok: true,
		},
		{
			name: "Responses流式事件嵌套usage",
			raw:  `data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":123,"output_tokens":45}}}`,
			pt:   123, ct: 45, ch: 0, ok: true,
		},
		{
			name: "Responses缓存明细等价映射",
			raw:  `{"usage":{"input_tokens":1000,"output_tokens":10,"input_tokens_details":{"cached_tokens":400}}}`,
			pt:   1000, ct: 10, ch: 400, ok: true,
		},
		{
			name: "两套字段同时出现时chat优先(语义不混)",
			raw:  `{"usage":{"prompt_tokens":7,"completion_tokens":8,"input_tokens":900,"output_tokens":900}}`,
			pt:   7, ct: 8, ch: 0, ok: true,
		},
		{
			name: "chat缓存字段优先于Responses明细",
			raw:  `{"usage":{"prompt_tokens":100,"completion_tokens":1,"prompt_cache_hit_tokens":11,"input_tokens_details":{"cached_tokens":400}}}`,
			pt:   100, ct: 1, ch: 11, ok: true,
		},
		{
			name: "字段缺失保持原语义(usage在但无字段)",
			raw:  `{"usage":{}}`,
			pt:   0, ct: 0, ch: 0, ok: true,
		},
		{
			name: "负值仍归零",
			raw:  `{"usage":{"input_tokens":-5,"output_tokens":-6}}`,
			pt:   0, ct: 0, ch: 0, ok: true,
		},
		{
			name: "无usage",
			raw:  `{"id":"x","choices":[]}`,
			ok:   false,
		},
		{
			name: "[DONE]不算usage",
			raw:  `data: [DONE]`,
			ok:   false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pt, ct, ch, ok, err := parseUsage([]byte(tc.raw))
			if err != nil {
				t.Fatalf("parseUsage(%s): %v", tc.raw, err)
			}
			if ok != tc.ok {
				t.Fatalf("ok = %v, want %v", ok, tc.ok)
			}
			if !tc.ok {
				return
			}
			if pt != tc.pt || ct != tc.ct || ch != tc.ch {
				t.Fatalf("got (pt=%d ct=%d cache=%d), want (pt=%d ct=%d cache=%d)", pt, ct, ch, tc.pt, tc.ct, tc.ch)
			}
		})
	}
}

// TestResponsesBillingCountsInputOutputTokens 是 G7 的端到端回归:真 handler
// + 真 PG,上游按 Responses 官方字段名上报,必须真扣钱。
func TestResponsesBillingCountsInputOutputTokens(t *testing.T) {
	t.Run("非流式_官方字段名", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setNon(`{"id":"r","object":"response","output":[],"usage":{"input_tokens":8000000,"output_tokens":1000000,"total_tokens":9000000}}`)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi"}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G7 非流式(官方字段名) status=%d body=%s", w.Code, bodyHead(w))
		t.Logf("G7 非流式 balance=%.6f ledgerSum=%.6f usage_rows=%d tokens=%d cost=%.6f kinds=%v", s.balance, s.ledgerSum, s.usageRows, s.tokens, s.cost, s.kinds)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body=%s)", w.Code, bodyHead(w))
		}
		if !strings.Contains(w.Body.String(), `"response"`) {
			t.Fatalf("上游响应体必须原样交付: %s", bodyHead(w))
		}
		if s.tokens != 9000000 || s.usageRows != 1 {
			t.Fatalf("计费未落账: rows=%d tokens=%d (want rows=1 tokens=9000000) —— /v1/responses 官方字段名被忽略 ⇒ 零计费", s.usageRows, s.tokens)
		}
		if math.Abs(s.cost-9.0) > 1e-6 || math.Abs(s.balance-91.0) > 1e-6 {
			t.Fatalf("金额错误: cost=%.6f balance=%.6f, want cost=9.0 balance=91.0", s.cost, s.balance)
		}
		if s.kinds[serverstore.LedgerKindConsume] != 1 {
			t.Fatalf("应有 1 笔 consume 流水, got %v", s.kinds)
		}
		if !strings.HasSuffix(u.lastPath(), "/responses") {
			t.Fatalf("上游路径 = %q, want 以 /responses 结尾(证明走的是 Responses 上游端点)", u.lastPath())
		}
		checkLedgerInvariant(t, s, "G7 非流式")
	})

	t.Run("非流式_chat字段名对照不变", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setNon(`{"id":"r","object":"response","usage":{"prompt_tokens":8000000,"completion_tokens":1000000}}`)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi"}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G7 对照(chat 字段名) status=%d tokens=%d cost=%.6f balance=%.6f", w.Code, s.tokens, s.cost, s.balance)
		if w.Code != http.StatusOK || s.tokens != 9000000 || math.Abs(s.cost-9.0) > 1e-6 {
			t.Fatalf("chat 字段名口径被改坏: status=%d tokens=%d cost=%.6f", w.Code, s.tokens, s.cost)
		}
	})

	t.Run("非流式_缓存明细按缓存价计费", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setNon(`{"id":"r","object":"response","usage":{"input_tokens":1000000,"output_tokens":0,"input_tokens_details":{"cached_tokens":400000}}}`)
		// 输入 1 元/1M、缓存 0.25 元/1M:600k miss × 1 + 400k cache × 0.25 = 0.7 元
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 0.25)
		w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi"}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G7 缓存明细 status=%d tokens=%d cost=%.6f balance=%.6f", w.Code, s.tokens, s.cost, s.balance)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200", w.Code)
		}
		if s.tokens != 1000000 {
			t.Fatalf("tokens = %d, want 1000000", s.tokens)
		}
		if math.Abs(s.cost-0.7) > 1e-6 {
			t.Fatalf("cost = %.6f, want 0.7(input_tokens_details.cached_tokens 未映射到缓存价)", s.cost)
		}
	})

	t.Run("流式_嵌套usage也要计费", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		// Responses 流式的 usage 嵌在 response.completed 事件的 response.usage
		u.setStream("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"hi\"}\n\n" +
			"event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"usage\":{\"input_tokens\":2000000,\"output_tokens\":1000000}}}\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		w := doPost(t, r, "/v1/responses", `{"model":"r3-model","input":"hi","stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G7 流式(嵌套 usage) status=%d delivered=%d tokens=%d cost=%.6f balance=%.6f",
			w.Code, w.Body.Len(), s.tokens, s.cost, s.balance)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body=%s)", w.Code, bodyHead(w))
		}
		if s.tokens != 3000000 || math.Abs(s.cost-3.0) > 1e-6 {
			t.Fatalf("流式 Responses 未按嵌套 usage 计费: tokens=%d cost=%.6f (want 3000000 / 3.0)", s.tokens, s.cost)
		}
		checkLedgerInvariant(t, s, "G7 流式")
	})
}

// ---------------------------------------------------------------------------
// G12:Anthropic 流式上游不报 usage ⇒ pending 行被删除、分文不取
// ---------------------------------------------------------------------------

// TestAnthropicStreamWithoutUsageStillBilled 是 G12 的端到端回归:上游只发
// 内容事件、从不报 usage,流式请求仍必须计费,且估算口径与 chat 流式**同源**
// (同一个实现:已转发字节 / 4)。测试同时把同一段字节喂给 chat 路径做对照,
// 断言两条路径估算出的 token 数完全相等 —— 防"第二份实现"。
func TestAnthropicStreamWithoutUsageStillBilled(t *testing.T) {
	var sb strings.Builder
	sb.WriteString("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\"}}\n\n")
	for i := 0; i < 50; i++ {
		sb.WriteString("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"")
		sb.WriteString(strings.Repeat("y", 200))
		sb.WriteString("\"}}\n\n")
	}
	sb.WriteString("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	streamBody := sb.String()
	wantTokens := int64(len(streamBody)) / 4

	t.Run("anthropic无usage仍计费", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream(streamBody)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G12 anthropic status=%d delivered=%d usage_rows=%d tokens=%d (want %d) cost=%.6f balance=%.6f kinds=%v",
			w.Code, w.Body.Len(), s.usageRows, s.tokens, wantTokens, s.cost, s.balance, s.kinds)
		if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "content_block_delta") {
			t.Fatalf("流内容未交付: status=%d body=%s", w.Code, bodyHead(w))
		}
		if s.usageRows != 1 || s.tokens <= 0 {
			t.Fatalf("usage 缺失的 Anthropic 流仍然免费: rows=%d tokens=%d (pending 行被删除、零扣费)", s.usageRows, s.tokens)
		}
		if s.tokens != wantTokens {
			t.Fatalf("估算 token = %d, want %d (已转发字节 %d / 4)", s.tokens, wantTokens, len(streamBody))
		}
		if s.cost <= 0 || math.Abs(s.balance-(100-s.cost)) > 1e-9 {
			t.Fatalf("未扣费: cost=%.6f balance=%.6f", s.cost, s.balance)
		}
		if s.kinds[serverstore.LedgerKindConsume] != 1 {
			t.Fatalf("应有 1 笔 consume 流水, got %v", s.kinds)
		}
		checkLedgerInvariant(t, s, "G12 anthropic")
	})

	t.Run("chat同字节流估算口径相同", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream(streamBody)
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G12 chat 对照 status=%d delivered=%d usage_rows=%d tokens=%d (want %d) cost=%.6f",
			w.Code, w.Body.Len(), s.usageRows, s.tokens, wantTokens, s.cost)
		if s.tokens != wantTokens {
			t.Fatalf("chat 估算 token = %d, want %d —— 两条流式路径口径必须同源", s.tokens, wantTokens)
		}
	})
}

// ---------------------------------------------------------------------------
// G5a:anthropicUsage 逐项 clamp 后相加回绕成负数 → 巨额用量计费 ¥0
// ---------------------------------------------------------------------------

// TestAnthropicUsageSaturatesInsteadOfWrapping 双管齐下:
//   - 解析器层:MaxInt64 + 1 必须饱和到 MaxInt64(不能回绕成 MinInt64 → 钳 0);
//   - 运行时层:上游声称 9.2e18 输入 token 时,响应**不得**以零计费交付。
//
// 运行时层用极低单价(1e-6 元/1M)让饱和后的金额仍落在 PG 可表达范围内,
// 从而把"计费 0"与"计费 9.2e6 元"的差异完整暴露出来(而不是停在错误分支上)。
func TestAnthropicUsageSaturatesInsteadOfWrapping(t *testing.T) {
	t.Run("解析器饱和", func(t *testing.T) {
		cases := []struct {
			name string
			raw  string
			want int64
		}{
			{"input=MaxInt64 + cache_creation=1", `{"usage":{"input_tokens":9223372036854775807,"cache_creation_input_tokens":1,"output_tokens":0}}`, math.MaxInt64},
			{"input=MaxInt64-1 + cache_creation=5", `{"usage":{"input_tokens":9223372036854775806,"cache_creation_input_tokens":5}}`, math.MaxInt64},
			{"三项同时溢出", `{"usage":{"input_tokens":9223372036854775807,"cache_read_input_tokens":9223372036854775807,"cache_creation_input_tokens":2}}`, math.MaxInt64},
			{"正常值不受影响", `{"usage":{"input_tokens":1000,"cache_read_input_tokens":100,"cache_creation_input_tokens":50,"output_tokens":7}}`, 1150},
		}
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				pt, ct, cache, ok, err := anthropicUsage([]byte(tc.raw))
				if err != nil || !ok {
					t.Fatalf("anthropicUsage: ok=%v err=%v", ok, err)
				}
				t.Logf("pt=%d cache=%d ct=%d", pt, cache, ct)
				if pt != tc.want {
					t.Fatalf("prompt tokens = %d, want %d(回绕成负数会被 clampTokens 归零 ⇒ 巨额用量计费 0)", pt, tc.want)
				}
				if pt < 0 {
					t.Fatalf("prompt tokens 回绕成负数: %d", pt)
				}
			})
		}
	})

	t.Run("运行时不再白送", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setNon(`{"id":"m","type":"message","usage":{"input_tokens":9223372036854775807,"cache_creation_input_tokens":1,"output_tokens":0}}`)
		// 1e-6 元/1M:饱和后的 9.223372e18 token ≈ 9.223e6 元,余额 1e7 元可覆盖 ⇒
		// 走完整结算(而非余额/范围错误分支),直接暴露"是否真的计费"。
		r, db, uid, token := newAuditR3Gateway(t, u, 1e7, 1e-6, 1e-6, 1e-6)
		w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[]}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G5a 运行时 status=%d usage_rows=%d tokens=%d cost=%.6f balance=%.6f (起始 1e7)", w.Code, s.usageRows, s.tokens, s.cost, s.balance)
		if w.Code != http.StatusOK {
			t.Fatalf("status = %d, want 200 (body=%s)", w.Code, bodyHead(w))
		}
		if s.tokens != math.MaxInt64 {
			t.Fatalf("落库 token = %d, want %d(饱和上限)", s.tokens, int64(math.MaxInt64))
		}
		if s.cost <= 1e6 {
			t.Fatalf("计费 %.6f 元 —— 巨额用量必须真计费(回绕后钳 0 就是原来的洞)", s.cost)
		}
		if s.balance >= 1e7 {
			t.Fatalf("余额未被扣减: %.6f", s.balance)
		}
		checkLedgerInvariant(t, s, "G5a 运行时")
	})
}

// ---------------------------------------------------------------------------
// G5b:除 ErrInsufficientBalance 之外的结算期错误只 log 后 200 交付
// ---------------------------------------------------------------------------

// TestSettlementFailureFailsClosedNonStream 覆盖四条**非流式**交付路径:
// 结算期发生非余额类真实 PG 错误时,一律不得交付上游内容。
func TestSettlementFailureFailsClosedNonStream(t *testing.T) {
	cases := []struct {
		name string
		path string
		body string
		// setUp 覆盖上游报文(逐路径的真实报文形态)
		setUp func(u *auditR3Upstream)
		// marker 是"交付了就说明没拦住"的上游内容标记
		marker string
	}{
		{
			name: "chat_completions", path: "/v1/chat/completions", body: `{"model":"r3-model","messages":[]}`,
			setUp: func(u *auditR3Upstream) {
				u.setNon(`{"id":"r3","choices":[{"message":{"content":"R3_PAYLOAD"}}],"usage":{"prompt_tokens":1000000,"completion_tokens":0}}`)
			},
			marker: "R3_PAYLOAD",
		},
		{
			name: "responses", path: "/v1/responses", body: `{"model":"r3-model","input":"hi"}`,
			setUp: func(u *auditR3Upstream) {
				u.setNon(`{"id":"r3","object":"response","output":[{"content":[{"text":"R3_PAYLOAD"}]}],"usage":{"input_tokens":1000000,"output_tokens":0}}`)
			},
			marker: "R3_PAYLOAD",
		},
		{
			name: "messages", path: "/v1/messages", body: `{"model":"r3-model","messages":[]}`,
			setUp: func(u *auditR3Upstream) {
				u.setNon(`{"id":"m","type":"message","content":[{"type":"text","text":"R3_PAYLOAD"}],"usage":{"input_tokens":1000000,"output_tokens":0}}`)
			},
			marker: "R3_PAYLOAD",
		},
		{
			name: "embeddings", path: "/v1/embeddings", body: `{"model":"r3-model","input":"hi"}`,
			setUp: func(u *auditR3Upstream) {
				u.set(&u.embed, `{"object":"list","data":[{"object":"embedding","index":0,"embedding":[0.5,0.25]}],"usage":{"prompt_tokens":1000000,"total_tokens":1000000}}`)
			},
			marker: "embedding",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			u := newAuditR3Upstream(t)
			tc.setUp(u)
			r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
			breakLedgerInserts(t, db)

			w := doPost(t, r, tc.path, tc.body, token, nil)
			s := auditR3Snapshot(t, db, uid)
			t.Logf("G5b %s status=%d body=%s | usage_rows=%d tokens=%d balance=%.6f ledgerSum=%.6f kinds=%v upstream_calls=%d",
				tc.name, w.Code, bodyHead(w), s.usageRows, s.tokens, s.balance, s.ledgerSum, s.kinds, u.callCount())
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, want 503 METERING_FAILED(结算失败不得静默交付)", w.Code)
			}
			var env struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
				t.Fatalf("503 必须是 JSON 错误信封: %v (%s)", err, bodyHead(w))
			}
			if env.Error.Code != r3MeteringFailedCode {
				t.Fatalf("error.code = %q, want %q", env.Error.Code, r3MeteringFailedCode)
			}
			if strings.Contains(w.Body.String(), tc.marker) {
				t.Fatalf("结算失败仍交付了上游内容(%q): %s", tc.marker, bodyHead(w))
			}
			if s.usageRows != 0 || s.balance != 100 || s.kinds[serverstore.LedgerKindConsume] != 0 {
				t.Fatalf("失败请求必须零落账零扣费: rows=%d balance=%.6f kinds=%v", s.usageRows, s.balance, s.kinds)
			}
			if u.callCount() != 1 {
				t.Fatalf("上游调用次数 = %d, want 1", u.callCount())
			}
			checkLedgerInvariant(t, s, "G5b "+tc.name)
		})
	}
}

// TestSettlementFailureFailsClosedStream 覆盖**流式**路径:SSE 头已发,状态码
// 改不了 —— 唯一合法表达是写一条 error 事件并**终止泵送**,而不是继续 200。
func TestSettlementFailureFailsClosedStream(t *testing.T) {
	t.Run("chat_reported_usage", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"R3_BEFORE\"}}]}\n\n" +
			"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1000000,\"completion_tokens\":0}}\n\n" +
			"data: {\"choices\":[{\"delta\":{\"content\":\"R3_AFTER_USAGE\"}}]}\n\n" +
			"data: [DONE]\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		breakLedgerInserts(t, db)
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		body := w.Body.String()
		t.Logf("G5b chat 流 status=%d delivered=%d 含error=%v 含DONE=%v 含usage后内容=%v balance=%.6f",
			w.Code, len(body), strings.Contains(body, r3MeteringFailedCode), strings.Contains(body, "[DONE]"),
			strings.Contains(body, "R3_AFTER_USAGE"), s.balance)
		if !strings.Contains(body, r3MeteringFailedCode) {
			t.Fatalf("流式结算失败必须写 SSE error 事件(缺失): %s", bodyHead(w))
		}
		if strings.Contains(body, "[DONE]") || strings.Contains(body, "R3_AFTER_USAGE") {
			t.Fatalf("结算失败后必须终止泵送,不得继续交付: %s", bodyHead(w))
		}
		if s.balance != 100 {
			t.Fatalf("失败请求不得扣费: balance=%.6f", s.balance)
		}
		checkLedgerInvariant(t, s, "G5b chat 流")
	})

	t.Run("anthropic_reported_usage", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"usage\":{\"input_tokens\":1000000,\"output_tokens\":0}}}\n\n" +
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"R3_BEFORE\"}}\n\n" +
			"event: message_delta\ndata: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":1000000}}\n\n" +
			"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"R3_AFTER_USAGE\"}}\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		breakLedgerInserts(t, db)
		w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		body := w.Body.String()
		t.Logf("G5b anthropic 流 status=%d delivered=%d 含error=%v 含usage后内容=%v balance=%.6f",
			w.Code, len(body), strings.Contains(body, r3MeteringFailedCode), strings.Contains(body, "R3_AFTER_USAGE"), s.balance)
		if !strings.Contains(body, r3MeteringFailedCode) {
			t.Fatalf("流式结算失败必须写 SSE error 事件(缺失): %s", bodyHead(w))
		}
		if strings.Contains(body, "R3_AFTER_USAGE") {
			t.Fatalf("结算失败后必须终止泵送,不得继续交付: %s", bodyHead(w))
		}
		if s.balance != 100 {
			t.Fatalf("失败请求不得扣费: balance=%.6f", s.balance)
		}
		checkLedgerInvariant(t, s, "G5b anthropic 流")
	})

	// 估算兜底结算(G12 的实现)同样必须 fail-closed:上游一个 usage 都不报,
	// 流结束后按字节估算落账,而落账失败时不能"反正流已经完了"就算了。
	t.Run("estimated_fallback", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"" + strings.Repeat("z", 400) + "\"}}]}\n\ndata: [DONE]\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		breakLedgerInserts(t, db)
		w := doPost(t, r, "/v1/messages", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G5b 估算兜底(anthropic) status=%d 含error=%v balance=%.6f", w.Code, strings.Contains(w.Body.String(), r3MeteringFailedCode), s.balance)
		if !strings.Contains(w.Body.String(), r3MeteringFailedCode) {
			t.Fatalf("估算兜底结算失败也必须发 SSE error: %s", bodyHead(w))
		}
		if s.balance != 100 {
			t.Fatalf("失败请求不得扣费: balance=%.6f", s.balance)
		}
	})

	// chat 路径的估算兜底(同一实现)也必须 fail-closed。
	t.Run("estimated_fallback_chat", func(t *testing.T) {
		u := newAuditR3Upstream(t)
		u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"" + strings.Repeat("z", 400) + "\"}}]}\n\ndata: [DONE]\n\n")
		r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
		breakLedgerInserts(t, db)
		w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
		s := auditR3Snapshot(t, db, uid)
		t.Logf("G5b 估算兜底(chat) status=%d 含error=%v balance=%.6f", w.Code, strings.Contains(w.Body.String(), r3MeteringFailedCode), s.balance)
		if !strings.Contains(w.Body.String(), r3MeteringFailedCode) {
			t.Fatalf("chat 估算兜底结算失败也必须发 SSE error: %s", bodyHead(w))
		}
		if s.balance != 100 {
			t.Fatalf("失败请求不得扣费: balance=%.6f", s.balance)
		}
	})
}

// TestTransientSettlementErrorFailsClosedOnInsert 是"不能把可恢复的瞬时错误
// 误判成免费放行"的反向锁:非流式**插入**结算遇到瞬时 PG 异常时,fail-closed
// 立刻拒绝(插入不是幂等操作,COMMIT 结果未知时重试会产生第二行已计费 usage
// = 重复扣款,所以这里刻意不重试)。
func TestTransientSettlementErrorFailsClosedOnInsert(t *testing.T) {
	u := newAuditR3Upstream(t)
	u.setNon(`{"id":"r3","choices":[{"message":{"content":"R3_PAYLOAD"}}],"usage":{"prompt_tokens":1000000,"completion_tokens":0}}`)
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
	failFirstLedgerInsert(t, db)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[]}`, token, nil)
	s := auditR3Snapshot(t, db, uid)
	t.Logf("G5b 瞬时错误(非流式) status=%d body=%s usage_rows=%d balance=%.6f", w.Code, bodyHead(w), s.usageRows, s.balance)
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503(瞬时结算错误也不得免费放行)", w.Code)
	}
	if strings.Contains(w.Body.String(), "R3_PAYLOAD") {
		t.Fatalf("结算未成功仍交付了内容: %s", bodyHead(w))
	}
	if s.usageRows != 0 || s.balance != 100 {
		t.Fatalf("失败请求必须零落账零扣费: rows=%d balance=%.6f", s.usageRows, s.balance)
	}
}

// TestTransientSettlementErrorRetriedOnIdempotentBackfill 证明"避免 DB 抖动
// 导致全站不可用"的那一半:流式**回填**结算在设计上幂等(settleUsageCostTx
// 按 usage_id 的流水汇总把该行收敛到目标金额,重复执行差额为 0),所以允许
// 有限次重试 —— 一次瞬时失败不会把正常的流式请求误判成失败。
func TestTransientSettlementErrorRetriedOnIdempotentBackfill(t *testing.T) {
	u := newAuditR3Upstream(t)
	u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{}}],\"usage\":{\"prompt_tokens\":1000000,\"completion_tokens\":0}}\n\n" +
		"data: [DONE]\n\n")
	r, db, uid, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
	failFirstLedgerInsert(t, db)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	s := auditR3Snapshot(t, db, uid)
	body := w.Body.String()
	t.Logf("G5b 瞬时错误(流式回填) status=%d 含DONE=%v 含error=%v usage_rows=%d tokens=%d cost=%.6f balance=%.6f",
		w.Code, strings.Contains(body, "[DONE]"), strings.Contains(body, r3MeteringFailedCode), s.usageRows, s.tokens, s.cost, s.balance)
	if strings.Contains(body, r3MeteringFailedCode) {
		t.Fatalf("幂等回填路径的一次瞬时失败不应升级成用户可见失败: %s", bodyHead(w))
	}
	if !strings.Contains(body, "[DONE]") {
		t.Fatalf("流应正常完成: %s", bodyHead(w))
	}
	if s.tokens != 1000000 || math.Abs(s.cost-1.0) > 1e-6 || math.Abs(s.balance-99.0) > 1e-6 {
		t.Fatalf("重试后必须完成结算: tokens=%d cost=%.6f balance=%.6f (want 1000000 / 1.0 / 99.0)", s.tokens, s.cost, s.balance)
	}
	checkLedgerInvariant(t, s, "G5b 瞬时错误(流式回填)")
}

// TestPendingUsageFailureRejectsStreamBeforeUpstream 是同类未堵出口:流式请求
// 连 pending usage 行都插不进去时,原实现只用 usageID=0 继续跑 —— 整条流
// **没有任何计量痕迹**,等于免费交付。现在必须在**调用上游之前**拒绝。
func TestPendingUsageFailureRejectsStreamBeforeUpstream(t *testing.T) {
	u := newAuditR3Upstream(t)
	u.setStream("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n")
	r, db, _, token := newAuditR3Gateway(t, u, 100, 1, 1, 1)
	if _, err := db.Exec(`ALTER TABLE usage RENAME TO r3_usage_broken`); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/chat/completions", `{"model":"r3-model","messages":[],"stream":true}`, token, nil)
	t.Logf("同类出口 status=%d body=%s upstream_calls=%d", w.Code, bodyHead(w), u.callCount())
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503(pending 行写不进去 ⇒ 整条流无计量痕迹)", w.Code)
	}
	if u.callCount() != 0 {
		t.Fatalf("必须在调用上游之前拒绝(上游已被调用 %d 次)", u.callCount())
	}
}
