// Package connectors implements the server-side connector catalog:
// admin CRUD (webadmin), plus the bootstrap assembly used by package
// bootstrap (enabled connectors with GlitchTip default injection).
package connectors

import (
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// maxDefinitionBytes bounds the connector definition JSON (seed defs are
// ~1KB; a generous ceiling keeps admin forms honest).
const maxDefinitionBytes = 64 << 10

// RegisterAdminRoutes mounts /api/admin/connectors (AdminAuth + RBAC v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	base := "/api/admin/connectors"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "", serverauth.PermConnectorRead, list(db))
	serverauth.AdminRoute(g, "GET", "/:id", serverauth.PermConnectorRead, get(db))
	serverauth.AdminRoute(g, "POST", "", serverauth.PermConnectorWrite, create(db))
	serverauth.AdminRoute(g, "PUT", "/:id", serverauth.PermConnectorWrite, update(db))
	serverauth.AdminRoute(g, "DELETE", "/:id", serverauth.PermConnectorWrite, remove(db))
	serverauth.AdminRoute(g, "PUT", "/:id/enabled", serverauth.PermConnectorWrite, setEnabled(db))
}

func rowJSON(c serverstore.Connector) gin.H {
	return gin.H{
		"id":          c.ID,
		"name":        c.Name,
		"description": c.Description,
		"auth_mode":   c.AuthMode,
		"definition":  c.Definition,
		"enabled":     c.Enabled,
		"updated_at":  c.UpdatedAt,
		"created_at":  c.CreatedAt,
	}
}

func list(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		rows, err := serverstore.ListConnectors(db)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		out := make([]gin.H, 0, len(rows))
		for _, r := range rows {
			out = append(out, rowJSON(r))
		}
		c.JSON(http.StatusOK, gin.H{"connectors": out})
	}
}

func get(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		conn, err := serverstore.GetConnector(db, c.Param("id"))
		if err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
			return
		}
		c.JSON(http.StatusOK, gin.H{"connector": rowJSON(*conn)})
	}
}

// bindConnector parses the create/update body with validation. Returns nil
// and writes the error response on invalid input.
func bindConnector(c *gin.Context) *serverstore.Connector {
	var req struct {
		ID          string `json:"id"`
		Name        string `json:"name"`
		Description string `json:"description"`
		AuthMode    string `json:"auth_mode"`
		Definition  string `json:"definition"`
		Enabled     *bool  `json:"enabled"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体格式错误")
		return nil
	}
	if len([]byte(req.Definition)) > maxDefinitionBytes {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "定义 JSON 过长")
		return nil
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	return &serverstore.Connector{
		ID:          strings.TrimSpace(req.ID),
		Name:        strings.TrimSpace(req.Name),
		Description: strings.TrimSpace(req.Description),
		AuthMode:    req.AuthMode,
		Definition:  req.Definition,
		Enabled:     enabled,
	}
}

func create(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		conn := bindConnector(c)
		if conn == nil {
			return
		}
		if err := serverstore.CreateConnector(db, conn); err != nil {
			if errors.Is(err, serverstore.ErrValidation) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "连接器参数不合法(id 小写字母数字/名称/认证模式/定义 JSON 须含 mcp+serverName)")
				return
			}
			if errors.Is(err, serverstore.ErrDuplicate) {
				serverauth.WriteError(c, http.StatusConflict, "CONFLICT", "连接器 id 已存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "connector_create", conn.ID)
		c.JSON(http.StatusCreated, gin.H{"connector": rowJSON(*conn)})
	}
}

func update(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		conn := bindConnector(c)
		if conn == nil {
			return
		}
		conn.ID = id // id 不可经 body 修改
		if err := serverstore.UpdateConnector(db, conn); err != nil {
			if errors.Is(err, serverstore.ErrValidation) {
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "连接器参数不合法")
				return
			}
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "connector_update", id)
		c.JSON(http.StatusOK, gin.H{"connector": rowJSON(*conn)})
	}
}

func setEnabled(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		var req struct {
			Enabled *bool `json:"enabled"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.Enabled == nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "缺少 enabled 字段")
			return
		}
		if err := serverstore.SetConnectorEnabled(db, c.Param("id"), *req.Enabled); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "connector_enabled", c.Param("id"))
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func remove(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.Param("id")
		if err := serverstore.DeleteConnector(db, id); err != nil {
			if errors.Is(err, serverstore.ErrNotFound) {
				serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "连接器不存在")
				return
			}
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
		_ = serverstore.AuditLog(db, adminUsername(c), "connector_delete", id)
		c.JSON(http.StatusOK, gin.H{"ok": true})
	}
}

func adminUsername(c *gin.Context) string {
	u := serverauth.AdminUser(c)
	if u == nil {
		return "admin"
	}
	return u.Username
}
