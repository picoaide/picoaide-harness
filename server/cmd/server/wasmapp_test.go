package main

import (
	"context"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件覆盖 cmd/server 侧的**装配期判据**回归（审计 P2-1 / P2-5 / P2-8 与接线缺失）：
//   - FIX-18：`PICOAI_COMPILE_ISOLATION=require` 必须真的拒绝启动；
//   - FIX-23：`http.Server.ReadTimeout` 必须与 limits.ServerReadTimeout 同源；
//   - FIX-24：内存四笔账自检只在启用应用子域时执行（未启用时不再挡住 4 GiB 容器）；
//   - FIX-47：过期分片上传会话的周期回收必须**真的启动**（装配级判据，不是源码文本）；
//   - 接线：发布闸门 / 事件清理调度 / 编译可用性 / 事件计数 必须真的接到装配里。
//
// 判据抽成**纯函数**（checkStartupMemory / mustRefuseStartupForIsolation）就是为了
// 能在不 Fatalf、不真改 /proc、不真起进程的前提下测到 —— log.Fatalf 没有测试缝。
// FIX-47 是例外：它**必须**真跑一次 setupWasmPlatform，因为"构造了但没 Start"在
// 源码文本上完全看不出来（见该用例的注释）。
//
// 变异验证（改回缺陷实现时哪条必红）：
//   - 去掉 checkStartupMemory 的 `if !enabled` ⇒ TestMemorySelfCheckSkippedWhenDisabled 必红；
//   - 启用档放宽判据（例如恒返回 nil）⇒ TestMemorySelfCheckFailClosedWhenEnabled 必红；
//   - 去掉 mustRefuseStartupForIsolation 的 usable 判断 ⇒ TestIsolationRequireRefusesStartup 必红；
//   - main.go 的 ReadTimeout 改回 `60 * time.Second` ⇒ TestServerReadTimeoutUsesLimits 必红；
//   - 删掉任一接线行（Ready/EventCleanup/CompileAvailability/Events/启动调用）⇒
//     TestWasmPlatformWiringPresent 必红；
//   - 删掉 wasmapp.go 的 `uploadCleanup.Start(ctx)` ⇒ TestUploadCleanupSchedulerIsWired 必红
//     （源码文本断言看不出这一条，这正是它存在的理由）。

// TestMemorySelfCheckSkippedWhenDisabled：审计 P2-8 —— 未启用应用子域时
// 内存四笔账（实例池/编译/上传/缓存）一笔都不会被用到，不该因此拒绝启动
// （此前 4 GiB 容器直接起不来：要求 MemAvailable ≥ 3.56 GiB）。
func TestMemorySelfCheckSkippedWhenDisabled(t *testing.T) {
	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, format) }

	if err := checkStartupMemory(false, 1, readyz.DefaultMemoryPlan(), logf); err != nil {
		t.Fatalf("未启用子域时必须跳过内存自检（不能挡住启动）：%v", err)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "跳过内存四笔账自检") {
		t.Fatalf("跳过必须是**显式的日志**（不许静默）：%q", joined)
	}
	if strings.Contains(joined, "memory budget") {
		t.Fatalf("未启用时不该打印四笔账明细：%q", joined)
	}
}

// TestMemorySelfCheckFailClosedWhenEnabled：启用子域时判据**一点没放宽** ——
// 理论峰值 > 可用内存 70% ⇒ 拒绝启动（§4.3：拒绝启动而不是等 OOM）。
func TestMemorySelfCheckFailClosedWhenEnabled(t *testing.T) {
	if err := checkStartupMemory(true, 1, readyz.DefaultMemoryPlan(), func(string, ...any) {}); err == nil {
		t.Fatal("启用子域 + 极小 MemAvailable ⇒ 必须拒绝启动")
	}
	// 四笔账之和恰好卡在 70% 水位 ⇒ 通过；少 1 字节 ⇒ 拒绝。
	need := readyz.InstancePoolBytes + readyz.CompilePeakBytes +
		int64(limits.UploadPeakPerUploadBytes) + readyz.CacheResidentBytes
	guard := int64(limits.MemoryPeakGuardPercent)
	avail := (need*100 + guard - 1) / guard
	if err := checkStartupMemory(true, avail, readyz.DefaultMemoryPlan(), func(string, ...any) {}); err != nil {
		t.Fatalf("恰好等于水位应通过：%v", err)
	}
	if err := checkStartupMemory(true, avail-1, readyz.DefaultMemoryPlan(), func(string, ...any) {}); err == nil {
		t.Fatal("超过水位 1 字节必须拒绝启动（判据不得放宽）")
	}
	// 正常机器：放行 + 明细进日志（运维据此看到四笔账的构成）。
	var lines []string
	if err := checkStartupMemory(true, 64<<30, readyz.DefaultMemoryPlan(), func(format string, args ...any) {
		lines = append(lines, format)
	}); err != nil {
		t.Fatalf("64 GiB 可用内存应通过：%v", err)
	}
	if !strings.Contains(strings.Join(lines, "\n"), "memory budget") {
		t.Fatalf("启用时必须打印四笔账明细：%v", lines)
	}
}

// TestIsolationRequireRefusesStartup：审计 P2-1 —— require 档的**唯一价值**是
// fail-closed（三处文档都写"隔离不可用就拒绝启动"），所以判据必须是
// "require ∧ 隔离未生效"。
func TestIsolationRequireRefusesStartup(t *testing.T) {
	cases := []struct {
		name   string
		mode   compile.IsolationMode
		usable bool
		want   bool
	}{
		{"require+不可用 ⇒ 拒绝启动", compile.IsolationRequire, false, true},
		{"require+可用 ⇒ 照常启动", compile.IsolationRequire, true, false},
		{"auto+不可用 ⇒ 降级但要可见（不拒绝）", compile.IsolationAuto, false, false},
		{"auto+可用 ⇒ 照常启动", compile.IsolationAuto, true, false},
		{"off ⇒ 显式关隔离（测试档），不按 require 判", compile.IsolationOff, false, false},
	}
	for _, tc := range cases {
		if got := mustRefuseStartupForIsolation(tc.mode, tc.usable); got != tc.want {
			t.Fatalf("%s：got %v want %v", tc.name, got, tc.want)
		}
	}
}

// TestServerReadTimeoutUsesLimits：审计 P2-5 —— `http.Server.ReadTimeout` 必须与
// `limits.ServerReadTimeout` **同源**（§5.5 单一真源；§10.5 第 58 项的断言
// `ClientUploadTimeout > ServerReadTimeout` 只在同源时才有意义）。
//
// 为什么用源码断言：服务端是在 `main()` 里内联构造的（测试拿不到那个结构体），
// 而把构造挪出 main() 超出了本次修复的范围。断言"表达式恰为 limits.ServerReadTimeout"
// 比断言某个副本值更硬 —— 副本值相等也可能是两处各写一遍 60s。
func TestServerReadTimeoutUsesLimits(t *testing.T) {
	if limits.ServerReadTimeout != 60*time.Second {
		t.Fatalf("limits.ServerReadTimeout=%v，设计基线是 60s；改它要同步 §4.2 与 §10.5 第 58 项",
			limits.ServerReadTimeout)
	}
	if limits.ClientUploadTimeout <= limits.ServerReadTimeout {
		t.Fatalf("§10.5 第 58 项的序关系被破坏：客户端上传超时 %v 必须 > 服务端读超时 %v",
			limits.ClientUploadTimeout, limits.ServerReadTimeout)
	}
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("读 main.go: %v", err)
	}
	m := regexp.MustCompile(`ReadTimeout:\s*([^\n,]+)`).FindStringSubmatch(string(src))
	if m == nil {
		t.Fatal("main.go 里找不到 http.Server 的 ReadTimeout 字段")
	}
	if got := strings.TrimSpace(m[1]); got != "limits.ServerReadTimeout" {
		t.Fatalf("ReadTimeout 取值为 %q，必须是 limits.ServerReadTimeout（硬编码会让 limits 断言说谎）", got)
	}
}

// TestWasmPlatformWiringPresent：FIX-16/17/19/20 的**接线**必须真的在装配里。
//
// 为什么是源码断言：`setupWasmPlatform` 会 log.Fatalf、要真 PG、真编译子进程，
// 没有测试缝；而这些接线缺失的形态正是本次审计的 P1（"判定逻辑一直是对的，
// 只是没人调用"）—— 一条"接线行还在不在"的断言足以防它再退化。
func TestWasmPlatformWiringPresent(t *testing.T) {
	src, err := os.ReadFile("wasmapp.go")
	if err != nil {
		t.Fatalf("读 wasmapp.go: %v", err)
	}
	s := string(src)
	wants := []struct {
		needle string
		why    string
	}{
		{"checkStartupMemory(enabled, readMemAvailable(), plan, log.Printf)", "内存四笔账自检必须按 enabled 分档（P2-8）且按部署档位算账"},
		{"memprofile.FromEnv(os.Getenv)", "内存档位必须来自部署配置（未知档位 fail-loud）"},
		{"MemoryProfile: prof,", "档位必须真的喂给 appserver（声明与执行同一份数）"},
		{"OnAppEvict: func(appID string) { appSrv.EvictApp(appID) },", "下架/冻结/删除后必须立即释放进程内驻留"},
		{"mustRefuseStartupForIsolation(mode, usable)", "require 档必须真的拒绝启动（P2-1）"},
		{"compile.IsolationFromEnv()", "隔离档必须来自部署配置"},
		{"events.NewCleanupScheduler(", "7 天保留必须有人来删（P1-2）"},
		{"eventCleanup.Start(ctx)", "清理调度必须启动（P1-2）"},
		{"p.EventCleanup.Close()", "清理调度必须随平台关停（P1-2）"},
		{"CompileAvailability:", "编译可用性必须注入 /readyz（P2-2）"},
		{"Events: func() readyz.EventsStats", "事件计数必须注入 /readyz（P2-7）"},
		{"Ready: checker,", "发布闸门必须注入 api.Options（P1-1）"},
	}
	for _, w := range wants {
		if !strings.Contains(s, w.needle) {
			t.Errorf("接线缺失：%q（%s）", w.needle, w.why)
		}
	}
}

// TestUploadCleanupSchedulerIsWired：FIX-47 —— 过期分片上传会话的周期回收必须**真的启动**。
//
// 判据是**装配级**的：真跑一次 setupWasmPlatform，然后问它的产物（非 nil + Running +
// 真的跑过至少一轮 + Close 之后停）。为什么不能只断言源码里有 `uploadCleanup.Start(ctx)`
// 这一行：文本断言**分不清"构造了但没 Start"** —— 未 Start 的 Close 是 no-op，非 nil 指针
// 与已启动完全同形，而这正是审计 P1-1 的现场形态（"实现是对的，零调用点"），后果是静默的：
// 断线客户端留下的 32 MiB 会话目录永久占盘，直到恰好有人再用同一个 upload_id。
//
// 变异方式（把 wasmapp.go 里的 `uploadCleanup.Start(ctx)` 删掉 ⇒ 本用例必红，已实测；
// 触发 `log.Fatalf` 的自检项都与应用子域开关绑定，本用例显式关掉基域，只测接线本身）。
func TestUploadCleanupSchedulerIsWired(t *testing.T) {
	// 装配里有两处 fail-closed 会 log.Fatalf（可信代理自检 / 内存四笔账），都只在启用
	// 应用子域时生效；显式关掉基域，让用例只回答"清理调度有没有接线"。
	t.Setenv(EnvAppsBaseDomain, "")
	db := requireRealDB(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, nil, t.TempDir(), "127.0.0.1:8080")
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	closed := false
	defer func() {
		if !closed {
			p.Close() // 失败路径也要收尾（实例锁/协程不能留到测试进程结束）
		}
	}()

	if p.UploadCleanup == nil {
		t.Fatal("装配产物里没有 UploadCleanup：过期上传会话的周期回收无人负责（审计 P1-1）")
	}
	if !p.UploadCleanup.Running() {
		t.Fatal("UploadCleanup 只被**构造**了、没有 Start：过期会话目录会永久占盘（FIX-47 的缺陷形态）")
	}
	// "启动即清一次"是该调度器的既定行为：轮数可观察 ⇒ 证明 goroutine 真的在跑，
	// 而不只是置了一个 started 标志。
	deadline := time.Now().Add(5 * time.Second)
	for p.UploadCleanup.Runs() < 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if p.UploadCleanup.Runs() < 1 {
		t.Fatalf("调度器 Running 但一轮都没执行（Runs=%d）：Start 只置了标志、协程没跑", p.UploadCleanup.Runs())
	}
	// Close 之后必须停（三段齐全：构造 + Start + Close）。
	p.Close()
	closed = true
	if p.UploadCleanup.Running() {
		t.Fatal("平台关停后 UploadCleanup 仍是 Running：Close 接线缺失")
	}
}
