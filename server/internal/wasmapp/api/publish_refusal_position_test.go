package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// 本文件是审计 FW-2「入口拒绝必须发生在读请求体之前」在**三条发布入口**上的**拒绝闸门
// 位置**判据（FW-E，2026-10-04）。
//
// 缺口形态（独立核验代理 FW-D-V §6.1 实测的变异 M-E）：只把 `publish` 里的
//
//	if rerr := h.publishBudgetRefusal(publishBudgetPlan)   // ← 拒绝闸门
//
// 挪到 `bindJSONLimited`（读请求体）**之后**，而预算**挂载**仍留在入口不动 ⇒ 发布预算族
// 全部判据仍然绿（整族 EXIT=0），而行为差是
//
//	交付树: elapsed=2.509627ms   status=504（拒绝在读体之前）
//	M-E 树: elapsed=3.002994919s status=504（把 3 s 请求体读完才拒绝）
//
// 后果：本该被**立刻拒绝**的请求先吃掉一次 `acquireUpload` 小时额度，并把最多 48 MiB
// 请求体读完。
//
// 为什么既有判据咬不到这一位置：
//   - `TestPublishBudgetForReadsRequestHeader` 只测"预算计划与拒绝函数本身"，不进任何入口；
//   - 走真实入口的 `TestRealEntriesHonorTotalBudget` 只发**不带头**的请求（`declared == 0`
//     ⇒ 拒绝闸门恒为 no-op），挪动它不改变任何行为；
//   - 带 `ClientBudgetHeader` 的端到端只有 `complete` 一条
//     （`TestUploadCompleteHonorsClientDeclaredBudget`），publish / validate 侧零覆盖。
//
// 判据（三条入口各驱动一次真实 HTTP 请求：生产路由树 + 真 PG + 真编译器；三条**同形**）：
//
//	① 结论是**结构化预算失败**：504 + `RUNTIME_TIMEOUT` + `details.phase=publish_budget`
//	   + `publish_total_budget_seconds=0` + `client_declared_budget_seconds=1` + 指向
//	   `upload_id` 重发的 hints（与既有判据同形）；
//	② 结论**远早于读体耗时**返回：请求体 3 s 才到达，上界 1 s（交付树实测毫秒量级）；
//	③ **结构性**判据：慢请求体的第一次 `Read` 从未发生 ⇒ 闸门确实在读体**之前**
//	   —— 这条直接表达那条位置纪律，不依赖墙钟与负载；
//	④ **额度判据**（FW-F，2026-10-04）：拒绝前后 `Compiler.UploadState` 的**小时额度用量
//	   不变** ⇒ 闸门确实在 `acquireUpload` **之前**（见下面「同族更窄的缺口」）。
//
// 同族更窄的缺口（核验代理 FW-E-V §5 实测的变异 M-X5；④ 就是为它补的）：只把拒绝闸门挪到
// `acquireUpload` **之后**、`bindJSONLimited`（读体）**之前** ⇒ ①②③ 全绿（结论仍是毫秒级
// 504、请求体仍一个字节没读），**整族 11 顶层 + 16 子用例也全绿**，而拒绝**真的吃掉了一次
// 上传小时额度**（其一次性探针实测：`quota status=504 elapsed=3.191521ms used_before=0 used_after=1`）。
// 这破坏的是 `publish.go:287-289` 成文的不变量 —— 拒绝「**不占编译槽、不烧上传额度、
// 不读请求体**」：①②③ 只守住最后一条，④ 守的是中间那条。
//
// 变异验证（实跑见交付报告 temp/audit-v282/fixes/FW-F.md）：把任一条入口的拒绝闸门挪到
// `bindJSONLimited` 之后 ⇒ 对应子用例在同一批跑里红（②与③同时红），其余判据保持绿；
// 只挪到 `acquireUpload` 之后（M-X5 / M-X5b）⇒ ②③ 保持绿，**④ 红**。
func TestDeclaredBudgetRefusalPrecedesRequestBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 请求体在 readDelay 之后才到达；拒绝必须发生在它之前，且远早于它。
	const readDelay = 3 * time.Second
	const refusalUpperBound = time.Second
	// 声明 1 s：不足传输余量（`limits.PublishTransferReserve` = 15 s）⇒ 有效预算 0
	// ⇒ 入口立刻给结构化结论（见 publishBudgetRefusal）。
	const declaredBudget = "1000"

	env := newUploadEnv(t)
	wasm := testGuestModule(t)

	// 自校准（防止 ④ 静默失去牙）：`quotaState` 按 alice 的**用户 id** 观察额度计数 ——
	// `UploadState` 是按 id 查表的，夹具若改了 token→用户映射，`env.ids["alice"]` 会取到
	// 零值，`UploadState(0, …)` 恒返回 `0, 0`，④ 就退化成恒真断言（本仓既有教训：判定
	// 之前先自问"我的量具在本环境真的咬得到吗"）。这条把"量具坏了"变成 fail-loud。
	if id := env.ids["alice"]; id == 0 {
		t.Fatalf("夹具里 alice 的用户 id 为零值：额度判据会退化成恒真（UploadState(0, …) 恒 0）")
	}

	writeBody := func(v any) string {
		t.Helper()
		raw, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("序列化请求体失败: %v", err)
		}
		return string(raw)
	}

	// quotaState 取"该用户当前的上传额度状态"：`used` = 小时窗口内的 `AllowUpload` 计数，
	// `inflight` = "同时 1 次编译中"的并发占位。
	//
	// 判据只用 `env.compiler` 这一份**可观测计数**（既有姿势先例：
	// `TestUploadCompleteStillUsesUploadRateGate` 用它断言"分片 PUT 不计数"），不拿
	// "函数被调用了 / 没被调用"这类白盒代理量当判据。`AllowUpload` 成功即 `used+1` 且
	// **永不回退**（`ReleaseUpload` 只退并发位，见 compile/compiler.go）⇒ "请求前后 `used`
	// 不变"等价于"这一跳没有消耗小时额度"。
	quotaState := func(t *testing.T) (used, inflight int) {
		t.Helper()
		return env.compiler.UploadState(env.ids["alice"], time.Now())
	}

	// run 发一次"声明预算不足 + 慢请求体"的请求，三条入口共用同一份判据。
	run := func(t *testing.T, path, token, body string) {
		t.Helper()
		slow := newSignallingSlowReader(readDelay)
		req := httptest.NewRequest(http.MethodPost, path,
			io.MultiReader(slow, strings.NewReader(body)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set(ClientBudgetHeader, declaredBudget)
		w := httptest.NewRecorder()
		// 额度在**请求之前**与**请求之后**各取一次（同一条入口的同一个请求，中间不夹别的调用）。
		usedBefore, inflightBefore := quotaState(t)
		start := time.Now()
		env.r.ServeHTTP(w, req)
		elapsed := time.Since(start)
		usedAfter, inflightAfter := quotaState(t)

		// ① 结构化预算结论（信封与既有判据逐字同形）。
		if w.Code != http.StatusGatewayTimeout {
			t.Fatalf("status = %d（%s），want 504 结构化预算结论"+
				"（非 504 说明这次失败不是「客户端声明预算不足」这条路径给出的结论）",
				w.Code, w.Body.String())
		}
		var eb errBody
		if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
			t.Fatalf("响应不是 JSON 错误信封: %v; body=%s", err, w.Body.String())
		}
		if eb.Error.Code != string(apperr.CodeRuntimeTimeout) {
			t.Fatalf("code = %s, want %s; body=%s", eb.Error.Code, apperr.CodeRuntimeTimeout, w.Body.String())
		}
		if eb.Error.Details["phase"] != "publish_budget" {
			t.Fatalf("details.phase = %v, want publish_budget（结论必须说明是预算而不是别的失败）: %s",
				eb.Error.Details["phase"], w.Body.String())
		}
		if got := eb.Error.Details["publish_total_budget_seconds"]; got != float64(0) {
			t.Fatalf("details.publish_total_budget_seconds = %v, want 0（声明的 1 s 不足传输余量）", got)
		}
		if got := eb.Error.Details["client_declared_budget_seconds"]; got != float64(1) {
			t.Fatalf("details.client_declared_budget_seconds = %v, want 1（诊断要能看出预算来自客户端声明）", got)
		}
		if hints := strings.Join(eb.Error.Hints, " "); !strings.Contains(hints, "upload_id") {
			t.Fatalf("hints 必须给出补救路径（带同一个 upload_id 重发）：%v", eb.Error.Hints)
		}

		// ② 结论远早于读体耗时返回（读体 3 s，上界 1 s）。
		//
		// ②③ 用 Errorf 而不是 Fatalf：两条各自独立成立，一次跑里全部报出来
		// （变异体上两条都会红 —— 读体既被读了、结论又晚到 3 s）。
		if elapsed >= refusalUpperBound {
			t.Errorf("结论耗时 %s ≥ %s（读体需要 %s）：拒绝发生在读请求体之后"+
				"—— 客户端已经等不到任何结论，这一跳的额度与最多 48 MiB 请求体却已经被消耗",
				elapsed, refusalUpperBound, readDelay)
		}

		// ③ 结构性：请求体一个字节都没被读过（闸门在读体**之前**）。
		//
		// 这条不依赖墙钟：`signallingSlowReader` 在第一次 `Read` 时关闭 `started`，
		// 而"读请求体"在生产链路里只有 `bindJSONLimited` 一处会触发它。
		select {
		case <-slow.started:
			t.Errorf("请求体在结论之前被读了：拒绝闸门排在了读请求体之后（位置纪律破坏）")
		default:
		}

		// ④ 拒绝**不得**烧掉一次上传小时额度（`acquireUpload` 必须排在闸门之后）。
		//
		// 与 ②③ 相互独立：M-X5 形态（闸门挪到 `acquireUpload` 之后、读体之前）下请求体
		// 仍未被读、结论仍是毫秒级 504 ⇒ ②③ 全绿，只有这条会红。`inflight` 只进文案
		// 不做断言：两条路径上它都被 `defer ReleaseUpload` 复位，拿它做判据是恒真断言。
		if usedAfter != usedBefore {
			t.Errorf("拒绝吃掉了上传小时额度：used %d → %d（inflight %d → %d）——"+
				"拒绝闸门排在了 `acquireUpload` 之后；该计数按设计**不回退**"+
				"（试错次数本身就是限流对象），只能等一小时窗口滑出",
				usedBefore, usedAfter, inflightBefore, inflightAfter)
		}
	}

	t.Run("publish：声明预算不足 ⇒ 拒绝在读请求体之前", func(t *testing.T) {
		const appID = "refusal-position-publish"
		run(t, "/api/client/v2/apps/wasm/"+appID+"/releases", env.tokens["alice"],
			writeBody(env.payload(appID, "1.0.0", wasm, goodConfig())))
	})

	t.Run("validate：声明预算不足 ⇒ 拒绝在读请求体之前", func(t *testing.T) {
		const appID = "refusal-position-validate"
		run(t, "/api/client/v2/apps/wasm/validate", env.tokens["alice"],
			writeBody(env.payload(appID, "1.0.0", wasm, goodConfig())))
	})

	t.Run("uploadComplete：声明预算不足 ⇒ 拒绝在读请求体之前", func(t *testing.T) {
		const appID = "refusal-position-complete"
		// 会话必须**真的可用**（3 片全部到位）：否则一旦拒绝闸门被挪到读体之后，
		// 请求会先变成"会话不存在"的 404 —— 红的原因就不是位置纪律了。
		chunk, parts := planThree(t, wasm)
		sess := env.createUpload(env.tokens["alice"], appID, "1.0.0", int64(len(wasm)), chunk)
		for i, part := range parts {
			env.putChunk(env.tokens["alice"], sess.UploadID, i, part)
		}
		run(t, completePath(sess.UploadID), env.tokens["alice"],
			writeBody(completeBody("预算法位置", goodConfig())))
	})
}
