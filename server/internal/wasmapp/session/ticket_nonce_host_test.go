package session

// ---- 换票 nonce 的主机名归一化、Cookie 可写性与"唯一出口"的配置面（R2-2 / R2-3，2026-09-19
// 第二轮对抗审计 §1.2–§1.3）----
//
// 两条实测形态（审计探针：真库 + 真 HTTP）：
//
//	A. 基域与对外地址**逐字相同**（都是 `harness.example.com:8443`）却被判成"不同域"
//	   —— 旧实现里 baseHost 只做 normalizeDomain（不剥端口），mainHost 走 originHost
//	   （剥端口）⇒ 登录可见 / 白名单应用的换票一律 500，而页面文案让管理员去检查一个
//	   本来就对的配置；
//	B. 未配对外地址时 derive 出的 `Domain=<host>:<port>` 被 net/http **静默省略**整个属性
//	   ⇒ Cookie 退化成 host-only ⇒ 子域兑换恒失败，零 ERROR 零审计（静默死）。
//
// 判据（与交付报告的验收表逐条对应）：
//
//	① 基域 == 对外地址（都带端口）⇒ 判定 required、签票 200、兑换成功（不 500）；
//	② 带端口的 derive ⇒ Set-Cookie 的 Domain **不带端口**，且**标准库 cookie jar**
//	   （RFC 6265 实现，host-only 与 Domain 两种语义在这里分岔）真的把它交给应用子域；
//	③ 常规形态（无端口）不回归；
//	④ 归一之后仍写不出可用 Cookie Domain（IP 字面量 / 含下划线的主机名）⇒ **fail-loud**：
//	   500 + ERROR（含可执行动作）+ 审计，且响应里没有任何 Cookie（绝不静默降级成 host-only）；
//	⑤ fail-closed 的"唯一出口"只给运维**实际可做**的动作：拒绝路径的 ERROR 日志与面向运维的
//	   文档（`server/.env.example`、`docs/releases/*.md`）里不得出现"去打开某个 Go 字段"式指引，
//	   且 `.env.example` 的示例组合必须自洽（基域主机 == 对外地址主机）——那是本题的现场。
//
// 变异验证（实跑记录见 temp/wasm-review-r1/fix-audit2.md）：
//   - baseHost 改回 normalizeDomain（不剥端口）⇒ ①②（判定与 Set-Cookie/jar）红；
//   - 去掉 cookieDomainWritable 闸门（IP/下划线静默降级）⇒ ④ 红；
//   - 把 Options.AllowTicketWithoutNonce 写回拒绝日志或运维文档 ⇒ ⑤ 红。

import (
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// 带端口的部署（审计形态 A/B 的现场值）：基域与对外地址逐字相同。
const (
	portBaseDomain = "harness.example.com:8443"
	portOrigin     = "https://harness.example.com:8443"
)

// formReqOn 构造打在**自定义源**上的同源表单 POST（formReq 固定打在 testMainOrigin 上，
// 而本文件的判据必须覆盖"主站/基域带非默认端口"的部署）。
func formReqOn(origin, path string, form url.Values) *http.Request {
	r := httpsReq(http.MethodPost, origin+path, strings.NewReader(form.Encode()))
	r.Header.Set("Origin", origin)
	return r
}

// loginAsOn 在**自定义源**上走完整登录流程（loginAs 固定打在 testMainOrigin 上；带端口的
// 部署在 MainOrigin 是严格断言，登录必须发生在同一个源上，否则连登录都会被 403 挡掉）。
func loginAsOn(t *testing.T, env *testEnv, username, origin string) *http.Cookie {
	t.Helper()
	env.newUserIfMissing(t, username)
	rec := httptest.NewRecorder()
	env.mgr.LoginSubmit(rec, formReqOn(origin, "/login", url.Values{
		"username": {username}, "password": {testPassword}, "next": {"/"},
	}))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("在 %s 上登录状态码 = %d, want 303；body=%s", origin, rec.Code, rec.Body.String())
	}
	c := cookieByName(rec.Result().Cookies(), EmployeeCookieName)
	if c == nil {
		t.Fatalf("在 %s 上登录成功但没有下发员工会话 Cookie", origin)
	}
	return c
}

// issueTicketOn 在指定源上走一次 POST /app-ticket，返回**原始响应**（断言 Set-Cookie 字节用）。
func issueTicketOn(t *testing.T, env *testEnv, origin string, empCookie *http.Cookie, appID string) *httptest.ResponseRecorder {
	t.Helper()
	r := formReqOn(origin, "/app-ticket", url.Values{"app": {appID}, "next": {"/"}})
	if empCookie != nil {
		r.AddCookie(empCookie)
	}
	rec := httptest.NewRecorder()
	env.mgr.TicketSubmit(rec, r)
	return rec
}

// browserJar 把一次响应的 Set-Cookie 交给**标准库 cookie jar**（net/http/cookiejar 是
// RFC 6265 的实现），再问它"应用子域会收到哪些 Cookie"。
//
// 为什么用它而不是只做字符串断言：host-only 与 `Domain=` 两种语义在 jar 里分岔 ——
// 旧实现（Domain 带端口）会让 jar 直接丢弃这条 Cookie，于是"服务端以为发了、浏览器
// 根本没存"，兑换端只能看到 nonce 缺席。这正是本题要消灭的静默死。
func browserJar(t *testing.T, rec *httptest.ResponseRecorder, setURL, askURL string) []*http.Cookie {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	set, err := url.Parse(setURL)
	if err != nil {
		t.Fatalf("解析下发地址 %q: %v", setURL, err)
	}
	ask, err := url.Parse(askURL)
	if err != nil {
		t.Fatalf("解析询问地址 %q: %v", askURL, err)
	}
	jar.SetCookies(set, rec.Result().Cookies())
	return jar.Cookies(ask)
}

// assertDomainIsHostWithoutPort 钉住 Set-Cookie 的 Domain 逐字节形状。
func assertDomainIsHostWithoutPort(t *testing.T, raw string, wantHost string) {
	t.Helper()
	if raw == "" {
		t.Fatalf("响应里没有 %s 的 Set-Cookie（浏览器持有性证明等于不存在）", TicketNonceCookieName)
	}
	if !strings.Contains(raw, "Domain="+wantHost) {
		t.Fatalf("Set-Cookie 没有可用的 Domain=%s：%q（Domain 写不出去 ⇒ 浏览器静默丢弃该属性 ⇒ 子域兑换恒失败）",
			wantHost, raw)
	}
	if strings.Contains(raw, ":8443") {
		t.Fatalf("Set-Cookie 里出现了端口：%q（Cookie 的作用域不含端口，net/http 会静默省略整个 Domain 属性）", raw)
	}
}

// TestSameValueWithPortIsNotTreatedAsForeignDomain 覆盖判据 ①（审计形态 A）：
// 基域与对外地址**写的是同一个值**（含端口）时必须照常签发 + 兑换，不许 500。
func TestSameValueWithPortIsNotTreatedAsForeignDomain(t *testing.T) {
	env := newEnv(t, func(o *Options) {
		o.BaseDomain = func() string { return portBaseDomain }
		o.MainOrigin = portOrigin
	})
	env.newApp(t, "my-app", "alice")
	empCookie := loginAsOn(t, env, "alice", portOrigin)

	// 判定：同一个值必须判成 required（旧实现：mainHost 剥端口、baseHost 不剥 ⇒ "不同域"）。
	dec := env.mgr.ticketNonceDecision()
	if dec.Plan != ticketNonceRequired {
		t.Fatalf("基域与对外地址逐字相同的部署被判成 %v（reason=%s）⇒ 登录可见 / 白名单应用一律 500，而文案会让管理员去查一个本来就对的配置",
			dec.Plan, dec.Reason)
	}
	if dec.CookieDomain != testMainHost {
		t.Fatalf("CookieDomain = %q, want %q（Cookie 的 Domain 属性不允许端口）", dec.CookieDomain, testMainHost)
	}

	// 签发：200 + 可用的 Domain（不得 500）。
	rec := issueTicketOn(t, env, portOrigin, empCookie, "my-app")
	if rec.Code != http.StatusOK {
		t.Fatalf("签发状态码 = %d, want 200；body=%s", rec.Code, rec.Body.String())
	}
	assertDomainIsHostWithoutPort(t, rawSetCookieFor(rec, TicketNonceCookieName), testMainHost)

	// 浏览器语义：应用子域（同端口）真的收得到这份 nonce。
	appURL := "https://my-app." + portBaseDomain + "/"
	jarNonce := cookieByName(browserJar(t, rec, portOrigin, appURL), TicketNonceCookieName)
	if jarNonce == nil {
		t.Fatalf("标准 cookie jar 认为应用子域收不到 nonce ⇒ 兑换必然失败（Set-Cookie: %q）",
			rawSetCookieFor(rec, TicketNonceCookieName))
	}

	// 整条链路：用 jar 交给子域的那份 nonce 兑换。
	it := parseIssuedTicket(t, rec)
	redeemRec := httptest.NewRecorder()
	clean, ok := env.mgr.RedeemTicket(redeemRec, redeemReq(t, it, jarNonce), "my-app")
	if !ok {
		t.Fatal("基域与对外地址同值（带端口）的部署换票兑换失败 —— 这正是审计里那条 500/静默死的现场")
	}
	if clean != "/" {
		t.Fatalf("干净 URL = %q, want /", clean)
	}
	if cookieByName(redeemRec.Result().Cookies(), AppCookieName) == nil {
		t.Fatal("兑换成功后没有下发应用会话 Cookie")
	}
}

// TestDerivedCookieDomainDropsPort 覆盖判据 ②（审计形态 B）：
// 未配对外地址（derive）时，Cookie 必须写成**不带端口**的基域主机名，且标准 jar 会把它
// 交给应用子域 —— 不允许再出现"Domain 带端口 ⇒ net/http 静默省略 ⇒ host-only 静默死"。
func TestDerivedCookieDomainDropsPort(t *testing.T) {
	env := newEnv(t, func(o *Options) {
		o.BaseDomain = func() string { return portBaseDomain }
		o.MainOrigin = "" // 对外地址未配置 ⇒ 按基域推导
	})
	env.newApp(t, "my-app", "alice")
	empCookie := loginAsOn(t, env, "alice", portOrigin)

	dec := env.mgr.ticketNonceDecision()
	if dec.Plan != ticketNonceRequired || !dec.Derived {
		t.Fatalf("判定 = %+v, want required + Derived", dec)
	}
	if dec.CookieDomain != testMainHost {
		t.Fatalf("派生出的 CookieDomain = %q，带端口 ⇒ net/http 会静默省略 Domain 属性（静默死）", dec.CookieDomain)
	}
	if dec.MainOrigin != portOrigin {
		t.Fatalf("诊断用的推导源 = %q, want %q（如实反映部署，端口不隐藏）", dec.MainOrigin, portOrigin)
	}

	rec := issueTicketOn(t, env, portOrigin, empCookie, "my-app")
	if rec.Code != http.StatusOK {
		t.Fatalf("签发状态码 = %d, want 200；body=%s", rec.Code, rec.Body.String())
	}
	raw := rawSetCookieFor(rec, TicketNonceCookieName)
	assertDomainIsHostWithoutPort(t, raw, testMainHost)

	appURL := "https://my-app." + portBaseDomain + "/"
	jarNonce := cookieByName(browserJar(t, rec, portOrigin, appURL), TicketNonceCookieName)
	if jarNonce == nil {
		t.Fatalf("标准 cookie jar 认为应用子域收不到 nonce（旧实现 = host-only 静默死）：Set-Cookie=%q", raw)
	}

	it := parseIssuedTicket(t, rec)
	redeemRec := httptest.NewRecorder()
	if _, ok := env.mgr.RedeemTicket(redeemRec, redeemReq(t, it, jarNonce), "my-app"); !ok {
		t.Fatal("带端口基域 + 未配对外地址的部署兑换失败（审计形态 B 的静默死）")
	}
}

// TestPortlessDeploymentKeepsWorking 覆盖判据 ③：常规形态（基域 == 主站主机、无端口）
// 的判定、Cookie 属性与 jar 语义一字不变（防"修带端口把常规形态改坏"）。
func TestPortlessDeploymentKeepsWorking(t *testing.T) {
	env := nonceEnv(t)
	env.newApp(t, "my-app", "alice")
	empCookie, _ := env.loginAs(t, "alice")

	dec := env.mgr.ticketNonceDecision()
	if dec.Plan != ticketNonceRequired || dec.Derived || dec.CookieDomain != testMainHost {
		t.Fatalf("常规形态判定 = %+v, want required + 非推导 + Domain=%s", dec, testMainHost)
	}
	rec := issueTicketOn(t, env, testMainOrigin, empCookie, "my-app")
	if rec.Code != http.StatusOK {
		t.Fatalf("常规形态签发状态码 = %d, want 200", rec.Code)
	}
	assertDomainIsHostWithoutPort(t, rawSetCookieFor(rec, TicketNonceCookieName), testMainHost)
	appURL := "https://my-app." + testMainHost + "/"
	if cookieByName(browserJar(t, rec, testMainOrigin, appURL), TicketNonceCookieName) == nil {
		t.Fatal("常规形态下应用子域收不到 nonce（回归）")
	}
}

// TestUnwritableBaseDomainFailsLoud 覆盖判据 ④：归一之后仍写不出可用 Cookie Domain 的
// 部署**必须大声失败**（500 + ERROR + 审计 + 不下发任何 Cookie），而不是静默发一条浏览器
// 收不到的 Cookie（审计形态 B 的变体：带下划线内网域名 / IP+端口）。
func TestUnwritableBaseDomainFailsLoud(t *testing.T) {
	cases := []struct {
		name string
		base string
	}{
		{"IP 字面量带端口", "127.0.0.1:8443"},
		{"带下划线的内网域名", "harness_example.com"},
		{"裸 IP（显式 https 前缀）", "https://10.0.0.7"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs := captureLogs(t, &logError)
			env := newEnv(t, func(o *Options) {
				o.BaseDomain = func() string { return tc.base }
				o.MainOrigin = ""
			})
			env.newApp(t, "my-app", "alice")
			empCookie, _ := env.loginAs(t, "alice")

			dec := env.mgr.ticketNonceDecision()
			if dec.Plan != ticketNonceUnavailable {
				t.Fatalf("判定 = %+v, want unavailable（写不出 Cookie Domain 的基域不得被判成可用）", dec)
			}
			if !strings.HasPrefix(dec.Reason, "base_domain_not_cookie_writable:") {
				t.Fatalf("原因 = %q, want base_domain_not_cookie_writable:*", dec.Reason)
			}

			_, hostWithPort := ParseBaseDomain(tc.base)
			rec := issueTicketOn(t, env, "https://"+hostWithPort, empCookie, "my-app")
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("签发状态码 = %d, want 500（fail-loud：宁可不签发票，也不发一张注定兑换不了的票）", rec.Code)
			}
			if cks := rec.Result().Cookies(); len(cks) != 0 {
				t.Fatalf("拒绝签发票时不得下发任何 Cookie，得到 %v（nonce host-only 静默降级 = 静默死）", cks)
			}
			// 非静默：审计 + ERROR 日志（含原因与可执行动作）。
			detail := env.audit.waitFor(t, "app_ticket_issue")
			if !strings.Contains(detail, "rejected=nonce_unavailable") {
				t.Fatalf("审计明细 = %q, want 含 rejected=nonce_unavailable", detail)
			}
			lines := errs()
			if !hasLog(lines, "base_domain_not_cookie_writable") {
				t.Fatalf("ERROR 日志没有说明原因（静默失败）：%v", lines)
			}
			if !hasLog(lines, ticketNonceRemedyBaseDomain) {
				t.Fatalf("ERROR 日志没有给出可执行动作：%v", lines)
			}
		})
	}
}

// TestTicketRefusalGivesOperatorActionableRemedy 覆盖判据 ⑤（拒绝路径的文案面）：
// 运维实际看到的那条 ERROR 里必须**只有**他能做的动作，不得再指回任何 Go 字段。
//
// 变异验证：把 `Options.AllowTicketWithoutNonce` 写回 refuseTicketNonce 的日志 ⇒ 本用例红。
func TestTicketRefusalGivesOperatorActionableRemedy(t *testing.T) {
	errs := captureLogs(t, &logError)
	// 现场形态：`.env.example` 曾经给出的组合（基域 apps.example.com + 对外地址另一个域）。
	env := newEnv(t, func(o *Options) {
		o.BaseDomain = func() string { return "apps.example.com" }
		o.MainOrigin = "https://ai.example.com"
	})
	env.newApp(t, "my-app", "alice")
	empCookie := loginAsOn(t, env, "alice", "https://ai.example.com")

	rec := issueTicketOn(t, env, "https://ai.example.com", empCookie, "my-app")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("主站域 ≠ 基域时应 fail-closed 拒绝签发票（500），得到 %d", rec.Code)
	}
	lines := errs()
	if !hasLog(lines, "main_origin_not_same_domain_as_base") {
		t.Fatalf("ERROR 日志没有说明原因：%v", lines)
	}
	remedyLine := ""
	for _, line := range lines {
		if strings.Contains(line, "AllowTicketWithoutNonce") || strings.Contains(line, "session.Options") {
			t.Fatalf("拒绝日志把运维指向了一个他打不开的 Go 字段（审计 §1.3 的原病）：%q", line)
		}
		if strings.Contains(line, ticketNonceRemedyAlignOrigin) {
			remedyLine = line
		}
	}
	if remedyLine == "" {
		t.Fatalf("ERROR 日志没有给出可执行动作（%q）：%v", ticketNonceRemedyAlignOrigin, lines)
	}
	for _, knob := range []string{"server.base_url", publicBaseURLEnvName, "PICOAI_APPS_BASE_DOMAIN"} {
		if !strings.Contains(remedyLine, knob) {
			t.Fatalf("拒绝日志缺少可执行配置项 %q：%q", knob, remedyLine)
		}
	}
}

// repoFile 读仓库根的某个文件（用 runtime.Caller 定位本文件，再向上找到仓库根）——
// 与工作目录无关，`go test ./...` 在任何起点都成立。
func repoFile(t *testing.T, rel string) string {
	t.Helper()
	_, self, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller 取不到本文件路径")
	}
	dir := filepath.Dir(self)
	for i := 0; i < 8; i++ {
		candidate := filepath.Join(dir, rel)
		if _, err := os.Stat(candidate); err == nil {
			return candidate
		}
		dir = filepath.Dir(dir)
	}
	t.Fatalf("从 %s 向上找不到仓库文件 %s", filepath.Dir(self), rel)
	return ""
}

// TestTicketNoncePromisesStayActionable 覆盖判据 ⑤ 的文档面（选项 ② 的判据）：
// 面向运维的出口（`.env.example` 与发布说明）里**不得**再出现"去打开某个 Go 字段"式指引，
// 且 `.env.example` 的应用基域示例必须与对外地址示例**同域**（审计 §1.3 的死路示例）。
//
// 变异验证：
//   - 把 `PICOAI_APPS_BASE_DOMAIN` 示例改回 `apps.example.com`（与对外地址示例不同域）⇒ 子用例红；
//   - 在发布说明或 `.env.example` 里写回 `AllowTicketWithoutNonce` ⇒ 子用例红。
func TestTicketNoncePromisesStayActionable(t *testing.T) {
	t.Run("运维文档不得指引去开 Go 字段", func(t *testing.T) {
		surfaces := []string{
			filepath.Join("server", ".env.example"),
			filepath.Join("docs", "releases", "v2.7.6-beta.5.md"),
		}
		for _, rel := range surfaces {
			body, err := os.ReadFile(repoFile(t, rel))
			if err != nil {
				t.Fatalf("读 %s 失败: %v", rel, err)
			}
			if strings.Contains(string(body), "AllowTicketWithoutNonce") {
				t.Fatalf("%s 里出现了 Go 字段名：运维没有配置面，任何指向它的措辞都是做不到的承诺"+
					"（要说明「没有这个开关」就用自然语言，不要给字段名）", rel)
			}
		}
	})

	t.Run(".env.example 的基域示例与对外地址示例必须同域", func(t *testing.T) {
		body, err := os.ReadFile(repoFile(t, filepath.Join("server", ".env.example")))
		if err != nil {
			t.Fatalf("读 .env.example 失败: %v", err)
		}
		baseExample := exampleValue(string(body), "PICOAI_APPS_BASE_DOMAIN")
		publicExample := exampleValue(string(body), "PICOAI_PUBLIC_BASE_URL")
		if baseExample == "" || publicExample == "" {
			t.Fatalf(".env.example 缺少示例值：base=%q public=%q", baseExample, publicExample)
		}
		_, baseHost := ParseBaseDomain(baseExample)
		publicURL, perr := url.Parse(publicExample)
		if perr != nil || publicURL.Hostname() == "" {
			t.Fatalf("对外地址示例解析不出主机名：%q (%v)", publicExample, perr)
		}
		if want := normalizeHostOnly(baseHost); want != publicURL.Hostname() {
			t.Fatalf(".env.example 的示例组合会走进死路：应用基域 %q 与对外地址 %q 不同域 ⇒ "+
				"登录可见 / 白名单应用一律拒绝签发票（审计 §1.3 的现场）", baseHost, publicURL.Hostname())
		}
	})
}

// exampleValue 取出 `.env.example` 里某个变量的**注释示例值**（`# NAME=value`）。
//
// 只认注释形式：这些变量在示例文件里都是"注释掉的推荐值"，未注释的那一行才是给用户改的。
func exampleValue(body, name string) string {
	for _, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") {
			continue
		}
		kv := strings.TrimSpace(strings.TrimPrefix(trimmed, "#"))
		if !strings.HasPrefix(kv, name+"=") {
			continue
		}
		value := strings.TrimSpace(strings.TrimPrefix(kv, name+"="))
		// 行内注释（`# NAME=value  # 说明`）在示例文件里不存在，这里只做防御性截断。
		if i := strings.Index(value, " #"); i >= 0 {
			value = strings.TrimSpace(value[:i])
		}
		return value
	}
	return ""
}
