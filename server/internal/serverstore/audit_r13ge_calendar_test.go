package serverstore

// R13-GE · R13A-02 回归：启动账本自愈窗口的 `AddDate` **月溢出**。
//
// 被审形态（R13-A 的日历探针）：`cmd/server/main.go` 的启动补算窗口是
//
//	from := serverstore.BeijingDay(time.Now()).AddDate(0, -max(n, 6), 0)
//
// 而 Go 的 `time.Time.AddDate` 会**归一化**（官方文档："AddDate normalizes its
// result in the same way that Date does"）：北京 2026-08-31 减 6 个月 = 2026-02-31
// → 归一化成 **2026-03-03**；下游 `dayKey()` 把起点截到月初 ⇒ **整个 2026-02 月**
// 从窗口里消失，而它此刻仍在保留期内（cutoff = 2026-02；回收只删 `< cutoff` 的月）。
//
// 触发面 ≈10 天/年（3/5/7/10/12 月 31 日各 1 天 + 8 月 29/30/31 共 3 天）。
// 危害：`cmd/server` 的启动补算是全仓**唯一**的"任意月"账本自愈入口
// （`RebuildUsageLedger` 的生产调用点只有这一处；`retentionBackfill` 只服务
// **被回收**的月，而 cutoff 月本身永不被回收）⇒ 触发日启动的实例，保留期内最早
// 一个月的 `usage_daily`/`usage_monthly` 洞不会被本轮或后续任何清理轮修补。
//
// 本文件三条判据：
//
//	A. 表驱动（21 个 (年,月,日,N) 组合，语料取自 R13-A 的探针）：窗口起点（月初）
//	   必须恰好等于保留期 cutoff 月；oracle 用**整数月份算术**独立算出来，
//	   不经过 AddDate（否则就是"同一条坏表达式自己对自己"）。
//	B. 真实复现（真 PG + 真 `RebuildUsageLedger`）：把时钟推到北京 2026-08-31、
//	   造一条 2 月明细并抹掉它的日账，跑一次启动窗口 ⇒ 2 月的日账必须被补回来。
//	C. 接线判据（源码级）：`cmd/server/main.go` 必须真的调用那个唯一实现 ——
//	   否则"helper 修好了但生产没用它"会静默通过（本项目登记的"接线守卫"形态）。

import (
	"os"
	"regexp"
	"strings"
	"testing"
	"time"
)

// r13geMonthShift 是"月份加减"的**独立 oracle**：用整数月份序号算，不经过
// `time.AddDate`（被测实现正是那个会归一化溢出的 API）。
func r13geMonthShift(y int, m time.Month, delta int) time.Time {
	idx := y*12 + int(m) - 1 + delta
	return time.Date(idx/12, time.Month(idx%12+1), 1, 0, 0, 0, 0, time.UTC)
}

// TestAuditR13GEStartupWindowCoversWholeRetention 是判据 A（表驱动，纯函数）。
func TestAuditR13GEStartupWindowCoversWholeRetention(t *testing.T) {
	var cases []struct {
		year      int
		month     time.Month
		day       int
		months    int
		got, want string
	}
	// 语料：2026–2028（含闰年 2028）× 每月 28 号起的每一天 × N∈{6,12}。
	// 覆盖 R13-A 探针列出的全部 21 个组合，且不依赖运行日期。
	for y := 2026; y <= 2028; y++ {
		for m := time.January; m <= time.December; m++ {
			last := time.Date(y, m+1, 0, 0, 0, 0, 0, time.UTC).Day()
			for d := 28; d <= last; d++ {
				for _, n := range []int{6, 12} {
					// now = 北京 (y,m,d) 12:00 的绝对瞬时（UTC+8）。
					now := time.Date(y, m, d, 12, 0, 0, 0, time.UTC).Add(-BeijingOffset)
					// 生产装配的窗口起点（唯一实现）。
					from := RetentionWindowStart(now, n)
					// oracle：cutoff 月 = 当前北京月 - N（整数月份算术）。
					want := r13geMonthShift(y, m, -n)
					cases = append(cases, struct {
						year      int
						month     time.Month
						day       int
						months    int
						got, want string
					}{y, m, d, n, from.Format("2006-01-02"), want.Format("2006-01-02")})
				}
			}
		}
	}
	if len(cases) < 200 {
		t.Fatalf("语料只有 %d 个组合（下限 200）—— 判据失效，不能静默通过", len(cases))
	}
	bad := 0
	for _, c := range cases {
		gotRow := dayKey(RetentionWindowStart(
			time.Date(c.year, c.month, c.day, 12, 0, 0, 0, time.UTC).Add(-BeijingOffset), c.months))
		if gotRow.Format("2006-01-02") != c.want {
			if bad < 8 {
				t.Errorf("窗口起点把仍在保留期内的月整月跳过：now=%04d-%02d-%02d N=%d got=%s want=%s",
					c.year, c.month, c.day, c.months, c.got, c.want)
			}
			bad++
		}
	}
	if bad > 0 {
		t.Errorf("共 %d/%d 个组合失败（AddDate 月溢出的形态）", bad, len(cases))
	}
	t.Logf("语料 %d 个 (年,月,日,N) 组合全部通过（2026–2028 含闰年 × 28 日起 × N∈{6,12}）", len(cases))
}

// TestAuditR13GEStartupWindowHealsTheOldestRetainedMonth 是判据 B（真 PG 复现）。
//
// 这正是 R13-A 探针的复现器形态：北京 2026-08-31 启动、2 月有明细但日账有洞。
// 修复后（窗口=月初归一）2 月必须被补回来。
func TestAuditR13GEStartupWindowHealsTheOldestRetainedMonth(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("TRUNCATE TABLE usage_daily RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	const retention = 6
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	// 启动时刻 = 北京 2026-08-31（"目标月没有该日"的那一类：8/31 - 6 月 = 2/31）。
	now := time.Date(2026, 8, 31, 10, 0, 0, 0, time.UTC).Add(-BeijingOffset)
	cutoff := r13geMonthShift(2026, time.August, -retention) // 2026-02-01
	if got := monthKey(cutoff); got != "202602" {
		t.Fatalf("oracle 失效：cutoff=%s，want 202602", got)
	}

	// 造一条**保留期内最早那个月**（cutoff 月 = 2026-02）的明细。
	if err := ensureUsagePartition(db, cutoff); err != nil {
		t.Fatalf("建 2026-02 分区: %v", err)
	}
	usageRowAt(t, db, uid, "r13ge-cal", BeijingDayAt(cutoff, 12), 2.5)
	// 抹掉它的日账（模拟"历史洞"）。
	if _, err := db.Exec(`DELETE FROM usage_daily`); err != nil {
		t.Fatal(err)
	}
	var daily int
	if err := db.QueryRow(`SELECT count(*) FROM usage_daily`).Scan(&daily); err != nil {
		t.Fatal(err)
	}
	if daily != 0 {
		t.Fatalf("夹具无效：日账没被抹掉（%d 行）", daily)
	}

	// 跑启动补算窗口（生产装配的那一行）。
	from := RetentionWindowStart(now, max(retention, 6))
	t.Logf("now(北京)=%s | 窗口起点=%s（月初=%s）| cutoff 月=%s",
		now.Add(BeijingOffset).Format("2006-01-02"), from.Format("2006-01-02"),
		dayKey(from).Format("2006-01"), monthKey(cutoff))
	if dayKey(from).After(cutoff) {
		t.Errorf("窗口起点 %s 晚于保留期 cutoff 月 %s —— 仍在保留期内的最早一个月被整月跳过自愈",
			dayKey(from).Format("2006-01"), monthKey(cutoff))
	}
	if err := RebuildUsageLedger(db, from, now); err != nil {
		t.Fatalf("RebuildUsageLedger: %v", err)
	}
	var healed int
	if err := db.QueryRow(`SELECT count(*) FROM usage_daily WHERE day = $1`,
		cutoff.Format(dateFmt)).Scan(&healed); err != nil {
		t.Fatal(err)
	}
	t.Logf("补算后 usage_daily(2026-02-01)=%d（want 1）", healed)
	if healed != 1 {
		t.Errorf("保留期内最早一个月（%s）的账本洞没有被启动自愈补上 —— "+
			"AddDate 月溢出形态仍在", monthKey(cutoff))
	}
}

// TestAuditR13GEStartupWindowUsesTheUniqueImplementation 是判据 C（源码级接线守卫）。
//
// "helper 修好了" ≠ "生产用了它"：本项目已登记过这种假绿（辅助函数测得到、接线缺失）。
// 所以从 `cmd/server/main.go` 里**逐字确认**启动窗口调用的是唯一实现，并且**不再**
// 出现裸 `AddDate(0, -…, 0)` 的旧形态。
func TestAuditR13GEStartupWindowUsesTheUniqueImplementation(t *testing.T) {
	raw, err := os.ReadFile("../../cmd/server/main.go")
	if err != nil {
		t.Fatalf("读 ../../cmd/server/main.go: %v", err)
	}
	src := string(raw)
	if !strings.Contains(src, "serverstore.RetentionWindowStart(") {
		t.Errorf("cmd/server/main.go 的启动账本自愈窗口没有调用唯一实现 serverstore.RetentionWindowStart —— " +
			"helper 修好但生产没用它（接线缺失）")
	}
	legacy := regexp.MustCompile(`BeijingDay\(time\.Now\(\)\)\.AddDate\(0, -`)
	if legacy.MatchString(src) {
		t.Errorf("cmd/server/main.go 仍出现旧形态 `BeijingDay(time.Now()).AddDate(0, -N, 0)` —— " +
			"AddDate 会在「目标月没有该日」时溢出到再下一个月，仍在保留期内的最早一个月被整月跳过")
	}
}
