package serverstore

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
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
	// InputModalities 模型接受的输入模态(0058):'text'/'image'(客户端据此
	// 渲染图片支持; 空/非法 = 仅 text)。存储为 JSON 数组文本。
	InputModalities []string `json:"input_modalities"`
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
	// CatalogMissing 表示"该行已不在上游目录里"(0080,审计 2026-09-23 G-02):
	// 渠道同步发现目录缺失时**不再物理删除**带定价/参数的行,而是打这个标记 ——
	// 价格与管理员配置保留、路由与客户端目录按可用性过滤掉它;目录恢复时由
	// SyncProviderModel 清标记并把名字加回 provider JSON。管理端仍能看到该行
	// (带价格),便于判断"上游真的下架了"还是"目录抖动了一轮"。
	CatalogMissing bool `json:"catalog_missing"`
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

// AddExcludedModel 把模型名加入排除名单(幂等)。自开事务 + 提交后失效缓存,
// 语义与历史逐字一致;要与其它写库(删除模型行)同事务请用 AddExcludedModelTx。
func AddExcludedModel(db *sql.DB, providerID int64, name string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := AddExcludedModelTx(tx, providerID, name); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateSettings()
	return nil
}

// AddExcludedModelTx 在调用方事务内把模型名加入排除名单(幂等),返回"是否真的
// 改了"(名字已在名单里返回 (false, nil) 且不写库)。
//
// 2026-09-23(第三轮 §7.3 C):旧实现是「读名单(经 settings 缓存)→ append →
// SetSetting 整串覆写」三句各自 autocommit、中间没有任何锁 ⇒ 两个并发的
// DELETE /models/:id(同一渠道型上游的两个模型;双管理员或双击两行即可)各自
// 读到同一份旧名单、各自整串覆写,**后写者覆盖前写者**。丢掉的那一项 =
// 管理员显式删除的渠道模型不在排除名单里 ⇒ 下一轮渠道同步的
// RemoveMissingProviderModels 把它当"上游已下架"重新上架,webadmin 删除确认
// 文案承诺的「删除后同步不会自动恢复」被撤销。
//
// 修法与 RemoveExcludedModelTx 同口径(读-改-写必须在**事务快照 + 行锁**下),
// 并补上它没有的那一步:
//   - 先 `INSERT … ON CONFLICT (key) DO NOTHING` 保证名单行存在 —— settings.key
//     是主键,并发首次插入由唯一键裁决(后到者会等先到者提交/回滚),不会双写;
//   - 再用 `SELECT … FOR UPDATE` 钉住该行(见 excludedModelsTx)。行锁把
//     "读 → append → 写回"整段串起来,后到的调用者读到的是前者的结果。
//
// 返回 (changed, err) 让调用方能区分"真的加了"与"本来就在"(审计/日志口径)。
// 缓存:读**不经** settingsCache(缓存不参与事务),写走 SetSettingTx 且不失效
// 缓存 —— 调用方必须在 Commit 之后 InvalidateSettings()。
func AddExcludedModelTx(tx *sql.Tx, providerID int64, name string) (bool, error) {
	key := excludedModelsKey(providerID)
	if _, err := tx.Exec(`INSERT INTO settings (key, value) VALUES (?, '[]') ON CONFLICT (key) DO NOTHING`, key); err != nil {
		return false, err
	}
	names, err := excludedModelsTx(tx, providerID)
	if err != nil {
		return false, err
	}
	for _, n := range names {
		if n == name {
			return false, nil
		}
	}
	b, _ := json.Marshal(append(names, name))
	if err := SetSettingTx(tx, key, string(b)); err != nil {
		return false, err
	}
	return true, nil
}

// RemoveExcludedModelTx 在调用方事务内把模型名移出排除名单,返回"是否真的
// 改了"(幂等:不在名单里返回 (false, nil),且不写库)。
//
// 2026-09-19(P2-4 + N1):名单此前是**单向**的,而 webadmin 删除确认文案承诺
// 「删除后同步不会自动恢复,如需恢复请重新添加」—— 实测重新添加的模型会在
// 下一轮同步被 RemoveMissingProviderModels 再删一次(它不在上游目录的 keep
// 列表里),管理员的显式意图被自动同步撤销。修法 = 管理端"重新添加"渠道模型时
// 移出该名(见 llmgateway/admin.go createModel)。
//
// 为什么只有事务版(2026-09-19 第三轮审计后:**刻意不提供 autocommit 版**):
// "移名单 + 建模型行"必须原子 —— 旧实现两步各自 autocommit,建行失败(500)或
// 撞重名(400)时名单已经被清空,下一个同步轮次就把管理员显式删除的渠道模型
// 复活(H2 保护被一次失败请求撤销)。只留事务版 ⇒ 调用方不可能漏掉这一步。
//
// 名单读的是**事务内**的 settings 行(不走 settingsCache:缓存不参与事务,
// 读-改-写必须以事务快照为准;2026-09-23 起该读还带 `FOR UPDATE` 行锁 ——
// 与 AddExcludedModelTx 共用 excludedModelsTx,两个方向的读-改-写都被串行化);
// 写走 SetSettingTx,**不失效缓存**,提交后由调用方 InvalidateSettings()。
func RemoveExcludedModelTx(tx *sql.Tx, providerID int64, name string) (bool, error) {
	names, err := excludedModelsTx(tx, providerID)
	if err != nil {
		return false, err
	}
	kept, changed := removeExcludedName(names, name)
	if !changed {
		return false, nil
	}
	b, _ := json.Marshal(kept)
	if err := SetSettingTx(tx, excludedModelsKey(providerID), string(b)); err != nil {
		return false, err
	}
	return true, nil
}

// excludedModelsTx 在事务内直读排除名单(语义与 GetExcludedModels 一致:
// 键不存在或空串 = 空名单,JSON 解析失败 = 错误,只是不经过 settings 缓存)。
//
// 2026-09-23(第三轮 §7.3 C):读**必须带 `FOR UPDATE`** —— 本函数只有两个调用方
// (AddExcludedModelTx 加名字 / RemoveExcludedModelTx 移名字),两者都是
// "读-改-写整串覆写":不加行锁时并发的加/移各自基于同一份旧快照覆写,后写者
// 静默覆盖前写者(删除丢项 ⇒ 下一轮渠道同步把管理员删掉的模型复活)。
// 行不存在时 `FOR UPDATE` 锁不到东西,但这不构成漏洞:名单行的创建只在
// AddExcludedModelTx 里、由 `INSERT … ON CONFLICT (key) DO NOTHING` 先做过
// (唯一键裁决),拿到行锁后的读一定看得到那一次插入的结果。
func excludedModelsTx(tx *sql.Tx, providerID int64) ([]string, error) {
	var v string
	err := tx.QueryRow(`SELECT value FROM settings WHERE key = ? FOR UPDATE`, excludedModelsKey(providerID)).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && v == "") {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var names []string
	if err := json.Unmarshal([]byte(v), &names); err != nil {
		return nil, err
	}
	return names, nil
}

// removeExcludedName 从名单里删掉一个名字,返回新名单与"是否真的删掉了"。
// 唯一实现(kept 始终是非 nil 切片 ⇒ 移空时 json.Marshal 得到 `[]` 而不是
// `null`,与"键不存在"同解但可自证已处理)。
func removeExcludedName(names []string, name string) ([]string, bool) {
	kept := make([]string, 0, len(names))
	changed := false
	for _, n := range names {
		if n == name {
			changed = true
			continue
		}
		kept = append(kept, n)
	}
	return kept, changed
}

// 说明:名单是**双向**的(2026-09-19 起)——删除渠道同步模型进名单,此后同步
// 不会把它带回来(webadmin Gateway 页文案:「删除后同步不会自动恢复,如需恢复
// 请重新添加」);管理端**显式重新添加**同名渠道模型时由 createModel 在**同一
// 事务**里调用 RemoveExcludedModelTx 移出名单(显式意图优先于自动同步),删除
// provider 时整键清理。此前"单向、无移出接口"的注释已过期;autocommit 版移出
// 接口已删除(只留事务版,调用方无法把这一步与建模型行拆开)。

func scanProvider(scan interface{ Scan(...any) error }) (*GatewayProvider, error) {
	var p GatewayProvider
	var models string
	if err := scan.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKeyEnc, &models, &p.Enabled, &p.Channel, &p.Protocol); err != nil {
		return nil, err
	}
	_ = json.Unmarshal([]byte(models), &p.Models)
	return &p, nil
}

// gatewayProviderColumns 是 gateway_providers 的读列清单(唯一一份实现):
// ListGatewayProviders / GetGatewayProvider / GetGatewayProviderTx 共用,
// 避免"某个入口漏读一列 ⇒ scanProvider 静默拿到零值"。
const gatewayProviderColumns = `id, name, base_url, api_key_enc, models, enabled, channel, protocol`

// ListGatewayProviders returns all providers.
func ListGatewayProviders(db *sql.DB) ([]GatewayProvider, error) {
	// R13-GE（V2-2 读面收口）：族内读面 —— 池上入口走已钉 search_path 的只读事务。
	rd, err := newUsageReadConn(db)
	if err != nil {
		return nil, err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	rows, err := rd.Query(`SELECT ` + gatewayProviderColumns + `
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
	// R13-GE（V2-2 读面收口）：族内读面 —— 池上入口走已钉 search_path 的只读事务。
	rd, err := newUsageReadConn(db)
	if err != nil {
		return nil, err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	row := rd.QueryRow(`SELECT `+gatewayProviderColumns+`
		FROM gateway_providers WHERE id = ?`, id)
	p, err := scanProvider(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// GetGatewayProviderTx 在调用方事务内读一个 provider。
//
// 2026-09-23(第三轮 §7.3 B):`forUpdate=true` 时用 `SELECT … FOR UPDATE` 取行锁
// —— 管理端 PUT /providers/:id 必须把**基线读取**也放进事务(并在锁下读),
// 否则"事务外读快照 → 事务内整行写回"之间别的写者提交的字段(轮换后的密钥/
// 改名/清单)会被这份过期快照覆盖:并发改名能把刚轮换的密钥写回旧密文。
// 行锁同时让"读基线 → 计算 → 写回 → 审计"整段串行,后到者基于前者的结果。
//
// 语义与非事务版逐字一致(ErrNotFound / 列清单 / scanProvider),不取锁时
// (forUpdate=false)与 GetGatewayProvider 等价,只是走事务连接。
func GetGatewayProviderTx(tx *sql.Tx, id int64, forUpdate bool) (*GatewayProvider, error) {
	q := `SELECT ` + gatewayProviderColumns + ` FROM gateway_providers WHERE id = ?`
	if forUpdate {
		q += ` FOR UPDATE`
	}
	p, err := scanProvider(tx.QueryRow(q, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// AddGatewayProvider inserts a provider; name conflicts return ErrDuplicate.
func AddGatewayProvider(db *sql.DB, p *GatewayProvider) (int64, error) {
	id, err := insertProvider(func(query string, args ...any) (int64, error) {
		return InsertID(db, query, args...)
	}, p)
	if err != nil {
		return 0, err
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return id, nil
}

// AddGatewayProviderTx 在调用方事务内插入 provider 行,返回新行 id
// (name 冲突 → ErrDuplicate,语义与 AddGatewayProvider 一致)。
//
// **不失效缓存**:事务可能回滚,失效只能在 Commit 之后由调用方做
// (与 AddModelTx / UpdateGatewayProviderTx 同一纪律)。管理端 POST /providers
// 需要把「插行 + 手动型清单同步 + 审计」放进同一个事务,故有此变体。
func AddGatewayProviderTx(tx *sql.Tx, p *GatewayProvider) (int64, error) {
	return insertProvider(func(query string, args ...any) (int64, error) {
		return InsertIDTx(tx, query, args...)
	}, p)
}

// insertProvider 是 provider INSERT 的唯一实现(AddGatewayProvider /
// AddGatewayProviderTx 共用):只写库 + 回填 p.ID + 把唯一键冲突归一为
// ErrDuplicate;缓存失效由调用方按"提交后"语义决定。
func insertProvider(insert insertFunc, p *GatewayProvider) (int64, error) {
	if p.Protocol == "" {
		p.Protocol = "openai" // 存量/未指定:默认 OpenAI 兼容(0043 迁移默认一致)
	}
	modelsJSON, _ := json.Marshal(p.Models)
	id, err := insert(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled, channel, protocol)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, p.Name, p.BaseURL, p.APIKeyEnc, string(modelsJSON), p.Enabled, p.Channel, p.Protocol)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	p.ID = id
	return id, nil
}

// UpdateGatewayProvider updates all fields.
//
// 2026-09-23(P0-2):真正的写入逻辑在 UpdateGatewayProviderTx —— 管理端 PUT
// /providers/:id 必须把「provider 行写入(含密钥轮换)」与「模型清单同步」放在
// **同一个事务**里,否则清单同步失败会留下"密钥已轮换、管理端以为失败"的半提交。
// 本函数保留为「自开事务 + 提交后失效缓存」的兼容入口(行为与历史逐字一致)。
func UpdateGatewayProvider(db *sql.DB, p *GatewayProvider) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := UpdateGatewayProviderTx(tx, p); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// UpdateGatewayProviderTx 是 UpdateGatewayProvider 的**事务内**版本:只写行,
// 不失效缓存 —— 失效必须发生在调用方 Commit **之后**,否则并发读者会在事务
// 提交前把旧值重新灌进进程缓存,提交后缓存就一直是脏的。
func UpdateGatewayProviderTx(tx *sql.Tx, p *GatewayProvider) error {
	if p.Protocol == "" {
		p.Protocol = "openai" // 空串不允许(列 CHECK),归一为默认
	}
	modelsJSON, _ := json.Marshal(p.Models)
	res, err := tx.Exec(`UPDATE gateway_providers SET name=?, base_url=?, api_key_enc=?, models=?, enabled=?, channel=?, protocol=?
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
	return nil
}

// DeleteGatewayProvider removes a provider (and its models);
// 若默认模型属于该 provider,同步重置 gateway.default_model。
func DeleteGatewayProvider(db *sql.DB, id int64) error {
	// R13-GE（V2-2）：族内关系（gateway_providers / models / settings）的池上写事务
	// 一律经唯一实现 usageWriteTx（BEGIN + SET LOCAL search_path = public 同源）。
	tx, err := usageWriteTx(db)
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

// SyncProviderModels makes the models table rows mirror the provider's models
// JSON list (single source of truth: the provider's model list is the model
// list the client sees).
//
// 2026-09-23(审计 G-01,P0):实现是**按 name upsert + 只剪枝清单外的行**,与
// SyncProviderModel 同语义 —— 命中既有行时只更新 display_name 与"目录缺失"
// 标记,**绝不覆盖/清空**价格、缓存价、峰谷折扣、default_params 与
// input_modalities。旧实现是「DELETE 该 provider 全部行 + 只插三列」,于是
// webadmin 的「编辑上游 → 保存」(弹窗无条件回传预填清单)一次就把该上游全部
// 定价清零;此后调用照常 200、token 照记、cost=0,且不留任何审计痕迹。
//
// 剪枝本身保持物理删除:那是**管理员显式**把名字从清单里删掉(含渠道型切回
// 手动型时的清空),显式意图必须让路由立刻不再匹配该模型。目录抖动触发的
// "目录缺失"走 RemoveMissingProviderModels 的标记路径,两者不要混。
//
// 重名模型按首次出现去重(UNIQUE(provider_id,name) 约束),避免半同步 + 500。
//
// 2026-09-23(P0-2):写入逻辑在 SyncProviderModelsTx —— 管理端 PUT /providers/:id
// 要把它与 provider 行写入放进同一个事务。本函数保留为「自开事务 + 提交后失效
// 缓存与告警」的兼容入口(行为与历史逐字一致)。
func SyncProviderModels(db *sql.DB, providerID int64, names []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	prunedPriced, err := SyncProviderModelsTx(tx, providerID, names)
	if err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	LogPrunedPricedModels(providerID, prunedPriced)
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// LogPrunedPricedModels 为「清单更新移除了带定价/参数的行」打一条可检索告警
// (审计 G-01 的"零痕迹"问题:此前连审计都没有)。**必须在事务提交后调用** ——
// 事务内打日志会在回滚时留下"删了带定价的行"的假告警。
func LogPrunedPricedModels(providerID int64, prunedPriced []string) {
	if len(prunedPriced) == 0 {
		return
	}
	log.Printf("gateway: WARNING provider=%d 模型清单更新移除了 %d 个带定价/参数的行: %s",
		providerID, len(prunedPriced), strings.Join(prunedPriced, ","))
}

// SyncProviderModelsTx 是 SyncProviderModels 的**事务内**版本:把 provider 的
// 模型清单同步进 models 表,但不提交、不失效缓存、不打告警 —— 这三件事都归调用
// 方在 Commit 之后做(事务内失效缓存会让并发读者把未提交的旧值灌回进程缓存)。
// 返回值是被剪枝且带运营方配置(价格/参数/模态)的模型名,供调用方提交后告警。
func SyncProviderModelsTx(tx *sql.Tx, providerID int64, names []string) ([]string, error) {
	seen := make(map[string]bool, len(names))
	deduped := make([]string, 0, len(names))
	for _, name := range names {
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		deduped = append(deduped, name)
	}
	keep := make(map[string]bool, len(deduped))
	for _, name := range deduped {
		keep[name] = true
	}
	// ① upsert:既有行只动 display_name 与目录缺失标记(写进清单即"要它可用"),
	//    价格/参数/模态一律保留。
	for _, name := range deduped {
		if _, err := tx.Exec(`INSERT INTO models (name, provider_id, display_name) VALUES (?, ?, ?)
			ON CONFLICT (provider_id, name) DO UPDATE
			SET display_name = excluded.display_name, catalog_missing = FALSE`,
			name, providerID, name); err != nil {
			return nil, err
		}
	}
	// ② 剪枝:只删不在清单里的行(含此前被标记 catalog_missing 的行 —— 管理员
	//    重新给出清单就是最终口径)。
	rows, err := providerModelRowsTx(tx, providerID)
	if err != nil {
		return nil, err
	}
	var prunedPriced []string
	for _, r := range rows {
		if keep[r.Name] {
			continue
		}
		if _, err := tx.Exec("DELETE FROM models WHERE id = ?", r.ID); err != nil {
			return nil, err
		}
		if r.HasOperatorConfig {
			prunedPriced = append(prunedPriced, r.Name)
		}
	}
	return prunedPriced, nil
}

// modelRowBrief 是同步路径关心的最小行信息(剪枝与"目录缺失"判定共用)。
type modelRowBrief struct {
	ID   int64
	Name string
	// HasOperatorConfig = 该行带运营方配置(价格/缓存价/峰谷折扣/default_params/
	// input_modalities 任一被配置过)。目录抖动时这种行绝不物理删除(G-02)。
	HasOperatorConfig bool
	CatalogMissing    bool
}

// providerModelRowsTx 读 provider 下全部模型行的同步视图(事务内)。
func providerModelRowsTx(tx *sql.Tx, providerID int64) ([]modelRowBrief, error) {
	rows, err := tx.Query(`SELECT id, name, input_price_per_1m, output_price_per_1m,
		cache_input_price_per_1m, offpeak_discount, COALESCE(default_params, ''),
		COALESCE(input_modalities, '["text"]'), catalog_missing
		FROM models WHERE provider_id = ?`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []modelRowBrief{}
	for rows.Next() {
		var r modelRowBrief
		var in, outPrice, cache, off sql.NullFloat64
		var params, modalities string
		if err := rows.Scan(&r.ID, &r.Name, &in, &outPrice, &cache, &off, &params, &modalities, &r.CatalogMissing); err != nil {
			return nil, err
		}
		r.HasOperatorConfig = hasOperatorModelConfig(in, outPrice, cache, off, params, modalities)
		out = append(out, r)
	}
	return out, rows.Err()
}

// hasOperatorModelConfig 判断一行是否带"运营方配置"。价格类字段非 NULL(含
// 显式 0 = 管理员定的"未定价")、default_params 非空且非 '{}'、input_modalities
// 非默认值,任一成立即为真。
func hasOperatorModelConfig(in, out, cache, off sql.NullFloat64, params, modalities string) bool {
	if in.Valid || out.Valid || cache.Valid || off.Valid {
		return true
	}
	if p := strings.TrimSpace(params); p != "" && p != "{}" {
		return true
	}
	return strings.TrimSpace(modalities) != `["text"]`
}

// SyncProviderModel upsert 一个模型的 display_name 与 default_params(幂等)。
// P2-18:已存在的行只更新 display_name——default_params 与 input_modalities
// 同语义,是管理员配置(如 concurrency_target),渠道同步不得覆盖清空;
// 只有新行才写入同步给出的默认参数。
//
// 2026-09-23(审计 G-02):同名行若上一轮被标记 catalog_missing(上游目录抖动
// 时的"停用"),本轮命中即视为**重新出现在上游目录** —— 清标记并把名字加回
// provider JSON(RemoveMissingProviderModels 曾把它移出),价格与参数分毫不动。
func SyncProviderModel(db *sql.DB, providerID int64, name, defaultParams string) error {
	tx, err := usageWriteTx(db) // R13-GE（V2-2）：族内写事务唯一实现
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var wasMissing bool
	err = tx.QueryRow(`SELECT catalog_missing FROM models WHERE provider_id = ? AND name = ?`,
		providerID, name).Scan(&wasMissing)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO models (name, provider_id, display_name, default_params)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(provider_id, name) DO UPDATE
		SET display_name = excluded.display_name, catalog_missing = FALSE`,
		name, providerID, name, defaultParams); err != nil {
		return err
	}
	if wasMissing {
		if err := addProviderModelName(tx, providerID, name); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if wasMissing {
		log.Printf("gateway: provider=%d 模型 %s 已回到上游目录,清除 catalog_missing(定价与参数保留)", providerID, name)
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return nil
}

// RemoveMissingProviderModels 处理 provider 下不在上游目录 keep 列表里的行。
//
// 2026-09-23(审计 G-02,P1):上游 /models 目录**部分抖动**(一轮超时/降级/返回
// 子集)不得摧毁运营方配置 ——
//   - 仍带定价/参数的行:只标记 catalog_missing = TRUE(停用),价格/参数/模态
//     全部保留,下一轮目录恢复时由 SyncProviderModel 清标记复原;
//   - 不带任何运营方配置的行:按旧行为物理删除(丢的只是上游目录信息);
//   - 两条路径都必须把名字从 provider 的 models JSON 移除:路由用的是
//     「JSON ∪ models 表」,行还在(停用)时也必须让路由侧看不到它,否则会路由到
//     一个上游目录里已不存在的模型;
//   - 停用/删除带定价的行必须打一条可检索的 warning(含 provider id 与模型名)。
//
// 已标记的行不重复处理(幂等:同一轮抖动重复触发只计一次)。若被处理的行正是
// gateway.default_model,重置为空串。返回"不再可路由的行数"(停用 + 删除)。
func RemoveMissingProviderModels(db *sql.DB, providerID int64, keep []string) (int, error) {
	tx, err := usageWriteTx(db) // R13-GE（V2-2）：族内写事务唯一实现
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	keepSet := make(map[string]bool, len(keep))
	for _, k := range keep {
		keepSet[k] = true
	}
	rows, err := providerModelRowsTx(tx, providerID)
	if err != nil {
		return 0, err
	}
	var doomed []modelRowBrief
	for _, r := range rows {
		if keepSet[r.Name] || r.CatalogMissing {
			continue
		}
		doomed = append(doomed, r)
	}

	deletedDefault := false
	var disabledPriced []string
	for _, r := range doomed {
		if r.HasOperatorConfig {
			if _, err := tx.Exec("UPDATE models SET catalog_missing = TRUE WHERE id = ?", r.ID); err != nil {
				return 0, err
			}
			disabledPriced = append(disabledPriced, r.Name)
		} else if _, err := tx.Exec("DELETE FROM models WHERE id = ?", r.ID); err != nil {
			return 0, err
		}
		// 2026-09-08(P1-8 同类):渠道同步删行时也必须从 provider 的 models JSON
		// 移除该名,否则路由仍匹配到它而 models 表无价 → 可调用且 cost=0。
		if err := removeProviderModelName(tx, providerID, r.Name); err != nil {
			return 0, err
		}
		var dm string
		if err := tx.QueryRow("SELECT value FROM settings WHERE key = 'gateway.default_model'").Scan(&dm); err == nil && dm == r.Name {
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
	if len(disabledPriced) > 0 {
		log.Printf("gateway: WARNING provider=%d 上游目录中缺少 %d 个带定价/参数的模型,已标记 catalog_missing(定价与参数保留,路由与客户端目录已排除): %s",
			providerID, len(disabledPriced), strings.Join(disabledPriced, ","))
	}
	InvalidateModelConfig()
	InvalidateSettings()
	InvalidateModelsChanged()
	return len(doomed), nil
}

// validInputModality 校验单个模态值。
func validInputModality(m string) bool { return m == "text" || m == "image" }

// NormalizeInputModalities 归一化输入模态:非法/空值过滤,去重,空结果回落
// 仅 text(与数据库默认/客户端 schema 缺省一致)。
func NormalizeInputModalities(raw []string) []string {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, m := range raw {
		if !validInputModality(m) || seen[m] {
			continue
		}
		seen[m] = true
		out = append(out, m)
	}
	if len(out) == 0 {
		return []string{"text"}
	}
	return out
}

// ParseInputModalities 解析 models.input_modalities 列(JSON 文本数组;
// 空/非法 = 仅 text)。
func ParseInputModalities(raw string) []string {
	if raw == "" {
		return []string{"text"}
	}
	var out []string
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return []string{"text"}
	}
	return NormalizeInputModalities(out)
}

func scanModel(scan interface{ Scan(...any) error }) (*Model, error) {
	var m Model
	var in, out, cache, off sql.NullFloat64
	var pEnabled int
	var modalities string
	if err := scan.Scan(&m.ID, &m.Name, &m.ProviderID, &m.DisplayName, &m.DefaultParams, &modalities,
		&in, &out, &cache, &off, &m.CatalogMissing, &m.ProviderName, &m.ProviderChannel, &pEnabled); err != nil {
		return nil, err
	}
	m.InputModalities = ParseInputModalities(modalities)
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

// modelSelectColumns 是"模型 + 所属上游"的最小读列清单(唯一一份实现):
// GetModel / GetModelTx / ListAdminModels 共用。
const modelSelectColumns = `m.id, m.name, m.provider_id, COALESCE(m.display_name, m.name),
		COALESCE(m.default_params, '{}'), COALESCE(m.input_modalities, '["text"]'),
		m.input_price_per_1m, m.output_price_per_1m, m.cache_input_price_per_1m, m.offpeak_discount,
		m.catalog_missing, p.name, p.channel, p.enabled`

// GetModel loads a model by id.
func GetModel(db *sql.DB, id int64) (*Model, error) {
	// R13-GE（V2-2 读面收口）：族内读面 —— 池上入口走已钉 search_path 的只读事务。
	rd, err := newUsageReadConn(db)
	if err != nil {
		return nil, err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	row := rd.QueryRow(`SELECT `+modelSelectColumns+`
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id WHERE m.id = ?`, id)
	m, err := scanModel(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return m, err
}

// GetModelTx 在调用方事务内按 id 读模型(语义与 GetModel 逐字一致)。
//
// 2026-09-23(第三轮 §7.3 C):`forUpdate=true` 时对模型行取 `FOR UPDATE` 锁 ——
// 管理端 DELETE /models/:id 要"读该行(名字/所属上游/是否渠道型)→ 写排除名单 →
// 删行"整段原子,基线读必须在锁下,否则并发删除同一行时第二次读到的状态可能
// 与真正删掉的那一行不一致。
func GetModelTx(tx *sql.Tx, id int64, forUpdate bool) (*Model, error) {
	q := `SELECT ` + modelSelectColumns + `
		FROM models m JOIN gateway_providers p ON p.id = m.provider_id WHERE m.id = ?`
	if forUpdate {
		q += ` FOR UPDATE OF m`
	}
	m, err := scanModel(tx.QueryRow(q, id))
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
//
// N-4(2026-09-23,P3):与路由同口径排除 catalog_missing = TRUE 的行(见
// llmgateway/upstream.go 的 syncedModelNames 与 llmgateway/models.go 的
// ListModels)。该过滤只影响不可达路径(能走到这里说明路由已成功,即该名下至少
// 有一行非缺失),但把"只剩目录缺失行"的退化情形钉成"未找到"(调用方回落 128K
// 补估上限),而不是把已停用行的参数当生效配置 —— 将来若有人把本函数接到管理端
// 预览或 bootstrap 兜底路径上,也不会重现"停用行仍参与取参"。
//
// R4-C-3(审计 2026-09-23,P2):同名模型出现在多个 provider 时,必须与两个同族
// 函数(ModelPrices / ModelCachePrice)**逐字同序**取参 —— 追加同样的
// `ORDER BY provider_id LIMIT 1`。没有它,返回的是 PG 结果集的第一行(堆序):
// 一次语义中性的 UPDATE 就能让返回值在 A 家 {context_length:4096} 与 B 家
// {context_length:900000} 之间翻转;而本函数唯一的消费者是 llmgateway 的
// promptEstimateCapForModel(上游漏报 usage 时的**输入侧补估上限**),于是同一条
// 请求的补估 token 数与费用可以差两个数量级,并与同族取价函数的口径分叉
// (30s 的 modelConfigCache 只是把"这一次碰巧读到的那一份"钉住,放大可见性而非修复)。
// R13-GE（V2-2 读面收口）：取价 / 取参 / 取缓存价这一族是**族内读面**，池上入口
// 一律走"已钉 search_path 的只读事务"唯一实现（`usageReadConn` / `withUsageSearchPathRead`）。
// 旧实现是裸 `db.QueryRow` ⇒ shadow schema 在场时读到 shadow 的价目（真 PG 实测
// in=1000/out=2000，而 public 是 1.0/2.0），而结算金额落进 **public 行**（少收/多收
// 都可能，`err=nil`，所有健康出口报绿）。`*Q` 变体是这些函数的**唯一语句实现**：
// q 是已钉事务的语句入口，scope 只用于 TTL 缓存的作用域绑定（缓存按原池绑定，
// 钉 search_path 不改变缓存语义）。
func ModelDefaultParams(db *sql.DB, name string) (string, error) {
	rd, err := newUsageReadConn(db)
	if err != nil {
		return "", err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	return modelDefaultParamsQ(rd, db, name)
}

func modelDefaultParamsQ(q rowQuerier, scope *sql.DB, name string) (string, error) {
	if v := modelConfigCache.get(scope, "dp:"+name); v != nil {
		return v.(string), nil
	}
	var params string
	err := q.QueryRow(`SELECT default_params FROM models WHERE name = ? AND catalog_missing = FALSE ORDER BY provider_id LIMIT 1`, name).Scan(&params)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	modelConfigCache.set(scope, "dp:"+name, params)
	return params, err
}

// ModelPrices returns the yuan-per-1M-token input/output prices and the
// off-peak discount for a model name (0, 0, 0 when the model is missing or
// unpriced). Used to compute usage cost at record time (0022/0023).
//
// N-4(2026-09-23):这里**故意不加** catalog_missing = FALSE —— 本函数是
// provider 维度取价失败时的**兜底**(历史行 provider_id=0、行被迁移/删除),
// 此时唯一比"用停用行的价"更差的选项就是"返回 0"(= 免费)。取参/取缓存价的
// 退化方向是安全的(未找到 ⇒ 回落默认窗口 / 回落输入价),取价不是。
func ModelPrices(db *sql.DB, name string) (inputPer1M, outputPer1M, offpeak float64) {
	rd, err := newUsageReadConn(db)
	if err != nil {
		return 0, 0, 0
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	return modelPricesQ(rd, db, name)
}

func modelPricesQ(q rowQuerier, scope *sql.DB, name string) (inputPer1M, outputPer1M, offpeak float64) {
	if v := modelConfigCache.get(scope, "price:"+name); v != nil {
		p := v.([3]float64)
		return p[0], p[1], p[2]
	}
	var in, out, off sql.NullFloat64
	// P1-6:同名多 provider 时必须确定性取价(物理行序会随 UPSERT 漂移)。
	err := q.QueryRow(`SELECT input_price_per_1m, output_price_per_1m, offpeak_discount FROM models WHERE name = ? ORDER BY provider_id LIMIT 1`, name).Scan(&in, &out, &off)
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
	modelConfigCache.set(scope, "price:"+name, r)
	return r[0], r[1], r[2]
}

// ModelPricesForProvider 按**实际命中的 provider** 取价(P1-6,审计 2026-09-13):
// 优先 (provider_id, name);该组合不存在(模型被迁移/删除)或 providerID==0
// (历史行)时回退到 name 口径(ModelPrices 自身已带确定性排序,不再随物理行序漂移)。
func ModelPricesForProvider(db *sql.DB, providerID int64, name string) (inputPer1M, outputPer1M, offpeak float64) {
	rd, err := newUsageReadConn(db)
	if err != nil {
		// 与 ModelPrices 的失败语义同形（取价失败 ⇒ 0 = 不加价，由调用方照旧落账）
		return 0, 0, 0
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	return modelPricesForProviderQ(rd, db, providerID, name)
}

func modelPricesForProviderQ(q rowQuerier, scope *sql.DB, providerID int64, name string) (inputPer1M, outputPer1M, offpeak float64) {
	if providerID <= 0 {
		return modelPricesQ(q, scope, name)
	}
	key := fmt.Sprintf("pprice:%d:%s", providerID, name)
	if v := modelConfigCache.get(scope, key); v != nil {
		p := v.([3]float64)
		return p[0], p[1], p[2]
	}
	var in, out, off sql.NullFloat64
	err := q.QueryRow(`SELECT input_price_per_1m, output_price_per_1m, offpeak_discount
		FROM models WHERE provider_id = ? AND name = ?`, providerID, name).Scan(&in, &out, &off)
	if errors.Is(err, sql.ErrNoRows) {
		return modelPricesQ(q, scope, name) // 该 provider 下无此模型行 → 回退 name 口径
	}
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
	modelConfigCache.set(scope, key, r)
	return r[0], r[1], r[2]
}

// ModelCachePriceForProvider 是 ModelCachePrice 的 provider 维度版本(P1-6)。
func ModelCachePriceForProvider(db *sql.DB, providerID int64, name string) float64 {
	rd, err := newUsageReadConn(db)
	if err != nil {
		return 0
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	return modelCachePriceForProviderQ(rd, db, providerID, name)
}

func modelCachePriceForProviderQ(q rowQuerier, scope *sql.DB, providerID int64, name string) float64 {
	if providerID <= 0 {
		return modelCachePriceQ(q, scope, name)
	}
	key := fmt.Sprintf("pcache:%d:%s", providerID, name)
	if v := modelConfigCache.get(scope, key); v != nil {
		return v.(float64)
	}
	var cache sql.NullFloat64
	err := q.QueryRow(`SELECT cache_input_price_per_1m FROM models WHERE provider_id = ? AND name = ?`,
		providerID, name).Scan(&cache)
	if errors.Is(err, sql.ErrNoRows) {
		return modelCachePriceQ(q, scope, name)
	}
	if err != nil || !cache.Valid {
		return 0
	}
	modelConfigCache.set(scope, key, cache.Float64)
	return cache.Float64
}

// ModelCachePrice returns the cache-hit input price (yuan per 1M tokens,
// 0029). 0 = 未配置缓存价(命中按输入价计费)。
func ModelCachePrice(db *sql.DB, name string) float64 {
	rd, err := newUsageReadConn(db)
	if err != nil {
		return 0
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	return modelCachePriceQ(rd, db, name)
}

func modelCachePriceQ(q rowQuerier, scope *sql.DB, name string) float64 {
	if v := modelConfigCache.get(scope, "cache:"+name); v != nil {
		return v.(float64)
	}
	var cache sql.NullFloat64
	// P1-6:同上,确定性取价。N-4:同样排除目录缺失行 —— 退化方向是把缓存价
	// 归 0(costOfAt 随即回落按输入价计费),不会产生免费额度。
	err := q.QueryRow(`SELECT cache_input_price_per_1m FROM models WHERE name = ? AND catalog_missing = FALSE ORDER BY provider_id LIMIT 1`, name).Scan(&cache)
	if err != nil || !cache.Valid {
		if err == nil {
			modelConfigCache.set(scope, "cache:"+name, 0.0)
		}
		return 0
	}
	modelConfigCache.set(scope, "cache:"+name, cache.Float64)
	return cache.Float64
}

// modelPriceInputs 是一次计量 / 结算需要的**全部读面**（R13-GE · V2-2）。
type modelPriceInputs struct {
	inputPer1M  float64
	outputPer1M float64
	cachePer1M  float64
	offpeak     float64
	peakWindows []PeakWindow
}

// loadModelPriceInputs 在**一个**已钉 search_path 的只读事务里读齐全部计价输入
// （唯一实现）：价目、缓存价、峰谷窗口。
//
// 为什么合成一个事务而不是让每个取价函数各开一个：这三条读永远一起用（同一次
// 记录 / 结算），合起来只多一次 BEGIN/ROLLBACK，而不是三次。峰谷窗口虽然住在
// `settings` 表里，但它直接乘进 cost（低谷折扣），与价目同属"计价输入"，必须
// 与价目看同一个库。
//
// 失败语义与旧实现逐字一致：打不开只读事务时返回零值输入（= 不加价 / 无峰谷
// 折扣），由调用方照旧落账 —— 不改变"计量优先于计费精度"这一既有取向。
func loadModelPriceInputs(db *sql.DB, providerID int64, name string) modelPriceInputs {
	var out modelPriceInputs
	rd, err := newUsageReadConn(db)
	if err != nil {
		return out
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	out.inputPer1M, out.outputPer1M, out.offpeak = modelPricesForProviderQ(rd, db, providerID, name)
	out.cachePer1M = modelCachePriceForProviderQ(rd, db, providerID, name)
	out.peakWindows = loadPeakWindowsQ(rd, db)
	return out
}

// AddModel inserts a model row(autocommit;插入成功后失效模型缓存)。
//
// 要与其它写库同事务请用 AddModelTx —— 两者共用同一条 INSERT(addModel),
// 只有"缓存失效的时机"不同。
func AddModel(db *sql.DB, m *Model) (int64, error) {
	id, err := addModel(func(query string, args ...any) (int64, error) {
		return InsertID(db, query, args...)
	}, m)
	if err != nil {
		return 0, err
	}
	InvalidateModelConfig()
	InvalidateModelsChanged()
	return id, nil
}

// AddModelTx 在调用方事务内插入模型行,返回新行 id(失败时 ErrDuplicate 语义
// 与 AddModel 一致)。
//
// **不失效模型缓存**:事务可能回滚,失效只能在 commit 之后做 —— 由调用方调用
// InvalidateModelConfig() / InvalidateModelsChanged()(见 llmgateway/admin.go
// createModel:移出排除名单 + 建模型行同事务,提交后统一失效)。
func AddModelTx(tx *sql.Tx, m *Model) (int64, error) {
	return addModel(func(query string, args ...any) (int64, error) {
		return InsertIDTx(tx, query, args...)
	}, m)
}

// insertFunc 执行一条 INSERT 并返回自增 id(*sql.DB 走 InsertID,*sql.Tx 走
// InsertIDTx)——让"模型的 INSERT 语句"只有一份实现。
type insertFunc func(query string, args ...any) (int64, error)

// addModel 是模型 INSERT 的唯一实现(AddModel / AddModelTx 共用):只负责
// 写库、回填 m.ID 与把唯一键冲突归一为 ErrDuplicate;缓存失效由调用方按
// "提交后"语义决定。
func addModel(insert insertFunc, m *Model) (int64, error) {
	if m.DefaultParams == "" {
		m.DefaultParams = "{}"
	}
	if m.InputModalities == nil {
		m.InputModalities = []string{"text"}
	}
	modalitiesJSON, _ := json.Marshal(m.InputModalities)
	id, err := insert(`INSERT INTO models (name, provider_id, display_name, default_params, input_modalities, input_price_per_1m, output_price_per_1m, cache_input_price_per_1m, offpeak_discount)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams, string(modalitiesJSON),
		nilIfNilFloat64(m.InputPricePer1M), nilIfNilFloat64(m.OutputPricePer1M), nilIfNilFloat64(m.CacheInputPricePer1M), nilIfNilFloat64(m.OffpeakDiscount))
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	m.ID = id
	return m.ID, nil
}

// UpdateModel updates a model row.
func UpdateModel(db *sql.DB, m *Model) error {
	modalitiesJSON, _ := json.Marshal(NormalizeInputModalities(m.InputModalities))
	tx, err := usageWriteTx(db) // R13-GE（V2-2）：族内写事务唯一实现
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 2026-09-08(P1-8 同类):改名时把旧名从 provider JSON 移除、新名加入,
	// 否则旧名仍可路由而 models 表无价 → cost=0。
	var oldName string
	var oldProvider int64
	err = tx.QueryRow("SELECT name, provider_id FROM models WHERE id = ?", m.ID).Scan(&oldName, &oldProvider)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	res, err := tx.Exec(`UPDATE models SET name=?, provider_id=?, display_name=?, default_params=?, input_modalities=?, input_price_per_1m=?, output_price_per_1m=?, cache_input_price_per_1m=?, offpeak_discount=?
		WHERE id=?`, m.Name, m.ProviderID, m.DisplayName, m.DefaultParams, string(modalitiesJSON),
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
	if oldName != m.Name || oldProvider != m.ProviderID {
		if err := removeProviderModelName(tx, oldProvider, oldName); err != nil {
			return err
		}
		if err := addProviderModelName(tx, m.ProviderID, m.Name); err != nil {
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

// addProviderModelName appends a model name to the provider's JSON list when
// missing (idempotent; keeps first-seen order).
func addProviderModelName(tx *sql.Tx, providerID int64, name string) error {
	var raw string
	err := tx.QueryRow("SELECT models FROM gateway_providers WHERE id = ?", providerID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		return nil
	}
	for _, n := range names {
		if n == name {
			return nil
		}
	}
	buf, err := json.Marshal(append(names, name))
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE gateway_providers SET models = ? WHERE id = ?", string(buf), providerID)
	return err
}

// ModelHasUsage reports whether the model name has recorded usage rows.
// 改名防护(审计修复 M7):有用量记录的模型改名会破坏历史费用口径。
func ModelHasUsage(db *sql.DB, name string) (bool, error) {
	// R13-GE（V2-2 读面收口）：读数决定"模型能不能删"（有用量的模型拒删）⇒
	// shadow 在场时读 shadow 的计数会得到相反答案。池上入口走已钉只读事务。
	rd, err := newUsageReadConn(db)
	if err != nil {
		return false, err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	var n int
	err = rd.QueryRow(`SELECT COUNT(*) FROM usage WHERE model = ?`, name).Scan(&n)
	return n > 0, err
}

// DeleteModel removes a model;若被删模型是 gateway.default_model,重置为空串
// (与 RemoveMissingProviderModels 同口径,防 bootstrap 悬空指向已删模型)。
// P1-8:同时从 gateway_providers.models JSON 中移除该模型名——上游路由用
// mergeModelNames(provider JSON, models 表),只删 models 行会让模型仍被路由
// 匹配到(ModelPrices 查不到行 → cost=0,平台付费零计量)。
func DeleteModel(db *sql.DB, id int64) error {
	// R13-GE（V2-2）：委托给 DeleteModelTx，但事务本身必须钉 search_path
	// （DeleteModelTx 里读/删的都是族内关系 models）。
	tx, err := usageWriteTx(db)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := DeleteModelTx(tx, id); err != nil {
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

// DeleteModelTx 在调用方事务内删除模型行(不提交、不失效缓存)。
//
// 2026-09-23(第三轮 §7.3 C):管理端 DELETE /models/:id 需要把「读该行 → 渠道型
// 记入排除名单 → 删行 → 审计」放进同一个事务(否则"排除名单写了但删行失败"会
// 把模型留在名单里,或反之),故把写入逻辑抽成事务版。缓存失效与 settings
// 失效(default_model 可能被清空)由调用方在 Commit 之后做。
func DeleteModelTx(tx *sql.Tx, id int64) error {
	var name string
	var providerID int64
	err := tx.QueryRow("SELECT name, provider_id FROM models WHERE id = ?", id).Scan(&name, &providerID)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if err := removeProviderModelName(tx, providerID, name); err != nil {
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
	return nil
}

// removeProviderModelName 从 gateway_providers.models JSON 数组里移除 name
// (事务内执行)。名字不存在 / JSON 损坏时不报错:models 行的删除本身仍应成功。
func removeProviderModelName(tx *sql.Tx, providerID int64, name string) error {
	var raw string
	err := tx.QueryRow("SELECT models FROM gateway_providers WHERE id = ?", providerID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var names []string
	if err := json.Unmarshal([]byte(raw), &names); err != nil {
		return nil
	}
	kept := make([]string, 0, len(names))
	changed := false
	for _, n := range names {
		if n == name {
			changed = true
			continue
		}
		kept = append(kept, n)
	}
	if !changed {
		return nil
	}
	buf, err := json.Marshal(kept)
	if err != nil {
		return err
	}
	_, err = tx.Exec("UPDATE gateway_providers SET models = ? WHERE id = ?", string(buf), providerID)
	return err
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
	// R13-GE（V2-2 读面收口）：族内读面 —— 池上入口走已钉 search_path 的只读事务。
	rd, err := newUsageReadConn(db)
	if err != nil {
		return nil, err
	}
	defer rd.Close() //nolint:errcheck // 只读事务回滚
	rows, err := rd.Query(`SELECT ` + modelSelectColumns + `
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
