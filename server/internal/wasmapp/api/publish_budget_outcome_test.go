package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件闭合「N1 的出口归一不得改判业务拒绝」这条规则（审计 P3-1）。
//
// 规则本体在 `publishErrorOutcome`（publish.go 的四条归一规则，顺序即优先级）：
//
//	② 总预算 ctx **没到点** ⇒ 原样（不是超时引起的失败，一个字都不改）；
//	④ 到点了，但失败**既不是** ctx 到点引起的（cause 链里没有 `DeadlineExceeded`）
//	   **也不是** `INTERNAL` ⇒ 原样（业务拒绝：版本不新 / 越权 / 配置不合法…）。
//
// 为什么第 ④ 条的形态判据承重：业务拒绝与"总预算到点"在毫秒级窗口里可能同时发生。只按
// "ctx 到点就改判"会把一次真实的「版本号必须比当前版本新」报成「平台侧总预算用尽」，让作者
// 去重发同一个版本号 —— 错误指不到病根。审计实证：删掉这一句之后**全部行为级交付判据
// 仍然全绿**（只有单元探针红），所以本文件的判据就是这条规则的**唯一**牙齿。
//
// 为什么判据是单元级而不是"从入口驱动"：**端到端形态结构上不可达**。生产链路里每一次
// ctx 到点都会先被 ctx 感知的调用（pgx 查询、编译子进程、guest 执行）捕获 ⇒ 失败形态必然是
// `DeadlineExceeded`（规则 ④ 的第一半）或 `INTERNAL`（第二半），两者都**应该**改判。规则 ④
// 真正守护的是"DB 读刚成功、Go 侧业务判定紧接着失败"的那条缝（微秒级、无法用 sleep 对齐）。
// 因此这里直接驱动出口归一函数本身，并把**用户可见的结论**（HTTP 状态 + 信封码 + phase）
// 一并钉住 —— 输出的不是"函数返回了什么"，而是"客户端会收到什么"。
//
// 变异验证（实跑记录见交付报告）：删掉 `if !errors.Is(err, context.DeadlineExceeded) &&
// err.Code != apperr.CodeInternal { return err }` 这一句（= "到点就改判"）⇒ 本用例的前三个
// 子用例红（VERSION_NOT_NEWER / FORBIDDEN / APP_CONFIG_INVALID 全被改判成 504
// `phase=publish_budget`），而第 4/5/6/7 条（正控与规则 ①②③）保持绿。
func TestPublishErrorOutcomeKeepsBusinessRejections(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 两个 Handler：一个时钟拨回 2 h（挂上的总预算**已经到点**），一个是正常时钟（没到点）。
	// `Now` 是 `publishBudgetCtx` 唯一的起算点来源 ⇒ 这是造"到点"的确定性手段。
	expiredHandlers := NewHandlers(Options{Now: func() time.Time { return time.Now().UTC().Add(-2 * time.Hour) }})
	liveHandlers := NewHandlers(Options{Now: func() time.Time { return time.Now().UTC() }})

	// 规则 ③（幂等）用的"已经是预算结论"的错误：用生产同一个构造器造，避免自造字面量。
	alreadyBudget := budgetExceeded(publishBudget{total: limits.PublishTotalBudget}, "compile")

	cases := []struct {
		name string
		h    *Handlers
		// attach=false ⇒ 请求上没有总预算载体（不属发布链路）。
		attach bool
		err    *apperr.Error
		// wantSame=true ⇒ 必须**原样透传**（同一个指针、code/message/details 一字不改）。
		wantSame  bool
		wantCode  apperr.Code
		wantPhase string
	}{
		{
			name: "到点 + 业务拒绝（版本不新）必须原样透传", h: expiredHandlers, attach: true,
			err:      apperr.New(apperr.CodeVersionNotNewer, "版本号必须比当前版本新"),
			wantSame: true, wantCode: apperr.CodeVersionNotNewer,
		},
		{
			name: "到点 + 业务拒绝（应用已锁定/越权）必须原样透传", h: expiredHandlers, attach: true,
			err:      apperr.New(apperr.CodeForbidden, "应用已锁定"),
			wantSame: true, wantCode: apperr.CodeForbidden,
		},
		{
			name: "到点 + 业务拒绝（配置不合法）必须原样透传", h: expiredHandlers, attach: true,
			err:      apperr.New(apperr.CodeAppConfigBad, "配置不合法"),
			wantSame: true, wantCode: apperr.CodeAppConfigBad,
		},
		{
			name: "到点 + INTERNAL（正控：这正是要改判的形态）", h: expiredHandlers, attach: true,
			err:      internalErr("查询失败", nil),
			wantSame: false, wantCode: apperr.CodeRuntimeTimeout, wantPhase: "publish_budget",
		},
		{
			name: "到点 + cause 链里有 DeadlineExceeded（正控：与码无关）", h: expiredHandlers, attach: true,
			err:      apperr.New(apperr.CodeValidation, "读取被取消").WithCause(context.DeadlineExceeded),
			wantSame: false, wantCode: apperr.CodeRuntimeTimeout, wantPhase: "publish_budget",
		},
		{
			name: "未到点 + INTERNAL（规则 ②：不是超时引起的失败一个字都不改）", h: liveHandlers, attach: true,
			err:      internalErr("查询失败", nil),
			wantSame: true, wantCode: apperr.CodeInternal,
		},
		{
			name: "没有预算载体 + INTERNAL（规则 ①：不属发布链路）", h: expiredHandlers, attach: false,
			err:      internalErr("查询失败", nil),
			wantSame: true, wantCode: apperr.CodeInternal,
		},
		{
			name: "已经是预算结论（规则 ③：幂等，不二次包装）", h: expiredHandlers, attach: true,
			err:      alreadyBudget,
			wantSame: true, wantCode: apperr.CodeRuntimeTimeout, wantPhase: "publish_budget",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(w)
			req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/demo/releases", nil)
			if tc.attach {
				ctx, _, cancel := tc.h.publishBudgetCtx(req.Context(), 0)
				t.Cleanup(cancel)
				req = req.WithContext(ctx)
			}
			c.Request = req

			got := tc.h.publishErrorOutcome(c, tc.err, "前置读")
			if got == nil {
				t.Fatal("publishErrorOutcome 返回 nil（入了错误就不该被吞掉）")
			}
			if tc.wantSame && got != tc.err {
				t.Fatalf("业务/链路错误被改判了：\n  原错误 = %s code=%s details=%v\n  改判后 = %s code=%s details=%v\n"+
					"  （到点只允许把「ctx 到点引起的失败」或 INTERNAL 归一成预算结论；"+
					"其它错误必须原样透传 —— 否则「版本不新」会被报成「预算用尽」）",
					tc.err.Message, tc.err.Code, tc.err.Details,
					got.Message, got.Code, got.Details)
			}
			if !tc.wantSame && got == tc.err {
				t.Fatalf("该改判的形态没有被改判：code=%s details=%v（到点 + INTERNAL / ctx 到点引起的失败"+
					"必须归一成结构化预算结论）", got.Code, got.Details)
			}

			// 用户可见的结论 = HTTP 状态 + 信封（不是"函数返回了什么"）。
			writeErr(c, got)
			if w.Code != apperr.StatusOf(tc.wantCode) {
				t.Fatalf("HTTP 状态 = %d，期望 %d（body=%s）", w.Code, apperr.StatusOf(tc.wantCode), w.Body.String())
			}
			var eb errBody
			if jerr := json.Unmarshal(w.Body.Bytes(), &eb); jerr != nil {
				t.Fatalf("响应不是 JSON 错误信封: %v; body=%s", jerr, w.Body.String())
			}
			if eb.Error.Code != string(tc.wantCode) {
				t.Fatalf("信封 code = %s，期望 %s（body=%s）", eb.Error.Code, tc.wantCode, w.Body.String())
			}
			if phase, _ := eb.Error.Details["phase"].(string); phase != tc.wantPhase {
				t.Fatalf("信封 details.phase = %q，期望 %q（body=%s）", phase, tc.wantPhase, w.Body.String())
			}
		})
	}
}
