package llmgateway

import (
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

const errorReportingClientsPath = "/api/server/admin/gateway/error-reporting/clients"

// TestErrorReportingClientsEmptyData:没有任何客户端上报过时,total=0、
// last_report_at 为空、items 为空数组 —— 管理端据此渲染"还没有任何客户端
// 上报",**不得**把这当成"一切正常(全员 ready)"(空数据 ≠ 绿灯)。
func TestErrorReportingClientsEmptyData(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	w, out := adminReq(t, r, "GET", errorReportingClientsPath, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("empty GET = %d %s", w.Code, w.Body.String())
	}
	if got := out["total"]; got != float64(0) {
		t.Fatalf("total = %v (%T), want 0", got, got)
	}
	if got, ok := out["last_report_at"]; !ok || got != "" {
		t.Fatalf("last_report_at = %v (present=%v), want empty string", got, ok)
	}
	for _, key := range []string{"ready", "disabled", "failed", "config_unavailable", "idle"} {
		v, ok := out[key]
		if !ok {
			t.Fatalf("counter %q missing from response: %s", key, w.Body.String())
		}
		if v != float64(0) {
			t.Fatalf("counter %q = %v, want 0", key, v)
		}
	}
	items, ok := out["items"].([]any)
	if !ok {
		t.Fatalf("items is %T, want JSON array (empty): %s", out["items"], w.Body.String())
	}
	if len(items) != 0 {
		t.Fatalf("items = %v, want empty", items)
	}
}

// TestErrorReportingClientsAggregate:五个状态计数 + total + last_report_at +
// items(updated_at 倒序、字段契约)与落库数据一致。
func TestErrorReportingClientsAggregate(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	type seed struct{ user, state, reason, host, level string }
	seeds := []seed{
		{"alice", serverstore.ErrorReportingStateReady, "", "glitchtip.example.com", "error"},
		{"bob", serverstore.ErrorReportingStateReady, "", "glitchtip.example.com", "warning"},
		{"carol", serverstore.ErrorReportingStateDisabled, "", "", ""},
		{"dave", serverstore.ErrorReportingStateFailed, "Sentry init 失败: DSN 非法", "localhost:8000", "error"},
	}
	for _, s := range seeds {
		uid, err := serverstore.CreateUserWithPassword(db, s.user, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		if err := serverstore.UpsertErrorReportingStatus(db, uid, s.state, s.reason, s.host, s.level, "picoaide-desktop@2.4.0"); err != nil {
			t.Fatal(err)
		}
	}

	w, out := adminReq(t, r, "GET", errorReportingClientsPath, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d %s", w.Code, w.Body.String())
	}
	for key, want := range map[string]float64{"ready": 2, "disabled": 1, "failed": 1, "config_unavailable": 0, "idle": 0, "total": 4} {
		if got := out[key]; got != want {
			t.Fatalf("%s = %v, want %v (body=%s)", key, got, want, w.Body.String())
		}
	}
	items, ok := out["items"].([]any)
	if !ok || len(items) != len(seeds) {
		t.Fatalf("items = %v, want %d entries", out["items"], len(seeds))
	}
	// updated_at 倒序:最后写入的 dave 排第一。
	first, ok := items[0].(map[string]any)
	if !ok {
		t.Fatalf("item[0] = %T", items[0])
	}
	if first["username"] != "dave" || first["state"] != serverstore.ErrorReportingStateFailed {
		t.Fatalf("item[0] = %v, want dave/failed (items=%v)", first, items)
	}
	if first["reason"] != "Sentry init 失败: DSN 非法" || first["dsn_host"] != "localhost:8000" ||
		first["level"] != "error" || first["release"] != "picoaide-desktop@2.4.0" {
		t.Fatalf("item[0] field contract mismatch: %v", first)
	}
	updatedAt, _ := first["updated_at"].(string)
	if _, err := time.Parse(time.RFC3339, updatedAt); err != nil {
		t.Fatalf("item updated_at = %q, not RFC3339: %v", updatedAt, err)
	}
	if out["last_report_at"] != updatedAt {
		t.Fatalf("last_report_at = %v, want %q (newest item)", out["last_report_at"], updatedAt)
	}
}

// TestErrorReportingClientsCapsItems:items 上限 100(按 updated_at 倒序),
// total 仍是全表行数 —— 列表被截断不得让总数变小。
func TestErrorReportingClientsCapsItems(t *testing.T) {
	r, db, hdr := adminTestSetup(t)
	defer db.Close()

	// 直接批量造 101 个用户 + 各自的 ready 状态(不走 argon2 建号,保持用例快)。
	if _, err := db.Exec(`INSERT INTO users (username) SELECT 'bulk' || i FROM generate_series(1, 101) AS i`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO client_error_reporting_status (user_id, state, updated_at)
		SELECT id, 'ready', now() FROM users WHERE username LIKE 'bulk%'`); err != nil {
		t.Fatal(err)
	}

	w, out := adminReq(t, r, "GET", errorReportingClientsPath, "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("GET = %d %s", w.Code, w.Body.String())
	}
	if got := out["total"]; got != float64(101) {
		t.Fatalf("total = %v, want 101", got)
	}
	if got := out["ready"]; got != float64(101) {
		t.Fatalf("ready = %v, want 101", got)
	}
	items, ok := out["items"].([]any)
	if !ok || len(items) != 100 {
		t.Fatalf("items len = %d (ok=%v), want 100", len(items), ok)
	}
}
