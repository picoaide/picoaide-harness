package serverstore

// R10-F4 泳道 · 可观测面与判据口径（R10-A-03 P2 / R10-A-05 P3 / R10-A-06 P3 /
// R10-A-07 P3 / R10-D-05 P3）。
//
// 这五条都不是"数据会不会丢"，而是**读数与判据口径**：
//
//	R10-A-03：`lock_timeout=5s` 只罩 reclaim 事务 ⇒ 任何 >5s 的 usage **读**事务
//	          都会让该关系记失败、整轮非 nil ⇒ 管理端保存保留期 500「保留清理失败」
//	          + `/readyz` 的 failed_rounds。取向：**区分"锁等待超时"与"真失败"**，
//	          超时走"本轮延后"（skipped_by_reason=lock-timeout、不进 failures）。
//	R10-A-05：失败关系不进机器可读面（`unreclaimed` 只收 skipped）⇒ 新增
//	          `failed_relations`（有界抽样，与 unreclaimed 同形）。
//	R10-A-06：`write_blocked` 对 `kind=other` 的瞬时错误也置位（语义漂移）⇒
//	          只有 partitionLayoutError 家族进 write_blocked_*，其余进 write_error_*。
//	R10-A-07：`directChildOfUsage` / `usageRelationIsDirectChildOfUsage` 仍按 relname
//	          比较 ⇒ 与 `attachedToUsage` 的 oid 口径统一。
//	R10-D-05：`write_blocked_action` 对索引/序列/视图/物化视图给不可执行的
//	          `DROP TABLE` ⇒ 按实际 relkind 给可执行指引（唯一一份映射）。
//
// 复跑（前两条要真 PG）：
//
//	cd server && PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10f4 \
//	  go test ./internal/serverstore/ -run 'TestR10F4(Timeout|Failure|Write|Parent|RelKind)' -count=1 -v

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestR10F4TimeoutIsDeferralNotFailure 是 R10-A-03 的判据。
//
// 触发面与审计方一致：一个**长读事务**（`BEGIN; SELECT … FROM usage;` 持有
// ACCESS SHARE 直到提交）与清理轮次重叠 ⇒ 清理的临界区拿不到 `usage` 的
// ACCESS EXCLUSIVE ⇒ 旧实现把 55P03 记成失败 ⇒ 整轮非 nil。
//
// 修复后的判据（四条一起）：
//
//	① 整轮在有界时间内返回（5s 等锁上界）且 **err=nil**（管理端不再 500）；
//	② failures=0 / failed_rounds=0 / last_error 为空（不把锁竞争记成故障）；
//	③ 这一轮**看得见**它：skipped_by_reason 有 lock-timeout、unreclaimed 点名关系；
//	④ 长读结束后下一轮自愈回收（超时只是延后）。
func TestR10F4TimeoutIsDeferralNotFailure(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	rel := "usage_" + monthKey(expired)
	for i := 0; i < 5; i++ {
		if err := r10f4Insert(db, uid, "reader-race", BeijingDayAt(expired, 10), 0.5); err != nil {
			t.Fatal(err)
		}
	}
	var curDB string
	if err := db.QueryRow("SELECT current_database()").Scan(&curDB); err != nil {
		t.Fatal(err)
	}
	reader, err := sql.Open("pgx", r10f4DSNFor(curDB))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	rtx, err := reader.BeginTx(t.Context(), nil)
	if err != nil {
		t.Fatal(err)
	}
	// 长读：把 ACCESS SHARE 持到事务结束（与清理的 ACCESS EXCLUSIVE 冲突）。
	if _, err := rtx.Exec("SELECT count(*) FROM usage"); err != nil {
		t.Fatal(err)
	}

	resetUsageRetentionStatusForTest()
	start := time.Now()
	cerr := CleanupUsageRetention(db)
	elapsed := time.Since(start)
	st := CurrentUsageRetentionStatus()
	t.Logf("长读者在场：elapsed=%s err=%v failures=%d failed_rounds=%d skipped=%d reasons=%v unreclaimed=%v",
		elapsed.Round(time.Millisecond), cerr, st.Failures, st.FailedRounds, st.Skipped, st.SkippedByReason, st.Unreclaimed)

	// ① 有界：等锁上界 5s × **一个共享锁点**（usage 的 AEX 是共同的锁点，
	//    第一处超时后其余关系直接延后 ⇒ 与关系数无关），旧实现是无界。
	if elapsed > 20*time.Second {
		t.Errorf("一次锁竞争把整轮拖成 %s（前半轮必须处处有界，且上界不得随关系数增长，R10-D-02）", elapsed)
	}
	// ② 锁竞争**不是**失败。
	if cerr != nil {
		t.Errorf("锁等待超时不得让整轮非 nil（管理端同步调用会回 500「保留清理失败」）: %v", cerr)
	}
	if st.Failures != 0 || st.FailedRounds != 0 {
		t.Errorf("超时必须与真失败可区分: failures=%d failed_rounds=%d last_error=%q", st.Failures, st.FailedRounds, st.LastError)
	}
	if st.LastError != "" {
		t.Errorf("超时不得写 last_error（它表示真故障）: %q", st.LastError)
	}
	// ③ 但必须**看得见**（可读的延后 + 点名关系）。
	if st.SkippedByReason[usageSkipLockTimeout] == 0 && st.SkippedByReason[usageSkipStatementTimeout] == 0 {
		t.Errorf("超时没有被记成可读原因（skipped_by_reason=%v）—— 静默延后与静默失败一样糟", st.SkippedByReason)
	}
	named := false
	for _, u := range st.Unreclaimed {
		if strings.Contains(u, rel) {
			named = true
		}
	}
	if !named {
		t.Errorf("延后的关系没有被点名（unreclaimed=%v）", st.Unreclaimed)
	}
	if st.FailedRelations != nil {
		t.Errorf("超时不得进 failed_relations（那是真失败的面）: %v", st.FailedRelations)
	}

	// ④ 长读结束 ⇒ 下一轮自愈。
	if err := rtx.Rollback(); err != nil {
		t.Fatal(err)
	}
	resetUsageRetentionStatusForTest()
	if cerr2 := CleanupUsageRetention(db); cerr2 != nil {
		t.Fatalf("长读结束后必须自愈回收: %v", cerr2)
	}
	if r9aRelationExists(t, db, rel) {
		t.Errorf("长读结束后到期关系 %s 仍未被回收（超时只该延后一轮）", rel)
	}
}

// TestR10F4FailedRelationsAreMachineReadable 是 R10-A-05 的判据。
//
// 用**确定性**的真失败（分区上挂了一个依赖视图 ⇒ 事务里的 `DROP TABLE` 报 2BP01）
// 造出失败，断言失败关系进机器可读面：`failures` 计数、`failed_relations` 点名、
// `last_error` 有明细 —— 旧实现只有最后一项，`unreclaimed` 只收 skipped ⇒
// "哪条关系真的失败了"在 /readyz 上不可判定。
func TestR10F4FailedRelationsAreMachineReadable(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	if err := SetSetting(db, RetentionMonthsSetting, "2"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	expired := bjMonth(3)
	if err := ensureUsagePartition(db, expired); err != nil {
		t.Fatal(err)
	}
	rel := "usage_" + monthKey(expired)
	if err := r10f4Insert(db, uid, "dep-view", BeijingDayAt(expired, 10), 0.5); err != nil {
		t.Fatal(err)
	}
	// 依赖对象：DROP TABLE 会因它报 2BP01（真失败，不是超时、也不是良性竞态）。
	if _, err := db.Exec("CREATE VIEW r10f4_dep_view AS SELECT id FROM " + quoteRelationIdent(rel)); err != nil {
		t.Fatalf("建依赖视图: %v", err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP VIEW IF EXISTS r10f4_dep_view") })

	resetUsageRetentionStatusForTest()
	cerr := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	t.Logf("round err=%v failures=%d failed_relations=%v last_error=%q",
		cerr, st.Failures, st.FailedRelations, st.LastError)

	if cerr == nil {
		t.Fatalf("真失败必须 fail-loud（被依赖对象挡住 DROP）: err=nil")
	}
	if st.Failures == 0 {
		t.Errorf("失败计数为 0（failures=%d）", st.Failures)
	}
	named := false
	for _, r := range st.FailedRelations {
		if r == rel {
			named = true
		}
	}
	if !named {
		t.Errorf("失败关系没有进机器可读面：failed_relations=%v（want 含 %s）", st.FailedRelations, rel)
	}
	if !strings.Contains(st.LastError, rel) {
		t.Errorf("last_error 应当点名失败关系: %q", st.LastError)
	}
	// 该关系必须还在盘上（逐关系隔离：失败不动数据，也不影响别的月份）。
	if !r9aRelationExists(t, db, rel) {
		t.Errorf("失败的 DROP 不得留在半成品状态：%s 应当仍存在", rel)
	}
	// 依赖对象撤掉后必须自愈（失败只延后一轮）。
	if _, err := db.Exec("DROP VIEW IF EXISTS r10f4_dep_view"); err != nil {
		t.Fatal(err)
	}
	resetUsageRetentionStatusForTest()
	if cerr2 := CleanupUsageRetention(db); cerr2 != nil {
		t.Fatalf("依赖对象撤掉后必须自愈: %v", cerr2)
	}
	if r9aRelationExists(t, db, rel) {
		t.Errorf("自愈轮未回收 %s", rel)
	}
}

// TestR10F4WriteBlockedIsLayoutOnly 是 R10-A-06 的判据（语义漂移）。
//
// `write_blocked_*` 的文档语义是"当月计量写入被**分区布局**挡住"（处置动作是分区
// DDL）。旧实现把任何 ensureUsagePartition 失败都塞进这一面（含未分类的瞬时错误，
// kind="other"）⇒ 运维会拿着分区动作去核对一个可能完全正确的分区树。
func TestR10F4WriteBlockedIsLayoutOnly(t *testing.T) {
	resetUsageRetentionStatusForTest()
	now := time.Now()

	// ① 分区布局错误（带封闭 kind + 可执行 action）⇒ write_blocked_*。
	noteUsagePartitionWriteFailure(now, &partitionLayoutError{
		kind:   usagePartitionKindOrphanNameCollision,
		action: "把该月分区领回",
		msg:    "同名孤儿挡住当月写入",
	})
	st := CurrentUsageRetentionStatus()
	if !st.WriteBlocked || st.WriteBlockedKind != usagePartitionKindOrphanNameCollision || st.WriteBlockedAction == "" {
		t.Fatalf("分区布局错误必须进 write_blocked_*（带 kind 与可执行 action）: %+v", st)
	}
	if st.WriteError {
		t.Errorf("分区布局错误不该同时进 write_error: %+v", st)
	}

	// ② 未分类的瞬时错误（连接/探测/DDL 失败）⇒ 只能进 write_error_*，不得冒充
	//    "分区布局阻塞"（write_blocked_action 在 other 上本来就是空串）。
	resetUsageRetentionStatusForTest()
	noteUsagePartitionWriteFailure(now, errors.New("connection reset by peer"))
	st = CurrentUsageRetentionStatus()
	if st.WriteBlocked {
		t.Errorf("未分类的瞬时错误不得置 write_blocked（语义漂移：R10-A-06）: %+v", st)
	}
	if !st.WriteError || st.WriteErrorMessage == "" || st.WriteErrorCount < 1 {
		t.Errorf("瞬时错误必须仍然可读（write_error_*）: %+v", st)
	}

	// ③ 一次成功写入同时清两面。
	noteUsagePartitionWriteOK(now)
	st = CurrentUsageRetentionStatus()
	if st.WriteBlocked || st.WriteError {
		t.Errorf("成功写入必须清掉两面: %+v", st)
	}
}

// TestR10F4ParentJudgementUsesOid 是 R10-A-07 的判据（与 attachedToUsage 口径统一）。
//
// 形态：**另一个 schema** 里也有一张叫 `usage` 的分区表，`public.usage_<YYYYMM>`
// 挂在它下面。此时：
//
//	Parent == "usage"（relname 相同）         —— 旧判据会判成"usage 的直接子分区"
//	直接父的 oid ≠ public.usage 的 oid         —— 新判据判 false
//
// 旧判据的后果是误导性的 fail-loud（随后的 `ALTER TABLE usage DETACH PARTITION`
// 报 42809/42P01）；这里把两个入口（落桶后的 shape 与临界区的事务判据）都钉住。
func TestR10F4ParentJudgementUsesOid(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("CREATE SCHEMA IF NOT EXISTS r10f4_alt"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP SCHEMA IF EXISTS r10f4_alt CASCADE") })
	if _, err := db.Exec(`CREATE TABLE r10f4_alt.usage (LIKE public.usage INCLUDING ALL) PARTITION BY RANGE (created_at)`); err != nil {
		t.Fatalf("建另一个 schema 的同名分区表: %v", err)
	}
	rel := "usage_209901" // 未来月：不会被本轮的保留清理碰到
	if _, err := db.Exec(fmt.Sprintf(
		`CREATE TABLE public.%s PARTITION OF r10f4_alt.usage FOR VALUES FROM ('%s') TO ('%s')`,
		quoteRelationIdent(rel), pgInstantArg(BeijingDayInstant(time.Date(2099, 1, 1, 0, 0, 0, 0, time.UTC))),
		pgInstantArg(BeijingDayInstant(time.Date(2099, 2, 1, 0, 0, 0, 0, time.UTC))))); err != nil {
		t.Fatalf("建跨 schema 同名分区: %v", err)
	}

	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatal(err)
	}
	shape, ok := tables.Shapes[rel]
	if !ok {
		t.Fatalf("%s 未出现在形态表里", rel)
	}
	if shape.Parent != "usage" {
		t.Fatalf("夹具前提不成立：%s 的直接父 relname = %q，want \"usage\"", rel, shape.Parent)
	}
	if shape.DirectParentUsage {
		t.Errorf("%s 的直接父只是**同名**（另一个 schema 的 usage），DirectParentUsage 不该为 true", rel)
	}
	if shape.directChildOfUsage() {
		t.Errorf("directChildOfUsage() 必须按 oid 判定（R10-A-07），不能用裸 relname")
	}
	direct, derr := usageRelationIsDirectChildOfUsage(db, rel)
	if derr != nil {
		t.Fatalf("临界区判据: %v", derr)
	}
	if direct {
		t.Errorf("usageRelationIsDirectChildOfUsage(%s) = true，want false（oid 口径）", rel)
	}
	// 反向对照：真正的 usage 直接子分区必须判 true（判据不是恒假）。
	if err := ensureUsagePartition(db, time.Date(2099, 3, 1, 0, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("建真实分区: %v", err)
	}
	if direct, derr := usageRelationIsDirectChildOfUsage(db, "usage_209903"); derr != nil || !direct {
		t.Errorf("真实直接子分区 usage_209903 必须判 true（err=%v got=%v）", derr, direct)
	}
}

// TestR10F4RelKindShapedDropGuidance 是 R10-D-05 的判据。
//
// 同名占名对象的形状有十种，而 `write_blocked_action` 此前对**任何**非分区形态都写
// "DROP TABLE <rel>" —— 索引/序列/视图/物化视图下这句话不可执行（真 PG 实测
// `… is not a table`）。判据：每个形态的 action 必须点名**与 relkind 匹配**的 DDL，
// 且不得出现 `DROP TABLE`（对非表形态）。
func TestR10F4RelKindShapedDropGuidance(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS r10f4_ddl_tbl (id int)"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = db.Exec("DROP TABLE IF EXISTS r10f4_ddl_tbl") })

	cases := []struct {
		name     string
		ddl      string
		wantVerb string
		notVerb  string
	}{
		{"table", `CREATE TABLE %s (LIKE public.usage INCLUDING DEFAULTS)`, "DROP TABLE IF EXISTS", ""},
		{"view", `CREATE VIEW %s AS SELECT 1 AS one`, "DROP VIEW IF EXISTS", "DROP TABLE"},
		{"matview", `CREATE MATERIALIZED VIEW %s AS SELECT 1 AS one`, "DROP MATERIALIZED VIEW IF EXISTS", "DROP TABLE"},
		{"index", `CREATE INDEX %s ON r10f4_ddl_tbl (id)`, "DROP INDEX IF EXISTS", "DROP TABLE"},
		{"sequence", `CREATE SEQUENCE %s`, "DROP SEQUENCE IF EXISTS", "DROP TABLE"},
	}
	for i, tc := range cases {
		rel := fmt.Sprintf("usage_2099%02d", i+1) // 未来月，避开保留期
		if _, err := db.Exec(fmt.Sprintf(tc.ddl, quoteRelationIdent(rel))); err != nil {
			t.Fatalf("建 %s 形态的占名对象 %s: %v", tc.name, rel, err)
		}
		month := time.Date(2099, time.Month(i+1), 1, 0, 0, 0, 0, time.UTC)
		err := ensureUsagePartition(db, month)
		if err == nil {
			t.Fatalf("%s 同名占名必须 fail-loud（不能静默重建）", rel)
		}
		kind, action, msg := partitionLayoutFailure(err)
		if kind != usagePartitionKindStaleDetached {
			t.Errorf("%s: kind = %q，want %q（msg=%s）", rel, kind, usagePartitionKindStaleDetached, msg)
		}
		if !strings.Contains(action, tc.wantVerb) {
			t.Errorf("%s（relkind=%s）的 action 没有给出可执行 DDL %q: %s", rel, tc.name, tc.wantVerb, action)
		}
		if tc.notVerb != "" && strings.Contains(action, tc.notVerb) {
			t.Errorf("%s（relkind=%s）的 action 仍在教运维执行不可执行的 %q: %s", rel, tc.name, tc.notVerb, action)
		}
		if !strings.Contains(action, rel) {
			t.Errorf("%s 的 action 没有点名关系: %s", rel, action)
		}
		t.Logf("%-8s %s -> %s", tc.name, rel, action)
	}
}
