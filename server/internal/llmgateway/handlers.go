package llmgateway

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 网关端点 handler 集合。
// Client 客户端面(Bearer); Admin 服务端管理面(RBAC 权限由 router 申报)。
type Handlers struct {
	// 客户端面 /api/client/v2/v1
	ChatCompletions gin.HandlerFunc // POST /chat/completions
	Embeddings      gin.HandlerFunc // POST /embeddings
	Messages        gin.HandlerFunc // POST /messages
	Models          gin.HandlerFunc // GET /models
	// 服务端面 /api/server/admin
	ListProviders    gin.HandlerFunc
	CreateProvider   gin.HandlerFunc
	UpdateProvider   gin.HandlerFunc
	DeleteProvider   gin.HandlerFunc
	ListModelsAdmin  gin.HandlerFunc
	CreateModel      gin.HandlerFunc
	UpdateModel      gin.HandlerFunc
	DeleteModel      gin.HandlerFunc
	GetGatewayConfig gin.HandlerFunc
	SetGatewayConfig gin.HandlerFunc
	ListChannelsAdmin gin.HandlerFunc
	SyncOneAdmin     gin.HandlerFunc
	SyncAllAdmin     gin.HandlerFunc
}

// NewHandlers 返回网关 handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	api := &API{DB: db}
	return &Handlers{
		ChatCompletions:  api.handleChatCompletions,
		Embeddings:       api.handleEmbeddings,
		Messages:         api.handleMessages,
		Models:           api.handleModels,
		ListProviders:    func(c *gin.Context) { listProviders(c, db) },
		CreateProvider:   func(c *gin.Context) { createProvider(c, db) },
		UpdateProvider:   func(c *gin.Context) { updateProvider(c, db) },
		DeleteProvider:   func(c *gin.Context) { deleteProvider(c, db) },
		ListModelsAdmin:  func(c *gin.Context) { listModelsAdmin(c, db) },
		CreateModel:      func(c *gin.Context) { createModel(c, db) },
		UpdateModel:      func(c *gin.Context) { updateModel(c, db) },
		DeleteModel:      func(c *gin.Context) { deleteModel(c, db) },
		GetGatewayConfig: func(c *gin.Context) { getGatewayConfig(c, db) },
		SetGatewayConfig: func(c *gin.Context) { setGatewayConfig(c, db) },
		ListChannelsAdmin: func(c *gin.Context) { listChannelsAdmin(c) },
		SyncOneAdmin:     func(c *gin.Context) { syncOneAdmin(c, db) },
		SyncAllAdmin:     func(c *gin.Context) { syncAllAdmin(c, db) },
	}
}
