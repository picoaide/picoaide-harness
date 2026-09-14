package sharedskills

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N6)的永久回归(共享技能端到端)
//
// 上传闸门此前只对**必填文件**(SKILL.md)做 CRC 校验:非必填条目(如
// references/broken.md)损坏照样 201 上传 → 审核通过 → 员工安装时才抛
// BAD_CRC。修复后每个非目录条目都在上传期解压校验。
// ---------------------------------------------------------------------------

// corruptZipEntryPayload 翻转 zip 某个条目压缩载荷的首字节(CRC 必失败)。
// 与 archiveutil 包内的同名测试助手同法,这里独立实现(跨包测试代码不共享)。
func corruptZipEntryPayload(t *testing.T, raw []byte, name string) []byte {
	t.Helper()
	out := append([]byte(nil), raw...)
	for off := 0; off+30 <= len(out); off++ {
		if !bytes.Equal(out[off:off+4], []byte{'P', 'K', 3, 4}) {
			continue
		}
		nlen := int(binary.LittleEndian.Uint16(out[off+26 : off+28]))
		elen := int(binary.LittleEndian.Uint16(out[off+28 : off+30]))
		if off+30+nlen <= len(out) && bytes.Equal(out[off+30:off+30+nlen], []byte(name)) {
			out[off+30+nlen+elen] ^= 0xFF
			return out
		}
	}
	t.Fatalf("entry not found in archive: %q", name)
	return nil
}

func TestUploadRejectsCorruptAuxiliaryEntry(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	raw := makeSkillArchive(t, map[string]string{
		"SKILL.md":             skillMd("aux-crc", "1.0.0"),
		"references/broken.md": "payload that will be corrupted on purpose\n",
	})
	patched := corruptZipEntryPayload(t, raw, "references/broken.md")

	code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("aux-crc", "1.0.0", "损坏的辅助文件", patched))
	t.Logf("UPLOAD(非必填文件 CRC 损坏) -> %d %s", code, truncateBody(body, 200))
	if code == http.StatusCreated {
		t.Fatalf("CRC 损坏的非必填条目仍被上传门放行(201):员工安装时才会抛 BAD_CRC")
	}
	if code != http.StatusUnprocessableEntity {
		t.Fatalf("upload = %d %s, want 422(归档损坏)", code, body)
	}
	if !strings.Contains(body, "损坏") {
		t.Fatalf("错误信息没有说明归档损坏: %s", body)
	}
	if _, err := serverstore.GetSharedSkill(db, "aux-crc", "1.0.0"); err == nil {
		t.Fatal("损坏归档仍被落库")
	}

	// 控制组:同一份归档未损坏时必须 201(校验不能误伤)。
	ok := makeSkillArchive(t, map[string]string{
		"SKILL.md":             skillMd("aux-ok", "1.0.0"),
		"references/broken.md": "payload that stays intact\n",
	})
	code, body = skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("aux-ok", "1.0.0", "完好的辅助文件", ok))
	if code != http.StatusCreated {
		t.Fatalf("upload(完好归档) = %d %s, want 201", code, body)
	}
}

func truncateBody(s string, n int) string {
	if len(s) > n {
		return s[:n] + "..."
	}
	return s
}

// TestUploadNamesBothDuplicateEntries:F2-N7 端到端 —— installerKey 折叠出的
// 「重复条目」必须点名两个文件,否则用户不知道改哪个(误杀是宁严勿宽的代价,
// 但代价必须可自助解决)。
func TestUploadNamesBothDuplicateEntries(t *testing.T) {
	r, db, _, userHdr, _ := setup(t)
	defer db.Close()

	raw := makeSkillArchive(t, map[string]string{
		"SKILL.md":    skillMd("dup-name", "1.0.0"),
		"a\u017fb.md": "first\n",
		"asb.md":      "second\n",
	})
	code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		uploadBody("dup-name", "1.0.0", "折叠重名", raw))
	t.Logf("UPLOAD(aſb.md + asb.md) -> %d %s", code, body)
	if code == http.StatusCreated {
		t.Fatalf("折叠等价的重复条目被放行:审核所见 ≠ 员工所装")
	}
	if !strings.Contains(body, "a\u017fb.md") || !strings.Contains(body, "asb.md") {
		t.Fatalf("拒绝信息没有列出被判为同一文件的两个名字: %s", body)
	}
}
