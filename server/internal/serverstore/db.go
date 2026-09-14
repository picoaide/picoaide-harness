package serverstore

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// pgInt64Array 把 []int64 编码成 PG 数组字面量("{1,2,3}"),配合 SQL 侧
// `= ANY(?::bigint[])` 使用(P2-7:成员集合走数组参数,避免拼 IN(?,?,…)
// 撞 PG 65535 参数上限 → 配额校验 fail-closed 全员 429)。
// 为什么传文本字面量而不是 []int64:database/sql 默认参数转换器不认识切片,
// 而 pgx 的切片编码又被 rewrite 包装层挡在 CheckNamedValue 之外
// ("unsupported type []int64");字符串参数走 pgx 的 text 编码,
// 由 SQL 的显式 ::bigint[] 转换解析。
func pgInt64Array(ids []int64) string {
	var b strings.Builder
	b.Grow(len(ids)*8 + 2)
	b.WriteByte('{')
	for i, id := range ids {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatInt(id, 10))
	}
	b.WriteByte('}')
	return b.String()
}

// pgFloat64Array 把 []float64 编码成 PG 数组字面量(配合 ::double precision[]),
// 用于余额账本的批量流水写入(unnest 展开)。理由同 pgInt64Array。
func pgFloat64Array(vals []float64) string {
	var b strings.Builder
	b.Grow(len(vals)*16 + 2)
	b.WriteByte('{')
	for i, v := range vals {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(strconv.FormatFloat(roundMicro(v), 'f', -1, 64))
	}
	b.WriteByte('}')
	return b.String()
}

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
	// 启动竞态容忍:PG 与 server 并行拉起时(compose/CI 验证),连接可能撞上
	// "database system is starting up"(SQLSTATE 57P03)。重试 30 次 × 1s,
	// 逾期返回最后一次错误(服务端配合 CI docker.yml 的 Verify 步骤双保险)。
	var lastErr error
	for attempt := 0; attempt < 30; attempt++ {
		if err := db.Ping(); err != nil {
			lastErr = err
			time.Sleep(time.Second)
			continue
		}
		lastErr = nil
		break
	}
	if lastErr != nil {
		db.Close()
		return nil, fmt.Errorf("pg ping: %w", lastErr)
	}
	// 连接池:实测 500 并发 1257 TPS / 3000 突发 1613 writes/s 0 失败;
	// 200 连接 + 业务层(流式 1-3s 打散)足以支撑数千并发大模型调用。
	// PG MVCC 多写并行,无需 SQLite 的单连接串行化。
	// 2026-08-31 实测（100tok/s 长流 2000 并发）: 池 200 时流式回填风暴
	// 打满池 -> database/sql 连接饥饿全站僵死(1490 goroutine 卡 waitForConn)。
	// 上调 400 + 短 IdleTime 淘汰半死连接(僵死元凶是"坏连接占池位不可复用")。
	//
	// 2026-09-13(N-2③):400 是**愿望值**,而 PG 侧的硬上限是
	// max_connections - superuser_reserved_connections(默认 100-3)。池超过
	// 这个数时,database/sql 会真的去开第 N+1 条连接,PG 直接回
	// "too many clients"——请求**报错而不是排队**,而拿到连接的那部分请求
	// 也未必能推进。这里按服务端实际可授予量收紧(留 4 条给运维/迁移/其它
	// 实例),并把连接获取失败变成排队;探测失败则回落到保守的 90。
	db.SetMaxOpenConns(pgPoolMax(db))
	db.SetMaxIdleConns(100)
	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetConnMaxIdleTime(5 * time.Minute)
	return db, nil
}

// pgPoolMaxWithProbe / pgPoolMaxWithoutProbe:pgPoolMax 的两个分支常量。
const (
	pgPoolMaxCeiling    = 400 // 历史愿望值(见 openPG 注释)
	pgPoolMaxFallback   = 90  // 探测失败时的保守值(PG 默认 max_connections=100)
	pgPoolReservedSlots = 4   // 留给运维连接/迁移/同库的其它实例
)

// pgPoolMax 返回应用连接池上限:min(400, 服务端可授予量, 显式覆盖)。
// PICOAI_DB_MAX_OPEN_CONNS 可显式指定(多实例部署/托管 PG 时按实际配额下调)。
func pgPoolMax(db *sql.DB) int {
	max := pgPoolMaxCeiling
	if usable, err := pgUsableConnections(db); err != nil {
		log.Printf("serverstore: SHOW max_connections failed (%v); capping pool at %d", err, pgPoolMaxFallback)
		max = pgPoolMaxFallback
	} else if usable < max {
		max = usable
	}
	if v := strings.TrimSpace(os.Getenv("PICOAI_DB_MAX_OPEN_CONNS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n < max {
				max = n
			}
		} else {
			log.Printf("serverstore: ignoring invalid PICOAI_DB_MAX_OPEN_CONNS=%q", v)
		}
	}
	if max < 2 { // 发布路径的最小可用池:同一时刻 1 条连接即可,但 2 是安全地板
		max = 2
	}
	return max
}

// pgUsableConnections 是 PG 实际能授予普通连接的条数(总连接数减去超级用户
// 保留位与给运维留的余量)。
func pgUsableConnections(db *sql.DB) (int, error) {
	var maxConn, reserved int
	if err := db.QueryRow(`SHOW max_connections`).Scan(&maxConn); err != nil {
		return 0, err
	}
	if err := db.QueryRow(`SHOW superuser_reserved_connections`).Scan(&reserved); err != nil {
		return 0, err
	}
	usable := maxConn - reserved - pgPoolReservedSlots
	if usable < 2 {
		usable = 2
	}
	return usable, nil
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
