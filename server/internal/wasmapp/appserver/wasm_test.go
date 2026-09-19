package appserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// assertHostSecurityHeaders 断言宿主独占的响应安全头（§4.8；含 4xx/5xx）。
func assertHostSecurityHeaders(t *testing.T, rec *httptest.ResponseRecorder, wantNoStore bool) {
	t.Helper()
	csp := rec.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "frame-ancestors 'none'") {
		t.Fatalf("宿主 CSP 不成立: %q", csp)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options 应为 nosniff，得到 %q", got)
	}
	// Referrer-Policy 必须是 same-origin，**绝不能是 no-referrer**（2026-09-19 P0）：
	// 应用自己的同源表单 POST 在 no-referrer 下会带 `Origin: null`，被 CheckOrigin
	// 全拒（应用写功能在真实浏览器里必然失败）。详见 edge.HostReferrerPolicy。
	const wantReferrer = "same-origin"
	if edge.HostReferrerPolicy != wantReferrer {
		t.Fatalf("edge.HostReferrerPolicy = %q, want %q", edge.HostReferrerPolicy, wantReferrer)
	}
	if got := rec.Header().Get("Referrer-Policy"); got != wantReferrer {
		t.Fatalf("Referrer-Policy = %q, want %q（no-referrer ⇒ 同源写请求 Origin: null ⇒ 403）",
			got, wantReferrer)
	}
	if got := rec.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("X-Frame-Options 应为 DENY，得到 %q", got)
	}
	if wantNoStore {
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("动态/错误响应必须 no-store，得到 %q", got)
		}
	}
}

// ===== 步骤⑩：正常往返 + 帧内容（§7.1）=====

// TestServe_FrameCarriesRequestFacts 钉住帧里由宿主构造的"请求事实"：
// app_id / path / query 原样进帧，身份字段来自注入的登录态。
//
// 2026-09-19 W4：旧用例（TestServe_AnonymousFrameHasNullUser）断言的
// "匿名 200 + auth.mode=public + has_user=false" 随匿名面整条删除 —— 没有身份时
// 请求根本进不到执行侧（401，见 client_test.go 的
// TestClientRequest_LoginRequiredWithoutIdentityIs401）。
func TestServe_FrameCarriesRequestFacts(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("frame")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	rec := e.get(appID, "/hello?a=1&b=2")
	if rec.Code != http.StatusOK {
		t.Fatalf("注入身份的请求应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["app_id"] != appID {
		t.Fatalf("帧内 app_id 不对: %v", body["app_id"])
	}
	if body["has_user"] != true {
		t.Fatalf("注入身份的请求帧内必须有 user，得到 %v", body["has_user"])
	}
	if body["auth_mode"] != "login" {
		t.Fatalf("access=login 的帧内 auth.mode 应为 login，得到 %v", body["auth_mode"])
	}
	if body["auth_verified"] != true {
		t.Fatalf("注入身份的帧内 auth.verified 应为 true，得到 %v", body["auth_verified"])
	}
	if body["path"] != "/hello" {
		t.Fatalf("帧内 path 不对: %v", body["path"])
	}
	query, _ := body["query"].(map[string]any)
	if query["a"] != "1" || query["b"] != "2" {
		t.Fatalf("帧内 query 不对: %v", body["query"])
	}
}

// TestServe_ClientFrameCarriesUserAndEvent 钉住两件事：注入的身份真的进了帧，
// 且计量（wasm_call_events）里带同一个 user_id（§4.9 追责底线）。
//
// 2026-09-19 W4：旧名里的 Session（应用会话）已随旧路径删除，身份唯一来源是注入。
func TestServe_ClientFrameCarriesUserAndEvent(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("private")
	e.publishApp(appSpec{appID: appID, config: loginRequiredConfig(testOwner)})

	user := e.clientUser(testOwner)

	rec := e.doClient(appID, user, http.MethodGet, "/me", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("已登录访问应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["has_user"] != true {
		t.Fatalf("已登录帧内必须有 user: %v", body)
	}
	if body["username"] != testOwner {
		t.Fatalf("帧内 username 应为 %q，得到 %v", testOwner, body["username"])
	}
	if body["auth_mode"] != "whitelist" || body["auth_verified"] != true {
		t.Fatalf("auth 字段不对: mode=%v verified=%v", body["auth_mode"], body["auth_verified"])
	}

	// 计量里必须带 user_id（§4.9：调用事件必须带 user_id，追责底线）。
	if n := e.waitForEvents(appID, 1); n < 1 {
		t.Fatal("没有落库的调用事件")
	}
	var gotUser int64
	var outcome string
	if err := e.db.QueryRow(
		`SELECT user_id, outcome FROM wasm_call_events WHERE app_id = $1 ORDER BY id DESC LIMIT 1`, appID).
		Scan(&gotUser, &outcome); err != nil {
		t.Fatalf("查调用事件: %v", err)
	}
	if gotUser != user.ID {
		t.Fatalf("调用事件的 user_id 应为 %d，得到 %d", user.ID, gotUser)
	}
	if outcome != "ok" {
		t.Fatalf("成功请求的 outcome 应为 ok，得到 %q", outcome)
	}
}

func TestServe_FrameHeadersAreAllowlisted(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("headers")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	req := clientRequestFor(t, appID, http.MethodGet, "/", "", "")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept-Language", "zh-CN")
	req.Header.Set("Accept", "application/json")
	// 下面这些**绝不能**进帧（凭证 + 部署拓扑 + 与业务无关）。
	req.Header.Set("Cookie", "picoaide_emp=secret")
	req.Header.Set("Authorization", "Bearer app-token")
	req.Header.Set("X-Forwarded-For", "203.0.113.7")
	req.Header.Set("X-Real-IP", "203.0.113.7")
	req.Header.Set("User-Agent", "probe/1.0")
	rec := e.clientDo(req, appID, e.ownerUser)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	body := decodeJSON(t, rec.Body)
	headers, _ := body["headers"].(map[string]any)
	if headers["content-type"] != "application/json" {
		t.Fatalf("content-type 应进帧，得到 %v", headers)
	}
	if headers["accept-language"] != "zh-CN" || headers["accept"] != "application/json" {
		t.Fatalf("accept / accept-language 应进帧，得到 %v", headers)
	}
	if len(headers) != len(frameHeaderAllowlist) {
		t.Fatalf("帧内头集合应恰好等于白名单（%v），得到 %v", frameHeaderAllowlist, headers)
	}
	for _, forbidden := range []string{"cookie", "authorization", "x-forwarded-for", "x-real-ip", "user-agent", "referer", "origin", "host"} {
		if _, ok := headers[forbidden]; ok {
			t.Fatalf("头 %q 不得进帧（红线 3 / 拓扑泄露）: %v", forbidden, headers)
		}
	}
	if strings.Contains(rec.Body.String(), "Bearer app-token") || strings.Contains(rec.Body.String(), "picoaide_emp=secret") {
		t.Fatal("响应体里出现了凭证字样（凭证绝不能被应用看到）")
	}
}

func TestServe_ResponseHeadersAreHostOwned(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("hostheaders")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	rec := e.get(appID, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	// 应用写的东西里：白名单外的头必须消失，宿主独占的头必须用宿主版本。
	if got := rec.Header().Get("X-Secret-Leak"); got != "" {
		t.Fatalf("白名单外的响应头必须被剥掉，得到 %q", got)
	}
	if got := rec.Header().Get("Set-Cookie"); got != "" {
		t.Fatalf("Cookie 由宿主独占（应用不得写 Set-Cookie），得到 %q", got)
	}
	if got := rec.Header().Get("Content-Disposition"); got != "" {
		t.Fatalf("Content-Disposition 仅允许 inline，attachment 必须被剥掉，得到 %q", got)
	}
	assertHostSecurityHeaders(t, rec, true)
	if got := rec.Header().Get("Content-Security-Policy"); strings.Contains(got, "unsafe-eval") {
		t.Fatalf("应用自带的 CSP 必须被宿主版本覆盖: %q", got)
	}
	if got := rec.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("应用设置的 content-type 应在白名单内生效，得到 %q", got)
	}
}

func TestServe_AppStatusCodePreserved(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("status")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})
	// echoapp 对所有路径都返回 200；这里验证"应用给的 4xx/5xx 不会被宿主改写"，
	// 用 /slow 的解析分支无法表达，故直接验证宿主写回逻辑（见 units_test.go 的
	// TestWriteAppResponse_StatusDefaultsAndClamps）。
	rec := e.get(appID, "/")
	if rec.Code != http.StatusOK {
		t.Fatalf("应用返回 200 时应原样交付，得到 %d", rec.Code)
	}
}

// ===== 步骤⑩：失败语义（§7.4 硬断言：绝不把失败报成 200）=====

func TestServe_NoResponseIs502(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("silent")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "silentapp")})

	rec := e.get(appID, "/api/x")
	if rec.Code != http.StatusBadGateway {
		t.Fatalf("无响应帧应 502，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if code := errorCodeOf(t, rec.Body); code != "RUNTIME_NO_RESPONSE" {
		t.Fatalf("错误码应为 RUNTIME_NO_RESPONSE，得到 %q", code)
	}
	assertHostSecurityHeaders(t, rec, true)

	// 调用事件必须记成失败（§4.9），且**不是** ok。
	if n := e.waitForEvents(appID, 1); n < 1 {
		t.Fatal("失败请求也必须产生调用事件")
	}
	var outcome, reason string
	if err := e.db.QueryRow(
		`SELECT outcome, reason_code FROM wasm_call_events WHERE app_id = $1 ORDER BY id DESC LIMIT 1`, appID).
		Scan(&outcome, &reason); err != nil {
		t.Fatalf("查调用事件: %v", err)
	}
	// outcome=error：RUNTIME_NO_RESPONSE 属于"应用自己结束得不对"，不是运行时主动终止
	//（runtime.outcomeFor 把 killed 留给超时/陷阱/内存/输出超限/非零退出那几类）。
	if outcome != "error" || reason != "RUNTIME_NO_RESPONSE" {
		t.Fatalf("失败事件应记 error/RUNTIME_NO_RESPONSE，得到 %s/%s", outcome, reason)
	}
}

func TestServe_TimeoutIs504(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("spin")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "spinapp")})
	// guest 预算调小只为让用例快（数值真源仍是 limits.GuestBudget）。
	e.srv.guestBudget = 300 * time.Millisecond

	start := time.Now()
	rec := e.get(appID, "/api/spin")
	elapsed := time.Since(start)
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("死循环应 504，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if code := errorCodeOf(t, rec.Body); code != "RUNTIME_TIMEOUT" {
		t.Fatalf("错误码应为 RUNTIME_TIMEOUT，得到 %q", code)
	}
	// 真正的判据是上面那个错误码：预算到点是 RUNTIME_TIMEOUT，而**墙钟**到点是
	// MODULE_KILLED（RequestWallClock 60 s）—— 两者在 HTTP 状态上都是 504，
	// 所以"码"才是"预算真的生效"的证据。
	//
	// 这里的时间上界只用于探测**挂死**（预算没生效时请求会一直占着，直到墙钟 60 s）：
	// 取 30 s 而不是 5 s，是因为该用例要做一次冷编译（--race 下实测 9 s），
	// 而编译耗时与"预算是否生效"无关。确定性来自错误码断言 + 轮询式收尾，不来自这个数字。
	if elapsed > limits.RequestWallClock/2 {
		t.Fatalf("超时请求应在预算内返回（而不是等满墙钟），实际耗时 %s", elapsed)
	}
}

func TestServe_BrokenModuleCompileFailsClosed(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("broken")
	// 发布期本应拦下这种字节（这里直接构造库里的坏制品，验证执行侧 fail-closed）。
	e.publishApp(appSpec{appID: appID, wasm: []byte("this is not a wasm module")})

	rec := e.get(appID, "/")
	if rec.Code == http.StatusOK {
		t.Fatalf("坏制品绝不能 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("编译失败应 500，得到 %d", rec.Code)
	}
}

// ===== 步骤⑩：静态资源命中失败时交给 wasm；模块缓存复用 =====

func TestServe_MissingStaticPathGoesToWasm(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("fallthrough")
	e.publishApp(appSpec{appID: appID, config: loginConfig(),
		assets: map[string]string{"index.html": "<html>shell</html>"}})

	rec := e.get(appID, "/api/items")
	if rec.Code != http.StatusOK {
		t.Fatalf("不存在同名资源时应交给 wasm，得到 %d", rec.Code)
	}
	body := decodeJSON(t, rec.Body)
	if body["path"] != "/api/items" {
		t.Fatalf("应由 wasm 处理该路径，得到 %v", body)
	}
}

func TestServe_CompiledModuleIsCachedAcrossRequests(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("cached")
	e.publishApp(appSpec{appID: appID})

	for i := 0; i < 3; i++ {
		if rec := e.get(appID, "/api/x"); rec.Code != http.StatusOK {
			t.Fatalf("第 %d 次请求应 200，得到 %d", i+1, rec.Code)
		}
	}
	entries, bytes := e.srv.modules.size()
	if entries != 1 {
		t.Fatalf("同一 (app,version) 三次请求后缓存应恰好 1 条，得到 %d", entries)
	}
	if bytes <= 0 {
		t.Fatalf("缓存字节记账应 > 0，得到 %d", bytes)
	}
}

// ===== 关闭期排空（wazero 的 Runtime 不能在编译中途关闭）=====

func TestClose_WaitsForInFlightRequestThenRefusesNewOnes(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("drain")
	// 给模块字节追加一个自定义段：内容变了 ⇒ wazero 的磁盘编译缓存**必然未命中**，
	// 请求会真的冷编译 —— 正是最容易踩到"engine.Close 把表置 nil，而并发
	// CompileModule 对 nil map 赋值"的窗口（该 panic 实测可复现，见 Server.Close 注释）。
	e.publishApp(appSpec{appID: appID, wasm: withCustomSection(t, "echoapp", "drain-probe", []byte("x"))})
	e.srv.guestBudget = 2 * time.Second
	// 排空预算放到请求墙钟（60 s）之上：本用例要证明的是"Close 会等在途请求"，
	// 而不是"排空预算够不够"；冷编译在 --race 下实测可达 20 s+。
	// 超时路径（排空失败 ⇒ 跳过关闭）另有一条确定性单测：TestClose_SkipsWhenDrainTimesOut。
	e.srv.drainTimeout = 90 * time.Second

	done := make(chan int, 1)
	go func() { done <- e.get(appID, "/slow?ms=300").Code }()
	waitFor(t, func() bool { running, _ := e.srv.scheduler.AppStats(appID); return running > 0 },
		"请求进入执行槽（此时通常正在冷编译）")

	start := time.Now()
	if err := e.srv.Close(); err != nil {
		t.Fatalf("Close 不得因在途请求报错: %v", err)
	}
	elapsed := time.Since(start)
	if elapsed < 200*time.Millisecond {
		t.Fatalf("Close 应等待在途请求排空后再关运行时，实际只用了 %s", elapsed)
	}
	select {
	case code := <-done:
		if code != http.StatusOK {
			t.Fatalf("在途请求应正常完成，得到 %d", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("在途请求未在关闭过程中完成")
	}

	// 关闭后：新请求 503（不再进入编译/执行路径），且重复 Close 幂等。
	rec := e.get(appID, "/api/x")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("关闭后新请求应 503，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if err := e.srv.Close(); err != nil {
		t.Fatalf("重复 Close 应幂等无错: %v", err)
	}
}

// TestClose_SkipsWhenDrainTimesOut 钉死"排空失败 ⇒ 跳过关闭"这条 fail-safe。
//
// 判据是**确定性的**：用例自己在进程内登记一个永不结束的在途请求（beginRequest 是
// 包内可见的），排空预算收到 50 ms ⇒ Close 必须（a）在 50 ms 量级返回、（b）返回明确的
// "未排空"错误、（c）**不**关闭运行时（否则就与在途请求竞争）。不依赖任何编译耗时。
func TestClose_SkipsWhenDrainTimesOut(t *testing.T) {
	e := newEnv(t)
	e.srv.drainTimeout = 50 * time.Millisecond
	if !e.srv.beginRequest() {
		t.Fatal("用例前提：此时不应处于关闭中")
	}
	// 刻意不 endRequest：模拟"一个卡住的在途请求"。

	start := time.Now()
	err := e.srv.Close()
	elapsed := time.Since(start)
	if elapsed > 5*time.Second {
		t.Fatalf("排空失败应尽快返回，实际 %s", elapsed)
	}
	if err == nil || !strings.Contains(err.Error(), "未排空") {
		t.Fatalf("排空失败必须返回明确错误（关闭不完整），得到 %v", err)
	}
	// 幂等：第二次仍返回同一错误（说明确实没有关下去）。
	if err2 := e.srv.Close(); err2 == nil || !strings.Contains(err2.Error(), "未排空") {
		t.Fatalf("重复 Close 应返回同一结论，得到 %v", err2)
	}
}

// ===== services 不可达：不 panic，按平台故障回应 =====

func TestServe_DatabaseUnreachableDoesNotPanic(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("nodb")
	e.publishApp(appSpec{appID: appID})
	_ = e.db.Close() // 模拟"平台库不可达"

	rec := e.get(appID, "/api/x")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("DB 不可达应 500（不是 404，也不是 panic），得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if code := errorCodeOf(t, rec.Body); code != "INTERNAL" {
		t.Fatalf("错误码应为 INTERNAL，得到 %q", code)
	}
}

// ===== 帧字段细节 =====

func TestServe_MalformedQueryIsTolerated(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("query")
	e.publishApp(appSpec{appID: appID})
	// `%zz` 不是合法转义：net/url 的 Query() 会跳过坏对而不是 panic。
	req := clientRequestFor(t, appID, http.MethodGet, "/x?bad=%zz&ok=1", "", "")
	rec := e.clientDo(req, appID, e.ownerUser)
	if rec.Code != http.StatusOK {
		t.Fatalf("坏 query 不应让请求失败，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	query, _ := body["query"].(map[string]any)
	if query["ok"] != "1" {
		t.Fatalf("合法参数应进帧，得到 %v", query)
	}
}

func TestServe_RequestBodyIsPassedThrough(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("body")
	e.publishApp(appSpec{appID: appID})
	rec := e.post(appID, "/api/save", "application/json", `{"amount":100}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	body := decodeJSON(t, rec.Body)
	if body["body"] != `{"amount":100}` {
		t.Fatalf("请求体应原样进帧，得到 %v", body["body"])
	}
	if body["method"] != "POST" {
		t.Fatalf("方法应进帧，得到 %v", body["method"])
	}
}

// 编译期断言：帧协议的唯一真源是 abi（本文件不复制任何字段名常量）。
var _ = abi.ABIVersion

// 编译期断言：测试只引用 limits，不硬编码数值。
var _ = limits.AppRequestBodyMaxBytes
