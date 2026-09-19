package session

// ---- 换票 nonce 的在途票隔离（2026-09-19 第二轮对抗审计 §1.4 / P3）----
//
// 缺陷形态（审计探针 TestAuditProbeTwoOutstandingTicketsBreakLegitBrowser 实证）：
// nonce Cookie 曾经只有一个**固定名**，而它带 `Domain=应用基域` + `Path=/` ⇒ 在浏览器里
// 是**基域级唯一**一份（RFC 6265 §5.3：同名/同域/同路径的新值覆盖旧值）。于是同一个
// 浏览器同时有两张在途票时（应用中心里中键连开两个应用：A 的跳转还没落地就点了 B），
// **先签发的那张票必然兑换失败**、被烧掉，用户被弹回换票页重来一轮；审计链里还留下一条
// 与攻击同形的 `rejected=nonce_mismatch`。
//
// 修法：nonce Cookie 名带上**本票 code 的摘要**（ticketNonceCookieNameFor），
// 每张在途票各持一份；固定名那条仍然下发/读取，但只是**回退**（ticketNonceCookieNames）。
//
// 判据（与交付报告的验收表逐条对应；全部走真库 + 真 cookiejar，不 mock）：
//
//	① 同一只浏览器（一份 net/http/cookiejar）里两张在途票**各自兑换成功**，
//	   且审计里**没有**任何 `rejected=` —— 修复前第一条必然红；
//	② 把别人的 nonce 送进我的票（专属名与固定名两种形态）⇒ 仍拒 + 审计 nonce_mismatch，
//	   且被兑换的那张票照旧被烧、另一张不受影响（R1-sec-1 的绑定语义不退化成"有 nonce 就放行"）；
//	③ 专属性不是装饰：把固定名那条从 jar 里去掉，两张票仍能兑换（多标签可用不依赖单例槽位）；
//	④ 完全不带 nonce ⇒ 仍拒（nonce_absent）+ 烧票；
//	⑤ 机制层：名字从 code 摘要派生、逐字节可断言、**不泄漏 code 或 nonce**，
//	   且两条 Cookie 的安全属性逐项一致（回退是同一份 nonce 的别名，不是第二个秘密）。
//
// 变异验证（把实现改回旧形态 ⇒ 必红，实跑记录见 temp/wasm-review-r1/fix-lastmile.md）：
//   - ticketNonceCookieNameFor 改回返回固定名（单例 Cookie）⇒ ①③ 红（A 的兑换失败/无 Cookie）；
//   - ticketNonceVerdict 去掉值比对（"有 Cookie 即放行"）⇒ ② 红；
//   - ticketNonceVerdict 只在缺失时拒（Cookie 存在就不比对）⇒ ② 红；
//   - 兑换侧只读固定名（丢掉专属名优先）⇒ ①（真实 jar 形态）红。

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 最小的"同一只浏览器"模型 =====

// multiTabJar 是一份**真实**的浏览器 cookie jar（net/http/cookiejar = RFC 6265 实现），
// 多次签发的 Set-Cookie 全部按浏览器语义累积：同名/同域/同路径互相覆盖，不同名各自留存。
//
// 为什么不用字符串断言代替它：本缺陷的成因**就是** jar 的覆盖语义 —— 只有让真实的 jar
// 去决定"应用子域会收到哪些 Cookie"，这条用例才能抓住"两张在途票互相覆盖"这件事。
type multiTabJar struct {
	t     *testing.T
	jar   http.CookieJar
	issue *url.URL
}

func newMultiTabJar(t *testing.T) *multiTabJar {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	issue, err := url.Parse(testMainOrigin + "/app-ticket")
	if err != nil {
		t.Fatalf("解析签发地址: %v", err)
	}
	return &multiTabJar{t: t, jar: jar, issue: issue}
}

// store 模拟浏览器收到一次签发响应的全部 Set-Cookie。
func (j *multiTabJar) store(rec *httptest.ResponseRecorder) {
	j.t.Helper()
	j.jar.SetCookies(j.issue, rec.Result().Cookies())
}

// cookiesFor 问 jar："导航到 <appID>.<基域> 时会带上哪些 Cookie"。
func (j *multiTabJar) cookiesFor(appID string) []*http.Cookie {
	j.t.Helper()
	u, err := url.Parse("https://" + appID + "." + testBaseDomain + "/")
	if err != nil {
		j.t.Fatalf("解析应用地址: %v", err)
	}
	return j.jar.Cookies(u)
}

// withoutCookies 复制一份 Cookie 列表但去掉指定名字（用于"去掉回退槽位"这条判据）。
func withoutCookies(cookies []*http.Cookie, names ...string) []*http.Cookie {
	out := make([]*http.Cookie, 0, len(cookies))
	for _, c := range cookies {
		drop := false
		for _, name := range names {
			if c.Name == name {
				drop = true
				break
			}
		}
		if !drop {
			out = append(out, c)
		}
	}
	return out
}

// perTicketNonce 取一次签发响应里"本票专属名"那条 nonce Cookie。
func perTicketNonce(t *testing.T, it issuedTicket) *http.Cookie {
	t.Helper()
	name := ticketNonceCookieNameFor(it.code)
	c := cookieByName(it.rec.Result().Cookies(), name)
	if c == nil {
		t.Fatalf("签发响应里没有本票专属 nonce Cookie %q：%v", name, it.rec.Header().Values("Set-Cookie"))
	}
	return c
}

// forgeNonce 伪造一条 nonce Cookie（模拟"把我的票的 Cookie 名配上别人的 nonce"，
// 或"只有固定名的既有形态"）。
//
// 属性抄真实签发的那条（Domain=基域、Path=/、HttpOnly、Secure、Strict）：伪造的难点
// 只应在**值**上，不该靠"属性奇特所以浏览器不认"来通过判据。
func forgeNonce(name, value string) *http.Cookie {
	return &http.Cookie{
		Name:     name,
		Value:    value,
		Path:     "/",
		Domain:   testMainHost,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
	}
}

// auditDetails 返回某个动作的全部审计 detail（审计异步 fire-and-forget，故轮询到
// 期望条数为止）。
func auditDetails(t *testing.T, a *auditRec, action string, want int) []string {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		a.mu.Lock()
		var out []string
		for _, e := range a.entries {
			parts := strings.SplitN(e, "|", 3)
			if len(parts) == 3 && parts[1] == action {
				out = append(out, parts[2])
			}
		}
		a.mu.Unlock()
		if len(out) >= want || time.Now().After(deadline) {
			return out
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// ===== 判据 ①：同一浏览器里两张在途票各自兑换成功 =====

// TestTwoOutstandingTicketsBothRedeemInOneBrowserJar 是本缺陷的回归本体：
// 应用中心里中键连开两个应用 ⇒ 同一个 cookie jar 里先后收到两份 nonce ⇒
// **两张票都要能兑换**（修复前：先签发的那张必然 nonce_mismatch 并被烧掉）。
func TestTwoOutstandingTicketsBothRedeemInOneBrowserJar(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	env.newApp(t, "other-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	browser := newMultiTabJar(t)
	// 中键连开：两次签发都发生在**同一只**浏览器里（这是缺陷的必要条件）。
	a := issueTicket(t, env, empCookie, "my-app", "/")
	browser.store(a.rec)
	b := issueTicket(t, env, empCookie, "other-app", "/")
	browser.store(b.rec)

	if a.nonce == nil || b.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}
	// 两张票的**专属名必须不同**（同名 = 浏览器里互相覆盖 = 本缺陷）。
	nameA, nameB := perTicketNonce(t, a).Name, perTicketNonce(t, b).Name
	if nameA == nameB {
		t.Fatalf("两张在途票的专属 nonce Cookie 同名（%q）⇒ 在浏览器里必然互相覆盖，"+
			"先签发的那张注定兑换失败", nameA)
	}
	if nameA == TicketNonceCookieName || nameB == TicketNonceCookieName {
		t.Fatalf("专属名退化成了固定名（%q / %q）⇒ nonce 又只剩基域级唯一一份", nameA, nameB)
	}

	// jar 里此刻同时持有两张票各自的 nonce（真实浏览器形态：基域级 Cookie 全部累积）。
	jarCookies := browser.cookiesFor("my-app")
	for _, it := range []issuedTicket{a, b} {
		c := cookieByName(jarCookies, ticketNonceCookieNameFor(it.code))
		if c == nil {
			t.Fatalf("jar 里没有票 %s 的专属 nonce（%q）⇒ 该票注定兑换失败；jar=%v",
				it.code[:8], ticketNonceCookieNameFor(it.code), cookieNames(jarCookies))
		}
		if c.Value != it.nonce.Value {
			t.Fatalf("票 %s 的专属 nonce 值与签发响应不一致", it.code[:8])
		}
	}

	// 判据①：两张各自兑换成功（用**真实的 jar Cookie 列表**，即浏览器真正会发的那些）。
	for _, tc := range []struct {
		label string
		it    issuedTicket
		appID string
	}{
		{"先签发的那张（应用 A）", a, "my-app"},
		{"后签发的那张（应用 B）", b, "other-app"},
	} {
		rec := httptest.NewRecorder()
		clean, ok := env.mgr.RedeemTicket(rec, redeemReq(t, tc.it, browser.cookiesFor(tc.appID)...), tc.appID)
		if !ok {
			t.Errorf("[判据①] %s 兑换失败 ⇒ 合法多标签流程被打断（审计=%q）",
				tc.label, env.audit.detailOf("app_ticket_redeem"))
			continue
		}
		if c := cookieByName(rec.Result().Cookies(), AppCookieName); c == nil {
			t.Errorf("[判据①] %s 兑换成功但没有下发应用会话 Cookie", tc.label)
		}
		if !strings.HasPrefix(clean, "/") {
			t.Errorf("[判据①] %s 的干净 URL 不是同基域相对路径：%q", tc.label, clean)
		}
	}

	// 合法流程不得在审计链里留下与攻击同形的拒绝记录（缺陷的第二个症状）。
	details := auditDetails(t, env.audit, "app_ticket_redeem", 2)
	for _, d := range details {
		if strings.Contains(d, "rejected=") {
			t.Errorf("合法多标签流程留下了拒绝审计（与攻击同形）：%q", d)
		}
	}
	if len(details) != 2 {
		t.Fatalf("审计里应有 2 条成功兑换，实际 %d 条：%v", len(details), details)
	}
}

// TestMultiTicketRedeemDoesNotRelyOnSingletonCookieSlot 是判据①的强化形态：
// 把**固定名**那条从 jar 里去掉（模拟它被拒收/被覆盖），两张票仍然各自可兑换 ⇒
// "多标签可用"靠的是**专属名**，不是某个基域级单例槽位。
//
// 变异验证：把 ticketNonceCookieNameFor 改回固定名（单例 Cookie）后，去掉固定名
// 等于一个 Cookie 都不剩 ⇒ 两张票都以 nonce_absent 被拒，本用例红。
func TestMultiTicketRedeemDoesNotRelyOnSingletonCookieSlot(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	env.newApp(t, "other-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	browser := newMultiTabJar(t)
	a := issueTicket(t, env, empCookie, "my-app", "/")
	browser.store(a.rec)
	b := issueTicket(t, env, empCookie, "other-app", "/")
	browser.store(b.rec)

	for _, tc := range []struct {
		label string
		it    issuedTicket
		appID string
	}{
		{"先签发的那张（应用 A）", a, "my-app"},
		{"后签发的那张（应用 B）", b, "other-app"},
	} {
		cookies := withoutCookies(browser.cookiesFor(tc.appID), TicketNonceCookieName)
		if len(cookies) == 0 {
			t.Fatalf("[判据③] 去掉固定名后 jar 里没有剩下任何 nonce ⇒ nonce 仍然只有"+
				"基域级唯一一份（票 %s 注定兑换失败）", tc.it.code[:8])
		}
		rec := httptest.NewRecorder()
		if _, ok := env.mgr.RedeemTicket(rec, redeemReq(t, tc.it, cookies...), tc.appID); !ok {
			t.Errorf("[判据③] %s 在「只有专属名」的 jar 里兑换失败（审计=%q）",
				tc.label, env.audit.detailOf("app_ticket_redeem"))
		}
	}
}

// cookieNames 只为失败信息可读：列出 jar 里的 Cookie 名（值不进日志/断言文本）。
func cookieNames(cookies []*http.Cookie) []string {
	out := make([]string, 0, len(cookies))
	for _, c := range cookies {
		out = append(out, c.Name)
	}
	return out
}

// ===== 判据 ②：跨票 nonce 仍拒（两种形态），且烧票范围不变 =====

// TestRedeemOtherTicketNonceUnderMyTicketCookieNameRejected 钉住"nonce 是**这一张票**的"：
// 把**另一张票**的 nonce 送进本票的专属 Cookie 名（浏览器里能构造出的跨票形态）⇒
// 拒 + 审计 `rejected=nonce_mismatch`；固定名那条的同类形态同样拒（既有回归用例的形状）。
//
// 变异验证：ticketNonceVerdict 只判"Cookie 在不在"而忽略值 ⇒ 本用例红（跨票放行）。
func TestRedeemOtherTicketNonceUnderMyTicketCookieNameRejected(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	a := issueTicket(t, env, empCookie, "my-app", "/one")
	b := issueTicket(t, env, empCookie, "my-app", "/two")
	if a.nonce == nil || b.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}
	if a.nonce.Value == b.nonce.Value {
		t.Fatal("两张票的 nonce 相同（每次签发必须重新生成）")
	}

	// 形态一：把 B 的 nonce 放进 **A 的专属名**下（专属名可从 A 的 code 派生。
	// 这正是"知道别人的 nonce 但不知道别人的票"这句判据在浏览器里的落点）。
	forged := forgeNonce(ticketNonceCookieNameFor(a.code), b.nonce.Value)
	crossed := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(crossed, redeemReq(t, a, forged), "my-app"); ok {
		t.Fatal("用另一张票的 nonce（放进我的票的 Cookie 名）兑换成功了 —— nonce 没绑到具体票")
	}
	if c := cookieByName(crossed.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("跨票 nonce 被拒但仍然下发了应用会话 Cookie：%+v", c)
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_mismatch") {
		t.Fatalf("审计细节 = %q, want 含 rejected=nonce_mismatch（「看错了那张票的 nonce」必须与攻击同形留痕）", detail)
	}
	// 票 A 已被那次拒绝烧掉（一次性语义无条件优先）—— 拿它自己的 nonce 也换不出来。
	if _, ok := env.mgr.RedeemTicket(httptest.NewRecorder(), redeemReq(t, a, perTicketNonce(t, a)), "my-app"); ok {
		t.Fatal("非匹配的 nonce 尝试没有把票烧掉（可被反复拿来探测）")
	}
	// 而票 B 完全不受影响：跨票尝试烧掉的是**被兑换的那张票**，不是别人手里的票。
	if _, ok := env.mgr.RedeemTicket(httptest.NewRecorder(), redeemReq(t, b, perTicketNonce(t, b)), "my-app"); !ok {
		t.Fatal("跨票尝试把另一张票也烧掉了（一次性语义的范围过大）")
	}

	// 形态二：把 B 的 nonce 放进**固定名**那条（回退槽位不得成为绕过值比对的入口）。
	c := issueTicket(t, env, empCookie, "my-app", "/three")
	legacyForged := forgeNonce(TicketNonceCookieName, b.nonce.Value)
	if _, ok := env.mgr.RedeemTicket(httptest.NewRecorder(), redeemReq(t, c, legacyForged), "my-app"); ok {
		t.Fatal("固定名回退槽位只看「有没有 Cookie」、不比对值 —— 跨票 nonce 被放行")
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_mismatch") {
		t.Fatalf("审计细节 = %q, want 含 rejected=nonce_mismatch", detail)
	}
}

// TestRedeemWithoutAnyNonceCookieStillRejected 是判据④：一个 nonce 都不带的浏览器
// （伪造链接/全新 jar）⇒ 拒 + `rejected=nonce_absent` + 烧票，且没有应用会话 Cookie。
func TestRedeemWithoutAnyNonceCookieStillRejected(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	a := issueTicket(t, env, empCookie, "my-app", "/")
	if a.nonce == nil {
		t.Fatal("签发换票未下发 nonce Cookie")
	}
	rec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(rec, redeemReq(t, a), "my-app"); ok {
		t.Fatal("[判据④] 不带任何 nonce 的兑换成功了（浏览器持有性证明等于不存在）")
	}
	if c := cookieByName(rec.Result().Cookies(), AppCookieName); c != nil {
		t.Fatalf("[判据④] 被拒的兑换仍然下发了应用会话 Cookie：%+v", c)
	}
	if detail := env.audit.waitFor(t, "app_ticket_redeem"); !strings.Contains(detail, "rejected=nonce_absent") {
		t.Fatalf("[判据④] 审计细节 = %q, want 含 rejected=nonce_absent", detail)
	}
	if _, ok := env.mgr.RedeemTicket(httptest.NewRecorder(), redeemReq(t, a, perTicketNonce(t, a)), "my-app"); ok {
		t.Fatal("[判据④] 失败的兑换没有把票烧掉")
	}
}

// ===== 判据 ⑤：机制层（名字确定性/不透明性/属性对齐） =====

// TestTicketNonceCookieNameIsPerTicketAndOpaque 钉住派生规则本身的可断言性质：
// 确定性、逐票不同、形状固定（前缀 + 8 位小写十六进制）、是合法 cookie-name token，
// 且**名字里不含 code 或 nonce**（Cookie 名对应用子域的 JS 可见，只有值受 HttpOnly 保护）。
func TestTicketNonceCookieNameIsPerTicketAndOpaque(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	a := issueTicket(t, env, empCookie, "my-app", "/one")
	b := issueTicket(t, env, empCookie, "my-app", "/two")

	nameA := ticketNonceCookieNameFor(a.code)
	if nameA != ticketNonceCookieNameFor(a.code) {
		t.Fatal("同一个 code 派生出了不同的 Cookie 名（派生必须是纯函数）")
	}
	if nameA == ticketNonceCookieNameFor(b.code) {
		t.Fatal("两张不同的票派生出同一个 Cookie 名（在途票又会互相覆盖）")
	}
	suffix, ok := strings.CutPrefix(nameA, TicketNonceCookieName+"_")
	if !ok {
		t.Fatalf("专属名 %q 不以 %q 为前缀 ⇒ 固定名回退与「只读专属名」两种形态无法共存", nameA, TicketNonceCookieName+"_")
	}
	if len(suffix) != 8 {
		t.Fatalf("专属名摘要长度 = %d, want 8（%q）", len(suffix), nameA)
	}
	for _, r := range suffix {
		if !strings.ContainsRune("0123456789abcdef", r) {
			t.Fatalf("专属名摘要含非小写十六进制字符 %q（%q）", r, nameA)
		}
	}
	// 名字必须是合法 cookie-name token（否则 net/http 会静默丢掉整条 Set-Cookie）。
	if probe := (&http.Cookie{Name: nameA, Value: "probe"}).String(); !strings.HasPrefix(probe, nameA+"=") {
		t.Fatalf("专属名 %q 不是合法 cookie-name token：%q", nameA, probe)
	}
	// 不透明性：Cookie 名对应用子域的 JS 可见 ⇒ 不得把 code/nonce 的任何一段写进名字。
	for _, secret := range []string{a.code, a.nonce.Value, b.code, b.nonce.Value} {
		if len(secret) >= 8 && strings.Contains(nameA, secret[:8]) {
			t.Fatalf("Cookie 名 %q 里出现了秘密值的前缀（%q 的前 8 位）", nameA, secret)
		}
	}
}

// TestTicketIssueWritesBothNonceCookiesWithIdenticalSecurityAttributes 钉住签发侧的两条
// Cookie 是**同一份 nonce 的两个别名**：值相同、安全属性逐项相同（回退槽位不得比专属名弱，
// 否则"浏览器收哪一条"就决定了防护强度）。
func TestTicketIssueWritesBothNonceCookiesWithIdenticalSecurityAttributes(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")
	a := issueTicket(t, env, empCookie, "my-app", "/")

	primary := perTicketNonce(t, a)
	legacy := cookieByName(a.rec.Result().Cookies(), TicketNonceCookieName)
	if legacy == nil {
		t.Fatalf("签发响应里没有回退用的固定名 Cookie %q：%v",
			TicketNonceCookieName, a.rec.Header().Values("Set-Cookie"))
	}
	if primary.Value != legacy.Value {
		t.Fatal("专属名与固定名两条 Cookie 的值不同（回退槽位必须是同一份 nonce 的别名）")
	}
	domain := env.mgr.ticketNonceDecision().CookieDomain
	for _, c := range []*http.Cookie{primary, legacy} {
		if c.Path != "/" || c.Domain != domain {
			t.Fatalf("Cookie %q 的作用域 = Domain=%q Path=%q, want Domain=%q Path=/",
				c.Name, c.Domain, c.Path, domain)
		}
		if !c.HttpOnly || !c.Secure || c.SameSite != http.SameSiteStrictMode {
			t.Fatalf("Cookie %q 的安全属性被放宽：HttpOnly=%t Secure=%t SameSite=%v",
				c.Name, c.HttpOnly, c.Secure, c.SameSite)
		}
		if c.MaxAge != int(limits.TicketTTL.Seconds()) {
			t.Fatalf("Cookie %q 的 MaxAge = %d, want %d（必须与票同寿命）",
				c.Name, c.MaxAge, int(limits.TicketTTL.Seconds()))
		}
	}
	// 两条都必须真的在 Set-Cookie 原始字节里（解析后的结构体看不到属性怎么写出去的）。
	for _, name := range []string{primary.Name, legacy.Name} {
		if raw := rawSetCookieFor(a.rec, name); raw == "" {
			t.Fatalf("Set-Cookie 里没有 %q 那条（%v）", name, a.rec.Header().Values("Set-Cookie"))
		}
	}
}
