package llmgateway

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
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
	// 服务端面 /api/server/admin
	ListProviders     gin.HandlerFunc
	CreateProvider    gin.HandlerFunc
	UpdateProvider    gin.HandlerFunc
	DeleteProvider    gin.HandlerFunc
	ListModelsAdmin   gin.HandlerFunc
	CreateModel       gin.HandlerFunc
	UpdateModel       gin.HandlerFunc
	DeleteModel       gin.HandlerFunc
	GetGatewayConfig  gin.HandlerFunc
	SetGatewayConfig  gin.HandlerFunc
	ListChannelsAdmin gin.HandlerFunc
	SyncOneAdmin      gin.HandlerFunc
	SyncAllAdmin      gin.HandlerFunc
}

// NewHandlers 返回网关 handler 集合(db 注入)。
// 注意: API 的 client/sse/rl 必须与旧 RegisterRoutes 相同初始化——chat/
// embeddings/messages handler 依赖它们, 缺省时 nil 解引用 panic(2026-09
// API 集中声明重构引入的回归)。
func NewHandlers(db *sql.DB) *Handlers {
	api := &API{
		DB: db,
		// 非流式:仅约束响应头到达(ResponseHeaderTimeout),body 单独限时读取——
		// 全量 Timeout 会截断长报告生成(审计2026-M11)
		client: &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 120 * time.Second}},
		// streaming client: headers (first byte) must arrive within the same
		// window as the non-stream client, but the body streams unbounded.
		sse: &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 120 * time.Second}},
		rl:  newRateLimiter(),
	}
	return &Handlers{
		ChatCompletions:   api.handleChatCompletions,
		Embeddings:        api.handleEmbeddings,
		Messages:          api.handleMessages,
		Models:            api.handleModels,
		Completions:       api.handleCompletions,
		Responses:         api.handleResponses,
		ListProviders:     func(c *gin.Context) { listProviders(c, db) },
		CreateProvider:    func(c *gin.Context) { createProvider(c, db) },
		UpdateProvider:    func(c *gin.Context) { updateProvider(c, db) },
		DeleteProvider:    func(c *gin.Context) { deleteProvider(c, db) },
		ListModelsAdmin:   func(c *gin.Context) { listModelsAdmin(c, db) },
		CreateModel:       func(c *gin.Context) { createModel(c, db) },
		UpdateModel:       func(c *gin.Context) { updateModel(c, db) },
		DeleteModel:       func(c *gin.Context) { deleteModel(c, db) },
		GetGatewayConfig:  func(c *gin.Context) { getGatewayConfig(c, db) },
		SetGatewayConfig:  func(c *gin.Context) { setGatewayConfig(c, db) },
		ListChannelsAdmin: func(c *gin.Context) { listChannelsAdmin(c) },
		SyncOneAdmin:      func(c *gin.Context) { syncOneAdmin(c, db) },
		SyncAllAdmin:      func(c *gin.Context) { syncAllAdmin(c, db) },
	}
}
