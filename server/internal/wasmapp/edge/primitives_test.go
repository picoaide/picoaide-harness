package edge

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 `edge` 包在 W4 之后**保留下来的原语**的行为判据。
//
// ⚠️ 原 `hostgate_test.go`（844 行）里两类用例混在一起：主机名门控（`HostGate`/
// `MatchHost`/`HostKind`/`IsProbePath`/`SelfOrigin`/`CheckOrigin`）随 W4 删除，
// 而**原语**类用例必须留下（总纲 §8.4 的保留列）—— 因此那个文件整体删除、
// 保留下来的用例搬到这里（禁止 `rm hostgate_test.go` 了事的反向检查见
// temp/wasm-client-only/audit-checklists/L7.md 的边界表）。
//
// 变异验证（§5.5）：
//   - `WriteAppNotFound` 不写安全头 ⇒ TestWriteAppNotFoundWritesSecurityHeaders 必红；
//   - `IsOriginShaped` 改为"剥掉多余部分再比"（接受路径/query/userinfo）⇒
//     TestIsOriginShaped 必红；
//   - `StripAppControlledHeaders` 去掉白名单过滤 ⇒ TestStripAppHeaders 必红；
//   - `HostReferrerPolicy` 改回 no-referrer ⇒ TestSecurityHeadersIncludeFrameAncestors 必红；
//   - `MaxBodyBytes` 改成硬编码 ⇒ TestMaxBodyBytesFromLimits 必红；
//   - `OriginDiagFields` 带上 Cookie ⇒ TestOriginDiagFieldsExcludesCredentials 必红。

const testBase = "apps.example.com"

// TestWriteAppNotFoundWritesSecurityHeaders：§4.8「含 4xx/5xx」。
func TestWriteAppNotFoundWritesSecurityHeaders(t *testing.T) {
	req := httptest.NewRequest("GET", "http://missing."+testBase+"/", nil)
	req.Host = "missing." + testBase
	w := httptest.NewRecorder()
	WriteAppNotFound(w, req, "missing", "picoaide-app://missing")
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

// TestWriteAppNotFoundAPIUsesJSONEnvelope：API 路径要 JSON 信封（服务端 §7.0 契约）。
func TestWriteAppNotFoundAPIUsesJSONEnvelope(t *testing.T) {
	req := httptest.NewRequest("GET", "http://missing."+testBase+"/api/x", nil)
	req.Host = "missing." + testBase
	w := httptest.NewRecorder()
	WriteAppNotFound(w, req, "missing", "picoaide-app://missing")
	var env map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &env); err != nil {
		t.Fatalf("API 404 必须是 JSON 信封，body=%q err=%v", w.Body.String(), err)
	}
	if _, ok := env["error"]; !ok {
		t.Fatalf("缺少 error 字段：%v", env)
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

// TestIsOriginShaped：客户端管线的跨源写判据第一道闸（总纲 §8.1 步骤 ⑦）。
//
// 形态判定**不能**靠"剥掉多余部分再比"：那会把 `picoaide-app://demo/x`、
// `picoaide-app://demo?x=1`、`user@demo` 这类伪造型当成合法源放行。
func TestIsOriginShaped(t *testing.T) {
	for _, ok := range []string{
		"picoaide-app://demo-a",
		"picoaide-app://demo-a/",
		"https://apps.example.com",
		"https://apps.example.com:8443",
		"https://[::1]:8443",
	} {
		if !IsOriginShaped(ok) {
			t.Fatalf("IsOriginShaped(%q) = false，want true（合法源形态）", ok)
		}
	}
	for _, bad := range []string{
		"",
		"null",
		"demo-a",
		"picoaide-app://",
		"picoaide-app://demo-a/x",
		"picoaide-app://demo-a?x=1",
		"picoaide-app://demo-a#f",
		"picoaide-app://user@demo-a",
		"https://apps.example.com/x",
	} {
		if IsOriginShaped(bad) {
			t.Fatalf("IsOriginShaped(%q) = true，必须拒（含路径/query/userinfo 或不是源）", bad)
		}
	}
}

// TestNormalizeOrigin：配置值与请求侧必须走同一套规范化（否则配置里多写一个
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
		// 自定义协议**不**走它（客户端应用的源由 appserver.normalizeCustomOrigin 归一）：
		// 走进来只会得到空串，这正是"两种源各有且只有一处实现"的分界。
		"picoaide-app://demo-a": "",
	}
	for raw, want := range cases {
		if got := NormalizeOrigin(raw); got != want {
			t.Errorf("NormalizeOrigin(%q)=%q，want %q", raw, got, want)
		}
	}
}

// TestOriginDiagFieldsExcludesCredentials：诊断字段是"应用写请求全 403"的唯一现场，
// 但它**绝不能**带 Cookie（会话明文进日志等于凭证泄漏）。
func TestOriginDiagFieldsExcludesCredentials(t *testing.T) {
	req := httptest.NewRequest("POST", "https://b."+testBase+"/note", nil)
	req.Host = "b." + testBase
	req.Header.Set("Origin", "picoaide-app://b")
	req.Header.Set("Referer", "https://b."+testBase+"/")
	req.Header.Set("X-Forwarded-Proto", "https")
	// 哨兵：应用会话明文绝不能被日志带出来。
	req.Header.Set("Cookie", "picoaide_app=secret-token-sentinel")
	got := OriginDiagFields(req)
	for _, want := range []string{
		`host="b.` + testBase + `"`,
		`origin="picoaide-app://b"`,
		`referer="https://b.` + testBase + `/"`,
		`x-forwarded-proto="https"`,
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("诊断字段缺少 %q：%s", want, got)
		}
	}
	if strings.Contains(got, "secret-token-sentinel") || strings.Contains(strings.ToLower(got), "cookie") {
		t.Fatalf("诊断字段带上了 Cookie/敏感值（凭证泄漏）：%s", got)
	}
	// nil 请求也要有稳定形态（调用方在极端分支上用它，不能 panic）。
	if OriginDiagFields(nil) == "" {
		t.Fatal("nil 请求应返回带空值的稳定形态")
	}
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
	ApplyHostSecurityHeaders(h, "picoaide-app://demo-a")
	if !strings.Contains(h.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatal("必须禁止被嵌帧（§4.8）")
	}
	if !strings.Contains(h.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatal("CSP 必须 default-src 'none'（§4.8）")
	}
	// Referrer-Policy 必须是 same-origin，**绝不能是 no-referrer**（2026-09-19 P0）：
	// 应用最常见的写路径是应用自己的同源表单 POST（如内置演示应用的留言墙
	// `<form method="post" action="/note">`），而 no-referrer 会让浏览器把它写成
	// `Origin: null`（WHATWG Fetch "append a request Origin header"），跨源写判据
	// 于是全拒 ⇒ 应用写在真实浏览器里 100% 不可用。
	// 变异验证：把 HostReferrerPolicy 改回 no-referrer ⇒ 本用例必红。
	if got := h.Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("Referrer-Policy = %q，必须 same-origin（no-referrer 会让同源写请求带 Origin: null）", got)
	}
	if HostReferrerPolicy == "no-referrer" {
		t.Fatal("HostReferrerPolicy 退回 no-referrer —— 应用内同源写请求会全部 403")
	}
}
