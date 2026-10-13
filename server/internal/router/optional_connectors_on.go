//go:build connectors

package router

// 本文件是 `connectors` 模块**打开**时的类型与路由接线（P1 第二片，2026-10-14）。

import (
	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/connectors"
	"github.com/picoaide/picoaide/internal/serverauth"
)

// ConnectorsAPI 是连接器管理面的 handler 集合（`connectors` 打开时就是
// `connectors.Handlers` 本身：别名，调用点零改写）。
type ConnectorsAPI = connectors.Handlers

// registerConnectorAdminRoutes 注册 `/api/server/admin/connectors*`。
//
// 提前 return（而不是把 nil 交给 gin）：字段为 nil 时整片不注册 —— gin 的
// `addRoute` 只断言 `len(handlers) > 0`，nil handler 会照常注册并在请求期 panic→500。
func registerConnectorAdminRoutes(authed *gin.RouterGroup, d Deps) {
	if d.Connector == nil {
		return
	}
	// 连接器管理
	serverauth.AdminRoute(authed, "GET", "/connectors", serverauth.PermConnectorRead, d.Connector.List)
	serverauth.AdminRoute(authed, "GET", "/connectors/:id", serverauth.PermConnectorRead, d.Connector.Get)
	serverauth.AdminRoute(authed, "POST", "/connectors", serverauth.PermConnectorWrite, d.Connector.Create)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Update)
	serverauth.AdminRoute(authed, "DELETE", "/connectors/:id", serverauth.PermConnectorWrite, d.Connector.Remove)
	serverauth.AdminRoute(authed, "PUT", "/connectors/:id/enabled", serverauth.PermConnectorWrite, d.Connector.SetEnabled)
}
