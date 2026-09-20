package wasmmod

import (
	"bytes"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件用手工拼装的 wasm 字节流覆盖静态校验器的全部分支。
//
// 变异验证（§5.5「变异验证」：任一限制改回"无上限"对应用例必须变红）：
//   - 删掉 Validate 里的体积判据           → TestValidateRejectsOversizeModule 必红；
//   - 删掉自定义段总量判据                  → TestValidateRejectsOversizeCustomSections 必红；
//   - 删掉导出面判据                       → TestValidateRejectsMissingStartExport /
//     TestValidateRejectsMemoryDeclaredButNotExported 必红；
//   - 删掉导入模块名判据                    → TestValidateRejectsForeignImportModule 必红；
//   - 删掉签名比对（只比符号名）             → TestValidateRejectsSignatureMismatch 必红；
//   - 交换层字段与版本字段的判断顺序          → TestValidateRejectsComponentModel 会退化成 SECTION_MALFORMED（必红）。
//
// ⚠️ 这里构造的是"结构形状正确"的模块，不保证能被 wazero 编译（没有 code 段）：
// 静态校验器只负责"编译之前就能判定的判据"，真编译 + 干跑由运行时模块负责（§4.2）。

// ===== 手工拼装 wasm 的最小工具 =====

const (
	valI32 byte = 0x7f
	valI64 byte = 0x7e
)

// u32 编码 LEB128 无符号 32 位整数。
func u32(v uint32) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			b |= 0x80
		}
		out = append(out, b)
		if v == 0 {
			return out
		}
	}
}

// wasmName 编码名字字段（u32 长度 + UTF-8）。
func wasmName(s string) []byte { return append(u32(uint32(len(s))), s...) }

// wasmVec 编码向量（u32 条数 + 各元素）。
func wasmVec(items ...[]byte) []byte {
	out := u32(uint32(len(items)))
	for _, it := range items {
		out = append(out, it...)
	}
	return out
}

// wasmFuncType 编码函数类型（0x60 + 形参向量 + 结果向量）。
func wasmFuncType(params, results []byte) []byte {
	out := []byte{0x60}
	out = append(out, u32(uint32(len(params)))...)
	out = append(out, params...)
	out = append(out, u32(uint32(len(results)))...)
	out = append(out, results...)
	return out
}

// wasmImport 编码一条导入（module + name + 种类 + 种类负载）。
func wasmImport(module, symbol string, kind byte, rest []byte) []byte {
	out := wasmName(module)
	out = append(out, wasmName(symbol)...)
	out = append(out, kind)
	return append(out, rest...)
}

// wasmExport 编码一条导出（name + 种类 + 索引）。
func wasmExport(symbol string, kind byte, index uint32) []byte {
	out := wasmName(symbol)
	out = append(out, kind)
	return append(out, u32(index)...)
}

// moduleBuilder 逐段拼一个模块。
type moduleBuilder struct{ body []byte }

func (m *moduleBuilder) add(id byte, payload []byte) *moduleBuilder {
	m.body = append(m.body, id)
	m.body = append(m.body, u32(uint32(len(payload)))...)
	return &moduleBuilder{body: append(m.body, payload...)}
}

func (m *moduleBuilder) custom(sectionName string, content []byte) *moduleBuilder {
	return m.add(SectionCustom, append(wasmName(sectionName), content...))
}

// customRaw 用任意名字字段字节拼自定义段（测畸形名字）。
func (m *moduleBuilder) customRaw(payload []byte) *moduleBuilder {
	return m.add(SectionCustom, payload)
}

func (m *moduleBuilder) build() []byte {
	out := []byte(ModuleMagic)
	out = append(out, 1, 0, 0, 0) // core module：version=1，layer=0
	return append(out, m.body...)
}

// 四个 wasi 符号的类型：fd_read/fd_write = (i32,i32,i32,i32)->i32；random_get = (i32,i32)->i32。
var (
	typeI32x4ToI32 = wasmFuncType([]byte{valI32, valI32, valI32, valI32}, []byte{valI32})
	typeI32x2ToI32 = wasmFuncType([]byte{valI32, valI32}, []byte{valI32})
)

// validModule 返回一个"最小合法"模块：导入 fd_read/fd_write/random_get、导出 _start 与 memory。
func validModule() *moduleBuilder {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x4ToI32, typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(
		wasmImport(limits.WasmImportModule, "fd_read", 0x00, u32(0)),
		wasmImport(limits.WasmImportModule, "fd_write", 0x00, u32(0)),
		wasmImport(limits.WasmImportModule, "random_get", 0x00, u32(1)),
	))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...))) // min=1、无 max
	m = m.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
	))
	return m
}

// codeOf 取出 *apperr.Error 的 code（断言失败即 Fatal）。
func codeOf(t *testing.T, err error) *apperr.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("期望报错，实际 nil")
	}
	e, ok := apperr.As(err)
	if !ok {
		t.Fatalf("期望 *apperr.Error，实际 %T: %v", err, err)
	}
	return e
}

// assertHints 断言错误带 hints（§8：第一消费者是 AI，必须可操作）。
func assertHints(t *testing.T, e *apperr.Error) {
	t.Helper()
	if len(e.Hints) == 0 {
		t.Fatalf("%s 没有 hints（§8 要求每条错误都可操作）: %s", e.Code, e.JSON())
	}
}

// ===== 正向：合法模块 =====

func TestValidateAcceptsMinimalModule(t *testing.T) {
	data := validModule().build()
	info, err := Validate(data)
	if err != nil {
		t.Fatalf("合法模块被拒: %v", err)
	}
	if len(info.Imports) != 3 {
		t.Fatalf("导入条数 = %d，期望 3: %+v", len(info.Imports), info.Imports)
	}
	if info.Imports[0].Name != "fd_read" || info.Imports[0].Signature != "i32i32i32i32_i32" {
		t.Fatalf("fd_read 解析错误: %+v", info.Imports[0])
	}
	if info.Imports[2].Signature != "i32i32_i32" {
		t.Fatalf("random_get 签名解析错误: %+v", info.Imports[2])
	}
	if !info.MemoryDeclared || !info.MemoryExported {
		t.Fatalf("memory 判定错误: declared=%v exported=%v", info.MemoryDeclared, info.MemoryExported)
	}
	if info.Version != CoreVersion || info.Layer != 0 {
		t.Fatalf("版本/层解析错误: %d/%d", info.Version, info.Layer)
	}
}

func TestValidateIgnoresExtraExports(t *testing.T) {
	// §4.2：额外导出忽略（Rust 实测多一个 __main_void）。
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x4ToI32))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "fd_read", 0x00, u32(0))))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
		wasmExport("__main_void", 0x00, 0),
	))
	info, err := Validate(m.build())
	if err != nil {
		t.Fatalf("带额外导出的模块被拒: %v", err)
	}
	if len(info.Exports) != 3 || info.ExportKinds["__main_void"] != KindFunc {
		t.Fatalf("导出面解析错误: %v / %v", info.Exports, info.ExportKinds)
	}
}

// ===== 头部：魔数 / 版本 / 组件模型 =====

func TestValidateRejectsBadMagic(t *testing.T) {
	data := []byte("NOPE")
	data = append(data, 1, 0, 0, 0)
	_, err := Validate(data)
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s，期望 %s", e.Code, apperr.CodeSectionMalformed)
	}
	assertHints(t, e)
	if e.Status() != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP = %d，期望 422（§7.4）", e.Status())
	}
}

func TestValidateRejectsTruncatedHeader(t *testing.T) {
	_, err := Validate([]byte{0x00, 0x61, 0x73})
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s", e.Code)
	}
	assertHints(t, e)
}

func TestValidateRejectsUnsupportedCoreVersion(t *testing.T) {
	data := []byte(ModuleMagic)
	data = append(data, 2, 0, 0, 0) // version=2、layer=0
	_, err := Validate(data)
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s，期望 SECTION_MALFORMED: %v", e.Code, err)
	}
	if e.Details["version"] != uint16(2) {
		t.Fatalf("details.version = %v", e.Details["version"])
	}
}

func TestValidateRejectsComponentModel(t *testing.T) {
	// 组件模型：版本 13（0x0d）、层 1（§10.2 第 19 项）。
	data := []byte(ModuleMagic)
	data = append(data, 13, 0, 1, 0)
	_, err := Validate(data)
	e := codeOf(t, err)
	if e.Code != apperr.CodeComponentModelUnsupport {
		t.Fatalf("code = %s，期望 COMPONENT_MODEL_UNSUPPORTED（必须先判层字段再判版本）: %v",
			e.Code, err)
	}
	if e.Status() != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP = %d，期望 422", e.Status())
	}
	assertHints(t, e)
}

// ===== 段表结构 =====

func TestValidateRejectsSectionLengthOverrun(t *testing.T) {
	data := validModule().build()
	// 把第一个段的长度前缀改成远超文件长度：id 在第 8 字节。
	bad := append([]byte{}, data[:9]...)
	bad = append(bad, u32(1<<20)...)
	bad = append(bad, data[9:]...)
	_, err := Validate(bad)
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s，期望 SECTION_MALFORMED: %v", e.Code, err)
	}
	if _, ok := e.Details["declared_size"]; !ok {
		t.Fatalf("details 缺少 declared_size: %v", e.Details)
	}
}

func TestValidateRejectsTruncatedSectionHeader(t *testing.T) {
	data := append(validModule().build(), SectionType) // 段 id 后面没有长度
	_, err := Validate(data)
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
}

func TestValidateRejectsDuplicateNonCustomSection(t *testing.T) {
	// 连续两条 memory 段（id 相同 ⇒ 不触发"顺序非法"，专门测重复段分支）。
	memory := wasmVec(append([]byte{0x00}, u32(1)...))
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x4ToI32))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "fd_read", 0x00, u32(0))))
	m = m.add(SectionMemory, memory)
	m = m.add(SectionMemory, memory)
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
	if !strings.Contains(e.Message, "两次") {
		t.Fatalf("错误消息应指出重复段: %s", e.Message)
	}
}

func TestValidateRejectsOutOfOrderSections(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionType, wasmVec(typeI32x4ToI32)) // 段 id 1 出现在段 id 5 之后
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
}

func TestValidateRejectsBadCustomSectionName(t *testing.T) {
	m := validModule()
	m = m.customRaw([]byte{0x05, 'a', 'b'}) // 声明 5 字节名字，实际只有 2 字节
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
}

// ===== 自定义段：抽取与总量 =====

func TestCustomSectionsExtractAndBytes(t *testing.T) {
	m := validModule()
	m = m.custom("producers", []byte("go"))
	m = m.custom("picoaide.app.json", []byte(`{"visible":true}`))
	m = m.custom("producers", []byte("dup")) // 重名：CustomSections 取第一个，counts 记 2
	data := m.build()

	info, err := Validate(data)
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	got := string(info.CustomSections["picoaide.app.json"])
	if got != `{"visible":true}` {
		t.Fatalf("picoaide.app.json 内容 = %q", got)
	}
	if string(info.CustomSections["producers"]) != "go" {
		t.Fatalf("重名自定义段应取第一个: %q", info.CustomSections["producers"])
	}
	if info.CustomSectionCounts["producers"] != 2 {
		t.Fatalf("producers 出现次数 = %d，期望 2", info.CustomSectionCounts["producers"])
	}
	// CustomBytes = 各自定义段负载之和（含段名字段）。
	want := len(wasmName("producers")) + len("go") +
		len(wasmName("picoaide.app.json")) + len(`{"visible":true}`) +
		len(wasmName("producers")) + len("dup")
	if info.CustomBytes != want {
		t.Fatalf("CustomBytes = %d，期望 %d", info.CustomBytes, want)
	}

	// ExtractCustomSections 必须是**复制**（发布期要"抽完立即释放原始字节"，§4.2）。
	extracted, err := ExtractCustomSections(data)
	if err != nil {
		t.Fatalf("ExtractCustomSections: %v", err)
	}
	extracted["picoaide.app.json"][0] = 'X'
	again, err := ExtractCustomSections(data)
	if err != nil {
		t.Fatalf("ExtractCustomSections(2): %v", err)
	}
	if again["picoaide.app.json"][0] != '{' {
		t.Fatalf("ExtractCustomSections 返回的切片与模块字节共享底层数组（改动污染了原数据）")
	}
}

func TestValidateRejectsOversizeCustomSections(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过 4 MiB 分配")
	}
	m := validModule()
	m = m.custom("assets", bytes.Repeat([]byte{'x'}, limits.SectionTotalMaxBytes+1))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionOverrideOversize {
		t.Fatalf("code = %s，期望 SECTION_OVERRIDE_OVERSIZE（§7.4 失败语义表）: %v", e.Code, err)
	}
	if e.Status() != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP = %d，期望 422", e.Status())
	}
	if e.Details["limit"] != limits.SectionTotalMaxBytes {
		t.Fatalf("details.limit = %v", e.Details["limit"])
	}
	assertHints(t, e)
}

func TestValidateRejectsOversizeModule(t *testing.T) {
	if testing.Short() {
		t.Skip("-short：跳过 32 MiB 分配")
	}
	data := make([]byte, limits.WasmMaxBytes+1)
	copy(data, ModuleMagic)
	data[4], data[5], data[6], data[7] = 1, 0, 0, 0
	_, err := Validate(data)
	e := codeOf(t, err)
	if e.Code != apperr.CodeWasmTooLarge {
		t.Fatalf("code = %s，期望 WASM_TOO_LARGE: %v", e.Code, err)
	}
	assertHints(t, e)
}

// ===== 导出面 =====

func TestValidateRejectsMissingStartExport(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "random_get", 0x00, u32(0))))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("memory", 0x02, 0))) // 只有 memory
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeValidateFailed {
		t.Fatalf("code = %s，期望 VALIDATE_FAILED: %v", e.Code, err)
	}
	missing, ok := e.Details["missing"].([]string)
	if !ok || len(missing) != 1 || missing[0] != "_start" {
		t.Fatalf("details.missing = %v", e.Details["missing"])
	}
	assertHints(t, e)
}

func TestValidateRejectsMemoryDeclaredButNotExported(t *testing.T) {
	// §4.2：memory 必须是**导出**而非仅声明。
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "random_get", 0x00, u32(0))))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0))) // 只有 _start
	info, err := Validate(m.build())
	if info != nil {
		t.Fatalf("校验失败时不应返回 ModuleInfo")
	}
	e := codeOf(t, err)
	if e.Code != apperr.CodeValidateFailed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
	if e.Details["memory_exported"] != false || e.Details["memory_declared"] != true {
		t.Fatalf("details 应说明 memory 仅声明未导出: %v", e.Details)
	}
	assertHints(t, e)
}

func TestValidateRejectsMemoryExportedAsWrongKind(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "random_get", 0x00, u32(0))))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x00, 0), // 名字对了但种类是 func
	))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeValidateFailed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
	wrong, ok := e.Details["wrong_kind"].(map[string]string)
	if !ok || wrong["memory"] != KindFunc {
		t.Fatalf("details.wrong_kind = %v", e.Details["wrong_kind"])
	}
}

// ===== 导入面 =====

func TestValidateRejectsForeignImportModule(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(
		wasmImport("env", "abort", 0x00, u32(0)), // §10.2 第 17 项：env.* / js.* 一律拒
	))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportNotAllowed {
		t.Fatalf("code = %s，期望 IMPORT_NOT_ALLOWED: %v", e.Code, err)
	}
	if e.Details["symbol"] != "env.abort" || e.Details["module"] != "env" {
		t.Fatalf("details = %v", e.Details)
	}
	if e.Status() != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP = %d，期望 422", e.Status())
	}
	assertHints(t, e)
}

func TestValidateRejectsUnknownSymbol(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(typeI32x2ToI32))
	m = m.add(SectionImport, wasmVec(
		wasmImport(limits.WasmImportModule, "sock_open", 0x00, u32(0)), // 真实 WASI 符号但不在白名单
	))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportNotAllowed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
	if e.Details["symbol"] != limits.WasmImportModule+".sock_open" {
		t.Fatalf("details.symbol = %v", e.Details["symbol"])
	}
	assertHints(t, e)
}

func TestValidateRejectsSignatureMismatch(t *testing.T) {
	// 符号在名单内、类型不符：§8 错误示例的形状（expected/actual/symbol）。
	m := &moduleBuilder{}
	// fd_write 声明成 (i32,i32,i32)->i32（少一个形参）。
	badFDWrite := wasmFuncType([]byte{valI32, valI32, valI32}, []byte{valI32})
	m = m.add(SectionType, wasmVec(badFDWrite))
	m = m.add(SectionImport, wasmVec(wasmImport(limits.WasmImportModule, "fd_write", 0x00, u32(0))))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportSignatureMismatch {
		t.Fatalf("code = %s，期望 IMPORT_SIGNATURE_MISMATCH: %v", e.Code, err)
	}
	if e.Details["symbol"] != limits.WasmImportModule+".fd_write" {
		t.Fatalf("details.symbol = %v", e.Details["symbol"])
	}
	if e.Details["actual"] != "func:i32i32i32_i32" {
		t.Fatalf("details.actual = %v", e.Details["actual"])
	}
	if !strings.Contains(e.Details["expected"].(string), "i32i32i32i32_i32") {
		t.Fatalf("details.expected = %v", e.Details["expected"])
	}
	if e.Status() != http.StatusUnprocessableEntity {
		t.Fatalf("HTTP = %d，期望 422", e.Status())
	}
	assertHints(t, e)
}

func TestCheckImportsReportsFirstOffenderOnly(t *testing.T) {
	// 只报第一条问题导入：错误信封是单错误结构（确定性 = 段内顺序）。
	imports := []Import{
		{Module: "env", Name: "abort", Kind: KindFunc, Signature: "i32_"},
		{Module: limits.WasmImportModule, Name: "sock_open", Kind: KindFunc, Signature: "i32_i32"},
	}
	err := CheckImports(imports, ImportWhitelist)
	e := codeOf(t, err)
	if e.Details["symbol"] != "env.abort" {
		t.Fatalf("应报第一条: %v", e.Details)
	}
}

func TestCheckImportsMutationDroppingFDReadTurnsRed(t *testing.T) {
	// 变异验证：白名单少一条 ⇒ 合法导入被拒。生成器的 -check 与门禁测试依赖同一判据。
	full := validModule().build()
	if _, err := Validate(full); err != nil {
		t.Fatalf("基线应通过: %v", err)
	}
	var mutated []ImportSpec
	for _, spec := range ImportWhitelist {
		if spec.Name == "fd_read" {
			continue
		}
		mutated = append(mutated, spec)
	}
	_, err := ValidateWithWhitelist(full, mutated)
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportNotAllowed || !strings.Contains(e.Details["symbol"].(string), "fd_read") {
		t.Fatalf("去掉 fd_read 后应报 IMPORT_NOT_ALLOWED: %v", e.JSON())
	}
}

func TestIsAllowedImportModule(t *testing.T) {
	if !IsAllowedImportModule(limits.WasmImportModule) {
		t.Fatalf("%s 必须被允许", limits.WasmImportModule)
	}
	for _, bad := range []string{"env", "js", "wasi_unstable", "", "WASI_SNAPSHOT_PREVIEW1"} {
		if IsAllowedImportModule(bad) {
			t.Fatalf("模块 %q 不应被允许", bad)
		}
	}
}

func TestSectionName(t *testing.T) {
	if SectionName(SectionCustom) != "custom" || SectionName(SectionImport) != "import" {
		t.Fatalf("段名映射错误")
	}
	if !strings.HasPrefix(SectionName(200), "section(") {
		t.Fatalf("未知段 id 应回落到 section(<id>): %s", SectionName(200))
	}
}

func TestValidateRejectsNonFunctionImportKindNotInWhitelist(t *testing.T) {
	// 非函数导入（memory/table/global）当前白名单里没有 ⇒ 一律 IMPORT_NOT_ALLOWED。
	m := &moduleBuilder{}
	m = m.add(SectionImport, wasmVec(
		wasmImport(limits.WasmImportModule, "memory", 0x02, append([]byte{0x00}, u32(1)...)),
	))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeImportNotAllowed {
		t.Fatalf("code = %s: %v", e.Code, err)
	}
	if e.Details["kind"] != KindMemory {
		t.Fatalf("details.kind = %v", e.Details["kind"])
	}
	assertHints(t, e)
}

// ===== P0-0（2026-09-21）：计数向量与载荷的一致性 =====
//
// 修复前的形态：类型/导入/导出三个解析函数的第一行是 `make([]T, 0, n)`，n 直接来自
// 段内声明的条数且**没有任何上界**。一个 15 字节的畸形模块（段 id=2、长度=5、
// 载荷 = `ff ff ff ff 0f`，即条数 0xFFFFFFFF）就能让宿主申请 256 GiB
// （Import = 4×string = 64 B）⇒ `fatal error: out of memory`，**进程级崩溃**
// （不可 recover、gin.Recovery 无效），而这条路径在 API server 进程内
// （`compile.ValidateWasm` 明写"不发子进程"）。可复现证据见
// docs/planning/2026-09-21-wasm-platform-gap-audit-and-plan.md §3 P0-0。
//
// 判据口径：三条用例都**必须**在分配之前拒掉，而不是"分配成功但后续失败"——
// 因此这里断言错误码与 detail，且用例本身在修复前会以 OOM 结束整个测试进程
// （这正是"判据必须能被打坏"的形态：把 checkVecCount 删掉，测试二进制直接崩）。
func TestValidateRejectsOversizedVectorCounts(t *testing.T) {
	var maxCount = []byte{0xff, 0xff, 0xff, 0xff, 0x0f} // u32 0xFFFFFFFF 的 LEB128

	// 每例给出**完整且段序合法**的段序列：否则会先撞"段顺序非法"，测不到计数向量判据
	//（第一版就踩过：导出段被摆在 memory 之前，失败原因指向了别处）。
	cases := []struct {
		name     string
		sections func() *moduleBuilder
	}{
		{"类型段", func() *moduleBuilder {
			m := &moduleBuilder{}
			m = m.add(SectionType, maxCount)
			m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
			m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
			return m
		}},
		{"导入段", func() *moduleBuilder {
			m := &moduleBuilder{}
			m = m.add(SectionType, wasmVec(wasmFuncType(nil, nil)))
			m = m.add(SectionImport, maxCount)
			m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
			m = m.add(SectionExport, wasmVec(wasmExport("_start", 0x00, 0), wasmExport("memory", 0x02, 0)))
			return m
		}},
		{"导出段", func() *moduleBuilder {
			m := &moduleBuilder{}
			m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
			m = m.add(SectionExport, maxCount)
			return m
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Validate(tc.sections().build())
			e := codeOf(t, err)
			if e.Code != apperr.CodeSectionMalformed {
				t.Fatalf("code = %s（期望 %s）: %v", e.Code, apperr.CodeSectionMalformed, err)
			}
			if e.Details["declared_count"] != uint32(0xFFFFFFFF) {
				t.Fatalf("details.declared_count 应回显声明的条数，实际 %#v", e.Details["declared_count"])
			}
			if !strings.Contains(e.Message, "计数向量越界") {
				t.Fatalf("错误消息应点明计数向量越界：%s", e.Message)
			}
			assertHints(t, e)
		})
	}
}

// TestValidateCountVectorBoundary 是上一条的**边界对照**：判据是
// `n > 剩余字节数`，因此"恰好等于"必须放过这条判据、"多一条"必须命中它。
//
// 为什么需要它：没有边界对照，"把所有计数都判非法"（例如写成 n >= len(rest)）
// 也能让上面的用例通过 —— 但会误杀"1 条 1 字节"这类合法前缀。
func TestValidateCountVectorBoundary(t *testing.T) {
	build := func(typePayload []byte) []byte {
		m := &moduleBuilder{}
		m = m.add(SectionType, typePayload)
		m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
		m = m.add(SectionExport, wasmVec(
			wasmExport("_start", 0x00, 0),
			wasmExport("memory", 0x02, 0),
		))
		return m.build()
	}

	// ① 多一条：声明 2 条、只剩 1 字节 ⇒ 必须命中计数向量判据（每条至少 1 字节）。
	_, err := Validate(build(append(u32(2), 0x60)))
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed || !strings.Contains(e.Message, "计数向量越界") {
		t.Fatalf("声明 2 条但只剩 1 字节必须命中计数向量判据，实际：%s / %s", e.Code, e.Message)
	}

	// ② 恰好相等：声明 1 条、剩 1 字节 ⇒ **不得**命中计数向量判据
	//（0x60 是 functype 的起始字节，后续会因形参/结果向量缺失而失败 —— 那是别的判据）。
	_, err2 := Validate(build(append(u32(1), 0x60)))
	e2 := codeOf(t, err2)
	if e2 != nil && strings.Contains(e2.Message, "计数向量越界") {
		t.Fatalf("条数等于剩余字节数时不应命中计数向量判据：%s", e2.Message)
	}
}

// ===== P0-4（2026-09-21）：DataCount 的规范位置 =====
//
// 规范（Wasm 2.0 / bulk-memory）：DataCount(12) 位于 Element(9) 之后、Code(10) 之前。
// 修复前只做"纯 id 升序"⇒ 规范位置被拒、数值升序被 wazero 拒（真编译报
// `invalid section order`）⇒ 带 DataCount 的产物 100% 发不出去。
// 这里断言**静态侧**接受规范位置；"运行时真能编译"由 runtime 包的
// TestCompileAcceptsDataCountInCanonicalPosition 与 compile 包的
// TestDataCountSectionOrderContract 承担（三条缺一不可）。
func TestValidateAcceptsDataCountCanonicalPosition(t *testing.T) {
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(wasmFuncType(nil, nil)))
	m = m.add(SectionFunction, wasmVec(u32(0)))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
	))
	m = m.add(SectionDataCount, u32(1))                 // ← 规范位置：Element 之后、Code 之前
	m = m.add(SectionCode, wasmVec([]byte{0x00, 0x0b})) // 空体（仅 end）
	m = m.add(SectionData, wasmVec([]byte{0x00}))       // 一个主动段的占位
	if _, err := Validate(m.build()); err != nil {
		t.Fatalf("DataCount 的规范位置必须被接受，实际被拒：%v", err)
	}
}

func TestValidateRejectsMisorderedDataCount(t *testing.T) {
	// ① DataCount 出现在 Code 之后（修复前"为了满足纯升序"的唯一姿势）。
	m := &moduleBuilder{}
	m = m.add(SectionType, wasmVec(wasmFuncType(nil, nil)))
	m = m.add(SectionFunction, wasmVec(u32(0)))
	m = m.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m = m.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
	))
	m = m.add(SectionCode, wasmVec([]byte{0x00, 0x0b}))
	m = m.add(SectionDataCount, u32(1)) // ← 错位
	_, err := Validate(m.build())
	e := codeOf(t, err)
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("DataCount 排在 Code 之后必须被拒，code = %s: %v", e.Code, err)
	}

	// ② DataCount 出现在 Element 之前但它自己已晚于其他段（例如紧跟 Data 之后重复）
	m2 := &moduleBuilder{}
	m2 = m2.add(SectionType, wasmVec(wasmFuncType(nil, nil)))
	m2 = m2.add(SectionFunction, wasmVec(u32(0)))
	m2 = m2.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m2 = m2.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
	))
	m2 = m2.add(SectionData, wasmVec([]byte{0x00}))
	m2 = m2.add(SectionDataCount, u32(1)) // ← 在 Data(11) 之后
	_, err2 := Validate(m2.build())
	e2 := codeOf(t, err2)
	if e2.Code != apperr.CodeSectionMalformed {
		t.Fatalf("DataCount 排在 Data 之后必须被拒，code = %s: %v", e2.Code, err2)
	}

	// ③ 正对照：DataCount 在 Element 之后、Code 之前（与 ① 的差别只有位置）
	m3 := &moduleBuilder{}
	m3 = m3.add(SectionType, wasmVec(wasmFuncType(nil, nil)))
	m3 = m3.add(SectionFunction, wasmVec(u32(0)))
	m3 = m3.add(SectionMemory, wasmVec(append([]byte{0x00}, u32(1)...)))
	m3 = m3.add(SectionExport, wasmVec(
		wasmExport("_start", 0x00, 0),
		wasmExport("memory", 0x02, 0),
	))
	m3 = m3.add(SectionElement, wasmVec()) // 空 Element 段（规范上 DataCount 之前）
	m3 = m3.add(SectionDataCount, u32(1))
	m3 = m3.add(SectionCode, wasmVec([]byte{0x00, 0x0b}))
	m3 = m3.add(SectionData, wasmVec([]byte{0x00}))
	if _, err := Validate(m3.build()); err != nil {
		t.Fatalf("Element → DataCount → Code → Data 必须被接受：%v", err)
	}
}
