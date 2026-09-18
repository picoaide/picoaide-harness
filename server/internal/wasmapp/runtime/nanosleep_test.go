package runtime

import (
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
)

// 本文件是 FIX-32（审计 P1-1）的门禁：**`WithNanosleep(真实实现)` 必须有判据**。
//
// 为什么不能用"耗时断言"（这一条是审计员实测踩出来的坑）：
// Go 在 wasip1 上的等待是**忙等循环**（`runtime/lock_wasip1.go`：*"Waiting for a mutex or
// timeout is implemented as a busy loop"*）——`time.Sleep` 只是反复 `usleep` → `poll_oneoff`。
// 于是把 `instance.go` 的 `WithNanosleep(sysNanosleep)` 换成 `WithNanosleep(func(int64) {})`
// （假睡眠）时：
//
//	墙钟：~305ms（**几乎不变**）   进程 CPU：5ms → ~300ms
//
// 也就是说，任何"sleep 够久了吗"的墙钟断言都测不出这个变异。**判据必须是 CPU 时间**。
//
// 变异验证（实跑过）：把 instance.go 的 `WithNanosleep(sysNanosleep)` 改成
// `WithNanosleep(func(int64) {})` ⇒ 本用例必红（实测 burned≈300ms > 阈值）。
func TestServe_NanosleepDoesNotBurnCPU(t *testing.T) {
	const sleepMS = 300
	rt := sharedRuntime(t)
	mod := appModule(t)
	// 预热：冷路径的开销（3.4 MiB 模块的 wazero 冷编译 ~1–2s CPU + 首次实例化的 Go 运行时启动）
	// 与被测行为无关，必须先付掉，否则判据测的是"编译烧了多少 CPU"。
	serveCompiled(t, rt, mod, testRequest("/ok", newFakeHost()))

	before, ok := processCPUTime()
	if !ok {
		// 非 unix（无 getrusage）：明确跳过而不是假装通过 —— 平台判据缺失必须可见。
		t.Skip("本平台没有进程 CPU 时间读数（unix getrusage 不可用）：WithNanosleep 的判据在 unix CI 上跑")
	}

	req := testRequest("/sleep?ms=300", newFakeHost())
	req.Budgets.GuestBudget = 5 * time.Second

	start := time.Now()
	res := serveCompiled(t, rt, mod, req)
	elapsed := time.Since(start)
	burned, _ := processCPUTime()
	burned -= before

	resp := requireOK(t, res)
	if body := bodyJSON(t, resp); body["slept_ms"] != float64(sleepMS) {
		t.Fatalf("guest 没有按预期睡眠 %dms：%v", sleepMS, body)
	}
	// ① 睡眠真的发生了（防止"反方向的变异"：sleep 被整体优化/短路掉）。
	if elapsed < 250*time.Millisecond {
		t.Fatalf("墙钟只有 %s：guest 的 time.Sleep(%dms) 没有真的等", elapsed.Round(time.Millisecond), sleepMS)
	}
	// ② 等待期间不得烧 CPU。阈值取 min(墙钟/3, 150ms)：
	//    - 真实现：本机 ~5ms（远低于阈值）；
	//    - 假实现：~300ms（必红）。
	//    取 min 是为了在极慢的机器上不把阈值放到"测不出假睡眠"的量级。
	limit := elapsed / 3
	if limit > 150*time.Millisecond {
		limit = 150 * time.Millisecond
	}
	if burned > limit {
		t.Fatalf("等待 %s 期间烧了 %s 的进程 CPU（上限 %s）：WithNanosleep 是假实现（poll_oneoff/usleep 立即返回 ⇒ guest 忙等）。"+
			"墙钟判据测不出这一条，所以必须用 CPU 时间", elapsed.Round(time.Millisecond), burned.Round(time.Millisecond), limit)
	}
	if res.Metrics.Outcome != capapi.OutcomeOK {
		t.Fatalf("outcome 应为 ok，实际 %q", res.Metrics.Outcome)
	}
	t.Logf("guest time.Sleep(%dms)：墙钟 %s、本进程 CPU %s（上限 %s）",
		sleepMS, elapsed.Round(time.Millisecond), burned.Round(time.Millisecond), limit)
}
