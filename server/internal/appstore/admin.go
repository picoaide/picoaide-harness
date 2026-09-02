package appstore

import (
	"database/sql"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// ---------------------------------------------------------------------------
// Handler 供给面(工程化重构 2026-09): 路由声明集中在 internal/router 包,
// 本包只通过公开 Handlers 结构暴露 gin.HandlerFunc 引用(实现保持私有)。
// ---------------------------------------------------------------------------

// Handlers 统一应用模型管理面 handler 集合。
// 服务端面 /api/server/admin(权限由 router 申报)。
type Handlers struct {
	// 归属转移(2026-09-02):PUT /apps/:kind/:app_id/owner
	TransferOwner gin.HandlerFunc
}

// NewHandlers 返回管理面 handler 集合(db 注入)。
func NewHandlers(db *sql.DB) *Handlers {
	return &Handlers{TransferOwner: transferOwner(db)}
}

// TransferOwnerAuditDetail 归属转移审计明细(稳定格式,webadmin 直接可读)。
func TransferOwnerAuditDetail(kind, appID, title, from, to string) string {
	detail := kind + ":" + appID
	if title != "" {
		detail += " 「" + title + "」"
	}
	return detail + " 归属 " + from + " → " + to
}

// transferOwner 归属转移:管理员把某个 App 的归属人改为其他存在用户。
// 归属只约束「谁能续传新版本」;转移后旧归属者的发布请求即 404,新归属者
// 获得续传权(版本语义规则不受影响)。审计 app_owner_transfer 留痕新旧值。
// 不支持清空归属(防误操作置为无主)。
func transferOwner(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		kind := c.Param("kind")
		appID := c.Param("app_id")
		if kind != serverstore.AppKindSkill && kind != serverstore.AppKindAgent {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"类型不合法:只能是 skill 或 agent")
			return
		}
		if !skillmanifest.IsAppID(appID) {
			serverauth.WriteError(c, http.StatusBadRequest, skillmanifest.CodeInvalidAppID,
				"名称不合法:必须是小写 kebab-case(如 my-skill)")
			return
		}
		var req struct {
			Owner string `json:"owner"`
		}
		if err := c.ShouldBindJSON(&req); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
			return
		}
		if req.Owner == "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "归属人不能为空")
			return
		}
		app, err := serverstore.GetApp(db, kind, appID)
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "能力不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		if _, err := serverstore.GetUserByUsername(db, req.Owner); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "目标用户不存在")
			return
		}
		if app.Owner == req.Owner {
			// 幂等:归属未变更,直接成功且不写审计(避免噪音条目)。
			c.JSON(http.StatusOK, gin.H{"ok": true, "owner": req.Owner})
			return
		}
		if err := serverstore.SetAppOwner(db, kind, appID, req.Owner); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
		admin := serverauth.AdminUser(c)
		actor := ""
		if admin != nil {
			actor = admin.Username
		}
		_ = serverstore.AuditLog(db, actor, "app_owner_transfer",
			TransferOwnerAuditDetail(kind, appID, app.Title, app.Owner, req.Owner))
		c.JSON(http.StatusOK, gin.H{"ok": true, "owner": req.Owner})
	}
}
