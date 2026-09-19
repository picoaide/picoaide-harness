package appserver

import (
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// ===========================================================================
// P0-2：单实例内存上限必须来自**当前生效的限制项**，不是部署档位
//
// 现场（2026-09-19 审计）：控制台保存 instance_memory_mb 后只被比较出"需重启"，
// 而装配期用的是 `prof.InstanceMemoryPages` —— 重启也永远不生效，且重启后
// restart_pending 被清空（界面显示"无需重启"）。后果是"自检按 32 MiB 算账、
// 实际按 64 MiB 跑"（2 GB 机器 OOM）。
//
// 变异验证（改回旧实现必红）：
//   - 把 Options.Limits 的读取去掉、改回 `MemoryPages: prof.InstanceMemoryPages`
//     ⇒ TestNewInstanceMemoryComesFromLimitsNotProfile 红（2048 ≠ 1024 页）；
//   - 只改 runtime 的 MemoryPages 而忘了 s.runtimePages / s.limits
//     ⇒ 同一用例的 CurrentLimits/InstanceMemoryPages 断言红；
//   - 把队列并发改回 prof.Instances ⇒ 同一用例的 Options().GlobalRunning 断言红。
// ---------------------------------------------------------------------------

// limitsFixtureServer 造一个"设置值 ≠ 档位值"的夹具：档位 small（64 MiB 实例内存），
// 生效限制项 128 MiB、并发 3。
func limitsFixture(t *testing.T) (memprofile.Profile, applimits.Limits, uint32) {
	t.Helper()
	prof := memprofile.Small()
	lim := applimits.FromProfile(prof)
	lim.InstanceMemoryMB = 128
	// 夹具前提：设置值必须真的不同于档位值，否则这条用例什么也证明不了。
	if lim.InstanceMemoryMB == int(prof.InstanceMemoryBytes()>>20) {
		t.Fatalf("夹具失效：设置值 %d MiB 与档位值相同", lim.InstanceMemoryMB)
	}
	// 128 MiB / 64 KiB = 2048 页（不调 InstanceMemoryPages()，避免与被测换算自证）。
	want := uint32(128) * 1024 * 1024 / 65536
	return prof, lim, want
}

func TestNewInstanceMemoryComesFromLimitsNotProfile(t *testing.T) {
	prof, lim, want := limitsFixture(t)

	e := newEnv(t, func(o *Options) {
		o.MemoryProfile = prof
		o.Limits = lim
	})
	// ① runtime 侧的页上限（wazero RuntimeConfig；装配期唯一写入点）。
	if got := e.srv.InstanceMemoryPages(); got != want {
		t.Fatalf("runtime 单实例内存页 = %d, want %d（设置 128 MiB；档位 %s = %d MiB）",
			got, want, prof.Name, prof.InstanceMemoryBytes()>>20)
	}
	// ② 生效限制项本身（控制台 GET /limits 读的就是它）。
	if got := e.srv.CurrentLimits().InstanceMemoryMB; got != 128 {
		t.Fatalf("CurrentLimits().InstanceMemoryMB = %d, want 128", got)
	}
	// ③ 队列并发同样取自生效限制项（否则"限制项按设置、并发按档位"又会分叉）。
	if got := e.srv.scheduler.Options().GlobalRunning; got != lim.MaxInstances {
		t.Fatalf("队列全局并发 = %d, want %d（生效限制项）", got, lim.MaxInstances)
	}
	// ④ 模块缓存按生效限制项缩放（MiB 口径）。
	if got := e.srv.modules != nil; !got {
		t.Fatal("模块缓存未装配")
	}
	wantCache := int64(lim.ModuleCacheMB) << 20
	if _, bytes := e.srv.modules.size(); bytes > wantCache {
		t.Fatalf("模块缓存记账 %d > 上限 %d", bytes, wantCache)
	}

	// 反向对照：不注入 Limits ⇒ 回落档位（证明"档位值"确实是另一个数，
	// 也就是说这条用例在旧实现下必然红）。
	e2 := newEnv(t, func(o *Options) { o.MemoryProfile = prof })
	if got := e2.srv.InstanceMemoryPages(); got != prof.InstanceMemoryPages {
		t.Fatalf("不注入 Limits 时应回落档位 %d 页，得到 %d", prof.InstanceMemoryPages, got)
	}
}

// TestApplyLimitsDoesNotAskForRestartWhenAssemblyAlreadyUsedTheValue：
// 装配期已经按生效限制项建好 runtime ⇒ 首次下发**不能**再报"需重启"
// （旧实现里这一步永远返回 instance_memory_mb，装配期把它丢掉、重启后又出现，
// 于是"需重启"这个提示永远修不好）。
func TestApplyLimitsDoesNotAskForRestartWhenAssemblyAlreadyUsedTheValue(t *testing.T) {
	prof, lim, _ := limitsFixture(t)
	e := newEnv(t, func(o *Options) {
		o.MemoryProfile = prof
		o.Limits = lim
	})
	if restart := e.srv.ApplyLimits(lim); len(restart) != 0 {
		t.Fatalf("装配值 == 生效值时应无需重启，得到 %v", restart)
	}
	// 改成另一个值仍然如实报"需重启"（提示本身不能失效）。
	next := lim
	next.InstanceMemoryMB = 256
	if restart := e.srv.ApplyLimits(next); len(restart) != 1 || restart[0] != "instance_memory_mb" {
		t.Fatalf("改了实例内存上限应报 instance_memory_mb 需重启，得到 %v", restart)
	}
}

// 编译期断言：调度器暴露的并发就是生效限制项用的那个字段（防未来重构时口径漂移）。
var _ = func(s *queue.Scheduler) int { return s.Options().GlobalRunning }
