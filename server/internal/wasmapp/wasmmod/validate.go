package wasmmod

import (
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// SignatureFormatDoc 是**规范化类型签名**的稳定格式说明（写进生成产物头部、SKILL 与错误文案）。
//
// 格式：形参类型短名依次拼接 + "_" + 结果类型短名依次拼接。
// 值类型短名：i32 / i64 / f32 / f64 / v128 / funcref / externref（未知类型写作 t<两位十六进制>）。
//
//	无结果：以 "_" 结尾，如 `i32_`
//	无参无结果：`_`
//	非函数导入：memory `mem:<min>..<max>`、table `table:<elemtype>:<min>..<max>`、
//	            global `global:<valtype>[:mut]`（无上限写作 ∞）
//
// 例：`fd_write(i32,i32,i32,i32) -> i32` 写作 `i32i32i32i32_i32`——§8 的错误示例用的就是这个格式。
// 该串是**跨版本契约**：生成器、门禁测试与白名单比对都逐字依赖它，改动必须同步重跑生成器。
const SignatureFormatDoc = `形参类型短名串 + "_" + 结果类型短名串（i32/i64/f32/f64/v128/funcref/externref；` +
	`例：fd_write(i32,i32,i32,i32)->i32 = "i32i32i32i32_i32"；无结果如 "i32_"；无参无结果 "_"）`

// ImportSpec 是导入面白名单的一条（生成产物 imports_gen.go 的元素类型，§4.2「导入面白名单」）。
type ImportSpec struct {
	Module    string
	Name      string
	Kind      string
	Signature string
}

// IsAllowedImportModule 判定导入模块名是否合法（§4.2/§10.2 第 17 项：env.* / js.* 一律拒）。
func IsAllowedImportModule(module string) bool {
	return module == limits.WasmImportModule
}

// LookupImport 在给定白名单里按 (module, name) 找出全部候选（生成器与门禁测试共用）。
func LookupImport(whitelist []ImportSpec, module, name string) []ImportSpec {
	var out []ImportSpec
	for _, spec := range whitelist {
		if spec.Module == module && spec.Name == name {
			out = append(out, spec)
		}
	}
	return out
}

// CheckImports 校验导入面，判据 = **符号 + 类型**（§4.2）。
//
// 三类失败（§7.4 失败语义表）：
//   - 模块名不是 limits.WasmImportModule        → IMPORT_NOT_ALLOWED
//   - 符号不在白名单                            → IMPORT_NOT_ALLOWED
//   - 符号在名单内但种类/签名不符                → IMPORT_SIGNATURE_MISMATCH
//     （details 按 §8 示例给 symbol / expected / actual）
//
// 只报**第一条**问题导入（段内顺序确定性）：错误信封是单错误结构，AI 修一条再校验一次，
// 比一次性返回 N 条更难用错（也避免错误体随产物大小膨胀）。
func CheckImports(imports []Import, whitelist []ImportSpec) error {
	for _, imp := range imports {
		symbol := imp.Module + "." + imp.Name
		if !IsAllowedImportModule(imp.Module) {
			return apperr.New(apperr.CodeImportNotAllowed,
				"导入模块名不在白名单：只允许 "+limits.WasmImportModule).
				WithDetail("symbol", symbol).
				WithDetail("module", imp.Module).
				WithDetail("allowed_module", limits.WasmImportModule).
				WithHint(hintsFor(apperr.CodeImportNotAllowed)...)
		}
		candidates := LookupImport(whitelist, imp.Module, imp.Name)
		if len(candidates) == 0 {
			return apperr.New(apperr.CodeImportNotAllowed,
				"导入符号不在白名单：平台只放行参考实现实际用到的 WASI 符号").
				WithDetail("symbol", symbol).
				WithDetail("module", imp.Module).
				WithDetail("name", imp.Name).
				WithDetail("kind", imp.Kind).
				WithDetail("signature", imp.Signature).
				WithHint(hintsFor(apperr.CodeImportNotAllowed,
					"不要直接调用 WASI（如 sock_open / path_open / fd_prestat_*）：平台不挂文件系统、不挂网络",
					"宿主能力请通过 stdin/stdout 的 JSON-RPC 调用（db.* / log / assets.read），它们不是 wasm 导入")...)
		}
		matched := false
		expected := make([]string, 0, len(candidates))
		for _, c := range candidates {
			if c.Kind == imp.Kind && c.Signature == imp.Signature {
				matched = true
				break
			}
			expected = append(expected, c.Kind+":"+c.Signature)
		}
		if !matched {
			// 编译期不报、实例化才炸（§10.2 第 18 项实测）⇒ 必须在静态校验里拦住。
			return apperr.New(apperr.CodeImportSignatureMismatch, "导入符号类型不符").
				WithDetail("symbol", symbol).
				WithDetail("expected", strings.Join(expected, " | ")).
				WithDetail("actual", imp.Kind+":"+imp.Signature).
				WithHint(hintsFor(apperr.CodeImportSignatureMismatch)...)
		}
	}
	return nil
}

// Validate 是上传期（validate / publish）的**静态校验入口**（§4.2 validate 行）。
//
// 判据顺序（先便宜后昂贵）：
//  1. 模块体积 ≤ limits.WasmMaxBytes                    → WASM_TOO_LARGE
//  2. 段表自解析（魔数/版本/层/长度越界）                  → SECTION_MALFORMED / COMPONENT_MODEL_UNSUPPORTED
//  3. 自定义段总量 ≤ limits.SectionTotalMaxBytes         → SECTION_OVERRIDE_OVERSIZE
//  4. 导出面必须含 limits.RequiredExports（额外导出忽略）  → VALIDATE_FAILED
//  5. 导入面白名单（符号 + 类型）                          → IMPORT_NOT_ALLOWED / IMPORT_SIGNATURE_MISMATCH
//
// ✅ 取舍（设计文档内部不一致，这里按 §7.4 失败语义表实现）：
// §4.2 的表格把"自定义段超限"写作 `SECTION_OVERSIZE`，而 §7.4 失败语义表（以及 §10.2 第 20 项）
// 写作 `SECTION_OVERRIDE_OVERSIZE`（HTTP 422）。错误码唯一真源是 §7.4，故本实现返回
// apperr.CodeSectionOverrideOversize；apperr 同时保留了 CodeSectionOversize 常量（未被本包使用）。
//
// 本函数**不含**编译与干跑：那两步（§4.2"一次真实编译 + 合成帧干跑"）由运行时模块在同进程、
// 同配额下完成；静态校验只负责"编译之前就能判定的判据"。
func Validate(data []byte) (*ModuleInfo, error) {
	return ValidateWithWhitelist(data, ImportWhitelist)
}

// ValidateWithWhitelist 用**给定**白名单执行完整校验。
//
// 业务代码一律用 Validate（它绑定生成产物 ImportWhitelist）；本函数存在的唯一理由是生成器自举：
// 生成器需要先 dump 出新导入集，再用"新清单"验证参考实现本身自洽（此时包级白名单可能尚未更新）。
// 也可用于测试里做变异验证（换一份缺项白名单 ⇒ 校验必须变红）。
func ValidateWithWhitelist(data []byte, whitelist []ImportSpec) (*ModuleInfo, error) {
	if len(data) > limits.WasmMaxBytes {
		return nil, apperr.Newf(apperr.CodeWasmTooLarge,
			"wasm 模块 %d 字节超过上限 %d 字节", len(data), limits.WasmMaxBytes).
			WithDetail("size", len(data)).
			WithDetail("limit", limits.WasmMaxBytes).
			WithHint("平台上限是 32 MiB：请内联资源是必要的，但不要把大块二进制塞进自定义段",
				"静态资源应走 picoaide.app.json 声明的 assets（≤ 4 MiB 自定义段），而不是重复内嵌")
	}
	info, err := Parse(data)
	if err != nil {
		return nil, err
	}

	// 自定义段总量（§4.2：4 MiB）。口径 = **会计入资源集的**自定义段负载字节和
	// （含段名字段），取保守值：名字字段也确确实实进内存，判宽了就等于放宽了 §4.2 的实测依据。
	//
	// ⚠️ `.debug_*` 前缀族**不计入**（2026-09-21 审计修复）：它们在发布期被丢弃
	// （`assets.SplitSections` 从不保留 ⇒ 不进资源集、不可能被静态直出、`assets.read`
	// 读不到），却是真实工具链的**默认**产出。计入的后果是同一模块两个数 ——
	// 资产口径通过、段总量口径超限，而提示说的是"请压缩资源"，作者只能按错的数改。
	// 判据的唯一实现是 `assets.CountsTowardSectionBudget`（Parse 侧调用它累加），
	// 作者侧脚本 `pack-assets.mjs` 的 `countsTowardSectionBudget` 与它逐字节对拍。
	// 注意这条**不是取消预算**：非 `.debug_*` 的段超过 4 MiB 仍然照拒
	// （TestSectionBudgetStillRejectsOversizeAssets）。
	if info.CustomBytes > limits.SectionTotalMaxBytes {
		e := apperr.Newf(apperr.CodeSectionOverrideOversize,
			"自定义段总量 %d 字节超过上限 %d 字节", info.CustomBytes, limits.SectionTotalMaxBytes).
			WithDetail("custom_bytes", info.CustomBytes).
			WithDetail("limit", limits.SectionTotalMaxBytes)
		if names := customSectionNames(info); len(names) > 0 {
			e.WithDetail("sections", names)
		}
		return nil, e.WithHint(
			"自定义段是内嵌资源的载体，上限 4 MiB：请压缩资源或改用更小的字体子集",
			"用 `wasm-objdump -h <file>.wasm` 或本包的 ExtractCustomSections 查看各段大小")
	}

	// 导出面（§4.2）：必须含 limits.RequiredExports；额外导出忽略（Rust 会多一个 __main_void）。
	var missing []string
	wrongKind := map[string]string{}
	for _, name := range limits.RequiredExports {
		kind, ok := info.ExportKinds[name]
		switch {
		case !ok:
			missing = append(missing, name)
		case name == "memory" && kind != KindMemory:
			wrongKind[name] = kind
		case name == "_start" && kind != KindFunc:
			wrongKind[name] = kind
		}
	}
	if len(missing) > 0 || len(wrongKind) > 0 {
		e := apperr.New(apperr.CodeValidateFailed, "导出面不满足应用契约").
			WithDetail("required", append([]string{}, limits.RequiredExports...)).
			WithDetail("exports", info.Exports)
		if len(missing) > 0 {
			e.WithDetail("missing", missing)
		}
		if len(wrongKind) > 0 {
			e.WithDetail("wrong_kind", wrongKind)
		}
		if info.MemoryDeclared && !info.MemoryExported {
			// §4.2 原话："memory 必须是导出而非仅声明"。
			e.WithDetail("memory_declared", true).WithDetail("memory_exported", false)
		}
		hints := []string{
			"入口必须是导出的 `_start`（Go/Rust 的 wasip1 command 产物默认满足；手写 wat 请显式导出）",
			"`memory` 必须是**导出**的线性内存，仅声明不够（裁剪导出或自定义 linker script 最容易踩）",
		}
		return nil, e.WithHint(hints...)
	}

	// 导入面（符号 + 类型）。
	if err := CheckImports(info.Imports, whitelist); err != nil {
		return nil, err
	}
	return info, nil
}

// customSectionNames 返回自定义段的名字清单（诊断用，顺序 = 文件顺序、去重）。
func customSectionNames(info *ModuleInfo) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range info.Sections {
		if s.ID != SectionCustom || seen[s.Name] {
			continue
		}
		seen[s.Name] = true
		out = append(out, s.Name)
	}
	return out
}
