package serverstore

import (
	"testing"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// TestOpen verifies the PG connection opens and pings (PG_DSN_TEST env).
func TestOpen(t *testing.T) {
	db, err := Open(DBConfig{Driver: DriverPG, DSN: PgTestDSN()})
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		t.Fatalf("Ping: %v", err)
	}
}

// FK 约束必须对池中每个连接生效(PG 的 FK 是服务端约束,天然 per-connection
// 一致;此处验证并发连接下 FK 仍被拒绝,防止回归为任意关约束)。
func TestForeignKeysEnforcedOnAllConnections(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const workers = 16
	type result struct {
		ok bool
	}
	results := make(chan result, workers)
	for i := 0; i < workers; i++ {
		go func() {
			_, err := db.Exec("INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (999999, 'x', now())")
			// FK 违例必须返回错误:err 非 nil 才算 FK 被拒绝(期望行为)
			results <- result{ok: err != nil}
		}()
	}
	for i := 0; i < workers; i++ {
		if r := <-results; !r.ok {
			t.Fatal("FK-violating insert succeeded on some connection")
		}
	}
}
