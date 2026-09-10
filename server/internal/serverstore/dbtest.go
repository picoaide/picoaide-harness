package serverstore

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
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

// requireTestPG skips the test when the PostgreSQL test server is
// unreachable. Database-dependent tests must never fail (nor hang) in an
// environment without a database: `go test ./...` must pass without DB, and
// CI must not depend on a database service (2026-09-02).
// Returned admin handle (administrative "postgres" connection) is non-nil
// only when the probe succeeded; callers close it on cleanup.
func requireTestPG(t *testing.T, adminDSN string) *sql.DB {
	t.Helper()
	adminURL, err := url.Parse(adminDSN)
	if err != nil {
		t.Skipf("DB test skipped: parse test dsn: %v", err)
	}
	adminURL.Path = "/postgres"
	adminURL.RawQuery = rewriteDSNQuery(adminURL.RawQuery, "connect_timeout", "3")
	admin, err := sql.Open("pgx", adminURL.String())
	if err != nil {
		t.Skipf("DB test skipped: open admin db: %v", err)
	}
	if err := admin.PingContext(context.Background()); err != nil {
		admin.Close()
		t.Skipf("DB test skipped: postgres unavailable at %s: %v", adminURL.Host, err)
	}
	return admin
}

// NewTestDB creates an isolated temporary PostgreSQL database for one test
// (CREATE DATABASE picoaide_test_<rand>), applies migrations, and returns a
// connection plus a cleanup func that drops the database. Each test gets a
// fresh schema — no cross-test interference (shared-database truncation turned
// out to leak runs between tests).
//
// 2026-09-10 性能:临时库改为从「模板库」克隆(CREATE DATABASE ... TEMPLATE)。
// 此前每个用例都要重放 52 个迁移 + 预建 24 个分区,单用例固定开销 1.5-3s;
// 全仓 99 处建库点、628 个用例里有 355 个 ≥1s,Go 门禁被纯建库耗时吃掉大半
// (实测 -p 4 时 217s,其中 ~2/3 是迁移重放)。模板库按「迁移集合哈希 + 分区
// 窗口」命名并缓存在同一个 PG 实例里:首个用例付一次迁移成本(advisory lock
// 互斥,跨包并发也只建一次),之后每个用例只付一次文件级克隆(~100ms)。
// 模板不可用时(无权限/克隆失败/迁移集合被测试钩子替换)自动回落到原来的
// 全量迁移路径,测试语义不变。
func NewTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	// 清空进程级 TTL 缓存(组织树/模型配置/settings):每个测试独立临时库,
	// 前一个测试写入的缓存值会污染后续测试(2026-08-31 加缓存后引入)。
	resetTestCaches()
	adminDSN := PgTestDSN()
	admin := requireTestPG(t, adminDSN)
	u, err := url.Parse(adminDSN)
	if err != nil {
		admin.Close()
		t.Fatalf("parse test dsn: %v", err)
	}
	suffix := randomSuffix(6)
	dbName := "picoaide_test_" + suffix
	// 连 admin 库(postgres)建临时库
	adminURL := *u
	adminURL.Path = "/postgres"
	adminURL.RawQuery = rewriteDSNQuery(adminURL.RawQuery, "connect_timeout", "5")
	cloned, cloneErr := createTestDBFromTemplate(admin, adminURL.String(), dbName)
	if cloneErr != nil {
		// 模板路径不可用:回落到「空库 + 全量迁移」,保持旧行为。
		t.Logf("test db %s: template clone unavailable (%v); applying migrations directly", dbName, cloneErr)
		if _, err := admin.Exec("CREATE DATABASE " + dbName); err != nil {
			admin.Close()
			t.Fatalf("create test db %s: %v", dbName, err)
		}
	}
	// 连临时库
	u.Path = "/" + dbName
	db, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		admin.Close()
		t.Fatalf("open test db: %v", err)
	}
	if !cloned {
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

// testDBTemplateLockKey 模板库构建的 advisory lock key(与 migrationLockKey
// 不同:模板库构建期间另需在模板库内跑 ApplyMigrations,两个 key 分离避免
// 同一会话的锁语义纠缠)。
const testDBTemplateLockKey = int64(0x50696354) // "PicT"

// createTestDBFromTemplate 克隆已迁移的模板库为本次测试库。返回 cloned=false
// 且 err=nil 表示"未走模板但也没出错"(理论上不会出现,保留以显式表达语义)。
func createTestDBFromTemplate(admin *sql.DB, adminDSN, dbName string) (bool, error) {
	// 测试替换了迁移集合(testMigrationHook):模板库命名失去意义,直接回落。
	if testMigrationHook != nil {
		return false, fmt.Errorf("migration set overridden by test hook")
	}
	template, err := testDBTemplateName()
	if err != nil {
		return false, err
	}
	if err := ensureTestDBTemplate(admin, adminDSN, template); err != nil {
		return false, err
	}
	if _, err := admin.Exec("CREATE DATABASE " + dbName + " TEMPLATE " + template); err != nil {
		return false, fmt.Errorf("clone template %s: %w", template, err)
	}
	return true, nil
}

// testDBTemplateName 由「迁移内容 + 预建分区窗口」派生模板库名:任一迁移改动
// 或跨月(分区窗口右移)都会得到新模板,旧模板不会被误用。
func testDBTemplateName() (string, error) {
	h := sha256.New()
	for _, m := range migrationsFor() {
		fmt.Fprintf(h, "%04d|%s|%s\n", m.version, m.name, m.sql)
	}
	_, end := testPartitionWindow()
	fmt.Fprintf(h, "partitions|%s\n", end.Format("2006-01"))
	return "picoaide_tmpl_" + hex.EncodeToString(h.Sum(nil))[:12], nil
}

// ensureTestDBTemplate 确保模板库存在且已完成迁移:advisory lock 串行化
// 「检查-创建-迁移」,跨包并发(-p N)时只有一个进程真正建库,其余进程等待
// 后直接复用。模板库构建失败时删除半成品,避免后来的进程克隆到不完整 schema。
func ensureTestDBTemplate(admin *sql.DB, adminDSN, template string) error {
	ctx := context.Background()
	conn, err := admin.Conn(ctx)
	if err != nil {
		return fmt.Errorf("template lock conn: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1)", testDBTemplateLockKey); err != nil {
		return fmt.Errorf("acquire template lock: %w", err)
	}
	defer func() {
		_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock($1)", testDBTemplateLockKey)
	}()
	exists, err := templateExists(ctx, conn, template)
	if err != nil || exists {
		return err
	}
	if _, err := conn.ExecContext(ctx, "CREATE DATABASE "+template); err != nil {
		// 锁内重查:极端情况下(锁获取前的窗口)其他进程已建好同一模板。
		if exists, checkErr := templateExists(ctx, conn, template); checkErr == nil && exists {
			return nil
		}
		return fmt.Errorf("create template db %s: %w", template, err)
	}
	u, err := url.Parse(adminDSN)
	if err != nil {
		return err
	}
	u.Path = "/" + template
	db, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		dropTemplateDB(admin, template)
		return fmt.Errorf("open template db: %w", err)
	}
	if err := ApplyMigrations(db); err != nil {
		db.Close()
		dropTemplateDB(admin, template)
		return fmt.Errorf("migrate template db: %w", err)
	}
	if err := ensureTestPartitions(db); err != nil {
		db.Close()
		dropTemplateDB(admin, template)
		return fmt.Errorf("ensure template partitions: %w", err)
	}
	// 必须在释放锁之前断开模板库连接:CREATE DATABASE ... TEMPLATE 要求源库
	// 没有其他会话,否则并发克隆会报 "source database is being accessed"。
	if err := db.Close(); err != nil {
		dropTemplateDB(admin, template)
		return fmt.Errorf("close template db: %w", err)
	}
	return nil
}

func templateExists(ctx context.Context, conn *sql.Conn, template string) (bool, error) {
	var exists bool
	if err := conn.QueryRowContext(ctx,
		"SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", template).Scan(&exists); err != nil {
		return false, fmt.Errorf("probe template db %s: %w", template, err)
	}
	return exists, nil
}

func dropTemplateDB(admin *sql.DB, template string) {
	if _, err := admin.Exec("DROP DATABASE IF EXISTS " + template + " WITH (FORCE)"); err != nil {
		// 半成品模板清理失败不致命:名字带迁移哈希,不会被后续运行误用。
		fmt.Fprintf(os.Stderr, "drop template db %s: %v\n", template, err)
	}
}

func randomSuffix(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", os.Getpid())
	}
	return hex.EncodeToString(b)
}

// resetTestCaches 清空进程级 TTL 缓存(仅测试用):每个测试独立临时库,
// 缓存 key 与 DB 数据绑定,测试间必须隔离。
// 注意:llmgateway 的上游路由缓存由该包测试自行调 InvalidateUpstreams()。
func resetTestCaches() {
	groupTreeCache.invalidateAll()
	modelConfigCache.invalidateAll()
	settingsCache.invalidateAll()
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

// testPartitionWindow 测试库预建分区的窗口:2026-01 起至当前+6 月。
// 命名模板库时复用同一函数,避免"模板库分区窗口"与"实际需要的分区"漂移。
func testPartitionWindow() (time.Time, time.Time) {
	start := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	end := time.Now().AddDate(0, 6, 0)
	return start, end
}

// ensureTestPartitions 预建 2026-01 起至当前+6 月的 usage 分区与 usage_daily 分区,
// 覆盖测试中硬编码的历史月份(2026-07/08/09 等),避免"no partition found"。
func ensureTestPartitions(db *sql.DB) error {
	start, end := testPartitionWindow()
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
