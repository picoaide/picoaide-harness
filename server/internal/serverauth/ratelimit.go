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
//
// 2026-09-08 P1-3:只对**失败**尝试计数(allow 不再记账;认证失败后调
// record,成功后 reset)。此前成功登录也占配额,正常用户 5 分钟内第 11 次
// 登录会被 429,而未认证者 10 次错密即可把任意账号(含 super_admin)锁死。
type loginLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	maxEntries  int
	maxAttempts int
	window      time.Duration
	lastSweep   time.Time
}

// callbackLimiterMaxAttempts:OIDC 回调按来源 IP 限流(独立桶,阈值高于
// 登录——同一出口 NAT 下的整个办公室共用 IP,且只对失败回调计数)。
const callbackLimiterMaxAttempts = 60

// sharedLoginLimiter 是**全服务端共享**的登录失败限流器(F17,审计
// 2026-09-11):此前客户端面与管理面各持一个实例,同一账号可从两个入口
// 各消耗一份失败预算(实际阈值翻倍)。PICOAI_LOGIN_MAX_ATTEMPTS 仍在首次
// 创建时读取(惰性单例,测试可先 t.Setenv)。
var sharedLoginLimiterOnce sync.Once
var sharedLoginLimiterVal *loginLimiter

func sharedLoginLimiter() *loginLimiter {
	sharedLoginLimiterOnce.Do(func() {
		sharedLoginLimiterVal = newLoginLimiter()
	})
	return sharedLoginLimiterVal
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
	return newRateLimiter(max)
}

// newCallbackLimiter bounds OIDC callback attempts per IP only (2026-09-08
// P0-2): the callback previously shared the per-username login bucket with the
// fixed pseudo-user "oidc-callback", so every SSO login in the deployment
// consumed one global 10-per-5min budget and the 11th callback anywhere got
// 429.
func newCallbackLimiter() *loginLimiter {
	return newRateLimiter(callbackLimiterMaxAttempts)
}

func newRateLimiter(maxAttempts int) *loginLimiter {
	return &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  10000,
		maxAttempts: maxAttempts,
		window:      5 * time.Minute,
	}
}

// allow reports whether the attempt may proceed. It does NOT record the
// attempt — callers record failures with record() and clear the window with
// reset() after a successful authentication.
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
	if len(kept) == 0 {
		delete(l.attempts, key)
	} else {
		l.attempts[key] = kept
	}
	return true
}

// record notes one failed attempt against the key.
func (l *loginLimiter) record(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.attempts[key] = append(l.attempts[key], time.Now())
}

// reset clears the key's history after a successful authentication.
func (l *loginLimiter) reset(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.attempts, key)
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

// clientIPKey is the IP-only rate-limit key (OIDC callbacks).
func clientIPKey(c *gin.Context) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	return "ip:" + host
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

// loginFailed records a failed authentication against both login buckets.
func (a *API) loginFailed(c *gin.Context, username string) {
	a.limiter.record(loginKey(c, username))
	a.limiter.record("u:" + username)
}

// loginSucceeded clears both login buckets after a successful authentication
// (a legitimate login must not consume the failure budget).
func (a *API) loginSucceeded(c *gin.Context, username string) {
	a.limiter.reset(loginKey(c, username))
	a.limiter.reset("u:" + username)
}

// oidcCallbackAllowed guards one OIDC callback through a dedicated IP-only
// bucket (P0-2). Failures are recorded by the caller; success resets it.
func (a *API) oidcCallbackAllowed(c *gin.Context) bool {
	if !a.callbackLimiter.allow(clientIPKey(c)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	return true
}

// oidcCallbackFailed records one failed callback attempt (IP bucket).
func (a *API) oidcCallbackFailed(c *gin.Context) {
	a.callbackLimiter.record(clientIPKey(c))
}

// oidcCallbackSucceeded clears the callback bucket for this IP.
func (a *API) oidcCallbackSucceeded(c *gin.Context) {
	a.callbackLimiter.reset(clientIPKey(c))
}
