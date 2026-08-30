package bootstrap

import (
	"context"
	"database/sql"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers bootstrap 端点 handler 集合。
type Handlers struct {
	// Bootstrap 客户端启动配置(带 Bearer 认证); 由 router 包挂 Authorization。
	Bootstrap gin.HandlerFunc
	// Health 存活探针(无认证, /healthz 固定端点在 server 面声明)。
	Health gin.HandlerFunc
}

// NewHandlers 返回 bootstrap handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{
		Bootstrap: buildBootstrapHandler(db),
		Health:    healthHandler(db),
	}
}

// healthHandler 无需认证的存活探针(docker HEALTHCHECK 用)。
// 查询 DB(3s 超时),DB 不可用返回 503。
func healthHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			// 健康探针保持 {ok:false} 语义(docker HEALTHCHECK 只认状态码),
			// 但 error 字段与错误信封同构(审计2026-F1.2)
			c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": gin.H{"code": "INTERNAL", "message": "db unavailable"}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}
