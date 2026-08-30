package telemetry

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 遥测端点 handler 集合(客户端面 Bearer 认证由 router 包挂载)。
type Handlers struct {
	// 客户端面 /api/client/v2/telemetry
	ReportSkillCall gin.HandlerFunc // POST /skill-call
}

// NewHandlers 返回遥测 handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{
		ReportSkillCall: reportSkillCall(db),
	}
}
