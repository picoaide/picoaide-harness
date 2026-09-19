package appdb

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件实现 §5.1 的 `db.define`（R32）：**唯一**的建表入口。
//
// 应用不能发 DDL（sqlgate.go 拦 CREATE/ALTER/DROP），表结构只能通过 db.define 声明，
// 由宿主代执行 CREATE TABLE IF NOT EXISTS，并在宿主侧强制：
//   - 表名/列名 limits.TableNamePattern / limits.ColumnNamePattern；
//   - 列 ≤ limits.MaxColumnsPerTable、表 ≤ limits.MaxTablesPerApp；
//   - 列类型必须落在 limits.SQLColumnTypes 枚举内（映射用 limits.SQLColumnTypeToSQLite）；
//   - 禁止声明主键/外键/索引/触发器（abi.ColumnDef 里根本没有这些字段）；
//   - 平台保留列 `_row_id` 由宿主自动追加（INTEGER PRIMARY KEY AUTOINCREMENT，§5.2），
//     应用列名不得叫 `_row_id`。
//
// 列类型枚举的粒度（已确认的取舍，不是缺陷）：枚举是**声明层契约**（§4.5 的枚举一致性由
// §5.5 门禁保证），不是存储层 enforcement。limits.SQLColumnTypeToSQLite 是多对一
// （int/bool → INTEGER，text/datetime → TEXT），所以「同列换类型」的检测只能按**映射后的
// SQLite 声明类型**比对：跨亲和性变更（text ↔ int、int ↔ real 等）一律检出并拒，
// 而 int ↔ bool、text ↔ datetime 这类同亲和性变更在存储层不可区分、检不出（也不影响存储行为）。
//
// 幂等与结构变更（§5.1「重复调用幂等」「改结构 = 由应用自己建新表或加列」）：
//   - 同表同列同类型重复调用 ⇒ Created=false，不做任何 DDL；
//   - 同表同列但**类型不同** ⇒ 拒（DB_DENIED，reason=column_type_change）；
//   - 同表新增列 ⇒ 宿主代执行 ALTER TABLE ADD COLUMN（应用自己发 ALTER 仍被拒）。
//     abi.DBDefineResult 只有 Created 一个布尔，无法表达「表已存在但加了列」，
//     因此加列时同样返回 Created=false（列清单从 Columns 与库结构对比可得）。

var (
	tableNameRe  = regexp.MustCompile(limits.TableNamePattern)
	columnNameRe = regexp.MustCompile(limits.ColumnNamePattern)
	appIDRe      = regexp.MustCompile(limits.AppIDPattern)
)

// typeColumn 是 PRAGMA table_info 里我们关心的一行。
type typeColumn struct {
	name     string
	declType string
}

// Define 建表（宿主代执行，重复调用幂等）。实现 capapi.DB。
//
// 锁语义：整条 DDL 在 writeMu 下执行（写者独占）。db.define 是写原语，与 db.exec 互斥，
// 但与 db.query 的读**不再互斥**（读走只读连接池）——读一条 SELECT 不会被建表挡住。
func (d *DB) Define(ctx context.Context, p abi.DBDefineParams) (abi.DBDefineResult, error) {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if err := d.ensureReadyLocked(true); err != nil {
		return abi.DBDefineResult{}, err
	}
	if d.inTx() {
		// 事务内只允许 db.query/db.exec（§4.4「事务内宿主调用禁止」）：建表是 DDL，
		// 放进事务会把「5 s 强制回滚」的语义搅浑（表结构变更回滚的边界由作者负责）。
		return abi.DBDefineResult{}, denied("define_in_transaction",
			"事务内不允许 db.define：请在事务之外先把表结构声明好").
			WithHint("db.define 是建表原语（DDL），只允许在事务外调用")
	}

	// L4：本原语的每条宿主语句都跑在读写连接上，执行前复检它仍带全套限额（FIX-12）。
	if _, cerr := d.checkedWriteConn(ctx); cerr != nil {
		return abi.DBDefineResult{}, cerr
	}

	cols, appErr := validateDefineParams(p)
	if appErr != nil {
		return abi.DBDefineResult{}, appErr
	}
	names := make([]string, 0, len(cols))
	for _, c := range cols {
		names = append(names, c.Name)
	}

	exists, existing, err := d.tableInfoLocked(ctx, p.Table)
	if err != nil {
		return abi.DBDefineResult{}, err
	}
	if !exists {
		// 表数上限（R32）：只有真的新建表才消耗配额。
		n, err := d.countTablesLocked(ctx)
		if err != nil {
			return abi.DBDefineResult{}, err
		}
		if n >= limits.MaxTablesPerApp {
			return abi.DBDefineResult{}, denied("too_many_tables",
				fmt.Sprintf("表数量已达上限 %d（当前 %d 张）", limits.MaxTablesPerApp, n)).
				WithDetail("limit", limits.MaxTablesPerApp).
				WithDetail("tables", n).
				WithHint("请合并表结构或删除不再使用的表；扩容只能由平台管理员操作")
		}
		if _, err := d.execHostLocked(ctx, buildCreateTable(p.Table, cols)); err != nil {
			return abi.DBDefineResult{}, err
		}
		d.tables.Store(int64(n + 1))
		return abi.DBDefineResult{Created: true, Table: p.Table, Columns: names}, nil
	}

	// 表已存在：逐列核对类型，允许追加新列。
	existingByName := make(map[string]string, len(existing))
	existingAppColumns := 0
	for _, c := range existing {
		if isReservedRowID(c.name) {
			// 平台追加的 `_row_id` 不占应用的列配额（§5.3「列 ≤ 16 / 表」说的是**应用列**）。
			// 审计 P2-2：老实现用 len(existing) 计数，把平台列也算成"应用的现有列"，
			// 于是"一次建 16 列"成功而"逐次加到 16 列"在 15 列就被拒（两条路径口径不一致）。
			continue
		}
		existingAppColumns++
		existingByName[strings.ToLower(c.name)] = c.declType
	}
	var added []abi.ColumnDef
	for _, c := range cols {
		got, ok := existingByName[strings.ToLower(c.Name)]
		if !ok {
			added = append(added, c)
			continue
		}
		want := limits.SQLColumnTypeToSQLite[c.Type]
		if !strings.EqualFold(strings.TrimSpace(got), want) {
			return abi.DBDefineResult{}, denied("column_type_change",
				fmt.Sprintf("列 %s.%s 已存在且类型为 %s，与本次声明的 %s 不一致", p.Table, c.Name, got, want)).
				WithDetail("table", p.Table).
				WithDetail("column", c.Name).
				WithDetail("existing_type", got).
				WithDetail("declared_type", want).
				WithHint("平台不做自动迁移：请新建一张表，或给新列起一个新名字")
		}
	}
	if len(added) == 0 {
		// 幂等路径：不执行任何 DDL。
		return abi.DBDefineResult{Created: false, Table: p.Table, Columns: names}, nil
	}
	if existingAppColumns+len(added) > limits.MaxColumnsPerTable {
		// 上限判据只数**应用声明的列**（平台保留列不占配额），文案也按这个口径写，
		// 否则会出现"应用只声明了 14 列，却被告知已有 16 列"的误导（审计 P2-2）。
		return abi.DBDefineResult{}, denied("too_many_columns",
			fmt.Sprintf("表 %s 的应用列数会超过上限 %d（当前 %d 列 + 新增 %d 列）",
				p.Table, limits.MaxColumnsPerTable, existingAppColumns, len(added))).
			WithDetail("limit", limits.MaxColumnsPerTable).
			WithDetail("columns", existingAppColumns).
			WithDetail("added", len(added)).
			WithHint("请新建一张表承载新字段，或删掉不再使用的列所在表后重建")
	}
	for _, c := range added {
		// ALTER TABLE ADD COLUMN 是 DDL，但**只由宿主在 db.define 内代执行**（R32）。
		stmt := fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s",
			quoteIdent(p.Table), quoteIdent(c.Name), limits.SQLColumnTypeToSQLite[c.Type])
		if _, err := d.execHostLocked(ctx, stmt); err != nil {
			return abi.DBDefineResult{}, err
		}
	}
	return abi.DBDefineResult{Created: false, Table: p.Table, Columns: names}, nil
}

// maxIdentLen 从 limits 的标识符 pattern（`^[a-z][a-z0-9_]{0,30}$`）推导长度上限。
//
// 错误文案里的数字必须与唯一真源一致，所以这里**推导**而不是在 appdb 里再写一个 31；
// 推导失败返回 0（调用方只在 >0 时把数字写进文案）。
func maxIdentLen(pattern string) int {
	open := strings.LastIndex(pattern, "{0,")
	closeIdx := strings.LastIndex(pattern, "}")
	if open < 0 || closeIdx <= open+3 {
		return 0
	}
	n, err := strconv.Atoi(pattern[open+3 : closeIdx])
	if err != nil {
		return 0
	}
	return n + 1 // {0,N} 只算首字符之后的长度
}

// validateDefineParams 校验表名/列名/列类型/列数（§5.1、§10.6 第 64/65/66 项）。
func validateDefineParams(p abi.DBDefineParams) ([]abi.ColumnDef, *apperr.Error) {
	table := p.Table
	if !tableNameRe.MatchString(table) || strings.HasPrefix(table, "sqlite_") {
		return nil, denied("invalid_table_name",
			fmt.Sprintf("非法表名 %q：必须匹配 %s（小写字母开头，只含小写字母/数字/下划线，长度 ≤ %d）",
				table, limits.TableNamePattern, maxIdentLen(limits.TableNamePattern))).
			WithDetail("field", "table").
			WithDetail("pattern", limits.TableNamePattern).
			WithHint("sqlite_ 前缀是引擎内部保留命名，也不能使用")
	}
	if isEngineBuiltinIdentifier(table) {
		// 与 sqlgate 的 engine_builtin 拒绝集同源：能定义但"提到即拒"的表名是坑
		// （应用建得出 `dbstat` 表，却永远查不到它，因为查询会命中引擎内建虚表名）。
		return nil, denied("reserved_table_name",
			fmt.Sprintf("非法表名 %q：它是引擎内建对象名（平台托管面）", table)).
			WithDetail("field", "table").
			WithDetail("reserved", append([]string(nil), engineBuiltinIdentifiers...)).
			WithHint("换一个表名：引擎内建对象名（如 dbstat / sqlite_* / pragma_*）不对应用开放")
	}
	if len(p.Columns) == 0 {
		return nil, denied("missing_columns", "db.define 至少要声明一列").
			WithDetail("field", "columns")
	}
	if len(p.Columns) > limits.MaxColumnsPerTable {
		return nil, denied("too_many_columns",
			fmt.Sprintf("列数超过上限 %d（声明了 %d 列）", limits.MaxColumnsPerTable, len(p.Columns))).
			WithDetail("limit", limits.MaxColumnsPerTable).
			WithDetail("columns", len(p.Columns)).
			WithHint("请把字段拆到多张表；平台上限由 db.define 强制，不能靠发布期声明绕过")
	}
	seen := make(map[string]bool, len(p.Columns))
	out := make([]abi.ColumnDef, 0, len(p.Columns))
	for _, c := range p.Columns {
		// 保留列先判：`_row_id` 与它的 SQLite 别名（rowid/_rowid_/oid）都不匹配
		// ColumnNamePattern 之外的语义 —— 先判它们能给出「这是平台主键」这种可操作文案，
		// 而不是笼统的命名规则错误。
		//
		// 为什么别名也要拒（审计 P1-1）：表里真出现一列叫 `rowid` 时，SQLite 的
		// rowid 解析会被这列**遮蔽**，而闸门又不允许应用提到 `rowid`
		// ⇒ 该列"建得出、永远读不到"。直接从建表侧堵死。
		if isReservedIdentifier(c.Name) {
			return nil, denied("reserved_column",
				"列名不能是平台保留列 "+limits.ReservedRowIDColumn+" 或它的 SQLite 别名（rowid / _rowid_ / oid）：平台会为每张表自动追加该主键").
				WithDetail("column", limits.ReservedRowIDColumn).
				WithDetail("identifier", c.Name).
				WithHint("业务上的自增序号请换一个列名（平台不提供自增语义）")
		}
		if isEngineBuiltinIdentifier(c.Name) {
			return nil, denied("reserved_column_name",
				fmt.Sprintf("非法列名 %q：它是引擎内建对象/函数名（与 SQL 闸门的 engine_builtin 拒绝集同源）", c.Name)).
				WithDetail("field", "column").
				WithDetail("reserved", append([]string(nil), engineBuiltinIdentifiers...)).
				WithHint("换一个列名：能定义但「提到即拒」的列名是坑")
		}
		if hasInternalPrefix(c.Name) || hasPragmaPrefix(c.Name) {
			// 与 sqlgate 的 `internal_object` / `pragma_function` 闸门保持一致：应用 SQL 里
			// 不允许出现这两类前缀的标识符，所以也不允许建出这种列
			// （否则会出现「能定义、不能用」的坑）。
			return nil, denied("invalid_column_name",
				fmt.Sprintf("非法列名 %q：sqlite_ / pragma_ 前缀是引擎保留命名", c.Name)).
				WithDetail("field", "column").
				WithDetail("pattern", limits.ColumnNamePattern).
				WithHint("换一个不以 sqlite_ / pragma_ 开头的列名")
		}
		if !columnNameRe.MatchString(c.Name) {
			return nil, denied("invalid_column_name",
				fmt.Sprintf("非法列名 %q：必须匹配 %s", c.Name, limits.ColumnNamePattern)).
				WithDetail("field", "column").
				WithDetail("pattern", limits.ColumnNamePattern)
		}
		if seen[strings.ToLower(c.Name)] {
			return nil, denied("duplicate_column", fmt.Sprintf("列名 %q 重复声明", c.Name)).
				WithDetail("field", "column").
				WithDetail("column", c.Name)
		}
		seen[strings.ToLower(c.Name)] = true
		if _, ok := limits.SQLColumnTypeToSQLite[c.Type]; !ok {
			return nil, denied("invalid_column_type",
				fmt.Sprintf("列 %s 的类型 %q 不在枚举内", c.Name, c.Type)).
				WithDetail("field", "type").
				WithDetail("column", c.Name).
				WithDetail("allowed", append([]string(nil), limits.SQLColumnTypes...)).
				WithHint("允许的类型：" + strings.Join(limits.SQLColumnTypes, " / "))
		}
		if !containsString(limits.SQLColumnTypes, c.Type) {
			// 枚举表是唯一真源：值不在 SQLColumnTypes 里（理论上不可达，防御性兜底）。
			return nil, denied("invalid_column_type",
				fmt.Sprintf("列 %s 的类型 %q 不在枚举内", c.Name, c.Type)).
				WithDetail("allowed", append([]string(nil), limits.SQLColumnTypes...))
		}
		out = append(out, abi.ColumnDef{Name: c.Name, Type: c.Type})
	}
	return out, nil
}

// buildCreateTable 生成建表 DDL：平台先追加 `_row_id INTEGER PRIMARY KEY AUTOINCREMENT`（§5.2），
// 再按声明顺序追加应用列（全部可空，应用不能声明 NOT NULL/主键/外键/唯一）。
func buildCreateTable(table string, cols []abi.ColumnDef) string {
	var b strings.Builder
	b.WriteString("CREATE TABLE IF NOT EXISTS ")
	b.WriteString(quoteIdent(table))
	b.WriteString(" (")
	b.WriteString(quoteIdent(limits.ReservedRowIDColumn))
	b.WriteString(" INTEGER PRIMARY KEY AUTOINCREMENT")
	for _, c := range cols {
		b.WriteString(", ")
		b.WriteString(quoteIdent(c.Name))
		b.WriteString(" ")
		b.WriteString(limits.SQLColumnTypeToSQLite[c.Type])
	}
	b.WriteString(")")
	return b.String()
}

// tableInfoLocked 读取表结构；表不存在时 exists=false。
func (d *DB) tableInfoLocked(ctx context.Context, table string) (bool, []typeColumn, error) {
	cctx, cancel := d.stmtContext(ctx)
	defer cancel()
	conn := d.writeConn()
	if conn == nil {
		return false, nil, apperr.New(apperr.CodeInternal, "appdb: 连接不可用（内部状态异常）")
	}
	rows, err := conn.QueryContext(cctx, `SELECT name, type FROM pragma_table_info(?)`, table)
	if err != nil {
		return false, nil, d.mapStmtError(cctx, err)
	}
	defer rows.Close()
	var out []typeColumn
	for rows.Next() {
		var c typeColumn
		if err := rows.Scan(&c.name, &c.declType); err != nil {
			return false, nil, d.mapStmtError(cctx, err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return false, nil, d.mapStmtError(cctx, err)
	}
	return len(out) > 0, out, nil
}

// execHostLocked 执行宿主代写的语句（DDL 等），带预算与错误映射。
func (d *DB) execHostLocked(ctx context.Context, query string, args ...any) (sql.Result, error) {
	cctx, cancel := d.stmtContext(ctx)
	defer cancel()
	conn := d.writeConn()
	if conn == nil {
		return nil, apperr.New(apperr.CodeInternal, "appdb: 连接不可用（内部状态异常）")
	}
	res, err := conn.ExecContext(cctx, query, args...)
	if err != nil {
		return nil, d.mapStmtError(cctx, err)
	}
	return res, nil
}

// quoteIdent 用双引号包裹标识符（名字已过 pattern 校验，这里再防一层注入）。
func quoteIdent(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func containsString(list []string, want string) bool {
	for _, v := range list {
		if v == want {
			return true
		}
	}
	return false
}
