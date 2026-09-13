package reports

// 第三轮审计残留①-A 回归(2026-09-13):test push 失败响应体回显 webhook 凭据。
//
// 缺陷:`POST /report-subscriptions/:id/test` 把 `PushWebhook` 的 `err.Error()`
// 原样拼进 502 信封,而 net/http 的错误串自带目标 URL
// (`Post "https://…?key=SECRET": dial tcp …`)。上一轮的 FIX-13 只堵了
// 列表出口与 last_error 出口,这条出口漏了 —— webadmin 会把它渲染进错误横幅。
//
// 本文件用**真 PG + 真 handler + 真权限常量**:权限名从 internal/router/router.go
// 正文解析(不硬编码,随路由声明漂移会立刻失败),角色口径由 serverauth 真表判定。
//
// 运行:
//   cd server && export GOCACHE=… GOMODCACHE=… GOPROXY=… GOFLAGS=-mod=mod GOSUMDB=off
//   PG_DSN_TEST="postgres://postgres:postgres@127.0.0.1:5432/postgres?sslmode=disable" \
//     go test ./internal/reports/ -run 'TestTestPushErrorSanitized' -count=1 -p 1 -v

import (
	"database/sql"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// routePermFromSource 从真实 router.go 正文里读出某条管理路由申报的权限常量名,
// 再从 rbac.go 读出常量值 —— 测试不硬编码权限名,避免与源码一起漂移。
func routePermFromSource(t *testing.T, method, path string) (constName, perm string) {
	t.Helper()
	src, err := os.ReadFile("../router/router.go")
	if err != nil {
		t.Fatalf("read router.go: %v", err)
	}
	m := regexp.MustCompile(`"` + regexp.QuoteMeta(method) + `",\s*"` + regexp.QuoteMeta(path) + `",\s*serverauth\.([A-Za-z0-9_]+)`).
		FindStringSubmatch(string(src))
	if m == nil {
		t.Fatalf("router.go 未找到 %s %s 的 AdminRoute 声明", method, path)
	}
	constName = m[1]
	rbac, err := os.ReadFile("../serverauth/rbac.go")
	if err != nil {
		t.Fatalf("read rbac.go: %v", err)
	}
	m2 := regexp.MustCompile(`(?m)^\s*` + constName + `\s*=\s*"([^"]+)"`).FindStringSubmatch(string(rbac))
	if m2 == nil {
		t.Fatalf("rbac.go 未找到常量 %s", constName)
	}
	return constName, m2[1]
}

func r3AdminSession(t *testing.T, db *sql.DB, name, role string) (sess, csrf string) {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: name, Source: "local", Status: 1, Role: role})
	if err != nil {
		t.Fatalf("create user %s: %v", name, err)
	}
	s, c, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatalf("create admin session %s: %v", name, err)
	}
	return s.ID, c
}

// TestTestPushErrorSanitized:502 响应体不得回显 hook_url 明文,但仍要给出
// 可诊断的错误类别;同时按真路由权限口径证明 auditor 连该端点都进不去。
func TestTestPushErrorSanitized(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef")

	permConst, permValue := routePermFromSource(t, "POST", "/report-subscriptions/:id/test")
	t.Logf("route_perm_const=%s route_perm_value=%q", permConst, permValue)
	if permValue == "" {
		t.Fatal("从 router.go 解析出的权限值为空")
	}

	// 角色口径(真权限表,不硬编码):auditor 无该权限,super_admin 有。
	auditor := &serverstore.User{Role: serverstore.RoleAuditor}
	super := &serverstore.User{Role: serverstore.RoleSuperAdmin}
	if serverauth.HasPermission(auditor, permValue) {
		t.Fatalf("设计口径:auditor 不应持有 %q(只读角色)", permValue)
	}
	if !serverauth.HasPermission(super, permValue) {
		t.Fatalf("super_admin 必须持有 %q", permValue)
	}

	usess, ucsrf := r3AdminSession(t, db, "boss-push", serverstore.RoleSuperAdmin)
	asess, acsrf := r3AdminSession(t, db, "auditor-push", serverstore.RoleAuditor)

	gin.SetMode(gin.TestMode)
	r := gin.New()
	reg := r.Group("/api/server/admin", serverauth.AdminAuth(db))
	h := NewHandlers(db)
	// 与 router.go 同一份声明形状(权限常量取自其正文)。
	serverauth.AdminRoute(reg, "POST", "/report-subscriptions/:id/test", permValue, h.TestPush)

	// 关闭端口的目标:连接必失败,错误串会回显完整 URL(含 key=…)。
	raw := "http://127.0.0.1:1/hook?" + secretHookKey
	id, err := serverstore.CreateReportSubscription(db, "bot-push", raw, true)
	if err != nil {
		t.Fatalf("create subscription: %v", err)
	}

	// ① auditor:真 403(权限口径,不靠测试自证)。
	wa := reqJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/report-subscriptions/%d/test", id), "", asess, acsrf)
	if wa.Code != http.StatusForbidden {
		t.Fatalf("auditor test push status = %d, want 403(body=%s)", wa.Code, wa.Body.String())
	}

	// ② super_admin:502,响应体不得含凭据(改前含 `key=SUPER-SECRET-BOT-KEY`)。
	w := reqJSON(t, r, "POST", fmt.Sprintf("/api/server/admin/report-subscriptions/%d/test", id), "", usess, ucsrf)
	body := w.Body.String()
	t.Logf("test_push status=%d body=%s", w.Code, body)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("test push status = %d, want 502(body=%s)", w.Code, body)
	}
	for _, leaked := range []string{secretHookKey, "SUPER-SECRET-BOT-KEY", raw} {
		if strings.Contains(body, leaked) {
			t.Fatalf("502 响应体仍回显 webhook 凭据(%q):%s", leaked, body)
		}
	}
	// ③ 脱敏不等于吞掉错误:仍要给出可诊断的类别。
	if !strings.Contains(body, "推送失败") || !strings.Contains(body, "目标拒绝连接") {
		t.Fatalf("502 响应体丢失了可诊断的失败类别:%s", body)
	}
}
