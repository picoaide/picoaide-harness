package serverstore

// R11-I4 · R11A-01（P1）回归：金额窗口的**算定**与**使用**必须在同一个持锁区间内。
//
// 被审形态（origin/master @ 3264137997）：
//
//	补账窗口在**冻结之前**由主循环算定（retentionLedgerWindow → detailMonthsOutside
//	→ shape.ReclaimWindow），而冻结（DETACH）在预补账的整窗口聚合之后才发生；
//	结算段的归属复检与补账都在持锁之后，但**窗口本身没有重算**。
//	⇒ 在 [窗口算定, 冻结] 之间**提交**、且 created_at 的北京日落在窗口之外的计量行，
//	预补账与结算段两次聚合都读不到它，却随 `DROP TABLE` 一起消失 —— 明细与永久账本
//	**双失**，而该轮 `err=nil / cleared=5 / skipped=0 / failures=0`、`/readyz` 全绿。
//
// 触发条件（生产可达）：被回收关系的**声明边界宽于其名义月且覆盖当月**（DBA 预建的
// 季度/年度分区，r7 srvbill-3 明确判为合法配置），且扫描时刻**当月还没有行**
// （每北京月第一次写入之前）。
//
// 本用例的判据与审计探针**逐字同源**（金额与账本行，不是日志文本）：
//
//	已提交金额 == 明细余额 + 永久账本（usage_daily / usage_monthly）
//	⇒ 差额即 SILENT_LOSS，必须为 0.00。
//
// 对照组（同一夹具、不注入交错）证明"判据不是夹具一建就红"。
//
// 复跑：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/<db> \
//	  go test ./internal/serverstore/ -run 'TestR11I4' -count=1 -v

import (
	"database/sql"
	"fmt"
	"math"
	"testing"
	"time"
)

// i4MonthLedgerCost 读某个北京月在永久账本（usage_daily）里的行数与金额合计。
func i4MonthLedgerCost(t *testing.T, db *sql.DB, month time.Time) (int64, float64) {
	t.Helper()
	start := dayKey(BeijingMonth(month))
	end := start.AddDate(0, 1, 0)
	var rows int64
	var cost float64
	if err := db.QueryRow(`SELECT count(*), COALESCE(SUM(cost),0) FROM usage_daily
		WHERE day >= ?::date AND day < ?::date`, start.Format(dateFmt), end.Format(dateFmt)).Scan(&rows, &cost); err != nil {
		t.Fatalf("读 %s 的日账: %v", monthKey(month), err)
	}
	return rows, cost
}

// i4DetailCost 读某北京日窗口里**还留在明细**的金额（直读父表）。
func i4DetailCost(t *testing.T, db *sql.DB, from, to time.Time) float64 {
	t.Helper()
	var cost float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage
		WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		dayStartArg(from), dayEndArgInclusive(to)).Scan(&cost); err != nil {
		t.Fatalf("读明细金额: %v", err)
	}
	return cost
}

// i4WidePartitionFixture 造"声明边界宽于名义月、且覆盖当月"的宽分区夹具（真 PG）。
//
// 名义月取 `bjMonth(4)`（早已到期），分区名仍是 `usage_<名义月>`，而它的声明边界
// 是 [名义月首日, 当月+2 月首日)。
func i4WidePartitionFixture(t *testing.T, db *sql.DB, nominal time.Time) (rel string, uid int64) {
	t.Helper()
	rel = "usage_" + monthKey(nominal)
	uid = mustUserID(t, db)
	for m := nominal; !m.After(BeijingMonth(time.Now()).AddDate(0, 7, 0)); m = m.AddDate(0, 1, 0) {
		_, _ = db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent("usage_"+monthKey(m)))
		if _, err := db.Exec("DROP TABLE IF EXISTS " + quoteRelationIdent("usage_"+monthKey(m))); err != nil {
			t.Fatalf("drop %s: %v", monthKey(m), err)
		}
	}
	lo := BeijingDayInstant(dayKey(nominal))
	hi := BeijingDayInstant(dayKey(BeijingMonth(time.Now()).AddDate(0, 2, 0)))
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(rel), lo.Format(pgInstantFmt), hi.Format(pgInstantFmt))); err != nil {
		t.Fatalf("建宽分区 %s: %v", rel, err)
	}
	return rel, uid
}

// TestR11I4WindowOutsideAggregateIsLedgered 是本条的主判据。
func TestR11I4WindowOutsideAggregateIsLedgered(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	for _, stmt := range []string{
		"TRUNCATE TABLE usage RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_daily RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_monthly RESTART IDENTITY CASCADE",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatal(err)
		}
	}
	// retention=2 ⇒ cutoff = bjMonth(2)；名义月取 bjMonth(4)（早已到期）。
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	nominal := bjMonth(4)
	rel, uid := i4WidePartitionFixture(t, db, nominal)

	// 名义月里的一行（属于**窗口内**，必须被回收前的补账收录）。
	const seedCost = 10.0
	seedID := usageRowAt(t, db, uid, "r11i4-wide", BeijingDayAt(nominal, 10), seedCost)
	if got := r6PartitionOf(t, db, seedID); got != rel {
		t.Fatalf("夹具无效：种子行落在 %s，want %s", got, rel)
	}

	// 交错点 = 预补账之前的归属探测（usageReclaimPreBackfill → usageOwnershipOf）：
	// 此刻**窗口已经算完**、冻结还没发生。从另一条连接提交一条**当月**的计量行。
	now := time.Now()
	const lateCost = 7.0
	var lateID int64
	hookFired := 0
	side, err := sql.Open("pgx", r10f4DSNFor(r10gCurDB(t, db)))
	if err != nil {
		t.Fatalf("开旁路连接: %v", err)
	}
	defer side.Close()
	usageOwnershipProbeHook = func(q usageQuerier, probeRel string) error {
		if probeRel != rel || hookFired > 0 {
			return nil
		}
		hookFired++
		if err := side.QueryRow(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
			VALUES ($1,$2,1000,500,'chat',$3,$4,false) RETURNING id`,
			uid, "r11i4-wide", lateCost, now.UTC()).Scan(&lateID); err != nil {
			t.Errorf("交错写入失败: %v", err)
			return nil
		}
		t.Logf("交错点：窗内种子行=%d(%.2f)，窗口外当月行=%d(%.2f) 已提交 @%s",
			seedID, seedCost, lateID, lateCost, now.UTC().Format(time.RFC3339))
		return nil
	}
	t.Cleanup(func() { usageOwnershipProbeHook = nil })

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理返回错误（本用例关注的不是失败面，而是静默丢失）: %v", err)
	}
	if hookFired == 0 {
		t.Fatalf("交错点没有触发：%s 没有走 attached 回收路径（夹具无效）", rel)
	}

	// ---- 判据：金额与账本行 ----
	today := BeijingDay(time.Now())
	detailNow := i4DetailCost(t, db, today, today)
	ledgerRowsNow, ledgerNow := i4MonthLedgerCost(t, db, BeijingMonth(time.Now()))
	ledgerRowsNom, ledgerNom := i4MonthLedgerCost(t, db, nominal)
	committed := seedCost + lateCost
	conserved := detailNow + ledgerNow + ledgerNom
	st := CurrentUsageRetentionStatus()
	t.Logf("看板：已提交=%.4f | 当月明细余额=%.4f | 当月账本 rows=%d cost=%.4f | 名义月账本 rows=%d cost=%.4f",
		committed, detailNow, ledgerRowsNow, ledgerNow, ledgerRowsNom, ledgerNom)
	t.Logf("轮次看板：rounds=%d failed=%d cleared_partitions=%d cleared_detached=%d skipped=%d failures=%d deferred=%v unreclaimed=%v",
		st.RoundNumber, st.FailedRounds, st.ClearedPartitions, st.ClearedDetached, st.Skipped, st.Failures,
		st.DeferredRelations, st.Unreclaimed)
	if !r9aRelationExists(t, db, rel) {
		t.Logf("（预期）宽分区 %s 已在补账之后被回收", rel)
	}
	loss := committed - conserved
	if math.Abs(loss) > 1e-9 {
		t.Fatalf("SILENT_LOSS=%.4f：窗口算定与冻结之间提交的当月计量行（%.4f）既没进账本、也已随 %s 被 DROP；"+
			"committed=%.4f detail_now=%.4f ledger_now=%.4f ledger_nominal=%.4f（R11A-01：窗口必须在这个持锁区间里重算）",
			loss, lateCost, rel, committed, detailNow, ledgerNow, ledgerNom)
	}
	// 金额必须落在**当月账本**里（不是被算进名义月，也不是留在明细）。
	if math.Abs(ledgerNow-lateCost) > 1e-9 {
		t.Errorf("当月账本金额=%.4f，want %.4f（窗口外的行必须被持锁重算出来的窗口覆盖）", ledgerNow, lateCost)
	}
}

// TestR11I4ControlNoInterleaveKeepsMoney 是对照组：同样夹具、同样的宽分区被回收，
// 但**不注入**交错写入 ⇒ 窗内金额必须完整留在账本里（证明上面的判据不是"夹具一建
// 就红"）。
func TestR11I4ControlNoInterleaveKeepsMoney(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	nominal := bjMonth(4)
	rel, uid := i4WidePartitionFixture(t, db, nominal)
	_ = rel
	const seedCost = 10.0
	usageRowAt(t, db, uid, "r11i4-wide", BeijingDayAt(nominal, 10), seedCost)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	rows, cost := i4MonthLedgerCost(t, db, nominal)
	if rows == 0 || math.Abs(cost-seedCost) > 1e-9 {
		t.Fatalf("对照组：名义月账本 rows=%d cost=%.4f，want rows>0 cost=%.4f", rows, cost, seedCost)
	}
	t.Logf("对照组：名义月账本 rows=%d cost=%.4f（宽分区已被回收、金额完整）", rows, cost)
}
