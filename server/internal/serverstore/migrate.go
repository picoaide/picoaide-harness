package serverstore

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	name    string
	sql     string
}

// migrations is populated in init() from embedded SQL files sorted by name.
var migrations []migration

// latestMigration is the highest applied version.
var latestMigration int64

func init() {
	entries, err := migrationFS.ReadDir("migrations")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".sql") {
			continue
		}
		// file name format: NNNN_name.sql
		prefix := strings.SplitN(e.Name(), "_", 2)[0]
		v, err := strconv.Atoi(prefix)
		if err != nil {
			continue
		}
		content, err := migrationFS.ReadFile("migrations/" + e.Name())
		if err != nil {
			panic(err)
		}
		migrations = append(migrations, migration{version: v, name: e.Name(), sql: string(content)})
	}
	sort.Slice(migrations, func(i, j int) bool { return migrations[i].version < migrations[j].version })
	if len(migrations) > 0 {
		latestMigration = int64(migrations[len(migrations)-1].version)
	}
}

// ApplyMigrations creates the schema_migrations table and applies all pending
// migrations, each in its own transaction. It is idempotent.
func ApplyMigrations(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at DATETIME DEFAULT (datetime('now','localtime'))
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}
	applied := map[int64]bool{}
	rows, err := db.Query("SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			return err
		}
		applied[v] = true
	}
	rows.Close()

	for _, m := range migrations {
		if applied[int64(m.version)] {
			continue
		}
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(m.sql); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %04d %s: %w", m.version, m.name, err)
		}
		if _, err := tx.Exec("INSERT INTO schema_migrations (version) VALUES (?)", m.version); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// EnsureMigrated opens the DB at path and applies migrations.
func EnsureMigrated(path string) (*sql.DB, error) {
	db, err := Open(path)
	if err != nil {
		return nil, err
	}
	if err := ApplyMigrations(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
