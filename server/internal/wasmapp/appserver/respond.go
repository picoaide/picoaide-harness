package appserver

import (
	"encoding/json"
	"html"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// hostOwnedResponseHeaders 是**宿主独占**的响应头（§4.8）。
//
// 应用自带的同名头一律剥离，且宿主版本一定生效（含 4xx/5xx）。
// cache-control 也在这里：§4.6 明写"动态响应一律不缓存"，而
// edge.ApplyHostSecurityHeaders 已经写好了 no-store —— 动态响应的缓存策略由宿主决定，
// 应用白名单里的 cache-control 只对**它自己**有意义（本包按设计口径降级为宿主决定）。
var hostOwnedResponseHeaders = map[string]struct{}{
	"content-security-policy":   {},
	"x-content-type-options":    {},
	"referrer-policy":           {},
	"x-frame-options":           {},
	"cache-control":             {},
	"strict-transport-security": {},
}

// writeAppResponse 把应用的最终响应帧写回客户端（§7.2 / §4.8）。
//
// 顺序与取舍：
//  1. **响应体上限**（§10.3 第 29 项）：超过 limits.AppResponseBodyMaxBytes ⇒
//     不写应用内容，改成 500 RUNTIME_OUTPUT_OVERRUN。**绝不截断后当成功**：
//     半个 JSON / 半个 HTML 只会让调用方拿到"看起来成功"的坏数据。
//  2. 宿主安全头先写（宿主独占，含错误响应）；再把应用头按白名单叠加，
//     并跳过宿主独占键（见 hostOwnedResponseHeaders）。
//  3. status 缺省 200（§7.2）；非法值（<100 或 >599）一律回落 200 —— 应用写错状态码
//     不该让宿主写出一个非法的 HTTP 响应。
func (s *Server) writeAppResponse(w http.ResponseWriter, r *http.Request, resp abi.Response) {
	if len(resp.Body) > limits.AppResponseBodyMaxBytes {
		s.writeFailure(w, r, apperr.New(apperr.CodeRuntimeOutputOverrun,
			"应用响应体超过上限（已按失败处理，未返回部分内容）").
			WithDetail("size", len(resp.Body)).
			WithDetail("max", limits.AppResponseBodyMaxBytes).
			WithHint("把大结果拆成分页接口，或让宿主侧的 db.query 做聚合/截断"), false)
		return
	}

	status := resp.Status
	if status < 100 || status > 599 {
		status = http.StatusOK
	}

	h := w.Header()
	edge.ApplyHostSecurityHeaders(h, edge.SelfOrigin(r))
	for k, v := range edge.StripAppControlledHeaders(headersFromMap(resp.Headers)) {
		if _, owned := hostOwnedResponseHeaders[strings.ToLower(k)]; owned {
			// 宿主独占：应用写了也不生效（CSP/nosniff/Referrer-Policy/缓存策略）。
			continue
		}
		h[k] = v
	}

	w.WriteHeader(status)
	if r != nil && r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, resp.Body)
}

// headersFromMap 把帧里的头（map[string]string）转成 http.Header。
func headersFromMap(m map[string]string) http.Header {
	if len(m) == 0 {
		return nil
	}
	out := make(http.Header, len(m))
	for k, v := range m {
		out.Set(k, v)
	}
	return out
}

// writeFailure 按 §7.4 / §8 把平台错误交给调用方。
//
// forceJSON=true 用于"体积类错误"：它们的第一个消费者是 AI/客户端，必须是可解析的
// JSON 信封（任务书明确要求不得退化成无指向的 400）。其余场景按请求形态选
// HTML（浏览器直访）或 JSON（/api/*、Accept: application/json）。
//
// 429 一律带 Retry-After（§4.6 / §7.4）。
func (s *Server) writeFailure(w http.ResponseWriter, r *http.Request, e *apperr.Error, forceJSON bool) {
	if e == nil {
		e = apperr.New(apperr.CodeInternal, "内部错误")
	}
	status := e.Status()

	h := w.Header()
	// 宿主安全头（含 4xx/5xx）：必须在写任何 body 之前。
	edge.ApplyHostSecurityHeaders(h, edge.SelfOrigin(r))
	if status == http.StatusTooManyRequests {
		h.Set("Retry-After", strconv.Itoa(limits.RetryAfterSeconds))
	}

	if forceJSON || wantsJSON(r) {
		h.Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(apperr.EnvelopeOf(e))
		return
	}
	h.Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, htmlErrorPage(status, string(e.Code), httpStatusTitle(status), e.Message, e.Hints))
}

// writeHTMLFailure 写一个自定义的 HTML 失败页（404/410 这类"可读页面"）。
func (s *Server) writeHTMLFailure(w http.ResponseWriter, r *http.Request, status int, code apperr.Code,
	title, message string, hints []string) {
	h := w.Header()
	edge.ApplyHostSecurityHeaders(h, edge.SelfOrigin(r))
	if wantsJSON(r) {
		h.Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(apperr.EnvelopeOf(apperr.New(code, message).WithHint(hints...)))
		return
	}
	h.Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, htmlErrorPage(status, string(code), title, message, hints))
}

// writeGone 处理"已下架"（apps.enabled=false）。
//
// # HTTP 码的取舍：410 Gone（不是 404）
//
// §6.2 只说"下架复用既有 apps.enabled"，没定 HTTP 码。本包取 **410**：
//   - 404 在本平台的语义是**"这个主机名没有登记"**（§4.8：查不到即 404、绝不回落主站，
//     目的是不泄露"某个 app_id 是否存在"，防的是钓鱼镜像与标识探测）；
//   - 下架的应用是**已登记、且访问者本来就持有链接**的资源：它对发布者是"我下架了"，
//     对使用者是"这个应用没了" —— 这两句话用 404（"请检查链接是否正确"）表达是误导，
//     会让作者去查拼写、让使用者以为是链接坏了；
//   - 410 在语义上正是"曾经存在、现已永久不可用"，且**不新增信息面**：主机名可解析
//     本身就说明有人发布过它（目录口径见 api/read.go：下架条目照样列出并带 enabled）。
//
// 响应同样带宿主安全头与 no-store（edge.ApplyHostSecurityHeaders 已写），
// 因此 410 不会被共享缓存留档。软删（deleted_at）走 404 —— 那是"退役后不再路由"（R37），
// 由步骤①的 GetWasmAppByHost 直接滤掉。
func (s *Server) writeGone(w http.ResponseWriter, r *http.Request, appID string) {
	s.writeHTMLFailure(w, r, http.StatusGone, apperr.CodeNotFound,
		"应用已下架",
		"该应用已被发布者或平台管理员下架，暂时不能访问。",
		[]string{"应用数据仍然保留；如需恢复使用，请联系应用发布者或平台管理员",
			"应用标识一经发布不能改名，恢复后链接不变"})
}

// writeBodyTooLarge 是 §4.6 请求体超限的统一出口（413 + JSON 信封）。
func (s *Server) writeBodyTooLarge(w http.ResponseWriter, r *http.Request, actual int64) {
	e := bodyTooLargeError(limits.AppRequestBodyMaxBytes)
	if actual > 0 {
		e.WithDetail("actual_bytes", actual)
	}
	// 体积类错误强制 JSON（可解析的 code + hints），见 writeFailure 注释。
	s.writeFailure(w, r, e, true)
}

// wantsJSON 判定调用方期望 JSON。
//
// 与 edge 的同名判定同口径（`/api/` 前缀或 Accept: application/json）：
// edge 的那个是包内私有，本包不能改它，故按同一规则复述一份。
// 应用子域**没有** /api/server 之类的平台路由，因此这里只需认应用自己的 API 前缀。
func wantsJSON(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/") || r.URL.Path == "/api" {
		return true
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept")), "application/json")
}

// ===== HTML 页面 =====

// htmlErrorPage 渲染一个无外链、无内联脚本的错误页（自身 CSP 下可显示）。
//
// 为什么错误页也要给 hints：§8 的第一消费者是 AI 与应用作者 —— 他们看到的是
// "哪个码 + 下一步改什么"，而不是一句"出错了"。
func htmlErrorPage(status int, code, title, message string, hints []string) string {
	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"zh-CN\"><head><meta charset=\"utf-8\">")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">")
	b.WriteString("<title>" + strconv.Itoa(status) + "</title></head>\n")
	b.WriteString("<body style=\"font-family:system-ui,-apple-system,sans-serif;margin:4rem auto;" +
		"max-width:34rem;padding:0 1rem;color:#333;line-height:1.6\">\n")
	b.WriteString("<h1 style=\"font-size:1.25rem;margin:0 0 .5rem\">" + html.EscapeString(title) + "</h1>\n")
	b.WriteString("<p style=\"color:#555;margin:0 0 1rem\">" + html.EscapeString(message) + "</p>\n")
	if code != "" {
		b.WriteString("<p style=\"color:#888;font-size:.85rem;margin:0 0 1rem\">错误码：" +
			html.EscapeString(code) + "</p>\n")
	}
	if len(hints) > 0 {
		b.WriteString("<ul style=\"color:#666;font-size:.9rem;padding-left:1.2rem\">\n")
		for _, h := range hints {
			b.WriteString("<li>" + html.EscapeString(h) + "</li>\n")
		}
		b.WriteString("</ul>\n")
	}
	b.WriteString("</body></html>")
	return b.String()
}

// httpStatusTitle 给状态码一个简短的中文标题（无对应时用"请求失败"）。
func httpStatusTitle(status int) string {
	switch status {
	case http.StatusBadRequest:
		return "请求不合法"
	case http.StatusUnauthorized:
		return "需要登录"
	case http.StatusForbidden:
		return "请求被拒绝"
	case http.StatusNotFound:
		return "页面不存在"
	case http.StatusGone:
		return "应用已下架"
	case http.StatusRequestEntityTooLarge:
		return "请求体过大"
	case http.StatusTooManyRequests:
		return "请求过于频繁"
	case http.StatusPaymentRequired:
		return "额度不足"
	case http.StatusInsufficientStorage:
		return "应用数据已满"
	case http.StatusBadGateway:
		return "应用没有返回响应"
	case http.StatusGatewayTimeout:
		return "应用执行超时"
	default:
		return "应用执行失败"
	}
}
