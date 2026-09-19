package api

import (
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
)

// R5（2026-09-19，审计残留 P2）：发布干跑必须取**运行时生效**的单实例内存上限，
// 不是**已保存**的控制台值。
//
// 缺陷窗口（与 R1-rt-7 同一族，但方向相反）：单实例上限住在 wazero 的 RuntimeConfig 里，
// 控制台保存之后**要重启才生效**。在"已保存 32 MiB、运行时仍按 128 MiB 跑"的窗口里，
// 干跑若读已保存值，就会拿一个**并不生效**的 32 MiB 去装载模块 ⇒ **误拒**一个线上完全
// 跑得起来的应用（作者只看到"模块无法被运行时装载"，而真实原因是控制台里那个还没生效的数字）。
// 干跑要回答的是"这次运行到底能不能跑起来"，所以必须用生效值。
//
// 判据是行为的（真 wasm + 真 runtime，不看源码文本）：声明 100 MiB 初始内存的模块
//   - ① 已保存 32 MiB / 生效 128 MiB ⇒ **装载必须通过**（说明用的是生效值）；
//   - ② 对照锚点：已保存 32 MiB / 生效 32 MiB ⇒ 同一模块**必须装载失败**
//     （证明这个模块真的需要 >32 MiB —— 没有它，① 可能只是"这个模块本来就能装"）；
//   - ③ 运行时钩子未注入/未就绪（返回 0）⇒ 回落已保存值（兼容路径不变）。
//
// 变异验证（实测见 temp/wasm-review-r1/fix-audit2.md）：把 dryRun 的
// `MemoryPages: h.effectiveMemoryPages()` 改回 `h.instanceMemoryPages()`（已保存值）
// ⇒ ① 红（行为与 ② 逐字相同：生效的 128 MiB 根本没被用上）。
func TestDryRunUsesRuntimeEffectiveMemoryLimit(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 100 MiB = 1600 页：大于已保存的 32 MiB（512 页）、小于生效的 128 MiB（2048 页）。
	const declaredPages = 1600
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
		return h.dryRun(c, "dryruneff", "1.0.0", mod, appcfg.Config{})
	}
	// 装载被拒的判据与 R1-rt-7 的护栏同源：runtime.New 按给定页数建 runtime，
	// 声明页数超过上限 ⇒ CompileModule 失败 ⇒ VALIDATE_FAILED("模块无法被运行时装载")。
	rejectedAtLoad := func(e *apperr.Error) bool { return e != nil && e.Code == apperr.CodeValidateFailed }

	saved := applimits.Defaults()
	saved.InstanceMemoryMB = 32
	if saved.InstanceMemoryPages() >= declaredPages {
		t.Fatalf("前置：已保存值必须是 %d MiB（< %d 页），得到 %d 页",
			32, declaredPages, saved.InstanceMemoryPages())
	}
	const effectivePages = uint32(2048) // 128 MiB：模拟"运行时仍在按旧上限跑"

	// ① 已保存 32 MiB、生效 128 MiB ⇒ 装载必须通过（判据只看有没有卡在装载那一关；
	//    本模块不写响应帧，随后会是 RUNTIME_NO_RESPONSE，属预期）。
	got := run(t, Options{
		DataRoot:             t.TempDir(),
		Limits:               func() applimits.Limits { return saved },
		EffectiveMemoryPages: func() uint32 { return effectivePages },
	})
	if rejectedAtLoad(got) {
		t.Fatalf("干跑用了**已保存**的 32 MiB 而不是运行时生效的 128 MiB：声明 %d 页（100 MiB）的模块"+
			"在真实上限 128 MiB 下能跑，却被误拒（%s：%s）—— 作者只会看到「模块无法被运行时装载」，"+
			"真实原因是控制台里那个还没重启生效的数字", declaredPages, got.Code, got.JSON())
	}

	// ② 对照锚点：生效值与已保存值一致（都是 32 MiB）⇒ 同一模块必须装载失败。
	//    没有这一段，① 可能只是"这个模块本来就能装"。
	denied := run(t, Options{
		DataRoot:             t.TempDir(),
		Limits:               func() applimits.Limits { return saved },
		EffectiveMemoryPages: func() uint32 { return saved.InstanceMemoryPages() },
	})
	if !rejectedAtLoad(denied) {
		t.Fatalf("对照锚点失败：32 MiB 上限下声明 %d 页（100 MiB）的模块必须装载失败，得到 %v",
			declaredPages, denied)
	}

	// ③ 运行时钩子没接线/运行时未就绪（返回 0）⇒ 回落已保存值（read.go 的兼容路径不变）。
	fallback := run(t, Options{
		DataRoot:             t.TempDir(),
		Limits:               func() applimits.Limits { return saved },
		EffectiveMemoryPages: func() uint32 { return 0 },
	})
	if !rejectedAtLoad(fallback) {
		t.Fatalf("生效值取不到时应回落已保存的 32 MiB（同一模块仍须装载失败），得到 %v", fallback)
	}
}
