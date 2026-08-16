package serverstore

import (
	"testing"
)

func TestModelDefaultParams(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "m1", `{"context_length":1048576,"max_output":393216}`); err != nil {
		t.Fatal(err)
	}
	params, err := ModelDefaultParams(db, "m1")
	if err != nil {
		t.Fatal(err)
	}
	if params != `{"context_length":1048576,"max_output":393216}` {
		t.Fatalf("params = %q", params)
	}
	// missing model -> ErrNotFound
	if _, err := ModelDefaultParams(db, "nope"); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
}

func TestGatewayProviderChannelField(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := AddGatewayProvider(db, &GatewayProvider{
		Name:      "deepseek-provider",
		BaseURL:   "https://api.deepseek.com",
		APIKeyEnc: "enc-key",
		Models:    []string{"deepseek-chat"},
		Enabled:   1,
		Channel:   "deepseek",
	})
	if err != nil {
		t.Fatalf("AddGatewayProvider: %v", err)
	}

	p, err := GetGatewayProvider(db, id)
	if err != nil {
		t.Fatalf("GetGatewayProvider: %v", err)
	}
	if p.Channel != "deepseek" {
		t.Fatalf("Channel = %q, want %q", p.Channel, "deepseek")
	}
}

func TestSyncProviderModelAndRemoveMissing(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p := &GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: "enc:x", Channel: "deepseek", Enabled: 1}
	pid, err := AddGatewayProvider(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-flash", `{"context_length":1048576}`); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "deepseek-v4-pro", `{"max_output":393216}`); err != nil {
		t.Fatal(err)
	}
	removed, err := RemoveMissingProviderModels(db, pid, []string{"deepseek-v4-pro"})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE name = 'deepseek-v4-pro'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("models = %d, want 1", n)
	}
	// default_model 被删时重置为空
	if err := SetSetting(db, "gateway.default_model", "deepseek-v4-pro"); err != nil {
		t.Fatal(err)
	}
	removed, err = RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed2 = %d", removed)
	}
	v, ok, _ := GetSetting(db, "gateway.default_model")
	if !ok || v != "" {
		t.Fatalf("default_model = %q ok=%v", v, ok)
	}
}

func TestSyncProviderModelPerProvider(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	p1 := &GatewayProvider{Name: "a", BaseURL: "http://a", APIKeyEnc: "enc", Enabled: 1}
	p2 := &GatewayProvider{Name: "b", BaseURL: "http://b", APIKeyEnc: "enc", Enabled: 1}
	id1, err := AddGatewayProvider(db, p1)
	if err != nil {
		t.Fatal(err)
	}
	id2, err := AddGatewayProvider(db, p2)
	if err != nil {
		t.Fatal(err)
	}
	// 两个 provider 提供同名模型
	if err := SyncProviderModel(db, id1, "gpt-4o", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, id2, "gpt-4o", `{"max_output":100}`); err != nil {
		t.Fatal(err)
	}
	// 应有两行,分属两个 provider
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE name = 'gpt-4o'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("rows for gpt-4o = %d, want 2", n)
	}
	// 每个 provider 都能删除自己的
	removed, err := RemoveMissingProviderModels(db, id1, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d", removed)
	}
	var remains int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE name = 'gpt-4o' AND provider_id = ?", id2).Scan(&remains); err != nil {
		t.Fatal(err)
	}
	if remains != 1 {
		t.Fatalf("provider2 row remains = %d, want 1", remains)
	}
}
