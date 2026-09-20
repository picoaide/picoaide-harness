package cachetrust

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 本文件守"编译缓存目录可信度"的两件事：**创建时纠偏**与**形状校验**。
//
// 变异验证（实跑过，勿删）：
//   - 删掉 Ensure 里的 os.Chmod ⇒ TestEnsureCorrectsLoosenedExistingDir 红；
//   - 删掉 Verify 里的符号链接分支 ⇒ TestVerifyRejectsSymlinkEntry/…RootSymlink 红；
//   - 删掉条目"非空"判据 ⇒ TestVerifyRejectsEmptyEntry 红；
//   - 删掉 group/other 写位判据 ⇒ TestVerifyRejectsGroupWritable* 红。

func TestEnsureCreatesPrivateDirAndIsTrusted(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	rep, err := Ensure(root, 0o700)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !rep.Trusted() {
		t.Fatalf("新建的 0700 目录必须可信，实际违规 %+v", rep.Violations)
	}
	fi, serr := os.Stat(root)
	if serr != nil {
		t.Fatal(serr)
	}
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("新建目录权限 = %#o，期望 0700", fi.Mode().Perm())
	}
}

// TestEnsureCorrectsLoosenedExistingDir 是 F-4 的核心行为判据：
// **目录已存在时 MkdirAll 不会改权限**，必须显式 Chmod 才能把"旧版本/人工/宽 umask
// 留下的可写目录"纠正回来。修复前只有 MkdirAll ⇒ 本用例红。
func TestEnsureCorrectsLoosenedExistingDir(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, 0o777); err != nil { // 模拟漂移：group/other 可写
		t.Fatal(err)
	}

	// 先确认"漂移"真的被旧实现会放过：Verify 必须报出来。
	before, verr := Verify(root)
	if verr != nil {
		t.Fatalf("Verify: %v", verr)
	}
	if before.Trusted() {
		t.Fatal("0777 目录必须先被判为不可信（否则下面的纠偏断言没有意义）")
	}

	rep, err := Ensure(root, 0o700)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if !rep.Trusted() {
		t.Fatalf("Ensure 必须把已存在目录纠偏到 0700，仍有违规 %+v", rep.Violations)
	}
	fi, _ := os.Stat(root)
	if fi.Mode().Perm() != 0o700 {
		t.Fatalf("纠偏后权限 = %#o，期望 0700", fi.Mode().Perm())
	}
}

func TestVerifyMissingDirIsEmptyNotError(t *testing.T) {
	rep, err := Verify(filepath.Join(t.TempDir(), "never-created"))
	if err != nil {
		t.Fatalf("目录不存在不应报错（还没编译过任何应用）: %v", err)
	}
	if !rep.Trusted() || rep.Entries != 0 {
		t.Fatalf("空报告期望：Trusted=%v Entries=%d", rep.Trusted(), rep.Entries)
	}
}

func TestVerifyRejectsRootSymlink(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "real")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "cache")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("本机不支持符号链接: %v", err)
	}
	rep, err := Verify(link)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Trusted() {
		t.Fatal("根目录是符号链接必须判违规（可把缓存重定向到任意位置）")
	}
	if !strings.Contains(rep.Violations[0].Reason, "符号链接") {
		t.Fatalf("违规原因应点名符号链接：%+v", rep.Violations[0])
	}
}

func TestVerifyRejectsGroupWritableShardAndEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	shard := filepath.Join(root, "wazero-v1.12.0-amd64-linux")
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(shard, "abcd")
	if err := os.WriteFile(entry, []byte("compiled"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 正例：形状正确时可信。
	rep, err := Verify(root)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !rep.Trusted() {
		t.Fatalf("正常缓存目录应可信，违规 %+v", rep.Violations)
	}
	if rep.Entries != 1 {
		t.Fatalf("Entries = %d，期望 1", rep.Entries)
	}

	// 反例 1：分片目录 group 可写。
	if err := os.Chmod(shard, 0o770); err != nil {
		t.Fatal(err)
	}
	if rep, _ := Verify(root); rep.Trusted() {
		t.Fatal("分片目录 group 可写必须判违规")
	}
	if err := os.Chmod(shard, 0o700); err != nil {
		t.Fatal(err)
	}

	// 反例 2：条目 group 可写。
	if err := os.Chmod(entry, 0o660); err != nil {
		t.Fatal(err)
	}
	rep, _ = Verify(root)
	if rep.Trusted() {
		t.Fatal("条目 group 可写必须判违规（可被同机其它用户篡改）")
	}
	if !strings.Contains(rep.Violations[0].Reason, "条目") {
		t.Fatalf("违规应点名缓存条目：%+v", rep.Violations[0])
	}
}

func TestVerifyRejectsSymlinkAndNonRegularEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	shard := filepath.Join(root, "wazero-v1.12.0-amd64-linux")
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := filepath.Join(t.TempDir(), "secret")
	if err := os.WriteFile(secret, []byte("s"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(secret, filepath.Join(shard, "deadbeef")); err != nil {
		t.Skipf("本机不支持符号链接: %v", err)
	}
	rep, err := Verify(root)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Trusted() {
		t.Fatal("条目是符号链接必须判违规（可把读条目变成读任意文件）")
	}
	found := false
	for _, v := range rep.Violations {
		if strings.Contains(v.Reason, "符号链接") {
			found = true
		}
	}
	if !found {
		t.Fatalf("违规里应有一条点名符号链接：%+v", rep.Violations)
	}
}

func TestVerifyRejectsEmptyEntry(t *testing.T) {
	root := filepath.Join(t.TempDir(), "cache")
	shard := filepath.Join(root, "shard")
	if err := os.MkdirAll(shard, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(shard, "empty"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	rep, err := Verify(root)
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if rep.Trusted() {
		t.Fatal("空条目必须判违规（半写/被截断）")
	}
}
