// 客户端专属访问模型（2026-09-19 决策）的**服务端入口**。
//
// 决策与架构：docs/decisions/2026-09-19-wasm-client-internal-origin.md。
//
// 模型一句话：应用只在桌面客户端内可用。客户端注册的自定义协议 handler 把
// `picoaide-app://<app_id>/<path>` 上的请求，转成
// `POST /api/client/v2/apps/wasm/:app_id/request` 的 JSON 信封送给本函数；
// **身份由客户端注入**（它本来就持有员工会话），因此这里：
//
//   - 不读任何 Cookie（自定义协议下 Cookie 完全不可用，契约 §3）；
//   - 没有换票/登录页这一跳（要求登录的应用在未认证时得到结构化 401）；
//   - 其余一切（准入、静态资源、wasm 执行、Origin 校验、计量、审计）
//     与旧的应用子域路径**共用同一个 serveApp 核心** —— 不存在第二份实现。
//
// 为什么身份不是"客户端铸造的另一种令牌"：客户端持有员工 bearer，直接由平台的
// BearerAuth 认证即可，多一层应用会话只会多一份可失效的状态与一处吊销缺口；
// 应用作用域的差别（哪个应用）由路径参数 app_id 与准入判定承担。
package appserver

import (
	"context"
	"net/http"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// ClientScheme 是**默认**的客户端内部 origin scheme（契约 §1 第 1 条）。
//
// 它是**客户端与本平台之间的传输契约**：合成请求的 `URL.Scheme`（自身源的来源）、
// Origin 自源判据、以及协议 handler 的注册名必须是同一个字符串。
//
// ⚠️ 2026-09-19 渠道化之后（契约 §10 / R1-SRV-1 / R2I-9）它降级为**默认值**：
// 生产路径一律读 `Options.AppScheme`（装配期由 `channel.AppOriginScheme()` 注入），
// 本常量只在"未注入"（单元测试、本地最小装配）时生效 —— 取值与官方渠道一致，
// 因此未注入时的行为与改造前逐字节相同。**不要**在任何生产路径直接引用它。
const ClientScheme = "picoaide-app"

// PicoaideAppOrigin 返回应用的自身源（`picoaide-app://<app_id>`）。
//
// ⚠️ 同上：这是**默认 scheme** 下的构造函数，生产路径请用 `(*Server).AppOrigin`。
// 保留它是为了给默认值与文档一个可引用的名字（包外测试与装配的 fallback 也用它）。
//
// app_id 归一化规则与 registry 一致（小写）：调用方传进来的可能带空白/大写，
// 这里统一收敛；**不做**任何其它改写（不补端口、不补路径、不去 scheme）。
func PicoaideAppOrigin(appID string) string {
	return originFor(ClientScheme, appID)
}

// originFor 是 origin 组装的**唯一实现**（scheme + app_id）。
func originFor(scheme, appID string) string {
	return scheme + "://" + strings.ToLower(strings.TrimSpace(appID))
}

// appScheme 返回本部署生效的应用 origin scheme（空 ⇒ 默认值）。
func (s *Server) appScheme() string {
	if s != nil && strings.TrimSpace(s.opt.AppScheme) != "" {
		return strings.TrimSpace(s.opt.AppScheme)
	}
	return ClientScheme
}

// AppOrigin 返回应用的自身源（`<渠道 app scheme>://<app_id>`）。
//
// **唯一**的生产构造点：协议 handler 合成的 `Origin`、api 层校验信封 `host` 时的
// 规范形态、管线里的跨源写判据（checkClientOrigin）、响应安全头的自身源
// （selfOrigin）—— 四处必须逐字节一致，因此只允许有这一个实现。
// 装配层把它交给 `wasmapi.Options.AppOrigin`（api 层拿不到 *Server）。
func (s *Server) AppOrigin(appID string) string {
	return originFor(s.appScheme(), appID)
}

// ServeClientRequest 处理一次**桌面客户端协议 handler** 送来的应用请求。
//
// user 为 nil 只可能来自测试或装配错误：生产路由是 `BearerAuth` 必需的（契约 §4.1），
// 平台上不存在匿名应用请求；管线会按"要求登录"回 401 AUTH_REQUIRED。
// 调用方（internal/wasmapp/api 的 clientRequest handler）负责：
//   - 认证（员工 bearer）与账号可用性（审计账号被拒）；
//   - 信封校验（方法/路径/Host 形态/头白名单/体积）；
//   - 把本函数的响应（状态 + 头 + 体）编码回协议 handler。
//
// sessionKey 是**会话键**（契约 §8.2 / R1-SRV-5），由调用方显式传参
// （= `serverstore.TokenHash(bearer)[:32]`），不用 context 传递。
//
// ⚠️ 2026-09-19 W4：服务端 `ai.chat` 已随总纲 §21 彻底删除 ⇒ **服务端不再有任何
// 在手令牌**，会话键的原始消费者（`aichat` 的按会话吊销）与四处吊销回调一并消失。
// 参数保留的理由只有两条，都是契约事实而不是习惯：①§8.2 冻结了这条显式传参的签名
// （客户端与本机代理按它实现，改签名要跨端同批）；②`serverauth.SessionKey` 仍是
// "吊销侧与请求侧同源"的唯一实现，删掉参数就会让它失去调用方（见 §8.2 的注释）。
// 服务端侧**不再读它做任何判定**（归因改由客户端出站头 `X-PicoAppId` 承担，§21.4）。
//
// 本函数只做"身份投影 + 进入共用管线"，任何准入/执行语义都不在这里重复。
func (s *Server) ServeClientRequest(w http.ResponseWriter, r *http.Request, appID string, user *serverstore.User, sessionKey string) {
	if r == nil {
		return
	}
	s.serveApp(w, r, appID, user, sessionKey)
}

// selfOrigin 返回本请求的**自身源**（响应安全头与跨源写判据的共同输入）。
//
// 唯一来源 = `app_id` + 本部署生效的 scheme（`Options.AppScheme`，渠道参数化）：
// 合成请求的 `URL.Scheme = <app scheme>`，Host = app_id。
//
// ⚠️ W4 之后这里**不再有 http(s) 分支**：旧的应用子域路径（身份由请求 Host 推导、
// 自身源走 `edge.SelfOrigin`）已随总纲 §8.4 整条删除。`edge.SelfOrigin` 只认
// http/https（TLS / X-Forwarded-Proto 判定），对合成请求会算出 `http://<app_id>`
// —— 一个**错的**源；`limits.AppContentSecurityPolicy(selfOrigin)` 今天忽略该参数
// （CSP 里写的是 `'self'`，由浏览器按页面 origin 解析）所以过去不显错，但那是颗
// 定时炸弹：任何"让 CSP 插值 / 拿它做比较或日志"的改动都会踩上。
func (s *Server) selfOrigin(r *http.Request) string {
	if r == nil {
		return ""
	}
	host := r.Host
	if host == "" && r.URL != nil {
		host = r.URL.Host
	}
	return s.AppOrigin(host)
}

// checkClientOrigin 是客户端专属模型下的跨源写防护（契约 §4.3）。
//
// 实测（契约 §3）：自定义协议下的请求**不带** Origin / Referer / Sec-Fetch-*。
// 因此协议 handler 必须合成 `Origin: <app scheme>://<app_id>`，而平台在这里
// 要求非幂等请求的 Origin 存在且等于**由 app_id 推导**的自身源
// （app_id 来自路由路径，绝不从 Origin/Host 反解）。
//
// 返回值第二项是**判据名**（沿用 edge 的既有口径，便于日志与测试对齐）：
// nil_request / origin_and_referer_missing / origin_malformed / origin_mismatch。
// 幂等请求（GET/HEAD/OPTIONS/TRACE）不做这项校验，与 edge.IsIdempotent 同一口径。
//
// 形态闸复用 edge.IsOriginShaped（拒绝 `null`、路径、查询、userinfo 这类非源形态），
// **不复制**一份形态判据。归一化只做自定义协议这一层（小写 + 去一个尾部斜杠）：
// edge.NormalizeOrigin 只认 http/https，自定义协议走它必然得空串 —— 而且 http(s)
// 形态在这里的结论是确定的：客户端页面不是 http(s) 源 ⇒ 一律跨源。
func (s *Server) checkClientOrigin(r *http.Request, appID string) (bool, string) {
	if r == nil {
		return false, "nil_request"
	}
	if edge.IsIdempotent(r.Method) {
		return true, ""
	}
	raw := strings.TrimSpace(r.Header.Get("Origin"))
	if raw == "" {
		// 浏览器两个都不发；这里保持"两者都缺即拒"的判据名不变（Referer 兜底分支
		// 在客户端模式下不可达：handler 保证 Origin 存在，缺失只可能是伪造/漏补）。
		return false, "origin_and_referer_missing"
	}
	if !edge.IsOriginShaped(raw) {
		return false, "origin_malformed"
	}
	if edge.NormalizeOrigin(raw) != "" {
		// 是个合法的 http(s) 源 ⇒ 一定不是本应用的源（客户端协议不是 http(s)）。
		return false, "origin_mismatch"
	}
	if normalizeCustomOrigin(raw) != s.AppOrigin(appID) {
		return false, "origin_mismatch"
	}
	return true, ""
}

// normalizeCustomOrigin 归一化**自定义协议**的源：小写 scheme + 小写 host + 去一个尾部斜杠。
//
// 只做"同一源的等价形态"归一（大小写、一个尾部斜杠），**不**做任何"截到源"的操作 ——
// `picoaide-app://other/x`、`picoaide-app://demo:8080`、`user@demo` 这类形态要么被
// edge.IsOriginShaped 拦下，要么归一化后与期望值不等（见 checkClientOrigin 的用例表）。
func normalizeCustomOrigin(raw string) string {
	s := strings.TrimSuffix(strings.TrimSpace(raw), "/")
	i := strings.Index(s, "://")
	if i <= 0 {
		return ""
	}
	scheme := strings.ToLower(strings.TrimSpace(s[:i]))
	host := strings.ToLower(strings.TrimSpace(s[i+3:]))
	if scheme == "" || host == "" {
		return ""
	}
	return scheme + "://" + host
}

// clientFrameUser 把员工行投影成帧内身份（§7.1 身份契约）。
//
// 字段与 session.resolveAppSession 的投影**逐字一致**（username / display_name /
// 部门 / is_publisher）—— 同一份身份契约不允许因为"从哪条路进来"而不同；
// 两条路的一致性由 client_test.go 的对拍用例钉住（旧路径在 W4 波次删除后，
// 这份投影就是唯一实现）。
//
// app 为 nil（不该发生：调用前已反查过应用）时 IsPublisher 恒 false —— 宁可少给
// 一个展示位，也不猜。
func (s *Server) clientFrameUser(ctx context.Context, u *serverstore.User, app *serverstore.WasmApp) *abi.User {
	if u == nil {
		return nil
	}
	out := &abi.User{ID: u.ID, Username: u.Username, DisplayName: u.DisplayName}
	if s.opt.DB != nil {
		// 展示名与部门：一次查询取齐（与 resolveAppSession 同 SQL 投影）。
		// 失败不阻断请求：展示名/部门只影响应用内的显示（§15.1 第 10 条），
		// 身份本身（ID/Username）已经由 BearerAuth 验证过。
		var display, dept string
		err := s.opt.DB.QueryRowContext(ctx, `SELECT COALESCE(u.display_name, ''),
				COALESCE((SELECT g.name FROM user_groups ug JOIN groups g ON g.id = ug.group_id
					WHERE ug.user_id = u.id ORDER BY g.name LIMIT 1), '')
			FROM users u WHERE u.id = $1`, u.ID).Scan(&display, &dept)
		if err == nil {
			out.DisplayName = strings.TrimSpace(display)
			out.Dept = dept
		}
	}
	if app != nil && app.Owner != "" {
		out.IsPublisher = app.Owner == u.Username
	}
	return out
}

// versionHeaderWriter 在**成功响应**（status < 400）上补 `X-PicoAide-App-Version`。
//
// 三条语义：
//   - status < 400 才写：失败响应不该让客户端把"这一次"当成某个版本的缓存来源；
//   - 写之前**覆盖**同名头：版本是平台事实，应用不得自称版本（与安全头同一条纪律，
//     见 edge.StripAppControlledHeaders 的注释）；
//   - status 缺省（未调用 WriteHeader 直接 Write）= 200 ⇒ 仍要带版本头。
//
// 只实现 http.ResponseWriter：它只包 `clientCaptureWriter`（纯 ResponseWriter），
// 不存在可选接口被吞掉的问题 —— 见 serveApp 里包装点的注释。
type versionHeaderWriter struct {
	http.ResponseWriter
	version string
	wrote   bool
}

func (w *versionHeaderWriter) WriteHeader(status int) {
	w.wrote = true
	if status < http.StatusBadRequest && w.version != "" {
		w.Header().Set(edge.AppVersionHeader, w.version)
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *versionHeaderWriter) Write(p []byte) (int, error) {
	if !w.wrote {
		// 未显式写头 ⇒ 隐式 200（net/http 的缺省语义）。
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

// 编译期断言：包装器仍是 http.ResponseWriter。
var _ http.ResponseWriter = (*versionHeaderWriter)(nil)
