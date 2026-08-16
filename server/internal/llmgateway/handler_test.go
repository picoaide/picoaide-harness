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
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/gw.db", t.TempDir()))
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
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/inject.db", t.TempDir()))
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
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/maxout.db", t.TempDir()))
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
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/hook.db", t.TempDir()))
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
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/match.db", t.TempDir()))
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
