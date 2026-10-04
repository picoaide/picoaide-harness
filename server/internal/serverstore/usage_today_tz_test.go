package serverstore

// S1-A1（审计 2026-10，P1）的判据：`dayEndArgInclusive` 不得在**接收者的
// Location** 的墙钟空间里做「加一天」—— 它与左边界 `dayStartArg` 必须同口径
// （先归一到北京日，再做日历算术）。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前实现 `pgInstantArg(BeijingDayInstant(to.AddDate(0,0,1)))`：`AddDate` 加的是
// **接收者 Location** 的墙钟，而生产调用点直传 `time.Now()`（接收者 =
// `time.Local`）。跨本地 DST 切换那一步是 23h/25h，于是「次日北京日」或被压回
// **同一天**（半开区间塌成空集），或被推到**两天后**（窗口 48h）：
//
//	对 `UserDayUsageCost` ⇒ `today_usage/today_cost` 读 0 或翻倍；
//	对 `UsageAggregate(db, from, to)` ⇒ 概览/报表的截止日整段错窗。
//
// 触发前提（精确）：**进程 TZ 带 DST** 且 now 在切换前 24h 内且该瞬时北京墙钟
// 落在病态带（23h 方向 [00:00,01:00)、25h 方向 (23:00,24:00)）—— 部署缺省
// `TZ=Asia/Shanghai`/UTC 不触发，所以判据必须在用例内**主动切 `time.Local`**
// 并构造切换日附近的瞬时；靠外部 `TZ=` 的话 CI（UTC 容器）恒绿。
//
// ## 为什么现有用例咬不到（本文件补的就是这个盲区）
//
//	`usage_yesterday_tz_test.go` 只覆盖**昨日**（R21F-03 已修的那半边），它的两个
//	  case 恰好落在**今日窗口正常**的那一侧；
//	`usage_test.go:1184` 的时区维度用例传的是 `time.FixedZone`（**无 DST**）——
//	  固定偏移下墙钟 +24h 恒等于真实 +24h，结构上咬不到。
//
// ## 判据（三层，各自独立）
//
//	① 单元 · 穷举：在真实 tzdata 的 DST 时区上找切换瞬时，扫「切换前后 24h、
//	   步长 10 分钟」，断言 `[dayStartArg(t), dayEndArgInclusive(t)]` **恰好**
//	   覆盖 24h 且右边界等于**独立推导**的「次日北京 00:00」；
//	② 端到端 · 生产入口：`userUsageSummaryAt` 在病态瞬时上，`today_usage` 必须
//	   等于预置值（既不是 0 也不是翻倍），`yesterday_usage` 作对照；
//	③ 自校准：每层先证明"本组输入在本环境的 tzdata 下**修前形态会给出另一个
//	   答案**"（直接做一遍用例要做的动作），构造不出就 `t.Skipf` 说明本环境
//	   咬不到 —— 不假红，也不留恒真断言。
//
// ## 变异（必须变红，实测三种组合见 temp/audit-v282/fixes/S1-A1.md）
//
//	M-A 只回退 `beijing.go` 的右边界 ⇒ ①红；
//	M-B 只回退 `usage.go` 的调用点归一 ⇒ ①绿（右边界本体已修）；
//	M-C 两处都回退（= 修前形态）⇒ ①红 + ②红。

import (
	"testing"
	"time"
)

// nextBeijingDayStart 是「t 所在北京日的次日 00:00」的**独立推导**：取固定 +8h
// 墙钟的字面年月日 → 在 UTC 日期值上加一天 → 减回 8h。与实现
// （`BeijingDay`/`BeijingDayInstant`）不是同一条路径。
func nextBeijingDayStart(t time.Time) time.Time {
	bj := t.In(time.FixedZone("BJT", int(BeijingOffset/time.Second)))
	day := time.Date(bj.Year(), bj.Month(), bj.Day(), 0, 0, 0, 0, time.UTC)
	return day.AddDate(0, 0, 1).Add(-BeijingOffset)
}

// buggyDayEndArg 逐字复刻**修前形态**（`BeijingDayInstant(to.AddDate(0,0,1))`）。
// 它不参与产品逻辑，只用于自校准：证明这组采样点/这组数据在本环境的 tzdata 下
// 真的能咬到该缺陷（构造不出 ⇒ 本环境咬不到，跳过而不是假红）。
func buggyDayEndArg(t time.Time) string {
	return pgInstantArg(BeijingDayInstant(t.AddDate(0, 0, 1)))
}

// dstTransitions 扫出 [from,to] 内本地 UTC 偏移发生变化的瞬时（先按小时粗扫，
// 再二分收敛到分钟）。找不到切换（本机 tzdata 没有该区的切换、或语料年份错位）
// 时返回空 —— 调用方据此跳过，不许静默通过。
func dstTransitions(loc *time.Location, from, to time.Time) []time.Time {
	const coarse = time.Hour
	var out []time.Time
	prev := from
	_, prevOff := prev.In(loc).Zone()
	for cur := from.Add(coarse); !cur.After(to); cur = cur.Add(coarse) {
		if _, off := cur.In(loc).Zone(); off != prevOff {
			lo, hi := prev, cur // off(lo) == prevOff，off(hi) != prevOff
			for hi.Sub(lo) > time.Minute {
				mid := lo.Add(hi.Sub(lo) / 2)
				if _, mo := mid.In(loc).Zone(); mo == prevOff {
					lo = mid
				} else {
					hi = mid
				}
			}
			out = append(out, hi)
			_, prevOff = hi.In(loc).Zone()
		}
		prev = cur
	}
	return out
}

// TestDayEndArgInclusiveIsExactBeijingDayAcrossDSTZones 是判据①：在 DST 时区的
// 切换瞬时前后各 24h 内按 10 分钟步长穷举，断言日窗口恒为「北京日恰好 24h」。
//
// 采样点用 `cur.In(loc)` 构造 —— 与生产一致：`AddDate` 看的是**接收者**的
// Location，`time.Now()` 的接收者就是 `time.Local`。
func TestDayEndArgInclusiveIsExactBeijingDayAcrossDSTZones(t *testing.T) {
	from := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC)
	const step = 10 * time.Minute

	// Lord_Howe 的 DST 只挪 30 分钟 —— 覆盖"非整小时 DST"这一形态。
	for _, name := range []string{"America/Santiago", "America/New_York", "Australia/Lord_Howe"} {
		t.Run(name, func(t *testing.T) {
			loc := mustLoad(t, name) // tzdata 缺失 ⇒ t.Skipf（本仓惯例：不静默跳过）
			withLocal(t, loc)

			transitions := dstTransitions(loc, from, to)
			if len(transitions) == 0 {
				t.Skipf("%s 在 %s..%s 内没有 DST 切换（本机 tzdata 与用例语料不匹配）"+
					"—— 判据在本环境咬不到，不假红", name, from.Format(dateFmt), to.Format(dateFmt))
			}

			var checked, teeth int
			var firstRed time.Time
			for _, tr := range transitions {
				for cur := tr.Add(-24 * time.Hour); !cur.After(tr.Add(24 * time.Hour)); cur = cur.Add(step) {
					arg := cur.In(loc)
					checked++
					// 自校准：该采样点在本机 tzdata 下确实处在"墙钟 +1 天 ≠ 真实 +24h"的形态。
					if dayEndArgInclusive(arg) != buggyDayEndArg(arg) {
						teeth++
						if firstRed.IsZero() {
							firstRed = arg
						}
					}

					lo, err := time.Parse(pgInstantFmt, dayStartArg(arg))
					if err != nil {
						t.Fatalf("parse 左边界 %q: %v", dayStartArg(arg), err)
					}
					hi, err := time.Parse(pgInstantFmt, dayEndArgInclusive(arg))
					if err != nil {
						t.Fatalf("parse 右边界 %q: %v", dayEndArgInclusive(arg), err)
					}
					want := nextBeijingDayStart(arg)
					if !hi.Equal(want) {
						t.Errorf("右边界 = %s, want %s（北京日 %s 的次日 00:00）—— 入参 %s（%s / 北京 %s）",
							dayEndArgInclusive(arg), pgInstantArg(want), BeijingDay(arg).Format(dateFmt),
							arg.Format(time.RFC3339), arg.Format("2006-01-02 15:04 MST"),
							arg.In(time.FixedZone("BJT", int(BeijingOffset/time.Second))).Format("2006-01-02 15:04"))
					}
					if span := hi.Sub(lo); span != 24*time.Hour {
						t.Errorf("日窗口 = [%s, %s) 跨度 %v, want 24h（0h = 今日读 0；48h = 今日翻倍）—— 入参 %s（%s）",
							dayStartArg(arg), dayEndArgInclusive(arg), span,
							arg.Format(time.RFC3339), arg.Format("2006-01-02 15:04 MST"))
					}
				}
			}

			if teeth == 0 {
				// 有切换却一个"墙钟位移"采样点都没有 ⇒ 是本用例的语料/采样写错了
				// （判据会退化成恒真断言），属测试缺陷，必须红。
				t.Fatalf("自校准失败：%s 有 %d 次 DST 切换，但 %d 个采样点里没有一处墙钟 +1 天 ≠ 真实 +24h"+
					"—— 判据成了恒真断言，请检查语料年份与采样步长", name, len(transitions), checked)
			}
			t.Logf("%s：切换 %d 次 · 采样 %d 点 · 其中 %d 点能咬到修前形态（首个 %s）",
				name, len(transitions), checked, teeth, firstRed.Format(time.RFC3339))
		})
	}
}

// TestUserUsageSummaryTodayWindowAcrossDSTSwitch 是判据②：走**生产入口**
// `userUsageSummaryAt`，在病态瞬时上断言 `today_usage` 等于预置值。
//
// 每个 case 的数据布局（北京日）：
//
//	昨天 = 500_000（对照：昨日路径不得被今天的修复带偏）
//	今天 = 1_000_000（唯一应被"今日"读到的值）
//	明天 = 2_000_000（只有窗口被展成 48h 时才会被误算进"今日"）
//
// 自校准用的是**真库查询**（直接用修前右边界查一次），而不是手算：它证明
// "在这批数据上，修前形态给出的今日读值与 1_000_000 不同" ⇒ 用例有牙。
func TestUserUsageSummaryTodayWindowAcrossDSTSwitch(t *testing.T) {
	cases := []struct {
		name string
		zone string
		// 本地墙钟（用 time.ParseInLocation 在目标时区解释）。
		wall string
		// 形态说明（只进日志/失败信息）。
		shape string
	}{
		{
			// 本地 2026-09-06 00:00 → 01:00（夏令时开始，-04 → -03）；
			// now = 本地 09-05 12:30（-04）= 北京 09-06 00:30 ⇒ 墙钟 +1 天只挪 23h。
			name: "America/Santiago DST 开始", zone: "America/Santiago", wall: "2026-09-05 12:30",
			shape: "墙钟 +1 天 = 23h ⇒ 右边界被压回同一天（窗口塌成空集）",
		},
		{
			// 本地 2026-04-05 00:00 回拨到 04-04 23:00（夏令时结束，-03 → -04）；
			// now = 本地 04-04 12:30（-03）= 北京 04-04 23:30 ⇒ 墙钟 +1 天要挪 25h。
			name: "America/Santiago DST 结束", zone: "America/Santiago", wall: "2026-04-04 12:30",
			shape: "墙钟 +1 天 = 25h ⇒ 右边界被推到两天后（窗口展成 48h）",
		},
		{
			// 本地 2026-03-08 02:00 → 03:00（EST -05 → EDT -04）；
			// now = 本地 03-07 11:30（EST）= 北京 03-08 00:30 ⇒ 23h 方向。
			name: "America/New_York DST 开始", zone: "America/New_York", wall: "2026-03-07 11:30",
			shape: "墙钟 +1 天 = 23h ⇒ 右边界被压回同一天（窗口塌成空集）",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			loc := mustLoad(t, tc.zone) // tzdata 缺失 ⇒ t.Skipf
			withLocal(t, loc)

			now, err := time.ParseInLocation("2006-01-02 15:04", tc.wall, loc)
			if err != nil {
				t.Fatalf("构造 now(%s @ %s): %v", tc.wall, tc.zone, err)
			}
			today := BeijingDay(now)
			bjWall := now.In(time.FixedZone("BJT", int(BeijingOffset/time.Second)))

			db, cleanup := newUsageDB(t)
			defer cleanup()
			mustPricedModel(t, db, "priced-model", 2.0, 8.0)
			uid := mustUserID(t, db)

			put := func(day time.Time, tokens int64) {
				t.Helper()
				id, err := RecordUsageKind(db, uid, "priced-model", tokens, 0, "chat")
				if err != nil {
					t.Fatalf("播用量行: %v", err)
				}
				setCreatedAtAt(t, db, id, BeijingDayAt(day, 10))
			}
			put(today.AddDate(0, 0, -1), 500_000) // 昨天（对照）
			put(today, 1_000_000)                 // 今天（唯一应当被"今日"读到的值）
			put(today.AddDate(0, 0, 1), 2_000_000)

			// 自校准（真库查询，直接做一遍用例要做的动作）：修前右边界下这
			// 批数据的"今日读值"必须**不是** 1_000_000，否则本组输入在本环境
			// 咬不到该缺陷 —— 跳过并说明，不假红。
			var buggyUsage int64
			if err := db.QueryRow(`SELECT COALESCE(SUM(prompt_tokens),0) + COALESCE(SUM(completion_tokens),0)
				FROM usage WHERE user_id = ? AND created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
				uid, dayStartArg(now), buggyDayEndArg(now)).Scan(&buggyUsage); err != nil {
				t.Fatalf("自校准查询: %v", err)
			}
			if buggyUsage == 1_000_000 {
				t.Skipf("本组输入在本机 tzdata 下咬不到：修前右边界 %s 与修后 %s 给出同一个今日读值"+
					"（%d）—— 不假红", buggyDayEndArg(now), dayEndArgInclusive(now), buggyUsage)
			}

			s, err := userUsageSummaryAt(db, uid, now)
			if err != nil {
				t.Fatalf("userUsageSummaryAt: %v", err)
			}
			t.Logf("now=%s（本地 %s / 北京 %s）%s\n"+
				"  今日窗口 = [%s, %s)（修前右边界 = %s ⇒ 修前今日读值 %d）\n"+
				"  ⇒ today_usage=%d today_cost=%v | yesterday_usage=%d",
				now.Format(time.RFC3339), now.Format("2006-01-02 15:04 MST"), bjWall.Format("2006-01-02 15:04"),
				tc.shape, dayStartArg(now), dayEndArgInclusive(now), buggyDayEndArg(now), buggyUsage,
				s.TodayUsage, s.TodayCost, s.YesterdayUsage)

			if s.TodayUsage != 1_000_000 {
				t.Errorf("today_usage = %d, want 1000000 —— %s；今天（北京 %s）窗口 = [%s, %s)，"+
					"修前形态给的是 %d（这 3 个数应当只有第 2 个被算进来：昨天 500000 / 今天 1000000 / 明天 2000000）",
					s.TodayUsage, tc.shape, today.Format(dateFmt), dayStartArg(now), dayEndArgInclusive(now), buggyUsage)
			}
			if s.YesterdayUsage != 500_000 {
				t.Errorf("对照：yesterday_usage = %d, want 500000（昨日路径已按北京日归一，不该被本次修复带偏）",
					s.YesterdayUsage)
			}
			if s.TodayCost <= 0 {
				t.Errorf("today_cost = %v, want > 0（1000000 token × 2 元/1M）—— 窗口对了但费用没被填充？", s.TodayCost)
			}
		})
	}
}
