package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

const upstreamKey = "sk-upstream-test"

// fakeUpstream is an OpenAI-compatible upstream for tests.
type fakeUpstream struct {
	baseURL    string
	srv        *httptest.Server
	gotBody    atomic.Value
	gotAuth    atomic.Value
	requests   atomic.Int64
	streamResp string
	nonStream  string
	status     int
	firstDelay time.Duration
}

func newFakeUpstream(t *testing.T) *fakeUpstream {
	t.Helper()
	f := &fakeUpstream{
		streamResp: `data: {"choices":[{"delta":{"content":"hi"}}]}

data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":10,"completion_tokens":5}}

data: [DONE]

`,
		nonStream: `{"id":"x","object":"chat.completion","usage":{"prompt_tokens":8,"completion_tokens":3}}`,
		status:    http.StatusOK,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.gotBody.Store(string(body))
		f.gotAuth.Store(r.Header.Get("Authorization"))
		f.requests.Add(1)
		if f.firstDelay > 0 {
			time.Sleep(f.firstDelay)
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(string(body), `"stream":true`) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(f.status)
			fmt.Fprint(w, f.streamResp)
			return
		}
		w.WriteHeader(f.status)
		fmt.Fprint(w, f.nonStream)
	}))
	t.Cleanup(f.srv.Close)
	f.baseURL = f.srv.URL
	return f
}

func newGateway(t *testing.T, f *fakeUpstream) (*gin.Engine, *sql.DB, string) {
	t.Helper()
	// 测试环境未接 master key:身份解密(测试密钥明文存储)
	DecryptSecret = func(s string) (string, error) { return s, nil }
	// 每个测试独立临时 DB:清空上游路由缓存,防前一测试的 provider 污染
	// (2026-08-31 加 LoadUpstreams 缓存后引入)。
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	// seed provider + model (handles empty f for pure-auth tests)
	if f != nil {
		if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('fake', ?, ?, '["deepseek-chat"]')`, f.baseURL, upstreamKey); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-chat', 1, 'DeepSeek Chat')`); err != nil {
			t.Fatal(err)
		}
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, token
}

func doPost(t *testing.T, r http.Handler, path, body, token string, ctx context.Context) *httptest.ResponseRecorder {
	t.Helper()
	var req *http.Request
	if ctx != nil {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body)).WithContext(ctx)
	} else {
		req = httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestApplyChannelOverrides(t *testing.T) {
	body := []byte(`{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.7}`)
	overrides := map[string]any{"thinking": map[string]any{"type": "enabled"}, "reasoning_effort": "max"}
	removeKeys := []string{"temperature"}
	out, err := applyChannelOverrides(body, overrides, removeKeys)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	if m["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %v", m["reasoning_effort"])
	}
	if _, ok := m["temperature"]; ok {
		t.Fatal("temperature should be removed")
	}
	th, _ := m["thinking"].(map[string]any)
	if th["type"] != "enabled" {
		t.Fatalf("thinking = %v", m["thinking"])
	}
	// messages preserved
	msgs, _ := m["messages"].([]any)
	if len(msgs) != 1 {
		t.Fatalf("messages = %v", m["messages"])
	}
}

func TestApplyMaxTokensDefault(t *testing.T) {
	// client provided max_tokens -> untouched
	body := []byte(`{"model":"m","max_tokens":100}`)
	out, err := applyMaxTokensDefault(body, `{"max_output":393216}`)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(out, &m)
	if m["max_tokens"].(float64) != 100 {
		t.Fatalf("max_tokens = %v", m["max_tokens"])
	}

	// client omitted -> inject from default_params
	body2 := []byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	out2, err := applyMaxTokensDefault(body2, `{"context_length":1048576,"max_output":393216}`)
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(out2, &m)
	if m["max_tokens"].(float64) != 393216 {
		t.Fatalf("max_tokens = %v", m["max_tokens"])
	}
}

func TestApplyStreamUsageRequest(t *testing.T) {
	// streaming body without stream_options -> inject include_usage=true
	body := []byte(`{"model":"m","stream":true}`)
	out, err := applyStreamUsageRequest(body)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	json.Unmarshal(out, &m)
	opts, ok := m["stream_options"].(map[string]any)
	if !ok {
		t.Fatalf("stream_options missing: %s", out)
	}
	if opts["include_usage"] != true {
		t.Fatalf("include_usage = %v, want true", opts["include_usage"])
	}

	// non-stream body -> untouched (stream_options must not leak into JSON mode)
	nonStream := []byte(`{"model":"m","messages":[]}`)
	out2, err := applyStreamUsageRequest(nonStream)
	if err != nil {
		t.Fatal(err)
	}
	if string(out2) != string(nonStream) {
		t.Fatalf("non-stream body mutated: %s", out2)
	}

	// client already set include_usage=false -> respected (no injection)
	explicitFalse := []byte(`{"model":"m","stream":true,"stream_options":{"include_usage":false}}`)
	out3, err := applyStreamUsageRequest(explicitFalse)
	if err != nil {
		t.Fatal(err)
	}
	if string(out3) != string(explicitFalse) {
		t.Fatalf("explicit include_usage=false was overridden: %s", out3)
	}

	// client set include_usage=true already -> merged without duplication
	explicitTrue := []byte(`{"model":"m","stream":true,"stream_options":{"include_usage":true}}`)
	out4, err := applyStreamUsageRequest(explicitTrue)
	if err != nil {
		t.Fatal(err)
	}
	json.Unmarshal(out4, &m)
	opts4 := m["stream_options"].(map[string]any)
	if opts4["include_usage"] != true {
		t.Fatalf("include_usage = %v, want true", opts4["include_usage"])
	}
}

func TestProxyNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if got := f.gotBody.Load().(string); got != body {
		t.Fatalf("body not forwarded identically: %q", got)
	}
	if got := f.gotAuth.Load().(string); got != "Bearer "+upstreamKey {
		t.Fatalf("auth = %q, want upstream key", got)
	}
	if got := w.Body.String(); got != f.nonStream {
		t.Fatalf("response not passthrough: %q", got)
	}
}

func TestProxyStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type = %q", ct)
	}
	if got := w.Body.String(); got != f.streamResp {
		t.Fatalf("stream not passthrough:\ngot:  %q\nwant: %q", got, f.streamResp)
	}
	// P1-1: the upstream must have been asked to include usage in the final
	// SSE chunk, otherwise the pending usage row can never be backfilled.
	forwarded := f.gotBody.Load().(string)
	var forwardedBody map[string]any
	if err := json.Unmarshal([]byte(forwarded), &forwardedBody); err != nil {
		t.Fatalf("forwarded body not JSON: %v", err)
	}
	opts, ok := forwardedBody["stream_options"].(map[string]any)
	if !ok || opts["include_usage"] != true {
		t.Fatalf("stream_options.include_usage not injected: %s", forwarded)
	}

	// pending row inserted then backfilled with tokens from final chunk
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage").Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("usage pt=%d ct=%d", pt, ct)
	}
}

func TestProxyStreamClientDisconnectStillMeters(t *testing.T) {
	f := newFakeUpstream(t)
	f.firstDelay = 100 * time.Millisecond // give the client time to disconnect mid-stream
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}`

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(body)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()

	done := make(chan struct{})
	go func() { r.ServeHTTP(w, req); close(done) }()
	time.Sleep(50 * time.Millisecond)
	cancel() // simulate client disconnect
	<-done

	// F4(2026-09-11): 客户端断开不再免费 —— 服务端继续 drain 上游直到拿到
	// usage chunk,或按已转发字节估算回填;pending 行保留且 tokens 落账。
	var n int
	var tokens int64
	if err := db.QueryRow("SELECT COUNT(*), COALESCE(MAX(prompt_tokens+completion_tokens),0) FROM usage").Scan(&n, &tokens); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("usage rows = %d, want 1 (disconnect must still be metered)", n)
	}
	if tokens <= 0 {
		t.Fatalf("usage tokens = %d, want > 0 (real usage or estimated backfill)", tokens)
	}
}

// C-9: a 4xx upstream on a streaming request must not leave a pending usage row.
func TestProxyStream4xxCleansPendingRow(t *testing.T) {
	f := newFakeUpstream(t)
	f.status = http.StatusBadRequest
	r, db, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[],"stream":true}`, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("usage rows = %d, want 0 after 4xx stream", n)
	}
}

// C-9: a stream whose providers all fail (502) must not leak a pending row.
func TestProxyStream502CleansPendingRow(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	r, db, token := newGateway(t, nil)
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('dead', ?, 'k', '["deepseek-chat"]')`, deadURL); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[],"stream":true}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("usage rows = %d, want 0 after 502 stream", n)
	}
}

// C-8: an oversized non-stream upstream response is refused with 502 instead
// of being buffered unboundedly.
func TestProxyOversizedUpstreamResponse(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"id":"x","content":"` + strings.Repeat("a", 4096) + `"}`
	r, _, token := newGateway(t, f)

	prev := maxUpstreamBody
	maxUpstreamBody = 1024
	defer func() { maxUpstreamBody = prev }()

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "UPSTREAM" {
		t.Fatalf("code = %v", code)
	}
	// 5#11: the 502 message must not echo upstream error details
	if msg := out["error"].(map[string]any)["message"].(string); strings.Contains(msg, "a") && strings.Contains(msg, "id") {
		t.Fatalf("502 leaks upstream body in message: %q", msg)
	}
}

func TestProxyRecordsUsageNonStream(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`

	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
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
}

func TestProxyUnauthorized(t *testing.T) {
	r, _, _ := newGateway(t, nil)
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "AUTH_REQUIRED" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyNoRetryOn5xx(t *testing.T) {
	f := newFakeUpstream(t)
	f.status = http.StatusInternalServerError
	r, _, token := newGateway(t, f)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want exactly 1 (no retry on 5xx: avoids double-billing)", n)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "UPSTREAM" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyRetriesTransportError(t *testing.T) {
	dead := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	deadURL := dead.URL
	dead.Close()

	r, db, token := newGateway(t, nil)
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('dead', ?, 'k', '["deepseek-chat"]')`, deadURL); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "UPSTREAM" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyRateLimited(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	if err := serverstore.SetSetting(db, "gateway.rate_limit", "2"); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 2; i++ {
		w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("request %d status = %d", i+1, w.Code)
		}
	}
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "RATE_LIMITED" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyInjectsChannelOverrides(t *testing.T) {
	f := newFakeUpstream(t)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	var pid int64
	if err := db.QueryRow(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled, channel) VALUES ('deepseek', ?, ?, '[]', 1, 'deepseek') RETURNING id`, f.baseURL, upstreamKey).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-v4-flash', ?, 'DeepSeek V4 Flash')`, pid); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"hi"}],"temperature":0.7}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(f.gotBody.Load().(string)), &got); err != nil {
		t.Fatal(err)
	}
	if got["reasoning_effort"] != "max" {
		t.Fatalf("reasoning_effort = %v", got["reasoning_effort"])
	}
	if _, ok := got["temperature"]; ok {
		t.Fatal("temperature should be removed")
	}
	th, _ := got["thinking"].(map[string]any)
	if th["type"] != "enabled" {
		t.Fatalf("thinking = %v", got["thinking"])
	}
}

func TestProxyInjectsMaxTokensFromModelDefaultParams(t *testing.T) {
	f := newFakeUpstream(t)
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled) VALUES ('p', ?, ?, '["m"]', 1)`, f.baseURL, upstreamKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params) VALUES ('m', 1, 'M', '{"context_length":1048576,"max_output":393216}')`); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"m","messages":[{"role":"user","content":"hi"}]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var got map[string]any
	if err := json.Unmarshal([]byte(f.gotBody.Load().(string)), &got); err != nil {
		t.Fatal(err)
	}
	if v := got["max_tokens"].(float64); v != 393216 {
		t.Fatalf("max_tokens = %v, want 393216", v)
	}
}

func TestProxyModelNotFound(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions", `{"model":"nope","messages":[]}`, token, nil)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "NOT_FOUND" {
		t.Fatalf("code = %v", code)
	}
}

func TestProxyInvalidBody(t *testing.T) {
	f := newFakeUpstream(t)
	r, _, token := newGateway(t, f)
	w := doPost(t, r, "/v1/chat/completions", `not-json`, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d", w.Code)
	}
}

func TestDecryptSecretHookUsedByLoadUpstreams(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('p', 'http://x', 'encrypted:abc', '["m"]')`); err != nil {
		t.Fatal(err)
	}
	defer func(prev func(string) (string, error)) { DecryptSecret = prev }(DecryptSecret)
	DecryptSecret = func(s string) (string, error) { return "decrypted-" + s, nil }

	ups, err := LoadUpstreams(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 1 || ups[0].APIKey != "decrypted-encrypted:abc" {
		t.Fatalf("upstreams = %+v", ups)
	}
}

func TestMatchModel(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('a', 'http://a', 'k', '["m1","m2"]'), ('b', 'http://b', 'k', '["m3"]')`); err != nil {
		t.Fatal(err)
	}

	up, err := MatchModel(db, "m2")
	if err != nil {
		t.Fatal(err)
	}
	if up.Name != "a" || up.BaseURL != "http://a" {
		t.Fatalf("upstream = %+v", up)
	}
	if _, err := MatchModel(db, "nope"); !errors.Is(err, serverstore.ErrNotFound) {
		t.Fatalf("expected ErrNotFound, got %v", err)
	}
}

// 上游响应头白名单:Set-Cookie 等不得透传给客户端
func TestServeJSONDropsUntrustedHeaders(t *testing.T) {
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Set-Cookie", "sid=abc")
		w.Header().Set("X-Upstream-Key", "secret")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, `{"ok":true}`)
	}))
	t.Cleanup(up.Close)
	body := `{"model":"m","messages":[]}`
	// N2(审计 r3 第四轮)起非流式交付**必然**落一行 usage(缺 usage 时按字节
	// 估算兜底),所以这个交付型用例需要一张真库账本 + 真实用户:否则结算
	// 失败会走 503 分支,透传/白名单根本没被执行(假绿)。
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "hdr", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	a := &API{DB: db}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", strings.NewReader(body))
	resp, err := http.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	a.serveJSON(c, resp, uid, "m", nil)
	if got := w.Body.String(); got != `{"ok":true}` {
		t.Fatalf("上游响应体必须原样透传(否则本用例没走到白名单分支): %q", got)
	}
	for k := range w.Header() {
		if strings.EqualFold(k, "Set-Cookie") || strings.EqualFold(k, "X-Upstream-Key") {
			t.Fatalf("untrusted header leaked: %s", k)
		}
	}
	if !strings.Contains(w.Header().Get("Content-Type"), "application/json") {
		t.Fatalf("Content-Type dropped: %v", w.Header())
	}
}

// 限流桶满员:驱逐最旧桶,新用户不被硬拒
func TestGatewayRateLimiterEvictsOldestWhenFull(t *testing.T) {
	l := newRateLimiter()
	l.max = 2
	if !l.allow(1, 10) || !l.allow(2, 10) {
		t.Fatal("first users allowed")
	}
	if !l.allow(3, 10) {
		t.Fatal("new user refused when bucket table full: must evict oldest")
	}
}

// 审计修复:流式响应的 usage 已回填后客户端才断连,真实计量必须保留
// (回退前无条件 DeleteUsage 会把已回填的真实用量删掉 → 统计丢失)。
func TestProxyStreamBackfilledThenDisconnectKeepsUsage(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	usageID, err := serverstore.RecordUsage(db, uid, "deepseek-chat", 0, 0)
	if err != nil {
		t.Fatal(err)
	}

	// upstream emits the usage chunk first, then a second line that is held
	// until the test releases it after cancelling the client context
	usageLine := "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":5}}\n\n"
	body := &stepReader{
		steps:     []string{usageLine, "data: held\n\n"},
		holdAfter: 1,
		blocked:   make(chan struct{}),
		release:   make(chan struct{}),
	}
	resp := &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(body),
	}

	gin.SetMode(gin.TestMode)
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	ctx, cancel := context.WithCancel(context.Background())
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(ctx)

	done := make(chan struct{})
	go func() {
		a := &API{DB: db}
		a.serveStream(c, resp, usageID, nil)
		close(done)
	}()
	<-body.blocked // usage chunk read + backfilled; stream is now holding
	cancel()       // client disconnects mid-stream
	close(body.release)
	<-done

	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", usageID).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("usage backfilled then dropped: pt=%d ct=%d, want 10/5", pt, ct)
	}
}

// stepReader emits lines in order; reads at index >= holdAfter block on a
// channel and signal via blocked (closed when the hold begins) until the test
// closes release.
type stepReader struct {
	steps     []string
	idx       int
	holdAfter int
	blocked   chan struct{}
	release   chan struct{}
	mu        sync.Mutex
	released  bool
}

func (r *stepReader) Read(p []byte) (int, error) {
	r.mu.Lock()
	if r.idx >= len(r.steps) {
		r.mu.Unlock()
		return 0, io.EOF
	}
	if r.idx >= r.holdAfter && !r.released {
		r.released = true
		r.mu.Unlock()
		close(r.blocked)
		<-r.release
	} else {
		r.mu.Unlock()
	}
	s := r.steps[r.idx]
	r.idx++
	return copy(p, s), nil
}

// 上游回显官方 key 时,客户端响应(体+头,含 4xx 错误路径)必须脱敏。
// 覆盖 chat 非流式/流式 + messages 非流式/流式四条透传路径。
func TestRedactSecrets(t *testing.T) {
	raw := []byte(`{"content":"key sk-abc123456789 leaked here"}`)
	out := redactSecrets(raw, []string{"sk-abc123456789"})
	if strings.Contains(string(out), "sk-abc123456789") {
		t.Fatalf("secret not redacted: %s", out)
	}
	if !strings.Contains(string(out), "***") {
		t.Fatalf("no replacement marker: %s", out)
	}
	// 短于阈值不替换(避免误伤正常内容)
	short := redactSecrets([]byte("a tiny xyz"), []string{"tiny"})
	if string(short) != "a tiny xyz" {
		t.Fatalf("short secret must not be replaced: %s", short)
	}
	// 无匹配返回原 slice(零分配路径)
	same := redactSecrets([]byte("no secrets here"), []string{"sk-abcdefgh"})
	if string(same) != "no secrets here" {
		t.Fatalf("unexpected mutate: %s", same)
	}
	// 头部值脱敏
	if v := redactHeaderValue("x-echo: sk-aaabbbcccdd", []string{"sk-aaabbbcccdd"}); strings.Contains(v, "sk-aaabbbcccdd") {
		t.Fatalf("header not redacted: %s", v)
	}
}

func TestServeJSONRedactsUpstreamKeyEcho(t *testing.T) {
	secret := "sk-upstream-secret-12345678"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream-Echo", secret)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"content":"echo %s","usage":{"prompt_tokens":1,"completion_tokens":1}}`, secret)
	}))
	t.Cleanup(up.Close)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// 交付路径必须真的走到:真实用户 → 结算成功 → 响应体透传(否则 503 分支
	// 里既没有 key 也没有 echo,断言会假绿 —— N2 起非流式交付必落账)。
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "redact", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	a := API{DB: db}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", nil)
	resp, err := http.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	a.serveJSON(c, resp, uid, "m", []string{secret})
	body := w.Body.String()
	if !strings.Contains(body, "echo ***") {
		t.Fatalf("响应体必须透传且已脱敏(否则本用例没走到交付分支): %s", body)
	}
	if strings.Contains(body, secret) {
		t.Fatalf("secret leaked in body: %s", body)
	}
	if strings.Contains(w.Header().Get("X-Upstream-Echo"), secret) {
		t.Fatalf("secret leaked in header: %s", w.Header().Get("X-Upstream-Echo"))
	}
}

func TestServeStreamRedactsUpstreamKeyEcho(t *testing.T) {
	secret := "sk-upstream-secret-12345678"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"echo %s\"}}]}\n\n", secret)
		fmt.Fprintf(w, "data: {\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(up.Close)
	var a API
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", nil)
	resp, err := http.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	a.serveStream(c, resp, 0, []string{secret})
	body := w.Body.String()
	if strings.Contains(body, secret) {
		t.Fatalf("secret leaked in stream: %s", body)
	}
	if !strings.Contains(body, "echo ***") {
		t.Fatalf("replacement missing: %s", body)
	}
}

func TestServeStreamRedactsErrorBody(t *testing.T) {
	secret := "sk-upstream-secret-12345678"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		fmt.Fprintf(w, `{"error":{"message":"bad key %s"}}`, secret)
	}))
	t.Cleanup(up.Close)
	var a API
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", nil)
	resp, err := http.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	a.serveStream(c, resp, 0, []string{secret})
	body := w.Body.String()
	if strings.Contains(body, secret) {
		t.Fatalf("secret leaked in error body: %s", body)
	}
}

// F4(2026-09-11):上游正常结束但从未回传 usage 时,pending 行不能留 0 token
// 悬挂行,也不能直接删除(客户端/上游已产生的用量会全部免费)。新语义:
// 按已转发字节估算 completion tokens 回填,行保留且 tokens > 0。
func TestProxyStreamNormalEOFWithoutUsageEstimatesTokens(t *testing.T) {
	f := newFakeUpstream(t)
	// 只发普通内容行,不含 usage,然后正常结束(EOF)。
	f.streamResp = "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
	r, db, token := newGateway(t, f)
	body := `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	var n int
	var ct int64
	if err := db.QueryRow("SELECT COUNT(*), COALESCE(MAX(completion_tokens),0) FROM usage").Scan(&n, &ct); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("usage rows = %d, want 1 (estimated backfill, not deletion)", n)
	}
	if ct <= 0 {
		t.Fatalf("completion_tokens = %d, want > 0 (estimated from forwarded bytes)", ct)
	}
}

// P0-B(审计 2026-09-12):解析边界必须把上游回报的负 token 归零。
// 上游负 token(cache hit 字段同样)会让 costOfAt 算出负费用 → 结算当作
// refund → 员工余额凭空增加。
func TestParseUsageClampsNegativeTokenCounts(t *testing.T) {
	pt, ct, cache, ok, err := parseUsage([]byte(`{"usage":{"prompt_tokens":-1000000,"completion_tokens":-1000000,"prompt_cache_hit_tokens":-5}}`))
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if pt != 0 || ct != 0 || cache != 0 {
		t.Fatalf("负 token 未归零: pt=%d ct=%d cache=%d, want 0/0/0", pt, ct, cache)
	}
	// miss 推算路径同样不得产出负值
	pt, ct, cache, ok, err = parseUsage([]byte(`{"usage":{"prompt_tokens":-100,"completion_tokens":-1,"prompt_cache_miss_tokens":10}}`))
	if err != nil || !ok || pt != 0 || ct != 0 || cache != 0 {
		t.Fatalf("miss 推算路径: got %d/%d/%d ok=%v err=%v", pt, ct, cache, ok, err)
	}
}

// P0-B 端到端(真实 handler + 真实假上游 + 真 PG):
// 上游回 `prompt_tokens:-1000000, completion_tokens:-1000000`、模型 1 元/1M
// → 旧实现 cost=-1.00 → refund 1.00 → 余额 1.00 变 2.00。修复后余额不变,
// 且不得出现 refund 流水、落库 cost/token 不得为负。
func TestNegativeUpstreamUsageDoesNotRechargeBalance(t *testing.T) {
	f := newFakeUpstream(t)
	f.nonStream = `{"id":"x","object":"chat.completion","usage":{"prompt_tokens":-1000000,"completion_tokens":-1000000}}`
	r, db, token := newGateway(t, f)
	enableBalanceGate(t, db, true)
	activateBalance(t, db, 1, 1) // 已开通,余额 1 元
	if _, err := db.Exec(`UPDATE models SET input_price_per_1m = 1, output_price_per_1m = 1 WHERE name = 'deepseek-chat'`); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[{"role":"user","content":"hi"}]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	// N1/N2(审计 r3 第四轮)起,负 token 归零后该侧等于"没有可用用量" ⇒ 走
	// **已交付字节**估算兜底:只可能产生以已交付字节/4 为上限的极小正向费用,
	// 绝不可能变成"余额凭空增加"(refund)。subject 仍是"不得凭空充值":断言
	// 余额不增加 + 扣费被字节上限约束(而不是"一分不扣")。
	if u.BalanceMoney > 1+1e-9 {
		t.Fatalf("负 token 凭空充值: balance = %v, want <= 1", u.BalanceMoney)
	}
	maxCharge := float64(len(f.nonStream)) / 4 / 1e6 * 1 // ≤ 已交付字节/4 个 token,输出单价 1 元/1M
	if charge := 1 - u.BalanceMoney; charge > maxCharge+1e-9 {
		t.Fatalf("负 token 触发超上限扣费: charge=%.9f max=%.9f(已交付 %d 字节)", charge, maxCharge, len(f.nonStream))
	}
	items, _, err := serverstore.BalanceLedgerPage(db, 1, "", 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range items {
		if e.Kind == serverstore.LedgerKindRefund {
			t.Fatalf("负 token 产生 refund 流水: %+v", e)
		}
	}
	var cost float64
	var pt, ct int64
	if err := db.QueryRow(`SELECT cost, prompt_tokens, completion_tokens FROM usage WHERE user_id = 1`).Scan(&cost, &pt, &ct); err != nil {
		t.Fatal(err)
	}
	if cost < 0 || pt < 0 || ct < 0 {
		t.Fatalf("usage 落库为负: cost=%v pt=%d ct=%d", cost, pt, ct)
	}
}

// 2026-09-11 删除(配额/部门预算下线,唯一闸门=余额;余额闸门用例见 balance_gate_test.go):
//   - TestQuotaBlocksOverLimit
//   - TestQuotaBoundaryBlocks
//   - TestQuotaStreamBlocked
//   - TestQuotaAdminExempt
//   - TestQuotaGlobalDefault
//   - TestQuotaMoneyBlocksOverLimit
//   - TestQuotaMoneyUnderLimit
//   - TestQuotaMoneyAdminExempt
//   - TestQuotaMoneyGlobalDefault
//   - TestQuotaDeptBudgetBlocksOverLimit
//   - TestQuotaDeptBudgetUnderLimit
//   - TestQuotaDeptBudgetAdminExempt
