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
	l.record("A")
	l.record("B")
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
		l.record("K")
	}
	if l.allow("K") {
		t.Fatal("over-budget attempt allowed")
	}
	// A successful login clears the failure budget (P1-3).
	l.reset("K")
	if !l.allow("K") {
		t.Fatal("reset must clear the failure budget")
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
		l.record("K")
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

// P1-3: successful checks must NOT consume the budget — only record() does.
// Before the fix, the 11th legitimate login in 5 minutes was rate-limited and
// 10 bad passwords from an unauthenticated caller locked any account.
func TestLoginLimiterCountsFailuresOnly(t *testing.T) {
	l := newRateLimiter(3)
	for i := 0; i < 50; i++ {
		if !l.allow("ip|alice") {
			t.Fatalf("check %d refused: allow must not consume the budget", i)
		}
	}
	for i := 0; i < 3; i++ {
		l.record("ip|alice")
	}
	if l.allow("ip|alice") {
		t.Fatal("budget must apply after 3 failures")
	}
	// Other keys are unaffected.
	if !l.allow("ip|bob") {
		t.Fatal("unrelated key refused")
	}
}

// P0-2: the OIDC callback bucket is IP-only and independent of the global
// per-username login bucket.
func TestOIDCCallbackBucketIsIndependent(t *testing.T) {
	a := New(nil)
	a.callbackLimiter = newRateLimiter(2)
	// Exhaust the login bucket's pseudo-user key; the callback bucket must not
	// care.
	for i := 0; i < 20; i++ {
		a.limiter.record("u:oidc-callback")
	}
	if !a.callbackLimiter.allow("ip:10.0.0.9") {
		t.Fatal("callback bucket must be independent from the login bucket")
	}
	a.callbackLimiter.record("ip:10.0.0.9")
	a.callbackLimiter.record("ip:10.0.0.9")
	if a.callbackLimiter.allow("ip:10.0.0.9") {
		t.Fatal("callback IP bucket must block after its own budget")
	}
	// A different IP (another office behind NAT) is unaffected.
	if !a.callbackLimiter.allow("ip:10.0.0.10") {
		t.Fatal("callback bucket must be per IP")
	}
}

// P1-5: the client login order follows auth.enabled; local stays available to
// the admin surface but is skipped for employee logins when disabled.
func TestClientPasswordOrderRespectsEnabled(t *testing.T) {
	a := New(nil)
	if got := a.clientPasswordOrder(); len(got) != 2 || got[0] != "ldap" || got[1] != "local" {
		t.Fatalf("default order = %v, want [ldap local]", got)
	}
	a.SetEnabledProviders([]string{"ldap"})
	if got := a.clientPasswordOrder(); len(got) != 1 || got[0] != "ldap" {
		t.Fatalf("ldap-only order = %v, want [ldap]", got)
	}
	a.SetEnabledProviders([]string{"local"})
	if got := a.clientPasswordOrder(); len(got) != 1 || got[0] != "local" {
		t.Fatalf("local-only order = %v, want [local]", got)
	}
	a.SetEnabledProviders([]string{"ldap", "oidc"})
	if got := a.clientPasswordOrder(); len(got) != 1 || got[0] != "ldap" {
		t.Fatalf("ldap+oidc order = %v, want [ldap]", got)
	}
}
