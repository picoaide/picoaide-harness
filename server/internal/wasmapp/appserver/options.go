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
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
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
	BaseDomain string
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

	scheduler *queue.Scheduler
	limiter   *anonlimit.Limiter
	// ai 是共享的 ai.chat 客户端（按 (用户, 会话) 缓存在手令牌，§4.7）。
	ai capapi.AI

	// mainOrigin 是主站源（`scheme://<BaseDomain>`），换票回跳用；空 = 未启用应用子域。
	mainOrigin string
	// trustedProxies 是可信前置代理（PICOAI_TRUSTED_PROXIES）：
	// 只有来自它们的 X-Forwarded-For 才被采信（见 clientip.go）。
	trustedProxies []netip.Prefix

	// guestBudget 是 guest 执行预算的测试注入点（0 = limits.GuestBudget）。
	// 生产路径不得设置它：数值唯一真源在 limits（§4.6）。
	guestBudget time.Duration
	// drainTimeout 是关闭前排空等待的测试注入点（0 = shutdownDrainTimeout）。
	drainTimeout time.Duration

	// ===== 关闭期排空（见 Close 的注释：wazero 的 Runtime 不能在编译/实例化中途被关闭）=====
	mu        sync.Mutex
	closing   bool
	inflight  int
	drained   chan struct{}
	closeOnce sync.Once
	closeErr  error
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

	scheduler := opt.Scheduler
	if scheduler == nil {
		scheduler = queue.New(queue.DefaultOptions())
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
	rt, err := runtime.New(context.Background(), runtime.Options{
		DataRoot: opt.DataRoot,
		Logger:   log.New(fnWriter{fn: logger}, "", 0),
	})
	if err != nil {
		return nil, fmt.Errorf("appserver: 装配执行侧运行时失败: %w", err)
	}
	s.rt = rt
	s.modules = newModuleCache()
	s.appdbs = newAppDBPool(now)

	// §4.7 / D3.1：ai.chat 由宿主用 http.Client 直调本地 /v1（不经出站白名单），
	// 令牌按 (用户, 会话) 缓存在内存里。BaseURL 缺失时 aichat 自己 fail-closed。
	if strings.TrimSpace(opt.AIBaseURL) == "" {
		logger("appserver: ⚠️ Options.AIBaseURL 为空：应用的 ai.chat 将一律返回 INTERNAL（这是装配缺陷，不是应用的问题）")
	}
	s.ai = aichat.New(aichat.Options{BaseURL: opt.AIBaseURL, DB: opt.DB})

	// 主站源：与 session 包同一份解析（BaseDomain 可带 scheme；缺省 https）。
	scheme, host := session.ParseBaseDomain(opt.BaseDomain)
	if host != "" {
		s.mainOrigin = scheme + "://" + host
	}
	s.trustedProxies = trustedProxiesFromEnv()
	if s.mainOrigin == "" {
		logger("appserver: BaseDomain 为空：未启用应用子域；RequiresLogin 的应用无法换票（将按 500 处理）")
	} else if len(s.trustedProxies) == 0 {
		// R35：子域启用却没有可信代理配置 ⇒ 全部匿名流量会坍缩进同一个每 IP 桶。
		// 启动自检由 main.go 的 anonlimit.CheckTrustedProxies 负责拒绝启动；
		// 这里再记一条"大声"日志（本包不代替 main.go 做进程退出决定）。
		logger("appserver: ⚠️ 已启用应用子域但 %s 未配置：匿名限流将按 TCP 对端地址计数（反代后=全部匿名流量共用一个桶）",
			anonlimit.EnvTrustedProxies)
	}
	return s, nil
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
