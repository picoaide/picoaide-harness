package runtime

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
)

// 本文件覆盖 §4.3.1（编译缓存：唯一构造函数 / 指纹 / 目录 / 分代）。
//
// 变异方式（把闸门改回危险默认值，用例必红）：
//   - 去掉 NewRuntimeConfig 的 WithCloseOnContextDone(true) ⇒ TestRuntimeConfigFingerprint_KeysOnly 第一条红；
//   - 让 RuntimeConfigFingerprint 把 memoryLimitPages 也序列化进去 ⇒ 同用例的"内存上限不进键"断言红；
//   - 把 cacheNamespaceFor 改成"恒返回 limits.CompileCacheRevision"（旧实现）⇒
//     TestCacheNamespacePrefersWazeroVersion 红（FIX-34）。
//
// ⚠️ 回收（超上限删除条目）的判据**不在本包**：唯一实现是 compile.ReclaimCache
// （runtime.PruneCompilationCache 已按审计 P2-3 删除——它在生产路径零调用点）；本包只保留
// 只读度量 CacheUsage。

func TestRuntimeConfigFingerprint_KeysOnly(t *testing.T) {
	base := NewRuntimeConfig()
	fp := RuntimeConfigFingerprint(base)
	t.Logf("fingerprint(base) = %s", fp)

	if !strings.Contains(fp, "closeOnContextDone=true") {
		t.Fatalf("指纹必须显示 CloseOnContextDone=true（§4.3：不开则 ctx 超时完全不生效）: %s", fp)
	}
	if got := RuntimeConfigFingerprint(NewRuntimeConfig()); got != fp {
		t.Fatalf("同一构造函数两次结果的指纹必须相同: %s vs %s", got, fp)
	}

	// §4.3.1-a：WithCloseOnContextDone **进**缓存键（moduleID 的 ensureTermination 字节）。
	if got := RuntimeConfigFingerprint(NewRuntimeConfig().WithCloseOnContextDone(false)); got == fp {
		t.Fatal("WithCloseOnContextDone 不进指纹 ⇒ 两侧配置不一致会被漏判（§4.3.1-a）")
	}
	// §4.3.1-a：WithMemoryLimitPages **不进**缓存键（实测：只改内存上限命中同一键）。
	if got := RuntimeConfigFingerprint(NewRuntimeConfig().WithMemoryLimitPages(256)); got != fp {
		t.Fatalf("WithMemoryLimitPages 不应进指纹（它不进缓存键，§4.3.1-a）: %s vs %s", got, fp)
	}
	// 引擎种类与 CoreFeatures 会改变编译产物 ⇒ 必须进指纹。
	if got := RuntimeConfigFingerprint(wazero.NewRuntimeConfigInterpreter().WithCloseOnContextDone(true)); got == fp {
		t.Fatal("解释器引擎的指纹不应等于编译器引擎")
	}
	if got := RuntimeConfigFingerprint(NewRuntimeConfig().WithCoreFeatures(api.CoreFeaturesV1)); got == fp {
		t.Fatal("CoreFeatures 不同的指纹不应相等")
	}
	// nil 安全性（诊断路径不能因为拿到 nil 就 panic）。
	if got := RuntimeConfigFingerprint(nil); got == "" {
		t.Fatal("nil RuntimeConfig 的指纹不应为空串")
	}
}

func TestNewCompilationCache_DirModeAndEntries(t *testing.T) {
	root := t.TempDir()
	cache, err := NewCompilationCache(root)
	if err != nil {
		t.Fatalf("NewCompilationCache: %v", err)
	}
	defer func() { _ = cache.Close(context.Background()) }()

	dir := CompileCacheDir(root)
	// 目录形状 = <dataRoot>/_compile-cache/<分代>；分代名 = wazero 真实版本（拿不到时回落到
	// limits.CompileCacheRevision）。生产形态（go build 的 main 二进制）自带真版本，
	// 所以升级 wazero 后旧目录**本来就不会被命中**（审计 P1-3 的事实更正）。
	want := filepath.Join(root, limits.CompileCacheDirName, cacheNamespace())
	if dir != want {
		t.Fatalf("缓存目录 = %s，期望 <dataRoot>/%s/<分代=%s>（§4.3 / limits 唯一真源）",
			dir, limits.CompileCacheDirName, cacheNamespace())
	}
	// 分代子目录必须在缓存根**之下**：缓存根是整个 _compile-cache（回收扫所有分代的地方），
	// 分代目录是这一代条目实际落盘的地方。
	if parent := filepath.Dir(dir); parent != filepath.Join(root, limits.CompileCacheDirName) {
		t.Fatalf("分代目录的父目录 = %s，期望 %s", parent, filepath.Join(root, limits.CompileCacheDirName))
	}
	if _, err := os.Stat(filepath.Join(root, limits.CompileCacheDirName)); err != nil {
		t.Fatalf("缓存根目录未创建: %v", err)
	}
	fi, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("缓存目录未创建: %v", err)
	}
	if perm := fi.Mode().Perm(); perm != os.FileMode(limits.DataDirMode) {
		t.Fatalf("缓存目录权限 = %o，期望 %o（§4.3.1-d：目录是信任边界）", perm, limits.DataDirMode)
	}
	if _, err := NewCompilationCache(""); err == nil {
		t.Fatal("空 dataRoot 必须报错（否则缓存会落在进程 cwd）")
	}

	// 真编译一个模块，确认条目落进 wazero 的版本分片子目录。
	rt, err := New(context.Background(), Options{DataRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()
	if _, err := rt.CompileModule(context.Background(), rawUnreachableModule()); err != nil {
		t.Fatalf("CompileModule: %v", err)
	}
	bytesUsed, entries, err := CacheUsage(dir)
	if err != nil {
		t.Fatalf("CacheUsage: %v", err)
	}
	if entries != 1 {
		t.Fatalf("编译一次后应有 1 条缓存条目，实际 %d（bytes=%d）", entries, bytesUsed)
	}
	if bytesUsed <= 0 {
		t.Fatalf("缓存条目字节数应 > 0，实际 %d", bytesUsed)
	}
	sub, err := filepath.Glob(filepath.Join(dir, "wazero-*"))
	if err != nil || len(sub) != 1 {
		t.Fatalf("应有且仅有一个 wazero-v<ver>-<arch>-<os> 版本分片目录，实际 %v (err=%v)", sub, err)
	}
	t.Logf("缓存条目：%d 条 / %d 字节，分片目录 %s", entries, bytesUsed, filepath.Base(sub[0]))
}

// 编译缓存回收的用例在 compile 包（唯一实现在那里：compile.ReclaimCache）。
//
// 这里原有的 TestPruneCompilationCache_ByAge 已随 runtime.PruneCompilationCache 一并删除
// （审计 P2-3：runtime 侧那份没有生产调用点，与 compile 侧重复）。等价判据（按 mtime 从旧到新、
// 两个维度同时满足、目录不存在不是错误、单条超限也删）在 compile/cache_test.go 与
// compile 的 TestReclaimCacheScansAllGenerations 里；"回收仍然生效"由
// TestReclaimCacheIsCalledByCompilerLoop（编译循环真的调它）保证。

// TestCacheNamespacePrefersWazeroVersion 是分代规则（FIX-34 / 审计 P1-3）的判据：
// **优先用 wazero 的真实版本**，只在拿不到版本时回落到手写常量。
//
// 变异方式：把 cacheNamespaceFor 改成"恒返回 limits.CompileCacheRevision"（旧实现）⇒
// 本用例红；改成"恒返回入参" ⇒ 回落断言红。
func TestCacheNamespacePrefersWazeroVersion(t *testing.T) {
	cases := []struct {
		in, want, why string
	}{
		{"v1.12.0", "v1.12.0", "生产 main 二进制里的真版本：wazero 自己就按它分片，升级即整代失效"},
		{"v1.13.0-rc.1", "v1.13.0-rc.1", "预发版本同样可以当分代名（升级必须换目录）"},
		{"", limits.CompileCacheRevision, "拿不到版本（test 二进制）⇒ 回落到手写常量"},
		{"dev", limits.CompileCacheRevision, "wazero 的 Default 值：同回落"},
		{"(devel)", limits.CompileCacheRevision, "Go 工具链的未定版本标记：同回落"},
		{"  ", limits.CompileCacheRevision, "空白等同缺失"},
	}
	for _, c := range cases {
		if got := cacheNamespaceFor(c.in); got != c.want {
			t.Errorf("cacheNamespaceFor(%q) = %q，期望 %q（%s）", c.in, got, c.want, c.why)
		}
	}
	// 生效值：test 二进制里必须是回落常量（否则说明解析逻辑在这台机器上行为不同，
	// 那正是需要知道的信号）。
	if got := cacheNamespace(); got != limits.CompileCacheRevision {
		t.Logf("注意：test 二进制里 cacheNamespace()=%q（期望回落常量 %q）—— "+
			"若 Go 工具链开始在 test 二进制里带 Deps，这是**变好**的方向：请同步更新本断言与文档",
			got, limits.CompileCacheRevision)
	}
}

func TestInstanceLimits_DefaultsFromLimitsPackage(t *testing.T) {
	var zero InstanceLimits
	if got := zero.MemoryLimitPages(); got != limits.InstanceMemoryPages {
		t.Fatalf("MemoryLimitPages 缺省 = %d，期望 limits.InstanceMemoryPages=%d", got, limits.InstanceMemoryPages)
	}
	if got := zero.EffectiveGuestBudget(); got != limits.GuestBudget {
		t.Fatalf("GuestBudget 缺省 = %s，期望 limits.GuestBudget=%s", got, limits.GuestBudget)
	}
	if got := zero.HostBudget("db.query"); got != limits.HostCallBudgetDefault {
		t.Fatalf("未单列预算的方法应回落到 limits.HostCallBudgetDefault，实际 %s", got)
	}
	if got := zero.HostBudget("db.query"); got != limits.HostCallBudgetDefault {
		t.Fatalf("未单列预算的宿主方法应回落 limits.HostCallBudgetDefault，实际 %s", got)
	}
	// 显式配置优先；非正值视为未设置（防"手滑设成 0"变成全部立即超时）。
	custom := InstanceLimits{HostBudgets: map[string]time.Duration{"assets.read": time.Second, "db.query": 0}}
	if got := custom.HostBudget("assets.read"); got != time.Second {
		t.Fatalf("显式预算应生效，实际 %s", got)
	}
	if got := custom.HostBudget("db.query"); got != limits.HostCallBudgetDefault {
		t.Fatalf("非正预算应回落到缺省，实际 %s", got)
	}
}

func TestServe_MemoryPagesMismatchIsRejected(t *testing.T) {
	// 内存上限是 RuntimeConfig 项（§4.3.1-c 的逐请求清单不含它）⇒ 请求侧声明不一致
	// 必须 fail-loud，不能静默取一个值假装限制生效。
	rt := sharedRuntime(t)
	req := testRequest("/ok", newFakeHost())
	req.Budgets.MemoryPages = limits.InstanceMemoryPages * 2
	if _, err := rt.Serve(context.Background(), appModule(t), req); err == nil {
		t.Fatal("请求侧内存上限与运行时不一致时必须报错")
	}
}

// TestRuntimeDegradesToInMemoryCacheWhenDiskCacheUnusable 是 P1-① 的**执行侧**判据。
//
// 背景（2026-09-21 独立审计 P1-①）：`cachetrust.Ensure` 的错误原先会一路冒泡到
// cmd/server 的 `log.Fatalf` —— 只读挂载、`--user` 非属主、k8s `runAsUser` 下
// Chmod 必然失败，于是**整个服务端起不来**，而它本该只是"首次编译慢一点"。
//
// 判据两条：
//  1. 磁盘缓存不可用时 `NewCompilationCache` 返回 (nil, nil)（降级信号，不是错误）；
//  2. `runtime.New` 收到这个信号后仍能装配成功并**真能编译**（不能把 nil 缓存
//     直接交给 wazero —— 那会在装配期炸）。
//
// 构造方式：把缓存根路径的位置先占成**普通文件**（`<dataRoot>/_compile-cache`
// 无法成为目录），于是 Ensure 报"根路径不是目录"⇒ 磁盘缓存拿不到。
// 变异验证：把 NewCompilationCache 的降级分支改回 `return nil, err`（或让 runtime.New
// 原样把 nil 交给 wazero）⇒ 本用例红。
func TestRuntimeDegradesToInMemoryCacheWhenDiskCacheUnusable(t *testing.T) {
	root := t.TempDir()
	// 占位：让 <dataRoot>/_compile-cache 成为一个**普通文件**。
	blocked := filepath.Join(root, limits.CompileCacheDirName)
	if err := os.WriteFile(blocked, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	cache, err := NewCompilationCache(root)
	if err != nil {
		t.Fatalf("磁盘缓存不可用不应是致命错误（执行侧必须能降级）：%v", err)
	}
	if cache != nil {
		_ = cache.Close(context.Background())
		t.Fatal("根路径被普通文件占位时不应拿到磁盘缓存")
	}

	// 降级路径必须真的能起运行时并编译。
	rt, err := New(context.Background(), Options{DataRoot: root})
	if err != nil {
		t.Fatalf("缓存不可用时 runtime.New 必须仍能装配（降级为进程内缓存）：%v", err)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	mod, cerr := rt.CompileModule(context.Background(), wasmtest.WithDataCount())
	if cerr != nil {
		t.Fatalf("降级后必须仍能编译（否则降级只是把崩溃换成不可用）：%v", cerr)
	}
	if mod == nil {
		t.Fatal("编译返回 nil 模块")
	}
	_ = mod.Close(context.Background())
}

// TestRuntimeDegradesWhenCacheRootIsRegularFile 覆盖 P2-④ 的边界形态。
//
// 与上一条的区别（2026-09-21 二轮审计 P2-④）：上一条堵的是**父目录**被文件占住
// （`Ensure` 返回 err ⇒ 第一版就降级了）；这一条堵的是**缓存分代目录自身**被普通文件占住 ——
// 此时 `Ensure` 的 `Lstat` 看到"存在但不是目录" ⇒ 返回**违规报告 + nil error**，
// 第一版于是继续往下走，由 `wazero.NewCompilationCacheWithDir` 失败 ⇒ `return nil, err`
// ⇒ `runtime.New` 失败 ⇒ `appserver.New` 失败 ⇒ `cmd/server` 的 `log.Fatalf`
// —— "缓存不可用只是慢一点"的承诺在这个形态下不成立（审计实测 err="… is not dir"）。
//
// 判据：两种占位形态下，`NewCompilationCache` 都必须返回 `(nil, nil)`（降级信号），
// 且 `runtime.New` 仍能装配 + 真编译。
// 变异验证：把 `wazero.NewCompilationCacheWithDir` 的错误分支改回 `return nil, err` ⇒ 本用例红。
func TestRuntimeDegradesWhenCacheRootIsRegularFile(t *testing.T) {
	root := t.TempDir()
	// 把**分代目录**（CompileCacheDir(root)）本身占成普通文件。
	dir := CompileCacheDir(root)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	cache, err := NewCompilationCache(root)
	if err != nil {
		t.Fatalf("分代目录被普通文件占住时必须降级而不是报错（报错会一路 log.Fatalf 打死服务端）：%v", err)
	}
	if cache != nil {
		_ = cache.Close(context.Background())
		t.Fatal("分代目录不可用时不应拿到磁盘缓存")
	}

	rt, rerr := New(context.Background(), Options{DataRoot: root})
	if rerr != nil {
		t.Fatalf("缓存不可用时 runtime.New 必须仍能装配（降级为进程内缓存）：%v", rerr)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	mod, cerr := rt.CompileModule(context.Background(), wasmtest.WithDataCount())
	if cerr != nil {
		t.Fatalf("降级后必须仍能编译：%v", cerr)
	}
	if mod == nil {
		t.Fatal("编译返回 nil 模块")
	}
	_ = mod.Close(context.Background())
}

// TestRuntimeRefusesUntrustedCacheDir 覆盖"不可信但可用"这一形态（三轮审计 P1-②）。
//
// 与上两条的区别：那条堵的是"目录不可用"（Ensure 报错 / wazero 打不开）；
// 这一条堵的是**目录可用但已判定不可信** —— 缓存根是**符号链接**（违规文案：
// "可被重定向到任意位置"）。第一版只打日志然后继续用，于是执行进程会从这个
// 被重定向的目录**读**（mmap 成机器码）并**写**编译产物，而"条目只有同文件 CRC32"
// 意味着布置链接的人可以自算 CRC 投毒。
//
// 判据三条（缺一不可）：
//  1. `NewCompilationCache` 返回 `(nil, nil)`（降级信号，不是错误 —— 服务端不许因此起不来）；
//  2. `runtime.New` 仍能装配并真编译（降级后功能不破）；
//  3. **链接目标目录里不出现任何新文件**（这条是关键：只断言 (nil,nil) 挡不住
//     "先用了再返回 nil" 的实现；目标目录被写入 = 平台真的把机器码放到了攻击者选的位置）。
//
// 变异验证：把 `!report.Trusted()` 分支改回"只打日志继续"（即删掉 `return nil, nil`）
// ⇒ 本用例红（cache 非 nil，且目标目录出现 wazero 分片/条目）。
func TestRuntimeRefusesUntrustedCacheDir(t *testing.T) {
	root := t.TempDir()
	attacker := filepath.Join(root, "attacker-dir")
	if err := os.MkdirAll(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	// 把**分代目录**做成指向攻击者目录的符号链接（父目录先建好）。
	dir := CompileCacheDir(root)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, dir); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}

	cache, err := NewCompilationCache(root)
	if err != nil {
		t.Fatalf("不可信缓存不得导致报错（否则会一路 log.Fatalf）：%v", err)
	}
	if cache != nil {
		_ = cache.Close(context.Background())
		t.Fatal("缓存根是符号链接时必须降级为 nil（不得照用被重定向的目录）")
	}

	rt, rerr := New(context.Background(), Options{DataRoot: root})
	if rerr != nil {
		t.Fatalf("降级后 runtime.New 必须仍能装配：%v", rerr)
	}
	t.Cleanup(func() { _ = rt.Close(context.Background()) })
	mod, cerr := rt.CompileModule(context.Background(), wasmtest.WithDataCount())
	if cerr != nil {
		t.Fatalf("降级后必须仍能编译：%v", cerr)
	}
	if mod != nil {
		_ = mod.Close(context.Background())
	}

	// ③ 链接目标必须**一个字节都没多**（平台没有把编译产物写进攻击者选的目录）。
	entries, derr := os.ReadDir(attacker)
	if derr != nil {
		t.Fatal(derr)
	}
	if len(entries) != 0 {
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("不可信缓存目录被照用：链接目标里出现了 %d 项 %v（平台把编译产物写进了被重定向的目录）",
			len(entries), names)
	}
}
