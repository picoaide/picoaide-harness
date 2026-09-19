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
// # 为什么可以缓存、以及缓存的到底是什么
//
// 抽取出来的资源在 `(app_id, version, path)` 下**不可变**：发布期 `assets.Write`
// 拒绝覆盖（§4.2「要改内容只能发新版」）。因此对同一个 `release_id`：
//
//   - 资源的**字节**、`content-type`、`ETag` 与解析后的 `picoaide.app.json` 都是常量；
//   - `ETag` 仍然与内容绑定（首次读到字节时按 `hash(app_id ‖ version ‖ path ‖ sha256(content))`
//     算出并随条目一起缓存）⇒ 换内容/换版本必然换 ETag（键不同 + 摘要不同）。
//
// 于是"`If-None-Match` 命中就 304"这条路径只需要缓存里的 ETag：**不读盘、不算哈希**
// （R1-rt-2 的判据），而 200 路径在缓存命中时连 `Read` 也省掉（R1-rt-3）。
//
// # 有界性（**不许引入无界内存**）
//
// 单一全局 LRU，两个硬上限（数值真源在 limits，见 ReleaseCacheMaxBytes 的注释）：
//
//   - `ReleaseCacheMaxBytes`：缓存字节总量；
//   - `ReleaseCacheMaxReleases`：`(app_id, release_id)` 条目数。
//
// 越界即按 LRU **整条**释放；单条资源超过字节上限一半时只缓存元数据（不缓存字节）；
// 唯一剩下的那一条不逐出（避免"刚写进去就被赶出来"的自逐），因此硬上界是
// `ReleaseCacheMaxBytes + SectionTotalMaxBytes + maxReleases × 元数据`。
// 另有空闲淘汰（与编译模块缓存同一个 TTL）：长时间没人访问的应用会被释放。
//
// 上面那个 `+ SectionTotalMaxBytes` 曾经只是**跨模块假设**（"单个 release 的资源总量
// ≤ 自定义段总量上限"由 wasmmod 校验，本包没有任何断言把它绑住）：现在它有两道护栏 ——
// `enforceByteBoundLocked` 让超额那一份退化成元数据（上界回到 `maxBytes` 以内，不依赖
// 任何外部常量），`TestReleaseCache_BudgetCoversSingleReleaseWorstCase` 把两个常量绑在一起
// （调大段总量上限而忘了算这笔账时会红）。
//
// # 失效（换版本 / 下架 / 冻结 / 删除 / 逐出）
//
//   - **换版本**：键含 `release_id` ⇒ 新版本天然不命中；并且新条目的第一次插入会
//     丢掉该应用**其它 release** 的条目（`dropOtherReleasesLocked`），旧版本的字节
//     不会滞留；
//   - **下架 / 冻结 / 删除 / 手动逐出**：四条路都会经 `appserver.Server.EvictApp`
//     （`api` 的处置钩子已接线）⇒ `evictApp` 清空该应用的全部条目。
//
// 本缓存的读者只会拿到**值拷贝**（`assetEntry` / `appcfg.Config`），共享的只有
// `Data []byte`——它一旦写入就不再修改，因此并发读安全。

// releaseKey 是缓存键：`(app_id, release_id)`。
//
// 为什么用 release_id 而不是 version 字符串：release_id 是版本行的主键，版本回滚、
// 同版本重发（不允许）等情况都不会与另一行共用键；version 只进 ETag 的摘要。
type releaseKey struct {
	AppID     string
	ReleaseID int64
}

// assetEntry 是一个静态资源的缓存条目（**值语义**：调用方拿到的是拷贝）。
type assetEntry struct {
	// ContentType 是 assets 按扩展名推导的 content-type。
	ContentType string
	// ETag 是强 ETag（带引号），与内容绑定。
	ETag string
	// Size 是资源字节数（= len(Data) 当 BytesCached；否则是读盘时看到的长度）。
	Size int
	// Data 是资源字节；仅当 BytesCached 为真时有效（单条超预算时只缓存元数据）。
	Data []byte
	// BytesCached 报告 Data 是否可用（false = 只有元数据，正文要回源读盘）。
	BytesCached bool
}

// releaseEntry 是一个 `(app_id, release_id)` 的缓存条目。
type releaseEntry struct {
	key    releaseKey
	assets map[string]assetEntry
	// bytes 是本条目持有的资源字节数（用于整条逐出时回退总量）。
	bytes int64

	cfg    appcfg.Config
	cfgErr *apperr.Error
	cfgSet bool
	// cfgAt 是这份配置**读盘成功**的时刻（TTL 复验用它；由注入的时钟给）。
	//
	// 存在的理由（R2-CA-1）：配置是准入判定的输入，而它在磁盘上**不是**只随版本变化 ——
	// 文件可能被平台故障/人为操作删掉或改坏。没有这个时刻时，暖缓存下的删除/损坏
	// 永远不被察觉（"配置读不到 = 500 平台故障"这条 fail-loud 只在冷路径成立）。
	cfgAt time.Time

	// lastUsed 是最近一次命中/写入的时间（空闲淘汰用它；由注入的时钟给）。
	lastUsed time.Time
	// lruElem 是本条目在 LRU 链表里的位置（nil = 已摘除）。
	lruElem *list.Element
}

// releaseCacheStats 是缓存的瞬时计数（护栏与 perf 探针用，不在请求路径上读）。
type releaseCacheStats struct {
	Entries     int
	Bytes       int64
	AssetHits   int64
	AssetMisses int64
	CfgHits     int64
	CfgMisses   int64
	// DiskReads 是真正落到磁盘的**资源/配置读取**次数 ——
	// "304 不读盘"这条判据的行为级观测点（R1-rt-2 的护栏读它）。
	DiskReads int64
	// Evictions 是 LRU/空闲淘汰掉的条目数（含换版本失效）。
	Evictions int64
}

// releaseCache 是有界的 `(app_id, release_id)` 级缓存（见文件头注释）。
type releaseCache struct {
	mu         sync.Mutex
	maxBytes   int64
	maxEntries int
	bytes      int64
	entries    map[releaseKey]*releaseEntry
	// lru 的 front = 最近使用；元素值是 *releaseEntry。
	lru *list.List
	now func() time.Time

	assetHits, assetMisses int64
	cfgHits, cfgMisses     int64
	diskReads              int64
	evictions              int64
}

// newReleaseCache 创建缓存。上限 0 及以下 ⇒ 用 limits 的真源（生产路径只走这一条）。
func newReleaseCache(maxBytes int64, maxEntries int, now func() time.Time) *releaseCache {
	if maxBytes <= 0 {
		maxBytes = limits.ReleaseCacheMaxBytes
	}
	if maxEntries <= 0 {
		maxEntries = limits.ReleaseCacheMaxReleases
	}
	if now == nil {
		now = time.Now
	}
	return &releaseCache{
		maxBytes:   maxBytes,
		maxEntries: maxEntries,
		entries:    make(map[releaseKey]*releaseEntry),
		lru:        list.New(),
		now:        now,
	}
}

// asset 查一个资源的缓存条目（**不读盘**）。命中即把它提到 LRU 头部。
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

// putAsset 写入一个资源条目（元数据 + 可选字节），并按上限淘汰。
func (c *releaseCache) putAsset(k releaseKey, logical string, a assetEntry) {
	if c == nil {
		return
	}
	if a.Size < 0 {
		a.Size = len(a.Data)
	}
	// 单条超过字节上限的一半 ⇒ 只缓存元数据：否则一份巨物会把整个缓存挤空，
	// 而 304 复验只需要 ETag（元数据），正文回源读一次并不比被挤掉更差。
	if int64(len(a.Data)) > c.maxBytes/2 {
		a.Data, a.BytesCached = nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.ensureLocked(k)
	if old, ok := e.assets[logical]; ok {
		e.bytes -= int64(len(old.Data))
		c.bytes -= int64(len(old.Data))
	}
	e.assets[logical] = a
	if a.BytesCached {
		e.bytes += int64(len(a.Data))
		c.bytes += int64(len(a.Data))
	}
	e.lastUsed = c.now()
	c.evictLocked()
	c.enforceByteBoundLocked()
}

// enforceByteBoundLocked 给"唯一那条不逐出"造成的超额补一道**结构性**上界（R2-CA-5）。
//
// 背景：`evictLocked` 刻意不逐出最后一条（否则"刚写进去就被自己赶出来"，缓存永不命中），
// 代价是允许一份超额。文件头把这个超额写成"≤ 单个 release 的资源总量"，而那个"≤"来自
// **另一个模块**的校验（wasm 自定义段总量 ≤ `SectionTotalMaxBytes`）—— 本包此前没有任何
// 断言把它绑住：段总量上限一旦被调大（或资源改走别的抽取通道），单条自身就可能超过
// `maxBytes`，此时 `c.bytes` 会无界超出文档承诺的硬上界。
//
// 这里不依赖那条跨模块假设：淘汰跑完仍有超额 ⇒ 只可能是唯一剩下的那条自己超了预算，
// 把它退化成"只缓存元数据"（304 复验只要 ETag，正文回源读盘），上界回到 `maxBytes` 以内。
// 与 putAsset 里"单条超预算一半只缓存元数据"是同一种降级，只是判据从"单条 vs 一半"改成
// "整条 vs 全部"。
func (c *releaseCache) enforceByteBoundLocked() {
	if c.bytes <= c.maxBytes {
		return
	}
	front := c.lru.Front()
	if front == nil {
		return
	}
	e, _ := front.Value.(*releaseEntry)
	if e == nil {
		return
	}
	for logical, a := range e.assets {
		if !a.BytesCached {
			continue
		}
		a.Data, a.BytesCached = nil, false
		e.assets[logical] = a
	}
	c.bytes -= e.bytes
	e.bytes = 0
	if c.bytes < 0 {
		c.bytes = 0
	}
}

// ConfigRevalidateTTL 是"解析后的应用配置"在缓存里的**有效期**（R2-CA-1）。
//
// 资源字节在 `(app_id, release_id, path)` 下不可变，但**配置文件的在盘存在性**不是：
// 目录被换过、文件被删掉/改坏都属于平台故障，而平台对它的承诺是 fail-loud（读不到 ⇒
// 500，绝不按匿名放行）。若配置像资源字节那样无限期缓存，暖缓存下这次故障就永远不被
// 察觉（宿主用旧配置准入、应用自己 `assets.read` 拿到 404 ⇒ 两边对"配置是什么"分叉）。
//
// 因此成功的解析结果只缓存本值：到期后第一个请求重新读盘 + 解析（每个应用每窗口一次，
// 相对"每请求都读"仍然省掉了绝大多数开销），故障与修复都在一个窗口内可见。
//
// 取 5 分钟与 `staticCacheMaxAge`（浏览器侧资源缓存窗口）同量级：两者都是"平台状态多久
// 必须被重新确认一次"的口径，排障时只有一个数字要记。
const ConfigRevalidateTTL = 5 * time.Minute

// config 查解析后的应用配置（**不读盘**；超过有效期按未命中处理，见 ConfigRevalidateTTL）。
func (c *releaseCache) config(k releaseKey) (appcfg.Config, *apperr.Error, bool) {
	if c == nil {
		return appcfg.Config{}, nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[k]
	if !ok || !e.cfgSet || c.now().Sub(e.cfgAt) > ConfigRevalidateTTL {
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

// putConfig 写入解析结果。
//
// **只缓存成功**（R2-CA-1）：失败不是常量 —— EIO/EMFILE/挂载抖动/文件被删都是可以
// **就地修好**的（把文件恢复原样即可），而"读失败"一旦进缓存就再没有任何请求会去
// 重读它：故障被固化成持续 500，且因为命中（含命中失败）会刷新 lastUsed，连空闲淘汰
// 也永不触发（越多请求越修不好），唯一出口只剩 EvictApp/重启。
//
// 与 `Asset()` 对失败的处理对称（"失败可能只是这一次的状态，不缓存失败"）。
func (c *releaseCache) putConfig(k releaseKey, cfg appcfg.Config, err *apperr.Error) {
	if c == nil || err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e := c.ensureLocked(k)
	e.cfg, e.cfgErr, e.cfgSet = cfg, nil, true
	e.cfgAt = c.now()
	e.lastUsed = e.cfgAt
	c.evictLocked()
}

// evictApp 丢掉某应用的全部条目（下架 / 冻结 / 删除 / 逐出时的唯一入口）。
//
// 返回被丢掉的条目数与**这些条目实际持有的资源字节数**（R2-CA-2：调用方要拿它记账 ——
// 此前只回条目数，2 MiB 的释放被写成"记账 0 KiB"，容量核算与内存归还的入参都失真）。
func (c *releaseCache) evictApp(appID string) (int, int64) {
	if c == nil || appID == "" {
		return 0, 0
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	var freed int64
	for k, e := range c.entries {
		if k.AppID != appID {
			continue
		}
		freed += e.bytes
		c.removeLocked(e)
		n++
	}
	return n, freed
}

// sweepIdle 释放空闲超过 idle 的条目（与编译模块缓存同一个后台循环调用）。
func (c *releaseCache) sweepIdle(idle time.Duration) (int, int64) {
	if c == nil || idle <= 0 {
		return 0, 0
	}
	cutoff := c.now().Add(-idle)
	c.mu.Lock()
	defer c.mu.Unlock()
	var n int
	var freed int64
	for _, e := range c.entries {
		if e.lastUsed.After(cutoff) {
			continue
		}
		freed += e.bytes
		c.removeLocked(e)
		n++
	}
	return n, freed
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
		Bytes:       c.bytes,
		AssetHits:   c.assetHits,
		AssetMisses: c.assetMisses,
		CfgHits:     c.cfgHits,
		CfgMisses:   c.cfgMisses,
		DiskReads:   c.diskReads,
		Evictions:   c.evictions,
	}
}

// countDiskRead 记一次真正的资源读盘（`assets.Store.Read`）。
func (c *releaseCache) countDiskRead() {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.diskReads++
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
// 这一步负责的是"旧版本的字节不滞留"（内存及时释放）。
func (c *releaseCache) dropOtherReleasesLocked(k releaseKey) {
	for old, e := range c.entries {
		if old == k || old.AppID != k.AppID {
			continue
		}
		c.removeLocked(e)
	}
}

// evictLocked 把总量压回上限内。
//
// **不逐出唯一剩下的那一条**：否则"刚写进去就被自己赶出来"会让缓存永不命中。
// 代价是允许一份超额，硬上界见文件头注释。
func (c *releaseCache) evictLocked() {
	for (c.bytes > c.maxBytes || len(c.entries) > c.maxEntries) && c.lru.Len() > 1 {
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
	c.bytes -= e.bytes
	if c.bytes < 0 {
		c.bytes = 0
	}
	if e.lruElem != nil {
		c.lru.Remove(e.lruElem)
		e.lruElem = nil
	}
	c.evictions++
}

// ===== 每请求视图 =====

// releaseContent 是一次请求对某个 `(app, release)` 的视图：**缓存优先，未命中才读盘**。
//
// 资源目录本身仍然每请求打开（`openAssets`，三次 Lstat）：目录存在性是**平台状态**
// 断言（缺失 = 500 平台故障，见 ServeApp 步骤⑤），不能因为"缓存里有字节"就跳过。
// 真正贵的三项 —— 资源读盘、SHA-256、配置读盘 + 解析（实测合计 ≈225 µs/200 KiB 资源）——
// 由本缓存放掉。
//
// 生命周期：一个请求一个实例（不跨请求共享），字段不可并发访问。
type releaseContent struct {
	srv   *Server
	appID string
	rel   *serverstore.WasmRelease
	key   releaseKey
	store *assets.Store

	cfg    appcfg.Config
	cfgErr *apperr.Error
	cfgSet bool
}

// openReleaseContent 为一次请求建立视图。store 是调用方已打开的资源目录
// （`openAssets` 的结果，可为 nil —— 那时任何读盘路径都会按平台故障处理）。
func (s *Server) openReleaseContent(appID string, rel *serverstore.WasmRelease, store *assets.Store) *releaseContent {
	if rel == nil {
		return nil
	}
	return &releaseContent{
		srv:   s,
		appID: appID,
		rel:   rel,
		key:   releaseKey{AppID: appID, ReleaseID: rel.ID},
		store: store,
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
	cfg, err := loadAppConfig(rc.store)
	rc.srv.releases.countDiskRead()
	rc.srv.releases.putConfig(rc.key, cfg, err)
	rc.cfg, rc.cfgErr, rc.cfgSet = cfg, err, true
	return cfg, err
}

// CachedAsset 只查缓存，**绝不读盘**（304 复验走这条）。
func (rc *releaseContent) CachedAsset(logical string) (assetEntry, bool) {
	if rc == nil {
		return assetEntry{}, false
	}
	return rc.srv.releases.asset(rc.key, logical)
}

// Asset 返回资源（元数据 + 字节），缓存优先；未命中才读盘并回填。
//
// 返回的 `*apperr.Error` 与 `assets.Store.Read` 同语义：调用方据此判定"不是静态资源"
// （存在性/路径/超限），因此**不缓存失败**（失败可能只是这个路径不存在，而包里其它
// 路径仍然存在；把"不存在"也缓存下来只会白占条目，且下次仍要判一遍）。
func (rc *releaseContent) Asset(logical string) (assetEntry, *apperr.Error) {
	if rc == nil {
		return assetEntry{}, apperr.New(apperr.CodeInternal, "缺少生效版本信息")
	}
	meta, metaOK := rc.srv.releases.asset(rc.key, logical)
	if metaOK && meta.BytesCached {
		return meta, nil
	}
	if rc.store == nil {
		return assetEntry{}, apperr.New(apperr.CodeInternal, "资源目录未打开")
	}
	rc.srv.releases.countDiskRead()
	contentType, data, aerr := rc.store.Read(logical)
	if aerr != nil {
		return assetEntry{}, aerr
	}
	etag := assetETag(rc.appID, rc.rel.Version, logical, data)
	if metaOK && meta.ETag != "" {
		// 只缓存了元数据（单条超预算）：ETag 复用缓存里那一份 —— 同一份不可变内容
		// 算出的摘要必然相同，复用可以避免"同一资源两个 ETag"的任何可能。
		etag = meta.ETag
	}
	a := assetEntry{ContentType: contentType, ETag: etag, Size: len(data), Data: data, BytesCached: true}
	rc.srv.releases.putAsset(rc.key, logical, a)
	return a, nil
}
