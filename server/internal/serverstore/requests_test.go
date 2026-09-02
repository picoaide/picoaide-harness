package serverstore

import (
	"testing"
	"time"
)

func TestListUsageRequests(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	u1, err := CreateUser(db, &User{Username: "req1", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	u2, err := CreateUser(db, &User{Username: "req2", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// u1: 2 chat + 1 embedding;u2: 1 search
	for i := 0; i < 2; i++ {
		if _, err := RecordUsageKind(db, u1, "m1", 100+int64(i), 10, "chat"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := RecordUsageKind(db, u1, "embed-model", 50, 0, "embedding"); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsageKind(db, u2, "m1", 7, 3, "search"); err != nil {
		t.Fatal(err)
	}

	from := time.Now().AddDate(0, 0, -1)
	to := time.Now().AddDate(0, 0, 1)

	// 1) 全量分页
	rows, total, err := ListUsageRequests(db, from, to, "", "", "", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 || len(rows) != 4 {
		t.Fatalf("all: total=%d rows=%d, want 4/4", total, len(rows))
	}
	// 倒序:第一条是最新请求
	if rows[0].ID < rows[1].ID {
		t.Fatalf("not desc order: %v", rows[0].ID)
	}

	// 2) 按用户过滤
	rows, total, err = ListUsageRequests(db, from, to, "req2", "", "", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || rows[0].Username != "req2" || rows[0].Kind != "search" {
		t.Fatalf("by user: %+v", rows)
	}

	// 3) 按模型 + kind 过滤
	rows, total, err = ListUsageRequests(db, from, to, "", "embed-model", "", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || rows[0].Kind != "embedding" {
		t.Fatalf("by model: %+v", rows)
	}
	rows, total, err = ListUsageRequests(db, from, to, "", "", "chat", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 {
		t.Fatalf("by kind chat: %d, want 2", total)
	}

	// 4) 分页 size=2 → 2 页
	rows, total, err = ListUsageRequests(db, from, to, "", "", "", 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	if total != 4 || len(rows) != 2 {
		t.Fatalf("page1: total=%d rows=%d", total, len(rows))
	}
	rows, _, err = ListUsageRequests(db, from, to, "", "", "", 2, 2)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("page2 rows=%d, want 2", len(rows))
	}

	// 5) 区间外 = 空
	rows, total, err = ListUsageRequests(db, time.Now().AddDate(0, 0, -30), time.Now().AddDate(0, 0, -20), "", "", "", 1, 100)
	if err != nil {
		t.Fatal(err)
	}
	if total != 0 || len(rows) != 0 {
		t.Fatalf("out of range: %d %d", total, len(rows))
	}
}

func TestRegroupByProvider(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// provider + 模型归属
	p1, err := AddGatewayProvider(db, &GatewayProvider{Name: "DeepSeek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "x", Models: []string{}, Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{Name: "deepseek-chat", ProviderID: p1}); err != nil {
		t.Fatal(err)
	}
	if _, err := AddModel(db, &Model{Name: "unlisted", ProviderID: p1}); err != nil {
		t.Fatal(err)
	}

	mp, err := ModelProviderMap(db)
	if err != nil {
		t.Fatal(err)
	}
	if mp["deepseek-chat"] != "DeepSeek" {
		t.Fatalf("map: %v", mp)
	}
	rows := []UsageAggregateRow{
		{Label: "deepseek-chat", PromptTokens: 100, Cost: 1.5},
		{Label: "unregistered-model", PromptTokens: 50, Cost: 0.6},
	}
	out := RegroupByProvider(rows, mp)
	if len(out) != 2 {
		t.Fatalf("provider rows = %d, want 2", len(out))
	}
	// 费用降序:DeepSeek(1.5) 在前, 未配置(0.6) 在后
	if out[0].Label != "DeepSeek" || out[0].PromptTokens != 100 {
		t.Fatalf("provider row[0] = %+v", out[0])
	}
	if out[1].Label != UnassignedProvider || out[1].PromptTokens != 50 {
		t.Fatalf("provider row[1] = %+v", out[1])
	}
}
