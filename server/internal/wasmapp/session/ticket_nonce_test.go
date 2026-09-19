package session

// ---- 换票的浏览器持有性证明（nonce Cookie，R1-sec-1 / 2026-09-19）----
//
// 攻击形态（主控真机复现）：任一登录员工 `POST /app-ticket` 拿到
// `https://<app>.<基域>/?ticket=<64hex>`，受害者在**全新 cookie jar** 里 GET 它
// ⇒ 302 + `Set-Cookie: picoaide_app=…` ⇒ 受害者的输入全部落在攻击者账号下。
//
// 本文件的用例就是那条链路的双向判据：
//   - 攻击面：全新 jar 的伪造链接**必须失败**，且响应里**没有** picoaide_app；
//   - 功能面：同一浏览器（主站登录 → POST /app-ticket → 带同一 jar GET 子域）
//     **必须继续成功**（302 + picoaide_app）。
//
// 变异验证（把闸门改回危险实现时，哪些用例必红）：
//   - RedeemTicket 去掉 nonce 比对（或"Cookie 缺失才拒、不比对值"）
//     ⇒ TestRedeemForgedLinkFromFreshJarIsRejected（缺失分支）与
//     TestRedeemNonceFromAnotherTicketRejected（比对分支）红；
//   - TicketSubmit 不再下发 nonce Cookie
//     ⇒ TestRedeemLegitChainInSameBrowserSucceeds 红；
//   - nonce Cookie 的 SameSite 改成 Lax ⇒ TestTicketIssueNonceCookieAttributes 红
//     （Lax 会随**跨站顶层 GET 导航**发送，而那正是攻击形态本身）；
//   - nonce Cookie 去掉 HttpOnly ⇒ 同上（应用子域是任意 JS 宿主，可被 document.cookie 覆盖）；
//   - ticketSecFetchVerdict 改成"头缺席即拒" ⇒ TestRedeemSecFetchAbsentKeepsLegitChainWorking 红；
//     改成"头存在即放行（不判值）" ⇒ TestRedeemSecFetchPresentAndHostileIsRejected 红；
//   - ticketNonceCookieDomain 去掉 domain-match 判定（域不匹配也发 Cookie）
//     ⇒ TestTicketIssueFallsBackWhenCookieDomainMismatch 红（那条用例钉的是"降级 + 留痕"）。

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// nonceEnv 是"主站 Host == 应用基域"的部署（应用地址形如 `my-app.harness.example.com`）。
//
// 只有这种形态（以及"主站是基域的子域"）才能下发覆盖 `<app>.<基域>` 的 Domain Cookie
// —— 见 ticketNonceCookieDomain。默认测试环境（基域 apps.example.com、主站
// harness.example.com）走的是**降级**路径，由 TestTicketIssueFallsBackWhenCookieDomainMismatch 覆盖。
func nonceEnv(t *testing.T) *testEnv {
	t.Helper()
	return newEnv(t, func(o *Options) {
		o.BaseDomain = func() string { return testMainHost }
	})
}

// issuedTicket 是一次签发的全部产物：票 code、这次响应下发的 nonce Cookie、
// 完整响应（断言 Set-Cookie 字节用），以及跳板页的跨源目标（= 真实浏览器会导航到的那条 URL）。
type issuedTicket struct {
	code   string
	nonce  *http.Cookie
	rec    *httptest.ResponseRecorder
	target string
}

// issueTicket 走完 POST /app-ticket 并解析出 code / nonce / 跳板页目标。
// nonce 为 nil = 该部署降级（未下发，见 ticket.nonce）。
func issueTicket(t *testing.T, env *testEnv, empCookie *http.Cookie, appID, next string) issuedTicket {
	t.Helper()
	r := formReq(t, "/app-ticket", url.Values{"app": {appID}, "next": {next}})
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("换票签发状态码 = %d, want 200（同源跳板页）；body=%s", rec.Code, rec.Body.String())
	}
	target := jumpTarget(t, rec.Body.String())
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("跳板页目标解析失败 %q: %v", target, err)
	}
	code := u.Query().Get("ticket")
	if code == "" {
		t.Fatalf("跳板页目标不含 ticket: %q", target)
	}
	return issuedTicket{
		code:   code,
		nonce:  cookieByName(rec.Result().Cookies(), TicketNonceCookieName),
		rec:    rec,
		target: target,
	}
}

// redeemReq 把"浏览器会导航到的目标 URL"变成一次子域 GET（可带 Cookie）。
//
// **用跳板页真实给出的 URL**、不自己拼：`next` 的路径与其余 query 都在里面，
// 兑换后返回的干净 URL 才与生产逐字节同形。
func redeemReq(t *testing.T, it issuedTicket, cookies ...*http.Cookie) *http.Request {
	t.Helper()
	r := httpsReq(http.MethodGet, it.target, nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	return r
}

// redeemCrossAppReq 是"降级部署 + 默认基域"下的兑换请求（appID 落在 testBaseDomain 上）。
func redeemCrossAppReq(t *testing.T, appID, code string, cookies ...*http.Cookie) *http.Request {
	t.Helper()
	r := httpsReq(http.MethodGet,
		"https://"+appID+"."+testBaseDomain+"/?ticket="+url.QueryEscape(code), nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	return r
}

// rawSetCookieFor 取指定名字那条 Set-Cookie 的**原始字节**（浏览器只认字节：
// 解析后的 Cookie 结构体看不到 `SameSite=Strict` 这类属性在线上到底怎么写的）。
func rawSetCookieFor(rec *httptest.ResponseRecorder, name string) string {
	for _, v := range rec.Header().Values("Set-Cookie") {
		if strings.HasPrefix(v, name+"=") {
			return v
		}
	}
	return ""
}

// TestTicketIssueNonceCookieAttributes 钉住 nonce Cookie 的**每一个属性**。
//
// 每一条都不是风格问题：Domain 决定应用子域收不收得到（收不到 = 合法链路断），
// SameSite=Strict 决定跨站导航带不带（Lax 会带上 = 攻击形态本身），
// HttpOnly 决定应用子域的 JS 能不能覆盖它（能覆盖 = 攻击者可自备 nonce）。
func TestTicketIssueNonceCookieAttributes(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie：伪造链接这道闸门等于不存在")
	}
	if len(it.nonce.Value) != 64 {
		t.Fatalf("nonce 长度 = %d, want 64（32 字节 crypto/rand 的 hex）", len(it.nonce.Value))
	}
	if it.nonce.Domain != testMainHost {
		t.Fatalf("Domain = %q, want %q（不写 Domain ⇒ 应用子域收不到，合法链路必断）", it.nonce.Domain, testMainHost)
	}
	if it.nonce.Path != "/" {
		t.Fatalf("Path = %q, want /", it.nonce.Path)
	}
	if !it.nonce.HttpOnly {
		t.Fatal("nonce Cookie 必须 HttpOnly（应用子域的 JS 不得覆盖它）")
	}
	if !it.nonce.Secure {
		t.Fatal("nonce Cookie 必须 Secure")
	}
	if it.nonce.SameSite != http.SameSiteStrictMode {
		t.Fatalf("SameSite = %v, want Strict（Lax 会随跨站顶层 GET 导航发送 = 攻击形态）", it.nonce.SameSite)
	}
	if it.nonce.MaxAge != int(limits.TicketTTL.Seconds()) {
		t.Fatalf("MaxAge = %d, want %d（与票同寿命）", it.nonce.MaxAge, int(limits.TicketTTL.Seconds()))
	}
	// 原始字节面（结构体断言看不到"浏览器实际收到的那一行"）。
	raw := rawSetCookieFor(it.rec, TicketNonceCookieName)
	if raw == "" {
		t.Fatalf("响应里没有 %s 的 Set-Cookie：%v", TicketNonceCookieName, it.rec.Header().Values("Set-Cookie"))
	}
	for _, want := range []string{
		"Domain=" + testMainHost,
		"Path=/",
		"HttpOnly",
		"Secure",
		"SameSite=Strict",
	} {
		if !strings.Contains(raw, want) {
			t.Fatalf("Set-Cookie 缺少 %q：%q", want, raw)
		}
	}
	if strings.Contains(raw, "SameSite=Lax") || strings.Contains(raw, "SameSite=None") {
		t.Fatalf("Set-Cookie 的 SameSite 被放宽了：%q", raw)
	}
}

// TestRedeemForgedLinkFromFreshJarIsRejected 是攻击面的**第一判据**：
// 攻击者拿到自己的票链接，受害者在全新 cookie jar（一个 Cookie 都没有）里打开 ⇒
// 兑换必须失败，响应里必须**没有** picoaide_app，且库里不得多出应用会话行。
//
// 变异验证：去掉 RedeemTicket 里的 nonce 判据 ⇒ 本用例第一条断言即红
// （伪造链接换出会话 = 原始 P0 形态）。
func TestRedeemForgedLinkFromFreshJarIsRejected(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, emp := env.loginAs(t, "alice")

	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}

	// 受害者的请求：**不带任何 Cookie**（全新 jar），其余形态与浏览器一致。
	victim := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(victim, redeemReq(t, it), "my-app")
	if ok {
		t.Fatalf("伪造链接在全新 jar 里兑换成功（登录 CSRF / 会话固定）：clean=%q", clean)
	}
	if c := cookieByName(victim.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
	}
	if raw := victim.Header().Get("Set-Cookie"); strings.Contains(raw, AppCookieName) {
		t.Fatalf("响应头里出现应用会话 Cookie：%q", raw)
	}
	if n := countRows(t, env, fmt.Sprintf(`SELECT count(*) FROM app_sessions WHERE user_id = %d`, emp.ID)); n != 0 {
		t.Fatalf("被拒的兑换仍然在**攻击者**账号下落了 %d 行 app_sessions（want 0）", n)
	}
	// 票必须已经烧掉（一次性无条件优先）：否则一个已知 code 可以被反复拿来探测 nonce。
	if n := env.mgr.tickets.size(); n != 0 {
		t.Fatalf("被拒之后在途票数 = %d, want 0（票必须一次性消费掉）", n)
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_absent") {
		t.Fatalf("兑换被拒的审计细节 = %q, want 含 rejected=nonce_absent", detail)
	}

	// 攻击者自己那只浏览器仍然能用这张票吗？——不能：票已经被上面那次拒绝烧掉了。
	owner := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(owner, redeemReq(t, it, it.nonce), "my-app"); ok {
		t.Fatal("票在伪造链接被拒之后还能兑换（一次性语义被破坏）")
	}
	if n := countRows(t, env, `SELECT count(*) FROM app_sessions`); n != 0 {
		t.Fatalf("全表 app_sessions 行数 = %d, want 0", n)
	}
}

// TestRedeemLegitChainInSameBrowserSucceeds 是功能面的判据（**不许为了安全把链路修死**）：
// 主站登录 → POST /app-ticket（收到 nonce Cookie）→ 带同一 jar GET 子域 ⇒ 302 + picoaide_app，
// 且解析出的身份就是登录的那个人。
func TestRedeemLegitChainInSameBrowserSucceeds(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, emp := env.loginAs(t, "alice")

	it := issueTicket(t, env, empCookie, "my-app", "/dash?tab=1")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}

	// 同一只浏览器：把签发时收到的 nonce 原样带上（真实浏览器靠 Domain=应用基域 自动完成）。
	rec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(rec, redeemReq(t, it, it.nonce), "my-app")
	if !ok {
		t.Fatal("同一浏览器的合法链路兑换失败（非 https？nonce 没带上？见日志与响应头）")
	}
	if clean != "/dash?tab=1" {
		t.Fatalf("干净 URL = %q, want /dash?tab=1（票据必须被剥掉、其余参数保留）", clean)
	}
	appCk := cookieByName(rec.Result().Cookies(), AppCookieName)
	if appCk == nil {
		t.Fatal("合法链路没有下发应用会话 Cookie")
	}
	if raw := rec.Header().Get("Set-Cookie"); !strings.Contains(raw, AppCookieName) {
		t.Fatalf("Set-Cookie 头里没有 %s：%q", AppCookieName, raw)
	}
	// 身份必须解析成登录者本人（帧内身份的唯一种子就是这个 Cookie）。
	r := httpsReq(http.MethodGet, "https://my-app."+testMainHost+"/api/facts", nil)
	r.AddCookie(appCk)
	id, ok := env.mgr.Resolve(r, "my-app")
	if !ok || id.User == nil {
		t.Fatal("兑换出来的应用会话解析不出身份")
	}
	if id.User.ID != emp.ID || id.User.Username != "alice" {
		t.Fatalf("帧内身份 = (%d,%s), want (%d,alice)", id.User.ID, id.User.Username, emp.ID)
	}
	if n := countRows(t, env, `SELECT count(*) FROM app_sessions`); n != 1 {
		t.Fatalf("app_sessions 行数 = %d, want 1", n)
	}
}

// TestRedeemReplayRejectedEvenWithNonceCookie 钉住"票仍然一次性"：合法链路成功之后，
// 同一只浏览器拿同一张票再来一次（带 nonce）也必须失败。
func TestRedeemReplayRejectedEvenWithNonceCookie(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}

	first := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(first, redeemReq(t, it, it.nonce), "my-app"); !ok {
		t.Fatal("首次兑换应当成功")
	}
	second := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(second, redeemReq(t, it, it.nonce), "my-app"); ok {
		t.Fatal("重放兑换成功了（票不再是一次性）")
	}
	if c := cookieByName(second.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("重放被拒但仍然下发了应用会话 Cookie：%+v", c)
	}
	if n := countRows(t, env, `SELECT count(*) FROM app_sessions`); n != 1 {
		t.Fatalf("app_sessions 行数 = %d, want 1（重放不得多落一行）", n)
	}
}

// TestRedeemNonceFromAnotherTicketRejected 钉住"nonce 是**这一张票**的"：
// 同一浏览器、同一个应用、同一个人 —— 但拿着**另一张票**的 nonce 去兑换本票 ⇒ 拒。
//
// 这条是"持有某个 nonce"与"持有这张票的 nonce"的差别，也是本修复的绑定本体。
func TestRedeemNonceFromAnotherTicketRejected(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	t1 := issueTicket(t, env, empCookie, "my-app", "/one")
	t2 := issueTicket(t, env, empCookie, "my-app", "/two")
	if t1.nonce == nil || t2.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}
	if t1.nonce.Value == t2.nonce.Value {
		t.Fatal("两张票的 nonce 相同（每次签发必须重新生成）")
	}

	// 用票 2 的 nonce 兑换票 1 ⇒ 拒，且响应里不得有应用会话 Cookie。
	crossed := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(crossed, redeemReq(t, t1, t2.nonce), "my-app"); ok {
		t.Fatal("用另一张票的 nonce 兑换成功了（nonce 没绑到具体票）")
	}
	if c := cookieByName(crossed.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("跨票 nonce 被拒但仍然下发了应用会话 Cookie：%+v", c)
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_mismatch") {
		t.Fatalf("审计细节 = %q, want 含 rejected=nonce_mismatch", detail)
	}
	// 票 1 已被那次拒绝烧掉 —— 即使随后拿它自己的 nonce 也兑换不出来。
	late := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(late, redeemReq(t, t1, t1.nonce), "my-app"); ok {
		t.Fatal("非匹配的 nonce 尝试没有把票烧掉（可被反复探测）")
	}
	// 而票 2 完全不受影响：跨票尝试烧掉的是**被兑换的那张票**，不是别人手里的票。
	second := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(second, redeemReq(t, t2, t2.nonce), "my-app"); !ok {
		t.Fatal("跨票尝试把另一张票也烧掉了（一次性语义的范围过大）")
	}
}

// TestRedeemSecFetchAbsentKeepsLegitChainWorking 是判据④：**老浏览器不发 Sec-Fetch-\***
// 时合法链路不受影响（放行），但必须留一条日志 —— "放行了但判据缺席"是安全事件。
func TestRedeemSecFetchAbsentKeepsLegitChainWorking(t *testing.T) {
	prev := logWarn
	defer func() { logWarn = prev }()
	var lines []string
	logWarn = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }

	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}

	r := redeemReq(t, it, it.nonce)
	if r.Header.Get("Sec-Fetch-Site") != "" || r.Header.Get("Sec-Fetch-Mode") != "" {
		t.Fatal("本用例的前提是请求不带 Sec-Fetch-*（httptest 不该自己加）")
	}
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, r, "my-app"); !ok {
		t.Fatal("缺少 Sec-Fetch-* 时合法链路被拒了（不能把老浏览器一刀切）")
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c == nil {
		t.Fatal("缺少 Sec-Fetch-* 时没有下发应用会话 Cookie")
	}
	var sawAbsent bool
	for _, l := range lines {
		if strings.Contains(l, "缺少 Sec-Fetch-* 头（放行）") {
			sawAbsent = true
		}
	}
	if !sawAbsent {
		t.Fatalf("头缺席时放行了但没留日志：%v", lines)
	}
}

// TestRedeemSecFetchPresentAndHostileIsRejected 是纵深判据：头**存在**且不符必须拒，
// 即使 nonce 完全正确（模拟"nonce 泄漏 + 跨站导航"的最坏组合）。
func TestRedeemSecFetchPresentAndHostileIsRejected(t *testing.T) {
	cases := []struct {
		name         string
		site, mode   string
		wantRejected bool
	}{
		{"跨站顶层导航（点开别人发来的链接）", "cross-site", "navigate", true},
		{"跨站子资源（iframe/img/fetch）", "cross-site", "no-cors", true},
		{"同站但非导航（应用自己 fetch 试探）", "same-site", "cors", true},
		{"同站导航（合法链路形态）", "same-site", "navigate", false},
		{"自身源导航", "same-origin", "navigate", false},
		{"无 initiator 导航（地址栏粘贴/书签）", "none", "navigate", false},
		{"同站导航但站判据大小写混杂", "Same-Site", "Navigate", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := nonceEnv(t)
			env.newApp(t, "my-app", "alice")
			empCookie, _ := env.loginAs(t, "alice")
			it := issueTicket(t, env, empCookie, "my-app", "/")
			if it.nonce == nil {
				t.Fatal("签发换票未下发 nonce Cookie")
			}
			r := redeemReq(t, it, it.nonce)
			r.Header.Set("Sec-Fetch-Site", tc.site)
			r.Header.Set("Sec-Fetch-Mode", tc.mode)
			rec := httptest.NewRecorder()
			_, ok := env.mgr.RedeemTicket(rec, r, "my-app")
			if ok != !tc.wantRejected {
				t.Fatalf("Sec-Fetch-Site=%q Mode=%q：兑换 ok=%v, want %v（响应头=%v）",
					tc.site, tc.mode, ok, !tc.wantRejected, rec.Header())
			}
			if tc.wantRejected {
				if c := cookieByName(rec.Result().Cookies(), AppCookieName); c != nil {
					t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
				}
			} else if c := cookieByName(rec.Result().Cookies(), AppCookieName); c == nil {
				t.Fatal("合法形态的 Sec-Fetch 被判据拒了")
			}
		})
	}
}

// TestTicketIssueFallsBackWhenCookieDomainMismatch 钉住**已知残留**（要认账，不假装解决）：
// 主站 Host 与应用基域不共享可写域时（默认测试环境：主站 harness.example.com、
// 基域 apps.example.com），浏览器会拒收 Domain=apps.example.com 的 Cookie ⇒
// 签发侧必须**降级为不发 nonce** 并留一条 error 日志，否则合法链路会整条断掉。
//
// ⚠️ 本用例第二段断言的是"降级后不带 nonce 的链接**能**兑换成功"——**这是残留，不是期望行为**。
// 把它钉成断言是为了让降级**可见**：若日后改成 fail-closed（例如拒绝签发/拒绝兑换），
// 这段断言会红，那时请同步更新报告 temp/wasm-review-r1/fix-sec1.md 与部署文档。
func TestTicketIssueFallsBackWhenCookieDomainMismatch(t *testing.T) {
	prev := logError
	defer func() { logError = prev }()
	var lines []string
	logError = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }

	// 默认环境：testBaseDomain=apps.example.com ≠ 主站 harness.example.com。
	env := newEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce != nil {
		t.Fatalf("域不匹配的部署仍然下发了 Domain Cookie（浏览器会拒收，合法链路必断）：%+v", it.nonce)
	}
	var sawDegrade bool
	for _, l := range lines {
		if strings.Contains(l, "无法为应用基域下发换票 nonce Cookie") {
			sawDegrade = true
		}
	}
	if !sawDegrade {
		t.Fatalf("降级没有留痕（这是「为什么这台部署挡不住伪造链接」的唯一现场）：%v", lines)
	}

	// 1) 合法链路照常可用（降级不等于修死）。
	legit := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(legit, redeemCrossAppReq(t, "my-app", it.code), "my-app"); !ok {
		t.Fatal("降级部署下合法链路被拒了")
	}
	if c := cookieByName(legit.Result().Cookies(), AppCookieName); c == nil {
		t.Fatal("降级部署下没有下发应用会话 Cookie")
	}

	// 2) Sec-Fetch 纵深在降级部署下**仍然生效**（这正是"回落判据"的含义）。
	it2 := issueTicket(t, env, empCookie, "my-app", "/")
	cross := redeemCrossAppReq(t, "my-app", it2.code)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.Header.Set("Sec-Fetch-Mode", "navigate")
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, cross, "my-app"); ok {
		t.Fatal("降级部署下跨站导航仍被兑换（回落判据没生效）")
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
	}

	// 3) 残留（见函数注释）：没有 nonce 就没有"同一只浏览器"这个判据。
	it3 := issueTicket(t, env, empCookie, "my-app", "/")
	fresh := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(fresh, redeemCrossAppReq(t, "my-app", it3.code), "my-app"); !ok {
		t.Fatal("降级部署的行为变了（若已改为 fail-closed，请更新报告与文档，而不是删掉这条断言）")
	}
}
