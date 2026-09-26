package serverstore

// R27-FIX39 ①② 回归：迁移执行器的**等锁预算**与**锁窗口可观测性**。
//
// 被审形态（R27 审计 AA2-07 = ★P1、AA2-08 = P2；S1-F1/F2 各自真跑复现）：
//
//	① `ApplyMigrations` 全函数**没有任何**等锁预算（`grep lock_timeout migrate.go` 零命中，
//	   唯一的预算在 0073 的文件里）。启动那一刻只要有任一会话对目标表持冲突锁
//	   （pg_dump 的 ACCESS SHARE / 长查询 / idle in transaction），`ALTER TABLE` 就
//	   **无界静默挂住**：真 PG 实测 `timeout 60` ⇒ EXIT=124，60s 内应用侧只有一行
//	   PG 驱动转发的 NOTICE；真二进制 `cmd/server` 20.01s 零输出；连 advisory lock
//	   的等待也是 30.02s 零输出 —— 此时 HTTP 还没监听，编排器与运维都拿不到线索。
//	② 迁移的 `ACCESS EXCLUSIVE` 窗口 = **整个迁移文件**（不是那条 ALTER）：0059 在
//	   15 万行夹具上实测按住 apps 19.17s，期间该表读写全等到迁移结束，而**全仓没有
//	   任何一条用例**测量"某个迁移持锁多久 / 锁住哪些表"。
//
// 本文件的判据是**能力级**的（不是"代码里有 lock_timeout 字样"——既有判据
// `migration_0073_test.go` 的 `strings.Contains(sql,"lock_timeout")` 把 0073 的预算
// 改成 `'0'` 仍然 ok，是假绿）：
//   - 条 1：真 PG + 真阻塞源 ⇒ 必须在**有界时间**内返回错误，且错误里点名迁移号与
//     SQLSTATE（55P03），库里不落版本行；释放阻塞源后必须立刻成功。
//     —— 变异 A（预算设成 0/无限）与本条 1 直接冲突 ⇒ 必红（见报告）。
//     —— 变异 B（把预算挪到 advisory-lock 那条连接上、DDL 仍走池）同样必红：
//     这是 R27 审计**已证伪过**的错误改法（预算设在 advisory 连接上仍 60s+ 挂死）。
//   - 条 2：advisory lock 的等待同样有界（另一实例占着锁时不能无界等）。
//   - 条 4：真迁移持 AE 1.2s ⇒ 观测必须**测到**这个窗口（去掉采样器即红）。

import (
	"bytes"
	"context"
	"database/sql"
	"log"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// holdAccessShare 在**另一条会话**上对 table 取 ACCESS SHARE 并持住，
// 返回该会话的 backend pid 与释放函数（用真锁，不用桩 —— 判据必须是"真的会冲突"）。
func holdAccessShare(t *testing.T, db *sql.DB, table string) (int, func()) {
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
	if _, err := conn.ExecContext(ctx, "LOCK TABLE "+table+" IN ACCESS SHARE MODE"); err != nil {
		conn.Close()
		t.Fatalf("阻塞源 LOCK TABLE %s: %v", table, err)
	}
	var once sync.Once
	return pid, func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "ROLLBACK")
			_ = conn.Close()
		})
	}
}

// holdAdvisoryLock 在另一条会话上占住迁移互斥锁（模拟"另一个实例正在迁移"）。
func holdAdvisoryLock(t *testing.T, db *sql.DB) func() {
	t.Helper()
	ctx := context.Background()
	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatalf("取互斥锁占用连接: %v", err)
	}
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock(?)", migrationLockKey); err != nil {
		conn.Close()
		t.Fatalf("占住迁移互斥锁: %v", err)
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			_, _ = conn.ExecContext(context.Background(), "SELECT pg_advisory_unlock(?)", migrationLockKey)
			_ = conn.Close()
		})
	}
}

// mustExec 是本文件的读取便利函数（失败即 Fatal，避免每处三行样板）。
func mustExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatalf("exec %q: %v", query, err)
	}
}

// blockBefore0080 把库退回到 0080 之前：0080 是**单条** `ALTER TABLE models …`
// （"要取 ACCESS EXCLUSIVE 的语句"的最小形态），退它比退带 DML 的迁移更干净。
func blockBefore0080(t *testing.T, db *sql.DB) {
	t.Helper()
	mustExec(t, db, `ALTER TABLE models DROP COLUMN IF EXISTS catalog_missing`)
	mustExec(t, db, `DELETE FROM schema_migrations WHERE version >= 80`)
}

// TestMigrationDDLLockBudgetFailsLoudInsteadOfHanging 是 ① 的承重判据。
func TestMigrationDDLLockBudgetFailsLoudInsteadOfHanging(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	blockBefore0080(t, db)

	blockerPID, release := holdAccessShare(t, db, "models")
	defer release()

	// 预算收紧到 2s（生产缺省 5 分钟；判据要的是"有界"这件事本身）。
	t.Setenv(migrationDDLLockBudgetEnv, "2000")

	// 日志捕获：修复前的形态正是"60s 零输出"，所以"等锁前/等锁中/超时后各一条
	// 可检索日志"必须被真跑证明（log 是进程级输出，本用例不并行；包内唯一的
	// t.Parallel 在 local_day_test.go，而并行用例在顺序用例全部结束后才跑）。
	var buf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&buf)
	defer log.SetOutput(prevOut)

	var observed []migrationObservation
	start := time.Now()
	err := applyMigrations(db, func(ob migrationObservation) { observed = append(observed, ob) })
	elapsed := time.Since(start)
	logged := buf.String()
	log.SetOutput(prevOut)

	if err == nil {
		t.Fatalf("并发持锁下 ApplyMigrations 必须**响亮失败**（修复前是无界静默挂死）；实测耗时 %s", elapsed)
	}
	if elapsed > 30*time.Second {
		t.Fatalf("必须**有界**：预算 2s，实测 %s —— 无界等待正是被审形态（EXIT=124）", elapsed)
	}
	for _, want := range []string{"0080", "55P03"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误必须点名 %q（迁移号 + SQLSTATE）；实际: %v", want, err)
		}
	}
	// 失败必须干净：0080 的版本行不能落库（半应用 = schema 与账本不一致）。
	var rows int
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version >= 80`).Scan(&rows); err != nil {
		t.Fatalf("读版本行: %v", err)
	}
	if rows != 0 {
		t.Fatalf("失败后不应存在 >= 0080 的版本行，实际 %d 行（半应用）", rows)
	}

	// 日志：等锁**前**（applying）、**等锁中**（waiting for a lock，修复前完全没有）、
	// 失败**后**（点名迁移号）三类都必须可检索。
	for _, want := range []string{
		"migrate: applying migration 0080",
		"waiting for a lock",
		"migrate: migration 0080",
	} {
		if !strings.Contains(logged, want) {
			t.Fatalf("日志必须包含 %q（修复前 60s 只有一行 PG NOTICE）; 实际:\n%s", want, logged)
		}
	}

	// 观测：失败的那条迁移也必须产出一条观测，且等锁与阻塞者都要被采样到
	// （"被谁挡住"只有等待当下可取 —— 超时回滚之后 pg_blocking_pids 就空了）。
	if len(observed) != 1 {
		t.Fatalf("失败的迁移也必须产出一条观测，实际 %d 条", len(observed))
	}
	if !observed[0].Waiting {
		t.Fatalf("观测必须报告 Waiting=true（采样到等锁）: %+v", observed[0])
	}
	foundBlocker := false
	for _, b := range observed[0].Blockers {
		if strings.HasPrefix(b, strconv.Itoa(blockerPID)+":") {
			foundBlocker = true
		}
	}
	if !foundBlocker {
		t.Fatalf("阻塞者里必须出现真实持锁会话 pid=%d，实际 %v", blockerPID, observed[0].Blockers)
	}

	// 释放阻塞源后必须立刻恢复（失败 ≠ 卡死）：这条同时证明 0080 的 DDL 真的没执行过。
	release()
	start = time.Now()
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("释放阻塞源后必须成功: %v", err)
	}
	if d := time.Since(start); d > 30*time.Second {
		t.Fatalf("释放后重试不该耗时 %s", d)
	}
	// 新应用的版本行必须带上内容摘要（③ 的写入侧）。
	for _, v := range []int{80, 81, 82} {
		var got string
		if err := db.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, v).Scan(&got); err != nil {
			t.Fatalf("读 %d 的 checksum: %v", v, err)
		}
		if want := embeddedMigrationChecksum(t, v); got != want {
			t.Fatalf("版本 %d 落库的 checksum=%q，want %q", v, got, want)
		}
	}
}

// TestMigrationAdvisoryLockBudgetFailsLoudInsteadOfHanging：迁移互斥锁的等待同样有界
// （S1 实测：占住 advisory lock 后 30.02s **零输出**）。
func TestMigrationAdvisoryLockBudgetFailsLoudInsteadOfHanging(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	release := holdAdvisoryLock(t, db)
	t.Setenv(migrationAdvisoryLockBudgetEnv, "1500")

	start := time.Now()
	err := ApplyMigrations(db)
	elapsed := time.Since(start)
	release()

	if err == nil {
		t.Fatalf("互斥锁被占住时必须响亮失败（修复前无界等待）；实测 %s", elapsed)
	}
	if elapsed > 30*time.Second {
		t.Fatalf("互斥锁等待必须有界：预算 1.5s，实测 %s", elapsed)
	}
	for _, want := range []string{"advisory", "55P03"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误必须点名 %q；实际: %v", want, err)
		}
	}
	// 释放后必须立刻成功（证明失败 ≠ 卡死，也证明预算没有留在池里的会话上）。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("释放互斥锁后必须成功: %v", err)
	}
}

// TestMigrationDurationEnvRejectsNonPositive：**不许用一条 env 把预算变成"无预算"**
// （写 0 / 写错一律回落缺省）。
func TestMigrationDurationEnvRejectsNonPositive(t *testing.T) {
	def := 42 * time.Second
	for _, tc := range []struct {
		raw  string
		want time.Duration
	}{
		{"", def},
		{"0", def},
		{"-1", def},
		{"abc", def},
		{"1500", 1500 * time.Millisecond},
		{" 2500 ", 2500 * time.Millisecond},
	} {
		t.Setenv(migrationDDLLockBudgetEnv, tc.raw)
		if got := migrationDurationEnv(migrationDDLLockBudgetEnv, def); got != tc.want {
			t.Fatalf("migrationDurationEnv(%q) = %s, want %s", tc.raw, got, tc.want)
		}
	}
}

// TestMigrationObservabilityRecordsAEWindow 是 ② 的承重判据：真迁移持 AE 1.2s，
// 观测必须测到这个窗口（窗口 = 采样到的首末两次"granted AE"之间 ⇒ 单调下界）。
func TestMigrationObservabilityRecordsAEWindow(t *testing.T) {
	// 顺序是承重的：先建库（模板克隆要求 hook == nil），再注入夹具迁移集。
	db := openTestDB(t)
	defer db.Close()

	const fixtureVersion = 9901
	prevHook := testMigrationHook
	testMigrationHook = func() []migration {
		return []migration{{
			version: fixtureVersion,
			name:    "9901_r27_ae_window_probe.sql",
			sql:     "LOCK TABLE apps IN ACCESS EXCLUSIVE MODE;\nDO $$ BEGIN PERFORM pg_sleep(1.2); END $$;\n",
		}}
	}
	defer func() { testMigrationHook = prevHook }()

	t.Setenv(migrationSlowWarnEnv, "300")

	var got []migrationObservation
	if err := applyMigrations(db, func(ob migrationObservation) { got = append(got, ob) }); err != nil {
		t.Fatalf("应用夹具迁移: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("期望恰好一条观测，实际 %d", len(got))
	}
	ob := got[0]
	if ob.Version != fixtureVersion || ob.Name != "9901_r27_ae_window_probe.sql" {
		t.Fatalf("观测的迁移身份不对: %+v", ob)
	}
	if ob.Elapsed < 1200*time.Millisecond {
		t.Fatalf("墙钟必须覆盖 pg_sleep(1.2)，实际 %s", ob.Elapsed)
	}
	if ob.AEWindow < 400*time.Millisecond {
		t.Fatalf("必须**测到** ACCESS EXCLUSIVE 窗口（去掉采样器即 0）；实际 %s（观测 %+v）", ob.AEWindow, ob)
	}
	if ob.AEWindow > 5*time.Second {
		t.Fatalf("AE 窗口不可能超过迁移本身: window=%s elapsed=%s", ob.AEWindow, ob.Elapsed)
	}
	if len(ob.AETables) != 1 || ob.AETables[0] != "apps" {
		t.Fatalf("AE 必须点名被锁的表，实际 %v", ob.AETables)
	}
	if !ob.Slow {
		t.Fatalf("elapsed=%s 超过阈值 %s，必须判慢: %+v", ob.Elapsed, ob.SlowAfter, ob)
	}

	// 默认出口的两行文本必须是**可检索**的（运维按前缀 grep）。
	line := formatMigrationObservation(ob)
	for _, want := range []string{"migrate: applied migration 9901", "elapsed=", "ae_window=", "ae_tables=[apps]"} {
		if !strings.Contains(line, want) {
			t.Fatalf("观测行缺少 %q: %s", want, line)
		}
	}
	warn := formatSlowMigration(ob)
	for _, want := range []string{"migrate: SLOW migration 9901", "ACCESS EXCLUSIVE on [apps]"} {
		if !strings.Contains(warn, want) {
			t.Fatalf("慢迁移告警缺少 %q: %s", want, warn)
		}
	}
}

// TestMigrationObservationWithoutSampleReportsNotObserved：没观测到时**如实**说
// "not-observed"，不打印 0s（0s 会被读成"没有持锁"，而事实是"窗口短于采样间隔"）。
func TestMigrationObservationWithoutSampleReportsNotObserved(t *testing.T) {
	line := formatMigrationObservation(migrationObservation{Version: 7, Name: "0007_x.sql", Elapsed: 3 * time.Millisecond})
	if !strings.Contains(line, "ae_window=not-observed") {
		t.Fatalf("没观测到 AE 必须如实标注: %s", line)
	}
	if strings.Contains(line, "ae_window=0s") {
		t.Fatalf("不得把「未观测到」打成 0s: %s", line)
	}
}

// migrationLockTimeoutRE 抽出迁移文件里**真正的** `SET [LOCAL] lock_timeout = <值>`
// 语句（注释里的散文提及不带取值，因此不会命中）。
//
// 取值域必须等于 PG 的真实解析面（本仓已复发三次的教训）：数字可带小数、可带时间单位
// （us/ms/s/min/h/d），可为负 —— `0` 与负值在 PG 里都表示**关闭**该预算。
var migrationLockTimeoutRE = regexp.MustCompile(
	`(?i)lock_timeout\s*(?:=|TO)\s*'?\s*(-?[0-9]+(?:\.[0-9]+)?)\s*(us|ms|s|min|h|d)?\s*'?`)

// migrationLockTimeoutValues 返回 sqlText 里每一处 lock_timeout 取值（含单位，如 "5s"）。
func migrationLockTimeoutValues(sqlText string) []string {
	var out []string
	for _, m := range migrationLockTimeoutRE.FindAllStringSubmatch(sqlText, -1) {
		out = append(out, m[1]+m[2])
	}
	return out
}

// lockTimeoutValueIsPositive 判定取值是否为正预算（"0"/"0ms"/"-1" 都等于关掉预算）。
func lockTimeoutValueIsPositive(lit string) bool {
	num := lit
	if i := strings.IndexFunc(num, func(r rune) bool {
		return !(r >= '0' && r <= '9') && r != '.' && r != '-'
	}); i >= 0 {
		num = num[:i]
	}
	v, err := strconv.ParseFloat(num, 64)
	return err == nil && v > 0
}

// TestMigrationFileLockTimeoutsArePositiveBudgets：**取值域**判据，替代旧判据
// `strings.Contains(lower(sql), "lock_timeout")`。
//
// 为什么必须换（R27 审计 AA2-07 / S1-F1 实测）：旧判据只看"有没有出现这个词"，
// 把 `0073_drop_wasm_sessions.sql:26` 的 `SET LOCAL lock_timeout = '5s';` 改成
// `'0'`（Postgres 语义 = **关闭**预算）之后用例**仍然 ok**（S1 实测 `ok … 1.515s`）
// —— 连"有预算"这件事本身都没有被能力级判据钉住。
func TestMigrationFileLockTimeoutsArePositiveBudgets(t *testing.T) {
	// ① 解析器自检：判据的取值域必须覆盖被守护方的真实写法（含"关掉预算"的三种形态）。
	for _, tc := range []struct {
		sql  string
		want []string
	}{
		{"SET LOCAL lock_timeout = '5s';", []string{"5s"}},
		{"set local lock_timeout = 0;", []string{"0"}},
		{"SET LOCAL lock_timeout = '0ms';", []string{"0ms"}},
		{"SET LOCAL lock_timeout = '-1';", []string{"-1"}},
		{"SET lock_timeout TO '250ms';", []string{"250ms"}},
		{"SET LOCAL lock_timeout = '0.5s';", []string{"0.5s"}},
		{"-- 注释里提到 lock_timeout，但这一行没有取值", nil},
		{"SET LOCAL statement_timeout = '5s';", nil},
	} {
		got := migrationLockTimeoutValues(tc.sql)
		if len(got) != len(tc.want) {
			t.Fatalf("解析 %q = %v, want %v", tc.sql, got, tc.want)
		}
		for i := range got {
			if got[i] != tc.want[i] {
				t.Fatalf("解析 %q = %v, want %v", tc.sql, got, tc.want)
			}
		}
	}
	for _, bad := range []string{"0", "0ms", "-1", "0.0s"} {
		if lockTimeoutValueIsPositive(bad) {
			t.Fatalf("%q 在 PG 里等于关闭预算，必须判为**非正**", bad)
		}
	}
	for _, good := range []string{"1", "250ms", "5s", "1min", "0.5s"} {
		if !lockTimeoutValueIsPositive(good) {
			t.Fatalf("%q 是正预算", good)
		}
	}

	// ② 真文件：迁移目录里**每一处** lock_timeout 取值都必须是正预算。
	found := 0
	for _, m := range migrationsFor() {
		for _, v := range migrationLockTimeoutValues(m.sql) {
			found++
			if !lockTimeoutValueIsPositive(v) {
				t.Fatalf("%s 的 lock_timeout 取值 %q 不是正预算：0/负值在 PG 里等于**关闭**该预算 "+
					"⇒ 该迁移回到无界等锁（R27-FIX39 之前正是这个形态被静默接受）", m.name, v)
			}
		}
	}
	// 扫描面不得为 0：至少要有一处被判定的取值，否则这条判据退化成恒真。
	// 目前 = 0073 的 `SET LOCAL lock_timeout = '5s'`（`migration_0073_test.go` 也要求它存在）；
	// 若将来有意移除，请连同那条用例一起改，并在这里显式登记新的事实来源。
	if found == 0 {
		t.Fatalf("扫描面为 0：%d 个迁移文件里没有一处 lock_timeout 取值（判据无法咬住任何东西）", len(migrationsFor()))
	}
	t.Logf("扫描 %d 个迁移文件、%d 处 lock_timeout 取值，全部为正预算", len(migrationsFor()), found)
}
