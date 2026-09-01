package archiveutil

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"errors"
	"io/fs"
	"strings"
	"testing"
)

// TestNormalizePathEdgeCases covers the pre-normalize absolute-path and
// drive-letter refusals plus the structural `./` pack root.
func TestNormalizePathEdgeCases(t *testing.T) {
	cases := []struct {
		raw     string
		want    string
		wantErr bool
	}{
		{"", "", false},
		{"./", "", false},
		{"./a/b", "a/b", false},
		{"a//b", "a/b", false},
		{"a/./b", "a/b", false},
		{"../a", "", true},
		{"a/../../b", "", true},
		{"/etc/passwd", "", true},
		{`\etc\passwd`, "", true},
		{`C:\x\y`, "", true},
		{`c:/x`, "", true},
		{"a\\b/c", "a/b/c", false}, // backslash is normalized to /
	}
	for _, c := range cases {
		got, err := NormalizePath(c.raw)
		if c.wantErr {
			if err == nil || !errors.Is(err, ErrUnsafe) {
				t.Errorf("NormalizePath(%q) err = %v, want ErrUnsafe", c.raw, err)
			}
			continue
		}
		if err != nil {
			t.Errorf("NormalizePath(%q) unexpected error: %v", c.raw, err)
			continue
		}
		if got != c.want {
			t.Errorf("NormalizePath(%q) = %q, want %q", c.raw, got, c.want)
		}
	}
}

// TestValidateZipBomb guards the declared-size vs actual-bytes boundary:
// an entry that inflates beyond MaxUnpackedBytes must be refused even when
// its header claims a small size.
func TestValidateZipBomb(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	// Header declares 100 bytes; the payload is far larger.
	hdr := &zip.FileHeader{Name: "SKILL.md", Method: zip.Store}
	w, err := zw.CreateHeader(hdr)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(bytes.Repeat([]byte("AAAA"), 2<<20)); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	data := buf.Bytes()

	_, err = Validate(data, testLim)
	if !errors.Is(err, ErrInvalid) {
		t.Fatalf("Validate = %v, want ErrInvalid", err)
	}
}

// TestReadAllZipAndTarGz exercises the whole-archive extraction path used by
// 规范化流程 (rewrite SKILL.md and repack).
func TestReadAllZipAndTarGz(t *testing.T) {
	zipData := makeZip(t, map[string][]byte{
		"SKILL.md": []byte("# Skill\n"),
		"img.png":  []byte("\x89PNG"),
	}, false)
	for name, data := range map[string][]byte{"zip": zipData} {
		_ = name
		files, err := ReadAll(data, testLim)
		if err != nil {
			t.Fatalf("ReadAll: %v", err)
		}
		if string(files["SKILL.md"]) != "# Skill\n" {
			t.Errorf("SKILL.md = %q", files["SKILL.md"])
		}
		if string(files["img.png"]) != "\x89PNG" {
			t.Errorf("img.png = %q", files["img.png"])
		}
	}

	// tar.gz with a directory entry and a file.
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	if err := tw.WriteHeader(&tar.Header{Name: "dir/", Typeflag: tar.TypeDir, Size: 0}); err != nil {
		t.Fatal(err)
	}
	if err := tw.WriteHeader(&tar.Header{Name: "dir/SKILL.md", Typeflag: tar.TypeReg, Size: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	files, err := ReadAll(buf.Bytes(), testLim)
	if err != nil {
		t.Fatalf("ReadAll tar.gz: %v", err)
	}
	if string(files["dir/SKILL.md"]) != "hello" {
		t.Errorf("dir/SKILL.md = %q", files["dir/SKILL.md"])
	}
	if _, ok := files["dir"]; ok {
		t.Error("directory entry must not be returned as a file")
	}
}

// TestReadAllRejectsSymlinks: link entries are never extracted (both formats).
func TestReadAllRejectsSymlinks(t *testing.T) {
	zipData := makeZip(t, map[string][]byte{"SKILL.md": []byte("x"), "link": []byte("etc/passwd")}, true)
	if _, err := ReadAll(zipData, testLim); !errors.Is(err, ErrUnsafe) {
		t.Errorf("ReadAll zip with symlink = %v, want ErrUnsafe", err)
	}
	tarData := makeTarGz(t, map[string]string{"SKILL.md": "x", "link": "etc/passwd"}, true)
	if _, err := ReadAll(tarData, testLim); !errors.Is(err, ErrUnsafe) {
		t.Errorf("ReadAll tar.gz with symlink = %v, want ErrUnsafe", err)
	}
}

// TestReadAllRejectsBadContainers: garbage and truncated payloads fail with
// ErrInvalid (not a panic).
func TestReadAllRejectsBadContainers(t *testing.T) {
	if _, err := ReadAll([]byte("not an archive"), testLim); !errors.Is(err, ErrInvalid) {
		t.Errorf("garbage = %v, want ErrInvalid", err)
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	if err := tw.WriteHeader(&tar.Header{Name: "SKILL.md", Typeflag: tar.TypeReg, Size: 5}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gw.Close(); err != nil {
		t.Fatal(err)
	}
	// Cut the payload in half: the gzip stream is truncated mid-file, tar
	// iteration must surface ErrInvalid (not a clean EOF) and ReadAll must
	// not panic.
	truncated := buf.Bytes()[:buf.Len()/2]
	if _, err := ReadAll(truncated, testLim); !errors.Is(err, ErrInvalid) {
		t.Errorf("truncated tar = %v, want ErrInvalid", err)
	}
}

// TestWriteZipRoundTrip: WriteZip output must Validate + ReadAll cleanly and
// preserve content (deterministic ordering asserted by byte equality).
func TestWriteZipRoundTrip(t *testing.T) {
	files := map[string][]byte{
		"z.txt":     []byte("last"),
		"a.txt":     []byte("first"),
		"SKILL.md":  []byte("# T\n"),
		"sub/x.txt": []byte("nested"),
	}
	data, err := WriteZip(files)
	if err != nil {
		t.Fatalf("WriteZip: %v", err)
	}
	sum, err := Validate(data, testLim)
	if err != nil {
		t.Fatalf("Validate written zip: %v", err)
	}
	if sum == "" {
		t.Fatal("empty checksum")
	}
	// Deterministic: writing the same set twice yields the same bytes.
	again, err := WriteZip(files)
	if err != nil {
		t.Fatalf("WriteZip again: %v", err)
	}
	if !bytes.Equal(data, again) {
		t.Error("WriteZip output is not deterministic")
	}
	out, err := ReadAll(data, testLim)
	if err != nil {
		t.Fatalf("ReadAll written zip: %v", err)
	}
	if string(out["SKILL.md"]) != "# T\n" {
		t.Errorf("SKILL.md = %q", out["SKILL.md"])
	}
	if string(out["a.txt"]) != "first" {
		t.Errorf("a.txt = %q", out["a.txt"])
	}
}

// TestExtractFileContentBinaryAndTooLarge: flags instead of payload for
// binary and oversized entries (preview path never returns raw bytes).
func TestExtractFileContentBinaryAndTooLarge(t *testing.T) {
	zipData := makeZip(t, map[string][]byte{
		"SKILL.md": []byte("ok"),
		"bin.dat":  []byte{0xff, 0xfe, 0x00, 0x01},
	}, false)
	_, _, found, binary, _, err := ExtractFileContent(zipData, "bin.dat", 100)
	if err != nil {
		t.Fatalf("ExtractFileContent: %v", err)
	}
	if !found || !binary {
		t.Errorf("bin.dat found=%v binary=%v, want true/true", found, binary)
	}
	_, size, found, _, tooLarge, err := ExtractFileContent(zipData, "SKILL.md", 1)
	if err != nil {
		t.Fatalf("ExtractFileContent: %v", err)
	}
	if !found || !tooLarge || size != 2 {
		t.Errorf("SKILL.md found=%v tooLarge=%v size=%d, want true/true/2", found, tooLarge, size)
	}
	// Missing target: not found, no error.
	_, _, found, _, _, err = ExtractFileContent(zipData, "missing.md", 100)
	if err != nil || found {
		t.Errorf("missing target: found=%v err=%v", found, err)
	}
}

// TestErrorTextUnmapped: an unknown error falls through to the generic copy.
func TestErrorTextUnmapped(t *testing.T) {
	got := ErrorText(errors.New("other"), "SKILL.md", 10)
	if got != "归档校验失败" {
		t.Errorf("ErrorText(other) = %q", got)
	}
	if !strings.Contains(ErrorText(ErrNoRequired, "SKILL.md", 10), "SKILL.md") {
		t.Error("ErrNoRequired text must name the required file")
	}
	if strings.Contains(ErrorText(ErrInvalid, "SKILL.md", 10), "(上限 10MB)") == false {
		t.Error("ErrInvalid text must carry the size bound")
	}
	_ = fs.ModeSymlink
}
