package archiveutil

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N6 / F2-N7)的永久回归
//
// F2-N6:一轮的 archupd-3 只对**必填文件**做了 CRC 校验,非必填条目损坏
// (references/broken.md 之类)仍能 201 上传、审核通过,员工安装时才抛
// BAD_CRC —— 故障落在最远端。现在每个非目录条目都要在上传期解压校验,
// 且总额按**实际解压字节**封顶(声明尺寸可以撒谎)。
//
// F2-N7:installerKey 的折叠是宁严勿宽(有意取舍),但拒绝时必须列出被判为
// 同一个文件的两个名字,否则用户无从改名。
// ---------------------------------------------------------------------------

// TestValidateRejectsCorruptAuxiliaryEntry:F2-N6 —— 非必填条目 CRC 损坏
// 必须在 Validate 就暴露,而不是等员工安装。
func TestValidateRejectsCorruptAuxiliaryEntry(t *testing.T) {
	raw := makeZip(t, map[string][]byte{
		"SKILL.md":           []byte("---\nname: demo\n---\n\nbody long enough to matter\n"),
		"references/aux.md":  []byte("auxiliary payload that will be corrupted on purpose\n"),
		"references/okay.md": []byte("this one stays intact\n"),
	}, false)
	corrupt := corruptZipPayload(t, raw, "references/aux.md")

	if _, err := Validate(corrupt, testLim); !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Validate(非必填条目 CRC 损坏) = %v, want ErrCorrupt(上传期就该拒,员工安装时才炸太晚)", err)
	}
	// 控制组:同一份归档未损坏时必须通过(校验不能误伤)。
	if _, err := Validate(raw, testLim); err != nil {
		t.Fatalf("Validate(完好归档) = %v, want nil", err)
	}
	// tar.gz 侧同口径。
	tarRaw := makeTarGz(t, map[string]string{
		"SKILL.md":          "---\nname: demo\n---\n\nbody long enough to matter\n",
		"references/aux.md": "auxiliary payload\n",
	}, false)
	if _, err := Validate(tarRaw, testLim); err != nil {
		t.Fatalf("Validate(完好 tar.gz) = %v, want nil", err)
	}
}

// TestValidateRejectsArchiveWhoseRealUnpackedSizeExceedsBudget:F2-N6 的
// 放大器 —— 校验全部条目之后,「大量条目各自声明 0 字节、实际高度可压」不能
// 变成无界 CPU。预算按实际解压字节累计,超限即 ErrInvalid。
func TestValidateRejectsArchiveWhoseRealUnpackedSizeExceedsBudget(t *testing.T) {
	lim := Limits{MaxArchiveBytes: MaxArchiveBytes, MaxUnpackedBytes: 8 << 20, MaxEntries: MaxArchiveEntries, RequiredFile: "SKILL.md"}
	big := bytes.Repeat([]byte{0}, 3<<20) // 每个条目真实解压 3MiB,压缩后极小
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	write := func(name string, payload []byte) {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	write("SKILL.md", []byte("---\nname: demo\n---\n\nbody long enough to matter\n"))
	blobs := make([]string, 0, 8)
	for i := 0; i < 8; i++ { // 8 × 3MiB = 24MiB 真实解压 > 8MiB 预算
		name := fmt.Sprintf("references/blob-%d.bin", i)
		blobs = append(blobs, name)
		write(name, big)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	t.Logf("压缩后 %d 字节,真实解压 24MiB(预算 8MiB)", len(raw))

	// ① 声明尺寸诚实:walkZip 的声明总量检查先拒。
	t0 := time.Now()
	if _, err := Validate(raw, lim); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Validate(真实解压超预算) = %v, want ErrInvalid(真实解压总量超限)", err)
	}
	t.Logf("① 声明诚实的超预算归档:拒绝耗时 %v", time.Since(t0).Round(time.Millisecond))

	// ② 声明尺寸全部改成 0(声明总量骗过检查),真实解压仍是 24MiB:预算必须在
	// **实际字节**上兜底(zip 读取器会先报 ErrFormat,同样是拒绝)。
	forged := raw
	for _, name := range blobs {
		forged = zipCDEntryPatch(t, forged, name, 0)
	}
	t0 = time.Now()
	_, err := Validate(forged, lim)
	el := time.Since(t0)
	t.Logf("② 声明 0 字节 / 真实 24MiB:err=%v 耗时 %v", err, el.Round(time.Millisecond))
	if err == nil {
		t.Fatal("伪造声明尺寸的归档被放行")
	}
	if !errors.Is(err, ErrInvalid) && !errors.Is(err, ErrCorrupt) {
		t.Fatalf("Validate = %v, want ErrInvalid/ErrCorrupt", err)
	}
	// 预算必须在**实际字节**上封顶:最坏情况只解压 MaxUnpackedBytes+1。
	if el > 3*time.Second {
		t.Fatalf("校验耗时 %v:预算没有封住实际解压量", el)
	}
}

// TestValidateFullEntryVerificationCost:F2-N10/N6 的成本实测(只记录+给一个
// 宽松上界)。全量校验把上传期的解压量从「一个必填条目」提高到「整个归档」,
// 上界是 MaxUnpackedBytes(64MiB),对应几十毫秒 —— 不是无界放大。
func TestValidateFullEntryVerificationCost(t *testing.T) {
	lim := DefaultLimits("SKILL.md")

	realistic := makeZip(t, map[string][]byte{
		"SKILL.md": []byte("---\nname: demo\n---\n\nbody long enough to matter\n"),
		"a.bin":    bytes.Repeat([]byte("payload-"), 4<<10), // 32KiB
		"b.bin":    bytes.Repeat([]byte("payload-"), 4<<10),
	}, false)
	t0 := time.Now()
	if _, err := Validate(realistic, lim); err != nil {
		t.Fatal(err)
	}
	t.Logf("普通归档(%d 字节) 全量校验耗时 %v", len(realistic), time.Since(t0).Round(time.Microsecond))

	// 最坏合法形态:真实解压量顶到预算上限的高度可压归档。
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	blob := bytes.Repeat([]byte{0}, 4<<20)
	write := func(name string, payload []byte) {
		w, err := zw.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Deflate})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(payload); err != nil {
			t.Fatal(err)
		}
	}
	write("SKILL.md", []byte("---\nname: demo\n---\n\nbody long enough to matter\n"))
	for i := 0; i < 15; i++ { // 15 × 4MiB = 60MiB < 64MiB 预算 → 合法但接近上限
		write(fmt.Sprintf("blob-%d.bin", i), blob)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	t0 = time.Now()
	if _, err := Validate(raw, lim); err != nil {
		t.Fatalf("接近预算上限的归档被误拒: %v", err)
	}
	el := time.Since(t0)
	t.Logf("接近上限归档(压缩 %d 字节 / 真实解压 60MiB) 全量校验耗时 %v", len(raw), el.Round(time.Millisecond))
	if el > 3*time.Second {
		t.Fatalf("全量校验耗时 %v,超出可接受范围", el)
	}
}

// TestDuplicateEntryErrorNamesBothCollidingEntries:F2-N7 —— installerKey
// 会把 aſb.txt 与 asb.txt 判成同一个文件(宁严勿宽),拒绝信息必须点名两个
// 名字,让上传者能改名。此前只回一句「归档含重复条目」。
func TestDuplicateEntryErrorNamesBothCollidingEntries(t *testing.T) {
	raw := makeZip(t, map[string][]byte{
		"SKILL.md":     []byte("---\nname: demo\n---\n\nbody long enough to matter\n"),
		"a\u017fb.txt": []byte("first\n"),
		"asb.txt":      []byte("second\n"),
	}, false)
	_, err := Validate(raw, testLim)
	if !errors.Is(err, ErrDuplicateEntry) {
		t.Fatalf("Validate = %v, want ErrDuplicateEntry", err)
	}
	first, second, ok := DuplicateEntryNames(err)
	if !ok {
		t.Fatalf("拒绝信息没有携带冲突的两个条目名: %v", err)
	}
	if first != "a\u017fb.txt" || second != "asb.txt" {
		t.Fatalf("names = (%q, %q), want (aſb.txt, asb.txt)", first, second)
	}
	// 大小写折叠同理:两个名字都要出现。
	raw2 := makeZip(t, map[string][]byte{
		"SKILL.md": []byte("---\nname: demo\n---\n\nbody long enough to matter\n"),
		"Notes.md": []byte("first\n"),
		"notes.md": []byte("second\n"),
	}, false)
	if _, err := Validate(raw2, testLim); !errors.Is(err, ErrDuplicateEntry) {
		t.Fatalf("Validate(case collision) = %v, want ErrDuplicateEntry", err)
	}
}
