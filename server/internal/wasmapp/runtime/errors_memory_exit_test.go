package runtime

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/sys"
)

// 本文件是 **R1-e2e-1** 的护栏：内存超限必须报 `RUNTIME_MEMORY`（并给出正确 hints），
// 而不是永远落进 `RUNTIME_GUEST_EXIT(exit 2)`。
//
// 现场（真机实测）：`instance_memory_mb` 默认 64 MiB 时，`hog?mb=80` ⇒ HTTP 500
// `{"code":"RUNTIME_GUEST_EXIT","details":{"guest_exit_code":2}}`，而诊断里
// `peak_memory_bytes=67108864`（**正是上限**）—— 文档承诺的 `RUNTIME_MEMORY` 对 Go
// （Tier 1 语言）应用不可达，且 GUEST_EXIT 的 hints 把作者引向"检查 os.Exit/panic"（方向错）。
//
// 判据为什么必须是**双条件**（退出码 2 + 峰值贴近上限）：Go 运行时 OOM 只留下一个普通的
// `proc_exit(2)`（stderr 尾巴里上万字节的 goroutine 回溯把"out of memory"特征串挤掉了），
// 单看退出码会把应用**自己**的 `os.Exit(2)` 误报成内存超限 —— 那正是本文件下半部分的
// 反例用例（真起 guest 跑一遍 os.Exit(2)，必须仍是 GUEST_EXIT）。
//
// 变异验证（实测）：把 `classifyGuestError` 的 ExitError default 分支改回"直接 GUEST_EXIT"
// ⇒ TestClassifyGoOOMUsesPeakAndLimit / TestServe_GoOOMIsReportedAsRuntimeMemory 必红；
// 把双条件去掉（只判 code==2）⇒ TestClassifyExitTwoWithLowPeakStaysGuestExit /
// TestServe_ExitCodeTwoWithLowPeakStaysGuestExit 必红。

// pages256 = 16 MiB（Go OOM 现场常用的小上限）。
const pages256 = uint32(256)

func exitErr(t *testing.T, code uint32) error {
	t.Helper()
	return sys.NewExitError(code)
}

// TestClassifyGoOOMUsesPeakAndLimit：退出码 2 + 峰值贴上限 ⇒ RUNTIME_MEMORY（含生效上限文案）。
func TestClassifyGoOOMUsesPeakAndLimit(t *testing.T) {
	const pages128 = uint32(2048) // 128 MiB
	limit := int64(pages128) * int64(limits.WasmPageSize)
	got := classifyGuestError(exitErr(t, goOOMExitCode), failureContext{
		memoryPages:     pages128,
		peakMemoryBytes: limit, // 现场实测：峰值正好等于上限
	})
	if got.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("退出码 2 + 峰值=上限 必须映射 RUNTIME_MEMORY，得到 %s：%s", got.Code, got.Message)
	}
	if !strings.Contains(got.Message, "128 MiB") {
		t.Fatalf("文案必须写**生效**上限 128 MiB，得到 %q", got.Message)
	}
	if got.Details["guest_exit_code"] != uint32(2) {
		t.Fatalf("诊断明细必须带 guest_exit_code=2，得到 %v", got.Details)
	}
	if got.Details["peak_memory_bytes"] != limit {
		t.Fatalf("诊断明细必须带 peak_memory_bytes=%d，得到 %v", limit, got.Details)
	}
	hints := strings.Join(got.Hints, " | ")
	if !strings.Contains(hints, "peak_memory_bytes") || !strings.Contains(hints, "128 MiB") {
		t.Fatalf("hints 必须把作者引向峰值与上限（而不是 os.Exit/panic），得到 %q", hints)
	}
	if strings.Contains(hints, "检查应用的 os.Exit 调用与致命错误分支") {
		t.Fatalf("内存超限不得复用 GUEST_EXIT 的 os.Exit 提示（R1-e2e-1 的方向错误），得到 %q", hints)
	}
}

// TestClassifyExitTwoWithLowPeakStaysGuestExit：**反例**（任务书点名的边界）——
// 退出码 2 但峰值很低（应用自己 os.Exit(2)）必须仍是 GUEST_EXIT。
func TestClassifyExitTwoWithLowPeakStaysGuestExit(t *testing.T) {
	defLimit := int64(limits.InstanceMemoryPages) * int64(limits.WasmPageSize) // 64 MiB
	cases := []struct {
		name string
		peak int64
	}{
		{"峰值 4 MiB（常态水位）", 4 << 20},
		{"峰值 89% 上限（阈值以下）", defLimit * 89 / 100},
		{"峰值 0（没采到 ≠ 用满了）", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := classifyGuestError(exitErr(t, 2), failureContext{peakMemoryBytes: tc.peak})
			if got.Code != apperr.CodeRuntimeGuestExit {
				t.Fatalf("退出码 2 但峰值 %d（上限 %d）必须仍是 GUEST_EXIT，得到 %s：%s",
					tc.peak, defLimit, got.Code, got.Message)
			}
			if got.Details["guest_exit_code"] != uint32(2) {
				t.Fatalf("GUEST_EXIT 明细里必须回显退出码，得到 %v", got.Details)
			}
			if !strings.Contains(strings.Join(got.Hints, " | "), "os.Exit") {
				t.Fatalf("真正的 os.Exit(2) 必须保留「检查 os.Exit」的提示，得到 %v", got.Hints)
			}
		})
	}
}

// TestClassifyGoOOMThresholdBoundary：阈值本身的边界（90% 起判内存超限）。
//
// 钉住它是因为阈值是"误报面"与"可诊断性"之间唯一的旋钮：改它就等于改判定语义。
func TestClassifyGoOOMThresholdBoundary(t *testing.T) {
	limit := int64(pages256) * int64(limits.WasmPageSize) // 16 MiB
	// 判据是 peak*10 >= limit*9（不带整数截断），所以"恰好 90%"要用上取整构造。
	atLeast90 := (limit*int64(memoryNearLimitRatio) + 9) / 10
	cases := []struct {
		peak int64
		want apperr.Code
	}{
		{atLeast90, apperr.CodeRuntimeMemory},        // 恰好跨过 90%
		{atLeast90 - 1, apperr.CodeRuntimeGuestExit}, // 差 1 字节 ⇒ 不判
		{limit, apperr.CodeRuntimeMemory},            // 100%（现场实测）
		{limit + 4096, apperr.CodeRuntimeMemory},     // 略超上限（采样与增长之间的竞态）
	}
	for _, tc := range cases {
		got := classifyGuestError(exitErr(t, goOOMExitCode),
			failureContext{memoryPages: pages256, peakMemoryBytes: tc.peak})
		if got.Code != tc.want {
			t.Errorf("峰值 %d / 上限 %d ⇒ %s，期望 %s", tc.peak, limit, got.Code, tc.want)
		}
	}
}

// TestClassifyOtherExitCodeWithHighPeakStaysGuestExit：双条件的**另一个方向** ——
// 峰值贴上限但退出码不是 2（例如应用自己 os.Exit(7) 前分配了很多）仍走 GUEST_EXIT，
// 内存超限的识别不能把任意非零退出都吞掉。
func TestClassifyOtherExitCodeWithHighPeakStaysGuestExit(t *testing.T) {
	limit := int64(pages256) * int64(limits.WasmPageSize)
	got := classifyGuestError(exitErr(t, 7), failureContext{memoryPages: pages256, peakMemoryBytes: limit})
	if got.Code != apperr.CodeRuntimeGuestExit {
		t.Fatalf("退出码 7 + 峰值=上限 必须仍是 GUEST_EXIT，得到 %s：%s", got.Code, got.Message)
	}
}

// TestServe_GoOOMIsReportedAsRuntimeMemory 是**端到端**判据（真 guest、真 runtime）。
//
// 现场形态（报告 R1-e2e-1）：Go 应用在**分块累积**数据时一路涨到上限、下一次 grow 失败
// ⇒ `proc_exit(2)`，诊断里 `peak_memory_bytes` = 上限。判据覆盖两个上限：
//
//	64 MiB（部署档位默认，= 现场 `hog?mb=80` 的形态）
//	16 MiB（控制台调小后的形态：同一份代码必须同样报 RUNTIME_MEMORY）
//
// 为什么用 `/alloc-chunks` 而不是 `/alloc`：`/alloc` 是**一次性巨块**，它的单次 grow 请求
// 一步就越限 ⇒ 线性内存在宿主侧**从未**接近上限（实测峰值恒为初始的 3.25 MiB），宿主没有
// 任何"贴近上限"的证据可用 —— 那是本判据的已知边界，写在报告里（不是本用例的判据）。
func TestServe_GoOOMIsReportedAsRuntimeMemory(t *testing.T) {
	for _, tc := range []struct {
		name  string
		pages uint32
	}{
		{"上限 64 MiB（档位默认）", uint32(limits.InstanceMemoryPages)},
		{"上限 16 MiB（控制台调小）", pages256},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rt, err := New(context.Background(), Options{MemoryPages: tc.pages})
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			defer func() { _ = rt.Close(context.Background()) }()
			cm, err := rt.CompileModule(context.Background(), guestBinary(t, "app"))
			if err != nil {
				t.Fatalf("CompileModule: %v", err)
			}
			req := testRequest("/alloc-chunks?mib=200", newFakeHost())
			req.Budgets = InstanceLimits{MemoryPages: tc.pages, GuestBudget: 10 * time.Second}
			res := serveCompiled(t, rt, cm, req)

			kill := requireKill(t, res, apperr.CodeRuntimeMemory)
			if res.Metrics.GuestExitCode != int32(goOOMExitCode) {
				t.Fatalf("计量里的 guest_exit_code 应为 %d（Go OOM 的固定形态），实际 %d",
					goOOMExitCode, res.Metrics.GuestExitCode)
			}
			limit := int64(tc.pages) * int64(limits.WasmPageSize)
			if res.Metrics.PeakMemory <= 0 || res.Metrics.PeakMemory*10 < limit*int64(memoryNearLimitRatio) {
				t.Fatalf("PeakMemory=%d 应贴近上限 %d（这是判据的第二半），stderr 首行=%q",
					res.Metrics.PeakMemory, limit, firstLine(res.Metrics.StderrTail))
			}
			if kill.Details["peak_memory_bytes"] != res.Metrics.PeakMemory {
				t.Fatalf("错误明细里的峰值 %v 应与计量一致（%d）", kill.Details["peak_memory_bytes"], res.Metrics.PeakMemory)
			}
			if want := int64(tc.pages) * int64(limits.WasmPageSize); kill.Details["memory_limit_bytes"] != want {
				t.Fatalf("错误明细里的上限 %v 应为生效值 %d", kill.Details["memory_limit_bytes"], want)
			}
			if !strings.Contains(kill.Message, fmt.Sprintf("%d MiB", limit>>20)) {
				t.Fatalf("文案必须写生效上限 %d MiB，得到 %q", limit>>20, kill.Message)
			}
			hints := strings.Join(kill.Hints, " | ")
			if !strings.Contains(hints, "peak_memory_bytes") {
				t.Fatalf("hints 必须指向峰值字段，得到 %q", hints)
			}
			// 判据精确到 **GUEST_EXIT 的原文提示**（而不是"出现 os.Exit 字样"）：
			// 新的内存 hints 里会出现"而不是 os.Exit 写错了"，那是**纠正方向**的措辞。
			if strings.Contains(hints, "检查应用的 os.Exit 调用") {
				t.Fatalf("内存超限不得复用 GUEST_EXIT 的 os.Exit 排查提示（R1-e2e-1 的方向错误），得到 %q", hints)
			}
			t.Logf("%s：code=%s peak=%d（%.0f%% of %d）exit=%d",
				tc.name, kill.Code, res.Metrics.PeakMemory,
				100*float64(res.Metrics.PeakMemory)/float64(limit), limit, res.Metrics.GuestExitCode)
		})
	}
}

// TestServe_ExitCodeTwoWithLowPeakStaysGuestExit 是上一条的**端到端反例**：
// 真 guest 调 os.Exit(2)（峰值是常态水位）⇒ 仍必须是 GUEST_EXIT，绝不能被误报成内存超限。
func TestServe_ExitCodeTwoWithLowPeakStaysGuestExit(t *testing.T) {
	req := testRequest("/exit?code=2", newFakeHost())
	res := serveCompiled(t, sharedRuntime(t), appModule(t), req)
	kill := requireKill(t, res, apperr.CodeRuntimeGuestExit)
	if res.Metrics.GuestExitCode != 2 {
		t.Fatalf("guest_exit_code 应为 2，实际 %d", res.Metrics.GuestExitCode)
	}
	limit := int64(limits.InstanceMemoryPages) * int64(limits.WasmPageSize)
	if res.Metrics.PeakMemory >= limit*9/10 {
		t.Fatalf("反例夹具失效：os.Exit(2) 的峰值 %d 已贴近上限 %d，无法区分两种形态",
			res.Metrics.PeakMemory, limit)
	}
	if !strings.Contains(strings.Join(kill.Hints, " | "), "os.Exit") {
		t.Fatalf("GUEST_EXIT 的 hints 必须保留 os.Exit 方向，得到 %v", kill.Hints)
	}
	t.Logf("os.Exit(2) 实测：peak=%d（上限 %d，远低于 90%%）⇒ code=%s",
		res.Metrics.PeakMemory, limit, kill.Code)
}
