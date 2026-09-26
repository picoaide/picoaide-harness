package serverstore

// R28-FIX41 ① 回归：迁移执行路径里**每一条**会取锁的语句都必须在等锁预算内。
//
// 被审形态（R28 审计 AB1-02 = **P1**；它同时是"FIX-39 ①没闭合"的证明）：
// FIX-39 把等锁预算加在「每条迁移事务」（`SET LOCAL lock_timeout`）与「advisory lock
// 等待」（会话级 `SET lock_timeout`）两处，但执行器**自有**的账本动作 ——
// `CREATE TABLE IF NOT EXISTS schema_migrations` /
// `ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum` /
// 读已应用版本 / 回填 checksum —— 跑在**池连接**上，而且发生在迁移循环**之前**。
// 真 PG 实测（AB1 的探针原文）：另一会话对 schema_migrations 持 ACCESS SHARE 时，
// 预算设 2s 仍然 **20s+ 不返回**，`ALTER` 的 NOTICE 比 `CREATE` 晚 20s
// ⇒ **即使列已存在、动作是 no-op，PG 仍先取 ACCESS EXCLUSIVE**。
// 而 FIX-39 自己的判据只锁 `models` ⇒ **本缺陷存在时全绿**（"判据的取值域 ≠ 被守护面"）。
//
// 本文件的判据分三层（缺一层就会出现"改名/搬走即假绿"的形态）：
//   - 条 1（能力级、真 PG）：另一会话持 ACCESS SHARE 挡 schema_migrations ⇒ 必须在
//     **有界时间**内响亮失败并点名"哪条语句 + SQLSTATE 55P03"，释放阻塞者后必须成功。
//   - 条 2（能力级、真 PG）：**版本行 INSERT** 也在迁移事务的预算内（夹具迁移本身不取锁，
//     只有 schema_migrations 上的 SHARE 锁能挡住它 ⇒ 55P03 只可能来自版本行写入）。
//   - 条 3（静态、清单级）：migrate.go 里**每一个** DB 调用点都必须落在预算会话内，或
//     在显式登记表里带着理由 —— 新增一条取锁语句却忘了加预算，判据即红。
//     这一条是"只给被点名的那条加预算"这种病根的直接解药（FIX-39 正是这么漏的）。
//   - 条 4（正向 + 不泄漏）：无并发锁时**完整链**照常成功；预算不得随连接归还池而
//     泄漏给后续业务查询（会话级 SET 的经典副作用）。

import (
	"bytes"
	"context"
	"database/sql"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"log"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

// holdTableLock 在**另一条会话**上对 table 取指定模式的锁并持住，hold 到点自动释放。
//
// 与同包 `holdAccessShare` 的区别只有一条：**有界占用**。变异体（把预算挪回池连接 =
// 复现 AB1-02）下被测函数会一直等到锁释放，自动释放保证用例仍在有限时间内给出"红"
// 的结论，而不是把整包拖到 `go test` 的包级超时（那时失败原因会退化成一行 panic）。
func holdTableLock(t *testing.T, db *sql.DB, table, mode string, hold time.Duration) (int, func()) {
	t.Helper()
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("取阻塞源连接: %v", err)
	}
	var pid int
	if err := conn.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
		conn.Close()
		t.Fatalf("读阻塞源 pid: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		conn.Close()
		t.Fatalf("阻塞源 BEGIN: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "LOCK TABLE "+table+" IN "+mode+" MODE"); err != nil {
		conn.Close()
		t.Fatalf("阻塞源 LOCK TABLE %s IN %s MODE: %v", table, mode, err)
	}
	var once sync.Once
	release := func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
		})
	}
	timer := time.AfterFunc(hold, release)
	t.Cleanup(func() { timer.Stop(); release() })
	return pid, release
}

// TestMigrationLedgerDDLLockBudgetFailsLoudInsteadOfHanging 是 ① 的承重判据（条 1）。
//
// 取值域刻意**不是** FIX-39 已经覆盖的 `models`，而是执行器自有的账本表：这就是 AB1-02
// 证明的缺口 —— 只锁 models 时本缺陷全绿。
func TestMigrationLedgerDDLLockBudgetFailsLoudInsteadOfHanging(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	// 阻塞模式的选择有实测依据（temp/r21/fix-41/probe/lockmatrix.log）：
	//   ALTER TABLE … ADD COLUMN IF NOT EXISTS 取 ACCESS EXCLUSIVE ⇒ 被 ACCESS SHARE 挡住；
	//   而 CREATE TABLE IF NOT EXISTS（表已存在）/ SELECT 取的是与 ACCESS SHARE **相容**的锁
	//   ⇒ 它们在同一场景下根本不等待，所以"账本阶段"的可咬点是那条 ALTER（它也是 P1 本体）。
	blockerPID, release := holdTableLock(t, db, "schema_migrations", "ACCESS SHARE", 8*time.Second)
	defer release()

	t.Setenv(migrationDDLLockBudgetEnv, "1000")

	var buf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prevOut)

	start := time.Now()
	err := ApplyMigrations(db)
	elapsed := time.Since(start)
	log.SetOutput(prevOut)
	logged := buf.String()

	if err == nil {
		t.Fatalf("账本 DDL 被并发锁挡住时必须**响亮失败**（修前 = 无界静默挂死，AB1-02 实测 20s+）；实测耗时 %s", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("必须**有界**：预算 1s，实测 %s —— 修前该语句跑在池连接上、不受任何预算约束", elapsed)
	}
	// 点名"哪条语句 + SQLSTATE"：只有"超时"两个字运维无法行动。
	for _, want := range []string{"schema_migrations", "checksum", "55P03"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误必须点名 %q；实际: %v", want, err)
		}
	}
	// 阻塞者的 pid 必须能在错误里被认出来（真话：错误文本里带的是 PG 的原始错误，
	// 阻塞者从 PG 拿不到；这里断言的是"等待发生在账本阶段且被拦下"这件事本身已在
	// 错误里说明 —— 见 withLockBudget 的文案，含"这次等待发生在迁移循环之前"）。
	if !strings.Contains(err.Error(), "迁移循环**之前**") {
		t.Fatalf("错误必须说明等待发生在迁移循环之前（否则会被误诊成某条迁移慢）: %v", err)
	}
	// 日志必须留下"拿到了互斥锁、然后就卡在账本阶段"的可检索痕迹。
	if !strings.Contains(logged, "migration lock acquired") {
		t.Fatalf("日志必须留下 advisory 锁已拿到的痕迹; 实际:\n%s", logged)
	}
	_ = blockerPID

	// 失败 ≠ 卡死：释放阻塞源后必须立刻成功。
	release()
	start = time.Now()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("释放阻塞源后必须成功: %v", err)
	}
	if d := time.Since(start); d > 30*time.Second {
		t.Fatalf("释放后重试不该耗时 %s", d)
	}
}

// TestMigrationVersionRowInsertIsInsideTheDDLBudget 是条 2：**版本行 INSERT** 的预算。
//
// 为什么必须单独一条：FIX-39 的判据挡的是"迁移文件里的 DDL"，而 `INSERT INTO
// schema_migrations (version, checksum)` 是迁移事务里的**第二条**写语句 —— 它取
// ROW EXCLUSIVE，与 SHARE 冲突。夹具迁移正文只有 `SELECT 1`（不取任何表锁），因此这里
// 出现的 55P03 **只可能**来自版本行写入：这正是"取值域 = 被守护面"的写法。
func TestMigrationVersionRowInsertIsInsideTheDDLBudget(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	// 先跑一次迁移：模板克隆出来的库可能是**checksum 列出现之前**建的（模板按迁移内容
	// 哈希命名并长期复用，而 FIX-39 没有新增迁移文件），此时版本行 INSERT 引用的列还不
	// 存在 —— 那不是本判据要测的东西。生产路径同样是"先过账本阶段、再进迁移循环"。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("准备（补齐账本 + 幂等重跑）: %v", err)
	}

	const fixtureVersion = 9902
	fixture := migration{
		version: fixtureVersion,
		name:    "9902_r28_version_row_budget.sql",
		sql:     "SELECT 1;\n", // 自身不取任何表锁
	}

	// 阻塞 SHARE（与版本行 INSERT 的 ROW EXCLUSIVE 冲突）。持有时长有界，变异体下
	// 用例仍能在有限时间内给出结论。
	_, release := holdTableLock(t, db, "schema_migrations", "SHARE", 8*time.Second)
	defer release()

	start := time.Now()
	_, err := applyOneMigration(context.Background(), db, fixture, 1000*time.Millisecond, 5*time.Second, nil)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("版本行写入被并发锁挡住时必须响亮失败；实测耗时 %s", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("版本行写入必须有界：预算 1s，实测 %s（无界 = 启动期静默挂死）", elapsed)
	}
	for _, want := range []string{"9902", "55P03"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误必须点名 %q；实际: %v", want, err)
		}
	}
	// 失败必须干净：版本行不能落库（半应用 = schema 与账本不一致）。
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version = $1`, fixtureVersion).Scan(&rows); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if rows != 0 {
		t.Fatalf("失败后不应存在 %d 的版本行，实际 %d 行（半应用）", fixtureVersion, rows)
	}

	// 释放阻塞源后同一条迁移必须成功落库（失败 ≠ 卡死）。
	release()
	if _, err := applyOneMigration(context.Background(), db, fixture, 1000*time.Millisecond, 5*time.Second, nil); err != nil {
		t.Fatalf("释放阻塞源后必须成功: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version = $1`, fixtureVersion).Scan(&rows); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if rows != 1 {
		t.Fatalf("成功路径必须落一行版本行，实际 %d 行", rows)
	}
	mustExec(t, db, `DELETE FROM schema_migrations WHERE version = $1`, fixtureVersion)
}

// TestMigrationDDLStatementClassesAllBoundedByTheTransactionBudget 是 ① 清单的**逐类**判据。
//
// 迁移文件里真正会取锁的语句有哪几类（`migrations-pg/*.sql` 全量清点：ALTER TABLE 42 个
// 文件、CREATE TABLE 28、CREATE INDEX 21（含 3 个 UNIQUE）、DROP 14、TRUNCATE 0），
// 加上执行器自己的两条账本 DDL 与版本行 INSERT。它们在**同一条迁移事务**里执行，因此
// 共享 `SET LOCAL lock_timeout`。这一条按"语句类别 × 冲突锁模式"逐类真跑一遍：
// 每一类都必须在有界时间内以 55P03 失败，而不是等锁释放。
//
// （账本两条 DDL + 版本行 INSERT 由本文件另外两条用例覆盖；这里覆盖迁移正文那一侧。）
func TestMigrationDDLStatementClassesAllBoundedByTheTransactionBudget(t *testing.T) {
	const budget = 600 * time.Millisecond
	cases := []struct {
		name    string
		table   string
		mode    string // 阻塞者持有的锁模式
		setup   string // 需要的预置 DDL（空 = 不需要）
		sql     string // 夹具迁移正文（要取锁的那一类语句）
		version int
	}{
		{
			name: "ALTER TABLE（ACCESS EXCLUSIVE）", table: "models", mode: "ACCESS SHARE",
			sql: "ALTER TABLE models ADD COLUMN IF NOT EXISTS zz_r28_probe INT;", version: 9911,
		},
		{
			name: "CREATE INDEX（SHARE）", table: "models", mode: "ACCESS EXCLUSIVE",
			sql: "CREATE INDEX zz_r28_probe_idx ON models (name);", version: 9912,
		},
		{
			name: "CREATE UNIQUE INDEX（SHARE）", table: "models", mode: "ACCESS EXCLUSIVE",
			sql: "CREATE UNIQUE INDEX zz_r28_probe_uidx ON models (id);", version: 9913,
		},
		{
			name: "DROP TABLE（ACCESS EXCLUSIVE）", table: "zz_r28_drop", mode: "ACCESS SHARE",
			setup: "CREATE TABLE zz_r28_drop (id INT);",
			sql:   "DROP TABLE zz_r28_drop;", version: 9914,
		},
		{
			name: "TRUNCATE（ACCESS EXCLUSIVE）", table: "zz_r28_trunc", mode: "ACCESS SHARE",
			setup: "CREATE TABLE zz_r28_trunc (id INT);",
			sql:   "TRUNCATE zz_r28_trunc;", version: 9915,
		},
		{
			name: "DML（ROW EXCLUSIVE）", table: "models", mode: "SHARE",
			sql: "UPDATE models SET catalog_missing = catalog_missing WHERE false;", version: 9916,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db := openTestDB(t)
			defer db.Close()
			if err := ApplyMigrations(db); err != nil {
				t.Fatalf("准备（补齐账本）: %v", err)
			}
			if tc.setup != "" {
				mustExec(t, db, tc.setup)
			}
			_, release := holdTableLock(t, db, tc.table, tc.mode, 6*time.Second)
			defer release()

			fixture := migration{version: tc.version, name: "9911_r28_statement_class.sql", sql: tc.sql + "\n"}
			start := time.Now()
			_, err := applyOneMigration(context.Background(), db, fixture, budget, 5*time.Second, nil)
			elapsed := time.Since(start)

			if err == nil {
				t.Fatalf("被 %s 挡住时必须响亮失败；实测耗时 %s（无界 = 启动期静默挂死）", tc.mode, elapsed)
			}
			if elapsed > 3*time.Second {
				t.Fatalf("必须有界：预算 %s，实测 %s", budget, elapsed)
			}
			if !strings.Contains(err.Error(), "55P03") {
				t.Fatalf("错误必须带 SQLSTATE 55P03；实际: %v", err)
			}
			var rows int
			if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version = $1`, tc.version).Scan(&rows); err != nil {
				t.Fatalf("读版本行: %v", err)
			}
			if rows != 0 {
				t.Fatalf("失败后不应存在版本行（半应用），实际 %d 行", rows)
			}
		})
	}
}

// emptyTestDB 建一个**空**库（不走模板克隆）并返回句柄。
//
// 条 4 要的是"从 0001 跑到 0082 的完整链"，模板库里链早就跑完了 ⇒ 必须空库形态。
func emptyTestDB(t *testing.T) (*sql.DB, func()) {
	t.Helper()
	adminDSN := PgTestDSN()
	admin := requireTestPG(t, adminDSN)
	u, err := url.Parse(adminDSN)
	if err != nil {
		admin.Close()
		t.Fatalf("parse test dsn: %v", err)
	}
	adminURL := *u
	adminURL.Path = "/postgres"
	name := "picoaide_test_empty_" + randomSuffix(6)
	if _, err := admin.Exec("CREATE DATABASE " + name); err != nil {
		admin.Close()
		t.Fatalf("create empty test db %s: %v", name, err)
	}
	u.Path = "/" + name
	db, err := Open(DBConfig{Driver: DriverPG, DSN: u.String()})
	if err != nil {
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		admin.Close()
		t.Fatalf("open empty test db: %v", err)
	}
	cleanup := func() {
		db.Close()
		_, _ = admin.Exec("DROP DATABASE IF EXISTS " + name + " WITH (FORCE)")
		admin.Close()
	}
	return db, cleanup
}

// TestMigrationFullChainAppliesAndBudgetDoesNotLeakIntoPool 是条 4（正向 + 不泄漏）。
//
// 两件事都必须成立，缺一条修复就不算成立：
//   - 无并发锁时**完整迁移链**照常跑完（预算不是"把迁移变严"）；
//   - 预算**不得**留在任何一条归还池的连接上（会话级 SET 的经典副作用：泄漏后
//     后续业务查询会莫名其妙地在 1s 处等锁超时）。
func TestMigrationFullChainAppliesAndBudgetDoesNotLeakIntoPool(t *testing.T) {
	db, cleanup := emptyTestDB(t)
	defer cleanup()

	t.Setenv(migrationDDLLockBudgetEnv, "1500")

	start := time.Now()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("无并发锁时必须照常成功（完整链 0001→%04d）: %v", schemaMaxVersion(migrationsFor()), err)
	}
	t.Logf("空库完整迁移链耗时 %s（%d 条迁移）", time.Since(start).Round(time.Millisecond), len(migrationsFor()))

	// checksum 列由账本阶段建出，且每条迁移都带上了摘要（写入侧）。
	var rows, unregistered int
	if err := db.QueryRow(`SELECT count(*), count(*) FILTER (WHERE `+checksumUnregisteredPredicate+`) FROM schema_migrations`).
		Scan(&rows, &unregistered); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if want := len(migrationsFor()); rows != want {
		t.Fatalf("版本行 = %d，want %d（完整链未跑完或跑多了）", rows, want)
	}
	if unregistered != 0 {
		t.Fatalf("每条迁移都必须带内容摘要，仍有 %d 行未登记", unregistered)
	}

	// 预算不得泄漏：预算取 1500ms（PG 会显示成 1.5s），池里**任何**连接上的
	// lock_timeout 都必须还是服务端缺省（0）。
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		var v string
		if err := db.QueryRow("SHOW lock_timeout").Scan(&v); err != nil {
			t.Fatalf("SHOW lock_timeout: %v", err)
		}
		seen[v] = true
		if v != "0" {
			t.Fatalf("预算泄漏到池连接：lock_timeout = %q（want 0）—— 会话级 SET 必须在同一会话上 RESET", v)
		}
	}
	if len(seen) == 0 {
		t.Fatal("没有采样到任何连接（判据退化成恒真）")
	}
}

// 分类标签（供分类计数断言使用）。
const (
	budgetReasonLedgerClosure = "withLockBudget 闭包：会话级 lock_timeout 覆盖（账本建表/补列/读/回填）"
	budgetReasonMigrationTx   = "事务预算：同一接收者在本函数内先前已 SET LOCAL lock_timeout（该语句在其后）"
	budgetReasonAdvisory      = "withLockBudget 闭包：advisory 锁等待的会话级预算"
	budgetReasonAltBudget     = "另一份**已登记**的预算机制：同一函数内先前已调用（见 lockSiteExemptions）"
	budgetReasonSetup         = "预算设置语句本身（SET LOCAL lock_timeout 不取表锁）"
)

// migrationDBAllowance 是一条"允许不落在预算会话内"的登记项。
//
// 每一条都必须带理由 —— "不加预算"本身是一个决定，必须写在纸面上；没登记的调用点
// 一律判红。stmtFragment 非空时只匹配 SQL 里含该片段的调用点（区分同一函数里同一
// 接收者的不同语句）。file 是**扫描根的一部分**：搬文件即陈旧（双向对账会红）。
type migrationDBAllowance struct {
	file, fn, recv, method string
	stmtFragment           string
	why                    string
}

// migrationDBAllowlist 是迁移执行器里允许不落在预算会话内的 DB 调用点。
var migrationDBAllowlist = []migrationDBAllowance{
	// 预算机制本身：SET/RESET lock_timeout 不取任何表锁。
	{file: "migrate.go", fn: "withLockBudget", recv: "conn", method: "*", why: "预算机制本身（SET/RESET lock_timeout 不取表锁）"},
	// 锁窗口采样：只读 pg_locks / pg_stat_activity，且自带 2s ctx 超时（见 sampleLockState）。
	{file: "migrate.go", fn: "sampleLockState", recv: "w.conn", method: "*", why: "锁窗口采样：只读 pg_catalog/pg_locks，自带 2s ctx 超时"},
	// 开启事务不取表锁；事务内的语句全在 `SET LOCAL lock_timeout` 之后（位置由判据自己比）。
	{file: "migrate.go", fn: "applyOneMigration", recv: "db", method: "BeginTx", why: "开事务不取表锁；事务内语句由本函数开头的 SET LOCAL 覆盖（位置另判）"},
	// 取一条池连接（`db.Conn` 不取表锁）：预算随后由 withLockBudget 施加在这条会话上。
	{file: "migrate.go", fn: "applyMigrations", recv: "db", method: "Conn", why: "取池连接（不取表锁）；预算由紧随其后的 withLockBudget 施加在这条会话上"},
	// 释放 advisory 锁：pg_advisory_unlock 不等待（没有"等锁"语义）。
	{file: "migrate.go", fn: "applyMigrations", recv: "conn", method: "ExecContext", stmtFragment: "pg_advisory_unlock",
		why: "释放 advisory 锁：pg_advisory_unlock 不等待、不取表锁"},
}

// lockStatementClasses 是"会取表级锁、因此必须有界"的语句类别（只看 SQL 文本的粗判据）。
//
// 为什么**只收这些**、不收普通 DML 与 `SELECT … FOR UPDATE`（如实登记的边界）：本判据
// 守护的是**启动期迁移执行器**的无界等待 —— 它跑在启动路径上、没有调用方 ctx 兜底，
// 等锁就是"容器起不来"。运行期业务语句（分区维护 / 用量回收 / 余额行锁）各有请求级或
// 调度级的预算与登记（见 lockSiteExemptions 的 altBudget 列）；把它们一起收进"必须
// 登记"的面只会让判据退化成形式主义。
//
// 唯一例外：`schema_migrations`（迁移账本表）的**任何**语句都算取锁 —— 版本行 INSERT
// 取 ROW EXCLUSIVE，与 SHARE 冲突（R28 条 2 真 PG 实测的形态），而账本表只有迁移执行器碰。
var lockStatementClasses = []string{
	"LOCK TABLE", "ALTER TABLE", "ALTER INDEX", "CREATE TABLE", "CREATE INDEX",
	"CREATE UNIQUE INDEX", "DROP TABLE", "DROP INDEX", "TRUNCATE", "REINDEX", "CLUSTER",
}

// lockTakingClass 判定一段 SQL 属于哪一类取锁语句（空串 = 不算取锁语句）。
func lockTakingClass(sql string) string {
	upper := strings.ToUpper(sql)
	for _, class := range lockStatementClasses {
		if strings.Contains(upper, class) {
			return class
		}
	}
	if strings.Contains(upper, "SCHEMA_MIGRATIONS") {
		return "schema_migrations（迁移账本表）"
	}
	return ""
}

// lockSiteExemption 是一条"取锁语句不落在预算会话内、但已经被回答过"的登记项。
//
// 两种口径，且**都必须可验证**（不是一句注释）：
//   - altBudget 非空：同一函数里必须**真的调用过**这个替代预算机制，且位置在该语句
//     之前（例：`applyUsageRetentionBudget` / `setUsageRetentionStatementBudget`）；
//   - notOnStartupPath：该函数必须**不在**迁移入口的可达集里（判据自己算调用图）——
//     这条取锁语句不在启动路径上；一旦有人把它接进迁移路径，判据立刻红。
//
// 两列都为空 = 不可验证的豁免 ⇒ 判据直接拒绝该登记项。
type lockSiteExemption struct {
	file, fn, method string
	sqlFragment      string
	altBudget        string
	notOnStartupPath bool
	why              string
}

// lockSiteExemptions 是整包里**允许**不落在 withLockBudget / 事务预算内的取锁语句。
//
// 这一张表是"扫描根改成整包"的代价，也是它的价值：整包口径下每一条运行期 DDL/锁
// 都必须被显式回答过（而不是因为文件不在扫描根里就没人看见）。
var lockSiteExemptions = []lockSiteExemption{
	{
		file: "usage_ledger.go", fn: "settleUsageReclaim", method: "Exec", sqlFragment: "LOCK TABLE ONLY",
		altBudget: "applyUsageRetentionBudget",
		why:       "用量回收的结算段：同函数先前已 applyUsageRetentionBudget(tx, …)（SET LOCAL lock_timeout + statement_timeout），整段另罩在 budgetMS 的 ctx deadline 里；不在启动迁移路径。",
	},
	{
		file: "usage_ledger.go", fn: "reclaimUsagePartitionAtomically", method: "Exec", sqlFragment: "LOCK TABLE ONLY",
		altBudget: "setUsageRetentionStatementBudget",
		why:       "用量回收的冻结段：同函数先前已 setUsageRetentionStatementBudget(tx)，整段罩在 usageReclaimFreezeBudgetMS 的 ctx（含 COMMIT）里；不在启动迁移路径。",
	},
	{
		file: "usage_ledger.go", fn: "reclaimUsagePartitionAtomically", method: "Exec", sqlFragment: "IN ACCESS EXCLUSIVE MODE",
		altBudget: "setUsageRetentionStatementBudget",
		why:       "同上（对 rel 子树的 ACCESS EXCLUSIVE）；锁级别按 relkind 分流见 usageReclaimTargetLock，预算来自同一份已登记机制。",
	},
	{
		file: "usage_ledger.go", fn: "reclaimUsagePartitionAtomically", method: "Exec", sqlFragment: "DETACH PARTITION",
		altBudget: "setUsageRetentionStatementBudget",
		why:       "同上（冻结段的 DETACH，父表 AEX 随本事务结束释放）；预算来自同一份已登记机制。",
	},
	{
		file: "partitions.go", fn: "adoptDetachedMonthPartition", method: "Exec", sqlFragment: "DETACH PARTITION",
		notOnStartupPath: true,
		why:              "运行期的「同名孤儿月分区领回」（写路径自愈）：不在启动迁移路径上（判据算调用图确认），因此不适用启动期等锁预算；**残留风险如实登记**：该事务自身没有 lock_timeout，属运行期既有形态，不在本轮判据面的修法范围内。",
	},
	{
		file: "partitions.go", fn: "adoptDetachedMonthPartition", method: "Exec", sqlFragment: "ATTACH PARTITION",
		notOnStartupPath: true,
		why:              "同上（领回的第二条语句 ATTACH）；与 DETACH 同一个事务、同一条残留风险。",
	},
}

// TestMigrationLockTakingStatementsAreAllBudgeted 是条 3：**清单级**判据（整包口径）。
//
// 病根（FIX-39）：只给"当下被点名的那条语句"加预算 ⇒ 同一个函数里另外四条取锁语句
// 原样漏掉，而判据全绿。所以这里不钉某条语句，而是把整包的 DB 调用点枚举出来，逐条
// 要求：要么落在预算会话内，要么在登记表里带理由。
//
// **R29-AC1-03 的三条取值域缺口**（本函数 2026-09-27 重写的原因，与下面三件事一一对应）：
//   - 扫描根只有 `migrate.go` **一个文件** ⇒ 同包另一个文件里的取锁语句结构上看不见；
//   - 只认 `*ast.SelectorExpr` 形态的调用 ⇒ `exec := db.ExecContext; exec(…)` 整条在面外；
//   - 只问"函数体里**出现过** SET LOCAL lock_timeout" ⇒ 取锁语句排在预算设置**之前**也算已预算。
//
// 现在的取值域：**整包非测试 .go** × **(selector ∪ 方法值别名)** × **(语句类别 + 位置)**，
// 外加一张**可验证**的豁免登记表（替代预算机制必须真的被调用；"不在启动路径"由判据自己
// 算调用图）。三个方向都要防（本仓已复发三次的教训）：扫描根过窄 / 取值域过窄 / 恒真。
func TestMigrationLockTakingStatementsAreAllBudgeted(t *testing.T) {
	fset := token.NewFileSet()
	files := parseServerstorePackage(t, fset)

	// 会走到数据库的方法（含取连接与开事务：它们不取表锁，但"要不要登记"必须是被
	// 显式回答过的问题，而不是没人看见）。
	dbMethods := map[string]bool{
		"Exec": true, "ExecContext": true,
		"Query": true, "QueryContext": true,
		"QueryRow": true, "QueryRowContext": true,
		"Conn": true, "BeginTx": true,
	}

	reachable := migrationReachable(files)
	altSymbols := map[string]bool{}
	for _, ex := range lockSiteExemptions {
		if ex.altBudget != "" {
			altSymbols[ex.altBudget] = true
		}
	}

	var sites []dbCallSite

	for name, file := range files {
		// 每份文件三张**位置感知**的表（都不是按名字认协议，而是按源码事实）：
		//   - setups：`SET LOCAL lock_timeout` 落在哪条接收者上、位置在哪；
		//   - altBudgets：登记表点名的替代预算机制在哪个函数里被调用；
		//   - aliases：`x := <recv>.<Method>` 方法值别名（R29-AC1-03 的 N4 形态）。
		setups := map[string][]token.Pos{}
		altBudgets := map[string][]token.Pos{}
		var aliases []dbAlias
		var pre []ast.Node
		ast.Inspect(file, func(n ast.Node) bool {
			if n == nil {
				pre = pre[:len(pre)-1]
				return true
			}
			defer func() { pre = append(pre, n) }()
			assign, ok := n.(*ast.AssignStmt)
			if ok && len(assign.Lhs) == 1 && len(assign.Rhs) == 1 {
				if id, ok := assign.Lhs[0].(*ast.Ident); ok {
					if sel, ok := assign.Rhs[0].(*ast.SelectorExpr); ok && dbMethods[sel.Sel.Name] && id.Name != "_" {
						aliases = append(aliases, dbAlias{name: id.Name, recv: exprText(sel.X), method: sel.Sel.Name, pos: assign.Pos()})
					}
				}
			}
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			if id, ok := call.Fun.(*ast.Ident); ok && altSymbols[id.Name] {
				altBudgets[enclosingFunc(pre)] = append(altBudgets[enclosingFunc(pre)], call.Pos())
			}
			if sel, ok := call.Fun.(*ast.SelectorExpr); ok && dbMethods[sel.Sel.Name] {
				if strings.Contains(allStringLiterals(call), "SET LOCAL lock_timeout") {
					key := enclosingFunc(pre) + "|" + exprText(sel.X)
					setups[key] = append(setups[key], call.Pos())
				}
			}
			return true
		})

		var stack []ast.Node
		ast.Inspect(file, func(n ast.Node) bool {
			if n == nil {
				stack = stack[:len(stack)-1]
				return true
			}
			defer func() { stack = append(stack, n) }()
			call, ok := n.(*ast.CallExpr)
			if !ok {
				return true
			}
			recv, method, ok := resolveDBReceiver(call, aliases, dbMethods)
			if !ok {
				return true
			}
			fn := enclosingFunc(stack)
			sql := allStringLiterals(call)
			s := dbCallSite{
				file: name, fn: fn, recv: recv, method: method,
				pos:       fset.Position(call.Pos()),
				sql:       sql,
				stmtArg:   firstStringLiteral(call),
				lockClass: lockTakingClass(sql),
			}

			inClosure, budgetRecv := lockBudgetClosure(stack)
			budgetSetup := strings.Contains(sql, "SET LOCAL lock_timeout")
			switch {
			case fn == "withLockBudget":
				s.reason = migrationDBAllowlist[0].why
			case budgetSetup:
				// 预算设置语句**自己**：它不取任何表锁，而且位置判据必须把它排除，
				// 否则"取锁语句必须在 SET LOCAL 之后"会把 SET LOCAL 本身判成违规。
				s.reason = budgetReasonSetup
			case inClosure && recv == budgetRecv:
				if method == "ExecContext" && strings.Contains(s.stmtArg, "pg_advisory_lock") {
					s.reason = budgetReasonAdvisory
				} else {
					s.reason = budgetReasonLedgerClosure
				}
			case inClosure && recv != budgetRecv:
				// **R28-FIX41 变异 A 抓出来的缺口**：预算施加在 `budgetRecv` 那条专用会话上，
				// 闭包里改走池连接（`db.Exec`）时预算**完全无效** —— 而"语句在预算闭包里"这句
				// 话仍然成立，所以只判"在不在闭包里"会假绿。必须按**接收者**判。
				s.missed = true
				s.missedWhy = "这条语句在 withLockBudget 闭包内，但跑在 " + recv + " 上，而预算是施加在 " + budgetRecv +
					" 这条会话上的 ⇒ 该语句**不受预算约束**（把账本 DDL 挪回池连接 = 复现 R28 AB1-02 的无界挂死）"
			default:
				// ① 事务预算：同一接收者在本函数里先前已 `SET LOCAL lock_timeout`。
				//    位置判据（R29-AC1-03 的 N3 形态）：**取锁语句**排在预算设置之前不算已预算；
				//    不取锁的语句（例如 `SET LOCAL DateStyle`）不受位置约束。
				if positions := setups[fn+"|"+recv]; len(positions) > 0 {
					before := false
					for _, p := range positions {
						if p < call.Pos() {
							before = true
						}
					}
					switch {
					case before:
						s.reason = budgetReasonMigrationTx
					case s.lockClass == "":
						// 非取锁语句：位置无关，交给下面的档位判（迁移路径上的仍要登记）。
					default:
						s.missed = true
						s.missedWhy = "取锁语句排在 `SET LOCAL lock_timeout` **之前**（同一接收者 " + recv + "、函数 " + fn +
							"）⇒ 这条语句不在预算内。预算必须**先设后用**（AC1-03 的 N3 形态：分类计数照样对、顺序错了）"
					}
				} else if ex, ok := matchLockExemption(s.file, fn, method, sql); ok && ex.altBudget != "" {
					// ② 已登记的替代预算机制：必须真的在**同一函数**里、且在该语句之前被调用。
					hasBefore := false
					for _, p := range altBudgets[fn] {
						if p < call.Pos() {
							hasBefore = true
						}
					}
					if hasBefore {
						s.reason = budgetReasonAltBudget + "（" + ex.altBudget + "）"
					} else {
						s.missed = true
						s.missedWhy = "登记项声称预算来自 " + ex.altBudget + "，但函数 " + fn + " 里找不到它（或在取锁语句之后才调用）—— 豁免必须可验证"
					}
				} else {
					// ③ 逐条登记的"不加预算"（清单驱动；每条必须带理由）。
					for _, a := range migrationDBAllowlist {
						if a.file != s.file || a.fn != fn || a.recv != recv {
							continue
						}
						if a.method != "*" && a.method != method {
							continue
						}
						if a.stmtFragment != "" && !strings.Contains(s.stmtArg, a.stmtFragment) {
							continue
						}
						s.reason = a.why
						break
					}
					if s.reason == "" {
						s.missed = true
					}
				}
			}
			sites = append(sites, s)
			return true
		})
	}

	// 扫描面下界：文件数、调用点数、取锁类别与承重分类都必须真的出现，否则判据可能是恒真。
	if len(files) < 30 {
		t.Fatalf("只解析到 %d 个非测试 .go 文件（serverstore 现有 45 个）—— 扫描根变窄了，判据正在退化成恒真", len(files))
	}
	if len(sites) < 250 {
		t.Fatalf("整包只扫到 %d 个 DB 调用点（现有 411 个）—— 取值域变窄了，判据正在退化成恒真", len(sites))
	}
	lockSites := 0
	for _, s := range sites {
		if s.lockClass != "" {
			lockSites++
		}
	}
	if lockSites < 6 {
		t.Fatalf("整包只扫到 %d 条取锁语句（现有 8 条）—— 取锁类别判据失效", lockSites)
	}
	cats := map[string]int{}
	for _, s := range sites {
		if s.reason != "" {
			cats[s.reason]++
		}
	}
	for _, must := range []string{
		budgetReasonLedgerClosure, budgetReasonMigrationTx, budgetReasonAdvisory,
		budgetReasonAltBudget + "（applyUsageRetentionBudget）",
	} {
		if cats[must] == 0 {
			t.Fatalf("没有任何调用点落在 %q 这一类 ⇒ 判据的分类失效（实际分类: %v）", must, cats)
		}
	}
	// 预算机制本身必须真的还在（SET + RESET 两条）。
	if cats[migrationDBAllowlist[0].why] < 2 {
		t.Fatal("withLockBudget 内的 SET/RESET 没被扫到：预算机制被搬走或改名了")
	}

	// 登记表**双向**对账：豁免项必须仍然命中真实语句（陈旧登记 = 免检区）。
	for _, ex := range lockSiteExemptions {
		if len([]rune(ex.why)) < 20 {
			t.Errorf("豁免登记 %s|%s 的理由太短：必须写清取值形态与判定依据", ex.file, ex.fn)
		}
		if ex.altBudget == "" && !ex.notOnStartupPath {
			t.Errorf("豁免登记 %s|%s 既没有替代预算机制、也没有声明不在启动路径 ⇒ 不可验证的豁免不许进表", ex.file, ex.fn)
		}
		if ex.notOnStartupPath && reachable[ex.fn] {
			t.Errorf("豁免登记 %s|%s 声称「不在启动路径」，但它**在**迁移入口的可达集里 ⇒ 该取锁语句必须有预算", ex.file, ex.fn)
		}
		hit := false
		for _, s := range sites {
			if s.file == ex.file && s.fn == ex.fn && s.method == ex.method && strings.Contains(s.sql, ex.sqlFragment) {
				hit = true
				break
			}
		}
		if !hit {
			t.Errorf("豁免登记 %s|%s|%q 已经匹配不到任何真实语句（改名/搬走/改写）—— 请删掉或改写这条登记（豁免表不许变成免检区）",
				ex.file, ex.fn, ex.sqlFragment)
		}
	}

	for _, s := range sites {
		if !s.missed {
			continue
		}
		if s.missedWhy != "" {
			t.Errorf("%s: %s", s.pos, s.missedWhy)
			continue
		}
		// 未落预算的调用点分两档（口径与理由都写在判据的注释里）：
		//   ① 取锁语句（DDL / LOCK / 账本表）：**整包**范围内必须有预算或登记理由；
		//   ② 非取锁语句：只在**预算执行器文件**（调过 withLockBudget 的文件）里判。
		//      运行期只读查询不在此列 —— 它们没有启动期无界挂死的语义，收进来只会把
		//      判据变成"每行业务 SQL 都要登记"（`Open` → `SHOW max_connections` 就是例子）。
		if s.lockClass != "" {
			if _, ok := matchLockExemption(s.file, s.fn, s.method, s.sql); ok {
				continue
			}
			t.Errorf("%s: %s 是一条**取锁语句**（类别 %s），却不在任何预算会话内、也没有在 lockSiteExemptions 里登记理由 "+
				"—— 取锁必须有界（R28 AB1-02 的账本 DDL 无界挂死；R29-AC1-03 的扫描根缺口）",
				s.pos, s.file, s.lockClass)
			continue
		}
		if budgetEnforcingFile(files[s.file]) {
			t.Errorf("%s: %s 这条 DB 调用点不在任何预算会话内，也没有在 migrationDBAllowlist 里登记理由"+
				"（它所在的文件承担预算职责）—— 新增取锁语句却忘了预算，判据必须红", s.pos, s.file)
		}
	}
	t.Logf("扫描 %d 个文件：%d 个 DB 调用点（其中取锁语句 %d 条），全部落在预算内或已登记；分类计数 %v",
		len(files), len(sites), lockSites, cats)
}

// dbCallSite 是一次 DB 调用点的静态事实（整包口径；file 是扫描根的一部分）。
type dbCallSite struct {
	file, fn, recv, method string
	pos                    token.Position
	sql                    string
	stmtArg                string
	lockClass              string
	reason                 string
	missed                 bool
	missedWhy              string
}

// dbAlias 是一次方法值别名绑定（`exec := db.ExecContext`）。
type dbAlias struct {
	name, recv, method string
	pos                token.Pos
}

// parseServerstorePackage 解析**整包**的非测试 .go 文件（键 = 文件名）。
//
// 扫描根 = 包目录（`migrate.go` 只是其中之一）。R29-AC1-03：把取值域钉在一个文件名上，
// 就是"同包新增文件即静默"的经典形态。
func parseServerstorePackage(t *testing.T, fset *token.FileSet) map[string]*ast.File {
	t.Helper()
	pkgs, err := parser.ParseDir(fset, ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, parser.SkipObjectResolution)
	if err != nil {
		t.Fatalf("解析 serverstore 包: %v", err)
	}
	out := map[string]*ast.File{}
	for _, pkg := range pkgs {
		for name, file := range pkg.Files {
			out[name] = file
		}
	}
	if len(out) == 0 {
		t.Fatal("一个非测试 .go 都没解析到：扫描根失效（判据会恒真）")
	}
	return out
}

// migrationReachable 返回**迁移入口可达**的函数名集合（包内调用图）。
//
// 为什么需要它：整包扫描之后，"哪些调用点必须被回答"不能靠文件名。入口 =
// `ApplyMigrations` / `EnsureMigrated`，边 = **裸标识符调用**（`foo(...)`）落在包内声明的
// 函数名上。刻意**不**认 `x.Method(...)` 形态的边：按方法名连边会把全包所有同名方法
// （`Exec` / `Query` / `Open` …）全拉进来，可达集瞬间变成"整个包"——那是假面，不是覆盖。
// 方法体里的预算问题由 `budgetEnforcingFile` 那一档与取锁类别那一档兜住。
func migrationReachable(files map[string]*ast.File) map[string]bool {
	bodies := map[string][]*ast.FuncDecl{}
	for _, file := range files {
		for _, decl := range file.Decls {
			fd, ok := decl.(*ast.FuncDecl)
			if !ok || fd.Name == nil || fd.Body == nil {
				continue
			}
			bodies[fd.Name.Name] = append(bodies[fd.Name.Name], fd)
		}
	}
	seen := map[string]bool{}
	queue := []string{"ApplyMigrations", "EnsureMigrated"}
	for len(queue) > 0 {
		name := queue[0]
		queue = queue[1:]
		if seen[name] {
			continue
		}
		seen[name] = true
		for _, fd := range bodies[name] {
			ast.Inspect(fd.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				id, ok := call.Fun.(*ast.Ident)
				if !ok {
					return true
				}
				if len(bodies[id.Name]) > 0 && !seen[id.Name] {
					queue = append(queue, id.Name)
				}
				return true
			})
		}
	}
	return seen
}

// budgetEnforcingFile 判定一份文件是不是"预算执行器"：文件里出现过 `withLockBudget(` 的调用。
//
// 这是"整包扫描"里那一半**强口径**的取值域来源：文件一旦承担预算职责，它里面**每一个**
// DB 调用点都必须被回答（与 SQL 类别无关）。命名无关 —— 新文件照做预算就自动进面。
func budgetEnforcingFile(file *ast.File) bool {
	if file == nil {
		return false
	}
	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		if id, ok := call.Fun.(*ast.Ident); ok && id.Name == "withLockBudget" {
			found = true
		}
		return true
	})
	return found
}

// matchLockExemption 在豁免登记表里找一条命中项（文件 + 函数 + 方法 + SQL 片段）。
func matchLockExemption(file, fn, method, sql string) (lockSiteExemption, bool) {
	for _, ex := range lockSiteExemptions {
		if ex.file != file || ex.fn != fn {
			continue
		}
		if ex.method != "" && ex.method != method {
			continue
		}
		if ex.sqlFragment != "" && !strings.Contains(sql, ex.sqlFragment) {
			continue
		}
		return ex, true
	}
	return lockSiteExemption{}, false
}

// resolveDBReceiver 解析一个调用点的**接收者与方法**，含方法值别名（`exec := db.ExecContext`）。
//
// 别名按位置取"最近一次先于本调用点的赋值"（同名遮蔽时不会拿到更早的那个）。R29-AC1-03
// 的 N4 形态（`call.Fun` 是 Ident 而不是 SelectorExpr）就在这里进面。
func resolveDBReceiver(call *ast.CallExpr, aliases []dbAlias, dbMethods map[string]bool) (string, string, bool) {
	if sel, ok := call.Fun.(*ast.SelectorExpr); ok && dbMethods[sel.Sel.Name] {
		return exprText(sel.X), sel.Sel.Name, true
	}
	id, ok := call.Fun.(*ast.Ident)
	if !ok {
		return "", "", false
	}
	best := -1
	for i := range aliases {
		if aliases[i].name != id.Name || aliases[i].pos >= call.Pos() {
			continue
		}
		if best < 0 || aliases[i].pos > aliases[best].pos {
			best = i
		}
	}
	if best < 0 {
		return "", "", false
	}
	return aliases[best].recv, aliases[best].method, true
}

// allStringLiterals 把一个调用实参里的字符串字面量按出现顺序拼起来（SQL 文本的近似）。
func allStringLiterals(call *ast.CallExpr) string {
	var b strings.Builder
	for _, a := range call.Args {
		ast.Inspect(a, func(n ast.Node) bool {
			if bl, ok := n.(*ast.BasicLit); ok && bl.Kind == token.STRING {
				b.WriteString(strings.Trim(bl.Value, "`\""))
			}
			return true
		})
	}
	return b.String()
}

// lockBudgetClosure 判定当前调用点是否在 `withLockBudget(...)` 的函数实参里，并返回
// **预算被施加到哪条会话**（`withLockBudget` 的第 2 个实参的源码形状，如 `conn`）。
//
// 只判"在不在闭包里"不够：闭包里改走池连接（`db.Exec`）时预算完全无效，而语句确实在
// 闭包内 —— 这个假绿是 R28-FIX41 的变异 A 实测抓出来的。
func lockBudgetClosure(stack []ast.Node) (bool, string) {
	for i := len(stack) - 1; i >= 1; i-- {
		lit, ok := stack[i].(*ast.FuncLit)
		if !ok {
			continue
		}
		call, ok := stack[i-1].(*ast.CallExpr)
		if !ok {
			return false, ""
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok || id.Name != "withLockBudget" {
			return false, ""
		}
		found := false
		for _, a := range call.Args {
			if a == lit {
				found = true
				break
			}
		}
		if !found || len(call.Args) < 2 {
			return false, ""
		}
		return true, exprText(call.Args[1])
	}
	return false, ""
}

// enclosingFunc 返回最近的函数（*ast.FuncDecl）名；匿名函数返回外层函数名。
func enclosingFunc(stack []ast.Node) string {
	for i := len(stack) - 1; i >= 0; i-- {
		if fd, ok := stack[i].(*ast.FuncDecl); ok {
			return fd.Name.Name
		}
	}
	return ""
}

// TestChecksumUnregisteredPredicateIsSharedByReadAndWrite 钉住 ② 的结构前提：
// 读侧（`SELECT … FROM schema_migrations`）与写侧（`UPDATE schema_migrations …`）必须都
// **引用同一个常量** `checksumUnregisteredPredicate`。任一边把 `checksum IS NULL OR
// checksum = ”` 重新写死，两边立刻分叉 —— 那正是 R28 AB1-05 的形态（读侧认空串、
// 写侧只认 NULL ⇒ 空串行永远回填不上、该行的内容对账永久关闭）。
//
// 为什么用 AST 而不是数文本出现次数：数文本会把注释/文档里的提及一起算进去
// （本仓已登记的"假绿/假红"形态），而 AST 只认"这段 SQL 的表达式里有没有那个标识符"。
func TestChecksumUnregisteredPredicateIsSharedByReadAndWrite(t *testing.T) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "migrate.go", nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("解析 migrate.go: %v", err)
	}
	const ident = "checksumUnregisteredPredicate"
	// 只看**真正执行**的语句（DB 调用的实参）：错误文案里也会出现同一句 SQL 的形状
	// （`MigrationChecksumError.Error()` 给运维的可行动作里就有一句 UPDATE），
	// 把散文/文案算进判据是这类检查最常见的假红/假绿来源。
	dbMethods := map[string]bool{
		"Exec": true, "ExecContext": true, "Query": true, "QueryContext": true,
		"QueryRow": true, "QueryRowContext": true,
	}
	readSide, writeSide := false, false
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || !dbMethods[sel.Sel.Name] {
			return true
		}
		var lits []string
		usesIdent := false
		for _, a := range call.Args {
			ast.Inspect(a, func(inner ast.Node) bool {
				switch v := inner.(type) {
				case *ast.BasicLit:
					if v.Kind == token.STRING {
						lits = append(lits, v.Value)
					}
				case *ast.Ident:
					if v.Name == ident {
						usesIdent = true
					}
				}
				return true
			})
		}
		sql := strings.Join(lits, "")
		if strings.Contains(sql, "FROM schema_migrations") {
			readSide = true
			if !usesIdent {
				t.Errorf("%s: 读侧的 SELECT 没有引用 %s —— 谓词被写死了第二份（两边分叉即 AB1-05 复发）",
					fset.Position(call.Pos()), ident)
			}
		}
		if strings.Contains(sql, "UPDATE schema_migrations") {
			writeSide = true
			if !usesIdent {
				t.Errorf("%s: 写侧的 UPDATE 没有引用 %s —— 谓词被写死了第二份", fset.Position(call.Pos()), ident)
			}
		}
		return true
	})
	if !readSide || !writeSide {
		t.Fatalf("没能在 migrate.go 里同时找到读侧与写侧语句（read=%v write=%v）—— 判据退化成恒真", readSide, writeSide)
	}
	// 常量本身只允许有一处定义（改名/复制会在这里露出来）。
	defs := 0
	ast.Inspect(file, func(n ast.Node) bool {
		if vs, ok := n.(*ast.ValueSpec); ok {
			for _, name := range vs.Names {
				if name.Name == ident {
					defs++
				}
			}
		}
		return true
	})
	if defs != 1 {
		t.Fatalf("%s 的定义有 %d 处，want 1（唯一真源）", ident, defs)
	}
}

// exprText 返回表达式的源码形状（`db` / `conn` / `tx` / `w.conn`）。
func exprText(e ast.Expr) string {
	switch v := e.(type) {
	case *ast.Ident:
		return v.Name
	case *ast.SelectorExpr:
		return exprText(v.X) + "." + v.Sel.Name
	default:
		return "?"
	}
}

// firstStringLiteral 返回调用实参里第一个字符串字面量（用于区分同一接收者的不同语句，
// 例如 `pg_advisory_unlock`）。
func firstStringLiteral(call *ast.CallExpr) string {
	for _, a := range call.Args {
		if bl, ok := a.(*ast.BasicLit); ok && bl.Kind == token.STRING {
			return strings.Trim(bl.Value, "`\"")
		}
	}
	return ""
}
