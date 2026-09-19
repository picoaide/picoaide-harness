// Package applimits 是 WASM 应用平台「运行期可配置限制项」的**唯一模型**：
// 并发（全局/单应用/单用户）与内存（单实例上限、进程内模块缓存、空闲回收、
// 应用库连接与页缓存）。
//
// 为什么需要它（2026-09-19 用户要求「并发应用数量、应用允许内存占用…需要后台有个
// 配置页面」）：这些数值过去全是 limits 包的编译期常量 —— 改一次要重新构建镜像；
// 2026-09-18 先做成了**部署档位**（memprofile，一个环境变量），但"控制台里看不到、
// 改不了"这件事没解决。现在把它们变成**平台设置**（PG settings，键 wasm.limits）：
//
//	优先级：控制台保存的 JSON > 部署档位（PICOAI_WASM_MEMORY_PROFILE）> 编译期默认
//
// 三条纪律（与既有 §5.5「数值单一真源」不冲突 —— limits 仍是**默认值**的唯一来源）：
//  1. 模型只有这一份：校验、序列化、四笔账预览、重启判定都从这里出；
//  2. 保存路径 **fail-loud**：超范围直接拒；四笔账（实例池+编译峰值+上传峰值+缓存驻留）
//     超过可用内存的 70% 也拒（与启动自检同一判据，不给"先跑起来再说"的口子）；
//  3. 「热生效」与「需重启」必须说清楚：单实例内存上限是 wazero **RuntimeConfig**
//     的字段（进程内 runtime 建好后不可变）⇒ 保存后标注需重启；其余可即时下发。
package applimits

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// Limits 是全部可配置限制项（JSON 形态即落库形态，字段名是**跨语言契约**：
// webadmin 表单与它逐字对齐）。
type Limits struct {
	// ---- 并发 ----
	// MaxInstances 是全局并发实例上限（同时驱动请求队列与进程内库句柄上限）。
	MaxInstances int `json:"max_instances"`
	// AppRunning 是同一应用同时运行的请求数。
	AppRunning int `json:"app_running"`
	// AppQueue 是同一应用允许的排队长度（含在跑）。
	AppQueue int `json:"app_queue"`
	// UserGlobalRunning 是单用户跨应用的并发上限。
	UserGlobalRunning int `json:"user_global_running"`
	// UserPerAppRunning 是单用户在同一应用内的并发上限。
	UserPerAppRunning int `json:"user_per_app_running"`
	// UserPerAppQueued 是单用户在同一应用队列里的占位上限。
	UserPerAppQueued int `json:"user_per_app_queued"`

	// ---- 内存 ----
	// InstanceMemoryMB 是单实例线性内存上限（MiB）。
	// ⚠️ wazero 的该字段属于 RuntimeConfig ⇒ **保存后需重启服务端生效**。
	InstanceMemoryMB int `json:"instance_memory_mb"`
	// ModuleCacheMB 是进程内编译模块缓存上限（MiB）。
	ModuleCacheMB int `json:"module_cache_mb"`
	// ModuleCacheIdleMin 是编译模块空闲回收时间（分钟）。
	ModuleCacheIdleMin int `json:"module_cache_idle_min"`
	// AppDBIdleMin 是应用库句柄空闲回收时间（分钟）。
	AppDBIdleMin int `json:"appdb_idle_min"`
	// AppDBCacheKiB 是每条 SQLite 连接的页缓存上限（KiB）。下一个新建连接生效。
	AppDBCacheKiB int `json:"appdb_cache_kib"`
	// AppDBReaders 是每个应用库句柄持有的**只读连接数**（§4.5「连接级只读分层」）。
	//
	// 语义（不要把"下一个句柄生效"读成"要重启"）：只读连接必须在 appdb 建库的
	// **一次性令牌窗口**内一次建满（窗口关闭后新建的连接会被连接钩子 fail-closed，
	// 见 appdb.Options.Readers）⇒ 它不可能按负载弹性扩缩。保存后**下一个新建的
	// 应用库句柄**按新值建连生效（与 appdb_cache_kib 同档：都是"下一次建连"，
	// 既不阻塞保存、也不要求重启）；已有句柄在空闲回收（appdb_idle_min）或污染回收
	// 重建时自然拿到新值。
	//
	// 它决定"同一应用能同时跑多少条 SELECT"（WAL 下真正并发），写仍由 appdb 的
	// writeMu 串行 ⇒ 加的是读者，不是写者。
	AppDBReaders int `json:"app_db_readers"`
}

// Defaults 返回编译期默认值（与历史行为逐值一致；limits 包仍是默认值唯一来源）。
func Defaults() Limits {
	return Limits{
		MaxInstances:       limits.GlobalInstances,
		AppRunning:         limits.AppRuntimeConcurrency,
		AppQueue:           limits.AppQueueDepth,
		UserGlobalRunning:  limits.UserGlobalRunning,
		UserPerAppRunning:  limits.UserPerAppRunning,
		UserPerAppQueued:   limits.UserPerAppQueued,
		InstanceMemoryMB:   limits.InstanceMemoryPages * limits.WasmPageSize >> 20,
		ModuleCacheMB:      int(limits.ModuleCacheMaxBytes >> 20),
		ModuleCacheIdleMin: int(limits.ModuleCacheIdleTTL.Minutes()),
		AppDBIdleMin:       3,
		AppDBCacheKiB:      1024,
		AppDBReaders:       limits.AppDBReaders,
	}
}

// FromProfile 把部署档位（memprofile）折算成限制项：并发、单实例上限、模块缓存随档位，
// 其余取默认（档位只管内存四笔账里的三笔）。
//
// 折算后必须**仍然自洽**（2026-09-19）：档位可以把全局并发压到 3（small），而默认值里
// 有几项是"相对全局并发"的上限（app_running / user_global_running 默认 4，
// user_per_app_running 相对 app_running）——不钳位就会出现 app_running(4) > max_instances(3)
// 这种**自身非法**的 Limits：控制台 GET 出来再原样保存会被 Validate 拒（"必须提交完整对象"
// 却永远提交不过），装配期也只能靠"全局上限恰好更小"兜住，语义上不可解释。
// 钳位只向下取小，不会把档位放大。
func FromProfile(p memprofile.Profile) Limits {
	l := Defaults()
	if p.Instances > 0 {
		l.MaxInstances = p.Instances
	}
	if p.InstanceMemoryPages > 0 {
		l.InstanceMemoryMB = int(p.InstanceMemoryPages) * limits.WasmPageSize >> 20
	}
	if p.ModuleCacheBytes > 0 {
		l.ModuleCacheMB = int(p.ModuleCacheBytes >> 20)
	}
	return l.clampCrossField()
}

// clampCrossField 把"相对上限"的字段钳进它们各自的宿主上限（只向下，不改默认语义）。
//
// 与 Validate 是同一批序关系：Validate 负责"拒绝非法输入"，这里负责"让内部折算结果合法"。
// 两者共用同一组判据顺序（先全局、再应用内、最后用户级）。
func (l Limits) clampCrossField() Limits {
	if l.MaxInstances > 0 {
		if l.AppRunning > l.MaxInstances {
			l.AppRunning = l.MaxInstances
		}
		if l.UserGlobalRunning > l.MaxInstances {
			l.UserGlobalRunning = l.MaxInstances
		}
	}
	if l.UserPerAppRunning > l.AppRunning {
		l.UserPerAppRunning = l.AppRunning
	}
	if l.UserPerAppQueued > l.AppQueue {
		l.UserPerAppQueued = l.AppQueue
	}
	return l
}

// 取值范围（**保存路径的硬边界**）。上下限都取"能跑起来"的保守值：
// 下限防止把平台调到不可用（0 并发、1 MiB 实例内存），上限防止一个手滑把机器打爆。
const (
	MinInstances        = 1
	MaxInstances        = 256
	MaxAppQueue         = 4096
	MinInstanceMemoryMB = 16
	MaxInstanceMemoryMB = 1024
	MinModuleCacheMB    = 8
	MaxModuleCacheMB    = 4096
	MaxIdleMin          = 24 * 60
	MinAppDBCacheKiB    = 128
	MaxAppDBCacheKiB    = 64 << 10
)

// Validate 校验取值范围与内部一致性（fail-loud；返回可直接回控制台的错误信封）。
func (l Limits) Validate() *apperr.Error {
	bad := func(field, msg string) *apperr.Error {
		return apperr.New(apperr.CodeValidation, msg).WithDetail("field", field)
	}
	switch {
	case l.MaxInstances < MinInstances || l.MaxInstances > MaxInstances:
		return bad("max_instances", fmt.Sprintf("全局并发实例数必须在 %d–%d 之间", MinInstances, MaxInstances)).
			WithHint("它同时决定进程内应用库句柄上限；小机器建议 3–8")
	case l.AppRunning < 1 || l.AppRunning > l.MaxInstances:
		return bad("app_running", "单应用并发必须在 1 与全局并发之间").
			WithHint("同一应用最多 N 个请求同时在跑（读并发；写仍串行）。小于 N 的请求进队列、" +
				"队列满才 429；调大不增加内存上界（实例池由全局并发封顶）")
	case l.AppQueue < 1 || l.AppQueue > MaxAppQueue:
		return bad("app_queue", fmt.Sprintf("单应用队列长度必须在 1–%d 之间", MaxAppQueue))
	case l.UserGlobalRunning < 1 || l.UserGlobalRunning > MaxInstances:
		return bad("user_global_running", "单用户跨应用并发必须在 1 与全局并发之间")
	case l.UserPerAppRunning < 1 || l.UserPerAppRunning > l.AppRunning:
		return bad("user_per_app_running", "单用户单应用并发必须在 1 与单应用并发之间")
	case l.UserPerAppQueued < 1 || l.UserPerAppQueued > l.AppQueue:
		return bad("user_per_app_queued", "单用户单应用排队上限必须在 1 与单应用队列之间")
	case l.InstanceMemoryMB < MinInstanceMemoryMB || l.InstanceMemoryMB > MaxInstanceMemoryMB:
		return bad("instance_memory_mb", fmt.Sprintf("单实例内存上限必须在 %d–%d MiB 之间", MinInstanceMemoryMB, MaxInstanceMemoryMB)).
			WithHint("Go 应用常驻堆通常 8 MiB 起；Zig 工具链默认初始内存 16.4 MiB ⇒ 低于 16 MiB 会让部分应用跑不起来")
	case l.ModuleCacheMB < MinModuleCacheMB || l.ModuleCacheMB > MaxModuleCacheMB:
		return bad("module_cache_mb", fmt.Sprintf("模块缓存上限必须在 %d–%d MiB 之间", MinModuleCacheMB, MaxModuleCacheMB))
	case l.ModuleCacheIdleMin < 1 || l.ModuleCacheIdleMin > MaxIdleMin:
		return bad("module_cache_idle_min", fmt.Sprintf("模块空闲回收必须在 1–%d 分钟之间", MaxIdleMin))
	case l.AppDBIdleMin < 1 || l.AppDBIdleMin > MaxIdleMin:
		return bad("appdb_idle_min", fmt.Sprintf("应用库空闲回收必须在 1–%d 分钟之间", MaxIdleMin))
	case l.AppDBCacheKiB < MinAppDBCacheKiB || l.AppDBCacheKiB > MaxAppDBCacheKiB:
		return bad("appdb_cache_kib", fmt.Sprintf("SQLite 页缓存必须在 %d–%d KiB 之间", MinAppDBCacheKiB, MaxAppDBCacheKiB))
	case l.AppDBReaders < 1 || l.AppDBReaders > limits.AppDBReadersMax:
		// 上界用 limits.AppDBReadersMax（=16）而不是本地新常量：它是**注入值的钳位**，
		// 唯一真源在 limits（§5.5），这里再抄一份数字就会两处漂移。
		return bad("app_db_readers", fmt.Sprintf("每应用只读连接数必须在 1–%d 之间", limits.AppDBReadersMax)).
			WithHint("它决定同一应用能同时跑多少条 SELECT（WAL 下真正并发），写仍串行；" +
				"每个只读连接各占一份页缓存（appdb_cache_kib）与一个 fd ⇒ 调大会线性抬高常驻，且**下一个应用库句柄**才生效")
	}
	return nil
}

// InstanceMemoryPages 返回 wazero 需要的页数（页大小 = limits.WasmPageSize）。
func (l Limits) InstanceMemoryPages() uint32 {
	if l.InstanceMemoryMB <= 0 {
		return limits.InstanceMemoryPages
	}
	return uint32(l.InstanceMemoryMB) * (1 << 20) / uint32(limits.WasmPageSize)
}

// Budget 计算四笔账（并发×实例上限 + 编译峰值 + 上传峰值 + 模块缓存），
// 与启动自检**同一判据**（availableBytes ≤ 0 ⇒ 不判定）。
//
// # 这笔账里**没有**SQLite 页缓存，去处写在这里（不静默漏掉）
//
// 四笔账的构成来自 readyz.MemoryPlan，只有四项：实例池、编译峰值、上传峰值、
// 模块缓存驻留。应用库的页缓存**从来不在其中**（appdb_cache_kib 当初进配置面时也不在），
// 它的上界是另一条独立的乘积式：
//
//	appdb_cache_kib × (1 + app_db_readers) × 应用库句柄数（≤ max_instances）
//
// 默认配置（1024 KiB × 5 × ≤32）= 160 MiB 的**最坏情况**常驻，且只在"这么多应用
// 同时被访问过"时才可能达到（句柄按 appdb_idle_min 空闲回收）。它不进四笔账的理由：
// 它是"缓存"而不是"实例"（可回收、不构成 OOM 的直接原因），且与其它三笔不同量级；
// 但**扩大 app_db_readers 会线性抬高这条上界**（16 时最坏 544 MiB），所以
// Validate 的 app_db_readers 分支把这件事写进 hint，控制台改这一项时要一并看页缓存。
//
// 标签用默认的 "settings"；需要如实反映来源时用 BudgetFor。
func (l Limits) Budget(availableBytes int64) readyz.MemoryBudget {
	return l.BudgetFor(availableBytes, "settings")
}

// BudgetFor 与 Budget 同公式，只是把"这套数值来自哪里"写进结果的 Profile 字段。
//
// 为什么要有它（P0-2）：Budget 原先**硬写** "settings"，于是无论数值实际来自控制台
// 设置、部署档位还是编译期默认，四笔账里都写着 settings —— 与视图里的 source 字段
// 互相矛盾（"来源：部署档位" 旁边写 "profile: settings"）。而"当前值来自哪个档位"
// 恰恰是排查"我改了设置为什么没生效"的第一现场信息。
//
// profile 为空 ⇒ 回落 "settings"（不改变既有调用方的语义）。
func (l Limits) BudgetFor(availableBytes int64, profile string) readyz.MemoryBudget {
	if strings.TrimSpace(profile) == "" {
		profile = "settings"
	}
	return readyz.ComputeMemoryBudgetFor(availableBytes, readyz.MemoryPlan{
		Profile:             profile,
		Instances:           l.MaxInstances,
		InstanceMemoryBytes: int64(l.InstanceMemoryMB) << 20,
		ModuleCacheBytes:    int64(l.ModuleCacheMB) << 20,
	})
}

// NeedsRestart 报告从 cur 改到 next 时**必须重启**的字段（空 = 全部可即时生效）。
//
// 只有单实例内存上限属于这一类：它是 wazero RuntimeConfig 的字段，而执行侧 runtime
// 是进程内单例、建好之后不可变（见 runtime.NewRuntimeConfig 的注释）。
// 其余字段都能即时下发：队列上限（Scheduler.SetOptions）、模块缓存上限与空闲 TTL
// （moduleCache.SetBounds）、库句柄上限与空闲回收（appDBPool.SetLimits）。
// 另有两个"下次生效"的软字段（既不阻塞保存，也不要求重启）：
//   - appdb_cache_kib —— 连接级 PRAGMA，只影响**新建**的连接；
//   - app_db_readers —— 只读连接必须在 appdb 建库的一次性令牌窗口内一次建满
//     （见 appdb.Options.Readers），因此只影响**下一个新建的应用库句柄**；
//     已有句柄在空闲回收/污染回收重建时生效（下发路径：appDBPool.SetReaders）。
func NeedsRestart(cur, next Limits) []string {
	var out []string
	if cur.InstanceMemoryMB != next.InstanceMemoryMB {
		out = append(out, "instance_memory_mb")
	}
	return out
}

// Encode 序列化（落库形态；字段顺序稳定，便于 diff 与人读）。
func (l Limits) Encode() string {
	b, _ := json.Marshal(l)
	return string(b)
}

// Parse 解析控制台提交的 JSON（空串 = 回到默认值）。
//
// 严格模式：未知字段直接报错（"我改了但没生效"通常就是拼错了字段名，静默忽略会让
// 运维在错误的前提上排查）；解析后校验范围与一致性。
func Parse(raw string) (Limits, *apperr.Error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return Defaults(), nil
	}
	// 先按"字段集合必须完整"校验：缺字段会被解码成 0，然后在校验里报成
	// **另一个字段**超范围（例如只提交 instance_memory_mb 时报"并发必须在 1–256"），
	// 排障时完全指错方向。这里先点名缺失/多余的字段，再谈取值范围。
	var probe map[string]json.RawMessage
	if err := json.Unmarshal([]byte(s), &probe); err != nil {
		return Limits{}, apperr.New(apperr.CodeValidation, "限制项 JSON 不合法").
			WithDetail("reason", err.Error()).
			WithHint("提交 GET /limits 里 limits 的完整对象")
	}
	for _, f := range FieldNames() {
		if _, ok := probe[f]; !ok {
			return Limits{}, apperr.New(apperr.CodeValidation, "限制项缺少字段："+f).
				WithDetail("field", f).
				WithDetail("missing", true).
				WithHint("必须提交完整对象（GET 的 limits 原样改值即可），不支持只提交片段")
		}
	}
	if len(probe) != len(FieldNames()) {
		for k := range probe {
			known := false
			for _, f := range FieldNames() {
				if f == k {
					known = true
					break
				}
			}
			if !known {
				return Limits{}, apperr.New(apperr.CodeValidation, "限制项含未知字段："+k).
					WithDetail("field", k).
					WithHint("字段名以 GET /limits 的 limits 为准（拼错字段名会让改动静默不生效）")
			}
		}
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(s)))
	dec.DisallowUnknownFields()
	var l Limits
	if err := dec.Decode(&l); err != nil {
		return Limits{}, apperr.New(apperr.CodeValidation, "限制项 JSON 不合法").
			WithDetail("reason", err.Error()).
			WithHint("提交完整对象（字段见 GET 的 limits），不要提交片段；未知字段会被拒绝")
	}
	if err := l.Validate(); err != nil {
		return Limits{}, err
	}
	return l, nil
}

// ParseStored 解析**已落库**的限制项（读取路径专用；与 Parse 的严格模式不同）。
//
// 为什么需要它（2026-09-19）：字段集合随版本增长（本轮新增 app_db_readers），而
// 已发布的 v2.7.6-beta.4 里 `settings.wasm.limits` 存的是**旧字段集合**。
// 把 Parse 的"字段必须完整"纪律用在**读取**上，升级就会把管理员保存过的整份设置判为
// 非法并整体回落部署档位（现场形态：启动日志一条"已保存的平台限制项不合法，已回落到
// 部署档位"，随后并发/内存全部变回档位值 —— 管理员看到的是"我的设置没了"）。
// 因此读取路径改成**前向兼容**：
//
//   - **缺失字段 ⇒ 用默认值补齐**（新版本新增的字段在老设置里必然缺失）；
//   - **未知字段 ⇒ 忽略**（回滚场景：新版本写入的字段在老二进制里不认识，
//     但已知字段仍应生效，而不是整份设置作废）。
//
// 校验**不打折**：补齐后的整份值仍走 Validate()（范围 + 序关系），非法即报错。
// 严格模式（Parse）保持原样并继续只服务控制台 PUT："提交片段"与"拼错字段名"必须在
// 写入侧就被挡住，那是它的职责。
//
// 代价（认账）：如果有人手工改库写进拼错的字段名，读取路径会静默用默认值补齐该字段
// （写入侧不存在这条路径 —— 控制台 PUT 走的是 Parse）。
func ParseStored(raw string) (Limits, *apperr.Error) {
	s := strings.TrimSpace(raw)
	if s == "" {
		return Defaults(), nil
	}
	// 注意解码语义：json.Unmarshal 只覆盖 JSON 里出现的字段，其余保留 l 的现值
	//（= Defaults()）—— 这正是"缺失字段补默认"的实现，不需要额外的字段遍历。
	l := Defaults()
	if err := json.Unmarshal([]byte(s), &l); err != nil {
		return Limits{}, apperr.New(apperr.CodeValidation, "已保存的限制项 JSON 无法解析").
			WithDetail("reason", err.Error()).
			WithHint("这条设置由控制台写入；解析失败通常意味着有人手工改过库，重新保存一次即可")
	}
	if err := l.Validate(); err != nil {
		return Limits{}, err
	}
	return l, nil
}

// Range 是一个字段的取值区间（控制台表单用它做即时校验与提示）。
type Range struct {
	Min  int    `json:"min"`
	Max  int    `json:"max"`
	Unit string `json:"unit"`
	// Restart 为 true 表示该字段改动需要重启服务端才生效。
	Restart bool `json:"restart"`
}

// Ranges 返回全部字段的取值区间（**与 Validate 同一批常量**，不另写一份数字）。
func Ranges() map[string]Range {
	return map[string]Range{
		"max_instances":         {MinInstances, MaxInstances, "个", false},
		"app_running":           {1, MaxInstances, "个", false},
		"app_queue":             {1, MaxAppQueue, "个", false},
		"user_global_running":   {1, MaxInstances, "个", false},
		"user_per_app_running":  {1, MaxInstances, "个", false},
		"user_per_app_queued":   {1, MaxAppQueue, "个", false},
		"instance_memory_mb":    {MinInstanceMemoryMB, MaxInstanceMemoryMB, "MiB", true},
		"module_cache_mb":       {MinModuleCacheMB, MaxModuleCacheMB, "MiB", false},
		"module_cache_idle_min": {1, MaxIdleMin, "分钟", false},
		"appdb_idle_min":        {1, MaxIdleMin, "分钟", false},
		"appdb_cache_kib":       {MinAppDBCacheKiB, MaxAppDBCacheKiB, "KiB", false},
		"app_db_readers":        {1, limits.AppDBReadersMax, "个", false},
	}
}

// FieldNames 返回全部字段名（诊断/文档/测试用，顺序即表单顺序）。
func FieldNames() []string {
	return []string{
		"max_instances", "app_running", "app_queue",
		"user_global_running", "user_per_app_running", "user_per_app_queued",
		"instance_memory_mb", "module_cache_mb", "module_cache_idle_min",
		"appdb_idle_min", "appdb_cache_kib", "app_db_readers",
	}
}
