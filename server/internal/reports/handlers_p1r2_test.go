package reports

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// 第二轮审计 P1-4 / P1-5 回归(2026-09-12)。
//
// 文件名刻意独立于 reports_test.go:同一轮里 server(组 A)也在这两个文件里
// 工作,新增独立测试文件避免并行改动冲突。复用 reports_test.go 的
// reqJSON / allowLocalWebhooks 帮助函数(同包)。

const secretHookKey = "key=SUPER-SECRET-BOT-KEY"

// newReportTestRouter 建真 handler + 真 PG(与 TestSubscriptionAPI 同构)。
func newReportTestRouter(t *testing.T) (*gin.Engine, *sql.DB, string, string) {
	t.Helper()
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef")

	uid, _ := serverstore.CreateUser(db, &serverstore.User{Username: "boss", Source: "local", Status: 1, Role: serverstore.RoleSuperAdmin})
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	reg := r.Group("/api/server/admin", serverauth.AdminAuth(db))
	h := NewHandlers(db)
	reg.GET("/report-subscriptions", h.List)
	reg.POST("/report-subscriptions", h.Create)
	reg.PUT("/report-subscriptions/:id", h.Update)
	reg.DELETE("/report-subscriptions/:id", h.Delete)
	reg.POST("/report-subscriptions/:id/test", h.TestPush)
	return r, db, sess.ID, csrf
}

// P1-5:校验用 trim 后的值、落库用原文 ⇒ 201 成功但订阅永久发不出去。
func TestCreateNormalizesHookURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	r, db, sess, csrf := newReportTestRouter(t)

	// 带前后空格提交(旧实现:201,库里存原文,后续 http.NewRequest 必失败)
	w := reqJSON(t, r, "POST", "/api/server/admin/report-subscriptions",
		`{"name":"带空格","hook_url":"  `+srv.URL+`  ","enabled":true}`, sess, csrf)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)

	// ① 落库值必须是归一化后的(无前后空格)。
	var stored string
	if err := db.QueryRow(`SELECT hook_url FROM report_subscriptions WHERE id = ?`, out.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != srv.URL {
		t.Fatalf("落库 hook_url = %q,期望归一化后的 %q", stored, srv.URL)
	}

	// ② 真正的行为断言:测试推送必须成功(改前 NewRequest 报
	//    `parse " https://… ": first path segment in URL cannot contain colon` → 502)。
	w = reqJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/report-subscriptions/%d/test", out.ID), "", sess, csrf)
	if w.Code != http.StatusOK {
		t.Fatalf("test push: %d %s", w.Code, w.Body.String())
	}
}

// P1-4:hook_url 是凭据本体,列表响应只回哨兵;明文仍留在库里供推送使用。
func TestListMasksHookURL(t *testing.T) {
	r, db, sess, _ := newReportTestRouter(t)
	raw := "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?" + secretHookKey
	id, err := serverstore.CreateReportSubscription(db, "企微群", raw, true)
	if err != nil {
		t.Fatal(err)
	}

	w := reqJSON(t, r, "GET", "/api/server/admin/report-subscriptions", "", sess, "")
	if w.Code != 200 {
		t.Fatalf("list: %d", w.Code)
	}
	if strings.Contains(w.Body.String(), secretHookKey) || strings.Contains(w.Body.String(), raw) {
		t.Fatalf("列表响应泄漏了 hook_url 明文: %s", w.Body.String())
	}
	var out struct {
		Subscriptions []struct {
			ID      int64  `json:"id"`
			HookURL string `json:"hook_url"`
		} `json:"subscriptions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Subscriptions) != 1 {
		t.Fatalf("subscriptions = %d", len(out.Subscriptions))
	}
	if out.Subscriptions[0].HookURL != serverstore.MaskedHookURL {
		t.Fatalf("hook_url = %q,期望哨兵 %q", out.Subscriptions[0].HookURL, serverstore.MaskedHookURL)
	}

	// 内部消费者(调度器/PushWebhook)仍必须拿到明文,否则订阅直接失效。
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || subs[0].ID != id || subs[0].HookURL != raw {
		t.Fatalf("DAO 侧明文被破坏: %+v", subs)
	}
}

// P1-4:审计 detail 只写 name/id(改前落 hook_url 原文 → auditor 读审计即可拿回凭据)。
func TestAuditDetailOmitsHookURL(t *testing.T) {
	r, db, sess, csrf := newReportTestRouter(t)
	raw := "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?" + secretHookKey

	w := reqJSON(t, r, "POST", "/api/server/admin/report-subscriptions",
		`{"name":"企微群","hook_url":"`+raw+`","enabled":true}`, sess, csrf)
	if w.Code != http.StatusCreated {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &out)

	// 更新(只改启用状态,hook_url 留空 = 保持现值)
	w = reqJSON(t, r, "PUT", fmt.Sprintf("/api/server/admin/report-subscriptions/%d", out.ID),
		`{"name":"企微群","hook_url":"","enabled":false}`, sess, csrf)
	if w.Code != 200 {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}

	rows, err := db.Query(`SELECT action, detail FROM audit_logs WHERE action LIKE 'report_subscription_%' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	seen := 0
	for rows.Next() {
		var action, detail string
		if err := rows.Scan(&action, &detail); err != nil {
			t.Fatal(err)
		}
		seen++
		if strings.Contains(detail, secretHookKey) || strings.Contains(detail, "qyapi.weixin.qq.com") {
			t.Fatalf("%s 的审计 detail 泄漏 hook_url: %q", action, detail)
		}
		if !strings.Contains(detail, "企微群") {
			t.Fatalf("%s 的审计 detail 丢了订阅标识: %q", action, detail)
		}
	}
	if seen < 2 {
		t.Fatalf("审计行数 = %d,期望 >= 2", seen)
	}

	// 留空 = 保持现值:库里仍是明文,推送链路不受影响。
	var stored string
	if err := db.QueryRow(`SELECT hook_url FROM report_subscriptions WHERE id = ?`, out.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != raw {
		t.Fatalf("hook_url 被空值覆盖为 %q", stored)
	}
}

// P1-4:last_error 只落类别(net/http 错误串会回显带 key 的完整 URL)。
func TestMarkReportRunStoresCategoryOnly(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	id, err := serverstore.CreateReportSubscription(db, "s", "https://example.com/hook?"+secretHookKey, true)
	if err != nil {
		t.Fatal(err)
	}

	// 这是 net/http 的真实错误形状:错误串里带完整目标 URL。
	full := `Post "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?` + secretHookKey + `": dial tcp 1.2.3.4:443: connect: connection refused`
	if err := serverstore.MarkReportRun(db, id, false, full); err != nil {
		t.Fatal(err)
	}
	var lastErr string
	if err := db.QueryRow(`SELECT last_error FROM report_subscriptions WHERE id = ?`, id).Scan(&lastErr); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(lastErr, "SUPER-SECRET") || strings.Contains(lastErr, "qyapi") {
		t.Fatalf("last_error 仍含目标地址: %q", lastErr)
	}
	if lastErr != "目标拒绝连接" {
		t.Fatalf("last_error = %q,期望类别标签", lastErr)
	}

	// JSON 出口(列表响应)同样不得带出明文。
	subs, _ := serverstore.ListReportSubscriptions(db)
	b, err := json.Marshal(subs)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "SUPER-SECRET") {
		t.Fatalf("ReportSubscription JSON 泄漏明文: %s", b)
	}

	// 更新订阅成功一次后 last_error 必须被清空(MarkReportRun(ok=true))。
	if err := serverstore.MarkReportRun(db, id, true, ""); err != nil {
		t.Fatal(err)
	}
	_ = db.QueryRow(`SELECT last_error FROM report_subscriptions WHERE id = ?`, id).Scan(&lastErr)
	if lastErr != "" {
		t.Fatalf("成功后 last_error 未清空: %q", lastErr)
	}

	// 配置变更(UPDATE)也必须清旧错误:旧失败原因不再代表当前配置。
	_ = serverstore.MarkReportRun(db, id, false, full)
	if err := serverstore.UpdateReportSubscription(db, id, "s2", "", true); err != nil {
		t.Fatal(err)
	}
	_ = db.QueryRow(`SELECT last_error FROM report_subscriptions WHERE id = ?`, id).Scan(&lastErr)
	if lastErr != "" {
		t.Fatalf("UPDATE 未清空 last_error: %q", lastErr)
	}
}

// SanitizeReportError 的输入覆盖:带 URL 的一律去地址化,不带 URL 的保留原样。
func TestSanitizeReportError(t *testing.T) {
	cases := []struct{ in, want string }{
		// PushWebhook 的三类真实错误形状,全部含目标 URL(带 key=…)
		{`Post "https://qyapi.weixin.qq.com/x?key=` + secretHookKey + `": dial tcp: connect: connection refused`, "目标拒绝连接"},
		{`Post "https://hook.example/x?key=` + secretHookKey + `": dial tcp: lookup hook.example: no such host`, "目标主机无法解析"},
		{`parse " https://hook.example/x?key=` + secretHookKey + ` ": first path segment in URL cannot contain colon`, "目标地址格式无法解析"},
		{`hook_url 不合法: 不允许指向内网/回环地址`, "hook_url 不合法: 不允许指向内网/回环地址"},
		// 不含 URL 的短消息保留原文(last_error 的既有可观测性契约)
		{"webhook 502", "webhook 502"},
		{"", ""},
	}
	for _, c := range cases {
		got := serverstore.SanitizeReportError(c.in)
		if got != c.want {
			t.Fatalf("SanitizeReportError(%q) = %q, want %q", c.in, got, c.want)
		}
		if strings.Contains(got, secretHookKey) {
			t.Fatalf("SanitizeReportError(%q) 仍含凭据", c.in)
		}
	}
}
