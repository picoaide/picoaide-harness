package appdb

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"

	sqlite3 "modernc.org/sqlite/lib"
)

// TestCrossAppAttachAndReadDenied 覆盖 §10.1 第 2/3/11 项：
// ATTACH 别的库（含别的应用的库）一律拒，且**目标文件不生成**。
//
// 两层：语句白名单（纵深）+ SQLITE_LIMIT_ATTACHED=0（唯一真闸门，§15.1 第 5 条）。
func TestCrossAppAttachAndReadDenied(t *testing.T) {
	root := t.TempDir()
	victim := newTestDBIn(t, root, "victim-app")
	defineTable(t, victim, "secrets", col("v", "text"))
	mustExec(t, victim, "INSERT INTO secrets(v) VALUES (?)", "top-secret")
	victimPath := victim.Path()

	attacker := newTestDBIn(t, root, "attacker-app")
	ctx := context.Background()
	defineTable(t, attacker, "items", col("v", "text"))

	// (1) 语句闸门：ATTACH 直接拒（可操作文案，§10.1 第 2 项）。
	_, err := attacker.Exec(ctx, abi.SQLParams{SQL: "ATTACH DATABASE '" + victimPath + "' AS b"})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "statement_not_allowed")
	if e.Details["statement"] != "ATTACH" {
		t.Fatalf("details.statement 应为 ATTACH：%v", e.Details)
	}

	// (2) 绕过闸门直接打在持有连接上：引擎层也必须拒（真闸门是 LIMIT_ATTACHED=0）。
	fresh := filepath.Join(root, "attacker-target.db")
	if _, err := attacker.rw.ExecContext(ctx, "ATTACH DATABASE '"+fresh+"' AS b"); err == nil {
		t.Fatal("引擎层 ATTACH 竟然成功：LIMIT_ATTACHED 未生效")
	} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
		t.Fatalf("ATTACH 原始错误应含 %q，实际：%v", canaryAttachErrFragment, err)
	}
	if _, statErr := os.Stat(fresh); statErr == nil {
		t.Fatal("被拒的 ATTACH 不应生成目标文件")
	}

	// (3) 跨应用读：`SELECT v FROM b.secrets` 过闸门（首关键字是 SELECT），
	//     但没有 b 这个库 ⇒ 引擎报 no such table，映射为可读的 DB_DENIED。
	_, err = attacker.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM b.secrets"})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "sql_error")
	if strings.Contains(e.Message, root) {
		t.Fatalf("错误文案不得泄露宿主路径：%s", e.Message)
	}
	// victim 库未被改动，也没被挂到 attacker 上。
	if _, err := attacker.Query(ctx, abi.SQLParams{SQL: "PRAGMA database_list"}); err == nil {
		t.Fatal("PRAGMA 应被闸门拒")
	}
	var n int
	rows, err := attacker.rw.QueryContext(ctx, "PRAGMA database_list")
	if err != nil {
		t.Fatalf("database_list 失败：%v", err)
	}
	for rows.Next() {
		n++
	}
	rows.Close()
	if n != 1 {
		t.Fatalf("attacker 只应挂 main 一个库，实际 %d", n)
	}
}

// TestVacuumIntoDeniedAndTargetNotCreated 覆盖 §10.1 第 7 项（与入库探针一致：
// 被拒时目标文件不生成）。
func TestVacuumIntoDeniedAndTargetNotCreated(t *testing.T) {
	d := newTestDB(t, "vacuum-app")
	defineTable(t, d, "items", col("v", "text"))
	mustExec(t, d, "INSERT INTO items(v) VALUES (?)", "x")
	out := filepath.Join(t.TempDir(), "export.db")

	// (1) 闸门：VACUUM 永久禁用（纵深）。
	_, err := d.Exec(context.Background(), abi.SQLParams{SQL: "VACUUM INTO '" + out + "'"})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "statement_not_allowed")

	// (2) 引擎层：LIMIT_ATTACHED=0 是 VACUUM INTO 的唯一闸门（实测 §15.2）。
	if _, err := d.writeConn().ExecContext(context.Background(), "VACUUM INTO '"+out+"'"); err == nil {
		t.Fatal("引擎层 VACUUM INTO 竟然成功：LIMIT_ATTACHED 未生效")
	} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
		t.Fatalf("VACUUM INTO 原始错误应含 %q，实际：%v", canaryAttachErrFragment, err)
	}
	if _, statErr := os.Stat(out); statErr == nil {
		t.Fatal("被拒的 VACUUM INTO 不应生成目标文件")
	}
}

// TestStatementDenyMatrix 覆盖 §10.1 第 4/5/6/8/9 项（多语句 / DDL / PRAGMA / VIEW）
// 以及保留列提到即拒。
func TestStatementDenyMatrix(t *testing.T) {
	d := newTestDB(t, "deny-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()

	cases := []struct {
		name   string
		sql    string
		reason string
	}{
		{name: "多语句 INSERT+SELECT", sql: "INSERT INTO items(v) VALUES ('a'); SELECT * FROM items", reason: "multiple_statements"},
		{name: "多语句 SELECT+SELECT", sql: "SELECT 1; SELECT 2", reason: "multiple_statements"},
		{name: "CREATE TABLE", sql: "CREATE TABLE leak(x)", reason: "statement_not_allowed"},
		{name: "CREATE VIEW", sql: "CREATE VIEW v AS SELECT * FROM items", reason: "statement_not_allowed"},
		{name: "DROP TABLE", sql: "DROP TABLE items", reason: "statement_not_allowed"},
		{name: "ALTER TABLE", sql: "ALTER TABLE items ADD COLUMN x TEXT", reason: "statement_not_allowed"},
		{name: "PRAGMA writable_schema", sql: "PRAGMA writable_schema = ON", reason: "statement_not_allowed"},
		{name: "PRAGMA database_list", sql: "PRAGMA database_list", reason: "statement_not_allowed"},
		{name: "ATTACH", sql: "ATTACH ':memory:' AS b", reason: "statement_not_allowed"},
		{name: "VACUUM", sql: "VACUUM", reason: "statement_not_allowed"},
		{name: "WITH RECURSIVE", sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c", reason: "with_not_allowed"},
		{name: "EXPLAIN", sql: "EXPLAIN SELECT 1", reason: "explain_not_allowed"},
		{name: "保留列", sql: "SELECT _row_id FROM items", reason: "reserved_column"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 写原语与读原语都必须拒（闸门在两个入口之前）。
			if _, err := d.Query(ctx, abi.SQLParams{SQL: tc.sql}); err == nil {
				t.Fatalf("db.query 应拒 %q", tc.sql)
			} else {
				requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), tc.reason)
			}
			if _, err := d.Exec(ctx, abi.SQLParams{SQL: tc.sql}); err == nil {
				t.Fatalf("db.exec 应拒 %q", tc.sql)
			} else {
				requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), tc.reason)
			}
		})
	}

	// 被拒之后库仍可用（闸门在进入驱动前，不污染连接状态）。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"})
	if err != nil {
		t.Fatalf("闸门拒绝后查询仍应可用：%v", err)
	}
	if res.Rows[0][0].(int64) != 0 {
		t.Fatalf("表应为空：%+v", res.Rows)
	}
}

// TestExecQueryRoundTripAndCrossConnectionVisibility：
// 写走读写连接、读走只读连接，两个连接必须互相看得到已提交数据。
func TestExecQueryRoundTripAndCrossConnectionVisibility(t *testing.T) {
	d := newTestDB(t, "rt-app")
	defineTable(t, d, "items", col("title", "text"), col("amount", "int"), col("ratio", "real"), col("done", "bool"))
	ctx := context.Background()

	res := mustExec(t, d, "INSERT INTO items(title, amount, ratio, done) VALUES (?, ?, ?, ?)",
		"甲", 42, 1.5, true)
	if res.RowsAffected != 1 {
		t.Fatalf("RowsAffected 应为 1，实际 %d", res.RowsAffected)
	}
	q, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT title, amount, ratio, done FROM items WHERE title = ?", Args: []any{"甲"}})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(q.Rows) != 1 {
		t.Fatalf("应查到 1 行：%+v", q.Rows)
	}
	if q.Rows[0][0] != "甲" || q.Rows[0][1] != int64(42) || q.Rows[0][2] != 1.5 || q.Rows[0][3] != int64(1) {
		t.Fatalf("返回值类型/内容不符：%+v", q.Rows[0])
	}
	if strings.Join(q.Columns, ",") != "title,amount,ratio,done" {
		t.Fatalf("列名不符：%v", q.Columns)
	}
	// NULL 原样回 null。
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "乙")
	q, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT amount FROM items WHERE title = ?", Args: []any{"乙"}})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if q.Rows[0][0] != nil {
		t.Fatalf("未写列应为 null，实际 %#v", q.Rows[0][0])
	}
	// UPDATE / DELETE 行数。
	if res := mustExec(t, d, "UPDATE items SET amount = ? WHERE title = ?", 7, "乙"); res.RowsAffected != 1 {
		t.Fatalf("UPDATE RowsAffected 应为 1，实际 %d", res.RowsAffected)
	}
	if res := mustExec(t, d, "DELETE FROM items WHERE title = ?", "乙"); res.RowsAffected != 1 {
		t.Fatalf("DELETE RowsAffected 应为 1，实际 %d", res.RowsAffected)
	}
	if res := mustExec(t, d, "DELETE FROM items WHERE title = ?", "不存在"); res.RowsAffected != 0 {
		t.Fatalf("无命中 DELETE RowsAffected 应为 0，实际 %d", res.RowsAffected)
	}
}

// TestQueryRejectsUnsupportedArgs 参数类型必须可读地被拒，而不是抛驱动内部错误。
func TestQueryRejectsUnsupportedArgs(t *testing.T) {
	d := newTestDB(t, "args-app")
	defineTable(t, d, "items", col("v", "text"))
	ctx := context.Background()
	_, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT ?", Args: []any{map[string]any{"a": 1}}})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "unsupported_arg_type")

	tooMany := make([]any, limits.SQLLimitVariableNumber+1)
	_, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT 1", Args: tooMany})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "too_many_args")
}

// TestQueryTruncatesAtRowLimit 覆盖 §4.5 返回行数上限 5 000 行（超出即截断并标记）。
func TestQueryTruncatesAtRowLimit(t *testing.T) {
	d := newTestDB(t, "rows-app")
	defineTable(t, d, "nums", col("v", "int"))
	ctx := context.Background()

	// 一次性插 5 100 行：每批 100 个元组（< SQLITE_LIMIT_VARIABLE_NUMBER=128）。
	const batch = 100
	placeholders := strings.TrimSuffix(strings.Repeat("(?),", batch), ",")
	args := make([]any, batch)
	for b := 0; b < 51; b++ {
		for i := range args {
			args[i] = b*batch + i
		}
		mustExec(t, d, "INSERT INTO nums(v) VALUES "+placeholders, args...)
	}
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM nums"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(res.Rows) != limits.SQLMaxRows {
		t.Fatalf("应截断到 %d 行，实际 %d", limits.SQLMaxRows, len(res.Rows))
	}
	if !res.Truncated {
		t.Fatal("行数超限时必须置 Truncated=true（不把成功报成失败，但必须显式标记截断）")
	}
}

// TestQueryTruncatesAtByteLimit 覆盖 §4.5 返回字节上限 8 MiB。
func TestQueryTruncatesAtByteLimit(t *testing.T) {
	d := newTestDB(t, "bytes-app")
	defineTable(t, d, "big", col("v", "text"))
	ctx := context.Background()
	chunk := strings.Repeat("x", 900*1024) // 单值 < SQLITE_LIMIT_LENGTH(1 MiB)
	for i := 0; i < 10; i++ {
		mustExec(t, d, "INSERT INTO big(v) VALUES (?)", chunk)
	}
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT v FROM big"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if !res.Truncated {
		t.Fatalf("超过 8 MiB 必须截断（返回 %d 行）", len(res.Rows))
	}
	if len(res.Rows) >= 10 {
		t.Fatalf("应在 8 MiB 上限处停下，实际返回 %d 行", len(res.Rows))
	}
	var total int64
	for _, row := range res.Rows {
		total += valueBytes(row[0])
	}
	if total > limits.SQLMaxResultBytes {
		t.Fatalf("返回字节 %d 超过上限 %d", total, limits.SQLMaxResultBytes)
	}
	if st := d.Stats(); st.Bytes != total {
		t.Fatalf("Stats.Bytes 应等于实际返回字节 %d，实际 %d", total, st.Bytes)
	}
}

// TestDatabaseFullMapsToDBLimit 覆盖 §10.3 第 30 项：写满 → SQLITE_FULL → DB_LIMIT(507)。
//
// 用包内私有默认值把 max_page_count 调到 32 页（128 KiB），不必真写 100 MB。
// 变异方式：不设 max_page_count（或调回默认 25600）⇒ 本用例写不满，变红。
func TestDatabaseFullMapsToDBLimit(t *testing.T) {
	old := defaultMaxPageCount
	defaultMaxPageCount = 32
	t.Cleanup(func() { defaultMaxPageCount = old })

	d := newTestDB(t, "full-app")
	defineTable(t, d, "blobs", col("v", "text"))
	ctx := context.Background()
	chunk := strings.Repeat("x", 8192)

	var fullErr *apperr.Error
	for i := 0; i < 500; i++ {
		if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO blobs(v) VALUES (?)", Args: []any{chunk}}); err != nil {
			fullErr = requireAppErr(t, err, apperr.CodeDBLimit)
			break
		}
	}
	if fullErr == nil {
		t.Fatal("写满 128 KiB 后应触发 SQLITE_FULL → DB_LIMIT")
	}
	requireReason(t, fullErr, "database_full")
	if fullErr.Status() != 507 {
		t.Fatalf("DB_LIMIT 的 HTTP 状态应为 507，实际 %d", fullErr.Status())
	}
	if fullErr.Details["limit_bytes"] != limits.AppDBMaxBytes {
		t.Fatalf("details.limit_bytes 应为 %d，实际 %v", limits.AppDBMaxBytes, fullErr.Details["limit_bytes"])
	}
	// 写满后仍可读（读连接不受影响），且库体积确实被限制在 max_page_count*page_size。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM blobs"})
	if err != nil {
		t.Fatalf("写满后读应仍可用：%v", err)
	}
	if n := res.Rows[0][0].(int64); n < 1 {
		t.Fatalf("应已写入若干行，实际 %d", n)
	}
	fi, err := os.Stat(d.Path())
	if err != nil {
		t.Fatalf("stat 失败：%v", err)
	}
	if maxBytes := int64(defaultMaxPageCount) * limits.AppDBPageSize; fi.Size() > maxBytes {
		t.Fatalf("库体积 %d 超过 max_page_count 换算上限 %d", fi.Size(), maxBytes)
	}
}

// TestSQLStatementTimeoutOnSlowQuery 用注入的 250 ms 预算验证：
// 每条语句都套了独立的硬超时，超时映射为 DB_DENIED + reason=statement_timeout，
// 且被中断的连接进入污染状态（**绝不复用**），但恢复路径是"丢弃整组连接并重连"
// —— 一次超时的代价是一次重连，而不是"该应用直到进程重启都不可用"（FIX-10/FIX-15.4）。
//
// 变异方式（两条）：
//   - 去掉 stmtContextLocked 的 WithTimeout ⇒ 超时那条断言红；
//   - 把 recoverPoisonedLocked 改回"直接返回污染错误" ⇒ "下一次调用已恢复"红。
func TestSQLStatementTimeoutOnSlowQuery(t *testing.T) {
	old := defaultStmtBudget
	defaultStmtBudget = 250 * time.Millisecond
	t.Cleanup(func() { defaultStmtBudget = old })

	d := newTestDB(t, "slow-app")
	defineTable(t, d, "nums", col("v", "int"))
	const batch = 100
	placeholders := strings.TrimSuffix(strings.Repeat("(?),", batch), ",")
	args := make([]any, batch)
	for b := 0; b < 3; b++ {
		for i := range args {
			args[i] = i
		}
		mustExec(t, d, "INSERT INTO nums(v) VALUES "+placeholders, args...)
	}
	// 三路笛卡尔积 = 1e6 行，远超 250 ms。
	slow := "SELECT count(*) FROM nums a, nums b, nums c"
	start := time.Now()
	_, err := d.Query(context.Background(), abi.SQLParams{SQL: slow})
	elapsed := time.Since(start)
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, ReasonStatementTimeout)
	if elapsed > 3*time.Second {
		t.Fatalf("注入 250 ms 预算却跑了 %v，超时未生效", elapsed)
	}
	// 污染标记仍在（保守）：被中断的连接绝不复用 —— 恢复只能靠"换一组新连接"。
	if poisoned, _ := poisonStateForTest(d); poisoned == nil {
		t.Fatal("超时后必须置污染标记（fail-closed：不复用被中断的连接）")
	}

	// 恢复路径 1（按语句）：下一次调用直接可用，且用的是**全新的**整代连接。
	oldROs := poolReadConnsForTest(d)
	oldRW := d.writeConn()
	res, err := d.Query(context.Background(), abi.SQLParams{SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("单语句超时后下一次调用应已恢复（丢弃整组连接重连）：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("恢复后的查询应返回 1 行：%+v", res.Rows)
	}
	if sameConnSet(poolReadConnsForTest(d), oldROs) || d.writeConn() == oldRW {
		t.Fatal("恢复必须换掉被中断的整代连接（全部只读 + rw 都要换新），绝不复用")
	}
	if poisoned, _ := poisonStateForTest(d); poisoned != nil {
		t.Fatal("恢复后污染标记应已清除")
	}

	// 恢复路径 2（按会话）：Close + 重开同样必须可用（审计 P0-2 的修复要求）。
	if err := d.Close(); err != nil {
		t.Fatalf("Close 失败：%v", err)
	}
	res, err = d.Query(context.Background(), abi.SQLParams{SQL: "SELECT 1"})
	if err != nil {
		t.Fatalf("Close 之后按需重连必须可用：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("重连后的查询应返回 1 行：%+v", res.Rows)
	}
}

// TestUnboundedRecursiveCTEInterruptTiming 覆盖 §10.3 第 31 项（比较慢，-short 跳过）。
//
// 无界递归 CTE 经 db.query 会被 WITH 闸门拒（见 TestStatementDenyMatrix），所以这里
// 直接打在持有连接上，验证**驱动层的真实中断行为**——这正是 stmtContextLocked 依赖的机制：
// ctx 到期时 modernc 驱动自行 sqlite3_interrupt（§15.2 实测 3.00 s 准时中断为同族证据）。
func TestUnboundedRecursiveCTEInterruptTiming(t *testing.T) {
	if testing.Short() {
		t.Skip("§10.3 第 31 项需要真等 5 s 预算，-short 跳过")
	}
	d := newTestDB(t, "cte-app")
	cte := "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c"

	// 先确认它过不了闸门（纵深）。
	if _, err := d.Query(context.Background(), abi.SQLParams{SQL: cte}); err == nil {
		t.Fatal("WITH RECURSIVE 应被闸门拒")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "with_not_allowed")
	}

	// 再直接打引擎：预算内必须被中断。
	ctx, cancel := context.WithTimeout(context.Background(), limits.SQLStatementBudget)
	defer cancel()
	start := time.Now()
	var n int64
	// 直接打持有连接（读写连接即可：这里验的是驱动层的中断行为，与连接形态无关）。
	err := d.writeConn().QueryRowContext(ctx, cte).Scan(&n)
	elapsed := time.Since(start)
	if err == nil {
		t.Fatal("无界递归 CTE 不应成功返回")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("中断错误应是 context.DeadlineExceeded，实际：%v", err)
	}
	if elapsed < 4*time.Second || elapsed > 20*time.Second {
		t.Fatalf("中断耗时应落在 5 s 预算附近，实际 %v", elapsed)
	}
	t.Logf("无界递归 CTE 实测中断耗时：%v（预算 %v，错误 %v）", elapsed.Round(10*time.Millisecond), limits.SQLStatementBudget, err)
	// 映射路径：超时统一变成 DB_DENIED + statement_timeout。
	mapped := d.mapStmtError(ctx, err)
	me := requireAppErr(t, mapped, apperr.CodeDBDenied)
	requireReason(t, me, "statement_timeout")
}

// TestQueryStripsReservedRowIDColumn 落实 §5.2 的字面语义「应用看不到 _row_id」：
// 结果投影里剥掉该列（Columns 与每行同步剔除），**不改写 SQL**、不引入新 ABI 字段。
//
// 变异方式：让 keep 收下全部列（不做投影）⇒ 本用例变红。
func TestQueryStripsReservedRowIDColumn(t *testing.T) {
	d := newTestDB(t, "projection-app")
	defineTable(t, d, "items", col("title", "text"), col("amount", "int"))
	ctx := context.Background()
	mustExec(t, d, "INSERT INTO items(title, amount) VALUES (?, ?)", "甲", 1)
	mustExec(t, d, "INSERT INTO items(title, amount) VALUES (?, ?)", "乙", 2)

	// (1) SELECT * 不得把 _row_id 带回来。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT * FROM items"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if strings.Join(res.Columns, ",") != "title,amount" {
		t.Fatalf("SELECT * 的列应为 title,amount（不含 _row_id），实际 %v", res.Columns)
	}
	if len(res.Rows) != 2 {
		t.Fatalf("应有 2 行，实际 %d", len(res.Rows))
	}
	for i, row := range res.Rows {
		if len(row) != 2 {
			t.Fatalf("第 %d 行应只有 2 个值，实际 %d：%+v", i, len(row), row)
		}
	}
	if res.Rows[0][0] != "甲" || res.Rows[1][0] != "乙" {
		t.Fatalf("剥列后值错位：%+v", res.Rows)
	}
	// 表限定写法同样剥掉。
	res, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT i.* FROM items i"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if strings.Contains(strings.Join(res.Columns, ","), limits.ReservedRowIDColumn) {
		t.Fatalf("SELECT i.* 也不应含 _row_id：%v", res.Columns)
	}

	// (2) 显式提到 _row_id：仍被闸门拒（reason=reserved_column）。
	_, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT _row_id FROM items"})
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")

	// (3) 别名不能绕过：`SELECT _row_id AS x` 同样拒。
	_, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT _row_id AS x FROM items"})
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")
	_, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT title, _row_id AS x FROM items"})
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")
	// 引号别名/加号拼接也绕不过（文本里出现该标识符即拒）。
	_, err = d.Query(ctx, abi.SQLParams{SQL: `SELECT "_row_id" AS "x" FROM items`})
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")
	_, err = d.Query(ctx, abi.SQLParams{SQL: "SELECT _row_id + 0 AS x FROM items"})
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")

	// (4) 写路径**不经**结果投影：`INSERT INTO b SELECT * FROM a` 走 db.exec，
	//     引擎看到的是物理列（含 _row_id）。两张 db.define 出来的表物理形状相同 ⇒ 按位对齐、正常写入。
	defineTable(t, d, "items_copy", col("title", "text"), col("amount", "int"))
	if _, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items_copy SELECT * FROM items"}); err != nil {
		t.Fatalf("两表物理形状相同，INSERT INTO … SELECT * 应成功（写路径不剥列）：%v", err)
	}
	copied, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT title, amount FROM items_copy"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(copied.Rows) != 2 || copied.Rows[0][0] != "甲" || copied.Rows[0][1] != int64(1) {
		t.Fatalf("复制结果不对：%+v", copied.Rows)
	}

	// 反向证据（也是本用例的变异判据）：目标列数比 `SELECT *` 的**物理**列数少时，
	// 引擎必须报「3 values for 2 columns」。如果谁把结果投影错误地套到写路径上，
	// `SELECT *` 会只剩 2 列、这条语句反而会成功 ⇒ 本用例变红。
	defineTable(t, d, "narrow", col("a", "text"), col("b", "int"))
	_, err = d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO narrow(a, b) SELECT * FROM items"})
	if err == nil {
		t.Fatal("写路径不得被结果投影影响：3 个物理列值插入 2 列必须报错")
	}
	requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "sql_error")
}

// TestQueryProjectionMeasuresAfterStripping：行/字节计量必须按**剥离后**的结果统计，
// 否则应用看到的计量与实际拿到的结果不一致（裁决要求的第 4 条用例）。
func TestQueryProjectionMeasuresAfterStripping(t *testing.T) {
	d := newTestDB(t, "projection-meter-app")
	defineTable(t, d, "notes", col("body", "text"))
	ctx := context.Background()
	body := strings.Repeat("y", 1000)
	mustExec(t, d, "INSERT INTO notes(body) VALUES (?)", body)

	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT * FROM notes"})
	if err != nil {
		t.Fatalf("Query 失败：%v", err)
	}
	if len(res.Columns) != 1 || res.Columns[0] != "body" {
		t.Fatalf("应只剩 body 列：%v", res.Columns)
	}
	want := int64(len(body))
	if st := d.Stats(); st.Bytes != want {
		t.Fatalf("Stats.Bytes 应按剥离后统计 %d，实际 %d（多算了 _row_id）", want, st.Bytes)
	}
	if st := d.Stats(); st.Rows != 1 {
		t.Fatalf("Stats.Rows 应为 1，实际 %d", st.Rows)
	}

	// 非 `SELECT *` 形态（子查询/表达式）不受影响。
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM notes"}); err != nil {
		t.Fatalf("count(*) 应正常：%v", err)
	}
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT body FROM (SELECT * FROM notes)"}); err != nil {
		t.Fatalf("子查询写法应正常：%v", err)
	}
	// 注：「结果里只有 _row_id」的边界无法从应用侧构造（提到即拒 + db.define 至少一列），
	// 由 TestProjectReservedColumnsOnlyRowID 直接验证投影函数。
}

// TestRowIDAliasBypassIsClosedEndToEnd 是审计 P1-1 的端到端回归（真库、真驱动）：
// `rowid` / `_rowid_` / `oid` 三个 SQLite 别名在**读**（把平台主键值以 `AS x` 回给应用）
// 与**写**（指定/改写平台主键、推进 sqlite_sequence）两条路径上都必须被拒，
// 且库内平台主键与自增序列在尝试之后**一个字节都没变**。
//
// 变异方式：把三个别名从 isReservedIdentifier 的匹配集里去掉 ⇒ 本用例全部断言变红。
func TestRowIDAliasBypassIsClosedEndToEnd(t *testing.T) {
	d := newTestDB(t, "rowid-alias-app")
	ctx := context.Background()
	defineTable(t, d, "items", col("title", "text"), col("amount", "int"))
	mustExec(t, d, "INSERT INTO items(title, amount) VALUES (?, ?)", "pk-a", 1)
	mustExec(t, d, "INSERT INTO items(title, amount) VALUES (?, ?)", "pk-b", 2)

	// 宿主视角：平台主键与自增序列的基线（应用看不到 _row_id，宿主可以直接读）。
	readHostState := func() (ids []int64, seq int64) {
		t.Helper()
		rows, err := d.writeConn().QueryContext(ctx, "SELECT _row_id FROM items ORDER BY _row_id")
		if err != nil {
			t.Fatalf("宿主读 _row_id 失败：%v", err)
		}
		defer rows.Close()
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				t.Fatalf("扫描 _row_id 失败：%v", err)
			}
			ids = append(ids, id)
		}
		if err := d.writeConn().QueryRowContext(ctx, "SELECT seq FROM sqlite_sequence WHERE name = 'items'").Scan(&seq); err != nil {
			t.Fatalf("读 sqlite_sequence 失败：%v", err)
		}
		return ids, seq
	}
	beforeIDs, beforeSeq := readHostState()
	if len(beforeIDs) != 2 || beforeSeq != 2 {
		t.Fatalf("前置状态不对：ids=%v seq=%d", beforeIDs, beforeSeq)
	}

	reads := []string{
		"SELECT rowid AS x FROM items",
		"SELECT _rowid_ AS x FROM items",
		"SELECT oid AS x FROM items",
		"SELECT max(rowid) AS x FROM items",
		"SELECT count(oid) AS x FROM items",
		"SELECT * FROM items WHERE rowid > 0",
		`SELECT "rowid" AS x FROM items`,
		"SELECT [oid] FROM items",
		"SELECT `_rowid_` FROM items",
	}
	for _, sqlText := range reads {
		if res, err := d.Query(ctx, abi.SQLParams{SQL: sqlText}); err == nil {
			t.Errorf("db.query %q 应被拒，实际成功并返回 rows=%v cols=%v", sqlText, res.Rows, res.Columns)
		} else {
			requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")
		}
	}
	writes := []string{
		"INSERT INTO items(rowid, title, amount) VALUES (4242, 'pk-set', 9)",
		"INSERT INTO items(oid, title, amount) VALUES (4243, 'pk-set', 9)",
		"UPDATE items SET rowid = 7777 WHERE title = 'pk-a'",
		"UPDATE items SET _rowid_ = 7778 WHERE title = 'pk-b'",
		"DELETE FROM items WHERE rowid = 1",
	}
	for _, sqlText := range writes {
		if _, err := d.Exec(ctx, abi.SQLParams{SQL: sqlText}); err == nil {
			t.Errorf("db.exec %q 应被拒（应用不得指定/改写平台主键），实际成功", sqlText)
		} else {
			requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "reserved_column")
		}
	}

	afterIDs, afterSeq := readHostState()
	if len(afterIDs) != len(beforeIDs) {
		t.Fatalf("平台主键行数被改写：before=%v after=%v", beforeIDs, afterIDs)
	}
	for i := range beforeIDs {
		if beforeIDs[i] != afterIDs[i] {
			t.Fatalf("平台主键被改写：before=%v after=%v", beforeIDs, afterIDs)
		}
	}
	if beforeSeq != afterSeq {
		t.Fatalf("sqlite_sequence 被应用推进：before=%d after=%d", beforeSeq, afterSeq)
	}

	// 对照：`SELECT *` 只回应用列（投影层仍然按名字剥平台列）。
	res, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT * FROM items ORDER BY title"})
	if err != nil {
		t.Fatalf("SELECT * 应正常：%v", err)
	}
	if strings.Join(res.Columns, ",") != "title,amount" {
		t.Fatalf("SELECT * 的列应只有应用列，实际 %v", res.Columns)
	}
}

// TestConstraintViolationKeepsEngineMessage 覆盖审计 P2-4：
// modernc 返回的是**扩展错误码**（唯一约束冲突 = SQLITE_CONSTRAINT_PRIMARYKEY 1555），
// 老实现用 se.Code() 精确匹配 SQLITE_CONSTRAINT(19) ⇒ 约束分支是死代码，
// 应用只拿到"SQL 执行失败（SQLite 错误码 1555）"这种没有信息量的文案。
// 现在按主码（& 0xff）分支，引擎原文必须原样回给作者（AI 是错误的第一消费者）。
//
// 变异方式：把 `extended & 0xff` 改回 `extended` ⇒ 本用例的文案断言变红。
func TestConstraintViolationKeepsEngineMessage(t *testing.T) {
	d := newTestDB(t, "constraint-app")
	ctx := context.Background()
	defineTable(t, d, "items", col("title", "text"))
	mustExec(t, d, "INSERT INTO items(title) VALUES (?)", "only-row")

	// 同形状自插：`_row_id` 主键冲突（应用无法指定主键，这是它能触发约束违例的合法路径）。
	_, err := d.Exec(ctx, abi.SQLParams{SQL: "INSERT INTO items SELECT * FROM items"})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	// 判据是"按主码分支"：1555 落到 SQLITE_CONSTRAINT(19) 上，给出专属 reason。
	// 若把 extended&0xff 改回 extended，这里会落到 default（sql_error）⇒ 用例变红。
	requireReason(t, e, "constraint_violation")
	if !strings.Contains(e.Message, "UNIQUE constraint failed") {
		t.Fatalf("约束违例必须保留引擎原文（含 UNIQUE constraint failed），实际 message=%q", e.Message)
	}
	if e.Message == "SQL 执行失败" || strings.Contains(e.Message, "SQLite 错误码") {
		t.Fatalf("不该退化成无信息量的默认文案：%q", e.Message)
	}
	code, _ := e.Details["sqlite_code"].(int)
	if code != sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY {
		t.Fatalf("details.sqlite_code 应为扩展码 %d，实际 %v", sqlite3.SQLITE_CONSTRAINT_PRIMARYKEY, e.Details["sqlite_code"])
	}
	// 约束违例不是"连接被污染"：后续调用照常可用。
	if _, err := d.Query(ctx, abi.SQLParams{SQL: "SELECT count(*) FROM items"}); err != nil {
		t.Fatalf("约束违例之后连接仍应可用：%v", err)
	}
}
