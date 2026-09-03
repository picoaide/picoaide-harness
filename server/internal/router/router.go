// Package router 集中声明 PicoAide 服务端全部 API 路由分组(工程化重构,
// 审计 2026-09): 命名空间统一为两个根 ——
//
//	/api/server    → 服务端管理面(webadmin/运维: 用户/部门/网关/品牌/审计…)
//	/api/client/v2 → 客户端员工面(桌面客户端: auth/bootstrap/marketplace/网关…)
//
// 设计(路径全集中): 各业务包公开 handler 供给(NewHandlers(db, ...) 等),
// 全部路径+方法+认证中间件+权限申报集中在本包一份 Register 调用——可枚举、
// 可审计、fall-open 防护天然成立。旧命名空间(/api、/v1、/v2/api、/v2/v1)
// 迁移后不再保留(迁移式)。
package router

import (
	"database/sql"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/brand"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
)

// 命名空间根(集中常量, 全仓库唯一真源)。
const (
	// NamespaceServer 服务端管理面(无版本号, 管理员/运维/审计用)。
	NamespaceServer = "/api/server"
	// NamespaceClientV2 客户端员工面(v2 大版本; 桌面客户端/员工接入用)。
	NamespaceClientV2 = "/api/client/v2"
)

// Deps 汇聚路由声明所需的全部 handler 集合与依赖(cmd/server 组装注入)。
type Deps struct {
	DB *sql.DB

	Auth       *serverauth.ClientHandlers
	Admin      *serverauth.AdminHandlers
	Appstore   *appstore.Handlers
	Bootstrap  *bootstrap.Handlers
	Brand      *brand.Handlers
	Market     *marketplace.Handlers
	Agentshare *agentshare.Handlers
	Shared     *sharedskills.Handlers
	Capability *capabilities.Handlers
	Connector  *connectors.Handlers
	Telemetry  *telemetry.Handlers
	Gateway    *llmgateway.Handlers
	Reports    *reports.Handlers
}

// Register 集中装配两个命名空间分组下的全部路由。
func Register(r *gin.Engine, deps Deps) {
	cli := r.Group(NamespaceClientV2)
	srv := r.Group(NamespaceServer)

	// ================= 客户端面 /api/client/v2 =================
	registerClientV2(cli, deps)

	// ================= 服务端管理面 /api/server =================
	registerServer(srv, deps)

	// ================= DeepSeek 兼容 LLM 网关 /v1(独立命名空间) =================
	registerGatewayV1(r, deps)
}

// registerClientV2 客户端员工面全部端点。
func registerClientV2(cli *gin.RouterGroup, d Deps) {
	// 认证面
	ag := cli.Group("/auth")
	ag.POST("/login", d.Auth.Login)
	ag.POST("/logout", serverauth.BearerAuth(d.DB), d.Auth.Logout)
	ag.GET("/me", serverauth.BearerAuth(d.DB), d.Auth.Me)
	ag.GET("/usage", serverauth.BearerAuth(d.DB), d.Auth.Usage)
	// 0057 员工自助改密(本地认证用户; 改密后全部令牌吊销, 客户端重新登录)。
	ag.POST("/password", serverauth.BearerAuth(d.DB), d.Auth.ChangePassword)
	// 公开发现: 登录方式(客户端登录页未登录时探测; 与 /api/server/admin 同 handler)。
	ag.GET("/methods", d.Admin.PublicMethods)
	for _, ro := range d.Auth.OIDC {
		ag.GET("/"+ro.Name+"/login", ro.Login)
		ag.GET("/"+ro.Name+"/callback", ro.Callback)
	}

	// 启动配置
	cli.GET("/config/bootstrap", serverauth.BearerAuth(d.DB), d.Bootstrap.Bootstrap)

	// 品牌/门户(公开)
	cli.GET("/brand", d.Brand.PublicBrand)
	cli.GET("/brand/logo/:name", d.Brand.Logo)
	cli.HEAD("/brand/logo/:name", d.Brand.Logo)
	cli.GET("/portal", d.Brand.PublicPortal)

	// 技能商城
	mg := cli.Group("/marketplace", serverauth.BearerAuth(d.DB))
	mg.GET("/skills", d.Market.ListSkills)
	mg.GET("/skills/:name", d.Market.GetSkill)
	mg.GET("/skills/:name/archive", d.Market.DownloadArchive)

	// 共享技能
	sg := cli.Group("/shared-skills", serverauth.BearerAuth(d.DB))
	sg.GET("", d.Shared.ListVisible)
	sg.POST("", d.Shared.Upload)
	sg.GET("/:name/:version/archive", d.Shared.Download)

	// 共享 Agent(预设)
	psg := cli.Group("/agent-presets", serverauth.BearerAuth(d.DB))
	psg.GET("", d.Agentshare.ListVisible)
	psg.POST("", d.Agentshare.Upload)
	psg.GET("/:name/archive", d.Agentshare.Download)
	psg.GET("/:name/:version/archive", d.Agentshare.DownloadVersioned)

	// 能力中心
	cg := cli.Group("/capabilities", serverauth.BearerAuth(d.DB))
	cg.GET("", d.Capability.ListCapabilities)

	// 遥测
	cli.POST("/telemetry/skill-call", serverauth.BearerAuth(d.DB), d.Telemetry.ReportSkillCall)
}

// registerGatewayV1 挂载 DeepSeek 兼容的 LLM 网关 API,与官方完全一致:
// 官方原生端点(/chat/completions、/completions、/responses、/models)
// + OpenAI/Anthropic 兼容(/v1/*)。独立于 /api/* 管理命名空间,第三方按
// DeepSeek 标准 baseURL(server 或 server/v1、server/anthropic) 接入。
func registerGatewayV1(r *gin.Engine, d Deps) {
	// OpenAI/Anthropic 兼容形态(OpenAI SDK base_url=server 自动补 /v1;
	// Anthropic SDK base_url=server/anthropic 用 /v1/messages)。
	v1 := r.Group("/v1", serverauth.BearerAuth(d.DB))
	v1.POST("/chat/completions", d.Gateway.ChatCompletions)
	v1.POST("/embeddings", d.Gateway.Embeddings)
	v1.POST("/messages", d.Gateway.Messages)
	v1.POST("/completions", d.Gateway.Completions)
	v1.POST("/responses", d.Gateway.Responses)
	v1.GET("/models", d.Gateway.Models)

	// 官方原生端点(base_url=server, 无 /v1 前缀)。
	gw := r.Group("", serverauth.BearerAuth(d.DB))
	gw.POST("/chat/completions", d.Gateway.ChatCompletions)
	gw.POST("/embeddings", d.Gateway.Embeddings)
	gw.POST("/completions", d.Gateway.Completions)
	gw.POST("/responses", d.Gateway.Responses)
	gw.GET("/models", d.Gateway.Models)
	// Anthropic 原生兼容(base_url=server/anthropic): SDK 请求 /v1/messages,
	// 已由上面 v1 组覆盖;再挂 /messages 兜底变体。
	gw.POST("/messages", d.Gateway.Messages)
}

// registerServer 服务端管理面全部端点。
func registerServer(srv *gin.RouterGroup, d Deps) {
	sg := srv.Group("/admin")
	// 公开: 管理登录(含 0057 两步验证第二步) + 登录方式发现
	sg.POST("/login", d.Admin.Login)
	sg.POST("/login/mfa", d.Admin.LoginMFA)
	sg.GET("/auth/methods", d.Admin.PublicMethods)

	// 会话内(AdminAuth + RBAC)
	authed := sg.Group("", serverauth.AdminAuth(d.DB))
	serverauth.AdminRoute(authed, "GET", "/me", "", d.Admin.Me)
	serverauth.AdminRoute(authed, "POST", "/logout", "", d.Admin.Logout)
	// 0057 密码/MFA 自助管理(任意管理角色; 有效会话 + CSRF + 旧密码/动态码双验)
	serverauth.AdminRoute(authed, "POST", "/me/password", "", d.Admin.MePassword)
	serverauth.AdminRoute(authed, "GET", "/me/mfa", "", d.Admin.GetMyMFA)
	serverauth.AdminRoute(authed, "POST", "/me/mfa/enable", "", d.Admin.EnableMyMFA)
	serverauth.AdminRoute(authed, "POST", "/me/mfa/verify", "", d.Admin.VerifyMyMFA)
	serverauth.AdminRoute(authed, "POST", "/me/mfa/disable", "", d.Admin.DisableMyMFA)

	// 用户/部门
	serverauth.AdminRoute(authed, "GET", "/users", serverauth.PermUserRead, d.Admin.ListUsers)
	serverauth.AdminRoute(authed, "POST", "/users", serverauth.PermUserWrite, d.Admin.CreateUser)
	serverauth.AdminRoute(authed, "PUT", "/users/:id", serverauth.PermUserWrite, d.Admin.UpdateUser)
	serverauth.AdminRoute(authed, "DELETE", "/users/:id", serverauth.PermUserWrite, d.Admin.DeleteUser)
	// 0057: 管理员重置他人 MFA(不能对自己; 关闭后吊销其全部会话)。
	serverauth.AdminRoute(authed, "PUT", "/users/:id/mfa", serverauth.PermUserWrite, d.Admin.ResetUserMFA)
	serverauth.AdminRoute(authed, "GET", "/users/:id/groups", serverauth.PermUserRead, d.Admin.GetUserGroups)
	serverauth.AdminRoute(authed, "PUT", "/users/:id/department", serverauth.PermDeptWrite, d.Admin.SetUserDept)
	serverauth.AdminRoute(authed, "GET", "/departments", serverauth.PermDeptRead, d.Admin.ListDepts)
	serverauth.AdminRoute(authed, "POST", "/departments", serverauth.PermDeptWrite, d.Admin.CreateDept)
	serverauth.AdminRoute(authed, "PUT", "/departments/:id", serverauth.PermDeptWrite, d.Admin.UpdateDept)
	serverauth.AdminRoute(authed, "DELETE", "/departments/:id", serverauth.PermDeptWrite, d.Admin.DeleteDept)
	serverauth.AdminRoute(authed, "GET", "/users/:id/tokens", serverauth.PermUserRead, d.Admin.ListUserTokens)
	serverauth.AdminRoute(authed, "POST", "/tokens/:id/revoke", serverauth.PermUserWrite, d.Admin.RevokeToken)
	serverauth.AdminRoute(authed, "GET", "/usage", serverauth.PermUsageRead, d.Admin.Usage)
	// 用量中心(2026-09 重构):总览聚合 + 请求级明细
	serverauth.AdminRoute(authed, "GET", "/usage/overview", serverauth.PermUsageRead, d.Admin.UsageOverview)
	serverauth.AdminRoute(authed, "GET", "/usage/requests", serverauth.PermUsageRead, d.Admin.UsageRequests)
	serverauth.AdminRoute(authed, "GET", "/server-info", serverauth.PermServerInfoRead, d.Admin.ServerInfo)
	serverauth.AdminRoute(authed, "GET", "/audit", serverauth.PermAuditRead, d.Admin.ListAuditLogs)
	// G13 审计保留策略(可配; 写仅 super_admin)。
	serverauth.AdminRoute(authed, "GET", "/audit/settings", serverauth.PermAuditRead, d.Admin.GetAuditSettings)
	serverauth.AdminRoute(authed, "PUT", "/audit/settings", serverauth.PermAuditRetention, d.Admin.PutAuditSettings)
	serverauth.AdminRoute(authed, "GET", "/auth", serverauth.PermAuthRead, d.Admin.GetAuthConfig)
	serverauth.AdminRoute(authed, "PUT", "/auth", serverauth.PermAuthWrite, d.Admin.SetAuthConfig)
	serverauth.AdminRoute(authed, "POST", "/auth/test", serverauth.PermAuthWrite, d.Admin.TestConn)

	// 网关管理
	serverauth.AdminRoute(authed, "GET", "/providers", serverauth.PermGatewayRead, d.Gateway.ListProviders)
	serverauth.AdminRoute(authed, "GET", "/providers/:id/balance", serverauth.PermGatewayRead, d.Gateway.ProviderBalance)
	serverauth.AdminRoute(authed, "POST", "/providers", serverauth.PermGatewayWrite, d.Gateway.CreateProvider)
	serverauth.AdminRoute(authed, "PUT", "/providers/:id", serverauth.PermGatewayWrite, d.Gateway.UpdateProvider)
	serverauth.AdminRoute(authed, "DELETE", "/providers/:id", serverauth.PermGatewayWrite, d.Gateway.DeleteProvider)
	serverauth.AdminRoute(authed, "POST", "/providers/:id/sync", serverauth.PermGatewayWrite, d.Gateway.SyncOneAdmin)
	serverauth.AdminRoute(authed, "POST", "/providers/sync-all", serverauth.PermGatewayWrite, d.Gateway.SyncAllAdmin)
	serverauth.AdminRoute(authed, "GET", "/models", serverauth.PermGatewayRead, d.Gateway.ListModelsAdmin)
	serverauth.AdminRoute(authed, "POST", "/models", serverauth.PermGatewayWrite, d.Gateway.CreateModel)
	serverauth.AdminRoute(authed, "PUT", "/models/:id", serverauth.PermGatewayWrite, d.Gateway.UpdateModel)
	serverauth.AdminRoute(authed, "DELETE", "/models/:id", serverauth.PermGatewayWrite, d.Gateway.DeleteModel)
	serverauth.AdminRoute(authed, "GET", "/gateway", serverauth.PermGatewayRead, d.Gateway.GetGatewayConfig)
	serverauth.AdminRoute(authed, "PUT", "/gateway", serverauth.PermGatewayWrite, d.Gateway.SetGatewayConfig)
	serverauth.AdminRoute(authed, "GET", "/channels", serverauth.PermGatewayRead, d.Gateway.ListChannelsAdmin)
	// 按模型并发状态(当前 + 90 天峰值 + 目标;2026-08-31 扩容申请指标)
	serverauth.AdminRoute(authed, "GET", "/concurrency", serverauth.PermGatewayRead, d.Gateway.ConcurrencyStatus)

	// 报表订阅(2026-09 P1):月度用量报表推送 webhook
	serverauth.AdminRoute(authed, "GET", "/report-subscriptions", serverauth.PermUsageRead, d.Reports.List)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions", serverauth.PermReportWrite, d.Reports.Create)
	serverauth.AdminRoute(authed, "PUT", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Update)
	serverauth.AdminRoute(authed, "DELETE", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Delete)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions/:id/test", serverauth.PermReportWrite, d.Reports.TestPush)

	// 技能商城管理
	serverauth.AdminRoute(authed, "GET", "/skills", serverauth.PermMarketRead, d.Market.ListSkillsAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills", serverauth.PermMarketWrite, d.Market.CreateSkillAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/archive", serverauth.PermMarketWrite, d.Market.UploadSkillArchiveAdmin)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name", serverauth.PermMarketWrite, d.Market.UpdateSkillAdmin)
	serverauth.AdminRoute(authed, "DELETE", "/skills/:name", serverauth.PermMarketWrite, d.Market.DeleteSkillAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/enable", serverauth.PermMarketWrite, d.Market.EnableSkillAdmin)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/preview", serverauth.PermMarketRead, d.Market.PreviewSkillAdmin)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/file", serverauth.PermMarketRead, d.Market.FileContentSkillAdmin)
	serverauth.AdminRoute(authed, "POST", "/skills/:name/normalize", serverauth.PermMarketWrite, d.Market.NormalizeSkillAdmin)
	// 市场智能体管理(G4 2026-09-04):与市场技能同构。
	serverauth.AdminRoute(authed, "GET", "/agents", serverauth.PermMarketRead, d.Market.ListAgentsAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents", serverauth.PermMarketWrite, d.Market.CreateAgentAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents/:name/archive", serverauth.PermMarketWrite, d.Market.UploadAgentArchiveAdmin)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name", serverauth.PermMarketWrite, d.Market.UpdateAgentAdmin)
	serverauth.AdminRoute(authed, "DELETE", "/agents/:name", serverauth.PermMarketWrite, d.Market.DeleteAgentAdmin)
	serverauth.AdminRoute(authed, "POST", "/agents/:name/enable", serverauth.PermMarketWrite, d.Market.EnableAgentAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/preview", serverauth.PermMarketRead, d.Market.PreviewAgentAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/file", serverauth.PermMarketRead, d.Market.FileContentAgentAdmin)
	serverauth.AdminRoute(authed, "GET", "/agents/:name/grants", serverauth.PermMarketRead, d.Market.ListAgentGrants)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name/grants", serverauth.PermMarketWrite, d.Market.ReplaceAgentGrants)
	serverauth.AdminRoute(authed, "PUT", "/agents/:name/grant", serverauth.PermMarketWrite, d.Market.SetAgentGrant)
	serverauth.AdminRoute(authed, "DELETE", "/agents/:name/grant", serverauth.PermMarketWrite, d.Market.RemoveAgentGrant)
	serverauth.AdminRoute(authed, "GET", "/skills/:name/grants", serverauth.PermMarketRead, d.Market.ListSkillGrants)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name/grants", serverauth.PermMarketWrite, d.Market.ReplaceSkillGrants)
	serverauth.AdminRoute(authed, "PUT", "/skills/:name/grant", serverauth.PermMarketWrite, d.Market.SetSkillGrant)
	serverauth.AdminRoute(authed, "DELETE", "/skills/:name/grant", serverauth.PermMarketWrite, d.Market.RemoveSkillGrant)

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
	// 归属转移(2026-09-02):统一模型的管理端点——owner 是 (kind, app_id) 级,
	// 与版本无关,故挂 apps 基路径。
	serverauth.AdminRoute(authed, "PUT", "/apps/:kind/:app_id/owner", serverauth.PermCapabilityWrite, d.Appstore.TransferOwner)
	serverauth.AdminRoute(authed, "GET", "/shared-skills/:name/grants", serverauth.PermCapabilityRead, d.Shared.ListGrants)
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/grants", serverauth.PermCapabilityWrite, d.Shared.ReplaceGrants)
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/grant", serverauth.PermCapabilityWrite, d.Shared.SetGrant)
	serverauth.AdminRoute(authed, "DELETE", "/shared-skills/:name/grant", serverauth.PermCapabilityWrite, d.Shared.RemoveGrant)

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

	// 能力中心管理
	serverauth.AdminRoute(authed, "GET", "/capabilities/approvals", serverauth.PermCapabilityRead, d.Capability.ListApprovals)

	// 连接器管理
	serverauth.AdminRoute(authed, "GET", "/connectors", serverauth.PermConnectorRead, d.Connector.List)
	serverauth.AdminRoute(authed, "GET", "/connectors/:id", serverauth.PermConnectorRead, d.Connector.Get)
	serverauth.AdminRoute(authed, "POST", "/connectors", serverauth.PermConnectorWrite, d.Connector.Create)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Update)
	serverauth.AdminRoute(authed, "DELETE", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Remove)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id/enabled", serverauth.PermConnectorWrite, d.Connector.SetEnabled)

	// 品牌/门户管理
	serverauth.AdminRoute(authed, "GET", "/brand", serverauth.PermBrandRead, d.Brand.AdminBrand)
	serverauth.AdminRoute(authed, "PUT", "/brand", serverauth.PermBrandWrite, d.Brand.PutAdminBrand)
	serverauth.AdminRoute(authed, "POST", "/brand/logo", serverauth.PermBrandWrite, d.Brand.UploadLogo)
	serverauth.AdminRoute(authed, "DELETE", "/brand/logo", serverauth.PermBrandWrite, d.Brand.DeleteLogo)
	serverauth.AdminRoute(authed, "GET", "/brand/snapshots", serverauth.PermBrandRead, d.Brand.ListSnapshots)
	serverauth.AdminRoute(authed, "POST", "/brand/restore", serverauth.PermBrandWrite, d.Brand.RestoreSnapshot)
	serverauth.AdminRoute(authed, "GET", "/portal", serverauth.PermPortalRead, d.Brand.AdminPortal)
	serverauth.AdminRoute(authed, "PUT", "/portal", serverauth.PermPortalWrite, d.Brand.PutAdminPortal)
}
