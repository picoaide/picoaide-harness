package runtime

// 本文件是**执行侧自持的缓存运维组件**（`CacheOps`，审计 R5-A-1）的判据。
//
// 要防的东西：回收与水位可见性**整体挂在编译子系统上** —— 编译子系统缺席（默认档下
// 缺 `picoaide-app-compile` 就只 log 后置 nil）时，周期回收不启动、`/readyz` 的
// compile_cache_bytes 恒为 0，而执行侧照写那棵树（cache_mode_test.go 的
// `wantDiskWrites: true`）⇒ 缓存只涨不降且不可见。
//
// 判据全部落在**真文件系统**上（稀疏条目，不占磁盘）：水位是真的、回收是真的、
// 周期循环的启动轮是真的。
//
// 变异验证（实跑，见交付报告）：
//   - 把 Reclaim 改成 no-op ⇒ 第 1、3 条红；
//   - 把 StartLoop 的启动轮去掉（只留 ticker）⇒ 第 3 条红；
//   - 把扫描根改成"当前分代"而不是 `_compile-cache` ⇒ 第 4 条（多分代）红。

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// seedSparseEntry 在缓存树的 `<分代>/<分片>/<名字>` 上造一条**稀疏**条目
// （逻辑体积 size，实占≈0）—— 与 cmd/server 的装配级夹具同口径：回收与水位只看
// 文件系统的 Size()，所以这样造"超限"零成本。
func seedSparseEntry(t *testing.T, root, generation, name string, size int64, mtime time.Time) string {
	t.Helper()
	dir := filepath.Join(filepath.Dir(CompileCacheDir(root)), generation, "wazero-dev-amd64-linux")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("建稀疏条目目录: %v", err)
	}
	p := filepath.Join(dir, name)
	f, err := os.Create(p)
	if err != nil {
		t.Fatalf("建稀疏条目: %v", err)
	}
	if err := f.Truncate(size); err != nil {
		_ = f.Close()
		t.Fatalf("置长度: %v", err)
	}
	if err := f.Close(); err != nil {
		t.Fatalf("关闭: %v", err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatalf("置 mtime: %v", err)
	}
	return p
}

// newTestCacheOps 造一个"无写保护窗口"的执行侧运维组件（判据要的是立刻可观测的回收）。
func newTestCacheOps(t *testing.T, root string, maxBytes int64, maxEntries int) (*CacheOps, *logCapture) {
	t.Helper()
	cap := &logCapture{}
	ops := NewCacheOps(CacheOpsOptions{
		DataRoot:   root,
		MaxBytes:   maxBytes,
		MaxEntries: maxEntries,
		WriteGrace: -1, // 不保护"刚写入"的条目（判据要确定性）
		Interval:   10 * time.Millisecond,
		Logger:     cap.Printf,
	})
	if ops == nil {
		t.Fatal("NewCacheOps 返回 nil（数据根非空时不该）")
	}
	t.Cleanup(ops.Close)
	return ops, cap
}

// logCapture 记录组件日志（断言"失败/回收必须留痕"）。
type logCapture struct {
	mu    sync.Mutex
	lines []string
}

func (l *logCapture) Printf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logCapture) joined() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// TestCacheOpsUsageAndReclaim：水位是真的、回收把两个维度都收进阈值。
func TestCacheOpsUsageAndReclaim(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	// 3 条 × 1000 字节（mtime 从旧到新），上限 1000 字节 / 2 条 ⇒ 两个维度都超。
	for i := 0; i < 3; i++ {
		seedSparseEntry(t, root, "r1", "entry-"+strconv.Itoa(i), 1000, now.Add(-time.Duration(3-i)*time.Hour))
	}
	ops, _ := newTestCacheOps(t, root, 1000, 2)

	bytes, entries, err := ops.Usage()
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if bytes != 3000 || entries != 3 {
		t.Fatalf("水位必须是真的目录扫描：got %d 字节 / %d 条，want 3000 / 3", bytes, entries)
	}
	// 扫描根必须是**缓存根**（含所有分代），不是当前分代。
	if got, want := ops.ScanRoot(), filepath.Join(root, "_compile-cache"); got != want {
		t.Fatalf("扫描根 = %q，want %q（含所有分代）", got, want)
	}

	removed, freed, rerr := ops.Reclaim()
	if rerr != nil {
		t.Fatalf("Reclaim: %v", rerr)
	}
	// 3 条 × 1000 字节、上限 1000 字节 ⇒ 必须删到只剩 1 条（删 1 条仍 2000 > 1000）。
	if removed != 2 || freed != 2000 {
		t.Fatalf("按 mtime 从旧到新删到阈值内：removed=%d freed=%d，want 2 / 2000", removed, freed)
	}
	bytes, entries, _ = ops.Usage()
	if bytes > 1000 || entries > 2 {
		t.Fatalf("回收后必须同时满足两个维度：%d 字节 / %d 条", bytes, entries)
	}
}

// TestCacheOpsScansAllGenerations：升级 wazero 之后的**旧分代**也要计入与回收
// （只在当前分代里统计会让"缓存有界"只在单代内成立）。
func TestCacheOpsScansAllGenerations(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	seedSparseEntry(t, root, "old-generation", "stale", 4000, now.Add(-48*time.Hour))
	seedSparseEntry(t, root, "r1", "current", 1000, now.Add(-time.Minute))
	ops, _ := newTestCacheOps(t, root, 2000, 100)

	bytes, entries, err := ops.Usage()
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	if bytes != 5000 || entries != 2 {
		t.Fatalf("旧分代必须计入水位：got %d 字节 / %d 条，want 5000 / 2", bytes, entries)
	}
	if _, _, rerr := ops.Reclaim(); rerr != nil {
		t.Fatalf("Reclaim: %v", rerr)
	}
	// 最旧的（旧分代）先被删，当前分代留下。
	genRoot := filepath.Dir(CompileCacheDir(root))
	if _, serr := os.Stat(filepath.Join(genRoot, "old-generation", "wazero-dev-amd64-linux", "stale")); !os.IsNotExist(serr) {
		t.Fatalf("最旧的条目（旧分代）必须被优先回收：err=%v", serr)
	}
	if _, serr := os.Stat(filepath.Join(genRoot, "r1", "wazero-dev-amd64-linux", "current")); serr != nil {
		t.Fatalf("当前分代的条目不该在只剩它时被删：%v", serr)
	}
}

// TestCacheOpsReclaimProtectsFreshEntries：**写保护窗口**内的条目不动（执行侧的回收与
// 在飞编译并发，删掉正在写的临时条目会让那次编译失败）。
func TestCacheOpsReclaimProtectsFreshEntries(t *testing.T) {
	root := t.TempDir()
	cap := &logCapture{}
	ops := NewCacheOps(CacheOpsOptions{
		DataRoot:   root,
		MaxBytes:   1000,
		MaxEntries: 100,
		WriteGrace: time.Minute, // 默认口径
		Logger:     cap.Printf,
	})
	t.Cleanup(ops.Close)
	seedSparseEntry(t, root, "r1", "in-flight", 4000, time.Now())

	removed, _, err := ops.Reclaim()
	if err != nil {
		t.Fatalf("Reclaim: %v", err)
	}
	if removed != 0 {
		t.Fatalf("写保护窗口内的条目不得被删（可能正在写入）：removed=%d", removed)
	}
	if !strings.Contains(cap.joined(), "写保护") && !strings.Contains(cap.joined(), "保护窗口") {
		t.Fatalf("跳过保护条目必须留痕（否则「水位不降」看着像回收坏了）：%s", cap.joined())
	}
	// 反面对照：同样的体积，mtime 够旧 ⇒ 必须被回收（证明"没删"是保护而不是没干活）。
	seedSparseEntry(t, root, "r1", "old", 4000, time.Now().Add(-2*time.Hour))
	removed, _, err = ops.Reclaim()
	if err != nil {
		t.Fatalf("Reclaim(old): %v", err)
	}
	if removed == 0 {
		t.Fatal("窗口外的条目必须被回收（判据不能假绿）")
	}
}

// TestCacheOpsLoopStartupReclaimsAndStops：周期循环**启动即回收一次**，且"在跑"可观测。
func TestCacheOpsLoopStartupReclaimsAndStops(t *testing.T) {
	root := t.TempDir()
	now := time.Now()
	for i := 0; i < 4; i++ {
		seedSparseEntry(t, root, "r1", "seed-"+strconv.Itoa(i), 1000, now.Add(-time.Duration(4-i)*time.Hour))
	}
	ops, cap := newTestCacheOps(t, root, 1000, 100)
	if bytes, _, _ := ops.Usage(); bytes <= 1000 {
		t.Fatalf("夹具没造出超限：%d", bytes)
	}
	if ops.LoopRunning() {
		t.Fatal("未启动时 LoopRunning 必须为 false（判据要能区分「没跑」）")
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ops.StartLoop(ctx)
	if !ops.LoopRunning() {
		t.Fatal("StartLoop 之后 LoopRunning 必须为 true")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if bytes, _, _ := ops.Usage(); bytes <= 1000 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("启动轮没有把存量超限收进阈值：%s", cap.joined())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !strings.Contains(cap.joined(), "执行侧/启动") {
		t.Fatalf("启动轮必须留一行可 grep 的日志（运维判断「周期回收在不在跑」的唯一证据）：%s", cap.joined())
	}
	ops.Close()
	if ops.LoopRunning() {
		t.Fatal("Close 之后 LoopRunning 必须为 false")
	}
}

// TestCacheOpsEmptyTreeIsNotAnError：没有缓存目录 ⇒ (0, 0, nil)（空树不是错误，
// 而"读不出来"必须是错误 —— 两者不能同形，那正是本条审计要消灭的形态）。
func TestCacheOpsEmptyTreeIsNotAnError(t *testing.T) {
	root := t.TempDir()
	ops, _ := newTestCacheOps(t, root, 1000, 10)
	bytes, entries, err := ops.Usage()
	if err != nil || bytes != 0 || entries != 0 {
		t.Fatalf("空树必须是 (0,0,nil)：%d / %d / %v", bytes, entries, err)
	}
	removed, freed, rerr := ops.Reclaim()
	if rerr != nil || removed != 0 || freed != 0 {
		t.Fatalf("空树回收必须是 no-op：%d / %d / %v", removed, freed, rerr)
	}
}

// TestNewCacheOpsNilWithoutDataRoot：没有数据根 ⇒ 没有磁盘缓存可管（nil 而不是"空对象"，
// 调用方据此区分"管不了"与"管着但是 0"）。
func TestNewCacheOpsNilWithoutDataRoot(t *testing.T) {
	if ops := NewCacheOps(CacheOpsOptions{DataRoot: "   "}); ops != nil {
		t.Fatal("数据根为空时必须返回 nil")
	}
	var ops *CacheOps
	if bytes, entries, err := ops.Usage(); bytes != 0 || entries != 0 || err != nil {
		t.Fatalf("nil 接收者必须安全：%d / %d / %v", bytes, entries, err)
	}
	if ops.LoopRunning() {
		t.Fatal("nil 接收者的 LoopRunning 必须是 false")
	}
	ops.Close() // 幂等且安全
}
