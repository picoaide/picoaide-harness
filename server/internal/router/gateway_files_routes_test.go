package router

// 网关文件台账路由的完整性（审计 2026-09-22 R7 / 修复泳道 L3）。
//
// 两条判据：
//  1. **逐条对齐**：`internal/router` 是生产真源，`llmgateway.RegisterAdminRoutes`
//     是测试自建镜像。两者在 `/gateway/files*` 上必须集合相等 —— 镜像多一条
//     （测试里全绿、线上 404）或生产多一条（镜像测不到、权限点无人复核）都要红，
//     而既有 parity 用例只查"镜像 ⊆ 生产"这一个方向；
//  2. **权限点精确**：读端点 `gateway:read`、写端点 `gateway:write`。auditor 角色
//     只有 audit/usage/user 三个只读权限 ⇒ 写端点靠 `gateway:write` 拦下；权限点
//     被误写成读权限（或漏申报）时，本用例与 cmd/server 的 fall-open 用例一起红。

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverauth"
)

// gatewayFileRouteKeys 收集一棵路由树里 /api/server/admin/gateway/files* 的
// (method, path) 集合。
func gatewayFileRouteKeys(e *gin.Engine) map[string]bool {
	out := map[string]bool{}
	prefix := NamespaceServer + "/admin/gateway/files"
	for _, r := range e.Routes() {
		if r.Path == prefix || strings.HasPrefix(r.Path, prefix+"/") {
			out[r.Method+" "+r.Path] = true
		}
	}
	return out
}

func TestGatewayFilesRoutesMirrorProductionAndPermissions(t *testing.T) {
	// 期望集合写死（生产真源）：新增/改动网关文件路由必须同时改这里。
	want := map[string]string{
		"GET " + NamespaceServer + "/admin/gateway/files":             serverauth.PermGatewayRead,
		"GET " + NamespaceServer + "/admin/gateway/files/summary":     serverauth.PermGatewayRead,
		"DELETE " + NamespaceServer + "/admin/gateway/files/:file_id": serverauth.PermGatewayWrite,
		"POST " + NamespaceServer + "/admin/gateway/files/purge":      serverauth.PermGatewayWrite,
	}

	prod := buildTestRouter(t)
	mirror := gin.New()
	llmgateway.RegisterAdminRoutes(mirror, nil)

	prodSet := gatewayFileRouteKeys(prod)
	mirrorSet := gatewayFileRouteKeys(mirror)

	if len(prodSet) != len(want) {
		t.Fatalf("生产树 /gateway/files* 路由数 = %d, want %d:\n  %s",
			len(prodSet), len(want), strings.Join(keysOf(prodSet), "\n  "))
	}
	for key := range want {
		if !prodSet[key] {
			t.Fatalf("生产路由树缺少 %s", key)
		}
		if !mirrorSet[key] {
			t.Fatalf("测试镜像缺少 %s（用例会 404，掩盖真实行为）", key)
		}
	}
	for key := range prodSet {
		if _, ok := want[key]; !ok {
			t.Fatalf("生产路由树多出未登记的路由 %s（权限点没人复核）", key)
		}
	}
	for key := range mirrorSet {
		if _, ok := want[key]; !ok {
			t.Fatalf("测试镜像多出生产没有的路由 %s（测试绿、线上 404）", key)
		}
	}

	// 权限点：同一条路由在两棵树里申报的权限必须一致，且等于期望值。
	perms := map[string]map[string]bool{}
	for _, rr := range serverauth.AdminRoutePerms() {
		key := rr.Method + " " + rr.Path
		if _, ok := want[key]; !ok {
			continue
		}
		if perms[key] == nil {
			perms[key] = map[string]bool{}
		}
		perms[key][rr.Perm] = true
	}
	for key, wantPerm := range want {
		got := perms[key]
		if len(got) == 0 {
			t.Fatalf("%s 没有经 AdminRoute 申报权限（fall-open）", key)
		}
		if len(got) != 1 {
			t.Fatalf("%s 在两棵树里申报了不同权限 %v（真源与镜像漂移）", key, got)
		}
		for p := range got {
			if p != wantPerm {
				t.Fatalf("%s 权限点 = %q, want %q", key, p, wantPerm)
			}
		}
	}
}

// TestGatewayFilesWriteRoutesRequireWritePermission：写端点必须在**权限层**被
// auditor 拦住（403），而不是靠参数校验/404 兜底。
//
// 用 AdminRoutePerms 的申报做静态断言（不起会话）：申报漂移成 gateway:read 时
// 这条会红 —— 结合 llmgateway 的 HTTP 级用例（auditor 访问四个端点全 403），
// 申报值 ↔ 真实拦截行为两端都被钉住。
func TestGatewayFilesWriteRoutesRequireWritePermission(t *testing.T) {
	auditor := serverauth.PermissionsOf("auditor")
	hasAuditorWrite := false
	for _, p := range auditor {
		if p == serverauth.PermGatewayWrite || p == serverauth.PermGatewayRead {
			hasAuditorWrite = true
		}
	}
	if hasAuditorWrite {
		t.Fatalf("auditor 不该持有任何 gateway 权限（实得 %v）—— 权限矩阵变了要同步本用例", auditor)
	}
	for _, rr := range serverauth.AdminRoutePerms() {
		if rr.Path != NamespaceServer+"/admin/gateway/files/:file_id" && rr.Path != NamespaceServer+"/admin/gateway/files/purge" {
			continue
		}
		if rr.Method != http.MethodDelete && rr.Method != http.MethodPost {
			continue
		}
		if rr.Perm != serverauth.PermGatewayWrite {
			t.Fatalf("%s %s 权限点 = %q, want %q", rr.Method, rr.Path, rr.Perm, serverauth.PermGatewayWrite)
		}
	}
}

// keysOf 把集合排成稳定顺序，便于失败信息可读。
func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	for i := 1; i < len(out); i++ { // 插入排序：集合很小，避免引入 sort 依赖顺序问题
		for j := i; j > 0 && out[j] < out[j-1]; j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out
}
