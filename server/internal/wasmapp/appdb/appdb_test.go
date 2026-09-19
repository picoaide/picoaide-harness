package appdb

// 测试基线：全部用例都真跑（真 SQLite 文件、t.TempDir() 做 DataRoot、真驱动），不 mock。
//
// 变异验证（CONTEXT.md 交付要求第 3 条：把闸门去掉时对应用例必红）。
// 本包每条闸门的判据与变异方式（用例名一律是**真实存在**的函数名 —— 审计 P2-5 的教训：
// 老表里引用了两个不存在的名字，审阅者按表找人会找不到）：
//
//	闸门                                        | 对应用例                                         | 变异方式 ⇒ 变红
//	--------------------------------------------|--------------------------------------------------|-------------------------------
//	连接级 max_page_count / LIMIT_*（持有连接）  | TestConnectionLimitsAppliedAndCanaryHolds        | 去掉 hardenConnLocked 里的限额施加
//	应用库连接的 LIMIT_ATTACHED 期望值 0         | TestAppDBConnectionsCarryZeroAttachLimit         | 同上
//	ATTACH 金丝雀确有区分力（非空断言）          | TestAttachCanaryIsNotVacuous                     | 无（它是"未加固连接能 ATTACH"的反面证据）
//	未加固连接打不开应用库（FIX-12 L3）          | TestUnhardenedConnectionToAppDBIsRefused         | 去掉钩子里的令牌/只读判定
//	平台只读自省 DSN 仍可用（能力判定）          | TestPlatformReadOnlyIntrospectionDSNStillWorks   | 把只读例外改成按 DSN 字符串匹配
//	池里只有两条连接（FIX-12 L2）                | TestHeldConnectionsAreTheOnlyOnes                | 把 SetMaxOpenConns(2) 调大
//	单语句闸门（多语句）                         | TestSingleStatementGate                          | 只取分号前 / 不判多语句
//	语句种类白名单                               | TestStatementKindWhitelist                       | 接受任意首关键字
//	保留列 _row_id                               | TestReservedRowIDMention                         | 去掉 mentionReserved 判定
//	保留列的 SQLite 别名（FIX-9）                | TestReservedRowIDAliasesAreRejected              | 去掉 rowid/_rowid_/oid 三个别名
//	保留列别名的端到端绕过（FIX-9）              | TestRowIDAliasBypassIsClosedEndToEnd             | 同上
//	词级 WITH 闸门（FIX-11）                     | TestNestedWithIsRejectedAtWordLevel              | 改回"只看首关键字"
//	引擎内建对象显式拒绝集（FIX-13）             | TestEngineBuiltinDenyListCoversAuditSurface      | 从清单里去掉 dbstat
//	建表侧的保留名/内建名（FIX-9/FIX-13）        | TestDefineRejectsRowIDAliasAndEngineBuiltinNames | 去掉 validateDefineParams 的保留名判定
//	列上限只数应用列（FIX-14）                   | TestDefineColumnLimitCountsAppColumnsOnly        | 加列路径改回 len(existing)
//	100 MB 上限 → DB_LIMIT                       | TestDatabaseFullMapsToDBLimit                    | 不设 max_page_count（调到 100MB 级）
//	单语句 5 s 硬超时                            | TestSQLStatementTimeoutOnSlowQuery               | 去掉 stmtContextLocked 的 WithTimeout
//	单语句超时后按语句恢复（FIX-10）             | TestSQLStatementTimeoutOnSlowQuery               | recoverPoisonedLocked 改回"直接返回污染错误"
//	事务 5 s 强制回滚                            | TestTransactionHardTimeoutRollsBack              | 去掉 Begin 的看门狗
//	事务超时后的写闸 + 按会话恢复（FIX-10）      | TestTransactionTimeoutWriteGateAndRecovery       | 去掉 ensureReadyLocked 的 deadTx 判定
//	约束违例保留引擎原文（FIX-15.2）             | TestConstraintViolationKeepsEngineMessage        | `extended & 0xff` 改回 `extended`
//	表/列上限                                    | TestDefineRejectsSeventeenthTable/Column         | 去掉 MaxTablesPerApp/MaxColumnsPerTable 检查
//
// 另有两条**进程级**不变量在测试里显式钉住：连接钩子对一个"非应用库"不做任何改动
// （TestUnhardenedConnectionToAppDBIsRefused 第 3 段），以及每条语句前对即将使用的
// 连接复检限额（verifyConnLocked —— 由全部真跑用例共同覆盖）。
//
// 只依赖包内私有默认值注入（defaultMaxPageCount / defaultStmtBudget），不改 limits 常量。

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"

	"modernc.org/sqlite"
)

// newTestDB 在 t.TempDir() 上开一个应用库。
func newTestDB(t *testing.T, appID string) *DB {
	t.Helper()
	return newTestDBWithReaders(t, appID, 0)
}

// newTestDBWithReaders 用指定只读连接数开库（0 = limits.AppDBReaders 的默认值）。
func newTestDBWithReaders(t *testing.T, appID string, readers int) *DB {
	t.Helper()
	d, err := Open(context.Background(), Options{DataRoot: t.TempDir(), AppID: appID, Readers: readers})
	if err != nil {
		t.Fatalf("Open(%s, readers=%d) 失败：%v", appID, readers, err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// pooledConn 是"池里一条持有连接"的具名视图（测试遍历用）。
type pooledConn struct {
	name string
	conn *sql.Conn
}

// poolReadConnsForTest 返回当前这一代只读连接的快照（stateMu 下读）。
//
// 为什么测试也要走锁：连接代际的发布/清空发生在 connectLocked / closeLocked 里，
// 后者可能由**别的 goroutine**（看门狗、并发 Close）触发；直接读 d.ros 会被
// race detector 判为数据竞争。
func poolReadConnsForTest(d *DB) []*sql.Conn {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return append([]*sql.Conn(nil), d.ros...)
}

// poisonStateForTest 返回污染标记与事务写闸的快照（stateMu 下读）。
//
// 为什么必须走锁（实测）：事务硬超时的看门狗 goroutine（expireTx）会写这两个字段，
// 测试直接读会被 race detector 判为数据竞争 —— 这是 HEAD 基线上就存在的测试侧竞争
// （`go test -race -run TestTransactionTimeoutWriteGateAndRecovery` 在未改造的代码上
// 同样报错），本次一并修掉。
func poisonStateForTest(d *DB) (poisoned, deadTx *apperr.Error) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.poisoned, d.deadTx
}

// allPoolConns 返回池里**全部**持有连接（每条只读连接 + 读写连接），供逐条断言使用。
//
// 只读连接每一条都必须单独验：只验 ros[0] 等于给后面几条留默认 LIMIT_ATTACHED=10 的缺口。
func allPoolConns(d *DB) []pooledConn {
	ros := poolReadConnsForTest(d)
	out := make([]pooledConn, 0, len(ros)+1)
	for i, c := range ros {
		out = append(out, pooledConn{name: fmt.Sprintf("ro[%d]", i), conn: c})
	}
	out = append(out, pooledConn{name: "rw", conn: d.writeConn()})
	return out
}

// pragmaInt64 读回一条连接上的整型 PRAGMA（测试用）。
func pragmaInt64(t *testing.T, conn *sql.Conn, name string) int64 {
	t.Helper()
	var got int64
	if err := conn.QueryRowContext(context.Background(), "PRAGMA "+name).Scan(&got); err != nil {
		t.Fatalf("读回 PRAGMA %s 失败：%v", name, err)
	}
	return got
}

// sameConnSet 报告两组连接指针是否完全相同（顺序无关；用于"整代连接必须被换掉"的断言）。
func sameConnSet(a, b []*sql.Conn) bool {
	if len(a) != len(b) {
		return false
	}
	seen := make(map[*sql.Conn]int, len(a))
	for _, c := range a {
		seen[c]++
	}
	for _, c := range b {
		seen[c]--
		if seen[c] < 0 {
			return false
		}
	}
	return true
}

// isReadOnlyPoolConn 报告一条连接是否属于只读池。
func isReadOnlyPoolConn(d *DB, conn *sql.Conn) bool {
	if conn == nil {
		return false
	}
	for _, c := range poolReadConnsForTest(d) {
		if c == conn {
			return true
		}
	}
	return false
}

// readConnForTest 按生产规则选一条"本次读要用的连接"并返回归还函数：
// 事务内是读写连接（看得到未提交的写、不占槽），事务外从只读池取一条（必须归还）。
//
// 它复刻的是 withSerialConn 的选取逻辑（生产路径不单独暴露"选连接"这一步），
// 归还函数保证测试不会把槽位泄漏出去 —— 泄漏会让收尾的 Close() 在 drainReadSlots 上挂死。
func readConnForTest(t *testing.T, d *DB) (*sql.Conn, func()) {
	t.Helper()
	if d.inTx() {
		return d.writeConn(), func() {}
	}
	conn, ok := d.takeReadSlot(context.Background())
	if !ok {
		t.Fatalf("无事务时应当能从只读池取到连接（readers=%d）", d.readers)
	}
	return conn, func() { d.putReadSlot(conn) }
}

// newTestDBIn 在指定数据根上开库（用于「同一应用的第二次打开」）。
func newTestDBIn(t *testing.T, root, appID string) *DB {
	t.Helper()
	d, err := Open(context.Background(), Options{DataRoot: root, AppID: appID})
	if err != nil {
		t.Fatalf("Open(%s) 失败：%v", appID, err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d
}

// defineTable 是测试用的建表助手。
func defineTable(t *testing.T, d *DB, table string, cols ...abi.ColumnDef) abi.DBDefineResult {
	t.Helper()
	res, err := d.Define(context.Background(), abi.DBDefineParams{Table: table, Columns: cols})
	if err != nil {
		t.Fatalf("define %s 失败：%v", table, err)
	}
	return res
}

// mustExec 是测试用的写助手。
func mustExec(t *testing.T, d *DB, sqlText string, args ...any) abi.ExecResult {
	t.Helper()
	res, err := d.Exec(context.Background(), abi.SQLParams{SQL: sqlText, Args: args})
	if err != nil {
		t.Fatalf("exec %q 失败：%v", sqlText, err)
	}
	return res
}

func col(name, typ string) abi.ColumnDef { return abi.ColumnDef{Name: name, Type: typ} }

// requireAppErr 断言错误是 apperr 且码匹配。
func requireAppErr(t *testing.T, err error, code apperr.Code) *apperr.Error {
	t.Helper()
	if err == nil {
		t.Fatalf("期望错误码 %s，实际 err=nil", code)
	}
	e, ok := apperr.As(err)
	if !ok {
		t.Fatalf("期望 *apperr.Error，实际 %T：%v", err, err)
	}
	if e.Code != code {
		t.Fatalf("期望错误码 %s，实际 %s（message=%s details=%v）", code, e.Code, e.Message, e.Details)
	}
	return e
}

// requireReason 断言错误的 details.reason。
func requireReason(t *testing.T, e *apperr.Error, want string) {
	t.Helper()
	got, _ := e.Details["reason"].(string)
	if got != want {
		t.Fatalf("期望 reason=%q，实际 %q（message=%s details=%v）", want, got, e.Message, e.Details)
	}
}

// ===== Open / 路径推导 / 权限 =====

// TestOpenDerivesPathFromAppID 覆盖 §4.4/§6.3：库路径由宿主按 app_id 推导，
// 目录 0700（limits.DataDirMode）、库文件 0600。
func TestOpenDerivesPathFromAppID(t *testing.T) {
	root := t.TempDir()
	d, err := Open(context.Background(), Options{DataRoot: root, AppID: "expense-note"})
	if err != nil {
		t.Fatalf("Open 失败：%v", err)
	}
	defer d.Close()

	wantDir := filepath.Join(root, limits.AppsDirName, "expense-note")
	if d.Dir() != wantDir {
		t.Fatalf("应用目录应为 %s，实际 %s", wantDir, d.Dir())
	}
	if d.Path() != filepath.Join(wantDir, appDBFileName) {
		t.Fatalf("库文件应为 %s/app.db，实际 %s", wantDir, d.Path())
	}
	fi, err := os.Stat(wantDir)
	if err != nil {
		t.Fatalf("应用目录不存在：%v", err)
	}
	if got := fi.Mode().Perm(); got != limits.DataDirMode {
		t.Fatalf("应用目录权限应为 %#o，实际 %#o", limits.DataDirMode, got)
	}
	ffi, err := os.Stat(d.Path())
	if err != nil {
		t.Fatalf("库文件不存在：%v", err)
	}
	if got := ffi.Mode().Perm(); got != dbFileMode {
		t.Fatalf("库文件权限应为 %#o，实际 %#o", dbFileMode, got)
	}
}

// TestOpenRejectsUnsafeAppID 是路径推导的安全前提：app_id 不可信时绝不拼路径。
func TestOpenRejectsUnsafeAppID(t *testing.T) {
	root := t.TempDir()
	for _, bad := range []string{
		"", "..", "../evil", "a/../../b", "App", "a_b", "a--b", "-a", "a-",
		strings.Repeat("a", limits.MaxAppIDLen+1), "app.db",
	} {
		d, err := Open(context.Background(), Options{DataRoot: root, AppID: bad})
		if err == nil {
			d.Close()
			t.Fatalf("app_id=%q 应被拒", bad)
		}
		e := requireAppErr(t, err, apperr.CodeInvalidAppID)
		_ = e
	}
	// 数据根下不应出现 app_id 之外的目录。
	entries, err := os.ReadDir(filepath.Join(root, limits.AppsDirName))
	if err == nil && len(entries) != 0 {
		t.Fatalf("非法 app_id 不应创建目录，实际有 %d 个", len(entries))
	}
}

func TestOpenRejectsEmptyDataRoot(t *testing.T) {
	if _, err := Open(context.Background(), Options{AppID: "demo"}); err == nil {
		t.Fatal("空 DataRoot 应被拒")
	}
}

// TestOpenReopensExistingDB 覆盖「同一个应用的第二次打开」：数据在、表数正确。
func TestOpenReopensExistingDB(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()
	d1 := newTestDBIn(t, root, "demo")
	defineTable(t, d1, "items", col("title", "text"))
	mustExec(t, d1, "INSERT INTO items(title) VALUES (?)", "hello")
	if err := d1.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}

	d2 := newTestDBIn(t, root, "demo")
	res, err := d2.Query(ctx, abi.SQLParams{SQL: "SELECT title FROM items"})
	if err != nil {
		t.Fatalf("重开后查询失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "hello" {
		t.Fatalf("重开后数据不对：%+v", res.Rows)
	}
	if st := d2.Stats(); st.Tables != 1 {
		t.Fatalf("重开后表数应为 1，实际 %d", st.Tables)
	}
}

// ===== 连接级限额 / 金丝雀（§4.5、§15.1 第 4 条；§10.1 第 12/13 项）=====

// TestConnectionLimitsAppliedAndCanaryHolds 逐条读回**池里每一条**持有连接（全部只读 + rw）
// 的限额，并直接（绕过语句闸门）验证 ATTACH 被引擎拒绝。
//
// 2026-09-19 起池里有 1+N 条连接：这里改成遍历全部（只读连接**每一条**都要单独验，
// 只验第一条就等于给后面几条留了默认 LIMIT_ATTACHED=10 的缺口）。
func TestConnectionLimitsAppliedAndCanaryHolds(t *testing.T) {
	d := newTestDB(t, "limits-app")
	ctx := context.Background()

	for _, c := range allPoolConns(d) {
		var got int64
		if err := c.conn.QueryRowContext(ctx, "PRAGMA max_page_count").Scan(&got); err != nil {
			t.Fatalf("[%s] 读回 max_page_count 失败：%v", c.name, err)
		}
		if got != int64(limits.AppDBMaxPageCount) {
			t.Fatalf("[%s] max_page_count 应为 %d，实际 %d", c.name, limits.AppDBMaxPageCount, got)
		}
		t.Logf("[%s] PRAGMA max_page_count 读回 = %d", c.name, got)
		for _, lim := range connectionLimits() {
			got, err := sqliteLimitCurrent(c.conn, lim.id)
			if err != nil {
				t.Fatalf("[%s] 读回 LIMIT_%s 失败：%v", c.name, lim.name, err)
			}
			if got != lim.value {
				t.Fatalf("[%s] SQLITE_LIMIT_%s 应为 %d，实际 %d", c.name, lim.name, lim.value, got)
			}
			t.Logf("[%s] SQLITE_LIMIT_%-20s 读回 = %d", c.name, lim.name, got)
		}
		// busy_timeout 也必须逐条在场（连接级不持久；WAL 下它是"正常争用不退化成
		// database_busy"的前提）。
		if bt := pragmaInt64(t, c.conn, "busy_timeout"); bt != limits.AppDBBusyTimeout.Milliseconds() {
			t.Fatalf("[%s] busy_timeout 应为 %d ms，实际 %d", c.name, limits.AppDBBusyTimeout.Milliseconds(), bt)
		}
		// 直接绕过闸门做 ATTACH：引擎层必须拒（原始错误串见 §15.2 实测）。
		if _, err := c.conn.ExecContext(ctx, "ATTACH ':memory:' AS direct_canary"); err == nil {
			t.Fatalf("[%s] 直接 ATTACH 竟然成功：LIMIT_ATTACHED 未生效", c.name)
		} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
			t.Fatalf("[%s] ATTACH 错误串不含 %q：%v", c.name, canaryAttachErrFragment, err)
		} else {
			t.Logf("[%s] ATTACH ':memory:' 被拒，原始错误串 = %q", c.name, err.Error())
		}
	}
	// 只读连接上的写必须被拒（query_only）。
	ro := poolReadConnsForTest(d)[0]
	if _, err := ro.ExecContext(ctx, "INSERT INTO sqlite_master VALUES (1)"); err == nil {
		t.Fatal("只读连接上写竟然成功")
	}
	// 只读连接只挂了 main 一个库（§10.1 第 12 项）。
	rows, err := ro.QueryContext(ctx, "PRAGMA database_list")
	if err != nil {
		t.Fatalf("database_list 失败：%v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		n++
	}
	if n != 1 {
		t.Fatalf("只读连接应只挂 main（1 行），实际 %d 行", n)
	}
}

// TestAttachCanaryIsNotVacuous 是金丝雀的「反面证据」：一条**没有**连接级限额的连接上
// ATTACH 会成功，所以"应用库连接上 ATTACH 被拒"这条断言有真实区分力（不是空断言）。
//
// 为什么刻意用一个**不是应用库**的文件：应用库上的未加固连接现在根本创建不出来
// （FIX-12 的连接守卫，见 TestUnhardenedConnectionToAppDBIsRefused），
// 所以"未加固连接的默认行为"只能在守卫范围之外演示（连接钩子对非应用路径不干预）。
//
// 变异方式：去掉 hardenConnLocked 里的限额施加 ⇒ 应用库两条连接也会退化成这里的样子，
// TestAppDBConnectionsCarryZeroAttachLimit / TestConnectionLimitsAppliedAndCanaryHolds 变红。
func TestAttachCanaryIsNotVacuous(t *testing.T) {
	raw, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "plain.db"))
	if err != nil {
		t.Fatalf("sql.Open 失败：%v", err)
	}
	defer raw.Close()
	conn, err := raw.Conn(context.Background())
	if err != nil {
		t.Fatalf("Conn 失败：%v", err)
	}
	defer conn.Close()
	ctx := context.Background()

	// 这条连接没有经过 hardenConnLocked：LIMIT_ATTACHED 必须是**驱动默认值**
	// （这里只断言"不等于设计值"，不把某个具体默认值钉成预期 —— 默认值随驱动版本变）。
	attached, err := sqliteLimitCurrent(conn, limitsAttachedID())
	if err != nil {
		t.Fatalf("读回 LIMIT_ATTACHED 失败：%v", err)
	}
	if attached == limits.SQLLimitAttached {
		t.Fatalf("非应用库连接不该带 LIMIT_ATTACHED=%d（否则本用例失去区分力）", limits.SQLLimitAttached)
	}
	// 默认限额下 ATTACH 成功 —— 这正是"漏设限额即静默失去 ATTACH 否决"的现场。
	if _, err := conn.ExecContext(ctx, "ATTACH ':memory:' AS x"); err != nil {
		t.Fatalf("默认限额下应当能 ATTACH（说明 ATTACH 金丝雀确有区分力），实际：%v", err)
	}
}

// TestAppDBConnectionsCarryZeroAttachLimit 把"应用库连接上的 LIMIT_ATTACHED"钉成
// **期望值 0**（审计 P1-3 的缺口侧断言已按 FIX-12 的要求改成期望值，不再把缺口写成预期），
// 并同时验证真实能力：ATTACH 必须被引擎拒绝，且错误必须是「挂载数超限」。
func TestAppDBConnectionsCarryZeroAttachLimit(t *testing.T) {
	d := newTestDB(t, "zero-attach-app")
	ctx := context.Background()

	for _, c := range allPoolConns(d) {
		got, err := sqliteLimitCurrent(c.conn, limitsAttachedID())
		if err != nil {
			t.Fatalf("[%s] 读回 LIMIT_ATTACHED 失败：%v", c.name, err)
		}
		if got != limits.SQLLimitAttached {
			t.Fatalf("[%s] LIMIT_ATTACHED 应为设计值 %d，实际 %d", c.name, limits.SQLLimitAttached, got)
		}
		if _, err := c.conn.ExecContext(ctx, "ATTACH ':memory:' AS direct_canary"); err == nil {
			t.Fatalf("[%s] 直接 ATTACH 竟然成功：LIMIT_ATTACHED 未生效", c.name)
		} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
			t.Fatalf("[%s] ATTACH 错误串不含 %q：%v", c.name, canaryAttachErrFragment, err)
		}
	}
}

// TestUnhardenedConnectionToAppDBIsRefused 是 FIX-12 的 L3 回归判据：
// 任何**没有**一次性连接令牌、也不是引擎层只读的连接，都不允许打开应用库。
//
// 关闭这条路径的原因（审计 P1-3）：驱动连接钩子只拿得到 ExecQuerierContext，
// 设不了 SQLITE_LIMIT_\*，所以"未加固的新连接"必然带着默认 ATTACHED=10 跑 ——
// 而这种连接在应用库上现在**根本创建不出来**（fail-closed）。
//
// 变异方式：去掉钩子里的守卫分支（未带令牌一律放行）⇒ 第 1/2 段断言变红。
func TestUnhardenedConnectionToAppDBIsRefused(t *testing.T) {
	d := newTestDB(t, "guard-app")
	ctx := context.Background()

	// (1) 裸路径（读写意图）：连接创建必须失败。
	raw, err := sql.Open("sqlite", d.Path())
	if err != nil {
		t.Fatalf("sql.Open 失败：%v", err)
	}
	defer raw.Close()
	if conn, cerr := raw.Conn(ctx); cerr == nil {
		_ = conn.Close()
		t.Fatal("未加固的连接不该能打开应用库（LIMIT_ATTACHED 会回到驱动默认值）")
	} else if !strings.Contains(cerr.Error(), "appdb") {
		t.Fatalf("拒绝原因应来自 appdb 的连接守卫，实际：%v", cerr)
	}

	// (2) 一次性令牌在 connectLocked 返回后立刻回收：同一条带令牌的 DSN 不能再用。
	token, err := newConnToken()
	if err != nil {
		t.Fatalf("newConnToken 失败：%v", err)
	}
	allowConnToken(token)
	marked, err := sql.Open("sqlite", appDBDSN(d.Path(), token))
	if err != nil {
		t.Fatalf("sql.Open(marked) 失败：%v", err)
	}
	defer marked.Close()
	held, err := marked.Conn(ctx) // 令牌有效 ⇒ 放行（钩子兜底设 max_page_count）
	if err != nil {
		t.Fatalf("持有有效令牌的连接应被放行：%v", err)
	}
	revokeConnToken(token)
	if extra, cerr := marked.Conn(ctx); cerr == nil {
		_ = extra.Close()
		t.Fatal("令牌回收后不该还能新建连接（否则新连接没有 SQLITE_LIMIT_*）")
	}
	_ = held.Close()

	// (3) 不是应用库的文件不受守卫波及（钩子只认受保护目录）。
	other, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "other.db"))
	if err != nil {
		t.Fatalf("sql.Open(other) 失败：%v", err)
	}
	defer other.Close()
	oc, err := other.Conn(ctx)
	if err != nil {
		t.Fatalf("非应用库不该被守卫波及：%v", err)
	}
	defer oc.Close()
	var pages int64
	if err := oc.QueryRowContext(ctx, "PRAGMA max_page_count").Scan(&pages); err != nil {
		t.Fatalf("读回非应用库 max_page_count 失败：%v", err)
	}
	if pages == int64(limits.AppDBMaxPageCount) {
		t.Fatalf("appdb 不该修改非应用库的 max_page_count（实际 %d）", pages)
	}
}

// TestPlatformReadOnlyIntrospectionDSNStillWorks 钉住守卫的**只读例外**：
// 平台自省路径（internal/wasmapp/api/read.go 的 `file:…?mode=ro&_pragma=query_only(1)`）
// 必须仍能打开应用库读结构；但它在能力上写不进去（引擎层 query_only）——
// 这是"按能力拦"而不是"按调用者拦"。
func TestPlatformReadOnlyIntrospectionDSNStillWorks(t *testing.T) {
	root := t.TempDir()
	d := newTestDBIn(t, root, "ro-introspect")
	defineTable(t, d, "items", col("title", "text"))
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "x")

	ro, err := sql.Open("sqlite", "file:"+d.Path()+"?mode=ro&_pragma=query_only(1)")
	if err != nil {
		t.Fatalf("sql.Open(ro) 失败：%v", err)
	}
	defer ro.Close()
	ctx := context.Background()
	conn, err := ro.Conn(ctx)
	if err != nil {
		t.Fatalf("平台只读自省连接必须被放行（api/read.go 依赖它）：%v", err)
	}
	defer conn.Close()

	var n int
	if err := conn.QueryRowContext(ctx, "SELECT count(*) FROM items").Scan(&n); err != nil {
		t.Fatalf("只读自省连接应能读表：%v", err)
	}
	if n != 1 {
		t.Fatalf("应读到 1 行，实际 %d", n)
	}
	// 钩子对"允许创建的连接"仍兜底 max_page_count（体积上限是硬边界）。
	var pages int64
	if err := conn.QueryRowContext(ctx, "PRAGMA max_page_count").Scan(&pages); err != nil {
		t.Fatalf("读回 max_page_count 失败：%v", err)
	}
	if pages != int64(limits.AppDBMaxPageCount) {
		t.Fatalf("连接钩子应把 max_page_count 兜底为 %d，实际 %d", limits.AppDBMaxPageCount, pages)
	}
	// 能力边界：引擎层只读 ⇒ 写与 VACUUM INTO 都被拒（实测 SQLITE_READONLY）。
	if _, err := conn.ExecContext(ctx, "INSERT INTO items(title) VALUES ('y')"); err == nil {
		t.Fatal("只读自省连接不该能写")
	}
	if _, err := conn.ExecContext(ctx, "VACUUM INTO '"+filepath.Join(t.TempDir(), "v.db")+"'"); err == nil {
		t.Fatal("只读自省连接不该能 VACUUM INTO")
	}
	// 注：该连接上的 ATTACH 仍会成功（实测会创建目标文件，但对挂上的库写入同样只读）
	// —— 这是平台自省路径的既有权能，应用侧不可达；见 appdb.go 的残留风险清单。

	// (2) 同样的只读标记不能靠"字符串伪装"绕过：mode=ro 但 query_only 未开时，
	// 钩子读回的 query_only=0 ⇒ 仍然拒绝（能力判定，不是 DSN 关键字判定）。
	if raw, err := sql.Open("sqlite", "file:"+d.Path()+"?mode=ro"); err == nil {
		defer raw.Close()
		if c, cerr := raw.Conn(ctx); cerr == nil {
			_ = c.Close()
			t.Fatal("只声明 mode=ro 但没有 query_only 的连接不该被放行（判据是能力，不是 DSN 关键字）")
		}
	}
}

// TestOpenFailsClosedWhenPageLimitCannotBeApplied 钉住 max_page_count 读回金丝雀的
// fail-closed 语义：SQLite 不允许把上限设到低于当前页数，此时读回值会大于期望值
// ⇒ Open 必须直接失败，绝不带着「实际上限比配置大」的库继续服务。
func TestOpenFailsClosedWhenPageLimitCannotBeApplied(t *testing.T) {
	root := t.TempDir()
	ctx := context.Background()

	// 先用正常限额建库并写到 64 页以上（约 256 KiB）。
	d := newTestDBIn(t, root, "oversize-app")
	defineTable(t, d, "blobs", col("v", "text"))
	chunk := strings.Repeat("x", 16*1024)
	for i := 0; i < 20; i++ {
		mustExec(t, d, "INSERT INTO blobs(v) VALUES (?)", chunk)
	}
	var pages int64
	if err := d.writeConn().QueryRowContext(ctx, "PRAGMA page_count").Scan(&pages); err != nil {
		t.Fatalf("读页数失败：%v", err)
	}
	if pages <= 8 {
		t.Fatalf("测试前提：库应超过 8 页，实际 %d 页", pages)
	}
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}

	// 把上限注入为 8 页（< 现有页数）⇒ 读回值必然 > 8 ⇒ fail-closed。
	old := defaultMaxPageCount
	defaultMaxPageCount = 8
	t.Cleanup(func() { defaultMaxPageCount = old })
	_, err := Open(ctx, Options{DataRoot: root, AppID: "oversize-app"})
	if err == nil {
		t.Fatal("max_page_count 无法生效时 Open 必须失败（fail-closed）")
	}
	if !strings.Contains(err.Error(), "max_page_count") {
		t.Fatalf("错误应点明 max_page_count 不一致：%v", err)
	}
}

// TestHeldConnectionsAreTheOnlyOnes 钉住「池里只有这一代持有的 1+N 条连接」：
// 跑完一轮能力调用后池子里的连接数恒为 1+readers，且第 2+N 条连接**拿不到**（fail-closed）。
//
// 这是 FIX-12 的 L2：即使有人日后写了 `d.sqlDB.QueryContext(...)`（绕过
// hardenConnLocked 的路径），它也只会阻塞到 ctx 超时——而不是静默拿到一条
// 没有 SQLITE_LIMIT_* 的连接。变异方式：把 SetMaxOpenConns(1+readers) 调大 ⇒ 本用例变红。
//
// 2026-09-19 改写：池容量从 2 变成 1+readers（WAL 下多读者并发），但"池外新连接
// 拿不到"这条语义**原样保留**（它才是本用例真正的判据）。
func TestHeldConnectionsAreTheOnlyOnes(t *testing.T) {
	d := newTestDB(t, "pool-app")
	defineTable(t, d, "items", col("title", "text"))
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "x")
	if _, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT title FROM items"}); err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	tx, err := d.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	if err := d.Commit(context.Background(), abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("Commit 失败：%v", err)
	}
	want := 1 + d.readers
	if got := d.sqlDB.Stats().OpenConnections; got != want {
		t.Fatalf("池内连接数应为 %d（1 写 + %d 读），实际 %d", want, d.readers, got)
	}
	// 第 2+N 条连接：池容量 1+readers 且全部被持有 ⇒ 只能等到 ctx 超时。
	cctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if extra, cerr := d.sqlDB.Conn(cctx); cerr == nil {
		_ = extra.Close()
		t.Fatal("池里不该能出现第 2+N 条连接（未加固的连接会失去 LIMIT_ATTACHED 否决）")
	}
	// 而且失败不会破坏持有连接：后续语句照常可用。
	if _, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT title FROM items"}); err != nil {
		t.Fatalf("第 2+N 条连接失败后持有连接仍应可用：%v", err)
	}
}

// ===== Close / Stats =====

func TestCloseIsIdempotentAndReopensOnDemand(t *testing.T) {
	d := newTestDB(t, "close-app")
	defineTable(t, d, "items", col("title", "text"))
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "keep")

	if err := d.Close(); err != nil {
		t.Fatalf("第一次 Close 失败：%v", err)
	}
	if err := d.Close(); err != nil {
		t.Fatalf("第二次 Close 应幂等，实际：%v", err)
	}
	// Close 之后按需重连：重连同样走加固 + 金丝雀，数据不丢。
	res, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT title FROM items"})
	if err != nil {
		t.Fatalf("Close 后按需重连查询失败：%v", err)
	}
	if len(res.Rows) != 1 || res.Rows[0][0] != "keep" {
		t.Fatalf("重连后数据不对：%+v", res.Rows)
	}
	if got := len(poolReadConnsForTest(d)); got != d.readers || d.writeConn() == nil {
		t.Fatalf("重连后应重新持有 1+%d 条连接（实际只读 %d 条）", d.readers, got)
	}
}

func TestStatsCountsRowsBytesTablesAndSize(t *testing.T) {
	d := newTestDB(t, "stats-app")
	if st := d.Stats(); st.Tables != 0 || st.Rows != 0 || st.Bytes != 0 {
		t.Fatalf("空库计量应为 0：%+v", st)
	}
	defineTable(t, d, "items", col("title", "text"))
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "hello")

	res, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT title FROM items"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("应有 1 行：%+v", res.Rows)
	}
	st := d.Stats()
	if st.Rows != 1 {
		t.Fatalf("Stats.Rows 应为 1，实际 %d", st.Rows)
	}
	if st.Bytes != int64(len("hello")) {
		t.Fatalf("Stats.Bytes 应为 %d，实际 %d", len("hello"), st.Bytes)
	}
	if st.Tables != 1 {
		t.Fatalf("Stats.Tables 应为 1，实际 %d", st.Tables)
	}
	if st.SizeBytes <= 0 {
		t.Fatalf("Stats.SizeBytes 应大于 0，实际 %d", st.SizeBytes)
	}
	if st.SizeBytes > limits.AppDBMaxBytes {
		t.Fatalf("库体积 %d 不应超过上限 %d", st.SizeBytes, limits.AppDBMaxBytes)
	}
	// 计量跨多次调用累计（§4.9 db_rows/db_bytes）。
	if _, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT title FROM items"}); err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if st := d.Stats(); st.Rows != 2 {
		t.Fatalf("累计行数应为 2，实际 %d", st.Rows)
	}
	// 闭库后 Stats 仍可读（诊断不能在关闭后失败）。
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	if st := d.Stats(); st.Rows != 2 || st.SizeBytes <= 0 {
		t.Fatalf("闭库后 Stats 应仍返回累计值与体积：%+v", st)
	}
}

// BenchmarkOpenClose 量化「每请求 Open + Close」的代价（加固 + 金丝雀 + chmod 的固定开销）。
// 背景：capapi.DB.Close 的注释写「每请求结束后由运行时调用」，而 §4.5 的口径是
// 一应用一（驱动/库）实例。本实现两者都支持（Close 后可懒重连），但代价差在这里。
func BenchmarkOpenClose(b *testing.B) {
	root := b.TempDir()
	ctx := context.Background()
	for i := 0; i < b.N; i++ {
		d, err := Open(ctx, Options{DataRoot: root, AppID: "bench-app"})
		if err != nil {
			b.Fatalf("Open 失败：%v", err)
		}
		if err := d.Close(); err != nil {
			b.Fatalf("Close 失败：%v", err)
		}
	}
}

// TestPerStatementVerifyFailsClosedWhenLimitsAreLost 覆盖 FIX-12 的 L4：
// 每条语句执行前都会复检"即将使用的那条连接"仍带全套限额；一旦不成立就报错，
// **绝不**带着默认限额继续跑。这里用测试直接改回连接的 LIMIT_ATTACHED 来模拟
// "限额丢失"（真实世界里只可能来自新连接或有人把限额改了回去）。
//
// 变异方式：去掉 runVerified 里的 verifyConnLocked 调用 ⇒ 本用例变红。
//
// 2026-09-19 改写：读路径现在有 N 条只读连接 ⇒ 注入必须打在**每一条**上，
// 否则单次 Query 可能正好取到没被改坏的那条而让用例假绿（这本身也是"每条连接
// 都要复检"的反向证明）。
func TestPerStatementVerifyFailsClosedWhenLimitsAreLost(t *testing.T) {
	d := newTestDB(t, "verify-l4-app")
	defineTable(t, d, "items", col("title", "text"))
	ctx := context.Background()
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"}); err != nil {
		t.Fatalf("前置查询应成功：%v", err)
	}
	if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items(title) VALUES ('x')"}); err != nil {
		t.Fatalf("前置写入应成功：%v", err)
	}

	// (1) 写路径：把读写连接的 ATTACH 否决改回默认 10 ⇒ 下一次写必须 fail-closed。
	if _, err := sqlite.Limit(d.writeConn(), limitsAttachedID(), 10); err != nil {
		t.Fatalf("测试注入 LIMIT_ATTACHED 失败：%v", err)
	}
	if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items(title) VALUES ('y')"}); err == nil {
		t.Fatal("写路径必须复检 LIMIT_ATTACHED：限额丢失时不得继续执行")
	} else if !strings.Contains(err.Error(), "LIMIT_ATTACHED") {
		t.Fatalf("错误应点明 LIMIT_ATTACHED 读回不一致，实际：%v", err)
	}
	// (2) 读路径：只读连接同理 —— 逐条打坏后，每一路读都必须报错。
	for i, conn := range poolReadConnsForTest(d) {
		if _, err := sqlite.Limit(conn, limitsAttachedID(), 10); err != nil {
			t.Fatalf("测试注入 LIMIT_ATTACHED（ros[%d]）失败：%v", i, err)
		}
	}
	for i := 0; i < d.readers+1; i++ {
		if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"}); err == nil {
			t.Fatalf("读路径必须复检 LIMIT_ATTACHED：限额丢失时不得继续执行（第 %d 次）", i+1)
		}
	}
	// (3) 复检失败不污染对象：限额恢复后立即恢复可用（fail-closed 但可自愈）。
	if _, err := sqlite.Limit(d.writeConn(), limitsAttachedID(), limits.SQLLimitAttached); err != nil {
		t.Fatalf("恢复 rw 限额失败：%v", err)
	}
	for i, conn := range poolReadConnsForTest(d) {
		if _, err := sqlite.Limit(conn, limitsAttachedID(), limits.SQLLimitAttached); err != nil {
			t.Fatalf("恢复 ros[%d] 限额失败：%v", i, err)
		}
	}
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("限额恢复后应立即可用：%v", err)
	}
	if n := res.Rows[0][0].(int64); n != 1 {
		t.Fatalf("应读到 1 行，实际 %d", n)
	}
}

// BenchmarkQuerySelectOne 量化"每条语句前的 L4 复检"的固定开销（FIX-12 的代价）。
// 复检 = 读回 max_page_count + LIMIT_ATTACHED（+ 只读连接的 query_only），
// 都是进程内 PRAGMA/limit 读回；把 runVerified 里的 verifyConnLocked 去掉后
// 重跑本 benchmark 即可得到差值（交付说明里给了实测数字）。
func BenchmarkQuerySelectOne(b *testing.B) {
	d, err := Open(context.Background(), Options{DataRoot: b.TempDir(), AppID: "bench-query"})
	if err != nil {
		b.Fatalf("Open 失败：%v", err)
	}
	b.Cleanup(func() { _ = d.Close() })
	ctx := context.Background()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
			b.Fatalf("Query 失败：%v", err)
		}
	}
}

// BenchmarkQuerySelectParallel 量化"多读者并发"的吞吐：与 BenchmarkQuerySelectOne
// 压同一条语句，但用 b.RunParallel 同时打 N 个读（N 默认 GOMAXPROCS）。
//
// 读法：单条语句的固定成本（L4 复检等）不变，吞吐应随只读连接数上升直到 CPU 饱和 ——
// 与改造前（读被对象级互斥量串行化）相比，"每 op 纳秒"在并发下不再随并发度线性放大。
func BenchmarkQuerySelectParallel(b *testing.B) {
	d, err := Open(context.Background(), Options{DataRoot: b.TempDir(), AppID: "bench-query-parallel"})
	if err != nil {
		b.Fatalf("Open 失败：%v", err)
	}
	b.Cleanup(func() { _ = d.Close() })
	ctx := context.Background()
	b.ResetTimer()
	b.RunParallel(func(pb *testing.PB) {
		for pb.Next() {
			if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
				b.Errorf("Query 失败：%v", err)
				return
			}
		}
	})
}

// TestDSNDatabaseFileParsing 钉住连接守卫的路径解析：守卫按"这条连接指向哪个文件"
// 判断是否受保护，解析错一个形态就等于守卫失效（或误伤别的库）。
func TestDSNDatabaseFileParsing(t *testing.T) {
	abs := filepath.Join(string(filepath.Separator), "srv", "data", "apps", "demo", "app.db")
	cases := []struct {
		name string
		dsn  string
		want string // 空串表示"不是文件库"
	}{
		{"裸路径", abs, abs},
		{"裸路径带未知参数", abs + "?_picoaide_appdb=deadbeef", abs},
		{"file: 绝对路径", "file:" + abs, abs},
		{"file:/// 三斜杠", "file://" + abs, abs},
		{"file://localhost", "file://localhost" + abs, abs},
		{"file: 带参数", "file:" + abs + "?mode=ro&_pragma=query_only(1)", abs},
		{"相对路径", "rel/app.db", filepath.Join(mustAbs(t, "."), "rel", "app.db")},
		{"内存库", ":memory:", ""},
		{"file::memory:", "file::memory:", ""},
		{"空串", "", ""},
		{"别的 host 的 file URI", "file://otherhost" + abs, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := dsnDatabaseFile(tc.dsn)
			if tc.want == "" {
				if ok {
					t.Fatalf("dsnDatabaseFile(%q) 应判为「非文件库」，实际 %q", tc.dsn, got)
				}
				return
			}
			if !ok {
				t.Fatalf("dsnDatabaseFile(%q) 应解析出路径", tc.dsn)
			}
			if got != tc.want {
				t.Fatalf("dsnDatabaseFile(%q) = %q，期望 %q", tc.dsn, got, tc.want)
			}
		})
	}
}

func mustAbs(t *testing.T, p string) string {
	t.Helper()
	abs, err := filepath.Abs(p)
	if err != nil {
		t.Fatalf("Abs(%q) 失败：%v", p, err)
	}
	return abs
}
