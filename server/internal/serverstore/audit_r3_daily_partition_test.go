package serverstore

import (
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// R1-P1-3 同族(2026-09-13 独立复核确认仍未修):日账分区 usage_daily_<YYYY>
// 的并发首写竞态。
//
// 根因:年分区 ensureUsageDailyPartition 只有一条裸
// `CREATE TABLE IF NOT EXISTS ... PARTITION OF`,没有月分区
// (ensureUsagePartition)那样的 42P07 兜底复检。「探测 → 建表」之间的窗口里
// 并发的另一会话会拿到 relation already exists(SQLSTATE 42P07),而这个错误
// 被原样返回 → RebuildUsageLedger 整轮失败、日账自愈被跳过;月分区的实现把
// 「名字被抢占」视为成功(名字被抢占即达到目的,但必须复检占用者是真分区)。
//
// 触发条件(复核报告 §11):跨年 + 两个 Rebuild/Cleanup
// (启动补算 vs CleanupUsageRetention)并发、或多副本共库。
//
// 本用例先 DROP 目标年分区,再用**真实写入路径** RebuildUsageLedger 16 并发
// 「首写」,失败数必须为 0;随后复检建出来的是真分区,并真的 INSERT 一行证明
// 该分区能承载业务写入(不是只把错误吞掉)。
func TestEnsureUsageDailyPartitionConcurrentFirstWrite(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 下一自然年:测试库预建分区窗口到"当前+6 月",目标年分区必然不存在。
	target := BeijingMonth(time.Now()).AddDate(0, 12, 0)
	rel := "usage_daily_" + target.Format("2006")
	from := time.Date(target.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	to := from.AddDate(0, 0, 30)

	const workers = 16
	assertNoFailures := func(round int, what string, errs []error) {
		t.Helper()
		var failed []string
		for i, err := range errs {
			if err != nil {
				failed = append(failed, fmt.Sprintf("w%d:%v", i, err))
			}
		}
		if len(failed) > 0 {
			t.Fatalf("round %d %s: %d/%d 并发首写失败(修复前为 42P07 relation %s already exists): %v",
				round, what, len(failed), workers, rel, failed)
		}
	}

	// round 1-2:生产路径(RebuildUsageLedger 是启动补算与
	// CleanupUsageRetention 的唯一日账入口)。
	for round := 1; round <= 2; round++ {
		if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
			t.Fatalf("round %d: drop %s: %v", round, rel, err)
		}
		errs := r3ConcurrentErrs(workers, func(int) error { return RebuildUsageLedger(db, from, to) })
		assertNoFailures(round, "RebuildUsageLedger", errs)
	}
	// round 3:直接并发打年分区 helper —— 与月分区的并发用例对称,证明两条
	// 路径共用同一套 42P07 语义。
	if _, err := db.Exec("DROP TABLE IF EXISTS " + rel); err != nil {
		t.Fatalf("round 3: drop %s: %v", rel, err)
	}
	errs := r3ConcurrentErrs(workers, func(int) error { return ensureUsageDailyPartition(db, target) })
	assertNoFailures(3, "ensureUsageDailyPartition", errs)

	// 竞态兜底不得放过"同名孤儿表":必须真的是 usage_daily 的分区。
	var isPartition bool
	if err := db.QueryRow(`SELECT c.relispartition FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = $1 AND n.nspname = 'public'`, rel).Scan(&isPartition); err != nil {
		t.Fatalf("复检分区 %s: %v", rel, err)
	}
	if !isPartition {
		t.Fatalf("%s 建出来了但不是分区(同名孤儿表)", rel)
	}

	// 真写:并发首写之后,该年分区必须能承载真实日账 INSERT(证明修的是
	// "建出可用分区",不是"把错误吞掉")。
	uid := mustUserID(t, db)
	day := time.Date(target.Year(), 1, 15, 0, 0, 0, 0, time.UTC).Format("2006-01-02")
	if _, err := db.Exec(`INSERT INTO usage_daily
		(user_id, model, day, prompt_tokens, completion_tokens, cache_prompt_tokens, requests, cost)
		VALUES (?, ?, ?, 1, 1, 0, 1, 0.25)`, uid, "audit-r3", day); err != nil {
		t.Fatalf("并发首写后的真实日账 INSERT 失败: %v", err)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM ` + rel).Scan(&n); err != nil {
		t.Fatalf("count %s: %v", rel, err)
	}
	if n != 1 {
		t.Fatalf("分区 %s 行数 = %d, want 1", rel, n)
	}
}

// TestEnsureUsageDailyPartitionRejectsStaleDetachedTable 锁反向边界:42P07
// 兜底复检不得把 F11 的同名**孤儿表**(被 DETACH 未 DROP,或历史遗留的同名
// 普通表)当成"分区已存在"吞掉 —— 年分区与月分区共用 helper 后同样必须
// fail-loud,否则该年日账写入会撞 "no partition of relation usage_daily found
// for row"。
func TestEnsureUsageDailyPartitionRejectsStaleDetachedTable(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	year := BeijingMonth(time.Now()).AddDate(2, 0, 0)
	rel := "usage_daily_" + year.Format("2006")
	if _, err := db.Exec("CREATE TABLE IF NOT EXISTS " + rel + " (id BIGINT)"); err != nil {
		t.Fatal(err)
	}
	err := ensureUsageDailyPartition(db, year)
	if err == nil || !strings.Contains(err.Error(), "is not a partition") {
		t.Fatalf("同名孤儿表下的 err = %v, want stale detached table error", err)
	}
}

// r3ConcurrentErrs 让 n 个 goroutine 同时执行 fn,返回各自错误(与
// TestEnsureUsagePartitionConcurrent 同一口径)。
func r3ConcurrentErrs(n int, fn func(i int) error) []error {
	var wg sync.WaitGroup
	errs := make([]error, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			errs[i] = fn(i)
		}(i)
	}
	close(start)
	wg.Wait()
	return errs
}
