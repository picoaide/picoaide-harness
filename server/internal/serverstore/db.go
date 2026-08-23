package serverstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"

	_ "modernc.org/sqlite"
)

// DriverName identifies the underlying SQL backend.
type DriverName string

const (
	DriverSQLite DriverName = "sqlite"
	DriverPG     DriverName = "pg"
)

// currentDriver is set by Open; migrate.go and dialect helpers consult it to
// emit backend-specific SQL. It is process-global because the codebase passes
// *sql.DB around (no context carrier) and opens exactly one DB per process.
var currentDriver = DriverSQLite

// DBConfig selects the backend for Open.
type DBConfig struct {
	Driver DriverName // "sqlite" (default) or "pg"
	Path   string     // sqlite file path
	DSN    string     // pg connection string (postgres:// or keyword DSN)
}

// Open opens the requested backend and verifies connectivity.
func Open(cfg DBConfig) (*sql.DB, error) {
	switch cfg.Driver {
	case "", DriverSQLite:
		return openSQLite(cfg.Path)
	case DriverPG:
		return openPG(cfg.DSN)
	default:
		return nil, fmt.Errorf("unsupported db driver %q (want sqlite or pg)", cfg.Driver)
	}
}

// NowExpr returns the backend-specific expression for "current timestamp".
// SQLite stores wall-clock strings via datetime('now','localtime'); PG uses
// now() with TIMESTAMPTZ (both scan back to local time via parseSQLTime).
func NowExpr() string {
	if currentDriver == DriverPG {
		return "now()"
	}
	return "datetime('now','localtime')"
}

// TimestampType returns the column type for timestamp columns.
func TimestampType() string {
	if currentDriver == DriverPG {
		return "TIMESTAMPTZ"
	}
	return "DATETIME"
}

// CaseInsensitiveCmp returns the SQL snippet comparing a column to a value
// case-insensitively. SQLite has COLLATE NOCASE; PG uses ILIKE with a bound
// value (or LOWER(col) = LOWER(?)). We use LOWER(col)=LOWER(?) so the same
// statement shape works with positional placeholders on both backends.
func CaseInsensitiveCmp(col string) string {
	if currentDriver == DriverPG {
		return fmt.Sprintf("LOWER(%s) = LOWER(?)", col)
	}
	return fmt.Sprintf("%s = ? COLLATE NOCASE", col)
}

// InsertIgnorePrefix returns the statement prefix for insert-or-ignore.
func InsertIgnorePrefix() string {
	if currentDriver == DriverPG {
		return "INSERT INTO"
	}
	return "INSERT OR IGNORE INTO"
}

// InsertID executes an INSERT and returns the auto-generated row id.
// SQLite: database/sql LastInsertId. PG: pgx stdlib does not implement
// LastInsertId, so we append RETURNING id and QueryRow-scan it.
func InsertID(db *sql.DB, query string, args ...any) (int64, error) {
	if currentDriver == DriverPG {
		var id int64
		err := db.QueryRow(query+" RETURNING id", args...).Scan(&id)
		return id, err
	}
	res, err := db.Exec(query, args...)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// openSQLite opens (or creates) the SQLite database at path with WAL journal mode.
func openSQLite(path string) (*sql.DB, error) {
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
	currentDriver = DriverSQLite
	return db, nil
}

// openPG opens a PostgreSQL database via pgx stdlib, wrapping the connector so
// that `?` placeholders (used throughout the codebase) are rewritten to $N on
// the fly. This keeps every SQL statement portable across SQLite and PG.
func openPG(dsn string) (*sql.DB, error) {
	if dsn == "" {
		return nil, errors.New("pg dsn required when db driver is pg")
	}
	connector, err := newPGConnector(dsn)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(&rewriteConnector{raw: connector})
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("pg ping: %w", err)
	}
	currentDriver = DriverPG
	return db, nil
}

// ---------------------------------------------------------------------------
// `?` -> `$N` rewrite layer.
//
// PostgreSQL's extended protocol uses $1..$N positional parameters, not `?`.
// All SQL in this codebase is written with `?` for SQLite compatibility. We
// wrap the pgx database/sql connector so every prepared/executed statement has
// `?` rewritten to $1..$N before reaching PostgreSQL.
// ---------------------------------------------------------------------------

type rewriteConnector struct {
	raw driver.Connector
}

func (rc *rewriteConnector) Connect(ctx context.Context) (driver.Conn, error) {
	c, err := rc.raw.Connect(ctx)
	if err != nil {
		return nil, err
	}
	return &rewriteConn{Conn: c}, nil
}

func (rc *rewriteConnector) Driver() driver.Driver {
	return rc.raw.Driver()
}

type rewriteConn struct {
	driver.Conn
}

var (
	_ driver.Conn               = (*rewriteConn)(nil)
	_ driver.ConnPrepareContext = (*rewriteConn)(nil)
	_ driver.ExecerContext      = (*rewriteConn)(nil)
	_ driver.QueryerContext     = (*rewriteConn)(nil)
	_ driver.Pinger             = (*rewriteConn)(nil)
)

func (c *rewriteConn) rewrite(q string) string { return rewritePlaceholders(q) }

func (c *rewriteConn) Prepare(query string) (driver.Stmt, error) {
	return c.PrepareContext(context.Background(), query)
}

func (c *rewriteConn) PrepareContext(ctx context.Context, query string) (driver.Stmt, error) {
	if pc, ok := c.Conn.(driver.ConnPrepareContext); ok {
		return pc.PrepareContext(ctx, c.rewrite(query))
	}
	return c.Conn.Prepare(c.rewrite(query))
}

func (c *rewriteConn) Ping(ctx context.Context) error {
	if p, ok := c.Conn.(driver.Pinger); ok {
		return p.Ping(ctx)
	}
	return nil
}

func (c *rewriteConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	if ec, ok := c.Conn.(driver.ExecerContext); ok {
		return ec.ExecContext(ctx, c.rewrite(query), args)
	}
	stmt, err := c.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	if dargs, err := namedToValue(args); err == nil {
		return stmt.Exec(dargs)
	}
	return nil, errors.New("rewriteConn: cannot exec without ExecerContext")
}

func (c *rewriteConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	if qc, ok := c.Conn.(driver.QueryerContext); ok {
		return qc.QueryContext(ctx, c.rewrite(query), args)
	}
	stmt, err := c.PrepareContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	if dargs, err := namedToValue(args); err == nil {
		return stmt.Query(dargs)
	}
	return nil, errors.New("rewriteConn: cannot query without QueryerContext")
}

func namedToValue(args []driver.NamedValue) ([]driver.Value, error) {
	out := make([]driver.Value, len(args))
	for i, a := range args {
		out[i] = a.Value
	}
	return out, nil
}

// rewritePlaceholders converts `?` positional placeholders (outside string
// literals/identifiers) into PostgreSQL $1..$N. Handles single/double quotes
// and escaped quotes.
func rewritePlaceholders(sql string) string {
	var b strings.Builder
	b.Grow(len(sql) + 16)
	inS, inD := false, false
	n := 0
	for i := 0; i < len(sql); i++ {
		ch := sql[i]
		switch {
		case inS:
			b.WriteByte(ch)
			if ch == '\'' {
				if i+1 < len(sql) && sql[i+1] == '\'' {
					b.WriteByte(sql[i+1])
					i++
				} else {
					inS = false
				}
			}
		case inD:
			b.WriteByte(ch)
			if ch == '"' {
				if i+1 < len(sql) && sql[i+1] == '"' {
					b.WriteByte(sql[i+1])
					i++
				} else {
					inD = false
				}
			}
		case ch == '\'':
			inS = true
			b.WriteByte(ch)
		case ch == '"':
			inD = true
			b.WriteByte(ch)
		case ch == '?':
			n++
			fmt.Fprintf(&b, "$%d", n)
		default:
			b.WriteByte(ch)
		}
	}
	return b.String()
}
