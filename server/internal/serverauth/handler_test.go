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
