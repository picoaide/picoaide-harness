package appdb

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// TestSingleStatementGate 是单语句闸门的表驱动用例（§4.5、§10.1 第 4 项）。
//
// 关键点：分号必须在**字符串字面量之外**；其后除空白/注释外还有内容即拒。
// 变异方式：把「分号之后还有内容」的判定去掉（或只取分号前的一段）⇒ 带 wantErr 的
// 多语句用例全部变红。
func TestSingleStatementGate(t *testing.T) {
	cases := []struct {
		name      string
		sql       string
		wantFirst string
		wantErr   string // apperr details.reason，空串表示应当通过
	}{
		// ---- 合法：分号只出现在字面量/注释里，或作为唯一的收尾 ----
		{name: "普通 SELECT", sql: "SELECT 1", wantFirst: "SELECT"},
		{name: "结尾分号", sql: "SELECT 1;", wantFirst: "SELECT"},
		{name: "结尾分号加空白", sql: "SELECT 1 ;  \n\t ", wantFirst: "SELECT"},
		{name: "结尾分号加行注释", sql: "SELECT 1; -- 完事", wantFirst: "SELECT"},
		{name: "结尾分号加块注释", sql: "SELECT 1; /* 完事 */", wantFirst: "SELECT"},
		{name: "字符串里的分号", sql: "SELECT 'a;b'", wantFirst: "SELECT"},
		{name: "字符串里的双分号", sql: "INSERT INTO t(v) VALUES (';;;')", wantFirst: "INSERT"},
		{name: "转义引号里的分号", sql: "SELECT 'it''s; fine'", wantFirst: "SELECT"},
		{name: "双引号标识符里的分号", sql: `SELECT "a;b" FROM t`, wantFirst: "SELECT"},
		{name: "反引号标识符里的分号", sql: "SELECT `a;b` FROM t", wantFirst: "SELECT"},
		{name: "方括号标识符里的分号", sql: "SELECT [a;b] FROM t", wantFirst: "SELECT"},
		{name: "行注释里的分号", sql: "SELECT 1 -- ; DROP TABLE t", wantFirst: "SELECT"},
		{name: "块注释里的分号", sql: "SELECT 1 /* ; DROP TABLE t */", wantFirst: "SELECT"},
		{name: "前导行注释", sql: "-- 注释\nSELECT 1", wantFirst: "SELECT"},
		{name: "前导块注释", sql: "/* 注释 */\nSELECT 1", wantFirst: "SELECT"},
		{name: "前导多个注释与空白", sql: " \n /* a */ -- b\n\t/* c */ UPDATE t SET v = 1", wantFirst: "UPDATE"},
		{name: "带参数的 DELETE", sql: "DELETE FROM t WHERE id = ?", wantFirst: "DELETE"},

		// ---- 多语句：一律拒（§10.1 第 4 项）----
		{name: "INSERT 后接 SELECT", sql: "INSERT INTO t(v) VALUES (1); SELECT * FROM t", wantErr: "multiple_statements"},
		{name: "两条 SELECT", sql: "SELECT 1; SELECT 2", wantErr: "multiple_statements"},
		{name: "两条 SELECT 之间只有注释", sql: "SELECT 1; /* x */ SELECT 2", wantErr: "multiple_statements"},
		{name: "SELECT 后接 DROP", sql: "SELECT 1; DROP TABLE t", wantErr: "multiple_statements"},
		{name: "前导分号后接语句", sql: "; SELECT 1", wantErr: "empty_statement"},

		// ---- 词法错误 ----
		{name: "字符串未闭合", sql: "SELECT 'abc", wantErr: "unterminated_string"},
		{name: "块注释未闭合", sql: "SELECT 1 /* 没关", wantErr: "unterminated_comment"},
		{name: "引号标识符未闭合", sql: `SELECT "abc`, wantErr: "unterminated_identifier"},
		{name: "方括号标识符未闭合", sql: "SELECT [abc", wantErr: "unterminated_identifier"},

		// ---- 空语句 ----
		{name: "空串", sql: "", wantErr: "empty_statement"},
		{name: "只有空白", sql: "   \n\t", wantErr: "empty_statement"},
		{name: "只有注释", sql: "-- 只有注释", wantErr: "empty_statement"},
		{name: "只有分号", sql: ";", wantErr: "empty_statement"},
		{name: "分号加注释", sql: "; -- x", wantErr: "empty_statement"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res, err := scanSQL(tc.sql)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("scanSQL(%q) 不应报错，实际：%v", tc.sql, err)
				}
				if res.first != tc.wantFirst {
					t.Fatalf("scanSQL(%q) 首关键字应为 %q，实际 %q", tc.sql, tc.wantFirst, res.first)
				}
				return
			}
			if err == nil {
				t.Fatalf("scanSQL(%q) 应被拒（reason=%s）", tc.sql, tc.wantErr)
			}
			if err.Code != apperr.CodeDBDenied {
				t.Fatalf("scanSQL(%q) 错误码应为 DB_DENIED，实际 %s", tc.sql, err.Code)
			}
			requireReason(t, err, tc.wantErr)
		})
	}
}

// TestStatementKindWhitelist 覆盖语句种类白名单与永久禁用种类（§4.5、§10.1 第 5/6/7/8/9 项）。
// 变异方式：让 classifyFirst 接受任意首关键字 ⇒ 全部 wantErr 用例变红。
func TestStatementKindWhitelist(t *testing.T) {
	cases := []struct {
		sql     string
		want    sqlKind
		wantErr string
	}{
		{sql: "SELECT * FROM items", want: kindSelect},
		{sql: "  select 1", want: kindSelect},
		{sql: "INSERT INTO items(a) VALUES (1)", want: kindInsert},
		{sql: "UPDATE items SET a = 1", want: kindUpdate},
		{sql: "DELETE FROM items", want: kindDelete},

		{sql: "CREATE TABLE leak(x)", wantErr: "statement_not_allowed"},
		{sql: "CREATE VIEW v AS SELECT 1", wantErr: "statement_not_allowed"},
		{sql: "CREATE INDEX i ON t(a)", wantErr: "statement_not_allowed"},
		{sql: "DROP TABLE items", wantErr: "statement_not_allowed"},
		{sql: "ALTER TABLE items ADD COLUMN x TEXT", wantErr: "statement_not_allowed"},
		{sql: "ATTACH DATABASE 'other.db' AS b", wantErr: "statement_not_allowed"},
		{sql: "DETACH DATABASE b", wantErr: "statement_not_allowed"},
		{sql: "VACUUM", wantErr: "statement_not_allowed"},
		{sql: "VACUUM INTO '/tmp/x'", wantErr: "statement_not_allowed"},
		{sql: "PRAGMA writable_schema = ON", wantErr: "statement_not_allowed"},
		{sql: "PRAGMA database_list", wantErr: "statement_not_allowed"},
		{sql: "REPLACE INTO items(a) VALUES (1)", wantErr: "statement_not_allowed"},
		{sql: "ANALYZE", wantErr: "statement_not_allowed"},
		{sql: "REINDEX items", wantErr: "statement_not_allowed"},
		{sql: "SAVEPOINT sp", wantErr: "statement_not_allowed"},
		{sql: "RELEASE sp", wantErr: "statement_not_allowed"},

		// 非白名单首关键字：WITH（含 WITH RECURSIVE）/ EXPLAIN / 裸 VALUES。
		{sql: "WITH x AS (SELECT 1) SELECT * FROM x", wantErr: "with_not_allowed"},
		{sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
			wantErr: "with_not_allowed"},
		{sql: "with recursive c(x) as (select 1) select 1", wantErr: "with_not_allowed"},
		{sql: "EXPLAIN SELECT 1", wantErr: "explain_not_allowed"},
		{sql: "EXPLAIN QUERY PLAN SELECT 1", wantErr: "explain_not_allowed"},
		{sql: "VALUES (1), (2)", wantErr: "statement_not_allowed"},
		{sql: "BEGIN", wantErr: "statement_not_allowed"},
		{sql: "COMMIT", wantErr: "statement_not_allowed"},
		{sql: "1 + 1", wantErr: "statement_not_allowed"},
	}

	for _, tc := range cases {
		t.Run(tc.sql, func(t *testing.T) {
			res, err := scanSQL(tc.sql)
			if err != nil {
				t.Fatalf("闸门应只判单语句，实际报错：%v", err)
			}
			kind, kerr := classifyFirst(res.first)
			if tc.wantErr == "" {
				if kerr != nil {
					t.Fatalf("classifyFirst(%q) 不应报错：%v", res.first, kerr)
				}
				if kind != tc.want {
					t.Fatalf("classifyFirst(%q) 应为 %v，实际 %v", res.first, tc.want, kind)
				}
				if !containsString(limits.AllowedStatementKinds, res.first) {
					t.Fatalf("%q 不在 limits.AllowedStatementKinds 里", res.first)
				}
				return
			}
			if kerr == nil {
				t.Fatalf("%q 应被拒（reason=%s）", tc.sql, tc.wantErr)
			}
			if kerr.Code != apperr.CodeDBDenied {
				t.Fatalf("%q 错误码应为 DB_DENIED，实际 %s", tc.sql, kerr.Code)
			}
			requireReason(t, kerr, tc.wantErr)
			// 错误文案必须可操作（§7.4：第一消费者是 AI）。
			if len(kerr.Hints) == 0 {
				t.Fatalf("%q 被拒时应给出 hints", tc.sql)
			}
			if len(limits.DeniedStatementKinds) == 0 {
				t.Fatal("limits.DeniedStatementKinds 不应为空")
			}
		})
	}
}

// TestCheckStatementEnforcesKind 覆盖「db.query 只跑 SELECT、db.exec 只跑写」。
func TestCheckStatementEnforcesKind(t *testing.T) {
	if _, err := checkStatement("INSERT INTO t(v) VALUES (1)", kindSelect); err == nil {
		t.Fatal("db.query 收到 INSERT 应被拒")
	} else {
		requireReason(t, err, "wrong_statement_kind")
	}
	if _, err := checkStatement("SELECT 1", kindInsert, kindUpdate, kindDelete); err == nil {
		t.Fatal("db.exec 收到 SELECT 应被拒")
	} else {
		requireReason(t, err, "wrong_statement_kind")
	}
	if _, err := checkStatement("SELECT 1", kindSelect); err != nil {
		t.Fatalf("SELECT 走 db.query 不应被拒：%v", err)
	}
}

// TestReservedRowIDMention 覆盖 §5.2/§10.6 第 67 项：提到保留列即拒，且必须是词边界。
// 变异方式：去掉 mentionReserved 判定 ⇒ 带 _row_id 的用例变红。
func TestReservedRowIDMention(t *testing.T) {
	cases := []struct {
		sql     string
		wantErr bool
	}{
		{sql: "SELECT _row_id FROM items", wantErr: true},
		{sql: "SELECT _ROW_ID FROM items", wantErr: true},
		{sql: "INSERT INTO items(_row_id, title) VALUES (1, 'x')", wantErr: true},
		{sql: "UPDATE items SET _row_id = 2", wantErr: true},
		{sql: "DELETE FROM items WHERE _row_id > 10", wantErr: true},
		{sql: `SELECT "_row_id" FROM items`, wantErr: true},
		{sql: "SELECT [_row_id] FROM items", wantErr: true},
		{sql: "SELECT `_row_id` FROM items", wantErr: true},
		{sql: "SELECT items._row_id FROM items", wantErr: true},
		// 词边界：不能误杀相似列名（§5.2 明确要求）。
		{sql: "SELECT my_row_id FROM items", wantErr: false},
		{sql: "SELECT _row_id_x FROM items", wantErr: false},
		{sql: "SELECT row_id FROM items", wantErr: false},
		{sql: "SELECT _row_identity FROM items", wantErr: false},
		// 字符串字面量里的文本不是「提到列」，不应误杀（参数化的值更不会进 SQL 文本）。
		{sql: "SELECT 'this is _row_id' FROM items", wantErr: false},
		{sql: "INSERT INTO items(title) VALUES ('_row_id')", wantErr: false},
	}
	for _, tc := range cases {
		t.Run(tc.sql, func(t *testing.T) {
			_, err := checkStatement(tc.sql, kindSelect, kindInsert, kindUpdate, kindDelete)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("%q 应因保留列被拒", tc.sql)
				}
				requireReason(t, err, "reserved_column")
				return
			}
			if err != nil {
				t.Fatalf("%q 不应被拒：%v", tc.sql, err)
			}
		})
	}
}

// TestReservedRowIDAliasesAreRejected 覆盖审计 P1-1（§5.2 / §10.6 第 67 项）：
// `rowid` / `_rowid_` / `oid` 是 `_row_id` 在 SQLite 里的**内建别名**，
// 它们能读到平台主键值（`SELECT rowid AS x` 会绕过按名字剥离的结果投影）、
// 也能指定/改写主键（`INSERT INTO t(rowid, …)` / `UPDATE t SET rowid = …`）。
//
// 三种引号形态（"…" / […] / `…`）与裸词一视同仁；相似名（my_rowid / rowid_x …）必须放行。
//
// 变异方式：把三个别名从 isReservedIdentifier 的匹配集里去掉 ⇒ 本用例全部拒绝断言变红。
func TestReservedRowIDAliasesAreRejected(t *testing.T) {
	// 3 个别名 × 3 种引号形态 + 裸词 + 大小写 + 限定名 + 表达式/写路径。
	blocked := []string{
		"SELECT rowid FROM items",
		"SELECT _rowid_ FROM items",
		"SELECT oid FROM items",
		`SELECT "rowid" FROM items`,
		`SELECT "_rowid_" FROM items`,
		`SELECT "oid" FROM items`,
		"SELECT [rowid] FROM items",
		"SELECT [_rowid_] FROM items",
		"SELECT [oid] FROM items",
		"SELECT `rowid` FROM items",
		"SELECT `_rowid_` FROM items",
		"SELECT `oid` FROM items",
		// 别名 + 输出别名（审计实测：老实现把平台主键值以列名 x 回给应用）。
		"SELECT rowid AS x FROM items",
		"SELECT _rowid_ AS x FROM items",
		"SELECT oid AS x FROM items",
		"SELECT ROWID FROM items",
		"SELECT RowId FROM items",
		"SELECT OID FROM items",
		"SELECT items.rowid FROM items",
		"SELECT main.items.oid FROM items",
		"SELECT max(rowid) AS x FROM items",
		"SELECT count(oid) FROM items",
		"SELECT * FROM items WHERE rowid = 1",
		"SELECT * FROM items WHERE _rowid_ > 0",
		"SELECT * FROM items ORDER BY oid",
		"INSERT INTO items(rowid, title) VALUES (4242, 'x')",
		"INSERT INTO items(_rowid_, title) VALUES (4242, 'x')",
		"INSERT INTO items(oid, title) VALUES (4242, 'x')",
		`INSERT INTO items("rowid", title) VALUES (4242, 'x')`,
		"UPDATE items SET rowid = 7777 WHERE title = 'a'",
		"UPDATE items SET oid = 7777",
		"DELETE FROM items WHERE rowid = 1",
		"DELETE FROM items WHERE _rowid_ = 1",
	}
	for _, sqlText := range blocked {
		t.Run("blocked/"+sqlText, func(t *testing.T) {
			// 读原语与写原语两个入口都必须拒（闸门在进入驱动之前）。
			_, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete)
			if err == nil {
				t.Fatalf("%q 应因保留列（或其 SQLite 别名）被拒", sqlText)
			}
			requireReason(t, err, "reserved_column")
			if err.Details["column"] != limits.ReservedRowIDColumn {
				t.Fatalf("%q 的 details.column 应为 %q，实际 %v", sqlText, limits.ReservedRowIDColumn, err.Details["column"])
			}
			if len(err.Hints) == 0 {
				t.Fatalf("%q 被拒时应给出 hints", sqlText)
			}
		})
	}

	// 词边界：这些是**不同的标识符**，不能误杀（§5.2 明确要求）。
	allowed := []string{
		"SELECT my_rowid FROM items",
		"SELECT rowid_x FROM items",
		"SELECT _rowid_x FROM items",
		"SELECT my_oid FROM items",
		"SELECT oid_x FROM items",
		"SELECT row_identity FROM items",
		"SELECT my_row_id FROM items",
		"SELECT xrowid FROM items",
		// 字符串字面量里的文本不是「提到列」。
		"SELECT 'rowid' FROM items",
		"SELECT 'oid' FROM items",
		"INSERT INTO items(title) VALUES ('rowid')",
		"SELECT * FROM items WHERE title = 'rowid' OR title = 'oid'",
		// 引号形态里的相似名同样是不同标识符。
		`SELECT "my_rowid" FROM items`,
		"SELECT [rowid_x] FROM items",
	}
	for _, sqlText := range allowed {
		t.Run("allowed/"+sqlText, func(t *testing.T) {
			if _, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete); err != nil {
				t.Fatalf("%q 不应被拒（词边界精确匹配）：%v", sqlText, err)
			}
		})
	}
}

// TestNestedWithIsRejectedAtWordLevel 覆盖审计 P1-2（§4.5）：WITH 的拒绝必须是
// **词级**判定，而不是"只看首关键字"——`SELECT count(*) FROM (WITH RECURSIVE …)`
// 的首关键字是 SELECT，老实现让它穿过闸门并真的跑满 5 s 单语句预算。
//
// 变异方式：把 checkStatement 里的 mentionWith 判定改回"只在 first == WITH 时判"
// ⇒ 下面全部嵌套用例变红。
func TestNestedWithIsRejectedAtWordLevel(t *testing.T) {
	blocked := []string{
		"WITH x AS (SELECT 1 AS v) SELECT v FROM x",
		"WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
		// 嵌套在 FROM 子查询里（审计实测能过老闸门并跑满 5 s）。
		"SELECT count(*) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT x FROM c)",
		// 嵌套的非递归 CTE（有意收紧：§4.5 只点名 WITH RECURSIVE，实现一律拒）。
		"SELECT * FROM (WITH x AS (SELECT 1 AS v) SELECT v FROM x)",
		// UNION 两侧各一个。
		"SELECT 1 FROM (WITH a AS (SELECT 1 AS v) SELECT v FROM a) UNION SELECT 2 FROM (WITH b AS (SELECT 2 AS v) SELECT v FROM b)",
		// 大小写与子查询套子查询。
		"select * from (with recursive c(x) as (select 1 union all select x+1 from c) select x from c)",
		"SELECT * FROM items WHERE title IN (SELECT v FROM (WITH z AS (SELECT 'x' AS v) SELECT v FROM z))",
	}
	for _, sqlText := range blocked {
		t.Run("blocked/"+sqlText, func(t *testing.T) {
			_, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete)
			if err == nil {
				t.Fatalf("%q 应被 WITH 闸门拒绝（词级判定）", sqlText)
			}
			requireReason(t, err, "with_not_allowed")
			if len(err.Hints) == 0 {
				t.Fatalf("%q 被拒时应给出 hints", sqlText)
			}
		})
	}

	// 不误杀：带引号的 "with" / [with] / `with` 在 SQLite 里是**标识符**，写不出 CTE；
	// 字符串字面量里的 'WITH' 同理。
	allowed := []string{
		`SELECT "with" FROM items`,
		"SELECT [with] FROM items",
		"SELECT `with` FROM items",
		"SELECT 'WITH RECURSIVE c(x) AS (SELECT 1) SELECT 1' FROM items",
		"INSERT INTO items(title) VALUES ('with')",
		"SELECT with_x FROM items",
	}
	for _, sqlText := range allowed {
		t.Run("allowed/"+sqlText, func(t *testing.T) {
			if _, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete); err != nil {
				t.Fatalf("%q 不应被拒：%v", sqlText, err)
			}
		})
	}
}

// TestEngineBuiltinDenyListCoversAuditSurface 覆盖审计 P2-1：拦截依据必须是
// **显式拒绝集 / 能力**，不能是名字前缀 —— `dbstat` 是非前缀的引擎内建虚表
// （给出本应用库的对象名与页表），`load_extension` 是非前缀函数（今天靠引擎
// "not authorized" 兜底，一旦驱动启用扩展加载就是进程内任意原生代码执行）。
//
// 这条用例同时是"新增引擎内建对象名必须进清单"的门禁：审计枚举出的 9 个可用虚表模块
// 必须全部在 engineBuiltinIdentifiers 里（或落在 sqlite_/pragma_ 前缀内）。
//
// 变异方式：从 engineBuiltinIdentifiers 里去掉 "dbstat" ⇒ blocked 段变红。
func TestEngineBuiltinDenyListCoversAuditSurface(t *testing.T) {
	// 审计用 `SELECT name FROM pragma_module_list` 枚举出的 9 个虚表模块。
	auditModules := []string{
		"dbstat", "fts5", "fts5vocab", "geopoly", "pragma_module_list",
		"pragma_table_info", "rtree", "rtree_i32", "sqlite_dbpage",
	}
	for _, m := range auditModules {
		if !isEngineBuiltinIdentifier(m) && !hasInternalPrefix(m) && !hasPragmaPrefix(m) {
			t.Fatalf("虚表模块 %q 既不在显式拒绝集里也不在前缀规则内：新增引擎内建对象名必须进 engineBuiltinIdentifiers", m)
		}
	}

	blocked := []string{
		"SELECT * FROM dbstat",
		"SELECT * FROM dbstat('main')",
		`SELECT * FROM "dbstat"`,
		"SELECT [dbstat] FROM dbstat",
		"SELECT name FROM dbstat WHERE pagetype = 'leaf'",
		"SELECT load_extension('libc.so.6')",
		"SELECT load_extension(?)",
		"SELECT writefile('/tmp/x', 'y')",
		"SELECT readfile('/etc/passwd')",
		"SELECT lsdir('/')",
		"SELECT fsdir('/')",
		"SELECT * FROM fts5('items')",
		"SELECT * FROM geopoly",
		"SELECT * FROM rtree",
		"SELECT * FROM rtree_i32",
		"SELECT * FROM sqlite_dbpage",
		"SELECT name FROM sqlite_master",
		"SELECT * FROM sqlite_schema",
		"SELECT * FROM sqlite_temp_master",
	}
	for _, sqlText := range blocked {
		t.Run("blocked/"+sqlText, func(t *testing.T) {
			_, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete)
			if err == nil {
				t.Fatalf("%q 应被显式拒绝集拦下", sqlText)
			}
			// sqlite_/pragma_ 前缀仍走各自更具体的 reason（internal_object / pragma_function），
			// 其余内建名走 engine_builtin。
			reason, _ := err.Details["reason"].(string)
			switch reason {
			case "engine_builtin", "internal_object", "pragma_function":
			default:
				t.Fatalf("%q 的 reason 应为 engine_builtin/internal_object/pragma_function，实际 %q", sqlText, reason)
			}
			if len(err.Hints) == 0 {
				t.Fatalf("%q 被拒时应给出 hints", sqlText)
			}
		})
	}

	// 相似名（不同标识符）必须放行。
	allowed := []string{
		"SELECT * FROM my_dbstat_table",
		"SELECT dbstat_x FROM items",
		"SELECT my_dbstat FROM items",
		"SELECT my_load_extension FROM items",
		"SELECT readfile_x FROM items",
		"SELECT 'dbstat' FROM items",
		"INSERT INTO items(title) VALUES ('load_extension')",
	}
	for _, sqlText := range allowed {
		t.Run("allowed/"+sqlText, func(t *testing.T) {
			if _, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete); err != nil {
				t.Fatalf("%q 不应被拒（相似名不是内建对象）：%v", sqlText, err)
			}
		})
	}
}

// TestSQLTextLengthLimit 覆盖 SQLITE_LIMIT_SQL_LENGTH 的前置检查（64 KiB）。
func TestSQLTextLengthLimit(t *testing.T) {
	big := "SELECT '" + strings.Repeat("a", limits.SQLLimitSQLLength) + "'"
	if _, err := scanSQL(big); err == nil {
		t.Fatal("超过 64 KiB 的 SQL 应被拒")
	} else {
		requireReason(t, err, "sql_too_long")
	}
}

// TestEngineInternalObjectsAreUnreachable 覆盖本实现在 §4.5 之外补的一条闸门。
//
// 实测证据（modernc.org/sqlite v1.55.0 / SQLite 3.53.3）：`sqlite_dbpage` 这个内部虚拟表
// **可写**——`UPDATE sqlite_dbpage SET data = … WHERE pgno = 1` 返回 err=nil，
// 也就是应用能直接改写库文件物理页，绕开 db.define 的表/列上限与保留列约束。
// 设计 §4.5 的禁用清单只列了 DDL/PRAGMA/ATTACH 这些语句关键字，没覆盖引擎内部虚拟表，
// 所以这里补一条：应用 SQL 中不得出现任何 `sqlite_` 前缀标识符。
func TestEngineInternalObjectsAreUnreachable(t *testing.T) {
	blocked := []string{
		"UPDATE sqlite_dbpage SET data = data WHERE pgno = 1",
		"UPDATE sqlite_dbpage SET data = zeroblob(4096) WHERE pgno = 1",
		"INSERT INTO sqlite_dbpage(pgno, data) VALUES (2, zeroblob(4096))",
		"DELETE FROM sqlite_dbpage WHERE pgno = 1",
		"SELECT count(*) FROM sqlite_dbpage",
		`SELECT * FROM "sqlite_dbpage"`,
		"SELECT * FROM [sqlite_master]",
		"SELECT name FROM sqlite_master",
		"DELETE FROM sqlite_sequence",
		"SELECT * FROM sqlite_temp_master",
		"INSERT INTO main.sqlite_master(name) VALUES ('x')",
	}
	for _, sqlText := range blocked {
		t.Run(sqlText, func(t *testing.T) {
			_, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete)
			if err == nil {
				t.Fatalf("%q 应被拒（引擎内部对象）", sqlText)
			}
			requireReason(t, err, "internal_object")
			if len(err.Hints) == 0 {
				t.Fatalf("%q 被拒时应给出 hints", sqlText)
			}
		})
	}
	// 字符串字面量里的同名文本不是「访问内部对象」，不能误杀（值应该走参数更安全，但文本也要放行）。
	for _, sqlText := range []string{
		"SELECT 'sqlite_dbpage' FROM t",
		"INSERT INTO t(note) VALUES ('sqlite_master is internal')",
		"INSERT INTO t(note) VALUES ('sqlite_x')",
		"INSERT INTO t(note) VALUES ('pragma_database_list')",
		"SELECT * FROM t WHERE note = 'sqlite_dbpage' OR note = 'sqlite_master'",
	} {
		if _, err := checkStatement(sqlText, kindSelect, kindInsert); err != nil {
			t.Fatalf("%q 不应被拒：%v", sqlText, err)
		}
	}
}

// TestPragmaTableValuedFunctionsAreUnreachable：`PRAGMA` 关键字被拒，但 PRAGMA 的
// 表值函数形态（`pragma_*`）能给出同样的信息——实测 `SELECT file FROM pragma_database_list`
// 会返回宿主侧库文件绝对路径，等价于设计 §4.5 明确要防的 `database_list` 探测。
func TestPragmaTableValuedFunctionsAreUnreachable(t *testing.T) {
	blocked := []string{
		"SELECT file FROM pragma_database_list",
		"SELECT name FROM pragma_table_list",
		"SELECT * FROM pragma_table_info('t')",
		"SELECT * FROM pragma_module_list",
		`SELECT * FROM "pragma_database_list"`,
		"SELECT max_page_count FROM pragma_max_page_count",
	}
	for _, sqlText := range blocked {
		t.Run(sqlText, func(t *testing.T) {
			_, err := checkStatement(sqlText, kindSelect, kindInsert, kindUpdate, kindDelete)
			if err == nil {
				t.Fatalf("%q 应被拒（PRAGMA 表值函数）", sqlText)
			}
			requireReason(t, err, "pragma_function")
		})
	}
	// 名字里含 pragma 但不是前缀（例如列名 my_pragma_note）不能误杀。
	if _, err := checkStatement("SELECT my_pragma_note FROM t", kindSelect); err != nil {
		t.Fatalf("my_pragma_note 不应被拒：%v", err)
	}
}
