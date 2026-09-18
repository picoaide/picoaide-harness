package appserver

import (
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// 本文件是「控制台限制项 → 运行中组件」的**唯一落地点**（2026-09-19）。
//
// 分工：applimits 负责模型/校验/四笔账预览；cmd/server 的 holder 负责"读设置 →
// 校验 → 落库"；本文件负责把一份 Limits 推给队列、模块缓存、库句柄池与 SQLite
// 连接参数，并回答"哪些改动要重启才生效"。
//
// 为什么每一条都写清楚"生效范围"：运营改完最怕的是"以为生效了"。四类里三类是
// 即时生效（队列上限、模块缓存与空闲 TTL、库句柄池与空闲回收），一类是**下次
// 新建连接**生效（SQLite 页缓存），一类必须**重启**（单实例内存上限，wazero
// RuntimeConfig 的字段，进程内 runtime 建好后不可变）。

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
	// ③ 应用库句柄池：即时生效（容量收紧时关闭最久未用的空闲句柄）。
	if s.appdbs != nil {
		s.appdbs.SetLimits(l.MaxInstances, time.Duration(l.AppDBIdleMin)*time.Minute)
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
	s.logf("appserver: 限制项已下发 max_instances=%d app_running=%d instance_memory=%dMiB module_cache=%dMiB idle=%dmin appdb_idle=%dmin restart=%v",
		l.MaxInstances, l.AppRunning, l.InstanceMemoryMB, l.ModuleCacheMB, l.ModuleCacheIdleMin, l.AppDBIdleMin, restart)
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

// InstanceMemoryPages 返回**当前生效**的单实例内存页上限（wazero runtime 侧的值；
// 与 CurrentLimits().InstanceMemoryPages() 不等时说明有待重启生效的改动）。
func (s *Server) InstanceMemoryPages() uint32 {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	pages := s.runtimePages
	s.mu.Unlock()
	if pages != 0 {
		return pages
	}
	return s.profile.InstanceMemoryPages
}
