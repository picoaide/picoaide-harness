// Package bootstrap aggregates the startup configuration for clients
// (GET /api/config/bootstrap): models + default model + skill/mcp suggestions.
package bootstrap

import (
	"context"
	"database/sql"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/marketplace"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// WebConfig mirrors the bootstrap `web` section.
type WebConfig struct {
	AllowPrivate   bool   `json:"allow_private"`
	SearchEndpoint string `json:"search_endpoint"`
}

// Response is the bootstrap payload. Field names are FIXED: the desktop
// client BootstrapConfig must align exactly.
type Response struct {
	DefaultModel string                `json:"default_model"`
	Models       []llmgateway.Model    `json:"models"`
	Skills       []SkillItem           `json:"skills"`
	MCP          []marketplace.MCPItem `json:"mcp"`
	Web          WebConfig             `json:"web"`
}

// RegisterRoutes mounts GET /api/config/bootstrap behind BearerAuth,
// plus an unauthenticated /healthz for docker healthchecks.
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	// 无需认证的存活探针:docker HEALTHCHECK 用(docker 官方语义:退出码 0=healthy)。
	// 查询 DB(3s 超时),DB 不可用返回 503。
	r.GET("/healthz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": "db unavailable"})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	r.GET("/api/config/bootstrap", serverauth.BearerAuth(db), func(c *gin.Context) {
		u := serverauth.CurrentUser(c)
		if u == nil {
			serverauth.WriteError(c, http.StatusUnauthorized, "AUTH_REQUIRED", "未认证")
			return
		}
		resp, err := Build(db, u)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "启动配置生成失败")
			return
		}
		c.JSON(http.StatusOK, resp)
	})
}

// Build assembles the bootstrap payload for a specific user: models are
// global, skill/mcp suggestions are filtered by the caller's grants
// (admins see everything; everyone else only granted resources — 部门隔离).
func Build(db *sql.DB, user *serverstore.User) (*Response, error) {
	models, err := llmgateway.ListModels(db)
	if err != nil {
		return nil, err
	}
	groups, err := serverstore.UserGroups(db, user.ID)
	if err != nil {
		return nil, err
	}
	skills, err := serverstore.ListSkills(db, true)
	if err != nil {
		return nil, err
	}
	var allowedSkills map[string]bool
	if !user.IsAdmin {
		names, err := serverstore.AccessibleSkillNames(db, user.Username, groups)
		if err != nil {
			return nil, err
		}
		allowedSkills = make(map[string]bool, len(names))
		for _, n := range names {
			allowedSkills[n] = true
		}
	}
	skillItems := make([]SkillItem, 0, len(skills))
	for _, sk := range skills {
		if !user.IsAdmin && !allowedSkills[sk.Name] {
			continue
		}
		skillItems = append(skillItems, SkillItem{Name: sk.Name, Version: sk.Version, Description: sk.Description})
	}
	mcp, err := marketplace.SuggestedMCPForUser(db, user.Username, groups, user.IsAdmin)
	if err != nil {
		return nil, err
	}
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, err
	}
	defaultModel := settings["gateway.default_model"]
	if !llmgateway.ModelEnabled(models, defaultModel) {
		log.Printf("bootstrap: default_model %q not in enabled models, falling back", defaultModel)
		if len(models) > 0 {
			defaultModel = models[0].ID
		} else {
			defaultModel = ""
		}
	}
	web := WebConfig{}
	if v, ok := settings["web.allow_private"]; ok {
		web.AllowPrivate, _ = strconv.ParseBool(v)
	}
	web.SearchEndpoint = settings["web.search_endpoint"]

	return &Response{
		DefaultModel: defaultModel,
		Models:       models,
		Skills:       skillItems,
		MCP:          mcp,
		Web:          web,
	}, nil
}

// SkillItem is the bootstrap skill suggestion shape.
type SkillItem struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}
