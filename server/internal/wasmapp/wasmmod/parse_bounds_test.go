package wasmmod

import (
	"runtime"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件是 WASM-1（P1，2026-09-23 独立审计）的回归门禁：
// 段内**二级计数**（函数类型形参/结果）与**段条目计数**都必须有**常数**上界。
//
// 缺陷形态（修复前实测，复跑命令见交付报告）：
//   - `type-bomb`：32 MiB 模块（平台允许的最大体积）的类型段声明 33 554 400 个形参
//     ⇒ 宿主 RSS +590 MiB；
//   - `import-bomb`：导入段声明 33 554 392 条 ⇒ TotalAlloc **2.00 GiB**；
//   - `custom-section-bomb`：11 184 808 个最小自定义段（3 B/个）⇒ TotalAlloc **2408 MiB**；
//   全部发生在 **API server 进程内**（`POST /api/client/v2/apps/wasm/validate`
//   → api/publish.go → compile.ValidateWasm，该路径明写"不发子进程"）⇒ 任意已登录
//   员工可触发进程级内存事故。第一层修复（2026-09-21）只加了
//   "计数 ≤ 剩余载荷字节"，而单个元素在宿主侧的代价是其最小编码长度的 16–22 倍，
//   所以常数上界是**同族缺陷的第二层**。
//
// 变异验证（实跑，见交付报告）：
//   - 把 `checkCountMax` 的调用删掉（各计数回到 `len(rest)` 上界）⇒ 本文件
//     TestParseAmplificationIsBounded 与边界矩阵的"上限+1"用例全红；
//   - 把常数调到比真实工具链产物还小 ⇒ 兼容性用例
//     （TestParseAcceptsLargestRealWorldShapes）红。

// ===== 构造 wasm 模块的测试助手 =====

func boundsLEB(v uint32) []byte {
	var out []byte
	for {
		b := byte(v & 0x7f)
		v >>= 7
		if v != 0 {
			out = append(out, b|0x80)
			continue
		}
		return append(out, b)
	}
}

func boundsSection(id byte, payload []byte) []byte {
	out := []byte{id}
	out = append(out, boundsLEB(uint32(len(payload)))...)
	return append(out, payload...)
}

func boundsHeader() []byte {
	return []byte{0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00}
}

func boundsModule(sections ...[]byte) []byte {
	out := boundsHeader()
	for _, s := range sections {
		out = append(out, s...)
	}
	return out
}

// emptyFuncType 是一个空函数类型（0x60 + 形参 0 + 结果 0）：3 字节。
var emptyFuncType = []byte{0x60, 0x00, 0x00}

// typeSectionWith 构造类型段：count 条空函数类型。
func typeSectionWith(count int) []byte {
	payload := boundsLEB(uint32(count))
	for i := 0; i < count; i++ {
		payload = append(payload, emptyFuncType...)
	}
	return boundsSection(SectionType, payload)
}

// funcTypeSection 构造"1 条函数类型 + 指定形参/结果个数"的类型段（形参/结果全为 i32）。
func funcTypeSection(params, results int) []byte {
	payload := boundsLEB(1)
	payload = append(payload, 0x60)
	payload = append(payload, boundsLEB(uint32(params))...)
	for i := 0; i < params; i++ {
		payload = append(payload, 0x7f)
	}
	payload = append(payload, boundsLEB(uint32(results))...)
	for i := 0; i < results; i++ {
		payload = append(payload, 0x7f)
	}
	return boundsSection(SectionType, payload)
}

// importSectionWith 构造 count 条合法导入（module="m", name="f", kind=func, typeidx=0）。
func importSectionWith(count int) []byte {
	payload := boundsLEB(uint32(count))
	for i := 0; i < count; i++ {
		payload = append(payload, 0x01, 'm', 0x01, 'f', 0x00, 0x00)
	}
	return boundsSection(SectionImport, payload)
}

// exportSectionWith 构造 count 条合法导出（名字唯一）。
func exportSectionWith(count int) []byte {
	payload := boundsLEB(uint32(count))
	for i := 0; i < count; i++ {
		name := []byte("e" + itoaBounds(i))
		payload = append(payload, boundsLEB(uint32(len(name)))...)
		payload = append(payload, name...)
		payload = append(payload, 0x00) // kind = func
		payload = append(payload, 0x00) // index = 0
	}
	return boundsSection(SectionExport, payload)
}

func itoaBounds(v int) string {
	if v == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for v > 0 {
		i--
		buf[i] = byte('0' + v%10)
		v /= 10
	}
	return string(buf[i:])
}

// customSections 构造 count 个最小自定义段（id=0、长度 1、段名长度 0 ⇒ 3 字节/个）。
func customSections(count int) []byte {
	out := make([]byte, 0, count*3)
	for i := 0; i < count; i++ {
		out = append(out, SectionCustom, 0x01, 0x00)
	}
	return out
}

// memorySectionWith 构造 count 条 limits（32 位内存、min=0）。
func memorySectionWith(count int) []byte {
	payload := boundsLEB(uint32(count))
	for i := 0; i < count; i++ {
		payload = append(payload, 0x00, 0x00)
	}
	return boundsSection(SectionMemory, payload)
}

// requireMalformedCap 断言错误是 SECTION_MALFORMED 且**指出常数上界**（而不是
// "计数向量越界"那条结构判据 —— 两层判据的文案必须可区分，否则排障会找错病根）。
func requireMalformedCap(t *testing.T, err error, parserMax int) {
	t.Helper()
	if err == nil {
		t.Fatal("必须被拒，实际放行")
	}
	e, ok := apperr.As(err)
	if !ok {
		t.Fatalf("错误不是结构化 apperr：%v", err)
	}
	if e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("码 = %s, want SECTION_MALFORMED（%v）", e.Code, err)
	}
	if !strings.Contains(e.Message, "超过解析器上限") {
		t.Fatalf("文案必须点明常数上界（与结构判据区分）：%s", e.Message)
	}
	if got, _ := e.Details["parser_max"].(int); got != parserMax {
		t.Fatalf("details.parser_max = %v, want %d", e.Details["parser_max"], parserMax)
	}
}

// ===== 边界矩阵：恰好上限必须放行；上限+1 必须拒 =====

// TestParseCountVectorCapsAtLimitAndOver 覆盖五个计数向量的边界（WASM-1 判据）。
func TestParseCountVectorCapsAtLimitAndOver(t *testing.T) {
	cases := []struct {
		name      string
		atLimit   []byte
		overLimit []byte
		parserMax int
	}{
		{
			"类型段条目数",
			boundsModule(typeSectionWith(MaxFuncTypeEntries)),
			boundsModule(typeSectionWith(MaxFuncTypeEntries + 1)),
			MaxFuncTypeEntries,
		},
		{
			"导入段条目数",
			boundsModule(funcTypeSection(0, 0), importSectionWith(MaxImportEntries)),
			boundsModule(funcTypeSection(0, 0), importSectionWith(MaxImportEntries+1)),
			MaxImportEntries,
		},
		{
			"导出段条目数",
			boundsModule(exportSectionWith(MaxExportEntries)),
			boundsModule(exportSectionWith(MaxExportEntries + 1)),
			MaxExportEntries,
		},
		{
			"自定义段条数",
			boundsModule(customSections(MaxCustomSections)),
			boundsModule(customSections(MaxCustomSections + 1)),
			MaxCustomSections,
		},
		{
			"内存段条目数",
			boundsModule(memorySectionWith(MaxMemoryEntries)),
			boundsModule(memorySectionWith(MaxMemoryEntries + 1)),
			MaxMemoryEntries,
		},
	}
	for _, c := range cases {
		if _, err := Parse(c.atLimit); err != nil {
			t.Fatalf("%s：恰好等于上限 %d 必须放行，实得 %v", c.name, c.parserMax, err)
		}
		_, err := Parse(c.overLimit)
		requireMalformedCap(t, err, c.parserMax)
	}
}

// TestParseFuncTypeCapsAtLimitAndOver 覆盖**元素内部**二级计数（形参/结果）的边界。
func TestParseFuncTypeCapsAtLimitAndOver(t *testing.T) {
	if _, err := Parse(boundsModule(funcTypeSection(MaxFuncParams, 0))); err != nil {
		t.Fatalf("形参恰好等于上限 %d 必须放行，实得 %v", MaxFuncParams, err)
	}
	requireMalformedCap(t, parseErr(boundsModule(funcTypeSection(MaxFuncParams+1, 0))), MaxFuncParams)

	if _, err := Parse(boundsModule(funcTypeSection(0, MaxFuncResults))); err != nil {
		t.Fatalf("结果恰好等于上限 %d 必须放行，实得 %v", MaxFuncResults, err)
	}
	requireMalformedCap(t, parseErr(boundsModule(funcTypeSection(0, MaxFuncResults+1))), MaxFuncResults)
}

func parseErr(mod []byte) error {
	_, err := Parse(mod)
	return err
}

// TestParseAcceptsLargestRealWorldShapes 是**校准兼容性**判据：常数上界必须高于
// 真实工具链产物（实测最大：类型段 38 条、形参 100 个、结果 138 个、导入 35 条、
// 导出 479 条；7940 个产物扫描，复跑命令见交付报告）。
//
// 变异：把任一回常数调到真实值以下（例如 MaxFuncParams=64）⇒ 本用例红。
func TestParseAcceptsLargestRealWorldShapes(t *testing.T) {
	real := []struct {
		name string
		mod  []byte
	}{
		{"单函数 100 形参 / 138 结果（spectest 实测最大）", boundsModule(funcTypeSection(100, 138))},
		{"类型段 38 条", boundsModule(typeSectionWith(38))},
		{"导入段 35 条", boundsModule(funcTypeSection(0, 0), importSectionWith(35))},
		{"导出段 479 条", boundsModule(exportSectionWith(479))},
	}
	for _, c := range real {
		if _, err := Parse(c.mod); err != nil {
			t.Fatalf("真实工具链形态被解析器上界误杀（校准失效）：%s: %v", c.name, err)
		}
	}
}

// ===== 分配有界（WASM-1 的核心判据）=====

// TestParseAmplificationIsBounded 是 WASM-1 的**主判据**：给定"恰好合法的最大体积
// 输入"，宿主侧解析分配必须与模块体积同量级，而不是 64×。
//
// 三个 bomb 都是审计实测过形态（模块 32 MiB = limits.WasmMaxBytes）：
//   - 类型段形参向量（修复前 RSS +590 MiB）；
//   - 导入段条目向量（修复前 TotalAlloc 2.00 GiB）；
//   - 自定义段条目向量（修复前 TotalAlloc 2408 MiB，本文件新增覆盖）。
//
// 判据取 TotalAlloc delta（不含构造模块本身的开销 —— 构造发生在测量之前）：
// 上界 64 MiB 是"模块体积的 2 倍"，远低于修复前的任何一个数。
//
// 变异验证：删掉 checkCountMax 的调用 ⇒ 三个子用例全部红（分别是 590 MiB / 2.00 GiB
// / 2408 MiB，实测数据见交付报告）。
func TestParseAmplificationIsBounded(t *testing.T) {
	const (
		moduleTarget = 32 << 20 // = limits.WasmMaxBytes（平台允许的最大模块）
		allocBudget  = 64 << 20
	)

	// ① 类型段二级计数 bomb：形参个数 = 剩余载荷字节。
	{
		mod := boundsHeader()
		payload := []byte{0x01, 0x60} // 1 条 functype
		n := moduleTarget - len(mod) - 16
		payload = append(payload, boundsLEB(uint32(n))...)
		payload = append(payload, make([]byte, n)...) // 形参（i32 = 0x00 也是合法值类型字节）
		payload = append(payload, 0x00)               // 结果数 0
		mod = append(mod, boundsSection(SectionType, payload)...)
		assertBoundedAlloc(t, "类型段形参 bomb", mod, allocBudget)
	}
	// ② 导入段条目 bomb：条数 = 剩余载荷字节。
	{
		mod := boundsHeader()
		payload := []byte{}
		n := moduleTarget - len(mod) - 16
		payload = append(payload, boundsLEB(uint32(n))...)
		payload = append(payload, make([]byte, n)...)
		mod = append(mod, boundsSection(SectionImport, payload)...)
		assertBoundedAlloc(t, "导入段条目 bomb", mod, allocBudget)
	}
	// ③ 自定义段条目 bomb：11 184 808 个最小段（3 字节/个）。
	{
		mod := append(boundsHeader(), customSections((moduleTarget-len(boundsHeader()))/3)...)
		assertBoundedAlloc(t, "自定义段条目 bomb", mod, allocBudget)
	}
}

// assertBoundedAlloc 断言 Parse 一个畸形大模块时：返回结构化错误 + 分配有界。
func assertBoundedAlloc(t *testing.T, name string, mod []byte, budget uint64) {
	t.Helper()
	runtime.GC()
	var before, after runtime.MemStats
	runtime.ReadMemStats(&before)
	info, err := Parse(mod)
	runtime.ReadMemStats(&after)
	delta := after.TotalAlloc - before.TotalAlloc

	if err == nil {
		t.Fatalf("%s：畸形计数向量必须被拒（info=%v）", name, info != nil)
	}
	e, ok := apperr.As(err)
	if !ok || e.Code != apperr.CodeSectionMalformed {
		t.Fatalf("%s：必须是结构化 SECTION_MALFORMED，实得 %v", name, err)
	}
	if delta > budget {
		t.Fatalf("%s：解析分配 %d MiB 超过预算 %d MiB —— 计数上界失效（宿主侧放大回归）",
			name, delta>>20, budget>>20)
	}
	t.Logf("%s：module=%d B alloc=%d MiB err=%s", name, len(mod), delta>>20, e.Code)
}
