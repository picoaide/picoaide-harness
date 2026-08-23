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
	//
	// _timezone=Local:驱动解析 DATETIME 列时,对无时区字符串(SQLite
	// datetime('now','localtime') 的墙钟串)按本地时区解释。默认(无 _timezone)
	// 按 UTC 解析,非 UTC 环境读出的时间点整体偏移,time.Since() 为负、
	// 孤儿回收等按年龄的逻辑失效(token/session 的 RFC3339 值因驱动
	// Scan→string 的 RFC3339Nano 序列化被平移同样失真)。带时区字符串不受影响。
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)&_timezone=Local"
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
