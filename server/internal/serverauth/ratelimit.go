package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/util"
)

// loginRateLimit bounds login attempts per key (ip+username).
// Sliding window: maxAttempts per window; bounded table with lazy cleanup.
//
// 2026-09-08 P1-3:只有**失败**尝试计数,成功登录 reset —— 此前成功登录也占
// 配额,正常用户 5 分钟内第 11 次登录会被 429,而未认证者 10 次错密即可把
// 任意账号(含 super_admin)锁死。
//
// 2026-09-23 E-01:"只对失败计数"必须由 **allow 判定即记账(原子)** 实现,
// 不能是"allow 只判定 + 业务失败后 record":后者在并发下,一批请求会在第一个
// record 落表之前**全部**通过判定(实测 20 并发错密穿透到 16 次、200 并发稳定
// 16~18 次,声明上限 10/5min),判定永远看到突发开始前的快照。现在允许 =
// 同一临界区内记账、拒绝 = 不记账、成功 = reset(失败分支不再二次记账)。
type loginLimiter struct {
	mu          sync.Mutex
	attempts    map[string][]time.Time
	maxEntries  int
	maxAttempts int
	// maxAttemptsFn 实时计算阈值(F17 复核):共享单例不能在创建时固话
	// PICOAI_LOGIN_MAX_ATTEMPTS —— 否则第一个测试设置的临时值会永久影响
	// 后续用例(阈值过大 → 限流测试永不触发;过小 → 正常登录被误伤)。
	// 生产环境变量进程内不变,实时读取只是多一次 getenv。
	maxAttemptsFn func() int
	window        time.Duration
	lastSweep     time.Time
}

// limit 返回当前生效的最大失败次数。
func (l *loginLimiter) limit() int {
	if l.maxAttemptsFn != nil {
		return l.maxAttemptsFn()
	}
	return l.maxAttempts
}

// callbackLimiterMaxAttempts:OIDC 回调按来源 IP 限流(独立桶,阈值高于
// 登录——同一出口 NAT 下的整个办公室共用 IP,且只对失败回调计数)。
const callbackLimiterMaxAttempts = 60

// loginIPMaxAttempts 是**单 IP 登录失败预算**(审计 2026-09-13 P1-2)。
//
// 为什么必须有这一维:账号桶(u:<username> 与 ip|username)都以用户名为键,
// 攻击者**每次换一个随机用户名**即可完全不触发限流。而未认证登录每次要跑一次
// argon2id(64MiB/t=3)—— 实测 30 次随机用户名登录全部 401、单次约 87ms,
// 数百并发即数十 GB 峰值(进程级 OOM,全站不可用)。IP 桶把"同一来源的失败
// 总数"也纳入预算;阈值取 60/5min(与 OIDC 回调同量级:正常用户 5 分钟内
// 失败 60 次已远超任何真实场景,而 NAT 出口的整间办公室仍有余量)。
const loginIPMaxAttempts = 60

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

// sharedLoginIPLimiter 是单 IP 失败预算的共享单例(客户端面/管理面/登录方式
// 探测共用同一张表;键带命名空间前缀区分用途)。
var sharedLoginIPLimiterOnce sync.Once
var sharedLoginIPLimiterVal *loginLimiter

func sharedLoginIPLimiter() *loginLimiter {
	sharedLoginIPLimiterOnce.Do(func() {
		sharedLoginIPLimiterVal = newRateLimiter(loginIPMaxAttempts)
	})
	return sharedLoginIPLimiterVal
}

func newLoginLimiter() *loginLimiter {
	// PICOAI_LOGIN_MAX_ATTEMPTS overrides the default 10/5min for test
	// environments (dev-env/E2E login repeatedly as the same user).
	// 阈值在**每次判定时**读取(见 maxAttemptsFn),保证共享单例下测试
	// 临时 env 不泄漏到其他用例。
	l := newRateLimiter(10)
	l.maxAttemptsFn = func() int {
		if v := os.Getenv("PICOAI_LOGIN_MAX_ATTEMPTS"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				return n
			}
		}
		return 10
	}
	return l
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

// allow reports whether the attempt may proceed and, when it may, records it
// in the same critical section (2026-09-23 E-01:判定与记账必须原子 —— 只判定
// 不记账会让并发突发穿透失败预算)。Callers clear the budget with reset() after
// a successful authentication, so a legitimate login never consumes it; a
// refused attempt is never recorded again.
// When the table is full, the key with the oldest window start **among the keys
// that are not saturated yet** is evicted (a sweep of distinct usernames must
// not DoS login for everyone; evicting a saturated key would wash a target's
// failure budget, E-05).
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
	if len(kept) >= l.limit() {
		l.attempts[key] = kept
		return false
	}
	if _, exists := l.attempts[key]; !exists && len(l.attempts) >= l.maxEntries {
		// Table full: evict one key instead of refusing the new key (C-2).
		l.evictOneLocked()
	}
	l.attempts[key] = append(kept, now)
	return true
}

// evictOneLocked 释放一个键位。受害者取**未饱和**(窗口内尝试次数 < 上限)的
// 键里窗口起点最早的那个:表满时"窗口起点最早"几乎必然是已经打满预算的键,
// 按它驱逐等于**清空目标的失败预算**(审计 2026-09-23 E-05,可被主动洗预算)。
// 只有整张表都已饱和时才回落到"窗口起点最早的键"(表必须有界,不能因为
// 攻击者填表就无限增长)。
func (l *loginLimiter) evictOneLocked() {
	limit := l.limit()
	victim, oldest := "", time.Time{}
	fallback, fallbackOldest := "", time.Time{}
	for k, ts := range l.attempts {
		if len(ts) == 0 {
			continue
		}
		if fallback == "" || ts[0].Before(fallbackOldest) {
			fallback, fallbackOldest = k, ts[0]
		}
		if len(ts) >= limit {
			continue
		}
		if victim == "" || ts[0].Before(oldest) {
			victim, oldest = k, ts[0]
		}
	}
	if victim == "" {
		victim = fallback
	}
	if victim != "" {
		delete(l.attempts, victim)
	}
}

// record notes one failed attempt against the key.
// 生产路径已不再需要它(allow 判定即记账);保留给测试预置桶状态以及"额外补记
// 一次失败"的显式语义 —— 对一个 allow 已经记账的键再调 record 会重复计数。
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

// loginHost 返回连接来源主机(RemoteAddr 的 host 部分,不含端口)。
func loginHost(c *gin.Context) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err != nil {
		host = c.Request.RemoteAddr
	}
	return host
}

// loginKey builds a rate-limit key from the connection IP and username.
// RemoteAddr 是安全默认(审计 C-1):X-Forwarded-For 攻击者可控,伪造头不得
// 重置 per-IP 预算。反代部署时 RemoteAddr 会坍缩为代理 IP(审计 2026-08-25
// F-02)导致单账号 DoS——因此 allow 额外维护一个 per-username 桶(见
// allowLogin),反代下攻击者炸同一用户名仍会在 username 桶被限。
//
// 2026-09-19:本桶(ip|username)**保留 RemoteAddr** 不变 —— 它与 u:username
// 桶是同一份 10 次预算,坍缩只是"更严"而不会放大任何人的攻击面(攻击者炸
// 某账号时 u: 桶必然同时打满)。真正会被坍缩变成全组织 DoS 的是**只按 IP**
// 的那个 60 次桶,它已改走 clientIPKey(见该函数)。
func loginKey(c *gin.Context, username string) string {
	return loginHost(c) + "|" + username
}

// dbLimiterScope 把限流键按 DB 实例隔离(F17 复核):生产单 DB 的
// 客户端面/管理面共享同一失败预算;测试的每个临时库(以及同进程多租户)
// 互不污染 —— 否则共享单例会让测试之间互相限流。
func dbLimiterScope(db *sql.DB) string {
	return fmt.Sprintf("db:%p|", db)
}

// clientIPKey 是**IP 维度失败预算**的统一桶键(登录 IP 桶 + OIDC 回调桶 +
// /auth/oidc|openid/login 流程桶),全部按真实客户端 IP 计。
//
// 审计 2026-09-13 P1-3:回调桶此前用 **RemoteAddr**,而反代(生产 compose 的
// Caddy)部署下所有用户共享同一个代理 IP ⇒ 一个未认证者用 60 次失败回调即可把
// **全组织**的 SSO 回调打成 429(实测:第 61 个请求即便来自不同
// X-Forwarded-For 也照样 429)。改用 gin 的 ClientIP():SetTrustedProxies 已把
// 可信代理限定为环回+显式配置(cmd/server/main.go),只有来自可信代理的 XFF
// 才会被采纳;不可信来源伪造的 XFF 不改变桶键(C-1,比采信 XFF 更严格)。
//
// 2026-09-19:上一条修复只覆盖了回调,**登录 IP 桶漏了** —— loginAllowed()、
// 管理面 handleLogin() 的 srcIPKey、MFA 第二步的 mfaIPKey 仍在用
// loginHost()(= RemoteAddr)。同一个坍缩在登录面依旧成立:反代下 60 次失败
// 登录(loginIPMaxAttempts)即可让**所有人**——包括密码完全正确的用户——在
// 整个 5 分钟窗口内登不进来(第 61 个请求在鉴权之前就被 429,成功登录也没有
// 机会去 reset 桶)。现三处统一走本函数。
func clientIPKey(c *gin.Context) string {
	return "ip:" + c.ClientIP()
}

// loginIPBudgetKey 是**登录 IP 桶**的完整键,也是它唯一的构造点。
//
// allow/record/reset 必须用同一个键:此前三处各自拼 "ip:"+loginHost(c),
// 改成按 ClientIP 计以后只要漏改其中一处,就会出现"判定键 ≠ 记账键"——
// 桶永远判不满,**限流静默失效**(回归测试
// TestLoginIPBudgetKeyUsesTrustedProxyClientIP 正是靠这一点发现 loginFailed
// 还在用 RemoteAddr)。键的 IP 维度只能按真实客户端 IP(见 clientIPKey)。
func loginIPBudgetKey(db *sql.DB, c *gin.Context) string {
	return loginIPBudgetKeyForHost(db, c.ClientIP())
}

// loginIPBudgetKeyForHost 与 loginIPBudgetKey 同形,供非 gin 入口
// (wasmapp/session 的 net/http 登录页)复用 —— host 由调用方按其信任边界解析。
func loginIPBudgetKeyForHost(db *sql.DB, host string) string {
	return dbLimiterScope(db) + "ip:" + host
}

// loginAllowed guards one login attempt through **three** buckets:
// ip|username(防单 IP 爆破)、username(防账号级 DoS——反代坍缩/分布式
// 爆破下,同一用户名跨 IP 的尝试总数仍受限)、以及 ip(防"随机用户名"
// 绕过前两桶做 argon2 放大,P1-2)。审计 2026-08-25 F-02 / 2026-09-13 P1-2。
func (a *API) loginAllowed(c *gin.Context, username string) bool {
	scope := dbLimiterScope(a.DB)
	if !a.limiter.allow(scope+loginKey(c, username)) ||
		!a.limiter.allow(scope+"u:"+username) ||
		!a.loginIPLimiter.allow(loginIPBudgetKey(a.DB, c)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	return true
}

// ===== 供非 gin 入口复用同一套登录失败预算（2026-09-17）=====
//
// 为什么必须导出：WASM 应用平台的员工浏览器登录页（internal/wasmapp/session）
// 走的是 net/http 而不是 gin，如果它自己不做预算，就等于**在客户端面
// /auth/login 之外新开了一个没有爆破防护的密码入口** —— 同一份账号密码、
// 同一套 provider，防护却只覆盖其中一个入口。这三个键与 gin 入口
// **完全相同**（host|username / u:username / ip:host），因此两处入口共享同一份
// 失败预算（在一个入口上的失败会同时收紧另一个）。
//
// 2026-09-23 E-01:AllowLoginAttempt 判定通过即**原子记账**（与 gin 入口的
// loginAllowed 同形），不再需要、也**不得**再调用失败记账 —— 那会重复计数
// 并把预算减半。RecordLoginFailure 因此已删除。

// AllowLoginAttempt 判定一次登录尝试是否在失败预算内；允许时立即记账。
// host 传客户端 IP（反代下由 gin 的 ClientIP 语义决定，调用方负责取值）。
func (a *API) AllowLoginAttempt(username, host string) bool {
	scope := dbLimiterScope(a.DB)
	return a.limiter.allow(scope+host+"|"+username) &&
		a.limiter.allow(scope+"u:"+username) &&
		a.loginIPLimiter.allow(loginIPBudgetKeyForHost(a.DB, host))
}

// ResetLoginSuccess 在认证成功后清空三个桶（合法登录不应消耗失败预算）。
func (a *API) ResetLoginSuccess(username, host string) {
	scope := dbLimiterScope(a.DB)
	a.limiter.reset(scope + host + "|" + username)
	a.limiter.reset(scope + "u:" + username)
	a.loginIPLimiter.reset(loginIPBudgetKeyForHost(a.DB, host))
}

// loginSucceeded clears the buckets after a successful authentication
// (a legitimate login must not consume the failure budget). IP 桶同样清空:
// 成功即证明该来源不是爆破流量,避免误伤同 NAT 的正常用户。
func (a *API) loginSucceeded(c *gin.Context, username string) {
	scope := dbLimiterScope(a.DB)
	a.limiter.reset(scope + loginKey(c, username))
	a.limiter.reset(scope + "u:" + username)
	a.loginIPLimiter.reset(loginIPBudgetKey(a.DB, c))
}

// oidcCallbackAllowed guards one OIDC callback through a dedicated IP-only
// bucket (P0-2). allow 判定即记账(2026-09-23 E-01:此前"只对失败回调计数"由
// 调用方 record,并发回调同样会穿透);成功回调由 oidcCallbackSucceeded 清空。
func (a *API) oidcCallbackAllowed(c *gin.Context) bool {
	if !a.callbackLimiter.allow(clientIPKey(c)) {
		writeError(c, http.StatusTooManyRequests, "RATE_LIMITED", "登录尝试过于频繁,请稍后再试")
		return false
	}
	return true
}

// oidcCallbackSucceeded clears the callback bucket for this IP.
func (a *API) oidcCallbackSucceeded(c *gin.Context) {
	a.callbackLimiter.reset(clientIPKey(c))
}

// ---------------------------------------------------------------------------
// 密码校验并发闸(审计 2026-09-13 P1-2)
// ---------------------------------------------------------------------------

// passwordVerifyMaxConcurrent 是**同时在跑**的 argon2id 校验上限。
//
// 每次校验按 argon2id 参数(m=64MiB,t=3,p=2)分配 64MiB,未认证者可以用
// "随机用户名 + 无限并发"把内存推到数十 GB(实测单次 87ms/64MiB、零限流)。
// 限流桶解决"总量",这里解决"瞬时并发":超出的请求最多等 500ms,仍拿不到
// 槽位即返回 429 —— 内存峰值被硬性限制在 slots×64MiB(4 核 ≈ 1GiB)。
func passwordVerifyMaxConcurrent() int {
	n := runtime.NumCPU() * 4
	if n < 8 {
		n = 8
	}
	if n > 32 {
		n = 32
	}
	return n
}

// passwordVerifySlots 是进程级共享槽位(客户端面/管理面/改密/MFA 自助共用;
// 任何入口都无法单独放宽)。
var passwordVerifySlots = make(chan struct{}, passwordVerifyMaxConcurrent())

// errPasswordVerifyBusy 表示密码校验并发闸已满(调用方映射 429,与"密码错误"
// 严格区分 —— 否则攻击期间正常用户会看到"密码错误"这种误导性结论)。
var errPasswordVerifyBusy = errors.New("password verify concurrency gate is full")

// passwordVerifyWait 是排队等槽位的上限:短于用户可感知的"卡住",长于正常
// 校验耗时(87ms 级),把突发流量削峰而不是直接拒绝。
const passwordVerifyWait = 500 * time.Millisecond

// acquirePasswordVerify 取得一个密码校验槽位。
// @returns release 必须 defer 调用;ok=false = 过载(调用方回 429)。
func acquirePasswordVerify() (release func(), ok bool) {
	select {
	case passwordVerifySlots <- struct{}{}:
		return func() { <-passwordVerifySlots }, true
	default:
	}
	t := time.NewTimer(passwordVerifyWait)
	defer t.Stop()
	select {
	case passwordVerifySlots <- struct{}{}:
		return func() { <-passwordVerifySlots }, true
	case <-t.C:
		return nil, false
	}
}

// verifyPasswordGated 是"带并发闸的密码校验"唯一入口:过载时返回 ok=false
// (上层按认证失败/429 处理),避免每个调用点各写一遍 acquire/release。
func verifyPasswordGated(hash, password string) (matched, ok bool) {
	release, ok := acquirePasswordVerify()
	if !ok {
		return false, false
	}
	defer release()
	return util.VerifyPassword(hash, password), true
}
