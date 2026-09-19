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
	//
	// 保留为**默认档**的数值；实际生效值由 MemoryPlan 给（部署可用
	// PICOAI_WASM_MEMORY_PROFILE 声明更小的档位，见 memprofile 包）。
	InstancePoolBytes = limits.GlobalInstances * limits.InstanceMemoryPages * limits.WasmPageSize
)

// MemoryPlan 是「内存四笔账」的**输入**（2026-09-18：从编译期常量改为可声明的档位）。
//
// 为什么要能声明：实例池这笔账 = 并发 × 单实例上限，是一个**最坏情况上界**。
// 32 × 64 MiB = 2 GiB 的上界让任何小于约 4 GB 的机器都过不了启动自检，
// 而唯一的补救路径过去是"重新构建镜像"。改成档位后，同一份数值同时驱动
// 启动自检与运行期强制（队列并发 / 实例内存上限 / 模块缓存上限 / 库句柄上限），
// 因此"声明的账"与"实际跑的账"不会分叉。
//
// 零值字段一律回落到默认档（DefaultMemoryPlan），保证既有调用点的语义不变。
type MemoryPlan struct {
	// Profile 是档位名（default / small / large；仅用于日志与 /readyz 展示）。
	Profile string
	// Instances 是全局并发实例上限（实例池那笔账的乘数）。
	Instances int
	// InstanceMemoryBytes 是单实例线性内存上限（字节）。
	InstanceMemoryBytes int64
	// ModuleCacheBytes 是**进程内**编译模块缓存上限（"缓存驻留"这笔账）。
	ModuleCacheBytes int64
	// CompilePeakBytes 是编译峰值这笔账（0 ⇒ 用 CompilePeakBytes 常量）。
	CompilePeakBytes int64
	// UploadPeakBytes 是上传峰值这笔账（0 ⇒ 用 limits.UploadPeakPerUploadBytes）。
	UploadPeakBytes int64
	// AppDBPageCachePerHandleBytes 是**每应用库句柄**的 SQLite 页缓存这笔账的单价
	// （0 ⇒ 用 DefaultAppDBPageCachePerHandleBytes）。
	//
	// 为什么是"单价 × Instances"而不是一个总数：句柄池容量 = max_instances
	// （appserver 的 newAppDBPoolWithMax(…, lim.MaxInstances)），所以这笔账的乘数与
	// 实例池那笔账**同一个**（plan.Instances）；控制台把 appdb_cache_kib / app_db_readers
	// 调大时，单价随之上抬，账本才不会"配到 272 GiB 还 ok:true"（R1-rt-8）。
	AppDBPageCachePerHandleBytes int64
}

// DefaultAppDBPageCachePerHandleBytes 是"每应用库句柄页缓存"的默认估算：
// (1 写 + limits.AppDBReaders 只读) 条连接 × 每条 1 MiB。
//
// 两个输入的默认值来源：只读连接数 = limits.AppDBReaders（真源）；
// 每连接页缓存 = appdb 的 appConnCacheKiB / applimits.Defaults().AppDBCacheKiB
// （两者由 applimits_test 的跨包断言钉住与这里同值 —— readyz 不能 import 那两个包：
// applimits 依赖本包，会成环）。生产路径一律由 applimits 传**生效值**，这里只是
// `ComputeMemoryBudget()`（无参数便捷入口）与最小装配的兜底。
const DefaultAppDBPageCachePerHandleBytes = int64(1+limits.AppDBReaders) * (1 << 20)

// DefaultMemoryPlan 返回默认档的四笔账输入（与 2026-09-18 之前的编译期常量逐一相同）。
func DefaultMemoryPlan() MemoryPlan {
	return MemoryPlan{
		Profile:                      "default",
		Instances:                    limits.GlobalInstances,
		InstanceMemoryBytes:          int64(limits.InstanceMemoryPages) * int64(limits.WasmPageSize),
		ModuleCacheBytes:             limits.ModuleCacheMaxBytes,
		CompilePeakBytes:             CompilePeakBytes,
		UploadPeakBytes:              limits.UploadPeakPerUploadBytes,
		AppDBPageCachePerHandleBytes: DefaultAppDBPageCachePerHandleBytes,
	}
}

// withDefaults 把零值字段补成默认档（调用方只填关心的一两项也不会算出错误的账）。
func (p MemoryPlan) withDefaults() MemoryPlan {
	d := DefaultMemoryPlan()
	if p.Profile == "" {
		p.Profile = d.Profile
	}
	if p.Instances <= 0 {
		p.Instances = d.Instances
	}
	if p.InstanceMemoryBytes <= 0 {
		p.InstanceMemoryBytes = d.InstanceMemoryBytes
	}
	if p.ModuleCacheBytes <= 0 {
		p.ModuleCacheBytes = d.ModuleCacheBytes
	}
	if p.CompilePeakBytes <= 0 {
		p.CompilePeakBytes = d.CompilePeakBytes
	}
	if p.UploadPeakBytes <= 0 {
		p.UploadPeakBytes = d.UploadPeakBytes
	}
	if p.AppDBPageCachePerHandleBytes <= 0 {
		p.AppDBPageCachePerHandleBytes = d.AppDBPageCachePerHandleBytes
	}
	return p
}

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
	// MemAvailable 可注入可用内存读取（默认 ReadMemoryAvailability：cgroup 感知 + 宿主回落）。
	//
	// 返回**带来源**的结构（host / cgroup / none）而不是裸字节数：来源必须出现在 `/readyz`
	// 上（审计 R1-rt-1 的判据是"读到了什么、从哪读到的"都要看得见）。单测注入临时路径的
	// 实现即可覆盖 cgroup v2 有上限 / v2=max / v1 / 全读不到四种形态。
	MemAvailable func() MemoryAvailability
	// MemoryPlan 提供**当前生效**的内存档位/账本输入（可为 nil ⇒ 档位维度不输出）。
	//
	// 为什么必须由装配层注入（R1-rt-10 的另一半）：档位不是本包能推导的东西 ——
	// 它来自"控制台设置 > 部署档位 > 编译期默认"的解析（cmd/server 的 wasmLimitsHolder）。
	// 不注入时 `mem_profile` 为空、理论峰值字段为 0：**"没有档位信息"与"档位是空字符串"
	// 不可区分**这件事以空值显式表达，绝不伪造一个默认档（那会正好掩盖 P0-2 要防的分叉：
	// 探针显示按默认档算账，实际跑的是控制台配置）。
	MemoryPlan func() MemoryPlan
}

// Snapshot 是 `/readyz` 的响应体。
//
// 语义分工（审计 P2-2 要求写清，且必须有断言钉住）：
//   - `ok` 回答"实例现在能不能**服务应用请求**"（执行面）：磁盘/缓存/队列/DB 不达标即
//     false；`compile_available=false` **不**把 ok 打成 false（编译是**发布面**的另一个
//     维度：没有编译器时子域请求照常服务，编排不该因此摘掉一个还在正常干活的实例）；
//   - `compile_available` 回答"发布链路能不能编译"：它必须可见（不再与健康态同形），
//     并且 AllowPublish 把它当**阻止发布**的理由（没有编译器就没有发布）。
//
// 内存维（R1-rt-1 / R1-rt-10）：`mem_source` / `mem_available_bytes` 回答"四笔账用的
// 可用内存是从哪读到的、数值多少"；`mem_profile` / `mem_budget_bytes` /
// `mem_budget_limit_bytes` / `mem_budget_ok` / `mem_budget_known` 回答"当前是哪一档、
// 理论峰值多少、按可用内存的允许水位判定结果如何"。`mem_source=none`（两个来源都读不到）
// ⇒ 内存自检被跳过，这件事以非阻塞 reason 显式说出来 —— 零水位与"未知"不能同形
// （那正是旧实现的 fail-open）。
type Snapshot struct {
	OK               bool     `json:"ok"`
	Reasons          []string `json:"reasons,omitempty"`
	DiskFreeByte     int64    `json:"disk_free_bytes"`
	MemSource        string   `json:"mem_source"`
	MemAvailableByte int64    `json:"mem_available_bytes"`
	// MemProfile 是本次判定用的内存档位名（空 = 装配层未注入档位提供者）。
	MemProfile string `json:"mem_profile"`
	// MemBudgetByte 是理论峰值（实例池 + 编译峰值 + 上传峰值 + 缓存驻留 + 库页缓存）。
	MemBudgetByte int64 `json:"mem_budget_bytes"`
	// MemBudgetLimitByte 是允许的上限（可用内存 × memory_peak_guard_percent%）。
	MemBudgetLimitByte int64 `json:"mem_budget_limit_bytes"`
	// MemBudgetOK / MemBudgetKnown 是判定结果与"是否真的判定过"
	//（known=false ⇒ 读不到可用内存，这一维没有判定，不是"判定通过"）。
	MemBudgetOK      bool   `json:"mem_budget_ok"`
	MemBudgetKnown   bool   `json:"mem_budget_known"`
	CompileAvailable bool   `json:"compile_available"`
	CompileQueue     int    `json:"compile_queue_depth"`
	CompileBusy      bool   `json:"compile_busy"`
	CacheBytes       int64  `json:"compile_cache_bytes"`
	CacheFiles       int    `json:"compile_cache_files"`
	ExecRunning      int    `json:"exec_running"`
	ExecWaiting      int    `json:"exec_waiting"`
	EventsDropped    int64  `json:"events_dropped"`
	EventsFailed     int64  `json:"events_failed"`
	EventsWritten    int64  `json:"events_written"`
	DBOK             bool   `json:"db_ok"`
	CheckedAt        string `json:"checked_at"`
	// SnapshotCached 报告这份读数是不是**缓存命中**（R1-rt-4）。
	//
	// 为什么必须可见：`/readyz` 现在有秒级缓存（limits.ReadyzSnapshotTTL），
	// 排障时要能区分"水位真的没变"与"你看到的是 ≤TTL 前的快照"。
	SnapshotCached bool `json:"snapshot_cached"`
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
	// reasonMemUnavailable：未取到可用内存 ⇒ 内存四笔账被跳过 —— **非阻塞**。
	//
	// 为什么不阻止发布、也不把 ok 打成 false：这是"保留可部署性"的那一半 ——
	// 非 Linux 开发机、受限容器都可能读不到 /proc/meminfo，拒绝启动/拒绝发布会让平台
	// 在这些环境里完全不可用。但"跳过"这件事必须**可见**（旧实现里它与"内存充足"
	// 逐字段同形，是本条审计认定的 fail-open）。
	reasonMemUnavailable = "未取到可用内存（跳过内存自检）"
)

// Checker 是水位探针。
//
// 两把锁刻意分开：
//   - `mu` 只保护 `lastFree`（水位读数，历史遗留）；
//   - `cacheMu` 保护**快照缓存**并充当单飞闸（见 snapshotCached）。
//
// 不合并成一把的理由：`Snapshot()`（不缓存的那条路，发布闸门与控制台预览在用）
// 会读 lastFree，若与缓存共用一把锁，采集期间持锁就变成"所有 Snapshot 串行"，
// 那正是我们要避免的（/readyz 与发布闸门互不等待）。
type Checker struct {
	opt Options

	mu       sync.Mutex
	lastFree int64

	cacheMu   sync.Mutex
	cached    Snapshot
	cachedAt  time.Time
	hasCached bool
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
		opt.MemAvailable = ReadMemoryAvailability
	}
	return &Checker{opt: opt}
}

// Snapshot 采集一次水位并给出是否达标与原因。
//
// ⚠️ **本方法永远做真活（不读缓存）**：发布闸门（AllowPublish）与控制台的内存账预览
// 要的是"此刻"的水位，缓存一份 ≤TTL 前的读数会让"磁盘刚满"在窗口内被放行。
// 需要缓存的调用点是 HTTP 处理（Handler，见 snapshotCached）。
func (c *Checker) Snapshot() Snapshot {
	s := c.collect()
	s.SnapshotCached = false
	return s
}

// snapshotCached 返回**带 TTL 的快照**（`/readyz` 处理路径专用），R1-rt-4。
//
// 为什么必须缓存：一次 collect 要做编译缓存目录的全量递归 walk（≤4096 条，
// 实测 ≈9.5–14 ms）+ statfs + db.Ping，而 `/readyz` 是**未认证**端点、监控每 1–5 s
// 打一次 ⇒ 每 1 s 一次 ≈1% 单核常驻 + 每秒 4096 次 Lstat + 每秒一次 DB 往返，
// 任意人都能放大。
//
// 单飞：持锁期间完成采集 ⇒ TTL 到点瞬间的并发请求里只有一个做真活，其余拿到
// 刚写好的同一份快照（旧实现是每个并发请求各做一遍真活）。
func (c *Checker) snapshotCached() Snapshot {
	ttl := limits.ReadyzSnapshotTTL
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	now := c.opt.Now()
	if c.hasCached && ttl > 0 && now.Sub(c.cachedAt) < ttl {
		s := c.cached
		s.SnapshotCached = true
		return s
	}
	s := c.collect()
	s.SnapshotCached = false
	c.cached, c.cachedAt, c.hasCached = s, now, true
	return s
}

// collect 采一次水位（不缓存、不加缓存锁）。
func (c *Checker) collect() Snapshot {
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
	// 内存维（R1-rt-1）：把读到的来源与数值暴露出来；读不到时显式说明"自检被跳过"。
	// 这是**非阻塞**说明项（见 reasonMemUnavailable），AllowPublish 也把它过滤掉。
	if c.opt.MemAvailable != nil {
		m := c.opt.MemAvailable()
		s.MemSource = string(m.Source)
		s.MemAvailableByte = m.Bytes
		if !m.Known() {
			reason := reasonMemUnavailable
			if strings.TrimSpace(m.Detail) != "" {
				reason += "：" + m.Detail
			}
			s.Reasons = append(s.Reasons, reason)
		}
		// 档位维（R1-rt-10）：哪一档、理论峰值多少、按可用内存判定的结果 ——
		// 与启动自检/控制台**同一份**输入、同一个判定函数（ComputeMemoryBudgetFor），
		// 因此探针上不可能出现"界面按档位显示、实际按别的数跑"。
		if c.opt.MemoryPlan != nil {
			plan := c.opt.MemoryPlan()
			b := ComputeMemoryBudgetFor(m.BudgetBytes(), plan)
			s.MemProfile = b.Profile
			s.MemBudgetByte = b.Total
			s.MemBudgetLimitByte = b.Limit
			s.MemBudgetOK = b.OK
			s.MemBudgetKnown = b.Known
		}
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
//
// 走**带 TTL 的快照缓存**（R1-rt-4）：这是未认证端点，不能每个请求都做全量目录
// walk + statfs + db.Ping。TTL 是 limits.ReadyzSnapshotTTL（唯一真源），响应体里
// 的 `snapshot_cached` 如实报告本次是不是缓存命中。
func (c *Checker) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s := c.snapshotCached()
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
// 因此三类**非阻塞说明项**不阻止发布：
//   - 执行槽满载：发布不占执行槽（满载时连发布都做不了反而无法排障）；
//   - 未取到可用内存：这是"保留可部署性"的降级路径（读不到 /proc 与 cgroup 时不拦人），
//     它已经在启动日志与 /readyz 上**显式**说明，不该再让发布链路不可用；
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
		if strings.HasPrefix(reason, reasonExecutorFull) || strings.HasPrefix(reason, reasonMemUnavailable) {
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
//
// 记账边界（2026-09-19 明确，P0-3）：这四笔账只覆盖**常驻/峰值**的四类占用
// （实例池 + 编译峰值 + 上传峰值 + 模块缓存驻留），**不含请求路径上的瞬时缓冲**。
// 最典型的一笔是"每次取版本元数据时是否顺带拉整份制品字节"：
//   - 旧实现每请求都查含 archive 的全列 ⇒ 单请求瞬时堆可达 `并发 × 制品上限`
//     （默认档 32 × 32 MiB ≈ 1 GiB），**四笔账里没有它**（它随并发瞬时出现、
//     随即释放，既不是常驻量、也不构成"启动前的理论峰值"，所以自检与预览都看不见）；
//   - 现实现（P0-3）请求路径只取不含 archive 的元数据投影，字节仅在**冷编译**那一刻
//     按需加载 ⇒ 这笔瞬时缓冲降为"每应用首个请求一次"，可忽略。
//
// 也就是说：它之所以不计入，是因为已经被**结构上**消除了，而不是被忽略了。
// 任何"让请求路径重新持有制品字节"的改动都必须回到这里重新算账
//（见 serverstore.wasmReleaseServeColumns 与 appserver.serveWasm 的注释）。
//
// 2026-09-19 追加（R1-rt-3）：请求热路径新增了 `(app_id, release_id)` 级的
// **资源/配置缓存**（appserver/releasecache.go），它同样**不进**这里的账，理由与
// 模块缓存不同、但边界同样硬：
//
//   - 它是**单一全局**的有界 LRU，硬上界写在 limits.ReleaseCacheMaxBytes 的注释里
//     （上限值 + 单个 release 的资源总量 ≤ SectionTotalMaxBytes + 条目元数据）；
//   - 它**可逐出**：容量越界按 LRU 整条释放、空闲超过 ModuleCacheIdleTTL 释放、
//     下架/冻结/删除/逐出（EvictApp）立即释放、换版本立即失效旧 release；
//   - 它不是"并发 × 实例"型的常驻上界（那才是本函数要联立的东西）：32 并发同时
//     访问 32 个不同应用，缓存的字节总量仍然只有 limits.ReleaseCacheMaxBytes。
//
// 因此它属于"有界可回收缓存"这一类（与磁盘编译缓存同性质），而不是第五笔账。
// 若将来把上限调大、或改成按并发/按实例多份，必须回到这里把它并入 Total。

// MemoryBudget 是四笔账（+ 应用库页缓存这笔）的分解（便于日志与探针展示）。
type MemoryBudget struct {
	// Profile 是本次判定用的内存档位名（default / small / large）。
	Profile       string `json:"profile"`
	Instances     int64  `json:"instances_bytes"`
	CompilePeak   int64  `json:"compile_peak_bytes"`
	UploadPeak    int64  `json:"upload_peak_bytes"`
	CacheResident int64  `json:"cache_resident_bytes"`
	// AppDBCache 是"应用库页缓存"这笔账（R1-rt-8）：
	// (1 + app_db_readers) × appdb_cache_kib × 句柄数（≤ max_instances）。
	//
	// 它过去**不在账里**（旧注释的理由是"可回收的缓存，不是实例"），于是控制台可以把
	// 组合配到 272 GiB 而保存判据一字不变。现在它是独立一笔（不并入模块缓存：两者的
	// 生命周期与失效路径完全不同，合并会让"调小哪一项"变得不可读）。
	AppDBCache int64 `json:"appdb_cache_bytes"`
	Total      int64 `json:"total_bytes"`
	Available  int64 `json:"available_bytes"`
	// Known 报告 Available 是不是**真的读到的**（false = 读不到 ⇒ 未判定）。
	//
	// 旧实现把"读不到"与"内存充足"表达成同一个 ok=true，控制台与 /readyz 都区分不出来
	// （R1-rt-1 的 fail-open）。现在 ok 旁边多了这个字段：`known=false, ok=true` 的
	// 含义是"没有判定"，而不是"判定通过"。
	Known bool `json:"known"`
	// Limit 是允许的上限（可用内存 × limits.MemoryPeakGuardPercent%）。
	Limit int64 `json:"limit_bytes"`
	OK    bool  `json:"ok"`
}

// ComputeMemoryBudget 计算**默认档**的理论峰值并判定是否超过可用内存的允许比例。
//
// availableBytes < 0（MemoryUnknown）表示"读不到可用内存" ⇒ **不判定**（返回 OK=true
// 且 Known=false），因为"读不到就拒绝启动"会让容器/受限环境无法部署；此时由部署文档兜住，
// 并且调用方**必须**把"跳过自检"这件事写进启动日志与 /readyz（不许静默）。
// availableBytes == 0 是**真的没有可用内存** ⇒ 判定失败（fail-loud）。
func ComputeMemoryBudget(availableBytes int64) MemoryBudget {
	return ComputeMemoryBudgetFor(availableBytes, DefaultMemoryPlan())
}

// ComputeMemoryBudgetFor 按给定档位计算理论峰值并判定（§4.3 内存四笔账 + 页缓存一笔）。
func ComputeMemoryBudgetFor(availableBytes int64, plan MemoryPlan) MemoryBudget {
	p := plan.withDefaults()
	b := MemoryBudget{
		Profile:       p.Profile,
		Instances:     int64(p.Instances) * p.InstanceMemoryBytes,
		CompilePeak:   p.CompilePeakBytes,
		UploadPeak:    p.UploadPeakBytes,
		CacheResident: p.ModuleCacheBytes,
		// 页缓存的乘数与实例池同一份（句柄数 ≤ max_instances = plan.Instances）。
		AppDBCache: int64(p.Instances) * p.AppDBPageCachePerHandleBytes,
		Available:  availableBytes,
	}
	b.Total = b.Instances + b.CompilePeak + b.UploadPeak + b.CacheResident + b.AppDBCache
	if availableBytes < 0 {
		b.Known = false
		b.OK = true
		return b
	}
	b.Known = true
	b.Limit = availableBytes * limits.MemoryPeakGuardPercent / 100
	b.OK = b.Total <= b.Limit
	return b
}

// CheckStartupMemory 是启动自检入口（默认档）：不达标返回错误（调用方 log.Fatal）。
func CheckStartupMemory(availableBytes int64) (MemoryBudget, *apperr.Error) {
	return CheckStartupMemoryFor(availableBytes, DefaultMemoryPlan())
}

// CheckStartupMemoryFor 是按档位的启动自检入口。
func CheckStartupMemoryFor(availableBytes int64, plan MemoryPlan) (MemoryBudget, *apperr.Error) {
	b := ComputeMemoryBudgetFor(availableBytes, plan)
	if b.OK {
		return b, nil
	}
	return b, apperr.New(apperr.CodeInternal, "理论内存峰值超过可用内存的安全水位，拒绝启动").
		WithDetail("total_bytes", b.Total).
		WithDetail("limit_bytes", b.Limit).
		WithDetail("available_bytes", b.Available).
		WithDetail("profile", b.Profile).
		WithDetail("guard_percent", limits.MemoryPeakGuardPercent).
		WithHint("§4.3 要求内存四笔账联立：实例池 + 编译峰值 + 上传峰值 + 缓存驻留").
		WithHint("两条出路：①扩容机器内存；②用 PICOAI_WASM_MEMORY_PROFILE 声明更小的档位" +
			"（small = 3 并发 / 64 MiB 实例 / 64 MiB 模块缓存，适合 2 GB 级机器）")
}

// ===== 平台相关读取 =====

func diskFree(path string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// 可用内存的读取实现只有一份：ReadMemoryAvailabilityAt（meminfo.go）。
//
// 这里曾经有第二份 memAvailable()（只看 /proc/meminfo），注释还断言"容器里也反映
// cgroup 限制后的可用量" —— 与事实相反（容器里读到的是宿主可用内存），而它本身零调用方
// （R1-rt-1 的死代码）。已删除：重复实现与错误注释都会让下一个人算错这笔账。
