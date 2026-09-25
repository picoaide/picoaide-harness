package reports

// R19A-S1-06 / S1-07（审计 2026-09-25，P2）的判据：月报投递必须
//   ① **有退避**（永久坏的 webhook 不再每 tick 重投 = 24 次/天/实例）；
//   ② **跨实例不重复**（两个实例同时 tick，同一期只投一次）；
//   ③ **跨月不丢期**（失败跨过月界时，仍补投被跨过的那一期）。
//
// 三条与 R19B-02（健康订阅不被兄弟失败顺带重推）共用同一处策略实现
// （delivery_policy.go），不再各自判定。
//
// 变异（必须变红）：
//   - 去掉 `SubscriptionDuePeriod` 里的 `NextAttemptAt` 判断（退避失效）⇒ 第 1 条红（24 次）；
//   - 去掉 `claimReportDelivery` 的认领（跨实例互斥失效）⇒ 第 2 条红（2 次）；
//   - 去掉 `PendingPeriod` 优先（期号只看"上一月"）⇒ 第 3 条红（08 → 09 跳期）。

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestPermanentWebhookFailureIsBackedOff：永久坏的 webhook 在 24 个 1 小时 tick 内
// 最多被投递 2 次（首次 + 1 小时后的快速重试），而不是 24 次。
func TestPermanentWebhookFailureIsBackedOff(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	pushes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		pushes++
		mu.Unlock()
		w.WriteHeader(http.StatusBadGateway) // 永久坏的 webhook
	}))
	defer srv.Close()
	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}

	base := bjAt(2026, 9, 15, 0)
	for h := 0; h < 24; h++ {
		now := base.Add(time.Duration(h) * time.Hour)
		s := NewScheduler(db, time.Hour, func() time.Time { return now })
		_ = s.tryRun()
	}
	mu.Lock()
	got := pushes
	mu.Unlock()
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("24 个 tick 内投递次数=%d fail_streak=%d next_attempt_at=%v", got, subs[0].FailStreak, subs[0].NextAttemptAt)
	if got > 2 {
		t.Fatalf("失败重试没有退避：24 小时内投递 %d 次（修前 = 每 tick 一次 = 24 次/天/实例，"+
			"永久坏的 webhook ≈720 次/月）", got)
	}
	if got < 2 {
		t.Fatalf("投递次数 = %d, want ≥2 —— 退避不得退化成「失败后不再重试」"+
			"（首次失败后 1 小时必须有一次快速重试）", got)
	}
	if subs[0].FailStreak != 2 {
		t.Fatalf("fail_streak = %d, want 2（连续失败次数必须落库，退避才有依据）", subs[0].FailStreak)
	}
	if subs[0].PendingPeriod != CurrentPeriod(base) {
		t.Fatalf("pending_period = %q, want %q（失败的那一期必须被记住，跨月不丢）",
			subs[0].PendingPeriod, CurrentPeriod(base))
	}
}

// TestTransientWebhookFailureRecoversOnFirstRetry：瞬时故障（1 小时后恢复）必须被
// 首次重试接住 —— 退避不能以"牺牲自愈速度"为代价。
func TestTransientWebhookFailureRecoversOnFirstRetry(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	pushes := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		pushes++
		first := pushes == 1
		mu.Unlock()
		if first {
			w.WriteHeader(http.StatusBadGateway) // 只有第一次失败
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}

	base := bjAt(2026, 9, 15, 0)
	clock := base
	for h := 0; h < 3; h++ {
		s := NewScheduler(db, time.Hour, func() time.Time { return clock })
		_ = s.tryRun()
		clock = clock.Add(time.Hour)
	}
	mu.Lock()
	got := pushes
	mu.Unlock()
	if got != 2 {
		t.Fatalf("投递次数 = %d, want 2（失败一次 + 1 小时后的快速重试成功）", got)
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if subs[0].LastRunAt == nil || subs[0].LastError != "" || subs[0].FailStreak != 0 ||
		subs[0].PendingPeriod != "" || subs[0].NextAttemptAt != nil {
		t.Fatalf("恢复后状态未归零: %+v", subs[0])
	}
}

// TestTwoInstancesDoNotDuplicateDelivery：两个实例同时 tick（真实多实例部署）⇒
// 同一期只投一次（PG advisory lock 认领）。
func TestTwoInstancesDoNotDuplicateDelivery(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	var periods []string
	release := make(chan struct{})
	ready := sync.WaitGroup{}
	ready.Add(1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Period string `json:"period"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		periods = append(periods, body.Period)
		mu.Unlock()
		ready.Done()
		<-release // 让两个实例的推送在时间上重叠（真实多实例必然发生）
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}

	now := bjAt(2026, 9, 15, 10)
	s1 := NewScheduler(db, time.Hour, func() time.Time { return now })
	s2 := NewScheduler(db, time.Hour, func() time.Time { return now })
	done := make(chan struct{}, 2)
	go func() { _ = s1.tryRun(); done <- struct{}{} }()
	go func() { _ = s2.tryRun(); done <- struct{}{} }()
	// 等第一条真的进了推送（此后第二条若也投递就会重叠），再放行。
	waited := make(chan struct{})
	go func() { ready.Wait(); close(waited) }()
	select {
	case <-waited:
	case <-time.After(10 * time.Second):
		t.Fatal("没有任何实例投递（多实例重叠场景没构造出来）")
	}
	time.Sleep(200 * time.Millisecond) // 给第二个实例足够时间"尝试"（它应当被认领挡下）
	close(release)
	<-done
	<-done

	mu.Lock()
	got := append([]string{}, periods...)
	mu.Unlock()
	t.Logf("两个实例同时 tick 的投递期号=%v", got)
	if len(got) != 1 {
		t.Fatalf("同一期被投递 %d 次, want 1 —— 投递必须有跨实例认领（PG advisory lock，"+
			"无认领时两个实例会把同一期各投一遍）", len(got))
	}
}

// TestCrossMonthFailureKeepsPendingPeriod：失败跨过月界 ⇒ 仍补投**被跨过的那一期**
// （期号不得从 08 跳到 09）。
func TestCrossMonthFailureKeepsPendingPeriod(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	var periods []string
	fail := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Period string `json:"period"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		periods = append(periods, body.Period)
		f := fail
		mu.Unlock()
		if f {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}
	// 9/30 23:00（北京）：这一轮应当投 8 月报表，推送失败。
	sep := bjAt(2026, 9, 30, 23)
	_ = NewScheduler(db, time.Hour, func() time.Time { return sep }).tryRun()
	// 10/1 00:00（北京）：webhook 恢复 —— 跨过月界，仍必须补投 8 月那一期。
	oct := bjAt(2026, 10, 1, 0)
	mu.Lock()
	fail = false
	mu.Unlock()
	if err := NewScheduler(db, time.Hour, func() time.Time { return oct }).tryRun(); err != nil {
		t.Fatalf("恢复后的轮次不该失败: %v", err)
	}
	mu.Lock()
	got := append([]string{}, periods...)
	mu.Unlock()
	t.Logf("投递期号序列=%v", got)
	if len(got) != 2 || got[0] != "2026-08" || got[1] != "2026-08" {
		t.Fatalf("投递期号 = %v, want [2026-08 2026-08] —— 跨月后必须仍在补失败的那一期"+
			"（修前静默跳到 2026-09，8 月报表永不投递）", got)
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if subs[0].PendingPeriod != "" || subs[0].LastError != "" {
		t.Fatalf("补投成功后 pending_period/last_error 必须清空: %+v", subs[0])
	}
}

// TestSubscriptionDuePeriodPolicy 单元级判据：三条判定的顺序与语义。
func TestSubscriptionDuePeriodPolicy(t *testing.T) {
	now := bjAt(2026, 9, 15, 10) // 本月 = 2026-09 ⇒ 上一期 = 2026-08
	next := now.Add(time.Hour)

	cases := []struct {
		name string
		sub  serverstore.ReportSubscription
		want string
		due  bool
	}{
		{"禁用不投", serverstore.ReportSubscription{Enabled: false}, "", false},
		{"退避窗口内不投", serverstore.ReportSubscription{Enabled: true, NextAttemptAt: &next, PendingPeriod: "2026-08"}, "", false},
		{"有待补期号 ⇒ 补那一期（跨月也一样）", serverstore.ReportSubscription{Enabled: true, PendingPeriod: "2026-07"}, "2026-07", true},
		{"从未投递 ⇒ 投上一期", serverstore.ReportSubscription{Enabled: true}, "2026-08", true},
		{"本月已投递 ⇒ 不投", serverstore.ReportSubscription{Enabled: true, LastRunAt: &now}, "", false},
	}
	for _, c := range cases {
		got, due := SubscriptionDuePeriod(now, c.sub)
		if got != c.want || due != c.due {
			t.Fatalf("%s: SubscriptionDuePeriod = (%q,%v), want (%q,%v)", c.name, got, due, c.want, c.due)
		}
	}
}
