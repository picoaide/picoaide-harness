// Package wasmtest 是 WASM 模块的**最小编码器**，供编译模块的测试构造夹具。
//
// 为什么自己编码而不是依赖 fixture 文件：
//   - 测试要断言的正是"段表/导入/导出长什么样"，手工编码让夹具与断言在同一屏内，
//     改一处不会让另一个文件静默失配；
//   - 不引入二进制 blob（评审时看不到内容）；
//   - 编出来的模块足够小（几百字节），编解码路径本身也顺带被测。
//
// ⚠️ 实现纪律：**每次返回前把切片裁到 len==cap**（`slices.Clip`），即"返回值不携带
// 余量"。原因：Go 的 append 在容量允许时会**就地**写入，而 wasm 编码里遍地是
// "长度前缀 + 载荷"这种模式；只要内层函数返回的切片带一点余量，外层的前缀写入
// 就会**覆盖载荷的第一个字节**（而不是另分配一块内存）。本文件第一版正是这样错的：
// Cat 返回 8 字节、cap 16，Vec 于是在同一块内存上"就地前插"了长度字节，
// 把类型段的 vec 计数 0x01 覆盖成了 0x08 —— 段表合法、但语义完全错误，
// 而所有夹具与断言会一起说谎。裁掉余量让 append 必然重新分配，这类别名陷阱消失。
//
// ⚠️ 本包**不得**被非测试代码 import（它生成的是"能过解析、但没有真实逻辑"的模块）。
// 目录名是 testdata，Go 工具链天然忽略它 ⇒ 不会进任何二进制的依赖树。
package wasmtest

import "slices"

// Uleb 编码一个 LEB128 无符号整数。
func Uleb(v uint64) []byte {
	var tmp [10]byte
	n := 0
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		tmp[n] = b
		n++
		if v == 0 {
			break
		}
	}
	out := make([]byte, n)
	copy(out, tmp[:n])
	return slices.Clip(out)
}

// Cat 拼接若干字节串（显式分配，杜绝别名）。
func Cat(parts ...[]byte) []byte {
	n := 0
	for _, p := range parts {
		n += len(p)
	}
	out := make([]byte, 0, n)
	for _, p := range parts {
		out = append(out, p...)
	}
	return slices.Clip(out)
}

// LenPrefix 给载荷加上**字节长度**前缀（wasm 的 name / 段体编码用这个）。
func LenPrefix(payload []byte) []byte {
	prefix := Uleb(uint64(len(payload)))
	out := make([]byte, 0, len(prefix)+len(payload))
	out = append(out, prefix...)
	out = append(out, payload...)
	return slices.Clip(out)
}

// VecCount 给字节串加上 **vec 元素个数**前缀（wasm 的 vec 编码用这个，与 LenPrefix
// 不同：vec 的前缀是元素个数，不是子串的字节长度 —— 两者在第一版里被混用过，
// 结果是"类型段声明了 8 个类型、实际只有 1 个"的合法但语义错误的模块）。
func VecCount(count uint64, payload []byte) []byte { return LenPrefix2(Uleb(count), payload) }

// LenPrefix2 用给定的前缀字节拼载荷（VecCount 的实现细节）。
func LenPrefix2(prefix, payload []byte) []byte {
	out := make([]byte, 0, len(prefix)+len(payload))
	out = append(out, prefix...)
	out = append(out, payload...)
	return slices.Clip(out)
}

// Name 编码一个 wasm 字符串（字节长度前缀）。
func Name(s string) []byte { return LenPrefix([]byte(s)) }

// Vec1 编码"含 1 个元素的 vec"——wasm 里最常见的形状（1 个类型、1 个内存、1 个函数）。
func Vec1(payload []byte) []byte { return VecCount(1, payload) }

// Section 编码一个段（id + 长度 + 载荷）。
func Section(id byte, payload []byte) []byte {
	prefix := Uleb(uint64(len(payload)))
	out := make([]byte, 0, 1+len(prefix)+len(payload))
	out = append(out, id)
	out = append(out, prefix...)
	out = append(out, payload...)
	return slices.Clip(out)
}

// TypeFunc 编码一个函数类型（form 0x60 + vec(param) + vec(result)）。
func TypeFunc(params, results []byte) []byte {
	return Cat([]byte{0x60}, VecCount(uint64(len(params)), params), VecCount(uint64(len(results)), results))
}

// TypeSection 编码类型段（段 id 1）：vec( functype )。
func TypeSection(types ...[]byte) []byte {
	return Section(1, VecCount(uint64(len(types)), Cat(types...)))
}

// ImportFunc 编码一条函数导入。
func ImportFunc(module, name string, typeIdx uint32) []byte {
	return Cat(Name(module), Name(name), []byte{0x00}, Uleb(uint64(typeIdx)))
}

// ImportMemory 编码一条内存导入。
func ImportMemory(module, name string, minPages uint32) []byte {
	return Cat(Name(module), Name(name), []byte{0x02, 0x00}, Uleb(uint64(minPages)))
}

// ImportSection 编码导入段（段 id 2）。
func ImportSection(imports ...[]byte) []byte {
	return Section(2, VecCount(uint64(len(imports)), Cat(imports...)))
}

// ExportFunc 编码一条函数导出。
func ExportFunc(name string, idx uint32) []byte {
	return Cat(Name(name), []byte{0x00}, Uleb(uint64(idx)))
}

// ExportMemory 编码一条内存导出。
func ExportMemory(name string, idx uint32) []byte {
	return Cat(Name(name), []byte{0x02}, Uleb(uint64(idx)))
}

// ExportSection 编码导出段（段 id 7）。
func ExportSection(exports ...[]byte) []byte {
	return Section(7, VecCount(uint64(len(exports)), Cat(exports...)))
}

// FunctionSection 编码函数段（段 id 3）：每个元素是一个类型索引。
func FunctionSection(typeIdxs ...uint32) []byte {
	var body []byte
	for _, i := range typeIdxs {
		body = append(body, Uleb(uint64(i))...)
	}
	return Section(3, VecCount(uint64(len(typeIdxs)), body))
}

// MemorySection 编码内存段（段 id 5）：vec( limits )，本夹具只放 1 个内存。
func MemorySection(minPages uint32) []byte {
	return Section(5, Vec1(Cat([]byte{0x00}, Uleb(uint64(minPages)))))
}

// CodeSection 编码代码段（段 id 10）：每个函数体必须是"locals 之后 = 结束指令"的合法体。
func CodeSection(bodies ...[]byte) []byte {
	enc := make([][]byte, 0, len(bodies))
	for _, b := range bodies {
		enc = append(enc, LenPrefix(b))
	}
	return Section(10, VecCount(uint64(len(bodies)), Cat(enc...)))
}

// Body 编码一个函数体：无局部变量 + 给定指令序列。
func Body(instrs ...byte) []byte {
	out := make([]byte, 0, 1+len(instrs))
	out = append(out, 0x00) // 0 个局部变量组
	out = append(out, instrs...)
	return slices.Clip(out)
}

// 常用值类型。
var (
	I32 = byte(0x7f)
	I64 = byte(0x7e)
)

// Params 是一组参数类型的语法糖。
func Params(types ...byte) []byte { return types }

// Build 拼出 \0asm + 版本 1 + 各段。
func Build(sections ...[]byte) []byte {
	out := make([]byte, 0, 8+64*len(sections))
	out = append(out, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
	for _, s := range sections {
		out = append(out, s...)
	}
	return slices.Clip(out)
}

// CustomSection 编码一个自定义段（id 0）。
func CustomSection(name string, payload []byte) []byte {
	return Section(0, Cat(Name(name), payload))
}

// Base 返回一个"最小可接受模块"：导入 fd_read + fd_write，导出 memory + _start。
//
// 结构（每一段都是编译与校验路径必须走到的）：
//
//	type:   (i32,i32,i32,i32)->i32   [fd_read / fd_write 同型]
//	import: wasi_snapshot_preview1.fd_read, wasi_snapshot_preview1.fd_write
//	func:   [_start] -> type 0
//	mem:    1 页
//	export: memory(mem 0), _start(func 1)
//	code:   i32.const -1; end     （返回 -1，永不被执行；本夹具只用于编译）
func Base() []byte {
	return Build(
		TypeSection(TypeFunc(Params(I32, I32, I32, I32), Params(I32))),
		ImportSection(
			ImportFunc("wasi_snapshot_preview1", "fd_read", 0),
			ImportFunc("wasi_snapshot_preview1", "fd_write", 0),
		),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x41, 0x7f, 0x0b)), // i32.const -1 ; end
	)
}

// ComponentModel 返回一个"组件模型形状"的字节串。
//
// 真实组件产物由 wasm-tools 生成；本夹具模拟解析器看到的**头**：
// 字节布局 = magic(4) + version(uint16 LE) + layer(uint16 LE)，因此
// `0a 00 01 00` = version 10 / layer 1（layer != 0 即组件模型）。
// 头判定先于任何段解析，因此这足以触发组件模型分支。
func ComponentModel() []byte {
	return []byte{0x00, 0x61, 0x73, 0x6d, 0x0a, 0x00, 0x01, 0x00}
}

// CorruptMagic 返回魔数被破坏的字节串。
func CorruptMagic() []byte {
	b := Base()
	b[1] = 'x'
	return b
}

// BigCustom 返回一个带 n 字节自定义段的模块（自定义段总量测试用）。
func BigCustom(n int) []byte {
	payload := make([]byte, n)
	for i := range payload {
		payload[i] = byte(i)
	}
	return Build(
		TypeSection(TypeFunc(Params(I32), Params(I32))),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x41, 0x7f, 0x0b)),
		CustomSection("assets", payload),
	)
}

// WithBadImportSignature 返回一个把 fd_write 声明成错误签名的模块
// （编译期合法、实例化才炸的经典形态）。
func WithBadImportSignature() []byte {
	return Build(
		TypeSection(
			TypeFunc(Params(I32, I32, I32, I32), Params(I32)),
			TypeFunc(Params(I32, I32), Params(I32)),
		),
		ImportSection(ImportFunc("wasi_snapshot_preview1", "fd_write", 1)),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x41, 0x7f, 0x0b)),
	)
}

// WithoutStart 返回缺少 _start 导出的模块。
func WithoutStart() []byte {
	return Build(
		TypeSection(TypeFunc(Params(I32), Params(I32))),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0)),
		CodeSection(Body(0x41, 0x7f, 0x0b)),
	)
}

// WithEnvImport 返回导入 env.* 的模块（不在白名单 ⇒ 必拒）。
func WithEnvImport() []byte {
	return Build(
		TypeSection(TypeFunc(Params(), Params())),
		ImportSection(ImportFunc("env", "abort", 0)),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x0b)),
	)
}

// WithImport 返回一个导入任意 (module,name) 函数的模块（白名单用例）。
//
// 用它可以构造"不在生成白名单里的符号"（如 sock_open / path_open），
// 验证静态校验真的按名单拒绝，而不是"只认模块名"。
func WithImport(module, name string, params, results []byte) []byte {
	return Build(
		TypeSection(TypeFunc(params, results)),
		ImportSection(ImportFunc(module, name, 0)),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x41, 0x7f, 0x0b)),
	)
}

// WithImportedMemory 返回导入 memory 的模块（导入面只允许函数 ⇒ 必拒）。
func WithImportedMemory() []byte {
	return Build(
		TypeSection(TypeFunc(Params(), Params())),
		ImportSection(ImportMemory("wasi_snapshot_preview1", "memory", 1)),
		FunctionSection(0),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 1)),
		CodeSection(Body(0x0b)),
	)
}

// TruncatedSection 返回"段长度声明超过实际字节"的模块（边界检查判据）。
func TruncatedSection() []byte {
	out := []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
	out = append(out, 0x01)             // type 段
	out = append(out, Uleb(4096)...)    // 声称 4096 字节
	out = append(out, 0x00, 0x01, 0x02) // 实际只有 3 字节
	return slices.Clip(out)
}

// DataCountSection 编码 DataCount 段（段 id 12）。
//
// 为什么单独一个段编码器：DataCount 是 **Wasm 2.0 / bulk-memory** 引入的、唯一不按
// 段 id 数值升序摆放的段（规范位置 = Element(9) 之后、Code(10) 之前）。平台预检
// 曾只做"纯 id 升序"，于是带 DataCount 的产物（TinyGo 默认、启用 bulk-memory 的
// LLVM/Rust/Zig 配置）陷入死局：放规范位置被预检拒、改数值升序被 wazero 拒。
// 夹具必须能构造这个形状，判据才存在。
func DataCountSection(count uint32) []byte { return Section(12, Uleb(uint64(count))) }

// DataSection 编码数据段（段 id 11）：vec( data )，这里放一个"主动、内存 0"的段。
//
// ⚠️ 偏移表达式是**常量表达式**（i32.const 0 ; end），不是函数体：**不能**用 Body()
// ——它会给函数体加"局部变量组计数"前缀，放进常量表达式就是非法操作码 0x00
// （本夹具第一版正是这样错的，被 wazero 报 `invalid byte for const expression op code: 0x0`）。
func DataSection(payload ...byte) []byte {
	const offsetExprI32Const0 = "\x41\x00\x0b" // i32.const 0 ; end
	seg := Cat([]byte{0x00}, []byte(offsetExprI32Const0), VecCount(uint64(len(payload)), payload))
	return Section(11, VecCount(1, seg))
}

// WithDataCount 返回一个**带 DataCount 段且按规范位置摆放**的可编译模块。
//
// 结构：type ()->() / func[_start] / memory 1 页 / export(memory,_start) /
// DataCount(1) / code: `data.drop 0; end` / data: 1 个主动段（1 字节）。
// code 段用到 `data.drop` ⇒ 按规范**必须**先声明 DataCount，否则 wazero 的校验
// 会直接拒（这正是"预检放行、真编译报错"的另一半）。
func WithDataCount() []byte {
	return Build(
		TypeSection(TypeFunc(Params(), Params())),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 0)),
		DataCountSection(1),
		CodeSection(Body(0xFC, 0x09, 0x00, 0x0B)), // data.drop 0 ; end
		DataSection(0x2a),
	)
}

// WithDuplicateSection 返回一个**重复出现某个非自定义段**的模块（段 id 至多一次）。
//
// 为什么需要它（2026-09-21 独立审计 P1-1）：平台此前的段序判据是 `id < lastSectionID`
// （只拦倒序），重复段静默通过；而 wazero 的 `checkSectionOrder` 是 `current > previous`
// （严格递增）⇒ 重复 Function/Table/Global/Element/Code/Data 段会被平台预检放行、
// 被真编译拒绝。本夹具让"预检必须与 wazero 同判"这条判据可复跑。
//
// ⚠️ 两次出现必须摆在**该段的规范位置**上（第一版夹具把它们追加到段表末尾，于是
// 低 id 的 table/global/element 会先撞上"顺序非法"判据，测到的是顺序而不是重复——
// 判据本身没错，但**测不到"重复"这条分支**。见 TestValidateRejectsDuplicateSectionAtTail
// 对"末尾重复"形态的独立判据）。
//
// @param id - 要重复的段 id（0..12，且必须是本夹具会安置的段）。
// @param first - 第一次出现的段载荷。
// @param second - 第二次出现的段载荷。
func WithDuplicateSection(id byte, first, second []byte) []byte {
	dup := Cat(Section(id, first), Section(id, second))
	return Build(concatSections(buildDuplicateBase(id, dup))...)
}

// WithDuplicateSectionAtTail 返回一个把某个低 id 段**重复追加在段表末尾**的模块。
//
// 与 WithDuplicateSection 的差别是"重复"与"乱序"同时成立：第一次出现落在段表末尾
// （相对 lastSectionID 是倒序，但因为是首次出现而被顺序判据放过），紧随其后的副本
// 命中重复判据。此时平台的判据顺序决定文案：重复必须优先（指向病根「出现了两次」），
// 而不是"出现在段 id 10 之后"。
func WithDuplicateSectionAtTail(id byte, first, second []byte) []byte {
	base := buildDuplicateBase(id, nil) // 规范段表，但不含 id 段（首次出现挪到末尾）
	return Build(append(concatSections(base),
		Section(id, first),
		Section(id, second),
	)...)
}

// 段 id 常量（core spec）。本包是独立夹具，不依赖 wasmmod（那里也有一份，
// 两边各自钉在规范上；夹具侧只用到"排序"这一个语义）。
const (
	secType     byte = 1
	secFunction byte = 3
	secMemory   byte = 5
	secExport   byte = 7
	secCode     byte = 10
)

// buildDuplicateBase 生成规范顺序的段表；dup 非空时把它插到目标段的规范位置上。
func buildDuplicateBase(id byte, dup []byte) [][]byte {
	var out [][]byte
	put := func(v []byte) {
		if len(v) > 0 {
			out = append(out, v)
		}
	}
	if dup != nil && id < secType {
		put(dup)
	}
	put(TypeSection(TypeFunc(Params(), Params())))
	if dup != nil && id == secType {
		put(dup)
	}
	if dup != nil && id > secType && id < secFunction {
		put(dup)
	}
	put(FunctionSection(0))
	if dup != nil && id == secFunction {
		put(dup)
	}
	if dup != nil && id > secFunction && id < secMemory {
		put(dup)
	}
	put(MemorySection(1))
	if dup != nil && id == secMemory {
		put(dup)
	}
	if dup != nil && id > secMemory && id < secExport {
		put(dup)
	}
	put(ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 0)))
	if dup != nil && id == secExport {
		put(dup)
	}
	if dup != nil && id > secExport && id < secCode {
		put(dup)
	}
	put(CodeSection(Body(0x0b)))
	if dup != nil && id == secCode {
		put(dup)
	}
	if dup != nil && id > secCode {
		put(dup)
	}
	return out
}

// concatSections 把段编码列表拼成一个字节串（Build 之前的"段表"形态）。
func concatSections(sections [][]byte) [][]byte { return sections }

// WithDataCountMisordered 返回一个把 DataCount 摆在 Code **之后**的模块。
//
// 这是修复前的"绕过姿势"（为了满足纯 id 升序）：预检曾放行，真编译期 wazero 报
// `invalid section order`。现在预检必须自己拒掉它（与 wazero 同判）。
func WithDataCountMisordered() []byte {
	return Build(
		TypeSection(TypeFunc(Params(), Params())),
		FunctionSection(0),
		MemorySection(1),
		ExportSection(ExportMemory("memory", 0), ExportFunc("_start", 0)),
		CodeSection(Body(0xFC, 0x09, 0x00, 0x0B)), // data.drop 0 ; end
		DataCountSection(1), // ← 错位：DataCount 必须在 Code 之前
		DataSection(0x2a),
	)
}

// Garbage 返回完全不含 wasm 头的字节串。
func Garbage(n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = byte(0xA5 ^ i)
	}
	return out
}
