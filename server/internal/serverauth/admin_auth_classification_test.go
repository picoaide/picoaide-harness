package serverauth

// 第二十二轮复审 V2-B2（P2）的判据：管理面 `AdminAuth` 必须把
// **会话被拒**（⇒ 401 AUTH_FAILED）与**依赖不可用**（⇒ 500 INTERNAL）分开。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前 `adminAuth` 是"`ValidateAdminSession` 的任何 error ⇒ 401"：
//
//	u, err := ValidateAdminSession(a.DB, cookie)
//	if err != nil { 401 AUTH_FAILED }
//
// 而 `ValidateAdminSession` 把 `GetAdminSession` / `GetUserByID` **和滑动窗口
// `UPDATE admin_sessions …`** 的原始 error 一律上抛 ⇒ 管理员已登录期间一次 PG
// 抖动（缺表 / 缺列 / 驱动故障 / 连接被拒）在 webadmin 表现为「你没登录」：
// `src/api.ts` 对**任何** 401 调 `unauthorizedHandler`，控制台原地切到未登录态。
// 这正是同包 `BearerAuth` 的缺陷本体（A2-01），本轮修复与判据都只覆盖了员工面。
//
// ## 修后契约（逐形态）
//
//	无 cookie / 会话不存在 / 已过期 / 空闲超时 / 会话被吊销（行被删）  ⇒ 401 AUTH_FAILED（语义不变）
//	用户被停用 / 用户已无管理权限（降为 user）                        ⇒ 401 AUTH_FAILED（语义不变）
//	admin_sessions 缺表 / users 缺表 / 缺列 / 假驱动 / 连接被拒        ⇒ **500 INTERNAL**（**不是** 401）
//	PG 只读（SELECT 照常、UPDATE 落空）                              ⇒ 200（滑动窗口是尽力而为的簿记）
//
// ## 变异（必须变红）
//
//   - `adminAuth` 退回"任何 error ⇒ 401" ⇒ 全部 500 用例红；
//   - `ValidateAdminSession` 把驱动错误也包装成 `ErrAuthRejected` ⇒ 500 用例红；
//   - `ValidateAdminSession` 丢掉拒绝分支的包装（返回裸 error）⇒ 401 用例红；
//   - 滑动窗口 UPDATE 的失败重新变成 `return nil, err` ⇒ 只读写用例红。

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

// ---------------------------------------------------------------------------
// 夹具：一个"管理会话 + 超级管理员"，以及打管理中间件的探针路由。
// ---------------------------------------------------------------------------

func adminProbe(t *testing.T, db *sql.DB, username string) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	uid, err := serverstore.CreateUserWithPassword(db, username, "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET role='super_admin', is_admin=1 WHERE id=?`, uid); err != nil {
		t.Fatal(err)
	}
	sess, _, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/probe", AdminAuth(db), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	return r, sess.ID
}

func adminCall(r *gin.Engine, cookie string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookie})
	}
	r.ServeHTTP(w, req)
	return w
}

// TestAdminAuthRejectionsStayUnauthorized 是**负向**判据：真正的拒绝路径一步都不能放宽。
func TestAdminAuthRejectionsStayUnauthorized(t *testing.T) {
	db := mustDB(t)

	// ① 没有 cookie ⇒ 401 AUTH_REQUIRED。
	r0, cookie := adminProbe(t, db, "v2b2a0")
	if w := adminCall(r0, ""); w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "AUTH_REQUIRED") {
		t.Fatalf("无 cookie ⇒ %d %s, want 401 AUTH_REQUIRED", w.Code, w.Body.String())
	}
	// ② 基线：会话有效 ⇒ 200（自校准：不然"401 用例红"与"夹具坏了"分不开）。
	if w := adminCall(r0, cookie); w.Code != http.StatusOK {
		t.Fatalf("有效会话 ⇒ %d %s, want 200（夹具不成立）", w.Code, w.Body.String())
	}
	// ③ 会话不存在（随机 cookie）⇒ 401 AUTH_FAILED。
	if w := adminCall(r0, "no-such-admin-session"); w.Code != http.StatusUnauthorized ||
		!strings.Contains(w.Body.String(), "AUTH_FAILED") {
		t.Fatalf("不存在的会话 ⇒ %d %s, want 401 AUTH_FAILED", w.Code, w.Body.String())
	}

	// ④ 已过期（硬 TTL）。
	r1, c1 := adminProbe(t, db, "v2b2a1")
	if _, err := db.Exec(`UPDATE admin_sessions SET expires_at = ? WHERE secret_hash = ?`,
		time.Now().Add(-time.Hour).UTC().Format(time.RFC3339), sessionSecretHash(c1)); err != nil {
		t.Fatal(err)
	}
	if w := adminCall(r1, c1); w.Code != http.StatusUnauthorized {
		t.Fatalf("已过期会话 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}

	// ⑤ 空闲超时。
	r2, c2 := adminProbe(t, db, "v2b2a2")
	if _, err := db.Exec(`UPDATE admin_sessions SET last_used_at = ? WHERE secret_hash = ?`,
		time.Now().Add(-2*AdminIdleTimeout).UTC().Format(time.RFC3339), sessionSecretHash(c2)); err != nil {
		t.Fatal(err)
	}
	if w := adminCall(r2, c2); w.Code != http.StatusUnauthorized {
		t.Fatalf("空闲超时会话 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}

	// ⑥ 吊销 = 会话行被删（`RevokeAllUserSessions` 的形态）。
	r3, c3 := adminProbe(t, db, "v2b2a3")
	if err := DeleteAdminSession(db, c3); err != nil {
		t.Fatal(err)
	}
	if w := adminCall(r3, c3); w.Code != http.StatusUnauthorized {
		t.Fatalf("被吊销会话 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}

	// ⑦ 用户被停用。
	r4, c4 := adminProbe(t, db, "v2b2a4")
	if _, err := db.Exec(`UPDATE users SET status = 0 WHERE id = (SELECT user_id FROM admin_sessions WHERE secret_hash = ?)`,
		sessionSecretHash(c4)); err != nil {
		t.Fatal(err)
	}
	if w := adminCall(r4, c4); w.Code != http.StatusUnauthorized {
		t.Fatalf("账号停用 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}

	// ⑧ 用户已无管理权限（降为 user）—— 会话本身有效，但这不是可用的管理会话。
	r5, c5 := adminProbe(t, db, "v2b2a5")
	if _, err := db.Exec(`UPDATE users SET role = 'user', is_admin = 0 WHERE id = (SELECT user_id FROM admin_sessions WHERE secret_hash = ?)`,
		sessionSecretHash(c5)); err != nil {
		t.Fatal(err)
	}
	if w := adminCall(r5, c5); w.Code != http.StatusUnauthorized {
		t.Fatalf("用户无管理权限 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}
}

// TestAdminAuthDependencyFailuresReturn500 是核心判据：管理面的**依赖故障** ⇒ 500，
// 且**不是** 401（401 会让 webadmin 原地切到未登录态）。
func TestAdminAuthDependencyFailuresReturn500(t *testing.T) {
	db := mustDB(t)
	r, cookie := adminProbe(t, db, "v2b2dep")

	// 前置自校准：夹具会话在依赖正常时确实是 200。
	if w := adminCall(r, cookie); w.Code != http.StatusOK {
		t.Fatalf("基线 ⇒ %d %s, want 200（夹具不成立）", w.Code, w.Body.String())
	}

	check := func(label string) {
		t.Helper()
		w := adminCall(r, cookie)
		body := strings.TrimSpace(w.Body.String())
		t.Logf("FORM %-28s => %d %s", label, w.Code, body)
		if w.Code == http.StatusUnauthorized {
			t.Fatalf("%s：管理面依赖故障被回成 401（%s）—— webadmin 的 src/api.ts 对任何 401 都调 "+
				"unauthorizedHandler ⇒ 一次 PG 抖动（重启 / 迁移半途缺表 / 连接池耗尽）就把控制台"+
				"原地切成未登录态（把「服务端不可用」显示成「你没登录」）", label, body)
		}
		if w.Code != http.StatusInternalServerError || !strings.Contains(body, `"code":"INTERNAL"`) {
			t.Fatalf("%s：依赖故障 ⇒ %d %s, want 500 INTERNAL", label, w.Code, body)
		}
	}

	// ① admin_sessions 缺表（迁移期 / 半途）。
	if _, err := db.Exec(`ALTER TABLE admin_sessions RENAME TO admin_sessions_v2b2`); err != nil {
		t.Fatal(err)
	}
	check("admin_sessions missing")
	if _, err := db.Exec(`ALTER TABLE admin_sessions_v2b2 RENAME TO admin_sessions`); err != nil {
		t.Fatal(err)
	}

	// ② users 缺表（会话行读得到、用户查询失败）。
	if _, err := db.Exec(`ALTER TABLE users RENAME TO users_v2b2`); err != nil {
		t.Fatal(err)
	}
	check("users missing")
	if _, err := db.Exec(`ALTER TABLE users_v2b2 RENAME TO users`); err != nil {
		t.Fatal(err)
	}

	// ③ 缺列（迁移半途：会话表少一列）。
	if _, err := db.Exec(`ALTER TABLE admin_sessions DROP COLUMN csrf_key`); err != nil {
		t.Fatal(err)
	}
	check("admin_sessions column dropped")
	if _, err := db.Exec(`ALTER TABLE admin_sessions ADD COLUMN csrf_key TEXT NOT NULL DEFAULT ''`); err != nil {
		t.Fatal(err)
	}
}

// TestAdminAuthFakeDriverAndConnRefused 是与真 PG 互为独立证据的两条依赖故障形态。
func TestAdminAuthFakeDriverAndConnRefused(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// ① 假驱动：驱动错误（连接池耗尽 / 存储不可用）。
	fake, err := sql.Open("a2fail", "")
	if err != nil {
		t.Fatalf("open fake db: %v", err)
	}
	defer fake.Close()
	r := gin.New()
	r.GET("/probe", AdminAuth(fake), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	w := adminCall(r, "any-cookie")
	t.Logf("FORM %-28s => %d %s", "fake driver", w.Code, strings.TrimSpace(w.Body.String()))
	if w.Code != http.StatusInternalServerError || !strings.Contains(w.Body.String(), `"code":"INTERNAL"`) {
		t.Fatalf("假驱动（存储不可用）⇒ %d %s, want 500 INTERNAL", w.Code, w.Body.String())
	}

	// ② 连接被拒（PG 没监听）：端口 1 上什么都没有。
	refused, err := sql.Open("pgx", "postgres://postgres:postgres@127.0.0.1:1/none?sslmode=disable&connect_timeout=2")
	if err != nil {
		t.Fatalf("open refused dsn: %v", err)
	}
	defer refused.Close()
	r2 := gin.New()
	r2.GET("/probe", AdminAuth(refused), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	w2 := adminCall(r2, "any-cookie")
	t.Logf("FORM %-28s => %d %s", "PG connect refused", w2.Code, strings.TrimSpace(w2.Body.String()))
	if w2.Code != http.StatusInternalServerError || !strings.Contains(w2.Body.String(), `"code":"INTERNAL"`) {
		t.Fatalf("连接被拒 ⇒ %d %s, want 500 INTERNAL", w2.Code, w2.Body.String())
	}
}

// TestAdminAuthReadOnlyPGStillServes 是**自校准**形态：PG 只读（SELECT 照常、
// UPDATE 落空）时管理面读取仍然 200。
//
// 为什么必须是 200 而不是 500：滑动窗口的 `UPDATE admin_sessions SET last_used_at`
// 是**尽力而为的簿记**，与员工侧 `VerifyToken` 的 `TouchTokenLastUsed` 同口径
// （那里也是忽略错误，所以 `BearerAuth` 在只读 PG 上照常 200 —— 见
// `auth_classification_test.go` 的同类自校准）。把它当依赖故障回 500 会让只读副本 /
// 写路径抖动期间**管理员连读取都做不到**，比"空闲窗口不前进"严重得多。
func TestAdminAuthReadOnlyPGStillServes(t *testing.T) {
	db := mustDB(t)
	r, cookie := adminProbe(t, db, "v2b2dep")

	var dbName string
	if err := db.QueryRow(`SELECT current_database()`).Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	// 只读设成**库级**默认值：只影响之后新建的连接，所以要把空闲连接放掉。
	if _, err := db.Exec(`ALTER DATABASE ` + dbName + ` SET default_transaction_read_only = on`); err != nil {
		t.Fatalf("设置只读: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`ALTER DATABASE ` + dbName + ` SET default_transaction_read_only = off`) })
	db.SetMaxIdleConns(0) // 连接归还即关闭 ⇒ 下一次查询必然新建（吃库级只读默认值）
	// 自校准：确认这次真的落在只读连接上（SELECT 照常、写被拒）。
	var ro string
	if err := db.QueryRow(`SHOW default_transaction_read_only`).Scan(&ro); err != nil {
		t.Fatalf("读只读标记: %v", err)
	}
	if ro != "on" {
		t.Skipf("本环境没能把连接切到只读（default_transaction_read_only=%q）—— 该形态不成立，不做断言", ro)
	}
	if _, werr := db.Exec(`UPDATE admin_sessions SET last_used_at = last_used_at`); werr == nil {
		t.Skip("只读连接上 UPDATE 竟然成功 —— 形态不成立（PG 语义变化？），不做断言")
	} else {
		t.Logf("自校准：只读连接上 UPDATE 被拒（%v）", werr)
	}

	w := adminCall(r, cookie)
	body := strings.TrimSpace(w.Body.String())
	t.Logf("FORM %-28s => %d %s", "PG read-only (SELECT ok)", w.Code, body)
	if w.Code != http.StatusOK {
		t.Fatalf("只读 PG 上的管理面读取 ⇒ %d %s, want 200 —— 滑动窗口 UPDATE 是尽力而为的簿记，"+
			"不该让管理员连读取都做不到", w.Code, body)
	}
}
