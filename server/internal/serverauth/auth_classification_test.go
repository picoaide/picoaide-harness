package serverauth

// A2-01（审计 2026-09-26，P2）的判据：**"令牌被拒"与"依赖不可用"必须分类**。
//
// ## 缺陷形态（判据要杀的东西）
//
// `BearerAuth` 把 `VerifyToken` 的**任何** error 都回 401 `AUTH_FAILED`，而客户端
// （`packages/host/enterprise/src/server-connector/auth.ts`）把任何 401 读作
// `auth_expired` ⇒ `ctx.picoSession.clear()` ⇒ **删掉磁盘上的令牌**
// （`$DSH_HOME/session.json`，`session-service.ts` 的 `clear()` 里 `unlinkSync`）。
// 也就是说：一次 PG 抖动（重启 / 连接池耗尽 / 语句超时 / 卷切换）= **全体在线员工
// 被登出**，LDAP/OIDC 用户还要重走 IdP。三个技能面（组织 / 市场 / 能力中心聚合）的
// `viewer()` 同形：`UserEffectiveGroups` 失败 ⇒ 401 `AUTH_REQUIRED`。
//
// 修后契约（客户端那一半由 FIX-1 泳道对拍，这里钉服务端两半）：
//
//	令牌不存在 / 已吊销 / 已过期 / 用户不存在 / 用户被停用 ⇒ 401 AUTH_FAILED（语义不变）
//	存储 / 依赖不可用（驱动错误、连接失败、超时）        ⇒ **500 INTERNAL**（**不是** 401）
//	组查询失败（资源面 viewer）                          ⇒ **500 INTERNAL**（**不是** 401）
//
// ## 变异（必须变红）
//
//   - `BearerAuth` 退回"任何 error 都 401" ⇒ 依赖故障那条用例红；
//   - `VerifyToken` 把存储错误也包装成 `ErrAuthRejected` ⇒ 同上红；
//   - `WriteViewerError` 对 `err != nil` 回 401 ⇒ 组查询那条用例红。

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 假驱动：让每一次查询都返回**驱动错误**（不是 `sql.ErrNoRows`）。
//
// 这正是生产里"PG 不可用 / 连接池耗尽 / 语句超时 / 卷切换"在同一段代码上的形态：
// `GetTokenByHash` 拿到的 err 满足 `err != nil && !errors.Is(err, ErrNotFound)`。
// ---------------------------------------------------------------------------

type a2FailDriver struct{}

func (a2FailDriver) Open(string) (driver.Conn, error) { return a2FailConn{}, nil }

type a2FailConn struct{}

func (a2FailConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("a2fail: prepare unavailable (storage down)")
}
func (a2FailConn) Close() error              { return nil }
func (a2FailConn) Begin() (driver.Tx, error) { return nil, errors.New("a2fail: begin unavailable") }

// QueryContext 的签名必须与 driver.QueryerContext 完全一致，否则 database/sql
// 会退回到 Prepare（那样测到的就是"prepare 失败"而不是"查询失败"）。
func (a2FailConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return nil, errors.New("a2fail: query unavailable (connection pool exhausted)")
}

func init() { sql.Register("a2fail", a2FailDriver{}) }

// TestStorageFailureIsNotUnauthorized 是核心判据：认证**存储故障** ⇒ 500，且**不是** 401。
func TestStorageFailureIsNotUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := sql.Open("a2fail", "")
	if err != nil {
		t.Fatalf("open fake db: %v", err)
	}
	defer db.Close()

	// 前置：确实拿到了"依赖故障"（不是 ErrNotFound 这类**判定**结果）。
	_, verr := VerifyToken(db, "storage-down-probe")
	if verr == nil {
		t.Fatal("前置不成立：假驱动下 VerifyToken 竟然成功")
	}
	if IsAuthRejection(verr) {
		t.Fatalf("前置不成立：存储故障被分类成「凭证被拒」（err=%v）——"+
			"这正是 A2-01 的缺陷本体，本用例的其余断言会失去意义", verr)
	}
	t.Logf("依赖故障错误 = %v（IsAuthRejection=false）", verr)

	r := gin.New()
	r.GET("/probe", BearerAuth(db), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/probe", nil)
	req.Header.Set("Authorization", "Bearer storage-down-probe")
	r.ServeHTTP(w, req)

	body := strings.TrimSpace(w.Body.String())
	t.Logf("存储故障 ⇒ status=%d body=%s", w.Code, body)
	if w.Code == http.StatusUnauthorized {
		t.Fatalf("认证存储故障被回成 401（body=%s）—— 客户端把 401 读作 auth_expired ⇒ "+
			"清会话 + 删掉磁盘令牌（$DSH_HOME/session.json）⇒ 一次 PG 抖动让**全体在线员工**被登出。"+
			"依赖故障必须回 5xx 让客户端保留令牌重试", body)
	}
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("存储故障状态码 = %d, want 500（依赖不可用）", w.Code)
	}
	if !strings.Contains(body, `"code":"INTERNAL"`) {
		t.Fatalf("存储故障的错误码 = %s, want INTERNAL", body)
	}
}

// TestTokenRejectionsStayUnauthorized 是**负向**判据：真正的拒绝路径一步都不能放宽。
//
// 变异（必须变红）：把 `VerifyToken` 的任一拒绝分支改成返回裸 error（不包装
// `ErrAuthRejected`）⇒ 对应用例红。
func TestTokenRejectionsStayUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := mustDB(t)
	uid, err := serverstore.CreateUserWithPassword(db, "a2cla", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	r := gin.New()
	r.GET("/probe", BearerAuth(db), func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	call := func(tok string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/probe", nil)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		r.ServeHTTP(w, req)
		return w
	}

	// ① 令牌不存在（随机串）⇒ 401 AUTH_FAILED。
	if w := call("no-such-token-at-all"); w.Code != http.StatusUnauthorized ||
		!strings.Contains(w.Body.String(), "AUTH_FAILED") {
		t.Fatalf("不存在的令牌 ⇒ %d %s, want 401 AUTH_FAILED", w.Code, w.Body.String())
	}
	// ② 缺失头 ⇒ 401 AUTH_REQUIRED（语义不变）。
	if w := call(""); w.Code != http.StatusUnauthorized ||
		!strings.Contains(w.Body.String(), "AUTH_REQUIRED") {
		t.Fatalf("缺失令牌 ⇒ %d %s, want 401 AUTH_REQUIRED", w.Code, w.Body.String())
	}
	// ③ 已吊销 ⇒ 401。
	revoked, err := IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if err := RevokeToken(db, revoked); err != nil {
		t.Fatal(err)
	}
	if w := call(revoked); w.Code != http.StatusUnauthorized {
		t.Fatalf("已吊销令牌 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}
	// ④ 已过期 ⇒ 401。
	expired, err := IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE api_tokens SET expires_at = ? WHERE token_hash = ?`,
		time.Now().Add(-time.Hour).UTC(), serverstore.TokenHash(expired)); err != nil {
		t.Fatal(err)
	}
	if w := call(expired); w.Code != http.StatusUnauthorized {
		t.Fatalf("已过期令牌 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}
	// ⑤ 用户被停用 ⇒ 401（令牌本身有效，但账号已不可用；这是**判定**而不是依赖故障）。
	disabled, err := IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE users SET status = 0 WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}
	if w := call(disabled); w.Code != http.StatusUnauthorized {
		t.Fatalf("账号停用 ⇒ %d %s, want 401", w.Code, w.Body.String())
	}
}

// TestVerifyTokenClassifiesErrors 单元级：`IsAuthRejection` 是唯一分类实现。
func TestVerifyTokenClassifiesErrors(t *testing.T) {
	db := mustDB(t)
	uid, err := serverstore.CreateUserWithPassword(db, "a2clb", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyToken(db, "definitely-not-a-token"); !IsAuthRejection(err) {
		t.Fatalf("不存在的令牌必须被判为「凭证被拒」，实得 err=%v", err)
	}
	if _, err := VerifyToken(db, ""); !IsAuthRejection(err) {
		t.Fatalf("空令牌必须被判为「凭证被拒」，实得 err=%v", err)
	}
	tok, err := IssueToken(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyToken(db, tok); err != nil {
		t.Fatalf("有效令牌不该报错: %v", err)
	}
	if IsAuthRejection(nil) {
		t.Fatal("nil 不是「凭证被拒」")
	}
	// 依赖故障：用一个**查不到表**的真实 PG 连接（把表改名）—— 这是真实的驱动错误，
	// 与假驱动那一条互为独立证据。
	if _, err := db.Exec(`ALTER TABLE api_tokens RENAME TO api_tokens_a2probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}
	if _, err := VerifyToken(db, tok); err == nil {
		t.Fatal("表不存在时 VerifyToken 竟然成功")
	} else if IsAuthRejection(err) {
		t.Fatalf("真实驱动错误被分类成「凭证被拒」：%v", err)
	}
}

// TestViewerGroupFailureIsNotUnauthorized 钉住三个技能面共用的 viewer 出口：
// 组查询失败 ⇒ 500，不是 401。
//
// 三个面（sharedskills / marketplace / capabilities）在各包内另有**路由级**用例，
// 这里钉的是共用的分类实现本身（唯一真源），保证三处不会各写一份。
func TestViewerGroupFailureIsNotUnauthorized(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db := mustDB(t)
	uid, err := serverstore.CreateUserWithPassword(db, "a2clc", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	// 注入依赖故障：user_groups 是 UserEffectiveGroups 的第一条查询。
	if _, err := db.Exec(`ALTER TABLE user_groups RENAME TO user_groups_a2probe`); err != nil {
		t.Fatalf("注入依赖故障: %v", err)
	}

	r := gin.New()
	r.GET("/viewer", func(c *gin.Context) {
		c.Set(CtxUserKey, u)
		got, groups, verr := ViewerGroups(c, db)
		if WriteViewerError(c, got, verr) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"groups": groups})
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/viewer", nil))
	body := strings.TrimSpace(w.Body.String())
	t.Logf("组查询失败 ⇒ status=%d body=%s", w.Code, body)
	if w.Code == http.StatusUnauthorized {
		t.Fatalf("组查询依赖故障被回成 401（body=%s）—— 401 会让客户端清会话 + 删磁盘令牌", body)
	}
	if w.Code != http.StatusInternalServerError || !strings.Contains(body, `"code":"INTERNAL"`) {
		t.Fatalf("组查询失败 ⇒ %d %s, want 500 INTERNAL", w.Code, body)
	}

	// 未认证（无用户）⇒ 仍是 401 AUTH_REQUIRED（拒绝语义不放宽）。
	r2 := gin.New()
	r2.GET("/viewer", func(c *gin.Context) {
		got, groups, verr := ViewerGroups(c, db)
		if WriteViewerError(c, got, verr) {
			return
		}
		c.JSON(http.StatusOK, gin.H{"groups": groups})
	})
	w2 := httptest.NewRecorder()
	r2.ServeHTTP(w2, httptest.NewRequest(http.MethodGet, "/viewer", nil))
	if w2.Code != http.StatusUnauthorized || !strings.Contains(w2.Body.String(), "AUTH_REQUIRED") {
		t.Fatalf("未认证 ⇒ %d %s, want 401 AUTH_REQUIRED", w2.Code, w2.Body.String())
	}
}
