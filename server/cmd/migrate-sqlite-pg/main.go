// migrate-sqlite-pg migrates all data from an existing SQLite database into a
// PostgreSQL database whose schema is already applied (migrations-pg).
//
// Usage:
//
//	-sqlite /data/picoaide-next/picoaide.db
//	-pg-dsn postgres://user:pass@host:5432/db?sslmode=disable
//	-dry-run  print row counts, write nothing
//
// Timestamps stored by SQLite as local wall-clock strings are converted to
// RFC3339 with local offset so PG TIMESTAMPTZ stores the same instant.
package main

import (
	"database/sql"
	"flag"
	"fmt"
	"log"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/picoaide/picoaide/internal/serverstore"
)

type column struct {
	name      string
	timestamp bool
}

type table struct {
	name       string
	columns    []column
	idSequence string
}

func main() {
	sqlitePath := flag.String("sqlite", "", "source SQLite database file")
	pgDSN := flag.String("pg-dsn", "", "target PostgreSQL DSN")
	dryRun := flag.Bool("dry-run", false, "print counts without writing")
	flag.Parse()

	if *sqlitePath == "" || *pgDSN == "" {
		log.Fatal("-sqlite and -pg-dsn are required")
	}

	src, err := sql.Open("sqlite", "file:"+*sqlitePath+"?_timezone=Local")
	if err != nil {
		log.Fatalf("open sqlite: %v", err)
	}
	defer src.Close()
	if err := src.Ping(); err != nil {
		log.Fatalf("sqlite ping: %v", err)
	}

	// PG opened through serverstore so the `?` -> `$N` rewrite layer applies.
	dst, err := serverstore.Open(serverstore.DBConfig{Driver: serverstore.DriverPG, DSN: *pgDSN})
	if err != nil {
		log.Fatalf("open pg: %v", err)
	}
	defer dst.Close()

	tables := []table{
		// INSERT order follows FK dependencies: parents first, children after.
		{name: "users", idSequence: "users_id_seq", columns: []column{
			{name: "id"}, {name: "username"}, {name: "display_name"}, {name: "email"},
			{name: "password_hash"}, {name: "source"}, {name: "is_admin"}, {name: "status"},
			{name: "created_at", timestamp: true}, {name: "updated_at", timestamp: true},
			{name: "quota_tokens"}, {name: "quota_money"},
		}},
		{name: "groups", idSequence: "groups_id_seq", columns: []column{
			{name: "id"}, {name: "name"}, {name: "parent_id"}, {name: "leader_id"},
			{name: "description"}, {name: "created_at", timestamp: true}, {name: "budget_money"},
		}},
		{name: "gateway_providers", idSequence: "gateway_providers_id_seq", columns: []column{
			{name: "id"}, {name: "name"}, {name: "base_url"}, {name: "api_key_enc"},
			{name: "models"}, {name: "enabled"}, {name: "channel"},
		}},
		{name: "models", idSequence: "models_id_seq", columns: []column{
			{name: "id"}, {name: "name"}, {name: "provider_id"}, {name: "display_name"},
			{name: "default_params"}, {name: "input_price_per_1m"}, {name: "output_price_per_1m"},
			{name: "offpeak_discount"}, {name: "cache_input_price_per_1m"},
		}},
		{name: "settings", columns: []column{{name: "key"}, {name: "value"}}},
		{name: "skills", idSequence: "skills_id_seq", columns: []column{
			{name: "id"}, {name: "name"}, {name: "version"}, {name: "description"},
			{name: "author"}, {name: "git_url"}, {name: "git_ref"}, {name: "checksum"},
			{name: "enabled"}, {name: "created_at", timestamp: true}, {name: "updated_at", timestamp: true},
		}},
		{name: "skill_grants", columns: []column{{name: "skill_name"}, {name: "grantee_type"}, {name: "grantee"}}},
		{name: "user_groups", columns: []column{{name: "user_id"}, {name: "group_id"}}},
		{name: "usage", idSequence: "usage_id_seq", columns: []column{
			{name: "id"}, {name: "user_id"}, {name: "model"}, {name: "prompt_tokens"},
			{name: "completion_tokens"}, {name: "created_at", timestamp: true},
			{name: "kind"}, {name: "cost"}, {name: "cache_prompt_tokens"},
		}},
		{name: "api_tokens", idSequence: "api_tokens_id_seq", columns: []column{
			{name: "id"}, {name: "user_id"}, {name: "token_hash"}, {name: "name"},
			{name: "created_at", timestamp: true}, {name: "expires_at", timestamp: true},
			{name: "last_used_at", timestamp: true}, {name: "revoked"},
		}},
		{name: "audit_logs", idSequence: "audit_logs_id_seq", columns: []column{
			{name: "id"}, {name: "username"}, {name: "action"}, {name: "detail"},
			{name: "created_at", timestamp: true},
		}},
		{name: "admin_sessions", columns: []column{ // id is TEXT PK (0009), no sequence
			{name: "id"}, {name: "user_id"}, {name: "csrf_key"}, {name: "expires_at", timestamp: true},
		}},
	}

	for _, t := range tables {
		n, err := migrateTable(src, dst, t, *dryRun)
		if err != nil {
			log.Fatalf("migrate %s: %v", t.name, err)
		}
		fmt.Printf("%-18s %d rows\n", t.name, n)
	}
	fmt.Println("DONE")
}

func migrateTable(src, dst *sql.DB, t table, dryRun bool) (int64, error) {
	cols := make([]string, len(t.columns))
	for i, c := range t.columns {
		cols[i] = c.name
	}
	placeholders := make([]string, len(cols))
	for i := range placeholders {
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}

	var n int64
	if err := src.QueryRow("SELECT COUNT(*) FROM " + t.name).Scan(&n); err != nil {
		return 0, err
	}
	if dryRun {
		return n, nil
	}
	if n == 0 {
		return 0, nil
	}

	rows, err := src.Query("SELECT " + strings.Join(cols, ", ") + " FROM " + t.name + " ORDER BY 1")
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	var batch []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return 0, err
		}
		row := map[string]any{}
		for i, c := range t.columns {
			row[c.name] = vals[i]
		}
		batch = append(batch, row)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}

	tx, err := dst.Begin()
	if err != nil {
		return 0, err
	}
	// Destination must be pre-emptied (TRUNCATE ... CASCADE) before running:
	// we only INSERT here, in dependency order, so FK child rows come after
	// their parents and never attempt to clear rows mid-migration.

	insQ := "INSERT INTO " + t.name + " (" + strings.Join(cols, ", ") + ") VALUES (" + strings.Join(placeholders, ", ") + ")"
	stmt, err := tx.Prepare(insQ)
	if err != nil {
		tx.Rollback()
		return 0, err
	}
	for _, row := range batch {
		args := make([]any, len(cols))
		for i, c := range t.columns {
			v := row[c.name]
			if c.timestamp {
				if s, ok := v.(string); ok && s != "" {
					v = convertSQLiteTime(s)
				} else if b, ok := v.([]byte); ok {
					s := string(b)
					if s != "" {
						v = convertSQLiteTime(s)
					}
				}
			}
			args[i] = v
		}
		if _, err := stmt.Exec(args...); err != nil {
			stmt.Close()
			tx.Rollback()
			return 0, fmt.Errorf("%s row %v: %w", t.name, args[0], err)
		}
	}
	stmt.Close()

	if t.idSequence != "" {
		if _, err := tx.Exec(fmt.Sprintf("SELECT setval('%s', COALESCE((SELECT MAX(id) FROM %s), 1))", t.idSequence, t.name)); err != nil {
			tx.Rollback()
			return 0, fmt.Errorf("setval %s: %w", t.idSequence, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

func convertSQLiteTime(s string) string {
	for _, f := range []string{"2006-01-02 15:04:05", time.RFC3339, "2006-01-02 15:04:05.999999999"} {
		if t, err := time.ParseInLocation(f, s, time.Local); err == nil {
			return t.Format(time.RFC3339)
		}
	}
	return s
}
