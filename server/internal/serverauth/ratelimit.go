package serverauth

import (
	"net"
	"net/http"
	"os"
	"strconv"
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
	lastSweep   time.Time
}

func newLoginLimiter() *loginLimiter {
	// PICOAI_LOGIN_MAX_ATTEMPTS overrides the default 10/5min for test
	// environments (dev-env/E2E login repeatedly as the same user).
	max := 10
	if v := os.Getenv("PICOAI_LOGIN_MAX_ATTEMPTS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			max = n
		}
	}
	return &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  10000,
		maxAttempts: max,
		window:      5 * time.Minute,
	}
}

// allow records an attempt; it reports whether the attempt may proceed.
// When the table is full, the key with the oldest window start is evicted
// (a sweep of distinct usernames must not DoS login for everyone).
// 清扫摊销:每次调用只清理当前 key;全局过期清扫每分钟至多一次(审计2026-M9:
// 每次调用 O(n) 全表扫描,攻击者填满 1 万键后每次登录尝试放大 1 万倍 CPU)。
func (l *loginLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	cutoff := now.Add(-l.window)

	if now.Sub(l.lastSweep) >= time.Minute {
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
		l.lastSweep = now
	}

	times := l.attempts[key]
	kept := times[:0]
	for _, t := range times {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= l.maxAttempts {
		l.attempts[key] = kept
		return false
	}
	if _, exists := l.attempts[key]; !exists && len(l.attempts) >= l.maxEntries {
		// Table full: evict the key with the oldest window start instead of
		// refusing the new key (C-2).
		var victim string
		var oldest time.Time
		for k, ts := range l.attempts {
			if len(ts) > 0 && (victim == "" || ts[0].Before(oldest)) {
				victim, oldest = k, ts[0]
			}
		}
		delete(l.attempts, victim)
	}
	l.attempts[key] = append(kept, now)
	return true
}

// loginKey builds a rate-limit key from the connection IP and username.
// RemoteAddr 是安全默认(审计 C-1):X-Forwarded-For 攻击者可控,伪造头不得
// 重置 per-IP 预算。反代部署时 RemoteAddr 会坍缩为代理 IP(审计 2026-08-25
// F-02)导致单账号 DoS——因此 allow 额外维护一个 per-username 桶(见
// allowLogin),反代下攻击者炸同一用户名仍会在 username 桶被限。
func loginKey(c *gin.Context, username string) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	return host + "|" + username
}

// loginAllowed guards one login attempt through BOTH buckets: ip|username
// (安全默认,防单 IP 爆破) and username (防账号级 DoS——反代坍缩/分布式
// 爆破下,同一用户名跨 IP 的尝试总数仍受限)。审计 2026-08-25 F-02。
func (a *API) loginAllowed(c *gin.Context, username string) bool {
	if !a.limiter.allow(loginKey(c, username)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	if !a.limiter.allow("u:" + username) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	return true
}
