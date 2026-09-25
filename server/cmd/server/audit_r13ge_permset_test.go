package main

// R13-GE · R13A-01 回归：管理面路由声明的权限点与 `serverauth.AllPermissions`
// **没有双向对账** ⇒ 死路由全绿。
//
// 被审形态（R13-A 的 §2.1(a) 探针，真实制造出来的假绿）：在 `internal/router` 的
// `registerServer` 里加一条
//
//	serverauth.AdminRoute(authed, "GET", "/zz-…", "probe:read", …)
//
// （权限点是**字面量**，不在 `serverauth.AllPermissions` 里），并按镜像对拍给出的
// 指引在 `productionOnlyAdminRoutes` 登记一行理由 —— 这是真实开发者的下一步操作。
// 结果是：
//
//   - 产品状态**真实地错**：该端点对**包括 super_admin 在内**的全部角色 403（死路由）；
//   - 而 `internal/serverauth`（fall-open 命名空间申报 / AdminRoute 空权限登记 / 角色矩阵）、
//     `internal/router`（镜像对拍**双向**登记表）、`cmd/server`（把每条路由都真请求一遍的
//     API 契约扫描）、webadmin 的权限点四向对拍（它读 `rbac.go` + `nav.ts` + `rbac.ts`，
//     **从不读 `router.go`**）—— 全部为绿。
//
// ⇒ 判据问的是「这条路由申报了吗」，而不是「这个权限点存在吗」。
//
// 本文件把 A 的探针收成正式判据，并补上缺失的**第三个方向**（路由 → 权限集合）与
// **反向**（权限集合 → 入口）：
//
//	A. 前向（缺失的那一向）：`AdminRoutePerms()` 里每个非空 perm 必须 ∈ AllPermissions
//	   **且** `HasPermission(super_admin, perm) == true`（后者正是 `RequirePermission`
//	   判定的那个函数 ⇒ 有它才等于"这条路由真的可达"）。
//	B. 反向：`AllPermissions` 里每条权限点必须**至少被一条管理面路由使用**，或在
//	   `reservedPermissions` 里**逐条登记**为"保留/外部使用"（缺了它，一个从不生效的
//	   死权限点会长期躺在集合里；有了它，"新增权限点但没接入口"不可能静默通过）。
//	C. 危害同构（真 DB + 真 super_admin 会话 + 真 middleware）：在一条同构的中间件链上
//	   挂两条路由 —— 一条用集合外的死权限点、一条用真实权限点 —— 证明"集合外的权限点
//	   ⇒ 对 super_admin 也 403"，而真实权限点不是 403。（A 证明生产树里没有这种路由；
//	   C 证明 A 若失效，危害就是那个 403。）
//
// 判据 C 为什么不直接打生产树里那条死路由：那需要先注入变异，判据不能依赖变异。
//
// **为什么用 `RequirePermission` 而不是 `AdminRoute` 构造**：`AdminRoute` 会把每条
// 注册路由写进 `serverauth` 的**包级累加注册表**（`adminRoutes`），而那个注册表正是
// `TestAdminRouterNoFallOpen` 用来算「申报表里有没有陈旧条目」的输入 —— 在判据里凭空
// 注册两条不存在的路由会污染它（实测：本判据第一版用 `AdminRoute` 时，
// `TestAdminRouterNoFallOpen` 报「申报表/豁免表里有 2 条在路由表里不存在」）。
// 所以 C 直接装 `RequirePermission`（= `AdminRoute` 在 `perm != ""` 时装进链首的那个
// 中间件），并用 C2 的源码级判据钉住「`AdminRoute` 确实就是这么装的」⇒ 既不污染
// 共享注册表，又保持与生产同构。

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// reservedPermissions 登记"在 AllPermissions 里、但**不接任何管理面路由**"的权限点。
//
// 判据 B 要求：集合里的每一条要么被至少一条路由使用，要么在这里逐条写明为什么
// 没有入口。**空表是合法状态**（当前 22 条权限点全部有入口）——这正是守卫的价值：
// 新增一条没有入口的权限点会被要求在这里"签字"。
//
// 键 = 权限点字面量；值 = 为什么保留它（谁在用 / 计划中的入口）。
var reservedPermissions = map[string]string{}

// TestAuditR13GEDeclaredAdminPermsAreGrantedToSuperAdmin 是判据 A（缺失的那一向）。
func TestAuditR13GEDeclaredAdminPermsAreGrantedToSuperAdmin(t *testing.T) {
	// 先装配**生产路由树**：AdminRoutePerms() 只登记"被真正注册过"的路由，
	// 不先跑一次 registerProductionRoutes 就会得到空集合 ⇒ 判据恒真（假绿）。
	buildRouter(t)
	perms := serverauth.AdminRoutePerms()
	if len(perms) == 0 {
		t.Fatal("AdminRoutePerms() 为空：生产装配没跑起来（判据会恒真，必须 fail-loud）")
	}
	super := &serverstore.User{Role: serverstore.RoleSuperAdmin}
	all := map[string]bool{}
	for _, p := range serverauth.AllPermissions {
		all[p] = true
	}
	// AdminRoutePerms() 是**包级累加**的注册表：同一进程里注册多次会重复登记，
	// 这里按 (method, path, perm) 去重后再判（否则报数失真）。
	seen := map[string]bool{}
	var bad []string
	for _, rr := range perms {
		if rr.Perm == "" {
			continue // 空权限 = 仅需有效管理会话（me/logout/mfa），另有用例覆盖
		}
		key := rr.Method + " " + rr.Path + " " + rr.Perm
		if seen[key] {
			continue
		}
		seen[key] = true
		if !all[rr.Perm] || !serverauth.HasPermission(super, rr.Perm) {
			bad = append(bad, fmt.Sprintf("%s %s -> perm=%q (in AllPermissions=%v)",
				rr.Method, rr.Path, rr.Perm, all[rr.Perm]))
		}
	}
	sort.Strings(bad)
	if len(bad) > 0 {
		t.Fatalf("有 %d 条管理面路由声明的权限点**连 super_admin 都拿不到** ⇒ 该端点对全部角色 403（死路由）：\n  %s\n"+
			"⇒ 请把权限点加进 serverauth.AllPermissions（或在 rbac.go 里定义常量再引用），"+
			"不要写字面量。", len(bad), strings.Join(bad, "\n  "))
	}
	t.Logf("生产路由树：%d 条管理面路由（去重后 %d 条带权限点），声明的权限点全部被 super_admin 持有",
		len(perms), len(seen))
}

// TestAuditR13GEAllPermissionsHaveAnEntryPoint 是判据 B（反向：权限集合 → 入口）。
func TestAuditR13GEAllPermissionsHaveAnEntryPoint(t *testing.T) {
	buildRouter(t)
	perms := serverauth.AdminRoutePerms()
	if len(perms) == 0 {
		t.Fatal("AdminRoutePerms() 为空：生产装配没跑起来（判据会恒真，必须 fail-loud）")
	}
	used := map[string]bool{}
	for _, rr := range perms {
		if rr.Perm != "" {
			used[rr.Perm] = true
		}
	}
	var orphan []string
	for _, p := range serverauth.AllPermissions {
		if used[p] {
			continue
		}
		if _, ok := reservedPermissions[p]; ok {
			continue
		}
		orphan = append(orphan, p)
	}
	sort.Strings(orphan)
	if len(orphan) > 0 {
		t.Errorf("serverauth.AllPermissions 里有 %d 条权限点**没有任何管理面路由使用**，也没有在 "+
			"reservedPermissions 里登记：%v\n⇒ 死权限点（永远不会生效）与死路由是同一枚硬币的两面；"+
			"要么给它接入口，要么在 reservedPermissions 里写明为什么保留。", len(orphan), orphan)
	}
	// 反向的再反向：reservedPermissions 里不许有陈旧的条目（登记了却已不在集合里，
	// 或其实已经有入口）—— 否则这张表会自己长成"假守卫"。
	for p, why := range reservedPermissions {
		if !containsStr(serverauth.AllPermissions, p) {
			t.Errorf("reservedPermissions 登记了 %q，但它不在 AllPermissions 里（陈旧条目）", p)
		}
		if used[p] {
			t.Errorf("reservedPermissions 登记 %q 为「无入口」（%s），但它已被管理面路由使用（陈旧条目）", p, why)
		}
	}
	t.Logf("AllPermissions %d 条，被路由使用 %d 条，登记为保留 %d 条",
		len(serverauth.AllPermissions), len(used), len(reservedPermissions))
}

// TestAuditR13GEDeadPermIsUnreachableForSuperAdmin 是判据 C1（危害同构，真 DB + 真会话）。
func TestAuditR13GEDeadPermIsUnreachableForSuperAdmin(t *testing.T) {
	db := requireRealDB(t)

	uid, err := serverstore.CreateUserWithPassword(db, fmt.Sprintf("r13ge-perm-%d", time.Now().UnixNano()), "pw123456789")
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
	sess, csrf, err := serverauth.CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}

	// 与生产**同构**的中间件链：AdminAuth（会话 + CSRF）→ RequirePermission(perm)。
	// 刻意不经 `AdminRoute`（它会写进包级注册表，见文件头说明）。
	gin.SetMode(gin.TestMode)
	r := gin.New()
	realPerm := serverauth.PermServerInfoRead
	dead := r.Group("/api/server/admin", serverauth.AdminAuth(db),
		serverauth.RequirePermission("zz:not-in-all-permissions"))
	dead.GET("/zz-dead-perm", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })
	// 对照组：真实权限点（super_admin 持有）⇒ 必须不是 403。
	live := r.Group("/api/server/admin", serverauth.AdminAuth(db),
		serverauth.RequirePermission(realPerm))
	live.GET("/zz-real-perm", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"ok": true}) })

	call := func(path string) (int, string) {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Cookie", "picoaide_session="+sess.ID)
		req.Header.Set("X-CSRF-Token", csrf)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		return w.Code, w.Body.String()
	}

	deadCode, deadBody := call("/api/server/admin/zz-dead-perm")
	t.Logf("super_admin GET /zz-dead-perm（死权限点）=> %d %s", deadCode, deadBody)
	if deadCode != http.StatusForbidden {
		t.Fatalf("集合外的权限点没有产生 403（实得 %d）—— 判据 C 的前提不成立，"+
			"A 的「死路由」危害描述需要重新核对", deadCode)
	}
	if !strings.Contains(deadBody, "FORBIDDEN") {
		t.Errorf("403 的响应体不是 RBAC 的 FORBIDDEN 信封：%s", deadBody)
	}
	realCode, realBody := call("/api/server/admin/zz-real-perm")
	t.Logf("super_admin GET /zz-real-perm（真实权限点 %s）=> %d %s", realPerm, realCode, realBody)
	if realCode == http.StatusForbidden {
		t.Fatalf("对照组：super_admin 拿 %s 竟然也 403 —— 权限模型本身坏了（不是本判据的目标形态）", realPerm)
	}
}

// TestAuditR13GEAdminRouteInstallsRequirePermission 是判据 C2（源码级接线守卫）。
//
// C1 直接装 `RequirePermission`，它与生产同构的前提是「`AdminRoute` 在 perm != "" 时
// 确实把 `RequirePermission(perm)` 放进链首」。这条用源码断言钉住，防止 C1 的构造
// 与生产悄悄分叉（若生产改成不装权限中间件，C1 仍会绿）。
func TestAuditR13GEAdminRouteInstallsRequirePermission(t *testing.T) {
	raw, err := os.ReadFile("../../internal/serverauth/rbac.go")
	if err != nil {
		t.Fatalf("读 ../../internal/serverauth/rbac.go: %v", err)
	}
	src := string(raw)
	want := regexp.MustCompile(`if\s+perm\s*!=\s*""\s*\{\s*chain\s*=\s*append\(chain,\s*RequirePermission\(perm\)\)`)
	if !want.MatchString(src) {
		t.Errorf("AdminRoute 没有在 perm != \"\" 时装上 RequirePermission(perm) —— " +
			"判据 C 的构造（直接装 RequirePermission）与生产不再同构")
	}
	if !strings.Contains(src, "adminRoutes = append") {
		t.Errorf("AdminRoute 不再把路由写进包级注册表 —— 判据 A/B 的输入面（AdminRoutePerms）会变空")
	}
}

// containsStr 是"集合成员"的小工具（判据 B 的反向再反向用）。
func containsStr(xs []string, s string) bool {
	for _, x := range xs {
		if x == s {
			return true
		}
	}
	return false
}
