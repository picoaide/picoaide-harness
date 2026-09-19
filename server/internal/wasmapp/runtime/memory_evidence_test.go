package runtime

// 本文件是 **R2-DG-1 + 第三轮对抗审计 C 区** 的行为级护栏（运行时诊断面）：
//
//   - R2-DG-1：「一次性巨块分配被打死」必须与「分块累积到 OOM」一样归到 RUNTIME_MEMORY；
//   - P2-1：这件事**不能**取决于应用在 OOM 前往 stderr 打了多少日志。旧实现的判据绑在
//     "stderr 开头 2 KiB 窗口"上（审计实测：noise=2100/4096 ⇒ 退回 RUNTIME_GUEST_EXIT，
//     hints 把作者引向"检查 os.Exit"，方向错）⇒ 现在改为**滚动匹配**（常量内存）；
//   - P2-2：普通 panic 的消息里含 "out of memory"（非恶意，例如包装上游错误串）**不得**
//     被判成平台内存事故 —— panic 与运行时 OOM 共用退出码 2，所以判据只能是**运行时形态
//     的特征行**（行首 + 排除 panic 行），不是裸子串；
//   - P3-3：单次巨量 stderr 写入不得让尾部缓冲的常驻容量放大（"stderr 缓冲上限"这一
//     宣称必须真实成立）。
//
// 变异验证（把实现改回去，用例必红 —— 本轮实跑过，日志见 temp/wasm-review-r1/fix-round3-C.md）：
//   - 判据改回"stderr 开头窗口 / 裸子串"⇒ TestServe_OOMClassificationSurvivesStderrNoise
//     与 TestServe_PanicMessageContainingOOMPhraseStaysGuestExit 红；
//   - 尾部缓冲改回 append 后 b.buf[:0] 截断 ⇒ TestTailBufferCapsRetainedCapacity 红；
//   - 去掉 5b 分支 ⇒ TestServe_OneShotAllocOOMIsRuntimeMemory 红。

import (
	"bytes"
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero/sys"
)

// serveOneShot 用 64 MiB 上限跑一条请求（一次性巨块 OOM 的固定夹具）。
func serveOneShot(t *testing.T, path string) *Result {
	t.Helper()
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
	req := testRequest(path, newFakeHost())
	req.Budgets = InstanceLimits{MemoryPages: pages, GuestBudget: 30 * time.Second}
	return serveCompiled(t, rt, cm, req)
}

// TestServe_OneShotAllocOOMIsRuntimeMemory 是 R2-DG-1 的核心判据（真 guest、真运行时）。
//
// 判据五段（缺一不可）：
//  1. **夹具前提**：这一次失败必须落在"峰值不贴上限"的形态（否则证明不了特征行判据）；
//  2. 失败码必须是 RUNTIME_MEMORY（旧实现给 RUNTIME_GUEST_EXIT）；
//  3. 明细必须自证判据来源（oom_evidence=stderr_oom_line + 命中行原文）——不是别的原因蒙对的；
//  4. **落库证据**（P3-1）必须已写进 CallMetrics.Evidence 且有界；
//  5. hints 必须指向"一次性分配"（旧实现指向 os.Exit/panic，方向相反）。
func TestServe_OneShotAllocOOMIsRuntimeMemory(t *testing.T) {
	const pages = 1024 // 64 MiB
	res := serveOneShot(t, "/alloc?mib=62")

	if res.KillReason == nil {
		t.Fatalf("62 MiB 一次性分配在 64 MiB 上限下必须失败（夹具失效）: %+v", res.Response)
	}
	limit := int64(pages) * int64(limits.WasmPageSize)
	// ① 夹具前提：峰值**不**贴近上限 ⇒ 双条件那条路径不成立。
	if res.Metrics.PeakMemory*10 >= limit*memoryNearLimitRatio {
		t.Fatalf("夹具形态不对：峰值 %d 已贴近上限 %d（那是分块累积形态，证明不了特征行判据）",
			res.Metrics.PeakMemory, limit)
	}
	// ② 失败码。
	if res.KillReason.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("一次性巨块 OOM 必须归 RUNTIME_MEMORY，得到 %s (%s)（方向错：作者会被引向 os.Exit/panic）",
			res.KillReason.Code, res.KillReason.Message)
	}
	// ③ 判据来源可自证。
	if got := res.KillReason.Details["oom_evidence"]; got != memoryEvidenceStderrLine {
		t.Fatalf("明细必须回 oom_evidence=%s（证明是运行时特征行判出来的，不是峰值），得到 %v；details=%v",
			memoryEvidenceStderrLine, got, res.KillReason.Details)
	}
	if got, _ := res.KillReason.Details["guest_exit_code"].(uint32); got != uint32(goOOMExitCode) {
		t.Fatalf("明细应回 guest_exit_code=2，得到 %v", res.KillReason.Details["guest_exit_code"])
	}
	line, _ := res.KillReason.Details["stderr_oom_line"].(string)
	if !strings.HasPrefix(line, oomStderrMarkers[0]) {
		t.Fatalf("明细里的证据行必须是运行时的 OOM 行（以 %q 开头），得到 %q", oomStderrMarkers[0], line)
	}
	// ④ 落库证据（P3-1）：分类依据必须在**计量结构**里，否则事后查 wasm_call_events
	// 只能看到 "RUNTIME_MEMORY + peak 5%" 这幅自相矛盾的画面。
	if !strings.Contains(res.Metrics.Evidence, "kind="+memoryEvidenceStderrLine) {
		t.Fatalf("CallMetrics.Evidence 必须带上分类依据（kind=%s），得到 %q",
			memoryEvidenceStderrLine, res.Metrics.Evidence)
	}
	if len(res.Metrics.Evidence) > capapi.MaxEvidenceBytes {
		t.Fatalf("落库证据必须 ≤ %d 字节，得到 %d", capapi.MaxEvidenceBytes, len(res.Metrics.Evidence))
	}
	// ⑤ hints 方向：必须说"一次性分配"，不得再出现"检查 os.Exit"这种反向提示。
	joined := strings.Join(res.KillReason.Hints, "\n")
	if !strings.Contains(joined, "一次性") {
		t.Fatalf("hints 必须指向一次性分配：%v", res.KillReason.Hints)
	}
	if strings.Contains(joined, "os.Exit") {
		t.Fatalf("hints 不得把真实的内存超限引向 os.Exit：%v", res.KillReason.Hints)
	}
	t.Logf("一次性巨块 OOM：code=%s peak=%d(%.1f%% 上限) exit=%d stderr 尾巴 %d 字节 evidence=%q",
		res.KillReason.Code, res.Metrics.PeakMemory,
		100*float64(res.Metrics.PeakMemory)/float64(limit), res.Metrics.GuestExitCode,
		len(res.Metrics.StderrTail), res.Metrics.Evidence)
}

// TestServe_OOMClassificationSurvivesStderrNoise 是 **P2-1** 的核心判据（真 guest、真运行时）：
// 同一个一次性巨块 OOM，只改 OOM 之前写进 stderr 的**普通日志字节数**。
//
// 五档覆盖审计实测的边界（噪声必须恒被判成 RUNTIME_MEMORY）：
//
//	0      —— 仓库自带用例的形态（特征行就在最前面）
//	2026   —— 审计实测的旧窗口边界内（旧实现在这一档还是绿的）
//	2100   —— 旧实现**翻红**的第一档（特征行落出 2048 窗口）
//	4096   —— 审计现场复现档
//	64 KiB —— 远超任何"固定窗口"的量级（只有滚动匹配才成立）
func TestServe_OOMClassificationSurvivesStderrNoise(t *testing.T) {
	for _, noise := range []int{0, 2026, 2100, 4096, 64 << 10} {
		t.Run(fmt.Sprintf("noise=%d", noise), func(t *testing.T) {
			res := serveOneShot(t, fmt.Sprintf("/stderr-then-alloc?mib=62&noise=%d", noise))
			if res.KillReason == nil {
				t.Fatalf("夹具失效：noise=%d 时应当 OOM 失败", noise)
			}
			if res.KillReason.Code != apperr.CodeRuntimeMemory {
				t.Fatalf("noise=%d：真 OOM 必须恒为 RUNTIME_MEMORY，得到 %s（details=%v hints=%v）\n"+
					"（判据绑在固定窗口/子串上时，噪声会把运行时特征行挤出窗口 ⇒ 退回 GUEST_EXIT + 方向错提示）",
					noise, res.KillReason.Code, res.KillReason.Details, res.KillReason.Hints)
			}
			if !strings.Contains(res.Metrics.Evidence, "kind="+memoryEvidenceStderrLine) {
				t.Fatalf("noise=%d：证据必须记成运行时特征行，得到 %q", noise, res.Metrics.Evidence)
			}
			t.Logf("noise=%5d ⇒ %s（peak=%d，证据 %d 字节）",
				noise, res.KillReason.Code, res.Metrics.PeakMemory, len(res.Metrics.Evidence))
		})
	}
}

// TestServe_PanicMessageContainingOOMPhraseStaysGuestExit 是 **P2-2** 的核心判据：
// 未 recover 的 panic（退出码 2）消息里含 "out of memory" **不得**被判成平台内存事故。
//
// 两个形态一起钉：
//   - /panic-oom：panic 消息包装了一句上游错误串（非恶意的常见写法）；
//   - /forge-oom：应用自己打印**裸的** "out of memory" 再 os.Exit(2)（审计的伪造探针）。
//
// 两者都必须是 RUNTIME_GUEST_EXIT，且**不留任何内存证据**（details 里没有 oom_evidence、
// CallMetrics.Evidence 为空）—— 这正是"落库后可分辨"的一半（P3-1 判据②：噪声/伪造形态与
// 真 OOM 在 evidence 上可区分：真 OOM 有 kind=stderr_oom_line 且带运行时行原文，这两档没有）。
func TestServe_PanicMessageContainingOOMPhraseStaysGuestExit(t *testing.T) {
	cases := []struct{ name, path string }{
		{"panic 消息包装上游错误串", "/panic-oom"},
		{"裸 out of memory + exit(2)", "/forge-oom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := serveOneShot(t, tc.path)
			if res.KillReason == nil {
				t.Fatalf("夹具失效：%s 应当失败", tc.path)
			}
			if res.KillReason.Code != apperr.CodeRuntimeGuestExit {
				t.Fatalf("%s 必须报 RUNTIME_GUEST_EXIT（应用自己的致命错误），得到 %s；details=%v hints=%v",
					tc.path, res.KillReason.Code, res.KillReason.Details, res.KillReason.Hints)
			}
			if _, ok := res.KillReason.Details["oom_evidence"]; ok {
				t.Fatalf("判成 GUEST_EXIT 时不得带内存判据：details=%v", res.KillReason.Details)
			}
			if res.Metrics.Evidence != "" {
				t.Fatalf("非内存事故不得落库内存证据，得到 %q", res.Metrics.Evidence)
			}
			joined := strings.Join(res.KillReason.Hints, "\n")
			if strings.Contains(joined, "内存用量超过单实例上限") || strings.Contains(joined, "一次性分配") {
				t.Fatalf("非内存事故不得给『减小一次性分配』这类反向建议：%v", res.KillReason.Hints)
			}
			if !strings.Contains(joined, "os.Exit") {
				t.Fatalf("GUEST_EXIT 应保留『检查 os.Exit/致命错误』的提示：%v", res.KillReason.Hints)
			}
		})
	}
}

// TestRuntimeMarkerLineCriterionIsNotSubstring 是判据的**单元级**边界表：钉住"什么算运行时
// OOM 特征行"，尤其是"不许扩大误报面"的反向用例。
//
// 与真 guest 用例的分工：这里直接喂 stderr 字节流（扫描器），不需要 wasm 编译，跑得飞快，
// 所以能把边界钉到字节级（含跨 Write 边界的 carry）。
func TestRuntimeMarkerLineCriterionIsNotSubstring(t *testing.T) {
	realLine := "runtime: out of memory: cannot allocate 65011712-byte block (360448 in use)\n"
	cases := []struct {
		name     string
		stream   string
		wantHit  bool
		anchored bool
	}{
		{"运行时行在开头", realLine, true, true},
		{"运行时行前面有大量普通日志（审计 P2-1 的形态）",
			strings.Repeat("plain log line\n", 1000) + realLine, true, true},
		{"运行时行前是**没有换行**的半行日志（固定窗口方案漏判的另一半）",
			"progress 42%..." + strings.Replace(realLine, "\n", "", 1), true, false},
		{"fatal error: runtime: out of memory", "fatal error: runtime: out of memory\n", true, true},
		{"fatal error: out of memory", "fatal error: out of memory\n", true, true},
		{"裸 out of memory（旧判据的误报面）", "out of memory\n", false, false},
		{"panic 消息里含同名字样（非恶意）",
			"panic: tool failed: upstream returned: out of memory while reading resultset\n", false, false},
		{"panic 消息里含**完整**运行时行文本（行内，不是行首）",
			"panic: wrapped: " + realLine, false, false},
		{"panic 行之后运行时的行首特征行仍然算证据（recover 后打日志再 OOM）",
			"panic: something [recovered]\n" + realLine, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b := newTailBuffer(limits.StderrTailBytes)
			// 逐字节写：既验证流式（跨 Write 边界的 carry），也不给实现"看到整块再找"的机会。
			for i := 0; i < len(tc.stream); i++ {
				if _, err := b.Write([]byte{tc.stream[i]}); err != nil {
					t.Fatalf("Write: %v", err)
				}
			}
			hit, ok := b.OOMHit()
			if ok != tc.wantHit {
				t.Fatalf("命中 = %v, want %v（hit=%+v）", ok, tc.wantHit, hit)
			}
			if ok && hit.anchored != tc.anchored {
				t.Fatalf("anchored = %v, want %v（hit=%+v）", hit.anchored, tc.anchored, hit)
			}
		})
	}
}

// TestTailBufferCapsRetainedCapacity 是 **P3-3** 的核心判据：单次巨量写入之后，
// stderr 缓冲的**常驻容量**不得超过声明上限（旧实现 b.buf[:0] 截断不回退 cap ⇒
// 一次 8 MiB 写入让本请求常驻 8 MiB），同时匹配状态是常量级（P2-1 判据③）。
func TestTailBufferCapsRetainedCapacity(t *testing.T) {
	const max = limits.StderrTailBytes // 2048（"stderr 缓冲上限"这一宣称）
	b := newTailBuffer(max)
	if got := cap(b.buf); got > max {
		t.Fatalf("构造后就已经超上限：cap=%d > %d", got, max)
	}
	// 一次 8 MiB 写入（wazero 的 writev 把每个 iovec 整块交给 writer，所以这是可达形态）。
	big := bytes.Repeat([]byte("Z"), 8<<20)
	if _, err := b.Write(big); err != nil {
		t.Fatalf("Write: %v", err)
	}
	if got := cap(b.buf); got > max {
		t.Fatalf("单次巨量写入后常驻容量 %d 超过声明上限 %d（旧行为：cap 跟着写入量放大）", got, max)
	}
	if got := len(b.Tail()); got > max {
		t.Fatalf("尾巴长度 %d 超过上限 %d", got, max)
	}
	if !strings.HasSuffix(b.Tail(), "ZZZZ") {
		t.Fatalf("尾巴必须保留末尾内容：%q", b.Tail())
	}
	// 匹配状态必须与写入量无关（P2-1 判据③：常驻 ≤ 1 KiB）。
	if got := b.residentBytes(); got > 1<<10 {
		t.Fatalf("滚动匹配常驻 %d 字节 > 1 KiB（内存开销宣称不成立）", got)
	}
	// 正常小写入不回归：多段小写入后尾巴仍是"最后 max 字节"。
	b2 := newTailBuffer(max)
	for i := 0; i < 100; i++ {
		if _, err := b2.Write([]byte(fmt.Sprintf("line-%03d\n", i))); err != nil {
			t.Fatalf("Write: %v", err)
		}
	}
	if !strings.HasSuffix(b2.Tail(), "line-099\n") {
		t.Fatalf("小写入的尾巴语义变了：%q", b2.Tail())
	}
	if got := cap(b2.buf); got > max {
		t.Fatalf("小写入后容量 %d > %d", got, max)
	}
}

// TestClassifyOneShotOOMUsesRuntimeMarkerLine 是 5b 分支的**单元级**边界表：
// 逐条钉住"什么时候用运行时特征行、什么时候不用"，包括反向用例（不许扩大误报面）。
//
// 扫描器（tailBuffer）负责"什么算特征行"，分类器只读它的结论 —— 两条路径各有行为级用例。
func TestClassifyOneShotOOMUsesRuntimeMarkerLine(t *testing.T) {
	const pages = 1024 // 64 MiB
	limit := int64(pages) * int64(limits.WasmPageSize)
	lowPeak := limit / 20 // 5% 上限 = 审计实测的一次性巨块水位
	nearPeak := limit     // 100% 上限 = 分块累积形态

	cases := []struct {
		name       string
		code       uint32
		peak       int64
		oomLine    string
		wantCode   apperr.Code
		wantDetail string // oom_evidence 的期望值（"" = 不得出现）
	}{
		{"一次性格块+运行时特征行 ⇒ MEMORY", 2, lowPeak,
			"runtime: out of memory: cannot allocate 65011712-byte block (360448 in use)",
			apperr.CodeRuntimeMemory, memoryEvidenceStderrLine},
		{"分块累积+峰值证据 ⇒ MEMORY（判据是峰值）", 2, nearPeak, "",
			apperr.CodeRuntimeMemory, memoryEvidencePeak},
		{"exit(2) 且无任何证据 ⇒ GUEST_EXIT（不许误报）", 2, lowPeak, "",
			apperr.CodeRuntimeGuestExit, ""},
		{"exit(7) 即便有运行时特征行 ⇒ GUEST_EXIT（特征行只对码 2 生效）", 7, lowPeak,
			"runtime: out of memory", apperr.CodeRuntimeGuestExit, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := classifyGuestError(sys.NewExitError(tc.code), failureContext{
				memoryPages:       pages,
				peakMemoryBytes:   tc.peak,
				stderrOOMLine:     tc.oomLine,
				stderrOOMAnchored: true,
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
			if tc.wantCode == apperr.CodeRuntimeMemory {
				ev, _ := e.Details["evidence"].(string)
				if !strings.Contains(ev, "kind="+tc.wantDetail) {
					t.Fatalf("内存事故必须在 details 里带 evidence（否则落库面拿不到依据）：%v", e.Details)
				}
				if len(ev) > capapi.MaxEvidenceBytes {
					t.Fatalf("evidence 必须 ≤ %d 字节，得到 %d", capapi.MaxEvidenceBytes, len(ev))
				}
			}
		})
	}
}

// TestMemoryEvidenceIsBoundedAndHonest 钉住证据字段的两条性质（P3-1 判据③ + P2-2 判据④）：
// 超长/含引号换行的证据行被裁到 ≤200 字节且可读；hint 文案不再声称旧判据（"stderr 开头有
// 特征串"），改为如实描述"运行时 OOM 特征行"并指向 evidence。
func TestMemoryEvidenceIsBoundedAndHonest(t *testing.T) {
	const pages = 1024
	huge := "runtime: out of memory: cannot allocate " + strings.Repeat("9", 5000) + "-byte block"
	f := failureContext{memoryPages: pages, peakMemoryBytes: 3 << 20, stderrOOMLine: huge, stderrOOMAnchored: true}
	ev := f.memoryEvidence(memoryEvidenceStderrLine, goOOMExitCode)
	if len(ev) > capapi.MaxEvidenceBytes {
		t.Fatalf("证据必须 ≤ %d 字节，得到 %d：%q", capapi.MaxEvidenceBytes, len(ev), ev)
	}
	e := classifyGuestError(sys.NewExitError(goOOMExitCode), f)
	detail, _ := e.Details["stderr_oom_line"].(string)
	if len(detail) > oomMarkerLineBytes+len("…") { // 200 + 省略号（stderrFirstLine 的截断标记）
		t.Fatalf("信封里的证据行必须有界，得到 %d 字节", len(detail))
	}
	joined := strings.Join(e.Hints, "\n")
	if !strings.Contains(joined, "特征行") {
		t.Fatalf("hint 必须说明判据是运行时的 OOM 特征行：%v", e.Hints)
	}
	if strings.Contains(joined, "stderr 开头有") {
		t.Fatalf("hint 不得再声称旧判据（滚动匹配下『stderr 开头有特征串』已不成立）：%v", e.Hints)
	}
	if !strings.Contains(joined, "evidence") {
		t.Fatalf("hint 必须指向 evidence（判据来源可自证）：%v", e.Hints)
	}
}
