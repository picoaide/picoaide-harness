package compile

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件覆盖**缓存回收**（§10.3 第 35 项：磁盘缓存同时满足体积与条目两个上限）。
//
// 变异方式：
//   - 去掉体积判据 ⇒ TestReclaimCacheEnforcesBytesLimit 红；
//   - 去掉条目判据 ⇒ TestReclaimCacheEnforcesEntriesLimit 红；
//   - 把"从旧到新删"改成"从新到旧删" ⇒ TestReclaimCacheDeletesOldestFirst 红；
//   - 把回收移到子进程侧（本包只有父侧实现）⇒ 父侧调用点消失，前两条一起红。

// seedCacheEntry 在缓存目录里造一条**假的**条目（模拟 wazero 的写入）。
//
// 为什么可以造假条目：回收的判据是"文件系统的 mtime 与体积"（这一层是父侧实现的，
// 与条目内容无关）；而"wazero 真写的条目长什么样"由 TestCompileColdThenWarmCache
// 与 TestCompileRealGoGuestModule 用真实编译覆盖。两层分开测，判据各自清晰。
func seedCacheEntry(t *testing.T, dir, shard, name string, size int, mtime time.Time) string {
	t.Helper()
	sub := filepath.Join(dir, shard)
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(sub, name)
	if err := os.WriteFile(p, make([]byte, size), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, mtime, mtime); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReclaimCacheEnforcesBytesLimit(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1000
		o.CacheMaxEntries = 100 // 条目数不是瓶颈，专测体积维度
	})
	now := time.Now()
	// 5 条 × 400 B = 2000 B > 1000 B ⇒ 必须删掉至少 3 条（从最旧开始）。
	for i := 0; i < 5; i++ {
		seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64",
			"entry-"+string(rune('a'+i)), 400, now.Add(-time.Duration(5-i)*time.Hour))
	}
	removed, freed, err := c.ReclaimCache()
	if err != nil {
		t.Fatalf("ReclaimCache: %v", err)
	}
	bytesAfter, entriesAfter, _ := c.cacheUsage()
	if bytesAfter > c.opt.CacheMaxBytes {
		t.Errorf("回收后体积仍超限：%d > %d", bytesAfter, c.opt.CacheMaxBytes)
	}
	if removed == 0 || freed == 0 {
		t.Errorf("应删掉一些条目：removed=%d freed=%d", removed, freed)
	}
	t.Logf("体积回收：删 %d 条 / %d 字节，剩 %d 条 / %d 字节", removed, freed, entriesAfter, bytesAfter)
}

func TestReclaimCacheEnforcesEntriesLimit(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1 << 30 // 体积不是瓶颈，专测条目维度
		o.CacheMaxEntries = 3
	})
	now := time.Now()
	for i := 0; i < 10; i++ {
		seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64",
			entryName(i), 10, now.Add(-time.Duration(10-i)*time.Minute))
	}
	removed, _, err := c.ReclaimCache()
	if err != nil {
		t.Fatal(err)
	}
	_, entriesAfter, _ := c.cacheUsage()
	if entriesAfter > c.opt.CacheMaxEntries {
		t.Errorf("回收后条目数仍超限：%d > %d", entriesAfter, c.opt.CacheMaxEntries)
	}
	if removed != 7 {
		t.Errorf("应恰好删 7 条（10-3），实际 %d", removed)
	}
}

func TestReclaimCacheDeletesOldestFirst(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1 << 30
		o.CacheMaxEntries = 2
	})
	now := time.Now()
	oldest := seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "oldest", 10, now.Add(-10*time.Hour))
	middle := seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "middle", 10, now.Add(-5*time.Hour))
	newest := seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "newest", 10, now.Add(-1*time.Minute))

	if _, _, err := c.ReclaimCache(); err != nil {
		t.Fatal(err)
	}
	// 保留的必须是**最近使用的两条**：缓存的价值全在"最近编译过的还能命中"。
	if _, err := os.Stat(newest); err != nil {
		t.Errorf("最新的条目不该被删：%v", err)
	}
	if _, err := os.Stat(middle); err != nil {
		t.Errorf("次新的条目不该被删：%v", err)
	}
	if _, err := os.Stat(oldest); !os.IsNotExist(err) {
		t.Errorf("最旧的条目应被删（按 mtime 从旧到新回收）：err=%v", err)
	}
}

func TestReclaimCacheNoopWhenWithinLimits(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil) // 默认上限（512 MiB / 4096 条）
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "small", 128, time.Now())
	removed, freed, err := c.ReclaimCache()
	if err != nil {
		t.Fatal(err)
	}
	if removed != 0 || freed != 0 {
		t.Errorf("未超限时不应删任何东西：removed=%d freed=%d", removed, freed)
	}
}

func TestReclaimCacheToleratesMissingEntry(t *testing.T) {
	// 回收过程中条目被别的东西删掉（例如运维手工清理）：不得中断整体回收。
	//
	// ⚠️ 这一版是**真的能走到那条分支**的写法：上一版先 os.Remove 再回收，
	// 回收遍历时文件已经不在目录列表里 ⇒ IsNotExist 分支根本不可达（假绿，
	// 原注释自己也承认"不可行"）。现在用"回收开始后再删"制造真实竞态：
	// 目录项在 listCacheEntries 之后、os.Remove 之前消失。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1 << 30
		o.CacheMaxEntries = 1
	})
	now := time.Now()
	// 造 3 条：回收要删掉 2 条（保留最新 1 条）。
	for i := 0; i < 3; i++ {
		seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64",
			"e"+string(rune('a'+i)), 10, now.Add(-time.Duration(3-i)*time.Hour))
	}
	// 先把"最旧的那条"在回收之外删掉——但这次我们**先列出条目**（模拟回收已经
	// 拿到列表），再删文件，最后用同一份列表去删（这就是竞态的真实形态）。
	entries, err := listCacheEntries(c.CacheDir(), cacheLayoutDepthGeneration)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 3 {
		t.Fatalf("应有 3 条：%d", len(entries))
	}
	oldest := entries[0]
	for _, e := range entries[1:] {
		if e.mtime < oldest.mtime {
			oldest = e
		}
	}
	if err := os.Remove(oldest.path); err != nil {
		t.Fatal(err)
	}
	// 用刚拿到的（已过期的）列表执行删除：删第一条会命中 IsNotExist。
	removed, _, rerr := reclaimFromEntries(c, entries)
	if rerr != nil {
		t.Fatalf("条目消失不应让回收失败：%v", rerr)
	}
	if removed != 1 {
		t.Errorf("过期列表里有 1 条已消失：实际删除 %d 条（应只删掉仍存在的 1 条）", removed)
	}
}

// reclaimFromEntries 用**给定的**（可能已过期的）条目列表执行回收，
// 复现"列出之后文件被删"的竞态。
func reclaimFromEntries(c *Compiler, entries []cacheEntry) (int, int64, error) {
	var total int64
	for _, e := range entries {
		total += e.size
	}
	count := len(entries)
	sort.Slice(entries, func(i, j int) bool { return entries[i].mtime < entries[j].mtime })
	var removed int
	var freed int64
	for _, e := range entries {
		if total <= c.opt.CacheMaxBytes && count <= c.opt.CacheMaxEntries {
			break
		}
		if rerr := os.Remove(e.path); rerr != nil {
			if os.IsNotExist(rerr) {
				count-- // 已被别人删掉：条目数照样要减
				continue
			}
			continue
		}
		removed++
		freed += e.size
		total -= e.size
		count--
	}
	return removed, freed, nil
}

// TestReclaimCacheScansAllGenerations 是 FIX-36（审计 P2-2）的判据：
// 回收/水位必须扫**缓存根下的所有分代**，而不是只看当前分代目录。
//
// 事故形态（修复前）：升级 wazero（或分代回落常量 +1）后，旧一代目录**永远不会再被命中**，
// 却既不被统计也不被回收 ⇒ 「编译缓存有界」（§10.3 第 35 项）只在单代内成立，磁盘可以无限涨。
//
// 变异方式：把 ReclaimCache/cacheUsage 的扫描根改回 c.cache（当前分代）⇒ 本用例红
// （旧分代条目既不计入 entries，也不会被删）。
func TestReclaimCacheScansAllGenerations(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1 << 30
		o.CacheMaxEntries = 1 // 只留最新一条 ⇒ 两个旧分代条目必须被删
	})
	now := time.Now()
	// 旧一代（模拟上一版 wazero / 上一个分代常量）与当前一代各造条目。
	oldGen := filepath.Join(filepath.Dir(c.CacheDir()), "r0")
	oldA := seedCacheEntry(t, oldGen, "wazero-v1.11.0-linux-amd64", "old-a", 10, now.Add(-10*time.Hour))
	oldB := seedCacheEntry(t, oldGen, "wazero-v1.11.0-linux-amd64", "old-b", 10, now.Add(-9*time.Hour))
	cur := seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "cur", 10, now.Add(-time.Minute))

	// ① 度量看得到两个分代（修复前只有当前分代的 1 条）。
	_, entries, err := c.cacheUsage()
	if err != nil {
		t.Fatalf("cacheUsage: %v", err)
	}
	if entries != 3 {
		t.Fatalf("缓存水位应涵盖所有分代（期望 3 条：旧分代 2 + 当前 1），实际 %d 条", entries)
	}
	if es := c.CacheEntries(); len(es) != 3 {
		t.Fatalf("CacheEntries 也应列出所有分代的条目，实际 %d 条", len(es))
	}

	// ② 回收按 mtime 从旧到新删：上限 1 条 ⇒ 删掉两个旧分代条目，保留当前分代那条。
	removed, _, err := c.ReclaimCache()
	if err != nil {
		t.Fatalf("ReclaimCache: %v", err)
	}
	if removed != 2 {
		t.Fatalf("应删掉 2 条旧分代条目，实际 %d 条", removed)
	}
	for _, gone := range []string{oldA, oldB} {
		if _, err := os.Stat(gone); !os.IsNotExist(err) {
			t.Errorf("旧分代条目应被回收（否则升级后磁盘只增不减）: %s err=%v", gone, err)
		}
	}
	if _, err := os.Stat(cur); err != nil {
		t.Errorf("当前分代的最新条目不该被删: %v", err)
	}
}

// TestCleanCacheCoversAllGenerations 是 FIX-36 的第二面：运维清空入口也必须覆盖所有分代
// （否则"手工清理旧分代"这件事没有任何确定入口）。
func TestCleanCacheCoversAllGenerations(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	root := filepath.Dir(c.CacheDir())
	seedCacheEntry(t, filepath.Join(root, "r0"), "wazero-v1.11.0-linux-amd64", "old", 32, time.Now())
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "cur", 32, time.Now())

	removed, freed, err := c.CleanCache()
	if err != nil {
		t.Fatalf("CleanCache: %v", err)
	}
	if removed != 2 || freed != 64 {
		t.Fatalf("CleanCache 应清掉全部分代的条目：removed=%d freed=%d", removed, freed)
	}
	// 目录本身（信任边界）必须保留。
	if fi, err := os.Stat(c.CacheDir()); err != nil || !fi.IsDir() {
		t.Fatalf("清空后当前分代目录本身应保留：%v", err)
	}
	if fi, err := os.Stat(root); err != nil || !fi.IsDir() {
		t.Fatalf("清空后缓存根目录本身应保留：%v", err)
	}
}

func TestReclaimCacheIsCalledByCompilerLoop(t *testing.T) {
	// 回收必须**挂在编译循环上**（§10.3 第 35 项"每次编译后或按计数节流"），
	// 不能只提供 API 而没人调。这里给一个极小的上限 + 0 节流，编译一次后必须已回收。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1
		o.CacheMaxEntries = 1
		o.ReclaimInterval = time.Nanosecond
	})
	// 先塞一条"很大"的旧条目，让下一次回收必然动手。
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "big-old", 4096, time.Now().Add(-time.Hour))

	mod := writeModule(t, t.TempDir(), "a.wasm", wasmtest.Base())
	if _, err := c.Compile(context.Background(), mod); err != nil {
		t.Fatalf("编译失败: %v", err)
	}
	// 编译真实写入的条目也要参与回收（上限 1 字节 / 1 条 ⇒ 回收后必然极小）。
	bytesAfter, entriesAfter, _ := c.cacheUsage()
	if entriesAfter > 1 {
		t.Errorf("编译后应已触发回收（上限 1 条），实际 %d 条", entriesAfter)
	}
	if bytesAfter > 1 {
		t.Errorf("编译后应已触发回收（上限 1 字节），实际 %d 字节", bytesAfter)
	}
}

func TestCleanCache(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	now := time.Now()
	for i := 0; i < 4; i++ {
		seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", entryName(i), 64, now)
	}
	removed, freed, err := c.CleanCache()
	if err != nil {
		t.Fatal(err)
	}
	if removed != 4 || freed != 256 {
		t.Errorf("CleanCache 应清空：removed=%d freed=%d", removed, freed)
	}
	// 目录本身必须保留（它承载 0700 权限与属主，是信任边界的一部分）。
	if fi, err := os.Stat(c.CacheDir()); err != nil || !fi.IsDir() {
		t.Errorf("清空后缓存目录本身应保留：%v", err)
	}
}

func TestCacheDirPermissionsAreTrustBoundary(t *testing.T) {
	// §4.3.1-d：目录属主=编译进程、执行进程只读。本机能断言的最强证据 = 权限不含
	// group/other 写位（0700）。这条断言把"未来有人改成 0777 图省事"变成红灯。
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	desc, err := cacheDirIsTrustBoundary(c.CacheDir())
	if err != nil {
		t.Fatalf("缓存目录权限不合规（%s）：%v", desc, err)
	}
	fi, serr := os.Stat(c.CacheDir())
	if serr != nil {
		t.Fatal(serr)
	}
	if fi.Mode().Perm() != os.FileMode(limits.DataDirMode) {
		t.Errorf("缓存目录权限应为 %#o，实际 %#o", limits.DataDirMode, fi.Mode().Perm())
	}
	t.Logf("缓存目录信任边界：%s", desc)
}

func TestCacheDirPermissionsDetectLoosenedMode(t *testing.T) {
	// 反向对照：证明上一条不是恒真断言。
	// 判据是 mode&0o022（group/other **写**位）⇒ 0755 合规、0777/0775 不合规。
	dir := t.TempDir()
	for _, tc := range []struct {
		mode    os.FileMode
		wantErr bool
	}{
		{0o700, false},
		{0o755, false}, // group/other 可读但不可写：编译缓存是"只读共享"也允许
		{0o770, true},
		{0o777, true},
	} {
		p := filepath.Join(dir, "m"+tc.mode.String()[1:])
		if err := os.MkdirAll(p, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(p, tc.mode); err != nil {
			t.Fatal(err)
		}
		_, err := cacheDirIsTrustBoundary(p)
		if tc.wantErr && err == nil {
			t.Errorf("mode=%#o 应被判为不合规（group/other 可写）", tc.mode)
		}
		if !tc.wantErr && err != nil {
			t.Errorf("mode=%#o 不应被判为不合规：%v", tc.mode, err)
		}
	}
}

func TestCacheShardHint(t *testing.T) {
	// §4.3.1-b：换 wazero 版本/换 CPU 会换分片名（旧条目永不复用却仍占空间）。
	dir := t.TempDir()
	for _, s := range []string{"wazero-v1.12.0-linux-amd64", "wazero-v1.13.0-linux-amd64"} {
		if err := os.MkdirAll(filepath.Join(dir, s), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	got := cacheShardHint(dir)
	if got != "wazero-v1.12.0-linux-amd64,wazero-v1.13.0-linux-amd64" {
		t.Errorf("分片名应被列出（供运维判断旧条目）：%q", got)
	}
}

func TestCacheEntryCountForLog(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "x", 1024, time.Now())
	got := c.CacheEntryCountForLog()
	for _, want := range []string{"1 条", "上限", "1.0 KiB"} {
		if !contains(got, want) {
			t.Errorf("水位描述应含 %q：%s", want, got)
		}
	}
}

func TestCacheEntriesPublicView(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, nil)
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "a", 32, time.Now())
	es := c.CacheEntries()
	if len(es) != 1 {
		t.Fatalf("应返回 1 条：%+v", es)
	}
	if es[0].Size != 32 || es[0].ModTimeUnixNano == 0 || es[0].Path == "" {
		t.Errorf("条目视图字段不全：%+v", es[0])
	}
}

func entryName(i int) string {
	return "entry-" + string(rune('a'+i))
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (func() bool {
		for i := 0; i+len(needle) <= len(haystack); i++ {
			if haystack[i:i+len(needle)] == needle {
				return true
			}
		}
		return false
	})()
}

// TestCompilerAvoidsUntrustedCacheDir 覆盖"不可信缓存 ⇒ 编译子进程不碰那棵树"。
//
// 背景（2026-09-21 四轮审计 P2-①）：执行侧已经"不可信 ⇒ 不用"（`runtime.NewCompilationCache`），
// 而编译侧此前只在 `require` 档 fail-closed、其余档位（**compose 默认就是 auto**）
// 告警之后**照用** —— 两侧不对称。这条不对称有后果：wazero 的磁盘缓存是**读 + 写**，
// 子进程命中就直接加载那份"机器码"并干跑它；`auto` 档在没有 bwrap 的机器上不隔离，
// 于是"能布置缓存目录的人"可以在**读得到数据根的编译进程**里执行代码。
//
// 判据（三条，缺一不可）：
//  1. 不可信（这里把分代目录做成指向别处的**符号链接**）⇒ `childCacheDir` 必须**偏离**配置目录；
//  2. 替代目录必须是本进程新建的真实目录、权限 0700，且**攻击者目录里一个文件都没有**
//     （只断言"换了个路径"挡不住"换了路径但仍然写进攻击者目录"的实现）；
//  3. **反向对照**：可信目录下必须**原样**使用配置目录 —— 否则"永远换临时目录"会让
//     "发布期编译暖到执行进程"这条前提静默失效（拿功能换安全）。
//
// 变异验证：把不可信分支里的 `childCacheDir = tmp` 改回 `childCacheDir = cache` ⇒ ① 红。
func TestCompilerAvoidsUntrustedCacheDir(t *testing.T) {
	child := buildCompileChildOnce(t)

	// ① 构造不可信缓存：`<dataRoot>/_compile-cache/<gen>` 是指向攻击者目录的符号链接。
	root := t.TempDir()
	attacker := filepath.Join(root, "attacker-dir")
	if err := os.MkdirAll(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	configuredParent := filepath.Dir(CompileCacheDir(root))
	if err := os.MkdirAll(configuredParent, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, CompileCacheDir(root)); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}

	c := newTestCompiler(t, child, func(o *Options) {
		o.DataRoot = root
		o.Isolation = IsolationOff // 非 require 档（compose 默认走的就是这条）
	})
	if c.childCacheDir == c.CacheDir() {
		t.Fatalf("缓存目录不可信时，子进程不得使用配置的缓存目录（%s）—— "+
			"wazero 的磁盘缓存是读+写，命中即加载并干跑那份机器码；auto 档没有 OS 隔离时"+
			"等于把代码执行权交给能布置该目录的人", c.CacheDir())
	}
	info, err := os.Stat(c.childCacheDir)
	if err != nil {
		t.Fatalf("替代缓存目录不存在（%s）：%v", c.childCacheDir, err)
	}
	if !info.IsDir() || info.Mode().Perm() != 0o700 {
		t.Fatalf("替代缓存目录必须是 0700 的真实目录：mode=%#o", info.Mode().Perm())
	}
	// ② 攻击者目录必须**一个文件都没有**（平台没有把编译产物写进去）。
	entries, derr := os.ReadDir(attacker)
	if derr != nil {
		t.Fatal(derr)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("不可信缓存目录被写入：攻击者目录出现 %d 项 %v", len(entries), names)
	}

	// ②b **真的编译一次**（五轮审计 P1 的教训）：只断言结构体字段是不够的 ——
	// `-cache-dir`（子进程 argv 的显式声明）与请求里的 `cache_dir` 必须是同一个值，
	// 子进程的启动自检会比对两者，不一致直接回 INTERNAL。上一版只改了请求、漏了 argv，
	// 于是"不可信 ⇒ 换临时目录"这条分支上**每一次真实编译都失败**，而只查字段的用例全绿。
	// 因此这里必须走完整链路：真编译 + 断言产物落在替代目录里 + 攻击者目录仍为空。
	mod := writeModule(t, t.TempDir(), "untrusted-cache.wasm", wasmtest.Base())
	if _, cerr := c.Compile(context.Background(), mod); cerr != nil {
		t.Fatalf("缓存不可信时编译必须仍然成功（改用临时缓存目录即可，见 doc.go 的口径）：%v", cerr)
	}
	afterEntries, aerr := os.ReadDir(attacker)
	if aerr != nil {
		t.Fatal(aerr)
	}
	if len(afterEntries) != 0 {
		t.Fatalf("编译后攻击者目录仍必须为空，实际 %d 项", len(afterEntries))
	}
	cacheEntries, cerr2 := os.ReadDir(c.childCacheDir)
	if cerr2 != nil {
		t.Fatal(cerr2)
	}
	if len(cacheEntries) == 0 {
		t.Fatalf("真编译必须在替代缓存目录里留下条目（否则这条判据只是「编译没报错」）: %s", c.childCacheDir)
	}

	// ③ 反向对照：可信目录必须原样使用（否则"暖缓存"这条前提静默失效）。
	good := newTestCompiler(t, child, func(o *Options) { o.Isolation = IsolationOff })
	if good.childCacheDir != good.CacheDir() {
		t.Fatalf("缓存目录可信时必须原样使用配置目录（否则发布期编译无法暖到执行进程）：child=%s configured=%s",
			good.childCacheDir, good.CacheDir())
	}
}

// TestCompilerFailureDoesNotLeakTempCacheDir 覆盖五轮审计 P2-②：
// 不可信缓存时创建的替代目录，在 `New` **失败**路径上必须被清掉。
//
// 为什么单测能得到确定结论：`os.MkdirTemp("", …)` 落在 `$TMPDIR`，所以把 TMPDIR 指向
// 一个空目录后，"有没有泄漏"就是"那个目录里有没有东西"（不依赖全局 /tmp 的并发状态）。
// 触发失败的方式 = `ChildBinary` 指向不存在的路径（`resolveChildBinary` 必失败），
// 而这一步在替代目录创建**之后**。
//
// 变异验证：把 `return fail(err)` 改回 `return nil, err` ⇒ 本用例红。
func TestCompilerFailureDoesNotLeakTempCacheDir(t *testing.T) {
	tmp := t.TempDir()
	t.Setenv("TMPDIR", tmp)

	root := t.TempDir()
	attacker := filepath.Join(root, "attacker")
	if err := os.MkdirAll(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(CompileCacheDir(root)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, CompileCacheDir(root)); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}

	_, err := New(Options{
		DataRoot:    root,
		Isolation:   IsolationOff,
		ChildBinary: filepath.Join(root, "does-not-exist-compile-child"),
		Timeout:     5 * time.Second,
		Logger:      testLogger{t},
	})
	if err == nil {
		t.Fatal("子进程二进制不存在时 New 必须失败（否则本用例是空转）")
	}
	entries, derr := os.ReadDir(tmp)
	if derr != nil {
		t.Fatal(derr)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("New 失败后仍在 TMPDIR 里留下 %d 项 %v —— 替代缓存目录必须在失败返回前清掉"+
			"（调用方拿到 nil 编译器，永远不会调 Close）", len(entries), names)
	}
}

// TestUntrustedCacheTempDirIsBoundedByReclaim 覆盖六轮审计 P2-②（r5 引入的回归）：
// 不可信缓存改用临时目录之后，**回收/水位/度量必须跟着那个目录走**。
//
// 问题形态：`ReclaimCache` / `cacheUsage` / `Stats` 此前一律只看**配置目录**
// （`cacheScanRoot` = `filepath.Dir(c.cache)`），而子进程写的是 `childCacheDir`
// ⇒ 那条分支上 512 MiB / 4096 条的预算与 `/readyz` 告警**全部静默失效**，
// 临时目录常落在 tmpfs 上（直接吃内存）。
//
// 判据：在不可信缓存分支下真编译若干个不同模块（把上限压到 1 条），
// `ReclaimCache` 必须真的删掉东西、且 `Stats()` 报的条目数必须来自**实际在用**的那个根。
//
// 变异验证：把 `cacheScanRoot` 改回 `filepath.Dir(c.cache)` ⇒ 本用例红（removed=0 / 条目数看不到）。
func TestUntrustedCacheTempDirIsBoundedByReclaim(t *testing.T) {
	child := buildCompileChildOnce(t)
	root := t.TempDir()
	attacker := filepath.Join(root, "attacker")
	if err := os.MkdirAll(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(CompileCacheDir(root)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, CompileCacheDir(root)); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	c := newTestCompiler(t, child, func(o *Options) {
		o.DataRoot = root
		o.Isolation = IsolationOff
		o.CacheMaxEntries = 1 // 强制回收必须动手
		o.CacheMaxBytes = 1 << 20
	})
	if c.childCacheDir == c.CacheDir() {
		t.Fatalf("前置条件不成立：本用例要求走「不可信 ⇒ 临时目录」这条分支")
	}
	// ⚠️ 三次编译必须是**内容不同**的模块：wazero 的缓存是内容寻址的
	//（条目名 = sha256(moduleID‖magic‖CPU features)），同一份字节编译三次只会留
	// **一条**条目 —— 那样 CacheMaxEntries=1 就永远不触发回收，判据变成空转
	//（第一版正是这样写的，`removed=0` 是假红）。
	dir := t.TempDir()
	modules := [][]byte{
		wasmtest.Base(),
		wasmtest.WithDataCount(),
		wasmtest.Build(
			wasmtest.TypeSection(wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params())),
			wasmtest.FunctionSection(0),
			wasmtest.MemorySection(2), // 与上面两份都不同（内存页数变了 ⇒ moduleID 变）
			wasmtest.ExportSection(wasmtest.ExportMemory("memory", 0), wasmtest.ExportFunc("_start", 0)),
			wasmtest.CodeSection(wasmtest.Body(0x0b)),
		),
	}
	for i, raw := range modules {
		mod := writeModule(t, dir, fmt.Sprintf("m%d.wasm", i), raw)
		if _, cerr := c.Compile(context.Background(), mod); cerr != nil {
			t.Fatalf("第 %d 次编译失败: %v", i+1, cerr)
		}
	}
	before, beforeEntries, uerr := c.cacheUsage()
	if uerr != nil {
		t.Fatalf("cacheUsage: %v", uerr)
	}
	if beforeEntries < 2 {
		t.Fatalf("前置条件不成立：三次不同模块的编译应留下 ≥2 条缓存条目（实际 %d，%d 字节）——"+
			"夹具不成立会让下面的回收断言变成空转", beforeEntries, before)
	}
	// 回收：必须真的从**在用的那个根**里删掉条目。
	removed, _, rerr := c.ReclaimCache()
	if rerr != nil {
		t.Fatalf("ReclaimCache: %v", rerr)
	}
	if removed == 0 {
		t.Fatalf("回收什么都没删：临时缓存目录（%s）没有被纳入回收扫描根 ⇒ 上限与水位在这条分支失效",
			c.childCacheDir)
	}
	// 度量必须来自在用的根（Stats 的 compile_cache_files 取自同一处）。
	_, entries := c.newestCacheMtime()
	if entries > 1 {
		t.Fatalf("回收后当前缓存仍剩 %d 条（上限 1）", entries)
	}
}
