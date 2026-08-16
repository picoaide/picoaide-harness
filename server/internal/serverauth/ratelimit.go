package serverauth

import (
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

// loginRateLimit bounds login attempts per key (ip+username).
// Sliding window: maxAttempts per window; bounded table with lazy cleanup.
type loginLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	maxEntries  int
	maxAttempts int
	window      time.Duration
}

func newLoginLimiter() *loginLimiter {
	return &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  10000,
		maxAttempts: 10,
		window:      5 * time.Minute,
	}
}

// allow records an attempt; it reports whether the attempt may proceed.
// When the table is full, new keys are rejected (429) and no eviction of
// active window entries happens; expired entries are cleaned lazily.
func (l *loginLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)

	// lazy cleanup of expired entries
	for k, times := range l.attempts {
		kept := times[:0]
		for _, t := range times {
			if t.After(cutoff) {
				kept = append(kept, t)
			}
		}
		if len(kept) == 0 {
			delete(l.attempts, k)
		} else {
			l.attempts[k] = kept
		}
	}

	times := l.attempts[key]
	if len(times) >= l.maxAttempts {
		return false
	}
	if _, exists := l.attempts[key]; !exists && len(l.attempts) >= l.maxEntries {
		// Table full: evict the key with the oldest window start instead of
		// refusing the new key (C-2). Refusing here would let a sweep of
		// distinct usernames DoS login for everyone.
		var victim string
		var oldest time.Time
		for k, ts := range l.attempts {
			if len(ts) > 0 && (victim == "" || ts[0].Before(oldest)) {
				victim, oldest = k, ts[0]
			}
		}
		delete(l.attempts, victim)
	}
	l.attempts[key] = append(times, now)
	return true
}

// loginKey builds a rate-limit key from the connection IP and username.
// RemoteAddr is used (never ClientIP): X-Forwarded-For is attacker-controlled
// and a forged header must not reset the per-IP budget (C-1). Behind a
// reverse proxy the proxy's own address becomes the key, which is still a
// bounded choke point.
func loginKey(c *gin.Context, username string) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	return host + "|" + username
}

// loginAllowed middleware-level guard; returns true if the request may proceed.
func (a *API) loginAllowed(c *gin.Context, username string) bool {
	if !a.limiter.allow(loginKey(c, username)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	return true
}
