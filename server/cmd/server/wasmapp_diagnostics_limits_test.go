package main

import (
	"context"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// 本文件是 **R2-DG-2 的装配级判据**：生产装配点必须把诊断面的"单实例内存上限"接到
// **运行时生效值**（`Options.EffectiveMemoryPages` = appserver.InstanceMemoryPages），
// 而不是控制台的"已保存值"。
//
// 为什么需要它（光有 api 包内的用例不够）：api 的用例回答的是"钩子给对了就渲染对"
// （Options.EffectiveMemoryPages → hints），它**测不到"生产真的传了"** ——
// 删掉装配里那一行时的失败形态是静默的：诊断又退回 `Options.Limits()`（已保存值），
// 而"保存了 instance_memory_mb 但还没重启"的窗口里两者可以差出几十上百 MiB
// （审计实测：保存 32 MiB / 实际按 128 MiB 跑），hints 会把 AI/作者带向错的数字。
//
// 判据（必须制造出"已保存 ≠ 生效"的窗口，否则证明不了接线）：
//  1. 装配期生效值 = 128 MiB（设置值 + runtime 一起建好）；
//  2. 模拟控制台保存 32 MiB（走真实持有者 Apply：holder 立刻变、runtime 不变）；
//  3. 诊断面报告的必须是 **128 MiB（2048 页）**；若得到 32 MiB（512 页），说明装配
//     没注入 EffectiveMemoryPages（退回了 Limits 的已保存值）。
//
// 变异验证：删掉 wasmapp.go 里 `EffectiveMemoryPages: appSrv.InstanceMemoryPages,`
// 那一行 ⇒ 本用例必红（得到 512 页）。
func TestDiagnosticsMemoryHintUsesRuntimePagesAtAssembly(t *testing.T) {
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	prof := memprofile.Small()
	const (
		savedMiB     = 128
		savedPages   = uint32(savedMiB) * 1024 * 1024 / 65536 // 2048
		shorterMiB   = 32
		shorterPages = uint32(shorterMiB) * 1024 * 1024 / 65536 // 512
	)
	if prof.InstanceMemoryPages == savedPages {
		t.Fatalf("夹具失效：档位 %s 本身就是 %d MiB", prof.Name, savedMiB)
	}
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	saved := applimits.FromProfile(prof)
	saved.InstanceMemoryMB = savedMiB
	saved.MaxInstances = prof.Instances // 四笔账在 CI 小机器上也能过水位
	if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
		t.Fatalf("保存限制项设置失败: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	defer p.Close()

	// ① 装配期：生效值与设置值都是 128 MiB。
	if got := p.AppServer.InstanceMemoryPages(); got != savedPages {
		t.Fatalf("装配期生效页数 = %d, want %d", got, savedPages)
	}
	if got := p.API.EffectiveMemoryPages(); got != savedPages {
		t.Fatalf("装配后诊断面页数 = %d, want %d（生效值）", got, savedPages)
	}

	// ② 模拟控制台保存 32 MiB（未重启）：holder 立刻变，runtime 不变 —— 这正是审计现场。
	shorter := saved
	shorter.InstanceMemoryMB = shorterMiB
	if _, aerr := p.Limits.Apply(shorter.Encode()); aerr != nil {
		t.Fatalf("控制台保存限制项失败: %v", aerr.JSON())
	}
	if got := p.Limits.Get().InstanceMemoryMB; got != shorterMiB {
		t.Fatalf("保存后 holder 应为 %d MiB，得到 %d", shorterMiB, got)
	}
	if got := p.AppServer.InstanceMemoryPages(); got != savedPages {
		t.Fatalf("保存未重启时运行时应仍是 %d 页，得到 %d（夹具/装配语义不符）", savedPages, got)
	}

	// ③ 诊断面必须是**生效值**，不是已保存值。
	if got := p.API.EffectiveMemoryPages(); got != savedPages {
		t.Fatalf("诊断面页数 = %d, want %d（运行时生效值）—— 得到 %d 说明装配没注入 "+
			"Options.EffectiveMemoryPages，诊断 hints 会回显控制台已保存值（%d MiB），"+
			"而应用实际按 %d MiB 跑（R2-DG-2）",
			got, savedPages, shorterPages, shorterMiB, savedMiB)
	}
}

// TestReadyzMemoryPlanComesFromAssembly 是 **R2-CA-4** 的装配级判据：
// `/readyz` 的内存档位/四笔账必须有**装配点注入**（`readyz.Options.MemoryPlan`）。
//
// 缺陷现场（审计）：`MemoryPlan: limitsHolder.Plan` 是唯一赋值点，而全仓测试零引用
// `MemProfile`/`mem_profile` —— 删掉那一行**可编译、全部用例仍绿**，而 `/readyz` 会静默
// 退回"没有档位信息"（`mem_profile=""`、`mem_budget_bytes=0`），探针上再也看不出
// "界面按档位算账、实际按控制台设置跑"这类分叉（P0-2 的可见面）。
// 同一波次的 `compile.Options.MemoryPages` 有这个级别的判据（见
// wasmapp_compile_limits_test.go），`MemoryPlan` 此前缺一条同形的。
//
// 判据两段：
//  1. 装配后快照必须带档位名与理论峰值（不是空档/零账）；
//  2. 控制台保存更小的单实例上限后，理论峰值必须**跟着变小**（证明它读的是
//     holder 的当前值，而不是某个编译期常量或装配期快照）。
//
// 变异验证：删掉 wasmapp.go 里 `MemoryPlan: limitsHolder.Plan,` 那一行 ⇒ 第 1 段必红
// （MemProfile="" / MemBudgetByte=0）。
func TestReadyzMemoryPlanComesFromAssembly(t *testing.T) {
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	prof := memprofile.Small()
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	saved := applimits.FromProfile(prof)
	saved.InstanceMemoryMB = 128
	saved.MaxInstances = prof.Instances
	if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
		t.Fatalf("保存限制项设置失败: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	defer p.Close()

	big := p.Checker.Snapshot()
	if big.MemProfile == "" {
		t.Fatalf("装配后 /readyz 快照必须带内存档位名（R1-rt-10）：装配点漏注入 " +
			"readyz.Options.MemoryPlan 时会静默退化成空档位（mem_profile=\"\"）")
	}
	if big.MemBudgetByte <= 0 {
		t.Fatalf("装配后理论峰值必须 > 0，得到 %d（MemoryPlan 未接线时它是 0）", big.MemBudgetByte)
	}
	// 实例池那一笔 ≥ max_instances × instance_memory_mb：用它做"读的是当前设置值"的判据。
	poolBytes := int64(saved.MaxInstances) << 20 * int64(saved.InstanceMemoryMB)
	if big.MemBudgetByte < poolBytes {
		t.Fatalf("理论峰值 %d 小于实例池那一笔 %d（max_instances=%d × %d MiB）",
			big.MemBudgetByte, poolBytes, saved.MaxInstances, saved.InstanceMemoryMB)
	}

	// 反向：把单实例上限改小 ⇒ 理论峰值必须跟着变小（同一份 holder 的数）。
	shorter := saved
	shorter.InstanceMemoryMB = 32
	if _, aerr := p.Limits.Apply(shorter.Encode()); aerr != nil {
		t.Fatalf("控制台保存限制项失败: %v", aerr.JSON())
	}
	small := p.Checker.Snapshot()
	if small.MemBudgetByte >= big.MemBudgetByte {
		t.Fatalf("单实例上限 %d MiB → %d MiB 后理论峰值应下降：%d → %d（说明存档位名与账本不是同源）",
			saved.InstanceMemoryMB, shorter.InstanceMemoryMB, big.MemBudgetByte, small.MemBudgetByte)
	}
	if small.MemProfile != big.MemProfile {
		t.Fatalf("档位名不应因为保存设置而变化：%q → %q", big.MemProfile, small.MemProfile)
	}
}
