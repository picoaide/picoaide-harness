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
	db, err := serverstore.EnsureMigrated(tempPath(t, "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	r := gin.New()
	api.RegisterRoutes(r)
	cleanup := func() { db.Close() }
	return r, db, cleanup
}

func tempPath(t *testing.T, name string) string {
	t.Helper()
	return fmt.Sprintf("%s/%s", t.TempDir(), name)
}

func loginToken(t *testing.T, r *gin.Engine, username, password string) string {
	t.Helper()
	w, out := doJSON(t, r, "POST", "/api/auth/login", fmt.Sprintf(`{"username":"%s","password":"%s"}`, username, password), nil)
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
	w, out := doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"bad"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong pw status = %d, body=%s", w.Code, w.Body.String())
	}
	if code, _ := out["error"].(map[string]any)["code"].(string); code != "AUTH_FAILED" {
		t.Fatalf("code = %v", out["error"])
	}

	// correct login
	w, out = doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"Admin@123"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login status = %d body=%s", w.Code, w.Body.String())
	}
	token := out["token"].(string)
	if token == "" {
		t.Fatal("empty token")
	}

	// me
	w, out = doJSON(t, r, "GET", "/api/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("me status = %d body=%s", w.Code, w.Body.String())
	}
	if u := out["user"].(map[string]any); u["username"] != "admin" {
		t.Fatalf("me user = %v", u)
	}

	// logout revokes
	w, _ = doJSON(t, r, "POST", "/api/auth/logout", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("logout status = %d", w.Code)
	}
	w, _ = doJSON(t, r, "GET", "/api/auth/me", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("me after logout status = %d", w.Code)
	}
}

func TestBearerAuthRequired(t *testing.T) {
	r, _, cleanup := newTestAPI(t)
	defer cleanup()
	w, _ := doJSON(t, r, "GET", "/api/auth/me", "", nil)
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
		w, out := doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"wrong"}`, nil)
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
		w, out := doJSON(t, r, "POST", "/api/auth/login", `{"username":"admin","password":"wrong"}`,
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
	db, err := serverstore.EnsureMigrated(tempPath(t, "race.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	db, err := serverstore.EnsureMigrated(tempPath(t, "takeover.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
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
	db, err := serverstore.EnsureMigrated(tempPath(t, "boot.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

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

// TestUsageSummaryEndpoint: GET /api/auth/usage 返回配额/余额/统计字段。
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
	id, _ := serverstore.RecordUsage(db, uid, "m1", 1_000_000, 0)
	setUsageAt(t, db, id, time.Now().Format("2006-01-02")+" 09:00:00") // 今日 cost 2
	id2, _ := serverstore.RecordUsage(db, uid, "m1", 500_000, 0)
	setUsageAt(t, db, id2, time.Now().AddDate(0, 0, -1).Format("2006-01-02")+" 23:00:00") // 昨日 cost 1

	// 个人配额:token 100000、金额 100
	q := int64(100000)
	m := 100.0
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	u.QuotaTokens = &q
	u.QuotaMoney = &m
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	token := loginToken(t, r, "alice", "Alice@123")
	w, out := doJSON(t, r, "GET", "/api/auth/usage", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("usage status = %d body=%s", w.Code, w.Body.String())
	}
	if out["is_admin"] != false {
		t.Fatalf("is_admin = %v", out["is_admin"])
	}
	if out["quota_tokens"].(float64) != 100000 || out["quota_money"].(float64) != 100 {
		t.Fatalf("quota = %v/%v", out["quota_tokens"], out["quota_money"])
	}
	// 本月已用 150 万 token / 3 元 → 剩余 985000 / 97
	if out["monthly_usage"].(float64) != 1_500_000 {
		t.Fatalf("monthly_usage = %v", out["monthly_usage"])
	}
	// 剩余 = 配额 - 本月已用 = 100000 - 1500000 = -1400000(超额为负)
	if out["remaining_tokens"].(float64) != -1_400_000 {
		t.Fatalf("remaining_tokens = %v", out["remaining_tokens"])
	}
	if out["monthly_cost"].(float64) != 3.0 {
		t.Fatalf("monthly_cost = %v", out["monthly_cost"])
	}
	if out["remaining_money"].(float64) != 97.0 {
		t.Fatalf("remaining_money = %v", out["remaining_money"])
	}
	if out["today_usage"].(float64) != 1_000_000 || out["today_cost"].(float64) != 2.0 {
		t.Fatalf("today = %v/%v", out["today_usage"], out["today_cost"])
	}
	if out["yesterday_usage"].(float64) != 500_000 || out["yesterday_cost"].(float64) != 1.0 {
		t.Fatalf("yesterday = %v/%v", out["yesterday_usage"], out["yesterday_cost"])
	}
	if out["total_usage"].(float64) != 1_500_000 || out["total_cost"].(float64) != 3.0 {
		t.Fatalf("total = %v/%v", out["total_usage"], out["total_cost"])
	}
	if _, ok := out["dept_budgets"]; !ok {
		t.Fatal("dept_budgets missing (want [])")
	}

	// 未登录 → 401
	w, _ = doJSON(t, r, "GET", "/api/auth/usage", "", nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("no token status = %d, want 401", w.Code)
	}
}

// TestUsageSummaryUnlimitedAndAdmin: 无限配额 → remaining null;admin → 豁免。
func TestUsageSummaryUnlimitedAndAdmin(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "alice", "Alice@123", false)
	createUser(t, db, "boss", "Boss@123", true)

	token := loginToken(t, r, "alice", "Alice@123")
	w, out := doJSON(t, r, "GET", "/api/auth/usage", "", map[string]string{"Authorization": "Bearer " + token})
	if w.Code != http.StatusOK {
		t.Fatalf("usage status = %d", w.Code)
	}
	// 无配额配置 → remaining null
	if v, present := out["remaining_tokens"]; !present || v != nil {
		t.Fatalf("unlimited remaining_tokens = %v (present=%v), want null", v, present)
	}
	if v, present := out["remaining_money"]; !present || v != nil {
		t.Fatalf("unlimited remaining_money = %v (present=%v), want null", v, present)
	}

	// admin:is_admin=true 且配额 0(豁免)
	token2 := loginToken(t, r, "boss", "Boss@123")
	w, out = doJSON(t, r, "GET", "/api/auth/usage", "", map[string]string{"Authorization": "Bearer " + token2})
	if w.Code != http.StatusOK {
		t.Fatalf("admin usage status = %d", w.Code)
	}
	if out["is_admin"] != true {
		t.Fatalf("admin is_admin = %v", out["is_admin"])
	}
	if v := out["remaining_tokens"]; v != nil {
		t.Fatalf("admin remaining_tokens = %v, want null(豁免)", v)
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

func setUsageAt(t *testing.T, db *sql.DB, id int64, ts string) {
	t.Helper()
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", ts, id); err != nil {
		t.Fatal(err)
	}
}
