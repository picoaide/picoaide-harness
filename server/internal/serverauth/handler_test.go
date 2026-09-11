package serverauth

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

func newTestAPI(t *testing.T) (*gin.Engine, *sql.DB, func()) {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	r := gin.New()
	api.RegisterRoutes(r)
	return r, db, cleanup
}

func loginToken(t *testing.T, r *gin.Engine, username, password string) string {
	t.Helper()
	w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login", fmt.Sprintf(`{"username":"%s","password":"%s"}`, username, password), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login %s: %d %s", username, w.Code, w.Body.String())
	}
	tok, _ := out["token"].(string)
	if tok == "" {
		t.Fatal("empty token")
	}
	return tok
}

func createUser(t *testing.T, db *sql.DB, username, password string, admin bool) {
	t.Helper()
	_, err := serverstore.CreateUserWithPassword(db, username, password)
	if err != nil {
		t.Fatal(err)
	}
	u, _ := serverstore.GetUserByUsername(db, username)
	u.IsAdmin = admin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
}

func doJSON(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestLoginLogoutMe(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", true)

	// wrong password
	w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"admin","password":"bad"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong pw status = %d, body=%s", w.Code, w.Body.String())
	}
	if code, _ := out["error"].(map[string]any)["code"].(string); code != "AUTH_FAILED" {
		t.Fatalf("code = %v", out["error"])
	}

	// correct login
	w, out = doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"admin","password":"Admin@123"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	token := out["token"].(string)
	if token == "" {
		t.Fatal("empty token")
	}

	// me
	w, out = doJSON(t, r, "GET", "/api/client/v2/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", w.Code, w.Body.String())
	}
	if u := out["user"].(map[string]any); u["username"] != "admin" {
		t.Fatalf("me user = %v", u)
	}

	// logout revokes
	w, _ = doJSON(t, r, "POST", "/api/client/v2/auth/logout", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("logout status = %d", w.Code)
	}
	w, _ = doJSON(t, r, "GET", "/api/client/v2/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("me after logout status = %d", w.Code)
	}
}

func TestBearerAuthRequired(t *testing.T) {
	r, _, cleanup := newTestAPI(t)
	defer cleanup()
	w, _ := doJSON(t, r, "GET", "/api/client/v2/auth/me", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d", w.Code)
	}
}

func TestLoginRateLimit(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", false)

	status := http.StatusOK
	for i := 0; i < 15; i++ {
		w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"admin","password":"wrong"}`, nil)
		status = w.Code
		if status == http.StatusTooManyRequests {
			if code, _ := out["error"].(map[string]any)["code"].(string); code != "RATE_LIMITED" {
				t.Fatalf("rate limit code = %v", out)
			}
			break
		}
	}
	if status != http.StatusTooManyRequests {
		t.Fatalf("expected rate limit after 10 attempts, last status = %d", status)
	}
}

// C-1: forged X-Forwarded-For must not reset the per-IP login rate limit.
// The limit key is derived from the connection's RemoteAddr, never from the
// attacker-controlled XFF header.
func TestLoginRateLimitXFFSpoof(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", false)

	status := http.StatusOK
	xff := []string{"10.0.0.1", "10.0.0.2", "1.2.3.4", "203.0.113.9"}
	for i := 0; i < 15; i++ {
		w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"admin","password":"wrong"}`,
			map[string]string{"X-Forwarded-For": xff[i%len(xff)]})
		status = w.Code
		if status == http.StatusTooManyRequests {
			if code, _ := out["error"].(map[string]any)["code"].(string); code != "RATE_LIMITED" {
				t.Fatalf("rate limit code = %v", out)
			}
			break
		}
	}
	if status != http.StatusTooManyRequests {
		t.Fatalf("XFF spoofing bypassed the login rate limit, last status = %d", status)
	}
}

// C-13: concurrent first logins for the same new external user must not 500
// (one goroutine's INSERT wins, the rest re-fetch the row).
func TestProvisionUserConcurrentCreate(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	api := New(db)

	ui := UserInfo{Username: "raceuser", Source: "external"}
	var wg sync.WaitGroup
	errs := make([]error, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = api.provisionUser(ui)
		}(i)
	}
	wg.Wait()
	for i, e := range errs {
		if e != nil {
			t.Fatalf("concurrent provision #%d failed: %v", i, e)
		}
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM users WHERE username = 'raceuser'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("users rows = %d, want 1", n)
	}
	u, err := serverstore.GetUserByUsername(db, "raceuser")
	if err != nil || u.Source != "external" {
		t.Fatalf("race user = %+v %v", u, err)
	}
}

func TestProvisionUserRejectsLocalAccountTakeover(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	createUser(t, db, "admin", "Admin@123", true) // local admin
	api := New(db)

	// external identity (LDAP/OIDC) colliding with a local account must NOT adopt it
	if _, err := api.provisionUser(UserInfo{Username: "admin", Source: "external"}); err == nil {
		t.Fatal("external identity adopted the local admin account")
	}

	// external identity creates its own row on first login
	ext, err := api.provisionUser(UserInfo{Username: "alice", DisplayName: "Alice", Source: "external"})
	if err != nil {
		t.Fatalf("provision external: %v", err)
	}
	if ext.Source != "external" {
		t.Fatalf("source = %q, want external", ext.Source)
	}

	// second external login adopts the external row (not local)
	ext2, err := api.provisionUser(UserInfo{Username: "alice", Source: "external"})
	if err != nil {
		t.Fatalf("re-provision external: %v", err)
	}
	if ext2.ID != ext.ID {
		t.Fatalf("external re-login created a new row: %d != %d", ext2.ID, ext.ID)
	}
	if ext2.Source != "external" {
		t.Fatalf("external re-login source = %q", ext2.Source)
	}
}

func TestBootstrapAdmin(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	// missing env -> error
	t.Setenv("PICOAI_ADMIN_PASSWORD", "")
	if err := EnsureBootstrapAdmin(db, "boss"); err == nil {
		t.Fatal("expected error without password env")
	}

	t.Setenv("PICOAI_ADMIN_PASSWORD", "Secret@99x")
	if err := EnsureBootstrapAdmin(db, "boss"); err != nil {
		t.Fatalf("EnsureBootstrapAdmin: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil || !u.IsAdmin {
		t.Fatalf("boss not admin: %v %+v", err, u)
	}
	if util.VerifyPassword(u.PasswordHash, "Secret@99x") == false {
		t.Fatal("bootstrap password not set correctly")
	}

	// idempotent: existing admin -> no error, no change
	if err := EnsureBootstrapAdmin(db, "boss"); err != nil {
		t.Fatalf("second EnsureBootstrapAdmin: %v", err)
	}
}

// ---------------------------------------------------------------------------
// 北京日夹具(2026-09-10 时区缺陷修复):
// 一律以"北京日"为基准构造**绝对瞬时**,不再用 time.Now().Format("2006-01-02")
// 这类"本机日期"(本机日 ≠ 北京日时用例必然查空:每天 8 小时窗口)。
// ---------------------------------------------------------------------------

// bjToday 返回北京日期值(今天)。
func bjToday() time.Time { return serverstore.BeijingDay(time.Now()) }

// bjDay 返回"北京日(今天 - daysAgo)"的日期值(查询边界用)。
func bjDay(daysAgo int) time.Time { return bjToday().AddDate(0, 0, -daysAgo) }

// fixtureAt 返回"北京日(今天 - daysAgo)的 hour:00"对应的绝对瞬时(写库夹具用)。
func fixtureAt(daysAgo, hour int) time.Time { return serverstore.BeijingDayAt(bjDay(daysAgo), hour) }

// setUsageAt 把用量行的 created_at 回填为给定绝对瞬时(timestamptz 参数,
// 与 PG 会话时区无关)。
func setUsageAt(t *testing.T, db *sql.DB, id int64, at time.Time) {
	t.Helper()
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", at, id); err != nil {
		t.Fatal(err)
	}
}

func mustUID(t *testing.T, db *sql.DB, username string) int64 {
	t.Helper()
	u, err := serverstore.GetUserByUsername(db, username)
	if err != nil {
		t.Fatal(err)
	}
	return u.ID
}

// TestUsageSummaryEndpoint: GET /api/auth/usage 返回余额/统计字段。
// 跨月安全(2026-09 修复):「昨日」记录与「今日」若跨月(每月 1 号),
// monthly_usage 只含本月(今日)部分,断言按实际日期动态计算——
// 此前用固定期望 150 万,月初运行必然失败(经典时间边界 bug)。
func TestUsageSummaryEndpoint(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "alice", "Alice@123", false)
	uid := mustUID(t, db, "alice")

	// 有定价模型,造今日/昨日/历史用量
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{Name: "prov", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	in, out2 := 2.0, 8.0
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "m1", ProviderID: pid, InputPricePer1M: &in, OutputPricePer1M: &out2}); err != nil {
		t.Fatal(err)
	}
	// 北京日口径:夹具与"今日/昨日"边界同源(进程 TZ=UTC 时北京 00:00-08:00
	// 也不会把今日算成昨日)。
	id, _ := serverstore.RecordUsage(db, uid, "m1", 1_000_000, 0)
	setUsageAt(t, db, id, fixtureAt(0, 9))
	// 昨日记录(可能跨月:北京 8/31 23:00)
	id2, _ := serverstore.RecordUsage(db, uid, "m1", 500_000, 0)
	setUsageAt(t, db, id2, fixtureAt(1, 23))

	today, yesterday := bjDay(0), bjDay(1)
	sameMonth := yesterday.Year() == today.Year() && yesterday.Month() == today.Month()
	// 跨月时:月度统计不含昨日记录(它属于上月)
	monthlyUsage := int64(1_000_000)
	monthlyCost := 2.0
	if sameMonth {
		monthlyUsage = 1_500_000
		monthlyCost = 3.0
	}

	// 2026-09-11:员工侧只剩余额口径 —— 开通并给 250 元余额。
	if _, err := serverstore.SetUserBalance(db, uid, 250, "test", "tester"); err != nil {
		t.Fatal(err)
	}

	token := loginToken(t, r, "alice", "Alice@123")
	w, out := doJSON(t, r, "GET", "/api/client/v2/auth/usage", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("usage status = %d body=%s", w.Code, w.Body.String())
	}
	if out["is_admin"] != false {
		t.Fatalf("is_admin = %v", out["is_admin"])
	}
	if out["balance_money"].(float64) != 250 || out["balance_activated"] != true {
		t.Fatalf("balance = %v activated=%v, want 250/true", out["balance_money"], out["balance_activated"])
	}
	for _, dead := range []string{"quota_tokens", "quota_money", "remaining_tokens", "remaining_money"} {
		if _, ok := out[dead]; ok {
			t.Fatalf("已下线的额度字段仍在下发: %s", dead)
		}
	}
	if out["monthly_usage"].(float64) != float64(monthlyUsage) {
		t.Fatalf("monthly_usage = %v, want %d", out["monthly_usage"], monthlyUsage)
	}
	if out["monthly_cost"].(float64) != monthlyCost {
		t.Fatalf("monthly_cost = %v, want %v", out["monthly_cost"], monthlyCost)
	}
	if out["today_usage"].(float64) != 1_000_000 || out["today_cost"].(float64) != 2.0 {
		t.Fatalf("today = %v/%v", out["today_usage"], out["today_cost"])
	}
	// 昨日:按真实"昨天"查询(跨月时仍是 8/31 的记录,不随断言分支变化)
	if out["yesterday_usage"].(float64) != 500_000 || out["yesterday_cost"].(float64) != 1.0 {
		t.Fatalf("yesterday = %v/%v", out["yesterday_usage"], out["yesterday_cost"])
	}
	if out["total_usage"].(float64) != 1_500_000 || out["total_cost"].(float64) != 3.0 {
		t.Fatalf("total = %v/%v", out["total_usage"], out["total_cost"])
	}
	// 2026-09-08 P2-13:死字段已移除(客户端从不渲染,服务端不再白算)。
	if _, ok := out["dept_budgets"]; ok {
		t.Fatal("dept_budgets must be removed (dead field)")
	}

	// 未登录 → 401
	w, _ = doJSON(t, r, "GET", "/api/client/v2/auth/usage", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d, want 401", w.Code)
	}
}

// TestUsageSummaryUnactivatedBalance: 未开通余额账户 → balance_activated=false
// 且余额为 0(客户端据此不渲染余额行);管理员同样返回其真实余额。
func TestUsageSummaryUnactivatedBalance(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "alice", "Alice@123", false)
	createUser(t, db, "boss", "Boss@123", true)

	token := loginToken(t, r, "alice", "Alice@123")
	w, out := doJSON(t, r, "GET", "/api/client/v2/auth/usage", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("usage status = %d", w.Code)
	}
	if out["balance_activated"] != false || out["balance_money"].(float64) != 0 {
		t.Fatalf("未开通 = %v/%v, want false/0", out["balance_activated"], out["balance_money"])
	}
}
