package archiveutil

import (
	"errors"
	"testing"
)

// FIX-24 残留 1(2026-09-13 独立复核确认仍存在):zip 分支的 ReadAll 没有重复
// 条目检查。
//
// 缺陷形态:zip 有 checkZipDuplicates,但只被 validateZip / zipList /
// zipExtract 调用;zipReadAll 至今不查重 → 同一份双 SKILL.md 的 zip 在四个
// 入口给出两个答案:
//
//	Validate            → ErrDuplicateEntry(审核拒绝)
//	ListContents        → ErrDuplicateEntry
//	ExtractFileContent  → ErrDuplicateEntry
//	ReadAll             → "EVIL"(out[name]=buf 末条覆盖,err=nil)
//
// 与 tar.gz 分支(tarReadAll 用 dupEntrySet,已修)口径不一致。当前所有调用点
// (marketplace.normalizeSkillAdmin 等)都在入库时先 Validate 兜住,所以实际
// 不可利用;但"四入口口径一致"是包的不变量,ReadAll 仍是"审核所见 ≠ 重打包
// 产物"的潜在载体。
//
// 修法:zipReadAll 复用同一个 checkZipDuplicates(与 validateZip/zipList/
// zipExtract 同源,不写第二份实现)。
func TestZipRejectsDuplicateEntriesOnAllFourEntries(t *testing.T) {
	dup := makeZipSeq(t, []zipSeqEntry{
		{"SKILL.md", []byte("benign")},
		{"SKILL.md", []byte("EVIL")},
	})
	caseDup := makeZipSeq(t, []zipSeqEntry{
		{"SKILL.md", []byte("benign")},
		{"skill.md", []byte("EVIL")}, // 客户端文件系统大小写不敏感
	})

	for name, data := range map[string][]byte{"dup": dup, "case-dup": caseDup} {
		if _, err := Validate(data, testLim); !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s: Validate = %v, want ErrDuplicateEntry", name, err)
		}
		if _, _, err := ListContents(data, testLim, 4096); !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s: ListContents = %v, want ErrDuplicateEntry", name, err)
		}
		if _, _, _, _, _, err := ExtractFileContent(data, "SKILL.md", 4096); !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s: ExtractFileContent = %v, want ErrDuplicateEntry", name, err)
		}
		// 基线在这里返回 EVIL / err=nil —— 四个入口唯一不一致的一个。
		files, err := ReadAll(data, testLim)
		if !errors.Is(err, ErrDuplicateEntry) {
			t.Errorf("%s: ReadAll = %v (SKILL.md=%q skill.md=%q), want ErrDuplicateEntry(基线返回 EVIL + nil)",
				name, err, files["SKILL.md"], files["skill.md"])
		}
	}
}

// TestZipReadAllCleanArchiveStillWorks 是防误伤:只有一份 SKILL.md 的正常 zip
// (含子目录与一个目录条目)必须照常 ReadAll,且预览与落盘内容一致。
func TestZipReadAllCleanArchiveStillWorks(t *testing.T) {
	ok := makeZipSeq(t, []zipSeqEntry{
		{"SKILL.md", []byte("benign")},
		{"references/", nil},
		{"references/a.md", []byte("x")},
	})
	files, content, err := ListContents(ok, testLim, 4096)
	if err != nil {
		t.Fatalf("ListContents(clean) = %v", err)
	}
	if content != "benign" {
		t.Fatalf("preview = %q, want benign", content)
	}
	got, err := ReadAll(ok, testLim)
	if err != nil {
		t.Fatalf("ReadAll(clean) = %v", err)
	}
	if string(got["SKILL.md"]) != content {
		t.Fatalf("预览(%q) ≠ 落盘(%q)", content, got["SKILL.md"])
	}
	if string(got["references/a.md"]) != "x" {
		t.Fatalf("子目录条目内容 = %q", got["references/a.md"])
	}
	if len(files) != 2 {
		t.Fatalf("files = %v, want 2 个非目录条目", files)
	}
}
