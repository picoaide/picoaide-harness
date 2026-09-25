package serverauth

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// 用例间的失败预算隔离(2026-09-19)
//
// 现象:整包跑 `go test ./internal/serverauth` 时 TestAdminUsageDept 的**正常**
// 登录被 429(usage_admin_test.go:33 `login: 429 RATE_LIMITED`),单跑该用例则绿。
//
// 机制(三条缺一不可):
//  1. sharedLoginLimiter / sharedLoginIPLimiter 是**包级单例**(产品语义:客户端面
//     与管理面共享同一份失败预算),跨用例存活;
//  2. 桶键 = dbLimiterScope(db) + "ip:" + clientIP,而 dbLimiterScope 用
//     fmt.Sprintf("%p", db) 标识 DB 实例 —— 每个用例的临时库句柄在用例结束后
//     被回收,Go 分配器会把**同一地址**发给后面的 sql.Open(实测 40 次
//     open/close 有 39 次拿到同一指针)⇒ 不同用例实际上共用同一个桶键;
//  3. TestAuditFixRandomUsernameStillRateLimitedByIP 故意用随机用户名打满 IP 桶
//     (记录满 loginIPMaxAttempts=60 次失败,断言第 61 次被拒),用完**不做**成功
//     登录 ⇒ 桶在该用例结束后仍然满着。5 分钟窗口内任何落到同一键的用例,
//     连**密码正确**的登录也会在鉴权之前被 429。
//
// 修法:每个用例开始时清空共享桶(resetSharedLimitersForTest),由包内所有构造
// 登录入口的测试辅助函数调用 —— 与 internal/telemetry 的
// resetErrorReportingLimiter 同一口径。产品限流阈值/键 一律不变。
// ===========================================================================

// resetSharedLimitersForTest 清空进程级共享的登录失败预算桶。
//
// 只清**内容**、不替换实例:已经构造好的 API/AdminAPI 持有旧指针(handler.go
// 的 New() 在构造期取单例),替换实例会让清空对它们无效。
//
// R15C-R-01 ③(审计 2026-09-25,P1):自助**签发配额**桶同样是包级单例(键 = DB 作用域 +
// user_id),也必须在这里重置 —— 否则"前一个用例用同一 user_id 打满配额"会让后面的
// 正常登录用例假红(新增"包级单例 + 进程级累积状态"必须挂进本统一入口是本仓纪律,
// 先例见 telemetry.resetErrorReportingLimiter)。
func resetSharedLimitersForTest() {
	for _, l := range []*loginLimiter{sharedLoginLimiter(), sharedLoginIPLimiter(), sharedTokenIssueQuotaLimiter()} {
		if l == nil {
			continue
		}
		l.mu.Lock()
		l.attempts = map[string][]time.Time{}
		l.lastSweep = time.Time{}
		l.mu.Unlock()
	}
}

// ipBucketCount 白盒观测共享 IP 桶里某个键当前的失败次数。
func ipBucketCount(key string) int {
	l := sharedLoginIPLimiter()
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.attempts[key])
}

// ipBucketKeys 返回共享 IP 桶当前的全部键(调试/断言用)。
func ipBucketKeys() []string {
	l := sharedLoginIPLimiter()
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]string, 0, len(l.attempts))
	for k := range l.attempts {
		out = append(out, k)
	}
	return out
}

// postLoginFrom 发一次密码登录,可指定 TCP 对端(RemoteAddr)与 X-Forwarded-For,
// 用于验证"桶键取的是哪个 IP"。
func postLoginFrom(t *testing.T, r http.Handler, remoteAddr, xff, username, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("POST", "/api/client/v2/auth/login",
		strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
	req.Header.Set("Content-Type", "application/json")
	if remoteAddr != "" {
		req.RemoteAddr = remoteAddr
	}
	if xff != "" {
		req.Header.Set("X-Forwarded-For", xff)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// loginBudgetRouter 建一棵客户端面路由树,并显式声明可信代理(与
// cmd/server/main.go 同口径:缺省只信回环,只有可信代理转发的 XFF 才被采纳)。
// 传 trusted 时会把 httptest 的 TCP 对端当作"反代"(生产里的 Caddy)。
func loginBudgetRouter(t *testing.T, db *sql.DB, trusted ...string) *gin.Engine {
	t.Helper()
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	r := gin.New()
	if err := r.SetTrustedProxies(trusted); err != nil {
		t.Fatal(err)
	}
	api.RegisterRoutes(r)
	return r
}

// TestSharedFailureBudgetIsClearedPerCase:跨用例污染回归(2026-09-19)。
//
// 前置条件成立性:阶段 1 直接把桶填满并断言 allow() 拒绝;阶段 2 断言统一入口
// 把**整张表**清干净(不只是"清自己这个键"),随后同一 RT 上的正常登录必须成功。
// 修复前(辅助函数不重置)阶段 2 必然红 —— 这就是 TestAdminUsageDept 的失败形态。
func TestSharedFailureBudgetIsClearedPerCase(t *testing.T) {
	// 阶段 1:模拟"上一个用例"(TestAuditFixRandomUsernameStillRateLimitedByIP)
	// 用完留下一个**打满**的 IP 桶。键按临时库的作用域构造,与真实用例一致。
	seedDB, seedCleanup := serverstore.NewTestDB(t)
	defer seedCleanup()
	seeded := dbLimiterScope(seedDB) + "ip:192.0.2.1"
	for i := 0; i < loginIPMaxAttempts; i++ {
		sharedLoginIPLimiter().record(seeded)
	}
	if sharedLoginIPLimiter().allow(seeded) {
		t.Fatalf("前置条件不成立:桶 %q 未被填满", seeded)
	}

	// 阶段 2:下一个用例从统一入口开始 —— 必须拿到干净的预算。
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	if n := ipBucketCount(seeded); n != 0 {
		t.Fatalf("上一个用例的失败预算泄漏到本用例:键 %q 残留 %d 次(修复前正确密码会被 429)", seeded, n)
	}
	createUser(t, db, "boss", "pw123456", true)
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("残留失败预算把正常登录打成 %d(期望 200):%s", w.Code, w.Body.String())
	}
}

// TestLoginIPBudgetKeyUsesTrustedProxyClientIP:反代坍缩回归(2026-09-19)。
//
// 生产 compose 前面是 Caddy:所有请求的 RemoteAddr 都是代理 IP。登录 IP 桶
// (loginIPMaxAttempts=60/5min)若按 RemoteAddr 计,就变成**全组织共用一个预算**
// —— 60 次失败登录即可让所有人(含密码正确者)在 5 分钟窗口内登不进来,而且
// 成功登录没有机会执行 reset(第 61 个请求在鉴权之前就被 429)。
// 这与审计 2026-09-13 P1-3 修掉的 OIDC 回调桶坍缩是同一类缺陷(回调已修、
// 登录面此前漏修)。
//
// 断言:①可信代理转发的 XFF 决定桶键(两个真人两个桶);②不可信来源伪造的 XFF
// 不改变桶键(仍按 TCP 对端,C-1);③一个真人打满预算不影响另一个真人的正确登录。
func TestLoginIPBudgetKeyUsesTrustedProxyClientIP(t *testing.T) {
	resetSharedLimitersForTest()
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	createUser(t, db, "realuser", "pw123456", false)
	// httptest 的 TCP 对端固定是 192.0.2.1:把它当"可信代理"(生产里的 Caddy),
	// 真人 IP 只在 XFF 里。
	r := loginBudgetRouter(t, db, "192.0.2.1")
	scope := dbLimiterScope(db)

	// ① 可信代理后的两个不同真人 → 两个桶键(修复前都落到 ip:192.0.2.1)。
	if w := postLoginFrom(t, r, "192.0.2.1:54321", "203.0.113.7", "ghost-a", "x"); w.Code != http.StatusUnauthorized {
		t.Fatalf("随机用户名错误密码应 401,得 %d", w.Code)
	}
	if w := postLoginFrom(t, r, "192.0.2.1:54321", "198.51.100.9", "ghost-b", "x"); w.Code != http.StatusUnauthorized {
		t.Fatalf("随机用户名错误密码应 401,得 %d", w.Code)
	}
	if n := ipBucketCount(scope + "ip:203.0.113.7"); n != 1 {
		t.Fatalf("登录 IP 桶未按真实客户端 IP 计:ip:203.0.113.7 = %d 次(修复前落在 ip:192.0.2.1);keys=%v scope=%q", n, ipBucketKeys(), scope)
	}
	if n := ipBucketCount(scope + "ip:198.51.100.9"); n != 1 {
		t.Fatalf("第二个真人的失败未落到自己的桶:ip:198.51.100.9 = %d 次", n)
	}
	if n := ipBucketCount(scope + "ip:192.0.2.1"); n != 0 {
		t.Fatalf("桶键仍是代理 IP(RemoteAddr):ip:192.0.2.1 = %d 次", n)
	}

	// ② 不可信对端伪造 XFF 不改变桶键(仍按 TCP 对端;比无条件采信 XFF 更严格)。
	if w := postLoginFrom(t, r, "198.51.100.200:5555", "203.0.113.7", "ghost-c", "x"); w.Code != http.StatusUnauthorized {
		t.Fatalf("随机用户名错误密码应 401,得 %d", w.Code)
	}
	if n := ipBucketCount(scope + "ip:198.51.100.200"); n != 1 {
		t.Fatalf("不可信来源的 XFF 被采信:ip:198.51.100.200 = %d 次(期望 1)", n)
	}

	// ③ 一个真人打满 IP 预算后,另一个真人的**正确密码**必须仍能登录
	//    (反代坍缩 = 全组织登录 DoS,修复前这里必然是 429)。
	for i := 0; i < loginIPMaxAttempts; i++ {
		sharedLoginIPLimiter().record(scope + "ip:203.0.113.7")
	}
	if w := postLoginFrom(t, r, "192.0.2.1:54321", "203.0.113.7", "ghost-d", "x"); w.Code != http.StatusTooManyRequests {
		t.Fatalf("打满预算的真人应被 429(限流不得被削弱),得 %d", w.Code)
	}
	w := postLoginFrom(t, r, "192.0.2.1:54321", "198.51.100.9", "realuser", "pw123456")
	if w.Code != http.StatusOK {
		t.Fatalf("另一个真人的正确密码被拒(反代下全组织共用预算):%d %s", w.Code, w.Body.String())
	}
}
