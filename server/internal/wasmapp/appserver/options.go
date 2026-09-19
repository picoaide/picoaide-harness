package appserver

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/aichat"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
)

// Options 是应用子域请求管线的装配参数。
//
// 除 AIBaseURL 外（见下）全部字段由 main.go 注入：本包**不自己读部署配置**
// （除 PICOAI_TRUSTED_PROXIES，见 clientip.go 的说明），也不自己建 DB 连接。
type Options struct {
	// DB 是平台 PostgreSQL 连接（应用反查、生效版本、会话/票务都走它）。必填。
	DB *sql.DB
	// DataRoot 是平台数据根：应用库在 <DataRoot>/apps/<app_id>/app.db，
	// 抽取的资源在 <DataRoot>/apps/<app_id>/assets/<release_id>/，
	// 编译缓存在 <DataRoot>/_compile-cache（§4.3/§4.5/§4.2）。必填。
	DataRoot string
	// BaseDomain 是应用基域（`<app_id>.<BaseDomain>`），也是主站主机名
	// （换票端点 `https://<BaseDomain>/app-ticket`）。可带 scheme 前缀
	// （`http://127.0.0.1:8080`，用于明文部署/本地开发）；不带 scheme 时按
	// https 处理 —— 与 session 包同口径（§4.7「必须拼 https」）。
	//
	// 为空 = 未启用应用子域：此时 RequiresLogin 的应用**无法**换票，本包按
	// 500 处理（配置错误不静默，见 §6.1 与 R25 的取舍说明）。
	//
	// **是函数而不是字符串**（2026-09-18）：基域可由管理端在运行期修改，
	// 服务端每处使用都必须读当前值（换票地址、日志、准入判定）。
	BaseDomain func() string
	// Sessions 是会话与票务管理器（模块 G）。必填：
	// 身份帧的唯一来源、`?ticket=` 兑换的唯一实现都在它里面。
	Sessions *session.Manager
	// Limiter 是匿名限流器（R35）。nil ⇒ 用 anonlimit.DefaultOptions() 新建。
	Limiter *anonlimit.Limiter
	// Scheduler 是请求排队/准入调度器（§4.6）。nil ⇒ 用 queue.DefaultOptions() 新建。
	Scheduler *queue.Scheduler
	// Events 是调用事件出口（§4.9）。nil ⇒ 只记日志（诊断数据不进库）。
	Events *events.Sink
	// Compiler 可选：只用于读编译缓存（本包断言它与执行侧**共用同一个缓存目录**，
	// §4.3.1-a：不一致会让"发布期编译暖不到执行进程"这条前提静默失效）。
	Compiler *compile.Compiler
	// MemoryProfile 是本部署声明的内存档位（可选；零值 ⇒ memprofile.Default()）。
	//
	// 它不只是记账口径：队列的全局并发、执行侧实例内存上限、进程内模块缓存上限、
	// 应用库句柄上限**全部**取自它 —— 声明与执行同一份数（见 memprofile 包注释）。
	MemoryProfile memprofile.Profile
	// Limits 是**当前生效**的平台限制项（可选；零值 ⇒ 按 MemoryProfile 折算，与历史行为一致）。
	//
	// ⚠️ 自 2026-09-19（P0-2）起 MemoryProfile 降级为**默认值来源**：真正生效的数值
	// 是这一份（控制台设置 > 部署档位 > 编译期默认，解析在 cmd/server 的 wasmLimitsHolder）。
	//
	// 为什么必须由装配方注入：单实例内存上限是 wazero RuntimeConfig 的字段，runtime
	// 建好之后**不可变** —— 装配期若只认部署档位，控制台保存的值就永远只是一个
	// "待重启"标记：重启后仍是档位值，而 restart_pending 又被清空（界面显示"无需重启"），
	// 于是"自检算的账"与"实际跑的账"分叉。同一份数值还驱动队列并发、模块缓存与库句柄
	// 上限，因此必须一次注入齐（否则又会出现"界面按设置显示、实际按档位跑"）。
	Limits applimits.Limits
	// AppIDExtraReserved 是部署期注入的企业既有主机名（§4.1）：
	// 本包用它做**纵深防御** —— 即使库里存在同名应用行，也不给这些主机名提供内容。
	AppIDExtraReserved []string
	// Now 注入时钟（测试用）；nil = time.Now。
	Now func() time.Time
	// Logger 是内部事件出口（配置/装配/编译/DB 故障的"大声"记录）；nil = log.Printf。
	// ⚠️ 它只用于**平台侧**诊断，绝不把内部错误原文回给应用或浏览器（§8）。
	Logger func(format string, args ...any)

	// AIBaseURL 是服务端自身的地址（宿主用它直调本地 `/v1`，§4.7 / D3.1）。
	//
	// ⚠️ 这是任务书给定字段表之外**追加**的一项，原因是装配必需：
	// 共享的 aichat.Client 必须知道打哪个地址，而 Options 里没有别的地方能表达它。
	// 留空 ⇒ ai.chat 一律 fail-closed 返回 INTERNAL（绝不静默降级），
	// 并在启动日志里"大声"记一条 —— 部署漏配不会变成"应用以为能调 AI"。
	AIBaseURL string
}

// Server 是应用子域请求管线（实现 edge.AppHandler）。
//
// 生命周期：New → （并发处理请求）→ Close。请求路径上除 `modules` 的模块缓存与
// 调度/限流器的内存态之外**不保留任何跨请求状态**（会话在 PG，实例每请求新建）。
type Server struct {
	opt    Options
	logger func(format string, args ...any)
	now    func() time.Time

	// rt 是执行侧运行时（模块 C）：进程内唯一，编译产物缓存与实例化都经它。
	rt *runtime.Runtime
	// modules 是 CompiledModule 的进程内缓存（见 modules.go 的淘汰策略与上限）。
	modules *moduleCache
	// appdbs 是应用库句柄池（§4.5：一应用一 driver 实例 + 一应用一连接，跨应用不复用；
	// 淘汰策略与上限见 dbpool.go）。
	appdbs *appDBPool
	// releases 是 `(app_id, release_id)` 级的资源/配置缓存（R1-rt-2/3，见 releasecache.go）。
	// 它有界、可逐出，并在下架/冻结/删除/逐出与换版本时失效。
	releases *releaseCache

	scheduler *queue.Scheduler
	limiter   *anonlimit.Limiter
	// ai 是共享的 ai.chat 客户端（按 (用户, 会话) 缓存在手令牌，§4.7）。
	ai capapi.AI

	// trustedProxies 是可信前置代理（PICOAI_TRUSTED_PROXIES）：
	// 只有来自它们的 X-Forwarded-For 才被采信（见 clientip.go）。
	trustedProxies []netip.Prefix

	// guestBudget 是 guest 执行预算的测试注入点（0 = limits.GuestBudget）。
	// 生产路径不得设置它：数值唯一真源在 limits（§4.6）。
	guestBudget time.Duration
	// drainTimeout 是关闭前排空等待的测试注入点（0 = shutdownDrainTimeout）。
	drainTimeout time.Duration

	// profile 是本部署声明的内存档位（memprofile）：数值同时驱动队列并发、
	// 实例内存上限、模块缓存上限与应用库句柄上限。
	profile memprofile.Profile
	// limits 是**当前生效**的限制项（控制台保存后由 ApplyLimits 更新；
	// 零值 ⇒ 按 profile 折算，见 CurrentLimits）。
	limits applimits.Limits
	// runtimePages 是执行侧 runtime 实际生效的单实例内存页上限。
	// 它只在装配时写一次：wazero 的 WithMemoryLimitPages 属于 RuntimeConfig，
	// runtime 建好后不可变 ⇒ 控制台改这一项要重启（ApplyLimits 会如实标注）。
	runtimePages uint32
	// reclaim 是限频的"归还内存给 OS"执行器（见 reclaim.go）。
	reclaim *reclaimer

	// ===== 关闭期排空（见 Close 的注释：wazero 的 Runtime 不能在编译/实例化中途被关闭）=====
	mu        sync.Mutex
	closing   bool
	inflight  int
	drained   chan struct{}
	closeOnce sync.Once
	closeErr  error

	// sweeperStop 停止后台空闲回收循环（Close 时关闭一次；见 sweepLoop）。
	sweeperStop chan struct{}
	sweeperOnce sync.Once
}

// 编译期断言：本包就是 edge 的应用处理器。
var _ edge.AppHandler = (*Server)(nil)

// New 装配请求管线。配置缺项一律 fail-loud（不静默降级）。
func New(opt Options) (*Server, error) {
	if opt.DB == nil {
		return nil, errors.New("appserver: Options.DB 必填（应用反查与生效版本都依赖平台库）")
	}
	if strings.TrimSpace(opt.DataRoot) == "" {
		return nil, errors.New("appserver: Options.DataRoot 必填（应用库/资源/编译缓存都在它下面）")
	}
	if opt.Sessions == nil {
		return nil, errors.New("appserver: Options.Sessions 必填（换票与身份解析的唯一来源）")
	}

	logger := opt.Logger
	if logger == nil {
		logger = log.Printf
	}
	now := opt.Now
	if now == nil {
		now = time.Now
	}
	s := &Server{opt: opt, logger: logger, now: now, drained: make(chan struct{})}

	// 内存档位：零值 ⇒ 默认档（与历史行为一致）。
	prof := opt.MemoryProfile
	if prof.Name == "" {
		prof = memprofile.Default()
	}
	s.profile = prof

	// 生效限制项（P0-2）：装配方注入的 Limits 优先（它已是"控制台设置 > 部署档位 >
	// 编译期默认"的解析结果）；零值才回落档位折算。下面**所有**运行期强制
	//（队列并发 / 实例内存上限 / 模块缓存 / 库句柄）都读这一份，保证"自检算的账"
	// 与"实际跑的账"是同一份数。
	lim := opt.Limits
	if lim.MaxInstances <= 0 {
		lim = applimits.FromProfile(prof)
	}

	scheduler := opt.Scheduler
	if scheduler == nil {
		qopt := queue.DefaultOptions()
		// 全局并发实例取自生效限制项（不是编译期常量、也不是档位）：声明与执行同一份数。
		qopt.GlobalRunning = lim.MaxInstances
		scheduler = queue.New(qopt)
	}
	s.scheduler = scheduler
	limiter := opt.Limiter
	if limiter == nil {
		limiter = anonlimit.New(anonlimit.DefaultOptions())
	}
	s.limiter = limiter

	// §4.3.1-a：编译侧与执行侧必须共用**同一份**磁盘缓存目录。两边各按 DataRoot
	// 推导，推导规则不一致（或配置给了不同的 DataRoot）会让"发布期预编译"这条前提
	// 静默失效 —— 失败形态只是"每个应用首个请求慢 1.9 s"，不会报错。所以这里对拍。
	if opt.Compiler != nil {
		want := runtime.CompileCacheDir(opt.DataRoot)
		got := opt.Compiler.CacheDir()
		if !samePath(want, got) {
			return nil, fmt.Errorf("appserver: 编译缓存目录不一致：编译侧 %q，执行侧 %q（§4.3.1-a：两侧必须共用同一目录）", got, want)
		}
	}

	// 运行时装配：DataRoot 非空 ⇒ 用 wazero 的磁盘编译缓存（与编译子进程共用）。
	// 单实例内存上限取自**生效限制项**（wazero 侧是"上限"，线性内存按需增长）；
	// 它属于 RuntimeConfig ⇒ 建好之后不可变，所以"控制台改了要重启"这件事只剩
	// 一次重启的距离（重启后这里读到的就是设置值，见 P0-2）。
	rt, err := runtime.New(context.Background(), runtime.Options{
		DataRoot:    opt.DataRoot,
		MemoryPages: lim.InstanceMemoryPages(),
		Logger:      log.New(fnWriter{fn: logger}, "", 0),
	})
	if err != nil {
		return nil, fmt.Errorf("appserver: 装配执行侧运行时失败: %w", err)
	}
	s.rt = rt
	s.runtimePages = lim.InstanceMemoryPages()
	s.limits = lim
	// 进程内模块缓存：上限与磁盘缓存解耦，并按生效限制项缩放；空闲 TTL 由后台 sweep 执行。
	s.modules = newModuleCacheWith(int64(lim.ModuleCacheMB)<<20, limits.ModuleCacheMaxEntries,
		limits.ModuleCacheIdleTTL, now)
	s.appdbs = newAppDBPoolWithMax(now, lim.MaxInstances)
	// 只读连接数按**生效限制项**初始化（不是 appdb 的编译期默认）：否则控制台保存过
	// app_db_readers 的部署在重启后会"退回默认"，直到下一次保存才生效。
	// 它只影响**新建句柄**（语义见 appDBPool.SetReaders）。
	s.appdbs.SetReaders(lim.AppDBReaders)
	// (app_id, release_id) 级资源/配置缓存：上限来自 limits 真源（不是本包的常量）。
	s.releases = newReleaseCache(limits.ReleaseCacheMaxBytes, limits.ReleaseCacheMaxReleases, now)
	s.reclaim = newReclaimer(freeOSMemory, now, logger)
	logger("appserver: %s；生效限制项 %s（队列并发/实例内存/模块缓存/库句柄均按它强制）", prof.Report(), lim.Encode())

	// §4.7 / D3.1：ai.chat 由宿主用 http.Client 直调本地 /v1（不经出站白名单），
	// 令牌按 (用户, 会话) 缓存在内存里。BaseURL 缺失时 aichat 自己 fail-closed。
	if strings.TrimSpace(opt.AIBaseURL) == "" {
		logger("appserver: ⚠️ Options.AIBaseURL 为空：应用的 ai.chat 将一律返回 INTERNAL（这是装配缺陷，不是应用的问题）")
	}
	s.ai = aichat.New(aichat.Options{BaseURL: opt.AIBaseURL, DB: opt.DB})

	// 主站源不再缓存：基域可由管理端在运行期改（2026-09-18），换票地址必须按
	// **当前**值生成 —— 见 mainOriginNow()。这里只做一次启动日志。
	s.trustedProxies = trustedProxiesFromEnv()
	if s.mainOriginNow() == "" {
		logger("appserver: BaseDomain 为空：未启用应用子域；RequiresLogin 的应用无法换票（将按 500 处理）")
	} else if len(s.trustedProxies) == 0 {
		// R35：子域启用却没有可信代理配置 ⇒ 全部匿名流量会坍缩进同一个每 IP 桶。
		// 启动自检由 main.go 的 anonlimit.CheckTrustedProxies 负责拒绝启动；
		// 这里再记一条"大声"日志（本包不代替 main.go 做进程退出决定）。
		logger("appserver: ⚠️ 已启用应用子域但 %s 未配置：匿名限流将按 TCP 对端地址计数（反代后=全部匿名流量共用一个桶）",
			anonlimit.EnvTrustedProxies)
	}
	// 后台空闲回收：模块缓存与库句柄的"用不着就还"（见 sweepLoop）。
	s.sweeperStop = make(chan struct{})
	go s.sweepLoop()
	return s, nil
}

// sweepLoop 是后台空闲回收循环：周期性地
//
//	① 逐出空闲超过 limits.ModuleCacheIdleTTL 的编译模块（释放机器码）；
//	② 回收空闲超过 appDBIdleTimeout 的应用库句柄（释放 SQLite 连接与页缓存）；
//	③ 只要真的释放了东西，就限频地归还一次内存给 OS（reclaim.go）。
//
// 为什么必须是"时间驱动"（而不只是容量驱动）：几百个应用时，每个应用都可能被
// 访问过一次而容量始终没满 —— 只有 LRU 的话这些模块会永久驻留（实测：全部 Close
// 后 RSS 也只回落约 20%）。这条循环是"更快释放"的落点。
func (s *Server) sweepLoop() {
	t := time.NewTicker(moduleSweepInterval)
	defer t.Stop()
	for {
		select {
		case <-s.sweeperStop:
			return
		case <-t.C:
			s.sweepOnce()
		}
	}
}

// sweepOnce 执行一轮空闲回收（测试可直接调用，不必等 ticker）。
func (s *Server) sweepOnce() {
	var freedBytes int64
	if s.modules != nil {
		if n, bytes := s.modules.sweep(); n > 0 {
			freedBytes += bytes
			s.logf("appserver: 空闲回收编译模块 %d 个（空闲 > %s，记账 %d KiB）",
				n, limits.ModuleCacheIdleTTL, bytes>>10)
		}
	}
	// (app_id, release_id) 级资源缓存与编译模块共用同一个空闲 TTL：几百个应用里
	// 每个都被访问过一次时，只有 LRU 也会让字节长期驻留（R1-rt-3 的有界性一半靠
	// 容量、一半靠时间维度）。
	if s.releases != nil {
		if n, bytes := s.releases.sweepIdle(limits.ModuleCacheIdleTTL); n > 0 {
			freedBytes += bytes
			s.logf("appserver: 空闲回收资源缓存 %d 个版本（空闲 > %s，%d KiB）",
				n, limits.ModuleCacheIdleTTL, bytes>>10)
		}
	}
	if s.appdbs != nil {
		if n, bytes := s.appdbs.sweepIdle(); n > 0 {
			freedBytes += bytes
			s.logf("appserver: 空闲回收应用库句柄 %d 个（空闲 > %s）", n, appDBIdleTimeout)
		}
	}
	if freedBytes > 0 && s.reclaim != nil {
		s.reclaim.request("空闲回收", freedBytes)
	}
}

// EvictApp 立即丢掉某应用的进程内驻留（模块 + 库句柄 + 资源/配置缓存），并把内存还给 OS。
//
// 触发点：应用下架 / 冻结 / 删除 —— 这几件事之后该应用大概率长时间不会被访问，
// 与其等 TTL 扫描，不如事件驱动立刻释放（用户要求的"更快释放"）。
// 返回被逐出的模块数与记账字节数（日志/测试用）。
// 在途请求不受影响（refs > 0 的模块留给 TTL 路径）。
func (s *Server) EvictApp(appID string) (int, int64) {
	if s == nil {
		return 0, 0
	}
	var mods int
	var bytes int64
	if s.modules != nil {
		mods, bytes = s.modules.evictApp(appID)
	}
	// 资源/配置缓存（R1-rt-2/3）：下架/冻结/删除/逐出四条处置路径都会走到这里
	//（api 的 evict 钩子），因此"内容仍然可服务"不会在处置之后继续存在。
	releases := 0
	if s.releases != nil {
		releases = s.releases.evictApp(appID)
	}
	var handles int
	if s.appdbs != nil {
		if n, b := s.appdbs.evictApp(appID); n > 0 {
			handles = n
			bytes += b
		}
	}
	if mods > 0 || handles > 0 || releases > 0 {
		s.logf("appserver: 事件驱动逐出 app=%s（模块 %d 个 / 库句柄 %d 个 / 资源缓存 %d 个版本，记账 %d KiB）",
			appID, mods, handles, releases, bytes>>10)
		if s.reclaim != nil {
			s.reclaim.request("应用处置", bytes)
		}
	}
	return mods, bytes
}

// Close 释放本包创建的资源（模块缓存 + 执行侧运行时）。
//
// **先排空在途请求再关闭**：wazero 的 Runtime 不能在编译/实例化中途被关闭 ——
// engine.Close() 会把内部表置 nil，而并发的 CompileModule 会直接对 nil map 赋值，
// 结果是**进程级 panic**（`assignment to entry in nil map`，实测：请求还在冷编译时
// 调 Close 必现）。因此：
//
//  1. 置 closing（此后新请求一律 503，不再进入编译/执行路径）；
//  2. 等在途请求计数归零（有界等待 shutdownDrainTimeout；超时也继续关闭 ——
//     关闭是关停路径，不能无限等）；
//  3. 关闭模块缓存与运行时。
//
// 幂等：重复调用返回首次的结果。
//
// 刻意**不**关闭注入进来的 DB / Sessions / Events / Compiler / Scheduler：
// 它们的所有权在调用方（同一实例可能被平台其他部分使用）。
func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() { s.closeErr = s.close() })
	return s.closeErr
}

// shutdownDrainTimeout 是关闭前排空在途请求的等待上限。
//
// 它不是 §4 的平台上限（limits 是那些数值的唯一真源），而是关停路径的实现参数：
// 请求本身受端到端墙钟 60 s 约束，但关停不该等满 60 s —— 超时后照常关闭
// 并"大声"记一条日志（此时进程通常正在退出，风险由部署方的优雅停机窗口承担）。
const shutdownDrainTimeout = 10 * time.Second

func (s *Server) close() error {
	// 先停后台回收循环：它会访问模块缓存与句柄池，必须在拆它们之前退出。
	s.sweeperOnce.Do(func() {
		if s.sweeperStop != nil {
			close(s.sweeperStop)
		}
	})
	s.mu.Lock()
	s.closing = true
	if s.inflight == 0 {
		close(s.drained)
	}
	drained := s.drained
	s.mu.Unlock()

	timeout := s.drainTimeout
	if timeout <= 0 {
		timeout = shutdownDrainTimeout
	}
	select {
	case <-drained:
	case <-time.After(timeout):
		// ⚠️ 排空失败时**放弃关闭**，而不是"照关不误"。
		//
		// 原因（实测，不是理论担忧）：wazero 的 `engine.Close()` 把内部表置 nil，而仍在
		// 跑的 CompileModule/Instantiate 会读/写同一批字段 —— 两者并发就是数据竞争，
		// 最坏形态是**进程级 panic**。这个窗口是真实的：一次冷编译（--race 下实测 >20 s，
		// 生产上 32 MiB 模块估算 10–20 s）完全可能超过排空预算。
		//
		// 取舍：进程即将退出时"泄漏一个运行时"由操作系统回收，代价为零；
		// 而与在途请求竞争是崩溃 + 请求异常中断。因此这里**宁可不关**，并把这个事实
		// 明确返回给调用方（关停日志里能看见"关闭不完整"）。
		s.logf("appserver: 关闭前仍有在途请求未在 %s 内结束，**跳过关闭**（避免与在途编译/实例化竞争导致进程崩溃）", timeout)
		return errors.Join(s.closeErr, fmt.Errorf("appserver: 仍有在途请求未排空（等待 %s），已跳过运行时/句柄池/模块缓存关闭", timeout))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var errs []error
	if s.appdbs != nil {
		if err := s.appdbs.closeAll(); err != nil {
			errs = append(errs, err)
		}
	}
	if s.modules != nil {
		if err := s.modules.closeAll(); err != nil {
			errs = append(errs, err)
		}
	}
	if s.rt != nil {
		if err := s.rt.Close(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// beginRequest 登记一次在途请求；关闭中返回 false（调用方应回 503）。
func (s *Server) beginRequest() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return false
	}
	s.inflight++
	return true
}

// endRequest 注销一次在途请求（与 beginRequest 严格配对，用 defer 调用）。
func (s *Server) endRequest() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.inflight > 0 {
		s.inflight--
	}
	if s.closing && s.inflight == 0 {
		select {
		case <-s.drained:
		default:
			close(s.drained)
		}
	}
}

// logf 是内部日志出口。
func (s *Server) logf(format string, args ...any) {
	if s == nil || s.logger == nil {
		return
	}
	s.logger(format, args...)
}

// fnWriter 把 io.Writer 形状接到 func(format, args...) 形式的日志出口（runtime 需要 *log.Logger）。
type fnWriter struct {
	fn func(format string, args ...any)
}

func (w fnWriter) Write(p []byte) (int, error) {
	if w.fn != nil {
		msg := strings.TrimRight(string(p), "\n")
		if msg != "" {
			w.fn("%s", msg)
		}
	}
	return len(p), nil
}

// samePath 比较两个路径是否指向同一位置（相对/绝对、尾斜杠不影响判定）。
func samePath(a, b string) bool {
	norm := func(p string) string {
		p = filepath.Clean(strings.TrimSpace(p))
		if abs, err := filepath.Abs(p); err == nil {
			return abs
		}
		return p
	}
	return norm(a) == norm(b)
}

// trustedProxiesFromEnv 读 PICOAI_TRUSTED_PROXIES（逗号分隔的 IP/CIDR）。
//
// 为什么按**环境变量**读而不是走 Options：这是部署期事实（反代地址），
// 与 anonlimit 的启动自检（anonlimit.CheckTrustedProxies）共用同一个变量名常量，
// 不新增字段、不新增真源。无法解析的项直接忽略（fail-closed：忽略=不信任，
// 只会让限流更严；启动自检已负责把非法值拦在进程之外）。
// mainOriginNow 按**当前**基域计算主站源（`scheme://<host>`）；空 = 未启用应用子域。
//
// 与 session.ParseBaseDomain 同一份解析（基域可带 scheme，缺省 https）—— 解析规则
// 只允许一份，避免两处对 "http://127.0.0.1:8080" 这类取值判断不一致。
func (s *Server) mainOriginNow() string {
	raw := ""
	if s.opt.BaseDomain != nil {
		raw = s.opt.BaseDomain()
	}
	scheme, host := session.ParseBaseDomain(raw)
	if host == "" {
		return ""
	}
	return scheme + "://" + host
}

func trustedProxiesFromEnv() []netip.Prefix {
	raw := strings.TrimSpace(os.Getenv(anonlimit.EnvTrustedProxies))
	if raw == "" {
		return nil
	}
	var out []netip.Prefix
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if p, err := netip.ParsePrefix(item); err == nil {
			out = append(out, p.Masked())
			continue
		}
		if ip, err := netip.ParseAddr(item); err == nil {
			out = append(out, netip.PrefixFrom(ip, ip.BitLen()))
		}
	}
	return out
}
