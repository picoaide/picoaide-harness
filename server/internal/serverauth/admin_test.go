package serverauth

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestAdminSession(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if sess.ID == "" || csrf == "" {
		t.Fatal("empty session/csrf")
	}
	u, err := ValidateAdminSession(db, sess.ID)
	if err != nil || u.ID != uid {
		t.Fatalf("validate: %v %v", u, err)
	}
	// csrf verify with tolerance (deterministic: anchored at an hour boundary)
	anchor := time.Now().UTC().Truncate(time.Hour)
	tok := IssueCSRF(sess.CSRFKey, anchor)
	if !VerifyCSRF(sess.CSRFKey, tok, anchor.Add(30*time.Minute)) {
		t.Fatal("same-window token rejected")
	}
	if !VerifyCSRF(sess.CSRFKey, tok, anchor.Add(90*time.Minute)) {
		t.Fatal("next-window token rejected")
	}
	if VerifyCSRF(sess.CSRFKey, tok, anchor.Add(150*time.Minute)) {
		t.Fatal("stale token accepted")
	}
	tokPrev := IssueCSRF(sess.CSRFKey, anchor.Add(-30*time.Minute))
	if !VerifyCSRF(sess.CSRFKey, tokPrev, anchor.Add(30*time.Minute)) {
		t.Fatal("previous-window token rejected")
	}
	if VerifyCSRF(sess.CSRFKey, "bad", anchor) {
		t.Fatal("csrf accepted bad token")
	}
	if VerifyCSRF("other-key", tok, anchor) {
		t.Fatal("csrf accepted wrong key")
	}
	// expire
	_, err = db.Exec("UPDATE admin_sessions SET expires_at = ? WHERE id = ?", time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), sess.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err == nil {
		t.Fatal("expired session accepted")
	}
}

func TestAdminAPIs(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

	// login
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	csrf := out["csrf_token"].(string)
	cookies := w.Result().Cookies()
	var sess string
	for _, ck := range cookies {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	if sess == "" {
		t.Fatal("no session cookie")
	}
	if !cookieHttpOnly(cookies) {
		t.Fatal("cookie not HttpOnly")
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	// /me returns a fresh csrf_token so a reloaded admin SPA can keep writing
	w, me := doJSON(t, r, "GET", "/api/admin/me", "", map[string]string{"Cookie": "picoaide_session=" + sess})
	if w.Code != http.StatusOK {
		t.Fatalf("me: %d %s", w.Code, w.Body.String())
	}
	if tok, _ := me["csrf_token"].(string); tok == "" {
		t.Fatal("me did not return csrf_token")
	}

	// list users requires auth
	if w, _ := doJSON(t, r, "GET", "/api/admin/users", "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("users without session: %d", w.Code)
	}
	// create user
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))
	// update user
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"status":0}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("update user: %d %s", w.Code, w.Body.String())
	}
	// CSRF missing → 403
	if w, _ := doJSON(t, r, "POST", "/api/admin/users", `{"username":"eve","password":"x"}`, map[string]string{"Cookie": "picoaide_session=" + sess}); w.Code != http.StatusForbidden {
		t.Fatalf("create without csrf: %d", w.Code)
	}
	// delete user
	w, _ = doJSON(t, r, "DELETE", fmt.Sprintf("/api/admin/users/%d", id), "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("delete user: %d %s", w.Code, w.Body.String())
	}
	// cannot delete self
	w, _ = doJSON(t, r, "DELETE", "/api/admin/users/1", "", hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("delete self: %d", w.Code)
	}
	// logout
	w, _ = doJSON(t, r, "POST", "/api/admin/logout", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("logout: %d", w.Code)
	}
	if w, _ := doJSON(t, r, "GET", "/api/admin/users", "", hdr()); w.Code != http.StatusUnauthorized {
		t.Fatalf("users after logout: %d", w.Code)
	}
}

func TestAdminPasswordPolicy(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	// short password -> VALIDATION
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"shorty","password":"tooshort"}`, hdr)
	if w.Code != http.StatusBadRequest || out["error"].(map[string]any)["code"] != "VALIDATION" {
		t.Fatalf("short password: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "10") {
		t.Fatalf("short password message should mention min length: %s", w.Body.String())
	}
	// 10-char password -> ok
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"okuser","password":"tenchars12"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("10-char password: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))
	// update password to short -> VALIDATION
	w, out = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"password":"short"}`, hdr)
	if w.Code != http.StatusBadRequest || out["error"].(map[string]any)["code"] != "VALIDATION" {
		t.Fatalf("short password update: %d %s", w.Code, w.Body.String())
	}
	// update password to 10 chars -> ok
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"password":"newpassword123"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("long password update: %d %s", w.Code, w.Body.String())
	}
}

func TestAdminUsage(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	// record some usage for user 1
	recordUsage(t, db, 1, "deepseek-chat", 10, 20)
	recordUsage(t, db, 1, "deepseek-chat", 30, 40)

	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=day", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("usage: %d %s", w.Code, w.Body.String())
	}
	rows := out["rows"].([]any)
	if len(rows) != 1 {
		t.Fatalf("usage rows = %d", len(rows))
	}
	r0 := rows[0].(map[string]any)
	if r0["prompt_tokens"].(float64) != 40 || r0["requests"].(float64) != 2 {
		t.Fatalf("usage row = %v", r0)
	}
	// invalid group
	if w, _ := doJSON(t, r, "GET", "/api/admin/usage?group=nope", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("bad group: %d", w.Code)
	}
}

func TestAdminTokens(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	uid, err := createUserDB(db, "tokadmin", "pw123456", false)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := IssueToken(db, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := IssueToken(db, uid); err != nil {
		t.Fatal(err)
	}

	// requires session
	if w, _ := doJSON(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/tokens", uid), "", nil); w.Code != http.StatusUnauthorized {
		t.Fatalf("tokens without session: %d", w.Code)
	}
	// list
	w, out = doJSON(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/tokens", uid), "", map[string]string{"Cookie": "picoaide_session=" + sess})
	if w.Code != http.StatusOK {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	toks := out["tokens"].([]any)
	if len(toks) != 2 {
		t.Fatalf("want 2 tokens, got %d", len(toks))
	}
	for _, tk := range toks {
		row := tk.(map[string]any)
		if _, leaked := row["token_hash"]; leaked {
			t.Fatal("token_hash leaked to admin listing")
		}
		if row["name"] != "desktop" {
			t.Fatalf("name = %v", row["name"])
		}
	}
	tid := int64(toks[0].(map[string]any)["id"].(float64))

	// unknown user -> 404
	if w, _ := doJSON(t, r, "GET", "/api/admin/users/999999/tokens", "", map[string]string{"Cookie": "picoaide_session=" + sess}); w.Code != http.StatusNotFound {
		t.Fatalf("unknown user list: %d", w.Code)
	}
	// revoke requires CSRF
	if w, _ := doJSON(t, r, "POST", fmt.Sprintf("/api/admin/tokens/%d/revoke", tid), "", map[string]string{"Cookie": "picoaide_session=" + sess}); w.Code != http.StatusForbidden {
		t.Fatalf("revoke without csrf: %d", w.Code)
	}
	// revoke
	w, _ = doJSON(t, r, "POST", fmt.Sprintf("/api/admin/tokens/%d/revoke", tid), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	w, out = doJSON(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/tokens", uid), "", map[string]string{"Cookie": "picoaide_session=" + sess})
	toks = out["tokens"].([]any)
	if toks[0].(map[string]any)["revoked"].(float64) != 1 {
		t.Fatal("token not revoked in listing")
	}
	// unknown token -> 404
	if w, _ := doJSON(t, r, "POST", "/api/admin/tokens/999999/revoke", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("unknown token revoke: %d", w.Code)
	}
}

func TestVerifyTokenTouchesLastUsed(t *testing.T) {
	db := mustDB(t)
	defer db.Close()
	uid, err := createUserDB(db, "lastused", "pw123456", false)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyToken(db, raw); err != nil {
		t.Fatal(err)
	}
	tok, err := serverstore.GetTokenByHash(db, serverstore.TokenHash(raw))
	if err != nil {
		t.Fatal(err)
	}
	if tok.LastUsedAt.IsZero() {
		t.Fatal("verify did not touch last_used_at")
	}
}

// C-15: creating an admin session sweeps already-expired sessions, so the
// admin_sessions table cannot grow without bound.
func TestCreateAdminSessionCleansExpired(t *testing.T) {
	db := mustDB(t)
	defer db.Close()
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at) VALUES (?, ?, 'k', ?)`,
		"expired-1", uid, time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at) VALUES (?, ?, 'k', ?)`,
		"expired-2", uid, time.Now().Add(-48*time.Hour).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := CreateAdminSession(db, uid); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"expired-1", "expired-2"} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM admin_sessions WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("expired session %s not swept", id)
		}
	}
}

// C-16: bootstrap admin password must satisfy the same 10-char policy as
// admin-created users (PICOAI_ADMIN_PASSWORD is the only gate).
func TestEnsureBootstrapAdminPasswordPolicy(t *testing.T) {
	db := mustDB(t)
	defer db.Close()

	t.Setenv("PICOAI_ADMIN_PASSWORD", "short")
	if err := EnsureBootstrapAdmin(db, "admin"); err == nil {
		t.Fatal("short bootstrap password accepted")
	}

	t.Setenv("PICOAI_ADMIN_PASSWORD", "this-is-long-enough")
	if err := EnsureBootstrapAdmin(db, "admin"); err != nil {
		t.Fatalf("bootstrap with valid password: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "admin")
	if err != nil || !u.IsAdmin {
		t.Fatalf("bootstrapped admin = %+v %v", u, err)
	}
}

// C-17: deleting the last admin is refused server-side; the row is rolled back.
func TestDeleteLastAdminRollsBack(t *testing.T) {
	db := mustDB(t)
	defer db.Close()
	if _, err := createUserDB(db, "adminA", "pw123456", true); err != nil {
		t.Fatal(err)
	}
	bID, err := createUserDB(db, "adminB", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.DeleteUser(db, bID); err != nil {
		t.Fatalf("delete adminB while adminA remains: %v", err)
	}
	a, err := serverstore.GetUserByUsername(db, "adminA")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.DeleteUser(db, a.ID); err == nil {
		t.Fatal("last admin deletion succeeded, want rollback")
	}
	if _, err := serverstore.GetUserByUsername(db, "adminA"); err != nil {
		t.Fatalf("last admin was deleted despite guard: %v", err)
	}
}

// --- helpers ---

func mustDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := serverstore.EnsureMigrated(tempPath(t, "admin.db"))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func createUserDB(db *sql.DB, username, password string, admin bool) (int64, error) {
	id, err := serverstore.CreateUserWithPassword(db, username, password)
	if err != nil {
		return 0, err
	}
	u, err := serverstore.GetUserByID(db, id)
	if err != nil {
		return 0, err
	}
	u.IsAdmin = admin
	return id, serverstore.UpdateUser(db, u)
}

func adminRouter(t *testing.T) (http.Handler, *sql.DB) {
	t.Helper()
	db := mustDB(t)
	if _, err := createUserDB(db, "boss", "pw123456", true); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	return r, db
}

func cookieHttpOnly(cookies []*http.Cookie) bool {
	for _, ck := range cookies {
		if ck.Name == sessionCookieName {
			return ck.HttpOnly
		}
	}
	return false
}

func recordUsage(t *testing.T, db *sql.DB, userID int64, model string, pt, ct int64) {
	t.Helper()
	_, err := serverstore.RecordUsage(db, userID, model, pt, ct)
	if err != nil {
		t.Fatal(err)
	}
}

// 用户组管理:部门归属的闭环入口(本地账号进组)
func TestAdminUserGroupsAPI(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)

	// 创建普通用户
	var out map[string]any
	w, out := doAdmin(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"pw12345678"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	aliceID := int64(out["user"].(map[string]any)["id"].(float64))

	// 设置部门组
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), `{"groups":["研发部","安全组"]}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set groups: %d %s", w.Code, w.Body.String())
	}
	// 读取
	w, out = doAdmin(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("get groups: %d %s", w.Code, w.Body.String())
	}
	groups := out["groups"].([]any)
	if len(groups) != 2 {
		t.Fatalf("groups = %v", groups)
	}
	// 用户列表附带组
	w, out = doAdmin(t, r, "GET", "/api/admin/users", "", hdr)
	users := out["users"].([]any)
	found := false
	for _, u := range users {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			if gs := um["groups"].([]any); len(gs) != 2 {
				t.Fatalf("list users groups = %v", gs)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("alice missing from user list")
	}
	// 非法组名拒绝
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), `{"groups":["a/b"]}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad group name = %d, want 400", w.Code)
	}
	// 不存在用户 → 404
	w, _ = doAdmin(t, r, "PUT", "/api/admin/users/99999/groups", `{"groups":["x"]}`, hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown user = %d, want 404", w.Code)
	}
	// 审计记录
	logs, err := serverstore.ListAuditLogs(db, 5)
	if err != nil || len(logs) == 0 || logs[0].Action != "user_groups" {
		t.Fatalf("audit = %+v %v", logs, err)
	}
}

func doAdmin(t *testing.T, r http.Handler, method, path, body string, hdr map[string]string) (*httptest.ResponseRecorder, map[string]any) {
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
