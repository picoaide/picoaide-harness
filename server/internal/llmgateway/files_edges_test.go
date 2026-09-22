package llmgateway

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// Files 直通的形态容错与出口脱敏（parseFileExpiry / filterFileList / relayFilesBody）
// ---------------------------------------------------------------------------

// TestFilesParseFileExpiryForms：expires_at 的形态容错。
//
// 官方口径是 **Unix 秒（number）**；数字字符串与 RFC3339 是容错。判据的重点是
// **非正数一律按"没给"处理**：`"0"`/`"-1"` 若按字面解析会得到 1970/1969，台账于是记成
// "上传即已过期"，回收器下一轮就会把上游那份**活文件**删掉。
func TestFilesParseFileExpiryForms(t *testing.T) {
	cases := []struct {
		raw  string
		ok   bool
		want int64 // 期望的 Unix 秒（ok=true 时比较）
	}{
		{`4102444800`, true, 4102444800},
		{`"4102444800"`, true, 4102444800},
		{`"2026-09-22T10:00:00Z"`, true, 1790071200},
		{`"2026-09-22T10:00:00.5Z"`, true, 1790071200},
		{`"0"`, false, 0},
		{`0`, false, 0},
		{`"-1"`, false, 0},
		{`-1`, false, 0},
		{`"  "`, false, 0},
		{``, false, 0},
		{`null`, false, 0},
		{`1.5`, false, 0},                    // 浮点形态漂移：按"没给"处理（收敛到上限）
		{`"99999999999999999999"`, false, 0}, // 超出 int64：按"没给"处理
		{`"not-a-time"`, false, 0},
	}
	for _, tc := range cases {
		got, ok := parseFileExpiry(json.RawMessage(tc.raw))
		if ok != tc.ok {
			t.Errorf("parseFileExpiry(%s) ok=%v, want %v", tc.raw, ok, tc.ok)
			continue
		}
		if ok && got.Unix() != tc.want {
			t.Errorf("parseFileExpiry(%s) = %d, want %d", tc.raw, got.Unix(), tc.want)
		}
	}
}

// TestFilesUploadLedgerNotImmediatelyExpiredByZeroExpiry：上游回 `expires_at:"0"` 时
// 台账必须记成**未来**（收敛到平台上限），而不是 1970 —— 后者会让回收器下一轮把
// 那份刚上传的活文件从上游删掉。
func TestFilesUploadLedgerNotImmediatelyExpiredByZeroExpiry(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"file-zero","object":"file","bytes":3,"expires_at":"0"}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	if w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct); w.Code != http.StatusOK {
		t.Fatalf("上传失败: %d %s", w.Code, w.Body.String())
	}
	var expires *time.Time
	if err := gw.db.QueryRow(`SELECT expires_at FROM gateway_files WHERE file_id = 'file-zero'`).Scan(&expires); err != nil {
		t.Fatalf("归属台账没写: %v", err)
	}
	if expires == nil || !expires.After(time.Now()) {
		t.Fatalf("expires_at=\"0\" 被解析成已过期时刻（%v）—— 回收器会立刻删掉活文件", expires)
	}
	if owned, err := serverstore.GatewayFileOwnedBy(gw.db, "file-zero", gw.uidA); err != nil || !owned {
		t.Fatalf("上传者必须立刻可用自己的文件: owned=%v err=%v", owned, err)
	}
}

// TestFilesListPreservesLargeIntegers：列表过滤会把整页解成 map 再编回去，
// 数字必须按字面保真（float64 往返会让 >2^53 的整数静默漂移）。
func TestFilesListPreservesLargeIntegers(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"list","data":[{"id":"file-mine","bytes":9007199254740993,"created_at":1758523200}],"has_more":false}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")
	if err := serverstore.RecordGatewayFile(gw.db, "file-mine", gw.uidA, nil); err != nil {
		t.Fatal(err)
	}

	w := doFilesReq(t, gw.r, http.MethodGet, "/v1/files", nil, gw.tokenA, "")
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d (%s)", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "9007199254740993") {
		t.Fatalf("列表项里的大整数在重编码中漂移: %s", w.Body.String())
	}
}

// TestFilesRelayRedactsKeyInPassthroughHeaders：白名单透传头（Retry-After /
// X-Request-Id）的值由上游控制，上游把 provider key 塞进去时同样必须脱敏 ——
// 头与体是两条独立的泄漏面（旧实现只脱敏体）。
func TestFilesRelayRedactsKeyInPassthroughHeaders(t *testing.T) {
	resetBodyParseGate(t)
	up := newFakeFilesUpstream(t)
	up.respond = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Retry-After", "7")
		w.Header().Set("X-Request-Id", "trace-"+upstreamKey)
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":{"message":"rate limited"}}`))
	}
	gw := newFilesGateway(t, up.srv.URL, "deepseek-official")

	body, ct := multipartBytes(t, "x")
	w := doFilesReq(t, gw.r, http.MethodPost, "/v1/files", bytes.NewReader(body), gw.tokenA, ct)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("status = %d (%s)", w.Code, w.Body.String())
	}
	if got := w.Header().Get("X-Request-Id"); strings.Contains(got, upstreamKey) {
		t.Fatalf("透传头里泄漏了 provider key: %q", got)
	} else if got == "" {
		t.Fatal("X-Request-Id 应保留（排障要用，只脱敏密钥片段）")
	}
	if got := w.Header().Get("Retry-After"); got != "7" {
		t.Fatalf("Retry-After 应原样透传，实得 %q", got)
	}
}
