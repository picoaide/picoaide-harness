package serverstore

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

func newUsageDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	db, err := EnsureMigrated(fmt.Sprintf("%s/usage.db", t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	return db, func() { db.Close() }
}

func mustUserID(t *testing.T, db *sql.DB) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: "u" + fmt.Sprint(time.Now().UnixNano()), Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	return id
}

// setCreatedAt backdates a usage row so day aggregation is deterministic.
func setCreatedAt(t *testing.T, db *sql.DB, id int64, ts string) {
	t.Helper()
	if _, err := db.Exec("UPDATE usage SET created_at = ? WHERE id = ?", ts, id); err != nil {
		t.Fatal(err)
	}
}

func TestRecordUsageReturnsID(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, err := RecordUsage(db, uid, "deepseek-chat", 10, 5)
	if err != nil {
		t.Fatal(err)
	}
	if id == 0 {
		t.Fatal("expected non-zero row id")
	}

	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 10 || ct != 5 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestUpdateUsageTokens(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	id, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)
	if err := UpdateUsageTokens(db, id, 42, 7); err != nil {
		t.Fatal(err)
	}
	var pt, ct int64
	if err := db.QueryRow("SELECT prompt_tokens, completion_tokens FROM usage WHERE id = ?", id).Scan(&pt, &ct); err != nil {
		t.Fatal(err)
	}
	if pt != 42 || ct != 7 {
		t.Fatalf("pt=%d ct=%d", pt, ct)
	}
}

func TestCleanupPendingUsage(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	uid := mustUserID(t, db)

	pending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0)     // zero tokens
	keptPending, _ := RecordUsage(db, uid, "deepseek-chat", 0, 0) // zero tokens, recent
	complete, _ := RecordUsage(db, uid, "deepseek-chat", 10, 5)   // has tokens, old
	setCreatedAt(t, db, pending, "2026-07-01 09:00:00")
	setCreatedAt(t, db, keptPending, "2026-08-02 09:00:00")
	setCreatedAt(t, db, complete, "2026-07-01 09:00:00")

	cutoff := time.Date(2026, 8, 1, 0, 0, 0, 0, time.Local)
	if err := CleanupPendingUsage(db, cutoff); err != nil {
		t.Fatal(err)
	}

	for _, id := range []int64{pending} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 0 {
			t.Fatalf("pending row %d not cleaned", id)
		}
	}
	for _, id := range []int64{keptPending, complete} {
		var n int
		if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE id = ?", id).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("row %d wrongly cleaned", id)
		}
	}
}

func TestUsageAggregateEmptyReturnsNonNil(t *testing.T) {
	db, cleanup := newUsageDB(t)
	defer cleanup()
	rows, err := UsageAggregate(db, time.Time{}, time.Time{}, "day")
	if err != nil {
		t.Fatal(err)
	}
	if rows == nil {
		t.Fatal("UsageAggregate returned nil slice on empty table (must be [] for JSON)")
	}
}
