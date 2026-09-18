// Package queue 实现 WASM 应用平台的**请求准入与排队**（设计基线 §4.6）。
//
// 全部上限（每应用并发 1 / 队列 32 / 每用户每应用占槽 4 / 每用户全局在跑 4 /
// 全局实例 32 / 端到端墙钟 60 s）都来自 limits 包，本包不引入新数值。
//
// 语义（§4.6 + §10.3 第 32–34 项）：
//   - **每应用并发恒为 1**：同一应用同一时刻只有一个请求在跑；
//   - **每应用队列 32**：超出直接 429 + Retry-After（不排队等待，避免无界内存）；
//   - **每用户在**同一应用**内**：同时最多 1 个在跑、队列中最多 4 个
//     ⇒ 防单用户占满该应用队列；
//   - **每用户全局在跑 4**（跨应用聚合）：防止单用户开 20 个应用占满全局 32 槽；
//   - **全局在跑 32**：跨应用耗尽保护；
//   - **端到端墙钟 60 s（含排队等待）**：到点即拒 —— 由调用方传入带 deadline 的 ctx
//     实现（本包在等待期间只观察 ctx，不自己造 deadline，以免与请求级 deadline 打架）。
//
// 公平性与 HO-L 阻塞：释放槽位时按 **FIFO 顺序扫描**等待队列并授权所有"当前可运行"的
// 请求，跳过那些会突破"每用户全局在跑"上限的请求（它们留在队列里，不丢、不报错）。
// 如果改为"队首不能跑就整队等待"，单个占了 4 个全局槽的用户会把整个应用卡死。
package queue

import (
	"context"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// Options 是调度器上限（零值字段用 limits 缺省填充）。
type Options struct {
	// GlobalRunning 是全局并发实例上限（§4.6）。
	GlobalRunning int
	// PerAppRunning 是每应用并发（§4.6：恒为 1）。
	PerAppRunning int
	// PerAppQueue 是每应用队列长度（§4.6：32）。
	PerAppQueue int
	// PerUserPerAppRunning 是单用户在同一应用内同时运行数（§4.6：1）。
	PerUserPerAppRunning int
	// PerUserPerAppQueued 是单用户在同一应用队列中的占位上限（§4.6：4）。
	PerUserPerAppQueued int
	// PerUserGlobalRunning 是单用户跨应用全局在跑上限（§4.6：4）。
	PerUserGlobalRunning int
}

// DefaultOptions 返回与 limits 包一致的缺省上限。
func DefaultOptions() Options {
	return Options{
		GlobalRunning:        limits.GlobalInstances,
		PerAppRunning:        limits.AppRuntimeConcurrency,
		PerAppQueue:          limits.AppQueueDepth,
		PerUserPerAppRunning: limits.UserPerAppRunning,
		PerUserPerAppQueued:  limits.UserPerAppQueued,
		PerUserGlobalRunning: limits.UserGlobalRunning,
	}
}

func (o Options) withDefaults() Options {
	d := DefaultOptions()
	if o.GlobalRunning <= 0 {
		o.GlobalRunning = d.GlobalRunning
	}
	if o.PerAppRunning <= 0 {
		o.PerAppRunning = d.PerAppRunning
	}
	if o.PerAppQueue <= 0 {
		o.PerAppQueue = d.PerAppQueue
	}
	if o.PerUserPerAppRunning <= 0 {
		o.PerUserPerAppRunning = d.PerUserPerAppRunning
	}
	if o.PerUserPerAppQueued <= 0 {
		o.PerUserPerAppQueued = d.PerUserPerAppQueued
	}
	if o.PerUserGlobalRunning <= 0 {
		o.PerUserGlobalRunning = d.PerUserGlobalRunning
	}
	return o
}

// Stats 是队列水位（§4.9 /readyz 与 /api/pico/... 观测面用）。
type Stats struct {
	// GlobalRunning 是当前全局在跑数。
	GlobalRunning int `json:"global_running"`
	// Waiting 是当前全部等待者数量。
	Waiting int `json:"waiting"`
	// Apps 是有等待者的应用数。
	Apps int `json:"apps"`
	// TrackedApps 是 app 状态表的条目数（= 在跑或有等待者的应用数；空闲条目会被回收）。
	//
	// 为什么要暴露它：准入成本只应与"活跃应用数"成正比，而**历史上出现过的应用数**
	// 曾经是成本的分母（审计 P2-3：20000 个空闲应用时单次 Acquire+Release 516–811 µs，
	// 且全程持全局锁）。这个字段让"表有没有被回收"在运维面上可验证。
	TrackedApps int `json:"apps_tracked"`
}

// Scheduler 是应用请求调度器（进程内存态；单实例部署 R20）。
type Scheduler struct {
	opt Options

	mu            sync.Mutex
	apps          map[string]*appState
	active        map[string]struct{}
	userRunning   map[int64]int
	globalRunning int
	waiting       int
	// pumpScans 是 pumpAllLocked 累计遍历的应用条目数（**性能回归口径**：
	// 遍历成本必须与"活跃应用数"成正比，而不是与历史上出现过的应用数成正比）。
	pumpScans int64
}

type appState struct {
	running int
	// runningUser 是在跑请求的发起者（PerAppRunning 恒为 1 ⇒ 单个值即可）。
	runningUser int64
	waiters     []*waiter
	userQueued  map[int64]int
}

type waiter struct {
	userID int64
	ch     chan struct{}
	// granted 由授权方置位（在 s.mu 保护下），等待方据 ch 关闭 + granted 判定。
	granted bool
}

// New 创建调度器。
func New(opt Options) *Scheduler {
	return &Scheduler{
		opt:         opt.withDefaults(),
		apps:        map[string]*appState{},
		active:      map[string]struct{}{},
		userRunning: map[int64]int{},
	}
}

// Ticket 是一次已获准运行的请求凭证（必须 Release；重复 Release 安全）。
type Ticket struct {
	appID  string
	userID int64
	once   sync.Once
	sched  *Scheduler
	// EnqueuedMS 是本次请求在队列中等待的毫秒数（§4.9 queue_wait_ms 字段）。
	EnqueuedMS int64
}

// Release 归还槽位并唤醒可运行的等待者。
func (t *Ticket) Release() {
	if t == nil || t.sched == nil {
		return
	}
	t.once.Do(func() { t.sched.release(t.appID, t.userID) })
}

// AppID 返回该凭证对应的应用（诊断用）。
func (t *Ticket) AppID() string { return t.appID }

// Acquire 申请一个运行槽位。语义见包注释。
//
// 失败时返回：
//   - APP_QUEUE_FULL(429)：该应用队列已满，或该用户在本应用的占位已达上限；
//   - APP_QUEUE_FULL(429, details.reason=wall_clock_exceeded)：ctx 在排队期间到期
//     （端到端墙钟 60 s 到点即拒，§4.6）。
//
// userID 传 0 表示匿名（匿名不参与"每用户在跑"计数，但仍受全局与每应用上限约束；
// 匿名另有全局/每 IP 令牌桶，见 §4.6 与 internal/wasmapp/anonlimit）。
func (s *Scheduler) Acquire(ctx context.Context, appID string, userID int64) (*Ticket, *apperr.Error) {
	start := time.Now()
	s.mu.Lock()

	// 快路径：无需排队直接授权。
	if s.canRunLocked(appID, userID) {
		s.grantLocked(appID, userID)
		s.mu.Unlock()
		return &Ticket{appID: appID, userID: userID, sched: s}, nil
	}

	// 队列容量检查（应用级 + 用户级占位）。
	as := s.appLocked(appID)
	if len(as.waiters) >= s.opt.PerAppQueue {
		s.dropIfIdleLocked(appID, as) // 满了说明这个应用不空；但别把"纯新建的空条目"留下
		s.mu.Unlock()
		return nil, apperr.New(apperr.CodeAppQueueFull, "应用队列已满").
			WithDetail("queue_depth", s.opt.PerAppQueue).
			WithHint("稍后重试；该应用同时只处理 1 个请求")
	}
	if userID != 0 && as.userQueued[userID] >= s.opt.PerUserPerAppQueued {
		s.dropIfIdleLocked(appID, as)
		s.mu.Unlock()
		return nil, apperr.New(apperr.CodeAppQueueFull, "你在该应用排队中的请求过多").
			WithDetail("per_user_queued", s.opt.PerUserPerAppQueued).
			WithHint("同一应用内同时最多 1 个请求在跑、4 个排队")
	}

	w := &waiter{userID: userID, ch: make(chan struct{})}
	as.waiters = append(as.waiters, w)
	if userID != 0 {
		as.userQueued[userID]++
	}
	s.active[appID] = struct{}{} // 有等待者 ⇒ 进入活跃集合（pumpAllLocked 只遍历它）
	s.waiting++
	s.mu.Unlock()

	select {
	case <-w.ch:
		// 已被授权（granted 在锁内置位后才关闭 ch，见 grantLocked）。
		return &Ticket{appID: appID, userID: userID, sched: s, EnqueuedMS: time.Since(start).Milliseconds()}, nil
	case <-ctx.Done():
		s.mu.Lock()
		if w.granted {
			// 竞态：等待期间被并发授权 ⇒ 立刻归还槽位，仍按超时返回。
			s.mu.Unlock()
			t := &Ticket{appID: appID, userID: userID, sched: s, EnqueuedMS: time.Since(start).Milliseconds()}
			t.Release()
		} else {
			s.removeWaiterLocked(appID, w)
			s.mu.Unlock()
		}
		return nil, apperr.New(apperr.CodeAppQueueFull, "请求超时（含排队等待超过端到端墙钟）").
			WithDetail("reason", "wall_clock_exceeded").
			WithDetail("wall_clock_ms", limits.RequestWallClock.Milliseconds()).
			WithHint("应用当前繁忙，请稍后重试")
	}
}

// canRunLocked 判定某请求此刻能否直接运行（调用方必须持锁）。
func (s *Scheduler) canRunLocked(appID string, userID int64) bool {
	if s.globalRunning >= s.opt.GlobalRunning {
		return false
	}
	as := s.appLocked(appID)
	if as.running >= s.opt.PerAppRunning {
		return false
	}
	if userID != 0 {
		if s.userRunning[userID] >= s.opt.PerUserGlobalRunning {
			return false
		}
		if as.userRunningOf(userID) >= s.opt.PerUserPerAppRunning {
			return false
		}
	}
	return true
}

// appRunningOf 统计某用户在该应用内正在运行的请求数。
// 由于 PerAppRunning 恒为 1，这里最多为 1；保留该函数是为了在
// PerAppRunning 被调大时仍然正确。
func (as *appState) userRunningOf(userID int64) int {
	if as.runningUser == userID {
		return as.running
	}
	return 0
}

// grantLocked 记账一次授权（调用方必须持锁）。
func (s *Scheduler) grantLocked(appID string, userID int64) {
	as := s.appLocked(appID)
	as.running++
	as.runningUser = userID
	s.globalRunning++
	if userID != 0 {
		s.userRunning[userID]++
	}
	s.active[appID] = struct{}{} // 在跑 ⇒ 活跃（唤醒时要能被遍历到）
}

// release 归还槽位并唤醒可运行者。
func (s *Scheduler) release(appID string, userID int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	as := s.appLocked(appID)
	if as.running > 0 {
		as.running--
	}
	if as.running == 0 {
		as.runningUser = 0
	}
	if s.globalRunning > 0 {
		s.globalRunning--
	}
	if userID != 0 {
		if s.userRunning[userID] > 1 {
			s.userRunning[userID]--
		} else {
			delete(s.userRunning, userID)
		}
	}
	// 关键：释放的可能是一个**全局**槽位（全局实例 32 / 每用户全局在跑 4），
	// 而等待者排在其他应用的队列里 ⇒ 必须跨应用唤醒，否则会出现
	// "用户在自己占满 4 个全局槽后，其第 5 个应用的排队请求永远不会被唤醒"。
	s.pumpAllLocked()
	// 唤醒之后再回收本应用的条目：此时它既没在跑也没等待者 ⇒ 不需要留在表里
	// （审计 P2-3：条目只增不减会让"历史应用数"变成每次准入的固定成本）。
	s.dropIfIdleLocked(appID, as)
}

// pumpAllLocked 遍历**活跃**应用（在跑或有等待者）并授权。
//
// 为什么只遍历活跃集合（审计 P2-3）：此前遍历整个 `s.apps`，而它的条目只增不减
// ⇒ 每次 Release 的成本与"历史上出现过的应用数"成正比（20000 应用时单次
// Acquire+Release 516–811 µs，且全程持全局锁 = 全平台准入吞吐的天花板）。
// 现在成本只与活跃应用数成正比（全局在跑 ≤32、等待者所属应用数有界）。
//
// 跨应用顺序不保证公平（Go map 迭代顺序随机）：这是有意的 —— 每应用并发恒为 1
// ⇒ 单个应用最多只占 1 个全局槽，不存在某个应用长期霸占全局槽的饿死路径；
// 而**应用内**的 FIFO 顺序由 pumpAppLocked 保证（§4.6 未要求跨应用公平）。
func (s *Scheduler) pumpAllLocked() {
	for appID := range s.active {
		s.pumpScans++ // 性能回归口径：只统计真的被遍历到的活跃条目
		as, ok := s.apps[appID]
		if !ok || len(as.waiters) == 0 {
			continue
		}
		s.pumpAppLocked(appID, as)
	}
}

// pumpAppLocked 按 FIFO 顺序授权某应用中所有当前可运行者
// （跳过会突破上限的，保留在队列中，不丢不报错）。
func (s *Scheduler) pumpAppLocked(appID string, as *appState) {
	for as.running < s.opt.PerAppRunning {
		idx := -1
		for i, w := range as.waiters {
			if w.granted {
				continue
			}
			if s.globalRunning >= s.opt.GlobalRunning {
				return
			}
			if w.userID != 0 {
				if s.userRunning[w.userID] >= s.opt.PerUserGlobalRunning {
					continue // 跳过（不阻塞后面的请求）
				}
				if as.userRunningOf(w.userID) >= s.opt.PerUserPerAppRunning {
					continue
				}
			}
			idx = i
			break
		}
		if idx < 0 {
			return
		}
		w := as.waiters[idx]
		// 从等待列表移除 + 记账。
		as.waiters = append(as.waiters[:idx], as.waiters[idx+1:]...)
		if w.userID != 0 {
			if as.userQueued[w.userID] > 1 {
				as.userQueued[w.userID]--
			} else {
				delete(as.userQueued, w.userID)
			}
		}
		s.waiting--
		w.granted = true
		s.grantLocked(appID, w.userID)
		close(w.ch)
	}
}

// removeWaiterLocked 把仍在队列中的等待者摘除并归还其占位计数。
// 调用方必须持锁，且必须先确认 w.granted == false。
func (s *Scheduler) removeWaiterLocked(appID string, w *waiter) {
	as := s.appLocked(appID)
	for i, x := range as.waiters {
		if x == w {
			as.waiters = append(as.waiters[:i], as.waiters[i+1:]...)
			if w.userID != 0 {
				if as.userQueued[w.userID] > 1 {
					as.userQueued[w.userID]--
				} else {
					delete(as.userQueued, w.userID)
				}
			}
			s.waiting--
			s.dropIfIdleLocked(appID, as)
			return
		}
	}
}

// dropIfIdleLocked 回收"既没在跑也没有等待者"的应用条目（调用方必须持锁）。
//
// 这张表以前只增不减：应用被删、长期没请求都不会回收，于是每次 Release 的全表遍历
// 成本随历史应用数线性增长（审计 P2-3）。条目本身不是资源泄漏（一个空
// appState 只有几十字节），但它是**准入吞吐的分母**，所以必须与"活跃"同义。
//
// 不变量（由 TestIdleAppsAreReclaimed 断言）：任何对外操作返回后，
// `s.apps` 里的每个条目都在 `s.active` 里（在跑或有等待者）。
func (s *Scheduler) dropIfIdleLocked(appID string, as *appState) {
	if as == nil || as.running > 0 || len(as.waiters) > 0 {
		return
	}
	delete(s.apps, appID)
	delete(s.active, appID)
}

func (s *Scheduler) appLocked(appID string) *appState {
	as, ok := s.apps[appID]
	if !ok {
		as = &appState{userQueued: map[int64]int{}}
		s.apps[appID] = as
	}
	return as
}

// Stats 返回全局水位。
func (s *Scheduler) Stats() Stats {
	s.mu.Lock()
	defer s.mu.Unlock()
	// 只遍历活跃集合（有界）：Stats 会被 /readyz 反复调用，不能退回全表扫描。
	n := 0
	for appID := range s.active {
		if as, ok := s.apps[appID]; ok && len(as.waiters) > 0 {
			n++
		}
	}
	return Stats{GlobalRunning: s.globalRunning, Waiting: s.waiting, Apps: n, TrackedApps: len(s.apps)}
}

// PumpScans 返回 pumpAllLocked 累计遍历的应用条目数（**性能回归口径**）。
//
// 存在的意义：性能判据用"遍历次数"而不是绝对耗时（机器差异会让绝对阈值假红）。
// 判据是"单次 Acquire+Release 的遍历次数不随历史应用数增长"。
func (s *Scheduler) PumpScans() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pumpScans
}

// AppStats 返回某应用的水位（诊断用）。
func (s *Scheduler) AppStats(appID string) (running, waiting int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if as, ok := s.apps[appID]; ok {
		return as.running, len(as.waiters)
	}
	return 0, 0
}

// Options 返回本调度器生效的上限（测试与文档断言用）。
func (s *Scheduler) Options() Options { return s.opt }
