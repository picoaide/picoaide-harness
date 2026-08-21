package llmgateway

import (
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
)

// RegisterRoutes mounts /v1/chat/completions and /v1/models behind
// bearer-token auth.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	a := &API{
		DB: db,
		// 非流式:仅约束响应头到达(ResponseHeaderTimeout),body 单独限时读取——
		// 全量 Timeout 会截断长报告生成(审计2026-M11)
		client: &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 120 * time.Second}},
		// streaming client: headers (first byte) must arrive within the same
		// window as the non-stream client, but the body streams unbounded.
		sse: &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 120 * time.Second}},
		rl:  newRateLimiter(),
	}
	v1 := r.Group("/v1", serverauth.BearerAuth(db))
	v1.POST("/chat/completions", a.handleChatCompletions)
	v1.POST("/embeddings", a.handleEmbeddings)
	v1.GET("/models", a.handleModels)
}
