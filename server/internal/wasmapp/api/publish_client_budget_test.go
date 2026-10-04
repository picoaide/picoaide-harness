package api

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是审计 FW-2 的回归护栏：**客户端声明的剩余预算必须把平台侧在这一跳的预算钳小**。
//
// 缺陷形态（修前）：客户端的分片链把 `CLIENT_UPLOAD_TIMEOUT_MS`（90 s）当作**整条链**的
// 预算（`CHUNKED_PUBLISH_BUDGET_MS`），开会话 / N 片 PUT / 续传刷新 / complete 每一跳只用
// "剩余额度"；而平台侧为 `complete` 这一跳**新开**一份 `PublishTotalBudget`（75 s）。
// 上传阶段一旦花掉 >15 s（17 MiB 二进制在 5 Mbps 上行 ≈37 s），客户端在这一跳只剩
// `90 s − 已用 < 75 s` ⇒ **平台允许的结论时刻落在客户端放弃之后**：员工/AI 拿到笼统的
// 网关错误，而平台正准备返回带 `code`/`hints` 的结构化错误 —— 正是 S4-06/CTRL-01 要消灭
// 的形态，只是搬到了分片路径。
//
// 修法 = 跨端传递剩余预算：客户端在 complete 上带 `ClientBudgetHeader`（值 = 本跳真正会等
// 的毫秒数），平台取 `min(PublishTotalBudget, max(0, 声明 − PublishTransferReserve))`，
// **永不放大**；缺省/非法/越界一律回落 `PublishTotalBudget`。
//
// 四条判据（每条都能被打坏，变异验证见交付报告）：
//
//	① TestParseClientBudgetHint —— 头的三态严格校验（缺省/非法/越界 ⇒ 没有可用声明）；
//	② TestClientDeclaredBudgetClampsServerBudget —— **序关系**：对客户端可能声明的每一个
//	   值，平台侧在这一跳的预算都**严格小于**它，且永不超过 PublishTotalBudget；
//	③ TestPublishBudgetForReadsRequestHeader —— **接线**：请求头真的进了预算计划（幂等）；
//	④ TestUploadCompleteHonorsClientDeclaredBudget —— **端到端**（真 PG + 真编译器 + 生产
//	   路由树）：声明 1 s ⇒ complete 回结构化结论而不是让客户端先超时；分片不丢，
//	   用同一个 upload_id 重发（新的一次调用有完整预算）即成功。

// TestParseClientBudgetHint 是头的**三态校验**判据（缺省 / 非法 / 越界 ⇒ 没有可用声明）。
func TestParseClientBudgetHint(t *testing.T) {
	maxMs := int64(limits.ClientUploadTimeout / time.Millisecond)
	cases := []struct {
		raw  string
		want time.Duration
		ok   bool
	}{
		{"", 0, false},
		{"   ", 0, false},
		{"abc", 0, false},
		{"5.5", 0, false},
		{"+5000", 0, false}, // 只接受 String(ms) 的规范形态
		{"-5000", 0, false}, // 负数
		{"0", 0, false},     // 0 = "已经不等了"
		{"1e3", 0, false},   // 科学计数
		{"0x10", 0, false},  // 十六进制
		{"5000 ", 5000 * time.Millisecond, true},
		{"90000", 90 * time.Second, true},  // = 客户端出站预算本身（上界，闭区间）
		{"90001", 0, false},                // 越界 ⇒ 回落（不是"钳到 90 s"）
		{"99999999999999999999", 0, false}, // int64 溢出
	}
	if int64((90*time.Second)/time.Millisecond) != maxMs {
		t.Fatalf("上界口径变了：%d != %d（改 ClientUploadTimeout 要同步本用例）", maxMs, 90000)
	}
	for _, tc := range cases {
		got, ok := parseClientBudgetHint(tc.raw)
		if ok != tc.ok || got != tc.want {
			t.Errorf("parseClientBudgetHint(%q) = (%s, %v), want (%s, %v)", tc.raw, got, ok, tc.want, tc.ok)
		}
	}
}

// TestClientDeclaredBudgetClampsServerBudget 是**序关系**判据（FW-2 的核心）。
//
// 断言（对客户端可能声明的每一个毫秒值）：
//
//	① 平台侧在这一跳的预算 **严格小于** 客户端声明的剩余额度
//	   —— 否则平台会把结论给在客户端放弃之后（修前形态：75 s > 55 s）；
//	② 且永不超过 PublishTotalBudget（**不得放大**：客户端声明再大也只能拿到默认总预算）；
//	③ deadline 与 total 一致（总预算换了，绝对截止时刻必须跟着换，不能只改文案）。
//
// 取值域 = `1ms .. ClientUploadTimeout`（parseClientBudgetHint 能返回的全部值），步长 1 ms
// 里的关键点 + 1 s 全程扫描：既覆盖"声明还很大"（不缩小），也覆盖"声明连传输余量都不够"
// （有效预算 0 ⇒ 入口拒绝）。
func TestClientDeclaredBudgetClampsServerBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)
	frozen := time.Now()
	h := NewHandlers(Options{Now: func() time.Time { return frozen }})

	// 精确表：三段的边界各自钉住一个值（真源 = limits 的两个常量，不写死 75/15）。
	reserve := limits.PublishTransferReserve
	maxDeclared := limits.ClientUploadTimeout
	table := []struct {
		declared time.Duration
		want     time.Duration
	}{
		{maxDeclared, limits.PublishTotalBudget},                                                               // 满额声明 ⇒ 不缩小
		{limits.PublishTotalBudget + reserve, limits.PublishTotalBudget},                                       // 恰好等于"总预算 + 余量"
		{limits.PublishTotalBudget + reserve - time.Millisecond, limits.PublishTotalBudget - time.Millisecond}, // 缩 1 ms
		{limits.PublishTotalBudget, limits.PublishTotalBudget - reserve},                                       // 声明 = 总预算 ⇒ 再减余量
		{reserve, 0},                    // 声明 = 余量 ⇒ 有效 0
		{reserve - time.Millisecond, 0}, // 不足余量 ⇒ 有效 0（不是负数）
		{time.Millisecond, 0},
	}
	for _, tc := range table {
		_, pb, cancel := h.publishBudgetCtx(context.Background(), tc.declared)
		cancel()
		if pb.total != tc.want {
			t.Errorf("声明 %s ⇒ 平台侧预算 %s, want %s", tc.declared, pb.total, tc.want)
		}
	}

	// 全程扫描（1 s 步长）：序关系与"不得放大"两条不变量。
	for declared := time.Second; declared <= maxDeclared; declared += time.Second {
		ctx, pb, cancel := h.publishBudgetCtx(context.Background(), declared)
		deadline, ok := ctx.Deadline()
		cancel()
		if !ok {
			t.Fatalf("声明 %s：预算 ctx 必须带 deadline", declared)
		}
		if pb.total > limits.PublishTotalBudget {
			t.Fatalf("声明 %s：平台侧预算 %s **被放大**到超过 PublishTotalBudget %s（客户端不得放大预算）",
				declared, pb.total, limits.PublishTotalBudget)
		}
		if pb.total >= declared {
			t.Fatalf("声明 %s：平台侧预算 %s **不严格小于**客户端在本跳的剩余额度 ⇒ "+
				"平台允许的结论时刻落在客户端放弃之后（FW-2 的缺陷形态）", declared, pb.total)
		}
		if want := frozen.Add(pb.total); !deadline.Equal(want) {
			t.Fatalf("声明 %s：deadline = %s, want %s（总预算改了，截止时刻必须跟着改）",
				declared, deadline, want)
		}
	}
}

// TestPublishBudgetForReadsRequestHeader 是**接线**判据：请求头 → 预算计划 → 拒绝闸门。
func TestPublishBudgetForReadsRequestHeader(t *testing.T) {
	gin.SetMode(gin.TestMode)
	frozen := time.Now()
	h := NewHandlers(Options{Now: func() time.Time { return frozen }})

	plan := func(header string, set bool) publishBudget {
		t.Helper()
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/uploads/x/complete", nil)
		if set {
			c.Request.Header.Set(ClientBudgetHeader, header)
		}
		_, pb, cancel := h.publishBudgetFor(c)
		cancel()
		return pb
	}

	// 缺头 / 非法 / 越界 ⇒ 平台默认总预算（老客户端与第三方客户端行为不变）。
	for _, raw := range []string{"", "abc", "0", "-1", "90001", "99999999999999999999"} {
		if pb := plan(raw, true); pb.total != limits.PublishTotalBudget || pb.declared != 0 {
			t.Errorf("头 %q ⇒ (total=%s, declared=%s), want (%s, 0)",
				raw, pb.total, pb.declared, limits.PublishTotalBudget)
		}
	}
	if pb := plan("", false); pb.total != limits.PublishTotalBudget {
		t.Fatalf("没有头 ⇒ total = %s, want %s", pb.total, limits.PublishTotalBudget)
	}

	// 合法声明 ⇒ 钳小，且拒绝闸门按"有效预算是否为 0"分流。
	clamped := plan("20000", true)
	if clamped.declared != 20*time.Second || clamped.total != 20*time.Second-limits.PublishTransferReserve {
		t.Fatalf("声明 20 s ⇒ (total=%s, declared=%s), want (%s, 20s)",
			clamped.total, clamped.declared, 20*time.Second-limits.PublishTransferReserve)
	}
	if err := h.publishBudgetRefusal(clamped); err != nil {
		t.Fatalf("声明 20 s 还剩 %s 有效预算，不该在入口拒绝：%s", clamped.total, err.Message)
	}
	starved := plan("1000", true)
	if err := h.publishBudgetRefusal(starved); err == nil {
		t.Fatal("声明 1 s（不足传输余量）必须在入口拒绝：否则会白烧一次编译，而客户端早已放弃")
	} else {
		if err.Code != apperr.CodeRuntimeTimeout || err.Details["phase"] != "publish_budget" {
			t.Fatalf("入口拒绝的信封不对：code=%s details=%v", err.Code, err.Details)
		}
		if hints := strings.Join(err.Hints, " "); !strings.Contains(hints, "upload_id") {
			t.Fatalf("入口拒绝必须给出可执行的补救（带同一个 upload_id 重发）：%v", err.Hints)
		}
	}
	if err := h.publishBudgetRefusal(plan("90000", true)); err != nil {
		t.Fatalf("满额声明不该被拒绝：%s", err.Message)
	}
}

// completeWithBudget 发一次带 `ClientBudgetHeader` 的 complete（空串 = 不带这个头）。
//
// `readDelay > 0` 时请求体在 `readDelay` 之后才到达（`slowStartReader`）——"入口拒绝必须发生在
// **读请求体之前**"这条位置判据就靠它：被拒时 reader 根本不会被读，所以用例**不需要**等这段
// 时间；一旦拒绝被挪到读体之后（或整段被删掉），耗时立刻多出 readDelay。
func (e *testEnv) completeWithBudget(t *testing.T, token, id, budget string, body any, readDelay time.Duration) *httptest.ResponseRecorder {
	t.Helper()
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("序列化 complete 请求体失败: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, completePath(id), bytes.NewReader(raw))
	if readDelay > 0 {
		req = httptest.NewRequest(http.MethodPost, completePath(id),
			io.MultiReader(&slowStartReader{d: readDelay}, bytes.NewReader(raw)))
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	if budget != "" {
		req.Header.Set(ClientBudgetHeader, budget)
	}
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}

// TestUploadCompleteHonorsClientDeclaredBudget 是**端到端**判据（真 PG + 真编译器 + 生产
// 路由树）：分片链最后一跳声明的剩余额度真的改变了平台侧的行为。
//
// 形态：3 片全部上传完成（会话可用），客户端在 complete 上声明"这一跳只剩 1 s"
// （等价于上传阶段用掉了 89 s，即弱网下的真实量级）⇒ 平台侧有效预算 = 0：
//
//	① 回**结构化**结论（504 RUNTIME_TIMEOUT + phase=publish_budget + 声明额度明细 +
//	   "带同一个 upload_id 重发"的 hints），而不是让客户端先超时；
//	② 拒绝发生在任何实际工作之前：不占 complete 租约、不烧上传额度、分片不丢；
//	③ 用同一个 upload_id 重发（新的一次调用有完整预算）⇒ 201 成功（恢复路径可达）。
//
// 反面（同一条用例的后半段）：满额声明（90000）不改变任何行为 ⇒ 仍然 201。
func TestUploadCompleteHonorsClientDeclaredBudget(t *testing.T) {
	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()

	sess := env.createUpload(env.tokens["alice"], "budget-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(env.tokens["alice"], sess.UploadID, i, part)
	}

	// ① 声明 1 s ⇒ 有效预算 0 ⇒ 结构化结论；请求体**故意慢 3 s**：
	//    拒绝必须发生在读体之前（被拒时 reader 一个字都不会被读 ⇒ 耗时 ≪ 3 s）；
	//    若拒绝被挪到读体之后（或整段被删），耗时立刻多出 3 s。
	const readDelay = 3 * time.Second
	start := time.Now()
	w := env.completeWithBudget(t, env.tokens["alice"], sess.UploadID, "1000", completeBody("预算应用", cfg), readDelay)
	elapsed := time.Since(start)
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("声明 1 s 的 complete = %d %s, want 504（结构化结论）", w.Code, w.Body.String())
	}
	if elapsed >= readDelay {
		t.Fatalf("入口拒绝耗时 %s ≥ 请求体延迟 %s：拒绝发生在读请求体之后（客户端只剩 1 s，等不起）",
			elapsed, readDelay)
	}
	var refusal struct {
		Error struct {
			Code    string         `json:"code"`
			Details map[string]any `json:"details"`
			Hints   []string       `json:"hints"`
		} `json:"error"`
	}
	env.decodeJSON(w, http.StatusGatewayTimeout, &refusal)
	if refusal.Error.Code != string(apperr.CodeRuntimeTimeout) {
		t.Fatalf("code = %s, want %s", refusal.Error.Code, apperr.CodeRuntimeTimeout)
	}
	if refusal.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("details.phase = %v, want publish_budget（结论必须说明是预算而不是别的失败）",
			refusal.Error.Details["phase"])
	}
	if got := refusal.Error.Details["publish_total_budget_seconds"]; got != float64(0) {
		t.Fatalf("details.publish_total_budget_seconds = %v, want 0（客户端声明的 1 s 不足传输余量）", got)
	}
	if got := refusal.Error.Details["client_declared_budget_seconds"]; got != float64(1) {
		t.Fatalf("details.client_declared_budget_seconds = %v, want 1（诊断要能看出预算来自客户端声明）", got)
	}
	if hints := strings.Join(refusal.Error.Hints, " "); !strings.Contains(hints, "upload_id") {
		t.Fatalf("hints 必须给出补救路径（带同一个 upload_id 重发）：%v", refusal.Error.Hints)
	}

	// ② 拒绝在任何实际工作之前：分片仍在（状态查询还是 3/3）。
	st := env.status(env.tokens["alice"], sess.UploadID)
	if len(st.Received) != 3 || st.ReceivedBytes != int64(len(wasm)) {
		t.Fatalf("拒绝不该丢分片：received=%v bytes=%d, want 3 片 / %d 字节",
			st.Received, st.ReceivedBytes, len(wasm))
	}

	// ③ 用同一个 upload_id 重发（声明满额）⇒ 成功（恢复路径可达，不是死路）。
	w = env.completeWithBudget(t, env.tokens["alice"], sess.UploadID, "90000", completeBody("预算应用", cfg), 0)
	if w.Code != http.StatusCreated {
		t.Fatalf("重发应该成功（续传只补缺失片 + 完整预算）：%d %s", w.Code, w.Body.String())
	}
}
