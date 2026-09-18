package events

import (
	"context"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// DefaultCleanupInterval 是调用事件保留期清理的检查间隔（1 小时）。
//
// 为什么是**实现参数**而不是 §4 的上限数值：它是"多久检查一次"，不改变任何语义
// （7 天保留 = limits.CallEventRetentionDays，由 Cleanup 自己算 cutoff）。
// 选 1 小时的理由：一天 24 次 DELETE 对 PG 是噪声级，而最坏多留 1 小时数据相对
// 7 天保留可忽略。
const DefaultCleanupInterval = time.Hour

// Cleaner 是保留期清理动作（生产 = *Sink，测试可注入计数桩）。
//
// 抽成接口而不是直接依赖 *Sink：调度器要测的是"**周期性、可停止、计数进日志**"，
// 与 SQL 无关；而 Cleanup 的 SQL/边界由 events_test.go 用真 PG 钉住。
type Cleaner interface {
	Cleanup(ctx context.Context, now time.Time) (int64, error)
}

// 生产装配的编译期断言：*Sink 必须满足 Cleaner。
var _ Cleaner = (*Sink)(nil)

// CleanupSchedulerOptions 是调度器可调项（零值 = 全部取缺省，生产不应传非零值）。
type CleanupSchedulerOptions struct {
	// Tick 是检查间隔（缺省 DefaultCleanupInterval）。测试注入短间隔。
	Tick time.Duration
	// Now 可注入时钟（清理 cutoff 由它推导；测试断言"注入的 now 真的被用上"）。
	Now func() time.Time
	// Logger 是清理结果日志出口（缺省 log.Printf）。
	//
	// **必须**把删除计数写进这一行：§4.9「丢最旧并计数」的计数此前没有任何出口
	// （审计 P2-7），而"删了多少行"是判断保留期是否真的在跑的唯一直接证据。
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

// CleanupScheduler 周期调用 Cleaner.Cleanup，让 `wasm_call_events` 的 7 天保留
// 真正生效（§4.9 / §5.3）。
//
// 为什么必须有这个调度器：`Cleanup` 的 SQL 与 cutoff 都是对的，但在本调度器出现
// 之前**没有任何生产调用方**（`grep -rn "\.Cleanup(" internal/ cmd/` 零命中）——
// 于是每请求一行的事件表成了平台唯一的**无界磁盘增长路径**（审计 P1-2：
// ~8.6 万行/天/应用，多应用线性叠加）。
//
// 生命周期：随 ctx 取消退出（与 reports/balance 的既有调度器同款），Close 可显式停止。
type CleanupScheduler struct {
	cleaner Cleaner
	opt     CleanupSchedulerOptions

	started atomic.Bool
	runs    atomic.Int64
	deleted atomic.Int64
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
	// 启动即清一次：停机期间攒下的过期行不该等到下一个整点，也让"调度真的在跑"
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

// runOnce 执行一轮清理并记账/记日志。
//
// 用**父 ctx** 而不是自造 ctx：进程退出时这一轮 DELETE 被取消是安全的
// （DELETE 幂等，下次启动的"启动即清一次"会补上），换来的是关停不必等待一轮 DB 操作。
func (s *CleanupScheduler) runOnce(ctx context.Context) {
	n, err := s.cleaner.Cleanup(ctx, s.opt.Now().UTC())
	s.runs.Add(1)
	if err != nil {
		s.errs.Add(1)
		s.opt.Logger("wasm: 调用事件保留期清理失败（%d 天保留暂未生效，下一轮重试）: %v",
			limits.CallEventRetentionDays, err)
		return
	}
	s.deleted.Add(n)
	s.opt.Logger("wasm: 调用事件保留期清理完成 deleted=%d retention_days=%d",
		n, limits.CallEventRetentionDays)
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

// Runs 返回已执行的清理轮数（观测/测试口径）。
func (s *CleanupScheduler) Runs() int64 {
	if s == nil {
		return 0
	}
	return s.runs.Load()
}

// Deleted 返回累计删除的行数（观测口径；与日志同源）。
func (s *CleanupScheduler) Deleted() int64 {
	if s == nil {
		return 0
	}
	return s.deleted.Load()
}

// Errors 返回失败轮数（DB 故障期间"保留期没在生效"必须可观测）。
func (s *CleanupScheduler) Errors() int64 {
	if s == nil {
		return 0
	}
	return s.errs.Load()
}
