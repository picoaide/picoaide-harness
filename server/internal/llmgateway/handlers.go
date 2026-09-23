package llmgateway

import (
	"database/sql"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 网关端点 handler 集合。
// Client 客户端面(Bearer); Admin 服务端管理面(RBAC 权限由 router 申报)。
type Handlers struct {
	// DeepSeek 兼容网关(独立 /v1 命名空间,与官方完全一致)
	ChatCompletions gin.HandlerFunc // POST /chat/completions (+ /v1 别名)
	Embeddings      gin.HandlerFunc // POST /embeddings (+ /v1 别名)
	Messages        gin.HandlerFunc // POST /messages (Anthropic 兼容)
	Models          gin.HandlerFunc // GET /models (+ /v1 别名)
	Completions     gin.HandlerFunc // POST /completions (FIM Beta)
	Responses       gin.HandlerFunc // POST /responses (Responses API)
	// Files API(2026-09-22):客户端默认用它上传图片并复用 file_id,拿不到才回落
	// base64 内联。硬绑 DeepSeek 上游,见 files.go。
	UploadFile   gin.HandlerFunc // POST /files (multipart,流式)
	ListFiles    gin.HandlerFunc // GET /files
	RetrieveFile gin.HandlerFunc // GET /files/:file_id
	DeleteFile   gin.HandlerFunc // DELETE /files/:file_id
	// 服务端面 /api/server/admin
	ListProviders    gin.HandlerFunc
	CreateProvider   gin.HandlerFunc
	UpdateProvider   gin.HandlerFunc
	DeleteProvider   gin.HandlerFunc
	ProviderBalance  gin.HandlerFunc // GET /providers/:id/balance(2026-09 渠道余额)
	ListModelsAdmin  gin.HandlerFunc
	CreateModel      gin.HandlerFunc
	UpdateModel      gin.HandlerFunc
	DeleteModel      gin.HandlerFunc
	GetGatewayConfig gin.HandlerFunc
	SetGatewayConfig gin.HandlerFunc
	// 网关文件台账的管理面(2026-09-22):按员工看占用 / 搜索 / 排序 / 清理。
	// 读走 gateway:read,删除与清理走 gateway:write(见 router.go 的申报)。
	ListGatewayFiles    gin.HandlerFunc // GET /gateway/files
	GatewayFilesSummary gin.HandlerFunc // GET /gateway/files/summary
	DeleteGatewayFile   gin.HandlerFunc // DELETE /gateway/files/:file_id
	PurgeGatewayFiles   gin.HandlerFunc // POST /gateway/files/purge
	ListChannelsAdmin   gin.HandlerFunc
	SyncOneAdmin        gin.HandlerFunc
	SyncAllAdmin        gin.HandlerFunc
	// ConcurrencyStatus 返回各模型当前并发(内存快照)+ 90 天历史峰值(DB),
	// 供服务器信息页展示与扩容申请(2026-08-31)。
	ConcurrencyStatus gin.HandlerFunc
	// TestErrorReporting 由服务端代发一条测试事件到错误上报 DSN(2026-09-16
	// P0-4/D3),让管理员点一下就知道"客户端 → GlitchTip"这一跳通不通。
	TestErrorReporting gin.HandlerFunc
	// ErrorReportingClients 返回客户端上报状态聚合(P1-3/D7)。
	ErrorReportingClients gin.HandlerFunc
}

// NewHandlers 返回网关 handler 集合(db 注入)。
// 注意: API 的 client/sse/rl 必须与旧 RegisterRoutes 相同初始化——chat/
// embeddings/messages handler 依赖它们, 缺省时 nil 解引用 panic(2026-09
// API 集中声明重构引入的回归)。
func NewHandlers(db *sql.DB) *Handlers {
	// 注册 serverstore 模型/上游写路径的回调:管理端增删 provider/模型时
	// 立即清空本包的上游路由缓存(配合 30s TTL 双保险)。
	serverstore.RegisterModelsChangedHook(InvalidateUpstreams)
	api := &API{
		DB: db,
		// 出站 client 的**唯一构造点**（见 upstreamHTTPClient）——生产装配与包内
		// 测试镜像（routes.go 的 RegisterRoutes）必须走同一条，安全面才同源。
		client: upstreamHTTPClient(),
		// streaming client: headers (first byte) must arrive within the same
		// window as the non-stream client, but the body streams unbounded.
		sse:  upstreamHTTPClient(),
		rl:   newRateLimiter(),
		conc: newConcurrencyMeter(),
	}
	// 启动按模型并发采样(2026-08-31):每 15s 落库峰值。
	// db 为 nil(测试路由树)时内部跳过。
	api.startConcurrencySampler(nil)
	return &Handlers{
		ChatCompletions:     api.handleChatCompletions,
		Embeddings:          api.handleEmbeddings,
		Messages:            api.handleMessages,
		Models:              api.handleModels,
		Completions:         api.handleCompletions,
		Responses:           api.handleResponses,
		UploadFile:          api.handleFilesUpload,
		ListFiles:           api.handleFilesList,
		RetrieveFile:        api.handleFilesRetrieve,
		DeleteFile:          api.handleFilesDelete,
		ListProviders:       func(c *gin.Context) { listProviders(c, db) },
		CreateProvider:      func(c *gin.Context) { createProvider(c, db) },
		UpdateProvider:      func(c *gin.Context) { updateProvider(c, db) },
		DeleteProvider:      func(c *gin.Context) { deleteProvider(c, db) },
		ProviderBalance:     func(c *gin.Context) { providerBalance(c, db) },
		ListModelsAdmin:     func(c *gin.Context) { listModelsAdmin(c, db) },
		CreateModel:         func(c *gin.Context) { createModel(c, db) },
		UpdateModel:         func(c *gin.Context) { updateModel(c, db) },
		DeleteModel:         func(c *gin.Context) { deleteModel(c, db) },
		GetGatewayConfig:    func(c *gin.Context) { getGatewayConfig(c, db) },
		SetGatewayConfig:    func(c *gin.Context) { setGatewayConfig(c, db) },
		ListGatewayFiles:    func(c *gin.Context) { listGatewayFilesAdmin(c, db) },
		GatewayFilesSummary: func(c *gin.Context) { gatewayFilesSummaryAdmin(c, db) },
		DeleteGatewayFile:   func(c *gin.Context) { deleteGatewayFileAdmin(c, api, db) },
		PurgeGatewayFiles:   func(c *gin.Context) { purgeGatewayFilesAdmin(c, api, db) },
		ListChannelsAdmin:   func(c *gin.Context) { listChannelsAdmin(c) },
		SyncOneAdmin:        func(c *gin.Context) { syncOneAdmin(c, db) },
		SyncAllAdmin:        func(c *gin.Context) { syncAllAdmin(c, db) },
		ConcurrencyStatus: func(c *gin.Context) {
			concurrencyStatus(c, db, api.conc)
		},
		TestErrorReporting:    func(c *gin.Context) { testErrorReporting(c, db) },
		ErrorReportingClients: func(c *gin.Context) { errorReportingClients(c, db) },
	}
}

// upstreamHTTPClient 返回网关出站 HTTP client 的**唯一构造点**。
//
// R4-C-7(审计 2026-09-23,P3):生产装配(NewHandlers)与包内测试镜像
// (routes.go 的 RegisterRoutes)必须用同一个构造点 —— 镜像此前自建
// `&http.Transport{ResponseHeaderTimeout: …}`,**不带 netguard**,于是所有经由该镜像
// 跑的用例对"出站被拦住"(连接期 IP 复检 / 代理路径复检)的行为与生产**不等价**
// (安全面差异)。两条路径现在共用本函数,判据见 routes_transport_test.go。
func upstreamHTTPClient() *http.Client {
	return &http.Client{Transport: newUpstreamTransport()}
}

// newUpstreamTransport 返回网关上游 HTTP transport(F10,审计 2026-09-11)。
// 保存时域名解析失败会放行(离线/内网 DNS 抖动),因此连接阶段必须复检:
// 解析出的任一候选 IP 若属于链路本地/云 metadata 段直接拒绝(防 DNS
// rebinding 把 provider API key 发往 metadata 服务);私网/环回允许 ——
// 企业内网自建 LLM 网关是本产品的主要场景。
func newUpstreamTransport() *http.Transport {
	t := util.SafeOutboundTransport()
	t.ResponseHeaderTimeout = 120 * time.Second
	return t
}

// ---------------------------------------------------------------------------
// P2-11(审计 2026-09-13):网关请求的**单用户并发准入**
// ---------------------------------------------------------------------------
//
// 背景:网关此前只有"每模型 in-flight 计数"(供管理端展示),没有任何准入闸门。
// 一个员工用脚本并发打满上游连接/内存即可拖垮整个实例(仓库既有实测:
// 单实例 ~1500 并发流式即 healthz 无响应)。这里按**用户**限制在跑的网关请求
// 数:单个员工的失控客户端被 429 挡住,其他员工不受影响(全局/按模型硬限流会
// 在正常高峰误伤全员,产品形态上不可取)。
//
// 上限取 32:远高于任何正常桌面客户端的并发(客户端同一时刻通常 1-3 条流),
// 又足以把"单员工打满全站"变成不可能。PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER
// 可覆盖(压测/特殊集成场景)。

const defaultMaxInflightPerUser = 32

func maxInflightPerUser() int {
	if v := os.Getenv("PICOAI_GATEWAY_MAX_INFLIGHT_PER_USER"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return defaultMaxInflightPerUser
}

type userInflightLimiter struct {
	mu     sync.Mutex
	active map[int64]int
}

var gatewayInflight = &userInflightLimiter{active: map[int64]int{}}

// acquire 记一次在跑请求;超出上限返回 ok=false。
func (l *userInflightLimiter) acquire(userID int64, max int) (release func(), ok bool) {
	l.mu.Lock()
	if l.active[userID] >= max {
		l.mu.Unlock()
		return nil, false
	}
	l.active[userID]++
	l.mu.Unlock()
	return func() {
		l.mu.Lock()
		if l.active[userID] <= 1 {
			delete(l.active, userID) // 归零即删键:表不随用户数无限增长
		} else {
			l.active[userID]--
		}
		l.mu.Unlock()
	}, true
}

// InFlightGuard 是网关路由的并发准入中间件(必须挂在 BearerAuth **之后**,
// 以便拿到已认证用户)。超限返回 429 RATE_LIMITED。
func InFlightGuard() gin.HandlerFunc {
	return func(c *gin.Context) {
		u := serverauth.CurrentUser(c)
		if u == nil {
			// 未经认证的请求由 BearerAuth 处理;这里不做二次拒绝(不改变错误语义)。
			c.Next()
			return
		}
		release, ok := gatewayInflight.acquire(u.ID, maxInflightPerUser())
		if !ok {
			serverauth.WriteError(c, http.StatusTooManyRequests, "RATE_LIMITED", "并发请求过多,请稍后再试")
			return
		}
		defer release()
		c.Next()
	}
}
