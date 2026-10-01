package reports

// R22-V3-B1（复审 2026-09-26，**P2**）/ B2（P3）的端到端判据（真 PG）：
// **外部写坏的 `pending_period` 只能影响它自己那一条订阅**。
//
// ## 缺陷形态（判据要杀的东西）
//
// `pending_period` 由产品自身只写 `CurrentPeriod` 与它的后继，但它**存在库里** ⇒ 外部
// （SQL 手改、半份备份恢复、旧格式遗留）可以写进任意字符串，而它是投递路径的唯一游标。
// 修前有两处独立的坏后果（都在真 PG 上实测复现）：
//
//	① 形态非法（`2026-99`）：`GenerateMonthlyReportForPeriod` 解析失败，而那一行的失败是
//	   `return ok, failed, err` —— **跳出整个候选循环** ⇒ 一条坏行让**全部订阅**停投，
//	   且每一轮都停在这一条上 ⇒ 不修库就不自愈（实测：健康订阅连续 5 轮 0 笔、
//	   `fail_streak=0`、`last_error=''`，即从未被尝试）。
//	② 未来期号（形态合法但晚于当前应投期）：被当成合法期号**真的投出去**一份未来月的
//	   空报表，随后 `nextPendingAfterDelivery` 对"比当前应投期新"的期号一律清空游标
//	   ⇒ 真正欠投的那几期被永久跳过（实测：`pending=2026-10` 时投出 `[2026-10]`，
//	   2026-08 及其之前一次没投）。
//
// ## 修后契约（本用例钉住的三条）
//
//	① 坏行在场时健康订阅**照常投递**（3 轮里每期恰好一次、按序补齐），且 `DispatchAll`
//	   不再整轮报错；坏行自己 `failed` + `last_error` 留痕（可诊断），游标原样不动。
//	② 未来期号**不产出空报表**：投出的是正常路径算出来的当前应投期，且它本身不落库。
//	③ **恢复路径 = 修好库值后下一轮自愈**：不设退避（`next_attempt_at` 保持 NULL）、
//	   不需要重启 —— 判据直接断言"下一轮就投出来"。未来期号那一格由**时间**收敛：
//	   它被忽略期间照常按月投，等它变成"当前应投期"时被正常兑现并收口（判据③）。
//
// ## 变异（必须变红，实跑对照见 temp/r21/fix-16/REPORT.md）
//
//   - 生成失败退回 `return ok, failed, err` + `SubscriptionDuePeriod` 退回"非空即欠投"
//     ⇒ ① 的第一条断言红（第 1 轮就整轮报错、健康订阅 3 轮 0 笔）；
//   - 未来期号退回"当合法期号投"⇒ ② 红（投出的是 `future` 而不是 `cur`）。

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// deliveryLedger 是 webhook 接收方的账本：按**订阅名**分开记（hook 路径区分订阅），
// 这样"哪一条订阅投了哪一期"可以直接断言，而不必靠猜先后顺序。
type deliveryLedger struct {
	mu    sync.Mutex
	bySub map[string][]string
}

func (l *deliveryLedger) record(sub, period string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.bySub[sub] = append(l.bySub[sub], period)
}

func (l *deliveryLedger) dump(sub string) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string{}, l.bySub[sub]...)
}

// reset 清空账本（对照轮与判据轮之间要分开记账）。
func (l *deliveryLedger) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.bySub = map[string][]string{}
}

// newReportLedgerServer 起一个"永远 200"的假 webhook 接收器，订阅名 = URL 路径。
func newReportLedgerServer(t *testing.T) (*httptest.Server, *deliveryLedger) {
	t.Helper()
	led := &deliveryLedger{bySub: map[string][]string{}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body ReportBody
		_ = json.NewDecoder(r.Body).Decode(&body)
		led.record(strings.TrimPrefix(r.URL.Path, "/"), body.Period)
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(srv.Close)
	return srv, led
}

// pinSubscriptionCreatedAt 把订阅的 `created_at` 钉到指定时刻。
//
// 为什么用例必须做这一步（R23-V3-B1 新增的游标下界带来的**夹具约束**）：
// `pending_period` 的下界是 `CurrentPeriod(created_at)`（见 delivery_policy.go 的
// `pendingPeriodFloor`）。用例用**注入时钟**把"部署时间"拨到过去，而
// `CreateReportSubscription` 写的是**真实墙钟**的 created_at（2026-09-26）⇒ 产品在注入
// 时钟下写出的合法游标（如 2026-06）反而"早于订阅创建"，那是**夹具的人造偏差**：
// 真实部署里订阅不可能在未来创建却欠着过去的期。与 `alignLastRunToClock` 同一处置
// （让库里的时间与注入时钟一致），不是对产品行为的放宽。
//
// 实现已提到 `reports_test.go`（与 `createSubscriptionAt` 同处，本包共用）。

// setPendingAndReset 把订阅置成"启用 + 欠 period 这一期 + 从未成功投递 + 无退避"。
//
// 同时把 `created_at` 钉到**该期的下一月**（下界 == period，闭区间的最紧合法夹具）：
// 种子游标只可能由"订阅已存在"的那一期写出，所以这不放宽任何判据，只是把夹具摆成
// 一个物理上可能的部署（细节见 pinSubscriptionCreatedAt）。
// 形态非法的种子值（`2026-99`）算不出"下一月" ⇒ 钉到一个远早的固定时刻，
// 让那一档继续按**形态**判死（判定顺序里形态在最前，与下界无关）。
func setPendingAndReset(t *testing.T, db *sql.DB, id int64, period string) {
	t.Helper()
	if _, err := db.Exec(`UPDATE report_subscriptions
		SET enabled=1, pending_period=$1, last_run_at=NULL, last_error='', fail_streak=0, next_attempt_at=NULL
		WHERE id=$2`, period, id); err != nil {
		t.Fatalf("设置订阅 %d 的游标 %q: %v", id, period, err)
	}
	seedCreatedAt := any(time.Date(2000, 1, 15, 0, 0, 0, 0, time.UTC))
	if month, err := parseBeijingPeriod(periodAfter(period)); err == nil {
		seedCreatedAt = month.AddDate(0, 0, 14) // 下一月的 15 日 ⇒ 下界恰好 == period
	}
	pinSubscriptionCreatedAt(t, db, id, seedCreatedAt)
}

// alignLastRunToClock 把"最后一次成功时刻"对齐到注入时钟。
//
// 生产里 `last_run_at` 由 SQL `now()`（真实墙钟）写入，而本用例用注入时钟表达月份;
// 不对齐会让 `ShouldRunMonthly` 拿**真实月份**去比注入月份 —— 那是判据自身的人造偏差，
// 不是产品行为（与 report_multimonth_catchup_test.go 的同名处置一致）。
func alignLastRunToClock(t *testing.T, db *sql.DB, at any) {
	t.Helper()
	if _, err := db.Exec(`UPDATE report_subscriptions SET last_run_at=$1 WHERE last_run_at IS NOT NULL`, at); err != nil {
		t.Fatalf("对齐 last_run_at: %v", err)
	}
}

// TestCorruptedPendingPeriodDoesNotBlockOtherSubscriptions 是 ① 的端到端判据。
func TestCorruptedPendingPeriodDoesNotBlockOtherSubscriptions(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	srv, ledger := newReportLedgerServer(t)

	bad, err := serverstore.CreateReportSubscription(db, "bad", srv.URL+"/bad", true)
	if err != nil {
		t.Fatal(err)
	}
	good, err := serverstore.CreateReportSubscription(db, "good", srv.URL+"/good", true)
	if err != nil {
		t.Fatal(err)
	}
	month := bjAt(2026, 9, 15, 10) // CurrentPeriod(month) = 2026-08
	if cur := CurrentPeriod(month); cur != "2026-08" {
		t.Fatalf("夹具前提不成立: CurrentPeriod = %q, want 2026-08", cur)
	}

	// 健康订阅：欠 2026-06/07/08 三期（用它自己的游标表达）。
	setPendingAndReset(t, db, good, "2026-06")
	// 坏行：**形态非法**的期号（外部 SQL 手改 / 半份备份恢复的形状）。
	setPendingAndReset(t, db, bad, "2026-99")

	// —— 对照轮：先禁用坏行，证明健康订阅本来是能投的（判据的前提成立）。——
	if _, err := db.Exec(`UPDATE report_subscriptions SET enabled=0 WHERE id=$1`, bad); err != nil {
		t.Fatal(err)
	}
	ok, failed, derr := DispatchAll(context.Background(), db, month)
	if derr != nil {
		t.Fatalf("对照轮 DispatchAll: %v", derr)
	}
	if ok != 1 || failed != 0 {
		t.Fatalf("对照轮 ok=%d failed=%d, want 1/0", ok, failed)
	}
	if got := ledger.dump("good"); strings.Join(got, ",") != "2026-06" {
		t.Fatalf("对照轮健康订阅投出 = %v, want [2026-06]", got)
	}
	alignLastRunToClock(t, db, month)
	ledger.reset() // 对照轮与判据轮分开记账

	// —— 判据：坏行在场（启用 + 写坏）时连跑 3 轮。——
	setPendingAndReset(t, db, good, "2026-06")
	setPendingAndReset(t, db, bad, "2026-99")
	for round := 1; round <= 3; round++ {
		ok, failed, derr = DispatchAll(context.Background(), db, month)
		if derr != nil {
			t.Fatalf("第 %d 轮 DispatchAll 整轮报错: %v —— 一条坏行不得终止整批（R22-V3-B1）", round, derr)
		}
		if ok != 1 || failed != 1 {
			t.Fatalf("第 %d 轮 ok=%d failed=%d, want 1/1 —— 健康订阅照常投、坏行记 failed 且只影响它自己",
				round, ok, failed)
		}
		alignLastRunToClock(t, db, month)
	}
	if got, want := strings.Join(ledger.dump("good"), ","), "2026-06,2026-07,2026-08"; got != want {
		t.Fatalf("坏行在场时健康订阅累计投递 = [%s], want [%s] —— 每期恰好一次、按序补齐", got, want)
	}
	if got := ledger.dump("bad"); len(got) != 0 {
		t.Fatalf("坏行投出了 %v —— 形态非法的期号绝不能被当成合法期号生成/投递", got)
	}

	// 坏行自己的可诊断性：last_error 留痕（failed 计数在上面逐轮断言），游标原样不动
	// （不可信的值必须留着等人工修，不得被静默改写/清空）。
	badSub, err := serverstore.GetReportSubscription(db, bad)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(badSub.LastError, "2026-99") {
		t.Fatalf("坏行的 last_error = %q, want 含 %q 的可诊断原因", badSub.LastError, "2026-99")
	}
	if badSub.PendingPeriod != "2026-99" {
		t.Fatalf("坏行的 pending_period = %q, want 原样保留 2026-99（不可信的值不得被静默改写）",
			badSub.PendingPeriod)
	}
	if badSub.FailStreak == 0 {
		t.Fatalf("坏行的 fail_streak = 0 —— 每一轮记一次失败，计数必须动")
	}
	// 健康订阅完全没被波及（这正是修复前失效的那一半）。
	goodSub, err := serverstore.GetReportSubscription(db, good)
	if err != nil {
		t.Fatal(err)
	}
	if goodSub.FailStreak != 0 || goodSub.LastError != "" {
		t.Fatalf("健康订阅被坏行波及: fail_streak=%d last_error=%q", goodSub.FailStreak, goodSub.LastError)
	}

	// —— 恢复路径：人工修好那一格 ⇒ **下一轮**自动恢复投递（不设退避、不需要重启）。——
	if _, err := db.Exec(`UPDATE report_subscriptions SET pending_period='2026-06' WHERE id=$1`, bad); err != nil {
		t.Fatal(err)
	}
	ok, failed, derr = DispatchAll(context.Background(), db, month)
	if derr != nil {
		t.Fatalf("修好后的下一轮 DispatchAll: %v", derr)
	}
	if ok != 1 || failed != 0 {
		t.Fatalf("修好后 ok=%d failed=%d, want 1/0 —— 坏行必须在下一轮自愈", ok, failed)
	}
	if got := ledger.dump("bad"); strings.Join(got, ",") != "2026-06" {
		t.Fatalf("修好后的下一轮坏行投出 = %v, want [2026-06] —— 恢复路径必须落在**下一轮**"+
			"（不能因为记了 fail_streak 就被退避窗口挡住）", got)
	}
	if got := ledger.dump("good"); len(got) != 3 {
		t.Fatalf("恢复轮里健康订阅又被投了一次（累计 %v）—— 游标推进语义被破坏", got)
	}
}

// TestFuturePendingPeriodDoesNotDeliverPhantomReport 是 ② 的端到端判据。
func TestFuturePendingPeriodDoesNotDeliverPhantomReport(t *testing.T) {
	allowLocalWebhooks(t)
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	srv, ledger := newReportLedgerServer(t)

	id, err := serverstore.CreateReportSubscription(db, "future", srv.URL+"/future", true)
	if err != nil {
		t.Fatal(err)
	}
	month := bjAt(2026, 9, 15, 10)
	cur := CurrentPeriod(month)             // 2026-08：真正欠投的那一期
	future := periodAfter(periodAfter(cur)) // 2026-10：外部写进来的未来期号
	if cur != "2026-08" || future != "2026-10" {
		t.Fatalf("夹具前提不成立: cur=%q future=%q, want 2026-08 / 2026-10", cur, future)
	}
	setPendingAndReset(t, db, id, future)

	// ① "本月已投过"这一形态下本轮不投，但**必须留原因**（可诊断，不静默）。
	if _, err := db.Exec(`UPDATE report_subscriptions SET last_run_at=$1 WHERE id=$2`, month, id); err != nil {
		t.Fatal(err)
	}
	ok, failed, derr := DispatchAll(context.Background(), db, month)
	if derr != nil {
		t.Fatalf("未来期号 + 本月已投过：DispatchAll: %v", derr)
	}
	// 不投（本月的正常投递已完成），但**算作本轮失败**：这是"库里有不可信值"的可观测面
	// （调度器状态表 + 订阅列表的 last_error），静默通过才是缺陷。
	if ok != 0 || failed != 1 {
		t.Fatalf("未来期号 + 本月已投过：ok=%d failed=%d, want 0/1（不投但必须记一次失败）", ok, failed)
	}
	if got := ledger.dump("future"); len(got) != 0 {
		t.Fatalf("未来期号被投出 %v —— 外部写入的期号不得产出报表", got)
	}
	sub, err := serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(sub.LastError, future) {
		t.Fatalf("last_error = %q, want 含未来期号 %q 的可诊断原因（异常必须留痕）", sub.LastError, future)
	}

	// ② 从未成功投递 ⇒ 未来期号被**忽略**，正常路径补投 cur（恰好一次），且它本身不落库。
	if _, err := db.Exec(`UPDATE report_subscriptions SET last_run_at=NULL WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	for round := 1; round <= 4; round++ {
		ok, failed, derr = DispatchAll(context.Background(), db, month)
		if derr != nil {
			t.Fatalf("第 %d 轮 DispatchAll: %v", round, derr)
		}
		t.Logf("9 月第 %d 轮 ok=%d failed=%d delivered=%v", round, ok, failed, ledger.dump("future"))
		if ok > 1 {
			t.Fatalf("第 %d 轮投出 %d 笔（want ≤1）—— 同一期不得重投", round, ok)
		}
		alignLastRunToClock(t, db, month)
	}
	got := ledger.dump("future")
	if strings.Join(got, ",") != cur {
		t.Fatalf("未来期号在场时的投出序列 = %v, want [%s] —— 必须补投**当前应投期**，"+
			"而不是把外部写入的未来期号投出去（那既是一份不存在的月份的空报表，"+
			"又会把真正欠投的期号永久跳过）", got, cur)
	}
	for _, p := range got {
		if p == future {
			t.Fatalf("投出了未来期号 %s —— 未来期号必须被当成不可信输入", future)
		}
	}
	sub, err = serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	// 不可信的那一格**不被静默改写**：`MarkReportDeliveredOn` 的 CASE 谓词只在
	// "投出的正是游标那一期"时动它（这是防另一个实例改游标的护栏，不得为了自愈拆掉）。
	if sub.PendingPeriod != future {
		t.Fatalf("pending_period = %q, want 原样保留 %q（不可信的值由人工修；"+
			"产品不得静默清空一个它没有投过的期号）", sub.PendingPeriod, future)
	}

	// ③ 时间往后走：未来期号被忽略（继续走正常路径），**等它变成"当前应投期"时被正常
	//    兑现**，随即清空 ⇒ 与正常月度节奏收敛，不跳期也不重投。
	//
	//    这一条把"外部写坏的期号会不会永久污染投递序列"从注释里的一句分析，变成可执行事实：
	//    修前（把未来期号当合法期号投 + 清空游标）这里会出现**幽灵期号 + 重复投递**。
	for _, clock := range []time.Time{bjAt(2026, 10, 15, 10), bjAt(2026, 11, 15, 10)} {
		ok, failed, derr = DispatchAll(context.Background(), db, clock)
		if derr != nil {
			t.Fatalf("tick %s DispatchAll: %v", clock.Format("2006-01"), derr)
		}
		if ok != 1 || failed != 0 {
			t.Fatalf("tick %s ok=%d failed=%d, want 1/0（每个月恰有一期："+
				"外部写坏的那一格不得让某个月多投或漏投）", clock.Format("2006-01"), ok, failed)
		}
		alignLastRunToClock(t, db, clock)
	}
	if got, want := strings.Join(ledger.dump("future"), ","), "2026-08,2026-09,2026-10"; got != want {
		t.Fatalf("跨 3 个月的投出序列 = [%s], want [%s] —— 未来期号必须收敛到正常月度节奏"+
			"（出现重复 = 幽灵期号又投了一遍；缺一期 = 被那次外部写入永久跳过）", got, want)
	}
	sub, err = serverstore.GetReportSubscription(db, id)
	if err != nil {
		t.Fatal(err)
	}
	if sub.PendingPeriod != "" {
		t.Fatalf("收敛之后 pending_period = %q, want 空（投到该期时游标自然收口）", sub.PendingPeriod)
	}
}

// TestPendingPeriodDiagnosticIsAlwaysStorable 钉住异常文案的**可落库性**（本条的收尾细节）。
//
// 缺陷形态：文案里回显的 `pending_period` 是**外部可控的任意字符串**，而
// `SanitizeReportError` 超长时做的是 `msg[:200]` 硬切字节 —— 切断多字节字符后 PG 的
// text 列会以 `invalid byte sequence for encoding "UTF8"` **拒绝整条 UPDATE** ⇒
// "记原因"这条承诺对超长/畸形输入静默失效（只剩日志）。
//
// 判据：任意 pending 取值下，文案都必须 ①非空 ②合法 UTF-8 ③经过
// `SanitizeReportError` 后**逐字节不变**（= 未触发它的 200 字节硬切，也保证
// "同一条值只写一次"的去重比较可判）。
func TestPendingPeriodDiagnosticIsAlwaysStorable(t *testing.T) {
	now := bjAt(2026, 9, 15, 10)
	cases := map[string]string{
		"短形态非法":       "2026-99",
		"超长多字节":       strings.Repeat("测", 200),
		"超长单字节":       strings.Repeat("x", 500),
		"合法前缀 + 超长垃圾": "2026-12" + strings.Repeat("测", 100),
		"非法 UTF-8 字节": "\xff\xfe",
	}
	for name, pending := range cases {
		_, _, anomaly := SubscriptionDuePeriod(now,
			serverstore.ReportSubscription{Enabled: true, PendingPeriod: pending})
		if anomaly == "" {
			t.Fatalf("%s: 不可信的 pending_period(%d 字节) 没有给出原因", name, len(pending))
		}
		if !utf8.ValidString(anomaly) {
			t.Fatalf("%s: 诊断文案不是合法 UTF-8（长度截断切断了多字节字符）", name)
		}
		if len(anomaly) > 190 {
			t.Fatalf("%s: 文案 %d 字节 > 190 —— 会撞上 SanitizeReportError 的 200 字节硬切",
				name, len(anomaly))
		}
		if got := serverstore.SanitizeReportError(anomaly); got != anomaly {
			t.Fatalf("%s: SanitizeReportError 改写了文案（去重比较会失真）", name)
		}
	}
}
