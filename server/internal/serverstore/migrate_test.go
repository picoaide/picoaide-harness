package serverstore

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(DBConfig{Path: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return db
}

func TestApplyMigrations(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var version int64
	if err := db.QueryRow("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").Scan(&version); err != nil {
		t.Fatalf("schema_migrations: %v", err)
	}
	if version != latestMigration() {
		t.Fatalf("version = %d, want %d", version, latestMigration())
	}

	// idempotent
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("second ApplyMigrations: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != len(migrationsFor()) {
		t.Fatalf("migration rows = %d, want %d", n, len(migrationsFor()))
	}
}

// TestUsageCreatedAtIndex: 迁移 0025 必须创建 created_at 单列索引,
// 否则 UsageAggregate 的纯日期范围聚合会全表扫描(审计高3)。
func TestUsageCreatedAtIndex(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	var name string
	if err := db.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_usage_time'`).Scan(&name); err != nil {
		t.Fatalf("idx_usage_time missing after migration: %v", err)
	}
	// 索引应覆盖 created_at(纯日期范围过滤的驱动列)
	if _, err := db.Exec(`SELECT COUNT(*) FROM usage WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01'`); err != nil {
		t.Fatalf("query with created_at range: %v", err)
	}
}

func TestApplyMigrationsFailure(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	// Re-apply with a broken migration appended should fail, not panic.
	base := migrationsFor()
	testMigrationHook = func() []migration {
		return append(base, migration{version: 999, name: "broken", sql: "THIS IS NOT SQL"})
	}
	defer func() { testMigrationHook = nil }()
	if err := ApplyMigrations(db); err == nil {
		t.Fatal("expected error for broken migration, got nil")
	}
}

// 0027:user_groups(group_id) 索引(审计 L3:N+1/全表扫治理)——迁移后索引必须存在。
func TestMigration0027UserGroupsGroupIndex(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'index' AND name = 'idx_user_groups_group'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("idx_user_groups_group index missing (n=%d)", n)
	}
}

// 0028:知识库/MCP 表下线,审计表独立为 audit_logs。
// 新库:audit_logs 存在,全部 kb_*/mcp_* 表不存在。
func TestMigration0028AuditCleanupFresh(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var hasAudit int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='audit_logs'`).Scan(&hasAudit); err != nil {
		t.Fatal(err)
	}
	if hasAudit != 1 {
		t.Fatal("audit_logs table missing after migration")
	}
	for _, name := range []string{"kb_audit_logs", "kb_documents", "kb_chunks", "kb_chunks_fts", "kb_folders", "kb_folder_groups", "kb_fts_trigram", "kb_fts", "kb_fts_data", "mcp_servers", "mcp_grants", "mcp_config_downloads"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?`, name).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("table %s should be dropped, found %d", name, n)
		}
	}
}

// 0028 旧库路径:kb_audit_logs 有数据时,数据完整搬入 audit_logs 后旧表被清。
func TestMigration0028AuditCleanupOldDB(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	keep := migrationsFor()
	filtered := make([]migration, 0, len(keep))
	for _, m := range keep {
		// 模拟 0028 之前的旧库:跳过 0028(审计表更名/清理)以及依赖其
		// audit_logs 表的后续迁移(0031 索引会在 audit_logs 上建索引)。
		if m.version >= 28 {
			continue
		}
		filtered = append(filtered, m)
	}
	testMigrationHook = func() []migration { return filtered }
	defer func() { testMigrationHook = nil }()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("pre-0028 apply: %v", err)
	}
	// 旧库手工构造 kb_audit_logs(0028 前 schema 的另一分支:表由 0008 创建,
	// 此处直接重建以模拟存量数据)
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS kb_audit_logs (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		username TEXT NOT NULL,
		action TEXT NOT NULL,
		detail TEXT NOT NULL DEFAULT '',
		created_at DATETIME DEFAULT (datetime('now','localtime'))
	)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO kb_audit_logs (username, action, detail) VALUES
		('admin','mcp_create','mcp#1 xhs'), ('admin','user_create','alice')`); err != nil {
		t.Fatal(err)
	}
	// 应用 0028
	testMigrationHook = func() []migration { return keep }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("apply 0028: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("audit_logs rows = %d, want 2 (migrated)", n)
	}
	var old int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='kb_audit_logs'`).Scan(&old); err != nil {
		t.Fatal(err)
	}
	if old != 0 {
		t.Fatal("kb_audit_logs should be dropped after migration")
	}
}
