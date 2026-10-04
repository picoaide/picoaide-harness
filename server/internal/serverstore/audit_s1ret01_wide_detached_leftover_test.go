package serverstore

// audit_s1ret01_wide_detached_leftover_test.go —— 第二十八轮审计 S1-RET-01（P1）的判据。
//
// 缺陷形态（审计方 confirmed-by-execution，本文件把它钉成回归）：
//   DBA 预建的**异名但整月对齐**的宽分区（季度 `usage_2020q1`）到期清理时，若冻结段
//   （DETACH）已提交而结算段失败（DROP 被依赖对象挡住 / 锁超时 / 预算到点 / 两步之间
//   重启），则：
//     ① 预补账只覆盖**判据月**（区间末月）⇒ 该块分区里其余月份的金额从所有读数面
//        消失（明细还在盘上，账本没有）；
//     ② DETACH 之后 PG 清掉 relpartbound、relispartition=false，名字又不是六位月
//        ⇒ 该关系此后**永不**再被任何一轮枚举（既不重试补账、也不回收、也不进
//        unreclaimed/skip_reasons/失败计数）⇒ 永不自愈。
//
// 两条修法各有判据：
//   ① 预补账窗口 = win ∪ 声明边界 ⇒ 断言「账本三天齐 + 读数三天齐」（每个阶段都断言）；
//   ② DETACH 之前写「这条关系是我们摘的 + 当时声明的窗口」标记、候选面据此把它捡回来
//      ⇒ 断言「第二轮不得静默」（依赖还在 ⇒ fail-loud 点名；依赖撤掉 ⇒ 补账+回收成功）。
//
// 反向对照（判据必须能咬到「身份判据被放松」）：别人手工建的同名表、别人那棵树的分区、
// 以及「我们的标记被挂到了别人树下」这三种关系**一条都不得被 DROP、也不得被补进我们的
// 永久账本**（见 TestAuditS1Ret01ForeignSameNamedRelationsAreNeverReclaimed）。

import (
	"database/sql"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// s1ret01LedgerDays 返回永久账本里落在 [from,to] 北京日闭区间内的日期（升序、去重）。
func s1ret01LedgerDays(t *testing.T, db *sql.DB, from, to time.Time) []string {
	t.Helper()
	rows, err := db.Query(`SELECT DISTINCT to_char(day,'YYYY-MM-DD') FROM usage_daily
	    WHERE day >= ?::date AND day <= ?::date ORDER BY 1`, from.Format(dateFmt), to.Format(dateFmt))
	if err != nil {
		t.Fatalf("读账本日期: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var d string
		if err := rows.Scan(&d); err != nil {
			t.Fatalf("scan 账本日期: %v", err)
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("读账本日期: %v", err)
	}
	return out
}

// s1ret01Comment 读关系的 pg_description（我们把 DETACH 标记写在这里）。
func s1ret01Comment(t *testing.T, db *sql.DB, rel string) string {
	t.Helper()
	var comment string
	if err := db.QueryRow(`SELECT COALESCE(obj_description(?::regclass, 'pg_class'), '')`, rel).Scan(&comment); err != nil {
		t.Fatalf("读 %s 的注释: %v", rel, err)
	}
	return comment
}

// s1ret01StatusMentions 报告保留状态里有没有点名某条关系（未回收面或失败面）。
func s1ret01StatusMentions(st UsageRetentionStatus, rel string) bool {
	return strings.Contains(strings.Join(st.Unreclaimed, ","), rel) ||
		strings.Contains(strings.Join(st.FailedRelations, ","), rel)
}

// s1ret01AssertQuarterMoneyVisible 是修法 ① 的判据（能力级：金额真的读得到）。
//
// 断言两件事，缺一不可：
//   - 永久账本覆盖**声明边界里的每一个月**（不是只有判据月）；
//   - 报表口径（明细 ∪ 账本）在三个月上都读到盘上真值 3/4/5。
//
// 只要预补账窗口退回「只用 win」，第一条就变红：2020-01/02 的账本行不存在，而该关系
// 一旦 DETACH 就再也不被枚举 ⇒ 后面两条读数断言跟着变红（读 0）。
func s1ret01AssertQuarterMoneyVisible(t *testing.T, db *sql.DB, username, stage string) {
	t.Helper()
	want := []string{"2020-01-10", "2020-02-10", "2020-03-10"}
	got := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31"))
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%s：永久账本覆盖的日期 = %v，want %v —— 整块分区在 DETACH 之前必须把"+
			"**声明边界覆盖的每个月**都补进账本；只补判据月（末月）会让其余月份在冻结段"+
			"提交后从所有读数面消失且永不自愈", stage, got, want)
	}
	for _, c := range []struct {
		name     string
		from, to string
		want     float64
	}{
		{"2020-01", "2020-01-01", "2020-01-31", 3},
		{"2020-02", "2020-02-01", "2020-02-29", 4},
		{"2020-03", "2020-03-01", "2020-03-31", 5},
	} {
		gotCost, _ := r25ReportTotal(t, db, username, bjDate(t, c.from), bjDate(t, c.to))
		if math.Abs(gotCost-c.want) > 1e-9 {
			t.Fatalf("%s：%s 的报表读数 = %.4f，want %.4f（金额从读数面消失）",
				stage, c.name, gotCost, c.want)
		}
	}
}

// s1ret01QuarterFixture 造审计方的夹具：整月对齐的异名季度分区 + 三个月的明细
// （走生产写路径）+ 一个依赖视图（让结算段的 DROP 必然 2BP01）。
func s1ret01QuarterFixture(t *testing.T, db *sql.DB, username, view string) {
	t.Helper()
	uid := r24User(t, db, username)
	r25RetentionOn(t, db, "1")
	r24WidePartition(t, db, "usage_2020q1", "2020-01-01 00:00:00+08", "2020-04-01 00:00:00+08")
	for _, c := range []struct {
		day  string
		cost float64
	}{{"2020-01-10", 3}, {"2020-02-10", 4}, {"2020-03-10", 5}} {
		r24UsageAt(t, db, uid, "s1ret01", c.cost, BeijingDayInstant(bjDate(t, c.day)))
	}
	if n := r25UsageRowsIn(t, db, "usage_2020q1"); n != 3 {
		t.Fatalf("夹具前提不成立：usage_2020q1 有 %d 行（want 3）", n)
	}
	if _, err := db.Exec("CREATE VIEW " + view + " AS SELECT count(*) AS n FROM usage_2020q1"); err != nil {
		t.Fatalf("建依赖视图 %s: %v", view, err)
	}
}

// s1ret01AssertFrozen 断言「冻结段已提交」：关系不再是分区、明细一行未删，并且带上了
// 我们写的身份标记（修法 ② 的写入侧判据 —— 标记缺失时后续「第二轮不得静默」的断言
// 必然一起红）。
func s1ret01AssertFrozen(t *testing.T, db *sql.DB) {
	t.Helper()
	var isPart bool
	if err := db.QueryRow(`SELECT relispartition FROM pg_class WHERE relname='usage_2020q1'`).Scan(&isPart); err != nil {
		t.Fatalf("读 relispartition: %v", err)
	}
	if isPart {
		t.Fatalf("夹具前提不成立：usage_2020q1 仍挂在 usage 下（DETACH 没发生）")
	}
	if n := r25UsageRowsIn(t, db, "usage_2020q1"); n != 3 {
		t.Fatalf("DETACH 后明细行应原样留在盘上（3 行），实际 %d 行", n)
	}
	comment := s1ret01Comment(t, db, "usage_2020q1")
	from, to, ok := parseUsageRetentionOwnedComment(comment)
	if !ok {
		t.Fatalf("DETACH 之前必须写下「我们摘的」身份标记（唯一持久证据），实际注释 = %q", comment)
	}
	if from.Format(dateFmt) != "2020-01-01" || to.Format(dateFmt) != "2020-03-31" {
		t.Fatalf("标记里的窗口必须是声明边界（2020-01-01..2020-03-31），实际 %s..%s",
			from.Format(dateFmt), to.Format(dateFmt))
	}
}

// TestAuditS1Ret01WideQuarterSettleFailureKeepsEveryMonthAndStaysObservable 是
// S1-RET-01 的端到端判据（审计方的现场形态）：
//
//	第一轮：DROP 被依赖对象挡住 ⇒ fail-loud；冻结段已提交（关系被摘下来）；
//	        账本与读数**三天齐**（修法 ①）；
//	第二轮：**不得静默** —— 依赖对象还在，DROP 必然仍被挡住，所以必须 fail-loud 并
//	        点名这条关系（修法 ② 把它捡回了枚举面；修复前是 err=nil/failures=0/
//	        unreclaimed=[]）。「回收成功」那一支由下一个用例覆盖。
func TestAuditS1Ret01WideQuarterSettleFailureKeepsEveryMonthAndStaysObservable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret01-wide-visible"
	s1ret01QuarterFixture(t, db, username, "s1ret01_dep_visible")

	err1 := CleanupUsageRetention(db)
	if err1 == nil {
		t.Fatalf("第一轮应当 fail-loud（DROP 被依赖对象挡住），实际 err=nil")
	}
	// 先断言金额（本条的用户可见后果），再断言形态与身份标记。
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第一轮之后")
	s1ret01AssertFrozen(t, db)

	err2 := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	if err2 == nil {
		t.Fatalf("第二轮不得静默：依赖对象仍在，DROP 必然仍被挡住，本轮应当 fail-loud"+
			"（实际 err=nil failures=%d skipped=%d unreclaimed=%v）", st.Failures, st.Skipped, st.Unreclaimed)
	}
	if !s1ret01StatusMentions(st, "usage_2020q1") {
		t.Fatalf("第二轮必须点名 usage_2020q1（unreclaimed=%v failed_rels=%v）—— "+
			"DETACH 残留重新进了枚举面就该在这里留痕", st.Unreclaimed, st.FailedRelations)
	}
	if !relationExists(t, db, "usage_2020q1") {
		t.Fatalf("DROP 被依赖对象挡住，关系必须仍在盘上")
	}
	if n := r25UsageRowsIn(t, db, "usage_2020q1"); n == 0 {
		t.Fatalf("fail-loud 的轮次不得把明细搬空/删空（行数 = 0）")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第二轮之后")
}

// TestAuditS1Ret01DetachedWidePartitionIsRecoveredNextRound 是修法 ② 的**回收**判据：
// 依赖对象消失之后，**下一轮**必须把这条 DETACH 残留捡回来（补账 + 并入相邻月 + DROP），
// 而不是像修复前那样永远不再枚举它（第二轮 err=nil/failures=0，关系与金额一起留在
// 一个谁都看不见的角落）。
func TestAuditS1Ret01DetachedWidePartitionIsRecoveredNextRound(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret01-wide-recover"
	s1ret01QuarterFixture(t, db, username, "s1ret01_dep_recover")

	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("第一轮应当 fail-loud（DROP 被依赖对象挡住），实际 err=nil")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第一轮之后")
	s1ret01AssertFrozen(t, db)

	if _, err := db.Exec(`DROP VIEW s1ret01_dep_recover`); err != nil {
		t.Fatalf("撤掉依赖视图: %v", err)
	}
	err2 := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	if err2 != nil {
		t.Fatalf("依赖对象已撤掉，第二轮应当把 DETACH 残留回收掉，实际 err=%v（failures=%d failed_rels=%v）",
			err2, st.Failures, st.FailedRelations)
	}
	if st.ClearedDetached < 1 {
		t.Fatalf("第二轮没有回收任何 DETACH 残留（cleared_detached=%d）—— 该关系仍不在枚举面里", st.ClearedDetached)
	}
	if relationExists(t, db, "usage_2020q1") {
		t.Fatalf("usage_2020q1 应当已被回收（账本已补齐、相邻月已并入）")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第二轮之后")
}

// TestAuditS1Ret01MonthlyPartitionKeepsMonthAndStaysObservable 是反向对照：
// **规范月名**分区在同一注入下账本完整、第二轮仍 fail-loud（钉住「拓宽宽分区路径
// 不许弄坏规范路径」）。审计方已实测过这条对照，这里把它固定成用例。
func TestAuditS1Ret01MonthlyPartitionKeepsMonthAndStaysObservable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret01-monthly"
	uid := r24User(t, db, username)
	r25RetentionOn(t, db, "1")

	r24UsageAt(t, db, uid, "s1ret01-m", 7, BeijingDayInstant(bjDate(t, "2020-01-10")))
	if !relationExists(t, db, "usage_202001") {
		t.Fatalf("夹具前提不成立：usage_202001 没建出来")
	}
	if _, err := db.Exec(`CREATE VIEW s1ret01_dep_month AS SELECT count(*) AS n FROM usage_202001`); err != nil {
		t.Fatalf("建依赖视图: %v", err)
	}
	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("第一轮应当 fail-loud，实际 err=nil")
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-01-31")); len(days) != 1 || days[0] != "2020-01-10" {
		t.Fatalf("规范月名分区的预补账应当覆盖整月：账本日期 = %v（want [2020-01-10]）", days)
	}
	if got, _ := r25ReportTotal(t, db, username, bjDate(t, "2020-01-01"), bjDate(t, "2020-01-31")); math.Abs(got-7) > 1e-9 {
		t.Fatalf("对照组读数应当完好（7），实际 %.4f —— 差异不应来自规范月名路径", got)
	}
	err2 := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	if err2 == nil {
		t.Fatalf("对照组第二轮应当仍然 fail-loud（孤儿路径按名字认它），实际 err=nil")
	}
	if !s1ret01StatusMentions(st, "usage_202001") {
		t.Fatalf("对照组第二轮应当点名 usage_202001，实际 unreclaimed=%v failed_rels=%v", st.Unreclaimed, st.FailedRelations)
	}
}

// TestAuditS1Ret01ForeignSameNamedRelationsAreNeverReclaimed 是**反向判据**：
// 「已 DETACH 且仍是我们摘的」这条身份判据一旦被放松成「名字像我们的 / 形状像我们的 /
// 带标记就行」，下面三种关系就会被 DROP、或把别人的行补进我们的永久账本。三种都必须
// 原样不动：
//
//	(a) 别人手工建的同名**独立表**（列形状与 usage 完全一致）；
//	(b) 别人那棵树的分区（异名 + 整月对齐的可读边界，与「我们摘下来但边界被清空」
//	    只差「是不是 usage 的后代」这一条）；
//	(c) 我们自己摘下来的残留被挂到了**别人**的树下（带我们的标记，但已是别人的活分区）。
func TestAuditS1Ret01ForeignSameNamedRelationsAreNeverReclaimed(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret01-foreign")
	r25RetentionOn(t, db, "1")

	mustExec := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("夹具 DDL 失败: %s: %v", q, err)
		}
	}
	insertRow := func(rel, at string, cost float64) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(rel)+
			` (user_id, model, created_at, prompt_tokens, completion_tokens, cache_prompt_tokens, cost)`+
			` VALUES (?, 's1ret01-foreign', ?::timestamptz, 100, 10, 0, ?)`, uid, at, cost); err != nil {
			t.Fatalf("往 %s 写明细: %v", rel, err)
		}
	}

	// (a) 同名独立表：名字与列形状都像我们的残留，唯独没有我们写的标记。
	mustExec(`CREATE TABLE usage_2020q1 (LIKE usage INCLUDING DEFAULTS)`)
	insertRow("usage_2020q1", "2020-01-10T00:00:00+08", 3)
	insertRow("usage_2020q1", "2020-02-10T00:00:00+08", 4)
	insertRow("usage_2020q1", "2020-03-10T00:00:00+08", 5)

	// (b) 别人那棵树的分区：异名 + 整月对齐的可读边界。
	mustExec(`CREATE TABLE s1ret01_archive (LIKE usage INCLUDING DEFAULTS) PARTITION BY RANGE (created_at)`)
	mustExec(`CREATE TABLE usage_2019h2 PARTITION OF s1ret01_archive ` +
		`FOR VALUES FROM ('2019-07-01 00:00:00+08') TO ('2020-01-01 00:00:00+08')`)
	insertRow("usage_2019h2", "2019-08-10T00:00:00+08", 9)

	// (c) 我们的标记 + 别人的活分区：标记不是唯一判据（relispartition 必须一起看）。
	mustExec(`CREATE TABLE usage_2020q2 PARTITION OF s1ret01_archive ` +
		`FOR VALUES FROM ('2020-04-01 00:00:00+08') TO ('2020-07-01 00:00:00+08')`)
	mustExec(`COMMENT ON TABLE usage_2020q2 IS '` +
		usageRetentionOwnedComment(bjDate(t, "2020-04-01"), bjDate(t, "2020-06-30")) + `'`)
	insertRow("usage_2020q2", "2020-05-10T00:00:00+08", 11)

	foreign := []string{"usage_2020q1", "usage_2019h2", "usage_2020q2"}
	wantRows := map[string]int64{"usage_2020q1": 3, "usage_2019h2": 1, "usage_2020q2": 1}
	// 违规项**全部收集**再一次性报出：这条用例是一次"身份判据被放松"的探针，
	// 首条断言就退出会把"关系被 DROP / 账本被污染"这些更重的后果藏在后面。
	var problems []string

	// 候选面判据（能力级）：一条都不得进保留期的候选面 —— 进了就意味着它会被补账并
	// DROP（孤儿路径的动作）。名字 / 形状 / 标记**单独**都不构成身份判据。
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatalf("扫描月关系: %v", err)
	}
	for _, rel := range foreign {
		if _, ok := tables.Shapes[rel]; ok {
			problems = append(problems, fmt.Sprintf("%s 进了保留候选面（orphans=%v）：它不是我们摘下来的残留",
				rel, tables.Orphans))
		}
	}

	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			problems = append(problems, fmt.Sprintf("第 %d 轮报错（这三条关系都不属于我们）：%v", round, err))
		}
	}
	for _, rel := range foreign {
		if !relationExists(t, db, rel) {
			problems = append(problems, fmt.Sprintf("%s 被 DROP 了 —— 别人的关系（同名独立表 / 别人树的分区 / 别人的活分区）不得被回收", rel))
			continue
		}
		if n := r25UsageRowsIn(t, db, rel); n != wantRows[rel] {
			problems = append(problems, fmt.Sprintf("%s 的明细行数 = %d，want %d（别人的明细不得被搬走）", rel, n, wantRows[rel]))
		}
	}
	// 账本判据：别人的明细**一行都不得**进我们的永久账本（那是把它们算成我们的用量）。
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2019-07-01"), bjDate(t, "2020-06-30")); len(days) != 0 {
		problems = append(problems, fmt.Sprintf("永久账本里出现了这些关系的行 %v —— 别人的明细被补进了我们的账本（金额污染）", days))
	}
	if len(problems) > 0 {
		t.Fatalf("别人的同名关系被当成我们的残留处理了：\n - %s", strings.Join(problems, "\n - "))
	}
}

// ---------------------------------------------------------------------------
// S1-RET-R（第二十九轮补强；红队报告 temp/audit-v282/verify/S1-RET-01.md，判定 PARTIAL）
//
// 红队指出交付判据缺三条子不变量的牙，外加一个 P2 级真实缺口（标记脆性）。本节把四条
// 都钉成可复跑的判据，并（按主控裁定，理由见报告 §3）把「别人的同名表 + 我们格式的
// exact COMMENT」这一形态落成**已知且接受**的出厂用例：
//
//	P2   追加运维说明 ⇒ 解析器读不懂 ⇒ 关系重新跌出枚举面（关系与磁盘永久漏收）；
//	VM2  「标记写入与 DETACH 同事务」没有判据（改成两步也全绿）；
//	VM3d 「解析器严格性」没有判据（放松成"包含关键字即认"也全绿）；
//	VM4  「leafTable() 限定」没有判据（去掉后全绿，账本被树里 2018 的明细污染）。
// ---------------------------------------------------------------------------

// TestAuditS1Ret01OwnedCommentDirections 是标记解析器的**方向表**：每一行一个方向，
// 两种方向都必须在场 ——
//
//	认  ：规范头（前缀 + v1 + from=/to= 逐字）成立；**规范头之后**的尾部注解任意，
//	      不影响判定，也不影响解析出的窗口；
//	不认：规范头或字段不逐字（含"包含关键字"、缺字段、顺序颠倒、版本不是 v1、
//	      大小写不符、前导空白/BOM、字段间夹注解、日期非法、区间倒置）。
//
// 变异对照（见报告 §4 的红/绿矩阵）：
//   - 把解析改成「包含关键字即认」⇒ 本表的不认行（prefix_only / missing_to /
//     reordered_fields / inverted_range / bad_month…）整片变红；
//   - 把"容忍尾部"改回「整串 exact」（旧实现 `len(strings.Fields(rest)) != 2`）⇒
//     本表的 trailing_* 行整片变红。
func TestAuditS1Ret01OwnedCommentDirections(t *testing.T) {
	canonical := usageRetentionOwnedComment(bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31"))
	// 写入侧与读取侧同源：方向表以写入侧渲染出的原文为基准，任何一侧改了都会被这里抓住。
	if canonical != usageRetentionOwnedCommentPrefix+" v1 from=2020-01-01 to=2020-03-31" {
		t.Fatalf("标记的规范形态变了：%q —— 方向表必须与写入侧同源同改", canonical)
	}
	cases := []struct {
		name    string
		comment string
		want    bool
		why     string
	}{
		// ---- 认：规范头逐字成立；尾部注解（任意）不参与判定 ----
		{"canonical_no_annotation", canonical, true, "写入侧的原样形态"},
		{"trailing_space_annotation", canonical + " [ops:已确认可以清理]", true, "运维追加一句说明（红队 §3.3 的现场形态）"},
		{"trailing_newline_annotation", canonical + "\n[ops]\n第二行说明", true, "多行注解"},
		{"trailing_glued_annotation", canonical + "[ops]", true, "末尾直接粘着写（无空白分隔）"},
		{"trailing_whitespace_only", canonical + "   \t\n", true, "只有空白"},
		{"trailing_long_annotation", canonical + " " + strings.Repeat("x", 4096), true, "超长注解"},
		{"trailing_field_like_annotation", canonical + " from=1999-01-01 to=1999-12-31", true, "注解里出现像字段的文本 —— 仍以规范头为准"},
		{"trailing_extra_field", canonical + " extra", true, "尾部多一个词（旧实现把它当『多一个字段』拒绝）"},
		{"trailing_extra_digit", canonical + "0", true, "日期后粘一个多余字符：窗口仍是规范日期（不放大区间）"},
		{"trailing_iso_time_suffix", usageRetentionOwnedCommentPrefix +
			" v1 from=2020-01-01 to=2020-03-31T00:00:00Z", true, "日期后带 ISO 时间后缀：窗口按日期算（月份归属不受时分秒影响）"},
		{"tab_between_fields", strings.Replace(canonical, " to=", "\tto=", 1), true, "两个规范字段之间的 ASCII 空白可以是制表符"},
		{"multi_space_between_fields", usageRetentionOwnedCommentPrefix +
			" v1 from=2020-01-01    to=2020-03-31", true, "字段间多空格（等价输入）"},
		// ---- 不认：规范头或字段不逐字 ----
		{"empty", "", false, "空注释"},
		{"unrelated_text", "普通运维说明", false, "别人的注释"},
		{"other_vendor_prefix", "acme:usage-retention:owned v1 from=2020-01-01 to=2020-03-31", false, "别家的前缀"},
		{"prefix_only", usageRetentionOwnedCommentPrefix, false, "只有前缀（『包含关键字即认』会误认它）"},
		{"prefix_and_version_only", usageRetentionOwnedCommentPrefix + " v1 ", false, "没有字段"},
		{"missing_version", usageRetentionOwnedCommentPrefix + " from=2020-01-01 to=2020-03-31", false, "缺版本号"},
		{"unknown_version", usageRetentionOwnedCommentPrefix + " v2 from=2020-01-01 to=2020-03-31", false, "未知版本（除 v1 一律不认）"},
		{"uppercase_version", usageRetentionOwnedCommentPrefix + " V1 from=2020-01-01 to=2020-03-31", false, "版本号大小写不逐字"},
		{"uppercase_prefix", "Picoaide:usage-retention:owned v1 from=2020-01-01 to=2020-03-31", false, "前缀大小写不逐字"},
		{"double_space_before_version", usageRetentionOwnedCommentPrefix + "  v1 from=2020-01-01 to=2020-03-31", false, "版本号前多一个空格（前缀+版本必须逐字）"},
		{"empty_date_fields", usageRetentionOwnedCommentPrefix + " v1 from= to=", false, "空日期"},
		{"leading_space", " " + canonical, false, "前导空白"},
		{"leading_bom", "\ufeff" + canonical, false, "前导 BOM"},
		{"missing_to", usageRetentionOwnedCommentPrefix + " v1 from=2020-01-01", false, "缺 to 字段"},
		{"reordered_fields", usageRetentionOwnedCommentPrefix + " v1 to=2020-03-31 from=2020-01-01", false, "字段顺序颠倒"},
		{"annotation_between_fields", usageRetentionOwnedCommentPrefix + " v1 from=2020-01-01 [ops] to=2020-03-31", false, "注解塞在两个规范字段之间（尾部注解只允许出现在最后一个规范字段之后）"},
		{"fields_glued", usageRetentionOwnedCommentPrefix + " v1 from=2020-01-01to=2020-03-31", false, "两个规范字段之间没有空白"},
		{"non_ascii_space_between_fields", usageRetentionOwnedCommentPrefix + " v1 from=2020-01-01\u00a0to=2020-03-31", false, "NBSP 不是 ASCII 空白（字段不逐字）"},
		{"inverted_range", usageRetentionOwnedCommentPrefix + " v1 from=2020-03-31 to=2020-01-01", false, "区间倒置"},
		{"bad_month", usageRetentionOwnedCommentPrefix + " v1 from=2020-13-01 to=2021-01-31", false, "月份非法"},
		{"bad_day", usageRetentionOwnedCommentPrefix + " v1 from=2020-02-30 to=2020-03-31", false, "日期非法"},
		{"short_date", usageRetentionOwnedCommentPrefix + " v1 from=2020-1-1 to=2020-03-31", false, "日期不足 10 字符"},
	}
	for _, c := range cases {
		from, to, ok := parseUsageRetentionOwnedComment(c.comment)
		if ok != c.want {
			t.Errorf("方向表不符 %s：want ok=%v，got ok=%v（%s）\n  注释=%q", c.name, c.want, ok, c.why, c.comment)
			continue
		}
		if !ok {
			continue
		}
		if got := from.Format(dateFmt) + ".." + to.Format(dateFmt); got != "2020-01-01..2020-03-31" {
			t.Errorf("方向表不符 %s：解析出的窗口 = %s，want 2020-01-01..2020-03-31（尾部注解不得影响窗口）",
				c.name, got)
		}
	}
}

// TestAuditS1Ret01AnnotatedMarkerStaysObservableAndRecoverable 是 P2（标记脆性）的
// 端到端判据：冻结段提交之后，**运维在标记后面追加一句说明**（`COMMENT ON TABLE`
// 正是给已摘下来的表做标注的工具）不得让关系重新跌出枚举面。
//
// 断言链（每一条都独立可被打坏）：
//   - 追加说明之后解析器仍认这条标记（"容忍尾部"被改回"整串 exact"即红）；
//   - 依赖还在 ⇒ 第二轮 **fail-loud 且点名** usage_2020q1（关系不在枚举面即红）；
//   - 依赖撤掉 ⇒ 第三轮**回收成功**（关系与磁盘不再永久漏收）；
//   - 全程金额三天齐（修法 ① 的窗口没有因此回退）。
func TestAuditS1Ret01AnnotatedMarkerStaysObservableAndRecoverable(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret01-annotated"
	s1ret01QuarterFixture(t, db, username, "s1ret01_dep_annotated")

	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("第一轮应当 fail-loud（DROP 被依赖对象挡住），实际 err=nil")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第一轮之后")
	s1ret01AssertFrozen(t, db)

	// 运维动作：保留规范头，后面追加一句说明。
	annotated := usageRetentionOwnedComment(bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31")) +
		" [ops:已确认可以清理，等依赖视图下线]"
	if _, err := db.Exec(`COMMENT ON TABLE usage_2020q1 IS '` + quoteSQLLiteral(annotated) + `'`); err != nil {
		t.Fatalf("追加运维说明: %v", err)
	}
	if got := s1ret01Comment(t, db, "usage_2020q1"); got != annotated {
		t.Fatalf("夹具未落地：注释 = %q，want %q", got, annotated)
	}
	// 量具自校准：先证明"这条注释确实带着尾部注解、且确实是我们要认的那条"。
	if _, _, ok := parseUsageRetentionOwnedComment(annotated); !ok {
		t.Fatalf("追加说明之后解析器必须仍认这条标记（否则关系重新跌出枚举面 = P2 回退）：%q", annotated)
	}

	err2 := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	if err2 == nil {
		t.Fatalf("第二轮不得静默：依赖对象仍在，DROP 必然仍被挡住，本轮应当 fail-loud"+
			"（实际 err=nil failures=%d cleared_detached=%d unreclaimed=%v）—— 关系已跌出枚举面",
			st.Failures, st.ClearedDetached, st.Unreclaimed)
	}
	if !s1ret01StatusMentions(st, "usage_2020q1") {
		t.Fatalf("带尾部注解的标记必须仍把关系留在枚举面上（第二轮应点名 usage_2020q1）："+
			"unreclaimed=%v failed_rels=%v", st.Unreclaimed, st.FailedRelations)
	}
	if !relationExists(t, db, "usage_2020q1") {
		t.Fatalf("DROP 被依赖对象挡住，关系必须仍在盘上")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第二轮之后")

	if _, err := db.Exec(`DROP VIEW s1ret01_dep_annotated`); err != nil {
		t.Fatalf("撤掉依赖视图: %v", err)
	}
	err3 := CleanupUsageRetention(db)
	st3 := CurrentUsageRetentionStatus()
	if err3 != nil {
		t.Fatalf("依赖对象已撤掉，第三轮应当把带注解的 DETACH 残留回收掉，实际 err=%v（failures=%d failed_rels=%v）",
			err3, st3.Failures, st3.FailedRelations)
	}
	if st3.ClearedDetached < 1 {
		t.Fatalf("第三轮没有回收任何 DETACH 残留（cleared_detached=%d）—— 带注解的标记没被认出来", st3.ClearedDetached)
	}
	if relationExists(t, db, "usage_2020q1") {
		t.Fatalf("usage_2020q1 应当已被回收（账本已补齐、相邻月已并入）")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第三轮之后")
}

// s1ret01MarkerTxShapeProblems 是 VM2（「标记写入必须与 DETACH 在同一个事务」）的
// **结构判据**：从源码里检查那段不变量，返回全部问题（空 = 不变量成立）。
//
// 口径：`reclaimUsagePartitionAtomically` 的冻结段里，标记与 DETACH 必须
//   - 都走冻结段事务句柄（`tx.Exec`，不是 `db.Exec`、也不是另一个事务句柄）；
//   - 都落在 `beginUsageBoundedTx(` 之后；
//   - 都落在 DETACH 之后的第一个 `tx.commit()` **之前**（提交之后这个事务就结束了）；
//   - 标记值由唯一实现 `usageRetentionOwnedComment` 渲染；
//   - 全包只有**一处** `COMMENT ON TABLE` 写入点（写错一个标记就是把别人的表列进 DROP 名单）。
//
// 咬得住什么：把 COMMENT 挪到 `db.Exec` / 另一个事务 / 提交之后（VM2 的形态）、
// 删掉写入点、把标记值改成手写字符串、新增第二个写入点。
// 咬不住什么：把两条语句整体抽进一个"接收 tx"的辅助函数（锚点找不到 ⇒ **fail-closed 变红**，
// 需要同步更新锚点，属有意为之的保守）；以及任何"形状对但运行期语义变了"的改法 ——
// 那一半由 TestAuditS1Ret01CommentFailureRollsBackDetach 的故障注入覆盖。
func s1ret01MarkerTxShapeProblems(src string) []string {
	var problems []string
	if n := strings.Count(src, `"COMMENT ON TABLE "`); n != 1 {
		problems = append(problems, fmt.Sprintf("产品代码里 COMMENT ON TABLE 写入点 = %d 处，want 恰好 1 处", n))
	}
	start := strings.Index(src, "func reclaimUsagePartitionAtomically(")
	if start < 0 {
		return append(problems, "锚点失效：源码里找不到 func reclaimUsagePartitionAtomically(（判据必须随重构一起更新）")
	}
	end := strings.Index(src[start:], "\n}\n")
	if end < 0 {
		return append(problems, "锚点失效：找不到冻结段函数的结尾")
	}
	body := src[start : start+end]
	mark := strings.Index(body, `tx.Exec("COMMENT ON TABLE "`)
	detach := strings.Index(body, `tx.Exec("ALTER TABLE usage DETACH PARTITION "`)
	if mark < 0 {
		problems = append(problems, "标记没有走冻结段事务句柄（tx.Exec(\"COMMENT ON TABLE \" …）："+
			"「与 DETACH 同一个事务」要求两条语句共用一个事务句柄")
	}
	if detach < 0 {
		problems = append(problems, "锚点失效：冻结段里找不到 tx.Exec(\"ALTER TABLE usage DETACH PARTITION \" …)")
	}
	if mark >= 0 && detach >= 0 {
		begin := strings.Index(body, "beginUsageBoundedTx(")
		if begin < 0 || begin > mark || begin > detach {
			problems = append(problems, "两条语句必须都在冻结段事务（beginUsageBoundedTx）之内")
		}
		if rel := strings.Index(body[detach:], "tx.commit()"); rel < 0 {
			problems = append(problems, "锚点失效：DETACH 之后找不到 tx.commit()")
		} else if mark > detach+rel {
			problems = append(problems, "标记写在冻结段提交之后：DETACH 已提交而标记还没写，"+
				"两步之间失败就留下一条无标记的孤儿（永远不再被枚举）")
		}
	}
	return problems
}

// TestAuditS1Ret01MarkerIsWrittenInsideTheDetachTransaction 用结构判据钉住 VM2。
//
// 为什么这条不变量必须单独有判据：行程内两步都成功时，行为与"同事务"逐字节相同
// （红队 VM2 实测：把 COMMENT 移出事务，修复方 4 条判据与红队的 15 条探针**全绿**）。
// 差异只在"DETACH 与 COMMENT 之间失败"时显现 —— 而那正是本条缺陷的现场
// （冻结已提交、后续失败 ⇒ 无标记的孤儿 ⇒ 永不再枚举）。运行期那一半由
// TestAuditS1Ret01CommentFailureRollsBackDetach 用真 SQL 故障注入覆盖。
func TestAuditS1Ret01MarkerIsWrittenInsideTheDetachTransaction(t *testing.T) {
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatalf("取不到本测试文件的路径（判据锚点失效）")
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(thisFile), "usage_ledger.go"))
	if err != nil {
		t.Fatalf("读 usage_ledger.go: %v", err)
	}
	src := string(raw)
	if problems := s1ret01MarkerTxShapeProblems(src); len(problems) > 0 {
		t.Fatalf("「标记与 DETACH 同事务」这条不变量被破坏：\n - %s", strings.Join(problems, "\n - "))
	}
	// 量具自校准：把两种 VM2 形态喂给**同一套锚点**，必须都报错 ——
	// 否则"判据有牙"这句话本身就没有证据（本项目已登记"变异落地 ≠ 变异有效"）。
	mutants := map[string]string{
		"COMMENT 挪出事务（DETACH 之后由 db.Exec 单独一条语句）": "func reclaimUsagePartitionAtomically() {\n" +
			"\ttx, _ := beginUsageBoundedTx(ctx, db)\n" +
			"\tif _, err := tx.Exec(\"ALTER TABLE usage DETACH PARTITION \" + rel); err != nil {\n\t\treturn\n\t}\n" +
			"\tif err := tx.commit(); err != nil {\n\t\treturn\n\t}\n" +
			"\tif _, err := db.Exec(\"COMMENT ON TABLE \" + rel + \" IS '\" + quoteSQLLiteral(usageRetentionOwnedComment(from, to)) + \"'\"); err != nil {\n\t\treturn\n\t}\n}\n",
		"COMMENT 落在同一个事务句柄、但在提交之后": "func reclaimUsagePartitionAtomically() {\n" +
			"\ttx, _ := beginUsageBoundedTx(ctx, db)\n" +
			"\tif _, err := tx.Exec(\"ALTER TABLE usage DETACH PARTITION \" + rel); err != nil {\n\t\treturn\n\t}\n" +
			"\tif err := tx.commit(); err != nil {\n\t\treturn\n\t}\n" +
			"\tif _, err := tx.Exec(\"COMMENT ON TABLE \" + rel + \" IS '\" + quoteSQLLiteral(usageRetentionOwnedComment(from, to)) + \"'\"); err != nil {\n\t\treturn\n\t}\n}\n",
	}
	for name, mutant := range mutants {
		if problems := s1ret01MarkerTxShapeProblems(mutant); len(problems) == 0 {
			t.Errorf("量具自校准失败：VM2 形态「%s」没有被结构判据咬住 —— 这条判据没有牙", name)
		}
	}
}

// TestAuditS1Ret01CommentFailureRollsBackDetach 是 VM2 的**故障注入**判据：在真 SQL
// 层让 `COMMENT ON TABLE` 必然失败（事件触发器，只在测试库里、不碰生产代码），然后断言
// 不变量「要么整轮回滚（关系仍挂在 usage 下）、要么带着标记被摘下来」成立。
//
// 为什么这能分辨 VM2：正确形态下 COMMENT 在 DETACH 之前、同一个事务里 ⇒ 注入点一响
// 整轮回滚 ⇒ 关系**仍然挂在 usage 下**、且**没有**标记；而把 COMMENT 移出事务（DETACH
// 先提交、再单独写标记）时，注入点恰好落在"已摘下来、还没写标记"的窗口里 ⇒ 关系被摘、
// 无标记 ⇒ 从所有轮次的枚举面消失（第二轮 err=nil）⇒ 本用例的"仍在挂载 / 仍在枚举面"
// 两条断言同时变红。
//
// 咬得住什么：DETACH 先提交、标记后写（无论标记写在 db 上还是另一个事务里）。
// 咬不住什么：把**两条语句整体顺序颠倒**但仍在同一事务里（那仍然原子，语义等价，
// 不该变红 —— 本用例有意不判顺序）；也咬不住"先写标记、再单独提交、再 DETACH"这种
// 同族变体（本用例的注入点打在 COMMENT 上，那种变体下 COMMENT 失败会先中止）。
func TestAuditS1Ret01CommentFailureRollsBackDetach(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret01-atomic"
	s1ret01QuarterFixture(t, db, username, "s1ret01_dep_atomic")

	// 故障注入装置：COMMENT 的命令标签是 'COMMENT'，事件触发器可以在 ddl_command_start
	// 抛异常 ⇒ 真 SQL 层失败（不是 mock、不是测试钩子），事务随之回滚。
	mustExec := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("夹具 DDL 失败: %s: %v", q, err)
		}
	}
	mustExec(`CREATE TABLE s1ret01_calib (x int)`)
	if _, err := db.Exec(`CREATE FUNCTION s1ret01_block_comment() RETURNS event_trigger AS $$
BEGIN RAISE EXCEPTION 's1ret01 fault injection: COMMENT blocked'; END $$ LANGUAGE plpgsql`); err != nil {
		t.Skipf("事件触发器不可用（%v）—— 本用例的故障注入手段在这种部署下不可达", err)
	}
	if _, err := db.Exec(`CREATE EVENT TRIGGER s1ret01_block_comment ON ddl_command_start WHEN TAG IN ('COMMENT') EXECUTE FUNCTION s1ret01_block_comment()`); err != nil {
		t.Skipf("创建事件触发器失败（%v）—— 需要超级用户/建触发器权限，本用例的注入手段不可达", err)
	}
	// 量具自校准：先证明注入点**真的**拦得住 COMMENT（"变异落地 ≠ 变异有效"）。
	if _, err := db.Exec(`COMMENT ON TABLE s1ret01_calib IS 'x'`); err == nil || !strings.Contains(err.Error(), "s1ret01 fault injection") {
		t.Fatalf("故障注入未生效：COMMENT ON TABLE 没有被事件触发器拦住（err=%v）—— 本用例的结论不成立", err)
	}
	// 注入点的**边界**也要自校准：它只该拦 COMMENT，不该拦 DETACH/其它 DDL。
	mustExec(`CREATE TABLE s1ret01_calib2 (x int)`)

	// 第一轮：COMMENT 必然失败 ⇒ 冻结段整体回滚 ⇒ 关系仍挂在 usage 下、且无标记。
	err1 := CleanupUsageRetention(db)
	st1 := CurrentUsageRetentionStatus()
	if err1 == nil {
		t.Fatalf("COMMENT 被注入失败，本轮应当 fail-loud，实际 err=nil（failures=%d skipped=%d）",
			st1.Failures, st1.Skipped)
	}
	if !s1ret01StatusMentions(st1, "usage_2020q1") {
		t.Fatalf("本轮必须点名 usage_2020q1（unreclaimed=%v failed_rels=%v）", st1.Unreclaimed, st1.FailedRelations)
	}
	var stillPartition bool
	if err := db.QueryRow(`SELECT relispartition FROM pg_class WHERE relname='usage_2020q1'`).Scan(&stillPartition); err != nil {
		t.Fatalf("读 relispartition: %v", err)
	}
	if !stillPartition {
		t.Fatalf("标记写失败时整轮必须回滚 —— 关系被摘下来了（relispartition=false）："+
			"这就是「DETACH 已提交、标记没写下」的形态，它从所有轮次的枚举面消失。"+
			"残留：%v", s1ret01UnmarkedDetachedLeftovers(t, db))
	}
	if n := r25UsageRowsIn(t, db, "usage_2020q1"); n != 3 {
		t.Fatalf("回滚后明细应当一行未动（3 行），实际 %d 行", n)
	}
	if got := s1ret01Comment(t, db, "usage_2020q1"); strings.Contains(got, usageRetentionOwnedCommentPrefix) {
		t.Fatalf("回滚后不得留下我们的标记（注释 = %q）—— 标记与 DETACH 要么都在、要么都不在", got)
	}
	if leftovers := s1ret01UnmarkedDetachedLeftovers(t, db); len(leftovers) > 0 {
		t.Fatalf("出现了「已摘下来、又没有标记」的关系 %v —— 它永不再被枚举", leftovers)
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第一轮（注入）之后")

	// 第二轮（注入仍在）：必须仍然 fail-loud 且仍在枚举面上。
	err2 := CleanupUsageRetention(db)
	st2 := CurrentUsageRetentionStatus()
	if err2 == nil || !s1ret01StatusMentions(st2, "usage_2020q1") {
		t.Fatalf("第二轮必须仍 fail-loud 并点名该关系（err=%v unreclaimed=%v failed_rels=%v）",
			err2, st2.Unreclaimed, st2.FailedRelations)
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第二轮（注入）之后")

	// 撤掉注入 + 撤掉依赖 ⇒ 第三轮必须能正常走完冻结段与结算段（证明注入点确实打在
	// COMMENT 上，且没有把状态改坏）。
	if _, err := db.Exec(`DROP EVENT TRIGGER s1ret01_block_comment`); err != nil {
		t.Fatalf("撤掉事件触发器: %v", err)
	}
	if _, err := db.Exec(`DROP VIEW s1ret01_dep_atomic`); err != nil {
		t.Fatalf("撤掉依赖视图: %v", err)
	}
	err3 := CleanupUsageRetention(db)
	st3 := CurrentUsageRetentionStatus()
	if err3 != nil {
		t.Fatalf("注入撤掉后应当能回收，实际 err=%v（failures=%d failed_rels=%v）", err3, st3.Failures, st3.FailedRelations)
	}
	if relationExists(t, db, "usage_2020q1") {
		t.Fatalf("注入撤掉后 usage_2020q1 应当被回收")
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "第三轮之后")
}

// s1ret01UnmarkedDetachedLeftovers 返回扫描面里**已不在 usage 树下、名字又不是六位月、
// 也没有可解析标记**的关系 —— 也就是"从所有轮次的枚举面消失、永不自愈"的那一类
// （S1-RET-01 的缺陷本体）。它是"标记与 DETACH 要么都在、要么都不在"这条不变量的
// 机器可读形式。
func s1ret01UnmarkedDetachedLeftovers(t *testing.T, db *sql.DB) []string {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname, COALESCE(c.relkind,''),
	    COALESCE(pg_partition_root(c.oid) = to_regclass('public.usage'), false),
	    COALESCE(obj_description(c.oid,'pg_class'),'')
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname LIKE 'usage\_%' AND c.relkind IN ('r','p')
ORDER BY c.relname`)
	if err != nil {
		t.Fatalf("扫描 usage_%% 关系: %v", err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var rel, kind, comment string
		var attached bool
		if err := rows.Scan(&rel, &kind, &attached, &comment); err != nil {
			t.Fatalf("scan 关系: %v", err)
		}
		if attached || usageLedgerRelation(rel) {
			continue
		}
		if _, ok := usageMonthRelationOf(rel); ok {
			continue
		}
		if _, _, ok := parseUsageRetentionOwnedComment(comment); ok {
			continue
		}
		out = append(out, rel+"("+kind+")")
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("扫描 usage_%% 关系: %v", err)
	}
	return out
}

// TestAuditS1Ret01MarkedDetachedNonLeafStaysOutOfFace 是 VM4 的判据：
// `ownedDetachedLeftover()` 的 `leafTable()` 限定必须有牙。
//
// 夹具（= 红队 V11 的形态）：一条**已摘下来**（不挂在 usage 下）的**非叶子**关系，
// 带着我们格式的完整标记，子树里还有一棵持有 2018 明细的叶子。
// 去掉 `leafTable()` 之后它会进候选面 ⇒ 孤儿路径对分区父表做 fold + 预补账 ⇒
// **树里的 2018 明细被补进我们永久的账本**（金额污染），而 DROP 会连子关系一起删。
//
// 期望：不进候选面、一行不动、账本零污染、不报错（它不属保留期管辖对象面）。
func TestAuditS1Ret01MarkedDetachedNonLeafStaysOutOfFace(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret01-nonleaf")
	r25RetentionOn(t, db, "1")

	mustExec := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("夹具 DDL 失败: %s: %v", q, err)
		}
	}
	// 非叶子 + 异名（不是六位月）+ 带我们的标记 + 不挂在 usage 下。
	mustExec(`CREATE TABLE usage_2018h1 (LIKE usage INCLUDING DEFAULTS) PARTITION BY RANGE (created_at)`)
	mustExec(`CREATE TABLE usage_2018h1_c1 PARTITION OF usage_2018h1 ` +
		`FOR VALUES FROM ('2018-01-01 00:00:00+08') TO ('2018-04-01 00:00:00+08')`)
	mustExec(`COMMENT ON TABLE usage_2018h1 IS '` +
		quoteSQLLiteral(usageRetentionOwnedComment(bjDate(t, "2018-01-01"), bjDate(t, "2018-03-31"))) + `'`)
	if _, err := db.Exec(`INSERT INTO usage_2018h1_c1 (user_id, model, created_at, prompt_tokens,`+
		` completion_tokens, cache_prompt_tokens, cost) VALUES (?, 's1ret01-nonleaf', `+
		`'2018-02-10T00:00:00+08'::timestamptz, 100, 10, 0, 13)`, uid); err != nil {
		t.Fatalf("写 2018 明细: %v", err)
	}
	// 前提自检：它确实是 relkind='p' 的非叶子、且不挂在 usage 下。
	var kind string
	var children int
	if err := db.QueryRow(`SELECT c.relkind, (SELECT count(*) FROM pg_inherits i WHERE i.inhparent=c.oid)
	    FROM pg_class c WHERE c.relname='usage_2018h1'`).Scan(&kind, &children); err != nil {
		t.Fatalf("读形态: %v", err)
	}
	if kind != "p" || children == 0 {
		t.Fatalf("夹具前提不成立：relkind=%q children=%d（want p / >0）", kind, children)
	}

	// 候选面判据（能力级）：带标记但**非叶子** ⇒ 不是我们的可达残留面，不进候选。
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatalf("扫描月关系: %v", err)
	}
	for _, rel := range []string{"usage_2018h1", "usage_2018h1_c1"} {
		if _, ok := tables.Shapes[rel]; ok {
			t.Fatalf("%s 进了保留候选面（orphans=%v）—— `leafTable()` 限定必须在场："+
				"非叶子走孤儿路径会对分区父表做 fold，并把树里的 2018 明细补进永久账本", rel, tables.Orphans)
		}
	}

	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮不该报错（这条关系不属于保留期的对象面）：%v", round, err)
		}
	}
	if !relationExists(t, db, "usage_2018h1") || !relationExists(t, db, "usage_2018h1_c1") {
		t.Fatalf("非叶子 DETACH 残留不得被回收（关系与子关系都必须原样留着，交人工处置）")
	}
	if n := r25UsageRowsIn(t, db, "usage_2018h1_c1"); n != 1 {
		t.Fatalf("子关系里的明细行数 = %d，want 1（一行都不得被搬走/删掉）", n)
	}
	// 账本判据：树里 2018 的明细**一行都不得**进我们的永久账本。
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2018-01-01"), bjDate(t, "2018-03-31")); len(days) != 0 {
		t.Fatalf("永久账本里出现了 2018 的行 %v —— 非叶子 DETACH 残留被当成候选面处理了（金额污染）", days)
	}
}

// TestAuditS1Ret01ForgedOwnedMarkerIsAcceptedBoundary 把红队 §3.1 的**反向对照缺口**
// 落成出厂用例：别人手工建的同名独立表 + **我们格式的 exact COMMENT**。
//
// 结论：**认账（已知且接受）**，不是缺陷（论证见报告 §3）。本用例把"接受"这件事钉死，
// 并同时钉住使它可接受的两条对照事实：
//
//	① 标记不是新增能力：**名字即身份**（`usage_<YYYYMM>`，连注释都不需要）是修复前就
//	   有的存量口径（`candidateForRetention` 路径 1 一字未改），本用例把两种形态放在
//	   同一个库里对照，断言它们**行为相同**；
//	② 动作只落在"伪造者自己拥有的关系"上：写 COMMENT 要求关系属主（PG 语义，红队已用
//	   真 SQL 实测：`COMMENT ON TABLE` 别人的表 ⇒ `must be owner of table`）⇒ 能打上我们
//	   标记的人必然是那张表的属主 ⇒ 被 DROP 的是他自己的表，不是第三方的数据；
//	   明细会被补进我们的永久账本（金额污染）这件事**修复前就能做**（形态 ① 不需要注释），
//	   所以标记没有扩大"能做这件事的人"的集合，只扩大了"能触发的名字形态"。
//
// 边界（"能做什么/不能做什么"的完整清单见报告 §3）：本形态能做的是"让自己拥有的
// `usage_*` 名关系被回收 + 把任意 (user, day, cost) 行灌进我们的永久账本"；不能做的是
// "删掉别人的关系"（DROP 要求属主）。**真正**的收窄需要第二要素（只增登记表 ⇒ 要迁移，
// 或 settings 里的 instance_id ⇒ 与伪造者同库同角色、可读 ⇒ 零增益），代价与收益见报告。
func TestAuditS1Ret01ForgedOwnedMarkerIsAcceptedBoundary(t *testing.T) {
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret01-forged")
	r25RetentionOn(t, db, "1")

	mustExec := func(q string) {
		t.Helper()
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("夹具 DDL 失败: %s: %v", q, err)
		}
	}
	insertRow := func(rel, at string, cost float64) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(rel)+
			` (user_id, model, created_at, prompt_tokens, completion_tokens, cache_prompt_tokens, cost)`+
			` VALUES (?, 's1ret01-forged', ?::timestamptz, 100, 10, 0, ?)`, uid, at, cost); err != nil {
			t.Fatalf("往 %s 写明细: %v", rel, err)
		}
	}

	// (d) 伪造形态：同名独立表 + 我们格式的 exact COMMENT（红队夹具）。
	mustExec(`CREATE TABLE usage_2020q1 (LIKE usage INCLUDING DEFAULTS)`)
	mustExec(`COMMENT ON TABLE usage_2020q1 IS '` +
		quoteSQLLiteral(usageRetentionOwnedComment(bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31"))) + `'`)
	insertRow("usage_2020q1", "2020-01-10T00:00:00+08", 3)
	insertRow("usage_2020q1", "2020-02-10T00:00:00+08", 4)
	insertRow("usage_2020q1", "2020-03-10T00:00:00+08", 5)
	// (d0) 存量对照：名字即身份（六位月），**没有任何注释**。
	mustExec(`CREATE TABLE usage_201801 (LIKE usage INCLUDING DEFAULTS)`)
	insertRow("usage_201801", "2018-01-10T00:00:00+08", 7)

	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatalf("扫描月关系: %v", err)
	}
	for _, rel := range []string{"usage_2020q1", "usage_201801"} {
		if _, ok := tables.Shapes[rel]; !ok {
			t.Fatalf("%s 没进候选面 —— 本用例钉的是「接受」（认账）这一当前行为，"+
				"若它变成不进候选面，说明身份判据收窄了，请同步更新报告 §3 的结论", rel)
		}
	}

	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮不该报错（两条关系都是叶子、可回收）：%v", round, err)
		}
	}
	for _, rel := range []string{"usage_2020q1", "usage_201801"} {
		if relationExists(t, db, rel) {
			t.Fatalf("%s 应当已被回收（两条形态的行为必须相同 —— 标记不比「名字即身份」更宽）", rel)
		}
	}
	days := s1ret01LedgerDays(t, db, bjDate(t, "2018-01-01"), bjDate(t, "2020-03-31"))
	if want := "2018-01-10,2020-01-10,2020-02-10,2020-03-10"; strings.Join(days, ",") != want {
		t.Fatalf("永久账本的日期 = %v，want %s —— 两种形态的明细都应当被补进我们的账本"+
			"（这条断言把「接受」钉死；账本被污染是认账的代价，见报告 §3）", days, want)
	}
}
