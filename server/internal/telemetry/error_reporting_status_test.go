package telemetry

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const errorReportingPath = "/api/client/v2/telemetry/error-reporting"

// resetErrorReportingLimiter 重置包级错误上报限流桶。
// 限流器是**进程级共享**(跨用例),而每个用例各自建临时库、用户 id 都从 1
// 开始 —— 不重置就会与前一个用例互相挤占同一预算,用例顺序一变就假红。
func resetErrorReportingLimiter() {
	errorReportingLimiter = newCallLimiter(time.Minute)
}

// errorReportingRows 读回全部上报状态(按 updated_at 倒序)。
func errorReportingRows(t *testing.T, db *sql.DB) []serverstore.ClientErrorReportingStatus {
	t.Helper()
	rows, err := serverstore.ListErrorReportingStatuses(db, 100)
	if err != nil {
		t.Fatalf("ListErrorReportingStatuses: %v", err)
	}
	return rows
}

// TestReportErrorReportingStatus:合法上报 → 200 {"ok":true} 且落库;
// 同一用户再次上报走 upsert(仍只有一行、字段被覆盖)。
func TestReportErrorReportingStatus(t *testing.T) {
	resetErrorReportingLimiter()
	r, db, token := newTestEnv(t)

	w := post(r, token, errorReportingPath,
		`{"state":"ready","dsn_host":"glitchtip.example.com","level":"error","release":"picoaide-desktop@2.4.0"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("ready report = %d %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body["ok"] != true {
		t.Fatalf("ready report body = %s (err=%v)", w.Body.String(), err)
	}
	rows := errorReportingRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	got := rows[0]
	if got.Username != "alice" || got.State != serverstore.ErrorReportingStateReady ||
		got.DSNHost != "glitchtip.example.com" || got.Level != "error" || got.Release != "picoaide-desktop@2.4.0" {
		t.Fatalf("persisted row mismatch: %+v", got)
	}

	// 状态变化 = 覆盖同一行(客户端失败后重报 failed)。
	w = post(r, token, errorReportingPath,
		`{"state":"failed","reason":"init failed: invalid DSN","dsn_host":"glitchtip.example.com:8000","level":"error","release":"picoaide-desktop@2.4.0"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("failed report = %d %s", w.Code, w.Body.String())
	}
	rows = errorReportingRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("rows after re-report = %d, want 1 (upsert)", len(rows))
	}
	if rows[0].State != serverstore.ErrorReportingStateFailed || rows[0].Reason != "init failed: invalid DSN" {
		t.Fatalf("re-report did not overwrite: %+v", rows[0])
	}

	// 未认证 401(Bearer 由 router 挂载;此处验证测试路由树确实带认证)。
	w = post(r, "badtoken", errorReportingPath, `{"state":"ready"}`)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("unauth = %d", w.Code)
	}
}

// TestReportErrorReportingStatusRejectsUnknownState:白名单外的 state 静默
// 忽略(200 ok、**不落库**)—— 与 skill-call"未知技能静默成功"同语义:
// 遥测不得因为客户端版本比服务端新就变成错误,也不让未知取值进入聚合页。
func TestReportErrorReportingStatusRejectsUnknownState(t *testing.T) {
	r, db, token := newTestEnv(t)
	for _, body := range []string{`{"state":"bogus"}`, `{"state":""}`, `{}`} {
		w := post(r, token, errorReportingPath, body)
		if w.Code != http.StatusOK {
			t.Fatalf("unknown state %s = %d %s, want 200", body, w.Code, w.Body.String())
		}
		var out map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || out["ok"] != true {
			t.Fatalf("unknown state %s body = %s (err=%v)", body, w.Body.String(), err)
		}
	}
	if rows := errorReportingRows(t, db); len(rows) != 0 {
		t.Fatalf("unknown states must not be persisted, got %+v", rows)
	}
}

// TestReportErrorReportingStatusSanitizesFields:单字段不合法**不废掉整条
// 上报**(遥测非致命):reason 按 rune 截断、level 非法置空、dsn_host 只接受
// 裸主机名(可选端口;整条 DSN/URL 一律不落库)、release 截断到 64 字符。
func TestReportErrorReportingStatusSanitizesFields(t *testing.T) {
	resetErrorReportingLimiter()
	r, db, token := newTestEnv(t)

	longReason := strings.Repeat("中", 300)
	w := post(r, token, errorReportingPath,
		`{"state":"failed","reason":"`+longReason+`","dsn_host":"https://pubkey@glitchtip.example.com/1","level":"trace","release":"`+strings.Repeat("v", 100)+`"}`)
	if w.Code != http.StatusOK {
		t.Fatalf("sanitize report = %d %s", w.Code, w.Body.String())
	}
	rows := errorReportingRows(t, db)
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	got := rows[0]
	// 整条 DSN 含公钥:dsn_host 必须为空,绝不能原样落库。
	if got.DSNHost != "" {
		t.Fatalf("full DSN accepted into dsn_host: %q", got.DSNHost)
	}
	// 非法 level 丢弃该字段,但状态与原因仍然记录。
	if got.Level != "" || got.State != serverstore.ErrorReportingStateFailed {
		t.Fatalf("invalid level handling: %+v", got)
	}
	if utf8.RuneCountInString(got.Reason) != serverstore.ErrorReportingMaxReasonRunes || !utf8.ValidString(got.Reason) {
		t.Fatalf("reason runes = %d valid=%v, want %d valid", utf8.RuneCountInString(got.Reason), utf8.ValidString(got.Reason), serverstore.ErrorReportingMaxReasonRunes)
	}
	if len(got.Release) != serverstore.ErrorReportingMaxReleaseLen {
		t.Fatalf("release len = %d, want %d", len(got.Release), serverstore.ErrorReportingMaxReleaseLen)
	}

	// dsn_host:裸主机名与 host:port 收下(客户端报的是 URL.host,自建
	// GlitchTip 默认 8000 端口);URL/路径/带 @ 的值一律置空。
	for _, tc := range []struct{ in, want string }{
		{"glitchtip.example.com", "glitchtip.example.com"},
		{"glitchtip.example.com:8000", "glitchtip.example.com:8000"},
		{"glitchtip.example.com/1", ""},
		{"ftp://glitchtip.example.com", ""},
		{"pubkey@glitchtip.example.com", ""},
		{"glitchtip.example.com:99999", ""},
		{"-bad.example.com", ""},
		{strings.Repeat("h", 300), ""},
	} {
		body := `{"state":"ready","dsn_host":"` + tc.in + `"}`
		if w := post(r, token, errorReportingPath, body); w.Code != http.StatusOK {
			t.Fatalf("dsn_host %q = %d %s", tc.in, w.Code, w.Body.String())
		}
		rows := errorReportingRows(t, db)
		if len(rows) != 1 {
			t.Fatalf("rows = %d, want 1", len(rows))
		}
		if rows[0].DSNHost != tc.want {
			t.Fatalf("dsn_host %q persisted as %q, want %q", tc.in, rows[0].DSNHost, tc.want)
		}
	}

	// 请求体不是 JSON:与 skill-call 一致返回 400(客户端实现有问题,不是遥测语义)。
	w = post(r, token, errorReportingPath, `{broken`)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("broken json = %d %s", w.Code, w.Body.String())
	}
}

// TestReportErrorReportingStatusRateLimited:每用户 10 次/分钟;第 11 次返回
// 429 + RATE_LIMITED 信封(与 skill-call 同一限流算法与错误信封)。
func TestReportErrorReportingStatusRateLimited(t *testing.T) {
	resetErrorReportingLimiter()
	r, db, token := newTestEnv(t)
	const limit = 10
	for i := 0; i < limit; i++ {
		w := post(r, token, errorReportingPath, `{"state":"ready"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("report %d = %d %s, want 200", i+1, w.Code, w.Body.String())
		}
	}
	w := post(r, token, errorReportingPath, `{"state":"ready"}`)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("report %d = %d %s, want 429", limit+1, w.Code, w.Body.String())
	}
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		t.Fatalf("429 body not JSON envelope: %s (%v)", w.Body.String(), err)
	}
	if envelope.Error.Code != "RATE_LIMITED" || envelope.Error.Message == "" {
		t.Fatalf("429 envelope = %+v", envelope)
	}
	// 限流只压速率:前 10 次的状态已落库且仍是一行。
	rows := errorReportingRows(t, db)
	if len(rows) != 1 || rows[0].State != serverstore.ErrorReportingStateReady {
		t.Fatalf("rows after rate limit = %+v, want 1 ready row", rows)
	}
}
