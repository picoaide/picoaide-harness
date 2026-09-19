package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/api"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// HostFuncs 是一次请求的宿主能力分发口（由 internal/wasmapp/hostcap 实现）。
//
// runtime 只负责**调度、计时与错误封装**：方法白名单、预算、recover 边界在这里；
// db/ai/assets/log 的具体语义不在这里（§4.4）。
type HostFuncs interface {
	// Dispatch 执行一次宿主调用。返回 *apperr.Error 表示这次调用失败（会作为
	// JSON-RPC error 回给应用，由应用决定怎么办）；宿主内部 panic 由 runtime 兜底。
	Dispatch(ctx context.Context, method string, params json.RawMessage) (any, *apperr.Error)
}

// Request 是一次应用请求的全部输入。
type Request struct {
	// Envelope 是宿主构造的请求帧（§7.1）。身份的唯一来源就是它（应用伪造不了）。
	Envelope abi.Request
	// Budgets 是本次请求的上限；零值全部回落到 limits（数值唯一真源）。
	Budgets InstanceLimits
	// Funcs 是宿主能力面；必填（缺了等于应用什么都调不了，属于装配错误）。
	Funcs HostFuncs
}

// Result 是一次应用请求的结论。
//
// 契约（与 §7.4「绝不把失败报成成功」同精神）：
//   - KillReason == nil ⇒ 一定拿到了合法的最终响应帧（Response 有效），调用方可以按 200 处理；
//   - KillReason != nil ⇒ 调用方必须按 KillReason.Status() 返回错误信封，**不得**看 Response；
//   - Serve 的第二个返回值只在"连跑都跑不起来"时非 nil（见 Serve 注释）。
type Result struct {
	Response   abi.Response
	Metrics    capapi.CallMetrics
	KillReason *apperr.Error
}

// OK 报告这次请求是否成功。
func (r *Result) OK() bool { return r != nil && r.KillReason == nil }

// postKillGrace 是"拿到结论后等 guest 真正退出"的宽限。
//
// ⚠️ 这不是资源上限（上限一律在 limits 包里），而是"别为了收尸把请求拖住"的调度参数：
// 正常应用写完响应帧就 proc_exit，实测在微秒级返回；赖着不走的应用只影响自己的收尾时间。
const postKillGrace = 250 * time.Millisecond

// Options 是运行时装配参数。
type Options struct {
	// DataRoot 是平台数据根；非空时编译缓存落在
	// <DataRoot>/<limits.CompileCacheDirName>/<limits.CompileCacheRevision>（带分代，见 CompileCacheDir）。
	// 与编译进程共用同一份磁盘缓存是"发布期编译暖到执行进程"的前提（§4.3.1）。
	DataRoot string
	// CompilationCache 可由调用方注入（与编译进程共享同一实例时）；nil 时按 DataRoot 新建，
	// DataRoot 也为空则退化为进程内内存缓存（仅测试/单机验证用）。
	CompilationCache wazero.CompilationCache
	// Logger 用于记录宿主 panic 等内部事件；nil ⇒ log.Default()。
	Logger *log.Logger
	// MemoryPages 是运行时的单实例线性内存页上限；0 ⇒ limits.InstanceMemoryPages。
	//
	// 为什么在构造期而不是每请求：wazero 把它放在 RuntimeConfig（§4.3.1-c 的逐请求
	// 清单不含它）⇒ 一个 Runtime 内的所有实例共享同一个上限。从 NewRuntimeConfig()
	// 起手再覆盖是允许的：该字段**不进编译缓存键**（§4.3.1-a 实测），因此不影响
	// 与编译进程共用磁盘缓存。
	MemoryPages uint32
	// OnModuleClose 是"实例即将关闭"的观察钩子（**测试专用**：生产路径永远为 nil，
	// 与 compile.Options.ChildArgs 同一口径）。
	//
	// 为什么需要一个钩子：R1-rt-18 的判据是"**等 guest 真正结束之后**才关闭实例"，而这件事
	// 从外部完全不可观测 —— 响应照旧成功、指标照旧一样，唯一的差别是关闭**时刻**与 guest
	// 当时是否还在跑。只靠 `-race` 抓数据竞争等于把判据押在时序运气上（实测单跑常常不触发）。
	// 钩子里的 GuestFinished 由 guest goroutine 自己的结束信号判定（不是复述调用点的说法），
	// 因此"没等就关"会被如实记成 false。
	OnModuleClose func(ModuleClose)
}

// ModuleClose 是一次"实例即将关闭"的事件（见 Options.OnModuleClose）。
type ModuleClose struct {
	// AppID 是本次请求的应用标识（观测用）。
	AppID string
	// GuestFinished 表示关闭那一刻 guest 的 `_start` 调用**确实**已经返回
	// （由 guest goroutine 关闭的信号通道判定，与调用点是否走过 settle 无关）。
	GuestFinished bool
}

// Runtime 是执行侧运行时：持有一个 wazero.Runtime（编译产物缓存 + WASI 宿主模块），
// 每个请求新建实例（§4.3「实例策略」：只缓存编译结果，禁止实例复用）。
type Runtime struct {
	rt     wazero.Runtime
	cache  wazero.CompilationCache
	ownCch bool // cache 是否由本运行时创建（决定 Close 时是否一并关闭）
	logger *log.Logger
	// memoryPages 是本运行时的线性内存上限（§4.3 R22），用于与请求侧期望值对拍。
	memoryPages uint32
	// onModuleClose 是 Options.OnModuleClose 的装配期快照（nil ⇒ 无观察者）。
	onModuleClose func(ModuleClose)
	seq           atomic.Uint64
}

// New 装配执行侧运行时。
func New(ctx context.Context, opts Options) (*Runtime, error) {
	cache := opts.CompilationCache
	own := false
	if cache == nil {
		if opts.DataRoot != "" {
			c, err := NewCompilationCache(opts.DataRoot)
			if err != nil {
				return nil, err
			}
			cache, own = c, true
		} else {
			cache = wazero.NewCompilationCache()
			own = true
		}
	}
	pages := opts.MemoryPages
	if pages == 0 {
		pages = limits.InstanceMemoryPages
	}
	rt := wazero.NewRuntimeWithConfig(ctx, NewRuntimeConfig().WithMemoryLimitPages(pages).WithCompilationCache(cache))
	// WASI preview1 的宿主实现（§4.3）。⚠️ 措辞更正（审计实测，2026-09-18）：preview1
	// **不是**"没有 socket"——它导出 sock_accept / sock_recv / sock_send / sock_shutdown，
	// 只是**没有** sock_open / sock_bind / sock_listen / sock_connect ⇒ **没有任何途径得到一个
	// socket fd**（`syscall.Socket` 在 wasip1 上不可用；`sock_accept(0..10)` / `sock_shutdown(3)`
	// 实测全 EBADF(8)）。再加上导入白名单只放行不造 fd 的两个 socket 符号、且拒绝任何非
	// wasi_snapshot_preview1 的模块，红线 4（应用不能出站）才成立。
	// Go 运行时自己会发出 sock_accept / sock_shutdown（经 text/template 的 Execute 可达，
	// 审计 P0-1）⇒ 白名单必须放行这两条，否则"渲染 HTML 页面"的合法应用会被拒。
	if _, err := wasi_snapshot_preview1.Instantiate(ctx, rt); err != nil {
		_ = rt.Close(ctx)
		if own {
			_ = cache.Close(ctx)
		}
		return nil, fmt.Errorf("runtime: 装配 WASI 宿主模块失败: %w", err)
	}
	logger := opts.Logger
	if logger == nil {
		logger = log.Default()
	}
	return &Runtime{rt: rt, cache: cache, ownCch: own, logger: logger, memoryPages: pages,
		onModuleClose: opts.OnModuleClose}, nil
}

// Close 关闭运行时与其自建的编译缓存。
func (r *Runtime) Close(ctx context.Context) error {
	err := r.rt.Close(ctx)
	if r.ownCch && r.cache != nil {
		if cerr := r.cache.Close(ctx); cerr != nil && err == nil {
			err = cerr
		}
	}
	return err
}

// MemoryLimitPages 返回本运行时**实际生效**的单实例线性内存页上限（只读）。
//
// 存在的意义（P0-2）：这个值是 wazero RuntimeConfig 的字段，装配之后再无第二处
// 可查 —— 而调用方若各自留一份"我以为传进去的值"，就会出现"账本写设置值、
// runtime 按档位跑"的分叉（旧实现的现场：控制台保存 32 MiB、重启也没生效，
// 界面却显示"无需重启"）。让访问器直接问运行时，比让调用方记住自己传了什么可靠。
func (r *Runtime) MemoryLimitPages() uint32 {
	if r == nil {
		return 0
	}
	return r.memoryPages
}

// CompileModule 是执行侧的编译入口（与编译进程共用 NewRuntimeConfig 的配置）。
//
// 它存在的意义是"同配置"这一条：执行进程若用别的配置编译，磁盘缓存就永远命中不了
// （§4.3.1-a）。生产路径上模块由编译进程预编译（60 s 预算 + 队列），本方法服务于
// 干跑与测试。
func (r *Runtime) CompileModule(ctx context.Context, bin []byte) (wazero.CompiledModule, error) {
	return r.rt.CompileModule(ctx, bin)
}

// ===== 一次请求：执行循环（§7）=====

// Serve 执行一次应用请求：新建实例 → 写请求帧 → 跑 _start → 帧循环 → 收尾。
//
// 返回值契约：
//   - (res, nil)：res 一定非 nil；成功与失败都从 res.KillReason 读（§7.4 每个码都在这条路径上映射）；
//   - (nil, err)：调用参数本身不成立（module/Funcs 为 nil）——装配错误，不是应用错误。
//
// 实现顺序逐条对应设计文档：
//
//	§4.3    每请求新建实例（禁止复用）；_start 显式调用
//	§7.1    请求帧写进 guest stdin；io.Pipe + 单写者，结束即 Close（不依赖阻塞语义）
//	§7.2    循环读 stdout：RPC → 回写应答；响应帧 → 结束；非 RS 起始 → 日志行
//	§7.3    两套预算：可暂停的 guest 时钟 + 宿主调用预算
//	§7.4    错误全表映射 + 硬断言（err=nil 但已关闭/无响应 ⇒ 绝不 200）
func (r *Runtime) Serve(ctx context.Context, module wazero.CompiledModule, req Request) (*Result, error) {
	if module == nil {
		return nil, errors.New("runtime: module 为 nil")
	}
	if req.Funcs == nil {
		return nil, errors.New("runtime: Request.Funcs 为 nil")
	}
	// 内存上限是 RuntimeConfig 项（不在逐请求的 ModuleConfig 清单里，§4.3.1-c）⇒
	// 请求侧只能声明"期望值"，与运行时不符即装配错误。fail-loud 而不是静默取其一：
	// 静默会让"以为每个应用被限制在 N 页"变成一个不成立的假设。
	if req.Budgets.MemoryPages != 0 && req.Budgets.MemoryPages != r.memoryPages {
		return nil, fmt.Errorf("runtime: Request.Budgets.MemoryPages=%d 与运行时上限 %d 不一致（该上限是 RuntimeConfig 项，须在 New 时指定）",
			req.Budgets.MemoryPages, r.memoryPages)
	}

	lim := req.Budgets
	guestBudget := lim.EffectiveGuestBudget()
	res := &Result{}
	res.Metrics.AppID = req.Envelope.AppID
	if req.Envelope.User != nil {
		res.Metrics.UserID = req.Envelope.User.ID
	}

	// guestCtx 贯穿实例一生（module 与实例化时的 ctx 绑定）：预算超时、外部取消、
	// 主动收尾都通过它传导，wazero 的 ctx 看门狗据此关闭 module（§4.3）。
	guestCtx, cancelGuest := context.WithCancelCause(ctx)
	defer cancelGuest(errModuleKilled)
	clock := newGuestClock(cancelGuest, guestBudget)
	defer clock.stop()

	// stdio：stdin/stdout 用 io.Pipe（宿主↔guest 双向流），stderr 用有界尾巴缓冲。
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	stderr := newTailBuffer(limits.StderrTailBytes)
	guest := &guestWriter{w: stdinW}

	// 收尾：不关管道的话，卡在 fd_read 里的 guest 会一直占着实例（§7.1 原话）。
	defer func() {
		cancelGuest(errModuleKilled)
		_ = stdinW.CloseWithError(io.EOF)
		_ = stdoutW.CloseWithError(io.ErrClosedPipe)
		_ = stdoutR.CloseWithError(io.ErrClosedPipe)
	}()

	// 看门狗：guestCtx 一旦结束（预算耗尽 / 外部取消），立刻解开两端的阻塞 I/O。
	//
	// 为什么必须有它：guest 可能正卡在 fd_read 上等宿主输入，而宿主正卡在 stdout 读上
	// —— 关闭 module 并**不会**打断阻塞在宿主函数（fd_read）里的那个 goroutine，
	// 只有关管道能。没有它，超时后双方互相等，请求永远不返回。
	watchdogDone := make(chan struct{})
	go func() {
		select {
		case <-guestCtx.Done():
			_ = stdinW.CloseWithError(io.EOF)
			_ = stdoutW.CloseWithError(io.ErrClosedPipe)
			_ = stdoutR.CloseWithError(io.ErrClosedPipe)
		case <-watchdogDone:
		}
	}()
	defer close(watchdogDone)

	// 实例名必须**每请求唯一**：wazero 的 store 按名字登记模块，同名会直接报
	// "module[x] has already been instantiated"，并发请求会互相踩（§4.3 每请求新实例）。
	mc := newModuleConfig(fmt.Sprintf("%s@%s#%d", appIDOr(req.Envelope.AppID), req.Envelope.Version, r.seq.Add(1)),
		stdinR, stdoutW, stderr)

	guestStart := time.Now()
	mod, err := r.rt.InstantiateModule(guestCtx, module, mc)
	if err != nil {
		res.KillReason = classifyInstantiateError(err, r.memoryPages)
		res.Metrics.StderrTail = stderr.Tail()
		fillFailureMetrics(&res.Metrics, res.KillReason)
		res.Metrics.CPUMs = msSince(guestStart)
		return res, nil
	}
	// guestFinished 在 guest 的 `_start` 调用**真正返回**（含 panic 被兜底）时关闭。
	//
	// 两条理由（R1-rt-18）：
	//  1. 它是"实例可以安全关闭"的地面真值：`rec` 据此判定关闭那一刻 guest 是否还在跑，
	//     供测试钩子断言（不复述调用点自己的说法，否则断言会退化成自证）；
	//  2. 关闭它发生在 `done <- callErr` **之前** ⇒ `settle` 收到 done 就等于它已关闭
	//     （happens-before），判定不会因调度抖动误报。
	guestFinished := make(chan struct{})
	// rec 记录"实例关闭"这一时刻（含测试钩子所需的事实：关闭时 guest 是否已结束）。
	// 只用 Serve 自己的 goroutine 读写，因此不需要锁。
	rec := &moduleCloseRecord{appID: appIDOr(req.Envelope.AppID), guestFinished: guestFinished}
	defer func() {
		// module 关闭放最后：它可能已经被超时路径关掉，重复关闭是幂等的。
		r.closeModule(mod, rec)
	}()

	startFn := mod.ExportedFunction("_start")
	if startFn == nil {
		// 导出面在发布期 validate 就该拦下（§4.2「必须含 _start 与 memory」）。
		res.KillReason = killError(apperr.CodeValidateFailed, "模块没有导出 _start")
		res.Metrics.StderrTail = stderr.Tail()
		fillFailureMetrics(&res.Metrics, res.KillReason)
		res.Metrics.CPUMs = msSince(guestStart)
		return res, nil
	}

	// §7.1：请求帧先写好（io.Pipe 的写会阻塞到对端读，故放 goroutine），再跑 _start。
	// 单写者保证：初始帧一定先于任何 RPC 应答（应用要先读到帧才可能发 RPC）。
	payload, merr := json.Marshal(req.Envelope)
	if merr != nil {
		return nil, fmt.Errorf("runtime: 请求帧序列化失败: %w", merr)
	}
	go func() {
		if werr := guest.writeFrame(guestCtx, payload); werr != nil {
			r.logf("请求帧写入失败 app=%s: %v", req.Envelope.AppID, werr)
		}
	}()

	done := make(chan error, 1)
	go func() {
		var callErr error
		func() {
			defer func() {
				// 兜底 recover：guest 线程（含 WASI 宿主函数）里的 panic **绝不能打死整个
				// 服务进程** —— §7.4 的归因底线是"一个应用的问题只影响它自己"。wazero 自己
				// 也用 closeWithExitCodeWithoutClosingResource 规避同类问题，说明"直接
				// Close 一个正在跑的实例"是误用（它的 ensureResourcesClosed 会把 m.Sys
				// 置 nil，而仍在执行的 WASI 调用正在读它 ⇒ 数据竞争 ⇒ nil 解引用）。
				if p := recover(); p != nil {
					r.logf("guest 执行 panic app=%s: %v", req.Envelope.AppID, p)
					callErr = fmt.Errorf("runtime: guest panic: %v", p)
				}
				// guest 结束后**立刻关掉 stdout 写端**：否则宿主的读端永远等不到 EOF
				// （写端在我们自己手里），"应用直接退出/崩溃、不写响应帧"的路径会一直卡到
				// 预算到点，把 RUNTIME_TRAP / RUNTIME_GUEST_EXIT 误报成 RUNTIME_TIMEOUT。
				_ = stdoutW.CloseWithError(io.EOF)
				close(guestFinished)
			}()
			_, callErr = startFn.Call(guestCtx)
		}()
		done <- callErr
	}()

	out := &loopOutcome{}
	r.pump(ctx, &req, lim, clock, guestCtx, guest, mod, stdoutR, out)

	// §7.2/§7.4：**收到合法最终响应帧 = 结论已定**（审计 P2-1 的裁定）。
	//
	// 为什么不能"等 guest 自己退出"：Go 在 wasip1 上的等待是**忙等循环**（见 instance.go 的
	// sysNanosleep 注释），应用写完响应帧后哪怕只做一点收尾，也可能拖过 guest 预算；那时
	// `clockExpired` 会把**已经拿到的答案**洗成 RUNTIME_TIMEOUT（审计实测：预算 1s、guest 写完
	// 响应帧后自旋 5s ⇒ 耗时 1.000s、code=RUNTIME_TIMEOUT、响应体被丢掉）。
	// §7.2 把响应信封定义为"应用的答案"，§7.4 的 RUNTIME_TIMEOUT 语义是"**没有答案**的预算耗尽"
	// ⇒ 丢掉已有的合法答案既增加延迟、又白占执行槽（§7.3 的端到端预算），还与"绝不把失败报成
	// 成功"的对偶（**也绝不把成功报成失败**）冲突。所以：立刻取消 guest 的预算、按该响应返回成功。
	//
	// ⚠️ R1-rt-18（P0，已实测数据竞争）：**取消预算 ≠ 可以立刻关闭实例**。旧实现在这里
	// `cancelGuest` 之后直接 `mod.Close`，而 guest goroutine 仍在跑 —— wazero 的
	// `ensureResourcesClosed` 会把 `m.Sys` 置 nil，正在执行的 WASI 调用（Go wasip1 的
	// nanosleep/time.Now 走 clock_time_get）读到 nil ⇒ 数据竞争 + nil 解引用 panic，而那个
	// goroutine 没有 recover ⇒ **整个服务端进程崩溃**（多租户同时中断）。现在按正常出口同一
	// 机制收尸：等 guest 真正结束（最多 postKillGrace），再关闭实例。
	//
	// 窗口预算的边界（语义不许退化）：宽限到点**不影响结论** —— 响应早就拿到了，照旧按成功
	// 返回；只是记一条日志说明"实例未在宽限内退出"（那是一个应用赖着不走的事实，不是请求失败）。
	//
	// 注意这只覆盖"**已经拿到结论**"这一条：没有响应帧的路径（预算耗尽 ⇒ RUNTIME_TIMEOUT、
	// 正常退出 ⇒ RUNTIME_NO_RESPONSE、非零退出 ⇒ RUNTIME_GUEST_EXIT、输出超限 ⇒
	// RUNTIME_OUTPUT_OVERRUN）全部照旧走下面的统一出口。
	if out.fatal == nil && out.response != nil {
		samplePeak(mod, &out.peak)
		cancelGuest(errModuleKilled)
		if _, settled := settle(done, guestCtx, postKillGrace); !settled {
			// 忽略 settle 的 error：结论已定（这个响应就是应用的答案），guest 怎么结束都不改判。
			r.logf("实例未在宽限内退出 app=%s（响应已拿到，按成功返回）", req.Envelope.AppID)
		}
		r.closeModule(mod, rec)
		recordLoopMetrics(&res.Metrics, out, stderr, guestStart)
		res.Response = *out.response
		res.Metrics.Outcome = capapi.OutcomeOK
		res.Metrics.ResponseSize = int64(len(out.response.Body))
		return res, nil
	}

	// 收尾：先让 guest 的读拿到 EOF（不依赖它自己会退出），再等它真正结束。
	_ = stdinW.CloseWithError(io.EOF)
	if out.fatal != nil {
		// 结论已经定了（循环里记下的致命错误），不需要等 guest 自己退：直接取消。
		// 走这条路的请求一定**没有**合法响应帧（拿到了就在上面的早退分支返回了）⇒
		// 我们主动取消不会被误记成成功。
		cancelGuest(errModuleKilled)
	}
	callErr, settled := settle(done, guestCtx, postKillGrace)
	if !settled {
		// 收尸超时：取消并关闭实例，结论照旧（缓冲区并发安全，晚到的写不会打穿任何东西）。
		cancelGuest(errModuleKilled)
		r.logf("guest 未在宽限内退出 app=%s（结论不受影响）", req.Envelope.AppID)
	}
	samplePeak(mod, &out.peak)

	// 结论优先级：循环里记下的致命错误 > guest 结束形态。
	f := failureContext{
		clockExpired:   clock.expired() || contextCauseIs(guestCtx, errGuestBudget),
		parentCanceled: ctx.Err() != nil,
		moduleClosed:   mod.IsClosed(),
		hasResponse:    out.response != nil,
		guestBudget:    guestBudget,
		// 生效的单实例上限（R1-rt-7 的文案同源）：错误里说的"多少 MiB"必须是真的。
		memoryPages: r.memoryPages,
	}
	fatal := out.fatal
	if fatal == nil {
		fatal = classifyGuestError(callErr, f)
		// §15.1 第 7 条硬断言：Call 返回 err=nil 但 module 已关闭 / 没有响应帧时
		// 绝不返回 200 —— classifyGuestError 已按此实现，这里再补一道兜底。
		if fatal == nil && f.moduleClosed && !f.hasResponse {
			fatal = killError(apperr.CodeModuleKilled, "实例已关闭且没有响应帧（已按被杀处理）")
		}
	}

	recordLoopMetrics(&res.Metrics, out, stderr, guestStart)
	if fatal != nil {
		res.KillReason = fatal
		fillFailureMetrics(&res.Metrics, fatal)
		return res, nil
	}
	res.Response = *out.response
	res.Metrics.Outcome = capapi.OutcomeOK
	res.Metrics.ResponseSize = int64(len(out.response.Body))
	return res, nil
}

// loopOutcome 是帧循环的中间结论。
type loopOutcome struct {
	// response 非 nil 表示收到了合法的最终响应帧。
	response *abi.Response
	// fatal 非 nil 表示循环期间发生了请求级失败（绝不能被后续响应帧"洗白"）。
	fatal *apperr.Error
	// peak 是采样到的线性内存峰值（字节）。
	peak int64
	// logs 是被判定为日志的 stdout 行数（§7.2「stdout 净化」统计）。
	logs int
	// hostCalls / hostCallMS 是宿主调用次数与累计耗时（§4.9）。
	hostCalls  int64
	hostCallMS int64
}

// pump 是 §7.2 的帧循环：
//
//	RPC 帧       → 调宿主能力 → 把 JSON-RPC 应答写回 guest stdin → 继续
//	响应帧       → 结束循环
//	非 RS 起始   → 按日志行读到换行、计入 StdoutLogs → 继续
//	超单行/总量  → RUNTIME_OUTPUT_OVERRUN
//
// 循环里的失败一律记进 out.fatal 并立即结束（不做"再试一次"）：失败语义只有一条出口。
func (r *Runtime) pump(ctx context.Context, req *Request, lim InstanceLimits, clock *guestClock,
	guestCtx context.Context, guest *guestWriter, mod api.Module, stdoutR io.Reader, out *loopOutcome) {

	// 计数包在 bufio **里面**：读预取也算"应用写出来的输出"（宁可多算，不可少算）。
	counter := &countingReader{r: stdoutR}
	reader := bufio.NewReaderSize(counter, 64<<10)

	for {
		// §4.6「协议帧单行上限 1 MiB」+ §7.4「单行/总输出超限 ⇒ RUNTIME_OUTPUT_OVERRUN」。
		// 总量上限取响应体上限（数值唯一真源在 limits，未在别处硬编码）。
		if counter.n > limits.AppResponseBodyMaxBytes {
			out.fatal = killError(apperr.CodeRuntimeOutputOverrun,
				fmt.Sprintf("应用输出超过总上限 %s", fmtBytes(limits.AppResponseBodyMaxBytes)))
			return
		}

		payload, err := abi.ReadFrame(reader)
		switch {
		case errors.Is(err, abi.ErrNotFrame):
			line, tooLong, lerr := readLogLine(reader, limits.ProtocolLineMaxBytes)
			if tooLong {
				out.fatal = killError(apperr.CodeRuntimeOutputOverrun,
					fmt.Sprintf("stdout 单行超过 %s 且不是协议帧", fmtBytes(limits.ProtocolLineMaxBytes)))
				return
			}
			if len(line) > 0 {
				out.logs++
			}
			samplePeak(mod, &out.peak)
			if lerr != nil {
				// EOF / 管道关闭：交给统一出口（由 guest 的结束形态决定结论）。
				return
			}
			continue

		case errors.Is(err, abi.ErrFrameTooLarge):
			out.fatal = killError(apperr.CodeRuntimeOutputOverrun,
				fmt.Sprintf("协议帧超过单帧上限 %s", fmtBytes(abi.MaxFrameBytes)))
			return

		case err != nil:
			// io.EOF（guest 关闭 stdout / 已退出）、管道被关闭、帧被截断…
			// 全部走统一出口：由 guest 的结束形态映射错误码（§7.4）。
			return
		}

		samplePeak(mod, &out.peak)

		switch abi.Classify(payload) {
		case abi.FrameResponse:
			resp := &abi.Response{}
			if uerr := json.Unmarshal(payload, resp); uerr != nil {
				out.fatal = killError(apperr.CodeRuntimeNoResponse, "响应帧不是合法 JSON").WithCause(uerr)
				return
			}
			out.response = resp
			return

		case abi.FrameRPC:
			if fatal := r.handleRPC(ctx, req, lim, clock, guestCtx, guest, mod, payload, out); fatal != nil {
				out.fatal = fatal
				return
			}

		default:
			// RS 开头但既不是 RPC 也不是响应：协议违规。§7.2 只有两类帧，
			// 这种"帧形状的垃圾"不能当日志吞掉（会掩盖应用 bug）。
			out.fatal = killError(apperr.CodeRuntimeNoResponse, "协议帧既不是 JSON-RPC 请求也不是响应信封")
			return
		}
	}
}

// handleRPC 处理一条应用发来的 JSON-RPC 请求。
//
// 返回非 nil 表示请求级失败（致命）；返回 nil 表示已把应答写回 guest 或无需应答。
// 能力自身的错误（DB_DENIED / AUTH_REQUIRED / AI_RATE_LIMITED…）是**非致命**的：
// 它们是应用可见的业务错误，由应用决定怎么办（§4.4）。
func (r *Runtime) handleRPC(ctx context.Context, req *Request, lim InstanceLimits, clock *guestClock,
	guestCtx context.Context, guest *guestWriter, mod api.Module, payload []byte, out *loopOutcome) *apperr.Error {

	var rpc abi.RPCRequest
	if err := json.Unmarshal(payload, &rpc); err != nil {
		// 连 id 都取不到 ⇒ 用 null id 回一条错误，继续循环（应用可能自己恢复）。
		return r.writeRPC(ctx, guest, abi.NewRPCError(nil, string(apperr.CodeValidation), "RPC 请求解析失败"))
	}
	if !hostMethodAllowed(rpc.Method) {
		// 封闭清单校验（§5.1/§5.5）：这一层就挡掉清单外的方法名，不依赖能力实现的
		// 默认分支（纵深防御）。
		return r.writeRPC(ctx, guest, abi.NewRPCError(rpc.ID, string(apperr.CodeNotFound),
			"未知的宿主方法: "+rpc.Method))
	}

	budget := lim.HostBudget(rpc.Method)

	// §7.3：进入宿主调用 ⇒ **暂停 guest 计时**（否则 ai.chat 的 30 s 会被 10 s 的
	// guest 预算误杀）；宿主调用用自己的预算 ctx（父 ctx 仍是请求 ctx，客户端断开
	// 时能及时中止）。
	clock.pause()
	start := time.Now()
	hostCtx, cancelHost := context.WithTimeout(ctx, budget)
	result, aerr := r.callHost(hostCtx, req.Funcs, rpc.Method, rpc.Params)
	hostCtxErr := hostCtx.Err()
	cancelHost()
	clock.resume()
	out.hostCalls++
	out.hostCallMS += time.Since(start).Milliseconds()

	// 强制复检（§4.4 / §15.1 第 6 条）：宿主函数可能**根本没理会** ctx，
	// 于是"预算"在它身上完全失效、且会返回 err=nil（实测）⇒ 以 ctx 的真实状态为准，
	// 把"被杀"翻译成失败，绝不让它变成成功。
	switch {
	case ctx.Err() != nil:
		return killError(apperr.CodeModuleKilled, "请求已取消（宿主调用期间）")
	case errors.Is(hostCtxErr, context.DeadlineExceeded):
		return killError(apperr.CodeHostCallOverBudget,
			fmt.Sprintf("宿主调用 %s 超过预算 %s", rpc.Method, budget))
	}

	// 复检 guest 侧状态：宿主调用期间 guest 可能已被关闭（外部取消 / 预算看门狗）。
	// 这里不直接下结论：交给统一出口按 guest 结束形态映射（timeout / MODULE_KILLED）。
	if guestCtx.Err() != nil || mod.IsClosed() {
		return nil
	}

	resp := abi.NewRPCResult(rpc.ID, result)
	if aerr != nil {
		resp = abi.RPCResponse{JSONRPC: "2.0", ID: normalizeID(rpc.ID), Error: rpcErrorBody(aerr)}
	}
	if werr := r.writeRPC(ctx, guest, resp); werr != nil {
		if guestCtx.Err() != nil || mod.IsClosed() {
			return nil
		}
		return werr
	}
	return nil
}

// rpcErrorBody 把平台错误转成 JSON-RPC 的错误对象（§7.2：code 用平台错误码字符串，
// 不走 JSON-RPC 数字码，避免两套语义）。
func rpcErrorBody(e *apperr.Error) *abi.RPCErrorBody {
	if e == nil {
		return nil
	}
	return &abi.RPCErrorBody{Code: string(e.Code), Message: e.Message, Details: e.Details}
}

// writeRPC 把一个 JSON-RPC 应答写回 guest stdin（同一帧格式，§7.2）。
func (r *Runtime) writeRPC(ctx context.Context, guest *guestWriter, resp abi.RPCResponse) *apperr.Error {
	b, err := json.Marshal(resp)
	if err != nil {
		return apperr.New(apperr.CodeInternal, "宿主应答序列化失败").WithCause(err)
	}
	if werr := guest.writeFrame(ctx, b); werr != nil {
		return apperr.New(apperr.CodeModuleKilled, "写入应用 stdin 失败").WithCause(werr)
	}
	return nil
}

// callHost 是宿主调用的一道**硬边界**：
//
//   - 预算硬闸：Dispatch 在独立 goroutine 里跑，主流程 select 预算 ctx。宿主函数遵守
//     ctx 时它自己会返回；**不遵守 ctx 时这是唯一的出路**（§10.3 第 26 项）。
//     被放弃的 goroutine 最多多跑一会儿，结果写进带缓冲的 chan（容量 1）后即可回收，
//     不会泄漏 goroutine。
//   - panic 边界（§4.4 兜底）：wazero 会 recover 宿主 panic，但那是实现细节不是契约。
//     panic 转成 INTERNAL 错误回给应用（非致命：应用可以选择重试或降级），
//     **细节只进宿主日志**（panic 文本可能带内部信息，不能回给应用）。
func (r *Runtime) callHost(ctx context.Context, funcs HostFuncs, method string, params json.RawMessage) (any, *apperr.Error) {
	type outcome struct {
		result any
		err    *apperr.Error
	}
	ch := make(chan outcome, 1)
	go func() {
		defer func() {
			if p := recover(); p != nil {
				r.logf("宿主能力 panic method=%s panic=%v", method, p)
				ch <- outcome{err: apperr.New(apperr.CodeInternal, "宿主能力内部错误（已隔离）")}
			}
		}()
		result, aerr := funcs.Dispatch(ctx, method, params)
		ch <- outcome{result: result, err: aerr}
	}()
	select {
	case o := <-ch:
		return o.result, o.err
	case <-ctx.Done():
		return nil, apperr.New(apperr.CodeHostCallOverBudget, "宿主调用超过预算（未在预算内返回）")
	}
}

// hostMethodAllowed 判定方法是否在封闭清单内（§5.1）。
//
// 例外只有一个：`abi.ping` —— 它是**不属于能力面**的协议内建探针（validate 干跑用，
// abi.ProbeMethods / abi.IsProbeMethod）。发布期的能力清单一致性门禁比的是
// abi.HostMethods（ping 不在其中），两件事不要混。
func hostMethodAllowed(method string) bool {
	if abi.IsProbeMethod(method) {
		return true
	}
	for _, m := range abi.HostMethods {
		if m == method {
			return true
		}
	}
	return false
}

// moduleCloseRecord 是"实例关闭"这一步的现场记录（每次 Serve 一个，只在 Serve 的
// goroutine 里读写 ⇒ 不需要锁）。
type moduleCloseRecord struct {
	appID string
	// guestFinished 由 guest goroutine 在 `_start` 真正返回时关闭（地面真值）。
	guestFinished <-chan struct{}
	// fired 保证测试钩子每次请求最多上报一次（defer 里的兜底关闭是幂等的第二道）。
	fired bool
}

// closeModule 关闭实例，并在关闭**之前**把"guest 是否已经结束"上报给观察钩子。
//
// 关闭本身是幂等的（wazero：已关闭时直接返回 nil），所以早退分支显式关闭之后，
// defer 里的兜底关闭仍可以安全再调一次。
func (r *Runtime) closeModule(mod api.Module, rec *moduleCloseRecord) {
	if rec == nil {
		_ = mod.Close(context.Background())
		return
	}
	if !rec.fired && r.onModuleClose != nil {
		rec.fired = true
		ev := ModuleClose{AppID: rec.appID}
		select {
		case <-rec.guestFinished:
			ev.GuestFinished = true
		default:
		}
		r.onModuleClose(ev)
	}
	_ = mod.Close(context.Background())
}

// settle 等 guest 结束：返回 (Call 的错误, 是否等到了)。
//
// 等待是**有界**的：guestCtx 已被取消（超时/外部取消）时最多再等 grace 就放弃收尸。
// 放弃是安全的——stderr 尾巴是并发安全的、管道已经关掉，晚到的写不会打穿任何东西。
func settle(done <-chan error, guestCtx context.Context, grace time.Duration) (error, bool) {
	select {
	case err := <-done:
		return err, true
	default:
	}
	select {
	case err := <-done:
		return err, true
	case <-guestCtx.Done():
		select {
		case err := <-done:
			return err, true
		case <-time.After(grace):
			return nil, false
		}
	}
}

// readLogLine 读到换行（§7.2：非 RS 起始的输出一律视为日志），并强制单行上限。
//
// 不用 bufio.Scanner：它有自己的一套上限语义，且不能表达"超限 ⇒ RUNTIME_OUTPUT_OVERRUN"
// （§4.6 要的是报错，不是静默截断）。
func readLogLine(r *bufio.Reader, max int) (line []byte, tooLong bool, err error) {
	var acc []byte
	for {
		chunk, rerr := r.ReadSlice('\n')
		acc = append(acc, chunk...)
		if len(acc) > max {
			return nil, true, nil
		}
		if rerr == nil {
			return acc, false, nil
		}
		if errors.Is(rerr, bufio.ErrBufferFull) {
			continue
		}
		return acc, false, rerr
	}
}

// countingReader 统计从 guest stdout 读出的总字节数（RUNTIME_OUTPUT_OVERRUN 的总量判据）。
type countingReader struct {
	r io.Reader
	n int
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += n
	return n, err
}

// samplePeak 采样线性内存峰值（§4.9 PeakMemory：用 wazero 的内存大小估算）。
//
// 采样点在"从 stdout 读到一段数据之后"：io.Pipe 的读与 guest 的写之间有互斥锁
// （happens-before 边），而 guest 的内存增长在它自己那条执行流上先于写发生
// ⇒ 这个读写序保证我们看到的 Size() 不会与 guest 的 grow 构成数据竞争。
func samplePeak(mod api.Module, peak *int64) {
	m := mod.Memory()
	if m == nil {
		return
	}
	if s := int64(m.Size()); s > *peak {
		*peak = s
	}
}

// guestWriter 是宿主 → guest 的单写者（§7.1：io.Pipe + 单写者）。
//
// 写可能阻塞（无缓冲管道要等对端读），因此每次都带上界等待：超时就主动让对端的读
// 拿到 EOF，把可能卡死的写解开 —— **不得依赖阻塞语义**。
type guestWriter struct {
	mu sync.Mutex
	w  *io.PipeWriter
}

func (g *guestWriter) writeFrame(ctx context.Context, payload []byte) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	done := make(chan error, 1)
	go func() { done <- abi.WriteFrame(g.w, payload) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = g.w.CloseWithError(io.EOF)
		return ctx.Err()
	}
}

// tailBuffer 是 stderr 的有界尾巴（§4.9：保留末尾 limits.StderrTailBytes 字节进诊断）。
//
// 并发安全：guest 在独立 goroutine 里写，宿主在结论处读；收尾宽限用尽后 guest 仍可能
// 在写（我们不阻塞等它），所以必须有锁，且 Write 永不失败。
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newTailBuffer(max int) *tailBuffer { return &tailBuffer{max: max} }

func (b *tailBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = append(b.buf[:0], b.buf[len(b.buf)-b.max:]...)
	}
	return len(p), nil
}

// Tail 返回当前尾巴（stderr 的末尾 max 字节）。
func (b *tailBuffer) Tail() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return string(b.buf)
}

func appIDOr(id string) string {
	if id == "" {
		return "app"
	}
	return id
}

func normalizeID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

// recordLoopMetrics 把帧循环的计量写进结果（§4.9）。
//
// 成功与失败两条出口共用**同一份**实现：两处各写一遍迟早会漂移（例如早退分支漏掉
// CPUMs 扣减、或失败分支漏掉 StdoutLogs），而计量字段是审计面的输入。
func recordLoopMetrics(m *capapi.CallMetrics, out *loopOutcome, stderr *tailBuffer, guestStart time.Time) {
	m.StderrTail = stderr.Tail()
	m.StdoutLogs = out.logs
	m.PeakMemory = out.peak
	m.HostCalls = out.hostCalls
	m.HostCallMS = out.hostCallMS
	// CPUMs 是 guest 自己的时间：扣掉宿主调用（那部分已单独计量）。
	m.CPUMs = msSince(guestStart) - out.hostCallMS
	if m.CPUMs < 0 {
		m.CPUMs = 0
	}
}

// fillFailureMetrics 把失败码写进调用事件字段（§4.9 outcome / reason_code / guest_exit_code）。
func fillFailureMetrics(m *capapi.CallMetrics, e *apperr.Error) {
	if e == nil {
		return
	}
	m.ReasonCode = string(e.Code)
	m.Outcome = outcomeFor(e.Code)
	if code, ok := e.Details["guest_exit_code"]; ok {
		if v, ok := code.(uint32); ok {
			m.GuestExitCode = int32(v)
		}
	}
}

// outcomeFor 把错误码映射到 §4.9 的 outcome 列：
// "killed" = 运行时主动终止了 guest；其余失败是 "error"。
func outcomeFor(code apperr.Code) string {
	switch code {
	case apperr.CodeRuntimeTimeout, apperr.CodeModuleKilled, apperr.CodeRuntimeTrap,
		apperr.CodeRuntimeMemory, apperr.CodeRuntimeOutputOverrun, apperr.CodeRuntimeGuestExit:
		return capapi.OutcomeKilled
	default:
		return capapi.OutcomeError
	}
}

func msSince(t time.Time) int64 { return time.Since(t).Milliseconds() }

func (r *Runtime) logf(format string, args ...any) {
	if r.logger != nil {
		r.logger.Printf(format, args...)
	}
}
