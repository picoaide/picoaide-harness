package reports

// R21C-03（审计 2026-09-26，P2）的判据：**修好 webhook 之后必须立刻能补投**，
// 而不是继续待在旧地址算出的退避窗口里。
//
// ## 缺陷形态（判据要杀的东西）
//
// `serverstore.UpdateReportSubscription` 清 `last_error` 却**不碰**
// `fail_streak` / `next_attempt_at`。`reportRetryDelay(streak≥2) = 24h`，于是管理员
// 改好地址后：界面显示「最近错误 = —、订阅启用」看着已经恢复，实际最长要干等
// **24 小时**才有下一次投递 —— 与 delivery_policy.go 承诺的"管理员修好 webhook 后
// 最多等 1 小时就补投"相反，而且"改好了但没反应"与"一切正常"在界面上同形。
//
// ## 修后契约
//
// **地址真的变了 = 合法的退避重置点**（配置变更 ⇒ 旧地址上的连续失败史与新地址
// 无关）：`fail_streak = 0`、`next_attempt_at = NULL`，下一个 tick 立刻可投；
// 但 `pending_period`（欠投事实）**不清**。
//
// 「留空 = 不修改」**不**触发重置：地址没变就没有重置点，否则每次改个名字都会把
// 永久坏地址的退避重置回 1 小时，投递频率被管理端操作放大。
//
// ## 变异（必须变红）
//
//   - `UpdateReportSubscription` 去掉两个归零 CASE ⇒ 第 1 条红（改地址后仍不投）；
//   - 去掉 `? <> ''` 条件（留空也重置）⇒ 第 2 条红（改名把退避洗掉）。

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// countingWebhook 起一个接收器，返回 (URL, 计数函数, 关闭函数)。
func countingWebhook(t *testing.T, status int) (string, func() int) {
	t.Helper()
	var mu sync.Mutex
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	return srv.URL, func() int {
		mu.Lock()
		defer mu.Unlock()
		return hits
	}
}

func TestFixingHookURLResetsBackoffSoCatchUpIsImmediate(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	badURL, badHits := countingWebhook(t, http.StatusInternalServerError)
	goodURL, goodHits := countingWebhook(t, http.StatusOK)

	base := bjAt(2026, 9, 15, 0)
	// created_at 与注入时钟同月（游标下界 = CurrentPeriod(created_at)，见 reports_test.go）。
	id := createSubscriptionAt(t, db, "ops", badURL, base)
	// 连续失败两次：第 1 次 ⇒ 退避 1 小时；第 2 次 ⇒ 退避 24 小时。
	_ = NewScheduler(db, time.Hour, func() time.Time { return base }).tryRun()
	_ = NewScheduler(db, time.Hour, func() time.Time { return base.Add(time.Hour) }).tryRun()

	sub, err := serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.FailStreak != 2 || sub.NextAttemptAt == nil {
		t.Fatalf("前置不成立：连续失败两次后 streak=%d next_attempt=%v，want 2 / 非空",
			sub.FailStreak, sub.NextAttemptAt)
	}
	blockedUntil := *sub.NextAttemptAt

	// —— 管理员改地址（配置变更）——
	if err := serverstore.UpdateReportSubscription(db, id, "ops", goodURL, true); err != nil {
		t.Fatalf("改地址: %v", err)
	}
	sub, err = serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.FailStreak != 0 || sub.NextAttemptAt != nil {
		t.Fatalf("改地址后 streak=%d next_attempt=%v —— 配置变更必须归零退避"+
			"（否则界面显示「最近错误 = —」像已恢复，实际最长还要干等 24 小时）",
			sub.FailStreak, sub.NextAttemptAt)
	}
	if sub.PendingPeriod != CurrentPeriod(base.Add(time.Hour)) {
		t.Fatalf("改地址不得动 pending_period（欠投是事实，与地址无关）：got %q want %q",
			sub.PendingPeriod, CurrentPeriod(base.Add(time.Hour)))
	}

	// —— 落在旧退避窗口之内（改地址后 2 小时，远早于 blockedUntil）的 tick 必须真的投出去。
	probe := blockedUntil.Add(-12 * time.Hour)
	if !probe.After(base.Add(time.Hour)) {
		t.Fatalf("判据前提不成立：旧退避窗口 %v 太短，构造不出「窗口内的一次 tick」", blockedUntil)
	}
	if _, _, err := DispatchAll(t.Context(), db, probe); err != nil {
		t.Fatalf("DispatchAll: %v", err)
	}
	if goodHits() != 1 {
		t.Fatalf("改地址后窗口内的 tick 投递次数 = %d, want 1 —— 退避没有随配置变更归零"+
			"（旧地址算出的窗口最长 24 小时，与「修好后最多 1 小时补投」的承诺相反）", goodHits())
	}
	if badHits() != 2 {
		t.Fatalf("旧地址的投递次数 = %d, want 2（改地址后不得再打到旧地址）", badHits())
	}
}

func TestRenamingWithoutURLChangeKeepsBackoff(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	badURL, badHits := countingWebhook(t, http.StatusInternalServerError)
	base := bjAt(2026, 9, 15, 0)
	id := createSubscriptionAt(t, db, "ops", badURL, base)
	_ = NewScheduler(db, time.Hour, func() time.Time { return base }).tryRun()
	_ = NewScheduler(db, time.Hour, func() time.Time { return base.Add(time.Hour) }).tryRun()

	// 「留空 = 不修改」：地址没变 ⇒ 不是重置点（只改名字）。
	if err := serverstore.UpdateReportSubscription(db, id, "ops-renamed", "", true); err != nil {
		t.Fatalf("改名: %v", err)
	}
	sub, err := serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.FailStreak != 2 || sub.NextAttemptAt == nil {
		t.Fatalf("改名（地址未变）后 streak=%d next_attempt=%v, want 2 / 非空 —— "+
			"地址没变就没有重置点，否则每次改名字都会把永久坏地址的退避洗回 1 小时",
			sub.FailStreak, sub.NextAttemptAt)
	}
	// 窗口内 tick：仍然不许投（退避未被洗掉）。
	probe := base.Add(2 * time.Hour)
	_ = NewScheduler(db, time.Hour, func() time.Time { return probe }).tryRun()
	if got := badHits(); got != 2 {
		t.Fatalf("窗口内 tick 的投递次数 = %d, want 2 —— 退避被无关配置变更洗掉了"+
			"（投递频率会被管理端的每次编辑放大）", got)
	}
}
