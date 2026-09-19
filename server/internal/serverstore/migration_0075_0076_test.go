package serverstore

// 0075（打开计数：明细 + 日汇总）与 0076（usage 应用维度归因）的回归。
//
// 手法与 migration_0071_test.go 一致：先只应用到 00NN-1 造"升级前"的库，再应用目标
// 迁移，逐条断言。这两条迁移最容易出事的地方是**表结构细节**（主键列集、哨兵值、
// 传播到分区），而不是数据改写 —— 所以断言落在 information_schema 与真实读写上。
//
// 变异验证：
//   - 把 0075 的主键改成 (app_id, day) ⇒ TestMigration0075... 的主键断言红；
//   - 把 dept_id 在汇总表上改成可空 / 去掉 COALESCE ⇒ 聚合用例红（NULL 不进主键）；
//   - 把 0076 的 app_id 列去掉缺省 / 改成可空 ⇒ TestMigration0076 红；
//   - 把 0076 的 ADD COLUMN 改成只对主表生效而分区不传播（PG 自动传播，改成分区级
//     ALTER 才会红）⇒ 分区行写 app_id 的用例红。

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// applyPreThen 先应用 <= before 的迁移建出"升级前"的库，返回目标迁移。
func applyPreThen(t *testing.T, before int) []migration {
	t.Helper()
	all := migrationsFor()
	var pre, post []migration
	for _, m := range all {
		if m.version <= before {
			pre = append(pre, m)
		}
		if m.version == before+1 {
			post = append(post, m)
		}
	}
	if len(post) != 1 {
		t.Fatalf("找不到 %d 的迁移（got %d 条）", before+1, len(post))
	}
	// 必须先设置迁移集合再建库：否则会克隆"已迁移到最新"的模板库。
	testMigrationHook = func() []migration { return pre }
	t.Cleanup(func() { testMigrationHook = nil })
	return post
}

func TestMigration0075CreatesOpenCountTables(t *testing.T) {
	post := applyPreThen(t, 74)
	db, cleanup := newTestDB(t)
	defer cleanup()

	// 升级前：两张表都不存在（先证明"这个用例真的在测迁移"，而不是测已建好的库）。
	if tableExists(t, db, "wasm_app_opens") || tableExists(t, db, "wasm_app_opens_daily") {
		t.Fatal("前置条件失败：0074 时不该有打开计数表")
	}

	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0075: %v", err)
	}
	if !tableExists(t, db, "wasm_app_opens") || !tableExists(t, db, "wasm_app_opens_daily") {
		t.Fatal("0075 之后两张表都必须存在")
	}
	// 主键必须是 (app_id, day, dept_id)：少了 dept_id 就会退化成"每天一行"
	// （丢部门维度），而运行期 upsert 仍能跑通 —— 静默退化只能靠结构断言拦住。
	if got := primaryKeyColumns(t, db, "wasm_app_opens_daily"); got != "app_id,day,dept_id" {
		t.Fatalf("日汇总主键 = %q, want app_id,day,dept_id", got)
	}
	// 明细表的 dept_id 必须**可空**（设计 §8.9：无部门记 NULL）。
	if !columnNullable(t, db, "wasm_app_opens", "dept_id") {
		t.Fatal("wasm_app_opens.dept_id 必须可空（无部门 = NULL）")
	}
	// 汇总表的 dept_id 必须 NOT NULL（主键列，0 = 无部门哨兵）。
	if columnNullable(t, db, "wasm_app_opens_daily", "dept_id") {
		t.Fatal("wasm_app_opens_daily.dept_id 必须 NOT NULL（0 = 无部门哨兵）")
	}

	// 真实读写（**全部显式给时刻**，否则会落进"今天"那个 UTC 日，断言不可复现）：
	//   部门 7：用户 1 打开一次
	//   无部门：用户 1 与用户 2 各一次
	ctx := context.Background()
	day := time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC)
	dept := int64(7)
	if err := RecordWasmAppOpen(ctx, db, WasmAppOpen{
		AppID: "notes", UserID: 1, DeptID: &dept, ClientVersion: "1.0.0", At: day.Add(2 * time.Hour)}); err != nil {
		t.Fatalf("写明细: %v", err)
	}
	if err := RecordWasmAppOpen(ctx, db, WasmAppOpen{AppID: "notes", UserID: 1, At: day.Add(3 * time.Hour)}); err != nil {
		t.Fatalf("写明细: %v", err)
	}
	// 无部门（NULL）行也会 COALESCE 成 0，不得出现"NULL 行 + 0 行"两份。
	if err := RecordWasmAppOpen(ctx, db, WasmAppOpen{AppID: "notes", UserID: 2, At: day.Add(4 * time.Hour)}); err != nil {
		t.Fatalf("写明细: %v", err)
	}
	if _, err := AggregateWasmAppOpens(ctx, db, day, day); err != nil {
		t.Fatalf("汇总: %v", err)
	}
	series, err := QueryWasmAppOpens(ctx, db, WasmOpenQuery{AppID: "notes", From: day, To: day, Granularity: "day"})
	if err != nil {
		t.Fatalf("查询: %v", err)
	}
	if series.TotalPV != 3 || series.TotalUV != 3 {
		t.Fatalf("区间合计 = pv %d uv %d, want 3/3（部门 7: pv1/uv1 + 无部门: pv2/uv2）",
			series.TotalPV, series.TotalUV)
	}
	byDept := map[int64]WasmOpenPoint{}
	for _, p := range series.Points {
		byDept[p.DeptID] = p
	}
	if p, ok := byDept[0]; !ok || p.PV != 2 || p.UV != 2 {
		t.Fatalf("无部门应聚成 dept_id=0 的 pv2/uv2 一行: %+v", series.Points)
	}
	if p, ok := byDept[7]; !ok || p.PV != 1 || p.UV != 1 {
		t.Fatalf("部门 7 应聚成 pv1/uv1 一行: %+v", series.Points)
	}
	// 幂等：重复汇总不得翻倍（DO UPDATE 而非累加）。
	if _, err := AggregateWasmAppOpens(ctx, db, day, day); err != nil {
		t.Fatalf("重复汇总: %v", err)
	}
	again, _ := QueryWasmAppOpens(ctx, db, WasmOpenQuery{AppID: "notes", From: day, To: day})
	if again.TotalPV != 3 {
		t.Fatalf("重复汇总后 pv = %d, want 3（必须幂等：upsert 覆盖而不是累加）", again.TotalPV)
	}
	// 清理只删过期明细，日汇总**长期保留**（趋势不能因为明细过期而断档）。
	deleted, err := PurgeWasmAppOpens(ctx, db, day.Add(24*time.Hour))
	if err != nil {
		t.Fatalf("清理: %v", err)
	}
	if deleted != 3 {
		t.Fatalf("清理行数 = %d, want 3", deleted)
	}
	after, _ := QueryWasmAppOpens(ctx, db, WasmOpenQuery{AppID: "notes", From: day, To: day})
	if after.TotalPV != 3 {
		t.Fatalf("清理明细后日汇总必须仍在（pv = %d, want 3）", after.TotalPV)
	}
	// 幂等重放：再执行一次 0075 的 SQL 不得报错。
	if _, err := db.Exec(post[0].sql); err != nil {
		t.Fatalf("重放 0075: %v", err)
	}
}

// TestMigration0075SplitsUsersByDeptOnSameDay 钉住"用户当天换部门 ⇒ 两个部门行"的
// 冻结口径（§8.9）：同一用户同一天在两个部门各算一次 UV。
func TestMigration0075SplitsUsersByDeptOnSameDay(t *testing.T) {
	// 本用例只关心聚合口径，不需要"升级前"的库：直接把全部迁移跑完即可
	// （testMigrationHook 留 nil = 走内嵌的完整迁移集合）。
	db, cleanup := newTestDB(t)
	defer cleanup()
	ctx := context.Background()
	day := time.Date(2026, 9, 19, 0, 0, 0, 0, time.UTC)
	deptA, deptB := int64(3), int64(4)
	for _, d := range []*int64{&deptA, &deptB} {
		if err := RecordWasmAppOpen(ctx, db, WasmAppOpen{AppID: "notes", UserID: 9, DeptID: d, At: day.Add(time.Hour)}); err != nil {
			t.Fatalf("写明细: %v", err)
		}
	}
	if _, err := AggregateWasmAppOpens(ctx, db, day, day); err != nil {
		t.Fatalf("汇总: %v", err)
	}
	series, err := QueryWasmAppOpens(ctx, db, WasmOpenQuery{AppID: "notes", From: day, To: day, Granularity: "dept"})
	if err != nil {
		t.Fatalf("按部门查询: %v", err)
	}
	if len(series.Points) != 2 {
		t.Fatalf("换部门的同一天应有两行（每部门一行）: %+v", series.Points)
	}
	for _, p := range series.Points {
		if p.PV != 1 || p.UV != 1 {
			t.Fatalf("每个部门行 = pv1/uv1，得到 %+v", p)
		}
	}
}

func TestMigration0076AddsUsageAppDimension(t *testing.T) {
	post := applyPreThen(t, 75)
	db, cleanup := newTestDB(t)
	defer cleanup()

	// 升级前：列不存在。
	if columnExists(t, db, "usage", "app_id") {
		t.Fatal("前置条件失败：0075 时不该有 usage.app_id")
	}
	testMigrationHook = func() []migration { return post }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("应用 0076: %v", err)
	}
	if !columnExists(t, db, "usage", "app_id") {
		t.Fatal("0076 之后 usage.app_id 必须存在")
	}
	if columnNullable(t, db, "usage", "app_id") {
		t.Fatal("usage.app_id 必须 NOT NULL（空串 = 无归因）")
	}

	// 归因标签的收窄校验：非法值一律记空串（best-effort，绝不影响计费）。
	cases := map[string]string{
		"notes":     "notes",
		" Notes ":   "notes",
		"a--b":      "",
		"-x":        "",
		"x-":        "",
		"a":         "",
		"":          "",
		"UPPER":     "upper",
		"has space": "",
		"sec-ch-ua": "sec-ch-ua",
		"<script>":  "",
		"严重越界-标签":   "",
	}
	for in, want := range cases {
		if got := SanitizeUsageAppID(in); got != want {
			t.Errorf("SanitizeUsageAppID(%q) = %q, want %q", in, got, want)
		}
	}

	// 真实写路径：usage 落账（分区表）→ 归因 UPDATE 生效；空标签不发 UPDATE。
	uid := createUsageTestUser(t, db, "u-attr")
	id, err := RecordUsageKind(db, uid, "demo-model", 10, 5, "chat")
	if err != nil {
		t.Fatalf("落 usage: %v", err)
	}
	if err := SetUsageAppID(db, id, "notes"); err != nil {
		t.Fatalf("归因: %v", err)
	}
	var got string
	if err := db.QueryRow(`SELECT app_id FROM usage WHERE id = ?`, id).Scan(&got); err != nil {
		t.Fatalf("读回 app_id: %v", err)
	}
	if got != "notes" {
		t.Fatalf("usage.app_id = %q, want notes", got)
	}
	// 幂等重放 0076。
	if _, err := db.Exec(post[0].sql); err != nil {
		t.Fatalf("重放 0076: %v", err)
	}
	// 重复归因（模拟流式 pending 行 + 结算后再绑）不报错、值仍正确。
	if err := SetUsageAppID(db, id, "notes"); err != nil {
		t.Fatalf("重复归因: %v", err)
	}
}

// ---- 小工具 ----

func tableExists(t *testing.T, db *sql.DB, table string) bool {
	t.Helper()
	var ok bool
	if err := db.QueryRow(`SELECT to_regclass($1) IS NOT NULL`, "public."+table).Scan(&ok); err != nil {
		t.Fatalf("查表 %s: %v", table, err)
	}
	return ok
}

func columnNullable(t *testing.T, db *sql.DB, table, column string) bool {
	t.Helper()
	var nullable string
	if err := db.QueryRow(`SELECT is_nullable FROM information_schema.columns
		WHERE table_name = ? AND column_name = ?`, table, column).Scan(&nullable); err != nil {
		t.Fatalf("查列 %s.%s: %v", table, column, err)
	}
	return nullable == "YES"
}

func primaryKeyColumns(t *testing.T, db *sql.DB, table string) string {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
		FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
		WHERE i.indrelid = $1::regclass AND i.indisprimary`, "public."+table).Scan(&got); err != nil {
		t.Fatalf("查主键 %s: %v", table, err)
	}
	return got
}

// createUsageTestUser 建一个能落 usage 行的用户（RecordUsageKind 有 FK）。
func createUsageTestUser(t *testing.T, db *sql.DB, name string) int64 {
	t.Helper()
	id, err := CreateUser(db, &User{Username: name, Source: "local", Status: 1, Role: RoleUser})
	if err != nil {
		t.Fatalf("建用户 %s: %v", name, err)
	}
	return id
}
