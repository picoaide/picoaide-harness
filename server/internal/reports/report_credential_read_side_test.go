package reports_test

// 第三轮审计残留①-B 回归(2026-09-13):历史审计行里的 webhook 凭据对只读角色
// 仍可读。
//
// 上一轮(reports/handlers.go 的 FIX-13/P1-4)堵住了列表出口(hook_url 走
// MarshalJSON 脱敏)与调度失败出口(last_error 过 SanitizeReportError),
// 但**≤beta.7 写入 0048 哈希链的历史审计行** detail 里仍是明文 URL,而
// audit:read(auditor 持有)**不含** report:read ⇒ 只读角色照样读到凭据。
// 历史行不能改写(会断链),只能在**读时**按查看者权限脱敏。
// (同轮残留①-A「test push 502 回显 URL」由同包的
//  report_push_error_sanitize_test.go 覆盖:那条需要本包内部的 SSRF 放行开关,
//  而 router 包依赖 reports ⇒ 本文件只能用外部测试包 reports_test。)
//
// 本文件用**生产路由表**(router.Register,与 cmd/server 同一份声明)+ 真 PG +
// 真 AdminAuth/RequirePermission/真 handler 端到端断言,不手搓 mini router,
// 也不硬编码权限名(角色口径由真 403/200 行为体现)。
//
// 运行:
//   cd server && export GOCACHE=… GOMODCACHE=… GOPROXY=… GOFLAGS=-mod=mod GOSUMDB=off
//   PG_DSN_TEST="postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable" \
//     go test ./internal/reports/ -run 'TestReportCredential' -count=1 -p 1 -v

import (
	"database/sql"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
)

const r3Secret = "SUPER-SECRET-BOT-KEY"

// r3ProdRouter 组装**生产路由表**:与 cmd/server/main.go 同样调用
// router.Register(这里是集中声明权限的唯一真源),只把 DB 换成临时测试库。
func r3ProdRouter(t *testing.T) (*gin.Engine, *sql.DB) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef")

	r := gin.New()
	router.Register(r, router.Deps{
		DB:            db,
		Auth:          serverauth.New(db).Handlers(),
		Admin:         (&serverauth.AdminAPI{DB: db}).Handlers(),
		Appstore:      appstore.NewHandlers(db),
		Bootstrap:     bootstrap.NewHandlers(db),
		Channel:       channel.NewHandlers(),
		PortalAdmin:   portal.NewAdminHandlers(db),
		ClientRelease: clientrelease.NewHandlers(func() string { return "2.7.2" }, "official"),
		Market:        marketplace.NewHandlers(db, t.TempDir()),
		Agentshare:    agentshare.NewHandlers(db, t.TempDir()),
		Shared:        sharedskills.NewHandlers(db, t.TempDir()),
		Capability:    capabilities.NewHandlers(db, t.TempDir()),
		Connector:     connectors.NewHandlers(db),
		Telemetry:     telemetry.NewHandlers(db),
		Gateway:       llmgateway.NewHandlers(db),
		Reports:       reports.NewHandlers(db),
	})
	return r, db
}

// r3Admin 建一个真用户 + 真管理会话(角色决定权限口径)。
func r3Admin(t *testing.T, db *sql.DB, name, role string) (session, csrf string) {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: name, Source: "local", Status: 1, Role: role})
	if err != nil {
		t.Fatalf("create user %s: %v", name, err)
	}
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatalf("create admin session %s: %v", name, err)
	}
	return sess.ID, csrf
}

// r3Req 走真 HTTP 栈(gin 路由 → AdminAuth → RequirePermission → handler)。
func r3Req(t *testing.T, r http.Handler, method, path, body, session, csrf string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
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

// TestReportCredentialHistoricalAuditRowRedaction:≤beta.7 写入哈希链的历史审计行
// (detail 带明文 hook URL)对**无 report:read** 的 auditor 读时脱敏;
// super_admin(持 report:read)仍读到原文;库内原文与哈希链逐字节不变。
func TestReportCredentialHistoricalAuditRowRedaction(t *testing.T) {
	r, db := r3ProdRouter(t)
	asess, _ := r3Admin(t, db, "auditor-hist", serverstore.RoleAuditor)
	ssess, _ := r3Admin(t, db, "boss-hist", serverstore.RoleSuperAdmin)

	// 真实历史形态:base 版本 handler 写的就是 "名称 + 明文 URL"。
	raw := "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + r3Secret
	detail := "bot-legacy " + raw
	if err := serverstore.AuditLog(db, "boss-hist", "report_subscription_create", detail); err != nil {
		t.Fatalf("seed legacy audit row: %v", err)
	}

	// ① 读侧脱敏必须发生在**读时**:库内原文与哈希链都不能被动过。
	var stored string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1`,
		"report_subscription_create").Scan(&stored); err != nil {
		t.Fatalf("read stored detail: %v", err)
	}
	if stored != detail {
		t.Fatalf("库内审计原文被改写 = %q, want %q(会断链)", stored, detail)
	}
	if brokenID, err := serverstore.VerifyAuditChain(db); err != nil {
		t.Fatalf("哈希链在读侧脱敏后断裂(id=%d): %v", brokenID, err)
	}

	// ② auditor(audit:read,无 report:read):读得到这条审计,但读不到凭据。
	wa := r3Req(t, r, "GET", "/api/server/admin/audit", "", asess, "")
	if wa.Code != http.StatusOK {
		t.Fatalf("auditor audit status = %d(body=%s)", wa.Code, wa.Body.String())
	}
	abody := wa.Body.String()
	t.Logf("auditor audit body=%s", abody)
	if !strings.Contains(abody, "bot-legacy") {
		t.Fatalf("脱敏后审计条目本身仍应可读(名称保留):%s", abody)
	}
	for _, leaked := range []string{r3Secret, "key=", raw} {
		if strings.Contains(abody, leaked) {
			t.Fatalf("auditor 仍能读到历史审计行里的凭据(%q):%s", leaked, abody)
		}
	}

	// ③ super_admin 持 report:read ⇒ 审计原文照旧可读(可追溯性不被牺牲)。
	ws := r3Req(t, r, "GET", "/api/server/admin/audit", "", ssess, "")
	if ws.Code != http.StatusOK {
		t.Fatalf("super_admin audit status = %d(body=%s)", ws.Code, ws.Body.String())
	}
	if !strings.Contains(ws.Body.String(), "key="+r3Secret) {
		t.Fatalf("super_admin(持 report:read)应仍能读到审计原文:%s", ws.Body.String())
	}
}

// TestReportCredentialAuditorCannotManageSubscriptions:读侧脱敏的**权限口径**
// 由真路由声明决定 —— auditor 命中 /report-subscriptions/* 管理面必须 403
// (不靠测试硬编码权限名:用真 403 行为反证 report:write 未进只读角色)。
func TestReportCredentialAuditorCannotManageSubscriptions(t *testing.T) {
	r, db := r3ProdRouter(t)
	asess, acsrf := r3Admin(t, db, "auditor-perm", serverstore.RoleAuditor)
	ssess, _ := r3Admin(t, db, "boss-perm", serverstore.RoleSuperAdmin)

	// 直接落库建一条(带凭据)用于探测:这里要验的是**读侧权限口径**,
	// 建单本身的校验(SSRF/DNS)不是本用例的对象。
	raw := "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=" + r3Secret
	id, err := serverstore.CreateReportSubscription(db, "bot-perm", raw, true)
	if err != nil {
		t.Fatalf("create subscription: %v", err)
	}

	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/server/admin/report-subscriptions"},
		{"POST", "/api/server/admin/report-subscriptions"},
		{"POST", fmt.Sprintf("/api/server/admin/report-subscriptions/%d/test", id)},
		{"PUT", fmt.Sprintf("/api/server/admin/report-subscriptions/%d", id)},
	} {
		wa := r3Req(t, r, tc.method, tc.path, "", asess, acsrf)
		if wa.Code != http.StatusForbidden {
			t.Fatalf("auditor %s %s status = %d, want 403(body=%s)", tc.method, tc.path, wa.Code, wa.Body.String())
		}
	}

	// super_admin 的列表出口仍然只回哨兵(既有脱敏不回退)。
	ws := r3Req(t, r, "GET", "/api/server/admin/report-subscriptions", "", ssess, "")
	if ws.Code != http.StatusOK {
		t.Fatalf("super_admin list status = %d(body=%s)", ws.Code, ws.Body.String())
	}
	if strings.Contains(ws.Body.String(), r3Secret) {
		t.Fatalf("列表出口回显了明文凭据:%s", ws.Body.String())
	}
}
