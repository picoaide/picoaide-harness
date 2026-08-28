package llmgateway

import (
	"context"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// fakeAnthropicUpstream is an Anthropic-compatible upstream for /v1/messages tests.
type fakeAnthropicUpstream struct {
	baseURL    string
	srv        *httptest.Server
	gotBody    sync.Map // path -> raw body string
	gotHeaders sync.Map // path -> raw Authorization/x-api-key headers
	requests   int
	status     int
	streamResp string
	nonStream  string
	mu         sync.Mutex
}

func newFakeAnthropicUpstream(t *testing.T) *fakeAnthropicUpstream {
	t.Helper()
	f := &fakeAnthropicUpstream{
		streamResp: `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":0}}}

event: content_block_delta
data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}

event: message_stop
data: {"type":"message_stop"}

`,
		nonStream: `{"id":"msg_x","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":8,"output_tokens":3,"cache_read_input_tokens":2}}`,
		status:    http.StatusOK,
	}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.requests++
		f.gotBody.Store(r.URL.Path, string(body))
		f.gotHeaders.Store(r.URL.Path, fmt.Sprintf("x-api-key=%s;authorization=%s;anthropic-version=%s",
			r.Header.Get("x-api-key"), r.Header.Get("Authorization"), r.Header.Get("anthropic-version")))
		f.mu.Unlock()
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

func newMessagesGateway(t *testing.T, f *fakeAnthropicUpstream) (*gin.Engine, *sql.DB, string) {
	t.Helper()
	DecryptSecret = func(s string) (string, error) { return s, nil }
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

	if f != nil {
		if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol) VALUES ('fake-anthropic', ?, ?, '["deepseek-v4-flash"]', 'anthropic')`, f.baseURL, upstreamKey); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-v4-flash', 1, 'DeepSeek V4 Flash')`); err != nil {
			t.Fatal(err)
		}
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	return r, db, token
}

// doMessagesPost posts to /v1/messages with the anthropic-version header the
// real client always sends.
func doMessagesPost(t *testing.T, r http.Handler, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestMessagesNonStream(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	r, db, token := newMessagesGateway(t, f)

	body := `{"model":"deepseek-v4-flash","max_tokens":1024,"messages":[{"role":"user","content":[{"type":"text","text":"Perform a web search for the query: hello"}]}],"tools":[{"type":"web_search_20250305","name":"web_search","max_uses":5}]}`
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `"text":"hi"`) {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}

	// upstream must have received the key, not the client token
	got, _ := f.gotHeaders.Load("/v1/messages")
	if got == nil {
		t.Fatal("upstream not called")
	}
	h := got.(string)
	if !strings.Contains(h, "x-api-key="+upstreamKey) || !strings.Contains(h, "authorization=Bearer "+upstreamKey) {
		t.Fatalf("upstream auth = %q, want server key", h)
	}
	if !strings.Contains(h, "anthropic-version=2023-06-01") {
		t.Fatalf("anthropic-version not passed: %q", h)
	}

	// usage must be metered with kind=search
	var uid int64
	var mname string
	var pt, ct, cache int64
	var kind string
	row := db.QueryRow(`SELECT user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, kind FROM usage`)
	if err := row.Scan(&uid, &mname, &pt, &ct, &cache, &kind); err != nil {
		t.Fatalf("usage row missing: %v", err)
	}
	if pt != 8 || ct != 3 || cache != 2 {
		t.Fatalf("usage = %d/%d/%d", pt, ct, cache)
	}
	if kind != "search" {
		t.Fatalf("usage kind = %q, want search", kind)
	}
}

func TestMessagesStream(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	r, db, token := newMessagesGateway(t, f)

	body := `{"model":"deepseek-v4-flash","stream":true,"max_tokens":1024,"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}`
	w := doMessagesPost(t, r, body, token)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), `message_start`) {
		t.Fatalf("unexpected stream body: %s", w.Body.String())
	}

	var pt, ct, cache int64
	var kind string
	row := db.QueryRow(`SELECT prompt_tokens, completion_tokens, cache_prompt_tokens, kind FROM usage`)
	if err := row.Scan(&pt, &ct, &cache, &kind); err != nil {
		t.Fatalf("usage row missing: %v", err)
	}
	if pt != 10 || ct != 5 || cache != 0 || kind != "search" {
		t.Fatalf("usage = %d/%d/%d kind=%s", pt, ct, cache, kind)
	}
}

func TestMessagesRequiresToken(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	r, _, _ := newMessagesGateway(t, f)
	w := doMessagesPost(t, r, `{"model":"deepseek-v4-flash","messages":[]}`, "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "AUTH_REQUIRED") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestMessagesModelNotFound(t *testing.T) {
	f := newFakeAnthropicUpstream(t)
	r, _, token := newMessagesGateway(t, f)
	w := doMessagesPost(t, r, `{"model":"nope","messages":[]}`, token)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "NOT_FOUND") {
		t.Fatalf("body = %s", w.Body.String())
	}
}

func TestMessagesIgnoresOpenAIOnlyModel(t *testing.T) {
	// 一个只挂在 openai provider 上的模型名,messages 路由不得路由到它。
	DecryptSecret = func(s string) (string, error) { return s, nil }
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	token, err := serverauth.IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, protocol) VALUES ('fake-openai', 'http://unused', ?, '["deepseek-chat"]', 'openai')`, upstreamKey); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES ('deepseek-chat', 1, 'DeepSeek Chat')`); err != nil {
		t.Fatal(err)
	}

	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterRoutes(r, db)
	w := doMessagesPost(t, r, `{"model":"deepseek-chat","messages":[]}`, token)
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", w.Code, w.Body.String())
	}
}

func TestAnthropicUsageParser(t *testing.T) {
	pt, ct, cache, ok, err := anthropicUsage([]byte(`{"type":"message","usage":{"input_tokens":8,"output_tokens":3,"cache_read_input_tokens":2}}`))
	if err != nil || !ok || pt != 8 || ct != 3 || cache != 2 {
		t.Fatalf("got %d/%d/%d ok=%v err=%v", pt, ct, cache, ok, err)
	}
	// SSE line shape
	pt, ct, cache, ok, err = anthropicUsage([]byte(`data: {"type":"message_delta","usage":{"input_tokens":10,"output_tokens":5}}`))
	if err != nil || !ok || pt != 10 || ct != 5 || cache != 0 {
		t.Fatalf("sse got %d/%d/%d ok=%v err=%v", pt, ct, cache, ok, err)
	}
	// [DONE] / empty
	if _, _, _, ok, _ := anthropicUsage([]byte(`data: [DONE]`)); ok {
		t.Fatal("[DONE] must not report usage")
	}
	if _, _, _, ok, _ := anthropicUsage([]byte(`data: {}`)); ok {
		t.Fatal("no usage must not report")
	}
}

// compile-time check that json stays imported (used by test helpers above)
var _ = context.Background
