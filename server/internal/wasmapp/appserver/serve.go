package appserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/aichat"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/hostcap"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/logbuf"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// ServeApp 处理一次应用子域请求（实现 edge.AppHandler）。
//
// appLabel 由主机名门控（edge.HostGate/MatchHost）校验过**形态**：小写、单级标签、
// 长度与字符集合规。本函数不重复形态校验，但会再过一次 registry 的**业务规则**
// （保留字/纯数字/xn--/企业既有主机名）——那是纵深防御，见步骤 ①。
//
// 顺序即语义（§6.1 ④⑤）：每一步都标了设计条款，调整顺序前先读那一条。
func (s *Server) ServeApp(w http.ResponseWriter, r *http.Request, appLabel string) {
	if r == nil {
		return
	}
	// 关停期：不再进入编译/执行路径（wazero 的 Runtime 不能在编译中途被 Close，
	// 见 Server.Close 的注释）。503 + 可读信封，让调用方知道是平台在关停。
	if !s.beginRequest() {
		shuttingDown := apperr.New(apperr.CodeInternal, "服务正在关闭，暂不可用").
			WithHint("平台正在重启或关停；请稍后重试")
		// 503 而不是 500：这是"暂时不可用"，调用方可以重试（500 表示内部错误）。
		shuttingDown.HTTP = http.StatusServiceUnavailable
		s.writeFailure(w, r, shuttingDown, false)
		return
	}
	defer s.endRequest()

	appID := strings.ToLower(strings.TrimSpace(appLabel))

	// ===== ① 应用反查（§4.8）=====
	// 纵深防御：保留字与部署期注入的企业既有主机名**永不**作为应用服务
	//（即使库里有行）。app_id 就是域名标签，占名等于占用企业域名资产（§4.1）。
	if aerr := registry.ValidateAppID(appID, s.opt.AppIDExtraReserved); aerr != nil {
		edge.WriteAppNotFound(w, r, appID)
		return
	}
	app, err := serverstore.GetWasmAppByHost(r.Context(), s.opt.DB, appID)
	switch {
	case errors.Is(err, serverstore.ErrNotFound):
		// 未登记 ⇒ 404，**绝不回落主站**（回落会让任意未登记子域变成主站镜像=钓鱼面）。
		// kind != wasm_app 的行由 GetWasmAppByHost 的 WHERE 直接滤掉（技能/智能体同名行不会命中）。
		edge.WriteAppNotFound(w, r, appID)
		return
	case err != nil:
		// DB 故障不是"应用不存在"：按平台故障报 500（把故障说成 404 会让作者去查链接）。
		s.logf("appserver: 应用反查失败 app=%s: %v", appID, err)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"), false)
		return
	}
	if app == nil || app.DeletedAt != nil || app.FrozenAt != nil {
		// 软删（退役）与冻结（R37 只读快照）都停止路由：冻结期保留数据是为了导出，
		// 不是为了继续服务。
		edge.WriteAppNotFound(w, r, appID)
		return
	}
	if !app.Enabled {
		// 下架复用 apps.enabled（§6.2 明写不新增版本级状态）。
		// HTTP 码的取舍见 writeGone 的注释：410 而不是 404。
		s.writeGone(w, r, appID)
		return
	}

	// ===== ② 生效版本（§6.1 ⑤ / §8）=====
	// 生效版本 = 最新 approved 且未软删的版本。审核开关开启时，新版停在 pending
	//（线上仍旧版本），因此"最新 approved"就是线上版本，无需另判开关。
	//
	// ⚠️ 这里取的是**不含制品字节**的元数据（P0-3，2026-09-19）：模块缓存命中
	//（暖机常态）时 rel.Wasm 没有任何读者，用全列查询等于每请求从 PG 拉一份
	// ≤32 MiB 的 TOAST 大字段再丢掉（默认档 32 并发下瞬时堆约 1 GiB，而 §4.3 的
	// 四笔账里没有这一笔）。字节在**冷编译**那一刻按需加载 —— 见 serveWasm 的
	// acquire 回调与 loadReleaseWasm。
	rel, rerr := serverstore.LatestApprovedWasmReleaseMeta(r.Context(), s.opt.DB, appID)
	switch {
	case errors.Is(rerr, serverstore.ErrNotFound):
		s.writeHTMLFailure(w, r, http.StatusNotFound, apperr.CodeNotFound,
			"应用还没有可用版本",
			"该应用已登记，但还没有审核通过的版本，暂时无法访问。",
			[]string{"请应用发布者发布一个版本；发布成功后这里即可访问"})
		return
	case rerr != nil:
		s.logf("appserver: 取生效版本失败 app=%s: %v", appID, rerr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（数据库不可达）；请稍后重试"), false)
		return
	}

	// ===== ③ 换票兑换（§6.1 ④）=====
	// 子域自身没有会话时，主站 /app-ticket 会 302 回来带一次性 code（60 s、绑 user+app）。
	// 兑换成功 ⇒ 立刻 302 到**去掉 ticket 参数**的干净 URL（票据不进地址栏/历史/Referer）。
	if r.URL != nil && r.URL.Query().Get("ticket") != "" {
		if clean, ok := s.opt.Sessions.RedeemTicket(w, r, appID); ok {
			http.Redirect(w, r, clean, http.StatusFound)
			return
		}
		// 兑换失败（过期/重放/跨应用/非 https）：票已被一次性消费（见 session.RedeemTicket），
		// 这里按"未登录"继续 —— RequiresLogin 应用会在⑤再送一次换票，不会死循环
		//（next 里已被清掉 ticket 参数）。
		s.logf("appserver: 换票未兑换 app=%s（过期/重放/跨应用/非 https）", appID)
	}

	// ===== ④ 身份（§7.1 身份契约）=====
	// 身份只有这一条来源：宿主读 host-only + HttpOnly 的应用会话 Cookie。
	// CurrentUser / SessionKey 是同一个 Resolve 的两个投影，这里一次取齐
	//（避免同一请求解析两遍应用会话），语义与 session.CurrentUser 完全一致。
	var user *abi.User
	var sessionKey string
	if id, ok := s.opt.Sessions.Resolve(r, appID); ok {
		user, sessionKey = id.User, id.SessionKey
	}

	// ===== ⑤ 准入（R24/R25）=====
	// 资源目录：抽取根由 assets 按 (appID, releaseID) 推导（§4.2），应用读到的
	// 与宿主读到的必须是同一份（应用用 assets.read("picoaide.app.json") 读自己的配置）。
	store, aerr := s.openAssets(appID, rel)
	if aerr != nil {
		s.logf("appserver: 资源目录不可用 app=%s release=%d: %v", appID, rel.ID, aerr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（该版本的资源目录缺失）；请告知应用发布者或平台管理员"), false)
		return
	}
	cfg, cerr := loadAppConfig(store)
	if cerr != nil {
		// ⚠️ 读不到/解析不了应用配置**绝不**当匿名处理：那会把 RequiresLogin 应用
		// 意外开放（发布期已经校验过的文件，线上读不到属于平台故障）。
		s.logf("appserver: 应用配置不可用 app=%s release=%d: %v", appID, rel.ID, cerr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "应用配置不可用（平台故障）").
			WithDetail("config", limits.AppConfigFileName).
			WithHint("应用配置在发布期已校验；线上读不到属于平台故障，请联系平台管理员"), false)
		return
	}
	if cfg.RequiresLogin() && user == nil {
		// R25（2026-09-18 收敛为 access 三模式）：access=login/whitelist 且未登录
		// ⇒ 302 主站换票，**只带相对路径**的 next
		//（带绝对 URL 会把"跳到哪"变成一个可被误用的输入；§4.7 的 next 白名单也只收相对路径）。
		if s.mainOriginNow() == "" {
			// BaseDomain 未配置 ⇒ 拼不出换票地址。这是部署配置错误，不能静默：
			// 静默按匿名放行 = 把要求登录的应用变成公开应用。
			s.logf("appserver: BaseDomain 未配置，无法为要求登录的应用换票 app=%s", appID)
			s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "应用子域未配置（平台故障）").
				WithHint("平台未配置应用基域，无法完成登录换票；请联系平台管理员"), false)
			return
		}
		if !secureRequest(r) {
			// 明文连接 ⇒ 票**永远**兑换不出会话（session.RedeemTicket 是 fail-closed：
			// 非 https 不签发 Secure Cookie）。若照常 302，用户会陷入
			// "换票 → 兑换失败 → 再换票" 的无限重定向（浏览器最终报重定向过多）。
			// 所以这里直接说清楚：应用子域必须 https（§4.7 / §10.4 第 49 项）。
			s.logf("appserver: 要求登录的应用收到非 https 请求 app=%s（应用子域必须 https）", appID)
			s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "应用子域必须通过 https 访问").
				WithHint("应用会话 Cookie 是 host-only + HttpOnly + Secure，明文连接下平台拒绝签发").
				WithHint("请通过 https 访问，或让前置反向代理回传 X-Forwarded-Proto: https"), false)
			return
		}
		// 跨源那一跳的**形态**按方法分流（2026-09-19 P0 的同族修复，与主站换票同一根因）：
		//
		//   - 幂等请求（GET/HEAD/OPTIONS/TRACE）：302 直接跳。导航不受 CSP 约束，
		//     302 是最省的一跳，行为与修复前完全一致。
		//   - 非幂等的普通请求（原生表单 POST 等）：**同源跳板页（200）**。
		//     原因：应用子域的 CSP（limits.AppContentSecurityPolicy）含 `form-action 'self'`，
		//     而 CSP3 的 form-action 会检查**重定向链上的每一个 URL**；这里是跨源跳转
		//     （应用子域 → 主站换票端点）⇒ 浏览器把这次提交整单拦掉
		//     （`Sending form data to 'https://<app>.<基域>/…' violates "form-action 'self'"`），
		//     服务端从未收到它，用户表现为"点了提交没反应，只有刷新（GET）才恢复"。
		//     跳板页把跨源那一跳交给页面自己（location.replace / meta refresh / 链接），
		//     三者都不受 form-action 约束 —— 因此**不放宽 CSP**。
		//   - 显式要 JSON 的请求（`/api/*`、`Accept: application/json`）：保持 302。
		//     form-action 只管原生表单提交，fetch/XHR 不受它约束；把 API 客户端改成
		//     收 HTML 跳板页反而会破坏应用的 JSON 契约（parse 失败比 CORS 报错更难查）。
		//
		// 代价（要认账）：跳板页走的是 GET 换票，**原始 POST 体不会重放** ⇒ 用户重新
		// 登录回来后需要再提交一次；页面文案已明确写出"这次提交没有被保存"。
		target := s.ticketURL(r, appID)
		if edge.IsIdempotent(r.Method) || wantsJSON(r) {
			http.Redirect(w, r, target, http.StatusFound)
			return
		}
		s.writeRedirectPage(w, r, target)
		return
	}
	// R24（用户 2026-09-18 明确保持）：平台**不做**名单校验 —— access=whitelist 的
	// 应用只是"要求登录 + 在帧里告诉应用模式是 whitelist"；已登录但不在名单里的
	// 用户照样进 wasm，由应用读自己的 whitelist 判定并返回 403（页面必须显示本人账号）。

	// ===== ⑥ 匿名限流（R35 / §4.6）=====
	// 只有匿名请求需要它：已登录请求的身份与额度边界由平台既有机制承担。
	if user == nil {
		ok, wait := s.limiter.Allow(clientIP(r, s.trustedProxies))
		if !ok {
			s.writeFailure(w, r, apperr.New(apperr.CodeRateLimited, "匿名访问过于频繁").
				WithDetail("retry_after_seconds", int(wait.Seconds())+1).
				WithHint("匿名应用按 IP 与全局限流；请稍后重试，或让应用要求登录（access 设为 login）"), false)
			return
		}
	}

	// ===== ⑦ 跨应用写防护（§4.8 / §10.4 第 44 项）=====
	// 同 eTLD+1 下 SameSite=Strict 挡不住 `<a>.<基域>` → `<b>.<基域>` 的跨源写
	//（表单 + text/plain 免预检）⇒ 非幂等方法必须 Origin == 自身源。
	// 必须在任何重定向/重写之前（本函数在 ⑤ 之后立刻做，早于静态/执行）。
	if !edge.IsIdempotent(r.Method) && !edge.CheckOrigin(r) {
		s.writeFailure(w, r, apperr.New(apperr.CodeForbidden, "跨源写请求被拒").
			WithDetail("reason", "origin_mismatch").
			WithHint("非幂等方法必须来自本应用自身的源（Origin/Referer 校验）"), false)
		return
	}

	// ===== ⑧ 请求体上限（§4.6）=====
	// 子域路由树不在主站的两个 1 MB 中间件分组里 ⇒ 必须自己实现（§4.6 原话）。
	// 先查 Content-Length（不读一个字节就能拒），再套 MaxBytesReader 兜住
	// chunked/无长度/长度撒谎的请求。
	if r.ContentLength > edge.MaxBodyBytes() {
		s.writeBodyTooLarge(w, r, r.ContentLength)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, edge.MaxBodyBytes())

	// ===== ⑨ 静态资源（§4.2 / §4.6 响应缓存）=====
	// 命中"本版本抽取出的资源"就由宿主直接服务（缓存键 app_id + version + path）；
	// 路由判定规则见 static.go 的 serveStatic 注释（含"要求登录的应用入口不直出"的特例）。
	if s.serveStatic(w, r, appID, rel, store, !cfg.RequiresLogin()) {
		return
	}

	// ===== ⑩ 交给 wasm（§6.1 ⑤）=====
	s.serveWasm(w, r, appID, rel, cfg, store, user, sessionKey)
}

// secureRequest 判定本次请求是否走加密连接（与 session 包同一口径）。
//
// 顺序：TLS ⇒ X-Forwarded-Proto（反代终止 TLS）⇒ 明文。
// 明文下平台**不签发**应用会话 Cookie（§4.7 fail-closed）—— 所以明文请求不能进换票重定向，
// 否则会形成"换票→兑换失败→再换票"的无限循环。
func secureRequest(r *http.Request) bool {
	if r == nil {
		return false
	}
	if r.TLS != nil {
		return true
	}
	proto := strings.TrimSpace(r.Header.Get("X-Forwarded-Proto"))
	if i := strings.IndexByte(proto, ','); i >= 0 {
		proto = proto[:i]
	}
	return strings.EqualFold(strings.TrimSpace(proto), "https")
}

// writeRedirectPage 写**同源跳板页**（应用会话失效 + 非幂等请求时的跨源那一跳）。
//
// 与主站换票成功后的跳板页共用**同一份实现**（`session.RedirectPage`）：三条出口
// （location.replace / meta refresh / 可见链接）、同一份中英文案表、同一套属性转义。
//
// 安全头由宿主独占函数写（§4.8）：
//   - CSP = `limits.AppContentSecurityPolicy`（含 `form-action 'self'`，**不放宽**：
//     本页没有任何表单，跨源那一跳是页面导航）；
//   - `Referrer-Policy` = `edge.HostReferrerPolicy`（same-origin）⇒ 从这里跳到主站时
//     浏览器**不带 Referer**（本页 URL 里没有票，target 的 query 里也没有票）；
//   - `Cache-Control: no-store`（带登录上下文的页面不得落缓存）。
func (s *Server) writeRedirectPage(w http.ResponseWriter, r *http.Request, target string) {
	h := w.Header()
	edge.ApplyHostSecurityHeaders(h, edge.SelfOrigin(r))
	h.Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	if r != nil && r.Method == http.MethodHead {
		return
	}
	_, _ = io.WriteString(w, session.RedirectPage(
		session.PreferredLocale(r.Header.Get("Accept-Language")),
		session.RedirectAppSessionExpired,
		target, "", ""))
}

// ticketURL 拼主站换票地址（§6.1 ①：`https://<基域>/app-ticket?app=<app_id>&next=<相对路径>`）。
//
// next **只带相对路径**（path + query，去掉 ticket 参数），且用 url.QueryEscape 编码：
// net/url 的 PathEscape 对 `&`/`=` 不转义，直接拼进 query 会被解析成额外的参数
// （`?next=/s?a=1&b=2` ⇒ next 只剩 `/s?a=1`）—— 任务书里写的 PathEscape 在这里是错的。
func (s *Server) ticketURL(r *http.Request, appID string) string {
	return s.mainOriginNow() + "/app-ticket?app=" + url.QueryEscape(appID) +
		"&next=" + url.QueryEscape(cleanRequestURI(r))
}

// cleanRequestURI 返回去掉 ticket 参数的同源相对 URL（path + query）。
func cleanRequestURI(r *http.Request) string {
	if r == nil || r.URL == nil {
		return "/"
	}
	p := r.URL.Path
	if p == "" {
		p = "/"
	}
	q := r.URL.Query()
	q.Del("ticket")
	if len(q) == 0 {
		return p
	}
	return p + "?" + q.Encode()
}

// openAssets 打开本版本的抽取资源目录（§4.2）。
func (s *Server) openAssets(appID string, rel *serverstore.WasmRelease) (*assets.Store, *apperr.Error) {
	if rel == nil {
		return nil, apperr.New(apperr.CodeInternal, "缺少生效版本信息")
	}
	return assets.Open(s.opt.DataRoot, appID, releaseAssetID(rel))
}

// releaseAssetID 返回版本资源目录名。
//
// 抽取目录是 `<data_root>/apps/<app_id>/assets/<release_id>/`（§4.2）。目录名的
// **约定**是发布期的抽取目录列（assets_dir）：可能写目录名，也可能写路径
// （含绝对路径），因此统一取 basename；为空时回落到版本行 id（数字，天然满足
// assets 的 releaseIDPattern）。
//
// ⚠️ 跨模块约定（交付说明已标注）：发布链路（模块 E/D）必须把资源抽到
// `assets/<assets_dir 的 basename 或 release.id>/`，且**即使包里没有任何自定义段
// 也必须建出该目录**（§4.2「抽出失败 = 发布失败」）—— 否则本函数会让该应用整体 500。
func releaseAssetID(rel *serverstore.WasmRelease) string {
	if rel == nil {
		return ""
	}
	if raw := strings.TrimSpace(rel.AssetsDir); raw != "" {
		base := strings.TrimSpace(filepath.Base(raw))
		if base != "" && base != "." && base != "/" && base != ".." {
			return base
		}
	}
	return strconv.FormatInt(rel.ID, 10)
}

// loadAppConfig 读并解析 `picoaide.app.json`（§4.2 / R25）。
//
// 解析走 appcfg.Parse：它会落定 access 缺省（login）并把**旧 schema**
// （login_required/visible，已发布版本里还是旧形态）映射成 access —— 因此
// "宿主按旧配置判准入、应用按同一份文件的新 schema 判"两条口径始终一致。
//
// 为什么从资源目录读而不是用版本行的 config_json 列：应用自己是用
// `assets.read("picoaide.app.json")` 读配置的（§4.2），宿主必须与它读**同一份**，
// 否则可能出现"宿主按 access=public 放进 wasm、应用按 whitelist 拒绝"这种
// 双方各说各话的状态。资源缺失 = 平台故障 ⇒ 调用方按 500 处理（fail-loud）。
func loadAppConfig(store *assets.Store) (appcfg.Config, *apperr.Error) {
	if store == nil {
		return appcfg.Config{}, apperr.New(apperr.CodeInternal, "资源目录未打开")
	}
	_, data, err := store.Read(limits.AppConfigFileName)
	if err != nil {
		return appcfg.Config{}, apperr.New(apperr.CodeInternal, "读取应用配置失败").
			WithDetail("config", limits.AppConfigFileName).
			WithCause(err)
	}
	cfg, perr := appcfg.Parse(data)
	if perr != nil {
		return appcfg.Config{}, apperr.New(apperr.CodeInternal, "应用配置非法（发布期应已校验）").
			WithDetail("config", limits.AppConfigFileName).
			WithDetail("reason", string(perr.Code)).
			WithDetail("detail", perr.Message).
			WithCause(perr)
	}
	return cfg, nil
}

// ===== wasm 执行（步骤 ⑩）=====

// serveWasm 把请求交给 wasm 实例（§6.1 ⑤ / §4.6 / §7）。
func (s *Server) serveWasm(w http.ResponseWriter, r *http.Request, appID string,
	rel *serverstore.WasmRelease, cfg appcfg.Config, store *assets.Store, user *abi.User, sessionKey string) {

	// 读体放在**排队之前**：慢客户端不该占着执行槽（执行槽是稀缺资源，
	// 每应用并发上限见 limits.AppRuntimeConcurrency，§4.6）。
	body, aerr := readRequestBody(r)
	if aerr != nil {
		s.writeFailure(w, r, aerr, true)
		return
	}

	// 端到端墙钟 60 s（含排队等待）由本 ctx 承载；queue 只观察它，不自己造 deadline
	//（§4.6 / queue 包注释：两处各造一个 deadline 会让错误归属无法区分）。
	ctx, cancel := context.WithTimeout(r.Context(), limits.RequestWallClock)
	defer cancel()

	ticket, aerr := s.scheduler.Acquire(ctx, appID, userIDOf(user))
	if aerr != nil {
		// 队列满 / 用户占槽超限 / 排队期间墙钟到点：429 + Retry-After（§7.4）。
		s.writeFailure(w, r, aerr, false)
		return
	}
	defer ticket.Release()

	// 编译模块缓存：键含 (app_id, version, release_id)，避免任何"版本回滚后拿到旧字节"的可能。
	//
	// 回调**只在缓存未命中（冷编译）时执行**：制品字节也就在那一刻按需加载
	//（P0-3）。命中时既不查 archive，也不碰 loadReleaseWasm。
	key := moduleKey{AppID: appID, Version: rel.Version, ReleaseID: rel.ID}
	mod, release, aerr := s.modules.acquire(ctx, key, func(cctx context.Context) (compiledResult, *apperr.Error) {
		full, lerr := s.loadReleaseWasm(cctx, rel)
		if lerr != nil {
			return compiledResult{}, lerr
		}
		return s.compileRelease(cctx, full)
	})
	if aerr != nil {
		s.logf("appserver: 取编译模块失败 app=%s v=%s: %v", appID, rel.Version, aerr)
		s.writeFailure(w, r, aerr, false)
		return
	}
	defer release()

	// §4.5：一应用一 driver 实例 + 一应用一连接，**跨应用不复用**。
	// 句柄池（dbpool.go）：同一应用复用同一句柄；同一句柄可被同应用的多个请求**同时**
	// 持有（2026-09-19 起并发控制下沉到 appdb：读走只读连接池、写由 writeMu 串行，
	// 见 appdb 的包注释），队列槽位只决定"同时能跑多少请求"；
	// 空闲 3 分钟或超过上限（limits.GlobalInstances）时回收；
	// 连接被污染 / 语句可能被放弃的请求结束后，句柄在 release 时（最后一个使用者）
	// 关闭重建 —— 关库前 appdb 会排空在途读者，不会抽走并发请求脚下的连接。
	handle, aerr := s.appdbs.acquire(ctx, s.opt.DataRoot, appID)
	if aerr != nil {
		s.logf("appserver: 打开应用库失败 app=%s: %v", appID, aerr)
		s.writeFailure(w, r, aerr, false)
		return
	}
	recycle := false
	// 归还顺序有讲究：**先收事务、再还句柄**（endRequest 可能回滚一个被应用遗弃的事务，
	// 若反过来，句柄可能已经被 release 关掉/回收）。defer 是后进先出，所以 endRequest
	// 要写在 release 之后。
	defer func() { s.appdbs.release(handle, recycle) }()
	db := &appDBConn{DB: handle.db, handle: handle}
	// 事务所有权收尾（见 appDBConn.endRequest）：应用在事务里结束（忘了 commit/被杀/超时）
	// 时，本请求必须把自己的持有者身份收干净 —— 否则同应用的并发请求会在看门狗
	// （appdb 的 5 s 硬超时）之前一直被 fail-closed 拒绝。
	defer db.endRequest()

	// 应用日志：每请求一个 logbuf（§5.1 的限额语义唯一实现在那个包），
	// 请求结束后由 flushAppLogs 转写到平台日志出口。
	logs := logbuf.New()
	defer s.flushAppLogs(appID, logs)

	// 宿主能力面（§5.1 封闭清单）：身份由宿主注入，应用伪造不了（§7.1 身份契约）。
	caps := &hostcap.Capabilities{
		AppID:   appID,
		Version: rel.Version,
		User:    user,
		DB:      db,
		AI:      s.ai,
		Assets:  assetsAdapter{store: store},
		Logs:    logs,
	}

	// §7.1：帧由宿主构造 —— 身份、方法、路径、查询、白名单化的头、请求体。
	env := abi.Request{
		ABI:     abi.ABIVersion,
		AppID:   appID,
		Version: rel.Version,
		Auth: abi.AuthInfo{
			// auth.mode 取自应用配置（§7.1）：**不要**从 user 是否为 nil 反推 ——
			// public 应用在用户已登录时同样是 public（反推会让应用看到 login
			// 却拿不到"名单校验"的语义）。取值只有 public/login/whitelist。
			Mode: cfg.AuthMode(),
			// Verified 表示宿主已验证身份：login/whitelist 下只有拿到身份才会进到这里；
			// 匿名（user==nil）时 Verified=false —— 应用据此就知道这不是"验证过的空用户"。
			Verified: user != nil,
		},
		User:    user,
		Method:  r.Method,
		Path:    requestPath(r),
		Query:   requestQuery(r),
		Headers: frameHeaders(r),
		Body:    string(body),
	}

	// 会话键进 ctx：ai.chat 的在手令牌按 (用户, 会话) 缓存，登出即可按会话批量吊销（§10.4 第 46 项）。
	hostCtx := aichat.WithSessionKey(ctx, sessionKey)

	started := s.now()
	res, serr := s.rt.Serve(hostCtx, mod, runtime.Request{
		Envelope: env,
		// 预算：内存页上限是 RuntimeConfig 项（0 = 与运行时一致），guest 预算默认 limits.GuestBudget
		//（数值唯一真源），仅测试注入更小的值。
		Budgets: runtime.InstanceLimits{GuestBudget: s.guestBudget},
		Funcs:   caps,
	})
	if serr != nil {
		// 装配错误（module/Funcs 为 nil 等），不是应用错误 ⇒ 500。
		s.logf("appserver: 运行时装配错误 app=%s: %v", appID, serr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用（运行时装配错误）"), false)
		return
	}
	if res == nil {
		s.logf("appserver: 运行时返回空结果 app=%s", appID)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用（运行时无结果）"), false)
		return
	}

	// 计量（§4.9）：runtime 负责 guest/宿主侧字段，本包补齐排队等待与应用库计量。
	metrics := res.Metrics
	metrics.QueueWaitMS = ticket.EnqueuedMS
	st := db.Stats()
	metrics.DBRows = st.Rows
	metrics.DBBytes = st.Bytes

	// 句柄回收判据（§11 的连接污染兜底）：请求在"可能有语句被放弃"的形态下结束
	// （超时 / 被杀 / 宿主调用超预算）时，句柄可能已被 appdb 标脏 ⇒ 下一次 release
	// 关掉重建。appDBConn 还会在 host call 层记下 statement_timeout / tx_timeout。
	if res.KillReason != nil && abandonedStatementPossible(res.KillReason.Code) {
		handle.dirty.Store(true)
	}
	recycle = handle.dirty.Load()
	if s.opt.Events != nil {
		s.opt.Events.Record(metrics)
	}

	// §7.4 硬断言：KillReason != nil ⇒ 按它的状态码与信封返回，**绝不 200**
	//（哪怕应用自己写了一帧 200 的响应）。
	if res.KillReason != nil {
		s.logf("appserver: 应用请求失败 app=%s v=%s code=%s outcome=%s elapsed=%s",
			appID, rel.Version, res.KillReason.Code, metrics.Outcome, s.now().Sub(started))
		s.writeFailure(w, r, res.KillReason, false)
		return
	}

	s.writeAppResponse(w, r, res.Response)
}

// abandonedStatementPossible 判定某个失败码是否意味着"可能有 SQL 语句被中途放弃"。
//
// 只有这三类会让 appdb 的连接处于"可能还有僵尸语句在跑"的状态（§11 V1 两层兜底）：
// 超时（guest 预算到点）、被杀（ctx 取消 / 客户端断开）、宿主调用超预算。
// 其余失败（陷阱、无响应帧、输出超限…）不涉及放弃语句，不必要地回收句柄只会白付开库代价。
func abandonedStatementPossible(code apperr.Code) bool {
	switch code {
	case apperr.CodeRuntimeTimeout, apperr.CodeModuleKilled, apperr.CodeHostCallOverBudget:
		return true
	}
	return false
}

// userIDOf 把帧内身份映射成调度器的用户键（0 = 匿名，不参与"每用户在跑"计数）。
func userIDOf(user *abi.User) int64 {
	if user == nil || user.ID <= 0 {
		return 0
	}
	return user.ID
}

// requestPath 返回进帧的路径（不含 query）。
func requestPath(r *http.Request) string {
	if r == nil || r.URL == nil || r.URL.Path == "" {
		return "/"
	}
	return r.URL.Path
}

// requestQuery 把 query 压成 map[string]string（同名取**第一个**值）。
//
// 为什么不传 []string：帧协议的类型是 map[string]string（§7.1），多值语义在应用侧
// 没有共识；取第一个值与浏览器历史行为一致，且不允许"同名多值"变成应用侧的分叉判断。
func requestQuery(r *http.Request) map[string]string {
	if r == nil || r.URL == nil {
		return map[string]string{}
	}
	q := r.URL.Query()
	// ticket 已在上游被消费/丢弃：绝不把它带进帧（帧会进 guest 内存与应用日志）。
	q.Del("ticket")
	out := make(map[string]string, len(q))
	for k, vs := range q {
		if len(vs) == 0 {
			continue
		}
		out[k] = vs[0]
	}
	return out
}

// frameHeaderAllowlist 是进帧的请求头**白名单**（§7.1「headers 只带应用需要的」）。
//
// 为什么只有这三个：
//   - `content-type` 决定应用怎么解析 body（表单/JSON）；
//   - `accept` 决定应用返回哪种表示（HTML vs JSON）；
//   - `accept-language` 决定界面语言。
//
// 为什么不带别的（每一条都是有意排除）：
//   - `cookie` / `authorization` / `proxy-authorization`：可用于调平台的**凭证**（红线 3）。
//     帧会进 guest 线性内存，可能被应用写进自己的库/日志/响应 —— 宿主的做法是让应用
//     完全不需要知道凭据存在（D3.1），因此这里连"看一眼"的机会都不给；
//   - `x-forwarded-*` / `forwarded`：泄露部署拓扑（真实客户端 IP、代理链、内网主机名）；
//   - `host` / `origin` / `referer`：跨源写防护已经由宿主在⑦完成，应用侧拿到它们只会
//     诱导作者自己写一套更弱的判断（且 Referer 可能带上主站票据参数）；
//   - `user-agent` / `sec-*` / 其余：与业务无关，需要时应用从页面自己取。
var frameHeaderAllowlist = []string{"content-type", "accept", "accept-language"}

// frameHeaderSanitizer 去掉头值里的 CR/LF（§4.8「CR/LF 中出现即拒」的同一口径）。
// net/http 在解析阶段已经拒过 CR/LF，这里只是保持"帧内头值干净"。
var frameHeaderSanitizer = strings.NewReplacer("\r", "", "\n", "")

// frameHeaders 按白名单抽取请求头（单值，取第一个）。
func frameHeaders(r *http.Request) map[string]string {
	out := make(map[string]string, len(frameHeaderAllowlist))
	if r == nil {
		return out
	}
	for _, name := range frameHeaderAllowlist {
		if v := strings.TrimSpace(r.Header.Get(name)); v != "" {
			out[name] = frameHeaderSanitizer.Replace(v)
		}
	}
	return out
}

// readRequestBody 读取应用 API 的请求体（上限 limits.AppRequestBodyMaxBytes，§4.6）。
//
// 超限 ⇒ BODY_TOO_LARGE(413) + 可读 JSON（调用方 forceJSON）：体积类错误的第一消费者
// 是 AI/客户端，必须能解析出 code 与 hints；**绝不**退化成无指向的 400 或空响应。
func readRequestBody(r *http.Request) ([]byte, *apperr.Error) {
	if r == nil || r.Body == nil {
		return nil, nil
	}
	data, err := io.ReadAll(r.Body)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			return nil, bodyTooLargeError(maxErr.Limit)
		}
		return nil, apperr.New(apperr.CodeValidation, "读取请求体失败").
			WithDetail("reason", "read_failed").
			WithHint("请重试；若持续失败请检查请求是否被中途中断")
	}
	if int64(len(data)) > limits.AppRequestBodyMaxBytes {
		// 双保险：MaxBytesReader 是唯一权威，但接口替换/包装出错时也不能放过。
		return nil, bodyTooLargeError(limits.AppRequestBodyMaxBytes)
	}
	return data, nil
}

func bodyTooLargeError(limit int64) *apperr.Error {
	return apperr.New(apperr.CodeBodyTooLarge, "请求体超过应用 API 上限").
		WithDetail("max_bytes", limits.AppRequestBodyMaxBytes).
		WithDetail("limit_used", limit).
		WithHint("应用 API 请求体上限由平台固定；大文件请走能力中心的上传通道，不要走应用 API").
		WithHint("把大请求拆小，或在宿主侧用 db.* 分页处理")
}
