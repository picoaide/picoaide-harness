package serverstore

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// P1-1（2026-09-20 本机全功能实测）：`trend[].uv` 曾经是
// `SELECT day, SUM(pv), SUM(uv) FROM wasm_app_opens_daily GROUP BY day` —— 把日汇总
// 里**各应用（且各天各一份）的 uv 相加**。现场：同一天 `today.uv=2` / `totals.uv=2`，
// 而 `trend[0].uv=3`（同一块看板上两个 UV 自相矛盾）。契约 §5.1c A 明令"UV 一律真实
// 去重 … 禁止把各应用的 uv 相加"——趋势点的"当天人数"同样适用。
//
// 本文件的两条用例分别钉住：
//  ① 跨应用去重：同一人当天开两个应用 ⇒ `trend[].uv` == `totals.uv`（同日窗口），
//     且**严格小于**各应用 uv 之和（前者 2、后者 3 —— 旧实现的取值）；
//  ② 按当地日界分桶：跨两天的明细各自落进自己的 trend 点（日边界由 Go 的 `LocalDay`
//     给出，含当天首尾秒的边界行），且窗口级 `totals.uv` 仍跨天去重。
//
// 变异验证（两条都要做）：把 ③ 的 UV 聚合改回 `SUM(uv) … GROUP BY day` ⇒ ① 红；
// 把 `dayStarts` 换成 UTC 日零点（或用 `AT TIME ZONE 'UTC'`）⇒ ② 在非 UTC 时区红。
//
// 2026-09-20 追加 **AUD-1** 一组（文件末尾）：趋势的 PV 与 UV 必须**同一天同源**
// （明细覆盖到的天 PV/UV 都取明细；只有明细已不在的天 PV 才回落日汇总），把
// `uv <= pv`（每个点）与"today 有数 ⇒ 曲线必有今天且逐值一致"写成不变量判据。

// openSummarySeedOpen 写一行明细（走**真实写入路径** `RecordWasmAppOpen`，
// 不在用例里手写 INSERT —— 写入口径（列集/时区/规范化）必须与生产一致）。
func openSummarySeedOpen(t *testing.T, db *sql.DB, appID string, userID int64, at time.Time) {
	t.Helper()
	if err := RecordWasmAppOpen(context.Background(), db, WasmAppOpen{
		AppID: appID, UserID: userID, At: at,
	}); err != nil {
		t.Fatalf("写明细 %s/user=%d: %v", appID, userID, err)
	}
}

// openSummaryAggregate 把明细汇总进日汇总（真实写入路径；趋势的 PV 读它）。
func openSummaryAggregate(t *testing.T, db *sql.DB, from, to time.Time) {
	t.Helper()
	if _, err := AggregateWasmAppOpens(context.Background(), db, from, to); err != nil {
		t.Fatalf("汇总日数据: %v", err)
	}
}

// trendUVOf 取 trend 里某一天的 uv（不存在则 ok=false）。
func trendUVOf(t *testing.T, sum *WasmAppOpensSummary, day string) (int64, bool) {
	t.Helper()
	p, ok := trendPointOf(t, sum, day)
	return p.UV, ok
}

// trendPointOf 取 trend 里某一天的点（不存在则 ok=false）。
func trendPointOf(t *testing.T, sum *WasmAppOpensSummary, day string) (WasmOpenTrendPoint, bool) {
	t.Helper()
	for _, p := range sum.Trend {
		if p.Day == day {
			return p, true
		}
	}
	return WasmOpenTrendPoint{}, false
}

// assertTrendInvariants 把 AUD-1 的两条不变量写成对**整条曲线**的断言（不只是被
// 单独检查的那一天）：
//
//	① 每个点恒有 `uv <= pv`（去重人数不可能大于打开次数）；
//	② `today` 有数时，曲线上必须有今天这一点，且 pv/uv 与 `today{}` **逐值一致**
//	   （同一页两个数字不得互相矛盾）。
func assertTrendInvariants(t *testing.T, sum *WasmAppOpensSummary) {
	t.Helper()
	for _, p := range sum.Trend {
		if p.UV > p.PV {
			t.Errorf("不变量破裂：trend[%s] uv=%d > pv=%d（PV 与 UV 必须同一天同源）",
				p.Day, p.UV, p.PV)
		}
	}
	if sum.Today.PV == 0 && sum.Today.UV == 0 {
		return
	}
	p, ok := trendPointOf(t, sum, sum.Today.Day)
	if !ok {
		t.Errorf("今天有数（today={pv:%d uv:%d}）而曲线没有今天这一点：trend=%+v",
			sum.Today.PV, sum.Today.UV, sum.Trend)
		return
	}
	if p.PV != sum.Today.PV || p.UV != sum.Today.UV {
		t.Errorf("trend[%s]={pv:%d uv:%d} 与 today={pv:%d uv:%d} 不一致（同一天必须同源）",
			p.Day, p.PV, p.UV, sum.Today.PV, sum.Today.UV)
	}
}

// TestSummarizeWasmAppOpensTrendUVIsCrossAppDedup 是 P1-1 的主判据（同日窗口）。
func TestSummarizeWasmAppOpensTrendUVIsCrossAppDedup(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()

	// 同一人（user 1）今天开了**两个**应用；另一个人（user 2）今天开了一个。
	openSummarySeedOpen(t, db, "notes", 1, now)
	openSummarySeedOpen(t, db, "board", 1, now)
	openSummarySeedOpen(t, db, "notes", 2, now)
	openSummaryAggregate(t, db, now, now)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, now, now, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}

	// 前置：两个应用各 1 个窗口 UV（合计 3 —— 这正是旧实现写进 trend 的数字）。
	var sumAppsUV int64
	for _, a := range sum.Apps {
		sumAppsUV += a.WindowUV
	}
	if len(sum.Apps) != 2 || sumAppsUV != 3 {
		t.Fatalf("前置：apps 应为 2 行、窗口 UV 合计 3，得到 %+v", sum.Apps)
	}
	if sum.Totals.UV != 2 || sum.Today.UV != 2 {
		t.Fatalf("前置：totals/today uv 应为 2（真实去重），得到 totals=%+v today=%+v", sum.Totals, sum.Today)
	}

	if len(sum.Trend) != 1 {
		t.Fatalf("同日窗口的趋势应恰有 1 个点，得到 %+v", sum.Trend)
	}
	// ① 核心断言：trend[].uv 必须**当天真实去重**，而不是各应用之和。
	if sum.Trend[0].UV != 2 {
		t.Fatalf("trend[0].uv = %d, want 2 —— 同一人开两个应用只算 1 个人；"+
			"把日汇总各应用 uv 相加会得到 3（§5.1c A 的 UV 禁令，P1-1）", sum.Trend[0].UV)
	}
	if sum.Trend[0].UV != sum.Totals.UV {
		t.Fatalf("同一天窗口下 trend[0].uv(%d) 必须等于 totals.uv(%d)：同一块看板两个 UV 不得自相矛盾",
			sum.Trend[0].UV, sum.Totals.UV)
	}
	if sum.Trend[0].UV >= sumAppsUV {
		t.Fatalf("trend[0].uv(%d) 必须严格小于各应用 uv 之和(%d)：相等即说明没有跨应用去重",
			sum.Trend[0].UV, sumAppsUV)
	}
	// PV 与 UV 同源（本次窗口内有明细 ⇒ 都取明细），3 次打开 2 个人。
	if sum.Trend[0].PV != 3 || sum.Trend[0].Day != LocalDayString(now) {
		t.Fatalf("trend[0] = %+v, want {day=%s pv=3}", sum.Trend[0], LocalDayString(now))
	}
}

// TestSummarizeWasmAppOpensTrendUVPerLocalDay 钉住"按当地日界分桶 + 窗口仍跨天去重"。
//
// 为什么必须有这一条：只断言同日窗口的话，"UV 读明细但按 UTC 分日"（或在明细上把
// 整段窗口当成一天）也能让 ① 绿。这里用**当地日的首秒与末秒**各放一行，让分桶错误
// 变成可见的错位。
func TestSummarizeWasmAppOpensTrendUVPerLocalDay(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()
	today := LocalDay(now)
	yesterday := today.AddDate(0, 0, -1)

	// 昨天：user 1 在当天首秒打开一次（边界行，必须落进"昨天"）。
	openSummarySeedOpen(t, db, "notes", 1, yesterday.Add(time.Second))
	// 今天：user 1（跨天重复访问，窗口级仍只算 1 个人）+ user 2；
	// 其中 user 2 的行放在当地日**末秒**（另一个边界行）。
	openSummarySeedOpen(t, db, "notes", 1, today.Add(time.Hour))
	openSummarySeedOpen(t, db, "notes", 2, today.AddDate(0, 0, 1).Add(-time.Second))
	openSummaryAggregate(t, db, yesterday, today)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, yesterday, today, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	if len(sum.Trend) != 2 {
		t.Fatalf("趋势应有两天，得到 %+v", sum.Trend)
	}
	if sum.Trend[0].Day != LocalDayString(yesterday) || sum.Trend[1].Day != LocalDayString(today) {
		t.Fatalf("趋势日期顺序/取值不对: %+v", sum.Trend)
	}
	if uv, ok := trendUVOf(t, sum, LocalDayString(yesterday)); !ok || uv != 1 {
		t.Fatalf("昨天 uv = %d(ok=%v), want 1 —— 当地日首秒的行必须落进昨天", uv, ok)
	}
	if uv, ok := trendUVOf(t, sum, LocalDayString(today)); !ok || uv != 2 {
		t.Fatalf("今天 uv = %d(ok=%v), want 2 —— 当地日末秒的行必须落进今天", uv, ok)
	}
	// 每一天的 uv 都是"当天人数"（不是窗口人数）：昨天 1、今天 2；窗口去重是 2。
	if sum.Totals.UV != 2 {
		t.Fatalf("窗口 totals.uv = %d, want 2（user 1 跨天重复访问只算 1 个人）", sum.Totals.UV)
	}
	// PV 是当天的打开次数（两天各有明细 ⇒ 取明细的 `count(*)`，与 UV 同源）。
	if sum.Trend[0].PV != 1 || sum.Trend[1].PV != 2 {
		t.Fatalf("趋势 PV = %d/%d, want 1/2（每次打开 +1）", sum.Trend[0].PV, sum.Trend[1].PV)
	}
}

// TestSummarizeWasmAppOpensTrendUVAcrossDSTDay 钉住"日边界是 Go 的 `LocalDay`
// （真实当地零点），不是固定 24 小时算术"：夏令时切换日的当地日长是 23 小时。
//
// 为什么必须有这一条：用 `epoch / 86400` 或"窗口起点 + N×24h"来分桶的实现在没有
// DST 的时区（含 CI 的 UTC）上**永远绿**，而在客户真实的 DST 时区上会把切换日之后
// 的每一行错位一天。本用例只在**本机时区有 DST** 时有牙齿，无 DST 时 skip ——
// 宁可显式 skip，也不要一条"看起来在测 DST 其实什么都没测"的假绿。
//
// 实跑姿势（判据在本机成立）：`TZ=America/New_York go test ./internal/serverstore/ -run TestSummarizeWasmAppOpensTrendUVAcrossDSTDay`
func TestSummarizeWasmAppOpensTrendUVAcrossDSTDay(t *testing.T) {
	if _, jan := time.Date(2026, 1, 15, 12, 0, 0, 0, time.Local).Zone(); true {
		_, jul := time.Date(2026, 7, 15, 12, 0, 0, 0, time.Local).Zone()
		if jan == jul {
			t.Skip("本机时区无夏令时（TZ 不是 DST 时区）⇒ 本用例无牙齿；" +
				"实跑姿势：TZ=America/New_York go test ./internal/serverstore/ -run TestSummarizeWasmAppOpensTrendUVAcrossDSTDay")
		}
	}
	// 2026-03-08 是美国夏令时开始日：当地这一天只有 23 小时。
	dstDay := time.Date(2026, 3, 8, 0, 0, 0, 0, time.Local)
	nextDay := dstDay.AddDate(0, 0, 1)
	if got := nextDay.Sub(dstDay); got != 23*time.Hour {
		t.Skipf("本机时区的 2026-03-08 不是 23 小时（实际 %v）⇒ 本用例无牙齿", got)
	}

	db, cleanup := NewTestDB(t)
	defer cleanup()
	// 首日的**末秒**与次日的**首秒**各一行：任何"24h 算术"的分桶都会把前者错判成次日。
	openSummarySeedOpen(t, db, "notes", 1, nextDay.Add(-time.Second))
	openSummarySeedOpen(t, db, "notes", 2, nextDay.Add(time.Second))
	openSummaryAggregate(t, db, dstDay, nextDay)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, dstDay, nextDay, nextDay)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	if len(sum.Trend) != 2 {
		t.Fatalf("趋势应有两天，得到 %+v", sum.Trend)
	}
	if uv, ok := trendUVOf(t, sum, LocalDayString(dstDay)); !ok || uv != 1 {
		t.Fatalf("DST 切换日 uv = %d(ok=%v), want 1 —— 当地日末秒的行必须落进当天（23 小时日）", uv, ok)
	}
	if uv, ok := trendUVOf(t, sum, LocalDayString(nextDay)); !ok || uv != 1 {
		t.Fatalf("DST 次日 uv = %d(ok=%v), want 1 —— 次日首秒的行必须落进次日", uv, ok)
	}
}

// TestSummarizeWasmAppOpensTrendDropsUVWhenDetailIsGone 钉住"取不到明细就如实给 0，
// 不编数据"：日汇总有 PV 而明细已过期（这里手工造一个没有明细的历史日行）时，
// 趋势点仍然出现（曲线不断档），UV 为 0 而不是沿用 PV 或上一个值。
func TestSummarizeWasmAppOpensTrendDropsUVWhenDetailIsGone(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()
	day := LocalDay(now).AddDate(0, 0, -3)

	// 只写日汇总行（模拟"明细已被保留期清理、曲线靠日汇总续着"）。
	if _, err := db.Exec(`INSERT INTO wasm_app_opens_daily (app_id, day, dept_id, pv, uv)
		VALUES ('notes', ?::date, 0, 7, 4)`, LocalDayString(day)); err != nil {
		t.Fatalf("造日汇总行: %v", err)
	}
	sum, err := SummarizeWasmAppOpens(context.Background(), db, day, now, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	uv, ok := trendUVOf(t, sum, LocalDayString(day))
	if !ok {
		t.Fatalf("明细缺失的日期仍应在趋势里（PV 来自日汇总，不断档）: %+v", sum.Trend)
	}
	if uv != 0 {
		t.Fatalf("该日 uv = %d, want 0（明细不在 ⇒ 当天人数不可知；不得把日汇总的 4 当成去重人数）", uv)
	}
	for _, p := range sum.Trend {
		if p.Day == LocalDayString(day) && p.PV != 7 {
			t.Fatalf("该日 PV = %d, want 7（PV 仍读日汇总）", p.PV)
		}
	}
}

// ---------------------------------------------------------------------------
// AUD-1（2026-09-20 独立对抗审计）：同一天必须**同源**
// ---------------------------------------------------------------------------

// TestSummarizeWasmAppOpensTrendSameSourcePerDay 是 AUD-1 的主判据。
//
// 缺陷现场（P1-1 修复自身引入的回归）：`trend[].pv` 读**日汇总**（每 5 分钟 tick 一次，
// 今天那一行是上一轮 tick 的快照）而 `trend[].uv` 读**实时明细** ⇒ tick 之后发生的
// 打开只进 UV 不进 PV，同一份响应里出现 `uv > pv`（去重人数大于打开次数，语义上不
// 可能）。活体实测 `trend=[{day:2026-09-20 pv:26 uv:27}]` 而同页
// `today={pv:52 uv:27}`。
//
// 判据：同一次调用里
//
//	① `trend[今天]` 与 `today{}` **逐值一致**（同一天同源，PV 不再落后一个 tick）；
//	② 取值就是明细的真值（2 次打开、2 个人）；
//	③ 整条曲线每个点 `uv <= pv`（见 assertTrendInvariants）。
//
// 变异验证（任选其一，本用例必红）：
//   - 把 `trend[].pv` 改回读日汇总（`SUM(pv) … GROUP BY day`）⇒ ① 得到 pv=1 uv=2；
//   - 把趋势的日期集合改回"只以日汇总为准"⇒ 前置的"曲线有今天"失败。
func TestSummarizeWasmAppOpensTrendSameSourcePerDay(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()

	// tick #1：此刻只有 user 1 打开过一次 ⇒ 日汇总里的今天是 pv=1 uv=1。
	openSummarySeedOpen(t, db, "notes", 1, now.Add(-90*time.Second))
	openSummaryAggregate(t, db, now, now)

	// tick 之后 user 2 又打开了：明细已写，日汇总要等下一轮 tick（缺陷窗口）。
	openSummarySeedOpen(t, db, "notes", 2, now)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, now, now, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	today := LocalDayString(now)

	// ① 曲线必须有今天（旧实现里日期集合以日汇总为准，这条在"没 tick 过"时会漏今天）。
	pt, ok := trendPointOf(t, sum, today)
	if !ok {
		t.Fatalf("曲线漏掉今天：today={pv:%d uv:%d} 而 trend=%+v", sum.Today.PV, sum.Today.UV, sum.Trend)
	}
	// ② 与 today 逐值一致（旧实现：pv 取日汇总的陈旧快照 1、uv 取明细 2 ⇒ 自相矛盾）。
	if pt.PV != sum.Today.PV || pt.UV != sum.Today.UV {
		t.Fatalf("trend[%s]={pv:%d uv:%d} 与 today={pv:%d uv:%d} 不一致 —— "+
			"PV 读日汇总（5 分钟 tick 的陈旧快照）+ UV 读实时明细，同一天不同源（AUD-1）",
			today, pt.PV, pt.UV, sum.Today.PV, sum.Today.UV)
	}
	if pt.PV != 2 || pt.UV != 2 {
		t.Fatalf("trend[%s]={pv:%d uv:%d}, want {2 2}（明细的真值：2 次打开、2 个人）",
			today, pt.PV, pt.UV)
	}
	// ③ 不变量：整条曲线 uv <= pv，且 today 有数时曲线必须有今天且逐值一致。
	assertTrendInvariants(t, sum)
}

// TestSummarizeWasmAppOpensTrendIncludesTodayBeforeFirstTick 钉住 AUD-1 的另一面：
// **首个 tick 之前**，`today` 已经有数（读明细，"本次调用计数在内"），而曲线曾经
// 完全漏掉今天（日期集合只来自日汇总）。
//
// 变异验证：把趋势的日期集合改回"只以日汇总为准"⇒ 本用例红。
func TestSummarizeWasmAppOpensTrendIncludesTodayBeforeFirstTick(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()

	// 只写明细，**不做任何 Aggregate**（服务端刚起 / 刚跨零点 / tick 还没跑）。
	openSummarySeedOpen(t, db, "notes", 1, now)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, now, now, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	if sum.Today.PV != 1 || sum.Today.UV != 1 {
		t.Fatalf("前置：today 应读明细得到 pv1/uv1，得到 %+v", sum.Today)
	}
	pt, ok := trendPointOf(t, sum, LocalDayString(now))
	if !ok {
		t.Fatalf("首个 tick 之前曲线漏掉今天（today 有数、曲线没有）: trend=%+v", sum.Trend)
	}
	if pt.PV != 1 || pt.UV != 1 {
		t.Fatalf("trend[今天]={pv:%d uv:%d}, want {1 1}（与 today 同源）", pt.PV, pt.UV)
	}
	assertTrendInvariants(t, sum)
}

// TestSummarizeWasmAppOpensTrendUnionsDetailAndSummaryDays 钉住趋势日期集合的**并集**
// 语义：同一次响应里既有"明细覆盖到的今天"（PV/UV 都来自明细），也有"明细已不在的
// 历史日"（PV 回落日汇总、UV 如实给 0），且按本地日升序。
//
// 变异验证：把日期集合改回"只以日汇总为准"⇒ 今天的点消失（本用例红）；
// 把明细日的 PV 改回读日汇总 ⇒ 该点的 pv/uv 不同源（assertTrendInvariants 红）。
func TestSummarizeWasmAppOpensTrendUnionsDetailAndSummaryDays(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	now := time.Now()
	oldDay := LocalDay(now).AddDate(0, 0, -5)

	// 历史日：只有日汇总行（模拟"明细已被保留期清理"）。
	if _, err := db.Exec(`INSERT INTO wasm_app_opens_daily (app_id, day, dept_id, pv, uv)
		VALUES ('notes', ?::date, 0, 9, 3)`, LocalDayString(oldDay)); err != nil {
		t.Fatalf("造日汇总行: %v", err)
	}
	// 今天：真实明细两行（两个人）。
	openSummarySeedOpen(t, db, "notes", 1, now)
	openSummarySeedOpen(t, db, "notes", 2, now)

	sum, err := SummarizeWasmAppOpens(context.Background(), db, oldDay, now, now)
	if err != nil {
		t.Fatalf("汇总失败: %v", err)
	}
	if len(sum.Trend) != 2 {
		t.Fatalf("趋势应有两天（历史日来自日汇总、今天来自明细），得到 %+v", sum.Trend)
	}
	if sum.Trend[0].Day != LocalDayString(oldDay) || sum.Trend[1].Day != LocalDayString(now) {
		t.Fatalf("趋势必须按本地日升序: %+v", sum.Trend)
	}
	if sum.Trend[0].PV != 9 || sum.Trend[0].UV != 0 {
		t.Fatalf("明细已不在的历史日 = {pv:%d uv:%d}, want {9 0}（PV 回落日汇总、UV 如实给 0）",
			sum.Trend[0].PV, sum.Trend[0].UV)
	}
	if sum.Trend[1].PV != 2 || sum.Trend[1].UV != 2 {
		t.Fatalf("今天的点 = {pv:%d uv:%d}, want {2 2}（明细同源）", sum.Trend[1].PV, sum.Trend[1].UV)
	}
	assertTrendInvariants(t, sum)
}
