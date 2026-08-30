// Package bootstrap aggregates the startup configuration for clients
// (GET /api/config/bootstrap): models + default model + skill suggestions.
package bootstrap

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// WebConfig mirrors the bootstrap `web` section.
type WebConfig struct {
	// 错误上报 DSN(feat/error-monitoring 2026-08):客户端 Sentry SDK 的
	// 上报地址(如 GlitchTip),空 = 客户端不启用错误上报。
	ErrorReportingDSN string `json:"error_reporting_dsn"`
	// 错误上报开关(2026-08 升级):服务端控制客户端是否自动启用上报。
	ErrorReportingEnabled bool `json:"error_reporting_enabled"`
	// 上报等级阈值(2026-08): error|warning|info|debug;>= 阈值才上报。
	ErrorReportingLevel string `json:"error_reporting_level"`
	// GlitchTip 连接器配置(统一分发 2026-08):服务端下发地址/组织,
	// 客户端连接器预填,用户只需填 token。空 = 不预填。
	GlitchTipBaseURL      string `json:"glitchtip_base_url"`
	GlitchTipOrganization string `json:"glitchtip_organization"`
	// 默认思考强度(2026-08):客户端默认模型的 reasoningEffort,
	// off|low|high|max(与客户端 llm-deepseek 适配器支持档位一致);默认 max。
	DefaultThinkingLevel string `json:"default_thinking_level"`
}

// validThinkingLevels 是合法的思考强度值(与客户端 llm-deepseek
// 适配器 REASONING_EFFORTS 对齐:off|low|high|max)。
var validThinkingLevels = map[string]bool{
	"off": true, "low": true, "high": true, "max": true,
}

// Response is the bootstrap payload. Field names are FIXED: the desktop
// client BootstrapConfig must align exactly.
type Response struct {
	DefaultModel string             `json:"default_model"`
	Models       []llmgateway.Model `json:"models"`
	Skills       []SkillItem        `json:"skills"`
	Web          WebConfig          `json:"web"`
	// Connectors 连接器目录(0042):客户端连接器中心的唯一定义源。
	// 每项 = 客户端 ConnectorDef 对齐的 JSON(definition 字段内嵌),
	// 服务端管理员经 webadmin 管理;客户端凭证仍只存本地,不随下发。
	Connectors []ConnectorItem `json:"connectors"`
}

// ConnectorItem 是下发到客户端的连接器定义(与客户端 ConnectorDef 对齐)。
// Definition 是 JSON 字符串(认证配置 + tokenFields + mcp 数组),客户端
// 解析后 use(原样注入)。字段名与客户端 BootstrapConfig 一致。
type ConnectorItem struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	AuthMode    string `json:"auth_mode"`
	// 完整定义 JSON:客户端 parse 后覆盖内置(无内置,仅此下发)。
	Definition string `json:"definition"`
}

// RegisterRoutes mounts GET /api/config/bootstrap behind BearerAuth,
// plus an unauthenticated /healthz for docker healthchecks (only on the
// no-prefix call — healthz is a fixed endpoint and must never be mirrored).
func RegisterRoutes(r *gin.Engine, db *sql.DB) {
	// 无需认证的存活探针:docker HEALTHCHECK 用(docker 官方语义:退出码 0=healthy)。
	// 查询 DB(3s 超时),DB 不可用返回 503。
	r.GET("/healthz", func(c *gin.Context) {
		ctx, cancel := context.WithTimeout(c.Request.Context(), 3*time.Second)
		defer cancel()
		if err := db.PingContext(ctx); err != nil {
			// 健康探针保持 {ok:false} 语义(docker HEALTHCHECK 只认状态码),
			// 但 error 字段与错误信封同构(审计2026-F1.2)
			c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "error": gin.H{"code": "INTERNAL", "message": "db unavailable"}})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	r.GET("/api/client/v2/config/bootstrap", serverauth.BearerAuth(db), buildBootstrapHandler(db))
}

// buildBootstrapHandler 返回 bootstrap 端点 handler;闭包在每次调用时新建,
// 但行为一致——/api 与 /v2/api 两条路由各自持有等价闭包(相同 db 引用)。
func buildBootstrapHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
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
	}
}

// Build assembles the bootstrap payload for a specific user: models are
// global, skill suggestions are filtered by the caller's grants
// (admins see everything; everyone else only granted resources — 部门隔离).
func Build(db *sql.DB, user *serverstore.User) (*Response, error) {
	models, err := llmgateway.ListModels(db)
	if err != nil {
		return nil, err
	}
	// 有效组(部门树继承:祖先链 + 主管子树)
	groups, err := serverstore.UserEffectiveGroups(db, user.ID)
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
	// 错误上报 DSN(feat/error-monitoring):空 = 客户端不启用
	web.ErrorReportingDSN = settings["web.error_reporting_dsn"]
	// 上报开关/等级(2026-08):enabled 默认 false(安全);level 默认 error
	web.ErrorReportingEnabled = settings["web.error_reporting_enabled"] == "true"
	if lv := settings["web.error_reporting_level"]; lv != "" {
		web.ErrorReportingLevel = lv
	} else {
		web.ErrorReportingLevel = "error"
	}
	// 统一分发(2026-08):GlitchTip 连接器地址/组织由服务端下发
	web.GlitchTipBaseURL = settings["web.glitchtip_base_url"]
	web.GlitchTipOrganization = settings["web.glitchtip_organization"]
	// 默认思考强度(2026-08):缺省 max;非法值回落 max(客户端按值过滤)。
	web.DefaultThinkingLevel = "max"
	if lv := settings["web.default_thinking_level"]; lv != "" && validThinkingLevels[lv] {
		web.DefaultThinkingLevel = lv
	}

	// 连接器目录(0042):只下发 enabled 连接器;GlitchTip 的 BASE_URL/ORGANIZATION
	// 默认值由 web.glitchtip_base_url / web.glitchtip_organization 合成注入
	// 定义 JSON 的 tokenFields defaultValue(取代客户端特判注入)。
	connectors, err := serverstore.ListEnabledConnectors(db)
	if err != nil {
		return nil, err
	}
	connectorItems := make([]ConnectorItem, 0, len(connectors))
	for _, c := range connectors {
		item := ConnectorItem{ID: c.ID, Name: c.Name, Description: c.Description, AuthMode: c.AuthMode, Definition: c.Definition}
		if c.ID == "glitchtip" {
			item.Definition = injectGlitchTipDefaults(c.Definition, web.GlitchTipBaseURL, web.GlitchTipOrganization)
		}
		connectorItems = append(connectorItems, item)
	}

	return &Response{
		DefaultModel: defaultModel,
		Models:       models,
		Skills:       skillItems,
		Web:          web,
		Connectors:   connectorItems,
	}, nil
}

// injectGlitchTipDefaults 把服务端配置的 GlitchTip 地址/组织合成进连接器
// 定义 JSON 的 tokenFields defaultValue(客户端连接表单自动预填)。
// 定义 JSON 非法时原样返回(种子数据恒合法,此处防御)。
func injectGlitchTipDefaults(defJSON, baseURL, org string) string {
	if baseURL == "" && org == "" {
		return defJSON
	}
	var def map[string]any
	if err := json.Unmarshal([]byte(defJSON), &def); err != nil {
		return defJSON
	}
	fields, _ := def["tokenFields"].([]any)
	for _, f := range fields {
		m, _ := f.(map[string]any)
		if m == nil {
			continue
		}
		switch m["key"] {
		case "GLITCHTIP_BASE_URL":
			if baseURL != "" {
				m["defaultValue"] = baseURL
			}
		case "GLITCHTIP_ORGANIZATION":
			if org != "" {
				m["defaultValue"] = org
			}
		}
	}
	out, err := json.Marshal(def)
	if err != nil {
		return defJSON
	}
	return string(out)
}

// SkillItem is the bootstrap skill suggestion shape.
type SkillItem struct {
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description"`
}
