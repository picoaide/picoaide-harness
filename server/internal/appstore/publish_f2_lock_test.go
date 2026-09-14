package appstore

import (
	"context"
	"database/sql"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N2 / F2-N9)的永久回归
//
// F2-N2:一轮为了串行化同名发布而用 db.Begin() 开了一个**只为持锁**的事务,
// 并持有到整个 Publish 结束;Publish 中途的 UpsertAppAndCreateRelease 会再开
// 一个事务、再要一条连接。池被在途发布占满时:持锁者卡在「等第二条连接」,
// 等锁者继续占着连接等咨询锁 —— 双方都不释放,db.Begin() 又用
// context.Background(),请求断开也不取消,永久死锁只能重启进程。
//
// 复核实测:pool=4 + 4 并发同名发布 → 3/3 次全卡死;pool=90 + 100 并发 →
// 0/100 完成。下面的用例用**小池**跑并发发布(现有用例用默认池所以测不出),
// 断言全部完成、无卡死。
//
// F2-N9:锁键此前是两段 32 位 hashtext,碰撞真实存在
// (hashtext("app-1481649") == hashtext("app-16327")),无关发布互相串行。
// ---------------------------------------------------------------------------

// publishInParallel 在给定连接池上限下并发发起 n 次同名发布,返回每人的结果。
// 超过 deadline 仍未结束即判定死锁(pool 会被判定为不可恢复)。
func publishInParallel(t *testing.T, db *sql.DB, name string, n, pool int, deadline time.Duration) []error {
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
			// 版本号不同、发布者不同:除了赢家,其余必须被归属/版本语义拒绝。
			r := raceReq(name, fmt.Sprintf("1.0.%d", i), fmt.Sprintf("user%d", i), fmt.Sprintf("T%d", i))
			_, errs[i] = Publish(db, r)
		}(i)
	}
	close(start)
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
		return errs
	case <-time.After(deadline):
		// 死锁时持锁事务会一直开着,**池里的连接也全被占住** —— 这里必须用
		// 一条池外的新连接(与探针同法)把本库后端终止,否则连收尸都会卡住。
		if ctl, cerr := sql.Open("pgx", serverstore.PgTestDSN()); cerr == nil {
			defer ctl.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var myPid int
			_ = ctl.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&myPid)
			_, _ = ctl.ExecContext(ctx, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
				WHERE datname = current_database() AND pid <> $1`, myPid)
		}
		t.Fatalf("POOL DEADLOCK: pool=%d 下 %d 个并发同名发布在 %v 内没有全部完成(持锁者要第二条连接、等锁者占着连接,互不释放)", pool, n, deadline)
		return nil
	}
}

// TestConcurrentPublishSmallPoolCompletesWithoutDeadlock:F2-N2 主回归。
// 小连接池(pool=4)+ 12 路并发同名发布:必须全部返回,且最多一个赢家。
func TestConcurrentPublishSmallPoolCompletesWithoutDeadlock(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	started := time.Now()
	errs := publishInParallel(t, db, "pool-race-small", 12, 4, 30*time.Second)
	t.Logf("pool=4, 12 路并发同名发布全部完成,耗时 %v", time.Since(started).Round(time.Millisecond))

	winners := 0
	for i, err := range errs {
		if err == nil {
			winners++
			continue
		}
		// 败者只能被归属/版本语义拒绝,不能是内部错误。
		if c := code(t, err); c != CodeNameTaken && c != CodeVersionNotIncreasing && c != CodeVersionExists {
			t.Fatalf("第 %d 路发布被非语义错误拒绝: %v", i, err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners = %d, want exactly 1(其余必须 409 归属/版本冲突)", winners)
	}
}

// TestConcurrentPublishMediumPoolNoStarvation:pool=8 + 24 路并发,确认「等待者
// 不占连接」的做法在持续争用下也不会饿死或超时。
func TestConcurrentPublishMediumPoolNoStarvation(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	started := time.Now()
	errs := publishInParallel(t, db, "pool-race-medium", 24, 8, 30*time.Second)
	t.Logf("pool=8, 24 路并发同名发布全部完成,耗时 %v", time.Since(started).Round(time.Millisecond))

	winners := 0
	for i, err := range errs {
		if err == nil {
			winners++
			continue
		}
		if c := code(t, err); c != CodeNameTaken && c != CodeVersionNotIncreasing && c != CodeVersionExists {
			t.Fatalf("第 %d 路发布被非语义错误拒绝: %v", i, err)
		}
	}
	if winners != 1 {
		t.Fatalf("winners = %d, want exactly 1", winners)
	}
}

// TestPublishLockKeyDoesNotSerializeUnrelatedNames:F2-N9 —— 锁键不能再用两段
// 32 位 hashtext。先用 PG 自己确认那两个名字同键,再按**旧键**(两段 int4 的
// 会话级形式与旧实现的事务级形式共用同一把锁)把 busy 占住:无关名字的发布
// 必须照常完成。旧实现下两者同键,这条用例会阻塞到超时(红)。
func TestPublishLockKeyDoesNotSerializeUnrelatedNames(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	ctx := context.Background()

	const busy, unrelated = "app-1481649", "app-16327"
	var h1, h2 int32
	if err := db.QueryRowContext(ctx, `SELECT hashtext($1), hashtext($2)`, busy, unrelated).Scan(&h1, &h2); err != nil {
		t.Fatal(err)
	}
	if h1 != h2 {
		t.Skipf("夹具在 32 位 hashtext 下已不再碰撞(%d vs %d),无法证明回归", h1, h2)
	}
	t.Logf("旧键碰撞确认: hashtext(%q) == hashtext(%q) == %d", busy, unrelated, h1)

	conn, err := db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	// 旧实现的键 = (hashtext(kind), hashtext(app_id));会话级两参形式与
	// pg_advisory_xact_lock(int4,int4) 在同一锁空间,足以模拟「busy 正在发布」。
	if _, err := conn.ExecContext(ctx, `SELECT pg_advisory_lock(hashtext($1), hashtext($2))`,
		serverstore.AppKindSkill, busy); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_, _ = conn.ExecContext(ctx, `SELECT pg_advisory_unlock(hashtext($1), hashtext($2))`,
			serverstore.AppKindSkill, busy)
	}()

	done := make(chan error, 1)
	go func() {
		_, err := Publish(db, raceReq(unrelated, "1.0.0", "alice", "T"))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("无关名字的发布失败: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("与持锁名字 32 位哈希碰撞的无关发布被阻塞:锁键仍是可碰撞的 32 位 hashtext")
	}
}
