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

// TestEnsureNeverReportsTrustedOnError 钉住 `(report, err)` 这对返回值的契约：
// **err 非 nil ⇒ Trusted() 必为 false**。
//
// 背景（2026-09-21 二轮独立审计 P1-①）：失败分支原先返回 `{Dir: dir}`（零违规 ⇒
// `Trusted()==true`）。调用方只要漏看 err（或写成 `rep, _ := Ensure(...)`）就会把
// "目录根本不可用"当成"目录可信"；而**守着它的用例在结构上不可能红** ——
// 旧断言是 `if err == nil && rep.Trusted() { t.Fatal(...) }`，真实行为 `err != nil`
// 使它永假，再加上 `os.Geteuid() == 0` 整条 Skip（本机就是 root）。
//
// 现在的判据是**双向**的，且不依赖"以非 root 身份制造 Chmod 失败"（那在 root 下不可能，
// 只会变成 Skip 假绿）：
//
//	① 构造一个必然失败的输入（父路径被普通文件占住）⇒ 断言 `err != nil` **且**
//	   `rep.Trusted() == false`（修复前这一条就红：err 非 nil 而 Trusted 为 true）；
//	② 反向对照：正常可创建的目录 ⇒ `err == nil` **且** `Trusted() == true`
//	   （防"把 Trusted 写成恒假"）。
//
// 变异验证：把任一失败分支改回 `CacheTrustReport{Dir: dir}` ⇒ ①红。
func TestEnsureNeverReportsTrustedOnError(t *testing.T) {
	base := t.TempDir()
	// 父路径是**普通文件**：`<base>/blocked/cache` 的任何创建/stat 都必然失败
	//（ENOTDIR），与运行身份无关 ⇒ 在 root 下也能稳定构造（不需要 Skip）。
	blocked := filepath.Join(base, "blocked")
	if err := os.WriteFile(blocked, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	rep, err := Ensure(filepath.Join(blocked, "cache"), 0o700)
	if err == nil {
		t.Fatalf("父路径被普通文件占住时必须报错，实际 err=nil, trusted=%v", rep.Trusted())
	}
	if rep.Trusted() {
		t.Fatalf("err 非 nil 时报告不得是「可信」（调用方漏看 err 就会把不可用当可信）：err=%v violations=%+v",
			err, rep.Violations)
	}
	if len(rep.Violations) == 0 {
		t.Fatalf("失败报告必须带至少一条违规（理由应说明失败原因）：%+v", rep)
	}

	// ①b 另一条失败分支：`Lstat` 返回 ENOENT（看起来"还不存在，可以创建"）但
	// `MkdirAll` 必然失败 —— 构造方式是**父路径是指向不存在目标的悬空符号链接**
	// （stat 整串 ⇒ ENOENT；MkdirAll ⇒ 父级建不出来）。这条把"创建失败"分支也钉住，
	// 否则只覆盖到 stat 失败那一条（两条分支各改一处，判据必须分别能红）。
	dangling := filepath.Join(base, "dangling")
	if err := os.Symlink(filepath.Join(base, "nowhere"), dangling); err != nil {
		t.Skipf("环境不支持符号链接，跳过 MkdirAll 分支：%v", err)
	}
	rep2, err2 := Ensure(filepath.Join(dangling, "cache"), 0o700)
	if err2 == nil {
		t.Fatalf("悬空链接下的目录不可能创建成功，实际 err=nil trusted=%v", rep2.Trusted())
	}
	if rep2.Trusted() {
		t.Fatalf("MkdirAll 失败分支同样不得报「可信」：err=%v violations=%+v", err2, rep2.Violations)
	}

	// ② 反向对照：正常路径仍必须给"可信 + nil"（防恒假）。
	ok := filepath.Join(base, "cache")
	good, gerr := Ensure(ok, 0o700)
	if gerr != nil {
		t.Fatalf("正常目录不应报错：%v", gerr)
	}
	if !good.Trusted() {
		t.Fatalf("正常创建的 0700 目录必须可信：%+v", good.Violations)
	}
}

// TestEnsureChmodFailureIsUntrustedAndReported 钉住 **Chmod 失败** 这条分支的契约。
//
// 为什么用接缝而不是真实调用（2026-09-21 三轮审计 §1-①）：Chmod 失败在 root 下无法
// 构造（CAP_FOWNER），旧版本因此 `t.Skip` —— 而 Skip 就是"这条分支可以静默回退"
// （审计实跑：把失败分支改回零违规报告，整包 `go test` 仍 ok）。现在替换包级
// `chmodDir` 接缝，让这条分支在**任何身份、任何文件系统**上都能确定性地被走到：
//   - `err` 必须非 nil（调用方要知道"权限没被纠正"）；
//   - 报告必须**不可信**（err 非 nil ⇒ Trusted()==false，与另外三条失败分支同契约）；
//   - 反向对照：接缝恢复后同一目录必须 `err==nil && Trusted()==true`（防"恒报错/恒不可信"）。
//
// 变异验证：把 `chmodDir` 的失败分支改回 `return CacheTrustReport{Dir: dir}, err`
// ⇒ 本用例红（Trusted 为 true）。
func TestEnsureChmodFailureIsUntrustedAndReported(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "cache")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}

	original := chmodDir
	chmodDir = func(string, os.FileMode) error { return os.ErrPermission }
	t.Cleanup(func() { chmodDir = original })

	rep, err := Ensure(dir, 0o700)
	if err == nil {
		t.Fatal("Chmod 失败必须返回非 nil 错误（否则调用方以为权限已纠正）")
	}
	if rep.Trusted() {
		t.Fatalf("Chmod 失败时报告不得是「可信」：violations=%+v", rep.Violations)
	}
	if len(rep.Violations) == 0 {
		t.Fatalf("失败报告必须带至少一条违规（理由应说明失败原因）：%+v", rep)
	}

	// 反向对照：接缝恢复后同一目录必须真的通过（防"恒报错/恒不可信"的假实现）。
	chmodDir = original
	good, gerr := Ensure(dir, 0o700)
	if gerr != nil {
		t.Fatalf("接缝恢复后不应报错：%v", gerr)
	}
	if !good.Trusted() {
		t.Fatalf("接缝恢复后必须可信：%+v", good.Violations)
	}
}
