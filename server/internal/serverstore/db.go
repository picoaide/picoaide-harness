package serverstore

import (
	"database/sql"
	"fmt"

	_ "modernc.org/sqlite"
)

// Open opens (or creates) the SQLite database at path with WAL journal mode.
func Open(path string) (*sql.DB, error) {
	// _pragma 参数在 modernc 驱动中对每个新建连接生效:foreign_keys 是 per-connection
	// pragma,仅在池中单连接上 Exec 会导致并发打开的其他连接 FK 静默关闭(审计2026-M7)
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, err
	}
	var fk int
	if err := db.QueryRow("PRAGMA foreign_keys").Scan(&fk); err != nil {
		db.Close()
		return nil, err
	}
	if fk != 1 {
		db.Close()
		return nil, fmt.Errorf("foreign_keys pragma not enabled")
	}
	return db, nil
}
