package appdb

import (
	"fmt"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是 §4.5「单语句闸门 + 语句种类白名单 + 保留列拒绝」的实现。
//
// 为什么自己写词法扫描而不是用 `strings.Contains(sql, ";")`：
// 分号可以合法出现在字符串字面量（`'a;b'`）、引号标识符（`"a;b"`）与注释里，
// 粗暴切分既会误杀合法查询，也会放过 `INSERT …; SELECT …` 这类真多语句
// （实测：多语句会让 db.query/db.exec 的区分形同虚设，§4.5）。
//
// 扫描只回答四件事（不解析 SQL 语义，语义交给 SQLite）：
//  1. 分号是否只出现在字符串/标识符/注释之外，且其后除空白与注释外再无内容；
//  2. 第一条语句的首个关键字（用于语句种类白名单）；
//  3. 是否在**标识符位置**提到平台保留列 `_row_id` 或它的 SQLite 别名（§5.2）；
//  4. 是否在**任意位置**出现关键字 `WITH`（§4.5 词级判定）或引擎内建对象名（§5.1）。

// sqlKind 是语句种类白名单的取值（§4.5：仅 SELECT/INSERT/UPDATE/DELETE）。
type sqlKind int

const (
	kindUnknown sqlKind = iota
	kindSelect
	kindInsert
	kindUpdate
	kindDelete
)

func (k sqlKind) String() string {
	switch k {
	case kindSelect:
		return "SELECT"
	case kindInsert:
		return "INSERT"
	case kindUpdate:
		return "UPDATE"
	case kindDelete:
		return "DELETE"
	}
	return "UNKNOWN"
}

// sqlScan 是扫描结果。
type sqlScan struct {
	// first 是首条语句的首个裸词（已大写化）；空串表示语句以非词法单词开头。
	first string
	// mentionReserved 表示标识符位置出现平台保留列 limits.ReservedRowIDColumn
	// **或它的 SQLite 内建别名**（rowid / _rowid_ / oid，见 reservedIdentifierAliases）。
	mentionReserved bool
	// reservedIdent 是首次命中的保留标识符原文（用于把文案说准：_row_id 还是它的别名）。
	reservedIdent string
	// mentionWith 表示语句在**任意位置**出现了裸词关键字 `WITH`（词级判定，§4.5）。
	//
	// 为什么必须词级而不是"首关键字"：`WITH RECURSIVE` 出现在子查询里时
	// （`SELECT count(*) FROM (WITH RECURSIVE c(x) AS (…) SELECT x FROM c)`）
	// 首个关键字仍是 SELECT ⇒ 老的"只看 first"判定整条失效，实测该语句会穿过闸门
	// 并真的跑满 5 s 单语句预算（审计 P1-2）。
	//
	// 取舍（有意收紧，已与设计口径对齐）：§4.5 写的是"禁 WITH RECURSIVE"，实现按
	// **一律拒 WITH** 执行 —— 嵌套的非递归 CTE（`SELECT … FROM (WITH x AS (…) SELECT …)`）
	// 也会一起被拒。理由是"能改写成普通 SELECT"的成本很低，而"漏放递归 CTE"的代价是
	// 一次资源耗尽；错杀的方向是安全的。见 classifyFirst 的 with_not_allowed 文案。
	mentionWith bool
	// internalIdent 是语句里出现的第一个引擎内部标识符：
	// `sqlite_` 前缀（内部表/虚拟表）或 `pragma_` 前缀（PRAGMA 表值函数）。
	//
	// 为什么必须拦（两条实测依据，modernc.org/sqlite v1.55.0 / SQLite 3.53.3，本机）：
	//  1. `UPDATE sqlite_dbpage SET data = data WHERE pgno = 1` **执行成功**（err=nil）
	//     ⇒ 应用可直接改写库文件物理页，绕开 db.define 的全部结构约束并写坏库；
	//  2. `SELECT file FROM pragma_database_list` 给出宿主侧库文件绝对路径
	//     ⇒ 与设计 §4.5 明确要防的 `PRAGMA database_list` 探测等价，却绕过了
	//     「PRAGMA 关键字一律拒」的语句闸门。
	// 设计 §4.5 的禁用清单只覆盖 DDL/PRAGMA/ATTACH 这些**语句关键字**，没覆盖这两类
	// 标识符，所以这里补上（与「清单式禁命中必然漏、要用 allow-list」的口径一致）。
	internalIdent string
	// engineBuiltin 是语句里第一个命中 engineBuiltinIdentifiers 的标识符。
	//
	// 为什么不能只按前缀拦（审计 P2-1）：`dbstat` 是引擎内建的**非前缀**同族虚表，
	// 实测 `SELECT * FROM dbstat` 给出本应用库的对象名与页表（含平台自建的
	// sqlite_sequence）；`load_extension` 是**非前缀**函数，今天只靠引擎
	// "not authorized" 兜底（一旦驱动启用扩展加载就是进程内任意原生代码执行）。
	// 拦截依据必须是**能力/显式清单**，不能是名字前缀。
	engineBuiltin string
}

// scanSQL 跑单语句闸门，返回扫描事实；任何违规都返回 *apperr.Error（DB_DENIED）。
func scanSQL(sql string) (*sqlScan, *apperr.Error) {
	if len(sql) > limits.SQLLimitSQLLength {
		return nil, denied("sql_too_long",
			fmt.Sprintf("SQL 文本超过 %d KiB 上限", limits.SQLLimitSQLLength>>10)).
			WithDetail("limit_bytes", limits.SQLLimitSQLLength).
			WithDetail("got_bytes", len(sql))
	}
	res := &sqlScan{}
	i, n := 0, len(sql)
	// sawContent 是「当前这条语句已有内容」（分号前的空语句检查用）；
	// sawAny 是「整段文本出现过内容」（结尾分号后没有内容仍然是合法语句）。
	sawContent := false
	sawAny := false
	terminated := false
	for i < n {
		c := sql[i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v':
			i++
			continue
		case c == '-' && i+1 < n && sql[i+1] == '-':
			// 行注释：直到行尾（SQLite 的 `--` 到换行或输入结束）。
			if j := strings.IndexByte(sql[i:], '\n'); j >= 0 {
				i += j + 1
			} else {
				i = n
			}
			continue
		case c == '/' && i+1 < n && sql[i+1] == '*':
			// 块注释：SQLite 允许嵌套吗？不允许（不支持嵌套），未闭合即词法错误。
			j := strings.Index(sql[i+2:], "*/")
			if j < 0 {
				return nil, denied("unterminated_comment", "块注释 /* 未闭合")
			}
			i += 2 + j + 2
			continue
		}

		if c == ';' {
			if !sawContent {
				return nil, denied("empty_statement", "SQL 为空语句（只有分号/空白/注释）")
			}
			terminated = true
			sawContent = false
			i++
			continue
		}

		// 到这里说明遇到了真正的内容。
		if terminated {
			// 分号之后还有内容 ⇒ 多语句：只允许一条语句（§4.5）。
			return nil, denied("multiple_statements",
				"只允许一条 SQL 语句：分号之后不得再有内容（字符串字面量与注释里的分号不算）").
				WithDetail("offset", i)
		}
		sawContent = true
		sawAny = true

		switch c {
		case '\'':
			end, err := scanSingleQuoted(sql, i)
			if err != nil {
				return nil, err
			}
			i = end
		case '"', '`':
			inner, end, err := scanQuotedIdentifier(sql, i, c)
			if err != nil {
				return nil, err
			}
			res.observeIdent(inner)
			i = end
		case '[':
			inner, end, err := scanBracketIdentifier(sql, i)
			if err != nil {
				return nil, err
			}
			res.observeIdent(inner)
			i = end
		default:
			if isWordByte(c) {
				j := i
				for j < n && isWordByte(sql[j]) {
					j++
				}
				word := sql[i:j]
				if res.first == "" {
					res.first = strings.ToUpper(word)
				}
				// 词级判定：**任意位置**的裸词 WITH 都算 CTE 入口（§4.5）。
				// 只认裸词：字符串字面量（scanSingleQuoted）与引号标识符
				// （"with" / [with] / `with`）走的是别的分支，不是关键字出现的位置
				// ——带引号的 "with" 在 SQLite 里是**标识符**，写不出 CTE。
				if !res.mentionWith && strings.EqualFold(word, withKeyword) {
					res.mentionWith = true
				}
				res.observeIdent(word)
				i = j
			} else {
				// 标点/运算符：对闸门无意义，逐个跳过。
				i++
			}
		}
	}
	if !sawAny {
		return nil, denied("empty_statement", "SQL 为空（只有空白/注释，没有语句）")
	}
	// 走到这里 sawContent 可能为 false：那是「语句以分号收尾」的正常形态
	// （`SELECT 1;` 是合法的单语句）。
	return res, nil
}

// checkStatement 在单语句闸门之上做语句种类判定。
//
// 判种类必须跳过前导注释与空白（scanSQL 已做）；`WITH`（含 `WITH RECURSIVE`）、
// `EXPLAIN`、裸 `VALUES` 等非白名单首关键字一律拒（§4.5/§10.1）。
// 注意：`SELECT` 文本里出现 `ATTACH`/`PRAGMA` 关键字属纵深，主闸门是
// LIMIT_ATTACHED=0 的连接级限额（§15.1 第 5 条）。
func checkStatement(sql string, allowed ...sqlKind) (*sqlScan, *apperr.Error) {
	res, err := scanSQL(sql)
	if err != nil {
		return nil, err
	}
	if res.mentionReserved {
		// 文案区分"平台列本身"与"SQLite 内建别名"：后者是应用最容易无意踩到的形态
		// （`SELECT rowid FROM t` 是 SQLite 的常见写法），必须把因果关系说清楚。
		if isReservedRowID(res.reservedIdent) {
			return nil, denied("reserved_column",
				"SQL 提到平台保留列 _row_id：应用看不到该列（它是平台主键）").
				WithDetail("column", limits.ReservedRowIDColumn).
				WithDetail("identifier", res.reservedIdent).
				WithHint("不要查询或写入 _row_id；需要业务序号请自己建列并用 db.define 声明")
		}
		return nil, denied("reserved_column",
			"SQL 提到平台保留列 "+res.reservedIdent+"：它是 _row_id 的 SQLite 内建别名（同一个 INTEGER PRIMARY KEY）").
			WithDetail("column", limits.ReservedRowIDColumn).
			WithDetail("identifier", res.reservedIdent).
			WithHint("rowid / _rowid_ / oid 都不能出现在 SQL 里；需要业务序号请自己建列并用 db.define 声明")
	}
	if res.internalIdent != "" {
		if hasPragmaPrefix(res.internalIdent) {
			return nil, denied("pragma_function",
				"不能使用 PRAGMA 表值函数 "+res.internalIdent+"（等价于应用提交 PRAGMA，平台一律拒）").
				WithDetail("identifier", res.internalIdent).
				WithHint("表结构与页信息由平台托管：建表/加列请用 db.define；schema 自省走平台接口")
		}
		return nil, denied("internal_object",
			"不能访问引擎内部对象 "+res.internalIdent+"（sqlite_ 前缀是 SQLite 保留命名）").
			WithDetail("identifier", res.internalIdent).
			WithHint("表结构与库文件由平台托管：建表/加列请用 db.define，数据请用自己的表读写")
	}
	if res.engineBuiltin != "" {
		// 显式拒绝集（不是前缀规则）：新增引擎内建对象名必须进 engineBuiltinIdentifiers。
		return nil, denied("engine_builtin",
			"不能使用引擎内建对象/函数 "+res.engineBuiltin+"：它属于平台托管面（§5.1 能力清单之外）").
			WithDetail("identifier", res.engineBuiltin).
			WithDetail("denied", append([]string(nil), engineBuiltinIdentifiers...)).
			WithHint("应用只能读写自己用 db.define 建的表；库结构/页信息/扩展加载都不对应用开放")
	}
	if res.mentionWith {
		// 词级判定：顶层与嵌套（子查询 / UNION 两侧 / FROM 子句里）一视同仁。
		return nil, denied("with_not_allowed",
			"不支持 CTE（WITH / WITH RECURSIVE），无论出现在语句的哪个位置：请改写成普通 SELECT").
			WithDetail("statement", "WITH").
			WithDetail("offset_hint", "nested_or_toplevel").
			WithHint("需要多步查询时用多次 db.query，或把中间结果落到自己的表里再查")
	}
	kind, err := classifyFirst(res.first)
	if err != nil {
		return nil, err
	}
	for _, want := range allowed {
		if kind == want {
			return res, nil
		}
	}
	// 种类合法但不是本次原语允许的（例如 db.query 收到 INSERT）。
	names := make([]string, 0, len(allowed))
	for _, want := range allowed {
		names = append(names, want.String())
	}
	return nil, denied("wrong_statement_kind",
		"语句种类不匹配：这里只接受 "+strings.Join(names, "/")+"，收到 "+kind.String()).
		WithDetail("statement", kind.String()).
		WithDetail("allowed", names).
		WithHint("db.query 只跑 SELECT；db.exec 只跑 INSERT/UPDATE/DELETE")
}

// classifyFirst 把首个关键字映射到语句种类，并对永久禁用的种类给出可操作文案。
func classifyFirst(first string) (sqlKind, *apperr.Error) {
	switch first {
	case "SELECT":
		return kindSelect, nil
	case "INSERT":
		return kindInsert, nil
	case "UPDATE":
		return kindUpdate, nil
	case "DELETE":
		return kindDelete, nil
	case "WITH":
		// 纵深（正常路径已被 checkStatement 的**词级** mentionWith 拦在更前面）：
		// 保留这支是为了让 classifyFirst 单独使用时也给出同一口径的拒绝，
		// 以及防止有人把词级判定改回"只看首关键字"后这里成为唯一防线。
		// 含 WITH RECURSIVE：CTE 的递归形态是运行期资源耗尽的主力（§10.3 第 31 项），
		// 且 `WITH … SELECT` 会让「首关键字判种类」失效 ⇒ 一并拒。
		return kindUnknown, denied("with_not_allowed",
			"不支持 WITH / WITH RECURSIVE：请把 CTE 改写为普通 SELECT（必要时拆成多次调用）").
			WithDetail("statement", "WITH").
			WithHint("需要多步查询时用多次 db.query，或让宿主侧逻辑拼装结果")
	case "EXPLAIN":
		return kindUnknown, denied("explain_not_allowed",
			"禁止 EXPLAIN / EXPLAIN QUERY PLAN：它会暴露平台内部的查询计划与库结构").
			WithDetail("statement", "EXPLAIN")
	case "VALUES":
		return kindUnknown, denied("statement_not_allowed",
			"只允许单条 SELECT/INSERT/UPDATE/DELETE，收到 VALUES（裸 VALUES 不在白名单内）").
			WithDetail("statement", "VALUES").
			WithDetail("allowed", limits.AllowedStatementKinds)
	}

	for _, kind := range limits.DeniedStatementKinds {
		if first != kind {
			continue
		}
		msg := "禁止 " + kind + " 语句"
		hint := "只允许单条 SELECT/INSERT/UPDATE/DELETE；建表请调用 db.define"
		switch kind {
		case "CREATE", "DROP", "ALTER":
			// 建表只能经 db.define（宿主代执行并强制表/列上限，R32）。
			msg = "禁止 " + kind + "：应用不能自己修改表结构"
			hint = fmt.Sprintf("建表/加列请调用 db.define；平台会代为执行并强制表数 ≤ %d、列数 ≤ %d",
				limits.MaxTablesPerApp, limits.MaxColumnsPerTable)
		case "ATTACH", "DETACH":
			msg = "禁止 " + kind + "：每个应用只能访问自己的数据库，不能挂载其它库"
			hint = "跨库读写在平台上是不可达能力；需要多张表请用 db.define 建在本应用库内"
		case "VACUUM":
			msg = "禁止 VACUUM / VACUUM INTO：应用不能压缩或导出数据库文件"
			hint = "数据导出请用 db.query 分页读取"
		case "PRAGMA":
			msg = "禁止 PRAGMA：连接级开关会绕过平台护栏（如 writable_schema）"
			hint = "平台已代设全部必要 PRAGMA；应用不需要也不能改"
		case "REPLACE":
			msg = "禁止 REPLACE：请用 INSERT（配 db.define 的列）或 UPDATE"
		}
		return kindUnknown, denied("statement_not_allowed", msg).
			WithDetail("statement", kind).
			WithDetail("allowed", limits.AllowedStatementKinds).
			WithHint(hint)
	}

	return kindUnknown, denied("statement_not_allowed",
		"只允许单条 SELECT/INSERT/UPDATE/DELETE 语句，收到 "+firstOrDefault(first)).
		WithDetail("statement", firstOrDefault(first)).
		WithDetail("allowed", limits.AllowedStatementKinds).
		WithHint("建表请调用 db.define；改表结构请在新版本里用 db.define 声明")
}

// denied 构造 DB_DENIED（403）并带上机器可读的 reason。
func denied(reason, msg string) *apperr.Error {
	e := apperr.New(apperr.CodeDBDenied, msg).WithDetail("reason", reason)
	if hints, ok := apperr.CommonHints[apperr.CodeDBDenied]; ok {
		for _, h := range hints {
			e = e.WithHint(h)
		}
	}
	return e
}

func firstOrDefault(first string) string {
	if first == "" {
		return "(无法识别的开头)"
	}
	return first
}

// scanSingleQuoted 跳过一个单引号字符串字面量，返回结束后的下标。
// SQLite 不用反斜杠转义，只有 `”` 表示一个引号（§4.5 明确要求考虑 `”` 转义）。
func scanSingleQuoted(sql string, start int) (int, *apperr.Error) {
	for i := start + 1; i < len(sql); i++ {
		if sql[i] != '\'' {
			continue
		}
		if i+1 < len(sql) && sql[i+1] == '\'' {
			i++
			continue
		}
		return i + 1, nil
	}
	return 0, denied("unterminated_string", "字符串字面量 ' 未闭合").
		WithDetail("offset", start)
}

// scanQuotedIdentifier 跳过 `"…"` 或 “ `…` “ 引号标识符，返回内部文本与结束下标。
// 两种引号都用「重复引号」表示自身（`""` / ``` “ ```）。
func scanQuotedIdentifier(sql string, start int, quote byte) (string, int, *apperr.Error) {
	var b strings.Builder
	for i := start + 1; i < len(sql); i++ {
		if sql[i] != quote {
			b.WriteByte(sql[i])
			continue
		}
		if i+1 < len(sql) && sql[i+1] == quote {
			b.WriteByte(quote)
			i++
			continue
		}
		return b.String(), i + 1, nil
	}
	return "", 0, denied("unterminated_identifier", "引号标识符未闭合").
		WithDetail("offset", start)
}

// scanBracketIdentifier 跳过 `[…]` 标识符（SQLite/MS-Access 风格，内部无转义）。
func scanBracketIdentifier(sql string, start int) (string, int, *apperr.Error) {
	for i := start + 1; i < len(sql); i++ {
		if sql[i] == ']' {
			return sql[start+1 : i], i + 1, nil
		}
	}
	return "", 0, denied("unterminated_identifier", "方括号标识符 [ 未闭合").
		WithDetail("offset", start)
}

// isWordByte 判断是否为标识符/关键字字节（含非 ASCII，SQLite 标识符允许 UTF-8）。
func isWordByte(c byte) bool {
	if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' {
		return true
	}
	return c == '_' || c == '$' || c >= 0x80
}

// observeIdent 记录标识符位置上的保留列与引擎内建标识符。
//
// 注意：引号形态（`"rowid"` / `[rowid]` / “ `rowid` “）与裸词走的是同一个入口
// ——SQLite 对这三者一视同仁地解析成同一个标识符，闸门也必须一视同仁
// （实测 `SELECT "rowid" AS x FROM items` 与裸词一样能读回平台主键）。
func (s *sqlScan) observeIdent(ident string) {
	if isReservedIdentifier(ident) {
		s.mentionReserved = true
		if s.reservedIdent == "" {
			s.reservedIdent = ident
		}
	}
	if s.internalIdent == "" && (hasInternalPrefix(ident) || hasPragmaPrefix(ident)) {
		s.internalIdent = ident
	}
	if s.engineBuiltin == "" && isEngineBuiltinIdentifier(ident) {
		s.engineBuiltin = ident
	}
}

// hasInternalPrefix 判断标识符是否落在 SQLite 保留的 `sqlite_` 前缀里
// （表名/内部虚拟表都算；实测 sqlite_dbpage 可写、sqlite_master 只读）。
func hasInternalPrefix(ident string) bool {
	return hasPrefixFold(ident, "sqlite_")
}

// hasPragmaPrefix 判断标识符是否是 PRAGMA 表值函数（`pragma_*`）。
func hasPragmaPrefix(ident string) bool {
	return hasPrefixFold(ident, "pragma_")
}

func hasPrefixFold(s, prefix string) bool {
	return len(s) >= len(prefix) && strings.EqualFold(s[:len(prefix)], prefix)
}

// withKeyword 是 CTE 的入口关键字（词级判定的比较对象）。
const withKeyword = "WITH"

// reservedIdentifierAliases 是平台保留列 `_row_id` 在 SQLite 里的**内建别名**（§5.2）。
//
// 为什么必须一起拒（审计 P1-1 实测）：
//   - `SELECT rowid AS x FROM items` ⇒ `cols=[x] rows=[[1]]`：结果列名是 `x`，
//     而结果投影只能按**输出列名**剥离 ⇒ 平台主键值原样回到应用；
//   - `INSERT INTO items(rowid, title, amount) VALUES (4242, …)` ⇒ 库内 `_row_id = 4242`
//     且 `sqlite_sequence.seq` 被推进（平台"应用不指定主键"的意图被绕开）；
//   - `UPDATE items SET rowid = 7777 WHERE …` ⇒ 成功改写平台主键。
//
// 词边界精确匹配：`my_rowid`、`rowid_x`、`_row_id` 之外的相似名一律放行（§5.2 要求不误杀）。
var reservedIdentifierAliases = []string{"rowid", "_rowid_", "oid"}

// isReservedIdentifier 判断一个**完整标识符**是否为平台保留列或其 SQLite 别名。
// 闸门（observeIdent）与结果投影（projectColumns）共用同一判据，避免两处口径漂移。
func isReservedIdentifier(ident string) bool {
	if isReservedRowID(ident) {
		return true
	}
	for _, alias := range reservedIdentifierAliases {
		if strings.EqualFold(ident, alias) {
			return true
		}
	}
	return false
}

// isReservedRowID 判断一个标识符是否为保留列本身（`_row_id`）。
// 单独留一支：文案与 define.go 的"平台会为你追加这一列"提示需要区分它与别名。
func isReservedRowID(ident string) bool {
	return strings.EqualFold(ident, limits.ReservedRowIDColumn)
}

// engineBuiltinIdentifiers 是"应用可用标识符面"的**显式拒绝集**（§5.1 能力清单的补集）。
//
// 为什么是显式清单而不是前缀规则（审计 P2-1）：按前缀拦只覆盖 `sqlite_` / `pragma_`，
// 而引擎里还有**非前缀**的同族对象 —— 实测 `SELECT * FROM dbstat` 直接给本应用库的
// 对象名与页映射（含平台自建的 `sqlite_sequence`），`load_extension` 也过闸门。
// 前缀规则在这里必然漏，因此：
//
//	**新增引擎内建对象名（虚表模块 / 有宿主语义的函数）必须进本清单**，
//	对应的门禁用例是 sqlgate_test.go 的 TestEngineBuiltinDenyListCoversAuditSurface。
//
// 清单内容来自对 `pragma_module_list` / `pragma_function_list` 的实测枚举
// （审计枚举 9 个可用虚表模块，其中只有 dbstat 是非前缀可达的）：
//   - 9 个虚表模块：dbstat / fts5 / fts5vocab / geopoly / rtree / rtree_i32 /
//     sqlite_dbpage / pragma_module_list / pragma_table_info
//     （后三者已被 sqlite_ / pragma_ 前缀拦下，这里再显式列一遍，防前缀判定被改坏）；
//   - 扩展加载入口与 SQLite shell 的文件语义函数：load_extension / readfile /
//     writefile / lsdir / fsdir / edit（后三者在平台构建里不存在，属纵深）。
var engineBuiltinIdentifiers = []string{
	"sqlite_dbpage",
	"sqlite_master",
	"sqlite_schema",
	"sqlite_temp_master",
	"sqlite_temp_schema",
	"dbstat",
	"fts5",
	"fts5vocab",
	"geopoly",
	"rtree",
	"rtree_i32",
	"pragma_module_list",
	"pragma_table_info",
	"pragma_table_list",
	"pragma_pragma_list",
	"pragma_function_list",
	"pragma_database_list",
	"pragma_max_page_count",
	"load_extension",
	"readfile",
	"writefile",
	"lsdir",
	"fsdir",
	"edit",
}

// isEngineBuiltinIdentifier 判断标识符是否命中显式拒绝集（大小写不敏感、整词相等）。
func isEngineBuiltinIdentifier(ident string) bool {
	for _, name := range engineBuiltinIdentifiers {
		if strings.EqualFold(ident, name) {
			return true
		}
	}
	return false
}
