package compile

// 本文件是**周期回收循环**（2026-09-23 现场 P0-a）的判据。
//
// 缺陷形态（生产实例实测，本文件第 1 条用例就是它的复现）：磁盘编译缓存的写者不止
// 发布期编译 —— **执行侧**（runtime 的 wazero 磁盘缓存）也在写（判据见
// internal/wasmapp/runtime/cache_mode_test.go 的 `wantDiskWrites: true`），而回收
// 此前只挂在 runJob（编译作业之后）上。于是"只服务、不发布"的稳态里缓存只涨不降，
// `/readyz` 报超限，发布闸门（AllowPublish）又因超限拒绝发布/校验 ⇒ 永不再产生编译
// 作业 ⇒ 回收再也不会被触发：**自锁**。
//
// 变异验证（实跑，见交付报告）：
//   - 把 StartReclaimLoop 的循环体改成空操作（或不启动 goroutine）⇒
//     TestStartReclaimLoopHealsOverLimitWithoutCompileJobs 红；
//   - 把启动轮的 force 去掉（走节流）⇒ 同一条红（New 把 lastReclaim 初始化成
//     "现在"，节流窗口内启动轮被静默跳过 ⇒ 重启也不自愈）；
//   - 去掉 ReclaimCache 的 reclaimMu ⇒ TestReclaimCacheTakesReclaimLock 红；
//   - 把 reclaimIfDue 的节流判定改成恒 true ⇒ TestReclaimPathsShareThrottle 红。

import (
	"context"
	"strings"
	"testing"
	"time"
)

// TestStartReclaimLoopHealsOverLimitWithoutCompileJobs：**现场形态的复现与修复判据**。
//
// 构造：缓存超上限 + **零编译作业**（Compiles 必须为 0 —— "只服务、不发布"的稳态）。
// 断言：
//  1. 启动周期循环后，缓存被降到两个阈值之内（不需要任何编译作业）；
//  2. 回收日志可 grep，且带**条数**与**释放字节**；
//  3. 全程没有编译作业（"没有作业"本身也是被断言的事实，不是假设）。
func TestStartReclaimLoopHealsOverLimitWithoutCompileJobs(t *testing.T) {
	child := buildCompileChildOnce(t)
	logger := &recordingLogger{}
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1000
		o.CacheMaxEntries = 100
		o.ReclaimInterval = time.Nanosecond
		o.Logger = logger
	})
	now := time.Now()
	for i := 0; i < 5; i++ {
		seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64",
			"stale-"+string(rune('a'+i)), 400, now.Add(-time.Duration(5-i)*time.Hour))
	}
	if bytes, _ := c.CacheUsage(); bytes <= 1000 {
		t.Fatalf("夹具没造出超限：%d 字节", bytes)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.StartReclaimLoop(ctx, 10*time.Millisecond)

	deadline := time.Now().Add(5 * time.Second)
	for {
		bytes, entries := c.CacheUsage()
		if bytes <= 1000 && entries <= 100 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("周期回收未把缓存降到阈值内：%d 字节 / %d 条（%s）",
				bytes, entries, logger.joined())
		}
		time.Sleep(5 * time.Millisecond)
	}

	logs := logger.joined()
	if !strings.Contains(logs, reclaimLogPrefix+"（启动）") {
		t.Errorf("启动轮必须有可 grep 的回收日志：%s", logs)
	}
	if !strings.Contains(logs, "删除") || !strings.Contains(logs, "释放") {
		t.Errorf("回收日志必须带条数与释放字节：%s", logs)
	}
	// "无任何编译作业"是本用例的前提，必须被断言（否则它退化成"编译顺带回收"的旧路径）。
	if st := c.Stats(); st.Compiles != 0 || st.Compiling {
		t.Fatalf("本用例不得产生编译作业：compiles=%d compiling=%v", st.Compiles, st.Compiling)
	}
}

// TestStartReclaimLoopStartupPassIsForced：启动轮必须**绕过节流**。
//
// 缺陷形态：New 把 lastReclaim 初始化成"现在"，若启动轮也走 reclaimIfDue，则前
// ReclaimInterval（缺省 30 s，而周期是 5 min）内的存量超限不会被处理 ——
// 表现正是"重启也不自愈"。
func TestStartReclaimLoopStartupPassIsForced(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1000
		o.CacheMaxEntries = 100
		// 远大于测试时长：只有"强制"的启动轮才可能动手。
		o.ReclaimInterval = time.Hour
	})
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "stale", 4096, time.Now().Add(-time.Hour))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c.StartReclaimLoop(ctx, time.Hour)

	deadline := time.Now().Add(5 * time.Second)
	for {
		bytes, _ := c.CacheUsage()
		if bytes <= 1000 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("启动轮被节流窗口挡住：存量超限（%d 字节）在第一个周期之前没有收敛"+
				"（现场形态=重启也不自愈）", bytes)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestStartReclaimLoopIsIdempotentAndStops：重复调用只启动一个循环；ctx 结束后**真的**停。
func TestStartReclaimLoopIsIdempotentAndStops(t *testing.T) {
	child := buildCompileChildOnce(t)
	logger := &recordingLogger{}
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1000
		o.CacheMaxEntries = 100
		o.ReclaimInterval = time.Nanosecond
		o.Logger = logger
	})
	ctx, cancel := context.WithCancel(context.Background())
	c.StartReclaimLoop(ctx, 5*time.Millisecond)
	c.StartReclaimLoop(ctx, 5*time.Millisecond) // 幂等：不得启动第二个循环
	cancel()

	// 等循环自己报告退出（有界）。
	deadline := time.Now().Add(5 * time.Second)
	for !strings.Contains(logger.joined(), "（周期循环）退出") {
		if time.Now().After(deadline) {
			t.Fatalf("ctx 结束后周期循环没有退出：%s", logger.joined())
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := strings.Count(logger.joined(), reclaimLogPrefix+"（启动）"); got != 1 {
		t.Fatalf("重复调用 StartReclaimLoop 不得启动第二个循环（启动轮日志 %d 条）：%s", got, logger.joined())
	}

	// 循环已停：再造超限条目，必须**留着**（这条是"真的停了"的判据，不是看日志）。
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "after-stop", 4096, time.Now())
	time.Sleep(100 * time.Millisecond)
	if bytes, _ := c.CacheUsage(); bytes <= 1000 {
		t.Fatal("ctx 结束后仍在回收：循环没有真的停")
	}
}

// TestReclaimCacheTakesReclaimLock：三个回收触发点必须**串行**（P0-a 的"同一把锁"）。
//
// 判据是确定性的：测试自己持有 reclaimMu，此时 ReclaimCache **必须**阻塞；把锁去掉
// （或改成别的锁）它会立刻返回 ⇒ 红。
func TestReclaimCacheTakesReclaimLock(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1
		o.CacheMaxEntries = 1
	})
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "stale", 4096, time.Now().Add(-time.Hour))

	c.reclaimMu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = c.ReclaimCache()
	}()
	select {
	case <-done:
		c.reclaimMu.Unlock()
		t.Fatal("ReclaimCache 没有持 reclaimMu：与周期回收/编译后回收并发时会同一条目删两次（日志计数失真、白扫目录）")
	case <-time.After(100 * time.Millisecond):
	}
	c.reclaimMu.Unlock()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("释放锁后 ReclaimCache 仍未返回")
	}
	if bytes, _ := c.CacheUsage(); bytes > 1 {
		t.Fatalf("回收没有生效：%d 字节", bytes)
	}
}

// TestReclaimPathsShareThrottle：编译后回收与周期回收共用**同一个** ReclaimInterval
// 节流窗口（否则周期轮次会把编译后的回收挤掉，或反之）。
func TestReclaimPathsShareThrottle(t *testing.T) {
	child := buildCompileChildOnce(t)
	c := newTestCompiler(t, child, func(o *Options) {
		o.CacheMaxBytes = 1000
		o.CacheMaxEntries = 100
		o.ReclaimInterval = time.Hour // 节流窗口远大于测试时长
	})
	// 第一次（强制）回收：动手。
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "a", 4096, time.Now().Add(-time.Hour))
	if removed, _, err := c.ReclaimCache(); err != nil || removed == 0 {
		t.Fatalf("强制回收应删掉超限条目：removed=%d err=%v", removed, err)
	}
	// 第二次（节流路径）：窗口内必须**什么都不做** —— 再造一条超限条目，它必须留着。
	seedCacheEntry(t, c.CacheDir(), "wazero-v1.12.0-linux-amd64", "b", 4096, time.Now())
	removed, _, err := c.reclaimIfDue()
	if err != nil {
		t.Fatalf("reclaimIfDue: %v", err)
	}
	if removed != 0 {
		t.Fatalf("节流窗口内不得回收：removed=%d", removed)
	}
	if bytes, _ := c.CacheUsage(); bytes <= 1000 {
		t.Fatalf("节流窗口内的条目被删了：%d 字节", bytes)
	}
}
