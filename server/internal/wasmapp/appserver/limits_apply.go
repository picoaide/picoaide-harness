package appserver

import (
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
	"github.com/picoaide/picoaide/internal/wasmapp/runtime"
)

// 本文件是「控制台限制项 → 运行中组件」的**唯一落地点**（2026-09-19）。
//
// 分工：applimits 负责模型/校验/四笔账预览；cmd/server 的 holder 负责"读设置 →
// 校验 → 落库"；本文件负责把一份 Limits 推给队列、模块缓存、库句柄池与 SQLite
// 连接参数，并回答"哪些改动要重启才生效"。
//
// 为什么每一条都写清楚"生效范围"：运营改完最怕的是"以为生效了"。四类里三类是
// 即时生效（队列上限、模块缓存与空闲 TTL、库句柄池与空闲回收），两类是**下一次
// 建连/下一个句柄**生效（SQLite 页缓存 appdb_cache_kib；只读连接数 app_db_readers），
// 一类必须**重启**（单实例内存上限，wazero RuntimeConfig 的字段，进程内 runtime
// 建好后不可变）。

// ApplyLimits 把限制项下发到运行中的组件，返回**需要重启才生效**的字段名。
//
// 幂等：同一份 Limits 重复下发是安全的（SetOptions/SetBounds/SetLimits 都是覆盖语义）。
func (s *Server) ApplyLimits(l applimits.Limits) []string {
	if s == nil {
		return nil
	}
	// ① 队列（并发与排队）：即时生效，收紧不打断在途请求。
	if s.scheduler != nil {
		qopt := queue.DefaultOptions()
		qopt.GlobalRunning = l.MaxInstances
		qopt.PerAppRunning = l.AppRunning
		qopt.PerAppQueue = l.AppQueue
		qopt.PerUserGlobalRunning = l.UserGlobalRunning
		qopt.PerUserPerAppRunning = l.UserPerAppRunning
		qopt.PerUserPerAppQueued = l.UserPerAppQueued
		s.scheduler.SetOptions(qopt)
	}
	// ② 进程内编译模块缓存：即时生效（收紧时立刻按 LRU 淘汰到新上限）。
	if s.modules != nil {
		s.modules.SetBounds(
			int64(l.ModuleCacheMB)<<20,
			limits.ModuleCacheMaxEntries,
			time.Duration(l.ModuleCacheIdleMin)*time.Minute,
		)
	}
	// ③ 应用库句柄池：容量与空闲回收即时生效（收紧容量时关闭最久未用的空闲句柄）。
	//
	// readers（只读连接数）是**下一个句柄**生效：只读连接只能在 appdb 建库的一次性
	// 令牌窗口内一次建满，运行中的句柄没有"加几条读者"这条路径（见 appDBPool.SetReaders）。
	// 因此这里下发它、但不在 restart 列表里 —— 与 appdb_cache_kib 同档，
	// 控制台文案必须如实写"下一个应用库句柄生效"。
	if s.appdbs != nil {
		s.appdbs.SetLimits(l.MaxInstances, time.Duration(l.AppDBIdleMin)*time.Minute)
		s.appdbs.SetReaders(l.AppDBReaders)
	}
	// ④ SQLite 每连接页缓存：**下一个新建连接**生效（连接级 PRAGMA）。
	appdb.SetConnCacheKiB(l.AppDBCacheKiB)

	// ⑤ 单实例内存上限：runtime 级 ⇒ 需重启。判定用"生效值 vs 目标值"，
	// 而不是"本次请求里改没改"，这样重复保存同一份配置不会误报要重启。
	var restart []string
	if s.InstanceMemoryPages() != l.InstanceMemoryPages() {
		restart = append(restart, "instance_memory_mb")
	}

	s.mu.Lock()
	s.limits = l
	s.mu.Unlock()
	s.logf("appserver: 限制项已下发 max_instances=%d app_running=%d instance_memory=%dMiB module_cache=%dMiB idle=%dmin appdb_idle=%dmin appdb_readers=%d restart=%v",
		l.MaxInstances, l.AppRunning, l.InstanceMemoryMB, l.ModuleCacheMB, l.ModuleCacheIdleMin, l.AppDBIdleMin, l.AppDBReaders, restart)
	return restart
}

// CurrentLimits 返回当前生效的限制项（装配期为档位折算值，控制台保存后为设置值）。
func (s *Server) CurrentLimits() applimits.Limits {
	if s == nil {
		return applimits.Defaults()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.limits.MaxInstances == 0 {
		// 装配期未显式设置 ⇒ 按档位折算（与 New 里的 profile 一致）。
		return applimits.FromProfile(s.profile)
	}
	return s.limits
}

// InstanceMemoryPages 返回**当前生效**的单实例内存页上限。
//
// 来源纪律（P0-2）：**优先问运行时**（`runtime.MemoryLimitPages`）—— 它才是
// wazero RuntimeConfig 里真正生效的那个数。装配期另存一份 `runtimePages` 只作
// 运行时缺失时的兜底；两处若不一致，说明装配没把值交给 runtime，
// 而"报告一个没生效的数"正是这次审计里最难发现的那类分叉（界面说 32 MiB、
// 实际按 64 MiB 跑）。
//
// 与 CurrentLimits().InstanceMemoryPages() 不等时说明有待重启生效的改动。
func (s *Server) InstanceMemoryPages() uint32 {
	if s == nil {
		return 0
	}
	if s.rt != nil {
		if pages := s.rt.MemoryLimitPages(); pages != 0 {
			return pages
		}
	}
	s.mu.Lock()
	pages := s.runtimePages
	s.mu.Unlock()
	if pages != 0 {
		return pages
	}
	return s.profile.InstanceMemoryPages
}

// RuntimeCacheMode 返回**执行侧实际生效**的编译缓存模式（disk / memory）。
//
// 来源纪律与 InstanceMemoryPages 完全同一条（P0-2 / R1-rt-1）：**问运行时**，
// 不在这里按 DataRoot 能不能建目录重算一遍 —— 第二个判断正是这条可观测性要消灭的
// 分叉（探针说 disk、实际跑 memory）。装配层只把这个值原样转成字符串送进 /readyz
// （cmd/server/wasmapp.go 的 readyz.Options.ExecCacheMode）。
//
// nil 接收者返回空串：调用方（探针）据此区分"没有运行时"与"某一种模式"。
func (s *Server) RuntimeCacheMode() runtime.CacheMode {
	if s == nil || s.rt == nil {
		return ""
	}
	return s.rt.CacheMode()
}

// CachedModuleCount 返回进程内编译模块缓存的条目数（只读；诊断与装配自检用）。
//
// 存在的理由：`EvictApp`（下架/冻结/删除的事件驱动释放）此前只有"返回被逐出数量"
// 这一条观测路径，而调用方（装配注入的钩子）**丢弃了返回值** —— 于是"钩子到底有没有
// 接到 appserver 上"在测试里不可观测，只能退化成源码文本断言（假绿）。
// 有了它，装配级用例可以"先暖一个模块，再走管理端处置，断言条目归零"。
func (s *Server) CachedModuleCount() int {
	if s == nil || s.modules == nil {
		return 0
	}
	entries, _ := s.modules.size()
	return entries
}

// CachedCompiledModuleCount 返回**已编译**的缓存条目数（= "模块就绪"的条目数）。
//
// 与 CachedModuleCount 的差别（2026-09-20 起才有意义）：条目可以只"资源就绪"——
// 随包资源集已在内存里、但还没编译（静态直出与 `assets.read` 建的就是这种）。
// 所以 `CachedModuleCount() == 1` **不能**说明编译发生过；要判"某条路径有没有触发
// 编译"必须看这个数（例：静态资源直出后它必须仍是 0，入口请求之后必须是 1）。
func (s *Server) CachedCompiledModuleCount() int {
	if s == nil || s.modules == nil {
		return 0
	}
	return s.modules.compiledCount()
}
