package serverstore

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
)

func TestOpen(t *testing.T) {
	db, err := Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

// FK 约束必须对池中每个连接生效(_pragma 方式,审计2026-M7:单连接 PRAGMA 会导致
// 并发打开的其他连接 FK 静默关闭)
func TestForeignKeysEnforcedOnAllConnections(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	const workers = 16
	failures := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := db.Exec("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (999999, 'x', datetime('now'))"); err == nil {
				failures <- fmt.Errorf("FK-violating insert succeeded on some connection")
			}
		}()
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
}
