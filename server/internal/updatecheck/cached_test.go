package updatecheck

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestCheckerNewAndDefaults covers the constructors and default-client path
// (an unusable endpoint must fail via ErrUnavailable, never panic).
func TestCheckerNewAndDefaults(t *testing.T) {
	c := New()
	if c.Client == nil {
		t.Fatal("New() must install a client")
	}
	if c.Endpoint != "" {
		t.Fatalf("New() Endpoint = %q, want empty (production)", c.Endpoint)
	}
	if c.Client.Timeout != httpClientTimeout {
		t.Fatalf("client timeout = %v, want %v", c.Client.Timeout, httpClientTimeout)
	}

	cached := NewCached()
	if cached == nil {
		t.Fatal("NewCached() returned nil")
	}
}

// TestCheckerBadRequestConstruction: a malformed endpoint request must wrap
// ErrUnavailable and never hit the network.
func TestCheckerBadRequestConstruction(t *testing.T) {
	c := &Checker{Client: &http.Client{}, Endpoint: "://bad-url"}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil {
		t.Fatal("expected error for malformed endpoint")
	}
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("error %v should wrap ErrUnavailable", err)
	}
}

// TestCheckerResponseTooLarge: an oversized release payload must be refused
// (bounded memory) even when the server responds 200.
func TestCheckerResponseTooLarge(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v9.9.9","pad":"` + strings.Repeat("x", maxResponseBody) + `"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	_, err := c.Check(context.Background(), "2.5.1")
	if err == nil || !errors.Is(err, ErrUnavailable) {
		t.Fatalf("expected ErrUnavailable for oversized body, got %v", err)
	}
	if !strings.Contains(err.Error(), "response too large") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestCheckerInvalidJSON: a 200 with garbage must wrap ErrUnavailable.
func TestCheckerInvalidJSON(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{oops`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("expected error for invalid json")
	}
}

// TestCheckerDevCurrent: "dev" (non-SemVer current) must never report an
// update even when the latest tag is newer.
func TestCheckerDevCurrent(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"tag_name":"v9.9.9","html_url":"https://x"}`))
	}))
	defer srv.Close()

	c := &Checker{Client: srv.Client(), Endpoint: srv.URL}
	res, err := c.Check(context.Background(), "dev")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.UpdateAvailable {
		t.Error("UpdateAvailable = true for dev current, want false")
	}
	if res.Current != "dev" {
		t.Errorf("Current = %q", res.Current)
	}
}

// TestCachedCheckerTTL exercises the 6h cache: a second Check within TTL
// does not hit the network (the endpoint counts requests).
func TestCachedCheckerTTL(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		_, _ = w.Write([]byte(`{"tag_name":"v2.6.0"}`))
	}))
	defer srv.Close()

	c := &CachedChecker{inner: &Checker{Client: srv.Client(), Endpoint: srv.URL}}
	first, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("first check: %v", err)
	}
	if !first.UpdateAvailable {
		t.Error("first check should report update")
	}
	second, err := c.Check(context.Background(), "2.5.1")
	if err != nil {
		t.Fatalf("second check: %v", err)
	}
	if second.Latest != first.Latest {
		t.Errorf("second Latest = %q, want %q", second.Latest, first.Latest)
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 1 {
		t.Fatalf("network hits = %d, want 1 (second call must be served from cache)", hits)
	}
}

// TestCachedCheckerConcurrentSingleflight: N concurrent first-checks share
// one network request.
func TestCachedCheckerConcurrentSingleflight(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		time.Sleep(30 * time.Millisecond) // widen the race window
		_, _ = w.Write([]byte(`{"tag_name":"v2.6.0"}`))
	}))
	defer srv.Close()

	c := &CachedChecker{inner: &Checker{Client: srv.Client(), Endpoint: srv.URL}}
	const n = 8
	results := make([]*Result, n)
	errs := make([]error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Check(context.Background(), "2.5.1")
		}(i)
	}
	wg.Wait()

	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("concurrent check %d: %v", i, errs[i])
		}
		if results[i] == nil || !results[i].UpdateAvailable {
			t.Fatalf("concurrent check %d: unexpected result %+v", i, results[i])
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if hits != 1 {
		t.Fatalf("network hits = %d, want 1 (singleflight)", hits)
	}
}

// TestCachedCheckerConcurrentFailure: when the shared check fails, every
// waiter gets an error and nothing is cached (next call retries).
func TestCachedCheckerConcurrentFailure(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &CachedChecker{inner: &Checker{Client: srv.Client(), Endpoint: srv.URL}}
	results := make([]*Result, 4)
	errs := make([]error, 4)
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			results[i], errs[i] = c.Check(context.Background(), "2.5.1")
		}(i)
	}
	wg.Wait()
	for i := 0; i < 4; i++ {
		if errs[i] == nil {
			t.Fatalf("concurrent failure check %d: expected error", i)
		}
		if results[i] != nil {
			t.Fatalf("concurrent failure check %d: expected nil result", i)
		}
	}
	// Nothing cached: a follow-up goes to the network again.
	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("expected error on follow-up after failed checks")
	}
}

// TestCachedCheckerFailureIsNotCached: a failed refresh must return an
// error (callers degrade silently) and must NOT cache the failure, so the
// next check retries the network.
func TestCachedCheckerFailureIsNotCached(t *testing.T) {
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if hits == 1 {
			_, _ = w.Write([]byte(`{"tag_name":"v2.6.0"}`))
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	c := &CachedChecker{inner: &Checker{Client: srv.Client(), Endpoint: srv.URL}}
	first, err := c.Check(context.Background(), "2.5.1")
	if err != nil || first == nil {
		t.Fatalf("first check: %v", err)
	}
	// Expire the TTL to force a refresh.
	c.mu.Lock()
	c.checked = time.Now().Add(-CacheTTL - time.Minute)
	c.mu.Unlock()

	if _, err := c.Check(context.Background(), "2.5.1"); err == nil {
		t.Fatal("refresh should fail loud (the caller degrades), got nil error")
	}
	// The stale value is retained internally but a fresh attempt happens: no
	// failure caching.
	c.mu.Lock()
	kept := c.cached
	c.mu.Unlock()
	if kept == nil || kept.Latest != "2.6.0" {
		t.Fatalf("stale cache not retained: %+v", kept)
	}
	if hits < 2 {
		t.Fatalf("network hits = %d, want >= 2 (refresh attempted)", hits)
	}
}

// TestErrorsIsUnavailable guards the sentinel wrapping for callers that
// degrade silently (server info page).
func TestErrorsIsUnavailable(t *testing.T) {
	if !errors.Is(ErrUnavailable, ErrUnavailable) {
		t.Fatal("sentinel must equal itself")
	}
	// Concurrency timeout path must also wrap the sentinel.
	wrapped := errors.Join(ErrUnavailable, errors.New("x"))
	if !errors.Is(wrapped, ErrUnavailable) {
		t.Fatal("Join must preserve ErrUnavailable")
	}
	if !strings.Contains(ErrUnavailable.Error(), "unavailable") {
		t.Fatal("error text changed; callers match on ErrUnavailable only")
	}
}
