package serverstore

// R21F-03（审计 2026-09-26，P2）的判据：`UserUsageSummary` 的「昨日」必须在
// **北京日期值**空间里减一天，不能在 `time.Local` 的**墙钟**空间里减
// （`now.AddDate(0,0,-1)` = 修前形态）。
//
// ## 缺陷形态（判据要杀的东西）
//
// `UserDayUsageCost` 的桶是**北京日**（`dayStartArg`/`dayEndArgInclusive` 走
// `BeijingDayInstant`，固定 +8、无 DST）。而 `AddDate` 减的是 `time.Local` 的墙钟：
// 跨本地 DST 切换那一步得到的是 23h/25h 而不是 24h。设 `o1`/`o2` 为今天/昨天的本地
// UTC 偏移，则修前给出的北京日 = `floor(北京墙钟 + (o1-o2)) - 1`，与真正的北京昨日
// `floor(北京墙钟) - 1` 相差一天 **当且仅当**：
//
//	o1-o2 = +1h（本地夏令时**开始**）且北京墙钟 ≥ 23:00 ⇒ 取到**今天**的桶；
//	o1-o2 = -1h（本地夏令时**结束**）且北京墙钟 < 01:00 ⇒ 取到**前天**的桶。
//
// 影响面 = `GET /api/client/v2/auth/usage` 的 `yesterday_usage`/`yesterday_cost`
// （客户端账号卡）在那两天显示错一天的用量；静默。前提：进程 TZ 是带 DST 的时区
// （部署缺省 UTC / `Asia/Shanghai` 不触发）—— 所以判据**必须在用例内切 `time.Local`**，
// 靠外部 `TZ=` 的话 CI（UTC 容器）恒绿。
//
// ## 判据（三条，缺一条都不算闭合）
//
//	① 每个切换方向各一组输入（DST 开始 / DST 结束），`now` 落在病态窗口内；
//	② 断言的是**真库里的桶**：把用量行分别放进「正确的北京昨日」与「修前会取到的那个
//	   桶」，跑**生产入口** `userUsageSummaryAt`，只允许前者被算进 `YesterdayUsage`；
//	③ 自校准 + 区分度自证：先证明这组输入下"正确桶 ≠ 修前桶"（否则判据只是恒真断言）
//	   —— 校准不成立时**跳过该用例**并说明，不假红（本仓对 tzdata/时钟类判据的纪律）。
//
// ## 变异（必须变红，实测形态有两种 —— 都来自 `dayEndArgInclusive` 的同一墙钟口径）
//
// `userUsageSummaryAt` 里的 `BeijingDay(now).AddDate(0,0,-1)` 退回 `now.AddDate(0,0,-1)`
// 之后，`UserDayUsageCost` 拿到的**不是北京日期值**（它落在北京日界之后 30 分钟），
// 于是 `BeijingDay(d)` 与 `BeijingDay(d.AddDate(0,0,1))` 的关系被破坏：
//
//	DST 开始（本例 A）⇒ 两者**相等** ⇒ 半开区间塌成空 ⇒ `yesterday_usage = 0`
//	  （客户端看到"昨天一点没用"，而真实昨日有量）；
//	DST 结束（本例 B）⇒ 相差 **2 天** ⇒ 窗口展成 48h ⇒ 昨日量 = 昨日 + 今日（翻倍）。
//
// 两条都 ≠ 111 ⇒ 用例红（实跑对照见 temp/r21/fix-8/REPORT.md）。

import (
	"testing"
	"time"
)

// yesterdayTZCase 是一组"跨本地 DST 切换"的输入。
type yesterdayTZCase struct {
	name string
	// now 的 Location 必须是 time.Local（生产里是 time.Now()）—— 缺陷本体就是
	// `AddDate` 在**接收者的 Location** 的墙钟空间里做算术，用 UTC 构造的入参
	// 根本触发不到它（本轮实测：第一版夹具用 time.UTC 构造 ⇒ 两个桶恒相同 ⇒ 判据变恒真）。
	now time.Time
}

func TestUserUsageSummaryYesterdayIsBeijingDayAcrossDSTSwitch(t *testing.T) {
	loc := mustLoad(t, "America/Santiago")
	withLocal(t, loc)

	cases := []yesterdayTZCase{
		{
			// 本地 2026-09-06 00:00 → 01:00（夏令时开始，偏移 -04 → -03）；
			// now = 本地 09-06 12:30（-03）= 北京 09-06 23:30 ⇒ 病态窗口（北京墙钟 ≥ 23:00）。
			name: "DST 开始（墙钟减一天 = 23h）",
			now:  time.Date(2026, 9, 6, 12, 30, 0, 0, loc),
		},
		{
			// 本地 2026-04-04 24:00 回拨到 23:00（夏令时结束，偏移 -03 → -04）；
			// now = 本地 04-05 12:30（-04）= 北京 04-06 00:30 ⇒ 病态窗口（北京墙钟 < 01:00）。
			name: "DST 结束（墙钟减一天 = 25h）",
			now:  time.Date(2026, 4, 5, 12, 30, 0, 0, loc),
		},
	}

	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 期望的北京昨日：**独立**推导（固定 +8 的墙钟 → 取字面日历日 → 在 UTC
			// 日期值上做日历算术），与实现里的 `BeijingDay(now).AddDate(0,0,-1)` 不是
			// 同一条路径（后者是 UTC+偏移 再取分量）。
			bjWall := tc.now.In(time.FixedZone("BJT", 8*3600))
			wantYesterday := time.Date(bjWall.Year(), bjWall.Month(), bjWall.Day(), 0, 0, 0, 0, time.UTC).
				AddDate(0, 0, -1)
			// 修前实现（墙钟减一天）会取到的桶 —— 判据要证明它与正确的那个**不同**。
			wallShift := tc.now.Sub(tc.now.AddDate(0, 0, -1))
			buggyBucket := BeijingDay(tc.now.AddDate(0, 0, -1))
			if wallShift == 24*time.Hour || wantYesterday.Equal(buggyBucket) {
				t.Skipf("本机 tzdata 下这组输入没有跨过切换（墙钟位移 %v，两桶均为 %s）"+
					"—— 判据在本环境咬不到，不假红", wallShift, wantYesterday.Format(dateFmt))
			}
			t.Logf("%s：now=%s（本地 %s / 北京 %s）墙钟位移=%v 正确北京昨日=%s 修前桶=%s",
				tc.name, tc.now.Format(time.RFC3339), tc.now.Format("2006-01-02 15:04 MST"),
				bjWall.Format("2006-01-02 15:04"), wallShift,
				wantYesterday.Format(dateFmt), buggyBucket.Format(dateFmt))

			uid := mustUserID(t, db)
			// 每个用例一个用户：月度字段是"当前真实月"，跨用例共用户会互相污染。
			put := func(day time.Time, tokens int64) {
				t.Helper()
				id, err := RecordUsageKind(db, uid, "priced-model", tokens, 0, "chat")
				if err != nil {
					t.Fatalf("播用量行: %v", err)
				}
				setCreatedAtAt(t, db, id, BeijingDayAt(day, 10))
			}
			put(wantYesterday, 111)                   // 正确的北京昨日
			put(buggyBucket, 222)                     // 修前会误取的那个桶（或它展开后的邻日）
			put(wantYesterday.AddDate(0, 0, -2), 444) // 再往前两天（防止"整体左移"蒙对）

			s, err := userUsageSummaryAt(db, uid, tc.now)
			if err != nil {
				t.Fatalf("userUsageSummaryAt: %v", err)
			}
			t.Logf("⇒ yesterday_usage=%d（want 111）", s.YesterdayUsage)
			if s.YesterdayUsage != 111 {
				t.Fatalf("昨日用量 = %d, want 111（正确的北京昨日 %s）；222 = 修前的墙钟位移取到的桶 %s，"+
					"444 = 前天 —— 「昨日」必须先归一到北京日再减一天（R21F-03）",
					s.YesterdayUsage, wantYesterday.Format(dateFmt), buggyBucket.Format(dateFmt))
			}
		})
	}
}

// TestUserUsageSummaryYesterdayIsPlainPreviousBeijingDay 是同一口径的"平凡日"回归：
// 不跨切换时两种实现的结论必须一致（防止把修复写成"永远差一天"的另一种错）。
func TestUserUsageSummaryYesterdayIsPlainPreviousBeijingDay(t *testing.T) {
	loc := mustLoad(t, "America/Santiago")
	withLocal(t, loc)

	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)
	uid := mustUserID(t, db)

	// 本地 2026-06-15 12:00 -04 = 16:00Z = 北京 06-16 00:00 ⇒ 北京昨日 = 06-15。
	now := time.Date(2026, 6, 15, 16, 0, 0, 0, time.UTC)
	want := BeijingDay(now).AddDate(0, 0, -1)
	if got := want.Format(dateFmt); got != "2026-06-15" {
		t.Fatalf("夹具自校准失败：北京昨日 = %s, want 2026-06-15", got)
	}
	id, err := RecordUsageKind(db, uid, "priced-model", 111, 0, "chat")
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAtAt(t, db, id, BeijingDayAt(want, 10))

	s, err := userUsageSummaryAt(db, uid, now)
	if err != nil {
		t.Fatal(err)
	}
	if s.YesterdayUsage != 111 {
		t.Fatalf("平凡日的昨日用量 = %d, want 111（北京昨日 %s）", s.YesterdayUsage, want.Format(dateFmt))
	}
	// 契约面：字段集不许因本次修复变动（跨端对拍的字段清单在 serverauth 侧）。
	if s.YesterdayCost == 0 {
		t.Fatalf("昨日费用为 0（111 token × 2 元/1M 应 > 0）—— 取值口径改了但字段没被填充？")
	}
}
