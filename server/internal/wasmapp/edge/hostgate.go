// Package edge 实现应用子域的**最外层门控**：主机名判别（allow-list）、
// 跨应用写防护（Origin 校验）、宿主独占的响应安全头、请求体上限。
//
// 设计依据：§4.8（响应与浏览器侧）、§6.1（请求链路）、§15.1 第 2/3/13 条、
// §10.1 第 13a–13d 项。
//
// 三条不可动摇的语义：
//
//  1. **allow-list，不是禁命中清单**（§4.8）：应用子域只挂应用路由树，主站路由
//     在子域**根本不注册**。全仓 Go 代码此前零 host 维度判断，`/`、`/portal`、
//     `/admin/*` 都在 NoRoute 分支、`/healthz` 在根引擎上 ⇒ 清单式"禁命中"必然漏，
//     没有门控时每个应用子域都会渲染门户与**管理台登录页**。
//  2. **未知主机名一律 404，绝不回落主站**（§4.8）：否则任何 `<随机>.<基域>`
//     都会变成主站的镜像（钓鱼面）。
//  3. **安全头由宿主独占**（§4.8/§15.1 第 13 条）：应用子域是公司域名下的
//     任意 HTML/JS 宿主（R8/R37），应用自带的同名头一律剥离，且 4xx/5xx 也要写。
package edge

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// logWarn 是本包的告警落点（与 session.logError / clientrelease.logWarn 同形，
// 测试可替换以静音）。只在**来源校验被拒**这类低频分支调用。
var logWarn = log.Printf

// HostKind 是主机名判别结果（三态：主站 / 应用子域 / 未知）。
type HostKind int

const (
	// HostMain 是主站主机名（等于应用基域本身，或未配置应用基域时的任意主机名）。
	HostMain HostKind = iota
	// HostApp 是应用子域：第一级标签即 app_id。
	HostApp
	// HostUnknown 是"看起来属于基域但形态非法"的主机名 ⇒ 一律 404，不回落主站。
	HostUnknown
)

// MatchHost 判别请求主机名（§4.8「主机名反查」）。
//
// base 为空 ⇒ 未启用应用子域，全部视为主站（HostMain），保持既有部署行为不变。
//
// 规则：
//   - 去掉端口、转小写、去尾部点（域名不区分大小写；入库统一小写）；
//   - host == base ⇒ 主站；
//   - host == "<label>.<base>" 且 label 只有一级（**通配证书只覆盖一级标签**，
//     R29/§4.2 ⇒ 不允许 `a.b.<base>`）且符合 app_id 规则 ⇒ 应用子域；
//   - 其他（更深的层级、非法 label、其它域名）⇒ 主站（不是我们的基域）。
func MatchHost(host, base string) (label string, kind HostKind) {
	h := normalizeHost(host)
	b := normalizeHost(base)
	if b == "" {
		return "", HostMain
	}
	if h == b {
		return "", HostMain
	}
	suffix := "." + b
	if !strings.HasSuffix(h, suffix) {
		// 不是本基域下的主机名 ⇒ 主站路由自己会按 Host 处理（例如 IP 直连、
		// 本地探测、其它域名反代到同一进程）。
		return "", HostMain
	}
	prefix := strings.TrimSuffix(h, suffix)
	if prefix == "" {
		return "", HostMain
	}
	// 只允许一级标签：`a.b.<base>` 既拿不到通配证书，也是刻意绕过保留字的常见手法。
	if strings.Contains(prefix, ".") {
		return "", HostUnknown
	}
	if !isValidAppLabel(prefix) {
		return "", HostUnknown
	}
	return prefix, HostApp
}

// normalizeHost 归一化主机名：去端口、小写、去尾部点。
func normalizeHost(h string) string {
	host, _ := splitHostPort(h)
	if host == "" {
		return ""
	}
	if strings.ContainsRune(host, ':') {
		// IPv6 字面量必须带方括号（`[::1]`）——与浏览器写在 Origin 里的形态一致。
		return "[" + host + "]"
	}
	return host
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
// 那会把 `https://a.<基域>/x`、`https://a.<基域>.evil.net` 这类伪造值
// 通过"截到源"的操作当成合法源放行。
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

// requestScheme 判定本次请求的协议：TLS ⇒ X-Forwarded-Proto（反代终止 TLS）⇒ http。
func requestScheme(r *http.Request) string {
	if r == nil {
		return "http"
	}
	if r.TLS != nil {
		return "https"
	}
	p := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if p == "" {
		return "http"
	}
	// 只取第一个值（逗号分隔的链里第一个是客户端侧协议）。
	if i := strings.IndexByte(p, ','); i >= 0 {
		p = p[:i]
	}
	switch strings.ToLower(strings.TrimSpace(p)) {
	case "https":
		return "https"
	case "http":
		return "http"
	}
	return "http"
}

// isValidAppLabel 校验第一级标签是否可能是合法 app_id。
// 这里只做**形态**校验（小写字母/数字/连字符、长度 ≤ 63、不以连字符开头结尾）；
// 纯数字 / `xn--` / 保留字等业务规则由 registry（app_id 校验）负责 ——
// 门控层的职责是"不是合法形态就不要当应用处理"，避免把畸形标签送进 DB 查询。
func isValidAppLabel(label string) bool {
	if label == "" || len(label) > limits.MaxAppIDLen {
		return false
	}
	if label[0] == '-' || label[len(label)-1] == '-' {
		return false
	}
	prevHyphen := false
	for i := 0; i < len(label); i++ {
		c := label[i]
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			prevHyphen = false
		case c == '-':
			if prevHyphen {
				return false
			}
			prevHyphen = true
		default:
			return false
		}
	}
	return true
}

// SelfOrigin 返回本次请求的自身源（`scheme://host[:port]`）。
//
// scheme 的判定顺序：TLS ⇒ X-Forwarded-Proto（反代终止 TLS）⇒ http。
// Host 由请求行给出，**不是客户端可随意伪造的"源"**：浏览器总是按真实目标写 Host，
// 因此"Origin == SelfOrigin"是一个可靠的跨源写判据（§15.1 第 3 条）。
//
// **端口必须参与**：RFC 6454 的 origin 是 scheme + host + port 三元组，而浏览器在
// `Origin` 头里**省略默认端口**（https 的 443 / http 的 80）。因此本函数的返回值必须
// 与"浏览器会发的那个 Origin"逐字符一致：默认端口省略、非默认端口保留。
//
// 这条曾经写错（旧实现把端口一律剥掉），后果是**非 443 部署下一切非幂等请求 403**
// （同源 Origin `https://h:8443` ≠ 自身源 `https://h`），且反向更糟：同主机的
// **任意端口**都被当成自身源（`https://h:9443` 会被放行）。判据见 §10.4 第 44 项。
func SelfOrigin(r *http.Request) string {
	if r == nil {
		return ""
	}
	scheme := requestScheme(r)
	host := originHostPort(r, scheme)
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

// NormalizeOrigin 归一化一个**源**字符串，使其可与 SelfOrigin 逐字符比较：
// 小写、去尾部斜杠、默认端口省略、非默认端口保留。
//
// 允许输入带尾部斜杠（`https://h/`，配置里常见）；**带路径的输入会被截到源**
// （`https://h/base` ⇒ `https://h`）—— 它是给配置值（Options.MainOrigin）用的。
// 判定**请求头**里的 `Origin` 时必须先过 IsOriginShaped：那里不接受任何路径形态。
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

// CheckOrigin 是跨应用写防护（§4.8「跨应用写防护」+ §10.4 第 44 项）。
//
// 条件（非幂等方法）：
//   - `Origin` 存在 ⇒ 必须 **完全等于** 自身源；
//   - `Origin` 缺失（老浏览器/同源表单）⇒ 校验 `Referer` 是否以自身源为前缀；
//   - 两者都缺失 ⇒ 拒（宁可拒一次合法请求，也不放过一次跨源写）。
//
// 必须在任何重定向/重写**之前**执行（本包由 HostGate 在最外层调用）。
//
// 被拒时落**一条**上下文日志（每个被拒的写请求一条，低频；绝不打请求体/Cookie）。
// 这条日志是"应用写请求全 403"这类线上故障的唯一现场：`Origin: null` 说明页面
// 下发了 no-referrer（见 HostReferrerPolicy），`Origin` 与 `self` 只差端口说明
// 反代的 X-Forwarded-Proto / Host 与浏览器实际访问的源不一致。
func CheckOrigin(r *http.Request) bool {
	ok, reason, detail := checkOriginReason(r)
	if !ok {
		logWarn("pico-wasm-edge: 应用子域写请求来源校验未通过 reason=%s self=%q %s detail=%s",
			reason, SelfOrigin(r), OriginDiagFields(r), detail)
	}
	return ok
}

// checkOriginReason 是 CheckOrigin 的判定本体：返回 (是否放行, 判据名, 人读补充)。
//
// 拆出来是为了让**失败原因**可枚举（日志与测试都盯着同一份判据名），
// 判定语义与拆之前逐条相同。
func checkOriginReason(r *http.Request) (bool, string, string) {
	if r == nil {
		return false, "nil_request", "请求对象为空"
	}
	self := SelfOrigin(r)
	if self == "" {
		return false, "no_self_origin", "推导不出自身源（Host 头缺失）"
	}
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		// Origin 必须是**源**（scheme + host[:port]），不带路径/query/fragment/userinfo。
		// `https://h/x`、`https://h?x`、`https://user@h` 这类值不是合法 Origin
		//（合法实现不会发），一律拒 —— 不能靠"剥掉多余部分再比"来猜它想表达什么：
		// 那会把 `https://a.<基域>/x` 这类伪造值当成 `https://a.<基域>` 放行。
		if !IsOriginShaped(origin) {
			return false, "origin_malformed",
				"Origin 不是合法的源形态（含路径/query/userinfo，或为字面量 \"null\" —— no-referrer 策略下浏览器对同源写请求也发 null）"
		}
		// 与自身源走**同一套规范化**（小写、默认端口省略）后再比：
		// 浏览器可能发 `https://h:443` 这种带默认端口的形态，而自身源按 Origin 的
		// 规范形态省略了它 —— 两侧都规范化才不会把同源判成跨源。
		// "null"（sandboxed iframe / data: 文档）形态不符 ⇒ 上面已拒。
		norm := NormalizeOrigin(origin)
		if norm == "" {
			return false, "origin_unparsable", "Origin 解析不出源"
		}
		if !strings.EqualFold(norm, self) {
			return false, "origin_mismatch", "Origin 与自身源不一致（规范化后仍不等）"
		}
		return true, "", ""
	}
	ref := strings.TrimSpace(r.Header.Get("Referer"))
	if ref == "" {
		return false, "origin_and_referer_missing",
			"Origin 与 Referer 都没有（no-referrer 策略下二者都会被剥掉）"
	}
	low := strings.ToLower(ref)
	if strings.HasPrefix(low, strings.ToLower(self)+"/") || strings.EqualFold(strings.TrimSuffix(low, "/"), self) {
		return true, "", ""
	}
	return false, "referer_mismatch", "Referer 不以自身源为前缀"
}

// OriginDiagFields 汇总一次来源校验失败的可观测面（Host / Origin / Referer /
// X-Forwarded-Proto）。**绝不含 Cookie**：会话明文进日志等于凭证泄漏。
//
// 导出是给 session.checkMainOrigin 复用（同一份日志口径，两处各写一遍必然漂移）。
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

// HostReferrerPolicy 是宿主为应用子域强制写入的 referrer 策略。
//
// **必须是 same-origin，绝不能是 no-referrer。** 应用子域的页面是应用自己的 HTML，
// 它最常见的写路径就是**同源表单 POST**（例如内置演示应用的留言墙
// `<form method="post" action="/note">`）。而按 WHATWG Fetch 的
// "append a request Origin header" 算法，referrer policy 为 no-referrer 时，
// **非 GET/HEAD 请求的 `Origin` 头会被写成字面量 `null`**（同源也一样）——
// 本包的 CheckOrigin 要求 `Origin == 自身源`，于是应用内所有同源写请求必然 403
// （「跨源写请求被拒」），应用功能在真实浏览器里 100% 不可用（2026-09-19 线上 P0）。
//
// same-origin 与原意图一致：同源才发 Referer、跨源一个字节都不发；区别只是同源
// 写请求仍带真实 Origin。别"为了更严"改回 no-referrer —— 那等于关掉应用写功能。
// 判据：temp/wasm-probe/micro-referrer.mjs 与
// docs/decisions/2026-09-19-referrer-policy-origin-null.md。
const HostReferrerPolicy = "same-origin"

// ApplyHostSecurityHeaders 写宿主独占的响应安全头（§4.8）。
//
// **含 4xx/5xx**：调用方必须在写任何响应体之前调用它，包括错误分支。
// 应用自带的同名头一律剥离 —— 由 StripAppControlledHeaders 完成（在把应用的
// 响应头写回客户端之前调用）。
//
// Referrer-Policy 取 HostReferrerPolicy（= same-origin，**不是 no-referrer**），
// 理由见该常量的注释：no-referrer ⇒ 同源写请求 Origin: null ⇒ CheckOrigin 全拒。
func ApplyHostSecurityHeaders(h http.Header, selfOrigin string) {
	h.Set("Content-Security-Policy", limits.AppContentSecurityPolicy(selfOrigin))
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", HostReferrerPolicy)
	// 应用子域绝不希望被搜索引擎或第三方嵌帧收录（frame-ancestors 已在 CSP 中）。
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

// MaxBodyBytes 是应用 API 的请求体上限（§4.6）。
// 子域路由树**不在**两个 1 MB 中间件分组里 ⇒ 必须自己实现（§4.6 原话）。
func MaxBodyBytes() int64 { return limits.AppRequestBodyMaxBytes }
