package serverstore

// R10-H3 泳道 · **任务 A**：核验 G3 提交后补在【工作树里、未经任何复审】的那 14 行
// （`usageReclaimEstimatedRows` 的表大小改按 `pg_partition_tree` 叶子求和）。
//
// 被核验的形态（W3-6 的问题陈述 + G3 的未提交修法）：
//
//	多级布局 `usage → usage_<YYYY>[p] → usage_<YYYYMM>`，回收**中间父表**时：
//	  · 声明式分区父表**自身没有存储** ⇒ `pg_relation_size(父)` = 0；
//	  · 未 ANALYZE ⇒ `pg_clas.reltuples` = -1/0；
//	  ⇒ 旧推导（只读该关系自己的 reltuples 与 pg_relation_size）给出 est=0
//	     ⇒ 预算退回下限 30s，而结算段聚合的是**整株子树** ⇒ 大子树每月都超时、
//	     被分类成"延后"、永远不回收（W3-6 的结论）。
//	  修法 = 把"这个关系有多少行"改成"整株子树的字节 / 128"。
//
// 本文件的判据（**不是**把实现的 SQL 抄一遍：子树字节用测试自己的
// `WITH RECURSIVE` 遍历 `pg_inherits` 独立算出，与实现的 `pg_partition_tree`
// 是两条不同的查询路径）：
//
//	H1 3 级布局 + 全程不 ANALYZE 的**中间父表**上，行数估计必须与**子树规模相称**：
//	   ① est ≥ 独立算出的子树堆字节/128（旧形态是 0 ⇒ 必红）；
//	   ② est 落在真实子树行数的 [1/2, 4] 倍区间内（钉住"估计的是行数"，不是别的量）；
//	   ③ 两个行数比 5:1 的中间父表，估计值必须同向拉开（旧形态两边都是 0 ⇒ 必红）。
//	H2 判据的**承重面**：子树字节跨过推导下限的门槛（≥96MiB，与 128 字节/行的估计
//	   口径同源）时，父表的预算必须**离开下限**（> usageReclaimSettleFloorMS）。
//	   判据自带夹具自校准（先断言夹具真的到了那个量级，否则报"夹具不成立"而不是假绿）。
//
// 复跑（真 PG）：
//
//	docker exec pg-test psql -U postgres -c "CREATE DATABASE r10h3"
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10h3 \
//	  go test ./internal/serverstore/ -run 'TestR10H' -count=1 -v -timeout 1800s
//	# 变异（删掉那 14 行 = 回到 pg_relation_size(自己)）：三条判据必须全红
//	bash temp/r10/fix-H3/mut-h3.sh budget_subtree_out

import (
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// r10hFatRows 是 H2 的种子行数（缺省 20 万；每行 model 约 1.1KB ⇒ 堆字节 ~250MB，
// 足以让"字节/128"跨过 75 万行的下限门槛）。
func r10hFatRows() int {
	if v := os.Getenv("R10H_ROWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 200_000
}

// r10hFatModelWidth 是 H2 每行的 model 宽度（字符）。取值必须让**整行留在堆里**：
// PG 只对超过 ~2KB 的 varlena 做 TOAST/压缩，而推导用的是 `pg_relation_size`
// （只数主 fork，不含 TOAST）—— 取 1.1KB 既能把字节做大，又不会被挪进 TOAST 表
// 而让判据测不到东西（这条是夹具的前提，H2 里有显式断言）。
const r10hFatModelWidth = 1100

// r10hMidParent 建一个**中间父表**（`usage` 的二/三级分区）并返回其名字。
func r10hMidParent(t *testing.T, db *sql.DB, mid string, from, to time.Time) {
	t.Helper()
	if _, err := db.Exec(fmt.Sprintf(
		"CREATE TABLE %s PARTITION OF usage FOR VALUES FROM ('%s') TO ('%s') PARTITION BY RANGE (created_at)",
		quoteRelationIdent(mid), pgInstantArg(from), pgInstantArg(to))); err != nil {
		t.Fatalf("建中间父表 %s: %v", mid, err)
	}
}

// r10hLeaf 建一个**孙辈叶子**（中间父表下的月分区）。
func r10hLeaf(t *testing.T, db *sql.DB, parent, leaf string, from, to time.Time) {
	t.Helper()
	if _, err := db.Exec(fmt.Sprintf("CREATE TABLE %s PARTITION OF %s FOR VALUES FROM ('%s') TO ('%s')",
		quoteRelationIdent(leaf), quoteRelationIdent(parent), pgInstantArg(from), pgInstantArg(to))); err != nil {
		t.Fatalf("建叶子 %s: %v", leaf, err)
	}
}

// r10hSeedLeaf 往叶子里灌 rows 行（model 宽度 = width 字符；width=0 用普通短名）。
// 全程不 ANALYZE —— 这正是 W3-6 的前提（reltuples 不可信）。
func r10hSeedLeaf(t *testing.T, db *sql.DB, uid int64, leaf string, at time.Time, rows, width int) {
	t.Helper()
	if rows <= 0 {
		return
	}
	model := "r10h-row"
	if width > 0 {
		model = "r10h-" + strings.Repeat("x", width)
	}
	if _, err := db.Exec(fmt.Sprintf(`INSERT INTO %s (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at, estimated)
        SELECT $1, $2, 10, 20, 'chat', 0.25, $3::timestamptz + ((g %% 60) * interval '1 minute'), FALSE
        FROM generate_series(1, $4) AS g`, quoteRelationIdent(leaf)), uid, model, at.UTC(), rows); err != nil {
		t.Fatalf("种子 %d 行进 %s: %v", rows, leaf, err)
	}
}

// r10hSubtreeHeap 用**测试自己的**递归遍历（pg_inherits）算出子树里所有关系的
// 堆字节与关系数（与实现的 `pg_partition_tree` 是两条独立路径）。
func r10hSubtreeHeap(t *testing.T, db *sql.DB, rel string) (heap int64, relations int) {
	t.Helper()
	if err := db.QueryRow(`
WITH RECURSIVE tree AS (
    SELECT to_regclass('public.' || $1) AS oid
    UNION ALL
    SELECT i.inhrelid FROM pg_inherits i JOIN tree ON i.inhparent = tree.oid
)
SELECT COALESCE(sum(pg_relation_size(oid)), 0)::bigint, count(*)::int FROM tree`, rel).Scan(&heap, &relations); err != nil {
		t.Fatalf("独立算子树字节 %s: %v", rel, err)
	}
	return heap, relations
}

// r10hRelationFacts 读该关系**自己**的 reltuples 与 pg_relation_size（W3-6 形态的
// 两个输入），用于断言夹具真的复现了"父表自身零存储 + 未 ANALYZE"。
func r10hRelationFacts(t *testing.T, db *sql.DB, rel string) (reltuples float64, size int64) {
	t.Helper()
	if err := db.QueryRow(`SELECT c.reltuples, COALESCE(pg_relation_size(c.oid), 0)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&reltuples, &size); err != nil {
		t.Fatalf("读 %s 的 catalog 事实: %v", rel, err)
	}
	return reltuples, size
}

// r10hCountRows 数该关系（子树）里的真实行数 —— 判据②的基准量。
func r10hCountRows(t *testing.T, db *sql.DB, rel string) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow("SELECT count(*) FROM " + quoteRelationIdent(rel)).Scan(&n); err != nil {
		t.Fatalf("数 %s 的行数: %v", rel, err)
	}
	return n
}

// TestR10HA1NonLeafBudgetTracksSubtreeBytes 见文件头 H1。
func TestR10HA1NonLeafBudgetTracksSubtreeBytes(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	// 父表 A：50 000 行，叶子 40 000 / 10 000 / 0（第三片叶子**存在但零行**，
	// 用来钉住「估计不能只看某一片叶子」）。
	bigFrom := BeijingDayInstant(time.Date(2098, 1, 1, 0, 0, 0, 0, time.UTC))
	bigTo := BeijingDayInstant(time.Date(2098, 4, 1, 0, 0, 0, 0, time.UTC))
	r10hMidParent(t, db, "usage_2098", bigFrom, bigTo)
	r10hLeaf(t, db, "usage_2098", "usage_209801", bigFrom, BeijingDayInstant(time.Date(2098, 2, 1, 0, 0, 0, 0, time.UTC)))
	r10hLeaf(t, db, "usage_2098", "usage_209802", BeijingDayInstant(time.Date(2098, 2, 1, 0, 0, 0, 0, time.UTC)), BeijingDayInstant(time.Date(2098, 3, 1, 0, 0, 0, 0, time.UTC)))
	r10hLeaf(t, db, "usage_2098", "usage_209803", BeijingDayInstant(time.Date(2098, 3, 1, 0, 0, 0, 0, time.UTC)), bigTo)
	r10hSeedLeaf(t, db, uid, "usage_209801", BeijingDayAt(time.Date(2098, 1, 10, 0, 0, 0, 0, time.UTC), 10), 40_000, 0)
	r10hSeedLeaf(t, db, uid, "usage_209802", BeijingDayAt(time.Date(2098, 2, 10, 0, 0, 0, 0, time.UTC), 10), 10_000, 0)

	// 父表 B：10 000 行，叶子 10 000 / 0 ⇒ 与 A 的行数比 = 5:1。
	smallFrom := BeijingDayInstant(time.Date(2097, 1, 1, 0, 0, 0, 0, time.UTC))
	smallTo := BeijingDayInstant(time.Date(2097, 3, 1, 0, 0, 0, 0, time.UTC))
	r10hMidParent(t, db, "usage_2097", smallFrom, smallTo)
	r10hLeaf(t, db, "usage_2097", "usage_209701", smallFrom, BeijingDayInstant(time.Date(2097, 2, 1, 0, 0, 0, 0, time.UTC)))
	r10hLeaf(t, db, "usage_2097", "usage_209702", BeijingDayInstant(time.Date(2097, 2, 1, 0, 0, 0, 0, time.UTC)), smallTo)
	r10hSeedLeaf(t, db, uid, "usage_209701", BeijingDayAt(time.Date(2097, 1, 10, 0, 0, 0, 0, time.UTC), 10), 10_000, 0)

	// 夹具前提（自校准）：中间父表**自身零存储**、**未 ANALYZE** ⇒ W3-6 的两个输入
	// 都是"不可用"。夹具不成立就必须红，不允许判据静默失效。
	for _, mid := range []string{"usage_2098", "usage_2097"} {
		rt, size := r10hRelationFacts(t, db, mid)
		heap, rels := r10hSubtreeHeap(t, db, mid)
		t.Logf("中间父表 %s: 自身 reltuples=%.0f pg_relation_size=%d；子树 %d 个关系、堆字节 %d（独立递归遍历）",
			mid, rt, size, rels, heap)
		if size != 0 {
			t.Fatalf("夹具不成立：%s 自身 pg_relation_size=%d（应为 0，声明式分区父表没有存储）", mid, size)
		}
		if rt > 0 {
			t.Fatalf("夹具不成立：%s 的 reltuples=%.0f > 0（本判据要的正是「未 ANALYZE」形态）", mid, rt)
		}
		if rels < 3 {
			t.Fatalf("夹具不成立：%s 的子树只有 %d 个关系（要 3 级布局：父 + 叶子）", mid, rels)
		}
		if heap <= 0 {
			t.Fatalf("夹具不成立：%s 的子树堆字节 = %d", mid, heap)
		}
	}

	heapA, _ := r10hSubtreeHeap(t, db, "usage_2098")
	heapB, _ := r10hSubtreeHeap(t, db, "usage_2097")
	rowsA := r10hCountRows(t, db, "usage_2098")
	rowsB := r10hCountRows(t, db, "usage_2097")
	estA := usageReclaimEstimatedRows(db, "usage_2098")
	estB := usageReclaimEstimatedRows(db, "usage_2097")
	t.Logf("估计：A(子树 %d 行 / 堆 %d B) est=%d 预算=%dms；B(子树 %d 行 / 堆 %d B) est=%d 预算=%dms",
		rowsA, heapA, estA, usageReclaimBudgetForRelation(db, "usage_2098"),
		rowsB, heapB, estB, usageReclaimBudgetForRelation(db, "usage_2097"))

	// ① 估计必须由**整株子树**的字节驱动（旧形态 = 父表自身 pg_relation_size = 0 ⇒ est=0）。
	if estA < heapA/usageReclaimRowBytesEstimate {
		t.Errorf("中间父表 usage_2098 的行数估计 %d < 子树堆字节/128 = %d —— "+
			"估计没有按叶子求和（父表自身零存储 ⇒ 多级布局下预算会退回下限，W3-6）",
			estA, heapA/usageReclaimRowBytesEstimate)
	}
	// ② 估计的**量纲**必须是行数：落在真实子树行数的 [1/2, 4] 倍内。
	if estA < rowsA/2 || estA > rowsA*4 {
		t.Errorf("中间父表 usage_2098 的估计 %d 与真实子树行数 %d 不相称（要求 [1/2, 4] 倍）", estA, rowsA)
	}
	// ③ 两个子树规模比 5:1 的父表，估计必须同向拉开（旧形态两边都是 0 ⇒ 必红）。
	if estB <= 0 {
		t.Errorf("中间父表 usage_2097 的估计 = %d —— 小子树也必须给出正估计（否则判据③恒真）", estB)
	} else if estA < 2*estB {
		t.Errorf("子树行数 %d:%d（≈5:1）的父表估计 %d:%d 没有同向拉开 —— "+
			"估计没有跟着子树规模走", rowsA, rowsB, estA, estB)
	}
}

// TestR10HA2NonLeafBudgetLeavesTheFloor 见文件头 H2：G3 的 14 行**承重**的那一条 ——
// 多级布局 + 大子树时预算必须离开下限（这正是 W3-6 说"会退回下限"的那条后果）。
func TestR10HA2NonLeafBudgetLeavesTheFloor(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)

	from := BeijingDayInstant(time.Date(2096, 1, 1, 0, 0, 0, 0, time.UTC))
	to := BeijingDayInstant(time.Date(2096, 3, 1, 0, 0, 0, 0, time.UTC))
	mid, leaf := "usage_2096", "usage_209601"
	r10hMidParent(t, db, mid, from, to)
	r10hLeaf(t, db, mid, leaf, from, to)
	rows := r10hFatRows()
	r10hSeedLeaf(t, db, uid, leaf, BeijingDayAt(time.Date(2096, 1, 10, 0, 0, 0, 0, time.UTC), 10), rows, r10hFatModelWidth)

	// 夹具自校准：① 中间父表自身零存储 + 未 ANALYZE；② 子树堆字节真的跨过门槛
	// （下限 30s ⇔ 15000ms + 20µs/行 ⇒ est ≥ 750 000 行 ⇔ 堆字节 ≥ 96MiB）。
	// 门槛达不到就报"夹具不成立"，绝不让判据静默变成恒真。
	rt, size := r10hRelationFacts(t, db, mid)
	heap, _ := r10hSubtreeHeap(t, db, mid)
	floorRows := int64(usageReclaimSettleFloorMS-usageReclaimSettleBaseMS) * 1000 / usageReclaimSettlePerRowUS
	needBytes := floorRows * usageReclaimRowBytesEstimate
	t.Logf("夹具：父表自身 reltuples=%.0f size=%d；子树堆字节=%d（需要 ≥ %d 才能跨过下限）；"+
		"真实行数=%d；叶子自身 reltuples/size=%v", rt, size, heap, needBytes, r10hCountRows(t, db, mid),
		func() string { r2, s2 := r10hRelationFacts(t, db, leaf); return fmt.Sprintf("%.0f/%d", r2, s2) }())
	if size != 0 || rt > 0 {
		t.Fatalf("夹具不成立：父表 %s 自身 reltuples=%.0f size=%d（要「零存储 + 未 ANALYZE」）", mid, rt, size)
	}
	if heap < needBytes {
		t.Fatalf("夹具不成立：子树堆字节 %d < 门槛 %d —— 调大 R10H_ROWS（当前 %d 行）；"+
			"否则本判据无法区分「离开下限」与「退回下限」", heap, needBytes, rows)
	}

	estMid := usageReclaimEstimatedRows(db, mid)
	estLeaf := usageReclaimEstimatedRows(db, leaf)
	budgetMid := usageReclaimBudgetForRelation(db, mid)
	budgetLeaf := usageReclaimBudgetForRelation(db, leaf)
	t.Logf("估计：父表 est=%d 预算=%dms；叶子 est=%d 预算=%dms（下限 %dms）",
		estMid, budgetMid, estLeaf, budgetLeaf, usageReclaimSettleFloorMS)

	if budgetMid <= usageReclaimSettleFloorMS {
		t.Errorf("中间父表 %s 的结算段预算 = %dms，仍在下限 %dms —— "+
			"多级布局 + 大子树下预算退回下限（W3-6 未闭合）", mid, budgetMid, usageReclaimSettleFloorMS)
	}
	if budgetLeaf <= usageReclaimSettleFloorMS {
		t.Errorf("叶子 %s 的结算段预算 = %dms，仍在下限 %dms（未 ANALYZE 的大表必须能从堆字节反推行数）",
			leaf, budgetLeaf, usageReclaimSettleFloorMS)
	}
}
