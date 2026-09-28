package serverstore

import (
	"testing"
	"time"
)

// 本地日边界（`local_day.go`）的判据。
//
// 三条不变量（每条都能单独被变异点红）：
//
//	① **边界瞬时的键就是桶键**：`LocalDayString(LocalDay(t)) == LocalDayString(t)` ——
//	   DST 缺口日（本地零点不存在）归一到前一天 23:00 时这条当场红；
//	② **阶梯无缝无重叠**：`NextLocalDay` 严格递增，且 `[LocalDay(D), NextLocalDay(D))`
//	   恰好是"本地日期 == D"的全部瞬时 ⇒ 任何一行明细都属于且只属于一个日桶；
//	③ **日历算术不漂**：`AddLocalDays(now, -90)` 落在那一天的**日边界**上，
//	   不因缺口日的墙钟归一化退回前一天。
//
// 为什么这些是数据完整性的判据（而不是"函数自测"）：`AggregateWasmAppOpens` 是
// **按天全量覆盖**（`ON CONFLICT DO UPDATE SET pv = EXCLUDED.pv`），日键撞车 =
// 后写覆盖前写 = 那一天的 PV/UV 永久算少；而 `PurgeWasmAppOpens` 用同一个阶梯当
// cutoff ⇒ 明细同轮被硬删，少掉的计数在明细与日汇总里**都不存在**（R20A-S-01）。
//
// ⚠️ 这些用例会**临时改写进程级的 `time.Local`**（`LocalDay` 的口径就是部署 TZ）。
// 同包测试必须保持**不并行**（当前包内零处 `t.Parallel()`）——新增并行用例前先读这段。

// withLocal 把进程时区切到 loc 并在用例结束时还原。
func withLocal(t *testing.T, loc *time.Location) {
	t.Helper()
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })
}

// mustLoad 取一个时区（tzdata 缺失时跳过——判据在无数据的环境里没有意义）。
func mustLoad(t *testing.T, name string) *time.Location {
	t.Helper()
	loc, err := time.LoadLocation(name)
	if err != nil {
		t.Skipf("本机没有时区数据 %s: %v", name, err)
	}
	return loc
}

// TestLocalDayNormalDay 普通日：日边界就是本地零点，键与瞬时一致。
func TestLocalDayNormalDay(t *testing.T) {
	for _, name := range []string{"UTC", "Asia/Shanghai", "Asia/Kathmandu"} {
		loc := mustLoad(t, name)
		withLocal(t, loc)
		for _, wall := range []string{"2026-09-06 00:00:00", "2026-09-06 12:34:56", "2026-09-06 23:59:59"} {
			at, err := time.ParseInLocation("2006-01-02 15:04:05", wall, loc)
			if err != nil {
				t.Fatalf("构造 %s: %v", wall, err)
			}
			day := LocalDay(at)
			if got := LocalDayString(day); got != "2026-09-06" {
				t.Fatalf("%s: LocalDay(%s) 的日键 = %s, want 2026-09-06", name, wall, got)
			}
			if day.After(at) {
				t.Fatalf("%s: LocalDay(%s) 晚于入参（边界必须 <= 入参）", name, wall)
			}
			if h, m, s := day.In(loc).Clock(); h != 0 || m != 0 || s != 0 {
				t.Fatalf("%s: LocalDay(%s) 不是本地零点而是 %02d:%02d:%02d", name, wall, h, m, s)
			}
		}
	}
}

// TestLocalDayOnDSTGapIsRealDayStart 是 R20A-S-01 的本体判据。
//
// 现场：`America/Santiago` 2026-09-06 的本地 00:00 **不存在**（00:00 -04:00 直接跳到
// 01:00 -03:00）。朴素写法 `time.Date(y,m,d,0,0,0,0,time.Local)` 会被 Go 归一化到
// **2026-09-05 23:00**（其本地日期是 09-05）⇒ 日阶梯上 09-05 与 09-06 两个桶撞键。
// 正确值 = 该日历日的第一个瞬时 = 时钟跳变那一刻 = `2026-09-06T04:00:00Z`。
func TestLocalDayOnDSTGapIsRealDayStart(t *testing.T) {
	loc := mustLoad(t, "America/Santiago")
	withLocal(t, loc)

	// 自校准：本机 tzdata 里这一天**真的**没有本地零点吗？没有才谈得上"缺口日"，
	// 否则这条判据在本环境咬不到（换 tzdata 后不许假红）。
	naive := time.Date(2026, 9, 6, 0, 0, 0, 0, loc)
	if LocalDayString(naive) == "2026-09-06" {
		t.Skipf("本机 tzdata 的 Santiago 2026-09-06 没有零点缺口（朴素写法已是 00:00），跳过")
	}

	at := time.Date(2026, 9, 6, 12, 0, 0, 0, loc)
	day := LocalDay(at)
	want := time.Date(2026, 9, 6, 4, 0, 0, 0, time.UTC) // 本地 01:00 -03:00
	if !day.Equal(want) {
		t.Fatalf("LocalDay(%s) = %s (UTC %s), want %s —— 缺口日的日边界必须是该日的第一个瞬时（时钟跳变那一刻）",
			at.Format(time.RFC3339), day.Format(time.RFC3339), day.UTC().Format(time.RFC3339), want.Format(time.RFC3339))
	}
	if got := LocalDayString(day); got != "2026-09-06" {
		t.Fatalf("缺口日的边界瞬时落回 %s —— 桶键与日历日不一致（后写覆盖前写的前置条件）", got)
	}
	if day.After(at) {
		t.Fatalf("LocalDay(%s) 晚于入参", at.Format(time.RFC3339))
	}
	// 缺口日只有 23 小时：结束边界 - 起始边界 = 23h（日历算术的直接体现）。
	if h := NextLocalDay(day).Sub(day); h != 23*time.Hour {
		t.Fatalf("缺口日长度 = %v, want 23h", h)
	}
}

// TestLocalDayLadderPartitionsEveryInstant 是"阶梯"判据：边界严格递增、键唯一，
// 且**任何一行明细都属于且只属于一个桶，桶键 == 它自己的本地日期**。
//
// 这条与实现口径无关（只依赖"本地日期"这个标签函数），因此它在 DST 时区既能抓住
// R20A-S-01（缺口日撞键），也不会像"按行标签整日删除"那样在 23/25 小时的日子上假红。
func TestLocalDayLadderPartitionsEveryInstant(t *testing.T) {
	for _, name := range []string{"UTC", "Asia/Shanghai", "Asia/Kathmandu", "America/Santiago", "Pacific/Apia"} {
		loc := mustLoad(t, name)
		withLocal(t, loc)
		// 扫过 2026 年的两个智利 DST 边界（04-05 秋令重叠、09-06 春令缺口）与
		// 一个跨日界线的历史日期（Apia 2011-12-30 整日不存在）。
		for _, window := range [][2]string{
			{"2026-04-01 12:00:00", "2026-04-10 12:00:00"},
			{"2026-09-01 12:00:00", "2026-09-12 12:00:00"},
			{"2011-12-27 12:00:00", "2012-01-03 12:00:00"},
		} {
			start, _ := time.ParseInLocation("2006-01-02 15:04:05", window[0], loc)
			end, _ := time.ParseInLocation("2006-01-02 15:04:05", window[1], loc)
			bounds := make([]time.Time, 0, 16)
			for day := LocalDay(start); !day.After(end); day = NextLocalDay(day) {
				bounds = append(bounds, day)
				if len(bounds) > 64 {
					t.Fatalf("%s: 日阶梯不收敛（>64 桶）", name)
				}
			}
			if len(bounds) < 2 {
				t.Fatalf("%s: 日阶梯只有 %d 个桶", name, len(bounds))
			}
			seen := map[string]bool{}
			for i, b := range bounds {
				if i > 0 && !b.After(bounds[i-1]) {
					t.Fatalf("%s: 日边界非严格递增（%s 之后是 %s）",
						name, bounds[i-1].Format(time.RFC3339), b.Format(time.RFC3339))
				}
				key := LocalDayString(b)
				if seen[key] {
					t.Fatalf("%s: 日键 %s 在阶梯上出现两次 —— 相邻两桶撞键（后写覆盖前写）", name, key)
				}
				seen[key] = true
				if b.In(loc).Format("2006-01-02") != key {
					t.Fatalf("%s: 桶边界 %s 的本地日期是 %s，与桶键 %s 不一致",
						name, b.Format(time.RFC3339), b.In(loc).Format("2006-01-02"), key)
				}
			}
			// 逐小时（含半小时时区的 :30 偏移）扫过整个窗口：每一行都必须落在
			// "键等于它自己本地日期"的那个桶里。
			last := NextLocalDay(bounds[len(bounds)-1])
			for cur := bounds[0]; cur.Before(last); cur = cur.Add(90 * time.Minute) {
				key := LocalDayString(cur)
				idx := -1
				for i := len(bounds) - 1; i >= 0; i-- {
					if !cur.Before(bounds[i]) {
						idx = i
						break
					}
				}
				if idx < 0 {
					t.Fatalf("%s: 瞬时 %s 不在任何日桶里（阶梯漏了一段）", name, cur.Format(time.RFC3339))
				}
				if cur.Before(last) && !cur.Before(NextLocalDay(bounds[idx])) {
					t.Fatalf("%s: 瞬时 %s 落在桶 %s 之外", name, cur.Format(time.RFC3339), LocalDayString(bounds[idx]))
				}
				if got := LocalDayString(bounds[idx]); got != key {
					t.Fatalf("%s: 瞬时 %s（本地日 %s）被算进日桶 %s —— 明细会被写进错误的 day 键",
						name, cur.Format(time.RFC3339), key, got)
				}
			}
		}
	}
}

// TestNextLocalDaySkipsNonexistentLocalDate 整日不存在（Apia 2011-12-30 因跨日界线
// 被跳过）时，阶梯必须直接跨过去，而不是卡死或回退。
//
// 为什么值得一条判据：缺口日的"变体"就是"整日没有瞬时" —— 归一化写错时最容易出现的
// 形态是 `NextLocalDay` 返回自己（死循环）或返回更早的瞬时。
func TestNextLocalDaySkipsNonexistentLocalDate(t *testing.T) {
	loc := mustLoad(t, "Pacific/Apia")
	withLocal(t, loc)
	day := LocalDay(time.Date(2011, 12, 29, 12, 0, 0, 0, loc))
	if got := LocalDayString(day); got != "2011-12-29" {
		t.Skipf("本机 tzdata 的 Apia 没有 2011-12-30 整日跳过（判据不可咬）：%s", got)
	}
	next := NextLocalDay(day)
	if !next.After(day) {
		t.Fatalf("NextLocalDay 没有前进（%s → %s）", day.Format(time.RFC3339), next.Format(time.RFC3339))
	}
	if got := LocalDayString(next); got != "2011-12-31" {
		t.Fatalf("跨过不存在的那一天之后应落在 2011-12-31，实得 %s", got)
	}
	if d := next.Sub(day); d != 24*time.Hour {
		t.Fatalf("两个真实日之间的跨度 = %v, want 24h（被跳过的那一天不占时间）", d)
	}
}

// TestAddLocalDaysKeepsCalendarDays 保留期边界那类"第 N 个日历日"的算术。
//
// R20A-S-01 的触发链第一环就是它：`now.AddDate(0,0,-90)` 在"缺口墙钟"上会被
// 归一化，于是保留期边界日漂到前一天（"整日一起删"的日界因此错位）。
func TestAddLocalDaysKeepsCalendarDays(t *testing.T) {
	loc := mustLoad(t, "America/Santiago")
	withLocal(t, loc)
	// now 取缺口日的本地零点这一族形态（墙钟落在不存在的时刻上正是现场）。
	now := time.Date(2026, 12, 5, 0, 0, 0, 0, loc)
	got := AddLocalDays(now, -90)
	wantDay := "2026-09-06"
	if key := LocalDayString(got); key != wantDay {
		t.Fatalf("AddLocalDays(now,-90) 落在 %s, want %s（缺口日必须落在它自己的日边界上）", key, wantDay)
	}
	if h, m, s := got.In(loc).Clock(); h != 1 || m != 0 || s != 0 {
		t.Fatalf("缺口日的日边界墙钟 = %02d:%02d:%02d, want 01:00（00:00 不存在）", h, m, s)
	}
	if !got.Before(now) {
		t.Fatalf("AddLocalDays 没有回到过去")
	}
	// 反向：从缺口日往前/往后各一天都是真实存在的日边界（严格递增）。
	prev, next := AddLocalDays(got, -1), AddLocalDays(got, 1)
	if !prev.Before(got) || !got.Before(next) {
		t.Fatalf("AddLocalDays 序列非严格递增：%s / %s / %s",
			LocalDayString(prev), LocalDayString(got), LocalDayString(next))
	}
	if LocalDayString(prev) != "2026-09-05" || LocalDayString(next) != "2026-09-07" {
		t.Fatalf("相邻日键 = %s / %s, want 2026-09-05 / 2026-09-07", LocalDayString(prev), LocalDayString(next))
	}
	// 普通时区下退化为朴素语义（不得引入偏移）。
	withLocal(t, mustLoad(t, "Asia/Shanghai"))
	sh := time.Date(2026, 12, 5, 15, 30, 0, 0, time.Local)
	if key := LocalDayString(AddLocalDays(sh, -90)); key != "2026-09-06" {
		t.Fatalf("上海时区 AddLocalDays(-90) = %s, want 2026-09-06", key)
	}
	if h, m, _ := AddLocalDays(sh, -90).In(time.Local).Clock(); h != 0 || m != 0 {
		t.Fatalf("上海时区的日边界必须是本地零点")
	}
}
