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
//   - 把 PerAppRunning 改成 0（无上限）⇒ TestPerAppConcurrencyLimit 必红；
//   - 把 PerAppRunning 默认值改回 1 ⇒ TestPerAppConcurrencyLimit、
//     TestSameUserCannotExceedPerAppRunningNowThatAppsRunConcurrently 必红；
//   - 把 PerAppQueue 调大 ⇒ TestAppQueueFull 必红；
//   - 把 PerUserGlobalRunning 改成 0 ⇒ TestPerUserGlobalRunning 必红；
//   - 去掉 release() 里的 pumpLocked ⇒ TestQueuedRequestRunsAfterRelease 必红；
//   - pumpAllLocked 改回遍历整个 s.apps（全表）⇒ TestIdleAppsDoNotInflateAdmissionCost 必红；
//   - 去掉 dropIfIdleLocked（条目不再回收）⇒ TestIdleAppsDoNotInflateAdmissionCost、
//     TestTrackedAppsMatchesActiveSet 必红。

// TestDefaultsComeFromLimits 钉死"上限只有一个真源"（§4.6 / §5.5「数值单一真源」）：
// 缺省值必须同时等于 limits 常量与设计文档写死的数字。
//
// ⚠️ PerAppRunning 的"文档值"于 2026-09-19 由 1 改为 4（同应用并发读）：这条断言
// 曾经把"每应用串行"钉死成契约，现在的契约是"**有上限**的并发"——
// 上限值本身仍必须等于 limits.AppRuntimeConcurrency（下面第一条），
// 而"超出上限就排队"由 TestPerAppConcurrencyLimit 用**行为**断言（不再依赖具体数字）。
func TestDefaultsComeFromLimits(t *testing.T) {
	o := DefaultOptions()
	eq(t, "GlobalRunning", o.GlobalRunning, limits.GlobalInstances)
	eq(t, "PerAppRunning", o.PerAppRunning, limits.AppRuntimeConcurrency)
	eq(t, "PerAppQueue", o.PerAppQueue, limits.AppQueueDepth)
	eq(t, "PerAppQueue(doc)", o.PerAppQueue, 32)
	eq(t, "PerUserPerAppQueued", o.PerUserPerAppQueued, limits.UserPerAppQueued)
	eq(t, "PerUserPerAppQueued(doc)", o.PerUserPerAppQueued, 4)
	eq(t, "PerUserGlobalRunning", o.PerUserGlobalRunning, limits.UserGlobalRunning)
	eq(t, "PerUserGlobalRunning(doc)", o.PerUserGlobalRunning, 4)
	// 单应用并发不得大于全局并发（否则"每应用上限"永远够不着，配置是骗人的）。
	if o.PerAppRunning > o.GlobalRunning {
		t.Fatalf("PerAppRunning=%d > GlobalRunning=%d：单应用上限必须落在全局并发之内",
			o.PerAppRunning, o.GlobalRunning)
	}
}

func eq(t *testing.T, name string, got, want int) {
	t.Helper()
	if got != want {
		t.Fatalf("%s=%d want %d", name, got, want)
	}
}

// TestPerAppConcurrencyLimit：§10.3 第 32 项的现行口径 —— **每应用最多 N 个并发**
// （N = limits.AppRuntimeConcurrency，2026-09-19 起默认 4），第 N+1 个必须排队。
//
// 为什么不再叫 TestPerAppSerial：那条用例把"每应用并发恒为 1"钉成了契约，而契约
// 已经变了 —— 现在要钉的是"**有上限**"这件事本身（超限即排队，不是无上限放行）。
// 判据用**行为**（第 N+1 个在释放前拿不到槽）而不是具体数字：默认值将来再调整时
// 这条用例仍然有效；"上限恒为 1"这个旧行为由 TestPerAppSerialWhenLimitIsOne
// 用显式 Options 覆盖（队列机制本身没有退化）。
func TestPerAppConcurrencyLimit(t *testing.T) {
	o := DefaultOptions()
	if o.PerAppRunning < 2 {
		t.Fatalf("本用例的前提是「每应用并发 > 1」（否则证明不了并发真的被放行）：PerAppRunning=%d", o.PerAppRunning)
	}
	s := New(o)
	ctx := context.Background()

	// 前 N 个请求（不同用户）必须**立刻**都能拿到槽 —— 这就是"同应用并发"本身。
	var held []*Ticket
	for i := 0; i < o.PerAppRunning; i++ {
		tk, err := s.Acquire(ctx, "app-a", int64(1+i))
		if err != nil {
			t.Fatalf("第 %d 个并发请求应立刻拿到槽（每应用上限 %d）：%v", i+1, o.PerAppRunning, err)
		}
		held = append(held, tk)
	}
	if running, waiting := s.AppStats("app-a"); running != o.PerAppRunning || waiting != 0 {
		t.Fatalf("running=%d waiting=%d，want %d/0", running, waiting, o.PerAppRunning)
	}

	// 第 N+1 个必须排队（不能直接拿到槽）。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 99)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	select {
	case <-done:
		t.Fatalf("第 %d 个请求不该在上限占满时拿到槽（每应用并发上限 %d）", o.PerAppRunning+1, o.PerAppRunning)
	case <-time.After(120 * time.Millisecond):
	}
	// 释放一个 ⇒ 排队者被唤醒。
	held[0].Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("释放后排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("释放后排队请求未被唤醒")
	}
	for _, tk := range held[1:] {
		tk.Release()
	}
	if r, w := s.AppStats("app-a"); r != 0 || w != 0 {
		t.Fatalf("drain 后 running=%d waiting=%d，want 0/0", r, w)
	}
}

// TestPerAppSerialWhenLimitIsOne：把上限显式配成 1 时，队列仍然是**串行**的
// （每应用并发 = 1 这个可配置形态没有被删掉，只是不再是默认）。
//
// 变异：pumpAppLocked 的上限判断写成 `for {}`（忽略 PerAppRunning）⇒ 本用例必红。
func TestPerAppSerialWhenLimitIsOne(t *testing.T) {
	s := New(Options{PerAppRunning: 1})
	ctx := context.Background()
	t1, err := s.Acquire(ctx, "app-a", 1)
	if err != nil {
		t.Fatalf("first acquire: %v", err)
	}
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
		t.Fatal("PerAppRunning=1 时第二个请求不该在第一个释放前拿到槽位（串行语义）")
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
}

// TestSameUserCannotExceedPerAppRunningNowThatAppsRunConcurrently 是 2026-09-19
// "每应用并发 4" 的**配套回归**：上限调大之后，"单用户单应用并发"必须仍然生效 ——
// 用户 A 在跑时、用户 B 也进来跑（同应用并发成立），此时 **A 的第二个请求**必须排队。
//
// 为什么单列一条（这不是理论担忧）：老实现把"在跑发起者"记成**单个 userID**
// （`runningUser int64` + "PerAppRunning 恒为 1 ⇒ 单值即可"），PerAppRunning 提到 4
// 之后，B 的授权会把 runningUser 覆盖成 B ⇒ 再查 A 的在跑数读到 0 ⇒ A 的第二个请求
// 被直接放行，`user_per_app_running=1` 对先来的用户静默失效。
//
// 变异：把 appState 换回单个 runningUser 字段 ⇒ 本用例必红（A 的第二个请求会被放行）。
func TestSameUserCannotExceedPerAppRunningNowThatAppsRunConcurrently(t *testing.T) {
	o := DefaultOptions()
	if o.PerAppRunning < 2 {
		t.Fatalf("本用例的前提是每应用并发 > 1：PerAppRunning=%d", o.PerAppRunning)
	}
	s := New(o)
	ctx := context.Background()

	a1, err := s.Acquire(ctx, "app-a", 7)
	if err != nil {
		t.Fatalf("用户 7 的第一个请求应可运行: %v", err)
	}
	// 另一个用户也能同时运行 ⇒ 证明"同应用并发"是真的（不是靠把上限调成 1 蒙对）。
	b1, err := s.Acquire(ctx, "app-a", 8)
	if err != nil {
		t.Fatalf("用户 8 的请求应与用户 7 并发运行（上限 %d）: %v", o.PerAppRunning, err)
	}
	if running, _ := s.AppStats("app-a"); running != 2 {
		t.Fatalf("同一应用应同时有 2 个请求在跑，得到 %d", running)
	}

	// 用户 7 的第二个请求：PerUserPerAppRunning=1 ⇒ 必须排队（哪怕应用还有空槽）。
	done := make(chan *Ticket, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 7)
		if e != nil {
			done <- nil
			return
		}
		done <- tk
	}()
	select {
	case <-done:
		t.Fatal("同一用户在同一应用内已有 1 个在跑时，第二个请求必须排队（user_per_app_running=1）")
	case <-time.After(120 * time.Millisecond):
	}
	a1.Release()
	select {
	case tk := <-done:
		if tk == nil {
			t.Fatal("用户 7 释放后其排队请求应被授权")
		}
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("用户 7 释放后其排队请求未被唤醒")
	}
	b1.Release()
}

// TestAppQueueFull：§10.3 第 32 项 —— 同应用 100 并发 ⇒ 队列 32，其余 429。
//
// 2026-09-19：每应用并发默认 4 ⇒ "占满在跑槽"要拿 PerAppRunning 个（不同用户，
// 免得被 user_per_app_running=1 挡住），否则第一个排队请求会直接拿到空槽、
// 队列永远填不满（本用例就是这么变的红）。队列容量与 429 的语义不变。
func TestAppQueueFull(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()

	var held []*Ticket
	for i := 0; i < o.PerAppRunning; i++ {
		tk, err := s.Acquire(ctx, "app-a", int64(1+i))
		if err != nil {
			t.Fatalf("占满在跑槽的第 %d 个请求应可运行: %v", i+1, err)
		}
		held = append(held, tk)
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
	for _, tk := range held {
		tk.Release()
	}
	wg.Wait()
}

// TestPerUserPerAppQueued：§10.3 第 33 项 —— 单用户在同一应用最多 4 个排队。
//
// 2026-09-19：每应用并发默认 4 ⇒ 要先把在跑槽占满（PerAppRunning 个**其他**用户），
// 用户 7 的请求才会进队列（否则它的第一个请求直接占用空槽，"每用户排队上限"
// 根本不会被触到 —— 本用例就是这么变的红）。判据本身不变。
func TestPerUserPerAppQueued(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()
	var held []*Ticket
	for i := 0; i < o.PerAppRunning; i++ {
		tk, err := s.Acquire(ctx, "app-a", int64(1+i))
		if err != nil {
			t.Fatalf("占满在跑槽的第 %d 个请求应可运行: %v", i+1, err)
		}
		held = append(held, tk)
	}

	// 前 4 个排队请求：必须在 goroutine 里调（Acquire 在需要排队时是阻塞的）。
	var wg sync.WaitGroup
	for i := 0; i < o.PerUserPerAppQueued; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			tk, e := s.Acquire(ctx, "app-a", 7)
			if e != nil {
				t.Errorf("第 %d 个排队应被接受: %v", i, e)
				return
			}
			tk.Release()
		}(i)
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
	for _, tk := range held {
		tk.Release()
	}
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
//
// 2026-09-19：每应用并发默认 4 ⇒ "排队"要先把 PerAppRunning 个槽占满。
func TestQueuedRequestRunsAfterRelease(t *testing.T) {
	o := DefaultOptions()
	s := New(o)
	ctx := context.Background()
	var held []*Ticket
	for i := 0; i < o.PerAppRunning; i++ {
		tk, err := s.Acquire(ctx, "app-a", int64(1+i))
		if err != nil {
			t.Fatalf("占满在跑槽的第 %d 个请求应可运行: %v", i+1, err)
		}
		held = append(held, tk)
	}
	got := make(chan int64, 1)
	go func() {
		tk, e := s.Acquire(ctx, "app-a", 99)
		if e != nil {
			got <- -1
			return
		}
		got <- tk.EnqueuedMS
		tk.Release()
	}()
	time.Sleep(80 * time.Millisecond)
	held[0].Release()
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
	for _, tk := range held[1:] {
		tk.Release()
	}
}

// TestHeadOfLineSkipped：队首被"每用户全局在跑上限"卡住时，后面的请求必须能运行
// （否则单个占用 4 个全局槽的用户会把整个应用卡死 —— 见包注释）。
//
// 2026-09-19：每应用并发默认 4 ⇒ app-z 要先用 PerAppRunning 个**其他**用户占满在跑槽，
// 用户 1 与用户 2 的请求才会都进队列（否则用户 2 会直接拿到空槽，本用例就不再
// 验证"跳过队首"这件事 —— 它曾经因为这条隐性前提而变成假绿）。
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

	// app-z 的在跑槽由 o.PerAppRunning 个**其他**用户占满。
	var zHeld []*Ticket
	for i := 0; i < o.PerAppRunning; i++ {
		tk, e := s.Acquire(ctx, "app-z", int64(3+i))
		if e != nil {
			t.Fatalf("app-z 占槽 acquire: %v", e)
		}
		zHeld = append(zHeld, tk)
	}

	// 队首 = 用户 1（被自己的全局上限卡住），其后 = 用户 2（应用槽已满，也只能排队）。
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
	if _, w := s.AppStats("app-z"); w != 2 {
		t.Fatalf("前置条件：用户 1 与用户 2 的请求都应在队列里，实际 waiting=%d", w)
	}

	zHeld[0].Release()
	select {
	case tk := <-second:
		tk.Release()
	case <-time.After(2 * time.Second):
		t.Fatal("队首被全局上限卡住时，后续请求必须能运行（不允许队首阻塞）")
	}
	for _, tk := range zHeld[1:] {
		tk.Release()
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
