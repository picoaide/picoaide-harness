package upload

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// DefaultCleanupInterval 是过期上传会话的回收检查间隔（TTL 的 1/6 = 5 分钟）。
//
// 为什么是**实现参数**而不是 §4 的上限数值：它只决定"多久检查一次"，不改变语义
// （有效期 = limits.UploadSessionTTL，由 Cleanup 自己算）。取 TTL 的 1/6 的理由：
// 最坏多留 5 分钟磁盘（此时该会话早已不可用），而检查本身只是一次目录扫描。
const DefaultCleanupInterval = limits.UploadSessionTTL / 6

// Cleaner 是过期会话的回收动作（生产 = *Store，测试可注入计数桩）。
//
// 抽成接口而不是直接依赖 *Store：调度器要测的是"周期性、可停止、计数进日志"，
// 与文件系统无关；而 Cleanup 自己的边界（哪些目录该删/不该删）由 upload_test.go
// 用真文件系统钉住。
type Cleaner interface {
	Cleanup(ctx context.Context, now time.Time) (int, error)
}

// 生产装配的编译期断言：*Store 必须满足 Cleaner。
var _ Cleaner = (*Store)(nil)

// CleanupSchedulerOptions 是调度器可调项（零值 = 全部取缺省，生产不应传非零值）。
type CleanupSchedulerOptions struct {
	// Tick 是检查间隔（缺省 DefaultCleanupInterval）。测试注入短间隔。
	Tick time.Duration
	// Now 可注入时钟（过期 cutoff 由它推导；测试断言"注入的 now 真的被用上"）。
	Now func() time.Time
	// Logger 是回收结果日志出口（缺省 log.Printf）。
	//
	// **必须**把删除计数写进这一行：会话目录是分片上传唯一的磁盘驻留，"回收了几个"
	// 是判断 30 分钟有效期真的在跑的唯一直接证据（与 events.CleanupScheduler 同口径）。
	Logger func(format string, args ...any)
}

func (o CleanupSchedulerOptions) withDefaults() CleanupSchedulerOptions {
	if o.Tick <= 0 {
		o.Tick = DefaultCleanupInterval
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Logger == nil {
		o.Logger = log.Printf
	}
	return o
}

// CleanupScheduler 周期回收过期上传会话（§4.2 的 30 分钟有效期）。
//
// 为什么必须有它：会话目录是**平台新增的一处磁盘驻留**，而"过期会话只能靠恰好有人
// 用同一个 upload_id 才被惰性回收"意味着——一个断线的客户端留下的 32 MiB 会永久
// 占盘（没人会再去碰那个 id）。这与 events.Cleanup 的坑（有实现、零生产调用方）
// 是同一类问题，所以调度器与 Cleanup 一起交付，接线由 cmd/server 完成。
//
// 生命周期：随 ctx 取消退出，Close 可显式停止。
type CleanupScheduler struct {
	cleaner Cleaner
	opt     CleanupSchedulerOptions

	started atomic.Bool
	runs    atomic.Int64
	removed atomic.Int64
	errs    atomic.Int64

	stopped  chan struct{}
	stopOnce sync.Once
	done     chan struct{}
}

// NewCleanupScheduler 构造调度器。cleaner 为 nil 时 Start 不做事（装配缺失不该 panic）。
func NewCleanupScheduler(cleaner Cleaner, opt CleanupSchedulerOptions) *CleanupScheduler {
	return &CleanupScheduler{
		cleaner: cleaner,
		opt:     opt.withDefaults(),
		stopped: make(chan struct{}),
		done:    make(chan struct{}),
	}
}

// Start 启动后台调度（可重复调用，只有第一次生效；Close 之后调用是 no-op）。
func (s *CleanupScheduler) Start(ctx context.Context) {
	if s == nil || ctx == nil || s.cleaner == nil {
		return
	}
	select {
	case <-s.stopped:
		return // 已 Close：不再起新的轮次
	default:
	}
	if !s.started.CompareAndSwap(false, true) {
		return
	}
	go s.loop(ctx)
}

func (s *CleanupScheduler) loop(ctx context.Context) {
	defer close(s.done)
	t := time.NewTicker(s.opt.Tick)
	defer t.Stop()
	// 启动即清一次：停机期间攒下的过期会话不该等到下一个整点，也让"调度真的在跑"
	// 有一个即时的、可断言的证据（不必等一个真实周期）。
	s.runOnce(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stopped:
			return
		case <-t.C:
			s.runOnce(ctx)
		}
	}
}

// runOnce 执行一轮回收并记账/记日志。
//
// 用**父 ctx** 而不是自造 ctx：进程退出时这一轮删除被取消是安全的（删除幂等，
// 下次启动的"启动即清一次"会补上），换来的是关停不必等待一轮文件系统操作。
func (s *CleanupScheduler) runOnce(ctx context.Context) {
	n, err := s.cleaner.Cleanup(ctx, s.opt.Now().UTC())
	s.runs.Add(1)
	if err != nil {
		s.errs.Add(1)
		s.opt.Logger("wasm: 过期上传会话回收失败（%s 有效期暂未生效，下一轮重试）: %v",
			limits.UploadSessionTTL, err)
		return
	}
	s.removed.Add(int64(n))
	s.opt.Logger("wasm: 过期上传会话回收完成 removed=%d ttl=%s", n, limits.UploadSessionTTL)
}

// Close 停止调度并等待在飞的一轮收尾（幂等；未 Start 时是 no-op）。
func (s *CleanupScheduler) Close() {
	if s == nil {
		return
	}
	s.stopOnce.Do(func() { close(s.stopped) })
	if s.started.Load() {
		<-s.done
	}
}

// Runs 返回已执行的回收轮数（观测/测试口径）。
func (s *CleanupScheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	return s.runs.Load()
}

// Running 报告调度器是否处于"已启动且未停止"状态（只读观测；不改变任何行为）。
//
// 为什么需要它（审计 P1-1 / FIX-47）：**"构造了但没 Start"与"Start 了"在装配期完全同形**
// （都是一个非 nil 指针，未 Start 的 Close 还是 no-op），于是"调度器建好了但零调用点"
// 这种半接线只能靠肉眼读代码发现 —— 而它的后果是静默的（断线客户端的会话目录永久占盘）。
// 有了它，cmd/server 的装配级用例可以直接问出这两个状态。
//
// 判据是三件事都成立：cleaner 存在（nil cleaner 的 Start 直接返回、不算启动）、
// Start 真的跑过、且还没被 Close。
func (s *CleanupScheduler) Running() bool {
	if s == nil || s.cleaner == nil || !s.started.Load() {
		return false
	}
	select {
	case <-s.stopped:
		return false // 已 Close：轮次已经停了
	default:
		return true
	}
}

// Removed 返回累计回收的会话数（观测口径；与日志同源）。
func (s *CleanupScheduler) Removed() int64 {
	if s == nil {
		return 0
	}
	return s.removed.Load()
}

// Errors 返回失败轮数（目录不可读期间"有效期没在生效"必须可观测）。
func (s *CleanupScheduler) Errors() int64 {
	if s == nil {
		return 0
	}
	return s.errs.Load()
}
