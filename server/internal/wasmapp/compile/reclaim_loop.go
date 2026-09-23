package compile

import (
	"context"
	"fmt"
	"time"
)

// 本文件是**周期回收循环**（2026-09-23 现场 P0-a 的修复）。
//
// 缺陷形态（生产实例实测）：`/readyz` 报 `编译缓存超上限：578263173 > 536870912`，
// 删掉缓存条目后立刻恢复；而**不删就永不恢复**。
//
// 根因（三条，缺一不可）：
//  1. **回收触发点与真正的写者不匹配**：磁盘编译缓存有两个写者 —— 发布/校验期的
//     编译子进程，以及**执行侧**（`internal/wasmapp/runtime` 的 wazero 磁盘缓存；
//     判据见 runtime/cache_mode_test.go 的 `wantDiskWrites: true`）。而 ReclaimCache
//     此前只挂在 runJob（编译作业之后）上 ⇒ "只服务、不发布"的时段里缓存只涨不降。
//  2. **发布闸门自锁**：缓存超限 ⇒ AllowPublish 拒绝发布/校验 ⇒ 不再产生编译作业
//     ⇒ 那条唯一的回收路径再也不会被触发。
//  3. 上限偏小（512 MiB / 单条产物 ≈17.8 MiB ⇒ ≈28 条），让第 1 条在真实部署里
//     很容易发生。
//
// 本文件修的是第 1 条（第 2 条由 readyz 的同步回收钩子修，第 3 条见交付报告的认账项）：
// 让回收**不依赖编译作业**，按固定周期跑。
//
// 为什么复用 reclaimMu 与 reclaimIfDue（而不是自己再写一份删除逻辑）：
//   - 唯一实现纪律：删除只有 cache.go 的 reclaimLocked 一份（§10.3 第 35 项）；
//   - 三个触发点（编译后 / 周期 / 发布闸门同步）共用一把锁 ⇒ 不会并发重复删除；
//   - 节流窗口共用 ⇒ 周期回收不会与"刚编译完的那次回收"重复劳动。

// reclaimLogPrefix 是回收日志的固定前缀（运维用 `grep 'compile: 缓存回收'` 定位）。
const reclaimLogPrefix = "compile: 缓存回收"

// DefaultReclaimLoopInterval 是周期回收的间隔（P0-a 的取值）。
//
// 为什么是 5 分钟：
//   - 它是"缓存水位收敛速度"与"目录全量 walk 开销"的折中（一次 walk ≈10 ms 量级，
//     5 分钟一次完全可忽略）；
//   - 比 ReclaimInterval（30 s 节流）大一个数量级 ⇒ 周期回收总是"到期"的，
//     不会把节流窗口占满而让编译后的回收路径失效；
//   - 现场（单条 Go 产物 ≈17.8 MiB、上限 512 MiB）即使以最坏速率增长，一个周期内
//     也不会把磁盘打满，而 `/readyz` 的告警窗口足够短。
const DefaultReclaimLoopInterval = 5 * time.Minute

// StartReclaimLoop 启动**不依赖编译作业**的周期回收循环（P0-a）。
//
// 契约：
//   - **启动即强制回收一次**（不看节流窗口）：部署启动时缓存可能已经超限，等一个
//     interval 会让发布面多 503 五分钟（现场就是"重启也不自愈"）；
//   - 之后每 interval 走一次**节流后的**回收（复用 ReclaimInterval 与同一把锁）；
//   - ctx 结束或 `Close()` 时退出；`Close()` 会等它收尾（避免与临时缓存目录的删除
//     竞争 —— 见 Close 的注释）；
//   - 失败只记日志：回收是维护动作，**绝不 panic、绝不阻塞**任何调用方（周期循环跑在
//     自己的 goroutine 里，编译/请求路径不会等它）。
//
// 幂等：重复调用只启动一个循环（第二次起是 no-op）。测试里若要"换一个 ctx 重启循环"，
// 需要新建 Compiler —— 这是刻意的：生命周期与 Compiler 同源，少一个可漂移的状态。
func (c *Compiler) StartReclaimLoop(ctx context.Context, interval time.Duration) {
	if c == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if interval <= 0 {
		interval = DefaultReclaimLoopInterval
	}
	c.loopOnce.Do(func() {
		c.loopStarted.Store(true)
		c.loopWG.Add(1)
		go func() {
			defer c.loopWG.Done()
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			// 启动即回收一次（强制）：部署启动时的存量超限必须在第一个周期之前收敛。
			c.reclaimOnce("启动", true)
			for {
				select {
				case <-ctx.Done():
					c.logger.Printf("%s（周期循环）退出：%v", reclaimLogPrefix, ctx.Err())
					return
				case <-c.stop:
					// Close() 已经开始了：不再回收（临时缓存目录马上要被删）。
					return
				case <-ticker.C:
					c.reclaimOnce("周期", false)
				}
			}
		}()
	})
}

// waitReclaimLoop 有界等待周期回收循环退出（Close 用）。
//
// 为什么要等待（而不是直接返回）：循环可能正在 scan/删除缓存目录，而 Close 紧接着要
// 删临时缓存目录（childCacheTemp）—— 不等就是"删树"与"删条目"并发（六轮审计 P3 同款
// 形态）。等待是**有界**的：回收是维护动作，不为它把关停拖过容器的优雅期。
func (c *Compiler) waitReclaimLoop(grace time.Duration) {
	done := make(chan struct{})
	go func() {
		c.loopWG.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(grace):
		c.logger.Printf("compile: 周期回收循环未在 %v 内退出（可能仍在扫描缓存目录）", grace)
	}
}

// reclaimOnce 执行一次回收并把结果写进日志（周期循环的唯一入口）。
//
// trigger 是"启动"/"周期"（只进日志，便于区分是首轮还是稳态轮次）；
// force=true 表示**绕过节流**（启动轮：New 把 lastReclaim 初始化成当前时间，走节流会
// 把启动轮静默跳过 —— 那正是"重启也不自愈"）。
//
// 日志口径（可 grep、含条数/字节/失败原因）：
//
//	compile: 缓存回收（启动）删除 3 条 / 释放 53477376 字节（当前 4096 字节 / 上限 536870912 字节、0 条 / 4096 条），用时 12ms
//	compile: 缓存回收（周期）失败：删除缓存条目 ab12… 失败: permission denied（本次删除 0 条 / 释放 0 字节）
//
// 每轮都打一行（含"什么都没删"的轮次）：这是运维判断"周期回收到底有没有在跑"的唯一
// 证据；5 分钟一行的量级可忽略。
func (c *Compiler) reclaimOnce(trigger string, force bool) {
	var removed int
	var freed int64
	var err error
	started := time.Now()
	if force {
		removed, freed, err = c.ReclaimCache()
	} else {
		removed, freed, err = c.reclaimIfDue()
	}
	took := time.Since(started)
	bytes, entries, uerr := c.cacheUsage()
	level := fmt.Sprintf("当前 %d 字节 / 上限 %d 字节、%d 条 / %d 条",
		bytes, c.opt.CacheMaxBytes, entries, c.opt.CacheMaxEntries)
	if uerr != nil {
		level = "当前水位不可读: " + uerr.Error()
	}
	if err != nil {
		// 失败也必须带"本轮删了几条/释放多少"与原因（否则排障只能看到一句"失败"）。
		c.logger.Printf("%s（%s）失败：%v（本次删除 %d 条 / 释放 %d 字节；%s）",
			reclaimLogPrefix, trigger, err, removed, freed, level)
		return
	}
	c.logger.Printf("%s（%s）删除 %d 条 / 释放 %d 字节（%s），用时 %v",
		reclaimLogPrefix, trigger, removed, freed, level, took)
}
