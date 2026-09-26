package reports

// R21F-05（审计 2026-09-26，P3）的判据：补投游标的**期号推进**（`periodAfter`）
// 绝不能经过 `time.Local`。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前：`time.ParseInLocation("2006-01", period, time.Local)` + `start.AddDate(0,1,0)`。
// `ParseInLocation` 对**不存在的本地时刻**会做归一化：当部署时区的 DST **缺口**
// 正好落在某月 1 日的本地零点时，那个"月首零点"会被推到**上月最后一天 23:00**
// ⇒ `+1 月` 之后仍格式化出**同一个月份** ⇒ `nextPendingAfterDelivery` 返回与输入
// 相同的期号 ⇒ `pending_period`（R21C-01 起的**逐期推进游标**）原地不动，
// 那一期被反复投递、后面的期永远排不上（补投链断在原地）。
//
// 真实形态（探针实跑，输出存 temp/r21/fix-10/probe/out.txt）：
//
//	legacy  America/Asuncion 2017-09 → 2017-09   （want 2017-10）
//	legacy  America/Asuncion 2023-09 → 2023-09   （want 2023-10）
//
// 418 个时区 × 2015–2035 × 12 个月只命中这两组真形态，且都是历史日期
// （Asunción 2024 起已无 DST）⇒ 现网不可达，故登记为 P3。
//
// ## 判据（三条，缺一条都测不到"游标只推进字面年月"）
//
//	① **严格晚一期**：六个时区（含缺陷本体的 `America/Asuncion`）× 若干期号
//	   （含跨年、含"**自身月首零点不存在**"的期号）上，`periodAfter(p)` 必须**严格
//	   晚于** p 且恰为下一月；
//	② **缺口形态**：`time.Local = America/Asuncion` 时，那几个"1 日零点不存在"的
//	   月份仍必须推进一期（**自校准**：先证明本机 tzdata 下旧实现真的会卡住，
//	   否则 `t.Skipf` 说明"判据在本环境咬不到"，不假红）；
//	③ **游标的真实后果**：`nextPendingAfterDelivery` 对任意早于当前期的期号
//	   必须**严格推进**（返回同值 = 那一期被反复投递）；
//	   外加**非法期号仍返回空串**（保守收口不被这次改动放松）。
//
// ## 判据为什么在用例内切 `time.Local`（而不是要求外部 `TZ=`）
//
// 解析的入参就是进程时区。靠外部环境变量时 CI（UTC 容器）永远落在"正确"的
// 一侧 ⇒ 判据恒绿，正是本仓登记的"判据未绑缺陷前提"假绿形态。与
// `report_period_timezone_test.go` 的 `withProcessLocal` 同纪律、同包不并行。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-10/REPORT.md）
//
//   - `periodAfter` 退回 `ParseInLocation("2006-01", period, time.Local)` +
//     `AddDate(0,1,0)` ⇒ ② 红（Asunción 形态），① 在其余五个时区仍绿 ——
//     这正是修前判据面缺失的原因；
//   - 只把解析换成 `time.Parse` 但仍做**本地**月算术 ⇒ ② 红（同样的归一化）；
//   - `periodAfter` 恒返回入参（游标不推进）⇒ ①②③ 全红；
//   - **只**把 `parseBeijingPeriod` 的解析换成 `ParseInLocation(…, time.Local)`
//     （月算术不动 —— R21F-05 的"另一半"）⇒ ①（`2017-10` 语料）与 ②④ 红
//     （R22-V3-B4，复审 2026-09-26：修前仓内 4 条判据在这个变异下**全绿**，
//     因为语料里只有"缺口在期号**下一月**"的形态，没有"缺口就在**本月**"的形态）。

import (
	"fmt"
	"testing"
	"time"
)

// periodAfterCases 覆盖缺陷形态（2017-09 / 2023-09，Asunción 的缺口月前一月）、
// 普通月与跨年（年末 +1 月进到次年）。
var periodAfterCases = []struct{ in, want string }{
	{"2017-09", "2017-10"}, // 缺口在期号的**下一月**（AddDate 归一化把月首吞回本月）
	{"2023-09", "2023-10"}, // 同上（第二组实测形态）
	// R22-V3-B4：缺口就在**期号自己的那个月**（`2017-10-01 00:00` 本地不存在 ⇒
	// `ParseInLocation` 把日期值推到 09-30，`+1 月` 之后仍是同一期）。这两条把
	// "只把解析换回 time.Local"这半个变异钉死 —— 修前语料里一条都没有。
	{"2017-10", "2017-11"},
	{"2023-10", "2023-11"},
	{"2000-10", "2000-11"}, // 同一形态的更早一组（扫描实测命中）
	{"2001-03", "2001-04"}, // America/Havana（另一族 DST 形态，扫描实测命中）
	{"2016-03", "2016-04"}, // Asia/Amman 的缺口月（归一化只挪小时、date 不变 ⇒ 无害，作对照）
	{"2026-01", "2026-02"},
	{"2026-02", "2026-03"},
	{"2026-11", "2026-12"},
	{"2026-12", "2027-01"}, // 跨年
	{"2023-12", "2024-01"}, // 跨年（缺陷时区的同一形态）
	{"1999-12", "2000-01"}, // 世纪边界
}

// periodAfterZones 是判据的时区空间：UTC、北京、两个东于 UTC+8 的时区
// （R21F-01 的缺陷面，回归）、两个有 DST 缺口历史的时区（本条缺陷本体）。
var periodAfterZones = []string{
	"UTC", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
	"America/Asuncion", "Asia/Amman",
}

// TestPeriodAfterAdvancesExactlyOneMonth 是①：任意时区、任意合法期号，
// 游标都必须严格推进恰好一个月。
func TestPeriodAfterAdvancesExactlyOneMonth(t *testing.T) {
	for _, tz := range periodAfterZones {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			t.Skipf("本机没有时区数据 %s: %v", tz, err)
		}
		withProcessLocal(t, loc)
		for _, c := range periodAfterCases {
			got := periodAfter(c.in)
			if got != c.want {
				t.Fatalf("TZ=%s periodAfter(%q) = %q, want %q —— 期号是标签，"+
					"解析与月算术都不得经过 time.Local", tz, c.in, got, c.want)
			}
			// 判据的"牙齿"：结果必须**严格晚于**输入（`YYYY-MM` 定长零填充 ⇒
			// 字典序 = 时间序）。返回同值 = 游标卡住（那一期被反复投递）。
			if !(got > c.in) {
				t.Fatalf("TZ=%s periodAfter(%q) = %q 不晚于输入（游标不前进 ⇒ "+
					"pending_period 会被反复投出同一期）", tz, c.in, got)
			}
		}
	}
}

// legacyPeriodAfterForTest 是**修前**的实现（只用于自校准：证明本机 tzdata 下
// 这条判据真的能咬到缺陷，以及证明新实现不是"碰巧正确"）。
func legacyPeriodAfterForTest(period string, loc *time.Location) string {
	start, err := time.ParseInLocation("2006-01", period, loc)
	if err != nil {
		return ""
	}
	return start.AddDate(0, 1, 0).Format("2006-01")
}

// TestPeriodAfterDoesNotStallOnDSTGapAtMonthStart 是②：缺口落在月首零点时，
// 游标仍必须推进（修前它返回同一个月）。
//
// 自校准（本仓对 tzdata 类判据的纪律）：先确认 ①该本地月 1 日的零点真的不存在、
// ②旧实现真的卡住；两条任一不成立就 `t.Skipf` 说明"本环境咬不到"，不假红也不假绿。
func TestPeriodAfterDoesNotStallOnDSTGapAtMonthStart(t *testing.T) {
	loc, err := time.LoadLocation("America/Asuncion")
	if err != nil {
		t.Skipf("本机没有时区数据 America/Asuncion: %v", err)
	}
	// (期号, 缺口所在月, 期望的下一期) —— 缺口月可以是期号的**下一月**（AddDate 把月首
	// 归一化回本月），也可以是期号**自己那一个月**（ParseInLocation 就已经把日期值推到
	// 上月最后一天）。R22-V3-B4 补的是后者：修前语料只有前者 ⇒ "只换解析"的变异全绿。
	cases := []struct {
		period     string
		gapYear    int
		gapMonth   time.Month
		wantPeriod string
	}{
		{"2017-09", 2017, time.October, "2017-10"},
		{"2023-09", 2023, time.October, "2023-10"},
		{"2017-10", 2017, time.October, "2017-11"}, // 缺口在期号自身那一月
		{"2023-10", 2023, time.October, "2023-11"}, // 同上
	}
	for _, c := range cases {
		// 自校准 ①：本地月首零点必须真的不存在（`time.Date` 把它归一化掉了）。
		literal := time.Date(c.gapYear, c.gapMonth, 1, 0, 0, 0, 0, loc)
		if literal.Day() == 1 && literal.Hour() == 0 && literal.Minute() == 0 {
			t.Skipf("本机 tzdata 下 %s 的 %d-%02d-01 零点存在 ⇒ 判据在本环境咬不到",
				loc, c.gapYear, c.gapMonth)
		}
		// 自校准 ②：旧实现必须**真的卡住**（否则这条用例测的不是本缺陷）。
		if legacy := legacyPeriodAfterForTest(c.period, loc); legacy != c.period {
			t.Skipf("本机 tzdata 下旧实现给出 %s（≠ %s）⇒ 判据在本环境咬不到",
				legacy, c.period)
		}
	}

	withProcessLocal(t, loc)
	for _, c := range cases {
		if got := periodAfter(c.period); got != c.wantPeriod {
			t.Fatalf("TZ=%s periodAfter(%q) = %q, want %q —— DST 缺口吞掉月首零点时，"+
				"ParseInLocation 会把日期值推到上月最后一天 ⇒ +1 月后仍是同一期，"+
				"欠投游标原地不动（补投链断在原地）", loc, c.period, got, c.wantPeriod)
		}
	}
}

// periodAfterScanZones 是④扫描的时区空间：两处"月首零点不存在"的**真形态**
// （America/Asuncion、America/Havana，本机 tzdata 扫描命中）+ 东于 UTC+8 的回归面
// （R21F-01）+ 两个有 DST 的对照。
var periodAfterScanZones = []string{
	"UTC", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney",
	"America/Asuncion", "America/Havana", "Asia/Amman",
	"Pacific/Apia", "America/Santiago",
}

// TestPeriodAfterAdvancesAcrossOwnMonthStartGap 是④：**自己找**"哪一组 (时区, 期号)
// 真的会卡"，而不是靠人眼挑年份。
//
// 为什么需要它（R22-V3-B4，复审 2026-09-26，P3）：V3 用 487 时区 × 21 年的扫描发现，
// 只把 `parseBeijingPeriod` 的解析换回 `ParseInLocation(…, time.Local)`（月算术不动）
// 时，仓内 4 条判据**全绿**，而 `America/Asuncion` 的 2017-10 / 2023-10 真的卡住 ——
// 因为语料里只有"缺口在期号**下一月**"的形态。现在语料（①②）已补上该形态，本用例再把
// "还可能有哪些形态"交给自校准扫描，避免下一次只补一个年份。
//
// 自校准（本仓对 tzdata 类判据的纪律）：卡住的形态由**旧实现自己**产生
// （`legacyPeriodAfterForTest(p, loc) == p`）；一个都扫不到就 `t.Skipf` 如实说明
// "本环境咬不到"（tzdata 缺失/被裁剪），既不假红也不假绿。
func TestPeriodAfterAdvancesAcrossOwnMonthStartGap(t *testing.T) {
	scanned, stalls := 0, 0
	for _, tz := range periodAfterScanZones {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			t.Skipf("本机没有时区数据 %s: %v", tz, err)
		}
		withProcessLocal(t, loc)
		for y := 2000; y <= 2040; y++ {
			for m := 1; m <= 12; m++ {
				period := fmt.Sprintf("%04d-%02d", y, m)
				scanned++
				if legacyPeriodAfterForTest(period, loc) != period {
					continue // 本环境这个 (时区, 期号) 不是缺陷形态 ⇒ 无需断言
				}
				stalls++
				want := time.Date(y, time.Month(m), 1, 0, 0, 0, 0, time.UTC).
					AddDate(0, 1, 0).Format("2006-01")
				got := periodAfter(period)
				if got == period {
					t.Fatalf("TZ=%s periodAfter(%q) = %q —— 游标原地不动：该月首零点在本地不存在时，"+
						"解析与月算术都不得经过 time.Local（旧实现正好卡在这里，自校准已证明）",
						tz, period, got)
				}
				if got != want {
					t.Fatalf("TZ=%s periodAfter(%q) = %q, want %q", tz, period, got, want)
				}
			}
		}
	}
	if stalls == 0 {
		t.Skipf("扫描了 %d 个 (时区 × 期号) 都没命中「自身月首零点不存在」的形态 ⇒ "+
			"判据在本环境咬不到（tzdata 缺失或被裁剪），不假绿", scanned)
	}
	t.Logf("扫描 %d 个 (时区 × 期号)，自校准命中 %d 个旧实现会卡住的形态，全部严格推进恰好一个月",
		scanned, stalls)
}

// TestNextPendingAfterDeliveryAlwaysAdvances 是③：把判据钉在**真实后果**上 ——
// 只要补投的期号早于"当前应投期"，游标就必须严格推进（返回同值 = 反复投同一期）。
//
// `now` 用绝对瞬时（bjAt）构造，与进程 TZ 无关；同时覆盖缺陷时区与普通时区。
func TestNextPendingAfterDeliveryAlwaysAdvances(t *testing.T) {
	now := bjAt(2026, 9, 15, 0) // CurrentPeriod(now) == 2026-08
	if cur := CurrentPeriod(now); cur != "2026-08" {
		t.Fatalf("夹具前提不成立: CurrentPeriod(%v) = %q, want 2026-08", now, cur)
	}
	for _, tz := range periodAfterZones {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			t.Skipf("本机没有时区数据 %s: %v", tz, err)
		}
		withProcessLocal(t, loc)
		for _, period := range []string{"2017-09", "2023-09", "2026-01", "2026-07"} {
			next := nextPendingAfterDelivery(now, period)
			want := periodAfter(period)
			if next != want {
				t.Fatalf("TZ=%s nextPendingAfterDelivery(%q) = %q, want %q",
					tz, period, next, want)
			}
			if !(next > period) {
				t.Fatalf("TZ=%s 补投游标不前进: %q → %q（同一期会被反复投出）",
					tz, period, next)
			}
		}
		// 已到当前期的期号仍必须清空游标（欠投补完，R21C-01 的原语义不放松）。
		if got := nextPendingAfterDelivery(now, "2026-08"); got != "" {
			t.Fatalf("TZ=%s 投出当前应投期后必须清空游标, got %q", tz, got)
		}
	}
}

// TestPeriodAfterKeepsConservativeFallback 是③的另一半：非法期号仍返回空串
// （**保守收口**：宁可停止推进，也不往库里写一个解析不了的期号）。
//
// 形态集合与 `TestGenerateMonthlyReportForPeriodRejectsMalformedPeriod` 同源：
// layout `2006-01` 要求定长零填充、不接受多余字符。
func TestPeriodAfterKeepsConservativeFallback(t *testing.T) {
	for _, bad := range []string{"", "x", "2026", "2026-1", "2026-13", "2026-00", "2026-02-01", "2026-02 ", " 2026-02"} {
		if got := periodAfter(bad); got != "" {
			t.Fatalf("periodAfter(%q) = %q, want \"\"（非法期号必须保守收口）", bad, got)
		}
	}
}
