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
	if w.Code != http.StatusCreated {
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
	if w.Code != http.StatusCreated {
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

	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=day&from="+time.Now().Format("2006-01-02")+"&to="+time.Now().Format("2006-01-02"), "", hdr)
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
	// 缺省 from/to 默认近 90 天窗口且按日补零(审计中2)
	if w, out := doJSON(t, r, "GET", "/api/admin/usage?group=day", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("usage default window: %d %s", w.Code, w.Body.String())
	} else if n := len(out["rows"].([]any)); n != usageDefaultWindowDays {
		t.Fatalf("usage default window rows = %d, want %d", n, usageDefaultWindowDays)
	}
}

// TestAdminUsageRangeValidation: 服务端区间校验与截断(审计中2):
//  1. to < from → 400 VALIDATION;
//  2. from/to 缺省 → 服务端默认近 90 天窗口(100 天前行不在内,10 天前在内);
//  3. group=user 超上限 → 截断并返回 truncated=true。
func TestAdminUsageRangeValidation(t *testing.T) {
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

	// 1) to < from → 400
	if w, _ := doJSON(t, r, "GET", "/api/admin/usage?group=day&from=2026-08-10&to=2026-08-01", "", hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("to<from: %d, want 400", w.Code)
	}

	// 2) 缺省窗口:100 天前的行应被排除,10 天前的行应包含
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, created_at)
		VALUES (1, 'm-old', 5, 5, datetime('now','localtime','-100 days'))`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, created_at)
		VALUES (1, 'm-recent', 7, 3, datetime('now','localtime','-10 days'))`); err != nil {
		t.Fatal(err)
	}
	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=model", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("usage default window: %d %s", w.Code, w.Body.String())
	}
	labels := map[string]bool{}
	for _, row := range out["rows"].([]any) {
		labels[row.(map[string]any)["label"].(string)] = true
	}
	if labels["m-old"] {
		t.Fatal("100-day-old row included in default window")
	}
	if !labels["m-recent"] {
		t.Fatal("10-day-old row missing from default window")
	}

	// 3) group=user 截断:501 个用户各一条用量 → 返回 ≤500 行且 truncated=true
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 501; i++ {
		res, err := tx.Exec(`INSERT INTO users (username, source, is_admin, status) VALUES (?, 'local', 0, 1)`, fmt.Sprintf("bulk%03d", i))
		if err != nil {
			t.Fatal(err)
		}
		id, err := res.LastInsertId()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, created_at)
			VALUES (?, 'm', 1, 1, datetime('now','localtime'))`, id); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=user", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("usage group=user: %d %s", w.Code, w.Body.String())
	}
	if n := len(out["rows"].([]any)); n > maxUserUsageRows {
		t.Fatalf("group=user rows = %d, want <= %d", n, maxUserUsageRows)
	}
	if tr, _ := out["truncated"].(bool); !tr {
		t.Fatal("group=user truncated flag missing/false")
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
	db, err := serverstore.EnsureMigrated(serverstore.DBConfig{Path: tempPath(t, "admin.db")})
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
	// 与 llmgateway 测试同因:adminLoginLimiter 包级共享且惰性创建,
	// 测试登录 boss 多次,默认 10 次/5min 会限流 → 放宽。
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "10000")
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

	// 建部门(单部门归属模型)
	devID, err := serverstore.CreateDepartment(db, "研发部", 0, 0, "")
	if err != nil {
		t.Fatal(err)
	}

	// 创建普通用户
	var out map[string]any
	w, out := doAdmin(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"pw12345678"}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	aliceID := int64(out["user"].(map[string]any)["id"].(float64))

	// 设置单部门归属(研发部;id=1 为迁移 seed 的隐式全员)
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/department", aliceID), fmt.Sprintf(`{"group_id":%d}`, devID), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set department: %d %s", w.Code, w.Body.String())
	}
	// 读取(仍走 GET groups,返回组名列表)
	w, out = doAdmin(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("get groups: %d %s", w.Code, w.Body.String())
	}
	groups := out["groups"].([]any)
	if len(groups) != 1 || groups[0] != "研发部" {
		t.Fatalf("groups = %v", groups)
	}
	// 用户列表附带组
	w, out = doAdmin(t, r, "GET", "/api/admin/users", "", hdr)
	users := out["users"].([]any)
	found := false
	for _, u := range users {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			if gs := um["groups"].([]any); len(gs) != 1 {
				t.Fatalf("list users groups = %v", gs)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("alice missing from user list")
	}
	// 多部门 set 端点已移除(单部门模型)
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), `{"groups":["研发部"]}`, hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("legacy multi-group endpoint = %d, want 404", w.Code)
	}
	// 不存在的部门 → 400
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/department", aliceID), `{"group_id":9999}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("bad dept = %d, want 400", w.Code)
	}
	// 未知字段(误传 department_id)必须被拒 —— 不得静默清空用户组归属
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/department", aliceID), `{"department_id":1}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d, want 400 (must not silently clear groups)", w.Code)
	}
	// 拒绝后组归属保持原样(研发部仍在)
	w, out = doAdmin(t, r, "GET", fmt.Sprintf("/api/admin/users/%d/groups", aliceID), "", hdr)
	if w.Code == http.StatusOK {
		if gs := out["groups"].([]any); len(gs) != 1 || gs[0] != "研发部" {
			t.Fatalf("groups after rejected unknown-field put = %v, want 研发部 intact", gs)
		}
	}
	// 不存在用户 → 404
	w, _ = doAdmin(t, r, "PUT", "/api/admin/users/99999/department", fmt.Sprintf(`{"group_id":%d}`, devID), hdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("unknown user = %d, want 404", w.Code)
	}
	// 审计记录
	logs, err := serverstore.ListAuditLogs(db, 5)
	if err != nil || len(logs) == 0 || logs[0].Action != "user_dept" {
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

// 部门管理 API:CRUD + 循环防护 + 删除约束 + 用户单部门归属
func TestAdminDepartmentsAPI(t *testing.T) {
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

	// 建部门树
	var out map[string]any
	w, out := doAdmin(t, r, "POST", "/api/admin/departments", `{"name":"研发部"}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create dept: %d %s", w.Code, w.Body.String())
	}
	devID := int64(out["department"].(map[string]any)["id"].(float64))
	var frontID int64
	w, out = doAdmin(t, r, "POST", "/api/admin/departments", `{"name":"前端组","parent_id":`+fmt.Sprint(devID)+`}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create child: %d %s", w.Code, w.Body.String())
	}
	frontID = int64(out["department"].(map[string]any)["id"].(float64))

	// 列表含层级(含迁移 seed 的隐式全员)
	w, out = doAdmin(t, r, "GET", "/api/admin/departments", "", hdr)
	if w.Code != http.StatusOK || len(out["departments"].([]any)) != 3 {
		t.Fatalf("list depts: %d %s", w.Code, w.Body.String())
	}

	// 循环防护:前端组不能成为研发部上级
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/departments/%d", devID),
		`{"name":"研发部","parent_id":`+fmt.Sprint(frontID)+`}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("cycle parent = %d, want 400", w.Code)
	}

	// 用户单部门归属
	var aliceID int64
	w, out = doAdmin(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"pw12345678"}`, hdr)
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d", w.Code)
	}
	aliceID = int64(out["user"].(map[string]any)["id"].(float64))
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/department", aliceID),
		`{"group_id":`+fmt.Sprint(frontID)+`}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("set dept: %d %s", w.Code, w.Body.String())
	}
	groups, err := serverstore.UserGroups(db, aliceID)
	if err != nil || len(groups) != 1 || groups[0] != "前端组" {
		t.Fatalf("alice groups = %v %v", groups, err)
	}

	// 删除约束:有成员 → 拒绝
	w, _ = doAdmin(t, r, "DELETE", fmt.Sprintf("/api/admin/departments/%d", frontID), "", hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("delete with member = %d, want 400", w.Code)
	}
	// 有子部门 → 拒绝
	w, _ = doAdmin(t, r, "DELETE", fmt.Sprintf("/api/admin/departments/%d", devID), "", hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("delete with child = %d, want 400", w.Code)
	}
	// 审计
	logs, err := serverstore.ListAuditLogs(db, 10)
	if err != nil || len(logs) == 0 || logs[0].Action != "user_dept" {
		t.Fatalf("audit = %+v %v", logs, err)
	}
}

// auth.mode=ldap 时,本地管理员不得绕过配置登录管理页(审计2026-M1)
func TestAdminLoginRespectsAuthMode(t *testing.T) {
	db := mustDB(t)
	if _, err := createUserDB(db, "boss", "pw123456", true); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "auth.mode", "ldap"); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	// 无 LDAP 配置 → ldap provider 未注册 → 登录必须 401
	w, _ := doAdmin(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("ldap-mode local admin login = %d, want 401", w.Code)
	}
}

// 外部(LDAP/OIDC)用户不得改本地密码:避免被踢出 IdP 且防接管守卫拒绝其登录
func TestExternalUserPasswordRejected(t *testing.T) {
	db := mustDB(t)
	bossID, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	extID, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice-ldap", Source: "external", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, bossID)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	w, _ := doAdmin(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", extID), `{"password":"newpassword123"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("external password change = %d, want 400", w.Code)
	}
	u, err := serverstore.GetUserByID(db, extID)
	if err != nil {
		t.Fatal(err)
	}
	if u.Source != "external" || u.PasswordHash != "" {
		t.Fatalf("external user mutated: source=%s hash=%q", u.Source, u.PasswordHash)
	}
}

// 员工流量配额:updateUser 设置 quota_tokens,listUsers 返回配额与本月用量。
func TestAdminUserQuota(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

	// login as admin
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
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	// create a regular user
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))
	// default quota_tokens is null (follow global default)
	if q, ok := out["user"].(map[string]any)["quota_tokens"]; ok && q != nil {
		t.Fatalf("default quota_tokens = %v, want null", q)
	}

	// record usage this month, set an explicit quota, then verify the list
	if _, err := serverstore.RecordUsage(db, id, "deepseek-chat", 100, 50); err != nil {
		t.Fatal(err)
	}
	w, out = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_tokens":5000}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("set quota: %d %s", w.Code, w.Body.String())
	}
	w, out = doJSON(t, r, "GET", "/api/admin/users", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d %s", w.Code, w.Body.String())
	}
	found := false
	for _, u := range out["users"].([]any) {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			found = true
			if q := um["quota_tokens"].(float64); q != 5000 {
				t.Fatalf("quota_tokens = %v, want 5000", q)
			}
			if mu := um["monthly_usage"].(float64); mu != 150 {
				t.Fatalf("monthly_usage = %v, want 150", mu)
			}
		}
	}
	if !found {
		t.Fatal("alice missing from user list")
	}

	// negative quota rejected
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_tokens":-1}`, hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative quota = %d, want 400", w.Code)
	}

	// quota_clear resets to NULL (follow global default)
	w, out = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_clear":true}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("clear quota: %d %s", w.Code, w.Body.String())
	}
	w, out = doJSON(t, r, "GET", "/api/admin/users", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d %s", w.Code, w.Body.String())
	}
	for _, u := range out["users"].([]any) {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			if q, present := um["quota_tokens"]; !present || q != nil {
				t.Fatalf("quota_tokens after clear = %v, want null", q)
			}
		}
	}
}

// TestAdminUserMoneyQuota: 按员工设置金额配额(0022),列表附 monthly_cost。
func TestAdminUserMoneyQuota(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

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
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))

	// 有定价模型 + 本月费用 6 元(1M prompt*2 + 0.5M completion*8)
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{Name: "prov-p", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	in, out2 := 2.0, 8.0
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "priced-model", ProviderID: pid, InputPricePer1M: &in, OutputPricePer1M: &out2}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, id, "priced-model", 1_000_000, 500_000); err != nil {
		t.Fatal(err)
	}

	// 设置金额配额 50 元
	w, out = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_money":50}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("set quota_money: %d %s", w.Code, w.Body.String())
	}

	// 列表返回 quota_money + monthly_cost
	w, out = doJSON(t, r, "GET", "/api/admin/users", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d %s", w.Code, w.Body.String())
	}
	found := false
	for _, u := range out["users"].([]any) {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			found = true
			if q := um["quota_money"].(float64); q != 50 {
				t.Fatalf("quota_money = %v, want 50", q)
			}
			if mc := um["monthly_cost"].(float64); mc != 6.0 {
				t.Fatalf("monthly_cost = %v, want 6.0", mc)
			}
		}
	}
	if !found {
		t.Fatal("alice missing from user list")
	}

	// 负数金额配额拒绝
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_money":-1}`, hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative quota_money = %d, want 400", w.Code)
	}

	// quota_money_clear 恢复 NULL(跟随全局默认)
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", id), `{"quota_money_clear":true}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("clear quota_money: %d %s", w.Code, w.Body.String())
	}
	w, out = doJSON(t, r, "GET", "/api/admin/users", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d %s", w.Code, w.Body.String())
	}
	for _, u := range out["users"].([]any) {
		um := u.(map[string]any)
		if um["username"] == "alice" {
			if q, present := um["quota_money"]; !present || q != nil {
				t.Fatalf("quota_money after clear = %v, want null", q)
			}
		}
	}
}

// TestAdminUsageCost: usage 汇总行携带 cost 字段。
func TestAdminUsageCost(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

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
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	id := int64(out["user"].(map[string]any)["id"].(float64))
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{Name: "prov-p", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	in, out2 := 2.0, 8.0
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "priced-model", ProviderID: pid, InputPricePer1M: &in, OutputPricePer1M: &out2}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, id, "priced-model", 1_000_000, 500_000); err != nil {
		t.Fatal(err)
	}

	// group=model:单桶,避免按日补零把 rows[0] 变成 2000 年的空桶
	w, out = doJSON(t, r, "GET", "/api/admin/usage?group=model&from=2000-01-01&to=2100-12-31", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("usage: %d %s", w.Code, w.Body.String())
	}
	rows := out["rows"].([]any)
	if len(rows) == 0 {
		t.Fatal("no usage rows")
	}
	if c := rows[0].(map[string]any)["cost"].(float64); c != 6.0 {
		t.Fatalf("usage row cost = %v, want 6.0", c)
	}
}

// listUsers 必须附带生效配额(effective_quota_tokens/money,审计 M7):
// 员工无个人配额时 = 全局默认,设个人配额后 = 个人值,admin 恒 0(不限)。
func TestAdminListUsersEffectiveQuota(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	csrf := out["csrf_token"].(string)
	var sess string
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}
	// 全局默认配额
	if err := serverstore.SetSetting(db, serverstore.MonthlyQuotaSetting, "100000"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, serverstore.MonthlyMoneyQuotaSetting, "50"); err != nil {
		t.Fatal(err)
	}
	// 员工(无个人配额)
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d", w.Code)
	}
	uid := int64(out["user"].(map[string]any)["id"].(float64))
	// 列表:alice 的生效配额 = 全局默认
	w, out = doJSON(t, r, "GET", "/api/admin/users?size=200", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d", w.Code)
	}
	alice := findUser(out, "alice")
	if alice == nil {
		t.Fatal("alice missing")
	}
	if eq, _ := alice["effective_quota_tokens"].(float64); eq != 100000 {
		t.Fatalf("alice effective_quota_tokens = %v, want 100000", eq)
	}
	if em, _ := alice["effective_quota_money"].(float64); em != 50 {
		t.Fatalf("alice effective_quota_money = %v, want 50", em)
	}
	// admin 恒 0(不限)
	boss := findUser(out, "boss")
	if boss == nil {
		t.Fatal("boss missing")
	}
	if eq, _ := boss["effective_quota_tokens"].(float64); eq != 0 {
		t.Fatalf("boss effective_quota_tokens = %v, want 0", eq)
	}
	// 设个人配额后生效值 = 个人值
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d", uid), `{"quota_tokens":5000,"quota_money":10}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("set quota: %d", w.Code)
	}
	w, out = doJSON(t, r, "GET", "/api/admin/users?size=200", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list users: %d", w.Code)
	}
	alice = findUser(out, "alice")
	if eq, _ := alice["effective_quota_tokens"].(float64); eq != 5000 {
		t.Fatalf("alice effective_quota_tokens after override = %v, want 5000", eq)
	}
	if em, _ := alice["effective_quota_money"].(float64); em != 10 {
		t.Fatalf("alice effective_quota_money after override = %v, want 10", em)
	}
}

func findUser(out map[string]any, name string) map[string]any {
	for _, u := range out["users"].([]any) {
		um := u.(map[string]any)
		if um["username"] == name {
			return um
		}
	}
	return nil
}

// 创建端点 REST 语义(审计 L6):POST 返回 201;updateDepartment 返回资源对象。
func TestAdminCreateReturnsCreated(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	csrf := out["csrf_token"].(string)
	var sess string
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}
	// POST /users → 201
	w, _ = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123"}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user status = %d, want 201", w.Code)
	}
	// POST /departments → 201
	w, out = doJSON(t, r, "POST", "/api/admin/departments", `{"name":"研发部"}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create dept status = %d, want 201", w.Code)
	}
	deptID := int64(out["department"].(map[string]any)["id"].(float64))
	// PUT /departments/:id → 返回 department 资源(与 create 一致,不再 {ok:true})
	w, out = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/departments/%d", deptID), `{"name":"技术中心"}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("update dept: %d %s", w.Code, w.Body.String())
	}
	dep, ok := out["department"].(map[string]any)
	if !ok || dep["name"] != "技术中心" || dep["id"].(float64) != float64(deptID) {
		t.Fatalf("update dept response = %v, want department object", out)
	}
}

// createDepartment 必须消费 budget_money(审计 H4:此前静默丢弃,
// 新建部门带预算保存后预算不生效)。
func TestAdminCreateDeptWithBudget(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	csrf := out["csrf_token"].(string)
	var sess string
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}
	// 创建带预算部门
	w, out = doJSON(t, r, "POST", "/api/admin/departments", `{"name":"财务部","budget_money":500}`, hdr())
	if w.Code != http.StatusOK && w.Code != http.StatusCreated {
		t.Fatalf("create dept with budget: %d %s", w.Code, w.Body.String())
	}
	// 列表必须带 budget_money=500
	w, out = doJSON(t, r, "GET", "/api/admin/departments", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list depts: %d", w.Code)
	}
	for _, d := range out["departments"].([]any) {
		dm := d.(map[string]any)
		if dm["name"] == "财务部" {
			if b, _ := dm["budget_money"].(float64); b != 500 {
				t.Fatalf("create dept budget_money = %v, want 500", b)
			}
			return
		}
	}
	t.Fatal("财务部 missing from list")
}

// 删除保留部门「全员」→ 400 VALIDATION(审计 L1:此前落入 500 INTERNAL)
func TestAdminDeleteEveryoneDept(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	csrf := out["csrf_token"].(string)
	var sess string
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}
	w, out = doJSON(t, r, "GET", "/api/admin/departments", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list depts: %d", w.Code)
	}
	var everyoneID int64
	for _, d := range out["departments"].([]any) {
		dm := d.(map[string]any)
		if dm["name"] == "全员" {
			everyoneID = int64(dm["id"].(float64))
		}
	}
	if everyoneID == 0 {
		t.Fatal("everyone dept missing from list")
	}
	w, out = doJSON(t, r, "DELETE", fmt.Sprintf("/api/admin/departments/%d", everyoneID), "", hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("delete everyone dept: %d %s, want 400", w.Code, w.Body.String())
	}
	if code, _ := out["error"].(map[string]any)["code"].(string); code != "VALIDATION" {
		t.Fatalf("error code = %v, want VALIDATION", code)
	}
}

// 创建部门带负预算 → 400
func TestAdminCreateDeptNegativeBudget(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	csrf := out["csrf_token"].(string)
	var sess string
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}
	w, _ = doJSON(t, r, "POST", "/api/admin/departments", `{"name":"坏预算","budget_money":-1}`, hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative budget create accepted: %d", w.Code)
	}
}

// TestAdminDeptBudget: 部门预算设置/清除,列表附 budget_money 与 monthly_cost。
func TestAdminDeptBudget(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

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
	hdr := func() map[string]string {
		return map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}
	}

	// 建部门
	w, out = doJSON(t, r, "POST", "/api/admin/departments", `{"name":"研发部"}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create dept: %d %s", w.Code, w.Body.String())
	}
	deptID := int64(out["department"].(map[string]any)["id"].(float64))

	// 员工挂部门 + 产生费用
	w, out = doJSON(t, r, "POST", "/api/admin/users", `{"username":"alice","password":"alicepw123","is_admin":false}`, hdr())
	if w.Code != http.StatusCreated {
		t.Fatalf("create user: %d %s", w.Code, w.Body.String())
	}
	uid := int64(out["user"].(map[string]any)["id"].(float64))
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/users/%d/department", uid), fmt.Sprintf(`{"group_id":%d}`, deptID), hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("assign dept: %d %s", w.Code, w.Body.String())
	}
	pid, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{Name: "prov-p", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	in, out2 := 2.0, 8.0
	if _, err := serverstore.AddModel(db, &serverstore.Model{Name: "priced-model", ProviderID: pid, InputPricePer1M: &in, OutputPricePer1M: &out2}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsage(db, uid, "priced-model", 1_000_000, 0); err != nil {
		t.Fatal(err)
	}

	// 设置预算 100
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/departments/%d", deptID), `{"name":"研发部","budget_money":100}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("set dept budget: %d %s", w.Code, w.Body.String())
	}

	// 列表附 budget_money 与 monthly_cost
	w, out = doJSON(t, r, "GET", "/api/admin/departments", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list depts: %d %s", w.Code, w.Body.String())
	}
	found := false
	for _, d := range out["departments"].([]any) {
		dm := d.(map[string]any)
		if dm["name"] == "研发部" {
			found = true
			if b := dm["budget_money"].(float64); b != 100 {
				t.Fatalf("budget_money = %v, want 100", b)
			}
			if mc := dm["monthly_cost"].(float64); mc != 2.0 {
				t.Fatalf("monthly_cost = %v, want 2.0", mc)
			}
		}
	}
	if !found {
		t.Fatal("研发部 missing from list")
	}

	// 负预算拒绝
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/departments/%d", deptID), `{"name":"研发部","budget_money":-5}`, hdr())
	if w.Code != http.StatusBadRequest {
		t.Fatalf("negative budget accepted: %d", w.Code)
	}

	// 清除预算(0)
	w, _ = doJSON(t, r, "PUT", fmt.Sprintf("/api/admin/departments/%d", deptID), `{"name":"研发部","budget_money":0}`, hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("clear budget: %d %s", w.Code, w.Body.String())
	}
	w, out = doJSON(t, r, "GET", "/api/admin/departments", "", hdr())
	if w.Code != http.StatusOK {
		t.Fatalf("list depts: %d", w.Code)
	}
	for _, d := range out["departments"].([]any) {
		dm := d.(map[string]any)
		if dm["name"] == "研发部" {
			if b, present := dm["budget_money"]; !present || b != nil {
				t.Fatalf("budget_money after clear = %v, want null", b)
			}
		}
	}
}

// auth 配置审计:mode 切换语义 + 密码掩码保持/清空 + 未启用模式字段清理。
func TestAdminAuthConfig(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()

	loginBody := `{"username":"boss","password":"pw123456"}`
	req := httptest.NewRequest("POST", "/api/admin/login", strings.NewReader(loginBody))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	csrf := out["csrf_token"].(string)
	sess := ""
	for _, ck := range w.Result().Cookies() {
		if ck.Name == sessionCookieName {
			sess = ck.Value
		}
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess, "X-CSRF-Token": csrf}

	// 1. 保存 ldap 模式(带密码)
	w, _ = doJSON(t, r, "PUT", "/api/admin/auth",
		`{"mode":"ldap","ldap":{"server_url":"ldap://x:389","bind_dn":"cn=admin","bind_password":"s3cret","base_dn":"dc=x","user_filter":"(uid=%s)"},"oidc":{}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("save ldap: %d %s", w.Code, w.Body.String())
	}
	get := func() map[string]any {
		_, o := doJSON(t, r, "GET", "/api/admin/auth", "", hdr)
		return o["auth"].(map[string]any)
	}
	a := get()
	if a["mode"].(string) != "ldap" {
		t.Fatalf("mode = %v", a["mode"])
	}
	ld := a["ldap"].(map[string]any)
	if ld["server_url"].(string) != "ldap://x:389" || ld["bind_password"].(string) != MaskSecret {
		t.Fatalf("ldap = %v (password must be masked)", ld)
	}

	// 2. 掩码回传 = 保持密码;改 base_dn 后密码不变
	w, _ = doJSON(t, r, "PUT", "/api/admin/auth",
		`{"mode":"ldap","ldap":{"server_url":"ldap://x:389","bind_dn":"cn=admin","bind_password":"***","base_dn":"dc=y"},"oidc":{}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("update ldap: %d", w.Code)
	}
	a = get()
	ld = a["ldap"].(map[string]any)
	if ld["base_dn"].(string) != "dc=y" || ld["bind_password"].(string) != MaskSecret {
		t.Fatalf("after masked update: base_dn=%v pw=%v", ld["base_dn"], ld["bind_password"])
	}

	// 3. 显式清空密码(空串覆盖)→ 回读无掩码(未配置)
	w, _ = doJSON(t, r, "PUT", "/api/admin/auth",
		`{"mode":"ldap","ldap":{"server_url":"ldap://x:389","bind_dn":"cn=admin","bind_password":"","base_dn":"dc=y"},"oidc":{}}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("clear ldap pw: %d", w.Code)
	}
	a = get()
	ld = a["ldap"].(map[string]any)
	if ld["bind_password"].(string) != "" {
		t.Fatalf("bind_password should be cleared, got %q", ld["bind_password"])
	}

	// 4. 切回 local → ldap/oidc 全部清空
	w, _ = doJSON(t, r, "PUT", "/api/admin/auth", `{"mode":"local"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("switch local: %d", w.Code)
	}
	a = get()
	if a["mode"].(string) != "local" {
		t.Fatalf("mode = %v", a["mode"])
	}
	ld = a["ldap"].(map[string]any)
	od := a["oidc"].(map[string]any)
	if ld["server_url"].(string) != "" || ld["bind_password"].(string) != "" || od["issuer"].(string) != "" {
		t.Fatalf("ldap/oidc should be cleared after local: ldap=%v oidc=%v", ld, od)
	}

	// 5. 非法 mode 拒绝
	w, _ = doJSON(t, r, "PUT", "/api/admin/auth", `{"mode":"nonsense"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("invalid mode = %d, want 400", w.Code)
	}
}
