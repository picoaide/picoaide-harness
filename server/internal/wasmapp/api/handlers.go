// Package api 是 WASM 应用平台**操作面**的 HTTP 层（设计基线 §8 全表）。
//
// 分层与纪律：
//   - 只暴露 gin.HandlerFunc（路由集中声明在 internal/router，本包不注册路由）；
//   - 错误响应用 §8 的 AI-first 信封 `{"error":{code,message,details,hints}}` ——
//     `serverauth.WriteError` 只能表达 code+message，装不下 details/hints，而
//     §4.2/§8 明写"第一消费者是 AI"，缺了 hints 就等于让作者自己猜；
//   - 本包**不做**数据访问实现（serverstore）、**不做**编译实现（compile）、
//     **不做**规则判定（registry/appcfg/limits），只做「编排 + 身份 + 审计 + 错误映射」。
//
// 依赖方向（capapi.go 的包注释）：api 在最上层，可以 import runtime/compile/assets，
// 但没有任何下层包 import 本包。
package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/registry"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// ---------------------------------------------------------------------------
// 装配面（Handler 供给面，路由由 internal/router 声明）
// ---------------------------------------------------------------------------

// Options 是 Handlers 的依赖。**全部依赖由调用方注入**，本包不读环境变量、
// 不建数据库连接、不构造编译器（装配责任在 cmd/server / router）。
type Options struct {
	DB       *sql.DB
	DataRoot string
	Compiler *compile.Compiler
	// Events 是调用事件 sink（§4.9）。
	//
	// 本包**不往它写**：调用事件是"应用请求"的观测面（每请求一行，带 cpu/内存/
	// 队列等待），而发布/预检不是应用请求 —— 混进去会让 per-app 的 Total/OK/Error
	// 与 CPU 水位失去含义。发布链路的失败是**同步**回给调用方的（§6.2），
	// 不需要第二个观测面。字段保留是因为它是平台装配的一部分（/readyz 与后续
	// "发布事件独立表"会用到），不是遗漏。
	Events *events.Sink
	Now    func() time.Time
	// Ready 是**发布面**的水位闸门（§4.9：「低于阈值红灯并拒绝发布」）。
	//
	// 为什么必须由装配层注入（审计 P1-1）：`readyz.AllowPublish` 的判定一直是对的
	// （磁盘/缓存/编译队列/编译可用性），但它曾经**零调用方** —— 于是"低水位拒绝发布"
	// 只写在注释里，磁盘低于 1 GiB 时发布照样进入编译与落库。
	//
	// nil = 不校验（保留既有测试与最小装配；生产装配在 cmd/server 注入）。
	Ready *readyz.Checker
	// Audit 是**组织级**动作的审计出口（如审核开关）。应用级动作（发布/上下架/
	// 冻结/导出/删除）一律直写 audit_logs 并带 app_id 列（0069，§4.9 的 app 维度）——
	// 本签名的 (username, action, detail) 装不下 app_id，所以不做二选一。
	Audit func(username, action, detail string)

	// ArtifactUsed 是制品占用统计（§5.3 每用户 1 GiB）的注入点，缺省
	// serverstore.CountUserArtifactBytes。
	//
	// 存在的意义只有一个：让"超配额"这条闸门能被**确定性地**测到 —— 否则要测它
	// 就得先往测试库里灌 1 GiB 的制品字节。生产装配不要设置它。
	ArtifactUsed func(ctx context.Context, username string) (int64, error)

	// BaseDomain 返回**当前**应用基域（`<app_id>.<BaseDomain>`）。与
	// internal/wasmapp/session 的同名字段**同源同语义**（同一份配置：session 用它拼
	// 换票回跳，本包用它拼目录/发布响应里的入口链接）。空 = 未启用应用子域 ⇒
	// 入口链接回落为按请求 Host 推导。
	//
	// 函数而不是字符串：管理端可在运行期改基域（2026-09-18 用户要求）。
	BaseDomain func() string

	// BaseDomainSource 返回当前基域的**来源**（"setting" / "env" / "none"），
	// 只给控制台展示用（让管理员一眼看出"这个值是控制台配的还是部署时写死的"）。
	BaseDomainSource func() string

	// ApplyBaseDomain 由 cmd/server 注入：校验 + 落库 + 同步运行期值，一步完成。
	//
	// 为什么放在注入侧而不是本包：启用子域要跑的两条 fail-closed 自检
	// （R35 可信代理必须显式配置、§4.3 内存四笔账）都住在 cmd/server 的装配代码里，
	// 本包只负责"发请求 → 拿结果 → 写审计"。返回非 nil 表示**没有生效**
	// （校验失败/自检不过），错误原样进 §8 信封回给控制台 —— 用 *apperr.Error
	// 而不是裸 error：控制台要拿到 code/details/hints 才能提示"还差什么条件"。
	ApplyBaseDomain func(baseDomain string) *apperr.Error
	// CompileCacheRoot 覆盖**编译缓存根目录**（缺省 = DataRoot：缓存落在
	// `<DataRoot>/_compile-cache`）。
	//
	// 为什么允许分开：生产里"应用数据目录"与"编译缓存目录"是两种信任边界
	// （缓存条目会被 mmap 成机器码执行，属主与权限也不同，见 §4.3.1-d），
	// 分开挂载是合法部署形态；测试里则用它让多个用例共享同一份缓存
	// （否则每个用例都要为 3.6 MiB 的夹具付一次冷编译）。
	//
	// 干跑（及未来的执行侧）必须与发布期编译**共用同一份缓存**才有意义，
	// 所以这里只覆盖根目录、不改任何配置（§4.3.1-a）。
	CompileCacheRoot string

	// AppIDExtraReserved 是**部署期注入的企业已知主机名**（§4.1：基域是平台资产，
	// 不能被应用占走）。直接转交 registry.ValidateAppID 的 extraReserved 参数。
	AppIDExtraReserved []string

	// Limits / LimitsSource / LimitsApply / LimitsRestart / MemoryAvailable
	// 是**平台限制项**（并发与内存）的读写闭包（2026-09-19：控制台可配置）。
	//
	// 为什么用闭包而不是让本包直接读库：解析优先级（设置 > 部署档位 > 编译期默认）、
	// 四笔账自检与"下发到运行中组件"这三件事都住在装配侧（cmd/server 的
	// wasmLimitsHolder + appserver.ApplyLimits）；本包只做"组装视图 + 转发"。
	// 任何一个为 nil ⇒ 对应能力不可用（GET/PUT 会如实报错，不静默给假值）。
	Limits          func() applimits.Limits
	LimitsSource    func() string
	LimitsProfile   func() string
	LimitsApply     func(raw string) ([]string, *apperr.Error)
	LimitsRestart   func() []string
	MemoryAvailable func() int64

	// OnAppEvict 是"立即释放该应用的进程内驻留"的钩子（可选）。
	//
	// 触发点 = 下架 / 冻结 / 删除：这几件事之后该应用大概率长时间不会被访问，
	// 与其等 appserver 的空闲 TTL 扫描，不如事件驱动立刻丢掉编译模块与库句柄
	// （2026-09-18 用户要求"更快释放"）。生产装配注入 appserver.Server.EvictApp；
	// 不注入 ⇒ 什么都不做（内存由 TTL 兜底），因此本包不依赖 appserver。
	OnAppEvict func(appID string)
}

// Handlers 是操作面 handler 集合（§8 全表）。
type Handlers struct {
	opt Options

	// ---- 客户端面 /api/client/v2/apps/wasm ----
	Validate     gin.HandlerFunc // POST /apps/wasm/validate
	Publish      gin.HandlerFunc // POST /apps/wasm/:app_id/releases
	SetPublished gin.HandlerFunc // POST /apps/wasm/:app_id/publish | /unpublish
	Freeze       gin.HandlerFunc // POST /apps/wasm/:app_id/freeze
	Export       gin.HandlerFunc // GET  /apps/wasm/:app_id/export
	Delete       gin.HandlerFunc // DELETE /apps/wasm/:app_id
	Diagnostics  gin.HandlerFunc // GET  /apps/wasm/:app_id/diagnostics
	Schema       gin.HandlerFunc // GET  /apps/wasm/:app_id/schema
	Catalog      gin.HandlerFunc // GET  /apps/wasm/catalog

	// ---- 客户端面 /api/client/v2/apps/wasm/uploads（§4.2 分片上传）----
	//
	// 五条端点共用一句话：**分片只解决"一次请求撞 60 s ReadTimeout"，不改变任何
	// 总量上限**。实现分别落在 upload.go（HTTP 面）与 internal/wasmapp/upload
	// （会话存储与组装）；发布仍然只有一条实现（publishFromBytes）。
	UploadCreate   gin.HandlerFunc // POST   /apps/wasm/uploads
	UploadChunk    gin.HandlerFunc // PUT    /apps/wasm/uploads/:upload_id/chunks/:index
	UploadStatus   gin.HandlerFunc // GET    /apps/wasm/uploads/:upload_id
	UploadComplete gin.HandlerFunc // POST   /apps/wasm/uploads/:upload_id/complete
	UploadAbort    gin.HandlerFunc // DELETE /apps/wasm/uploads/:upload_id

	// up 是分片上传会话存储的惰性单例（类型与装配在 upload.go）：
	// 会话级互斥与幂等重放缓存都必须活在**同一个** Store 实例里。
	up uploadState

	// ---- 管理面 /api/server/admin/wasm-apps ----
	// 平台限制项（并发/内存）：GET 读当前值 + 四笔账预览，PUT 保存并下发。
	AdminLimitsGet     gin.HandlerFunc // GET /wasm-apps/limits
	AdminLimitsPut     gin.HandlerFunc // PUT /wasm-apps/limits
	AdminList          gin.HandlerFunc // GET    ""
	AdminUnpublish     gin.HandlerFunc // POST   /:app_id/unpublish
	AdminPublish       gin.HandlerFunc // POST   /:app_id/publish（与下架对称，管理员处置完能恢复）
	AdminTransferOwner gin.HandlerFunc // PUT    /:app_id/owner
	AdminFreeze        gin.HandlerFunc // POST   /:app_id/freeze
	AdminReview        gin.HandlerFunc // PUT    /review  (R17 审核开关)
	// 审核队列（P0-1）：待审清单 + 通过/拒绝。R17 的开关一旦打开，新版本就停在
	// pending —— 没有这三条，开关就等于"全组织再也发不出新版本"。
	AdminReleases       gin.HandlerFunc // GET  /:app_id/releases?status=pending|approved|rejected|all
	AdminApproveRelease gin.HandlerFunc // POST /:app_id/releases/:version/approve
	AdminRejectRelease  gin.HandlerFunc // POST /:app_id/releases/:version/reject（可选 body {"reason":"..."}）
	AdminBaseDomainGet  gin.HandlerFunc // GET    /domain   (应用泛域名配置，2026-09-18)
	AdminBaseDomainPut  gin.HandlerFunc // PUT    /domain
	// 管理面诊断与运行时水位（2026-09-19，P1-9/P2-4）：
	//   diagnostics —— 同一份 diag 数据，出口从"发布者令牌"扩到管理会话；
	//   runtime     —— 平台级只读水位（编译/执行/事件/磁盘 + 尚未接线的缺口清单）。
	AdminDiagnostics gin.HandlerFunc // GET /:app_id/diagnostics（capability:read）
	AdminRuntime     gin.HandlerFunc // GET /runtime（capability:read）
}

// SettingReviewRequired 是发布审核开关的 settings 键（R17）。
//
// 默认**关**（默认不审 + 事后抽检）：取不到该键 = false。开启时新版本进
// `app_releases.status='pending'`，**线上仍旧版本**（不中断使用）。
const SettingReviewRequired = "wasm.review_required"

// NewHandlers 构造 handler 集合。opt 的零值字段按"未配置即 fail-closed"处理
// （见 requireReady），不在这里 panic —— 装配错误应该在第一次请求时以结构化
// 错误暴露，而不是让整个进程起不来（router 只拿得到 *Handlers，没有 error 通道）。
func NewHandlers(opt Options) *Handlers {
	h := &Handlers{opt: opt}
	h.Validate = h.validate
	h.Publish = h.publish
	h.SetPublished = h.setPublished
	h.Freeze = h.freeze
	h.Export = h.export
	h.Delete = h.deleteApp
	h.Diagnostics = h.diagnostics
	h.Schema = h.schema
	h.Catalog = h.catalog
	h.UploadCreate = h.uploadCreate
	h.UploadChunk = h.uploadChunk
	h.UploadStatus = h.uploadStatus
	h.UploadComplete = h.uploadComplete
	h.UploadAbort = h.uploadAbort
	h.AdminList = h.adminList
	h.AdminUnpublish = h.adminUnpublish
	h.AdminPublish = h.adminPublish
	h.AdminTransferOwner = h.adminTransferOwner
	h.AdminFreeze = h.adminFreeze
	h.AdminReview = h.adminReview
	h.AdminReleases = h.adminReleases
	h.AdminApproveRelease = h.adminApproveRelease
	h.AdminRejectRelease = h.adminRejectRelease
	h.AdminBaseDomainGet = h.adminBaseDomainGet
	h.AdminBaseDomainPut = h.adminBaseDomainPut
	h.AdminLimitsGet = h.adminLimitsGet
	h.AdminLimitsPut = h.adminLimitsPut
	h.AdminDiagnostics = h.adminDiagnostics
	h.AdminRuntime = h.adminRuntime
	return h
}

// ---------------------------------------------------------------------------
// 基础设施：错误信封 / 身份 / 审计 / 请求体
// ---------------------------------------------------------------------------

// writeErr 按 §8 的 AI-first 信封回错误。
//
// 与平台通用信封的关系：`{"error":{"code","message"}}` 是本函数输出的**子集**
// （details/hints 为空时省略），所以既有客户端解析逻辑不受影响。
func writeErr(c *gin.Context, e *apperr.Error) {
	if e == nil {
		e = apperr.New(apperr.CodeInternal, "内部错误")
	}
	status := e.Status()
	if status == http.StatusTooManyRequests && c.Writer.Header().Get("Retry-After") == "" {
		setRetryAfter(c, limits.RetryAfterSeconds)
	}
	c.JSON(status, apperr.EnvelopeOf(e))
}

// writeErrWithRetry 回 429 并带 Retry-After（§4.6：队列满/限流必须给重试间隔）。
func writeErrWithRetry(c *gin.Context, e *apperr.Error, after time.Duration) {
	setRetryAfter(c, int(after.Seconds()))
	writeErr(c, e)
}

// setRetryAfter 写 Retry-After（秒，最小 1 —— 回 "0" 会让客户端立刻重试）。
func setRetryAfter(c *gin.Context, seconds int) {
	if seconds < 1 {
		seconds = 1
	}
	c.Header("Retry-After", strconv.Itoa(seconds))
}

// internalErr 是"不该发生的错误"的统一出口：只记日志/原因，不外泄内部细节。
func internalErr(msg string, cause error) *apperr.Error {
	return apperr.New(apperr.CodeInternal, msg).WithCause(cause)
}

// currentUser 取登录身份并做客户端面的账号可用性判定。
//
// 判据与 serverauth/handler.go:301、session/store.go:101 **完全一致**（不得分叉：
// 同一账号在两个入口得到相反结论就是漏洞）：审计账号不可持有员工面凭证。
func (h *Handlers) currentUser(c *gin.Context) (*serverstore.User, *apperr.Error) {
	u := serverauth.CurrentUser(c)
	if u == nil {
		return nil, apperr.New(apperr.CodeAuthRequired, "未认证").
			WithHint("AI 只是编辑器：所有发布/管理动作都必须由**发起操作的员工**持自己的令牌调用（§8 身份语义）")
	}
	if u.Role == serverstore.RoleAuditor {
		return nil, apperr.New(apperr.CodeForbidden, "审计账号不可使用应用平台").
			WithHint("审计员只可经管理后台只读工作台（与客户端面登录同一判据）")
	}
	return u, nil
}

// serverauthCurrentUser 是 serverauth.CurrentUser 的薄封装。
//
// 单独包一层是为了让本包**只有一个**读取上下文身份的入口：身份语义（§8）不允许
// 出现"某个 handler 用了别的取值方式"这种分叉。
func serverauthCurrentUser(c *gin.Context) *serverstore.User { return serverauth.CurrentUser(c) }

// cacheRoot 返回编译缓存根（缺省 = 数据根）。
func (h *Handlers) cacheRoot() string {
	if strings.TrimSpace(h.opt.CompileCacheRoot) != "" {
		return h.opt.CompileCacheRoot
	}
	return h.opt.DataRoot
}

// artifactUsed 统计某发布者的制品占用（缺省走 DAO，测试可注入）。
func (h *Handlers) artifactUsed(ctx context.Context, username string) (int64, error) {
	if h.opt.ArtifactUsed != nil {
		return h.opt.ArtifactUsed(ctx, username)
	}
	return serverstore.CountUserArtifactBytes(ctx, h.opt.DB, username)
}

// requireReady 检查装配完整性（fail-closed：缺依赖就报 INTERNAL，绝不静默跳过检查）。
func (h *Handlers) requireReady() *apperr.Error {
	switch {
	case h.opt.DB == nil:
		return apperr.New(apperr.CodeInternal, "平台数据库未配置")
	case strings.TrimSpace(h.opt.DataRoot) == "":
		return apperr.New(apperr.CodeInternal, "平台数据根未配置")
	case h.opt.Compiler == nil:
		return apperr.New(apperr.CodeInternal, "编译子系统未配置").
			WithHint("发布链路必须同步编译（§6.2）：没有编译器时不允许「只看静态校验」就发布")
	}
	return nil
}

// publishGate 是**发布面**的 fail-closed 水位闸门（§4.9：低于阈值拒绝发布）。
//
// 位置纪律：在 requireReady 之后、任何实际工作之前 —— 不读请求体（上传体 base64
// 可达 44 MiB）、不占上传额度、不落盘、不写审计（与"限流/占位被拒不写审计"同口径：
// 否则一个循环重试的客户端就能刷爆审计表）。平台可用性与身份无关，因此它排在
// 身份判定之前：低水位平台不该先花力气去解析一次上传。
//
// validate 也走这条闸门（见 validate 的注释：预检同样真的编译）。
func (h *Handlers) publishGate() *apperr.Error {
	if h.opt.Ready == nil {
		return nil
	}
	return h.opt.Ready.AllowPublish()
}

// now 返回注入的时钟（测试用）。
func (h *Handlers) now() time.Time {
	if h.opt.Now != nil {
		return h.opt.Now()
	}
	return time.Now()
}

// auditApp 写一条**应用级**审计（带 app_id 列，0069 / §4.9）。
//
// 失败只吞掉（审计不能反过来让业务失败 —— 与既有 AuditLog 调用点同口径：
// audit 写入是"必须留痕"，但不是"业务的前置条件"）。
func (h *Handlers) auditApp(appID, username, action, detail string) {
	if h.opt.DB == nil {
		return
	}
	_ = serverstore.AuditLogApp(h.opt.DB, appID, username, action, detail)
}

// auditOrg 写一条**组织级**审计（无 app 维度，如审核开关）。
func (h *Handlers) auditOrg(username, action, detail string) {
	if h.opt.Audit != nil {
		h.opt.Audit(username, action, detail)
		return
	}
	if h.opt.DB != nil {
		_ = serverstore.AuditLog(h.opt.DB, username, action, detail)
	}
}

// evictApp 通知装配层立即释放该应用的进程内驻留（编译模块 + 库句柄）。
//
// 只在下架 / 冻结 / 删除**成功之后**调用：这三件事之后应用大概率长时间不被访问，
// 事件驱动的释放比等空闲 TTL 更符合"更快释放"。钩子未注入 ⇒ 静默跳过
// （内存由 appserver 的空闲回收兜底），因此本包对 appserver 零依赖。
func (h *Handlers) evictApp(appID string) {
	if h == nil || h.opt.OnAppEvict == nil || appID == "" {
		return
	}
	h.opt.OnAppEvict(appID)
}

// auditDetail 拼装稳定的审计明细（沿用 appstore.TransferOwnerAuditDetail 的形态：
// 「kind:app_id 「title」 变更」），webadmin 的审计页可直接读。
func auditDetail(appID, title, change string) string {
	d := "wasm_app:" + appID
	if title != "" {
		d += " 「" + title + "」"
	}
	if change != "" {
		d += " " + change
	}
	return d
}

// bindJSONLimited 读取并解析请求体，**自己**套 http.MaxBytesReader（§4.2/R21）。
//
// 两条顺序是硬要求（§4.2 原话：「白名单只是豁免 ⇒ handler 内必须自己再套；
// 先查 Content-Length 回 413」）：
//  1. Content-Length 超限直接 413 —— 这样即使 router 忘了把该路由放进
//     largeBodyRoutes，33 MiB / 40 MiB 两档上传仍能得到**有指向性**的错误，
//     而不是退化成"JSON 解析失败"的 400（§10.5 第 56/57 项）；
//  2. 再套 MaxBytesReader —— chunked（无 Content-Length）时唯一的上限。
//
// 不在这里 DisallowUnknownFields：请求体的新增字段必须向后兼容（老客户端 + 新服务端）。
func bindJSONLimited[T any](c *gin.Context, maxBytes int64, what string) (T, *apperr.Error) {
	var out T
	body := c.Request.Body
	if body == nil {
		return out, apperr.New(apperr.CodeValidation, "请求体为空").
			WithHint("Content-Type 必须是 application/json，且请求体是 JSON 对象")
	}
	if c.Request.ContentLength > maxBytes {
		return out, bodyTooLarge(c.Request.ContentLength, maxBytes, what)
	}
	dec := json.NewDecoder(http.MaxBytesReader(c.Writer, body, maxBytes))
	if err := dec.Decode(&out); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return out, bodyTooLarge(c.Request.ContentLength, maxBytes, what)
		}
		if errors.Is(err, io.EOF) {
			return out, apperr.New(apperr.CodeValidation, "请求体为空").
				WithHint("Content-Type 必须是 application/json，且请求体是 JSON 对象")
		}
		return out, apperr.New(apperr.CodeValidation, "请求体格式错误").
			WithCause(err).
			WithHint("请求体必须是单个 JSON 对象（不要分包、不要尾随内容）")
	}
	// 尾随内容一律拒：`{...}{...}` 这种形态通常是客户端把两次请求拼在一起，
	// 静默取第一个会让"我明明发了新版本"变成一个查不出来的悬案。
	var trailing json.RawMessage
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return out, apperr.New(apperr.CodeValidation, "请求体在 JSON 对象之后还有多余内容").
			WithHint("一个请求只能有一个 JSON 对象")
	}
	return out, nil
}

// bodyTooLarge 构造 413 的**有指向性**错误（§4.2 / §10.5 第 56/57 项）。
//
// 必须同时说清三件事：收到了多少、上限是多少、该怎么办 —— 只说"太大"会让 AI
// 反复重试同样的体积。
func bodyTooLarge(got, max int64, what string) *apperr.Error {
	e := apperr.Newf(apperr.CodeBodyTooLarge, "请求体 %s 超过上限 %s", humanBytes(got), humanBytes(max)).
		WithDetail("content_length", got).
		WithDetail("max_body_bytes", max).
		WithDetail("wasm_max_bytes", limits.WasmMaxBytes).
		WithHint("上传体是 base64 JSON：体积约为 .wasm 的 4/3 再加少量元数据；" +
			"请求体上限 " + humanBytes(max) + " 对应约 " + humanBytes(max*3/4) + " 的 .wasm")
	if strings.TrimSpace(what) != "" {
		e.WithDetail("kind", what)
	}
	return e
}

// humanBytes 把字节数渲染成 MiB/KiB（错误文案用；数值来源仍是 limits 常量本身，
// 这里只做单位换算与展示，不新增任何上限）。
func humanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		return strconv.FormatFloat(float64(n)/(1<<20), 'f', 1, 64) + " MiB"
	case n >= 1<<10:
		return strconv.FormatFloat(float64(n)/(1<<10), 'f', 1, 64) + " KiB"
	default:
		return strconv.FormatInt(n, 10) + " B"
	}
}

// decodeWasmBase64 解码上传的 wasm（§4.2/R21）。
//
// 体积判定放在**解码后**（base64 解码器自己要按 4/3 分配，先按 Content-Length
// 粗筛没有任何收益），但解码前的字符串长度先做一次上界检查，避免为一个畸形请求
// 分配几倍内存：base64 长度 L 对应最多 L/4*3 字节。
func decodeWasmBase64(encoded string) ([]byte, *apperr.Error) {
	if strings.TrimSpace(encoded) == "" {
		return nil, apperr.New(apperr.CodeMissingField, "缺少 wasm_base64").
			WithDetail("field", "wasm_base64").
			WithHint("把编译产物（GOOS=wasip1 GOARCH=wasm）做 base64 标准编码后放进 wasm_base64")
	}
	if int64(len(encoded)) > int64(limits.UploadBodyMaxBytes) {
		return nil, bodyTooLarge(int64(len(encoded)), limits.UploadBodyMaxBytes, "wasm_base64")
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, apperr.New(apperr.CodeValidation, "wasm_base64 不是合法的 base64").
			WithCause(err).
			WithHint("用**标准**base64（含 padding 的 A-Za-z0-9+/）；URL-safe 变体（-_）不接受")
	}
	if int64(len(raw)) > limits.WasmMaxBytes {
		return nil, apperr.Newf(apperr.CodeWasmTooLarge,
			"模块体积 %s 超过上限 %s", humanBytes(int64(len(raw))), humanBytes(limits.WasmMaxBytes)).
			WithDetail("wasm_bytes", int64(len(raw))).
			WithDetail("max_wasm_bytes", limits.WasmMaxBytes).
			WithHint("平台上限就是 " + humanBytes(limits.WasmMaxBytes) + "（内嵌 HTML/JS 也走自定义段，" +
				"自定义段另有 " + humanBytes(limits.SectionTotalMaxBytes) + " 总量上限）").
			WithHint("请压缩资源：字体做子集化、图片换 webp、去掉调试符号（Go: -ldflags=\"-s -w\"）")
	}
	return raw, nil
}

// creationAppID 取"创建路径"（validate / publish）的 app_id 并做**严格**校验。
//
// 与只读路径的关键差别：**不静默小写**。§10.5 第 52/53 项明写"app_id 含大写 →
// 400 INVALID_APP_ID"——静默归一化会让 `My-App` 与 `my-app` 都能创建出同一个标识，
// 而作者以为自己建了两个应用（且域名大小写不敏感，两者最终指向同一行）。
//
// 路径参数与请求体都给时必须逐字一致（不一致说明调用方状态错乱，静默取其一会让
// "我发到了 A 却检查了 B"变成查不出来的悬案）。
func (h *Handlers) creationAppID(c *gin.Context, bodyAppID string) (string, *apperr.Error) {
	rawPath := strings.TrimSpace(c.Param("app_id"))
	rawBody := strings.TrimSpace(bodyAppID)
	if rawPath != "" && rawBody != "" && rawPath != rawBody {
		return "", apperr.New(apperr.CodeValidation, "路径中的 app_id 与请求体不一致").
			WithDetail("path_app_id", rawPath).
			WithDetail("body_app_id", rawBody).
			WithHint("两者必须一致（路径参数是权威，请求体里的 app_id 可以省略）")
	}
	raw := rawPath
	if raw == "" {
		raw = rawBody
	}
	if raw == "" {
		return "", apperr.New(apperr.CodeMissingField, "缺少 app_id").
			WithDetail("field", "app_id").
			WithHint("app_id 就是应用的域名标签（小写字母/数字/单个连字符，≤63）")
	}
	if raw != strings.ToLower(raw) {
		return "", apperr.New(apperr.CodeInvalidAppID, "app_id 必须全小写").
			WithDetail("app_id", raw).
			WithDetail("pattern", limits.AppIDPattern).
			WithHint("大小写敏感是有意的：app_id 是域名标签，平台不做静默小写（避免两个名字指向同一行）")
	}
	if err := h.validateAppID(raw); err != nil {
		return "", err
	}
	return raw, nil
}

// validateAppID 用 registry 规则校验 app_id（§4.1 / §10.5 第 52/53/53b 项）。
func (h *Handlers) validateAppID(appID string) *apperr.Error {
	return registry.ValidateAppID(appID, h.opt.AppIDExtraReserved)
}

// appOrigin 返回应用的入口链接（`scheme://<app_id>.<基域>`）。
//
// 基域未配置时按请求 Host 推导（本包只把它当展示字段：不参与任何鉴权判定）。
// 两个都拿不到就返回空串（调用方据此省略字段）。
func (h *Handlers) appOrigin(c *gin.Context, appID string) string {
	// 基域解析规则只允许一份：复用 session.ParseBaseDomain（同一份部署配置的
	// 两个消费者必须对"带不带 scheme / 大小写 / 尾点"给出相同结论）。
	raw := ""
	if h.opt.BaseDomain != nil {
		raw = h.opt.BaseDomain()
	}
	if scheme, host := session.ParseBaseDomain(raw); scheme != "" && host != "" && appID != "" {
		return scheme + "://" + appID + "." + host
	}
	host := strings.TrimSpace(c.Request.Host)
	if host == "" {
		return ""
	}
	scheme := "https"
	if c.Request.TLS == nil && !strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https") {
		// 明文直达（本地/内网部署）时不要伪造 https —— 链接点不开比"不安全"更糟。
		scheme = "http"
	}
	return scheme + "://" + appID + "." + host
}

// reviewRequired 读审核开关（R17，默认关）。
func (h *Handlers) reviewRequired() bool {
	if h.opt.DB == nil {
		return false
	}
	v, ok, err := serverstore.GetSetting(h.opt.DB, SettingReviewRequired)
	if err != nil || !ok {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "on", "yes":
		return true
	default:
		// 无法识别的值按**关**处理：与"默认关"同向，且写入端只写 true/false。
		return false
	}
}

// releaseVersion 归一化版本号（去空白）。
func releaseVersion(v string) string { return strings.TrimSpace(v) }

// budgetCtx 给一次内部操作套预算（编译/干跑各自的预算在调用点给）。
func budgetCtx(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(parent, d)
}
