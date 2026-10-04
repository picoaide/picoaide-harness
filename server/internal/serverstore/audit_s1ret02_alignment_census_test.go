package serverstore

// S1-RET-02（第二十八轮审计 P2）+ RENAME 残留 + S1-RET-03（状态面月份折算）的判据。
//
// 缺陷形态（原报告的逐字口径）：
//
//	① **异名 + 非整月对齐**的 attached 叶子（审计实测 `usage_2020h1`）三条入选路径
//	   全不命中，而 `scanUsageMonthTables` 在 `!candidateForRetention` 处直接
//	   `continue`（**零计数、零日志**）⇒ 关系与它的明细永远不回收，整轮读数却逐字是
//	   "什么都没发生"（`err=nil failures=0 skipped=0 unreclaimed=[]`）；
//	   另一半：孤儿循环的 `reclaimMonths → !ok` 同样是零计数 `continue`。
//	② RENAME 形态：我们自己 DETACH 下来的残留带身份标记（`COMMENT`），但扫描面的 SQL
//	   按**名字**（`relname LIKE 'usage\_%'`）过滤 ⇒ 运维把它改名之后，它在所有面上
//	   消失（金额安全 —— 预补账已提交；但磁盘永不回收、观测面零命中）。
//	③ `usage_retention_status.go` 的 `retentionMonthOfRelation` **只认名字**
//	   （六位月名 / 四位年名），异名宽分区的**真失败**折算不出月份 ⇒ 进不了
//	   `reclaim_blocked_*`（"保留策略停摆"这条**跨重启**的告警面），且"折算不出"
//	   与"没有受阻月"逐字同形（静默）。
//
// 三条修法的口径（都在任务书允许的二选一里选了**观测面**那一支，理由见报告 §2）：
//
//	口径②（不放宽动作面）：`candidateForRetention` **一字未改** —— 「边界错位 ⇒ 不入选」
//	是既定的设计判据（`TestAuditR25ReclaimCandidateAndMonthAttribution` 的候选表逐行
//	钉住）。改成"按对齐纳入"会引入一条未表征的搬行路径（没有名字锚点时
//	fold-adjacent 领不回相邻月的行），属于破坏性动作。所以本条修的是**观测面**：
//	每一条被认出的关系都要有落面（skip 面或 census 面），绝不静默 `continue`。
//	RENAME 形态则按**身份证据**（我们写的规范头）进扫描面 —— SQL 的前缀匹配比解析器
//	**宽**，身份仍由 `parseUsageRetentionOwnedComment` 唯一判定（fail-closed）。
//	②' `retentionMonthOfRelation` 收敛为"清理侧事实优先 → 名字兜底 → **显式未知**并计数"。
//
// 复跑：
//
//	cd server && GOCACHE=… GOMODCACHE=… GOFLAGS='-mod=mod -buildvcs=false' GOPROXY=off \
//	  PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/p5 \
//	  go test ./internal/serverstore/ -run 'TestAuditS1Ret02|TestAuditS1Ret03' -count=1 -v

import (
	"database/sql"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strconv"
	"strings"
	"testing"
)

// s1ret02InsertRow 往**任意关系**里直插一行明细（夹具专用）。
//
// 为什么不走生产写路径（`r24UsageAt`）：写路径的 `ensureUsagePartition` 只认可
// "边界恰好覆盖该月"的分区（R25-F27 的覆盖判据），撞上本文件的两类夹具形态
// （异名不对齐 / DEFAULT）会 fail-loud —— 那本身是既有的、与本条无关的判据。
// 本文件的夹具只关心"扫描面/清理面怎么看这条关系"，所以直接写 SQL。
func s1ret02InsertRow(t *testing.T, db *sql.DB, rel string, uid int64, model, at string, cost float64) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(rel)+
		` (user_id, model, created_at, prompt_tokens, completion_tokens, cache_prompt_tokens, cost)`+
		` VALUES (?, ?, ?::timestamptz, 100, 10, 0, ?)`, uid, model, at, cost); err != nil {
		t.Fatalf("往 %s 写明细: %v", rel, err)
	}
}

// s1ret02InsertRowInSchema 与 s1ret02InsertRow 同形，但把**模式**与关系名分别加引号
// （`quoteRelationIdent("a.b")` 会把整串当成一个标识符 ⇒ 42P01）。
func s1ret02InsertRowInSchema(t *testing.T, db *sql.DB, schema, rel string, uid int64, model, at string, cost float64) {
	t.Helper()
	if _, err := db.Exec(`INSERT INTO `+quoteRelationIdent(schema)+`.`+quoteRelationIdent(rel)+
		` (user_id, model, created_at, prompt_tokens, completion_tokens, cache_prompt_tokens, cost)`+
		` VALUES (?, ?, ?::timestamptz, 100, 10, 0, ?)`, uid, model, at, cost); err != nil {
		t.Fatalf("往 %s.%s 写明细: %v", schema, rel, err)
	}
}

// s1ret02Has 报告清单里有没有以 needle 开头/包含 needle 的条目（`rel(reason)` 形态）。
func s1ret02Has(list []string, needle string) bool {
	for _, s := range list {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}

// s1ret02Scan 扫描一次扫描面（判据直接读**扫描事实**，不经过清理轮的投影 ——
// "分类在哪一层发生"本身是被测对象）。
func s1ret02Scan(t *testing.T, db *sql.DB) usageMonthTables {
	t.Helper()
	tables, err := scanUsageMonthTables(db)
	if err != nil {
		t.Fatalf("扫描月关系: %v", err)
	}
	return tables
}

// s1ret02UnmanagedReason 返回扫描结果里某条关系的分类（不在面内返回空串）。
func s1ret02UnmanagedReason(tables usageMonthTables, rel string) string {
	for _, u := range tables.Unmanaged {
		if u.Rel == rel {
			return u.Reason
		}
	}
	return ""
}

// ---------------------------------------------------------------------------
// ① 异名 + 非整月对齐的 attached 叶子：从"静默漏收"变成"可观测且可处置"
// ---------------------------------------------------------------------------

// TestAuditS1Ret02MisalignedAttachedLeafIsCountedNotSilent 是 S1-RET-02 的主判据
// （审计实测形态 `usage_2020h1`：UTC 手写边界 + 三行明细）。
//
// 断言链（缺一条都不算闭合）：
//
//	候选面**不放宽**（这次是观测面修复）；
//	扫描面给出封闭取值的分类（不是 continue）；
//	月份事实由**声明边界**给出（状态面据此把它算进"该回收却没回收"的面）；
//	一轮之后：skipped_by_reason + unreclaimed 点名 + needs_manual_months（人工处置面）；
//	census 面与 skip 面**互斥**（同一件事不在两处计数）；
//	一行数据都不许动（关系/明细/账本）；
//	日志逐条（带封闭取值），修复前是零计数零日志。
func TestAuditS1Ret02MisalignedAttachedLeafIsCountedNotSilent(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-misaligned")
	r25RetentionOn(t, db, "1")

	const rel = "usage_2020h1"
	// 起止都落在北京月**中间**（UTC 自然月边界）⇒ 不对齐北京月界。
	r24WidePartition(t, db, rel, "2020-01-01 00:00:00+00", "2020-07-01 00:00:00+00")
	s1ret02InsertRow(t, db, rel, uid, "s1ret02-misaligned", "2020-02-10T00:00:00+08", 3)

	tables := s1ret02Scan(t, db)
	if _, ok := tables.Shapes[rel]; ok {
		t.Fatalf("%s 进了候选面 —— 本次是**观测面**修复，动作面必须一字不放宽"+
			"（「边界错位 ⇒ 不入选」由 TestAuditR25ReclaimCandidateAndMonthAttribution 逐行钉住）", rel)
	}
	if got := s1ret02UnmanagedReason(tables, rel); got != usageSkipMisalignedAttached {
		t.Fatalf("扫描面把 %s 归类成 %q，want %q（修复前是静默 continue）",
			rel, got, usageSkipMisalignedAttached)
	}
	if got := tables.Months[rel]; got != "202001" {
		t.Fatalf("%s 的月份事实 = %q，want 202001（边界优先；S1-RET-03 的收口）", rel, got)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("登记形态不得让整轮失败（它是「看得见」而不是「处理失败」）: %v\n%s", err, logs.String())
	}
	st := CurrentUsageRetentionStatus()
	if st.SkippedByReason[usageSkipMisalignedAttached] != 1 {
		t.Fatalf("skipped_by_reason[%s] = %d，want 1（实际 %v）", usageSkipMisalignedAttached,
			st.SkippedByReason[usageSkipMisalignedAttached], st.SkippedByReason)
	}
	if !s1ret02Has(st.Unreclaimed, rel+"("+usageSkipMisalignedAttached+")") {
		t.Fatalf("unreclaimed 必须点名 %s：%v", rel, st.Unreclaimed)
	}
	if !s1ret02Has(st.NeedsManualMonths, "202001("+usageSkipMisalignedAttached+")") {
		t.Fatalf("needs_manual_months 必须点名该月与该原因（人工处置面）：%v", st.NeedsManualMonths)
	}
	if st.UnmanagedCount != 0 || len(st.UnmanagedByReason) != 0 {
		t.Fatalf("misaligned-attached 属于 skip 面，不得重复进 census：count=%d reasons=%v",
			st.UnmanagedCount, st.UnmanagedByReason)
	}
	// 一行数据都不许动：这是"按设计不动它"的形态，改动就是金额事故。
	if !relationExists(t, db, rel) {
		t.Fatalf("%s 被回收了 —— 没有名字锚点时相邻月并入领不回那些行，服务端不得动它", rel)
	}
	if n := r25UsageRowsIn(t, db, rel); n != 1 {
		t.Fatalf("%s 的明细 = %d 行，want 1（不得搬走/删除）", rel, n)
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-06-30")); len(days) != 0 {
		t.Fatalf("账本里出现了这些行 %v —— 没有名字锚点的关系不得被补账（金额污染）", days)
	}
	if out := logs.String(); !strings.Contains(out, "reason="+usageSkipMisalignedAttached) {
		t.Fatalf("必须有逐条日志（修复前零计数零日志）：\n%s", out)
	}
}

// TestAuditS1Ret02UnreadableBoundLeafIsVisibleAndUnknownMonthIsCounted 覆盖第二个
// attached 叶子形态：**边界读不懂**（DEFAULT 分区）。它可能持有任意月份的明细，
// 所以既不能按名字也不能按边界判它 —— 但"永远不回收"必须看得见。
//
// 它同时是 S1-RET-03「找不到月份必须显式返回未知并计数」的判据：这条关系既没有
// 可读边界、名字也不是六位月/四位年 ⇒ 折算不出月份 ⇒ 必须进
// `reclaim_month_unknown`（修复前它与"没有受阻月"逐字同形）。
func TestAuditS1Ret02UnreadableBoundLeafIsVisibleAndUnknownMonthIsCounted(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-bound")
	r25RetentionOn(t, db, "1")

	const rel = "usage_aux_default"
	if _, err := db.Exec("CREATE TABLE " + quoteRelationIdent(rel) + " PARTITION OF usage DEFAULT"); err != nil {
		t.Fatalf("建 DEFAULT 分区: %v", err)
	}
	s1ret02InsertRow(t, db, rel, uid, "s1ret02-bound", "2020-02-10T00:00:00+08", 7)

	tables := s1ret02Scan(t, db)
	if got := s1ret02UnmanagedReason(tables, rel); got != usageSkipBoundUnreadable {
		t.Fatalf("%s 的归类 = %q，want %q（DEFAULT 边界读不懂 ⇒ 不动它，但要看得见）",
			rel, got, usageSkipBoundUnreadable)
	}
	if _, ok := tables.Months[rel]; ok {
		t.Fatalf("%s 不该有月份事实（边界读不懂、名字也不是月）—— 那正是「未知」面要显式计数的形态", rel)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("登记形态不得让整轮失败: %v\n%s", err, logs.String())
	}
	st := CurrentUsageRetentionStatus()
	if st.SkippedByReason[usageSkipBoundUnreadable] != 1 {
		t.Fatalf("skipped_by_reason[%s] = %d，want 1（实际 %v）", usageSkipBoundUnreadable,
			st.SkippedByReason[usageSkipBoundUnreadable], st.SkippedByReason)
	}
	if st.ReclaimMonthUnknown != 1 || !s1ret02Has(st.ReclaimMonthUnknownRelations, rel) {
		t.Fatalf("折算不出月份的未回收关系必须**显式**计数并点名：count=%d rels=%v（旧实现里"+
			"「折算不出月」与「没有受阻月」逐字同形）", st.ReclaimMonthUnknown, st.ReclaimMonthUnknownRelations)
	}
	if !strings.Contains(logs.String(), "no derivable") {
		t.Fatalf("「未知」必须同时有一行日志：\n%s", logs.String())
	}
	if !relationExists(t, db, rel) || r25UsageRowsIn(t, db, rel) != 1 {
		t.Fatalf("%s 不得被回收/搬行（它是读不懂边界的形态，判据不建立在对边界的猜测上）", rel)
	}
}

// TestAuditS1Ret02AliasNonLeafParentIsCensusNotNeedsManual 是**反向对照**：
// 多级布局 `usage → usage_<YYYY> → usage_<YYYYMM>` 的年份父表是**合法容器**
// （服务端不替管理员拆分区树，R7-A/R8-A-4）—— 它必须出现在 census 面，
// 但**不得**进 skipped_by_reason / needs_manual_months（那是"需人工处置"的面，
// 长期误报会把真正的洞淹掉）。
func TestAuditS1Ret02AliasNonLeafParentIsCensusNotNeedsManual(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	r24User(t, db, "s1ret02-alias")
	r25RetentionOn(t, db, "1")

	const rel = "usage_2099"
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(rel) + ` PARTITION OF usage ` +
		`FOR VALUES FROM ('2099-01-01 00:00:00+08') TO ('2100-01-01 00:00:00+08') PARTITION BY RANGE (created_at)`); err != nil {
		t.Fatalf("建年份中间父表: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE usage_209901 PARTITION OF ` + quoteRelationIdent(rel) +
		` FOR VALUES FROM ('2099-01-01 00:00:00+08') TO ('2099-02-01 00:00:00+08')`); err != nil {
		t.Fatalf("建子叶子: %v", err)
	}

	tables := s1ret02Scan(t, db)
	if got := s1ret02UnmanagedReason(tables, rel); got != usageUnmanagedAliasNonLeaf {
		t.Fatalf("%s 的归类 = %q，want %q", rel, got, usageUnmanagedAliasNonLeaf)
	}
	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("合法布局不得让整轮失败: %v\n%s", err, logs.String())
	}
	st := CurrentUsageRetentionStatus()
	if st.UnmanagedByReason[usageUnmanagedAliasNonLeaf] != 1 || !s1ret02Has(st.UnmanagedRelations, rel) {
		t.Fatalf("census 面必须点名合法容器：by_reason=%v rels=%v", st.UnmanagedByReason, st.UnmanagedRelations)
	}
	if st.SkippedByReason[usageUnmanagedAliasNonLeaf] != 0 {
		t.Fatalf("census 面不得进 skipped_by_reason（两处计数会分叉）：%v", st.SkippedByReason)
	}
	if s1ret02Has(st.NeedsManualMonths, rel) {
		t.Fatalf("合法容器不得进 needs_manual_months（长期误报会淹没真正的洞）：%v", st.NeedsManualMonths)
	}
	if !relationExists(t, db, rel) {
		t.Fatalf("%s 不得被回收（非叶子 ⇒ DROP 会连子关系一起删）", rel)
	}
}

// ---------------------------------------------------------------------------
// ② RENAME 出 `usage_%` 命名族的 DETACH 残留：按**身份证据**（我们写的标记）回枚举面
// ---------------------------------------------------------------------------

// TestAuditS1Ret02RenamedOwnedLeftoverIsReclaimed 是 RENAME 形态的**正向判据**。
//
// 夹具走 S1-RET-01 的真实链路造出"我们摘下来的残留"（宽分区 + 依赖视图逼出
// 「冻结已提交、结算段失败」⇒ 关系被 DETACH、标记已写入），然后由运维 `RENAME`
// 出命名族（`usage_2020q1` → `v_retired_2020q1`）—— 修复前这一步让它从**所有**
// 面上消失（SQL 按名字过滤；金额安全但磁盘永不回收）。
//
// 断言：撤掉依赖后**下一轮必须真的回收它**（`cleared_detached≥1` + 关系消失 +
// 账本三天齐 + 报表读数 3/4/5）。
func TestAuditS1Ret02RenamedOwnedLeftoverIsReclaimed(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret02-renamed"
	s1ret01QuarterFixture(t, db, username, "s1ret02_dep_renamed")

	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("第一轮应当 fail-loud（DROP 被依赖对象挡住），实际 err=nil")
	}
	s1ret01AssertFrozen(t, db) // 关系已 DETACH + 标记已写（身份证据在）

	// 运维动作：把它改名出命名族（这是本条要收口的形态）。
	const renamed = "v_retired_2020q1"
	if _, err := db.Exec(`ALTER TABLE usage_2020q1 RENAME TO ` + renamed); err != nil {
		t.Fatalf("改名: %v", err)
	}
	// 前提自检：名字已经**不**匹配扫描面的名字族（否则这条用例测不到 RENAME 路径）。
	if strings.HasPrefix(renamed, "usage_") {
		t.Fatalf("夹具前提不成立：改名后的名字仍在 usage_ 族里")
	}
	tables := s1ret02Scan(t, db)
	shape, ok := tables.Shapes[renamed]
	if !ok {
		t.Fatalf("改名后的残留没有回到扫描面（SQL 必须按**我们的标记前缀**并集进来）："+
			"shapes=%v unmanaged=%v", keysOfShape(tables.Shapes), tables.Unmanaged)
	}
	if !shape.OwnedDetach {
		t.Fatalf("%s 的 OwnedDetach=false —— 身份判据必须是解析器（fail-closed），不是名字", renamed)
	}

	if _, err := db.Exec(`DROP VIEW s1ret02_dep_renamed`); err != nil {
		t.Fatalf("撤掉依赖视图: %v", err)
	}
	err := CleanupUsageRetention(db)
	st := CurrentUsageRetentionStatus()
	if err != nil {
		t.Fatalf("依赖对象已撤掉，第二轮应当把改名后的残留回收掉，实际 err=%v（failures=%d failed_rels=%v）",
			err, st.Failures, st.FailedRelations)
	}
	if st.ClearedDetached < 1 {
		t.Fatalf("第二轮没有回收任何 DETACH 残留（cleared_detached=%d）—— 改名后的残留仍不在枚举面里",
			st.ClearedDetached)
	}
	if relationExists(t, db, renamed) {
		t.Fatalf("%s 应当已被回收（账本已补齐、相邻月已并入）", renamed)
	}
	s1ret01AssertQuarterMoneyVisible(t, db, username, "改名后回收")
}

// TestAuditS1Ret02RenamedWithoutMarkerIsNotOurs 是 RENAME 形态的**反向对照**：
// 名字与标记两条准入都不命中的关系**不得**被当我们的残留（不许 DROP、不许补账）。
func TestAuditS1Ret02RenamedWithoutMarkerIsNotOurs(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-foreign")
	r25RetentionOn(t, db, "1")

	// 别人手工建的独立表（列形状与 usage 完全一致）+ 名字在**两条准入之外**。
	const rel = "v_foreign_2020q1"
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(rel) + ` (LIKE usage INCLUDING DEFAULTS)`); err != nil {
		t.Fatalf("建外部表: %v", err)
	}
	s1ret02InsertRow(t, db, rel, uid, "s1ret02-foreign", "2020-02-10T00:00:00+08", 3)

	tables := s1ret02Scan(t, db)
	if _, ok := tables.Shapes[rel]; ok {
		t.Fatalf("%s 进了候选面 —— 两条准入（名字族 / 我们的标记）都不命中，不得当我们的残留", rel)
	}
	var problems []string
	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			problems = append(problems, "第 "+strconv.Itoa(round)+" 轮报错: "+err.Error())
		}
	}
	if !relationExists(t, db, rel) {
		problems = append(problems, rel+" 被 DROP 了 —— 它不是我们的残留")
	} else if n := r25UsageRowsIn(t, db, rel); n != 1 {
		problems = append(problems, rel+" 的明细 = "+strconv.FormatInt(n, 10)+" 行，want 1")
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-06-30")); len(days) != 0 {
		problems = append(problems, "永久账本里出现了这些行 "+strings.Join(days, ",")+" —— 别人的明细被补进了我们的账本")
	}
	if len(problems) > 0 {
		t.Fatalf("两条准入之外的关系被动过了：\n - %s", strings.Join(problems, "\n - "))
	}
}

// TestAuditS1Ret02CorruptedMarkerIsVisibleButNotClaimed 覆盖 fail-closed 的另一半：
// 注释**以我们的规范头开头**、却读不懂（版本号不是 v1）⇒ 解析器不认（不当我们的
// 残留去 DROP），但它在扫描面里**看得见**（census 的 marker-unparsed）。
//
// 这一条同时钉住"SQL 的前缀预筛比解析器宽"这条设计：若有人把 SQL 的预筛收紧成
// "整串相等"，本用例的 marker-unparsed 会消失（静默 —— 正是 S1-RET-R 修掉的 P2 形态）。
func TestAuditS1Ret02CorruptedMarkerIsVisibleButNotClaimed(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-corrupt")
	r25RetentionOn(t, db, "1")

	const rel = "v_retired_2020q1"
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(rel) + ` (LIKE usage INCLUDING DEFAULTS)`); err != nil {
		t.Fatalf("建表: %v", err)
	}
	s1ret02InsertRow(t, db, rel, uid, "s1ret02-corrupt", "2020-02-10T00:00:00+08", 3)
	// 规范头 + 不认识的版本号 ⇒ parseUsageRetentionOwnedComment 不认（fail-closed）。
	corrupted := usageRetentionOwnedCommentPrefix + " v2 from=2020-01-01 to=2020-03-31"
	if _, err := db.Exec(`COMMENT ON TABLE ` + quoteRelationIdent(rel) + ` IS '` + corrupted + `'`); err != nil {
		t.Fatalf("写注释: %v", err)
	}

	tables := s1ret02Scan(t, db)
	if _, ok := tables.Shapes[rel]; ok {
		t.Fatalf("%s 进了候选面 —— 读不懂的标记必须按 fail-closed 处理（不认作我们的残留）", rel)
	}
	if got := s1ret02UnmanagedReason(tables, rel); got != usageUnmanagedMarkerUnparsed {
		t.Fatalf("%s 的归类 = %q，want %q（读不懂的标记必须**看得见**）",
			rel, got, usageUnmanagedMarkerUnparsed)
	}
	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮报错（读不懂的标记不属于我们，一行都不该动）: %v", round, err)
		}
	}
	st := CurrentUsageRetentionStatus()
	if st.UnmanagedByReason[usageUnmanagedMarkerUnparsed] != 1 {
		t.Fatalf("census 面必须点名 marker-unparsed：%v", st.UnmanagedByReason)
	}
	if !relationExists(t, db, rel) || r25UsageRowsIn(t, db, rel) != 1 {
		t.Fatalf("%s 不得被回收/搬行（标记读不懂 ⇒ fail-closed 不动它）", rel)
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-06-30")); len(days) != 0 {
		t.Fatalf("账本里出现了这些行 %v —— 读不懂标记的关系不得被补账", days)
	}
}

// ---------------------------------------------------------------------------
// ③ 状态面的月份折算：宽分区的真失败必须进"跨重启的停摆面"
// ---------------------------------------------------------------------------

// TestAuditS1Ret03WidePartitionFailureEntersBlockedFace 是 S1-RET-03 的主判据。
//
// 现场（审计实测）：同一注入下**异名宽分区**真失败时 `reclaim_stalled=false /
// blocked_month=""`，而**规范月名**同样真失败 ⇒ `stalled=true / blocked_month=202001`。
// 根因是状态面的月份折算只认名字（六位月名 / 四位年名），`usage_2020q1` 两者都不匹配。
//
// 修复后：折算复用清理侧的事实（声明边界 → 标记 → 名字），所以宽分区的失败**进**
// `reclaim_blocked_*`，而它的逾期时长是保留期的纯函数 ⇒ `reclaim_stalled` 在**重启后
// 第一轮**就成立（这正是 R11-D-03 要的跨重启性质）。
func TestAuditS1Ret03WidePartitionFailureEntersBlockedFace(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	const username = "s1ret03-wide-blocked"
	// 整月对齐的异名季度分区 + 依赖视图 ⇒ 结算段的 DROP 必然被挡（真失败）。
	s1ret01QuarterFixture(t, db, username, "s1ret03_dep")

	if err := CleanupUsageRetention(db); err == nil {
		t.Fatalf("DROP 被依赖对象挡住时必须 fail-loud，实际 err=nil")
	}
	st := CurrentUsageRetentionStatus()
	if !s1ret02Has(st.FailedRelations, "usage_2020q1") {
		t.Fatalf("失败面必须点名 usage_2020q1：%v", st.FailedRelations)
	}
	if !s1ret02Has(st.ReclaimBlockedMonths, "202001") {
		t.Fatalf("宽分区的真失败必须进跨重启的停摆面（reclaim_blocked_months 含 202001）：%v"+
			"（修复前这里恒为空 —— 折算只认六位月名）", st.ReclaimBlockedMonths)
	}
	if st.ReclaimBlockedMonth != "202001" || st.ReclaimBlockedReason != usageReclaimBlockedFailed {
		t.Fatalf("reclaim_blocked_month/reason = %q/%q，want 202001/%s",
			st.ReclaimBlockedMonth, st.ReclaimBlockedReason, usageReclaimBlockedFailed)
	}
	if !st.ReclaimStalled {
		t.Fatalf("该月已逾期远超 24h（保留期纯函数）⇒ reclaim_stalled 必须在**第一轮**就成立"+
			"（age=%ds）", st.ReclaimBlockedAgeSeconds)
	}
	if st.ReclaimMonthUnknown != 0 {
		t.Fatalf("这条关系的月份是可推导的，不该落进「未知」面：%v", st.ReclaimMonthUnknownRelations)
	}
	// 反向对照：规范月名（同一注入）也必须照旧进面 —— 修复不许把存量口径弄坏。
	if !s1ret02Has(st.Unreclaimed, "usage_2020q1") && !s1ret02Has(st.FailedRelations, "usage_2020q1") {
		t.Fatalf("宽分区必须在未回收/失败面上可见：unreclaimed=%v failed=%v", st.Unreclaimed, st.FailedRelations)
	}
}

// ---------------------------------------------------------------------------
// ③' 核验后收口（V-P5 §1-S1/S2）：两条**实跑**静默路径 —— 身份证据在、但结构上
//     不在动作面。口径：fail-closed（不动作）+ **必须出声**（census 计数 + 日志 +
//     /readyz 载荷），两条各配一条判据与一条回退变异。
// ---------------------------------------------------------------------------

// s1ret02RowsInSchema 统计 `<schema>.<rel>` 的行数（不依赖 search_path）。
func s1ret02RowsInSchema(t *testing.T, db *sql.DB, schema, rel string) int64 {
	t.Helper()
	var n int64
	if err := db.QueryRow("SELECT count(*) FROM " + quoteRelationIdent(schema) + "." + quoteRelationIdent(rel)).Scan(&n); err != nil {
		t.Fatalf("统计 %s.%s 行数: %v", schema, rel, err)
	}
	return n
}

// s1ret02RelationExistsInSchema 报告 `<schema>.<rel>` 是否存在（不依赖 search_path）。
func s1ret02RelationExistsInSchema(t *testing.T, db *sql.DB, schema, rel string) bool {
	t.Helper()
	var exists bool
	if err := db.QueryRow(`SELECT to_regclass(?) IS NOT NULL`,
		schema+"."+quoteRelationIdent(rel)).Scan(&exists); err != nil {
		t.Fatalf("查 %s.%s 存在性: %v", schema, rel, err)
	}
	return exists
}

// s1ret02MarkedLeafFixture 造一条"我们自己摘下来的残留"终态（普通叶子表 + 规范标记 + 一行明细）。
//
// 直接写 DDL 而不是走 DETACH 链路：本用例要的是**终态**（标记在、名字/模式可能被运维改过），
// 走链路会引入与本条无关的前置状态（S1-RET-01 的冻结/结算已由它自己的用例覆盖）。
func s1ret02MarkedLeafFixture(t *testing.T, db *sql.DB, rel string, uid int64, at string, cost float64) {
	t.Helper()
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(rel) + ` (LIKE usage INCLUDING DEFAULTS)`); err != nil {
		t.Fatalf("建表 %s: %v", rel, err)
	}
	s1ret02InsertRow(t, db, rel, uid, "s1ret02-owned", at, cost)
	mark := usageRetentionOwnedComment(bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31"))
	if _, err := db.Exec(`COMMENT ON TABLE ` + quoteRelationIdent(rel) + ` IS '` + mark + `'`); err != nil {
		t.Fatalf("写标记 %s: %v", rel, err)
	}
}

// TestAuditS1Ret02MarkerOutsidePublicIsVisibleNotActioned 是核验方 §1-S1 的判据：
// **带我们标记的残留被 `SET SCHEMA` 搬出 public** 之后，扫描面原来硬钉
// `n.nspname = 'public'` ⇒ 四条读数面零命中、日志一个字都没有（核验方实跑）。
//
// 现在的口径：**身份证据成立 ⇒ 必须看得见；结构上不在动作面 ⇒ 绝不动作**（fail-closed）。
// 动作面为什么必须退出：整条 DDL/补账/搬行链路都按 `public.` 解析
// （`quoteRelationIdent`、`probeUsagePartition` 的 `to_regclass('public.usage')`、
// `foldAdjacentMonthsIntoUsage` 的落点），把别的模式里的关系放进候选面等于让
// DROP/搬行落到 search_path 解析出来的**另一个同名对象**上。
//
// 夹具里同时放一条**同形态但留在 public** 的对照（它必须被真回收）——
// 这样"差异来自模式过滤"这件事本身有判据，而不是靠断言"两条都不动"（那是假绿）。
func TestAuditS1Ret02MarkerOutsidePublicIsVisibleNotActioned(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-schema")
	r25RetentionOn(t, db, "1")

	const (
		pubRel  = "v_retired_pub_2020"
		moveRel = "v_retired_moved_2020"
		schema  = "p5_elsewhere"
	)
	// 对照与被测用**不同日期**：账本里只许出现对照那一天（证明被测那条一行都没进账本）。
	s1ret02MarkedLeafFixture(t, db, pubRel, uid, "2020-01-10T00:00:00+08", 3)
	s1ret02MarkedLeafFixture(t, db, moveRel, uid, "2020-02-10T00:00:00+08", 7)

	tables := s1ret02Scan(t, db)
	// 搬走**之前**：两条都在 public、都带标记 ⇒ 都是候选（夹具前提）。
	for _, rel := range []string{pubRel, moveRel} {
		if _, ok := tables.Shapes[rel]; !ok {
			t.Fatalf("夹具前提不成立：%s 在 public 里、带标记，应当是候选", rel)
		}
	}

	if _, err := db.Exec(`CREATE SCHEMA ` + quoteRelationIdent(schema)); err != nil {
		t.Fatalf("建模式: %v", err)
	}
	if _, err := db.Exec(`ALTER TABLE ` + quoteRelationIdent(moveRel) + ` SET SCHEMA ` + quoteRelationIdent(schema)); err != nil {
		t.Fatalf("搬模式: %v", err)
	}
	display := schema + "." + moveRel
	tables = s1ret02Scan(t, db)
	if _, ok := tables.Shapes[moveRel]; ok {
		t.Fatalf("%s 搬走之后仍进候选面 —— 跨模式的关系不得进动作面"+
			"（DDL/搬行会落到 search_path 解析出来的同名对象上）", moveRel)
	}
	if got := s1ret02UnmanagedReason(tables, display); got != usageUnmanagedMarkerOutsidePublic {
		t.Fatalf("%s 的归类 = %q，want %q（身份证据在 ⇒ 必须看得见；核验方实测修复前是零命中）",
			display, got, usageUnmanagedMarkerOutsidePublic)
	}

	logs := captureRetentionLog(t)
	if err := CleanupUsageRetention(db); err != nil {
		t.Fatalf("跨模式残留不得让整轮失败（它只是「看得见但不动」）: %v\n%s", err, logs.String())
	}
	st := CurrentUsageRetentionStatus()
	if st.UnmanagedByReason[usageUnmanagedMarkerOutsidePublic] != 1 {
		t.Fatalf("census 面必须按封闭取值点名 %s：%v", usageUnmanagedMarkerOutsidePublic, st.UnmanagedByReason)
	}
	if !s1ret02Has(st.UnmanagedRelations, display) {
		t.Fatalf("census 抽样必须点名**模式.关系**（裸名字会与 public 同名关系歧义）：%v", st.UnmanagedRelations)
	}
	if !strings.Contains(logs.String(), "reason="+usageUnmanagedMarkerOutsidePublic) {
		t.Fatalf("必须有逐条日志（修复前日志里一个字都没有）：\n%s", logs.String())
	}
	// 对照：public 的那条被**真回收**（证明差异来自模式过滤，而不是"标记根本没用"）。
	if relationExists(t, db, pubRel) {
		t.Fatalf("对照 %s 应当已被回收（终态残留 + 标记 + 已到期窗口）", pubRel)
	}
	if st.ClearedDetached < 1 {
		t.Fatalf("对照没有被回收（cleared_detached=%d）—— 夹具前提不成立", st.ClearedDetached)
	}
	// 被测：一行未动、一分钱未进账本。
	if !s1ret02RelationExistsInSchema(t, db, schema, moveRel) {
		t.Fatalf("%s 被动了 —— 跨模式关系必须 fail-closed（不动作）", display)
	}
	if n := s1ret02RowsInSchema(t, db, schema, moveRel); n != 1 {
		t.Fatalf("%s 的明细 = %d 行，want 1", display, n)
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31")); strings.Join(days, ",") != "2020-01-10" {
		t.Fatalf("账本里应当只有对照那一天（2020-01-10），实得 %v —— 跨模式残留被补账了就是金额污染", days)
	}
}

// TestAuditS1Ret02OutsidePublicLookalikeStaysMarkerUnparsed 是核验方 V-P12 §P3-4 的判据：
// 分类顺序必须"**身份成不成立**先于模式/账本族判定"。
//
// 缺陷形态（核验方实测）：`case !inPublic` 排在 `case markerPrefixed && !s.OwnedDetach`
// 之前时，**跨模式下"前缀命中但解析器不认"**的第三方注释被归成 `marker-outside-public`
// —— 而那个取值的语义是"带我们**可解析的**标记、身份成立、只是不在动作面"，
// `marker-unparsed` 因此在跨模式下**不可达**（Detail 文案与事实相反）。
//
// 判据：跨模式 + 前缀命中 + 解析器不认 ⇒ 必须 `marker-unparsed`，**不得** `marker-outside-public`；
// 反向对照由 TestAuditS1Ret02MarkerOutsidePublicIsVisibleNotActioned 承担（真的带可解析标记
// 的跨模式残留仍归 `marker-outside-public`）——两条一起把顺序钉死（只钉一条的话，
// "一律归 marker-unparsed"这种过度收紧会静默通过）。
func TestAuditS1Ret02OutsidePublicLookalikeStaysMarkerUnparsed(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-lookalike")
	r25RetentionOn(t, db, "1")

	const (
		schema = "p5_lookalike_ns"
		rel    = "vp5_lookalike_q1"
	)
	if _, err := db.Exec(`CREATE SCHEMA ` + quoteRelationIdent(schema)); err != nil {
		t.Fatalf("建模式: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(schema) + `.` + quoteRelationIdent(rel) +
		` (LIKE usage INCLUDING DEFAULTS)`); err != nil {
		t.Fatalf("建表: %v", err)
	}
	s1ret02InsertRowInSchema(t, db, schema, rel, uid, "s1ret02-lookalike", "2020-02-10T00:00:00+08", 5)
	// 前缀命中（SQL 预筛会捞它）、解析器**不认**（字段名不是 from=/to=）。
	lookalike := usageRetentionOwnedCommentPrefix + "-by-thirdparty v1 from=2020-01-01 to=2020-03-31"
	if _, err := db.Exec(`COMMENT ON TABLE ` + quoteRelationIdent(schema) + `.` + quoteRelationIdent(rel) +
		` IS '` + lookalike + `'`); err != nil {
		t.Fatalf("写注释: %v", err)
	}
	// 自校准：如果这个注释其实**能**被解析器认，判据就测错了形态（夹具前提 fail-loud）。
	if _, _, ok := parseUsageRetentionOwnedComment(lookalike); ok {
		t.Fatalf("夹具前提不成立：伪造注释居然被解析器认了（%q）", lookalike)
	}

	display := schema + "." + rel
	tables := s1ret02Scan(t, db)
	if _, ok := tables.Shapes[rel]; ok {
		t.Fatalf("%s 进了候选面 —— 解析器不认的注释不得当我们的残留", display)
	}
	got := s1ret02UnmanagedReason(tables, display)
	if got != usageUnmanagedMarkerUnparsed {
		t.Fatalf("%s 的归类 = %q，want %q —— 身份成不成立必须先于模式/账本族判定"+
			"（把 `case !inPublic` 排到前面会让它在跨模式下不可达，核验方 V-P12 §P3-4 实测）",
			display, got, usageUnmanagedMarkerUnparsed)
	}

	logs := captureRetentionLog(t)
	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮报错（读不懂的注释不属于我们，一行都不该动）: %v\n%s", round, err, logs.String())
		}
	}
	st := CurrentUsageRetentionStatus()
	if st.UnmanagedByReason[usageUnmanagedMarkerUnparsed] != 1 {
		t.Fatalf("census 面必须按 %s 点名：%v", usageUnmanagedMarkerUnparsed, st.UnmanagedByReason)
	}
	if st.UnmanagedByReason[usageUnmanagedMarkerOutsidePublic] != 0 {
		t.Fatalf("身份不成立的形态不得被归成 %s（那会把「这是我们的残留」写进读面）：%v",
			usageUnmanagedMarkerOutsidePublic, st.UnmanagedByReason)
	}
	if !s1ret02RelationExistsInSchema(t, db, schema, rel) || s1ret02RowsInSchema(t, db, schema, rel) != 1 {
		t.Fatalf("%s 不得被回收/搬行（fail-closed）", display)
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-03-31")); len(days) != 0 {
		t.Fatalf("账本里出现了这些行 %v —— 读不懂的注释不得被补账", days)
	}
}

// TestAuditS1Ret02LedgerNamedOwnedLeftoverIsVisibleNotActioned 是核验方 §1-S2 的判据：
// **带我们标记的残留被改名成 `usage_daily_*`** 之后，扫描循环原来先按账本族规则
// `continue`（标记判定在它之后）⇒ 同样静默。
//
// 口径：账本族没有回收路径（既有裁决）⇒ **绝不动作**；但带我们标记的必须出声。
// 反向对照：**同样名字、没有标记**的关系是正常的永久账本 ⇒ 照旧静默（不该进 census）。
func TestAuditS1Ret02LedgerNamedOwnedLeftoverIsVisibleNotActioned(t *testing.T) {
	resetUsageRetentionStatusForTest()
	defer resetUsageRetentionStatusForTest()
	db, cleanup := newTestDB(t)
	defer cleanup()
	uid := r24User(t, db, "s1ret02-ledger")
	r25RetentionOn(t, db, "1")

	const (
		ownedRel = "usage_daily_2999" // 带我们的标记 ⇒ 出声
		plainRel = "usage_daily_2998" // 无标记 ⇒ 正常永久账本 ⇒ 静默
	)
	s1ret02MarkedLeafFixture(t, db, ownedRel, uid, "2020-02-10T00:00:00+08", 7)
	if _, err := db.Exec(`CREATE TABLE ` + quoteRelationIdent(plainRel) + ` (LIKE usage INCLUDING DEFAULTS)`); err != nil {
		t.Fatalf("建对照表: %v", err)
	}

	tables := s1ret02Scan(t, db)
	for _, rel := range []string{ownedRel, plainRel} {
		if _, ok := tables.Shapes[rel]; ok {
			t.Fatalf("%s 进了候选面 —— 账本族没有回收路径，不得进动作面", rel)
		}
	}
	if got := s1ret02UnmanagedReason(tables, ownedRel); got != usageUnmanagedLedgerNamedOwned {
		t.Fatalf("%s 的归类 = %q，want %q（带标记 ⇒ 必须看得见）", ownedRel, got, usageUnmanagedLedgerNamedOwned)
	}
	if got := s1ret02UnmanagedReason(tables, plainRel); got != "" {
		t.Fatalf("无标记的账本族关系 %s 不该进 census（它是正常的永久账本）：%q", plainRel, got)
	}

	logs := captureRetentionLog(t)
	for round := 1; round <= 2; round++ {
		if err := CleanupUsageRetention(db); err != nil {
			t.Fatalf("第 %d 轮报错（账本族关系不得让整轮失败）: %v\n%s", round, err, logs.String())
		}
	}
	st := CurrentUsageRetentionStatus()
	if st.UnmanagedByReason[usageUnmanagedLedgerNamedOwned] != 1 {
		t.Fatalf("census 面必须按封闭取值点名 %s：%v", usageUnmanagedLedgerNamedOwned, st.UnmanagedByReason)
	}
	if !s1ret02Has(st.UnmanagedRelations, ownedRel) {
		t.Fatalf("census 抽样必须点名 %s：%v", ownedRel, st.UnmanagedRelations)
	}
	if s1ret02Has(st.UnmanagedRelations, plainRel) {
		t.Fatalf("无标记的账本族关系不得进 census：%v", st.UnmanagedRelations)
	}
	if !strings.Contains(logs.String(), "reason="+usageUnmanagedLedgerNamedOwned) {
		t.Fatalf("必须有逐条日志（修复前日志里一个字都没有）：\n%s", logs.String())
	}
	if !relationExists(t, db, ownedRel) || r25UsageRowsIn(t, db, ownedRel) != 1 {
		t.Fatalf("%s 一行都不许动（账本族没有回收路径）", ownedRel)
	}
	if !relationExists(t, db, plainRel) {
		t.Fatalf("对照 %s 被动了", plainRel)
	}
	if days := s1ret01LedgerDays(t, db, bjDate(t, "2020-01-01"), bjDate(t, "2020-12-31")); len(days) != 0 {
		t.Fatalf("账本里出现了这些行 %v —— 账本族关系不得被补账", days)
	}
}

// ---------------------------------------------------------------------------
// ④ 分类表（单元面）：封闭取值 → 落面 的映射，以及两个面判据的一致性
// ---------------------------------------------------------------------------

// TestAuditS1Ret02UnmanagedReasonTable 把"形态 → 封闭取值 → 落面"钉成一张表。
//
// 变异对照：
//   - 把 `usageUnmanagedReason` 的某一支改回"一律 unmarked-orphan" ⇒ 对应行红；
//   - 把 `usageUnmanagedReasonIsSkipFace` 与 `usageSkipNeedsManual` 的集合改得不一致
//     ⇒ 一致性断言红（两处各判一遍就会分叉：计数在一个面、点名在另一个面）。
func TestAuditS1Ret02UnmanagedReasonTable(t *testing.T) {
	const (
		alignedYear = "FOR VALUES FROM ('2020-01-01 00:00:00+08') TO ('2021-01-01 00:00:00+08')"
		utcQuarter  = "FOR VALUES FROM ('2020-01-01 00:00:00+00') TO ('2020-04-01 00:00:00+00')"
	)
	attachedLeaf := func(bound string) usageRelationShape {
		return usageRelationShape{Kind: "r", Partition: true, AttachedUsage: true, DirectParentUsage: true, Bound: bound}
	}
	cases := []struct {
		name           string
		rel            string
		shape          usageRelationShape
		markerPrefixed bool
		inPublic       bool
		want           string
	}{
		{"异名 + 对齐（候选面，不该走到分类）", "usage_2020q1", attachedLeaf(alignedYear), false, true, ""},
		{"异名 + 不对齐的 attached 叶子 ⇒ skip 面", "usage_2020h1", attachedLeaf(utcQuarter), false, true, usageSkipMisalignedAttached},
		{"异名 + 边界读不懂的 attached 叶子 ⇒ skip 面", "usage_aux", attachedLeaf("DEFAULT"), false, true, usageSkipBoundUnreadable},
		{"非叶子的异名父表（多级布局容器）⇒ census", "usage_2099",
			usageRelationShape{Kind: "p", Children: 2, Partition: true, AttachedUsage: true, Bound: alignedYear}, false, true, usageUnmanagedAliasNonLeaf},
		{"名字族里的非后代、无标记 ⇒ census", "usage_2020q1", usageRelationShape{Kind: "r"}, false, true, usageUnmanagedUnmarkedOrphan},
		{"带标记但解析器不认 ⇒ census（fail-closed）", "v_x", usageRelationShape{Kind: "r", OwnedDetach: false}, true, true, usageUnmanagedMarkerUnparsed},
		{"带我们的标记 + 别人的活分区 ⇒ census", "v_x", usageRelationShape{Kind: "r", Partition: true, OwnedDetach: true}, true, true, usageUnmanagedMarkerLivePartition},
		{"带我们的标记 + 非叶子 ⇒ census", "v_x", usageRelationShape{Kind: "p", Children: 1, OwnedDetach: true}, true, true, usageUnmanagedMarkerNonLeaf},
		// 核验后收口（V-P5 §1-S1/S2）：两条实跑静默路径。
		{"带我们的标记 + **不在 public 模式** ⇒ census（不动作，但出声）", "elsewhere.usage_2020q1",
			usageRelationShape{Kind: "r", OwnedDetach: true}, true, false, usageUnmanagedMarkerOutsidePublic},
		{"带我们的标记 + 名字落进**永久账本族** ⇒ census", "usage_daily_2999",
			usageRelationShape{Kind: "r", OwnedDetach: true}, true, true, usageUnmanagedLedgerNamedOwned},
	}
	for _, tc := range cases {
		ledgerNamed := usageLedgerRelation(tc.rel)
		if tc.want == "" {
			// 候选面那一行：分类函数**不该**被调用（这里只钉住"它是候选"这件事的
			// 另一半在 TestAuditR25ReclaimCandidateAndMonthAttribution）。
			if !tc.shape.candidateForRetention(tc.rel) {
				t.Errorf("[%s] 夹具前提不成立：%s 应当是候选", tc.name, tc.rel)
			}
			continue
		}
		// 夹具前提：非 public 的行必须真的不在名字族（否则它走的是名字准入而不是标记准入）；
		// 账本族那一行必须真的被 usageLedgerRelation 判为账本名。
		if !tc.inPublic && strings.HasPrefix(tc.rel, "usage_") {
			t.Errorf("[%s] 夹具前提不成立：非 public 的行不该用 public 名字族的名字 %q", tc.name, tc.rel)
		}
		if strings.Contains(tc.name, "永久账本族") && !ledgerNamed {
			t.Errorf("[%s] 夹具前提不成立：%q 不是账本族名字", tc.name, tc.rel)
		}
		if got := tc.shape.usageUnmanagedReason(tc.rel, tc.markerPrefixed, tc.inPublic, ledgerNamed); got != tc.want {
			t.Errorf("[%s] rel=%s：got %q want %q", tc.name, tc.rel, got, tc.want)
		}
	}
	// 一致性：落面判据（usageUnmanagedReasonIsSkipFace）与 skip 面的分类判据
	// （usageSkipNeedsManual）对**本面的九个取值**必须逐值一致 —— 否则
	// "计数在一个面、点名在另一个面"。
	reasons := []string{
		usageSkipMisalignedAttached, usageSkipBoundUnreadable, usageSkipUnclassifiedOrphan,
		usageUnmanagedUnmarkedOrphan, usageUnmanagedAliasNonLeaf, usageUnmanagedMarkerUnparsed,
		usageUnmanagedMarkerLivePartition, usageUnmanagedMarkerNonLeaf,
		usageUnmanagedMarkerOutsidePublic, usageUnmanagedLedgerNamedOwned,
	}
	for _, r := range reasons {
		if usageUnmanagedReasonIsSkipFace(r) != usageSkipNeedsManual(r) {
			t.Errorf("取值 %q 的落面判据与 skip 分类判据不一致：isSkipFace=%v needsManual=%v",
				r, usageUnmanagedReasonIsSkipFace(r), usageSkipNeedsManual(r))
		}
		if usageSkipIsDeferral(r) {
			t.Errorf("取值 %q 不得被算成「本轮有界延后」（那会把它喂进停摆位的另一条路）", r)
		}
	}
}

// keysOfShape 是诊断输出用：形态表的键（仅用于报错信息）。
func keysOfShape(m map[string]usageRelationShape) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// ---------------------------------------------------------------------------
// ⑤ 结构面：孤儿循环的 `!ok` 分支不得静默（防御性分支 + 量具自校准）
// ---------------------------------------------------------------------------

// TestAuditS1Ret02ReclaimLoopsHaveNoSilentContinue 钉住"**两个**回收循环的
// `reclaimMonths → !ok` 分支都不得静默 continue"这条不变量。
//
// 为什么只能用**结构级**判据：候选判据（candidateForRetention）已经蕴含"归属可推导"，
// 所以这两支在当前结构下**不可达** —— 没有任何夹具能在不破坏候选判据的前提下走到那里。
// 不可达的防御性分支拿不到行为级判据，于是照 S1-RET-R 的 VM2 结构判据同形做：
// AST 锚点（`for … range tables.Orphans` / `for … range attached` 里的 `if !ok { … }`）
// + **量具自校准**（喂三种合成形态：静默版 / 只给孤儿桶设哨兵版 / 两个都有版）——
// 找不到锚点时判据自己变红，而不是静默变成"零命中 ✅"。
//
// 为什么必须**两个循环都查**（核验后收口 §2）：核验方用变异实证，同一次
// `reclaimMonths → !ok` 变异下孤儿桶有落面、attached 桶零落面 —— 只给一个循环设哨兵
// 等于把同一条不变量拆成"一半有牙、一半没有"。
func TestAuditS1Ret02ReclaimLoopsHaveNoSilentContinue(t *testing.T) {
	src, err := os.ReadFile("usage_ledger.go")
	if err != nil {
		t.Fatalf("读 usage_ledger.go: %v", err)
	}
	if probs := s1ret02ReclaimLoopShapeProblems(string(src)); len(probs) > 0 {
		t.Errorf("两个回收循环的 !ok 分支都必须 noteSkip 点名（不得静默 continue）：\n - %s",
			strings.Join(probs, "\n - "))
	}
	// 量具自校准（三种合成形态）。判据驱动坏掉时这几条会先红。
	form := func(orphan, attachedSentinel bool) string {
		body := func(sentinel bool) string {
			if !sentinel {
				return "\t\t\tcontinue\n"
			}
			return "\t\t\tnoteSkip(\"x\", rel, usageSkipUnclassifiedOrphan, \"…\")\n\t\t\tcontinue\n"
		}
		return `package serverstore

func CleanupUsageRetention(db *sql.DB) (err error) {
	for _, rel := range tables.Orphans {
		first, last, ok := shape.reclaimMonths(rel)
		if !ok {
` + body(orphan) + `		}
		_, _ = first, last
	}
	for _, rel := range attached {
		first, last, ok := shape.reclaimMonths(rel)
		if !ok {
` + body(attachedSentinel) + `		}
		_, _ = first, last
	}
	return nil
}
`
	}
	if probs := s1ret02ReclaimLoopShapeProblems(form(false, false)); len(probs) != 2 {
		t.Errorf("量具自校准失败：两个循环都静默的合成形态应当报 2 条问题，实得 %v", probs)
	}
	if probs := s1ret02ReclaimLoopShapeProblems(form(true, false)); len(probs) != 1 {
		t.Errorf("量具自校准失败：只给孤儿桶设哨兵的合成形态应当报 1 条问题（attached 桶），实得 %v", probs)
	}
	if probs := s1ret02ReclaimLoopShapeProblems(form(true, true)); len(probs) > 0 {
		t.Errorf("量具自校准失败：两个循环都有哨兵的合成形态被判红：%v", probs)
	}
}

// s1ret02ReclaimLoopShapeProblems 检查 CleanupUsageRetention 里**两个回收循环**
// （`for _, rel := range tables.Orphans` 与 `for _, rel := range attached`）的
// `reclaimMonths → !ok` 分支是否都有 noteSkip（AST 锚点；找不到锚点一律记问题 =
// fail-closed；两个循环各恰好一处，实得数不符即记问题）。
//
// 为什么要区分"哪个孤儿循环"：同一个函数里有**两个** `for _, rel := range tables.Orphans`
// —— 一个是 R12-N2 的"关系仍然存在"簿记（那里的 `!ok` 只是"没有月份可记"，静默 continue
// 是对的），另一个才是回收循环。判据只认后者：它的 `!ok` 前一条语句形如
// `first, last, ok := shape.reclaimMonths(rel)`（接收者是 `shape`；簿记循环用的是
// `tables.Shapes[rel].reclaimMonths(rel)`）。
func s1ret02ReclaimLoopShapeProblems(src string) []string {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, "usage_ledger.go", src, 0)
	if err != nil {
		return []string{"解析源码失败: " + err.Error()}
	}
	var problems []string
	// 两个循环各查一次：孤儿桶（tables.Orphans）与 attached 桶。
	loops := []struct {
		name  string
		match func(ast.Expr) bool
	}{
		{"孤儿回收循环", s1ret02IsTablesOrphans},
		{"attached 回收循环", s1ret02IsAttachedSlice},
	}
	for _, loop := range loops {
		found := 0
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Name.Name != "CleanupUsageRetention" || fn.Body == nil {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				rng, ok := n.(*ast.RangeStmt)
				if !ok || !loop.match(rng.X) {
					return true
				}
				stmts := rng.Body.List
				for i, st := range stmts {
					ifs, ok := st.(*ast.IfStmt)
					if !ok || !s1ret02IsNotOk(ifs.Cond) || i == 0 {
						continue
					}
					if !s1ret02PrecededByShapeReclaim(stmts[i-1]) {
						continue // 簿记循环（没有月份可记 ⇒ 静默 continue 是对的）
					}
					found++
					if !s1ret02BodyReportsSkip(ifs.Body) {
						problems = append(problems, fmt.Sprintf(
							"%s的 !ok 分支（第 %d 行）没有 noteSkip(…usageSkipUnclassifiedOrphan…) —— "+
								"静默 continue 正是 S1-RET-02 的另一半（判据回归时要让人看见，而不是什么都不做）",
							loop.name, fset.Position(ifs.Pos()).Line))
					}
				}
				return true
			})
		}
		if found != 1 {
			problems = append(problems, fmt.Sprintf("%s里的 `if !ok` 分支 = %d 处，want 恰好 1 处"+
				"（锚点失效 = 判据失效：`for _, rel := range <桶>` + `shape := tables.Shapes[rel]` + "+
				"`first, last, ok := shape.reclaimMonths(rel)` 是这条判据的全部依据）", loop.name, found))
		}
	}
	return problems
}

// s1ret02IsAttachedSlice 判断表达式是不是 `attached`（回收循环的第二个桶）。
func s1ret02IsAttachedSlice(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "attached"
}

// s1ret02IsTablesOrphans 判断表达式是不是 `tables.Orphans`。
func s1ret02IsTablesOrphans(e ast.Expr) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Orphans" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == "tables"
}

// s1ret02PrecededByShapeReclaim 判断语句是不是 `first, last, ok := shape.reclaimMonths(rel)`。
func s1ret02PrecededByShapeReclaim(stmt ast.Stmt) bool {
	as, ok := stmt.(*ast.AssignStmt)
	if !ok || len(as.Rhs) == 0 {
		return false
	}
	call, ok := as.Rhs[0].(*ast.CallExpr)
	if !ok {
		return false
	}
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "reclaimMonths" {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == "shape"
}

// s1ret02IsNotOk 判断条件是不是 `!ok`。
func s1ret02IsNotOk(e ast.Expr) bool {
	un, ok := e.(*ast.UnaryExpr)
	if !ok || un.Op != token.NOT {
		return false
	}
	id, ok := un.X.(*ast.Ident)
	return ok && id.Name == "ok"
}

// s1ret02BodyReportsSkip 判断分支体里有没有 `noteSkip(…, usageSkipUnclassifiedOrphan, …)`。
func s1ret02BodyReportsSkip(body *ast.BlockStmt) bool {
	if body == nil {
		return false
	}
	found := false
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok || id.Name != "noteSkip" {
			return true
		}
		for _, arg := range call.Args {
			if a, ok := arg.(*ast.Ident); ok && a.Name == "usageSkipUnclassifiedOrphan" {
				found = true
			}
		}
		return true
	})
	return found
}
