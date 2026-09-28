package opens

// R20A-S-01（审计 2026-09-25，P1，**不可逆**）的端到端判据：
// 保留期边界日恰好是"本地零点不存在"的 DST 缺口日时，长期日汇总**不许少算**。
//
// ## 现场
//
// `America/Santiago` 2026-09-06 没有本地 00:00（00:00 -04:00 直接跳到 01:00 -03:00），
// 朴素的 `time.Date(y,m,d,0,0,0,0,time.Local)` 被 Go 归一化到**前一天 23:00** ⇒
// `AggregateWasmAppOpens` 的日阶梯上相邻两桶**键相同**（都写 day='2026-09-05'）⇒
// `ON CONFLICT DO UPDATE SET pv = EXCLUDED.pv` 后写覆盖前写；`PurgeWasmAppOpens` 又用
// 同一个阶梯当 cutoff ⇒ 明细同轮被硬删。终态实测 `pv=8（want 10）`、`09-06` 行 1（应 3）
// —— 那 2 次开放在明细与日汇总里**都不存在**（修前更差：三个 now 形态 4/6/6）。
//
// ## 判据（与实现口径无关的那一条）
//
// **终态总量守恒**：`SUM(wasm_app_opens_daily.pv) == 种入明细总数`（日桶语义、时区、DST
// 形态都不参与），外加两条过程不变量（日汇总单调不降 / 明细绝不被删掉一半）。
//
// ⚠️ 不要用"按行标签整日删除"当判据（审计方的第一版量具就是这么假红的）：行标签是
// `LocalDayString(opened_at)`，而桶是 `[LocalDay(D), NextLocalDay(D))` —— 判据一旦要求
// 两者相等，就等于把实现口径抄进判据里；守恒式才是外部可验证的那一半。
//
// ⚠️ 本用例会改写进程级 `time.Local`（日界口径就是部署 TZ），因此**不得并行**。
// 它依赖真 PG（`serverstore.NewTestDB` 在无 PG 时自行 Skip）。

import (
	"context"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestSchedulerKeepsRollupWhenRetentionBoundaryIsDSTGap 是上面那条判据的本体。
func TestSchedulerKeepsRollupWhenRetentionBoundaryIsDSTGap(t *testing.T) {
	loc, err := time.LoadLocation("America/Santiago")
	if err != nil {
		t.Skipf("本机没有 America/Santiago 时区数据: %v", err)
	}
	// 自校准：本机 tzdata 里缺口日真的存在吗？不存在则这条判据咬不到（不许假红）。
	if got := time.Date(2026, 9, 6, 0, 0, 0, 0, loc).Format("2006-01-02"); got == "2026-09-06" {
		t.Skipf("本机 tzdata 的 Santiago 2026-09-06 没有零点缺口，判据不可咬")
	}
	prevLocal := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prevLocal })

	db := testDB(t)
	ctx := context.Background()
	userID := seedUser(t, db, "u-dst-gap")

	// now 取"本地 00:00"这一族形态（墙钟落在不存在的时刻上正是现场）。
	now := time.Date(2026, 12, 5, 0, 0, 0, 0, loc)
	boundary := serverstore.AddLocalDays(now, -serverstore.WasmAppOpensRetentionDays)
	if got := serverstore.LocalDayString(boundary); got != "2026-09-06" {
		t.Fatalf("用例前提不成立：保留期边界日 = %s, want 2026-09-06（缺口日）", got)
	}

	// 种入：边界日的前一天 / 当天 / 后一天各 3 条（日首、日中、日尾）。
	// 期望表按**行的真实本地日期**记账（缺口日的"00:00"墙钟不存在，会被 Go 归一化到
	// 相邻时刻 —— 那不是数据丢失，只要守恒式成立）。
	appID := "dst-gap"
	expected := map[string]int64{}
	seed := func(at time.Time) {
		t.Helper()
		if err := serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
			AppID: appID, UserID: userID, At: at}); err != nil {
			t.Fatalf("种明细 %s: %v", at.Format(time.RFC3339), err)
		}
		expected[serverstore.LocalDayString(at)]++
	}
	by, bm, bd := boundary.In(loc).Date()
	for _, off := range []int{-1, 0, 1} {
		for _, clock := range []time.Time{
			time.Date(by, bm, bd+off, 0, 0, 0, 0, loc),
			time.Date(by, bm, bd+off, 12, 0, 0, 0, loc),
			time.Date(by, bm, bd+off, 23, 59, 59, 0, loc),
		} {
			seed(clock)
		}
	}
	// 保留期内的"新"一天：离 now 5 天，落在两个维护窗口之外 ⇒ 先显式汇总一次
	// （这正是生产里发生的事：每个自然日在它还是"最近两天"时被活动窗汇总过）。
	fresh := serverstore.AddLocalDays(now, -5)
	seed(fresh.Add(9 * time.Hour))
	if _, err := serverstore.AggregateWasmAppOpens(ctx, db, fresh, fresh); err != nil {
		t.Fatalf("预汇总 fresh 日: %v", err)
	}

	var seeded int64
	for _, n := range expected {
		seeded += n
	}

	// 时钟从 now-2d 扫到 now+4d（一小时一步）：种入的三天都会经过"待删区间"，
	// 保留期边界也会真的扫过缺口日。
	clock := serverstore.AddLocalDays(now, -2)
	end := serverstore.AddLocalDays(now, 4)
	sched := NewScheduler(db, time.Hour, func() time.Time { return clock })

	prevPV := int64(-1)
	prevDetail := int64(-1)
	rounds := 0
	for !clock.After(end) {
		sched.TryRun(ctx)
		rounds++

		var pv int64
		if err := db.QueryRow(`SELECT COALESCE(sum(pv),0) FROM wasm_app_opens_daily WHERE app_id = $1`, appID).
			Scan(&pv); err != nil {
			t.Fatalf("读日汇总: %v", err)
		}
		if prevPV >= 0 && pv < prevPV {
			t.Fatalf("第 %d 轮 clock=%s：日汇总合计由 %d 缩到 %d —— 日汇总被更小的值覆盖"+
				"（说明某一天被部分删除过）", rounds, clock.Format(time.RFC3339), prevPV, pv)
		}
		prevPV = pv

		// 过程不变量：某一天的剩余明细只能是 0（整日删完）或该天种入总数（一行没删）。
		var detail int64
		if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens WHERE app_id = $1`, appID).Scan(&detail); err != nil {
			t.Fatalf("数明细: %v", err)
		}
		if detail != prevDetail {
			prevDetail = detail
			rows, qerr := db.Query(`SELECT opened_at FROM wasm_app_opens WHERE app_id = $1`, appID)
			if qerr != nil {
				t.Fatalf("读明细: %v", qerr)
			}
			got := map[string]int64{}
			for rows.Next() {
				var at time.Time
				if serr := rows.Scan(&at); serr != nil {
					rows.Close()
					t.Fatalf("扫明细: %v", serr)
				}
				got[serverstore.LocalDayString(at.UTC())]++
			}
			rows.Close()
			for day, n := range got {
				want := expected[day]
				if want == 0 {
					t.Fatalf("探针自身错：明细落到了未预期的本地日 %s（%d 行）", day, n)
				}
				if n != want {
					t.Fatalf("第 %d 轮 clock=%s：本地日 %s 只剩 %d 行（种入 %d）—— 某一天被删掉了一半"+
						"（这正是日汇总缩水的必要条件）", rounds, clock.Format(time.RFC3339), day, n, want)
				}
			}
		}
		clock = clock.Add(time.Hour)
	}

	var final int64
	if err := db.QueryRow(`SELECT COALESCE(sum(pv),0) FROM wasm_app_opens_daily WHERE app_id = $1`, appID).
		Scan(&final); err != nil {
		t.Fatalf("读终态日汇总: %v", err)
	}
	// 逐日归属：终态的**每一个 day 键**都必须等于"本地日期就是这一天"的明细条数。
	// 这一条比总量更强：日阶梯只要错一小时（例如把 `NextLocalDay` 退回 `AddDate`），
	// 缺口日之后的桶就会吞掉次日第一个小时的行 —— 总量仍然守恒，但归属错了。
	got := map[string]int64{}
	rows, qerr := db.Query(`SELECT day::text, COALESCE(sum(pv),0) FROM wasm_app_opens_daily
		WHERE app_id=$1 GROUP BY 1 ORDER BY 1`, appID)
	if qerr != nil {
		t.Fatalf("读终态日汇总行: %v", qerr)
	}
	for rows.Next() {
		var day string
		var pv int64
		if serr := rows.Scan(&day, &pv); serr != nil {
			rows.Close()
			t.Fatalf("扫日汇总行: %v", serr)
		}
		got[day] = pv
	}
	rows.Close()
	if rerr := rows.Err(); rerr != nil {
		t.Fatalf("日汇总行: %v", rerr)
	}
	if final != seeded {
		t.Fatalf("终态总量不守恒：日汇总合计 pv=%d, want %d（%d 行明细；逐日：%v / 期望：%v）—— "+
			"缺口日的日桶被相邻桶覆盖（或明细在汇总前被删）", final, seeded, seeded, got, expected)
	}
	for day, want := range expected {
		if got[day] != want {
			t.Fatalf("日汇总的 day 键归属错误：%s = %d, want %d（全部：%v / 期望：%v）—— "+
				"日阶梯与日历日错位（DST 缺口日归一化的直接后果）", day, got[day], want, got, expected)
		}
	}
	for day, pv := range got {
		if _, ok := expected[day]; !ok && pv != 0 {
			t.Fatalf("日汇总里出现了没有明细的 day 键 %s=%d（期望：%v）", day, pv, expected)
		}
	}
	t.Logf("Santiago 缺口日边界：rounds=%d 种入=%d 终态日汇总=%d（逐日 %v）", rounds, seeded, final, got)

	// 保留期内那一天的明细绝不能被提前删（清理越界是 R19B-01 的另一半）。
	var freshLeft int64
	if err := db.QueryRow(`SELECT count(*) FROM wasm_app_opens WHERE app_id=$1 AND opened_at >= $2`,
		appID, fresh.UTC()).Scan(&freshLeft); err != nil {
		t.Fatalf("数保留期内明细: %v", err)
	}
	if freshLeft == 0 {
		t.Fatalf("保留期内（now-5d）的明细被提前清理")
	}
}
