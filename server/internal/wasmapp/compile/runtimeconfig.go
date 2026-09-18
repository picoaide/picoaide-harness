package compile

import (
	"fmt"
	"reflect"
	"sort"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// NewCompilerRuntimeConfig 是**编译侧**的 wazero RuntimeConfig 唯一构造函数。
//
// ⚠️ 必须与 `internal/wasmapp/runtime.NewRuntimeConfig` **逐字段相同**（§4.3.1-a）：
// wazero 的磁盘编译缓存键 = sha256(moduleID ‖ magic ‖ CPU features)，而
// `moduleID = AssignModuleID(binary, listeners, ensureTermination)` ⇒
// **`WithCloseOnContextDone` 进键、`WithMemoryLimitPages` 不进键**
// （证据：docs/evidence/2026-09-17-wasm-app-platform/cache-key/，只改内存上限命中同一键
// 429b279e…；只改 CloseOnContextDone 换键 68689fd7…）。两侧不一致的后果是**静默的**：
// 发布期编译暖不到执行进程 ⇒ 每次进程重启后每个应用首个请求付一次冷编译（~1.9 s），
// 同一模块在缓存里落两份条目。
//
// 为什么本包不 import internal/wasmapp/runtime：
//  1. 依赖方向（capapi.go 的包注释）：compile 与 runtime 是同层能力实现，互相 import
//     会成环（runtime 不依赖 compile，但两侧将来都要被 api/edge 组装，横向依赖会让
//     组装顺序变成编译期约束）；
//  2. 【本模块的并行开发约束】runtime 由模块 C 并行开发，import 一个正在改动的包会让
//     本包编译状态被别人左右——而"两侧配置一致"这件事本身用**测试**保证更可靠
//     （见 consistency_test.go：源码级指纹比对，不需要 import 对方）。
//
// 因此这里显式声明本侧的配置，并在 consistency_test.go 里用反射 + 源码 AST 与
// runtime 侧对拍。**改这里必须同时改 runtime 侧，反之亦然**。
func NewCompilerRuntimeConfig() wazero.RuntimeConfig {
	return wazero.NewRuntimeConfig().
		// §4.3 / §15.1 第 1 条：不开则 context 超时完全不生效（实测）。
		// ★ 这一项进缓存键，是两侧一致性里最要紧的一条。
		WithCloseOnContextDone(true).
		// §4.3（R22）：64 MiB/实例。编译进程用它只是"顺手对齐"——
		// 该标志**不进键**，因此它对缓存命中与否没有影响；但两侧保持同值可以
		// 免掉一类"为什么这个字段不一样"的排查成本。
		WithMemoryLimitPages(limits.InstanceMemoryPages)
}

// CompilerRuntimeConfigFingerprint 返回编译侧 RuntimeConfig 的稳定指纹。
//
// 供跨包一致性测试使用（consistency_test.go 把它与 `runtime.NewRuntimeConfig()` 的
// 指纹对拍）。指纹**包含全部字段**（不止本包显式设置的两个）：wazero 新增
// RuntimeConfig 字段时，只要两侧都用 `wazero.NewRuntimeConfig()` 起手，
// 新字段的默认值会同时出现在两侧；一旦有一侧显式设置了新字段，指纹立刻不等。
func CompilerRuntimeConfigFingerprint() string {
	return configFingerprint(reflect.ValueOf(NewCompilerRuntimeConfig()))
}

// configFingerprint 渲染任意配置对象（wazero 的 runtimeConfig 是非导出结构体，
// 反射只能读不能 Interface()，所以全部通过 Kind 分支处理）。
func configFingerprint(v reflect.Value) string {
	if !v.IsValid() {
		return "<invalid>"
	}
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return fmt.Sprintf("%s(<nil>)", v.Type())
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return fmt.Sprintf("=%v", v)
	}
	t := v.Type()
	fields := make([]string, 0, t.NumField())
	for i := 0; i < t.NumField(); i++ {
		f := t.Field(i)
		fv := v.Field(i)
		if isScalarField(f.Type) {
			fields = append(fields, fmt.Sprintf("%s=%v", f.Name, valueOf(fv)))
			continue
		}
		// 非标量字段（函数值、接口如 CompilationCache）：只报"有没有设"。
		// 类型 + 是否为零值足以区分"两侧配置不同"，且不会因为指针身份不同而误报。
		fields = append(fields, fmt.Sprintf("%s=%s", f.Name, refTypeIdentity(fv)))
	}
	sort.Strings(fields)
	return t.String() + "{" + strings.Join(fields, " ") + "}"
}

// isScalarField 判断字段能否直接取值比较（避免对函数/切片/映射调 Interface()）。
func isScalarField(t reflect.Type) bool {
	switch t.Kind() {
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64,
		reflect.String, reflect.Float32, reflect.Float64:
		return true
	default:
		return false
	}
}

// valueOf 安全地取出标量字段的值（非导出字段不能用 Interface()）。
func valueOf(v reflect.Value) any {
	switch v.Kind() {
	case reflect.Bool:
		return v.Bool()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return v.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return v.Uint()
	case reflect.String:
		return v.String()
	case reflect.Float32, reflect.Float64:
		return v.Float()
	default:
		return refTypeIdentity(v)
	}
}

// refTypeIdentity 给不可比字段一个稳定标识（类型 + 是否为零值）。
func refTypeIdentity(v reflect.Value) string {
	switch v.Kind() {
	case reflect.Chan, reflect.Func, reflect.Map, reflect.Pointer, reflect.Slice, reflect.Interface:
		if v.IsNil() {
			return v.Type().String() + "(nil)"
		}
		return v.Type().String() + "(set)"
	default:
		return v.Type().String()
	}
}
