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
	}
}

// FromProfile 把部署档位（memprofile）折算成限制项：并发、单实例上限、模块缓存随档位，
// 其余取默认（档位只管内存四笔账里的三笔）。
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
			WithHint("同一应用的请求是串行的（一应用一连接），调高只影响排队策略")
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
func (l Limits) Budget(availableBytes int64) readyz.MemoryBudget {
	return readyz.ComputeMemoryBudgetFor(availableBytes, readyz.MemoryPlan{
		Profile:             "settings",
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
// 另有一个"下次生效"的软字段：appdb_cache_kib —— 它是连接级 PRAGMA，只影响**新建**
// 的连接（已有句柄在空闲回收后重建时生效），因此既不阻塞保存，也不要求重启。
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
	}
}

// FieldNames 返回全部字段名（诊断/文档/测试用，顺序即表单顺序）。
func FieldNames() []string {
	return []string{
		"max_instances", "app_running", "app_queue",
		"user_global_running", "user_per_app_running", "user_per_app_queued",
		"instance_memory_mb", "module_cache_mb", "module_cache_idle_min",
		"appdb_idle_min", "appdb_cache_kib",
	}
}
