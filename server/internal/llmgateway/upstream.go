package llmgateway

import (
	"database/sql"
	"encoding/json"
	"errors"
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
	Name     string
	BaseURL  string
	APIKey   string
	Models   []string
	Channel  string
	Protocol string
}

func loadUpstreamsDB(db *sql.DB) ([]Upstream, error) {
	rows, err := db.Query(`SELECT id, name, base_url, api_key_enc, models, channel, protocol FROM gateway_providers WHERE enabled = 1 ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ups []Upstream
	for rows.Next() {
		var u Upstream
		var id int64
		var key, modelsJSON string
		if err := rows.Scan(&id, &u.Name, &u.BaseURL, &key, &modelsJSON, &u.Channel, &u.Protocol); err != nil {
			return nil, err
		}
		key, err := DecryptSecret(key)
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
		if err := json.Unmarshal([]byte(modelsJSON), &u.Models); err != nil {
			log.Printf("gateway: skip provider %s: bad models json: %v", u.Name, err)
			continue
		}
		// ponytail: N+1 per provider; admin-managed table is tiny, a JOIN adds no value
		synced, err := syncedModelNames(db, id)
		if err != nil {
			log.Printf("gateway: skip provider %s: load synced models: %v", u.Name, err)
			continue
		}
		u.Models = mergeModelNames(u.Models, synced)
		ups = append(ups, u)
	}
	return ups, rows.Err()
}

// syncedModelNames returns the model names a provider has in the models table.
func syncedModelNames(db *sql.DB, providerID int64) ([]string, error) {
	rows, err := db.Query(`SELECT name FROM models WHERE provider_id = ?`, providerID)
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

// MatchModels returns every enabled upstream serving modelName, in DB order.
// Multiple candidates enable failover: when the first provider fails before
// the first byte, the next one is tried.
func MatchModels(db *sql.DB, modelName string) ([]Upstream, error) {
	return MatchModelsByProtocol(db, modelName, "")
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

// MatchModel finds the first enabled upstream serving modelName, or ErrNotFound.
func MatchModel(db *sql.DB, modelName string) (*Upstream, error) {
	ups, err := MatchModels(db, modelName)
	if err != nil {
		return nil, err
	}
	if len(ups) == 0 {
		return nil, serverstore.ErrNotFound
	}
	return &ups[0], nil
}
