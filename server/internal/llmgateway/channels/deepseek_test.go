package channels

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestDeepSeekRequestOverrides covers the model-aware override contract:
// reasoner models get no overrides (upstream rejects reasoning_effort),
// everything else gets thinking + effort max and the four sampling keys removed.
func TestDeepSeekRequestOverrides(t *testing.T) {
	d := DeepSeek{}

	ov, remove := d.RequestOverrides("deepseek-v4-flash")
	if ov == nil || remove == nil {
		t.Fatal("non-reasoner model must return overrides")
	}
	if ov["thinking"] == nil {
		t.Error("thinking override missing")
	}
	if ov["reasoning_effort"] != "max" {
		t.Errorf("reasoning_effort = %v, want max", ov["reasoning_effort"])
	}
	wantRemove := map[string]bool{"temperature": true, "top_p": true, "presence_penalty": true, "frequency_penalty": true}
	if len(remove) != len(wantRemove) {
		t.Fatalf("remove = %v", remove)
	}
	for _, k := range remove {
		if !wantRemove[k] {
			t.Errorf("unexpected remove key %q", k)
		}
	}

	// Reasoner: no-op (case-insensitive match).
	ov, remove = d.RequestOverrides("deepseek-reasoner-v2")
	if ov != nil || remove != nil {
		t.Errorf("reasoner = %v/%v, want nil/nil", ov, remove)
	}
	ov, remove = d.RequestOverrides("DeepSeek-V4-REASONER")
	if ov != nil || remove != nil {
		t.Errorf("REASONER = %v/%v, want nil/nil", ov, remove)
	}
}

func TestDeepSeekDefaultsAndIdentity(t *testing.T) {
	d := DeepSeek{}
	if d.Name() != "deepseek" {
		t.Errorf("Name = %q", d.Name())
	}
	if d.BaseURL() != "https://api.deepseek.com" {
		t.Errorf("BaseURL = %q", d.BaseURL())
	}
	ctx, out := d.DefaultModelCaps()
	if ctx <= 0 || out <= 0 {
		t.Errorf("DefaultModelCaps = %d/%d", ctx, out)
	}
}

// TestParseOAIModelsMalformed: a non-JSON body or a wrong-typed data field
// is an error, not a panic or silent empty list.
func TestParseOAIModelsMalformed(t *testing.T) {
	if _, err := ParseOAIModels([]byte("{oops")); err == nil {
		t.Error("expected error for invalid JSON")
	}
	if _, err := ParseOAIModels([]byte(`{"data":{"id":"x"}}`)); err == nil {
		t.Error("expected error for object-typed data field")
	}
	if _, err := ParseOAIModels([]byte(`{"data":[{"id":7}]}`)); err != nil {
		t.Logf("numeric id tolerated as %v", err)
	}
}

// TestHTTPFetch: success, non-200, cancellation, and the 1 MiB body cap.
func TestHTTPFetch(t *testing.T) {
	// Success with Bearer header.
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer key-1" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer ts.Close()
	body, err := HTTPFetch(context.Background(), ts.URL, "key-1")
	if err != nil {
		t.Fatalf("HTTPFetch: %v", err)
	}
	if string(body) != `{"data":[]}` {
		t.Errorf("body = %q", body)
	}

	// Non-200.
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer bad.Close()
	if _, err := HTTPFetch(context.Background(), bad.URL, ""); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("401 err = %v", err)
	}

	// Cancelled context.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := HTTPFetch(ctx, ts.URL, ""); err == nil {
		t.Error("cancelled ctx should error")
	}

	// Oversized body capped at 1 MiB (server sends 2 MiB).
	big := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, 2<<20))
	}))
	defer big.Close()
	body, err = HTTPFetch(context.Background(), big.URL, "")
	if err != nil {
		t.Fatalf("HTTPFetch big: %v", err)
	}
	if len(body) > 1<<20 {
		t.Errorf("body len = %d, cap is 1<<20", len(body))
	}
}

// TestDeepSeekFetchModelsErrorPropagation: the fetch error surfaces untouched.
func TestDeepSeekFetchModelsErrorPropagation(t *testing.T) {
	d := DeepSeek{}
	sentinel := errors.New("boom")
	_, err := d.FetchModels(context.Background(), "k", func(url string) ([]byte, error) {
		if url != "https://api.deepseek.com/models" {
			t.Fatalf("url = %q", url)
		}
		return nil, sentinel
	})
	if !errors.Is(err, sentinel) {
		t.Fatalf("err = %v, want sentinel", err)
	}
}

// TestDeepSeekFetchModelsNilFetchFn: the default fetch path is exercised only
// with a live server here through the channel's own HTTP client contract.
func TestDeepSeekFetchModelsNilFetchFnURL(t *testing.T) {
	d := DeepSeek{}
	// Assert the URL construction without a network call by capturing the
	// fetchFn invocation only.
	called := ""
	_, _ = d.FetchModels(context.Background(), "k", func(url string) ([]byte, error) {
		called = url
		return []byte(`{"data":[{"id":"x"}]}`), nil
	})
	if called != "https://api.deepseek.com/models" {
		t.Errorf("url = %q", called)
	}
}
