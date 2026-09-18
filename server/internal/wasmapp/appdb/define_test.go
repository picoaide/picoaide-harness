package appdb

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// tableInfoRow 是 PRAGMA table_info 的一行（宿主内部使用）。
type tableInfoRow struct {
	cid       int
	name      string
	declType  string
	notNull   int
	dfltValue any
	pk        int
}

// readTableInfo 用宿主内部 PRAGMA 读表结构（应用提交的 PRAGMA 一律拒，但宿主自己要用）。
func readTableInfo(t *testing.T, d *DB, table string) []tableInfoRow {
	t.Helper()
	rows, err := d.rw.QueryContext(context.Background(), `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`, table)
	if err != nil {
		t.Fatalf("读 table_info(%s) 失败：%v", table, err)
	}
	defer rows.Close()
	var out []tableInfoRow
	for rows.Next() {
		var r tableInfoRow
		var dflt any
		if err := rows.Scan(&r.cid, &r.name, &r.declType, &r.notNull, &dflt, &r.pk); err != nil {
			t.Fatalf("扫描 table_info 失败：%v", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("table_info 迭代失败：%v", err)
	}
	return out
}

// TestDefineCreatesReservedRowIDPrimaryKey 覆盖 §5.2 与 §10.6 第 66 项：
// 平台自动追加唯一的 `_row_id INTEGER PRIMARY KEY AUTOINCREMENT`，
// 应用列全部可空、无主键（abi.ColumnDef 里根本没有主键字段可传）。
func TestDefineCreatesReservedRowIDPrimaryKey(t *testing.T) {
	d := newTestDB(t, "define-app")
	res := defineTable(t, d, "items", col("title", "text"), col("amount", "int"), col("done", "bool"))
	if !res.Created {
		t.Fatal("首次 define 应返回 Created=true")
	}
	if res.Table != "items" {
		t.Fatalf("结果表名应为 items，实际 %s", res.Table)
	}
	// 应用看不到 _row_id：结果列清单里只有应用声明的列（§5.2）。
	if strings.Join(res.Columns, ",") != "title,amount,done" {
		t.Fatalf("结果列应为 title,amount,done，实际 %v", res.Columns)
	}
	info := readTableInfo(t, d, "items")
	if len(info) != 4 {
		t.Fatalf("物理列应为 _row_id + 3 列，实际 %d：%+v", len(info), info)
	}
	if info[0].name != limits.ReservedRowIDColumn || info[0].pk != 1 {
		t.Fatalf("第一列应是唯一的 _row_id 主键：%+v", info[0])
	}
	if !strings.Contains(strings.ToUpper(info[0].declType), "INTEGER") {
		t.Fatalf("_row_id 应是 INTEGER：%+v", info[0])
	}
	for _, r := range info[1:] {
		if r.pk != 0 {
			t.Fatalf("应用列不应是主键：%+v", r)
		}
		if r.notNull != 0 {
			t.Fatalf("应用列不应是 NOT NULL：%+v", r)
		}
	}
	// declType 必须是 limits.SQLColumnTypeToSQLite 的映射值（数值/类型单一真源）。
	wantTypes := []string{"TEXT", "INTEGER", "INTEGER"}
	for i, want := range wantTypes {
		if info[i+1].declType != want {
			t.Fatalf("列 %s 声明类型应为 %s，实际 %s", info[i+1].name, want, info[i+1].declType)
		}
	}
	// AUTOINCREMENT 会建 sqlite_sequence，但它不能算进「应用表数」。
	if st := d.Stats(); st.Tables != 1 {
		t.Fatalf("表数应为 1（sqlite_sequence 不计），实际 %d", st.Tables)
	}
}

// TestDefineIsIdempotent 覆盖 §5.1「重复调用幂等」。
func TestDefineIsIdempotent(t *testing.T) {
	d := newTestDB(t, "idem-app")
	first := defineTable(t, d, "items", col("title", "text"))
	if !first.Created {
		t.Fatal("首次 Created 应为 true")
	}
	second := defineTable(t, d, "items", col("title", "text"))
	if second.Created {
		t.Fatal("第二次 Created 应为 false（幂等，不执行 DDL）")
	}
	if strings.Join(second.Columns, ",") != "title" {
		t.Fatalf("幂等路径也应回列清单：%v", second.Columns)
	}
	// 幂等路径不得改变物理结构（列序/主键不变）。
	info := readTableInfo(t, d, "items")
	if len(info) != 2 || info[0].name != limits.ReservedRowIDColumn || info[1].name != "title" {
		t.Fatalf("幂等路径改动了表结构：%+v", info)
	}
	if st := d.Stats(); st.Tables != 1 {
		t.Fatalf("表数应仍为 1，实际 %d", st.Tables)
	}
}

// TestDefineAllowsAddingColumnsButRejectsTypeChange 覆盖 §5.1「改结构 = 由应用自己建新表或加列」。
//
// 本包的选择：同表**新增列**由宿主在 db.define 内代执行 ALTER TABLE ADD COLUMN（应用自己
// 发 ALTER 仍被 sqlgate 拒）；同表同列**换类型**一律拒。
func TestDefineAllowsAddingColumnsButRejectsTypeChange(t *testing.T) {
	d := newTestDB(t, "alter-app")
	defineTable(t, d, "items", col("title", "text"), col("amount", "int"))

	// 加列：Created=false（abi.DBDefineResult 只有这一个布尔，无法表达「已加列」）。
	res := defineTable(t, d, "items", col("title", "text"), col("amount", "int"), col("note", "text"))
	if res.Created {
		t.Fatal("加列不应把 Created 置 true（表本来就存在）")
	}
	info := readTableInfo(t, d, "items")
	if len(info) != 4 || info[3].name != "note" || info[3].declType != "TEXT" {
		t.Fatalf("加列未生效：%+v", info)
	}
	// 再次调用同样声明：纯幂等，不重复加列。
	defineTable(t, d, "items", col("title", "text"), col("amount", "int"), col("note", "text"))
	if info := readTableInfo(t, d, "items"); len(info) != 4 {
		t.Fatalf("重复声明不应重复加列：%+v", info)
	}

	// 换类型：拒（text → int 是跨亲和性变更，会毁数据）。
	_, err := d.Define(context.Background(), abi.DBDefineParams{
		Table:   "items",
		Columns: []abi.ColumnDef{col("title", "int")},
	})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "column_type_change")
	if e.Details["existing_type"] != "TEXT" || e.Details["declared_type"] != "INTEGER" {
		t.Fatalf("类型冲突的 details 应回显既有/声明类型：%v", e.Details)
	}
	// 换类型被拒后结构不变。
	if info := readTableInfo(t, d, "items"); info[1].declType != "TEXT" {
		t.Fatalf("被拒的变更不应生效：%+v", info)
	}
}

// TestDefineRejectsInvalidNames 覆盖 §10.6 第 64 项（非法表名/列名）。
func TestDefineRejectsInvalidNames(t *testing.T) {
	d := newTestDB(t, "name-app")
	badTables := []string{
		"", "Items", "1items", "_items", "it ems", "items;DROP TABLE x", "items--", "a-b",
		"sqlite_master", "sqlite_sequence", "sqlite_x",
		strings.Repeat("a", 32), // 31 是上限
	}
	for _, table := range badTables {
		_, err := d.Define(context.Background(), abi.DBDefineParams{
			Table: table, Columns: []abi.ColumnDef{col("a", "text")},
		})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		requireReason(t, e, "invalid_table_name")
	}
	// 合法表名（含数字与下划线，≤31 字符）。
	ok := defineTable(t, d, "items_2026", col("a", "text"))
	if !ok.Created {
		t.Fatal("合法表名应建表成功")
	}

	badColumns := []string{"", "Title", "1col", "co l", "col-1", "col;x", strings.Repeat("c", 32), limits.ReservedRowIDColumn}
	for _, name := range badColumns {
		_, err := d.Define(context.Background(), abi.DBDefineParams{
			Table: "cols", Columns: []abi.ColumnDef{col(name, "text")},
		})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		reason, _ := e.Details["reason"].(string)
		if reason != "invalid_column_name" && reason != "reserved_column" {
			t.Fatalf("列名 %q 应被拒为非法/保留，实际 reason=%s", name, reason)
		}
	}
}

// TestDefineRejectsSeventeenthTable 覆盖 §10.6 第 64 项（表数上限，details 带 limit）。
func TestDefineRejectsSeventeenthTable(t *testing.T) {
	d := newTestDB(t, "tables-app")
	for i := 1; i <= limits.MaxTablesPerApp; i++ {
		defineTable(t, d, fmt.Sprintf("t%02d", i), col("a", "text"))
	}
	if st := d.Stats(); st.Tables != limits.MaxTablesPerApp {
		t.Fatalf("应有 %d 张表，实际 %d", limits.MaxTablesPerApp, st.Tables)
	}
	_, err := d.Define(context.Background(), abi.DBDefineParams{
		Table: "t17", Columns: []abi.ColumnDef{col("a", "text")},
	})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "too_many_tables")
	if e.Details["limit"] != limits.MaxTablesPerApp {
		t.Fatalf("details.limit 应为 %d，实际 %v", limits.MaxTablesPerApp, e.Details["limit"])
	}
	// 已有表的幂等调用不受表数上限影响（不消耗新配额）。
	defineTable(t, d, "t01", col("a", "text"))
}

// TestDefineRejectsSeventeenthColumn 覆盖 §10.6 第 64 项（列数上限）。
func TestDefineRejectsSeventeenthColumn(t *testing.T) {
	d := newTestDB(t, "cols-app")
	cols16 := make([]abi.ColumnDef, 0, limits.MaxColumnsPerTable)
	for i := 1; i <= limits.MaxColumnsPerTable; i++ {
		cols16 = append(cols16, col(fmt.Sprintf("c%02d", i), "text"))
	}
	defineTable(t, d, "wide", cols16...)

	// (a) 单次声明 17 列。
	cols17 := append(append([]abi.ColumnDef{}, cols16...), col("c17", "text"))
	_, err := d.Define(context.Background(), abi.DBDefineParams{Table: "wide2", Columns: cols17})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "too_many_columns")
	if e.Details["limit"] != limits.MaxColumnsPerTable {
		t.Fatalf("details.limit 应为 %d，实际 %v", limits.MaxColumnsPerTable, e.Details["limit"])
	}

	// (b) 给已有 16 列的表加第 17 列（走 existing+added 分支）。
	_, err = d.Define(context.Background(), abi.DBDefineParams{Table: "wide", Columns: cols17})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "too_many_columns")
	if info := readTableInfo(t, d, "wide"); len(info) != limits.MaxColumnsPerTable+1 {
		t.Fatalf("被拒的加列不应生效：%d 列", len(info))
	}
}

// TestDefineRejectsRowIDAliasAndEngineBuiltinNames 覆盖审计 P1-1 / P2-1 的**建表层**：
//   - 列名不能是 `_row_id` 的 SQLite 别名（rowid / _rowid_ / oid）——否则表里会出现一列
//     遮挡 rowid 解析、而 SQL 闸门又不允许提到它 ⇒「建得出、永远读不到」；
//   - 表名/列名不能是引擎内建对象名（dbstat / sqlite_* / load_extension …）——
//     与 sqlgate 的 engine_builtin 拒绝集同源，避免"能定义但提到即拒"的坑。
//
// 变异方式：把 validateDefineParams 里的 isReservedIdentifier / isEngineBuiltinIdentifier
// 判定去掉 ⇒ 本用例变红。
func TestDefineRejectsRowIDAliasAndEngineBuiltinNames(t *testing.T) {
	d := newTestDB(t, "define-reserved-app")
	ctx := context.Background()

	for _, name := range []string{"rowid", "_rowid_", "oid", "ROWID", "Oid"} {
		_, err := d.Define(ctx, abi.DBDefineParams{Table: "t_alias", Columns: []abi.ColumnDef{col(name, "text")}})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		requireReason(t, e, "reserved_column")
		if e.Details["identifier"] != name {
			t.Fatalf("列名 %q 被拒时 details.identifier 应回显实际形态，实际 %v", name, e.Details["identifier"])
		}
	}
	for _, name := range []string{"dbstat", "sqlite_dbpage", "pragma_table_info", "load_extension", "readfile"} {
		_, err := d.Define(ctx, abi.DBDefineParams{Table: "t_builtin", Columns: []abi.ColumnDef{col(name, "text")}})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		reason, _ := e.Details["reason"].(string)
		if reason != "reserved_column_name" && reason != "invalid_column_name" {
			t.Fatalf("内建名列名 %q 应被拒（reserved_column_name/invalid_column_name），实际 reason=%q", name, reason)
		}
	}
	// 表名同样不能是引擎内建对象名。
	for _, table := range []string{"dbstat", "load_extension", "fts5"} {
		_, err := d.Define(ctx, abi.DBDefineParams{Table: table, Columns: []abi.ColumnDef{col("a", "text")}})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		requireReason(t, e, "reserved_table_name")
	}
	// 相似名不受影响（词边界精确匹配）。
	defineTable(t, d, "my_dbstat_table", col("my_rowid", "text"), col("oid_x", "int"), col("rowid_note", "text"))
}

// TestDefineColumnLimitCountsAppColumnsOnly 覆盖审计 P2-2（§4.5/§5.3 列 ≤ 16 / 表）：
// 上限判据只数**应用声明的列**，平台保留列 `_row_id` 不占应用配额 ——
// 老实现把平台列算进 existing，于是"一次建 16 列"成功、而"逐次加到 16 列"在 15 列就被拒。
//
// 变异方式：把加列路径的 existingAppColumns 换回 len(existing)（含平台列）⇒ (b) 段变红。
func TestDefineColumnLimitCountsAppColumnsOnly(t *testing.T) {
	d := newTestDB(t, "col-limit-app")
	ctx := context.Background()
	limit := limits.MaxColumnsPerTable

	// (a) 一次声明 16 列：成功（物理列数 = 17，含平台列）。
	cols16 := make([]abi.ColumnDef, 0, limit)
	for i := 1; i <= limit; i++ {
		cols16 = append(cols16, col(fmt.Sprintf("c%02d", i), "text"))
	}
	defineTable(t, d, "wide", cols16...)
	if info := readTableInfo(t, d, "wide"); len(info) != limit+1 {
		t.Fatalf("一次建 16 列：物理列数应为 %d（含平台列），实际 %d", limit+1, len(info))
	}

	// (b) 逐列加到一个新表：从 1 列一路加到 16 列，每一步都必须成功。
	declared := []abi.ColumnDef{col("c01", "text")}
	defineTable(t, d, "grow", declared...)
	for i := 2; i <= limit; i++ {
		declared = append(declared, col(fmt.Sprintf("c%02d", i), "text"))
		res, err := d.Define(ctx, abi.DBDefineParams{Table: "grow", Columns: declared})
		if err != nil {
			t.Fatalf("逐列加到第 %d 列应成功，实际被拒：%v", i, err)
		}
		if res.Created {
			t.Fatal("加列路径必须返回 Created=false（表已存在）")
		}
	}
	if info := readTableInfo(t, d, "grow"); len(info) != limit+1 {
		t.Fatalf("逐列加到 16 应用列后物理列数应为 %d，实际 %d", limit+1, len(info))
	}

	// (c) 表已有 16 个**应用列**时，再引入一个新列必须被拒 ——
	// 判据走"加列"分支（声明 16 列，其中 c17 是新列），details.columns 必须是
	// 应用列口径 16（不含平台列），而不是老实现的 17。
	shifted := make([]abi.ColumnDef, 0, limit)
	for i := 2; i <= limit+1; i++ {
		shifted = append(shifted, col(fmt.Sprintf("c%02d", i), "text")) // c02..c17：比现有列多出 c17
	}
	_, err := d.Define(ctx, abi.DBDefineParams{Table: "grow", Columns: shifted})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "too_many_columns")
	if e.Details["columns"] != limit {
		t.Fatalf("details.columns 应为应用列数 %d（不含平台列），实际 %v", limit, e.Details["columns"])
	}
	if e.Details["added"] != 1 {
		t.Fatalf("details.added 应为 1，实际 %v", e.Details["added"])
	}
	if info := readTableInfo(t, d, "grow"); len(info) != limit+1 {
		t.Fatalf("被拒的加列不应生效：物理列数应为 %d，实际 %d", limit+1, len(info))
	}
	// 一次声明 17 列（新表）同样被拒（走声明期检查）。
	declared17 := append(append([]abi.ColumnDef{}, declared...), col("c17", "text"))
	if _, err := d.Define(ctx, abi.DBDefineParams{Table: "wide17", Columns: declared17}); err == nil {
		t.Fatal("一次声明 17 列应被拒")
	} else {
		requireReason(t, requireAppErr(t, err, apperr.CodeDBDenied), "too_many_columns")
	}
	// 幂等：同一张 16 列表重复声明同一个结构不消耗配额、也不报错。
	defineTable(t, d, "grow", declared...)
}

// TestDefineRejectsUnknownColumnType 覆盖 §10.6 第 65 项（列类型枚举封闭）。
func TestDefineRejectsUnknownColumnType(t *testing.T) {
	d := newTestDB(t, "type-app")
	for _, bad := range []string{"blob", "BLOB", "varchar(255)", "timestamp", "json", "numeric", "", "TEXT"} {
		_, err := d.Define(context.Background(), abi.DBDefineParams{
			Table: "t", Columns: []abi.ColumnDef{col("a", bad)},
		})
		e := requireAppErr(t, err, apperr.CodeDBDenied)
		requireReason(t, e, "invalid_column_type")
		if got, _ := e.Details["allowed"].([]string); len(got) != len(limits.SQLColumnTypes) {
			t.Fatalf("类型被拒时应回显完整枚举，实际 %v", e.Details["allowed"])
		}
	}
	// 枚举内全部类型都能建（映射表是唯一真源）。
	cols := make([]abi.ColumnDef, 0, len(limits.SQLColumnTypes))
	for i, typ := range limits.SQLColumnTypes {
		cols = append(cols, col(fmt.Sprintf("c%d", i), typ))
	}
	defineTable(t, d, "alltypes", cols...)
	info := readTableInfo(t, d, "alltypes")
	for i, typ := range limits.SQLColumnTypes {
		want := limits.SQLColumnTypeToSQLite[typ]
		if info[i+1].declType != want {
			t.Fatalf("%s 应映射为 %s，实际 %s", typ, want, info[i+1].declType)
		}
	}
}

// TestDefineIgnoresStructuralFieldsAndRejectsRowIDColumn 覆盖 §10.6 第 66/67 项。
//
// 结构里根本没有主键/索引/触发器字段：guest 多发的 JSON 字段会被 encoding/json 丢掉，
// 因此「试图指定主键/索引/触发器」不可能生效——本用例把这个事实钉住。
func TestDefineIgnoresStructuralFieldsAndRejectsRowIDColumn(t *testing.T) {
	d := newTestDB(t, "struct-app")
	raw := `{"table":"items","columns":[{"name":"title","type":"text"}],
	         "primary_key":"title","indexes":[{"name":"i","columns":["title"]}],
	         "unique":true,"foreign_key":{"table":"other","column":"id"},
	         "trigger":"AFTER INSERT BEGIN SELECT 1; END"}`
	var p abi.DBDefineParams
	if err := json.Unmarshal([]byte(raw), &p); err != nil {
		t.Fatalf("解析参数失败：%v", err)
	}
	res, err := d.Define(context.Background(), p)
	if err != nil {
		t.Fatalf("多余字段不应导致失败（结构里没有这些字段即不存在）：%v", err)
	}
	if !res.Created {
		t.Fatal("应建表成功")
	}
	info := readTableInfo(t, d, "items")
	if len(info) != 2 {
		t.Fatalf("只应有两列：%+v", info)
	}
	for _, r := range info {
		if r.pk != 0 && r.name != limits.ReservedRowIDColumn {
			t.Fatalf("除 _row_id 外不应有主键：%+v", r)
		}
	}
	// 索引/触发器不得被创建。
	var n int
	if err := d.rw.QueryRowContext(context.Background(),
		`SELECT count(*) FROM sqlite_master WHERE type IN ('index','trigger') AND tbl_name = 'items'`).Scan(&n); err != nil {
		t.Fatalf("统计索引失败：%v", err)
	}
	if n != 0 {
		t.Fatalf("不应创建任何索引/触发器，实际 %d", n)
	}

	// 用保留列当用户列名：拒。
	_, err = d.Define(context.Background(), abi.DBDefineParams{
		Table: "other", Columns: []abi.ColumnDef{col(limits.ReservedRowIDColumn, "int")},
	})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "reserved_column")
}

// TestDefineRejectsDuplicateColumnsAndEmpty 覆盖参数边界。
func TestDefineRejectsDuplicateColumnsAndEmpty(t *testing.T) {
	d := newTestDB(t, "dup-app")
	_, err := d.Define(context.Background(), abi.DBDefineParams{Table: "t"})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "missing_columns")

	_, err = d.Define(context.Background(), abi.DBDefineParams{
		Table: "t", Columns: []abi.ColumnDef{col("a", "text"), col("a", "text")},
	})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "duplicate_column")
}

// TestDefineInsideTransactionDenied 覆盖 §4.4「事务内宿主调用禁止」。
func TestDefineInsideTransactionDenied(t *testing.T) {
	d := newTestDB(t, "tx-define-app")
	tx, err := d.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin 失败：%v", err)
	}
	defer func() { _ = d.Rollback(context.Background(), abi.TxParams{TxID: tx.TxID}) }()
	_, derr := d.Define(context.Background(), abi.DBDefineParams{
		Table: "t", Columns: []abi.ColumnDef{col("a", "text")},
	})
	e := requireAppErr(t, derr, apperr.CodeDBDenied)
	requireReason(t, e, "define_in_transaction")
}

// TestDefineRejectsInternalPrefixNames：与 sqlgate 的 internal_object 闸门保持一致，
// 不允许建出 `sqlite_` 前缀的表/列（否则会出现「建得出、写不了」的坑）。
func TestDefineRejectsInternalPrefixNames(t *testing.T) {
	d := newTestDB(t, "internal-name-app")
	_, err := d.Define(context.Background(), abi.DBDefineParams{
		Table: "sqlite_like", Columns: []abi.ColumnDef{col("a", "text")},
	})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "invalid_table_name")

	_, err = d.Define(context.Background(), abi.DBDefineParams{
		Table: "ok_table", Columns: []abi.ColumnDef{col("sqlite_x", "text")},
	})
	e = requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "invalid_column_name")
}

// TestIdentifierLengthBoundaryMatchesPattern：错误文案里的长度上限必须由 limits 的
// pattern 推导（不在 appdb 里二次硬编码），且与真实可建/不可建边界一致。
func TestIdentifierLengthBoundaryMatchesPattern(t *testing.T) {
	maxLen := maxIdentLen(limits.TableNamePattern)
	if maxLen <= 1 {
		t.Fatalf("从 %s 推不出长度上限：%d", limits.TableNamePattern, maxLen)
	}
	if got := maxIdentLen(limits.ColumnNamePattern); got != maxLen {
		t.Fatalf("表名/列名 pattern 长度上限应一致：%d vs %d", maxLen, got)
	}
	d := newTestDB(t, "identlen-app")
	okName := strings.Repeat("a", maxLen)
	defineTable(t, d, okName, col("v", "text"))

	tooLong := strings.Repeat("a", maxLen+1)
	_, err := d.Define(context.Background(), abi.DBDefineParams{
		Table: tooLong, Columns: []abi.ColumnDef{col("v", "text")},
	})
	e := requireAppErr(t, err, apperr.CodeDBDenied)
	requireReason(t, e, "invalid_table_name")
	if !strings.Contains(e.Message, fmt.Sprintf("%d", maxLen)) {
		t.Fatalf("错误文案应写出推导出的长度上限 %d：%s", maxLen, e.Message)
	}
}
