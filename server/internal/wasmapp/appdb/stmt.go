package appdb

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件实现 §5.1 的 `db.query`（单条 SELECT，只读连接）与 `db.exec`（单条写语句）。
//
// 两个原语的语句种类是**互斥**的：db.query 只跑 SELECT，db.exec 只跑 INSERT/UPDATE/DELETE。
// 这条区分是多语句闸门的价值所在（§4.5：「多语句让 db.query/db.exec 区分形同虚设」），
// 所以种类不匹配时直接拒，而不是「反正 SQLite 会报错」。

// Query 执行单条 SELECT。实现 capapi.DB。
//
// 并发语义（2026-09-19）：读走**只读连接池**，语句执行期间不持任何锁 ⇒ 同一应用的
// 多个读可以真正并发（WAL 下也不与写者互斥）。事务内、连接被污染、连接正在重建这三种
// 情况退化到 withSerialConn（串行，语义与改造前一致）。
func (d *DB) Query(ctx context.Context, p abi.SQLParams) (abi.QueryResult, error) {
	// 闸门与参数规整是纯 CPU 动作，放在取连接之前（不占槽、不占锁）。
	if _, err := checkStatement(p.SQL, kindSelect); err != nil {
		return abi.QueryResult{}, err
	}
	args, appErr := normalizeArgs(p.Args)
	if appErr != nil {
		return abi.QueryResult{}, appErr
	}

	var out abi.QueryResult
	err := d.withReadConn(ctx, func(conn *sql.Conn) error {
		cctx, cancel := d.stmtContext(ctx)
		defer cancel()
		rows, err := conn.QueryContext(cctx, p.SQL, args...)
		if err != nil {
			return d.mapStmtError(cctx, err)
		}
		defer rows.Close()

		cols, err := rows.Columns()
		if err != nil {
			return d.mapStmtError(cctx, err)
		}
		// 结果投影：剥掉平台保留列 `_row_id`（§5.2）与它的 SQLite 别名。
		//
		// 为什么在**结果投影层**剥，而不是改写 SQL：
		//  1. §5.2 的字面语义是「应用看不到 `_row_id`」——「提到即拒」是手段、挡不住
		//     `SELECT *`（它会把这列带回来），所以目的要在这里兜住；
		//  2. 只在投影层剥 ⇒ 完全不影响写语句的列数语义：`INSERT INTO b SELECT * FROM a`
		//     走 db.exec 路径，根本不经过这里（剥离不是改写 SQL，列的物理顺序也不动）；
		//  3. 应用 SQL 里已不可能出现 `_row_id` 或其别名（checkStatement 的 reserved_column
		//     闸门，含 `rowid AS x` / `"rowid"` / `[rowid]` / `` `rowid` `` 全部形态），
		//     所以结果里出现的这些名字必然是平台列或老库里遗留的同名列。
		//
		// 判据与闸门共用 isReservedIdentifier（同一个集合，不允许两处口径漂移）：
		// 审计 P1-1 的绕过正是"闸门按名字拦、投影按名字剥"却用 `AS x` 把来源藏起来 ——
		// 现在闸门在进入驱动前就拒，投影这一层是纵深。
		//
		// 计量按**剥离后**的行/字节统计（否则应用看到的数字与实际拿到的结果不一致）。
		keep, projCols := projectColumns(cols)
		out = abi.QueryResult{Columns: projCols}
		// 扫描目标：**每个列一个 rawCell**（复用，不随行数增长），只接住驱动的原始值
		// （[]byte 不复制）；`[]any` 形态的 `ptrs` 也在这里一次分配（修复前每行一次）。
		cells := make([]rawCell, len(cols))
		cellPtrs := make([]any, len(cols))
		for i := range cells {
			cellPtrs[i] = &cells[i]
		}
		var totalBytes int64
		truncated := false
		for rows.Next() {
			if len(out.Rows) >= limits.SQLMaxRows {
				// 行数超限：截断并标记。
				//
				// **对 §4.5 的有意偏离（设计一致性报告 D6）**：§4.5/§7.4 的原话是
				// 「超出即截断并报错」，这里只置 `truncated=true` 而**不返回错误码**。
				// 取舍理由：分页读取必须可行 —— 「超限即 507/403」会让"表里超过 5000 行"
				// 变成一个应用无法处理的状态（连第一页都拿不到），而分页正是设计推荐的
				// 大数据读法（§4.5「数据导出请用 db.query 分页读取」）。
				// 因此失败语义由**显式标志**表达：Truncated 一定随 QueryResult 进 RPC 结果体
				// （abi.QueryResult.Truncated，应用侧可见），绝不静默；文档侧待与设计同步。
				truncated = true
				break
			}
			if err := rows.Scan(cellPtrs...); err != nil {
				return d.mapStmtError(cctx, err)
			}
			// **预算在复制之前**（2026-09-23 审计 WDB-1，P1）：修复前是
			// "整行 []any 物化 + 每个 []byte 转一次 string" **之后**才比上限，于是
			// `SELECT zeroblob(1048576) ×128`（单行 128 MiB，SQLITE_LIMIT_COLUMN×
			// SQLITE_LIMIT_LENGTH 的上界）实测一次查询分配 **384 MiB**（8 MiB 上限的
			// 48 倍）、耗时 446 ms，而应用侧收益为零（0 行 + Truncated）。现在只按
			// **原始长度**累加（rawCell.n，零复制），超预算立刻停手；`[]byte→string`
			// 只在"这行确实要留下"时发生（每行最多 8 MiB，与上限同阶）。
			var rowBytes int64
			for _, i := range keep {
				rowBytes += int64(cells[i].n)
			}
			if rowBytes > limits.SQLMaxResultBytes-totalBytes {
				// 单行就吃掉整份结果预算 ⇒ 应用拿不到任何数据（0 行 + Truncated 从来
				// 不是有用的结果），而这正是"纯放大型查询"的形态。给一条可操作的
				// 结构化错误（DB_LIMIT，§7.4 的"行数/结果超限"档），而不是静默空结果。
				if len(out.Rows) == 0 {
					return queryResultTooLarge(rowBytes, len(keep))
				}
				truncated = true
				break
			}
			row := make([]any, 0, len(keep))
			for _, i := range keep {
				row = append(row, cells[i].value())
			}
			out.Rows = append(out.Rows, row)
			totalBytes += rowBytes
		}
		if err := rows.Err(); err != nil {
			// 超时/取消在这里体现（驱动在 ctx 到期时自行 sqlite3_interrupt，实测 ~5 s 准时中断）。
			return d.mapStmtError(cctx, err)
		}
		out.Truncated = truncated
		d.rows.Add(int64(len(out.Rows)))
		d.bytes.Add(totalBytes)
		return nil
	})
	if err != nil {
		return abi.QueryResult{}, err
	}
	return out, nil
}

// projectColumns 计算结果投影：返回要保留的列下标与列名，剥掉平台保留列（§5.2）。
//
// 只返回下标、不改行内容：调用方按 keep 组装每行，保证 Columns 与 Rows 严格同步。
// 只剥保留列时返回**非 nil** 空切片（JSON 序列化成 []，而不是 null）。
func projectColumns(cols []string) (keep []int, projected []string) {
	keep = make([]int, 0, len(cols))
	projected = make([]string, 0, len(cols))
	for i, name := range cols {
		if isReservedIdentifier(name) {
			continue
		}
		keep = append(keep, i)
		projected = append(projected, name)
	}
	return keep, projected
}

// Exec 执行单条写语句（仅 INSERT/UPDATE/DELETE）。实现 capapi.DB。
//
// 写永远是串行的：整条语句在 writeMu 下执行（同一时刻只有一条语句能碰读写连接），
// 与改造前的"一次一条语句"语义一致；变的是**读不再被写挡住**（读走只读连接池）。
func (d *DB) Exec(ctx context.Context, p abi.SQLParams) (abi.ExecResult, error) {
	if _, err := checkStatement(p.SQL, kindInsert, kindUpdate, kindDelete); err != nil {
		return abi.ExecResult{}, err
	}
	args, appErr := normalizeArgs(p.Args)
	if appErr != nil {
		return abi.ExecResult{}, appErr
	}
	var out abi.ExecResult
	err := d.withSerialConn(ctx, false, func(conn *sql.Conn) error {
		cctx, cancel := d.stmtContext(ctx)
		defer cancel()
		res, err := conn.ExecContext(cctx, p.SQL, args...)
		if err != nil {
			return d.mapStmtError(cctx, err)
		}
		n, err := res.RowsAffected()
		if err != nil {
			// 写已生效；拿不到行数不应把成功报成失败。
			out = abi.ExecResult{RowsAffected: 0}
			return nil
		}
		out = abi.ExecResult{RowsAffected: n}
		return nil
	})
	if err != nil {
		return abi.ExecResult{}, err
	}
	return out, nil
}

// normalizeArgs 校验绑定参数类型。
//
// 参数由 guest 经 JSON 传入（runtime 解成 any），因此实际只可能是
// nil/string/bool/float64（或 json.Number）；对象/数组一律拒，避免把
// 「驱动内部错误」暴露成不可读的 500。
func normalizeArgs(args []any) ([]any, *apperr.Error) {
	if len(args) == 0 {
		return nil, nil
	}
	if len(args) > limits.SQLLimitVariableNumber {
		return nil, denied("too_many_args",
			fmt.Sprintf("绑定参数个数超过上限 %d（收到 %d 个）", limits.SQLLimitVariableNumber, len(args))).
			WithDetail("limit", limits.SQLLimitVariableNumber).
			WithDetail("got", len(args))
	}
	out := make([]any, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case nil:
			out[i] = nil
		case string:
			out[i] = v
		case bool:
			out[i] = v
		case int:
			out[i] = int64(v)
		case int32:
			out[i] = int64(v)
		case int64:
			out[i] = v
		case float32:
			out[i] = float64(v)
		case float64:
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return nil, denied("unsupported_arg_type",
					fmt.Sprintf("第 %d 个参数是 NaN/Inf，SQLite 不接受", i+1)).
					WithDetail("index", i)
			}
			out[i] = v
		case json.Number:
			if n, err := v.Int64(); err == nil {
				out[i] = n
			} else if f, err := v.Float64(); err == nil {
				out[i] = f
			} else {
				return nil, denied("unsupported_arg_type",
					fmt.Sprintf("第 %d 个参数不是合法数字", i+1)).WithDetail("index", i)
			}
		default:
			return nil, denied("unsupported_arg_type",
				fmt.Sprintf("第 %d 个参数类型不支持：只允许 string/number/bool/null（参数化查询请用占位符 ?）", i+1)).
				WithDetail("index", i).
				WithDetail("type", fmt.Sprintf("%T", a))
		}
	}
	return out, nil
}

// normalizeValue 把驱动返回值规整成 ABI 友好的 JSON 值。
// 结果计量口径（**唯一一份**）：一个值进响应后的字节数。
//
// 修复前是 `normalizeValue`（先 []byte→string 复制，再 valueBytes 计量）两步；
// 现在由 rawCell（扫描期，零复制）与 valueBytes（测试侧独立复算）共用这三个常量
// 与同一条 switch —— 两边漂移会让"预算"与"实测"对不上，所以口径必须同源。
const (
	bytesOfNull   = 4 // "null"
	bytesOfBool   = 5 // "false"
	bytesOfNumber = 8 // int64 / float64 的十进制上界估计（与旧口径逐字一致）
)

// valueBytes 估算一个返回值在响应里的字节数（用于 8 MiB 返回上限的计量）。
//
// ⚠️ 生产路径不再调用它（`Query` 在扫描期就用 rawCell.n 累加，见 rawCell 的长注释）；
// 保留它是**计量口径的第二实现**，供测试独立复算"返回字节数 ≤ 上限"这条不变量。
func valueBytes(v any) int64 {
	switch t := v.(type) {
	case nil:
		return bytesOfNull
	case string:
		return int64(len(t))
	case bool:
		return bytesOfBool
	default:
		return bytesOfNumber
	}
}

// ===== 结果预算（WDB-1，2026-09-23）=====

// rawCell 是"按原始形态接住一列"的扫描目标。
//
// 存在的理由（审计 WDB-1）：结果预算是 **8 MiB**，而修复前每个值都要先
// `[]byte → string` 复制一份才轮到预算判定，于是"合法上限输入"（128 列 × 1 MiB
// zeroblob）能换出 384 MiB 宿主分配（3× 于数据本身），而应用侧 0 收益。
// 这里把 []byte 原样挂在 bin 上（**不复制**），复制推迟到 value()，即"这一行确实
// 要进结果"之后。其余类型的归一化口径与修复前的 normalizeValue 逐字相同
// （time.Time → UTC/RFC3339Nano；nil/bool/数值按上面的常量计量）。
type rawCell struct {
	// other 是非 []byte 列的原始值（nil / string / int64 / float64 / bool / time.Time
	// 归一化后的 string）。
	other any
	// bin 是 []byte 列的原始字节（与驱动内部缓冲共享；只在本次 rows.Next() 有效）。
	bin []byte
	// n 是该列在响应里的字节数（与 valueBytes 同口径），供预算累加。
	n int
}

// Scan 实现 sql.Scanner：接住驱动给的原始值，**不做任何复制**。
func (c *rawCell) Scan(src any) error {
	switch t := src.(type) {
	case []byte:
		c.bin, c.other, c.n = t, nil, len(t)
	case string:
		c.bin, c.other, c.n = nil, t, len(t)
	case nil:
		c.bin, c.other, c.n = nil, nil, bytesOfNull
	case time.Time:
		// 与旧 normalizeValue 同口径（UTC + RFC3339Nano）；字符串长度就是计量。
		s := t.UTC().Format(time.RFC3339Nano)
		c.bin, c.other, c.n = nil, s, len(s)
	case bool:
		c.bin, c.other, c.n = nil, t, bytesOfBool
	default:
		// int64 / float64（以及驱动将来可能新增的数值类型）。
		c.bin, c.other, c.n = nil, t, bytesOfNumber
	}
	return nil
}

// value 返回该列进结果时的值：唯一一处 `[]byte → string` 复制。
func (c *rawCell) value() any {
	if c.bin != nil {
		return string(c.bin)
	}
	return c.other
}

// queryResultTooLarge 是"单行就超过整份结果预算"的结构化错误。
//
// 码用**既有的** DB_LIMIT（§7.4 的"行数/结果超限"档，与 §4.5 同源），不新增码：
// 它是 `details.reason` 区分具体病因。语义比"0 行 + Truncated"强 —— 后者让应用
// 完全无从判断"是我查错了还是结果太大"。
func queryResultTooLarge(rowBytes int64, columns int) *apperr.Error {
	return apperr.Newf(apperr.CodeDBLimit,
		"单行结果 %d 字节超过整份结果上限 %d 字节（无法返回任何行）", rowBytes, limits.SQLMaxResultBytes).
		WithDetail("reason", "result_too_large").
		WithDetail("row_bytes", rowBytes).
		WithDetail("max", limits.SQLMaxResultBytes).
		WithDetail("columns", columns).
		WithHint("把大列从结果里去掉（别用 SELECT *），只取需要的列或子串（substr）").
		WithHint("按主键/时间分页读取（LIMIT/OFFSET），或让 SQL 侧做聚合/统计")
}
