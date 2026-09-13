package archiveutil

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// R7 审计回归(archupd-1 / archupd-3 / archupd-4 / archupd-5)
//
// 三条不变量:
//  1. 声明尺寸不可信:审核面必须先解压再判定「读得出来吗 / 多大」,
//     任何「按声明值决定要不要读原文」的做法都会让 >preview 上限的真实
//     编排静默降级成空串(err=nil),审核面由此变瞎;
//  2. 上传闸门(Validate)必须拒绝「必填文件 CRC 损坏」与「同一路径既是
//     文件又是目录」——这两类归档客户端安装必抛,不能放进员工机器;
//  3. 「名字以 / 结尾、模式却是符号链接」的条目在 Validate / ListContents /
//     ExtractFileContent / ReadAll 四个入口必须给出一致结论(拒绝)。
// ---------------------------------------------------------------------------

// zipCDEntryPatch 把某个条目在本地文件头与中央目录里的「声明解压尺寸」
// 改成 declared(声明值可以撒谎;真实字节由 deflate 流决定)。
func zipCDEntryPatch(t *testing.T, raw []byte, name string, declared uint32) []byte {
	t.Helper()
	out := append([]byte(nil), raw...)
	nameBytes := []byte(name)
	hits := 0
	for off := 0; off+30 <= len(out); off++ {
		// 本地文件头 PK\x03\x04:解压尺寸在 +22。
		if bytes.Equal(out[off:off+4], []byte{'P', 'K', 3, 4}) {
			nlen := int(binary.LittleEndian.Uint16(out[off+26 : off+28]))
			if off+30+nlen <= len(out) && bytes.Equal(out[off+30:off+30+nlen], nameBytes) {
				binary.LittleEndian.PutUint32(out[off+22:off+26], declared)
				hits++
			}
		}
		// 中央目录 PK\x01\x02:解压尺寸在 +24(读取器真正采信的那份)。
		if bytes.Equal(out[off:off+4], []byte{'P', 'K', 1, 2}) {
			nlen := int(binary.LittleEndian.Uint16(out[off+28 : off+30]))
			if off+46+nlen <= len(out) && bytes.Equal(out[off+46:off+46+nlen], nameBytes) {
				binary.LittleEndian.PutUint32(out[off+24:off+28], declared)
				hits++
			}
		}
	}
	if hits == 0 {
		t.Fatalf("no zip record found for %q", name)
	}
	return out
}

// corruptZipPayload 翻转某条目压缩载荷的第一个字节(CRC 校验必失败)。
func corruptZipPayload(t *testing.T, raw []byte, name string) []byte {
	t.Helper()
	out := append([]byte(nil), raw...)
	nameBytes := []byte(name)
	for off := 0; off+30 <= len(out); off++ {
		if !bytes.Equal(out[off:off+4], []byte{'P', 'K', 3, 4}) {
			continue
		}
		nlen := int(binary.LittleEndian.Uint16(out[off+26 : off+28]))
		elen := int(binary.LittleEndian.Uint16(out[off+28 : off+30]))
		if off+30+nlen <= len(out) && bytes.Equal(out[off+30:off+30+nlen], nameBytes) {
			payload := off + 30 + nlen + elen
			if payload >= len(out) {
				t.Fatalf("payload offset out of range for %q", name)
			}
			out[payload] ^= 0xFF
			return out
		}
	}
	t.Fatalf("entry not found: %q", name)
	return nil
}

// makeZipNamed 构造 zip(条目顺序固定,便于按序摆放符号链接目录条目)。
func makeZipNamed(t *testing.T, entries []struct {
	name    string
	content []byte
	mode    fs.FileMode
}) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, e := range entries {
		hdr := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.mode != 0 {
			hdr.SetMode(e.mode)
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		// 以 / 结尾的条目被 zip.Writer 视为目录,拒绝写入载荷。
		if !strings.HasSuffix(e.name, "/") {
			if _, err := w.Write(e.content); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestValidateRejectsCorruptRequiredFile(t *testing.T) {
	raw := makeZip(t, map[string][]byte{"SKILL.md": []byte("---\nname: demo\n---\n\nbody long enough to matter\n")}, false)
	raw = corruptZipPayload(t, raw, "SKILL.md")
	if _, err := Validate(raw, testLim); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Validate(corrupt SKILL.md) = %v, want ErrCorrupt", err)
	}
}

func TestValidateRejectsFileAndDirectoryAtSamePath(t *testing.T) {
	// 同一路径既是文件(SKILL.md)又是目录(SKILL.md/child.md):
	// 客户端解包必抛 EISDIR,上传闸门必须先拒。
	raw := makeZipNamed(t, []struct {
		name    string
		content []byte
		mode    fs.FileMode
	}{
		{"SKILL.md", []byte("---\nname: demo\n---\n\nbody long enough\n"), 0},
		{"SKILL.md/child.md", []byte("child\n"), 0},
	})
	if _, err := Validate(raw, testLim); !errors.Is(err, ErrPathConflict) {
		t.Fatalf("Validate(file+dir same path) = %v, want ErrPathConflict", err)
	}
}

func TestValidateRejectsSymlinkModeDirectoryEntry(t *testing.T) {
	// 名字以 / 结尾(S_IFDIR 假象)但模式位是 S_IFLNK:其余三个入口都
	// 判 ErrUnsafe,Validate 此前把 isDir 分支放在 symlink 检查之前而放行。
	raw := makeZipNamed(t, []struct {
		name    string
		content []byte
		mode    fs.FileMode
	}{
		{"SKILL.md", []byte("---\nname: demo\n---\n\nbody long enough\n"), 0},
		{"evil/", []byte("x"), fs.ModeSymlink | 0o777},
	})
	if _, err := Validate(raw, testLim); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("Validate(symlink-mode dir entry) = %v, want ErrUnsafe", err)
	}
	if _, _, err := ListContents(raw, testLim, 1<<20); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("ListContents(symlink-mode dir entry) = %v, want ErrUnsafe", err)
	}
	if _, _, _, _, _, err := ExtractFileContent(raw, "SKILL.md", 1<<20); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("ExtractFileContent(symlink-mode dir entry) = %v, want ErrUnsafe", err)
	}
	if _, err := ReadAll(raw, testLim); !errors.Is(err, ErrUnsafe) {
		t.Fatalf("ReadAll(symlink-mode dir entry) = %v, want ErrUnsafe", err)
	}
}

func TestExtractFileContentRejectsForgedDeclaredSize(t *testing.T) {
	body := []byte("---\nname: demo\ndescription: a real skill used for size checks\n---\n\n# Body\n")
	raw := makeZip(t, map[string][]byte{"SKILL.md": body}, false)
	// 声明 1 MiB、真实只有几十字节:修复前逐文件审核接口按声明值直接返回
	// tooLarge + size=1048576(审核人被引向错误结论)。修复后必须真的解压:
	// 声明与真实不符即明确报损坏,绝不再吐出伪造长度。
	raw = zipCDEntryPatch(t, raw, "SKILL.md", 1<<20)
	_, size, _, _, tooLarge, err := ExtractFileContent(raw, "SKILL.md", 1<<20)
	if err == nil {
		t.Fatalf("forged declared size served as size=%d tooLarge=%v; want explicit corruption error", size, tooLarge)
	}
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("ExtractFileContent(forged size) = %v, want ErrCorrupt", err)
	}
}

func TestListContentsDoesNotSilentlySkipRequiredFileOnForgedSize(t *testing.T) {
	body := []byte("---\nname: demo\ndescription: a real skill used for size checks\n---\n\n# Body\n")
	raw := makeZip(t, map[string][]byte{"SKILL.md": body}, false)
	// 声明 2 MiB → 修复前 zipList 直接跳过读取(required=="" 且 err=nil),
	// 审核面看到的是「空 SKILL.md」且没有任何错误信号 —— 这正是 archupd-1
	// 的盲区:审核人无法区分「空文件」与「根本没读」。
	raw = zipCDEntryPatch(t, raw, "SKILL.md", 2<<20)
	files, required, err := ListContents(raw, testLim, 1<<20)
	if err == nil {
		t.Fatalf("ListContents(forged size) = (files=%v, required=%q, err=nil): silent degradation must not happen", files, required)
	}
	if !errors.Is(err, ErrCorrupt) {
		t.Fatalf("ListContents(forged size) = %v, want ErrCorrupt", err)
	}
}

// archupd-2(只修可验证的那半):查重键必须对齐**安装端文件系统**的名字
// 等价类,而不只是语言级的 ToLower。Win32 会剥离每个路径分量结尾的点/空格,
// NTFS 的 $UpCase 把 U+017F ſ / U+0131 ı / U+212A K 折成 s/i/k ——
// 这些名字在服务端看起来不同,在员工机器上是同一个文件(末条覆盖先条)。
// 完整 NTFS 表与真实 Windows 行为不在本容器可验证范围(TASKS.md 记录在案),
// 这里只统一「查重键」的口径:宁可错杀,不放行。
func TestValidateRejectsInstallerEquivalentEntryNames(t *testing.T) {
	cases := []struct {
		name   string
		first  string
		second string
	}{
		{"trailing dot", "SKILL.md", "SKILL.md."},
		{"trailing space", "SKILL.md", "SKILL.md "},
		{"long s", "SKILL.md", "\u017fKILL.md"},
		{"dotless i", "SKILL.mid", "SKILL.m\u0131d"},
		{"kelvin sign", "SKILL.mkd", "SKILL.m\u212ad"},
	}
	for _, c := range cases {
		raw := makeZip(t, map[string][]byte{
			c.first:    []byte("benign body long enough to matter\n"),
			c.second:   []byte("EVIL\n"),
			"extra.md": []byte("x\n"),
		}, false)
		if _, err := Validate(raw, testLim); !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s: Validate(%q + %q) = %v, want ErrDuplicateEntry", c.name, c.first, c.second, err)
		}
	}
}
