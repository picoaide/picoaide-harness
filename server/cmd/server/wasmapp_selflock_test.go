package main

// 本文件是**编译缓存自锁**（2026-09-23 现场 P0）的装配级判据。
//
// 现场形态：`/readyz` = 503 `{"ok":false,"reasons":["编译缓存超上限：578263173 > 536870912"]}`
// ⇒ 发布/校验面整体 503；**删掉缓存条目立刻恢复，不删就永不恢复**（自锁）。
// 三层根因里，本文件覆盖"谁来解除它"，并钉住装配真的接上了：
//
//	① 旧形态复现：缓存超限 + **零编译作业** ⇒ AllowPublish 永远 503 且水位一点不降；
//	② 周期回收（P0-a）：`startWasmCompileReclaimLoop` 启动即把存量超限收进阈值内；
//	③ 同步回收（P0-b）：`compileReclaimHook` 接到 AllowPublish ⇒ 回收达标后放行；
//	   回收失败 ⇒ 仍 503（可行动文案）；
//	④ 装配守卫：setupWasmPlatform 里那两行接线与"生效上限注入"必须真的在（源码级，
//	   与 wasmapp_cache_mode_test.go 同口径：装配级用例才测得到"有没有接上"）。
//
// 用**真组件**（真 compile.Compiler / 真 readyz.Checker / 真写盘缓存目录），
// 不用 mock：本条的失败形态（水位与"谁在写"）只有落到文件系统上才成立。
//
// 变异验证（实跑，见交付报告）：
//   - 去掉 setupWasmPlatform 的 startWasmCompileReclaimLoop 调用 ⇒ ④ 红；
//   - 把 StartReclaimLoop 的循环体改成空操作 ⇒ ② 红；
//   - 去掉 setupWasmPlatform 的 ReclaimCompileCache 注入 ⇒ ③、④ 红；
//   - 去掉 AllowPublish 的同步回收 ⇒ ③ 红。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// sparseCacheEntry 在缓存分代目录里造一条**稀疏**条目（逻辑体积 size，实占≈0）。
//
// 为什么可以这么造：回收与水位判据只看文件系统的 `Size()`（compile/cache.go 的
// listCacheEntries），而稀疏文件的 Size 就是逻辑大小 ⇒ 造出"600 MiB 缓存"零成本、
// 零磁盘占用（真写 600 MiB 会让用例变成磁盘炸弹）。条目布局必须与 wazero 一致：
// `<分代>/<分片>/<条目>`（相对 `_compile-cache` 深度 3）。
func sparseCacheEntry(t *testing.T, dataRoot, shard, name string, size int64, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(runtime.CompileCacheDir(dataRoot), shard)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建缓存分片目录: %v", err)
	}
	p := filepath.Join(dir, name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatalf("建稀疏缓存条目: %v", err)
	}
	if err := f.Truncate(size); err != nil {
		_ = f.Close()
		t.Fatalf("稀疏条目置长度: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("关闭稀疏条目: %v", err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatalf("置条目 mtime: %v", err)
	}
	return p
}

// readyzPayload 取一次 /readyz 的 JSON（缓存水位/上限/理由）。
func readyzPayload(t *testing.T, c *readyz.Checker) (ok bool, reasons []string, cacheBytes, cacheLimit int64) {
	t.Helper()
	rr := httptest.NewRecorder()
	c.Handler()(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var body struct {
		OK                bool     `json:"ok"`
		Reasons           []string `json:"reasons"`
		CacheBytes        *int64   `json:"compile_cache_bytes"`
		CacheLimitBytes   *int64   `json:"compile_cache_limit_bytes"`
		CompileAvailable  *bool    `json:"compile_available"`
		SnapshotCached    bool     `json:"snapshot_cached"`
		CompileCacheFiles *int     `json:"compile_cache_files"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("/readyz 响应不是合法 JSON: %v; body=%s", err, rr.Body.String())
	}
	if body.CacheBytes == nil || body.CacheLimitBytes == nil {
		t.Fatalf("/readyz payload 缺 compile_cache_bytes / compile_cache_limit_bytes：%s", rr.Body.String())
	}
	return body.OK, body.Reasons, *body.CacheBytes, *body.CacheLimitBytes
}

// TestSelfLockOldForm_NoJobNoHealIsPermanent503 是**旧形态的复现**（现场形态的用例化）。
//
// 配置 = 缓存超限 + **零编译作业** + 没有任何自愈路径（无周期回收、无同步钩子）：
// 断言 AllowPublish **每一次**都 503，且水位**一点没降** —— 这正是现场"不删就永不恢复"。
func TestSelfLockOldForm_NoJobNoHealIsPermanent503(t *testing.T) {
	child := compileChildPath(t)
	dataRoot := t.TempDir()
	c := newCompilerWithLimits(t, child, dataRoot, 1000, 100)
	seedOverLimit(t, dataRoot, 1000)

	// 旧形态的探针：**没有** ReclaimCompileCache 钩子（周期循环也没启动）。
	checker := readyz.New(readyz.Options{
		DataRoot: dataRoot,
		Compiler: compileStatsFunc(c),
	})
	for i := 0; i < 5; i++ {
		if err := checker.AllowPublish(); err == nil {
			t.Fatalf("第 %d 次判定：超限且无自愈路径时必须 503（现场形态）", i+1)
		}
	}
	before, _ := c.CacheUsage()
	if before <= 1000 {
		t.Fatalf("自锁形态下水位不该下降：%d", before)
	}
	if st := c.Stats(); st.Compiles != 0 || st.Compiling {
		t.Fatalf("本用例必须「无任何编译作业」：compiles=%d compiling=%v", st.Compiles, st.Compiling)
	}
}

// TestSelfLockPeriodicReclaimHeals ②：周期回收（P0-a）在**零编译作业**下把存量超限收进阈值。
//
// 走生产装配用的那个 helper（startWasmCompileReclaimLoop）⇒ 既验证循环行为，也验证
// "装配启动它"这件事的载体是可测的。
func TestSelfLockPeriodicReclaimHeals(t *testing.T) {
	child := compileChildPath(t)
	dataRoot := t.TempDir()
	c := newCompilerWithLimits(t, child, dataRoot, 1000, 100)
	seedOverLimit(t, dataRoot, 1000)

	checker := readyz.New(readyz.Options{
		DataRoot: dataRoot,
		Compiler: compileStatsFunc(c),
	})
	if err := checker.AllowPublish(); err == nil {
		t.Fatal("前置：未回收前必须 503")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	startWasmCompileReclaimLoop(ctx, c) // 生产装配的同一个 helper

	deadline := time.Now().Add(5 * time.Second)
	for {
		if bytes, _ := c.CacheUsage(); bytes <= 1000 {
			break
		}
		if time.Now().After(deadline) {
			bytes, entries := c.CacheUsage()
			t.Fatalf("周期回收未把缓存收进阈值：%d 字节 / %d 条", bytes, entries)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := checker.AllowPublish(); err != nil {
		t.Fatalf("周期回收达标后必须放行：%v", err)
	}
	if st := c.Stats(); st.Compiles != 0 {
		t.Fatalf("周期回收不依赖编译作业：compiles=%d", st.Compiles)
	}
}

// TestSelfLockSyncReclaimHealsOrKeepsActionable503 ③：发布闸门的同步回收（P0-b）。
func TestSelfLockSyncReclaimHealsOrKeepsActionable503(t *testing.T) {
	child := compileChildPath(t)
	dataRoot := t.TempDir()
	c := newCompilerWithLimits(t, child, dataRoot, 1000, 100)
	seedOverLimit(t, dataRoot, 1000)

	checker := readyz.New(readyz.Options{
		DataRoot:            dataRoot,
		Compiler:            compileStatsFunc(c),
		ReclaimCompileCache: compileReclaimHook(c), // 生产装配的同一个 helper
	})

	// 回收成功 ⇒ 放行（且真的删了东西）。
	if err := checker.AllowPublish(); err != nil {
		t.Fatalf("同步回收达标后必须放行：%v", err)
	}
	if bytes, _ := c.CacheUsage(); bytes > 1000 {
		t.Fatalf("放行时缓存必须已达标：%d", bytes)
	}

	// 再造成超限，但这次**删除一定失败**：条目是一个非空目录（os.Remove 返回 ENOTEMPTY/
	// EEXIST），且上限设成 1 字节（任何可计量的条目都算超限）⇒ 仍 503，且文案点名回收
	// 失败 + 给出可行动 hint。
	//
	// 为什么用"非空目录"：回收的判据是"文件系统上的条目"，而 root 下权限位不挡删除 ⇒
	// 用权限造失败会得到"本机绿、CI 红"的环境依赖；目录非空是内核层面的硬失败。
	badRoot := t.TempDir()
	c2 := newCompilerWithLimits(t, child, badRoot, 1, 10)
	dir := filepath.Join(runtime.CompileCacheDir(badRoot), "wazero-test-shard", "undeletable")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if bytes, _ := c2.CacheUsage(); bytes <= 1 {
		t.Fatalf("夹具没造出超限（非空目录的体积在本文件系统上是 %d 字节）：无法构造"+
			"「回收失败」这条路径", bytes)
	}
	checker2 := readyz.New(readyz.Options{
		DataRoot:            badRoot,
		Compiler:            compileStatsFunc(c2),
		ReclaimCompileCache: compileReclaimHook(c2),
	})
	err := checker2.AllowPublish()
	if err == nil {
		t.Fatal("回收失败（删不掉）时必须继续 503")
	}
	reasons := strings.Join(detailStrings(t, err, "reasons"), " ")
	if !strings.Contains(reasons, "同步回收失败") {
		t.Fatalf("理由必须点名同步回收失败：%s", reasons)
	}
	if !strings.Contains(strings.Join(err.Hints, " "), limits.CompileCacheDirName) {
		t.Fatalf("hint 必须可行动（指向缓存目录）：%v", err.Hints)
	}
}

// TestWasmPlatformReadyzRecoversFromRealOverLimit 是**真装配的端到端**：
// 真 setupWasmPlatform + 真 512 MiB 上限 + 真写盘缓存目录（稀疏条目造 640 MiB 逻辑体积）。
//
// 断言链（与现场证据一一对应）：
//  1. 装配启动的周期回收把**装配前就存在的**存量超限收进阈值（P0-a 的启动轮）；
//  2. 再造成超限（此时周期循环正在 5 分钟休眠里）⇒ `/readyz` **如实** 503，
//     理由点名编译缓存超限，且 `compile_cache_limit_bytes` = 512 MiB
//     （生效上限真的被注入了 —— 这条挡住"探针按编译期常量、回收按别的值"的二次分叉）；
//  3. 发布闸门（AllowPublish，与 publish/validate 同一入口）自愈后放行；
//  4. 自愈后 `/readyz` 回到 200，且 compile_cache_bytes 已在上限内。
//
// ⚠️ 顺序不是随意的（第一版就是这么红的）：周期回收的**启动轮**是异步的，若先装配再
// 造超限，它会与夹具赛跑并可能把水位**正好**收到阈值上（`>` 判据 ⇒ 不再算超限）。
// 因此夹具必须在装配**之前**造好，等启动轮收完（水位 ≤ 阈值）再造成超限 ——
// 此时循环已进入 5 分钟休眠，超限状态可被稳定观察。
func TestWasmPlatformReadyzRecoversFromRealOverLimit(t *testing.T) {
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)
	dataRoot := t.TempDir()
	// ① 装配前造 640 MiB（稀疏，不占磁盘）⇒ 装配的启动轮必须把它收进阈值。
	seedEntriesOverLimit(t, dataRoot, "preexisting")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p := setupWasmPlatform(ctx, db, dataRoot)
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	t.Cleanup(p.Close)

	if p.Compiler == nil {
		t.Fatal("装配后应有编译器（本用例需要真编译子系统）")
	}
	// 1) 等启动轮收完（判定条件就是"水位已进阈值"）。
	waitForCacheAtMost(t, p.Compiler, int64(limits.CompileCacheMaxBytes), 30*time.Second,
		"装配启动的周期回收没有把存量超限收进阈值")

	// 2) 再造成超限（周期循环此刻在 5 分钟休眠里 ⇒ 状态稳定可观察）。
	seedEntriesOverLimit(t, dataRoot, "observed")
	if bytes, _ := p.Compiler.CacheUsage(); bytes <= int64(limits.CompileCacheMaxBytes) {
		t.Fatalf("夹具没造出超限：%d 字节", bytes)
	}

	// 3) /readyz 必须如实报超限（等一个快照 TTL，避免读到造超限之前的缓存快照）。
	var (
		reasons    []string
		cacheBytes int64
		cacheLimit int64
		ok         bool
	)
	deadline := time.Now().Add(10 * time.Second)
	for {
		ok, reasons, cacheBytes, cacheLimit = readyzPayload(t, p.Checker)
		if !ok && strings.Contains(strings.Join(reasons, " "), "编译缓存超上限") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("超限未反映到 /readyz：ok=%v reasons=%v bytes=%d", ok, reasons, cacheBytes)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if cacheLimit != int64(limits.CompileCacheMaxBytes) {
		t.Fatalf("生效上限必须注入探针：got %d want %d", cacheLimit, int64(limits.CompileCacheMaxBytes))
	}
	if cacheBytes <= cacheLimit {
		t.Fatalf("payload 里的水位必须真的超限：%d ≤ %d", cacheBytes, cacheLimit)
	}

	// 4) 发布闸门自愈（publish / validate 走同一个 AllowPublish）。
	if err := p.Checker.AllowPublish(); err != nil {
		t.Fatalf("真装配下同步回收应解除自锁：%v", err)
	}
	if bytes, _ := p.Compiler.CacheUsage(); bytes > int64(limits.CompileCacheMaxBytes) {
		t.Fatalf("放行时缓存必须已达标：%d", bytes)
	}

	// 5) 探针恢复绿灯。
	deadline = time.Now().Add(10 * time.Second)
	for {
		ok, reasons, cacheBytes, cacheLimit = readyzPayload(t, p.Checker)
		if ok {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/readyz 未恢复：reasons=%v bytes=%d limit=%d", reasons, cacheBytes, cacheLimit)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitForCacheAtMost 轮询到"缓存水位 ≤ 阈值"（或超时失败）。
func waitForCacheAtMost(t *testing.T, c *compile.Compiler, limit int64, budget time.Duration, why string) {
	t.Helper()
	deadline := time.Now().Add(budget)
	for {
		if bytes, _ := c.CacheUsage(); bytes <= limit {
			return
		}
		if time.Now().After(deadline) {
			bytes, entries := c.CacheUsage()
			t.Fatalf("%s（当前 %d 字节 / %d 条，上限 %d）", why, bytes, entries, limit)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// TestWasmCompileSelfLockWiringIsPresent ④：装配守卫（源码级）。
//
// 为什么必须源码级：另三条判据测的是"组件给了就work"，而 setupWasmPlatform 是唯一
// 装配点 —— 删掉那两行接线时失败形态是**静默的**（不会有用例红），正是现场 P0 的一半。
func TestWasmCompileSelfLockWiringIsPresent(t *testing.T) {
	src, err := os.ReadFile("wasmapp.go")
	if err != nil {
		t.Fatalf("读 wasmapp.go: %v", err)
	}
	text := string(src)
	start := strings.Index(text, "func setupWasmPlatform(")
	if start < 0 {
		t.Fatal("wasmapp.go 里找不到 setupWasmPlatform")
	}
	end := strings.Index(text[start:], "\nfunc ")
	if end < 0 {
		t.Fatal("定位 setupWasmPlatform 函数体失败")
	}
	body := text[start : start+end]

	for _, want := range []struct{ needle, why string }{
		{"startWasmCompileReclaimLoop(ctx, compiler)", "周期回收（P0-a）必须在装配期启动"},
		{"ReclaimCompileCache: compileReclaimHook(compiler)", "发布闸门的同步回收钩子（P0-b）必须接线"},
		{"CacheMaxBytes:", "生效上限必须注入探针（否则超限判定与回收用的阈值分叉）"},
		{"st.CacheMaxBytes", "注入的必须是编译器自己的生效上限（不是重新推导一个）"},
	} {
		if !strings.Contains(body, want.needle) {
			t.Fatalf("setupWasmPlatform 缺 %q（%s）", want.needle, want.why)
		}
	}
}

// ===== 夹具 =====

// compileChildPath 返回可用的编译子进程路径（与 wasmapp_test.go 同源）。
func compileChildPath(t *testing.T) string {
	t.Helper()
	ensureCompileChildNextToTestBinary(t)
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("定位测试二进制失败: %v", err)
	}
	return filepath.Join(filepath.Dir(self), compile.ChildBinaryName)
}

// newCompilerWithLimits 造一个**真**编译器（隔离关闭：测试机不装 bwrap；不跑编译，
// 只用它的缓存目录与回收实现）。
func newCompilerWithLimits(t *testing.T, child, dataRoot string, maxBytes int64, maxEntries int) *compile.Compiler {
	t.Helper()
	c, err := compile.New(compile.Options{
		DataRoot:        dataRoot,
		Isolation:       compile.IsolationOff,
		ChildBinary:     child,
		CacheMaxBytes:   maxBytes,
		CacheMaxEntries: maxEntries,
		// 节流窗口给足：本文件的判据都是"强制回收/启动即回收"，不受节流影响。
		ReclaimInterval: time.Hour,
		Logger:          testLoggerAdapter{t},
	})
	if err != nil {
		t.Fatalf("compile.New: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// testLoggerAdapter 把编译侧日志转给 testing.T。
type testLoggerAdapter struct{ t *testing.T }

func (l testLoggerAdapter) Printf(format string, args ...any) { l.t.Logf(format, args...) }

// compileStatsFunc 是**生产装配同款**的水位快照闭包（字段逐一相同）。
func compileStatsFunc(c *compile.Compiler) func() readyz.CompilerStatsSnapshot {
	return func() readyz.CompilerStatsSnapshot {
		if c == nil {
			return readyz.CompilerStatsSnapshot{}
		}
		st := c.Stats()
		return readyz.CompilerStatsSnapshot{
			QueueDepth:      st.QueueDepth,
			InFlight:        boolToInt(st.Compiling),
			CacheBytes:      st.CacheBytes,
			CacheFiles:      st.CacheEntries,
			Running:         st.ChildRunning,
			CacheMaxBytes:   st.CacheMaxBytes,
			CacheMaxEntries: st.CacheMaxEntries,
		}
	}
}

// seedOverLimit 造出"必然超限"的缓存（相对给定上限）。
func seedOverLimit(t *testing.T, dataRoot string, limit int64) {
	t.Helper()
	now := time.Now()
	for i := 0; i < 3; i++ {
		sparseCacheEntry(t, dataRoot, "wazero-v-test-shard",
			"stale-"+strconv.Itoa(i), limit, now.Add(-time.Duration(3-i)*time.Hour))
	}
}

// seedEntriesOverLimit 造 640 MiB 逻辑体积的缓存（20 × 32 MiB，稀疏 ⇒ 不占磁盘）。
//
// 640 MiB > 生产缺省上限 512 MiB ⇒ 每次调用都造出真超限；tag 用来区分批次
// （同一批文件名固定，重复调用不会互相覆盖）。
func seedEntriesOverLimit(t *testing.T, dataRoot, tag string) {
	t.Helper()
	const entry = int64(32 << 20)
	now := time.Now()
	for i := 0; i < 20; i++ {
		sparseCacheEntry(t, dataRoot, "wazero-v-test-shard",
			tag+"-"+strconv.Itoa(i), entry, now.Add(-time.Duration(20-i)*time.Minute))
	}
}

// detailStrings 从错误信封的 details 里取字符串切片。
func detailStrings(t *testing.T, e *apperr.Error, key string) []string {
	t.Helper()
	raw, ok := e.Details[key]
	if !ok {
		t.Fatalf("details 缺 %s：%#v", key, e.Details)
	}
	out, ok := raw.([]string)
	if !ok {
		t.Fatalf("details.%s 不是 []string：%#v", key, raw)
	}
	return out
}
