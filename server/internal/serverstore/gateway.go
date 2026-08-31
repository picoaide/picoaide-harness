package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

type GatewayProvider struct {
	ID        int64
	Name      string
	BaseURL   string
	APIKeyEnc string
	Models    []string
	Enabled   int
	Channel   string
	// Protocol 是上游 API 方言(0043):openai(默认,chat/embeddings)
	// 或 anthropic(/v1/messages 兼容端点)。模型路由按协议过滤,
	// 同一模型名可同时挂两种协议的 provider。
	Protocol string
}

type Model struct {
	ID            int64  `json:"id"`
	Name          string `json:"name"`
	ProviderID    int64  `json:"provider_id"`
	DisplayName   string `json:"display_name"`
	DefaultParams string `json:"default_params"`
	// InputPricePer1M / OutputPricePer1M 元/百万 token(0022);nil/0 = 未定价,
	// 费用按 0 计,页面标注「未定价」。embedding 复用 input 价。
	InputPricePer1M  *float64 `json:"input_price_per_1m"`
	OutputPricePer1M *float64 `json:"output_price_per_1m"`
	// CacheInputPricePer1M 缓存命中输入价(0029,元/百万 token);nil = 未配置
	// (计费按 input_price_per_1m,DeepSeek 官方缓存命中为输入价的 50% 左右)。
	CacheInputPricePer1M *float64 `json:"cache_input_price_per_1m"`
	// OffpeakDiscount 低谷折扣率(0023):nil/0/1 = 无峰谷价;0<d<1 = 空闲时段
	// (高峰窗口外;窗口配置见 settings usage.peak_windows,北京时间)费用 × d。
	OffpeakDiscount *float64 `json:"offpeak_discount"`
	// ProviderName / ProviderChannel / ProviderEnabled:上游信息(审计修复 M3)。
	// 管理端模型列表展示全部模型(含已停用上游的),仅客户端 /v1/models 过滤 enabled。
	ProviderName    string `json:"provider_name"`
	ProviderChannel string `json:"provider_channel"`
	ProviderEnabled bool   `json:"provider_enabled"`
}

// scanProvider 扫描 gateway_providers 一行。
// ---- 渠道同步模型排除名单(审计修复 H2)----
// 管理员在管理端删除的渠道同步模型记入该名单,定时同步不再自动恢复
// (否则被 SyncLoop 复活,且复活后价格被清空)。键:settings 中
// "gateway.excluded_models.<providerID>",值:JSON 数组。
const excludedModelsKeyPrefix = "gateway.excluded_models."

func excludedModelsKey(providerID int64) string {
	return excludedModelsKeyPrefix + strconv.FormatInt(providerID, 10)
}

// GetExcludedModels 返回某上游被排除同步的模型名(未配置时返回空,nil 错误)。
func GetExcludedModels(db *sql.DB, providerID int64) ([]string, error) {
	v, ok, err := GetSetting(db, excludedModelsKey(providerID))
	if err != nil || !ok || v == "" {
		return nil, err
	}
	var names []string
	if err := json.Unmarshal([]byte(v), &names); err != nil {
		return nil, err
	}
	return names, nil
}

// AddExcludedModel 把模型名加入排除名单(幂等)。
func AddExcludedModel(db *sql.DB, providerID int64, name string) error {
	names, err := GetExcludedModels(db, providerID)
	if err != nil {
		return err
	}
	for _, n := range names {
		if n == name {
			return nil
		}
	}
	names = append(names, name)
	b, _ := json.Marshal(names)
	return SetSetting(db, excludedModelsKey(providerID), string(b))
}

// RemoveExcludedModel 从排除名单移除模型名(幂等;名单清空后删除 setting)。
func RemoveExcludedModel(db *sql.DB, providerID int64, name string) error {
	names, err := GetExcludedModels(db, providerID)
	if err != nil {
		return err
	}
	out := names[:0]
	for _, n := range names {
		if n != name {
			out = append(out, n)
		}
	}
	if len(out) == 0 {
		_, err := db.Exec("DELETE FROM settings WHERE key = ?", excludedModelsKey(providerID))
		if err == nil {
			settingsCache.invalidateAll() // 直写 settings 需同步失效缓存
		}
		return err
	}
	b, _ := json.Marshal(out)
	return SetSetting(db, excludedModelsKey(providerID), string(b))
}

func scanProvider(scan interface{ Scan(...any) error }) (*GatewayProvider, error) {
	var p GatewayProvider
	var models string
	if err := scan.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKeyEnc, &models, &p.Enabled, &p.Channel, &p.Protocol); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(models), &p.Models)
	return &p, nil
}

// ListGatewayProviders returns all providers.
func ListGatewayProviders(db *sql.DB) ([]GatewayProvider, error) {
	rows, err := db.Query(`SELECT id, name, base_url, api_key_enc, models, enabled, channel, protocol
		FROM gateway_providers ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []GatewayProvider
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// GetGatewayProvider loads one provider.
func GetGatewayProvider(db *sql.DB, id int64) (*GatewayProvider, error) {
	row := db.QueryRow(`SELECT id, name, base_url, api_key_enc, models, enabled, channel, protocol
		FROM gateway_providers WHERE id = ?`, id)
	p, err := scanProvider(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// AddGatewayProvider inserts a provider; name conflicts return ErrDuplicate.
func AddGatewayProvider(db *sql.DB, p *GatewayProvider) (int64, error) {
	if p.Protocol == "" {
		p.Protocol = "openai" // 存量/未指定:默认 OpenAI 兼容(0043 迁移默认一致)
	}
	modelsJSON, _ := json.Marshal(p.Models)
	id, err := InsertID(db, `INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled, channel, protocol)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, p.Name, p.BaseURL, p.APIKeyEnc, string(modelsJSON), p.Enabled, p.Channel, p.Protocol)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	p.ID = id
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return p.ID, nil
}

// UpdateGatewayProvider updates all fields.
func UpdateGatewayProvider(db *sql.DB, p *GatewayProvider) error {
	if p.Protocol == "" {
		p.Protocol = "openai" // 空串不允许(列 CHECK),归一为默认
	}
	modelsJSON, _ := json.Marshal(p.Models)
	res, err := db.Exec(`UPDATE gateway_providers SET name=?, base_url=?, api_key_enc=?, models=?, enabled=?, channel=?, protocol=?
		WHERE id=?`, p.Name, p.BaseURL, p.APIKeyEnc, string(modelsJSON), p.Enabled, p.Channel, p.Protocol, p.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// DeleteGatewayProvider removes a provider (and its models);
// 若默认模型属于该 provider,同步重置 gateway.default_model。
func DeleteGatewayProvider(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.Query("SELECT name FROM models WHERE provider_id = ?", id)
	if err != nil {
		return err
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			rows.Close()
			return err
		}
		names = append(names, n)
	}
	rows.Close()
	if _, err := tx.Exec("DELETE FROM models WHERE provider_id = ?", id); err != nil {
		return err
	}
	res, err := tx.Exec("DELETE FROM gateway_providers WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	// 清理该上游的渠道同步排除名单(审计修复 H2)
	if _, err := tx.Exec("DELETE FROM settings WHERE key = ?", excludedModelsKey(id)); err != nil {
		return err
	}
	for _, name := range names {
		if err := clearDefaultModelIf(tx, name); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// 上游/models/settings 已变更:失效模型配置与服务端上游路由缓存
	InvalidateModelConfig()
	InvalidateSettings()
	InvalidateModelsChanged()
	return nil
}

// SyncProviderModels replaces the models table rows for a provider so it
// mirrors the provider's models JSON list. This keeps a single source of
// truth: the provider's model list is the model list the client sees.
// 重名模型按首次出现去重(UNIQUE(provider_id,name) 约束),避免半同步 + 500。
func SyncProviderModels(db *sql.DB, providerID int64, names []string) error {
	seen := make(map[string]bool, len(names))
	deduped := make([]string, 0, len(names))
	for _, name := range names {
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		deduped = append(deduped, name)
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM models WHERE provider_id = ?", providerID); err != nil {
		return err
	}
	for _, name := range deduped {
		if _, err := tx.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES (?, ?, ?)`,
			name, providerID, name); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// SyncProviderModel upsert 一个模型的 display_name 与 default_params(幂等)。
func SyncProviderModel(db *sql.DB, providerID int64, name, defaultParams string) error {
	_, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, default_params)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(provider_id, name) DO UPDATE SET display_name=excluded.display_name, default_params=excluded.default_params`,
		name, providerID, name, defaultParams)
	if err == nil {
		InvalidateModelConfig()
		InvalidateModelsChanged()
	}
	return err
}

// RemoveMissingProviderModels 删除 provider 下不在 keep 列表中的模型。
// 若被删的是 gateway.default_model,重置为空串。返回删除数量。
func RemoveMissingProviderModels(db *sql.DB, providerID int64, keep []string) (int, error) {
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	keepSet := make(map[string]bool, len(keep))
	for _, k := range keep {
		keepSet[k] = true
	}
	rows, err := tx.Query(`SELECT id, name FROM models WHERE provider_id = ?`, providerID)
	if err != nil {
		return 0, err
	}
	type row struct {
		id   int64
		name string
	}
	var doomed []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.name); err != nil {
			rows.Close()
			return 0, err
		}
		if !keepSet[r.name] {
			doomed = append(doomed, r)
		}
	}
	rows.Close()

	deletedDefault := false
	for _, r := range doomed {
		if _, err := tx.Exec("DELETE FROM models WHERE id = ?", r.id); err != nil {
			return 0, err
		}
		var dm string
		if err := tx.QueryRow("SELECT value FROM settings WHERE key = 'gateway.default_model'").Scan(&dm); err == nil && dm == r.name {
			deletedDefault = true
		}
	}
	if deletedDefault {
		if _, err := tx.Exec("UPDATE settings SET value = '' WHERE key = 'gateway.default_model'"); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	InvalidateModelConfig()
	InvalidateSettings()
	InvalidateModelsChanged()
	return len(doomed), nil
}

func scanModel(scan interface{ Scan(...any) error }) (*Model, error) {
	var m Model
	var in, out, cache, off sql.NullFloat64
	var pEnabled int
	if err := scan.Scan(&m.ID, &m.Name, &m.ProviderID, &m.DisplayName, &m.DefaultParams,
		&in, &out, &cache, &off, &m.ProviderName, &m.ProviderChannel, &pEnabled); err != nil {
		return nil, err
	}
	m.ProviderEnabled = pEnabled == 1
	if in.Valid {
		m.InputPricePer1M = &in.Float64
	}
	if out.Valid {
		m.OutputPricePer1M = &out.Float64
	}
	if cache.Valid {
		m.CacheInputPricePer1M = &cache.Float64
	}
	if off.Valid {
		m.OffpeakDiscount = &off.Float64
	}
	return &m, nil
}

// GetModel loads a model by id.
func GetModel(db *sql.DB, id int64) (*Model, error) {
	row := db.QueryRow(`SELECT m.id, m.name, m.provider_id, COALESCE(m.display_name, m.name),
		COALESCE(m.default_params, '{}'), m.input_price_per_1m, m.output_price_per_1m, m.cache_input_price_per_1m, m.offpeak_discount,
		p.name, p.channel, p.enabled
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id WHERE m.id = ?`, id)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// modelConfigTTL 模型配置缓存时长(30s):价格/default_params 由 webadmin
// 低频配置;热路径每条流式请求调 ModelPrices+ModelCachePrice+
// ModelDefaultParams 三次查询,缓存后 0 DB。
const modelConfigTTL = 30 * time.Second

var modelConfigCache = newTTLCache(modelConfigTTL)

// InvalidateModelConfig 使模型配置缓存失效(webadmin 改模型价格/参数时调用)。
func InvalidateModelConfig() { modelConfigCache.invalidateAll() }

// ModelDefaultParams loads a model's default_params by name.
func ModelDefaultParams(db *sql.DB, name string) (string, error) {
	if v := modelConfigCache.get(db, "dp:"+name); v != nil {
		return v.(string), nil
	}
	var params string
	err := db.QueryRow(`SELECT default_params FROM models WHERE name = ?`, name).Scan(&params)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	modelConfigCache.set(db, "dp:"+name, params)
	return params, err
}

// ModelPrices returns the yuan-per-1M-token input/output prices and the
// off-peak discount for a model name (0, 0, 0 when the model is missing or
// unpriced). Used to compute usage cost at record time (0022/0023).
func ModelPrices(db *sql.DB, name string) (inputPer1M, outputPer1M, offpeak float64) {
	if v := modelConfigCache.get(db, "price:"+name); v != nil {
		p := v.([3]float64)
		return p[0], p[1], p[2]
	}
	var in, out, off sql.NullFloat64
	err := db.QueryRow(`SELECT input_price_per_1m, output_price_per_1m, offpeak_discount FROM models WHERE name = ?`, name).Scan(&in, &out, &off)
	if err != nil {
		return 0, 0, 0
	}
	r := [3]float64{}
	if in.Valid {
		r[0] = in.Float64
	}
	if out.Valid {
		r[1] = out.Float64
	}
	if off.Valid {
		r[2] = off.Float64
	}
	modelConfigCache.set(db, "price:"+name, r)
	return r[0], r[1], r[2]
}

// ModelCachePrice returns the cache-hit input price (yuan per 1M tokens,
// 0029). 0 = 未配置缓存价(命中按输入价计费)。
func ModelCachePrice(db *sql.DB, name string) float64 {
	if v := modelConfigCache.get(db, "cache:"+name); v != nil {
		return v.(float64)
	}
	var cache sql.NullFloat64
	err := db.QueryRow(`SELECT cache_input_price_per_1m FROM models WHERE name = ?`, name).Scan(&cache)
	if err != nil || !cache.Valid {
		if err == nil {
			modelConfigCache.set(db, "cache:"+name, 0.0)
		}
		return 0
	}
	modelConfigCache.set(db, "cache:"+name, cache.Float64)
	return cache.Float64
}

// AddModel inserts a model row.
func AddModel(db *sql.DB, m *Model) (int64, error) {
	if m.DefaultParams == "" {
		m.DefaultParams = "{}"
	}
	id, err := InsertID(db, `INSERT INTO models (name, provider_id, display_name, default_params, input_price_per_1m, output_price_per_1m, cache_input_price_per_1m, offpeak_discount)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams,
		nilIfNilFloat64(m.InputPricePer1M), nilIfNilFloat64(m.OutputPricePer1M), nilIfNilFloat64(m.CacheInputPricePer1M), nilIfNilFloat64(m.OffpeakDiscount))
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	m.ID = id
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return m.ID, nil
}

// UpdateModel updates a model row.
func UpdateModel(db *sql.DB, m *Model) error {
	res, err := db.Exec(`UPDATE models SET name=?, provider_id=?, display_name=?, default_params=?, input_price_per_1m=?, output_price_per_1m=?, cache_input_price_per_1m=?, offpeak_discount=?
		WHERE id=?`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams,
		nilIfNilFloat64(m.InputPricePer1M), nilIfNilFloat64(m.OutputPricePer1M), nilIfNilFloat64(m.CacheInputPricePer1M), nilIfNilFloat64(m.OffpeakDiscount), m.ID)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// ModelHasUsage reports whether the model name has recorded usage rows.
// 改名防护(审计修复 M7):有用量记录的模型改名会破坏历史费用口径。
func ModelHasUsage(db *sql.DB, name string) (bool, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE model = ?`, name).Scan(&n)
	return n > 0, err
}

// DeleteModel removes a model;若被删模型是 gateway.default_model,重置为空串
// (与 RemoveMissingProviderModels 同口径,防 bootstrap 悬空指向已删模型)。
func DeleteModel(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var name string
	err = tx.QueryRow("SELECT name FROM models WHERE id = ?", id).Scan(&name)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	res, err := tx.Exec("DELETE FROM models WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	if err := clearDefaultModelIf(tx, name); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateModelConfig()
	InvalidateSettings()
	InvalidateModelsChanged()
	return nil
}

// clearDefaultModelIf 把指向指定模型名的 gateway.default_model 置空(事务内)。
func clearDefaultModelIf(tx *sql.Tx, name string) error {
	var dm string
	err := tx.QueryRow("SELECT value FROM settings WHERE key = 'gateway.default_model'").Scan(&dm)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if dm == name {
		if _, err := tx.Exec("UPDATE settings SET value = '' WHERE key = 'gateway.default_model'"); err != nil {
			return err
		}
	}
	return nil
}

// ListAdminModels returns all models with pricing/off-peak fields for the
// admin UI (webadmin 价格列/编辑弹窗数据源,0022/0023)。与公开 ListModels
// (仅基础字段)区分:价格/折扣属管理配置,不应从客户端可见端点泄露。
// 展示全部模型(含已停用上游的,审计修复 M3):管理页需能管理禁用上游的模型,
// 客户端可见性由 ListModels 的 WHERE p.enabled = 1 单独控制。
func ListAdminModels(db *sql.DB) ([]Model, error) {
	rows, err := db.Query(`SELECT m.id, m.name, m.provider_id, COALESCE(m.display_name, m.name),
		COALESCE(m.default_params, '{}'), m.input_price_per_1m, m.output_price_per_1m, m.cache_input_price_per_1m, m.offpeak_discount,
		p.name, p.channel, p.enabled
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id
		ORDER BY m.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Model
	for rows.Next() {
		m, err := scanModel(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *m)
	}
	return out, rows.Err()
}
