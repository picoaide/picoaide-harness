package api

// F16（打开校验与计数）与 app-proof（持有性证明）在**传输层**的判据。
//
// 契约：设计总纲 §5.1b（open）、§8.9（计数存储与口径）、§20.1/§23.1（proof）。
//
// 变异验证（改坏哪一行会让本文件的哪条用例红）：
//   - 把 requireProof 从 openApp 里删掉 ⇒ TestOpenAppRequiresProof 红；
//   - 把 proof 的 app_id 绑定（Claims.App）从 Verify 里删掉 ⇒
//     TestOpenAppRejectsCrossAppProof 红；
//   - 把 user_id 绑定删掉 ⇒ TestOpenAppRejectsCrossUserProof 红；
//   - 把 exp 判定删掉 ⇒ TestOpenAppRejectsExpiredProof 红；
//   - 把 `changed: rel.Version != current` 改成恒 false ⇒ TestOpenAppVersionChanged 红；
//   - 把计数挪出 open（或改成按请求计数）⇒ TestOpenAppCountsOncePerOpen 红；
//   - 去掉 `X-PicoAide-App-Version` 响应头 ⇒ TestOpenAppSetsVersionHeader 红；
//   - 让计数失败冒泡成 5xx ⇒ TestOpenAppSurvivesCountingFailure 红；
//   - 把 410 改回 404 ⇒ TestOpenAppGoneAndMissing 红；
//   - 把 sessionKeyFor 改成空串 ⇒ TestClientRequestPassesSessionKey 红。

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
)

// decodeErrCode 断言响应是错误信封且 code 恰好是指定值。
//
// 为什么单独包一层：proof 的四类失败**共用 401**，只看状态码测不出"缺 proof 与
// 绑定不符被分到了同一个码"（而客户端的反应完全不同：前者惰性签发、后者清缓存重签）。
func decodeErrCode(t *testing.T, rec *httptest.ResponseRecorder, wantStatus int, wantCode string) errBody {
	t.Helper()
	var eb errBody
	if err := json.Unmarshal(rec.Body.Bytes(), &eb); err != nil {
		t.Fatalf("响应不是 JSON 错误信封: %v; body=%s", err, rec.Body.String())
	}
	if rec.Code != wantStatus {
		t.Fatalf("status = %d, want %d; body=%s", rec.Code, wantStatus, rec.Body.String())
	}
	if eb.Error.Code != wantCode {
		t.Fatalf("code = %q, want %q; body=%s", eb.Error.Code, wantCode, rec.Body.String())
	}
	return eb
}

// seedOpenApp 落一行应用 + 一个 approved 版本（open 端点只读这两样）。
func seedOpenApp(t *testing.T, e *testEnv, appID, version, title string, enabled bool) {
	t.Helper()
	seedApp(t, e, appID, title, "alice", enabled)
	if _, err := serverstore.CreateWasmRelease(context.Background(), e.db, serverstore.WasmRelease{
		AppID:      appID,
		Version:    version,
		Title:      title,
		Publisher:  "alice",
		Status:     serverstore.ReleaseStatusApproved,
		ConfigJSON: `{"access":"login"}`,
		Checksum:   "deadbeef",
	}); err != nil {
		t.Fatalf("落库版本 %s@%s 失败: %v", appID, version, err)
	}
}

// postOpen 发一次 open 请求；withProof=false 时不带 proof。
func (e *testEnv) postOpen(appID, token, current string, withProof bool) *httptest.ResponseRecorder {
	e.t.Helper()
	body, _ := json.Marshal(map[string]string{"current_version": current})
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/open", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if withProof {
		// 用生产签发路径铸一份（serverURL = httptest 的缺省 Host）。
		req.Host = "example.com"
		req.Header.Set(proofHeader, e.mintProofFor(token, appID))
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// mintProofFor 为任意 (token, appID) 铸 proof（open 用例的 token 可能是 alice/bob）。
func (e *testEnv) mintProofFor(token, appID string) string {
	e.t.Helper()
	var uid int64
	if err := e.db.QueryRow(`SELECT user_id FROM api_tokens WHERE token_hash = ?`,
		serverstore.TokenHash(token)).Scan(&uid); err != nil {
		e.t.Fatalf("token 不属于任何用户: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://example.com/api/client/v2/apps/wasm/proof", nil)
	req.Host = "example.com"
	res, err := e.proof.Issue(req, uid, serverstore.TokenHash(token), appID, e.installRequest(appID))
	if err != nil {
		e.t.Fatalf("铸 proof 失败（appID=%s）: %v", appID, err)
	}
	return res.Proof
}

func TestOpenAppHappyPathCountsAndSetsVersion(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.2.3", "备忘工具", true)

	// 首次打开（无缓存版本）⇒ changed=true、带版本头、计数 +1。
	rec := e.postOpen("notes", e.tokens["alice"], "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("open = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(edge.AppVersionHeader); got != "1.2.3" {
		t.Fatalf("%s = %q, want 1.2.3（客户端缓存键的唯一来源）", edge.AppVersionHeader, got)
	}
	var out struct {
		Version   string `json:"version"`
		ReleaseID int64  `json:"release_id"`
		Title     string `json:"title"`
		Changed   bool   `json:"changed"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析响应: %v body=%s", err, rec.Body.String())
	}
	if out.Version != "1.2.3" || out.Title != "备忘工具" || !out.Changed || out.ReleaseID <= 0 {
		t.Fatalf("响应字段不符: %+v", out)
	}
	if n := e.opens.count(); n != 1 {
		t.Fatalf("打开计数 = %d, want 1（每次调用 +1）", n)
	}
	if call, _ := e.opens.last(); call.clientVersion != "" {
		t.Fatalf("client_version = %q, want 空串（首次打开无缓存）", call.clientVersion)
	}

	// 版本未变 ⇒ changed=false（不准清缓存）；计数仍然 +1（PV 式，不去重）。
	rec = e.postOpen("notes", e.tokens["alice"], "1.2.3", true)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if out.Changed {
		t.Fatal("current_version == 服务端版本时 changed 必须为 false（否则每次打开都清缓存）")
	}
	if n := e.opens.count(); n != 2 {
		t.Fatalf("两次打开后计数 = %d, want 2（PV 不去重）", n)
	}
	// 版本变化 ⇒ changed=true。
	seedOpenApp(t, e, "notes2", "1.0.0", "备忘工具", true)
	if _, err := serverstore.CreateWasmRelease(context.Background(), e.db, serverstore.WasmRelease{
		AppID: "notes", Version: "2.0.0", Title: "备忘工具", Publisher: "alice",
		Status: serverstore.ReleaseStatusApproved, ConfigJSON: `{"access":"login"}`,
	}); err != nil {
		t.Fatalf("落库新版本: %v", err)
	}
	rec = e.postOpen("notes", e.tokens["alice"], "1.2.3", true)
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if !out.Changed || out.Version != "2.0.0" {
		t.Fatalf("版本变化必须 changed=true 且回新版本: %+v", out)
	}
	if got := rec.Header().Get(edge.AppVersionHeader); got != "2.0.0" {
		t.Fatalf("版本头 = %q, want 2.0.0", got)
	}
}

func TestOpenAppRequiresProof(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)

	// 缺 proof ⇒ 401 proof_required（R2S-6：open 端点**同样**要求 proof）。
	rec := e.postOpen("notes", e.tokens["alice"], "", false)
	obj := decodeErrCode(t, rec, http.StatusUnauthorized, "proof_required")
	if obj.Error.Details["header"] != proofHeader {
		t.Fatalf("details 应告诉客户端带哪个头: %v", obj.Error.Details)
	}
	if n := e.opens.count(); n != 0 {
		t.Fatalf("未过 proof 的请求不得计数（got %d）", n)
	}
	// 瞎编的 proof ⇒ 401 proof_mismatch。
	body, _ := json.Marshal(map[string]string{"current_version": ""})
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/notes/open", bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+e.tokens["alice"])
	req.Header.Set(proofHeader, "v1.kid.AAAA.BBBB")
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	decodeErrCode(t, w, http.StatusUnauthorized, "proof_mismatch")
}

func TestOpenAppRejectsCrossUserAndCrossAppProof(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	seedOpenApp(t, e, "other", "1.0.0", "另一个应用", true)

	// 跨用户重放：alice 的 proof 配 bob 的 bearer ⇒ 401 proof_mismatch。
	aliceProof := e.mintProofFor(e.tokens["alice"], "notes")
	body, _ := json.Marshal(map[string]string{"current_version": ""})
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/notes/open", bytes.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+e.tokens["bob"])
	req.Header.Set(proofHeader, aliceProof)
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	decodeErrCode(t, w, http.StatusUnauthorized, "proof_mismatch")

	// 跨应用重放：为 notes 签的 proof 拿去开 other ⇒ 401 proof_mismatch。
	req2 := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/other/open", bytes.NewReader(body))
	req2.Host = "example.com"
	req2.Header.Set("Authorization", "Bearer "+e.tokens["alice"])
	req2.Header.Set(proofHeader, aliceProof)
	w2 := httptest.NewRecorder()
	e.r.ServeHTTP(w2, req2)
	decodeErrCode(t, w2, http.StatusUnauthorized, "proof_mismatch")

	if n := e.opens.count(); n != 0 {
		t.Fatalf("被拒的请求一次都不该计数（got %d）", n)
	}
}

func TestOpenAppRejectsExpiredProof(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)

	// 先用**当前**时钟签一份合法 proof，再把服务的时钟推到 TTL 之后：
	// 校验必须回 401 proof_expired（不是 mismatch —— 客户端的反应不同：
	// 过期 ⇒ 重新签发；绑定不符 ⇒ 清缓存 + 重新签发并记异常）。
	proof := e.mintProofFor(e.tokens["alice"], "notes")
	advanced, err := appproof.New(appproof.Options{
		DataRoot: e.proofRoot, // **同一**数据根 ⇒ 同一密钥环与安装注册表（否则会新生成一把密钥）
		Now:      func() time.Time { return time.Now().Add(appproof.DefaultTTL + time.Minute) },
	})
	if err != nil {
		t.Fatalf("构造推进时钟的 proof 服务: %v", err)
	}
	e.h.opt.Proof = advanced

	body, _ := json.Marshal(map[string]string{"current_version": ""})
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/notes/open", bytes.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+e.tokens["alice"])
	req.Header.Set(proofHeader, proof)
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	decodeErrCode(t, w, http.StatusUnauthorized, "proof_expired")
	if n := e.opens.count(); n != 0 {
		t.Fatalf("过期 proof 不得计数（got %d）", n)
	}
}

func TestOpenAppNotFoundAndGone(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	seedOpenApp(t, e, "offline", "1.0.0", "已下架", false)
	seedApp(t, e, "noversion", "没有版本", "alice", true)

	// 不存在 ⇒ 404（且不泄露"曾经存在"）。
	decodeErrCode(t, e.postOpen("ghost", e.tokens["alice"], "", true), http.StatusNotFound, "NOT_FOUND")
	// 下架 ⇒ **410**（客户端据此显示"已下架"而不是"不存在"）。
	decodeErrCode(t, e.postOpen("offline", e.tokens["alice"], "", true), http.StatusGone, "NOT_FOUND")
	// 登记了但没有 approved 版本 ⇒ 404 + 可操作 hint。
	obj := decodeErrCode(t, e.postOpen("noversion", e.tokens["alice"], "", true), http.StatusNotFound, "NOT_FOUND")
	if len(obj.Error.Hints) == 0 {
		t.Fatal("没有可用版本时必须给 hint（否则作者不知道要发布）")
	}
	// 未认证 ⇒ 401（BearerAuth 中间件，先于 proof）。
	rec := e.postOpen("notes", "", "", false)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无令牌 = %d, want 401", rec.Code)
	}
}

func TestOpenAppSurvivesCountingFailure(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	e.opens.fail = true

	// §8.9：计数失败**不影响打开**（只 warn，不改响应）。
	rec := e.postOpen("notes", e.tokens["alice"], "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("计数故障时 open 必须仍成功: %d body=%s", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get(edge.AppVersionHeader); got != "1.0.0" {
		t.Fatalf("计数故障不得影响版本头: %q", got)
	}
}

func TestOpenAppUnknownFieldRejected(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	body := []byte(`{"current_version":"1.0.0","cache":true}`)
	req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/notes/open", bytes.NewReader(body))
	req.Host = "example.com"
	req.Header.Set("Authorization", "Bearer "+e.tokens["alice"])
	req.Header.Set(proofHeader, e.mintProofFor(e.tokens["alice"], "notes"))
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	// `cache` 字段已按契约删除（R1-CLI-7）：传它必须 400，而不是被静默忽略。
	decodeErrCode(t, w, http.StatusBadRequest, "VALIDATION")
}

func TestProofIssueEndpoint(t *testing.T) {
	e := newTestEnv(t)
	install := e.installRequest("notes")
	raw, _ := json.Marshal(map[string]any{
		"install_id": install.InstallID,
		"public_key": install.PublicKey,
		"nonce":      install.Nonce,
		"ts":         install.TS,
		"signature":  install.Signature,
		"app_id":     "notes",
	})
	rec := e.req(http.MethodPost, "/api/client/v2/apps/wasm/proof", e.tokens["alice"], raw)
	if rec.Code != http.StatusOK {
		t.Fatalf("签发 = %d body=%s", rec.Code, rec.Body.String())
	}
	var out struct {
		Proof     string `json:"proof"`
		ExpiresAt int64  `json:"expires_at"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("解析: %v", err)
	}
	if out.Proof == "" || out.ExpiresAt == 0 {
		t.Fatalf("签发响应缺字段: %+v", out)
	}
	// 重放同一份安装签名 ⇒ 401 proof_replayed（nonce 一次性）。
	rec = e.req(http.MethodPost, "/api/client/v2/apps/wasm/proof", e.tokens["alice"], raw)
	decodeErrCode(t, rec, http.StatusUnauthorized, "proof_replayed")
	// 未认证 ⇒ 401（BearerAuth 先于一切）。
	rec = e.req(http.MethodPost, "/api/client/v2/apps/wasm/proof", "", raw)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无令牌签发 = %d, want 401", rec.Code)
	}
}

// TestClientRequestPassesSessionKey 钉住会话键接缝（契约 §8.2 / R1-SRV-5）：
// 入口必须传 `serverstore.TokenHash(bearer)[:32]`，而不是空串。
func TestClientRequestPassesSessionKey(t *testing.T) {
	e := newClientEnv(t, true)
	rec := e.post("demo", okEnvelope("demo"))
	if rec.Code != http.StatusOK {
		t.Fatalf("信封请求 = %d body=%s", rec.Code, rec.Body.String())
	}
	want := serverstore.TokenHash(e.token)[:32]
	if e.hook.sessionKey != want {
		t.Fatalf("sessionKey = %q, want %q（Bearer 的 SHA-256 前 16 字节 hex）", e.hook.sessionKey, want)
	}
}

// ---- 渠道 scheme 参数化（契约 §8.3/§10，R2I-9）与 truncated 契约（R1-SRV-11）----

// TestClientRequestUsesInjectedAppScheme 钉住**scheme 参数化的唯一落点**。
//
// 变异：把 clientreq.go 的 `u.Scheme = h.clientAppScheme()` 改回包级常量
// （appserver.ClientScheme）⇒ 本用例红（渠道客户端注册的是 `acme-app`，
// 服务端按 `picoaide-app` 组装自身源 ⇒ 所有非幂等请求 403）。
func TestClientRequestUsesInjectedAppScheme(t *testing.T) {
	e := newClientEnv(t, true)
	// 注入渠道 scheme（生产 = channel.AppOriginScheme() 的结果）。
	e.h.opt.AppScheme = "acme-app"
	e.h.opt.AppOrigin = func(appID string) string { return "acme-app://" + appID }

	// 信封 host 用渠道 scheme 的规范形态 ⇒ 放行，且合成请求的 URL.Scheme 是渠道值。
	env := okEnvelope("demo")
	env.Host = "acme-app://demo"
	rec := e.post("demo", env)
	if rec.Code != http.StatusOK {
		t.Fatalf("渠道 scheme 的规范 host 应放行，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	if e.hook.scheme != "acme-app" {
		t.Fatalf("合成请求的 URL.Scheme = %q, want acme-app（必须来自渠道配置）", e.hook.scheme)
	}
	// 官方 scheme 的 host 现在必须被拒（服务端只认本部署的 scheme）。
	env2 := okEnvelope("demo")
	env2.Host = "picoaide-app://demo"
	if rec := e.post("demo", env2); rec.Code != http.StatusBadRequest {
		t.Fatalf("非本部署 scheme 的 host 必须 400，得到 %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestClientResponseEnvelopeAlwaysCarriesTruncated 钉住 `truncated` 键**总是出现**。
//
// 契约 §5.1 / R1-SRV-11 / SEC-10：客户端把 `truncated:true` 一律按 502
// `INVALID_PLATFORM_RESPONSE` 处理并渲染错误页；"键缺失"与"键为 false"在客户端解析里
// 必须是两件事 —— 一旦省略（`omitempty`），老客户端会把"平台没告诉我"当成"没截断"，
// 于是把半个页面当成功渲染。
//
// 变异：给 clientResponseEnvelope.Truncated 加回 `,omitempty` ⇒ 本用例红。
func TestClientResponseEnvelopeAlwaysCarriesTruncated(t *testing.T) {
	e := newClientEnv(t, true)
	rec := e.post("demo", okEnvelope("demo"))
	if rec.Code != http.StatusOK {
		t.Fatalf("信封请求 = %d body=%s", rec.Code, rec.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("响应不是 JSON: %v", err)
	}
	v, ok := raw["truncated"]
	if !ok {
		t.Fatal(`响应信封必须**始终**带 "truncated" 键（省略会让客户端把截断当成功）`)
	}
	if string(v) != "false" {
		t.Fatalf(`未截断时 truncated 必须是 false，得到 %s`, v)
	}
}

// TestOpenAppResponseCarriesTodayOpens 钉住 §5.1b 新增的 `opens.today.{pv,uv}`。
//
// 变异：去掉响应里的 Opens 字段 ⇒ 红；把 today 的口径改成"不含本次调用" ⇒ 红
// （契约明写本次调用计数在内）；把 uv 改成不去重 ⇒ 红。
func TestOpenAppResponseCarriesTodayOpens(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)

	type opensOut struct {
		Opens *struct {
			Today struct {
				PV int64 `json:"pv"`
				UV int64 `json:"uv"`
			} `json:"today"`
		} `json:"opens"`
	}
	read := func(rec *httptest.ResponseRecorder) opensOut {
		t.Helper()
		var out opensOut
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			t.Fatalf("解析响应: %v body=%s", err, rec.Body.String())
		}
		return out
	}

	// 第一次打开：本次调用**计数在内** ⇒ pv=1。
	rec := e.postOpen("notes", e.tokens["alice"], "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("open = %d body=%s", rec.Code, rec.Body.String())
	}
	if got := read(rec); got.Opens == nil || got.Opens.Today.PV != 1 || got.Opens.Today.UV != 1 {
		t.Fatalf("首次打开的 opens.today = %+v, want pv1/uv1（含本次调用）", got.Opens)
	}
	// 同一用户再打开一次：pv+1、uv 不变（按 user_id 去重）。
	rec = e.postOpen("notes", e.tokens["alice"], "1.0.0", true)
	if got := read(rec); got.Opens == nil || got.Opens.Today.PV != 2 || got.Opens.Today.UV != 1 {
		t.Fatalf("第二次打开 opens.today = %+v, want pv2/uv1（PV 不去重、UV 去重）", got.Opens)
	}
	// 换一个用户：uv+1。
	rec = e.postOpen("notes", e.tokens["bob"], "", true)
	if got := read(rec); got.Opens == nil || got.Opens.Today.PV != 3 || got.Opens.Today.UV != 2 {
		t.Fatalf("另一用户打开 opens.today = %+v, want pv3/uv2", got.Opens)
	}
	// 与明细表抽样对账（响应里的数字必须来自真实落库的明细）。
	var pv, uv int64
	if err := e.db.QueryRow(`SELECT count(*), count(DISTINCT user_id) FROM wasm_app_opens WHERE app_id = 'notes'`).
		Scan(&pv, &uv); err != nil {
		t.Fatalf("查明细: %v", err)
	}
	if pv != 3 || uv != 2 {
		t.Fatalf("明细 = pv%d/uv%d, want 3/2（响应必须与明细同源）", pv, uv)
	}
}

// TestOpenAppOmitsOpensWhenCountingFails 钉住 §5.1b 第 2 条的**缺省语义**。
//
// 变异：把计数失败时的 opens 回成 `{"today":{"pv":0,"uv":0}}` ⇒ 红（把"统计不可用"
// 冒充成"今天没人打开"，客户端会渲染一个确定但错误的数字）。
func TestOpenAppOmitsOpensWhenCountingFails(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "notes", "1.0.0", "备忘工具", true)
	e.opens.fail = true

	rec := e.postOpen("notes", e.tokens["alice"], "", true)
	if rec.Code != http.StatusOK {
		t.Fatalf("计数失败时仍须 200: %d body=%s", rec.Code, rec.Body.String())
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if v, ok := raw["opens"]; ok {
		t.Fatalf("计数失败时 opens 必须**缺省或为 null**，得到 %s（不得回 0 冒充没人打开）", v)
	}
	// 版本字段照常（打开本身不受影响）。
	if _, ok := raw["version"]; !ok {
		t.Fatal("计数失败不得影响版本字段")
	}
}

// ============================================================================
// R1-L1-1（P0）：**`request` 路径必须校验 `X-Pico-App-Proof`**
// ============================================================================
//
// 缺口原文：`requireProof` 的唯一调用点曾是 `open.go`，而真正的应用请求路径
// （带 bearer、执行 wasm、能读写应用库）完全不要求安装密钥签名 ⇒ 只拿到被盗 bearer
// 就能驱动任意应用，A′（§23.1）被架空。契约依据：§5.1「认证 = Bearer ＋
// X-Pico-App-Proof（必需）」、§13.1 I2、§23.1。
//
// 四条用例（缺一不算闭合）：
//
//	① 缺头 ⇒ 401 `proof_required`
//	② 跨应用 proof ⇒ 401 `proof_mismatch`
//	③ 非幂等（POST）同一 proof 第二次 ⇒ 401 `proof_replayed`（jti 一次性）
//	④ 幂等（GET）**不查 jti**（正对照：同一 proof 连用两次都 200，读路径不被变成写路径）

func TestClientRequestRequiresProof(t *testing.T) {
	e := newClientEnv(t, true)
	e.noProof = true // 不自动附 proof

	// ① 缺头 ⇒ 401 proof_required（且**没有**走到应用管线）。
	before := e.hook.called
	rec := e.post("demo", okEnvelope("demo"))
	decodeErrCode(t, rec, http.StatusUnauthorized, "proof_required")
	if e.hook.called != before {
		t.Fatal("缺 proof 的请求绝不允许进入应用管线（管线一进就代表 can 执行 wasm/读写应用库）")
	}

	// ② 跨应用：为 other 签的 proof 打 demo 的 request ⇒ 401 proof_mismatch。
	env := okEnvelope("demo")
	rec = e.post("demo", env, func(r *http.Request) {
		r.Header.Set(proofHeader, e.mintProof("other"))
	})
	decodeErrCode(t, rec, http.StatusUnauthorized, "proof_mismatch")
	if e.hook.called != before {
		t.Fatal("跨应用 proof 不得进入管线")
	}

	// ③ 非幂等重放：同一张 proof 连发两次 POST，第二次必须 proof_replayed。
	envPost := okEnvelope("demo")
	envPost.Method = http.MethodPost
	envPost.Path = "/notes"
	proof := e.mintProof("demo")
	rec = e.post("demo", envPost, func(r *http.Request) { r.Header.Set(proofHeader, proof) })
	if rec.Code != http.StatusOK {
		t.Fatalf("第一次 POST 应通过，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	rec = e.post("demo", envPost, func(r *http.Request) { r.Header.Set(proofHeader, proof) })
	decodeErrCode(t, rec, http.StatusUnauthorized, "proof_replayed")

	// ④ 正对照：幂等（GET）不查 jti —— 同一张 proof 连用两次都必须通过。
	//    （变异：把 proofJTIExemptMethods 删掉 ⇒ 本段红；那会把每次读都变成写。）
	envGet := okEnvelope("demo") // Method 缺省 GET
	proofGet := e.mintProof("demo")
	for i := 0; i < 2; i++ {
		rec = e.post("demo", envGet, func(r *http.Request) { r.Header.Set(proofHeader, proofGet) })
		if rec.Code != http.StatusOK {
			t.Fatalf("幂等请求第 %d 次必须放行（不查 jti），得到 %d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}
}

// TestOpenAppFrozenStatesDoNotCollapse 钉住契约 §5.1 / §7.7③ / R2-X-2：
// 冻结 / 软删 / 未登记都是 404，但**必须**带不同的 `reason`。
//
// 为什么不能塌缩：客户端的文案与下一步动作不同（冻结=「已被管理员停用，请联系管理员」；
// 已删除=「应用不存在」）。全部说成"应用不存在"会让被冻结的应用看起来像被删了 ——
// 用户会去问"为什么删了我的应用"，而管理员什么都没删。
//
// 变异：去掉任一处的 `WithDetail("reason", …)` ⇒ 本用例红。
func TestOpenAppFrozenStatesDoNotCollapse(t *testing.T) {
	e := newTestEnv(t)
	seedOpenApp(t, e, "frozen", "1.0.0", "被冻结的应用", true)
	seedOpenApp(t, e, "alive", "1.0.0", "正常应用", true)
	if err := serverstore.FreezeWasmApp(context.Background(), e.db, "frozen", time.Now()); err != nil {
		t.Fatalf("冻结应用: %v", err)
	}
	// 软删（退役）：DAO 层直接置 deleted_at。
	if _, err := e.db.Exec(`UPDATE apps SET deleted_at = now() WHERE kind = 'wasm_app' AND app_id = 'frozen-deleted'`); err != nil {
		t.Fatalf("预置软删行: %v", err)
	}
	seedOpenApp(t, e, "frozen-deleted", "1.0.0", "已退役应用", true)
	if _, err := e.db.Exec(`UPDATE apps SET deleted_at = now() WHERE kind = 'wasm_app' AND app_id = 'frozen-deleted'`); err != nil {
		t.Fatalf("软删应用: %v", err)
	}

	readReason := func(rec *httptest.ResponseRecorder, wantStatus int) string {
		t.Helper()
		var eb errBody
		if err := json.Unmarshal(rec.Body.Bytes(), &eb); err != nil {
			t.Fatalf("解析错误信封: %v body=%s", err, rec.Body.String())
		}
		if rec.Code != wantStatus {
			t.Fatalf("status = %d, want %d body=%s", rec.Code, wantStatus, rec.Body.String())
		}
		reason, _ := eb.Error.Details["reason"].(string)
		return reason
	}

	if got := readReason(e.postOpen("frozen", e.tokens["alice"], "", true), http.StatusNotFound); got != "app_frozen" {
		t.Fatalf("冻结应用的 reason = %q, want app_frozen（三档不得塌缩）", got)
	}
	if got := readReason(e.postOpen("frozen-deleted", e.tokens["alice"], "", true), http.StatusNotFound); got == "app_frozen" || got == "" {
		t.Fatalf("软删应用的 reason = %q, want 非 app_frozen 且非空（与冻结区分）", got)
	}
	if got := readReason(e.postOpen("ghost", e.tokens["alice"], "", true), http.StatusNotFound); got == "app_frozen" || got == "" {
		t.Fatalf("未登记应用的 reason = %q, want 非 app_frozen 且非空", got)
	}
	// 正常的应用不受影响（正对照）。
	if rec := e.postOpen("alive", e.tokens["alice"], "", true); rec.Code != http.StatusOK {
		t.Fatalf("正常应用 = %d body=%s", rec.Code, rec.Body.String())
	}
}

// TestPublishRejectsReservedPathPrefix 钉住 §21.2 规则②（R2-X-3）：
// 应用**不得**定义 `__picoaide/` 前缀的路由 —— 服务端能静态看到的"路由面"是随包资源
// （自定义段）的名字，因此发布期拒占用该前缀的资源路径。
//
// 为什么必须拒而不是忽略：该前缀由宿主**本地**处理（规则①：这类请求绝不转发平台），
// 静默忽略会让"本地开发好的接口发布后 404/拿到宿主响应"变成一个作者无从下手的谜题。
//
// 变异：把 checkReservedPathPrefix 的调用从 stageRelease 里删掉 ⇒ 本用例红
// （资源被当作普通静态资源接受，发布成功）。
func TestPublishRejectsReservedPathPrefix(t *testing.T) {
	e := newTestEnv(t)
	base := testGuestModule(t)

	// 正例：普通资源路径照常接受（证明闸门不会误伤）。
	ok := withCustomSections(t, base, map[string][]byte{"assets/app.js": []byte("// ok")})
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
		e.payload("resv-ok", "1.0.0", ok, goodConfig())); w.Code != http.StatusOK {
		t.Fatalf("普通资源路径必须通过，得到 %d body=%s", w.Code, w.Body.String())
	}

	// 反例：占用保留前缀 ⇒ 拒（不是"忽略并继续"）。
	bad := withCustomSections(t, base, map[string][]byte{"__picoaide/ai/chat": []byte("{}")})
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
		e.payload("resv-bad", "1.0.0", bad, goodConfig()))
	eb := e.decodeErr(w, http.StatusForbidden)
	if eb.Error.Code != "ASSET_DENIED" {
		t.Fatalf("code = %s, want ASSET_DENIED", eb.Error.Code)
	}
	if eb.Error.Details["reason"] != "reserved_path_prefix" {
		t.Fatalf("details.reason = %v, want reserved_path_prefix（作者要能一眼看出是保留前缀）",
			eb.Error.Details["reason"])
	}
	// 发布（非 validate）同样拒：两条入口共用同一条闸门。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/resv-bad/releases", e.tokens["alice"],
		e.payload("resv-bad", "1.0.0", bad, goodConfig()))
	if w.Code == http.StatusCreated {
		t.Fatalf("占用保留前缀的发布不得成功，得到 %d body=%s", w.Code, w.Body.String())
	}
}
