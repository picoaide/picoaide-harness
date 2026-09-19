package appserver

// 客户端专属访问模型（2026-09-19 契约）的服务端判据。
//
// 变异验证（把闸门改回危险实现时，哪些用例必红）：
//   - serveApp 的 ④ 去掉 `case id.client` 分支（客户端请求回落到 Cookie 解析）
//     ⇒ TestClientRequest_InjectedIdentityReachesGuest 红（帧内没有身份）；
//   - 去掉 ⑤ 的客户端 401 分支（未登录仍走换票 302）⇒
//     TestClientRequest_LoginRequiredWithoutIdentityIs401 红（拿到 302/Location）；
//   - 让客户端路径也读 Cookie / 应用会话（把身份来源扩成"Cookie ∪ 注入"）⇒
//     TestClientRequest_AppSessionCookieIsNotIdentity 红（真会话也被当身份）；
//   - 把 ⑦ 的 checkClientOrigin 换成"缺失即放行" ⇒
//     TestClientRequest_MissingOriginOnWriteIs403 与 TestCheckClientOrigin 红；
//   - 把 checkClientOrigin 的逐字比对放开成"任意域名/任意 scheme 都算自身源" ⇒
//     TestCheckClientOrigin 与 TestClientRequest_CrossOriginWriteRejected 红；
//   - 让历史上 access=public 的配置在读取侧按"允许匿名"处理 ⇒
//     TestClientRequest_LegacyPublicConfigReadsAsLogin 红（无身份也 200）；
//   - clientFrameUser 的投影字段与 users 行分叉（少给 display_name/dept
//     或把 is_publisher 判反）⇒ TestClientFrameUser_ProjectsUserRowAndPublisherFlag 红。
//
// 2026-09-19 W4：旧子域路径（换票 / 应用会话 Cookie / 匿名面）已整条删除，
// 因此本文件不再有"Cookie 路径 vs 客户端路径"的对拍 —— 客户端路径就是唯一实现，
// 对拍对象改成 users 行 + apps.owner 这两份权威数据。

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// clientRequestFor 构造一次"客户端协议 handler 合成"的请求。
//
// 形状与 api 层 buildClientRequest 逐字一致（这是跨包契约，不是测试细节）：
// `URL.Scheme = picoaide-app`、`URL.Host = Host = <app_id>`、路径/方法/体原样。
// Origin 由协议 handler **合成**（契约 §4.3）—— 自定义协议下浏览器一个都不发。
func clientRequestFor(t *testing.T, appID, method, path, origin, body string) *http.Request {
	t.Helper()
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	req := httptest.NewRequest(method, "http://"+appID+path, strings.NewReader(body))
	req.URL.Scheme = ClientScheme
	req.URL.Host = appID
	req.Host = appID
	req.RemoteAddr = "203.0.113.9:5555"
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return req
}

// testSessionKey 是用例里的会话键（契约 §8.2：bearer SHA-256 前 16 字节 hex）。
// 用例不经过 HTTP 认证层，因此在这里显式给一个固定值 —— 它只影响 aichat 的
// "在手令牌"分桶，不影响本文件的任何判据。
const testSessionKey = "0123456789abcdef0123456789abcdef"

// doClient 走生产入口 ServeClientRequest（app_id 由调用方给，与路由参数同源）。
func (e *env) doClient(appID string, user *serverstore.User, method, path, origin, body string) *httptest.ResponseRecorder {
	e.t.Helper()
	rec := httptest.NewRecorder()
	e.srv.ServeClientRequest(rec, clientRequestFor(e.t, appID, method, path, origin, body), appID, user, testSessionKey)
	return rec
}

// clientUser 取一个真账号（已存在则复用）。
func (e *env) clientUser(username string) *serverstore.User {
	e.t.Helper()
	e.newUser(username)
	u, err := serverstore.GetUserByUsername(e.db, username)
	if err != nil || u == nil {
		e.t.Fatalf("取用户 %s 失败: %v", username, err)
	}
	return u
}

// clientOriginOf 是应用自身源（协议 handler 合成 Origin 时用的那个值）。
func clientOriginOf(appID string) string { return PicoaideAppOrigin(appID) }

// ===== ① 注入的身份必须真的进到应用帧里 =====

func TestClientRequest_InjectedIdentityReachesGuest(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-id")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	rec := e.doClient(appID, e.clientUser(testOwner), http.MethodGet, "/me", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("客户端请求应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["has_user"] != true || body["username"] != testOwner {
		t.Fatalf("帧内身份不对：%v", body)
	}
	if body["auth_verified"] != true {
		t.Fatalf("注入的身份必须 verified=true：%v", body)
	}
	if body["auth_mode"] != "login" {
		t.Fatalf("access=login 的帧内 auth.mode 必须是 login：%v", body)
	}
	// 计量里必须带 user_id（§4.9：调用事件追责底线）——与旧 Cookie 路径同一条判据。
	if n := e.waitForEvents(appID, 1); n < 1 {
		t.Fatal("没有落库的调用事件")
	}
	var gotUser int64
	if err := e.db.QueryRow(
		`SELECT user_id FROM wasm_call_events WHERE app_id = $1 ORDER BY id DESC LIMIT 1`, appID).Scan(&gotUser); err != nil {
		t.Fatalf("读调用事件失败: %v", err)
	}
	if gotUser == 0 {
		t.Fatal("注入身份的请求在调用事件里没有 user_id")
	}
}

// ===== ② 无身份 + 要求登录的应用 ⇒ 401（**不是** 302 换票）=====
//
// 两种失败渲染都要覆盖（与既有口径一致：页面导航拿可读 HTML、应用内 API 拿 JSON）：
// 协议 handler 是**透明转发**，它把 status/headers/body 原样交回 Chromium，
// 所以平台不能在页面导航上只吐 JSON。

func TestClientRequest_LoginRequiredWithoutIdentityIs401(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-login")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	// (1) API 风格（应用内 fetch/XHR）：Accept: application/json ⇒ JSON 信封 + AUTH_REQUIRED。
	req := clientRequestFor(t, appID, http.MethodGet, "/", "", "")
	req.Header.Set("Accept", "application/json")
	rec := httptest.NewRecorder()
	e.srv.ServeClientRequest(rec, req, appID, nil, testSessionKey)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未认证访问要求登录的应用应 401，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if loc := rec.Header().Get("Location"); loc != "" {
		t.Fatalf("客户端模式不得有换票跳转（Location=%q）", loc)
	}
	if code := errorCodeOf(t, rec.Body); code != "AUTH_REQUIRED" {
		t.Fatalf("错误码应为 AUTH_REQUIRED，得到 %q", code)
	}

	// (2) 页面导航风格（无 Accept / text/html）：可读 HTML 失败页，仍然 401 且无 Location。
	page := e.doClient(appID, nil, http.MethodGet, "/", "", "")
	if page.Code != http.StatusUnauthorized {
		t.Fatalf("页面风格同样必须 401，得到 %d", page.Code)
	}
	if loc := page.Header().Get("Location"); loc != "" {
		t.Fatalf("页面风格也不得跳转（Location=%q）", loc)
	}
	if ct := page.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Fatalf("页面导航应拿可读 HTML（Content-Type=%q）", ct)
	}
	if !strings.Contains(page.Body.String(), "需要登录") {
		t.Fatalf("HTML 失败页必须给出可读提示：%s", page.Body.String())
	}
}

// ===== ③ 身份只来自注入：Cookie（含旧应用会话 Cookie 的形态）不是身份 =====

func TestClientRequest_AppSessionCookieIsNotIdentity(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-cookie")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	// W4 之后**没有**任何链路能签发真的应用会话 Cookie（app_sessions 表已随迁移 0073
	// 删除），因此这里只能给"形态合法但伪造"的取值；判据本身不变：客户端模型下
	// Cookie 一律不是身份，带上它不会 200、也不会触发任何跳转。
	for name, cookie := range map[string]*http.Cookie{
		// 旧模型的应用会话 Cookie 名 + 形态合法的明文值。
		"forged": {Name: "picoaide_app", Value: "deadbeefdeadbeefdeadbeefdeadbeef", Path: "/"},
		// 员工会话 Cookie 名（旧模型里换票的输入）：同样不得被当身份。
		"employee": {Name: "picoaide_emp", Value: "deadbeefdeadbeefdeadbeefdeadbeef", Path: "/"},
	} {
		req := clientRequestFor(t, appID, http.MethodGet, "/", "", "")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		e.srv.ServeClientRequest(rec, req, appID, nil, testSessionKey)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("%s Cookie 不得当身份：应 401，得到 %d body=%s", name, rec.Code, rec.Body.String())
		}
		if loc := rec.Header().Get("Location"); loc != "" {
			t.Fatalf("%s Cookie 触发了换票跳转（Location=%q）", name, loc)
		}
	}
}

// ===== ④ 跨源写防护在客户端模式下照常生效（Origin 自源由 app_id 推导）=====

func TestClientRequest_CrossOriginWriteRejected(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-origin")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})
	user := e.clientUser(testOwner)

	// 跨应用（另一个 app_id 的源）⇒ 403。
	rec := e.doClient(appID, user, http.MethodPost, "/note", clientOriginOf("someone-else"), "v=1")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("跨应用写应 403，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	// http(s) 源（浏览器/其它页面）⇒ 同样 403：客户端协议不是 http(s)。
	rec = e.doClient(appID, user, http.MethodPost, "/note", "https://"+appID+".harness.example.com", "v=1")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("http(s) 源写应 403，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	// 自身源 ⇒ 照常通过（证明上面拒的是"来源"而不是"写"）。
	rec = e.doClient(appID, user, http.MethodPost, "/note", clientOriginOf(appID), "v=1")
	if rec.Code != http.StatusOK {
		t.Fatalf("同源写应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
}

func TestClientRequest_MissingOriginOnWriteIs403(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-noorg")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})
	user := e.clientUser(testOwner)

	// (1) 页面导航风格（无 Accept）：可读 HTML 失败页 + 403。
	rec := e.doClient(appID, user, http.MethodPost, "/note", "", "v=1")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("缺 Origin 的写请求应 403，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "跨源写请求被拒") {
		t.Fatalf("页面风格必须给可读提示：%s", rec.Body.String())
	}

	// (2) API 风格（应用内 fetch/XHR）：JSON 信封 + 机器可读的 reason。
	apiReq := clientRequestFor(t, appID, http.MethodPost, "/note", "", "v=1")
	apiReq.Header.Set("Accept", "application/json")
	apiRec := httptest.NewRecorder()
	e.srv.ServeClientRequest(apiRec, apiReq, appID, user, testSessionKey)
	if apiRec.Code != http.StatusForbidden {
		t.Fatalf("缺 Origin 的写请求应 403，得到 %d body=%s", apiRec.Code, apiRec.Body.String())
	}
	apiBody := apiRec.Body.Bytes()
	if code := errorCodeOf(t, bytes.NewReader(apiBody)); code != "FORBIDDEN" {
		t.Fatalf("错误码应为 FORBIDDEN，得到 %q", code)
	}
	var envelope struct {
		Error struct {
			Details map[string]any `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(apiBody, &envelope); err != nil {
		t.Fatalf("错误信封不是 JSON: %v", err)
	}
	if got := envelope.Error.Details["reason"]; got != "origin_and_referer_missing" {
		t.Fatalf("details.reason = %v, want origin_and_referer_missing", got)
	}

	// (3) 幂等请求不受这条约束（GET 不带 Origin 照常放行）。
	if got := e.doClient(appID, user, http.MethodGet, "/me", "", ""); got.Code != http.StatusOK {
		t.Fatalf("幂等请求不该被 Origin 判据拦住，得到 %d", got.Code)
	}
}

// TestCheckClientOrigin 是判据本体的形态表（reason 是日志与测试的公共词汇表）。
//
// 变异方式：把 `raw == ""` 分支改成"放行"⇒ 第一条红；把逐字比对改成"只比 scheme"
// 或"任意域名都行"⇒ other-host / http(s) / 端口三条红；去掉形态闸 ⇒ malformed 两条红。
func TestCheckClientOrigin(t *testing.T) {
	const appID = "demo"
	self := PicoaideAppOrigin(appID) // picoaide-app://demo
	cases := []struct {
		name   string
		method string
		origin string
		wantOK bool
		reason string
	}{
		{"幂等请求无需 Origin", http.MethodGet, "", true, ""},
		{"非幂等缺 Origin", http.MethodPost, "", false, "origin_and_referer_missing"},
		{"非幂等缺 Origin（PUT）", http.MethodPut, "", false, "origin_and_referer_missing"},
		{"自身源", http.MethodPost, self, true, ""},
		{"自身源（大小写不敏感）", http.MethodPost, "PicoAide-App://DEMO", true, ""},
		{"自身源（一个尾部斜杠）", http.MethodPost, self + "/", true, ""},
		{"跨应用", http.MethodPost, PicoaideAppOrigin("other"), false, "origin_mismatch"},
		{"任意域名", http.MethodPost, "https://evil.example", false, "origin_mismatch"},
		{"同域名的 http 源", http.MethodPost, "http://" + appID, false, "origin_mismatch"},
		{"带端口", http.MethodPost, self + ":8080", false, "origin_mismatch"},
		{"字面量 null", http.MethodPost, "null", false, "origin_malformed"},
		{"带路径", http.MethodPost, self + "/x", false, "origin_malformed"},
		// 带凭据的畸形源：形态闸只拦 host 部分的 `/?#@`（scheme 里带 @ 它看不出来），
		// 但逐字比对必然不等 ⇒ 照样拒（归类为 mismatch）。
		{"带凭据", http.MethodPost, "user@" + self, false, "origin_mismatch"},
		{"裸主机名", http.MethodPost, appID, false, "origin_malformed"},
		{"其它自定义协议", http.MethodPost, "evil-app://" + appID, false, "origin_mismatch"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "http://"+appID+"/x", nil)
			req.Host = appID
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			ok, reason := originChecker(t).checkClientOrigin(req, appID)
			if ok != tc.wantOK || reason != tc.reason {
				t.Fatalf("checkClientOrigin(%q, origin=%q) = (%v, %q), want (%v, %q)",
					tc.method, tc.origin, ok, reason, tc.wantOK, tc.reason)
			}
		})
	}
	if ok, reason := originChecker(t).checkClientOrigin(nil, appID); ok || reason != "nil_request" {
		t.Fatalf("nil 请求应判 nil_request，得到 (%v, %q)", ok, reason)
	}
}

// originChecker 返回一个**只有 scheme 配置**的最小 Server（用例只测判据本身，
// 不需要 DB/会话/运行时）。它同时钉住一条纪律：checkClientOrigin 是**方法**
// （读 Options.AppScheme）而不是包级函数 —— 渠道参数化之后，"服务端认哪个 scheme"
// 必须与装配注入的一致（R1-SRV-1/SRV-9）。
func originChecker(t *testing.T) *Server {
	t.Helper()
	return &Server{}
}

// ===== ⑤ 历史 access=public（读取侧即 login）=====

func TestClientRequest_LegacyPublicConfigReadsAsLogin(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-legacy")
	// 存量已发布版本的随包配置（appSpec 直接把这份字节写进资源目录，等价于历史版本）。
	e.publishApp(appSpec{appID: appID, config: publicConfig()})

	// (1) 无身份 ⇒ 401（契约 §4.4：历史 public 在读取侧即 login，**没有匿名**）。
	rec := e.doClient(appID, nil, http.MethodGet, "/me", "", "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("历史 public 应用不得匿名可达：应 401，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	// (2) 已登录 ⇒ 照常可用，且帧内如实告诉应用"要求登录"（auth.mode=login）。
	rec = e.doClient(appID, e.clientUser(testOwner), http.MethodGet, "/me", "", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("历史 public 应用对已登录用户必须照常可用，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	body := decodeJSON(t, rec.Body)
	if body["auth_mode"] != "login" {
		t.Fatalf("历史 public 的帧内 auth.mode 必须是 login（读取侧即 login）：%v", body)
	}
	if body["has_user"] != true || body["auth_verified"] != true {
		t.Fatalf("帧内身份不对：%v", body)
	}
}

// ===== ⑥ 身份投影：帧内身份必须与 users 行 / apps.owner 这两份权威数据一致 =====
//
// 2026-09-19 W4：旧的"客户端路径 vs Cookie 路径"对拍（session.resolveAppSession）
// 随旧路径删除 —— 那份投影不再是第二份实现，权威数据改成数据库里的行本身。
func TestClientFrameUser_ProjectsUserRowAndPublisherFlag(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-parity")
	// 应用归属 alice（testOwner）；使用者是 bob ⇒ is_publisher 必须为 false。
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	bob := e.clientUser("bob")
	// 展示名 + 部门：投影必须原样给出（应用靠它们显示"当前是谁"）。
	if _, err := e.db.Exec(`UPDATE users SET display_name = $1 WHERE id = $2`, "鲍勃", bob.ID); err != nil {
		t.Fatalf("写 display_name 失败: %v", err)
	}
	var groupID int64
	if err := e.db.QueryRow(
		`INSERT INTO groups (name, parent_id) VALUES ($1, NULL) RETURNING id`, "研发部").Scan(&groupID); err != nil {
		t.Fatalf("建部门失败: %v", err)
	}
	if _, err := e.db.Exec(`INSERT INTO user_groups (user_id, group_id) VALUES ($1, $2)`, bob.ID, groupID); err != nil {
		t.Fatalf("挂部门失败: %v", err)
	}

	app, err := serverstore.GetWasmAppByHost(t.Context(), e.db, appID)
	if err != nil {
		t.Fatalf("取应用失败: %v", err)
	}

	// ① 使用者 bob：ID/用户名来自行本身，展示名/部门来自同一次查询，is_publisher=false。
	got := e.srv.clientFrameUser(t.Context(), bob, app)
	if got == nil {
		t.Fatal("客户端路径投影出 nil 身份")
	}
	if got.ID != bob.ID || got.Username != bob.Username {
		t.Fatalf("ID/Username 与 users 行分叉：投影=%+v 行=%+v", got, bob)
	}
	if got.DisplayName != "鲍勃" {
		t.Fatalf("display_name = %q, want %q（users.display_name）", got.DisplayName, "鲍勃")
	}
	if got.Dept != "研发部" {
		t.Fatalf("部门 = %q, want %q（user_groups 的第一个组）", got.Dept, "研发部")
	}
	if got.IsPublisher {
		t.Fatal("使用者不是发布者，不得给 is_publisher=true")
	}

	// ② 发布者本人（alice = apps.owner）：同一份投影必须给出 is_publisher=true。
	//（这条同时钉住"发布者判定看归属而不是看 Role/管理员"。）
	owner := e.ownerUser
	if pgot := e.srv.clientFrameUser(t.Context(), owner, app); pgot == nil || !pgot.IsPublisher {
		t.Fatalf("应用归属 alice ⇒ 她的投影必须 is_publisher=true，得到 %+v", pgot)
	}

	// ③ nil 用户 ⇒ nil 身份（调用方按"无身份"处理，不得凭空造一个）。
	if nilUser := e.srv.clientFrameUser(t.Context(), nil, app); nilUser != nil {
		t.Fatalf("nil 用户必须投影出 nil 身份，得到 %+v", nilUser)
	}
}

// ===== ⑦ 信封解析出的 JSON 体必须原样进应用（回归：base64/大小）=====

func TestClientRequest_BodyReachesGuest(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("client-body")
	e.publishApp(appSpec{appID: appID, config: loginConfig()})

	rec := e.doClient(appID, e.clientUser(testOwner), http.MethodPost, "/echo", clientOriginOf(appID), `{"n":7}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("POST 应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	// echoapp 的 /echo 回显请求体原文（见 testdata/echoapp）。
	if got, _ := payload["body"].(string); !strings.Contains(got, `"n":7`) {
		t.Fatalf("应用没有收到请求体原文：%v", payload)
	}
}
