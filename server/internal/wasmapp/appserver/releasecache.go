package appserver

import (
	"container/list"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== (app_id, release_id) 级缓存（R1-rt-2 / R1-rt-3）=====
//
// # 缓存的到底是什么（2026-09-20 改口径：内存资源集）
//
// 随包资源**不再抽取到宿主磁盘**（决策文档 docs/decisions/2026-09-20-wasm-assets-in-memory.md）：
// 运行期的唯一真源是内存资源集 `assets.Set`（由 wasm 自定义段 + 库内 `config_json`
// 构造，常驻在模块缓存条目里，见 modules.go 的 acquireSet/insertSet）。资源字节既然
// 已经在内存里、且在 `(app_id, release_id, path)` 下**不可变**，本缓存就只留
// **推导出来的东西**，不再复制一份字节（同一份内容在进程里存两遍，还要凭空多维护
// 一套字节预算）：
//
//   - `assetEntry`：`content-type` + `ETag` + `Size` —— 静态直出与 304 复验需要的全部；
//   - `appcfg.Config`：解析后的应用配置（准入判定的输入）。
//
// 为什么连元数据也值得缓存：ETag = `hash(app_id ‖ version ‖ path ‖ sha256(content))`，
// 其中 sha256 是热路径上唯一"随资源体积增长"的成本（实测 200 KiB ≈ 256 µs/请求）；
// 按 release 只算一次就是 R1-rt-3 要省的那笔钱（正文本身每次仍按逻辑路径去资源集取，
// 那只是内存里的一次 map 查找）。而 304 复验（R1-rt-2）更彻底：只读缓存里的 ETag，
// **完全不碰资源集、不算哈希**（观测点 = `SourceReads` 不增长）。
//
// # 有界性（**不许引入无界内存**）
//
// 单一全局 LRU，**唯一硬上限是条目数** `ReleaseCacheMaxReleases`（数值真源在 limits），
// 外加**空闲淘汰**（与编译模块缓存同一个 TTL，见 `sweepIdle`）：长时间没人访问的
// 应用会被整条释放。
//
// **这里没有字节预算**：本缓存不再持有资源字节 —— 资源字节计入**模块缓存**的
// `module_cache_mb`（`insertSet` 把 `set.Bytes()` 记进条目 size），与模块同生命周期
// （容量 LRU + 空闲 TTL + 应用级逐出）。`limits.ReleaseCacheMaxBytes` 是数值真源模块
// （limits 包，本模块不可修改）的文件，常量**保留**在那里，但本包已不再引用它；
// 部署侧真正覆盖"编译产物 + 随包资源"的旋钮是 `module_cache_mb`。
//
// # 失效（换版本 / 下架 / 冻结 / 删除 / 逐出）
//
//   - **换版本**：键含 `release_id` ⇒ 新版本天然不命中；并且新条目的第一次插入会
//     丢掉该应用**其它 release** 的条目（`dropOtherReleasesLocked`），旧版本的元数据
//     不会滞留（正确性本来就不依赖这一步，它负责"及时释放"）；
//   - **下架 / 冻结 / 删除 / 手动逐出**：四条路都会经 `appserver.Server.EvictApp`
//     （`api` 的处置钩子已接线）⇒ `evictApp` 清空该应用的全部条目。
//
// 本缓存的读者只会拿到**值拷贝**（`assetEntry` / `appcfg.Config`）；被共享的只有
// `*assets.Set`（构造完成后只读），因此并发读安全。

// releaseKey 是缓存键：`(app_id, release_id)`。
//
// 为什么用 release_id 而不是 version 字符串：release_id 是版本行的主键，版本回滚、
// 同版本重发（不允许）等情况都不会与另一行共用键；version 只进 ETag 的摘要。
type releaseKey struct {
	AppID     string
	ReleaseID int64
}

// assetEntry 是一个静态资源的缓存条目（**值语义**：调用方拿到的是拷贝）。
//
// 只有元数据：正文的真源是内存资源集（`assets.Set.Read`），调用方按需去取，
// 这里再存一份不会让任何路径变快（内存里的一次 map 查找），只会让同一份内容有两个副本。
type assetEntry struct {
	// ContentType 是资源集按扩展名推导的 content-type。
	ContentType string
	// ETag 是强 ETag（带引号），与内容绑定。
	ETag string
	// Size 是资源字节数（首次回源时由 `set.Read` 的字节长度得到）。
	Size int
}

// releaseEntry 是一个 `(app_id, release_id)` 的缓存条目。
type releaseEntry struct {
	key    releaseKey
	assets map[string]assetEntry

	cfg    appcfg.Config
	cfgErr *apperr.Error
	cfgSet bool

	// lastUsed 是最近一次命中/写入的时间（空闲淘汰用它；由注入的时钟给）。
	lastUsed time.Time
	// lruElem 是本条目在 LRU 链表里的位置（nil = 已摘除）。
	lruElem *list.Element
}

// releaseCacheStats 是缓存的瞬时计数（护栏与 perf 探针用，不在请求路径上读）。
type releaseCacheStats struct {
	Entries     int
	AssetHits   int64
	AssetMisses int64
	CfgHits     int64
	CfgMisses   int64
	// SourceReads 是**元数据缓存未命中** ⇒ 不得不回源到内存资源集重新派生元数据的次数
	// （`assets.Set.Read` + 重算 ETag）。
	//
	// 它是 R1-rt-2「304 复验不回源」这条**行为断言**的观测点：304 只走 `CachedAsset`
	// ⇒ 该计数不变；一旦实现改回"先取正文/算哈希、再判 If-None-Match"，计数就会涨
	// （原判据是"删掉磁盘上的文件后 304 仍成立"；内存模型下没有可删的盘上副本，
	// 于是把"回源派生"这一动作本身变成可观测量）。200 命中路径同理：正文照取，
	// 但不再重算 ETag ⇒ 计数不变。
	SourceReads int64
	// Evictions 是 LRU/空闲淘汰掉的条目数（含换版本失效）。
	Evictions int64
}

// releaseCache 是有界的 `(app_id, release_id)` 级缓存（见文件头注释）。
type releaseCache struct {
	mu         sync.Mutex
	maxEntries int
	entries    map[releaseKey]*releaseEntry
	// lru 的 front = 最近使用；元素值是 *releaseEntry。
	lru *list.List
	now func() time.Time

	assetHits, assetMisses int64
	cfgHits, cfgMisses     int64
	sourceReads            int64
	evictions              int64
}

// newReleaseCache 创建缓存。条目上限 0 及以下 ⇒ 用 limits 的真源（生产路径只走这一条）。
func newReleaseCache(maxEntries int, now func() time.Time) *releaseCache {
	if maxEntries <= 0 {
		maxEntries = limits.ReleaseCacheMaxReleases
	}
	if now == nil {
		now = time.Now
	}
	return &releaseCache{
		maxEntries: maxEntries,
		entries:    make(map[releaseKey]*releaseEntry),
		lru:        list.New(),
		now:        now,
	}
}

// asset 查一个资源的缓存**元数据**（不回源）。命中即把它提到 LRU 头部。
func (c *releaseCache) asset(k releaseKey, logical string) (assetEntry, bool) {
	if c == nil {
		return assetEntry{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok {
		c.assetMisses++
		return assetEntry{}, false
	}
	a, ok := e.assets[logical]
	if !ok {
		c.assetMisses++
		return assetEntry{}, false
	}
	e.lastUsed = c.now()
	if e.lruElem != nil {
		c.lru.MoveToFront(e.lruElem)
	}
	c.assetHits++
	return a, true
}

// putAsset 写入一个资源的**元数据**，并按条目数上限淘汰。
//
// 不再有"单条超过预算一半只缓存元数据"这条分支：本缓存本来就只有元数据
// （字节预算随内存资源集一起取消，见文件头"有界性"）。
func (c *releaseCache) putAsset(k releaseKey, logical string, a assetEntry) {
	if c == nil {
		return
	}
	if a.Size < 0 {
		a.Size = 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.ensureLocked(k)
	e.assets[logical] = a
	e.lastUsed = c.now()
	c.evictLocked()
}

// config 查解析后的应用配置（不回源）。
//
// **没有 TTL 复验**（R2-CA-1 的机制连同 configAt 一起删除）：配置的载体现在与资源
// 字节同源 —— 不可变的库内 `config_json` 随资源集注入，同一个 `release_id` 下它
// 不可能被外部改动或删掉（原机制存在的唯一理由是"磁盘上的文件可能被平台故障/人为
// 操作改坏"，而这条路径已经不存在）。因此"解析成功就长期有效"与"资源字节
// 长期有效"是同一个事实，不需要每 5 分钟重新确认一次。
func (c *releaseCache) config(k releaseKey) (appcfg.Config, *apperr.Error, bool) {
	if c == nil {
		return appcfg.Config{}, nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok || !e.cfgSet {
		c.cfgMisses++
		return appcfg.Config{}, nil, false
	}
	e.lastUsed = c.now()
	if e.lruElem != nil {
		c.lru.MoveToFront(e.lruElem)
	}
	c.cfgHits++
	return e.cfg, e.cfgErr, true
}

// putConfig 写入解析结果。**只缓存成功**。
//
// 失败不是常量：现在失败只剩"资源集里没有 `picoaide.app.json`"这一种（发布链路写入
// 的 `config_json` 为空/该版本没有配置）——它仍然可以随着**新版本**或资源集重建而改变，
// 所以失败的记录不该进缓存（进了就再也没有请求会去重读它）。与 `Asset()` 对失败的
// 处理对称：不缓存失败。
func (c *releaseCache) putConfig(k releaseKey, cfg appcfg.Config, err *apperr.Error) {
	if c == nil || err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.ensureLocked(k)
	e.cfg, e.cfgErr, e.cfgSet = cfg, nil, true
	e.lastUsed = c.now()
	c.evictLocked()
}

// evictApp 丢掉某应用的全部条目（下架 / 冻结 / 删除 / 逐出时的唯一入口）。
//
// 返回被丢掉的条目数；第二个返回值（记账字节）**恒为 0** —— 本缓存已不持有字节，
// 随包资源的内存由模块缓存记账（`moduleCache.evictApp` 会把 `set.Bytes()` 一起还回来，
// 见 modules.go 的 insertSet）。保留这个形状是为了不改逐出调用点的记账口径
// （options.go 的 EvictApp/sweepOnce 把两处返回值相加后交给 reclaim）。
func (c *releaseCache) evictApp(appID string) (int, int64) {
	if c == nil || appID == "" {
		return 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for k, e := range c.entries {
		if k.AppID != appID {
			continue
		}
		c.removeLocked(e)
		n++
	}
	return n, 0
}

// sweepIdle 释放空闲超过 idle 的条目（与编译模块缓存同一个后台循环调用）。
//
// 第二个返回值恒为 0（同 evictApp：本缓存不持有字节）。
func (c *releaseCache) sweepIdle(idle time.Duration) (int, int64) {
	if c == nil || idle <= 0 {
		return 0, 0
	}
	cutoff := c.now().Add(-idle)
	c.mu.Lock()
	defer c.mu.Unlock()
	var n int
	for _, e := range c.entries {
		if e.lastUsed.After(cutoff) {
			continue
		}
		c.removeLocked(e)
		n++
	}
	return n, 0
}

// stats 返回瞬时计数（测试/探针）。
func (c *releaseCache) stats() releaseCacheStats {
	if c == nil {
		return releaseCacheStats{}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return releaseCacheStats{
		Entries:     len(c.entries),
		AssetHits:   c.assetHits,
		AssetMisses: c.assetMisses,
		CfgHits:     c.cfgHits,
		CfgMisses:   c.cfgMisses,
		SourceReads: c.sourceReads,
		Evictions:   c.evictions,
	}
}

// countSourceRead 记一次"不得不回源到内存资源集"（元数据未命中 ⇒ `set.Read` + 重算 ETag）。
func (c *releaseCache) countSourceRead() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.sourceReads++
	c.mu.Unlock()
}

// ensureLocked 返回（必要时新建）条目。调用方持锁。
func (c *releaseCache) ensureLocked(k releaseKey) *releaseEntry {
	if e, ok := c.entries[k]; ok {
		return e
	}
	e := &releaseEntry{key: k, assets: make(map[string]assetEntry), lastUsed: c.now()}
	e.lruElem = c.lru.PushFront(e)
	c.entries[k] = e
	// 换版本失效：同一应用**其它 release** 的条目在这里被丢掉。
	c.dropOtherReleasesLocked(k)
	c.evictLocked()
	return e
}

// dropOtherReleasesLocked 丢掉同一应用其它 release 的条目（换版本时的显式失效）。
//
// 新版本的键与旧版本不同 ⇒ **正确性本来就不依赖这一步**（旧条目永远不会被读到）；
// 这一步负责的是"旧版本的元数据不滞留"（内存及时释放）。
func (c *releaseCache) dropOtherReleasesLocked(k releaseKey) {
	for old, e := range c.entries {
		if old == k || old.AppID != k.AppID {
			continue
		}
		c.removeLocked(e)
	}
}

// evictLocked 把条目数压回上限内。
//
// **不逐出唯一剩下的那一条**：否则"刚写进去就被自己赶出来"会让缓存永不命中。
func (c *releaseCache) evictLocked() {
	for len(c.entries) > c.maxEntries && c.lru.Len() > 1 {
		back := c.lru.Back()
		if back == nil {
			return
		}
		c.removeLocked(back.Value.(*releaseEntry))
	}
}

// removeLocked 从索引与 LRU 里摘掉一个条目。调用方持锁。
func (c *releaseCache) removeLocked(e *releaseEntry) {
	if e == nil {
		return
	}
	if cur, ok := c.entries[e.key]; ok && cur == e {
		delete(c.entries, e.key)
	}
	if e.lruElem != nil {
		c.lru.Remove(e.lruElem)
		e.lruElem = nil
	}
	c.evictions++
}

// ===== 每请求视图 =====

// releaseContent 是一次请求对某个 `(app, release)` 的视图：**元数据缓存优先，
// 未命中才回源到内存资源集**。
//
// 生命周期：一个请求一个实例（不跨请求共享），字段不可并发访问。
type releaseContent struct {
	srv   *Server
	appID string
	rel   *serverstore.WasmRelease
	key   releaseKey
	// set 是本版本的内存资源集（由调用方经模块缓存的 acquireSet 取到，可与其它请求
	// 共享：构造完成后只读）。nil = 平台故障（调用方没能把资源加载起来）。
	set *assets.Set

	cfg    appcfg.Config
	cfgErr *apperr.Error
	cfgSet bool
}

// openReleaseContent 为一次请求建立视图。set 是本版本的内存资源集
// （`acquireSet` 的结果，可为 nil —— 那时任何回源路径都会按平台故障处理）。
func (s *Server) openReleaseContent(appID string, rel *serverstore.WasmRelease, set *assets.Set) *releaseContent {
	if rel == nil {
		return nil
	}
	return &releaseContent{
		srv:   s,
		appID: appID,
		rel:   rel,
		key:   releaseKey{AppID: appID, ReleaseID: rel.ID},
		set:   set,
	}
}

// Config 返回解析后的应用配置（缓存优先）。
func (rc *releaseContent) Config() (appcfg.Config, *apperr.Error) {
	if rc == nil {
		return appcfg.Config{}, apperr.New(apperr.CodeInternal, "缺少生效版本信息")
	}
	if rc.cfgSet {
		return rc.cfg, rc.cfgErr
	}
	if cfg, err, ok := rc.srv.releases.config(rc.key); ok {
		rc.cfg, rc.cfgErr, rc.cfgSet = cfg, err, true
		return cfg, err
	}
	cfg, err := loadAppConfig(rc.set)
	rc.srv.releases.putConfig(rc.key, cfg, err)
	rc.cfg, rc.cfgErr, rc.cfgSet = cfg, err, true
	return cfg, err
}

// CachedAsset 只查缓存，**绝不回源**（304 复验走这条）。
func (rc *releaseContent) CachedAsset(logical string) (assetEntry, bool) {
	if rc == nil {
		return assetEntry{}, false
	}
	return rc.srv.releases.asset(rc.key, logical)
}

// Asset 返回资源的**元数据 + 字节**（content-type / ETag / Size 来自缓存，字节来自
// 内存资源集），**元数据缓存优先**：命中时不重算 ETag（省掉 sha256），但仍然要按
// 逻辑路径去资源集取一次字节（一次路径校验 + map 查找，很便宜 —— 字节的真源就是
// `rc.set`，本缓存不复制它）。
//
// 返回的 `[]byte` 是资源集里的**共享只读切片**（不拷贝）：调用方不得改写。
//
// 返回的 `*apperr.Error` 与 `assets.Set.Read` 同语义：调用方据此判定"不是静态资源"
// （路径非法 / 资源集里没有）。因此**不缓存失败** —— 失败可能只是这个路径不存在，
// 而包里其它路径仍然存在；把"不存在"也缓存下来只会白占条目。
func (rc *releaseContent) Asset(logical string) (assetEntry, []byte, *apperr.Error) {
	if rc == nil {
		return assetEntry{}, nil, apperr.New(apperr.CodeInternal, "缺少生效版本信息")
	}
	if rc.set == nil {
		return assetEntry{}, nil, apperr.New(apperr.CodeInternal, "资源集未加载").
			WithHint("平台没能为该版本建立内存资源集；请联系平台管理员检查该版本的制品")
	}
	meta, cached := rc.srv.releases.asset(rc.key, logical)
	if !cached {
		// 元数据未命中 ⇒ 这一次要为它重算 ETag（sha256）；计数就是"回源派生"的观测点。
		rc.srv.releases.countSourceRead()
	}
	contentType, data, aerr := rc.set.Read(logical)
	if aerr != nil {
		return assetEntry{}, nil, aerr
	}
	if cached {
		return meta, data, nil
	}
	a := assetEntry{ContentType: contentType, ETag: assetETag(rc.appID, rc.rel.Version, logical, data), Size: len(data)}
	rc.srv.releases.putAsset(rc.key, logical, a)
	return a, data, nil
}
