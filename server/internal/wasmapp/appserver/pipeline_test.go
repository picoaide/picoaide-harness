package appserver

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// ===== 步骤①：应用反查（§4.8）=====

// TestServe_ClientUnknownAppIs404 是"未登记的 app_id ⇒ 404"在**客户端路径**上的判据。
//
// 2026-09-19 W4：旧的两条 UnknownHost 用例（`TestServe_UnknownHostIs404AndNeverFallsBackToMainSite`
// 与 `TestServe_UnknownHostAPIRequestIsJSON404`）随子域路径删除 —— "unknown host"（主机名
// 门控 + 绝不回落主站）这个概念已经不存在。仍然存活的判据是"反查不到应用就不服务"，
// 因此按客户端入口重写一条：app_id 由路由参数给出，反查失败一律 404，页面形态与
// API 形态各一份（页面可读 HTML、`Accept: application/json` 拿 JSON 信封）。
func TestServe_ClientUnknownAppIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("ghost")

	rec := e.get(appID, "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("未登记的应用应 404，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := rec.Body.String()
	// 404 页面是平台自有产物：门户/管理台/任何表单都不允许出现（也不允许它变成一处跳板）。
	for _, forbidden := range []string{"PicoAide", "portal", "管理后台", "<form"} {
		if strings.Contains(body, forbidden) {
			t.Fatalf("404 页面疑似回落到平台其它页面（含 %q）: %s", forbidden, body)
		}
	}
	// 宿主安全头在 404 上同样必须写（§4.8：含 4xx/5xx）。
	assertHostSecurityHeaders(t, rec, true)
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Fatalf("页面请求应拿到 HTML 404，得到 %q", ct)
	}

	// API 形态：同一个 404 带可解析的 JSON 信封。
	apiReq := clientRequestFor(t, appID, http.MethodGet, "/api/items", "", "")
	apiReq.Header.Set("Accept", "application/json")
	apiRec := e.clientDo(apiReq, appID, e.ownerUser)
	if apiRec.Code != http.StatusNotFound {
		t.Fatalf("未登记应用的 API 请求应 404，得到 %d", apiRec.Code)
	}
	if code := errorCodeOf(t, apiRec.Body); code != "NOT_FOUND" {
		t.Fatalf("错误码应为 NOT_FOUND，得到 %q", code)
	}
}

func TestServe_ReservedLabelIs404(t *testing.T) {
	e := newEnv(t)
	// 保留字即使库里存在行也不服务（纵深防御，§4.1：保留名属于平台资产）。
	e.publishApp(appSpec{appID: "admin"})
	rec := e.get("admin", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("保留字 app_id 应 404，得到 %d", rec.Code)
	}
}

func TestServe_ExtraReservedHostIs404(t *testing.T) {
	e := newEnv(t, func(o *Options) { o.AppIDExtraReserved = []string{"intranet"} })
	e.publishApp(appSpec{appID: "intranet"})
	rec := e.get("intranet", "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("部署期注入的企业保留名应 404，得到 %d", rec.Code)
	}
}

func TestServe_DisabledAppIs410(t *testing.T) {
	e := newEnv(t)
	disabled := false
	appID := e.appID("offline")
	e.publishApp(appSpec{appID: appID, enabled: &disabled})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusGone {
		t.Fatalf("下架应用应 410，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "已下架") {
		t.Fatalf("410 页面应说明已被下架: %s", rec.Body.String())
	}
	assertHostSecurityHeaders(t, rec, true)

	// API 形态：可解析的 JSON 信封（同一个 code，状态码仍是 410）。
	req := clientRequestFor(t, appID, http.MethodGet, "/api/items", "", "")
	req.Header.Set("Accept", "application/json")
	apiRec := e.clientDo(req, appID, e.ownerUser)
	if apiRec.Code != http.StatusGone {
		t.Fatalf("下架应用的 API 请求也应 410，得到 %d", apiRec.Code)
	}
	if code := errorCodeOf(t, apiRec.Body); code != "NOT_FOUND" {
		t.Fatalf("错误码应为 NOT_FOUND（410 由 HTTP 状态表达），得到 %q", code)
	}
}

func TestServe_SoftDeletedAppIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("retired")
	e.publishApp(appSpec{appID: appID})
	if err := serverstore.SoftDeleteWasmApp(t.Context(), e.db, appID); err != nil {
		t.Fatalf("SoftDeleteWasmApp: %v", err)
	}
	if rec := e.get(appID, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("软删（退役）应用应 404（R37：退役即停止路由），得到 %d", rec.Code)
	}
}

func TestServe_FrozenAppIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("frozen")
	e.publishApp(appSpec{appID: appID, frozen: true})
	if rec := e.get(appID, "/"); rec.Code != http.StatusNotFound {
		t.Fatalf("冻结应用应 404（冻结是只读快照，不继续服务），得到 %d", rec.Code)
	}
}

// ===== 步骤②：生效版本 =====

func TestServe_NoApprovedReleaseIs404(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("pending")
	// 只有 pending 版本 ⇒ 没有生效版本（审核开关开启时线上仍旧版本；这里一个都没有）。
	e.publishApp(appSpec{appID: appID, status: serverstore.ReleaseStatusPending})
	rec := e.get(appID, "/")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("无生效版本应 404，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "还没有可用版本") {
		t.Fatalf("404 页面应说明原因: %s", rec.Body.String())
	}
}

// ===== 步骤③④：身份注入与准入 =====

// TestServe_WhitelistOutsiderStillReachesWasm 是 **R24 / A3 的核心回归网**
// （独立审计 2026-09-18 P2-3 补）。
//
// 判据（用户口径）：`access=whitelist` 只是"要求登录 + 把模式告诉应用"，
// **名单由应用自己比对** —— 平台不得自行拦截白名单外的员工。未授权请求必须
// 照常进 wasm，由应用返回它自己的 403 页面（§10.5 第 51 项：这是**非边界**）。
//
// 为什么必须单独钉一条：这条性质此前没有任何用例咬住 —— 往 appserver 里塞一条
// "白名单外一律 403"的拦截后，既有 74 个用例**全部仍然绿**（最接近的那条
// reserved-app-config 用例只断言"响应体里没有配置内容"，平台 403 同样满足）。
// 变异判据：加上那条拦截 ⇒ 本用例红。
func TestServe_WhitelistOutsiderStillReachesWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("gated")
	// 名单里只有 alice；下面用 bob 登录（"未授权员工"）。
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig("alice")})

	// 身份由客户端注入（bob 是"已登录但不在名单里"的员工）。
	rec := e.doClient(appID, e.clientUser("bob"), http.MethodGet, "/secret", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("白名单外的已登录员工必须照常进 wasm（平台不比对名单），得到 %d body=%.200s",
			rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["auth_mode"] != "whitelist" {
		t.Fatalf("帧内 auth.mode 必须是 whitelist（应用据此自己判定），得到 %v", body["auth_mode"])
	}
	// 平台只注入身份：bob 的身份必须原样在帧里（应用要用它比对名单）。
	if body["has_user"] != true || body["username"] != "bob" {
		t.Fatalf("帧内身份必须是 bob（应用靠它比对名单），得到 user=%v/%v", body["has_user"], body["username"])
	}
}

// ===== 步骤⑤：配置读不到 ⇒ 500（绝不能当匿名放行）=====

func TestServe_ConfigMissingIs500(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("noconfig")
	e.publishApp(appSpec{appID: appID, skipConfig: true})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("读不到应用配置必须 500（不能当匿名放行），得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "app_id") {
		t.Fatal("配置故障时不得进入 wasm")
	}
	if !strings.Contains(e.logs.String(), "应用配置不可用") {
		t.Fatalf("平台故障必须大声记日志，日志=%s", e.logs.String())
	}
}

func TestServe_ConfigInvalidIs500(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("badconfig")
	e.publishApp(appSpec{appID: appID, config: `{"login_required": "yes"}`})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("非法应用配置必须 500，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(e.logs.String(), "应用配置不可用") {
		t.Fatalf("非法配置必须大声记日志，日志=%s", e.logs.String())
	}
}

// TestServe_LoginModeAllowsEveryLoggedInUser 覆盖 access=login 模式
// （用户原话："登陆后使用（默认全员）"）：登录后**不看名单**，任何员工都能用。
//
// 变异方式：把 RequiresLogin() 改成"只有 whitelist 才要求登录"（login 当匿名放行）⇒
// 本用例的 200 断言会被 401 取代而红（"未注入身份 ⇒ 401"那半条在 client_test.go 的
// TestClientRequest_LoginRequiredWithoutIdentityIs401，不在这里重复）；把 AuthMode() 的
// login 分支映射成 public ⇒ 帧内 mode 断言红。
func TestServe_LoginModeAllowsEveryLoggedInUser(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("loginmode")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	// 任何员工（不在任何名单里 —— 这里根本没有名单）注入身份后都能进 wasm。
	const anyone = "bob-anyone"
	rec := e.doClient(appID, e.clientUser(anyone), http.MethodGet, "/", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("access=login 登录后应 200（登录后全员可用），得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["auth_mode"] != "login" || body["auth_verified"] != true {
		t.Fatalf("帧内 auth 不对: mode=%v verified=%v", body["auth_mode"], body["auth_verified"])
	}
	if body["username"] != anyone {
		t.Fatalf("帧内 username = %v, want %q", body["username"], anyone)
	}
}

// TestServe_LegacySchemaConfigStillWorks 守住**兼容 shim 的端到端**：
// 已发布版本的随包 `picoaide.app.json` 还是旧 schema（`login_required` / `visible`），
// 迁移 0071 只改写库里的 config_json，**随包资产是发布期快照、永远可能是旧的** ——
// 平台升级后老应用必须照旧运行（映射规则见 appcfg 包注释）。
//
// 变异方式：删掉 appcfg 的旧形态映射（或让旧字段报 unknown_field）⇒ 本用例全红。
func TestServe_LegacySchemaConfigStillWorks(t *testing.T) {
	e := newEnv(t)

	// ① 旧 public：读取侧即 login（契约 §4.4：平台没有匿名面），visible=false 不再有任何过滤语义。
	//（"无身份 ⇒ 401"那半条由 client_test.go 的 TestClientRequest_LegacyPublicConfigReadsAsLogin 覆盖。）
	pub := e.appID("legacy-public")
	e.publishApp(appSpec{appID: pub, config: legacyPublicConfig()})
	rec := e.get(pub, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("旧 schema 的 public 应用对已登录员工应 200，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}
	if body := decodeJSON(t, rec.Body); body["auth_mode"] != "login" || body["has_user"] != true {
		t.Fatalf("旧 schema 的 public 应映射成 login（读取侧即 login）：mode=%v has_user=%v",
			body["auth_mode"], body["has_user"])
	}

	// ② 旧 白名单：login_required=true + 名单非空 ⇒ whitelist（要求登录）。
	white := e.appID("legacy-white")
	e.publishApp(appSpec{appID: white, config: legacyWhitelistConfig(testOwner)})
	if rec := e.doClient(white, nil, http.MethodGet, "/", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("旧 schema 的 login_required=true 应用无身份应 401，得到 %d", rec.Code)
	}
	authed := e.get(white, "/")
	if authed.Code != http.StatusOK {
		t.Fatalf("旧 schema 的白名单应用登录后应 200，得到 %d body=%.200s", authed.Code, authed.Body.String())
	}
	if body := decodeJSON(t, authed.Body); body["auth_mode"] != "whitelist" {
		t.Fatalf("旧 schema 的 login_required+名单 应映射成 whitelist，得到 %v", body["auth_mode"])
	}

	// ③ 旧"登录但名单为空"：映射成 login（新规则：登录后全员可用；旧规则本会拒发布）。
	loginApp := e.appID("legacy-login")
	e.publishApp(appSpec{appID: loginApp, config: `{"login_required":true,"whitelist":[]}`})
	if rec := e.doClient(loginApp, nil, http.MethodGet, "/", "", ""); rec.Code != http.StatusUnauthorized {
		t.Fatalf("旧 schema 的 login_required=true（空名单）无身份应 401，得到 %d", rec.Code)
	}
	ok := e.doClient(loginApp, e.clientUser("carol-outsider"), http.MethodGet, "/", "", "")
	if ok.Code != http.StatusOK {
		t.Fatalf("旧 schema 映射成 login 后，任何登录员工都该可用，得到 %d body=%.200s", ok.Code, ok.Body.String())
	}
	if body := decodeJSON(t, ok.Body); body["auth_mode"] != "login" {
		t.Fatalf("空名单的旧配置应映射成 login，得到 %v", body["auth_mode"])
	}
}

// ===== 步骤⑧：请求体上限（§4.6）=====

func TestServe_BodyTooLargeIs413JSON(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("bigbody")
	e.publishApp(appSpec{appID: appID})

	// (a) Content-Length 撒谎/超大：不读一个字节就能拒。
	big := strings.Repeat("a", limits.AppRequestBodyMaxBytes+1)
	req := clientRequestFor(t, appID, http.MethodPost, "/api/save", clientOriginOf(appID), big)
	req.Header.Set("Content-Type", "application/json")
	rec := e.clientDo(req, appID, e.ownerUser)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超大请求体应 413，得到 %d", rec.Code)
	}
	if code := errorCodeOf(t, rec.Body); code != "BODY_TOO_LARGE" {
		t.Fatalf("错误码应为 BODY_TOO_LARGE（不得退化成无指向的 400），得到 %q", code)
	}

	// (b) 无 Content-Length（chunked 形态）：MaxBytesReader 必须兜住。
	req2 := clientRequestFor(t, appID, http.MethodPost, "/api/save", clientOriginOf(appID), "")
	req2.Body = io.NopCloser(&endlessReader{})
	req2.ContentLength = -1
	req2.Header.Set("Content-Type", "application/json")
	if req2.ContentLength >= 0 {
		t.Fatalf("该用例要求 ContentLength 未知，得到 %d", req2.ContentLength)
	}
	rec2 := e.clientDo(req2, appID, e.ownerUser)
	if rec2.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("无长度声明的超大请求体应 413，得到 %d body=%s", rec2.Code, rec2.Body.String())
	}
	if code := errorCodeOf(t, rec2.Body); code != "BODY_TOO_LARGE" {
		t.Fatalf("错误码应为 BODY_TOO_LARGE，得到 %q", code)
	}
}

// endlessReader 永远产出 'a'（模拟 chunked 的超大请求体）。
type endlessReader struct{}

func (endlessReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 'a'
	}
	return len(p), nil
}

// ===== 队列（§4.6 / §10.3 第 32/33 项）=====

// TestServe_SameAppRequestsRunConcurrentlyByDefault 是用户问题 3
// （「wasm 应用怎么支持高并发，不应该是每个请求串行」）的**行为判据**。
//
// 判据（不靠"墙钟比大小"，那条在负载高时会假红）：
//  1. 默认装配下每应用并发 > 1（queue.DefaultOptions 取 limits.AppRuntimeConcurrency）；
//  2. **执行区间真的重叠**：调度器的在跑计数被**持续**观测到 == 2 —— 执行区间以
//     "持有执行槽"为准，重叠窗口 ≥ 单次 hold 的一半；
//  3. **排队等待 ≈ 0**：两个请求的 `queue_wait_ms`（平台自己的调用事件遥测）都远小于
//     单次 hold ⇒ 第二个请求不是"排队等到第一个跑完"才进的执行。
//
// ⚠️ 为什么判据不能写成"[发起,返回] 两个区间相交"（本用例第一版就是那样，已改）：
// 排队等待也算在"返回"里 —— 串行实现下第二个请求在队列里等到第一个跑完，它的区间
// 依然与第一个相交 ⇒ 那条断言**恒真**（假绿，也正因如此它在变异下抓不到问题）。
// 执行区间必须以"真的持有执行槽"为准（判据 2），并用队列遥测排除"等待造成的假重叠"（判据 3）。
//
// 墙钟只作**观测值**打印（并发时 ≈ 单次耗时，串行时 ≈ 两次之和）。
// 变异验证：把 limits.AppRuntimeConcurrency 改回 1 ⇒ 本用例必红（判据 1 先红；
// 把判据 1 的守卫摘掉后判据 2/3 也必红，已实测）。
//
// ⚠️ 两个请求必须注入**两个不同员工**（2026-09-19 W4 起身份一律注入）：队列还有一条
// §4.6 的"单用户同应用同时运行数 = 1"（limits.UserPerAppRunning），同一员工的两次并发
// 请求会被它**按设计**串行 —— 那不是本用例要测的东西。这里测的是**每应用**并发。
func TestServe_SameAppRequestsRunConcurrentlyByDefault(t *testing.T) {
	e := newEnv(t) // 不注入 Scheduler：要测的正是**默认配置**
	appID := e.appID("concurrent")
	e.publishApp(appSpec{appID: appID})

	perApp := e.srv.scheduler.Options().PerAppRunning
	if perApp < 2 {
		t.Fatalf("默认每应用并发 = %d，必须 > 1（否则默认部署下同应用仍是串行）", perApp)
	}
	users := []*serverstore.User{e.ownerUser, e.clientUser("bob-conc")}
	if got := e.srv.scheduler.Options().PerUserPerAppRunning; got != 1 {
		t.Fatalf("用例前提：单用户同应用并发应为 1（§4.6），得到 %d", got)
	}

	const holdMS = 600
	hold := holdMS * time.Millisecond
	start := make(chan struct{})
	type span struct {
		begin, end time.Time
		code       int
		body       string
	}
	spans := make([]span, 2)
	var wg sync.WaitGroup
	// done 用原子计数（采样 goroutine 不读 spans：那些字段由各自的请求 goroutine 写，
	// 跨 goroutine 读会撞 -race，而"谁写谁读"在这里并不需要）。
	var done int32
	for i := range spans {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start // 屏障：两个请求尽量同时出发
			spans[i].begin = time.Now()
			rec := e.doClient(appID, users[i], http.MethodGet, "/slow?ms="+strconv.Itoa(holdMS), "", "")
			spans[i].code = rec.Code
			spans[i].body = rec.Body.String()
			spans[i].end = time.Now()
			atomic.AddInt32(&done, 1)
		}(i)
	}
	// 采样执行槽水位：running == 2 的**持续窗口**就是两个请求执行区间的重叠部分；
	// waiting 则用来证明"没有谁在排队等对方跑完"（串行实现下第二个请求会在队列里
	// 待满第一个请求的执行时长）。
	maxRunning := 0
	maxWaiting := 0
	overlapSamples := 0
	var firstOverlap, lastOverlap time.Time
	pollDone := make(chan struct{})
	go func() {
		defer close(pollDone)
		deadline := time.Now().Add(30 * time.Second)
		for time.Now().Before(deadline) {
			running, waiting := e.srv.scheduler.AppStats(appID)
			if waiting > maxWaiting {
				maxWaiting = waiting
			}
			if running >= 2 {
				now := time.Now()
				overlapSamples++
				if firstOverlap.IsZero() {
					firstOverlap = now
				}
				lastOverlap = now
				if running > maxRunning {
					maxRunning = running
				}
			}
			if atomic.LoadInt32(&done) == int32(len(spans)) {
				return
			}
			time.Sleep(time.Millisecond)
		}
	}()
	close(start)
	wg.Wait()
	<-pollDone

	for i, s := range spans {
		if s.code != http.StatusOK {
			t.Logf("平台日志:\n%s", e.logs.String())
			t.Fatalf("第 %d 个请求应 200，得到 %d body=%s", i, s.code, s.body)
		}
	}
	overlapSpan := lastOverlap.Sub(firstOverlap)
	d0 := spans[0].end.Sub(spans[0].begin)
	d1 := spans[1].end.Sub(spans[1].begin)
	totalBegin := spans[0].begin
	if spans[1].begin.Before(totalBegin) {
		totalBegin = spans[1].begin
	}
	totalEnd := spans[0].end
	if spans[1].end.After(totalEnd) {
		totalEnd = spans[1].end
	}
	concurrentWall := totalEnd.Sub(totalBegin)

	// queue_wait_ms 只作**观测**（平台调用事件遥测，§4.9）：判据不依赖 DB 事件表
	// —— 事件写入是旁路（批量 flush），让它决定这条并发用例的红绿会把"事件链路慢"
	// 混进"请求是否并发"。主判据用调度器状态（下面的 maxWaiting）。
	var maxWaitMS int64
	if n := e.waitForEvents(appID, 2); n == 2 {
		if err := e.db.QueryRow(
			`SELECT COALESCE(MAX(queue_wait_ms), 0) FROM wasm_call_events WHERE app_id = $1`, appID).
			Scan(&maxWaitMS); err != nil {
			t.Fatalf("查 queue_wait_ms: %v", err)
		}
	} else {
		t.Logf("（观测项缺失：调用事件只落了 %d 条；事件链路的门禁在别处，这里不据此判红）", n)
	}

	t.Logf("每应用并发上限=%d；请求[发起→返回] %v / %v（含各自排队等待，**不作为判据**）；"+
		"两请求总跨度 %v；执行槽观测：max_running=%d、max_waiting=%d、重叠窗口 %v（%d 次采样）、"+
		"最大 queue_wait_ms=%d",
		perApp, d0.Round(time.Millisecond), d1.Round(time.Millisecond),
		concurrentWall.Round(time.Millisecond),
		maxRunning, maxWaiting, overlapSpan.Round(time.Millisecond), overlapSamples, maxWaitMS)

	// 判据 2：两个请求**同时持有执行槽**，且这个重叠窗口是持续的（不是采样撞上的瞬间）。
	if maxRunning < 2 || overlapSamples == 0 {
		t.Fatalf("同一应用的在跑数从未达到 2（max=%d，采样 %d 次）—— 请求没有并发进入执行",
			maxRunning, overlapSamples)
	}
	if overlapSpan < hold/2 {
		t.Fatalf("两个请求同时持槽的窗口只有 %v（< hold/2 = %v）—— 重叠是瞬时的，不构成并发执行",
			overlapSpan, hold/2)
	}
	// 判据 3：没有任何请求在队列里等对方（串行实现下第二个请求会排队待满第一个的执行时长）。
	if maxWaiting != 0 {
		t.Fatalf("该应用出现了排队（max_waiting=%d）—— 同应用请求仍被串行化", maxWaiting)
	}
	// 队列不变量：两个请求都结束后，该应用的在跑/排队都要归零。
	if r, w := e.srv.scheduler.AppStats(appID); r != 0 || w != 0 {
		t.Fatalf("drain 后 running=%d waiting=%d，want 0/0", r, w)
	}
}

func TestServe_QueueFullIs429WithRetryAfter(t *testing.T) {
	e := newEnv(t, func(o *Options) {
		// 每应用队列 1：A 在跑、B 排队（占满容量）、C 必须 429。
		//
		// PerAppRunning 显式取 1：本用例要验证的是**队列容量**这条闸门本身，
		// 与"每应用能并发几个"无关；用默认值（4）时 B 会直接拿到空槽，
		// 队列永远填不满（2026-09-19 默认值从 1 改成 4 之后本用例就是这么变的红）。
		o.Scheduler = queue.New(queue.Options{PerAppRunning: 1, PerAppQueue: 1, PerUserPerAppQueued: 1})
	})
	appID := e.appID("queue")
	e.publishApp(appSpec{appID: appID})
	// guest 预算用平台缺省（10 s）：本用例要验证的是**队列**，不是预算；
	// 收紧预算会让"应用还没跑完就被预算收掉"混进来（负载高时必现假红）。
	// A 持有执行槽 1.5 s，给"B 排队、C 被拒"留出充裕窗口。
	done := make(chan int, 2)
	go func() { done <- e.get(appID, "/slow?ms=1500").Code }()
	waitFor(t, func() bool { running, _ := e.srv.scheduler.AppStats(appID); return running > 0 },
		"第一个请求进入执行槽")
	go func() { done <- e.get(appID, "/slow?ms=1").Code }()
	waitFor(t, func() bool { return e.srv.scheduler.Stats().Waiting > 0 }, "第二个请求进入队列")

	rec := e.get(appID, "/api/slow?ms=1")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("队列满应 429，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Fatal("队列满的 429 必须带 Retry-After")
	}
	if code := errorCodeOf(t, rec.Body); code != "APP_QUEUE_FULL" {
		t.Fatalf("错误码应为 APP_QUEUE_FULL，得到 %q", code)
	}
	for i := 0; i < 2; i++ {
		select {
		case code := <-done:
			if code != http.StatusOK {
				t.Fatalf("在跑/排队的请求都应成功，得到 %d", code)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("在跑/排队的请求没有在预期时间内结束（队列唤醒失效？）")
		}
	}

	// 排队等待必须进调用事件（§4.9 queue_wait_ms）。
	// 只有 2 条：被 429 拒的第三个请求根本没进 wasm（这正是队列闸门的意义）。
	if n := e.waitForEvents(appID, 2); n != 2 {
		t.Fatalf("应有 2 条调用事件（429 的请求不产生事件），得到 %d", n)
	}
	var maxWait int64
	if err := e.db.QueryRow(
		`SELECT COALESCE(MAX(queue_wait_ms), 0) FROM wasm_call_events WHERE app_id = $1`, appID).
		Scan(&maxWait); err != nil {
		t.Fatalf("查 queue_wait_ms: %v", err)
	}
	if maxWait <= 0 {
		t.Fatalf("排队过的请求 queue_wait_ms 应 > 0，得到 %d", maxWait)
	}
}

// waitFor 轮询等待条件成立（带超时，失败即 Fatal）。
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("等待超时：%s", what)
}
