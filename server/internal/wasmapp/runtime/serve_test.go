package runtime

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件覆盖 §7（帧协议 / 计时 / 失败语义）与 §10.3 第 24–29 项。
//
// 变异方式（把闸门改回危险默认值，用例必红）：
//   - 去掉 clock.pause()/resume() ⇒ TestServe_HostCallPausesGuestClock 红（宿主调用被算进 guest 预算）；
//   - 去掉 callHost 的 select on ctx ⇒ TestServe_HostCallOverBudgetIgnoringCtx 红（宿主忽略 ctx 时预算失效）；
//   - 去掉 handleRPC 的"返回后强制复检" ⇒ 同上（err=nil 会让失败变成成功）；
//   - 把非零退出的 ExitError 归到 RUNTIME_NO_RESPONSE ⇒ TestServe_NonZeroExitWithoutResponse 红；
//   - 去掉读帧循环里"先收到的 fatal 不被后续响应帧洗白" ⇒ TestServe_HostCallOverBudgetIgnoringCtx 红；
//   - 去掉看门狗（guestCtx 结束时关管道）⇒ TestServe_TimeoutWhileGuestBlockedOnRead 挂死（超时后不返回）。

// ===== 正常往返 =====

func TestServe_HappyPath(t *testing.T) {
	host := newFakeHost()
	res := serveApp(t, "/ok", host)
	resp := requireOK(t, res)

	if resp.Status != 200 {
		t.Fatalf("status=%d，期望 200", resp.Status)
	}
	body := bodyJSON(t, resp)
	if body["log_code"] != "" || body["db_code"] != "" {
		t.Fatalf("宿主调用不应失败: %v", body)
	}
	if body["username"] != "zhangwei" {
		t.Fatalf("身份未按帧注入: %v", body)
	}
	if !strings.Contains(body["db"].(string), `"columns":["n"]`) {
		t.Fatalf("db.query 的结果没有回到应用: %v", body["db"])
	}
	if calls := host.callList(); len(calls) != 2 || calls[0] != abi.MethodLog || calls[1] != abi.MethodDBQuery {
		t.Fatalf("宿主调用序列异常: %v", calls)
	}

	m := res.Metrics
	if m.Outcome != capapi.OutcomeOK || m.ReasonCode != "" {
		t.Fatalf("成功的计量字段异常: %+v", m)
	}
	if m.HostCalls != 2 || m.HostCallMS < 0 {
		t.Fatalf("宿主调用计量异常: %+v", m)
	}
	if m.PeakMemory <= 0 {
		t.Fatalf("PeakMemory 必须 > 0（用 Memory.Size() 估算），实际 %d", m.PeakMemory)
	}
	if m.CPUMs < 0 {
		t.Fatalf("CPUMs 必须 >= 0（guest 时间扣掉宿主时间），实际 %d", m.CPUMs)
	}
	if m.ResponseSize != int64(len(resp.Body)) || m.ResponseSize <= 0 {
		t.Fatalf("ResponseSize=%d，期望 %d", m.ResponseSize, len(resp.Body))
	}
	if m.StdoutLogs != 0 {
		t.Fatalf("正常路径不应有 stdout 日志，实际 %d", m.StdoutLogs)
	}
	if m.AppID != "test-app" || m.UserID != 10231 {
		t.Fatalf("计量里的 app/user 维度缺失: %+v", m)
	}
	t.Logf("正常往返：200，PeakMemory=%d B，CPUMs=%d ms，HostCallMS=%d ms，ResponseSize=%d",
		m.PeakMemory, m.CPUMs, m.HostCallMS, m.ResponseSize)
}

// 普通能力错误是**非致命**的：回给应用，由应用决定怎么办（§4.4）。
func TestServe_HostErrorIsNonFatal(t *testing.T) {
	host := newFakeHost()
	host.errOn[abi.MethodDBExec] = apperr.New(apperr.CodeDBDenied, "只允许单条 SELECT/INSERT/UPDATE/DELETE")
	res := serveApp(t, "/rpcerr", host)
	resp := requireOK(t, res)
	body := bodyJSON(t, resp)
	if body["host_error"] != string(apperr.CodeDBDenied) {
		t.Fatalf("应用应收到 DB_DENIED，实际 %v", body["host_error"])
	}
}

// 封闭清单在 runtime 这一层也要挡（不依赖能力实现的默认分支）。
func TestServe_UnknownHostMethodRejected(t *testing.T) {
	host := newFakeHost()
	res := serveApp(t, "/unknownmethod", host)
	resp := requireOK(t, res)
	body := bodyJSON(t, resp)
	if body["host_error"] != string(apperr.CodeNotFound) {
		t.Fatalf("未知方法应回 NOT_FOUND，实际 %v", body["host_error"])
	}
	for _, c := range host.callList() {
		if c == "net.fetch" {
			t.Fatal("清单外的方法被真的派发了（§5.1 封闭清单被绕过）")
		}
	}
}

// 宿主 panic 不得打穿：转 INTERNAL 回给应用，细节只进宿主日志。
func TestServe_HostPanicIsolated(t *testing.T) {
	host := newFakeHost()
	host.panicOn[abi.MethodAIChat] = true
	res := serveApp(t, "/hostpanic", host)
	resp := requireOK(t, res)
	body := bodyJSON(t, resp)
	if body["host_error"] != string(apperr.CodeInternal) {
		t.Fatalf("panic 应转成 INTERNAL，实际 %v", body["host_error"])
	}
	if strings.Contains(resp.Body, "pg-dsn-should-not-leak") {
		t.Fatal("宿主 panic 的内部细节泄进了应用可见的响应体")
	}
	if !strings.Contains(testRTLog.String(), "panic") {
		t.Fatal("宿主 panic 必须记进宿主日志（否则事后无法定位）")
	}
}

// §7.2：非 RS 起始的输出一律视为日志，不污染 ABI。
func TestServe_StdoutLogsDoNotPolluteABI(t *testing.T) {
	host := newFakeHost()
	res := serveApp(t, "/logs", host)
	resp := requireOK(t, res)
	if resp.Status != 200 {
		t.Fatalf("status=%d", resp.Status)
	}
	if res.Metrics.StdoutLogs != 2 {
		t.Fatalf("StdoutLogs=%d，期望 2（两条非帧输出行；stderr 不计入）", res.Metrics.StdoutLogs)
	}
	body := bodyJSON(t, resp)
	if body["log_code"] != "" {
		t.Fatalf("日志行之后的宿主调用应正常: %v", body)
	}
}

// stderr 尾巴：只保留末尾 limits.StderrTailBytes 字节。
func TestServe_StderrTailBounded(t *testing.T) {
	res := serveApp(t, "/stderr", newFakeHost())
	requireOK(t, res)
	tail := res.Metrics.StderrTail
	if len(tail) > limits.StderrTailBytes {
		t.Fatalf("stderr 尾巴 %d 字节超过上限 %d", len(tail), limits.StderrTailBytes)
	}
	if !strings.Contains(tail, "[stderr-11]") {
		t.Fatalf("尾巴必须保留**末尾**内容，实际 %q", tail)
	}
	if strings.Contains(tail, "[stderr-00]") {
		t.Fatalf("尾巴不应保留开头内容（说明没有按上限截断）: %q", tail)
	}
	t.Logf("stderr 尾巴 %d 字节，末尾标记 [stderr-11] 在", len(tail))
}

// ===== §10.3 第 24 项：死循环 =====

func TestServe_InfiniteLoopTimeout(t *testing.T) {
	const budget = 700 * time.Millisecond
	req := testRequest("/timeout", newFakeHost())
	req.Budgets.GuestBudget = budget
	start := time.Now()
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	elapsed := time.Since(start)
	requireKill(t, res, apperr.CodeRuntimeTimeout)
	if res.Metrics.Outcome != capapi.OutcomeKilled {
		t.Fatalf("超时的 outcome 应为 killed，实际 %s", res.Metrics.Outcome)
	}
	if elapsed < budget {
		t.Fatalf("耗时 %s 短于预算 %s（说明不是「预算到点」而是别的失败）", elapsed, budget)
	}
	if elapsed > budget+3*time.Second {
		t.Fatalf("耗时 %s 远超预算 %s：总耗时必须接近 guest 预算而不是无限", elapsed, budget)
	}
	t.Logf("死循环：预算 %s，实测总耗时 %s", budget, elapsed)
}

// 纯 wasm 死循环（不经 Go 运行时）也必须被同一预算收掉。
func TestServe_RawWasmInfiniteLoopTimeout(t *testing.T) {
	const budget = 500 * time.Millisecond
	start := time.Now()
	res := serveRaw(t, rawInfiniteLoopModule(), InstanceLimits{GuestBudget: budget})
	elapsed := time.Since(start)
	requireKill(t, res, apperr.CodeRuntimeTimeout)
	if elapsed > budget+3*time.Second {
		t.Fatalf("纯 wasm 死循环耗时 %s 远超预算 %s", elapsed, budget)
	}
	t.Logf("纯 wasm 死循环：预算 %s，实测 %s", budget, elapsed)
}

// ===== §10.3 第 25 项：无限递归（栈耗尽，宿主必须存活）=====

func TestServe_InfiniteRecursionHostSurvives(t *testing.T) {
	// 用小内存上限（16 MiB）让"递归吃光线性内存"在秒级发生：Go 的 goroutine 栈在
	// 线性内存里，递归会一路 grow 到上限。
	//
	// 实测（Go 1.26.5 / wazero v1.12.0，64 MiB 上限）：递归约 6 s 后 Go 运行时 OOM，
	// 走 proc_exit(2)（stderr 里有 "runtime: out of memory"）——**不是** wasm 栈溢出
	// 陷阱；真正的 wasm 栈溢出由 TestServe_WasmStackOverflow 用手写模块覆盖。
	rt, err := New(context.Background(), Options{MemoryPages: 256})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()
	cm, err := rt.CompileModule(context.Background(), guestBinary(t, "app"))
	if err != nil {
		t.Fatalf("CompileModule: %v", err)
	}

	req := testRequest("/recurse", newFakeHost())
	req.Budgets = InstanceLimits{MemoryPages: 256, GuestBudget: 20 * time.Second}
	start := time.Now()
	res := serveCompiled(t, rt, cm, req)
	if res.KillReason == nil {
		t.Fatalf("无限递归必须失败，实际成功（response=%+v）", res.Response)
	}
	switch res.KillReason.Code {
	case apperr.CodeRuntimeGuestExit, apperr.CodeRuntimeMemory, apperr.CodeRuntimeTrap:
	default:
		t.Fatalf("无限递归的错误码应为 GUEST_EXIT/MEMORY/TRAP 之一，实际 %s (%s)",
			res.KillReason.Code, res.KillReason.Message)
	}
	t.Logf("Go 无限递归实测：code=%s exit=%d peak=%d 耗时=%s stderr=%q",
		res.KillReason.Code, res.Metrics.GuestExitCode, res.Metrics.PeakMemory,
		time.Since(start).Round(time.Millisecond), firstLine(res.Metrics.StderrTail))

	// 宿主必须存活：紧接着再跑一次正常请求。
	requireOK(t, serveApp(t, "/ok", newFakeHost()))
}

// 真正的 wasm 栈溢出（手写自递归模块）⇒ RUNTIME_TRAP，宿主存活。
func TestServe_WasmStackOverflow(t *testing.T) {
	res := serveRaw(t, rawRecursiveModule(), InstanceLimits{GuestBudget: 5 * time.Second})
	requireKill(t, res, apperr.CodeRuntimeTrap)
	if !strings.Contains(res.KillReason.Error(), "stack overflow") {
		t.Fatalf("内部原因应可见 stack overflow: %v", res.KillReason)
	}
	if res.Metrics.GuestExitCode != 0 {
		t.Fatalf("栈溢出不应被记成 guest 退出码（实际 %d）", res.Metrics.GuestExitCode)
	}
	// 宿主存活。
	requireOK(t, serveApp(t, "/ok", newFakeHost()))
}

// RUNTIME_TRAP：unreachable（手写模块，判据确定）。
func TestServe_UnreachableTrap(t *testing.T) {
	res := serveRaw(t, rawUnreachableModule(), InstanceLimits{GuestBudget: 3 * time.Second})
	requireKill(t, res, apperr.CodeRuntimeTrap)
	if !strings.Contains(res.KillReason.Error(), "unreachable") {
		t.Fatalf("内部原因应可见 unreachable: %v", res.KillReason)
	}
	if res.KillReason.Status() != 500 {
		t.Fatalf("RUNTIME_TRAP 的 HTTP 语义应为 500（§7.4），实际 %d", res.KillReason.Status())
	}
}

// ===== §10.3 第 27/28 项：内存超限 / Go 运行时 OOM =====

// OOM 的真实形态（实测）：Go 运行时在内存增长失败时 `fatal error: out of memory`
// 并 proc_exit(2) ⇒ 映射 RUNTIME_GUEST_EXIT(2)，**绝不报成 RUNTIME_NO_RESPONSE**。
func TestServe_MemoryGrowOverLimit(t *testing.T) {
	rt, err := New(context.Background(), Options{MemoryPages: 256}) // 16 MiB
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()
	cm, err := rt.CompileModule(context.Background(), guestBinary(t, "app"))
	if err != nil {
		t.Fatalf("CompileModule: %v", err)
	}
	req := testRequest("/alloc?mib=24", newFakeHost())
	req.Budgets = InstanceLimits{MemoryPages: 256, GuestBudget: 10 * time.Second}
	res := serveCompiled(t, rt, cm, req)

	if res.KillReason == nil {
		t.Fatalf("24 MiB 堆在 16 MiB 上限下必须失败，实际成功: %+v", res.Response)
	}
	switch res.KillReason.Code {
	case apperr.CodeRuntimeGuestExit, apperr.CodeRuntimeMemory:
	default:
		t.Fatalf("内存超限应映射 GUEST_EXIT 或 RUNTIME_MEMORY，实际 %s (%s)",
			res.KillReason.Code, res.KillReason.Message)
	}
	if res.KillReason.Code == apperr.CodeRuntimeNoResponse {
		t.Fatal("内存超限被误报成 RUNTIME_NO_RESPONSE（§10.3 第 28 项明确禁止）")
	}
	t.Logf("内存超限实测：code=%s exit=%d peak=%d stderr 尾巴 %d 字节，首行=%q",
		res.KillReason.Code, res.Metrics.GuestExitCode, res.Metrics.PeakMemory,
		len(res.Metrics.StderrTail), firstLine(res.Metrics.StderrTail))
	// ⚠️ 实测现象（Go 1.26.5 / wazero v1.12.0）：Go 运行时 OOM 时 stderr 先打
	// "runtime: out of memory… / fatal error: out of memory"，随后是**上万字节的
	// goroutine 回溯**；2 KiB 的尾巴里只剩回溯 ⇒ **退出码 2 才是 OOM 的可靠判据**
	// （§4.9 的诊断面同时回 exit code 与 stderr 尾巴，正是为此）。
	if res.Metrics.GuestExitCode != 2 {
		t.Fatalf("实测 Go 运行时 OOM 的退出码是 2（proc_exit(2)），实际记录 %d", res.Metrics.GuestExitCode)
	}
	if len(res.Metrics.StderrTail) == 0 {
		t.Fatal("stderr 尾巴不应为空（OOM 时 Go 运行时会输出诊断）")
	}
	if len(res.Metrics.StderrTail) > limits.StderrTailBytes {
		t.Fatalf("stderr 尾巴 %d 字节超过上限 %d", len(res.Metrics.StderrTail), limits.StderrTailBytes)
	}
	if res.Metrics.PeakMemory <= 0 || res.Metrics.PeakMemory > 256*limits.WasmPageSize {
		t.Fatalf("PeakMemory=%d 超出 16 MiB 上限或未采集", res.Metrics.PeakMemory)
	}
}

// 声明式内存超限在**编译期**就被拒（wazero：min N pages over limit of M pages）。
func TestCompileModule_MemoryDeclarationOverLimit(t *testing.T) {
	rt := sharedRuntime(t)
	_, err := rt.CompileModule(context.Background(), rawDeclaredMemoryModule(limits.InstanceMemoryPages+1))
	if err == nil {
		t.Fatal("初始内存声明超上限的模块必须编译失败（§4.3 R22）")
	}
	t.Logf("声明式超限的编译错误：%v", err)
}

// 默认上限（64 MiB）下 24 MiB 堆应当成功，并采到 ≥ 24 MiB 的峰值。
func TestServe_MemoryWithinDefaultLimit(t *testing.T) {
	req := testRequest("/alloc?mib=24", newFakeHost())
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	requireOK(t, res)
	if res.Metrics.PeakMemory < 24<<20 {
		t.Fatalf("PeakMemory=%d，应至少覆盖 24 MiB 的堆", res.Metrics.PeakMemory)
	}
	t.Logf("默认上限（%s）下 24 MiB 堆：PeakMemory=%d B",
		fmtPages(limits.InstanceMemoryPages), res.Metrics.PeakMemory)
}

// ===== §7.2/§7.4：已收到合法最终响应帧 ⇒ 结论已定（审计 P2-1）=====

// TestServe_ResponseThenLingerIsConclusive 是 P2-1 的判据：应用写完**合法最终响应帧**后
// 赖着不走（自旋 5s，远超 1s 预算）时，平台必须**立刻按该响应返回成功**，而不是
// 等 guest 退出、让预算到点把答案洗成 RUNTIME_TIMEOUT。
//
// 事故形态（审计实测，修复前）：budget=1s、guest 自旋 5s ⇒ 耗时 **1.000s**、
// code=RUNTIME_TIMEOUT、**响应体被丢掉** —— 既有延迟又有错误结论，还白占 1s 执行槽。
//
// 变异方式：把 Serve 里"收到响应帧就 cancelGuest+mod.Close 并按该响应返回"的分支去掉
// （即回到"等 guest 退出 / settle"的老路径）⇒ 本用例必红（耗时变 ~1s、KillReason=RUNTIME_TIMEOUT、
// body 丢失）。
func TestServe_ResponseThenLingerIsConclusive(t *testing.T) {
	const budget = 1 * time.Second
	req := testRequest("/respond-spin?ms=5000", newFakeHost())
	req.Budgets.GuestBudget = budget

	start := time.Now()
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	elapsed := time.Since(start)

	resp := requireOK(t, res) // 成功：绝不能被报成 RUNTIME_TIMEOUT
	body := bodyJSON(t, resp)
	if body["spin_ok"] != true {
		t.Fatalf("响应体必须就是应用写出的那个响应信封，实际 %v", body)
	}
	// 延迟判据：远小于 guest 预算（本机实测 ~5ms；给到 500ms 的宽松上界，
	// 因为 CI 上首次实例化可能有冷启动抖动）。
	if elapsed >= 500*time.Millisecond {
		t.Fatalf("收到响应帧后仍等了 %s（预算 %s）：响应帧没有被当作结论，实例没有立即收敛",
			elapsed.Round(time.Millisecond), budget)
	}
	if res.Metrics.Outcome != capapi.OutcomeOK {
		t.Fatalf("计量 outcome 应为 ok，实际 %q（reason=%q）", res.Metrics.Outcome, res.Metrics.ReasonCode)
	}
	t.Logf("响应帧 + 自旋 5000ms / 预算 %s ⇒ 耗时 %s、code=成功、body=%s",
		budget, elapsed.Round(time.Millisecond), resp.Body)
}

// TestServe_LingerDoesNotChangeNoResponsePaths 是上一条的**反向对照**：
// "响应帧已到即定论"只覆盖"已经拿到答案"的那一条，其余失败语义一条都不许松动。
func TestServe_LingerDoesNotChangeNoResponsePaths(t *testing.T) {
	t.Run("无响应帧+预算耗尽=RUNTIME_TIMEOUT", func(t *testing.T) {
		req := testRequest("/timeout", newFakeHost())
		req.Budgets.GuestBudget = 300 * time.Millisecond
		res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
		requireKill(t, res, apperr.CodeRuntimeTimeout)
	})

	t.Run("无响应帧+正常退出=RUNTIME_NO_RESPONSE", func(t *testing.T) {
		req := testRequest("/silent", newFakeHost())
		res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
		requireKill(t, res, apperr.CodeRuntimeNoResponse)
		if res.Response.Status != 0 || res.Response.Body != "" {
			t.Fatalf("失败请求不得携带响应体: %+v", res.Response)
		}
	})

	t.Run("非零退出=RUNTIME_GUEST_EXIT(code)", func(t *testing.T) {
		req := testRequest("/exit?code=2", newFakeHost())
		res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
		requireKill(t, res, apperr.CodeRuntimeGuestExit)
		if res.Metrics.GuestExitCode != 2 {
			t.Fatalf("guest_exit_code 应为 2，实际 %d", res.Metrics.GuestExitCode)
		}
	})
}

// ===== §10.3 第 28 项：非零退出且无响应帧 =====

func TestServe_NonZeroExitWithoutResponse(t *testing.T) {
	req := testRequest("/exit?code=7", newFakeHost())
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	e := requireKill(t, res, apperr.CodeRuntimeGuestExit)
	if res.Metrics.GuestExitCode != 7 {
		t.Fatalf("必须从 ExitError 取到 exit code 7，实际 %d", res.Metrics.GuestExitCode)
	}
	if !strings.Contains(e.Message, "7") {
		t.Fatalf("错误文案应回显退出码: %s", e.Message)
	}
	if e.Details["guest_exit_code"] != uint32(7) {
		t.Fatalf("诊断明细应带 guest_exit_code，实际 %v", e.Details)
	}
}

// ===== §7.4 硬断言：无响应帧 =====

func TestServe_NormalExitWithoutResponse(t *testing.T) {
	req := testRequest("/silent", newFakeHost())
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	requireKill(t, res, apperr.CodeRuntimeNoResponse)
	if res.Metrics.GuestExitCode != 0 {
		t.Fatalf("正常退出不应记退出码，实际 %d", res.Metrics.GuestExitCode)
	}
	if res.KillReason.Status() != 502 {
		t.Fatalf("RUNTIME_NO_RESPONSE 应为 502（§7.4），实际 %d", res.KillReason.Status())
	}
	// 绝不返回 200。
	if res.OK() {
		t.Fatal("无响应帧被报成成功")
	}
}

// ===== §10.3 第 29 项：单行输出超限 =====

func TestServe_OutputOverrun(t *testing.T) {
	const budget = 5 * time.Second
	req := testRequest("/flood", newFakeHost())
	req.Budgets.GuestBudget = budget
	// 模块在计时**之前**取好：一次性开销（wazero 冷编译）绝不许落进"耗时必须接近预算"
	// 的窗口里。包级不变量在 helpers_test.go 的 warmUpGuestFixture（TestMain 预热）；
	// 这里显式再取一次，让本用例不依赖预热顺序。
	rt := sharedRuntime(t)
	mod := appModule(t)
	start := time.Now()
	res := serveCompiled(t, rt, mod, req)
	requireKill(t, res, apperr.CodeRuntimeOutputOverrun)
	if elapsed := time.Since(start); elapsed > budget {
		t.Fatalf("超限应在预算内被发现，实际耗时 %s", elapsed)
	}
}

// 总量方向的输出超限（单行都合法）：与单行方向是两条判据。
func TestServe_TotalOutputOverrun(t *testing.T) {
	const budget = 8 * time.Second
	req := testRequest("/spam", newFakeHost())
	req.Budgets.GuestBudget = budget
	// 同上：模块取在计时窗口之外。
	rt := sharedRuntime(t)
	mod := appModule(t)
	start := time.Now()
	res := serveCompiled(t, rt, mod, req)
	requireKill(t, res, apperr.CodeRuntimeOutputOverrun)
	if elapsed := time.Since(start); elapsed > budget {
		t.Fatalf("总量超限应在预算内被发现，实际 %s", elapsed)
	}
	if !strings.Contains(res.KillReason.Message, "总上限") {
		t.Fatalf("应命中总量判据（而不是单行判据）: %s", res.KillReason.Message)
	}
	t.Logf("总量超限：%s", res.KillReason.Message)
}

// 响应帧本身超过单帧上限（1 MiB）⇒ ErrFrameTooLarge ⇒ RUNTIME_OUTPUT_OVERRUN。
//
// ⚠️ 这条判据只需**长度前缀**（9 字节：RS + 十进制长度 + '\n'）就能触发：夹具
// （testdata/guests/app 的 /bigframe）必须边写帧头边流式写载荷，**不得先把 2 MiB
// 的响应信封物化出来** —— 物化要烧 1.2–2.4 s 的 guest CPU，而 guest 预算是**墙钟**
// 3 s ⇒ 机器一有负载，guest 光造帧就把预算烧完，宿主的判据根本来不及被触发，
// 结论被洗成 RUNTIME_TIMEOUT（2026-09-19 定位与复现：
// docs/AUDIT-2026-09-19-WASM-FRAME-LIMIT.md）。与单行/总量两条判据同款，
// 这里断言"超限必须在预算内被发现"。
func TestServe_ResponseFrameTooLarge(t *testing.T) {
	const budget = 3 * time.Second
	req := testRequest("/bigframe", newFakeHost())
	req.Budgets.GuestBudget = budget
	// 模块/运行时在计时**之前**取好（同 helpers_test.go 的 warmUpGuestFixture 口径）：
	// 一次性开销（冷编译 ~10–20 s）不得落进"超限必须在预算内被发现"的窗口里。
	rt := sharedRuntime(t)
	mod := appModule(t)
	start := time.Now()
	res := serveCompiled(t, rt, mod, req)
	requireKill(t, res, apperr.CodeRuntimeOutputOverrun)
	if !strings.Contains(res.KillReason.Message, "单帧上限") {
		t.Fatalf("应命中单帧上限判据: %s", res.KillReason.Message)
	}
	if elapsed := time.Since(start); elapsed > budget {
		t.Fatalf("单帧超限应在预算内被发现，实际耗时 %s", elapsed)
	}
}

// ===== §10.3 第 26 项：宿主函数不理会 ctx =====

func TestServe_HostCallOverBudgetIgnoringCtx(t *testing.T) {
	host := newFakeHost()
	host.blockFor[abi.MethodDBQuery] = 1500 * time.Millisecond // 故意不看 ctx

	req := testRequest("/hostblock", host) // 应用会**无视**宿主错误继续写 200 响应
	req.Budgets = InstanceLimits{
		GuestBudget: 5 * time.Second,
		HostBudgets: map[string]time.Duration{abi.MethodDBQuery: 200 * time.Millisecond},
	}
	start := time.Now()
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	elapsed := time.Since(start)

	requireKill(t, res, apperr.CodeHostCallOverBudget)
	if res.KillReason.Status() != 504 {
		t.Fatalf("HOST_CALL_OVER_BUDGET 应为 504（§7.4），实际 %d", res.KillReason.Status())
	}
	if elapsed > 1200*time.Millisecond {
		t.Fatalf("耗时 %s：预算硬闸没有生效（宿主阻塞 1.5s 被完整等到）", elapsed)
	}
	// 应用"无视错误照样返回 200"不能把失败洗白。
	if strings.Contains(res.Response.Body, "ignored_host_error") {
		t.Fatal("宿主超预算后仍接受了应用写的响应帧（失败被报成成功）")
	}
	t.Logf("宿主忽略 ctx 阻塞 1.5s、预算 200ms：实测 %s 返回 %s", elapsed, res.KillReason.Code)
}

// §7.3：进入宿主调用时**暂停** guest 计时（否则 ai.chat 的 30 s 会被 10 s 误杀）。
func TestServe_HostCallPausesGuestClock(t *testing.T) {
	host := newFakeHost()
	host.blockFor[abi.MethodLog] = 400 * time.Millisecond

	req := testRequest("/paused", host) // 宿主 400ms + guest 自己再忙 400ms
	req.Budgets = InstanceLimits{
		GuestBudget: 600 * time.Millisecond,
		HostBudgets: map[string]time.Duration{abi.MethodLog: 2 * time.Second},
	}
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	requireOK(t, res) // 不暂停 ⇒ guest 侧累计 800ms > 600ms ⇒ RUNTIME_TIMEOUT
	if res.Metrics.HostCallMS < 350 {
		t.Fatalf("宿主耗时计量异常: %d ms", res.Metrics.HostCallMS)
	}
}

// hostCtx 超时但宿主"恰好"在超时后返回 err=nil ⇒ 返回后强制复检必须判失败。
func TestServe_ForceRecheckAfterHostReturns(t *testing.T) {
	host := newFakeHost()
	host.blockFor[abi.MethodLog] = 300 * time.Millisecond

	req := testRequest("/ok", host)
	req.Budgets = InstanceLimits{
		GuestBudget: 5 * time.Second,
		HostBudgets: map[string]time.Duration{abi.MethodLog: 100 * time.Millisecond},
	}
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	requireKill(t, res, apperr.CodeHostCallOverBudget)
}

// ===== 看门狗：guest 卡在 fd_read 时也必须能收掉 =====

func TestServe_TimeoutWhileGuestBlockedOnRead(t *testing.T) {
	const budget = 600 * time.Millisecond
	req := testRequest("/readmore", newFakeHost()) // 读第二帧（宿主不会再写）⇒ 永久阻塞
	req.Budgets.GuestBudget = budget
	start := time.Now()
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	elapsed := time.Since(start)
	requireKill(t, res, apperr.CodeRuntimeTimeout)
	if elapsed > budget+3*time.Second {
		t.Fatalf("卡在 fd_read 的 guest 耗时 %s：看门狗没生效（关 module 打断不了阻塞的 fd_read，必须关管道）", elapsed)
	}
	t.Logf("卡在 fd_read：预算 %s，实测 %s", budget, elapsed)
}

// ===== 上游取消 =====

func TestServe_CallerCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	req := testRequest("/timeout", newFakeHost())
	req.Budgets.GuestBudget = 30 * time.Second
	go func() {
		time.Sleep(300 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	res, err := sharedRuntime(t).Serve(ctx, appModule(t), req)
	if err != nil {
		t.Fatalf("Serve: %v", err)
	}
	elapsed := time.Since(start)
	requireKill(t, res, apperr.CodeModuleKilled)
	if elapsed > 3*time.Second {
		t.Fatalf("上游取消后耗时 %s，应及时返回", elapsed)
	}
	if res.Metrics.Outcome != capapi.OutcomeKilled {
		t.Fatalf("MODULE_KILLED 的 outcome 应为 killed，实际 %s", res.Metrics.Outcome)
	}
}

// ===== 并发：每请求新实例 + 实例名唯一 =====

func TestServe_ConcurrentRequestsGetSeparateInstances(t *testing.T) {
	const n = 6
	var wg sync.WaitGroup
	results := make([]*Result, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			req := testRequest("/echo", newFakeHost())
			req.Envelope.Body = `{"i":` + string(rune('0'+i)) + `}`
			res, err := sharedRuntime(t).Serve(context.Background(), appModule(t), req)
			if err != nil {
				t.Errorf("并发 Serve(%d) 装配错误: %v", i, err)
				return
			}
			results[i] = res
		}(i)
	}
	wg.Wait()
	for i, res := range results {
		if res == nil {
			t.Fatalf("第 %d 个请求没有结果", i)
		}
		resp := requireOK(t, res)
		if !strings.Contains(resp.Body, `{\"i\":`+string(rune('0'+i))) {
			t.Fatalf("第 %d 个请求的响应串了: %s", i, resp.Body)
		}
	}
}

// ===== 装配错误 =====

func TestServe_RejectsNilArguments(t *testing.T) {
	rt := sharedRuntime(t)
	if _, err := rt.Serve(context.Background(), nil, testRequest("/ok", newFakeHost())); err == nil {
		t.Fatal("module=nil 必须报装配错误")
	}
	req := testRequest("/ok", nil)
	if _, err := rt.Serve(context.Background(), appModule(t), req); err == nil {
		t.Fatal("Funcs=nil 必须报装配错误")
	}
}

// 缺少 _start 的模块：发布期 validate 应拦下，执行期兜底报 VALIDATE_FAILED。
func TestServe_MissingStartExport(t *testing.T) {
	// 手写一个只有 memory 导出、没有 _start 的模块。
	var bin []byte
	bin = append(bin, 0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00)
	bin = append(bin, wasmSection(1, []byte{0x01, 0x60, 0x00, 0x00})...)
	bin = append(bin, wasmSection(3, []byte{0x01, 0x00})...)
	bin = append(bin, wasmSection(5, []byte{0x01, 0x00, 0x01})...)
	exp := []byte{0x01, 0x06}
	exp = append(exp, "memory"...)
	exp = append(exp, 0x02, 0x00)
	bin = append(bin, wasmSection(7, exp)...)
	body := []byte{0x00, 0x0b}
	code := []byte{0x01}
	code = append(code, uleb(uint32(len(body)))...)
	code = append(code, body...)
	bin = append(bin, wasmSection(10, code)...)

	res := serveRaw(t, bin, InstanceLimits{GuestBudget: 2 * time.Second})
	requireKill(t, res, apperr.CodeValidateFailed)
}

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
