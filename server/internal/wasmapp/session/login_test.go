package session

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---- Referrer-Policy：same-origin 是功能正确性，不是风格（2026-09-19 P0）----

// TestPageReferrerPolicyIsSameOrigin 是**防回退门禁**：两个页面的 meta 与响应头
// 都必须是 same-origin，绝不能是 no-referrer。
//
// 为什么这条断言不能松：按 WHATWG Fetch 的 "append a request Origin header" 算法，
// referrer policy 为 no-referrer 时，**非 GET/HEAD 请求的 Origin 头被写成字面量
// `null`**（同源也一样）—— 登录页 POST /login、换票页自动提交 POST /app-ticket
// 都会带 `Origin: null`，而服务端判据是 `Origin == 自身源` ⇒ 必然 403
// ⇒ 员工浏览器登录入口 100% 不可用。
//
// 浏览器侧证据（真实 Chromium，三种策略对照，已落盘）：
// temp/wasm-probe/micro-referrer.mjs ⇒ no-referrer→`Origin: null`、
// same-origin→真实 Origin、strict-origin-when-cross-origin→真实 Origin。
// 服务端判定侧的行为回归见 TestLoginSubmitOriginMatrix。
//
// 变异验证：把 mainPageReferrerPolicy 改回 no-referrer ⇒ 本用例必红。
func TestPageReferrerPolicyIsSameOrigin(t *testing.T) {
	if mainPageReferrerPolicy != "same-origin" {
		t.Fatalf("mainPageReferrerPolicy = %q，必须是 same-origin", mainPageReferrerPolicy)
	}
	if mainPageReferrerPolicy == "no-referrer" {
		t.Fatal("策略退回 no-referrer：同源表单 POST 会带 Origin: null，登录与换票必然 403")
	}
	// 两个页面的三处下发面必须一致：HTML 里的 meta + writePage 的响应头。
	// （meta 与响应头取值不同时 meta 会覆盖头 —— 只改一处等于没改。）
	for _, tc := range []struct {
		name string
		html string
	}{
		{"登录页", loginHTML("zh", loginView{Title: "登录", ShowForm: true})},
		{"换票页", ticketHTML("zh", ticketView{Title: "正在打开应用", App: "my-app", Next: "/"})},
	} {
		if !strings.Contains(tc.html, `<meta name="referrer" content="same-origin">`) {
			t.Fatalf("%s 的 meta referrer 不是 same-origin：%s", tc.name, tc.html)
		}
		if strings.Contains(tc.html, "no-referrer") {
			t.Fatalf("%s 仍含 no-referrer 字样（登录/换票会 403）：%s", tc.name, tc.html)
		}
	}

	// 响应头（writePage 的落点）：登录页与换票页都要断言，避免只改一条路径。
	loginRec := httptest.NewRecorder()
	New(Options{ProductName: "示例产品"}).LoginPage(loginRec, httpsReq(http.MethodGet, testMainOrigin+"/login", nil))
	if got := loginRec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("登录页响应头 Referrer-Policy = %q, want same-origin", got)
	}
	ticketRec := httptest.NewRecorder()
	ticketMgr := New(Options{BaseDomain: func() string { return testBaseDomain }})
	ticketMgr.TicketPage(ticketRec, httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=my-app", nil))
	if got := ticketRec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("换票页响应头 Referrer-Policy = %q, want same-origin", got)
	}
}

// TestLoginSubmitOriginMatrix 是"策略 → 浏览器实际会发的头 → 服务端判定"的
// **行为回归**（比字符串断言更硬）：直接拿浏览器在不同策略下**真实会发**的头
// 打 POST /login，断言通行/拒绝与安全语义都不退化。
//
// 与 TestPageReferrerPolicyIsSameOrigin 一起构成闭环：
//   - 策略侧：页面必须 same-origin ⇒ 浏览器发真实 Origin（微实验已证）；
//   - 判定侧：真实 Origin 必须放行，而 `null` / 跨源仍然必须拒。
//
// 变异验证：checkMainOrigin 改成"Origin 为 null 也放行"⇒ 本用例红。
func TestLoginSubmitOriginMatrix(t *testing.T) {
	env := newEnv(t)
	env.newUser(t, "alice")

	cases := []struct {
		name    string
		origin  string
		referer string
		want    int
	}{
		{"同源 Origin（same-origin 策略下浏览器的真实形态）", testMainOrigin, "", http.StatusSeeOther},
		{"Origin: null（no-referrer 策略下浏览器的形态）", "null", "", http.StatusForbidden},
		{"跨源 Origin", "https://evil.example.com", "", http.StatusForbidden},
		{"Origin: null 不得靠 Referer 兜底", "null", testMainOrigin + "/login", http.StatusForbidden},
		{"无 Origin，Referer 同源（老浏览器兜底路径）", "", testMainOrigin + "/login?next=%2F", http.StatusSeeOther},
		{"无 Origin，Referer 跨源", "", "https://evil.example.com/login", http.StatusForbidden},
		{"Origin 与 Referer 都缺失", "", "", http.StatusForbidden},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httpsReq(http.MethodPost, testMainOrigin+"/login", strings.NewReader(url.Values{
				"username": {"alice"}, "password": {testPassword}, "next": {"/"},
			}.Encode()))
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				r.Header.Set("Referer", tc.referer)
			}
			rec := httptest.NewRecorder()
			env.mgr.LoginSubmit(rec, r)
			if rec.Code != tc.want {
				t.Fatalf("Origin=%q Referer=%q ⇒ %d, want %d（body=%s）",
					tc.origin, tc.referer, rec.Code, tc.want, rec.Body.String())
			}
			cookie := cookieByName(rec.Result().Cookies(), EmployeeCookieName)
			if tc.want == http.StatusSeeOther {
				if cookie == nil {
					t.Fatal("同源登录没有下发会话 Cookie")
				}
				return
			}
			if cookie != nil {
				t.Fatal("被拒的登录竟然签发了会话 Cookie")
			}
			if tc.want == http.StatusForbidden {
				// 403 页面必须**可重试**：旧实现 ShowForm=false，
				// 用户落到一个没有任何输入框的死页面（2026-09-19 P0 的用户可见面）。
				body := rec.Body.String()
				if !strings.Contains(body, `name="username"`) || !strings.Contains(body, `name="password"`) {
					t.Fatalf("来源校验失败页没有输入框（用户无从重试）：%s", body)
				}
				if !strings.Contains(body, copyZH.ErrOriginRejected) {
					t.Fatal("来源校验失败页没有可操作指引文案")
				}
			}
		})
	}
	// 恰好两次成功（同源 Origin、以及老浏览器的同源 Referer 兜底）⇒ 两行会话；
	// 被拒的 5 次绝不能落库。
	if n := countRows(t, env, "SELECT count(*) FROM employee_sessions"); n != 2 {
		t.Fatalf("employee_sessions 行数 = %d, want 2（被拒的 5 次不得落库）", n)
	}
}

// TestCheckMainOriginLogsRejectionContext 是"失败必须可定位"的门禁（2026-09-19）：
// 线上只看到 403 时，日志必须一条就能回答"期望源、浏览器发了什么、哪条判据没过"。
//
// 这条日志是 no-referrer ⇒ `Origin: null` 那个 P0 当时**缺失**的唯一证据面
// （旧实现只在"配置的 MainOrigin 与请求源不一致"时打日志，其余分支静默）。
func TestCheckMainOriginLogsRejectionContext(t *testing.T) {
	prev := logError
	defer func() { logError = prev }()
	var lines []string
	logError = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }

	m := New(Options{MainOrigin: testMainOrigin})
	r := httpsReq(http.MethodPost, testMainOrigin+"/login", nil)
	r.Header.Set("Origin", "null")
	r.Header.Set("Referer", testMainOrigin+"/login")
	r.Header.Set("X-Forwarded-Proto", "https")
	// 哨兵：Cookie 里的会话明文**绝不能**出现在日志里（凭证泄漏）。
	r.Header.Set("Cookie", EmployeeCookieName+"="+testPassword)

	if m.checkMainOrigin(r) {
		t.Fatal("Origin: null 必须被拒")
	}
	if len(lines) != 1 {
		t.Fatalf("一次拒绝应落且只落一条日志，得到 %d 条：%v", len(lines), lines)
	}
	line := lines[0]
	for _, want := range []string{
		"reason=origin_malformed",
		`want="` + testMainOrigin + `"`,
		`origin="null"`,
		`referer="` + testMainOrigin + `/login"`,
		`host="` + testMainHost + `"`,
		`x-forwarded-proto="https"`,
	} {
		if !strings.Contains(line, want) {
			t.Fatalf("日志缺少 %q：%s", want, line)
		}
	}
	if strings.Contains(line, testPassword) || strings.Contains(strings.ToLower(line), "cookie") {
		t.Fatalf("日志带上了 Cookie/敏感值（凭证泄漏）：%s", line)
	}

	// 放行时不得打日志（否则正常流量会把日志刷满）。
	lines = nil
	ok := httpsReq(http.MethodPost, testMainOrigin+"/login", nil)
	ok.Header.Set("Origin", testMainOrigin)
	if !m.checkMainOrigin(ok) {
		t.Fatal("同源 Origin 应放行")
	}
	if len(lines) != 0 {
		t.Fatalf("放行时打了日志：%v", lines)
	}
}

// TestPageCopyCoversBothLanguages 断言 pageCopy 的**每个字段**在中英两份里都非空。
//
// 用反射而不是手写清单：手写清单会随着新增字段漂移，而它要防的正是"新增文案只给了
// 一种语言"（另一种语言的页面上会渲染出一个空行/半句话）。
func TestPageCopyCoversBothLanguages(t *testing.T) {
	typ := reflect.TypeOf(pageCopy{})
	if typ.NumField() < 10 {
		t.Fatalf("pageCopy 只有 %d 个字段，远低于预期 —— 反射可能失效（假绿防线）", typ.NumField())
	}
	for _, tc := range []struct {
		lang string
		c    pageCopy
	}{{"zh", copyZH}, {"en", copyEN}} {
		v := reflect.ValueOf(tc.c)
		for i := 0; i < typ.NumField(); i++ {
			f := typ.Field(i)
			if f.Name == "Lang" {
				continue
			}
			if strings.TrimSpace(v.Field(i).String()) == "" {
				t.Fatalf("%s 文案缺字段 %s（两种语言必须都给）", tc.lang, f.Name)
			}
		}
	}
	if copyZH.Lang != "zh" || copyEN.Lang != "en" {
		t.Fatalf("Lang 标记错误：%q / %q", copyZH.Lang, copyEN.Lang)
	}
}

// ---- 登录页渲染 ----

// TestLoginPageHasNoExternalResources 断言登录页是自包含的注入式 HTML：
// 没有外链 CSS/JS/字体/图片，因此 `default-src 'none'` 的严格 CSP 可用。
func TestLoginPageHasNoExternalResources(t *testing.T) {
	html := loginHTML("zh", loginView{Title: "登录", Next: "/", ShowForm: true})
	if strings.Contains(html, "http") {
		t.Fatal("登录页出现了 http/https 字样（外链资源会破坏 default-src 'none'）")
	}
	for _, bad := range []string{"<link", "src=", "@import", "url(", "<iframe"} {
		if strings.Contains(html, bad) {
			t.Fatalf("登录页含可疑外部资源标记 %q", bad)
		}
	}
	// 关键结构必须在（表单 POST 到 /login、带 next 隐藏域）。
	for _, want := range []string{`method="post"`, `action="/login"`, `name="next"`, `name="username"`, `name="password"`} {
		if !strings.Contains(html, want) {
			t.Fatalf("登录页缺少 %q", want)
		}
	}

	rec := httptest.NewRecorder()
	m := New(Options{ProductName: "示例产品"})
	m.LoginPage(rec, httpsReq(http.MethodGet, testMainOrigin+"/login", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("登录页状态码 = %d", rec.Code)
	}
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("登录页 CSP = %q，应为 default-src 'none' + frame-ancestors 'none'", csp)
	}
	// Referrer-Policy 必须是 same-origin，**绝不能是 no-referrer**（2026-09-19 P0）：
	// no-referrer 会让浏览器把本页的同源表单 POST（POST /login、POST /app-ticket）
	// 写成字面量 `Origin: null`（WHATWG Fetch "append a request Origin header"），
	// 而 checkMainOrigin 要求 Origin == 自身源 ⇒ 登录与换票必然 403。
	// 浏览器侧证据：temp/wasm-probe/micro-referrer.mjs（真实 Chromium 三种策略对照）。
	// 行为回归（同源 Origin 通行 / null 与跨源被拒）见 TestLoginSubmitOriginMatrix。
	if got := rec.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("Referrer-Policy = %q, want same-origin（no-referrer 会让同源表单 POST 带 Origin: null）", got)
	}
	if got := rec.Header().Get("Referrer-Policy"); got == "no-referrer" {
		t.Fatal("Referrer-Policy 退回了 no-referrer —— 这会让登录与换票 100% 403，绝不允许")
	}
	// 页面内联的 meta 必须与响应头**同一个值**（两者都会决定文档策略，取值不同时
	// meta 会覆盖头，只改一处等于没改）。
	if body := rec.Body.String(); !strings.Contains(body, `<meta name="referrer" content="same-origin">`) {
		t.Fatalf("登录页 meta referrer 不是 same-origin：%s", body)
	}
	if strings.Contains(rec.Body.String(), "http") {
		t.Fatal("实际渲染的页面里出现了 http 字样")
	}
}

// TestLoginPageLocalePerRequest 断言语言**按请求解析**、且同一个 Manager 实例
// 无需重建即可切换（宿主侧"模块级冻结语言"是已记录两次的 bug 类）。
func TestLoginPageLocalePerRequest(t *testing.T) {
	m := New(Options{})
	zh := httptest.NewRecorder()
	r1 := httpsReq(http.MethodGet, testMainOrigin+"/login", nil)
	r1.Header.Set("Accept-Language", "zh-CN,zh;q=0.9")
	m.LoginPage(zh, r1)
	en := httptest.NewRecorder()
	r2 := httpsReq(http.MethodGet, testMainOrigin+"/login", nil)
	r2.Header.Set("Accept-Language", "en-US,en;q=0.9")
	m.LoginPage(en, r2)

	zhBody, enBody := zh.Body.String(), en.Body.String()
	if !strings.Contains(zhBody, "用户名") || !strings.Contains(zhBody, `<html lang="zh">`) {
		t.Fatalf("中文页面缺少中文文案/语言标记：%s", zhBody)
	}
	if !strings.Contains(enBody, "Username") || !strings.Contains(enBody, `<html lang="en">`) {
		t.Fatalf("英文页面缺少英文文案/语言标记：%s", enBody)
	}
	if zhBody == enBody {
		t.Fatal("两种 Accept-Language 得到同一份页面（语言被冻结了）")
	}
	// 同一个实例再来一次中文，仍必须是中文（不残留上一次的语言）。
	zh2 := httptest.NewRecorder()
	r3 := httpsReq(http.MethodGet, testMainOrigin+"/login", nil)
	r3.Header.Set("Accept-Language", "zh")
	m.LoginPage(zh2, r3)
	if !strings.Contains(zh2.Body.String(), "用户名") {
		t.Fatal("同一实例第二次中文请求不是中文（语言状态泄漏）")
	}
}

// TestLoginPageInsecureShowsErrorAndNoForm 覆盖 §10.4 第 49 项的用户可见面：
// 非 https 时明确报错，并且连表单都不渲染（不可能静默发出一个不安全的 Cookie）。
func TestLoginPageInsecureShowsErrorAndNoForm(t *testing.T) {
	m := New(Options{})
	rec := httptest.NewRecorder()
	m.LoginPage(rec, httpsReq(http.MethodGet, "http://harness.example.com/login", nil))
	body := rec.Body.String()
	if !strings.Contains(body, copyZH.ErrInsecure) {
		t.Fatalf("非 https 登录页没有明确错误提示：%s", body)
	}
	if strings.Contains(body, `name="password"`) {
		t.Fatal("非 https 登录页仍然渲染了密码表单")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("非 https 登录页签发了 Cookie")
	}
}

// ---- 登录提交 ----

// TestLoginSubmitRejectsForeignOrigin 覆盖 §4.7 的登录 CSRF 防护。
func TestLoginSubmitRejectsForeignOrigin(t *testing.T) {
	env := newEnv(t)
	env.newUser(t, "alice")
	r := formReq(t, "/login", url.Values{
		"username": {"alice"}, "password": {testPassword}, "next": {"/"},
	})
	r.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()
	env.mgr.LoginSubmit(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源登录状态码 = %d, want 403", rec.Code)
	}
	if c := cookieByName(rec.Result().Cookies(), EmployeeCookieName); c != nil {
		t.Fatal("跨源登录竟然签发了会话 Cookie")
	}
	if n := countRows(t, env, "SELECT count(*) FROM employee_sessions"); n != 0 {
		t.Fatalf("跨源登录落了 %d 行会话", n)
	}
}

// TestLoginRefusesNonHTTPS 覆盖 §10.4 第 49 项（Secure fail-closed）：
// 非 https 的 POST 不落库、不下发 Cookie。
func TestLoginRefusesNonHTTPS(t *testing.T) {
	// MainOrigin 留空 ⇒ 走"按请求推导"，才能命中 insecure 分支本身
	// （生产里配了 https 的 MainOrigin 时，http 请求会先被同源断言挡在 403）。
	env := newEnv(t, func(o *Options) { o.MainOrigin = "" })
	env.newUser(t, "alice")
	r := httpsReq(http.MethodPost, "http://harness.example.com/login",
		strings.NewReader(url.Values{
			"username": {"alice"}, "password": {testPassword}, "next": {"/"},
		}.Encode()))
	r.Header.Set("Origin", "http://harness.example.com")
	rec := httptest.NewRecorder()
	env.mgr.LoginSubmit(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("非 https 登录状态码 = %d, want 403", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), copyZH.ErrInsecure) {
		t.Fatal("非 https 登录没有给出明确错误")
	}
	if c := cookieByName(rec.Result().Cookies(), EmployeeCookieName); c != nil {
		t.Fatal("非 https 登录签发了 Cookie（必须 fail-closed）")
	}
	if n := countRows(t, env, "SELECT count(*) FROM employee_sessions"); n != 0 {
		t.Fatalf("非 https 登录落了 %d 行会话", n)
	}
}

// TestLoginSuccessSetsSessionAndCookie 覆盖 §4.7 的 Cookie 属性与"只存 SHA-256"。
func TestLoginSuccessSetsSessionAndCookie(t *testing.T) {
	env := newEnv(t)
	cookie, emp := env.loginAs(t, "alice")

	// Cookie 属性：host-only（无 Domain）+ HttpOnly + Path=/ + SameSite=Lax + Secure。
	if cookie.Domain != "" {
		t.Fatalf("Cookie 带了 Domain=%q（host-only 要求不设 Domain，否则会发往全部应用子域）", cookie.Domain)
	}
	if !cookie.HttpOnly {
		t.Fatal("Cookie 缺 HttpOnly（应用 JS 必须读不到，§10.4 第 42 项）")
	}
	if cookie.Path != "/" {
		t.Fatalf("Cookie Path = %q", cookie.Path)
	}
	if cookie.SameSite != http.SameSiteLaxMode {
		t.Fatalf("主站 Cookie SameSite = %v, want Lax", cookie.SameSite)
	}
	if !cookie.Secure {
		t.Fatal("https 下 Cookie 必须带 Secure")
	}
	if cookie.MaxAge <= 0 {
		t.Fatalf("Cookie MaxAge = %d，应为正数（TTL = limits.AppSessionTTL 8h）", cookie.MaxAge)
	}
	if emp.Username != "alice" {
		t.Fatalf("身份用户名 = %q", emp.Username)
	}

	// 库里只有 SHA-256，绝无明文。
	var stored, ua string
	if err := env.db.QueryRow(`SELECT token_hash, user_agent FROM employee_sessions LIMIT 1`).Scan(&stored, &ua); err != nil {
		t.Fatalf("读会话行: %v", err)
	}
	if stored == cookie.Value {
		t.Fatal("库里存了 Cookie 明文（必须只存 SHA-256）")
	}
	if stored != serverstore.TokenHash(cookie.Value) {
		t.Fatalf("token_hash = %q, want SHA-256(cookie)", stored)
	}
	if len(stored) != 64 {
		t.Fatalf("token_hash 长度 = %d, want 64（hex sha256）", len(stored))
	}
	if env.audit.waitFor(t, "login_success") == "" {
		t.Fatal("登录成功未写审计")
	}
}

// TestLoginFailureMessageDoesNotLeakExistence 断言"账号不存在"与"密码错误"
// 返回**逐字节相同**的页面（否则 /login 就是账号枚举器）。
func TestLoginFailureMessageDoesNotLeakExistence(t *testing.T) {
	env := newEnv(t)
	env.newUser(t, "alice")

	missing := httptest.NewRecorder()
	env.mgr.LoginSubmit(missing, formReq(t, "/login", url.Values{
		"username": {"nobody"}, "password": {testPassword}, "next": {"/"},
	}))
	wrong := httptest.NewRecorder()
	env.mgr.LoginSubmit(wrong, formReq(t, "/login", url.Values{
		"username": {"alice"}, "password": {"wrong-password"}, "next": {"/"},
	}))
	if missing.Code != http.StatusUnauthorized || wrong.Code != http.StatusUnauthorized {
		t.Fatalf("状态码 = %d / %d, want 401", missing.Code, wrong.Code)
	}
	if missing.Body.String() != wrong.Body.String() {
		t.Fatal("「账号不存在」与「密码错误」的页面不同 —— 泄露了账号是否存在")
	}
	if !strings.Contains(wrong.Body.String(), copyZH.ErrCredentials) {
		t.Fatal("认证失败没有给出统一文案")
	}
	if env.audit.waitFor(t, "login_fail") == "" {
		t.Fatal("登录失败未写审计")
	}
}

// TestLoginRejectsAuditorAndDisabled 断言与客户端面同一套账号可用性判据。
func TestLoginRejectsAuditorAndDisabled(t *testing.T) {
	env := newEnv(t)
	env.newUser(t, "auditor1")
	env.setRole(t, "auditor1", serverstore.RoleAuditor)
	env.newUser(t, "disabled1")
	setStatus(t, env, "disabled1", 0)

	for _, name := range []string{"auditor1", "disabled1"} {
		rec := httptest.NewRecorder()
		env.mgr.LoginSubmit(rec, formReq(t, "/login", url.Values{
			"username": {name}, "password": {testPassword}, "next": {"/"},
		}))
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s 登录状态码 = %d, want 401", name, rec.Code)
		}
		if c := cookieByName(rec.Result().Cookies(), EmployeeCookieName); c != nil {
			t.Fatalf("%s 竟然签发了会话", name)
		}
	}
	if n := countRows(t, env, "SELECT count(*) FROM employee_sessions"); n != 0 {
		t.Fatalf("被拒账号落了 %d 行会话", n)
	}
}

// TestLoginRedirectsToSanitizedNext 断言登录后的回跳也走同一个 next 白名单。
func TestLoginRedirectsToSanitizedNext(t *testing.T) {
	env := newEnv(t)
	env.newUser(t, "alice")
	cases := []struct{ next, want string }{
		{"/app-ticket?app=my-app&next=%2Fdash", "/app-ticket?app=my-app&next=%2Fdash"},
		{"//evil.com", "/"},
		{"https://evil.com", "/"},
	}
	for _, tc := range cases {
		rec := httptest.NewRecorder()
		env.mgr.LoginSubmit(rec, formReq(t, "/login", url.Values{
			"username": {"alice"}, "password": {testPassword}, "next": {tc.next},
		}))
		if rec.Code != http.StatusSeeOther {
			t.Fatalf("next=%q 登录状态码 = %d", tc.next, rec.Code)
		}
		if got := rec.Header().Get("Location"); got != tc.want {
			t.Fatalf("next=%q 回跳 = %q, want %q", tc.next, got, tc.want)
		}
	}
}

// TestCurrentEmployeeRejectsRevokedAndExpired 覆盖员工会话的三把闸。
func TestCurrentEmployeeRejectsRevokedAndExpired(t *testing.T) {
	env := newEnv(t)
	cookie, emp := env.loginAs(t, "alice")

	// 有效
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(cookie)); !ok {
		t.Fatal("有效会话解析失败")
	}
	// 过期：推进注入时钟超过 limits.AppSessionTTL
	env.advance(appSessionTTLPlus())
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(cookie)); ok {
		t.Fatal("过期会话仍然有效")
	}
	env.advance(-appSessionTTLPlus())

	// 吊销
	if err := env.mgr.RevokeSession(t.Context(), emp.SessionID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(cookie)); ok {
		t.Fatal("已吊销会话仍然有效")
	}
	// 伪造的明文解析不出会话
	fake := &http.Cookie{Name: EmployeeCookieName, Value: "deadbeef"}
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(fake)); ok {
		t.Fatal("伪造 Cookie 解析出了会话")
	}
}

// TestLogoutInvalidatesAppSessionsImmediately 覆盖 §10.4 第 46 项：
// 员工登出后，名下全部应用子域会话立即失效（SQL 层级联）。
func TestLogoutInvalidatesAppSessionsImmediately(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	env.newApp(t, "other-app", "alice")
	empCookie, emp := env.loginAs(t, "alice")

	// 在两个应用里各兑换一份会话。
	appCookies := map[string]*http.Cookie{}
	for _, appID := range []string{"my-app", "other-app"} {
		code := env.issueTicketViaPOST(t, empCookie, appID, "/")
		rec := httptest.NewRecorder()
		if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket(appID, code), appID); !ok {
			t.Fatalf("%s 兑换失败", appID)
		}
		c := cookieByName(rec.Result().Cookies(), AppCookieName)
		if c == nil {
			t.Fatalf("%s 兑换未下发应用 Cookie", appID)
		}
		appCookies[appID] = c
		if env.mgr.CurrentUser(reqWithCookie(c), appID) == nil {
			t.Fatalf("%s 兑换后 CurrentUser 为空", appID)
		}
	}
	if n := countRows(t, env, "SELECT count(*) FROM app_sessions"); n != 2 {
		t.Fatalf("app_sessions 行数 = %d, want 2", n)
	}

	// 登出（POST + 同源）。
	lo := formReq(t, "/logout", url.Values{})
	lo.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.Logout(rec, lo)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("登出状态码 = %d", rec.Code)
	}
	if env.audit.waitFor(t, "logout") == "" {
		t.Fatal("登出未写审计")
	}

	// §10.4 第 46 项：两张应用 Cookie 都必须立刻失效，且库里的行被删掉。
	if n := countRows(t, env, "SELECT count(*) FROM app_sessions"); n != 0 {
		t.Fatalf("登出后仍有 %d 行 app_sessions（必须级联失效）", n)
	}
	for appID, c := range appCookies {
		if u := env.mgr.CurrentUser(reqWithCookie(c), appID); u != nil {
			t.Fatalf("登出后 %s 的旧应用凭证仍解析出身份 %+v", appID, u)
		}
		if k := env.mgr.SessionKey(reqWithCookie(c), appID); k != "" {
			t.Fatalf("登出后 %s 的 SessionKey = %q，应为空", appID, k)
		}
	}
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(empCookie)); ok {
		t.Fatal("登出后员工会话仍然有效")
	}
	var revoked any
	if err := env.db.QueryRow(`SELECT revoked_at FROM employee_sessions WHERE id = ?`, emp.SessionID).Scan(&revoked); err != nil {
		t.Fatalf("读 revoked_at: %v", err)
	}
	if revoked == nil {
		t.Fatal("登出没有置 revoked_at")
	}
}

// TestLogoutRejectsCrossOrigin 断言登出也走 Origin 校验（否则第三方页面能强制登出，
// 且能借用户浏览器发出无 CSRF 保护的写请求）。
func TestLogoutRejectsCrossOrigin(t *testing.T) {
	env := newEnv(t)
	empCookie, _ := env.loginAs(t, "alice")
	r := formReq(t, "/logout", url.Values{})
	r.Header.Set("Origin", "https://evil.example.com")
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.Logout(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源登出状态码 = %d, want 403", rec.Code)
	}
	if _, ok := env.mgr.CurrentEmployee(reqWithCookie(empCookie)); !ok {
		t.Fatal("跨源登出竟然吊销了会话")
	}
}

// TestAppCookieIsNotABearerCredential 覆盖 §10.4 第 43 项：
// 应用子域拿不到任何可用于调主站 /api/client/v2/* 的凭证 ——
// 应用 Cookie 与 Bearer 令牌格式不同，且 serverauth.BearerAuth **只读
// Authorization 头**，带 Cookie 的请求必然 401。
func TestAppCookieIsNotABearerCredential(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("兑换失败")
	}
	appCookie := cookieByName(rec.Result().Cookies(), AppCookieName)
	if appCookie == nil {
		t.Fatal("兑换未下发应用 Cookie")
	}
	if appCookie.Name == EmployeeCookieName {
		t.Fatal("应用 Cookie 名与员工会话 Cookie 名相同")
	}

	// 真跑 serverauth.BearerAuth：只带应用 Cookie（以及员工 Cookie）都不能通过。
	gin := serverauth.New(env.db)
	for _, cs := range [][]*http.Cookie{{appCookie}, {empCookie}, {appCookie, empCookie}} {
		r := httptest.NewRequest(http.MethodGet, "/api/client/v2/auth/me", nil)
		for _, c := range cs {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		ok := runBearerAuth(t, gin, w, r)
		if ok {
			t.Fatalf("带着 Cookie（%d 个）竟然通过了 BearerAuth —— 应用拿到了平台凭证", len(cs))
		}
		if code := errorCode(t, w); code != "AUTH_REQUIRED" {
			t.Fatalf("BearerAuth 错误码 = %q, want AUTH_REQUIRED", code)
		}
	}
	// 反向：把应用 Cookie 的值当 Bearer 令牌发，也必须失败（它不在 api_tokens 里）。
	r := httptest.NewRequest(http.MethodGet, "/api/client/v2/auth/me", nil)
	r.Header.Set("Authorization", "Bearer "+appCookie.Value)
	if runBearerAuth(t, gin, httptest.NewRecorder(), r) {
		t.Fatal("应用会话明文被当作 Bearer 令牌接受了")
	}
}
