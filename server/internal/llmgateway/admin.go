package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// ---------------------------------------------------------------------------
// 网关配置审计(2026-09 P1 补全):provider/模型/全局配置变更全部落 audit_logs。
// 此前 llmgateway 对 AuditLog 零调用——「计量即金钱」的平台,价格/渠道/配额
// 变更不留痕是审计缺口(见 .smoke/ENTERPRISE-FEATURE-AUDIT-2026-09-02.md)。
// ---------------------------------------------------------------------------

// auditActor 取管理会话用户名(AdminAuth 一定已注入;防御性兜底空串)。
func auditActor(c *gin.Context) string {
	if u := serverauth.AdminUser(c); u != nil {
		return u.Username
	}
	return ""
}

// auditSetSettingTx 写 settings 并记录变更到 changes(旧→新),用于 gateway_config
// 审计的字段级明细。**事务内**版本(2026-09-19:P2-1 网关配置写入整体原子化):
// 旧值仍从 db 读(settings 表没有 GetSettingTx;读旧值只为组装审计明细,不参与
// 原子性),写入走 SetSettingTx —— 后者**不主动失效缓存**,提交后必须由调用方
// 调用 serverstore.InvalidateSettings(),否则保存成功但运行期(限流/峰谷/错误
// 上报)仍读到旧值,配置静默不生效。changes 组装逻辑与旧实现逐字一致。
func auditSetSettingTx(db *sql.DB, tx *sql.Tx, key, label, value string, changes *[]string) error {
	old, _, err := serverstore.GetSetting(db, key)
	if err != nil {
		old = ""
	}
	if old != value {
		*changes = append(*changes, fmt.Sprintf("%s:%s→%s", label, orEmpty(old), orEmpty(value)))
	}
	return serverstore.SetSettingTx(tx, key, value)
}

func orEmpty(v string) string {
	if v == "" {
		return "(空)"
	}
	return v
}

// RegisterAdminRoutes mounts /api/server/admin/providers, /api/server/admin/models
// and /api/server/admin/gateway behind AdminAuth + RBAC permission checks (v3b).
func RegisterAdminRoutes(r *gin.Engine, db *sql.DB) {
	base := "/api/server/admin"
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
	// 错误上报自检(P0-4/D3):服务端代发测试事件 + 客户端上报状态聚合(P1-3)。
	serverauth.AdminRoute(g, "POST", "/gateway/error-reporting/test", serverauth.PermGatewayWrite, func(c *gin.Context) { testErrorReporting(c, db) })
	serverauth.AdminRoute(g, "GET", "/gateway/error-reporting/clients", serverauth.PermGatewayRead, func(c *gin.Context) { errorReportingClients(c, db) })
	serverauth.AdminRoute(g, "GET", "/channels", serverauth.PermGatewayRead, func(c *gin.Context) { listChannelsAdmin(c) })
	serverauth.AdminRoute(g, "POST", "/providers/:id/sync", serverauth.PermGatewayWrite, func(c *gin.Context) { syncOneAdmin(c, db) })
	serverauth.AdminRoute(g, "POST", "/providers/sync-all", serverauth.PermGatewayWrite, func(c *gin.Context) { syncAllAdmin(c, db) })
	// 网关文件台账管理面(2026-09-22):与生产路由树(internal/router)逐条对齐 ——
	// 测试树缺一条就会让对应用例 404（本仓既有约定:测试树必须镜像生产路径）。
	api := &API{DB: db, client: &http.Client{Transport: newUpstreamTransport()}}
	serverauth.AdminRoute(g, "GET", "/gateway/files", serverauth.PermGatewayRead, func(c *gin.Context) { listGatewayFilesAdmin(c, db) })
	serverauth.AdminRoute(g, "GET", "/gateway/files/summary", serverauth.PermGatewayRead, func(c *gin.Context) { gatewayFilesSummaryAdmin(c, db) })
	serverauth.AdminRoute(g, "DELETE", "/gateway/files/:file_id", serverauth.PermGatewayWrite, func(c *gin.Context) { deleteGatewayFileAdmin(c, api, db) })
	serverauth.AdminRoute(g, "POST", "/gateway/files/purge", serverauth.PermGatewayWrite, func(c *gin.Context) { purgeGatewayFilesAdmin(c, api, db) })
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
	if err := validateUpstreamBaseURL(req.BaseURL); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
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
	_ = serverstore.AuditLog(db, auditActor(c), "provider_create",
		fmt.Sprintf("%s base_url=%s channel=%s protocol=%s enabled=%v models=%d",
			p.Name, p.BaseURL, p.Channel, p.Protocol, p.Enabled == 1, len(p.Models)))
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
	orig := *p // 审计基线(p.Models 切片仅读,后续赋值不回溯)
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
		if err := validateUpstreamBaseURL(req.BaseURL); err != nil {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", err.Error())
			return
		}
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
	// 审计:字段级变更明细(密钥只记"已更换",不落明文/密文)
	var ch []string
	if p.Name != orig.Name {
		ch = append(ch, "name:"+orig.Name+"→"+p.Name)
	}
	if p.BaseURL != orig.BaseURL {
		ch = append(ch, "base_url:"+orig.BaseURL+"→"+p.BaseURL)
	}
	if p.Channel != orig.Channel {
		ch = append(ch, "channel:"+orEmpty(orig.Channel)+"→"+orEmpty(p.Channel))
	}
	if p.Protocol != orig.Protocol {
		ch = append(ch, "protocol:"+orig.Protocol+"→"+p.Protocol)
	}
	if p.Enabled != orig.Enabled {
		ch = append(ch, fmt.Sprintf("enabled:%v→%v", orig.Enabled == 1, p.Enabled == 1))
	}
	if p.APIKeyEnc != orig.APIKeyEnc {
		ch = append(ch, "api_key:已更换")
	}
	if !slices.Equal(orig.Models, p.Models) {
		ch = append(ch, fmt.Sprintf("models:%d→%d", len(orig.Models), len(p.Models)))
	}
	if len(ch) > 0 {
		_ = serverstore.AuditLog(db, auditActor(c), "provider_update", p.Name+": "+strings.Join(ch, ", "))
	}
	c.JSON(http.StatusOK, gin.H{"provider": providerJSON(*p), "sync": syncRes})
}

func deleteProvider(c *gin.Context, db *sql.DB) {
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
	if err := serverstore.DeleteGatewayProvider(db, id); err != nil {
		// 不存在的上游此前落 500,掩盖了资源缺失(审计修复 M2)
		if errors.Is(err, serverstore.ErrNotFound) {
			serverauth.WriteError(c, http.StatusNotFound, "NOT_FOUND", "上游不存在")
			return
		}
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
		return
	}
	_ = serverstore.AuditLog(db, auditActor(c), "provider_delete", fmt.Sprintf("%s base_url=%s", p.Name, p.BaseURL))
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

type modelReq struct {
	Name          string `json:"name"`
	ProviderID    int64  `json:"provider_id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
	// InputModalities 模型接受的输入模态(0058,'text'/'image' 数组):
	// create 缺省 = 仅 text;update 缺省/空 = 不覆盖,显式数组 = 设置
	// (与价格字段「未传不覆盖」同语义;空数组/非法值由校验拒绝)。
	InputModalities []string `json:"input_modalities"`
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

// validateInputModalities rejects invalid input modality arrays (0058):
// non-empty subsets of {text, image}, no duplicates. nil = 未设置,允许
// (create 缺省仅 text / update 不覆盖)。
func validateInputModalities(c *gin.Context, modalities []string) bool {
	if modalities == nil {
		return true
	}
	if len(modalities) == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "input_modalities 不能为空数组")
		return false
	}
	seen := make(map[string]bool, len(modalities))
	for _, m := range modalities {
		if m != "text" && m != "image" {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"input_modalities 只能包含 text/image")
			return false
		}
		if seen[m] {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"input_modalities 不能包含重复项")
			return false
		}
		seen[m] = true
	}
	return true
}

// modalitiesDetail 模型模态审计明细(仅 text 归一显示)。
func modalitiesDetail(ms []string) string {
	return strings.Join(ms, "+")
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

// auditModelDetail 模型审计明细(价格 nil = 未定价)。
func auditModelDetail(m *serverstore.Model) string {
	return fmt.Sprintf("%s provider=%d display=%s modalities=%s input=%s output=%s cache=%s offpeak=%s",
		m.Name, m.ProviderID, m.DisplayName, modalitiesDetail(m.InputModalities), priceStr(m.InputPricePer1M),
		priceStr(m.OutputPricePer1M), priceStr(m.CacheInputPricePer1M), priceStr(m.OffpeakDiscount))
}

func priceStr(p *float64) string {
	if p == nil {
		return "未定价"
	}
	return strconv.FormatFloat(*p, 'g', -1, 64)
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
	if !validateInputModalities(c, req.InputModalities) {
		return
	}
	// provider 必须存在:FK 冲突此前落 500,掩盖参数错误(审计修复 M2)
	prov, err := serverstore.GetGatewayProvider(db, req.ProviderID)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "所属上游不存在")
		return
	}
	// 2026-09-19(P2-4):渠道型上游的模型名可能还在**排除名单**里(管理员删除
	// 过它,而 webadmin 删除确认文案承诺「如需恢复请重新添加」)。管理端重新
	// 添加是**显式意图**,必须先把该名移出名单 —— 否则下一轮同步会因为它不在
	// 上游目录的 keep 列表(newNames)里再删一次,承诺不可兑现(实测
	// create 200 → 下一轮 Removed:1)。
	//
	// 顺序:先移名单、后建行,且**两步在同一事务内**(2026-09-19,N1)。
	// 旧实现两步各自 autocommit:"移名单"先提交,于是**失败请求**(建行 500、
	// 或同名重复 400)也会清空名单 ⇒ 下一轮同步把管理员显式删除的渠道模型
	// 复活(H2 保护被一次失败请求撤销)。判据="请求失败不留任何状态变化"。
	// 反过来(先建行再移名单)会把"模型已建但下轮被删"这种最坏的半套状态变成
	// 常态,而管理员看到的是 200。
	//
	// 缓存失效必须在 **commit 之后**:AddModelTx 不失效模型缓存、
	// RemoveExcludedModelTx 走的 SetSettingTx 也不失效 settings 缓存 ⇒
	// 提交后显式失效三处,否则"保存成功但运行期读旧值"(模型目录 / 排除名单
	// 静默不生效)。事务回滚路径什么都不失效(缓存里仍是库里的真值)。
	m := &serverstore.Model{
		Name: req.Name, ProviderID: req.ProviderID, DisplayName: req.DisplayName,
		DefaultParams: req.DefaultParams, InputModalities: serverstore.NormalizeInputModalities(req.InputModalities),
		InputPricePer1M:  req.InputPricePer1M.Value,
		OutputPricePer1M: req.OutputPricePer1M.Value, CacheInputPricePer1M: req.CacheInputPricePer1M.Value,
		OffpeakDiscount: req.OffpeakDiscount.Value,
	}
	if prov.Channel == "" {
		// 手动型上游不参与同步,没有排除名单语义:单条 INSERT(autocommit),
		// 缓存失效由 AddModel 自己完成 —— 行为与历史逐字一致。
		if _, err := serverstore.AddModel(db, m); err != nil {
			writeModelCreateError(c, err)
			return
		}
	} else {
		tx, err := db.Begin()
		if err != nil {
			log.Printf("gateway model create: 开启事务失败 provider=%d name=%s: %v", req.ProviderID, req.Name, err)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
		defer tx.Rollback() // 提交后为 no-op
		if _, err := serverstore.RemoveExcludedModelTx(tx, req.ProviderID, req.Name); err != nil {
			log.Printf("gateway model create: 移出排除名单失败 provider=%d name=%s: %v", req.ProviderID, req.Name, err)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
		if _, err := serverstore.AddModelTx(tx, m); err != nil {
			// 400/500:defer 的 Rollback 会把本次请求对名单的改动一并撤销。
			writeModelCreateError(c, err)
			return
		}
		if err := tx.Commit(); err != nil {
			log.Printf("gateway model create: 提交失败 provider=%d name=%s: %v", req.ProviderID, req.Name, err)
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
			return
		}
		// 提交成功后失效:①排除名单(settings 键,RemoveExcludedModelTx 不失效);
		// ②模型目录/定价(AddModelTx 不失效)。顺序无依赖,都是"提交后立刻可见"。
		serverstore.InvalidateSettings()
		serverstore.InvalidateModelConfig()
		serverstore.InvalidateModelsChanged()
	}
	_ = serverstore.AuditLog(db, auditActor(c), "model_create", auditModelDetail(m))
	c.JSON(http.StatusOK, gin.H{"model": m})
}

// writeModelCreateError 把建行失败映射为既有错误语义(逐字不变):
// 同名 → 400「模型名已存在」,其它 → 500「创建失败」。
func writeModelCreateError(c *gin.Context, err error) {
	if errors.Is(err, serverstore.ErrDuplicate) {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "模型名已存在")
		return
	}
	serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "创建失败")
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
	orig := *m // 审计基线(指针字段仅读)
	var req modelReq
	if err := c.ShouldBindJSON(&req); err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	if !validateModelPrices(c, req.InputPricePer1M.Value, req.OutputPricePer1M.Value, req.CacheInputPricePer1M.Value, req.OffpeakDiscount.Value) {
		return
	}
	if !validateInputModalities(c, req.InputModalities) {
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
	// input_modalities:显式数组(含空数组——校验拒绝)才覆盖,缺省保持现值。
	if req.InputModalities != nil {
		m.InputModalities = serverstore.NormalizeInputModalities(req.InputModalities)
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
	// 审计:价格/参数变更明细(口径即计费,必须留痕)
	var ch []string
	if m.Name != orig.Name {
		ch = append(ch, "name:"+orig.Name+"→"+m.Name)
	}
	if m.ProviderID != orig.ProviderID {
		ch = append(ch, fmt.Sprintf("provider:%d→%d", orig.ProviderID, m.ProviderID))
	}
	if m.DisplayName != orig.DisplayName {
		ch = append(ch, "display:"+orig.DisplayName+"→"+m.DisplayName)
	}
	if m.DefaultParams != orig.DefaultParams {
		ch = append(ch, "params:已修改")
	}
	if modalitiesDetail(m.InputModalities) != modalitiesDetail(orig.InputModalities) {
		ch = append(ch, "modalities:"+modalitiesDetail(orig.InputModalities)+"→"+modalitiesDetail(m.InputModalities))
	}
	if !optF64Eq(m.InputPricePer1M, orig.InputPricePer1M) {
		ch = append(ch, "input:"+priceStr(orig.InputPricePer1M)+"→"+priceStr(m.InputPricePer1M))
	}
	if !optF64Eq(m.OutputPricePer1M, orig.OutputPricePer1M) {
		ch = append(ch, "output:"+priceStr(orig.OutputPricePer1M)+"→"+priceStr(m.OutputPricePer1M))
	}
	if !optF64Eq(m.CacheInputPricePer1M, orig.CacheInputPricePer1M) {
		ch = append(ch, "cache:"+priceStr(orig.CacheInputPricePer1M)+"→"+priceStr(m.CacheInputPricePer1M))
	}
	if !optF64Eq(m.OffpeakDiscount, orig.OffpeakDiscount) {
		ch = append(ch, "offpeak:"+priceStr(orig.OffpeakDiscount)+"→"+priceStr(m.OffpeakDiscount))
	}
	if len(ch) > 0 {
		_ = serverstore.AuditLog(db, auditActor(c), "model_update", m.Name+": "+strings.Join(ch, ", "))
	}
	c.JSON(http.StatusOK, gin.H{"model": m})
}

// optF64Eq 指针浮点相等(含 nil 语义)。
func optF64Eq(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func deleteModel(c *gin.Context, db *sql.DB) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "无效 ID")
		return
	}
	// 渠道型上游:删除其同步模型记入排除名单,防止被 SyncLoop 复活(审计修复 H2)
	var delName string
	if m, err := serverstore.GetModel(db, id); err == nil {
		delName = m.Name
		if m.ProviderChannel != "" {
			if err := serverstore.AddExcludedModel(db, m.ProviderID, m.Name); err != nil {
				serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除失败")
				return
			}
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
	if delName != "" {
		_ = serverstore.AuditLog(db, auditActor(c), "model_delete", delName)
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
		// 缺省 0 = 不限制(与官方一致:官方只限账号级并发,不限请求速率)。
		rateLimit = "0"
	}
	retention := settings[serverstore.RetentionMonthsSetting]
	if retention == "" {
		retention = fmt.Sprintf("%d", serverstore.DefaultRetentionMonths)
	}
	// 出站体加工的两个闸门值(2026-09-22):缺省即 Default*,空值一律回落到缺省展示 ——
	// 管理端永远看到一个具体数字,不需要理解"空 = 缺省"。
	maxFileRefs := settings[SettingMaxFileRefs]
	if maxFileRefs == "" {
		maxFileRefs = strconv.Itoa(DefaultMaxFileRefsPerRequest)
	}
	parseBudget := settings[SettingBodyParseBudgetMB]
	if parseBudget == "" {
		parseBudget = strconv.Itoa(DefaultBodyParseBudgetMB)
	}
	fileExpiryDays := settings[SettingFileExpiryDays]
	if fileExpiryDays == "" {
		fileExpiryDays = strconv.Itoa(DefaultFileExpiryDays)
	}
	c.JSON(http.StatusOK, gin.H{
		"default_model":             settings["gateway.default_model"],
		"rate_limit":                rateLimit,
		"peak_windows":              settings[serverstore.PeakWindowsSetting], // 高峰时段 JSON;空 = 无峰谷价
		"retention_months":          retention,                                // usage 明细保留月数(0=永久,默认 6)
		"error_reporting_dsn":       settings["web.error_reporting_dsn"],
		"error_reporting_enabled":   settings["web.error_reporting_enabled"] == "true",
		"error_reporting_level":     settings["web.error_reporting_level"],
		"error_reporting_heartbeat": settings["web.error_reporting_heartbeat"] == "true",
		"glitchtip_base_url":        settings["web.glitchtip_base_url"],
		"glitchtip_organization":    settings["web.glitchtip_organization"],
		"default_thinking_level":    settings["web.default_thinking_level"],
		"server_base_url":           settings["server.base_url"],
		"max_file_refs":             maxFileRefs,    // 单请求 file_id 引用数上限
		"body_parse_budget_mb":      parseBudget,    // 进程级在飞请求体字节预算(MiB)
		"file_expiry_days":          fileExpiryDays, // 网关强制执行的文件保留上限(天)
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
		DefaultModel            *string         `json:"default_model"`
		RateLimit               *FlexibleString `json:"rate_limit"`
		PeakWindows             *string         `json:"peak_windows"`
		RetentionMonths         *string         `json:"retention_months"`
		ErrorReportingDSN       *string         `json:"error_reporting_dsn"`
		ErrorReportingEnabled   *bool           `json:"error_reporting_enabled"`
		ErrorReportingLevel     *string         `json:"error_reporting_level"`
		ErrorReportingHeartbeat *bool           `json:"error_reporting_heartbeat"`
		GlitchTipBaseURL        *string         `json:"glitchtip_base_url"`
		GlitchTipOrg            *string         `json:"glitchtip_organization"`
		DefaultThinkingLevel    *string         `json:"default_thinking_level"`
		ServerBaseURL           *string         `json:"server_base_url"`
		MaxFileRefs             *FlexibleString `json:"max_file_refs"`
		BodyParseBudgetMB       *FlexibleString `json:"body_parse_budget_mb"`
		FileExpiryDays          *FlexibleString `json:"file_expiry_days"`
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
		// 0 = 不限制(缺省,与官方口径一致);上限 100000 防误填天文数字。
		if n, err := strconv.Atoi(string(*req.RateLimit)); err != nil || n < 0 || n > 100000 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "rate_limit 必须是 0~100000 的整数(0=不限制)")
			return
		}
	}
	if req.MaxFileRefs != nil && *req.MaxFileRefs != "" {
		if _, ok := ParseMaxFileRefs(string(*req.MaxFileRefs)); !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				fmt.Sprintf("max_file_refs 必须是 1~%d 的整数", MaxMaxFileRefsPerRequest))
			return
		}
	}
	if req.BodyParseBudgetMB != nil && *req.BodyParseBudgetMB != "" {
		if _, ok := ParseBodyParseBudgetMB(string(*req.BodyParseBudgetMB)); !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				fmt.Sprintf("body_parse_budget_mb 必须是 %d~%d 的整数", MinBodyParseBudgetMB, MaxBodyParseBudgetMB))
			return
		}
	}
	if req.FileExpiryDays != nil && *req.FileExpiryDays != "" {
		if _, ok := ParseFileExpiryDays(string(*req.FileExpiryDays)); !ok {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				fmt.Sprintf("file_expiry_days 必须是 %d~%d 的整数", MinFileExpiryDays, MaxFileExpiryDays))
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
	// 错误上报 DSN 准入校验(2026-09-16,R2)。**必须放在任何写库之前**:
	// 拒绝时不允许留下半套已生效的配置(AC1:400 且 settings 未被写入),也不留
	// 审计噪音。规则见 dsn.go(硬拒 loopback/链路本地/云 metadata;私网与
	// http 只告警不阻断 —— 内网自建 GlitchTip 是合法主场景)。
	//
	// F-07(修复轮 1):**原样回提交不算"新的坏配置"**。
	//
	// 现场链路:库里可能存着本轮之前保存的坏 DSN(如 `http://…@localhost:8000/1`,
	// 旧版 webadmin 零校验照收);而「网关」页没有 DSN 输入框,它 GET 整份配置后
	// `{ ...cfg }` 原样回提交 —— 而这里的判定只看"字段是否出现",于是该页保存
	// **任何**无关配置都会被 400 拦住,管理员在本页无法自救(复核实证:A)
	// `PUT {rate_limit:321}` → 200;B) 整份回提交 → 400 且 rate_limit 未变)。
	//
	// 语义:只有"本次提交要把它**改成**另一个坏值"才拒绝;与库中现值逐字相同的
	// 提交视为**未提供**(不写库、不变更、不审计),但仍透出告警,让管理员知道
	// 库里那串不可用 —— 与"不把没有数据渲染成一切正常"的取向一致。
	// 库里现存的 DSN(未提交该字段时也要读出来做跨字段判定与告警)。
	storedDSN, storedDSNExists, _ := serverstore.GetSetting(db, "web.error_reporting_dsn")
	var dsnInspection ErrorReportingDSN
	if req.ErrorReportingDSN != nil && storedDSNExists && storedDSN == *req.ErrorReportingDSN {
		// F-07:原样回提交不算"新的坏配置" —— 视为未提供(不写库、不变更、不审计);
		// 但下面的告警仍要看库中现值。
		req.ErrorReportingDSN = nil
	}
	if req.ErrorReportingDSN != nil {
		dsnInspection = InspectErrorReportingDSN(*req.ErrorReportingDSN)
		if dsnInspection.Rejected() {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", dsnInspection.Message)
			return
		}
	}
	// 审计(2026-09 P1):字段级变更明细捕获。
	// 2026-09-11:默认 token/金额配额已下线(网关唯一闸门 = 余额),不再有
	// quota_default_change 动作。
	changes := []string{}
	// 合法但有风险的配置(私网/明文 http)透出给 webadmin 显示黄色告警条(P2-3)。
	warnings := []string{}
	if req.ErrorReportingDSN != nil && dsnInspection.Message != "" {
		warnings = append(warnings, "错误上报 DSN:"+dsnInspection.Message)
	} else if req.ErrorReportingDSN == nil && storedDSNExists {
		// S10-5(2026-09-17):只要本次**没有提交新的 DSN**(字段缺省,或与库中逐字
		// 相同的原样回提交),生效值就是库中现值 —— 它不可用时必须告警。此前这条被
		// dsnUnchanged 卡住,`PUT {error_reporting_enabled:true}` 这类部分体更新拿到
		// 的是 warnings:[],与"不能把坏配置渲染成一切正常"的取向相反。
		if storedInspection := InspectErrorReportingDSN(storedDSN); storedInspection.Rejected() {
			// 库中现值本身不可用:不阻断本页保存,但必须让管理员看见。
			warnings = append(warnings, "错误上报 DSN:库中现有值不可用("+storedInspection.Message+");请在「错误监控」页更新它")
		}
	}
	// F-13(修复轮 1):跨字段一致性 —— **不能保存"启用上报但没有 DSN"**。
	//
	// 复核实证:`PUT enabled=true + dsn=""` 返回 200 且入库(enabled="true"/dsn=""),
	// 客户端侧 `initSentry('')` 直接返回 —— 一个字节都不发,而管理员看到"已保存"。
	// 这是 R2 的跨字段形态(单字段都合法,组合起来必然不工作)。
	//
	// 判定用**生效后**的值(本次提交值 ?? 库中现值),且必须在任何写库之前 ——
	// 否则会出现"enabled 已写、然后发现 dsn 为空"的半套配置。
	{
		effectiveEnabled := false
		effectiveDSN := strings.TrimSpace(storedDSN)
		if storedEnabled, found, err := serverstore.GetSetting(db, "web.error_reporting_enabled"); err == nil && found {
			effectiveEnabled = storedEnabled == "true"
		}
		if req.ErrorReportingEnabled != nil {
			effectiveEnabled = *req.ErrorReportingEnabled
		}
		if req.ErrorReportingDSN != nil {
			effectiveDSN = strings.TrimSpace(*req.ErrorReportingDSN)
		}
		// S12-01(审计 2026-09-17):拒绝只在**本次提交显式提供**这两个字段之一时生效
		// (req.* 为指针;F-07 已把"原样回提交"折成 nil)。
		//
		// 否则「网关」页(F-07 白名单,页面上没有 DSN 输入框)保存任何无关字段都会被
		// 这里拦住:库里的 enabled="true" + dsn="" 是旧版 webadmin 可写入的真实存量
		// (v2.7.4 无 DSN 校验,且当时由「错误监控」页同时提交两个字段),该页既不能
		// 提交这两个字段、也不能靠报错自救。语义与 F-07 同源:库里的坏状态不是
		// "本次新的坏配置",降级为告警并点名唯一能修的页面。
		explicitSubmission := req.ErrorReportingEnabled != nil || req.ErrorReportingDSN != nil
		if effectiveEnabled && effectiveDSN == "" {
			if explicitSubmission {
				// 文案追加页面指引,让 400 自我定位(常量本身在 dsn.go,由
				// dsn 对拍语料冻结,不改它以免两侧文案漂移)。
				serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
					ErrorReportingDSNEnabledWithoutDSNMessage+";请到「错误监控」页填写 DSN 或关闭开关")
				return
			}
			warnings = append(warnings, "错误上报:库中开关已打开但 DSN 为空(客户端不会上报任何错误);请在「错误监控」页填写 DSN 或关闭开关")
		}
	}
	// 2026-09-19(审计):两条白名单校验必须与上面的 DSN 准入校验同一条纪律 ——
	// **在任何写库之前**。此前它们写在各自的写入分支内,于是
	// `PUT {"rate_limit":"120","error_reporting_level":"fatal"}` 会先落
	// rate_limit、再 400 ⇒ 拒绝留下半套已生效的配置(与该函数自己的声明矛盾)。
	// 判定条件与 400 文案逐字不变,只是提前到写库前。
	if req.ErrorReportingLevel != nil {
		// 等级阈值校验(2026-08):error|warning|info|debug
		switch *req.ErrorReportingLevel {
		case "", "error", "warning", "info", "debug":
		default:
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "reporting_level 必须是 error|warning|info|debug")
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
	}
	// 2026-09-19(审计 P2-1):以下 12 处写库收进**单一事务**,任一字段写失败
	// 整体回滚 —— 旧实现逐键 SetSetting,500 路径会留下"半套已生效配置"且
	// 零审计(AuditLog 只在函数末尾调一次),而其中 retention_months 之后紧跟
	// **破坏性** CleanupUsageRetention,更值得警惕。
	//
	// 范式与 serverauth/admin.go 的 F14(认证配置事务化)一致:Begin +
	// defer Rollback + 逐键 SetSettingTx + Commit;提交后**必须**
	// InvalidateSettings()(SetSettingTx 不失效缓存,见 auditSetSettingTx 注释)。
	tx, err := db.Begin()
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	defer tx.Rollback()
	if req.DefaultModel != nil {
		old, _, _ := serverstore.GetSetting(db, "gateway.default_model")
		if old != *req.DefaultModel {
			changes = append(changes, "默认模型:"+orEmpty(old)+"→"+orEmpty(*req.DefaultModel))
		}
		if err := serverstore.SetSettingTx(tx, "gateway.default_model", *req.DefaultModel); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.RateLimit != nil {
		if err := auditSetSettingTx(db, tx, "gateway.rate_limit", "每用户限流", string(*req.RateLimit), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	// 高峰窗口:显式空串 = 移除(无峰谷价),显式合法 JSON = 写入(审计修复 H1)
	if req.MaxFileRefs != nil {
		if err := auditSetSettingTx(db, tx, SettingMaxFileRefs, "单请求文件引用上限", string(*req.MaxFileRefs), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.BodyParseBudgetMB != nil {
		if err := auditSetSettingTx(db, tx, SettingBodyParseBudgetMB, "请求体加工内存预算", string(*req.BodyParseBudgetMB), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.FileExpiryDays != nil {
		if err := auditSetSettingTx(db, tx, SettingFileExpiryDays, "文件保留上限(天)", string(*req.FileExpiryDays), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.PeakWindows != nil {
		if err := auditSetSettingTx(db, tx, serverstore.PeakWindowsSetting, "高峰时段", *req.PeakWindows, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	// usage 明细保留月数(0=永久,默认 6)。**破坏性清理移出事务,在提交后执行**
	// (2026-09-19,P2-1):配置写入已原子生效,清理失败不再留下半套配置(旧行为
	// 是 retention 已落库而后续键未落)。仅显式提交 retention_months 时执行,
	// 失败仍是 500「保留清理失败」(文案不变)。
	if req.RetentionMonths != nil {
		if err := auditSetSettingTx(db, tx, serverstore.RetentionMonthsSetting, "明细保留", *req.RetentionMonths, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingDSN != nil {
		// 准入校验已在**任何写库之前**完成(见本函数上方 dsnInspection);
		// 这里只负责写入与透出告警。
		if err := auditSetSettingTx(db, tx, "web.error_reporting_dsn", "错误上报DSN", *req.ErrorReportingDSN, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingEnabled != nil {
		if err := auditSetSettingTx(db, tx, "web.error_reporting_enabled", "错误上报开关", strconv.FormatBool(*req.ErrorReportingEnabled), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingLevel != nil {
		// 准入校验已在**任何写库之前**完成(见本函数上方白名单校验块)。
		if err := auditSetSettingTx(db, tx, "web.error_reporting_level", "错误上报等级", *req.ErrorReportingLevel, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ErrorReportingHeartbeat != nil {
		// D4:独立开关,**默认 false = 与今天行为完全一致**;不改 error_reporting_level
		// 的取值与语义(红线)。
		if err := auditSetSettingTx(db, tx, "web.error_reporting_heartbeat", "错误上报心跳", strconv.FormatBool(*req.ErrorReportingHeartbeat), &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.GlitchTipBaseURL != nil {
		if err := auditSetSettingTx(db, tx, "web.glitchtip_base_url", "GlitchTip地址", *req.GlitchTipBaseURL, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.GlitchTipOrg != nil {
		if err := auditSetSettingTx(db, tx, "web.glitchtip_organization", "GlitchTip组织", *req.GlitchTipOrg, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.DefaultThinkingLevel != nil {
		// 准入校验已在**任何写库之前**完成(见本函数上方白名单校验块)。
		if err := auditSetSettingTx(db, tx, "web.default_thinking_level", "默认思考强度", *req.DefaultThinkingLevel, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if req.ServerBaseURL != nil {
		if err := auditSetSettingTx(db, tx, "server.base_url", "对外地址", *req.ServerBaseURL, &changes); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保存失败")
		return
	}
	// 提交后刷新缓存:SetSettingTx 有意不失效缓存(事务可能回滚),配置的
	// 运行期读取(限流/峰谷/错误上报/保留期)必须立刻看到新值。
	// 顺序也要紧:CleanupUsageRetention 经 EffectiveRetentionMonths 读
	// usage.retention_months,必须在失效之后才能读到本次写入的值。
	serverstore.InvalidateSettings()
	// 出站体加工的两个闸门值走自己的进程内 10s TTL 缓存(见 body_memory.go)——
	// 保存后必须主动失效,否则管理员改完最多 10s 内仍按旧值拒绝/放行。
	InvalidateGatewayLimits()
	// 审计**先于**破坏性清理(2026-09-19,N2):配置此刻已经提交生效,"谁改了什么"
	// 的可追溯性不得取决于 CleanupUsageRetention 的成败 —— 旧实现把 AuditLog
	// 放在清理之后,清理失败(500「保留清理失败」)会留下"配置已生效但零审计"
	// 的缺口。detail 与成功路径逐字一致(同一次 changes 组装,不掺入清理结果)。
	if len(changes) > 0 {
		_ = serverstore.AuditLog(db, auditActor(c), "gateway_config", strings.Join(changes, ", "))
	}
	if req.RetentionMonths != nil {
		if err := serverstore.CleanupUsageRetention(db); err != nil {
			serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "保留清理失败")
			return
		}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "warnings": warnings})
}

func modelEnabledByDB(db *sql.DB, name string) bool {
	models, err := ListModels(db)
	if err != nil {
		return false
	}
	return ModelEnabled(models, name)
}

// ---------------------------------------------------------------------------
// F10(审计 2026-09-11):provider base_url 安全校验。
//
// 背景:上游地址是管理员可控输入,服务端会对它发起请求并附带该 provider 的
// API key。不校验时,被攻破的管理会话可把 key 发往云 metadata(169.254.169.254
// / 100.100.100.200 / fd00:ec2::254)窃取云凭据,或指向任意非 http 协议。
//
// 与 reports webhook 的"禁止私网"不同:企业内网自建 LLM 网关是本产品的
// 主要场景,**允许私网**;这里只拦截:
//   - 非 http/https scheme、带 userinfo 的 URL;
//   - 链路本地/云 metadata 地址(IPv4 169.254.0.0/16、IPv6 fe80::/10、
//     阿里云 100.100.100.200、AWS IPv6 fd00:ec2::254);
//   - 无法解析的主机名(保存时即失败,而不是请求时才报错)。
// ---------------------------------------------------------------------------

// isBlockedUpstreamIP 委托到 util 的统一出站护栏(保存时与运行期同一口径)。
func isBlockedUpstreamIP(ip net.IP) bool { return util.IsBlockedOutboundIP(ip) }

// validateUpstreamBaseURL 校验 provider 上游地址(F10)。
func validateUpstreamBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return errors.New("base_url 不能为空")
	}
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("base_url 不是合法 URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("base_url 只支持 http/https")
	}
	if u.User != nil {
		return errors.New("base_url 不允许携带用户名/密码")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("base_url 缺少主机名")
	}
	if util.IsBlockedOutboundHost(host) {
		return errors.New("base_url 不允许指向云 metadata 服务")
	}
	// 字面 IP:直接判定,不解析。
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedUpstreamIP(ip) {
			return errors.New("base_url 不允许指向链路本地/云 metadata 地址")
		}
		return nil
	}
	// 域名:解析成功则检查任一结果(防解析到 metadata)。解析失败**放行**
	// (离线部署/内网 DNS 短暂不可用是常态;运行时还有 Dial 复检兜底),
	// 但保存时的字面 IP 与已知 metadata 域名仍拦截。
	ips, lerr := net.LookupIP(host)
	if lerr != nil || len(ips) == 0 {
		return nil
	}
	for _, ip := range ips {
		if isBlockedUpstreamIP(ip) {
			return errors.New("base_url 解析到了链路本地/云 metadata 地址")
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// 网关文件台账的管理面（2026-09-22）
// ---------------------------------------------------------------------------
//
// 需求：上游 Files 配额是**每 API key**（全组织共享），管理员需要"按员工看占用量、
// 能搜索、能排序、能清理"的工具。只读聚合与列表走 gateway:read，删除/清理走
// gateway:write（路由申报见 internal/router/router.go），全部动作写审计。

// 列表分页的三个数值：与 serverstore.normalizeGatewayFileQuery 的缺省/上限**同源**
// （那边把 Limit<=0 或 >200 都归一到 50；这里必须在**算出 offset 之前**用同一份
// 生效值，否则 size 缺省时 offset 恒为 0、分页静默失效）。
const (
	defaultGatewayFilePageSize = 50
	maxGatewayFilePageSize     = 200
	// maxGatewayFilePage 是页号上限。存在的唯一理由是防溢出：page 取 MaxInt64 时
	// (page-1)*size 会回绕成**负数**，被 DAO 的 `Offset < 0 ⇒ 0` 兜底成"第一页"
	// —— 越界页本该返回空集，却把第一页数据当成"最后一页"交给管理员。
	// 2^20 页 × 200 条 = 2 亿行，远超任何真实台账规模。
	maxGatewayFilePage = 1 << 20
)

// adminFileQuery 从查询参数解析过滤/排序/分页条件（数值/排序的非法值一律回落缺省）。
//
// `user=` 一律按**用户名**解，数字 ID 走 `user_id=`（审计 2026-09-22 R6 P1-B：
// 旧实现"先按 ID 解"⇒ 用户名恰好是数字时 `user=2` 会过滤到 id=2 的**另一个员工**、
// purge 更会删错人）。用户名查不到 ⇒ 空集（不退化成"不过滤"）。
//
// 唯一的例外是 `state`：**未知取值必须拒绝**（返回 ok=false），不能静默忽略 ——
// 静默忽略 = 过滤条件消失，管理员看着"已过期"的筛选结果实际是全量（与 purge
// 侧同一口径，见 purgeGatewayFilesAdmin 的注释）。
func adminFileQuery(c *gin.Context, db *sql.DB) (serverstore.GatewayFileQuery, bool) {
	q := serverstore.GatewayFileQuery{}
	if v := strings.TrimSpace(c.Query("user_id")); v != "" {
		if id, err := strconv.ParseInt(v, 10, 64); err == nil && id > 0 {
			q.UserID = id
		} else {
			q.UserID = -1
		}
	} else if v := strings.TrimSpace(c.Query("user")); v != "" {
		if uid, err := serverstore.GetUserByUsername(db, v); err == nil && uid != nil {
			q.UserID = uid.ID
		} else {
			q.UserID = -1
		}
	}
	q.Search = strings.TrimSpace(c.Query("q"))
	switch strings.TrimSpace(c.Query("state")) {
	case "", "all":
	case "expired":
		q.OnlyExpired = true
	case "active":
		q.OnlyActive = true
	default:
		return q, false
	}
	q.Sort = strings.TrimSpace(c.Query("sort"))
	q.Desc = c.Query("order") != "asc"
	size := defaultGatewayFilePageSize
	if n, err := strconv.Atoi(strings.TrimSpace(c.Query("size"))); err == nil && n > 0 {
		size = min(n, maxGatewayFilePageSize)
	}
	q.Limit = size
	page := 1
	if n, err := strconv.Atoi(strings.TrimSpace(c.Query("page"))); err == nil && n > 1 {
		page = min(n, maxGatewayFilePage)
	}
	q.Offset = (page - 1) * q.Limit // 与生效的 size 同源（缺省 size 时旧实现算出 0）
	return q, true
}

func listGatewayFilesAdmin(c *gin.Context, db *sql.DB) {
	q, ok := adminFileQuery(c, db)
	if !ok {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "state 只支持 active|expired|all")
		return
	}
	rows, total, err := serverstore.ListGatewayFiles(db, q)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件台账失败")
		return
	}
	files, bytes, expired, err := serverstore.GatewayFileTotals(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件台账失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"rows":  rows,
		"total": total,
		"totals": gin.H{
			"files":   files,
			"bytes":   bytes,
			"expired": expired,
		},
	})
}

func gatewayFilesSummaryAdmin(c *gin.Context, db *sql.DB) {
	rows, err := serverstore.GatewayFileSummary(db, strings.TrimSpace(c.Query("sort")), c.Query("order") != "asc")
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取占用汇总失败")
		return
	}
	files, bytes, expired, err := serverstore.GatewayFileTotals(db)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取占用汇总失败")
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"rows": rows,
		"totals": gin.H{
			"files":   files,
			"bytes":   bytes,
			"expired": expired,
		},
	})
}

func deleteGatewayFileAdmin(c *gin.Context, api *API, db *sql.DB) {
	fileID := strings.TrimSpace(c.Param("file_id"))
	if !validGatewayFileID(fileID) {
		writeFileNotFound(c, fileID)
		return
	}
	// 管理端按 id 删除**不看过期**（列表里的过期行同样有删除按钮；审计 2026-09-22
	// R6 P2 实测旧实现走 GatewayFileOwner ⇒ 过期行 404，管理员只能等回收器）。
	if exists, err := serverstore.GatewayFileRowExists(db, fileID); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取文件台账失败")
		return
	} else if !exists {
		writeFileNotFound(c, fileID)
		return
	}
	up, ok := fileUpstream(db)
	if !ok {
		serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "没有可用的文件上游")
		return
	}
	if err := deleteUpstreamFile(api.filesHTTPClient(), up, fileID); err != nil {
		log.Printf("gateway: admin delete file: upstream delete failed: %v", err)
		serverauth.WriteError(c, http.StatusBadGateway, "UPSTREAM", "上游删除失败，请稍后重试")
		return
	}
	if err := serverstore.DeleteGatewayFileRow(db, fileID); err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "删除台账行失败")
		return
	}
	_ = serverstore.AuditLog(db, auditActor(c), "gateway_file_delete", "file_id="+fileID)
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": 1})
}

// purgeGatewayFilesAdmin 按条件批量清理（上游删除 + 台账删行）。
//
// 安全边界：`user` 或 `state` **至少给一个**（不给就等于"清空全公司台账"，
// 必须走一次显式确认的入口，而不是一个空 body 就全网删除）；单次上限 500 条，
// 客户端可重复调用。
func purgeGatewayFilesAdmin(c *gin.Context, api *API, db *sql.DB) {
	var req struct {
		User        *string `json:"user"`
		UserID      *int64  `json:"user_id"`
		State       *string `json:"state"`
		ExpiredOnly *bool   `json:"expired_only"`
		Limit       *int    `json:"limit"`
	}
	if err := c.ShouldBindJSON(&req); err != nil && err != io.EOF {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "请求体错误")
		return
	}
	q := serverstore.GatewayFileQuery{}
	target := "all"
	if req.UserID != nil {
		// 显式给了 user_id 就必须是**正整数**：旧实现把 `<=0` 静默忽略 ⇒ 过滤条件
		// 消失、范围从"某个人"变成"全组织"（`{"user_id":0,"state":"expired"}` 会清掉
		// 全公司已过期文件）。列表侧同一口径（`?user_id=0` 落空集，fail-closed），
		// 这里选显式 400 —— 一个自己都不成立的 user_id 只可能是调用方写错了。
		if *req.UserID <= 0 {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
				"user_id 必须是正整数（用户名请用 user）")
			return
		}
		q.UserID = *req.UserID
		target = "user_id=" + strconv.FormatInt(*req.UserID, 10)
	} else if req.User != nil && strings.TrimSpace(*req.User) != "" {
		// `user` 一律用户名（数字用户名不会被当成 ID —— 删错人的根因，见 adminFileQuery）。
		v := strings.TrimSpace(*req.User)
		if uid, err := serverstore.GetUserByUsername(db, v); err == nil && uid != nil {
			q.UserID = uid.ID
		} else {
			serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "user 必须是存在的用户名（数字 ID 请用 user_id）")
			return
		}
		target = "user=" + v
	}
	// 状态过滤先归一到**一个**取值，再据此设过滤条件与审计范围。
	//
	// 为什么不能各写各的：`state` 与 `expired_only` 是同一件事的两种写法
	// （`{"state":"active","expired_only":true}` 完全可能出现），逐块追加会让审计
	// detail 写出"state=active state=expired"这种自相矛盾的范围 —— 事后无法据审计
	// 判断管理员到底清了什么。同时未知 state 必须显式拒绝（静默忽略 = 过滤条件
	// 消失、范围扩大），所以白名单校验必须排在最前。
	state := ""
	if req.State != nil {
		state = strings.TrimSpace(*req.State)
	}
	switch state {
	case "", "all", "expired", "active":
	default:
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "state 只支持 active|expired|all")
		return
	}
	// `expired_only=true` 是 `state=expired` 的等价写法（老前端/脚本用），优先级更高；
	// `state=active` 才是"清理仍然有效的文件"这条危险路径，必须显式给出。
	if req.ExpiredOnly != nil && *req.ExpiredOnly {
		state = "expired"
	}
	switch state {
	case "expired":
		q.OnlyExpired = true
		target += " state=expired"
	case "active":
		q.OnlyActive = true
		target += " state=active"
	}
	if q.UserID == 0 && !q.OnlyExpired && !q.OnlyActive {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION", "必须指定 user 或 state（避免误清全量台账）")
		return
	}
	// 删**有效**文件必须指名员工（审计 2026-09-22 R6 P1-D 实测：`{"state":"active"}`
	// 一个请求删掉全组织 6 个有效文件 + 上游对象）。用户 2026-09-22 确认"批量清理可以
	// 删有效文件"，但**范围必须收敛到某个人**；全组织范围只允许清"已过期"。
	if q.OnlyActive && q.UserID == 0 {
		serverauth.WriteError(c, http.StatusBadRequest, "VALIDATION",
			"清理仍然有效的文件必须指定员工（user 或 user_id）；全组织范围只允许清理已过期文件")
		return
	}
	limit := 0
	if req.Limit != nil {
		limit = *req.Limit
	}
	// 单次上限 500（文档口径）：更大请重复调用，避免一次请求在上游侧打太久。
	if limit <= 0 || limit > 500 {
		limit = 500
	}
	ids, err := serverstore.ListGatewayFilesForPurge(db, q, limit)
	if err != nil {
		serverauth.WriteError(c, http.StatusInternalServerError, "INTERNAL", "读取待清理文件失败")
		return
	}
	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": 0, "failed": 0, "matched": 0})
		return
	}
	up, ok := fileUpstream(db)
	if !ok {
		serverauth.WriteError(c, http.StatusServiceUnavailable, "SERVER", "没有可用的文件上游")
		return
	}
	client := api.filesHTTPClient()
	deleted, failed := 0, 0
	for _, id := range ids {
		if err := deleteUpstreamFile(client, up, id); err != nil {
			log.Printf("gateway: admin purge file: upstream delete failed: %v", err)
			failed++
			continue
		}
		if err := serverstore.DeleteGatewayFileRow(db, id); err != nil {
			log.Printf("gateway: admin purge file: delete ledger row failed: %v", err)
			failed++
			continue
		}
		deleted++
	}
	_ = serverstore.AuditLog(db, auditActor(c), "gateway_file_purge",
		fmt.Sprintf("%s 删除 %d 失败 %d 命中 %d", target, deleted, failed, len(ids)))
	c.JSON(http.StatusOK, gin.H{"ok": true, "deleted": deleted, "failed": failed, "matched": len(ids)})
}
