package serverstore

// R7-A 判据（第七轮审计 2026-09-24，P1-A + P2-A）：**多级分区**布局
// `usage → usage_<YYYY> → usage_<YYYYMM>` 下的清理与聚合口径。
//
// 为什么必须覆盖这一档（不能以"本仓迁移只建一级"为由跳过）：
// `migrations-pg/**` 确实只建一级月分区，所以这个形态不是迁移产物 —— 但它是
// **DBA 手写 DDL** 就能产生的合法 PG 布局（`CREATE TABLE usage_2026 PARTITION OF
// usage … PARTITION BY RANGE (created_at)` + 其下的月分区），而旧实现的后果是
// **静默金额错误**：孙辈叶子的直接父是 `usage_<YYYY>`（不是 `usage`）⇒ 被判成
// "孤儿" ⇒
//
//	A（P1）孤儿补账走 `usage ∪ 孤儿` 的 UNION ALL，而 `SELECT … FROM usage`
//	    **本来就已经包含这棵子树的行** ⇒ 同一行算两遍（真 PG 实测：同数据同一轮
//	    清理，永久日账/月账 12.5 → 25.0，且不会被后续轮次纠正），随后孤儿循环又把
//	    这株**仍然挂在 usage 上的活分区** DROP（明细真的从 usage 里消失），善后
//	    `ensureUsagePartition` 报 42P17 ⇒ 该月再建不出分区；
//	B（P2）孙辈叶子里的明细对聚合**永久不可见**（分段判据只认"直接挂在 usage 下的
//	    叶子"）⇒ 该月聚合回落账本，账本未覆盖时读数就是 0，静默偏小。
//
// 修法与取舍（写清楚，别再引入一次重复）：
//   - 归属判据改成**传递祖先**（`pg_partition_root`，见 usageRelationShape.
//     attachedToUsage）—— 挂 usage 之下的关系（不论几层）都走**不带** extraSources
//     的普通补账路径（= 不重复计）；只有**不是** usage 后代的关系才进孤儿桶，
//     并在动手前由 assertDetachedFromUsage 按 catalog 事实复检一次（双保险）。
//   - 聚合可见性选**第一条**路（分段判据按 usage 子树的实际叶子集合判定，见
//     usageAggregateSegments），而不是"清理路径先并入再删"：明细留在原地即可被
//     聚合读到，读数与账本天然同源；代价是这类深层后代分区**本轮不 DETACH/DROP**
//     （只有 usage 的直接子分区能 `ALTER TABLE usage DETACH PARTITION`，摘更深的
//     等于替管理员拆分区树）⇒ 清理记 `SKIP descendant partition …` 并计入 skipped。
//     金额侧没有代价：账本已补齐、聚合读明细，两个口径都等于真实值。
//
// 变异验证（本文件的判据必须能被打坏）：
//   - 把 attachedToUsage 退回"只看直接父"：两条 Multilevel 用例必红 —— 孙辈叶子
//     又落进孤儿桶，动手前的复检 assertDetachedFromUsage 直接 fail-loud（清理返回
//     错误、日志 `FAILED … op=orphan-ownership`、failures=1，**一分钱都不会被写成
//     两倍**），聚合用例则读数回落账本 = 0；
//   - 把 ledgerDetailSource 的一次 UNION 聚合拆成两次 UPSERT：
//     TestUsageRetentionOrphanAndUsageSameDaySumInOneAggregate 必红（同一
//     (user, model, day) 的两份金额互相覆盖成其中一份）。

import (
	"database/sql"
	"fmt"
	"math"
	"strings"
	"testing"
	"time"
)

// r7aDropDirectUsagePartitions 摘掉 usage 的全部**直接**子分区（PG 不允许区间重叠，
// 建中间父表前必须清场）。
func r7aDropDirectUsagePartitions(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_inherits i ON i.inhrelid = c.oid
JOIN pg_class p ON p.oid = i.inhparent
WHERE n.nspname = 'public' AND p.relname = 'usage'`)
	if err != nil {
		t.Fatalf("枚举 usage 的直接子分区: %v", err)
	}
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			t.Fatal(err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		t.Fatal(err)
	}
	rows.Close()
	for _, name := range names {
		if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(name)); err != nil {
			t.Fatalf("detach %s: %v", name, err)
		}
		if _, err := db.Exec("DROP TABLE IF EXISTS " + r6Quote(name)); err != nil {
			t.Fatalf("drop %s: %v", name, err)
		}
	}
}

// r7aTwoLevelLeaf 把 m 月所在的那一年改造成 `usage → usage_<YYYY> →
// usage_<YYYYMM>`（DBA 手写 DDL 形态），返回 (中间父表名, 孙辈叶子名)。
func r7aTwoLevelLeaf(t *testing.T, db *sql.DB, m time.Time) (string, string) {
	t.Helper()
	r7aDropDirectUsagePartitions(t, db)
	yearRel := fmt.Sprintf("usage_%04d", m.Year())
	leaf := "usage_" + monthKey(m)
	yearFrom := time.Date(m.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	yearTo := yearFrom.AddDate(1, 0, 0)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		r6Quote(yearRel),
		pgInstantArg(BeijingDayInstant(yearFrom)), pgInstantArg(BeijingDayInstant(yearTo)))); err != nil {
		t.Fatalf("建中间父表 %s（多级分区布局）: %v", yearRel, err)
	}
	lo := BeijingDayInstant(dayKey(m))
	hi := BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(leaf), r6Quote(yearRel), pgInstantArg(lo), pgInstantArg(hi))); err != nil {
		t.Fatalf("建孙辈叶子分区 %s: %v", leaf, err)
	}
	return yearRel, leaf
}

// r7aAncestry 返回 rel 的 (分区树传递根, 直接父表)——夹具有效性判据，判据本身
// 与产品侧的实现无关（直接读 catalog）。
func r7aAncestry(t *testing.T, db *sql.DB, rel string) (string, string) {
	t.Helper()
	var root, parent sql.NullString
	if err := db.QueryRow(`SELECT CASE WHEN c.relispartition THEN r.relname END, p.relname
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
LEFT JOIN pg_class r ON r.oid = pg_partition_root(c.oid)
WHERE c.relname = ? AND n.nspname = 'public'`, rel).Scan(&root, &parent); err != nil {
		t.Fatalf("读 %s 的分区树位置: %v", rel, err)
	}
	return root.String, parent.String
}

// r7aRawDetailCost 直接对 usage **父表**求和某北京月的明细金额（物理事实，不经过
// 分段判据）：用作夹具有效性与"清理前的值"的参照，避免"参照值本身依赖被审的判据"。
func r7aRawDetailCost(t *testing.T, db *sql.DB, m time.Time) float64 {
	t.Helper()
	var cost float64
	if err := db.QueryRow(`SELECT COALESCE(SUM(cost),0) FROM usage
WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		BeijingDayInstant(dayKey(m)), BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))).Scan(&cost); err != nil {
		t.Fatalf("读 %s 的明细金额: %v", monthKey(m), err)
	}
	return cost
}

// TestUsageRetentionMultilevelGrandchildKeepsLivePartitionAndAmount 是 P1-A 的判据
// （判据 a）：多级布局下一轮清理之后
//
//	ledger 行数/金额 == 窗口聚合 == 清理前的值（**不是两倍**），且孙辈叶子仍在
//	（活分区不得被删）—— 它必须仍然挂在 usage 上，而不是被 DETACH 成孤儿。
//
// 夹具：row 的确落在孙辈叶子里（tableoid 判据）、传递根确实是 usage。清理前
// 账本为空（反例保护：否则"账本等于金额"可能只是账本里本来就有），因此
// "清理前的值"取**物理明细**求和（不经过被审的分段判据，避免参照值自己依赖判据）。
func TestUsageRetentionMultilevelGrandchildKeepsLivePartitionAndAmount(t *testing.T) {
	const cost = 12.5
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m := bjMonth(2) // 早于 cutoff（当前北京月 - 1）⇒ 到期
	yearRel, leaf := r7aTwoLevelLeaf(t, db, m)
	id := usageRowAt(t, db, uid, "m-r7a-grandchild", BeijingDayAt(m, 10), cost)

	// 夹具有效性：行真的在孙辈叶子里，且该叶子的传递根是 usage（不是孤儿）。
	if got, want := r6PartitionOf(t, db, id), leaf; got != want {
		t.Fatalf("夹具无效：行落在 %s，want %s（多级布局没铺出来）", got, want)
	}
	if root, parent := r7aAncestry(t, db, leaf); root != "usage" || parent != yearRel {
		t.Fatalf("夹具无效：%s 的传递根=%q 直接父=%q，want root=usage parent=%s", leaf, root, parent, yearRel)
	}
	if rows0, amount0 := r6LedgerStats(t, db, m); rows0 != 0 || amount0 != 0 {
		t.Fatalf("夹具无效：清理前 %s 的日账已有 %d 行 / %.4f（判据要求账本由这一轮清理补齐）", monthKey(m), rows0, amount0)
	}
	// "清理前的值"取**物理明细**（不经过分段判据）：真实发生的金额。
	before := r7aRawDetailCost(t, db, m)
	if math.Abs(before-cost) > 1e-9 {
		t.Fatalf("夹具无效：清理前 %s 的明细金额 %.4f，want %.4f", monthKey(m), before, cost)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("多级布局的到期月不得让清理失败（它是 usage 的**后代**分区，走普通补账路径）: %v\n日志:\n%s",
			err, logs.String())
	}
	out := logs.String()
	if !strings.Contains(out, "failures=0") {
		t.Fatalf("本轮清理必须零失败（failures=0）:\n%s", out)
	}
	rows, amount := r6LedgerStats(t, db, m)
	if rows != 1 || math.Abs(amount-cost) > 1e-9 {
		t.Fatalf("多级布局的永久账本 = (%d 行, %.4f)，want (1, %.4f):"+
			"孙辈叶子被判成孤儿 ⇒ `usage ∪ 孤儿` 的 UNION ALL 把同一行算两遍（金额翻倍）\n日志:\n%s",
			rows, amount, cost, out)
	}
	if !relationExists(t, db, leaf) {
		t.Fatalf("%s 被清理 DROP 了：它仍然挂在 usage 上（活分区），清理只能补账、不能删它\n日志:\n%s", leaf, out)
	}
	if root, parent := r7aAncestry(t, db, leaf); root != "usage" || parent != yearRel {
		t.Fatalf("清理后 %s 的分区树位置变了：传递根=%q 直接父=%q，want root=usage parent=%s（活分区不得被 DETACH）",
			leaf, root, parent, yearRel)
	}
	after := r6SumCost(t, db, m, m.AddDate(0, 1, -1))
	if math.Abs(after-before) > 1e-9 {
		t.Fatalf("清理后 %s 的聚合从 %.4f 变成 %.4f（金额被重复计数或明细被删）", monthKey(m), before, after)
	}
	if math.Abs(after-amount) > 1e-9 {
		t.Fatalf("清理后 %s 的聚合 %.4f ≠ 账本 %.4f（两个口径分叉）", monthKey(m), after, amount)
	}
	if !strings.Contains(out, "SKIP descendant partition "+leaf) {
		t.Fatalf("深层后代分区必须留下可 grep 的 SKIP 说明（不 DETACH/DROP 的理由）:\n%s", out)
	}
}

// TestUsageRetentionMultilevelGrandchildDetailVisibleBeforeCleanup 是 P2-A 的判据
// （判据 b）：**不经任何清理**，孙辈叶子里的明细就必须被 UsageAggregateWithLedger
// 读到（等于明细值）。
//
// 旧实现的分段判据只认"直接挂在 usage 下的叶子"⇒ 该月被判成"没有明细分区"⇒
// 聚合回落账本（账本还没覆盖 ⇒ 0），而明细真实存在于 `SELECT … FROM usage` 可见
// 的位置 —— 该月读数静默偏小（与 P1-A 是同一根因的另一半）。
func TestUsageRetentionMultilevelGrandchildDetailVisibleBeforeCleanup(t *testing.T) {
	const cost = 9.75
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m := bjMonth(2)
	_, leaf := r7aTwoLevelLeaf(t, db, m)
	id := usageRowAt(t, db, uid, "m-r7a-grandchild-agg", BeijingDayAt(m, 10), cost)
	if got := r6PartitionOf(t, db, id); got != leaf {
		t.Fatalf("夹具无效：行落在 %s，want %s", got, leaf)
	}

	// 明细确实在（父表查询可见），且账本为空 ⇒ 聚合只能从明细取值。
	var detailRows int
	var detailCost float64
	if err := db.QueryRow(`SELECT count(*), COALESCE(SUM(cost),0) FROM usage
WHERE created_at >= ?::timestamptz AND created_at < ?::timestamptz`,
		BeijingDayInstant(dayKey(m)), BeijingDayInstant(dayKey(m).AddDate(0, 1, 0))).Scan(&detailRows, &detailCost); err != nil {
		t.Fatal(err)
	}
	if detailRows != 1 || math.Abs(detailCost-cost) > 1e-9 {
		t.Fatalf("夹具无效：usage 里读到 (%d 行, %.4f)，want (1, %.4f)", detailRows, detailCost, cost)
	}
	if rows0, amount0 := r6LedgerStats(t, db, m); rows0 != 0 || amount0 != 0 {
		t.Fatalf("夹具无效：%s 的账本已有 %d 行 / %.4f（判据要求聚合走明细）", monthKey(m), rows0, amount0)
	}

	got := r6SumCost(t, db, m, m.AddDate(0, 1, -1))
	if math.Abs(got-cost) > 1e-9 {
		t.Fatalf("多级布局下 %s 的窗口聚合 %.4f ≠ 明细实际值 %.4f："+
			"孙辈叶子不被认作该月的明细来源 ⇒ 明细存在却从不被聚合（该月读数静默偏小）",
			monthKey(m), got, cost)
	}
}

// TestUsageRetentionOrphanAndUsageSameDaySumInOneAggregate 是"孤儿补账必须与 usage
// **同一次**聚合"的判据（变异②：把 UNION 拆成两次 UPSERT 即红）。
//
// 夹具（同一 (user_id, model, day) 在 usage 与孤儿里**各有一行**）：
//   - retention=2 ⇒ cutoff = bjMonth(2)：m3 = bjMonth(3) 到期、m2 = bjMonth(2) 保留；
//   - `usage_<m2>` 是**更宽**的分区（覆盖 m3..m2，名字月 = m2 ⇒ 本轮不在保留期外，
//     不会被清掉），usage 里的那一行就落在它里面；
//   - `usage_<m3>` 是**独立**的孤儿表（DETACH 残留），行落在它自己的名义月内
//     ⇒ 不会走"相邻月并入"，只能靠 extraSources 参与聚合。
//
// 正确语义：孤儿与 usage 的两份金额**求和**（4.0 + 8.0 = 12.0，requests=2）。
// 分两次 UPSERT 会让后一次把前一次**覆盖**成自己那一份（实测 12.0 → 4.0 或 8.0）。
func TestUsageRetentionOrphanAndUsageSameDaySumInOneAggregate(t *testing.T) {
	const (
		usageCost  = 4.0
		orphanCost = 8.0
	)
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m2 := bjMonth(2) // 保留期内的名字月（更宽分区的名字用它）
	m3 := bjMonth(3) // 到期的名义月（孤儿表的名字用它）
	day := BeijingDayAt(m3, 10)

	// 把 m2/m3 的原月分区摘掉，改造成"更宽分区 usage_<m2> 覆盖 m3..m2"。
	r6DropMonthPartitions(t, db, m3, m2)
	wide := "usage_" + monthKey(m2)
	start := BeijingDayInstant(dayKey(m3))
	end := BeijingDayInstant(dayKey(m2).AddDate(0, 1, 0))
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
		r6Quote(wide), pgInstantArg(start), pgInstantArg(end))); err != nil {
		t.Fatalf("建更宽分区 %s: %v", wide, err)
	}
	// 独立孤儿表（同名月关系已不在 usage 下）。
	orphan := "usage_" + monthKey(m3)
	if _, err := db.Exec("CREATE TABLE " + r6Quote(orphan) + " (LIKE usage INCLUDING ALL)"); err != nil {
		t.Fatalf("建孤儿表 %s: %v", orphan, err)
	}
	if _, err := db.Exec(`INSERT INTO `+r6Quote(orphan)+
		` (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
		VALUES (?, 'm-r7a-sum', 1000, 500, 'chat', ?, ?, FALSE)`, uid, orphanCost, day); err != nil {
		t.Fatalf("往孤儿表写明细: %v", err)
	}
	id := usageRowAt(t, db, uid, "m-r7a-sum", day, usageCost)
	if got := r6PartitionOf(t, db, id); got != wide {
		t.Fatalf("夹具无效：usage 的行落在 %s，want %s", got, wide)
	}
	if root, _ := r7aAncestry(t, db, orphan); root != "" {
		t.Fatalf("夹具无效：%s 仍在分区树里（传递根=%q），它不是孤儿", orphan, root)
	}

	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("孤儿补账不得失败: %v", err)
	}
	if relationExists(t, db, orphan) {
		t.Fatalf("孤儿表 %s 补账成功后应当被清掉", orphan)
	}
	rows, amount := r6LedgerStats(t, db, m3)
	want := usageCost + orphanCost
	if rows != 1 || math.Abs(amount-want) > 1e-9 {
		t.Fatalf("同一 (user, model, day) 在 usage 与孤儿里各有一行时，账本 = (%d 行, %.4f)，want (1, %.4f):"+
			"孤儿必须与 usage 放进**同一次**聚合（UNION ALL）；拆成两次 UPSERT 会让两份金额互相覆盖成其中一份",
			rows, amount, want)
	}
	var requests int64
	if err := db.QueryRow(`SELECT requests FROM usage_daily WHERE day = ?::date AND model = 'm-r7a-sum'`,
		dayKey(m3).Format(dateFmt)).Scan(&requests); err != nil {
		t.Fatalf("读日账 requests: %v", err)
	}
	if requests != 2 {
		t.Fatalf("日账 requests=%d，want 2（usage 与孤儿各一行都参与同一次聚合）", requests)
	}
	agg := r6SumCost(t, db, m3, m3.AddDate(0, 1, -1))
	if math.Abs(agg-amount) > 1e-9 {
		t.Fatalf("清理后 %s 的聚合 %.4f ≠ 账本 %.4f", monthKey(m3), agg, amount)
	}
}

// TestUsageRetentionOrphanColumnMismatchFailsLoudWithoutDrop 是反向对照之一：
// 孤儿的**列集与 usage 不一致**（少一列账本聚合要用的列）时必须 fail-loud 且
// **不 DROP**（金额还在那条关系里，交给人工处置），绝不"按列序猜着搬运"。
//
// 与 P1-A 相反的方向同样重要：修法把"挂 usage 之下的关系"从孤儿桶里摘了出去，
// 但**真正的孤儿**（不在 usage 分区树里）仍然必须走 UNION 补账 + 失败不删。
func TestUsageRetentionOrphanColumnMismatchFailsLoudWithoutDrop(t *testing.T) {
	const cost = 6.5
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "1"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	m := bjMonth(2)
	rel := "usage_" + monthKey(m)

	// 同名真分区摘掉，改成一张**缺列**（没有 cache_prompt_tokens）的独立表。
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + r6Quote(rel)); err != nil {
		t.Fatalf("detach %s: %v", rel, err)
	}
	if _, err := db.Exec("DROP TABLE IF EXISTS " + r6Quote(rel)); err != nil {
		t.Fatalf("drop %s: %v", rel, err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + r6Quote(rel) + ` (
		id BIGSERIAL PRIMARY KEY, user_id BIGINT, model TEXT,
		prompt_tokens BIGINT, completion_tokens BIGINT,
		cost DOUBLE PRECISION, created_at TIMESTAMPTZ, estimated BOOLEAN)`); err != nil {
		t.Fatalf("建缺列孤儿表 %s: %v", rel, err)
	}
	if _, err := db.Exec(`INSERT INTO `+r6Quote(rel)+
		` (user_id, model, prompt_tokens, completion_tokens, cost, created_at, estimated)
		VALUES (?, 'm-r7a-mismatch', 1000, 500, ?, ?, FALSE)`, uid, cost, BeijingDayAt(m, 10)); err != nil {
		t.Fatalf("往缺列孤儿表写明细: %v", err)
	}
	if root, _ := r7aAncestry(t, db, rel); root != "" {
		t.Fatalf("夹具无效：%s 仍在分区树里（传递根=%q）", rel, root)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("列集不一致的孤儿补账必须 fail-loud（不许按列序猜着搬运）:\n%s", logs.String())
	}
	if !relationExists(t, db, rel) {
		t.Fatalf("列集不一致的孤儿表 %s 被 DROP 了：补账没成功就不能删（金额还在它里面）", rel)
	}
	if rows, amount := r6LedgerStats(t, db, m); rows != 0 || amount != 0 {
		t.Fatalf("补账失败却写进了账本？%s 的日账 = (%d 行, %.4f)", monthKey(m), rows, amount)
	}
	var stillThere float64
	if err := db.QueryRow("SELECT COALESCE(SUM(cost),0) FROM " + r6Quote(rel)).Scan(&stillThere); err != nil {
		t.Fatalf("读孤儿表明细: %v", err)
	}
	if math.Abs(stillThere-cost) > 1e-9 {
		t.Fatalf("孤儿表里的明细金额 %.4f ≠ %.4f（明细不许被悄悄搬走或删掉）", stillThere, cost)
	}
	out := logs.String()
	if !strings.Contains(out, "FAILED "+rel) || !strings.Contains(out, "sqlstate=42703") {
		t.Fatalf("失败必须点名关系 + 带原因码（FAILED %s / sqlstate=42703）:\n%s", rel, out)
	}
}
