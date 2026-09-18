package appserver

import (
	"container/list"
	"context"
	"errors"
	"sync"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// compiledModuleSizeFactor 把"wasm 字节数"换算成"驻留内存估算"。
//
// 为什么需要它：wazero 的 CompiledModule 在内存里放的是**编译产物**（机器码 +
// 索引/重定位元数据），实测通常是原始字节的数倍。这里取 4 倍并向下取整作为
// 记账口径，方向是"宁可多算不可少算"（与 runtime.CacheUsage 把 *.tmp 也计入同一精神）：
// 少算会让上界变成一个不成立的假设。
//
// ⚠️ 这是**估算**不是精确值；它的用途只是给内存上界一个保守的记账单位。
const compiledModuleSizeFactor = 4

// moduleKey 是编译模块缓存的键。
//
// 为什么带 ReleaseID：版本号在库里是**永久占位**的（§4.1），正常情况下
// (app_id, version) 就唯一确定一份字节；带上 release 行 id 是纵深防御 ——
// 即使有人手工删行后重发同一版本号，也不会命中上一次的编译产物。
type moduleKey struct {
	AppID     string
	Version   string
	ReleaseID int64
}

// compiledResult 是一次冷编译的产出（模块 + 记账体积）。
type compiledResult struct {
	mod  wazero.CompiledModule
	size int64
}

// moduleEntry 是缓存里的一条（带引用计数，用于安全淘汰）。
type moduleEntry struct {
	key  moduleKey
	mod  wazero.CompiledModule
	size int64
	// refs 是当前正在使用该模块的请求数。**只有 refs == 0 的条目才可淘汰**：
	// wazero 允许在实例运行期间 Close 一个 CompiledModule，但"正在实例化的那一刻"
	// 被 Close 会直接失败 —— 淘汰的判据必须比"能不能 Close"更保守。
	refs int
	elem *list.Element
}

// moduleCache 是 `wazero.CompiledModule` 的进程内缓存（LRU + 双维度上限）。
//
// # 为什么必须有它
//
// 不缓存就是**每请求重新编译**：wazero 的磁盘缓存只让"编译"变快（读缓存条目 +
// 反序列化），仍然要走一遍 CompileModule；进程内持有 CompiledModule 才能让
// 后续请求直接进 Instantiate。设计 §4.3 明确"只缓存编译结果，每请求新实例"。
//
// # 上限与淘汰策略
//
// 双维度上限直接复用 limits 的编译缓存两项（CompileCacheMaxBytes 512 MiB /
// CompileCacheMaxEntries 4096）：CompiledModule 的驻留正是 §4.3「内存四笔账」里
// "编译缓存驻留"那一笔，复用同一组数值可以保证"磁盘条目 + 内存条目"整体不越过
// §4.3 的内存预算，且**不引入新旋钮**（数值单一真源，§5.5）。
//
// 淘汰是 LRU（每次命中把条目移到队首，从队尾开始淘汰），并**跳过仍在使用的条目**
// （refs > 0）：极端情况下宁可短暂超限，也不把正在跑的请求关掉。
//
// 并发：同一 key 的并发冷编译被 compileSem（容量 1）串行化 —— 与 §4.3「编译进程
// 并发 1」同一纪律：让 32 个并发冷编译同时展开会把进程内存打爆（编译峰值远大于
// 实例内存）。等待信号量时观察 ctx，排队期间请求超时即返回（不无限等）。
type moduleCache struct {
	mu    sync.Mutex
	items map[moduleKey]*moduleEntry
	ll    *list.List
	bytes int64

	maxBytes   int64
	maxEntries int

	compileSem chan struct{}
}

// newModuleCache 用 limits 的编译缓存上限构造缓存。
func newModuleCache() *moduleCache {
	return &moduleCache{
		items:      map[moduleKey]*moduleEntry{},
		ll:         list.New(),
		maxBytes:   limits.CompileCacheMaxBytes,
		maxEntries: limits.CompileCacheMaxEntries,
		compileSem: make(chan struct{}, limits.CompileConcurrency),
	}
}

// acquire 取一个可用模块；未命中时调用 loader 冷编译（同一时刻只允许一个冷编译）。
//
// 返回的 release 必须调用（通常 defer）：它把引用计数归还，使条目重新可淘汰。
func (c *moduleCache) acquire(ctx context.Context, key moduleKey,
	loader func(context.Context) (compiledResult, *apperr.Error)) (wazero.CompiledModule, func(), *apperr.Error) {

	if mod, release, ok := c.tryAcquire(key); ok {
		return mod, release, nil
	}

	// 冷编译串行化（§4.3 编译并发 1）。等待期间响应 ctx 取消，绝不无限等。
	select {
	case c.compileSem <- struct{}{}:
	case <-ctx.Done():
		return nil, nil, apperr.New(apperr.CodeModuleKilled, "等待编译槽位时请求已取消（客户端断开或墙钟到点）").
			WithCause(ctx.Err())
	}
	defer func() { <-c.compileSem }()

	// 双检：等信号量期间可能已经有别的请求把同一 key 编好了。
	if mod, release, ok := c.tryAcquire(key); ok {
		return mod, release, nil
	}

	res, aerr := loader(ctx)
	if aerr != nil {
		return nil, nil, aerr
	}
	if res.mod == nil {
		return nil, nil, apperr.New(apperr.CodeInternal, "编译模块为空（平台缺陷）")
	}
	return c.insert(key, res)
}

// tryAcquire 命中即引用并返回（未命中返回 ok=false）。
func (c *moduleCache) tryAcquire(key moduleKey) (wazero.CompiledModule, func(), bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.items[key]
	if !ok {
		return nil, nil, false
	}
	e.refs++
	c.ll.MoveToFront(e.elem)
	return e.mod, c.releaser(e), true
}

// releaser 返回归还引用的函数（幂等由 once 之外的写法保证：每个 acquire 只调用一次）。
func (c *moduleCache) releaser(e *moduleEntry) func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			c.mu.Lock()
			if e.refs > 0 {
				e.refs--
			}
			c.mu.Unlock()
		})
	}
}

// insert 放入新编译的模块并引用它（容量超限时淘汰 LRU 尾部）。
func (c *moduleCache) insert(key moduleKey, res compiledResult) (wazero.CompiledModule, func(), *apperr.Error) {
	size := res.size
	if size <= 0 {
		size = 1
	}
	c.mu.Lock()
	if e, ok := c.items[key]; ok {
		// 理论上到不了（信号量已串行化），但重复插入必须无害：用已有的，关掉多的那个。
		e.refs++
		c.ll.MoveToFront(e.elem)
		release := c.releaser(e)
		c.mu.Unlock()
		go func() { _ = res.mod.Close(context.Background()) }()
		return e.mod, release, nil
	}
	e := &moduleEntry{key: key, mod: res.mod, size: size, refs: 1}
	e.elem = c.ll.PushFront(e)
	c.items[key] = e
	c.bytes += size
	victims := c.evictLocked()
	c.mu.Unlock()

	for _, v := range victims {
		// Close 放在锁外：Close 可能触发引擎侧回收，不该占着缓存互斥量。
		_ = v.Close(context.Background())
	}
	return e.mod, c.releaser(e), nil
}

// evictLocked 从 LRU 尾部淘汰直到回到上限内，返回需要在锁外 Close 的模块。
//
// 跳过 refs > 0 的条目；若可达的条目全部在用，则**停止淘汰**（宁可短暂超限）。
func (c *moduleCache) evictLocked() []wazero.CompiledModule {
	var victims []wazero.CompiledModule
	for c.overLocked() {
		var victim *moduleEntry
		for e := c.ll.Back(); e != nil; e = e.Prev() {
			entry := e.Value.(*moduleEntry)
			if entry.refs == 0 {
				victim = entry
				break
			}
		}
		if victim == nil {
			return victims
		}
		c.removeLocked(victim)
		victims = append(victims, victim.mod)
	}
	return victims
}

func (c *moduleCache) overLocked() bool {
	if c.maxEntries > 0 && len(c.items) > c.maxEntries {
		return true
	}
	return c.maxBytes > 0 && c.bytes > c.maxBytes
}

func (c *moduleCache) removeLocked(e *moduleEntry) {
	delete(c.items, e.key)
	c.ll.Remove(e.elem)
	c.bytes -= e.size
}

// closeAll 关闭全部缓存条目（Server.Close 调用）。
func (c *moduleCache) closeAll() error {
	c.mu.Lock()
	mods := make([]wazero.CompiledModule, 0, len(c.items))
	for e := c.ll.Front(); e != nil; e = e.Next() {
		mods = append(mods, e.Value.(*moduleEntry).mod)
	}
	c.items = map[moduleKey]*moduleEntry{}
	c.ll.Init()
	c.bytes = 0
	c.mu.Unlock()

	var errs []error
	for _, m := range mods {
		if err := m.Close(context.Background()); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// has 报告某键当前是否在缓存里（**不**增加引用计数；诊断/测试断言用）。
//
// 存在的意义：测试里用 tryAcquire 当"探针"会漏掉一次 release（引用计数是给淘汰用的），
// 从而把"仍被使用"的状态带进后续断言。
func (c *moduleCache) has(key moduleKey) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	_, ok := c.items[key]
	return ok
}

// size 返回当前缓存条目数与记账字节数（诊断/测试断言用）。
func (c *moduleCache) size() (entries int, bytes int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.items), c.bytes
}

// ===== 冷编译（执行侧）=====

// compileRelease 在**执行进程内**把一个版本的 wasm 编译成 CompiledModule。
//
// 为什么执行进程也允许编译（而不是"只读编译子进程的缓存、编不出来就报错"）：
// 设计 §4.3.1-a 明确把"发布期编译暖不到执行进程时，进程重启后每个应用首个请求
// 付一次冷编译（约 1.9 s）"当作**已知且可接受**的后果 —— 编译缓存命中是优化，
// 不是前提。因此这里按 limits.CompileTimeout 预算就地编译，成功后进模块缓存。
//
// 预算与失败语义（§7.4）：到点 ⇒ COMPILE_TIMEOUT(504)；其余失败 ⇒ INTERNAL
// （发布期 validate 已经真编译过一次，走到这里失败说明平台状态异常；细节只进日志）。
func (s *Server) compileRelease(ctx context.Context, rel *serverstore.WasmRelease) (compiledResult, *apperr.Error) {
	if rel == nil || len(rel.Wasm) == 0 {
		return compiledResult{}, apperr.New(apperr.CodeInternal, "版本制品字节为空（平台故障）").
			WithHint("发布期必须落制品字节；请联系平台管理员检查该版本的归档")
	}
	if int64(len(rel.Wasm)) > int64(limits.WasmMaxBytes) {
		// 纵深防御：发布期已校验体积（§4.2）。
		return compiledResult{}, apperr.New(apperr.CodeWasmTooLarge, "版本制品超过体积上限（平台故障）").
			WithDetail("size", len(rel.Wasm)).
			WithDetail("max", limits.WasmMaxBytes)
	}
	cctx, cancel := context.WithTimeout(ctx, limits.CompileTimeout)
	defer cancel()
	mod, err := s.rt.CompileModule(cctx, rel.Wasm)
	if err != nil {
		if errors.Is(cctx.Err(), context.DeadlineExceeded) {
			return compiledResult{}, apperr.New(apperr.CodeCompileTimeout, "编译应用模块超过预算").
				WithDetail("budget_ms", limits.CompileTimeout.Milliseconds())
		}
		return compiledResult{}, apperr.New(apperr.CodeInternal, "编译应用模块失败（平台故障）").
			WithCause(err).
			WithHint("发布期已校验并编译过该模块；此处失败属于平台状态异常，请查看诊断")
	}
	return compiledResult{mod: mod, size: int64(len(rel.Wasm)) * compiledModuleSizeFactor}, nil
}
