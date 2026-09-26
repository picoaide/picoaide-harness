package reports

// R21F-01（审计 2026-09-26，P2）的判据：月报**期号**是**北京月标签**，
// `GenerateMonthlyReportForPeriod` 的解析绝不能经过 `time.Local`。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修前：`time.ParseInLocation("2006-01", period, time.Local)` ⇒ **本地**月首零点，
// 再 `AddDate(0,1,0)` 喂给 `GenerateMonthlyReport`（后者按 `serverstore.BeijingMonth`
// 取上月）。部署时区 **东于 UTC+8** 时（`Asia/Tokyo` / `Australia/Sydney`），本地月首
// 零点在北京还停在**上个月最后一天 23:00** ⇒ 期号少一个月（真库实测：
// 请求 `2026-02` 生成 `Period=2026-01`，请求 `2026-01` 生成 `2025-12`）。
// 静默：没有报错，投出去的报表期号与内容都比 `pending_period` 早一期 ——
// 而 `pending_period` 是补投游标，投出后立刻推进，于是那一期**永远不再有机会**。
//
// ## 判据（三条，缺一条都测不到"期号是北京标签"）
//
//	① **期号 == 请求期号**：五个时区（含两个东于 UTC+8 的）× 五个期号（含跨年）；
//	② **窗口也跟着期号走**：期号所在北京月的行被计入、邻月的不被计入
//	   （只钉标签的实现改了 `Period` 但窗口仍错的话这条红）；
//	③ **解析的严格性不回退**：`2026-1` / `2026-13` / `2026-02-01` / `x` 一律报错，
//	   且必须在**碰数据库之前**报错（传 nil DB 即可证明）。
//
// ## 判据为什么在用例内切 `time.Local`（而不是要求外部 `TZ=`）
//
// 期号解析的入参是**进程时区**。若靠外部环境变量，CI（UTC 容器）永远落在"正确"
// 的那一侧 ⇒ 判据恒绿，正是本仓登记的"判据未绑缺陷前提"假绿形态。切 `time.Local`
// 后同一份用例在**任意** `TZ` 下都成立（本仓 `local_day_test.go` 同款做法；
// 同包测试保持不并行）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-8/REPORT.md）
//
//   - `parseBeijingPeriod` 退回 `time.ParseInLocation("2006-01", period, time.Local)`
//     ⇒ ① 在 `Asia/Tokyo` / `Australia/Sydney` 下红（UTC/Shanghai/Santiago 仍绿 ——
//     这正是修前判据面缺失的原因）；
//   - 期号解析正确但窗口仍用本地月首（`GenerateMonthlyReport(db, localMonthStart.AddDate(0,1,0))`）
//     ⇒ ① 红（标签也错）或 ② 红；
//   - 去掉 layout 严格性（换成 `strings.Split` 解析）⇒ ③ 红。

import (
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// periodTZCases 是判据的时区空间：UTC、北京、两个东于 UTC+8 的时区（缺陷本体）、
// 一个负偏移 + DST 缺口的时区（回归面）。
var periodTZCases = []string{"UTC", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "America/Santiago"}

// periodCases 覆盖年初/年末（跨年进位）与普通月。
var periodCases = []string{"2026-01", "2026-02", "2026-06", "2026-12", "2027-01"}

// TestGenerateMonthlyReportForPeriodIsBeijingMonthInAnyTimezone 是①。
func TestGenerateMonthlyReportForPeriodIsBeijingMonthInAnyTimezone(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	for _, tz := range periodTZCases {
		loc, err := time.LoadLocation(tz)
		if err != nil {
			t.Skipf("本机没有时区数据 %s: %v", tz, err)
		}
		withProcessLocal(t, loc)
		for _, period := range periodCases {
			body, gerr := GenerateMonthlyReportForPeriod(db, period)
			if gerr != nil {
				t.Fatalf("TZ=%s 期号=%s 生成失败: %v", tz, period, gerr)
			}
			if body.Period != period {
				t.Fatalf("TZ=%s 请求期号=%s 生成期号=%s —— 期号是北京月标签，"+
					"解析不得经过 time.Local（部署时区东于 UTC+8 时本地月首零点在北京还属于上个月）",
					tz, period, body.Period)
			}
		}
	}
}

// TestGenerateMonthlyReportForPeriodWindowFollowsPeriod 是②：期号的**窗口**必须与
// 期号同源（只把标签改对、窗口仍按本地月首取的实现会在这里红）。
//
// 夹具用绝对瞬时（`bjAt`）构造，与进程 TZ 无关；断言的是"哪一期的行被算进来"。
func TestGenerateMonthlyReportForPeriodWindowFollowsPeriod(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "r21f01", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 2026-02 内两条（北京 2026-02-15 与 02-28 23:30，后者贴月界），
	// 2026-01 / 2026-03 各一条作负控。
	recordUsage(t, db, uid, "m1", 100, 10, bjAt(2026, 2, 15, 10))
	recordUsage(t, db, uid, "m1", 200, 20, bjAt(2026, 2, 28, 23))
	recordUsage(t, db, uid, "m1", 400, 40, bjAt(2026, 1, 31, 23))
	recordUsage(t, db, uid, "m1", 800, 80, bjAt(2026, 3, 1, 0))

	loc, lerr := time.LoadLocation("Asia/Tokyo") // 缺陷本体的时区
	if lerr != nil {
		t.Skipf("本机没有时区数据 Asia/Tokyo: %v", lerr)
	}
	withProcessLocal(t, loc)

	body, gerr := GenerateMonthlyReportForPeriod(db, "2026-02")
	if gerr != nil {
		t.Fatal(gerr)
	}
	if body.Period != "2026-02" {
		t.Fatalf("期号 = %s, want 2026-02", body.Period)
	}
	// 330 = 100+10+200+20（只含 2026-02 的两条）；相邻月的 440/880 不得计入。
	if body.Total.Requests != 2 || body.Total.Tokens != 330 {
		t.Fatalf("2026-02 的窗口算错: requests=%d tokens=%d, want 2/330"+
			"（计入邻月 = 窗口没跟着期号走）", body.Total.Requests, body.Total.Tokens)
	}
}

// TestGenerateMonthlyReportForPeriodRejectsMalformedPeriod 是③：解析形态的严格性
// 与修前逐字一致（`2006-01` 定长零填充、不接受多余字符），且**在碰数据库之前**报错。
//
// 传 nil DB：合法期号会走到聚合查询而 panic/报错，非法期号必须在此之前返回
// （这条同时钉住"校验在最前面"，防止把解析挪到查询之后）。
func TestGenerateMonthlyReportForPeriodRejectsMalformedPeriod(t *testing.T) {
	for _, bad := range []string{"", "x", "2026", "2026-1", "2026-13", "2026-00", "2026-02-01", "2026-02 ", " 2026-02"} {
		body, err := GenerateMonthlyReportForPeriod(nil, bad)
		if err == nil {
			t.Fatalf("期号 %q 必须被拒（修前 time.ParseInLocation 也拒），实得 body=%+v", bad, body)
		}
	}
}

// withProcessLocal 把进程时区切到 loc 并在用例结束时还原（判据的入参就是它）。
//
// ⚠️ 本包的用例因此**不得并行**（当前包内零处 t.Parallel()）；新增并行用例前先读
// 本文件头。与 serverstore/local_day_test.go 的 withLocal 同一纪律。
func withProcessLocal(t *testing.T, loc *time.Location) {
	t.Helper()
	prev := time.Local
	time.Local = loc
	t.Cleanup(func() { time.Local = prev })
}
