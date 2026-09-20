// Package assets 实现 §5.1 的 `assets.read` 能力：读取**包内资源**。
//
// # 资源的载体与生命周期（2026-09-20 定案：内存直出）
//
// 随包资源 = wasm 模块的**自定义段**（段名就是包内逻辑路径）。运行期宿主把
// `app_releases.wasm` 读出来、解析自定义段、构造成一份**内存资源集**（`Set`），
// 静态直出 / `assets.read` / 应用配置读取三条路径全部走它 ——
// **不再有"发布期抽到宿主磁盘、运行期读盘"这一步**（决策文档
// `docs/decisions/2026-09-20-wasm-assets-in-memory.md`）。
//
// 为什么改（三条都是实测出来的，不是审美）：
//
//  1. **同一件事只能有一处实现**：抽段落盘原先既有发布链路一份、又有播种链路一份，
//     播种那份漏抽资源 ⇒ 演示应用入口页 500。内存模型下"构造资源集"只有一处。
//  2. **不能有两份权威**：应用配置曾经在库里（`config_json`）与磁盘上
//     （`<release>/picoaide.app.json`）各一份，必须写一致性判据 + 半成品自愈。
//     现在库是唯一权威，运行期把配置**注入**资源集（保留资源名，仍然永不直出）。
//  3. **没有路径拼接就没有路径穿越**：原实现要逐段 `Lstat` 拒符号链接、realpath
//     前缀比对、原子写防半写 —— 内存模型下这些防御连同它们的判据一起消失。
//
// # 这里仍然**不是**"文件系统能力"
//
// 路径是**包内逻辑路径**（作者在自定义段里写下的名字，如 `index.html`、
// `static/app.css`），不是宿主文件系统路径：`Set.Read` 先按逻辑规则逐段校验，
// 再在内存映射里做**精确键查找**（没有规范化、没有前缀匹配、没有通配）。
// 能力清单门禁把 `AssetsReadParams.Path` 显式豁免为"包内逻辑路径"
// （见 hostcap 的无路径参数测试）。
//
// # 上限（数值单一真源在 limits）
//
//   - 单文件与**段总量**同源：`limits.SectionTotalMaxBytes`（4 MiB/版本）；
//   - 逻辑路径：`MaxPathBytes` / `MaxSegmentBytes`；
//   - `List()` 条数：`MaxListEntries`。
package assets

import (
	"encoding/base64"
	"path"
	"sort"
	"strings"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

const (
	// MaxPathBytes 是包内逻辑路径的长度上限。
	//
	// ⚠️ limits 包（本模块不可修改）没有资产路径长度常量；这个 256 是本包
	// 当前唯一的数值来源，已列入交付说明请求并入 limits（§5.5「数值单一真源」）。
	// 取值理由：任何真实资源名（含目录层级）都远小于 256 字节；给一个上限是
	// 为了让"超长路径"在进入资源集之前就被拒。
	MaxPathBytes = 256
	// MaxSegmentBytes 是**单个路径段**的长度上限。
	//
	// 这条原本来自文件系统事实（POSIX NAME_MAX = 255 字节）。内存模型不再受
	// NAME_MAX 约束，但**口径刻意不变**：同一个资源在"打包脚本 / 发布校验 /
	// 运行期读取"三处必须同判，放宽它会让已发布内容的合法性随版本漂移。
	MaxSegmentBytes = 255
	// MaxListEntries 是 List() 的条数上限（自省/诊断用，防一次列出巨量条目）。
	//
	// ⚠️ 同上，limits 包无对应常量，已列入交付说明。
	MaxListEntries = 10000
)

// ===== 段 → 资源：唯一一份策略 =====

// ToolchainSections 是**工具链自带的自定义段**名（不当作静态资源）。
//
// 依据是实测而不是猜测：Go 的 wasip1 产物固定带三个自定义段（`go:buildid` /
// `producers` / `name`；本机实测 refapp.wasm 分别 114 B / 71 B / 73 043 B）。
// 其中 `name` 是符号名表（73 KiB！），`producers` 是产线元数据 —— 把它们收进
// 资源集只会浪费内存与段额度，并让作者困惑（`assets.read("name")` 读到一坨符号表）。
//
// 判据与分流见 SplitSections；打包脚本 `scripts/pack-assets.mjs` 的拒绝清单与
// 本表同源（改这里必须同步改它，`assets` 包测试会读脚本源码对拍）。
var ToolchainSections = map[string]struct{}{
	"name":                {},
	"producers":           {},
	"target_features":     {},
	"dylink":              {},
	"dylink.0":            {},
	"linking":             {},
	"sourceMappingURL":    {},
	"external_debug_info": {},
}

// SplitSections 把自定义段分成「静态资源」与「非资源段（忽略并报告）」。
//
// 判据（两条都要满足才算资源）：
//   - 段名不是工具链元数据（ToolchainSections）；
//   - 段名是**包内逻辑路径**（IsLogicalAssetPath 的纯字符串预判；完整校验在
//     Set.Build 里做，那里会拒掉超长与非法字符）。
//
// `picoaide.app.json` 是平台独占名（配置由平台按库内 `config_json` 注入），
// 模块里的同名段直接忽略 —— 否则"资源拒绝覆盖"会先占位，导致配置注入不进去。
func SplitSections(in map[string][]byte) (kept map[string][]byte, skipped []string) {
	kept = make(map[string][]byte, len(in))
	for name, data := range in {
		if _, isToolchain := ToolchainSections[name]; isToolchain {
			skipped = append(skipped, name)
			continue
		}
		if name == limits.AppConfigFileName {
			skipped = append(skipped, name)
			continue
		}
		if !IsLogicalAssetPath(name) {
			skipped = append(skipped, name)
			continue
		}
		kept[name] = data
	}
	sort.Strings(skipped)
	return kept, skipped
}

// IsLogicalAssetPath 是**包内逻辑路径**规则的纯字符串预判（不做长度与段长校验，
// 那些由 ValidateLogicalPath 负责）。
//
// 它存在只为"分流"：把工具链元数据与明显不是路径的段名挑出去，避免对每个段都走
// 一遍完整校验（`go:buildid` 这类名字在完整校验下会报错，而它应当被**静默忽略**）。
func IsLogicalAssetPath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.ContainsAny(p, "\\:") {
		return false
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "", ".", "..":
			return false
		}
	}
	return true
}

// ValidateLogicalPath 是**包内逻辑路径**的白名单式校验（唯一的完整实现）。
//
// 逐条拒（§4.4/§5.1）：空、绝对路径、`\`、`..` 段、`.` 段、空段（`//`、尾随 `/`）、
// 控制字符、Windows 盘符/协议形态（`:`）、超长（MaxPathBytes / MaxSegmentBytes）。
// 校验通过后还要 `path.Clean` 回环比对 —— 纯字符串层面的"看一眼"不算数。
func ValidateLogicalPath(p string) (string, *apperr.Error) {
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
				WithDetail("max_segment_bytes", MaxSegmentBytes)
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

func notFound(p string) *apperr.Error {
	return apperr.Newf(apperr.CodeNotFound, "资源不存在：%s", p).
		WithDetail("path", p).
		WithHint("随包资源来自 wasm 的自定义段（用 scripts/pack-assets.mjs 打进模块）；" +
			"段名必须是包内逻辑路径，如 index.html、static/app.css")
}

func pathDenied(reason, p string) *apperr.Error {
	return apperr.New(apperr.CodeAssetDenied, "资源路径被拒").
		WithDetail("path", p).
		WithDetail("reason", reason).
		WithHint("assets.read 只接受包内逻辑路径：相对、以 `/` 分隔、不含 `..`/`\\`/控制字符")
}

// ===== 内存资源集 =====

// Entry 是资源集里的一条：字节 + 由扩展名推出的 content-type。
type Entry struct {
	// ContentType 由逻辑路径的扩展名推出（ContentTypeFor）；静态直出与
	// `assets.read` 的 text/base64 分流都用它。
	ContentType string
	// Data 是资源字节（**只读**：调用方不得改写；静态直出直接写响应体）。
	Data []byte
}

// Set 是一个 (app_id, release_id) 的**内存**资源集。
//
// 并发：构造完成后只读，可被多个请求并发使用（`appserver` 的版本缓存保证同一 key
// 只有一个实例）。生命周期与模块缓存一致（LRU + 空闲 TTL + 应用级逐出）。
type Set struct {
	appID     string
	releaseID string
	entries   map[string]Entry
	order     []string
	bytes     int64
}

// Build 用"wasm 自定义段 + 平台配置"构造资源集。
//
// 入参 sections 是**已抽出的自定义段**（调用方用 wasmmod.ExtractCustomSections 得到），
// cfgJSON 是该版本的 `config_json`（库内权威副本）；非空时以保留资源名
// `picoaide.app.json` 注入 —— 模块里的同名段在 SplitSections 已被忽略。
//
// 逐条校验（不通过即整份失败；发布期有同一套判据先拦一次，这里是运行期兜底）：
//   - 段名必须过 ValidateLogicalPath；
//   - 单文件 ≤ limits.SectionTotalMaxBytes；
//   - 总量 ≤ limits.SectionTotalMaxBytes（段总量与单文件上限同源，§4.2）。
func Build(appID, releaseID string, sections map[string][]byte, cfgJSON []byte) (*Set, *apperr.Error) {
	kept, _ := SplitSections(sections)
	set := &Set{
		appID:     appID,
		releaseID: releaseID,
		entries:   make(map[string]Entry, len(kept)+1),
		order:     make([]string, 0, len(kept)+1),
	}
	var total int64
	add := func(logical string, data []byte) *apperr.Error {
		if len(data) > limits.SectionTotalMaxBytes {
			return oversize(logical, len(data))
		}
		total += int64(len(data))
		if total > limits.SectionTotalMaxBytes {
			return apperr.New(apperr.CodeAssetOversize, "随包资源总量超过上限").
				WithDetail("total", total).
				WithDetail("max", limits.SectionTotalMaxBytes).
				WithHint("随包资源来自 wasm 自定义段，段总量上限见平台限制")
		}
		set.entries[logical] = Entry{ContentType: ContentTypeFor(logical), Data: data}
		set.order = append(set.order, logical)
		return nil
	}
	for _, name := range sortedNames(kept) {
		logical, perr := ValidateLogicalPath(name)
		if perr != nil {
			return nil, perr
		}
		if aerr := add(logical, kept[name]); aerr != nil {
			return nil, aerr
		}
	}
	if len(cfgJSON) > 0 {
		logical, perr := ValidateLogicalPath(limits.AppConfigFileName)
		if perr != nil {
			return nil, perr
		}
		if aerr := add(logical, cfgJSON); aerr != nil {
			return nil, aerr
		}
	}
	sort.Strings(set.order)
	set.bytes = total
	return set, nil
}

func oversize(p string, size int) *apperr.Error {
	return apperr.New(apperr.CodeAssetOversize, "资源超过单文件上限").
		WithDetail("path", p).
		WithDetail("size", size).
		WithDetail("max", limits.SectionTotalMaxBytes).
		WithHint("随包资源来自 wasm 自定义段，段总量上限与单文件上限同源")
}

func sortedNames(m map[string][]byte) []string {
	out := make([]string, 0, len(m))
	for name := range m {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// AppID 返回资源集所属应用。
func (s *Set) AppID() string {
	if s == nil {
		return ""
	}
	return s.appID
}

// ReleaseID 返回资源集所属版本行 id（诊断用）。
func (s *Set) ReleaseID() string {
	if s == nil {
		return ""
	}
	return s.releaseID
}

// Bytes 返回资源集占用的字节数（内存记账用）。
func (s *Set) Bytes() int64 {
	if s == nil {
		return 0
	}
	return s.bytes
}

// Read 返回一个包内资源的 content-type 与字节。
//
// 错误语义（调用方依赖它们区分"不是静态资源"与"平台故障"）：
//   - 路径非法 ⇒ `ASSET_DENIED`（`details.reason` 给出具体哪一条）；
//   - 路径合法但资源集里没有 ⇒ `NOT_FOUND`（**这是正常分支**：静态直出据此把请求
//     交给 wasm 兜底，见 appserver.static）。
func (s *Set) Read(logicalPath string) (string, []byte, *apperr.Error) {
	if s == nil {
		return "", nil, apperr.New(apperr.CodeInternal, "资源集不可用")
	}
	logical, perr := ValidateLogicalPath(logicalPath)
	if perr != nil {
		return "", nil, perr
	}
	entry, ok := s.entries[logical]
	if !ok {
		return "", nil, notFound(logical)
	}
	return entry.ContentType, entry.Data, nil
}

// Has 报告资源集里是否有该逻辑路径（**不校验路径合法性**：非法路径一律 false）。
func (s *Set) Has(logicalPath string) bool {
	if s == nil {
		return false
	}
	_, ok := s.entries[logicalPath]
	return ok
}

// List 返回全部资源的逻辑路径（按字典序，最多 MaxListEntries 条）。
func (s *Set) List() []string {
	if s == nil {
		return nil
	}
	if len(s.order) <= MaxListEntries {
		return append([]string(nil), s.order...)
	}
	return append([]string(nil), s.order[:MaxListEntries]...)
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
