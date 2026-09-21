package edge

import (
	"fmt"
	"net"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 `edge` 包在 W4 之后**保留下来的全部原语**（总纲 §8.4 的精确保留列）：
//
//	IsOriginShaped / NormalizeOrigin / OriginDiagFields / IsIdempotent
//	AppVersionHeader / ApplyHostSecurityHeaders / StripAppControlledHeaders / MaxBodyBytes
//
// ⚠️ 原 `hostgate.go` 里与主机名有关的符号（`HostKind`/`MatchHost`/`SelfOrigin`/
// `CheckOrigin`/`normalizeHost`/`requestScheme`/`isValidAppLabel`）已随 W4 删除；
// 文件本身也被删除（零残留断言盯着 `edge/hostgate.go` 这个路径）。
// 保留下来的这些符号在客户端专属模型下**一条都没少用**：安全头、应用头剥离、
// 请求体上限、Origin 形态判定（管线步骤 ⑦ 复用 `IsOriginShaped`）、版本头、
// 来源校验失败的诊断字段（`OriginDiagFields`）。

// originHostPort 返回写进 `Origin` 的 host 部分：默认端口（http 80 / https 443）
// **省略**，其余端口保留。
//
// 这条规则来自浏览器本身：`Origin` 头里的默认端口是省略的（RFC 6454 允许规范化，
// 浏览器事实上就是这么发的）。所以"自身源"要能与浏览器实际发出的 `Origin`
// **逐字符相等**，就必须按同一规则拼；否则两种部署各错一半 ——
// 剥掉端口会让非 443 部署的同源请求全被判成跨源（403），
// 保留默认端口又会把 `https://h:443` 认成别的源。
func originHostPort(r *http.Request, scheme string) string {
	if r == nil {
		return ""
	}
	host, port := splitHostPort(r.Host)
	if host == "" {
		return ""
	}
	if port == "" || port == defaultPort(scheme) {
		if strings.ContainsRune(host, ':') {
			return "[" + host + "]"
		}
		return host
	}
	if strings.ContainsRune(host, ':') {
		return "[" + host + "]:" + port
	}
	return host + ":" + port
}

// IsOriginShaped 判定一个串是否是**源**的形态：`scheme://host[:port]`，
// 只允许一个可选的尾部斜杠，不接受路径/query/fragment/userinfo。
//
// 用途：`Origin` 请求头必须是源（RFC 6454）。判定不能靠"剥掉多余部分再比" ——
// 那会把 `https://a.example.com/x`、`https://a.example.com.evil.net` 这类伪造值
// 通过"截到源"的操作当成合法源放行。
//
// W4 之后它是客户端管线的跨源写判据（`appserver.checkClientOrigin`）的第一道闸：
// 自定义协议下的 `Origin` 是协议 handler 合成的，因此"形态是否合法"必须先判，
// 再判"是否等于 `<app scheme>://<app_id>`"。
func IsOriginShaped(s string) bool {
	i := strings.Index(s, "://")
	if i <= 0 {
		return false
	}
	host := s[i+3:]
	host = strings.TrimSuffix(host, "/") // 只容忍一个尾部斜杠
	if host == "" {
		return false
	}
	return !strings.ContainsAny(host, "/?#@")
}

// defaultPort 返回 scheme 的默认端口（http 80 / https 443），未知 scheme 返回空串。
func defaultPort(scheme string) string {
	switch scheme {
	case "http":
		return "80"
	case "https":
		return "443"
	}
	return ""
}

// splitHostPort 把 `Host` 头拆成 (主机名, 端口)。
//
// 端口原样返回（`":8443"` / `":443"`），没有端口时返回空串。主机名统一小写、
// 去尾部点、IPv6 字面量去方括号 —— 与浏览器写 `Origin` 时的规范化形态一致。
//
// 为什么不用裸 `net.SplitHostPort`：它对无端口的普通主机名（`apps.example.com`）
// 会报错，调用方就得自己分辨"没端口"与"畸形"。这里把两种形态都收口到一处：
// 不带方括号又没有端口的地址一律当作"整个串都是主机名"（IPv6 裸字面量在 `Host`
// 里本来就不合法，这里按原样处理即可，不做额外解释）。
func splitHostPort(h string) (host, port string) {
	h = strings.TrimSpace(h)
	if h == "" {
		return "", ""
	}
	if strings.HasPrefix(h, "[") {
		// `[::1]` / `[::1]:8443`
		if hp, p, err := net.SplitHostPort(h); err == nil && isPort(p) {
			return trimHostSuffix(strings.ToLower(hp)), p
		}
		inner := strings.TrimSuffix(strings.TrimPrefix(h, "["), "]")
		return trimHostSuffix(strings.ToLower(inner)), ""
	}
	if hp, p, err := net.SplitHostPort(h); err == nil && isPort(p) {
		return trimHostSuffix(strings.ToLower(hp)), p
	}
	if host, port, ok := splitTrailingPort(h); ok {
		return host, port
	}
	return trimHostSuffix(strings.ToLower(h)), ""
}

// isPort 判定 SplitHostPort 切出来的"端口"是不是真的端口。
//
// 为什么需要它：`a.example.com:8443.` 这种 FQDN 尾部点写在端口之后的写法会被
// `net.SplitHostPort` 切成 port="8443."（它不校验字符集）——若直接采信，尾部点就
// 混进 origin 字符串，与浏览器发的 `https://a.example.com:8443` 不相等。
func isPort(p string) bool {
	if p == "" {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return false
		}
	}
	return true
}

// trimHostSuffix 去掉主机名尾部点（`a.b.` 与 `a.b` 是同一个名字）。
func trimHostSuffix(h string) string { return strings.TrimSuffix(h, ".") }

// splitTrailingPort 兜住"端口后缀落在尾部点之后"的 FQDN 写法
// （`a.example.com:8443.`）：`net.SplitHostPort` 会把 port 切成 `8443.`，
// 上面因此不采信它 —— 这里显式剥掉尾部的 `.` 再按 `:port` 拆一次。
//
// 只在"最后一个冒号之后全是数字（可能带尾点）、且冒号之前不含冒号"时才动：
// 后半条把裸 IPv6 字面量（`::1`）排除在外，否则尾段 `1` 会被误当成端口。
func splitTrailingPort(h string) (host, port string, ok bool) {
	trimmed := strings.TrimSuffix(h, ".")
	i := strings.LastIndexByte(trimmed, ':')
	if i < 0 || strings.ContainsRune(trimmed[:i], ':') {
		return "", "", false
	}
	p := trimmed[i+1:]
	if !isPort(p) {
		return "", "", false
	}
	return trimHostSuffix(strings.ToLower(trimmed[:i])), p, true
}

// NormalizeOrigin 归一化一个**源**字符串，使其可与自身源逐字符比较：
// 小写、去尾部斜杠、默认端口省略、非默认端口保留。
//
// 允许输入带尾部斜杠（`https://h/`，配置里常见）；**带路径的输入会被截到源**
// （`https://h/base` ⇒ `https://h`）—— 它是给配置值（如控制台的对外地址）用的。
// 判定**请求头**里的 `Origin` 时必须先过 IsOriginShaped：那里不接受任何路径形态。
//
// ⚠️ 它只认 http/https（配置值都是这两种）。自定义协议（客户端应用的
// `<app scheme>://<app_id>`）**不要**走它 —— 会得空串，归一化在
// `appserver.normalizeCustomOrigin` 里（同一套"只做等价形态归一、绝不截到源"的口径）。
func NormalizeOrigin(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	i := strings.Index(s, "://")
	if i < 0 {
		return ""
	}
	scheme := strings.ToLower(strings.TrimSpace(s[:i]))
	if scheme != "http" && scheme != "https" {
		return ""
	}
	host := strings.TrimSuffix(strings.TrimSpace(s[i+3:]), "/")
	if host == "" {
		return ""
	}
	// 配置里可能带路径（`https://h/base`）——源不含路径，多出来的部分直接丢弃。
	if j := strings.IndexByte(host, '/'); j >= 0 {
		host = host[:j]
	}
	// 借一个假请求复用同一套 host:port 规范化（默认端口省略）。
	fake := &http.Request{Host: host}
	return scheme + "://" + originHostPort(fake, scheme)
}

// OriginDiagFields 汇总一次来源校验失败的可观测面（Host / Origin / Referer /
// X-Forwarded-Proto）。**绝不含 Cookie**：会话明文进日志等于凭证泄漏。
//
// 唯一调用方是 `appserver` 的跨源写拒绝分支（管线步骤 ⑤）：应用页在客户端内
// 发非幂等请求被拒时，日志里必须同时留下"期望的源/收到的 Origin/Referer"三件事实，
// 否则"应用写请求全 403"只能靠猜（Origin 是协议 handler 合成的，
// 合成错 scheme / 漏补头都会走到这里）。
func OriginDiagFields(r *http.Request) string {
	if r == nil {
		return `host="" origin="" referer="" x-forwarded-proto=""`
	}
	return fmt.Sprintf("host=%q origin=%q referer=%q x-forwarded-proto=%q",
		r.Host, r.Header.Get("Origin"), r.Header.Get("Referer"), r.Header.Get("X-Forwarded-Proto"))
}

// IsIdempotent 判定方法是否幂等（幂等方法不做 Origin 校验）。
// 与 RFC 7231 一致：GET/HEAD/OPTIONS/TRACE 幂等；POST/PUT/PATCH/DELETE 不幂等。
func IsIdempotent(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions, http.MethodTrace:
		return true
	}
	return false
}

// HostReferrerPolicy 是宿主为应用响应强制写入的 referrer 策略。
//
// **必须是 same-origin，绝不能是 no-referrer。** 应用页最常见的写路径就是
// **同源表单 POST**（例如内置演示应用的留言墙 `<form method="post" action="/note">`）。
// 而按 WHATWG Fetch 的 "append a request Origin header" 算法，referrer policy 为
// no-referrer 时，**非 GET/HEAD 请求的 `Origin` 头会被写成字面量 `null`**（同源也一样）
// —— 管线的跨源写判据要求 `Origin == <app scheme>://<app_id>`，于是应用内所有同源写
// 请求必然 403（「跨源写请求被拒」），应用功能 100% 不可用（2026-09-19 线上 P0）。
//
// same-origin 与原意图一致：同源才发 Referer、跨源一个字节都不发；区别只是同源
// 写请求仍带真实 Origin。别"为了更严"改回 no-referrer —— 那等于关掉应用写功能。
// 判据：temp/wasm-probe/micro-referrer.mjs 与
// docs/decisions/2026-09-19-referrer-policy-origin-null.md。
const HostReferrerPolicy = "same-origin"

// AppVersionHeader 是**生效版本**的响应头名（契约 §5.1 / R1-DAT-12 / R2I-21）。
//
// 为什么必须有它：客户端的内容缓存键是 `(session-scope, app_id, version, path)`,
// 而"version"此前在客户端**没有任何来源** —— 协议 handler 拿到的只有响应体（应用
// 自己的字节），于是缓存要么不按版本分目录（改版后继续发旧内容），要么只能靠
// `open` 端点兜底。平台在**成功响应**上写这个头，客户端原样透传/读取即可。
//
// 定义在 edge（而不是 api 或 appserver）的唯一理由：两个包都要写它，而
// `api → appserver → edge` 是既有依赖方向，常量只能住在被双方共享的最下游包。
const AppVersionHeader = "X-PicoAide-App-Version"

// ApplyHostSecurityHeaders 写宿主独占的响应安全头（§4.8）。
//
// **含 4xx/5xx**：调用方必须在写任何响应体之前调用它，包括错误分支。
// 应用自带的同名头一律剥离 —— 由 StripAppControlledHeaders 完成（在把应用的
// 响应头写回客户端之前调用）。
//
// selfOrigin 由**调用方**传入（`appserver.(*Server).selfOrigin`）：本包不自行推导，
// 见包注释的边界铁律。CSP 目前不使用该参数（里面写的是 `'self'`，由浏览器按页面
// origin 解析），但签名必须带着它 —— 否则"某天让 CSP 插值"就会踩上错误的源。
//
// Referrer-Policy 取 HostReferrerPolicy（= same-origin，**不是 no-referrer**），
// 理由见该常量的注释。
func ApplyHostSecurityHeaders(h http.Header, selfOrigin string) {
	h.Set("Content-Security-Policy", limits.AppContentSecurityPolicy(selfOrigin))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", HostReferrerPolicy)
	// 应用页绝不希望被搜索引擎或第三方嵌帧收录（frame-ancestors 已在 CSP 中）。
	h.Set("X-Frame-Options", "DENY")
	// 宿主独占 Cookie，因此禁止应用设置 Cookie 头（白名单里也没有 cookie）。
	h.Set("Cache-Control", "no-store")
}

// StripAppControlledHeaders 从应用返回的头里剥掉宿主独占头与不在白名单里的头（§4.8）。
//
// 返回剥离后的新 map（不修改入参）。**Cookie 由宿主独占**（Set-Cookie 一律丢）。
func StripAppControlledHeaders(app http.Header) http.Header {
	out := make(http.Header, len(app))
	allow := map[string]struct{}{}
	for _, k := range limits.AppResponseHeaderAllowlist {
		allow[k] = struct{}{}
	}
	for k, vs := range app {
		lk := strings.ToLower(k)
		if _, ok := allow[lk]; !ok {
			continue
		}
		// CR/LF 注入防护（§4.8「CR/LF：头值中出现即拒」）。
		clean := make([]string, 0, len(vs))
		bad := false
		for _, v := range vs {
			if strings.ContainsAny(v, "\r\n") {
				bad = true
				break
			}
			clean = append(clean, v)
		}
		if bad {
			continue
		}
		// 用规范键写入：http.Header.Get 会做 MIME 规范化，写入小写键会让 Get 落空。
		ck := http.CanonicalHeaderKey(lk)
		out[ck] = clean
	}
	// content-type 必须在允许集合内（§4.8「限定集合」）。
	if ct := out.Get("Content-Type"); ct != "" {
		if !allowedContentType(ct) {
			delete(out, "Content-Type")
		}
	}
	// content-disposition 仅允许 inline（禁止把应用页面变成下载）。
	if cd := out.Get("Content-Disposition"); cd != "" {
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(cd)), "inline") {
			delete(out, "Content-Disposition")
		}
	}
	return out
}

// allowedContentType 判定 content-type 是否在允许集合内（忽略参数如 charset）。
func allowedContentType(ct string) bool {
	base := strings.ToLower(strings.TrimSpace(ct))
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = strings.TrimSpace(base[:i])
	}
	for _, a := range limits.AppResponseContentTypes {
		if base == a {
			return true
		}
	}
	return false
}

// DefaultContentTypeForBody 在应用**没有给出可用 content-type** 时显式判定一个类型。
//
// 为什么必须有这条（2026-09-21 审计 F-13）：动态响应此前把 Content-Type 交给
// `net/http` 的**隐式嗅探**（应用没写、或被 §4.8 白名单剥掉 ⇒ 头为空 ⇒ 首次 Write
// 时由标准库按前 512 字节决定）。两个后果：
//   - "白名单"事实上被绕过：类型由**响应体内容**决定，而不是由平台枚举决定；
//   - 行为随 Go 版本漂移，且在本 package 的测试里完全不可见（隐式路径不写头）。
//
// 判据（"显式 + 收口"两条一起）：
//  1. 用 `http.DetectContentType`（与隐式路径同一张表 ⇒ **行为等价、无回归**）；
//  2. 结果必须落回 §4.8 的允许集合：`text/html` / `text/plain` 保留并补 charset，
//     `image/*` 只在允许集合内保留，其余（含 Go 会认出的 application/pdf、
//     application/zip、audio/*、video/*）一律回落 `application/octet-stream`。
//
// 为什么保留 text/html 而不是统一 octet-stream：应用页的主文档就是 HTML，
// 而"没写 Content-Type"的应用在修复前靠嗅探能正常渲染 —— 统一 octet-stream 会把
// 它们变成下载 ⇒ 白屏，属于**修复引入的回归**。参考实现（refapp / examples）都显式
// 写了头，所以这条只影响"忘了写"的应用：给它们一个安全的、与修复前一致的默认值。
func DefaultContentTypeForBody(body []byte) string {
	sniffed := http.DetectContentType(body)
	base := strings.ToLower(strings.TrimSpace(sniffed))
	if i := strings.IndexByte(base, ';'); i >= 0 {
		base = strings.TrimSpace(base[:i])
	}
	switch base {
	case "text/html":
		return "text/html; charset=utf-8"
	case "text/plain":
		return "text/plain; charset=utf-8"
	}
	if strings.HasPrefix(base, "image/") && allowedContentType(base) {
		return base
	}
	return "application/octet-stream"
}

// MaxBodyBytes 是应用 API 的请求体上限（§4.6）。
func MaxBodyBytes() int64 { return limits.AppRequestBodyMaxBytes }
