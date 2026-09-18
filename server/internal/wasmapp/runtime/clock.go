package runtime

import (
	"context"
	"errors"
	"sync"
	"time"
)

// errGuestBudget 是 guest 预算耗尽的取消原因（§7.3）。
//
// 用 CancelCause 而不是 Deadline 的理由：guest 的 deadline 是**可暂停**的
// （进入宿主调用时暂停计时），而 wazero 的 WithCloseOnContextDone 只认
// "这个 ctx 被取消/超时"，不关心截止时间是怎么算出来的 ⇒ 一个普通的
// cancelable ctx + 自己维护的预算时钟，比反复重建 WithDeadline ctx 更贴合语义
// （重建 ctx 也不行：module 是与**实例化时那个 ctx** 绑定的）。
var errGuestBudget = errors.New("runtime: guest 预算耗尽")

// errModuleKilled 是"外部取消"的取消原因（§7.4 的 MODULE_KILLED）。
var errModuleKilled = errors.New("runtime: 请求已取消")

// guestClock 是**可暂停**的 guest 执行预算（§7.3）。
//
// 语义（设计原文）：
//
//	进入 guest → guest 预算 10 s
//	  调宿主函数 → 【暂停 guest 计时】+ 宿主预算
//	  宿主返回   → 恢复 guest 计时
//
// 实现要点：
//   - 只有一个 ctx（guestCtx）贯穿整个实例生命周期（wazero 的 module 与实例化
//     时的 ctx 绑定），"暂停"= 停表 + 记账，"恢复"= 用剩余预算重新起表；
//   - 用一个**代次**（gen）让"暂停瞬间正好在触发的定时器回调"失效：暂停会
//     gen++，回调发现代次不符就直接返回 —— 这是"暂停与超时竞争"的唯一正确解法
//     （单纯 Stop() 不能阻止已经在跑的回调）；
//   - 超时通过 cancelGuest(errGuestBudget) 传导：wazero 的 ctx 看门狗会关闭 module，
//     紧循环在 loop 头部的终止检查里观察到关闭并退出（实测死循环 10.001 s 退出）。
type guestClock struct {
	mu     sync.Mutex
	cancel context.CancelCauseFunc

	remain time.Duration // 剩余预算
	last   time.Time     // 上次开始计时的时刻（!paused 时有效）
	paused bool
	gen    uint64
	timer  *time.Timer
	done   bool
}

func newGuestClock(cancel context.CancelCauseFunc, budget time.Duration) *guestClock {
	c := &guestClock{cancel: cancel, remain: budget, last: time.Now()}
	c.mu.Lock()
	defer c.mu.Unlock()
	if budget > 0 {
		c.armLocked()
	} else {
		// budget<=0 不应出现（InstanceLimits.EffectiveGuestBudget 保证 > 0）；
		// 真出现就按"立即耗尽"处理，绝不退化成"无限制"。
		c.done = true
		c.cancel(errGuestBudget)
	}
	return c
}

func (c *guestClock) armLocked() {
	gen := c.gen
	c.timer = time.AfterFunc(c.remain, func() { c.fire(gen) })
}

// fire 是定时器回调：只有代次没变、且没有处于暂停态时才真的取消。
func (c *guestClock) fire(gen uint64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.done || c.paused || gen != c.gen {
		return
	}
	c.done = true
	c.timer = nil
	c.cancel(errGuestBudget)
}

// pause 暂停 guest 计时（进入宿主调用前调用，必须与 resume 成对）。
func (c *guestClock) pause() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.paused || c.done {
		return
	}
	c.gen++ // 让正在触发的回调失效
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
	c.remain -= time.Since(c.last)
	c.paused = true
}

// resume 恢复 guest 计时（宿主调用返回后调用）。
func (c *guestClock) resume() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.paused || c.done {
		return
	}
	c.paused = false
	c.last = time.Now()
	if c.remain <= 0 {
		c.done = true
		c.cancel(errGuestBudget)
		return
	}
	c.armLocked()
}

// stop 永久停表（请求结束）。
func (c *guestClock) stop() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.done = true
	if c.timer != nil {
		c.timer.Stop()
		c.timer = nil
	}
}

// expired 报告预算是否已经耗尽。
func (c *guestClock) expired() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.done
}
