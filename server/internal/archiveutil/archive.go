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

// 包内默认边界(16MB 原始 / 64MB 解包 / 10000 条目)。这是全仓唯一的一份数字:
// sharedskills 与 agentshare 的 ArchiveLimits() 都从这里取,不各自硬编码。
const (
	// MaxArchiveBytes: raw archive size cap.
	MaxArchiveBytes = 16 << 20
	// MaxUnpackedBytes: total unpacked payload cap.
	MaxUnpackedBytes = 64 << 20
	// MaxArchiveEntries: entry-count cap.
	MaxArchiveEntries = 10000
)

// DefaultLimits 返回包内默认边界(requiredFile 由调用方给出)。
//
// ExtractFileContent 的签名没有 Limits 参数(调用方只关心预览上限),但它必须
// **扫完整个归档**才能发现位于目标之后的重复条目,所以 tar 分支在函数内用这套
// 默认边界给自己封顶(2026-09-13:为查重改成全量遍历后曾一次上限都没有,
// 10 万条目实测 372ms,且归档来自上传者,条目数可任意)。
func DefaultLimits(requiredFile string) Limits {
	return Limits{
		MaxArchiveBytes:  MaxArchiveBytes,
		MaxUnpackedBytes: MaxUnpackedBytes,
		MaxEntries:       MaxArchiveEntries,
		RequiredFile:     requiredFile,
	}
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
	// ErrDuplicateEntry: the archive contains the same (normalized,
	// case-insensitive) entry path more than once. 服务端取第一个匹配条目、
	// 客户端按序写盘最后一个生效 → 审核看到的内容 ≠ 员工安装的内容,
	// 双 SKILL.md 可夹带(P2-11),因此一律拒绝。
	ErrDuplicateEntry = errors.New("archive has duplicate entries")
	// ErrCorrupt: 必填条目的解压/CRC 校验失败(声明尺寸与真实字节不符、
	// deflate 流损坏)。客户端安装必抛,上传闸门必须先拒(archupd-3)。
	ErrCorrupt = errors.New("archive entry is corrupt")
	// ErrPathConflict: 同一(归一化、大小写不敏感)路径既是文件又是目录
	// (SKILL.md 与 SKILL.md/child) —— 客户端解包必抛 EISDIR。
	ErrPathConflict = errors.New("archive path is both a file and a directory")
)

// dupEntrySet 记录已见条目名(按 installerKey 归一:大小写/尾随点空格/
// NTFS $UpCase 危险折叠都视为同一路径)。值是该键**第一次**出现时的原样
// 条目名 —— F2-N7:拒绝时必须能告诉上传者是哪两个名字被判成了同一个文件
// (如 aſb.txt 与 asb.txt),否则用户无从改名。
type dupEntrySet map[string]string

// add 记录一个条目名;与已见条目在安装端等价即返回 *DuplicateEntryError
// (errors.Is(err, ErrDuplicateEntry) 为真,同时携带两个冲突名字)。
func (s dupEntrySet) add(name string) error {
	key := installerKey(name)
	if first, ok := s[key]; ok {
		return &DuplicateEntryError{First: first, Second: name}
	}
	s[key] = name
	return nil
}

// DuplicateEntryError 指出归档里被判为「同一个文件」的两个条目名。
//
// installerKey 是**宁严勿宽**的安装端等价键:大小写、尾随点/空格、NTFS
// 危险折叠(NTFS/macOS 上 aſb.txt 与 asb.txt 是同一个文件)全都算重复。
// 代价是大小写敏感文件系统(ext4/APFS 大小写敏感)上合法的一对文件会被
// 误杀 —— 这是有意的取舍,但错误信息必须把两个名字都列出来,让作者能改名
// (F2-N7);只说「归档含重复条目」的话,用户根本不知道该改哪个。
type DuplicateEntryError struct {
	First  string // 先出现的条目名
	Second string // 与它等价的另一个条目名
}

func (e *DuplicateEntryError) Error() string {
	return fmt.Sprintf("archive has duplicate entries: %q and %q map to the same file", e.First, e.Second)
}

// Unwrap 让 errors.Is(err, ErrDuplicateEntry) 继续成立(调用方既有映射不变)。
func (e *DuplicateEntryError) Unwrap() error { return ErrDuplicateEntry }

// DuplicateEntryNames 从错误链里取出被判重复的两个条目名(供 HTTP 层
// 回显给上传者)。第二个返回值为 false 时表示错误里没有名字(旧路径)。
func DuplicateEntryNames(err error) (first, second string, ok bool) {
	var de *DuplicateEntryError
	if errors.As(err, &de) {
		return de.First, de.Second, true
	}
	return "", "", false
}

// ntfsDangerousFold 是 NTFS $UpCase 里与 Unicode 简单小写不同的危险映射
// (Go/JS 的 ToLower 都不做这一步):这些码位在 Windows/macOS 上会折成 ASCII
// 字母,与同目录下的 ASCII 名落进同一个文件。
var ntfsDangerousFold = map[rune]rune{
	0x017F: 's', // ſ LATIN SMALL LETTER LONG S
	0x0131: 'i', // ı LATIN SMALL LETTER DOTLESS I
	0x212A: 'k', // K KELVIN SIGN
}

// installerKey 计算「安装端文件系统等价键」,用于查重与文件/目录冲突判定:
//
//  1. Unicode 简单小写(Go 的 strings.ToLower 是逐码位简单映射,与 JS
//     toLowerCase 在常见输入上一致);
//  2. NTFS $UpCase 危险折叠(ſ→s、ı→i、K→k);
//  3. 每个路径分量去掉结尾的点与空格(Win32 路径归一化会剥离,
//     `SKILL.md.` 与 `SKILL.md` 在 Windows 上落到同一个文件)。
//
// 为什么不只做 ToLower:审"两个实现必须一致"的防线时,运行环境也是实现之一。
// 服务端按 ToLower 判"不同名",客户端按序写盘,而 Windows/macOS 的文件系统
// 把两者当成同一个文件 —— 审核所见(良性 SKILL.md)≠ 员工所装(末条 EVIL)。
// 完整的 NTFS $UpCase 表与真实 Win32 行为未建(本容器无法执行验证,见
// TASKS.md 记录),但服务端**宁严勿宽**:凡在安装端可能等价的路径一律拒绝,
// 客户端侧的同款防线(archive-util.ts assertNoDuplicateEntry)需要同一份口径。
func installerKey(name string) string {
	lowered := strings.ToLower(name)
	parts := strings.Split(lowered, "/")
	var b strings.Builder
	b.Grow(len(lowered))
	for i, part := range parts {
		if i > 0 {
			b.WriteByte('/')
		}
		trimmed := strings.TrimRight(part, ". ")
		for _, r := range trimmed {
			if folded, ok := ntfsDangerousFold[r]; ok {
				r = folded
			}
			b.WriteRune(r)
		}
	}
	return b.String()
}

// pathKinds 记录每个(小写归一)路径的角色:显式目录条目、普通文件条目,
// 以及被「a/b」这类子条目隐含为目录的祖先路径。archupd-3:zip 里只有
// 「SKILL.md」与「SKILL.md/child.md」两个文件条目、没有任何 "SKILL.md/"
// 目录条目时,同一路径已经既是文件又是目录,客户端解包必抛 EISDIR ——
// 只查「同名条目重复」的旧实现完全看不见这种冲突。
type pathKinds struct {
	files map[string]bool // 普通文件条目路径
	dirs  map[string]bool // 目录条目路径 + 由子条目隐含的祖先路径
}

func newPathKinds() *pathKinds {
	return &pathKinds{files: map[string]bool{}, dirs: map[string]bool{}}
}

// add 记录一个条目;返回 ErrPathConflict 表示该路径已作为另一种角色出现。
func (k *pathKinds) add(name string, isDir bool) error {
	key := installerKey(name)
	if isDir {
		if k.files[key] {
			return ErrPathConflict
		}
		k.dirs[key] = true
		return nil
	}
	if k.dirs[key] {
		return ErrPathConflict
	}
	// 祖先路径一旦被登记为文件,本条目就把该文件同时当成了目录。
	for _, ancestor := range ancestorPaths(key) {
		if k.files[ancestor] {
			return ErrPathConflict
		}
		k.dirs[ancestor] = true
	}
	k.files[key] = true
	return nil
}

// ancestorPaths 返回 path 的全部上级路径(不含自身)。
func ancestorPaths(path string) []string {
	var out []string
	for i := 0; i < len(path); i++ {
		if path[i] == '/' && i > 0 {
			out = append(out, path[:i])
		}
	}
	return out
}

// checkZipDuplicates 扫描 zip 条目头,拒绝重复的非目录条目(不解压),
// 并拒绝「同一路径既是文件又是目录」的归档。
func checkZipDuplicates(zr *zip.Reader) error {
	seen := dupEntrySet{}
	kinds := newPathKinds()
	for _, zf := range zr.File {
		isDir := strings.HasSuffix(zf.Name, "/")
		name, err := NormalizePath(zf.Name)
		if err != nil || name == "" {
			continue // 越界/空名交由各路径原有的 ErrUnsafe 处理
		}
		if err := kinds.add(name, isDir); err != nil {
			return err
		}
		if isDir {
			continue // 目录条目不携带内容
		}
		if err := seen.add(name); err != nil {
			return err
		}
	}
	return nil
}

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
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return ErrInvalid
	}
	// P2-11:重复条目(含大小写碰撞)一律拒绝
	if err := checkZipDuplicates(zr); err != nil {
		return err
	}
	hasRequired := false
	// F2-N6:逐个条目完整解压校 CRC,而不是只查必填文件 —— 非必填条目损坏
	// (references/broken.md 之类)此前能 201 上传、审核通过,员工安装时才抛
	// BAD_CRC(故障落在最远端)。
	//
	// 预算按**实际解压字节**累计(walkZip 里的 UncompressedSize64 是声明值,
	// 上传者可撒谎成 0):总额以 lim.MaxUnpackedBytes 封顶,于是「一万个条目
	// 各声明 0 字节、实际各解压 64MiB」不会变成无界 CPU —— 一旦真实解压总量
	// 超限即 ErrInvalid。合法归档的总解压量本来就被 walkZip 的声明值检查
	// 限制在同一上限内,所以不会误伤。
	budget := lim.MaxUnpackedBytes
	err = walkZip(data, lim, func(zf *zip.File, name string, isDir bool, mode fs.FileMode) (bool, error) {
		// archupd-5:符号链接检查必须在 isDir 之前 —— 「名字以 / 结尾、模式
		// 却是 S_IFLNK」的条目被 zipList/zipExtract/zipReadAll 判 ErrUnsafe,
		// 旧 Validate 把 isDir 分支放在前面,于是同一份归档「上传放行、
		// 预览/解包拒绝」。四个入口必须给出一致结论。
		if mode&fs.ModeSymlink != 0 {
			return false, ErrUnsafe
		}
		if isDir {
			return true, nil
		}
		if name == "" {
			return false, ErrUnsafe
		}
		if name == lim.RequiredFile {
			hasRequired = true
		}
		n, verr := verifyZipEntry(zf, budget)
		if verr != nil {
			return false, verr
		}
		budget -= n
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

// verifyZipEntry 完整解压一个条目(内容丢弃)以触发 CRC/deflate 校验,返回
// **实际**解压字节数。读取量以 remaining+1 封顶:连 remaining 字节都读得完
// 说明该条目超过了整个归档剩余的解压预算(声明尺寸不可信),按 ErrInvalid 拒绝。
func verifyZipEntry(zf *zip.File, remaining int64) (int64, error) {
	rc, err := zf.Open()
	if err != nil {
		return 0, ErrCorrupt
	}
	defer rc.Close()
	n, err := io.CopyN(io.Discard, rc, remaining+1)
	if err != nil && !errors.Is(err, io.EOF) {
		return n, ErrCorrupt
	}
	if n > remaining {
		return n, ErrInvalid
	}
	return n, nil
}

// readZipEntry 解压一个条目,返回前 maxPreview 字节与**真实**解压长度。
//
// archupd-1/archupd-4:zip 头里的 UncompressedSize64 是上传者可任意伪造的
// 声明值。按声明值决定「要不要读原文」会让任何真实超过预览上限的编排静默
// 降级成空串(err=nil,审核面变瞎);按声明值回 size 会让逐文件审核接口报出
// 假长度。长度一律以实际解压字节为准;超过 maxPreview 时继续读到条目末尾
// 取真实长度(上限 MaxUnpackedBytes)。
func readZipEntry(zf *zip.File, maxPreview int64) (head []byte, size int64, tooLarge bool, err error) {
	rc, err := zf.Open()
	if err != nil {
		return nil, 0, false, err
	}
	defer rc.Close()
	head, err = io.ReadAll(io.LimitReader(rc, maxPreview+1))
	if err != nil {
		return nil, 0, false, err
	}
	if int64(len(head)) > maxPreview {
		rest, cerr := io.Copy(io.Discard, io.LimitReader(rc, MaxUnpackedBytes))
		if cerr != nil {
			return nil, 0, false, cerr
		}
		return nil, int64(len(head)) + rest, true, nil
	}
	return head, int64(len(head)), false, nil
}

func zipList(data []byte, lim Limits, maxPreview int64) ([]string, string, error) {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, "", ErrInvalid
	}
	// P2-11:重复条目(含大小写碰撞)一律拒绝——否则「列表/预览」与
	// 客户端按序解压的最后一个条目可能不是同一个文件。
	if err := checkZipDuplicates(zr); err != nil {
		return nil, "", err
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
		// archupd-1:必填文件是否可读、长度多少,只看真实解压结果,不看声明值。
		if name == lim.RequiredFile && required == "" {
			buf, _, tooLarge, rerr := readZipEntry(zf, maxPreview)
			if rerr != nil {
				return nil, "", ErrCorrupt
			}
			if !tooLarge {
				required = string(buf)
			}
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
	// P2-11:重复条目(含大小写碰撞)一律拒绝,不取「第一个匹配」——
	// 客户端按序解压最后一个生效,审核内容必须与安装内容一致。
	if err := checkZipDuplicates(zr); err != nil {
		return "", 0, false, false, false, err
	}
	// archupd-5:符号链接条目一律拒绝,且必须在命中目标之前检查 ——
	// 「命中即返回」会让排在目标之后的链接条目逃过检查,结论随条目顺序变化。
	for _, zf := range zr.File {
		if zf.Mode()&fs.ModeSymlink != 0 {
			return "", 0, false, false, false, ErrUnsafe
		}
	}
	for _, zf := range zr.File {
		name, nerr := NormalizePath(zf.Name)
		if nerr != nil || name == "" || strings.HasSuffix(zf.Name, "/") {
			continue
		}
		if name != target {
			continue
		}
		// archupd-4:size 必须是真实解压长度(声明值可伪造:HTTP 200
		// size=1048576 而真实内容 56 字节会把审核人引向错误的结论)。
		buf, size, tooLarge, rerr := readZipEntry(zf, maxPreview)
		if rerr != nil {
			// archupd-4:声明尺寸与真实字节不符(可伪造)时明确报损坏,
			// 绝不把伪造的声明值当成 size 返回给审核面。
			return "", size, true, false, false, ErrCorrupt
		}
		if tooLarge {
			return "", size, true, false, true, nil
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
	// FIX-24(审计 2026-09-12,P1-6):tar.gz 分支此前**完全没有**重复条目检查,
	// 而 zip 分支有(checkZipDuplicates,三个入口都调)。后果是同一份归档在
	// 四个入口里给出**两个不同的 SKILL.md**:
	//
	//	Validate     → nil(审核通过)
	//	ListContents → 预览 = benign(第一个命中)
	//	tarExtract   → benign(命中即返回)
	//	tarReadAll   → EVIL(末条覆盖 → 安装/重打包产物)
	//
	// 即「审核所见 ≠ 员工所装」。语义与 zip 完全对齐:同一(归一化、大小写
	// 不敏感)路径出现两次即 ErrDuplicateEntry;目录条目不携带内容,不计入。
	seen := dupEntrySet{}
	kinds := newPathKinds()
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
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			return ErrUnsafe
		}
		isDir := hdr.Typeflag == tar.TypeDir
		if name == "" {
			if isDir {
				continue
			}
			return ErrUnsafe
		}
		// archupd-3:与 zip 侧同口径 —— 同一路径既是文件又是目录即拒。
		if err := kinds.add(name, isDir); err != nil {
			return err
		}
		if isDir {
			continue
		}
		if err := seen.add(name); err != nil {
			return err
		}
		total += hdr.Size
		if total > lim.MaxUnpackedBytes {
			return ErrInvalid
		}
		if name == lim.RequiredFile {
			hasRequired = true
		}
		// archupd-3(tar 侧)/ F2-N6:每个非目录条目都完整读一遍,gzip/deflate
		// 损坏(含条目内容与 CRC 不匹配)在上传期暴露,而不是等员工安装时才炸。
		// tar 头部的 Size 是权威值(外层 gzip 只负责压缩),上面的 total 已按它
		// 封顶,因此这里不会引入额外的无界解压。
		if _, cerr := io.CopyN(io.Discard, tr, hdr.Size+1); cerr != nil && !errors.Is(cerr, io.EOF) {
			return ErrCorrupt
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
	// FIX-24:与 zipList 的 checkZipDuplicates 同语义 —— 重复条目一律拒绝,
	// 不做"第一个生效"的静默挑选。四个入口必须给出一致的结论。
	seen := dupEntrySet{}
	kinds := newPathKinds()
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
		name, err := NormalizePath(hdr.Name)
		if err != nil {
			return nil, "", ErrUnsafe
		}
		if name == "" {
			continue
		}
		if hdr.Typeflag == tar.TypeDir {
			// archupd-3:与 zip 侧同口径 —— 同一路径既是文件又是目录即拒。
			if err := kinds.add(name, true); err != nil {
				return nil, "", err
			}
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		if err := kinds.add(name, false); err != nil {
			return nil, "", err
		}
		if err := seen.add(name); err != nil {
			return nil, "", err
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
	// FIX-24:与 zipExtract 的 checkZipDuplicates 同语义 —— 重复条目一律拒绝,
	// 而不是"命中第一个就返回"。
	//
	// 注意必须**扫完整个归档**才能返回命中结果:tar 没有 zip 那种只读条目头
	// 的廉价预扫,而"命中即 return"会让位于目标**之后**的重复条目逃过检查
	// (双 SKILL.md 时预览 benign、tarReadAll 却是 EVIL —— 正是本条审计的
	// 现场)。归档有 MaxEntries/MaxUnpackedBytes 上限,完整扫描代价可控。
	//
	// 2026-09-13(复核残留 2):上面那句"归档有上限"必须由**本函数自己**保证
	// —— 此前这里一个计数都没有(改全量遍历时只加了查重),任何跳过 Validate
	// 直接调 ExtractFileContent 的调用方都会继承一次无界扫描。口径与
	// validateTar/tarReadAll 同源:包内默认 MaxArchiveEntries /
	// MaxUnpackedBytes,越界即拒(目录/链接条目不计体积,与 validateTar 一致)。
	seen := dupEntrySet{}
	kinds := newPathKinds()
	var (
		outContent string
		outSize    int64
		outFound   bool
		outBinary  bool
		outTooBig  bool
	)
	entries := 0
	var total int64
	for {
		hdr, herr := tr.Next()
		if herr == io.EOF {
			break
		}
		if herr != nil {
			return "", 0, false, false, false, ErrUnsafe
		}
		entries++
		if entries > MaxArchiveEntries {
			return "", 0, false, false, false, ErrTooMany
		}
		name, nerr := NormalizePath(hdr.Name)
		if nerr != nil || name == "" {
			continue
		}
		if hdr.Typeflag == tar.TypeDir {
			if derr := kinds.add(name, true); derr != nil {
				return "", 0, false, false, false, derr
			}
			continue
		}
		if hdr.Typeflag == tar.TypeSymlink || hdr.Typeflag == tar.TypeLink {
			continue
		}
		if derr := kinds.add(name, false); derr != nil {
			return "", 0, false, false, false, derr
		}
		if derr := seen.add(name); derr != nil {
			return "", 0, false, false, false, derr
		}
		total += hdr.Size
		if total > MaxUnpackedBytes {
			return "", 0, false, false, false, ErrInvalid
		}
		if name != target || outFound {
			continue
		}
		size := hdr.Size
		switch {
		case size > maxPreview:
			outSize, outFound, outTooBig = size, true, true
		default:
			buf := make([]byte, size)
			if _, err := io.ReadFull(tr, buf); err != nil {
				return "", size, true, false, false, ErrUnsafe
			}
			outSize, outFound = size, true
			if !utf8.Valid(buf) {
				outBinary = true
			} else {
				outContent = string(buf)
			}
		}
	}
	if !outFound {
		return "", 0, false, false, false, nil
	}
	return outContent, outSize, true, outBinary, outTooBig, nil
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
	case errors.Is(err, ErrDuplicateEntry):
		return "归档含重复条目(同一文件出现多次,大小写不敏感)"
	case errors.Is(err, ErrCorrupt):
		return "归档内容损坏(必填文件解压或校验失败)"
	case errors.Is(err, ErrPathConflict):
		return "归档中同一路径既是文件又是目录"
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
	// FIX-24 残留 1(审计 2026-09-13):四个入口口径一致 —— 这里此前是唯一
	// 不查重的入口(Validate/zipList/zipExtract 都调 checkZipDuplicates),
	// 双 SKILL.md 的 zip 在 ReadAll 里返回末条覆盖的 EVIL 且 err=nil。复用
	// 同一个 checkZipDuplicates,不写第二份实现。
	if err := checkZipDuplicates(zr); err != nil {
		return nil, err
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
	// FIX-24:重复条目一律拒绝。这是审计里"审核所见 ≠ 安装产物"的**直接**
	// 现场 —— `out[name] = buf` 是末条覆盖,而 tarList/tarExtract 取第一条,
	// 于是双 SKILL.md 的归档在审核页显示 benign、在 ReadAll(市场规范化重
	// 打包)里是 EVIL。
	seen := dupEntrySet{}
	kinds := newPathKinds()
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
			if name != "" {
				if derr := kinds.add(name, true); derr != nil {
					return nil, derr
				}
			}
			continue
		}
		if derr := kinds.add(name, false); derr != nil {
			return nil, derr
		}
		if derr := seen.add(name); derr != nil {
			return nil, derr
		}
		buf, rerr := io.ReadAll(io.LimitReader(tr, lim.MaxUnpackedBytes))
		if rerr != nil {
			return nil, ErrInvalid
		}
		total += int64(len(buf))
		if total > lim.MaxUnpackedBytes {
			return nil, ErrInvalid
		}
		// first-wins:即使重复检查在将来被绕过(例如换成流式实现),落盘语义
		// 也必须与 tarList/tarExtract 的"第一个命中"一致,不能是末条覆盖。
		if _, exists := out[name]; !exists {
			out[name] = buf
		}
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
