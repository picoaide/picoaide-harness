package serverstore

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

func newUsageDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	db, cleanup := newTestDB(t)
	return db, cleanup
}

func mustUserID(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: "u" + fmt.Sprint(time.Now().UnixNano()), Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// setCreatedAt backdates a usage row so day aggregation is deterministic.
// 分区表:string 日期回填到历史月份时,必须确保目标月分区存在
// (分区键 created_at 的 UPDATE 路由要求分区存在)。
func setCreatedAt(t *testing.T, db *sql.DB, id int64, ts string) {
	t.Helper()
	if tm, err := time.Parse("2006-01-02 15:04:05", ts); err == nil {
		if err := ensureUsagePartition(db, tm); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", ts, id); err != nil {
		t.Fatal(err)
	}
}

func TestRecordUsageReturnsID(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, err := RecordUsage(db, uid, "deepseek-chat", 10, 5)
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("expected non-zero row id")
	}

	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestUpdateUsageTokens(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)
	if err := UpdateUsageTokens(db, id, 42, 7); err != nil {
		t.Fatal(err)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 42 || ct != 7 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestCleanupPendingUsage(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)     // zero tokens
	keptPending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0) // zero tokens, recent
	complete, _ := RecordUsage(db, uid, "deepseek-chat", 10, 5)   // has tokens, old
	setCreatedAt(t, db, pending, "2026-07-01 09:00:00")
	setCreatedAt(t, db, keptPending, "2026-08-02 09:00:00")
	setCreatedAt(t, db, complete, "2026-07-01 09:00:00")

	cutoff := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	if err := CleanupPendingUsage(db, cutoff); err != nil {
		t.Fatal(err)
	}

	for _, id := range []int64{pending} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("pending row %d not cleaned", id)
		}
	}
	for _, id := range []int64{keptPending, complete} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("row %d wrongly cleaned", id)
		}
	}
}

func TestUsageAggregateEmptyReturnsNonNil(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if rows == nil {
		t.Fatal("UsageAggregate returned nil slice on empty table (must be [] for JSON)")
	}
}

// TestUserMonthlyUsage: only current-calendar-month rows count; pending
// (zero-token) rows and prior-month rows are excluded.
func TestUserMonthlyUsage(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	thisMonth := monthStart(time.Now()).AddDate(0, 0, 5)
	lastMonth := monthStart(time.Now()).AddDate(0, -1, 15)

	for _, ts := range []time.Time{thisMonth, thisMonth, lastMonth} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts.Format(pgTimeFmt))
	}
	// pending row this month must not count
	pending, _ := RecordUsage(db, uid, "m", 0, 0)
	setCreatedAt(t, db, pending, thisMonth.Format(pgTimeFmt))

	total, err := UserMonthlyUsage(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if total != 30 { // 2 × (10+5), last-month and pending excluded
		t.Fatalf("monthly usage = %d, want 30", total)
	}
}

func TestUserMonthlyUsageBatch(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	a := mustUserID(t, db)
	b := mustUserID(t, db)
	thisMonth := monthStart(time.Now()).AddDate(0, 0, 5)

	id, _ := RecordUsage(db, a, "m", 10, 5)
	setCreatedAt(t, db, id, thisMonth.Format(pgTimeFmt))
	id, _ = RecordUsage(db, a, "m", 2, 0)
	setCreatedAt(t, db, id, thisMonth.Format(pgTimeFmt))
	id, _ = RecordUsage(db, b, "m", 7, 7)
	setCreatedAt(t, db, id, thisMonth.Format(pgTimeFmt))

	got, err := UserMonthlyUsageBatch(db, []int64{a, b})
	if err != nil {
		t.Fatal(err)
	}
	if got[a] != 17 || got[b] != 14 {
		t.Fatalf("batch = %v, want a=17 b=14", got)
	}
	if len(got) != 2 {
		t.Fatalf("batch returned %d entries, want 2", len(got))
	}
	// empty input → empty map, no error
	empty, err := UserMonthlyUsageBatch(db, nil)
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty batch = %v err=%v", empty, err)
	}
}

// TestEffectiveQuota: admin exempt; per-user override wins; else global
// default; missing/invalid global setting → unlimited.
func TestEffectiveQuota(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()

	adminID := mustUserID(t, db)
	u, _ := GetUserByID(db, adminID)
	u.IsAdmin = true
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}

	uid := mustUserID(t, db)
	uu, _ := GetUserByID(db, uid)

	// no global setting, no override → unlimited
	if q, err := EffectiveQuota(db, uu); err != nil || q != 0 {
		t.Fatalf("default quota = %d err=%v, want 0 (unlimited)", q, err)
	}
	// admin always unlimited
	if q, err := EffectiveQuota(db, u); err != nil || q != 0 {
		t.Fatalf("admin quota = %d err=%v, want 0", q, err)
	}
	// global default
	if err := SetSetting(db, MonthlyQuotaSetting, "5000"); err != nil {
		t.Fatal(err)
	}
	if q, _ := EffectiveQuota(db, uu); q != 5000 {
		t.Fatalf("global default quota = %d, want 5000", q)
	}
	// invalid global value → unlimited
	if err := SetSetting(db, MonthlyQuotaSetting, "abc"); err != nil {
		t.Fatal(err)
	}
	if q, _ := EffectiveQuota(db, uu); q != 0 {
		t.Fatalf("invalid global quota = %d, want 0", q)
	}
	// per-user override wins over global
	if err := SetSetting(db, MonthlyQuotaSetting, "5000"); err != nil {
		t.Fatal(err)
	}
	qq := int64(300)
	uu.QuotaTokens = &qq
	if q, _ := EffectiveQuota(db, uu); q != 300 {
		t.Fatalf("override quota = %d, want 300", q)
	}
	// admin with explicit low quota is still unlimited
	uu2, _ := GetUserByID(db, adminID)
	qq = 1
	uu2.QuotaTokens = &qq
	if q, _ := EffectiveQuota(db, uu2); q != 0 {
		t.Fatalf("admin override quota = %d, want 0 (exempt)", q)
	}
}

// TestUsageAggregateUserJoinsUsername: group=user labels the username (from
// the users table), falling back to the numeric id for deleted users.
func TestUsageAggregateUserJoinsUsername(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	rowID, err := RecordUsage(db, uid, "m", 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, rowID, "2026-08-10 09:00:00")

	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "user")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user rows = %+v, want label alice", rows)
	}

	// date range + user group must not hit an ambiguous created_at (users
	// table also has created_at after the LEFT JOIN)
	from := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 31, 0, 0, 0, 0, time.Local)
	rows, err = UsageAggregate(db, from, to, "user")
	if err != nil {
		t.Fatalf("user group with date filter: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user rows with range = %+v, want label alice", rows)
	}

	// deleted user falls back to the numeric id
	other, err := CreateUser(db, &User{Username: "ghost", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, other, "m", 2, 2); err != nil {
		t.Fatal(err)
	}
	if err := DeleteUser(db, other); err != nil {
		t.Fatal(err)
	}
	rows, err = UsageAggregate(db, time.Time{}, time.Time{}, "user")
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range rows {
		if r.Label == "ghost" {
			found = true
		}
	}
	if found {
		t.Fatalf("deleted user still labelled by username: %+v", rows)
	}
}

// TestUsageAggregateZeroFill: group=day with from/to 区间内缺日填 0,
// 保证折线不跨缺日直连。
func TestUsageAggregateZeroFill(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	for _, ts := range []string{"2026-08-10 09:00:00", "2026-08-12 09:00:00"} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts)
	}
	from := time.Date(2026, 8, 10, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 12, 0, 0, 0, 0, time.Local)
	rows, err := UsageAggregate(db, from, to, "day")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 3 { // 8-10, 8-11(填0), 8-12
		t.Fatalf("zero-fill rows = %d, want 3 (8-10/8-11/8-12)", len(rows))
	}
	wantLabels := []string{"2026-08-10", "2026-08-11", "2026-08-12"}
	for i, w := range wantLabels {
		if rows[i].Label != w {
			t.Fatalf("row[%d].Label = %q, want %q", i, rows[i].Label, w)
		}
	}
	if rows[1].Requests != 0 {
		t.Fatalf("gap day requests = %d, want 0", rows[1].Requests)
	}
	if rows[0].Requests != 1 || rows[2].Requests != 1 {
		t.Fatalf("non-gap requests wrong: %+v", rows)
	}
}

// TestUsageAggregateWeekMonth: group=week/month 正确聚合并按期补齐。
func TestUsageAggregateWeekMonth(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	// 2026-08-10(周一)与 2026-08-17(下周一)分属两个周桶
	for _, ts := range []string{"2026-08-10 09:00:00", "2026-08-17 09:00:00", "2026-08-18 09:00:00"} {
		id, _ := RecordUsage(db, uid, "m", 10, 5)
		setCreatedAt(t, db, id, ts)
	}
	from := time.Date(2026, 8, 10, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 8, 20, 0, 0, 0, 0, time.Local)

	rows, err := UsageAggregate(db, from, to, "week")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 { // 周桶 2026-08-10(8-10), 2026-08-17(8-17+8-18)
		t.Fatalf("week rows = %d, want 2", len(rows))
	}
	if rows[0].Label != "2026-08-10" || rows[1].Label != "2026-08-17" {
		t.Fatalf("week labels wrong: %+v", rows)
	}
	if rows[0].Requests != 1 || rows[1].Requests != 2 {
		t.Fatalf("week aggregation wrong: %+v", rows)
	}

	fromM := time.Date(2026, 7, 1, 0, 0, 0, 0, time.Local)
	toM := time.Date(2026, 9, 15, 0, 0, 0, 0, time.Local)
	rows, err = UsageAggregate(db, fromM, toM, "month")
	if err != nil {
		t.Fatal(err)
	}
	// 7/8/9 三个月,7 月填 0
	if len(rows) != 3 {
		t.Fatalf("month rows = %d, want 3", len(rows))
	}
	if rows[0].Label != "2026-07" || rows[0].Requests != 0 {
		t.Fatalf("july should be zero-filled: %+v", rows[0])
	}
	if rows[1].Label != "2026-08" || rows[1].Requests != 3 {
		t.Fatalf("august rows = %+v", rows[1])
	}
}

// TestUsageAggregateKindSplit: embedding 行单独计入 embed_requests/embed_tokens。
func TestUsageAggregateKindSplit(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	if _, err := RecordUsage(db, uid, "m", 10, 5); err != nil { // chat
		t.Fatal(err)
	}
	if _, err := RecordUsageKind(db, uid, "embed-m", 30, 0, "embedding"); err != nil {
		t.Fatal(err)
	}
	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
	r := rows[0]
	if r.Requests != 2 || r.EmbedRequests != 1 {
		t.Fatalf("requests=%d embed_requests=%d, want 2/1", r.Requests, r.EmbedRequests)
	}
	if r.EmbedTokens != 30 || r.PromptTokens != 40 {
		t.Fatalf("embed_tokens=%d prompt_tokens=%d, want 30/40", r.EmbedTokens, r.PromptTokens)
	}
}

// TestUsageAggregateMonthOverflow: from 为月末(8/31)时月桶不得跳过 9 月
// (审计2026-E3 P1-2 回归)。
func TestUsageAggregateMonthOverflow(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	id, _ := RecordUsage(db, uid, "m", 10, 5)
	setCreatedAt(t, db, id, "2026-08-31 09:00:00")
	id, _ = RecordUsage(db, uid, "m", 20, 5)
	setCreatedAt(t, db, id, "2026-09-15 09:00:00")

	from := time.Date(2026, 8, 31, 0, 0, 0, 0, time.Local)
	to := time.Date(2026, 9, 15, 0, 0, 0, 0, time.Local)
	rows, err := UsageAggregate(db, from, to, "month")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("month rows = %d, want 2 (2026-08, 2026-09)", len(rows))
	}
	if rows[0].Label != "2026-08" || rows[1].Label != "2026-09" {
		t.Fatalf("month labels wrong: %+v", rows)
	}
	if rows[0].Requests != 1 || rows[1].Requests != 1 {
		t.Fatalf("month requests wrong: %+v", rows)
	}
}

// TestUsageAggregateUserFilter: username 过滤仅返回该用户。
func TestUsageAggregateUserFilter(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	a, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	b, err := CreateUser(db, &User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = RecordUsage(db, a, "m", 10, 5)
	_, _ = RecordUsage(db, b, "m", 99, 1)

	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day", WithUsername("alice"))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].PromptTokens != 10 {
		t.Fatalf("filtered rows = %+v, want alice 10", rows)
	}

	// username 过滤 + group=user 组合:相关子查询不产生双 JOIN(审计2026-E3 P1-1)
	rows, err = UsageAggregate(db, time.Time{}, time.Time{}, "user", WithUsername("alice"))
	if err != nil {
		t.Fatalf("user group + username filter: %v", err)
	}
	if len(rows) != 1 || rows[0].Label != "alice" {
		t.Fatalf("user+filter rows = %+v, want [alice]", rows)
	}
}

// ---- 金额(费用)维度(0022) ----

// mustPricedModel 创建带价格的模型并返回模型名。
func mustPricedModel(t *testing.T, db *sql.DB, name string, in, out float64) {
	t.Helper()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-" + name, BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	inPtr, outPtr := in, out
	if _, err := AddModel(db, &Model{Name: name, ProviderID: pid, InputPricePer1M: &inPtr, OutputPricePer1M: &outPtr}); err != nil {
		t.Fatal(err)
	}
}

// TestRecordUsageComputesCost: 有定价模型 → usage.cost = pt/1e6*in + ct/1e6*out。
func TestRecordUsageComputesCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0) // 2元/1M in, 8元/1M out

	id, err := RecordUsage(db, uid, "priced-model", 1_000_000, 500_000)
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	want := 2.0 + 4.0 // 1M*2/1M + 0.5M*8/1M
	if cost != want {
		t.Fatalf("cost = %v, want %v", cost, want)
	}
}

// TestRecordUsageUnpricedModelCostZero: 未定价/无模型行 → cost=0(页面标注未定价)。
func TestRecordUsageUnpricedModelCostZero(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	id, err := RecordUsage(db, uid, "no-such-model", 1_000_000, 1_000_000)
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 0 {
		t.Fatalf("cost = %v, want 0 (unpriced)", cost)
	}
}

// TestUpdateUsageTokensRecomputesCost: 流式 pending 行回填 token 后 cost 必须重算。
func TestUpdateUsageTokensRecomputesCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	id, err := RecordUsage(db, uid, "priced-model", 0, 0) // pending
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 0 {
		t.Fatalf("pending cost = %v, want 0", cost)
	}
	if err := UpdateUsageTokens(db, id, 1_000_000, 500_000); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 6.0 {
		t.Fatalf("backfilled cost = %v, want 6.0", cost)
	}
}

// TestUserMonthlyCost: 当月费用 SUM(cost),上月不计入。
func TestUserMonthlyCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	id, err := RecordUsage(db, uid, "priced-model", 1_000_000, 500_000)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, id, "2000-01-01 10:00:00") // 上月
	id2, err := RecordUsage(db, uid, "priced-model", 500_000, 0)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, id2, time.Now().Format("2006-01-02")+" 09:00:00") // 本月

	cost, err := UserMonthlyCost(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if cost != 1.0 { // 0.5M*2/1M
		t.Fatalf("monthly cost = %v, want 1.0", cost)
	}
}

// TestUserMonthlyCostBatch: 批量费用查询(管理页 N+1 防护)。
func TestUserMonthlyCostBatch(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	uid2 := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)
	if _, err := RecordUsage(db, uid, "priced-model", 1_000_000, 0); err != nil {
		t.Fatal(err)
	}
	costs, err := UserMonthlyCostBatch(db, []int64{uid, uid2, 9999})
	if err != nil {
		t.Fatal(err)
	}
	if costs[uid] != 2.0 {
		t.Fatalf("uid cost = %v, want 2.0", costs[uid])
	}
	if costs[uid2] != 0 {
		t.Fatalf("uid2 cost = %v, want 0", costs[uid2])
	}
}

// TestEffectiveMoneyQuota: admin 豁免 → 个人覆盖 → 全局默认;0=不限。
func TestEffectiveMoneyQuota(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	mustUserID(t, db) // uid1 = 普通用户

	// 无个人值且无全局默认 → 不限
	u, err := GetUserByID(db, 1)
	if err != nil {
		t.Fatal(err)
	}
	q, err := EffectiveMoneyQuota(db, u)
	if err != nil {
		t.Fatal(err)
	}
	if q != 0 {
		t.Fatalf("no setting quota = %v, want 0 (unlimited)", q)
	}

	// 全局默认 100
	if err := SetSetting(db, MonthlyMoneyQuotaSetting, "100"); err != nil {
		t.Fatal(err)
	}
	q, err = EffectiveMoneyQuota(db, u)
	if err != nil {
		t.Fatal(err)
	}
	if q != 100 {
		t.Fatalf("global default quota = %v, want 100", q)
	}

	// 个人覆盖 50
	m := 50.0
	u.QuotaMoney = &m
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	q, err = EffectiveMoneyQuota(db, u)
	if err != nil {
		t.Fatal(err)
	}
	if q != 50 {
		t.Fatalf("override quota = %v, want 50", q)
	}

	// 个人 0 = 不限,覆盖全局默认
	z := 0.0
	u.QuotaMoney = &z
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	q, err = EffectiveMoneyQuota(db, u)
	if err != nil {
		t.Fatal(err)
	}
	if q != 0 {
		t.Fatalf("override zero quota = %v, want 0", q)
	}

	// admin 恒豁免
	u.IsAdmin = true
	u.QuotaMoney = nil
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	q, err = EffectiveMoneyQuota(db, u)
	if err != nil {
		t.Fatal(err)
	}
	if q != 0 {
		t.Fatalf("admin quota = %v, want 0", q)
	}
}

// TestUsageAggregateCost: 聚合行携带 cost(该桶费用合计),补零桶 cost=0。
func TestUsageAggregateCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	id, err := RecordUsage(db, uid, "priced-model", 1_000_000, 500_000)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, id, "2026-08-10 10:00:00")

	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Cost != 6.0 {
		t.Fatalf("rows = %+v, want one row cost 6.0", rows)
	}
}

// ---- 峰谷价格(0023) ----

// deepseekPeakWindows 为 DeepSeek 当前官方政策(2026-08 起):
// 高峰 = 北京时间**周一至周五** 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%。
// 测试固定此配置(设置键 usage.peak_windows)。
var deepseekPeakWindows = `[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]},{"start":"14:00","end":"18:00","weekdays":[1,2,3,4,5]}]`

// mustOffpeakModel 创建带价格与低谷折扣的模型。
func mustOffpeakModel(t *testing.T, db *sql.DB, name string, in, out, offpeak float64) {
	t.Helper()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-" + name, BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	inPtr, outPtr, offPtr := in, out, offpeak
	if _, err := AddModel(db, &Model{Name: name, ProviderID: pid, InputPricePer1M: &inPtr, OutputPricePer1M: &outPtr, OffpeakDiscount: &offPtr}); err != nil {
		t.Fatal(err)
	}
}

func utc(h, m int) time.Time {
	return time.Date(2026, 8, 19, h, m, 0, 0, time.UTC)
}

// utcOn returns a UTC time on a specific date (used to test weekday logic).
// 2026-08-19 = 周三;16(周日)/17(周一)/22(周六)。
func utcOn(day, h, m int) time.Time {
	return time.Date(2026, 8, day, h, m, 0, 0, time.UTC)
}

// TestParsePeakWindows:合法 JSON 解析;非法/空 → nil(无峰谷)。
func TestParsePeakWindows(t *testing.T) {
	w := ParsePeakWindows(deepseekPeakWindows)
	if len(w) != 2 || w[0].StartMin != 9*60 || w[0].EndMin != 12*60 || w[1].StartMin != 14*60 || w[1].EndMin != 18*60 {
		t.Fatalf("parsed windows = %+v", w)
	}
	if ParsePeakWindows("") != nil {
		t.Fatal("empty should be nil")
	}
	if ParsePeakWindows("not-json") != nil {
		t.Fatal("bad json should be nil")
	}
	if ParsePeakWindows(`[{"start":"12:00","end":"09:00"}]`) != nil {
		t.Fatal("start>=end should be nil")
	}
	if ParsePeakWindows(`[{"start":"25:00","end":"26:00"}]`) != nil {
		t.Fatal("bad hh:mm should be nil")
	}
}

// TestOffpeakFactor:高峰窗口(北京 09:00-12:00、14:00-18:00)外乘折扣。
// UTC 转北京 = +8h:UTC 01:00 = 北京 09:00(高峰起),UTC 04:00 = 北京 12:00(高峰止),
// UTC 06:00 = 北京 14:00(高峰起),UTC 10:00 = 北京 18:00(高峰止)。
func TestOffpeakFactor(t *testing.T) {
	windows := ParsePeakWindows(deepseekPeakWindows)
	cases := []struct {
		name     string
		now      time.Time
		discount float64
		want     float64
	}{
		{"空闲 00:00 UTC(北京 08:00)", utc(0, 0), 0.5, 0.5},
		{"高峰起 01:00 UTC(北京 09:00)含", utc(1, 0), 0.5, 1},
		{"高峰止 04:00 UTC(北京 12:00)不含", utc(4, 0), 0.5, 0.5},
		{"空闲 05:00 UTC(北京 13:00)", utc(5, 0), 0.5, 0.5},
		{"高峰起 06:00 UTC(北京 14:00)含", utc(6, 0), 0.5, 1},
		{"高峰止 10:00 UTC(北京 18:00)不含", utc(10, 0), 0.5, 0.5},
		{"空闲 15:00 UTC(北京 23:00)", utc(15, 0), 0.5, 0.5},
		// 工作日判定(weekdays=[1-5]):周六/周日即使 10:00 高峰时段也空闲;周一/周五按高峰。
		{"周六 10:00 UTC(北京 18:00,周末空闲)", utcOn(22, 10, 0), 0.5, 0.5},
		{"周日 01:00 UTC(北京 09:00,周末空闲)", utcOn(16, 1, 0), 0.5, 0.5},
		{"周一 01:00 UTC(北京 09:00,工作日高峰)", utcOn(17, 1, 0), 0.5, 1},
		{"周五 06:00 UTC(北京 14:00,工作日高峰)", utcOn(21, 6, 0), 0.5, 1},
		{"无折扣 0", utc(10, 0), 0, 1},
		{"无折扣 -1", utc(10, 0), -1, 1},
		{"无折扣 1(显式无峰谷)", utc(10, 0), 1, 1},
		{"无折扣 >1", utc(10, 0), 1.5, 1},
		{"未配置窗口 → 全标准价", utc(10, 0), 0.5, 1}, // windows = nil
	}
	for _, c := range cases {
		var ws []PeakWindow
		if c.name == "未配置窗口 → 全标准价" {
			ws = nil
		} else {
			ws = windows
		}
		if got := offpeakFactor(c.now, c.discount, ws); got != c.want {
			t.Errorf("%s: offpeakFactor(%v, %v) = %v, want %v", c.name, c.now, c.discount, got, c.want)
		}
	}
}

// TestRecordUsageOffpeakDiscount:空闲时段记录按折扣价折算,高峰时段按标准价。
func TestRecordUsageOffpeakDiscount(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustOffpeakModel(t, db, "offpeak-model", 2.0, 8.0, 0.5) // 标准 1M in=2 + 0.5M out=4
	if err := SetSetting(db, PeakWindowsSetting, deepseekPeakWindows); err != nil {
		t.Fatal(err)
	}

	// 空闲(UTC 10:00 = 北京 18:00):cost = (2+4)*0.5 = 3
	id, err := recordUsageKindAt(db, uid, "offpeak-model", 1_000_000, 500_000, "chat", utc(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 3.0 {
		t.Fatalf("off-peak cost = %v, want 3.0", cost)
	}

	// 高峰(UTC 08:00 = 北京 16:00):cost = 6(标准价)
	id2, err := recordUsageKindAt(db, uid, "offpeak-model", 1_000_000, 500_000, "chat", utc(8, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id2).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 6.0 {
		t.Fatalf("peak cost = %v, want 6.0", cost)
	}
}

// TestRecordUsageNoWindows:未配置高峰窗口时,即使有折扣也按标准价(防误打折)。
func TestRecordUsageNoWindows(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustOffpeakModel(t, db, "offpeak-model", 2.0, 8.0, 0.5)

	id, err := recordUsageKindAt(db, uid, "offpeak-model", 1_000_000, 500_000, "chat", utc(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 6.0 {
		t.Fatalf("no-windows cost = %v, want 6.0 (standard)", cost)
	}
}

// TestUpdateUsageTokensOffpeakRecompute:流式回填时按回填时刻折算。
func TestUpdateUsageTokensOffpeakRecompute(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustOffpeakModel(t, db, "offpeak-model", 2.0, 8.0, 0.5)
	if err := SetSetting(db, PeakWindowsSetting, deepseekPeakWindows); err != nil {
		t.Fatal(err)
	}

	id, err := recordUsageKindAt(db, uid, "offpeak-model", 0, 0, "chat", utc(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	if err := updateUsageTokensAt(db, id, 1_000_000, 500_000, utc(10, 0)); err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 3.0 {
		t.Fatalf("backfilled off-peak cost = %v, want 3.0", cost)
	}
}

// ---- 部门金额预算(0024) ----

// mustDept 创建部门(返回 id)。
func mustDept(t *testing.T, db *sql.DB, name string, parent int64) int64 {
	t.Helper()
	id, err := CreateDepartment(db, name, parent, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// TestDeptBudgetEffective: 员工生效预算 = 归属部门 + 祖先链(最近配置者胜)。
func TestDeptBudgetEffective(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	// 树:研发(预算 1000)→ 前端(无)→ 前端A组(预算 500)
	rd := mustDept(t, db, "研发部", 0)
	qd := mustDept(t, db, "前端部", rd)
	qa := mustDept(t, db, "前端A组", qd)
	if err := SetDeptBudget(db, rd, 1000); err != nil {
		t.Fatal(err)
	}
	if err := SetDeptBudget(db, qa, 500); err != nil {
		t.Fatal(err)
	}

	// 普通成员挂前端A组:链上全部预算生效(研发 1000 是子树封顶,A组 500 更严)
	uid, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := AddUserGroup(db, uid, qa); err != nil {
		t.Fatal(err)
	}
	eff, err := EffectiveDeptBudget(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(eff) != 2 || eff[0].Budget != 1000 || eff[0].Name != "研发部" || eff[1].Budget != 500 || eff[1].Name != "前端A组" {
		t.Fatalf("alice effective budget = %+v, want [研发部 1000, 前端A组 500]", eff)
	}

	// 挂前端部(祖先链 研发1000, 前端无):最近配置 = 研发 1000
	uid2, err := CreateUser(db, &User{Username: "bob", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := AddUserGroup(db, uid2, qd); err != nil {
		t.Fatal(err)
	}
	eff2, err := EffectiveDeptBudget(db, uid2)
	if err != nil {
		t.Fatal(err)
	}
	if len(eff2) != 1 || eff2[0].Budget != 1000 {
		t.Fatalf("bob effective budget = %+v, want [研发部 1000]", eff2)
	}

	// 无部门:无部门预算
	uid3, err := CreateUser(db, &User{Username: "carl", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	eff3, err := EffectiveDeptBudget(db, uid3)
	if err != nil {
		t.Fatal(err)
	}
	if len(eff3) != 0 {
		t.Fatalf("carl effective budget = %+v, want none", eff3)
	}
}

// TestDeptBudgetChainMultiBudget: 一条链上多级配置预算 → 全部生效(都需守住)。
func TestDeptBudgetChainMultiBudget(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rd := mustDept(t, db, "研发部", 0)
	qd := mustDept(t, db, "前端部", rd)
	qa := mustDept(t, db, "前端A组", qd)
	if err := SetDeptBudget(db, rd, 1000); err != nil {
		t.Fatal(err)
	}
	if err := SetDeptBudget(db, qd, 600); err != nil {
		t.Fatal(err)
	}
	if err := SetDeptBudget(db, qa, 500); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "alice", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := AddUserGroup(db, uid, qa); err != nil {
		t.Fatal(err)
	}
	eff, err := EffectiveDeptBudget(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	// 3 级预算全部生效(排序:祖先 → 自己)
	if len(eff) != 3 || eff[0].Budget != 1000 || eff[1].Budget != 600 || eff[2].Budget != 500 {
		t.Fatalf("chain budgets = %+v", eff)
	}
}

// TestDeptBudgetCost: 部门当月费用 = 树内全部成员 SUM(cost)。
func TestDeptBudgetCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rd := mustDept(t, db, "研发部", 0)
	qd := mustDept(t, db, "前端部", rd)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	// 研发直属成员 + 前端部成员
	uid1, _ := CreateUser(db, &User{Username: "a1", Source: "local", Status: 1})
	_ = AddUserGroup(db, uid1, rd)
	uid2, _ := CreateUser(db, &User{Username: "a2", Source: "local", Status: 1})
	_ = AddUserGroup(db, uid2, qd)
	// 无部门用户(不计入)
	uid3, _ := CreateUser(db, &User{Username: "a3", Source: "local", Status: 1})

	id, _ := RecordUsage(db, uid1, "priced-model", 1_000_000, 0) // 2 元
	setCreatedAt(t, db, id, time.Now().Format("2006-01-02")+" 09:00:00")
	id2, _ := RecordUsage(db, uid2, "priced-model", 500_000, 0) // 1 元
	setCreatedAt(t, db, id2, time.Now().Format("2006-01-02")+" 09:00:00")
	id3, _ := RecordUsage(db, uid3, "priced-model", 1_000_000, 0) // 2 元,不计
	setCreatedAt(t, db, id3, time.Now().Format("2006-01-02")+" 09:00:00")

	cost, err := DeptMonthlyCost(db, rd)
	if err != nil {
		t.Fatal(err)
	}
	if cost != 3.0 { // 研发树 = a1 2 + a2 1(前端是子树)
		t.Fatalf("dept monthly cost = %v, want 3.0", cost)
	}
	cost, err = DeptMonthlyCost(db, qd)
	if err != nil {
		t.Fatal(err)
	}
	if cost != 1.0 {
		t.Fatalf("sub dept monthly cost = %v, want 1.0", cost)
	}
}

// TestDeptBudgetCostBatch: 批量部门费用(部门列表页 N+1 防护)。
func TestDeptBudgetCostBatch(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rd := mustDept(t, db, "研发部", 0)
	qd := mustDept(t, db, "前端部", rd)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)
	uid1, _ := CreateUser(db, &User{Username: "a1", Source: "local", Status: 1})
	_ = AddUserGroup(db, uid1, qd)
	id, _ := RecordUsage(db, uid1, "priced-model", 1_000_000, 0)
	setCreatedAt(t, db, id, time.Now().Format("2006-01-02")+" 09:00:00")

	costs, err := DeptMonthlyCostBatch(db, []int64{rd, qd, 9999})
	if err != nil {
		t.Fatal(err)
	}
	if costs[rd] != 2.0 || costs[qd] != 2.0 {
		t.Fatalf("batch costs = %+v, want rd=qd=2.0", costs)
	}
	if costs[9999] != 0 {
		t.Fatalf("missing dept cost = %v, want 0", costs[9999])
	}
}

// ---- 员工用量概览(日/昨日/总计) ----

// TestUserDayUsageCost: 指定日用量/费用(边界 [day00, 次日00))。
func TestUserDayUsageCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	// 今天 09:00:1M prompt → cost 2
	id, err := RecordUsage(db, uid, "priced-model", 1_000_000, 0)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, id, time.Now().Format("2006-01-02")+" 09:00:00")
	// 昨天 23:00:500K prompt → cost 1
	id2, err := RecordUsage(db, uid, "priced-model", 500_000, 0)
	if err != nil {
		t.Fatal(err)
	}
	setCreatedAt(t, db, id2, time.Now().AddDate(0, 0, -1).Format("2006-01-02")+" 23:00:00")

	now := time.Now()
	usage, cost, err := UserDayUsageCost(db, uid, now)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 1_000_000 || cost != 2.0 {
		t.Fatalf("today usage=%d cost=%v, want 1000000/2.0", usage, cost)
	}
	u2, c2, err := UserDayUsageCost(db, uid, now.AddDate(0, 0, -1))
	if err != nil {
		t.Fatal(err)
	}
	if u2 != 500_000 || c2 != 1.0 {
		t.Fatalf("yesterday usage=%d cost=%v, want 500000/1.0", u2, c2)
	}
}

// TestUserTotalUsageCost: 全历史累计(不含 pending 零行影响,含任意日期)。
func TestUserTotalUsageCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	id, _ := RecordUsage(db, uid, "priced-model", 1_000_000, 0)
	setCreatedAt(t, db, id, "2020-01-01 10:00:00") // 历史
	id2, _ := RecordUsage(db, uid, "priced-model", 500_000, 0)
	setCreatedAt(t, db, id2, "2020-06-15 10:00:00")

	usage, cost, err := UserTotalUsageCost(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if usage != 1_500_000 || cost != 3.0 {
		t.Fatalf("total usage=%d cost=%v, want 1500000/3.0", usage, cost)
	}
}

// TestUserUsageSummary: 汇总结构(本月+今日+昨日+总计)一次取齐。
// 跨月安全(2026-09):昨日与今日跨月时(每月 1 号),月度统计只含今日
// 记录(昨日属上月),断言随实际日期计算。
func TestUserUsageSummary(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "priced-model", 2.0, 8.0)

	now := time.Now()
	// 今天
	id, _ := RecordUsage(db, uid, "priced-model", 1_000_000, 0)
	setCreatedAt(t, db, id, now.Format("2006-01-02")+" 09:00:00")
	// 昨天(可能跨月:8/31 23:00)
	id2, _ := RecordUsage(db, uid, "priced-model", 500_000, 0)
	setCreatedAt(t, db, id2, now.AddDate(0, 0, -1).Format("2006-01-02")+" 23:00:00")

	yesterday := now.AddDate(0, 0, -1)
	sameMonth := yesterday.Year() == now.Year() && yesterday.Month() == now.Month()
	monthlyUsage := int64(1_000_000)
	monthlyCost := 2.0
	if sameMonth {
		monthlyUsage = 1_500_000
		monthlyCost = 3.0
	}

	s, err := UserUsageSummary(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if s.TodayUsage != 1_000_000 || s.TodayCost != 2.0 {
		t.Fatalf("today = %d/%v", s.TodayUsage, s.TodayCost)
	}
	if s.YesterdayUsage != 500_000 || s.YesterdayCost != 1.0 {
		t.Fatalf("yesterday = %d/%v", s.YesterdayUsage, s.YesterdayCost)
	}
	if s.TotalUsage != 1_500_000 || s.TotalCost != 3.0 {
		t.Fatalf("total = %d/%v", s.TotalUsage, s.TotalCost)
	}
	if s.MonthlyUsage != monthlyUsage || s.MonthlyCost != monthlyCost {
		t.Fatalf("monthly=%d/%v vs want %d/%v", s.MonthlyUsage, s.MonthlyCost, monthlyUsage, monthlyCost)
	}
}

// 缓存计费(0029/0030):命中 token 按缓存价,未命中按输入价,未配置缓存价回退输入价。
func TestRecordUsageCacheCost(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	// 输入 2 元/1M,输出 8 元/1M,缓存 1 元/1M
	cachePtr := 1.0
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-cache", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{Name: "cache-model", ProviderID: pid, InputPricePer1M: ptrFloat(2.0), OutputPricePer1M: ptrFloat(8.0), CacheInputPricePer1M: &cachePtr}); err != nil {
		t.Fatal(err)
	}

	// 1M 输入全命中:100 万命中 → 1 元
	id, err := RecordUsageKindCached(db, uid, "cache-model", 1_000_000, 0, 1_000_000, "chat")
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 1.0 {
		t.Fatalf("full-cache cost = %v, want 1.0", cost)
	}

	// 混合:50 万命中 + 50 万未命中 + 25 万输出 = 0.5*1 + 0.5*2 + 0.25*8 = 3.5
	id2, err := RecordUsageKindCached(db, uid, "cache-model", 1_000_000, 250_000, 500_000, "chat")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id2).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 3.5 {
		t.Fatalf("mixed cost = %v, want 3.5", cost)
	}
}

// 未配置缓存价时回退输入价:用 input=2 的模型,全命中应按 2 元计。
func TestRecordUsageCacheFallsBackToInput(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	mustPricedModel(t, db, "no-cache-model", 2.0, 8.0) // 无 CacheInputPricePer1M
	id, err := RecordUsageKindCached(db, uid, "no-cache-model", 1_000_000, 0, 1_000_000, "chat")
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 2.0 {
		t.Fatalf("fallback cost = %v, want 2.0 (输入价)", cost)
	}
}

// 命中数超过总输入:防御钳制,按总输入计费。
func TestRecordUsageCacheClamp(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	cachePtr := 1.0
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-clamp", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{Name: "clamp-model", ProviderID: pid, InputPricePer1M: ptrFloat(2.0), OutputPricePer1M: ptrFloat(8.0), CacheInputPricePer1M: &cachePtr}); err != nil {
		t.Fatal(err)
	}
	// 输入 10 万,命中 100 万(异常)→ 钳制为 10 万命中,费用 = 0.1*1 = 0.1
	id, err := RecordUsageKindCached(db, uid, "clamp-model", 100_000, 0, 1_000_000, "chat")
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow("SELECT cost FROM usage WHERE id = ?", id).Scan(&cost); err != nil {
		t.Fatal(err)
	}
	if cost != 0.1 {
		t.Fatalf("clamp cost = %v, want 0.1", cost)
	}
}

func ptrFloat(v float64) *float64 { return &v }

// TestDeptBudgetMultiMembership: 用户同时归属多个部门(2026-09 本地用户
// 多部门支持)——EffectiveDeptBudget 返回全部所属部门 + 各自祖先链(去重),
// 预算语义 = 全部同时生效,任一超限即拦截(≠ 取最高)。
func TestDeptBudgetMultiMembership(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rd := mustDept(t, db, "研发部", 0)
	mk := mustDept(t, db, "市场部", 0)
	if err := SetDeptBudget(db, rd, 1000); err != nil {
		t.Fatal(err)
	}
	if err := SetDeptBudget(db, mk, 500); err != nil {
		t.Fatal(err)
	}

	// 用户同时挂 研发部(祖先链自身1000) 与 市场部(500)
	uid, err := CreateUser(db, &User{Username: "multi", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, uid, []string{"研发部", "市场部"}); err != nil {
		t.Fatal(err)
	}
	eff, err := EffectiveDeptBudget(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	// 期望:研发部 1000 + 市场部 500(祖先→自身排序,去重)
	// 注意 groups 按名称排序(市场部 < 研发部A组,中文排序),预算链迭代
	// memberIDs 顺序 → 结果排序与名称相关;此处只校验集合。
	budgets := map[string]float64{}
	for _, b := range eff {
		budgets[b.Name] = b.Budget
	}
	if len(eff) != 2 {
		t.Fatalf("eff = %+v, want 2 budgets (研发1000 + 市场500)", eff)
	}
	if budgets["研发部"] != 1000 || budgets["市场部"] != 500 {
		t.Fatalf("budgets = %v, want 研发部:1000 市场部:500", budgets)
	}
	// 任一超限即拦:市场部 500 更小,超限时用户被拦(即使研发部未超)
	if effBudgetsHasSmaller(budgets, 500) {
		// 验证市场部预算确实参与(不是只取最高的研发 1000)
		t.Logf("multi-membership budgets: %v (市场部 500 参与,任一超限即拦)", budgets)
	}
}

// effBudgetsHasSmaller 检查任意预算 ≤ 给定值(证明不是只取最高)。
func effBudgetsHasSmaller(budgets map[string]float64, limit float64) bool {
	for _, v := range budgets {
		if v <= limit {
			return true
		}
	}
	return false
}
