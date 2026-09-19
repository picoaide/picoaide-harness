package api

// 本文件是 **R2-DG-2 / R2-DG-3**（第二轮对抗式审计 · 诊断区域）的行为级护栏：
// 诊断出口里的"单实例线性内存上限"必须来自**运行时生效值**，而不是"控制台已保存值"。
//
// 缺陷现场（审计实测，tip 3e490f2fb2）：
//   - `read.go` 的 hints 走 `h.instanceMemoryPages()` = `Options.Limits().InstanceMemoryPages()`
//     —— 那是**已保存值**；
//   - 单实例内存上限住在 wazero 的 RuntimeConfig 里，**保存后要重启才生效** ⇒ 在重启窗口里
//     两者不同（实测：保存 32 MiB 未重启、实际按 128 MiB 跑，差 96 MiB）；
//   - 更糟的是那条接线**零护栏**：把 read.go 回退成编译期常量，整包 api 用例 153.8s 全绿。
//
// 修法：`Options.EffectiveMemoryPages`（生产装配注入 appserver.InstanceMemoryPages）+
// read.go 的 `effectiveMemoryPages()`（运行时优先、已保存值只兜底）。
//
// 变异验证（把实现改回去，本用例必红）：
//   - read.go 把 `h.effectiveMemoryPages()` 改回 `h.instanceMemoryPages()` ⇒
//     hints 会渲染"64 MiB"（已保存值）而不是"128 MiB"（生效值）⇒ 红；
//   - cmd/server 删掉 `EffectiveMemoryPages:` 那一行 ⇒ 抓不到生效值 ⇒ 同样红
//     （装配级判据见 cmd/server 的同名装配用例）。

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// diagnosticsHintsFor 真跑一次 diagnosticsPayload（含 DB 查询与 hints 合并），
// 返回它下发给控制台/AI 的 hints。
//
// ⚠️ 必须驱动真接线：只调 diag.HintsForMemoryPages 的话，把 read.go 改回已保存值也不会有
// 任何反应 —— 那正是这条缺陷此前零护栏的形态。
func diagnosticsHintsFor(t *testing.T, h *Handlers, appID string) []string {
	t.Helper()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET",
		"/api/client/v2/apps/wasm/"+appID+"/diagnostics?minutes=60&limit=10", nil)
	body, aerr := h.diagnosticsPayload(c, appID, &serverstore.WasmApp{AppID: appID, Enabled: true})
	if aerr != nil {
		t.Fatalf("diagnosticsPayload: %v", aerr.JSON())
	}
	raw, _ := json.Marshal(body["hints"])
	var hints []string
	if err := json.Unmarshal(raw, &hints); err != nil {
		t.Fatalf("解析 hints: %v", err)
	}
	return hints
}

func hintsContain(hints []string, needle string) bool {
	for _, hint := range hints {
		if strings.Contains(hint, needle) {
			return true
		}
	}
	return false
}

// TestDiagnosticsMemoryHintFollowsEffectiveNotSaved 是 R2-DG-2 的核心判据：
// "已保存 64 MiB、运行时生效 128 MiB"时，hints 必须说 128 MiB。
//
// 两条断言互为反向对照（只说"出现 128"会漏掉"两个都出现"的假修）：
//  1. 必须出现生效值 128 MiB；
//  2. 不得出现已保存值 64 MiB。
func TestDiagnosticsMemoryHintFollowsEffectiveNotSaved(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()

	const appID = "diag-effective"
	if _, err := db.ExecContext(ctx, `INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, guest_exit_code, stderr_tail, cpu_ms, peak_memory_bytes, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		appID, 0, "error", string(apperr.CodeRuntimeMemory), 2, "traceback...", 12, 4096,
		time.Now().UTC()); err != nil {
		t.Fatalf("写调用事件: %v", err)
	}

	saved := applimits.Defaults() // 64 MiB（= 控制台已保存值）
	if saved.InstanceMemoryMB == 128 {
		t.Fatalf("夹具失效：默认档位本身就是 128 MiB")
	}
	const effectivePages = uint32(128) * 1024 * 1024 / uint32(limits.WasmPageSize) // 128 MiB
	h := NewHandlers(Options{
		DB:     db,
		Limits: func() applimits.Limits { return saved },
		// 运行时真正生效的值（装配注入 appserver.InstanceMemoryPages）。
		EffectiveMemoryPages: func() uint32 { return effectivePages },
	})

	hints := diagnosticsHintsFor(t, h, appID)
	if !hintsContain(hints, "128 MiB") {
		t.Fatalf("诊断 hints 必须跟随**生效值** 128 MiB，实际：%v", hints)
	}
	if hintsContain(hints, "64 MiB") {
		t.Fatalf("诊断 hints 不得回显**已保存值** 64 MiB（重启窗口里它不是生效值）：%v", hints)
	}

	// 反向：生效值变了（重启后）hints 必须跟着变 —— 证明它不是被写死的常量。
	h2 := NewHandlers(Options{
		DB:                   db,
		Limits:               func() applimits.Limits { return saved },
		EffectiveMemoryPages: func() uint32 { return 256 * 1024 * 1024 / uint32(limits.WasmPageSize) },
	})
	hints2 := diagnosticsHintsFor(t, h2, appID)
	if !hintsContain(hints2, "256 MiB") {
		t.Fatalf("生效值改为 256 MiB 后 hints 必须跟随，实际：%v", hints2)
	}
}

// TestDiagnosticsMemoryHintFallsBackToLimits 钉住兜底路径：装配没注入生效值钩子时，
// hints 回落到 `Options.Limits()`（已保存值）—— 语义与 R1-rt-25 之前一致，
// 不许因为加了新钩子就让最小装配渲染出编译期默认（那会把控制台配过的值又抹掉）。
func TestDiagnosticsMemoryHintFallsBackToLimits(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	defer cleanup()
	ctx := context.Background()
	const appID = "diag-fallback"
	if _, err := db.ExecContext(ctx, `INSERT INTO wasm_call_events
		(app_id, user_id, outcome, reason_code, guest_exit_code, stderr_tail, cpu_ms, peak_memory_bytes, created_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		appID, 0, "error", string(apperr.CodeRuntimeMemory), 2, "traceback...", 12, 4096,
		time.Now().UTC()); err != nil {
		t.Fatalf("写调用事件: %v", err)
	}
	saved := applimits.Defaults()
	saved.InstanceMemoryMB = 32
	h := NewHandlers(Options{DB: db, Limits: func() applimits.Limits { return saved }})
	if hints := diagnosticsHintsFor(t, h, appID); !hintsContain(hints, "32 MiB") {
		t.Fatalf("未注入生效值钩子时应回落到 Limits()（32 MiB），实际：%v", hints)
	}
}
