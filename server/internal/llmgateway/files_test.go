package llmgateway

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// /v1/files 直通（2026-09-22）回归防线
// ---------------------------------------------------------------------------

// fakeFilesUpstream 记录收到的请求并返回预设响应，模拟 DeepSeek Files API。
type fakeFilesUpstream struct {
	srv     *httptest.Server
	hits    atomic.Int64
	method  atomic.Value
	path    atomic.Value
	query   atomic.Value
	auth    atomic.Value
	ctype   atomic.Value
	body    atomic.Value
	respond func(w http.ResponseWriter, r *http.Request)
}

func newFakeFilesUpstream(t *testing.T) *fakeFilesUpstream {
	t.Helper()
	f := &fakeFilesUpstream{}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		f.hits.Add(1)
		f.method.Store(r.Method)
		f.path.Store(r.URL.Path)
		f.query.Store(r.URL.RawQuery)
		f.auth.Store(r.Header.Get("Authorization"))
		f.ctype.Store(r.Header.Get("Content-Type"))
		f.body.Store(string(raw))
		if f.respond != nil {
			f.respond(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		// 聊天类路径返回一份最小的 chat completion（同一台假上游也服务 /files 用例）；
		// 断言点通常在**请求体**（出站加工），响应形状只要能被上游路径接受即可。
		if strings.Contains(r.URL.Path, "chat/completions") || strings.Contains(r.URL.Path, "messages") {
			fmt.Fprint(w, `{"id":"chat-1","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}`)
			return
		}
		switch r.Method {
		case http.MethodPost:
			// expires_at 取远期 unix 秒（官方口径是 number）——归属台账据此判过期。
			fmt.Fprint(w, `{"id":"file-abc","object":"file","bytes":11,"created_at":1,"filename":"image.webp","purpose":"user_data","expires_at":4102444800}`)
		case http.MethodDelete:
			fmt.Fprint(w, `{"id":"file-abc","object":"file","deleted":true}`)
		default:
			fmt.Fprint(w, `{"object":"list","data":[{"id":"file-abc"},{"id":"file-someone-else"}],"has_more":false}`)
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// filesGateway 是 /files 用例的测试环境：路由树 + DB + 两个员工的令牌与 id。
type filesGateway struct {
	r      *gin.Engine
	db     *sql.DB
	tokenA string
	tokenB string
	uidA   int64
	uidB   int64
}

// newFilesGateway 建一个只连假上游的网关路由树：provider 名称含 deepseek，
// 满足 /files 的"只认 DeepSeek"判据；同时建两个员工（A/B）用于归属隔离用例。
func newFilesGateway(t *testing.T, upstreamURL, providerName string) *filesGateway {
	t.Helper()
	prevDecrypt := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	t.Cleanup(func() { DecryptSecret = prevDecrypt })
	InvalidateUpstreams()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	issue := func(username string) (string, int64) {
		uid, err := serverstore.CreateUser(db, &serverstore.User{Username: username, Source: "local", Status: 1})
		if err != nil {
			t.Fatal(err)
		}
		tok, err := serverauth.IssueToken(db, uid)
		if err != nil {
			t.Fatal(err)
		}
		return tok, uid
	}
	gw := &filesGateway{db: db}
	gw.tokenA, gw.uidA = issue("files-user-a")
	gw.tokenB, gw.uidB = issue("files-user-b")
	if _, err := db.Exec(
		`INSERT INTO gateway_providers (name, base_url, api_key_enc, models) VALUES (?, ?, ?, '["deepseek-chat"]')`,
		providerName, upstreamURL, upstreamKey,
	); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	gw.r = gin.New()
	RegisterRoutes(gw.r, db)
	return gw
}

func doFilesReq(t *testing.T, r http.Handler, method, path string, body io.Reader, token, contentType string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, body)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// multipartBytes 造一个与 DSH 客户端同形的上传体（purpose + expires_after + file）。
func multipartBytes(t *testing.T, payload string) ([]byte, string) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	_ = mw.WriteField("purpose", "user_data")
	_ = mw.WriteField("expires_after[anchor]", "created_at")
	_ = mw.WriteField("expires_after[seconds]", "86400")
	fw, err := mw.CreateFormFile("file", "image.webp")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fw.Write([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := mw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes(), mw.FormDataContentType()
}

// throttleReader 把已有字节按块 + 间隔缓慢喂给请求体（模拟真实网络上的慢上传）。
func throttleReader(src []byte, chunk int, delay time.Duration) io.Reader {
	pr, pw := io.Pipe()
	go func() {
		defer pw.Close()
		for off := 0; off < len(src); off += chunk {
			end := off + chunk
			if end > len(src) {
				end = len(src)
			}
			if _, err := pw.Write(src[off:end]); err != nil {
				return
			}
			if end < len(src) {
				time.Sleep(delay)
			}
		}
	}()
	return pr
}

// 官方 Files 路径是 `<base>/files`（api/create-file 等四页与官方客户端的
// `this.path = '/files'` 一致）；base 里显式带 /v1 的配置也要归一，不能拼成
// /v1/v1/files 或依赖未文档化的 /v1/files。
func TestFilesURLCanonicalizesToOfficialPath(t *testing.T) {
	cases := []struct{ base, want string }{
		{"https://api.deepseek.com", "https://api.deepseek.com/files"},
		{"https://api.deepseek.com/", "https://api.deepseek.com/files"},
		{"https://api.deepseek.com/v1", "https://api.deepseek.com/files"},
		{"https://api.deepseek.com/v1/", "https://api.deepseek.com/files"},
		{"http://127.0.0.1:8081", "http://127.0.0.1:8081/files"},
		{"http://127.0.0.1:8081/v1", "http://127.0.0.1:8081/files"},
	}
	for _, c := range cases {
		if got := filesURL(c.base, ""); got != c.want {
			t.Errorf("filesURL(%q) = %q, want %q", c.base, got, c.want)
		}
	}
	if got := filesURL("https://api.deepseek.com", "/file-1"); got != "https://api.deepseek.com/files/file-1" {
		t.Errorf("suffix join = %q", got)
	}
}

// TestFilesUploadStreamsMultipartToDeepSeek：上传体（含 multipart boundary）
// 必须原样到上游，Authorization 换成上游 key，响应原样回给客户端。
func TestFilesUploadStreamsMultipartToDeepSeek(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "IMG-BYTES")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)

	if w.Code != http.StatusOK {
		t.Fatalf("upload status = %d (%s)", w.Code, w.Body.String())
	}
	if up.hits.Load() != 1 {
		t.Fatalf("upstream hits = %d, want 1", up.hits.Load())
	}
	if got := up.method.Load(); got != http.MethodPost {
		t.Errorf("upstream method = %v", got)
	}
	if got := up.path.Load(); got != "/files" {
		t.Errorf("upstream path = %v, want /files（官方路径，不插 /v1）", got)
	}
	if got := up.auth.Load(); got != "Bearer "+upstreamKey {
		t.Errorf("upstream auth = %v, want 上游 key（客户端 token 不得外发）", got)
	}
	if got := up.ctype.Load(); got != ct {
		t.Errorf("upstream content-type = %v, want %v（multipart boundary 必须原样）", got, ct)
	}
	sent, _ := up.body.Load().(string)
	if !strings.Contains(sent, "IMG-BYTES") || !strings.Contains(sent, `name="purpose"`) {
		t.Errorf("upstream body 不是完整 multipart: %q", sent)
	}
	if !strings.Contains(w.Body.String(), `"file-abc"`) {
		t.Errorf("响应未透传: %s", w.Body.String())
	}
}

// TestFilesUploadRecordsOwnership：上传成功后必须写下归属台账（含 expires_at），
// 否则后续 list/retrieve/delete 会把它当"不存在"。
func TestFilesUploadRecordsOwnership(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("upload status = %d (%s)", w.Code, w.Body.String())
	}
	owner, ok, err := serverstore.GatewayFileOwner(gw.db, "file-abc")
	if err != nil || !ok {
		t.Fatalf("归属未记录: ok=%v err=%v", ok, err)
	}
	var wantUID int64
	if err := gw.db.QueryRow(`SELECT id FROM users WHERE username = 'files-user-a'`).Scan(&wantUID); err != nil {
		t.Fatal(err)
	}
	if owner != wantUID {
		t.Fatalf("归属 user_id = %d, want %d", owner, wantUID)
	}
	var expires *time.Time
	if err := gw.db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'file-abc'`).Scan(&expires); err != nil {
		t.Fatal(err)
	}
	if expires == nil || expires.Before(time.Now()) {
		t.Fatalf("expires_at 未按官方 unix 秒解析: %v", expires)
	}
}

// TestFilesOwnershipIsolation：归属隔离（本次审计 P0）。
//   - 别人上传的文件：检索/删除必须 404，且**不得触达上游**；
//   - 列表只回自己的文件；
//   - 自己的文件照常检索/删除；删除成功后台账收敛。
func TestFilesOwnershipIsolation(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "secret-image")
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("A 上传失败: %d %s", w.Code, w.Body.String())
	}
	hitsAfterUpload := up.hits.Load()

	// B 检索 A 的文件 → 404，且不触达上游
	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files/file-abc", nil, gw.tokenB, ""); w.Code != http.StatusNotFound {
		t.Fatalf("B 检索他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	// B 删除 A 的文件 → 404，且不触达上游
	if w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/file-abc", nil, gw.tokenB, ""); w.Code != http.StatusNotFound {
		t.Fatalf("B 删除他人文件 status = %d (%s), want 404", w.Code, w.Body.String())
	}
	if up.hits.Load() != hitsAfterUpload {
		t.Fatalf("越权请求触达了上游：hits %d → %d", hitsAfterUpload, up.hits.Load())
	}

	// 列表：上游返回全账号两条，A 只应看到自己的 file-abc
	wA := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, "")
	if wA.Code != http.StatusOK {
		t.Fatalf("A 列表 status = %d (%s)", wA.Code, wA.Body.String())
	}
	var listA struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(wA.Body.Bytes(), &listA); err != nil {
		t.Fatalf("A 列表不是 JSON: %s", wA.Body.String())
	}
	if len(listA.Data) != 1 || listA.Data[0]["id"] != "file-abc" {
		t.Fatalf("A 列表应只含自己的文件，实得 %s", wA.Body.String())
	}

	// B 的列表应为空（上游返回的 file-someone-else 不属于 B）
	wB := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenB, "")
	if !strings.Contains(wB.Body.String(), `"data":[]`) {
		t.Fatalf("B 列表应为空，实得 %s", wB.Body.String())
	}

	// 本人检索/删除照常
	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files/file-abc", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("A 检索自己的文件 status = %d (%s)", w.Code, w.Body.String())
	}
	if w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/file-abc", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("A 删除自己的文件 status = %d (%s)", w.Code, w.Body.String())
	}
	if _, ok, err := serverstore.GatewayFileOwner(gw.db, "file-abc"); err != nil || ok {
		t.Fatalf("删除后台账未收敛: ok=%v err=%v", ok, err)
	}
}

// TestFilesUnknownAndMalformedIDsAreNotFound：未登记 id、非法形状（点段/编码穿越）
// 一律 404 同形，且不进上游 URL。
func TestFilesUnknownAndMalformedIDsAreNotFound(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	for _, id := range []string{"file-never-seen", "bad.id", "%2e%2e", "a%2F..%2Fb"} {
		for _, method := range []string{http.MethodGet, http.MethodDelete} {
			w := doFilesReq(t, gw.r, method, "/v1/files/"+id, nil, gw.tokenA, "")
			if w.Code != http.StatusNotFound {
				t.Fatalf("%s /v1/files/%s status = %d (%s), want 404", method, id, w.Code, w.Body.String())
			}
		}
	}
	if up.hits.Load() != 0 {
		t.Fatalf("非法/未登记 id 不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestFilesHardBoundToDeepSeek：没有 deepseek 系 provider 时必须 503，且
// **一个字节都不能发往非 DeepSeek 上游**。
func TestFilesHardBoundToDeepSeek(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "some-other-vendor")

	body, ct := multipartBytes(t, "SECRET-IMAGE")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d (%s), want 503", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("上游收到了 %d 次请求 —— 文件不得发往非 DeepSeek 供应商", up.hits.Load())
	}
	if !strings.Contains(w.Body.String(), "UPSTREAM") {
		t.Errorf("错误信封缺 code: %s", w.Body.String())
	}
}

// TestFilesListKeepsQueryAndPath：列表 query 透传、检索/删除路径拼接正确。
func TestFilesListKeepsQueryAndPath(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	// 先登记一个归属，让检索/删除能过归属闸门
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}

	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files?purpose=user_data&limit=3", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", w.Code, w.Body.String())
	}
	if got := up.query.Load(); got != "purpose=user_data&limit=3" {
		t.Errorf("upstream query = %v, want 原样透传", got)
	}
	if got := up.path.Load(); got != "/files" {
		t.Errorf("upstream path = %v", got)
	}

	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files/file-abc", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("retrieve status = %d (%s)", w.Code, w.Body.String())
	}
	if got := up.path.Load(); got != "/files/file-abc" {
		t.Errorf("retrieve upstream path = %v", got)
	}

	if w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/file-abc", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("delete status = %d (%s)", w.Code, w.Body.String())
	}
	if got := up.method.Load(); got != http.MethodDelete {
		t.Errorf("delete upstream method = %v", got)
	}
	if got := up.path.Load(); got != "/files/file-abc" {
		t.Errorf("delete upstream path = %v", got)
	}
}

// TestFilesUpstreamErrorRelayedAndKeyRedacted：上游 4xx 透传状态码 + 统一错误
// 信封，且响应体里的上游 key 必须被脱敏；Retry-After 白名单透传。
func TestFilesUpstreamErrorRelayedAndKeyRedacted(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "7")
		w.WriteHeader(http.StatusTooManyRequests)
		fmt.Fprintf(w, `{"error":{"message":"file rejected by %s","type":"invalid_request_error","code":"invalid_request_error"}}`, upstreamKey)
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)

	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d (%s), want 429 透传", w.Code, w.Body.String())
	}
	out := w.Body.String()
	if strings.Contains(out, upstreamKey) {
		t.Fatalf("上游 key 泄漏进响应: %s", out)
	}
	if !strings.Contains(out, "file rejected") {
		t.Fatalf("上游错误信息应保留: %s", out)
	}
	if got := w.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After 应透传，实得 %q", got)
	}
}

// TestFilesUploadResponseKeyRedacted：**2xx** 响应体里的上游 key 同样必须脱敏
// （审计指出既有用例只覆盖 4xx 路径）。
func TestFilesUploadResponseKeyRedacted(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"id":"file-abc","object":"file","filename":"leaked-%s.webp"}`, upstreamKey)
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if strings.Contains(w.Body.String(), upstreamKey) {
		t.Fatalf("2xx 响应里的上游 key 未脱敏: %s", w.Body.String())
	}
}

// TestFilesRequiresBearerToken：未认证 401（路由组中间件）。
func TestFilesRequiresBearerToken(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, "", "")
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d (%s), want 401", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("未认证请求不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestFilesRateLimited：每用户限流对 /files 生效（settings gateway.rate_limit=1）。
func TestFilesRateLimited(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.SetSetting(gw.db, "gateway.rate_limit", "1"); err != nil {
		t.Fatal(err)
	}
	if w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, ""); w.Code != http.StatusOK {
		t.Fatalf("首个请求应放行: %d %s", w.Code, w.Body.String())
	}
	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, "")
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("第二个请求应 429，实得 %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "RATE_LIMITED") {
		t.Fatalf("429 信封缺 RATE_LIMITED: %s", w.Body.String())
	}
}

// TestFilesUpstreamUnreachableIsBadGateway：上游连不上时报 502，**不得**被误报成
// "客户端上传过慢"（旧的 url.Error.Timeout 判据会这样误报）。
func TestFilesUpstreamUnreachableIsBadGateway(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	deadAddr := "http://" + l.Addr().String()
	_ = l.Close()
	gw := newFilesGateway(t, deadAddr, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("status = %d (%s), want 502", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "UPSTREAM") {
		t.Fatalf("502 信封缺 UPSTREAM: %s", w.Body.String())
	}
	if strings.Contains(w.Body.String(), "上传过慢") {
		t.Fatalf("上游不可达被误报成客户端上传过慢: %s", w.Body.String())
	}
}

// TestFilesUploadOverLimitReturns413：声明了 Content-Length 的超限请求**先拒后转**。
func TestFilesUploadDeclaredOverLimitRejectedBeforeForwarding(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	prev := maxFilesUploadBody
	maxFilesUploadBody = 1024
	t.Cleanup(func() { maxFilesUploadBody = prev })

	big := bytes.NewReader(make([]byte, 4096))
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", big, gw.tokenA, "multipart/form-data; boundary=x")
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d (%s), want 413", w.Code, w.Body.String())
	}
	if up.hits.Load() != 0 {
		t.Fatalf("超限请求不应触达上游（%d 次）", up.hits.Load())
	}
}

// TestFilesUploadChunkedOverLimitReturns413：**未知长度**（chunked）的上传只能在
// 边读边转时由 MaxBytesReader 中断 —— 这条路径覆盖 filesBodyTracker 的 413 分类
// （声明长度的兄弟用例走的是"先拒后转"，覆盖不到它）。
func TestFilesUploadChunkedOverLimitReturns413(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":{"message":"truncated"}}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	prev := maxFilesUploadBody
	maxFilesUploadBody = 1024
	t.Cleanup(func() { maxFilesUploadBody = prev })

	// 用一层不识别的 wrapper 隐藏长度 ⇒ 传输层走 chunked，ContentLength 未知。
	body, ct := multipartBytes(t, strings.Repeat("y", 8192))
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", struct{ io.Reader }{bytes.NewReader(body)}, gw.tokenA, ct)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d (%s), want 413 请求体过大", w.Code, w.Body.String())
	}
}

// TestFilesSlowUploadSucceedsWithinBudget：**真实 http.Server** 上，全局
// ReadTimeout 只有 400ms，而上传耗时约 1.6s ⇒ 读预算（15s）必须救回来。
//
// 这条判据是审计 P0：此前所有 /files 用例都走 httptest.NewRecorder，而
// Recorder 的 SetReadDeadline 返回 ErrNotSupported ⇒ 把 handleFilesUpload 里的
// extendBodyReadDeadline 整行删掉，全包测试依然全绿（读预算在该路径上不可观测）。
func TestFilesSlowUploadSucceedsWithinBudget(t *testing.T) {
	setBodyReadBudget(t, 15*time.Second)
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	ts := httptest.NewUnstartedServer(gw.r)
	ts.Config.ReadTimeout = 400 * time.Millisecond
	ts.Start()
	t.Cleanup(ts.Close)

	body, ct := multipartBytes(t, strings.Repeat("z", 8*1024))
	req, err := http.NewRequest(http.MethodPost, ts.URL+"/v1/files",
		throttleReader(body, 1024, 200*time.Millisecond)) // 8 块 × 200ms ≈ 1.6s
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", ct)
	req.Header.Set("Authorization", "Bearer "+gw.tokenA)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("慢上传失败: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("慢上传 status = %d (%s)，读预算未生效", resp.StatusCode, raw)
	}
	if up.hits.Load() != 1 {
		t.Fatalf("上游应收到 1 次请求，实得 %d", up.hits.Load())
	}
}

// TestFilesEmptyUpstreamBodyKeepsStatus：204 保持无 body（HTTP 语义禁止），
// 且不写 Content-Type —— 这条断言让 204 子支具备判别力（只删子支会变红）。
func TestFilesEmptyUpstreamBodyKeepsStatus(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.RecordGatewayFile(gw.db, "file-abc", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}

	w := doFilesReq(t, gw.r, http.MethodDelete, "/v1/files/file-abc", nil, gw.tokenA, "")
	if w.Code != http.StatusNoContent {
		t.Fatalf("status = %d (%s), want 204", w.Code, w.Body.String())
	}
	if w.Body.Len() != 0 {
		t.Fatalf("204 不应带 body: %q", w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); ct != "" {
		t.Fatalf("204 不应写 Content-Type，实得 %q", ct)
	}
}

// TestFilesEmptyOKBodyBecomesJSON：上游空 200 ⇒ 客户端拿到 `{}` + JSON 类型。
func TestFilesEmptyOKBodyBecomesJSON(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if got := w.Body.String(); got != "{}" {
		t.Fatalf("body = %q, want {}", got)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json(§7.0)", ct)
	}
}

// TestFilesNonJSONUpstreamContentTypeIsNormalized：上游 2xx 给 text/html 时不得
// 原样透传（§7.0：服务端 API 一律 JSON）。
func TestFilesNonJSONUpstreamContentTypeIsNormalized(t *testing.T) {
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"object":"list","data":[]}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, "")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("content-type = %q, want application/json(§7.0)", ct)
	}
}

// TestFilesEnvelopeIsJSON：所有 /files 失败路径必须是 JSON 信封（§7.0 契约）。
func TestFilesEnvelopeIsJSON(t *testing.T) {
	up := newFakeFilesUpstream(t)
	gw := newFilesGateway(t, up.srv.URL, "some-other-vendor")

	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, "")
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("响应不是 JSON 信封: %s", w.Body.String())
	}
	if envelope.Error.Code == "" || envelope.Error.Message == "" {
		t.Fatalf("信封字段不全: %s", w.Body.String())
	}
}
