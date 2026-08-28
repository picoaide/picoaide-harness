// Package agentshare implements the shared-agent store: employees upload
// agent presets created in their 创造模式 (local `agent.cordis.yml`
// compositions), admins review them, and every approved preset is visible
// and installable by all employees.
package agentshare

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

// Archive limits: the raw gzipped tar a client may upload, and the total
// unpacked tree size (both ceilings, not quotas).
const (
	MaxArchiveBytes   = 16 << 20
	MaxUnpackedBytes  = 64 << 20
	MaxArchiveEntries = 10000
	MaxBodyBytes      = 24 << 20 // base64 inflates ~33%; bound the request body above the raw limit
)

var (
	// ErrArchiveTooLarge: the raw archive exceeds MaxArchiveBytes.
	ErrArchiveTooLarge = errors.New("archive too large")
	// ErrUnsafeArchive: a tar entry path escapes the staging root, is
	// absolute, or is a symlink/hardlink.
	ErrUnsafeArchive = errors.New("unsafe archive")
	// ErrNoComposition: the archive carries no top-level agent.cordis.yml.
	ErrNoComposition = errors.New("archive has no agent.cordis.yml at its root")
	// ErrEntryLimit: too many entries in the archive.
	ErrEntryLimit = errors.New("archive has too many entries")
)

// linkTypes are tar entry types refused from an uploaded preset. A preset is
// composition text plus optional sibling assets; links would let an archive
// smuggle a reference to a file outside its own tree.
var linkTypes = map[byte]bool{
	tar.TypeSymlink: true,
	tar.TypeLink:    true,
}

// posixNormalize normalizes a tar entry path (tar paths are always posix)
// and refuses absolute paths and parent traversal. The returned path is "" for
// the pack root itself (`./`), which is structural and safe.
func posixNormalize(raw string) (string, error) {
	if raw == "" {
		return "", nil
	}
	if strings.HasPrefix(raw, "/") {
		return "", ErrUnsafeArchive
	}
	parts := strings.Split(strings.ReplaceAll(raw, "\\", "/"), "/")
	out := make([]string, 0, len(parts))
	for _, segment := range parts {
		switch segment {
		case "", ".":
			continue
		case "..":
			return "", ErrUnsafeArchive
		default:
			out = append(out, segment)
		}
	}
	return strings.Join(out, "/"), nil
}

// ValidatePresetArchive lists a gzipped tar stream without extracting it,
// refusing unsafe entries, bounding size/entry count, and requiring a
// top-level agent.cordis.yml. Returns the archive's sha256 hex.
// The caller owns `data`; this function never buffers more than one entry.
func ValidatePresetArchive(data []byte) (string, error) {
	if len(data) == 0 {
		return "", ErrArchiveTooLarge
	}
	if len(data) > MaxArchiveBytes {
		return "", ErrArchiveTooLarge
	}
	sum := sha256.Sum256(data)
	hexSum := hex.EncodeToString(sum[:])

	zr, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return "", ErrUnsafeArchive
	}
	tr := tar.NewReader(zr)
	var total int64
	entries := 0
	hasComposition := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", ErrUnsafeArchive
		}
		entries++
		if entries > MaxArchiveEntries {
			return "", ErrEntryLimit
		}
		name, err := posixNormalize(hdr.Name)
		if err != nil {
			return "", err
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if linkTypes[hdr.Typeflag] {
			return "", ErrUnsafeArchive
		}
		if name == "" {
			return "", ErrUnsafeArchive
		}
		// Structural size bound: the sum of every non-directory entry.
		total += hdr.Size
		if total > MaxUnpackedBytes {
			return "", ErrArchiveTooLarge
		}
		if name == "agent.cordis.yml" {
			hasComposition = true
		}
	}
	if !hasComposition {
		return "", ErrNoComposition
	}
	return hexSum, nil
}

// ListArchiveContents lists every non-directory entry path (sorted, unique)
// and returns the top-level agent.cordis.yml content for admin review.
// @param data - a previously validated archive; the caller owns the bytes.
func ListArchiveContents(data []byte) ([]string, string, error) {
	zr, err := gzip.NewReader(strings.NewReader(string(data)))
	if err != nil {
		return nil, "", ErrUnsafeArchive
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	set := map[string]bool{}
	var composition string
	var order []string
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, "", ErrUnsafeArchive
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		name, err := posixNormalize(hdr.Name)
		if err != nil {
			return nil, "", ErrUnsafeArchive
		}
		if name == "" || linkTypes[hdr.Typeflag] {
			continue
		}
		if name == "agent.cordis.yml" && composition == "" {
			buf := make([]byte, hdr.Size)
			if hdr.Size > 1<<20 { // cap composition preview at 1MB
				continue
			}
			if _, err := io.ReadFull(tr, buf); err != nil {
				return nil, "", ErrUnsafeArchive
			}
			composition = string(buf)
		}
		if !set[name] {
			set[name] = true
			order = append(order, name)
		}
	}
	sort.Strings(order)
	// Ensure the composition is always present in the file list.
	if _, ok := set["agent.cordis.yml"]; !ok {
		order = append(order, "agent.cordis.yml")
		sort.Strings(order)
	}
	return order, composition, nil
}

// maxFilePreviewBytes caps the inline text returned by the per-file review
// endpoint; larger files are flagged for archive download instead.
const maxFilePreviewBytes = 1 << 20

// ExtractFileContent finds one archive entry by normalized path and returns
// its text content. Binary (non-UTF-8) and oversized entries return flags
// instead of payload; the caller decides how to present them.
func ExtractFileContent(data []byte, target string) (content string, size int64, found, binary, tooLarge bool, err error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return "", 0, false, false, false, ErrUnsafeArchive
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, herr := tr.Next()
		if herr == io.EOF {
			break
		}
		if herr != nil {
			return "", 0, false, false, false, ErrUnsafeArchive
		}
		if hdr.Typeflag == tar.TypeDir || linkTypes[hdr.Typeflag] {
			continue
		}
		name, nerr := posixNormalize(hdr.Name)
		if nerr != nil || name == "" {
			continue
		}
		if name != target {
			continue
		}
		size = hdr.Size
		if hdr.Size > maxFilePreviewBytes {
			return "", size, true, false, true, nil
		}
		buf := make([]byte, hdr.Size)
		if _, err := io.ReadFull(tr, buf); err != nil {
			return "", size, true, false, false, ErrUnsafeArchive
		}
		if !utf8.Valid(buf) {
			return "", size, true, true, false, nil
		}
		return string(buf), size, true, false, false, nil
	}
	return "", 0, false, false, false, nil
}

// safeName is the filename a stored archive uses: <name>-<version>.tar.gz
// where both segments are already validated single path segments.
func safeName(name, version string) string {
	return fmt.Sprintf("%s-%s.tar.gz", name, version)
}
