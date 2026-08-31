package serverauth

import (
	"database/sql"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/go-ldap/ldap/v3"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestAdminTestConnectionLDAP:测试连接 LDAP 必须:
//  1. 用已保存的 bind_password 测试(前端回传掩码 *** 或空串时回读保存值);
//  2. 返回目录统计(用户/组数 + 前 5 样例)。
func TestAdminTestConnectionLDAP(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}

	// 保存 ldap 配置(密码落盘)
	for k, v := range map[string]string{
		"ldap.server_url":    "ldap://fake",
		"ldap.bind_dn":       "cn=svc,ou=system,dc=example",
		"ldap.bind_password": "svcpass",
		"ldap.base_dn":       "dc=example",
		"ldap.user_filter":   "(uid=%s)",
		"ldap.group_filter":  "(member=%s)",
		"ldap.group_attr":    "cn",
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}

	// fake 连接: 2 用户 + 1 组
	f := &fakeLDAPConn{
		passwords: map[string]string{"cn=svc,ou=system,dc=example": "svcpass"},
		searchResults: map[string]*ldap.SearchResult{
			"(uid=*)": {Entries: []*ldap.Entry{
				dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
				dirUser("uid=bob,ou=people,dc=example", "bob", "Bob", "bob@example.com"),
			}},
			"(member=*)": {Entries: []*ldap.Entry{
				dirGroup("cn=admins,ou=groups,dc=example", "admins"),
			}},
			"(member=uid=alice,ou=people,dc=example)": {Entries: []*ldap.Entry{
				dirGroup("cn=admins,ou=groups,dc=example", "admins"),
			}},
		},
	}
	orig := ldapProbeDialHook
	ldapProbeDialHook = func(string) (ldapConn, error) { return f, nil }
	defer func() { ldapProbeDialHook = orig }()

	// 请求测试连接: bind_password 传 "***"(webadmin 回显值) → 服务端回读已存密码
	r := ginNewTestRouter(t, db)
	w, out := doAdmin(t, r, "POST", "/api/server/admin/auth/test",
		`{"type":"ldap","ldap":{"server_url":"ldap://fake","bind_dn":"cn=svc,ou=system,dc=example","bind_password":"***","base_dn":"dc=example","user_filter":"(uid=%s)","group_filter":"(member=%s)","group_attr":"cn"}}`, hdr)
	if w.Code != 200 {
		t.Fatalf("test conn: %d %s", w.Code, w.Body.String())
	}
	if out["ok"] != true {
		t.Fatalf("ok = %v message=%v", out["ok"], out["message"])
	}
	if out["users"] != float64(2) || out["groups"] != float64(1) {
		t.Fatalf("stats = users:%v groups:%v, want 2/1", out["users"], out["groups"])
	}
	sample, _ := out["sample"].([]any)
	if len(sample) != 2 {
		t.Fatalf("sample = %v, want 2 entries", sample)
	}
	first, _ := sample[0].(map[string]any)
	if first["username"] != "alice" || first["display_name"] != "Alice" {
		t.Fatalf("sample[0] = %v", first)
	}
	grps, _ := first["groups"].([]any)
	if len(grps) != 1 || grps[0] != "admins" {
		t.Fatalf("sample[0].groups = %v", grps)
	}
}

// TestAdminTestConnectionLDAPBadPassword:密码错误时测试连接失败。
func TestAdminTestConnectionLDAPBadPassword(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sess.ID, "X-CSRF-Token": csrf}

	f := &fakeLDAPConn{} // 无 passwords → bind 拒绝
	orig := ldapProbeDialHook
	ldapProbeDialHook = func(string) (ldapConn, error) { return f, nil }
	defer func() { ldapProbeDialHook = orig }()

	r := ginNewTestRouter(t, db)
	w, out := doAdmin(t, r, "POST", "/api/server/admin/auth/test",
		`{"type":"ldap","ldap":{"server_url":"ldap://fake","bind_dn":"cn=svc,ou=system,dc=example","bind_password":"wrong","base_dn":"dc=example"}}`, hdr)
	if w.Code != 200 {
		t.Fatalf("test conn = %d %s", w.Code, w.Body.String())
	}
	if out["ok"] != false {
		t.Fatalf("ok = %v, want false (bad bind password)", out["ok"])
	}
}

// ginNewTestRouter builds the admin route tree on the given DB.
func ginNewTestRouter(t *testing.T, db *sql.DB) http.Handler {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	RegisterAdminRoutes(r, db)
	return r
}
