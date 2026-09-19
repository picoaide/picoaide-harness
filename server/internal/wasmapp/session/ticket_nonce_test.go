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
// 第二轮（回归审计 P0，2026-09-19）：**降级不能由请求方选**。初版按 r.Host 判"能否下发
// nonce"，于是任何别名主机名（IP 直连/旧域名/反代域名）都能把闸门按请求关掉。现在的
// 判据是"只读服务端配置 + 签发侧 fail-closed + 兑换侧对 nonce 为空的票一律拒"。
//
// 变异验证（把闸门改回危险实现时，哪些用例必红）：
//   - RedeemTicket 去掉 nonce 比对（或"Cookie 缺失才拒、不比对值"）
//     ⇒ TestRedeemForgedLinkFromFreshJarIsRejected（缺失分支）与
//     TestRedeemNonceFromAnotherTicketRejected（比对分支）红；
//   - **RedeemTicket 去掉 `t.nonce == ""` 的 fail-closed**
//     ⇒ TestRedeemRejectsTicketWithoutNonceBinding 红（回归审计要求的第 4 条变异）；
//   - **ticketNoncePlan 改回按 r.Host 判定**（初版实现）
//     ⇒ TestAliasHostCannotGetNonceLessTicket 红（别名 Host 又能签出无 nonce 的票）；
//   - TicketSubmit 不再下发 nonce Cookie ⇒ TestRedeemLegitChainInSameBrowserSucceeds 红；
//   - nonce Cookie 的 SameSite 改成 Lax ⇒ TestTicketIssueNonceCookieAttributes 红
//     （Lax 会随**跨站顶层 GET 导航**发送，而那正是攻击形态本身）；
//   - nonce Cookie 去掉 HttpOnly ⇒ 同上（应用子域是任意 JS 宿主，可被 document.cookie 覆盖）；
//   - ticketSecFetchVerdict 改成"头缺席即拒" ⇒ TestRedeemSecFetchAbsentKeepsLegitChainWorking 红；
//     改成"头存在即放行（不判值）" ⇒ TestRedeemSecFetchPresentAndHostileIsRejected 红。

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 测试用的别名主机名（不属于基域）：IP 直连/旧域名/反代域名在 edge.HostGate 里都是
// HostMain，因此主站路由（含 /app-ticket）在它上面照常服务 —— 这正是回归审计那条 P0 的入口。
const (
	testAliasHost   = "picoaide-alias.example.org"
	testAliasOrigin = "https://picoaide-alias.example.org"
)

// nonceEnv 是"主站源已配置且等于应用基域"的部署（应用地址形如 `my-app.harness.example.com`）：
// 这是唯一能下发 nonce Cookie 的形态，也是生产推荐形态。
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
// nonce 为 nil = 该部署显式降级（未下发，见 ticket.nonce）。
func issueTicket(t *testing.T, env *testEnv, empCookie *http.Cookie, appID, next string) issuedTicket {
	t.Helper()
	r := formReq(t, "/app-ticket", url.Values{"app": {appID}, "next": {next}})
	r.AddCookie(empCookie)
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	if rec.Code != http.StatusOK {
		t.Fatalf("换票签发状态码 = %d, want 200（同源跳板页）；body=%s", rec.Code, rec.Body.String())
	}
	return parseIssuedTicket(t, rec)
}

// parseIssuedTicket 从一次 **200 的跳板页响应**里取出 code / nonce / 目标 URL。
func parseIssuedTicket(t *testing.T, rec *httptest.ResponseRecorder) issuedTicket {
	t.Helper()
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

// appTicketReqOn 构造某个基域下应用子域的带票 GET（可带 Cookie）。
func appTicketReqOn(baseDomain, appID, code string, cookies ...*http.Cookie) *http.Request {
	r := httpsReq(http.MethodGet,
		"https://"+appID+"."+baseDomain+"/?ticket="+url.QueryEscape(code), nil)
	for _, c := range cookies {
		r.AddCookie(c)
	}
	return r
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

// captureLogs 临时替换某个日志落点，返回读取已捕获行的函数（测试结束时自动还原）。
//
// 用它而不是直接断言"没崩"：本修复的关键语义（fail-closed、显式降级、判据缺席放行）
// **必须留痕**，否则线上只看到 500/403 而答不出原因。
func captureLogs(t *testing.T, sink *func(format string, args ...any)) func() []string {
	t.Helper()
	prev := *sink
	var lines []string
	*sink = func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	t.Cleanup(func() { *sink = prev })
	return func() []string { return lines }
}

// hasLog 报告已捕获的日志里是否有任意一行包含 needle。
func hasLog(lines []string, needle string) bool {
	for _, l := range lines {
		if strings.Contains(l, needle) {
			return true
		}
	}
	return false
}

// issueRaw 直接驱动 TicketSubmit（可选改 Host/Origin —— 模拟别名主机名），返回响应。
func issueRaw(t *testing.T, env *testEnv, empCookie *http.Cookie, appID, host, origin string) *httptest.ResponseRecorder {
	t.Helper()
	r := formReq(t, "/app-ticket", url.Values{"app": {appID}, "next": {"/"}})
	if host != "" {
		r.Host = host
	}
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if empCookie != nil { // nil = 未登录（AddCookie(nil) 会 panic，这里显式跳过）
		r.AddCookie(empCookie)
	}
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	return rec
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
// 这条是"持有某个 nonce"与"持有这张票的 nonce"的差别，也是绑定的本体。
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
	lines := captureLogs(t, &logWarn)

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
	if !hasLog(lines(), "缺少 Sec-Fetch-* 头（放行）") {
		t.Fatalf("头缺席时放行了但没留日志：%v", lines())
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

// ===== 回归审计 P0（2026-09-19 二轮）：降级不能由请求方选 =====

// TestAliasHostCannotGetNonceLessTicket 是回归审计那条 P0 的门禁：**Host 不再是降级开关**。
//
// 初版实现里，任何"不属于基域"的别名主机名（IP 直连/旧域名/反代域名）都会让
// TicketSubmit 走"降级"分支 ⇒ 签出的票 nonce 为空 ⇒ 兑换侧整条跳过持有性证明 ⇒
// 受害者在全新 cookie jar 里照样兑换成功（与修复前同一个形态）。本用例钉住：
//  1. 对外地址已配置（生产推荐）：别名 Host 的 POST 被来源断言挡下（403），一张票都不签；
//  2. 对外地址未配置：判定按**应用基域推导**（配置事实），票**照常带 nonce** ——
//     但别名主机存不下 Domain=基域 的 Cookie ⇒ 那条链接在全新 jar 里兑换失败（fail-closed）；
//  3. 对外地址配成与基域不同域：拒绝签发票（而不是"静默降级成无 nonce 的票"）。
func TestAliasHostCannotGetNonceLessTicket(t *testing.T) {
	t.Run("对外地址已配置：别名 Host 连票都拿不到（403）", func(t *testing.T) {
		env := nonceEnv(t) // MainOrigin = testMainOrigin（配置齐全）
		env.newApp(t, "my-app", "alice")
		empCookie, _ := env.loginAs(t, "alice")

		rec := issueRaw(t, env, empCookie, "my-app", testAliasHost, testAliasOrigin)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("别名 Host 的换票签发应被来源断言挡下（403），得到 %d body=%.200s",
				rec.Code, rec.Body.String())
		}
		if n := env.mgr.tickets.size(); n != 0 {
			t.Fatalf("别名 Host 签出了 %d 张票（want 0）", n)
		}
		if cookieByName(rec.Result().Cookies(), TicketNonceCookieName) != nil ||
			cookieByName(rec.Result().Cookies(), AppCookieName) != nil {
			t.Fatalf("被拒的响应里出现了 Cookie：%v", rec.Header().Values("Set-Cookie"))
		}
	})

	t.Run("对外地址未配置：按基域推导 ⇒ 票带 nonce，别名主机兑换不出会话", func(t *testing.T) {
		lines := captureLogs(t, &logError)
		info := captureLogs(t, &logInfo)
		env := newEnv(t, func(o *Options) { o.MainOrigin = "" })
		env.newApp(t, "my-app", "alice")
		empCookie, _ := env.loginAs(t, "alice")

		// 别名 Host：checkMainOrigin 按请求推导（self == alias）⇒ 来源这关能过。
		// 但"能否下发 nonce"只读配置：对外地址未配置 ⇒ 按应用基域推导 ⇒ required。
		// 初版在这里会"成功签发一张 nonce 为空的票"（被审计的 P0 形态）。
		rec := issueRaw(t, env, empCookie, "my-app", testAliasHost, testAliasOrigin)
		if rec.Code != http.StatusOK {
			t.Fatalf("对外地址未配置时应按基域推导并照常签发票（200），得到 %d body=%.200s",
				rec.Code, rec.Body.String())
		}
		it := parseIssuedTicket(t, rec)
		if it.nonce == nil {
			t.Fatal("推导模式下没有下发 nonce Cookie：别名 Host 又能签出无持有性证明的票（P0 回归）")
		}
		if it.nonce.Domain != testMainHost {
			t.Fatalf("nonce Cookie 的 Domain = %q, want %q（推导值必须来自配置里的基域）",
				it.nonce.Domain, testMainHost)
		}
		if !hasLog(info(), "已按应用基域推导主站源") {
			t.Fatalf("推导生效没有 info 留痕：%v", info())
		}
		if hasLog(lines(), "拒绝签发换票") {
			t.Fatalf("推导模式不应出现「拒签」日志：%v", lines())
		}

		// 受害者的全新 jar 打开这条链接：浏览器**没有**这条 nonce（它是别名主机下发的、
		// 在该主机上根本存不下）⇒ 兑换必须失败且不签发应用会话 Cookie。
		victim := httptest.NewRecorder()
		if _, ok := env.mgr.RedeemTicket(victim, redeemReq(t, it), "my-app"); ok {
			t.Fatal("别名 Host 签出的票在全新 jar 里兑换成功（P0 形态）")
		}
		if c := cookieByName(victim.Result().Cookies(), AppCookieName); c != nil {
			t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
		}
		if n := countRows(t, env, `SELECT count(*) FROM app_sessions`); n != 0 {
			t.Fatalf("被拒的兑换落了 %d 行 app_sessions（want 0）", n)
		}
	})

	t.Run("对外地址与基域不同域：拒绝签发票（而不是静默降级）", func(t *testing.T) {
		lines := captureLogs(t, &logError)
		env := newEnv(t, func(o *Options) {
			o.BaseDomain = func() string { return "apps.example.com" }
			o.MainOrigin = testMainOrigin // harness.example.com 与 apps.example.com 不同域
		})
		env.newApp(t, "my-app", "alice")
		empCookie, _ := env.loginAs(t, "alice")

		rec := issueRaw(t, env, empCookie, "my-app", "", "")
		if rec.Code != http.StatusInternalServerError {
			t.Fatalf("域不匹配的部署应拒绝签发票（500），得到 %d body=%.200s", rec.Code, rec.Body.String())
		}
		if n := env.mgr.tickets.size(); n != 0 {
			t.Fatalf("域不匹配的部署签出了 %d 张票（want 0）", n)
		}
		if rawSetCookieFor(rec, TicketNonceCookieName) != "" {
			t.Fatal("域不匹配时不得下发 nonce Cookie（浏览器会拒收，合法链路也会失败）")
		}
		if !hasLog(lines(), "拒绝签发换票") {
			t.Fatalf("拒绝签发没有留痕：%v", lines())
		}
		if detail := env.audit.waitFor(t, "app_ticket_issue"); !strings.Contains(detail, "rejected=nonce_unavailable") {
			t.Fatalf("审计细节 = %q, want 含 rejected=nonce_unavailable", detail)
		}
	})
}

// TestDerivedMainOriginKeepsTicketFlowUsable 是"加固不许把正常链路修死"的判据：
// **对外地址未配置 + 基域已配置**（现网两套环境的形态）时，换票必须**照常可用**，
// 而不是 500/拒绝 —— 判定按配置里的应用基域推导主站源（`<scheme>://<基域>`）。
//
// 这是"只从服务端配置取值"的推导：绝不用 r.Host（那正是被审计打穿的洞）。
func TestDerivedMainOriginKeepsTicketFlowUsable(t *testing.T) {
	info := captureLogs(t, &logInfo)
	env := newEnv(t, func(o *Options) { o.MainOrigin = "" }) // 对外地址未配置
	env.newApp(t, "my-app", "alice")
	empCookie, emp := env.loginAs(t, "alice")

	// 判定依据必须是配置里的基域（而不是请求 Host）。
	dec := env.mgr.ticketNonceDecision()
	if dec.Plan != ticketNonceRequired || !dec.Derived {
		t.Fatalf("判定 = %+v, want required + Derived", dec)
	}
	if dec.MainOrigin != testMainOrigin || dec.CookieDomain != testMainHost {
		t.Fatalf("推导值 = %q / domain %q, want %q / %q",
			dec.MainOrigin, dec.CookieDomain, testMainOrigin, testMainHost)
	}

	// 换票全链路照常可用。
	it := issueTicket(t, env, empCookie, "my-app", "/dash")
	if it.nonce == nil {
		t.Fatal("推导模式下没有下发 nonce Cookie")
	}
	rec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(rec, redeemReq(t, it, it.nonce), "my-app")
	if !ok {
		t.Fatal("推导模式下换票不可用（这正是本次加固要避免的功能回归）")
	}
	if clean != "/dash" {
		t.Fatalf("干净 URL = %q, want /dash", clean)
	}
	appCk := cookieByName(rec.Result().Cookies(), AppCookieName)
	if appCk == nil {
		t.Fatal("推导模式下没有下发应用会话 Cookie")
	}
	r := httpsReq(http.MethodGet, "https://my-app."+testMainHost+"/api/facts", nil)
	r.AddCookie(appCk)
	id, ok := env.mgr.Resolve(r, "my-app")
	if !ok || id.User == nil || id.User.ID != emp.ID {
		t.Fatalf("推导模式下解析不出本人身份：%+v", id)
	}
	if !hasLog(info(), "已按应用基域推导主站源") {
		t.Fatalf("推导说明没有落 info 日志：%v", info())
	}
}

// TestDerivedMainOriginIsConfigOnly 钉住推导分支的三条硬性质：
//  1. scheme 取自**基域配置**（http 部署推导 http 源，不被悄悄改成 https）；
//  2. 推导说明**只落一条**日志（换票每次应用登录都会发生，逐次打印会刷满日志）；
//  3. 基域未配置时**不涉及换票**（TicketSubmit 直接 404，不产生换票日志/审计）。
func TestDerivedMainOriginIsConfigOnly(t *testing.T) {
	t.Run("scheme 取自基域配置（http 部署推导 http 源）", func(t *testing.T) {
		m := New(Options{BaseDomain: func() string { return "http://apps.example.com" }})
		dec := m.ticketNonceDecision()
		if !dec.Derived || dec.MainOrigin != "http://apps.example.com" {
			t.Fatalf("推导值 = %q（Derived=%v），want http://apps.example.com", dec.MainOrigin, dec.Derived)
		}
	})

	t.Run("推导说明只落一条日志", func(t *testing.T) {
		lines := captureLogs(t, &logInfo)
		m := New(Options{BaseDomain: func() string { return testMainHost }})
		for i := 0; i < 5; i++ {
			m.ticketNonceDecision()
		}
		n := 0
		for _, l := range lines() {
			if strings.Contains(l, "已按应用基域推导主站源") {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("推导说明落了 %d 条日志，want 1：%v", n, lines())
		}
	})

	t.Run("基域未配置：换票端点不涉及（404，无日志无审计）", func(t *testing.T) {
		logs := captureLogs(t, &logError)
		env := newEnv(t, func(o *Options) {
			o.BaseDomain = func() string { return "" }
			o.MainOrigin = ""
		})
		rec := issueRaw(t, env, nil, "my-app", testMainHost, testMainOrigin)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("未启用应用子域时 /app-ticket 应 404，得到 %d", rec.Code)
		}
		if env.mgr.tickets.size() != 0 {
			t.Fatal("未启用应用子域时不应签发票")
		}
		if len(logs()) != 0 {
			t.Fatalf("未启用应用子域时不应产生换票日志：%v", logs())
		}
	})
}

// TestRedeemRejectsTicketWithoutNonceBinding 是"兑换侧 fail-closed"的判据（回归审计修法 1）：
// **票上没有 nonce ⇒ 一律拒**，即使 Sec-Fetch 判据全部"合法"。
//
// 为什么需要它：nonce 为空的票意味着"这张票没有任何浏览器持有性证明"，只剩 Sec-Fetch；
// 而 Sec-Fetch 挡不住地址栏粘贴（`Site: none`）与缺席头。历史票、以及任何我们没预料到的
// 签发路径，都必须在这里被挡住 —— 而不是"因为签发侧没给 nonce 就放行"。
//
// 变异验证（回归审计要求的第 4 条）：把 RedeemTicket 里 `t.nonce == ""` 的 fail-closed
// 去掉 ⇒ 本用例第一条断言即红。
func TestRedeemRejectsTicketWithoutNonceBinding(t *testing.T) {
	env := nonceEnv(t) // 默认部署：AllowTicketWithoutNonce=false
	env.newApp(t, "my-app", "alice")
	_, emp := env.loginAs(t, "alice")

	// 直接注入一张"没有 nonce"的票（白盒：模拟历史票 / 未知签发路径）。
	code, err := newSecret()
	if err != nil {
		t.Fatalf("newSecret: %v", err)
	}
	now := env.now()
	env.mgr.tickets.issue(code, ticket{
		userID:            emp.ID,
		appID:             "my-app",
		employeeSessionID: emp.SessionID,
		expiresAt:         now.Add(limits.TicketTTL),
		// nonce 留空 = 没有浏览器持有性证明
	}, now)

	// 连"最友好"的请求形态（同站导航）都必须拒 —— 没有 nonce 就没有绑定的对象。
	r := appTicketReqOn(testBaseDomain, "my-app", code)
	r.Header.Set("Sec-Fetch-Site", "same-site")
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	rec := httptest.NewRecorder()
	if clean, ok := env.mgr.RedeemTicket(rec, r, "my-app"); ok {
		t.Fatalf("nonce 为空的票被兑换成功（无浏览器持有性证明）：clean=%q", clean)
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
	}
	if n := countRows(t, env, `SELECT count(*) FROM app_sessions`); n != 0 {
		t.Fatalf("被拒的兑换落了 %d 行 app_sessions（want 0）", n)
	}
	// 票仍按一次性消费掉（否则一个已知 code 可以被反复拿来探测）。
	if n := env.mgr.tickets.size(); n != 0 {
		t.Fatalf("在途票数 = %d, want 0", n)
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_unbound") {
		t.Fatalf("审计细节 = %q, want 含 rejected=nonce_unbound", detail)
	}
}

// TestDegradedDeploymentNeedsExplicitOptIn 钉住**显式降级**部署的语义（回归审计修法 1 的例外）：
// 只有部署方显式配置 AllowTicketWithoutNonce=true 才允许"没有 nonce 的票"被兑换，
// 且每次签发与兑换都要 ERROR 级留痕 + 审计 —— 正常链路仍然可用（别把它修死），
// 但 Sec-Fetch 纵深不退化（跨站导航照样拒）。
func TestDegradedDeploymentNeedsExplicitOptIn(t *testing.T) {
	logs := captureLogs(t, &logError)
	env := newEnv(t, func(o *Options) {
		// 本部署确实无法下发 nonce：配置的对外地址与基域**不同域**。
		// （留空不再代表"无法下发"——留空会按应用基域推导，那是正常路径。）
		o.BaseDomain = func() string { return "apps.example.com" }
		o.MainOrigin = testMainOrigin    // harness.example.com ≠ apps.example.com
		o.AllowTicketWithoutNonce = true // 部署方显式接受该风险
	})
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	it := issueTicket(t, env, empCookie, "my-app", "/dash")
	if it.nonce != nil {
		t.Fatalf("显式降级部署不应下发 nonce Cookie：%+v", it.nonce)
	}
	if detail := env.audit.waitFor(t, "app_ticket_issue"); !strings.Contains(detail, "nonce=disabled(configured)") {
		t.Fatalf("降级签发的审计细节 = %q, want 含 nonce=disabled(configured)", detail)
	}
	if !hasLog(logs(), "显式允许**无 nonce** 的换票") {
		t.Fatalf("降级签发没有 ERROR 留痕：%v", logs())
	}

	// 1) 正常链路仍然可用（降级 ≠ 修死）。
	rec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(rec, redeemReq(t, it), "my-app")
	if !ok {
		t.Fatal("显式降级部署下合法链路被拒了")
	}
	if clean != "/dash" {
		t.Fatalf("干净 URL = %q, want /dash", clean)
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c == nil {
		t.Fatal("显式降级部署下没有下发应用会话 Cookie")
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "nonce_unbound=allowed_by_config") {
		t.Fatalf("降级兑换的审计细节 = %q, want 含 nonce_unbound=allowed_by_config", detail)
	}
	if !hasLog(logs(), "显式允许**无 nonce** 的换票") {
		t.Fatalf("降级兑换没有 ERROR 留痕：%v", logs())
	}

	// 2) Sec-Fetch 纵深在降级部署下**仍然生效**（这正是"回落判据"的含义）。
	it2 := issueTicket(t, env, empCookie, "my-app", "/")
	cross := redeemReq(t, it2)
	cross.Header.Set("Sec-Fetch-Site", "cross-site")
	cross.Header.Set("Sec-Fetch-Mode", "navigate")
	rec2 := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec2, cross, "my-app"); ok {
		t.Fatal("降级部署下跨站导航仍被兑换（回落判据没生效）")
	}
	if c := cookieByName(rec2.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
	}
}

// TestTicketNoncePlanUsesConfigOnly 是判定函数本身的白盒判据：**输入只有配置**。
//
// 同一份配置下结论恒定，与请求长什么样无关 —— 这是"降级不可由请求方选"的最小证明
// （变异：把 ticketNonceDecision 改回按 r.Host 判定 ⇒ 别名用例红）。
//
// 判定规则（回归审计加固后的完整口径）：
//   - 对外地址**已配置**：主站 Host 必须 domain-match 基域才 required；
//   - 对外地址**未配置/不可解析**：按应用基域推导（`<基域 scheme>://<基域>`）⇒ required；
//   - 基域未配置：unavailable（调用方在此之前已 404）。
//
// 规则依据两块拼图，缺一不可：
//   - Cookie 的 Domain 必须 domain-match **响应所在主机**（RFC 6265 §5.3 第 6 步）
//     ⇒ 主站 Host 必须等于基域、或是基域的**子域**（祖先域不行，方向反了）；
//   - 而 edge.HostGate 把基域的一级子域一律判成**应用子域**（`<label>.<基域>` 走应用路由，
//     主站路由根本不注册在那里）⇒ 实际可用的形态只有"主站 Host == 应用基域"。
func TestTicketNoncePlanUsesConfigOnly(t *testing.T) {
	cases := []struct {
		name      string
		base      string
		main      string
		want      ticketNoncePlan
		wantDo    string
		wantDeriv bool
	}{
		{"对外地址 == 基域（唯一实际可用形态）", "harness.example.com", "https://harness.example.com", ticketNonceRequired, "harness.example.com", false},
		{"对外地址是基域的子域（RFC 允许，但会被 HostGate 判成应用子域）", "example.com", "https://harness.example.com", ticketNonceRequired, "example.com", false},
		{"对外地址是基域的祖先域（Domain 写不进去）", "apps.example.com", "https://example.com", ticketNonceUnavailable, "", false},
		{"对外地址与基域不同域", "apps.example.com", "https://harness.example.com", ticketNonceUnavailable, "", false},
		{"对外地址未配置 ⇒ 按基域推导（现网形态）", "harness.example.com", "", ticketNonceRequired, "harness.example.com", true},
		{"对外地址不可解析（漏 scheme）⇒ 同样按基域推导", "harness.example.com", "harness.example.com", ticketNonceRequired, "harness.example.com", true},
		{"对外地址是 IPv6 字面量 ⇒ 按基域推导", "harness.example.com", "https://[::1]:8443", ticketNonceRequired, "harness.example.com", true},
		{"对外地址带非默认端口（主机名仍匹配）", "harness.example.com", "https://harness.example.com:8443", ticketNonceRequired, "harness.example.com", false},
		{"对外地址带子路径（只取源）", "harness.example.com", "https://harness.example.com/base", ticketNonceRequired, "harness.example.com", false},
		{"基域带尾点与大小写", "Harness.Example.COM.", "https://harness.example.com", ticketNonceRequired, "harness.example.com", false},
		{"基域带 http scheme 且对外地址未配置 ⇒ 推导同 scheme", "http://apps.example.com", "", ticketNonceRequired, "apps.example.com", true},
		{"基域未配置 ⇒ unavailable", "", "https://harness.example.com", ticketNonceUnavailable, "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := New(Options{
				BaseDomain: func() string { return tc.base },
				MainOrigin: tc.main,
			})
			dec := m.ticketNonceDecision()
			if dec.Plan != tc.want {
				t.Fatalf("plan = %v, want %v（base=%q main=%q reason=%q）",
					dec.Plan, tc.want, tc.base, tc.main, dec.Reason)
			}
			if dec.CookieDomain != tc.wantDo {
				t.Fatalf("cookie domain = %q, want %q", dec.CookieDomain, tc.wantDo)
			}
			if dec.Derived != tc.wantDeriv {
				t.Fatalf("Derived = %v, want %v（main_origin=%q）", dec.Derived, tc.wantDeriv, dec.MainOrigin)
			}
			if dec.Plan == ticketNonceRequired && dec.MainOrigin == "" {
				t.Fatal("required 时必须给出判定依据的 main_origin")
			}
			if dec.Plan == ticketNonceUnavailable && dec.Reason == "" {
				t.Fatal("unavailable 必须给出可定位的原因（进日志/审计）")
			}
		})
	}

	// Resolver 优先于静态串（生产走 Resolver：settings server.base_url 是运行期设置）。
	m := New(Options{
		BaseDomain:         func() string { return testMainHost },
		MainOrigin:         "https://stale.example.com",
		MainOriginResolver: func() string { return testMainOrigin },
	})
	if dec := m.ticketNonceDecision(); dec.Plan != ticketNonceRequired || dec.Derived {
		t.Fatalf("Resolver 应优先于静态 MainOrigin，得到 %+v", dec)
	}
	if got := m.configuredMainOrigin(); got != testMainOrigin {
		t.Fatalf("configuredMainOrigin = %q, want %q", got, testMainOrigin)
	}
	// Resolver 返回空 ⇒ 回落静态串。
	m2 := New(Options{
		BaseDomain:         func() string { return testMainHost },
		MainOrigin:         testMainOrigin,
		MainOriginResolver: func() string { return "" },
	})
	if got := m2.configuredMainOrigin(); got != testMainOrigin {
		t.Fatalf("Resolver 为空时应回落静态 MainOrigin，得到 %q", got)
	}
}

// TestRedeemNonceBoundTicketSurvivesMainOriginChange 是一条防"过度收紧"的性质：
// 已经签发的票（带 nonce）在配置改变后仍然只按 nonce 判据兑换 —— 兑换侧看的是
// 票记录里的 nonce，不是"当前配置"（配置变更不该让在途的合法票瞬间失效）。
func TestRedeemNonceBoundTicketSurvivesMainOriginChange(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	it := issueTicket(t, env, empCookie, "my-app", "/")
	if it.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}
	// 票已签发之后，部署把主站源改成"与基域不匹配"（例如管理员手滑）。
	env.mgr.opt.MainOrigin = "https://other.example.org"
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, redeemReq(t, it, it.nonce), "my-app"); !ok {
		t.Fatal("配置变更后在途的合法票被拒了（兑换侧不该看配置，只看票记录的 nonce）")
	}
}
