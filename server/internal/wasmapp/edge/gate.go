package edge

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// AppHandler 处理一次**已通过主机名门控**的应用子域请求。
//
// 实现方职责（本包不做）：
//   - 按 appLabel 查 `apps`（kind=wasm_app）：查不到必须返回 404（Use AppNotFound）；
//   - 会话/换票、限流、准入、队列、wasm 执行、静态资源。
type AppHandler interface {
	ServeApp(w http.ResponseWriter, r *http.Request, appLabel string)
}

// HostGate 是挂在 HTTP 服务最外层的**主机名门控**（§4.8 / §15.1 第 2 条）。
//
// 它保证：应用子域只可能进入 Apps 分支，主站路由在子域**结构上不可达**。
// 这是 allow-list 语义 —— 而不是在庞大的主站路由表上维护"禁命中清单"
// （全仓 Go 代码零 host 维度判断，清单式禁命中必然漏）。
type HostGate struct {
	// BaseDomain 是应用基域（空 = 未启用应用子域，全部走主站）。
	BaseDomain string
	// Main 是主站（既有 gin 引擎）。
	Main http.Handler
	// Apps 是应用子域处理器（为 nil 时任何应用子域都 404）。
	Apps AppHandler
	// ExtraMainHosts 是**显式**指定"也当主站处理"的主机名（默认空）。
	//
	// 为什么默认空：设计明确"查不到即 404，绝不回落主站"。保留字（www/api/admin/…）
	// 默认**不**自动成为主站主机名 —— 否则 `admin.<基域>` 会渲染管理台登录页，
	// 正是 §10.1 第 13b 项要挡住的形态。需要额外主机名也服务主站的部署显式加进来。
	//
	// **生效范围（读清楚再改）**：只看 `HostUnknown`（形态非法/多级标签）这一支。
	// 命中即走主站，用于"`a.b.<基域>` 这类拿不到通配证书但企业确实在用的主机名
	// 要服务主站"这种真实部署需求。
	//
	// **`HostApp`（合法的一级标签）不受影响**：应用子域永远进应用分支，绝不回流主站
	// ——这是 §4.8 的硬规则（回落会让任何子域变成主站镜像 = 钓鱼面）。
	// 保留字主机名（`admin.<基域>` 等）走 `HostApp`，因此也不在本字段的管辖范围：
	// 它们会在 appserver 的 registry 校验层拿到 404（纵深防御）。
	ExtraMainHosts []string
}

// ServeHTTP 实现 http.Handler。
func (g *HostGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	label, kind := MatchHost(r.Host, g.BaseDomain)
	switch kind {
	case HostApp:
		if g.Apps == nil {
			WriteAppNotFound(w, r, label)
			return
		}
		g.Apps.ServeApp(w, r, label)
	case HostUnknown:
		// 形态非法（多级标签 / 非法字符）：默认既不进应用也不回落主站。
		//
		// 唯一例外是**显式**列进 ExtraMainHosts 的主机名（部署者明确声明"这个
		// 主机名也服务主站"）。没有这条，ExtraMainHosts 就是个死配置：
		// `HostMain` 本来就进主站、`HostApp` 不该被它劫走，只剩 `HostUnknown`
		// 是它唯一有意义的落点。
		if g.isExtraMainHost(r.Host) {
			g.Main.ServeHTTP(w, r)
			return
		}
		WriteAppNotFound(w, r, "")
	default:
		g.Main.ServeHTTP(w, r)
	}
}

func (g *HostGate) isExtraMainHost(host string) bool {
	if len(g.ExtraMainHosts) == 0 {
		return false
	}
	h := normalizeHost(host)
	for _, x := range g.ExtraMainHosts {
		if normalizeHost(x) == h {
			return true
		}
	}
	return false
}

// WriteAppNotFound 是应用子域上的统一 404。
//
// 两条硬要求：
//   - **绝不回落主站**（§4.8）—— 不泄露主站内容，也不泄露"这个 app_id 是否存在"；
//   - 安全头照样要写（§4.8：含 4xx/5xx）；是 API 路径时用平台 JSON 信封。
func WriteAppNotFound(w http.ResponseWriter, r *http.Request, appLabel string) {
	ApplyHostSecurityHeaders(w.Header(), SelfOrigin(r))
	if wantsJSON(r) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusNotFound)
		_ = json.NewEncoder(w).Encode(apperr.EnvelopeOf(
			apperr.New(apperr.CodeNotFound, "应用不存在").
				WithHint("请确认应用链接是否正确；应用标识一经发布不能改名")))
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusNotFound)
	_, _ = w.Write([]byte(appNotFoundHTML))
}

// wantsJSON 判定客户端期望 JSON（API 路径或显式 Accept: application/json）。
func wantsJSON(r *http.Request) bool {
	if r == nil {
		return false
	}
	if strings.HasPrefix(r.URL.Path, "/api/") {
		return true
	}
	accept := strings.ToLower(r.Header.Get("Accept"))
	return strings.Contains(accept, "application/json")
}

// appNotFoundHTML 是极简 404 页（无外链、无内联脚本，符合自身 CSP）。
const appNotFoundHTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>404</title></head>
<body style="font-family:system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1rem;color:#333">
<h1 style="font-size:1.25rem">应用不存在</h1>
<p style="color:#666">请确认链接是否正确。应用标识一经发布不能改名。</p>
</body></html>`
