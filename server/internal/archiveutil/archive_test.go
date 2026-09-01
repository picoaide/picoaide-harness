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

var testLim = Limits{
	MaxArchiveBytes:  1 << 20,
	MaxUnpackedBytes: 4 << 20,
	MaxEntries:       100,
	RequiredFile:     "SKILL.md",
}

func makeZip(t *testing.T, entries map[string][]byte, symlink bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, content := range entries {
		hdr := &zip.FileHeader{Name: name, Method: zip.Deflate}
		if symlink && name == "link" {
			hdr.SetMode(fs.ModeSymlink | 0o777) // fs.FileMode 位,非 unix st_mode
		}
		w, err := zw.CreateHeader(hdr)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write(content); err != nil {
			t.Fatal(err)
		}
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func makeTarGz(t *testing.T, entries map[string]string, symlink bool) []byte {
	t.Helper()
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	for name, content := range entries {
		typ := byte(tar.TypeReg)
		size := int64(len(content))
		if symlink && name == "link" {
			typ = tar.TypeSymlink
			size = 0 // link target lives in the header, not the payload
		}
		if err := tw.WriteHeader(&tar.Header{Name: name, Typeflag: typ, Size: size}); err != nil {
			t.Fatal(err)
		}
		if size > 0 {
			if _, err := tw.Write([]byte(content)); err != nil {
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

func TestFormat(t *testing.T) {
	if Format([]byte{'P', 'K', 3, 4, 0, 0}) != "zip" {
		t.Fatal("zip magic not detected")
	}
	if Format([]byte{0x1f, 0x8b, 8, 0}) != "tar.gz" {
		t.Fatal("gzip magic not detected")
	}
	if Format([]byte{'x', 'y', 'z', 'w'}) != "" {
		t.Fatal("garbage accepted")
	}
	if Format(nil) != "" {
		t.Fatal("nil accepted")
	}
}

func TestValidateZip(t *testing.T) {
	data := makeZip(t, map[string][]byte{
		"SKILL.md":     []byte("# demo"),
		"tools/run.sh": []byte("x"),
	}, false)
	sum, err := Validate(data, testLim)
	if err != nil {
		t.Fatalf("valid zip rejected: %v", err)
	}
	if len(sum) != 64 {
		t.Fatalf("checksum = %q", sum)
	}

	// missing SKILL.md
	if _, err := Validate(makeZip(t, map[string][]byte{"readme.md": []byte("x")}, false), testLim); err != ErrNoRequired {
		t.Fatalf("missing required = %v", err)
	}
	// traversal
	if _, err := Validate(makeZip(t, map[string][]byte{"SKILL.md": []byte("x"), "../evil": []byte("x")}, false), testLim); err != ErrUnsafe {
		t.Fatalf("traversal = %v", err)
	}
	// absolute
	if _, err := Validate(makeZip(t, map[string][]byte{"SKILL.md": []byte("x"), "/etc/passwd": []byte("x")}, false), testLim); err != ErrUnsafe {
		t.Fatalf("absolute = %v", err)
	}
	// symlink
	if _, err := Validate(makeZip(t, map[string][]byte{"SKILL.md": []byte("x"), "link": []byte("target")}, true), testLim); err != ErrUnsafe {
		t.Fatalf("symlink = %v", err)
	}
	// garbage
	if _, err := Validate([]byte("not an archive"), testLim); err != ErrInvalid {
		t.Fatalf("garbage = %v", err)
	}
	// oversized
	big := append([]byte{'P', 'K', 3, 4}, make([]byte, 2000000)...)
	if _, err := Validate(big, testLim); err != ErrInvalid {
		t.Fatalf("oversized = %v", err)
	}
}

func TestValidateTarGzCompat(t *testing.T) {
	data := makeTarGz(t, map[string]string{"SKILL.md": "# demo", "tools/run.sh": "x"}, false)
	if _, err := Validate(data, testLim); err != nil {
		t.Fatalf("valid tar.gz rejected: %v", err)
	}
	if _, err := Validate(makeTarGz(t, map[string]string{"SKILL.md": "x", "../evil": "x"}, false), testLim); err != ErrUnsafe {
		t.Fatalf("traversal = %v", err)
	}
	if _, err := Validate(makeTarGz(t, map[string]string{"SKILL.md": "x", "link": "t"}, true), testLim); err != ErrUnsafe {
		t.Fatalf("symlink = %v", err)
	}
	if _, err := Validate(makeTarGz(t, map[string]string{"readme.md": "x"}, false), testLim); err != ErrNoRequired {
		t.Fatalf("missing = %v", err)
	}
}

func TestListContentsZip(t *testing.T) {
	data := makeZip(t, map[string][]byte{
		"SKILL.md":     []byte("---\nname: demo\n---\n# hi"),
		"tools/run.sh": []byte("x"),
		"b.txt":        []byte("y"),
	}, false)
	files, content, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 3 || files[0] != "SKILL.md" || files[1] != "b.txt" || files[2] != "tools/run.sh" {
		t.Fatalf("files = %v", files)
	}
	if !strings.Contains(content, "name: demo") {
		t.Fatalf("content = %q", content)
	}
}

func TestListContentsTarGz(t *testing.T) {
	data := makeTarGz(t, map[string]string{"SKILL.md": "---\nname: demo\n---", "a.txt": "x"}, false)
	files, content, err := ListContents(data, testLim, 1<<20)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || !strings.Contains(content, "name: demo") {
		t.Fatalf("files=%v content=%q", files, content)
	}
}

func TestExtractFileContentZip(t *testing.T) {
	data := makeZip(t, map[string][]byte{
		"SKILL.md": []byte("# hi"),
		"a/b/c.md": []byte("nested"),
		"bin.dat":  []byte{0xff, 0xfe, 0x00},
	}, false)
	content, size, found, binary, tooLarge, err := ExtractFileContent(data, "a/b/c.md", 1<<20)
	if err != nil || !found || content != "nested" || size != 6 || binary || tooLarge {
		t.Fatalf("nested = %q %d %v %v %v %v", content, size, found, binary, tooLarge, err)
	}
	_, _, found, binary, _, err = ExtractFileContent(data, "bin.dat", 1<<20)
	if err != nil || !found || !binary {
		t.Fatalf("binary detection failed: %v %v %v", found, binary, err)
	}
	_, size, found, _, tooLarge, err = ExtractFileContent(data, "SKILL.md", 2)
	if err != nil || !found || !tooLarge || size != 4 {
		t.Fatalf("too large flag = %v %v %v %v", found, tooLarge, size, err)
	}
	_, _, found, _, _, err = ExtractFileContent(data, "missing.md", 1<<20)
	if err != nil || found {
		t.Fatalf("missing = %v %v", found, err)
	}
}

func TestExtractFileContentTarGz(t *testing.T) {
	data := makeTarGz(t, map[string]string{"SKILL.md": "# hi", "a.md": "x"}, false)
	content, _, found, _, _, err := ExtractFileContent(data, "a.md", 1<<20)
	if err != nil || !found || content != "x" {
		t.Fatalf("tar extract = %q %v %v", content, found, err)
	}
}

func TestErrorText(t *testing.T) {
	if ErrorText(ErrNoRequired, "SKILL.md", 16) == "" {
		t.Fatal("no message for ErrNoRequired")
	}
	if ErrorText(ErrUnsafe, "SKILL.md", 16) == "" {
		t.Fatal("no message for ErrUnsafe")
	}
	if ErrorText(errors.New("x"), "SKILL.md", 16) == "" {
		t.Fatal("no default message")
	}
}
