package compile

import (
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
)

// CompilerMemoryPagesEnvVar 是"编译子进程的实例内存上限"的传递通道（父侧写、子侧读）。
//
// 值 = **生效**的单实例线性内存页数（十进制，页大小 = limits.WasmPageSize）。
//
// 为什么必须传（R1-rt-7b，两个方向都实测过）：`WithMemoryLimitPages` 在**编译期**就按
// 模块**声明**的初始/最大线性内存校验（wazero 的原文：`min N pages (…) over limit of M pages (…)`）。
// 用编译期默认（64 MiB）会让控制台的 instance_memory_mb 完全不作用于发布期编译：
//
//	调小（16 MiB）：声明 18 MiB 的模块在发布期放行 ⇒ 首个请求在 16 MiB 下跑不起来
//	               （500，且被报成"平台故障"）；
//	调大（128 MiB）：声明 100 MiB 的模块被编译子进程按 64 MiB 误拒 ⇒ 应用永远发不出去，
//	               连错误文案里的数字也是过期的 64 MiB。
//
// 通道为什么是环境变量而不是子进程 flag：flag 集是跨进程契约（cmd/picoaide-app-compile
// 与本包两侧各自解析），加一个 flag 要同时改两侧；而这条参数是**部署级、进程生命周期内
// 不可变**的（它属于子进程的 wazero RuntimeConfig，与执行侧同语义："改了要重启生效"），
// 环境变量恰好表达这个语义，命名空间也与 PICOAI_COMPILE_ISOLATION 一致。
//
// ⚠️ 它**不在** compileEnvAllowlist 里：父环境里的同名变量永远不会被透传，值只可能来自
// CompileChildEnv 的显式注入（"冒充值不得生效"用例：TestCompileChildEnvCarriesEffectiveMemoryPages）。
const CompilerMemoryPagesEnvVar = "PICOAI_COMPILE_MEMORY_PAGES"

// maxCompilerMemoryPages 是 wazero 对 `WithMemoryLimitPages` 的硬上限
// （超过它 wazero 直接 panic：`memoryLimitPages invalid: N > 65536`）。
//
// 进程内的 env 是可信输入（父侧注入），但"可信"不等于"可以拿一个会让子进程 panic 的
// 值去调它"—— 非法值一律回落默认并往 stderr 记一行（部署缺陷要大声，但不该让编译不可用）。
const maxCompilerMemoryPages = 65536

// compilerMemoryPagesFromProcess 读出生效页数（子进程侧的唯一入口）。
//
// 缺失 ⇒ 编译期默认（`go test` 与手工 `-request` 排障都走这条，行为与历史一致）；
// 非法（非十进制 / 0 / 超过 wazero 硬上限）⇒ 回落默认 + stderr 记一行。
func compilerMemoryPagesFromProcess() uint32 {
	raw := strings.TrimSpace(os.Getenv(CompilerMemoryPagesEnvVar))
	if raw == "" {
		return limits.InstanceMemoryPages
	}
	n, err := strconv.ParseUint(raw, 10, 32)
	if err != nil || n == 0 || n > maxCompilerMemoryPages {
		fmt.Fprintf(os.Stderr, "picoaide-app-compile: %s=%q 非法（应为 1–%d 页）⇒ 回落编译期默认 %d 页（%d MiB）\n",
			CompilerMemoryPagesEnvVar, raw, maxCompilerMemoryPages,
			limits.InstanceMemoryPages, limits.InstanceMemoryPages*limits.WasmPageSize>>20)
		return limits.InstanceMemoryPages
	}
	return uint32(n)
}

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
//
// 页数取**生效值**（R1-rt-7b）：子进程从 CompilerMemoryPagesEnvVar 读到装配侧注入的
// instance_memory_mb，读不到才回落编译期默认。它**不进缓存键**，所以"编译期与执行期
// 上限不同"不会让缓存分叉；两侧同值的意义是"发布期能过的模块，执行期也能起来"。
func NewCompilerRuntimeConfig() wazero.RuntimeConfig {
	return NewCompilerRuntimeConfigFor(compilerMemoryPagesFromProcess())
}

// NewCompilerRuntimeConfigFor 是显式页数版本（页数 = 生效的单实例线性内存上限）。
//
// 页数 0 或超过 wazero 硬上限时回落编译期默认（与 compilerMemoryPagesFromProcess 同一判据）：
// 调用方（子进程 main）拿不到装配侧的值时不该 panic，也不该让编译不可用。
func NewCompilerRuntimeConfigFor(memoryPages uint32) wazero.RuntimeConfig {
	if memoryPages == 0 || memoryPages > maxCompilerMemoryPages {
		memoryPages = limits.InstanceMemoryPages
	}
	return wazero.NewRuntimeConfig().
		// §4.3 / §15.1 第 1 条：不开则 context 超时完全不生效（实测）。
		// ★ 这一项进缓存键，是两侧一致性里最要紧的一条。
		WithCloseOnContextDone(true).
		// §4.3（R22）：单实例线性内存上限 = **生效值**（默认 64 MiB）。
		// 该标志**不进键**，因此它对缓存命中与否没有影响；但两侧保持同值才能让
		// "模块声明的初始内存"这条校验在发布期与执行期给出同一个结论。
		WithMemoryLimitPages(memoryPages)
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
