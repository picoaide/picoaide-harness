package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// DecryptSecret decrypts an upstream API key. 默认报错(未接线即失败,
// 审计2026-L14):AES-GCM master-key wiring 由 cmd/server/main.go 安装。
var DecryptSecret = func(s string) (string, error) {
	return "", errors.New("master key not wired")
}

// safeModelForLog 脱敏模型名再入日志:model 是用户可控输入(%q 已阻止换行
// 注行,但仍可能超长或含敏感串)——仅记录截断后的前 40 字符与原始长度。
// 2026-09-01 审计:多处 log.Printf 直接打印 req.Model。
func safeModelForLog(model string) string {
	const max = 40
	runes := []rune(model)
	if len(runes) <= max {
		return fmt.Sprintf("%q (len=%d)", model, len(runes))
	}
	return fmt.Sprintf("%q… (len=%d)", string(runes[:max]), len(runes))
}

// upstreamTTL 上游路由缓存时长:provider/模型表由管理端低频改动,
// 而每条聊天请求都调 LoadUpstreams(N+1:provider + 每 provider 的 synced models)。
// 30s TTL 内管理端变更最多延迟 30s 生效(路由一致性可接受,换来热路径 0 DB)。
const upstreamTTL = 30 * time.Second

var (
	upstreamCacheMu sync.Mutex
	upstreamCache   []Upstream
	upstreamCacheAt time.Time
	upstreamCacheDB *sql.DB // 缓存绑定的 DB 实例:不同 DB(测试)不共享
)

// InvalidateUpstreams 主动失效上游缓存(管理端增删 provider/模型时调用)。
func InvalidateUpstreams() {
	upstreamCacheMu.Lock()
	defer upstreamCacheMu.Unlock()
	upstreamCache = nil
	upstreamCacheDB = nil
}

// withCache 包装 LoadUpstreams 内部逻辑,附加缓存(供测试无缓存路径)。
// 兼容签名:测试直接调 LoadUpstreams;缓存命中返回上次结果。
// DB 实例绑定:测试用独立临时库(不同 *sql.DB),缓存按 DB 隔离——
// 同一进程内不同 DB 的测试不会相互污染。
func loadUpstreamsCached(db *sql.DB) ([]Upstream, error) {
	upstreamCacheMu.Lock()
	if upstreamCache != nil && upstreamCacheDB == db && time.Since(upstreamCacheAt) < upstreamTTL {
		c := upstreamCache
		upstreamCacheMu.Unlock()
		return c, nil
	}
	upstreamCacheMu.Unlock()

	ups, err := loadUpstreamsDB(db)
	if err != nil {
		return nil, err
	}
	upstreamCacheMu.Lock()
	upstreamCache = ups
	upstreamCacheAt = time.Now()
	upstreamCacheDB = db
	upstreamCacheMu.Unlock()
	return ups, nil
}

// LoadUpstreams returns all enabled providers with their model lists.
// Model names merge the provider's models JSON column with the models table
// (where channel sync writes), so both manually-entered and synced models route.
// One broken provider (undecryptable key, corrupt models JSON) is skipped and
// logged instead of aborting the whole gateway.
func LoadUpstreams(db *sql.DB) ([]Upstream, error) {
	return loadUpstreamsCached(db)
}

// Upstream is an enabled LLM provider (OpenAI-compatible, or Anthropic-compatible when Protocol == "anthropic").
type Upstream struct {
	// ID 是 gateway_providers.id:计费取价必须按**实际命中的 provider**
	// (P1-6,审计 2026-09-13 —— 同名模型挂多 provider 时按 name 取价会随
	// 物理行序漂移,可命中 0 价行)。
	ID       int64
	Name     string
	BaseURL  string
	APIKey   string
	Models   []string
	Channel  string
	Protocol string
}

// loadUpstreamsDB 读**上游路由与密钥**(`gateway_providers`)与每 provider 的已同步
// 模型名(`models`)—— 两条都是族内关系。
//
// R13-GH3(`search_path` 同族第三条路径):旧实现是裸池上的未限定名查询,连接/角色/
// 库级 search_path 前置同名 shadow schema 时,`base_url` + `api_key_enc`(上游路由与
// **密钥**)与模型清单都读自 shadow —— 管理员在 public 改路由,网关却按 shadow 的
// 诱饵路由发请求,且没有任何错误面(真 PG + 敌对 search_path 实测)。现在整段
// (provider 扫描 + 逐 provider 的 syncedModelNames)在**同一个已钉 search_path 的
// 只读事务**里读;`loadUpstreamsCached` 的 30s 缓存语义不变。
func loadUpstreamsDB(db *sql.DB) ([]Upstream, error) {
	var ups []Upstream
	err := serverstore.WithUsageSearchPathRead(db, func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id, name, base_url, api_key_enc, models, channel, protocol FROM gateway_providers WHERE enabled = 1 ORDER BY id`)
		if err != nil {
			return err
		}
		// 先把 provider 行**全部读进内存再关 rows**：*sql.Tx 只持有一条连接，
		// 在 rows 未读完时再发下一条语句会让驱动报 "driver: bad connection"
		// （R13-GH3 实跑踩到：N+1 的逐 provider 读原先在池上、每条各占一条连接，
		// 收进同一个事务后必须先排空再进下一轮）。
		type providerRow struct {
			id                             int64
			name, baseURL, key, modelsJSON string
			channel, protocol              string
		}
		var list []providerRow
		for rows.Next() {
			var r providerRow
			if err := rows.Scan(&r.id, &r.name, &r.baseURL, &r.key, &r.modelsJSON, &r.channel, &r.protocol); err != nil {
				rows.Close()
				return err
			}
			list = append(list, r)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return err
		}
		rows.Close()

		for _, r := range list {
			u := Upstream{ID: r.id, Name: r.name, BaseURL: r.baseURL, Channel: r.channel, Protocol: r.protocol}
			key, err := DecryptSecret(r.key)
			if err != nil {
				log.Printf("gateway: skip provider %s: decrypt api key: %v", u.Name, err)
				continue
			}
			u.APIKey = key
			if u.Protocol != "anthropic" && u.Protocol != "openai" && u.Protocol != "both" {
				// 未知协议(防御):不参与任何路由,与损坏 key 同档处理
				log.Printf("gateway: skip provider %s: unknown protocol %q", u.Name, u.Protocol)
				continue
			}
			if err := json.Unmarshal([]byte(r.modelsJSON), &u.Models); err != nil {
				log.Printf("gateway: skip provider %s: bad models json: %v", u.Name, err)
				continue
			}
			// ponytail: N+1 per provider; admin-managed table is tiny, a JOIN adds no value
			synced, err := syncedModelNames(tx, r.id)
			if err != nil {
				log.Printf("gateway: skip provider %s: load synced models: %v", u.Name, err)
				continue
			}
			u.Models = mergeModelNames(u.Models, synced)
			ups = append(ups, u)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return ups, nil
}

// syncedModelNames returns the model names a provider has in the models table.
// 2026-09-23(审计 G-02):排除 catalog_missing = TRUE 的行 —— 它们已不在上游
// 目录里(渠道同步发现目录缺失时停用而非删除,以保住定价),路由池必须按可用性
// 过滤掉,否则会把请求发往一个上游目录中已不存在的模型。
//
// R13-GH3:形参是**已钉 search_path 的事务**(由 loadUpstreamsDB 提供)——函数自己
// 开不出事务,只能作为已钉事务的语句入口(机械守卫按 via-caller 登记)。
func syncedModelNames(tx *sql.Tx, providerID int64) ([]string, error) {
	rows, err := tx.Query(`SELECT name FROM models WHERE provider_id = ? AND catalog_missing = FALSE`, providerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		names = append(names, n)
	}
	return names, rows.Err()
}

// mergeModelNames appends b's names to a, dropping duplicates.
func mergeModelNames(a, b []string) []string {
	if len(b) == 0 {
		return a
	}
	seen := make(map[string]bool, len(a)+len(b))
	out := make([]string, 0, len(a)+len(b))
	for _, n := range append(append([]string{}, a...), b...) {
		if seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

// MatchModelsByProtocol returns every enabled upstream serving modelName with
// the given protocol ("" = any). This is how the Anthropic /v1/messages route
// finds Anthropic-compatible providers only, while chat keeps OpenAI ones.
// `both`(0044)同时匹配 openai 与 anthropic 两种路由——同一 key 双端点。
func MatchModelsByProtocol(db *sql.DB, modelName, protocol string) ([]Upstream, error) {
	ups, err := LoadUpstreams(db)
	if err != nil {
		return nil, err
	}
	var out []Upstream
	for i := range ups {
		if protocol != "" {
			switch ups[i].Protocol {
			case "both":
				// both:与任何协议请求都匹配(openai 路由和 anthropic 路由)
			case protocol:
				// 精确匹配
			default:
				continue
			}
		}
		for _, m := range ups[i].Models {
			if m == modelName {
				out = append(out, ups[i])
				break
			}
		}
	}
	return out, nil
}
