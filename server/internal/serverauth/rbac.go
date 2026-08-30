package serverauth

//
// RBAC 权限模型(设计 v3b: 2026-09-04-client-login-brand-ux.md)
//
// 角色: super_admin(全量) / auditor(只读审计) / user(普通员工,无管理权限)。
// 权限: 声明式权限点常量 + 角色→权限映射(Go 内存表,不落 DB——权限集合
// 稳定、变更需发版,内表简单可测无 JOIN;未来需要运行时自定义角色时再演进)。
//
// 服务端强制: RequirePermission 中间件在所有 /api/admin/* 路由上执行,
// 前端隐藏菜单只是体验层;权限判定在服务端 403,不可绕过。
//

import (
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// 权限点清单。命名规范: <域>:<动作>。
const (
	PermUserRead        = "user:read"   // 用户列表
	PermUserWrite       = "user:write"  // 增改删用户、配额
	PermRoleAssign      = "role:assign" // 角色分配/提权降权
	PermDeptRead        = "dept:read"   // 部门
	PermDeptWrite       = "dept:write"
	PermAuthRead        = "auth:read"    // 认证配置(脱敏)
	PermAuthWrite       = "auth:write"   // 认证配置(含 client_secret)
	PermGatewayRead     = "gateway:read" // 网关/模型/渠道/价格
	PermGatewayWrite    = "gateway:write"
	PermUsageRead       = "usage:read"       // 用量报表
	PermQuotaWrite      = "quota:write"      // 配额/部门预算
	PermMarketRead      = "market:read"      // 市场技能
	PermMarketWrite     = "market:write"     // 技能审批/授权
	PermCapabilityRead  = "capability:read"  // 能力中心
	PermCapabilityWrite = "capability:write" // 能力中心审批
	PermConnectorRead   = "connector:read"   // 连接器
	PermConnectorWrite  = "connector:write"
	PermAuditRead       = "audit:read"            // 审计日志
	PermAuditRetention  = "audit:retention:write" // 审计保留策略(仅 super_admin)
	PermBrandRead       = "brand:read"            // 品牌
	PermBrandWrite      = "brand:write"
	PermPortalRead      = "portal:read" // 门户首页
	PermPortalWrite     = "portal:write"
	PermServerInfoRead  = "server-info:read"      // 服务器信息
	PermErrorMonRead    = "error-monitoring:read" // 错误监控
)

// AllPermissions is the full permission set (super_admin).
var AllPermissions = []string{
	PermUserRead, PermUserWrite, PermRoleAssign,
	PermDeptRead, PermDeptWrite,
	PermAuthRead, PermAuthWrite,
	PermGatewayRead, PermGatewayWrite,
	PermUsageRead, PermQuotaWrite,
	PermMarketRead, PermMarketWrite,
	PermCapabilityRead, PermCapabilityWrite,
	PermConnectorRead, PermConnectorWrite,
	PermAuditRead, PermAuditRetention,
	PermBrandRead, PermBrandWrite,
	PermPortalRead, PermPortalWrite,
	PermServerInfoRead, PermErrorMonRead,
}

// AuditorPermissions is the read-only triple allowed to the auditor role.
var AuditorPermissions = []string{
	PermAuditRead, PermUsageRead, PermUserRead,
}

// rolePerms maps role → permission set (Go in-memory table).
var rolePerms = map[string][]string{
	serverstore.RoleSuperAdmin: AllPermissions,
	serverstore.RoleAuditor:    AuditorPermissions,
	serverstore.RoleUser:       {},
}

// PermissionsOf returns the permission set for a role.
func PermissionsOf(role string) []string {
	if perms, ok := rolePerms[role]; ok {
		return perms
	}
	return nil
}

// HasPermission reports whether the user's role grants the permission.
// Pure function, no DB access.
func HasPermission(u *serverstore.User, perm string) bool {
	if u == nil {
		return false
	}
	for _, p := range PermissionsOf(u.Role) {
		if p == perm {
			return true
		}
	}
	return false
}

// RequirePermission returns a gin middleware enforcing the given permission.
// It must run after AdminAuth (which populates the admin_user context).
// Denied → 403 FORBIDDEN (never 404: audit-friendly and cannot be probed
// through menu enumeration — the 404 page is a frontend affordance only).
func RequirePermission(perm string) gin.HandlerFunc {
	return func(c *gin.Context) {
		u := currentAdmin(c)
		if u == nil {
			WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未登录")
			return
		}
		if !HasPermission(u, perm) {
			WriteError(c, http.StatusForbidden, "FORBIDDEN", "没有权限执行该操作")
			return
		}
		c.Next()
	}
}

// ---------------------------------------------------------------------------
// 路由表收敛: 全部 /api/admin/* 路由必须通过 AdminRoute 注册, 显式声明
// 权限点, 杜绝「漏挂权限 → fall-open 越权」。请求序列:
//   AdminAuth(会话+CSRF) → RequirePermission(perm) → handler
//
// login 与 auth/methods 保持公开(不经过 AdminAuth); me/logout 仅需有效
// 管理会话(perm 为空串 = 登录即可)。
// ---------------------------------------------------------------------------

// adminRoutePerm records one registered admin route's required permission.
type adminRoutePerm struct {
	method string
	path   string
	perm   string
}

// adminRoutes is the in-memory registry of every AdminRoute registration;
// the integrity test compares it against gin's actual route table to prove
// no /api/admin/* route can exist without an explicit permission (fall-open
// protection). Routes registered here are also visible via Routes().
var adminRoutes []adminRoutePerm

// AdminRoute registers an admin route with an explicit required permission.
// perm == "" means "authenticated admin session only" (me/logout).
// The registry records the FULL path (group base + route) so integrity tests
// can match against gin's complete route table.
func AdminRoute(g *gin.RouterGroup, method, path, perm string, handlers ...gin.HandlerFunc) {
	chain := make([]gin.HandlerFunc, 0, len(handlers)+1)
	if perm != "" {
		chain = append(chain, RequirePermission(perm))
	}
	chain = append(chain, handlers...)
	g.Handle(method, path, chain...)
	fullPath := g.BasePath() + path
	if path == "" {
		fullPath = g.BasePath()
	}
	adminRoutes = append(adminRoutes, adminRoutePerm{method: method, path: fullPath, perm: perm})
}

// AdminRoutePerms exposes the registry (for the integrity test).
func AdminRoutePerms() []struct {
	Method string
	Path   string
	Perm   string
} {
	out := make([]struct {
		Method string
		Path   string
		Perm   string
	}, 0, len(adminRoutes))
	for _, r := range adminRoutes {
		out = append(out, struct {
			Method string
			Path   string
			Perm   string
		}{r.method, r.path, r.perm})
	}
	return out
}
