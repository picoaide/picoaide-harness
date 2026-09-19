package api

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是审计 R1-rt-7 的回归护栏：**发布干跑必须与执行侧同源取单实例内存上限**。
//
// 现场：api/publish.go 的 dryRun 只传 `runtime.Options{DataRoot: …}`，MemoryPages 为零值
// ⇒ runtime.New 回落编译期 64 MiB。控制台把 instance_memory_mb 调小 ⇒ 干跑在 64 MiB 下
// **放行线上跑不起来的应用**（首个请求 RUNTIME_MEMORY）；调大 ⇒ 误拒本来就合法的应用。
// 干跑存在的理由正是"编译通过 ≠ 能跑"，用错上限等于把它变成摆设。
//
// 判据是**行为**的，不是源码文本：构造一个初始内存声明 > 64 MiB 的模块，
//   - 生效上限 128 MiB ⇒ 装载必须通过（错误不再是"模块无法被运行时装载"）；
//   - 回落编译期默认（64 MiB）⇒ 装载必须被拒。
//
// 变异验证（实测：改回缺陷实现时哪条必红）：把 dryRun 的
// `MemoryPages: h.instanceMemoryPages()` 删掉 ⇒ 第一段断言必红（128 MiB 的干跑退回 64 MiB，
// 与"没有注入 Limits"的行为逐字相同）。
func TestDryRunUsesEffectiveInstanceMemoryLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 128 MiB / 64 KiB = 2048 页：一半在当前默认之上（64 MiB = 1024 页）。
	const declaredPages = 2048
	mod := wasmtest.Build(
		wasmtest.TypeSection(wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params())),
		wasmtest.FunctionSection(0),
		wasmtest.MemorySection(declaredPages),
		wasmtest.ExportSection(wasmtest.ExportMemory("memory", 0), wasmtest.ExportFunc("_start", 0)),
		wasmtest.CodeSection(wasmtest.Body(0x0b)),
	)

	run := func(t *testing.T, opt Options) *apperr.Error {
		t.Helper()
		h := NewHandlers(opt)
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("POST", "/api/client/v2/apps/wasm/validate", nil)
		return h.dryRun(c, "dryrunmem", "1.0.0", mod, appcfg.Config{})
	}

	// ① 生效上限 128 MiB（控制台设置值）⇒ 装载不得因"内存声明超过平台上限"失败。
	lim := applimits.Defaults()
	lim.InstanceMemoryMB = 128
	if lim.InstanceMemoryPages() != declaredPages {
		t.Fatalf("前置：128 MiB 应换算成 %d 页，得到 %d", declaredPages, lim.InstanceMemoryPages())
	}
	got := run(t, Options{
		DataRoot: t.TempDir(),
		Limits:   func() applimits.Limits { return lim },
	})
	// 装载通过之后干跑会继续往下走（本模块不写响应帧 ⇒ RUNTIME_NO_RESPONSE，属预期）：
	// 判据只看"有没有卡在装载那一关"。
	if got != nil && got.Code == apperr.CodeValidateFailed {
		t.Fatalf("生效上限 128 MiB 时，声明 %d 页（128 MiB）的模块必须能装载；"+
			"却拿到 %s：%s（干跑回落到了编译期 64 MiB）", declaredPages, got.Code, got.JSON())
	}

	// ② 对照：不注入 Limits（= 缺陷实现的回落路径，编译期 64 MiB）⇒ 同一模块必须装载失败。
	//    这一段是"变异后必红"的锚点：若第一段与这一段的行为相同，说明上限没被真的生效。
	fallback := run(t, Options{DataRoot: t.TempDir()})
	if fallback == nil || fallback.Code != apperr.CodeValidateFailed {
		t.Fatalf("64 MiB 上限下声明 128 MiB 的模块必须装载失败（对照锚点），得到 %v", fallback)
	}

	// ③ 生效上限 64 MiB（与编译期默认同值但**来自限制项**）⇒ 与 ② 同判：证明 ① 的差别
	//    来自注入的生效值，而不是"注入 Limits 这件事"本身改变了行为。
	small := applimits.Defaults()
	small.InstanceMemoryMB = limits.InstanceMemoryPages * limits.WasmPageSize >> 20 // 64 MiB
	if got := run(t, Options{
		DataRoot: t.TempDir(),
		Limits:   func() applimits.Limits { return small },
	}); got == nil || got.Code != apperr.CodeValidateFailed {
		t.Fatalf("生效上限 64 MiB 时同一模块必须装载失败，得到 %v", got)
	}
}

// TestInstanceMemoryPagesHelperFollowsInjectedLimits：干跑用的页数取自装配注入的闭包
// （最小装配 = nil ⇒ 0 ⇒ 由 runtime.New 回落编译期默认，保持既有测试可用）。
func TestInstanceMemoryPagesHelperFollowsInjectedLimits(t *testing.T) {
	if got := NewHandlers(Options{}).instanceMemoryPages(); got != 0 {
		t.Fatalf("未注入 Limits 时应返回 0（回落 runtime 默认），得到 %d", got)
	}
	lim := applimits.Defaults()
	lim.InstanceMemoryMB = 128
	h := NewHandlers(Options{Limits: func() applimits.Limits { return lim }})
	if got, want := h.instanceMemoryPages(), uint32(2048); got != want {
		t.Fatalf("干跑页数 = %d，期望 %d（128 MiB）", got, want)
	}
}
