package appserver_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
)

// TestCleanupLegacyAssetDirs 守的是"清理工具只删它该删的东西"。
//
// 变异验证（实跑过）：
//   - 把 `assets` 名字判据去掉（删 app 目录下的任何子目录）⇒ 第 1 条断言红（app.db 没了）；
//   - 把两层 `Lstat` 的符号链接跳过去掉 ⇒ 第 3 条断言红（数据根外的目录被删）。
func TestCleanupLegacyAssetDirs(t *testing.T) {
	root := t.TempDir()
	apps := filepath.Join(root, "apps")
	mustMkdir(t, filepath.Join(apps, "demo-a", "assets", "25", "static"))
	mustWrite(t, filepath.Join(apps, "demo-a", "assets", "25", "index.html"), "hello")
	mustWrite(t, filepath.Join(apps, "demo-a", "assets", "25", "static", "app.css"), "body{}")
	mustWrite(t, filepath.Join(apps, "demo-a", "app.db"), "sqlite")
	// 没有 assets 目录的应用：不影响，且自己的文件不能被动。
	mustMkdir(t, filepath.Join(apps, "demo-b"))
	mustWrite(t, filepath.Join(apps, "demo-b", "app.db"), "sqlite")

	// 数据根之外的真实目录：`apps/evil` 是指向它的符号链接，清理必须**不跟随**。
	outside := filepath.Join(t.TempDir(), "outside")
	mustMkdir(t, filepath.Join(outside, "assets", "1"))
	mustWrite(t, filepath.Join(outside, "assets", "1", "keep.txt"), "must survive")
	if err := os.Symlink(outside, filepath.Join(apps, "evil")); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}

	var logs []string
	dirs, freed := appserver.CleanupLegacyAssetDirs(root, func(format string, args ...any) {
		logs = append(logs, format)
	})
	if dirs != 1 {
		t.Fatalf("应只清理 1 个历史资源目录，得到 %d（日志 %d 条）", dirs, len(logs))
	}
	if freed <= 0 {
		t.Fatalf("释放字节数应大于 0，得到 %d", freed)
	}
	if _, err := os.Stat(filepath.Join(apps, "demo-a", "assets")); !os.IsNotExist(err) {
		t.Fatalf("demo-a/assets 必须被删除，stat err=%v", err)
	}
	if _, err := os.Stat(filepath.Join(apps, "demo-a", "app.db")); err != nil {
		t.Fatalf("app.db 不得被删：%v", err)
	}
	if _, err := os.Stat(filepath.Join(apps, "demo-b", "app.db")); err != nil {
		t.Fatalf("其它应用不得被碰：%v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "assets", "1", "keep.txt")); err != nil {
		t.Fatalf("符号链接指向的数据根外目录不得被删：%v", err)
	}
	// 幂等：再跑一遍什么都不删（历史目录已不存在）。
	if again, _ := appserver.CleanupLegacyAssetDirs(root, nil); again != 0 {
		t.Fatalf("第二次清理应为 0，得到 %d", again)
	}
	// 数据根不存在时静默返回（源码构建/首次启动的正常路径）。
	if n, _ := appserver.CleanupLegacyAssetDirs(filepath.Join(root, "nope"), nil); n != 0 {
		t.Fatalf("数据根不存在时应为 0，得到 %d", n)
	}
	// 数据根**本身**是符号链接时：按它指向的真实目录清理（这是正确行为 —— 运维可以把
	// 数据根配成链接，平台其它模块拼路径时同样跟着它走）。这里只钉住"它确实清到了真实
	// 目录里的历史目录"，从而把"数据根这层不判链接"这条边界写成**事实**而不是含糊承诺。
	linkRoot := filepath.Join(t.TempDir(), "rootlink")
	if err := os.Symlink(root, linkRoot); err == nil {
		mustMkdir(t, filepath.Join(apps, "demo-c", "assets", "1"))
		if n, _ := appserver.CleanupLegacyAssetDirs(linkRoot, nil); n != 1 {
			t.Fatalf("数据根是符号链接时应按真实目录清理到 1 个，得到 %d", n)
		}
		if _, err := os.Stat(filepath.Join(apps, "demo-c", "assets")); !os.IsNotExist(err) {
			t.Fatalf("数据根是符号链接时真实目录里的历史资源目录应被清理，stat err=%v", err)
		}
	}
	// 日志必须点名"内存直出"这件事（排障时能一眼看出目录为什么消失）。
	joined := strings.Join(logs, "\n")
	if !strings.Contains(joined, "内存直出") {
		t.Fatalf("清理日志必须说明原因（内存直出），实际：%s", joined)
	}
}

func mustMkdir(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
