package serverstore

// R10-F4 泳道 · 孤儿路径的"判定 → 动作"收口（R10-A-01 P1 / R10-A-02 P2 / R10-A-04 P2）。
//
// 被修形态（HEAD f325817ae8）：`CleanupUsageRetention` 的**孤儿分支**在
// "判定它不是 usage 的后代"（assertDetachedFromUsage，落桶后一次）与
// "`DROP TABLE IF EXISTS rel`"之间隔着 min/max 探测 → detailMonthsOutside →
// foldAdjacentMonthsIntoUsage → retentionBackfill（`usage ∪ rel` 的 UNION ALL），
// 多轮 SQL 往返（同机秒级）且**不持锁、不是一个事务**。而生产路径**会**在这个窗口里
// 把同名孤儿领回 usage 下（ensureUsagePartition → ensureDetachedOrphanMonth →
// adoptDetachedMonthPartition）。两条可判定的危害：
//
//	H1 账本翻倍：rel 已在 usage 树下 ⇒ 同一行被 `usage ∪ rel` 算两遍（12.5 → 25.0）；
//	H2 活分区被删：`DROP TABLE IF EXISTS` 对"已挂回 usage 的分区"成功（PG 允许
//	   直接 DROP 分区）⇒ 清理路径静默拆掉一块 usage 分区树；
//	   两条都**完全静默**：本轮 err=nil / failures=0 / skipped=0。
//
// 另外两条同族/派生：
//
//	R10-A-02（P2）：轮首快照 × **本轮自己**的领回（foldAdjacentMonthsIntoUsage 的
//	ensureUsagePartition 把相邻月的同名孤儿 adopt 回来）⇒ 后面轮到它时复检命中
//	"它成了 usage 的后代" ⇒ 旧实现 noteFailure ⇒ 整轮非 nil ⇒ 管理端保存保留期
//	500「保留清理失败」，而失败主体正是**本轮自愈成功**的证据；
//	R10-A-04（P2）：assertDetachedFromUsage 是"账本不许翻倍 + 不许删活分区"的**唯一**
//	守卫，而此前掏空它没有任何既有用例变红（审计方实测：serverstore 全量 168.5s
//	只有新探针红）——本文件既复现那条判据（TestR10F4OrphanBucketClassificationIsTransitive
//	直接断言落桶传递性 + 判据本身报错），又用竞态用例打坏它。
//
// 复跑（真 PG，与 CI 同形）：
//
//	docker exec pg-test psql -U postgres -c "CREATE DATABASE r10f4"
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10f4 \
//	  go test ./internal/serverstore/ -run 'TestR10F4(Orphan|StaleOrphan)' -count=1 -v

import (
	"database/sql"
	"fmt"
	"testing"
	"time"
)

// r10f4BuildDetachedMonthOrphan 造出 R9D-00 形态的孤儿：
// 年父表 `usage_<YYYY>`（曾挂在 usage 下）+ 月叶子 `usage_<YYYYMM>`，
// 插入一行后把**年父表**从 usage 摘走 ⇒ 月叶子成了"另一株 public 分区树里的分区"。
//
// 返回 (叶子关系名, 年父表名, 该月)。
func r10f4BuildDetachedMonthOrphan(t *testing.T, db *sql.DB, monthsAgo int) (string, string, time.Time) {
	t.Helper()
	r9c2ResetUsageMonthRelations(t, db)
	for _, stmt := range []string{
		"TRUNCATE TABLE usage RESTART IDENTITY CASCADE",
		"TRUNCATE TABLE usage_daily",
		"TRUNCATE TABLE usage_monthly",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatalf("设置保留期: %v", err)
	}
	m := BeijingMonth(time.Now()).AddDate(0, -monthsAgo, 0)
	yearStart := dayKey(time.Date(m.Year(), time.January, 1, 0, 0, 0, 0, time.UTC))
	yearEnd := yearStart.AddDate(1, 0, 0)
	parent := fmt.Sprintf("usage_%d", m.Year())
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		quoteRelationIdent(parent), pgInstantArg(BeijingDayInstant(yearStart)),
		pgInstantArg(BeijingDayInstant(yearEnd)))); err != nil {
		t.Fatalf("建年父表 %s: %v", parent, err)
	}
	rel := "usage_" + monthKey(m)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(rel), quoteRelationIdent(parent),
		pgInstantArg(BeijingDayInstant(dayKey(m))),
		pgInstantArg(BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建月叶子 %s: %v", rel, err)
	}
	return rel, parent, m
}

// r10f4InUsageTree 返回"rel 此刻是不是 public.usage 的后代分区"（catalog 事实，
// 判据与产品代码的实现无关：直接读 pg_partition_root 的 oid 比较）。
func r10f4InUsageTree(t *testing.T, db *sql.DB, rel string) bool {
	t.Helper()
	var attached bool
	if err := db.QueryRow(`SELECT COALESCE(c.relispartition AND pg_partition_root(c.oid) = to_regclass('public.usage'), false)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&attached); err != nil {
		t.Fatalf("读 %s 的传递根: %v", rel, err)
	}
	return attached
}

// TestR10F4OrphanReattachedInsideCleanupWindow 是 H1/H2 的确定性复现（R10-A-01）。
//
// 交错点用产品自带的**仅测试**注入点 cleanupDetachedStepHook（step="detail-months"：
// min/max 探测之后、detailMonthsOutside 之前 —— 正是"判据已过、动作未做"的窗口），
// 在其中调用**生产路径** ensureUsagePartition（写路径/启动账本重建用的同一个入口）
// 把该月分区领回 usage 下，然后放行清理。
//
// 修复后的判据（三条一起成立才算通过）：
//
//	H1 账本恰好一份（rows=1, cost=12.5000）—— 归属在动手时已变 ⇒ 补账必须走
//	   **不带额外来源**的普通口径（它的行本来就在 `SELECT … FROM usage` 里）；
//	H2 活分区既没被 DROP，也仍在 usage 分区树下；
//	H3 这是**良性 deferred**：err=nil / failures=0 / cleared_detached=0（不动数据、
//	   不记失败，留给下一轮的普通分区路径）。
func TestR10F4OrphanReattachedInsideCleanupWindow(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	rel, parent, m := r10f4BuildDetachedMonthOrphan(t, db, 7)
	row := r9c2Row{model: "m-r10f4-reattach", day: m, cost: 12.5}
	r9c2InsertRow(t, db, rel, uid, row)

	// 摘走整株子树（受支持的运维动作，R9D-00 的入口）⇒ rel 变成同名孤儿。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}
	if r10f4InUsageTree(t, db, rel) {
		t.Fatalf("前置不成立：%s 仍在 usage 分区树里", rel)
	}

	reattached := false
	cleanupDetachedStepHook = func(gotRel, step string) {
		if gotRel != rel || step != "detail-months" || reattached {
			return
		}
		reattached = true
		// 生产入口：写路径/启动账本重建都是经这里把同名孤儿领回 usage。
		if err := ensureUsagePartition(db, m); err != nil {
			t.Errorf("窗口内领回 %s 失败（用例装置失效）: %v", rel, err)
			return
		}
		if !r10f4InUsageTree(t, db, rel) {
			t.Errorf("窗口内领回未生效：%s 仍不在 usage 分区树里", rel)
		}
		t.Logf("R10F4：在 %q 窗口内把 %s 领回 usage 下（生产 adopt 路径）", step, rel)
	}
	t.Cleanup(func() { cleanupDetachedStepHook = nil })

	roundErr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	t.Logf("round err=%v failures=%d skipped=%d cleared_detached=%d", roundErr, st.Failures, st.Skipped, st.ClearedDetached)
	if !reattached {
		t.Fatalf("清理没有到达 detail-months 挂钩（用例装置失效）")
	}

	// H1：永久账本不得被算两遍（`usage ∪ rel` 且 rel 已在 usage 树下 ⇒ 同一行两次）。
	n, cost := r9c2LedgerCost(t, db, row.day, row.model)
	t.Logf("H1 账本读数：rows=%d cost=%.4f（单份应为 %.4f）", n, cost, row.cost)
	if n != 1 || cost > row.cost+1e-9 {
		t.Errorf("H1 账本被并发领回污染：%s 的行在补账时既属于 usage 又作为额外来源参与 UNION ALL，"+
			"usage_daily 记成 %.4f（rows=%d），应为 1 行 %.4f（R7-A 的 assertDetachedFromUsage 唯一要防的就是这条）",
			rel, cost, n, row.cost)
	}

	// H2：已经回到 usage 分区树下的**活分区**不得被本轮 DROP（服务端不替管理员拆分区树）。
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("H2 %s 已被清理路径 DROP，而它此刻是 usage 的分区（PG 允许直接 DROP 分区 ⇒ 静默拆树）", rel)
	} else if !r10f4InUsageTree(t, db, rel) {
		t.Errorf("H2 %s 仍在盘上但已不在 usage 分区树下（分区树被拆）", rel)
	}

	// H3：良性 deferred —— 不动数据、不记失败、也不算"回收了一条"。
	if roundErr != nil {
		t.Errorf("H3 归属在动手时已变 ⇒ 必须良性返回 nil（R10-A-01/A-02：自愈不是失败）: %v", roundErr)
	}
	if st.Failures != 0 {
		t.Errorf("H3 良性 deferred 不得计入失败: failures=%d", st.Failures)
	}
	if st.ClearedDetached != 0 {
		t.Errorf("H3 一行数据都没动，不得记成 cleared_detached=%d", st.ClearedDetached)
	}
}

// TestR10F4OrphanReattachPGDropSemantics 把 H2 依赖的 PG 语义单独钉住：
// `DROP TABLE <partition>` 对**仍挂在父表下的分区**是成功的（不是 fake 出来的），
// 且父表随即对该窗口失去路由（23514）。判据与产品代码无关，只测 PG 事实 ——
// 没有这条事实，H2 就只是"看起来危险"。
func TestR10F4OrphanReattachPGDropSemantics(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	rel, _, m := r10f4BuildDetachedMonthOrphan(t, db, 7)
	if _, err := db.Exec("DROP TABLE " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("DROP 一个仍挂在父表下的分区必须成功（H2 的前提）: %v", err)
	}
	var exists bool
	if err := db.QueryRow(`SELECT to_regclass('public.'||$1) IS NOT NULL`, rel).Scan(&exists); err != nil {
		t.Fatal(err)
	}
	if exists {
		t.Fatalf("DROP TABLE 之后 %s 仍然存在", rel)
	}
	t.Logf("PG 语义确认：DROP TABLE %s（挂在父表下的分区）成功；窗口 %s 从此没有分区", rel, monthKey(m))
}

// TestR10F4StaleOrphanSnapshotIsBenignSelfHeal 是 R10-A-02 的确定性复现（修复后语义）。
//
// 夹具（与审计方探针同形）：
//   - A = 普通表 `usage_<m1>`（无分区身份的表形态孤儿），持有一行**落在 m2** 的明细
//     ⇒ 清理处理 A 时必然走"相邻月并入"分支；
//   - B = `usage_<m2>`，是另一株（已脱离 usage 的）public 分区树里的叶子
//     ⇒ 并入分支里的 ensureUsagePartition(m2) 会把它**领回** usage 下。
//
// m1 = now-9、m2 = now-8（都早于 cutoff = now-6），且 monthKey(m1) < monthKey(m2)
// ⇒ 轮首快照的顺序保证 A 先被处理、B 后被动到（B 那时已经变成 attached）。
//
// 修复后的判据：① B 被本轮自己领回（自愈成功）；② 本轮**不记失败**（err=nil /
// failures=0）—— 旧实现把它记成 orphan-ownership 的"判据回归"；
// ③ 金额侧仍然正确（并入 + 补账只算一次）；④ B **没被删**（它已是 usage 的分区）。
func TestR10F4StaleOrphanSnapshotIsBenignSelfHeal(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	// B 及其所在的"另一株"分区树（复用上面的构造器，只是月份更早）。
	bRel, bParent, bMonth := r10f4BuildDetachedMonthOrphan(t, db, 8)
	now := BeijingMonth(time.Now())
	m1 := now.AddDate(0, -9, 0)
	aRel := "usage_" + monthKey(m1)
	if _, err := db.Exec("CREATE TABLE " + quoteRelationIdent(aRel) + " (LIKE usage INCLUDING DEFAULTS)"); err != nil {
		t.Fatalf("建表形态孤儿 %s: %v", aRel, err)
	}
	uid := mustUserID(t, db)
	row := r9c2Row{model: "m-r10f4-stale", day: bMonth, cost: 4.25}
	if _, err := db.Exec("INSERT INTO "+quoteRelationIdent(aRel)+
		` (id, user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		 VALUES (?, ?, ?, 10, 10, 'chat', ?, ?, FALSE)`,
		900001, uid, row.model, row.cost, BeijingDayAt(dayKey(bMonth), 3)); err != nil {
		t.Fatalf("往 %s 插入落在 %s 的明细: %v", aRel, monthKey(bMonth), err)
	}
	// B 所在的那株树必须已经从 usage 摘走。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(bParent)); err != nil {
		t.Fatalf("摘走 %s 所在子树: %v", bRel, err)
	}
	if r10f4InUsageTree(t, db, bRel) {
		t.Fatalf("前置不成立：%s 仍在 usage 分区树里", bRel)
	}
	if got := r9d00DirectParent(t, db, aRel); got != "" {
		t.Fatalf("前置不成立：%s 应当是普通表（无父表），实得 %q", aRel, got)
	}

	roundErr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	t.Logf("round err=%v failures=%d skipped=%d cleared_detached=%d", roundErr, st.Failures, st.Skipped, st.ClearedDetached)
	t.Logf("失败关系(failed_relations)=%v unreclaimed=%v", st.FailedRelations, st.Unreclaimed)

	// ① 本轮**自己**把 B 领回了 usage 树下（adopt 自愈成功）。
	if !r10f4InUsageTree(t, db, bRel) {
		t.Fatalf("本轮自己的 adopt 未生效：%s 仍不在 usage 分区树里（用例装置失效）", bRel)
	}
	// ② 自愈**不是**失败（旧实现：assertDetachedFromUsage 命中 ⇒ noteFailure ⇒ 整轮非 nil
	//    ⇒ 管理端 PUT /api/server/admin/gateway 500「保留清理失败」）。
	if roundErr != nil {
		t.Fatalf("轮首快照的过期条目被本轮自己的领回变成了失败（R10-A-02 未修）: %v", roundErr)
	}
	if st.Failures != 0 {
		t.Fatalf("自愈成功不得计入失败: failures=%d failed_relations=%v", st.Failures, st.FailedRelations)
	}
	// ③ 金额侧仍然正确（并入 + 补账只算一次）。
	if n, cost := r9c2LedgerCost(t, db, row.day, row.model); n != 1 || cost < row.cost-1e-9 || cost > row.cost+1e-9 {
		t.Errorf("账本读数 rows=%d cost=%.4f，want 1/%.4f", n, cost, row.cost)
	}
	// ④ 表形态孤儿 A 已按到期回收；B（活分区）**没被删**。
	if r9aRelationExists(t, db, aRel) {
		t.Errorf("到期的表形态孤儿 %s 未被回收", aRel)
	}
	if !r9aRelationExists(t, db, bRel) {
		t.Errorf("活分区 %s 被清理路径删掉了（它此刻是 usage 的分区）", bRel)
	}
	if st.ClearedDetached < 1 {
		t.Errorf("A 应被记成 cleared_detached≥1，实得 %d（用例的\"确实动了手\"前置不成立）", st.ClearedDetached)
	}
}

// TestR10F4OrphanBucketClassificationIsTransitive 是 R10-A-04（P2）要求的**能打坏判据**的用例。
//
// 被保护的两件事（账本翻倍 + 删活分区）唯一守卫是 assertDetachedFromUsage；而审计方
// 实测"把它整体置空 ⇒ serverstore 全量只有新探针红"。本用例把守卫的两半都钉住：
//
//  1. **落桶判据必须是传递的**（attachedToUsage = 传递根 = usage，按 oid）：多级布局
//     `usage → usage_<YYYY>[p] → usage_<YYYYMM>` 里的孙辈叶子必须落进 Partitions，
//     而不是 Orphans。判据退回"只看直接父"时这里立刻红（它会被当成孤儿 ⇒ 补账
//     `usage ∪ 孤儿` 把同一行算两遍 + DROP 掉一株活分区）。
//  2. **判据本身对"已在 usage 树下"的关系必须报错**：assertDetachedFromUsage 被掏空
//     （return nil）时这里红 —— 它是孤儿循环在动手前 fail-loud 的唯一入口。
//
// 两条都是**语义**判据（读 catalog + 调产品判据），不是字符串断言。
func TestR10F4OrphanBucketClassificationIsTransitive(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	expired := bjMonth(7)
	yearRel, leaf := r7aTwoLevelLeaf(t, db, expired)

	// 1) 落桶：孙辈叶子必须是"usage 的后代"（传递），不是孤儿。
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, rel := range tables.Partitions {
		if rel == leaf {
			found = true
		}
	}
	if !found {
		t.Fatalf("多级布局的孙辈叶子 %s 未落进 Partitions（传递祖先判据回归 ⇒ 它会被当成孤儿，"+
			"补账算两遍 + DROP 活分区）；Partitions=%v Orphans=%v",
			leaf, tables.Partitions, tables.Orphans)
	}
	for _, rel := range tables.Orphans {
		if rel == leaf {
			t.Fatalf("%s 同时落进了 Orphans（判据分叉）: Orphans=%v", leaf, tables.Orphans)
		}
	}
	shape := tables.Shapes[leaf]
	if !shape.attachedToUsage() {
		t.Errorf("%s 的形态判据 attachedToUsage()=false，want true（传递根 = usage）", leaf)
	}
	if !shape.AttachedUsage {
		t.Errorf("%s 的 SQL 事实 AttachedUsage=false，want true", leaf)
	}
	if shape.directChildOfUsage() {
		t.Errorf("%s 的直接父是 %s，directChildOfUsage() 不该为 true", leaf, yearRel)
	}
	if got := shape.Parent; got != yearRel {
		t.Errorf("%s 的直接父 = %q，want %q", leaf, got, yearRel)
	}

	// 2) 判据本身：已在 usage 树下的关系必须被拒（掏空 ⇒ 这里红）。
	if err := assertDetachedFromUsage(db, leaf); err == nil {
		t.Fatalf("assertDetachedFromUsage(%s) 必须报错（它在 usage 分区树里）；"+
			"掏空这条判据 = 账本翻倍 + 删活分区两件静默事故同时失去守卫", leaf)
	} else {
		t.Logf("判据按预期拒绝：%v", err)
	}
	// 反向对照：真正脱离 usage 的关系必须被放行（判据不是恒真/恒假）。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(yearRel)); err != nil {
		t.Fatalf("DETACH %s: %v", yearRel, err)
	}
	if r10f4InUsageTree(t, db, leaf) {
		t.Fatalf("前置不成立：%s 仍被算作 usage 的后代", leaf)
	}
	if err := assertDetachedFromUsage(db, leaf); err != nil {
		t.Fatalf("已脱离 usage 的 %s 必须被判据放行（否则孤儿路径永不工作）: %v", leaf, err)
	}
}
