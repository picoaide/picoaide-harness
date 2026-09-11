package serverstore

import (
	"errors"
	"testing"
	"time"
)

func newBalanceTestUser(t *testing.T, db interface {
	QueryRow(string, ...any) *sqlRowLike
}, name string) int64 {
	t.Helper()
	return 0
}

type sqlRowLike = interface{}

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

func TestAdjustUserBalance(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid, err := CreateUser(db, &User{Username: "bal-adjust", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}

	// 初次余额 0
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 0 {
		t.Fatalf("initial balance = %v", u.BalanceMoney)
	}
	// 增加
	next, err := AdjustUserBalance(db, uid, 100.555)
	if err != nil {
		t.Fatal(err)
	}
	if next != 100.56 { // 四舍五入到分
		t.Fatalf("after add = %v, want 100.56", next)
	}
	// 扣减
	next, err = AdjustUserBalance(db, uid, -30.56)
	if err != nil {
		t.Fatal(err)
	}
	if next != 70 {
		t.Fatalf("after deduct = %v, want 70", next)
	}
	// 超扣 → ErrValidation 且余额不变
	if _, err := AdjustUserBalance(db, uid, -1000); !errors.Is(err, ErrValidation) {
		t.Fatalf("over-deduct err = %v, want ErrValidation", err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 70 {
		t.Fatalf("balance changed after failed deduct = %v", u.BalanceMoney)
	}
	// set 覆盖
	next, err = SetUserBalance(db, uid, 12.345)
	if err != nil {
		t.Fatal(err)
	}
	if next != 12.35 {
		t.Fatalf("set = %v, want 12.35", next)
	}
	// 未知用户
	if _, err := AdjustUserBalance(db, 999999, 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user err = %v, want ErrNotFound", err)
	}
}

func TestGrantMonthlyBalanceAddCoverAndIdempotent(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()

	uid, err := CreateUser(db, &User{Username: "bal-grant-user", Role: RoleUser, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	adminID, err := CreateUser(db, &User{Username: "bal-grant-admin", Role: RoleSuperAdmin, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	disabledID, err := CreateUser(db, &User{Username: "bal-grant-off", Role: RoleUser, Source: "local", Status: 0})
	if err != nil {
		t.Fatal(err)
	}

	sep := time.Date(2026, 9, 15, 12, 0, 0, 0, time.UTC)
	g, granted, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "tester", sep)
	if err != nil {
		t.Fatal(err)
	}
	if !granted || g.Affected != 1 {
		t.Fatalf("grant = %+v granted=%v, want affected=1", g, granted)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 100 {
		t.Fatalf("user balance = %v, want 100", u.BalanceMoney)
	}
	// 管理员/禁用用户不发放
	if u, _ := GetUserByID(db, adminID); u.BalanceMoney != 0 {
		t.Fatalf("admin balance = %v, want 0", u.BalanceMoney)
	}
	if u, _ := GetUserByID(db, disabledID); u.BalanceMoney != 0 {
		t.Fatalf("disabled balance = %v, want 0", u.BalanceMoney)
	}
	// 幂等:同月第二次不发放
	g2, granted2, err := GrantMonthlyBalance(db, BalanceModeAdd, 100, "tester", sep)
	if err != nil {
		t.Fatal(err)
	}
	if granted2 {
		t.Fatalf("second grant should be no-op: %+v", g2)
	}
	if g2 == nil || g2.Month != "202609" {
		t.Fatalf("existing grant = %+v", g2)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 100 {
		t.Fatalf("idempotent grant changed balance = %v", u.BalanceMoney)
	}
	// 下月 cover:重置为固定额度
	oct := time.Date(2026, 10, 2, 1, 0, 0, 0, time.UTC)
	g3, granted3, err := GrantMonthlyBalance(db, BalanceModeCover, 30, "tester", oct)
	if err != nil || !granted3 {
		t.Fatalf("cover grant = %+v granted=%v err=%v", g3, granted3, err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 30 {
		t.Fatalf("cover balance = %v, want 30", u.BalanceMoney)
	}
	// 下月 add:累加
	nov := time.Date(2026, 11, 2, 1, 0, 0, 0, time.UTC)
	if _, granted, err := GrantMonthlyBalance(db, BalanceModeAdd, 5, "tester", nov); err != nil || !granted {
		t.Fatalf("add grant err=%v granted=%v", err, granted)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 35 {
		t.Fatalf("add balance = %v, want 35", u.BalanceMoney)
	}
	// 额度 <= 0 拒绝
	if _, _, err := GrantMonthlyBalance(db, BalanceModeAdd, 0, "tester", sep); !errors.Is(err, ErrValidation) {
		t.Fatalf("zero amount err = %v", err)
	}
}

func TestUsageDeductsBalance(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "bal-model", 1, 1) // 1 元 / 100 万 token
	// 复核修正(F8):只有闸门开启时消费才扣余额。
	if err := SaveBalanceSettings(db, BalanceSettings{Enabled: true, MonthlyAmount: 0, MonthlyMode: BalanceModeAdd}); err != nil {
		t.Fatal(err)
	}

	// 充值 10 元
	if _, err := SetUserBalance(db, uid, 10); err != nil {
		t.Fatal(err)
	}
	// 非流式落账 1000+500 token:cost = 0.001+0.0005 = 0.0015
	if _, err := RecordUsage(db, uid, "bal-model", 1000, 500); err != nil {
		t.Fatal(err)
	}
	var cost0 float64
	if err := db.QueryRow("SELECT COALESCE(SUM(cost),0) FROM usage WHERE user_id = ?", uid).Scan(&cost0); err != nil {
		t.Fatal(err)
	}
	t.Logf("sum cost = %v balance-read = %v", cost0, func() float64 { uu, _ := GetUserByID(db, uid); return uu.BalanceMoney }())
	u, _ := GetUserByID(db, uid)
	if want := 10 - 0.0015; u.BalanceMoney < want-1e-6 || u.BalanceMoney > want+1e-6 {
		t.Fatalf("balance after usage = %v, want %v", u.BalanceMoney, want)
	}
	// 流式 pending 回填:先 0 cost,回填后按差额扣一次
	pend, err := RecordUsage(db, uid, "bal-model", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := GetUserByID(db, uid)
	if err := UpdateUsageTokens(db, pend, 1000, 0); err != nil {
		t.Fatal(err)
	}
	after, _ := GetUserByID(db, uid)
	if after.BalanceMoney >= before.BalanceMoney {
		t.Fatalf("backfill did not deduct: before=%v after=%v", before.BalanceMoney, after.BalanceMoney)
	}
	// 重复回填(同值)不再扣
	if err := UpdateUsageTokens(db, pend, 1000, 0); err != nil {
		t.Fatal(err)
	}
	again, _ := GetUserByID(db, uid)
	if again.BalanceMoney != after.BalanceMoney {
		t.Fatalf("idempotent backfill deducted again: %v -> %v", after.BalanceMoney, again.BalanceMoney)
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
// 通过环检测(A.parent=B 后 B.parent=A 形成环),网关配额热路径会死循环。
func TestUpdateDepartmentInvalidatesTreeForCycleCheck(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	// 先填充缓存(模拟真实流量里已发生的读取)。
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

// 复核修正(F8,F10 高视角):未启用余额闸门时消费不扣余额 —— 否则默认关闭
// 数周后首次启用闸门,全员会被历史消费扣成负余额并一次性全部拦截。
func TestBalanceNotDeductedWhenDisabled(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "bal-off-model", 1, 1)

	if _, err := SetUserBalance(db, uid, 10); err != nil {
		t.Fatal(err)
	}
	// 未启用:消费不扣
	if _, err := RecordUsage(db, uid, "bal-off-model", 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	if u, _ := GetUserByID(db, uid); u.BalanceMoney != 10 {
		t.Fatalf("disabled billing changed balance = %v, want 10", u.BalanceMoney)
	}
	// 启用后:消费扣减
	if err := SaveBalanceSettings(db, BalanceSettings{Enabled: true, MonthlyAmount: 0, MonthlyMode: BalanceModeAdd}); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, uid, "bal-off-model", 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	u, _ := GetUserByID(db, uid)
	if want := 9.0; u.BalanceMoney < want-1e-6 || u.BalanceMoney > want+1e-6 {
		t.Fatalf("enabled billing balance = %v, want %v", u.BalanceMoney, want)
	}
}
