package serverauth

import "strings"

// ---------------------------------------------------------------------------
// 管理面命名空间的**申报判据**（R4-C-2，审计 2026-09-23，P2）
// ---------------------------------------------------------------------------
//
// 缺陷形态：`/api/server/admin/*` 的"全部申报"守卫用的是**字面量前缀**
// `"/api/server/admin/"`（含尾斜杠）。在规定的路由落点 `internal/router/router.go`
// 里新加一条管理面路由时，三种写法会同时躲过 fall-open 守卫与镜像对拍：
//
//	/api/server/admin-extra/probe-x   前缀近似（不含尾斜杠）⇒ fall-open 不命中
//	/api/server/ops/probe-x           同命名空间另一分组 ⇒ 两条守卫都不命中
//	/api/server/admin                 恰好等于前缀去掉尾斜杠 ⇒ fall-open 不命中
//
// 判据必须与危害同构：危害是"**管理面命名空间下出现了未申报的路由**"，所以判据是
// **命名空间级**的 —— 遍历 `/api/server` 下的**每一条**路由，断言它要么在
// `AdminRoutePerms()` 申报表里、要么在下面这张**显式公开豁免表**里；豁免表按
// `(method, path)` **精确匹配**（不得用前缀包含关系放行），且反过来要求"登记了却
// 不存在"的陈旧条目也判红。
//
// 三个判据都是 fail-loud，且判据实现（AdminNamespaceViolations）是纯函数，可以用
// 注入的路由集合自证判别力（见 cmd/server/main_test.go 与 rbac_test.go 的对照子用例）。

// AdminNamespaceServer 是服务端管理面命名空间的**唯一真源副本**。
//
// 真源在 `internal/router`（`router.NamespaceServer`），但 serverauth 被 router 依赖，
// 反向 import 会成环 ⇒ 这里保留一份常量，并由
// `cmd/server/route_namespace_parity_test.go` 断言两者逐字相等（漂移即红）。
const AdminNamespaceServer = "/api/server"

// AdminRouteExemption 是一条公开（未认证）管理面路由的豁免登记：必须写明理由。
type AdminRouteExemption struct {
	Method string
	Path   string
	Reason string
}

// PublicAdminRoutes 是 `/api/server` 命名空间下**不过 AdminAuth/RBAC** 的公开路由。
//
// 之所以要独立一张表而不是"在 fall-open 扫描里跳过 login"：公开面是**安全决策**
// （任何新增都需要理由），必须以显式清单的形式被 review；清单里的每一条都必须真实
// 存在（陈旧条目判红，防止"清单越长越像有守卫"）。
func PublicAdminRoutes() []AdminRouteExemption {
	return []AdminRouteExemption{
		{"POST", AdminNamespaceServer + "/admin/login", "管理端登录第一步（未认证，自带 IP/账号双维度限流）"},
		{"POST", AdminNamespaceServer + "/admin/login/mfa", "管理端两步登录第二步（票据在第一步签发，未认证）"},
		{"GET", AdminNamespaceServer + "/admin/auth/methods", "登录方式发现（登录页渲染前调用，未认证，不泄露账号存在性）"},
	}
}

// InServerNamespace 判定一条路由路径是否属于管理面命名空间。
//
// 判据是**路径分段**（`p == namespace` 或 `p` 以 `namespace + "/"` 开头），不是裸前缀
// 包含：`/api/server-something`、`/api/serverless` 不属于本命名空间；而
// `/api/server`（恰好无尾斜杠）与 `/api/server/ops/x` **属于** —— 后者正是审计里
// 能绕过旧守卫的写法之一。
func InServerNamespace(path string) bool {
	return path == AdminNamespaceServer || strings.HasPrefix(path, AdminNamespaceServer+"/")
}

// AdminNamespaceViolations 是"管理面命名空间下每条路由都已申报或已豁免"的**唯一判据**。
//
// routes  = 生产/镜像路由表里的 "METHOD /path" 集合。
// declared= AdminRoutePerms() 展开的 "METHOD /path" 集合。
// public  = PublicAdminRoutes() 展开的 "METHOD /path" 集合（精确匹配）。
//
// 返回 (undeclared, stale)：
//
//	undeclared = 命名空间内既未申报也未豁免的路由（必须判红）；
//	stale      = 申报表/豁免表里登记了、但路由表里不存在的条目（必须判红）。
//
// 纯函数：调用方把自己的路由集合传进来即可自证判别力（不需要为"注入一条假路由"去改
// 生产装配）。
func AdminNamespaceViolations(routes []string, declared, public map[string]bool) (undeclared, stale []string) {
	seen := make(map[string]bool, len(routes))
	for _, key := range routes {
		path := methodPath(key)
		if !InServerNamespace(path) {
			continue
		}
		seen[key] = true
		if declared[key] || public[key] {
			continue
		}
		undeclared = append(undeclared, key)
	}
	// 陈旧条目：豁免表是"安全决策清单"，申报表是"权限清单"，两者都必须与真实
	// 路由表对得上（少了说明改名/删除后没清理，多了说明守卫在保护一个不存在的东西）。
	for key := range public {
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	// declared 里包含 /api/server 之外的路由没有意义（申报表只服务管理面），但这里
	// 只反向核对"命名空间内已申报的条目是否仍然存在"，避免把别人的表也判红。
	for key := range declared {
		if !InServerNamespace(methodPath(key)) {
			continue
		}
		if !seen[key] {
			stale = append(stale, key)
		}
	}
	return undeclared, stale
}

// methodPath 从 "METHOD /path" 里取出路径（无空格时原样返回）。
func methodPath(key string) string {
	if i := strings.IndexByte(key, ' '); i >= 0 {
		return key[i+1:]
	}
	return key
}

// MethodPathSet 把 "METHOD /path" 列表展开成集合（判据三处调用共用的唯一实现）。
func MethodPathSet(keys []string) map[string]bool {
	out := make(map[string]bool, len(keys))
	for _, k := range keys {
		out[k] = true
	}
	return out
}
