package serverstore

import (
	"database/sql"
	"embed"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

//go:embed migrations/*.sql migrations-pg/*.sql
var migrationFS embed.FS

type migration struct {
	version int
	name    string
	sql     string
}

// testMigrationHook, when non-nil (tests only), overrides the migration set
// so failure paths can be exercised without a real broken embed.
var testMigrationHook func() []migration

// migrationsFor returns the embedded migration set for the current driver.
// SQLite uses migrations/, PostgreSQL uses migrations-pg/ (same version
// numbers, backend-appropriate DDL). Sorted by version ascending.
func migrationsFor() []migration {
	if testMigrationHook != nil {
		return testMigrationHook()
	}
	dir := "migrations"
	if currentDriver == DriverPG {
		dir = "migrations-pg"
	}
	entries, err := migrationFS.ReadDir(dir)
	if err != nil {
		panic(err)
	}
	var out []migration
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
		content, err := migrationFS.ReadFile(dir + "/" + e.Name())
		if err != nil {
			panic(err)
		}
		out = append(out, migration{version: v, name: e.Name(), sql: string(content)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].version < out[j].version })
	return out
}

// latestMigration returns the highest migration version for the current driver.
func latestMigration() int64 {
	ms := migrationsFor()
	if len(ms) == 0 {
		return 0
	}
	return int64(ms[len(ms)-1].version)
}

// init embedded FS is validated at package init: both migration dirs must
// exist and parse.
func init() {
	for _, dir := range []string{"migrations", "migrations-pg"} {
		if _, err := migrationFS.ReadDir(dir); err != nil {
			panic(fmt.Sprintf("migrations dir %s: %v", dir, err))
		}
	}
}

// ApplyMigrations creates the schema_migrations table and applies all pending
// migrations, each in its own transaction. It is idempotent.
func ApplyMigrations(db *sql.DB) error {
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at ` + TimestampType() + ` DEFAULT (` + NowExpr() + `)
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

	for _, m := range migrationsFor() {
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

// EnsureMigrated opens the DB with the given config and applies migrations.
func EnsureMigrated(cfg DBConfig) (*sql.DB, error) {
	db, err := Open(cfg)
	if err != nil {
		return nil, err
	}
	if err := ApplyMigrations(db); err != nil {
		db.Close()
		return nil, err
	}
	return db, nil
}
