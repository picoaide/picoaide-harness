// 变异验证方式（CONTEXT §4.3；每条用例都是"闸门去掉即变红"）：
//   - 把 Authorization 头去掉（改成让应用自己传令牌）→ TestChatInjectsHostMintedToken 红；
//   - 把 ctx 预算去掉（http.Client.Timeout 兜 30 s 或干脆不限）→ TestChatBudgetTimeout 红；
//   - 把 429 + BALANCE_EXHAUSTED 的映射改成 INTERNAL → TestChatBalanceInsufficient 红；
//   - 把余额错误里塞进余额数值/上游原文 → TestChatDoesNotLeakInternals 红；
//   - 把 strict 解析（DisallowUnknownFields）去掉 → TestChatRejectsCallerSuppliedToken 红；
//   - 把"续期时把旧行记进 stale、过期才删"改成"立刻删" → TestTokenRowReclamation 红。
package aichat

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 假令牌表（不依赖 PG 的用例用；真实实现另有 PG 用例）=====

type tokenRow struct {
	userID    int64
	raw       string
	expiresAt time.Time
}

type fakeTokenStore struct {
	mu      sync.Mutex
	nextID  int64
	rows    map[int64]tokenRow
	created []int64
	deleted []int64
}

func newFakeTokenStore() *fakeTokenStore {
	return &fakeTokenStore{rows: map[int64]tokenRow{}}
}

func (f *fakeTokenStore) mint(_ *sql.DB, userID int64, raw string, expiresAt time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.nextID++
	f.rows[f.nextID] = tokenRow{userID: userID, raw: raw, expiresAt: expiresAt}
	f.created = append(f.created, f.nextID)
	return f.nextID, nil
}

func (f *fakeTokenStore) drop(_ *sql.DB, id int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.rows, id)
	f.deleted = append(f.deleted, id)
	return nil
}

func (f *fakeTokenStore) live() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.rows)
}

func (f *fakeTokenStore) mintCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.created)
}

func (f *fakeTokenStore) wasDeleted(id int64) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, d := range f.deleted {
		if d == id {
			return true
		}
	}
	return false
}

// ===== 假网关 =====

// gatewayCall 记录一次上游收到的请求（用于断言"host 真的发出了带令牌的请求"）。
type gatewayCall struct {
	Path          string
	Method        string
	Authorization string
	ContentType   string
	Body          []byte
}

type fakeGateway struct {
	*httptest.Server
	mu       sync.Mutex
	calls    []gatewayCall
	handler  func(w http.ResponseWriter, r *http.Request, body []byte)
	deadline time.Duration
}

func newFakeGateway(t *testing.T, fn func(w http.ResponseWriter, r *http.Request, body []byte)) *fakeGateway {
	t.Helper()
	g := &fakeGateway{handler: fn}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		g.mu.Lock()
		g.calls = append(g.calls, gatewayCall{
			Path:          r.URL.Path,
			Method:        r.Method,
			Authorization: r.Header.Get("Authorization"),
			ContentType:   r.Header.Get("Content-Type"),
			Body:          body,
		})
		g.mu.Unlock()
		g.handler(w, r, body)
	}))
	t.Cleanup(g.Close)
	return g
}

func (g *fakeGateway) snapshot() []gatewayCall {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make([]gatewayCall, len(g.calls))
	copy(out, g.calls)
	return out
}

func (g *fakeGateway) callCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return len(g.calls)
}

// okGateway 返回一个 OpenAI 兼容的成功响应。
func okGateway(t *testing.T) *fakeGateway {
	t.Helper()
	return newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"deepseek-chat","choices":[{"message":{"role":"assistant","content":"你好"},
		  "finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`))
	})
}

// ===== 夹具 =====

type testClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *testClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *testClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
}

func newTestClient(t *testing.T, baseURL string) (*Client, *fakeTokenStore, *testClock) {
	t.Helper()
	store := newFakeTokenStore()
	clock := &testClock{t: time.Date(2026, 9, 18, 10, 0, 0, 0, time.UTC)}
	c := New(Options{BaseURL: baseURL})
	if c.cfgErr != nil {
		t.Fatalf("New(%q) 装配失败: %v", baseURL, c.cfgErr)
	}
	c.d.minter = store.mint
	c.d.dropper = store.drop
	c.d.now = clock.now
	c.d.defaultModel = func(*sql.DB) (string, error) { return "default-model", nil }
	t.Cleanup(c.RevokeUserAllForTest)
	return c, store, clock
}

// RevokeUserAllForTest 在用例结束时清掉缓存（避免跨用例串味）。
func (c *Client) RevokeUserAllForTest() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tokens = map[tokenKey]*sessionToken{}
}

func testUser() *abi.User {
	return &abi.User{ID: 10231, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部"}
}

func simpleParams() abi.AIChatParams {
	return abi.AIChatParams{Messages: []abi.ChatMessage{{Role: "user", Content: "报销单怎么填"}}}
}

// ===== 成功路径与身份注入 =====

func TestChatInjectsHostMintedToken(t *testing.T) {
	g := okGateway(t)
	c, store, _ := newTestClient(t, g.URL)

	res, err := c.Chat(context.Background(), testUser(), simpleParams())
	if err != nil {
		t.Fatalf("Chat = %v", err)
	}
	if res.Content != "你好" || res.Model != "deepseek-chat" {
		t.Fatalf("result = %+v", res)
	}
	if res.Usage == nil || res.Usage.PromptTokens != 11 || res.Usage.CompletionTokens != 7 || res.Usage.TotalTokens != 18 {
		t.Fatalf("usage = %+v", res.Usage)
	}

	calls := g.snapshot()
	if len(calls) != 1 {
		t.Fatalf("网关收到 %d 次请求, want 1", len(calls))
	}
	call := calls[0]
	if call.Method != http.MethodPost || call.Path != "/v1/chat/completions" {
		t.Fatalf("method/path = %s %s", call.Method, call.Path)
	}
	token, ok := strings.CutPrefix(call.Authorization, "Bearer ")
	if !ok || token == "" {
		t.Fatalf("Authorization = %q, want Bearer <token>", call.Authorization)
	}
	if len(token) != rawTokenBytes*2 {
		t.Fatalf("令牌长度 = %d, want %d（32 字节 hex）", len(token), rawTokenBytes*2)
	}
	if _, err := hex.DecodeString(token); err != nil {
		t.Fatalf("令牌不是 hex: %v", err)
	}
	// 令牌必须是**宿主铸造的**那一张（应用拿不到、也传不进）。
	if store.mintCount() != 1 {
		t.Fatalf("铸造次数 = %d, want 1", store.mintCount())
	}
	for id, row := range store.rows {
		if row.raw != token {
			t.Fatalf("网关收到的令牌不是宿主铸造的（row %d）", id)
		}
		if row.userID != 10231 {
			t.Fatalf("令牌挂在 user %d 上, want 10231（谁登录用谁的钱，R36）", row.userID)
		}
		if d := row.expiresAt.Sub(c.d.now()); d != limits.AITokenTTL {
			t.Fatalf("令牌有效期 = %v, want %v", d, limits.AITokenTTL)
		}
	}
	// 应用拿不到令牌：结果体里不得出现它。
	if strings.Contains(fmt.Sprint(res), token) {
		t.Fatal("令牌泄露进了返回给应用的结果")
	}

	// stream=false + 不注入系统提示 + 消息原样。
	var sent upstreamChatRequest
	if err := json.Unmarshal(call.Body, &sent); err != nil {
		t.Fatalf("请求体不是 JSON: %v (%s)", err, call.Body)
	}
	if sent.Stream {
		t.Fatal("stream 必须是 false（宿主函数是同步请求/应答）")
	}
	if len(sent.Messages) != 1 || sent.Messages[0].Role != "user" || sent.Messages[0].Content != "报销单怎么填" {
		t.Fatalf("messages 被改写了: %+v（平台不注入系统提示）", sent.Messages)
	}
	if sent.Model != "deepseek-chat" && sent.Model != "default-model" {
		t.Fatalf("model = %q", sent.Model)
	}
}

// 应用**没有任何渠道**能把令牌塞给宿主：多余字段会被严格解析拒掉。
func TestChatRejectsCallerSuppliedToken(t *testing.T) {
	g := okGateway(t)
	c, _, _ := newTestClient(t, g.URL)

	raw := json.RawMessage(`{"messages":[{"role":"user","content":"hi"}],"token":"app-supplied-token"}`)
	_, e := decodeChatParamsForTest(c, raw)
	if e == nil {
		t.Fatal("带 token 字段的参数必须被拒（应用不参与令牌）")
	}
	if e.Code != apperr.CodeValidation {
		t.Fatalf("code = %s, want VALIDATION", e.Code)
	}
	if g.callCount() != 0 {
		t.Fatal("被拒的调用不得触达网关")
	}
}

// decodeChatParamsForTest 直接跑 hostcap 之外的严格解析路径（与 Chat 内部同一实现）。
func decodeChatParamsForTest(_ *Client, raw json.RawMessage) (abi.AIChatParams, *apperr.Error) {
	var p abi.AIChatParams
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return p, apperr.New(apperr.CodeValidation, "参数字段不合法").WithCause(err)
	}
	return p, nil
}

func TestChatAnonymousRejected(t *testing.T) {
	g := okGateway(t)
	c, store, _ := newTestClient(t, g.URL)

	_, err := c.Chat(context.Background(), nil, simpleParams())
	if err == nil {
		t.Fatal("匿名调用必须拒（§4.7 / §10.4）")
	}
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeAuthRequired || e.Status() != 401 {
		t.Fatalf("err = %v, want AUTH_REQUIRED/401", err)
	}
	if g.callCount() != 0 || store.mintCount() != 0 {
		t.Fatal("匿名调用不得触达网关，也不得铸造令牌")
	}
	// user.id 缺失同样按匿名处理（身份不完整 = 不能用）。
	if _, err := c.Chat(context.Background(), &abi.User{}, simpleParams()); err == nil {
		t.Fatal("user.id 缺失必须拒")
	}
}

// ===== 失败映射（§4.7 / §7.4）=====

func TestChatBalanceInsufficient(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"网关闸门 429 BALANCE_EXHAUSTED", 429, `{"error":{"code":"BALANCE_EXHAUSTED","message":"余额不足,请联系管理员"}}`},
		{"结算失败 429 BALANCE_EXHAUSTED", 429, `{"error":{"code":"BALANCE_EXHAUSTED","message":"费用 8.00 元超过余额 1.00 元"}}`},
		{"402 语义", 402, `{"error":{"code":"PAYMENT_REQUIRED","message":"insufficient balance: 1.00"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			c, _, _ := newTestClient(t, g.URL)
			_, err := c.Chat(context.Background(), testUser(), simpleParams())
			e, ok := apperr.As(err)
			if !ok {
				t.Fatalf("err = %v, want *apperr.Error", err)
			}
			if e.Code != apperr.CodeAIBalanceInsufficient {
				t.Fatalf("code = %s, want %s", e.Code, apperr.CodeAIBalanceInsufficient)
			}
			if e.Status() != 402 {
				t.Fatalf("status = %d, want 402（§10.3 第 38b 项）", e.Status())
			}
			// 不暴露余额数值，也不透出上游原文。
			blob := e.JSON()
			for _, leak := range []string{"8.00", "1.00", "insufficient balance", "余额不足,请联系管理员"} {
				if strings.Contains(blob, leak) {
					t.Fatalf("错误体泄露了内部信息 %q: %s", leak, blob)
				}
			}
			hints := strings.Join(e.Hints, " ")
			if !strings.Contains(hints, "桌面客户端") {
				t.Fatalf("hints 必须指向「在桌面客户端查看余额」: %v", e.Hints)
			}
			if g.callCount() != 1 {
				t.Fatalf("网关调用次数 = %d, want 1", g.callCount())
			}
		})
	}
}

func TestChatRateLimited(t *testing.T) {
	g := newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":"RATE_LIMITED","message":"请求过于频繁,请稍后再试"}}`))
	})
	c, _, _ := newTestClient(t, g.URL)
	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeAIRateLimited {
		t.Fatalf("err = %v, want AI_RATE_LIMITED", err)
	}
	if e.Status() != 429 {
		t.Fatalf("status = %d, want 429", e.Status())
	}
	if e.Details["retry_after_seconds"] != 7 {
		t.Fatalf("details = %v, want retry_after_seconds=7（带 Retry-After）", e.Details)
	}
}

func TestChatRateLimitedWithoutRetryAfterHeader(t *testing.T) {
	g := newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"code":"RATE_LIMITED"}}`))
	})
	c, _, _ := newTestClient(t, g.URL)
	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, _ := apperr.As(err)
	if e == nil || e.Code != apperr.CodeAIRateLimited {
		t.Fatalf("err = %v", err)
	}
	if e.Details["retry_after_seconds"] != limits.RetryAfterSeconds {
		t.Fatalf("缺 Retry-After 时应当回落 limits.RetryAfterSeconds(%d)，得到 %v",
			limits.RetryAfterSeconds, e.Details)
	}
}

// 其它上游失败一律 INTERNAL，且**不透出上游原文**（§4.7）。
func TestChatDoesNotLeakInternals(t *testing.T) {
	const secret = "upstream-internal-host.db.local:5432 password=hunter2"
	cases := []struct {
		name   string
		status int
		body   string
	}{
		{"上游 500", 500, `{"error":{"message":"` + secret + `"}}`},
		{"上游 400（模型不存在）", 400, `{"error":{"message":"model not found: ` + secret + `"}}`},
		{"令牌被拒 401", 401, `{"error":{"message":"` + secret + `"}}`},
		{"200 但结构异常", 200, `{"object":"chat.completion","note":"` + secret + `"}`},
		{"200 但 4xx 风格错误体", 200, `{"error":{"code":"INTERNAL","message":"` + secret + `"}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			g := newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			})
			c, _, _ := newTestClient(t, g.URL)
			_, err := c.Chat(context.Background(), testUser(), simpleParams())
			e, ok := apperr.As(err)
			if !ok {
				t.Fatalf("err = %v, want *apperr.Error", err)
			}
			if e.Code != apperr.CodeInternal {
				t.Fatalf("code = %s, want INTERNAL（上游非余额/限流失败统一收敛）", e.Code)
			}
			if e.Status() != 500 {
				t.Fatalf("status = %d, want 500", e.Status())
			}
			if blob := e.JSON(); strings.Contains(blob, secret) || strings.Contains(blob, "hunter2") {
				t.Fatalf("错误体泄露了上游原文: %s", blob)
			}
		})
	}
}

// ===== 预算与取消 =====

func TestChatBudgetTimeout(t *testing.T) {
	g := newFakeGateway(t, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		time.Sleep(300 * time.Millisecond)
		_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"late"}}]}`))
	})
	c, _, _ := newTestClient(t, g.URL)
	c.d.budget = 50 * time.Millisecond // 夹具：真实预算是 limits.HostAIChatBudget(30 s)

	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeHostCallOverBudget {
		t.Fatalf("err = %v, want HOST_CALL_OVER_BUDGET（宿主调用超预算）", err)
	}
	if e.Status() != 504 {
		t.Fatalf("status = %d, want 504", e.Status())
	}
	if e.Details["budget_ms"] != int64(50) {
		t.Fatalf("details = %v, want budget_ms=50", e.Details)
	}
}

func TestChatCancelledRequestIsModuleKilled(t *testing.T) {
	g := newFakeGateway(t, func(w http.ResponseWriter, r *http.Request, _ []byte) {
		<-r.Context().Done() // 客户端（宿主）取消后立刻返回
	})
	c, _, _ := newTestClient(t, g.URL)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err := c.Chat(ctx, testUser(), simpleParams())
	<-done
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeModuleKilled {
		t.Fatalf("err = %v, want MODULE_KILLED（请求被杀，不是 AI 慢）", err)
	}
}

// ===== 令牌缓存 / 续期 / 回收 =====

func TestTokenReuseAndReclamation(t *testing.T) {
	g := okGateway(t)
	c, store, clock := newTestClient(t, g.URL)
	ctx := WithSessionKey(context.Background(), "sess-1")

	// 第一次：铸造一张。
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 1 || store.live() != 1 {
		t.Fatalf("mint=%d live=%d, want 1/1", store.mintCount(), store.live())
	}
	first := g.snapshot()[0].Authorization

	// 续期窗口内（到期前还有 > 5 min）：复用，不重铸。
	clock.advance(limits.AITokenTTL - limits.AITokenRenewBefore - time.Minute)
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 1 {
		t.Fatalf("续期窗口外又铸了一张（mint=%d）—— 应当复用", store.mintCount())
	}
	if got := g.snapshot()[1].Authorization; got != first {
		t.Fatal("缓存命中时应当复用同一张令牌")
	}

	// 进入续期窗口：重铸；**旧行此刻不能删**（可能还有在飞请求）。
	clock.advance(2 * time.Minute)
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 2 {
		t.Fatalf("续期窗口内应当重铸，mint=%d", store.mintCount())
	}
	second := g.snapshot()[2].Authorization
	if second == first {
		t.Fatal("重铸必须换一张新令牌")
	}
	if store.live() != 2 {
		t.Fatalf("live=%d, want 2（当前 + 尚未过期的上一张）", store.live())
	}
	// 旧行对应的 id 是 1。
	if store.wasDeleted(1) {
		t.Fatal("旧行在仍然有效时被删了：在飞请求会撞 401")
	}

	// 再往后（跨过当前令牌的到期时刻）：两张旧行都被回收，行数有界。
	clock.advance(limits.AITokenTTL + time.Second)
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if !store.wasDeleted(1) || !store.wasDeleted(2) {
		t.Fatalf("过期旧行没有被回收: deleted=%v", store.deleted)
	}
	if store.live() > 2 {
		t.Fatalf("live=%d, want ≤2（每会话最多 2 行）", store.live())
	}
}

// 到期判据的取等边界：必须与 serverauth.VerifyToken 的 `After(expiresAt)` 一致。
func TestExpiryFencepost(t *testing.T) {
	at := time.Unix(1000, 0)
	if expired(at, at) {
		t.Fatal("now == expiresAt 不能算过期（VerifyToken 用 time.Now().After(expiresAt)）")
	}
	if !expired(at.Add(time.Nanosecond), at) {
		t.Fatal("now 严格晚于 expiresAt 必须算过期")
	}
}

func TestTokenSessionsAreIsolated(t *testing.T) {
	g := okGateway(t)
	c, store, _ := newTestClient(t, g.URL)
	ctxA := WithSessionKey(context.Background(), "sess-A")
	ctxB := WithSessionKey(context.Background(), "sess-B")
	if _, err := c.Chat(ctxA, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Chat(ctxB, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 2 {
		t.Fatalf("不同会话应当各铸一张，mint=%d", store.mintCount())
	}
	if g.snapshot()[0].Authorization == g.snapshot()[1].Authorization {
		t.Fatal("不同会话不得共用令牌（否则登出无法按会话吊销）")
	}
	// 另一个用户同样隔离。
	if _, err := c.Chat(ctxA, &abi.User{ID: 999, Username: "lisi"}, simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 3 {
		t.Fatalf("不同用户应当各铸一张，mint=%d", store.mintCount())
	}
}

func TestRevokeSessionAndUser(t *testing.T) {
	g := okGateway(t)
	c, store, _ := newTestClient(t, g.URL)
	ctxA := WithSessionKey(context.Background(), "sess-A")
	ctxB := WithSessionKey(context.Background(), "sess-B")
	other := &abi.User{ID: 999, Username: "lisi"}

	if _, err := c.Chat(ctxA, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Chat(ctxB, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Chat(ctxB, other, simpleParams()); err != nil {
		t.Fatal(err)
	}
	tokenA := g.snapshot()[0].Authorization

	// 登出会话 A：立刻删行。
	c.RevokeSession("sess-A")
	if !store.wasDeleted(1) {
		t.Fatalf("RevokeSession 必须删行: deleted=%v", store.deleted)
	}
	if store.live() != 2 {
		t.Fatalf("live=%d, want 2（只吊销 sess-A）", store.live())
	}
	// 下次调用重新铸造（旧令牌不再复用）。
	if _, err := c.Chat(ctxA, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if got := g.snapshot()[3].Authorization; got == tokenA {
		t.Fatal("吊销后不得复用旧令牌")
	}

	// 按用户批量吊销：只动这个用户的行。
	c.RevokeUser(10231)
	if store.live() != 1 {
		t.Fatalf("live=%d, want 1（只剩另一个用户）", store.live())
	}
	c.RevokeUser(999)
	if store.live() != 0 {
		t.Fatalf("live=%d, want 0", store.live())
	}
}

// 删行失败必须被计数（§4.9：吊销是 fire-and-forget + 失败计数），且内存条目照丢。
func TestRevokeFailureCounted(t *testing.T) {
	g := okGateway(t)
	c, _, _ := newTestClient(t, g.URL)
	c.d.dropper = func(*sql.DB, int64) error { return fmt.Errorf("db is down") }
	ctx := WithSessionKey(context.Background(), "sess-x")
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	c.RevokeSession("sess-x")
	if c.RevokeFailures() == 0 {
		t.Fatal("删行失败必须计数")
	}
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if g.snapshot()[0].Authorization == g.snapshot()[1].Authorization {
		t.Fatal("即使删行失败，内存条目也必须被丢掉（明文只在内存 ⇒ 丢条目即失效）")
	}
}

// ===== 参数校验 =====

func TestChatParamValidation(t *testing.T) {
	g := okGateway(t)
	c, _, _ := newTestClient(t, g.URL)

	many := make([]abi.ChatMessage, limits.AIChatMaxMessages+1)
	for i := range many {
		many[i] = abi.ChatMessage{Role: "user", Content: "x"}
	}
	big := make([]abi.ChatMessage, 0, 1)
	big = append(big, abi.ChatMessage{Role: "user", Content: strings.Repeat("x", limits.AIChatMaxBodyBytes+1)})

	cases := []struct {
		name string
		p    abi.AIChatParams
	}{
		{"messages 为空", abi.AIChatParams{}},
		{"messages 超条数", abi.AIChatParams{Messages: many}},
		{"请求体超字节", abi.AIChatParams{Messages: big}},
		{"role 为空", abi.AIChatParams{Messages: []abi.ChatMessage{{Content: "hi"}}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := c.Chat(context.Background(), testUser(), tc.p)
			e, ok := apperr.As(err)
			if !ok || e.Code != apperr.CodeValidation {
				t.Fatalf("err = %v, want VALIDATION", err)
			}
		})
	}
	if g.callCount() != 0 {
		t.Fatal("校验失败的调用不得触达网关（省下的是使用者的钱）")
	}
}

func TestChatModelResolution(t *testing.T) {
	g := okGateway(t)
	c, _, _ := newTestClient(t, g.URL)

	// 显式 model 原样透传（模型由服务端裁决，宿主不挑模型）。
	p := simpleParams()
	p.Model = "deepseek-reasoner"
	if _, err := c.Chat(context.Background(), testUser(), p); err != nil {
		t.Fatal(err)
	}
	var sent upstreamChatRequest
	if err := json.Unmarshal(g.snapshot()[0].Body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Model != "deepseek-reasoner" {
		t.Fatalf("model = %q", sent.Model)
	}

	// 未指定 ⇒ 平台默认模型。
	if _, err := c.Chat(context.Background(), testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(g.snapshot()[1].Body, &sent); err != nil {
		t.Fatal(err)
	}
	if sent.Model != "default-model" {
		t.Fatalf("缺省 model = %q, want default-model", sent.Model)
	}

	// 平台没有默认模型 ⇒ 可读的 VALIDATION（不是静默 500）。
	c.d.defaultModel = func(*sql.DB) (string, error) { return "", nil }
	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeValidation || e.Details["field"] != "model" {
		t.Fatalf("err = %v, want VALIDATION(field=model)", err)
	}
}

// ===== 装配 =====

func TestBaseURLCannotLeakTokenOverPlaintext(t *testing.T) {
	// 明文 http 发往非回环地址：Bearer 令牌会裸奔在信道上 ⇒ 必须拒。
	c := New(Options{BaseURL: "http://harness.example.com:8080"})
	if c.cfgErr == nil {
		t.Fatal("明文 http + 非回环地址必须拒（否则用户令牌在信道上裸奔）")
	}
	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeInternal {
		t.Fatalf("err = %v, want INTERNAL", err)
	}
	// 显式放行才算放行。
	if c2 := New(Options{BaseURL: "http://harness.example.com:8080", AllowPlaintextRemote: true}); c2.cfgErr != nil {
		t.Fatalf("显式 AllowPlaintextRemote 时应当放行: %v", c2.cfgErr)
	}
	// 回环 + http（服务端调自己）是默认放行的形态。
	if c3 := New(Options{BaseURL: "http://127.0.0.1:8080"}); c3.cfgErr != nil {
		t.Fatalf("回环地址应当放行: %v", c3.cfgErr)
	}
	if c4 := New(Options{BaseURL: "http://localhost:8080"}); c4.cfgErr != nil {
		t.Fatalf("localhost 应当放行: %v", c4.cfgErr)
	}
	if c5 := New(Options{BaseURL: "https://harness.example.com"}); c5.cfgErr != nil {
		t.Fatalf("https 应当放行: %v", c5.cfgErr)
	}
	for _, bad := range []string{"", "ftp://127.0.0.1", "127.0.0.1:8080", "http://"} {
		if c := New(Options{BaseURL: bad}); c.cfgErr == nil {
			t.Fatalf("BaseURL=%q 必须拒", bad)
		}
	}
}

func TestEndpointAcceptsV1Suffix(t *testing.T) {
	g := okGateway(t)
	for _, base := range []string{g.URL, g.URL + "/v1", g.URL + "/"} {
		c, _, _ := newTestClient(t, base)
		if _, err := c.Chat(context.Background(), testUser(), simpleParams()); err != nil {
			t.Fatalf("BaseURL=%q: %v", base, err)
		}
	}
	for _, call := range g.snapshot() {
		if call.Path != "/v1/chat/completions" {
			t.Fatalf("path = %q（BaseURL 带不带 /v1 都要落到同一条路由）", call.Path)
		}
	}
}

func TestMissingDBFailsClosed(t *testing.T) {
	g := okGateway(t)
	c := New(Options{BaseURL: g.URL}) // 没有 DB ⇒ 没有令牌表
	_, err := c.Chat(context.Background(), testUser(), simpleParams())
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeInternal {
		t.Fatalf("err = %v, want INTERNAL", err)
	}
	if g.callCount() != 0 {
		t.Fatal("没有令牌表时不得发出无令牌请求")
	}
}

// WithSessionKey 的边界：空键不写 ctx；未绑定时同一用户共用一个令牌（有文档说明）。
func TestSessionKeyBinding(t *testing.T) {
	ctx := context.Background()
	if SessionKeyFrom(WithSessionKey(ctx, "")) != "" {
		t.Fatal("空键不应写入 ctx")
	}
	if SessionKeyFrom(WithSessionKey(ctx, "s1")) != "s1" {
		t.Fatal("会话键没有正确绑定")
	}
	g := okGateway(t)
	c, store, _ := newTestClient(t, g.URL)
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Chat(ctx, testUser(), simpleParams()); err != nil {
		t.Fatal(err)
	}
	if store.mintCount() != 1 {
		t.Fatalf("未绑定会话键时同一用户应共用一张令牌，mint=%d", store.mintCount())
	}
}

// ===== 真实 PostgreSQL（api_tokens）：无 PG 时自动 skip =====
//
// 这个用例覆盖"生产实现"这一半：serverstore.CreateToken 真的写行、
// serverauth.VerifyToken 真的认这张令牌（= 网关 BearerAuth 的判据）、
// 回收真的删行。前面的假表用例覆盖"不依赖 PG 也能跑的完整 Chat 路径"。

func TestTokenStoreAgainstPostgres(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	userID, err := serverstore.CreateUserWithPassword(db, "zhangwei", "pw-for-test-123456")
	if err != nil {
		t.Fatalf("建用户: %v", err)
	}
	g := okGateway(t)
	// 这里用**生产装配**（Options.DB 非 nil ⇒ 注入 serverstore.CreateToken）。
	c := New(Options{BaseURL: g.URL, DB: db})
	if c.cfgErr != nil {
		t.Fatal(c.cfgErr)
	}
	clock := &testClock{t: time.Now()}
	c.d.now = clock.now
	// 默认模型解析走真实实现（settings + 模型目录）：这里显式给模型，避免依赖目录数据。
	ctx := WithSessionKey(context.Background(), "pg-sess")
	p := simpleParams()
	p.Model = "pg-model"
	// 必须用**真实存在的用户 id**：api_tokens.user_id 有外键（测试想证明的正是
	// "写进的是真表"）。
	pgUser := &abi.User{ID: userID, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部"}

	if _, err := c.Chat(ctx, pgUser, p); err != nil {
		t.Fatalf("Chat = %v", err)
	}
	calls := g.snapshot()
	token := strings.TrimPrefix(calls[0].Authorization, "Bearer ")
	if token == "" {
		t.Fatal("没有发出令牌")
	}
	// 平台自己的校验路径必须认这张令牌（= BearerAuth 的判据）。
	u, err := serverauth.VerifyToken(db, token)
	if err != nil {
		t.Fatalf("serverauth.VerifyToken(宿主铸造的令牌) = %v（网关会 401 ⇒ 应用调不通 AI）", err)
	}
	if u.ID != userID || u.Username != "zhangwei" {
		t.Fatalf("令牌归属 = %d/%s, want %d/zhangwei（谁登录用谁的钱）", u.ID, u.Username, userID)
	}
	// 明文不落盘：表里只有 SHA-256。
	var hash string
	if err := db.QueryRow(`SELECT token_hash FROM api_tokens WHERE user_id = ?`, userID).Scan(&hash); err != nil {
		t.Fatalf("令牌行不存在: %v", err)
	}
	if hash != serverstore.TokenHash(token) || strings.Contains(hash, token) {
		t.Fatalf("api_tokens 里存的不是 SHA-256: %q", hash)
	}
	// 有效期为 45 min（网关侧看得到的真实约束）。
	row, err := serverstore.GetTokenByHash(db, hash)
	if err != nil {
		t.Fatal(err)
	}
	ttl := row.ExpiresAt.Sub(clock.now())
	if ttl < limits.AITokenTTL-time.Minute || ttl > limits.AITokenTTL+time.Minute {
		t.Fatalf("TTL = %v, want ≈%v（§4.7 的 45 min 必须是 DB 侧事实）", ttl, limits.AITokenTTL)
	}

	// 续期：进入窗口后重铸，旧行保留；等它过期后回收 ⇒ 行数有界。
	clock.advance(limits.AITokenTTL - limits.AITokenRenewBefore + time.Second)
	if _, err := c.Chat(ctx, pgUser, p); err != nil {
		t.Fatalf("续期 Chat = %v", err)
	}
	if n := countTokens(t, db, userID); n != 2 {
		t.Fatalf("续期后行数 = %d, want 2（当前 + 尚未过期的上一张）", n)
	}
	clock.advance(limits.AITokenTTL)
	if _, err := c.Chat(ctx, pgUser, p); err != nil {
		t.Fatalf("再次续期 Chat = %v", err)
	}
	if n := countTokens(t, db, userID); n > 2 {
		t.Fatalf("行数 = %d, want ≤2（过期旧行必须被回收）", n)
	}

	// 登出：按会话立即吊销（行被删 ⇒ VerifyToken 立刻不认）。
	c.RevokeSession("pg-sess")
	if n := countTokens(t, db, userID); n != 0 {
		t.Fatalf("RevokeSession 后行数 = %d, want 0", n)
	}
	if _, err := serverauth.VerifyToken(db, token); err == nil {
		t.Fatal("吊销后旧令牌仍然有效")
	}
}

func countTokens(t *testing.T, db *sql.DB, userID int64) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM api_tokens WHERE user_id = ?`, userID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}
