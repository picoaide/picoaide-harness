package serverstore

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"
)

// PgTestDSN returns the PostgreSQL test DSN template (exported for
// cross-package tests). Override via PG_DSN_TEST (e.g. CI sets
// postgres://picoaide:ci@postgres:5432/picoaide_test). Default matches a
// local dev PG (postgres/postgres).
func PgTestDSN() string {
	if dsn := os.Getenv("PG_DSN_TEST"); dsn != "" {
		return dsn
	}
	return "postgres://postgres:postgres@127.0.0.1:5432/picoaide_test?sslmode=disable"
}

// NewTestDB creates an isolated temporary PostgreSQL database for one test
// (CREATE DATABASE picoaide_test_<rand>), applies migrations, and returns a
// connection plus a cleanup func that drops the database. Each test gets a
// fresh schema — no cross-test interference (shared-database truncation turned
// out to leak runs between tests).
func NewTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	adminDSN := PgTestDSN()
	u, err := url.Parse(adminDSN)
	if err != nil {
		t.Fatalf("parse test dsn: %v", err)
	}
	suffix := randomSuffix(6)
	dbName := "picoaide_test_" + suffix
	// 连 admin 库(postgres)建临时库
	adminURL := *u
	adminURL.Path = "/postgres"
	adminURL.RawQuery = rewriteDSNQuery(adminURL.RawQuery, "connect_timeout", "5")
	admin, err := sql.Open("pgx", adminURL.String())
	if err != nil {
		t.Fatalf("open admin db: %v", err)
	}
	if _, err := admin.Exec("CREATE DATABASE " + dbName); err != nil {
		admin.Close()
		t.Fatalf("create test db %s: %v", dbName, err)
	}
	// 连临时库
	u.Path = "/" + dbName
	db, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		admin.Close()
		t.Fatalf("open test db: %v", err)
	}
	if err := ApplyMigrations(db); err != nil {
		db.Close()
		admin.Close()
		t.Fatalf("apply migrations: %v", err)
	}
	// 预建历史+未来分区,覆盖测试硬编码月份(2026-07/08/09 等),避免 no partition
	if err := ensureTestPartitions(db); err != nil {
		db.Close()
		admin.Close()
		t.Fatalf("ensure test partitions: %v", err)
	}
	cleanup := func() {
		db.Close()
		if _, err := admin.Exec("DROP DATABASE IF EXISTS " + dbName + " WITH (FORCE)"); err != nil {
			t.Logf("drop test db %s: %v", dbName, err)
		}
		admin.Close()
	}
	return db, cleanup
}

func randomSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	return hex.EncodeToString(b)
}

// rewriteDSNQuery sets/keeps query params (sslmode etc.) from the original.
func rewriteDSNQuery(rawQuery string, key, value string) string {
	q := map[string]string{}
	for _, kv := range strings.Split(rawQuery, "&") {
		if kv == "" {
			continue
		}
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 {
			q[parts[0]] = parts[1]
		}
	}
	q[key] = value
	var out []string
	for k, v := range q {
		out = append(out, k+"="+v)
	}
	return strings.Join(out, "&")
}

// newTestDB is the internal alias for NewTestDB (serverstore-internal tests).
func newTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	return NewTestDB(t)
}


// ensureTestPartitions 预建 2026-01 起至当前+6 月的 usage 分区与 usage_daily 分区,
// 覆盖测试中硬编码的历史月份(2026-07/08/09 等),避免"no partition found"。
func ensureTestPartitions(db *sql.DB) error {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Now().AddDate(0, 6, 0)
	for m := start; !m.After(end); m = m.AddDate(0, 1, 0) {
		if err := ensureUsagePartition(db, m); err != nil {
			return err
		}
		if err := ensureUsageDailyPartition(db, m); err != nil {
			return err
		}
	}
	return nil
}
