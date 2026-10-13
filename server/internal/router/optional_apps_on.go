//go:build apps

package router

// 本文件是 `apps` 模块**打开**时的路由与类型接线（P1 第二片，2026-10-14）。
//
// 关闭态在 `optional_apps_off.go`：同一批标识符在那里是"空类型 + 空实现"，
// 于是引用它们的路由注册代码**编不进产物**（不是"注册了但 handler 为 nil"）。

import (
	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
)

// WasmAPI 是 WASM 应用平台操作面的 handler 集合。
//
// 它是**别名**而不是包装类型：`apps` 打开时它就是 `wasmapi.Handlers` 本身，
// 于是 `Deps.Wasm` 的字段名、复合字面量里的键、方法集全都不变（零调用点改写）。
type WasmAPI = wasmapi.Handlers

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
	// 为什么必须分片：服务端 `http.Server.ReadTimeout` 是 `limits.ServerReadTimeout`
	// （60 s）—— **与请求体大小无关的硬上限**。而 `.wasm` 上限 `limits.WasmMaxBytes`
	// 是 32 MiB（base64 JSON 后请求体 ≤ `limits.UploadBodyMaxBytes` = 48 MiB），
	// 一次 POST 在慢链路上必然撞这 60 s（§10.5 第 58 项；48 MiB 需约 6.7 Mbps 保底）。
	//
	// 预算链的**真实序关系**（唯一真源 `server/internal/limits/limits.go`，
	// 清单 `limits.json`；数字一律从那里读，不要凭记忆抄；
	// `limits_gen_test.go` 的 `TestCriticalValuesAndOrdering` 把这条序关系钉住）：
	//
	//	ClientUploadTimeout (90 s) > PublishTotalBudget (75 s) > CompileTimeout (60 s)
	//	                             = ClientUploadTimeout − PublishTransferReserve (15 s)
	//	ServerReadTimeout (60 s)  == CompileTimeout (60 s)     ← 相等，**不是** "服务端 > 编译"
	//
	// 夹在"客户端出站预算"与"单次编译上限"之间的那一档是 `PublishTotalBudget`
	// （一次 publish/validate 在平台侧的总预算：编译 + 抽取 + 干跑**共用**一个 deadline，
	// 见 wasmapp/api/publish.go 的 publishBudgetCtx），不是 ReadTimeout；
	// ReadTimeout 与编译预算同为 60 s，两者是**上限**关系而非严格大小关系。
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

// publishWasmReservedAppIDs 把 app_id 保留字收口（X4-1）接到 WASM 路由树上。
//
// 为什么由本文件提供：清单**从真实路由表派生**（`publishRouteReservedAppIDs`），
// 而"会遮蔽 `:app_id` 的静态段"这件事只在 apps 的 `:app_id` 路由存在时才成立。
// 关闭 apps ⇒ 注册表里没有 `:app_id`，这里是编译期 no-op（不是"空转的判据"）。
func publishWasmReservedAppIDs(r *gin.Engine) { publishRouteReservedAppIDs(r.Routes()) }
