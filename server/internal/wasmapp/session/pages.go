package session

import (
	"html/template"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// 本文件是登录页与换票页的**注入式 HTML**（与 packages/host/desktop 的
// auth-gate.ts 同类：宿主自己渲染的页面，不走 SPA）。
//
// 三条硬要求（§4.7 与任务口径）：
//  1. **无外部资源**：CSS/JS/字体一律内联，因此可以配上 `default-src 'none'` 的严格 CSP；
//  2. **语言按请求解析**：copy 表是静态数据、选择发生在请求期 —— 绝不在模块级把
//     语言冻结成常量（宿主侧多语言的既有 bug 类，见 host-locale 的两条长期规则）；
//  3. **错误不泄露账号存在性**：认证失败一律同一句"账号或密码错误"。

// mainPageReferrerPolicy 是主站这两个页面（员工登录页 / 换票页）下发与内联的
// referrer 策略。**必须是 same-origin，绝不能是 no-referrer。**
//
// 这不是"严不严"的取舍，而是功能正确性问题（2026-09-19 线上 P0）：
// 按 WHATWG Fetch 的 "append a request Origin header" 算法，当请求的 referrer
// policy 是 no-referrer 时，**非 GET/HEAD 请求的 `Origin` 头被写成字面量 `null`**
// —— 同源请求也一样（规范里只有 cors / websocket 模式才无条件写真实源）。
//
// 本平台这两个页面**都靠同源表单 POST 工作**：登录页 `POST /login`、换票页
// 加载即自动提交 `POST /app-ticket`；而服务端的 CSRF 判据正是
// `Origin == 自身源`（checkMainOrigin，§4.7）。于是 no-referrer ⇒ 浏览器发
// `Origin: null` ⇒ 两个端点必然 403 ⇒ 员工登录与换票 **100% 不可用**。
//
// 为什么 same-origin 满足原有的"不向第三方泄漏页面 URL"意图：它只在**同源**请求上
// 发 Referer，跨源请求一个字节都不发（比 no-referrer-when-downgrade 严），
// 同时同源写请求仍带真实 Origin。别"为了更严"改回 no-referrer —— 那等于关掉登录。
//
// 判据与复现（真实 Chromium 微实验）：temp/wasm-probe/micro-referrer.mjs、
// 决策文档 docs/decisions/2026-09-19-referrer-policy-origin-null.md。
const mainPageReferrerPolicy = "same-origin"

// mainPageCSP 是主站这两个页面自带的 CSP。
//
// 比 §4.8 的应用子域口径更严（不放开 connect-src），但保留 `style-src 'unsafe-inline'`
// 与 `script-src 'unsafe-inline'` —— 换票页需要一个内联自动提交脚本，登录页需要内联样式，
// 这正是"无外部资源"换来的能力。`img-src 'self' data:` 只为后续可能的渠道 logo
// （data: URI 或本站路径）留口，不允许任何外链图片。
const mainPageCSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
	"img-src 'self' data:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

// pageCSS 是两个页面共用的内联样式（无外链字体、无外链背景图）。
const pageCSS = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#f5f6f8;color:#1f2328;font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif}
.card{width:100%;max-width:22rem;margin:2rem 1rem;padding:1.75rem;border-radius:14px;background:#fff;
box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.08)}
.brand{margin:0 0 .25rem;font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:#6b7280}
h1{margin:0 0 1rem;font-size:1.15rem;font-weight:600}
p{margin:0 0 .75rem;font-size:.85rem;line-height:1.5}
.err{color:#b42318}
.ok{color:#067647}
label{display:block;margin:.75rem 0 .25rem;font-size:.8rem;color:#4b5563}
input[type=text],input[type=password]{width:100%;padding:.55rem .65rem;font-size:.95rem;border:1px solid #d0d5dd;
border-radius:8px;background:#fff;color:inherit}
input[type=text]:focus,input[type=password]:focus{outline:2px solid #2563eb;outline-offset:1px;border-color:#2563eb}
button{margin-top:1.25rem;width:100%;padding:.6rem .75rem;font-size:.95rem;font-weight:600;color:#fff;
background:#2563eb;border:0;border-radius:8px;cursor:pointer}
button:hover{background:#1d4ed8}
button:active{background:#1e40af}
/* 跳板页的兜底入口是**链接**而不是按钮：form-action 只约束表单提交，
   链接导航不受它管 —— 这正是它在"跨源那一跳"上比按钮更可靠的原因。 */
p.act{margin:1.25rem 0 0}
a.go{display:block;padding:.6rem .75rem;font-size:.95rem;font-weight:600;text-align:center;
color:#fff;background:#2563eb;border-radius:8px;text-decoration:none}
a.go:hover{background:#1d4ed8}
a.go:active{background:#1e40af}
@media (prefers-color-scheme:dark){
body{background:#0b0d10;color:#e6e8eb}
.card{background:#161a1f;box-shadow:0 1px 2px rgba(0,0,0,.4),0 8px 24px rgba(0,0,0,.5)}
.brand{color:#9aa3ad}
label{color:#a9b1ba}
input[type=text],input[type=password]{background:#0f1216;border-color:#303740;color:#e6e8eb}
.err{color:#f97066}.ok{color:#75e0a7}
}`

// pageCopy 是一个语言下的全部文案。新增文案必须两个语言都给（测试逐一比对键集合）。
type pageCopy struct {
	Lang string
	// Login
	LoginTitle    string
	LoginHeading  string
	UsernameLabel string
	PasswordLabel string
	LoginSubmit   string
	// 认证失败：**统一文案**，不得区分"用户不存在/密码错误/账号禁用"
	// （否则 /login 变成账号枚举器）。
	ErrCredentials string
	ErrInternal    string
	ErrForbidden   string
	// ErrOriginRejected 是**来源校验失败**的专用文案（与 ErrForbidden 区分）：
	// 它带**可操作指引**，因为这条分支**仍然渲染登录表单**让用户重试
	// （2026-09-19 P0：曾经 ShowForm=false，用户落到一个没有输入框的死页面）。
	ErrOriginRejected string
	ErrMethod         string
	ErrRateLimited    string
	// 非 https：明确报错而不是静默下发不安全 Cookie（§10.4 第 49 项）。
	ErrInsecure string
	// ErrTicketNonceUnavailable 是**换票签发被 fail-closed 拒绝**时的文案
	// （R1-sec-1 回归审计：本部署无法下发 nonce Cookie ⇒ 宁可不签发票）。
	// 它是运维可定位的**配置故障**（不是用户错误），文案要让管理员知道去配什么。
	ErrTicketNonceUnavailable string
	NoticeOut                 string
	// Ticket
	TicketTitle   string
	TicketHeading string
	TicketBody    string
	TicketSubmit  string
	// TicketRedirectBody / TicketContinue 属于**跳板页**（TicketSubmit 成功后的 200 页）：
	// 它与确认页是两件事 —— 确认页在"还没有票"时问浏览器要一次同源 POST，
	// 跳板页在"票已经拿到"时把浏览器交给应用子域。文案必须说清"已经换好了"，
	// 否则用户会以为还要再点一次。
	TicketRedirectBody string
	TicketContinue     string
	// SessionExpired* 是**应用子域会话失效**时的跳板页文案（appserver 调用
	// RedirectPage(RedirectAppSessionExpired, …)）。它必须说清"这次提交没有被保存"，
	// 否则用户会以为数据已经写入（跳板页走的是 GET 换票，原始 POST 体不会重放）。
	SessionExpiredHeading string
	SessionExpiredBody    string
	SessionExpiredAction  string
	ErrSession            string
}

var copyZH = pageCopy{
	Lang:           "zh",
	LoginTitle:     "登录",
	LoginHeading:   "登录",
	UsernameLabel:  "用户名",
	PasswordLabel:  "密码",
	LoginSubmit:    "登录",
	ErrCredentials: "账号或密码错误",
	ErrInternal:    "服务暂时不可用，请稍后重试",
	ErrForbidden:   "请求来源校验未通过，请从平台首页重新进入",
	ErrOriginRejected: "请求来源校验未通过：浏览器没有发送可识别的来源。" +
		"请在下方重新输入账号密码重试；若仍失败，请从平台首页重新打开本页" +
		"（安装了剥离来源的隐私类浏览器扩展时请先关闭）。",
	ErrMethod:      "请求方法不被允许",
	ErrRateLimited: "登录尝试过于频繁，请稍后再试",
	ErrInsecure: "当前连接不是 HTTPS，出于安全考虑平台不会签发登录凭证。" +
		"请改用 https:// 访问本平台，或联系管理员启用 TLS。",
	ErrTicketNonceUnavailable: "服务端的对外访问地址与应用域名不匹配，平台无法安全地完成应用登录，" +
		"因此没有签发访问凭证。请联系管理员检查「服务端对外地址」（控制台设置或 " + publicBaseURLEnvName +
		" 环境变量）与应用基域配置 —— 两者必须同域，且应用基域必须是能承载 Cookie 的普通域名" +
		"（不能是 IP 地址，也不能含下划线）。",
	NoticeOut:     "已退出登录。",
	TicketTitle:   "正在打开应用",
	TicketHeading: "正在打开应用",
	TicketBody:    "正在为你换取一次性访问凭证。若浏览器没有自动跳转，请点击下面的按钮。",
	TicketSubmit:  "继续",
	TicketRedirectBody: "一次性访问凭证已换好，正在为你跳转到应用。" +
		"若浏览器没有自动跳转，请点击下面的链接继续。",
	TicketContinue:        "继续前往应用",
	SessionExpiredHeading: "登录状态已失效",
	SessionExpiredBody: "应用登录状态已失效，这次提交没有被保存。" +
		"正在带你去重新登录；若浏览器没有自动跳转，请点击下面的链接。",
	SessionExpiredAction: "去登录并返回应用",
	ErrSession:           "登录状态已失效，请重新登录",
}

var copyEN = pageCopy{
	Lang:           "en",
	LoginTitle:     "Sign in",
	LoginHeading:   "Sign in",
	UsernameLabel:  "Username",
	PasswordLabel:  "Password",
	LoginSubmit:    "Sign in",
	ErrCredentials: "Incorrect username or password",
	ErrInternal:    "Service temporarily unavailable, please retry",
	ErrForbidden:   "Request origin check failed, please start again from the platform home page",
	ErrOriginRejected: "Request origin check failed: the browser sent no recognizable origin. " +
		"Please enter your credentials below and try again; if it still fails, reopen this page " +
		"from the platform home page (disable privacy extensions that strip origins first).",
	ErrMethod:      "Method not allowed",
	ErrRateLimited: "Too many sign-in attempts, please try again later",
	ErrInsecure: "This connection is not HTTPS, so the platform will not issue a sign-in credential. " +
		"Please use https:// or ask your administrator to enable TLS.",
	ErrTicketNonceUnavailable: "The server public address does not match the application domain, so the " +
		"application sign-in cannot be completed securely and no credential was issued. Please ask your " +
		"administrator to check the server public address (console setting or the " + publicBaseURLEnvName +
		" environment variable) and the application base domain - they must share the same domain, and the " +
		"base domain must be a plain domain name that can carry cookies (not an IP address, and without underscores).",
	NoticeOut:     "You have been signed out.",
	TicketTitle:   "Opening application",
	TicketHeading: "Opening application",
	TicketBody:    "Exchanging a one-time access credential. If your browser does not redirect automatically, use the button below.",
	TicketSubmit:  "Continue",
	TicketRedirectBody: "Your one-time access credential is ready. Redirecting you to the application. " +
		"If your browser does not redirect automatically, use the link below.",
	TicketContinue:        "Continue to the application",
	SessionExpiredHeading: "Your session has expired",
	SessionExpiredBody: "Your application session has expired, so this submission was not saved. " +
		"Taking you to sign in again; if your browser does not redirect automatically, use the link below.",
	SessionExpiredAction: "Sign in and return to the application",
	ErrSession:           "Your session has expired, please sign in again",
}

// copyFor 返回语言对应的文案表。
func copyFor(lang string) pageCopy {
	if lang == "en" {
		return copyEN
	}
	return copyZH
}

// preferredLocale 解析 Accept-Language（§4.7：语言按请求解析）。
//
// 规则：按 q 值降序取第一个能识别的语言标签（前缀匹配 `zh`/`en`，中英两版），
// q=0 视为"不接受"直接跳过，全部不匹配时回落产品默认 `zh`（与宿主侧
// host-locale 的 DEFAULT_HOST_LOCALE 同口径）。
func preferredLocale(acceptLanguage string) string {
	type entry struct {
		tag string
		q   float64
		seq int
	}
	var entries []entry
	for i, part := range strings.Split(acceptLanguage, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		tag := part
		q := 1.0
		if semi := strings.IndexByte(part, ';'); semi >= 0 {
			tag = strings.TrimSpace(part[:semi])
			for _, param := range strings.Split(part[semi+1:], ";") {
				param = strings.TrimSpace(param)
				if !strings.HasPrefix(strings.ToLower(param), "q=") {
					continue
				}
				if v, err := strconv.ParseFloat(strings.TrimSpace(param[2:]), 64); err == nil {
					q = v
				}
			}
		}
		if q <= 0 {
			continue
		}
		entries = append(entries, entry{tag: strings.ToLower(tag), q: q, seq: i})
	}
	sort.SliceStable(entries, func(a, b int) bool { return entries[a].q > entries[b].q })
	for _, e := range entries {
		switch {
		case e.tag == "zh" || strings.HasPrefix(e.tag, "zh-"):
			return "zh"
		case e.tag == "en" || strings.HasPrefix(e.tag, "en-"):
			return "en"
		}
	}
	return "zh"
}

// ---- 模板 ----

var loginTmpl = template.Must(template.New("login").Parse(`<!doctype html>
<html lang="{{.C.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="` + mainPageReferrerPolicy + `">
<title>{{.Title}}</title>
<style>{{.CSS}}</style>
</head>
<body>
<main class="card">
{{if .Product}}<p class="brand">{{.Product}}</p>{{end}}
<h1>{{.C.LoginHeading}}</h1>
{{if .Insecure}}<p class="err" role="alert">{{.C.ErrInsecure}}</p>{{end}}
{{if .Error}}<p class="err" role="alert">{{.Error}}</p>{{end}}
{{if .Notice}}<p class="ok" role="status">{{.Notice}}</p>{{end}}
{{if .ShowForm}}
<form method="post" action="/login">
<input type="hidden" name="next" value="{{.Next}}">
<label for="picoaide-username">{{.C.UsernameLabel}}</label>
<input id="picoaide-username" name="username" type="text" autocomplete="username" required maxlength="{{.MaxUser}}" autofocus>
<label for="picoaide-password">{{.C.PasswordLabel}}</label>
<input id="picoaide-password" name="password" type="password" autocomplete="current-password" required maxlength="{{.MaxPass}}">
<button type="submit">{{.C.LoginSubmit}}</button>
</form>
{{end}}
</main>
</body>
</html>
`))

// loginView 是登录页模板的数据。
type loginView struct {
	C pageCopy
	// CSS 必须是 template.CSS（html/template 会拒绝把裸 string 注入 <style>，
	// 输出 ZgotmplZ 占位符 ⇒ 页面退化成无样式裸表单）。样式是编译期常量、
	// 不含任何用户输入，显式标注类型是正确用法而非绕过转义。
	CSS      template.CSS
	Title    string
	Product  string
	Next     string
	Error    string
	Notice   string
	Insecure bool
	ShowForm bool
	MaxUser  int
	MaxPass  int
}

// loginHTML 渲染登录页（语言由调用方按请求解析后传入）。
func loginHTML(lang string, v loginView) string {
	v.C = copyFor(lang)
	// html/template 会拒绝把 string 注入 <style>（输出 ZgotmplZ 占位符 ⇒ 页面退化
	// 成无样式裸表单）。样式是我们自己的**编译期常量**、不含任何用户输入，
	// 因此显式标注为 template.CSS 是正确且必要的（不是绕过转义）。
	v.CSS = template.CSS(pageCSS)
	if v.MaxUser == 0 {
		v.MaxUser = maxUsernameLen
	}
	if v.MaxPass == 0 {
		v.MaxPass = maxPasswordLen
	}
	return renderTemplate(loginTmpl, v)
}

var ticketTmpl = template.Must(template.New("ticket").Parse(`<!doctype html>
<html lang="{{.C.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="` + mainPageReferrerPolicy + `">
<title>{{.Title}}</title>
<style>{{.CSS}}</style>
</head>
<body>
<main class="card">
{{if .Product}}<p class="brand">{{.Product}}</p>{{end}}
<h1>{{.C.TicketHeading}}</h1>
<p>{{.C.TicketBody}}</p>
<form method="post" action="/app-ticket" id="picoaide-ticket-form">
<input type="hidden" name="app" value="{{.App}}">
<input type="hidden" name="next" value="{{.Next}}">
<noscript><button type="submit">{{.C.TicketSubmit}}</button></noscript>
</form>
</main>
<script>document.getElementById("picoaide-ticket-form").submit();</script>
</body>
</html>
`))

// ticketView 是换票确认页的数据（GET 只渲染它，**不签发任何东西**）。
type ticketView struct {
	C       pageCopy
	CSS     template.CSS
	Title   string
	Product string
	App     string
	Next    string
}

// ticketHTML 渲染换票确认页。
func ticketHTML(lang string, v ticketView) string {
	v.C = copyFor(lang)
	// html/template 会拒绝把 string 注入 <style>（输出 ZgotmplZ 占位符 ⇒ 页面退化
	// 成无样式裸表单）。样式是我们自己的**编译期常量**、不含任何用户输入，
	// 因此显式标注为 template.CSS 是正确且必要的（不是绕过转义）。
	v.CSS = template.CSS(pageCSS)
	return renderTemplate(ticketTmpl, v)
}

// redirectPageTmpl 是**跳板页**模板（同源页面 + 页面自己完成跨源那一跳）。
//
// 为什么需要它（2026-09-19 线上 P0，真实 Chromium 复现；两处使用场景同一个根因）：
//
//	场景一（主站换票）：换票 POST 是同源的，但签发成功后要落到**跨源**的应用子域；
//	场景二（应用子域会话失效）：应用内的表单 POST 是同源的，但未登录时 appserver 要把它
//	送到**跨源**的主站换票端点。
//
//	两处的旧实现都是 `http.Redirect(..., 302)`，而 CSP3 的 `form-action` 检查会遍历整个
//	重定向链：同源 302 放行、**跨源 302 一律拦下**（Chromium 实测分别报
//	`Sending form data to '…/app-ticket' violates "form-action 'self'"` 与
//	`Sending form data to 'https://<app>.<基域>/…' violates "form-action 'self'"`）。
//	后果是服务端**从未收到那次 POST**（用户在换票页卡死 / 在应用里点了提交没反应）。
//
// 现在的形态：这类请求 **返回 200 的同源页面**，跨源那一跳由页面自己完成 —— 三条出口，
// 一条比一条保守，且都不经过 `form-action`：
//  1. 内联脚本 `location.replace(<链接的 href>)`：`replace` 不留历史条目
//     （后退不会退回这一页；换票场景下票已换出，本页没有重放的余地）；
//  2. `<meta http-equiv="refresh" content="0;url=…">`：无 JS 时的回退
//     （按 HTML 规范，声明式刷新同样以 replace 语义导航）；
//  3. 可见的 `<a href="…">`：**页面文案承诺的那个"继续"入口**，链接导航不受
//     `form-action` 约束，用户总有一条能走通的路。
//
// 关于票/凭据的泄漏面：两个调用方写响应时都设了 `Cache-Control: no-store` 与
// `Referrer-Policy: same-origin`（主站是 `writePage`、应用子域是
// `edge.ApplyHostSecurityHeaders` 的 `HostReferrerPolicy`）—— 从本页跨源跳走时，
// 浏览器**一个 Referer 字节都不发**，目标 URL 里的 `?ticket=` 不会经 Referer 泄漏；
// 应用子域兑换成功后由 `RedeemTicket` 302 到去掉 `ticket` 的干净 URL，
// 所以票也不会留在地址栏/历史/后续 Referer 里。本页自己的 URL 不含票（票在响应体里），
// 因此"后退"即使发生也不会暴露票。
//
// 注入面：`Target` 由服务端拼接（app_id 过 sanitizeAppID+registry 校验、next 过 sanitizeNext、
// 应用侧是 mainOrigin+ticketURL），但这里**仍然按不可信数据处理**：`<a href>` 与 meta `content`
// 都走 html/template 的属性转义（裸 `"` 会变成 `&#34;`，无法闭合属性），脚本**一个字节的 URL
// 都不拼接**、而是从 DOM 读 `a.href`（浏览器已解析好的绝对 URL）—— 因此不需要
// `template.JSStr`，也不存在"拼接进 <script> "这一类注入面。
var redirectPageTmpl = template.Must(template.New("redirect-page").Parse(`<!doctype html>
<html lang="{{.C.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="` + mainPageReferrerPolicy + `">
<meta http-equiv="refresh" content="0;url={{.Target}}">
<title>{{.Title}}</title>
<style>{{.CSS}}</style>
</head>
<body>
<main class="card">
{{if .Product}}<p class="brand">{{.Product}}</p>{{end}}
<h1>{{.Heading}}</h1>
<p>{{.Body}}</p>
<p class="act"><a class="go" id="picoaide-continue" href="{{.Target}}">{{.Action}}</a></p>
</main>
<script>var a=document.getElementById("picoaide-continue");if(a)location.replace(a.href);</script>
</body>
</html>
`))

// RedirectKind 选择跳板页的文案。模板与三条出口只有一份实现，两个场景只差文案。
type RedirectKind int

const (
	// RedirectTicketIssued：主站换票签发成功 ⇒ 把浏览器交给应用子域（票在 target 里）。
	RedirectTicketIssued RedirectKind = iota
	// RedirectAppSessionExpired：应用子域会话失效 ⇒ 把浏览器交给主站换票端点
	//（target 是 `/app-ticket?app=…&next=…`，**不含票**）。
	RedirectAppSessionExpired
)

// redirectPageView 是跳板页的数据（Target = 跨源那一跳的目标 URL）。
type redirectPageView struct {
	C       pageCopy
	CSS     template.CSS
	Title   string
	Product string
	Heading string
	Body    string
	Action  string
	Target  string
}

// RedirectPage 渲染**同源跳板页**（唯一实现；供主站换票与 appserver 共用）。
//
// lang 由调用方按请求解析（主站用 localeOf，应用子域用 PreferredLocale）；
// target 必须由调用方用服务端拼接的地址（绝不要把请求里的原始串直接传进来）；
// title/product 允许为空（title 为空时用该场景的标题）。
//
// ⚠️ 调用方必须自己写安全头：主站是 writePage（CSP=mainPageCSP、no-store、
// Referrer-Policy=same-origin），应用子域是 edge.ApplyHostSecurityHeaders
// （CSP=limits.AppContentSecurityPolicy、no-store、Referrer-Policy=HostReferrerPolicy）。
// **两个场景都不放宽 form-action**：表单永远只提交到同源，跨源那一跳是页面导航。
func RedirectPage(lang string, kind RedirectKind, target, title, product string) string {
	c := copyFor(lang)
	v := redirectPageView{Target: target, Product: product, Title: title}
	switch kind {
	case RedirectAppSessionExpired:
		v.Heading, v.Body, v.Action = c.SessionExpiredHeading, c.SessionExpiredBody, c.SessionExpiredAction
		if v.Title == "" {
			v.Title = c.SessionExpiredHeading
		}
	default:
		v.Heading, v.Body, v.Action = c.TicketHeading, c.TicketRedirectBody, c.TicketContinue
		if v.Title == "" {
			v.Title = c.TicketHeading
		}
	}
	v.C = c
	// 同 loginHTML/ticketHTML：样式是编译期常量，显式标注 template.CSS 是正确用法
	// （否则 html/template 输出 ZgotmplZ，页面退化成无样式裸页）。
	v.CSS = template.CSS(pageCSS)
	return renderTemplate(redirectPageTmpl, v)
}

// PreferredLocale 按 Accept-Language 解析语言（导出给 appserver 的注入式页面复用，
// 避免第二份语言解析实现）。空串 ⇒ 产品默认 `zh`。
func PreferredLocale(acceptLanguage string) string { return preferredLocale(acceptLanguage) }

// renderTemplate 执行模板；模板是编译期常量，失败只可能是编程错误。
func renderTemplate(t *template.Template, data any) string {
	var sb strings.Builder
	if err := t.Execute(&sb, data); err != nil {
		logError("pico-wasm-session: render template %s: %v", t.Name(), err)
		return ""
	}
	return sb.String()
}

// writePage 写一个自包含 HTML 页（安全头自带，不依赖上游是否已设）。
//
// 为什么在这里也设 CSP：这两个页面是"平台自己的注入式页面"，安全头必须由渲染方
// 独占（§4.8 对应用子域是同一条原则）；即使路由层另有一套主站安全头，
// 更严的页面级 CSP 也不会被放松成不安全。
//
// Referrer-Policy **必须是 same-origin**（见 mainPageReferrerPolicy 的长注释）：
// no-referrer 会让浏览器把这两个页面的同源表单 POST 写成 `Origin: null`，
// 而服务端要求 `Origin == 自身源` ⇒ 登录与换票必然 403。
func writePage(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", mainPageReferrerPolicy)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", mainPageCSP)
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// localeOf 按请求解析语言（Accept-Language），绝不使用模块级冻结的语言。
func localeOf(r *http.Request) string {
	if r == nil {
		return "zh"
	}
	return preferredLocale(r.Header.Get("Accept-Language"))
}
