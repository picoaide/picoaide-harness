package serverstore

// R10-H3 泳道 · **W3-2（P3）**：`write_blocked_*` 只报当月 ⇒ 到期月（`[DETACH, DROP]`
// 窗口里唯一能撞上的月份）的布局型写失败在 `/readyz` 上完全不可见。
//
// 缺陷形态（复审 W3 的实测）：
//
//	回收一个到期月时，`[DETACH 提交, DROP 提交]` 之间该月的关系是"同名孤儿表"，
//	任何对该月的写入（迟到写入/补写）都会以 `*partitionLayoutError`
//	（stale detached table）失败并记进写入面 —— 但记账键是**到期月**，而
//	`usageWriteStateForReadyz` 只放行**当月** ⇒
//	  `write_blocked=false / write_blocked_month=""`（W3 的原始输出）。
//	单槽实现还有反向的洞：一次非当月失败会把**当月**的状态顶掉（当月不可写读成绿）。
//
// 本文件的判据（都是**生产写路径** `recordUsageKindAt`，不是直接调记账函数）：
//
//	H1 到期月写失败 ⇒ 当月面保持 false（语义不变），而
//	   `write_blocked_other_months` 必须点名该月（month + relation + kind）。
//	H2 两个面**互不遮蔽**：当月失败 + 到期月失败同时存在时，两份读数都在。
//	H3 成功写入只清**它自己那个月**：当月恢复不得抹掉"到期月写不进去"，
//	   反之亦然（单槽实现两个方向都会丢）。
//
// 复跑（真 PG）：
//
//	PG_DSN_TEST=postgres://postgres:postgres@127.0.0.1:5432/r10h3 \
//	  go test ./internal/serverstore/ -run 'TestR10H2' -count=1 -v

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

// r10hOtherMonth 在 readyz 快照里找某个月份的"其它月份"读数。
func r10hOtherMonth(t *testing.T, list []UsageWriteBlockOtherMonth, month string) *UsageWriteBlockOtherMonth {
	t.Helper()
	for i := range list {
		if list[i].Month == month {
			return &list[i]
		}
	}
	return nil
}

// TestR10HW2DetachedMonthWriteFailureIsVisible 是 W3-2 的主判据（判据 H1）。
func TestR10HW2DetachedMonthWriteFailureIsVisible(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	rel, expired := r10hOrphanFixture(t, db, uid)
	expiredMonth := monthKey(expired)
	currentMonth := monthKey(BeijingMonth(time.Now()))
	if expiredMonth == currentMonth {
		t.Fatalf("夹具不成立：到期月与当月都是 %s", currentMonth)
	}

	resetUsageRetentionStatusForTest()
	// 走**生产写路径**：一笔 created_at = 到期月的迟到写入（写路径会先 ensureUsagePartition）。
	at := BeijingDayAt(expired, 10)
	if _, err := recordUsageKindAt(db, uid, "r10h-w32", 10, 10, "chat", at); err == nil {
		t.Fatalf("夹具前提不成立：到期月 %s 有同名非分区表，写入应当失败", rel)
	} else {
		t.Logf("到期月写入失败（预期）：%v", err)
	}

	st := CurrentUsageRetentionStatus()
	jsonRaw, jerr := json.Marshal(st)
	if jerr != nil {
		t.Fatal(jerr)
	}
	t.Logf("快照：write_blocked=%v month=%q；other=%+v total=%d；json=%s",
		st.WriteBlocked, st.WriteBlockedMonth, st.WriteBlockedOtherMonths, st.WriteBlockedOtherCount, jsonRaw)

	// 当月面的语义**不变**：到期月的阻塞不冒充当月（当月可能完全正常）。
	if st.WriteBlocked {
		t.Errorf("非当月的布局型失败不得置 write_blocked（当月面语义必须保持）: month=%q", st.WriteBlockedMonth)
	}
	got := r10hOtherMonth(t, st.WriteBlockedOtherMonths, expiredMonth)
	if got == nil {
		t.Fatalf("到期月 %s 的布局型写失败在 /readyz 上必须可读（W3-2）："+
			"write_blocked_other_months=%+v total=%d", expiredMonth, st.WriteBlockedOtherMonths, st.WriteBlockedOtherCount)
	}
	if got.Relation != rel {
		t.Errorf("其它月份读数必须点名关系名: got %q want %q", got.Relation, rel)
	}
	if got.Kind == "" || got.Kind == "other" {
		t.Errorf("布局型失败必须带**封闭 kind**（机器可分流；W3-2 的原始失败是 stale detached table）: %+v", got)
	}
	if got.Count < 1 || got.Since == "" {
		t.Errorf("其它月份读数必须带累计次数与首次发生时刻: %+v", got)
	}
	if st.WriteBlockedOtherCount < 1 {
		t.Errorf("write_blocked_other_count 必须 ≥1（清单有界、计数是全量）: %d", st.WriteBlockedOtherCount)
	}
	if !strings.Contains(string(jsonRaw), `"write_blocked_other_months"`) {
		t.Errorf("/readyz.usage_retention 缺少机器可读键 write_blocked_other_months：%s", jsonRaw)
	}

	// 判据 H3（清账口径）：该月下一次**成功**写入只清它自己那一条。
	// 让该月可写：把同名非分区表挪走 → 写路径会重建月分区。
	if _, err := db.Exec("DROP TABLE " + quoteRelationIdent(rel)); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "r10h-w32-ok", 10, 10, "chat", at); err != nil {
		t.Fatalf("撤掉占名关系后到期月必须可写: %v", err)
	}
	st2 := CurrentUsageRetentionStatus()
	if got2 := r10hOtherMonth(t, st2.WriteBlockedOtherMonths, expiredMonth); got2 != nil {
		t.Errorf("该月恢复可写之后，它自己的那一条必须被清掉: %+v", got2)
	}
}

// TestR10HW2CurrentAndOtherMonthsDoNotMaskEachOther 是判据 H2/H3（两个面互不遮蔽）。
func TestR10HW2CurrentAndOtherMonthsDoNotMaskEachOther(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := db.Exec("TRUNCATE TABLE usage RESTART IDENTITY CASCADE"); err != nil {
		t.Fatal(err)
	}
	uid := mustUserID(t, db)
	rel, expired := r10hOrphanFixture(t, db, uid)
	expiredMonth := monthKey(expired)
	currentMonth := monthKey(BeijingMonth(time.Now()))

	// 当月也造一个"同名非分区表"占名 ⇒ 当月写入同样失败。
	// 形态与到期月同源：把当月分区**摘下来**（DETACH 之后它就是一个普通表，
	// relispartition=false ⇒ 写路径无法 adopt 领回，只能 fail-loud）。
	if err := ensureUsagePartition(db, time.Now()); err != nil {
		t.Fatal(err)
	}
	curRel := "usage_" + currentMonth
	if _, err := db.Exec("ALTER TABLE usage DETACH PARTITION " + quoteRelationIdent(curRel)); err != nil {
		t.Fatalf("摘当月分区 %s: %v", curRel, err)
	}

	resetUsageRetentionStatusForTest()
	// 先写到到期月（非当月），再写到当月 —— 单槽实现的形态是"后写的那个月把先写的顶掉"。
	if _, err := recordUsageKindAt(db, uid, "r10h-w32-expired", 10, 10, "chat", BeijingDayAt(expired, 10)); err == nil {
		t.Fatalf("夹具前提不成立：到期月 %s 写入应当失败", rel)
	}
	if _, err := recordUsageKindAt(db, uid, "r10h-w32-current", 10, 10, "chat", time.Now()); err == nil {
		t.Fatalf("夹具前提不成立：当月 %s 写入应当失败", curRel)
	}

	st := CurrentUsageRetentionStatus()
	t.Logf("两个面：write_blocked=%v month=%q；other=%+v", st.WriteBlocked, st.WriteBlockedMonth, st.WriteBlockedOtherMonths)
	if !st.WriteBlocked || st.WriteBlockedMonth != currentMonth {
		t.Errorf("当月失败必须进 write_blocked_*（既有语义）: %v/%q want month=%q", st.WriteBlocked, st.WriteBlockedMonth, currentMonth)
	}
	if got := r10hOtherMonth(t, st.WriteBlockedOtherMonths, expiredMonth); got == nil {
		t.Errorf("当月失败不得遮蔽到期月的读数（单槽实现的洞）: %+v", st.WriteBlockedOtherMonths)
	} else if got.Relation != rel {
		t.Errorf("到期月读数必须点名 %s: %+v", rel, got)
	}
	// 反向：当月恢复不得抹掉到期月那一条。
	if _, err := db.Exec("DROP TABLE " + quoteRelationIdent(curRel)); err != nil {
		t.Fatal(err)
	}
	if _, err := recordUsageKindAt(db, uid, "r10h-w32-current-ok", 10, 10, "chat", time.Now()); err != nil {
		t.Fatalf("撤掉占名关系后当月必须可写: %v", err)
	}
	st2 := CurrentUsageRetentionStatus()
	if st2.WriteBlocked {
		t.Errorf("当月恢复可写后 write_blocked 必须回落: %+v", st2)
	}
	if got := r10hOtherMonth(t, st2.WriteBlockedOtherMonths, expiredMonth); got == nil {
		t.Errorf("当月恢复可写不得抹掉到期月那一条（各月独立）: %+v", st2.WriteBlockedOtherMonths)
	}
}

// TestR10HW2ErrorFaceAlsoHasOtherMonths 覆盖同一个洞的**瞬时失败**面（write_error_*）：
// 结构同因（单槽 + 只放行当月），所以判据同形。
func TestR10HW2ErrorFaceAlsoHasOtherMonths(t *testing.T) {
	expired := bjMonth(3)
	month := monthKey(expired)
	resetUsageRetentionStatusForTest()
	noteUsagePartitionWriteFailure(expired, errors.New("connection reset by peer"))
	st := CurrentUsageRetentionStatus()
	if st.WriteError {
		t.Errorf("非当月的瞬时失败不得置 write_error（当月面语义不变）: %+v", st)
	}
	if got := r10hOtherMonth(t, st.WriteErrorOtherMonths, month); got == nil {
		t.Fatalf("非当月的瞬时写失败也必须可读（write_error_other_months）: %+v", st.WriteErrorOtherMonths)
	} else if got.Relation != "usage_"+month {
		t.Errorf("其它月份读数必须点名关系名: %+v", got)
	}
	if st.WriteErrorOtherCount < 1 {
		t.Errorf("write_error_other_count 必须 ≥1: %d", st.WriteErrorOtherCount)
	}
}
