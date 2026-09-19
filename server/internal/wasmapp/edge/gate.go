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
// 它保证两件事（都是 allow-list 语义，而不是在庞大的主站路由表上维护"禁命中清单"
// —— 全仓 Go 代码零 host 维度判断，清单式禁命中必然漏）：
//  1. 应用子域只可能进入 Apps 分支，主站路由在子域**结构上不可达**；
//  2. 主站只在**已声明的主机名**上服务：基域本身、显式列进 ExtraMainHosts 的主机名、
//     以及无会话的编排探针（`/healthz`、`/readyz`）；其余一切主机名（任意域名、IP 直连、
//     localhost、反代别名）一律 404 —— 不回落主站（R1-sec-3：否则门户与管理台登录页
//     可被任意主机名镜像）。
type HostGate struct {
	// BaseDomain 返回**当前**应用基域（空 = 未启用应用子域，全部走主站）。
	//
	// 为什么是函数而不是字符串（2026-09-18 用户要求「管理端支持泛域名配置」）：
	// 基域从"启动期部署配置"变成了"管理端可改的运行期设置"，而门控是每请求都要
	// 判一次的地方 —— 持一份启动期快照会让"控制台改完不生效，重启才生效"。
	//
	// 语义与 MatchHost(host, "") 一致：返回空串时**一切主机名都当主站**
	// （等于没有门控），因此本门控可以无条件常挂，不需要启动期判断是否安装。
	BaseDomain func() string
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
	// **生效范围（读清楚再改）**：只看 `HostUnknown` 这一支。R1-sec-3 之后 `HostUnknown`
	// 的含义是"**一切不是本基域的主机名**"（任意其它域名、IP 直连、localhost、旧域名、
	// 反代别名、空 Host）加上"形态非法的子域"（多级标签 / 非法 label）。也就是说：
	// 主站若部署在与基域**不同**的主机名上（例如应用基域 `apps.example.com`、主站在
	// `example.com`），**必须**把那个主机名显式列进本字段，否则主站会 404。
	//
	// **`HostApp`（合法的一级标签）不受影响**：应用子域永远进应用分支，绝不回流主站
	// ——这是 §4.8 的硬规则（回落会让任何子域变成主站镜像 = 钓鱼面）。
	// 保留字主机名（`admin.<基域>` 等）走 `HostApp`，因此也不在本字段的管辖范围：
	// 它们会在 appserver 的 registry 校验层拿到 404（纵深防御）。
	ExtraMainHosts []string
}

// probePaths 是"**在任意 Host 下都必须照常可达**"的编排探针端点（见 ServeHTTP）。
//
// 为什么必须留这个例外：k8s / docker compose / systemd 的健康检查打的是 **Pod IP、
// 容器名、localhost**（`http://127.0.0.1:8080/healthz`、`http://<pod-ip>:8080/readyz`）
// ——配置了应用基域之后这些主机名既不是基域、也不是它的子域 ⇒ 属于 HostUnknown。
// 若把 404 一并施加到它们身上，编排器会把**完全健康**的实例判成挂掉并反复重启
// （"修好漏洞、弄坏编排"）。
//
// 为什么它不与 R1-sec-3 的钓鱼面冲突（两条都是事实）：
//   - 这两个端点**无会话、不接受任何凭据**（GET-only 探针），响应里没有任何用户数据、
//     没有 HTML 页面、没有可被镜像的登录表单 —— 攻击者把它们反代到自己的域名上，拿到的
//     只是"服务活着吗 / 还剩多少磁盘水位"这两个事实；
//   - 门户 `/`、`/portal`、管理台 `/admin/*`、管理登录 API `/api/server/admin/login`、
//     换票端点 `/app-ticket` 在未知主机上**全部仍然 404**（本例外按路径精确匹配这两条）。
//
// ⚠️ 与 `cmd/server/main.go` 的 `r.GET("/healthz")` / `r.GET("/readyz")` 是**同一份清单的
// 两处字面量**：新增"任意 Host 可达"的探针时必须两边同时改（`IsProbePath` 供装配层复用；
// 见报告 temp/wasm-review-r1/fix-hosthook.md 的未决项）。
var probePaths = []string{"/healthz", "/readyz"}

// IsProbePath 判定路径是否是"任意 Host 可达"的编排探针端点（probePaths 的唯一读取点）。
func IsProbePath(path string) bool {
	for _, p := range probePaths {
		if path == p {
			return true
		}
	}
	return false
}

// isProbeRequest 判定本次请求是否命中探针例外。
//
// 收紧到**幂等方法**（GET/HEAD）：探针本身就是 GET，而这两条路径的宿主端点也只在主站的
// 根引擎上注册了 GET ⇒ 收紧之后这条例外不可能被当成"任意 Host 下打主站写面"的通道
// （`POST /healthz` 在未知主机上照旧 404）。
func isProbeRequest(r *http.Request) bool {
	if r == nil || r.URL == nil {
		return false
	}
	return IsIdempotent(r.Method) && IsProbePath(r.URL.Path)
}

// currentBaseDomain 读当前基域（取值函数可能为 nil —— 早期装配/测试里只给字符串。
// nil 时返回空串，等价于"未启用子域"，绝不 panic）。
func (g *HostGate) currentBaseDomain() string {
	if g.BaseDomain == nil {
		return ""
	}
	return strings.TrimSpace(g.BaseDomain())
}

// ServeHTTP 实现 http.Handler。
func (g *HostGate) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	label, kind := MatchHost(r.Host, g.currentBaseDomain())
	switch kind {
	case HostApp:
		if g.Apps == nil {
			WriteAppNotFound(w, r, label)
			return
		}
		g.Apps.ServeApp(w, r, label)
	case HostUnknown:
		// 未知主机名（非本基域 / 形态非法的子域）：默认既不进应用也不回落主站。
		//
		// 例外一：**编排探针** `/healthz`、`/readyz`（见 probePaths 的注释 —— 探针打的是
		// Pod IP / localhost，无会话、不泄露凭据；404 掉它们等于让编排器杀掉健康实例）。
		if isProbeRequest(r) {
			g.Main.ServeHTTP(w, r)
			return
		}
		// 例外二：**显式**列进 ExtraMainHosts 的主机名（部署者明确声明"这个主机名也服务
		// 主站"，例如主站部署在基域的祖先域上）。没有这条，ExtraMainHosts 就是个死配置：
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
