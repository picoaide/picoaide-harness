package session

import (
	"crypto/tls"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestSanitizeNextOpenRedirectTable 是开放重定向的**表驱动**覆盖（§4.7 / §15.1 第 12 条）。
//
// 每一行都写明"为什么这条必须被拒"：核心判据是返回值**永远不会**变成
// "以非 `/` 开头"或"含 `//` / `:` / `\`"的串，因此拼在 `https://<app>.<基域>` 之后
// 不可能改变目标主机。
func TestSanitizeNextOpenRedirectTable(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		// --- 经典开放重定向 payload：一律回落 `/` ---
		{"协议相对", "//evil.com", "/"},
		{"反斜杠变体", `/\evil.com`, "/"},
		{"三斜杠", "///evil.com/x", "/"},
		{"编码的协议相对", "/%2F%2Fevil.com", "/"},
		{"编码的反斜杠", `/%5Cevil.com`, "/"},
		{"绝对 http", "http://evil.com", "/"},
		{"绝对 https", "https://evil.com", "/"},
		{"javascript scheme", "javascript:alert(1)", "/"},
		{"javascript 大写", "JavaScript:alert(1)", "/"},
		{"data scheme", "data:text/html,<script>1</script>", "/"},
		{"无前导斜杠", "evil.com", "/"},
		{"空串", "", "/"},
		{"只有反斜杠", `\evil.com`, "/"},
		{"冒号在中段", "/a:b", "/"},
		{"编码冒号+斜杠", "/a%3A%2F%2Fevil.com", "/"},
		{"query 里的协议相对", "/a?x=//evil.com", "/"},
		{"query 里的绝对地址", "/a?next=https://evil.com", "/"},
		{"fragment", "/a#//evil.com", "/"},
		{"CRLF 头注入", "/a\r\nSet-Cookie:%20x=1", "/"},
		{"编码 CRLF", "/a%0d%0aX-Evil:1", "/"},
		{"NUL", "/a\x00b", "/"},
		{"空格", "/a b", "/"},
		{"制表符", "/a\tb", "/"},
		{"DEL", "/a\x7fb", "/"},
		{"超长 513", "/" + strings.Repeat("a", 512), "/"},
		{"非法百分号转义", "/a%zz", "/"},
		{"截断的百分号转义", "/a%2", "/"},

		// --- 合法：必须原样保留 ---
		{"根路径", "/", "/"},
		{"普通路径", "/dashboard", "/dashboard"},
		{"多级路径", "/a/b/c", "/a/b/c"},
		{"带 query", "/a?x=1&y=2", "/a?x=1&y=2"},
		{"一次编码的空格", "/dash%20board", "/dash%20board"},
		{"一次编码的中文", "/%E4%B8%AD%E6%96%87", "/%E4%B8%AD%E6%96%87"},
		{"路径里的加号是字面量", "/a+b", "/a+b"},
		{"恰好 512", "/" + strings.Repeat("a", 511), "/" + strings.Repeat("a", 511)},
		{"点段留在自身源内", "/a/../b", "/a/../b"},
		{
			// 明确决定的容忍度：二次编码放行。我们只解码一次做校验，
			// 且 Location 一律由原串拼出 —— 本层不可能因此改变目标主机。
			"二次编码放行（已写明的容忍度）",
			"/a?x=%252F%252Fevil.com", "/a?x=%252F%252Fevil.com",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeNext(tc.in); got != tc.want {
				t.Fatalf("sanitizeNext(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestSanitizeNextNeverEscapesHost 是表驱动之外的**性质断言**：
// 任何输入下，sanitizeNext 的结果拼在应用源之后都仍然指向同一个源。
func TestSanitizeNextNeverEscapesHost(t *testing.T) {
	inputs := []string{
		"//evil.com", `/\evil.com`, "/%2F%2Fevil.com", "https://evil.com", "javascript:",
		"/a?x=//evil.com", "/%5cevil.com", "/\t//evil.com", "/%09//evil.com",
		"/a/b", "/", "/x?y=z", "/%2e%2e/%2e%2e/etc/passwd",
	}
	const origin = "https://my-app.apps.example.com"
	for _, in := range inputs {
		got := sanitizeNext(in)
		if !strings.HasPrefix(got, "/") || strings.HasPrefix(got, "//") {
			t.Fatalf("sanitizeNext(%q) = %q：结果不是同源相对路径", in, got)
		}
		if strings.ContainsAny(got, "\\:#") || strings.Contains(got, "//") {
			t.Fatalf("sanitizeNext(%q) = %q：结果含危险字符", in, got)
		}
	}
}

// TestSanitizeAppID 覆盖**外部传入** app_id 的严格形态闸（FIX-28 / §4.1 + §10.5 第 52/53 项）。
//
// 这里刻意**不再**做小写/去空白的宽容归一化：`REAL-APP` / ` My-App ` 这类形态
// 会被静默改写成另一个 app_id，而调用方随后用未归一化的原串做跳转与比对 ——
// 结果是死链或永远兑换不了的票（详见 sanitizeAppID 的注释）。
//
// 变异验证：把 sanitizeAppID 改回"小写 + TrimSpace + 去尾点"（旧实现）
// ⇒ 前两条与"大写/尾点/空白"用例必红。
func TestSanitizeAppID(t *testing.T) {
	cases := []struct{ in, want string }{
		{"my-app", "my-app"},
		{"my-app2", "my-app2"},
		// 非法形态一律空串（调用方按 404 处理）。
		{" My-App ", ""},
		{"MY-APP", ""},
		{"my-app.", ""}, // 尾点形态属于主机名装饰，不是 app_id
		{"my-app:8443", ""},
		{"my-app.evil.example.com", ""},
		{"my-app/../my-app", ""},
		{"my--app", ""},
		{"-my-app", ""},
		{"my_app", ""},
		{"my app", ""},
		{"my\tapp", ""},
		{"", ""},
		{"   ", ""},
		{strings.Repeat("a", 64), ""}, // 超过 DNS label 上限（limits.MaxAppIDLen=63）
		{strings.Repeat("a", 63), strings.Repeat("a", 63)},
	}
	for _, tc := range cases {
		if got := sanitizeAppID(tc.in); got != tc.want {
			t.Fatalf("sanitizeAppID(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestLookupAppID 覆盖**服务端解析出**的 app 标识（主机标签）路径：
// 形态由门控保证，这里只剥主机名杂质 + 过业务规则（保留字 / 部署期注入的企业主机名）。
func TestLookupAppID(t *testing.T) {
	m := New(Options{AppIDExtraReserved: []string{"intranet"}})
	cases := []struct {
		in   string
		want string
		ok   bool
	}{
		{"my-app", "my-app", true},
		{"MY-APP", "my-app", true},                  // 域名标签不区分大小写（门控已小写，这里是纵深）
		{"my-app.apps.example.com:8443", "", false}, // 真主机名（多级标签）不是 app_id
		{"my-app.", "my-app", true},                 // FQDN 尾部点
		{"admin", "", false},                        // 保留字（registry 唯一真源）
		{"intranet", "", false},                     // 部署期注入的企业既有主机名
		{"www", "", false},
		{"123", "", false}, // 纯数字（IP 形态）
		{"", "", false},
	}
	for _, tc := range cases {
		got, ok := m.lookupAppID(tc.in)
		if got != tc.want || ok != tc.ok {
			t.Errorf("lookupAppID(%q) = (%q,%v)，want (%q,%v)", tc.in, got, ok, tc.want, tc.ok)
		}
	}
}

// TestParseBaseDomain 覆盖基域解析（scheme 的有无决定 https/http，§4.7）。
func TestParseBaseDomain(t *testing.T) {
	cases := []struct {
		in         string
		wantScheme string
		wantHost   string
	}{
		{"", "", ""},
		{"apps.example.com", "https", "apps.example.com"},
		{"https://apps.example.com", "https", "apps.example.com"},
		{"https://apps.example.com/", "https", "apps.example.com"},
		{"HTTPS://Apps.Example.COM.", "https", "apps.example.com"},
		{"http://127.0.0.1:8080", "http", "127.0.0.1:8080"},
		{"ftp://apps.example.com", "https", "apps.example.com"}, // 非法 scheme 回落 https
	}
	for _, tc := range cases {
		s, h := ParseBaseDomain(tc.in)
		if s != tc.wantScheme || h != tc.wantHost {
			t.Fatalf("ParseBaseDomain(%q) = (%q,%q), want (%q,%q)", tc.in, s, h, tc.wantScheme, tc.wantHost)
		}
	}
}

// TestAppOrigin 断言基域配置决定回跳源的 scheme（明文部署只能显式写 http://）。
func TestAppOrigin(t *testing.T) {
	plain := New(Options{BaseDomain: func() string { return "apps.example.com" }})
	if got := plain.AppOrigin("my-app"); got != "https://my-app.apps.example.com" {
		t.Fatalf("AppOrigin = %q", got)
	}
	local := New(Options{BaseDomain: func() string { return "http://127.0.0.1:8080" }})
	if got := local.AppOrigin("my-app"); got != "http://my-app.127.0.0.1:8080" {
		t.Fatalf("明文部署 AppOrigin = %q", got)
	}
	off := New(Options{})
	if got := off.AppOrigin("my-app"); got != "" {
		t.Fatalf("未启用应用子域时 AppOrigin = %q, want 空", got)
	}
}

// TestCheckMainOrigin 覆盖 Origin/Referer 的同源校验（§4.7 防登录 CSRF）。
func TestCheckMainOrigin(t *testing.T) {
	m := New(Options{MainOrigin: testMainOrigin})

	cases := []struct {
		name    string
		origin  string
		referer string
		want    bool
	}{
		{"Origin 同源", testMainOrigin, "", true},
		{"Origin 同源带尾斜杠", testMainOrigin + "/", "", true},
		{"Origin 大小写不同（源不区分大小写）", "https://Harness.Example.COM", "", true},
		{"Origin 跨源", "https://evil.example.com", "", false},
		{"Origin 是 null（sandboxed iframe）", "null", "", false},
		{"Origin 是 http 降级", "http://harness.example.com", "", false},
		{"Origin 缺失但 Referer 同源", "", testMainOrigin + "/app-ticket?app=x", true},
		{"Origin 缺失且 Referer 跨源", "", "https://evil.example.com/x", false},
		{"Origin 与 Referer 都缺失", "", "", false},
		{"Origin 合法时忽略伪造 Referer", testMainOrigin, "https://evil.example.com/x", true},
		{"子域伪造 Referer 前缀", "", testMainOrigin + ".evil.example.com/x", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, testMainOrigin+"/app-ticket", nil)
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if tc.referer != "" {
				r.Header.Set("Referer", tc.referer)
			}
			if got := m.checkMainOrigin(r); got != tc.want {
				t.Fatalf("checkMainOrigin = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestMainOriginNormalizedAgainstRequest 是 FIX-26 在 session 侧的回归判据：
// MainOrigin 与请求自身源必须走**同一套**规范化（默认端口省略、非默认端口保留），
// 否则配置里多写一个 `:443` 就让断言恒不成立（永久 403），
// 而 `https://h:8443` 这种非默认端口部署又会被误判成跨源。
//
// 变异验证：把 mainOrigin/checkMainOrigin 改回"只小写 + 去尾斜杠"（旧实现）
// ⇒ 前两条（显式默认端口 / 非默认端口）必红。
func TestMainOriginNormalizedAgainstRequest(t *testing.T) {
	cases := []struct {
		name       string
		mainOrigin string
		host       string
		tls        bool
		origin     string
		want       bool
	}{
		{"配置带显式默认端口，请求不带", "https://harness.example.com:443",
			"harness.example.com", true, "https://harness.example.com", true},
		{"配置不带端口，请求带显式默认端口", "https://harness.example.com",
			"harness.example.com:443", true, "https://harness.example.com:443", true},
		{"非默认端口：配置与请求都带", "https://harness.example.com:8443",
			"harness.example.com:8443", true, "https://harness.example.com:8443", true},
		{"非默认端口：浏览器发的 Origin 带端口", "https://harness.example.com:8443",
			"harness.example.com:8443", true, "https://apps.example.com", false},
		{"端口不同 ⇒ 跨源", "https://harness.example.com:8443",
			"harness.example.com:8443", true, "https://harness.example.com:9443", false},
		{"配置带尾斜杠 + 大写", "  https://Harness.Example.COM/ ",
			"harness.example.com", true, "https://harness.example.com", true},
		{"Origin 带路径 ⇒ 不是合法的源", "https://harness.example.com",
			"harness.example.com", true, "https://harness.example.com/x", false},
		{"Origin: null ⇒ 拒", "https://harness.example.com",
			"harness.example.com", true, "null", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := New(Options{MainOrigin: tc.mainOrigin})
			r := httptest.NewRequest(http.MethodPost, "https://"+tc.host+"/app-ticket", nil)
			r.Host = tc.host
			if tc.tls {
				r.TLS = &tls.ConnectionState{}
			}
			r.Header.Set("Origin", tc.origin)
			if got := m.checkMainOrigin(r); got != tc.want {
				t.Fatalf("MainOrigin=%q host=%q Origin=%q ⇒ checkMainOrigin=%v，want %v",
					tc.mainOrigin, tc.host, tc.origin, got, tc.want)
			}
		})
	}
}

// TestCheckMainOriginAssertsCanonicalHost 断言 MainOrigin 配置同时是**断言**：
// 员工会话 Cookie 是 host-only，别名主机上换票拿不到 Cookie，
// 因此请求自身的源与配置不一致时必须拒（fail-closed）。
func TestCheckMainOriginAssertsCanonicalHost(t *testing.T) {
	m := New(Options{MainOrigin: testMainOrigin})
	r := httptest.NewRequest(http.MethodPost, "https://alias.example.com/app-ticket", nil)
	r.Header.Set("Origin", "https://alias.example.com")
	if m.checkMainOrigin(r) {
		t.Fatal("别名主机 + 自洽 Origin 也应被拒（MainOrigin 是权威主站源）")
	}
	// 未配置 MainOrigin 时按请求推导（保持既有部署行为）。
	derived := New(Options{})
	r2 := httptest.NewRequest(http.MethodPost, "https://alias.example.com/app-ticket", nil)
	r2.Header.Set("Origin", "https://alias.example.com")
	if !derived.checkMainOrigin(r2) {
		t.Fatal("未配置 MainOrigin 时应按请求推导主站源")
	}
}

// TestPreferredLocale 覆盖 Accept-Language 解析（语言按请求解析，不冻结）。
func TestPreferredLocale(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "zh"},
		{"zh-CN,zh;q=0.9,en;q=0.8", "zh"},
		{"en-US,en;q=0.9", "en"},
		{"en;q=0.8,zh;q=0.9", "zh"},       // q 值优先于出现顺序
		{"fr-FR,fr;q=0.9,en;q=0.5", "en"}, // 跳过不认识的语言
		{"fr,de;q=0.9", "zh"},             // 全不匹配 ⇒ 产品默认
		{"en;q=0", "zh"},                  // q=0 = 不接受
		{"zh-Hant-TW", "zh"},
		{"EN-gb", "en"},
		{"*", "zh"},
	}
	for _, tc := range cases {
		if got := preferredLocale(tc.in); got != tc.want {
			t.Fatalf("preferredLocale(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// TestSecureRequestFollowsEdgeScheme 断言 https 判定与 edge 同一套口径
// （TLS → X-Forwarded-Proto → http），fail-closed 的前提。
func TestSecureRequestFollowsEdgeScheme(t *testing.T) {
	m := New(Options{})
	tlsReq := httptest.NewRequest(http.MethodGet, "https://harness.example.com/login", nil)
	if !m.secureRequest(tlsReq) {
		t.Fatal("https 请求应判定为安全")
	}
	plain := httptest.NewRequest(http.MethodGet, "http://harness.example.com/login", nil)
	if m.secureRequest(plain) {
		t.Fatal("http 请求必须判定为不安全（fail-closed）")
	}
	proxied := httptest.NewRequest(http.MethodGet, "http://harness.example.com/login", nil)
	proxied.Header.Set("X-Forwarded-Proto", "https")
	if !m.secureRequest(proxied) {
		t.Fatal("反代终止 TLS（X-Forwarded-Proto: https）应判定为安全")
	}
	downgrade := httptest.NewRequest(http.MethodGet, "http://harness.example.com/login", nil)
	downgrade.Header.Set("X-Forwarded-Proto", "http, https")
	if m.secureRequest(downgrade) {
		t.Fatal("链里第一个协议是 http 时必须判不安全（取第一个值）")
	}
}
