package api

// 客户端专属访问模型（2026-09-19 契约 §4.1–4.4）**传输层**的判据：
// 信封的形状/体积、host 判据、方法/path/query/头白名单、以及响应编码
//（Set-Cookie 整条丢弃、逐跳头与 Content-Length 剔除）。
//
// 这个文件的用例**不碰真实应用管线**：Options.ServeClientRequest 被替换成一个
// 记录器，因此可以精确断言"信封里的东西被还原成了什么请求"以及"管线的响应被编码
// 成了什么信封"。真实管线的准入/静态/执行判据在 appserver/client_test.go。
//
// 变异验证（把闸门改回危险实现时，哪些用例必红）：
//   - clientHostFor 放开成任意域名 / 恢复端口逻辑 ⇒ TestClientRequest_HostForms 红；
//   - 删掉方法白名单 ⇒ TestClientRequest_MethodWhitelist 红；
//   - clientResponseHeaders 把 Set-Cookie 放回来（或只剥 Domain）⇒
//     TestClientRequest_ResponseEncoding 红；
//   - 头白名单把 cookie/referer/sec-fetch-* 放回来 ⇒ TestClientRequest_HeaderWhitelist 红；
//   - 去掉信封 MaxBytesReader / 解码后的 1 MiB 判定 ⇒ TestClientRequest_BodyLimits 红。

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 夹具 =====

// clientHook 是注入的"应用管线"替身：记录收到的合成请求，回一个可编程的响应。
type clientHook struct {
	called  int
	appID   string
	user    *serverstore.User
	method  string
	path    string
	query   string
	host    string
	scheme  string
	headers http.Header
	body    []byte
	// sessionKey 记下管线收到的**会话键**（契约 §8.2 / R1-SRV-5）：
	// 它必须等于 bearer 的 SHA-256 前 32 个 hex 字符（用例直接对拍，见 TestClientRequestPassesSessionKey）。
	sessionKey string

	status  int
	head    http.Header
	respRaw []byte
}

func (h *clientHook) serve(w http.ResponseWriter, r *http.Request, appID string, user *serverstore.User, sessionKey string) {
	h.called++
	h.appID, h.user, h.method = appID, user, r.Method
	h.sessionKey = sessionKey
	h.host, h.headers = r.Host, r.Header.Clone()
	if r.URL != nil {
		h.scheme, h.path, h.query = r.URL.Scheme, r.URL.Path, r.URL.RawQuery
	}
	h.body, _ = io.ReadAll(r.Body)
	status := h.status
	if status == 0 {
		status = http.StatusOK
	}
	for k, vs := range h.head {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	w.WriteHeader(status)
	_, _ = w.Write(h.respRaw)
}

// clientEnv 是客户端入口的最小装配：真 PG（BearerAuth 要验令牌）+ 生产路径路由。
type clientEnv struct {
	t     *testing.T
	r     *gin.Engine
	db    *sql.DB
	hook  *clientHook
	token string
	user  *serverstore.User
	// proof / installPub / installPriv / installID 是持有性证明的用例侧材料。
	proof       *appproof.Service
	installPub  ed25519.PublicKey
	installPriv ed25519.PrivateKey
	installID   string
	// noProof 为真时 postRaw **不**自动附 proof（"缺 proof ⇒ 401"用例）。
	noProof bool
	// h 是装配好的 handler 集合：渠道 scheme 参数化等用例要能改 Options 后重建。
	h *Handlers
}

// newClientEnv 建环境；withHook=false 用于"未装配钩子"的 fail-closed 用例。
func newClientEnv(t *testing.T, withHook bool) *clientEnv {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	id, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "alice", Source: "local", Status: 1, Role: serverstore.RoleUser,
	})
	if err != nil {
		t.Fatalf("建用户失败: %v", err)
	}
	tok, err := serverauth.IssueToken(db, id)
	if err != nil {
		t.Fatalf("签发令牌失败: %v", err)
	}
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil || u == nil {
		t.Fatalf("取用户失败: %v", err)
	}

	// 持有性证明（契约 §20/§23.1）：生产端点**必装**，用例同样装上 ——
	// 否则本文件的全部信封用例都会变成 401 proof_required（那不是被测语义）。
	// 安装密钥用一次性生成的 Ed25519（与真客户端同款），私钥只活在用例里。
	pub, priv, kerr := ed25519.GenerateKey(rand.Reader)
	if kerr != nil {
		t.Fatalf("生成安装密钥失败: %v", kerr)
	}
	proof, perr := appproof.New(appproof.Options{DataRoot: t.TempDir()})
	if perr != nil {
		t.Fatalf("构造 app-proof 失败: %v", perr)
	}

	hook := &clientHook{status: http.StatusOK, head: http.Header{}, respRaw: []byte("hello")}
	opt := Options{DB: db, Proof: proof}
	if withHook {
		opt.ServeClientRequest = hook.serve
	}
	h := NewHandlers(opt)

	r := gin.New()
	g := r.Group("/api/client/v2/apps/wasm", serverauth.BearerAuth(db))
	g.POST("/:app_id/request", h.ClientRequest)
	return &clientEnv{
		t: t, r: r, db: db, hook: hook, token: tok, user: u, h: h,
		proof: proof, installPub: pub, installPriv: priv, installID: "install-test-0001",
	}
}

// mintProof 为 (本次 token, appID) 铸造一份**真实**的 proof。
//
// 走的是生产签发路径（appproof.Service.Issue）+ 生产待签消息（appproof.InstallMessage）：
// 用例里如果自己拼一份"看起来像 proof"的字符串，就测不出签名/绑定/一次性表的任何一条。
// serverURL 取 http://example.com —— httptest.NewRequest 的缺省 Host，与请求侧一致。
func (e *clientEnv) mintProof(appID string) string {
	e.t.Helper()
	return e.mintProofWith(appID, e.token, e.installID, e.installPriv)
}

// mintProofWith 是 mintProof 的完整形态（跨用户/跨安装/自定义签名用例用）。
func (e *clientEnv) mintProofWith(appID, token, installID string, priv ed25519.PrivateKey) string {
	e.t.Helper()
	ts := time.Now().UTC().Unix()
	// nonce 必须**每次**都新（一次性表会拒重放）：用毫秒时间戳 + 随机后缀，
	// 而不是可复现的固定串 —— 用例连发几次会撞同一秒（实测踩过）。
	nonceBuf := make([]byte, 12)
	if _, err := rand.Read(nonceBuf); err != nil {
		e.t.Fatalf("生成 nonce 失败: %v", err)
	}
	nonce := installID + "-" + strconv.FormatInt(ts, 10) + "-" + hex.EncodeToString(nonceBuf)
	req := httptest.NewRequest(http.MethodPost, "http://example.com/api/client/v2/apps/wasm/proof", nil)
	req.Host = "example.com"
	uid := e.user.ID
	if token != e.token {
		// 跨用户用例：按 token 反查用户（token 只存哈希，这里用测试自己建的行）。
		var id int64
		if err := e.db.QueryRow(`SELECT user_id FROM api_tokens WHERE token_hash = ?`,
			serverstore.TokenHash(token)).Scan(&id); err != nil {
			e.t.Fatalf("跨用户用例的 token 不属于任何用户: %v", err)
		}
		uid = id
	}
	res, err := e.proof.Issue(req, uid, serverstore.TokenHash(token), appID, appproof.InstallRequest{
		InstallID: installID,
		PublicKey: base64.StdEncoding.EncodeToString(priv.Public().(ed25519.PublicKey)),
		Nonce:     nonce,
		TS:        ts,
		Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(priv, appproof.InstallMessage(installID, nonce, ts, "http://example.com"))),
	})
	if err != nil {
		e.t.Fatalf("铸造 proof 失败（appID=%s）: %v", appID, err)
	}
	return res.Proof
}

// clientEnvelope 是测试侧的信封（与 clientRequestEnvelope 逐字段对应；刻意不复用
// 生产结构体：那一侧改了字段名/标签，这里必须跟着红，而不是被同一份定义掩盖）。
type clientEnvelope struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   string            `json:"query"`
	Host    string            `json:"host"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// post 发一次信封请求（默认已认证；token="" 表示不带 Authorization）。
func (e *clientEnv) post(appID string, env clientEnvelope, mutate ...func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	raw, err := json.Marshal(env)
	if err != nil {
		e.t.Fatalf("编码信封: %v", err)
	}
	return e.postRaw(appID, raw, mutate...)
}

func (e *clientEnv) postRaw(appID string, raw []byte, mutate ...func(*http.Request)) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/request", bytes.NewReader(raw))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+e.token)
	// 缺省自动附一份合法 proof：本文件的既有用例测的是**信封语义**，proof 是它们
	// 的前置条件（契约 §20.1 的准入顺序：BearerAuth → app-proof → 信封）。要测 proof
	// 本身用 noProof 或 mutate 覆盖这个头。
	if !e.noProof && req.Header.Get("X-Pico-App-Proof") == "" {
		req.Header.Set("X-Pico-App-Proof", e.mintProof(appID))
	}
	for _, m := range mutate {
		m(req)
	}
	rec := httptest.NewRecorder()
	e.r.ServeHTTP(rec, req)
	return rec
}

// okEnvelope 返回一份最小合法信封。
func okEnvelope(appID string) clientEnvelope {
	return clientEnvelope{
		Method: http.MethodGet, Path: "/notes", Query: "page=2",
		Host: appserver.PicoaideAppOrigin(appID),
	}
}

// errEnvelope 解析错误信封（顺带断言 HTTP 码）。
func errEnvelope(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int) map[string]any {
	t.Helper()
	if rec.Code != wantStatus {
		t.Fatalf("状态码 = %d, want %d（body=%s）", rec.Code, wantStatus, rec.Body.String())
	}
	var env map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatalf("响应不是 JSON 信封: %v body=%s", err, rec.Body.String())
	}
	obj, ok := env["error"].(map[string]any)
	if !ok {
		t.Fatalf("响应没有 error 对象: %v", env)
	}
	return obj
}

// ===== host 判据（契约 §4.2：只接受 picoaide-app://<app_id> 或裸 <app_id>）=====

func TestClientRequest_HostForms(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	legal := []struct {
		name string
		host string
	}{
		{"规范 origin", appserver.PicoaideAppOrigin(appID)},
		{"裸 app_id", appID},
		{"首尾空白", "  " + appserver.PicoaideAppOrigin(appID) + "  "},
		{"大小写不敏感（归一化到小写）", "PicoAide-App://DEMO"},
	}
	for _, tc := range legal {
		t.Run("合法/"+tc.name, func(t *testing.T) {
			env := okEnvelope(appID)
			env.Host = tc.host
			before := e.hook.called
			rec := e.post(appID, env)
			if rec.Code != http.StatusOK {
				t.Fatalf("host=%q 应放行，得到 %d body=%s", tc.host, rec.Code, rec.Body.String())
			}
			if e.hook.called != before+1 {
				t.Fatalf("host=%q 没有走到应用管线", tc.host)
			}
		})
	}

	illegal := []struct {
		name string
		host string
	}{
		{"旧草稿的 .app.localhost", appID + ".app.localhost"},
		{"旧草稿带端口", appID + ".app.localhost:41234"},
		{"任意域名", "evil.example"},
		{"http(s) 源", "https://" + appID},
		{"带端口", appserver.PicoaideAppOrigin(appID) + ":8080"},
		{"带路径", appserver.PicoaideAppOrigin(appID) + "/x"},
		{"另一应用的源", appserver.PicoaideAppOrigin("other")},
		{"带凭据", "user@" + appID},
		{"缺失", ""},
	}
	for _, tc := range illegal {
		t.Run("非法/"+tc.name, func(t *testing.T) {
			env := okEnvelope(appID)
			env.Host = tc.host
			before := e.hook.called
			rec := e.post(appID, env)
			obj := errEnvelope(t, rec, http.StatusBadRequest)
			if obj["code"] != "VALIDATION" {
				t.Fatalf("code = %v, want VALIDATION", obj["code"])
			}
			if _, ok := obj["hints"]; !ok {
				t.Fatalf("host 判据的错误必须带 hints（AI-first）：%v", obj)
			}
			if e.hook.called != before {
				t.Fatalf("host=%q 不该走到应用管线", tc.host)
			}
		})
	}
}

// ===== 合成请求的形状（api 层 → appserver 的跨包契约）=====

func TestClientRequest_SyntheticRequestShape(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)
	e.hook.status = http.StatusCreated
	e.hook.head.Set("Content-Type", "text/plain; charset=utf-8")
	e.hook.respRaw = []byte("note-ok")

	body := []byte(`{"n":7}`)
	env := clientEnvelope{
		Method: http.MethodPost, Path: "/notes", Query: "page=2&q=a%2Fb",
		Host: appID,
		Headers: map[string]string{
			"origin":           appserver.PicoaideAppOrigin(appID),
			"content-type":     "application/json",
			"accept":           "application/json",
			"accept-language":  "zh-CN",
			"if-none-match":    `"v1"`,
			"user-agent":       "picoaide-client",
			"x-requested-with": "XMLHttpRequest",
		},
		Body: base64.StdEncoding.EncodeToString(body),
	}
	rec := e.post(appID, env)
	if rec.Code != http.StatusOK {
		t.Fatalf("入口应 200（内层状态在信封里），得到 %d body=%s", rec.Code, rec.Body.String())
	}

	// 合成请求：scheme/host 是客户端协议的自身源来源，路径/查询原样。
	if e.hook.scheme != appserver.ClientScheme {
		t.Fatalf("URL.Scheme = %q, want %q", e.hook.scheme, appserver.ClientScheme)
	}
	if e.hook.host != appID {
		t.Fatalf("Host = %q, want %q", e.hook.host, appID)
	}
	if e.hook.path != "/notes" || e.hook.query != "page=2&q=a%2Fb" {
		t.Fatalf("路径/查询被改写了：path=%q query=%q", e.hook.path, e.hook.query)
	}
	if e.hook.method != http.MethodPost {
		t.Fatalf("method = %q", e.hook.method)
	}
	if !bytes.Equal(e.hook.body, body) {
		t.Fatalf("请求体原文没有原样送达：%q", e.hook.body)
	}
	if got := e.hook.headers.Get("Accept-Language"); got != "zh-CN" {
		t.Fatalf("白名单头没有转发：%q", got)
	}
	if e.hook.user == nil || e.hook.user.Username != "alice" {
		t.Fatalf("身份没有交给管线：%+v", e.hook.user)
	}

	// 响应信封：状态与体逐字节还原。
	var out struct {
		Status  int         `json:"status"`
		Headers http.Header `json:"headers"`
		Body    string      `json:"body"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应信封不是 JSON: %v", err)
	}
	if out.Status != http.StatusCreated {
		t.Fatalf("status = %d, want 201", out.Status)
	}
	raw, err := base64.StdEncoding.DecodeString(out.Body)
	if err != nil {
		t.Fatalf("body 不是 base64: %v", err)
	}
	if string(raw) != "note-ok" {
		t.Fatalf("body = %q", raw)
	}
	if got := out.Headers.Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
}

// ===== 方法白名单 =====

func TestClientRequest_MethodWhitelist(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	for _, m := range []string{"GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		env := okEnvelope(appID)
		env.Method = m
		before := e.hook.called
		if rec := e.post(appID, env); rec.Code != http.StatusOK {
			t.Fatalf("方法 %s 应放行，得到 %d body=%s", m, rec.Code, rec.Body.String())
		}
		if e.hook.called != before+1 {
			t.Fatalf("方法 %s 没有走到应用管线", m)
		}
	}
	// 小写形态归一化后同样放行（协议 handler 可能原样转发浏览器给的大小写）。
	env := okEnvelope(appID)
	env.Method = "get"
	if rec := e.post(appID, env); rec.Code != http.StatusOK {
		t.Fatalf("小写方法应归一化后放行，得到 %d", rec.Code)
	}

	for _, m := range []string{"TRACE", "CONNECT", "FOO", "", "GET POST"} {
		env := okEnvelope(appID)
		env.Method = m
		obj := errEnvelope(t, e.post(appID, env), http.StatusBadRequest)
		if obj["code"] != "VALIDATION" {
			t.Fatalf("方法 %q 的错误码 = %v", m, obj["code"])
		}
	}
}

// ===== path / query 判据 =====

func TestClientRequest_PathQueryValidation(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	legal := []struct {
		path, query string
	}{
		{"/", ""},
		{"/notes", ""},
		{"/notes/42/edit", "page=2&sort=desc"},
		{"/a%2Fb", "q=%E4%B8%AD%E6%96%87"},
	}
	for _, tc := range legal {
		env := okEnvelope(appID)
		env.Path, env.Query = tc.path, tc.query
		if rec := e.post(appID, env); rec.Code != http.StatusOK {
			t.Fatalf("path=%q query=%q 应放行，得到 %d body=%s", tc.path, tc.query, rec.Code, rec.Body.String())
		}
	}

	illegal := []struct {
		name, path, query string
	}{
		{"空路径", "", ""},
		{"相对路径", "notes", ""},
		{"绝对 URL", "http://evil.example/x", ""},
		{"协议相对 URL", "//evil.example/x", ""},
		{"上跳段", "/a/../b", ""},
		{"反斜杠", "/a\\b", ""},
		{"片段", "/a#b", ""},
		{"控制字符", "/a\x01b", ""},
		{"超长路径", "/" + strings.Repeat("x", 4096), ""},
		{"query 带片段", "/a", "x=1#frag"},
		{"query 带换行", "/a", "x=1\ny=2"},
		{"超长 query", "/a", strings.Repeat("q", 4097)},
	}
	for _, tc := range illegal {
		t.Run(tc.name, func(t *testing.T) {
			env := okEnvelope(appID)
			env.Path, env.Query = tc.path, tc.query
			obj := errEnvelope(t, e.post(appID, env), http.StatusBadRequest)
			if obj["code"] != "VALIDATION" {
				t.Fatalf("code = %v, want VALIDATION", obj["code"])
			}
		})
	}
}

// ===== 请求头白名单（含 2026-09-19 删除的 cookie/referer/sec-fetch-*）=====

func TestClientRequest_HeaderWhitelist(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	// 合法集合：白名单的八个头一个不少。
	env := okEnvelope(appID)
	env.Headers = map[string]string{
		"origin":            appserver.PicoaideAppOrigin(appID),
		"content-type":      "application/json",
		"accept":            "text/html",
		"accept-language":   "zh-CN",
		"if-none-match":     `"v1"`,
		"if-modified-since": "Wed, 21 Oct 2026 07:28:00 GMT",
		"user-agent":        "picoaide-client",
		"x-requested-with":  "XMLHttpRequest",
	}
	if rec := e.post(appID, env); rec.Code != http.StatusOK {
		t.Fatalf("八个白名单头应全部放行，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if got := e.hook.headers.Get("If-None-Match"); got != `"v1"` {
		t.Fatalf("条件请求头没有转发：%q", got)
	}

	illegal := []struct {
		name    string
		headers map[string]string
	}{
		{"cookie（实测不存在）", map[string]string{"cookie": "picoaide_app=deadbeef"}},
		{"referer（实测不存在）", map[string]string{"referer": "https://evil.example/"}},
		{"sec-fetch-site（实测不存在）", map[string]string{"sec-fetch-site": "cross-site"}},
		{"sec-fetch-mode", map[string]string{"sec-fetch-mode": "navigate"}},
		{"authorization（凭证绝不进信封）", map[string]string{"authorization": "Bearer x"}},
		{"未知头", map[string]string{"x-custom": "1"}},
		{"头名过长", map[string]string{strings.Repeat("a", 65): "1"}},
		{"空头名", map[string]string{"  ": "1"}},
		{"头值带 CRLF（注入）", map[string]string{"accept": "text/html\r\nX-Evil: 1"}},
		{"头值过长", map[string]string{"accept": strings.Repeat("a", (8<<10)+1)}},
	}
	for _, tc := range illegal {
		t.Run(tc.name, func(t *testing.T) {
			env := okEnvelope(appID)
			env.Headers = tc.headers
			obj := errEnvelope(t, e.post(appID, env), http.StatusBadRequest)
			if obj["code"] != "VALIDATION" {
				t.Fatalf("code = %v, want VALIDATION", obj["code"])
			}
		})
	}

	// 条数上限（maxClientHeaderCount = 24）：25 条一律拒 —— 条数闸在**白名单之前**，
	// 因此这里用不同的键名撑条数即可，不必都是合法头。
	over := map[string]string{}
	for i := 0; i < 25; i++ {
		over["x-h"+string(rune('a'+i))] = "1"
	}
	env = okEnvelope(appID)
	env.Headers = over
	obj := errEnvelope(t, e.post(appID, env), http.StatusBadRequest)
	if obj["code"] != "VALIDATION" {
		t.Fatalf("超过条数上限的 code = %v", obj["code"])
	}
	details, _ := obj["details"].(map[string]any)
	if details["count"] != float64(25) {
		t.Fatalf("details.count = %v, want 25", details["count"])
	}
}

// ===== 体积：请求体 1 MiB、信封上限 =====

func TestClientRequest_BodyLimits(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	// 恰好 1 MiB（解码后）：放行。
	env := okEnvelope(appID)
	env.Method = http.MethodPost
	env.Body = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("a"), int(limits.AppRequestBodyMaxBytes)))
	if rec := e.post(appID, env); rec.Code != http.StatusOK {
		t.Fatalf("恰好 1 MiB 的请求体应放行，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if int64(len(e.hook.body)) != limits.AppRequestBodyMaxBytes {
		t.Fatalf("管线收到的体大小 = %d", len(e.hook.body))
	}

	// 1 MiB + 1 字节（解码后）：413 + 点名上限。
	env = okEnvelope(appID)
	env.Method = http.MethodPost
	env.Body = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("a"), int(limits.AppRequestBodyMaxBytes)+1))
	obj := errEnvelope(t, e.post(appID, env), http.StatusRequestEntityTooLarge)
	if obj["code"] != "BODY_TOO_LARGE" {
		t.Fatalf("code = %v, want BODY_TOO_LARGE", obj["code"])
	}
	details, _ := obj["details"].(map[string]any)
	if details["max_bytes"] != float64(limits.AppRequestBodyMaxBytes) {
		t.Fatalf("details.max_bytes = %v", details["max_bytes"])
	}

	// 信封本身上限（暴力大 body）：同样是 413，不落到 JSON 解析失败的 400。
	env = okEnvelope(appID)
	env.Method = http.MethodPost
	env.Body = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("a"), int(limits.AppRequestBodyMaxBytes)*2))
	if rec := e.post(appID, env); rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("超信封上限应 413，得到 %d body=%.200s", rec.Code, rec.Body.String())
	}

	// 非法 base64：400（不是 500、也不是静默空体）。
	env = okEnvelope(appID)
	env.Method = http.MethodPost
	env.Body = "!!!not-base64!!!"
	obj = errEnvelope(t, e.post(appID, env), http.StatusBadRequest)
	if obj["code"] != "VALIDATION" {
		t.Fatalf("非法 base64 的 code = %v", obj["code"])
	}

	// 信封不是 JSON / 有未知字段：400（DisallowUnknownFields 是契约）。
	obj = errEnvelope(t, e.postRaw(appID, []byte(`{"method":"GET","path":"/","query":"","host":"demo","headers":{},"body":"","extra":1}`)), http.StatusBadRequest)
	if obj["code"] != "VALIDATION" {
		t.Fatalf("未知字段的 code = %v", obj["code"])
	}
	obj = errEnvelope(t, e.postRaw(appID, []byte(`not json`)), http.StatusBadRequest)
	if obj["code"] != "VALIDATION" {
		t.Fatalf("非 JSON 信封的 code = %v", obj["code"])
	}
}

// ===== 响应编码：Set-Cookie 整条丢弃 + 逐跳头/Content-Length 剔除 =====

func TestClientRequest_ResponseEncoding(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)
	e.hook.status = http.StatusTeapot // 418：证明状态原样透传（不做"合法状态码"过滤）
	e.hook.head = http.Header{
		"Content-Type":       {"text/html; charset=utf-8"},
		"ETag":               {`"abc"`},
		"Set-Cookie":         {"session=1; Path=/; Domain=evil.example", "second=2; HttpOnly"},
		"Content-Length":     {"999"},
		"Connection":         {"keep-alive"},
		"Keep-Alive":         {"timeout=5"},
		"Transfer-Encoding":  {"chunked"},
		"Proxy-Authenticate": {"Basic"},
		"Upgrade":            {"websocket"},
		"Trailer":            {"X-T"},
	}
	e.hook.respRaw = []byte("你好，应用")

	rec := e.post(appID, okEnvelope(appID))
	if rec.Code != http.StatusOK {
		t.Fatalf("入口应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Status    int         `json:"status"`
		Headers   http.Header `json:"headers"`
		Body      string      `json:"body"`
		Truncated bool        `json:"truncated"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("响应信封不是 JSON: %v", err)
	}
	if out.Status != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", out.Status)
	}
	if out.Truncated {
		t.Fatal("正常路径下 truncated 必须为 false")
	}
	// Set-Cookie **整条丢弃**（不是只剥 Domain）：自定义协议下 Cookie 完全不可用。
	if got := out.Headers.Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("Set-Cookie 必须整条丢弃，得到 %v", got)
	}
	// 逐跳头与 Content-Length 剔除。
	for _, h := range []string{"Connection", "Keep-Alive", "Transfer-Encoding", "Proxy-Authenticate", "Upgrade", "Trailer", "Content-Length"} {
		if got := out.Headers.Get(h); got != "" {
			t.Fatalf("%s 必须被剔除，得到 %q", h, got)
		}
	}
	// 其余端到端头照常透传。
	if got := out.Headers.Get("ETag"); got != `"abc"` {
		t.Fatalf("ETag = %q", got)
	}
	if got := out.Headers.Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("Content-Type = %q", got)
	}
	raw, err := base64.StdEncoding.DecodeString(out.Body)
	if err != nil || string(raw) != "你好，应用" {
		t.Fatalf("body 还原失败: %v / %q", err, raw)
	}
}

// ===== 认证：无令牌 401、吊销后 401（契约 §4.4「无匿名」）=====

func TestClientRequest_AuthRequiredAndRevoked(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, true)

	// 无 Authorization：路由中间件 401（**不是**匿名可用）。
	rec := e.post(appID, okEnvelope(appID), func(r *http.Request) { r.Header.Del("Authorization") })
	obj := errEnvelope(t, rec, http.StatusUnauthorized)
	if obj["code"] != "AUTH_REQUIRED" {
		t.Fatalf("无令牌的 code = %v", obj["code"])
	}
	if e.hook.called != 0 {
		t.Fatal("无令牌的请求不该走到应用管线")
	}

	// 有效令牌：放行。
	if rec := e.post(appID, okEnvelope(appID)); rec.Code != http.StatusOK {
		t.Fatalf("有效令牌应放行，得到 %d", rec.Code)
	}

	// 吊销（登出/改密/禁用走的是同一条 RevokeToken 路径）：随即 401，
	// 且**进不到应用管线**（"注销后应用请求仍可用"是这条契约的反面）。
	if err := serverauth.RevokeToken(e.db, e.token); err != nil {
		t.Fatalf("吊销令牌失败: %v", err)
	}
	before := e.hook.called
	obj = errEnvelope(t, e.post(appID, okEnvelope(appID)), http.StatusUnauthorized)
	if code, _ := obj["code"].(string); code != "AUTH_FAILED" && code != "AUTH_REQUIRED" {
		t.Fatalf("吊销后的 code = %v（want AUTH_FAILED/AUTH_REQUIRED）", obj["code"])
	}
	if e.hook.called != before {
		t.Fatal("吊销后的请求不该走到应用管线")
	}
}

// ===== fail-closed：钩子未装配 =====

func TestClientRequest_HookNotWiredIs500(t *testing.T) {
	const appID = "demo"
	e := newClientEnv(t, false)
	obj := errEnvelope(t, e.post(appID, okEnvelope(appID)), http.StatusInternalServerError)
	if obj["code"] != "INTERNAL" {
		t.Fatalf("未装配钩子的 code = %v, want INTERNAL", obj["code"])
	}
	// 装配缺陷不得静默按匿名/空响应放行。
	if hints, _ := obj["hints"].([]any); len(hints) == 0 {
		t.Fatalf("未装配钩子必须给出可操作 hints：%v", obj)
	}
}

// ===== app_id 本身非法（路由参数）=====

func TestClientRequest_InvalidAppID(t *testing.T) {
	e := newClientEnv(t, true)
	// 大写 app_id：registry 的口径是"创建路径不静默小写"，但客户端入口是**只读路径**，
	// 这里按 registry 的既有规则校验（保留字/纯数字/xn--/长度）。
	for _, bad := range []string{"123", "xn--abc", "admin", "portal"} {
		rec := e.post(bad, clientEnvelope{
			Method: http.MethodGet, Path: "/", Host: appserver.PicoaideAppOrigin(bad),
		})
		if rec.Code == http.StatusOK {
			t.Fatalf("非法 app_id %q 不该放行", bad)
		}
		if e.hook.called != 0 {
			t.Fatalf("非法 app_id %q 不该走到应用管线", bad)
		}
	}
}
