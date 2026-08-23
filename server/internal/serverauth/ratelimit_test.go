package serverauth

import (
	"testing"
	"time"
)

// C-2: a full rate-limit table must evict the oldest key instead of refusing
// new keys (otherwise a distributed username sweep is a global login DoS).
func TestLoginLimiterEvictsOldestWhenFull(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  2,
		maxAttempts: 10,
		window:      5 * time.Minute,
	}
	if !l.allow("A") || !l.allow("B") {
		t.Fatal("first keys should be allowed")
	}
	if !l.allow("C") {
		t.Fatal("new key refused when table full: must evict oldest")
	}
	if len(l.attempts) > l.maxEntries {
		t.Fatalf("table size = %d, want <= %d", len(l.attempts), l.maxEntries)
	}
	if _, ok := l.attempts["A"]; ok {
		t.Fatal("oldest key A not evicted")
	}
	// the evicted key starts a fresh budget again
	if !l.allow("A") {
		t.Fatal("evicted key should be reusable")
	}
}

// C-2b: eviction never happens while a key is under its own attempt budget,
// so legitimate users are unaffected.
func TestLoginLimiterNoEvictionBelowCapacity(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  10,
		maxAttempts: 3,
		window:      5 * time.Minute,
	}
	for i := 0; i < 3; i++ {
		if !l.allow("K") {
			t.Fatalf("attempt %d refused", i)
		}
	}
	if l.allow("K") {
		t.Fatal("over-budget attempt allowed")
	}
}

// 过期条目由每分钟清扫清理:窗口结束后再次尝试,旧条目不得累积计入预算
func TestLoginLimiterSweepsExpiredEntries(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  10,
		maxAttempts: 3,
		window:      time.Minute,
	}
	for i := 0; i < 3; i++ {
		if !l.allow("K") {
			t.Fatalf("attempt %d refused", i)
		}
	}
	if l.allow("K") {
		t.Fatal("over-budget attempt allowed")
	}
	// 窗口已过:下一次调用触发全局清扫,旧尝试作废
	l.mu.Lock()
	for k, ts := range l.attempts {
		for i := range ts {
			l.attempts[k][i] = ts[i].Add(-2 * time.Minute)
		}
	}
	l.mu.Unlock()
	if !l.allow("K") {
		t.Fatal("fresh window attempt refused after expiry sweep")
	}
}
