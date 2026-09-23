package serverstore

import (
	"bytes"
	"database/sql"
	"errors"
	"log"
	"strconv"
	"strings"
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

// TestModelInputModalities: 模型输入模态的归一化、存取往返与同步保留(0058)。
func TestModelInputModalities(t *testing.T) {
	db := openTestDB(t)
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p", BaseURL: "http://a", APIKeyEnc: "k"})
	if err != nil {
		t.Fatal(err)
	}
	// AddModel 缺省仅 text;显式 [text,image] 往返一致
	mid, err := AddModel(db, &Model{Name: "vision", ProviderID: pid, DisplayName: "视觉"})
	if err != nil {
		t.Fatal(err)
	}
	m, err := GetModel(db, mid)
	if err != nil {
		t.Fatal(err)
	}
	if len(m.InputModalities) != 1 || m.InputModalities[0] != "text" {
		t.Fatalf("default modalities = %v, want [text]", m.InputModalities)
	}
	mid2, err := AddModel(db, &Model{Name: "v2", ProviderID: pid, InputModalities: []string{"text", "image"}})
	if err != nil {
		t.Fatal(err)
	}
	m2, err := GetModel(db, mid2)
	if err != nil {
		t.Fatal(err)
	}
	if len(m2.InputModalities) != 2 || m2.InputModalities[0] != "text" || m2.InputModalities[1] != "image" {
		t.Fatalf("modalities = %v, want [text image]", m2.InputModalities)
	}
	// UpdateModel 归一化写入
	m2.InputModalities = []string{"text", "image", "text"}
	if err := UpdateModel(db, m2); err != nil {
		t.Fatal(err)
	}
	got, _ := GetModel(db, mid2)
	if len(got.InputModalities) != 2 {
		t.Fatalf("normalize failed: %v", got.InputModalities)
	}
	// SyncProviderModel 重同步不覆盖管理员配置(已有行保持,新行缺省 text)
	if err := SyncProviderModel(db, pid, "v2", `{"max_output":1}`); err != nil {
		t.Fatal(err)
	}
	got, _ = GetModel(db, mid2)
	if len(got.InputModalities) != 2 {
		t.Fatalf("sync overwrote modalities: %v", got.InputModalities)
	}
}

// TestParseNormalizeInputModalities: 解析(空/非法回落 text)与归一化(过滤/去重)。
func TestParseNormalizeInputModalities(t *testing.T) {
	for _, c := range []struct {
		raw  string
		want []string
	}{
		{`["text"]`, []string{"text"}},
		{`["text","image"]`, []string{"text", "image"}},
		{`["image","text"]`, []string{"image", "text"}},
		{``, []string{"text"}},
		{`not-json`, []string{"text"}},
		{`["audio"]`, []string{"text"}},
		{`["text","text"]`, []string{"text"}},
		{`[]`, []string{"text"}},
	} {
		if got := ParseInputModalities(c.raw); len(got) != len(c.want) {
			t.Fatalf("ParseInputModalities(%q) = %v, want %v", c.raw, got, c.want)
		} else {
			for i := range got {
				if got[i] != c.want[i] {
					t.Fatalf("ParseInputModalities(%q) = %v, want %v", c.raw, got, c.want)
				}
			}
		}
	}
	if got := NormalizeInputModalities(nil); len(got) != 1 || got[0] != "text" {
		t.Fatalf("Normalize(nil) = %v, want [text]", got)
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

// 渠道同步排除名单(审计修复 H2):删除渠道同步模型后进名单,此后同步不会把它
// 带回来(webadmin Gateway 页提示「删除后同步不会自动恢复,如需恢复请重新添加」)。
//
// 名单现在是**双向**的(2026-09-19):管理端显式"重新添加"同名渠道模型时移出该名,
// 否则那句提示不可兑现(实测重新添加的模型会在下一轮同步被再删一次)。移出只有
// **事务版** `RemoveExcludedModelTx`(必须与建模型行同事务,否则失败请求会撤销
// 管理员的删除意图);autocommit 版刻意不存在。本用例覆盖添加幂等、读取、以及
// 删除上游时随行清理 —— 移出与幂等语义由 llmgateway 的
// TestRemoveExcludedModelIsIdempotentAndKeepsEmptyList 覆盖。
func TestExcludedModelsAddAndProviderCleanup(t *testing.T) {
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
	// 名单确实落库为 setting(下面「随上游删除清理」的断言因此不是空的)。
	if _, ok, _ := GetSetting(db, excludedModelsKey(pid)); !ok {
		t.Fatal("excluded setting missing after add")
	}
	// 删除上游清理排除名单
	if err := AddExcludedModel(db, pid, "m1"); err != nil {
		t.Fatal(err)
	}
	names, _ = GetExcludedModels(db, pid)
	if len(names) != 2 {
		t.Fatalf("excluded = %v, want 2 entries", names)
	}
	if err := DeleteGatewayProvider(db, pid); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := GetSetting(db, excludedModelsKey(pid)); ok {
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
	if _, err := RecordUsageKind(db, uid, "used", 10, 10, "chat"); err != nil {
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

// TestSyncProviderModelPreservesDefaultParams 覆盖 P2-18:渠道同步不得覆盖
// 管理员配置的 default_params(与 input_modalities 同语义)。
func TestSyncProviderModelPreservesDefaultParams(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-sync", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 首次同步建行:写入同步参数
	if err := SyncProviderModel(db, pid, "sync-model", `{"context_length":128000}`); err != nil {
		t.Fatal(err)
	}
	var params, display string
	if err := db.QueryRow(`SELECT default_params, display_name FROM models WHERE name = 'sync-model'`).Scan(&params, &display); err != nil {
		t.Fatal(err)
	}
	if params != `{"context_length":128000}` {
		t.Fatalf("首次同步 default_params = %s", params)
	}
	// 管理员改配置
	if _, err := db.Exec(`UPDATE models SET default_params = ? WHERE name = 'sync-model'`, `{"concurrency_target":4}`); err != nil {
		t.Fatal(err)
	}
	// 再次同步(上游参数变化)→ 不得覆盖管理员的 default_params
	if err := SyncProviderModel(db, pid, "sync-model", `{"context_length":256000}`); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT default_params, display_name FROM models WHERE name = 'sync-model'`).Scan(&params, &display); err != nil {
		t.Fatal(err)
	}
	if params != `{"concurrency_target":4}` {
		t.Fatalf("同步覆盖了管理员 default_params: %s", params)
	}
	if display != "sync-model" {
		t.Fatalf("display_name = %q, want 同步更新", display)
	}
}

// P1-8 同类(2026-09-08):渠道同步删行必须同步移除 provider JSON 里的名字,
// 否则该名仍可路由而 models 表无价 → 可调用且 cost=0。
func TestRemoveMissingProviderModelsStripsProviderJSON(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-prune", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET models = ? WHERE id = ?`, `["m1","m2"]`, pid); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"m1", "m2"} {
		if err := SyncProviderModel(db, pid, name, `{}`); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := RemoveMissingProviderModels(db, pid, []string{"m2"})
	if err != nil {
		t.Fatal(err)
	}
	if removed != 1 {
		t.Fatalf("removed = %d, want 1", removed)
	}
	var raw string
	if err := db.QueryRow(`SELECT models FROM gateway_providers WHERE id = ?`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != `["m2"]` {
		t.Fatalf("provider JSON = %s, want [\"m2\"] (stale name must be pruned)", raw)
	}
}

// P1-8 同类(2026-09-08):模型改名必须把 provider JSON 的旧名换成新名。
func TestUpdateModelRenameSyncsProviderJSON(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-rename", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET models = ? WHERE id = ?`, `["old-name"]`, pid); err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, pid, "old-name", `{}`); err != nil {
		t.Fatal(err)
	}
	var id int64
	if err := db.QueryRow(`SELECT id FROM models WHERE name = 'old-name'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	m, err := GetModel(db, id)
	if err != nil {
		t.Fatal(err)
	}
	m.Name = "new-name"
	if err := UpdateModel(db, m); err != nil {
		t.Fatal(err)
	}
	var raw string
	if err := db.QueryRow(`SELECT models FROM gateway_providers WHERE id = ?`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != `["new-name"]` {
		t.Fatalf("provider JSON = %s, want [\"new-name\"]", raw)
	}
}

// ---------------------------------------------------------------------------
// G-01(P0)/G-02(P1) 回归(审计 2026-09-23):模型清单同步**不得摧毁运营方定价**
// ---------------------------------------------------------------------------

// modelRowByName 取一行模型(缺行即失败:以下用例关心的正是"行还在")。
func modelRowByName(t *testing.T, db *sql.DB, pid int64, name string) *Model {
	t.Helper()
	var id int64
	if err := db.QueryRow(`SELECT id FROM models WHERE provider_id = ? AND name = ?`, pid, name).Scan(&id); err != nil {
		t.Fatalf("模型行 %s(provider=%d)不存在: %v", name, pid, err)
	}
	m, err := GetModel(db, id)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// assertModelConfigKept 断言价格/缓存价/峰谷折扣/default_params/模态逐字未变。
// want 传 nil = 该字段必须仍为 NULL。
func assertModelConfigKept(t *testing.T, m *Model, in, out, cache, off *float64, params string, modalities []string) {
	t.Helper()
	check := func(label string, got, want *float64) {
		t.Helper()
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Fatalf("%s: got %v, want %v(模型 %s)", label, ptrFloatStr(got), ptrFloatStr(want), m.Name)
		}
	}
	check("input_price_per_1m", m.InputPricePer1M, in)
	check("output_price_per_1m", m.OutputPricePer1M, out)
	check("cache_input_price_per_1m", m.CacheInputPricePer1M, cache)
	check("offpeak_discount", m.OffpeakDiscount, off)
	if m.DefaultParams != params {
		t.Fatalf("default_params: got %q, want %q(模型 %s)", m.DefaultParams, params, m.Name)
	}
	if len(m.InputModalities) != len(modalities) {
		t.Fatalf("input_modalities: got %v, want %v(模型 %s)", m.InputModalities, modalities, m.Name)
	}
	for i := range modalities {
		if m.InputModalities[i] != modalities[i] {
			t.Fatalf("input_modalities: got %v, want %v(模型 %s)", m.InputModalities, modalities, m.Name)
		}
	}
}

func ptrFloatStr(p *float64) string {
	if p == nil {
		return "NULL"
	}
	return strconv.FormatFloat(*p, 'g', -1, 64)
}

// TestSyncProviderModelsKeepsPricingAndParams 覆盖 G-01 的服务端根因:
// 旧 SyncProviderModels 是"DELETE 该 provider 全部 models 行 + 只插三列
// (name, provider_id, display_name)",于是 webadmin 的「编辑上游 → 保存」
// (弹窗**无条件**回传预填的 models 列表)会把该上游全部模型的价格/缓存价/
// 峰谷折扣/default_params/input_modalities 清零 —— 之后调用照常 200、
// token 照记、cost=0。修法 = 按 name upsert + 只剪枝清单外的行。
func TestSyncProviderModelsKeepsPricingAndParams(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-keep", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModels(db, pid, []string{"m1", "m2"}); err != nil {
		t.Fatal(err)
	}
	id := modelRowByName(t, db, pid, "m1").ID
	in, out, cache, off := 30.0, 60.0, 3.0, 0.5
	const params = `{"max_output":123,"context_length":65536}`
	if err := UpdateModel(db, &Model{
		ID: id, Name: "m1", ProviderID: pid, DisplayName: "M1",
		DefaultParams: params, InputModalities: []string{"text", "image"},
		InputPricePer1M: &in, OutputPricePer1M: &out, CacheInputPricePer1M: &cache, OffpeakDiscount: &off,
	}); err != nil {
		t.Fatal(err)
	}

	// ① 同一清单再同步一次:「编辑上游 → 原样保存」的服务端路径,必须是无操作。
	if err := SyncProviderModels(db, pid, []string{"m1", "m2"}); err != nil {
		t.Fatal(err)
	}
	assertModelConfigKept(t, modelRowByName(t, db, pid, "m1"), &in, &out, &cache, &off, params, []string{"text", "image"})

	// ② 清单**真的**新增模型时,既有行同样不得被重建(upsert 语义)。
	if err := SyncProviderModels(db, pid, []string{"m1", "m2", "m3"}); err != nil {
		t.Fatal(err)
	}
	assertModelConfigKept(t, modelRowByName(t, db, pid, "m1"), &in, &out, &cache, &off, params, []string{"text", "image"})

	// ③ 剪枝:管理员从清单里删掉的模型必须真的不再路由(行删除)。
	if err := SyncProviderModels(db, pid, []string{"m1", "m3"}); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM models WHERE provider_id = ? AND name = 'm2'`, pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("m2 行数 = %d, want 0(不在清单里的行必须被剪枝)", n)
	}
	assertModelConfigKept(t, modelRowByName(t, db, pid, "m1"), &in, &out, &cache, &off, params, []string{"text", "image"})
}

// TestRemoveMissingProviderModelsKeepsPricedRows 覆盖 G-02:
// 上游 /models 目录**部分抖动**(一轮超时/降级/返回子集)不得物理删除带运营方
// 定价/参数的行 —— 旧行为是 DELETE(价格一并消失),下一轮目录恢复时以新行插回
// (价格 NULL)⇒ 该模型**永久免费**,而且无日志无审计。
func TestRemoveMissingProviderModelsKeepsPricedRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-bounce", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	const params = `{"context_length":128000,"max_output":8192}`
	if err := SyncProviderModel(db, pid, "priced", params); err != nil {
		t.Fatal(err)
	}
	in, out := 3.0, 7.0
	if err := UpdateModel(db, &Model{
		ID: modelRowByName(t, db, pid, "priced").ID, Name: "priced", ProviderID: pid,
		DisplayName: "priced", DefaultParams: params, InputModalities: []string{"text", "image"},
		InputPricePer1M: &in, OutputPricePer1M: &out,
	}); err != nil {
		t.Fatal(err)
	}
	// 对照:一个不带任何运营方配置的行(同步默认参数为空、无价)仍按旧行为物理删除
	if err := SyncProviderModel(db, pid, "bare", `{}`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE gateway_providers SET models = ? WHERE id = ?`, `["priced","bare"]`, pid); err != nil {
		t.Fatal(err)
	}

	prevWriter := log.Writer()
	var buf bytes.Buffer
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(prevWriter) })

	// 目录抖动:一轮里两个模型都不在上游目录中
	removed, err := RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 2 {
		t.Fatalf("removed = %d, want 2(1 行标记停用 + 1 行物理删除)", removed)
	}
	// ① 有价行仍在,价格/参数/模态一字未改
	priced := modelRowByName(t, db, pid, "priced")
	assertModelConfigKept(t, priced, &in, &out, nil, nil, params, []string{"text", "image"})
	// ② 标记为"目录缺失"(路由与客户端目录据此过滤)
	if !priced.CatalogMissing {
		t.Fatalf("catalog_missing = false, want true(有价行必须被标记停用而不是删除)")
	}
	// ③ provider JSON 里的名字已移除(否则仍会被路由匹配到)
	var raw string
	if err := db.QueryRow(`SELECT models FROM gateway_providers WHERE id = ?`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "priced") {
		t.Fatalf("provider JSON = %s, want 不含 priced", raw)
	}
	// ④ 未带运营方配置的行仍物理删除
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM models WHERE provider_id = ? AND name = 'bare'`, pid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("bare 行数 = %d, want 0", n)
	}
	// ⑤ 停用有价行必须留下**可检索的 warning 日志**(含 provider id 与模型名)
	logged := buf.String()
	for _, want := range []string{"catalog_missing", "priced", strconv.FormatInt(pid, 10)} {
		if !strings.Contains(logged, want) {
			t.Fatalf("目录缺失告警日志缺少 %q: %q", want, logged)
		}
	}
	// ⑥ 幂等:再删一轮不得重复计数(已标记的行不参与第二轮)
	again, err := RemoveMissingProviderModels(db, pid, nil)
	if err != nil {
		t.Fatal(err)
	}
	if again != 0 {
		t.Fatalf("removed(第二轮) = %d, want 0", again)
	}
	// ⑦ 目录恢复:同名 upsert 清标记、名字回到 provider JSON,价格不变
	if err := SyncProviderModel(db, pid, "priced", params); err != nil {
		t.Fatal(err)
	}
	recovered := modelRowByName(t, db, pid, "priced")
	if recovered.CatalogMissing {
		t.Fatalf("目录恢复后 catalog_missing 仍为 true(模型永久不可路由)")
	}
	assertModelConfigKept(t, recovered, &in, &out, nil, nil, params, []string{"text", "image"})
	if err := db.QueryRow(`SELECT models FROM gateway_providers WHERE id = ?`, pid).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(raw, "priced") {
		t.Fatalf("provider JSON = %s, want 含 priced(目录恢复后名字应回到清单)", raw)
	}
}

// TestModelConfigLookupsSkipCatalogMissingRows：N-4(2026-09-23,P3)——
// ModelDefaultParams / ModelCachePrice 与路由（syncedModelNames / ListModels）
// 同口径排除 catalog_missing = TRUE 的行。
//
// 为什么值得钉：这是个"当前不可达但同族"的口径分裂 —— 取参/取缓存价的退化方向
// 是安全的（未找到 ⇒ 回落 128K 补估上限 / 回落输入价），而 ModelPrices（取价
// 兜底）**故意不排除**（退化成 0 = 免费，比用停用行的价更差）。三种退化方向不同，
// 必须由用例把"谁过滤谁不过滤"钉死，否则下一次重构会把它们统一成一条 SQL。
func TestModelConfigLookupsSkipCatalogMissingRows(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	const params = `{"context_length":64000,"max_output":4096}`
	in, out, cache := 3.0, 7.0, 1.5

	mk := func(name string) int64 {
		pid, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-" + name, BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
		if err != nil {
			t.Fatal(err)
		}
		if err := SyncProviderModel(db, pid, name, params); err != nil {
			t.Fatal(err)
		}
		if err := UpdateModel(db, &Model{
			ID: modelRowByName(t, db, pid, name).ID, Name: name, ProviderID: pid,
			DisplayName: name, DefaultParams: params, InputModalities: []string{"text"},
			InputPricePer1M: &in, OutputPricePer1M: &out, CacheInputPricePer1M: &cache,
		}); err != nil {
			t.Fatal(err)
		}
		return pid
	}

	// solo：唯一一行被标记目录缺失 ⇒ 取参与取缓存价都必须"查不到"，取价兜底仍保留。
	soloPID := mk("solo")
	// dup：两行同名，低 id 的那行被标记缺失 ⇒ 取缓存价必须落到**高 id 的活行**上
	// （不过滤时按 ORDER BY provider_id LIMIT 1 会取到缺失行的 1.5）。
	dupMissingPID := mk("dup")
	const dupLiveCache = 9.0
	dupLivePID, err := AddGatewayProvider(db, &GatewayProvider{Name: "p-dup-live", BaseURL: "http://a", APIKeyEnc: "k", Enabled: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncProviderModel(db, dupLivePID, "dup", params); err != nil {
		t.Fatal(err)
	}
	liveCache := dupLiveCache
	if err := UpdateModel(db, &Model{
		ID: modelRowByName(t, db, dupLivePID, "dup").ID, Name: "dup", ProviderID: dupLivePID,
		DisplayName: "dup", DefaultParams: params, InputModalities: []string{"text"},
		InputPricePer1M: &in, OutputPricePer1M: &out, CacheInputPricePer1M: &liveCache,
	}); err != nil {
		t.Fatal(err)
	}
	if dupMissingPID >= dupLivePID {
		t.Fatalf("夹具失效:缺失行 provider_id=%d 必须小于活行 %d（否则测不出 ORDER BY 取首行）", dupMissingPID, dupLivePID)
	}
	// 目录抖动：两家的名字都不在目录里 ⇒ 有价行被标记缺失（不物理删除）。
	if _, err := RemoveMissingProviderModels(db, soloPID, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := RemoveMissingProviderModels(db, dupMissingPID, nil); err != nil {
		t.Fatal(err)
	}
	if !modelRowByName(t, db, soloPID, "solo").CatalogMissing {
		t.Fatal("夹具失效:solo 未被标记 catalog_missing")
	}

	// ① 唯一行缺失 ⇒ 取参返回 ErrNotFound（调用方回落默认窗口），不再把停用行的参数当生效配置。
	if got, err := ModelDefaultParams(db, "solo"); !errors.Is(err, ErrNotFound) || got != "" {
		t.Fatalf("ModelDefaultParams(catalog_missing) = (%q, %v), want (\"\", ErrNotFound)", got, err)
	}
	// ② 唯一行缺失 ⇒ 缓存价 0（costOfAt 随即回落按输入价计费）。
	if got := ModelCachePrice(db, "solo"); got != 0 {
		t.Fatalf("ModelCachePrice(catalog_missing) = %v, want 0", got)
	}
	// ③ 取价兜底**故意不过滤**：宁可沿用停用行的价，也不能退化成 0（免费）。
	if gotIn, gotOut, _ := ModelPrices(db, "solo"); gotIn != in || gotOut != out {
		t.Fatalf("ModelPrices(catalog_missing) = (%v,%v), want (%v,%v) —— 取价兜底不得因标记而变成 0",
			gotIn, gotOut, in, out)
	}
	// ④ 同名两行：缺失行 id 更小，但取缓存价必须落到活行。
	if got := ModelCachePrice(db, "dup"); got != dupLiveCache {
		t.Fatalf("ModelCachePrice(dup) = %v, want %v（活行；取到 %v 说明未排除 catalog_missing）",
			got, dupLiveCache, cache)
	}
	// ⑤ 目录恢复：标记清除后两处都恢复原值。
	if err := SyncProviderModel(db, soloPID, "solo", params); err != nil {
		t.Fatal(err)
	}
	if got, err := ModelDefaultParams(db, "solo"); err != nil || got != params {
		t.Fatalf("目录恢复后 ModelDefaultParams(solo) = (%q, %v), want (%q, nil)", got, err, params)
	}
	if got := ModelCachePrice(db, "solo"); got != cache {
		t.Fatalf("目录恢复后 ModelCachePrice(solo) = %v, want %v", got, cache)
	}
}
