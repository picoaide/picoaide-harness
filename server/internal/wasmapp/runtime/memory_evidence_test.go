package runtime

// 本文件是 **R2-DG-1**（第二轮对抗式审计 · 诊断区域）的行为级护栏：
// "一次性巨块分配被打死"必须与"分块累积到 OOM"一样归到 RUNTIME_MEMORY。
//
// 缺陷现场（审计实测，Go 1.26.5 / wazero v1.12.0，tip 3e490f2fb2）：
//
//   - 双条件（退出码 2 + 峰值贴近上限）只覆盖**分块累积**形态；
//   - **一次性巨块**（`/alloc?mib=62`，上限 64 MiB）峰值恒为 3.4 MiB（= 上限的 5.1%）
//     ⇒ 双条件不成立 ⇒ 归成 RUNTIME_GUEST_EXIT，hints 把作者引向"检查 os.Exit/panic"
//     （方向错），而平台记录的 peak_memory_bytes 反过来"证明"不是内存问题；
//   - `errors.go` 里认账的兜底（"靠 stderr 头部的 fatal error: out of memory"）**不可达**：
//     特征串在字节 0–76，而平台只留末尾 2 KiB（随后全是 goroutine 回溯）。
//
// 修法：stderr 缓冲改为"有界开头 + 有界尾巴"（开头窗口只给分类器，不进诊断面），
// 分类器在"退出码 2 且没有峰值证据"时用头部特征串判定（details 里回 oom_evidence）。
//
// 变异验证（把实现改回去，用例必红）：
//   - 去掉 tailBuffer 的开头窗口（Head() 返回空）⇒ TestServe_OneShotAllocOOMIsRuntimeMemory 红、
//     TestClassifyOneShotOOMUsesStderrHead 的 "stderr_head" 分支红；
//   - 去掉 classifyGuestError 的 5b 分支 ⇒ TestServe_OneShotAllocOOMIsRuntimeMemory 红
//     （RUNTIME_GUEST_EXIT ≠ RUNTIME_MEMORY）。

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/sys"
)

// TestServe_OneShotAllocOOMIsRuntimeMemory 是 R2-DG-1 的核心判据（真 guest、真运行时）。
//
// 判据四段（缺一不可）：
//  1. **夹具前提**：这一次失败必须落在"峰值不贴上限"的形态（否则证明不了头部判据）；
//  2. 失败码必须是 RUNTIME_MEMORY（旧实现给 RUNTIME_GUEST_EXIT）；
//  3. 明细必须自证判据来源（`oom_evidence=stderr_head`）——不是别的原因蒙对的；
//  4. hints 必须指向"一次性分配"（旧实现指向 os.Exit/panic，方向相反）。
func TestServe_OneShotAllocOOMIsRuntimeMemory(t *testing.T) {
	const pages = 1024 // 64 MiB
	rt, err := New(context.Background(), Options{MemoryPages: pages})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()
	cm, err := rt.CompileModule(context.Background(), guestBinary(t, "app"))
	if err != nil {
		t.Fatalf("CompileModule: %v", err)
	}

	// 62 MiB 一次性分配 vs 64 MiB 上限（审计实测的形态：分配根本没成功，峰值只有常态水位）。
	req := testRequest("/alloc?mib=62", newFakeHost())
	req.Budgets = InstanceLimits{MemoryPages: pages, GuestBudget: 20 * time.Second}
	res := serveCompiled(t, rt, cm, req)

	if res.KillReason == nil {
		t.Fatalf("62 MiB 一次性分配在 64 MiB 上限下必须失败（夹具失效）: %+v", res.Response)
	}
	limit := int64(pages) * int64(limits.WasmPageSize)
	// ① 夹具前提：峰值**不**贴近上限 ⇒ 双条件那条路径不成立。
	if res.Metrics.PeakMemory*10 >= limit*memoryNearLimitRatio {
		t.Fatalf("夹具形态不对：峰值 %d 已贴近上限 %d（那是分块累积形态，证明不了头部判据）",
			res.Metrics.PeakMemory, limit)
	}
	// ② 失败码。
	if res.KillReason.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("一次性巨块 OOM 必须归 RUNTIME_MEMORY，得到 %s (%s)（方向错：作者会被引向 os.Exit/panic）",
			res.KillReason.Code, res.KillReason.Message)
	}
	// ③ 判据来源可自证。
	if got := res.KillReason.Details["oom_evidence"]; got != "stderr_head" {
		t.Fatalf("明细必须回 oom_evidence=stderr_head（证明是头部特征串判出来的，不是峰值），得到 %v；details=%v",
			got, res.KillReason.Details)
	}
	if got := res.KillReason.Details["guest_exit_code"]; got != uint32(goOOMExitCode) {
		t.Fatalf("明细应回 guest_exit_code=2，得到 %v", got)
	}
	// ④ hints 方向：必须说"一次性分配"，不得再出现"检查 os.Exit"这种反向提示。
	joined := strings.Join(res.KillReason.Hints, "\n")
	if !strings.Contains(joined, "一次性") {
		t.Fatalf("hints 必须指向一次性分配：%v", res.KillReason.Hints)
	}
	if strings.Contains(joined, "os.Exit") {
		t.Fatalf("hints 不得把真实的内存超限引向 os.Exit：%v", res.KillReason.Hints)
	}
	t.Logf("一次性巨块 OOM：code=%s peak=%d(%.1f%% 上限) exit=%d stderr 尾巴 %d 字节 head=%q",
		res.KillReason.Code, res.Metrics.PeakMemory,
		100*float64(res.Metrics.PeakMemory)/float64(limit), res.Metrics.GuestExitCode,
		len(res.Metrics.StderrTail), res.KillReason.Details["stderr_head"])
}

// TestTailBufferKeepsHeadAndTailBounded：stderr 缓冲必须同时保留**有界开头**与**有界尾巴**，
// 且两者都不超过上限（诊断面只收尾巴，开头只给分类器）。
//
// 变异：把 Write 里的 head 分支去掉 ⇒ 本用例红。
func TestTailBufferKeepsHeadAndTailBounded(t *testing.T) {
	const max = 64
	b := newTailBuffer(max)
	if _, err := b.Write(bytes.Repeat([]byte("H"), max)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if _, err := b.Write(bytes.Repeat([]byte("T"), 200)); err != nil {
		t.Fatalf("Write: %v", err)
	}
	head, tail := b.Head(), b.Tail()
	if len(head) > max || len(tail) > max {
		t.Fatalf("开头/尾巴都必须有界：head=%d tail=%d 上限=%d", len(head), len(tail), max)
	}
	if !strings.HasPrefix(head, "HHHH") {
		t.Fatalf("开头窗口必须保留**前**若干字节（OOM 特征串在这里）：%q", head)
	}
	if strings.Contains(head, "T") {
		t.Fatalf("开头窗口不得被后续写入覆盖：%q", head)
	}
	if !strings.HasSuffix(tail, "TTTT") || strings.Contains(tail, "H") {
		t.Fatalf("尾巴必须只保留**末尾**内容：%q", tail)
	}
}

// TestClassifyOneShotOOMUsesStderrHead 是 5b 分支的**单元级**边界表：
// 逐条钉住"什么时候用头部特征串、什么时候不用"，包括反向用例（不许扩大误报面）。
func TestClassifyOneShotOOMUsesStderrHead(t *testing.T) {
	const pages = 1024 // 64 MiB
	limit := int64(pages) * int64(limits.WasmPageSize)
	lowPeak := limit / 20 // 5% 上限 = 审计实测的一次性巨块水位
	nearPeak := limit     // 100% 上限 = 分块累积形态

	cases := []struct {
		name       string
		code       uint32
		peak       int64
		head       string
		wantCode   apperr.Code
		wantDetail string // oom_evidence 的期望值（"" = 不得出现）
	}{
		{"一次性格块+头部证据 ⇒ MEMORY", 2, lowPeak, "runtime: out of memory: cannot allocate 65011712-byte block\nfatal error: out of memory\n", apperr.CodeRuntimeMemory, "stderr_head"},
		{"分块累积+峰值证据 ⇒ MEMORY（不带头部证据）", 2, nearPeak, "", apperr.CodeRuntimeMemory, ""},
		{"exit(2) 且无任何证据 ⇒ GUEST_EXIT（不许误报）", 2, lowPeak, "bye\n", apperr.CodeRuntimeGuestExit, ""},
		{"exit(7) 即便 stderr 写了 out of memory ⇒ GUEST_EXIT（特征串只对码 2 生效）", 7, lowPeak, "out of memory\n", apperr.CodeRuntimeGuestExit, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := classifyGuestError(sys.NewExitError(tc.code), failureContext{
				memoryPages:     pages,
				peakMemoryBytes: tc.peak,
				stderrHead:      tc.head,
			})
			if e == nil {
				t.Fatal("非零退出不得映射成 nil（会被当成成功）")
			}
			if e.Code != tc.wantCode {
				t.Fatalf("code = %s, want %s（message=%s details=%v）", e.Code, tc.wantCode, e.Message, e.Details)
			}
			got, _ := e.Details["oom_evidence"].(string)
			if got != tc.wantDetail {
				t.Fatalf("oom_evidence = %q, want %q（details=%v）", got, tc.wantDetail, e.Details)
			}
		})
	}
}
