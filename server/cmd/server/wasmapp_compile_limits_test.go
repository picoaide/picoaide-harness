package main

import (
	"context"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
)

// 本文件是 **R1-rt-7b 的装配级判据**：生产装配点必须把**生效的** instance_memory_mb
// 传给编译子系统（`compile.Options.MemoryPages`）。
//
// 为什么需要它（光有编译包内的双向用例不够）：编译包的用例回答的是"传进来就生效"
// （Options.MemoryPages → 子进程 wazero 上限 → 模块声明的内存校验），它**测不到"生产
// 真的传了"**。装配点漏传时的失败形态是静默的：`Options.MemoryPages = 0` ⇒ 编译侧回落
// 编译期默认 64 MiB ⇒ 控制台把 instance_memory_mb 调小/调大对发布期编译完全没有作用
// （调小：发布放行、首个请求 500；调大：声明大内存的应用永远发不出去）——
// 这正是审计 R1-rt-7b 的现场（只修了服务路径那一半）。
//
// 判据：档位固定 small（64 MiB 实例内存）、设置值 128 MiB（两者必须不同），真跑一次
// setupWasmPlatform，然后问它的产物：编译侧生效页数 = **设置值**折算的 2048 页。
//
// 变异验证：把 wasmapp.go 里 `compile.Options{…}` 的 `MemoryPages:` 那一行删掉
// （或改回不传/写死 limits.InstanceMemoryPages）⇒ 本用例必红（0 / 1024 ≠ 2048，已实测）。
func TestCompileInstanceMemoryComesFromSetting(t *testing.T) {
	// 档位 small = 64 MiB 实例内存；设置值 128 MiB —— 两者必须不同，否则这条用例
	// 证明不了"编译侧读的是设置值而不是档位/编译期默认"。
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	prof := memprofile.Small()
	wantPages := uint32(128) * 1024 * 1024 / 65536 // 128 MiB / 64 KiB = 2048 页
	if prof.InstanceMemoryPages == wantPages {
		t.Fatalf("夹具失效：档位 %s 本身就是 128 MiB（%d 页）", prof.Name, wantPages)
	}
	db := requireRealDB(t)
	// 生产装配不接 ChildBinary 注入（约定：server 与子进程同目录）⇒ 要真装上编译器，
	// 只能把产物构建到测试二进制同目录（与 TestWasmInstanceMemoryComesFromSettingAfterRestart
	// 共用同一份夹具）。
	ensureCompileChildNextToTestBinary(t)

	saved := applimits.FromProfile(prof)
	saved.InstanceMemoryMB = 128
	saved.MaxInstances = prof.Instances // 3：四笔账在 CI 小机器上也能过水位
	if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
		t.Fatalf("保存限制项设置失败: %v", err)
	}

	// 装配期的两处 fail-closed（可信代理 / 四笔账）只在启用应用子域时生效，显式关掉基域，
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	closed := false
	defer func() {
		if !closed {
			p.Close()
		}
	}()

	if p.Compiler == nil {
		// 评审口径：编译子系统不可用时发布链路本就 fail-closed，但那样本条判据就变成
		// 空转 ⇒ 直接失败（夹具已把子进程放到它找的位置，这里不该为 nil）。
		t.Fatal("装配产物里没有 Compiler：编译子进程没装上，本判据无法回答 rt-7b 的接线问题")
	}
	if got := p.Compiler.MemoryPages(); got != wantPages {
		t.Fatalf("编译侧生效页数 = %d, want %d（设置 instance_memory_mb=128；档位 %s = %d MiB）——"+
			"说明装配点没把生效的限制项传给 compile.Options.MemoryPages（R1-rt-7b：发布期编译会按过期的 64 MiB 跑）",
			got, wantPages, prof.Name, prof.InstanceMemoryBytes()>>20)
	}
	// 与执行侧**同源**（同一 holder 的同一个字段）：两侧不等就说明"发布期能过的模块，
	// 执行期起不来"这类分叉又回来了。
	if got := p.AppServer.InstanceMemoryPages(); got != wantPages {
		t.Fatalf("执行侧生效页数 = %d, want %d（同一份 applimits.Limits 必须同时驱动两侧）", got, wantPages)
	}
}

// TestCompileTimeoutComesFromSetting 是**同一类接线判据**，对象是 2026-10-01 新增的
// `compile_timeout_seconds`。
//
// 为什么必须单独判一次（而不是"既然 MemoryPages 那条绿了就够了"）：编译超时与内存上限
// 走的是**两个不同的通道** —— 内存上限进的是 `compile.Options`（构造期），而超时会作为
// `-timeout` 传给编译子进程的 argv（每次编译）。只在构造期固化的话，控制台把它调大之后
// 子进程仍按旧值自杀：界面上是新值、实际按旧值跑，**没有任何门禁会红**。
//
// 判据：设置值 45 s（≠ 编译期默认 60 s，也 ≠ 任何档位）⇒ 装配后编译器读到的必须是 45 s。
//
// 变异验证：把 wasmapp.go 的 `applyAll` 里 `compiler.SetTimeout(l.CompileTimeout())`
// 那一行删掉（或改成写死 limits.CompileTimeout）⇒ 本用例必红（60 ≠ 45）。
func TestCompileTimeoutComesFromSetting(t *testing.T) {
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	saved := applimits.Defaults()
	saved.CompileTimeoutSeconds = 45
	if saved.CompileTimeoutSeconds == int(limits.CompileTimeout/time.Second) {
		t.Fatalf("夹具失效：设置值与编译期默认相同（都是 %d s），证明不了接线", saved.CompileTimeoutSeconds)
	}
	if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
		t.Fatalf("保存限制项设置失败: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	closed := false
	defer func() {
		if !closed {
			p.Close()
		}
	}()

	if p.Compiler == nil {
		t.Fatal("装配产物里没有 Compiler：本判据无法回答 compile_timeout_seconds 的接线问题")
	}
	want := 45 * time.Second
	if got := p.Compiler.Timeout(); got != want {
		t.Fatalf("编译侧生效超时 = %s, want %s —— 装配点没把生效的限制项交给编译器"+
			"（它会作为 -timeout 进编译子进程 argv：控制台调大之后子进程仍按旧值自杀，界面上却是新值）",
			got, want)
	}
	// 与执行侧同源：同一份 applimits.Limits 必须同时驱动两侧。
	if got := p.AppServer.CurrentLimits().CompileTimeout(); got != want {
		t.Fatalf("执行侧读到 %s, want %s（两侧必须来自同一份限制项）", got, want)
	}
}
