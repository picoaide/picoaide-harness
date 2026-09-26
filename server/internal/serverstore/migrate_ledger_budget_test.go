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

// 两个"在预算内"的类别标签（供分类计数断言使用）。
const (
	budgetReasonLedgerClosure = "withLockBudget 闭包：会话级 lock_timeout 覆盖（账本建表/补列/读/回填）"
	budgetReasonMigrationTx   = "迁移事务：函数开头已 SET LOCAL lock_timeout（DDL + 版本行 INSERT）"
	budgetReasonAdvisory      = "withLockBudget 闭包：advisory 锁等待的会话级预算"
)

// migrationDBAllowance 是一条"允许不落在预算会话内"的登记项。
//
// 每一条都必须带理由 —— "不加预算"本身是一个决定，必须写在纸面上；没登记的调用点
// 一律判红。stmtFragment 非空时只匹配 SQL 里含该片段的调用点（区分同一函数里同一
// 接收者的不同语句）。
type migrationDBAllowance struct {
	fn, recv, method string
	stmtFragment     string
	why              string
}

// migrationDBAllowlist 是 migrate.go 里允许不落在预算会话内的 DB 调用点。
var migrationDBAllowlist = []migrationDBAllowance{
	// 预算机制本身：SET/RESET lock_timeout 不取任何表锁。
	{fn: "withLockBudget", recv: "conn", method: "*", why: "预算机制本身（SET/RESET lock_timeout 不取表锁）"},
	// 锁窗口采样：只读 pg_locks / pg_stat_activity，且自带 2s ctx 超时（见 sampleLockState）。
	{fn: "sampleLockState", recv: "w.conn", method: "*", why: "锁窗口采样：只读 pg_catalog/pg_locks，自带 2s ctx 超时"},
	// 开启事务不取表锁；事务内的三条语句全在 `SET LOCAL lock_timeout` 之后。
	{fn: "applyOneMigration", recv: "db", method: "BeginTx", why: "开事务不取表锁；事务内语句由本函数开头的 SET LOCAL 覆盖"},
	// 取一条池连接（`db.Conn` 不取表锁）：预算随后由 withLockBudget 施加在这条会话上。
	{fn: "applyMigrations", recv: "db", method: "Conn", why: "取池连接（不取表锁）；预算由紧随其后的 withLockBudget 施加在这条会话上"},
	// 释放 advisory 锁：pg_advisory_unlock 不等待（没有"等锁"语义）。
	{fn: "applyMigrations", recv: "conn", method: "ExecContext", stmtFragment: "pg_advisory_unlock",
		why: "释放 advisory 锁：pg_advisory_unlock 不等待、不取表锁"},
}

// TestMigrationLockTakingStatementsAreAllBudgeted 是条 3：**清单级**判据。
//
// 病根（FIX-39）：只给"当下被点名的那条语句"加预算 ⇒ 同一个函数里另外四条取锁语句
// 原样漏掉，而判据全绿。所以这里不钉某条语句，而是把 migrate.go 的**全部** DB 调用点
// 枚举出来，逐条要求：要么落在预算会话内（withLockBudget 的闭包 / 已 SET LOCAL 的事务），
// 要么在 migrationDBAllowlist 里带理由登记。新增取锁语句却忘了预算 ⇒ 本判据红。
//
// 三个必须防的假绿形态（本仓已复发三次的教训）：
//   - 扫描根过窄：只扫 `applyMigrations` 会漏掉同文件其它函数 ⇒ 这里扫整个文件的所有函数；
//   - 取值域过窄：只认 `db.` 前缀会漏掉 `conn.` / `tx.` / `w.conn.` ⇒ 这里按任意接收者枚举；
//   - 恒真：一条都没扫到也"通过" ⇒ 末尾对扫描面下界做断言。
func TestMigrationLockTakingStatementsAreAllBudgeted(t *testing.T) {
	const src = "migrate.go"
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, src, nil, parser.ParseComments)
	if err != nil {
		t.Fatalf("解析 %s: %v", src, err)
	}

	// 会走到数据库的方法（含取连接与开事务：它们不取表锁，但"要不要登记"必须是被
	// 显式回答过的问题，而不是没人看见）。
	dbMethods := map[string]bool{
		"Exec": true, "ExecContext": true,
		"Query": true, "QueryContext": true,
		"QueryRow": true, "QueryRowContext": true,
		"Conn": true, "BeginTx": true,
	}

	type site struct {
		pos       token.Position
		key       string
		reason    string // 非空 = 已判定为"在预算内"
		missed    bool
		missedWhy string
		stmtArg   string
	}
	var sites []site

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
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || !dbMethods[sel.Sel.Name] {
			return true
		}
		recv := exprText(sel.X)
		fn := enclosingFunc(stack)
		method := sel.Sel.Name
		s := site{pos: fset.Position(call.Pos()), key: fn + "|" + recv + "|" + method, stmtArg: firstStringLiteral(call)}

		inClosure, budgetRecv := lockBudgetClosure(stack)
		switch {
		case fn == "withLockBudget":
			s.reason = migrationDBAllowlist[0].why
		case inClosure && recv == budgetRecv:
			if method == "ExecContext" && strings.Contains(s.stmtArg, "pg_advisory_lock") {
				s.reason = budgetReasonAdvisory
			} else {
				s.reason = budgetReasonLedgerClosure
			}
		case inClosure && recv != budgetRecv:
			// **R28-FIX41 变异 A 抓出来的缺口**：预算施加在 `budgetRecv` 那条专用会话上，
			// 闭包里改走池连接（`db.Exec`）时预算**完全无效** —— 而"语句在预算闭包里"这句
			// 话仍然是成立的，所以只判"在不在闭包里"会假绿。这正是 FIX-39 的取值域病根
			// （预算存在 ≠ 覆盖到这条语句），必须按**接收者**判。
			s.missed = true
			s.missedWhy = "这条语句在 withLockBudget 闭包内，但跑在 " + recv + " 上，而预算是施加在 " + budgetRecv +
				" 这条会话上的 ⇒ 该语句**不受预算约束**（把账本 DDL 挪回池连接 = 复现 R28 AB1-02 的无界挂死）"
		case fn == "applyOneMigration" && recv == "tx":
			s.reason = budgetReasonMigrationTx
		default:
			for _, a := range migrationDBAllowlist {
				if a.fn != fn || a.recv != recv {
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
		sites = append(sites, s)
		return true
	})

	// 扫描面下界：数量与"承重类别"都必须真的出现，否则判据可能是恒真。
	if len(sites) < 12 {
		t.Fatalf("只扫到 %d 个 DB 调用点（migrate.go 现有 15 个）—— 扫描根/取值域变窄了，判据正在退化成恒真", len(sites))
	}
	cats := map[string]int{}
	for _, s := range sites {
		cats[s.reason]++
	}
	for _, must := range []string{budgetReasonLedgerClosure, budgetReasonMigrationTx, budgetReasonAdvisory} {
		if cats[must] == 0 {
			t.Fatalf("没有任何调用点落在 %q 这一类 ⇒ 判据的分类失效（实际分类: %v）", must, cats)
		}
	}
	// 预算机制本身必须真的还在（SET + RESET 两条）。
	if cats[migrationDBAllowlist[0].why] < 2 {
		t.Fatal("withLockBudget 内的 SET/RESET 没被扫到：预算机制被搬走或改名了")
	}
	// applyOneMigration 必须先 SET LOCAL 再执行任何 tx 语句（否则"tx 即已预算"的前提不成立）。
	if !functionBodyContains(file, "applyOneMigration", "SET LOCAL lock_timeout") {
		t.Fatal("applyOneMigration 里找不到 `SET LOCAL lock_timeout` —— 迁移事务的预算前提没了，" +
			"此时本判据对 tx.* 的放行是假绿")
	}

	for _, s := range sites {
		if s.missed {
			if s.missedWhy != "" {
				t.Errorf("%s: %s", s.pos, s.missedWhy)
				continue
			}
			t.Errorf("%s: %s 这条 DB 调用点不在任何预算会话内，也没有在 migrationDBAllowlist 里登记理由 "+
				"—— 取锁语句必须有界（R28 AB1-02：账本 DDL 跑在池连接上 ⇒ 每次启动都可能无界静默挂死）", s.pos, s.key)
		}
	}
	t.Logf("扫描 %s：%d 个 DB 调用点，全部落在预算内或已登记；分类计数 %v", src, len(sites), cats)
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

// functionBodyContains 判定函数体里是否出现过某段源码文本（用于"预算前提"这类结构性事实）。
func functionBodyContains(file *ast.File, funcName, needle string) bool {
	found := false
	ast.Inspect(file, func(n ast.Node) bool {
		fd, ok := n.(*ast.FuncDecl)
		if !ok || fd.Name.Name != funcName || fd.Body == nil {
			return true
		}
		ast.Inspect(fd.Body, func(inner ast.Node) bool {
			if bl, ok := inner.(*ast.BasicLit); ok && bl.Kind == token.STRING && strings.Contains(bl.Value, needle) {
				found = true
			}
			return true
		})
		return false
	})
	return found
}
