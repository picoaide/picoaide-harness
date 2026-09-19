package runtime

// P3-1 的行为级护栏（第三轮对抗审计 C 区）：**分类依据必须落库**。
//
// 缺陷现场：`oom_evidence` 与命中的证据行此前只进瞬时错误信封（Details），而
// `wasm_call_events`（0069）没有对应列、`fillFailureMetrics` 也不搬运 —— 事后在诊断面
// 看到的正是"自相矛盾"的那幅画面：
//
//	reason_code=RUNTIME_MEMORY + peak_memory_bytes=3407872（上限的 5.1%）
//	+ stderr_tail 全是 goroutine 回溯（特征行早被挤掉）
//
// 于是**无法分辨**"真 OOM / 普通 panic 误报 / 应用自己打印的同名文本"。
//
// 判据三段（真 guest + 真 PG + 真诊断读取路径）：
//  1. 真 OOM（噪声 4096）落库后能读到分类依据（kind=stderr_oom_line + 运行时行原文 + 峰值），
//     而不是只剩 peak；
//  2. 同一批里的 panic 噪声形态（GUEST_EXIT）**证据为空** ⇒ 两者在落库证据上可区分；
//  3. 证据有界（≤ capapi.MaxEvidenceBytes）。
//
// 变异：把 fillFailureMetrics 里的 evidence 搬运删掉 ⇒ 本用例红（第 1 段拿不到 kind=…）。

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/diag"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
)

func TestMemoryEvidenceIsPersistedToCallEvents(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	// ① 真 OOM（前面 4096 字节噪声：审计 P2-1 的现场形态）。
	oom := serveOneShot(t, "/stderr-then-alloc?mib=62&noise=4096")
	if oom.KillReason == nil || oom.KillReason.Code != apperr.CodeRuntimeMemory {
		t.Fatalf("夹具失效：应当 RUNTIME_MEMORY，得到 %+v", oom.KillReason)
	}
	// ② 非恶意的 panic 噪声（消息里含同名字样）：必须落在另一个码、且不带内存证据。
	noisy := serveOneShot(t, "/panic-oom")
	if noisy.KillReason == nil || noisy.KillReason.Code != apperr.CodeRuntimeGuestExit {
		t.Fatalf("夹具失效：panic 应当 GUEST_EXIT，得到 %+v", noisy.KillReason)
	}

	sink := events.NewSink(db, events.Options{RingSize: 16, FlushInterval: 10 * time.Millisecond})
	sink.Start(ctx)
	sink.Record(oom.Metrics)
	sink.Record(noisy.Metrics)
	// Close 会先 flush 再返回（events.Sink 的 loop 在 stop 分支落库），所以这里是确定的。
	if err := sink.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := sink.Written(); got != 2 {
		t.Fatalf("应当落库 2 条，得到 %d（failed=%d）", got, sink.Failed())
	}

	fails, err := diag.RecentFailures(ctx, db, oom.Metrics.AppID, 10)
	if err != nil {
		t.Fatalf("RecentFailures: %v", err)
	}
	if len(fails) != 2 {
		t.Fatalf("诊断面应当读到 2 条失败，得到 %d 条：%+v", len(fails), fails)
	}
	byCode := map[string]diag.Failure{}
	for _, f := range fails {
		byCode[f.ReasonCode] = f
	}
	mem, ok := byCode[string(apperr.CodeRuntimeMemory)]
	if !ok {
		t.Fatalf("诊断面没有 RUNTIME_MEMORY 行：%+v", fails)
	}
	// 判据①：落库的是**分类依据**，不是只有 peak。
	if !strings.Contains(mem.Evidence, "kind="+memoryEvidenceStderrLine) {
		t.Fatalf("wasm_call_events.evidence 必须带判据来源（kind=%s），得到 %q；行=%+v",
			memoryEvidenceStderrLine, mem.Evidence, mem)
	}
	if !strings.Contains(mem.Evidence, oomStderrMarkers[0]) {
		t.Fatalf("落库证据必须含运行时特征行原文（事后可自证），得到 %q", mem.Evidence)
	}
	if !strings.Contains(mem.Evidence, "peak=") {
		t.Fatalf("落库证据必须同时带上峰值口径，得到 %q", mem.Evidence)
	}
	if len(mem.Evidence) > capapi.MaxEvidenceBytes {
		t.Fatalf("落库证据必须 ≤ %d 字节，得到 %d", capapi.MaxEvidenceBytes, len(mem.Evidence))
	}
	// 判据②：同一批的 panic 噪声形态没有内存证据 ⇒ 两种形态在落库面上可区分。
	guest, ok := byCode[string(apperr.CodeRuntimeGuestExit)]
	if !ok {
		t.Fatalf("诊断面没有 GUEST_EXIT 行：%+v", fails)
	}
	if guest.Evidence != "" {
		t.Fatalf("非内存事故不得留下内存证据（否则事后无法分辨误报与真 OOM），得到 %q", guest.Evidence)
	}
	if mem.PeakMemory <= 0 || mem.GuestExitCode != int32(goOOMExitCode) {
		t.Fatalf("计量列本身也必须完整：peak=%d exit=%d", mem.PeakMemory, mem.GuestExitCode)
	}
	t.Logf("落库证据 RUNTIME_MEMORY：%q（%d 字节）；GUEST_EXIT（panic 噪声）：evidence=%q",
		mem.Evidence, len(mem.Evidence), guest.Evidence)
}
