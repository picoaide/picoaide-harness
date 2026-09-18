package queue

import (
	"context"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 变异验证（§5.5「变异验证」）：
//   - 把 PerAppRunning 改成 0（无上限）⇒ TestPerAppSerial 必红；
//   - 把 PerAppQueue 调大 ⇒ TestAppQueueFull 必红；
//   - 把 PerUserGlobalRunning 改成 0 ⇒ TestPerUserGlobalRunning 必红；
//   - 去掉 release() 里的 pumpLocked ⇒ TestQueuedRequestRunsAfterRelease 必红；
//   - pumpAllLocked 改回遍历整个 s.apps（全表）⇒ TestIdleAppsDoNotInflateAdmissionCost 必红；
//   - 去掉 dropIfIdleLocked（条目不再回收）⇒ TestIdleAppsDoNotInflateAdmissionCost、
//     TestTrackedAppsMatchesActiveSet 必红。

// TestDefaultsComeFromLimits 钉死"上限只有一个真源"（§4.6 / §5.5「数值单一真源」）：
// 缺省值必须同时等于 limits 常量与设计文档写死的数字。
func TestDefaultsComeFromLimits(t *testing.T) {
	o := DefaultOptions()
	eq(t, "GlobalRunning", o.GlobalRunning, limits.GlobalInstances)
	eq(t, "PerAppRunning", o.PerAppRunning, limits.AppRuntimeConcurrency)
	eq(t, "PerAppRunning(doc)", o.PerAppRunning, 1)
	eq(t, "PerAppQueue", o.PerAppQueue, limits.AppQueueDepth)
	eq(t, "PerAppQueue(doc)", o.PerAppQueue, 32)
	eq(t, "PerUserPerAppQueued", o.PerUserPerAppQueued, limits.UserPerAppQueued)
	eq(t, "PerUserPerAppQueued(doc)", o.PerUserPerAppQueued, 4)
	eq(t, "PerUserGlobalRunning", o.PerUserGlobalRunning, limits.UserGlobalRunning)
	eq(t, "PerUserGlobalRunning(doc)", o.PerUserGlobalRunning, 4)
}

func eq(t *testing.T, name string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s=%d want %d", name, got, want)
	}
}

// TestPerAppSerial：§10.3 第 32 项的前半 —— 每应用并发恒为 1。
func TestPerAppSerial(t *testing.T) {
	s := New(DefaultOptions())
	ctx := context.Background()
	t1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	// 第二个请求（不同用户）必须排队，不能直接拿到槽。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 2)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	select {
	case <-done:
		t.Fatal("第二个请求不该在第一个释放前拿到槽位（§4.6 每应用并发恒为 1）")
	case <-time.After(120 * time.Millisecond):
	}
	t1.Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("释放后排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后排队请求未被唤醒")
	}
	if r, w := s.AppStats("app-a"); r != 0 || w != 0 {
		t.Fatalf("drain 后 running=%d waiting=%d，want 0/0", r, w)
	}
}

// TestAppQueueFull：§10.3 第 32 项 —— 同应用 100 并发 ⇒ 队列 32，其余 429。
func TestAppQueueFull(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	held, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("running acquire: %v", err)
	}
	var wg sync.WaitGroup
	for i := 0; i < o.PerAppQueue; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tk, e := s.Acquire(ctx, "app-a", int64(100+i))
			if e == nil {
				tk.Release()
			}
		}(i)
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, w := s.AppStats("app-a"); w == o.PerAppQueue {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, w := s.AppStats("app-a"); w != o.PerAppQueue {
		t.Fatalf("排队数=%d，want %d", w, o.PerAppQueue)
	}
	_, e := s.Acquire(ctx, "app-a", 9999)
	if e == nil {
		t.Fatal("队列满时必须拒绝")
	}
	if e.Code != apperr.CodeAppQueueFull {
		t.Fatalf("code=%s want APP_QUEUE_FULL", e.Code)
	}
	if got := e.Status(); got != 429 {
		t.Fatalf("http=%d want 429（§7.4 APP_QUEUE_FULL）", got)
	}
	held.Release()
	wg.Wait()
}

// TestPerUserPerAppQueued：§10.3 第 33 项 —— 单用户在同一应用最多 4 个排队。
func TestPerUserPerAppQueued(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()
	held, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("running acquire: %v", err)
	}

	// 前 4 个排队请求：必须在 goroutine 里调（Acquire 在需要排队时是阻塞的）。
	var wg sync.WaitGroup
	for i := 0; i < o.PerUserPerAppQueued; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			tk, e := s.Acquire(ctx, "app-a", 7)
			if e != nil {
				t.Errorf("第 %d 个排队应被接受: %v", i, e)
				return
			}
			tk.Release()
		}()
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, w := s.AppStats("app-a"); w == o.PerUserPerAppQueued {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, w := s.AppStats("app-a"); w != o.PerUserPerAppQueued {
		t.Fatalf("同一用户排队数=%d，want %d", w, o.PerUserPerAppQueued)
	}
	// 第 5 个必须立刻被拒（队列容量检查在等待之前，所以这里不会阻塞）。
	_, e := s.Acquire(ctx, "app-a", 7)
	if e == nil || e.Code != apperr.CodeAppQueueFull {
		t.Fatalf("同一用户第 5 个排队请求必须 429，got %v", e)
	}
	if e.Details["per_user_queued"] != o.PerUserPerAppQueued {
		t.Fatalf("details 应带 per_user_queued=%d，got %v", o.PerUserPerAppQueued, e.Details)
	}
	held.Release()
	wg.Wait()
}

// TestPerUserGlobalRunning：§10.3 第 34 项 —— 单用户开 20 个应用同时打，
// 每用户全局在跑上限 4，其余排队。
func TestPerUserGlobalRunning(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	var held []*Ticket
	for i := 0; i < o.PerUserGlobalRunning; i++ {
		tk, e := s.Acquire(ctx, appOf(i), 42)
		if e != nil {
			t.Fatalf("第 %d 个应用应可运行: %v", i+1, e)
		}
		held = append(held, tk)
	}
	// 第 5 个应用必须排队（不同应用、同一用户）。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, appOf(99), 42)
		if e == nil {
			done <- tk
		}
	}()
	select {
	case <-done:
		t.Fatal("单用户跨应用全局在跑上限为 4，第 5 个不该直接运行（§4.6）")
	case <-time.After(150 * time.Millisecond):
	}
	// 释放一个 ⇒ 排队者被唤醒。
	held[0].Release()
	select {
	case tk := <-done:
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后跨应用排队者未被唤醒")
	}
	for _, tk := range held[1:] {
		tk.Release()
	}
}

// TestGlobalRunningLimit：全局 32 槽耗尽时新应用也排队。
func TestGlobalRunningLimit(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()
	var held []*Ticket
	for i := 0; i < o.GlobalRunning; i++ {
		// 每个请求用不同用户 + 不同应用 ⇒ 只受全局上限约束。
		tk, e := s.Acquire(ctx, appOf(i), int64(1000+i))
		if e != nil {
			t.Fatalf("第 %d 个应可运行: %v", i, e)
		}
		held = append(held, tk)
	}
	if got := s.Stats().GlobalRunning; got != o.GlobalRunning {
		t.Fatalf("global running=%d want %d", got, o.GlobalRunning)
	}
	ctx2, cancel := context.WithTimeout(ctx, 100*time.Millisecond)
	defer cancel()
	_, e := s.Acquire(ctx2, appOf(12345), 555)
	if e == nil {
		t.Fatal("全局槽耗尽时新请求必须排队并被墙钟拒绝")
	}
	if e.Details["reason"] != "wall_clock_exceeded" {
		t.Fatalf("details.reason=%v want wall_clock_exceeded", e.Details["reason"])
	}
	for _, tk := range held {
		tk.Release()
	}
	if got := s.Stats().GlobalRunning; got != 0 {
		t.Fatalf("drain 后 global running=%d want 0", got)
	}
}

// TestQueuedRequestRunsAfterRelease 覆盖"释放唤醒"这条主链路（变异点见文件头）。
func TestQueuedRequestRunsAfterRelease(t *testing.T) {
	s := New(DefaultOptions())
	ctx := context.Background()
	t1, _ := s.Acquire(ctx, "app-a", 1)
	got := make(chan int64, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 2)
		if e != nil {
			got <- -1
			return
		}
		got <- tk.EnqueuedMS
		tk.Release()
	}()
	time.Sleep(80 * time.Millisecond)
	t1.Release()
	select {
	case ms := <-got:
		if ms < 0 {
			t.Fatal("排队请求应被授权")
		}
		if ms < 50 {
			t.Fatalf("EnqueuedMS=%d，应反映真实排队时长", ms)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("超时未唤醒")
	}
}

// TestHeadOfLineSkipped：队首被"每用户全局在跑上限"卡住时，后面的请求必须能运行
// （否则单个占用 4 个全局槽的用户会把整个应用卡死 —— 见包注释）。
func TestHeadOfLineSkipped(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	// 用户 1 占满自己的 4 个全局槽（用 4 个其它应用）。
	var hog []*Ticket
	for i := 0; i < o.PerUserGlobalRunning; i++ {
		tk, e := s.Acquire(ctx, appOf(i), 1)
		if e != nil {
			t.Fatalf("hog acquire: %v", e)
		}
		hog = append(hog, tk)
	}

	// app-z 由用户 3 占住运行槽。
	z, e := s.Acquire(ctx, "app-z", 3)
	if e != nil {
		t.Fatalf("app-z acquire: %v", e)
	}

	// 队首 = 用户 1（被自己的全局上限卡住），其后 = 用户 2。
	first := make(chan *Ticket, 1)
	go func() {
		tk, err := s.Acquire(ctx, "app-z", 1)
		if err == nil {
			first <- tk
		}
	}()
	time.Sleep(80 * time.Millisecond)
	second := make(chan *Ticket, 1)
	go func() {
		tk, err := s.Acquire(ctx, "app-z", 2)
		if err == nil {
			second <- tk
		}
	}()
	time.Sleep(80 * time.Millisecond)

	z.Release()
	select {
	case tk := <-second:
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("队首被全局上限卡住时，后续请求必须能运行（不允许队首阻塞）")
	}
	for _, tk := range hog {
		tk.Release()
	}
	select {
	case tk := <-first:
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("用户 1 释放槽位后其排队请求应被授权")
	}
}

// TestReleaseIdempotent：重复 Release 不得把计数减成负数。
func TestReleaseIdempotent(t *testing.T) {
	s := New(DefaultOptions())
	tk, err := s.Acquire(context.Background(), "app-a", 1)
	if err != nil {
		t.Fatal(err)
	}
	tk.Release()
	tk.Release()
	tk.Release()
	if got := s.Stats().GlobalRunning; got != 0 {
		t.Fatalf("global=%d want 0", got)
	}
}

// TestAnonymousNotCountedPerUser：匿名（userID=0）不参与"每用户"计数，
// 但仍受全局与每应用上限约束（§4.6：匿名另有令牌桶，见 anonlimit）。
func TestAnonymousNotCountedPerUser(t *testing.T) {
	s := New(DefaultOptions())
	ctx := context.Background()
	var held []*Ticket
	for i := 0; i < limits.UserGlobalRunning+2; i++ {
		tk, e := s.Acquire(ctx, appOf(i), 0)
		if e != nil {
			t.Fatalf("匿名第 %d 个应用不该被每用户上限拦: %v", i+1, e)
		}
		held = append(held, tk)
	}
	for _, tk := range held {
		tk.Release()
	}
}

func appOf(i int) string {
	return "app-" + string(rune('a'+i%26)) + string(rune('0'+i/26))
}

// ===== 审计修复回归（P2-3：app 表只增不减 + 每次 Release 全表遍历）=====

// TestIdleAppsDoNotInflateAdmissionCost 是 P2-3 的**性能回归**。
//
// 判据用**遍历次数**（不使用绝对耗时：机器差异会让绝对阈值假红）：
// 单次 Acquire+Release 遍历的应用条目数必须与空载同阶，而不是与"历史上出现过的
// 应用数"成正比（审计实测：20000 个空闲应用时单次 516–811 µs 且持全局锁）。
//
// 变异：把 pumpAllLocked 改回 `for appID, as := range s.apps` ⇒ 本用例的
// scans 断言立即变红（20001 >> base+8）。
func TestIdleAppsDoNotInflateAdmissionCost(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	// 空载基线：一次 Acquire+Release 的遍历次数。
	measure := func(appID string) int64 {
		before := s.PumpScans()
		tk, err := s.Acquire(ctx, appID, 0)
		if err != nil {
			t.Fatalf("acquire(%s): %v", appID, err)
		}
		tk.Release()
		return s.PumpScans() - before
	}
	base := measure("probe-app")

	// 造 20000 个"历史上出现过、现已空闲"的应用（就是审计复现的形态）。
	const idleApps = 20000
	for i := 0; i < idleApps; i++ {
		tk, err := s.Acquire(ctx, "idle-"+strconv.Itoa(i), 0)
		if err != nil {
			t.Fatalf("第 %d 个应用准入失败: %v", i, err)
		}
		tk.Release()
	}
	if got := s.Stats().TrackedApps; got != 0 {
		t.Fatalf("空闲应用条目未被回收：apps=%d want 0（表只增不减正是 P2-3）", got)
	}
	if got := measure("probe-app-2"); got > base+8 {
		t.Fatalf("单次 Acquire+Release 遍历 %d 个条目（空载 %d）—— 准入成本仍随历史应用数增长",
			got, base)
	}
}

// TestTrackedAppsMatchesActiveSet：条目回收的不变量 —— 任何操作返回后，
// app 表里的条目都在活跃集合里（在跑或有等待者），且取消的等待者会把条目一起收走。
func TestTrackedAppsMatchesActiveSet(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	var held []*Ticket
	for i := 0; i < o.PerUserGlobalRunning; i++ {
		tk, err := s.Acquire(ctx, appOf(i), 1)
		if err != nil {
			t.Fatalf("acquire: %v", err)
		}
		held = append(held, tk)
	}
	if got := s.Stats().TrackedApps; got != o.PerUserGlobalRunning {
		t.Fatalf("在跑的应用必须留在表里：TrackedApps=%d want %d", got, o.PerUserGlobalRunning)
	}
	// 一个被墙钟拒掉的排队者：条目必须随取消一起回收。
	tctx, cancel := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancel()
	if _, err := s.Acquire(tctx, "queued-app", 1); err == nil {
		t.Fatal("全局/每用户上限下应排队并超时")
	}
	if got := s.Stats().TrackedApps; got != o.PerUserGlobalRunning {
		t.Fatalf("超时取消的等待者未回收：TrackedApps=%d want %d", got, o.PerUserGlobalRunning)
	}
	for _, tk := range held {
		tk.Release()
	}
	st := s.Stats()
	if st.TrackedApps != 0 || st.Waiting != 0 || st.GlobalRunning != 0 {
		t.Fatalf("空闲后表必须清空：%+v", st)
	}
	if n := len(s.active); n != 0 {
		t.Fatalf("活跃集合未清空：%d", n)
	}
}

// TestPumpOnlyVisitsActiveApps：**白盒**钉住"pumpAllLocked 只遍历活跃集合"。
//
// 为什么需要它（而不是只靠上一条端到端性能用例）：条目回收生效后
// `s.apps ≡ s.active`，两种遍历在端到端场景里**代价相同** —— 那条用例对
// "遍历目标"这一半边不敏感（它敏感的是"条目增长"那一半）。
// 这里手工塞进 20000 个空闲条目（模拟"回收被关掉/历史遗留"的形态），断言一次
// Acquire+Release **一个空闲条目都不遍历**：遍历成本必须只与活跃应用数有关。
//
// 变异：把 pumpAllLocked 改回 `range s.apps` ⇒ 本用例立即变红（>=20000 次遍历）。
func TestPumpOnlyVisitsActiveApps(t *testing.T) {
	s := New(DefaultOptions())
	for i := 0; i < 20000; i++ {
		s.apps["legacy-"+strconv.Itoa(i)] = &appState{userQueued: map[int64]int{}}
	}
	if len(s.active) != 0 {
		t.Fatalf("前置条件：活跃集合应为空，got %d", len(s.active))
	}
	before := s.PumpScans()
	tk, err := s.Acquire(context.Background(), "probe-app", 0)
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	tk.Release()
	if got := s.PumpScans() - before; got > 8 {
		t.Fatalf("一次 Acquire+Release 遍历了 %d 个应用条目 —— pumpAllLocked 仍在遍历整张表"+
			"（应与活跃应用数成正比，空闲历史条目一个都不该碰）", got)
	}
	// 被遍历到的（活跃的）那个条目在释放后必须被回收；手工塞的空闲条目不在活跃集合里，
	// 不是本用例的断言对象（它们只用来证明"遍历不看它们"）。
	if _, ok := s.apps["probe-app"]; ok {
		t.Fatal("探针应用空闲后应被回收")
	}
}
