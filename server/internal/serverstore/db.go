package serverstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// DriverName identifies the underlying SQL backend (PostgreSQL only.
// SQLite support was removed in the PG-only migration).
type DriverName string

const (
	DriverPG DriverName = "pg"
)

// DBConfig selects the backend for Open.
type DBConfig struct {
	Driver DriverName // "pg" (default)
	DSN    string     // pg connection string (postgres:// or keyword DSN)
}

// Open opens the requested backend and verifies connectivity.
func Open(cfg DBConfig) (*sql.DB, error) {
	switch cfg.Driver {
	case "", DriverPG:
		return openPG(cfg.DSN)
	default:
		return nil, fmt.Errorf("unsupported db driver %q (want pg)", cfg.Driver)
	}
}

// NowExpr returns the backend-specific expression for "current timestamp".
// PG uses now() with TIMESTAMPTZ (both scan back to local time via parseSQLTime).
func NowExpr() string {
	return "now()"
}

// TimestampType returns the column type for timestamp columns.
func TimestampType() string {
	return "TIMESTAMPTZ"
}

// CaseInsensitiveCmp returns the SQL snippet comparing a column to a value
// case-insensitively. PG uses LOWER(col)=LOWER(?).
func CaseInsensitiveCmp(col string) string {
	return fmt.Sprintf("LOWER(%s) = LOWER(?)", col)
}

// InsertID executes an INSERT and returns the auto-generated row id.
// PG: pgx stdlib does not implement LastInsertId, so we append RETURNING id
// and QueryRow-scan it.
func InsertID(db *sql.DB, query string, args ...any) (int64, error) {
	var id int64
	err := db.QueryRow(query+" RETURNING id", args...).Scan(&id)
	return id, err
}

// openPG opens a PostgreSQL database via pgx stdlib. Wraps the connector with
// the `?` -> `$N` rewrite layer: the codebase's SQL statements all use `?`
// placeholders (kept for portability), and pgx requires $N. Configures a pool
// sized for the gateway's concurrency and the Asia/Shanghai session timezone.
func openPG(dsn string) (*sql.DB, error) {
	if dsn == "" {
		return nil, errors.New("pg dsn required")
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
	// 连接池:实测 500 并发 1257 TPS / 3000 突发 1613 writes/s 0 失败;
	// 200 连接 + 业务层(流式 1-3s 打散)足以支撑数千并发大模型调用。
	// PG MVCC 多写并行,无需 SQLite 的单连接串行化。
	// 2026-08-31 实测（100tok/s 长流 2000 并发）: 池 200 时流式回填风暴
	// 打满池 -> database/sql 连接饥饿全站僵死(1490 goroutine 卡 waitForConn)。
	// 上调 400 + 短 IdleTime 淘汰半死连接(僵死元凶是"坏连接占池位不可复用")。
	db.SetMaxOpenConns(400)
	db.SetMaxIdleConns(100)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
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
