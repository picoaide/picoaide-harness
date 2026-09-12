// Package agentshare implements the shared-agent store: employees upload
// agent presets created in their 创造模式 (local `agent.cordis.yml`
// compositions), admins review them, and every approved preset is visible
// and installable by all employees.
package agentshare

import (
	"errors"
	"fmt"

	"github.com/picoaide/picoaide/internal/archiveutil"
	"github.com/picoaide/picoaide/internal/util"
)

// Archive limits: the raw archive a client may upload, and the total
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
	// ErrUnsafeArchive: an archive entry path escapes the staging root, is
	// absolute, or is a symlink/hardlink.
	ErrUnsafeArchive = errors.New("unsafe archive")
	// ErrNoComposition: the archive carries no top-level agent.cordis.yml.
	ErrNoComposition = errors.New("archive has no agent.cordis.yml at its root")
	// ErrEntryLimit: too many entries in the archive.
	ErrEntryLimit = errors.New("archive has too many entries")
	// ErrDuplicateEntry: the archive repeats an entry (case-insensitive).
	ErrDuplicateEntry = errors.New("archive has duplicate entries")
)

// presetLimits: 校验边界(zip 推荐 / tar.gz 兼容)。
var presetLimits = archiveutil.Limits{
	MaxArchiveBytes:  MaxArchiveBytes,
	MaxUnpackedBytes: MaxUnpackedBytes,
	MaxEntries:       MaxArchiveEntries,
	RequiredFile:     "agent.cordis.yml",
}

// ValidatePresetArchive lists an archive without extracting it, refusing
// unsafe entries, bounding size/entry count, and requiring a top-level
// agent.cordis.yml. Returns the archive's sha256 hex.
// The caller owns `data`; this function never buffers more than one entry.
func ValidatePresetArchive(data []byte) (string, error) {
	checksum, err := archiveutil.Validate(data, presetLimits)
	switch {
	case errors.Is(err, archiveutil.ErrNoRequired):
		return "", ErrNoComposition
	case errors.Is(err, archiveutil.ErrUnsafe):
		return "", ErrUnsafeArchive
	case errors.Is(err, archiveutil.ErrTooMany):
		return "", ErrEntryLimit
	case errors.Is(err, archiveutil.ErrDuplicateEntry):
		return "", ErrDuplicateEntry
	case errors.Is(err, archiveutil.ErrInvalid):
		return "", ErrArchiveTooLarge
	default:
		return checksum, err
	}
}

// ListArchiveContents lists every non-directory entry path (sorted, unique)
// and returns the top-level agent.cordis.yml content for admin review.
// @param data - a previously validated archive; the caller owns the bytes.
func ListArchiveContents(data []byte) ([]string, string, error) {
	return archiveutil.ListContents(data, presetLimits, maxFilePreviewBytes)
}

// maxFilePreviewBytes caps the inline text returned by the per-file review
// endpoint; larger files are flagged for archive download instead.
const maxFilePreviewBytes = 1 << 20

// ExtractFileContent finds one archive entry by normalized path and returns
// its text content. Binary (non-UTF-8) and oversized entries return flags
// instead of payload; the caller decides how to present them.
func ExtractFileContent(data []byte, target string) (content string, size int64, found, binary, tooLarge bool, err error) {
	return archiveutil.ExtractFileContent(data, target, maxFilePreviewBytes)
}

// safeName is the filename a stored archive uses: <name>-<version>.tar.gz
// where both segments are already validated single path segments. 注意:
// 旧磁盘回退文件与 pre-0041 行沿用 tar.gz 名;zip 存档下载时由调用方按
// 格式嗅探生成 <name>-<version>.zip 响应名。
//
// 审计 2026-09-12(纵深防御):本函数此前无条件拼接两个入参,只靠"调用方已
// 校验 / 值来自 DB"这一约定 —— 与姊妹实现 sharedskills.safeName 的显式校验
// 不对称。约定一旦在某条新路径上失守,拼出的就是可越出 cacheDir 的路径
// (filepath.Join(cacheDir, "../../etc/passwd-1.tar.gz"))。
//
// 这里补上与 sharedskills 同级的守卫:非法段返回空串,调用方 os.ReadFile("")
// 直接失败 → 404/500,而不是读到目录外的文件。纯读路径(3 处 Download/
// Preview)行为不变:`..` 段在到达本函数前已被 presetIDRe/versionRe 拒绝,
// 且任何情况下 DB 里的 name/version 都通过了同一套正则。
func safeName(name, version string) string {
	if !util.SafePathSegment(name) || !util.SafePathSegment(version) {
		return ""
	}
	return fmt.Sprintf("%s-%s.tar.gz", name, version)
}
