package runtime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
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
//  5. 其他 ExitError(code!=0)  → RUNTIME_GUEST_EXIT(code)（**绝不报成 RUNTIME_NO_RESPONSE**，
//     §10.3 第 28 项：Go 运行时 OOM 走 proc_exit(2)）
//  6. err==nil 且 module 已关闭 → MODULE_KILLED（§15.1 第 7 条硬断言）
//  7. err==nil 且无响应帧       → RUNTIME_NO_RESPONSE
//  8. 错误串含内存/OOM 特征     → RUNTIME_MEMORY
//  9. 其余 guest 侧错误         → RUNTIME_TRAP（unreachable / 越界 / 栈溢出…）
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
		return killError(apperr.CodeRuntimeMemory, "应用内存用量超过单实例上限（"+fmtPages(limits.InstanceMemoryPages)+"）").WithCause(err)
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
func killError(code apperr.Code, msg string) *apperr.Error {
	e := apperr.New(code, msg)
	if hints, ok := runtimeHints[code]; ok {
		e.WithHint(hints...)
	}
	return e
}

// runtimeHints 是执行侧失败码的可操作提示（与 apperr.CommonHints 同精神，按需扩展）。
var runtimeHints = map[apperr.Code][]string{
	apperr.CodeRuntimeTimeout: {
		"把重活放到宿主能力里做（db.query / ai.chat），不要在 guest 里自旋",
		"检查是否有死循环或忘了 return 的循环",
	},
	apperr.CodeRuntimeTrap: {
		"常见原因：数组越界、空指针解引用、除零、递归过深",
		"在本地用同样的 wasm 产物跑一遍（平台执行环境与本地 wasip1 一致）",
	},
	apperr.CodeRuntimeMemory: {
		"单实例线性内存上限由平台固定（" + fmtPages(limits.InstanceMemoryPages) + "），应用无法调整",
		"避免一次性把大结果集读进内存：用 db.query 的分页/聚合在宿主侧完成",
	},
	apperr.CodeRuntimeOutputOverrun: {
		"协议帧单行上限 " + fmtBytes(limits.ProtocolLineMaxBytes) + "：响应必须写成**一个** RS 帧",
		"不要在 stdout 里打印巨长的调试内容（stdout 只用于帧协议，日志请用 log 宿主函数）",
	},
	apperr.CodeRuntimeNoResponse: {
		"应用必须写出一个最终响应帧（status/headers/body）后结束",
		"不要 print 调试信息后直接 return",
	},
	apperr.CodeRuntimeGuestExit: {
		"退出码在诊断里回传（guest_exit_code）：Go 运行时 OOM 是 2",
		"检查应用的 os.Exit 调用与致命错误分支",
	},
	apperr.CodeModuleKilled: {
		"请求已被取消或实例已被关闭：通常是客户端断开、服务关停或上游超时",
	},
	apperr.CodeHostCallOverBudget: {
		"宿主调用超过了它的预算：不要在一次调用里做无界的工作",
		"预算按方法给出（ai.chat 单独 30 s）",
	},
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
func classifyInstantiateError(err error) *apperr.Error {
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
		return killError(apperr.CodeRuntimeMemory, "模块的线性内存声明超过平台上限（"+fmtPages(limits.InstanceMemoryPages)+"）").WithCause(err)
	default:
		return killError(apperr.CodeRuntimeTrap, "模块实例化失败").WithCause(err)
	}
}

// contextCauseIs 判断 guestCtx 的取消原因是否为 target（clock 用）。
func contextCauseIs(ctx context.Context, target error) bool {
	return errors.Is(context.Cause(ctx), target)
}
