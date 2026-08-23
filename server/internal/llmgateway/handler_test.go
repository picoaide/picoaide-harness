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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/gw.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

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

func TestProxyStreamClientDisconnectKeepsPendingRow(t *testing.T) {
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

	// C-9: a client-disconnected stream must not leak a pending usage row
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("usage rows = %d, want 0 (pending row cleaned up on disconnect)", n)
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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/inject.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	res, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled, channel) VALUES ('deepseek', ?, ?, '[]', 1, 'deepseek')`, f.baseURL, upstreamKey)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := res.LastInsertId()
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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/maxout.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/hook.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/match.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	var a API
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest("POST", "/", strings.NewReader(body))
	resp, err := http.Get(up.URL)
	if err != nil {
		t.Fatal(err)
	}
	a.serveJSON(c, resp, 1, "m")
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

// setUserQuota sets alice's (user id 1) monthly quota and optionally their
// admin flag, then seeds the given monthly usage.
func setUserQuota(t *testing.T, db *sql.DB, quota int64, admin bool, used int64) {
	t.Helper()
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	q := quota
	u.QuotaTokens = &q
	u.IsAdmin = admin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	if used > 0 {
		if _, err := serverstore.RecordUsage(db, 1, "deepseek-chat", used, 0); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQuotaBlocksOverLimit(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserQuota(t, db, 100, false, 100) // used == quota → blocked

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "QUOTA_EXCEEDED" {
		t.Fatalf("code = %v", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0 (blocked before forwarding)", n)
	}
}

func TestQuotaBoundaryBlocks(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserQuota(t, db, 100, false, 99) // 99 < 100 → passes
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("under quota status = %d, want 200", w.Code)
	}
	setUserQuota(t, db, 100, false, 100) // 100 == 100 → blocked
	w = doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("at quota status = %d, want 429", w.Code)
	}
}

func TestQuotaStreamBlocked(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserQuota(t, db, 50, false, 60)

	w := doPost(t, r, "/v1/chat/completions",
		`{"model":"deepseek-chat","messages":[],"stream":true}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
	// no pending usage row must be left behind
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 1 { // the seeded 60-token row
		t.Fatalf("usage rows = %d, want 1", rows)
	}
}

func TestQuotaAdminExempt(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserQuota(t, db, 1, true, 100000) // admin, tiny quota, huge usage

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (admin exempt)", w.Code)
	}
	if n := f.requests.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
}

func TestQuotaGlobalDefault(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	// global default quota 100 via settings; user has no override (nil)
	if err := serverstore.SetSetting(db, serverstore.MonthlyQuotaSetting, "100"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, 1, "deepseek-chat", 100, 0); err != nil {
		t.Fatal(err)
	}
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429 (global default enforced)", w.Code)
	}
	// user override 0 = unlimited wins over the global default
	setUserQuota(t, db, 0, false, 0)
	w = doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (override unlimited)", w.Code)
	}
}

// 审计修复:流式响应的 usage 已回填后客户端才断连,真实计量必须保留
// (回退前无条件 DeleteUsage 会把已回填的真实用量删掉 → 统计丢失)。
func TestProxyStreamBackfilledThenDisconnectKeepsUsage(t *testing.T) {
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: fmt.Sprintf("%s/backfill.db", t.TempDir())})
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
		a.serveStream(c, resp, usageID)
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

// setUserMoneyQuota 设置 alice(用户 1)的金额配额与本月已用金额
// (直接插 usage.cost 行,模拟已发生的费用)。
func setUserMoneyQuota(t *testing.T, db *sql.DB, quota float64, admin bool, used float64) {
	t.Helper()
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	q := quota
	u.QuotaMoney = &q
	u.IsAdmin = admin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	if used > 0 {
		if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost)
			VALUES (1, 'deepseek-chat', ?, 0, 'chat', ?)`, int64(used*1e6), used); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQuotaMoneyBlocksOverLimit(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserMoneyQuota(t, db, 100, false, 100) // used == quota → blocked

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "QUOTA_EXCEEDED" {
		t.Fatalf("code = %v", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

func TestQuotaMoneyUnderLimit(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserMoneyQuota(t, db, 100, false, 50) // 50 < 100 → passes

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestQuotaMoneyAdminExempt(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setUserMoneyQuota(t, db, 1, true, 100000) // admin, tiny quota, huge usage

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (admin exempt)", w.Code)
	}
}

func TestQuotaMoneyGlobalDefault(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	if err := serverstore.SetSetting(db, serverstore.MonthlyMoneyQuotaSetting, "100"); err != nil {
		t.Fatal(err)
	}
	setUserMoneyQuota(t, db, 0, false, 0) // 个人无值? 这里显式 0 = 不限,先验证默认不拦截
	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("override unlimited status = %d, want 200", w.Code)
	}
	// 无个人覆盖(NULL)→ 走全局默认 100,已用 100 → 拦截
	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.QuotaMoney = nil
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost)
		VALUES (1, 'deepseek-chat', 0, 0, 'chat', 100)`); err != nil {
		t.Fatal(err)
	}
	w = doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("global default status = %d, want 429", w.Code)
	}
}

// setDeptBudgetForUser 创建部门并挂用户,设置部门预算与已用费用。
func setDeptBudgetForUser(t *testing.T, db *sql.DB, budget float64, used float64) {
	t.Helper()
	gid, err := serverstore.CreateDepartment(db, "研发部", 0, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetDeptBudget(db, gid, budget); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.AddUserGroup(db, 1, gid); err != nil {
		t.Fatal(err)
	}
	if used > 0 {
		if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost)
			VALUES (1, 'deepseek-chat', ?, 0, 'chat', ?)`, int64(used*1e6), used); err != nil {
			t.Fatal(err)
		}
	}
}

func TestQuotaDeptBudgetBlocksOverLimit(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setDeptBudgetForUser(t, db, 100, 100) // 部门树已用 == 预算 → 拦截

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d, want 429", w.Code)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	if code := out["error"].(map[string]any)["code"]; code != "QUOTA_EXCEEDED" {
		t.Fatalf("code = %v", code)
	}
	if n := f.requests.Load(); n != 0 {
		t.Fatalf("upstream calls = %d, want 0", n)
	}
}

func TestQuotaDeptBudgetUnderLimit(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setDeptBudgetForUser(t, db, 100, 50) // 50 < 100 → 放行

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
}

func TestQuotaDeptBudgetAdminExempt(t *testing.T) {
	f := newFakeUpstream(t)
	r, db, token := newGateway(t, f)
	setDeptBudgetForUser(t, db, 1, 100000) // 部门预算 1,已用 10 万;admin 豁免

	u, err := serverstore.GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	u.IsAdmin = true
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	w := doPost(t, r, "/v1/chat/completions", `{"model":"deepseek-chat","messages":[]}`, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (admin exempt)", w.Code)
	}
}
