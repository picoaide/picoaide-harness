package reports

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestShouldRunMonthly(t *testing.T) {
	now := time.Date(2026, 9, 2, 10, 0, 0, 0, time.Local)
	cases := []struct {
		last *time.Time
		want bool
	}{
		{nil, true},
		{ptr(time.Date(2026, 8, 31, 23, 0, 0, 0, time.Local)), true}, // 上月
		{ptr(time.Date(2025, 12, 5, 0, 0, 0, 0, time.Local)), true},  // 跨年
		{ptr(time.Date(2026, 9, 1, 9, 0, 0, 0, time.Local)), false},  // 本月已跑
	}
	for _, c := range cases {
		if got := ShouldRunMonthly(now, c.last); got != c.want {
			t.Fatalf("ShouldRunMonthly(%v) = %v, want %v", c.last, got, c.want)
		}
	}
}

func ptr(v time.Time) *time.Time { return &v }

func recordUsage(t *testing.T, db *sql.DB, userID int64, model string, pt, ct int64, at time.Time) {
	t.Helper()
	_, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, cache_prompt_tokens, kind, cost, created_at)
		VALUES (?, ?, ?, ?, 0, 'chat', 0.1, ?)`, userID, model, pt, ct, at.Format("2006-01-02 15:04:05"))
	if err != nil {
		t.Fatal(err)
	}
}

func TestGenerateMonthlyReport(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()

	u1, _ := serverstore.CreateUser(db, &serverstore.User{Username: "r1", Source: "local", Status: 1})
	u2, _ := serverstore.CreateUser(db, &serverstore.User{Username: "r2", Source: "local", Status: 1})
	// 上月内两条(2026-08)、本月一条(2026-09,不应计入)
	recordUsage(t, db, u1, "m1", 1000, 100, time.Date(2026, 8, 15, 10, 0, 0, 0, time.Local))
	recordUsage(t, db, u2, "m1", 2000, 200, time.Date(2026, 8, 16, 10, 0, 0, 0, time.Local))
	recordUsage(t, db, u1, "m2", 99999, 0, time.Date(2026, 9, 1, 10, 0, 0, 0, time.Local))

	body, err := GenerateMonthlyReport(db, time.Date(2026, 9, 5, 0, 0, 0, 0, time.Local))
	if err != nil {
		t.Fatal(err)
	}
	if body.Period != "2026-08" {
		t.Fatalf("period = %s", body.Period)
	}
	if body.Total.Requests != 2 || body.Total.Tokens != 3300 {
		t.Fatalf("total = %+v", body.Total)
	}
	if len(body.TopModels) != 1 || body.TopModels[0].Label != "m1" {
		t.Fatalf("top models = %+v", body.TopModels)
	}
	if len(body.TopUsers) != 2 {
		t.Fatalf("top users = %+v", body.TopUsers)
	}
}

func TestPushWebhook(t *testing.T) {
	got := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- string(b)
		w.WriteHeader(200)
	}))
	defer srv.Close()

	body := &ReportBody{Type: TypeMonthly, Period: "2026-08"}
	if err := PushWebhook(context.Background(), srv.URL, body); err != nil {
		t.Fatal(err)
	}
	payload := <-got
	if !strings.Contains(payload, "monthly_usage_report") {
		t.Fatalf("payload = %s", payload)
	}
}

func reqJSON(t *testing.T, r http.Handler, method, path, body, session, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != "" {
		reader = strings.NewReader(body)
	} else {
		reader = strings.NewReader("")
	}
	req := httptest.NewRequest(method, path, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if session != "" {
		req.AddCookie(&http.Cookie{Name: "picoaide_session", Value: session})
	}
	if method != "GET" && csrf != "" {
		req.Header.Set("X-CSRF-Token", csrf)
	}
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestSubscriptionAPI(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef")

	uid, _ := serverstore.CreateUser(db, &serverstore.User{Username: "boss", Source: "local", Status: 1, Role: serverstore.RoleSuperAdmin})
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	rcvd := make(chan string, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		select {
		case rcvd <- string(b):
		default:
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	gin.SetMode(gin.TestMode)
	r := gin.New()
	reg := r.Group("/api/server/admin", serverauth.AdminAuth(db))
	h := NewHandlers(db)
	reg.GET("/report-subscriptions", h.List)
	reg.POST("/report-subscriptions", h.Create)
	reg.PUT("/report-subscriptions/:id", h.Update)
	reg.DELETE("/report-subscriptions/:id", h.Delete)
	reg.POST("/report-subscriptions/:id/test", h.TestPush)

	// 创建
	w := reqJSON(t, r, "POST", "/api/server/admin/report-subscriptions",
		`{"name":"钉钉推送","hook_url":"`+srv.URL+`","enabled":true}`, sess.ID, csrf)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)

	// 列表
	w = reqJSON(t, r, "GET", "/api/server/admin/report-subscriptions", "", sess.ID, "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "钉钉推送") {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}

	// 测试推送(提交空报表也应成功)
	w = reqJSON(t, r, "POST", "/api/server/admin/report-subscriptions/"+fmt.Sprintf("%d", out.ID)+"/test", "", sess.ID, csrf)
	if w.Code != 200 {
		t.Fatalf("test push: %d %s", w.Code, w.Body.String())
	}
	select {
	case p := <-rcvd:
		if !strings.Contains(p, "monthly_usage_report") {
			t.Fatalf("webhook payload = %s", p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("webhook not called")
	}

	// 更新(禁用)
	w = reqJSON(t, r, "PUT", "/api/server/admin/report-subscriptions/"+fmt.Sprintf("%d", out.ID),
		`{"name":"钉钉推送","hook_url":"`+srv.URL+`","enabled":false}`, sess.ID, csrf)
	if w.Code != 200 {
		t.Fatalf("update: %d", w.Code)
	}
	// 删除
	w = reqJSON(t, r, "DELETE", "/api/server/admin/report-subscriptions/"+fmt.Sprintf("%d", out.ID), "", sess.ID, csrf)
	if w.Code != 200 {
		t.Fatalf("delete: %d", w.Code)
	}
	// 审计:创建/删除留痕
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action IN ('report_subscription_create','report_subscription_delete')`).Scan(&n)
	if n != 2 {
		t.Fatalf("audit rows = %d", n)
	}
}

func TestDispatchAll(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	got := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case got <- struct{}{}:
		default:
		}
		w.WriteHeader(200)
	}))
	defer srv.Close()

	id, _ := serverstore.CreateReportSubscription(db, "s1", srv.URL, true)
	_, _, err := DispatchAll(context.Background(), db, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-got:
	case <-time.After(2 * time.Second):
		t.Fatal("webhook not called by dispatch")
	}
	subs, _ := serverstore.ListReportSubscriptions(db)
	for _, s := range subs {
		if s.ID == id && s.LastRunAt == nil {
			t.Fatal("last_run_at not updated")
		}
	}
}
