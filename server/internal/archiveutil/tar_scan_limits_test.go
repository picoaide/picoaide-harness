package archiveutil

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"testing"
)

// zeroReader 产生无限零字节(构造超限归档用,避免测试里分配 64 MB 切片)。
type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = 0
	}
	return len(p), nil
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b [20]byte
	pos := len(b)
	for i > 0 {
		pos--
		b[pos] = byte('0' + i%10)
		i /= 10
	}
	return string(b[pos:])
}

// makeTarGzWithLargeEntry 生成一个 tar.gz:先一个声明的 blob(全零,可压缩),
// 再在末尾放一份正常的 SKILL.md —— 复刻"为查重改成全量遍历后,函数内没有
// 条目数/体积上限"的现场(tarExtract 必须扫完整个归档才能返回命中结果)。
func makeTarGzWithLargeEntry(t *testing.T, blobName string, blobSize int64, extraEntries int) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	add := func(name, content string) {
		hdr := &tar.Header{Name: name, Typeflag: tar.TypeReg, Size: int64(len(content))}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if content != "" {
			if _, err := tw.Write([]byte(content)); err != nil {
				t.Fatal(err)
			}
		}
	}
	if blobSize > 0 {
		if err := tw.WriteHeader(&tar.Header{Name: blobName, Typeflag: tar.TypeReg, Size: blobSize}); err != nil {
			t.Fatal(err)
		}
		if _, err := io.CopyN(tw, zeroReader{}, blobSize); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < extraEntries; i++ {
		add("extras/f"+itoa(i)+".md", "x")
	}
	add("SKILL.md", "benign")
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// 复核残留 2(2026-09-13 独立复核确认仍存在):tarExtract 为查重改成全量遍历
// 后,函数内没有条目数/体积上限。
//
// 缺陷形态:tar 没有 zip 那种只读条目头的廉价预扫,"命中即 return" 会让位于
// 目标之后的重复条目逃过检查,所以 FIX-24 改成扫完整个归档 —— 但 tarExtract
// 的签名没有 Limits 参数(ExtractFileContent(data, target, maxPreview)),函数
// 体内也没有任何计数。基线实测:10001 条目 37.0ms、100000 条目 372.8ms,且都
// 成功返回内容;65KB 原始字节即可声明 64MiB+1 的解包量(全零高压缩比)。
// 当前被入库前的 Validate(MaxArchiveEntries=10000)兜住,属"未来若有人跳过
// Validate 就直接继承无界扫描"的加固缺口。
//
// 修法:函数内用包内既有常量(与 Validate/ReadAll 同一套 MaxArchiveEntries /
// MaxUnpackedBytes,见 archiveutil.DefaultLimits)计数,越界即拒
// (ErrTooMany / ErrInvalid),不新造口径。
func TestTarExtractEnforcesEntryLimit(t *testing.T) {
	// 目标文件放在**最后**:基线会扫完全部 10001 条并成功返回内容。
	over := makeTarGzWithLargeEntry(t, "extras/pad.bin", 0, MaxArchiveEntries)
	content, _, found, _, _, err := ExtractFileContent(over, "SKILL.md", 4096)
	if !errors.Is(err, ErrTooMany) {
		t.Fatalf("超条目上限的 tar: err = %v(found=%v content=%q), want ErrTooMany", err, found, content)
	}

	// 防误伤:条目数在限内的同一形态必须照常命中。
	under := makeTarGzWithLargeEntry(t, "extras/pad.bin", 0, 10)
	gotContent, gotSize, gotFound, _, gotTooLarge, gotErr := ExtractFileContent(under, "SKILL.md", 4096)
	if gotErr != nil || !gotFound || gotTooLarge || gotContent != "benign" || gotSize != int64(len("benign")) {
		t.Fatalf("限内 tar 抽取异常: content=%q size=%d found=%v tooLarge=%v err=%v",
			gotContent, gotSize, gotFound, gotTooLarge, gotErr)
	}
}

func TestTarExtractEnforcesUnpackedLimit(t *testing.T) {
	// 声明体积超过 MaxUnpackedBytes:必须按声明大小拒绝,而不是一路扫完
	// (基线在同样的 65KB 原始归档上成功返回 SKILL.md)。
	over := makeTarGzWithLargeEntry(t, "extras/blob.bin", MaxUnpackedBytes+1, 0)
	content, _, found, _, _, err := ExtractFileContent(over, "SKILL.md", 4096)
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("超解包上限的 tar: err = %v(found=%v content=%q), want ErrInvalid", err, found, content)
	}

	// 防误伤:体积在限内的 tar 照常命中。
	under := makeTarGzWithLargeEntry(t, "extras/blob.bin", 1<<20, 0)
	gotContent, _, gotFound, _, _, gotErr := ExtractFileContent(under, "SKILL.md", 4096)
	if gotErr != nil || !gotFound || gotContent != "benign" {
		t.Fatalf("限内 tar 抽取异常: content=%q found=%v err=%v", gotContent, gotFound, gotErr)
	}
}

// TestTarExtractCleanArchiveUnaffected 锁四个入口在"干净归档"上口径一致
// (扫描上限只拦异常形态,不改变正常行为)。
func TestTarExtractCleanArchiveUnaffected(t *testing.T) {
	ok := makeTarGzSeq(t, []tarSeqEntry{
		{"SKILL.md", "benign"},
		{"references/a.md", "x"},
		{"references/", ""},
	})
	if _, err := Validate(ok, testLim); err != nil {
		t.Fatalf("Validate(clean) = %v", err)
	}
	if _, err := ReadAll(ok, testLim); err != nil {
		t.Fatalf("ReadAll(clean) = %v", err)
	}
	content, _, found, _, _, err := ExtractFileContent(ok, "SKILL.md", 4096)
	if err != nil || !found || content != "benign" {
		t.Fatalf("ExtractFileContent(clean) = %q found=%v err=%v", content, found, err)
	}
}
