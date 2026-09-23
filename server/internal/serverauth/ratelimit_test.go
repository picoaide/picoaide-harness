package serverauth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// 2026-09-23 E-01:allow 的语义是**判定并原子记账**;本文件里所有"填充预算"
// 的用例一律用 allow(不再用 record)—— record 只用于测试预置(见下方注释)。

// bucketLen 白盒观测某个桶当前的失败次数。
func bucketLen(l *loginLimiter, key string) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.attempts[key])
}

// C-2: a full rate-limit table must evict the oldest key instead of refusing
// new keys (otherwise a distributed username sweep is a global login DoS).
func TestLoginLimiterEvictsOldestWhenFull(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  2,
		maxAttempts: 10,
		window:      5 * time.Minute,
	}
	// 每个 allow 自己记账(E-01):两个键各占一格,表被填满。
	if !l.allow("A") || !l.allow("B") {
		t.Fatal("上限内的首次尝试必须被允许")
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
			t.Fatalf("第 %d 次尝试(上限内)被拒", i+1)
		}
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
		if !l.allow("K") {
			t.Fatalf("第 %d 次尝试(上限内)被拒", i+1)
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

// 2026-09-23 E-01:allow 必须**判定即记账**(同一临界区),不得退回"只判定、
// 业务失败后再 record"的两阶段语义 —— 后者在并发下,一批请求会在第一个 record
// 落表之前全部通过判定(审计实测:20 并发错密穿透到 16 次、200 并发 16~18 次,
// 声明上限 10/5min)。
//
// 语义不变:仍然是**按失败次数**计 —— 上限内的尝试放行,第 limit+1 次被拒,
// 成功登录(reset)恢复预算,其它键不受影响。
func TestLoginLimiterAllowRecordsAtomically(t *testing.T) {
	l := newRateLimiter(3)
	for i := 0; i < 3; i++ {
		if !l.allow("ip|alice") {
			t.Fatalf("第 %d 次尝试(上限内)被拒", i+1)
		}
	}
	if l.allow("ip|alice") {
		t.Fatal("第 4 次必须被拒:allow 必须自己记账(退回两阶段语义时这一条会通过)")
	}
	// 成功登录清账后预算恢复。
	l.reset("ip|alice")
	if !l.allow("ip|alice") {
		t.Fatal("reset must clear the failure budget")
	}
	// 其它键不受影响。
	if !l.allow("ip|bob") {
		t.Fatal("unrelated key refused")
	}
}

// E-05:表满驱逐不得优先驱逐**已饱和**的键 —— "窗口起点最早"在表满时几乎必然
// 是已打满预算的键,按它驱逐等于清空目标的失败预算(可被主动洗预算规避锁定)。
func TestLoginLimiterEvictionSkipsSaturatedKeys(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  2,
		maxAttempts: 2,
		window:      5 * time.Minute,
	}
	// victim 先打满(两次 allow 记账 + 第三次被拒)。
	if !l.allow("victim") || !l.allow("victim") {
		t.Fatal("上限内的两次尝试必须被允许")
	}
	if l.allow("victim") {
		t.Fatal("saturated key must be refused")
	}
	// other 未饱和(只有 1 次),victim 的窗口起点更早。
	if !l.allow("other") {
		t.Fatal("未饱和键必须被允许")
	}
	// 表满:新键必须能进(C-2:不得拒绝),被驱逐的只能是未饱和的 other。
	if !l.allow("fresh") {
		t.Fatal("new key refused when table full: must evict, not refuse")
	}
	if l.allow("victim") {
		t.Fatal("已饱和键的失败预算被驱逐洗掉了:驱逐必须跳过饱和键(E-05)")
	}
}

// P0-2: the OIDC callback bucket is IP-only and independent of the global
// per-username login bucket.
func TestOIDCCallbackBucketIsIndependent(t *testing.T) {
	a := New(nil)
	a.callbackLimiter = newRateLimiter(2)
	// 打满登录桶的伪用户键(record 只用于预置);回调桶必须不关心。
	for i := 0; i < 20; i++ {
		a.limiter.record("u:oidc-callback")
	}
	// 回调桶:两次 allow 判定即记账,用满 2 次预算。
	if !a.callbackLimiter.allow("ip:10.0.0.9") {
		t.Fatal("callback bucket must be independent from the login bucket")
	}
	if !a.callbackLimiter.allow("ip:10.0.0.9") {
		t.Fatal("callback bucket二发必须在预算内")
	}
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

// ===========================================================================
// E-01 回归:并发突发不得穿透失败预算(判定即记账)
// ===========================================================================

// loginStatus 发一次客户端面密码登录并返回状态码。可在 goroutine 里调用
// (不触碰 *testing.T)。
func loginStatus(r http.Handler, username, password, remoteAddr string) int {
	req := httptest.NewRequest("POST", "/api/client/v2/auth/login",
		strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w.Code
}

// burstLogin 并发发出 n 次同一账号的错密登录(同一来源 IP),返回 401/429/其它
// 的计数。RemoteAddr 的端口各不相同,但桶键只取 host(见 loginKey/clientIPKey)。
func burstLogin(n int, r http.Handler, username, password string) (n401, n429, other int) {
	var wg sync.WaitGroup
	start := make(chan struct{})
	codes := make([]int, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			codes[i] = loginStatus(r, username, password, fmt.Sprintf("192.0.2.1:%d", 40000+i))
		}(i)
	}
	close(start)
	wg.Wait()
	for _, c := range codes {
		switch c {
		case http.StatusUnauthorized:
			n401++
		case http.StatusTooManyRequests:
			n429++
		default:
			other++
		}
	}
	return n401, n429, other
}

// 20 并发错密:10 次失败预算必须是**硬上限**(401 恰好 10 次,其余 429)。
// 修复前(allow 只判定、失败分支才 record)实测 401=16。
func TestLoginBurstCannotPierceFailureBudget(t *testing.T) {
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10")
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "burstuser", "pw1234567890", false)

	n401, n429, other := burstLogin(20, r, "burstuser", "wrong-password")
	scope := dbLimiterScope(db)
	t.Logf("并发 20 次错密:401=%d 429=%d 其他=%d;桶残留 u:burstuser=%d ip:192.0.2.1=%d",
		n401, n429, other,
		bucketLen(sharedLoginLimiter(), scope+"u:burstuser"),
		bucketLen(sharedLoginIPLimiter(), scope+"ip:192.0.2.1"))
	if other != 0 {
		t.Fatalf("意外状态码 %d 个(期望只有 401 / 429)", other)
	}
	if n401 != 10 {
		t.Fatalf("并发突发穿透失败预算:401=%d, want 恰好 10(声明上限 10/5min;修复前为 16)", n401)
	}
}

// 200 并发错密:同一上限仍然只能是 10(审计实测修复前为 16~18)。
func TestLoginBurst200CannotPierceFailureBudget(t *testing.T) {
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10")
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "ampuser", "pw1234567890", false)

	n401, n429, other := burstLogin(200, r, "ampuser", "wrong-password")
	scope := dbLimiterScope(db)
	t.Logf("并发 200 次错密:401=%d 429=%d 其他=%d;桶残留 u:ampuser=%d ip:192.0.2.1=%d",
		n401, n429, other,
		bucketLen(sharedLoginLimiter(), scope+"u:ampuser"),
		bucketLen(sharedLoginIPLimiter(), scope+"ip:192.0.2.1"))
	if other != 0 {
		t.Fatalf("意外状态码 %d 个(期望只有 401 / 429)", other)
	}
	if n401 != 10 {
		t.Fatalf("200 并发穿透失败预算:401=%d, want 恰好 10(修复前稳定 16~18)", n401)
	}
}

// 正确口令不受影响:预算未打满时正常用户必须能登录,成功登录清空预算
// (限流语义仍是"按失败次数"计,不能把正常用户锁死)。
func TestLoginBudgetResetOnSuccessKeepsCorrectPassword(t *testing.T) {
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10")
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "resetboss", "pw1234567890", false)

	const addr = "192.0.2.1:40001"
	for i := 0; i < 9; i++ {
		if code := loginStatus(r, "resetboss", "wrong-password", addr); code != http.StatusUnauthorized {
			t.Fatalf("第 %d 次错密 = %d, want 401", i+1, code)
		}
	}
	if code := loginStatus(r, "resetboss", "pw1234567890", addr); code != http.StatusOK {
		t.Fatalf("预算未打满时正确口令被拒 = %d(限流把正常用户锁死)", code)
	}
	// 成功登录已清账:此后仍应能失败满 10 次才被拒(而不是立刻 429)。
	for i := 0; i < 10; i++ {
		if code := loginStatus(r, "resetboss", "wrong-password", addr); code != http.StatusUnauthorized {
			t.Fatalf("成功登录后的第 %d 次错密 = %d, want 401(reset 未生效?)", i+1, code)
		}
	}
	if code := loginStatus(r, "resetboss", "wrong-password", addr); code != http.StatusTooManyRequests {
		t.Fatalf("第 11 次错密 = %d, want 429(按失败次数计的上限必须仍然生效)", code)
	}
}

// E-01 同族回归(MFA 第二步):mfa-ip / mfa-user 两个桶同样必须判定即记账 ——
// 40 张票据并发错码只允许 10 次走到 TOTP 校验。旧实现靠"第二次判定在若干次
// DB 往返之后"的意外串行化侥幸没被穿透(审计探针 B),这里把它钉成不变量。
func TestMFABurstCannotPierceFailureBudget(t *testing.T) {
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10")
	ensureTestMasterKey(t)
	resetSharedLimitersForTest()
	db := mustDB(t)
	defer db.Close()

	gin.SetMode(gin.TestMode)
	r := gin.New()
	if err := r.SetTrustedProxies([]string{"127.0.0.1", "::1"}); err != nil {
		t.Fatal(err)
	}
	RegisterAdminRoutes(r, db)

	if _, err := createUserDB(db, "mfaboss", "pw1234567890", true); err != nil {
		t.Fatal(err)
	}
	u, err := serverstore.GetUserByUsername(db, "mfaboss")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := genTOTPSecret("mfaboss")
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryptMFASecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetUserMFA(db, u.ID, cipher, true); err != nil {
		t.Fatal(err)
	}

	const tickets = 40
	tks := make([]string, 0, tickets)
	for i := 0; i < tickets; i++ {
		tk, err := createMFAChallenge(db, u.ID, "login", "", mfaTicketTTL)
		if err != nil {
			t.Fatal(err)
		}
		tks = append(tks, tk)
	}

	var wg sync.WaitGroup
	start := make(chan struct{})
	codes := make([]int, len(tks))
	for i, tk := range tks {
		wg.Add(1)
		go func(i int, tk string) {
			defer wg.Done()
			<-start
			req := httptest.NewRequest("POST", "/api/server/admin/login/mfa",
				strings.NewReader(`{"mfa_ticket":"`+tk+`","code":"000000"}`))
			req.Header.Set("Content-Type", "application/json")
			req.RemoteAddr = "192.0.2.1:40000"
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			codes[i] = w.Code
		}(i, tk)
	}
	close(start)
	wg.Wait()

	n401, n429, other := 0, 0, 0
	for _, c := range codes {
		switch c {
		case http.StatusUnauthorized:
			n401++
		case http.StatusTooManyRequests:
			n429++
		default:
			other++
		}
	}
	t.Logf("并发 %d 张票据 + 错动态码:401=%d 429=%d 其他=%d", tickets, n401, n429, other)
	if other != 0 {
		t.Fatalf("意外状态码 %d 个(期望只有 401 / 429)", other)
	}
	if n401 != 10 {
		t.Fatalf("MFA 第二步并发穿透失败预算:401=%d, want 恰好 10", n401)
	}
}
