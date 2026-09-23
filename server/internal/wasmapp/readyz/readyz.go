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
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
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
	// CacheMaxBytes / CacheMaxEntries 是编译器**生效**的回收阈值
	//（compile.Options.CacheMaxBytes 的快照，控制台可配之后会与编译期常量不同）。
	//
	// 为什么要放进快照（2026-09-23 P0）：超限判定若用编译期常量，而上限可由控制台/装配
	// 注入，两条判据就会分叉 —— 探针报"超限"、回收却认为"没超"，于是**回收永远删不掉**
	// 而 503 永久化（正是本次现场 P0 的形态之一）。0 ⇒ 调用方回落 limits 的编译期默认。
	CacheMaxBytes   int64
	CacheMaxEntries int
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
	// ExecCacheMode 报告**执行侧实际生效**的编译缓存模式（`disk` / `memory`）。
	//
	// 为什么它必须能被看见（2026-09-21 独立审计 P1-① 的可观测面）：磁盘缓存不可用时
	// 执行侧**降级为进程内缓存**（`runtime.NewCompilationCache` 返回 `(nil, nil)`，
	// `runtime.New` 换成 `wazero.NewCompilationCache()`）—— 这条"缓存不可用 ⇒ 慢一点"
	// 的取舍此前只有一行日志，容器里日志轮转后就再也查不到"这台实例的跨进程暖缓存
	// 其实没生效"。
	//
	// ⚠️ 取值**必须**来自运行时自己（`appserver.Server.RuntimeCacheMode` →
	// `runtime.Runtime.CacheMode`），不许在装配层按"目录看起来能不能建"重算一遍：
	// 第二个判断就是分叉本身（探针说 disk、实际跑 memory）。装配点只做 `string(...)`
	// 转换，不参与判定。
	//
	// nil ⇒ 字段为空串（"没注入"与"某一种模式"不可混淆）。
	ExecCacheMode func() string
	// CompileCacheMode 报告**编译侧实际生效**的编译缓存模式（`configured` / `temporary`）。
	//
	// 与 ExecCacheMode 同一纪律：取值来自 `compile.Compiler.CacheMode()`（唯一真源 =
	// 决定子进程 `-cache-dir` 的那个字段）。编译子系统不可用时**不报任何一种模式**
	// （空串）—— 此时 `compile_available=false` 已经说明了"没有编译面"，
	// 而"临时目录"与"没有编译器"是完全不同的两件事，不能混成一个值。
	CompileCacheMode func() string
	// ReclaimCompileCache 是**发布闸门的同步自愈钩子**（2026-09-23 现场 P0-b）。
	//
	// AllowPublish 命中"编译缓存超上限"这条阻塞理由时，先调它**同步回收一次再判**：
	// 超限曾把发布闸门关上，而唯一的回收触发点是"编译作业之后" ⇒ 闸门关上 ⇒ 没有编译
	// 作业 ⇒ 永不回收 ⇒ 超限永久化（现场实测：删掉缓存条目立刻恢复，不删就永不恢复）。
	//
	// 由装配层接到编译侧**唯一**的回收实现（`compile.Compiler.ReclaimCache`）；
	// readyz **不 import compile**（依赖方向：compile 不该知道探针，import 会成环），
	// 因此这里只认一个三返回值的函数签名。
	//
	// 返回值 = (删除条目数, 释放字节数, 错误)。err != nil 表示回收本身失败（权限/IO），
	// AllowPublish 会把它写进可行动文案；err == nil 但回收后仍超限 ⇒ 仍然 503。
	//
	// nil ⇒ 不做同步回收（保持"超限即拒绝"的旧语义；最小装配/单测可用），
	// 但拒绝文案会点名"装配层没有注入回收钩子"（装配缺失必须可见，不许静默降级）。
	ReclaimCompileCache func() (removed int, freed int64, err error)
	// Logger 记**只该进服务端日志**的东西（R5-A-5：驱动错误原文 / R5-A-4：回收的部分失败）。
	//
	// 为什么探针需要一个日志出口：`/readyz` 是**未认证端点**，响应体里只能有分类后的
	// 定性原因（同文件 CompileAvailability.Detail 的注释写的就是这条纪律：不要塞底层
	// 错误原文）—— 而"为什么不可达 / 哪一条删不掉"又必须留在机器上供排障。两者只能靠
	// "对外短语 + 服务端明细"分离，明细的落点就是这个 Logger。
	//
	// nil ⇒ 明细丢弃，但**对外仍然只给分类**：绝不因为"没接日志"就把原文吐出去
	// （fail-closed 的方向是"少说"，不是"多说"）。
	Logger func(format string, args ...any)
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
//
// 缓存模式维（`exec_cache_mode` / `compile_cache_mode`）：两侧的编译缓存都可能**降级**
// （执行侧磁盘缓存不可用 ⇒ 进程内缓存；编译侧缓存目录不可信 ⇒ 临时目录），而两条降级
// 此前都只有日志。这两个字段把"实际生效的模式"暴露出来，取值**只**来自运行时/编译器
// 自己的访问器（不许在装配层重算），因此不可能与"真的用了哪个缓存"分叉 ——
// 详见 Options.ExecCacheMode / Options.CompileCacheMode。
type Snapshot struct {
	OK      bool     `json:"ok"`
	Reasons []string `json:"reasons,omitempty"`
	// Actions 是**每一条 reason 的可行动文案**（R5-A-3）：取自发布闸门登记表
	// `publishBlockers` 的 `Action` 字段，与 Reasons 同序、只对"有 Action 的理由"产出。
	//
	// 为什么必须有这个字段：P0-c 的交付物是一张"每条阻塞理由都要回答谁来解除它"的
	// 登记表，但那段文案此前**只存在于 Go 源码里**（全仓唯一读者是断言它 ≥12 字的测试）——
	// 运维在 /readyz 与管理端只看得到 reason 字面量，于是"闸门关上之后谁来把它重新打开"
	// 在产品里仍然是空的。现在它是响应体的一部分（`actions`），并且 `AllowPublish`
	// 的 503 hints 也是由同一份登记表拼出来的（同一真源，不允许出现第二份处置文案）。
	//
	// 内容是**静态的运维指引**（不含任何水位/路径之外的信息），因此可以出现在未认证的
	// /readyz 上：它回答的是"该做什么"，而不是"这台机器现在是什么状态"。
	Actions          []string `json:"actions,omitempty"`
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
	MemBudgetOK      bool `json:"mem_budget_ok"`
	MemBudgetKnown   bool `json:"mem_budget_known"`
	CompileAvailable bool `json:"compile_available"`
	// ExecCacheMode 是执行侧**实际生效**的编译缓存模式：`disk` 或 `memory`。
	//
	// 制造它的那条降级（磁盘缓存不可用 ⇒ 进程内缓存）不是错误、也不影响功能，
	// 但它是"为什么这台实例每个应用首个请求都慢"的唯一答案，所以必须在探针上可读
	// （此前只有一行日志）。空串 = 装配层未注入提供者（与"某一模式"不可混淆）。
	ExecCacheMode string `json:"exec_cache_mode"`
	// CompileCacheMode 是编译侧**实际生效**的编译缓存模式：`configured` 或 `temporary`。
	//
	// `temporary` 表示发布期编译**不读也不写**配置的缓存目录（该目录被判不可信，
	// 见 compile.New）：编译功能照常，但缓存永不跨次复用。空串 = 无编译子系统
	// （看 compile_available）或装配层未注入。
	CompileCacheMode string `json:"compile_cache_mode"`
	CompileQueue     int    `json:"compile_queue_depth"`
	CompileBusy      bool   `json:"compile_busy"`
	CacheBytes       int64  `json:"compile_cache_bytes"`
	CacheFiles       int    `json:"compile_cache_files"`
	// CacheLimitBytes 是**生效**的磁盘编译缓存上限（与超限判定用的是同一个值）。
	//
	// 为什么必须下发：现场排障要看的是"现在多少 / 上限多少"（本条 P0 的现场证据就是
	// `编译缓存超上限：578263173 > 536870912`）。0 = 没有编译子系统（看 compile_available）。
	CacheLimitBytes int64 `json:"compile_cache_limit_bytes"`
	ExecRunning     int   `json:"exec_running"`
	ExecWaiting     int   `json:"exec_waiting"`
	// ExecLimit 是**生效**的全局执行槽上限（与"执行槽已满"的判定用的是同一个值）。
	//
	// 为什么必须下发（2026-09-23 R6-A-7）：`max_instances` 是控制台可配的运营参数，
	// 而"现在在跑几个 / 上限几个"只有放在一起才读得出水位；此前探针拿编译期常量
	// 判定，于是同一个 `exec_running` 在不同档位下会得到相反的结论。0 = 装配层没有
	// 注入调度器（这一维没有判定，不是"上限为 0"）。
	ExecLimit     int    `json:"exec_limit"`
	EventsDropped int64  `json:"events_dropped"`
	EventsFailed  int64  `json:"events_failed"`
	EventsWritten int64  `json:"events_written"`
	DBOK          bool   `json:"db_ok"`
	CheckedAt     string `json:"checked_at"`
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
// 2026-09-23（P0 自锁）起，过滤**不再自己写 HasPrefix**，而是查下面的登记表
// `publishBlockers`（唯一判据来源），并且每条 reason 都必须经 `Snapshot.addReason`
// 用这里的常量产出（判据见 publish_blocker_registry_test.go）。
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
	// reasonDiskLow：数据根所在磁盘余量低于红线 —— **阻塞发布**。
	reasonDiskLow = "磁盘余量不足"
	// reasonDiskUnreadable：磁盘余量读不出来 —— **阻塞发布**（读不到 ≠ 充足）。
	reasonDiskUnreadable = "磁盘余量不可读"
	// reasonQueueFull：编译队列满 —— **阻塞发布**（队列随在飞编译完成自然回落）。
	reasonQueueFull = "编译队列已满"
	// reasonCompileCacheOver：磁盘编译缓存超上限 —— **阻塞发布**，也是现场 P0 的
	// 自锁点（见 AllowPublish 的 healCompileCacheOverflow）。
	reasonCompileCacheOver = "编译缓存超上限"
	// reasonDBUnreachable：数据库 Ping 失败 —— **阻塞发布**。
	reasonDBUnreachable = "数据库不可达"
)

// PublishHealKind 是"谁来解除这条阻塞理由"的**封闭枚举**（自愈路径登记表的值）。
//
// 为什么要有这张表（P0-c 的常设判据）：现场 P0 的根因不是"某个判断写错了"，而是
// **新增一条阻塞理由时没有人回答"谁来解除它"** —— "编译缓存超上限"被写成阻塞项之后，
// 唯一的解除者是"编译作业之后的回收"，而闸门恰好把编译作业关上 ⇒ 自锁。
// 因此每条阻塞理由都必须在这里显式登记解除者，新增理由而没登记 ⇒ 判据红。
type PublishHealKind string

const (
	// HealPeriodicReclaim：**周期任务**解除（compile.StartReclaimLoop 每 5 分钟回收
	// 一次磁盘编译缓存；现场 P0-a 的修复）。
	HealPeriodicReclaim PublishHealKind = "periodic-task"
	// HealSyncReclaim：**请求路径上的同步自愈**解除（AllowPublish 命中缓存超限时先调
	// Options.ReclaimCompileCache 再判；现场 P0-b 的修复）。
	HealSyncReclaim PublishHealKind = "sync-reclaim"
	// HealSelfDraining：条件随平台继续干活自然回落 —— 无需人工，但登记项必须写清
	// "谁在推进"（不允许出现"等它自己好"这种没有主语的自愈）。
	HealSelfDraining PublishHealKind = "self-draining"
	// HealOperator：只能靠**运维介入** ⇒ 必须给可行动文案（publishBlocker.Action）。
	HealOperator PublishHealKind = "operator"
)

// publishBlocker 是一条 /readyz reason 的**发布语义登记**。
type publishBlocker struct {
	// Prefix 是 reason 前缀；collect() 产出的每一条 reason 都以某个登记的 Prefix 开头
	//（由 addReason 保证；"在却没登记 / 登记了却不在"两个方向都有判据）。
	Prefix string
	// BlocksPublish 表示它是否阻止发布。false ⇒ 只是"非阻塞说明项"，Why 必须解释为什么不拦。
	BlocksPublish bool
	// Heal 是解除者（BlocksPublish=true 时必填）。
	Heal PublishHealKind
	// Action 是可行动文案（Heal==HealOperator 时必填）：告诉运维"现在该做什么"。
	Action string
	// Why 记录这条登记的判断依据（尤其非阻塞项为什么不拦）。
	Why string
}

// publishBlockers 是**发布闸门的唯一判据表**。
//
// 语义：
//   - AllowPublish 用它决定哪些 reason 阻塞（不再自己写 HasPrefix）；
//   - 未登记的 reason ⇒ fail-closed 视为**阻塞**（安全方向：宁可不发布也不放行）；
//   - 每条登记项都必须能被 collect() 产出，且每条阻塞项都必须有解除者 ——
//     两个方向都由 publish_blocker_registry_test.go 常驻断言。
var publishBlockers = []publishBlocker{
	{
		Prefix: reasonDiskLow, BlocksPublish: true, Heal: HealOperator,
		Action: "释放数据根所在磁盘空间（编译缓存 <data_root>/" + limits.CompileCacheDirName +
			" 与调用事件表都会占用），或扩容后重启；余量低于 1 GiB 拒绝发布是刻意设计（§4.9）。" +
			"要清编译缓存请走进程内回收入口（ReclaimCache / CleanCache，见 /readyz 的 actions）；" +
			"**不要手工删除或改名 <data_root>/" + limits.CompileCacheDirName + " 目录本身**——" +
			"执行侧把它绑定为信任边界且不会重建，删掉之后所有冷编译会失败到重启",
		Why: "磁盘写满会让发布半途失败并留下不一致状态：这条没有自动解除者",
	},
	{
		Prefix: reasonDiskUnreadable, BlocksPublish: true, Heal: HealOperator,
		Action: "检查数据根路径是否存在、可 stat（挂载丢失、权限、只读文件系统都会走到这里）",
		Why:    "读不出余量 ≠ 余量充足：fail-closed 拒绝发布",
	},
	{
		Prefix: reasonCompileUnavailable, BlocksPublish: true, Heal: HealOperator,
		Action: "构建 cmd/picoaide-app-compile 并与 picoaide-server 放在同一目录（生产镜像还需 bubblewrap），" +
			"然后重启服务端（可用性在启动期判定）",
		Why: "没有编译器就没有发布（审计 P2-2）",
	},
	{
		Prefix: reasonQueueFull, BlocksPublish: true, Heal: HealSelfDraining,
		Action: "通常无需人工：编译 worker 持续消费队列，队列随在飞编译完成而回落；" +
			"若长期停留，说明 worker 卡在一次编译里（看 /readyz 的 compile_busy 与服务端日志）",
		Why: "有界队列是设计目标（§4.6），且它有真实消费者（worker）在推进 —— 与缓存超限不同",
	},
	{
		Prefix: reasonCompileCacheOver, BlocksPublish: true, Heal: HealSyncReclaim,
		Action: "发布闸门会**先同步回收一次再判**（P0-b），周期任务每 5 分钟也会回收（P0-a）；" +
			"若仍超限，请检查 <data_root>/" + limits.CompileCacheDirName +
			" 的写权限与磁盘余量。要手工清理只允许删**分片目录下的条目文件**" +
			"（如 `find <data_root>/" + limits.CompileCacheDirName + " -type f -delete`）；" +
			"**不要删除或改名缓存目录本身**：执行侧 wazero 的 fileCache 在构造期绑定它、" +
			"不会重建，删掉之后所有冷编译会失败到重启（唯一正确的恢复方式是进程内回收入口）",
		Why: "现场 P0 的自锁点：它曾把**唯一**的回收触发点（编译作业）关上 —— " +
			"所以它必须同时有周期回收与同步自愈两条出路",
	},
	{
		Prefix: reasonDBUnreachable, BlocksPublish: true, Heal: HealOperator,
		Action: "检查 PostgreSQL 连通性与连接池（发布要落版本行与审计）",
		Why:    "库不可达时发布必然失败，提前拒绝可避免半成品",
	},
	{
		Prefix: reasonExecutorFull, BlocksPublish: false, Heal: HealSelfDraining,
		Why: "发布不占执行槽；满载时连发布都做不了反而无法排障（§4.9 的原话）",
	},
	{
		Prefix: reasonMemUnavailable, BlocksPublish: false, Heal: HealOperator,
		Action: "无需人工：这是保留可部署性的降级路径（非 Linux 开发机/受限容器读不到 /proc 与 cgroup）；" +
			"要恢复内存自检请以 cgroup 限额运行或挂载 /proc",
		Why: "内存自检被跳过这件事已在 /readyz 与启动日志显式说明，不该再让发布链路不可用",
	},
}

// publishBlockerFor 返回 reason 对应的登记项（未登记 ⇒ ok=false）。
//
// 前缀匹配（而不是全等）：reason 会带附加说明（"：<现在值> > <阈值>"），前缀才是判据。
func publishBlockerFor(reason string) (publishBlocker, bool) {
	for _, b := range publishBlockers {
		if strings.HasPrefix(reason, b.Prefix) {
			return b, true
		}
	}
	return publishBlocker{}, false
}

// blocksPublish 判定一条 reason 是否阻止发布。
//
// ⚠️ 未登记 ⇒ **true**（fail-closed）：新增理由而忘了登记时，宁可不发布也不放行；
// 而"忘了登记"这件事由 publish_blocker_registry_test.go 的源码判据当场打红。
func blocksPublish(reason string) bool {
	b, ok := publishBlockerFor(reason)
	if !ok {
		return true
	}
	return b.BlocksPublish
}

// addReason 记一条 reason：prefix **必须**取自上面的 reason* 常量（登记表里的前缀），
// extra 是附加说明（可为空，通常以"："开头）。
//
// 为什么集中成一个方法（P0-c 的常设判据）：发布闸门的判据表要能**枚举** collect() 可能
// 产出的全部 reason；字符串拼接散落在各分支里无法枚举，也就无法回答"新增一条阻塞理由时
// 谁来解除它"。判据同时禁止再出现 `s.Reasons = append(...)` 的裸拼装。
func (s *Snapshot) addReason(prefix, extra string) {
	s.Reasons = append(s.Reasons, prefix+extra)
}

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
				s.addReason(reasonDiskLow, fmt.Sprintf("：%d 字节 < %d", free, int64(MinDiskFreeBytes)))
			}
		} else {
			s.OK = false
			s.addReason(reasonDiskUnreadable, ": "+err.Error())
		}
	}
	if c.opt.CompileAvailability != nil {
		ca := c.opt.CompileAvailability()
		s.CompileAvailable = ca.Available
		if !ca.Available {
			// 非阻塞说明项（对齐"执行槽已满"的先例）：ok 说的是执行面，编译可用性是
			// 发布面。但这条必须出现在 reasons 里，让"发布已禁用"在探针上**可读**，
			// 而不只是靠一个 bool 字段（审计 P2-2）。
			extra := ""
			if strings.TrimSpace(ca.Detail) != "" {
				extra = "：" + ca.Detail
			}
			s.addReason(reasonCompileUnavailable, extra)
		}
	}
	if c.opt.CompileCacheMode != nil {
		// 取值来自编译侧自己（见 Options.CompileCacheMode 的"不许重算"纪律）。
		s.CompileCacheMode = c.opt.CompileCacheMode()
	}
	if c.opt.Compiler != nil {
		cs := c.opt.Compiler()
		s.CompileQueue = cs.QueueDepth
		s.CompileBusy = cs.InFlight > 0 || cs.Running
		s.CacheBytes = cs.CacheBytes
		s.CacheFiles = cs.CacheFiles
		// 超限判定必须用**编译器自己的生效上限**，不是编译期常量：两者一旦分叉，
		// 探针会报"超限"而回收（按生效上限）认为"没超" ⇒ 回收永远删不掉、503 永久化。
		// 生效上限 = compile.Options.CacheMaxBytes（控制台可配之后随之变化）；
		// 快照没给（最小装配/旧调用点）时才回落到编译期常量。
		maxBytes := cs.CacheMaxBytes
		if maxBytes <= 0 {
			maxBytes = int64(limits.CompileCacheMaxBytes)
		}
		s.CacheLimitBytes = maxBytes
		if cs.QueueDepth >= limits.CompileQueueDepth {
			s.OK = false
			s.addReason(reasonQueueFull, fmt.Sprintf("：%d ≥ %d", cs.QueueDepth, limits.CompileQueueDepth))
		}
		if cs.CacheBytes > maxBytes {
			// 注意：这条理由**有两条自动解除路径**（周期回收 P0-a / 发布闸门的同步回收
			// P0-b，登记见 publishBlockers）。历史上的缺口是"只有编译作业之后才回收"，
			// 而这条理由本身会把编译作业关上 ⇒ 自锁。
			s.OK = false
			s.addReason(reasonCompileCacheOver, fmt.Sprintf("：%d > %d", cs.CacheBytes, maxBytes))
		}
	}
	if c.opt.Scheduler != nil {
		st := c.opt.Scheduler.Stats()
		s.ExecRunning = st.GlobalRunning
		s.ExecWaiting = st.Waiting
		// 判据必须用**生效上限**，不是编译期常量（2026-09-23 R6-A-7，接 2026-09-21
		// wasm-platform-gap-audit P1-④）：
		//   · `max_instances` 是管理端可配的运营参数（applimits，1..256，holder 在装配层），
		//     而 `limits.GlobalInstances` 只是它的编译期缺省值；
		//   · 两者一分叉，探针就会说反话 —— 配成 small 档（3）时"执行槽已满"永远不出现
		//     （运维盲区），配成 64 时在还剩 32 个空槽时就报满载（误报）。
		//   · 生效值只有一个来源：调度器自己的 s.opt（queue.Acquire / pumpAllLocked
		//     的准入判定读的就是它，控制台保存经 SetOptions 即时生效）。这里**不**
		//     复制那份解析（"档位 vs 控制台 vs 缺省"的解析在装配层），也不重算 ——
		//     与 CacheLimitBytes 同一条纪律：读数取自真正做判定的那个对象。
		// 快照没给（最小装配/旧调用点）时才回落到编译期常量（与 compile 侧同款兜底）。
		execLimit := c.opt.Scheduler.Options().GlobalRunning
		if execLimit <= 0 {
			execLimit = limits.GlobalInstances
		}
		s.ExecLimit = execLimit
		if st.GlobalRunning >= execLimit {
			// 满载不是"不健康"（§4.6：有界即设计目标）⇒ 只做**非阻塞**说明项，
			// 不置 OK=false；AllowPublish 也会过滤掉这一条（发布不占执行槽，
			// 满载时连发布都做不了反而无法排障）。
			s.addReason(reasonExecutorFull, fmt.Sprintf("：%d ≥ %d", st.GlobalRunning, execLimit))
		}
	}
	if c.opt.Events != nil {
		es := c.opt.Events()
		s.EventsDropped, s.EventsFailed, s.EventsWritten = es.Dropped, es.Failed, es.Written
	}
	if c.opt.ExecCacheMode != nil {
		// 执行侧模式同理：来自运行时自己的 CacheMode()，装配点只做 string 转换。
		s.ExecCacheMode = c.opt.ExecCacheMode()
	}
	// 内存维（R1-rt-1）：把读到的来源与数值暴露出来；读不到时显式说明"自检被跳过"。
	// 这是**非阻塞**说明项（见 reasonMemUnavailable），AllowPublish 也把它过滤掉。
	if c.opt.MemAvailable != nil {
		m := c.opt.MemAvailable()
		s.MemSource = string(m.Source)
		s.MemAvailableByte = m.Bytes
		if !m.Known() {
			extra := ""
			if strings.TrimSpace(m.Detail) != "" {
				extra = "：" + m.Detail
			}
			s.addReason(reasonMemUnavailable, extra)
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
			// R5-A-5：**只给分类后的原因**，绝不回显驱动原文。
			//
			// 驱动错误里带的是运维基础设施的标识：pgx 的连接错误逐字形如
			// `failed to connect to \`user=<PGUSER> database=<PGDB>\`: <host>:<port> (<hostname>): …`，
			// 而 /readyz 是**未认证端点**（cmd/server/main.go 直接 r.GET("/readyz", …)），
			// 同一批 reasons 还会进 AllowPublish 的 503 details ⇒ 任何能访问这两个面的人
			// 都能读到生产库的用户名/库名/地址。本文件自己的纪律写在
			// CompileAvailability.Detail 与 meminfo.go 的注释里（"不要塞底层错误原文"），
			// DB 这条此前是唯一的例外。
			//
			// 原文进服务端日志（可 grep，排障能力不降级）：Logger 未接线时**丢弃**，
			// 而不是退回"把原文放进响应体"。
			s.addReason(reasonDBUnreachable, "："+classifyDBError(err))
			c.logf("readyz: 数据库探针失败（分类=%s；原文仅进服务端日志，不进 /readyz）：%v",
				classifyDBError(err), err)
		} else {
			s.DBOK = true
		}
	}
	s.attachActions()
	return s
}

// classifyDBError 把数据库探针的错误**分类**成一句不含敏感信息的短语（R5-A-5）。
//
// 判据用错误链（errors.Is / net.Error / *net.DNSError）而不是驱动文案：文案会随驱动
// 版本变（pgx 5.10 与 6.x 的措辞就不同），而错误类型不会。分类之外**一个字都不回显** ——
// 不拼路径、不拼用户名、不拼地址（那正是本条要堵的洞）。
//
// 分类是**尽力而为**的：认不出来就统一给"连接失败"（宁可少说，不可多说）。
func classifyDBError(err error) string {
	if err == nil {
		return ""
	}
	switch {
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return "连接超时（探针预算内未完成）"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "连接被拒绝（数据库未在监听？）"
	case errors.Is(err, syscall.EHOSTUNREACH), errors.Is(err, syscall.ENETUNREACH):
		return "网络不可达"
	case errors.Is(err, syscall.EACCES), errors.Is(err, syscall.EPERM):
		return "认证或权限失败"
	case errors.Is(err, syscall.ECONNRESET), errors.Is(err, syscall.EPIPE):
		return "连接被重置"
	}
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return "域名解析失败"
	}
	var netErr net.Error
	if errors.As(err, &netErr) && netErr.Timeout() {
		return "连接超时（网络层超时）"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "连接目标不存在（套接字/主机名解析结果）"
	}
	return "连接失败"
}

// logf 是 nil 安全的日志出口（Options.Logger 未接线 ⇒ 丢弃）。
func (c *Checker) logf(format string, args ...any) {
	if c == nil || c.opt.Logger == nil {
		return
	}
	c.opt.Logger(format, args...)
}

// attachActions 把每条 reason 的**可行动文案**填进 s.Actions（R5-A-3）。
//
// 取值一律来自发布闸门登记表 `publishBlockers`（唯一真源）：没有登记的 reason 不会有
// 文案（而"未登记"这件事由 publish_blocker_registry_test.go 当场打红，不会静默溜过），
// 登记了但 Action 为空的（自愈类）也不产出 —— 那种情况下"谁来解除它"的答案是
// 机器（周期回收/同步回收/自然回落），不是运维。
func (s *Snapshot) attachActions() {
	for _, r := range s.Reasons {
		b, ok := publishBlockerFor(r)
		if !ok {
			continue
		}
		if line := blockerActionLine(b); line != "" {
			s.Actions = append(s.Actions, line)
		}
	}
}

// blockerActionLine 把一条登记项渲染成**运维可读的一行**（/readyz 的 actions 与
// AllowPublish 的 hints 共用同一份渲染：两处文案同源，第二份就是分叉的开始）。
func blockerActionLine(b publishBlocker) string {
	if strings.TrimSpace(b.Action) == "" {
		return ""
	}
	return fmt.Sprintf("%s（解除者：%s）：%s", b.Prefix, b.Heal, b.Action)
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
// 因此三类**非阻塞说明项**不阻止发布（判据来自 publishBlockers 登记表，不再自己写
// HasPrefix —— 见该表的注释）：
//   - 执行槽满载：发布不占执行槽（满载时连发布都做不了反而无法排障）；
//   - 未取到可用内存：这是"保留可部署性"的降级路径（读不到 /proc 与 cgroup 时不拦人），
//     它已经在启动日志与 /readyz 上**显式**说明，不该再让发布链路不可用；
//   - 编译子系统不可用：**会**阻止（没有编译器就没有发布）—— 它不是"说明项"而是
//     实打实的发布面缺失（审计 P2-2 的第二个要求）。
//
// **自锁解除（2026-09-23 现场 P0-b）**：命中"编译缓存超上限"时，先**同步回收一次再判**
// （Options.ReclaimCompileCache）。理由：超限曾把发布闸门关上，而唯一的回收触发点是
// "编译作业之后"——闸门关上 ⇒ 没有编译作业 ⇒ 永不回收 ⇒ 超限永久化（现场实测：删掉
// 缓存条目立刻恢复 200，不删就永久 503）。回收成功 ⇒ 放行；回收失败/仍超限 ⇒ 仍然 503，
// 但 reasons/hints 必须**可行动**（点名"回收失败/仍超限"、给出现在值与阈值）。
//
// ⚠️ 只对**这一条**理由做自愈重判：其余阻塞理由保持第一次采集的结果（不做二次采集），
// 因此磁盘/DB/编译可用性等 fail-closed 语义一字不改。
//
// HTTP 语义：返回的 `*apperr.Error` 显式带 503（Service Unavailable）——
// 这是"平台暂时不可用"而非"你的请求有问题"：500 会被当成服务端 bug、429 会被当成
// 客户端限流（并诱导客户端按 Retry-After 立刻重试，而磁盘低水位需要运维介入）。
func (c *Checker) AllowPublish() *apperr.Error {
	s := c.Snapshot()
	blocking := make([]string, 0, len(s.Reasons))
	cacheOver := false
	for _, reason := range s.Reasons {
		if !blocksPublish(reason) {
			continue
		}
		if strings.HasPrefix(reason, reasonCompileCacheOver) {
			cacheOver = true
		}
		blocking = append(blocking, reason)
	}
	var healHint string
	if cacheOver {
		healed, replacement, hint := c.healCompileCacheOverflow()
		healHint = hint
		if healed {
			blocking = dropReasonPrefix(blocking, reasonCompileCacheOver)
		} else {
			blocking = replaceReasonPrefix(blocking, reasonCompileCacheOver, replacement)
		}
	}
	if len(blocking) == 0 {
		return nil
	}
	e := apperr.New(apperr.CodeInternal, "平台当前不可用，已拒绝新的发布").
		WithDetail("reasons", blocking).
		WithDetail("compile_available", s.CompileAvailable).
		WithDetail("compile_cache_bytes", s.CacheBytes).
		WithDetail("compile_cache_limit_bytes", s.CacheLimitBytes).
		WithHint("这是 fail-closed 保护：磁盘/缓存/编译队列水位不足时接受发布会把平台推向不可恢复状态").
		WithHint("请在服务端查看 /readyz 的明细")
	// **可行动文案来自登记表**（R5-A-3）：P0-c 要求"每条阻塞理由都要回答谁来解除它"，
	// 那段文案此前只在源码里；现在它与 /readyz 的 actions 由同一份登记项渲染，
	// 因此"闸门关上之后谁能把它重新打开"在**对外面上是有答案的**。
	for _, line := range blockerActionLines(blocking) {
		e = e.WithHint(line)
	}
	if healHint != "" {
		e = e.WithHint(healHint)
	}
	e.HTTP = http.StatusServiceUnavailable
	return e
}

// blockerActionLines 把一组阻塞理由渲染成可行动提示（与 /readyz 的 actions 同源）。
func blockerActionLines(reasons []string) []string {
	out := make([]string, 0, len(reasons))
	for _, r := range reasons {
		b, ok := publishBlockerFor(r)
		if !ok {
			continue
		}
		if line := blockerActionLine(b); line != "" {
			out = append(out, line)
		}
	}
	return out
}

// dropReasonPrefix 返回去掉（前缀匹配的）某条 reason 之后的列表。
func dropReasonPrefix(reasons []string, prefix string) []string {
	out := make([]string, 0, len(reasons))
	for _, r := range reasons {
		if strings.HasPrefix(r, prefix) {
			continue
		}
		out = append(out, r)
	}
	return out
}

// replaceReasonPrefix 把（前缀匹配的）某条 reason 换成新文案（保留其余位置顺序）。
func replaceReasonPrefix(reasons []string, prefix, replacement string) []string {
	out := make([]string, 0, len(reasons))
	for _, r := range reasons {
		if strings.HasPrefix(r, prefix) {
			out = append(out, replacement)
			continue
		}
		out = append(out, r)
	}
	return out
}

// compileCacheLevel 读**生效**的缓存水位与上限（读不到 ⇒ 0, 0）。
//
// 取值一律来自装配注入的 Compiler 快照（与超限判定、与回收用的阈值同源）——
// 这里不自己 walk 目录，也不 import compile。
func (c *Checker) compileCacheLevel() (bytes int64, max int64) {
	if c.opt.Compiler == nil {
		return 0, 0
	}
	cs := c.opt.Compiler()
	max = cs.CacheMaxBytes
	if max <= 0 {
		max = int64(limits.CompileCacheMaxBytes)
	}
	return cs.CacheBytes, max
}

// healCompileCacheOverflow 对"编译缓存超上限"这条阻塞理由做一次**同步自愈**（P0-b）。
//
// 返回 (是否已解除, 仍阻塞时的可行动文案, 给调用方追加的 hint)。
//
// 失败方向一律 fail-closed：钩子未接线 / 回收报错 / 回收后仍超限 / 水位读不出来 ⇒
// 仍然阻塞，且文案点名"为什么没解除"并给出现在值与阈值（现场排障要的就是这三个数）。
//
// ⚠️ 口径纪律（R5-A-4）：**任何写进文案的数字都必须是回收后重新读到的**。
// 旧实现把判定用的第一次读数（回收**前**）当作"现在"，于是"一条删不掉、其余删够"时会
// 写出自相矛盾的 `现在 104857600 > 536870912`（假命题），把运维指向错误方向。
// 现在：回收后一律重读；只有重读值真的超限才写"仍超限"，否则按**已解除**处理并把
// "个别条目删不掉"降级为服务端日志（一条删不掉的条目不该把发布闸门永久关上）。
func (c *Checker) healCompileCacheOverflow() (ok bool, replacement string, hint string) {
	bytes, max := c.compileCacheLevel()
	if c.opt.ReclaimCompileCache == nil {
		// 装配缺失：保持"超限即拒绝"的旧语义，但必须让它可见（不许静默降级）。
		return false,
			fmt.Sprintf("%s（未接线回收钩子：装配层没有注入 ReclaimCompileCache，本闸门无法自愈；现在 %d > %d）",
				reasonCompileCacheOver, bytes, max),
			"装配层未注入缓存回收钩子（readyz.Options.ReclaimCompileCache）：发布闸门无法自愈，请核对 cmd/server 的装配"
	}
	removed, freed, err := c.opt.ReclaimCompileCache()
	// 回收**后**重新读数（无论成功还是失败）：文案里的"现在"必须是此刻的事实。
	after, afterMax := c.compileCacheLevel()
	if err != nil {
		if afterMax > 0 && after <= afterMax {
			// 回收报了错，但水位已经达标 ⇒ **判定已解除**：把"个别条目删不掉"降级为
			// 服务端日志。继续关着闸门只会让一个已达标的水位永久 503（正是 P0 的形态）。
			c.logf("readyz: 同步回收报错但水位已达标（删除 %d 条 / 释放 %d 字节；回收后 %d ≤ %d）：%v",
				removed, freed, after, afterMax, err)
			return true, "", ""
		}
		detail := "回收后水位不可读"
		if afterMax > 0 {
			detail = fmt.Sprintf("回收后 %d > %d", after, afterMax)
		}
		return false,
			fmt.Sprintf("%s（同步回收失败：%v；本次删除 %d 条 / 释放 %d 字节；%s）",
				reasonCompileCacheOver, err, removed, freed, detail),
			"缓存回收失败（服务端日志里有 " + reasonCompileCacheOver + " 的回收记录）：请检查 <data_root>/" +
				limits.CompileCacheDirName + " 的写权限与磁盘余量；**不要手工删除或改名缓存目录**——" +
				"请走进程内回收入口（ReclaimCache / CleanCache）或重启服务端"
	}
	if afterMax <= 0 {
		// 水位读不出来 ⇒ 无法证明已解除（读不到 ≠ 已达标）。
		return false,
			fmt.Sprintf("%s（同步回收后无法复核水位：编译器快照不可读；本次删除 %d 条 / 释放 %d 字节）",
				reasonCompileCacheOver, removed, freed),
			"无法复核回收后的缓存水位（编译器快照不可读）：请查看 /readyz 的 compile_cache_bytes 与 compile_available"
	}
	if after > afterMax {
		return false,
			fmt.Sprintf("%s（同步回收后仍超限：本次删除 %d 条 / 释放 %d 字节；现在 %d > %d）",
				reasonCompileCacheOver, removed, freed, after, afterMax),
			"同步回收已执行但仍超限（写入快于回收，或删除被拒）：请检查数据根剩余空间与 <data_root>/" +
				limits.CompileCacheDirName + " 的写权限"
	}
	return true, "", ""
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
