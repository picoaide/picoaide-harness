package serverstore

// R6-A-1 判据（第六轮审计 2026-09-23，P1）：`CleanupUsageRetention` 必须**逐关系
// 错误隔离**，一条关系失败不得让整轮清理停摆。
//
// 缺陷形态（修复前）：Orphans 前置循环与分区循环都是"遇到第一条失败即 `return derr`"，
// 而 Orphans 在分区循环**之前** ⇒ 任意一条 `usage_<YYYYMM>` 关系 `DROP` 失败就让
// **该轮全部到期月份**留在盘上；失败是稳定的（每轮都在同一处失败）⇒ 保留策略
// **永久停摆**（`usage.retention_months` 在管理端仍显示"生效中"，磁盘按经过的月份
// 单调增长），只能人工 DROP 那条关系。两条触发形态都不需要改产品代码：
//
//	A. 月名被非表关系占用（视图占名 `usage_202001`）——
//	   旧实现硬发 `DROP TABLE IF EXISTS`，PG 报 42809 `"…" is not a table`；
//	B. 一个视图依赖某个真分区（运维建报表视图是完全正常的动作）——
//	   `DROP TABLE` 报 2BP01 `cannot drop table … because other objects depend on it`。
//
// 三条判据分别覆盖：A 按 relkind 分流后**被正确处理**（DROP VIEW）且不阻塞其余月份；
// B 失败**只隔离到那一条关系**（其余到期月份照常清掉 + 错误点名 + 日志带 SQLSTATE
// 原因码），且解除阻塞后重试**真的能推进**（不是永久停摆）；C 无法安全清理的形态
// （索引等非表对象）记警告并**跳过**，既不硬发 DROP TABLE 也不阻断其余月份。

import (
	"bytes"
	"database/sql"
	"log"
	"strings"
	"testing"
	"time"
)

// captureRetentionLog 把标准 log 输出接到缓冲区（仅测试期间；本文件的用例不并行）。
func captureRetentionLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	prev := log.Writer()
	buf := &bytes.Buffer{}
	log.SetOutput(buf)
	t.Cleanup(func() { log.SetOutput(prev) })
	return buf
}

// expiredMonthPartitions 返回当前**早于保留 cutoff** 的月分区名（升序），
// 作为"本轮应当被清掉"的夹具基线 —— 判据不写死具体月份。
func expiredMonthPartitions(t *testing.T, db *sql.DB) []string {
	t.Helper()
	n, err := EffectiveRetentionMonths(db)
	if err != nil {
		t.Fatalf("读保留期: %v", err)
	}
	cutoff := BeijingMonth(time.Now()).AddDate(0, -n, 0)
	var out []string
	for _, rel := range usagePartitionRelations(t, db) {
		if m, ok := usageMonthRelationOf(rel); ok && m.Before(cutoff) {
			out = append(out, rel)
		}
	}
	return out
}

// TestUsageRetentionViewOccupiedMonthNameIsClearedNotStalling 覆盖形态 A：
// 月名被视图占用时必须按 relkind 用 DROP VIEW 清掉，且与它无关的到期分区照常清理。
func TestUsageRetentionViewOccupiedMonthNameIsClearedNotStalling(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := expiredMonthPartitions(t, db)
	if len(expired) == 0 {
		t.Fatal("夹具无效：测试库里没有早于保留 cutoff 的月分区")
	}

	// 占名视图（代码注释点名的"被换成 VIEW 的异常形态"）。
	if _, err := db.Exec("DROP VIEW IF EXISTS usage_202001"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE VIEW usage_202001 AS SELECT 1 AS x"); err != nil {
		t.Fatalf("造占名视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS usage_202001") })

	logs := captureRetentionLog(t)
	err := CleanupUsageRetention(db)
	if err != nil {
		t.Fatalf("视图占名不得让清理报错（应按 relkind 分流用 DROP VIEW 清掉）: %v", err)
	}
	if relationExists(t, db, "usage_202001") {
		t.Fatal("占名视图没有被清掉（relkind 分流未生效）—— 该月的新写入仍会撞同名关系")
	}
	for _, rel := range expired {
		if relationExists(t, db, rel) {
			t.Fatalf("%s 仍在盘上：与占名视图无关的到期分区被整轮停摆牵连（R6-A-1 回归）", rel)
		}
	}
	out := logs.String()
	for _, want := range []string{"round summary", "cleared_partitions=", "failures=0"} {
		if !strings.Contains(out, want) {
			t.Fatalf("每轮可观测日志缺少 %q（清了几条/失败几条必须可 grep）:\n%s", want, out)
		}
	}

	// 同一调用再跑一次：幂等、不报错、继续推进（不再"停在第一次失败处"）。
	logs2 := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("第二次清理应成功（幂等）: %v", err)
	}
	if !strings.Contains(logs2.String(), "failures=0") {
		t.Fatalf("第二次清理的轮次日志缺 failures=0:\n%s", logs2.String())
	}
}

// TestUsageRetentionDependentViewIsolatedAndRetryProgresses 覆盖形态 B：
// 依赖视图让某条关系的 DROP 失败时，其余到期月份仍必须被清掉（不再整轮停摆），
// 错误必须点名失败关系且日志带原因码；解除阻塞后重试必须真的把它清掉。
func TestUsageRetentionDependentViewIsolatedAndRetryProgresses(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := expiredMonthPartitions(t, db)
	if len(expired) < 2 {
		t.Skipf("测试库的到期月分区不足（%v），跳过依赖视图形态", expired)
	}
	// 名字升序 = 时间升序：让最早的那条被视图挡住，其余作为"不得被牵连"的对照。
	blocked, others := expired[0], expired[1:]

	if _, err := db.Exec("DROP VIEW IF EXISTS r6s_usage_report"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE VIEW r6s_usage_report AS SELECT count(*) AS n FROM " + blocked); err != nil {
		t.Fatalf("造依赖视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r6s_usage_report") })

	logs := captureRetentionLog(t)
	err := CleanupUsageRetention(db)
	if err == nil {
		t.Fatalf("%s 被视图依赖而无法 DROP，必须 fail-loud（返回错误）", blocked)
	}
	if !strings.Contains(err.Error(), blocked) {
		t.Fatalf("聚合错误未点名失败关系 %s: %v", blocked, err)
	}
	if !strings.Contains(logs.String(), "sqlstate=2BP01") {
		t.Fatalf("失败日志缺少 SQLSTATE 原因码（运维要能看出失败原因）:\n%s", logs.String())
	}
	if !strings.Contains(logs.String(), "round summary") || !strings.Contains(logs.String(), "failures=1") {
		t.Fatalf("轮次汇总行缺 failures=1（失败条数必须可 grep）:\n%s", logs.String())
	}
	for _, rel := range others {
		if relationExists(t, db, rel) {
			t.Fatalf("%s 被与它无关的失败牵连（整轮停摆，R6-A-1 回归）", rel)
		}
	}

	// 第二次调用：仍 fail-loud（阻塞条件还在），但**其余月份继续推进** —— 不是停在同一处。
	logs2 := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("阻塞条件仍在时必须继续返回错误（fail-loud 不得退化成静默）")
	} else if !strings.Contains(err.Error(), blocked) {
		t.Fatalf("第二次调用的错误未点名 %s: %v", blocked, err)
	}
	if !strings.Contains(logs2.String(), "round summary") {
		t.Fatalf("第二次调用没有轮次汇总行（静默轮次无法发现停摆）:\n%s", logs2.String())
	}

	// 解除阻塞（运维删掉报表视图）后，下一次调用必须把这条关系清掉 = 重试能推进。
	if _, err := db.Exec("DROP VIEW IF EXISTS r6s_usage_report"); err != nil {
		t.Fatal(err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("解除阻塞后应成功清理 %s: %v", blocked, err)
	}
	if relationExists(t, db, blocked) {
		t.Fatalf("%s 在解除阻塞后仍未清掉（保留策略永久停摆）", blocked)
	}
}

// TestUsageRetentionSkipsNonDroppableRelkindWithoutStalling 覆盖形态 C：
// 月名被索引占用（relkind='I'/'i'）时既不能硬发 DROP TABLE（42809），
// 也不能因此阻断其余月份 —— 记警告、跳过、其余照清。
func TestUsageRetentionSkipsNonDroppableRelkindWithoutStalling(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	expired := expiredMonthPartitions(t, db)
	if len(expired) == 0 {
		t.Fatal("夹具无效：测试库里没有早于保留 cutoff 的月分区")
	}

	if _, err := db.Exec("DROP INDEX IF EXISTS usage_202001"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("CREATE INDEX usage_202001 ON usage (created_at)"); err != nil {
		t.Skipf("本机 PG 不能在建出与月名同名的索引（%v），跳过该形态", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP INDEX IF EXISTS usage_202001") })

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("索引占名应被**跳过**（不是失败）: %v", err)
	}
	if !relationExists(t, db, "usage_202001") {
		t.Fatal("索引被删了：服务端不得替管理员删非表对象（只允许表/视图/物化视图）")
	}
	for _, rel := range expired {
		if relationExists(t, db, rel) {
			t.Fatalf("%s 被与它无关的跳过形态牵连（R6-A-1 回归）", rel)
		}
	}
	out := logs.String()
	if !strings.Contains(out, "SKIP detached relation usage_202001") || !strings.Contains(out, "skipped=1") {
		t.Fatalf("跳过非表形态必须留下可 grep 的警告（SKIP … / skipped=1）:\n%s", out)
	}
}
