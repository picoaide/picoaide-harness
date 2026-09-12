package archiveutil

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"strings"
	"testing"
)

// FIX-24(审计 2026-09-12,P1-6):archiveutil 的 tar.gz 分支完全没有重复条目检查。
//
// 缺陷形态:zip 分支有 checkZipDuplicates 且三个入口全调;tar.gz 分支一处
// 都没有。于是同一份双 SKILL.md 的 tar.gz 在四个入口给出**两个不同答案**:
//
//	Validate            → nil          (审核通过)
//	ListContents        → "benign"     (第一个命中)
//	ExtractFileContent  → "benign"     (命中即返回)
//	ReadAll             → "EVIL"       (out[name]=buf 末条覆盖)
//
// 即"审核所见 ≠ 员工所装"。真实消费者:唯一 ReadAll 生产调用点是
// marketplace/admin.go 的规范化重打包 —— 审核展示 benign,重打包落库 EVIL。
//
// 缓解事实(审计员复核确认):客户端 enterprise/archive-util.ts 的
// assertNoDuplicateEntry 会挡住默认端到端路径,所以表现是"审核通过但员工
// 装不上",不是静默夹带。但服务端这一层必须与 zip 分支同语义。
//
// 修法:validateTar / tarList / tarExtract / tarReadAll 四处全部拒绝重复
// (dupEntrySet,大小写不敏感),并把 tarReadAll 从"末条覆盖"改成"首条生效"
// —— 即使将来重复检查被绕过,落盘语义也必须与预览一致。

// 目录条目用**尾斜杠**表示(与 zip 分支的 makeZipSeq 约定一致);
// archive/tar 不允许给 TypeReg 编码尾斜杠,所以这里据此选 TypeDir。
type tarSeqEntry struct {
	name    string
	content string
}

// makeTarGzSeq 按**给定顺序**写条目(普通 map 无法表达重复条目)。
func makeTarGzSeq(t *testing.T, entries []tarSeqEntry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for _, e := range entries {
		isDir := strings.HasSuffix(e.name, "/")
		hdr := &tar.Header{Name: e.name, Typeflag: tar.TypeReg, Size: int64(len(e.content))}
		if isDir {
			hdr = &tar.Header{Name: e.name, Typeflag: tar.TypeDir, Mode: 0o755}
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if !isDir && e.content != "" {
			if _, err := tw.Write([]byte(e.content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// TestTarGzRejectsDuplicateEntries 是核心回归锁:四个入口必须**一致地**拒绝。
func TestTarGzRejectsDuplicateEntries(t *testing.T) {
	dup := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "benign"},
		{"SKILL.md", "EVIL"},
	})

	if _, err := Validate(dup, testLim); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("Validate(tar dup) = %v, want ErrDuplicateEntry(修复前为 nil → 审核通过)", err)
	}
	if _, _, err := ListContents(dup, testLim, 4096); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("ListContents(tar dup) = %v, want ErrDuplicateEntry", err)
	}
	if _, _, _, _, _, err := ExtractFileContent(dup, "SKILL.md", 4096); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("ExtractFileContent(tar dup) = %v, want ErrDuplicateEntry", err)
	}
	if _, err := ReadAll(dup, testLim); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("ReadAll(tar dup) = %v, want ErrDuplicateEntry(修复前成功返回 EVIL)", err)
	}
}

// TestTarGzDuplicateCaseInsensitive 锁大小写碰撞:客户端文件系统大小写不敏感,
// skill.md 会覆盖 SKILL.md,所以同样必须拒绝(与 zip 分支一致)。
func TestTarGzDuplicateCaseInsensitive(t *testing.T) {
	caseDup := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "benign"},
		{"skill.md", "EVIL"},
	})
	for name, err := range map[string]error{
		"Validate": func() error { _, e := Validate(caseDup, testLim); return e }(),
		"ReadAll":  func() error { _, e := ReadAll(caseDup, testLim); return e }(),
	} {
		if !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s(tar case-dup) = %v, want ErrDuplicateEntry", name, err)
		}
	}
}

// TestTarGzDuplicateInSubdir 锁"任意路径"的重复,而不只是顶层文件。
func TestTarGzDuplicateInSubdir(t *testing.T) {
	dup := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "ok"},
		{"references/a.md", "one"},
		{"references/a.md", "two"},
	})
	if _, err := Validate(dup, testLim); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("Validate(subdir dup) = %v, want ErrDuplicateEntry", err)
	}
	if _, err := ReadAll(dup, testLim); !errors.Is(err, ErrDuplicateEntry) {
		t.Errorf("ReadAll(subdir dup) = %v, want ErrDuplicateEntry", err)
	}
}

// TestTarGzSingleEntryStillWorks 是防误伤:只有一份 SKILL.md 的正常归档
// (含子目录)必须照常通过,四个入口结论一致。
func TestTarGzSingleEntryStillWorks(t *testing.T) {
	ok := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "benign"},
		{"references/a.md", "x"},
		{"references/", ""}, // 目录条目不计入重复检查
	})
	if _, err := Validate(ok, testLim); err != nil {
		t.Fatalf("Validate(single) = %v, want nil", err)
	}
	files, content, err := ListContents(ok, testLim, 4096)
	if err != nil {
		t.Fatalf("ListContents(single) = %v", err)
	}
	if content != "benign" {
		t.Fatalf("preview = %q, want benign", content)
	}
	if len(files) != 2 {
		t.Fatalf("files = %v, want 2 个非目录条目", files)
	}
	got, err := ReadAll(ok, testLim)
	if err != nil {
		t.Fatalf("ReadAll(single) = %v", err)
	}
	if string(got["SKILL.md"]) != "benign" {
		t.Fatalf("ReadAll SKILL.md = %q, want benign", got["SKILL.md"])
	}
	// 预览与落盘必须一致(这是本条审计的核心不变量)
	if content != string(got["SKILL.md"]) {
		t.Fatalf("预览(%q) ≠ 落盘(%q) —— 审核所见必须等于安装产物", content, got["SKILL.md"])
	}
}

// TestTarGzDirectoryPlusSameNamedFile 锁目录条目不算重复内容
// (与 zip 分支 checkZipDuplicates 跳过 "/" 结尾条目的语义一致)。
func TestTarGzDirectoryPlusSameNamedFile(t *testing.T) {
	ok := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "ok"},
		{"sub/", ""},
		{"sub/x.md", "x"},
	})
	if _, err := Validate(ok, testLim); err != nil {
		t.Fatalf("目录 + 同名文件不该被判重复: %v", err)
	}
}
