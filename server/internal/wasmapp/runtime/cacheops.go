package runtime

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是**执行侧自持**的磁盘编译缓存运维组件（水位 + 回收 + 周期循环）。
//
// 为什么需要它（审计 R5-A-1，P1）：回收与水位可见性此前**整体挂在编译子系统上** ——
// `cmd/server` 在编译子系统缺席时（默认档 `PICOAI_COMPILE_ISOLATION=auto` 下，缺
// `picoaide-app-compile` 就只打一行日志并把 compiler 置 nil）：
//
//	① 周期回收循环不启动（`startWasmCompileReclaimLoop` 对 nil 直接 return）；
//	② `/readyz` 的 `compile_cache_bytes` / `compile_cache_files` 恒为 0（探针拿到的是
//	   零值快照），也就是说"这棵树在涨"在运维面上**不可见**；
//	③ 全仓没有第二个回收者（`CleanCache` 零生产调用方）。
//
// 而**执行侧照写那棵树**：`runtime.New` 只看 `DataRoot` 就装磁盘缓存（判据见
// cache_mode_test.go 的 `wantDiskWrites: true`）—— 于是"只服务、不发布"的部署里这棵树
// 只涨不降，直到把数据根所在磁盘吃掉，而 `/readyz` 上三个数字全是 0/上限。
//
// 现在：编译器在 ⇒ 唯一回收者仍是 `compile` 的周期循环（P0-a 的三条自愈路径一字不改）；
// 编译器**缺席** ⇒ 由本组件接手同一职责（水位可见性 + 周期回收）。两者**互斥**
// （装配点只在 `compiler == nil` 时创建它，见 cmd/server 的 newWasmCompileCacheOps），
// 同一棵树永远只有一个删除者。
//
// 与 `compile` 侧的关系（唯一实现纪律的边界）：删除逻辑在本包**只有这一份、且只在
// 编译子系统缺席时启用** —— 本包原有的 `PruneCompilationCache` 被删是因为它"与
// compile 侧重复且生产路径零调用点"（审计 P2-3），而本组件有真实且**唯一**的调用场景。
// 两侧的判定口径（扫描根 = 全部分代、先体积后条数、mtime 从旧到新）必须一致，由
// cmd/server 的跨包一致性用例钉住（`TestWasmCacheOpsMatchesCompileSideReclaim`）。
const (
	// DefaultCacheReclaimInterval 是执行侧周期回收的间隔（与 compile 侧同为 5 分钟：
	// 这是"水位收敛速度"与"目录全量 walk 开销"的折中，一次 walk ≈10 ms 量级）。
	DefaultCacheReclaimInterval = 5 * time.Minute

	// DefaultCacheReclaimWriteGrace 是"刚写入的条目"的保护窗口。
	//
	// 为什么执行侧需要一个 compile 侧没有的东西：编译子进程**只在自己的作业里**写缓存，
	// 而 compile 侧的回收在两次作业之间同步执行（单线程 worker ⇒ 不与编译重入）。
	// 执行侧不同 —— 请求路径上的冷编译（appserver → runtime.CompileModule → wazero 的
	// fileCache.Add）与周期回收是两个 goroutine，回收若删掉**正在写**的临时条目，
	// 那次编译就会以 `rename … no such file or directory` 失败（请求 500）。
	// 因此这里的回收**不动**刚写入的条目；若保护窗口内的条目让水位仍超限，如实记一行日志、
	// 下一轮再收（那时它们已经"旧"了）。
	DefaultCacheReclaimWriteGrace = time.Minute
)

// CacheOpsOptions 是执行侧缓存运维组件的装配参数（零值字段一律回落默认）。
type CacheOpsOptions struct {
	// DataRoot 是平台数据根；扫描根 = `<DataRoot>/_compile-cache`（**含所有分代**）。
	DataRoot string
	// MaxBytes / MaxEntries 是回收阈值；非正数 ⇒ limits 的编译期缺省。
	MaxBytes   int64
	MaxEntries int
	// Interval 是周期回收间隔；非正数 ⇒ DefaultCacheReclaimInterval。
	Interval time.Duration
	// WriteGrace 是"刚写入的条目"保护窗口；0 ⇒ DefaultCacheReclaimWriteGrace；
	// 负数 ⇒ 不保护（取消该保护，判据用例用它构造"回收立刻生效"）。
	WriteGrace time.Duration
	// Logger 记水位不可读/回收失败/每轮结果；nil ⇒ 不记。
	Logger func(format string, args ...any)
	// Now 可注入时钟（仅测试用）。
	Now func() time.Time
}

// CacheOps 是执行侧的磁盘编译缓存运维组件（水位 + 回收 + 周期循环）。
//
// 并发：Usage/Reclaim 可并发调用（Reclaim 内部串行化，见 mu）；周期循环与显式调用
// 共用同一把锁 —— 与 compile 侧"三个触发点共用 reclaimMu"同一条纪律，避免两个删除者
// 各扫一遍、各删一遍（重复删除的条目第二次报 ENOENT 会被容忍，但日志与计数会失真）。
type CacheOps struct {
	dataRoot string
	scanRoot string
	maxBytes int64
	maxEntry int
	interval time.Duration
	grace    time.Duration
	logf     func(format string, args ...any)
	now      func() time.Time

	mu       sync.Mutex
	lastRecl time.Time
	// loggedScanErr 让"水位读不出来"只记一次（周期循环会反复读，不该刷日志）。
	loggedScanErr atomic.Bool

	stop     chan struct{}
	loopOnce sync.Once
	loopWG   sync.WaitGroup
	running  atomic.Bool
	closed   atomic.Bool
}

// NewCacheOps 构造执行侧缓存运维组件（nil 表示数据根为空 ⇒ 没有磁盘缓存可管）。
func NewCacheOps(opt CacheOpsOptions) *CacheOps {
	if strings.TrimSpace(opt.DataRoot) == "" {
		return nil
	}
	maxBytes := opt.MaxBytes
	if maxBytes <= 0 {
		maxBytes = int64(limits.CompileCacheMaxBytes)
	}
	maxEntries := opt.MaxEntries
	if maxEntries <= 0 {
		maxEntries = limits.CompileCacheMaxEntries
	}
	interval := opt.Interval
	if interval <= 0 {
		interval = DefaultCacheReclaimInterval
	}
	grace := opt.WriteGrace
	switch {
	case grace == 0:
		grace = DefaultCacheReclaimWriteGrace
	case grace < 0:
		grace = 0
	}
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	return &CacheOps{
		dataRoot: opt.DataRoot,
		// 扫描根 = 缓存根 `_compile-cache/`（**含所有分代**），与 compile 侧
		// `cacheScanRoot()` 的配置分支逐字同口径：升级 wazero 后旧一代永不再被命中，
		// 却仍占磁盘；只看当前分代会让"缓存有界"只在单代内成立。
		scanRoot: filepath.Dir(CompileCacheDir(opt.DataRoot)),
		maxBytes: maxBytes,
		maxEntry: maxEntries,
		interval: interval,
		grace:    grace,
		logf:     opt.Logger,
		now:      now,
		stop:     make(chan struct{}),
	}
}

// ScanRoot 返回扫描根（诊断/判据用）。
func (o *CacheOps) ScanRoot() string {
	if o == nil {
		return ""
	}
	return o.scanRoot
}

// MaxBytes / MaxEntries 返回生效阈值（进 /readyz 的 compile_cache_limit_bytes）。
func (o *CacheOps) MaxBytes() int64 {
	if o == nil {
		return 0
	}
	return o.maxBytes
}

// MaxEntries 返回生效条目上限。
func (o *CacheOps) MaxEntries() int {
	if o == nil {
		return 0
	}
	return o.maxEntry
}

// Interval 返回周期回收间隔（诊断用）。
func (o *CacheOps) Interval() time.Duration {
	if o == nil {
		return 0
	}
	return o.interval
}

// Usage 统计缓存树（含所有分代）的体积与条目数。
//
// 目录不存在 ⇒ (0, 0, nil)：空树不是错误（首次部署就是这样），而"读不出来"是错误 ——
// 两者绝不能同形（那正是本条审计要消灭的形态：缺席时自报 0 与"真的是 0"不可区分）。
func (o *CacheOps) Usage() (bytes int64, entries int, err error) {
	if o == nil {
		return 0, 0, nil
	}
	files, err := cacheFiles(o.scanRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, 0, nil
		}
		o.logScanErrOnce(err)
		return 0, 0, err
	}
	for _, f := range files {
		bytes += f.size
	}
	return bytes, len(files), nil
}

// UsageOrZero 是 Usage 的"探针友好"形态：读不出来时给 0 并把原因记进日志。
//
// 探针（/readyz）没有"水位不可读"这条 reason（登记表里没有这一条，而新增 reason 必须
// 先回答"谁来解除它"）—— 因此这里不伪造数字：读不出来就是 0，而**错误进服务端日志**。
func (o *CacheOps) UsageOrZero() (bytes int64, entries int) {
	b, e, _ := o.Usage()
	return b, e
}

// logScanErrOnce 记一次水位不可读（周期性读不该刷日志）。
func (o *CacheOps) logScanErrOnce(err error) {
	if o == nil || o.logf == nil || !o.loggedScanErr.CompareAndSwap(false, true) {
		return
	}
	o.logf("runtime: ⚠️ 编译缓存水位不可读（%s）：%v", o.scanRoot, err)
}

// Reclaim 回收缓存，使体积与条目数**同时**降到阈值内。
//
// 语义与 compile.reclaimLocked 一致（先体积后条数一起判、mtime 从旧到新、单条删除失败
// 不中断整体回收并带回 err），只多一条**写保护窗口**（见 DefaultCacheReclaimWriteGrace
// 的注释：执行侧的回收可能与在飞编译并发）。返回 (删除条目数, 释放字节数, 错误)。
func (o *CacheOps) Reclaim() (removed int, freed int64, err error) {
	if o == nil {
		return 0, 0, nil
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	o.lastRecl = o.now()
	return o.reclaimLocked()
}

// reclaimLocked 是回收实现体（调用方必须持有 mu）。
func (o *CacheOps) reclaimLocked() (removed int, freed int64, err error) {
	files, err := cacheFiles(o.scanRoot)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return 0, 0, nil
		}
		return 0, 0, err
	}
	var total int64
	for _, f := range files {
		total += f.size
	}
	count := len(files)
	if total <= o.maxBytes && count <= o.maxEntry {
		return 0, 0, nil
	}
	sort.Slice(files, func(i, j int) bool {
		if !files[i].modTime.Equal(files[j].modTime) {
			return files[i].modTime.Before(files[j].modTime)
		}
		return files[i].path < files[j].path // 稳定序（同 mtime 时行为可复现）
	})
	cutoff := o.now().Add(-o.grace)
	var protected int
	for _, f := range files {
		if total <= o.maxBytes && count <= o.maxEntry {
			break
		}
		if o.grace > 0 && f.modTime.After(cutoff) {
			// 可能正在写入：本轮不动它（见 DefaultCacheReclaimWriteGrace）。
			protected++
			continue
		}
		if rerr := os.Remove(f.path); rerr != nil {
			// 单条失败不中断整体回收（否则一条权限异常就让整棵树永远超限）。
			if !os.IsNotExist(rerr) {
				err = fmt.Errorf("删除缓存条目 %s 失败: %w", filepath.Base(f.path), rerr)
			}
			continue
		}
		removed++
		freed += f.size
		total -= f.size
		count--
	}
	if protected > 0 && o.logf != nil {
		o.logf("runtime: 编译缓存回收跳过 %d 条写入保护窗口（< %v）内的条目（当前 %d 字节 / 上限 %d 字节）",
			protected, o.grace, total, o.maxBytes)
	}
	return removed, freed, err
}

// StartLoop 启动**不依赖编译作业**的周期回收循环（幂等）。
//
// 契约（与 compile.StartReclaimLoop 一致，便于运维用同一套口径理解两侧）：
//   - **启动即强制回收一次**（部署启动时缓存可能已经超限，等一个 interval 会让水位在
//     运维面上多"红"一个周期）；
//   - 之后每 interval 一次；每轮都记一行日志（含"什么都没删"的轮次）—— 这是运维判断
//     "周期回收到底有没有在跑"的唯一证据；
//   - ctx 结束或 Close() 时退出；失败只记日志，绝不 panic/阻塞任何调用方。
func (o *CacheOps) StartLoop(ctx context.Context) {
	if o == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	o.loopOnce.Do(func() {
		o.running.Store(true)
		o.loopWG.Add(1)
		go func() {
			defer o.loopWG.Done()
			defer o.running.Store(false)
			ticker := time.NewTicker(o.interval)
			defer ticker.Stop()
			o.reclaimOnce("启动")
			for {
				select {
				case <-ctx.Done():
					o.logfLine("runtime: 编译缓存周期回收（执行侧）退出：%v", ctx.Err())
					return
				case <-o.stop:
					return
				case <-ticker.C:
					o.reclaimOnce("周期")
				}
			}
		}()
	})
}

// LoopRunning 报告周期循环此刻是否在跑（判据用：R5-A-1 的补判据②要求"周期回收仍在跑"
// 这件事可观测，而不是只有"源码里有一行启动调用"）。
func (o *CacheOps) LoopRunning() bool {
	if o == nil {
		return false
	}
	return o.running.Load()
}

// Close 停止周期循环并等待它收尾（幂等、有界）。
func (o *CacheOps) Close() {
	if o == nil {
		return
	}
	if o.closed.CompareAndSwap(false, true) {
		close(o.stop)
	}
	done := make(chan struct{})
	go func() {
		o.loopWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		o.logfLine("runtime: 编译缓存周期回收循环未在 5s 内退出")
	}
}

// reclaimOnce 执行一轮回收并把结果写进日志（周期循环的唯一入口）。
func (o *CacheOps) reclaimOnce(trigger string) {
	if o == nil {
		return
	}
	started := o.now()
	removed, freed, err := o.Reclaim()
	bytes, entries, uerr := o.Usage()
	took := o.now().Sub(started)
	level := fmt.Sprintf("当前 %d 字节 / 上限 %d 字节、%d 条 / %d 条",
		bytes, o.maxBytes, entries, o.maxEntry)
	if uerr != nil {
		level = "当前水位不可读: " + uerr.Error()
	}
	if err != nil {
		o.logfLine("runtime: 编译缓存回收（执行侧/%s）失败：%v（本次删除 %d 条 / 释放 %d 字节；%s）",
			trigger, err, removed, freed, level)
		return
	}
	o.logfLine("runtime: 编译缓存回收（执行侧/%s）删除 %d 条 / 释放 %d 字节（%s），用时 %v",
		trigger, removed, freed, level, took)
}

// logfLine 是 nil 安全的日志出口。
func (o *CacheOps) logfLine(format string, args ...any) {
	if o == nil || o.logf == nil {
		return
	}
	o.logf(format, args...)
}
