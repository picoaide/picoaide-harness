package runtime

import (
	"context"
	"fmt"
	"log"
	"strings"
	"testing"
	"time"
)

// TestServe_ModuleCloseWaitsForGuestFinish 是 R1-rt-18 的**可观测**判据，也是
// `Options.OnModuleClose` 钩子的调用方（回归审计 §1.7：钩子加了却零调用方 ⇒
// "关闭实例前 guest 是否真的结束"这件事依旧没有任何断言）。
//
// 被判定的时序是 Serve 的**早退分支**：应用写完合法最终响应帧之后宿主立刻取消 guest 预算，
// 但「取消预算 ≠ 可以立刻关闭实例」—— wazero 的 ensureResourcesClosed 会把 `m.Sys` 置 nil，
// 而仍在执行的 WASI 调用正在读它（R1-rt-18 实测数据竞争 + nil 解引用 panic，能让整个
// 服务端进程崩溃）。正确形态是 `settle(done, guestCtx, postKillGrace)` 等到 guest goroutine
// **真正结束**（或有界宽限到点）再 closeModule。
//
// 判据：钩子事件里的 GuestFinished 由 **guest goroutine 自己的结束信号**判定
// （`guestFinished` 通道在 `done <- callErr` **之前**关闭，见 Serve 里的注释），
// 不是复述调用点的说法 ⇒ 它如实回答「关闭那一刻 guest 还在不在跑」：
//
//   - 修复后的形态：`settle` 只有收到 `done` 才返回，而 `done` 在 `guestFinished` 关闭之后
//     才发出 ⇒ 关闭时 guest 一定已经结束（GuestFinished=true）—— 这是 happens-before
//     保证的**不变量**，不是时序运气；
//   - 变异（去掉 `settle`、恢复「拿到响应帧就立刻 Close」）：closeModule 落在 `cancelGuest`
//     之后的**微秒级**，而 guest 要停下只能靠这次取消传播出去（实测：响应帧到达之后再等
//     ~20–60ms 才观察到 guest 结束）⇒ 关闭时 guest 仍在自旋（GuestFinished=false）。
//
// 为什么跑 rounds 轮：单轮「变异后仍报 true」只在「cancel 与 close 之间恰好被调度器抢占
// 20ms 以上」时才可能发生；连做 5 轮（任一轮为 false 即失败）把这种巧合压到可忽略，
// 而**每轮的断言都不含任何 sleep**：只读钩子事件与 guest 自己的结束信号（`/respond-spin`
// 的 100ms 自旋是 guest 自己的行为，用来保证「响应帧刚被读到时 guest 一定还在跑」）。
//
// 变异验证（命令与红/绿对照见 temp/wasm-review-r1/fix-hosthook.md）：
// 把 Serve 早退分支里的 `settle(done, guestCtx, postKillGrace)` 去掉（恢复 R1-rt-18
// 修复前的「立刻 Close」）⇒ 本用例必红（实测 5/5 轮 GuestFinished=false）。
func TestServe_ModuleCloseWaitsForGuestFinish(t *testing.T) {
	const (
		// guest 写完响应帧后自旋 100ms（`/respond-spin` 的既有形状）。
		lingerMS = 100
		// 轮数：见上「为什么跑 rounds 轮」。
		rounds = 5
	)

	// observed 把钩子事件与「事件发生的墙钟时刻」一起记下来 —— 后者用于把关闭时刻
	// 换算成「响应帧到达之后多久」，进 t.Logf 与失败信息（判据本身只看 GuestFinished）。
	type observed struct {
		ev ModuleClose
		at time.Time
	}

	// 专职 Runtime：只有它能带 OnModuleClose（包级共享那个是给其他用例的，不带钩子）。
	// 不注入 DataRoot ⇒ 进程内内存缓存（与生产无关，只为把编译开销限制在本用例内）。
	logBuf := &lockedBuffer{}
	closes := make(chan observed, rounds+2)
	rt, err := New(context.Background(), Options{
		Logger:        log.New(logBuf, "", 0),
		OnModuleClose: func(ev ModuleClose) { closes <- observed{ev: ev, at: time.Now()} },
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer func() { _ = rt.Close(context.Background()) }()

	cm, err := rt.CompileModule(context.Background(), guestBinary(t, "app"))
	if err != nil {
		t.Fatalf("CompileModule: %v", err)
	}

	var lastElapsed, lastClosedAfter time.Duration
	for i := 1; i <= rounds; i++ {
		req := testRequest(fmt.Sprintf("/respond-spin?ms=%d", lingerMS), newFakeHost())
		// 预算充裕：本用例考的不是「预算到点」，而是「拿到答案之后要不要等 guest」。
		req.Budgets.GuestBudget = 3 * time.Second

		start := time.Now()
		res, serr := rt.Serve(context.Background(), cm, req)
		elapsed := time.Since(start)
		if serr != nil {
			t.Fatalf("第 %d 轮 Serve 返回装配错误: %v", i, serr)
		}
		resp := requireOK(t, res) // 响应帧就是答案：结论不许被收尾方式改写
		if body := bodyJSON(t, resp); body["spin_ok"] != true {
			t.Fatalf("第 %d 轮响应体不是应用写出的那个信封: %v", i, body)
		}

		// 钩子在 Serve 返回前同步触发（closeModule 在早退分支里直接调用、defer 里那次
		// 因 rec.fired 不会再上报）⇒ 事件一定已经在通道里。
		var obs observed
		select {
		case obs = <-closes:
		case <-time.After(2 * time.Second):
			t.Fatalf("第 %d 轮：OnModuleClose 在 2s 内没有上报（钩子没接到 closeModule？）", i)
		}
		lastElapsed, lastClosedAfter = elapsed, obs.at.Sub(start)

		if obs.ev.AppID != "test-app" {
			t.Errorf("第 %d 轮：钩子事件 AppID=%q，want test-app", i, obs.ev.AppID)
		}
		if !obs.ev.GuestFinished {
			t.Fatalf("第 %d 轮：实例关闭时 guest 仍在运行（GuestFinished=false，关闭发生在响应帧到达后 %s）："+
				"早退分支必须先 settle 再 closeModule（R1-rt-18）——这就是「取消预算不等于可以立刻关闭实例」的判据",
				i, lastClosedAfter.Round(time.Millisecond))
		}
		if got := logBuf.String(); strings.Contains(got, "未在宽限内退出") {
			t.Fatalf("第 %d 轮：guest 在宽限内自行结束，不该出现「未在宽限内退出」日志：%q", i, got)
		}
	}

	// 每轮恰好上报一次（defer 里的兜底关闭是幂等的第二道，不得变成第二次观测）。
	select {
	case dup := <-closes:
		t.Fatalf("同一次请求上报了多次关闭事件: %+v", dup)
	default:
	}

	t.Logf("%d 轮全部 GuestFinished=true；末轮 Serve 耗时 %s、关闭发生在响应帧到达后 %s；宿主日志=%q",
		rounds, lastElapsed.Round(time.Millisecond), lastClosedAfter.Round(time.Millisecond), logBuf.String())
}
