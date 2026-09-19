package session

// 本文件是 2026-09-19 第三轮对抗审计 A-1/A-2（两条 P2）的**行为级护栏**：
//
//	A-1 尾点基域（`apps.example.com..:8443`）与 A-2 单标签基域（`intranet`）在旧实现里
//	能穿过闸门 → 服务端 200 + `Domain=<畸形值>` + 零 ERROR + 零审计，而真 Chromium
//	整条丢弃该 Cookie ⇒ 兑换恒失败（"静默死"）。
//
// 判据全部行为级：真 PG + 真登录 + 真 `POST /app-ticket` + 真 Set-Cookie 字节 +
// 真审计 + 真 `net/http/cookiejar`（RFC 6265 参考实现）。没有"只断言函数返回值"的用例。
//
// 变异验证（改回旧实现 ⇒ 本文件必红，实测见 temp/wasm-review-r1/fix-round3-A.md）：
//   - `cookieDomainWritable` 改回"只问 net/http 的 Cookie.String" ⇒ 第一组用例红
//     （尾点域与单标签域会被判定为可写 ⇒ 200 而不是 500）；
//   - `normalizeHostOnly` 改回"只剥一个尾点、端口在剥点之后才切" ⇒ `..:8443` 那两行红；
//   - 放行单标签 / 公网后缀 / localhost ⇒ 对应子用例红。

import (
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
	"time"
)

// TestBaseDomainGateFailsLoudForBrowserDiscardableForms 覆盖 P2-1/P2-2 的判据①：
// 这些基域**必须 fail-loud 拒发**（500 + ERROR + 审计 + 响应零 Cookie），不得 200。
func TestBaseDomainGateFailsLoudForBrowserDiscardableForms(t *testing.T) {
	cases := []struct {
		name       string
		base       string
		wantReason string
		// wantExtra 是 ERROR 日志里除原因码/配置项名之外还必须出现的**可行动作要点**。
		wantExtra []string
	}{
		// 多尾点档：ERROR 必须点名"多余的结尾点"并给出**正确写法**（运维照抄即可）。
		{"端口前双尾点（A-1 现场：只剥一个尾点 + 端口在剥点之后才切）", "apps.example.com..:8443", "multiple_trailing_dots",
			[]string{"结尾点", "apps.example.com"}},
		{"双尾点（无端口）", "apps.example.com..", "multiple_trailing_dots", []string{"结尾点", "apps.example.com"}},
		{"单标签（A-2 现场：内网常见）", "intranet", "single_label", nil},
		{"公网后缀（多标签）", "co.uk", "public_suffix", nil},
		{"公网后缀（私有段）", "github.io", "public_suffix", nil},
		{"保留名 localhost", "localhost", "reserved_host", nil},
		{"mDNS 保留后缀 .local", "corp.local", "reserved_host", nil},
		{"IP 字面量", "10.0.0.7", "ip_not_allowed", nil},
		{"下划线", "harness_example.com", "bad_label", nil},
		{"前导点（空标签）", ".apps.example.com", "bad_label", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			errs := captureLogs(t, &logError)
			env := newEnv(t, func(o *Options) {
				o.BaseDomain = func() string { return tc.base }
				// 未配对外地址 ⇒ 走"按基域推导"这条路径：旧实现正是在这里静默 200。
				o.MainOrigin = ""
			})
			env.newApp(t, "my-app", "alice")
			empCookie, _ := env.loginAs(t, "alice")
			before := env.mgr.tickets.size()

			rec := issueTicketOn(t, env, testMainOrigin, empCookie, "my-app")

			// ① 拒绝必须发生在**签发侧**（而不是等兑换时才发现）。
			if rec.Code != http.StatusInternalServerError {
				t.Fatalf("基域 %q：签发状态码 = %d，want 500（200 = 又签出一张浏览器拿不到 nonce 的票 ⇒ 静默死）",
					tc.base, rec.Code)
			}
			// ② 响应零 Cookie（绝不发一条注定被丢弃的 Set-Cookie）。
			if cs := rec.Result().Cookies(); len(cs) != 0 {
				t.Fatalf("基域 %q：拒绝签发却下发了 %d 条 Cookie：%v", tc.base, len(cs), cookieNames(cs))
			}
			// ③ 不留"注定兑换不了"的票（拒绝前有多少张，拒绝后还是多少张）。
			if after := env.mgr.tickets.size(); after != before {
				t.Fatalf("基域 %q：拒绝签发却在 store 里留下票（%d → %d）", tc.base, before, after)
			}
			// ④ ERROR 日志：原因码 + 运维可做的动作（配置键名）。
			lines := errs()
			if !hasLog(lines, "base_domain_not_cookie_writable") {
				t.Fatalf("基域 %q：ERROR 日志没有点名原因：%v", tc.base, lines)
			}
			if !hasLog(lines, tc.wantReason) {
				t.Fatalf("基域 %q：ERROR 日志缺少原因码 %q：%v", tc.base, tc.wantReason, lines)
			}
			for _, want := range tc.wantExtra {
				if !hasLog(lines, want) {
					t.Fatalf("基域 %q：ERROR 日志缺少可行动作要点 %q（运维要能看出是「多余结尾点」并知道正确写法）：%v",
						tc.base, want, lines)
				}
			}
			if !hasLog(lines, "PICOAI_APPS_BASE_DOMAIN") {
				t.Fatalf("基域 %q：ERROR 日志没有给出可行动作（应点名 PICOAI_APPS_BASE_DOMAIN / server.base_url）：%v",
					tc.base, lines)
			}
			// ⑤ 审计留痕（拒绝也要能被审计查到，否则"零审计"那半条又回来了）。
			// 审计回调是异步的（auditAsync）：轮询等待，而不是赌它已经落账。
			d := waitAuditDetail(t, env.audit, "app_ticket_issue")
			if !strings.Contains(d, "rejected=nonce_unavailable") {
				t.Fatalf("基域 %q：审计 = %q，want 含 rejected=nonce_unavailable", tc.base, d)
			}
		})
	}
}

// TestBaseDomainGateKeepsLegalForms 覆盖判据②（不回归）：合法形态照常签发，
// 且下发的 Domain 必须是**规范形态**（浏览器真的会存 —— 用 RFC 6265 参考实现验证）。
func TestBaseDomainGateKeepsLegalForms(t *testing.T) {
	const mainOrigin = "https://apps.example.com"
	cases := []struct {
		name string
		base string
		want string // 期望的 Cookie Domain（归一化后）
	}{
		{"普通两级域", "apps.example.com", "apps.example.com"},
		{"带端口（端口不参与 Cookie 作用域）", "apps.example.com:8443", "apps.example.com"},
		{"大小写", "APPS.Example.COM", "apps.example.com"},
		{"单个尾点（FQDN 根点）", "apps.example.com.", "apps.example.com"},
		{"尾点在端口前（单点）", "apps.example.com.:8443", "apps.example.com"},
		{"显式 https 前缀", "https://apps.example.com", "apps.example.com"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := newEnv(t, func(o *Options) {
				o.BaseDomain = func() string { return tc.base }
				o.MainOrigin = mainOrigin
			})
			env.newApp(t, "my-app", "alice")
			empCookie := loginAsOn(t, env, "alice", mainOrigin)

			dec := env.mgr.ticketNonceDecision()
			if dec.Plan != ticketNonceRequired {
				t.Fatalf("合法形态 %q 被判成不可用（reason=%s）⇒ 登录可见应用一律 500", tc.base, dec.Reason)
			}
			if dec.CookieDomain != tc.want {
				t.Fatalf("基域 %q 的 Cookie Domain = %q, want %q", tc.base, dec.CookieDomain, tc.want)
			}
			rec := issueTicketOn(t, env, mainOrigin, empCookie, "my-app")
			if rec.Code != http.StatusOK {
				t.Fatalf("合法形态 %q：签发状态码 = %d, want 200", tc.base, rec.Code)
			}
			raw := rawSetCookieFor(rec, TicketNonceCookieName)
			assertDomainIsHostWithoutPort(t, raw, tc.want)

			// 浏览器侧：应用子域必须真的收到 nonce（两条：专属名 + 固定名）。
			got := browserJar(t, rec, mainOrigin+"/app-ticket", "https://my-app."+tc.want+"/")
			if len(got) != 2 {
				t.Fatalf("基域 %q：应用子域只收到 %d 条 Cookie（%v），浏览器会存 ⇒ 必须 2 条（专属名 + 固定名）",
					tc.base, len(got), cookieNames(got))
			}
		})
	}
}

// TestCookieDomainWritableImpliesBrowserStoresIt 是 P2-1 的**核心不变量**：
//
//	闸门说"能下发" ⇒ RFC 6265 参考实现（net/http/cookiejar）必须真的把这条 Domain Cookie
//	交给应用子域。旧实现违反它的两种形态（`harness.example.com.` 尾点、`harness.example.com..`
//	双尾点）正是"服务端 200、浏览器零 Cookie"的静默死。
//
// 反方向不成立、也不该成立：cookiejar **不实现** PSL / registry-controlled 判定
// （`com`、`co.uk`、`localhost`、单标签在 jar 里都"能存"），那几种形态的证据是真 Chromium
// （temp/audit-round3/A/chromium-cookie-probe2.mjs 实测全部 DROPPED）——
// 所以闸门必须**比 jar 更严**，这里把两侧一起钉住。
func TestCookieDomainWritableImpliesBrowserStoresIt(t *testing.T) {
	// wantJar 是 net/http/cookiejar 的**实测行为**（参考实现，不是被测对象）：
	// 它按"注册域至少两级"拒绝单标签（`com`/`intranet`/`localhost`），但不校验字符集、
	// 也按 RFC 剥前导点 ⇒ 这几处闸门必须比它更严。
	cases := []struct {
		name     string
		host     string
		wantGate bool
		wantJar  bool
		why      string
	}{
		{"规范两级域", "harness.example.com", true, true, "控制组：两侧都必须接受"},
		{"单尾点（判定层的非规范写法）", "harness.example.com.", false, false, "闸门拒（要规范形态）；jar 也丢（domain-match 失败）"},
		{"双尾点", "harness.example.com..", false, false, "A-1 形态：闸门必须拒（旧实现放行 ⇒ jar 零 Cookie）"},
		{"公网后缀", "com", false, false, "单标签：jar 也拒（闸门另有 public_suffix 判据）"},
		{"单标签（A-2 形态）", "intranet", false, false, "jar 按注册域判定也拒；真 Chromium DROPPED（见探针）"},
		{"本机保留名", "localhost", false, false, "同上；真 Chromium DROPPED（见探针）"},
		{"含下划线", "harness_example.com", false, true, "jar 不校验字符集 ⇒ 闸门必须更严（旧实现正是放行了它）"},
		{"前导点（空标签）", ".harness.example.com", false, true, "jar 按 RFC 剥前导点后接受 ⇒ 闸门必须更严（配置里前导点一律当非法）"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gate := cookieDomainWritable(tc.host)
			if gate != tc.wantGate {
				t.Fatalf("cookieDomainWritable(%q) = %t, want %t（%s）", tc.host, gate, tc.wantGate, tc.why)
			}
			jar := jarStoresForSubdomain(t, tc.host)
			if jar != tc.wantJar {
				t.Fatalf("cookiejar 存 %q 的 Domain Cookie 并交给子域 = %t, want %t（%s：参考实现的行为是事实，闸门必须以它为准或更严）",
					tc.host, jar, tc.wantJar, tc.why)
			}
			// 核心不变量：闸门放行的形态，浏览器必须真的存 —— 否则就是静默死。
			if gate && !jar {
				t.Fatalf("静默死复现：闸门说 %q 可写，而 RFC 6265 参考实现根本没存（服务端 200、浏览器零 Cookie）", tc.host)
			}
		})
	}
}

// TestBaseDomainVerdictReasonsAreStable 钉住策略层的原因码（控制台 details.reason /
// 启动期错误 / 运行期日志三处共用），避免"同一形态在不同路径给出不同说法"。
func TestBaseDomainVerdictReasonsAreStable(t *testing.T) {
	cases := []struct {
		in     string
		want   string
		host   string
		usable bool
	}{
		{"apps.example.com", "", "apps.example.com", true},
		{"APPS.Example.COM.", "", "apps.example.com", true},
		{"apps.example.com:8443", "", "apps.example.com", true},
		{"Apps.Example.COM.:8443", "", "apps.example.com", true},
		{"http://apps.example.com", "", "apps.example.com", true},
		{"apps.example.com..", "multiple_trailing_dots", "", false},
		{"apps.example.com..:8443", "multiple_trailing_dots", "", false},
		{"intranet", "single_label", "", false},
		{"co.uk", "public_suffix", "", false},
		{"localhost", "reserved_host", "", false},
		{"corp.local", "reserved_host", "", false},
		{"10.0.0.7", "ip_not_allowed", "", false},
		{"harness_example.com", "bad_label", "", false},
		{".apps.example.com", "bad_label", "", false},
		{"*.apps.example.com", "wildcard_not_allowed", "", false},
		{"apps.example.com/path", "not_a_bare_host", "", false},
		{"[::1]:8443", "not_a_bare_host", "", false},
		{"   ", "", "", false}, // 空 = 关闭子域（合法，Host 为空）
	}
	for _, tc := range cases {
		verdict := InspectAppBaseDomain(tc.in)
		if verdict.Reason != tc.want {
			t.Fatalf("InspectAppBaseDomain(%q).Reason = %q, want %q", tc.in, verdict.Reason, tc.want)
		}
		if verdict.Host != tc.host {
			t.Fatalf("InspectAppBaseDomain(%q).Host = %q, want %q", tc.in, verdict.Host, tc.host)
		}
		if tc.want != "" && verdict.Hint == "" {
			t.Fatalf("拒绝 %q 必须带可行动作（Hint），否则运维/管理员不知道该改哪里", tc.in)
		}
		// 闸门与策略层同一个结论（"能承载 Cookie"只有一份判据）。
		if got := cookieDomainWritable(tc.host); tc.usable && tc.host != "" && !got {
			t.Fatalf("策略层放行 %q，闸门却说不可写 ⇒ 两条判据分叉", tc.in)
		}
	}
}

// jarStoresForSubdomain 用 net/http/cookiejar（RFC 6265 参考实现）回答：
// "把 Domain=<host> 的 Cookie 下发在 https://<host>/ 上，https://my-app.<host>/ 收得到吗"。
// @param host - 待测的 Domain 值。
// @returns true = 子域能收到（浏览器会存）。
func jarStoresForSubdomain(t *testing.T, host string) bool {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("cookiejar.New: %v", err)
	}
	setURL, err := url.Parse("https://" + host + "/app-ticket")
	if err != nil {
		t.Fatalf("解析下发地址（host=%q）: %v", host, err)
	}
	askURL, err := url.Parse("https://my-app." + host + "/")
	if err != nil {
		t.Fatalf("解析应用子域地址（host=%q）: %v", host, err)
	}
	jar.SetCookies(setURL, []*http.Cookie{{
		Name: TicketNonceCookieName, Value: "v", Path: "/", Domain: host,
		HttpOnly: true, Secure: true, SameSite: http.SameSiteStrictMode,
	}})
	return len(jar.Cookies(askURL)) > 0
}

// waitAuditDetail 轮询等待某个审计动作的明细出现（审计回调是异步的）。
// @param rec - 审计记录器。
// @param action - 审计动作名。
// @returns 明细（超时返回空串，由调用方给出可读失败）。
func waitAuditDetail(t *testing.T, rec *auditRec, action string) string {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if detail := rec.detailOf(action); detail != "" {
			return detail
		}
		if time.Now().After(deadline) {
			return ""
		}
		time.Sleep(5 * time.Millisecond)
	}
}
