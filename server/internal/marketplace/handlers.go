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
	GetSkill        gin.HandlerFunc // GET /skills/:name
	DownloadArchive gin.HandlerFunc // GET /skills/:name/archive
	// 服务端面 /api/server/admin(G4 市场智能体, 与技能同构)
	ListAgentsAdmin         gin.HandlerFunc
	CreateAgentAdmin        gin.HandlerFunc
	UploadAgentArchiveAdmin gin.HandlerFunc
	PreviewAgentAdmin       gin.HandlerFunc
	FileContentAgentAdmin   gin.HandlerFunc
	UpdateAgentAdmin        gin.HandlerFunc
	DeleteAgentAdmin        gin.HandlerFunc
	EnableAgentAdmin        gin.HandlerFunc
	ListAgentGrants         gin.HandlerFunc
	ReplaceAgentGrants      gin.HandlerFunc
	SetAgentGrant           gin.HandlerFunc
	RemoveAgentGrant        gin.HandlerFunc
	ListSkillsAdmin         gin.HandlerFunc
	CreateSkillAdmin        gin.HandlerFunc
	UploadSkillArchiveAdmin gin.HandlerFunc
	PreviewSkillAdmin       gin.HandlerFunc
	FileContentSkillAdmin   gin.HandlerFunc
	NormalizeSkillAdmin     gin.HandlerFunc
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
		GetSkill:                api.getSkill,
		DownloadArchive:         api.downloadArchive,
		ListAgentsAdmin:         func(c *gin.Context) { listAgentsAdmin(c, db) },
		CreateAgentAdmin:        func(c *gin.Context) { createAgentAdmin(c, db) },
		UploadAgentArchiveAdmin: func(c *gin.Context) { uploadAgentArchiveAdmin(c, db) },
		PreviewAgentAdmin:       func(c *gin.Context) { previewAgentAdmin(c, db) },
		FileContentAgentAdmin:   func(c *gin.Context) { fileContentAgentAdmin(c, db) },
		UpdateAgentAdmin:        func(c *gin.Context) { updateAgentAdmin(c, db) },
		DeleteAgentAdmin:        func(c *gin.Context) { deleteAgentAdmin(c, db) },
		EnableAgentAdmin:        func(c *gin.Context) { enableAgentAdmin(c, db) },
		ListAgentGrants:         func(c *gin.Context) { listAgentGrants(c, db) },
		ReplaceAgentGrants:      func(c *gin.Context) { replaceAgentGrants(c, db) },
		SetAgentGrant:           func(c *gin.Context) { applyAgentGrant(c, db, true) },
		RemoveAgentGrant:        func(c *gin.Context) { applyAgentGrant(c, db, false) },
		ListSkillsAdmin:         func(c *gin.Context) { listSkillsAdmin(c, db) },
		CreateSkillAdmin:        func(c *gin.Context) { createSkillAdmin(c, db) },
		UploadSkillArchiveAdmin: func(c *gin.Context) { uploadSkillArchiveAdmin(c, db, cacheDir) },
		PreviewSkillAdmin:       func(c *gin.Context) { previewSkillAdmin(c, db, cacheDir) },
		FileContentSkillAdmin:   func(c *gin.Context) { fileContentSkillAdmin(c, db, cacheDir) },
		NormalizeSkillAdmin:     func(c *gin.Context) { normalizeSkillAdmin(c, db, cacheDir) },
		UpdateSkillAdmin:        func(c *gin.Context) { updateSkillAdmin(c, db, cacheDir) },
		DeleteSkillAdmin:        func(c *gin.Context) { deleteSkillAdmin(c, db) },
		EnableSkillAdmin:        func(c *gin.Context) { enableSkillAdmin(c, db) },
		ListSkillGrants:         func(c *gin.Context) { listSkillGrants(c, db) },
		ReplaceSkillGrants:      func(c *gin.Context) { replaceSkillGrants(c, db) },
		SetSkillGrant:           func(c *gin.Context) { setSkillGrant(c, db, true) },
		RemoveSkillGrant:        func(c *gin.Context) { setSkillGrant(c, db, false) },
	}
}
