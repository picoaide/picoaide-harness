package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/router"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
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
//   - 放宽内存四笔账判据（恒返回 nil）⇒ TestMemorySelfCheckFailClosedWhenEnabled 必红；
//   - 把 Source=none 的跳过分支删掉（拿 0 去判）⇒ TestMemorySelfCheckSkipsWhenUnknownButSaysSo 必红；
//   - 自检改回 readMemAvailable（只看 /proc）⇒ TestMemorySelfCheckUsesCgroupAwareAvailability 必红；
//   - 启用档放宽判据（例如恒返回 nil）⇒ TestMemorySelfCheckFailClosedWhenEnabled 必红；
//   - 去掉 mustRefuseStartupForIsolation 的 usable 判断 ⇒ TestIsolationRequireRefusesStartup 必红；
//   - main.go 的 ReadTimeout 改回 `60 * time.Second` ⇒ TestServerReadTimeoutUsesLimits 必红；
//   - 删掉任一接线行（Ready/EventCleanup/CompileAvailability/Events/启动调用）⇒
//     TestWasmPlatformWiringPresent 必红；
//   - 删掉 wasmapp.go 的 `uploadCleanup.Start(ctx)` ⇒ TestUploadCleanupSchedulerIsWired 必红
//     （源码文本断言看不出这一条，这正是它存在的理由）。

// ⚠️ `TestMemorySelfCheckSkippedWhenDisabled` 已随 W4 删除：它断言"未启用应用子域时
// 跳过内存四笔账自检"（审计 P2-8 的按 enabled 分档）。客户端专属模型下**没有"未启用"
// 这个档位** —— 应用平台始终在服务（`/api/client/v2/apps/wasm/*` 无条件挂载），
// 四笔账随时会被用到 ⇒ 判据全量生效（这正是 §4.3 的原话"拒绝启动而不是等 OOM"）。
// 该档位的消失由 `TestMemorySelfCheckFailClosedWhenEnabled` +
// `TestMemorySelfCheckSkipsWhenUnknownButSaysSo` 继续守（判据一点没放宽）。

// TestMemorySelfCheckFailClosedWhenEnabled：启用子域时判据**一点没放宽** ——
// 理论峰值 > 可用内存 70% ⇒ 拒绝启动（§4.3：拒绝启动而不是等 OOM）。
func TestMemorySelfCheckFailClosedWhenEnabled(t *testing.T) {
	if err := checkStartupMemory(memAvail(1), readyz.DefaultMemoryPlan(), func(string, ...any) {}); err == nil {
		t.Fatal("启用子域 + 极小可用内存 ⇒ 必须拒绝启动")
	}
	// 各笔账之和恰好卡在 70% 水位 ⇒ 通过；少 1 字节 ⇒ 拒绝。
	plan := readyz.DefaultMemoryPlan()
	need := readyz.InstancePoolBytes + readyz.CompilePeakBytes +
		int64(limits.UploadPeakPerUploadBytes) + readyz.CacheResidentBytes +
		int64(plan.Instances)*plan.AppDBPageCachePerHandleBytes
	guard := int64(limits.MemoryPeakGuardPercent)
	avail := (need*100 + guard - 1) / guard
	if err := checkStartupMemory(memAvail(avail), readyz.DefaultMemoryPlan(), func(string, ...any) {}); err != nil {
		t.Fatalf("恰好等于水位应通过：%v", err)
	}
	if err := checkStartupMemory(memAvail(avail-1), readyz.DefaultMemoryPlan(), func(string, ...any) {}); err == nil {
		t.Fatal("超过水位 1 字节必须拒绝启动（判据不得放宽）")
	}
	// 正常机器：放行 + 明细进日志（运维据此看到各笔账的构成与**内存来源**）。
	var lines []string
	if err := checkStartupMemory(memAvail(64<<30), readyz.DefaultMemoryPlan(), func(format string, args ...any) {
		lines = append(lines, fmt.Sprintf(format, args...))
	}); err != nil {
		t.Fatalf("64 GiB 可用内存应通过：%v", err)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "memory budget") {
		t.Fatalf("启用时必须打印各笔账明细：%v", lines)
	}
	// 来源必须进日志（R1-rt-1：排障时第一眼要能看出这个数是宿主读的还是 cgroup 算的）。
	if !strings.Contains(joined, "mem_source=host") {
		t.Fatalf("日志必须带内存来源：%v", lines)
	}
}

// memAvail 构造一个"已读到"的可用内存结果（测试里不碰真实 /proc 与 cgroup）。
func memAvail(bytes int64) readyz.MemoryAvailability {
	return readyz.MemoryAvailability{Bytes: bytes, Source: readyz.MemorySourceHost, Detail: "测试注入"}
}

// TestMemorySelfCheckSkipsWhenUnknownButSaysSo：读不到可用内存时**跳过但大声说**（R1-rt-1）。
//
// 这一条同时钉住"保留可部署性"（不拒绝启动）与"fail-loud"（日志必须点名跳过）两半。
// 变异：把 Source=none 的分支删掉（让 CheckStartupMemoryFor 拿 0 去判）⇒ 第一个断言必红
// （会变成拒绝启动）；把日志删掉 ⇒ 第二个断言必红。
func TestMemorySelfCheckSkipsWhenUnknownButSaysSo(t *testing.T) {
	unknown := readyz.MemoryAvailability{Source: readyz.MemorySourceNone, Detail: "两个来源都读不到"}
	var lines []string
	logf := func(format string, args ...any) { lines = append(lines, fmt.Sprintf(format, args...)) }
	if err := checkStartupMemory(unknown, readyz.DefaultMemoryPlan(), logf); err != nil {
		t.Fatalf("读不到可用内存时不得拒绝启动（保留可部署性）：%v", err)
	}
	joined := strings.Join(lines, "\n")
	if !strings.Contains(joined, "未取到可用内存，跳过内存自检") {
		t.Fatalf("跳过必须是显式的日志（不许与'内存充足'同形）：%q", joined)
	}
	if !strings.Contains(joined, "两个来源都读不到") {
		t.Fatalf("日志必须带上读取失败的原因：%q", joined)
	}
	if strings.Contains(joined, "memory budget") {
		t.Fatalf("跳过时不该打印账面明细（会误导成已判定）：%q", joined)
	}
}

// TestMemorySelfCheckUsesCgroupAwareAvailability：R1-rt-1 的 P0 现场（装配级判据）：
// 宿主 7 GiB 可用 + 容器限额 256 MiB 的部署必须拒绝启动；旧实现只看 /proc/meminfo，
// 读到宿主 7 GiB 就放行，随后被内核 OOM-kill。
//
// 读取实现本身的四形态（v2 有上限 / v2=max / v1 / 全读不到）由 readyz 包的用例覆盖，
// 这里钉的是"装配自检用的是带来源的读取结果，而不是裸字节数"。
func TestMemorySelfCheckUsesCgroupAwareAvailability(t *testing.T) {
	limited := readyz.MemoryAvailability{
		Bytes:  256 << 20,
		Source: readyz.MemorySourceCgroup,
		Detail: "cgroup 限额 256 MiB − 用量 0 MiB = 剩余 256 MiB；宿主 MemAvailable 7168 MiB（取较小者：cgroup 剩余）",
	}
	if err := checkStartupMemory(limited, readyz.DefaultMemoryPlan(), func(string, ...any) {}); err == nil {
		t.Fatal("256 MiB 容器 + 默认档必须拒绝启动（宿主 7 GiB 不该放行）")
	}
	// 同一台机器、没有 cgroup 限额（来源=host）⇒ 放行：证明拒绝来自 cgroup 那一笔。
	if err := checkStartupMemory(memAvail(7<<30), readyz.DefaultMemoryPlan(), func(string, ...any) {}); err != nil {
		t.Fatalf("宿主 7 GiB 且无 cgroup 限额应放行：%v", err)
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
		{"checkStartupMemory(readMemoryAvailability(), plan, log.Printf)", "内存四笔账自检必须按部署档位算账，且用 cgroup 感知的读取结果（R1-rt-1）；W4 起不再有\"未启用\"档位（应用平台始终在服务）"},
		{"MemAvailable: readMemoryAvailability", "可用内存的来源与数值必须暴露在 /readyz 上（R1-rt-1）"},
		{"memprofile.FromEnv(os.Getenv)", "内存档位必须来自部署配置（未知档位 fail-loud）"},
		{"MemoryProfile: prof,", "档位必须真的喂给 appserver（声明与执行同一份数）"},
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
	db := requireRealDB(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
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

// ensureCompileChildNextToTestBinary 把编译子进程构建到**测试二进制同目录**。
//
// setupWasmPlatform 刻意不接 ChildBinary 注入（生产路径就是"server 与子进程同目录"），
// 所以要让它真的装上编译器、让 api.requireCompiler 放行，只能把产物放在它找的位置。
// 同包多次调用共享一份（已存在即跳过）。
func ensureCompileChildNextToTestBinary(t *testing.T) {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("定位测试二进制失败: %v", err)
	}
	out := filepath.Join(filepath.Dir(self), compile.ChildBinaryName)
	if _, err := os.Stat(out); err == nil {
		return
	}
	rootOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
	if err != nil {
		t.Fatalf("定位模块根失败（需要 go 工具链）: %v", err)
	}
	cmd := exec.Command("go", "build", "-o", out, "./cmd/picoaide-app-compile")
	cmd.Dir = strings.TrimSpace(string(rootOut))
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
	if b, berr := cmd.CombinedOutput(); berr != nil {
		t.Fatalf("构建编译子进程失败: %v\n%s", berr, b)
	}
}

// TestWasmInstanceMemoryComesFromSettingAfterRestart：P0-2 的**装配级**判据。
//
// 现场：控制台保存 instance_memory_mb=32 后只显示"需重启"，而装配期用的是部署档位
// （`prof.InstanceMemoryPages`）—— 重启也不生效；更糟的是装配期 `ApplyLimits` 的返回值
// 只进日志，于是重启后 restart_pending 被清空、界面显示"无需重启"，而实际值仍是档位值。
// 后果是"自检按设置算账、实际按档位跑"，2 GB 机器会 OOM（2026-09-18 决策要防的那条）。
//
// 判据分三段（都必须真跑装配，不接受源码文本断言）：
//  1. runtime 实际生效的页数 = **设置值**折算（不是档位值）；
//  2. 重启后 restart_pending **为空**（装配期已经用上了设置值，没有"待重启"残留）；
//  3. GET /wasm-apps/limits 如实反映"值来自控制台设置"，且四笔账的来源标签不是
//     硬写的 settings（旧实现里 profile 字段恒为 "settings"）。
//
// 变异验证：把 appserver.New 改回 `MemoryPages: prof.InstanceMemoryPages`
// ⇒ 第 1 段必红（2048 ≠ 1024 页）；把 limitsHolder.ApplyStartup 的调用去掉
// ⇒ 第 2 段在"设置值仍与档位值不同的场景"下必红。
func TestWasmInstanceMemoryComesFromSettingAfterRestart(t *testing.T) {
	// 档位固定为 small（64 MiB 实例内存），设置值 128 MiB —— 两者必须不同，
	// 否则这条用例证明不了"设置赢了档位"。
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	prof := memprofile.Small()
	if prof.InstanceMemoryBytes()>>20 == 128 {
		t.Fatalf("夹具失效：档位 %s 本身就是 128 MiB", prof.Name)
	}
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	saved := applimits.FromProfile(prof)
	saved.InstanceMemoryMB = 128
	saved.MaxInstances = prof.Instances // 3：四笔账在 CI 小机器上也能过水位
	if err := serverstore.SetSetting(db, SettingWasmLimits, saved.Encode()); err != nil {
		t.Fatalf("保存限制项设置失败: %v", err)
	}

	// 装配期有两处 fail-closed 只在启用应用子域时生效（可信代理 / 四笔账），
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

	// ---- ① runtime 实际值 = 设置值 ----
	// 128 MiB / 64 KiB = 2048 页。
	wantPages := uint32(128) * 1024 * 1024 / 65536
	if got := p.AppServer.InstanceMemoryPages(); got != wantPages {
		t.Fatalf("runtime 单实例内存页 = %d, want %d（设置 128 MiB；档位 %s = %d MiB）——"+
			"说明装配期仍按档位建 runtime（P0-2 的现场）",
			got, wantPages, prof.Name, prof.InstanceMemoryBytes()>>20)
	}
	// ---- ② 重启后不应再有"待重启"残留 ----
	if pending := p.Limits.RestartPending(); len(pending) != 0 {
		t.Fatalf("重启后 restart_pending = %v, want 空（装配期已按设置值建 runtime）", pending)
	}

	// ---- ③ GET /wasm-apps/limits 的视图 ----
	gin.SetMode(gin.TestMode)
	r := gin.New()
	// 管理面身份：生产由 AdminAuth 注入，这里直接放上下文（与 api 包测试同一契约）。
	r.Use(func(c *gin.Context) {
		c.Set("admin_user", &serverstore.User{Username: "boss", Role: serverstore.RoleSuperAdmin})
		c.Next()
	})
	// 走 AdminRoute 申报：顺带证明路由真的挂上了、权限点是读。
	serverauth.AdminRoute(r.Group(router.NamespaceServer+"/admin/wasm-apps"),
		"GET", "/limits", serverauth.PermCapabilityRead, p.API.AdminLimitsGet)
	w := httptest.NewRecorder()
	req := httptest.NewRequest("GET", router.NamespaceServer+"/admin/wasm-apps/limits", nil)
	r.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("GET /wasm-apps/limits = %d: %s", w.Code, w.Body.String())
	}
	var view struct {
		Limits struct {
			InstanceMemoryMB int `json:"instance_memory_mb"`
		} `json:"limits"`
		Source         string   `json:"source"`
		Profile        string   `json:"profile"`
		SourceLabel    string   `json:"source_label"`
		RestartPending []string `json:"restart_pending"`
		Budget         struct {
			Profile string `json:"profile"`
		} `json:"budget"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil {
		t.Fatalf("解析 /limits 视图失败: %v; body=%s", err, w.Body.String())
	}
	if view.Limits.InstanceMemoryMB != 128 {
		t.Fatalf("视图 instance_memory_mb = %d, want 128", view.Limits.InstanceMemoryMB)
	}
	if view.Source != "setting" {
		t.Fatalf("视图 source = %q, want setting（值来自控制台保存）", view.Source)
	}
	if view.Profile != prof.Name {
		t.Fatalf("视图必须回显部署档位名 %q，得到 %q", prof.Name, view.Profile)
	}
	if len(view.RestartPending) != 0 {
		t.Fatalf("视图 restart_pending = %v, want 空", view.RestartPending)
	}
	// 四笔账的来源标签如实反映来源（旧实现恒为 "settings"，与 source 字段矛盾）。
	if !strings.Contains(view.Budget.Profile, "setting") {
		t.Fatalf("四笔账来源标签 = %q，应反映「值来自控制台设置」", view.Budget.Profile)
	}
	if view.SourceLabel == "" {
		t.Fatal("视图必须给出一句可直接显示的来源说明（source_label）")
	}

	closed = true
	p.Close()
}

// TestWasmSavedLimitsFromOlderBuildStillApplies：**升级连续性**的装配级判据。
//
// 现场（本次要防的）：已发布的 v2.7.6-beta.4 里 `settings.wasm.limits` 存的是**旧字段
// 集合**（那时还没有 `app_db_readers`）。读取路径若沿用控制台 PUT 的严格 Parse
// （"字段必须完整"），升级后这条设置会被判为非法 → 回落部署档位 → 管理员眼前的
// 并发/内存全部变回档位值（"我的设置没了"），而日志只有一条 warning。
//
// 判据：塞一份**缺 app_db_readers** 的旧设置进库 → 真装配 → ①来源仍是 setting；
// ②旧设置里的已知字段逐字生效（instance_memory_mb=128 真的进了 runtime）；
// ③缺失的新字段补默认（app_db_readers = limits.AppDBReaders）；④不产生"待重启"残留。
//
// 变异验证：把 newWasmLimitsHolder 的读取改回 applimits.Parse ⇒ ①立刻变红
// （来源退化成 profile，instance_memory_mb 回到 64）。
func TestWasmSavedLimitsFromOlderBuildStillApplies(t *testing.T) {
	t.Setenv(memprofile.EnvMemoryProfile, "small")
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	// 旧版本落库形态：字段集合停在 v2.7.6-beta.4（无 app_db_readers）。
	const oldSetting = `{"max_instances":3,"app_running":2,"app_queue":16,` +
		`"user_global_running":2,"user_per_app_running":1,"user_per_app_queued":2,` +
		`"instance_memory_mb":128,"module_cache_mb":64,"module_cache_idle_min":10,` +
		`"appdb_idle_min":3,"appdb_cache_kib":512}`
	if err := serverstore.SetSetting(db, SettingWasmLimits, oldSetting); err != nil {
		t.Fatalf("写入旧版限制项设置失败: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	p := setupWasmPlatform(ctx, db, t.TempDir())
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	defer p.Close()

	if got := p.Limits.Source(); got != "setting" {
		t.Fatalf("设置来源 = %q，want setting —— 旧字段集合的设置被判非法并回落档位了"+
			"（读取路径必须前向兼容，见 applimits.ParseStored）", got)
	}
	l := p.Limits.Get()
	if l.InstanceMemoryMB != 128 || l.AppRunning != 2 {
		t.Fatalf("旧设置里的已知字段必须逐字生效，得到 %s", l.Encode())
	}
	if l.AppDBCacheKiB != 512 {
		t.Fatalf("appdb_cache_kib 应保留 512，得到 %d", l.AppDBCacheKiB)
	}
	if l.AppDBReaders != limits.AppDBReaders {
		t.Fatalf("缺失的新字段应补默认 %d，得到 %d", limits.AppDBReaders, l.AppDBReaders)
	}
	// 128 MiB / 64 KiB = 2048 页：证明"设置真的进了执行侧 runtime"，不是只读了个数。
	wantPages := uint32(128) * 1024 * 1024 / 65536
	if got := p.AppServer.InstanceMemoryPages(); got != wantPages {
		t.Fatalf("runtime 单实例内存页 = %d，want %d（旧设置应照常生效）", got, wantPages)
	}
	if pending := p.Limits.RestartPending(); len(pending) != 0 {
		t.Fatalf("旧设置装配后不该有「待重启」残留，得到 %v", pending)
	}
}

// ===== P1-8：管理端下架/冻结 → 逐出进程内驻留（装配级行为断言）=====
//
// 为什么不再用源码 grep：旧门禁只断言 `OnAppEvict: func(appID string) {...}` 这行
// 字符串还在，**分不清"接上了"与"handler 从不调用"** —— 而缺陷正是后者（管理端
// 处置不逐出，发布者路径逐出），于是它一路绿灯。
//
// 现在这条用例走完整条链：真装配 → 暖一个真实模块进模块缓存 → 调**真实的**
// 管理端 handler（经 AdminRoute 挂载、真实鉴权中间件位置）→ 断言缓存条目归零。
// 模型侧的两个 API 用例（api/admin_evict_test.go）用记账假钩子钉住"handler 调用钩子"，
// 两条合起来覆盖整条链。
//
// 变异验证：去掉 adminUnpublish / adminFreeze 里的 h.evictApp(appID)
// ⇒ 本用例对应断言必红（缓存条目仍是 1）。
func TestWasmAdminDisposalEvictsRuntimeCache(t *testing.T) {
	db := requireRealDB(t)
	ensureCompileChildNextToTestBinary(t)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dataRoot := t.TempDir()
	p := setupWasmPlatform(ctx, db, dataRoot)
	if p == nil {
		t.Fatal("setupWasmPlatform 返回 nil")
	}
	closed := false
	defer func() {
		if !closed {
			p.Close()
		}
	}()

	// ---- 造一个"已生效"的应用：直接落库 + 按 §4.2 布局写资源目录 ----
	// （不走发布链路：那是 api/appserver 两个包的用例已经覆盖的部分；这里要的是
	//  "有一个能被真的编译并进入模块缓存的生效版本"。）
	const appID = "evict-assembly"
	cfgJSON := `{"access":"public","purpose":"逐出链路测试","data_sensitivity":"internal"}`
	if _, err := serverstore.CreateUser(db, &serverstore.User{Username: "alice", Source: "local", Status: 1, Role: serverstore.RoleUser}); err != nil {
		t.Fatalf("建用户失败: %v", err)
	}
	if err := serverstore.UpsertWasmApp(ctx, db, serverstore.WasmApp{
		AppID: appID, Title: "逐出测试", Owner: "alice",
		Channel: serverstore.AppChannelWasm, Enabled: true,
		Purpose: "逐出链路测试", DataSensitivity: "internal", ConfigJSON: cfgJSON,
	}); err != nil {
		t.Fatalf("落应用行失败: %v", err)
	}
	relID, err := serverstore.CreateWasmRelease(ctx, db, serverstore.WasmRelease{
		AppID: appID, Version: "1.0.0", Title: "逐出测试", Publisher: "alice",
		Status: serverstore.ReleaseStatusApproved, Wasm: refAppModule(t), ConfigJSON: cfgJSON,
	})
	if err != nil {
		t.Fatalf("落版本行失败: %v", err)
	}
	if err := serverstore.SetWasmAppCurrentRelease(ctx, db, appID, relID); err != nil {
		t.Fatalf("置生效版本失败: %v", err)
	}
	// 2026-09-20 起随包资源不再落盘：配置就取自上面那行 `ConfigJSON`（库内权威副本），
	// 资源集由 appserver 在运行期从制品字节解析自定义段得到 —— 这里**故意不写任何磁盘
	// 资源目录**，正是为了证明"不落盘也能跑通编译/缓存/逐出这条链"。

	serve := func() {
		t.Helper()
		// 客户端专属模型：请求由桌面客户端的协议 handler 合成
		// （`<app scheme>://<app_id>` + 注入身份），统一走 ServeClientRequest。
		req := httptest.NewRequest(http.MethodGet, "http://"+appID+"/", nil)
		req.URL.Scheme, req.URL.Host, req.Host = appserver.ClientScheme, appID, appID
		rec := httptest.NewRecorder()
		p.AppServer.ServeClientRequest(rec, req, appID, &serverstore.User{ID: 1, Username: "alice"}, "0123456789abcdef0123456789abcdef")
		if rec.Code != 200 {
			t.Fatalf("客户端应用请求 = %d, want 200; body=%s", rec.Code, rec.Body.String())
		}
	}

	// ---- 暖机：首个请求冷编译，模块进缓存 ----
	serve()
	if got := p.AppServer.CachedModuleCount(); got != 1 {
		t.Fatalf("暖机后模块缓存条目 = %d, want 1（冷编译没进缓存，后面的断言就没有意义）", got)
	}

	// ---- 管理端下架 ⇒ 逐出 ----
	admin := newWasmAdminCaller(t, p)
	admin.post("/unpublish", appID, nil)
	if got := p.AppServer.CachedModuleCount(); got != 0 {
		t.Fatalf("管理员下架后模块缓存仍有 %d 条：管理端没有逐出进程内驻留（P1-8）", got)
	}

	// ---- 再上架 + 再暖机 + 冻结 ⇒ 逐出 ----
	admin.post("/publish", appID, nil)
	serve()
	if got := p.AppServer.CachedModuleCount(); got != 1 {
		t.Fatalf("重新上架后暖机条目 = %d, want 1", got)
	}
	admin.post("/freeze", appID, nil)
	if got := p.AppServer.CachedModuleCount(); got != 0 {
		t.Fatalf("管理员冻结后模块缓存仍有 %d 条：管理端没有逐出进程内驻留（P1-8）", got)
	}

	closed = true
	p.Close()
}

// wasmAdminCaller 把管理端 handler 挂在**生产路径 + AdminRoute** 上调用
// （参数绑定/权限申报与生产同一形状；身份由中间件直接注入，与 api 包测试同一契约）。
type wasmAdminCaller struct {
	t *testing.T
	r *gin.Engine
	p *wasmPlatform
}

func newWasmAdminCaller(t *testing.T, p *wasmPlatform) *wasmAdminCaller {
	t.Helper()
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Set("admin_user", &serverstore.User{Username: "boss", Role: serverstore.RoleSuperAdmin})
		c.Next()
	})
	g := r.Group(router.NamespaceServer + "/admin/wasm-apps")
	serverauth.AdminRoute(g, "POST", "/:app_id/unpublish", serverauth.PermCapabilityWrite, p.API.AdminUnpublish)
	serverauth.AdminRoute(g, "POST", "/:app_id/publish", serverauth.PermCapabilityWrite, p.API.AdminPublish)
	serverauth.AdminRoute(g, "POST", "/:app_id/freeze", serverauth.PermCapabilityWrite, p.API.AdminFreeze)
	return &wasmAdminCaller{t: t, r: r, p: p}
}

func (a *wasmAdminCaller) post(action, appID string, body any) {
	a.t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		if err != nil {
			a.t.Fatalf("序列化请求体失败: %v", err)
		}
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest("POST",
		router.NamespaceServer+"/admin/wasm-apps/"+appID+action, reader)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.r.ServeHTTP(w, req)
	if w.Code != 200 {
		a.t.Fatalf("管理端 %s %s = %d; body=%s", action, appID, w.Code, w.Body.String())
	}
}

// refAppModule 现场编译参考实现为 wasip1 模块（整包复用一次）。
//
// 用 refapp 而不是最小空模块：它能读请求帧并写出合法响应帧，因此 ServeApp 能真的
// 走完"编译 → 实例化 → 调用 → 响应"（缓存里才会留下模块）。
func refAppModule(t *testing.T) []byte {
	t.Helper()
	refAppOnce.Do(func() {
		rootOut, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}").Output()
		if err != nil {
			refAppErr = err
			return
		}
		dir, err := os.MkdirTemp("", "picoaide-cmdserver-refapp-")
		if err != nil {
			refAppErr = err
			return
		}
		out := filepath.Join(dir, "refapp.wasm")
		cmd := exec.Command("go", "build", "-o", out, "./internal/wasmapp/refapp")
		cmd.Dir = strings.TrimSpace(string(rootOut))
		cmd.Env = append(os.Environ(), "GOOS=wasip1", "GOARCH=wasm", "CGO_ENABLED=0")
		if b, berr := cmd.CombinedOutput(); berr != nil {
			refAppErr = fmt.Errorf("构建 refapp 失败: %v\n%s", berr, b)
			return
		}
		refAppBytes, refAppErr = os.ReadFile(out)
	})
	if refAppErr != nil {
		t.Fatalf("%v", refAppErr)
	}
	return refAppBytes
}

var (
	refAppOnce  sync.Once
	refAppBytes []byte
	refAppErr   error
)
