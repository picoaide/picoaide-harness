package sharedskills

import (
	"database/sql"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 共享技能端点 handler 集合。
// Public 客户端面(Bearer 认证); Admin 服务端面(RBAC 权限由 router 申报)。
type Handlers struct {
	// 客户端面 /api/client/v2/shared-skills
	ListVisible gin.HandlerFunc // GET ""
	Upload      gin.HandlerFunc // POST ""
	Download    gin.HandlerFunc // GET /:name/:version/archive
	// 服务端面 /api/server/admin
	ListAll       gin.HandlerFunc // GET ""
	DownloadAdmin gin.HandlerFunc // GET /:name/:version/archive
	Preview       gin.HandlerFunc // GET /:name/:version/preview
	Decide        gin.HandlerFunc // 批准(POST /:name/:version/approve)
	Reject        gin.HandlerFunc // 拒绝(POST /:name/:version/reject)
	Remove        gin.HandlerFunc // DELETE /:name/:version
	SetQuality    gin.HandlerFunc // PUT /:name/:version/quality
	FileContent   gin.HandlerFunc // GET /:name/:version/file
	ListGrants    gin.HandlerFunc // GET /:name/grants
	ReplaceGrants gin.HandlerFunc // PUT /:name/grants
	SetGrant      gin.HandlerFunc // PUT /:name/grant
	RemoveGrant   gin.HandlerFunc // DELETE /:name/grant
	// 能力锁定(D4):/api/server/admin/capability-locks
	ListLocks  gin.HandlerFunc // GET  ""
	SetLock    gin.HandlerFunc // PUT  /:kind/:name
	RemoveLock gin.HandlerFunc // DELETE /:kind/:name
}

// NewHandlers 返回共享技能 handler 集合(db + cacheDir 注入)。
func NewHandlers(db *sql.DB, cacheDir string) *Handlers {
	return &Handlers{
		ListVisible:   listVisible(db),
		Upload:        upload(db, cacheDir),
		Download:      download(db, cacheDir, false),
		ListAll:       listAll(db),
		DownloadAdmin: download(db, cacheDir, true),
		Preview:       preview(db, cacheDir),
		Decide:        decide(db, serverstore.SharedSkillApproved, "shared_skill_approve"),
		Reject:        decide(db, serverstore.SharedSkillRejected, "shared_skill_reject"),
		Remove:        remove(db, cacheDir),
		SetQuality:    setQuality(db),
		FileContent:   fileContent(db, cacheDir),
		ListGrants:    listGrants(db),
		ReplaceGrants: replaceGrants(db),
		SetGrant:      setGrant(db, true),
		RemoveGrant:   setGrant(db, false),
		ListLocks:     listLocks(db),
		SetLock:       setLock(db),
		RemoveLock:    removeLock(db),
	}
}
