package reports

// R21C-01（审计 2026-09-26，**P1**）的端到端判据：webhook 连续失败跨过 N≥3 个
// 北京月界之后恢复，**每一个**欠投期号都必须被投**恰好一次**，顺序递增、无重复；
// 同时"稳态下每期只投一次、不无限重投"的老契约不得退化。
//
// ## 缺陷形态（判据要杀的东西）
//
// `pending_period` 是**单槽**、且成功落账一律"清空 + `last_run_at = now()`"：
//
//	07-15 tick 该投 2026-06 ⇒ 失败 ⇒ pending=2026-06（此后不覆盖）
//	08-15 / 09-15 tick 仍补 2026-06 —— 这期间 2026-07/08 也"轮到自己"了，
//	        但既不进 pending_period 也不落任何痕迹
//	10-15 tick 补 2026-06 成功 ⇒ 清空 pending + last_run_at=2026-10
//	10-15 再 tick ⇒ ShouldRunMonthly(10月,10月)=false ⇒ 不再投
//	11-15 tick ⇒ CurrentPeriod 只给"上一个北京月"=2026-10 ⇒ 投 2026-10
//	⇒ 2026-07 / 2026-08 / 2026-09 **永久丢失**，产品里没有任何恢复路径
//	  （`POST /report-subscriptions/:id/test` 只生成"上一个北京月"）
//
// 真 PG 实测（本用例的前身探针）：delivered=[2026-06 2026-10]、
// never=[2026-07 2026-08 2026-09]。
//
// ## 修后契约（游标逐期推进）
//
// 每次成功投出期号 P 之后：P 严格早于"当前应投期" ⇒ 游标推进到 P+1（下一个 tick
// 接着补）；投到"当前应投期"才清空游标。⇒ 每个 tick 补一期、按序补齐，不跳期、
// 不重投，且**不需要新迁移**（复用 0082 的 `pending_period`，语义从"那一期"放宽成
// "最早未投的那一期" —— 正是建列注释写的意思）。
//
// ## 变异（必须变红）
//
//   - 成功落账退回 `MarkReportAttemptOn(…, true, …)`（= 投出即清空游标）⇒ 本用例红
//     （delivered 停在第 1 期，never 出现 3 期）；
//   - `nextPendingAfterDelivery` 恒返回 ""（清空）⇒ 同上红；
//   - 游标推进但**永不推进到当前期**（例如恒返回 periodAfter(period) 不管是否已到
//     当前期）⇒ 稳态断言红（同一期被无限重投）。

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestMultiMonthBacklogIsCatchUpPeriodByPeriod(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	var mu sync.Mutex
	var delivered []string
	broken := true
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body ReportBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		defer mu.Unlock()
		if broken {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		delivered = append(delivered, body.Period)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	id, err := serverstore.CreateReportSubscription(db, "finance", srv.URL, true)
	if err != nil {
		t.Fatal(err)
	}

	// tick 驱动生产投递入口 DispatchAll（调度器只是它的门卫，见 scheduler.tryRun），
	// 并把 `last_run_at` 对齐到注入时钟。
	//
	// 为什么必须对齐：生产里 `last_run_at` 由 SQL `now()` 写入 = **真实墙钟**，而本
	// 用例用注入时钟推进月份（真实跑三个月不可能）。不对齐的话 `ShouldRunMonthly`
	// 会拿 2026-09 的真实墙钟去比注入的 2026-10，把"本月已投过"判成 false ⇒ 同一期
	// 被重复投递 —— 那是**判据自身的人造偏差**，不是产品行为。对齐 = 让库里的
	// "最后一次成功时刻"与注入时钟一致，复刻"这一轮真的发生在那个月"的部署事实。
	tick := func(clock time.Time) (ok, failed int) {
		t.Helper()
		ok, failed, derr := DispatchAll(context.Background(), db, clock)
		if derr != nil {
			t.Fatalf("DispatchAll(%s): %v", clock.Format("2006-01-02"), derr)
		}
		if ok > 0 {
			if _, err := db.Exec(`UPDATE report_subscriptions SET last_run_at = $1 WHERE id = $2`,
				clock, id); err != nil {
				t.Fatal(err)
			}
		}
		sub, err := serverstore.GetReportSubscription(db, id)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("tick %s ⇒ ok=%d failed=%d pending=%q streak=%d",
			clock.Format("2006-01-02 15:04"), ok, failed, sub.PendingPeriod, sub.FailStreak)
		return ok, failed
	}

	// —— 7/8/9 三个月：webhook 一直 500（跨过 3 个月界）。
	for _, clock := range []time.Time{
		bjAt(2026, 7, 15, 10), bjAt(2026, 8, 15, 10), bjAt(2026, 9, 15, 10),
	} {
		if ok, failed := tick(clock); ok != 0 || failed != 1 {
			t.Fatalf("%s: ok=%d failed=%d, want ok=0 failed=1（前提：这三个月 webhook 全坏）",
				clock.Format("2006-01-02"), ok, failed)
		}
	}
	sub, err := serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.PendingPeriod != "2026-06" {
		t.Fatalf("连续失败三个月后 pending_period = %q, want 2026-06 —— 第一次失败必须钉住最早未投期",
			sub.PendingPeriod)
	}

	// —— 10/15 修好：此后按小时 tick，逐期补齐。
	mu.Lock()
	broken = false
	mu.Unlock()
	oct := bjAt(2026, 10, 15, 10)
	for h := 0; h < 4; h++ {
		tick(oct.Add(time.Duration(h) * time.Hour))
	}

	mu.Lock()
	got := append([]string{}, delivered...)
	mu.Unlock()
	t.Logf("投递期号序列 = %v", got)

	// 判据①：**每一个**欠投期号各被投恰好一次，且顺序递增（不跳期、不重投）。
	want := []string{"2026-06", "2026-07", "2026-08", "2026-09"}
	if len(got) != len(want) {
		t.Fatalf("投递期号 = %v（%d 期），want %v —— 跨月失败期间到期的中间各期被静默跳过"+
			"（修前实测 delivered=[2026-06 2026-10]、never=[2026-07 2026-08 2026-09]，"+
			"且产品里没有恢复路径）", got, len(got), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("投递期号 = %v, want %v（必须按序补齐、不得乱序或重复）", got, want)
		}
	}

	// 判据②：欠投补完之后游标必须清空（否则会把已投的期一直重投）。
	sub, err = serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.PendingPeriod != "" {
		t.Fatalf("补齐后 pending_period = %q, want 空 —— 投到当前应投期之后游标必须收口",
			sub.PendingPeriod)
	}

	// 判据③（老契约不退化）：稳态下同月再 tick 不得重投任何一期。
	for h := 4; h < 6; h++ {
		if ok, failed := tick(oct.Add(time.Duration(h) * time.Hour)); ok != 0 || failed != 0 {
			t.Fatalf("稳态 tick ok=%d failed=%d, want 0/0 —— 已投过的期不得被重复投递"+
				"（游标收口后 ShouldRunMonthly 必须挡住本月重复投）", ok, failed)
		}
	}
	// 调度器的门卫（SubscriptionDuePeriod）必须与 DispatchAll 同结论：不欠投 ⇒ 整轮不触发。
	if err := NewScheduler(db, time.Hour, func() time.Time { return oct.Add(6 * time.Hour) }).tryRun(); err != nil {
		t.Fatalf("稳态调度轮次不该失败: %v", err)
	}
	mu.Lock()
	final := append([]string{}, delivered...)
	mu.Unlock()
	if len(final) != len(want) {
		t.Fatalf("稳态之后累计投递 = %v, want %v —— 出现了重复投递", final, want)
	}

	// 判据④：下一个月按正常节奏投"上一个北京月"，跨月补投不会把后续正常节奏打乱。
	tick(bjAt(2026, 11, 15, 10))
	mu.Lock()
	final = append([]string{}, delivered...)
	mu.Unlock()
	if len(final) != len(want)+1 || final[len(final)-1] != "2026-10" {
		t.Fatalf("11 月 tick 之后累计投递 = %v, want %v + [2026-10] —— "+
			"补齐历史欠投后必须回到正常月度节奏", final, want)
	}
}

// TestPhaseTwoCriteriaAreNotRedundantUnderCursorSemantics 是 R21C-05（审计
// 2026-09-26，P3 的复核结论）的判据：阶段二的两条判据**各自承重**。
//
// 审计当时的判定是「`!stillDue`（reports.go:460）与 `freshPeriod != period`（:466）
// 在现有契约下等价 ⇒ 各删一条都不红」。那个判定在**旧的单槽游标**下成立：成功即清空
// pending 并把 last_run_at 推到当月 ⇒ 阶段二重读要么"不欠投"（第一条抓住）、要么
// "还是那一期"（第二条永远不触发）。
//
// R21C-01 把游标改成**逐期推进**之后，出现了第三种状态：对方投出了一期、游标推进到
// 下一期 ⇒ **仍然 due，但期号变了**。此时第一条不触发、第二条必须触发；删掉第二条
// 会把"已经投出去的那一期"再投一遍。本用例用两个具体的订阅状态把这两种状态并列钉住。
func TestPhaseTwoCriteriaAreNotRedundantUnderCursorSemantics(t *testing.T) {
	// 阶段一读到的状态：欠投 2026-06，本轮已按它生成了报表。
	const claimedPeriod = "2026-06"
	month := bjAt(2026, 10, 15, 10) // CurrentPeriod(month) = 2026-09

	cases := []struct {
		name            string
		sub             serverstore.ReportSubscription
		wantStillDue    bool
		wantPeriodMoved bool
		why             string
	}{
		{
			name: "对方投完最后一期（游标清空 + last_run_at 落到本月）",
			sub: serverstore.ReportSubscription{
				Enabled: true, PendingPeriod: "", LastRunAt: ptrTime(month),
			},
			wantStillDue:    false, // ⇒ 第一条判据（!stillDue）承重
			wantPeriodMoved: false,
			why:             "整条不再欠投：本轮不得再投",
		},
		{
			name: "对方投完一期但游标推进到下一期（仍然欠投的是别的一期）",
			sub: serverstore.ReportSubscription{
				Enabled: true, PendingPeriod: "2026-07", LastRunAt: ptrTime(month),
			},
			wantStillDue:    true, // ⇒ 第一条不触发
			wantPeriodMoved: true, // ⇒ 第二条判据（freshPeriod != period）承重
			why:             "仍然 due，但本轮生成的 2026-06 已经不是该投的那一期：投出去就是重复投递",
		},
	}
	for _, c := range cases {
		freshPeriod, stillDue, _ := SubscriptionDuePeriod(month, c.sub)
		if stillDue != c.wantStillDue {
			t.Fatalf("%s: stillDue=%v, want %v（%s）", c.name, stillDue, c.wantStillDue, c.why)
		}
		moved := stillDue && freshPeriod != claimedPeriod
		if moved != c.wantPeriodMoved {
			t.Fatalf("%s: freshPeriod=%q（claimed=%q）⇒ 第二条判据触发=%v, want %v（%s）",
				c.name, freshPeriod, claimedPeriod, moved, c.wantPeriodMoved, c.why)
		}
	}

	// 反向自证：两种状态**必须**能在同一份契约下同时构造出来 —— 否则"各自承重"
	// 就只是注释里的一句话（这正是审计当时判"互相冗余"的原因）。
	if cases[0].wantStillDue == cases[1].wantStillDue || cases[0].wantPeriodMoved == cases[1].wantPeriodMoved {
		t.Fatal("两种状态没有区分度：两条判据在本契约下仍然等价")
	}
}
