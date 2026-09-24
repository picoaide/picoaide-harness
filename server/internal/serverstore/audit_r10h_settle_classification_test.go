package serverstore

// R10-H3 泳道 · **W3-1（P2）**：结算段/预补账的"整段总预算（ctx deadline）到点"
// 必须与 55P03/57014 **同类**（有界延后），而不是真失败。
//
// 缺陷形态（复审 W3 的实测，本波 N2② 引入的回归）：
//
//	`settleUsageReclaim` / `withUsageSettleBudget` 新增了"整段总上界"
//	（`context.WithTimeout`，含 COMMIT），而分类的唯一出口 `usageFailureTimeoutReason`
//	只认 SQLSTATE 55P03/57014 ⇒ 预算到点时错误形态是 `context deadline exceeded`，
//	或 database/sql 在 ctx 到点后把后续语句拒成的
//	`sql: transaction has already been committed or rolled back`（W3 在真库上抓到的
//	原文）⇒ `sqlstate=unknown` ⇒ `failures=1` + 整轮非 nil ⇒
//	  ① 管理端保存保留期回 500「保留清理失败」（配置其实已提交并已审计，正是
//	     R10-A-03 修掉的症状）；
//	  ② `/readyz.failed_rounds` 把"预算不够"记成故障，与"超时=延后 + 连续 5 轮升级"
//	     的意图相反；
//	  ③ 该形态**不自愈**（预算不随轮次变宽）⇒ 每一轮都失败。
//
// 本文件的判据：
//
//	H1 注入 `context.DeadlineExceeded`（W3 的 `TestW3F` 同形）⇒ 整轮必须走**延后**：
//	   err=nil / failures=0 / failed_rounds=0 / skipped_by_reason 出现
//	   `settle-budget-timeout` / 关系原样留着 / **金额仍可见**（预补账这根保险丝）。
//	H2 分类的**精度**：真实 ctx 到点的两种错误形态都算延后；而"ctx 没到点时的
//	   `sql.ErrTxDone`"必须仍然是真失败（fail-loud）—— 否则实现可以用一个宽判据
//	   把所有事务误用吞成"延后"。
//	H3 **真实** ctx 到点（不是注入错误值）：让归属复检在结算事务里睡过推导出来的
//	   总预算，走 W3 的 `TestW3F2` 同一条路径 ⇒ 同样必须是延后而不是失败。
//
// 复跑（真 PG）：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10h3 \
//	  go test ./internal/serverstore/ -run 'TestR10H1' -count=1 -v

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// r10hOrphanFixture 建"同名非分区表"孤儿（W3 的 W3-2/W3F 夹具同形）：
// 到期月有一个同名但**不是分区**的表 ⇒ 写路径的 ensureUsagePartition 会以
// `*partitionLayoutError`（stale detached table）失败，且它无法被 adopt 领回。
func r10hOrphanFixture(t *testing.T, db *sql.DB, uid int64) (rel string, expired time.Time) {
	t.Helper()
	expired = bjMonth(3)
	rel = "usage_" + monthKey(expired)
	if _, err := db.Exec("DROP TABLE IF EXISTS public." + quoteRelationIdent(rel)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE TABLE public." + quoteRelationIdent(rel) + " (LIKE usage INCLUDING DEFAULTS)"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(rel)+` (id, user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
        VALUES (990101, $1, 'r10h-w31', 10, 10, 'chat', 4.25, $2, FALSE)`, uid, BeijingDayAt(expired, 10)); err != nil {
		t.Fatal(err)
	}
	return rel, expired
}

// TestR10HW1SettleBudgetTimeoutIsDeferral 是 W3-1 的判据 ①（注入形态）。
func TestR10HW1SettleBudgetTimeoutIsDeferral(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	rel, expired := r10hOrphanFixture(t, db, uid)
	// 夹具自校准：孤儿表的行**不在** usage 的读面里（这正是"必须先补账"的理由）⇒
	// 判据在补账发生前必须是 0，否则"金额仍可见"这条断言会退化成恒真。
	wantMoney := 4.25
	if pre := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1)); pre != 0 {
		t.Fatalf("夹具不成立：孤儿表的行在补账前就可见（报表=%.4f）—— 判据会恒真", pre)
	}

	// 故障注入：只让**事务句柄**上的归属复检报"总预算到点"（池上的前置复检照常）。
	usageOwnershipProbeHook = func(q usageQuerier, gotRel string) error {
		if gotRel != rel {
			return nil
		}
		if _, isTx := q.(*sql.Tx); isTx {
			return context.DeadlineExceeded
		}
		return nil
	}
	t.Cleanup(func() { usageOwnershipProbeHook = nil })

	resetUsageRetentionStatusForTest()
	cerr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	gotMoney := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1))
	t.Logf("注入 ctx 到点：err=%v failures=%d failed_rounds=%d last_error=%q reasons=%v streak=%v 关系仍在=%v 报表=%.4f(want %.4f)",
		cerr, st.Failures, st.FailedRounds, st.LastError, st.SkippedByReason, st.DeferredStreak,
		r9aRelationExists(t, db, rel), gotMoney, wantMoney)

	if cerr != nil || st.Failures != 0 || st.FailedRounds != 0 || st.LastError != "" {
		t.Errorf("**总预算 ctx 到点**必须与 statement_timeout 同类（延后）：管理端保存保留期不得因此 500、"+
			"failed_rounds 不得增长（W3-1）；实得 err=%v failures=%d failed_rounds=%d last_error=%q",
			cerr, st.Failures, st.FailedRounds, st.LastError)
	}
	if st.SkippedByReason[usageSkipSettleBudgetTimeout] == 0 {
		t.Errorf("必须出现 %s 的延后计数（封闭取值，与 lock-timeout/statement-timeout 并列）: %v",
			usageSkipSettleBudgetTimeout, st.SkippedByReason)
	}
	if st.DeferredStreak[rel] != 1 {
		t.Errorf("延后必须进 deferred_streak（连续 N 轮升级为停摆告警的输入）: %v", st.DeferredStreak)
	}
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("延后必须一行数据都不动：%s 应当仍在盘上", rel)
	}
	if gotMoney < wantMoney-1e-9 {
		t.Errorf("预补账这根保险丝必须让金额仍然可见：报表 %.4f < want %.4f（补账前是 0）", gotMoney, wantMoney)
	}
}

// TestR10HW1BudgetErrorClassificationIsPrecise 是 W3-1 的判据 ②（分类精度）。
func TestR10HW1BudgetErrorClassificationIsPrecise(t *testing.T) {
	expiredCtx, cancel := context.WithTimeout(context.Background(), time.Nanosecond)
	defer cancel()
	time.Sleep(2 * time.Millisecond) // 让 ctx 真的到点

	txDone := fmt.Errorf("核对该月的分区树根: %w", sql.ErrTxDone) // 真库实测的原文形态
	cases := []struct {
		name string
		err  error
		want string // "" = 必须 fail-loud（不是超时）
	}{
		{"ctx.DeadlineExceeded（裸）", context.DeadlineExceeded, usageSkipSettleBudgetTimeout},
		{"ctx.DeadlineExceeded（包装）", fmt.Errorf("rebuild ledger: %w", context.DeadlineExceeded), usageSkipSettleBudgetTimeout},
		{"ctx.Canceled（包装）", fmt.Errorf("query: %w", context.Canceled), usageSkipSettleBudgetTimeout},
		{"总预算到点的真实形态（ctx 已到点 + TxDone）", usageBudgetError(expiredCtx, txDone), usageSkipSettleBudgetTimeout},
		{"ctx 未到点的 TxDone（真的事务误用）", usageBudgetError(context.Background(), txDone), ""},
		{"裸 TxDone（无 ctx 证据）", txDone, ""},
		{"55P03", &pgconn.PgError{Code: pgSQLStateLockNotAvailable, Message: "lock timeout"}, usageSkipLockTimeout},
		{"57014", &pgconn.PgError{Code: pgSQLStateQueryCanceled, Message: "statement timeout"}, usageSkipStatementTimeout},
		{"42P01（关系不存在）", &pgconn.PgError{Code: "42P01", Message: "undefined table"}, ""},
		{"普通错误", fmt.Errorf("catalog 读失败"), ""},
	}
	for _, tc := range cases {
		reason, ok := usageFailureTimeoutReason(tc.err)
		switch {
		case tc.want == "" && ok:
			t.Errorf("%s：被判成延后（%s），必须是真失败 fail-loud", tc.name, reason)
		case tc.want != "" && !ok:
			t.Errorf("%s：未被判成延后，want %s", tc.name, tc.want)
		case tc.want != "" && reason != tc.want:
			t.Errorf("%s：reason = %s，want %s", tc.name, reason, tc.want)
		}
	}
	// 哨兵本身必须可被 errors.Is 命中（分类靠它，不靠错误文本）。
	if !errors.Is(usageBudgetError(expiredCtx, txDone), errUsageSettleBudget) {
		t.Errorf("usageBudgetError 在 ctx 到点时必须打上 errUsageSettleBudget 标记")
	}
	if errors.Is(usageBudgetError(context.Background(), txDone), errUsageSettleBudget) {
		t.Errorf("ctx 未到点时不得打标记（否则真事务误用会被吞成延后）")
	}
}

// TestR10HW1RealSettleBudgetExpiryIsDeferral 是 W3-1 的判据 ③（**真实** ctx 到点，
// W3 的 `TestW3F2` 同一条路径）。
//
// 代价说明：结算段的下限预算是 30s（usageReclaimSettleFloorMS），所以这条用例要
// 真的睡过 30s —— 换来的是"不依赖注入错误值"的独立证据（注入只能证明分类函数，
// 证明不了真实错误形态）。W3 把它做成 opt-in，本泳道保留为默认（它是 P2 回归的
// 唯一生产路径证据）。
func TestR10HW1RealSettleBudgetExpiryIsDeferral(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	rel, expired := r10hOrphanFixture(t, db, uid)
	wantMoney := 4.25 // 见上一条用例的夹具自校准说明
	if pre := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1)); pre != 0 {
		t.Fatalf("夹具不成立：孤儿表的行在补账前就可见（报表=%.4f）", pre)
	}

	budget := usageReclaimBudgetForRelation(db, rel)
	usageOwnershipProbeHook = func(q usageQuerier, got string) error {
		if got == rel {
			if _, isTx := q.(*sql.Tx); isTx {
				t.Logf("在结算事务里睡 %dms（> 总预算 %dms）…", budget+1500, budget)
				time.Sleep(time.Duration(budget+1500) * time.Millisecond)
			}
		}
		return nil
	}
	t.Cleanup(func() { usageOwnershipProbeHook = nil })

	resetUsageRetentionStatusForTest()
	start := time.Now()
	cerr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	gotMoney := r6SumCost(t, db, dayKey(expired), dayKey(expired).AddDate(0, 1, -1))
	t.Logf("真实 ctx 到点：wall=%s err=%v failures=%d failed_rounds=%d failed_rels=%v reasons=%v last_error=%q 报表=%.4f(want %.4f)",
		time.Since(start).Round(time.Second), cerr, st.Failures, st.FailedRounds, st.FailedRelations,
		st.SkippedByReason, st.LastError, gotMoney, wantMoney)

	if cerr != nil || st.Failures != 0 || st.FailedRounds != 0 {
		t.Errorf("真实的总预算到点必须按延后分类（否则预算不够的月份**每轮都失败**、管理端保存保留期回 500）: "+
			"err=%v failures=%d last_error=%q", cerr, st.Failures, st.LastError)
	}
	if st.SkippedByReason[usageSkipSettleBudgetTimeout] == 0 {
		t.Errorf("真实 ctx 到点必须记进 %s: %v", usageSkipSettleBudgetTimeout, st.SkippedByReason)
	}
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("延后必须一行数据都不动：%s 应当仍在盘上", rel)
	}
	if gotMoney < wantMoney-1e-9 {
		t.Errorf("预补账必须让金额仍然可见：报表 %.4f < want %.4f（补账前是 0）", gotMoney, wantMoney)
	}
}
