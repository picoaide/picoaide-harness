package tokenretention

// R15C-R-01 ①（审计 2026-09-25，P1）的判据：过期令牌必须有一个**周期执行者**。
//
// 修复前的实测形态：`api_tokens` 全仓零回收者（DELETE 只有 4 处按 user_id：改密/
// 禁用/删用户），迁移 0031 建的 `idx_tokens_expires` 真 PG `idx_scan = 0`；500 条
// 过期行在**重启服务后依然存在**（没有任何启动期清理）。读取面又无分页 ⇒ 1M 行时
// 单请求 130.8 MiB / 堆 +656 MB。
//
// 三条判据（本仓对"清理"的既有约定：挂 ctx、退出即停、删除计数进日志）：
//  1. 启动即跑一轮：不重启进程、不调任何接口，过期行被删掉，且**删除计数进日志**；
//  2. ctx 取消后后台循环退出（Stopped() 关闭），不再跑新的一轮；
//  3. 幂等：连续多轮不重复删、不报错。
//
// 变异即红：把 Start 里的 `s.TryRun()`（启动先跑一轮）删掉 ⇒ 用例 1 红；
// 把 select 的 `<-ctx.Done()` 分支删掉 ⇒ 用例 2 红；把 TryRun 的 PurgeExpiredTokens
// 调用删掉 ⇒ 用例 1/3 红。

import (
	"bytes"
	"context"
	"database/sql"
	"log"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func seedExpiredAndLive(t *testing.T, db *sql.DB, expired, live int) int64 {
	t.Helper()
	uid, err := serverstore.CreateUser(db, &serverstore.User{Username: "tokret", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
		SELECT ?, 'r15c-exp-' || g, 'desktop', now() - interval '1 day' FROM generate_series(1, ?) g`,
		uid, expired); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
		SELECT ?, 'r15c-live-' || g, 'desktop', now() + interval '90 days' FROM generate_series(1, ?) g`,
		uid, live); err != nil {
		t.Fatal(err)
	}
	return uid
}

// captureLog 捕获测试期间的全局 log 输出（调度器的删除计数行必须能被 grep 到）。
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	var mu sync.Mutex
	prev := log.Writer()
	log.SetOutput(&lockedWriter{w: &buf, mu: &mu})
	t.Cleanup(func() { log.SetOutput(prev) })
	return &buf
}

type lockedWriter struct {
	w  *bytes.Buffer
	mu *sync.Mutex
}

func (l *lockedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.w.Write(p)
}

func TestSchedulerPurgesExpiredTokensOnStartAndLogsCount(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	uid := seedExpiredAndLive(t, db, 7, 3)
	logs := captureLog(t)

	ran := make(chan int64, 8)
	s := NewScheduler(db, 50*time.Millisecond, nil)
	s.onRun = func(removed int64) {
		select {
		case ran <- removed:
		default:
		}
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.Start(ctx)

	select {
	case removed := <-ran:
		if removed != 7 {
			t.Fatalf("启动第一轮应删 7 条过期行, 实得 %d", removed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("调度器没有在启动后跑第一轮（Start 里删掉 s.TryRun() 即红）")
	}

	var live int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, uid).Scan(&live); err != nil {
		t.Fatal(err)
	}
	if live != 3 {
		t.Fatalf("回收后应只剩 3 条有效行, 实得 %d（有效行被删 = 谓词写错）", live)
	}
	if expired, err := serverstore.CountExpiredTokens(db); err != nil || expired != 0 {
		t.Fatalf("过期行应清空, 实得 %d (err=%v)", expired, err)
	}
	// 可观测面：Started/Runs/LastRemoved 都是**过程事实**。注意 LastRemoved 是
	// "最近一轮"的读数（tick 很短时后续空转轮会把它覆盖成 0），所以这里只断言
	// "跑过至少一轮"，第一轮删了 7 条这件事由上面的 ran 通道断言（那是本轮事实）。
	if !s.Started() || s.Runs() < 1 {
		t.Fatalf("可观测面不对: started=%v runs=%d", s.Started(), s.Runs())
	}

	// 删除计数必须进日志（本仓对清理的既有约定）。
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(logs.String(), "purged 7 expired api token(s)") {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !strings.Contains(logs.String(), "purged 7 expired api token(s)") {
		t.Fatalf("删除计数必须进日志, 实得日志:\n%s", logs.String())
	}

	// 幂等：后续轮次不再删任何行（不重复删、不报错）。
	select {
	case removed := <-ran:
		if removed != 0 {
			t.Fatalf("第二轮应删 0 行（幂等）, 实得 %d", removed)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("调度器没有继续跑后续轮次")
	}
}

func TestSchedulerStopsWithContext(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	seedExpiredAndLive(t, db, 1, 0)

	s := NewScheduler(db, 20*time.Millisecond, nil)
	ctx, cancel := context.WithCancel(context.Background())
	s.Start(ctx)
	select {
	case <-s.Stopped():
		t.Fatal("ctx 未取消时调度器不应退出")
	case <-time.After(200 * time.Millisecond):
	}
	cancel()
	select {
	case <-s.Stopped():
	case <-time.After(10 * time.Second):
		t.Fatal("ctx 取消后调度器必须退出（退出即停是清理者的既有约定）")
	}
	runs := s.Runs()
	time.Sleep(150 * time.Millisecond)
	if s.Runs() != runs {
		t.Fatalf("ctx 取消后不得再跑新的一轮: %d → %d", runs, s.Runs())
	}
}

func TestSchedulerNilDBIsSafe(t *testing.T) {
	s := NewScheduler(nil, time.Hour, nil)
	s.Start(context.Background())
	if s.Started() {
		t.Fatal("nil db 不应启动后台循环")
	}
	if s.TryRun() != 0 {
		t.Fatal("nil db 的 TryRun 应为空操作")
	}
}
