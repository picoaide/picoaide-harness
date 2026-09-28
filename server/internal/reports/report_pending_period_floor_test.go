package reports

// R23-V3-B1（复审 2026-09-27，**P2**）的判据：`pending_period` 可信度的**下界**，
// 以及"期号越界类"生成失败的两条独立性质。
//
// ## 缺陷形态（判据要杀的东西）
//
// 修复前的 `classifyPendingPeriod` **只有上界**（"晚于当前应投期 ⇒ 未来期号，不可信"），
// 而形态合法、又早于当前应投期的值一律当**可信游标**。真 PG + 真 webhook 实测：
//
//	`pending_period='0001-01'`（形态合法，Go 与 PG 都接受）
//	⇒ 5 轮 DispatchAll 全部投出公元 1 年的空报表 [0001-01 … 0001-05]，游标每轮 +1 月，
//	  真正欠投的 2026-06/07/08 **一期都没投**（把游标追到 2026 年需要 2.4 万+ 轮），
//	  且 `last_error` 全程为空（连痕迹都没有）。
//	`pending_period='0000-01'`（Go 能解析、PG 表示不了公元 0 年）
//	⇒ 聚合 SQL 报 `SQLSTATE 22008` ⇒ 走**生成失败**路径并**设了退避** ⇒ 人工改回合法值
//	  后**不能"下一轮自愈"**（要等自己设下的 1 小时窗口）——与形态非法档明确写下的
//	  "不设退避、改好即自愈"承诺相反。
//
// ## 修后契约（本文件钉住的四条）
//
//	① 下界 = `CurrentPeriod(created_at)`（`pendingPeriodFloor`）：早于它的一律
//	   **不可信档** —— 本轮不投 + 记原因 + **不设退避** + 改回合法值后下一轮自愈；
//	② 下界是**闭区间**：恰等于 `CurrentPeriod(created_at)` 是产品自己会写下的合法边界；
//	③ 合法历史欠投（跨多月）仍按序补齐、每期恰好一次（下界不得把正常补投挡掉）；
//	④ **期号越界类**的生成失败（解析失败 / `SQLSTATE 22xxx`）不设退避、不钉游标，
//	   且**不拖垮整批**（同轮其他订阅照常投）—— 后者是把 `return ok, failed, err`
//	   单编辑改回去时**唯一**会红的性质（分类层拦下的坏行走不到生成期）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-21/REPORT.md）
//
//   - 去掉下界（`pendingPeriodFloor` 恒返回 ""）⇒ ①②红（`0001-01` 又变成可信游标，
//     5 轮全部投出公元 1 年的空报表）；
//   - 下界改成开区间（`periodBeforeFloor` 用 `<=`）⇒ ②红（产品自己写下的边界值被拒）；
//   - 生成失败退回 `return ok, failed, err`（R22-V3-B1 之前的形态）⇒ ④红
//     （同轮 id 更大的订阅零痕迹、且 DispatchAll 返回非 nil）；
//   - 生成失败一律走退避档（不看 `periodUnusableError`）⇒ ④红
//     （`next_attempt_at` 非 NULL + 恢复轮被退避窗口挡住）。

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestPendingPeriodClassificationMatrix 是判定层的**逐输入读数**表
// （`classifyPendingPeriod` + `SubscriptionDuePeriod`，注入时钟与订阅创建月）。
//
// 每个输入读三件事：本轮投不投（`due`）、投的话是哪一期、有没有可诊断原因。
// "是否设退避 / 改回合法值后是否自愈"两条是端到端读数，见本文件另两条用例。
func TestPendingPeriodClassificationMatrix(t *testing.T) {
	now := bjAt(2026, 9, 15, 10)   // CurrentPeriod = 2026-08
	created := bjAt(2026, 9, 5, 9) // 下界 = CurrentPeriod = 2026-08
	if cur := CurrentPeriod(now); cur != "2026-08" {
		t.Fatalf("夹具前提不成立: CurrentPeriod = %q, want 2026-08", cur)
	}
	if floor := pendingPeriodFloor(created); floor != "2026-08" {
		t.Fatalf("夹具前提不成立: 下界 = %q, want 2026-08", floor)
	}
	lastRun := now
	cases := []struct {
		name    string
		pending string
		lastRun *time.Time
		wantDue bool
		want    string // due=true 时的期号
		anomaly bool
		// keyword 是诊断文案里必须出现的"下一步怎么办"（fail-closed 档 = 「下一轮」，
		// 未来期号档 = 走正常路径补投当前应投期）。
		keyword string
		why     string
	}{
		{"空串 = 无游标", "", nil, true, "2026-08", false, "正常路径", "正常路径（当前应投期）"},
		{"恰为当前应投期", "2026-08", nil, true, "2026-08", false, "正常路径", "合法边界"},
		{"恰为下界（创建当月首次失败的写法）", "2026-08", nil, true, "2026-08", false, "正常路径", "闭区间下界"},
		{"早于下界一期", "2026-07", nil, false, "", true, "下一轮", "★ 下界：产品不可能写下的值 ⇒ fail-closed"},
		{"公元 1 年（本轮最小反例）", "0001-01", nil, false, "", true, "下一轮", "★ 下界：修前每轮投出公元 1 年的空报表"},
		{"公元 0 年（PG 表示不了）", "0000-01", nil, false, "", true, "下一轮", "★ 下界 + 表示区间：修前走生成失败并设退避"},
		{"公元 0 年·十二月", "0000-12", nil, false, "", true, "下一轮", "同上（早于 earliestReportPeriod）"},
		{"公元 1000 年", "1000-01", nil, false, "", true, "下一轮", "下界"},
		{"公元 1900 年", "1900-01", nil, false, "", true, "下一轮", "下界"},
		{"Unix 纪元", "1970-01", nil, false, "", true, "下一轮", "下界"},
		{"形态非法·月越界", "2026-99", nil, false, "", true, "下一轮", "形态档"},
		{"形态非法·非数字", "oops", nil, false, "", true, "下一轮", "形态档"},
		{"未来期号", "2026-09", nil, true, "2026-08", true, "正常路径", "忽略该格、走正常路径"},
		{"未来期号·极远", "9999-12", nil, true, "2026-08", true, "正常路径", "忽略该格、走正常路径"},
		{"未来期号 + 本月已投过", "2026-09", &lastRun, false, "", true, "正常路径", "不投但留原因"},
	}
	for _, c := range cases {
		sub := serverstore.ReportSubscription{
			Enabled: true, PendingPeriod: c.pending, CreatedAt: created, LastRunAt: c.lastRun,
		}
		period, due, anomaly := SubscriptionDuePeriod(now, sub)
		// 逐输入读数（-v 可见；报告里直接引用这几行）。
		class, reason := classifyPendingPeriod(now, created, c.pending)
		t.Logf("READING pending=%-9q class=%d due=%-5v period=%-8q anomaly=%v reason=%q",
			c.pending, class, due, period, anomaly != "", reason)
		if due != c.wantDue || period != c.want {
			t.Fatalf("%s（pending=%q）: period=%q due=%v, want period=%q due=%v —— %s",
				c.name, c.pending, period, due, c.want, c.wantDue, c.why)
		}
		if (anomaly != "") != c.anomaly {
			t.Fatalf("%s（pending=%q）: anomaly=%q, want 非空=%v —— %s",
				c.name, c.pending, anomaly, c.anomaly, c.why)
		}
		if anomaly != "" && !strings.Contains(anomaly, c.keyword) {
			t.Fatalf("%s: 诊断文案必须写明下一步怎么办（含 %s）: %q", c.name, c.keyword, anomaly)
		}
	}
}

// TestAncientPendingPeriodIsFailClosedAndSelfHeals 是 ①②③ 的端到端判据
// （真 PG + 真 webhook + 注入时钟）。
//
// 两个古老形态（`0001-01` / `0000-01`）各跑一遍：
//
//	第 1..5 轮：ok=0 failed=1、**零投递**、`next_attempt_at` 保持 NULL（不设退避）、
//	            `last_error` 留痕且含该值、`pending_period` 原样保留（等人工修）；
//	修库后第 6..9 轮：按序补齐 4 期，每期恰好一次（下界不得挡住合法的历史补投）。
func TestAncientPendingPeriodIsFailClosedAndSelfHeals(t *testing.T) {
	for _, ancient := range []string{"0001-01", "0000-01"} {
		t.Run(ancient, func(t *testing.T) {
			allowLocalWebhooks(t)
			db, cleanup := serverstore.NewTestDB(t)
			t.Cleanup(cleanup)
			srv, ledger := newReportLedgerServer(t)

			id, err := serverstore.CreateReportSubscription(db, "ancient", srv.URL+"/ancient", true)
			if err != nil {
				t.Fatal(err)
			}
			// 订阅创建于 2026-09 ⇒ 下界 2026-08（`0001-01` / `0000-01` 远远早于它）。
			pinSubscriptionCreatedAt(t, db, id, bjAt(2026, 9, 5, 9))
			if _, err := db.Exec(`UPDATE report_subscriptions SET pending_period=$1 WHERE id=$2`,
				ancient, id); err != nil {
				t.Fatal(err)
			}
			month := bjAt(2026, 9, 15, 10) // CurrentPeriod = 2026-08

			for round := 1; round <= 5; round++ {
				ok, failed, derr := DispatchAll(context.Background(), db, month)
				if derr != nil {
					t.Fatalf("第 %d 轮 DispatchAll 整轮报错: %v —— 不可信游标不得终止整批", round, derr)
				}
				if ok != 0 || failed != 1 {
					t.Fatalf("第 %d 轮 ok=%d failed=%d, want 0/1（不可信游标：本轮不投 + 记一次失败）",
						round, ok, failed)
				}
				sub, err := serverstore.GetReportSubscription(db, id)
				if err != nil {
					t.Fatal(err)
				}
				if sub.PendingPeriod != ancient {
					t.Fatalf("第 %d 轮 pending_period = %q, want 原样保留 %q（不可信的值由人工修）",
						round, sub.PendingPeriod, ancient)
				}
				if sub.NextAttemptAt != nil {
					t.Fatalf("第 %d 轮 next_attempt_at = %v, want NULL —— 不可信游标档**不设退避**（否则改回合法值后不能「下一轮自愈」）", round, sub.NextAttemptAt)
				}
				if !strings.Contains(sub.LastError, ancient) {
					t.Fatalf("第 %d 轮 last_error = %q, want 含 %q 的可诊断原因", round, sub.LastError, ancient)
				}
				if got := ledger.dump("ancient"); len(got) != 0 {
					t.Fatalf("第 %d 轮投出了 %v —— 不可信游标绝不能生成/投递任何报表", round, got)
				}
				t.Logf("READING %s 第 %d 轮 ok=%d failed=%d pending=%q next_attempt=%v delivered=%v",
					ancient, round, ok, failed, sub.PendingPeriod, sub.NextAttemptAt, ledger.dump("ancient"))
			}

			// —— 恢复路径：人工把那一格改成**合法且在下界之上**的期号，
			// 并把创建月对齐到这份欠投（夹具时间自洽：真实部署里欠 5 月意味着订阅至少
			// 5 月前就在，见 pinSubscriptionCreatedAt）。
			// `fail_streak` 此刻已累积到 5 —— 恢复仍必须落在**下一轮**（这正是"不设退避"
			// 与"退避档"的可见差别）。——
			pinSubscriptionCreatedAt(t, db, id, bjAt(2026, 6, 5, 9)) // 下界 = 2026-05
			if _, err := db.Exec(`UPDATE report_subscriptions SET pending_period='2026-05' WHERE id=$1`,
				id); err != nil {
				t.Fatal(err)
			}
			for round := 0; round < 4; round++ {
				ok, failed, derr := DispatchAll(context.Background(), db, month)
				if derr != nil {
					t.Fatalf("恢复后第 %d 轮 DispatchAll: %v", round+1, derr)
				}
				if ok != 1 || failed != 0 {
					t.Fatalf("恢复后第 %d 轮 ok=%d failed=%d, want 1/0 —— 改回合法期号后必须"+
						"**下一轮**就恢复（不能被上一档留下的 fail_streak/退避挡住）", round+1, ok, failed)
				}
			}
			t.Logf("READING %s 修库后累计投递 = %v（每期恰好一次、按序）", ancient, ledger.dump("ancient"))
			want := []string{"2026-05", "2026-06", "2026-07", "2026-08"}
			if got := ledger.dump("ancient"); strings.Join(got, ",") != strings.Join(want, ",") {
				t.Fatalf("合法历史欠投的补投序列 = %v, want %v —— 下界不得挡住正常的按序补齐，"+
					"且每期恰好一次", got, want)
			}
			sub, err := serverstore.GetReportSubscription(db, id)
			if err != nil {
				t.Fatal(err)
			}
			if sub.PendingPeriod != "" || sub.FailStreak != 0 || sub.LastError != "" {
				t.Fatalf("补齐到当前应投期之后: pending=%q fail_streak=%d last_error=%q, want 空/0/空",
					sub.PendingPeriod, sub.FailStreak, sub.LastError)
			}
		})
	}
}

// TestGenerationRangeFailureDoesNotAbortBatchNorBackoff 是 ④ 的端到端判据
// （**单编辑**即可变红：把生成失败退回 `return ok, failed, err`）。
//
// ## 怎么在真 PG 上真的把「生成」打红
//
// 期号由**调度时钟**算出来（正常路径 = `CurrentPeriod(clock)`），把时钟拨到公元 10001 年
// 2 月即可让 `CurrentPeriod` 产出五位数年号的期号 —— `parseBeijingPeriod`
// 的 layout `2006-01` 拒绝解析的期号。同一档的另一形态是 `0000-01`（Go 能解析、PG 表示
// 不了 ⇒ 聚合报 `SQLSTATE 22008`），它的**错误分类**由
// `TestPeriodUnusableErrorClassifiesRealPGErrors` 用真 PG 错误钉住；作为**外部写入的
// 游标**时它还会被分类层挡在更前面（见上一条用例）。两条路径合起来覆盖"期号越界类"。
//
// ## 见证为什么不是"同轮另一条订阅投递成功"
//
// 生成失败是**按期号**的（`GenerateMonthlyReportForPeriod` 只吃期号），同一轮里走正常路径
// 的订阅拿到的是**同一个**期号 ⇒ 它们必然一起失败；而只要存在一个能生成成功的期号，就
// 意味着"坏期号"不成立。所以"同轮另一条订阅投递成功"这种见证在本形态下**结构上不可达**
// （如实降级，不写成能杀死的判据）。
//
// 可用的见证是"**循环有没有继续走**"：id 更大的第二条订阅（这里用一条**形态非法游标**的
// 行，由分类层拦下并留痕）必须在**同一轮**被检视并留下痕迹 —— 这正是
// `return ok, failed, err` 会掐掉的那一段（旧形态停在第一条上，第二条的
// `last_error`/`fail_streak` 一个字都不会动），加上 `DispatchAll` 的返回错误必须为 nil。
func TestGenerationRangeFailureDoesNotAbortBatchNorBackoff(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	srv, ledger := newReportLedgerServer(t)

	bad, err := serverstore.CreateReportSubscription(db, "bad", srv.URL+"/bad", true)
	if err != nil {
		t.Fatal(err)
	}
	witness, err := serverstore.CreateReportSubscription(db, "witness", srv.URL+"/witness", true)
	if err != nil {
		t.Fatal(err)
	}
	// 见证订阅：形态非法的游标（外部写坏的形状）⇒ 分类层拦下 + 留痕，且**不会**走到生成期
	// （所以它不会与坏期号那条一起失败 —— 它是"循环继续走"的见证）。
	setPendingAndReset(t, db, witness, "2026-99")

	year10001 := bjAt(10001, 2, 15, 10)
	outOfRange := CurrentPeriod(year10001) // 五位数年份（Go 的 layout `2006` 只收 4 位）
	if _, err := parseBeijingPeriod(outOfRange); err == nil {
		t.Fatalf("夹具前提不成立: CurrentPeriod(公元 10001 年 2 月) = %q 竟然可解析", outOfRange)
	}

	ok, failed, derr := DispatchAll(context.Background(), db, year10001)
	if derr != nil {
		t.Fatalf("DispatchAll: %v —— 单条订阅的生成失败不得终止整批"+
			"（旧形态的 `return ok, failed, err` 会让这里拿到非 nil）", derr)
	}
	if ok != 0 || failed != 2 {
		t.Fatalf("ok=%d failed=%d, want 0/2 —— 坏期号那条 failed++ 之后循环必须继续，"+
			"让 id 更大的第二条订阅也被检视", ok, failed)
	}
	if got := ledger.dump("bad"); len(got) != 0 {
		t.Fatalf("越界期号投出了 %v —— 期号不可用时绝不能投递任何报表", got)
	}
	badSub, err := serverstore.GetReportSubscription(db, bad)
	if err != nil {
		t.Fatal(err)
	}
	if badSub.NextAttemptAt != nil {
		t.Fatalf("期号越界失败的 next_attempt_at = %v, want NULL —— 它属「改库值/改时钟即可恢复」档，"+
			"不该设退避（否则恢复轮会被自己设下的窗口挡住）", badSub.NextAttemptAt)
	}
	if badSub.PendingPeriod != "" {
		t.Fatalf("期号越界失败把 pending_period 钉成了 %q —— 不可用的期号不得被洗成「欠投游标」",
			badSub.PendingPeriod)
	}
	if !strings.Contains(badSub.LastError, outOfRange) {
		t.Fatalf("last_error = %q, want 含越界期号本体 %q 的可诊断原因", badSub.LastError, outOfRange)
	}
	// ★ 单编辑见证：id 更大的第二条订阅在**同一轮**被检视并留痕。
	witnessSub, err := serverstore.GetReportSubscription(db, witness)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(witnessSub.LastError, "2026-99") || witnessSub.FailStreak == 0 {
		t.Fatalf("同一轮里 id 更大的订阅零痕迹（last_error=%q fail_streak=%d）—— "+
			"说明循环在第一条生成失败处就跳出了整批（R22-V3-B1 的缺陷形态）",
			witnessSub.LastError, witnessSub.FailStreak)
	}

	// —— 恢复：时钟回到正常年份 ⇒ 坏的那条**下一轮**就投出去。
	// 若越界失败走了退避档，它设下的窗口落在公元 10001 年 ⇒ 这里会被挡住（本断言即变异判据）。——
	oct := bjAt(2026, 10, 15, 10)
	ok, failed, derr = DispatchAll(context.Background(), db, oct)
	if derr != nil {
		t.Fatalf("恢复轮 DispatchAll: %v", derr)
	}
	if ok != 1 || failed != 1 {
		t.Fatalf("恢复轮 ok=%d failed=%d, want 1/1（坏订阅投出 + 非法游标那条继续留痕）",
			ok, failed)
	}
	if got := ledger.dump("bad"); strings.Join(got, ",") != "2026-09" {
		t.Fatalf("恢复轮坏订阅投出 = %v, want [2026-09]（越界失败之后的**下一轮**就恢复）", got)
	}
}

// TestPeriodUnusableErrorClassifiesRealPGErrors 钉住错误分类器对**真实 PG 错误**的形状
// （不是构造出来的假错误）：`0000-01` 的聚合失败必须是 `periodUnusableError`。
//
// 为什么单独一条：上一条用例走的是**期号由时钟算出**的路径，若分类器认不出真错误，
// 它会退回"可恢复失败"档（设退避），而那条用例只断言"NULL"——分类器一改就会红。
// 这里直接读真错误的种类，失败信息能指到病根。
func TestPeriodUnusableErrorClassifiesRealPGErrors(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 表示不了 ⇒ 真 PG 报 22008。
	if _, err := GenerateMonthlyReportForPeriod(db, "0000-01"); err == nil {
		t.Fatal("夹具前提不成立：PG 表示不了公元 0 年，生成本该失败")
	} else if !periodUnusableError(err) {
		t.Fatalf("真 PG 的期号越界错误被判成「可恢复失败」（会设退避）: %v", err)
	}
	// 合法的古老期号（PG 表示得了）⇒ 生成成功，不是错误。
	if _, err := GenerateMonthlyReportForPeriod(db, "0001-01"); err != nil {
		t.Fatalf("0001-01 生成失败（夹具前提不成立）: %v", err)
	}
	// 依赖故障（表不存在）⇒ **不是**期号不可用档：它必须继续走可恢复失败（设退避）。
	if _, err := db.Exec(`ALTER TABLE usage_daily RENAME TO usage_daily_renamed_for_probe`); err != nil {
		t.Fatalf("制造依赖故障: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec(`ALTER TABLE usage_daily_renamed_for_probe RENAME TO usage_daily`) })
	if _, err := GenerateMonthlyReportForPeriod(db, "2026-07"); err == nil {
		t.Fatal("夹具前提不成立：usage_daily 已改名，生成本该失败")
	} else if periodUnusableError(err) {
		t.Fatalf("依赖故障被误判成「期号不可用」（会导致它不设退避、每 tick 重试）: %v", err)
	}
}

// TestSubscriptionReadsCarryCreatedAtForTheFloor 是下界的**接线判据**：
// 两个读点必须把 `created_at` 带进结构体，否则下界静默退化成"没有下界"
// （见 `pendingPeriodFloor` 的"零值行为"一节：零值 ⇒ 只保留数据模型区间那一层）。
func TestSubscriptionReadsCarryCreatedAtForTheFloor(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	id, err := serverstore.CreateReportSubscription(db, "wired", "https://hook.example/wired", true)
	if err != nil {
		t.Fatal(err)
	}
	one, err := serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if one.CreatedAt.IsZero() {
		t.Fatal("GetReportSubscription 没带 created_at ⇒ 游标下界静默失效")
	}
	list, err := serverstore.ListReportSubscriptions(db)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range list {
		if s.ID == id && s.CreatedAt.IsZero() {
			t.Fatal("ListReportSubscriptions 没带 created_at ⇒ 粗筛与调度路径的游标下界静默失效")
		}
	}
	if floor := pendingPeriodFloor(one.CreatedAt); floor == "" {
		t.Fatal("真实读回的 created_at 仍算不出下界")
	}
}
