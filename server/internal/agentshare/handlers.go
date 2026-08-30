package agentshare

import (
	"database/sql"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 共享 Agent(预设)端点 handler 集合。
// Public 客户端面(Bearer 认证); Admin 服务端面(RBAC 权限由 router 申报)。
type Handlers struct {
	// 客户端面 /api/client/v2/agent-presets
	ListVisible       gin.HandlerFunc // GET ""
	Upload            gin.HandlerFunc // POST ""
	Download          gin.HandlerFunc // GET /:name/archive
	DownloadVersioned gin.HandlerFunc // GET /:name/:version/archive
	// 服务端面 /api/server/admin
	ListAll                gin.HandlerFunc // GET ""
	DownloadAdmin          gin.HandlerFunc // GET /:name/archive
	Preview                gin.HandlerFunc // GET /:name/preview
	Decide                 gin.HandlerFunc // 批准(POST /:name/approve)
	Reject                 gin.HandlerFunc // 拒绝(POST /:name/reject)
	Remove                 gin.HandlerFunc // DELETE /:name
	DownloadAdminVersioned gin.HandlerFunc // GET /:name/:version/archive
	PreviewVersioned       gin.HandlerFunc // GET /:name/:version/preview
	DecideVersioned        gin.HandlerFunc // 批准(POST /:name/:version/approve)
	RejectVersioned        gin.HandlerFunc // 拒绝(POST /:name/:version/reject)
	RemoveVersioned        gin.HandlerFunc // DELETE /:name/:version
	SetPresetQuality       gin.HandlerFunc // PUT /:name/:version/quality
	PresetFileContent      gin.HandlerFunc // GET /:name/:version/file
	ListPresetGrants       gin.HandlerFunc // GET /:name/grants
	ReplacePresetGrants    gin.HandlerFunc // PUT /:name/grants
	SetPresetGrant         gin.HandlerFunc // PUT /:name/grant
	RemovePresetGrant      gin.HandlerFunc // DELETE /:name/grant
}

// NewHandlers 返回共享 Agent handler 集合(db + cacheDir 注入)。
func NewHandlers(db *sql.DB, cacheDir string) *Handlers {
	return &Handlers{
		ListVisible:            listVisible(db),
		Upload:                 upload(db, cacheDir),
		Download:               download(db, cacheDir, false),
		DownloadVersioned:      downloadVersioned(db, cacheDir, false),
		ListAll:                listAll(db),
		DownloadAdmin:          download(db, cacheDir, true),
		Preview:                preview(db, cacheDir),
		Decide:                 decide(db, serverstore.AgentPresetApproved, "agent_preset_approve"),
		Reject:                 decide(db, serverstore.AgentPresetRejected, "agent_preset_reject"),
		Remove:                 remove(db, cacheDir),
		DownloadAdminVersioned: downloadVersioned(db, cacheDir, true),
		PreviewVersioned:       preview(db, cacheDir),
		DecideVersioned:        decideVersioned(db, serverstore.AgentPresetApproved, "agent_preset_approve"),
		RejectVersioned:        decideVersioned(db, serverstore.AgentPresetRejected, "agent_preset_reject"),
		RemoveVersioned:        removeVersioned(db, cacheDir),
		SetPresetQuality:       setPresetQuality(db),
		PresetFileContent:      presetFileContent(db, cacheDir),
		ListPresetGrants:       listPresetGrants(db),
		ReplacePresetGrants:    replacePresetGrants(db),
		SetPresetGrant:         setPresetGrant(db, true),
		RemovePresetGrant:      setPresetGrant(db, false),
	}
}
