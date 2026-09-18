package appserver

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// ===== 步骤①：应用反查（§4.8）=====

func TestServe_UnknownHostIs404AndNeverFallsBackToMainSite(t *testing.T) {
	e := newEnv(t)
	rec := e.get(e.appID("ghost"), "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未登记主机名应 404，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	// 绝不回落主站：门户/管理台的任何字样都不允许出现。
	for _, forbidden := range []string{"PicoAide", "portal", "管理后台", "<form"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("404 页面疑似回落主站内容（含 %q）: %s", forbidden, body)
		}
	}
	// 宿主安全头在 404 上同样必须写（§4.8：含 4xx/5xx）。
	assertHostSecurityHeaders(t, rec, true)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("浏览器请求应拿到 HTML 404，得到 %q", ct)
	}
}

func TestServe_UnknownHostAPIRequestIsJSON404(t *testing.T) {
	e := newEnv(t)
	rec := e.get(e.appID("ghost"), "/api/items")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("应 404，得到 %d", rec.Code)
	}
	if code := errorCodeOf(t, rec.Body); code != "NOT_FOUND" {
		t.Fatalf("错误码应为 NOT_FOUND，得到 %q", code)
	}
}

func TestServe_ReservedLabelIs404(t *testing.T) {
	e := newEnv(t)
	// 保留字即使库里存在行也不服务（纵深防御，§4.1：基域是平台资产）。
	e.publishApp(appSpec{appID: "admin"})
	rec := e.get("admin", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("保留字主机名应 404，得到 %d", rec.Code)
	}
}

func TestServe_ExtraReservedHostIs404(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.AppIDExtraReserved = []string{"intranet"} })
	e.publishApp(appSpec{appID: "intranet"})
	rec := e.get("intranet", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("部署期注入的企业主机名应 404，得到 %d", rec.Code)
	}
}

func TestServe_DisabledAppIs410(t *testing.T) {
	e := newEnv(t)
	disabled := false
	appID := e.appID("offline")
	e.publishApp(appSpec{appID: appID, enabled: &disabled})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusGone {
		t.Fatalf("下架应用应 410，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "已下架") {
		t.Fatalf("410 页面应说明已被下架: %s", rec.Body.String())
	}
	assertHostSecurityHeaders(t, rec, true)

	// API 形态：可解析的 JSON 信封（同一个 code，状态码仍是 410）。
	req := httptest.NewRequest(http.MethodGet, appURL(appID, "/api/items"), nil)
	req.Header.Set("Accept", "application/json")
	apiRec := e.serve(req)
	if apiRec.Code != http.StatusGone {
		t.Fatalf("下架应用的 API 请求也应 410，得到 %d", apiRec.Code)
	}
	if code := errorCodeOf(t, apiRec.Body); code != "NOT_FOUND" {
		t.Fatalf("错误码应为 NOT_FOUND（410 由 HTTP 状态表达），得到 %q", code)
	}
}

func TestServe_SoftDeletedAppIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("retired")
	e.publishApp(appSpec{appID: appID})
	if err := serverstore.SoftDeleteWasmApp(t.Context(), e.db, appID); err != nil {
		t.Fatalf("SoftDeleteWasmApp: %v", err)
	}
	if rec := e.get(appID, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("软删（退役）应用应 404（R37：退役即停止路由），得到 %d", rec.Code)
	}
}

func TestServe_FrozenAppIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("frozen")
	e.publishApp(appSpec{appID: appID, frozen: true})
	if rec := e.get(appID, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("冻结应用应 404（冻结是只读快照，不继续服务），得到 %d", rec.Code)
	}
}

// ===== 步骤②：生效版本 =====

func TestServe_NoApprovedReleaseIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("pending")
	// 只有 pending 版本 ⇒ 没有生效版本（审核开关开启时线上仍旧版本；这里一个都没有）。
	e.publishApp(appSpec{appID: appID, status: serverstore.ReleaseStatusPending})
	rec := e.get(appID, "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("无生效版本应 404，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "还没有可用版本") {
		t.Fatalf("404 页面应说明原因: %s", rec.Body.String())
	}
}

// ===== 步骤③④⑤：换票、身份、准入 =====

// TestServe_WhitelistOutsiderStillReachesWasm 是 **R24 / A3 的核心回归网**
// （独立审计 2026-09-18 P2-3 补）。
//
// 判据（用户口径）：`access=whitelist` 只是"要求登录 + 把模式告诉应用"，
// **名单由应用自己比对** —— 平台不得自行拦截白名单外的员工。未授权请求必须
// 照常进 wasm，由应用返回它自己的 403 页面（§10.5 第 51 项：这是**非边界**）。
//
// 为什么必须单独钉一条：这条性质此前没有任何用例咬住 —— 往 appserver 里塞一条
// "白名单外一律 403"的拦截后，既有 74 个用例**全部仍然绿**（最接近的那条
// reserved-app-config 用例只断言"响应体里没有配置内容"，平台 403 同样满足）。
// 变异判据：加上那条拦截 ⇒ 本用例红。
func TestServe_WhitelistOutsiderStillReachesWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("gated")
	// 名单里只有 alice；下面用 bob 登录（"未授权员工"）。
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})

	cookie := e.loggedInCookieAs(appID, "bob")
	rec := e.get(appID, "/secret", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("白名单外的已登录员工必须照常进 wasm（平台不比对名单），得到 %d body=%.200s",
			rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["auth_mode"] != "whitelist" {
		t.Fatalf("帧内 auth.mode 必须是 whitelist（应用据此自己判定），得到 %v", body["auth_mode"])
	}
	// 平台只注入身份：bob 的身份必须原样在帧里（应用要用它比对名单）。
	if body["has_user"] != true || body["username"] != "bob" {
		t.Fatalf("帧内身份必须是 bob（应用靠它比对名单），得到 user=%v/%v", body["has_user"], body["username"])
	}
}

func TestServe_LoginRequiredRedirectsToTicket(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("private")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice", "bob")})

	rec := e.get(appID, "/dashboard?tab=1")
	if rec.Code != http.StatusFound {
		t.Fatalf("未登录访问 login_required 应用应 302，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	loc := rec.Header().Get("Location")
	if !strings.HasPrefix(loc, testMainOrigin+"/app-ticket?") {
		t.Fatalf("应 302 到主站换票端点，得到 %q", loc)
	}
	u, err := url.Parse(loc)
	if err != nil {
		t.Fatalf("Location 非法: %q", loc)
	}
	if got := u.Query().Get("app"); got != appID {
		t.Fatalf("app 参数应为 %q，得到 %q", appID, got)
	}
	next := u.Query().Get("next")
	if !strings.HasPrefix(next, "/") || strings.Contains(next, "https://") || strings.Contains(next, "//") {
		t.Fatalf("next 必须是**相对路径**，得到 %q（完整 Location=%q）", next, loc)
	}
	if next != "/dashboard?tab=1" {
		t.Fatalf("next 应保留原路径与查询，得到 %q", next)
	}
	if strings.Contains(loc, appID+".") {
		t.Fatalf("换票端点必须在**主站**而不是应用子域: %q", loc)
	}
}

func TestServe_TicketRedirectStripsTicketParam(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("stale")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})

	// 过期/无效票据：兑换失败 ⇒ 按未登录继续 ⇒ 302 换票，且 next 里**不能**再带 ticket
	//（否则会拿着旧票据反复回跳）。
	rec := e.get(appID, "/page?ticket=stale-code&keep=1")
	if rec.Code != http.StatusFound {
		t.Fatalf("应 302，得到 %d", rec.Code)
	}
	u, err := url.Parse(rec.Header().Get("Location"))
	if err != nil {
		t.Fatalf("Location 非法: %v", err)
	}
	next := u.Query().Get("next")
	if next != "/page?keep=1" {
		t.Fatalf("next 应去掉 ticket 并保留其余参数，得到 %q", next)
	}
}

func TestServe_InvalidTicketIsConsumedNotTrusted(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("badticket")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})
	rec := e.get(appID, "/?ticket=whatever")
	if rec.Code != http.StatusFound {
		t.Fatalf("无效票据不得放行（应 302 换票），得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app_id") {
		t.Fatal("无效票据不得进入 wasm（响应体里出现了应用回显）")
	}
}

// ===== 步骤⑤：配置读不到 ⇒ 500（绝不能当匿名放行）=====

func TestServe_ConfigMissingIs500(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("noconfig")
	e.publishApp(appSpec{appID: appID, skipConfig: true})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("读不到应用配置必须 500（不能当匿名放行），得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app_id") {
		t.Fatal("配置故障时不得进入 wasm")
	}
	if !strings.Contains(e.logs.String(), "应用配置不可用") {
		t.Fatalf("平台故障必须大声记日志，日志=%s", e.logs.String())
	}
}

func TestServe_ConfigInvalidIs500(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("badconfig")
	e.publishApp(appSpec{appID: appID, config: `{"login_required": "yes"}`})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("非法应用配置必须 500，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(e.logs.String(), "应用配置不可用") {
		t.Fatalf("非法配置必须大声记日志，日志=%s", e.logs.String())
	}
}

// TestServe_LoginModeAllowsEveryLoggedInUser 覆盖 2026-09-18 新增的 access=login 模式
// （用户原话："登陆后使用（默认全员）"）：未登录 302 换票；登录后**不看名单**，任何员工都能用。
//
// 变异方式：把 RequiresLogin() 改成"只有 whitelist 才要求登录"（login 当匿名放行）⇒ 第一个断言红；
// 把 AuthMode() 的 login 分支映射成 public ⇒ 帧内 mode 断言红。
func TestServe_LoginModeAllowsEveryLoggedInUser(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("loginmode")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	// 未登录 ⇒ 302 换票（login 与 whitelist 都要求登录）。
	if rec := e.get(appID, "/"); rec.Code != http.StatusFound {
		t.Fatalf("access=login 未登录应 302 换票，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	// 任何员工（不在任何名单里 —— 这里根本没有名单）登录后都能进 wasm。
	const anyone = "bob-anyone"
	cookie := e.loggedInCookieAs(appID, anyone)
	rec := e.get(appID, "/", cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("access=login 登录后应 200（登录后全员可用），得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["auth_mode"] != "login" || body["auth_verified"] != true {
		t.Fatalf("帧内 auth 不对: mode=%v verified=%v", body["auth_mode"], body["auth_verified"])
	}
	if body["username"] != anyone {
		t.Fatalf("帧内 username = %v, want %q", body["username"], anyone)
	}
}

// TestServe_LegacySchemaConfigStillWorks 守住**兼容 shim 的端到端**：
// 已发布版本的随包 `picoaide.app.json` 还是旧 schema（`login_required` / `visible`），
// 迁移 0071 只改写库里的 config_json，**随包资产是发布期快照、永远可能是旧的** ——
// 平台升级后老应用必须照旧运行（映射规则见 appcfg 包注释）。
//
// 变异方式：删掉 appcfg 的旧形态映射（或让旧字段报 unknown_field）⇒ 本用例全红。
func TestServe_LegacySchemaConfigStillWorks(t *testing.T) {
	e := newEnv(t)

	// ① 旧 public：login_required=false ⇒ 匿名可用（visible=false 不再有任何过滤语义）。
	pub := e.appID("legacy-public")
	e.publishApp(appSpec{appID: pub, config: legacyPublicConfig()})
	rec := e.get(pub, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("旧 schema 的 public 应用匿名访问应 200，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	if body := decodeJSON(t, rec.Body); body["auth_mode"] != "public" || body["has_user"] != false {
		t.Fatalf("旧 schema 应映射成 public：mode=%v has_user=%v", body["auth_mode"], body["has_user"])
	}

	// ② 旧 白名单：login_required=true + 名单非空 ⇒ whitelist（要求登录）。
	white := e.appID("legacy-white")
	e.publishApp(appSpec{appID: white, config: legacyWhitelistConfig(testOwner)})
	if rec := e.get(white, "/"); rec.Code != http.StatusFound {
		t.Fatalf("旧 schema 的 login_required=true 应用未登录应 302，得到 %d", rec.Code)
	}
	authed := e.get(white, "/", e.loggedInCookieAs(white, testOwner))
	if authed.Code != http.StatusOK {
		t.Fatalf("旧 schema 的白名单应用登录后应 200，得到 %d body=%.200s", authed.Code, authed.Body.String())
	}
	if body := decodeJSON(t, authed.Body); body["auth_mode"] != "whitelist" {
		t.Fatalf("旧 schema 的 login_required+名单 应映射成 whitelist，得到 %v", body["auth_mode"])
	}

	// ③ 旧"登录但名单为空"：映射成 login（新规则：登录后全员可用；旧规则本会拒发布）。
	loginApp := e.appID("legacy-login")
	e.publishApp(appSpec{appID: loginApp, config: `{"login_required":true,"whitelist":[]}`})
	if rec := e.get(loginApp, "/"); rec.Code != http.StatusFound {
		t.Fatalf("旧 schema 的 login_required=true（空名单）未登录应 302，得到 %d", rec.Code)
	}
	anyoneCookie := e.loggedInCookieAs(loginApp, "carol-outsider")
	ok := e.get(loginApp, "/", anyoneCookie)
	if ok.Code != http.StatusOK {
		t.Fatalf("旧 schema 映射成 login 后，任何登录员工都该可用，得到 %d body=%.200s", ok.Code, ok.Body.String())
	}
	if body := decodeJSON(t, ok.Body); body["auth_mode"] != "login" {
		t.Fatalf("空名单的旧配置应映射成 login，得到 %v", body["auth_mode"])
	}
}

func TestServe_MissingBaseDomainIs500NotAnonymous(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.BaseDomain = func() string { return "" } })
	appID := e.appID("nobase")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("未配置基域时 login_required 应用必须 500（不能静默当匿名），得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "app_id") {
		t.Fatal("配置错误时不得进入 wasm")
	}
}

func TestServe_LoginRequiredOnPlaintextIs500NotRedirectLoop(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("plaintext")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})

	// 明文请求（无 TLS、无 X-Forwarded-Proto）：票永远兑换不出会话
	//（session.RedeemTicket fail-closed）⇒ 必须 500 说清楚，绝不能 302 进死循环。
	req := httptest.NewRequest(http.MethodGet, "http://"+appID+"."+testBaseDomain+"/", nil)
	rec := e.serve(req)
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("明文访问 login_required 应用应 500（不能 302 进重定向循环），得到 %d", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "" {
		t.Fatalf("不得重定向，得到 Location=%q", loc)
	}

	// 反代回传 X-Forwarded-Proto: https 时应照常 302（部署形态允许 TLS 终止在反代）。
	req2 := httptest.NewRequest(http.MethodGet, "http://"+appID+"."+testBaseDomain+"/", nil)
	req2.Header.Set("X-Forwarded-Proto", "https")
	rec2 := e.serve(req2)
	if rec2.Code != http.StatusFound {
		t.Fatalf("反代终止 TLS 时应 302 换票，得到 %d", rec2.Code)
	}
}

// ===== 步骤⑥：匿名限流（R35）=====

func TestServe_AnonymousRateLimited(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		o.Limiter = anonlimit.New(anonlimit.Options{
			GlobalRatePerMin: 1000, GlobalBurst: 1000,
			PerIPRatePerMin: 1, PerIPBurst: 1,
		})
	})
	appID := e.appID("anon")
	e.publishApp(appSpec{appID: appID})

	if rec := e.get(appID, "/api/x"); rec.Code != http.StatusOK {
		t.Fatalf("第一个匿名请求应放行，得到 %d", rec.Code)
	}
	rec := e.get(appID, "/api/x")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("第二个匿名请求应被限流，得到 %d", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("429 必须带 Retry-After（§4.6/§7.4）")
	}
	if code := errorCodeOf(t, rec.Body); code != "RATE_LIMITED" {
		t.Fatalf("错误码应为 RATE_LIMITED，得到 %q", code)
	}
	// 浏览器直访（非 /api）拿到的是同一个码的可读 HTML 页，不是裸状态码。
	if htmlRec := e.get(appID, "/"); htmlRec.Code != http.StatusTooManyRequests {
		t.Fatalf("浏览器请求同样应 429，得到 %d", htmlRec.Code)
	} else if !strings.Contains(htmlRec.Body.String(), "RATE_LIMITED") {
		t.Fatalf("HTML 错误页里应带错误码: %s", htmlRec.Body.String())
	}

	// 已登录请求**不**走匿名限流（R35：限流只针对匿名）。
	cookie := e.loggedInCookie(appID)
	if rec := e.get(appID, "/", cookie); rec.Code != http.StatusOK {
		t.Fatalf("已登录请求不应被匿名限流拦住，得到 %d body=%s", rec.Code, rec.Body.String())
	}
}

// ===== 步骤⑦：跨应用写防护（§4.8 / §10.4 第 44 项）=====

func TestServe_CrossOriginWriteRejected(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("csrf")
	e.publishApp(appSpec{appID: appID})

	// 正确源：放行。
	if rec := e.post(appID, "/api/save", "application/json", `{}`); rec.Code != http.StatusOK {
		t.Fatalf("同源 POST 应放行，得到 %d body=%s", rec.Code, rec.Body.String())
	}

	// 跨源：403（同 eTLD+1 下 SameSite=Strict 挡不住这种写，必须靠 Origin 校验）。
	req := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), strings.NewReader(`{}`))
	req.Header.Set("Origin", "https://evil.example.com")
	rec := e.serve(req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨源 POST 应 403，得到 %d", rec.Code)
	}
	if code := errorCodeOf(t, rec.Body); code != "FORBIDDEN" {
		t.Fatalf("错误码应为 FORBIDDEN，得到 %q", code)
	}

	// 同基域但**另一个应用**的源：同样拒（这正是"跨应用写"的形态）。
	req2 := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), strings.NewReader(`{}`))
	req2.Header.Set("Origin", "https://other."+testBaseDomain)
	if rec := e.serve(req2); rec.Code != http.StatusForbidden {
		t.Fatalf("其它应用子域的 POST 应 403，得到 %d", rec.Code)
	}

	// 两者都缺：拒（宁可拒一次合法请求，也不放过一次跨源写）。
	req3 := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), strings.NewReader(`{}`))
	if rec := e.serve(req3); rec.Code != http.StatusForbidden {
		t.Fatalf("无 Origin 无 Referer 的 POST 应 403，得到 %d", rec.Code)
	}

	// 只有 Referer（老浏览器）：前缀命中自身源即放行。
	req4 := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), strings.NewReader(`{}`))
	req4.Header.Set("Referer", "https://"+appID+"."+testBaseDomain+"/page")
	if rec := e.serve(req4); rec.Code != http.StatusOK {
		t.Fatalf("Referer 命中自身源的 POST 应放行，得到 %d", rec.Code)
	}

	// 幂等方法不需要 Origin。
	req5 := httptest.NewRequest(http.MethodGet, appURL(appID, "/"), nil)
	if rec := e.serve(req5); rec.Code != http.StatusOK {
		t.Fatalf("无 Origin 的 GET 应放行，得到 %d", rec.Code)
	}
}

// ===== 步骤⑧：请求体上限（§4.6）=====

func TestServe_BodyTooLargeIs413JSON(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("bigbody")
	e.publishApp(appSpec{appID: appID})

	// (a) Content-Length 撒谎/超大：不读一个字节就能拒。
	big := strings.Repeat("a", limits.AppRequestBodyMaxBytes+1)
	req := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), strings.NewReader(big))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://"+appID+"."+testBaseDomain)
	rec := e.serve(req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超大请求体应 413，得到 %d", rec.Code)
	}
	if code := errorCodeOf(t, rec.Body); code != "BODY_TOO_LARGE" {
		t.Fatalf("错误码应为 BODY_TOO_LARGE（不得退化成无指向的 400），得到 %q", code)
	}

	// (b) 无 Content-Length（chunked 形态）：MaxBytesReader 必须兜住。
	req2 := httptest.NewRequest(http.MethodPost, appURL(appID, "/api/save"), &endlessReader{})
	req2.Header.Set("Content-Type", "application/json")
	req2.Header.Set("Origin", "https://"+appID+"."+testBaseDomain)
	if req2.ContentLength >= 0 {
		t.Fatalf("该用例要求 ContentLength 未知，得到 %d", req2.ContentLength)
	}
	rec2 := e.serve(req2)
	if rec2.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("无长度声明的超大请求体应 413，得到 %d body=%s", rec2.Code, rec2.Body.String())
	}
	if code := errorCodeOf(t, rec2.Body); code != "BODY_TOO_LARGE" {
		t.Fatalf("错误码应为 BODY_TOO_LARGE，得到 %q", code)
	}
}

// endlessReader 永远产出 'a'（模拟 chunked 的超大请求体）。
type endlessReader struct{}

func (endlessReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	return len(p), nil
}

// ===== 队列（§4.6 / §10.3 第 32/33 项）=====

func TestServe_QueueFullIs429WithRetryAfter(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		// 每应用队列 1：A 在跑、B 排队（占满容量）、C 必须 429。
		o.Scheduler = queue.New(queue.Options{PerAppQueue: 1, PerUserPerAppQueued: 1})
	})
	appID := e.appID("queue")
	e.publishApp(appSpec{appID: appID})
	// guest 预算用平台缺省（10 s）：本用例要验证的是**队列**，不是预算；
	// 收紧预算会让"应用还没跑完就被预算收掉"混进来（负载高时必现假红）。
	// A 持有执行槽 1.5 s，给"B 排队、C 被拒"留出充裕窗口。
	done := make(chan int, 2)
	go func() { done <- e.get(appID, "/slow?ms=1500").Code }()
	waitFor(t, func() bool { running, _ := e.srv.scheduler.AppStats(appID); return running > 0 },
		"第一个请求进入执行槽")
	go func() { done <- e.get(appID, "/slow?ms=1").Code }()
	waitFor(t, func() bool { return e.srv.scheduler.Stats().Waiting > 0 }, "第二个请求进入队列")

	rec := e.get(appID, "/api/slow?ms=1")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("队列满应 429，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("队列满的 429 必须带 Retry-After")
	}
	if code := errorCodeOf(t, rec.Body); code != "APP_QUEUE_FULL" {
		t.Fatalf("错误码应为 APP_QUEUE_FULL，得到 %q", code)
	}
	for i := 0; i < 2; i++ {
		select {
		case code := <-done:
			if code != http.StatusOK {
				t.Fatalf("在跑/排队的请求都应成功，得到 %d", code)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("在跑/排队的请求没有在预期时间内结束（队列唤醒失效？）")
		}
	}

	// 排队等待必须进调用事件（§4.9 queue_wait_ms）。
	// 只有 2 条：被 429 拒的第三个请求根本没进 wasm（这正是队列闸门的意义）。
	if n := e.waitForEvents(appID, 2); n != 2 {
		t.Fatalf("应有 2 条调用事件（429 的请求不产生事件），得到 %d", n)
	}
	var maxWait int64
	if err := e.db.QueryRow(
		`SELECT COALESCE(MAX(queue_wait_ms), 0) FROM wasm_call_events WHERE app_id = $1`, appID).
		Scan(&maxWait); err != nil {
		t.Fatalf("查 queue_wait_ms: %v", err)
	}
	if maxWait <= 0 {
		t.Fatalf("排队过的请求 queue_wait_ms 应 > 0，得到 %d", maxWait)
	}
}

// waitFor 轮询等待条件成立（带超时，失败即 Fatal）。
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s", what)
}
