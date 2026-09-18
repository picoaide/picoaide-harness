package edge

import (
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 变异验证（§5.5「变异验证」）：
//   - MatchHost 去掉"多级标签 ⇒ HostUnknown"分支 ⇒ TestMatchHostRejectsNestedLabel 必红；
//   - HostGate 的 HostUnknown 分支改为回落主站 ⇒ TestGateNeverFallsBackToMain 必红；
//   - CheckOrigin 在 Origin 存在时改为跳过校验 ⇒ TestCheckOriginRejectsCrossOrigin 必红；
//   - StripAppControlledHeaders 去掉白名单过滤 ⇒ TestStripAppHeaders 必红。

const testBase = "apps.example.com"

// ===== 主机名判别（§4.8 / §10.1 13a–13d）=====

func TestMatchHost(t *testing.T) {
	cases := []struct {
		host    string
		wantLab string
		want    HostKind
		why     string
	}{
		{"apps.example.com", "", HostMain, "基域本身是主站"},
		{"APPS.Example.COM:8443", "", HostMain, "大小写与端口归一"},
		{"apps.example.com.", "", HostMain, "尾部点归一（FQDN 写法）"},
		{"expense-note.apps.example.com", "expense-note", HostApp, "一级标签即 app_id"},
		{"EXPENSE-NOTE.apps.example.com", "expense-note", HostApp, "域名不区分大小写"},
		{"expense-note.apps.example.com:443", "expense-note", HostApp, "带端口"},
		{"a.b.apps.example.com", "", HostUnknown, "通配证书只覆盖一级标签（R29）⇒ 不进应用也不回落主站"},
		{"-bad.apps.example.com", "", HostUnknown, "非法 label 形态"},
		{"bad-.apps.example.com", "", HostUnknown, "非法 label 形态"},
		{"bad_underscore.apps.example.com", "", HostUnknown, "下划线不是合法 app_id 字符"},
		{"other.example.com", "", HostMain, "不是本基域 ⇒ 主站（IP 直连/其它域名反代）"},
		{"example.com", "", HostMain, "上层域名不是应用子域"},
		{"", "", HostMain, "空 Host（HTTP/1.0 探测）"},
	}
	for _, c := range cases {
		gotLab, gotKind := MatchHost(c.host, testBase)
		if gotKind != c.want || gotLab != c.wantLab {
			t.Errorf("MatchHost(%q) = (%q,%d)，want (%q,%d)：%s", c.host, gotLab, gotKind, c.wantLab, c.want, c.why)
		}
	}
}

// TestMatchHostDisabled：未配置基域时全部当主站（既有部署行为不变）。
func TestMatchHostDisabled(t *testing.T) {
	for _, h := range []string{"", "a.b", "expense-note.apps.example.com"} {
		if lab, kind := MatchHost(h, ""); kind != HostMain || lab != "" {
			t.Errorf("未启用子域时 MatchHost(%q)=(%q,%d)，want 主站", h, lab, kind)
		}
	}
}

// TestMatchHostRejectsNestedLabel：`a.b.<基域>` 既拿不到通配证书，也是绕过保留字的常见手法。
func TestMatchHostRejectsNestedLabel(t *testing.T) {
	for _, h := range []string{"x.www.apps.example.com", "a.admin.apps.example.com"} {
		if _, kind := MatchHost(h, testBase); kind != HostUnknown {
			t.Errorf("MatchHost(%q) kind=%d，want HostUnknown", h, kind)
		}
	}
}

func TestMatchHostMaxLabelLen(t *testing.T) {
	long := strings.Repeat("a", limits.MaxAppIDLen)
	if _, kind := MatchHost(long+"."+testBase, testBase); kind != HostApp {
		t.Fatalf("%d 字符标签应合法", limits.MaxAppIDLen)
	}
	tooLong := strings.Repeat("a", limits.MaxAppIDLen+1)
	if _, kind := MatchHost(tooLong+"."+testBase, testBase); kind != HostUnknown {
		t.Fatal("超过 DNS label 上限必须拒")
	}
}

// ===== 门控：绝不放行主站路由 =====

type recordingHandler struct {
	hits   int
	labels []string
}

func (h *recordingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.hits++
	w.WriteHeader(200)
	_, _ = w.Write([]byte("MAIN"))
}

func (h *recordingHandler) ServeApp(w http.ResponseWriter, r *http.Request, label string) {
	h.labels = append(h.labels, label)
	if label == "missing" {
		WriteAppNotFound(w, r, label)
		return
	}
	ApplyHostSecurityHeaders(w.Header(), SelfOrigin(r))
	w.WriteHeader(200)
	_, _ = w.Write([]byte("APP"))
}

// TestGateExtraMainHostsRoutesUnknownHostsToMain 是 FIX-29 的回归判据（§4.8 host 门控）。
//
// 语义：ExtraMainHosts 只在 `HostUnknown` 分支生效（把"本来 404 的多级/畸形主机名"
// 显式当主站），**绝不**影响 `HostApp`（应用子域永不回流主站）。
//
// 变异验证：把 ServeHTTP 的 HostUnknown 分支改回"无条件 WriteAppNotFound"
// （或把 ExtraMainHosts 判定挪回 default 分支）⇒ "显式列入的多级主机名" 用例必红。
func TestGateExtraMainHostsRoutesUnknownHostsToMain(t *testing.T) {
	const extra = "a.b." + testBase

	newGate := func() (*HostGate, *recordingHandler, *recordingHandler) {
		main := &recordingHandler{}
		apps := &recordingHandler{}
		return &HostGate{
			BaseDomain:     func() string { return testBase },
			Main:           main,
			Apps:           apps,
			ExtraMainHosts: []string{extra, "PORTAL.Example.COM:8443."},
		}, main, apps
	}

	serve := func(g *HostGate, host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://"+host+"/", nil)
		req.Host = host
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		return w
	}

	t.Run("显式列入的多级主机名走主站", func(t *testing.T) {
		g, main, apps := newGate()
		w := serve(g, extra)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "MAIN") {
			t.Fatalf("ExtraMainHosts 里的主机名必须走主站，得到 %d body=%q", w.Code, w.Body.String())
		}
		if main.hits != 1 || len(apps.labels) != 0 {
			t.Fatalf("主站命中 %d、应用标签 %v（want 1 / 空）", main.hits, apps.labels)
		}
	})

	t.Run("大小写与端口归一后同样命中", func(t *testing.T) {
		g, _, apps := newGate()
		w := serve(g, "portal.example.com:8443")
		if !strings.Contains(w.Body.String(), "MAIN") {
			t.Fatalf("ExtraMainHosts 判定必须与 MatchHost 同一套归一（大小写/端口/尾部点），得到 %q", w.Body.String())
		}
		if len(apps.labels) != 0 {
			t.Fatalf("不该进应用分支：%v", apps.labels)
		}
	})

	t.Run("应用子域即使用户把它列进表也不回流主站", func(t *testing.T) {
		g, main, apps := newGate()
		// app_id 恰好等于 extra 的第一级标签：它走 HostApp（合法一级标签），不受影响。
		w := serve(g, "a."+testBase)
		if w.Code != 200 || !strings.Contains(w.Body.String(), "APP") {
			t.Fatalf("应用子域必须走应用分支，得到 %d body=%q", w.Code, w.Body.String())
		}
		if main.hits != 0 {
			t.Fatal("§4.8 硬规则：应用子域绝不回流主站")
		}
		if len(apps.labels) != 1 || apps.labels[0] != "a" {
			t.Fatalf("应用标签=%v，want [a]", apps.labels)
		}
	})

	t.Run("未列入的多级子域仍 404", func(t *testing.T) {
		g, main, apps := newGate()
		w := serve(g, "x.y."+testBase)
		if w.Code != http.StatusNotFound {
			t.Fatalf("未列入 ExtraMainHosts 的多级主机名必须 404，得到 %d", w.Code)
		}
		if main.hits != 0 || len(apps.labels) != 0 {
			t.Fatal("既不能回落主站，也不能进应用分支")
		}
	})

	t.Run("表为空时逐字节保持原语义", func(t *testing.T) {
		g, main, apps := newGate()
		g.ExtraMainHosts = nil
		if w := serve(g, extra); w.Code != http.StatusNotFound {
			t.Fatalf("ExtraMainHosts 为空时多级主机名必须 404，得到 %d", w.Code)
		}
		if main.hits != 0 || len(apps.labels) != 0 {
			t.Fatal("默认行为不得变化")
		}
	})
}

// TestGateNeverFallsBackToMain 是 §4.8 的核心判据：
// 未知/畸形应用主机名一律 404，**绝不**回落主站（否则每个子域都是主站镜像）。
func TestGateNeverFallsBackToMain(t *testing.T) {
	main := &recordingHandler{}
	apps := &recordingHandler{}
	g := &HostGate{BaseDomain: func() string { return testBase }, Main: main, Apps: apps}

	cases := []struct {
		host     string
		wantCode int
		wantBody string
	}{
		{"expense-note." + testBase, 200, "APP"},
		{"missing." + testBase, 404, ""},
		{"a.b." + testBase, 404, ""},       // 多级标签
		{"bad_label." + testBase, 404, ""}, // 非法形态
		{testBase, 200, "MAIN"},            // 主站
		{"other.example.com", 200, "MAIN"}, // 非本基域
	}
	for _, c := range cases {
		req := httptest.NewRequest("GET", "http://"+c.host+"/", nil)
		req.Host = c.host
		w := httptest.NewRecorder()
		g.ServeHTTP(w, req)
		if w.Code != c.wantCode {
			t.Errorf("host=%q code=%d want %d", c.host, w.Code, c.wantCode)
		}
		if c.wantBody != "" && !strings.Contains(w.Body.String(), c.wantBody) {
			t.Errorf("host=%q body=%q want 含 %q", c.host, w.Body.String(), c.wantBody)
		}
	}
	if main.hits != 2 {
		t.Fatalf("主站被命中 %d 次，want 2（只有基域本身与非本基域域名）", main.hits)
	}
}

// TestGate404WritesSecurityHeaders：§4.8「含 4xx/5xx」。
func TestGate404WritesSecurityHeaders(t *testing.T) {
	g := &HostGate{BaseDomain: func() string { return testBase }, Main: &recordingHandler{}, Apps: &recordingHandler{}}
	req := httptest.NewRequest("GET", "http://missing."+testBase+"/", nil)
	req.Host = "missing." + testBase
	w := httptest.NewRecorder()
	g.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("code=%d", w.Code)
	}
	if got := w.Header().Get("Content-Security-Policy"); !strings.Contains(got, "default-src 'none'") {
		t.Fatalf("404 也必须写 CSP，got %q", got)
	}
	if w.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("404 也必须写 nosniff")
	}
}

// TestGate404APIUsesJSONEnvelope：API 路径要 JSON 信封（服务端 §7.0 契约）。
func TestGate404APIUsesJSONEnvelope(t *testing.T) {
	g := &HostGate{BaseDomain: func() string { return testBase }, Main: &recordingHandler{}, Apps: &recordingHandler{}}
	req := httptest.NewRequest("GET", "http://missing."+testBase+"/api/x", nil)
	req.Host = "missing." + testBase
	w := httptest.NewRecorder()
	g.ServeHTTP(w, req)
	var env map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("API 404 必须是 JSON 信封，body=%q err=%v", w.Body.String(), err)
	}
	if _, ok := env["error"]; !ok {
		t.Fatalf("缺少 error 字段：%v", env)
	}
}

// TestGateWithoutAppsHandler：Apps 未装配时也不能回落主站。
func TestGateWithoutAppsHandler(t *testing.T) {
	main := &recordingHandler{}
	g := &HostGate{BaseDomain: func() string { return testBase }, Main: main}
	req := httptest.NewRequest("GET", "http://expense-note."+testBase+"/", nil)
	req.Host = "expense-note." + testBase
	w := httptest.NewRecorder()
	g.ServeHTTP(w, req)
	if w.Code != 404 {
		t.Fatalf("code=%d want 404", w.Code)
	}
	if main.hits != 0 {
		t.Fatal("应用子域绝不能命中主站处理器")
	}
}

// ===== Origin 校验（§4.8 / §10.4 第 44 项）=====

func TestCheckOriginRejectsCrossOrigin(t *testing.T) {
	// a.<base> 上的页面 POST 到 b.<base>：同站不同源，SameSite=Strict 挡不住。
	req := httptest.NewRequest("POST", "https://b."+testBase+"/api/save", nil)
	req.Host = "b." + testBase
	req.TLS = &tls.ConnectionState{}
	req.Header.Set("Origin", "https://a."+testBase)
	if CheckOrigin(req) {
		t.Fatal("跨源写必须被拒（§10.4 第 44 项）")
	}
	// 同源写放行。
	req.Header.Set("Origin", "https://b."+testBase)
	if !CheckOrigin(req) {
		t.Fatal("同源写必须放行")
	}
	// Origin: null（sandboxed iframe）必须拒。
	req.Header.Set("Origin", "null")
	if CheckOrigin(req) {
		t.Fatal("Origin: null 必须拒")
	}
}

func TestCheckOriginRefererFallback(t *testing.T) {
	req := httptest.NewRequest("POST", "https://b."+testBase+"/api/save", nil)
	req.Host = "b." + testBase
	req.TLS = &tls.ConnectionState{}
	// 老浏览器不发 Origin：用 Referer 前缀判定。
	req.Header.Set("Referer", "https://b."+testBase+"/page")
	if !CheckOrigin(req) {
		t.Fatal("Referer 同源前缀应放行")
	}
	req.Header.Set("Referer", "https://evil.example.net/page")
	if CheckOrigin(req) {
		t.Fatal("Referer 跨源必须拒")
	}
	// 前缀相似但不同源（b.apps.example.com.evil.net）必须拒。
	req.Header.Set("Referer", "https://b."+testBase+".evil.net/x")
	if CheckOrigin(req) {
		t.Fatal("前缀相似域名必须拒")
	}
	// 两者都缺 ⇒ 拒（宁可拒一次合法请求，也不放过一次跨源写）。
	req.Header.Del("Referer")
	if CheckOrigin(req) {
		t.Fatal("无 Origin 且无 Referer 必须拒")
	}
}

func TestIsIdempotent(t *testing.T) {
	for _, m := range []string{"GET", "HEAD", "OPTIONS"} {
		if !IsIdempotent(m) {
			t.Errorf("%s 应幂等", m)
		}
	}
	for _, m := range []string{"POST", "PUT", "PATCH", "DELETE"} {
		if IsIdempotent(m) {
			t.Errorf("%s 不应幂等（需要 Origin 校验）", m)
		}
	}
}

// ===== 响应头 =====

func TestSelfOrigin(t *testing.T) {
	req := httptest.NewRequest("GET", "http://x/", nil)
	req.Host = "b." + testBase
	if got := SelfOrigin(req); got != "http://b."+testBase {
		t.Fatalf("SelfOrigin=%q", got)
	}
	req.Header.Set("X-Forwarded-Proto", "https, http")
	if got := SelfOrigin(req); got != "https://b."+testBase {
		t.Fatalf("反代终止 TLS 时 SelfOrigin=%q want https", got)
	}
	req.TLS = &tls.ConnectionState{}
	req.Header.Set("X-Forwarded-Proto", "http")
	if got := SelfOrigin(req); got != "https://b."+testBase {
		t.Fatalf("TLS 存在时以 TLS 为准，got %q", got)
	}
}

// TestSelfOriginMatchesBrowserOrigin 是 FIX-26 的回归判据（§15.1 第 3 条 /
// §10.4 第 44 项）：SelfOrigin 必须与**浏览器实际会发的那个 Origin 字符串**
// 逐字符相等 —— 默认端口省略、非默认端口保留。
//
// 变异验证：把 originHostPort 的端口分支改回"一律剥端口"（旧实现）
// ⇒ 8443/8080 两个用例必红；改成"一律保留端口"⇒ 443/80 两个用例必红。
func TestSelfOriginMatchesBrowserOrigin(t *testing.T) {
	cases := []struct {
		name   string
		host   string
		tls    bool
		xfp    string
		want   string
		reason string
	}{
		{"https 默认端口省略", "apps.example.com", true, "", "https://apps.example.com",
			"浏览器在 Origin 里省略 :443 ⇒ 自身源也必须省略"},
		{"http 默认端口省略", "apps.example.com", false, "", "http://apps.example.com",
			"浏览器在 Origin 里省略 :80"},
		{"https 非默认端口保留", "apps.example.com:8443", true, "", "https://apps.example.com:8443",
			"旧实现在这里剥掉端口 ⇒ 同源请求被判跨源（403）"},
		{"http 非默认端口保留", "apps.example.com:8080", false, "", "http://apps.example.com:8080",
			"端口是 origin 三元组的一部分"},
		{"IPv6 非默认端口", "[::1]:8443", true, "", "https://[::1]:8443",
			"IPv6 字面量必须带方括号"},
		{"IPv6 默认端口省略", "[::1]:443", true, "", "https://[::1]",
			"默认端口在 Origin 里省略，IPv6 同样"},
		{"IPv6 无端口", "[::1]", true, "", "https://[::1]", ""},
		{"无端口", "apps.example.com", true, "", "https://apps.example.com", ""},
		{"反代终止 TLS + 非默认端口", "apps.example.com:8443", false, "https", "https://apps.example.com:8443",
			"X-Forwarded-Proto 决定 scheme，Host 的端口照旧保留"},
		{"显式默认端口等价省略", "apps.example.com:443", true, "", "https://apps.example.com",
			"`h:443` 与 `h` 是同一个源（浏览器只会发后者）"},
		{"大写与尾部点归一", "APPS.Example.COM:8443.", true, "", "https://apps.example.com:8443",
			"域名不区分大小写；FQDN 尾部点不属于源"},
		{"裸 IPv6 无端口", "::1", true, "", "https://[::1]",
			"Host 里的 IPv6 一定带方括号；裸形态按原样收进方括号"},
		{"反代降级为明文 + 非默认端口", "apps.example.com:8080", false, "http", "http://apps.example.com:8080",
			"X-Forwarded-Proto: http 时不能保留 https 的 scheme"},
		{"无 Host", "", true, "", "", "拿不到 host 就没有源（调用方按拒处理）"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "http://placeholder/", nil)
			req.Host = c.host
			if c.tls {
				req.TLS = &tls.ConnectionState{}
			}
			if c.xfp != "" {
				req.Header.Set("X-Forwarded-Proto", c.xfp)
			}
			got := SelfOrigin(req)
			if got != c.want {
				t.Fatalf("Host=%q tls=%v xfp=%q ⇒ SelfOrigin=%q，want %q（%s）",
					c.host, c.tls, c.xfp, got, c.want, c.reason)
			}
			// 反向判据：把 SelfOrigin 当作浏览器会发的 Origin 回灌，必须判定为同源。
			if got != "" && !CheckOrigin(withOriginHeader(req, got)) {
				t.Fatalf("SelfOrigin=%q 回灌为 Origin 时必须判定同源（否则非默认端口部署全 403）", got)
			}
		})
	}
}

// TestCheckOriginPortIsPartOfOrigin：端口必须参与比较（FIX-26 的安全语义那一半）。
//
// 变异验证：CheckOrigin 改为忽略端口 ⇒ "其它端口" 用例必红。
func TestCheckOriginPortIsPartOfOrigin(t *testing.T) {
	req := httptest.NewRequest("POST", "https://apps.example.com:8443/api/save", nil)
	req.Host = "apps.example.com:8443"
	req.TLS = &tls.ConnectionState{}

	if !CheckOrigin(withOriginHeader(req, "https://apps.example.com:8443")) {
		t.Fatal("同源（含端口）的 Origin 必须放行 —— 否则非 443 部署下所有非幂等请求 403")
	}
	if CheckOrigin(withOriginHeader(req, "https://apps.example.com:9443")) {
		t.Fatal("其它端口不是自身源：同主机的任意端口都被放行会让攻击者可影响的端口获得同源写权限")
	}
	if CheckOrigin(withOriginHeader(req, "https://apps.example.com")) {
		t.Fatal("默认端口与 8443 不是同一个源（浏览器也不会这样发）")
	}
	if CheckOrigin(withOriginHeader(req, "http://apps.example.com:8443")) {
		t.Fatal("scheme 降级不是同一个源")
	}
	// Origin 必须是**源**：带路径/query/userinfo 的值不是合法 Origin（合法实现不会发），
	// 一律拒 —— 不能"截到源再比"（否则 `https://a.<基域>/x` 会被当成 `https://a.<基域>`）。
	for _, bad := range []string{
		"https://apps.example.com:8443/x",
		"https://apps.example.com:8443?x=1",
		"https://apps.example.com:8443#f",
		"https://user@apps.example.com:8443",
		"null",
		"apps.example.com:8443",
		"",
	} {
		if bad == "" {
			continue
		}
		if CheckOrigin(withOriginHeader(req, bad)) {
			t.Fatalf("Origin=%q 不是合法的源形态，必须拒（否则伪造型可绕过跨源写防护）", bad)
		}
	}
	// 反向对照：带尾斜杠的源形态（`https://h/`）仍算同源。
	if !CheckOrigin(withOriginHeader(req, "https://apps.example.com:8443/")) {
		t.Fatal("尾部斜杠是源的常见写法，应判同源")
	}
	// 反向对照：默认端口部署下 `h` 与 `h:443` 都算同源。
	req2 := httptest.NewRequest("POST", "https://apps.example.com/api/save", nil)
	req2.Host = "apps.example.com"
	req2.TLS = &tls.ConnectionState{}
	for _, origin := range []string{"https://apps.example.com", "https://apps.example.com:443"} {
		if !CheckOrigin(withOriginHeader(req2, origin)) {
			t.Fatalf("默认端口部署下 Origin=%q 应判同源", origin)
		}
	}
}

// TestNormalizeOrigin：MainOrigin 与请求侧必须走同一套规范化（否则配置里多写一个
// `:443` 就让断言恒不成立 = 永久 403）。
func TestNormalizeOrigin(t *testing.T) {
	cases := map[string]string{
		"https://harness.example.com":      "https://harness.example.com",
		"https://harness.example.com:443":  "https://harness.example.com",
		"https://harness.example.com:8443": "https://harness.example.com:8443",
		"  HTTPS://Harness.Example.COM/  ": "https://harness.example.com",
		"http://harness.example.com:80":    "http://harness.example.com",
		"http://harness.example.com:8080":  "http://harness.example.com:8080",
		"https://harness.example.com/base": "https://harness.example.com",
		"https://[::1]:8443":               "https://[::1]:8443",
		"":                                 "",
		"harness.example.com":              "",
		"ftp://harness.example.com":        "",
	}
	for raw, want := range cases {
		if got := NormalizeOrigin(raw); got != want {
			t.Errorf("NormalizeOrigin(%q)=%q，want %q", raw, got, want)
		}
	}
}

// withOriginHeader 复制请求并设置 Origin 头（不改原请求）。
func withOriginHeader(r *http.Request, origin string) *http.Request {
	clone := r.Clone(r.Context())
	clone.Header.Set("Origin", origin)
	return clone
}

// TestStripAppHeaders：宿主独占头 + 白名单 + CRLF + content-type 集合。
func TestStripAppHeaders(t *testing.T) {
	in := http.Header{}
	in.Set("Content-Type", "text/html; charset=utf-8")
	in.Set("Cache-Control", "no-cache")
	in.Set("Content-Disposition", "inline")
	in.Set("Set-Cookie", "evil=1")                     // Cookie 由宿主独占 ⇒ 丢
	in.Set("Content-Security-Policy", "default-src *") // 宿主独占 ⇒ 丢
	in.Set("X-Frame-Options", "ALLOWALL")              // 宿主独占 ⇒ 丢
	in.Set("X-Powered-By", "x")                        // 不在白名单 ⇒ 丢
	in.Set("X-Injected", "a\r\nEvil: 1")               // CRLF ⇒ 丢该头
	out := StripAppControlledHeaders(in)
	if out.Get("Set-Cookie") != "" || out.Get("Content-Security-Policy") != "" ||
		out.Get("X-Frame-Options") != "" || out.Get("X-Powered-By") != "" || out.Get("X-Injected") != "" {
		t.Fatalf("宿主独占/白名单外/CRLF 头未被剥离：%v", out)
	}
	if out.Get("Content-Type") == "" || out.Get("Cache-Control") == "" || out.Get("Content-Disposition") == "" {
		t.Fatalf("白名单内的头被误删：%v", out)
	}

	bad := http.Header{}
	bad.Set("Content-Type", "application/x-evil")
	if got := StripAppControlledHeaders(bad).Get("Content-Type"); got != "" {
		t.Fatalf("content-type 必须在限定集合内，got %q", got)
	}
	attach := http.Header{}
	attach.Set("Content-Disposition", "attachment; filename=x")
	if got := StripAppControlledHeaders(attach).Get("Content-Disposition"); got != "" {
		t.Fatalf("content-disposition 仅允许 inline，got %q", got)
	}
}

func TestMaxBodyBytesFromLimits(t *testing.T) {
	if MaxBodyBytes() != limits.AppRequestBodyMaxBytes || MaxBodyBytes() != 1<<20 {
		t.Fatalf("应用 API 请求体上限=%d want 1 MiB（§4.6）", MaxBodyBytes())
	}
}

func TestSecurityHeadersIncludeFrameAncestors(t *testing.T) {
	h := http.Header{}
	ApplyHostSecurityHeaders(h, "https://a."+testBase)
	if !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("必须禁止被嵌帧（§4.8）")
	}
	if !strings.Contains(h.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal("CSP 必须 default-src 'none'（§4.8）")
	}
	if h.Get("Referrer-Policy") != "no-referrer" {
		t.Fatal("必须 no-referrer（§4.8）")
	}
}

// TestGatePicksUpBaseDomainChangeWithoutRestart 是「管理端配置泛域名」的核心判据
// （2026-09-18 用户要求：应用名 + 泛域名 = 应用访问地址）。
//
// 门控**常挂**、基域由取值函数提供 ⇒ 控制台保存后**同一进程内立即生效**：
//   - 基域为空时：一切主机名都当主站（等价于没挂门控，既有部署行为不变）；
//   - 基域变成 `apps.example.com` 后：`<应用名>.apps.example.com` 立刻进应用分支。
//
// 变异判据：把 BaseDomain 换回启动期字符串快照（或按 enabled 决定装不装门控），
// 本用例必红 —— 那正是"控制台改完要重启才生效"的形态。
func TestGatePicksUpBaseDomainChangeWithoutRestart(t *testing.T) {
	main := &recordingHandler{}
	apps := &recordingHandler{}
	current := ""
	g := &HostGate{BaseDomain: func() string { return current }, Main: main, Apps: apps}

	serve := func(host string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", "http://"+host+"/", nil)
		rec := httptest.NewRecorder()
		g.ServeHTTP(rec, req)
		return rec
	}

	// ① 未配置基域：应用子域形态的主机名也走主站（与"没挂门控"逐字节等价）。
	if rec := serve("expense-note.apps.example.com"); rec.Body.String() != "MAIN" {
		t.Fatalf("未配置基域时应走主站，得到 %q", rec.Body.String())
	}
	if rec := serve("harness.example.com"); rec.Body.String() != "MAIN" {
		t.Fatalf("主站主机名应走主站，得到 %q", rec.Body.String())
	}

	// ② 控制台保存基域（同一个 gate 实例，不重建、不重启）。
	current = "apps.example.com"

	if rec := serve("expense-note.apps.example.com"); rec.Code != 200 || rec.Body.String() != "APP" {
		t.Fatalf("配置基域后应用子域必须立刻进应用分支，得到 %d %q", rec.Code, rec.Body.String())
	}
	if rec := serve("harness.example.com"); rec.Body.String() != "MAIN" {
		t.Fatalf("非本基域的主机名仍走主站，得到 %q", rec.Body.String())
	}
	if rec := serve("a.b.apps.example.com"); rec.Code != 404 {
		t.Fatalf("多级标签仍必须 404（通配证书只覆盖一级），得到 %d", rec.Code)
	}

	// ③ 再清空：立刻回到"全部走主站"。
	current = ""
	if rec := serve("expense-note.apps.example.com"); rec.Body.String() != "MAIN" {
		t.Fatalf("清空基域后应立刻回到主站，得到 %q", rec.Body.String())
	}
}
