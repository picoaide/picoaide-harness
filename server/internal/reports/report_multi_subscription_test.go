package reports

// R19B-02（审计 2026-09-25，P1；**第十八轮 R18C-03 修复引入的回归**）：投递必须按
// **订阅粒度**判定是否欠投。
//
// 缺陷形态：`tryRun` 的 should 判据是 per-subscription 的（"任一订阅待补跑"），而
// `DispatchAll` 对**全部** enabled 订阅无条件重推 ⇒ 一个订阅持续失败时，同实例上
// **健康**的订阅每小时重收同一期月报（真实部署里每小时一轮、直到本北京月底，最坏约
// 700 次真实出站 webhook）。R18C-03 之前失败也推进 last_run_at ⇒ should 恒 false
// ⇒ 这条被顺带掩盖；既有用例只种**一个**订阅 ⇒ 整包仍绿。
//
// 变异（必须变红）：把 `DispatchAll` 里的 `ShouldRunMonthly(month, sub.LastRunAt)`
// 过滤去掉（退回"全部 enabled 无条件重推"）⇒ 本文件两条用例都红
// （healthy=3 want 1；已投递订阅被重投 3 次 want 0）。

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestHealthySubscriptionNotRepushedWhenSiblingFails 是主判据：
// 混合健康/失败订阅连跑三轮 ⇒ 健康订阅**恰好 1 次**、失败订阅**按期 3 次**。
// 同时钉住 DispatchAll 的返回值只统计"真正尝试过的"订阅（第 2/3 轮 ok=0/failed=1）。
func TestHealthySubscriptionNotRepushedWhenSiblingFails(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	healthyHits, brokenHits := 0, 0
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		healthyHits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer healthy.Close()
	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		brokenHits++
		mu.Unlock()
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer broken.Close()

	if _, err := serverstore.CreateReportSubscription(db, "finance-ok", healthy.URL, true); err != nil {
		t.Fatal(err)
	}
	brokenID, err := serverstore.CreateReportSubscription(db, "compliance-broken", broken.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	// 2026-09-15（北京）⇒ 本期 = 2026-08。三轮 = 三个 1 小时 tick（R19A-S1-06 之后
	// 失败有指数退避：首轮失败 ⇒ 1 小时后才允许重试，所以必须推进时钟，否则第 2/3 轮
	// 被退避窗口挡住 —— 那是退避在起作用，不是"不报错"）。
	clock := bjAt(2026, 9, 15, 10)
	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })

	for round := 1; round <= 3; round++ {
		if err := sched.tryRun(); err == nil {
			t.Fatalf("第 %d 轮：仍有订阅失败（且已过退避窗口），tryRun 必须报错（可观测面不能把失败显示成正常）", round)
		}
		// 三次尝试落在 t0 / +1h / +3h（退避 1h、2h、4h）—— 时钟必须按退避节奏推进，
		// 否则中间那些轮次会被退避窗口正当地跳过。
		clock = advanceToNextAttempt(t, db, brokenID, clock)
	}

	mu.Lock()
	gotHealthy, gotBroken := healthyHits, brokenHits
	mu.Unlock()
	if gotBroken != 3 {
		t.Fatalf("失败订阅的推送次数 = %d, want 3（失败必须按 tick 重试同一期）", gotBroken)
	}
	if gotHealthy != 1 {
		t.Fatalf("健康订阅的推送次数 = %d, want 1 —— 兄弟订阅失败导致它被重复投递同一期月报"+
			"（真实部署里每小时一轮、直到月底）", gotHealthy)
	}
}

// TestDispatchAllCountsOnlyPendingSubscriptions 钉住返回值语义：第 2 轮起
// `DispatchAll` 只尝试"待补跑"的订阅 ⇒ ok=0/failed=1；健康订阅根本不在尝试集合里。
func TestDispatchAllCountsOnlyPendingSubscriptions(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()

	if _, err := serverstore.CreateReportSubscription(db, "finance-ok", srv.URL, true); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateReportSubscription(db, "compliance-broken", bad.URL, true); err != nil {
		t.Fatal(err)
	}
	clock := bjAt(2026, 9, 15, 10)
	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })

	if err := sched.tryRun(); err == nil {
		t.Fatal("首轮有失败订阅，必须报错")
	}
	clock = clock.Add(time.Hour) // 越过首轮失败后的 1 小时退避窗口
	// 首轮后：健康订阅本月已投递（不再欠投），只有失败订阅待补跑。直接调 DispatchAll 读
	// 返回值——它统计的是"**真正尝试过**的订阅"，因此必须是 ok=0/failed=1
	// （变异：去掉 per-subscription 过滤 ⇒ ok=1，本断言红）。
	ok, failed, err := DispatchAll(context.Background(), db, clock)
	if err != nil {
		t.Fatalf("DispatchAll 不该在订阅级推送失败时返回顶层错误: %v", err)
	}
	if ok != 0 || failed != 1 {
		t.Fatalf("第 2 轮 DispatchAll 尝试集 = ok:%d failed:%d, want ok:0 failed:1 —— "+
			"已投递成功的订阅不得进入尝试集", ok, failed)
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range subs {
		switch s.Name {
		case "finance-ok":
			if s.LastRunAt == nil || s.LastError != "" {
				t.Fatalf("健康订阅终态错误: %+v", s)
			}
		case "compliance-broken":
			if s.LastRunAt != nil {
				t.Fatalf("失败订阅不得推进 last_run_at（否则本月内零重试）: %+v", s)
			}
			if s.LastError == "" {
				t.Fatal("失败原因必须落 last_error")
			}
		default:
			t.Fatalf("意外订阅: %+v", s)
		}
	}
}

// TestAlreadyDeliveredSubscriptionIsNotRedelivered：本月内已**成功**投递过的订阅
// 不欠投 —— 兄弟失败时它一次都不该再收到。
func TestAlreadyDeliveredSubscriptionIsNotRedelivered(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer bad.Close()

	id, err := serverstore.CreateReportSubscription(db, "finance-ok", srv.URL, true)
	if err != nil {
		t.Fatal(err)
	}
	clock := bjAt(2026, 9, 15, 10)
	now := clock
	// 本月内已成功投递过 ⇒ ShouldRunMonthly=false。
	if err := serverstore.MarkReportRun(db, id, true, ""); err != nil {
		t.Fatal(err)
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 || ShouldRunMonthly(now, subs[0].LastRunAt) {
		t.Fatalf("前置条件不成立：该订阅本月应已投递（last_run_at=%v）", subs[0].LastRunAt)
	}
	// 再加一个持续失败的订阅，把调度器的 should 打开。
	brokenID, berr := serverstore.CreateReportSubscription(db, "compliance-broken", bad.URL, true)
	if berr != nil {
		t.Fatal(berr)
	}

	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })
	for round := 1; round <= 3; round++ {
		if err := sched.tryRun(); err == nil {
			t.Fatalf("第 %d 轮：仍有订阅失败（且已过退避窗口），tryRun 必须报错", round)
		}
		clock = advanceToNextAttempt(t, db, brokenID, clock) // 退避 1h → 2h → 4h
	}
	mu.Lock()
	got := hits
	mu.Unlock()
	if got != 0 {
		t.Fatalf("本月已成功投递的订阅被重投 %d 次, want 0（它不欠投）", got)
	}
}

// TestControlHealthyOnlyDeliveredOnce 是对照（量具自检）：只有健康订阅、无兄弟失败时，
// 三轮里恰好 1 次投递 —— 它证明上面的重复不是"每轮必推"的探针产物。
func TestControlHealthyOnlyDeliveredOnce(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := serverstore.CreateReportSubscription(db, "finance-ok", srv.URL, true); err != nil {
		t.Fatal(err)
	}
	now := bjAt(2026, 9, 15, 10)
	sched := NewScheduler(db, time.Hour, func() time.Time { return now })
	for round := 1; round <= 3; round++ {
		if err := sched.tryRun(); err != nil {
			t.Fatalf("第 %d 轮不该报错: %v", round, err)
		}
	}
	mu.Lock()
	got := hits
	mu.Unlock()
	if got != 1 {
		t.Fatalf("对照：健康订阅单独存在时推送次数 = %d, want 1", got)
	}
}
