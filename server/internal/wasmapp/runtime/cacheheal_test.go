package runtime

// 本文件是**编译缓存目录被外部删除/改名**时执行侧自愈（审计 R5-A-2）的判据。
//
// 缺陷形态（PROBE-4 复现，本节审计的原文）：`publishBlockers` 的文案教运维"整目录删除
// 不影响正确性"，而执行侧 wazero 的 fileCache **在构造期**绑定分片目录、**不会重建**
// （wazero v1.12.0 cache.go 原话："the embedder must safeguard this directory from
// external changes"）⇒ 照文案做完，**所有冷编译失败到重启**：
//
//	open …/_compile-cache/<分代>/wazero-dev-amd64-linux/<key>.<rand>.tmp: no such file or directory
//
// 两条判据（都必须是行为级 —— 文案判据在 readyz 包那边）：
//
//	① 自愈：删掉整个缓存树之后，**下一次冷编译必须成功**（路径没变 ⇒ 已绑定的
//	   fileCache 重新可用），且磁盘上重新出现条目；
//	② 不可自愈时**不许留谜语**：把缓存目录位置换成普通文件（重建必然失败）⇒ 错误文案
//	   必须点名"缓存目录被外部删除/不可用"并给出可行动处置（重启 / 走进程内回收入口 /
//	   不要手工删目录），而不是只回一句驱动级 ENOENT。
//
// 变异验证（实跑，见交付报告）：
//   - 去掉 CompileModule 里的 ensureDiskCacheDirs/重试 ⇒ ① 红（报 ENOENT）；
//   - 把 cacheDirFailure 的路径归属判据去掉（恒 false）⇒ ② 红（回的是裸错误）。

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// secondMinimalWasmModule 是第二个**互不相同**的最小模块（一个空函数：type/function/code 三段）。
//
// 为什么必须换一份字节：wazero 的进程内缓存先于文件缓存命中（getCompiledModuleFromMemory
// 在 getCompiledModuleFromCache 之前），同一个模块第二次编译根本不会再走 fileCache.Add ——
// 用它做"删目录后再编译"会给出**假绿**（内存命中 ⇒ 永不触碰那个被删的目录）。
var secondMinimalWasmModule = []byte{
	0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // magic + version
	0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type: () -> ()
	0x03, 0x02, 0x01, 0x00, // function: [type 0]
	0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b, // code: 一个函数体（0 局部变量 + end）
}

// cacheRootOf 返回缓存**根**（`<dataRoot>/_compile-cache`，含所有分代）。
func cacheRootOf(root string) string { return filepath.Dir(CompileCacheDir(root)) }

// TestCompileModuleSelfHealsAfterCacheDirRemoved 见文件头 ①。
func TestCompileModuleSelfHealsAfterCacheDirRemoved(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	rt, err := New(ctx, Options{DataRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(ctx) })
	if rt.CacheMode() != CacheModeDisk {
		t.Fatalf("前置：干净数据根下必须是磁盘缓存，got %q", rt.CacheMode())
	}
	// 前置：先用模块 A 真的写出至少一条磁盘条目（否则"删了再编译成功"什么都证明不了）。
	if _, cerr := rt.CompileModule(ctx, minimalWasmModule); cerr != nil {
		t.Fatalf("前置编译 A 失败: %v", cerr)
	}
	if n := diskCacheEntries(root); n == 0 {
		t.Fatal("前置：编译 A 之后磁盘缓存里应有条目（夹具/判据失效）")
	}
	shard := filepath.Join(CompileCacheDir(root), wazeroShardDirName())
	if _, serr := os.Stat(shard); serr != nil {
		// 分片名以 wazero 自己建的为准（wazeroVersion() 在 test 二进制里是 dev）。
		t.Fatalf("前置：分片目录不存在（%s）：%v", shard, serr)
	}

	// 外部删除整棵树（= 旧文案教运维做的事）。
	if rerr := os.RemoveAll(cacheRootOf(root)); rerr != nil {
		t.Fatalf("删除缓存树失败: %v", rerr)
	}

	// 断言 ①：下一次冷编译必须**成功**（自愈），且重新写出条目。
	if _, cerr := rt.CompileModule(ctx, secondMinimalWasmModule); cerr != nil {
		t.Fatalf("缓存目录被外部删除后，冷编译必须自愈成功（旧行为：所有冷编译失败到重启）：%v", cerr)
	}
	if n := diskCacheEntries(root); n == 0 {
		t.Fatal("自愈之后磁盘缓存里必须重新出现条目（只成功不落盘 = 自愈其实没生效）")
	}
	if _, serr := os.Stat(shard); serr != nil {
		t.Fatalf("自愈应把分片目录按**原名**建回来（%s）：%v", shard, serr)
	}
}

// TestCompileModuleErrorNamesExternalDeletionWhenHealFails 见文件头 ②。
func TestCompileModuleErrorNamesExternalDeletionWhenHealFails(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	rt, err := New(ctx, Options{DataRoot: root})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(func() { _ = rt.Close(ctx) })
	if _, cerr := rt.CompileModule(ctx, minimalWasmModule); cerr != nil {
		t.Fatalf("前置编译失败: %v", cerr)
	}
	// 让"重建目录"必然失败：缓存目录的**位置**被一个普通文件占住。
	dir := CompileCacheDir(root)
	if rerr := os.RemoveAll(cacheRootOf(root)); rerr != nil {
		t.Fatalf("删除缓存树失败: %v", rerr)
	}
	if merr := os.MkdirAll(filepath.Dir(dir), 0o700); merr != nil {
		t.Fatalf("建父目录失败: %v", merr)
	}
	if werr := os.WriteFile(dir, []byte("occupied"), 0o600); werr != nil {
		t.Fatalf("占住缓存目录路径失败: %v", werr)
	}

	_, cerr := rt.CompileModule(ctx, secondMinimalWasmModule)
	if cerr == nil {
		t.Fatal("缓存目录不可用时冷编译必须失败（不许静默降级成「看起来成功」）")
	}
	msg := cerr.Error()
	for _, want := range []string{"编译缓存目录", "不要手工删除或改名", "重启"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("错误文案缺 %q —— 运维/作者不该只看到驱动级谜语：%s", want, msg)
		}
	}
}
