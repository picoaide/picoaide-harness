package runtime

// 本文件是 `/readyz` 的 `exec_cache_mode`（Task：磁盘缓存不可用 ⇒ 进程内缓存）在
// **运行时这一侧**的判据。
//
// 缺陷形态（要防的东西）：探针上写着一个模式，而运行时实际用的是另一个缓存
// （"探针说 disk、实际跑 memory"）。因此本用例不看任何常量/字符串，而是**做真事**：
//
//	① 建运行时 → 读 rt.CacheMode()（被测值）；
//	② 用一个最小合法模块真的编译一次；
//	③ 数**磁盘缓存目录里真的出现了几个条目**（runtime.CacheUsage 是只读度量）。
//
// 判据 = ①与③必须一致：报 disk ⟺ 编译真的往磁盘写了条目；报 memory ⟺ 磁盘上一条没有。
// 两边的期望都断言（不是只断言"降级时是 memory"），因此这条闸不会因为"磁盘路径也
// 悄悄降级了"而假绿。
//
// 变异验证（实跑）：
//   - 把 resolveCompilationCache 的降级分支改成 `return mem, CacheModeDisk` ⇒ 第 2 行
//     用例红（报 disk 而磁盘上零条目）；
//   - 把 cacheModeOf 改成恒返回 CacheModeMemory ⇒ 第 1 行（正常磁盘路径）红。

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/tetratelabs/wazero"
)

// minimalWasmModule 是**合法但什么都不做**的最小 wasm 模块（magic + version）。
//
// 它足以驱动 wazero 的编译路径（engine.addCompiledModule → fileCache.Add），
// 从而把"这台运行时的缓存到底写不写磁盘"变成可观测事实 —— 这正是本用例要的：
// 判据落在**行为**上，不落在我们对分支的记忆上。
var minimalWasmModule = []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}

// diskCacheEntries 返回磁盘缓存目录里的条目数（缓存根不是**真实目录**/不存在 ⇒ 0）。
//
// 用 runtime.CacheUsage（唯一只读度量实现，与 /readyz 的 compile_cache_* 同源）
// 而不是自己 walk：判据要与产品看到的口径一致。
//
// ⚠️ 先判"是真实目录"再数：磁盘缓存不可用的形态之一正是"缓存根被普通文件占住"
// （cachetrust 的"缓存根路径不是目录"），此时 CacheUsage 会把**占位文件本身**数成
// 1 条 —— 那是"目录不可用"而不是"运行时写了缓存"，直接数会给出相反的结论。
func diskCacheEntries(root string) int {
	if root == "" {
		return 0
	}
	dir := CompileCacheDir(root)
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		return 0
	}
	_, entries, err := CacheUsage(dir)
	if err != nil {
		return 0
	}
	return entries
}

// occupyCacheDirWithFile 让 <root>/_compile-cache/<分代> 变成一个**普通文件**。
//
// 这是"磁盘缓存不可用"里最干净的一种形态：cachetrust.Ensure 对它只给**违规报告**
// （nil error，见 cachetrust.go 的 "缓存根路径不是目录" 分支），因此执行侧走
// "不可信 ⇒ 不用"（NewCompilationCache 返回 (nil, nil)）、编译侧走"不可信 ⇒ 临时目录"
// —— 两侧同一次降级，与真实部署里的只读挂载/路径被占同形。
func occupyCacheDirWithFile(t *testing.T, root string) {
	t.Helper()
	dir := CompileCacheDir(root)
	if err := os.MkdirAll(filepath.Dir(dir), 0o700); err != nil {
		t.Fatalf("建缓存父目录失败: %v", err)
	}
	if err := os.WriteFile(dir, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("占用缓存目录路径失败: %v", err)
	}
}

// TestRuntimeCacheModeMatchesBuiltCache 是本文件的判据本体（见文件头）。
func TestRuntimeCacheModeMatchesBuiltCache(t *testing.T) {
	ctx := context.Background()

	cases := []struct {
		name string
		// opts 造装配参数；root 是该用例的数据根（可为空 = 没有数据根）。
		opts func(t *testing.T) (Options, string)
		want CacheMode
		// wantDiskWrites 是"编译一次之后，磁盘缓存里必须真的有条目"。
		wantDiskWrites bool
	}{
		{
			name: "正常路径：DataRoot 可用 ⇒ disk，且编译真的写盘",
			opts: func(t *testing.T) (Options, string) {
				root := t.TempDir()
				return Options{DataRoot: root}, root
			},
			want:           CacheModeDisk,
			wantDiskWrites: true,
		},
		{
			name: "降级路径：缓存根被普通文件占住 ⇒ memory，且磁盘上零条目",
			opts: func(t *testing.T) (Options, string) {
				root := t.TempDir()
				occupyCacheDirWithFile(t, root)
				return Options{DataRoot: root}, root
			},
			want:           CacheModeMemory,
			wantDiskWrites: false,
		},
		{
			name: "没有 DataRoot ⇒ memory（单机验证/最小装配）",
			opts: func(t *testing.T) (Options, string) {
				return Options{}, ""
			},
			want:           CacheModeMemory,
			wantDiskWrites: false,
		},
		{
			name: "调用方注入内存缓存 ⇒ memory（注入路径也必须问对象自己）",
			opts: func(t *testing.T) (Options, string) {
				root := t.TempDir()
				return Options{DataRoot: root, CompilationCache: wazero.NewCompilationCache()}, root
			},
			want:           CacheModeMemory,
			wantDiskWrites: false,
		},
		{
			name: "调用方注入磁盘缓存 ⇒ disk",
			opts: func(t *testing.T) (Options, string) {
				root := t.TempDir()
				c, err := NewCompilationCache(root)
				if err != nil {
					t.Fatalf("NewCompilationCache: %v", err)
				}
				if c == nil {
					t.Fatal("干净目录必须给出磁盘缓存（夹具失效）")
				}
				return Options{DataRoot: root, CompilationCache: c}, root
			},
			want:           CacheModeDisk,
			wantDiskWrites: true,
		},
	}

	// 至少一条"真的写盘"的用例：否则整组可能因为"谁都写不进去"而假绿。
	diskCases := 0
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			opts, root := tc.opts(t)
			rt, err := New(ctx, opts)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			defer func() { _ = rt.Close(ctx) }()

			got := rt.CacheMode()
			if got != tc.want {
				t.Fatalf("rt.CacheMode() = %q, want %q（模式必须是对**真的装进 wazero 的**那个缓存的判定）", got, tc.want)
			}
			// 真编译一次：没有这一步，"磁盘上零条目"什么也证明不了
			//（运行时可能压根没走编译路径）。
			if _, cerr := rt.CompileModule(ctx, minimalWasmModule); cerr != nil {
				t.Fatalf("CompileModule(最小模块) 失败: %v", cerr)
			}
			entries := diskCacheEntries(root)
			if tc.wantDiskWrites && entries == 0 {
				t.Fatalf("模式报 %q，但编译后磁盘缓存里 0 条目 —— "+
					"说明探测手段失效或运行时其实没用磁盘缓存（判据不能假绿）", got)
			}
			if !tc.wantDiskWrites && entries != 0 {
				t.Fatalf("模式报 %q，但编译后磁盘缓存里有 %d 条目 —— "+
					"报告的模式与运行时实际构建的缓存分叉了", got, entries)
			}
		})
	}
	for _, tc := range cases {
		if tc.wantDiskWrites {
			diskCases++
		}
	}
	if diskCases == 0 {
		t.Fatal("用例表里没有一条期望真写盘 —— 判据会退化成空转")
	}
	if diskCases == len(cases) {
		t.Fatal("用例表里没有一条期望降级 —— 判据测不到 memory 那一侧")
	}
}

// TestRuntimeCacheModeNilRuntime 钉住"没有运行时"不得伪装成任何一种模式。
func TestRuntimeCacheModeNilRuntime(t *testing.T) {
	var rt *Runtime
	if got := rt.CacheMode(); got != "" {
		t.Fatalf("nil Runtime 的 CacheMode() = %q, want 空串（空值 ≠ 任何一种模式）", got)
	}
}
