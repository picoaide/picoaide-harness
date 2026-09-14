package serverstore

// 审计 r7 **第三轮**对抗复核(报告 RECHECK3-F1-billing-partitions §2 rc3-4)。
//
// r7f1-3 把覆盖判据从"同名关系"放宽到"区间覆盖",但覆盖探测的**入口**仍然是
// **可解析的区间字面量**:`DEFAULT` 与 `FOR VALUES FROM (MINVALUE) TO (MAXVALUE)`
// 是**最宽**的两种覆盖(分区树在区间上完整覆盖一切,写入经 PG 路由正确落进该
// 分区),却因为拿不到引号字面量被判成"读不懂" ⇒ 该布局下每月首写:
//
//	DEFAULT 分区为空   → 建出不必要的月分区(无害但不是"复用");
//	DEFAULT 分区已有行 → CREATE 被 PG 以 **23514** 拒绝(不是 42P17),
//	                     isOverlapPartitionErr 不认 ⇒ **裸 SQLSTATE 直出**,
//	                     RecordUsage / RebuildUsageLedger 该月永久失败(503),
//	                     而该布局本身完全可写 —— 每月首写永久卡死且不自愈;
//	MINVALUE..MAXVALUE → 同理判非覆盖 → CREATE → 42P17 → 文案说"无法确定是哪一个"。
//
// 修法:
//  1. partitionBoundCoverage 把两种形态显式识别为"覆盖一切" ⇒ scanUsagePartitions
//     命中 Covering 即复用、跳过 CREATE(ensureRangePartition 的区间判据不允许分叉);
//  2. 23514 纳入翻译(isDefaultPartitionViolationErr → coveredByDefaultPartitionErr),
//     给与 overlappingPartitionErr 同级的人工处置指引(不再裸 SQLSTATE);
//  3. 回归用例覆盖 DEFAULT(空/有行)与 MINVALUE 三种布局。

import (
	"database/sql"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// r7cDropUsagePartitions 清掉 usage 的全部分区(临时库,构造隔离布局用)。
func r7cDropUsagePartitions(t *testing.T, db *sql.DB) {
	t.Helper()
	rows, err := db.Query(`SELECT c.relname FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_class p ON p.oid = i.inhparent
WHERE p.relname = 'usage' AND c.relnamespace = 'public'::regnamespace`)
	if err != nil {
		t.Fatalf("列出 usage 分区: %v", err)
	}
	var names []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		names = append(names, n)
	}
	rows.Close()
	for _, n := range names {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + n); err != nil {
			t.Fatalf("drop %s: %v", n, err)
		}
	}
}

// r7cCoveredEverythingCounter 支撑三种"覆盖一切"布局的同一份断言。
func r7cAssertCoveredLayoutReused(t *testing.T, db *sql.DB, partition, covering string, seedRow bool) {
	t.Helper()
	r7cDropUsagePartitions(t, db)
	if _, err := db.Exec(`CREATE TABLE ` + partition + ` PARTITION OF usage ` + covering); err != nil {
		t.Fatalf("构造覆盖布局(%s %s): %v", partition, covering, err)
	}
	uid, err := CreateUser(db, &User{Username: "r7c-covered-" + partition, Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	at := r7bMonthAt(2099, time.August)
	if seedRow {
		// DBA 预建 + 历史写入已经落在该分区里(23514 的触发条件)。
		if _, err := db.Exec(`INSERT INTO usage (user_id, model, prompt_tokens, completion_tokens, kind, cost, created_at)
VALUES (?, 'r7c-model', 1, 1, 'chat', 0, '2099-08-15 12:00:00+08')`, uid); err != nil {
			t.Fatalf("在覆盖分区里预置历史行: %v", err)
		}
	}
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatalf("%s 布局下 ensureUsagePartition 失败(该布局本就可写,只是不能再建窄分区): %v", partition, err)
	}
	// 关键:命中覆盖后**不得**再 CREATE 月分区。
	if exists, _, bound := r4ProbeRelation(t, db, "usage_209908"); exists {
		t.Fatalf("窗口已被 %s 完整覆盖,却仍然建了月分区 usage_209908(bound=%s)", partition, bound)
	}
	// 真写路径:计量必须成功并落进覆盖分区。
	id, err := recordUsageKindAt(db, uid, "r7c-model", 10, 10, "chat", at)
	if err != nil {
		t.Fatalf("%s 布局下的计量写入失败: %v", partition, err)
	}
	var where string
	if err := db.QueryRow(`SELECT tableoid::regclass::text FROM usage WHERE id = ?`, id).Scan(&where); err != nil {
		t.Fatal(err)
	}
	if where != partition {
		t.Fatalf("计量写入没有路由到覆盖分区: 落在 %s, want %s", where, partition)
	}
	// 幂等:重复 ensure 仍然成功(热路径每次写入都会调它)。
	if err := ensureUsagePartition(db, at); err != nil {
		t.Fatalf("%s 布局下幂等复检失败: %v", partition, err)
	}
	// 服务端不得改写/删除别人的分区。
	exists, isPartition, after := r4ProbeRelation(t, db, partition)
	if !exists || !isPartition {
		t.Fatalf("覆盖分区被自动处置: exists=%v isPartition=%v", exists, isPartition)
	}
	t.Logf("%s(%s): ensure/record/幂等全部成功,写入落进 %s,分区边界=%q", partition, covering, where, after)
}

// TestR7cDefaultPartitionLayoutIsReused:DEFAULT 分区(空)+ 月首写。
// 修复前:scanUsagePartitions 读不懂 DEFAULT ⇒ 走 CREATE 建出 usage_209908
// (不必要,且把"覆盖一切"的布局撕成两半)。
func TestR7cDefaultPartitionLayoutIsReused(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	r7cAssertCoveredLayoutReused(t, db, "usage_r7c_dflt_empty", "DEFAULT", false)
}

// TestR7cDefaultPartitionWithRowsIsReused:DEFAULT 分区里**已有该窗口的行**
// (DBA 预建 + 历史写入)—— 修复前 CREATE 报 23514 裸错误,该月每次计量写入
// 永久 503 且不自愈;修复后必须复用并正常路由。
func TestR7cDefaultPartitionWithRowsIsReused(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	r7cAssertCoveredLayoutReused(t, db, "usage_r7c_dflt_rows", "DEFAULT", true)
}

// TestR7cMinValueMaxValueLayoutIsReused:MINVALUE..MAXVALUE(等价 DEFAULT,
// 显式无限区间)布局同问 —— 修复前同样被判"读不懂"。
func TestR7cMinValueMaxValueLayoutIsReused(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	r7cAssertCoveredLayoutReused(t, db, "usage_r7c_minmax", "FOR VALUES FROM (MINVALUE) TO (MAXVALUE)", true)
}

// TestR7cCoveredEverythingIsRecognizedByComparator:"覆盖一切"的形态识别,以及
// 它与既有"读不懂"契约的**分工**:
//
//   - 异名分区扫描(scanUsagePartitions → partitionBoundCoversEverything):
//     DEFAULT / MINVALUE..MAXVALUE = 覆盖一切 ⇒ 复用、跳过 CREATE(rc3-4);
//   - 同名关系(verifyPartitionBound → partitionBoundCoverage):默认仍按
//     「读不懂 ⇒ fail-loud + 人工核对」(审计 r5 §2 的契约,不允许被本轮悄悄
//     放宽 —— 月分区名字 + DEFAULT 边界的手工对象仍然要求人看)。
func TestR7cCoveredEverythingIsRecognizedByComparator(t *testing.T) {
	spec := partitionSpec{parent: "usage", key: "209908", from: "2099-07-31 16:00:00+00:00", to: "2099-08-31 16:00:00+00:00"}

	coveringForms := []struct{ bound, desc string }{
		{"DEFAULT", "DEFAULT 分区"},
		{"default", "小写 default"},
		{" DEFAULT ", "带空白"},
		{"FOR VALUES FROM (MINVALUE) TO (MAXVALUE)", "显式无限区间"},
		{"FOR VALUES FROM ( MINVALUE ) TO ( MAXVALUE )", "带内嵌空白"},
		{"for values from (minvalue) to (maxvalue)", "小写"},
		{"FOR VALUES FROM (MINVALUE) TO (MAXVALUE);", "带分号"},
	}
	for _, c := range coveringForms {
		if !partitionBoundCoversEverything(c.bound) {
			t.Fatalf("%s(%q)没有被识别为覆盖一切", c.desc, c.bound)
		}
	}
	notCovering := []string{
		"FOR VALUES FROM ('2099-08-01 00:00:00+08') TO ('2099-09-01 00:00:00+08')",
		"FOR VALUES FROM ('2099-08-10 00:00:00+08') TO ('2099-09-10 00:00:00+08')",
		"FOR VALUES FROM (MINVALUE) TO ('2099-09-01 00:00:00+08')",
		"FOR VALUES IN (1,2,3)",
		"",
	}
	for _, b := range notCovering {
		if partitionBoundCoversEverything(b) {
			t.Fatalf("%q 被误判为覆盖一切(会跳过 CREATE 而留下窗口空洞)", b)
		}
	}

	// 同名关系契约不变:DEFAULT 仍是"读不懂"(fail-loud),不得被判就绪。
	if covered, _, readable := partitionBoundCoverage(spec, "DEFAULT"); covered || readable {
		t.Fatalf("同名 DEFAULT 关系被放行(审计 r5 §2 的「读不懂 ⇒ 人工核对」契约被破坏): covered=%v readable=%v", covered, readable)
	}
	if err := verifyPartitionBound(spec, "DEFAULT"); err == nil {
		t.Fatalf("同名 DEFAULT 边界被判就绪")
	} else if !strings.Contains(err.Error(), "cannot be read back from the catalog") {
		t.Fatalf("同名 DEFAULT 必须报「读不懂」类错误: %v", err)
	}
	// 既有区间语义不变。
	if covered, _, readable := partitionBoundCoverage(spec, "FOR VALUES FROM ('2099-07-01 00:00:00+08') TO ('2099-10-01 00:00:00+08')"); !covered || !readable {
		t.Fatalf("季度覆盖(既有语义)被破坏: covered=%v readable=%v", covered, readable)
	}
	if covered, _, readable := partitionBoundCoverage(spec, "FOR VALUES FROM ('2099-08-10 00:00:00+08') TO ('2099-09-10 00:00:00+08')"); covered || !readable {
		t.Fatalf("部分重叠(既有语义:不覆盖)被破坏: covered=%v readable=%v", covered, readable)
	}
}

// TestR7cDefaultPartitionViolationIsTranslated:23514(PG 的"新增分区会让
// DEFAULT 分区里的既有行违反约束")必须被识别并翻译成与 overlappingPartitionErr
// 同级的人工处置指引 —— 修复前计量热路径只拿到裸 SQLSTATE,管理员无从下手。
func TestR7cDefaultPartitionViolationIsTranslated(t *testing.T) {
	// 识别:两种错误形态(*pgconn.PgError 与纯字符串)。
	pgErr := &pgconn.PgError{Code: "23514", Message: `updated partition constraint for default partition "usage_dflt" would be violated by some row`}
	if !isDefaultPartitionViolationErr(pgErr) {
		t.Fatalf("23514(*pgconn.PgError)没有被识别为 DEFAULT 分区冲突")
	}
	if !isDefaultPartitionViolationErr(errString("ERROR: updated partition constraint for default partition \"usage_dflt\" would be violated by some row (SQLSTATE 23514)")) {
		t.Fatalf("23514(错误串)没有被识别为 DEFAULT 分区冲突")
	}
	// 不能把别的 SQLSTATE 误认成它(42P17/42P07 各有自己的出口)。
	if isDefaultPartitionViolationErr(errString("ERROR: partition \"usage_209908\" would overlap partition \"usage_209909\" (SQLSTATE 42P17)")) {
		t.Fatalf("42P17 被误判为 DEFAULT 分区冲突")
	}
	if isDefaultPartitionViolationErr(nil) {
		t.Fatalf("nil 不是 DEFAULT 分区冲突")
	}

	spec := partitionSpec{parent: "usage", key: "209908", from: "2099-07-31 16:00:00+00:00", to: "2099-08-31 16:00:00+00:00"}
	msg := coveredByDefaultPartitionErr(spec, pgErr).Error()
	t.Logf("翻译后的错误: %s", msg)
	for _, want := range []string{"manual intervention", "usage_209908", "DEFAULT", "usage"} {
		if !strings.Contains(msg, want) {
			t.Fatalf("翻译后的错误缺少 %q(管理员无从下手): %s", want, msg)
		}
	}
	if strings.Contains(msg, "DROP 该分区让服务端重建") {
		t.Fatalf("错误文案诱导管理员删表(文案纪律): %s", msg)
	}
}

// errString 是 errors.New 的别名,保持用例内可读(避免为一行 import 展开)。
type errString string

func (e errString) Error() string { return string(e) }
