package llmgateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"log"
	"time"

	"github.com/picoaide/picoaide/internal/llmgateway/channels"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// SyncResult 描述一个 provider 的同步结果。
type SyncResult struct {
	Provider string `json:"provider"`
	Added    int    `json:"added"`
	Removed  int    `json:"removed"`
	// Skipped:手动型上游无需同步(审计修复 L8),供前端折叠展示而非逐条报错。
	Skipped bool   `json:"skipped,omitempty"`
	Error   string `json:"error,omitempty"`
}

// httpFetch15s 返回带 15s 请求内超时的 fetchFn(审计修复 M5):慢/黑洞上游
// 不得把 admin 同步请求挂到 channels.HTTPFetch 的 120s 客户端超时。
// 与 syncProviderNow 即时同步口径一致;测试经 syncFetchFn 注入。
func httpFetch15s(key string) func(url string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	return func(url string) ([]byte, error) {
		defer cancel()
		return channels.HTTPFetch(ctx, url, key)
	}
}

// SyncOnce 对所有 enabled 且含 key 的 provider 拉取模型并同步 models 表。
// 单个 provider 失败不影响其他。fetchFn 可注入便于测试;nil 时用 HTTPFetch。
func SyncOnce(db *sql.DB, fetchFn func(url string) ([]byte, error)) ([]SyncResult, error) {
	providers, err := serverstore.ListGatewayProviders(db)
	if err != nil {
		return nil, err
	}
	var results []SyncResult
	for i := range providers {
		p := &providers[i]
		if p.Enabled != 1 || p.APIKeyEnc == "" {
			continue
		}
		if p.Channel == "" {
			// 手动型上游:模型来自创建时填写的列表,无需也绝不能自动同步;
			// 但 sync-all 必须明确说明,否则管理员以为同步无效。标记 Skipped
			// 供前端折叠为一行汇总(审计修复 L8)。
			results = append(results, SyncResult{Provider: p.Name, Skipped: true, Error: "手动型上游无需同步(模型来自模型列表)"})
			continue
		}
		ch, ok := channels.Get(p.Channel)
		if !ok {
			results = append(results, SyncResult{Provider: p.Name, Error: "unknown channel"})
			continue
		}
		key, err := DecryptSecret(p.APIKeyEnc)
		if err != nil {
			results = append(results, SyncResult{Provider: p.Name, Error: err.Error()})
			continue
		}
		results = append(results, SyncProvider(db, ch, p, key, fetchFn))
	}
	return results, nil
}

// SyncProvider 同步单个 provider 的模型,返回结果。
// added = 本次真正新增的模型数(此前不在目录中的),removed = 上游不再提供
// 而被清理的模型数(审计修复 M5:此前 added 恒为全量目录数,误导运维)。
// 排除名单中的模型(管理端删除的渠道同步模型)跳过,防止被 SyncLoop 复活
// (审计修复 H2)。
func SyncProvider(db *sql.DB, ch channels.Channel, p *serverstore.GatewayProvider, key string, fetchFn func(url string) ([]byte, error)) SyncResult {
	f := fetchFn
	if f == nil {
		f = httpFetch15s(key)
	}
	models, err := ch.FetchModels(context.Background(), key, f)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	// 空列表可能是上游瞬时异常,不当作"模型全部下架"清空目录
	if len(models) == 0 {
		return SyncResult{Provider: p.Name, Added: 0, Removed: 0}
	}
	// 排除名单:管理端删除的渠道同步模型不自动恢复(审计修复 H2)
	excluded, err := serverstore.GetExcludedModels(db, p.ID)
	if err != nil {
		excluded = nil
	}
	excludedSet := make(map[string]bool, len(excluded))
	for _, e := range excluded {
		excludedSet[e] = true
	}
	// 同步前目录集合:计算 added 的基线(审计修复 M5)
	beforeSet := make(map[string]bool)
	if before, err := syncedModelNames(db, p.ID); err == nil {
		for _, n := range before {
			beforeSet[n] = true
		}
	}
	cl, mo := ch.DefaultModelCaps()
	type caps struct {
		ContextLength int64 `json:"context_length"`
		MaxOutput     int64 `json:"max_output"`
	}
	seen := make(map[string]bool, len(models))
	var newNames []string
	added := 0
	for _, m := range models {
		if seen[m.ID] || excludedSet[m.ID] {
			continue
		}
		seen[m.ID] = true
		cln, mon := m.ContextLen, m.MaxOutput
		if cln == 0 {
			cln = cl
		}
		if mon == 0 {
			mon = mo
		}
		params, _ := json.Marshal(caps{ContextLength: cln, MaxOutput: mon})
		if err := serverstore.SyncProviderModel(db, p.ID, m.ID, string(params)); err != nil {
			return SyncResult{Provider: p.Name, Error: err.Error()}
		}
		if !beforeSet[m.ID] {
			added++
		}
		newNames = append(newNames, m.ID)
	}
	removed, err := serverstore.RemoveMissingProviderModels(db, p.ID, newNames)
	if err != nil {
		return SyncResult{Provider: p.Name, Error: err.Error()}
	}
	return SyncResult{Provider: p.Name, Added: added, Removed: removed}
}

// SyncIteration runs one model sync plus pending-usage cleanup (C-9): stale
// zero-token rows from interrupted streams are purged on every tick, not
// only at startup.
func SyncIteration(db *sql.DB, fetchFn func(url string) ([]byte, error)) ([]SyncResult, error) {
	if err := serverstore.CleanupPendingUsage(db, time.Now().Add(-time.Hour)); err != nil {
		log.Printf("gateway: cleanup pending usage: %v", err)
	}
	return SyncOnce(db, fetchFn)
}

// SyncLoop 定时执行 SyncIteration,固定间隔。
func SyncLoop(db *sql.DB, interval time.Duration, fetchFn func(url string) ([]byte, error)) {
	if interval <= 0 {
		interval = time.Hour
	}
	for {
		if _, err := SyncIteration(db, fetchFn); err != nil {
			log.Printf("gateway sync: %v", err)
		}
		time.Sleep(interval)
	}
}
