//go:build skills

package main

// 本文件登记"模块自有的、未认证扫描只能看到 JSON 401 的非 JSON 面"
// （P1 第二片，2026-10-14 起按模块分文件）。
//
// 为什么按变体分文件：这些路由只在其模块编进来时才在路由树上（关闭态整片不注册），
// 而 `sweepCheckExceptionTables` 有一条硬判据"登记了却 never 命中 ⇒ 表在说谎"。
// 把表按变体拆开，两种形态下这条判据都保持原样生效，而不是被放宽。
//
// 归属：表里 15 条**全部**属于技能面（判定见 off 文件）。因此 build 约束是 `skills`，
// 其它两个模块的开关不影响本表 —— 两种形态下"登记了就必须被扫到"这条判据都成立。

// sweepModuleAuthGatedNonJSONSurfaces 是模块自有的非 JSON 例外面。
var sweepModuleAuthGatedNonJSONSurfaces = map[string]string{
	"GET /api/client/v2/skills/builtin/:name/archive":            "内置技能归档（application/gzip）",
	"GET /api/client/v2/marketplace/skills/:name/archive":        "商城技能归档（application/gzip）",
	"GET /api/client/v2/agent-presets/:name/archive":             "智能体预设归档（application/gzip）",
	"GET /api/client/v2/agent-presets/:name/:version/archive":    "智能体预设指定版本归档（application/gzip）",
	"GET /api/client/v2/shared-skills/:name/:version/archive":    "组织共享技能归档（application/gzip）",
	"POST /api/server/admin/skills/:name/archive":                "管理端技能归档（application/gzip，重新打包）",
	"GET /api/server/admin/skills/:name/file":                    "管理端技能单文件（原样字节）",
	"GET /api/server/admin/agents/:name/file":                    "管理端智能体单文件（原样字节）",
	"GET /api/server/admin/skills/:name/archive":                 "管理端市场技能归档（application/gzip；zip 归档时为 application/zip 原样字节）",
	"GET /api/server/admin/agents/:name/archive":                 "管理端市场智能体归档（application/gzip；zip 归档时为 application/zip 原样字节）",
	"GET /api/server/admin/agent-presets/:name/archive":          "管理端预设归档（application/gzip）",
	"GET /api/server/admin/agent-presets/:name/:version/archive": "管理端预设指定版本归档（application/gzip）",
	"GET /api/server/admin/agent-presets/:name/:version/file":    "管理端预设单文件（原样字节）",
	"GET /api/server/admin/shared-skills/:name/:version/archive": "管理端组织共享技能归档（application/gzip）",
	"GET /api/server/admin/shared-skills/:name/:version/file":    "管理端组织共享技能单文件（原样字节）",
}
