package appstore

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// N-2 永久回归(2026-09-13 三轮):发布锁的连接需求必须恒为 1
//
// R2 只保证了「等锁者不占连接」,持锁者仍然要两条连接(一条 hold 会话级锁
// 到 Publish 结束,一条给落库事务)。于是触发条件从「池里坐着 N 个同名等待者」
// 变成「池里坐着 N 个**不同名**的持锁者」—— 后者在生产里是**正常负载**
// (多人/多任务同时上传不同内容),不需要攻击者刻意制造同名竞争:
//
//	pool=2 两个不同名 → 3/3 轮死锁
//	pool=90 conc=100 不同名 → 20s 只完成 10/100(90 条 backend idle in transaction)
//
// 关键覆盖:本文件全部用**不同名字**。R2 新增的 publish_f2_lock_test.go 只用
// 同一个 name,恰好只测了已修好的那一半,对 N-2 零覆盖(假绿灯)。
// ---------------------------------------------------------------------------

// publishDistinctInParallel 让 n 个并发发布各自使用**不同**的 App 名。
func publishDistinctInParallel(t *testing.T, db *sql.DB, prefix string, n, pool int, deadline time.Duration) []error {
	t.Helper()
	db.SetMaxOpenConns(pool)
	db.SetMaxIdleConns(pool)
	errs := make([]error, n)
	var wg sync.WaitGroup
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			_, err := Publish(db, raceReq(
				fmt.Sprintf("%s-%d", prefix, i), "1.0.0",
				fmt.Sprintf("u%d", i), fmt.Sprintf("T%d", i)))
			errs[i] = err
		}(i)
	}
	close(start)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(deadline):
		t.Fatalf("DEADLOCK: pool=%d 下 %d 个**不同名**的并发发布在 %v 内没有全部完成"+
			"(持锁者需要第二条连接 → 池被占满且无人推进)", pool, n, deadline)
	}
	return errs
}

// TestPublishDistinctNamesTinyPoolNoDeadlock:N-2 的最小复现矩阵 ——
// pool=1/2/3 都必须全部完成。修复前 pool=1 与 pool=2 都是 100% 死锁。
func TestPublishDistinctNamesTinyPoolNoDeadlock(t *testing.T) {
	for _, tc := range []struct{ n, pool int }{{2, 1}, {2, 2}, {4, 2}, {6, 3}} {
		t.Run(fmt.Sprintf("pool%d-n%d", tc.pool, tc.n), func(t *testing.T) {
			db, cleanup := serverstore.NewTestDB(t)
			defer cleanup()
			start := time.Now()
			errs := publishDistinctInParallel(t, db, fmt.Sprintf("n2-tiny-%d-%d", tc.pool, tc.n), tc.n, tc.pool, 20*time.Second)
			for i, err := range errs {
				if err != nil {
					t.Errorf("不同名发布 %d 失败: %v", i, err)
				}
			}
			t.Logf("pool=%d n=%d 全部完成,耗时 %v", tc.pool, tc.n, time.Since(start).Round(time.Millisecond))
		})
	}
}

// pgConnectionCensus 返回 (max_connections, superuser_reserved, 当前总连接数)。
// 「当前总连接数」包含同一台 PG 上**其它测试进程**的池 —— go test -p N 时
// 多个包的池会共同吃 max_connections,那是环境上限而不是发布缺陷。
func pgConnectionCensus(t *testing.T, db *sql.DB) (int, int, int) {
	t.Helper()
	var maxConn, reserved, current int
	if err := db.QueryRow(`SHOW max_connections`).Scan(&maxConn); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SHOW superuser_reserved_connections`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM pg_stat_activity`).Scan(&current); err != nil {
		t.Fatal(err)
	}
	return maxConn, reserved, current
}

// TestPublishDistinctNamesProductionScale:复核员的量级(pool=90 conc=100)。
// 修复前 20s 只完成 10/100(90 条 backend idle in transaction/ClientRead)。
//
// 池大小按**当前 PG 剩余可授予连接数**收敛(上限 90):单跑时就是复核员的
// 生产画像;`go test -p N` 多包并发时自动缩小,避免把「别的测试进程占满
// max_connections」误报成发布失败(判据仍然是 pool < conc 的过订阅场景)。
func TestPublishDistinctNamesProductionScale(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	maxConn, reserved, current := pgConnectionCensus(t, db)
	pool := 90
	if free := maxConn - reserved - current - 2; free < pool {
		pool = free
	}
	if pool < 4 {
		t.Skipf("同一台 PG 上已有 %d 条连接(max=%d reserved=%d),剩余不足以复刻 pool<conc 的过订阅场景", current, maxConn, reserved)
	}
	t.Logf("PG max=%d reserved=%d 当前连接=%d → 本用例池=%d,并发=100", maxConn, reserved, current, pool)
	start := time.Now()
	errs := publishDistinctInParallel(t, db, "n2-scale", 100, pool, 60*time.Second)
	bad := 0
	for i, err := range errs {
		if err != nil {
			bad++
			if bad <= 3 {
				t.Errorf("不同名发布 %d 失败: %v", i, err)
			}
		}
	}
	if bad > 0 {
		t.Fatalf("pool=%d conc=100 不同名: %d/100 失败", pool, bad)
	}
	t.Logf("pool=%d conc=100 不同名全部完成,耗时 %v", pool, time.Since(start).Round(time.Millisecond))
}

// TestPublishDistinctNamesLeavesNoAdvisoryLock:串行化用的锁不能泄漏 ——
// 事务级咨询锁提交即释放;若有人换回会话级锁而忘了 unlock,这里会看到残留。
func TestPublishDistinctNamesLeavesNoAdvisoryLock(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	_ = publishDistinctInParallel(t, db, "n2-leak", 6, 3, 20*time.Second)

	// 用一个**独立**连接数 advisory 锁(排除本测试自己的连接)。
	ctl, err := sql.Open("pgx", serverstore.PgTestDSN())
	if err != nil {
		t.Skipf("ctl open: %v", err)
	}
	defer ctl.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var dbName string
	if err := db.QueryRow(`SELECT current_database()`).Scan(&dbName); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := ctl.QueryRowContext(ctx, `SELECT count(*) FROM pg_locks l
		JOIN pg_database d ON d.oid = l.database
		WHERE l.locktype = 'advisory' AND d.datname = $1`, dbName).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("并发发布结束后仍残留 %d 条 advisory 锁(锁泄漏 = 后续同名发布永久阻塞)", n)
	}
}

// TestPublishPoolCapStaysBelowPGMaxConnections:池上限必须 ≤ PG 实际可授予量。
// 修复前 db.go 硬编码 SetMaxOpenConns(400) > PG max_connections(100) ——
// 超过该值的请求不是排队而是直接 "too many clients" 报错。
func TestPublishPoolCapStaysBelowPGMaxConnections(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	var maxConn, reserved int
	if err := db.QueryRow(`SHOW max_connections`).Scan(&maxConn); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SHOW superuser_reserved_connections`).Scan(&reserved); err != nil {
		t.Fatal(err)
	}
	got := db.Stats().MaxOpenConnections
	t.Logf("PG max_connections=%d superuser_reserved=%d;应用池上限=%d", maxConn, reserved, got)
	if got > maxConn-reserved {
		t.Fatalf("应用池上限 %d 超过 PG 可授予的普通连接数 %d(超出的请求会直接报错)", got, maxConn-reserved)
	}
	// 同一时刻只应该有一个发布持锁,池至少要能放下 2(1 持锁 + 1 给别的请求)。
	if got < 2 {
		t.Fatalf("应用池上限 %d 过小,发布路径无法工作", got)
	}
}

// ---------------------------------------------------------------------------
// N-4 的**确定性**回归(不依赖并发时序):审核不变量必须在写入时原子判定。
//
// HTTP 层的 approve/reject 竞态测试是概率性的(窗口窄),所以这里直接对
// serverstore 的审核写入做状态机断言:拒绝过的版本再也无法被置为 approved,
// 且拒绝与释放归档是同一条语句的副作用(rejected 行不可能留着归档字节)。
// ---------------------------------------------------------------------------

func TestReleaseReviewGuardIsAtomic(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	req := raceReq("n4-guard", "1.0.0", "alice", "T")
	if _, err := Publish(db, req); err != nil {
		t.Fatalf("publish: %v", err)
	}
	// 1) 从未被拒过的行(含迁移前存量行)仍可通过审核。
	if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill,
		"n4-guard", "1.0.0", serverstore.ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("pending 行通过审核失败: %v", err)
	}
	row, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "n4-guard", "1.0.0")
	if err != nil || row.Status != serverstore.ReleaseStatusApproved || len(row.Archive) == 0 {
		t.Fatalf("approve 后 = %+v err=%v", row, err)
	}
	// 2) 拒绝:状态与归档释放必须同时发生。
	if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill,
		"n4-guard", "1.0.0", serverstore.ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatalf("reject: %v", err)
	}
	row, err = serverstore.GetRelease(db, serverstore.AppKindSkill, "n4-guard", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("reject 后 status=%s", row.Status)
	}
	if len(row.Archive) != 0 || row.Size != 0 {
		t.Fatalf("reject 后归档没有释放: archive=%d size=%d(存储上界被绕过:员工可无限循环上传→被拒)",
			len(row.Archive), row.Size)
	}
	// 3) 关键断言:归档已释放的 rejected 行**不能**再被置为 approved。
	err = serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill,
		"n4-guard", "1.0.0", serverstore.ReleaseStatusApproved, "")
	if !errors.Is(err, serverstore.ErrReleaseArchiveCleared) {
		t.Fatalf("rejected+空归档的版本通过审核 = %v, want ErrReleaseArchiveCleared", err)
	}
	row, _ = serverstore.GetRelease(db, serverstore.AppKindSkill, "n4-guard", "1.0.0")
	if row.Status != serverstore.ReleaseStatusRejected || len(row.Archive) != 0 {
		t.Fatalf("被拒的写操作改变了行: status=%s archive=%d", row.Status, len(row.Archive))
	}
	// 4) 不存在的版本仍回 ErrNotFound(不能与「归档已释放」混淆)。
	if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill,
		"n4-guard", "9.9.9", serverstore.ReleaseStatusApproved, ""); !errors.Is(err, serverstore.ErrNotFound) {
		t.Fatalf("不存在的版本 = %v, want ErrNotFound", err)
	}
}
