package serverstore

import (
	"database/sql"
	"strings"
	"testing"
)

// 0054/0055 回归（2026-09-23，P1 MIG-2）：**同名不同源的能力内容不得被静默丢弃**。
//
// 病根（独立审计用真实载荷复现）：统一模型的身份键是 `apps.PRIMARY KEY (kind,
// app_id)`（0053，**不含 channel**），而 0054 按「市场先插、组织后插」的顺序回填、
// 全部 `ON CONFLICT DO NOTHING`：
//
//	同名同版本（市场 skills 与组织 shared_skills）⇒ 组织 release 被静默丢弃；
//	同名不同版本                                   ⇒ 组织 release 挂到 channel='market'
//	                                                  的 App 下（归属错配）；
//	组织授权                                        ⇒ 并进市场 App（授权语义错配）；
//
// 而 0055 **没有任何自检**就 DROP 掉六张旧表 ⇒ 以上内容永久丢失、无法恢复。
//
// 本文件两条用例把"丢"与"不丢"都钉住：
//
//	① TestMigration0055BackfillConflictIsFailLoud：存在同名冲突时，0055 必须
//	   **中止升级**并点名冲突（旧表原样保留）；按处置指引消除冲突后重放即通过，
//	   非冲突内容一行不少。
//	② TestMigration0054And0055BackfillPreservesEverything：无冲突时回填必须
//	   **逐行完整**（三张源表 + 三张授权表），且 0055 的自检不得误报。
//
// 变异验证（2026-09-23 实跑）：把 0055 的自检 DO 块整段删掉 ⇒ ① 红
// （"同名同版本的组织 release 被静默丢弃" 不再被拦住）。
func TestMigration0055BackfillConflictIsFailLoud(t *testing.T) {
	db, cleanup := newVersionedTestDB(t, migrationsBetween(t, 1, 53))
	defer cleanup()

	// --- 存量数据：三张源表 + 三张授权表，含两种同名冲突形态 ---
	seedLegacyCapabilities(t, db, []legacySkill{
		// 市场：独占一个 / 与组织同名同版本 / 与组织同名不同版本
		{name: "market-only", version: "1.0.0", archive: "market-archive-market-only", status: "approved", channel: "market"},
		{name: "clash-same", version: "1.0.0", archive: "market-archive-clash-same", status: "approved", channel: "market"},
		{name: "clash-diff", version: "1.0.0", archive: "market-archive-clash-diff", status: "approved", channel: "market"},
		// 组织：独占一个 / 同名同版本 / 同名不同版本
		{name: "org-only", version: "2.0.0", archive: "org-archive-org-only", status: "approved", channel: "org"},
		{name: "clash-same", version: "1.0.0", archive: "org-archive-clash-same", status: "pending", channel: "org"},
		{name: "clash-diff", version: "2.0.0", archive: "org-archive-clash-diff", status: "approved", channel: "org"},
	})
	if _, err := db.Exec(`INSERT INTO agent_presets (name, display_name, version, author, checksum, status, archive)
		VALUES ('org-agent', '组织智能体', '1.0.0', 'alice', 'ck-agent', 'approved', ?)`, []byte("org-archive-org-agent")); err != nil {
		t.Fatalf("插入存量 agent_presets: %v", err)
	}
	seedLegacyGrant(t, db, "skill_grants", "skill_name", "market-only", "user", "alice")
	seedLegacyGrant(t, db, "shared_skill_grants", "skill_name", "org-only", "group", "dept-a")
	seedLegacyGrant(t, db, "shared_skill_grants", "skill_name", "clash-same", "user", "bob")
	seedLegacyGrant(t, db, "shared_skill_grants", "skill_name", "clash-diff", "user", "carol")
	seedLegacyGrant(t, db, "agent_preset_grants", "preset_name", "org-agent", "group", "dept-b")

	// --- 0054（回填） ---
	if err := applyMigrationsOnly(t, db, 54); err != nil {
		t.Fatalf("应用 0054: %v", err)
	}
	// 市场行占名：身份归属市场，冲突名的组织行不另建 App（(kind, app_id) 主键下不可能）
	assertAppChannel(t, db, "skill", "clash-same", "market")
	assertAppChannel(t, db, "skill", "clash-diff", "market")
	assertAppChannel(t, db, "skill", "org-only", "org")
	assertAppChannel(t, db, "agent", "org-agent", "org")
	// 同名同版本：市场那份在目标里（组织那份没有位置，见下）
	assertReleaseArchive(t, db, "skill", "clash-same", "1.0.0", "market-archive-clash-same")
	// 同名不同版本：组织版本**不得**挂到市场 App 下（归属错配即本次修的缺陷之一）
	if n := countReleases(t, db, "skill", "clash-diff", "2.0.0"); n != 0 {
		t.Errorf("组织版本 clash-diff@2.0.0 被挂到了市场 App 下（归属错配）: %d 行", n)
	}
	// 组织授权不得并进市场 App（授权语义错配）
	if n := countGrants(t, db, "skill", "clash-same", "user", "bob"); n != 0 {
		t.Errorf("组织授权 clash-same → user:bob 被并进了市场 App: %d 行", n)
	}
	// 非冲突内容必须已经在统一模型里（说明失败点是冲突，不是回填本身坏了）
	assertReleaseArchive(t, db, "skill", "org-only", "2.0.0", "org-archive-org-only")
	assertReleaseArchive(t, db, "agent", "org-agent", "1.0.0", "org-archive-org-agent")
	if n := countGrants(t, db, "skill", "org-only", "group", "dept-a"); n != 1 {
		t.Errorf("非冲突的组织授权应已回填: %d 行", n)
	}

	// --- 0055（DROP 前自检）：必须中止，且点名冲突 ---
	err := applyMigrationsOnly(t, db, 55)
	if err == nil {
		t.Fatal("存在同名冲突时 0055 竟然通过了 —— 组织 release/授权会在 DROP 后永久丢失（P1 回归）")
	}
	msg := err.Error()
	if !strings.Contains(msg, "回填自检失败") {
		t.Fatalf("0055 的失败必须来自回填自检（而不是别的 SQL 错误）: %v", err)
	}
	// 点名冲突清单：三张冲突行（clash-same 组织版、clash-diff 组织版、两条组织授权）
	for _, want := range []string{"clash-same@1.0.0", "clash-diff@2.0.0", "clash-same → user:bob", "clash-diff → user:carol"} {
		if !strings.Contains(msg, want) {
			t.Errorf("0055 的异常必须点名 %q（审计要求「在日志里点名冲突清单」）:\n%s", want, msg)
		}
	}
	// 关键：中止时六张旧表**一张都不能少**（数据可恢复的前提）
	for _, table := range []string{"skills", "shared_skills", "agent_presets", "skill_grants", "shared_skill_grants", "agent_preset_grants"} {
		if !tableExists(t, db, table) {
			t.Fatalf("0055 中止后旧表 %s 不该消失", table)
		}
	}

	// --- 恢复路径 A（文件头指引）：明确删除冲突的组织行与授权，再重放 0055 ---
	if _, err := db.Exec(`DELETE FROM shared_skill_grants WHERE skill_name IN ('clash-same','clash-diff')`); err != nil {
		t.Fatalf("删除冲突授权: %v", err)
	}
	if _, err := db.Exec(`DELETE FROM shared_skills WHERE name IN ('clash-same','clash-diff')`); err != nil {
		t.Fatalf("删除冲突组织技能: %v", err)
	}
	if err := applyMigrationsOnly(t, db, 55); err != nil {
		t.Fatalf("消除冲突后 0055 应通过（清理路径必须可行，否则升级永久卡死）: %v", err)
	}
	for _, table := range []string{"skills", "shared_skills", "agent_presets", "skill_grants", "shared_skill_grants", "agent_preset_grants"} {
		if tableExists(t, db, table) {
			t.Fatalf("0055 通过后旧表 %s 必须已删除", table)
		}
	}
	// 存活内容一行不少
	assertReleaseArchive(t, db, "skill", "org-only", "2.0.0", "org-archive-org-only")
	assertReleaseArchive(t, db, "skill", "market-only", "1.0.0", "market-archive-market-only")
	assertReleaseArchive(t, db, "skill", "clash-same", "1.0.0", "market-archive-clash-same")
	assertReleaseArchive(t, db, "agent", "org-agent", "1.0.0", "org-archive-org-agent")
	if n := countGrants(t, db, "skill", "org-only", "group", "dept-a"); n != 1 {
		t.Errorf("恢复后组织授权丢失: %d 行", n)
	}
	if n := countGrants(t, db, "agent", "org-agent", "group", "dept-b"); n != 1 {
		t.Errorf("恢复后组织智能体授权丢失: %d 行", n)
	}
}

// TestMigration0054And0055BackfillPreservesEverything：**无冲突**时回填必须逐行完整
// —— 这条同时是"防误报"用例：0055 的自检若把正常回填判成缺失，升级会被无端挡住。
func TestMigration0054And0055BackfillPreservesEverything(t *testing.T) {
	db, cleanup := newVersionedTestDB(t, migrationsBetween(t, 1, 53))
	defer cleanup()

	skills := []legacySkill{
		{name: "mk-a", version: "1.0.0", archive: "mk-a-archive", status: "approved", channel: "market"},
		{name: "mk-b", version: "2.0.0", archive: "mk-b-archive", status: "approved", channel: "market"},
		{name: "org-a", version: "1.0.0", archive: "org-a-v1", status: "approved", channel: "org"},
		{name: "org-a", version: "1.1.0", archive: "org-a-v11", status: "pending", channel: "org"},
		{name: "org-b", version: "3.0.0", archive: "org-b-archive", status: "rejected", channel: "org"},
	}
	seedLegacyCapabilities(t, db, skills)
	if _, err := db.Exec(`INSERT INTO agent_presets (name, display_name, version, author, checksum, status, archive)
		VALUES ('ag-a', '智能体 A', '1.2.0', 'bob', 'ck-1', 'approved', ?),
		       ('ag-b', '智能体 B', '0.9.0', 'carol', 'ck-2', 'pending', ?)`,
		[]byte("ag-a-archive"), []byte("ag-b-archive")); err != nil {
		t.Fatalf("插入存量 agent_presets: %v", err)
	}
	seedLegacyGrant(t, db, "skill_grants", "skill_name", "mk-a", "user", "alice")
	seedLegacyGrant(t, db, "skill_grants", "skill_name", "mk-b", "group", "dept-x")
	seedLegacyGrant(t, db, "shared_skill_grants", "skill_name", "org-a", "group", "dept-y")
	seedLegacyGrant(t, db, "shared_skill_grants", "skill_name", "org-b", "user", "dave")
	seedLegacyGrant(t, db, "agent_preset_grants", "preset_name", "ag-a", "group", "dept-z")

	// 0054 + 0055 连续应用（真实升级顺序）；0055 的自检必须通过
	if err := applyMigrationsOnly(t, db, 54); err != nil {
		t.Fatalf("应用 0054: %v", err)
	}
	if err := applyMigrationsOnly(t, db, 55); err != nil {
		t.Fatalf("无冲突的库上 0055 必须通过（自检误报会把正常升级挡死）: %v", err)
	}
	// 逐行：每张源表的 (name, version, archive) 都在统一模型里、且通道归属正确
	for _, s := range skills {
		assertAppChannel(t, db, "skill", s.name, s.channel)
		assertReleaseArchive(t, db, "skill", s.name, s.version, s.archive)
	}
	assertReleaseArchive(t, db, "agent", "ag-a", "1.2.0", "ag-a-archive")
	assertReleaseArchive(t, db, "agent", "ag-b", "0.9.0", "ag-b-archive")
	// 审核状态按旧表语义保留（组织行原样、市场行 approved）
	assertReleaseStatus(t, db, "skill", "org-a", "1.1.0", "pending")
	assertReleaseStatus(t, db, "skill", "org-b", "3.0.0", "rejected")
	assertReleaseStatus(t, db, "skill", "mk-b", "2.0.0", "approved")
	// 授权逐行
	for _, g := range []struct{ kind, app, gtype, grantee string }{
		{"skill", "mk-a", "user", "alice"},
		{"skill", "mk-b", "group", "dept-x"},
		{"skill", "org-a", "group", "dept-y"},
		{"skill", "org-b", "user", "dave"},
		{"agent", "ag-a", "group", "dept-z"},
	} {
		if n := countGrants(t, db, g.kind, g.app, g.gtype, g.grantee); n != 1 {
			t.Errorf("授权 %s/%s → %s:%s 未回填: %d 行", g.kind, g.app, g.gtype, g.grantee, n)
		}
	}
	// 旧表已下线
	for _, table := range []string{"skills", "shared_skills", "agent_presets", "skill_grants", "shared_skill_grants", "agent_preset_grants"} {
		if tableExists(t, db, table) {
			t.Fatalf("0055 通过后旧表 %s 必须已删除", table)
		}
	}
}

// ---- 0054/0055 用例的小工具 ----

// legacySkill 一条存量技能（market ← skills，org ← shared_skills）。
type legacySkill struct {
	name    string
	version string
	archive string
	status  string
	channel string
}

// seedLegacyCapabilities 按 channel 把技能写进旧的 skills / shared_skills 表。
func seedLegacyCapabilities(t *testing.T, db *sql.DB, rows []legacySkill) {
	t.Helper()
	for _, r := range rows {
		checksum := "ck-" + r.name + "-" + r.version
		var err error
		if r.channel == "market" {
			// 注意：0052 已删掉 skills 的 git_url/git_ref/source 三列（归档上传是唯一入口）
			_, err = db.Exec(`INSERT INTO skills (name, display_name, version, description, author,
				checksum, enabled, archive, downloads, calls)
				VALUES (?, ?, ?, '', 'alice', ?, 1, ?, 3, 7)`,
				r.name, r.name, r.version, checksum, []byte(r.archive))
		} else {
			_, err = db.Exec(`INSERT INTO shared_skills (name, display_name, version, description, author,
				checksum, status, reason, archive, downloads, calls)
				VALUES (?, ?, ?, '', 'alice', ?, ?, '', ?, 5, 9)`,
				r.name, r.name, r.version, checksum, r.status, []byte(r.archive))
		}
		if err != nil {
			t.Fatalf("插入存量技能 %s/%s（%s）: %v", r.name, r.version, r.channel, err)
		}
	}
}

// seedLegacyGrant 往某张旧授权表写一行（列名随表不同：skill_name / preset_name）。
func seedLegacyGrant(t *testing.T, db *sql.DB, table, nameCol, name, granteeType, grantee string) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO `+table+` (`+nameCol+`, grantee_type, grantee) VALUES (?, ?, ?)`,
		name, granteeType, grantee); err != nil {
		t.Fatalf("插入存量授权 %s/%s → %s:%s: %v", table, name, granteeType, grantee, err)
	}
}

// applyMigrationsOnly 只应用指定版本的那一条迁移（模拟"升级到该版本"）。
func applyMigrationsOnly(t *testing.T, db *sql.DB, version int) error {
	t.Helper()
	ms := migrationsBetween(t, version, version)
	testMigrationHook = func() []migration { return ms }
	defer func() { testMigrationHook = nil }()
	return ApplyMigrations(db)
}

// migrationsBetween 取 [lo, hi] 区间内的迁移（升序）。
func migrationsBetween(t *testing.T, lo, hi int) []migration {
	t.Helper()
	var out []migration
	for _, m := range migrationsFor() {
		if m.version >= lo && m.version <= hi {
			out = append(out, m)
		}
	}
	if len(out) == 0 {
		t.Fatalf("迁移集合 %d..%d 为空", lo, hi)
	}
	return out
}

func assertAppChannel(t *testing.T, db *sql.DB, kind, appID, wantChannel string) {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT channel FROM apps WHERE kind = ? AND app_id = ?`, kind, appID).Scan(&got); err != nil {
		t.Fatalf("读 %s/%s 的 channel: %v", kind, appID, err)
	}
	if got != wantChannel {
		t.Errorf("%s/%s 的 channel = %q，期望 %q", kind, appID, got, wantChannel)
	}
}

func assertReleaseArchive(t *testing.T, db *sql.DB, kind, appID, version, wantArchive string) {
	t.Helper()
	var got []byte
	if err := db.QueryRow(`SELECT archive FROM app_releases WHERE kind = ? AND app_id = ? AND version = ?`,
		kind, appID, version).Scan(&got); err != nil {
		t.Fatalf("读 %s/%s@%s 的 archive: %v", kind, appID, version, err)
	}
	if string(got) != wantArchive {
		t.Errorf("%s/%s@%s 的 archive = %q，期望 %q（回填必须逐字节保留原文）", kind, appID, version, got, wantArchive)
	}
}

func assertReleaseStatus(t *testing.T, db *sql.DB, kind, appID, version, wantStatus string) {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT status FROM app_releases WHERE kind = ? AND app_id = ? AND version = ?`,
		kind, appID, version).Scan(&got); err != nil {
		t.Fatalf("读 %s/%s@%s 的 status: %v", kind, appID, version, err)
	}
	if got != wantStatus {
		t.Errorf("%s/%s@%s 的 status = %q，期望 %q", kind, appID, version, got, wantStatus)
	}
}

func countReleases(t *testing.T, db *sql.DB, kind, appID, version string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM app_releases WHERE kind = ? AND app_id = ? AND version = ?`,
		kind, appID, version).Scan(&n); err != nil {
		t.Fatalf("数 %s/%s@%s: %v", kind, appID, version, err)
	}
	return n
}

func countGrants(t *testing.T, db *sql.DB, kind, appID, granteeType, grantee string) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM app_grants
		WHERE kind = ? AND app_id = ? AND grantee_type = ? AND grantee = ?`,
		kind, appID, granteeType, grantee).Scan(&n); err != nil {
		t.Fatalf("数授权 %s/%s → %s:%s: %v", kind, appID, granteeType, grantee, err)
	}
	return n
}
