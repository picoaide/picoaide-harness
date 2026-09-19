package appserver

// ---- R1-sec-1（登录 CSRF / 会话固定）在 **appserver 层**的端到端判据 ----
//
// 主控真机复现的就是这一层：攻击者（任一登录员工）`POST /app-ticket` 拿到
// `https://<app>.<基域>/?ticket=<64hex>`，受害者在**全新 cookie jar** 里 GET 它
// ⇒ 302 + `Set-Cookie: picoaide_app=…`，此后帧内身份 = 攻击者。
//
// 修复本体在 session 包（换票的 nonce Cookie 绑定，见 session/ticket_nonce_test.go），
// 本文件的用例只回答一个端到端问题：**走过 ServeApp 整条流水线之后，伪造链接还能不能
// 换出应用会话 Cookie、合法链路还通不通。**
//
// 变异验证：
//   - 去掉 session.RedeemTicket 的 nonce 判据 ⇒ TestServe_ForgedTicketLinkInFreshJarGetsNoAppSession 红；
//   - 去掉 session.TicketSubmit 的 nonce 下发 ⇒ TestServe_LegitChainKeepsNonceAndAppSession 红
//     （helper redeemAppSession 也会红）。

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// TestServe_ForgedTicketLinkInFreshJarGetsNoAppSession 复现并钉死 P0 的攻击面。
//
// 判据（缺一不可）：
//  1. 响应里**没有** picoaide_app（头与解析后的 Cookie 都查一遍）；
//  2. 不是"带着应用会话的 302" —— login_required 应用按未登录继续，302 回**主站**换票端点；
//  3. 库里那位员工名下**没有**新的应用会话行（受害者的输入不会落在攻击者账号下）。
func TestServe_ForgedTicketLinkInFreshJarGetsNoAppSession(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("forged")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig(testOwner)})

	// 攻击者：任一登录员工。走完整签发（POST /app-ticket），拿到票与 nonce Cookie。
	emp := e.loginEmployee(testOwner)
	form := url.Values{"app": {appID}, "next": {"/"}}
	req := httptest.NewRequest(http.MethodPost, testMainOrigin+"/app-ticket", strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Origin", testMainOrigin)
	req.AddCookie(emp)
	rec := httptest.NewRecorder()
	e.mgr.TicketSubmit(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("签发换票 status=%d body=%s", rec.Code, rec.Body.String())
	}
	if cookieByName(rec.Result().Cookies(), session.TicketNonceCookieName) == nil {
		t.Fatal("签发未下发 nonce Cookie：伪造链接这道闸门等于不存在")
	}
	target := jumpPageTarget(t, rec.Body.String())
	u, err := url.Parse(target)
	if err != nil {
		t.Fatalf("跳板页目标非法 %q: %v", target, err)
	}
	if u.Query().Get("ticket") == "" {
		t.Fatalf("跳板页目标不含 ticket: %q", target)
	}

	// 受害者：**全新 cookie jar**（一个 Cookie 都不带）打开那条链接。
	victim := e.get(appID, u.RequestURI())

	if c := cookieByName(victim.Result().Cookies(), session.AppCookieName); c != nil {
		t.Fatalf("伪造链接在全新 jar 里换出了应用会话 Cookie（原始 P0 形态）：%+v", c)
	}
	if raw := victim.Header().Get("Set-Cookie"); strings.Contains(raw, session.AppCookieName) {
		t.Fatalf("响应头里出现应用会话 Cookie：%q", raw)
	}
	if victim.Code != http.StatusFound {
		t.Fatalf("login_required 应用的伪造链接应按未登录继续（302），得到 %d body=%.200s",
			victim.Code, victim.Body.String())
	}
	loc := victim.Header().Get("Location")
	if !strings.HasPrefix(loc, testMainOrigin+"/app-ticket?") {
		t.Fatalf("应当 302 回**主站**换票端点，得到 %q", loc)
	}
	if strings.Contains(loc, "ticket=") {
		t.Fatalf("回跳地址里不得再带票（会反复回跳）：%q", loc)
	}
	var n int
	if err := e.db.QueryRow(
		`SELECT count(*) FROM app_sessions s JOIN users u ON u.id = s.user_id WHERE u.username = $1`,
		testOwner).Scan(&n); err != nil {
		t.Fatalf("count app_sessions: %v", err)
	}
	if n != 0 {
		t.Fatalf("被拒的伪造链接仍然落了 %d 行应用会话（受害者的输入会落在攻击者账号下）", n)
	}
}

// TestServe_LegitChainKeepsNonceAndAppSession 是同一判据的功能面：
// 主站登录 → POST /app-ticket（收到 nonce）→ 带**同一 jar** GET 子域 ⇒ 302 + picoaide_app。
//
// 它同时钉住"nonce 不是可选项"：签发响应里必须有它，兑换响应里必须有应用会话 Cookie。
func TestServe_LegitChainKeepsNonceAndAppSession(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("legit")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig(testOwner)})

	emp := e.loginEmployee(testOwner)
	// redeemAppSession 就是"同一只浏览器"：它把签发响应的 nonce 带进子域兑换请求。
	appCookie := e.redeemAppSession(emp, appID)
	if appCookie == nil || appCookie.Value == "" {
		t.Fatal("合法链路没有拿到应用会话 Cookie")
	}
	if !appCookie.HttpOnly || !appCookie.Secure || appCookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("应用会话 Cookie 属性退化：%+v", appCookie)
	}
	// 带这个 Cookie 再访问应用：必须拿到帧内身份（而不是被当成未登录）。
	rec := e.get(appID, "/", appCookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("带应用会话 Cookie 访问应 200，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["has_user"] != true || body["username"] != testOwner {
		t.Fatalf("帧内身份 = %v/%v, want true/%s", body["has_user"], body["username"], testOwner)
	}
}
