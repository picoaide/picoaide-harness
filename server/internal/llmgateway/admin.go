package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// RegisterAdminRoutes mounts /api/admin/providers, /api/admin/models and
// /api/admin/gateway behind AdminAuth + RBAC permission checks (v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	base := "/api/admin"
	g := r.Group(base, serverauth.AdminAuth(db))
	serverauth.AdminRoute(g, "GET", "/providers", serverauth.PermGatewayRead, func(c *gin.Context) { listProviders(c, db) })
	serverauth.AdminRoute(g, "POST", "/providers", serverauth.PermGatewayWrite, func(c *gin.Context) { createProvider(c, db) })
	serverauth.AdminRoute(g, "PUT", "/providers/:id", serverauth.PermGatewayWrite, func(c *gin.Context) { updateProvider(c, db) })
	serverauth.AdminRoute(g, "DELETE", "/providers/:id", serverauth.PermGatewayWrite, func(c *gin.Context) { deleteProvider(c, db) })
	serverauth.AdminRoute(g, "GET", "/models", serverauth.PermGatewayRead, func(c *gin.Context) { listModelsAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/models", serverauth.PermGatewayWrite, func(c *gin.Context) { createModel(c, db) })
	serverauth.AdminRoute(g, "PUT", "/models/:id", serverauth.PermGatewayWrite, func(c *gin.Context) { updateModel(c, db) })
	serverauth.AdminRoute(g, "DELETE", "/models/:id", serverauth.PermGatewayWrite, func(c *gin.Context) { deleteModel(c, db) })
	serverauth.AdminRoute(g, "GET", "/gateway", serverauth.PermGatewayRead, func(c *gin.Context) { getGatewayConfig(c, db) })
	serverauth.AdminRoute(g, "PUT", "/gateway", serverauth.PermGatewayWrite, func(c *gin.Context) { setGatewayConfig(c, db) })
	serverauth.AdminRoute(g, "GET", "/channels", serverauth.PermGatewayRead, func(c *gin.Context) { listChannelsAdmin(c) })
	serverauth.AdminRoute(g, "POST", "/providers/:id/sync", serverauth.PermGatewayWrite, func(c *gin.Context) { syncOneAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/providers/sync-all", serverauth.PermGatewayWrite, func(c *gin.Context) { syncAllAdmin(c, db) })
}

// syncFetchFn is the fetchFn used by immediate post-save syncs; nil uses
// the channel's real HTTP fetch. Test-injectable (never hit real upstreams
// in unit tests).
var syncFetchFn func(url string) ([]byte, error)

// syncProviderNow runs one channel-model sync right after save so the
// catalog is usable immediately instead of waiting for the hourly loop.
// Failures are non-fatal: the provider stays saved and the caller retries
// via sync-all / the per-provider sync button.
// 生产路径 15s 请求内超时(审计2026-M5):慢/黑洞上游不得把 admin 请求挂到 120s。
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
	fetch := syncFetchFn
	if fetch == nil {
		fetch = httpFetch15s(key)
	}
	res := SyncProvider(db, ch, p, key, fetch)
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
	fetch := syncFetchFn
	if fetch == nil {
		fetch = httpFetch15s(key)
	}
	c.JSON(http.StatusOK, gin.H{"result": SyncProvider(db, ch, p, key, fetch)})
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
	// Channel 指针语义(审计修复 M3 附带):nil/缺省 = 不修改;"" = 清空为
	// 手动型;非空 = 指定渠道。此前空串被跳过,渠道型上游无法切回手动型。
	Channel *string `json:"channel"`
	// 显式禁用开关:enabled=false 的 provider 不再参与模型路由(审计2026-M14)
	Enabled *bool `json:"enabled"`
	// Protocol(0043):openai(默认)或 anthropic(/v1/messages 兼容端点)。
	// nil/缺省/空串 = openai;非法值拒绝。
	Protocol *string `json:"protocol"`
}

func providerJSON(p serverstore.GatewayProvider) gin.H {
	key := p.APIKeyEnc
	if key != "" {
		key = "***"
	}
	protocol := p.Protocol
	if protocol == "" {
		protocol = "openai"
	}
	return gin.H{
		"id":       p.ID,
		"name":     p.Name,
		"base_url": p.BaseURL,
		"api_key":  key,
		"models":   p.Models,
		"enabled":  p.Enabled == 1,
		"channel":  p.Channel,
		"protocol": protocol,
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
	channel := ""
	if req.Channel != nil {
		channel = *req.Channel
	}
	protocol := "openai"
	if req.Protocol != nil && *req.Protocol != "" {
		protocol = *req.Protocol
	}
	if protocol != "openai" && protocol != "anthropic" && protocol != "both" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "protocol 仅支持 openai/anthropic/both")
		return
	}
	if req.BaseURL == "" && channel != "" {
		if ch, ok := channels.Get(channel); ok {
			req.BaseURL = ch.BaseURL()
		}
	}
	if req.Name == "" || req.BaseURL == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "名称和 base_url 必填")
		return
	}
	// 渠道型上游的 key 是同步的刚需:无 key 创建必然同步失败(审计修复 L4)
	if channel != "" && req.APIKey == "" {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "渠道型上游必须填写 API Key")
		return
	}
	enc, err := encryptSecret(req.APIKey)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "密钥加密失败")
		return
	}
	// 渠道型上游的模型由同步维护,不落手动模型清单(审计修复 M3 附带)
	p := &serverstore.GatewayProvider{Name: req.Name, BaseURL: req.BaseURL, APIKeyEnc: enc, Channel: channel, Enabled: 1, Protocol: protocol}
	if channel == "" {
		p.Models = req.Models
	}
	if req.Enabled != nil && !*req.Enabled {
		p.Enabled = 0
	}
	if _, err := serverstore.AddGatewayProvider(db, p); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "上游名称已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
		return
	}
	// 同步 models 表:provider 的模型清单即客户端可见模型(单一数据源)。
	// channel provider 的模型由渠道同步维护,不走 provider.models 列表覆盖。
	// 手动型:模型表同步失败则回滚刚创建的 provider,避免半提交(审计修复 M2)
	// ——此前先插后错返回 500,客户端重试必然撞"上游名称已存在"。
	if p.Channel == "" {
		if err := serverstore.SyncProviderModels(db, p.ID, req.Models); err != nil {
			_ = serverstore.DeleteGatewayProvider(db, p.ID)
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
	if req.BaseURL == "" && p.BaseURL == "" && req.Channel != nil && *req.Channel != "" {
		if ch, ok := channels.Get(*req.Channel); ok {
			p.BaseURL = ch.BaseURL()
		}
	}
	if req.BaseURL != "" {
		p.BaseURL = req.BaseURL
	}
	wasChannel := p.Channel
	if req.Channel != nil {
		// 指针语义:"" = 清空渠道(切回手动型)(审计修复 M3 附带)
		p.Channel = *req.Channel
	}
	if req.Protocol != nil && *req.Protocol != "" {
		if *req.Protocol != "openai" && *req.Protocol != "anthropic" && *req.Protocol != "both" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "protocol 仅支持 openai/anthropic/both")
			return
		}
		p.Protocol = *req.Protocol
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
	} else if p.Channel != "" {
		// 渠道型上游的手动模型清单已无意义:LoadUpstreams 会把它并进路由,
		// 导致已切渠道的上游仍路由旧的手动模型(审计修复 M3 附带清理)。
		p.Models = nil
	}
	if req.Enabled != nil {
		if *req.Enabled {
			p.Enabled = 1
		} else {
			p.Enabled = 0
		}
	}
	if err := serverstore.UpdateGatewayProvider(db, p); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "上游名称已存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "更新失败")
		return
	}
	// 模型清单变更同步到 models 表(单一数据源)。仅两种情形触发:
	//  1. 请求显式携带 models 字段(手动型清单编辑);
	//  2. 渠道型切回手动型(wasChannel != "" → p.Channel == ""):清空旧渠道
	//     同步来的模型,避免残留路由。
	// 启停/改名等其它更新不得用空清单清空手动型上游的模型(审计修复后回归:
	// PUT {"enabled":false} 曾把该上游模型全部删除)。
	// channel provider 的模型由渠道同步维护,不走 provider.models 列表覆盖。
	clearingChannelModels := wasChannel != "" && p.Channel == ""
	if (req.Models != nil || clearingChannelModels) && p.Channel == "" {
		names := p.Models
		if clearingChannelModels {
			names = nil
		}
		if err := serverstore.SyncProviderModels(db, p.ID, names); err != nil {
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
		// 不存在的上游此前落 500,掩盖了资源缺失(审计修复 M2)
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "上游不存在")
			return
		}
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
	// 价格/折扣用 optionalFloat 区分「未传」与「显式 null」(审计修复 L6):
	// 未传 = 不覆盖;显式 null = 清空(设为未定价)。此前 null 与缺省同义,
	// 定价后无法回退到未定价。
	InputPricePer1M  optionalFloat `json:"input_price_per_1m"`
	OutputPricePer1M optionalFloat `json:"output_price_per_1m"`
	// CacheInputPricePer1M 缓存命中输入价(0029):nil/未传 = 不覆盖;0 = 清空(未配置)。
	CacheInputPricePer1M optionalFloat `json:"cache_input_price_per_1m"`
	OffpeakDiscount      optionalFloat `json:"offpeak_discount"` // 0023:0<d<=1 低谷折扣;nil/1 = 无峰谷
}

// optionalFloat 记录 JSON 字段是否出现(Set)与解析出的值(Value,nil = null)。
type optionalFloat struct {
	Set   bool
	Value *float64
}

func (o *optionalFloat) UnmarshalJSON(b []byte) error {
	o.Set = true
	if string(b) == "null" {
		o.Value = nil
		return nil
	}
	var v float64
	if err := json.Unmarshal(b, &v); err != nil {
		return err
	}
	o.Value = &v
	return nil
}

// validateModelPrices rejects negative prices (nil = 未定价,允许) and
// out-of-range off-peak discounts (must satisfy 0 < d <= 1; nil/1 = none).
func validateModelPrices(c *gin.Context, in, out, cache, offpeak *float64) bool {
	if in != nil && *in < 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "input_price_per_1m 不能为负数")
		return false
	}
	if out != nil && *out < 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "output_price_per_1m 不能为负数")
		return false
	}
	if cache != nil && *cache < 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "cache_input_price_per_1m 不能为负数")
		return false
	}
	if offpeak != nil && (*offpeak <= 0 || *offpeak > 1) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "offpeak_discount 必须在 (0,1] 之间(1 = 无峰谷价)")
		return false
	}
	return true
}

func listModelsAdmin(c *gin.Context, db *sql.DB) {
	// 管理端用完整字段(含价格/峰谷折扣,0022/0023);客户端 /v1/models 仍走
	// 公开 ListModels(基础字段,不泄露定价配置)。
	models, err := serverstore.ListAdminModels(db)
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
	if !validateModelPrices(c, req.InputPricePer1M.Value, req.OutputPricePer1M.Value, req.CacheInputPricePer1M.Value, req.OffpeakDiscount.Value) {
		return
	}
	// provider 必须存在:FK 冲突此前落 500,掩盖参数错误(审计修复 M2)
	if _, err := serverstore.GetGatewayProvider(db, req.ProviderID); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "所属上游不存在")
		return
	}
	m := &serverstore.Model{
		Name: req.Name, ProviderID: req.ProviderID, DisplayName: req.DisplayName,
		DefaultParams: req.DefaultParams, InputPricePer1M: req.InputPricePer1M.Value,
		OutputPricePer1M: req.OutputPricePer1M.Value, CacheInputPricePer1M: req.CacheInputPricePer1M.Value,
		OffpeakDiscount: req.OffpeakDiscount.Value,
	}
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
	if !validateModelPrices(c, req.InputPricePer1M.Value, req.OutputPricePer1M.Value, req.CacheInputPricePer1M.Value, req.OffpeakDiscount.Value) {
		return
	}
	// 改名防护(审计修复 M7):模型名承担路由键/记账键/默认模型键多重身份,
	// 改名会破坏 usage 历史口径并使默认模型悬空。渠道同步模型本由上游命名,
	// 改名必被下次同步覆盖;有用量记录的模型改名会错位历史费用。
	if req.Name != "" && req.Name != m.Name {
		if has, err := serverstore.ModelHasUsage(db, m.Name); err == nil && has {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "该模型已有用量记录,不允许改名")
			return
		}
		if m.ProviderChannel != "" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "渠道同步模型由上游命名,不允许改名")
			return
		}
		m.Name = req.Name
	}
	if req.ProviderID > 0 {
		if _, err := serverstore.GetGatewayProvider(db, req.ProviderID); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "所属上游不存在")
			return
		}
		m.ProviderID = req.ProviderID
	}
	if req.DisplayName != "" {
		m.DisplayName = req.DisplayName
	}
	if req.DefaultParams != "" {
		m.DefaultParams = req.DefaultParams
	}
	// optionalFloat:未传(Set=false)不覆盖;显式 null(Set=true,Value=nil)
	// 清空为未定价(审计修复 L6)
	if req.InputPricePer1M.Set {
		m.InputPricePer1M = req.InputPricePer1M.Value
	}
	if req.OutputPricePer1M.Set {
		m.OutputPricePer1M = req.OutputPricePer1M.Value
	}
	if req.CacheInputPricePer1M.Set {
		m.CacheInputPricePer1M = req.CacheInputPricePer1M.Value
	}
	if req.OffpeakDiscount.Set {
		m.OffpeakDiscount = req.OffpeakDiscount.Value
	}
	if err := serverstore.UpdateModel(db, m); err != nil {
		if errors.Is(err, serverstore.ErrDuplicate) {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "模型名已存在")
			return
		}
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
	// 渠道型上游:删除其同步模型记入排除名单,防止被 SyncLoop 复活(审计修复 H2)
	if m, err := serverstore.GetModel(db, id); err == nil && m.ProviderChannel != "" {
		if err := serverstore.AddExcludedModel(db, m.ProviderID, m.Name); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
			return
		}
	}
	if err := serverstore.DeleteModel(db, id); err != nil {
		// 不存在的模型此前落 500(审计修复 M2)
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "模型不存在")
			return
		}
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
	monthlyQuota := settings[serverstore.MonthlyQuotaSetting]
	if monthlyQuota == "" {
		monthlyQuota = "0"
	}
	monthlyQuotaMoney := settings[serverstore.MonthlyMoneyQuotaSetting]
	if monthlyQuotaMoney == "" {
		monthlyQuotaMoney = "0"
	}
	retention := settings[serverstore.RetentionMonthsSetting]
	if retention == "" {
		retention = fmt.Sprintf("%d", serverstore.DefaultRetentionMonths)
	}
	c.JSON(http.StatusOK, gin.H{
		"default_model":           settings["gateway.default_model"],
		"rate_limit":              rateLimit,
		"monthly_quota":           monthlyQuota,                             // default per-user monthly tokens (0 = unlimited)
		"monthly_quota_money":     monthlyQuotaMoney,                        // default per-user monthly yuan (0 = unlimited)
		"peak_windows":            settings[serverstore.PeakWindowsSetting], // 高峰时段 JSON;空 = 无峰谷价
		"retention_months":        retention,                                // usage 明细保留月数(0=永久,默认 6)
		"error_reporting_dsn":     settings["web.error_reporting_dsn"],
		"error_reporting_enabled": settings["web.error_reporting_enabled"] == "true",
		"error_reporting_level":   settings["web.error_reporting_level"],
		"glitchtip_base_url":      settings["web.glitchtip_base_url"],
		"glitchtip_organization":  settings["web.glitchtip_organization"],
		"default_thinking_level":  settings["web.default_thinking_level"],
		"server_base_url":         settings["server.base_url"],
	})
}

// FlexibleString 接受 JSON string 或 number(审计修复 2026-P (B2):第三方
// 直连 API 常按业务直觉传数字,如 rate_limit:60;统一解析为字符串存储,
// 兼容两种输入,保持既有 *string 语义不变)。
type FlexibleString string

// UnmarshalJSON 接受 string / number;其他类型报错。
func (f *FlexibleString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 {
		*f = ""
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = FlexibleString(s)
		return nil
	}
	if b[0] == '-' || (b[0] >= '0' && b[0] <= '9') {
		var n json.Number
		if err := json.Unmarshal(b, &n); err != nil {
			return err
		}
		*f = FlexibleString(n.String())
		return nil
	}
	return errors.New("flexible string: unsupported type")
}

// setGatewayConfig validates default_model against enabled models and saves.
// 契约(审计修复 M1):字符串/布尔字段全部用指针——缺省(null/未传)= 不覆盖,
// 显式 "" / false = 清空/关闭;peak_windows 显式空串 = 移除高峰窗口(无峰谷价)。
// rate_limit/monthly_quota/monthly_quota_money 用 FlexibleString:兼容
// JSON 数字与字符串(第三方直连不踩坑,前端字符串不受影响)。
// 2026-09:web.allow_private / web.search_endpoint 已随 web_fetch/web_search
// 服务端链路调整删除(客户端默认启用、无消费方),不再下发/读写。
func setGatewayConfig(c *gin.Context, db *sql.DB) {
	var req struct {
		DefaultModel          *string         `json:"default_model"`
		RateLimit             *FlexibleString `json:"rate_limit"`
		MonthlyQuota          *FlexibleString `json:"monthly_quota"`
		MonthlyQuotaMoney     *FlexibleString `json:"monthly_quota_money"`
		PeakWindows           *string         `json:"peak_windows"`
		RetentionMonths       *string         `json:"retention_months"`
		ErrorReportingDSN     *string         `json:"error_reporting_dsn"`
		ErrorReportingEnabled *bool           `json:"error_reporting_enabled"`
		ErrorReportingLevel   *string         `json:"error_reporting_level"`
		GlitchTipBaseURL      *string         `json:"glitchtip_base_url"`
		GlitchTipOrg          *string         `json:"glitchtip_organization"`
		DefaultThinkingLevel  *string         `json:"default_thinking_level"`
		ServerBaseURL         *string         `json:"server_base_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	// 高峰时段:显式空串 = 清空(无峰谷价);非空必须合法,非法 JSON 直接拒绝,
	// 宁可保持现状也不写坏计费口径。
	if req.PeakWindows != nil && *req.PeakWindows != "" {
		if serverstore.ParsePeakWindows(*req.PeakWindows) == nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "peak_windows 必须是合法高峰时段 JSON,如 [{\"start\":\"09:00\",\"end\":\"12:00\"}]")
			return
		}
	}
	if req.DefaultModel != nil && *req.DefaultModel != "" && !modelEnabledByDB(db, *req.DefaultModel) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "默认模型必须属于已启用的模型")
		return
	}
	if req.RateLimit != nil && *req.RateLimit != "" {
		if n, err := strconv.Atoi(string(*req.RateLimit)); err != nil || n <= 0 || n > 100000 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "rate_limit 必须是正整数")
			return
		}
	}
	if req.MonthlyQuota != nil && *req.MonthlyQuota != "" {
		if n, err := strconv.Atoi(string(*req.MonthlyQuota)); err != nil || n < 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "monthly_quota 必须是非负整数")
			return
		}
	}
	if req.MonthlyQuotaMoney != nil && *req.MonthlyQuotaMoney != "" {
		if n, err := strconv.ParseFloat(string(*req.MonthlyQuotaMoney), 64); err != nil || n < 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "monthly_quota_money 必须是非负数字")
			return
		}
	}
	if req.RetentionMonths != nil {
		if n, err := serverstore.ParseRetentionMonths(*req.RetentionMonths); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "retention_months 必须是 0~120 的整数(0=永不删除)")
			return
		} else if n < 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "retention_months 必须 >= 0")
			return
		}
	}
	if req.DefaultModel != nil {
		if err := serverstore.SetSetting(db, "gateway.default_model", *req.DefaultModel); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.RateLimit != nil {
		if err := serverstore.SetSetting(db, "gateway.rate_limit", string(*req.RateLimit)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.MonthlyQuota != nil {
		if err := serverstore.SetSetting(db, serverstore.MonthlyQuotaSetting, string(*req.MonthlyQuota)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.MonthlyQuotaMoney != nil {
		if err := serverstore.SetSetting(db, serverstore.MonthlyMoneyQuotaSetting, string(*req.MonthlyQuotaMoney)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	// 高峰窗口:显式空串 = 移除(无峰谷价),显式合法 JSON = 写入(审计修复 H1)
	if req.PeakWindows != nil {
		if err := serverstore.SetSetting(db, serverstore.PeakWindowsSetting, *req.PeakWindows); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	// usage 明细保留月数(0=永久,默认 6);变更后立即执行一次清理。
	if req.RetentionMonths != nil {
		if err := serverstore.SetSetting(db, serverstore.RetentionMonthsSetting, *req.RetentionMonths); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
		if err := serverstore.CleanupUsageRetention(db); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保留清理失败")
			return
		}
	}
	if req.ErrorReportingDSN != nil {
		// 错误上报 DSN(空串 = 清空/不启用);Sentry 格式,非空结尾必须 /、
		// 否则 SDK 解析失败——此处仅存,合法性由客户端初始化容错。
		if err := serverstore.SetSetting(db, "web.error_reporting_dsn", *req.ErrorReportingDSN); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingEnabled != nil {
		if err := serverstore.SetSetting(db, "web.error_reporting_enabled", strconv.FormatBool(*req.ErrorReportingEnabled)); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingLevel != nil {
		// 等级阈值校验(2026-08):error|warning|info|debug
		switch *req.ErrorReportingLevel {
		case "", "error", "warning", "info", "debug":
		default:
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "reporting_level 必须是 error|warning|info|debug")
			return
		}
		if err := serverstore.SetSetting(db, "web.error_reporting_level", *req.ErrorReportingLevel); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.GlitchTipBaseURL != nil {
		// GlitchTip 连接器地址(统一分发;空串 = 清空,客户端不预填)
		if err := serverstore.SetSetting(db, "web.glitchtip_base_url", *req.GlitchTipBaseURL); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.GlitchTipOrg != nil {
		// GlitchTip 组织 slug(统一分发)
		if err := serverstore.SetSetting(db, "web.glitchtip_organization", *req.GlitchTipOrg); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.DefaultThinkingLevel != nil {
		// 默认思考强度(2026-08):客户端默认模型 reasoningEffort,
		// 与 llm-deepseek 适配器支持档位对齐(off|low|high|max)
		switch *req.DefaultThinkingLevel {
		case "", "off", "low", "high", "max":
		default:
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "default_thinking_level 必须是 off|low|high|max")
			return
		}
		if err := serverstore.SetSetting(db, "web.default_thinking_level", *req.DefaultThinkingLevel); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ServerBaseURL != nil {
		// 对外 HTTPS 地址(经 Caddy 反代后的访问入口),webadmin 配置展示用
		if err := serverstore.SetSetting(db, "server.base_url", *req.ServerBaseURL); err != nil {
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
