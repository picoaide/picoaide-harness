package reports

// R18C-03（审计 2026-09-25，P2，承诺 > 实现）：月报订阅的"失败重试"修前**不存在** ——
// `MarkReportRun` 失败也写 `last_run_at` ⇒ 本北京月内 `ShouldRunMonthly` 恒 false（月内零重试）；
// 下一次真正运行在**下月**，那一轮生成的是"刚结束的那个月" ⇒ **失败的那一期永不投递**，
// 而 webadmin 对管理员承诺"上月未推送则次月 1 日后自动补发"/"失败会在下月补跑时重试"。
//
// 修后：失败不推进 `last_run_at`（只写 last_error）⇒ 该订阅本月内仍然"待补跑"，
// 调度器每一轮会重新生成**同一期**（GenerateMonthlyReport 取"上月"，本月内不变）
// 并重投，直到成功；成功一次即不再重复投递。
//
// R19A-S1-06（审计 2026-09-25，P2）**追加**了退避与期号记忆：失败后不是"下一 tick
// 立刻重投"（那会让永久坏的 webhook 每天被重投 24 次/实例），而是
// `next_attempt_at` 之前的轮次一律跳过；被跳过的轮次不生成报表、也不报错。因此本文件
// 的时钟按"退避到点再 tick"推进（`advanceToNextAttempt`）——**承诺不变**（失败仍会
// 重试、同一期、直到成功），变的只是节奏。退避本身的判据在
// report_delivery_policy_test.go。
//
// 本文件用真 PG + 真 HTTP webhook 跑**调度器那一轮**（tryRun），把"失败 → 下一轮补投同一期
// → 成功 → 不再重复"三步都钉住。残留（诚实边界）：失败持续跨过月界时，下一轮生成的是
// 最新一期，被跨过的那一期不再补投（单靠 last_run_at 表达不了"待补期号"，闭合需加列）。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestFailedMonthlyReportIsRetriedByNextSchedulerRound 钉"失败重试真的存在"。
func TestFailedMonthlyReportIsRetriedByNextSchedulerRound(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	var periods []string
	failing := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Period string `json:"period"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		periods = append(periods, body.Period)
		fail := failing
		mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusBadGateway)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}
	// 2026-09-15（北京）：本轮的期号 = 2026-08。
	clock := bjAt(2026, 9, 15, 10)
	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })

	// ① 第一次尝试：推送失败 ⇒ 必须如实返回错误，且**不**推进 last_run_at。
	if err := sched.tryRun(); err == nil {
		t.Fatal("首轮推送失败必须如实报错（可观测面不能把失败显示成正常）")
	}
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(subs) != 1 {
		t.Fatalf("订阅数 = %d, want 1", len(subs))
	}
	if subs[0].LastRunAt != nil {
		t.Fatalf("失败推进了 last_run_at（%v）⇒ 本月内不会再补跑", subs[0].LastRunAt)
	}
	if subs[0].LastError == "" {
		t.Fatal("失败原因必须落 last_error（管理端要看得见）")
	}
	// 失败后仍然"待补跑"——这正是重试存在的前提。
	if !ShouldRunMonthly(clock, subs[0].LastRunAt) {
		t.Fatal("失败后 ShouldRunMonthly = false ⇒ 本北京月内零重试（修前的缺陷形态）")
	}
	// 期号被记住（R19A-S1-07）：跨月也不会跳期。
	if subs[0].PendingPeriod != "2026-08" {
		t.Fatalf("pending_period = %q, want 2026-08（失败的那一期必须被记下来）", subs[0].PendingPeriod)
	}

	// ② webhook 恢复 ⇒ 退避到点后的下一轮必须补投**同一期**（失败的那一期），不是新一期。
	clock = advanceToNextAttempt(t, db, subs[0].ID, clock)
	mu.Lock()
	failing = false
	mu.Unlock()
	if err := sched.tryRun(); err != nil {
		t.Fatalf("恢复后的一轮不该失败: %v", err)
	}
	mu.Lock()
	got := append([]string{}, periods...)
	mu.Unlock()
	if len(got) != 2 {
		t.Fatalf("推送次数 = %d (%v), want 2（失败一次 + 补投一次）", len(got), got)
	}
	if got[0] != "2026-08" || got[1] != "2026-08" {
		t.Fatalf("补投的期号 = %v, want [2026-08 2026-08]（失败的那一期必须被重投）", got)
	}
	subs, err = serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	if subs[0].LastRunAt == nil {
		t.Fatal("成功必须推进 last_run_at")
	}
	if subs[0].LastError != "" {
		t.Fatalf("成功后 last_error 必须清空，实得 %q", subs[0].LastError)
	}
	if subs[0].PendingPeriod != "" || subs[0].NextAttemptAt != nil || subs[0].FailStreak != 0 {
		t.Fatalf("成功后补投标记/退避状态必须归零，实得 pending=%q streak=%d next=%v",
			subs[0].PendingPeriod, subs[0].FailStreak, subs[0].NextAttemptAt)
	}

	// ③ 成功之后同一期内不再重复投递（幂等锚：last_run_at 落进本月）。
	clock = clock.Add(time.Hour)
	if err := sched.tryRun(); err != nil {
		t.Fatalf("成功后的空转轮不该报错: %v", err)
	}
	mu.Lock()
	n := len(periods)
	mu.Unlock()
	if n != 2 {
		t.Fatalf("推送次数 = %d, want 2（成功后不得重复投递同一期）", n)
	}
}

// advanceToNextAttempt 把测试时钟推进到该订阅的退避到点（没有退避则 +1 小时）。
//
// 退避是 R19A-S1-06 引入的调度语义：失败后的轮次在 `next_attempt_at` 之前被跳过
// （不生成报表、不报错）。判据要验的是"承诺是否还在"（失败会重试、同一期、直到成功），
// 所以时钟必须按真实节奏走，而不是把退避当成"不重试"。
func advanceToNextAttempt(t *testing.T, db *sql.DB, subID int64, clock time.Time) time.Time {
	t.Helper()
	subs, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range subs {
		if s.ID != subID {
			continue
		}
		if s.NextAttemptAt != nil && s.NextAttemptAt.After(clock) {
			return s.NextAttemptAt.Add(time.Second)
		}
	}
	return clock.Add(time.Hour)
}

// TestRetrySurvivesAcrossSchedulerRoundsUntilSuccess 钉"重试有界且不丢"：
// 连续 3 轮失败 + 第 4 轮成功 ⇒ 恰好 4 次推送、期号全部是失败的那一期
// （证明调度器的每一轮都在补同一期，而不是"只重试一次"）。
func TestRetrySurvivesAcrossSchedulerRoundsUntilSuccess(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	var n int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		n++
		fail := n <= 3
		mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if _, err := serverstore.CreateReportSubscription(db, "ops", srv.URL, true); err != nil {
		t.Fatal(err)
	}
	clock := bjAt(2026, 9, 20, 10)
	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })
	subID := int64(0)
	for round := 1; round <= 4; round++ {
		err := sched.tryRun()
		if round <= 3 && err == nil {
			t.Fatalf("第 %d 轮（webhook 仍在 5xx，且已过退避窗口）必须报错", round)
		}
		if round == 4 && err != nil {
			t.Fatalf("第 4 轮（webhook 恢复）必须成功: %v", err)
		}
		if subs, lerr := serverstore.ListReportSubscriptions(db); lerr == nil && len(subs) == 1 {
			subID = subs[0].ID
		}
		clock = advanceToNextAttempt(t, db, subID, clock) // 退避窗口（1h → 2h → 4h）
	}
	mu.Lock()
	total := n
	mu.Unlock()
	if total != 4 {
		t.Fatalf("推送次数 = %d, want 4（3 次失败重试 + 1 次成功）", total)
	}
	subs, _ := serverstore.ListReportSubscriptions(db)
	if subs[0].LastRunAt == nil || subs[0].LastError != "" {
		t.Fatalf("终态错误: %+v", subs[0])
	}
}
