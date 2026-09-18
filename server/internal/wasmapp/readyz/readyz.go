// Package readyz 实现**启动自检**与**运行期水位探针**：
// 设计依据 §4.3（内存四笔账联立 + 启动自检）、§4.9（运维面 `/readyz`）、
// §15.1 第 9 条（单实例启动自检）、§11 第 21 项（可观测缺口）。
//
// 两个"fail-closed"是设计明确要求的，不是可选项：
//  1. **理论峰值内存 > 可用内存 70% ⇒ 拒绝启动**（§4.3 原话：「拒绝启动而不是等 OOM」）；
//  2. **磁盘/队列/缓存水位低于阈值 ⇒ 拒绝发布**（§4.9 原话：「低于阈值红灯并拒绝发布」）。
//
// 现网 `healthz` 只做 `db.Ping`：磁盘满仍然 healthy —— 那正是本包要补的洞。
package readyz

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// 以下三个常量是**启动自检的估算系数**，不是"应用可见的上限"，
// 因此不属于 limits 包（§4 的上限表）。
//
// 设计文档给了四笔账的构成（§4.3「内存四笔账」）但没给后两笔的倍数，
// 这里取保守值并把依据写在注释里；若实测发现偏差，改这里并同步本注释。
const (
	// CompilePeakBytes 是"编译峰值"这笔账（§4.3 第三笔）。
	// 依据 §15.2：2.48 MiB 模块编译 RSS +34 MiB（≈13.7×）；32 MiB 模块按 8× 保守估。
	CompilePeakBytes = limits.WasmMaxBytes * 8
	// CacheResidentBytes 是"编译缓存驻留"这笔账（§4.3 第一笔）。
	// 缓存条目在编译时被读入进程；按缓存上限的 25% 保守估。
	CacheResidentBytes = limits.CompileCacheMaxBytes / 4
	// MinDiskFreeBytes 是磁盘余量红线（低于即拒绝发布）。取 1 GiB：
	// 单次发布最多 32 MiB wasm + 资产，1 GiB 足够数百次发布，同时远高于"写满即事故"的余量。
	MinDiskFreeBytes = 1 << 30
	// InstancePoolBytes 是"32 × 64 MiB 实例"这笔账（§4.3 第二笔）。
	InstancePoolBytes = limits.GlobalInstances * limits.InstanceMemoryPages * limits.WasmPageSize
)

// CompilerStatsSnapshot 是编译侧水位的**结构化视图**（与 compile.Stats 解耦，
// 避免本包 import compile 造成依赖环）。
type CompilerStatsSnapshot struct {
	QueueDepth int
	InFlight   int
	CacheBytes int64
	CacheFiles int
	Running    bool
}

// CompileAvailability 是编译子系统的**是非题**状态（§4.9 运维面；装配层注入）。
//
// 为什么与 CompilerStatsSnapshot 分开：水位读数的零值在"子系统缺失"与"空闲"之间
// **不可区分**（两者都是 0/false）—— 审计 P2-2 实测的正是这一点：编译器缺失时
// `/readyz` 与健康态逐字段同形。可用性不是水位，必须由装配层显式回答。
type CompileAvailability struct {
	// Available 表示发布链路此刻能否编译；false ⇒ AllowPublish 拒绝发布。
	Available bool
	// Detail 是可读说明（进 reasons；**不要**塞底层错误原文：/readyz 是未认证端点）。
	Detail string
}

// EventsStats 是调用事件的计数水位（§4.9「有界环形内存 → 丢最旧并计数」）。
//
// 用值类型而不是 func：本包不该 import events（依赖方向 events → capapi/limits），
// 而"三个计数"是稳定的小契约。缺失时计数保持 0（字段仍然存在，避免响应体形状漂移）。
type EventsStats struct {
	Dropped int64
	Failed  int64
	Written int64
}

// Options 是探针配置。
type Options struct {
	// DataRoot 是应用数据根（磁盘水位在这里量）。
	DataRoot string
	// Compiler 提供编译队列与缓存水位（可为 nil ⇒ 相关项不判）。
	Compiler func() CompilerStatsSnapshot
	// CompileAvailability 报告编译子系统是否可用（可为 nil ⇒ 视为可用/不判）。
	//
	// ⚠️ 它决定 `compile_available` 与"发布是否被拒"：nil 与"可用"同义
	// （保持既有测试与最小装配可用），**生产装配必须注入**（否则审计 P2-2 复现）。
	CompileAvailability func() CompileAvailability
	// Events 提供调用事件计数（可为 nil ⇒ 三个字段为 0）。
	Events func() EventsStats
	// Scheduler 提供执行队列水位（可为 nil）。
	Scheduler *queue.Scheduler
	// DB 探针（可为 nil）。
	Ping func() error
	// Now 可注入时钟。
	Now func() time.Time
	// DiskFree 可注入磁盘余量读取（默认 syscall.Statfs）。
	DiskFree func(path string) (int64, error)
	// MemAvailable 可注入可用内存读取（默认读 /proc/meminfo）。
	MemAvailable func() (int64, error)
}

// Snapshot 是 `/readyz` 的响应体。
//
// 语义分工（审计 P2-2 要求写清，且必须有断言钉住）：
//   - `ok` 回答"实例现在能不能**服务应用请求**"（执行面）：磁盘/缓存/队列/DB 不达标即
//     false；`compile_available=false` **不**把 ok 打成 false（编译是**发布面**的另一个
//     维度：没有编译器时子域请求照常服务，编排不该因此摘掉一个还在正常干活的实例）；
//   - `compile_available` 回答"发布链路能不能编译"：它必须可见（不再与健康态同形），
//     并且 AllowPublish 把它当**阻止发布**的理由（没有编译器就没有发布）。
type Snapshot struct {
	OK               bool     `json:"ok"`
	Reasons          []string `json:"reasons,omitempty"`
	DiskFreeByte     int64    `json:"disk_free_bytes"`
	CompileAvailable bool     `json:"compile_available"`
	CompileQueue     int      `json:"compile_queue_depth"`
	CompileBusy      bool     `json:"compile_busy"`
	CacheBytes       int64    `json:"compile_cache_bytes"`
	CacheFiles       int      `json:"compile_cache_files"`
	ExecRunning      int      `json:"exec_running"`
	ExecWaiting      int      `json:"exec_waiting"`
	EventsDropped    int64    `json:"events_dropped"`
	EventsFailed     int64    `json:"events_failed"`
	EventsWritten    int64    `json:"events_written"`
	DBOK             bool     `json:"db_ok"`
	CheckedAt        string   `json:"checked_at"`
}

// reasons 的**前缀**常量：AllowPublish 靠它们区分"阻塞原因"与"非阻塞说明"。
//
// 为什么抽成常量：AllowPublish 用 HasPrefix 过滤，若前缀与生产 reason 的字面量
// 各写一份，改文案时过滤会静默失效（把非阻塞项当成阻塞项，或反过来放过阻塞项）。
const (
	// reasonExecutorFull：执行槽满 —— **非阻塞**（有界即设计目标），但发布不占执行槽，
	// 所以它也不阻止发布（满载时连发布都做不了反而无法排障）。
	reasonExecutorFull = "执行槽已满"
	// reasonCompileUnavailable：编译子系统不可用 —— 非阻塞（ok 仍可为 true），
	// 但**阻止发布**（没有编译器就没有发布；审计 P2-2 的第二个要求）。
	reasonCompileUnavailable = "编译子系统不可用"
)

// Checker 是水位探针。
type Checker struct {
	opt Options

	mu       sync.Mutex
	lastFree int64
}

// New 创建探针。
func New(opt Options) *Checker {
	if opt.Now == nil {
		opt.Now = time.Now
	}
	if opt.DiskFree == nil {
		opt.DiskFree = diskFree
	}
	if opt.MemAvailable == nil {
		opt.MemAvailable = memAvailable
	}
	return &Checker{opt: opt}
}

// Snapshot 采集一次水位并给出是否达标与原因。
func (c *Checker) Snapshot() Snapshot {
	// CompileAvailable 的缺省是 true：没有可用性提供者时"不判"（与既有装配兼容），
	// 生产装配由 cmd/server 显式注入（见 Options.CompileAvailability）。
	s := Snapshot{OK: true, CompileAvailable: true, CheckedAt: c.opt.Now().UTC().Format(time.RFC3339)}
	if c.opt.DataRoot != "" && c.opt.DiskFree != nil {
		if free, err := c.opt.DiskFree(c.opt.DataRoot); err == nil {
			s.DiskFreeByte = free
			c.mu.Lock()
			c.lastFree = free
			c.mu.Unlock()
			if free < MinDiskFreeBytes {
				s.OK = false
				s.Reasons = append(s.Reasons, fmt.Sprintf("磁盘余量不足：%d 字节 < %d", free, int64(MinDiskFreeBytes)))
			}
		} else {
			s.OK = false
			s.Reasons = append(s.Reasons, "磁盘余量不可读: "+err.Error())
		}
	}
	if c.opt.CompileAvailability != nil {
		ca := c.opt.CompileAvailability()
		s.CompileAvailable = ca.Available
		if !ca.Available {
			// 非阻塞说明项（对齐"执行槽已满"的先例）：ok 说的是执行面，编译可用性是
			// 发布面。但这条必须出现在 reasons 里，让"发布已禁用"在探针上**可读**，
			// 而不只是靠一个 bool 字段（审计 P2-2）。
			reason := reasonCompileUnavailable
			if strings.TrimSpace(ca.Detail) != "" {
				reason += "：" + ca.Detail
			}
			s.Reasons = append(s.Reasons, reason)
		}
	}
	if c.opt.Compiler != nil {
		cs := c.opt.Compiler()
		s.CompileQueue = cs.QueueDepth
		s.CompileBusy = cs.InFlight > 0 || cs.Running
		s.CacheBytes = cs.CacheBytes
		s.CacheFiles = cs.CacheFiles
		if cs.QueueDepth >= limits.CompileQueueDepth {
			s.OK = false
			s.Reasons = append(s.Reasons, fmt.Sprintf("编译队列已满：%d ≥ %d", cs.QueueDepth, limits.CompileQueueDepth))
		}
		if cs.CacheBytes > int64(limits.CompileCacheMaxBytes) {
			// 注意：这个状态由编译器在**每次编译后**回收（ReclaimInterval 节流）收敛，
			// 因此正常路径下是瞬态；若长期停留说明回收失败（日志里有记录）。
			s.OK = false
			s.Reasons = append(s.Reasons, fmt.Sprintf("编译缓存超上限：%d > %d", cs.CacheBytes, int64(limits.CompileCacheMaxBytes)))
		}
	}
	if c.opt.Scheduler != nil {
		st := c.opt.Scheduler.Stats()
		s.ExecRunning = st.GlobalRunning
		s.ExecWaiting = st.Waiting
		if st.GlobalRunning >= limits.GlobalInstances {
			// 满载不是"不健康"（§4.6：有界即设计目标）⇒ 只做**非阻塞**说明项，
			// 不置 OK=false；AllowPublish 也会过滤掉这一条（发布不占执行槽，
			// 满载时连发布都做不了反而无法排障）。
			s.Reasons = append(s.Reasons, fmt.Sprintf("%s：%d ≥ %d", reasonExecutorFull, st.GlobalRunning, limits.GlobalInstances))
		}
	}
	if c.opt.Events != nil {
		es := c.opt.Events()
		s.EventsDropped, s.EventsFailed, s.EventsWritten = es.Dropped, es.Failed, es.Written
	}
	if c.opt.Ping != nil {
		if err := c.opt.Ping(); err != nil {
			s.OK = false
			s.DBOK = false
			s.Reasons = append(s.Reasons, "数据库不可达: "+err.Error())
		} else {
			s.DBOK = true
		}
	}
	return s
}

// Handler 是 `/readyz` 的 HTTP 处理（JSON；不达标返回 503）。
func (c *Checker) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := c.Snapshot()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if !s.OK {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(s)
	}
}

// AllowPublish 是**发布前的 fail-closed 闸门**（§4.9：低于阈值拒绝发布）。
//
// 与 Snapshot 的区别：这里只关心"能不能安全地接一次编译 + 落盘"，
// 因此两类**非阻塞说明项**不阻止发布：
//   - 执行槽满载：发布不占执行槽（满载时连发布都做不了反而无法排障）；
//   - 编译子系统不可用：**会**阻止（没有编译器就没有发布）—— 它不是"说明项"而是
//     实打实的发布面缺失（审计 P2-2 的第二个要求）。
//
// HTTP 语义：返回的 `*apperr.Error` 显式带 503（Service Unavailable）——
// 这是"平台暂时不可用"而非"你的请求有问题"：500 会被当成服务端 bug、429 会被当成
// 客户端限流（并诱导客户端按 Retry-After 立刻重试，而磁盘低水位需要运维介入）。
func (c *Checker) AllowPublish() *apperr.Error {
	s := c.Snapshot()
	blocking := make([]string, 0, len(s.Reasons))
	for _, reason := range s.Reasons {
		if strings.HasPrefix(reason, reasonExecutorFull) {
			continue
		}
		blocking = append(blocking, reason)
	}
	if len(blocking) == 0 {
		return nil
	}
	e := apperr.New(apperr.CodeInternal, "平台当前不可用，已拒绝新的发布").
		WithDetail("reasons", blocking).
		WithDetail("compile_available", s.CompileAvailable).
		WithHint("这是 fail-closed 保护：磁盘/缓存/编译队列水位不足时接受发布会把平台推向不可恢复状态").
		WithHint("请在服务端查看 /readyz 的明细")
	e.HTTP = http.StatusServiceUnavailable
	return e
}

// ===== 单实例启动自检（R20 / §15.1 第 9 条）=====

// InstanceLock 是单实例部署的 advisory 锁句柄。
type InstanceLock struct {
	f    *os.File
	path string
	once sync.Once
}

// AcquireInstanceLock 在数据根上取排他 advisory 锁。
//
// 为什么必须做（§15.1 第 9 条原话）：**多副本的失败形态是静默的**
// （一次性换票在 A 签发、B 兑换失败；编译缓存/执行队列各自一半）。
// 因此宁可拒绝启动，也不要"看起来在跑"。
//
// 用 POSIX `flock(LOCK_EX|LOCK_NB)`（与上游会话写入同族手法）：进程崩溃时
// 内核自动释放，不会留下需要人工清理的陈旧锁文件。
func AcquireInstanceLock(dataRoot string) (*InstanceLock, error) {
	if dataRoot == "" {
		return nil, fmt.Errorf("readyz: 数据根为空，无法取实例锁")
	}
	if err := os.MkdirAll(dataRoot, limits.DataDirMode); err != nil {
		return nil, fmt.Errorf("readyz: 创建数据根失败: %w", err)
	}
	path := filepath.Join(dataRoot, "instance.lock")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("readyz: 打开实例锁失败: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		return nil, fmt.Errorf("readyz: 另一个实例已持有 %s（本平台按 R20 只允许单实例部署）: %w", path, err)
	}
	// 写上 pid 便于运维判断占用者（写失败不影响锁语义）。
	_ = f.Truncate(0)
	_, _ = f.WriteAt([]byte(strconv.Itoa(os.Getpid())+"\n"), 0)
	return &InstanceLock{f: f, path: path}, nil
}

// Release 释放实例锁（幂等）。
func (l *InstanceLock) Release() {
	if l == nil {
		return
	}
	l.once.Do(func() {
		if l.f != nil {
			_ = syscall.Flock(int(l.f.Fd()), syscall.LOCK_UN)
			_ = l.f.Close()
		}
	})
}

// Path 返回锁文件路径（诊断用）。
func (l *InstanceLock) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// ===== 内存四笔账（§4.3）=====

// MemoryBudget 是四笔账的分解（便于日志与探针展示）。
type MemoryBudget struct {
	Instances     int64 `json:"instances_bytes"`
	CompilePeak   int64 `json:"compile_peak_bytes"`
	UploadPeak    int64 `json:"upload_peak_bytes"`
	CacheResident int64 `json:"cache_resident_bytes"`
	Total         int64 `json:"total_bytes"`
	Available     int64 `json:"available_bytes"`
	// Limit 是允许的上限（可用内存 × limits.MemoryPeakGuardPercent%）。
	Limit int64 `json:"limit_bytes"`
	OK    bool  `json:"ok"`
}

// ComputeMemoryBudget 计算理论峰值并判定是否超过可用内存的允许比例。
// availableBytes ≤ 0 表示读不到 ⇒ **不判定**（返回 OK=true 并标注），
// 因为"读不到就拒绝启动"会让容器/受限环境无法部署；此时由部署文档兜住。
func ComputeMemoryBudget(availableBytes int64) MemoryBudget {
	b := MemoryBudget{
		Instances:     InstancePoolBytes,
		CompilePeak:   CompilePeakBytes,
		UploadPeak:    limits.UploadPeakPerUploadBytes,
		CacheResident: CacheResidentBytes,
		Available:     availableBytes,
	}
	b.Total = b.Instances + b.CompilePeak + b.UploadPeak + b.CacheResident
	if availableBytes <= 0 {
		b.OK = true
		return b
	}
	b.Limit = availableBytes * limits.MemoryPeakGuardPercent / 100
	b.OK = b.Total <= b.Limit
	return b
}

// CheckStartupMemory 是启动自检入口：不达标返回错误（调用方 log.Fatal）。
func CheckStartupMemory(availableBytes int64) (MemoryBudget, *apperr.Error) {
	b := ComputeMemoryBudget(availableBytes)
	if b.OK {
		return b, nil
	}
	return b, apperr.New(apperr.CodeInternal, "理论内存峰值超过可用内存的安全水位，拒绝启动").
		WithDetail("total_bytes", b.Total).
		WithDetail("limit_bytes", b.Limit).
		WithDetail("available_bytes", b.Available).
		WithDetail("guard_percent", limits.MemoryPeakGuardPercent).
		WithHint("§4.3 要求内存四笔账联立：实例池 + 编译峰值 + 上传峰值 + 缓存驻留").
		WithHint("扩容机器内存，或由平台管理员下调可用实例数（当前为编译期常量，需重新构建）")
}

// ===== 平台相关读取 =====

func diskFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// memAvailable 读 Linux 的 MemAvailable（容器里也反映 cgroup 限制后的可用量）。
func memAvailable() (int64, error) {
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0, err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "MemAvailable:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		kb, err := strconv.ParseInt(fields[1], 10, 64)
		if err != nil {
			return 0, err
		}
		return kb * 1024, nil
	}
	if err := sc.Err(); err != nil {
		return 0, err
	}
	return 0, fmt.Errorf("readyz: /proc/meminfo 缺少 MemAvailable")
}
