package serverstore

// R9-D P0（R9D-00）+ R9-C P1（R9C-1）+ R9-D P2（R9D-05 / R9D-07）的判据。
//
// 被审形态（审计方确定性复现，父提交同样复现 ⇒ 不是第八轮回归，但它是第八轮刚修的
// R8-A-1 的**孪生未闭面**）：
//
//	管理员执行受支持的运维动作 `ALTER TABLE usage DETACH PARTITION usage_<YYYY>`
//	（把整株子树摘下来）之后，子树里**仍在保留期内**的同名孤儿叶子被
//	`probeUsagePartition` 按 relname 命中 ⇒ RootIsExpectedParent=false ⇒
//	`misboundedPartitionErr` ⇒ **该月每一次对话**都在结算前被拒
//	（网关 503 METERING_FAILED，fail-closed 不交付），三轮回合不自愈，
//	清理 err=nil/skipped=0/failures=0 且 /readyz 的 usage_retention 全绿。
//
// 判据分层（不允许只钉字符串）：
//
//	W1  自愈：当月写入恢复正常 + 明细真的落在**领回后**的月分区上 + DETACH 之前
//	    写下的明细**重新可见**（领回是数据保全的，不是"另建一张空表"）；
//	W2  自愈是**永久**的：第二次、第三次写入同样成功（判据是"每一次对话都可用"）；
//	W3  领不回时 fail-loud + **可观测**：错误带封闭 kind 与可执行运维动作，
//	    且 `CurrentUsageRetentionStatus()` 的 write_blocked_* 能区分该状态；
//	W4  有效边界（声明 ∩ 祖先）：被祖先截断的窗口**不能**被当成"已覆盖/已就绪"，
//	    要么建出顶层分区（窗口本来没被覆盖）要么 fail-loud 点名祖先（写不进去）；
//	W5  保留期内的同名孤儿**零计数不可见**被修掉（skip_reasons 里点名）。

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

// r9d00Spec 造一层"中间父表 + 当月叶子"，返回 (中间父表名, 当月叶子名, 父表窗口下界)。
//
// 中间父表 = 上个月的月名（`usage_<上月>`），边界覆盖 [上月, 下下月) —— 这正是
// `usageMonthRelationOf` 认得的名字形态，也是 R9-D 复现里用的形态。
func r9d00BuildMonthlyParentLayout(t *testing.T, db *sql.DB) (string, string) {
	t.Helper()
	now := BeijingMonth(time.Now())
	prev := now.AddDate(0, -1, 0)
	parent := "usage_" + monthKey(prev)
	leaf := "usage_" + monthKey(now)
	r7aDropDirectUsagePartitions(t, db)
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		quoteRelationIdent(parent), pgInstantArg(BeijingDayInstant(dayKey(prev))),
		pgInstantArg(BeijingDayInstant(dayKey(now).AddDate(0, 2, 0))))); err != nil {
		t.Fatalf("建中间父表 %s: %v", parent, err)
	}
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(leaf), quoteRelationIdent(parent),
		pgInstantArg(BeijingDayInstant(dayKey(now))),
		pgInstantArg(BeijingDayInstant(dayKey(now).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("建当月叶子 %s: %v", leaf, err)
	}
	return parent, leaf
}

// r9d00RowRel 返回该用户最近一条明细落在哪张关系上（tableoid 事实，不走产品判据）。
func r9d00RowRel(t *testing.T, db *sql.DB, uid int64) string {
	t.Helper()
	var rel string
	if err := db.QueryRow(`SELECT tableoid::regclass::text FROM usage WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
		uid).Scan(&rel); err != nil {
		t.Fatalf("读最新明细所在关系: %v", err)
	}
	return rel
}

// r9d00DirectParent 返回关系的直接父表名（catalog 事实）。
func r9d00DirectParent(t *testing.T, db *sql.DB, rel string) string {
	t.Helper()
	var parent string
	if err := db.QueryRow(`SELECT COALESCE(p.relname, '') FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_inherits i ON i.inhrelid = c.oid
LEFT JOIN pg_class p ON p.oid = i.inhparent
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&parent); err != nil {
		t.Fatalf("读 %s 的直接父表: %v", rel, err)
	}
	return parent
}

// r9d00VisibleRows 返回 `SELECT … FROM usage` 能看到的该用户明细行数（用户面口径）。
func r9d00VisibleRows(t *testing.T, db *sql.DB, uid int64) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow(`SELECT count(*) FROM usage WHERE user_id = $1`, uid).Scan(&n); err != nil {
		t.Fatalf("统计 usage 可见明细: %v", err)
	}
	return n
}

// TestR9D00DetachedAncestorOrphanIsAdoptedBack 是 P0 的**修后必绿**判据（W1/W2）。
//
// 修复前：DETACH 之后每一次 RecordUsage 都失败 ⇒ 网关 503 METERING_FAILED ⇒ 该月
// 全部对话不可用，且清理/readyz 全绿。
// 修复后：写路径把同名孤儿**领回** usage 下（DETACH + ATTACH 同一事务），当月写入
// 恢复，且 DETACH 之前写下的明细重新可见（领回是数据保全的动作）。
func TestR9D00DetachedAncestorOrphanIsAdoptedBack(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	parent, leaf := r9d00BuildMonthlyParentLayout(t, db)

	// ① DETACH 之前：写入正常，明细落进当月叶子。
	if _, err := RecordUsageKind(db, uid, "m-r9d00-before", 100, 50, "chat"); err != nil {
		t.Fatalf("前置不成立：DETACH 之前写入就失败: %v", err)
	}
	if got := r9d00RowRel(t, db, uid); got != leaf {
		t.Fatalf("DETACH 前明细落在 %s，want %s", got, leaf)
	}
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}
	// 前置判据：同名孤儿确实脱离了 usage 树（否则本用例什么都没测）。
	if got := r9d00DirectParent(t, db, leaf); got != parent {
		t.Fatalf("前置不成立：DETACH 之后 %s 的直接父表 = %q，want %q", leaf, got, parent)
	}
	if visible := r9d00VisibleRows(t, db, uid); visible != 0 {
		t.Fatalf("前置不成立：DETACH 之后 `SELECT … FROM usage` 仍能看到 %d 行", visible)
	}

	// ② 当月写入：必须自愈（修复前这里返回"分区树根不对"的 fail-loud 错误）。
	for i := 1; i <= 2; i++ {
		if _, err := RecordUsageKind(db, uid, "m-r9d00-after", 100, 50, "chat"); err != nil {
			t.Fatalf("第 %d 次写入必须自愈（修复前：每一次对话 503 METERING_FAILED）: %v", i, err)
		}
		// 自愈必须是**永久**的：每一次都落在同一张领回后的月分区上。
		if got := r9d00RowRel(t, db, uid); got != leaf {
			t.Fatalf("第 %d 次写入的明细落在 %s，want %s", i, got, leaf)
		}
		if got := r9d00DirectParent(t, db, leaf); got != "usage" {
			t.Fatalf("领回之后 %s 的直接父表 = %q，want \"usage\"", leaf, got)
		}
	}
	// ③ 数据保全：DETACH 之前那 1 行重新可见（领回不是"另建一张空表"）。
	if visible := r9d00VisibleRows(t, db, uid); visible != 3 {
		t.Fatalf("领回之后 `SELECT … FROM usage` 可见明细 = %d，want 3（1 行 DETACH 前的 + 2 行之后的）", visible)
	}
	// ④ 没有留下"当月不可写"的阻塞状态。
	if st := CurrentUsageRetentionStatus(); st.WriteBlocked {
		t.Fatalf("自愈成功却报了 write_blocked: %+v", st)
	}
}

// TestR9D00UnadoptableOrphanFailsLoudAndObservable 是 P0 的**另一半判据**（W3）：
// 领不回来时必须 fail-loud，且"当月不可写"必须能从 /readyz 的出口读出来。
//
// 两种领不回来的形态（判据与危害同构：都只需"当月写不进去"这一条事实）：
//
//	中间父表形态：同名孤儿 relkind='p'（自身又是分区父表）—— 领回它会连带把整棵子树
//	              搬走，服务端不替管理员拆分区树（与清理"深层后代只补账不 DETACH"
//	              同一口径）⇒ 文案按形态分流，给出"人工要决定什么"；
//	叶子但领回被挡：叶子同名孤儿的声明边界与 usage 下既有分区重叠 ⇒ ATTACH 吃 42P17
//	              ⇒ 文案给出**完整可执行**的 DETACH + ATTACH SQL。
func TestR9D00UnadoptableOrphanFailsLoudAndObservable(t *testing.T) {
	t.Run("middle_parent_orphan_is_not_reparented", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		uid := mustUserID(t, db)
		resetUsageRetentionStatusForTest()
		parent, leaf := r9d00BuildMonthlyParentLayout(t, db)
		// 把当月叶子换成"当月**中间父表**"：同名关系 relkind='p'（带一个更深的子分区）。
		if _, err := db.Exec("ALTER TABLE " + quoteRelationIdent(parent) + " DETACH PARTITION " + quoteRelationIdent(leaf)); err != nil {
			t.Fatalf("detach leaf: %v", err)
		}
		if _, err := db.Exec("DROP TABLE " + quoteRelationIdent(leaf)); err != nil {
			t.Fatalf("drop leaf: %v", err)
		}
		cur := BeijingMonth(time.Now())
		lo := pgInstantArg(BeijingDayInstant(dayKey(cur)))
		hi := pgInstantArg(BeijingDayInstant(dayKey(cur).AddDate(0, 1, 0)))
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(leaf), quoteRelationIdent(parent), lo, hi)); err != nil {
			t.Fatalf("建当月中间父表 %s: %v", leaf, err)
		}
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
			quoteRelationIdent(leaf+"_sub"), quoteRelationIdent(leaf), lo, hi)); err != nil {
			t.Fatalf("建更深叶子: %v", err)
		}
		if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
			t.Fatalf("DETACH %s: %v", parent, err)
		}

		_, werr := RecordUsageKind(db, uid, "m-r9d00-blocked", 1, 1, "chat")
		if werr == nil {
			t.Fatalf("中间父表形态的同名孤儿不该被自动领回（服务端不替管理员拆分区树）")
		}
		kind, action, _ := partitionLayoutFailure(werr)
		if kind != usagePartitionKindOrphanNameCollision {
			t.Fatalf("错误分类 = %q，want %q（err=%v）", kind, usagePartitionKindOrphanNameCollision, werr)
		}
		// 运维动作必须**可执行/可决策**：说清服务端为什么不自动做 + 人工要决定什么。
		for _, want := range []string{"relkind", "分区父表", leaf, "不会自动"} {
			if !strings.Contains(action, want) {
				t.Fatalf("运维动作文案缺少 %q（可执行性判据）: %s", want, action)
			}
		}
		assertWriteBlockedObservable(t, usagePartitionKindOrphanNameCollision)

		// 人工按文案处置（摘出同名关系并删掉）⇒ 服务端自己建出当月叶子、阻塞状态清掉。
		if _, err := db.Exec("ALTER TABLE " + quoteRelationIdent(parent) + " DETACH PARTITION " + quoteRelationIdent(leaf)); err != nil {
			t.Fatalf("人工处置（从旧父表摘出同名关系）: %v", err)
		}
		if _, err := db.Exec("DROP TABLE " + quoteRelationIdent(leaf)); err != nil {
			t.Fatalf("人工处置（删掉同名关系）: %v", err)
		}
		if _, err := RecordUsageKind(db, uid, "m-r9d00-unblocked", 1, 1, "chat"); err != nil {
			t.Fatalf("人工处置之后必须恢复: %v", err)
		}
		if st := CurrentUsageRetentionStatus(); st.WriteBlocked {
			t.Fatalf("恢复写入之后阻塞状态必须被清掉: %+v", st)
		}
	})

	t.Run("leaf_orphan_adoption_blocked_by_overlap", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		uid := mustUserID(t, db)
		resetUsageRetentionStatusForTest()
		cur := BeijingMonth(time.Now())
		parent := "usage_" + monthKey(cur.AddDate(0, -1, 0))
		leaf := "usage_" + monthKey(cur)
		next := "usage_" + monthKey(cur.AddDate(0, 1, 0))
		r7aDropDirectUsagePartitions(t, db)
		// 旧树：中间父表 [上月, 下下月) + 同名叶子，但叶子**声明**覆盖两个月。
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(parent), pgInstantArg(BeijingDayInstant(dayKey(cur.AddDate(0, -1, 0)))),
			pgInstantArg(BeijingDayInstant(dayKey(cur).AddDate(0, 2, 0))))); err != nil {
			t.Fatalf("建旧树中间父表 %s: %v", parent, err)
		}
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
			quoteRelationIdent(leaf), quoteRelationIdent(parent),
			pgInstantArg(BeijingDayInstant(dayKey(cur))),
			pgInstantArg(BeijingDayInstant(dayKey(cur).AddDate(0, 2, 0))))); err != nil {
			t.Fatalf("建同名叶子 %s: %v", leaf, err)
		}
		if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
			t.Fatalf("DETACH %s: %v", parent, err)
		}
		// usage 下有一个**下个月**的正常分区 ⇒ 领回（ATTACH 两个月）必然 42P17 overlap。
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s')",
			quoteRelationIdent(next), pgInstantArg(BeijingDayInstant(dayKey(cur.AddDate(0, 1, 0)))),
			pgInstantArg(BeijingDayInstant(dayKey(cur).AddDate(0, 2, 0))))); err != nil {
			t.Fatalf("建下个月分区 %s: %v", next, err)
		}

		_, werr := RecordUsageKind(db, uid, "m-r9d00-overlap", 1, 1, "chat")
		if werr == nil {
			t.Fatalf("领回与既有分区重叠时必须 fail-loud（不得静默把两个月的数据塞进一张月名分区）")
		}
		kind, action, _ := partitionLayoutFailure(werr)
		if kind != usagePartitionKindOrphanNameCollision {
			t.Fatalf("错误分类 = %q，want %q（err=%v）", kind, usagePartitionKindOrphanNameCollision, werr)
		}
		for _, want := range []string{"BEGIN;", "DETACH PARTITION", "ATTACH PARTITION", parent, leaf} {
			if !strings.Contains(action, want) {
				t.Fatalf("运维动作文案缺少 %q（可执行性判据）: %s", want, action)
			}
		}
		assertWriteBlockedObservable(t, usagePartitionKindOrphanNameCollision)

		// 领回失败必须**原子**：事务回滚 ⇒ 同名关系仍在旧父表下（没有半成品状态）。
		if got := r9d00DirectParent(t, db, leaf); got != parent {
			t.Fatalf("领回失败之后 %s 的直接父表 = %q，want %q（DDL 必须整体回滚）", leaf, got, parent)
		}
	})
}

// assertWriteBlockedObservable 断言"当月不可写"在 /readyz 的出口上可区分（R9D-00 的
// 第 2 条硬要求：不允许"该月写入永久 503 而所有健康面报绿"）。
func assertWriteBlockedObservable(t *testing.T, wantKind string) {
	t.Helper()
	st := CurrentUsageRetentionStatus()
	if !st.WriteBlocked {
		t.Fatalf("写入被挡却没有任何健康出口能区分: %+v", st)
	}
	if st.WriteBlockedMonth != monthKey(BeijingMonth(time.Now())) {
		t.Fatalf("write_blocked_month = %q，want %q", st.WriteBlockedMonth, monthKey(BeijingMonth(time.Now())))
	}
	if st.WriteBlockedKind != wantKind {
		t.Fatalf("write_blocked_kind = %q，want %q", st.WriteBlockedKind, wantKind)
	}
	if st.WriteBlockedAction == "" || st.WriteBlockedError == "" || st.WriteBlockedSince == "" || st.WriteBlockedCount < 1 {
		t.Fatalf("write_blocked_* 缺少动作/错误/起始时刻/计数: %+v", st)
	}
}

// TestR9C1EffectiveBoundBeatsDeclaredBound 是 R9C-1（P1）的判据（W4）。
//
// PG 对子分区的**有效**约束 = 声明边界 ∩ 全部祖先边界；而 `CREATE … PARTITION OF`
// 与 `ATTACH PARTITION` 都**不校验包含关系**（PG 18.6 实测）⇒ 只看自己的
// relpartbound 会把"写入根本到不了的窗口"判成已覆盖。两种受害形态：
//
//	c6  目标月叶子不存在，扫描误判"窗口已被孙辈覆盖" ⇒ 不建分区 ⇒ INSERT 23514；
//	c11 目标月叶子存在（自己边界覆盖、但祖先把它截掉）⇒ 判"就绪" ⇒ INSERT 23514。
//
// 修复后：c6 必须建出顶层月分区并写入成功；c11 必须 fail-loud 且**点名祖先**。
func TestR9C1EffectiveBoundBeatsDeclaredBound(t *testing.T) {
	t.Run("c6_declared_bound_exceeds_ancestor", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		uid := mustUserID(t, db)
		target := BeijingMonth(time.Now())
		// 中间父表：[target-1 月, target+1 月) 声明为分区父表；它的祖先用法是 usage。
		mid := "usage_2026"
		leafName := "usage_" + monthKey(target.AddDate(0, -1, 0))
		r7aDropDirectUsagePartitions(t, db)
		// 中间父表只覆盖 [年初, target 月首)：顶层路由到不了 target 月。
		yearStart := pgInstantArg(BeijingDayInstant(dayKey(time.Date(target.Year(), 1, 1, 0, 0, 0, 0, time.UTC))))
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(mid), yearStart,
			pgInstantArg(BeijingDayInstant(dayKey(target))))); err != nil {
			t.Fatalf("建中间父表 %s: %v", mid, err)
		}
		// 孙辈子分区**声明**覆盖 target 月（但祖先边界把它截在外面）。
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
			quoteRelationIdent(leafName), quoteRelationIdent(mid),
			pgInstantArg(BeijingDayInstant(dayKey(target.AddDate(0, -1, 0)))),
			pgInstantArg(BeijingDayInstant(dayKey(target.AddDate(0, 1, 0)))))); err != nil {
			t.Fatalf("建孙辈子分区 %s: %v", leafName, err)
		}
		// PG 事实：顶层路由到不了 target 月（声明边界说覆盖，写入说没有）。
		var probe partitionProbe
		var err error
		if probe, err = probeUsagePartition(db, leafName, "usage"); err != nil {
			t.Fatal(err)
		}
		if _, _, readable := partitionBoundCoverage(usageMonthPartitionSpec(target), probe.Bound); !readable {
			t.Fatalf("夹具的声明边界应当可读")
		}
		if covered, _ := descendantEffectiveCoverage(
			usageMonthPartitionSpec(target),
			usageTreeParentIndex(mustDescendants(t, db, "usage")),
			mustDescendant(t, db, leafName)); covered {
			t.Fatalf("前置不成立：有效边界判据仍认为 target 月被覆盖（声明边界覆盖、祖先把它截掉了）")
		}

		if _, err := RecordUsageKind(db, uid, "m-r9c1-c6", 100, 50, "chat"); err != nil {
			t.Fatalf("c6：窗口其实没被覆盖 ⇒ 必须建出顶层月分区并写入成功（修复前：误判已覆盖 ⇒ INSERT 23514）: %v", err)
		}
		if got := r9d00RowRel(t, db, uid); got != "usage_"+monthKey(target) {
			t.Fatalf("c6：明细落在 %s，want usage_%s", got, monthKey(target))
		}
		if got := r9d00DirectParent(t, db, "usage_"+monthKey(target)); got != "usage" {
			t.Fatalf("c6：新建的月分区直接父表 = %q，want \"usage\"", got)
		}
	})

	t.Run("c11_same_name_leaf_cut_off_by_ancestor", func(t *testing.T) {
		db, cleanup := NewTestDB(t)
		defer cleanup()
		uid := mustUserID(t, db)
		target := BeijingMonth(time.Now())
		mid := "usage_2026"
		leaf := "usage_" + monthKey(target)
		r7aDropDirectUsagePartitions(t, db)
		// 祖先声明到 target 月中为止（把 target 月的后半个月截掉）。
		yearStart := pgInstantArg(BeijingDayInstant(dayKey(time.Date(target.Year(), 1, 1, 0, 0, 0, 0, time.UTC))))
		midCut := pgInstantArg(BeijingDayInstant(dayKey(target)).Add(15 * 24 * time.Hour))
		if _, err := db.Exec(fmt.Sprintf(
			"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
			quoteRelationIdent(mid), yearStart, midCut)); err != nil {
			t.Fatalf("建中间父表 %s: %v", mid, err)
		}
		if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
			quoteRelationIdent(leaf), quoteRelationIdent(mid),
			pgInstantArg(BeijingDayInstant(dayKey(target))),
			pgInstantArg(BeijingDayInstant(dayKey(target).AddDate(0, 1, 0))))); err != nil {
			t.Fatalf("建当月叶子 %s: %v", leaf, err)
		}
		_, werr := RecordUsageKind(db, uid, "m-r9c1-c11", 1, 1, "chat")
		if werr == nil {
			t.Fatalf("c11：被祖先截断的窗口必须 fail-loud（修复前：判「就绪」⇒ 裸 23514）")
		}
		kind, action, _ := partitionLayoutFailure(werr)
		if kind != usagePartitionKindAncestorExcludes {
			t.Fatalf("错误分类 = %q，want %q（err=%v）", kind, usagePartitionKindAncestorExcludes, werr)
		}
		if !strings.Contains(action, mid) || !strings.Contains(action, "祖先") {
			t.Fatalf("运维动作必须点名祖先链（否则管理员会去改一个本来就对的分区）: %s", action)
		}
		if st := CurrentUsageRetentionStatus(); !st.WriteBlocked || st.WriteBlockedKind != usagePartitionKindAncestorExcludes {
			t.Fatalf("c11 的阻塞必须在可观测面上可区分: %+v", st)
		}
	})
}

// mustDescendants / mustDescendant 是判据用的 catalog 读取（不走产品判据）。
func mustDescendants(t *testing.T, db *sql.DB, root string) []partitionDescendant {
	t.Helper()
	desc, err := usageTreeDescendants(db, root)
	if err != nil {
		t.Fatalf("枚举 %s 的后代: %v", root, err)
	}
	return desc
}

func mustDescendant(t *testing.T, db *sql.DB, rel string) partitionDescendant {
	t.Helper()
	for _, d := range mustDescendants(t, db, "usage") {
		if d.Rel == rel {
			return d
		}
	}
	t.Fatalf("%s 不在 usage 的后代清单里", rel)
	return partitionDescendant{}
}

// TestR9D07RetainedOrphanIsCountedInSkipReasons 覆盖 R9D-07（P2）：
// 保留期内的同名孤儿此前在 skip_reasons 里**零计数**（`continue`），于是"有一条关系
// 在挡着当月写入"与"没有可回收的关系"在运维面上逐字同形。
func TestR9D07RetainedOrphanIsCountedInSkipReasons(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	resetUsageRetentionStatusForTest()
	parent, leaf := r9d00BuildMonthlyParentLayout(t, db)
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("保留期内的孤儿不该让清理失败（不能删保留期内的明细）: %v", err)
	}
	st := CurrentUsageRetentionStatus()
	if st.SkippedByReason[usageSkipOrphanRetained] < 1 {
		t.Fatalf("保留期内的同名孤儿必须在 skip_reasons 里点名（修复前零计数）: %+v", st)
	}
	if !strings.Contains(strings.Join(st.Unreclaimed, ","), leaf) {
		t.Fatalf("未回收清单必须点名 %s: %v", leaf, st.Unreclaimed)
	}
	if _, err := db.Exec("SELECT count(*) FROM " + quoteRelationIdent(leaf)); err != nil {
		t.Fatalf("保留期内的孤儿不得被删掉: %v", err)
	}
}

// TestR9D05ConfiguredMonthsZeroIsNotAnObservation 覆盖 R9D-05（P2）：
// configured_months 的 0 在本域里等于"永不删除"，而进程跑过第一轮之前它也是 0 ——
// 同一个字段承载两种语义。判据：显式给出"这个值是观测值"的一位。
func TestR9D05ConfiguredMonthsZeroIsNotAnObservation(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	resetUsageRetentionStatusForTest()
	if st := CurrentUsageRetentionStatus(); st.ConfiguredMonthsKnown {
		t.Fatalf("还没跑过任何一轮时 configured_months_known 必须为 false（零值不是观测）: %+v", st)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "0"); err != nil {
		t.Fatal(err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("保留期 0（永不删除）不该失败: %v", err)
	}
	st := CurrentUsageRetentionStatus()
	if !st.ConfiguredMonthsKnown || st.ConfiguredMonths != 0 {
		t.Fatalf("跑过一轮之后必须是「观测到 0（永不删除）」: %+v", st)
	}
}

// TestR9C4FailedRoundKeepsLastRetentionObservation 覆盖 R9C-4（P3）的第一条：
// `/readyz.usage_retention.configured_months` 在**失败轮次**读作 0，而 0 在本域里的
// API 语义是"永不删除"（= 保留策略关掉了）—— 监视器会读到与事实相反的结论。
//
// 判据：读不到生效保留期的那一轮**不得**把上一次的观测值覆盖成 0；本轮失败由
// failed_rounds / last_error 表达。
func TestR9C4FailedRoundKeepsLastRetentionObservation(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	resetUsageRetentionStatusForTest()
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("第一轮（正常）不该失败: %v", err)
	}
	st := CurrentUsageRetentionStatus()
	if !st.ConfiguredMonthsKnown || st.ConfiguredMonths != 6 {
		t.Fatalf("第一轮之后必须观测到 6: %+v", st)
	}
	// 让下一轮在读保留期时就失败（settings 表不可读）⇒ 该轮什么也没观测到。
	// 注意 settings 有 30s 进程内缓存，必须显式失效，否则这一轮会命中缓存、测不到。
	if _, err := db.Exec("ALTER TABLE settings RENAME TO settings_hidden"); err != nil {
		t.Fatalf("隐藏 settings 表: %v", err)
	}
	InvalidateSettings()
	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("settings 读不到时清理必须 fail-loud（不得静默按缺省继续）")
	}
	st2 := CurrentUsageRetentionStatus()
	if st2.FailedRounds != 1 || st2.LastError == "" {
		t.Fatalf("失败轮次必须记进 failed_rounds / last_error: %+v", st2)
	}
	if st2.ConfiguredMonths != 6 || !st2.ConfiguredMonthsKnown {
		t.Fatalf("失败轮次不得把已观测到的保留期写成 0（0 = 永不删除，语义相反）: %+v", st2)
	}
	if st2.CutoffMonth != st.CutoffMonth {
		t.Fatalf("失败轮次不得清掉已观测到的 cutoff_month: got %q want %q", st2.CutoffMonth, st.CutoffMonth)
	}
}

// TestR9C4LastRoundAtIsTheRoundEnd 覆盖 R9C-4 的第二条：`last_round_at` 记的是轮次
// **开始**而文档写"结束"。判据不能只断言"字段非空"（那样两种实现都绿）—— 这里让
// 一轮清理**确定性地**阻塞 ~400ms，再断言 last_round_at 落在**结束侧**：
// 只记开始时刻的实现会给出 ≈0 的差值。
func TestR9C4LastRoundAtIsTheRoundEnd(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	resetUsageRetentionStatusForTest()
	if err := SetSetting(db, RetentionMonthsSetting, "6"); err != nil {
		t.Fatal(err)
	}
	// 用另一条连接对 settings 拿 ACCESS EXCLUSIVE：清理的第一步（读保留期）必然阻塞。
	blocker, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blocker.Exec("LOCK TABLE settings IN ACCESS EXCLUSIVE MODE"); err != nil {
		t.Fatalf("锁 settings: %v", err)
	}
	// settings 有 30s 进程内缓存：必须失效，否则第一步根本不碰表、测不到阻塞。
	InvalidateSettings()
	started := time.Now()
	done := make(chan error, 1)
	go func() { done <- CleanupUsageRetention(db) }()
	// 阻塞 2s（> 1s）：`last_round_at` 是 RFC3339（**秒级**），解析回来最多比真实时刻早
	// 1s —— 判据阈值必须大于这个截断误差，否则"正确实现"也会随机落在负侧（首轮全量
	// 跑就踩到过：delta = -478ms，纯属秒截断）。
	time.Sleep(2 * time.Second)
	if err := blocker.Commit(); err != nil {
		t.Fatalf("放锁: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("清理失败: %v", err)
	}
	st := CurrentUsageRetentionStatus()
	if st.LastRoundAt == "" {
		t.Fatalf("last_round_at 为空 —— 运维无法回答「最近一轮何时跑的」")
	}
	at, err := time.Parse(time.RFC3339, st.LastRoundAt)
	if err != nil {
		t.Fatalf("last_round_at 必须是 RFC3339: %q (%v)", st.LastRoundAt, err)
	}
	if elapsed := at.Sub(started); elapsed < time.Second {
		t.Fatalf("last_round_at 落在开始侧（距开始 %v，本轮至少阻塞了 2s；RFC3339 只到秒，容差 1s）"+
			"—— 语义必须是最近一轮结束的时刻", elapsed)
	}
	if elapsed := at.Sub(started); elapsed > 30*time.Second {
		t.Fatalf("last_round_at 距开始 %v，超出合理范围", elapsed)
	}
}

// TestR9D00StaleProbeAfterConcurrentAdoptionIsBenign 钉住"并发领回的良性复检"（R9D-00 的
// 自愈路径在**并发**下的表现）：多个请求同时撞上同一个同名孤儿时只有一个能完成
// DETACH+ATTACH，其余请求手里是**动手之前**的目录观察 ⇒ 它们的 DETACH 会报"它不是那个
// 父表的分区"。判据：复检 catalog（已就绪 ⇒ 按良性处理），不让第一个胜者之外的用户吃
// 一次 503。
//
// 确定性：直接构造"过期观察"这一事实（先取 probe，再由别人完成领回），不靠 sleep 猜时序。
func TestR9D00StaleProbeAfterConcurrentAdoptionIsBenign(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	uid := mustUserID(t, db)
	parent, leaf := r9d00BuildMonthlyParentLayout(t, db)
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(parent)); err != nil {
		t.Fatalf("DETACH %s: %v", parent, err)
	}
	spec := usageMonthPartitionSpec(BeijingMonth(time.Now()))
	// ① 写路径的目录观察（真实路径里就是 ensureRangePartition 里那一次 probeUsagePartition）。
	probe, err := probeUsagePartition(db, spec.relation(), spec.parent)
	if err != nil {
		t.Fatalf("探测: %v", err)
	}
	if probe.RootIsExpectedParent {
		t.Fatalf("前置不成立：%s 此时不是同名孤儿（root=%q）", spec.relation(), probe.Root)
	}
	// ② 并发胜者替它完成领回（与产品同一动作、单事务）。
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec("ALTER TABLE " + quoteRelationIdent(parent) + " DETACH PARTITION " + quoteRelationIdent(leaf)); err != nil {
		t.Fatalf("并发胜者 detach: %v", err)
	}
	if _, err := tx.Exec(fmt.Sprintf("ALTER TABLE usage ATTACH PARTITION %s FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(leaf), pgInstantArg(BeijingDayInstant(dayKey(BeijingMonth(time.Now())))),
		pgInstantArg(BeijingDayInstant(dayKey(BeijingMonth(time.Now())).AddDate(0, 1, 0))))); err != nil {
		t.Fatalf("并发胜者 attach: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("并发胜者提交: %v", err)
	}
	// ③ 拿着**过期观察**走孤儿分支：DETACH 必然失败（它已经不是旧父表的分区）⇒ 必须复检
	//    catalog 并按良性处理（返回 nil），而不是把 503 甩给这个用户。
	if err := ensureDetachedOrphanMonth(db, spec, probe); err != nil {
		t.Fatalf("并发领回必须按良性处理（另一个胜者已领回并落位，目录事实已是就绪）: %v", err)
	}
	if _, err := RecordUsageKind(db, uid, "m-r9d00-stale", 100, 50, "chat"); err != nil {
		t.Fatalf("复检之后写入必须成功: %v", err)
	}
	if got := r9d00RowRel(t, db, uid); got != leaf {
		t.Fatalf("明细应落在 %s，实际 %s", leaf, got)
	}
}
