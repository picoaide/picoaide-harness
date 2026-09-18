package runtime_test

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	wasmruntime "github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// 本文件（外部测试包）是 FIX-34 的**交叉断言**：同一条缓存目录推导必须在两侧算出**同一个
// 目录**（§4.3.1-a），否则"发布期编译暖到执行进程"这条前提静默失效。
//
// 依赖方向不允许 compile import runtime（两者是同层能力实现），所以两侧各有一份同算法的
// 实现（runtime.CompileCacheDir / compile.CompileCacheDir）。本文件同时 import 两侧，
// 是唯一能直接对拍它们的地方；生产装配点 appserver.Options 另有同口径校验。
//
// 变异方式：
//   - 只改一侧的分代规则（例如 compile 侧写死 limits.CompileCacheRevision）⇒ 必红；
//   - 把 cacheNamespaceFor 的回落改成"恒返回传入值" ⇒ 空版本那两条必红。

func TestCompileCacheDirMatchesCompileSide(t *testing.T) {
	roots := []string{"/data/app", "/var/lib/picoaide", filepath.Join(t.TempDir(), "数据根")}
	for _, root := range roots {
		got := wasmruntime.CompileCacheDir(root)
		want := compile.CompileCacheDir(root)
		if got != want {
			t.Fatalf("两侧缓存目录不一致（§4.3.1-a：会让发布期编译暖不到执行进程）：\n  runtime: %s\n  compile: %s",
				got, want)
		}
		if !strings.HasPrefix(got, filepath.Join(root, "_compile-cache")+string(filepath.Separator)) {
			t.Fatalf("缓存目录必须在 <dataRoot>/_compile-cache/ 之下：%s", got)
		}
		t.Logf("两侧一致：%s", got)
	}
}

// TestCompileCacheNamespaceInProductionBinary 是"生产形态带真版本"的判据：
// `go build` 出来的 main 二进制里 Deps 有 wazero ⇒ 两侧都按 wazero 版本分代
// （而不是手写回落常量）。这条正是"为什么不需要人记得升级时改常量"的证据。
func TestCompileCacheNamespaceInProductionBinary(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过 go build 生产形态探针（需要一次 go build）")
	}
	moduleRoot := serverModuleRoot(t)
	bin := filepath.Join(t.TempDir(), "versionprobe")
	build := exec.Command("go", "build", "-o", bin, "./internal/wasmapp/runtime/testdata/versionprobe")
	build.Dir = moduleRoot
	build.Env = os.Environ()
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("构建探针失败: %v\n%s", err, out)
	}
	out, err := exec.Command(bin).CombinedOutput()
	if err != nil {
		t.Fatalf("运行探针失败: %v\n%s", err, out)
	}
	fields := map[string]string{}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
		if ok {
			fields[k] = v
		}
	}
	if fields["wazero_in_deps"] != "true" {
		t.Fatalf("生产形态（go build 的 main 二进制）的 Deps 里应当有 wazero（审计 P1-3 实测）；"+
			"若 Go 工具链行为变化，请同步更新文档与分代回落策略。探针输出：\n%s", out)
	}
	rtDir, cmDir := fields["runtime_dir"], fields["compile_dir"]
	if rtDir == "" || cmDir == "" {
		t.Fatalf("探针输出缺少目录：\n%s", out)
	}
	if rtDir != cmDir {
		t.Fatalf("生产形态下两侧目录仍不一致：runtime=%s compile=%s", rtDir, cmDir)
	}
	gen := filepath.Base(rtDir)
	if gen == "r1" || gen == "dev" || gen == "" {
		t.Fatalf("生产形态的分代名 = %q，应当是 wazero 的真实版本（vX.Y.Z）——"+
			"若拿不到版本，说明 build info 里没有 wazero（本用例上一段已断言有），分代策略需重审。完整输出：\n%s",
			gen, out)
	}
	if !strings.HasPrefix(gen, "v") {
		t.Fatalf("分代名 %q 不像 wazero 版本（期望 vX.Y.Z）", gen)
	}
	t.Logf("生产形态分代：%s（runtime 与 compile 两侧一致，Deps 里 wazero=true）", gen)
}

// serverModuleRoot 从当前测试目录向上找 go.mod（= server/ 模块根）。
func serverModuleRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("Getwd: %v", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatalf("从 %s 向上找不到 go.mod", dir)
		}
		dir = parent
	}
}
