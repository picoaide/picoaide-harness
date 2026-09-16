package llmgateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"
)

// errReportingRewriteTransport 把出站请求重写到 httptest 服务器,使用例
// **零真实网络**:DSN 主机用 TEST-NET-3 字面 IP(203.0.113.0/24,RFC 5737),
// 它既不是环回/私网(校验通过),又不需要 DNS 解析(CheckOutboundTarget 对
// 字面 IP 直接判定)。
type errReportingRewriteTransport struct{ target *url.URL }

func (t errReportingRewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	clone := req.Clone(req.Context())
	clone.URL.Scheme = t.target.Scheme
	clone.URL.Host = t.target.Host
	return http.DefaultTransport.RoundTrip(clone)
}

// useRewriteClient 让包级 client 工厂在用例期间改写到给定 httptest 服务器。
func useRewriteClient(t *testing.T, srvURL string) {
	t.Helper()
	target, err := url.Parse(srvURL)
	if err != nil {
		t.Fatalf("parse test server url: %v", err)
	}
	prev := errorReportingTestClient
	errorReportingTestClient = func() *http.Client {
		return &http.Client{
			Timeout:       errorReportingTestTimeout,
			Transport:     errReportingRewriteTransport{target: target},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		}
	}
	t.Cleanup(func() { errorReportingTestClient = prev })
}

var eventIDRe = regexp.MustCompile(`^[0-9a-f]{32}$`)

// TestErrorReportingTestEventSuccess:后端可达时,handler 必须 200,event_id 是
// 32 位十六进制,且 mock 侧真的收到了正确的 X-Sentry-Auth 与可解析的事件体。
func TestErrorReportingTestEventSuccess(t *testing.T) {
	var (
		gotAuth string
		gotBody map[string]any
		gotPath string
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("X-Sentry-Auth")
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"event_id":"` + "0123456789abcdef0123456789abcdef" + `"}`))
	}))
	defer srv.Close()
	useRewriteClient(t, srv.URL)

	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	const dsn = "https://test-public-key@203.0.113.7/1"
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"error_reporting_dsn":"`+dsn+`"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("seed dsn: %d %s", w.Code, w.Body.String())
	}

	w, out := adminReq(t, r, "POST", "/api/server/admin/gateway/error-reporting/test", `{}`, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("test event: %d %s", w.Code, w.Body.String())
	}
	if out["ok"] != true {
		t.Fatalf("ok = %v, want true (%v)", out["ok"], out)
	}
	eventID, _ := out["event_id"].(string)
	if !eventIDRe.MatchString(eventID) {
		t.Fatalf("event_id = %q, want 32 hex", eventID)
	}
	if !strings.Contains(gotAuth, "sentry_key=test-public-key") {
		t.Fatalf("X-Sentry-Auth = %q, want sentry_key=test-public-key", gotAuth)
	}
	if !strings.Contains(gotAuth, "sentry_version=7") {
		t.Fatalf("X-Sentry-Auth = %q, want sentry_version=7", gotAuth)
	}
	if gotPath != "/api/1/store/" {
		t.Fatalf("store path = %q, want /api/1/store/", gotPath)
	}
	if gotBody["message"] != "PicoAide 管理端连通性自检" {
		t.Fatalf("event message = %v, want 管理端连通性自检", gotBody["message"])
	}
	if gotBody["level"] != "error" {
		t.Fatalf("event level = %v, want error", gotBody["level"])
	}
	// AC3/D3:必须标注"服务端视角"这一局限。
	if note, _ := out["note"].(string); !strings.Contains(note, "服务端") || !strings.Contains(note, "员工客户端") {
		t.Fatalf("note = %q, want explicit server-perspective caveat", note)
	}
	if ep, _ := out["endpoint"].(string); ep != "https://203.0.113.7/api/1/store/" {
		t.Fatalf("endpoint = %q, want derived store endpoint", ep)
	}
}

// TestErrorReportingTestEventConnectRefused:端口关掉 ⇒ 502 + kind=CONNECT。
func TestErrorReportingTestEventConnectRefused(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := srv.URL
	srv.Close() // 立刻关闭 ⇒ 该端口上必然 ECONNREFUSED

	inspection := ErrorReportingDSN{
		Verdict:       ErrorReportingDSNAccept,
		Host:          "127.0.0.1",
		ProjectID:     "1",
		PublicKey:     "key",
		StoreEndpoint: deadURL + "/api/1/store/",
	}
	got := sendErrorReportingTestEvent(context.Background(), inspection, "test")
	if got.OK {
		t.Fatalf("closed port reported success: %+v", got)
	}
	if got.Kind != ErrorReportingKindConnect {
		t.Fatalf("kind = %s (%s), want CONNECT", got.Kind, got.Detail)
	}
}

// TestErrorReportingTestEventHTTP4xx:上报服务返回 403 ⇒ kind=HTTP_4XX,
// 且 http_status 透出给管理员。
func TestErrorReportingTestEventHTTP4xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"detail":"invalid api key"}`))
	}))
	defer srv.Close()

	inspection := ErrorReportingDSN{
		Verdict:       ErrorReportingDSNAccept,
		Host:          "127.0.0.1",
		ProjectID:     "1",
		PublicKey:     "key",
		StoreEndpoint: srv.URL + "/api/1/store/",
	}
	got := sendErrorReportingTestEvent(context.Background(), inspection, "test")
	if got.OK {
		t.Fatalf("403 reported success: %+v", got)
	}
	if got.Kind != ErrorReportingKindHTTP4xx {
		t.Fatalf("kind = %s, want HTTP_4XX", got.Kind)
	}
	if got.HTTPStatus != http.StatusForbidden {
		t.Fatalf("http_status = %d, want 403", got.HTTPStatus)
	}
	if !strings.Contains(got.Detail, "invalid api key") {
		t.Fatalf("detail = %q, want upstream body excerpt", got.Detail)
	}
}

// TestErrorReportingTestEventTimeout:mock 挂住 ⇒ kind=TIMEOUT。
// 收缩包级超时,用例不必真等 8 秒。
func TestErrorReportingTestEventTimeout(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(3 * time.Second)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	prevTimeout := errorReportingTestTimeout
	errorReportingTestTimeout = 200 * time.Millisecond
	t.Cleanup(func() { errorReportingTestTimeout = prevTimeout })

	inspection := ErrorReportingDSN{
		Verdict:       ErrorReportingDSNAccept,
		Host:          "127.0.0.1",
		ProjectID:     "1",
		PublicKey:     "key",
		StoreEndpoint: srv.URL + "/api/1/store/",
	}
	started := time.Now()
	got := sendErrorReportingTestEvent(context.Background(), inspection, "test")
	if got.OK {
		t.Fatalf("timeout reported success: %+v", got)
	}
	if got.Kind != ErrorReportingKindTimeout {
		t.Fatalf("kind = %s (%s), want TIMEOUT", got.Kind, got.Detail)
	}
	// 必须真的按收缩后的超时返回,而不是等满默认 8 秒。
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("timeout took %s, want <= 2s (injected timeout not honoured)", elapsed)
	}
}

// TestErrorReportingTestEventRejectsLoopbackDsn:坏 DSN 在**发任何网络请求之前**
// 就被同一套校验规则拒绝(400 + VALIDATION),而不是先连一次再报错。
func TestErrorReportingTestEventRejectsLoopbackDsn(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("loopback dsn must be rejected before any outbound request, got %s", r.URL)
	}))
	defer srv.Close()
	useRewriteClient(t, srv.URL)

	r, db, hdr := adminTestSetup(t)
	defer db.Close()
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway",
		`{"error_reporting_dsn":"https://test-public-key@203.0.113.7/1"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("seed dsn: %d %s", w.Code, w.Body.String())
	}

	// 显式传坏 DSN(缺省用已保存值;这里覆盖成现场值)。
	w, out := adminReq(t, r, "POST", "/api/server/admin/gateway/error-reporting/test",
		`{"dsn":"http://key@localhost:8000/1"}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("loopback dsn accepted: %d %s", w.Code, w.Body.String())
	}
	env, _ := out["error"].(map[string]any)
	if env == nil || env["code"] != "VALIDATION" || env["message"] != ErrorReportingDSNBlockedMessage {
		t.Fatalf("envelope = %v, want VALIDATION + blocked message", out)
	}

	// 未配置 DSN 时给出明确中文提示,而不是静默成功。
	if w, _ := adminReq(t, r, "PUT", "/api/server/admin/gateway", `{"error_reporting_dsn":""}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("clear dsn: %d", w.Code)
	}
	w, out = adminReq(t, r, "POST", "/api/server/admin/gateway/error-reporting/test", `{}`, hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("empty dsn test event = %d, want 400 (%s)", w.Code, w.Body.String())
	}
	env, _ = out["error"].(map[string]any)
	if env == nil || env["code"] != "VALIDATION" {
		t.Fatalf("envelope = %v, want VALIDATION", out)
	}
}
