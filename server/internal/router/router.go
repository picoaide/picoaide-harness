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

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/bootstrap"
	"github.com/picoaide/picoaide/internal/capabilities"
	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/portal"
	"github.com/picoaide/picoaide/internal/reports"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/sharedskills"
	"github.com/picoaide/picoaide/internal/telemetry"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/skillseed"
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
	Market      *marketplace.Handlers
	Agentshare  *agentshare.Handlers
	Shared      *sharedskills.Handlers
	Capability  *capabilities.Handlers
	Connector   *connectors.Handlers
	Telemetry   *telemetry.Handlers
	Gateway     *llmgateway.Handlers
	Reports     *reports.Handlers

	// Wasm 是 WASM 应用平台的操作面（设计基线
	// docs/planning/2026-09-17-wasm-app-platform.md §8）。
	//
	// ⚠️ 客户端专属模型（2026-09-19）之后不再有"应用子域路由树"：应用请求由桌面
	// 客户端的协议 handler 合成、经 `/api/client/v2/apps/wasm/:app_id/request` 进入
	// （见 registerClientV2 里的 wasm 应用分组），因此这里的管理端点天然只在主站可见。
	Wasm *wasmapi.Handlers
	// ⚠️ `WasmSession *session.Manager` 与它带来的五条主站 HTML 路由
	// （`GET|POST /login`、`POST /logout`、`GET|POST /app-ticket`）已随 W4 删除：
	// 员工浏览器会话的唯一用途是"给应用子域换票"，而应用不再有对外主机名，
	// 身份一律由桌面客户端持员工 bearer 注入（总纲 §8.4）。
	// SkillSeed 内置技能下发面（随服务端镜像发布：/opt/picoaide/skills）。
	// 见 internal/wasmapp/skillseed —— 与 ClientRelease 同一范式，只是下发的是
	// 技能包而不是安装包；客户端按需安装，不自动装。
	SkillSeed *skillseed.Handlers
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
}

// registerWasm 挂载 WASM 应用平台的全部端点（设计基线 §8 操作面全表）。
//
// 全部路径集中在**本包**声明（仓库纪律：业务包不得自行 r.Group() 注册生产路由）。
func registerWasm(r *gin.Engine, d Deps) {
	if d.Wasm == nil {
		return
	}
	// 客户端员工面：Bearer 认证。上传体上限 48 MiB（§4.2/R21）⇒ 两条上传路由
	// 必须进 largeBodyRoutes 豁免 1 MB 中间件；**豁免只是豁免**，handler 内自己
	// 还要套 MaxBytesReader（§4.2 原话）。
	wg := r.Group(NamespaceClientV2+"/apps/wasm", bodyLimitMiddleware(), serverauth.BearerAuth(d.DB))
	wg.POST("/validate", d.Wasm.Validate)
	wg.POST("/:app_id/releases", d.Wasm.Publish)
	wg.POST("/:app_id/publish", d.Wasm.SetPublished)
	wg.POST("/:app_id/unpublish", d.Wasm.SetPublished)
	wg.POST("/:app_id/freeze", d.Wasm.Freeze)
	wg.GET("/:app_id/export", d.Wasm.Export)
	wg.DELETE("/:app_id", d.Wasm.Delete)
	wg.GET("/:app_id/diagnostics", d.Wasm.Diagnostics)
	wg.GET("/:app_id/schema", d.Wasm.Schema)
	// 作者的数据面（2026-09-21）：只读浏览自己应用库里的行。
	// 鉴权沿用 ownedApp（仅发布者本人，他人 404 同形），每次调用写审计
	//（`wasm_app_rows_view`；显式要原值时是 `wasm_app_rows_view_unmasked`）。
	// 见 internal/wasmapp/api/rows.go 的安全论证与 docs/decisions。
	wg.GET("/:app_id/rows", d.Wasm.Rows)
	// 标识唯一性预查（2026-09-20）：发布表单填 app_id 时异步问它、提交前再问一次。
	// **只读**（不编译/不写盘/不占版本号/不进审计/不消耗上传额度），因此不进
	// largeBodyRoutes 也没必要限流；判据与发布同源（GetWasmApp + checkOwner）。
	wg.GET("/:app_id/availability", d.Wasm.Availability)
	// 发布者本人的版本历史 + 审核结论（含被拒理由）。R1-pm-3：审核开关一旦打开，
	// 发布者此前只有发布那一刻的"待审核"一句话，之后**永远**收不到结论
	// （reason 写了没人读、版本号又永久占位）—— 这条是作者侧唯一的结论出口。
	// 鉴权沿用 ownedApp：**非发布者一律 404，且与"应用不存在"逐字节同形**
	// （不泄露存在性）；返回体不含制品字节。
	wg.GET("/:app_id/releases", d.Wasm.MyReleases)
	wg.GET("/catalog", d.Wasm.Catalog)

	// ===== 客户端专属访问模型（2026-09-19 决策）=====
	//
	// 应用只在桌面客户端内可用：客户端注册的自定义协议 handler 把
	// `picoaide-app://<app_id>/…` 上的请求包成信封送到这里执行，
	// 身份由客户端注入（它持有员工 bearer）。旧的应用子域 + 换票链路在 W4 波次删除。
	// 决策与架构：docs/decisions/2026-09-19-wasm-client-internal-origin.md。
	//
	// **唯一入口**：`request` 必须持员工令牌（BearerAuth，契约 §4.1）；
	// 匿名入口（`anon-request`）随匿名面一起删除（契约 §1 第 2 条 / §4.4「无匿名」）。
	wg.POST("/:app_id/request", d.Wasm.ClientRequest)

	// 持有性证明（app-proof，契约 §20.1/§23.1）：**签发**端点。
	//
	// 为什么签发要 BearerAuth：proof 绑的是"哪个员工 + 哪把 bearer"，
	// 签发本身是"证明你持有这把 bearer 与这把安装私钥"（安装签名见 §23.1）。
	// 路由是静态段（无 :app_id）：绑定用的 app_id 在请求体里，且必须过 registry 校验
	// —— 一张 proof 只对一个应用有效（R2S-2/N2：不绑 app_id 就能跨应用重放）。
	wg.POST("/proof", d.Wasm.AppProofIssue)

	// 打开校验与计数（F16，契约 §5.1b / §8.9）：**每次打开动作调一次**。
	//
	// 顺序冻结：BearerAuth（本组中间件）→ app-proof → 应用反查。
	// 响应头 `X-PicoAide-App-Version` 是客户端内容**缓存键的唯一来源**（R1-DAT-12）。
	wg.POST("/:app_id/open", d.Wasm.OpenApp)

	// ---- 分片上传与续传（§4.2 / §7.3）----
	//
	// 为什么必须分片：客户端上传超时 90 s > 服务端 ReadTimeout 60 s > 编译 60 s，
	// 32 MiB 一次 POST 必然撞 60 s 的 ReadTimeout（§10.5 第 58 项）。
	// 端点语义（实现见 wasmapp/api/upload.go，存储见 wasmapp/upload）：
	//
	//	POST   /uploads                          开会话（小 JSON，**不**豁免）
	//	PUT    /uploads/:upload_id/chunks/:index 上传第 index 片（application/octet-stream）
	//	GET    /uploads/:upload_id               续传查询（已收到哪些片）
	//	POST   /uploads/:upload_id/complete      拼装并走既有发布链路（小 JSON，**不**豁免）
	//	DELETE /uploads/:upload_id               主动放弃（回收磁盘）
	//
	// 只有 PUT 那一条进 largeBodyRoutes（单片可达 8 MiB > 1 MiB 默认上限）；
	// 其余四条都是小 JSON。**豁免只是豁免**：PUT 的 handler 内部自己再套
	// http.MaxBytesReader 并先查 Content-Length（§4.2 原话）。
	wg.POST("/uploads", d.Wasm.UploadCreate)
	wg.PUT("/uploads/:upload_id/chunks/:index", d.Wasm.UploadChunk)
	wg.GET("/uploads/:upload_id", d.Wasm.UploadStatus)
	wg.POST("/uploads/:upload_id/complete", d.Wasm.UploadComplete)
	wg.DELETE("/uploads/:upload_id", d.Wasm.UploadAbort)

	// 管理面最小运维面（R23）：应用列表 / 下架 / 转移归属 / 冻结 + 审核开关。
	// 权限点复用能力中心的粗粒度点（§13：RBAC 沿用资源类别级 + 应用层 owner 比较，
	// 不造实例级权限点）。
	ag := r.Group(NamespaceServer+"/admin/wasm-apps", bodyLimitMiddleware(), serverauth.AdminAuth(d.DB))
	serverauth.AdminRoute(ag, "GET", "", serverauth.PermCapabilityRead, d.Wasm.AdminList)
	serverauth.AdminRoute(ag, "POST", "/:app_id/unpublish", serverauth.PermCapabilityWrite, d.Wasm.AdminUnpublish)
	// 上架：与下架对称（下架是管理员的处置动作，处置完必须能恢复）。
	serverauth.AdminRoute(ag, "POST", "/:app_id/publish", serverauth.PermCapabilityWrite, d.Wasm.AdminPublish)
	serverauth.AdminRoute(ag, "PUT", "/:app_id/owner", serverauth.PermCapabilityWrite, d.Wasm.AdminTransferOwner)
	serverauth.AdminRoute(ag, "POST", "/:app_id/freeze", serverauth.PermCapabilityWrite, d.Wasm.AdminFreeze)
	serverauth.AdminRoute(ag, "PUT", "/review", serverauth.PermCapabilityWrite, d.Wasm.AdminReview)
	// 审核队列（P0-1）：待审清单 + 通过/拒绝。
	//
	// 为什么必须有这三条：R17 的开关一旦打开，publish.go 就把新版本落成 pending，
	// 而生效版本只认 approved —— 没有审批出口时"开启审核"= 全组织再也发不出新版本，
	// 且界面上没有任何地方能看到积压。读写权限点与既有列表/处置一致
	// （capability:read 看队列 / capability:write 处置）。
	serverauth.AdminRoute(ag, "GET", "/:app_id/releases", serverauth.PermCapabilityRead, d.Wasm.AdminReleases)
	serverauth.AdminRoute(ag, "POST", "/:app_id/releases/:version/approve", serverauth.PermCapabilityWrite, d.Wasm.AdminApproveRelease)
	serverauth.AdminRoute(ag, "POST", "/:app_id/releases/:version/reject", serverauth.PermCapabilityWrite, d.Wasm.AdminRejectRelease)
	// ⚠️ 应用泛域名配置（`GET|PUT /domain`、设置键 `wasm.apps_base_domain`）已随 W4
	// 删除：应用不再有对外主机名（总纲 §8.4）。历史设置行保留在库里但不再被读取。
	// 平台限制项（并发/内存）：2026-09-19 用户要求"后台要有配置页面"。
	// 读用 capability:read（与列表同权限点），写用 capability:write。
	serverauth.AdminRoute(ag, "GET", "/limits", serverauth.PermCapabilityRead, d.Wasm.AdminLimitsGet)
	serverauth.AdminRoute(ag, "PUT", "/limits", serverauth.PermCapabilityWrite, d.Wasm.AdminLimitsPut)
	// 管理面诊断与运行时水位（2026-09-19，P1-9/P2-4）：两条都是**只读**，
	// 因此都用 capability:read。
	//
	// 为什么管理面必须有诊断出口：诊断能力（diag 包 + wasm_call_events）此前只有
	// 员工 Bearer 面一条出口，鉴权是"发布者本人" —— 管理员排障调不到，页面也没有
	// 入口，只能找发布者或用员工令牌手搓 curl。这里只**新增**管理面出口，
	// 员工面的鉴权语义一字未改（发布者仍只看得到自己的应用）。
	serverauth.AdminRoute(ag, "GET", "/:app_id/diagnostics", serverauth.PermCapabilityRead, d.Wasm.AdminDiagnostics)
	// 管理面的只读数据面（2026-09-21）：表结构 + 行浏览，与员工面同形同实现，
	// 差别只有鉴权（管理会话 + capability:read）与操作者账号（进审计）。
	// 为什么管理员也要有：排障与合规（员工面的 schema/rows 只认发布者本人，
	// 管理员借用他人令牌会让审计记错人）。
	serverauth.AdminRoute(ag, "GET", "/:app_id/schema", serverauth.PermCapabilityRead, d.Wasm.AdminSchema)
	serverauth.AdminRoute(ag, "GET", "/:app_id/rows", serverauth.PermCapabilityRead, d.Wasm.AdminRows)
	// runtime 是平台级（无 app 维度）的只读水位：编译队列/缓存、执行槽、调用事件
	// 丢包计数、磁盘余量，以及"还没有出口"的水位清单。挂在 /limits 同级的静态段上，
	// 与既有的 /review、/limits 一样不参与 /:app_id 的通配。
	serverauth.AdminRoute(ag, "GET", "/runtime", serverauth.PermCapabilityRead, d.Wasm.AdminRuntime)
	// 打开计数（F16 / §8.9 管理端出口④）：只读，与列表/诊断同权限点。
	// 数据来自日汇总表（长期保留），明细（含 user_id/部门）仅 capability:read 可见
	// —— 隐私口径见迁移 0075 与 §8.9 的合规说明。
	serverauth.AdminRoute(ag, "GET", "/:app_id/opens", serverauth.PermCapabilityRead, d.Wasm.AdminAppOpens)
	// 看板概览（W5 C2）：**静态段** `opens/summary`，与 `/:app_id/opens` 同层但更具体
	// ⇒ 由 gin 的静态优先规则命中本行（不会落到 :app_id 通配上）。
	serverauth.AdminRoute(ag, "GET", "/opens/summary", serverauth.PermCapabilityRead, d.Wasm.AdminOpensSummary)
	// 应用维度 AI 用量（W5 C4）：数据源是 0076 的 usage.app_id（§21.4 的归因列）。
	serverauth.AdminRoute(ag, "GET", "/:app_id/ai-usage", serverauth.PermCapabilityRead, d.Wasm.AdminAppAIUsage)
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

	// 技能商城
	mg := cli.Group("/marketplace", serverauth.BearerAuth(d.DB))
	mg.GET("/skills", d.Market.ListSkills)
	mg.GET("/skills/:name", d.Market.GetSkill)
	mg.GET("/skills/:name/archive", d.Market.DownloadArchive)

	// 内置技能(随服务端镜像发布,见 internal/wasmapp/skillseed)。
	// 内容在镜像层(/opt/picoaide/skills),随镜像升级而更新;客户端在能力中心
	// 按需安装(下载 → sha256 对照 → 整树解包 → <dshHome>/skills)。
	// 认证口径与市场/共享技能一致:**BearerAuth** —— 未登录时连"平台内置了
	// 哪些技能"都不该被枚举,而客户端本来就得先登录才有意义。
	// 响应头契约与 marketplace 相同(X-Skill-Checksum / X-Skill-Version),
	// 客户端安装器靠它做完整性对照。
	builtinSkills := cli.Group("/skills/builtin", serverauth.BearerAuth(d.DB))
	builtinSkills.GET("", d.SkillSeed.ListBuiltin)
	builtinSkills.GET("/:name/archive", d.SkillSeed.BuiltinDownload)

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
	// 客户端错误上报状态(P1-3/D7):客户端回报自身 error-reporting 初始化结果,
	// 管理端在「错误监控」页展示 N 台已启用 / M 台失败(不再靠猜)。非致命语义:
	// 未知 state 静默 ok 不写库,限流复用 telemetry 的 callLimiter。
	cli.POST("/telemetry/error-reporting", serverauth.BearerAuth(d.DB), d.Telemetry.ReportErrorReporting)
}

// registerGatewayV1 挂载 DeepSeek 兼容的 LLM 网关 API,与官方完全一致:
// 官方原生端点(/chat/completions、/completions、/responses、/models)
// + OpenAI/Anthropic 兼容(/v1/*)。独立于 /api/* 管理命名空间,第三方按
// DeepSeek 标准 baseURL(server 或 server/v1、server/anthropic) 接入。
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

	// 官方原生端点(base_url=server, 无 /v1 前缀)。
	gw := r.Group("", serverauth.BearerAuth(d.DB), llmgateway.InFlightGuard())
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
	// 错误上报自检 + 客户端状态聚合(2026-09-16 P0-4/P1-3):
	// test = 服务端代发一条测试事件(D3:浏览器直发拿不到可读失败原因);
	// clients = 客户端上报状态聚合(D7)。
	serverauth.AdminRoute(authed, "POST", "/gateway/error-reporting/test", serverauth.PermGatewayWrite, d.Gateway.TestErrorReporting)
	serverauth.AdminRoute(authed, "GET", "/gateway/error-reporting/clients", serverauth.PermGatewayRead, d.Gateway.ErrorReportingClients)
	serverauth.AdminRoute(authed, "GET", "/channels", serverauth.PermGatewayRead, d.Gateway.ListChannelsAdmin)
	// 按模型并发状态(当前 + 90 天峰值 + 目标;2026-08-31 扩容申请指标)
	serverauth.AdminRoute(authed, "GET", "/concurrency", serverauth.PermGatewayRead, d.Gateway.ConcurrencyStatus)

	// 报表订阅(2026-09 P1):月度用量报表推送 webhook
	// 列表含 hook_url(凭据本体)⇒ 用独立的 report:read(不进 AuditorPermissions),
	// 不再挂在 usage:read 上(审计 2026-09-12 P1-4)。
	serverauth.AdminRoute(authed, "GET", "/report-subscriptions", serverauth.PermReportRead, d.Reports.List)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions", serverauth.PermReportWrite, d.Reports.Create)
	serverauth.AdminRoute(authed, "PUT", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Update)
	serverauth.AdminRoute(authed, "DELETE", "/report-subscriptions/:id", serverauth.PermReportWrite, d.Reports.Delete)
	serverauth.AdminRoute(authed, "POST", "/report-subscriptions/:id/test", serverauth.PermReportWrite, d.Reports.TestPush)

	// 技能商城管理
	serverauth.AdminRoute(authed, "GET", "/skills", serverauth.PermMarketRead, d.Market.ListSkillsAdmin)
	// 平台内置技能（**只读诊断面**，2026-09-19）：镜像资产，不是数据库行 ——
	// 没有上架/授权/审批/owner 语义，所以这里只有一条 GET，权限点用 capability:read
	// （与 /wasm-apps/* 的读端点同口径）。
	//
	// ⚠️ 路径与市场技能的 `GET /skills/:name` 同级：gin 的静态段优先于参数段，
	// 因此名字恰为 `builtin` 的市场技能在这一条 GET 上不可达（其余
	// `/skills/:name/*` 端点不受影响）。这是刻意接受的代价：内置技能是"平台带了
	// 什么"的基础事实，比一个极端命名更该有稳定入口。
	serverauth.AdminRoute(authed, "GET", "/skills/builtin", serverauth.PermCapabilityRead, d.SkillSeed.AdminListBuiltin)
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
	// 组织共享技能上下架(2026-09-15):与市场技能同一语义(apps.enabled),但作用于
	// org 渠道行;员工可见性与下载都由该标志闸住(见 serverstore.ListVisibleSharedSkills
	// 与 sharedskills.download)。市场技能仍走 marketplace 的 /skills/:name 端点。
	serverauth.AdminRoute(authed, "PUT", "/shared-skills/:name/enabled", serverauth.PermCapabilityWrite, d.Shared.SetEnabled)
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
	// 组织共享智能体上下架(SG-4,2026-09-17):与上面共享技能的
	// PUT /shared-skills/:name/enabled 对称 —— 同一 RBAC 权限点、同一 JSON 信封、
	// 同一 apps.enabled 语义(读侧三处闸门早已就位:ListVisibleAgentPresets /
	// agentshare.listVisible / serveArchive)。市场渠道智能体仍走 marketplace 的
	// POST /agents/:name/enable,两条路径互不越界(requireOrgAgent / 渠道守卫)。
	serverauth.AdminRoute(authed, "PUT", "/agent-presets/:name/enabled", serverauth.PermCapabilityWrite, d.Agentshare.SetEnabled)

	// 能力中心管理
	serverauth.AdminRoute(authed, "GET", "/capabilities/approvals", serverauth.PermCapabilityRead, d.Capability.ListApprovals)

	// 连接器管理
	serverauth.AdminRoute(authed, "GET", "/connectors", serverauth.PermConnectorRead, d.Connector.List)
	serverauth.AdminRoute(authed, "GET", "/connectors/:id", serverauth.PermConnectorRead, d.Connector.Get)
	serverauth.AdminRoute(authed, "POST", "/connectors", serverauth.PermConnectorWrite, d.Connector.Create)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Update)
	serverauth.AdminRoute(authed, "DELETE", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Remove)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id/enabled", serverauth.PermConnectorWrite, d.Connector.SetEnabled)

	// 门户管理(2026-09-10:品牌管理面已删除 —— 名称/文案/标识来自渠道配置,
	// 改内容 = 改渠道配置并重新构建镜像,因此没有在线编辑端点)
	serverauth.AdminRoute(authed, "GET", "/portal", serverauth.PermPortalRead, d.PortalAdmin.Get)
	serverauth.AdminRoute(authed, "PUT", "/portal", serverauth.PermPortalWrite, d.PortalAdmin.Put)
}
