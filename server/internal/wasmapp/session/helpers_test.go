package session

// ---- 变异验证（把闸门改回危险实现时，哪些用例必红）----
//
//   - sanitizeNext 去掉 `//`/`:`/`\` 判定（或只校验原串不解码）
//     → TestSanitizeNextOpenRedirectTable 红
//   - checkMainOrigin 改成"没有 Origin 就放行"
//     → TestTicketSubmitRejectsForeignOrigin / TestLoginSubmitRejectsForeignOrigin 红
//   - secureRequest 改成恒 true（或 Cookie 的 Secure 去掉）
//     → TestLoginRefusesNonHTTPS / TestRedeemRefusesNonHTTPS / TestCookieAttributes 红
//   - ticketStore.consume 改成"先返回再删"（非 CAS）
//     → TestConcurrentRedeemOnlyOneWins 红
//   - ticketStore.consume 去掉 appID 比对（或匹配失败也消费）
//     → TestCrossAppTicketRejected 红
//   - revokeEmployeeSession 去掉 app_sessions 的 DELETE
//     → TestLogoutInvalidatesAppSessionsImmediately 红
//   - resolveAppSession 去掉 `s.app_id = ?` / `e.revoked_at IS NULL`
//     → TestAppSessionBoundToSubdomain / TestLogoutInvalidatesAppSessionsImmediately 红
//   - 会话落库改成存明文（hashSecret 恒等）
//     → TestEmployeeSessionStoredHashedOnly 红
//   - 登录页改回模块级冻结语言（包级常量接受语言）
//     → TestLoginPageLocalePerRequest 红
//   - 换票页 GET 顺手签发 Cookie / 发 code
//     → TestTicketPageRendersFormOnly 红
//   - TicketSubmit 去掉 `m.appIDValidExternal(appID)` 判定（或 sanitizeAppID 改回
//     旧的"小写 + 去空白 + 去尾点"宽容归一化）
//     → TestTicketSubmitRejectsMalformedApp / TestTicketPageSharesAppIDRulesWithSubmit 红
//   - TicketSubmit 去掉 `!m.secureRequest(r)` 分支
//     → TestTicketSubmitRefusesNonHTTPS 红
//   - mainOrigin 改回"只小写 + 去尾斜杠"（不规范化默认端口）
//     → TestMainOriginNormalizedAgainstRequest 红

import (
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 测试用的占位域名（本仓公开，禁止真实域名）。
const (
	testBaseDomain = "apps.example.com"
	testMainHost   = "harness.example.com"
	testMainOrigin = "https://harness.example.com"
	testPassword   = "Test-Password-2026"
)

// auditRec 记录 Audit 回调（异步调用，故用互斥量 + 轮询等待）。
type auditRec struct {
	mu      sync.Mutex
	entries []string
}

func (a *auditRec) fn(username, action, detail string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.entries = append(a.entries, username+"|"+action+"|"+detail)
}

// has 报告是否出现过某个动作。
func (a *auditRec) has(action string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, e := range a.entries {
		if strings.HasPrefix(strings.SplitN(e, "|", 3)[1], action) {
			return true
		}
	}
	return false
}

// detailOf 返回第一个匹配动作的 detail（没有则空串）。
func (a *auditRec) detailOf(action string) string {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, e := range a.entries {
		parts := strings.SplitN(e, "|", 3)
		if len(parts) == 3 && parts[1] == action {
			return parts[2]
		}
	}
	return ""
}

// waitFor 轮询等待某个动作出现（审计是异步 fire-and-forget）。
func (a *auditRec) waitFor(t *testing.T, action string) string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if a.has(action) {
			return a.detailOf(action)
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("审计回调未在超时内出现动作 %q；已记录：%v", action, a.entries)
	return ""
}

// testEnv 是一次测试的完整环境（真 PG + 真 serverauth provider 链）。
type testEnv struct {
	mgr   *Manager
	db    *sql.DB
	audit *auditRec
	auth  *serverauth.API

	clockMu sync.Mutex
	clock   time.Time
}

// now 返回注入的时钟（测试可推进以验证 60 s / 8 h 过期）。
func (e *testEnv) now() time.Time {
	e.clockMu.Lock()
	defer e.clockMu.Unlock()
	return e.clock
}

// advance 推进注入时钟。
func (e *testEnv) advance(d time.Duration) {
	e.clockMu.Lock()
	defer e.clockMu.Unlock()
	e.clock = e.clock.Add(d)
}

// newEnv 建一个真库用例环境（无 PG 时 serverstore.NewTestDB 自动 Skip）。
func newEnv(t *testing.T, mutate ...func(*Options)) *testEnv {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 真 provider 链：本用例走 serverauth.AuthenticatePassword（导出包装），
	// 与客户端面同一套 local/LDAP 顺序 —— 不是 mock。
	api := serverauth.New(db)
	if err := api.ReloadProviders(db); err != nil {
		t.Fatalf("ReloadProviders: %v", err)
	}

	env := &testEnv{
		db:    db,
		audit: &auditRec{},
		auth:  api,
		clock: time.Date(2026, 9, 17, 10, 0, 0, 0, time.UTC),
	}
	opt := Options{
		DB:         db,
		BaseDomain: testBaseDomain,
		MainOrigin: testMainOrigin,
		Auth: func(username, password string) (string, int64, error) {
			ui, err := api.AuthenticatePassword(username, password)
			if err != nil {
				return "", 0, err
			}
			// 返回 0 ⇒ 由 session 层按用户名解析 users 行（与 main.go 的装配一致）。
			return ui.Username, 0, nil
		},
		Audit: env.audit.fn,
		Now:   env.now,
	}
	for _, fn := range mutate {
		fn(&opt)
	}
	env.mgr = New(opt)
	return env
}

// newUser 建一个真账号并返回其 id。
func (e *testEnv) newUser(t *testing.T, username string) int64 {
	t.Helper()
	id, err := serverstore.CreateUserWithPassword(e.db, username, testPassword)
	if err != nil {
		t.Fatalf("create user %s: %v", username, err)
	}
	return id
}

// setRole 直接改角色（测试用；无导出入口的业务字段）。
func (e *testEnv) setRole(t *testing.T, username, role string) {
	t.Helper()
	if _, err := e.db.Exec(`UPDATE users SET role = ? WHERE username = ?`, role, username); err != nil {
		t.Fatalf("set role: %v", err)
	}
}

// newApp 建一个 wasm 应用行（归属 owner）。
func (e *testEnv) newApp(t *testing.T, appID, owner string) {
	t.Helper()
	if err := serverstore.UpsertWasmApp(t.Context(), e.db, serverstore.WasmApp{
		AppID: appID, Title: appID, Owner: owner, Channel: serverstore.AppChannelWasm, Enabled: true,
	}); err != nil {
		t.Fatalf("upsert app %s: %v", appID, err)
	}
}

// --- HTTP 辅助 ---

// httpsReq 构造一个 https 请求（httptest 对 https:// 目标会挂 dummy TLS，
// 因此 edge.SelfOrigin 会判成 https，与生产反代终止 TLS 的形态一致）。
func httpsReq(method, target string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, target, body)
	if body != nil {
		r.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	return r
}

// formReq 构造一个同源表单 POST。
func formReq(t *testing.T, path string, form url.Values) *http.Request {
	t.Helper()
	r := httpsReq(http.MethodPost, testMainOrigin+path, strings.NewReader(form.Encode()))
	r.Header.Set("Origin", testMainOrigin)
	return r
}

// loginAs 走完整登录流程并返回员工会话 Cookie 与身份。
func (e *testEnv) loginAs(t *testing.T, username string) (*http.Cookie, *Employee) {
	t.Helper()
	e.newUserIfMissing(t, username)
	rec := httptest.NewRecorder()
	e.mgr.LoginSubmit(rec, formReq(t, "/login", url.Values{
		"username": {username}, "password": {testPassword}, "next": {"/"},
	}))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("登录状态码 = %d, want 303；body=%s", rec.Code, rec.Body.String())
	}
	c := cookieByName(rec.Result().Cookies(), EmployeeCookieName)
	if c == nil {
		t.Fatal("登录成功但没有下发员工会话 Cookie")
	}
	r := httpsReq(http.MethodGet, testMainOrigin+"/login", nil)
	r.AddCookie(c)
	emp, ok := e.mgr.CurrentEmployee(r)
	if !ok {
		t.Fatal("CurrentEmployee 解析失败")
	}
	return c, emp
}

// newUserIfMissing 建账号（幂等，便于同一用例多次登录取不同会话）。
func (e *testEnv) newUserIfMissing(t *testing.T, username string) int64 {
	t.Helper()
	if u, err := serverstore.GetUserByUsername(e.db, username); err == nil {
		return u.ID
	}
	return e.newUser(t, username)
}

// cookieByName 从响应里取指定 Cookie。
func cookieByName(cs []*http.Cookie, name string) *http.Cookie {
	for _, c := range cs {
		if c.Name == name {
			return c
		}
	}
	return nil
}

// requestWithTicket 构造应用子域上的兑换请求。
func requestWithTicket(appID, ticket string) *http.Request {
	return httpsReq(http.MethodGet, "https://"+appID+"."+testBaseDomain+"/?ticket="+url.QueryEscape(ticket), nil)
}

// reqWithCookie 构造一个带 Cookie 的 https 请求（主站或应用子域皆可，
// 本包只按 Cookie 值解析，不看请求主机）。
func reqWithCookie(c *http.Cookie) *http.Request {
	r := httpsReq(http.MethodGet, testMainOrigin+"/", nil)
	if c != nil {
		r.AddCookie(c)
	}
	return r
}

// countRows 跑一个 count 查询（用 ? 占位，与全仓口径一致）。
func countRows(t *testing.T, env *testEnv, query string) int {
	t.Helper()
	var n int
	if err := env.db.QueryRow(query).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return n
}

// setStatus 直接改账号启用状态（测试用）。
func setStatus(t *testing.T, env *testEnv, username string, status int) {
	t.Helper()
	if _, err := env.db.Exec(`UPDATE users SET status = ? WHERE username = ?`, status, username); err != nil {
		t.Fatalf("set status: %v", err)
	}
}

// userID 取账号的 users.id。
func (e *testEnv) userID(t *testing.T, username string) int64 {
	t.Helper()
	u, err := serverstore.GetUserByUsername(e.db, username)
	if err != nil {
		t.Fatalf("get user %s: %v", username, err)
	}
	return u.ID
}

// appSessionTTLPlus 返回"明确超过 AppSessionTTL"的推进量（用 limits 真值，
// 不硬编码 8h —— 改 TTL 时这里自动跟随）。
func appSessionTTLPlus() time.Duration { return limits.AppSessionTTL + time.Minute }

// runBearerAuth 用**真的** serverauth.BearerAuth 中间件跑一次请求，
// 返回业务 handler 是否被触达（false = 中间件拒绝了）。
func runBearerAuth(t *testing.T, api *serverauth.API, w http.ResponseWriter, r *http.Request) bool {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	reached := false
	engine.GET("/api/client/v2/auth/me", serverauth.BearerAuth(api.DB), func(c *gin.Context) {
		reached = true
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	engine.ServeHTTP(w, r)
	return reached
}

// errorCode 取统一错误信封里的 code（§0.4.1 契约）。
func errorCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var envelope struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("错误信封不是 JSON: %v (%s)", err, w.Body.String())
	}
	return envelope.Error.Code
}

// issueTicketViaPOST 走完 POST /app-ticket 并解析出 code。
func (e *testEnv) issueTicketViaPOST(t *testing.T, empCookie *http.Cookie, appID, next string) string {
	t.Helper()
	r := formReq(t, "/app-ticket", url.Values{"app": {appID}, "next": {next}})
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	e.mgr.TicketSubmit(rec, r)
	if rec.Code != http.StatusFound {
		t.Fatalf("换票状态码 = %d, want 302；body=%s", rec.Code, rec.Body.String())
	}
	loc := rec.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("Location 解析失败 %q: %v", loc, err)
	}
	if u.Host != appID+"."+testBaseDomain {
		t.Fatalf("回跳主机 = %q, want %q", u.Host, appID+"."+testBaseDomain)
	}
	code := u.Query().Get("ticket")
	if code == "" {
		t.Fatalf("回跳 URL 不含 ticket: %q", loc)
	}
	return code
}
