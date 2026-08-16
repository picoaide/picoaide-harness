package llmgateway

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// RegisterAdminRoutes mounts /api/admin/providers, /api/admin/models and
// /api/admin/gateway behind AdminAuth.
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	g := r.Group("/api/admin", serverauth.AdminAuth(db))
	g.GET("/providers", func(c *gin.Context) { listProviders(c, db) })
	g.POST("/providers", func(c *gin.Context) { createProvider(c, db) })
	g.PUT("/providers/:id", func(c *gin.Context) { updateProvider(c, db) })
	g.DELETE("/providers/:id", func(c *gin.Context) { deleteProvider(c, db) })
	g.GET("/models", func(c *gin.Context) { listModelsAdmin(c, db) })
	g.POST("/models", func(c *gin.Context) { createModel(c, db) })
	g.PUT("/models/:id", func(c *gin.Context) { updateModel(c, db) })
	g.DELETE("/models/:id", func(c *gin.Context) { deleteModel(c, db) })
	g.GET("/gateway", func(c *gin.Context) { getGatewayConfig(c, db) })
	g.PUT("/gateway", func(c *gin.Context) { setGatewayConfig(c, db) })
	g.GET("/channels", func(c *gin.Context) { listChannelsAdmin(c) })
	g.POST("/providers/:id/sync", func(c *gin.Context) { syncOneAdmin(c, db) })
	g.POST("/providers/sync-all", func(c *gin.Context) { syncAllAdmin(c, db) })
}

// syncFetchFn is the fetchFn used by immediate post-save syncs; nil uses
// the channel's real HTTP fetch. Test-injectable (never hit real upstreams
// in unit tests).
var syncFetchFn func(url string) ([]byte, error)

// syncProviderNow runs one channel-model sync right after save so the
// catalog is usable immediately instead of waiting for the hourly loop.
// Failures are non-fatal: the provider stays saved and the caller retries
// via sync-all / the per-provider sync button.
func syncProviderNow(db *sql.DB, p *serverstore.GatewayProvider) *SyncResult {
	if p.Channel == "" {
		return nil
	}
	ch, ok := channels.Get(p.Channel)
	if !ok {
		return &SyncResult{Provider: p.Name, Error: "unknown channel"}
	}
	key, err := DecryptSecret(p.APIKeyEnc)
	if err != nil {
		return &SyncResult{Provider: p.Name, Error: err.Error()}
	}
	res := SyncProvider(db, ch, p, key, syncFetchFn)
	return &res
}

func listChannelsAdmin(c *gin.Context) {
	type entry struct {
		Name    string `json:"name"`
		BaseURL string `json:"base_url"`
	}
	names := channels.All()
	out := make([]entry, 0, len(names))
	for _, n := range names {
		if ch, ok := channels.Get(n); ok {
			out = append(out, entry{Name: n, BaseURL: ch.BaseURL()})
		}
	}
	c.JSON(http.StatusOK, gin.H{"channels": out})
}

func syncAllAdmin(c *gin.Context, db *sql.DB) {
	results, err := SyncOnce(db, nil)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "同步失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"results": results})
}

func syncOneAdmin(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	p, err := serverstore.GetGatewayProvider(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "上游不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	ch, ok := channels.Get(p.Channel)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "渠道不存在")
		return
	}
	key, err := DecryptSecret(p.APIKeyEnc)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "密钥解密失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"result": SyncProvider(db, ch, p, key, nil)})
}

// encryptSecret encrypts an upstream API key with the master key.
func encryptSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key, err := util.GetMasterKey()
	if err != nil {
		return "", err
	}
	return util.Encrypt(key, plaintext), nil
}

type providerReq struct {
	Name    string   `json:"name"`
	BaseURL string   `json:"base_url"`
	APIKey  string   `json:"api_key"`
	Models  []string `json:"models"`
	Channel string   `json:"channel"`
}

func providerJSON(p serverstore.GatewayProvider) gin.H {
	key := p.APIKeyEnc
	if key != "" {
		key = "***"
	}
	return gin.H{
		"id":       p.ID,
		"name":     p.Name,
		"base_url": p.BaseURL,
		"api_key":  key,
		"models":   p.Models,
		"enabled":  p.Enabled == 1,
		"channel":  p.Channel,
	}
}

func listProviders(c *gin.Context, db *sql.DB) {
	list, err := serverstore.ListGatewayProviders(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	out := make([]gin.H, 0, len(list))
	for _, p := range list {
		out = append(out, providerJSON(p))
	}
	c.JSON(http.StatusOK, gin.H{"providers": out})
}

func createProvider(c *gin.Context, db *sql.DB) {
	var req providerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if req.BaseURL == "" && req.Channel != "" {
		if ch, ok := channels.Get(req.Channel); ok {
			req.BaseURL = ch.BaseURL()
		}
	}
	if req.Name == "" || req.BaseURL == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称和 base_url 必填")
		return
	}
	enc, err := encryptSecret(req.APIKey)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "密钥加密失败")
		return
	}
	p := &serverstore.GatewayProvider{Name: req.Name, BaseURL: req.BaseURL, APIKeyEnc: enc, Models: req.Models, Channel: req.Channel, Enabled: 1}
	if _, err := serverstore.AddGatewayProvider(db, p); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "上游名称已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	// 同步 models 表:provider 的模型清单即客户端可见模型(单一数据源)。
	// channel provider 的模型由渠道同步维护,不走 provider.models 列表覆盖
	if p.Channel == "" {
		if err := serverstore.SyncProviderModels(db, p.ID, req.Models); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型同步失败")
			return
		}
	}
	// 渠道型:保存后立即同步一次,模型即刻上架(失败不阻塞,可重试)
	var syncRes *SyncResult
	if p.Channel != "" {
		syncRes = syncProviderNow(db, p)
	}
	c.JSON(http.StatusOK, gin.H{"provider": providerJSON(*p), "sync": syncRes})
}

func updateProvider(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	p, err := serverstore.GetGatewayProvider(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "上游不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req providerReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if req.Name != "" {
		p.Name = req.Name
	}
	if req.BaseURL == "" && p.BaseURL == "" && req.Channel != "" {
		if ch, ok := channels.Get(req.Channel); ok {
			p.BaseURL = ch.BaseURL()
		}
	}
	if req.BaseURL != "" {
		p.BaseURL = req.BaseURL
	}
	if req.Channel != "" {
		p.Channel = req.Channel
	}
	if req.APIKey != "" {
		enc, err := encryptSecret(req.APIKey)
		if err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "密钥加密失败")
			return
		}
		p.APIKeyEnc = enc
	}
	if req.Models != nil {
		p.Models = req.Models
	}
	if err := serverstore.UpdateGatewayProvider(db, p); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	// 模型清单变更同步到 models 表(单一数据源)。
	// channel provider 的模型由渠道同步维护,不走 provider.models 列表覆盖
	if p.Channel == "" {
		if err := serverstore.SyncProviderModels(db, p.ID, p.Models); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "模型同步失败")
			return
		}
	}
	// 渠道型:更新后也立即同步,模型列表保持新鲜
	var syncRes *SyncResult
	if p.Channel != "" {
		syncRes = syncProviderNow(db, p)
	}
	c.JSON(http.StatusOK, gin.H{"provider": providerJSON(*p), "sync": syncRes})
}

func deleteProvider(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if err := serverstore.DeleteGatewayProvider(db, id); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type modelReq struct {
	Name          string `json:"name"`
	ProviderID    int64  `json:"provider_id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
}

func listModelsAdmin(c *gin.Context, db *sql.DB) {
	models, err := ListModels(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"models": models})
}

func createModel(c *gin.Context, db *sql.DB) {
	var req modelReq
	if err := c.ShouldBindJSON(&req); err != nil || req.Name == "" || req.ProviderID <= 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "模型名和 provider 必填")
		return
	}
	m := &serverstore.Model{Name: req.Name, ProviderID: req.ProviderID, DisplayName: req.DisplayName, DefaultParams: req.DefaultParams}
	if _, err := serverstore.AddModel(db, m); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "模型名已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"model": m})
}

func updateModel(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	m, err := serverstore.GetModel(db, id)
	if errors.Is(err, serverstore.ErrNotFound) {
		serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "模型不存在")
		return
	}
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "查询失败")
		return
	}
	var req modelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if req.Name != "" {
		m.Name = req.Name
	}
	if req.ProviderID > 0 {
		m.ProviderID = req.ProviderID
	}
	if req.DisplayName != "" {
		m.DisplayName = req.DisplayName
	}
	if req.DefaultParams != "" {
		m.DefaultParams = req.DefaultParams
	}
	if err := serverstore.UpdateModel(db, m); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"model": m})
}

func deleteModel(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	if err := serverstore.DeleteModel(db, id); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// getGatewayConfig returns gateway + web settings.
func getGatewayConfig(c *gin.Context, db *sql.DB) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取失败")
		return
	}
	rateLimit := settings["gateway.rate_limit"]
	if rateLimit == "" {
		rateLimit = "60"
	}
	allowPrivate := settings["web.allow_private"] == "true"
	c.JSON(http.StatusOK, gin.H{
		"default_model":   settings["gateway.default_model"],
		"rate_limit":      rateLimit,
		"allow_private":   allowPrivate,
		"search_endpoint": settings["web.search_endpoint"],
		"server_base_url": settings["server.base_url"],
	})
}

// setGatewayConfig validates default_model against enabled models and saves.
func setGatewayConfig(c *gin.Context, db *sql.DB) {
	var req struct {
		DefaultModel   string `json:"default_model"`
		RateLimit      string `json:"rate_limit"`
		AllowPrivate   bool   `json:"allow_private"`
		SearchEndpoint string `json:"search_endpoint"`
		ServerBaseURL  string `json:"server_base_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if req.DefaultModel != "" && !modelEnabledByDB(db, req.DefaultModel) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "默认模型必须属于已启用的模型")
		return
	}
	if req.RateLimit != "" {
		if n, err := strconv.Atoi(req.RateLimit); err != nil || n <= 0 || n > 100000 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "rate_limit 必须是正整数")
			return
		}
	}
	if req.DefaultModel != "" {
		if err := serverstore.SetSetting(db, "gateway.default_model", req.DefaultModel); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.RateLimit != "" {
		if err := serverstore.SetSetting(db, "gateway.rate_limit", req.RateLimit); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if err := serverstore.SetSetting(db, "web.allow_private", strconv.FormatBool(req.AllowPrivate)); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	if err := serverstore.SetSetting(db, "web.search_endpoint", req.SearchEndpoint); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	if req.ServerBaseURL != "" {
		// 对外 HTTPS 地址(经 Caddy 反代后的访问入口),webadmin 配置展示用
		if err := serverstore.SetSetting(db, "server.base_url", req.ServerBaseURL); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func modelEnabledByDB(db *sql.DB, name string) bool {
	models, err := ListModels(db)
	if err != nil {
		return false
	}
	return ModelEnabled(models, name)
}
