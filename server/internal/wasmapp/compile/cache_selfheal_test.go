package compile

// 本文件是**编译侧对"缓存目录被外部删除"的反应**的特征化判据（审计 R5-A-2 的对照面）。
//
// 结论（本用例钉住的事实，也是"为什么编译侧不加自愈代码"的依据）：
// **编译侧本来就不会被这件事打坏** —— 子进程对每次请求都新建一份 wazero Runtime 与
// `NewCompilationCacheWithDir(req.CacheDir)`（cmd/picoaide-app-compile/main.go 的 compile；
// `server` 类型自己的注释写着"无跨请求状态：每次编译都是一份新的 wazero Runtime"），
// 而 wazero 的 `ensuresFileCache` 在构造时会 mkdir 缓存目录与版本分片目录 ⇒ 目录被删之后
// **下一次编译会自己把它建回来**。真正会被打坏的是**执行侧**（`Runtime` 在构造期绑定一次，
// 见 internal/wasmapp/runtime/cacheheal.go 与 cacheheal_test.go）。
//
// 为什么仍然要有这条用例：这条"编译侧天然自愈"的前提**只来自子进程"每次请求一份 cache"
// 这个设计**。把 cache 提升为进程级（一个很自然的优化）就会让编译侧变成"删目录 ⇒ 失败到
// 重启"，而那种退化不会有任何别的用例红。本用例就是那道闸：
//
//	变异验证（实跑，见交付报告）：把 cmd/picoaide-app-compile 的 cache 提升为**进程级**
//	（sync.Once + 包级变量，模拟"常驻子进程只绑定一次"的优化）⇒ 本用例红。
//
// ⚠️ 第二个模块必须与第一个内容不同：wazero 的缓存是内容寻址的，同一份字节第二次编译
// 只会命中（父侧判 cached、子进程也不写盘），那样"删目录后仍成功"证明不了任何事。

import (
	"context"
	"os"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
)

// TestCompileSurvivesCacheDirRemoval 见文件头。
func TestCompileSurvivesCacheDirRemoval(t *testing.T) {
	child := buildCompileChildOnce(t)
	root := t.TempDir()
	c := newTestCompiler(t, child, func(o *Options) { o.DataRoot = root })
	dir := t.TempDir()

	// ① 先编译一次：让子进程真的把版本分片目录建出来（观测值 = 复原后要对拍的名字）。
	if _, err := c.Compile(context.Background(), writeModule(t, dir, "a.wasm", wasmtest.Base())); err != nil {
		t.Fatalf("前置编译失败: %v", err)
	}
	shards := cacheShardDirNames(c.childCacheDir)
	if len(shards) == 0 {
		t.Fatalf("前置：子进程应在 %s 下建出 wazero 分片目录", c.childCacheDir)
	}

	// ② 外部删除整棵树（= 旧文案教运维做的事）。
	if err := os.RemoveAll(c.cacheScanRoot()); err != nil {
		t.Fatalf("删除缓存树失败: %v", err)
	}

	// ③ 再编译一个**内容不同**的模块 ⇒ 必须成功（子进程每次请求都重建 cache/目录）。
	other := wasmtest.Build(
		wasmtest.TypeSection(wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params())),
		wasmtest.FunctionSection(0),
		wasmtest.MemorySection(2),
		wasmtest.ExportSection(wasmtest.ExportMemory("memory", 0), wasmtest.ExportFunc("_start", 0)),
		wasmtest.CodeSection(wasmtest.Body(0x0b)),
	)
	if _, err := c.Compile(context.Background(), writeModule(t, dir, "b.wasm", other)); err != nil {
		t.Fatalf("缓存目录被外部删除后，发布期编译必须仍然成功（子进程每次请求新建 cache ⇒ 目录自动重建；"+
			"若这条红了，说明子进程的 cache 被改成进程级绑定，而它没有配套的自愈）：%v", err)
	}

	// ④ 分片目录必须按**原名**回来（名字对不上 = 缓存暖不到执行侧，静默退化）。
	after := cacheShardDirNames(c.childCacheDir)
	found := false
	for _, name := range after {
		if name == shards[0] {
			found = true
		}
	}
	if !found {
		t.Fatalf("重建的分片目录名必须与删掉的那个一致：before=%v after=%v", shards, after)
	}
	if _, entries := c.CacheUsage(); entries == 0 {
		t.Fatal("复原之后必须真的重新写出条目（只成功不落盘 = 缓存其实没恢复）")
	}
}
