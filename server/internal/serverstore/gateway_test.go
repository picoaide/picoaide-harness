package serverstore

import (
	"errors"
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

func TestSyncProviderModelsDedupesNames(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	// 重名模型列表不得触发 UNIQUE 冲突(原实现第二个 INSERT 失败 → 半同步 + 500)
	if err := SyncProviderModels(db, pid, []string{"m", "m", "x"}); err != nil {
		t.Fatalf("SyncProviderModels with duplicate names: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE provider_id = ?", pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("model rows = %d, want 2", n)
	}
}

func TestDeleteModelClearsDefaultModel(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "def", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, "gateway.default_model", "def"); err != nil {
		t.Fatal(err)
	}
	mid, err := AddModel(db, &Model{Name: "def", ProviderID: pid, DisplayName: "def"})
	if err == nil {
		t.Fatal("duplicate model insert should fail") // def 已由 SyncProviderModel 建行
	}
	// 找到 def 行 id 再删
	var id int64
	if err := db.QueryRow("SELECT id FROM models WHERE name = 'def'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	_ = mid
	if err := DeleteModel(db, id); err != nil {
		t.Fatal(err)
	}
	v, ok, _ := GetSetting(db, "gateway.default_model")
	if !ok || v != "" {
		t.Fatalf("default_model = %q ok=%v, want cleared", v, ok)
	}
}

func TestDeleteProviderClearsDefaultModel(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "def", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, "gateway.default_model", "def"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteGatewayProvider(db, pid); err != nil {
		t.Fatal(err)
	}
	v, ok, _ := GetSetting(db, "gateway.default_model")
	if !ok || v != "" {
		t.Fatalf("default_model = %q ok=%v, want cleared", v, ok)
	}
}

// 渠道同步排除名单(审计修复 H2):增删查与幂等。
func TestExcludedModelsCRUD(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := AddExcludedModel(db, pid, "deepseek-chat"); err != nil {
		t.Fatal(err)
	}
	// 幂等:重复添加不报错、不重复
	if err := AddExcludedModel(db, pid, "deepseek-chat"); err != nil {
		t.Fatal(err)
	}
	names, err := GetExcludedModels(db, pid)
	if err != nil || len(names) != 1 || names[0] != "deepseek-chat" {
		t.Fatalf("excluded = %v %v, want [deepseek-chat]", names, err)
	}
	// 移除后名单清空(删除 setting)
	if err := RemoveExcludedModel(db, pid, "deepseek-chat"); err != nil {
		t.Fatal(err)
	}
	names, _ = GetExcludedModels(db, pid)
	if len(names) != 0 {
		t.Fatalf("excluded after remove = %v, want empty", names)
	}
	_, ok, _ := GetSetting(db, excludedModelsKey(pid))
	if ok {
		t.Fatal("excluded setting should be deleted when empty")
	}
	// 删除上游清理排除名单
	if err := AddExcludedModel(db, pid, "m1"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteGatewayProvider(db, pid); err != nil {
		t.Fatal(err)
	}
	_, ok, _ = GetSetting(db, excludedModelsKey(pid))
	if ok {
		t.Fatal("excluded setting should be cleaned up with provider")
	}
}

// ModelHasUsage(审计修复 M7):有用量记录的模型返回 true。
func TestModelHasUsage(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "used", `{}`); err != nil {
		t.Fatal(err)
	}
	has, err := ModelHasUsage(db, "used")
	if err != nil || has {
		t.Fatalf("has usage before record = %v %v, want false", has, err)
	}
	uid, err := CreateUser(db, &User{Username: "u", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, uid, "used", 10, 10); err != nil {
		t.Fatal(err)
	}
	has, err = ModelHasUsage(db, "used")
	if err != nil || !has {
		t.Fatalf("has usage after record = %v %v, want true", has, err)
	}
}

// 模型改名撞 UNIQUE → ErrDuplicate(审计修复 M2):此前落 500。
func TestUpdateModelDuplicateName(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "m1", `{}`); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "m2", `{}`); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := db.QueryRow("SELECT id FROM models WHERE name = 'm2'").Scan(&id); err != nil {
		t.Fatal(err)
	}
	m, err := GetModel(db, id)
	if err != nil {
		t.Fatal(err)
	}
	m.Name = "m1"
	if err := UpdateModel(db, m); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("rename to existing = %v, want ErrDuplicate", err)
	}
}

// 上游改名撞 UNIQUE → ErrDuplicate(审计修复 M2)。
func TestUpdateGatewayProviderDuplicateName(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := AddGatewayProvider(db, &GatewayProvider{Name: "p1", BaseURL: "http://a", APIKeyEnc: "k"}); err != nil {
		t.Fatal(err)
	}
	p2, err := AddGatewayProvider(db, &GatewayProvider{Name: "p2", BaseURL: "http://b", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	p, err := GetGatewayProvider(db, p2)
	if err != nil {
		t.Fatal(err)
	}
	p.Name = "p1"
	if err := UpdateGatewayProvider(db, p); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("rename provider to existing = %v, want ErrDuplicate", err)
	}
}

// ListAdminModels 展示全部模型(含已停用上游的,审计修复 M3):
// 客户端可见性由 ListModels 的 enabled 过滤单独控制。
func TestListAdminModelsIncludesDisabledProvider(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "m1", `{}`); err != nil {
		t.Fatal(err)
	}
	p, err := GetGatewayProvider(db, pid)
	if err != nil {
		t.Fatal(err)
	}
	p.Enabled = 0
	if err := UpdateGatewayProvider(db, p); err != nil {
		t.Fatal(err)
	}
	all, err := ListAdminModels(db)
	if err != nil || len(all) != 1 {
		t.Fatalf("ListAdminModels = %d models (%v), want 1 (disabled provider's model still listed)", len(all), err)
	}
	if all[0].ProviderName != "p" || all[0].ProviderEnabled {
		t.Fatalf("provider fields = %+v, want name=p enabled=false", all[0])
	}
	// 客户端列表必须过滤禁用上游(公开 ListModels 的 WHERE p.enabled = 1 在
	// llmgateway 包测试中验证;这里直接查库确认行仍在、仅标记 enabled=0)
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM models WHERE provider_id = ?", pid).Scan(&n); err != nil || n != 1 {
		t.Fatalf("model rows = %d (%v), want 1", n, err)
	}
}
