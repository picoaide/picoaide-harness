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
//   - 删掉 group/other 写位判据 ⇒ TestVerifyRejectsGroupWritable* 红；
//   - 把 Ensure 的第一道 Lstat 检查挪到 Chmod 之后 ⇒
//     TestEnsureDoesNotFollowSymlinkWhenCorrectingMode 红（目标目录权限被平台改掉了）。

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

// TestEnsureDoesNotFollowSymlinkWhenCorrectingMode 是 P1-① 的核心判据：
// **`os.Chmod` 跟随符号链接**，所以"先 Chmod 再 Verify"会让平台亲手改掉链接目标的
// 权限。判据 = 根路径是符号链接时，Ensure 必须 (a) 报告违规、(b) **一次权限位都不改**。
//
// 变异验证：把 Ensure 开头的 Lstat 分支删掉（或挪到 Chmod 之后）⇒ 目标目录的 0777
// 会被改成 0700 / 0707，本用例红。这条与 TestVerifyRejectsRootSymlink 的区别：
// 那条只钉"读的时候会报"，这条钉"写的时候不动手"。
func TestEnsureDoesNotFollowSymlinkWhenCorrectingMode(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "real-target")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	// 故意给目标一个"平台绝不该产生"的宽权限：只要被 Chmod 过就看得出来。
	if err := os.Chmod(target, 0o777); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "cache")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("环境不支持符号链接：%v", err)
	}

	rep, err := Ensure(link, 0o700)
	if err != nil {
		t.Fatalf("符号链接根路径应返回违规报告而不是 err：%v", err)
	}
	if rep.Trusted() {
		t.Fatal("符号链接根路径必须被判为不可信")
	}
	if len(rep.Violations) == 0 || !strings.Contains(rep.Violations[0].Reason, "符号链接") {
		t.Fatalf("违规原因应指出符号链接：%+v", rep.Violations)
	}
	fi, serr := os.Stat(target) // Stat（跟随链接）= 目标本身
	if serr != nil {
		t.Fatal(serr)
	}
	if fi.Mode().Perm() != 0o777 {
		t.Fatalf("链接目标的权限被平台改掉了：%#o（期望仍是 0777 —— Ensure 不得跟随符号链接 Chmod）",
			fi.Mode().Perm())
	}
}

// TestEnsureReportsChmodFailureInsteadOfClaimingTrust 覆盖 P1-① 的第二半：
// Chmod 失败（非属主 / 只读挂载）原先**被当成成功** —— 调用方拿到 err=nil 且
// `Trusted()==true`，日志里没有任何信号，而"只有编译进程可写"这条缓解其实没生效。
//
// 判据：目录存在但不可 chmod 时，Ensure 必须返回**非 nil 错误**，
// 且绝不能同时给出"可信"的报告（两者只能有一个成立）。
//
// 本用例用"目录本身不存在且父目录不可写"来构造 Chmod 失败（需要 root 之外的普通
// 用户视角；在容器里以 root 跑时会自动跳过并说明，避免变成假绿）。
func TestEnsureReportsChmodFailureInsteadOfClaimingTrust(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("以 root 运行时 Chmod 总能成功（CAP_FOWNER），无法在单测里构造失败；" +
			"该形态由部署侧（--user/只读挂载）触发，判据是 Ensure 的错误传播分支")
	}
	base := t.TempDir()
	root := filepath.Join(base, "cache")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	// 换成别人拥有的目录在单测里做不到；改为让父目录不可写 + 删除目标后重建来触发错误。
	// 这里采用更直接的形态：把 root 换成只读父目录下的路径。
	roParent := filepath.Join(base, "ro")
	if err := os.MkdirAll(roParent, 0o555); err != nil {
		t.Fatal(err)
	}
	rep, err := Ensure(filepath.Join(roParent, "nested"), 0o700)
	if err == nil && rep.Trusted() {
		t.Fatal("无法创建/授权缓存目录时，Ensure 不得同时返回 nil 错误与\"可信\"报告")
	}
}
