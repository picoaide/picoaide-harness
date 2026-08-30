package connectors

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 连接器端点 handler 集合(服务端管理面 RBAC 权限由 router 申报)。
type Handlers struct {
	// 服务端面 /api/server/admin/connectors
	List       gin.HandlerFunc // GET ""
	Get        gin.HandlerFunc // GET /:id
	Create     gin.HandlerFunc // POST ""
	Update     gin.HandlerFunc // PUT /:id
	Remove     gin.HandlerFunc // DELETE /:id
	SetEnabled gin.HandlerFunc // PUT /:id/enabled
}

// NewHandlers 返回连接器 handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{
		List:       list(db),
		Get:        get(db),
		Create:     create(db),
		Update:     update(db),
		Remove:     remove(db),
		SetEnabled: setEnabled(db),
	}
}
