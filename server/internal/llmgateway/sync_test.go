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
