package serverauth

// WEB-2 服务端侧回归(2026-09-23 独立审计)。
//
// 审计证据(修前):
//
//	PUT /api/server/admin/auth {"enabled":","} → 200 落库
//	enabledProviderNames → 空集
//	clientPasswordOrder() → 遗留兜底 ["ldap","local"]
//	员工面本地口令登录 → 200 + token
//
// 即"配置越空,放开得越多"(空集合被同时当成"还没配置过"与"配置成什么都没有")。
// 本文件锁住修好后的两条规则:
//  1. HTTP 面:`auth.enabled` 解析后**至少要有一个有效提供方**,空集合 400;
//  2. 运行期:空集合只在"从未配置过"(最小装配/单测)时沿用遗留顺序,
//     已经配置过而集合为空 ⇒ 空顺序(fail-closed,员工面不提供任何口令登录)。

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestAuthEnabledRequiresAtLeastOneProvider:PUT /auth 不允许把 enabled 写成
// "没有任何有效项"的列表(`,` / ` , `),同时保留既有语义:单个有效提供方
// (含非 local 的 oidc)合法、非法项与重复项照旧 400。
func TestAuthEnabledRequiresAtLeastOneProvider(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	w, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK {
		t.Fatalf("login: %d", w.Code)
	}
	hdr := map[string]string{"Cookie": "picoaide_session=" + sessionCookie(t, w), "X-CSRF-Token": out["csrf_token"].(string)}

	cases := []struct {
		name    string
		body    string
		want    int
		comment string
	}{
		{"只有分隔符", `{"enabled":","}`, http.StatusBadRequest, "每项 trim 后都是空串 = 无有效提供方"},
		{"空白项列表", `{"enabled":" , "}`, http.StatusBadRequest, "同上(带空格)"},
		{"未知提供方", `{"enabled":"bogus"}`, http.StatusBadRequest, "既有语义:未知项 400"},
		{"重复项", `{"enabled":"local,local"}`, http.StatusBadRequest, "既有语义:重复项 400"},
		{"单项 local", `{"enabled":"local"}`, http.StatusOK, "既有语义:仅本地账号合法"},
		{"单项 oidc", `{"enabled":"oidc"}`, http.StatusOK, "既有语义:允许只启用浏览器跳转"},
		{"空串按 mode 推导", `{"enabled":"","mode":"ldap"}`, http.StatusOK, "既有语义:enabled 缺省时由 mode 推导出 local,ldap"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w, body := doJSON(t, r, "PUT", "/api/server/admin/auth", tc.body, hdr)
			if w.Code != tc.want {
				t.Fatalf("PUT %s = %d %v, want %d(%s)", tc.body, w.Code, body, tc.want, tc.comment)
			}
		})
	}

	// 被拒的请求不得留下半套配置:最后一次**成功**保存的是最后一个用例
	// (enabled 空串 + mode=ldap ⇒ "local,ldap"),中间那些 400 一个字段都没写。
	_, a := doJSON(t, r, "GET", "/api/server/admin/auth", "", hdr)
	authCfg, _ := a["auth"].(map[string]any)
	if got, _ := authCfg["enabled"].(string); got != "local,ldap" {
		t.Fatalf("auth.enabled after rejected saves = %q, want %q(最后一次成功保存的值)", got, "local,ldap")
	}
}

// TestAuthEnabledEmptySetFailsClosed:空集合的两种语义必须分开 ——
// "从未配置过"保留遗留兼容面,"配置成空"一律 fail-closed。
// 变异验证:把 clientPasswordOrder 的判据改回 `len(a.enabledProviders) == 0`,
// 则本用例的登录断言变成 200 + token(红)。
func TestAuthEnabledEmptySetFailsClosed(t *testing.T) {
	db := mustDB(t)
	if _, err := createUserDB(db, "alice", "pw123456", false); err != nil {
		t.Fatal(err)
	}
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))

	// ① 从未配置过(最小装配/单测):沿用遗留顺序,既有行为不变。
	if got := api.clientPasswordOrder(); len(got) != 2 || got[0] != "ldap" || got[1] != "local" {
		t.Fatalf("unconfigured order = %v, want legacy [ldap local]", got)
	}

	// ② 显式配置成空集(等价于旧库里已存在的 auth.enabled=",")⇒ 空顺序。
	api.SetEnabledProviders(nil)
	if got := api.clientPasswordOrder(); len(got) != 0 {
		t.Fatalf("configured-empty order = %v, want empty(fail-closed)", got)
	}

	// ③ 员工面本地口令登录必须被拒(修前:200 + token)。
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)
	w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"alice","password":"pw123456"}`, nil)
	if w.Code == http.StatusOK {
		t.Fatalf("本地口令在空 enabled 集合下仍被接受(fail-open):%d %v", w.Code, out)
	}
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("本地口令登录 = %d %v, want 401", w.Code, out)
	}

	// ④ 非空集合照常工作(防"一律拒绝"式假绿):恢复 local 后同一用户可以登录。
	api.SetEnabledProviders([]string{"local"})
	if _, err := api.AuthenticatePassword("alice", "pw123456"); err != nil {
		t.Fatalf("enabled=local 时本地口令登录失败: %v", err)
	}
}
