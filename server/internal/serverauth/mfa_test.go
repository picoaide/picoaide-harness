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
	"github.com/pquerna/otp/totp"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// ---- 0057 密码/MFA 全链路测试 ----

// genTOTPCode 生成当前时间步的动态码(测试用; 依赖与生产同一 pquerna/otp)。
func genTOTPCode(t *testing.T, secret string) string {
	t.Helper()
	code, err := totp.GenerateCode(secret, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return code
}

// ensureTestMasterKey 让 util.GetMasterKey 可用(main 里的 EnsureMasterKey 等价)。
func ensureTestMasterKey(t *testing.T) {
	t.Helper()
	if _, err := util.EnsureMasterKey(t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

// ---------------- 员工自助改密 ----------------

func TestEmployeeChangePassword(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "alice", "pw1234567890", false)
	tok := loginToken(t, r, "alice", "pw1234567890")

	// 旧密码错误 → 401
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"wrong","new_password":"abcd123456"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong old password: %d %s", w.Code, w.Body.String())
	}
	// 过短 → 400
	w, _ = doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"pw1234567890","new_password":"short"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("short password: %d %s", w.Code, w.Body.String())
	}
	// 新密码与原密码相同 → 400(强制改密不可绕过)
	w, _ = doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"pw1234567890","new_password":"pw1234567890"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("same password: %d %s", w.Code, w.Body.String())
	}
	// 成功
	w, _ = doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"pw1234567890","new_password":"abcd123456789"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusOK {
		t.Fatalf("change password: %d %s", w.Code, w.Body.String())
	}
	// 全部令牌吊销(含当前) → 旧 token 不能再访问 /me
	w, _ = doJSON(t, r, "GET", "/api/client/v2/auth/me", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("old token still valid: %d", w.Code)
	}
	// 新密码可登录
	loginToken(t, r, "alice", "abcd123456789")
	// 审计
	var n int
	_ = db.QueryRow("SELECT COUNT(*) FROM audit_logs WHERE action = 'password_change' AND username = 'alice'").Scan(&n)
	if n == 0 {
		t.Fatal("password_change audit missing")
	}
}

func TestEmployeeChangePasswordExternalRejected(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	// 直接插入 external 用户(模拟 LDAP/OIDC provision 后的行)
	id, err := serverstore.CreateUser(db, &serverstore.User{Username: "ext1", Source: "external", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	_ = id
	// external 用户无密码无法走本地登录; 用本地用户验证拒绝路径不具备代表性,
	// 改由直接构造: local 用户改 password_hash 后置 source=external。
	// external 用户经 LDAP/OIDC 认证持有 token(员工面登录不校验 source);
	// 直接铸 token 模拟该场景。
	u2, err := serverstore.GetUserByUsername(db, "ext1")
	if err != nil {
		t.Fatal(err)
	}
	tok, err := IssueToken(db, u2.ID)
	if err != nil {
		t.Fatal(err)
	}
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"pw1234567890","new_password":"abcd123456789"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusBadRequest {
		t.Fatalf("external must not change password: %d %s", w.Code, w.Body.String())
	}
}

func TestPasswordChangeGuardBlocksBusiness(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	ensureTestMasterKey(t)
	createUser(t, db, "bob", "pw1234567890", false)
	u, _ := serverstore.GetUserByUsername(db, "bob")
	hash, _ := util.HashPassword("pw1234567890")
	if err := serverstore.UpdateUserPassword(db, u.ID, hash, true); err != nil {
		t.Fatal(err)
	}
	// 受保护业务端点(模拟 bootstrap)+ 一个需要 Bearer 的对照组
	r.GET("/api/client/v2/config/bootstrap", BearerAuth(db), func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	tok := loginToken(t, r, "bob", "pw1234567890")
	// 守卫: bootstrap 403 PASSWORD_CHANGE_REQUIRED
	w, out := doJSON(t, r, "GET", "/api/client/v2/config/bootstrap", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusForbidden {
		t.Fatalf("bootstrap: %d %s", w.Code, w.Body.String())
	}
	if e, _ := out["error"].(map[string]any); e["code"] != "PASSWORD_CHANGE_REQUIRED" {
		t.Fatalf("error code: %v", out)
	}
	// 白名单: me 可访问
	w, _ = doJSON(t, r, "GET", "/api/client/v2/auth/me", "", map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusOK {
		t.Fatalf("me blocked: %d", w.Code)
	}
	// 完成强制改密后解锁
	w, _ = doJSON(t, r, "POST", "/api/client/v2/auth/password",
		`{"old_password":"pw1234567890","new_password":"newpass123456"}`, map[string]string{"Authorization": "Bearer " + tok})
	if w.Code != http.StatusOK {
		t.Fatalf("forced change: %d %s", w.Code, w.Body.String())
	}
	tok2 := loginToken(t, r, "bob", "newpass123456")
	w, _ = doJSON(t, r, "GET", "/api/client/v2/config/bootstrap", "", map[string]string{"Authorization": "Bearer " + tok2})
	if w.Code != http.StatusOK {
		t.Fatalf("bootstrap after change: %d", w.Code)
	}
}

// ---------------- 管理员改自己密码 ----------------

func TestAdminChangeOwnPassword(t *testing.T) {
	r, db := adminRouter(t)
	uid, _ := serverstore.GetUserByUsername(db, "boss")
	sess, csrf, err := CreateAdminSession(db, uid.ID)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}
	// 旧密码错
	w, _ := doAdmin(t, r, "POST", "/api/server/admin/me/password", `{"old_password":"nope","new_password":"abcd123456789"}`, hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("wrong old: %d %s", w.Code, w.Body.String())
	}
	// 成功
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/password", `{"old_password":"pw123456","new_password":"newadmin12345"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("change: %d %s", w.Code, w.Body.String())
	}
	// 当前会话已被吊销(全吊销语义) → 原会话访问 /me 401
	w, _ = doAdmin(t, r, "GET", "/api/server/admin/me", "", hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("session not revoked: %d %s", w.Code, w.Body.String())
	}
	// 新密码可重新登录
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"newadmin12345"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("relogin: %d %s", w.Code, w.Body.String())
	}
}

// ---------------- 管理员 MFA 全流程 ----------------

func adminSessionHeaders(t *testing.T, db *sql.DB, username string) (map[string]string, int64) {
	t.Helper()
	u, err := serverstore.GetUserByUsername(db, username)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	return map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}, u.ID
}

func TestMFALifecycle(t *testing.T) {
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	hdr, uid := adminSessionHeaders(t, db, "boss")

	// 未开启: 查询状态
	w, out := doAdmin(t, r, "GET", "/api/server/admin/me/mfa", "", hdr)
	if w.Code != http.StatusOK || out["enabled"] != false {
		t.Fatalf("mfa state: %d %v", w.Code, out)
	}
	// 开启: 主密码错误拒绝
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/enable", `{"password":"wrong"}`, hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("enable wrong password: %d", w.Code)
	}
	// 开启: 主密码正确 → secret + ticket
	w, out = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/enable", `{"password":"pw123456"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", w.Code, w.Body.String())
	}
	secret, _ := out["secret"].(string)
	ticket, _ := out["ticket"].(string)
	if secret == "" || ticket == "" {
		t.Fatalf("enable response: %v", out)
	}
	if _, ok := out["otpauth_url"].(string); !ok || strings.Index(out["otpauth_url"].(string), "otpauth://totp/") != 0 {
		t.Fatalf("otpauth_url: %v", out["otpauth_url"])
	}
	// verify: 错误码
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/verify", fmt.Sprintf(`{"ticket":%q,"code":"000000"}`, ticket), hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("verify wrong code: %d", w.Code)
	}
	// verify: 正确码
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/verify", fmt.Sprintf(`{"ticket":%q,"code":%q}`, ticket, genTOTPCode(t, secret)), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("verify: %d %s", w.Code, w.Body.String())
	}
	u, _ := serverstore.GetUserByID(db, uid)
	if !u.TotpEnabled || u.TotpSecret == "" {
		t.Fatalf("mfa not persisted: %+v", u)
	}
	// 重放同一 ticket → 失效
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/verify", fmt.Sprintf(`{"ticket":%q,"code":%q}`, ticket, genTOTPCode(t, secret)), hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("ticket replay: %d", w.Code)
	}
	// 两步登录: 密码正确不再直接发 session
	w, out = doAdmin(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK || out["mfa_required"] != true {
		t.Fatalf("login mfa_required: %d %v", w.Code, out)
	}
	mfaTicket, _ := out["mfa_ticket"].(string)
	// 错误码 → 401 且计数
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login/mfa", fmt.Sprintf(`{"mfa_ticket":%q,"code":"000000"}`, mfaTicket), nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("login/mfa wrong code: %d", w.Code)
	}
	// 正确码 → session cookie
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login/mfa", fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, mfaTicket, genTOTPCode(t, secret)), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login/mfa: %d %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), "picoaide_session=") {
		t.Fatalf("no session cookie: %v", w.Header())
	}
	// 重放 → 失效
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login/mfa", fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, mfaTicket, genTOTPCode(t, secret)), nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("login/mfa replay: %d", w.Code)
	}
	// 关闭: 主密码+动态码双验; 先给错密码
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/disable", fmt.Sprintf(`{"password":"wrong","code":%q}`, genTOTPCode(t, secret)), hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("disable wrong password: %d", w.Code)
	}
	// 正确关闭
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/mfa/disable", fmt.Sprintf(`{"password":"pw123456","code":%q}`, genTOTPCode(t, secret)), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("disable: %d %s", w.Code, w.Body.String())
	}
	u, _ = serverstore.GetUserByID(db, uid)
	if u.TotpEnabled || u.TotpSecret != "" {
		t.Fatalf("mfa not cleared: %+v", u)
	}
	// 关闭后再登录 → 一步会话
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("relogin after disable: %d %s", w.Code, w.Body.String())
	}
	if out2, _ := jsonm(w); out2["mfa_required"] == true {
		t.Fatal("mfa_required after disable")
	}
}

func jsonm(w *httptest.ResponseRecorder) (map[string]any, error) {
	var m map[string]any
	err := json.Unmarshal(w.Body.Bytes(), &m)
	return m, err
}

func TestMFAChallengeGuards(t *testing.T) {
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	// 不存在的 ticket
	w, _ := doAdmin(t, r, "POST", "/api/server/admin/login/mfa", `{"mfa_ticket":"nope","code":"123456"}`, nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unknown ticket: %d", w.Code)
	}
	// 启用流程 ticket 不能用于登录
	hdr, _ := adminSessionHeaders(t, db, "boss")
	w, out := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/enable", `{"password":"pw123456"}`, hdr)
	enableTicket, _ := out["ticket"].(string)
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login/mfa", fmt.Sprintf(`{"mfa_ticket":%q,"code":"123456"}`, enableTicket), nil)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("enable ticket reused for login: %d", w.Code)
	}
}

func TestResetUserMFAByAdmin(t *testing.T) {
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	// boss(超管) + 目标管理员 victim
	vid, err := createUserDB(db, "victim", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	// 给 victim 开 MFA(直接复制 boss 的启用流程太繁琐, 直接加密存库)
	secret, _, err := genTOTPSecret("victim")
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryptMFASecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetUserMFA(db, vid, cipher, true); err != nil {
		t.Fatal(err)
	}
	// victim 有自己的会话
	victimHdr, _ := adminSessionHeaders(t, db, "victim")
	bossHdr, bossID := adminSessionHeaders(t, db, "boss")
	_ = bossID

	// 不能重置自己
	w, _ := doAdmin(t, r, "PUT", fmt.Sprintf("/api/server/admin/users/%d/mfa", bossID), "", bossHdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("reset self: %d %s", w.Code, w.Body.String())
	}
	// 重置 victim → ok, 且其全部会话吊销
	w, _ = doAdmin(t, r, "PUT", fmt.Sprintf("/api/server/admin/users/%d/mfa", vid), "", bossHdr)
	if w.Code != http.StatusOK {
		t.Fatalf("reset victim: %d %s", w.Code, w.Body.String())
	}
	v, _ := serverstore.GetUserByID(db, vid)
	if v.TotpEnabled || v.TotpSecret != "" {
		t.Fatalf("victim mfa not cleared: %+v", v)
	}
	w, _ = doAdmin(t, r, "GET", "/api/server/admin/me", "", victimHdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("victim session not revoked: %d", w.Code)
	}
	// 不存在用户 → 404
	w, _ = doAdmin(t, r, "PUT", "/api/server/admin/users/999999/mfa", "", bossHdr)
	if w.Code != http.StatusNotFound {
		t.Fatalf("reset missing: %d", w.Code)
	}
}

func TestAdminMustChangeGuardBlocks(t *testing.T) {
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	// boss 置 must_change=1(模拟管理员重置密码后)
	u, _ := serverstore.GetUserByUsername(db, "boss")
	hash, _ := util.HashPassword("pw123456")
	if err := serverstore.UpdateUserPassword(db, u.ID, hash, true); err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}
	// 业务端点被拦
	w, out := doAdmin(t, r, "GET", "/api/server/admin/users", "", hdr)
	if w.Code != http.StatusForbidden {
		t.Fatalf("users should be blocked: %d", w.Code)
	}
	if e, _ := out["error"].(map[string]any); e["code"] != "PASSWORD_CHANGE_REQUIRED" {
		t.Fatalf("error code: %v", out)
	}
	// me 放行
	w, _ = doAdmin(t, r, "GET", "/api/server/admin/me", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("me blocked: %d", w.Code)
	}
	// 完成改密(改密后本会话也被吊销)
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/me/password", `{"old_password":"pw123456","new_password":"brandnew123"}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("forced change: %d %s", w.Code, w.Body.String())
	}
	w, _ = doAdmin(t, r, "GET", "/api/server/admin/me", "", hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("session should be revoked after forced change: %d", w.Code)
	}
}
