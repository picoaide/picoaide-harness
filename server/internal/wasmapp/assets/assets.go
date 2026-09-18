// Package assets 实现 §5.1 的 `assets.read` 能力：读取**包内资源**。
//
// 资源的生命周期（§4.2）：发布期从 wasm 自定义段抽出到
// `<data_root>/apps/<app_id>/assets/<release_id>/`，抽取失败 = 发布失败；
// 之后宿主直接服务 + 缓存（缓存键 `app_id + version + path`），应用与宿主读**同一份**。
//
// # 为什么这里不是"文件系统能力"
//
// 关键区别在于**路径的来源与语义**（§4.4「任何宿主函数不得接受文件路径」、
// §5.1「无文件系统语义、无路径穿越」）：
//
//   - 路径是**包内逻辑路径**（作者在 wasm 自定义段里写下的资源名，如
//     `index.html`、`static/app.css`），不是宿主文件系统路径；
//   - 宿主**从不把 `path` 当路径用**：先按逻辑规则逐段校验，再拼到
//     「本应用 + 本版本」的抽取根下，最后用 EvalSymlinks + 前缀比对
//     确认解析结果仍在根内（防符号链接逃逸）。
//
// 因此应用既读不到别的应用/版本，也读不到宿主机上的任何文件。能力清单门禁
// 把 `AssetsReadParams.Path` 显式豁免为"包内逻辑路径"（见 hostcap 的无路径参数测试）。
package assets

import (
	"encoding/base64"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

const (
	// AssetsDirName 是抽取目录名（§4.2：`<data_root>/apps/<app_id>/assets/<release_id>/`）。
	AssetsDirName = "assets"
	// MaxPathBytes 是包内逻辑路径的长度上限。
	//
	// ⚠️ limits 包（本模块不可修改）没有资产路径长度常量；这个 256 是本包
	// 当前唯一的数值来源，已列入交付说明请求并入 limits（§5.5「数值单一真源」）。
	// 取值理由：任何真实资源名（含目录层级）都远小于 256 字节；给一个上限是
	// 为了让"超长路径"在拼到宿主路径之前就被拒。
	MaxPathBytes = 256
	// MaxSegmentBytes 是**单个路径段**的长度上限。
	//
	// 这不是策略而是文件系统事实：POSIX NAME_MAX = 255 字节（Linux/大多数
	// 文件系统；Windows 是 255 个 UTF-16 单元，更宽松）。不做这个检查的话，
	// 一个 256 字节的文件名会以 ENAMETOOLONG 落到 OS 层、变成一句 INTERNAL，
	// 作者看不出是自己写错了名字。
	//
	// ⚠️ 同 MaxPathBytes：limits 包（不可修改）没有对应常量，已列入交付说明。
	MaxSegmentBytes = 255
	// MaxListEntries 是 List() 的条数上限（自省/诊断用，防一次列出巨量条目）。
	//
	// ⚠️ 同上，limits 包无对应常量，已列入交付说明。
	MaxListEntries = 10000
	// tempFilePattern 是原子写的临时文件前缀（同目录内 rename，保证原子）。
	tempFilePattern = ".picoaide-tmp-*"
)

// appIDPattern 复用平台既有标识规则（§4.1）；这里只做纵深防御 —— app_id 在
// 发布链路上已经校验过，但 Store 是"拼宿主路径"的地方，必须自己再挡一次。
var appIDPattern = regexp.MustCompile(limits.AppIDPattern)

// releaseIDPattern 是抽取目录名的形态：发布版本行 id（数字）为主，允许
// `[A-Za-z0-9._-]` 以便未来改用语义化标识；不允许分隔符、不允许以点开头。
var releaseIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)

// Store 是一个「应用 + 版本」的抽取资源目录。
//
// 并发：Store 只读（Read/List）可并发使用；Write 仅发布期单写者调用。
type Store struct {
	// root 是**已解析**（EvalSymlinks）的绝对路径，末尾无分隔符。
	// 存解析后的值而不是原始入参，前缀比对才挡得住"数据根本身是符号链接"。
	root      string
	appID     string
	releaseID string
}

// Open 打开（并校验存在）某个应用版本抽取好的资源目录。
//
// root 是数据根（`<data_root>`），内部拼 `apps/<app_id>/assets/<release_id>/`。
// 目录不存在 ⇒ INTERNAL：发布期必须 `MkdirAll` 出该目录（§4.2「抽出失败 = 发布失败」），
// 走到这里说明平台状态自相矛盾，不是用户/应用的错。
//
// 纵深防御（§5.1 / §4.4，模块 H 审计 P2）：抽取目录**本身**也可能是符号链接
// （实测：`<…>/assets/9 → /etc` 会让 Store 把 `/etc` 当资源根，随后 Read("passwd")
// 真的读到宿主文件）。当前攻击者模型下造这个链需要写数据根的权限，属纵深防御，
// 但代价只有两次 realpath 判据 ——
//
//  1. `apps` / `<app_id>` / `assets` 三段逐一 Lstat，符号链接段一律拒
//     （与 Write.makeDirs 同一套段级判据：发布链路只会 MkdirAll 出真目录）；
//  2. 解析后的抽取目录必须落在解析后的 `<data_root>/apps/<app_id>/assets/` 之下
//     （与 Read.resolveExisting 同一套 realpath + 前缀判据）——
//     这一段挡的是"抽取目录自身是指向根外的链接"。
func Open(root, appID, releaseID string) (*Store, *apperr.Error) {
	if strings.TrimSpace(root) == "" {
		return nil, apperr.New(apperr.CodeInternal, "资源根目录未配置").
			WithHint("宿主启动时必须提供数据根（limits.AppsDirName 之下才是应用数据）")
	}
	if !appIDPattern.MatchString(appID) {
		return nil, apperr.Newf(apperr.CodeValidation, "非法的 app_id %q", appID).
			WithDetail("field", "app_id").
			WithHint("app_id 必须满足 " + limits.AppIDPattern)
	}
	if !releaseIDPattern.MatchString(releaseID) {
		return nil, apperr.Newf(apperr.CodeValidation, "非法的 release_id %q", releaseID).
			WithDetail("field", "release_id").
			WithHint("release_id 只允许 [A-Za-z0-9._-]，且不得以点开头（防目录穿越）")
	}
	dir := filepath.Join(root, limits.AppsDirName, appID, AssetsDirName, releaseID)
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, apperr.New(apperr.CodeInternal, "资源目录路径无法解析").WithCause(err)
	}
	// 段级判据（第 1 层）：数据根之下的三段都必须是真目录。
	if e := assertRealSegments(root, appID); e != nil {
		return nil, e
	}
	resolved, err := filepath.EvalSymlinks(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, apperr.New(apperr.CodeInternal, "资源目录不存在").
				WithDetail("app_id", appID).
				WithDetail("release_id", releaseID).
				WithHint("发布期必须先把资源抽到 <data_root>/apps/<app_id>/assets/<release_id>/，抽出失败即发布失败")
		}
		return nil, apperr.New(apperr.CodeInternal, "资源目录不可用").WithCause(err)
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return nil, apperr.New(apperr.CodeInternal, "资源目录不可用").WithCause(err)
	}
	if !st.IsDir() {
		return nil, apperr.New(apperr.CodeInternal, "资源路径不是目录").
			WithDetail("app_id", appID)
	}
	// 锚定判据（第 2 层）：解析后的目录必须仍在解析后的资源根之下。
	anchor, aerr := assetsRoot(root, appID)
	if aerr != nil {
		return nil, aerr
	}
	if !within(anchor, filepath.Clean(resolved)) {
		return nil, apperr.New(apperr.CodeAssetDenied, "资源抽取目录不在应用资源根之下").
			WithDetail("app_id", appID).
			WithDetail("release_id", releaseID).
			WithDetail("reason", "root_escaped").
			WithHint("抽取目录必须是 <data_root>/apps/<app_id>/assets/ 的**真实**子目录；" +
				"指向别处的符号链接一律拒（§5.1「无文件系统语义、无路径穿越」）")
	}
	return &Store{root: filepath.Clean(resolved), appID: appID, releaseID: releaseID}, nil
}

// assertRealSegments 逐段 Lstat `apps` / `<app_id>` / `assets`，符号链接段一律拒。
//
// 为什么不只看最终 realpath：`<data_root>/apps/<app_id>/assets` **本身**是链接时，
// 解析后的锚点会跟着链接走，"抽取目录在锚点之下"依然成立 —— 只查最终 realpath
// 挡不住这种形态。这里复用 Write.makeDirs 的段级判据（发布链路只造真目录），
// 缺失的段不算错误（Open 的调用方负责目录不存在时的报错语义）。
func assertRealSegments(root, appID string) *apperr.Error {
	cur := root
	for _, seg := range []string{limits.AppsDirName, appID, AssetsDirName} {
		cur = filepath.Join(cur, seg)
		st, err := os.Lstat(cur)
		switch {
		case err == nil:
			if st.Mode()&os.ModeSymlink != 0 {
				return apperr.New(apperr.CodeAssetDenied, "资源根路径上有符号链接段").
					WithDetail("app_id", appID).
					WithDetail("reason", "symlink_segment").
					WithHint("资源根必须是真目录：抽取目录及其父级不允许符号链接（§5.1）")
			}
			if !st.IsDir() {
				return apperr.New(apperr.CodeAssetDenied, "资源根路径上有非目录段").
					WithDetail("app_id", appID).
					WithDetail("reason", "not_a_directory")
			}
		case os.IsNotExist(err):
			// 目录还没建：Open 后续的 EvalSymlinks 会给出"资源目录不存在"的语义。
			return nil
		default:
			return apperr.New(apperr.CodeInternal, "资源根路径不可用").WithCause(err)
		}
	}
	return nil
}

// assetsRoot 返回解析后的 `<data_root>/apps/<app_id>/assets/`（Open 的锚点）。
func assetsRoot(root, appID string) (string, *apperr.Error) {
	anchor := filepath.Join(root, limits.AppsDirName, appID, AssetsDirName)
	absAnchor, err := filepath.Abs(anchor)
	if err != nil {
		return "", apperr.New(apperr.CodeInternal, "资源根路径无法解析").WithCause(err)
	}
	resolvedAnchor, err := filepath.EvalSymlinks(absAnchor)
	if err != nil {
		if os.IsNotExist(err) {
			return "", apperr.New(apperr.CodeInternal, "应用资源根不存在").
				WithDetail("app_id", appID).
				WithHint("发布期必须先把资源抽到 <data_root>/apps/<app_id>/assets/<release_id>/，抽出失败即发布失败")
		}
		return "", apperr.New(apperr.CodeInternal, "应用资源根不可用").WithCause(err)
	}
	return filepath.Clean(resolvedAnchor), nil
}

// Root 返回抽取目录的绝对路径（诊断/发布期落盘用）。
func (s *Store) Root() string { return s.root }

// AppID 返回本 Store 所属应用标识。
func (s *Store) AppID() string { return s.appID }

// Read 读取一个包内资源，返回 content-type 与原始字节。
//
// 错误语义（§7.4 + §7.4 未列出的补充码 ASSET_*；模块 H 审计 P2-3 把三个补充码接上）：
//   - 路径非法 / 越界 / 符号链接逃逸 / 资源根异常 ⇒ ASSET_DENIED（403，details.reason 系列）；
//   - 资源不存在 ⇒ NOT_FOUND（404：这是 §7.4 表里的码，语义就是"不存在"）；
//   - 单文件超过 limits.SectionTotalMaxBytes（4 MiB，与自定义段总量同源）⇒ ASSET_OVERSIZE（422）。
//
// 为什么不复用 DB_DENIED：那会把"资源路径问题"指向"SQL 语句被拒"，而错误码的
// 第一消费者是 AI（§8）—— 指错方向等于没有提示（`ASSET_*` 三个码在 apperr 里
// 早就有定义与 HTTP 映射，此前零调用点）。
//
// **不 panic、不读宿主任何其他路径**：所有失败都在本函数内闭环。
func (s *Store) Read(logicalPath string) (string, []byte, *apperr.Error) {
	full, e := s.resolveExisting(logicalPath)
	if e != nil {
		return "", nil, e
	}
	data, err := os.ReadFile(full)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil, notFound(logicalPath)
		}
		return "", nil, apperr.New(apperr.CodeInternal, "资源读取失败").WithCause(err)
	}
	if len(data) > limits.SectionTotalMaxBytes {
		return "", nil, apperr.New(apperr.CodeAssetOversize, "资源超过单文件上限").
			WithDetail("path", logicalPath).
			WithDetail("size", len(data)).
			WithDetail("max", limits.SectionTotalMaxBytes).
			WithHint("静态资源在发布期从 wasm 自定义段抽出，段总量上限与单文件上限同源")
	}
	return ContentTypeFor(logicalPath), data, nil
}

// List 返回可读资源的逻辑路径（相对抽取根、以 `/` 分隔），按字典序。
//
// 只列**真的能读到的**条目：解析后仍在根内的普通文件。目录、悬空链接、
// 指向根外的符号链接都不列出 —— 否则作者会看到一份"列得出来但读不到"的清单。
// 超过 MaxListEntries 即截断（自省用，不保证完整性）。
func (s *Store) List() []string {
	out := make([]string, 0, 32)
	_ = filepath.WalkDir(s.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			// WalkDir 的 err 只在无法读取某目录时出现：跳过该子树而不是整体失败
			// （自省接口不应因为一个坏条目就不可用）。
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if len(out) >= MaxListEntries {
			return fs.SkipAll
		}
		rel, relErr := filepath.Rel(s.root, p)
		if relErr != nil {
			return nil
		}
		logical := filepath.ToSlash(rel)
		if _, e := s.resolveExisting(logical); e != nil {
			return nil
		}
		out = append(out, logical)
		return nil
	})
	sort.Strings(out)
	return out
}

// Write 把一个资源写进抽取目录（**发布期抽取用**）。
//
// 语义：
//   - 原子：写同目录临时文件 → rename（读到半个文件的可能为零）；
//   - **拒绝覆盖**：目标已存在即拒（抽取一次；要改内容只能发新版，R25/§10.5 第 56f 项）；
//   - 自动建父目录，但**逐段建、拒绝穿越符号链接**（MkdirAll 会顺着链接建到根外）；
//   - 单文件 ≤ limits.SectionTotalMaxBytes（与段总量同源）。
func (s *Store) Write(logicalPath string, data []byte) *apperr.Error {
	cleaned, e := validateLogicalPath(logicalPath)
	if e != nil {
		return e
	}
	if len(data) > limits.SectionTotalMaxBytes {
		return apperr.New(apperr.CodeAssetOversize, "资源超过单文件上限").
			WithDetail("path", logicalPath).
			WithDetail("size", len(data)).
			WithDetail("max", limits.SectionTotalMaxBytes)
	}
	segments := strings.Split(cleaned, "/")
	base := segments[len(segments)-1]
	dir, e := s.makeDirs(segments[:len(segments)-1])
	if e != nil {
		return e
	}
	full := filepath.Join(dir, base)

	// 先以 O_EXCL 占位：这是"拒绝覆盖"的**唯一**判定点（rename 会覆盖，
	// 所以不能把存在性判断留到 rename）。
	f, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return apperr.New(apperr.CodeAssetExists, "资源已存在，抽取只写一次").
				WithDetail("path", logicalPath).
				WithDetail("reason", "already_exists").
				WithHint("改资源内容 = 发一个新版本（§10.5 第 56f 项）")
		}
		return apperr.New(apperr.CodeInternal, "资源落盘失败").WithCause(err)
	}
	tmp, err := os.CreateTemp(dir, tempFilePattern)
	if err != nil {
		f.Close()
		os.Remove(full)
		return apperr.New(apperr.CodeInternal, "临时文件创建失败").WithCause(err)
	}
	tmpName := tmp.Name()
	cleanup := func() {
		tmp.Close()
		os.Remove(tmpName)
		os.Remove(full)
	}
	if _, err := tmp.Write(data); err != nil {
		cleanup()
		return apperr.New(apperr.CodeInternal, "临时文件写入失败").WithCause(err)
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return apperr.New(apperr.CodeInternal, "临时文件同步失败").WithCause(err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		os.Remove(full)
		return apperr.New(apperr.CodeInternal, "临时文件关闭失败").WithCause(err)
	}
	// rename 覆盖掉自己刚占位的空文件；占位保证了这之间没有第三方写进来。
	if err := os.Rename(tmpName, full); err != nil {
		os.Remove(tmpName)
		os.Remove(full)
		return apperr.New(apperr.CodeInternal, "资源原子替换失败").WithCause(err)
	}
	// 占位空文件已在 rename 时被替换，无需再删。
	_ = f.Close()
	return nil
}

// makeDirs 逐段创建目录并返回最终目录的**绝对路径**。
//
// 不用 os.MkdirAll：MkdirAll 会沿已存在的符号链接一路建到根外（数据根下
// 出现一个指向 /tmp 的链接即可把后续资源写到宿主任何地方）。这里逐段
// Lstat：符号链接段一律拒。
func (s *Store) makeDirs(segs []string) (string, *apperr.Error) {
	cur := s.root
	for _, seg := range segs {
		cur = filepath.Join(cur, seg)
		st, err := os.Lstat(cur)
		switch {
		case err == nil:
			if st.Mode()&os.ModeSymlink != 0 {
				return "", pathDenied("symlink_segment", strings.Join(segs, "/")).
					WithHint("抽取目录内不允许符号链接：资源只能来自 wasm 自定义段")
			}
			if !st.IsDir() {
				return "", pathDenied("not_a_directory", strings.Join(segs, "/"))
			}
		case os.IsNotExist(err):
			if err := os.Mkdir(cur, limits.DataDirMode); err != nil && !os.IsExist(err) {
				return "", apperr.New(apperr.CodeInternal, "资源目录创建失败").WithCause(err)
			}
		default:
			return "", apperr.New(apperr.CodeInternal, "资源目录不可用").WithCause(err)
		}
	}
	return cur, nil
}

// resolveExisting 校验逻辑路径并返回**已确认仍在抽取根内**的绝对路径。
func (s *Store) resolveExisting(logicalPath string) (string, *apperr.Error) {
	cleaned, e := validateLogicalPath(logicalPath)
	if e != nil {
		return "", e
	}
	candidate := filepath.Join(s.root, filepath.FromSlash(cleaned))
	if !within(s.root, candidate) {
		return "", pathDenied("escaped_root", logicalPath)
	}
	resolved, err := filepath.EvalSymlinks(candidate)
	if err != nil {
		if os.IsNotExist(err) {
			return "", notFound(logicalPath)
		}
		return "", pathDenied("unresolvable", logicalPath).WithCause(err)
	}
	// 前缀比对的**对象是解析结果**：候选路径字符串看起来在根内、而链接指向
	// 根外是最常见的逃逸形态（§5.1 要求明确复核）。
	if !within(s.root, resolved) {
		return "", pathDenied("symlink_escape", logicalPath)
	}
	st, err := os.Stat(resolved)
	if err != nil {
		if os.IsNotExist(err) {
			return "", notFound(logicalPath)
		}
		return "", apperr.New(apperr.CodeInternal, "资源不可用").WithCause(err)
	}
	if st.IsDir() {
		return "", notFound(logicalPath).WithHint("assets.read 只读文件；目录请用应用内自己的清单表示")
	}
	return resolved, nil
}

// validateLogicalPath 是**包内逻辑路径**的白名单式校验。
//
// 逐条拒（§4.4/§5.1）：空、绝对路径、`\`、`..` 段、`.` 段、空段（`//`、尾随 `/`）、
// 控制字符、Windows 盘符/协议形态（`:`）、超长（MaxPathBytes）。
// 校验通过后还要 `path.Clean` 回环比对 —— 纯字符串层面的"看一眼"不算数。
func validateLogicalPath(p string) (string, *apperr.Error) {
	if p == "" {
		return "", pathDenied("empty_path", p)
	}
	if len(p) > MaxPathBytes {
		return "", pathDenied("path_too_long", p).
			WithDetail("max", MaxPathBytes)
	}
	if strings.HasPrefix(p, "/") {
		return "", pathDenied("absolute_path", p).
			WithHint("assets.read 的 path 是**包内逻辑路径**（如 index.html、static/app.css），不是文件系统路径")
	}
	if strings.ContainsRune(p, '\\') {
		return "", pathDenied("backslash", p).
			WithHint("路径分隔符统一用 `/`")
	}
	if strings.ContainsRune(p, ':') {
		return "", pathDenied("drive_or_scheme", p)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return "", pathDenied("control_char", p)
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if len(seg) > MaxSegmentBytes {
			return "", pathDenied("segment_too_long", p).
				WithDetail("max_segment_bytes", MaxSegmentBytes).
				WithHint("单个目录名/文件名不得超过 255 字节（POSIX NAME_MAX）")
		}
		switch seg {
		case "":
			return "", pathDenied("empty_segment", p).
				WithHint("不要写 `//` 或以 `/` 结尾")
		case ".":
			return "", pathDenied("dot_segment", p)
		case "..":
			return "", pathDenied("parent_segment", p)
		}
	}
	if cleaned := path.Clean(p); cleaned != p {
		// 上面的逐段检查已经排除 Clean 会改写的情形；这是纵深防御：
		// 任何"Clean 后与原文不同"的路径都拒，而不是用 Clean 的结果继续。
		return "", pathDenied("not_canonical", p)
	}
	return p, nil
}

// within 报告 p 是否等于 root 或位于 root 之下（按路径段比较，不用裸字符串前缀：
// `/a/bc` 不该被认为在 `/a/b` 之内）。
func within(root, p string) bool {
	if p == root {
		return true
	}
	return strings.HasPrefix(p, root+string(os.PathSeparator))
}

func notFound(p string) *apperr.Error {
	return apperr.Newf(apperr.CodeNotFound, "资源不存在：%s", p).
		WithDetail("path", p).
		WithHint("资源必须在发布期从 wasm 自定义段抽出（HTML/JS/CSS/字体都走这条）")
}

func pathDenied(reason, p string) *apperr.Error {
	return apperr.New(apperr.CodeAssetDenied, "资源路径被拒").
		WithDetail("path", p).
		WithDetail("reason", reason).
		WithHint("assets.read 只接受包内逻辑路径：相对、以 `/` 分隔、不含 `..`/`\\`/控制字符")
}

// ===== content-type 映射 =====

// extContentTypes 是扩展名 → content-type 映射。
//
// 取值全部来自 limits.AppResponseContentTypes（§4.8 的"限定集合"）——
// 新增扩展名时如果类型不在那个集合里，会先被响应头白名单拦掉，所以这里
// 用测试断言映射值的闭包（assets 测试 + §5.5 数值单一真源精神）。
//
// `.js` 映射成 `text/javascript`（而不是 `application/javascript`）是有意的：
// §4.2/§5.1 的 assets.read 只把 `text/*` 与 `application/json` 当文本回给应用，
// 用 `text/javascript` 才能让 JS 资源直接以字符串返回而不是 base64。
var extContentTypes = map[string]string{
	".html":  "text/html",
	".htm":   "text/html",
	".txt":   "text/plain",
	".css":   "text/css",
	".js":    "text/javascript",
	".mjs":   "text/javascript",
	".json":  "application/json",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".svg":   "image/svg+xml",
	".webp":  "image/webp",
	".ico":   "image/x-icon",
	".woff2": "font/woff2",
	".woff":  "font/woff",
}

// ContentTypeFor 按扩展名给出 content-type；未知扩展名回落
// application/octet-stream（在响应头白名单内，且必然走 base64）。
func ContentTypeFor(logicalPath string) string {
	ext := strings.ToLower(path.Ext(logicalPath))
	if ct, ok := extContentTypes[ext]; ok {
		return ct
	}
	return "application/octet-stream"
}

// TextPayload 报告该资源应作为 text 回给应用（否则 base64）。
//
// 规则（§4.2 静态资源 + §5.1 assets.read）：
//   - content-type 前缀 `text/` 或 `application/json` 视为文本；
//   - **文本类还必须真是合法 UTF-8** —— 否则 JSON 编码会把坏字节替换成
//     U+FFFD，应用拿到的是"悄悄被改过的内容"。这种文件退回 base64，
//     应用至少能拿到原始字节。
func TextPayload(contentType string, data []byte) bool {
	if !isTextContentType(contentType) {
		return false
	}
	return utf8.Valid(data)
}

func isTextContentType(contentType string) bool {
	if strings.HasPrefix(contentType, "text/") {
		return true
	}
	return contentType == "application/json"
}

// Base64 编码资源字节（保证 abi.AssetsReadResult 的 base64 分支只有一处实现）。
func Base64(data []byte) string { return base64.StdEncoding.EncodeToString(data) }
