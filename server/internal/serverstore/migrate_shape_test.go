package serverstore

// R6-A-3 判据（第六轮审计 2026-09-23，P2）：迁移目录加载时必须做**文件形状自检**
// 并 fail-loud，且**第二次启动也必须报错**。
//
// 缺陷形态（修复前）：`migrationsFor()` 对 `Atoi(前缀)` 失败的文件 `continue`，
// 而 `applied` 快照只读一次、只按版本号判：
//   - 版本号重复（`0082_a.sql` + `0082_b.sql`）⇒ 首次启动在
//     `INSERT INTO schema_migrations` 上撞主键（生产 = log.Fatalf），
//     **第二次启动返回 nil** —— applied 里已有 0082，两条一起被跳过 ⇒
//     后一条的 DDL 永不生效，且此后零日志零判据；
//   - 文件名不合规（`0082-badname.sql`）⇒ **从第一次启动起**静默跳过整条迁移。
//
// 三条判据：
//  1. 夹具目录（临时目录 + os.DirFS）造两种形态 ⇒ `loadMigrations` 返回错误且
//     文案**点名文件**（重复版本号要同时点名两个）；
//  2. 执行级：在真 PG 上"第一次启动成功、第二次启动（同一个库、applied 已有该
//     版本）必须报错" —— 证明形状自检与 applied 快照无关；
//  3. 反向：现有 73 个内置迁移零误报（按文件名规则、版本唯一且严格升序）。

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeMigrations 把 name → SQL 写进一个临时目录并返回 os.DirFS。
func writeMigrations(t *testing.T, files map[string]string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	for name, sql := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(sql), 0o600); err != nil {
			t.Fatalf("写夹具迁移 %s: %v", name, err)
		}
	}
	return dir, "."
}

func TestLoadMigrationsRejectsDuplicateVersion(t *testing.T) {
	dir, sub := writeMigrations(t, map[string]string{
		"0001_init.sql":   "CREATE TABLE r6s_dup_a (id INT);",
		"0082_first.sql":  "CREATE TABLE r6s_dup_x (id INT);",
		"0082_second.sql": "CREATE TABLE r6s_dup_y (id INT);",
	})
	_, err := loadMigrations(os.DirFS(dir), sub)
	if err == nil {
		t.Fatal("版本号重复必须报错（第二次启动会因 applied 快照把两条一起跳过）")
	}
	for _, want := range []string{"0082_first.sql", "0082_second.sql", "0082"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误文案未点名 %q（必须能直接定位冲突的两个文件）: %v", want, err)
		}
	}
}

func TestLoadMigrationsRejectsMalformedName(t *testing.T) {
	dir, sub := writeMigrations(t, map[string]string{
		"0001_init.sql":    "CREATE TABLE r6s_bad_a (id INT);",
		"0082-badname.sql": "CREATE TABLE r6s_bad_b (id INT);",
	})
	_, err := loadMigrations(os.DirFS(dir), sub)
	if err == nil {
		t.Fatal("文件名不合规必须报错（旧实现从第一次启动起静默跳过整条迁移）")
	}
	for _, want := range []string{"0082-badname.sql", "NNNN_name.sql"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误文案未点名 %q（要给出可行动的形状要求）: %v", want, err)
		}
	}
}

func TestLoadMigrationsRejectsDuplicateStem(t *testing.T) {
	dir, sub := writeMigrations(t, map[string]string{
		"0082_same_thing.sql": "CREATE TABLE r6s_stem_a (id INT);",
		"0083_same_thing.sql": "CREATE TABLE r6s_stem_b (id INT);",
	})
	_, err := loadMigrations(os.DirFS(dir), sub)
	if err == nil {
		t.Fatal("同一描述名配了不同版本号必须报错（通常是复制粘贴未改内容）")
	}
	for _, want := range []string{"0082_same_thing.sql", "0083_same_thing.sql", "same_thing"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误文案未点名 %q: %v", want, err)
		}
	}
}

// TestEmbeddedMigrationsPassShapeCheck 是反向判据：内置迁移集**零误报**，
// 且加载结果仍是"按版本严格升序、版本唯一"。
func TestEmbeddedMigrationsPassShapeCheck(t *testing.T) {
	ms, err := loadMigrations(migrationFS, "migrations-pg")
	if err != nil {
		t.Fatalf("内置迁移集被形状自检误判（会挡住所有部署）: %v", err)
	}
	if len(ms) == 0 {
		t.Fatal("内置迁移集为空（embed 失效）")
	}
	for i, m := range ms {
		if m.name == "" || m.sql == "" {
			t.Fatalf("第 %d 条迁移内容为空: %+v", i, m)
		}
		if i > 0 && ms[i-1].version >= m.version {
			t.Fatalf("版本未严格升序/出现重复: %d (%s) 之后是 %d (%s)",
				ms[i-1].version, ms[i-1].name, m.version, m.name)
		}
	}
	if got, want := int64(ms[len(ms)-1].version), latestMigration(); got != want {
		t.Fatalf("最新版本 = %d, want %d", got, want)
	}
}

// TestApplyMigrationsShapeCheckRunsOnEveryStartup 是执行级判据（真 PG）：
// 形状自检与 applied 快照无关 —— 第一次启动成功之后，用坏形状的加载器再跑一次
// （= 第二次启动，库里 0002 已应用）**必须仍然报错**，而不是"已 applied ⇒ 跳过"。
func TestApplyMigrationsShapeCheckRunsOnEveryStartup(t *testing.T) {
	db := newFreshDB(t)

	goodDir, goodSub := writeMigrations(t, map[string]string{
		"0001_a.sql": "CREATE TABLE r6s_shape_a (id INT);",
		"0002_b.sql": "CREATE TABLE r6s_shape_b (id INT);",
	})
	badDir, badSub := writeMigrations(t, map[string]string{
		"0001_a.sql": "CREATE TABLE r6s_shape_a (id INT);",
		"0002_b.sql": "CREATE TABLE r6s_shape_b (id INT);",
		"0002_c.sql": "CREATE TABLE r6s_shape_c (id INT);",
	})

	prev := migrationLoader
	t.Cleanup(func() { migrationLoader = prev })

	// 第一次启动：合规集合 ⇒ 成功，两条 DDL 都生效。
	migrationLoader = func() ([]migration, error) { return loadMigrations(os.DirFS(goodDir), goodSub) }
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("第一次启动（合规集合）应成功: %v", err)
	}
	for _, table := range []string{"r6s_shape_a", "r6s_shape_b"} {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM pg_tables WHERE tablename = ?`, table).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n != 1 {
			t.Fatalf("第一次启动后 %s 不存在（迁移没有真的应用）", table)
		}
	}

	// 第二次启动（同一个库，schema_migrations 里已有 0001/0002）：坏形状必须报错。
	migrationLoader = func() ([]migration, error) { return loadMigrations(os.DirFS(badDir), badSub) }
	err := ApplyMigrations(db)
	if err == nil {
		t.Fatal("第二次启动遇到重复版本号必须报错 —— 旧实现因 applied 快照把两条一起跳过（后一条 DDL 永不生效）")
	}
	for _, want := range []string{"0002_b.sql", "0002_c.sql"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("第二次启动的错误未点名 %q: %v", want, err)
		}
	}
	// 第三条迁移的 DDL 当然不能生效（这正是旧实现静默发生的事）。
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM pg_tables WHERE tablename = 'r6s_shape_c'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatal("夹具问题：r6s_shape_c 不该存在（第三条迁移从未被应用）")
	}
}
