package serverstore

import (
	"database/sql"
	"sync"
	"time"
)

// cacheEntry 一条带 TTL 的缓存值。
// db 绑定:同一进程可能持有多个 *sql.DB(生产单实例单库;测试每个用例独立
// 临时库)。缓存条目绑定来源 DB,读取时校验——不同 DB 互不污染,无需
// 测试显式清缓存(2026-08-31 加缓存后引入,防测试隔离问题)。
type cacheEntry struct {
	val any
	exp time.Time
	db  *sql.DB
}

// ttlCache 是标准库实现的无依赖内存缓存(mutex + map)。
// 用途:热路径上高频读、低频写的数据(组织树/模型路由/模型配置/设置)。
// 设计:不阻塞写读——过期条目 lazy 淘汰,写回时重建;无需 goroutine 定时清扫。
type ttlCache struct {
	mu    sync.Mutex
	items map[string]cacheEntry
	ttl   time.Duration
}

func newTTLCache(ttl time.Duration) *ttlCache {
	return &ttlCache{items: map[string]cacheEntry{}, ttl: ttl}
}

// get 读缓存;miss/过期/DB 不匹配返回 nil。
func (c *ttlCache) get(db *sql.DB, key string) any {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return nil
	}
	if e.db != db || time.Now().After(e.exp) {
		delete(c.items, key)
		return nil
	}
	return e.val
}

// set 写缓存(以写入时刻起算 TTL,绑定当前 DB)。val 为 nil 时不缓存。
func (c *ttlCache) set(db *sql.DB, key string, val any) {
	if val == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items[key] = cacheEntry{val: val, exp: time.Now().Add(c.ttl), db: db}
}

// invalidate 主动失效(管理端变更模型/组织/上游时调用)。
func (c *ttlCache) invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.items, key)
}

// invalidateAll 全量失效(不区分 key)。
func (c *ttlCache) invalidateAll() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.items = map[string]cacheEntry{}
}

// InvalidateAllCaches 全量失效(供测试/维护入口)。
func InvalidateAllCaches() {
	groupTreeCache.invalidateAll()
	modelConfigCache.invalidateAll()
	settingsCache.invalidateAll()
}
