package brand

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 品牌/门户端点 handler 集合。
// Public 客户端面公开端点; Admin 服务端管理面端点(权限由 router 包申报)。
type Handlers struct {
	// 客户端面(/api/client/v2)
	PublicBrand  gin.HandlerFunc
	Logo         gin.HandlerFunc // GET/HEAD /brand/logo/:name
	PublicPortal gin.HandlerFunc
	// 服务端面(/api/server/admin)
	AdminBrand      gin.HandlerFunc // GET
	PutAdminBrand   gin.HandlerFunc // PUT
	UploadLogo      gin.HandlerFunc // POST /brand/logo
	DeleteLogo      gin.HandlerFunc // DELETE /brand/logo
	ListSnapshots   gin.HandlerFunc // GET /brand/snapshots
	RestoreSnapshot gin.HandlerFunc // POST /brand/restore
	AdminPortal     gin.HandlerFunc // GET /portal
	PutAdminPortal  gin.HandlerFunc // PUT /portal
}

// NewHandlers 返回品牌/门户 handler 集合(db + dataDir 注入)。
func NewHandlers(db *sql.DB, dataDir string) *Handlers {
	return &Handlers{
		PublicBrand:     func(c *gin.Context) { getPublicBrand(c, db) },
		Logo:            func(c *gin.Context) { serveLogo(c, db, dataDir) },
		PublicPortal:    func(c *gin.Context) { getPublicPortal(c, db) },
		AdminBrand:      func(c *gin.Context) { getAdminBrand(c, db) },
		PutAdminBrand:   func(c *gin.Context) { putAdminBrand(c, db, dataDir) },
		UploadLogo:      func(c *gin.Context) { uploadLogo(c, db, dataDir) },
		DeleteLogo:      func(c *gin.Context) { deleteLogo(c, db, dataDir) },
		ListSnapshots:   func(c *gin.Context) { listSnapshots(c, db) },
		RestoreSnapshot: func(c *gin.Context) { restoreSnapshot(c, db, dataDir) },
		AdminPortal:     func(c *gin.Context) { getAdminPortal(c, db) },
		PutAdminPortal:  func(c *gin.Context) { putAdminPortal(c, db, dataDir) },
	}
}
