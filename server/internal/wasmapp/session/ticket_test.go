package session

import (
	"html"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ---- GET /app-ticket：只渲染确认页，不签发任何东西 ----

// TestTicketPageRendersFormOnly 断言 GET 不查库、不下发 Cookie、不发票。
//
// DB 为 nil 的 Manager 仍然渲染成功 —— 这本身就是"GET 不碰数据库"的证明。
func TestTicketPageRendersFormOnly(t *testing.T) {
	audit := &auditRec{}
	m := New(Options{BaseDomain: testBaseDomain, Audit: audit.fn})
	rec := httptest.NewRecorder()
	m.TicketPage(rec, httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=my-app&next=%2Fdash", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, want 200", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{`action="/app-ticket"`, `name="app" value="my-app"`, `name="next" value="/dash"`,
		`document.getElementById("picoaide-ticket-form").submit()`} {
		if !strings.Contains(body, want) {
			t.Fatalf("换票页缺少 %q：%s", want, body)
		}
	}
	if strings.Contains(body, "http") {
		t.Fatal("换票页出现了 http 字样（必须是自包含的注入式 HTML）")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("GET /app-ticket 下发了 Cookie（必须什么都不签发）")
	}
	if m.tickets.size() != 0 {
		t.Fatal("GET /app-ticket 签发了票据")
	}
	if len(audit.entries) != 0 {
		t.Fatalf("GET /app-ticket 写了审计：%v", audit.entries)
	}
}

// TestTicketPageLocalePerRequest 断言换票页也按请求解析语言。
func TestTicketPageLocalePerRequest(t *testing.T) {
	m := New(Options{BaseDomain: testBaseDomain})
	r1 := httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=my-app", nil)
	r1.Header.Set("Accept-Language", "en")
	en := httptest.NewRecorder()
	m.TicketPage(en, r1)
	r2 := httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=my-app", nil)
	r2.Header.Set("Accept-Language", "zh")
	zh := httptest.NewRecorder()
	m.TicketPage(zh, r2)
	if !strings.Contains(en.Body.String(), "Opening application") {
		t.Fatal("英文请求没有拿到英文换票页")
	}
	if !strings.Contains(zh.Body.String(), "正在打开应用") {
		t.Fatal("中文请求没有拿到中文换票页")
	}
}

// TestTicketPageNotFoundForMalformedApp 断言形态非法的 app 直接 404
// （不查库，避免未登录用户用它探测应用是否存在）。
func TestTicketPageNotFoundForMalformedApp(t *testing.T) {
	m := New(Options{BaseDomain: testBaseDomain})
	for _, target := range []string{
		testMainOrigin + "/app-ticket",
		testMainOrigin + "/app-ticket?app=",
		testMainOrigin + "/app-ticket?app=" + strings.Repeat("a", 64),
	} {
		rec := httptest.NewRecorder()
		m.TicketPage(rec, httpsReq(http.MethodGet, target, nil))
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s 状态码 = %d, want 404", target, rec.Code)
		}
	}
}

// TestTicketPageNotFoundWithoutBaseDomain 断言未配置应用基域时（= 未启用应用子域）
// 换票端点不存在 —— 与 edge.HostGate 的语义一致。
func TestTicketPageNotFoundWithoutBaseDomain(t *testing.T) {
	m := New(Options{})
	rec := httptest.NewRecorder()
	m.TicketPage(rec, httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=my-app", nil))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未启用应用子域时状态码 = %d, want 404", rec.Code)
	}
}

// ---- POST /app-ticket：校验与签发 ----

// TestTicketSubmitNotFoundWithoutBaseDomain：未启用应用子域时 POST 与 GET 同语义
// （都 404，而不是渲染"应用不存在"—— 那是应用子域的 404，出现在主站上会误导用户，
// 也会与主站 NoRoute 的 404 混成同一份字节）。
func TestTicketSubmitNotFoundWithoutBaseDomain(t *testing.T) {
	m := New(Options{})
	rec := httptest.NewRecorder()
	r := httpsReq(http.MethodPost, testMainOrigin+"/app-ticket",
		strings.NewReader(url.Values{"app": {"my-app"}, "next": {"/"}}.Encode()))
	r.Header.Set("Origin", testMainOrigin)
	m.TicketSubmit(rec, r)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未启用应用子域时 POST 状态码 = %d, want 404", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "" {
		t.Fatalf("未启用应用子域时不得产生重定向: %q", loc)
	}
}

// TestTicketSubmitRejectsMalformedApp 是 FIX-28 的回归判据（§4.1 + §10.5 第 52/53 项）。
//
// 审计结论：`app` 参数此前只做小写/去空白/限长，于是
//   - `real-app.evil.example.com` 被库反查归一化成第一级标签 `real-app` **命中真应用**
//     ⇒ 签出一张绑 `real-app` 的票、却把用户 302 到 `real-app.evil.example.com.<基域>`
//     （HostGate 一律 404）⇒ 死链，且那张票**永远兑换不了**；
//   - `real-app:8443` 让 Location 连 url.Parse 都失败。
//
// 现在 `app` 先过 registry 的形态与业务规则（与子域路由同一套），非法一律 404：
// **不签发任何票、不产生任何重定向**。
//
// 变异验证：把 TicketSubmit 里的 `m.appIDValidExternal(appID)` 判断去掉（或改回
// 旧 sanitizeAppID 的宽容归一化）⇒ 前 8 条用例必红。
func TestTicketSubmitRejectsMalformedApp(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "real-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	bad := []struct{ app, why string }{
		{"real-app.evil.example.com", "多级子域：反查会归一化成 real-app 而命中真应用 ⇒ 死链 + 永不可兑换的票"},
		{"real-app:8443", "带端口：Location 连 url.Parse 都失败"},
		{"REAL-APP", "大写：静默小写化会让『签出的票』与『跳转目标』不是同一个 app_id"},
		{"real-app.", "尾点：主机名装饰不是 app_id"},
		{"real-app/../real-app", "路径穿越形态"},
		{"real--app", "连续连字符（形态非法）"},
		{"real-app-", "以连字符结尾（形态非法）"},
		{"real_app", "下划线不是合法字符"},
		{"admin", "平台保留字"},
		{"www", "平台保留字"},
		{"123", "纯数字（IP 形态）"},
		{"xn--fiqs8s", "punycode 前缀"},
		{strings.Repeat("a", 64), "超过 DNS label 上限"},
		{"", "空"},
	}
	for _, tc := range bad {
		t.Run(tc.app, func(t *testing.T) {
			rec := httptest.NewRecorder()
			r := formReq(t, "/app-ticket", url.Values{"app": {tc.app}, "next": {"/"}})
			r.AddCookie(empCookie)
			env.mgr.TicketSubmit(rec, r)
			if rec.Code != http.StatusNotFound {
				t.Fatalf("app=%q 必须 404（%s），得到 %d Location=%q body=%s",
					tc.app, tc.why, rec.Code, rec.Header().Get("Location"), rec.Body.String())
			}
			if loc := rec.Header().Get("Location"); loc != "" {
				t.Fatalf("app=%q 非法却产生了重定向: %q（不签发、不重定向）", tc.app, loc)
			}
		})
	}

	// 反向对照：合法 app 正常签发并 302（防"一刀切全禁"）。
	code := env.issueTicketViaPOST(t, empCookie, "real-app", "/")
	if code == "" {
		t.Fatal("合法 app 必须照常签发票")
	}
	// 签出的票能在真实子域上兑换 —— 这才是"票有效"的判据。
	// （RedeemTicket 只负责写 Cookie 并回干净 URL，最终 302 由 appserver 发。）
	rec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(rec, requestWithTicket("real-app", code), "real-app")
	if !ok {
		t.Fatal("合法 app 签出的票必须可兑换")
	}
	if clean != "/" {
		t.Fatalf("兑换后的干净 URL = %q, want /", clean)
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c == nil || c.Value == "" {
		t.Fatal("兑换成功必须下发应用会话 Cookie")
	}
}

// TestTicketPageSharesAppIDRulesWithSubmit：GET 确认页与 POST 必须**同一套** app 规则
// （否则 GET 会变成"哪些形态能被 POST 接受"的探测器）。
func TestTicketPageSharesAppIDRulesWithSubmit(t *testing.T) {
	m := New(Options{BaseDomain: testBaseDomain})
	for _, app := range []string{
		"real-app.evil.example.com", "real-app:8443", "REAL-APP", "real-app.",
		"admin", "123", strings.Repeat("a", 64), "",
	} {
		rec := httptest.NewRecorder()
		m.TicketPage(rec, httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app="+url.QueryEscape(app), nil))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET /app-ticket?app=%q 状态码 = %d, want 404（与 POST 同口径）", app, rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	m.TicketPage(rec, httpsReq(http.MethodGet, testMainOrigin+"/app-ticket?app=real-app", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("合法 app 的确认页应 200，得到 %d", rec.Code)
	}
}

// TestTicketSubmitRefusesNonHTTPS 是 FIX-30 的回归判据（§10.4 第 49 项的部署健壮性）。
//
// 明文连接下签出的票**永远兑换不出来**（RedeemTicket 是 fail-closed：非 https 不签发
// Secure Cookie），照常 302 只会让用户"换票 → 兑换失败 → 再换票"地空转一圈。
// 现在与 appserver 的 login_required 分支同口径：明确的可读错误页，**不签票、不 302**。
//
// 变异验证：去掉 TicketSubmit 里的 `!m.secureRequest(r)` 分支 ⇒ 本用例必红。
func TestTicketSubmitRefusesNonHTTPS(t *testing.T) {
	// MainOrigin 留空 ⇒ 按请求推导（明文请求的自身源 = http://…），
	// 这样 403 的成因只可能是 secureRequest，而不是"配置主站源不匹配"。
	env := newEnv(t, func(o *Options) { o.MainOrigin = "" })
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	const plainMain = "http://harness.example.com"
	r := httpsReq(http.MethodPost, plainMain+"/app-ticket",
		strings.NewReader(url.Values{"app": {"my-app"}, "next": {"/"}}.Encode()))
	r.Host = "harness.example.com"
	r.TLS = nil // 明文
	r.Header.Set("Origin", plainMain)
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)

	if rec.Code == http.StatusFound {
		t.Fatalf("非 https 不得签发换票（会 302 到一张永远兑换不出来的票）Location=%q",
			rec.Header().Get("Location"))
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("非 https 应给明确的可读错误（403），得到 %d", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "HTTPS") && !strings.Contains(body, "https") {
		t.Fatalf("错误页必须说明原因是明文连接，body=%.300s", body)
	}
	// 不得下发任何 Cookie（票都没签，更不该有会话）。
	if len(rec.Result().Cookies()) != 0 {
		t.Fatalf("非 https 不得下发任何 Cookie，得到 %v", rec.Result().Cookies())
	}

	// 反向对照：同一账号在 https 下照常签发（否则"一律拒绝"也能假绿）。
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
	if code == "" {
		t.Fatal("https 下必须照常签发票（反向对照）")
	}
}

// TestTicketSubmitRejectsForeignOrigin 覆盖 §10.4 第 41 项 / §15.1 第 12 条：
// 第三方页面（iframe/img/表单）触发的换票必须被 Origin 校验拒掉。
func TestTicketSubmitRejectsForeignOrigin(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	r := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {"/"}})
	r.AddCookie(empCookie)
	r.Header.Set("Origin", "https://evil.example.com")
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源换票状态码 = %d, want 403", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "" {
		t.Fatalf("跨源换票仍然跳转到了 %q", loc)
	}
	if env.mgr.tickets.size() != 0 {
		t.Fatal("跨源换票签发了票据")
	}

	// 完全没有 Origin/Referer 也必须拒（宁可拒一次合法请求，也不放过跨源写）。
	r2 := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {"/"}})
	r2.AddCookie(empCookie)
	r2.Header.Del("Origin")
	rec2 := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec2, r2)
	if rec2.Code != http.StatusForbidden {
		t.Fatalf("无 Origin/Referer 状态码 = %d, want 403", rec2.Code)
	}
}

// TestTicketSubmitWithoutSessionRedirectsToLogin 覆盖 §6.1 ② 与 §10.4 第 39 项。
func TestTicketSubmitWithoutSessionRedirectsToLogin(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {"/dash"}}))
	if rec.Code != http.StatusFound {
		t.Fatalf("状态码 = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil || u.Path != "/login" {
		t.Fatalf("未登录换票应跳登录页，得到 %q", loc)
	}
	// 登录后的 next 必须能回到 /app-ticket（结构上可往返，不是被 sanitize 抹成 `/`）。
	back := sanitizeNext(u.Query().Get("next"))
	if !strings.HasPrefix(back, "/app-ticket?") || !strings.Contains(back, "app=my-app") {
		t.Fatalf("登录回跳 next = %q（应回到 /app-ticket 并保留 app）", back)
	}
	if env.mgr.tickets.size() != 0 {
		t.Fatal("未登录请求签发了票据")
	}
}

// TestTicketSubmitUnknownOrDeletedAppIs404 覆盖 §4.7 第 3 条：
// 查不到就 404，且与 §4.8 主机名反查同口径（同一个 serverstore 函数）。
func TestTicketSubmitUnknownOrDeletedAppIs404(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "gone-app", "alice")
	if err := serverstore.SoftDeleteWasmApp(t.Context(), env.db, "gone-app"); err != nil {
		t.Fatalf("soft delete: %v", err)
	}
	empCookie, _ := env.loginAs(t, "alice")

	for _, appID := range []string{"no-such-app", "gone-app"} {
		r := formReq(t, "/app-ticket", url.Values{"app": {appID}, "next": {"/"}})
		r.AddCookie(empCookie)
		rec := httptest.NewRecorder()
		env.mgr.TicketSubmit(rec, r)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("app=%s 状态码 = %d, want 404", appID, rec.Code)
		}
		if env.mgr.tickets.size() != 0 {
			t.Fatalf("app=%s 仍然签发了票据", appID)
		}
	}
}

// TestTicketSubmitIssuesTicketAndRedirects 覆盖 §4.7 的签发与 §6.1 ③ 的回跳形态。
func TestTicketSubmitIssuesTicketAndRedirects(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	r := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {"/dash?tab=1"}})
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	if rec.Code != http.StatusFound {
		t.Fatalf("状态码 = %d, want 302", rec.Code)
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, "https://my-app."+testBaseDomain+"/dash?") {
		t.Fatalf("回跳地址 = %q（必须是 https 且落在应用子域）", loc)
	}
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("Location 解析失败: %v", err)
	}
	code := u.Query().Get("ticket")
	if len(code) != 64 {
		t.Fatalf("ticket 长度 = %d, want 64（32 字节 hex）", len(code))
	}
	if u.Query().Get("tab") != "1" {
		t.Fatalf("原始 query 参数丢失：%q", loc)
	}
	if env.audit.waitFor(t, "app_ticket_issue") == "" {
		t.Fatal("换票签发未写审计（§4.9）")
	}
	if env.mgr.tickets.size() != 1 {
		t.Fatalf("在途票数 = %d, want 1", env.mgr.tickets.size())
	}
}

// TestTicketSubmitNextFallsBackToRoot 覆盖"非法 next 回落 `/`"（§4.7 原话）。
func TestTicketSubmitNextFallsBackToRoot(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	for _, next := range []string{"//evil.com", "https://evil.com", `/\evil.com`, "/%2F%2Fevil.com", "javascript:alert(1)"} {
		r := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {next}})
		r.AddCookie(empCookie)
		rec := httptest.NewRecorder()
		env.mgr.TicketSubmit(rec, r)
		if rec.Code != http.StatusFound {
			t.Fatalf("next=%q 状态码 = %d, want 302（非法 next 只回落，不拒整单）", next, rec.Code)
		}
		u, err := url.Parse(rec.Header().Get("Location"))
		if err != nil {
			t.Fatalf("next=%q Location 解析失败: %v", next, err)
		}
		if u.Host != "my-app."+testBaseDomain || u.Path != "/" {
			t.Fatalf("next=%q 的回跳 = %q（必须回落应用根）", next, rec.Header().Get("Location"))
		}
	}
}

// TestTicketSubmitTicketParamComesFirst 断言我们自己签发的 ticket 排在原 query 之前：
// 应用用 `Query().Get("ticket")` 取到的必然是有效票，而不是 next 里夹带的同名参数。
func TestTicketSubmitTicketParamComesFirst(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	r := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {"/a?ticket=evil&x=1"}})
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	u, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("Location 解析失败: %v", err)
	}
	got := u.Query().Get("ticket")
	if got == "evil" || len(got) != 64 {
		t.Fatalf("应用会读到的 ticket = %q（应为本次签发的 64 位十六进制码）", got)
	}
	if !strings.Contains(rec.Header().Get("Location"), "?ticket="+got+"&ticket=evil") {
		t.Fatalf("ticket 参数顺序不对：%q", rec.Header().Get("Location"))
	}
}

// TestTicketEndpointsRejectWrongMethods 断言两个端点只吃各自的方法。
func TestTicketEndpointsRejectWrongMethods(t *testing.T) {
	env := newEnv(t)
	post := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}})
	rec := httptest.NewRecorder()
	env.mgr.TicketPage(rec, post)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 到 TicketPage 状态码 = %d, want 405", rec.Code)
	}
	get := httpsReq(http.MethodGet, testMainOrigin+"/app-ticket", nil)
	rec2 := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec2, get)
	if rec2.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET 到 TicketSubmit 状态码 = %d, want 405", rec2.Code)
	}
}

// TestTicketExpiresAfterTTL 覆盖"过期 code 拒"（TTL = limits.TicketTTL 60 s）。
func TestTicketExpiresAfterTTL(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	env.advance(limits.TicketTTL + time.Second)
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); ok {
		t.Fatal("过期票据被接受了")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("过期票据仍下发了 Cookie")
	}
	if env.mgr.tickets.size() != 0 {
		t.Fatal("过期票据没有被清理")
	}
}

// TestTicketUsableJustBeforeTTL 是上一条的反向对照：TTL 内必须可用
// （否则"60 s"就变成了"0 s"，闸门方向反了）。
func TestTicketUsableJustBeforeTTL(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
	env.advance(limits.TicketTTL - time.Second)
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("TTL 内的票据被拒了")
	}
}

// TestConcurrentRedeemOnlyOneWins 是"单次消费"的并发断言：
// 同一 code 被 64 个 goroutine 同时兑换，必须**恰好一个**成功。
func TestConcurrentRedeemOnlyOneWins(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	const workers = 64
	var wg sync.WaitGroup
	var mu sync.Mutex
	wins := 0
	start := make(chan struct{})
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			<-start
			if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); ok {
				mu.Lock()
				wins++
				mu.Unlock()
			}
		}()
	}
	close(start)
	wg.Wait()
	if wins != 1 {
		t.Fatalf("并发兑换成功次数 = %d, want 1（CAS 失效）", wins)
	}
	if n := countRows(t, env, "SELECT count(*) FROM app_sessions"); n != 1 {
		t.Fatalf("app_sessions 行数 = %d, want 1", n)
	}
}

// TestRedeemReplayRejected 覆盖 §10.4 第 40 项前半（重放）。
func TestRedeemReplayRejected(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	first := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(first, requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("首次兑换失败")
	}
	second := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(second, requestWithTicket("my-app", code), "my-app"); ok {
		t.Fatal("重放票据被接受了")
	}
	if len(second.Result().Cookies()) != 0 {
		t.Fatal("重放票据下发了 Cookie")
	}
}

// TestCrossAppTicketRejected 覆盖 §10.4 第 40 项后半（跨应用）：
// 一律拒，且**不消费** —— 合法应用仍然能用这张票。
func TestCrossAppTicketRejected(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "app-a", "alice")
	env.newApp(t, "app-b", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "app-a", "/")

	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("app-b", code), "app-b"); ok {
		t.Fatal("跨应用兑换成功了")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("跨应用兑换下发了 Cookie")
	}
	// 票没被烧掉：正确的应用仍然可以兑换。
	right := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(right, requestWithTicket("app-a", code), "app-a"); !ok {
		t.Fatal("跨应用尝试把票烧掉了（错误的应用不应有权消费他人票据）")
	}
}

// TestRedeemReturnsCleanURL 覆盖"兑换后 302 回去掉 ticket 的干净 URL"。
func TestRedeemReturnsCleanURL(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/dash?tab=1")

	r := httpsReq(http.MethodGet, "https://my-app."+testBaseDomain+"/dash?tab=1&ticket="+code, nil)
	rec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(rec, r, "my-app")
	if !ok {
		t.Fatal("兑换失败")
	}
	if strings.Contains(clean, "ticket") {
		t.Fatalf("干净 URL 仍含 ticket：%q", clean)
	}
	if clean != "/dash?tab=1" {
		t.Fatalf("干净 URL = %q, want /dash?tab=1", clean)
	}
}

// TestAppCookieAttributes 覆盖 §4.7 / §15.1 第 3 条 / §10.4 第 42/43 项。
func TestAppCookieAttributes(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("兑换失败")
	}
	c := cookieByName(rec.Result().Cookies(), AppCookieName)
	if c == nil {
		t.Fatal("兑换未下发应用 Cookie")
	}
	if c.Domain != "" {
		t.Fatalf("应用 Cookie 带了 Domain=%q（必须 host-only：每个子域各自一份）", c.Domain)
	}
	if !c.HttpOnly {
		t.Fatal("应用 Cookie 缺 HttpOnly（§10.4 第 42 项：document.cookie 必须为空）")
	}
	if !c.Secure {
		t.Fatal("应用 Cookie 缺 Secure")
	}
	if c.SameSite != http.SameSiteStrictMode {
		t.Fatalf("应用 Cookie SameSite = %v, want Strict（§15.1 第 3 条）", c.SameSite)
	}
	if c.Path != "/" {
		t.Fatalf("应用 Cookie Path = %q", c.Path)
	}
	if c.MaxAge != int(limits.AppSessionTTL.Seconds()) {
		t.Fatalf("应用 Cookie MaxAge = %d, want %d", c.MaxAge, int(limits.AppSessionTTL.Seconds()))
	}
	// Set-Cookie 头里必须**字面**出现 HttpOnly（浏览器行为无法在单测里跑，
	// 因此断言头本身 —— 任务口径明确要求这一条）。
	raw := rec.Header().Get("Set-Cookie")
	if !strings.Contains(raw, "HttpOnly") {
		t.Fatalf("Set-Cookie 头不含 HttpOnly：%q", raw)
	}
	// 库里只有哈希。
	var stored string
	if err := env.db.QueryRow(`SELECT token_hash FROM app_sessions LIMIT 1`).Scan(&stored); err != nil {
		t.Fatalf("读应用会话行: %v", err)
	}
	if stored == c.Value || stored != serverstore.TokenHash(c.Value) {
		t.Fatal("app_sessions.token_hash 不是 Cookie 的 SHA-256")
	}
}

// TestRedeemRefusesNonHTTPS 覆盖 §10.4 第 49 项：明文连接不签发应用 Cookie。
func TestRedeemRefusesNonHTTPS(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	r := httpsReq(http.MethodGet, "http://my-app."+testBaseDomain+"/?ticket="+code, nil)
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, r, "my-app"); ok {
		t.Fatal("明文连接下兑换成功了")
	}
	if len(rec.Result().Cookies()) != 0 {
		t.Fatal("明文连接下发了应用 Cookie（必须 fail-closed）")
	}
	if n := countRows(t, env, "SELECT count(*) FROM app_sessions"); n != 0 {
		t.Fatalf("明文连接落了 %d 行应用会话", n)
	}
}

// TestRedeemAfterLogoutFails 覆盖"签发→兑换"窗口内登出的窄窗口（§10.4 第 46 项）：
// 票还在 60 s 有效期内，但员工会话已失效 ⇒ 换不出应用会话。
func TestRedeemAfterLogoutFails(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, emp := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")

	if err := env.mgr.RevokeSession(t.Context(), emp.SessionID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); ok {
		t.Fatal("员工会话已吊销，仍然换出了应用会话")
	}
	if n := countRows(t, env, "SELECT count(*) FROM app_sessions"); n != 0 {
		t.Fatalf("落下了 %d 行应用会话", n)
	}
}

// ---- CurrentUser / SessionKey ----

// TestCurrentUserAndSessionKey 覆盖身份读取与会话键（供 aichat 按会话吊销）。
func TestCurrentUserAndSessionKey(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	env.newApp(t, "other-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	// 未兑换 ⇒ nil / 空键。
	if u := env.mgr.CurrentUser(reqWithCookie(nil), "my-app"); u != nil {
		t.Fatalf("无 Cookie 时 CurrentUser = %+v", u)
	}
	if k := env.mgr.SessionKey(reqWithCookie(nil), "my-app"); k != "" {
		t.Fatalf("无 Cookie 时 SessionKey = %q", k)
	}

	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("兑换失败")
	}
	appCookie := cookieByName(rec.Result().Cookies(), AppCookieName)

	r := reqWithCookie(appCookie)
	u := env.mgr.CurrentUser(r, "my-app")
	if u == nil {
		t.Fatal("CurrentUser 为空")
	}
	if u.ID != env.userID(t, "alice") || u.Username != "alice" {
		t.Fatalf("身份 = %+v", u)
	}
	if !u.IsPublisher {
		t.Fatal("applications.owner = alice，IsPublisher 应为 true")
	}
	key := env.mgr.SessionKey(r, "my-app")
	if key == "" {
		t.Fatal("SessionKey 为空")
	}
	// §10.4 第 40 项：同一张 Cookie 在别的应用子域解析不出身份（app_id 绑定）。
	if u2 := env.mgr.CurrentUser(r, "other-app"); u2 != nil {
		t.Fatalf("应用 Cookie 在另一个应用子域解析出了身份：%+v", u2)
	}
	if k2 := env.mgr.SessionKey(r, "other-app"); k2 != "" {
		t.Fatalf("跨应用 SessionKey = %q", k2)
	}

	// 另一个应用兑换 ⇒ 会话键必须不同（每个 (会话, 应用) 一份）。
	code2 := env.issueTicketViaPOST(t, empCookie, "other-app", "/")
	rec2 := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec2, requestWithTicket("other-app", code2), "other-app"); !ok {
		t.Fatal("第二个应用兑换失败")
	}
	key2 := env.mgr.SessionKey(reqWithCookie(cookieByName(rec2.Result().Cookies(), AppCookieName)), "other-app")
	if key2 == "" || key2 == key {
		t.Fatalf("会话键未按 (会话, 应用) 区分：%q / %q", key, key2)
	}
}

// TestSessionKeyDiffersPerEmployeeSession 断言同一个用户在不同浏览器会话里
// 得到不同会话键（否则"按会话吊销"会误伤另一个浏览器）。
func TestSessionKeyDiffersPerEmployeeSession(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	keys := map[string]bool{}
	for i := 0; i < 2; i++ {
		empCookie, _ := env.loginAs(t, "alice")
		code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
		rec := httptest.NewRecorder()
		if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket("my-app", code), "my-app"); !ok {
			t.Fatal("兑换失败")
		}
		k := env.mgr.SessionKey(reqWithCookie(cookieByName(rec.Result().Cookies(), AppCookieName)), "my-app")
		if k == "" {
			t.Fatal("空会话键")
		}
		keys[k] = true
	}
	if len(keys) != 2 {
		t.Fatalf("两个浏览器会话得到 %d 个不同会话键，want 2", len(keys))
	}
}

// TestFullTicketFlowFromAppSubdomainToCleanURL 是 §6.1 链路①–⑤ 的端到端回归：
// 子域无 Cookie ⇒ 主站换票页（GET）⇒ 未登录跳登录页 ⇒ 登录 ⇒ 回到 /app-ticket
// ⇒ 同源 POST 发票 ⇒ 302 回子域 ⇒ 兑换 ⇒ 干净 URL。
func TestFullTicketFlowFromAppSubdomainToCleanURL(t *testing.T) {
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	env.newUser(t, "alice")

	// ① 主站换票的 POST（未登录）⇒ 302 登录页。
	first := httptest.NewRecorder()
	env.mgr.TicketSubmit(first, formReq(t, "/app-ticket", url.Values{
		"app": {"my-app"}, "next": {"/deep/path?x=1"},
	}))
	loginURL := first.Header().Get("Location")
	if !strings.HasPrefix(loginURL, "/login?next=") {
		t.Fatalf("未登录换票应跳登录页，得到 %q", loginURL)
	}

	// ② 用户跟随到登录页（GET），取出表单里的 next。
	page := httptest.NewRecorder()
	env.mgr.LoginPage(page, httpsReq(http.MethodGet, testMainOrigin+loginURL, nil))
	next := hiddenValue(t, page.Body.String(), "next")
	if !strings.HasPrefix(next, "/app-ticket?") {
		t.Fatalf("登录页的 next = %q", next)
	}

	// ③ 提交登录 ⇒ 303 回到 /app-ticket。
	login := httptest.NewRecorder()
	env.mgr.LoginSubmit(login, formReq(t, "/login", url.Values{
		"username": {"alice"}, "password": {testPassword}, "next": {next},
	}))
	if login.Code != http.StatusSeeOther {
		t.Fatalf("登录状态码 = %d", login.Code)
	}
	backURL := login.Header().Get("Location")
	if !strings.HasPrefix(backURL, "/app-ticket?") {
		t.Fatalf("登录后回跳 = %q（应回到 /app-ticket）", backURL)
	}
	empCookie := cookieByName(login.Result().Cookies(), EmployeeCookieName)

	// ④ 换票页 GET ⇒ 取出 next（嵌套编码应被正确还原）。
	ticketPage := httptest.NewRecorder()
	env.mgr.TicketPage(ticketPage, httpsReq(http.MethodGet, testMainOrigin+backURL, nil))
	innerNext := hiddenValue(t, ticketPage.Body.String(), "next")
	if innerNext != "/deep/path?x=1" {
		t.Fatalf("换票页 next = %q, want /deep/path?x=1（嵌套编码还原失败）", innerNext)
	}

	// ⑤ 同源 POST 发票 ⇒ 302 回子域。
	sub := formReq(t, "/app-ticket", url.Values{"app": {"my-app"}, "next": {innerNext}})
	sub.AddCookie(empCookie)
	issue := httptest.NewRecorder()
	env.mgr.TicketSubmit(issue, sub)
	if issue.Code != http.StatusFound {
		t.Fatalf("换票状态码 = %d", issue.Code)
	}
	loc := issue.Header().Get("Location")
	u, err := url.Parse(loc)
	if err != nil || u.Host != "my-app."+testBaseDomain {
		t.Fatalf("回跳 = %q", loc)
	}
	if u.Path != "/deep/path" || u.Query().Get("x") != "1" {
		t.Fatalf("回跳路径/参数丢失：%q", loc)
	}

	// ⑥ 子域兑换 ⇒ 干净 URL + Cookie。
	redeem := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(redeem, httpsReq(http.MethodGet, loc, nil), "my-app")
	if !ok {
		t.Fatal("兑换失败")
	}
	if clean != "/deep/path?x=1" {
		t.Fatalf("干净 URL = %q", clean)
	}
	if cookieByName(redeem.Result().Cookies(), AppCookieName) == nil {
		t.Fatal("兑换未下发应用 Cookie")
	}
}

// hiddenValue 从渲染出的表单里取隐藏域的值（html/template 会做属性转义，需还原）。
func hiddenValue(t *testing.T, body, name string) string {
	t.Helper()
	marker := `name="` + name + `" value="`
	i := strings.Index(body, marker)
	if i < 0 {
		t.Fatalf("页面里没有隐藏域 %s：%s", name, body)
	}
	rest := body[i+len(marker):]
	j := strings.IndexByte(rest, '"')
	if j < 0 {
		t.Fatalf("隐藏域 %s 的值没有闭合", name)
	}
	return html.UnescapeString(rest[:j])
}

// TestRevokeNotifiesAppSessionHook 断言登出时把被吊销的应用会话键回调出去
// （main.go 用它让 aichat 立即丢弃内存里的在手令牌，§10.4 第 46 项的进程内一半）。
func TestRevokeNotifiesAppSessionHook(t *testing.T) {
	var mu sync.Mutex
	revoked := map[string]bool{}
	env := newEnv(t, func(o *Options) {
		o.OnAppSessionRevoked = func(key string) {
			mu.Lock()
			revoked[key] = true
			mu.Unlock()
		}
	})
	env.newApp(t, "app-a", "alice")
	env.newApp(t, "app-b", "alice")
	empCookie, emp := env.loginAs(t, "alice")

	want := map[string]bool{}
	for _, appID := range []string{"app-a", "app-b"} {
		code := env.issueTicketViaPOST(t, empCookie, appID, "/")
		rec := httptest.NewRecorder()
		if _, ok := env.mgr.RedeemTicket(rec, requestWithTicket(appID, code), appID); !ok {
			t.Fatalf("%s 兑换失败", appID)
		}
		want[env.mgr.SessionKey(reqWithCookie(cookieByName(rec.Result().Cookies(), AppCookieName)), appID)] = true
	}
	if err := env.mgr.RevokeSession(t.Context(), emp.SessionID); err != nil {
		t.Fatalf("RevokeSession: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	for k := range want {
		if k == "" || !revoked[k] {
			t.Fatalf("应用会话键 %q 没有被回调吊销（已回调：%v）", k, revoked)
		}
	}
	if len(revoked) != len(want) {
		t.Fatalf("回调了 %d 个键，want %d", len(revoked), len(want))
	}
}

// TestAuditPanicDoesNotCrash 断言审计回调 panic 不会带崩进程（异步 goroutine
// 里的 panic 等于整个服务退出）。
func TestAuditPanicDoesNotCrash(t *testing.T) {
	var mu sync.Mutex
	calls := 0
	env := newEnv(t, func(o *Options) {
		o.Audit = func(string, string, string) {
			mu.Lock()
			calls++
			mu.Unlock()
			panic("审计回调炸了")
		}
	})
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	code := env.issueTicketViaPOST(t, empCookie, "my-app", "/")
	if _, ok := env.mgr.RedeemTicket(httptest.NewRecorder(), requestWithTicket("my-app", code), "my-app"); !ok {
		t.Fatal("兑换失败")
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		c := calls
		mu.Unlock()
		if c >= 3 { // login_success + ticket_issue + ticket_redeem
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("审计回调只被调用 %d 次（异步路径可能被 panic 打断）", calls)
}
