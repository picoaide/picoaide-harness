//go:build skills

package router

// 本文件是 `skills` 模块**打开**时的类型与路由接线（P1 第二片，2026-10-14）。
//
// 五组 handler（Market / Shared / Agentshare / Capability / SkillSeed）在这里
// 一次注册完毕：关闭态由 `optional_skills_off.go` 提供同名空实现，整片路由连同
// handler 类型一起从产物里消失。

import (
	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/skillseed"
)

// 技能面的五个 handler 类型（`skills` 打开时都是**别名**：Deps 字段名、复合
// 字面量的键与方法集全不变，调用点零改写）。
type (
	// MarketAPI 技能商城（`apps.channel='market'`）的管理面与员工面。
	MarketAPI = marketplace.Handlers
	// SharedSkillsAPI 组织共享技能（`channel='org'`）的上传/审校/授权。
	SharedSkillsAPI = sharedskills.Handlers
	// AgentshareAPI 组织共享 Agent 预设。
	AgentshareAPI = agentshare.Handlers
	// CapabilitiesAPI 能力中心审批面。
	CapabilitiesAPI = capabilities.Handlers
	// SkillSeedAPI 平台内置技能下发面（随镜像发布，见 internal/skillseed）。
	SkillSeedAPI = skillseed.Handlers
)

// registerSkillsClientRoutes 注册 `/api/client/v2` 下技能面的全部端点。
//
// **逐组提前 return**（而不是把 nil 交给 gin）：gin 的 `addRoute` 只断言
// `len(handlers) > 0`，传 nil handler 会**照常注册**，症状是每个请求
// panic→Recovery→500 —— 既不是约定的 404，也躲开"路由消失声明表"的视线。
//
// 为什么按**组**而不是按"整片五组一起"守：每一组各自只依赖一个 handler，
// 合并成一个大条件会让"只有某一组缺 handler"时**另外四组也跟着消失**
// （判据面看不见的连带失效）。组内缺 handler ⇒ 只有那一组不注册。
func registerSkillsClientRoutes(cli *gin.RouterGroup, d Deps) {
	registerMarketClientRoutes(cli, d)
	registerBuiltinSkillsRoutes(cli, d)
	registerSharedSkillsClientRoutes(cli, d)
	registerAgentPresetsClientRoutes(cli, d)
	registerCapabilitiesClientRoutes(cli, d)
}

// registerMarketClientRoutes 注册员工面技能商城（`apps.channel='market'`）。
func registerMarketClientRoutes(cli *gin.RouterGroup, d Deps) {
	if d.Market == nil {
		return
	}
	mg := cli.Group("/marketplace", serverauth.BearerAuth(d.DB))
	mg.GET("/skills", d.Market.ListSkills)
	mg.GET("/skills/:name", d.Market.GetSkill)
	mg.GET("/skills/:name/archive", d.Market.DownloadArchive)

}

// registerBuiltinSkillsRoutes 注册平台内置技能下发面。
//
// 内容在镜像层(/opt/picoaide/skills),随镜像升级而更新;客户端在能力中心
// 按需安装(下载 → sha256 对照 → 整树解包 → <dshHome>/skills)。
// 认证口径与市场/共享技能一致:**BearerAuth** —— 未登录时连"平台内置了
// 哪些技能"都不该被枚举,而客户端本来就得先登录才有意义。
// 响应头契约与 marketplace 相同(X-Skill-Checksum / X-Skill-Version),
// 客户端安装器靠它做完整性对照。
func registerBuiltinSkillsRoutes(cli *gin.RouterGroup, d Deps) {
	if d.SkillSeed == nil {
		return
	}
	builtinSkills := cli.Group("/skills/builtin", serverauth.BearerAuth(d.DB))
	builtinSkills.GET("", d.SkillSeed.ListBuiltin)
	builtinSkills.GET("/:name/archive", d.SkillSeed.BuiltinDownload)
}

// registerSharedSkillsClientRoutes 注册员工面组织共享技能。
func registerSharedSkillsClientRoutes(cli *gin.RouterGroup, d Deps) {
	if d.Shared == nil {
		return
	}
	sg := cli.Group("/shared-skills", serverauth.BearerAuth(d.DB))
	sg.GET("", d.Shared.ListVisible)
	sg.POST("", d.Shared.Upload)
	sg.GET("/:name/:version/archive", d.Shared.Download)

}

// registerAgentPresetsClientRoutes 注册员工面组织共享 Agent（预设）。
func registerAgentPresetsClientRoutes(cli *gin.RouterGroup, d Deps) {
	if d.Agentshare == nil {
		return
	}
	psg := cli.Group("/agent-presets", serverauth.BearerAuth(d.DB))
	psg.GET("", d.Agentshare.ListVisible)
	psg.POST("", d.Agentshare.Upload)
	psg.GET("/:name/archive", d.Agentshare.Download)
	psg.GET("/:name/:version/archive", d.Agentshare.DownloadVersioned)

}

// registerCapabilitiesClientRoutes 注册员工面能力中心目录。
func registerCapabilitiesClientRoutes(cli *gin.RouterGroup, d Deps) {
	if d.Capability == nil {
		return
	}
	cg := cli.Group("/capabilities", serverauth.BearerAuth(d.DB))
	cg.GET("", d.Capability.ListCapabilities)
}

// registerSkillsAdminRoutes 注册 `/api/server/admin` 下技能面的全部端点
// （技能商城 / 市场智能体 / 共享技能 / 共享 Agent / 能力中心审批）。
//
// **逐组提前 return**（理由与员工面同，见 registerSkillsClientRoutes 的注释）。
func registerSkillsAdminRoutes(authed *gin.RouterGroup, d Deps) {
	registerMarketAdminRoutes(authed, d)
	registerBuiltinSkillsAdminRoutes(authed, d)
	registerSharedSkillsAdminRoutes(authed, d)
	registerAgentPresetsAdminRoutes(authed, d)
	registerCapabilitiesAdminRoutes(authed, d)
}

// registerBuiltinSkillsAdminRoutes 注册平台内置技能的**只读诊断面**。
//
// 镜像资产，不是数据库行 —— 没有上架/授权/审批/owner 语义，所以只有一条 GET，
// 权限点用 capability:read（与 /wasm-apps/* 的读端点同口径）。
//
// ⚠️ 路径与市场技能的 `GET /skills/:name` 同级：gin 的静态段优先于参数段，
// 因此名字恰为 `builtin` 的市场技能在这一条 GET 上不可达（其余
// `/skills/:name/*` 端点不受影响）。这是刻意接受的代价：内置技能是"平台带了
// 什么"的基础事实，比一个极端命名更该有稳定入口。
func registerBuiltinSkillsAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.SkillSeed == nil {
		return
	}
	serverauth.AdminRoute(authed, "GET", "/skills/builtin", serverauth.PermCapabilityRead, d.SkillSeed.AdminListBuiltin)
}

// registerMarketAdminRoutes 注册技能商城与市场智能体的管理面。
func registerMarketAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Market == nil {
		return
	}
	serverauth.AdminRoute(authed, "GET", "/skills", serverauth.PermMarketRead, d.Market.ListSkillsAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills", serverauth.PermMarketWrite, d.Market.CreateSkillAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/archive", serverauth.PermMarketWrite, d.Market.UploadSkillArchiveAdmin)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name", serverauth.PermMarketWrite, d.Market.UpdateSkillAdmin)
	serverauth.AdminRoute(authed, "DELETE", "/skills/:name", serverauth.PermMarketWrite, d.Market.DeleteSkillAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/enable", serverauth.PermMarketWrite, d.Market.EnableSkillAdmin)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/preview", serverauth.PermMarketRead, d.Market.PreviewSkillAdmin)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/file", serverauth.PermMarketRead, d.Market.FileContentSkillAdmin)
	// 归档下载(2026-09-23):预览弹层「文件过大 → 下载归档」的落点(预览基路径
	// + /archive)。此前市场两个命名空间只有 POST …/archive(上传新版),市场行的
	// 该链接必 404;组织侧对应端点是 /shared-skills/:name/:version/archive 与
	// /agent-presets/:name/:version/archive。权限与同命名空间既有下载面一致
	// (GET /skills/:name/file、/agents/:name/file 都是 market:read)。
	serverauth.AdminRoute(authed, "GET", "/skills/:name/archive", serverauth.PermMarketRead, d.Market.DownloadSkillArchiveAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/normalize", serverauth.PermMarketWrite, d.Market.NormalizeSkillAdmin)
	// 市场智能体管理(G4 2026-09-04):与市场技能同构。
	//
	// 渠道边界(A-8,2026-09-23 第三轮审计):这一片是**市场命名空间**,只服务
	// `apps.channel='market'` 的智能体行 —— 逐名端点统一过
	// `marketplace.requireMarketAgent`(org 行 ⇒ 404,与"不存在"逐字节同形);
	// 组织共享库的孪生端点走 `agentshare.requireOrgAgent`(反方向)。
	// "哪些面经论证**故意**跨渠道"(登记/上传新版靠读 org 行回 409 跨源同名互斥)
	// 的唯一真源 = `internal/marketplace/channel.go` 的 `marketAgentRoutePolicy`,
	// 由 `TestAgentAdminRoutesAreMarketOnlyOrRegistered` 与运行时路由表双向对拍。
	serverauth.AdminRoute(authed, "GET", "/agents", serverauth.PermMarketRead, d.Market.ListAgentsAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents", serverauth.PermMarketWrite, d.Market.CreateAgentAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents/:name/archive", serverauth.PermMarketWrite, d.Market.UploadAgentArchiveAdmin)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name", serverauth.PermMarketWrite, d.Market.UpdateAgentAdmin)
	serverauth.AdminRoute(authed, "DELETE", "/agents/:name", serverauth.PermMarketWrite, d.Market.DeleteAgentAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents/:name/enable", serverauth.PermMarketWrite, d.Market.EnableAgentAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/preview", serverauth.PermMarketRead, d.Market.PreviewAgentAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/file", serverauth.PermMarketRead, d.Market.FileContentAgentAdmin)
	// 归档下载(2026-09-23,与技能侧同形同权限):预览弹层「文件过大 → 下载归档」。
	serverauth.AdminRoute(authed, "GET", "/agents/:name/archive", serverauth.PermMarketRead, d.Market.DownloadAgentArchiveAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/grants", serverauth.PermMarketRead, d.Market.ListAgentGrants)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name/grants", serverauth.PermMarketWrite, d.Market.ReplaceAgentGrants)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name/grant", serverauth.PermMarketWrite, d.Market.SetAgentGrant)
	serverauth.AdminRoute(authed, "DELETE", "/agents/:name/grant", serverauth.PermMarketWrite, d.Market.RemoveAgentGrant)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/grants", serverauth.PermMarketRead, d.Market.ListSkillGrants)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name/grants", serverauth.PermMarketWrite, d.Market.ReplaceSkillGrants)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name/grant", serverauth.PermMarketWrite, d.Market.SetSkillGrant)
	serverauth.AdminRoute(authed, "DELETE", "/skills/:name/grant", serverauth.PermMarketWrite, d.Market.RemoveSkillGrant)

}

// registerSharedSkillsAdminRoutes 注册组织共享技能与能力锁定的管理面。
func registerSharedSkillsAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Shared == nil {
		return
	}
	// 共享技能管理
	serverauth.AdminRoute(authed, "GET", "/shared-skills", serverauth.PermCapabilityRead, d.Shared.ListAll)
	serverauth.AdminRoute(authed, "GET", "/shared-skills/:name/:version/archive", serverauth.PermCapabilityRead, d.Shared.DownloadAdmin)
	serverauth.AdminRoute(authed, "GET", "/shared-skills/:name/:version/preview", serverauth.PermCapabilityRead, d.Shared.Preview)
	serverauth.AdminRoute(authed, "POST", "/shared-skills/:name/:version/approve", serverauth.PermCapabilityWrite, d.Shared.Decide)
	serverauth.AdminRoute(authed, "POST", "/shared-skills/:name/:version/reject", serverauth.PermCapabilityWrite, d.Shared.Reject)
	serverauth.AdminRoute(authed, "DELETE", "/shared-skills/:name/:version", serverauth.PermCapabilityWrite, d.Shared.Remove)
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/:version/quality", serverauth.PermCapabilityWrite, d.Shared.SetQuality)
	serverauth.AdminRoute(authed, "GET", "/shared-skills/:name/:version/file", serverauth.PermCapabilityRead, d.Shared.FileContent)
	// 能力锁定(D4:仅管理员可发布的技能/智能体名单,支持对尚不存在的名字预锁定)
	serverauth.AdminRoute(authed, "GET", "/capability-locks", serverauth.PermCapabilityRead, d.Shared.ListLocks)
	serverauth.AdminRoute(authed, "PUT", "/capability-locks/:kind/:name", serverauth.PermCapabilityWrite, d.Shared.SetLock)
	serverauth.AdminRoute(authed, "DELETE", "/capability-locks/:kind/:name", serverauth.PermCapabilityWrite, d.Shared.RemoveLock)
	serverauth.AdminRoute(authed, "GET", "/shared-skills/:name/grants", serverauth.PermCapabilityRead, d.Shared.ListGrants)
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/grants", serverauth.PermCapabilityWrite, d.Shared.ReplaceGrants)
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/grant", serverauth.PermCapabilityWrite, d.Shared.SetGrant)
	// 组织共享技能上下架(2026-09-15):与市场技能同一语义(apps.enabled),但作用于
	// org 渠道行;员工可见性与下载都由该标志闸住(见 serverstore.ListVisibleSharedSkills
	// 与 sharedskills.download)。市场技能仍走 marketplace 的 /skills/:name 端点。
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/enabled", serverauth.PermCapabilityWrite, d.Shared.SetEnabled)
	serverauth.AdminRoute(authed, "DELETE", "/shared-skills/:name/grant", serverauth.PermCapabilityWrite, d.Shared.RemoveGrant)

}

// registerAgentPresetsAdminRoutes 注册组织共享 Agent 的管理面。
func registerAgentPresetsAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Agentshare == nil {
		return
	}
	// 共享 Agent 管理
	serverauth.AdminRoute(authed, "GET", "/agent-presets", serverauth.PermCapabilityRead, d.Agentshare.ListAll)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/archive", serverauth.PermCapabilityRead, d.Agentshare.DownloadAdmin)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/preview", serverauth.PermCapabilityRead, d.Agentshare.Preview)
	serverauth.AdminRoute(authed, "POST", "/agent-presets/:name/approve", serverauth.PermCapabilityWrite, d.Agentshare.Decide)
	serverauth.AdminRoute(authed, "POST", "/agent-presets/:name/reject", serverauth.PermCapabilityWrite, d.Agentshare.Reject)
	serverauth.AdminRoute(authed, "DELETE", "/agent-presets/:name", serverauth.PermCapabilityWrite, d.Agentshare.Remove)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/:version/archive", serverauth.PermCapabilityRead, d.Agentshare.DownloadAdminVersioned)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/:version/preview", serverauth.PermCapabilityRead, d.Agentshare.PreviewVersioned)
	serverauth.AdminRoute(authed, "POST", "/agent-presets/:name/:version/approve", serverauth.PermCapabilityWrite, d.Agentshare.DecideVersioned)
	serverauth.AdminRoute(authed, "POST", "/agent-presets/:name/:version/reject", serverauth.PermCapabilityWrite, d.Agentshare.RejectVersioned)
	serverauth.AdminRoute(authed, "DELETE", "/agent-presets/:name/:version", serverauth.PermCapabilityWrite, d.Agentshare.RemoveVersioned)
	serverauth.AdminRoute(authed, "PUT", "/agent-presets/:name/:version/quality", serverauth.PermCapabilityWrite, d.Agentshare.SetPresetQuality)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/:version/file", serverauth.PermCapabilityRead, d.Agentshare.PresetFileContent)
	serverauth.AdminRoute(authed, "GET", "/agent-presets/:name/grants", serverauth.PermCapabilityRead, d.Agentshare.ListPresetGrants)
	serverauth.AdminRoute(authed, "PUT", "/agent-presets/:name/grants", serverauth.PermCapabilityWrite, d.Agentshare.ReplacePresetGrants)
	serverauth.AdminRoute(authed, "PUT", "/agent-presets/:name/grant", serverauth.PermCapabilityWrite, d.Agentshare.SetPresetGrant)
	serverauth.AdminRoute(authed, "DELETE", "/agent-presets/:name/grant", serverauth.PermCapabilityWrite, d.Agentshare.RemovePresetGrant)
	// 组织共享智能体上下架(SG-4,2026-09-17):与上面共享技能的
	// PUT /shared-skills/:name/enabled 对称 —— 同一 RBAC 权限点、同一 JSON 信封、
	// 同一 apps.enabled 语义(读侧三处闸门早已就位:ListVisibleAgentPresets /
	// agentshare.listVisible / serveArchive)。市场渠道智能体仍走 marketplace 的
	// POST /agents/:name/enable,两条路径互不越界(requireOrgAgent / 渠道守卫)。
	serverauth.AdminRoute(authed, "PUT", "/agent-presets/:name/enabled", serverauth.PermCapabilityWrite, d.Agentshare.SetEnabled)

}

// registerCapabilitiesAdminRoutes 注册能力中心审批面。
func registerCapabilitiesAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Capability == nil {
		return
	}
	// 能力中心管理
	serverauth.AdminRoute(authed, "GET", "/capabilities/approvals", serverauth.PermCapabilityRead, d.Capability.ListApprovals)
}
