package marketplace

import (
	"database/sql"

	"github.com/gin-gonic/gin"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 技能商城端点 handler 集合。
// Public 客户端面(Bearer 认证); Admin 服务端面(RBAC 权限由 router 申报)。
type Handlers struct {
	// 客户端面 /api/client/v2/marketplace
	ListSkills      gin.HandlerFunc // GET /skills
	SkillUpdates    gin.HandlerFunc // GET /skills/updates
	GetSkill        gin.HandlerFunc // GET /skills/:name
	DownloadArchive gin.HandlerFunc // GET /skills/:name/archive
	// 服务端面 /api/server/admin
	ListSkillsAdmin         gin.HandlerFunc
	CreateSkillAdmin        gin.HandlerFunc
	UploadSkillArchiveAdmin gin.HandlerFunc
	UpdateSkillAdmin        gin.HandlerFunc
	DeleteSkillAdmin        gin.HandlerFunc
	EnableSkillAdmin        gin.HandlerFunc
	ListSkillGrants         gin.HandlerFunc
	ReplaceSkillGrants      gin.HandlerFunc
	SetSkillGrant           gin.HandlerFunc
	RemoveSkillGrant        gin.HandlerFunc
}

// NewHandlers 返回技能商城 handler 集合(db + cacheDir 注入)。
func NewHandlers(db *sql.DB, cacheDir string) *Handlers {
	api := NewAPI(db, cacheDir)
	return &Handlers{
		ListSkills:              api.listSkills,
		SkillUpdates:            api.skillUpdates,
		GetSkill:                api.getSkill,
		DownloadArchive:         api.downloadArchive,
		ListSkillsAdmin:         func(c *gin.Context) { listSkillsAdmin(c, db) },
		CreateSkillAdmin:        func(c *gin.Context) { createSkillAdmin(c, db) },
		UploadSkillArchiveAdmin: func(c *gin.Context) { uploadSkillArchiveAdmin(c, db, cacheDir) },
		UpdateSkillAdmin:        func(c *gin.Context) { updateSkillAdmin(c, db, cacheDir) },
		DeleteSkillAdmin:        func(c *gin.Context) { deleteSkillAdmin(c, db) },
		EnableSkillAdmin:        func(c *gin.Context) { enableSkillAdmin(c, db) },
		ListSkillGrants:         func(c *gin.Context) { listSkillGrants(c, db) },
		ReplaceSkillGrants:      func(c *gin.Context) { replaceSkillGrants(c, db) },
		SetSkillGrant:           func(c *gin.Context) { setSkillGrant(c, db, true) },
		RemoveSkillGrant:        func(c *gin.Context) { setSkillGrant(c, db, false) },
	}
}
