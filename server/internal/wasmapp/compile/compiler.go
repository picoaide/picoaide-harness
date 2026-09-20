package compile

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/cachetrust"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// IsolationMode 是编译子进程的 OS 级隔离策略（R31 / §15.1 第 14 条）。
type IsolationMode int

const (
	// IsolationAuto 是默认：可用则启用，不可用则**大声记日志**并继续。
	// 生产默认值——"隔离不可用就拒绝服务"会让一个没装 bwrap 的镜像直接不可用，
	// 而设计文档把 fail-closed 的严格档留给显式配置。
	IsolationAuto IsolationMode = iota
	// IsolationRequire 是生产强化档：隔离不可用 ⇒ New 返回错误（fail-closed）。
	IsolationRequire
	// IsolationOff 关闭隔离：**仅测试**，且每次启动都会在日志里显式声明。
	IsolationOff
)

func (m IsolationMode) String() string {
	switch m {
	case IsolationAuto:
		return "auto"
	case IsolationRequire:
		return "require"
	case IsolationOff:
		return "off"
	default:
		return fmt.Sprintf("unknown(%d)", int(m))
	}
}

// IsolationEnvVar 是选择隔离档位的环境变量名。
//
// 部署形态需要它：默认档 `IsolationAuto` 在隔离不可用时**只警告并继续**，
// 而"生产要不要接受无隔离编译"是运维决策，不该由代码替他决定。设成
// `require` 即 fail-closed（隔离不可用则启动失败）。
const IsolationEnvVar = "PICOAI_COMPILE_ISOLATION"

// IsolationFromEnv 读取 IsolationEnvVar 并解析成 IsolationMode。
//
// 取值（大小写不敏感）：
//
//	"require" / "strict"  → IsolationRequire（生产强化的 fail-closed 档）
//	"off" / "none"        → IsolationOff（**仅测试**；每次启动都会在日志里声明）
//	"auto" / "" / 其它    → IsolationAuto（默认）
//
// 未识别的值回落 auto 而不是报错：这个开关是"加固"用的，把它写错不该让服务起不来；
// 但未知值会让 auto 打出那条"未隔离"的警告日志，问题不会被静默吞掉。
func IsolationFromEnv() IsolationMode {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(IsolationEnvVar))) {
	case "require", "strict":
		return IsolationRequire
	case "off", "none":
		return IsolationOff
	default:
		return IsolationAuto
	}
}

// Options 是 Compiler 的构造参数。
//
// 全部上限的**数值默认值都取自 limits**（§4 铁律：数值唯一真源），Options 只提供覆盖点。
type Options struct {
	// DataRoot 是平台数据根：缓存目录 = <DataRoot>/<limits.CompileCacheDirName>。
	DataRoot string
	// Isolation 是隔离策略（缺省 IsolationAuto）。
	Isolation IsolationMode
	// MemoryPages 是**生效**的单实例线性内存页上限（装配方注入
	// `applimits.Limits.InstanceMemoryPages()`；0 ⇒ 编译期默认 limits.InstanceMemoryPages）。
	//
	// 为什么编译侧也需要它（R1-rt-7b，P1）：wazero 在**编译期**按它校验模块**声明**的
	// 初始/最大线性内存。用编译期默认会让控制台的 instance_memory_mb 对发布期完全不生效 ——
	// 调小 ⇒ "发布放行、首个请求 500（还被报成平台故障）"；调大 ⇒ 声明大内存的应用
	// 永远发不出去。装配侧与执行侧（appserver/options.go）读的是**同一个**
	// applimits.Limits，因此这里是"同源取生效值"的编译侧一半。
	//
	// ⚠️ 与该值同语义的是执行侧的 runtime.Options.MemoryPages：两者都属于各自进程的
	// wazero RuntimeConfig ⇒ **保存后需重启**才生效（本包在 New 时快照，不做运行期热改）。
	MemoryPages uint32
	// MaxQueue 是队列深度（缺省 limits.CompileQueueDepth = 64，满则 429）。
	MaxQueue int
	// Timeout 是单次编译超时（缺省 limits.CompileTimeout = 60 s）。
	// 到点 ⇒ 杀子进程 + COMPILE_TIMEOUT(504)，下一次请求重启子进程。
	Timeout time.Duration
	// CacheMaxBytes / CacheMaxEntries 是缓存回收的两个维度（缺省取自 limits，
	// §10.3 第 35 项要求**同时**满足两者）。
	CacheMaxBytes   int64
	CacheMaxEntries int
	// UploadRatePerHour 是每用户上传频率上限（缺省 limits.UploadRatePerHour = 30）。
	UploadRatePerHour int
	// UploadConcurrentCompiles 是同一用户同时编译中的上传上限（缺省 1）。
	UploadConcurrentCompiles int
	// IdleTimeout 是常驻子进程的空闲退出时间（缺省 DefaultIdleTimeout）。
	// 空闲退出会释放子进程保留的编译内存；下一次请求自动重启。
	//
	// ⚠️ 它不是设计文档 §4 里的"上限数值"（那是给应用作者看的护栏），
	// 而是本模块的运行期实现参数，因此留在本包（见 DefaultIdleTimeout 的注释）。
	IdleTimeout time.Duration
	// ChildBinary 是编译子进程可执行文件路径。空 ⇒ 取本进程可执行文件同目录下的
	// ChildBinaryName。测试用它指向 go build 出来的临时二进制。
	ChildBinary string
	// Env 是子进程环境变量的**父环境来源**（缺省 os.Environ）。
	// 只用于测试注入"含机密的假父环境"，验证白名单真的把它们剔掉了。
	Env []string
	// ReclaimInterval 是缓存回收的最小间隔（节流，§10.3 第 35 项"每次编译后或按计数节流"）。
	ReclaimInterval time.Duration
	// Logger 是隔离/异常路径的日志出口（缺省 log.Printf；测试可注入以断言"大声"）。
	Logger Logger
	// ReadableDirs 是编译子进程需要**只读**访问的目录（除系统目录白名单之外）。
	//
	// 为什么需要显式声明：隔离用的是**读白名单**（不是 `--ro-bind / /`，见
	// isolate_linux.go 的 bwrapReadOnlySystemDirs），所以"模块字节从哪读"必须由
	// 调用方告诉编译器。通常传上传暂存根目录（例如 `<DataRoot>/apps/_uploads`）。
	//
	// 未声明时编译器会**按请求自适应**：把每个模块自己所在的目录只读绑进去，
	// 目录变化时重启子进程（见 ensureChild 的 boundDirs）。声明它只是省掉重启。
	ReadableDirs []string
	// ChildArgs 是附加给子进程的参数（**测试专用**：注入模拟故障的子进程行为）。
	// 生产路径永远为空——留这个口子是因为"超时/被杀/协议破坏"只有真起进程才成立，
	// 而 mock exec 会让这三类用例退化成"测自己的假实现"。
	ChildArgs []string
}

// Logger 是最小日志接口（只为可测：隔离不可用必须"大声记日志"）。
type Logger interface {
	Printf(format string, args ...any)
}

// ChildBinaryName 是编译子进程的二进制名（与 cmd/picoaide-app-compile 目录名一致）。
//
// 为什么放在本包而不是 limits：limits 是**应用作者可见的上限真源**（§4 的护栏表），
// 而这是部署形态的内部约定（两个二进制同目录）。放进去会让 limits 变成杂物间，
// 反而削弱"§4 的每个数字都有出处"这条纪律。
const ChildBinaryName = "picoaide-app-compile"

// DefaultIdleTimeout 是常驻编译子进程的空闲退出时间。
//
// 取值理由：编译是低频动作（每用户 30 次/小时的上传配额），5 分钟足以覆盖
// "连续发几个版本"的常见节奏，同时保证"偶尔传一次"的部署不会长期挂着一个
// 保留了 wazero 编译内存的进程（§4.3 内存四笔账里的"编译缓存驻留"那笔）。
const DefaultIdleTimeout = 5 * time.Minute

// uploadStatePruneThreshold 是触发 uploads map 清理的条目数阈值。
//
// 取值理由：单实例部署下"曾经上传过的用户"最多到员工总数（数千）；给一个远大于
// 常见规模的阈值，避免每次 AllowUpload 都全表扫（清理是 O(n) 的）。
const uploadStatePruneThreshold = 4096

// pruneUploadsLocked 丢掉"窗口内无记录且无在飞上传"的用户条目（调用方持有 uploadMu）。
func (c *Compiler) pruneUploadsLocked(cutoff time.Time) {
	for id, st := range c.uploads {
		if st.inflight > 0 {
			continue
		}
		active := false
		for _, t := range st.stamps {
			if t.After(cutoff) {
				active = true
				break
			}
		}
		if !active {
			delete(c.uploads, id)
		}
	}
}

// minRetryAfter 是被拒时给出的最小 Retry-After。
//
// 契约放在这里而不是调用方：AllowUpload 是唯一知道"为什么被拒、最快何时能再来"
// 的地方；让每个调用点自己 clamp 是重复且易漏的（§7.4 要求 429 必带 Retry-After）。
const minRetryAfter = time.Second

// defaultReclaimInterval 是缓存回收的节流间隔。
//
// 为什么节流：回收要 os.ReadDir 整个缓存目录（4096 条目量级），每次编译都全扫
// 会让"编译很快"的路径被 IO 拖慢；而缓存超限是**长期**趋势，秒级延迟无害。
const defaultReclaimInterval = 30 * time.Second

// Result 是一次成功编译的产出（父侧对外契约）。
type Result struct {
	Imports     []Symbol
	Exports     []Symbol
	CustomBytes int64
	CompileMS   int64
	// Cached 表示本次编译命中了磁盘缓存（判据见 Compiler.compileOne）。
	Cached bool
	// CacheEntry 是命中时**缓存目录里最新的条目**的绝对路径（未命中为空）。
	//
	// ⚠️ 语义边界：wazero 的条目名是内容寻址的，但文件名不可从模块字节直接推导
	// （键含 moduleID 与 CPU features），因此这里给的是"本次编译后最新的条目"。
	// 多模块共享缓存时它可能指向**别的模块**的条目 ⇒ 只可用于诊断/日志，
	// 不要当作"这条缓存就是本次编译的产物"的判据（真判据是 Cached 与 CompileMS）。
	CacheEntry string
}

// Stats 是编译子系统的运行指标（§4.9 /readyz 用）。
type Stats struct {
	// QueueDepth 是当前排队的请求数（不含正在跑的那一个）。
	QueueDepth int
	// QueueCapacity 是队列容量（limits.CompileQueueDepth）。
	QueueCapacity int
	// Compiling 表示此刻有编译在跑（单进程串行 ⇒ 最多 1）。
	Compiling bool
	// ChildRunning 表示常驻子进程存在。
	ChildRunning bool
	// CacheBytes / CacheEntries 是缓存目录的当前体积/条目数。
	CacheBytes   int64
	CacheEntries int
	// CacheMaxBytes / CacheMaxEntries 是回收阈值（透出给 /readyz 判水位）。
	CacheMaxBytes   int64
	CacheMaxEntries int
	// Compiles / Failures / Timeouts 是累计计数。
	Compiles int64
	Failures int64
	Timeouts int64
	// LastCompileMS 是最近一次编译耗时（含缓存命中路径）。
	LastCompileMS int64
}

// Compiler 是编译子系统的父侧门面：单进程串行（并发 1）+ 有界队列 + 磁盘缓存回收。
//
// 并发模型（R31）：
//
//	Compile() ──enqueue(非阻塞，满则 429)──▶ jobs(chan, 深度 64)
//	                                             │
//	                       run() 单 goroutine ◀──┘  同一时刻只有一个编译在跑
//	                                             │
//	                    常驻子进程（首次启动，空闲 IdleTimeout 后退出）
//
// 为什么串行：编译是 CPU 密集且峰值内存高（32 MiB 模块的编译峰值是内存四笔账之一，
// §4.3）。串行把并发度固定为 1，从而把"编译池被上传打满"这条路封死。
type Compiler struct {
	opt   Options
	cache string
	// childCacheDir 是**实际交给编译子进程**的缓存目录。
	//
	// 与 `cache`（配置面/诊断面）分开的理由（2026-09-21 四轮审计 P2-①）：缓存目录
	// 形状不可信时（符号链接、group 可写、条目非普通文件），wazero 的磁盘缓存是
	// **读 + 写** —— 子进程会先查表，命中就直接加载那份"机器码"并**干跑**它。
	// 在 `auto` 档（compose 默认）没有 OS 级隔离时，那等于让能布置缓存目录的人
	// 在编译进程里执行代码，而编译进程读得到数据根。
	// 执行侧已经"不可信 ⇒ 不用"（runtime.NewCompilationCache），编译侧此前只在
	// `require` 档 fail-closed、其余档位**告警照用** ⇒ 两侧不对称。
	// 现在的口径：不可信 ⇒ 子进程改用一个**全新的临时目录**（本进程创建、0700、
	// 退出即删）—— 既不读攻击者的条目，也不往那棵树里写；编译功能不受影响。
	childCacheDir string
	// childCacheTemp 非空表示 childCacheDir 是我们创建的临时目录（关闭时要清）。
	childCacheTemp string
	child          string
	logger         Logger
	iso            *isolationPlan
	// isoMode 是**生效的隔离档位**（构造时冻结）。保留它是为了让调用方能拿到
	// 结构化状态而不是只有一句描述文案（见 IsolationStatus）。
	isoMode IsolationMode

	jobs chan *job
	stop chan struct{}
	done chan struct{}
	once sync.Once

	mu           sync.Mutex
	childProc    *childProcess
	compiling    bool
	compiles     int64
	failures     int64
	timeouts     int64
	lastCompileM int64
	lastReclaim  time.Time

	uploadMu sync.Mutex
	uploads  map[int64]*uploadState
}

// uploadState 是单用户的上传频率/并发状态（R20 允许进程内存态：单实例部署）。
//
// 为什么不用令牌桶：规则是"每用户 30 次/小时（滑动窗口）+ 同时最多 1 次编译中的上传"，
// 滑动窗口 + 并发计数就是它本身，再包一层桶只会让"第 31 次 429"的判据变模糊。
type uploadState struct {
	// stamps 是最近一小时内的调用时间戳（升序，过期从头部丢弃）。
	stamps []time.Time
	// inflight 是"已被允许、正在编译"的上传数。
	inflight int
}

// job 是一次排队的编译请求。
type job struct {
	modulePath string
	resp       chan jobResult
}

type jobResult struct {
	res *Result
	err *apperr.Error
}

// New 构造编译器。
//
// 失败即 fail-closed（不返回半可用的 Compiler）：隔离要求不满足、缓存目录建不出来、
// 子进程二进制不存在，都在这里拒绝。
func New(opt Options) (*Compiler, error) {
	if opt.DataRoot == "" {
		return nil, errors.New("compile: DataRoot 必填（缓存目录 = DataRoot/<limits.CompileCacheDirName>）")
	}
	if opt.MaxQueue <= 0 {
		opt.MaxQueue = limits.CompileQueueDepth
	}
	if opt.Timeout <= 0 {
		opt.Timeout = limits.CompileTimeout
	}
	if opt.CacheMaxBytes <= 0 {
		opt.CacheMaxBytes = limits.CompileCacheMaxBytes
	}
	if opt.CacheMaxEntries <= 0 {
		opt.CacheMaxEntries = limits.CompileCacheMaxEntries
	}
	if opt.UploadRatePerHour <= 0 {
		opt.UploadRatePerHour = limits.UploadRatePerHour
	}
	if opt.UploadConcurrentCompiles <= 0 {
		opt.UploadConcurrentCompiles = limits.UploadConcurrentCompiles
	}
	if opt.IdleTimeout <= 0 {
		opt.IdleTimeout = DefaultIdleTimeout
	}
	if opt.ReclaimInterval <= 0 {
		opt.ReclaimInterval = defaultReclaimInterval
	}
	if opt.Logger == nil {
		opt.Logger = log.Default()
	}
	// 生效的单实例内存上限（R1-rt-7b）：装配方没注入（最小装配/单测）时回落编译期默认。
	// 与 appserver/options.go 的 `lim.InstanceMemoryPages()` 同一判据、同一取值来源
	// （装配侧的 applimits.Limits），因此发布期编译与执行期实例化不会各说各话。
	if opt.MemoryPages == 0 || opt.MemoryPages > maxCompilerMemoryPages {
		opt.MemoryPages = limits.InstanceMemoryPages
	}

	// 必须与 internal/wasmapp/runtime 算出**同一个目录**（§4.3.1-a：两侧不一致
	// 会让"发布期编译暖到执行进程"这条前提静默失效）。推导的唯一入口是
	// cache.go 的 CompileCacheDir()（分代 = wazero 真实版本，拿不到才回落到
	// limits.CompileCacheRevision），runtime 侧有一份同算法的实现 + 交叉断言用例。
	cache := CompileCacheDir(opt.DataRoot)
	// 0700：缓存目录是信任边界（§4.3.1-d），属主=编译进程，执行进程只读。
	//
	// 三步合一（2026-09-21 审计 F-4）：MkdirAll + **显式 Chmod**（只在新建时生效的
	// MkdirAll 挡不住"旧版本/人工/宽 umask 留下的可写目录"）+ 形状校验
	//（真实目录、无 group/other 写位、条目是普通非空文件 —— 详见 cachetrust 包）。
	// 校验策略：`require` 档发现违规**拒绝启动**（隔离已声明为强制，缓存可信度不能例外）；
	// 其余档位告警并逐条打印，由运维面处置。
	report, cerr := cachetrust.Ensure(cache, os.FileMode(limits.DataDirMode))
	if cerr != nil {
		return nil, cerr
	}
	// 默认：子进程用配置的缓存目录。
	childCacheDir := cache
	var childCacheTemp string
	if !report.Trusted() {
		for _, v := range report.Violations {
			opt.Logger.Printf("compile: ⚠️ 缓存目录不可信：%s（%s）", v.Path, v.Reason)
		}
		if opt.Isolation == IsolationRequire {
			return nil, fmt.Errorf("compile: 缓存目录不可信（%d 处违规）但隔离档位是 require：%s（%s）——"+
				"缓存条目会被执行进程 mmap 成机器码，require 档不接受可投毒的缓存",
				len(report.Violations), report.Violations[0].Path, report.Violations[0].Reason)
		}
		// 非 require 档：**不拒绝启动，但也不碰那棵树**（四轮审计 P2-①）。
		// wazero 的磁盘缓存是读 + 写：子进程命中就直接加载那份"机器码"并干跑它 ——
		// 能布置缓存目录的人因此可以在编译进程里执行代码（auto 档常常没有 OS 级隔离）。
		// 换一个本进程新建的 0700 临时目录：既不读攻击者的条目，也不往里写。
		tmp, terr := os.MkdirTemp("", "picoaide-compile-cache-")
		if terr != nil {
			return nil, fmt.Errorf("compile: 缓存目录不可信，且无法创建替代缓存目录: %w", terr)
		}
		if cerr := os.Chmod(tmp, os.FileMode(limits.DataDirMode)); cerr != nil {
			_ = os.RemoveAll(tmp)
			return nil, fmt.Errorf("compile: 替代缓存目录权限设置失败: %w", cerr)
		}
		opt.Logger.Printf("compile: ⚠️ 缓存目录不可信 ⇒ 本次编译进程改用临时缓存目录（不读也不写那棵树）：%s", tmp)
		childCacheDir, childCacheTemp = tmp, tmp
	}
	// 兼容面：旧的一行式权限描述仍保留（诊断/验收输出用），判据比 cachetrust 浅，
	// 只回答"根目录权限是否合 §4.3.1-d"。
	if desc, terr := cacheDirIsTrustBoundary(cache); terr != nil {
		opt.Logger.Printf("compile: ⚠️ 缓存目录权限不合规（%s）：%v；§4.3.1-d 要求只有编译进程可写", desc, terr)
	}

	// 从这里往下的任何失败都必须在返回前清掉临时缓存目录（五轮审计 P2-②：
	// `os.MkdirTemp` 在 New 早期就创建了目录，而后续任一步失败都会 `return nil, err`
	// ——调用方拿不到 *Compiler，也就永远不会调 Close()，目录留在 /tmp 里）。
	fail := func(err error) (*Compiler, error) {
		if childCacheTemp != "" {
			_ = os.RemoveAll(childCacheTemp)
		}
		return nil, err
	}

	child, err := resolveChildBinary(opt.ChildBinary)
	if err != nil {
		return fail(err)
	}

	plan, err := planIsolation(opt.Isolation, child, opt.Logger)
	if err != nil {
		return fail(err)
	}

	c := &Compiler{
		opt:            opt,
		cache:          cache,
		childCacheDir:  childCacheDir,
		childCacheTemp: childCacheTemp,
		child:          child,
		logger:         opt.Logger,
		iso:            plan,
		isoMode:        opt.Isolation,
		jobs:           make(chan *job, opt.MaxQueue),
		stop:           make(chan struct{}),
		done:           make(chan struct{}),
		uploads:        map[int64]*uploadState{},
		lastReclaim:    time.Now(),
	}
	go c.run()
	return c, nil
}

// Compile 在 60 s 预算内编译一个模块（缓存目录 = <DataRoot>/_compile-cache）。
//
// 失败语义（§7.4）：
//   - 队列满 ⇒ COMPILE_BUSY(429)（见 CompileBusyReason：为何不是 APP_QUEUE_FULL）；
//   - 到点   ⇒ 杀子进程 + COMPILE_TIMEOUT(504)，下次请求自动重启；
//   - 异常退出（被杀/OOM）⇒ COMPILE_OOM(500)，details 带 exit code/signal；
//   - 静态校验失败 ⇒ SECTION_MALFORMED / IMPORT_* / COMPONENT_MODEL_UNSUPPORTED(422)。
func (c *Compiler) Compile(ctx context.Context, modulePath string) (*Result, *apperr.Error) {
	if modulePath == "" || !filepath.IsAbs(modulePath) {
		return nil, apperr.New(apperr.CodeValidation, "module_path 必须是绝对路径")
	}
	j := &job{modulePath: modulePath, resp: make(chan jobResult, 1)}
	select {
	case c.jobs <- j:
	default:
		// 队列满：**不阻塞**（阻塞会把"上传洪水"变成"HTTP 连接洪水"）。
		return nil, compileBusyError(len(c.jobs), c.opt.MaxQueue)
	}
	select {
	case r := <-j.resp:
		return r.res, r.err
	case <-ctx.Done():
		// 调用方（HTTP 请求）先放弃：任务仍在队列/执行中，我们只放弃等待，
		// 不取消它——取消会让"已经跑了一半的编译"丢掉可复用的缓存写入。
		return nil, apperr.From(ctx.Err()).WithHint("请求已被取消，编译可能仍在后台完成")
	}
}

// MemoryPages 返回**生效**的单实例线性内存页上限（装配注入的值，未注入 = 编译期默认）。
//
// 与执行侧 `appserver.Server.InstanceMemoryPages()` 同一个用途：让"装配真的把生效值传进来了"
// 成为可断言的事实（cmd/server 的装配级用例钉住它），而不是只能读代码相信。
func (c *Compiler) MemoryPages() uint32 {
	if c == nil {
		return 0
	}
	return c.opt.MemoryPages
}

// ValidateWasm 做"编译前静态预检"（不发子进程）：体积 + 段表 + 导出面 + 导入面。
//
// 与 Compile 的分工：本方法只回答"字节本身是否可接受"，**不做真编译、不写缓存**。
// 设计文档里的 validate（§4.2）还需要真编译 + 干跑，那部分由上层编排
// （预检失败没必要起进程；预检通过后再 Compile）。
func (c *Compiler) ValidateWasm(module []byte) (*Report, *apperr.Error) {
	// 体积、自定义段总量、导出面、导入面白名单**全部由 wasmmod 判定**
	//（WASM_TOO_LARGE / SECTION_OVERRIDE_OVERSIZE / VALIDATE_FAILED / IMPORT_*）。
	// 本方法**不再重复任何一条**：重复判据 = 第二真源，早晚会在边界上给出不同结论
	//（曾有过体积与自定义段总量各判两遍的版本，已删）。
	v := StaticValidatorHook
	if v == nil {
		v = NewValidator() // 生产实现 = wasmmod 适配器（唯一真源，见 staticvalidate.go）
	}
	rep, err := v.Validate(module)
	if err != nil {
		return nil, apperr.From(err)
	}
	return rep, nil
}

// ExtractCustomSections 抽出自定义段（assets 抽取用，§4.2）。
//
// 放在编译包的原因：解析 wasm 段表的能力只在这里有一份；assets 模块不需要
// 重新实现一遍段解析（重复实现 = 两份判据，长期必然漂移）。
func (c *Compiler) ExtractCustomSections(module []byte) (map[string][]byte, *apperr.Error) {
	// 自定义段总量**不在这里判**：wasmmod.Validate 已经用统一口径（含段名负载）判过，
	// 这里的二次口径（不含段名）既不可达又是第二真源。调用方应先用 ValidateWasm。
	out, err := extractCustomSections(module)
	if err != nil {
		return nil, apperr.From(err)
	}
	return out, nil
}

// Stats 返回运行指标（§4.9 /readyz：编译队列深度、编译中标志、缓存体积/条目）。
func (c *Compiler) Stats() Stats {
	c.mu.Lock()
	st := Stats{
		QueueDepth:      len(c.jobs),
		QueueCapacity:   c.opt.MaxQueue,
		Compiling:       c.compiling,
		ChildRunning:    c.childProc != nil && c.childProc.alive(),
		CacheMaxBytes:   c.opt.CacheMaxBytes,
		CacheMaxEntries: c.opt.CacheMaxEntries,
		Compiles:        c.compiles,
		Failures:        c.failures,
		Timeouts:        c.timeouts,
		LastCompileMS:   c.lastCompileM,
	}
	c.mu.Unlock()
	bytes, entries, _ := c.cacheUsage()
	st.CacheBytes, st.CacheEntries = bytes, entries
	return st
}

// CacheDir 返回缓存目录绝对路径（诊断/权限断言用）。
func (c *Compiler) CacheDir() string { return c.cache }

// CacheEntries 返回缓存条目的路径/体积/写入时间（UnixNano），按路径升序。
//
// 用途：/readyz 水位、命中判定的可观测性、以及**回收测试**（"删的是最旧的那些"
// 必须能被外部断言）。返回副本，调用方改不了内部状态。
//
// 口径 = **所有分代**（与 cacheUsage/ReclaimCache 一致，见 cacheScanRoot）：只列当前分代会
// 让"升级后仍占磁盘的旧目录"在诊断面里彻底不可见（审计 P2-2）。
func (c *Compiler) CacheEntries() []CacheEntry {
	es, err := listCacheEntries(c.cacheScanRoot(), cacheLayoutDepthAll)
	if err != nil {
		return nil
	}
	out := make([]CacheEntry, 0, len(es))
	for _, e := range es {
		out = append(out, CacheEntry{Path: e.path, Size: e.size, ModTimeUnixNano: e.mtime})
	}
	return out
}

// IsolationPlan 返回生效的隔离方案描述（诊断：/readyz 与启动日志）。
func (c *Compiler) IsolationPlan() string { return c.iso.describe() }

// IsolationStatus 返回隔离的**结构化**状态：档位、是否实际生效、可读细节。
//
// 与 IsolationPlan 的分工：IsolationPlan 是给人看的字符串；**判据必须结构化** ——
// 消费者是启动 fail-closed（`IsolationRequire` 档在隔离不可用时要拒绝启动），
// 若调用方用 strings.Contains(plan, "已启用") 去判，隔离方案的措辞一变就会静默失效
// （而失效的方向是"生产带着无隔离的编译进程起来了"）。
// 注意 `IsolationOff` 档的 usable 也是 false：那是有意的（显式关隔离 ≠ 隔离生效），
// 判据由调用方结合 mode 决定（require ∧ !usable 才拒绝启动）。
func (c *Compiler) IsolationStatus() (mode IsolationMode, usable bool, detail string) {
	if c == nil {
		return IsolationAuto, false, "编译器未构造"
	}
	return c.isoMode, c.iso != nil && c.iso.available, c.iso.describe()
}

// closeGrace 是 Close 等待 worker 收尾的宽限。
//
// 为什么需要它：worker 可能正卡在一次编译里（预算 = Options.Timeout，默认 60 s），
// 而它只在 runJob 之间看 c.stop。关停路径（HTTP 优雅期通常 10 s）等不起 60 s。
// 因此 Close 的策略是"**先杀子进程**（让在飞请求立刻拿到错误返回）再等 worker"，
// 宽限只兜住"worker 还在做收尾（回收缓存/写结果）"的极短窗口。
const closeGrace = 5 * time.Second

// Close 关闭编译器：停接受新请求、杀子进程（中断在飞编译）、有界等待 worker 退出。
//
// 顺序很关键（踩过）：**先 kill 子进程**。否则 worker 会一直阻塞在 `proc.request`
// 上等满一个编译预算，把进程关停拖过容器的优雅期 → SIGKILL → 无 bwrap 时编译子进程
// 成孤儿，继续写 `<dataRoot>/_compile-cache`（下个实例随后并发写同一目录）。
func (c *Compiler) Close() error {
	var err error
	c.once.Do(func() {
		close(c.stop)
		// 临时缓存目录（不可信缓存的替代品）随编译器关闭一起清掉。
		if c.childCacheTemp != "" {
			_ = os.RemoveAll(c.childCacheTemp)
		}
		// 1) 先断掉在飞编译：杀子进程会让 proc.request 立刻返回错误，worker 随即
		//    从 runJob 出来看到 stop 并收尾。
		c.mu.Lock()
		if c.childProc != nil {
			err = c.childProc.kill()
			c.childProc = nil
		}
		c.mu.Unlock()
		// 2) 有界等待 worker（正常情况下立刻返回）。
		select {
		case <-c.done:
		case <-time.After(closeGrace):
			c.logger.Printf("compile: worker 未在 %v 内退出（在飞编译可能仍在收尾）", closeGrace)
		}
	})
	return err
}

// ===== worker（单 goroutine，串行执行）=====

func (c *Compiler) run() {
	defer close(c.done)
	for {
		select {
		case <-c.stop:
			c.drain()
			return
		case j := <-c.jobs:
			c.runJob(j)
		}
	}
}

// drain 把队列里剩下的请求全部回绝（关闭时不让任何调用方永久阻塞）。
func (c *Compiler) drain() {
	for {
		select {
		case j := <-c.jobs:
			j.resp <- jobResult{err: apperr.New(apperr.CodeInternal, "编译器正在关闭")}
		default:
			return
		}
	}
}

// runJob 执行一个编译请求（含空闲子进程的启动与超时后的清理）。
func (c *Compiler) runJob(j *job) {
	c.mu.Lock()
	c.compiling = true
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.compiling = false
		c.mu.Unlock()
	}()

	res, err := c.compileOne(j.modulePath)

	c.mu.Lock()
	if err != nil {
		c.failures++
		if err.Code == apperr.CodeCompileTimeout {
			c.timeouts++
		}
	} else {
		c.compiles++
		c.lastCompileM = res.CompileMS
	}
	needReclaim := time.Since(c.lastReclaim) >= c.opt.ReclaimInterval
	if needReclaim {
		c.lastReclaim = time.Now()
	}
	c.mu.Unlock()

	if needReclaim {
		// 回收在父侧（子进程只写不删，§10.3 第 35 项）。
		if _, _, rerr := c.ReclaimCache(); rerr != nil {
			c.logger.Printf("compile: 缓存回收失败（下次继续尝试）: %v", rerr)
		}
	}
	j.resp <- jobResult{res: res, err: err}
}

// compileOne 是单个编译的完整路径：准备子进程 → 发请求 → 判定缓存命中 → 收尾。
func (c *Compiler) compileOne(modulePath string) (*Result, *apperr.Error) {
	proc, cerr := c.ensureChild(modulePath)
	if cerr != nil {
		return nil, cerr
	}

	// 缓存命中判定（父侧）：wazero 不暴露"是否命中"的 API，但它的条目是
	// **内容寻址**的（条目名 = sha256(moduleID‖magic‖CPU features)，§4.3.1）。
	// 判据用"最新条目的写入时间是否被本次编译推进"：
	//   - miss ⇒ wazero 写入新条目 ⇒ 最新 mtime 前进；
	//   - hit  ⇒ 只读已有条目 ⇒ 最新 mtime 不变。
	// 用 mtime 而不是"条目数是否增加"：条目数在"命中 + 回收同时发生"时不可靠，
	// 而 mtime 只被写入推进（回收只删旧的，不影响"最新"）。
	beforeMtime, beforeEntries := c.newestCacheMtime()

	req := Request{Op: OpCompile, ModulePath: modulePath, CacheDir: c.childCacheDir}
	resp, rerr := proc.request(req, c.opt.Timeout)
	if rerr != nil {
		return nil, c.explainMemoryDeclaration(rerr)
	}

	afterMtime, afterEntries := c.newestCacheMtime()
	cached := beforeEntries > 0 && afterEntries > 0 && afterMtime <= beforeMtime
	entry := ""
	if cached {
		entry = c.newestCacheEntry()
	}

	res := &Result{
		Imports:     resp.Imports,
		Exports:     resp.Exports,
		CustomBytes: resp.CustomBytes,
		CompileMS:   resp.CompileMS,
		Cached:      cached,
		CacheEntry:  entry,
	}
	return res, nil
}

// memoryDeclarationOverLimit 是 wazero 拒绝"模块声明的线性内存超过生效上限"时的错误特征
// （原文形如 `section memory: min 1600 pages (100 Mi) over limit of 1024 pages (64 Mi)`）。
//
// 判据用错误串而不是错误类型：wazero 不导出类型化错误（与 runtime/errors.go 的
// memoryErrorPatterns 同一处置），且这段文本正是子进程回传的 details["error"]。
const memoryDeclarationOverLimit = "over limit of"

// explainMemoryDeclaration 给"模块声明的内存超上限"这类失败补上**生效值**（R1-rt-7b ③）。
//
// 为什么需要：子进程回传的原文里的数字来自它自己的 RuntimeConfig —— 修好 rt-7b 之后
// 那已经是生效值；但父侧再显式回一条结构化明细与提示，作者/AI 就不必从 wazero 的长句里
// 抠数字，也不会拿到"过期的 64 MiB"。
//
// 只对**这一条**特征生效（其余失败原样透传）：给所有编译失败都挂内存提示会把
// "你的语法错了"误导成"你的内存超了"。
func (c *Compiler) explainMemoryDeclaration(err *apperr.Error) *apperr.Error {
	if err == nil {
		return nil
	}
	raw, _ := err.Details["error"].(string)
	if !strings.Contains(raw, memoryDeclarationOverLimit) {
		return err
	}
	pages := c.opt.MemoryPages
	mib := int64(pages) * int64(limits.WasmPageSize) >> 20
	return err.
		WithDetail("memory_limit_pages", pages).
		WithDetail("memory_limit_bytes", int64(pages)*int64(limits.WasmPageSize)).
		WithHint(fmt.Sprintf("平台**当前生效**的单实例线性内存上限是 %d 页（%d MiB）："+
			"模块声明的初始/最大线性内存不能超过它（工具链的默认初始内存也算：Zig 默认 257 页、Go 的常驻堆另计）；"+
			"确需更大就把控制台的 instance_memory_mb 调大并重启服务端", pages, mib))
}

// ensureChild 返回可用的常驻子进程（不存在/已死/已空闲超时/**绑定目录不含本次模块**则重启）。
//
// "绑定目录"这条是隔离设计的一部分：沙箱用**读白名单**（只读绑系统目录 + 模块目录
// + 可写绑缓存目录），因此一个已经起来的子进程只能读它启动时被绑进来的那些目录。
// 模块换目录时必须重启，否则会得到"文件不存在"这种**看起来像模块问题**的错误。
//
// 代价可接受：编译是低频动作（每用户 30 次/小时），而同一应用的连续上传通常落在
// 同一暂存目录 ⇒ 绝大多数情况下不触发重启。
func (c *Compiler) ensureChild(modulePath string) (*childProcess, *apperr.Error) {
	needDir := dirOf(modulePath)

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.childProc != nil {
		switch {
		case !c.childProc.alive():
			// 已经死了（崩溃/被杀/自己退出）：留下退出信息供本次请求解释。
			c.childProc = nil
		case c.childProc.idleFor() >= c.opt.IdleTimeout:
			// 空闲超时：主动杀掉，释放它保留的编译内存（下次请求重启）。
			if err := c.childProc.kill(); err != nil {
				c.logger.Printf("compile: 空闲子进程退出失败: %v", err)
			}
			c.childProc = nil
		case !c.childProc.coversDir(needDir):
			// 本次模块不在已绑定的只读目录里 ⇒ 必须重启才能让它可见。
			// （不上"顺手多绑几个"的优化：绑定集合越宽，隔离实际强度越弱。）
			if err := c.childProc.kill(); err != nil {
				c.logger.Printf("compile: 目录变化重启时旧子进程退出失败: %v", err)
			}
			c.childProc = nil
		default:
			return c.childProc, nil
		}
	}

	proc, err := c.spawnChild(needDir)
	if err != nil {
		return nil, apperr.From(err).WithHint("编译进程不可用：请检查部署镜像里是否有 picoaide-app-compile 二进制与隔离工具（bwrap）")
	}
	c.childProc = proc
	return proc, nil
}

// spawnChild 启动一个常驻子进程。
//
// env：**只**传白名单（§4.3）+ 平台自己算出的部署级参数（CompileChildEnv：生效的
// 单实例内存上限，R1-rt-7b）。这不是"清理"，是"白名单"——父环境里的
// PG_DSN / master key / PICOAI_* 一律不进子进程（子进程读的是攻击者的字节）。
func (c *Compiler) spawnChild(moduleDir string) (*childProcess, error) {
	env := CompileChildEnv(c.envSource(), c.opt.MemoryPages)
	// 只读绑定集合 = 声明的 ReadableDirs ∪ 本次模块所在目录 ∪ 子进程二进制所在目录。
	//
	// 三项都是**必须**的：沙箱内的 `/` 是空 tmpfs（读白名单，见 bwrapReadOnlySystemDirs），
	// 所以"模块字节从哪读"和"要 exec 的二进制在哪"都必须显式绑进去 ——
	// 少绑任意一项，子进程都起不来或读不到模块（本机实测：漏绑二进制目录时
	// 启动自检直接失败）。
	//
	// 绑定二进制目录的代价：同目录下的其它文件（例如 server 自己的二进制）也可读。
	// 这是刻意接受的最小暴露面——它不含数据根、不含 master key、不含 .env。
	readDirs := append([]string{}, c.opt.ReadableDirs...)
	for _, d := range []string{moduleDir, dirOf(c.child)} {
		if d != "" && !dirCovered(readDirs, d) {
			readDirs = append(readDirs, d)
		}
	}
	// -cache-dir 是**显式声明可写面**：隔离启动器只认这个值（不再从 argv 反解——
	// 常驻子进程的 argv 里根本没有 cache_dir，它只出现在请求里）。
	// ⚠️ `-cache-dir` 必须与请求里的 `cache_dir` **同一个值**（`childCacheDir`）：
	// 子进程启动时会记下这个声明，并在每个请求上做一致性自检
	//（cmd/picoaide-app-compile/main.go 的 declaredCacheDir 比对），不一致直接回
	// INTERNAL。五轮审计实测：这里曾漏改成 `c.cache` ⇒ 在"缓存不可信"这条分支上
	// **每一次真实编译都失败**（而只断言结构体的用例完全看不出来）。
	args := append([]string{
		"-listen",
		"-timeout", c.opt.Timeout.String(),
		"-cache-dir", c.childCacheDir,
	}, c.opt.ChildArgs...)
	proc, err := startChild(c.child, args, env, c.iso, isolationTargets{
		CacheDir:     c.childCacheDir,
		ReadOnlyDirs: readDirs,
		Env:          env,
	})
	if err != nil {
		return nil, err
	}
	// 启动自检：ping 一次确认协议版本一致（拿到旧版二进制的场景下 fail-fast，
	// 而不是等第一次编译时才炸出难懂的错误）。
	//
	// ⚠️ 错误必须**就地**包上"启动自检"的上下文：如果只在外层用 fmt.Errorf 包一层，
	// 调用方的 apperr.From 会用 errors.As 命中内层 *apperr.Error 并把外层消息丢掉
	//（症状：运维看到"读取编译子进程应答失败"，不知道是部署问题还是编译问题）。
	if _, perr := proc.request(Request{Op: OpPing}, startupPingTimeout); perr != nil {
		_ = proc.kill()
		return nil, startupSelfCheckError(perr)
	}
	return proc, nil
}

// startupPingTimeout 是启动自检的预算（ping 不涉及编译，2 s 足够）。
const startupPingTimeout = 2 * time.Second

// startupSelfCheckError 把启动自检的失败包装成带上下文的平台错误（保留原码与 details）。
func startupSelfCheckError(perr *apperr.Error) *apperr.Error {
	if perr == nil {
		return nil
	}
	e := apperr.New(perr.Code, "编译子进程启动自检失败："+perr.Message)
	for k, v := range perr.Details {
		e = e.WithDetail(k, v)
	}
	e = e.WithDetail("stage", "startup_self_check")
	// 这条 hint 是可运维的：自检失败几乎总是"二进制不对/跑不起来"，不是模块的问题。
	e = e.WithHint(
		"部署检查：picoaide-app-compile 必须与 picoaide-server 同目录、同一版本（协议版本不符会让自检失败）",
		"手工复跑：`picoaide-app-compile -request '{\"op\":\"ping\"}'` 应输出 {\"ok\":true,\"version\":\"picoaide-app-compile/1\"}",
	)
	return e
}

// envSource 返回父环境来源（测试可注入假环境）。
func (c *Compiler) envSource() []string {
	if c.opt.Env != nil {
		return c.opt.Env
	}
	return os.Environ()
}

// resolveChildBinary 解析子进程可执行文件路径。
func resolveChildBinary(explicit string) (string, error) {
	p := explicit
	if p == "" {
		self, err := os.Executable()
		if err != nil {
			return "", fmt.Errorf("compile: 解析自身可执行文件失败: %w", err)
		}
		p = filepath.Join(filepath.Dir(self), ChildBinaryName)
	}
	if !filepath.IsAbs(p) {
		abs, err := filepath.Abs(p)
		if err != nil {
			return "", fmt.Errorf("compile: 子进程路径非法: %w", err)
		}
		p = abs
	}
	fi, err := os.Stat(p)
	if err != nil {
		return "", fmt.Errorf("compile: 编译子进程不存在（%s）: %w", p, err)
	}
	if fi.IsDir() || fi.Mode().Perm()&0o100 == 0 {
		return "", fmt.Errorf("compile: 编译子进程不可执行: %s", p)
	}
	return p, nil
}

// compileBusyError 构造"编译队列满"的错误。
//
// 见包注释与交付说明里的口径讨论：设计 §4.3 说"队列 64（满则 429）"，而 §7.4 的
// `APP_QUEUE_FULL` 是**应用执行**队列满（每应用队列 32）的码，语义是"这个应用太忙"。
// 编译队列是**平台级**的等待区，混用会让 AI 把"平台编译忙"误判成"我的应用被刷爆"，
// 从而去优化自己根本没问题的地方 ⇒ 这里用 `COMPILE_BUSY`(429，apperr 已定义，
// 与 §7.4 的 429 语义一致)。
func compileBusyError(depth, capacity int) *apperr.Error {
	return apperr.New(apperr.CodeCompileBusy, "编译队列已满，请稍后重试").
		WithDetail("queue_depth", depth).
		WithDetail("queue_capacity", capacity).
		WithDetail("retry_after_seconds", limits.RetryAfterSeconds).
		WithHint("上传是同步编译的：请等待当前上传完成后再重试（每用户同时只允许 1 个上传编译）")
}

// ===== 上传频率闸门（§4.3「上传频率」/ §10.3 第 36 项）=====

// AllowUpload 判定该用户此刻能否发起一次上传（validate + publish 合计）。
//
// 两条规则（§4.3 第 147 行）：
//  1. 每用户 limits.UploadRatePerHour 次/小时（**滑动窗口**，不是固定窗口：
//     固定窗口在边界上允许 2× 突发）；
//  2. 同时最多 limits.UploadConcurrentCompiles 次编译中的上传。
//
// 返回 retryAfter 供 HTTP 层写 `Retry-After`（§7.4：429 + Retry-After）。
// 内存态即可（R20 单实例部署）。
//
// 注意：**允许即计数**（不是"成功才计数"）。理由是这条闸门防的是"上传即预编译"
// 被当 DoS 面用，而失败的上传同样消耗了编译 CPU（恶意用户可以故意上传编译不过的
// 包刷 CPU）——按成功计数会让"第 31 次"永远到不了。
func (c *Compiler) AllowUpload(userID int64, now time.Time) (ok bool, retryAfter time.Duration) {
	if now.IsZero() {
		now = time.Now()
	}
	cutoff := now.Add(-time.Hour)

	c.uploadMu.Lock()
	defer c.uploadMu.Unlock()

	// 顺手清理长期不用的用户条目：单实例长期运行下，uploads 会随"曾经上传过的
	// 用户数"单调增长（每用户一条）。清掉的判据是"窗口内没有记录且没有在飞上传"。
	if len(c.uploads) > uploadStatePruneThreshold {
		c.pruneUploadsLocked(cutoff)
	}
	st := c.uploads[userID]
	if st == nil {
		st = &uploadState{}
		c.uploads[userID] = st
	}
	// 丢过期（stamps 升序 ⇒ 从头部丢）。
	keep := st.stamps[:0]
	for _, t := range st.stamps {
		if t.After(cutoff) {
			keep = append(keep, t)
		}
	}
	st.stamps = keep

	// 先判并发（"同时 1 次编译中"），再判频率。
	//
	// 顺序有语义：并发被拒**不消耗**频率额度——否则"同时点两次"会让用户
	// 白白损失一次小时额度，而小时额度是 30 次/小时这种"用户能感知"的资源。
	if st.inflight >= c.opt.UploadConcurrentCompiles {
		return false, minRetryAfter
	}
	if len(st.stamps) >= c.opt.UploadRatePerHour {
		// 最早的一次滑出窗口时才有下一次机会。
		wait := st.stamps[0].Add(time.Hour).Sub(now)
		if wait < minRetryAfter {
			// 契约：被拒时 retryAfter 恒 ≥ minRetryAfter。压在调用方（HTTP 层）会让
			// "Retry-After: 0" 变成忙等提示；负数更糟。
			wait = minRetryAfter
		}
		return false, wait
	}
	st.stamps = append(st.stamps, now)
	st.inflight++
	return true, 0
}

// ReleaseUpload 释放一次上传的并发占位（编译结束/失败都要调，defer 最稳）。
//
// 频率计数**不**回退：试错次数本身就是限流对象（见 AllowUpload 的说明）。
func (c *Compiler) ReleaseUpload(userID int64) {
	c.uploadMu.Lock()
	defer c.uploadMu.Unlock()
	if st := c.uploads[userID]; st != nil && st.inflight > 0 {
		st.inflight--
	}
}

// UploadState 返回该用户当前的频率用量（诊断/日志用；不是判定入口）。
func (c *Compiler) UploadState(userID int64, now time.Time) (used int, inflight int) {
	if now.IsZero() {
		now = time.Now()
	}
	cutoff := now.Add(-time.Hour)
	c.uploadMu.Lock()
	defer c.uploadMu.Unlock()
	st := c.uploads[userID]
	if st == nil {
		return 0, 0
	}
	n := 0
	for _, t := range st.stamps {
		if t.After(cutoff) {
			n++
		}
	}
	return n, st.inflight
}

// DropChild 立即让常驻子进程下线（测试与运维用：验证"下次请求自动重启"）。
func (c *Compiler) DropChild() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.childProc != nil {
		_ = c.childProc.kill()
		c.childProc = nil
	}
}
