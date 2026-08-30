package capabilities

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 能力中心端点 handler 集合。
// Public 客户端面(Bearer 认证); Admin 服务端面(RBAC 权限由 router 申报)。
type Handlers struct {
	// 客户端面 /api/client/v2/capabilities
	ListCapabilities gin.HandlerFunc // GET ""
	// 服务端面 /api/server/admin
	ListApprovals gin.HandlerFunc // GET /approvals
}

// NewHandlers 返回能力中心 handler 集合(db + cacheDir 注入)。
func NewHandlers(db *sql.DB, cacheDir string) *Handlers {
	return &Handlers{
		ListCapabilities: listCapabilities(db, cacheDir),
		ListApprovals:    listApprovals(db, cacheDir),
	}
}
