package wasmmod

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
)

// ===== 模块头常量（§4.2 魔数 + 版本/层字段校验）=====

const (
	// ModuleMagic 是 wasm 二进制魔数 `\0asm`。
	ModuleMagic = "\x00asm"
	// CoreVersion 是 core module 的版本字段（文件第 5–6 字节，小端）。
	CoreVersion = 1
	// ComponentVersion 是组件模型（component）的版本字段取值（0x0d）。
	ComponentVersion = 13
	// HeaderLen = 魔数 4 字节 + 版本 2 字节 + 层（layer）2 字节（§10.2 第 19 项）。
	HeaderLen = 8
)

// 段 id（wasm core spec）。自定义段（0）可重复且可出现在任意位置，其余段最多一次且按 id 升序。
const (
	SectionCustom    byte = 0
	SectionType      byte = 1
	SectionImport    byte = 2
	SectionFunction  byte = 3
	SectionTable     byte = 4
	SectionMemory    byte = 5
	SectionGlobal    byte = 6
	SectionExport    byte = 7
	SectionStart     byte = 8
	SectionElement   byte = 9
	SectionCode      byte = 10
	SectionData      byte = 11
	SectionDataCount byte = 12
)

// 导入项种类（Import.Kind / ImportSpec.Kind 的取值）。
const (
	KindFunc   = "func"
	KindMemory = "memory"
	KindTable  = "table"
	KindGlobal = "global"
)

// sectionNames 是段 id → 名字（Section.Name 只对自定义段有值，这里是诊断用的通用名字）。
var sectionNames = map[byte]string{
	SectionCustom:    "custom",
	SectionType:      "type",
	SectionImport:    "import",
	SectionFunction:  "function",
	SectionTable:     "table",
	SectionMemory:    "memory",
	SectionGlobal:    "global",
	SectionExport:    "export",
	SectionStart:     "start",
	SectionElement:   "element",
	SectionCode:      "code",
	SectionData:      "data",
	SectionDataCount: "datacount",
}

// SectionName 返回段 id 的名字（未知 id 返回 "section(<id>)"）。
func SectionName(id byte) string {
	if n, ok := sectionNames[id]; ok {
		return n
	}
	return fmt.Sprintf("section(%d)", id)
}

// ===== 公开类型（§4.2）=====

// Import 是一条导入项。
//
// 判据 = **符号 + 类型**（§4.2）：只匹配符号名会让"签名不匹配"的产物通过静态校验，
// 而这类产物**编译期全绿、实例化才炸**（§10.2 第 18 项实测），所以类型必须一起判。
type Import struct {
	// Module 是导入模块名；平台只允许 limits.WasmImportModule。
	Module string
	// Name 是导入符号名（如 fd_read）。
	Name string
	// Kind 是种类：func / memory / table / global。
	Kind string
	// Signature 是规范化类型签名（格式见 SignatureFormatDoc，例：i32i32i32i32_i32）。
	Signature string
}

// Section 是一条段表项。
//
// Offset/Size 描述**负载**（payload）：Offset 是负载在文件中的绝对起始偏移，
// Size 是负载字节数（不含 1 字节段 id 与 LEB128 长度前缀）。自定义段的 Name 是
// 负载开头的名字字段（名字字段本身计入 Size）。
type Section struct {
	ID     byte
	Name   string
	Offset int
	Size   int
}

// ModuleInfo 是静态解析结果（Validate/Parse 的返回值）。
type ModuleInfo struct {
	// Imports 是导入段的全部条目（**保持段内顺序与重复**：Go wasip1 实测 fd_write 出现两次）。
	Imports []Import
	// Exports 是导出名，按段内顺序。
	Exports []string
	// ExportKinds 是导出名 → 种类（func/memory/table/global）；额外字段，便于上层断言
	// "_start" 是函数、"memory" 是内存（§4.2 导出面判据）。
	ExportKinds map[string]string
	// Sections 是段表（含自定义段），按文件顺序。
	Sections []Section
	// CustomSections 是段名 → 内容（**重名取第一个**，次数见 CustomSectionCounts）。
	// 内容切片与传入的 data 共享底层数组（不复制）；若要在释放 data 后继续持有，
	// 请用 ExtractCustomSections（它会复制）。
	CustomSections map[string][]byte
	// CustomSectionCounts 是段名 → 出现次数（重名时同样只有第一个进 CustomSections）。
	CustomSectionCounts map[string]int
	// CustomBytes 是**计入 §4.2 段总量预算**的自定义段负载字节和（口径：各段负载之和，
	// 含段名长度前缀与段名；**不含** `.debug_*` 前缀族 —— 它们在发布期被丢弃、不进资源集，
	// 计入会让同一模块出现"资产口径通过、段总量口径超限"两个数）。
	//
	// 预算口径的唯一实现在 assets.CountsTowardSectionBudget；它与作者侧
	// `skills/app-builder/scripts/pack-assets.mjs` 逐字节同源（assets 包测试对拍）。
	CustomBytes int
	// HasStart 表示存在 start 段（实例化时会自动执行该函数；平台不因此拒绝，仅记录以便诊断）。
	HasStart bool
	// MemoryDeclared 表示模块**声明**了线性内存（memory 段非空，或导入了 memory）。
	MemoryDeclared bool
	// MemoryExported 表示导出段里有一个种类为 memory 的 "memory" 导出。
	// §4.2：memory 必须是**导出**而非仅声明（wazero 实例化需要它）。
	MemoryExported bool
	// Version / Layer 是模块头两个字段（core: 1 / 0）。
	Version uint16
	Layer   uint16
}

// funcType 是类型段里的一条函数类型。
type funcType struct {
	params  []string
	results []string
}

func (ft funcType) signature() string {
	return strings.Join(ft.params, "") + "_" + strings.Join(ft.results, "")
}

// hexDigits 是 valueTypeName 未知取值分支用的十六进制字母表。
const hexDigits = "0123456789abcdef"

// valueTypeName 把 wasm 值类型字节映射成签名里的短名。
//
// ⚠️ 未知取值**不得**用 `fmt.Sprintf`（2026-09-23 审计 WASM-1，P1）：这个函数在
// 类型段解析里按**形参/结果个数**调用，而那个计数只受"≤ 剩余载荷字节"约束 ⇒
// 每个形参一次 `Sprintf` 就是一次堆分配，把一个 32 MiB 模块放大成 GiB 级分配。
// 已知取值全部返回**驻留常量**（零分配），未知取值手写 3 字节十六进制（一次小分配）。
func valueTypeName(b byte) string {
	switch b {
	case 0x7f:
		return "i32"
	case 0x7e:
		return "i64"
	case 0x7d:
		return "f32"
	case 0x7c:
		return "f64"
	case 0x7b:
		return "v128"
	case 0x70:
		return "funcref"
	case 0x6f:
		return "externref"
	default:
		// 与 `fmt.Sprintf("t%02x", b)` 逐字节相同，但无格式化开销。
		return string([]byte{'t', hexDigits[b>>4], hexDigits[b&0x0f]})
	}
}

// ===== 错误构造（每条都带 hints，§8：第一消费者是 AI）=====

// malformedf 构造 SECTION_MALFORMED（段表/头部结构非法）。
// apperr.CommonHints 里没有该码的条目，故本包自带一组提示（§8：每条错误都必须带 hints）。
func malformedf(format string, args ...any) *apperr.Error {
	return apperr.Newf(apperr.CodeSectionMalformed, format, args...).
		WithHint(hintsFor(apperr.CodeSectionMalformed, malformedHints...)...)
}

// hintsFor 返回公共提示（apperr.CommonHints）加上本包补充的提示；
// 返回**新切片**，不会改写 apperr 的公共表（跨包全局不得被本包就地修改）。
func hintsFor(code apperr.Code, extra ...string) []string {
	out := append([]string{}, apperr.CommonHints[code]...)
	return append(out, extra...)
}

// malformedHints 是段表类错误的固定提示集合。
var malformedHints = []string{
	"文件必须是标准 core module：`\\0asm` 开头、版本字段 = 1、层字段 = 0",
	"编译目标必须是 wasm32-wasip1（Go: GOOS=wasip1 GOARCH=wasm）",
	"不要上传 .wat 文本、gzip 压缩包、或组件模型（component / .wit）产物",
}

// ===== 解析 =====

// Parse 只做**结构与格式解析**，不做任何策略判据（导出面 / 导入白名单 / 体积）。
//
// 存在两个入口的原因（自举）：导入白名单（imports_gen.go）本身就是"参考实现真编译产物"的
// 导出结果，生成器必须在白名单**尚不存在/尚未更新**时就能读出导入集，所以生成器走 Parse；
// 业务代码一律走 Validate（= Parse + 全部策略判据），门禁测试还会额外断言
// Validate(参考实现) 通过，确保生成的清单确实覆盖参考实现。
//
// 返回的错误全部是 SECTION_MALFORMED（魔数/版本/长度越界/字段非法）或
// COMPONENT_MODEL_UNSUPPORTED（层字段 != 0，§10.2 第 19 项）。
func Parse(data []byte) (*ModuleInfo, error) {
	if len(data) < HeaderLen {
		return nil, malformedf("模块只有 %d 字节，不足 8 字节头部", len(data)).
			WithDetail("size", len(data)).
			WithDetail("min_size", HeaderLen)
	}
	if !bytes.Equal(data[:len(ModuleMagic)], []byte(ModuleMagic)) {
		return nil, malformedf("魔数不是 `\\0asm`（前 4 字节是 %s）", hex.EncodeToString(data[:4])).
			WithDetail("magic", hex.EncodeToString(data[:4]))
	}
	version := binary.LittleEndian.Uint16(data[4:6])
	layer := binary.LittleEndian.Uint16(data[6:8])

	// ⚠️ 必须先判层字段再判版本：组件模型的版本字段是 13（0x0d），
	// 反过来判会把"组件模型"误报成 SECTION_MALFORMED，AI 就拿不到正确出路。
	if layer != 0 {
		return nil, apperr.New(apperr.CodeComponentModelUnsupport,
			"不支持组件模型（component）产物：平台只接受 core module").
			WithDetail("layer", layer).
			WithDetail("version", version).
			WithHint(hintsFor(apperr.CodeComponentModelUnsupport,
				"若用 Rust，请编译到 wasm32-wasip1（而不是 wasm32-wasip2 / component target）",
				"若用 TypeScript/AssemblyScript，本平台不支持（工具链只产出组件模型）")...)
	}
	if version != CoreVersion {
		return nil, malformedf("模块版本字段是 %d，只支持 core module 版本 %d", version, CoreVersion).
			WithDetail("version", version).
			WithDetail("expected_version", CoreVersion)
	}

	info := &ModuleInfo{
		Version:             version,
		Layer:               layer,
		ExportKinds:         map[string]string{},
		CustomSections:      map[string][]byte{},
		CustomSectionCounts: map[string]int{},
	}

	// 段表遍历：id(1B) + LEB128 u32 长度 + 负载。
	var (
		typePayload, importPayload, exportPayload, memoryPayload, startPayload []byte
		haveType, haveImport, haveExport, haveMemory, haveStart                bool
		lastSectionID                                                          = -1
		// seenSection 记录每个非自定义段 id 是否已经出现过（下标 = id，0..12）。
		//
		// 为什么需要它，而不是靠"相邻相等"或"严格递增"推断重复（2026-09-21 独立审计
		// P1-1 的判据收口）：`int(id) == lastSectionID` 只覆盖**紧邻**的重复段；
		// 一旦两次出现之间夹着别的段（如 function 段被 code 段隔开），判据会先落到
		// "顺序非法"那条，错误码虽然同样是 SECTION_MALFORMED，但文案不再指出病根，
		// 且"重复"与"乱序"两种病因在同一个输入上不可区分（同一模块报哪种取决于
		// 段的相对位置）。显式集合让**重复恒优先**、文案稳定，且与 wazero 的
		// `current > previous` 判据保持同判（两者都拒，这里额外给出更精确的错误）。
		seenSection [SectionDataCount + 1]bool
		// firstSectionOffset 记录每个段 id 首次出现的段起始偏移，供重复段报错指向首次出现。
		firstSectionOffset [SectionDataCount + 1]int
	)
	offset := HeaderLen
	for offset < len(data) {
		sectionStart := offset
		id := data[offset]
		offset++
		size, used, err := readU32(data[offset:])
		if err != nil {
			return nil, malformedf("第 %d 字节处的段长度前缀非法：%v（段 id=%s）",
				offset, err, SectionName(id)).
				WithDetail("offset", sectionStart).
				WithDetail("section_id", id).
				WithDetail("section", SectionName(id)).
				WithDetail("size_available", len(data)-offset)
		}
		offset += used
		if uint64(size) > uint64(len(data)-offset) {
			return nil, malformedf("段 %s 声明长度 %d 字节，但文件只剩 %d 字节（段表越界/截断）",
				SectionName(id), size, len(data)-offset).
				WithDetail("offset", sectionStart).
				WithDetail("section_id", id).
				WithDetail("section", SectionName(id)).
				WithDetail("declared_size", size).
				WithDetail("available", len(data)-offset)
		}
		payloadStart := offset
		payload := data[offset : offset+int(size)]
		offset += int(size)

		if id == SectionCustom {
			// 自定义段：负载开头是名字（u32 长度 + UTF-8）。
			//
			// 条数上界：自定义段可以重复出现，而每个最小段只占 3 字节 ⇒ 没有常数上界时
			// "合法上限体积"能换出 GiB 级宿主分配（见 MaxCustomSections 的实测数字）。
			if e := checkCountMax(SectionCustom, "自定义段条数", uint32(len(info.Sections)+1), MaxCustomSections); e != nil {
				return nil, e.WithDetail("offset", sectionStart)
			}
			name, n, err := readName(payload)
			if err != nil {
				return nil, malformedf("自定义段（偏移 %d）的段名非法：%v", sectionStart, err).
					WithDetail("offset", sectionStart).
					WithDetail("section_id", id).
					WithDetail("section", SectionName(id)).
					WithDetail("size", size)
			}
			info.Sections = append(info.Sections, Section{ID: id, Name: name, Offset: payloadStart, Size: int(size)})
			info.CustomSectionCounts[name]++
			if _, dup := info.CustomSections[name]; !dup {
				info.CustomSections[name] = payload[n:]
			}
			// 段总量预算（§4.2 的 4 MiB）只计**会变成资源**的载荷：`.debug_*` 前缀族
			// （DWARF）在发布期被丢弃 —— 不进资源集、不可能被静态直出、assets.read 也
			// 读不到，却由真实工具链默认产出几 MB。把它们计入的后果是同一模块两个数
			// （资产口径通过、段总量口径超限，且提示说的是"压缩资源"），作者/AI 只能
			// 按错的数改。判据的唯一实现见 assets.CountsTowardSectionBudget 的长注释。
			if assets.CountsTowardSectionBudget(name) {
				info.CustomBytes += int(size)
			}
			continue
		}

		// 非自定义段：每个 id 至多一次，且必须按**规范顺序**（core spec §5.5）。
		//
		// DataCount(12) 是唯一不按数值升序的段：它的规范位置是 Element(9) 之后、
		// Code(10) 之前（Wasm 2.0 / bulk-memory）。判据必须与平台自己的运行时
		// wazero 逐条对齐（wazero@v1.12.0 internal/wasm/binary/decoder.go:190-204）——
		// 修复前这里只做"纯 id 升序"，于是带 DataCount 的模块陷入死局：
		//   · DataCount 放规范位置 → 本函数报"顺序非法"（Code(10) < DataCount(12)）；
		//   · 改成数值升序（放 Data/Code 之后）→ 预检放行，但真编译期 wazero 报
		//     `invalid section order` ⇒ **任何带 DataCount 的产物都发不出去**
		//     （TinyGo 默认产物、启用 bulk-memory 的 LLVM/Rust/Zig 配置）。
		// 见 docs/planning/2026-09-21-wasm-platform-gap-audit-and-plan.md §3 P0-4。
		// id 上界 = 12（DataCount）。**Tag 段（13）故意在此被拒**，理由必须写清楚，
		// 否则会被误读成"漏了一个段"（2026-09-21 独立审计 P3-④）：
		//
		//   · wazero 的 `checkSectionOrder`（v1.12.0 internal/wasm/binary/decoder.go:185-189）
		//     对 Tag 有一条**特例位置规则**（Memory 之后、Global 之前），也就是说
		//     "段序"这一层 wazero 是认识 13 的；
		//   · 但平台**根本不支持 TAG 语义**（没有 tag 段解析、运行时不启用
		//     exception-handling），所以一个带 Tag 段的模块即便段序摆对，也会在
		//     真编译期被 wazero 以 feature 缺失拒掉；
		//   · 于是这里提前拒、并给出可操作的 `SECTION_MALFORMED`（指向"段 id 13"），
		//     而不是放行到编译期换一个编译器内部错误 —— 契约「预检通过即可编译」
		//     因此仍然成立（**两边都拒**，只是**拒的位置与理由不同**）。
		//
		// 判据见 TestValidateRejectsTagSectionID13：id=13 必须被拒，且文案指向段 id
		// 而不是"顺序非法"（后者会让人以为"摆对位置就能过"）。
		if id > SectionDataCount {
			return nil, malformedf("未知段 id %d（平台只支持 0–12：Tag 段（13）属 Wasm 3.0 异常处理，"+
				"本平台不启用该特性，段序摆对也无法编译）", id).
				WithDetail("offset", sectionStart).
				WithDetail("section_id", id)
		}
		// 重复段判据**先于**顺序判据：两种病因（"同一段出现两次" vs "段乱序"）在
		// 同一段表上可能同时成立，只有把重复放在前面，同一输入才会稳定地给出
		// 指向病根的文案（判据：`{3,4,6,9,10,11}` 各构造一个"重复空段"模块，
		// 错误 message 必须含「两次」——见 TestValidateRejectsDuplicateNonCustomSections）。
		if seenSection[id] {
			return nil, duplicateSection(sectionStart, id).
				WithDetail("first_offset", firstSectionOffset[id])
		}
		seenSection[id] = true
		firstSectionOffset[id] = sectionStart
		switch {
		case id == SectionDataCount:
			// DataCount 必须在 Element 之后（且不能出现在它自己之前）。
			if lastSectionID > int(SectionElement) {
				return nil, malformedf("段顺序非法：段 %s 出现在段 id %d 之后（DataCount 必须在 Element 之后、Code 之前）",
					SectionName(id), lastSectionID).
					WithDetail("offset", sectionStart).
					WithDetail("section_id", id).
					WithDetail("section", SectionName(id)).
					WithDetail("previous_section_id", lastSectionID)
			}
		case lastSectionID == int(SectionDataCount):
			// DataCount 之后只允许 Code 及其后继段。
			if int(id) < int(SectionCode) {
				return nil, malformedf("段顺序非法：段 %s 出现在段 %s 之后（DataCount 之后只允许 Code 及之后）",
					SectionName(id), SectionName(SectionDataCount)).
					WithDetail("offset", sectionStart).
					WithDetail("section_id", id).
					WithDetail("section", SectionName(id)).
					WithDetail("previous_section_id", lastSectionID)
			}
		case int(id) < lastSectionID:
			// 严格递增 = "每个非自定义段至多一次 + 按 id 升序"，与 wazero 的
			// `checkSectionOrder`（`current > previous`）**逐字等价**。
			//
			// 为什么是"严格递增"而不是"只拦倒序"（2026-09-21 独立审计 P1-1）：
			// 只拦倒序时**重复段会静默通过**（例如两个 Function 段），而 wazero 会以
			// `invalid section order` 拒绝 ⇒ `/validate` 回绿、`/publish` 的真编译
			// 才炸，契约「预检通过即可编译」被破坏。重复由上面的 `seenSection`
			// 显式覆盖（含 5 个原有的 `haveX` 分支），这里只判"倒序"。
			return nil, malformedf("段顺序非法：段 %s 出现在段 id %d 之后（非自定义段必须严格递增：至多一次且按 id 升序）",
				SectionName(id), lastSectionID).
				WithDetail("offset", sectionStart).
				WithDetail("section_id", id).
				WithDetail("section", SectionName(id)).
				WithDetail("previous_section_id", lastSectionID)
		}
		lastSectionID = int(id)
		info.Sections = append(info.Sections, Section{ID: id, Offset: payloadStart, Size: int(size)})

		switch id {
		case SectionType:
			if haveType {
				return nil, duplicateSection(sectionStart, id)
			}
			haveType, typePayload = true, payload
		case SectionImport:
			if haveImport {
				return nil, duplicateSection(sectionStart, id)
			}
			haveImport, importPayload = true, payload
		case SectionExport:
			if haveExport {
				return nil, duplicateSection(sectionStart, id)
			}
			haveExport, exportPayload = true, payload
		case SectionMemory:
			if haveMemory {
				return nil, duplicateSection(sectionStart, id)
			}
			haveMemory, memoryPayload = true, payload
		case SectionStart:
			if haveStart {
				return nil, duplicateSection(sectionStart, id)
			}
			haveStart, startPayload = true, payload
		}
	}

	// 类型段必须**先**解析：导入函数的签名（Import.Signature）都指向类型段的下标。
	var types []funcType
	if haveType {
		parsed, err := parseTypes(typePayload)
		if err != nil {
			return nil, err
		}
		types = parsed
	}

	if haveImport {
		imports, err := parseImports(importPayload, types)
		if err != nil {
			return nil, err
		}
		info.Imports = imports
		for _, imp := range imports {
			if imp.Kind == KindMemory {
				info.MemoryDeclared = true
			}
		}
	}
	if haveExport {
		names, kinds, err := parseExports(exportPayload)
		if err != nil {
			return nil, err
		}
		info.Exports = names
		info.ExportKinds = kinds
		if k, ok := kinds["memory"]; ok && k == KindMemory {
			info.MemoryExported = true
		}
	}
	if haveMemory {
		n, used, err := readU32(memoryPayload)
		if err != nil {
			return nil, malformedf("内存段的条目数非法：%v", err).
				WithDetail("section", SectionName(SectionMemory))
		}
		if n > 0 {
			info.MemoryDeclared = true
		}
		// 逐条校验 limits 编码，避免"声明了但编码非法"被当成合法。
		//
		// 走 parseLimitsRaw 而不是 parseLimits：这里的描述串会被丢弃，而条目数
		// 只受"≤ 剩余载荷"约束 ⇒ 用会格式化的那个版本等于给宿主加一条
		// "每条一次 Sprintf"的放大路径（2026-09-23 审计 WASM-1 同族）。
		rest := memoryPayload[used:]
		if e := checkCountMax(SectionMemory, "内存段条目数", n, MaxMemoryEntries); e != nil {
			return nil, e
		}
		for i := uint32(0); i < n; i++ {
			_, _, _, _, consumed, err := parseLimitsRaw(rest)
			if err != nil {
				return nil, malformedf("内存段第 %d 条 limits 非法：%v", i, err).
					WithDetail("section", SectionName(SectionMemory)).
					WithDetail("index", i)
			}
			rest = rest[consumed:]
		}
	}
	if haveStart {
		if len(startPayload) == 0 {
			return nil, malformedf("start 段为空（规范要求一个函数索引）").
				WithDetail("section", SectionName(SectionStart))
		}
		if _, _, err := readU32(startPayload); err != nil {
			return nil, malformedf("start 段的函数索引非法：%v", err).
				WithDetail("section", SectionName(SectionStart))
		}
		info.HasStart = true
	}
	return info, nil
}

func duplicateSection(offset int, id byte) *apperr.Error {
	return malformedf("段 %s 出现了两次（非自定义段至多一次）", SectionName(id)).
		WithDetail("offset", offset).
		WithDetail("section_id", id).
		WithDetail("section", SectionName(id))
}

// checkVecCount 校验"段内计数向量"与剩余载荷的一致性。
//
// 为什么必须有这条（2026-09-21 安全修复，P0）：向量解析的第一行是
// `make([]T, 0, n)`，n 直接来自段内声明，最大 0xFFFFFFFF。若不做上界校验，
// 一个 **15 字节**的畸形模块就能让宿主申请 256 GiB（`Import` = 4×string = 64 B，
// 0xFFFFFFFF×64 B = 274 877 906 944 B），触发 `fatal error: out of memory`
// —— 这是**进程级**崩溃（不可 recover，gin.Recovery 无效），且发生在 API server
// 进程内（`compile.ValidateWasm` 明写"不发子进程"）⇒ 任意已登录员工可让整个
// 服务端退出。修复前的实测复现见 docs/planning/2026-09-21-wasm-platform-gap-audit-and-plan.md §3 P0-0。
//
// 判据：向量里每个元素在字节流中至少占 1 字节 ⇒ n 不可能大于剩余载荷长度。
// 这里只做**上界**；元素内部结构仍由各自的解析循环逐条校验（截断/畸形各有错码）。
func checkVecCount(section byte, what string, n uint32, rest []byte) error {
	if uint64(n) > uint64(len(rest)) {
		return malformedf("%s条目数 %d 与剩余载荷 %d 字节不一致（计数向量越界）", what, n, len(rest)).
			WithDetail("section", SectionName(section)).
			WithDetail("declared_count", n).
			WithDetail("available_bytes", len(rest))
	}
	return nil
}

// ===== 计数向量的**常数**上界（2026-09-23 审计 WASM-1，P1）=====
//
// 为什么"≤ 剩余载荷字节"这一层不够（同族缺陷的**第二层**）：单个元素在宿主侧的
// 字节代价远大于它在字节流里的最小编码长度 ——
//
//	向量          元素最小编码   宿主侧每条代价（64 位）    放大
//	类型段条目    3 B（空 functype）  16 B 切片头 + 两次 append   ~10×
//	形参/结果     1 B            16 B 切片头（外加每个未知值类型一次分配） ~16×
//	导入段条目    3 B            4×string = 64 B              ~21×
//	导出段条目    3 B            16 B + 一个 map 条目（≈50 B）  ~22×
//
// 于是一个**恰好合法**的 32 MiB 模块（平台允许的最大体积）可以被放大成宿主进程内
// GiB 级分配：修复前实测 `TotalAlloc 2.00 GiB`（导入向量）/`+590 MiB RSS`（类型向量），
// 且这条路径在 **API server 进程内**（`POST /api/client/v2/apps/wasm/validate`
// → `api/publish.go` → `compile.ValidateWasm`，该文件明写"不发子进程"）⇒
// 任意已登录员工（bearer）即可触发进程级内存事故。
// 结构判据（每元素 ≥1 字节）消不掉放大倍数，所以这里给**常数**上界。
//
// 取值校准（2026-09-23 实测 7940 个真实产物 = wazero@v1.12 全部 testdata（Go/TinyGo/
// Zig/Rust/emscripten/assemblyscript 工具链产物 + W3C spectest 模块）+ 平台参考实现
// 用真 Go wasip1 工具链编译：`cd temp/audit-2026-09-23/probes/wasm && go run . calib`）：
//
//	类型段条数  实测最大 38    → 上界 1024（26×；真实工具链产物 ≤38）
//	单函数形参  实测最大 100   → 上界 256（2.5×；真实工具链产物 ≤17）
//	单函数结果  实测最大 138   → 上界 256（1.9×；真实工具链产物 ≤16）
//	导入段条数  实测最大 35    → 上界 1024（29×）
//	导出段条数  实测最大 479   → 上界 4096（8.5×）
//
// 乘积界：1024 类型 × (256 形参 + 256 结果) × 16 B ≈ 8 MiB ⇒ 最坏情形下解析期分配
// 与模块体积（≤32 MiB）同量级，不再是 64× 放大。
//
// ⚠️ 这些是**解析器自身的放大防线**，不是平台能力上限：它们不进 limits 包、
// 不进 limitsspec 生成物、不对外宣告（真实工具链离它们有一个数量级）。
const (
	// MaxFuncTypeEntries 是类型段条目数上限（见上面的校准表）。
	MaxFuncTypeEntries = 1024
	// MaxFuncParams 是单个函数类型的形参个数上限。
	MaxFuncParams = 256
	// MaxFuncResults 是单个函数类型的结果个数上限。
	MaxFuncResults = 256
	// MaxImportEntries 是导入段条目数上限（Go wasip1 实测 35 条）。
	MaxImportEntries = 1024
	// MaxExportEntries 是导出段条目数上限。
	MaxExportEntries = 4096
	// MaxMemoryEntries 是内存段条目数上限（规范允许 n>1 但校验器只接受 0/1；
	// 取 16 与"每应用库上限"同量级，远高于任何真实产物）。
	MaxMemoryEntries = 16
	// MaxCustomSections 是自定义段条数上限。
	//
	// 这一条不在报告列举的三个向量里，但**同在本次审计的这条路径上且放大更大**：
	// 一个最小自定义段（id=0 + 长度 1 + 段名长度 0）在字节流里只占 **3 B**，而宿主
	// 为它 append 一个 `Section`（32 B）并写一个 map 计数条目 ⇒ 实测
	// "32 MiB 模块 = 11 184 808 个自定义段 ⇒ TotalAlloc **2408 MiB**、err=nil"
	// （2026-09-23 本机实测，探针见交付报告）。真源工具链产物的自定义段是个位数
	// （name/producers/target_features + 平台自己的资源段），4096 已是三个数量级余量。
	MaxCustomSections = 4096
)

// checkCountMax 校验"段内/元素内计数"不超过**常数**上界（见上面的校准表）。
//
// 判据与 checkVecCount 互补：那条是"结构不可能"（计数 > 剩余字节），这条是
// "宿主侧代价不可能"（计数 > 解析器为它预留的预算）。两层的错误文案必须可区分，
// 否则排障时会以为是同一个病根。
func checkCountMax(section byte, what string, n uint32, max int) *apperr.Error {
	if uint64(n) > uint64(max) {
		return malformedf("%s %d 超过解析器上限 %d（该计数在宿主侧的字节代价远大于其编码长度）", what, n, max).
			WithDetail("section", SectionName(section)).
			WithDetail("declared_count", n).
			WithDetail("parser_max", max)
	}
	return nil
}

// parseTypes 解析类型段：vec of functype(0x60)。
func parseTypes(payload []byte) ([]funcType, error) {
	n, used, err := readU32(payload)
	if err != nil {
		return nil, malformedf("类型段条目数非法：%v", err).WithDetail("section", SectionName(SectionType))
	}
	rest := payload[used:]
	if err := checkVecCount(SectionType, "类型段", n, rest); err != nil {
		return nil, err
	}
	// 第二层：常数上界（见 MaxFuncTypeEntries 的长注释）。
	if err := checkCountMax(SectionType, "类型段条目数", n, MaxFuncTypeEntries); err != nil {
		return nil, err
	}
	out := make([]funcType, 0, n)
	for i := uint32(0); i < n; i++ {
		if len(rest) == 0 {
			return nil, malformedf("类型段第 %d 条在数据结束前截断", i).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		if rest[0] != 0x60 {
			return nil, malformedf("类型段第 %d 条不是函数类型（首字节 0x%02x，应为 0x60）", i, rest[0]).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		rest = rest[1:]
		np, used, err := readU32(rest)
		if err != nil {
			return nil, malformedf("类型段第 %d 条形参个数非法：%v", i, err).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		rest = rest[used:]
		if uint64(np) > uint64(len(rest)) {
			return nil, malformedf("类型段第 %d 条形参越界（声明 %d 个）", i, np).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		// 第二层：常数上界。单个形参在宿主侧 = 16 B 切片头（外加值类型名），
		// 而它在字节流里只占 1 B ⇒ 没有常数上界就是 16× 放大（WASM-1）。
		if e := checkCountMax(SectionType,
			fmt.Sprintf("类型段第 %d 条形参个数", i), np, MaxFuncParams); e != nil {
			return nil, e.WithDetail("index", i)
		}
		ft := funcType{params: make([]string, 0, np)}
		for k := uint32(0); k < np; k++ {
			ft.params = append(ft.params, valueTypeName(rest[k]))
		}
		rest = rest[np:]
		nr, used, err := readU32(rest)
		if err != nil {
			return nil, malformedf("类型段第 %d 条结果个数非法：%v", i, err).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		rest = rest[used:]
		if uint64(nr) > uint64(len(rest)) {
			return nil, malformedf("类型段第 %d 条结果越界（声明 %d 个）", i, nr).
				WithDetail("section", SectionName(SectionType)).WithDetail("index", i)
		}
		// 第二层：常数上界（与形参同源；结果数在宿主侧同样是 16 B/个的切片头）。
		if e := checkCountMax(SectionType,
			fmt.Sprintf("类型段第 %d 条结果个数", i), nr, MaxFuncResults); e != nil {
			return nil, e.WithDetail("index", i)
		}
		ft.results = make([]string, 0, nr)
		for k := uint32(0); k < nr; k++ {
			ft.results = append(ft.results, valueTypeName(rest[k]))
		}
		rest = rest[nr:]
		out = append(out, ft)
	}
	return out, nil
}

// parseImports 解析导入段（vec of import）。
func parseImports(payload []byte, types []funcType) ([]Import, error) {
	n, used, err := readU32(payload)
	if err != nil {
		return nil, malformedf("导入段条目数非法：%v", err).WithDetail("section", SectionName(SectionImport))
	}
	rest := payload[used:]
	if err := checkVecCount(SectionImport, "导入段", n, rest); err != nil {
		return nil, err
	}
	// 第二层：常数上界（一条 Import = 4×string = 64 B，是放大倍数最高的一类）。
	if err := checkCountMax(SectionImport, "导入段条目数", n, MaxImportEntries); err != nil {
		return nil, err
	}
	out := make([]Import, 0, n)
	for i := uint32(0); i < n; i++ {
		detail := func() *apperr.Error {
			return malformedf("导入段第 %d 条非法", i).
				WithDetail("section", SectionName(SectionImport)).
				WithDetail("index", i)
		}
		module, consumed, err := readName(rest)
		if err != nil {
			return nil, detail().WithCause(err)
		}
		rest = rest[consumed:]
		name, consumed, err := readName(rest)
		if err != nil {
			return nil, detail().WithCause(err)
		}
		rest = rest[consumed:]
		if len(rest) == 0 {
			return nil, detail().WithCause(errTruncated)
		}
		kindByte := rest[0]
		rest = rest[1:]
		imp := Import{Module: module, Name: name}
		switch kindByte {
		case 0x00: // func: typeidx
			idx, consumed, err := readU32(rest)
			if err != nil {
				return nil, detail().WithCause(err)
			}
			rest = rest[consumed:]
			if uint64(idx) >= uint64(len(types)) {
				return nil, detail().WithDetail("type_index", idx).
					WithDetail("type_count", len(types)).
					WithCause(errTruncated)
			}
			imp.Kind = KindFunc
			imp.Signature = types[idx].signature()
		case 0x01: // table: reftype + limits
			if len(rest) == 0 {
				return nil, detail().WithCause(errTruncated)
			}
			elemType := valueTypeName(rest[0])
			lim, consumed, err := parseLimits(rest[1:])
			if err != nil {
				return nil, detail().WithCause(err)
			}
			rest = rest[1+consumed:]
			imp.Kind = KindTable
			imp.Signature = "table:" + elemType + ":" + lim
		case 0x02: // memory: limits
			lim, consumed, err := parseLimits(rest)
			if err != nil {
				return nil, detail().WithCause(err)
			}
			rest = rest[consumed:]
			imp.Kind = KindMemory
			imp.Signature = "mem:" + lim
		case 0x03: // global: valtype + mut
			if len(rest) < 2 {
				return nil, detail().WithCause(errTruncated)
			}
			imp.Kind = KindGlobal
			imp.Signature = "global:" + valueTypeName(rest[0])
			if rest[1] == 1 {
				imp.Signature += ":mut"
			}
			rest = rest[2:]
		default:
			return nil, detail().WithDetail("kind_byte", kindByte).
				WithDetail("reason", "导入种类只能是 0(func)/1(table)/2(memory)/3(global)")
		}
		out = append(out, imp)
	}
	return out, nil
}

// parseExports 解析导出段（vec of export），返回名字序列与名字→种类映射。
func parseExports(payload []byte) ([]string, map[string]string, error) {
	n, used, err := readU32(payload)
	if err != nil {
		return nil, nil, malformedf("导出段条目数非法：%v", err).WithDetail("section", SectionName(SectionExport))
	}
	rest := payload[used:]
	if err := checkVecCount(SectionExport, "导出段", n, rest); err != nil {
		return nil, nil, err
	}
	// 第二层：常数上界（一条导出 = 16 B 切片头 + 一个 map 条目 ≈50 B）。
	if err := checkCountMax(SectionExport, "导出段条目数", n, MaxExportEntries); err != nil {
		return nil, nil, err
	}
	names := make([]string, 0, n)
	kinds := make(map[string]string, n)
	for i := uint32(0); i < n; i++ {
		detail := func() *apperr.Error {
			return malformedf("导出段第 %d 条非法", i).
				WithDetail("section", SectionName(SectionExport)).
				WithDetail("index", i)
		}
		name, consumed, err := readName(rest)
		if err != nil {
			return nil, nil, detail().WithCause(err)
		}
		rest = rest[consumed:]
		if len(rest) < 2 {
			return nil, nil, detail().WithCause(errTruncated)
		}
		kindByte, idx := rest[0], rest[1:]
		rest = rest[1:]
		var kind string
		switch kindByte {
		case 0x00:
			kind = KindFunc
		case 0x01:
			kind = KindTable
		case 0x02:
			kind = KindMemory
		case 0x03:
			kind = KindGlobal
		default:
			return nil, nil, detail().WithDetail("kind_byte", kindByte).
				WithDetail("reason", "导出种类只能是 0(func)/1(table)/2(memory)/3(global)")
		}
		_, consumed, err = readU32(idx)
		if err != nil {
			return nil, nil, detail().WithCause(err)
		}
		rest = rest[consumed:]
		if _, dup := kinds[name]; dup {
			// 规范要求导出名唯一；重名会让"memory 是不是内存"这类判据产生歧义（安全相关），故直接拒。
			return nil, nil, detail().WithDetail("name", name).
				WithDetail("reason", "导出名重复（规范要求唯一）")
		}
		names = append(names, name)
		kinds[name] = kind
	}
	return names, kinds, nil
}

// parseLimitsRaw 解析 limits 编码（flags 字节 + min [+ max]）的**结构**，
// 只返回值与消耗字节数，不构造描述串。
//
// 为什么要与描述串分开（2026-09-23 审计 WASM-1 同族）：内存段逐条校验时**丢弃**
// 描述串（它只有导入签名用得上），而条目数只受"≤ 剩余载荷"约束 ⇒ 32 MiB 载荷
// 可以让上千万条 limits 各走一次 `fmt.Sprintf`（一次格式化 = 一次堆分配 + 反射式
// 格式化开销），这是与 np/nr 同族的"宿主侧每元素代价 ≫ 编码长度"放大。
func parseLimitsRaw(b []byte) (flags byte, min, max uint32, hasMax bool, used int, err error) {
	if len(b) == 0 {
		return 0, 0, 0, false, 0, errTruncated
	}
	flags = b[0]
	if flags > 0x03 {
		return 0, 0, 0, false, 0, fmt.Errorf("limits flags 非法：0x%02x", flags)
	}
	used = 1
	min, n, err := readU32(b[used:])
	if err != nil {
		return 0, 0, 0, false, 0, err
	}
	used += n
	if flags&0x01 != 0 {
		m, n, merr := readU32(b[used:])
		if merr != nil {
			return 0, 0, 0, false, 0, merr
		}
		used += n
		max, hasMax = m, true
	}
	return flags, min, max, hasMax, used, nil
}

// parseLimits 解析 limits 编码（flags 字节 + min [+ max]），返回描述串与消耗字节数。
//
// 描述串只用于导入签名（条目数已被 MaxImportEntries 封顶）⇒ 这里的格式化不是热路径。
func parseLimits(b []byte) (string, int, error) {
	flags, min, max, hasMax, used, err := parseLimitsRaw(b)
	if err != nil {
		return "", 0, err
	}
	out := fmt.Sprintf("%d..", min)
	if hasMax {
		out += fmt.Sprintf("%d", max)
	} else {
		out += "∞"
	}
	if flags&0x02 != 0 {
		out += ":shared"
	}
	return out, used, nil
}

// ===== 自定义段抽取（发布期静态资源，§4.2）=====

// ExtractCustomSections 抽出全部自定义段，供发布期把静态资源收进资源集
// （2026-09-20 起不再落盘：见 docs/decisions/2026-09-20-wasm-assets-in-memory.md；
// 抽完即可释放 wasm 原始字节）。
//
// 与 Parse 的差别：
//   - 返回的内容是**复制**过的，不与 data 共享底层数组——这是"抽完立即释放原始字节"成立的前提；
//   - 重名段取第一个（与 Parse 一致）。
//
// 本函数只做结构解析，**不重复策略判据**：调用方应先 Validate（体积 / 自定义段总量 / 导出面 / 导入面）
// 再抽取（发布链路"抽取失败 = 发布失败"的前提是静态校验已经通过）。
func ExtractCustomSections(data []byte) (map[string][]byte, error) {
	sections, _, err := ExtractCustomSectionsWithCounts(data)
	return sections, err
}

// ExtractCustomSectionsWithCounts 与 ExtractCustomSections 相同，但**同时**返回
// "段名 → 出现次数"。
//
// 为什么需要次数（2026-09-20）：随包资源以段名作为包内逻辑路径，而重名段在解析层
// 只取第一个、其余**静默丢弃** —— 作者把同一个包内路径打了两遍（或两个不同文件映射到
// 同一个路径）时，他看到的页面与"最后写进去的那份"不一致，且不会出现任何错误码。
// 发布期据此拒（`ASSET_EXISTS` + `details.reason = "duplicate_section"`）比让作者对着
// 一个"内容不对"的页面猜要便宜得多。
func ExtractCustomSectionsWithCounts(data []byte) (map[string][]byte, map[string]int, error) {
	info, err := Parse(data)
	if err != nil {
		return nil, nil, err
	}
	out := make(map[string][]byte, len(info.CustomSections))
	for name, content := range info.CustomSections {
		cp := make([]byte, len(content))
		copy(cp, content)
		out[name] = cp
	}
	counts := make(map[string]int, len(info.CustomSectionCounts))
	for name, n := range info.CustomSectionCounts {
		counts[name] = n
	}
	return out, counts, nil
}
