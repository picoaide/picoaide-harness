// Package agentshare implements the shared-agent store: employees upload
// agent presets created in their 创造模式 (local `agent.cordis.yml`
// compositions), admins review them, and every approved preset is visible
// and installable by all employees.
package agentshare

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"
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

// ErrTooManyPending is returned when the author already holds the per-user
// pending submission cap.
var ErrTooManyPending = errors.New("too many pending submissions")

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

// safeName is the filename a stored archive uses: <name>-<version>.tar.gz
// where both segments are already validated single path segments.
func safeName(name, version string) string {
	return fmt.Sprintf("%s-%s.tar.gz", name, version)
}
