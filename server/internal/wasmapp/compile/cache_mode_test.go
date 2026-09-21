package compile

// 本文件是 `/readyz` 的 `compile_cache_mode`（Task：缓存目录不可信 ⇒ 临时目录）在
// **编译侧**的判据。
//
// 判据纪律：模式必须来自**决定子进程缓存目录的那个字段**（`childCacheTemp` /
// `childCacheDir`，它们同时进 argv 的 `-cache-dir` 与请求的 `cache_dir`），
// 而不是另算一遍"目录看起来可不可信"。因此本用例把模式与那两个字段**对拍**：
//
//	configured ⟺ childCacheDir == CacheDir()
//	temporary  ⟺ childCacheDir == childCacheTemp ≠ CacheDir()
//
// 变异验证（实跑）：
//   - 把 CacheMode() 改成恒返回 CacheModeConfigured ⇒ 第 2 段红；
//   - 把 CacheMode() 改成恒返回 CacheModeTemporary ⇒ 第 1 段红。

import (
	"os"
	"path/filepath"
	"testing"
)

// TestCompilerCacheModeFollowsChildCacheDir 见文件头。
func TestCompilerCacheModeFollowsChildCacheDir(t *testing.T) {
	child := buildCompileChildOnce(t)

	// ① 正常路径：配置的缓存目录可用 ⇒ configured，且子进程用的就是它。
	good := newTestCompiler(t, child, func(o *Options) {
		o.DataRoot = t.TempDir()
		o.Isolation = IsolationOff
	})
	if got := good.CacheMode(); got != CacheModeConfigured {
		t.Fatalf("干净数据根下 CacheMode() = %q, want %q", got, CacheModeConfigured)
	}
	if good.childCacheDir != good.CacheDir() {
		t.Fatalf("configured 模式必须让子进程用配置目录：childCacheDir=%s CacheDir=%s",
			good.childCacheDir, good.CacheDir())
	}

	// ② 降级路径：缓存根是**符号链接**（不可信）⇒ temporary，子进程改用临时目录。
	// 与 cache_test.go 的"不可信 ⇒ 不读也不写那棵树"用同一种不可信形态
	//（真部署里的同族形态：只读挂载 / 非属主 / group 可写 / 根路径被占）。
	root := t.TempDir()
	attacker := filepath.Join(root, "attacker-dir")
	if err := os.MkdirAll(attacker, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(CompileCacheDir(root)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(attacker, CompileCacheDir(root)); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}
	bad := newTestCompiler(t, child, func(o *Options) {
		o.DataRoot = root
		o.Isolation = IsolationOff
	})
	if got := bad.CacheMode(); got != CacheModeTemporary {
		t.Fatalf("不可信缓存根下 CacheMode() = %q, want %q（探针必须如实说出「缓存不会跨次复用」）", got, CacheModeTemporary)
	}
	if bad.childCacheTemp == "" || bad.childCacheDir != bad.childCacheTemp {
		t.Fatalf("temporary 模式必须对应「子进程用本进程新建的临时目录」："+
			"childCacheDir=%s childCacheTemp=%s CacheDir=%s",
			bad.childCacheDir, bad.childCacheTemp, bad.CacheDir())
	}
	if bad.childCacheDir == bad.CacheDir() {
		t.Fatalf("temporary 模式却仍指向配置目录 %s", bad.CacheDir())
	}

	// ③ 收尾：Close 之后临时目录必须被清掉（模式说的是"退出即删"，不是"换个地方堆"）。
	tempDir := bad.childCacheTemp
	if err := bad.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(tempDir); !os.IsNotExist(err) {
		t.Fatalf("Close 后临时缓存目录仍在（%s）：err=%v", tempDir, err)
	}
}

// TestCompilerCacheModeNilCompiler 钉住"没有编译器"不得伪装成任何一种模式。
func TestCompilerCacheModeNilCompiler(t *testing.T) {
	var c *Compiler
	if got := c.CacheMode(); got != "" {
		t.Fatalf("nil Compiler 的 CacheMode() = %q, want 空串（空值 ≠ 任何一种模式）", got)
	}
}
