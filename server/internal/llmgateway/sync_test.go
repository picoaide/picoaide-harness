package llmgateway

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func syncTestDB(t *testing.T) *sql.DB {
	t.Helper()
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	// sync 测试自给自足:显式接线 DecryptSecret(此前依赖其它测试文件的
	// 全局副作用,单独跑 sync 用例即失败)。密钥内容对假上游无意义。
	prev := DecryptSecret
	DecryptSecret = func(s string) (string, error) { return s, nil }
	t.Cleanup(func() { DecryptSecret = prev })
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/sync.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	enc, err := encryptSecret("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	p := &serverstore.GatewayProvider{Name: "deepseek", BaseURL: "https://api.deepseek.com", APIKeyEnc: enc, Channel: "deepseek", Enabled: 1}
	if _, err := serverstore.AddGatewayProvider(db, p); err != nil {
		t.Fatal(err)
	}
	return db
}

// 无渠道(手动型)provider 不该被自动同步,但 sync-all 必须给出明确原因
// 而不是静默跳过——否则管理员点"立即同步"不知道发生了什么。
func TestSyncOnceReportsUnchanneled(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/sync.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	enc, err := encryptSecret("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	p := &serverstore.GatewayProvider{Name: "manual", BaseURL: "https://custom.example.com", APIKeyEnc: enc, Channel: "", Enabled: 1}
	if _, err := serverstore.AddGatewayProvider(db, p); err != nil {
		t.Fatal(err)
	}
	results, err := SyncOnce(db, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 || results[0].Error == "" {
		t.Fatalf("unchanneled provider must report a reason: %+v", results)
	}
	if !strings.Contains(results[0].Error, "手动") {
		t.Fatalf("error should explain the manual path: %q", results[0].Error)
	}
}

func TestSyncOnceAddsNewModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	models, err := ListModels(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(models) != 2 {
		t.Fatalf("models = %+v", models)
	}
}

func TestSyncOnceRemovesGoneModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	fetchFn2 := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn2); err != nil {
		t.Fatal(err)
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-pro" {
		t.Fatalf("models after removal = %+v", models)
	}
}

func TestSyncEmptyFetchKeepsModels(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	// transient upstream quirk: empty data list
	empty := func(url string) ([]byte, error) {
		return []byte(`{"data":[]}`), nil
	}
	if _, err := SyncOnce(db, empty); err != nil {
		t.Fatal(err)
	}
	models, _ := ListModels(db)
	if len(models) != 2 {
		t.Fatalf("empty fetch wiped models: %+v", models)
	}
}

func TestSyncOnceFetchFailureSkips(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return nil, fmt.Errorf("boom")
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatalf("SyncOnce should tolerate fetch failure, got %v", err)
	}
	models, _ := ListModels(db)
	if len(models) != 0 {
		t.Fatalf("no models expected, got %+v", models)
	}
}

// C-9: CleanupPendingUsage runs on every sync iteration, so stale pending
// usage rows cannot accumulate between restarts.
func TestSyncIterationCleansPendingUsage(t *testing.T) {
	db := syncTestDB(t)
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "u-cleanup", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	id, err := serverstore.RecordUsage(db, uid, "m", 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?",
		time.Now().Add(-2*time.Hour).Format("2006-01-02 15:04:05"), id); err != nil {
		t.Fatal(err)
	}
	fetchFn := func(url string) ([]byte, error) { return []byte(`{"data":[]}`), nil }
	if _, err := SyncIteration(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM usage").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("stale pending usage rows = %d, want 0", n)
	}
}

// 审计修复 M5:added = 本次真正新增数,而非目录全量;重复同步应为 0。
func TestSyncProviderAddedIsIncremental(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	res, err := SyncOnce(db, fetchFn)
	if err != nil || len(res) != 1 {
		t.Fatalf("first sync: %+v %v", res, err)
	}
	if res[0].Added != 2 || res[0].Removed != 0 {
		t.Fatalf("first sync added/removed = %d/%d, want 2/0", res[0].Added, res[0].Removed)
	}
	// 相同目录再同步:无新增、无移除
	res, err = SyncOnce(db, fetchFn)
	if err != nil || len(res) != 1 {
		t.Fatalf("second sync: %+v %v", res, err)
	}
	if res[0].Added != 0 || res[0].Removed != 0 {
		t.Fatalf("second sync added/removed = %d/%d, want 0/0 (incremental)", res[0].Added, res[0].Removed)
	}
	// 上游新增一个:只报 1
	fetchFn2 := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"},{"id":"deepseek-v4-new"}]}`), nil
	}
	res, _ = SyncOnce(db, fetchFn2)
	if res[0].Added != 1 || res[0].Removed != 0 {
		t.Fatalf("third sync added/removed = %d/%d, want 1/0", res[0].Added, res[0].Removed)
	}
}

// 审计修复 H2:排除名单中的模型(管理端删除的渠道同步模型)不被同步复活。
func TestSyncExcludedModelNotResurrected(t *testing.T) {
	db := syncTestDB(t)
	fetchFn := func(url string) ([]byte, error) {
		return []byte(`{"data":[{"id":"deepseek-v4-flash"},{"id":"deepseek-v4-pro"}]}`), nil
	}
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	// 管理端删除 deepseek-v4-flash(等价于 DELETE /api/admin/models 记入排除名单)
	p, _ := serverstore.ListGatewayProviders(db)
	if err := serverstore.AddExcludedModel(db, p[0].ID, "deepseek-v4-flash"); err != nil {
		t.Fatal(err)
	}
	// 直接删行(模拟删除动作后的表状态)
	if _, err := db.Exec("DELETE FROM models WHERE name = 'deepseek-v4-flash'"); err != nil {
		t.Fatal(err)
	}
	// 再次同步:排除名单中的模型不复活
	if _, err := SyncOnce(db, fetchFn); err != nil {
		t.Fatal(err)
	}
	models, _ := ListModels(db)
	if len(models) != 1 || models[0].ID != "deepseek-v4-pro" {
		t.Fatalf("models after sync with exclusion = %+v, want [deepseek-v4-pro]", models)
	}
}

// 审计修复 L8:手动型上游在 sync-all 中标记 Skipped 而非伪装成错误噪音。
func TestSyncOnceManualProviderSkipped(t *testing.T) {
	db, err := serverstore.EnsureMigrated(fmt.Sprintf("%s/sync.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	t.Setenv("PICOAI_MASTER_KEY", "0123456789abcdef0123456789abcdef")
	enc, err := encryptSecret("sk-test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.AddGatewayProvider(db, &serverstore.GatewayProvider{
		Name: "manual", BaseURL: "https://custom.example.com", APIKeyEnc: enc, Channel: "", Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	results, err := SyncOnce(db, nil)
	if err != nil || len(results) != 1 {
		t.Fatalf("SyncOnce = %+v %v", results, err)
	}
	if !results[0].Skipped {
		t.Fatalf("manual provider should be marked skipped: %+v", results[0])
	}
}
