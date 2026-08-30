package serverauth

import (
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// 路由表完整性: 服务端强制 RBAC 的 fall-open 防护。
// 断言每个 /api/admin/* 受保护路由都通过 AdminRoute 注册并声明了权限点
// (或明确为空=仅需有效管理会话的 me/logout), 防止「漏挂权限 → 任意
// 管理会话可越权」。
// ---------------------------------------------------------------------------

func TestAdminRouteRegistryNoUnprotected(t *testing.T) {
	r := gin.New()
	db := mustDB(t)
	RegisterAdminRoutes(r, db)
	registered := map[string]bool{}
	for _, rr := range AdminRoutePerms() {
		registered[rr.Method+" "+rr.Path] = true
	}
	// 公开(未认证)路由显式豁免: 登录与登录方式发现。
	public := map[string]bool{"POST /api/admin/login": true, "GET /api/admin/auth/methods": true}
	for _, rt := range r.Routes() {
		if !stringsHasPrefix(rt.Path, "/api/admin/") {
			continue
		}
		key := rt.Method + " " + rt.Path
		if public[key] {
			continue
		}
		if !registered[key] {
			t.Fatalf("admin route %s registered without AdminRoute (fall-open risk)", key)
		}
	}
	if len(registered) < 15 {
		t.Fatalf("registry too small: %d (serverauth own routes)", len(registered))
	}
}

func TestAdminRouteRegistryPermissionsDeclared(t *testing.T) {
	for _, rr := range AdminRoutePerms() {
		if rr.Perm == "" {
			if rr.Path != "/api/admin/me" && rr.Path != "/api/admin/logout" {
				t.Fatalf("route %s %s has empty perm but is not me/logout", rr.Method, rr.Path)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// 角色 × 权限矩阵(纯函数, 无 DB)。
// ---------------------------------------------------------------------------

func TestPermissionsOfRoles(t *testing.T) {
	cases := []struct {
		role string
		has  []string
		no   []string
	}{
		{serverstore.RoleSuperAdmin, []string{PermUserWrite, PermAuthWrite, PermAuditRetention, PermBrandWrite, PermPortalWrite}, []string{}},
		{serverstore.RoleAuditor, []string{PermAuditRead, PermUsageRead, PermUserRead}, []string{PermUserWrite, PermAuthWrite, PermBrandWrite, PermGatewayWrite, PermRoleAssign}},
		{serverstore.RoleUser, []string{}, []string{PermAuditRead, PermUserRead, PermUsageRead, PermAuthWrite}},
	}
	for _, tc := range cases {
		u := &serverstore.User{Role: tc.role}
		for _, p := range tc.has {
			if !HasPermission(u, p) {
				t.Fatalf("role %s should have %s", tc.role, p)
			}
		}
		for _, p := range tc.no {
			if HasPermission(u, p) {
				t.Fatalf("role %s must NOT have %s", tc.role, p)
			}
		}
	}
	if HasPermission(nil, PermAuditRead) {
		t.Fatal("nil user must have no permissions")
	}
	if HasPermission(&serverstore.User{Role: "bogus"}, PermAuditRead) {
		t.Fatal("unknown role must have no permissions")
	}
}

// ---------------------------------------------------------------------------
// auditor 服务端强制: 登录后对写端点 403(非前端隐藏)。
// ---------------------------------------------------------------------------

func TestAuditorCannotWrite(t *testing.T) {
	r := gin.New()
	db := mustDB(t)
	RegisterAdminRoutes(r, db)
	uid, err := serverstore.CreateUserWithPassword(db, "aud", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	u.Role = serverstore.RoleAuditor
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{
		"Cookie":       "picoaide_session=" + sess.ID,
		"X-CSRF-Token": csrf,
	}
	// auditor 可读
	w, _ := doJSON(t, r, "GET", "/api/admin/audit", "", nil)
	if w.Code == http.StatusForbidden {
		t.Fatalf("auditor should read audit, got 403")
	}
	w, _ = doJSON(t, r, "GET", "/api/admin/users", "", nil)
	if w.Code == http.StatusForbidden {
		t.Fatalf("auditor should read users (read-only), got 403")
	}
	// auditor 写端点一律 403
	writeCases := []struct {
		method, path, body string
	}{
		{"PUT", "/api/admin/auth", `{"mode":"local"}`},
		{"POST", "/api/admin/users", `{"username":"x","password":"pwpw111111"}`},
		{"PUT", "/api/admin/users/1", `{"role":"user"}`},
	}
	for _, tc := range writeCases {
		w, _ := doJSON(t, r, tc.method, tc.path, tc.body, hdr)
		if w.Code != http.StatusForbidden {
			t.Fatalf("auditor %s %s = %d, want 403", tc.method, tc.path, w.Code)
		}
	}
}

// ---------------------------------------------------------------------------
// user 角色: 管理门户 403(login 拒发会话), ValidateAdminSession 拒 user。
// ---------------------------------------------------------------------------

func TestUserCannotEnterPortal(t *testing.T) {
	db := mustDB(t)
	uid, err := serverstore.CreateUserWithPassword(db, "plain", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	sess, _, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err == nil {
		t.Fatal("user session must be rejected by ValidateAdminSession")
	}
}

// TestAdminSessionIdleExpired: 空闲超时过期(60min 滑动)。
func TestAdminSessionIdleExpired(t *testing.T) {
	db := mustDB(t)
	uid, err := serverstore.CreateUserWithPassword(db, "boss-idle", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	u.Role = serverstore.RoleSuperAdmin
	if err := serverstore.UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	sess, _, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-5 * time.Hour).UTC().Format(time.RFC3339)
	if _, err := db.Exec("UPDATE admin_sessions SET last_used_at = ? WHERE id = ?", past, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err == nil {
		t.Fatal("idle session must be rejected")
	}
	fresh := time.Now().UTC().Format(time.RFC3339)
	if _, err := db.Exec("UPDATE admin_sessions SET last_used_at = ? WHERE id = ?", fresh, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err != nil {
		t.Fatalf("active session must validate: %v", err)
	}
}

func stringsHasPrefix(s, prefix string) bool {
	return len(s) >= len(prefix) && s[:len(prefix)] == prefix
}
