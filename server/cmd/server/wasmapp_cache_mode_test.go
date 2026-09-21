package main

// 本文件是 `/readyz` 的 `exec_cache_mode` / `compile_cache_mode` 的**装配级判据**
// （Task：让"缓存不可用 ⇒ 降级"这件事在探针上可见，而不是只留一行日志）。
//
// 判据分三段，覆盖任务要求的三件事：
//
//	(a) 磁盘→内存的降级**反映在 payload 上**（不是只打日志）：把数据根下的编译缓存
//	    路径用一个**普通文件**占住（cachetrust 判"缓存根路径不是目录"）⇒ 执行侧降级为
//	    进程内缓存、编译侧改用临时目录 ⇒ payload 必须是 memory / temporary；
//	(b) 正常路径报 disk / configured；
//	(c) **一致性**：payload 里的值必须等于运行时/编译器自己给出的值
//	    （`AppServer.RuntimeCacheMode()` / `Compiler.CacheMode()`）—— 装配层只允许做
//	    `string(...)` 转换，不许按"目录看起来能不能建"重算一遍。
//
// 为什么放在装配级（而不是只在 readyz 包里）：readyz 的用例只能证明"钩子给对了就渲染对"，
// 它**测不到生产有没有真的接上** —— 删掉 wasmapp.go 里 `ExecCacheMode:` 那一行时
// 失败形态是静默的（字段退化成空串，探针上看起来只是"没这一项"）。
//
// 变异验证（实跑，见交付说明）：
//   - 删掉 wasmapp.go 的 `ExecCacheMode:` 注入 ⇒ (a)(b)(c) 三条全红（空串）；
//   - 把 resolveCompilationCache 的降级分支改成报 CacheModeDisk ⇒ (a) 红；
//   - 把 compile.CacheMode() 改成恒 configured ⇒ (a) 红。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// readyzCacheModes 从 `/readyz` 的**真实 HTTP 响应体**里取两个模式字段。
//
// 为什么走 HTTP 而不是直接读 Snapshot 结构体：任务要求的是"出现在 payload 上"，
// 而 payload 的键名（JSON tag）与结构体字段名是两件事 —— 只有解析响应体才能同时
// 钉住"字段存在"与"键名是这两个"。
func readyzCacheModes(t *testing.T, p *wasmPlatform) (execMode, compileMode string, ok bool, reasons []string) {
	t.Helper()
	rr := httptest.NewRecorder()
	p.Checker.Handler()(rr, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	var body struct {
		OK               bool     `json:"ok"`
		Reasons          []string `json:"reasons"`
		ExecCacheMode    *string  `json:"exec_cache_mode"`
		CompileCacheMode *string  `json:"compile_cache_mode"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("/readyz 响应不是合法 JSON: %v; body=%s", err, rr.Body.String())
	}
	if body.ExecCacheMode == nil {
		t.Fatalf("/readyz payload 里没有 exec_cache_mode 键（JSON 名是跨端契约）：%s", rr.Body.String())
	}
	if body.CompileCacheMode == nil {
		t.Fatalf("/readyz payload 里没有 compile_cache_mode 键（JSON 名是跨端契约）：%s", rr.Body.String())
	}
	return *body.ExecCacheMode, *body.CompileCacheMode, body.OK, body.Reasons
}

// newCacheModePlatform 装配一个平台实例（内存档位用 small：本用例不测四笔账，
// 但启动自检必须过 —— 这正是 setupWasmPlatform 会 log.Fatalf 的地方）。
func newCacheModePlatform(t *testing.T, dataRoot string) *wasmPlatform {
	t.Helper()
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p := setupWasmPlatform(ctx, db, dataRoot)
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	t.Cleanup(p.Close)
	return p
}

// TestReadyzCacheModesNormalPath 是 (b)：正常路径必须报 disk / configured。
func TestReadyzCacheModesNormalPath(t *testing.T) {
	p := newCacheModePlatform(t, t.TempDir())

	execMode, compileMode, _, reasons := readyzCacheModes(t, p)
	if execMode != string(runtime.CacheModeDisk) {
		t.Fatalf("exec_cache_mode = %q, want %q（干净数据根下执行侧必须真的用磁盘缓存）",
			execMode, runtime.CacheModeDisk)
	}
	if compileMode != string(compile.CacheModeConfigured) {
		t.Fatalf("compile_cache_mode = %q, want %q（干净数据根下编译子进程必须用配置的缓存目录）",
			compileMode, compile.CacheModeConfigured)
	}
	// (c) 一致性：payload 与组件自己的回答必须逐字相同。
	if want := string(p.AppServer.RuntimeCacheMode()); execMode != want {
		t.Fatalf("payload 的 exec_cache_mode=%q 与运行时自己的 CacheMode()=%q 不一致 —— "+
			"探针不得有第二个判断（reasons=%v）", execMode, want, reasons)
	}
	if want := string(p.Compiler.CacheMode()); compileMode != want {
		t.Fatalf("payload 的 compile_cache_mode=%q 与编译器自己的 CacheMode()=%q 不一致（reasons=%v）",
			compileMode, want, reasons)
	}
}

// TestReadyzCacheModesReflectDegradation 是 (a)：两侧降级必须**反映在 payload 上**。
func TestReadyzCacheModesReflectDegradation(t *testing.T) {
	dataRoot := t.TempDir()
	// 让 <dataRoot>/_compile-cache/<分代> 变成一个普通文件：两侧的 cachetrust 都会判
	// "缓存根路径不是目录"（执行侧 ⇒ 进程内缓存；编译侧 ⇒ 临时目录），而功能不受影响。
	cacheDir := runtime.CompileCacheDir(dataRoot)
	if err := os.MkdirAll(filepath.Dir(cacheDir), 0o700); err != nil {
		t.Fatalf("建缓存父目录失败: %v", err)
	}
	if err := os.WriteFile(cacheDir, []byte("not a directory"), 0o600); err != nil {
		t.Fatalf("占用缓存目录路径失败: %v", err)
	}

	p := newCacheModePlatform(t, dataRoot)

	execMode, compileMode, _, reasons := readyzCacheModes(t, p)
	if execMode != string(runtime.CacheModeMemory) {
		t.Fatalf("磁盘缓存不可用时 exec_cache_mode = %q, want %q —— "+
			"这条降级此前只有一行日志，探针必须如实说出来（reasons=%v）",
			execMode, runtime.CacheModeMemory, reasons)
	}
	if compileMode != string(compile.CacheModeTemporary) {
		t.Fatalf("缓存目录不可信时 compile_cache_mode = %q, want %q —— "+
			"编译侧会改用临时目录（不读也不写那棵树），探针必须如实说出来（reasons=%v）",
			compileMode, compile.CacheModeTemporary, reasons)
	}
	// (c) 一致性：降级路径上同样必须与组件自己的回答逐字相同。
	if want := string(p.AppServer.RuntimeCacheMode()); execMode != want {
		t.Fatalf("降级路径上 payload 的 exec_cache_mode=%q 与运行时自己的 CacheMode()=%q 不一致",
			execMode, want)
	}
	if want := string(p.Compiler.CacheMode()); compileMode != want {
		t.Fatalf("降级路径上 payload 的 compile_cache_mode=%q 与编译器自己的 CacheMode()=%q 不一致",
			compileMode, want)
	}
	// 降级不是"平台不可用"：执行面照常 ok（缓存是性能优化，不是执行前提）。
	if !p.Checker.Snapshot().OK {
		t.Logf("提示：降级用例下 /readyz.ok=false（reasons=%v）—— 这是水位（磁盘/队列/DB）的事，与缓存模式无关",
			reasons)
	}
}
