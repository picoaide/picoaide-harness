package serverstore

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
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
	if version != latestMigration {
		t.Fatalf("version = %d, want %d", version, latestMigration)
	}

	// idempotent
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("second ApplyMigrations: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM schema_migrations").Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	if n != len(migrations) {
		t.Fatalf("migration rows = %d, want %d", n, len(migrations))
	}
}

func TestApplyMigrationsFailure(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("ApplyMigrations: %v", err)
	}
	// Re-apply with a broken migration appended should fail, not panic.
	migrations = append(migrations, migration{version: 999, name: "broken", sql: "THIS IS NOT SQL"})
	defer func() { migrations = migrations[:len(migrations)-1] }()
	if err := ApplyMigrations(db); err == nil {
		t.Fatal("expected error for broken migration, got nil")
	}
}
