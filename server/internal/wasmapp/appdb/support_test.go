package appdb

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// sqliteLimitCurrent 读回某条连接上某个 SQLITE_LIMIT_* 的当前值
// （newVal = -1 是 sqlite3_limit 的「只查询」语义）。
func sqliteLimitCurrent(conn *sql.Conn, id int) (int, error) {
	return sqlite.Limit(conn, id, -1)
}

// limitsAttachedID 暴露 SQLITE_LIMIT_ATTACHED 常量给测试。
func limitsAttachedID() int { return sqlite3.SQLITE_LIMIT_ATTACHED }

// TestProjectReservedColumnsOnlyRowID 覆盖「结果里只有 _row_id 一列」的边界：
// 返回 Columns 空数组 + 每行空数组（不报错、也不返回「看起来有列」的结果）。
//
// 说明：应用侧无法真的查出「只有 _row_id」的结果集（提到即拒 + `SELECT *` 至少含一列应用列），
// 所以这条边界直接测投影逻辑本身。
func TestProjectReservedColumnsOnlyRowID(t *testing.T) {
	keep, cols := projectColumns([]string{limits.ReservedRowIDColumn})
	if len(keep) != 0 {
		t.Fatalf("只应剥掉保留列，实际 keep=%v", keep)
	}
	if len(cols) != 0 {
		t.Fatalf("列清单应为空，实际 %v", cols)
	}
	if cols == nil {
		t.Fatal("空列清单必须是非 nil 切片（JSON 要序列化成 []，不能是 null）")
	}
	// 混合列：保留列在中间。
	keep, cols = projectColumns([]string{"title", limits.ReservedRowIDColumn, "amount"})
	if len(keep) != 2 || keep[0] != 0 || keep[1] != 2 {
		t.Fatalf("投影下标错：%v", keep)
	}
	if strings.Join(cols, ",") != "title,amount" {
		t.Fatalf("投影列错：%v", cols)
	}
	// 大小写与限定名：SQLite 返回的列名就是声明的 `_row_id`，大小写不敏感处理。
	if keep, _ := projectColumns([]string{"_ROW_ID", "v"}); len(keep) != 1 || keep[0] != 1 {
		t.Fatalf("大小写不同的保留列也应剥掉：%v", keep)
	}
}

// mapStmtErrorLockedErrorForTest 用"已经到期的 ctx"在真实驱动路径上造一条
// statement_timeout 错误（真错误，不是构造串），供常量一致性断言使用。
func mapStmtErrorLockedErrorForTest(d *DB) *apperr.Error {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := d.mapStmtErrorLocked(ctx, context.Canceled)
	e, _ := apperr.As(err)
	return e
}
