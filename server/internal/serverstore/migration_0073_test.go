package serverstore

import (
	"database/sql"
	"strings"
	"testing"
)

// 0073 回归（WASM「客户端专属」改造 · W4-1）：**删除旧访问模型的两张会话表**。
//
// 判据（对应 L7 清单 W4-1 与总纲 §9 的验收 SQL）：
//
//	① 迁移前两张表**确实存在**（先证明这个用例真的在测迁移，而不是测一个本来就没有的库）；
//	② 迁移后 `to_regclass('public.app_sessions') IS NULL`
//	   **且** `to_regclass('public.employee_sessions') IS NULL`（设计 §9 的验收 SQL 逐字）；
//	③ **幂等**：同一条 SQL 再执行一次不报错、库内其它对象逐字节不变；
//	④ **不误伤**：名字相邻/相近的表（`app_sessions_archive`、`employee_session_log`）
//	   与其它业务表必须原样保留 —— `DROP TABLE IF EXISTS` 写成通配或顺序颠倒
//	   （先删被引用方）都会在这里露馅；
//	⑤ **顺序不可颠倒**：先删 `employee_sessions` 必须失败（外键依赖），
//	   这条是"顺序"这个要求的机器判据（只在"先删被引用方"时才有意义）。
//
// 手法与 migration_0074_test.go 一致：先只应用到 0072 造"升级前"的库，再应用 0073。
func TestMigration0073DropsLegacySessionTables(t *testing.T) {
	post := applyPreThen(t, 72)
	db, cleanup := newTestDB(t)
	defer cleanup()

	// --- 1) 前置条件：这是"升级前"的库，两张表都在 ---
	for _, table := range []string{"employee_sessions", "app_sessions"} {
		if !tableExists(t, db, table) {
			t.Fatalf("前置条件失败：0072 时 %s 应当存在（旧模型的两张会话表）", table)
		}
	}

	// --- 2) 不误伤夹具：名字相邻/相近的表 ---
	// 它们不属于本迁移的对象；`DROP TABLE IF EXISTS` 的名字写错（少写/多写/通配）
	// 或实现改成"按前缀扫"都会把它们带走。
	for _, table := range []string{"app_sessions_archive", "employee_session_log"} {
		if _, err := db.Exec(`CREATE TABLE ` + table + ` (id BIGINT PRIMARY KEY, note TEXT)`); err != nil {
			t.Fatalf("建旁证表 %s: %v", table, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO app_sessions_archive (id, note) VALUES (1, '旁证')`); err != nil {
		t.Fatalf("写旁证行: %v", err)
	}

	// --- 3) 顺序不可颠倒：先删被引用方必须失败（app_sessions → employee_sessions 有外键） ---
	if _, err := db.Exec(`DROP TABLE IF EXISTS employee_sessions`); err == nil {
		t.Fatal("先删 employee_sessions 竟然成功了 —— 说明外键依赖已不存在，" +
			"「先 app 后 employee」这条顺序要求失去了机器判据（请核对 0070 的外键定义）")
	}

	// --- 4) 应用 0073 ---
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0073: %v", err)
	}

	// --- 5) 验收 SQL（设计 §9 逐字） ---
	var gone bool
	if err := db.QueryRow(`SELECT to_regclass('public.app_sessions') IS NULL
		AND to_regclass('public.employee_sessions') IS NULL`).Scan(&gone); err != nil {
		t.Fatalf("验收 SQL: %v", err)
	}
	if !gone {
		t.Fatal("升级后 app_sessions / employee_sessions 必须都不存在（§9 的验收 SQL）")
	}

	// --- 6) 不误伤：旁证表与旁证行必须在 ---
	for _, table := range []string{"app_sessions_archive", "employee_session_log"} {
		if !tableExists(t, db, table) {
			t.Fatalf("旁证表 %s 被迁移误删（DROP 的名字写错了）", table)
		}
	}
	var note string
	if err := db.QueryRow(`SELECT note FROM app_sessions_archive WHERE id = 1`).Scan(&note); err != nil {
		t.Fatalf("旁证行被误删: %v", err)
	}
	if note != "旁证" {
		t.Fatalf("旁证行内容被改: %q", note)
	}
	// 旧模型的其它持久面（apps / app_releases / users）一张都不能少。
	for _, table := range []string{"apps", "app_releases", "users", "wasm_call_events"} {
		if !tableExists(t, db, table) {
			t.Fatalf("业务表 %s 被迁移误删", table)
		}
	}
	// 各表的列集也不得被动过（本迁移只 DROP 两张表）。
	if got := countColumns(t, db, "apps"); got == 0 {
		t.Fatal("apps 列集被清空")
	}

	// --- 7) 幂等：重放同一条 SQL，两遍都必须成功且库内对象计数不变 ---
	before := countUserTables(t, db)
	for i := 02; i > 0; i-- {
		if _, err := db.Exec(post[0].sql); err != nil {
			t.Fatalf("重放 0073（幂等要求可重放）第 %d 次: %v", 3-i, err)
		}
	}
	if after := countUserTables(t, db); after != before {
		t.Fatalf("重放 0073 改变了库内对象数：before=%d after=%d", before, after)
	}
	// 重放后验收 SQL 仍必须成立。
	if err := db.QueryRow(`SELECT to_regclass('public.app_sessions') IS NULL
		AND to_regclass('public.employee_sessions') IS NULL`).Scan(&gone); err != nil {
		t.Fatalf("重放后验收 SQL: %v", err)
	}
	if !gone {
		t.Fatal("重放后两张表又出现了")
	}
	// 自检：`lock_timeout` 必须在文件里（部署纪律：宁可快速失败也不要挂住部署）。
	if !hasLockTimeoutPragma(post[0].sql) {
		t.Fatal("0073 必须设 SET LOCAL lock_timeout（否则 DROP 会无声地卡住部署）")
	}
	if hasCascade(post[0].sql) {
		t.Fatal("0073 不得使用 CASCADE（有意的 fail-loud：万一有别的表引用，要报错停下）")
	}
}

// ---- 0073 用例的小工具 ----

// countColumns 返回某张表的列数（读 information_schema，不走 information_schema 缓存）。
func countColumns(t *testing.T, db *sql.DB, table string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = ?`, table).Scan(&n); err != nil {
		t.Fatalf("读 %s 列数: %v", table, err)
	}
	return n
}

// countUserTables 返回 public 下的用户表数量（幂等判据：重放不得改变它）。
func countUserTables(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM information_schema.tables
		WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).Scan(&n); err != nil {
		t.Fatalf("读表数量: %v", err)
	}
	return n
}

// hasLockTimeoutPragma 判定迁移 SQL 里是否设置了 lock_timeout。
func hasLockTimeoutPragma(sqlText string) bool {
	return strings.Contains(strings.ToLower(sqlText), "lock_timeout")
}

// hasCascade 判定迁移 SQL 里是否出现了 CASCADE（大小写不敏感）。
//
// ⚠️ 判据本身也要防"注释里写了 CASCADE 就当通过"：先剥掉 `--` 行注释再查。
func hasCascade(sqlText string) bool {
	for _, line := range strings.Split(sqlText, "\n") {
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		if strings.Contains(strings.ToLower(line), "cascade") {
			return true
		}
	}
	return false
}
