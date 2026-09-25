package serverstore

// R13-GE · R13A-03 回归：迁移文件集合与 `schema_migrations` 的**双向对账**。
//
// 被审形态（R13-A 的迁移集合探针）：`ApplyMigrations` 只做**单向**遍历
// （文件 → DB），DB 里多出来的版本既无错误、无日志、无告警（探针实测返回 nil）。
// 三条现实来源：① 二进制回滚（DB 已到 0081，二进制只认 0080）；② 手工/脚本写入；
// ③ 历史上删过/改过号的迁移文件。
//
// 修法口径（fail-loud，见 `SchemaMismatchError` 的注释）：反向差集非空 ⇒
// `ApplyMigrations` 返回一个**结构化**错误（点名版本、指出方向、给两条可行动作），
// `cmd/server` 的既有 `log.Fatalf` 路径据此拒绝启动。**不做"打个日志继续跑"** ——
// 这一类缺陷的全部危害都来自静默。
//
// 判据（全部走**生产嵌入集合**，即 `testMigrationHook == nil`）：
//
//	A. 库里掺一条**超出二进制可见上界**的版本（真降级的形态）⇒ 必须 fail-loud，
//	   错误里点名该版本、方向为"库比二进制新"；
//	B. 库里掺一条**落在可见区间之外的下界**（版本 0，历史死条目的形态）⇒ 同样 fail-loud；
//	C. 正向对照：干净库（= 模板库克隆）上 `ApplyMigrations` 必须返回 nil 且幂等；
//	D. 反向差集的纯函数判据（`schemaUnknownVersions` 升序、不多不少）。
//
// 为什么不用 `testMigrationHook` 造 A/B（R13-A 的探针手法在这里不适用）：那个接缝
// 是测试专用的集合注入点，迁移语义夹具的固定手法就是"先应用到 00NN、再应用 00NN+1"
// —— 库里必然有大量"不在注入集合里"的版本。直接往 `schema_migrations` 里掺一行
// 更贴近生产（也正是任务书写的"造一条多余的 schema_migrations 行"）。

import (
	"errors"
	"strings"
	"testing"
)

// TestAuditR13GEMigrationReverseReconciliationFailsLoud 是判据 A/B。
func TestAuditR13GEMigrationReverseReconciliationFailsLoud(t *testing.T) {
	if testMigrationHook != nil {
		t.Fatal("前置条件：本判据必须跑在生产嵌入集合上（testMigrationHook == nil）")
	}
	files := migrationsFor()
	maxFile := schemaMaxVersion(files)

	cases := []struct {
		name    string
		version int64
		wantDir string
	}{
		// 真降级的形态：库里有一个比二进制可见上界更高的版本。
		{"库比二进制新（二进制被回滚）", maxFile + 1, "库比二进制**新**"},
		// 历史死条目 / 手工写入的形态：落在可见区间之外的下界。
		{"可见区间之外的下界死条目", 0, "库比二进制**旧**"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db, cleanup := newTestDB(t)
			defer cleanup()
			if _, err := db.Exec(`INSERT INTO schema_migrations (version) VALUES (?)`, tc.version); err != nil {
				t.Fatalf("掺入多余版本 %d: %v", tc.version, err)
			}
			err := ApplyMigrations(db)
			if err == nil {
				t.Fatalf("schema_migrations 里有版本 %d（没有对应迁移文件）却返回 nil —— "+
					"这就是被审形态：DB 里多出来的版本静默通过", tc.version)
			}
			var mism *SchemaMismatchError
			if !errors.As(err, &mism) {
				t.Fatalf("错误类型不是 *SchemaMismatchError（拿不到结构化读数）: %T %v", err, err)
			}
			found := false
			for _, v := range mism.Unknown {
				if v == tc.version {
					found = true
				}
			}
			if !found {
				t.Errorf("错误没有点名版本 %d（Unknown=%v）", tc.version, mism.Unknown)
			}
			if mism.MaxFile != maxFile {
				t.Errorf("MaxFile=%d，want %d（二进制可见集合的上界）", mism.MaxFile, maxFile)
			}
			msg := err.Error()
			if !strings.Contains(msg, tc.wantDir) {
				t.Errorf("错误文案没有说清方向（want 含 %q）：%s", tc.wantDir, msg)
			}
			t.Logf("OK fail-loud：%s", msg)
		})
	}
}

// TestAuditR13GEMigrationReverseReconciliationCleanDBIsGreen 是判据 C（正向对照）。
func TestAuditR13GEMigrationReverseReconciliationCleanDBIsGreen(t *testing.T) {
	if testMigrationHook != nil {
		t.Fatal("前置条件：本判据必须跑在生产嵌入集合上（testMigrationHook == nil）")
	}
	db, cleanup := newTestDB(t)
	defer cleanup()
	// 干净库（模板克隆：applied 与 files 恰好一致）必须 nil，且幂等（第二次也 nil）。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("干净库上 ApplyMigrations 返回错误（判据恒真/过严）: %v", err)
	}
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("第二次 ApplyMigrations（幂等）返回错误: %v", err)
	}
	// 反向差集必须为空 —— 与 B/A 的红色形成对照（证明 A/B 的红来自那一条掺入的行）。
	var unknown []int64
	rows, err := db.Query(`SELECT version FROM schema_migrations`)
	if err != nil {
		t.Fatal(err)
	}
	applied := map[int64]bool{}
	for rows.Next() {
		var v int64
		if err := rows.Scan(&v); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		applied[v] = true
	}
	rows.Close()
	unknown = schemaUnknownVersions(applied, migrationsFor())
	if len(unknown) != 0 {
		t.Errorf("干净库的反向差集非空：%v —— 模板库与嵌入集合已经漂移", unknown)
	}
	t.Logf("干净库：applied=%d 条，反向差集为空，两次 ApplyMigrations 均 nil", len(applied))
}

// TestAuditR13GESchemaUnknownVersionsIsExact 是判据 D（纯函数，双向不多不少）。
func TestAuditR13GESchemaUnknownVersionsIsExact(t *testing.T) {
	files := []migration{{version: 1}, {version: 3}, {version: 7}}
	applied := map[int64]bool{1: true, 3: true, 7: true}
	if got := schemaUnknownVersions(applied, files); len(got) != 0 {
		t.Errorf("完全一致时反向差集必须为空，得到 %v", got)
	}
	applied[9] = true
	applied[0] = true
	applied[2] = true
	got := schemaUnknownVersions(applied, files)
	want := []int64{0, 2, 9}
	if len(got) != len(want) {
		t.Fatalf("反向差集 = %v，want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("反向差集 = %v（必须升序且不多不少），want %v", got, want)
		}
	}
	if m := schemaMaxVersion(files); m != 7 {
		t.Errorf("schemaMaxVersion = %d, want 7", m)
	}
	if m := schemaMaxVersion(nil); m != 0 {
		t.Errorf("空集合的 schemaMaxVersion = %d, want 0", m)
	}
}
