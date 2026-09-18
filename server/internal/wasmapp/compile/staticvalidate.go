package compile

import (
	"sort"

	"github.com/picoaide/picoaide/internal/wasmapp/wasmmod"
)

// 本文件是 compile 侧对**静态校验**的接线：把 wasmmod（模块 A 的实现）适配成本包的
// StaticValidator 契约。
//
// 为什么这里**只有适配、没有第二份解析器**（2026-09-18 切换，取代此前的"最小解析器"）：
// 段表/导入/导出的解析与判据是**唯一真源**问题（§5.5「数值单一真源」的同族要求）：
// 两份实现必然漂移，而漂移的后果是"预检说能过、编译子进程说不能过"这类不可复现的
// 行为差异。wasmmod 已是权威实现（导入白名单还是**构建期由参考实现生成**的，
// 手写即门禁红），因此编译子进程与父侧预检都直接用它的结论。
//
// 本包仍然保留 StaticValidator 接口与 Report 结构，理由有二：
//  1. Report 是**父侧对外契约**（Result.Imports/Exports 的来源），不该随 wasmmod 的
//     内部类型（ModuleInfo）变动而变动；
//  2. 接口让测试可以注入"拒绝一切"的假校验器，验证错误映射路径（否则那条路径只能靠
//     构造畸形字节覆盖）。

// StaticValidator 是"编译前静态校验"的可替换接口。
//
// 生产实现 = wasmmodValidator（wasmmod.Validate 的适配器）；测试可注入假实现。
type StaticValidator interface {
	Validate(module []byte) (*Report, error)
}

// StaticValidatorHook 是父侧可选注入的静态校验器（默认 nil ⇒ 用 wasmmodValidator）。
//
// 用途仅限测试与将来的灰度替换：生产路径**总是**走 wasmmod。
var StaticValidatorHook StaticValidator

// NewValidator 返回生产用静态校验器（wasmmod 适配器）。
//
// 编译子进程（cmd/picoaide-app-compile）与父侧 ValidateWasm 都用它——两侧同一实现，
// 因此"预检通过但编译子进程拒绝"这类不一致在结构上不可能发生。
func NewValidator() StaticValidator { return wasmmodValidator{} }

// wasmmodValidator 把 wasmmod.Validate 的结果翻译成本包的 Report。
type wasmmodValidator struct{}

// Validate 调 wasmmod.Validate 并转换结果。
//
// 错误**原样透传**（不重新包装、不改码）：wasmmod 的错误已经是 §7.4 表格里的码 + §8
// 的 details/hints 形状（第一消费者是 AI）。在这里做"二次翻译"只会丢掉 hints。
func (wasmmodValidator) Validate(module []byte) (*Report, error) {
	info, err := wasmmod.Validate(module)
	if err != nil {
		return nil, err
	}
	return reportFromModuleInfo(info), nil
}

// reportFromModuleInfo 把 wasmmod 的解析结果转换成本包的 Report。
//
// 字段一一对应（无信息丢失）：
//
//	info.Imports          → Report.Imports（保持段内顺序与重复，Go 产物里 fd_write 出现两次）
//	info.Exports + Kinds  → Report.Exports（段内顺序 + 种类）
//	info.CustomBytes      → Report.CustomBytes（wasmmod 的保守口径：含段名负载）
//	info.Sections         → Report.SectionNames（含自定义段，按文件顺序）
//	info.Layer != 0       → Report.ComponentModel（wasmmod 已在 Parse 阶段拒绝，
//	                        这里保留字段是为了"解析成功但仍是组件"的防御性断言）
func reportFromModuleInfo(info *wasmmod.ModuleInfo) *Report {
	rep := &Report{
		CustomBytes:    int64(info.CustomBytes),
		ComponentModel: info.Layer != 0,
	}
	rep.Imports = make([]Symbol, 0, len(info.Imports))
	for _, im := range info.Imports {
		rep.Imports = append(rep.Imports, Symbol{
			Module:    im.Module,
			Name:      im.Name,
			Kind:      im.Kind,
			Signature: im.Signature,
		})
	}
	rep.Exports = make([]Symbol, 0, len(info.Exports))
	for _, name := range info.Exports {
		rep.Exports = append(rep.Exports, Symbol{Name: name, Kind: info.ExportKinds[name]})
	}
	rep.SectionNames = make([]string, 0, len(info.Sections))
	for _, s := range info.Sections {
		rep.SectionNames = append(rep.SectionNames, s.Name)
	}
	// 自定义段名排序输出：wasmmod 给的是 map，直接遍历会让同一模块两次校验产出
	// 不同的 Report（日志/测试会随机漂移，且难复现）。
	names := make([]string, 0, len(info.CustomSections))
	for name := range info.CustomSections {
		names = append(names, name)
	}
	sort.Strings(names)
	rep.CustomSections = names
	return rep
}

// extractCustomSections 抽出自定义段（assets 抽取用，§4.2）。
//
// 委托 wasmmod.ExtractCustomSections：它返回**复制过**的内容（可以安全地在原始
// 模块字节被释放后继续持有），且"重名取第一个"的语义在那里有明确文档。
func extractCustomSections(module []byte) (map[string][]byte, error) {
	return wasmmod.ExtractCustomSections(module)
}
