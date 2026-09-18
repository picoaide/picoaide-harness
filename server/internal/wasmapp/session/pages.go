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
	ErrMethod      string
	ErrRateLimited string
	// 非 https：明确报错而不是静默下发不安全 Cookie（§10.4 第 49 项）。
	ErrInsecure string
	NoticeOut   string
	// Ticket
	TicketTitle   string
	TicketHeading string
	TicketBody    string
	TicketSubmit  string
	ErrSession    string
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
	ErrMethod:      "请求方法不被允许",
	ErrRateLimited: "登录尝试过于频繁，请稍后再试",
	ErrInsecure: "当前连接不是 HTTPS，出于安全考虑平台不会签发登录凭证。" +
		"请改用 https:// 访问本平台，或联系管理员启用 TLS。",
	NoticeOut:     "已退出登录。",
	TicketTitle:   "正在打开应用",
	TicketHeading: "正在打开应用",
	TicketBody:    "正在为你换取一次性访问凭证。若浏览器没有自动跳转，请点击下面的按钮。",
	TicketSubmit:  "继续",
	ErrSession:    "登录状态已失效，请重新登录",
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
	ErrMethod:      "Method not allowed",
	ErrRateLimited: "Too many sign-in attempts, please try again later",
	ErrInsecure: "This connection is not HTTPS, so the platform will not issue a sign-in credential. " +
		"Please use https:// or ask your administrator to enable TLS.",
	NoticeOut:     "You have been signed out.",
	TicketTitle:   "Opening application",
	TicketHeading: "Opening application",
	TicketBody:    "Exchanging a one-time access credential. If your browser does not redirect automatically, use the button below.",
	TicketSubmit:  "Continue",
	ErrSession:    "Your session has expired, please sign in again",
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
<meta name="referrer" content="no-referrer">
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
<meta name="referrer" content="no-referrer">
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
func writePage(w http.ResponseWriter, status int, body string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("Referrer-Policy", "no-referrer")
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
