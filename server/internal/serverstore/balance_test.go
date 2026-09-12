package serverstore

import (
	"database/sql"
	"errors"
	"math"
	"sync"
	"testing"
	"time"
)

func TestBalanceSettingsRoundtrip(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	s, err := GetBalanceSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if s.Enabled || s.MonthlyAmount != 0 || s.MonthlyMode != BalanceModeAdd {
		t.Fatalf("defaults = %+v", s)
	}
	if err := SaveBalanceSettings(db, BalanceSettings{Enabled: true, MonthlyAmount: 88.5, MonthlyMode: BalanceModeCover}); err != nil {
		t.Fatal(err)
	}
	s, err = GetBalanceSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if !s.Enabled || s.MonthlyAmount != 88.5 || s.MonthlyMode != BalanceModeCover {
		t.Fatalf("roundtrip = %+v", s)
	}
}

// mustBalanceUser 建一个普通员工并返回 id。
func mustBalanceUser(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// assertLedgerInvariant 断言 I1:余额 == 流水合计(账本唯一真源)。
func assertLedgerInvariant(t *testing.T, db *sql.DB, uid int64) {
	t.Helper()
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	sum, err := BalanceLedgerSum(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-roundMicro(sum)) > 1e-9 {
		t.Fatalf("I1 违反: balance=%v ledger_sum=%v", u.BalanceMoney, sum)
	}
}

func TestAdjustUserBalance(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := mustBalanceUser(t, db, "bal-adjust")

	// 初次余额 0 且未开通
	u0, _ := GetUserByID(db, uid)
	if u0.BalanceMoney != 0 || !u0.BalanceActivatedAt.IsZero() {
		t.Fatalf("initial = %v activated=%v, want 0 / 未开通", u0.BalanceMoney, u0.BalanceActivatedAt)
	}
	// 增加(入账即开通)
	next, err := AdjustUserBalance(db, uid, 100.555, "充值", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if next != 100.56 { // 四舍五入到分
		t.Fatalf("after add = %v, want 100.56", next)
	}
	u1, _ := GetUserByID(db, uid)
	if u1.BalanceActivatedAt.IsZero() {
		t.Fatal("首次入账必须置开通位")
	}
	assertLedgerInvariant(t, db, uid)

	// 扣减
	next, err = AdjustUserBalance(db, uid, -30.56, "", "admin")
	if err != nil {
		t.Fatal(err)
	}
	if next != 70 {
		t.Fatalf("after deduct = %v, want 70", next)
	}
	// 扣减超过展示余额 → ErrValidation(防误输),余额不变
	if _, err := AdjustUserBalance(db, uid, -1000, "", "admin"); !errors.Is(err, ErrValidation) {
		t.Fatalf("over-deduct err = %v, want ErrValidation", err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 70 {
		t.Fatalf("balance changed after failed deduct = %v", u.BalanceMoney)
	}
	// set:允许 0(清零),此前服务端一律拒绝 amount<=0 → 界面「设为 0」必然失败
	if next, err = SetUserBalance(db, uid, 0, "清零", "admin"); err != nil || next != 0 {
		t.Fatalf("set 0 = %v err=%v, want 0/nil", next, err)
	}
	if next, err = SetUserBalance(db, uid, 12.345, "", "admin"); err != nil || next != 12.35 {
		t.Fatalf("set 12.345 = %v err=%v", next, err)
	}
	if _, err := AdjustUserBalance(db, 999999, 1, "", "admin"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing user err = %v, want ErrNotFound", err)
	}
	assertLedgerInvariant(t, db, uid)
}

// 残值清零:微元记账 + 分位展示的历史死角 —— 余额 0.004(显示 ¥0.00)时
// 扣 0.01 会被拒,但 set 0 必须把它清干净。
func TestClearSubCentResidue(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := mustBalanceUser(t, db, "bal-residue")
	if _, err := SetUserBalance(db, uid, 0.004, "", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := AdjustUserBalance(db, uid, -0.01, "", "admin"); !errors.Is(err, ErrValidation) {
		t.Fatalf("deduct 0.01 from 0.004 = %v, want ErrValidation", err)
	}
	next, err := SetUserBalance(db, uid, 0, "清零", "admin")
	if err != nil || next != 0 {
		t.Fatalf("clear residue = %v err=%v, want 0/nil", next, err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 0 {
		t.Fatalf("residue not cleared: %v", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, uid)
}

// 逐人·月锚:add 发放幂等、跨月再发、新员工被下一轮补齐(不再"月中入职没额度")。
func TestGrantMonthlyBalancePerUserAndBackfill(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	u1 := mustBalanceUser(t, db, "grant-a")
	u2 := mustBalanceUser(t, db, "grant-b")
	adminID := mustBalanceUser(t, db, "grant-admin")
	admin, _ := GetUserByID(db, adminID)
	admin.Role = RoleSuperAdmin
	admin.IsAdmin = true
	if err := UpdateUser(db, admin); err != nil {
		t.Fatal(err)
	}
	disabled := mustBalanceUser(t, db, "grant-disabled")
	if _, err := db.Exec(`UPDATE users SET status = 0 WHERE id = ?`, disabled); err != nil {
		t.Fatal(err)
	}

	sep := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	run, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "tester", sep, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run.Granted != 2 || run.Month != "202609" {
		t.Fatalf("run = %+v, want granted=2 month=202609", run)
	}
	if u, _ := GetUserByID(db, u1); u.BalanceMoney != 100 {
		t.Fatalf("u1 = %v, want 100", u.BalanceMoney)
	}
	if u, _ := GetUserByID(db, u2); u.BalanceMoney != 100 {
		t.Fatalf("u2 = %v, want 100", u.BalanceMoney)
	}
	if u, _ := GetUserByID(db, adminID); u.BalanceMoney != 0 {
		t.Fatalf("admin = %v, want 0(管理员豁免发放)", u.BalanceMoney)
	}
	if u, _ := GetUserByID(db, disabled); u.BalanceMoney != 0 {
		t.Fatalf("disabled = %v, want 0", u.BalanceMoney)
	}
	// 幂等:同一月再次全体发放 → 无可发对象
	run2, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "tester", sep, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run2.Granted != 0 || run2.Skipped != 2 {
		t.Fatalf("second run = %+v, want granted=0 skipped=2", run2)
	}
	if u, _ := GetUserByID(db, u1); u.BalanceMoney != 100 {
		t.Fatalf("idempotent grant changed balance = %v", u.BalanceMoney)
	}
	// 月中新入职:下一轮自动补齐(这是 0061 单月锚做不到的)
	newbie := mustBalanceUser(t, db, "grant-newbie")
	run3, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "", sep, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run3.Granted != 1 {
		t.Fatalf("backfill run = %+v, want granted=1", run3)
	}
	if u, _ := GetUserByID(db, newbie); u.BalanceMoney != 100 {
		t.Fatalf("newbie = %v, want 100", u.BalanceMoney)
	}
	// 单用户补发(新建/启用即时发放)
	run4, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "", sep, u1)
	if err != nil {
		t.Fatal(err)
	}
	if run4.Granted != 0 || run4.Skipped != 1 {
		t.Fatalf("single-user rerun = %+v, want granted=0 skipped=1", run4)
	}
	// 跨月
	oct := time.Date(2026, 10, 1, 0, 30, 0, 0, time.UTC)
	run5, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "", oct, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run5.Granted != 3 {
		t.Fatalf("oct run = %+v, want granted=3", run5)
	}
	if u, _ := GetUserByID(db, u1); u.BalanceMoney != 200 {
		t.Fatalf("u1 after oct = %v, want 200", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, u1)
	assertLedgerInvariant(t, db, u2)
	assertLedgerInvariant(t, db, newbie)
}

// cover:清零差额必须记 reset 流水(手工充值被抹掉这件事在账本里可见),
// 且余额恰好等于额度。
func TestCoverModeRecordsReset(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := mustBalanceUser(t, db, "cover-user")
	if _, err := AdjustUserBalance(db, uid, 500, "手工充值", "admin"); err != nil {
		t.Fatal(err)
	}
	sep := time.Date(2026, 9, 5, 3, 0, 0, 0, time.UTC)
	if _, err := GrantMonthlyBalance(db, BalanceModeCover, 100, "tester", sep, 0); err != nil {
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 100 {
		t.Fatalf("cover balance = %v, want 100", u.BalanceMoney)
	}
	items, total, err := BalanceLedgerPage(db, uid, "", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 { // adjust +500 / reset -500 / grant +100
		t.Fatalf("ledger entries = %d (%+v), want 3", total, items)
	}
	var sawReset bool
	for _, e := range items {
		if e.Kind == LedgerKindReset && e.Amount == -500 {
			sawReset = true
		}
	}
	if !sawReset {
		t.Fatalf("cover 未记录清零流水(手工充值被静默抹掉): %+v", items)
	}
	assertLedgerInvariant(t, db, uid)
}

// 消费扣减:已开通用户**无论闸门开关**都扣(闸门只决定拦不拦),
// 未开通用户不扣不记(I5)。
func TestUsageDeductsActivatedBalanceOnly(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "bal-model2", 1, 1)

	activated := mustBalanceUser(t, db, "bal-on")
	untouched := mustBalanceUser(t, db, "bal-off")
	if _, err := SetUserBalance(db, activated, 10, "", "admin"); err != nil {
		t.Fatal(err)
	}
	// 闸门关闭(默认):已开通用户照扣
	if _, err := RecordUsage(db, activated, "bal-model2", 1_000_000, 0); err != nil { // 1 元
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, activated); math.Abs(u.BalanceMoney-9) > 1e-9 {
		t.Fatalf("activated balance = %v, want 9", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, activated)
	// 未开通用户:不扣不记
	if _, err := RecordUsage(db, untouched, "bal-model2", 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, untouched); u.BalanceMoney != 0 {
		t.Fatalf("未开通用户被扣款 = %v", u.BalanceMoney)
	}
	if sum, _ := BalanceLedgerSum(db, untouched); sum != 0 {
		t.Fatalf("未开通用户产生流水 = %v", sum)
	}
}

// 流式回填按差额结算:重复回填不重复扣,费用下调自动记 refund 回补。
func TestUsageBackfillDeltaAndRefund(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "bal-model3", 1, 1)
	uid := mustBalanceUser(t, db, "bal-backfill")
	if _, err := SetUserBalance(db, uid, 10, "", "admin"); err != nil {
		t.Fatal(err)
	}
	pend, err := RecordUsage(db, uid, "bal-model3", 0, 0) // pending, cost 0
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); err != nil { // 1 元
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, uid); math.Abs(u.BalanceMoney-9) > 1e-9 {
		t.Fatalf("after backfill = %v, want 9", u.BalanceMoney)
	}
	// 重复回填同一结果:不再扣
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, uid); math.Abs(u.BalanceMoney-9) > 1e-9 {
		t.Fatalf("重复回填重复扣款: %v, want 9", u.BalanceMoney)
	}
	// 向下修正(估算回填 100 万 → 真实 50 万):回补 0.5 元
	if err := UpdateUsageTokens(db, pend, 500_000, 0); err != nil {
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, uid); math.Abs(u.BalanceMoney-9.5) > 1e-9 {
		t.Fatalf("费用下调未回补: %v, want 9.5", u.BalanceMoney)
	}
	items, _, err := BalanceLedgerPage(db, uid, "", 1, 20)
	if err != nil {
		t.Fatal(err)
	}
	var refunds int
	for _, e := range items {
		if e.Kind == LedgerKindRefund {
			refunds++
		}
	}
	if refunds != 1 {
		t.Fatalf("refund 流水 = %d (%+v), want 1", refunds, items)
	}
	assertLedgerInvariant(t, db, uid)
}

// P0-B(审计 2026-09-12):上游负 token 不得变成 refund(凭空充值)。
// 负 token 走进 costOfAt 会算出负费用,结算侧 delta = -cost > 0 → refund →
// balance_money 增加;账本不变量 I1 仍自洽,事后审计看不出来。
func TestNegativeTokensDoNotRefund(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "neg-model", 1, 1) // 1 元/1M:负 token 会算出 -1 元
	uid := mustBalanceUser(t, db, "neg-token-user")
	if _, err := SetUserBalance(db, uid, 1, "充值", "admin"); err != nil {
		t.Fatal(err)
	}

	// 1) 一次落账路径(非流式 chat / embedding)
	if _, err := RecordUsageKind(db, uid, "neg-model", -1_000_000, -1_000_000, "chat"); err != nil {
		t.Fatalf("RecordUsageKind(负 token): %v", err)
	}
	// 2) pending 行 + 负 token 回填(流式 chat / Anthropic messages)
	pend, err := RecordUsage(db, uid, "neg-model", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, -1_000_000, -1_000_000); err != nil {
		t.Fatalf("UpdateUsageTokens(负 token): %v", err)
	}

	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-1) > 1e-9 {
		t.Fatalf("负 token 凭空充值: balance = %v, want 1", u.BalanceMoney)
	}
	items, _, err := BalanceLedgerPage(db, uid, "", 1, 50)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range items {
		if e.Kind == LedgerKindRefund {
			t.Fatalf("负 token 产生 refund 流水: %+v", e)
		}
	}
	// 负 token 也不得落库污染月用量/报表,cost 不得为负(负 cost 是 refund 的源头)
	var pt, ct int64
	var cost float64
	if err := db.QueryRow(`SELECT prompt_tokens, completion_tokens, cost FROM usage WHERE id = ?`, pend).
		Scan(&pt, &ct, &cost); err != nil {
		t.Fatal(err)
	}
	if pt < 0 || ct < 0 || cost < 0 {
		t.Fatalf("usage 落库为负: pt=%d ct=%d cost=%v", pt, ct, cost)
	}
	assertLedgerInvariant(t, db, uid)
}

// P0-C(审计 2026-09-12):并发消费不得透支余额。
// 旧实现 `UPDATE ... balance_money + delta` 无下限:8 笔 1.00 消耗 + 1.00 余额
// → balance_money = -7.00。修法要求「余额不足 → 回滚整个事务」(usage 行与
// 扣款同事务),并与「未开通账户」区分开。
func TestConcurrentUsageCannotOverdraft(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "od-model", 1, 1) // 1_000_000 tokens = 1 元
	uid := mustBalanceUser(t, db, "od-user")
	if _, err := SetUserBalance(db, uid, 1, "充值", "admin"); err != nil {
		t.Fatal(err)
	}

	const attempts = 8
	var wg sync.WaitGroup
	errs := make([]error, attempts)
	start := make(chan struct{})
	for i := 0; i < attempts; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, errs[i] = RecordUsage(db, uid, "od-model", 1_000_000, 0)
		}(i)
	}
	close(start)
	wg.Wait()

	var ok, insufficient int
	for i, err := range errs {
		switch {
		case err == nil:
			ok++
		case errors.Is(err, ErrInsufficientBalance):
			insufficient++
		default:
			t.Fatalf("第 %d 笔返回意外错误: %v", i, err)
		}
	}
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u.BalanceMoney < -1e-9 {
		t.Fatalf("并发透支: balance = %v(1.00 余额消费了 %d 笔 1.00)", u.BalanceMoney, attempts)
	}
	if ok != 1 || insufficient != attempts-1 {
		t.Fatalf("成功 %d / 余额不足 %d, want 1 / %d", ok, insufficient, attempts-1)
	}
	// 回滚语义:失败的那几笔不得留下 usage 行(否则就是"记了账没扣钱")
	var rows int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE user_id = ?`, uid).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != int64(ok) {
		t.Fatalf("usage 行 = %d, want %d(余额不足必须回滚整个事务)", rows, ok)
	}
	if math.Abs(u.BalanceMoney) > 1e-9 {
		t.Fatalf("余额 = %v, want 0", u.BalanceMoney)
	}
	assertLedgerInvariant(t, db, uid)

	// 未开通账户(余额 0 + 有费用)语义是"不扣不记",不得被当成余额不足。
	off := mustBalanceUser(t, db, "od-off-user")
	if _, err := RecordUsage(db, off, "od-model", 1_000_000, 0); err != nil {
		t.Fatalf("未开通账户被误判为余额不足: %v", err)
	}
	if sum, _ := BalanceLedgerSum(db, off); sum != 0 {
		t.Fatalf("未开通账户产生流水 = %v", sum)
	}
}

// P0-C 回填路径(流式估算回填):结算超出余额时同样报错并回滚 ——
// 已写入的 token/cost 回填必须一起撤销,余额不得变动。
func TestBackfillCannotOverdraft(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "bf-model", 1, 1)
	uid := mustBalanceUser(t, db, "bf-user")
	if _, err := SetUserBalance(db, uid, 0.5, "", "admin"); err != nil {
		t.Fatal(err)
	}
	pend, err := RecordUsage(db, uid, "bf-model", 0, 0) // pending,cost 0
	if err != nil {
		t.Fatal(err)
	}
	// 回填 1 元 > 余额 0.5 元 → 余额不足
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); !errors.Is(err, ErrInsufficientBalance) {
		t.Fatalf("err = %v, want ErrInsufficientBalance", err)
	}
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-0.5) > 1e-9 {
		t.Fatalf("余额 = %v, want 0.5", u.BalanceMoney)
	}
	// 整个事务回滚:回填的 token/cost 不得留下(否则 usage 与余额不一致)
	var pt int64
	var cost float64
	if err := db.QueryRow(`SELECT prompt_tokens, cost FROM usage WHERE id = ?`, pend).Scan(&pt, &cost); err != nil {
		t.Fatal(err)
	}
	if pt != 0 || cost != 0 {
		t.Fatalf("回填未回滚: pt=%d cost=%v", pt, cost)
	}
	assertLedgerInvariant(t, db, uid)
}

// 下限只约束**扣减**:历史欠款账户(修复前透支遗留的负余额)的费用下调
// 回补(refund)不能被下限卡住,否则账目永远回不到 0。
func TestRefundStillAppliesOnLegacyNegativeBalance(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustPricedModel(t, db, "rf-model", 1, 1)
	uid := mustBalanceUser(t, db, "rf-user")
	if _, err := SetUserBalance(db, uid, 10, "", "admin"); err != nil {
		t.Fatal(err)
	}
	pend, err := RecordUsage(db, uid, "rf-model", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, 1_000_000, 0); err != nil { // 扣 1 元
		t.Fatal(err)
	}
	// 模拟修复前遗留的透支余额(生产库可能存在欠款账户)
	if _, err := db.Exec(`UPDATE users SET balance_money = -5 WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}
	if err := UpdateUsageTokens(db, pend, 500_000, 0); err != nil { // 费用下调 → 回补 0.5
		t.Fatalf("欠款账户回补被下限卡住: %v", err)
	}
	u, err := GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(u.BalanceMoney-(-4.5)) > 1e-9 {
		t.Fatalf("余额 = %v, want -4.5(负差额回补必须生效)", u.BalanceMoney)
	}
	// 欠款状态下新的消费仍被拒绝(不得继续加深欠款)
	if _, err := RecordUsage(db, uid, "rf-model", 1_000_000, 0); !errors.Is(err, ErrInsufficientBalance) {
		t.Fatalf("欠款账户继续消费: err = %v, want ErrInsufficientBalance", err)
	}
}

// 闸门判定:已开通 + 分位余额 <= 0 → 拦;未开通 → 不拦;闸门关 → 不拦。
func TestBalanceBlocked(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := mustBalanceUser(t, db, "gate-user")
	u, _ := GetUserByID(db, uid)

	// 闸门关闭:即使余额 0 也不拦
	if blocked, _ := BalanceBlocked(db, u); blocked {
		t.Fatal("闸门关闭时不应拦截")
	}
	if err := SaveBalanceSettings(db, BalanceSettings{Enabled: true}); err != nil {
		t.Fatal(err)
	}
	// 未开通:不拦
	if blocked, _ := BalanceBlocked(db, u); blocked {
		t.Fatal("未开通余额账户不应被余额闸门拦截")
	}
	// 开通后余额 0 → 拦
	if _, err := SetUserBalance(db, uid, 1, "", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := SetUserBalance(db, uid, 0, "", "admin"); err != nil {
		t.Fatal(err)
	}
	u, _ = GetUserByID(db, uid)
	if blocked, _ := BalanceBlocked(db, u); !blocked {
		t.Fatal("已开通且余额为 0 应拦截")
	}
	// 残值 0.004(展示 ¥0.00)→ 分位口径下同样拦
	if _, err := db.Exec(`UPDATE users SET balance_money = 0.004 WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}
	u, _ = GetUserByID(db, uid)
	if blocked, _ := BalanceBlocked(db, u); !blocked {
		t.Fatal("余额 0.004(显示 ¥0.00)应与展示一致地被拦截")
	}
	// 0.006(展示 ¥0.01)→ 放行
	if _, err := db.Exec(`UPDATE users SET balance_money = 0.006 WHERE id = ?`, uid); err != nil {
		t.Fatal(err)
	}
	u, _ = GetUserByID(db, uid)
	if blocked, _ := BalanceBlocked(db, u); blocked {
		t.Fatal("余额 0.006(显示 ¥0.01)不应被拦截")
	}
}

func TestBalanceEmptyDatabaseGrant(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	now := time.Date(2026, 9, 1, 1, 0, 0, 0, time.UTC)
	run, err := GrantMonthlyBalance(db, BalanceModeAdd, 50, "", now, 0)
	if err != nil {
		t.Fatal(err)
	}
	if run.Granted != 0 || run.Month != "202609" {
		t.Fatalf("empty run = %+v", run)
	}
	if _, err := GrantMonthlyBalance(db, BalanceModeAdd, 0, "", now, 0); !errors.Is(err, ErrValidation) {
		t.Fatalf("amount 0 err = %v, want ErrValidation", err)
	}
}

func TestSubtreeGroupIDsCycleGuard(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	// 直接构造 A↔B 环(绕过 UpdateDepartment 的环检测),验证热路径不死循环。
	var aID, bID int64
	if err := db.QueryRow(`INSERT INTO groups (name, parent_id) VALUES ('cyc-a', 0) RETURNING id`).Scan(&aID); err != nil {
		t.Skipf("no PG: %v", err)
	}
	if err := db.QueryRow(`INSERT INTO groups (name, parent_id) VALUES ('cyc-b', ?) RETURNING id`, aID).Scan(&bID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE groups SET parent_id = ? WHERE id = ?`, bID, aID); err != nil {
		t.Fatal(err)
	}
	InvalidateGroupTree()
	done := make(chan []int64, 1)
	go func() {
		ids, _ := subtreeGroupIDs(db, aID)
		done <- ids
	}()
	select {
	case ids := <-done:
		if len(ids) != 2 {
			t.Fatalf("cycle ids = %v, want A+B only", ids)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("subtreeGroupIDs hung on a cycle (F3 regression)")
	}
}

func TestPreOrderNodesForest(t *testing.T) {
	nodes := []groupNode{{id: 1, parent: 0}, {id: 2, parent: 0}, {id: 3, parent: 1}, {id: 4, parent: 2}}
	got := preOrderNodes(nodes)
	if len(got) != 4 {
		t.Fatalf("forest preorder = %v, want all 4 nodes", got)
	}
	if got[0].id != 1 || got[1].id != 3 || got[2].id != 2 || got[3].id != 4 {
		t.Fatalf("forest order = %+v", got)
	}
	// 环:2→1→2,不应死循环
	cyc := []groupNode{{id: 1, parent: 2}, {id: 2, parent: 1}, {id: 3, parent: 0}}
	if got := preOrderNodes(cyc); len(got) > 3 {
		t.Fatalf("cycle preorder = %+v", got)
	}
}

// F3 回归:部门更新后必须失效组织树缓存,否则第二次 reparent 会基于旧树
// 通过环检测(A.parent=B 后 B.parent=A 形成环)。
func TestUpdateDepartmentInvalidatesTreeForCycleCheck(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	InvalidateGroupTree()
	if _, err := loadGroupTree(db); err != nil {
		t.Fatal(err)
	}
	var aID, bID int64
	if err := db.QueryRow(`INSERT INTO groups (name, parent_id) VALUES ('cyc-x', 0) RETURNING id`).Scan(&aID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`INSERT INTO groups (name, parent_id) VALUES ('cyc-y', 0) RETURNING id`).Scan(&bID); err != nil {
		t.Fatal(err)
	}
	// A → B(合法)
	if err := UpdateDepartment(db, aID, "cyc-x", bID, 0, ""); err != nil {
		t.Fatalf("first reparent: %v", err)
	}
	// B → A 必须被环检测拒绝(F3 前:缓存仍是旧树,检测不到 A 已是 B 的子)
	if err := UpdateDepartment(db, bID, "cyc-y", aID, 0, ""); !errors.Is(err, ErrValidation) {
		t.Fatalf("cycle reparent err = %v, want ErrValidation", err)
	}
}

// F9 回归(复核):用户维度授权必须与用户名字大小写口径一致。
func TestGrantUserCaseInsensitive(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	if _, err := CreateUser(db, &User{Username: "Alice", Source: "local", Status: 1}); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "demo-skill", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	names, err := AccessibleSkillNames(db, "Alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "demo-skill" {
		t.Fatalf("case-insensitive user grant = %v, want [demo-skill]", names)
	}
	// 反向:授权存 "Bob" → 查询 "bob" 也命中。
	if _, err := CreateUser(db, &User{Username: "bob", Source: "local", Status: 1}); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "other-skill", "Bob", GranteeUser); err != nil {
		t.Fatal(err)
	}
	names2, _ := AccessibleSkillNames(db, "bob", nil)
	if len(names2) != 1 || names2[0] != "other-skill" {
		t.Fatalf("reverse case-insensitive grant = %v, want [other-skill]", names2)
	}
}
