package serverauth

// 审计 2026-09-19:usageOverview 的 top_models 用不稳定排序。
//
// 缺陷形态:`sort.Slice(top, func(i, j int) bool { return top[i].Cost > top[j].Cost })`
// 只按 Cost 比较 ⇒ **等值行的相对顺序不由任何判据决定**,而是由 pdqsort 的
// 内部行为决定。输入本身是确定的(UsageAggregate / UsageAggregateFromLedger
// 都 `ORDER BY label`,mergeUsageRows 顺序保持),所以"同一份数据两次请求给出
// 不同顺序"并不成立;但一旦**同时存在不同成本与等值行**,等值组就会被重排成
// 与模型名无关的顺序(实测:5 个已定价 + 15 个未定价时,0 成本组的输出顺序是
// m-05/m-09/m-11/m-07/…,既不是输入序也不是字典序)⇒
//   - 展示顺序每次都要靠人重新找;更硬的是**取前 10 的边界**:第 10/11 名等值
//     时(未定价模型很常见)选中哪 10 个是不确定的,多一个等值模型就可能换人。
//
// 修法:sort.SliceStable + 次级键 Label(模型名)⇒ 顺序由判据完全确定。
// 唯一判据(Cost 降序)与"取前 10"语义不变:仍按成本排序、仍取成本最高的 10 个,
// 只有等值时的次序被固定下来(等值时本来就没有"谁更该在前"的事实)。

import (
	"fmt"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// topModelLabels 调一次 overview,返回 top_models 的模型名序列。
func topModelLabels(t *testing.T, r http.Handler, hdr map[string]string) []string {
	t.Helper()
	w, out := doJSON(t, r, "GET", "/api/server/admin/usage/overview", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("overview = %d %s", w.Code, w.Body.String())
	}
	rows, ok := out["top_models"].([]any)
	if !ok {
		t.Fatalf("top_models 缺失: %v", out)
	}
	labels := make([]string, 0, len(rows))
	for _, raw := range rows {
		m, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("top_models 行形态异常: %v", raw)
		}
		label, _ := m["label"].(string)
		labels = append(labels, label)
	}
	return labels
}

// TestUsageOverviewTopModelsStableOrder:等值(未定价)模型的顺序必须由判据确定 ——
// Cost 降序,等值时按模型名升序;两次请求逐字一致。
func TestUsageOverviewTopModelsStableOrder(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	u, err := serverstore.CreateUser(db, &serverstore.User{Username: "top-owner", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled)
		VALUES ('top-provider', 'https://upstream.example', 'sk', '[]', 1)`); err != nil {
		t.Fatal(err)
	}
	var pid int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'top-provider'`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// 5 个已定价(成本 5/4/3/2/1 元)+ 15 个未定价(成本 0)。
	// 等值组 15 行 > 前 10 的剩余名额 5 ⇒ 边界选谁必须确定。
	var wantLabels []string
	for i := 0; i < 5; i++ {
		name := fmt.Sprintf("paid-%d", i)
		if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m)
			VALUES (?, ?, ?, ?)`, name, pid, name, 1000000*(5-i)); err != nil {
			t.Fatal(err)
		}
		if _, err := serverstore.RecordUsageKind(db, u, name, 1, 0, "chat"); err != nil {
			t.Fatal(err)
		}
		wantLabels = append(wantLabels, name) // 成本 5-i 元,降序
	}
	// 未定价模型:名字故意与插入顺序错开(先插 free-09…free-00),
	// 这样"字典序"与"插入序"不同,能区分"确定"与"碰巧"。
	var free []string
	for i := 14; i >= 0; i-- {
		free = append(free, fmt.Sprintf("free-%02d", i))
	}
	for _, name := range free {
		if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name)
			VALUES (?, ?, ?)`, name, pid, name); err != nil {
			t.Fatal(err)
		}
		if _, err := serverstore.RecordUsageKind(db, u, name, 1, 0, "chat"); err != nil {
			t.Fatal(err)
		}
	}
	// 取前 10 = 5 个已定价 + 字典序最小的 5 个未定价(free-00…free-04)。
	for i := 0; i < 5; i++ {
		wantLabels = append(wantLabels, fmt.Sprintf("free-%02d", i))
	}

	got1 := topModelLabels(t, r, hdr)
	got2 := topModelLabels(t, r, hdr)
	if len(got1) != len(wantLabels) {
		t.Fatalf("top_models 长度 = %d, want %d (%v)", len(got1), len(wantLabels), got1)
	}
	for i := range wantLabels {
		if got1[i] != wantLabels[i] {
			t.Fatalf("top_models[%d] = %q, want %q\n got  = %v\n want = %v", i, got1[i], wantLabels[i], got1, wantLabels)
		}
	}
	if fmt.Sprint(got1) != fmt.Sprint(got2) {
		t.Fatalf("同一份数据两次请求顺序漂移:\n first  = %v\n second = %v", got1, got2)
	}
}

// TestUsageOverviewTopModelsCostStillPrimary:唯一判据不变 —— 成本高的排在前面,
// 次级键只在等值时生效;非等值行不得被字典序改写。
func TestUsageOverviewTopModelsCostStillPrimary(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	u, err := serverstore.CreateUser(db, &serverstore.User{Username: "cost-owner", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO gateway_providers (name, base_url, api_key_enc, models, enabled)
		VALUES ('cost-provider', 'https://upstream.example', 'sk', '[]', 1)`); err != nil {
		t.Fatal(err)
	}
	var pid int64
	if err := db.QueryRow(`SELECT id FROM gateway_providers WHERE name = 'cost-provider'`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	// zzz-expensive 成本高但字典序最大;aac-cheap 成本低但字典序最小。
	if _, err := db.Exec(`INSERT INTO models (name, provider_id, display_name, input_price_per_1m) VALUES
		('zzz-expensive', ?, 'Z', 500000), ('aac-cheap', ?, 'A', 1)`, pid, pid); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsageKind(db, u, "zzz-expensive", 1000, 0, "chat"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecordUsageKind(db, u, "aac-cheap", 1, 0, "chat"); err != nil {
		t.Fatal(err)
	}
	got := topModelLabels(t, r, hdr)
	if len(got) != 2 || got[0] != "zzz-expensive" || got[1] != "aac-cheap" {
		t.Fatalf("top_models = %v, want [zzz-expensive aac-cheap](Cost 降序为主判据)", got)
	}
}
