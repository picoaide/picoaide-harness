package runtime

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/sys"
)

// failureContext 是"把 guest 的退出形态映射成平台错误码"所需的全部事实（§7.4）。
//
// 为什么要一个显式的事实包：失败语义**不能只看 error 值**——
//   - 超时后 wazero 返回的是 `*sys.ExitError{ExitCode: 0xffffffff}`，正常 proc_exit(0)
//     返回的是**同一个类型且 err != nil**（ExitCode 0），所以"err != nil"既不是失败
//     的充分条件也不是必要条件；
//   - "module 已关闭但 Call 返回 err=nil"必须映射成 MODULE_KILLED（§15.1 第 7 条），
//     这条只能从 module 状态读出来；
//   - 只有宿主自己知道"这次取消是我们自己的预算时钟造成的"还是"上游 ctx 被取消"。
type failureContext struct {
	// clockExpired 表示 guest 预算耗尽（本方时钟触发）。
	clockExpired bool
	// parentCanceled 表示进入 Serve 的那个 ctx 被取消（客户端断开/服务关停）。
	parentCanceled bool
	// moduleClosed 表示 module 已经处于关闭态。
	moduleClosed bool
	// hasResponse 表示已经收到合法的最终响应帧。
	hasResponse bool
	// guestBudget 是本次请求生效的 guest 预算（只用于错误文案）。
	guestBudget time.Duration
	// memoryPages 是本次运行**生效**的单实例线性内存页数（只用于错误文案；
	// 0 ⇒ 编译期默认 limits.InstanceMemoryPages）。
	//
	// 为什么必须带上它（R1-rt-7）：控制台把 instance_memory_mb 改成 128 MiB 后，
	// 错误文案若还硬写"64 MiB"，排障会被直接误导（应用作者按 64 MiB 去优化，
	// 而真实上限是 128 MiB）。文案与生效值必须同源。
	memoryPages uint32
	// peakMemoryBytes 是本次运行采样到的**线性内存峰值**（字节；0 = 没采到）。
	//
	// 为什么必须带上它（R1-e2e-1）：Go 运行时 OOM 的表现是**普通非零退出码 2**
	// （`proc_exit(2)`，实测 stderr 尾巴里只剩上万字节的 goroutine 回溯、特征串已被挤掉），
	// 只看错误串/退出码永远分不出"内存超限"与"应用自己 os.Exit(2)"。峰值是唯一能区分
	// 两者的现场证据 ⇒ 判定要"退出码 + 峰值贴近上限"**双条件**（见 memoryNearLimit）。
	peakMemoryBytes int64
	// stderrOOMLine 是 guest stderr 里**命中的运行时 OOM 特征行原文**（"" = 没命中；
	// 由 tailBuffer 的滚动扫描给出，见其 scanLocked）。
	//
	// 为什么必须带上它（R2-DG-1 + 第三轮审计 P2-1）：双条件只覆盖"分块累积到 OOM"这一种
	// 形态。**一次性巨块分配**（`make([]byte, N)` 且 N 接近上限）失败时峰值只有常态水位
	// （实测 64 MiB 上限下的 62 MiB 巨块：peak = 3.4 MiB = 上限的 5.1%），双条件因此不成立、
	// 方向被判反 —— 平台记录的 `peak_memory_bytes` 反过来"证明"不是内存问题，hints 把作者
	// 引向 os.Exit/panic。那种形态的唯一证据是运行时自己打的那一行
	// （`runtime: out of memory: cannot allocate …`），它可能出现在 stderr 的**任意位置**。
	//
	// ⚠️ 判据是"**运行时形态**的行"（行首锚定或"没有 panic 行时的行内命中"，见
	// oomStderrMarkers / scanLocked），不是裸的 "out of memory" 子串 —— 后者会把
	// `panic("… out of memory …")` 这类非恶意文本误判成平台内存事故（第三轮审计 P2-2）。
	stderrOOMLine string
	// stderrOOMAnchored 表示上面那行是否落在**行首**（运行时自己输出的形态）。
	// 它只进证据（落库/信封），不参与判定 —— 判定在扫描时已经用过这个事实。
	stderrOOMAnchored bool
}

// goOOMExitCode 是 Go 运行时内存耗尽时的退出码（实测 Go 1.26.5 / wazero v1.12.0：
// `fatal error: out of memory` 之后 proc_exit(2)，见 serve_test.go 的
// TestServe_MemoryGrowOverLimit 与 §10.3 第 28 项）。
const goOOMExitCode = 2

// memoryNearLimitRatio 是"峰值贴近上限"的判据（R1-e2e-1 的第二个条件）。
//
// 取 90% 的依据（实测，Go 1.26.5 / wazero v1.12.0）：
//
//	分块累积到 OOM：峰值 = 上限的 97%–100%（现场 R1-e2e-1：peak_memory_bytes=67108864 = 64 MiB 整）；
//	应用自己 os.Exit(2)：峰值 = 常态水位 3.25 MiB（= Go 的初始页数，远低于 90%）。
//
// 它把"退出码 2"这一个**弱判据**收窄成"退出码 2 且峰值贴着上限"的双条件，代价是
// "应用恰好在上限 90% 水位上主动 os.Exit(2)"会被误归一次 —— 用这个小误判面换回
// "内存超限可诊断"，且误归时的 hints 同时写了退出码与峰值，作者一眼能自证。
//
// ⚠️ 已知边界（曾被当成"只能认账"）：峰值 ≥ 上限 − **单次最大分配**。应用若一次性申请接近
// 上限量级的巨块，峰值可能落在 90% 以下而仍被归成 GUEST_EXIT（实测 64 MiB 上限 + 一次性
// 62 MiB 分配：退出码 2、峰值 3.4 MiB = 上限的 5.1%；而同机 60 MiB 的那次**成功**分配
// 峰值 99.2% —— 平台的记录会反过来"证明"不是内存问题）。
//
// R2-DG-1（2026-09-19）把这个边界补上了：这种形态的唯一证据是运行时自己打的
// `runtime: out of memory: cannot allocate …` 那一行，现在由 tailBuffer 的**滚动扫描**
// 取出、由 stderrOOMEvidence 参与分类（见 classifyGuestError 的第 5b 条）。双条件仍然是
// 主判据（它不需要读 guest 自带的内容），运行时特征行是"峰值没采到"时的兜底。
const memoryNearLimitRatio = 9 // peak*10 >= limit*9 ⇔ peak ≥ 90% 上限

// oomStderrMarkers 是 Go 运行时 OOM 打在 stderr 上的**运行时前缀**（实测 Go 1.26.5 /
// wazero v1.12.0，三行都来自运行时自己的 print/throw 路径）：
//
//	runtime: out of memory: cannot allocate 65011712-byte block (360448 in use)
//	fatal error: runtime: out of memory
//	fatal error: out of memory
//
// ⚠️ 这里**只收运行时形态**，不收裸的 "out of memory"（第三轮审计 P2-2 实测的误报面）：
// 未 recover 的 panic 与运行时 OOM 共用退出码 2，而 panic 的消息是应用可控文本 ——
// `panic("tool failed: upstream returned: out of memory while reading resultset")`
// 这种**非恶意**写法（包装上游错误串）会命中裸串，让平台把应用自己的致命错误说成
// "内存用量超过单实例上限"，还给出两条反向建议。
//
// 裸串的判据价值本来也有限：`memoryErrorPatterns` 里的 "over limit of"/"memory limit"
// 是 wazero 自己的错误串口径，guest stderr 里出现它们更多是应用在打印日志。
var oomStderrMarkers = []string{
	"runtime: out of memory",
	"fatal error: runtime: out of memory",
	"fatal error: out of memory",
}

// panicStderrPrefix 是 Go 打印未 recover panic 时的行首形态（`panic: <值>`）。
//
// 它的作用不是"识别 panic 再免责"，而是**收窄证据**：见过这一行之后，只有**行首**命中
// 运行时前缀才算 OOM 证据（见 tailBuffer.scanLocked）—— panic 行内的同名字样一律不算。
const panicStderrPrefix = "panic: "

// oomMarkerLastByte 是全部特征串的**末字节**（三条都以 "y" 结尾）。
//
// 它只是扫描器的性能闸门：行内子串搜索只在"刚追加的字节等于它"时做一次，否则每写一个
// 字节都要把整行扫一遍（O(行长²)）。判据本身与它无关（搜索命中的仍是完整特征串）。
const oomMarkerLastByte = 'y'

// stderrOOMEvidence 报告滚动扫描有没有取到"Go 运行时 OOM 特征行"。
//
// 判据的正确性由扫描器负责（行首锚定 + panic 排除 + 运行时前缀，见 tailBuffer.scanLocked），
// 这里只读结论。取舍（如实记，第三轮审计后仍成立的部分）：stderr 是**guest 自己写的内容**，
// 应用仍可以逐字打印运行时那一行来让平台把它的 os.Exit(2) 归成 RUNTIME_MEMORY。代价仅限于
// **这一个失败码的诊断方向**（平台不据此做任何准入/计费判定），而收益是"真实 OOM 的方向判反"
// 这条已实测发生过的缺陷被修掉；并且证据行会逐字进错误信封与调用事件（evidence 字段），
// 作者/管理员可以拿它对拍运行时的真实格式。要彻底关闭这个面只能改成"由宿主注入的分配失败
// 回调"（wazero 无此面）。
func (f failureContext) stderrOOMEvidence() bool { return f.stderrOOMLine != "" }

// memoryEvidence 是**落库/回信**用的"分类依据"（第三轮审计 P3-1）。
//
// 为什么要有它：`oom_evidence` 与命中的证据行此前只进瞬时错误信封，`wasm_call_events` 里
// 只有 reason_code/peak/exit —— 事后在诊断面看到的正是"RUNTIME_MEMORY + 峰值 3.4 MiB +
// stderr_tail 全是 goroutine 回溯"这幅自相矛盾的画面，无法分辨真 OOM / panic 误报 / 伪造。
//
// 形态（单行、字段有界、内容经既有转义）：
//
//	kind=stderr_oom_line; anchored=true; line="runtime: out of memory: cannot allocate …"; peak=3407872; limit=67108864; exit=2
//	kind=peak_near_limit; peak=67108864; limit=67108864; exit=2
//
// 证据行本身是 guest 可控文本，所以按 200 字节裁（capapi.MaxEvidenceBytes 同口径）。
func (f failureContext) memoryEvidence(kind string, code uint32) string {
	limit := int64(effectivePages(f.memoryPages)) * int64(limits.WasmPageSize)
	var b strings.Builder
	fmt.Fprintf(&b, "kind=%s; peak=%d; limit=%d; exit=%d", kind, f.peakMemoryBytes, limit, code)
	if kind == memoryEvidenceStderrLine {
		fmt.Fprintf(&b, "; anchored=%t; line=%s", f.stderrOOMAnchored, strconv.Quote(f.stderrOOMLine))
	}
	out := b.String()
	if len(out) > capapi.MaxEvidenceBytes {
		out = out[:capapi.MaxEvidenceBytes]
	}
	return out
}

// memoryEvidenceKind 的取值（也是错误信封里 `oom_evidence` 的值）：
// 判据来自运行时特征行，还是来自"峰值贴近上限"。
const (
	memoryEvidenceStderrLine = "stderr_oom_line"
	memoryEvidencePeak       = "peak_near_limit"
)

// peakNearLimit 报告"采样到的峰值是否贴近本次运行的内存上限"。
//
// 两个条件缺一不可：峰值必须 >0（没采到 ≠ 用满了）且 ≥ 上限的 memoryNearLimitRatio/10。
func (f failureContext) peakNearLimit() bool {
	if f.peakMemoryBytes <= 0 {
		return false
	}
	limit := int64(effectivePages(f.memoryPages)) * int64(limits.WasmPageSize)
	return f.peakMemoryBytes*10 >= limit*int64(memoryNearLimitRatio)
}

// effectivePages 把"生效页数"折算成可渲染值（0 = 未指定 ⇒ 编译期默认）。
func effectivePages(pages uint32) uint32 {
	if pages == 0 {
		return limits.InstanceMemoryPages
	}
	return pages
}

// classifyGuestError 把 guest 的结束形态映射成平台错误码；nil 表示"正常结束"。
//
// 判定顺序即优先级（每条都有实测依据，见 §7.4 与 §10.3）：
//
//  1. 本方预算耗尽            → RUNTIME_TIMEOUT（实测死循环在预算整点被关闭）
//  2. 上游 ctx 取消            → MODULE_KILLED
//  3. ExitError.ExitCode==0    → 正常退出（Go 的 main 返回就是 proc_exit(0)）
//  4. ExitError 的保留码       → MODULE_KILLED（wazero 用 0xffffffff/0xefffffff 表示
//     "被 ctx 关闭"，与 guest 自己的 proc_exit 区分开）
//  5. ExitError(code!=0) 且 峰值贴近上限 且 code==2 → RUNTIME_MEMORY（R1-e2e-1：
//     Go 运行时 OOM 走 proc_exit(2)，**双条件**收窄，普通 os.Exit(2) 不会被误报）
//     5b. ExitError(code==2) 且峰值**不**贴上限，但 stderr 里滚动命中了**运行时 OOM
//     特征行**（`runtime: out of memory` / `fatal error: runtime: out of memory` /
//     `fatal error: out of memory`）→ RUNTIME_MEMORY
//     （R2-DG-1：一次性巨块分配的形态，峰值只有常态水位；第三轮审计把"开头 2 KiB 窗口"
//     改成滚动匹配，并排除 panic 文本里的同名字样 —— 见 tailBuffer.scanLocked）
//  6. 其他 ExitError(code!=0)  → RUNTIME_GUEST_EXIT(code)（**绝不报成 RUNTIME_NO_RESPONSE**，
//     §10.3 第 28 项）
//  7. err==nil 且 module 已关闭 → MODULE_KILLED（§15.1 第 7 条硬断言）
//  8. err==nil 且无响应帧       → RUNTIME_NO_RESPONSE
//  9. 错误串含内存/OOM 特征     → RUNTIME_MEMORY
//  10. 其余 guest 侧错误        → RUNTIME_TRAP（unreachable / 越界 / 栈溢出…）
func classifyGuestError(err error, f failureContext) *apperr.Error {
	switch {
	case f.clockExpired:
		return killError(apperr.CodeRuntimeTimeout, fmt.Sprintf("应用超过了 %s 的 guest 预算", f.guestBudget))
	case f.parentCanceled:
		return killError(apperr.CodeModuleKilled, "请求已取消（客户端断开或服务关停），实例已被关闭")
	}

	var exitErr *sys.ExitError
	if errors.As(err, &exitErr) {
		switch code := exitErr.ExitCode(); code {
		case 0:
			// 正常退出：注意这是**非 nil 的 error**（wazero 的 exitZero 是共享值）。
			if f.hasResponse {
				return nil
			}
			return killError(apperr.CodeRuntimeNoResponse, "应用正常退出但没有返回响应帧")
		case sys.ExitCodeContextCanceled, sys.ExitCodeDeadlineExceeded:
			// 被 ctx 关闭，但不是我们的预算时钟（否则上面就返回了）⇒ 外部取消。
			return killError(apperr.CodeModuleKilled, "实例已被关闭（context 取消）")
		default:
			// 内存超限走的是**普通非零退出码**（Go 运行时 OOM = proc_exit(2)），因此
			// 必须在"非零退出"这一支里先用"退出码 + 峰值贴近上限"的双条件识别它 ——
			// 否则永远只会得到 GUEST_EXIT，而它的 hints 会把作者引向"检查 os.Exit/panic"
			// （方向错：真实原因是内存超限，R1-e2e-1 实测）。
			if code == goOOMExitCode && f.peakNearLimit() {
				limit := int64(effectivePages(f.memoryPages)) * int64(limits.WasmPageSize)
				e := killErrorPages(apperr.CodeRuntimeMemory,
					fmt.Sprintf("应用内存用量超过单实例上限（%s）", fmtPages(effectivePages(f.memoryPages))),
					f.memoryPages).WithDetail("guest_exit_code", code).
					WithDetail("peak_memory_bytes", f.peakMemoryBytes).
					WithDetail("memory_limit_bytes", limit).
					WithDetail("oom_evidence", memoryEvidencePeak).
					WithDetail("evidence", f.memoryEvidence(memoryEvidencePeak, code))
				return e.WithHint(
					fmt.Sprintf("峰值内存 %s 已达到上限的 %d%% 以上、退出码 %d（Go 运行时 OOM 的固定形态）",
						fmtBytes(int(f.peakMemoryBytes)), memoryNearLimitRatio*10, code),
					"看诊断里的 peak_memory_bytes：它贴着上限就说明是分配太多，而不是 os.Exit 写错了",
					"减小一次性分配（分页/流式处理、别把大结果集整体读进内存）；"+
						"Go 运行时自身还有数 MiB 常驻堆，留给业务数据的内存比上限小")
			}
			// 5b（R2-DG-1，第三轮审计收紧）：**一次性巨块分配**的 OOM 峰值只有常态水位
			// （分配根本没成功，采样看不到"贴近上限"），唯一证据是运行时自己打的
			// `runtime: out of memory: cannot allocate …` 那一行 —— 它可能出现在 stderr 的
			// **任意位置**（应用先打了多少日志都不影响），由 tailBuffer 的滚动扫描取出。
			// 没有这一条时，作者会拿到 RUNTIME_GUEST_EXIT + "检查 os.Exit 调用"的方向错提示
			// （实测：64 MiB 上限下 62 MiB 一次性分配、峰值 5.1%）。
			if code == goOOMExitCode && f.stderrOOMEvidence() {
				limit := int64(effectivePages(f.memoryPages)) * int64(limits.WasmPageSize)
				e := killErrorPages(apperr.CodeRuntimeMemory,
					fmt.Sprintf("应用内存用量超过单实例上限（%s）", fmtPages(effectivePages(f.memoryPages))),
					f.memoryPages).WithDetail("guest_exit_code", code).
					WithDetail("peak_memory_bytes", f.peakMemoryBytes).
					WithDetail("memory_limit_bytes", limit).
					WithDetail("oom_evidence", memoryEvidenceStderrLine).
					WithDetail("stderr_oom_line", stderrFirstLine(f.stderrOOMLine)).
					WithDetail("evidence", f.memoryEvidence(memoryEvidenceStderrLine, code))
				return e.WithHint(
					fmt.Sprintf("退出码 %d 且 stderr 出现 Go 运行时 OOM 的**特征行**（以 %q 开头；"+
						"这类**一次性巨块**分配失败时，采样到的峰值只有 %s，比上限低得多，"+
						"别被 peak_memory_bytes 误导）", code, oomStderrMarkers[0], fmtBytes(int(f.peakMemoryBytes))),
					"判据来源见 evidence 字段（kind=stderr_oom_line + 命中行原文）：它取的是运行时自己"+
						"打印的分配失败行，不是应用的 panic 文本；应用若自己打印了同名文本，"+
						"evidence 里的 line 会与之逐字一致，可据此存疑",
					"减小一次性分配：把大块拆成分页/流式处理，或改用宿主能力（db.query 的分页/聚合）",
					"Go 运行时自身还有数 MiB 常驻堆，留给业务数据的内存比上限小")
			}
			e := killError(apperr.CodeRuntimeGuestExit,
				fmt.Sprintf("应用以退出码 %d 结束且没有返回响应帧", code))
			e.WithDetail("guest_exit_code", code)
			return e
		}
	}

	if err == nil {
		switch {
		case f.moduleClosed:
			// §15.1 第 7 条：err=nil 但 module 已关闭 ⇒ 必须 MODULE_KILLED，绝不返回 200。
			return killError(apperr.CodeModuleKilled, "实例已被关闭但调用返回成功（已按被杀处理）")
		case f.hasResponse:
			return nil
		default:
			return killError(apperr.CodeRuntimeNoResponse, "应用没有返回响应帧就结束了")
		}
	}

	msg := err.Error()
	if containsAny(msg, memoryErrorPatterns) {
		return killErrorPages(apperr.CodeRuntimeMemory,
			"应用内存用量超过单实例上限（"+fmtPages(effectivePages(f.memoryPages))+"）", f.memoryPages).WithCause(err)
	}
	if containsAny(msg, trapPatterns) {
		return killError(apperr.CodeRuntimeTrap, "应用内部错误（wasm 陷阱）").WithCause(err)
	}
	if strings.Contains(msg, "runtime closed") {
		return killError(apperr.CodeModuleKilled, "运行时已关闭").WithCause(err)
	}
	return killError(apperr.CodeRuntimeTrap, "应用执行失败").WithCause(err)
}

// trapPatterns 是 wazero 陷阱类错误串的特征（公共 API 没有导出错误类型，
// internal/wasmruntime.Error 不可 import ⇒ 按错误串分类是唯一可行的判据；
// 用例见 §10.3 第 24/25 项与 RUNTIME_TRAP 一行的实现覆盖）。
var trapPatterns = []string{
	"unreachable",
	"out of bounds memory access",
	"invalid memory access",
	"invalid table access",
	"stack overflow",
	"call stack exhausted",
	"integer divide by zero",
	"integer overflow",
	"invalid conversion to integer",
	"indirect call type mismatch",
	"undefined element",
	"uninitialized element",
	"table out of bounds",
}

// memoryErrorPatterns 是"内存页超限"类错误串。
var memoryErrorPatterns = []string{
	"out of memory",
	"over limit of",
	"memory limit",
	"cannot allocate memory",
}

func containsAny(s string, patterns []string) bool {
	for _, p := range patterns {
		if strings.Contains(s, p) {
			return true
		}
	}
	return false
}

// killError 构造一个带可操作提示的失败（§7.4：第一消费者是 AI）。
// 它用编译期默认的单实例上限渲染提示；已知生效值时用 killErrorPages（R1-rt-7）。
func killError(code apperr.Code, msg string) *apperr.Error {
	return killErrorPages(code, msg, 0)
}

// killErrorPages 与 killError 同义，但按**生效**页数渲染与内存上限有关的提示（0 = 默认）。
func killErrorPages(code apperr.Code, msg string, pages uint32) *apperr.Error {
	e := apperr.New(code, msg)
	if hints := runtimeHints(code, pages); len(hints) > 0 {
		e.WithHint(hints...)
	}
	return e
}

// runtimeHints 返回执行侧失败码的可操作提示（与 apperr.CommonHints 同精神，按需扩展）。
//
// 形参 pages 是**生效**的单实例线性内存页数（0 ⇒ 编译期默认）：只有"内存上限"这一类
// 提示随它变化（R1-rt-7 的硬写 64 MiB 就是在这里被修掉的），其余提示是常量。
func runtimeHints(code apperr.Code, pages uint32) []string {
	switch code {
	case apperr.CodeRuntimeMemory:
		return []string{
			"单实例线性内存上限由平台固定（" + fmtPages(effectivePages(pages)) + "），应用无法调整",
			"避免一次性把大结果集读进内存：用 db.query 的分页/聚合在宿主侧完成",
		}
	case apperr.CodeRuntimeTimeout:
		return []string{
			"把重活放到宿主能力里做（db.query），不要在 guest 里自旋",
			"检查是否有死循环或忘了 return 的循环",
		}
	case apperr.CodeRuntimeTrap:
		return []string{
			"常见原因：数组越界、空指针解引用、除零、递归过深",
			"在本地用同样的 wasm 产物跑一遍（平台执行环境与本地 wasip1 一致）",
		}
	case apperr.CodeRuntimeOutputOverrun:
		return []string{
			"协议帧单行上限 " + fmtBytes(limits.ProtocolLineMaxBytes) + "：响应必须写成**一个** RS 帧",
			"不要在 stdout 里打印巨长的调试内容（stdout 只用于帧协议，日志请用 log 宿主函数）",
		}
	case apperr.CodeRuntimeNoResponse:
		return []string{
			"应用必须写出一个最终响应帧（status/headers/body）后结束",
			"不要 print 调试信息后直接 return",
		}
	case apperr.CodeRuntimeGuestExit:
		return []string{
			"退出码在诊断里回传（guest_exit_code）：Go 运行时 OOM 是 2",
			"检查应用的 os.Exit 调用与致命错误分支",
		}
	case apperr.CodeModuleKilled:
		return []string{
			"请求已被取消或实例已被关闭：通常是客户端断开、服务关停或上游超时",
		}
	case apperr.CodeHostCallOverBudget:
		return []string{
			"宿主调用超过了它的预算：不要在一次调用里做无界的工作",
			"预算按方法给出（limits.HostCallBudgetDefault，5 s）",
		}
	}
	return nil
}

// stderrFirstLine 取 stderr 证据里的第一行（诊断明细里只放这一行，别把 2 KiB 全塞进去）。
//
// Go 运行时 OOM 的固定形态是：第一行 `runtime: out of memory: …`，第二行
// `fatal error: out of memory` —— 第一行就足以自证，且带上了"想要多少字节"这个关键数字。
func stderrFirstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	const max = 200 // 明细字段是诊断面的一部分：一条超长行会把整个信封刷爆
	if len(s) > max {
		s = s[:max] + "…"
	}
	return s
}

func fmtBytes(n int) string {
	switch {
	case n%(1<<20) == 0:
		return fmt.Sprintf("%d MiB", n>>20)
	case n%(1<<10) == 0:
		return fmt.Sprintf("%d KiB", n>>10)
	default:
		return fmt.Sprintf("%d B", n)
	}
}

func fmtPages(pages uint32) string {
	return fmt.Sprintf("%d 页（%s）", pages, fmtBytes(int(pages)*limits.WasmPageSize))
}

// classifyInstantiateError 映射"实例化失败"。
//
// 实例化期的错误基本都是发布期 validate 应该拦下的问题（§4.2：导入签名不匹配
// **编译期全绿、实例化才炸**），执行进程只做兜底映射：
//
//	签名不匹配 ⇒ IMPORT_SIGNATURE_MISMATCH
//	内存声明超限 / OOM ⇒ RUNTIME_MEMORY
//	其余 ⇒ RUNTIME_TRAP（当作"这个模块跑不起来"）
func classifyInstantiateError(err error, memoryPages uint32) *apperr.Error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "signature mismatch"):
		e := apperr.New(apperr.CodeImportSignatureMismatch, "模块导入的函数签名与平台 ABI 不一致")
		if h, ok := apperr.CommonHints[apperr.CodeImportSignatureMismatch]; ok {
			e.WithHint(h...)
		}
		return e.WithCause(err)
	case containsAny(msg, memoryErrorPatterns):
		return killErrorPages(apperr.CodeRuntimeMemory,
			"模块的线性内存声明超过平台上限（"+fmtPages(effectivePages(memoryPages))+"）", memoryPages).WithCause(err)
	default:
		return killError(apperr.CodeRuntimeTrap, "模块实例化失败").WithCause(err)
	}
}

// contextCauseIs 判断 guestCtx 的取消原因是否为 target（clock 用）。
func contextCauseIs(ctx context.Context, target error) bool {
	return errors.Is(context.Cause(ctx), target)
}
