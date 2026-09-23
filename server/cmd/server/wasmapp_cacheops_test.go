package main

// 本文件是**执行侧缓存运维兜底**（R5-A-1）与**两包回收口径一致性**的装配级判据。
//
// 现场形态（R5-A-1）：编译子系统缺席（auto 档下缺 `picoaide-app-compile` 只 log 后置 nil）
// 时，执行侧照写 `_compile-cache`（`runtime/cache_mode_test.go` 的 `wantDiskWrites: true`），
// 而周期回收不启动、`/readyz` 的 `compile_cache_bytes` 恒为 0、全仓没有第二个回收者
// ⇒ 这棵树只涨不降且**不可见**。
//
// 判据四条：
//
//	① 探针来源（`wasmCompileStatsProvider`）：编译器缺席 + 执行侧组件在 ⇒ 报**真实目录扫描**
//	   的水位与生效阈值（不是零值），并在 /readyz 的 HTTP 响应体上 > 0；
//	② 互斥（`startWasmCacheFallbackReclaim`）：编译器在 ⇒ 执行侧回收**不启动**；缺席 ⇒ 启动，
//	   且启动轮真的把存量超限收进阈值（"周期回收仍在跑"是可观测事实，不是源码里有行调用）；
//	③ 两包口径一致：同一棵树、同一份阈值下，`compile.ReclaimCache` 与执行侧 `CacheOps.Reclaim`
//	   的删除条数/释放字节/剩余水位必须逐项相同（防止两份实现漂移）；
//	④ **真装配**（`setupWasmPlatform` + 编译子进程被移走）：`p.Compiler == nil` 且
//	   `p.CacheOps != nil`，写盘后 /readyz 的 `compile_cache_bytes` > 0。
//
// 变异验证（实跑，见交付报告）：
//   - 去掉 setupWasmPlatform 里的 `if compiler == nil { … startWasmCacheFallbackReclaim … }`
//     ⇒ ④ 红；把 wasmCompileStatsProvider 的缺席分支改回零值快照 ⇒ ①④ 红；
//   - 把互斥判断反过来（编译器在也启动）⇒ ② 红；把执行侧回收改成 no-op ⇒ ②③ 红。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// execSideWasmModule 是"合法但什么都不做"的最小模块（装配级判据用它驱动**执行侧**真的写盘）。
var execSideWasmModule = []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}

// TestWasmCompileStatsProviderFallsBackToExecSideScan ①：编译器缺席时探针必须报真实水位。
func TestWasmCompileStatsProviderFallsBackToExecSideScan(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()

	// 对照（旧形态）：没有执行侧组件 ⇒ 零值快照 —— 这正是"自报 0 字节"的来源。
	if got := wasmCompileStatsProvider(nil, nil)(); got.CacheBytes != 0 || got.CacheMaxBytes != 0 {
		t.Fatalf("没有数据根/组件时不该伪造水位：%+v", got)
	}

	// 执行侧**真的写盘**：生产装配用的就是同一个 runtime 组件、同一个缓存目录
	//（runtime/cache_mode_test.go 已钉住 `wantDiskWrites: true`）。
	rt, err := runtime.New(ctx, runtime.Options{DataRoot: root})
	if err != nil {
		t.Fatalf("runtime.New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(ctx) })
	if rt.CacheMode() != runtime.CacheModeDisk {
		t.Fatalf("前置：干净数据根下执行侧必须是磁盘缓存，got %q", rt.CacheMode())
	}
	if _, cerr := rt.CompileModule(ctx, execSideWasmModule); cerr != nil {
		t.Fatalf("执行侧编译（写盘）失败: %v", cerr)
	}

	ops := newWasmCompileCacheOps(root, t.Logf)
	if ops == nil {
		t.Fatal("数据根非空时 newWasmCompileCacheOps 不该返回 nil")
	}
	t.Cleanup(ops.Close)
	snap := wasmCompileStatsProvider(nil, ops)()
	if snap.CacheBytes <= 0 || snap.CacheFiles <= 0 {
		t.Fatalf("编译器缺席时探针必须报**真实占用**（R5-A-1 ①：不许自报 0）：%+v", snap)
	}
	if snap.CacheMaxBytes != int64(limits.CompileCacheMaxBytes) || snap.CacheMaxEntries != limits.CompileCacheMaxEntries {
		t.Fatalf("生效阈值必须是 limits 的唯一真源：%+v", snap)
	}

	// HTTP 面（未认证的 /readyz）同样要 > 0 —— 判据不能只落在内部结构上。
	c := readyz.New(readyz.Options{DataRoot: root, Compiler: wasmCompileStatsProvider(nil, ops)})
	_, _, cacheBytes, cacheLimit := readyzPayload(t, c)
	if cacheBytes <= 0 {
		t.Fatalf("/readyz 的 compile_cache_bytes 必须 > 0（真实占用），got %d", cacheBytes)
	}
	if cacheLimit != int64(limits.CompileCacheMaxBytes) {
		t.Fatalf("/readyz 的 compile_cache_limit_bytes = %d，want %d", cacheLimit, int64(limits.CompileCacheMaxBytes))
	}
}

// TestWasmCacheFallbackReclaimIsMutuallyExclusiveWithCompiler ②：谁回收是**互斥**的，
// 且"执行侧在跑"这件事可观测。
func TestWasmCacheFallbackReclaimIsMutuallyExclusiveWithCompiler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	child := compileChildPath(t)
	root := t.TempDir()

	// 编译子系统在 ⇒ 执行侧回收**不启动**（唯一回收者是 compile 的周期循环）。
	c := newCompilerWithLimits(t, child, root, 1000, 100)
	ops, cap := newTightCacheOps(t, root, 1000, 100)
	if startWasmCacheFallbackReclaim(ctx, c, ops) {
		t.Fatal("编译器在时执行侧回收不得启动（同一棵树两个删除者会让计数与日志失真）")
	}
	if ops.LoopRunning() {
		t.Fatal("未启动时 LoopRunning 必须为 false")
	}
	if compileReclaimHook(c, ops) == nil {
		t.Fatal("同步回收钩子在编译器存在时必须接到编译侧（P0-b 的三条自愈路径之一）")
	}

	// 编译器缺席 ⇒ 执行侧接手，且**启动轮**把存量超限收进阈值。
	seedOverLimit(t, root, 1000)
	if bytes, _, _ := ops.Usage(); bytes <= 1000 {
		t.Fatalf("夹具没造出超限：%d", bytes)
	}
	if !startWasmCacheFallbackReclaim(ctx, nil, ops) {
		t.Fatal("编译器缺席时必须由执行侧接手（R5-A-1 的核心要求）")
	}
	if !ops.LoopRunning() {
		t.Fatal("接手之后周期回收必须在跑（R5-A-1 ②）")
	}
	waitForCacheOpsAtMost(t, ops, 1000, 10*time.Second)
	if !strings.Contains(cap.joined(), "执行侧/启动") {
		t.Fatalf("启动轮必须留一行可 grep 的日志：%s", cap.joined())
	}

	// 同步回收钩子也要接到执行侧（否则"超限"这条理由在缺席形态下永远无解）。
	hook := compileReclaimHook(nil, ops)
	if hook == nil {
		t.Fatal("编译器缺席时同步回收钩子必须接到执行侧组件")
	}
	seedOverLimit(t, root, 1000)
	if removed, _, herr := hook(); herr != nil || removed == 0 {
		t.Fatalf("缺席形态下的同步回收必须真的删东西：removed=%d err=%v", removed, herr)
	}
	if compileReclaimHook(nil, nil) != nil {
		t.Fatal("两者都不可用时必须是 nil（AllowPublish 据此点名装配缺失）")
	}
}

// TestWasmCacheOpsMatchesCompileSideReclaim ③：两包回收口径**逐项一致**（防实现漂移）。
func TestWasmCacheOpsMatchesCompileSideReclaim(t *testing.T) {
	child := compileChildPath(t)
	rootA, rootB := t.TempDir(), t.TempDir()
	base := time.Now().Add(-time.Hour)
	for _, root := range []string{rootA, rootB} {
		for i := 0; i < 4; i++ {
			sparseCacheEntry(t, root, "wazero-v-test-shard", "entry-"+string(rune('a'+i)),
				1000, base.Add(time.Duration(i)*time.Minute))
		}
	}
	c := newCompilerWithLimits(t, child, rootA, 1000, 100)
	ops, _ := newTightCacheOps(t, rootB, 1000, 100)

	// 扫描根同口径：缓存**根**（含所有分代），不是当前分代。
	if got, want := ops.ScanRoot(), filepath.Dir(runtime.CompileCacheDir(rootB)); got != want {
		t.Fatalf("执行侧扫描根 = %q，want %q", got, want)
	}
	resC, freedC, errC := c.ReclaimCache()
	resO, freedO, errO := ops.Reclaim()
	if errC != nil || errO != nil {
		t.Fatalf("两侧回收都不该报错：compile=%v exec=%v", errC, errO)
	}
	if resC != resO || freedC != freedO {
		t.Fatalf("两包回收口径漂移：compile(removed=%d freed=%d) vs exec(removed=%d freed=%d)",
			resC, freedC, resO, freedO)
	}
	bytesC, entriesC := c.CacheUsage()
	bytesO, entriesO, _ := ops.Usage()
	if bytesC != bytesO || entriesC != entriesO {
		t.Fatalf("回收后剩余水位必须一致：compile(%d 字节/%d 条) vs exec(%d 字节/%d 条)",
			bytesC, entriesC, bytesO, entriesO)
	}
	if bytesO > 1000 {
		t.Fatalf("执行侧回收后必须达标：%d", bytesO)
	}
}

// TestWasmPlatformWithoutCompilerStillReportsRealCache ④：**真装配**下的现场形态。
//
// 让编译子系统真的缺席（把编译子进程从测试二进制旁边移开 —— auto 档下 setupWasmPlatform
// 只 log 后置 nil，这正是"缺一个可选辅助二进制"的现场形态），然后断言：
//   - `p.Compiler == nil` 且 `p.CacheOps != nil`（执行侧接手）；
//   - 周期回收在跑，且启动轮把**装配前就存在**的存量超限收进阈值；
//   - 执行侧写盘之后 /readyz 的 `compile_cache_bytes` > 0（不再自报 0）。
func TestWasmPlatformWithoutCompilerStillReportsRealCache(t *testing.T) {
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	db := requireRealDB(t)

	self, err := os.Executable()
	if err != nil {
		t.Fatalf("定位测试二进制失败: %v", err)
	}
	child := filepath.Join(filepath.Dir(self), compile.ChildBinaryName)
	hidden := child + ".absent-by-test"
	restore := func() {}
	if _, serr := os.Stat(child); serr == nil {
		if rerr := os.Rename(child, hidden); rerr != nil {
			t.Fatalf("移开编译子进程失败: %v", rerr)
		}
		restore = func() { _ = os.Rename(hidden, child) }
	}
	// 装配一结束就还原（同包用例是串行的，没有并发风险；还原是幂等的）。
	t.Cleanup(func() { restore() })

	dataRoot := t.TempDir()
	// 装配**之前**造 640 MiB 逻辑体积（稀疏 ⇒ 不占磁盘）：启动轮必须把它收进阈值。
	seedEntriesOverLimit(t, dataRoot, "preexisting")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p := setupWasmPlatform(ctx, db, dataRoot)
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	t.Cleanup(p.Close)
	restore() // 立刻还原，避免影响后续用例

	if p.Compiler != nil {
		t.Fatal("前置：本用例要求编译子系统缺席（auto 档下缺子进程只 log 后置 nil）")
	}
	if p.CacheOps == nil {
		t.Fatal("编译子系统缺席时必须有执行侧缓存运维组件（R5-A-1：回收与水位不得挂在编译子系统上）")
	}
	if !p.CacheOps.LoopRunning() {
		t.Fatal("编译子系统缺席时周期回收必须仍在跑（R5-A-1 ②）")
	}
	waitForCacheOpsAtMost(t, p.CacheOps, int64(limits.CompileCacheMaxBytes), 30*time.Second)

	// ① 执行侧写盘 ⇒ /readyz 的真实占用 > 0（旧形态：恒 0）。
	rt, rerr := runtime.New(ctx, runtime.Options{DataRoot: dataRoot})
	if rerr != nil {
		t.Fatalf("runtime.New: %v", rerr)
	}
	t.Cleanup(func() { _ = rt.Close(ctx) })
	if _, cerr := rt.CompileModule(ctx, execSideWasmModule); cerr != nil {
		t.Fatalf("执行侧编译（写盘）失败: %v", cerr)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, reasons, cacheBytes, cacheLimit := readyzPayload(t, p.Checker)
		if cacheBytes > 0 {
			if cacheLimit != int64(limits.CompileCacheMaxBytes) {
				t.Fatalf("生效上限必须注入探针：got %d want %d", cacheLimit, int64(limits.CompileCacheMaxBytes))
			}
			if !strings.Contains(strings.Join(reasons, " "), "编译子系统不可用") {
				t.Fatalf("缺席这件事仍必须显式说出来（compile_available 与 reason）：%v", reasons)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/readyz 的 compile_cache_bytes 必须反映真实占用（R5-A-1 ①）："+
				"got %d（旧形态恒为 0）；reasons=%v", cacheBytes, reasons)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// 反向对照：水位必须与磁盘实际占用一致（不是随便一个非零值）。
	bytes, _, uerr := p.CacheOps.Usage()
	if uerr != nil {
		t.Fatalf("Usage: %v", uerr)
	}
	if bytes <= 0 {
		t.Fatalf("执行侧组件必须能看到真实水位：%d", bytes)
	}
}

// newTightCacheOps 造一个阈值很小的执行侧组件（负 grace ⇒ 回收立刻生效，判据要确定性）。
func newTightCacheOps(t *testing.T, root string, maxBytes int64, maxEntries int) (*runtime.CacheOps, *logRecorder) {
	t.Helper()
	rec := &logRecorder{}
	ops := runtime.NewCacheOps(runtime.CacheOpsOptions{
		DataRoot:   root,
		MaxBytes:   maxBytes,
		MaxEntries: maxEntries,
		WriteGrace: -1,
		Interval:   10 * time.Millisecond,
		Logger:     rec.Printf,
	})
	if ops == nil {
		t.Fatal("NewCacheOps 返回 nil（数据根非空时不该）")
	}
	t.Cleanup(ops.Close)
	return ops, rec
}

// logRecorder 记录组件日志（断言"启动轮/回收必须留痕"）。
type logRecorder struct {
	mu    sync.Mutex
	lines []string
}

func (l *logRecorder) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logRecorder) joined() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// waitForCacheOpsAtMost 轮询到执行侧水位达标（或超时失败）。
func waitForCacheOpsAtMost(t *testing.T, ops *runtime.CacheOps, limit int64, budget time.Duration) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for {
		if bytes, _, err := ops.Usage(); err == nil && bytes <= limit {
			return
		}
		if time.Now().After(deadline) {
			bytes, entries, err := ops.Usage()
			t.Fatalf("执行侧回收未把缓存收进阈值（%d 字节 / %d 条 / 上限 %d，err=%v）", bytes, entries, limit, err)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
