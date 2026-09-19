package appserver

import (
	"context"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/hostcap"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/logbuf"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// serveApp 是**客户端专属访问模型**的唯一请求管线（2026-09-19 决策
// docs/decisions/2026-09-19-wasm-client-internal-origin.md）。
//
// 应用只在桌面客户端内以 `<渠道 app scheme>://<app_id>/` 打开，客户端协议 handler
// 把请求包成信封送到 `POST /api/client/v2/apps/wasm/:app_id/request`；**身份由客户端
// 注入**（它本来就持有员工 bearer）。旧的应用子域路径（换票 / 应用会话 Cookie /
// 匿名限流 / 主机名门控）已随 W4 波次整条删除 —— 因此这里没有 Cookie、没有票、
// 没有匿名分支，也不存在第二份实现。
//
// 顺序即语义（§8.1）：每一步都标了设计条款，调整顺序前先读那一条。
func (s *Server) serveApp(w http.ResponseWriter, r *http.Request, appLabel string,
	clientUser *serverstore.User, sessionKey string) {
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

	// ===== ① 应用反查（§8.1 ①）=====
	// 纵深防御：保留字与部署期注入的企业既有主机名**永不**作为应用服务
	//（即使库里有行）。app_id 曾经就是域名标签，占名等于占用企业域名资产。
	if aerr := registry.ValidateAppID(appID, s.opt.AppIDExtraReserved); aerr != nil {
		edge.WriteAppNotFound(w, r, appID, s.selfOrigin(r))
		return
	}
	app, err := serverstore.GetWasmAppByHost(r.Context(), s.opt.DB, appID)
	switch {
	case errors.Is(err, serverstore.ErrNotFound):
		// 未登记 ⇒ 404。
		// kind != wasm_app 的行由 GetWasmAppByHost 的 WHERE 直接滤掉（技能/智能体同名行不会命中）。
		edge.WriteAppNotFound(w, r, appID, s.selfOrigin(r))
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
		//
		// ⚠️ **两档，不是三档**（R2-L1-2 主控裁定 (b)，2026-09-20）：冻结 / 软删 /
		// 未登记都是 404，但只有冻结档的客户文案与下一步动作不同（「已被管理员停用，
		// 请联系管理员」）。软删与未登记**同档**：契约 §7.7② 给"已删除"的可见文案就是
		// 「应用不存在」，且 `GetWasmAppByHost` 带 `deleted_at IS NULL` ⇒ 软删行在 DAO
		// 层已返回 ErrNotFound（走上面的 `edge.WriteAppNotFound`）。原先
		// `reason = "app_deleted"` 那一支**永不可达**，留着它就是"语义已死却能被当成
		// 活契约"的依据 —— 已删；`nil` / `DeletedAt` 判定只作纵深防御，与未登记共用
		// 同一份 reason/文案。
		reason, message, hint := "app_not_found", "应用不存在", "该应用未在本平台登记或已退役；请回到应用中心刷新目录"
		if app != nil && app.FrozenAt != nil {
			reason = "app_frozen"
			message = "应用已被管理员停用（冻结）"
			hint = "冻结是只读快照：数据仍然保留，但不能继续使用；如需恢复请联系平台管理员"
		}
		s.writeFailure(w, r, apperr.New(apperr.CodeNotFound, message).
			WithDetail("reason", reason).
			WithHint(hint), false)
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

	// ===== ②b 版本头（契约 §5.1 / R1-DAT-12 / R2I-21）=====
	// 客户端的内容缓存键是 `(session-scope, app_id, version, path)`，而 version 在
	// 客户端此前**没有任何来源** ⇒ 平台在成功响应上写 `X-PicoAide-App-Version`。
	//
	// 为什么用一层薄 writer 而不是在三个成功出口（静态 304 / 静态直出 / wasm 响应）
	// 各写一遍：漏一个出口就是"某一类响应没有版本"，而缓存 bug 的形态是
	// **改版后继续发旧内容**——最难从现象反推原因的那一类。包装层统一保证
	// "status < 400 的响应一定带版本头，且应用自带的同名头被覆盖"。
	w = &versionHeaderWriter{ResponseWriter: w, version: rel.Version}

	// ===== ③ 身份（§7.1 身份契约 / §8.2）=====
	// 身份是**注入**的（客户端已持员工会话，见 client.go）：不读任何 Cookie，
	// 也不查应用会话表（那张表随旧模型一起删，见迁移 0073）。
	user := s.clientFrameUser(r.Context(), clientUser, app)

	// ===== ④ 准入（R24/R25 + 2026-09-19 契约 §4.4）=====
	// 资源目录：抽取根由 assets 按 (appID, releaseID) 推导（§4.2），应用读到的
	// 与宿主读到的必须是同一份（应用用 assets.read("picoaide.app.json") 读自己的配置）。
	//
	// ⚠️ 目录仍然**每请求打开**（三次 Lstat，实测 ≈30 µs）：它是"平台状态"断言
	// （目录缺失 = 500 平台故障），不能因为 `(app_id, release_id)` 级缓存里有字节
	// 就跳过。真正贵的三项（资源配置读盘 + 解析、资源读盘、SHA-256）走 releaseContent
	// 的缓存（R1-rt-3），命中时零读盘。
	store, aerr := s.openAssets(appID, rel)
	if aerr != nil {
		s.logf("appserver: 资源目录不可用 app=%s release=%d: %v", appID, rel.ID, aerr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "平台暂时不可用").
			WithHint("这是平台侧故障（该版本的资源目录缺失）；请告知应用发布者或平台管理员"), false)
		return
	}
	rc := s.openReleaseContent(appID, rel, store)
	cfg, cerr := rc.Config()
	if cerr != nil {
		// ⚠️ 读不到/解析不了应用配置**绝不**当匿名处理：那会把 RequiresLogin 应用
		// 意外开放（发布期已经校验过的文件，线上读不到属于平台故障）。
		s.logf("appserver: 应用配置不可用 app=%s release=%d: %v", appID, rel.ID, cerr)
		s.writeFailure(w, r, apperr.New(apperr.CodeInternal, "应用配置不可用（平台故障）").
			WithDetail("config", limits.AppConfigFileName).
			WithHint("应用配置在发布期已校验；线上读不到属于平台故障，请联系平台管理员"), false)
		return
	}
	// 准入只有一条规则：**一律要求登录**（契约 §4.4）。
	//
	// 历史配置里的 `access=public` 在读取侧即 `login`（`RequiresLogin()` 恒真，
	// 见 appcfg 的兼容读）：平台没有匿名面，`legacyAnonymous` 那条分支随旧子域路径
	// 一起删除（W4 的两段时序：W1 清语义 / W4 删代码，见 §8.4）。
	if cfg.RequiresLogin() && user == nil {
		// 客户端模式：没有浏览器换票这一跳，也不该让应用看到匿名身份
		//（R25 的语义是"要求登录"，不是"尽量登录"）⇒ 结构化 401，由客户端
		// 引导员工登录后重试。forceJSON=false：页面导航拿可读 HTML，应用内 API
		//（`/api/*` 或 Accept: application/json）拿 JSON 信封 —— 与既有口径一致。
		s.writeFailure(w, r, apperr.New(apperr.CodeAuthRequired, "该应用要求登录后使用").
			WithDetail("access", string(cfg.Access)).
			WithHint("应用只在桌面客户端内可用；请在客户端登录后重试（浏览器无法打开本应用）"), false)
		return
	}
	// R24（用户 2026-09-18 明确保持）：平台**不做**名单校验 —— access=whitelist 的
	// 应用只是"要求登录 + 在帧里告诉应用模式是 whitelist"；已登录但不在名单里的
	// 用户照样进 wasm，由应用读自己的 whitelist 判定并返回 403（页面必须显示本人账号）。

	// ===== ⑤ 跨应用写防护（§8.1 ⑦ / 契约 §4.3）=====
	// 自定义协议下浏览器**不发** Origin（契约 §3），是协议 handler 合成的 ⇒ 非幂等
	// 方法必须 `Origin == <app scheme>://<app_id>`（自身源由 app_id 推导，**绝不**
	// 从 Origin/Host 反解）。必须在任何重定向/重写之前（这里早于静态/执行）。
	if !edge.IsIdempotent(r.Method) {
		ok, reason := s.checkClientOrigin(r, appID)
		if !ok {
			// 被拒时把可观测面写进日志（Origin/Referer/Host 与自身源）：
			// "应用写请求全 403"这类故障的唯一现场，且**绝不含 Cookie**。
			s.logf("appserver: 跨源写请求被拒 app=%s reason=%s self=%q %s",
				appID, reason, s.selfOrigin(r), edge.OriginDiagFields(r))
			s.writeFailure(w, r, apperr.New(apperr.CodeForbidden, "跨源写请求被拒").
				WithDetail("reason", reason).
				WithHint("非幂等方法必须来自本应用自身的源（客户端模式下 Origin 由协议 handler 合成，"+
					"必须等于 <渠道 app scheme>://<app_id>）"), false)
			return
		}
	}

	// ===== ⑥ 请求体上限（§4.6）=====
	// 先查 Content-Length（不读一个字节就能拒），再套 MaxBytesReader 兜住
	// chunked/无长度/长度撒谎的请求。
	if r.ContentLength > edge.MaxBodyBytes() {
		s.writeBodyTooLarge(w, r, r.ContentLength)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, edge.MaxBodyBytes())

	// ===== ⑦ 静态资源（§4.2 / §4.6 响应缓存）=====
	// 命中"本版本抽取出的资源"就由宿主直接服务（缓存键 app_id + version + path）；
	// 路由判定规则见 static.go 的 serveStatic 注释。
	// `If-None-Match` 命中的 304 在缓存命中时**不读盘、不算哈希**（R1-rt-2）。
	if s.serveStatic(w, r, rel, rc, !cfg.RequiresLogin()) {
		return
	}

	// ===== ⑧ 交给 wasm（§6.1 ⑤）=====
	s.serveWasm(w, r, appID, rel, cfg, store, user, sessionKey)
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

	// ===== 应用日志（§5.1）=====
	// 每请求一个 logbuf（它的限额语义唯一实现在那个包），请求结束后由 flushAppLogs
	// 转写到平台日志出口。
	//
	// ⚠️ 刷盘必须发生在**执行槽与库句柄都归还之后**（R1-rt-6）。defer 是后进先出，
	// 所以这里**最先注册** ⇒ 最后执行。旧实现把它注册在句柄之后（LIFO 最先跑），
	// 于是 ≤100 条 × 4 KiB 的同步 stderr 写发生在**持有执行槽 + 库句柄 + 模块引用**
	// 的期间：容器 log driver 慢/磁盘满时，这段写会直接吃掉稀缺的执行槽。
	// 语义不变（仍然同步、仍然每请求一次、仍然有界），只是移出持有期。
	logs := logbuf.New()
	defer s.flushAppLogs(appID, logs)

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

	// 宿主能力面（§5.1 封闭清单）：身份由宿主注入，应用伪造不了（§7.1 身份契约）。
	// ⚠️ `ai.chat` 已随 §21 彻底删除：服务端 wasm **不再具备任何 AI 能力**，
	// 应用要调模型必须走"前端 JS → 宿主保留路径 `/__picoaide/ai/chat` → 结果回传 wasm"
	// （客户端 AI loop，见总纲 §21.2）。因此能力面里没有 AI 字段。
	caps := &hostcap.Capabilities{
		AppID:   appID,
		Version: rel.Version,
		User:    user,
		DB:      db,
		Assets:  assetsAdapter{store: store},
		Logs:    logs,
	}

	// §7.1：帧由宿主构造 —— 身份、方法、路径、查询、白名单化的头、请求体。
	//
	// auth.mode 的取值口径（2026-09-19 契约 §4.4）：`access` 在读取侧收敛为
	// login|whitelist（历史 public 即 login，AuthMode 已如此映射）；平台没有匿名面，
	// 因此帧里不会出现 public（旧子域路径的匿名分支随 W4 删除）。
	authMode := cfg.AuthMode()
	env := abi.Request{
		ABI:     abi.ABIVersion,
		AppID:   appID,
		Version: rel.Version,
		Auth: abi.AuthInfo{
			// auth.mode 取自应用配置（§7.1）：**不要**从 user 是否为 nil 反推 ——
			// 反推会让应用看到 login 却拿不到"名单校验"的语义。
			// 取值只有 public/login/whitelist；平台不再产生 public。
			Mode: authMode,
			// Verified 表示宿主已验证身份：login/whitelist 下只有拿到身份才会进到这里。
			Verified: user != nil,
		},
		User:    user,
		Method:  r.Method,
		Path:    requestPath(r),
		Query:   requestQuery(r),
		Headers: frameHeaders(r),
		Body:    string(body),
	}

	// ⚠️ sessionKey 不再有消费者（它过去是 `ai.chat` 在手令牌的会话维度）：
	// 服务端 AI 已删除，§21.4 的应用维度归因改由**客户端**在出站头
	// `X-Pico-App-Id` 上承担。参数保留是因为 `ServeClientRequest` 把它作为
	// 契约 §8.2 的显式传参（登出/改密后的吊销回调已随 aichat 一起消失）。
	_ = sessionKey
	started := s.now()
	res, serr := s.rt.Serve(ctx, mod, runtime.Request{
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
