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
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/telemetry"
	// ⚠️ 可选模块（skills / apps / connectors）的 handler 包**不在**本文件的 import 里：
	// 它们的类型由 build-tag 文件（optional_*_on.go）以别名提供，关闭时是空类型 ⇒
	// 整棵包树从 `go list -deps ./cmd/server` 里消失。见
	// docs/decisions/2026-10-14-server-build-tags.md。
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

	Auth      *serverauth.ClientHandlers
	Admin     *serverauth.AdminHandlers
	Appstore  *appstore.Handlers
	Bootstrap *bootstrap.Handlers
	// ClientRelease 客户端安装包下发(随镜像发布,见 internal/clientrelease)。
	ClientRelease *clientrelease.Handlers
	// Channel 渠道内容下发(登录页/客户端界面/门户共用一份渠道配置)。
	Channel *channel.Handlers
	// PortalAdmin 门户页配置(公开面的名称/欢迎语来自渠道;此处只管分发与开关)。
	PortalAdmin *portal.AdminHandlers
	// ---- 可选模块（skills）：字段名是装配契约的一部分，**无论开关都存在**；
	// 类型由 build-tag 文件给出（skills 开 = 真 handler 的别名；关 = 空类型）。
	// 关闭时引用它们的路由注册代码编不进来 ⇒ 整片路由与 handler 树一起消失。
	Market     *MarketAPI
	Agentshare *AgentshareAPI
	Shared     *SharedSkillsAPI
	Capability *CapabilitiesAPI
	// ---- 可选模块（connectors）：同上。
	Connector *ConnectorsAPI
	Telemetry *telemetry.Handlers
	Gateway   *llmgateway.Handlers
	Reports   *reports.Handlers

	// Wasm 是 WASM 应用平台的操作面（设计基线
	// docs/planning/2026-09-17-wasm-app-platform.md §8）。
	//
	// ⚠️ 客户端专属模型（2026-09-19）之后不再有"应用子域路由树"：应用请求由桌面
	// 客户端的协议 handler 合成、经 `/api/client/v2/apps/wasm/:app_id/request` 进入
	// （见 registerClientV2 里的 wasm 应用分组），因此这里的管理端点天然只在主站可见。
	Wasm *WasmAPI
	// ⚠️ `WasmSession *session.Manager` 与它带来的五条主站 HTML 路由
	// （`GET|POST /login`、`POST /logout`、`GET|POST /app-ticket`）已随 W4 删除：
	// 员工浏览器会话的唯一用途是"给应用子域换票"，而应用不再有对外主机名，
	// 身份一律由桌面客户端持员工 bearer 注入（总纲 §8.4）。
	// SkillSeed 内置技能下发面（随服务端镜像发布：/opt/picoaide/skills）。
	// 见 internal/skillseed —— 与 ClientRelease 同一范式，只是下发的是
	// 技能包而不是安装包；客户端按需安装，不自动装。
	// 可选模块（skills）：技能面关闭时它是空类型（与 Market 同一条 build-tag 纪律）。
	SkillSeed *SkillSeedAPI
}

// Register 集中装配两个命名空间分组下的全部路由。
func Register(r *gin.Engine, deps Deps) {
	// P2-17: 两个业务命名空间统一挂 1MB 请求体上限(未认证的 /auth/login、
	// /admin/login 同样覆盖)。此前只有测试镜像(serverauth.RegisterAdminRoutes)
	// 挂了这层,生产路由树没有,客户端可推超大 JSON 致 OOM。
	cli := r.Group(NamespaceClientV2, bodyLimitMiddleware())
	srv := r.Group(NamespaceServer, bodyLimitMiddleware())

	// ================= 客户端面 /api/client/v2 =================
	registerClientV2(cli, deps)

	// ================= 服务端管理面 /api/server =================
	registerServer(srv, deps)

	// ================= DeepSeek 兼容 LLM 网关 /v1(独立命名空间) =================
	registerGatewayV1(r, deps)

	// ================= 客户端安装包下载(根路径,非 API) =================
	// 不走 /api 命名空间:这是大文件下载,与 /api 的强制 JSON 契约无关
	// (与归档下载同属"文件语义"例外)。挂根路径也让地址简短稳定:
	// https://<服务端>/updates/client/<文件名>
	// ServeFile 自带 Range/断点续传,无需额外中间件。
	r.GET("/updates/client/*file", deps.ClientRelease.File)
	r.HEAD("/updates/client/*file", deps.ClientRelease.File)

	// ⚠️ 员工浏览器会话与一次性换票（`/login`、`/logout`、`/app-ticket`）已随 W4
	// 整体删除（总纲 §8.4 + §9 迁移 0073）：那是"应用子域"模型的入口，应用改为只在
	// 桌面客户端内打开之后，平台上不再存在"把浏览器登录态换成应用会话"这条链路。
	// 员工/管理端的登录面分别是 `/api/client/v2/auth/login` 与
	// `/api/server/admin/login`（既有，未受影响）。

	// ================= WASM 应用平台操作面（§8）=================
	registerWasm(r, deps)

	// app_id 保留字收口（X4-1）：`app_id` 与 WASM 操作面的**路由静态段**同名
	// 时，`/apps/wasm/<static>/…` 会遮蔽 `/apps/wasm/:app_id/…`（`uploads` 是
	// 现场：应用能发布出去，但 open/request/publish/rows… 全部 404，建完即废
	// 且归属与版本号永久占位）。清单**从刚注册完的真实路由表派生**（不是手抄），
	// 且只收**真的会遮蔽** `:app_id` 的静态段（S7-2：同层但领不走下降的叶子段 ——
	// 例如 `catalog` / `proof` / `validate` —— 与更深层的 `rows` / `open` 都不是遮蔽段，
	// 收进来会把完全可用的名字判成不可用 ⇒ 存量应用永远发不出新版本）。
	// 注入 registry 的写侧校验；`wasm_appid_route_test.go` 断言"派生集合 == 真实
	// 匹配树上会遮蔽的集合（双向）"「派生集合 == 生效集合」「每个静态段都被写侧拒」
	// 「写侧接受的名字必须真的可达」，任一被拆掉都会红。
	publishWasmReservedAppIDs(r)
}

// maxJSONBody 是 /api/client/v2 与 /api/server 下全部端点的默认请求体上限
// (1MB 足够全部管理表单与客户端 JSON 请求)。
const maxJSONBody = 1 << 20

// largeBodyRoutes 自带更大请求体上限的路由(method + gin 路由模板):
// 归档上传 24MB(base64 膨胀)、品牌 logo 多图为 ≤4MB multipart。
// 这些路由由 handler 内部的 MaxBytesReader/multipart 解析限体;外层再套 1MB
// 会使内层上限失效(outer 先返回 body too large),故显式豁免。
var largeBodyRoutes = map[string]struct{}{
	"POST " + NamespaceServer + "/admin/skills/:name/archive": {}, // marketplace 24MB
	"POST " + NamespaceServer + "/admin/agents/:name/archive": {}, // agentshare 24MB
	"POST " + NamespaceClientV2 + "/shared-skills":            {}, // sharedskills 24MB
	"POST " + NamespaceClientV2 + "/agent-presets":            {}, // agentshare 24MB
	// WASM 应用上传：.wasm ≤ 32 MiB、base64 后请求体 ≤ 48 MiB（§4.2/R21）。
	// handler 内必须自己再套 http.MaxBytesReader(48<<20) 并先查 Content-Length。
	"POST " + NamespaceClientV2 + "/apps/wasm/validate":         {},
	"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/releases": {},
	// 分片上传的单片（§4.2：单片 ≤ UploadChunkMaxBytes = 8 MiB > 1 MiB 默认上限）。
	// 同理：豁免只是豁免，handler 内自己套 MaxBytesReader(8<<20) 并先查 Content-Length。
	// 开会话与 complete 是**小 JSON**，故意不进这张表。
	"PUT " + NamespaceClientV2 + "/apps/wasm/uploads/:upload_id/chunks/:index": {},
	// 客户端专属访问模型的请求信封（2026-09-19）：应用请求体上限 1 MiB
	//（limits.AppRequestBodyMaxBytes）经 base64 膨胀 4/3 ⇒ 信封可达 ~1.4 MiB，
	// 超过 1 MiB 默认上限。handler 内自套 MaxBytesReader 并先解码后再判一次。
	// 只有这一条（没有匿名入口：契约 §4.4「无匿名」）。
	"POST " + NamespaceClientV2 + "/apps/wasm/:app_id/request": {},
}

// bodyLimitExempt 判定某路由是否自带更大的请求体上限。
// 中间件在 gin 路由匹配之后执行,c.FullPath() 已是路由模板(如
// "/api/server/admin/skills/:name/archive")。
func bodyLimitExempt(method, fullPath string) bool {
	_, ok := largeBodyRoutes[method+" "+fullPath]
	return ok
}

// bodyLimitMiddleware 统一限制两个业务命名空间的请求体大小(P2-17)。
// 超限时 ShouldBindJSON 会读到 "http: request body too large",由各 handler
// 统一回 400 VALIDATION(不新增响应形态)。
func bodyLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil && !bodyLimitExempt(c.Request.Method, c.FullPath()) {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxJSONBody)
		}
		c.Next()
	}
}

// publicMethodsHandler 取"登录方式发现"的唯一 handler(两条路由共用:客户端
// 面 /api/client/v2/auth/methods 与管理端公开面 /api/server/admin/auth/methods)。
//
// R24-X4-B2:优先用**客户端认证 API** 的 handler —— 它带运行期视图,`configured`
// 与 `/auth/{oidc,openid}/login` 解析 provider 的那张表同源;管理端 handler 只在
// 最小装配(d.Auth 缺失,仅测试自建路由树)里兜底,那时按 settings 判定。
//
// 这里**只做一次选择**,两条路由都调本函数:两处各写一次判断就是"同一台服务端
// 两个说法"的温床。
func publicMethodsHandler(d Deps) gin.HandlerFunc {
	if d.Auth != nil && d.Auth.PublicMethods != nil {
		return d.Auth.PublicMethods
	}
	return d.Admin.PublicMethods
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
	// 公开发现: 登录方式(客户端登录页未登录时探测; 与管理端公开面同一实现)。
	//
	// R24-X4-B2: 判定必须带**运行期视图** —— settings 只决定"启用了哪些候选",
	// "此刻哪个真的可用"以客户端认证 API 的 provider 注册表为准(与
	// `/auth/{oidc,openid}/login` 自己解析 provider 的那张表同源)。旧接线用的是
	// 管理端 handler(只看 settings) ⇒ IdP discovery 失败时登录页照样渲染一颗
	// 点到 404 的 SSO 按钮。
	ag.GET("/methods", publicMethodsHandler(d))
	// F2(审计 2026-09-11): 固定注册 oidc/openid 两条路由,provider 在**请求时**
	// 从当前认证配置动态解析 —— webadmin 保存认证配置后立即生效,不再需要
	// 重启(旧实现把启动时快照的 provider 闭包写死在路由表里)。
	for _, name := range []string{"oidc", "openid"} {
		ag.GET("/"+name+"/login", d.Auth.BrowserLogin(name))
		ag.GET("/"+name+"/callback", d.Auth.BrowserCallback(name))
	}

	// 启动配置
	cli.GET("/config/bootstrap", serverauth.BearerAuth(d.DB), d.Bootstrap.Bootstrap)

	// 渠道内容(公开:客户端登录页在未登录时就要拿名称/标语/logo)
	cli.GET("/channel", d.Channel.PublicChannel)
	cli.GET("/channel/logo", d.Channel.Logo)
	cli.HEAD("/channel/logo", d.Channel.Logo)
	// 暗色 logo 与 favicon 各自独立端点(未配置时 404 JSON 信封):
	// 曾把三张图都指向 /channel/logo 且恒发浅色版,导致 favicon 与暗色
	// logo 的字节永远下发不了。
	cli.GET("/channel/logo-dark", d.Channel.LogoDark)
	cli.HEAD("/channel/logo-dark", d.Channel.LogoDark)
	cli.GET("/channel/favicon", d.Channel.Favicon)
	cli.HEAD("/channel/favicon", d.Channel.Favicon)

	// 客户端安装包(公开:员工首次安装与升级都要能取,登录前也要能拿)
	// 清单地址故意放在 /api/client/v2/updates/manifest,与更新服务器上的
	// latest.json 同形状 —— 客户端一套解析逻辑走两种来源。
	cli.GET("/updates/manifest", d.ClientRelease.Manifest)

	// 门户(公开;站点名/欢迎语来自渠道配置,见 internal/channel)

	// 技能面（skills）：市场/内置技能/共享技能/共享 Agent/能力中心。
	// 关闭 skills 时本函数是**编译期 no-op**（另一份 build-tag 文件），使整片
	// 路由连同 handler 类型一起从产物里消失 —— 绝不留"注册了但 handler 为 nil"。
	registerSkillsClientRoutes(cli, d)

	// 遥测
	cli.POST("/telemetry/skill-call", serverauth.BearerAuth(d.DB), d.Telemetry.ReportSkillCall)
	// 客户端错误上报状态(P1-3/D7):客户端回报自身 error-reporting 初始化结果,
	// 管理端在「错误监控」页展示 N 台已启用 / M 台失败(不再靠猜)。非致命语义:
	// 未知 state 静默 ok 不写库,限流复用 telemetry 的 callLimiter。
	cli.POST("/telemetry/error-reporting", serverauth.BearerAuth(d.DB), d.Telemetry.ReportErrorReporting)
}

// registerGatewayV1 挂载 DeepSeek 兼容的 LLM 网关 API:官方原生端点
// (/chat/completions、/completions、/responses、/models、/files)
// + OpenAI 兼容别名(/v1/*)。独立于 /api/* 管理命名空间,第三方按
// baseURL(server 或 server/v1) 接入。
//
// 与官方文档的已知差异(2026-09-22 盘点,别把本函数读成"与官方完全一致"):
//   - 官方的 /beta 前缀未实现(/beta/chat/completions 前缀续写、/beta/completions FIM);
//   - 官方 Anthropic 兼容前缀 /anthropic/v1/*(含 x-api-key 认证)未实现;
//   - GET /user/balance(密钥持有人视角)未实现,只有管理端 providers/:id/balance;
//   - 官方 429 = "账号级并发上限"(flash 2500 / v4-pro 500);我们的 429 是
//     余额不足/本地限流,语义不同。
func registerGatewayV1(r *gin.Engine, d Deps) {
	// OpenAI/Anthropic 兼容形态(OpenAI SDK base_url=server 自动补 /v1;
	// Anthropic SDK base_url=server/anthropic 用 /v1/messages)。
	// P2-11(审计 2026-09-13):单用户在跑的网关请求上限(防止单员工打满全站)。
	// 必须排在 BearerAuth 之后(中间件按声明顺序执行,准入需要已认证用户)。
	v1 := r.Group("/v1", serverauth.BearerAuth(d.DB), llmgateway.InFlightGuard())
	v1.POST("/chat/completions", d.Gateway.ChatCompletions)
	v1.POST("/embeddings", d.Gateway.Embeddings)
	v1.POST("/messages", d.Gateway.Messages)
	v1.POST("/completions", d.Gateway.Completions)
	v1.POST("/responses", d.Gateway.Responses)
	v1.GET("/models", d.Gateway.Models)
	// Files API(2026-09-22,官方 Files API 同形):客户端默认用 file_id 传图片,
	// 缺失则每步回落成 base64 内联。实现硬绑 DeepSeek 上游(见 llmgateway/files.go)。
	v1.POST("/files", d.Gateway.UploadFile)
	v1.GET("/files", d.Gateway.ListFiles)
	v1.GET("/files/:file_id", d.Gateway.RetrieveFile)
	v1.DELETE("/files/:file_id", d.Gateway.DeleteFile)

	// 官方原生端点(base_url=server, 无 /v1 前缀)。
	gw := r.Group("", serverauth.BearerAuth(d.DB), llmgateway.InFlightGuard())
	gw.POST("/chat/completions", d.Gateway.ChatCompletions)
	gw.POST("/embeddings", d.Gateway.Embeddings)
	gw.POST("/completions", d.Gateway.Completions)
	gw.POST("/responses", d.Gateway.Responses)
	gw.GET("/models", d.Gateway.Models)
	gw.POST("/files", d.Gateway.UploadFile)
	gw.GET("/files", d.Gateway.ListFiles)
	gw.GET("/files/:file_id", d.Gateway.RetrieveFile)
	gw.DELETE("/files/:file_id", d.Gateway.DeleteFile)
	// Anthropic Messages 的**别名**兜底:base_url=server 时 Anthropic SDK 请求
	// /v1/messages(由上面 v1 组覆盖),这里再挂根级 /messages。
	// 注意:官方 Anthropic 兼容的 base_url 是 <host>/anthropic(路径
	// /anthropic/v1/messages),该前缀我们**没有**实现,也没有实现 Anthropic SDK
	// 默认的 x-api-key 认证 ⇒ 按官方文档接入会 404/401(属未实现项,勿照注释误判)。
	gw.POST("/messages", d.Gateway.Messages)
}

// registerServer 服务端管理面全部端点。
func registerServer(srv *gin.RouterGroup, d Deps) {
	sg := srv.Group("/admin")
	// 公开: 管理登录(含 0057 两步验证第二步) + 登录方式发现
	sg.POST("/login", d.Admin.Login)
	sg.POST("/login/mfa", d.Admin.LoginMFA)
	// 与客户端面同一条判定(R24-X4-B2):两条 methods 路由必须给出同一个
	// `configured`,否则同一台服务端在登录页与管理面公开面上说法不一致。
	sg.GET("/auth/methods", publicMethodsHandler(d))

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
	// 0061/0062 员工余额(存量):单人调整/清零 + 流水账本 + 月度发放配置。
	serverauth.AdminRoute(authed, "POST", "/users/:id/balance", serverauth.PermUserWrite, d.Admin.AdjustBalance)
	serverauth.AdminRoute(authed, "GET", "/users/:id/balance/ledger", serverauth.PermUserRead, d.Admin.UserBalanceLedger)
	serverauth.AdminRoute(authed, "GET", "/balance", serverauth.PermUserRead, d.Admin.GetBalance)
	serverauth.AdminRoute(authed, "PUT", "/balance", serverauth.PermUserWrite, d.Admin.PutBalance)
	serverauth.AdminRoute(authed, "POST", "/balance/grant", serverauth.PermUserWrite, d.Admin.GrantBalance)
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
	// 网关文件台账的管理面(2026-09-22):按员工看占用 / 搜索 / 排序 / 清理。
	// 读 = gateway:read,写(删除/批量清理)= gateway:write。
	serverauth.AdminRoute(authed, "GET", "/gateway/files", serverauth.PermGatewayRead, d.Gateway.ListGatewayFiles)
	serverauth.AdminRoute(authed, "GET", "/gateway/files/summary", serverauth.PermGatewayRead, d.Gateway.GatewayFilesSummary)
	serverauth.AdminRoute(authed, "DELETE", "/gateway/files/:file_id", serverauth.PermGatewayWrite, d.Gateway.DeleteGatewayFile)
	serverauth.AdminRoute(authed, "POST", "/gateway/files/purge", serverauth.PermGatewayWrite, d.Gateway.PurgeGatewayFiles)
	// 错误上报自检 + 客户端状态聚合(2026-09-16 P0-4/P1-3):
	// test = 服务端代发一条测试事件(D3:浏览器直发拿不到可读失败原因);
	// clients = 客户端上报状态聚合(D7)。
	serverauth.AdminRoute(authed, "POST", "/gateway/error-reporting/test", serverauth.PermGatewayWrite, d.Gateway.TestErrorReporting)
	serverauth.AdminRoute(authed, "GET", "/gateway/error-reporting/clients", serverauth.PermGatewayRead, d.Gateway.ErrorReportingClients)
	serverauth.AdminRoute(authed, "GET", "/channels", serverauth.PermGatewayRead, d.Gateway.ListChannelsAdmin)
	// 按模型并发状态(当前 + 90 天峰值 + 目标;2026-08-31 扩容申请指标)
	serverauth.AdminRoute(authed, "GET", "/concurrency", serverauth.PermGatewayRead, d.Gateway.ConcurrencyStatus)

	// 归属转移(2026-09-02):统一模型的管理端点 —— owner 是 (kind, app_id) 级,
	// 与版本无关,故挂 apps 基路径。
	//
	// ⚠️ 它是**基础面**而不是技能面（P1 第二片，2026-10-14 的归位判断）：
	// `kind ∈ {skill, agent, wasm_app}` 三种共用同一张 `apps` 表与同一套 owner 语义，
	// 而 `appstore` 是共享底座（P0 规划 §5 第 8 条：两个变体都必须保留它）。
	// 把它放进 skills 会让"只开 apps"的变体失去应用归属转移入口 —— 那是功能缺失，
	// 不是裁剪。权限点 `capability:write` 本来就随 RBAC 常量保留（权限模型不随变体变）。
	serverauth.AdminRoute(authed, "PUT", "/apps/:kind/:app_id/owner", serverauth.PermCapabilityWrite, d.Appstore.TransferOwner)

	// 报表订阅(2026-09 P1):月度用量报表推送 webhook
	// 列表含 hook_url(凭据本体)⇒ 用独立的 report:read(不进 AuditorPermissions),
	// 不再挂在 usage:read 上(审计 2026-09-12 P1-4)。
	serverauth.AdminRoute(authed, "GET", "/report-subscriptions", serverauth.PermReportRead, d.Reports.List)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions", serverauth.PermReportWrite, d.Reports.Create)
	serverauth.AdminRoute(authed, "PUT", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Update)
	serverauth.AdminRoute(authed, "DELETE", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Delete)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions/:id/test", serverauth.PermReportWrite, d.Reports.TestPush)

	// 技能面管理端（skills）：技能商城/市场智能体/共享技能/共享 Agent/能力中心审批。
	// 与客户端面同一份开关；关闭时整片不注册（编译期 no-op）。
	registerSkillsAdminRoutes(authed, d)

	// 连接器管理（connectors）：关闭时整片不注册（编译期 no-op）。
	registerConnectorAdminRoutes(authed, d)

	// 门户管理(2026-09-10:品牌管理面已删除 —— 名称/文案/标识来自渠道配置,
	// 改内容 = 改渠道配置并重新构建镜像,因此没有在线编辑端点)
	serverauth.AdminRoute(authed, "GET", "/portal", serverauth.PermPortalRead, d.PortalAdmin.Get)
	serverauth.AdminRoute(authed, "PUT", "/portal", serverauth.PermPortalWrite, d.PortalAdmin.Put)
}
