// Package archiveutil implements the shared archive safety checks for the
// skill/preset stores. Both zip (推荐/新格式) and gzipped tar (旧格式/兼容)
// archives are accepted: the format is sniffed from the magic bytes so
// pre-migration rows keep validating, previewing and installing.
//
// Every returned error is one of the package sentinels; callers map them to
// their own error taxonomy (sharedskills / agentshare / marketplace).
package archiveutil

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"sort"
	"strings"
	"unicode/utf8"
)

// Limits bound one archive: raw bytes, total unpacked payload, entry count,
// and the file that must exist at the archive root.
type Limits struct {
	MaxArchiveBytes  int
	MaxUnpackedBytes int64
	MaxEntries       int
	RequiredFile     string
}

var (
	// ErrInvalid: the archive failed structural validation (too large / bad
	// container / not the required format).
	ErrInvalid = errors.New("archive invalid")
	// ErrUnsafe: an entry path escapes the root or is a link file.
	ErrUnsafe = errors.New("unsafe archive")
	// ErrNoRequired: the archive carries no top-level required file.
	ErrNoRequired = errors.New("archive has no required file at its root")
	// ErrTooMany: too many entries in the archive.
	ErrTooMany = errors.New("archive has too many entries")
)

// Format returns "zip" or "tar.gz" for a payload whose magic bytes match,
// "" otherwise (callers then treat it as invalid).
func Format(data []byte) string {
	if len(data) >= 4 && data[0] == 'P' && data[1] == 'K' && (data[2] == 3 || data[2] == 5 || data[2] == 7) {
		return "zip"
	}
	if len(data) >= 2 && data[0] == 0x1f && data[1] == 0x8b {
		return "tar.gz"
	}
	return ""
}

// Validate lists an archive without extracting it, refusing unsafe entries
// and bounding size/entry count, and requiring lim.RequiredFile at the root
// (flat — no leading directory segment). Returns the archive's sha256 hex.
func Validate(data []byte, lim Limits) (string, error) {
	if len(data) == 0 || len(data) > lim.MaxArchiveBytes {
		return "", ErrInvalid
	}
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])
	switch Format(data) {
	case "zip":
		return hexSum, validateZip(data, lim)
	case "tar.gz":
		return hexSum, validateTar(data, lim)
	default:
		return "", ErrInvalid
	}
}

// ListContents lists the archive's non-directory entry paths (sorted,
// unique) and returns the top-level required file's content (capped at
// maxPreview bytes; larger → empty string).
func ListContents(data []byte, lim Limits, maxPreview int64) ([]string, string, error) {
	switch Format(data) {
	case "zip":
		return zipList(data, lim, maxPreview)
	case "tar.gz":
		return tarList(data, lim, maxPreview)
	default:
		return nil, "", ErrInvalid
	}
}

// ExtractFileContent finds one archive entry by normalized path and returns
// its text content. Binary (non-UTF-8) and oversized entries return flags
// instead of payload; the caller decides how to present them.
func ExtractFileContent(data []byte, target string, maxPreview int64) (content string, size int64, found, binary, tooLarge bool, err error) {
	switch Format(data) {
	case "zip":
		return zipExtract(data, target, maxPreview)
	case "tar.gz":
		return tarExtract(data, target, maxPreview)
	default:
		return "", 0, false, false, false, ErrInvalid
	}
}

// ---- zip implementation (archive/zip) ----

type zipWalk func(zf *zip.File, name string, isDir bool, mode fs.FileMode) (keepGoing bool, rerr error)

func walkZip(data []byte, lim Limits, fn zipWalk) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ErrInvalid
	}
	entries := 0
	var total uint64
	for _, zf := range zr.File {
		entries++
		if entries > lim.MaxEntries {
			return ErrTooMany
		}
		name, err := NormalizePath(zf.Name)
		if err != nil {
			return ErrUnsafe
		}
		isDir := strings.HasSuffix(zf.Name, "/")
		if zf.UncompressedSize64 > uint64(lim.MaxUnpackedBytes) {
			return ErrInvalid
		}
		total += zf.UncompressedSize64
		if total > uint64(lim.MaxUnpackedBytes) {
			return ErrInvalid
		}
		keep, rerr := fn(zf, name, isDir, zf.Mode())
		if rerr != nil {
			return rerr
		}
		if !keep {
			break
		}
	}
	return nil
}

func validateZip(data []byte, lim Limits) error {
	hasRequired := false
	err := walkZip(data, lim, func(zf *zip.File, name string, isDir bool, mode fs.FileMode) (bool, error) {
		if isDir {
			return true, nil
		}
		if name == "" {
			return false, ErrUnsafe
		}
		if mode&fs.ModeSymlink != 0 {
			return false, ErrUnsafe
		}
		if name == lim.RequiredFile {
			hasRequired = true
		}
		return true, nil
	})
	if err != nil {
		return err
	}
	if !hasRequired {
		return ErrNoRequired
	}
	return nil
}

func zipList(data []byte, lim Limits, maxPreview int64) ([]string, string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, "", ErrInvalid
	}
	set := map[string]bool{}
	var required string
	var order []string
	entries := 0
	for _, zf := range zr.File {
		entries++
		if entries > lim.MaxEntries {
			return nil, "", ErrTooMany
		}
		if zf.Mode()&fs.ModeSymlink != 0 {
			return nil, "", ErrUnsafe
		}
		name, err := NormalizePath(zf.Name)
		if err != nil {
			return nil, "", ErrUnsafe
		}
		if strings.HasSuffix(zf.Name, "/") {
			continue
		}
		if name == "" {
			continue
		}
		if name == lim.RequiredFile && required == "" && zf.UncompressedSize64 <= uint64(maxPreview) {
			rc, rerr := zf.Open()
			if rerr != nil {
				return nil, "", ErrInvalid
			}
			buf, rerr := io.ReadAll(io.LimitReader(rc, maxPreview+1))
			rc.Close()
			if rerr != nil {
				return nil, "", ErrInvalid
			}
			required = string(buf)
		}
		if !set[name] {
			set[name] = true
			order = append(order, name)
		}
	}
	sort.Strings(order)
	return order, required, nil
}

func zipExtract(data []byte, target string, maxPreview int64) (string, int64, bool, bool, bool, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return "", 0, false, false, false, ErrInvalid
	}
	for _, zf := range zr.File {
		if zf.Mode()&fs.ModeSymlink != 0 {
			return "", 0, false, false, false, ErrUnsafe
		}
		name, nerr := NormalizePath(zf.Name)
		if nerr != nil || name == "" || strings.HasSuffix(zf.Name, "/") {
			continue
		}
		if name != target {
			continue
		}
		size := int64(zf.UncompressedSize64)
		if size > maxPreview {
			return "", size, true, false, true, nil
		}
		rc, rerr := zf.Open()
		if rerr != nil {
			return "", size, true, false, false, ErrInvalid
		}
		// 声明大小可伪造(小声明+高压缩比 = zip 炸弹):按实际解压字节设
		// 硬上限,超出即按 tooLarge 返回——与 zipList 的 LimitReader 一致
		// (2026-09-01 审计:此前信任 UncompressedSize64,管理端预览 OOM)。
		buf, rerr := io.ReadAll(io.LimitReader(rc, maxPreview+1))
		rc.Close()
		if rerr != nil {
			return "", size, true, false, false, ErrInvalid
		}
		if int64(len(buf)) > maxPreview {
			return "", int64(len(buf)), true, false, true, nil
		}
		if !utf8.Valid(buf) {
			return "", size, true, true, false, nil
		}
		return string(buf), size, true, false, false, nil
	}
	return "", 0, false, false, false, nil
}

// ---- tar.gz implementation (legacy format, still accepted) ----

func validateTar(data []byte, lim Limits) error {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return ErrUnsafe
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	var total int64
	entries := 0
	hasRequired := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return ErrUnsafe
		}
		entries++
		if entries > lim.MaxEntries {
			return ErrTooMany
		}
		name, err := NormalizePath(hdr.Name)
		if err != nil {
			return ErrUnsafe
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return ErrUnsafe
		}
		if name == "" {
			return ErrUnsafe
		}
		total += hdr.Size
		if total > lim.MaxUnpackedBytes {
			return ErrInvalid
		}
		if name == lim.RequiredFile {
			hasRequired = true
		}
	}
	if !hasRequired {
		return ErrNoRequired
	}
	return nil
}

func tarList(data []byte, lim Limits, maxPreview int64) ([]string, string, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, "", ErrUnsafe
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	set := map[string]bool{}
	var required string
	var order []string
	entries := 0
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", ErrUnsafe
		}
		entries++
		if entries > lim.MaxEntries {
			return nil, "", ErrTooMany
		}
		if hdr.Typeflag == tar.TypeDir || hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		name, err := NormalizePath(hdr.Name)
		if err != nil {
			return nil, "", ErrUnsafe
		}
		if name == "" {
			continue
		}
		if name == lim.RequiredFile && required == "" && hdr.Size <= maxPreview {
			buf := make([]byte, hdr.Size)
			if _, err := io.ReadFull(tr, buf); err != nil {
				return nil, "", ErrUnsafe
			}
			required = string(buf)
		}
		if !set[name] {
			set[name] = true
			order = append(order, name)
		}
	}
	sort.Strings(order)
	return order, required, nil
}

func tarExtract(data []byte, target string, maxPreview int64) (string, int64, bool, bool, bool, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", 0, false, false, false, ErrUnsafe
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, herr := tr.Next()
		if herr == io.EOF {
			break
		}
		if herr != nil {
			return "", 0, false, false, false, ErrUnsafe
		}
		if hdr.Typeflag == tar.TypeDir || hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		name, nerr := NormalizePath(hdr.Name)
		if nerr != nil || name == "" {
			continue
		}
		if name != target {
			continue
		}
		size := hdr.Size
		if size > maxPreview {
			return "", size, true, false, true, nil
		}
		buf := make([]byte, size)
		if _, err := io.ReadFull(tr, buf); err != nil {
			return "", size, true, false, false, ErrUnsafe
		}
		if !utf8.Valid(buf) {
			return "", size, true, true, false, nil
		}
		return string(buf), size, true, false, false, nil
	}
	return "", 0, false, false, false, nil
}

// NormalizePath normalizes an archive entry path and refuses absolute paths
// and parent traversal. The returned path is "" for the pack root itself
// (`./`), which is structural and safe.
func NormalizePath(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	// 绝对路径(正斜杠/反斜杠/Windows 盘符)在归一前拒绝——`\etc` 或
	// `C:\x` 经 ReplaceAll 与空段折叠会被静默变成相对路径放行,与客户端
	// assertSafeZipEntry 的 pre-normalize 检查对齐(2026-09-01 深挖)。
	if strings.HasPrefix(raw, "/") || strings.HasPrefix(raw, "\\") {
		return "", ErrUnsafe
	}
	if len(raw) >= 2 && isASCIILetter(raw[0]) && (raw[1] == ':') {
		return "", ErrUnsafe
	}
	parts := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
	out := make([]string, 0, len(parts))
	for _, segment := range parts {
		switch segment {
		case "", ".":
			continue
		case "..":
			return "", ErrUnsafe
		default:
			out = append(out, segment)
		}
	}
	return strings.Join(out, "/"), nil
}

// isASCIILetter reports whether b is an ASCII letter (for drive-prefix check).
func isASCIILetter(b byte) bool {
	return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

// ErrorText maps sentinels to the human-facing (Chinese) description used by
// both stores' archiveErrorMessage.
func ErrorText(err error, requiredName string, maxArchiveMB int) string {
	switch {
	case errors.Is(err, ErrNoRequired):
		return fmt.Sprintf("归档缺少 %s", requiredName)
	case errors.Is(err, ErrUnsafe):
		return "归档内容不安全(路径越界或链接文件)"
	case errors.Is(err, ErrTooMany):
		return "归档条目过多"
	case errors.Is(err, ErrInvalid):
		return fmt.Sprintf("归档过大或结构非法(上限 %dMB)", maxArchiveMB)
	default:
		return "归档校验失败"
	}
}

// ReadAll extracts every regular file from an archive into memory, bounded by
// lim (同 Validate 的安全边界:拒绝越界路径与链接项)。规范化流程需要重写
// 归档中的 SKILL.md 并重新打包,因此必须能拿到全部条目内容。
func ReadAll(data []byte, lim Limits) (map[string][]byte, error) {
	switch Format(data) {
	case "zip":
		return zipReadAll(data, lim)
	case "tar.gz":
		return tarReadAll(data, lim)
	default:
		return nil, ErrInvalid
	}
}

func zipReadAll(data []byte, lim Limits) (map[string][]byte, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, ErrInvalid
	}
	out := map[string][]byte{}
	var total int64
	entries := 0
	for _, zf := range zr.File {
		entries++
		if entries > lim.MaxEntries {
			return nil, ErrTooMany
		}
		if zf.Mode()&fs.ModeSymlink != 0 {
			return nil, ErrUnsafe
		}
		name, err := NormalizePath(zf.Name)
		if err != nil {
			return nil, ErrUnsafe
		}
		if name == "" || strings.HasSuffix(zf.Name, "/") {
			continue
		}
		rc, rerr := zf.Open()
		if rerr != nil {
			return nil, ErrInvalid
		}
		buf, rerr := io.ReadAll(io.LimitReader(rc, lim.MaxUnpackedBytes))
		rc.Close()
		if rerr != nil {
			return nil, ErrInvalid
		}
		total += int64(len(buf))
		if total > lim.MaxUnpackedBytes {
			return nil, ErrInvalid
		}
		out[name] = buf
	}
	return out, nil
}

func tarReadAll(data []byte, lim Limits) (map[string][]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, ErrInvalid
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	out := map[string][]byte{}
	var total int64
	entries := 0
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, ErrInvalid
		}
		entries++
		if entries > lim.MaxEntries {
			return nil, ErrTooMany
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return nil, ErrUnsafe
		}
		name, nerr := NormalizePath(hdr.Name)
		if nerr != nil {
			return nil, ErrUnsafe
		}
		if name == "" || hdr.Typeflag == tar.TypeDir {
			continue
		}
		buf, rerr := io.ReadAll(io.LimitReader(tr, lim.MaxUnpackedBytes))
		if rerr != nil {
			return nil, ErrInvalid
		}
		total += int64(len(buf))
		if total > lim.MaxUnpackedBytes {
			return nil, ErrInvalid
		}
		out[name] = buf
	}
	return out, nil
}

// WriteZip packs files into a deterministic zip (entry order sorted), used by
// 规范化流程重新打包归档。
func WriteZip(files map[string][]byte) ([]byte, error) {
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	sort.Strings(names)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, n := range names {
		w, err := zw.Create(n)
		if err != nil {
			return nil, err
		}
		if _, err := w.Write(files[n]); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
