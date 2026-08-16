package llmgateway

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// deadUpstream accepts connections but closes them immediately (transport error).
func deadUpstream(t *testing.T, attempts *atomic.Int64) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

// stalledStream sends one SSE chunk then blocks until aborted, like a hung
// upstream after the first token.
func stalledStream(t *testing.T, attempts *atomic.Int64, chunk string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, chunk+"\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	t.Cleanup(srv.Close)
	return srv
}

// brokenAfterFirstChunk sends one SSE chunk then drops the connection, like
// an upstream dying mid-stream.
func brokenAfterFirstChunk(t *testing.T, attempts *atomic.Int64, chunk string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempts.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, chunk+"\n\n")
		w.(http.Flusher).Flush()
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			conn.Close()
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func seedProvider(t *testing.T, db *sql.DB, name, baseURL, models string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, 'k', ?)`, name, baseURL, models); err != nil {
		t.Fatal(err)
	}
}

func assertUPSTREAM(t *testing.T, w *httptest.ResponseRecorder) {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatalf("error body not json: %q", w.Body.String())
	}
	if code := out["error"].(map[string]any)["code"]; code != "UPSTREAM" {
		t.Fatalf("error code = %v, body=%s", code, w.Body.String())
	}
}

func TestProxySingleProviderNoRetryOnConnectFailure(t *testing.T) {
	var attempts atomic.Int64
	dead := deadUpstream(t, &attempts)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "dead", dead.URL, `["m"]`)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"m","messages":[]}`, token, nil)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", w.Code)
	}
	assertUPSTREAM(t, w)
	if n := attempts.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1 (single provider never retries)", n)
	}
}

func TestProxyFailoverToNextProviderOnConnectFailure(t *testing.T) {
	var badAttempts atomic.Int64
	bad := deadUpstream(t, &badAttempts)
	good := newFakeUpstream(t)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "bad", bad.URL, `["m"]`)
	seedProvider(t, db, "good", good.baseURL, `["m"]`)

	body := `{"model":"m","messages":[]}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if n := badAttempts.Load(); n != 1 {
		t.Fatalf("first provider calls = %d, want 1", n)
	}
	if n := good.requests.Load(); n != 1 {
		t.Fatalf("second provider calls = %d, want 1", n)
	}
	if got := w.Body.String(); got != good.nonStream {
		t.Fatalf("response not from second provider: %q", got)
	}
}

func TestProxyFailoverToNextProviderOn5xx(t *testing.T) {
	var firstAttempts atomic.Int64
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstAttempts.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(bad.Close)
	good := newFakeUpstream(t)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "bad", bad.URL, `["m"]`)
	seedProvider(t, db, "good", good.baseURL, `["m"]`)

	body := `{"model":"m","messages":[]}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", w.Code, w.Body.String())
	}
	if n := firstAttempts.Load(); n != 1 {
		t.Fatalf("first provider calls = %d, want 1", n)
	}
	if n := good.requests.Load(); n != 1 {
		t.Fatalf("second provider calls = %d, want 1", n)
	}
	if got := w.Body.String(); got != good.nonStream {
		t.Fatalf("response not from second provider: %q", got)
	}
}

func TestProxyNoFailoverOn4xx(t *testing.T) {
	var firstAttempts atomic.Int64
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		firstAttempts.Add(1)
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"bad request"}}`)
	}))
	t.Cleanup(bad.Close)
	good := newFakeUpstream(t)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "bad", bad.URL, `["m"]`)
	seedProvider(t, db, "good", good.baseURL, `["m"]`)

	w := doPost(t, r, "/v1/chat/completions", `{"model":"m","messages":[]}`, token, nil)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 passthrough", w.Code)
	}
	if n := firstAttempts.Load(); n != 1 {
		t.Fatalf("first provider calls = %d, want 1", n)
	}
	if n := good.requests.Load(); n != 0 {
		t.Fatalf("second provider calls = %d, want 0 (4xx never fails over)", n)
	}
}

func TestProxyNoFailoverAfterStreamStarted(t *testing.T) {
	var brokenAttempts atomic.Int64
	broken := brokenAfterFirstChunk(t, &brokenAttempts, `data: {"choices":[{"delta":{"content":"hi"}}]}`)
	good := newFakeUpstream(t)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "broken", broken.URL, `["m"]`)
	seedProvider(t, db, "good", good.baseURL, `["m"]`)

	body := `{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}`
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (stream already started)", w.Code)
	}
	if n := good.requests.Load(); n != 0 {
		t.Fatalf("second provider calls = %d, want 0 (no failover after first byte)", n)
	}
	if got := w.Body.String(); strings.Contains(got, "[DONE]") {
		t.Fatalf("stream should be truncated, got: %q", got)
	}
	if !strings.Contains(w.Body.String(), "hi") {
		t.Fatalf("partial stream lost: %q", w.Body.String())
	}
}

func TestProxyStreamIdleTimeout(t *testing.T) {
	var attempts atomic.Int64
	stalled := stalledStream(t, &attempts, `data: {"choices":[{"delta":{"content":"hi"}}]}`)
	r, db, token := newGateway(t, nil)
	seedProvider(t, db, "stalled", stalled.URL, `["m"]`)

	defer func(prev time.Duration) { streamIdleTimeout = prev }(streamIdleTimeout)
	streamIdleTimeout = 300 * time.Millisecond

	body := `{"model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}`
	start := time.Now()
	w := doPost(t, r, "/v1/chat/completions", body, token, nil)
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("request took %v, stream was not terminated by idle timeout", elapsed)
	}
	if n := attempts.Load(); n != 1 {
		t.Fatalf("upstream calls = %d, want 1", n)
	}
	got := w.Body.String()
	if !strings.Contains(got, `"content":"hi"`) {
		t.Fatalf("first chunk missing: %q", got)
	}
	if !strings.Contains(got, "UPSTREAM_IDLE_TIMEOUT") {
		t.Fatalf("no idle timeout error sent to client: %q", got)
	}
	if strings.Contains(got, "[DONE]") {
		t.Fatalf("stream should be terminated before [DONE]: %q", got)
	}
}

func TestMatchModelsReturnsAllCandidates(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/multi.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES ('a', 'http://a', 'k', '["m"]'), ('b', 'http://b', 'k', '["m"]'), ('c', 'http://c', 'k', '["other"]')`); err != nil {
		t.Fatal(err)
	}

	ups, err := MatchModels(db, "m")
	if err != nil {
		t.Fatal(err)
	}
	if len(ups) != 2 || ups[0].Name != "a" || ups[1].Name != "b" {
		t.Fatalf("candidates = %+v, want [a b] in id order", ups)
	}
}
