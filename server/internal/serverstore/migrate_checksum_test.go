package serverstore

// R27-FIX39 ③ 回归：**运行时内容对账**（`schema_migrations.checksum`）。
//
// 被审形态（R27 审计 AA2-09 = P2；S1-F3 真跑三形态）：
//
//	`schema_migrations` 只记 `(version, applied_at)`，而 `ApplyMigrations` 的**唯一判据
//	是版本号**（`if applied[…]{ continue }`）⇒ "版本行在"被当成"DDL 已生效"的证据。
//	S1 真跑：把已应用的 0058 内容改掉（加一条 DDL）后，**老库**（0058 已应用）err=nil 且
//	新 DDL 永不生效，**新库**上同一个二进制却建出了它 —— 同一个二进制产出两套 schema，
//	两边都报成功、零日志。仓内本来有一条登记表
//	（`scripts/check-migration-range.mjs` + `migrations-checksums.json`），但 **Go 侧零引用**
//	（`grep -rn migrations-checksums server/ --include=*.go | wc -l` = 0），所以它管的是
//	"仓库里的文件别被静默改"，管不到"这个库到底跑的是哪一份内容"。
//
// 本文件的判据（能力级）：
//   - 条 1：Go 侧算出的 sha256 与 JS 登记表**逐条对拍**（同一算法、同一真源，
//     双向：登记了却没有文件 = 死条目；有文件却没登记 = 漏登记）。
//   - 条 2：**同一个版本号、不同内容**必须在启动期 fail-loud 并点名迁移号，
//     而且漂移内容绝不能被执行（去掉校验即红）。
//   - 条 3：**前向兼容**（硬要求）—— checksum 列之前建的老库必须能继续启动，
//     首启回填，回填值必须是随包文件的摘要，第二次启动稳定。

import (
	"bytes"
	"encoding/json"
	"errors"
	"log"
	"os"
	"strings"
	"testing"
)

// migrationChecksumRegistryEntry / Registry 对应 `migrations-checksums.json` 的形状
// （唯一真源在 `scripts/check-migration-range.mjs`，这里只读不写）。
type migrationChecksumRegistryEntry struct {
	Version string `json:"version"`
	File    string `json:"file"`
	Bytes   int    `json:"bytes"`
	SHA256  string `json:"sha256"`
}

type migrationChecksumRegistry struct {
	Schema    string                           `json:"schema"`
	Algorithm string                           `json:"algorithm"`
	Entries   []migrationChecksumRegistryEntry `json:"entries"`
}

func readChecksumRegistry(t *testing.T) migrationChecksumRegistry {
	t.Helper()
	raw, err := os.ReadFile("migrations-checksums.json")
	if err != nil {
		t.Fatalf("读迁移登记表（scripts/check-migration-range.mjs 生成）: %v", err)
	}
	var reg migrationChecksumRegistry
	if err := json.Unmarshal(raw, &reg); err != nil {
		t.Fatalf("解析迁移登记表: %v", err)
	}
	return reg
}

// embeddedMigrationChecksum 返回内嵌迁移集合里 version 的字节摘要（判据用）。
func embeddedMigrationChecksum(t *testing.T, version int) string {
	t.Helper()
	for _, m := range migrationsFor() {
		if m.version == version {
			return m.checksum()
		}
	}
	t.Fatalf("内嵌迁移集合里没有版本 %d", version)
	return ""
}

// TestMigrationChecksumsMatchJSRegistry：Go 摘要必须与 JS 侧登记表**逐条**一致
// （同一算法、同一真源；两侧独立算，所以这条对拍是真的跨实现判据）。
func TestMigrationChecksumsMatchJSRegistry(t *testing.T) {
	reg := readChecksumRegistry(t)
	if reg.Algorithm != "sha256" {
		t.Fatalf("登记表算法 = %q，want sha256（Go 侧 checksum() 用 sha256，算法不一致时两边的摘要不可比）", reg.Algorithm)
	}
	embedded := map[string]migration{}
	for _, m := range migrationsFor() {
		embedded[m.name] = m
	}
	if len(embedded) == 0 || len(reg.Entries) == 0 {
		t.Fatalf("对拍面为空：内嵌 %d 条 / 登记 %d 条", len(embedded), len(reg.Entries))
	}
	registered := map[string]bool{}
	for _, e := range reg.Entries {
		registered[e.File] = true
		m, ok := embedded[e.File]
		if !ok {
			t.Fatalf("登记表里有内嵌集合不存在的条目 %s（死条目）", e.File)
		}
		if got := m.checksum(); got != e.SHA256 {
			t.Fatalf("%s 的摘要两侧不一致：Go(内嵌字节)=%s，JS(登记表)=%s", e.File, got, e.SHA256)
		}
		if len(m.sql) != e.Bytes {
			t.Fatalf("%s 的字节数两侧不一致：Go=%d，登记=%d", e.File, len(m.sql), e.Bytes)
		}
	}
	for name := range embedded {
		if !registered[name] {
			t.Fatalf("内嵌迁移 %s 没有登记进 migrations-checksums.json（新增迁移必须登记）", name)
		}
	}
}

// TestAppliedMigrationContentChangeFailsLoud：形态 B —— 同一个版本号、不同内容。
func TestAppliedMigrationContentChangeFailsLoud(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	// 保证库内已登记摘要（老模板库没有这一列时，这一步就是首启回填）。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("首启（回填）: %v", err)
	}

	// 造"同一版本号、不同内容"：把 0058 的正文追加一条 DDL（S1 用的正是这一形态）。
	const driftVersion = 58
	real := migrationsFor()
	// 先记下**未漂移**的摘要：换掉 loader 之后 `migrationsFor()` 给的就是漂移版本，
	// 拿它当期望值会变成自洽判据（本仓已登记的假绿模式第 3 条）。
	realChecksum := embeddedMigrationChecksum(t, driftVersion)
	drifted := make([]migration, 0, len(real))
	for _, m := range real {
		if m.version == driftVersion {
			m.sql += "\nCREATE TABLE r27_fix39_drift_probe (id INT);\n"
		}
		drifted = append(drifted, m)
	}
	if drifted[len(drifted)-1].version != real[len(real)-1].version {
		t.Fatalf("夹具构造失败：迁移集合被改坏")
	}
	prevLoader := migrationLoader
	migrationLoader = func() ([]migration, error) { return drifted, nil }
	defer func() { migrationLoader = prevLoader }()

	err := ApplyMigrations(db)
	if err == nil {
		t.Fatal("已应用迁移的内容被改写必须 fail-loud —— 修复前这里是 err=nil 且新 DDL 永不生效（两套 schema 静默分叉）")
	}
	var csErr *MigrationChecksumError
	if !errors.As(err, &csErr) {
		t.Fatalf("必须是可判别的 MigrationChecksumError，实际 %T: %v", err, err)
	}
	if csErr.Version != driftVersion {
		t.Fatalf("必须点名冲突的迁移号 %d，实际 %d", driftVersion, csErr.Version)
	}
	if csErr.Expected == csErr.Applied {
		t.Fatalf("两侧摘要不该相同: %+v", csErr)
	}
	for _, want := range []string{"0058", "0058_model_input_modalities.sql"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("错误必须点名 %q（迁移号/文件名）: %v", want, err)
		}
	}
	// 漂移内容绝不能被执行（"内容对不上就停"而不是"顺手把它跑了"）。
	var exists bool
	if err := db.QueryRow(`SELECT to_regclass('public.r27_fix39_drift_probe') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatalf("探针表查询: %v", err)
	}
	if exists {
		t.Fatal("内容不一致时**不得**执行该迁移的正文")
	}
	// 库内登记的摘要不能被改写（否则下一轮就"自洽"了）。
	var got string
	if err := db.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, driftVersion).Scan(&got); err != nil {
		t.Fatalf("读 0058 checksum: %v", err)
	}
	if got != realChecksum {
		t.Fatalf("失败路径改写了库内摘要: got=%s want=%s", got, realChecksum)
	}
	if csErr.Applied != realChecksum {
		t.Fatalf("错误里必须带上库内登记的那一份摘要: %+v want=%s", csErr, realChecksum)
	}
}

// TestLegacyDatabaseWithoutChecksumsStillStarts：**前向兼容硬要求** ——
// checksum 列出现之前建的存量库必须能继续启动（首启回填），且回填值是随包文件的摘要。
func TestLegacyDatabaseWithoutChecksumsStillStarts(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()

	// 老库形态：这一列根本不存在（老二进制只建 version + applied_at）。
	mustExec(t, db, `ALTER TABLE schema_migrations DROP COLUMN IF EXISTS checksum`)

	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("老库必须能**继续启动**（不能因为「老库没有 checksum 列」就拒绝启动）: %v", err)
	}
	var nulls int
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE checksum IS NULL OR checksum = ''`).Scan(&nulls); err != nil {
		t.Fatalf("读空摘要行数: %v", err)
	}
	if nulls != 0 {
		t.Fatalf("首启必须回填**全部**已应用版本的摘要，仍有 %d 行为空", nulls)
	}
	// 回填值必须等于随包文件的摘要（不是"随便写个非空值"）。
	for _, v := range []int{1, 58, 73, 82} {
		var got string
		if err := db.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, v).Scan(&got); err != nil {
			t.Fatalf("读版本 %d 的 checksum: %v", v, err)
		}
		if want := embeddedMigrationChecksum(t, v); got != want {
			t.Fatalf("回填的 checksum 必须等于随包文件摘要：version=%d got=%s want=%s", v, got, want)
		}
	}
	// 再启动一次必须稳定（幂等：不重复回填、不报错、不把列删掉）。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("老库第二次启动: %v", err)
	}
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("老库第三次启动: %v", err)
	}
}

// TestChecksumBackfillConvergesOnEmptyStringRows 是 R28-FIX41 ② 的承重判据。
//
// 被审形态（R28 审计 AB1-05 = P3，真 PG 连跑三次复现）：
//
//	`checksum = ''`（**空串**，不是 NULL）被读侧当成"未登记"（读侧注释与实现：NULL / 空串
//	都落成 ""），写侧却只回填 `WHERE checksum IS NULL` ⇒ 那一行**永远**改不到，于是
//	每次启动都打印 "backfilled content checksums for 1 migration(s)"（日志是假的、回填不收敛），
//	且该行永远落在"未登记"分支 ⇒ **"已应用迁移被就地改写必须 fail-loud"这条不变式对它永久不成立**。
//	FIX-39 自己的用例把整列 DROP（只有 NULL 这一种形态），**结构上测不到空串**。
//
// 本条同时钉三件事（缺一件修复就不算成立）：
//  1. 三形态各一行（空串 / NULL / 合法值）⇒ 前两种必须在**一次**启动后全部登记；
//  2. 收敛：第二次启动**不再**打印 "backfilled"（并且不报错、不改写合法值那一行）；
//  3. 能力级：该行此后真的参与内容对账 —— 把 0001 的正文改掉 ⇒ 启动期 fail-loud。
func TestChecksumBackfillConvergesOnEmptyStringRows(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	// 先跑一次：补齐列与已登记摘要（模板库可能是 checksum 列出现之前建的）。
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("准备（补齐账本）: %v", err)
	}

	const (
		emptyVersion = 1 // 空串：被审形态
		nullVersion  = 2 // NULL：FIX-39 已经覆盖的形态
		legalVersion = 3 // 合法值：对照组（任何一次启动都不该动它）
	)
	legalBefore := embeddedMigrationChecksum(t, legalVersion)
	mustExec(t, db, `UPDATE schema_migrations SET checksum = '' WHERE version = ?`, emptyVersion)
	mustExec(t, db, `UPDATE schema_migrations SET checksum = NULL WHERE version = ?`, nullVersion)
	mustExec(t, db, `UPDATE schema_migrations SET checksum = ? WHERE version = ?`, legalBefore, legalVersion)

	// 三形态的种子必须真的写进去了（夹具漏 await 的同族形态：夹具没构造出缺陷 ⇒ 假绿）。
	var emptyCount, nullCount int
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version = ? AND checksum = ''`, emptyVersion).Scan(&emptyCount); err != nil {
		t.Fatalf("读空串种子: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM schema_migrations WHERE version = ? AND checksum IS NULL`, nullVersion).Scan(&nullCount); err != nil {
		t.Fatalf("读 NULL 种子: %v", err)
	}
	if emptyCount != 1 || nullCount != 1 {
		t.Fatalf("夹具没构造出三形态：空串=%d NULL=%d（want 1/1）", emptyCount, nullCount)
	}

	runOnce := func() (string, error) {
		var buf bytes.Buffer
		prevOut := log.Writer()
		log.SetOutput(&buf)
		err := ApplyMigrations(db)
		log.SetOutput(prevOut)
		return buf.String(), err
	}

	// —— 第 1 次启动：两种"未登记"形态都必须被回填。
	logged1, err := runOnce()
	if err != nil {
		t.Fatalf("第一次启动（回填）: %v", err)
	}
	if !strings.Contains(logged1, "backfilled content checksums for 2 migration(s)") {
		t.Fatalf("第一次启动必须回填 2 条（空串 + NULL）；实际日志:\n%s", logged1)
	}
	for _, v := range []int{emptyVersion, nullVersion, legalVersion} {
		var got string
		if err := db.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, v).Scan(&got); err != nil {
			t.Fatalf("读 %d 的 checksum: %v", v, err)
		}
		if want := embeddedMigrationChecksum(t, v); got != want {
			t.Fatalf("回填后 version=%d 的 checksum=%q，want %q", v, got, want)
		}
	}

	// —— 第 2 次启动：必须**零回填**（收敛），且合法值那一行逐字不动。
	logged2, err := runOnce()
	if err != nil {
		t.Fatalf("第二次启动: %v", err)
	}
	if strings.Contains(logged2, "backfilled") {
		t.Fatalf("回填不收敛：第二次启动仍然打印 backfilled（空串行改不到 = 该行的内容对账永久关闭）；日志:\n%s", logged2)
	}
	var legalAfter string
	if err := db.QueryRow(`SELECT checksum FROM schema_migrations WHERE version = ?`, legalVersion).Scan(&legalAfter); err != nil {
		t.Fatalf("读合法值行: %v", err)
	}
	if legalAfter != legalBefore {
		t.Fatalf("合法值那一行不该被改写: got=%s want=%s", legalAfter, legalBefore)
	}

	// —— 能力级：这一行现在真的参与内容对账（AB1-05 的危害正是"永久不参与"）。
	real := migrationsFor()
	drifted := make([]migration, 0, len(real))
	for _, m := range real {
		if m.version == emptyVersion {
			m.sql += "\nCREATE TABLE r28_fix41_backfill_probe (id INT);\n"
		}
		drifted = append(drifted, m)
	}
	prevLoader := migrationLoader
	migrationLoader = func() ([]migration, error) { return drifted, nil }
	defer func() { migrationLoader = prevLoader }()

	err = ApplyMigrations(db)
	if err == nil {
		t.Fatal("空串行被回填之后，同一版本号的内容漂移必须 fail-loud（修复前该行永远落在「未登记」分支 ⇒ 永不参与对账）")
	}
	var csErr *MigrationChecksumError
	if !errors.As(err, &csErr) {
		t.Fatalf("必须是可判别的 MigrationChecksumError，实际 %T: %v", err, err)
	}
	if csErr.Version != emptyVersion {
		t.Fatalf("必须点名冲突的迁移号 %d，实际 %d", emptyVersion, csErr.Version)
	}
	var exists bool
	if err := db.QueryRow(`SELECT to_regclass('public.r28_fix41_backfill_probe') IS NOT NULL`).Scan(&exists); err != nil {
		t.Fatalf("探针表查询: %v", err)
	}
	if exists {
		t.Fatal("内容不一致时**不得**执行该迁移的正文")
	}
}
