package serverstore

import (
	"math"
	"testing"
	"time"
)

// TestSearchOnlyRowSurvivesPendingCleanup：只有搜索、没有 token 的已计费行
// 不得被启动期 0-token 清理删掉（否则余额已扣、明细消失）。
func TestSearchOnlyRowSurvivesPendingCleanup(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-search4", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{
		Name: "search-model4", ProviderID: pid,
		InputPricePer1M: ptrFloat(1), OutputPricePer1M: ptrFloat(4),
	}); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	paid, err := recordUsageKindAtCached(db, uid, pid, "search-model4", 0, 0, 0, 2, "search", false, at)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := recordUsageKindAtCached(db, uid, pid, "search-model4", 0, 0, 0, 0, "search", false, at)
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	setCreatedAt(t, db, paid, old.Format("2006-01-02 15:04:05"))
	setCreatedAt(t, db, pending, old.Format("2006-01-02 15:04:05"))

	if err := CleanupPendingUsage(db, time.Now().Add(-24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	var cost float64
	if err := db.QueryRow(`SELECT cost FROM usage WHERE id = ?`, paid).Scan(&cost); err != nil {
		t.Fatalf("搜索计费行被 0-token 清理误删: %v", err)
	}
	if math.Abs(cost-0.01) > 1e-12 {
		t.Fatalf("surviving cost = %v, want 0.01", cost)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage WHERE id = ?`, pending).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("0-token/0-search 的 pending 行仍应被清理")
	}
}

// TestParseSearchPricePer1K 覆盖管理端输入口径（空串/负数/NaN/上限）。
func TestParseSearchPricePer1K(t *testing.T) {
	cases := []struct {
		raw  string
		want float64
		ok   bool
	}{
		{"", 0, true},
		{"0", 0, true},
		{"5", 5, true},
		{" 5.5 ", 5.5, true},
		{"1000", 1000, true},
		{"-1", 0, false},
		{"abc", 0, false},
		{"NaN", 0, false},
		{"Inf", 0, false},
		{"1000.01", 0, false},
	}
	for _, c := range cases {
		got, ok := ParseSearchPricePer1K(c.raw)
		if ok != c.ok || (ok && got != c.want) {
			t.Errorf("ParseSearchPricePer1K(%q) = %v,%v want %v,%v", c.raw, got, ok, c.want, c.ok)
		}
	}
}

func TestSearchFee(t *testing.T) {
	cases := []struct {
		requests int64
		per1K    float64
		want     float64
	}{
		{0, 5, 0},
		{1, 5, 0.005},
		{2, 5, 0.01},
		{1000, 5, 5},
		{-3, 5, 0},
		{2, 0, 0},
		{2, -1, 0},
	}
	for _, c := range cases {
		if got := searchFee(c.requests, c.per1K); math.Abs(got-c.want) > 1e-12 {
			t.Errorf("searchFee(%d,%v) = %v want %v", c.requests, c.per1K, got, c.want)
		}
	}
}

// TestRecordUsageSearchFeeNotDiscounted 是 0085 的核心判据：
// 搜索按次费用 = 次数 × 单价 / 1000，**不乘**峰谷折扣；token 费用照常打折。
func TestRecordUsageSearchFeeNotDiscounted(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-search", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	off := 0.5
	if _, err := AddModel(db, &Model{
		Name: "search-model", ProviderID: pid,
		InputPricePer1M: ptrFloat(1), OutputPricePer1M: ptrFloat(4), CacheInputPricePer1M: ptrFloat(1),
		OffpeakDiscount: &off,
	}); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}
	// 工作日 09:00-12:00 / 14:00-18:00（北京时间）= 高峰；其余空闲。
	if err := SetSetting(db, PeakWindowsSetting,
		`[{"start":"09:00","end":"12:00","weekdays":[1,2,3,4,5]},{"start":"14:00","end":"18:00","weekdays":[1,2,3,4,5]}]`); err != nil {
		t.Fatal(err)
	}

	// 2026-10-17 是周六：北京时间 20:00，必然落在空闲时段。
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	id, err := recordUsageKindAtCached(db, uid, pid, "search-model", 1_000_000, 0, 0, 2, "search", false, at)
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	var searches int64
	if err := db.QueryRow(`SELECT cost, search_requests FROM usage WHERE id = ?`, id).Scan(&cost, &searches); err != nil {
		t.Fatal(err)
	}
	// token: 1M × 1 元/1M × 0.5 = 0.5；搜索: 2 × 5/1000 = 0.01（不打折）。
	const want = 0.51
	if math.Abs(cost-want) > 1e-12 {
		t.Fatalf("cost = %v, want %v (搜索费不得乘峰谷折扣)", cost, want)
	}
	if searches != 2 {
		t.Fatalf("search_requests = %d, want 2", searches)
	}
}

// TestUpdateUsageSearchFee 覆盖流式回填路径：token + 搜索次数在同一次 UPDATE
// 里结算，cost 同时包含两部分。
func TestUpdateUsageSearchFee(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-search2", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{
		Name: "search-model2", ProviderID: pid,
		InputPricePer1M: ptrFloat(1), OutputPricePer1M: ptrFloat(4), CacheInputPricePer1M: ptrFloat(1),
	}); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, SearchPriceSetting, "5"); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	id, err := recordUsageKindAtCached(db, uid, pid, "search-model2", 0, 0, 0, 0, "search", false, at)
	if err != nil {
		t.Fatal(err)
	}
	if err := updateUsageTokensAtCached(db, id, 1_000_000, 0, 0, 3, false, true, at); err != nil {
		t.Fatal(err)
	}
	var cost float64
	var searches int64
	if err := db.QueryRow(`SELECT cost, search_requests FROM usage WHERE id = ?`, id).Scan(&cost, &searches); err != nil {
		t.Fatal(err)
	}
	const want = 1.0 + 3*0.005
	if math.Abs(cost-want) > 1e-12 {
		t.Fatalf("cost = %v, want %v", cost, want)
	}
	if searches != 3 {
		t.Fatalf("search_requests = %d, want 3", searches)
	}
}

// TestSearchPriceMissingMeansNoFee：未配置单价（升级后的缺省）时按次费用为 0，
// 只记次数不改账单 —— 不能让升级动作本身改变既有计费。
func TestSearchPriceMissingMeansNoFee(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "prov-search3", BaseURL: "http://x", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{
		Name: "search-model3", ProviderID: pid,
		InputPricePer1M: ptrFloat(1), OutputPricePer1M: ptrFloat(4), CacheInputPricePer1M: ptrFloat(1),
	}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 10, 17, 12, 0, 0, 0, time.UTC)
	id, err := recordUsageKindAtCached(db, uid, pid, "search-model3", 1_000_000, 0, 0, 2, "search", false, at)
	if err != nil {
		t.Fatal(err)
	}
	var cost float64
	var searches int64
	if err := db.QueryRow(`SELECT cost, search_requests FROM usage WHERE id = ?`, id).Scan(&cost, &searches); err != nil {
		t.Fatal(err)
	}
	if math.Abs(cost-1.0) > 1e-12 {
		t.Fatalf("cost = %v, want 1.0（未配置 Search 单价时不加收）", cost)
	}
	if searches != 2 {
		t.Fatalf("search_requests = %d, want 2（次数仍要落库供对账）", searches)
	}
}
