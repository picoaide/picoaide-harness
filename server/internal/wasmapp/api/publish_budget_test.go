package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/compile/testdata/wasmtest"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 本文件是审计 S4-06 / CTRL-01 的回归护栏：**发布链路只有一个总预算**。
//
// 缺陷形态（修前）：publish/validate 在**同一个 HTTP 请求**里顺序做「编译（B）→ 抽取（C）→
// 干跑（D）」，而 B 与 D 各自从 request ctx 派生预算
// （`budgetCtx(c.Request.Context(), CompileTimeout)` 各一次）⇒ 平台侧"最晚给结论"的时刻
// = 两段上限之和（默认 60 + 60 = 120 s；只算内层 guest 也是 60 + 30 = 90 s），
// 而客户端对这条请求的出站预算是 90 s（`limits.ClientUploadTimeout`）⇒ 员工/AI 先拿到笼统的
// 网络错误，平台其实正准备返回带 `code`/`hints` 的结构化错误。
//
// 两条判据（一条机制、一条接线）：
//
//	① TestPublishStagesNeverOutliveTotalBudget —— 两个阶段派生出的 ctx 都不越过总 deadline，
//	   而阶段自己的上限仍然生效（min 语义）；
//	② TestPublishDryRunIsCutByTotalBudget —— 真的跑一次 `prepare`（真编译 + 永不返回的
//	   `_start`），断言失败结论是"平台侧总预算用尽"且发生在总预算之内。
//
// 变异验证（实跑记录见交付报告）：
//   - 把 `prepare` 的两段改回 `budgetCtx(c.Request.Context(), …)`（= 修前形态）
//     ⇒ ② 的两条断言同时红（阶段 D 拿到全新的外层预算，只有 guest 预算能结束它）；
//   - 把 `publishBudgetCtx` 的 `context.WithDeadline` 换成 `context.WithCancel`
//     ⇒ ① 红（总预算 ctx 没有 deadline）。

// TestPublishStagesNeverOutliveTotalBudget 是**机制**判据：总 deadline 是阶段预算的上界，
// 阶段自己的上限仍然生效（两者取较早者 = min 语义）。
//
// 关键场景 = 生产里真实发生的那一种：**前一阶段已经吃掉了大部分总预算**，后一阶段拿到的
// 阶段上限（`compile_timeout_seconds`，60 s）远大于总预算剩余 ⇒ 它必须被总 deadline 截住，
// 而不是另起一个 60 s 的钟（那正是 S4-06：两段之和 120 s > 客户端 90 s）。
func TestPublishStagesNeverOutliveTotalBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)

	// 把总预算的有效剩余压到 1.2 s（时钟拨回；总预算 = h.now() + limits.PublishTotalBudget）。
	// 时钟**冻结**在同一个值上 ⇒ deadline 的算术可以逐字比较（不引入"取两次 now"的抖动）。
	// `now` 可推进：幂等那条断言需要"第二次派生的时刻确实前进过"才可证伪（见下）。
	const effective = 1200 * time.Millisecond
	frozen := time.Now()
	offset := limits.PublishTotalBudget - effective
	now := frozen.Add(-offset)
	h := NewHandlers(Options{Now: func() time.Time { return now }})

	shared, pb, cancel := h.publishBudgetCtx(context.Background(), 0)
	defer cancel()

	sharedDeadline, ok := shared.Deadline()
	if !ok {
		t.Fatal("总预算 ctx 必须带 deadline —— 没有它，两个阶段又各自从零起算（S4-06 的缺陷形态）")
	}
	if want := h.now().Add(limits.PublishTotalBudget); !sharedDeadline.Equal(want) {
		t.Fatalf("总 deadline = %s，期望 %s（= 请求到达时刻 + limits.PublishTotalBudget）", sharedDeadline, want)
	}
	if pb.total != limits.PublishTotalBudget {
		t.Fatalf("预算计划里的总预算 = %s，期望 limits.PublishTotalBudget = %s", pb.total, limits.PublishTotalBudget)
	}

	// 幂等：分片 complete 路径会经 publishFromBytes 再进一次 prepare，**再次派生必须返回
	// 同一份预算计划**（error details 渲染的就是这份计划；重新计算会给出一个与本次请求
	// 无关的时刻）。
	//
	// ⚠️ N4（S4-06 对抗验证）：这条断言原来只比 ctx 的 deadline，而 `context.WithDeadline`
	// 取"父 deadline 与 now+d 中较早者" ⇒ 二次派生**结构上**不会推后 ctx 的 deadline，
	// 删掉幂等短路也照样绿（验证方 M7 实测全绿）。判据改成比**计划本身**，并用**推进
	// 30 s 的时钟**造出可区分性：删掉短路后重新计算会得到 `now2 + 总预算`（= 首次 + 30 s）。
	now = now.Add(30 * time.Second)
	again, pbAgain, cancelAgain := h.publishBudgetCtx(shared, 0)
	defer cancelAgain()
	againDeadline, _ := again.Deadline()
	if !pbAgain.deadline.Equal(pb.deadline) || pbAgain.total != pb.total {
		t.Fatalf("publishBudgetCtx 不幂等：再次派生换了预算计划（deadline %s → %s，total %s → %s）—— "+
			"分片 complete 经 publishFromBytes 再进 prepare 时会渲染出一份与本次请求无关的预算",
			pb.deadline, pbAgain.deadline, pb.total, pbAgain.total)
	}
	// ctx 的 deadline 不变是**结构性**结果（父 ctx 更早），不足以证明幂等 —— 保留它是为了
	// 钉住"阶段都从这一份派生"。
	if !againDeadline.Equal(sharedDeadline) {
		t.Fatalf("再次派生的 ctx deadline = %s ≠ %s", againDeadline, sharedDeadline)
	}

	// ① 阶段上限（60 s）≫ 总预算剩余（1.2 s）⇒ 阶段 deadline 必须仍是**总 deadline**。
	stage, cancelStage := budgetCtx(shared, limits.CompileTimeout)
	defer cancelStage()
	stageDeadline, _ := stage.Deadline()
	if !stageDeadline.Equal(sharedDeadline) {
		t.Fatalf("阶段 deadline = %s ≠ 总 deadline %s：阶段预算又各自从零起算了"+
			"（阶段上限 %s ≫ 总预算剩余 %s ⇒ 两段之和会越过总预算）",
			stageDeadline, sharedDeadline, limits.CompileTimeout, effective)
	}

	// ② 反向：阶段上限更短时必须仍然以阶段上限为准（阶段自己的闸门不能被总预算顶掉，
	//    否则控制台配的 compile_timeout_seconds / dry_run_budget_seconds 会静默失效）。
	tight, cancelTight := budgetCtx(shared, 200*time.Millisecond)
	defer cancelTight()
	tightDeadline, _ := tight.Deadline()
	if !tightDeadline.Before(sharedDeadline) {
		t.Fatalf("阶段上限 200 ms 没有生效：阶段 deadline = %s，总 deadline = %s", tightDeadline, sharedDeadline)
	}
	if remaining := time.Until(tightDeadline); remaining > 200*time.Millisecond {
		t.Fatalf("阶段上限 200 ms 没有生效：剩余 %s", remaining)
	}
}

// spinningModule 是"能编译、能实例化，但 `_start` 永不返回"的模块（干跑只可能被预算结束）。
//
// 形态与 wasmtest.Base() 同构（同两条 WASI 导入 + memory/_start 导出），只是 `_start` 体
// 换成一个紧循环：
//
//	loop        ; 0x03 0x40
//	  br 0      ; 0x0c 0x00
//	end         ; 0x0b
//	end         ; 0x0b（函数体结束）
//
// 紧循环正是 wazero `WithCloseOnContextDone` 的终止检查点（runtime/clock.go 记的实测形态）。
func spinningModule() []byte {
	return wasmtest.Build(
		wasmtest.TypeSection(
			// 0：fd_read / fd_write 的签名（WASI 白名单要求逐字一致）
			wasmtest.TypeFunc(wasmtest.Params(wasmtest.I32, wasmtest.I32, wasmtest.I32, wasmtest.I32), wasmtest.Params(wasmtest.I32)),
			// 1：_start 的签名
			wasmtest.TypeFunc(wasmtest.Params(), wasmtest.Params()),
		),
		wasmtest.ImportSection(
			wasmtest.ImportFunc("wasi_snapshot_preview1", "fd_read", 0),
			wasmtest.ImportFunc("wasi_snapshot_preview1", "fd_write", 0),
		),
		wasmtest.FunctionSection(1),
		wasmtest.MemorySection(1),
		// 函数索引空间 = 2 个导入 + _start(idx 2)
		wasmtest.ExportSection(wasmtest.ExportMemory("memory", 0), wasmtest.ExportFunc("_start", 2)),
		wasmtest.CodeSection(wasmtest.Body(0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b)),
	)
}

// TestPublishDryRunIsCutByTotalBudget 是**接线**判据（行为级）：两段真的共用一个总 deadline。
//
// 做法：把注入时钟拨回（总预算 − effective）⇒ 等价于"这次请求已经用掉了大部分总预算"
// （总预算从 `h.now()` 起算，见 publishBudgetCtx）。阶段自己的 guest 预算是 10 s，远大于
// effective ⇒ 只有总 deadline 能结束这次干跑。
func TestPublishDryRunIsCutByTotalBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)

	cacheRoot := sharedCacheRoot(t)
	comp, err := compile.New(compile.Options{
		DataRoot:    cacheRoot,
		ChildBinary: testCompileChild(t),
		// 与 helpers_test.go 同口径：本用例测的是发布链路，OS 级隔离由 compile 包自己负责。
		Isolation: compile.IsolationOff,
		Logger:    testLogger{t},
	})
	if err != nil {
		t.Fatalf("构造编译器失败: %v", err)
	}
	t.Cleanup(func() { _ = comp.Close() })

	const effective = 4 * time.Second
	const guest = 10 * time.Second
	offset := limits.PublishTotalBudget - effective

	lim := applimits.Defaults()
	lim.GuestBudgetSeconds = int(guest / time.Second)
	lim.DryRunBudgetSeconds = int(guest / time.Second)

	h := NewHandlers(Options{
		DataRoot:         t.TempDir(),
		CompileCacheRoot: cacheRoot,
		Compiler:         comp,
		Limits:           func() applimits.Limits { return lim },
		// 唯一"缩短总预算"的手段：总预算 = h.now() + limits.PublishTotalBudget。
		Now: func() time.Time { return time.Now().Add(-offset) },
	})

	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/api/client/v2/apps/wasm/validate", nil)
	// 模拟真实请求入口：publish / validate 在**读请求体之前**挂总预算，publishFromBytes
	// 兜底（幂等）；prepare 只取用、缺失即 fail-loud。
	entryCtx, _, cancelEntry := h.publishBudgetCtx(c.Request.Context(), 0)
	defer cancelEntry()
	c.Request = c.Request.WithContext(entryCtx)

	start := time.Now()
	_, perr := h.prepare(c, "budgetprobe", spinningModule(), nil, "1.0.0", false, false, "")
	elapsed := time.Since(start)

	if perr == nil {
		t.Fatalf("`_start` 永不返回，prepare 必须在总预算（%s）内给出失败结论", effective)
	}
	if got := perr.Details["phase"]; got != "publish_budget" {
		t.Fatalf("失败结论不是「平台侧总预算用尽」：code=%s phase=%v message=%s（details=%v）\n"+
			"  这说明阶段 D 又拿到了一个全新的预算（修前形态：外层 = CompileTimeout，guest = %s）",
			perr.Code, got, perr.Message, perr.Details, guest)
	}
	if got := perr.Details["publish_total_budget_seconds"]; got != int(limits.PublishTotalBudget/time.Second) {
		t.Fatalf("details.publish_total_budget_seconds = %v，期望 %d（必须来自 limits 真源，不写死）",
			got, int(limits.PublishTotalBudget/time.Second))
	}
	if perr.Code != apperr.CodeCompileTimeout && perr.Code != apperr.CodeRuntimeTimeout {
		t.Fatalf("总预算用尽必须落在超时类错误码（编译/干跑各自的超时码），得到 %s", perr.Code)
	}
	// 余量 2 s：允许真实编译（子进程 spawn + wazero 编译，通常 ≪1 s）与收尾（postKillGrace 250 ms）。
	if elapsed > effective+2*time.Second {
		t.Fatalf("结论耗时 %s 超过了总预算 %s（+2 s 余量）：阶段 D 显然在按自己的 guest 预算（%s）跑，"+
			"总 deadline 没有接上", elapsed, effective, guest)
	}
}

// ---------------------------------------------------------------------------
// N1–N3（S4-06 对抗验证的续集，2026-10-04）
// ---------------------------------------------------------------------------
//
//   - **N1**：总预算在**阶段之外**（前置读 / 落库）到点时，失败必须仍是"平台侧总预算用尽"
//     这条结构化结论，而不是 `500 INTERNAL「查询失败/版本保存失败」`；
//   - **N2**：总 deadline 的**位置纪律**（必须挂在读请求体之前）要有判据；
//   - **N3**：**三条入口各自**真的挂了总预算，要有行为判据。
//
// 缺陷形态（验证方 §4 的变异实证）：原判据只驱动 `publishBudgetCtx` 本身（G1）或自己挂
// 载体（G2），**没有任何一条请求从生产入口走进来**
//   - M2（把 `validate` 的挂载挪到读请求体之后）⇒ 全套判据全绿。真实后果：平台侧最坏
//     = 读体（`ReadTimeout` 上限 60 s）+ 总预算 75 s = 135 s ≫ 客户端 90 s，而读体本身
//     在超预算时**不会**被 ctx 打断 ⇒ 它只能靠"读体吃掉预算"来兜（本文件第 ② 条用例）；
//   - M4b（三个入口都不挂 + 删掉 `prepare` 的 fail-loud = 完整回到修前形态）⇒ 全绿。

// slowStartReader 是一个"第一次 Read 先睡 d 秒再无内容"的 reader。
//
// 与 `strings.NewReader` 串成 `io.MultiReader` 后，请求体在 d 秒之后才真正开始到达 ——
// 用来把"读请求体"这一段做成可测量的墙钟（§2.2 实测：读体 3.22 s ⇒ 剩余 71.78 s）。
type slowStartReader struct {
	d    time.Duration
	once bool
}

func (s *slowStartReader) Read([]byte) (int, error) {
	if !s.once {
		s.once = true
		time.Sleep(s.d)
	}
	return 0, io.EOF
}

// signallingSlowReader 是 slowStartReader 的**可观测**版本：第一次 Read 先睡 d 秒，并在
// "开始睡"（= 调用方已经走到读请求体这一步）与"睡完"（= 读体即将交回调用方）两个时刻各关
// 一个 channel。
//
// 用途见 TestUploadCompleteBudgetCoversLeaseWait：complete 的**会话租约**
// （`BeginComplete`）排在读体之前，所以"开始读体"这一刻就是"已经持有租约"的可观测凭据 ——
// 用它代替 sleep 定长来对齐两个并发 complete 的时序。
type signallingSlowReader struct {
	d        time.Duration
	started  chan struct{}
	finished chan struct{}
	once     bool
}

func newSignallingSlowReader(d time.Duration) *signallingSlowReader {
	return &signallingSlowReader{d: d, started: make(chan struct{}), finished: make(chan struct{})}
}

func (s *signallingSlowReader) Read([]byte) (int, error) {
	if !s.once {
		s.once = true
		close(s.started)
		time.Sleep(s.d)
		close(s.finished)
	}
	return 0, io.EOF
}

// TestRealEntriesHonorTotalBudget 同时闭合 N3（入口接线）与 N2（位置纪律）。
//
// 三条入口各驱动一次**真实 HTTP 请求**（生产路由树 + 真实 PG + 真编译器），注入时钟把总
// 预算压到 `effective`：
//
//	① `validate`：请求体**慢 3 s** ⇒ 判据是"读体吃掉预算"：总耗时 ≈ 读体耗时（而不是
//	   "读体 + 一整个总预算"）。挂载点若被挪到读体之后（M2），这里会多出一整个 effective；
//	② `publish`（base64 直传）：`_start` 永不返回的模块 ⇒ 只有总预算能结束它（挂载被删 ⇒
//	   退回 guest 预算 10 s，耗时立刻超标）；
//	③ `complete`（分片最后一跳）：同样永不返回的模块，1 片 + complete —— 覆盖第三条入口。
//
// ⚠️ 只驱动"瞬时请求体"是**不够**的（P2-1 的判据缺口）：瞬时体把挂载点挪到读体之后
// 耗时不变 ⇒ 全绿。所以 `publish` 与 `complete` 各自**再补一条慢请求体子用例**
// （④⑥，与 ① 同形）：读体 3 s、总预算 2 s ⇒ 基线的结论落在读体结束处（≈3 s），
// 挂载点被挪到读体之后的变异体要多跑一整个 effective（≈5 s）。
//
// 三条都断言 504 + `RUNTIME_TIMEOUT` + `details.phase=publish_budget`（结构化），
// 且总耗时落在预算附近（上界给足余量以免在负载高的机器上假红）。
//
// 入口内部**更晚**的位置（`complete` 的"租约之后、读体之前"）由
// TestUploadCompleteBudgetCoversLeaseWait 单独覆盖 —— 那个形态读体仍在预算内，
// 走出预算的是在会话租约上排队的时间。
func TestRealEntriesHonorTotalBudget(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const effective = 2 * time.Second
	const readDelay = 3 * time.Second
	offset := limits.PublishTotalBudget - effective
	env := newUploadEnv(t, func(o *Options) {
		o.Now = func() time.Time { return time.Now().UTC().Add(-offset) }
	})
	spin := spinningModule()

	assertBudgetOutcome := func(t *testing.T, w *httptest.ResponseRecorder, elapsed time.Duration, lo, hi time.Duration) {
		t.Helper()
		if w.Code != http.StatusGatewayTimeout {
			t.Fatalf("状态 = %d（%s），期望 504 结构化结论", w.Code, w.Body.String())
		}
		eb := env.decodeErr(w, http.StatusGatewayTimeout)
		if eb.Error.Code != string(apperr.CodeRuntimeTimeout) {
			t.Fatalf("code = %s, want %s", eb.Error.Code, apperr.CodeRuntimeTimeout)
		}
		if eb.Error.Details["phase"] != "publish_budget" {
			t.Fatalf("details.phase = %v, want publish_budget（平台侧总预算用尽，而不是别的失败：%s）",
				eb.Error.Details["phase"], w.Body.String())
		}
		if elapsed < lo || elapsed > hi {
			t.Fatalf("耗时 %s 不在 [%s, %s]：总 deadline 没有罩住这一段（挂载位置/接线有问题）",
				elapsed, lo, hi)
		}
	}

	t.Run("validate：读请求体吃掉总预算（位置纪律 N2）", func(t *testing.T) {
		payload := `{"app_id":"budget-slow","version":"1.0.0","wasm_base64":"` + b64(spin) + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/validate",
			io.MultiReader(&slowStartReader{d: readDelay}, strings.NewReader(payload)))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+env.tokens["alice"])
		w := httptest.NewRecorder()
		start := time.Now()
		env.r.ServeHTTP(w, req)
		elapsed := time.Since(start)
		// 上界 = 读体 + 半个预算：M2（挂载挪到读体之后）会让读体之后**再拿到**一整个
		// effective ⇒ 约 5 s，越过这条线。
		assertBudgetOutcome(t, w, elapsed, readDelay-200*time.Millisecond, readDelay+effective/2)
	})

	t.Run("publish 直传：只有总预算能结束永不返回的 _start", func(t *testing.T) {
		start := time.Now()
		w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/budget-spin/releases", env.tokens["alice"],
			env.payload("budget-spin", "1.0.0", spin, goodConfig()))
		elapsed := time.Since(start)
		// 挂载被删（M4b）⇒ 干跑按 guest 预算（10 s）跑 ⇒ 远超上界。
		assertBudgetOutcome(t, w, elapsed, effective-200*time.Millisecond, effective+2*time.Second)
	})

	// ④ publish 的**位置纪律**：请求体慢 3 s（> 总预算 2 s）⇒ 读体自己就把预算吃光。
	//
	// 与 ① 同形，但走的是 `publish` 入口（P2-1 实测的判据缺口：原来只有瞬时体的
	// ②，把挂载点挪到 `bindJSONLimited` 之后仍然是绿的）。基线的结论必须落在读体结束
	// 处（≈3 s）：预算早就在读体期间到点，读体一结束 `loadForPublish` 立刻给出结构化
	// 预算结论；变异体（挂载挪到读体之后）要多跑一整个 effective（≈5 s）⇒ 越过上界。
	t.Run("publish 慢请求体：读体吃掉总预算（位置纪律 N2）", func(t *testing.T) {
		raw, merr := json.Marshal(env.payload("budget-slow-publish", "1.0.0", spin, goodConfig()))
		if merr != nil {
			t.Fatalf("序列化请求体失败: %v", merr)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/client/v2/apps/wasm/budget-slow-publish/releases",
			io.MultiReader(&slowStartReader{d: readDelay}, strings.NewReader(string(raw))))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+env.tokens["alice"])
		w := httptest.NewRecorder()
		start := time.Now()
		env.r.ServeHTTP(w, req)
		elapsed := time.Since(start)
		assertBudgetOutcome(t, w, elapsed, readDelay-200*time.Millisecond, readDelay+effective/2)
	})

	t.Run("complete：分片最后一跳同样受总预算约束", func(t *testing.T) {
		sess := env.createUpload(env.tokens["alice"], "budget-spin2", "1.0.0",
			int64(len(spin)), limits.UploadChunkMinBytes)
		env.putChunk(env.tokens["alice"], sess.UploadID, 0, spin)
		start := time.Now()
		w := env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["alice"],
			completeBody("预算应用", goodConfig()))
		elapsed := time.Since(start)
		assertBudgetOutcome(t, w, elapsed, effective-200*time.Millisecond, effective+2*time.Second)
	})

	// ⑥ complete 的**位置纪律**：与 ④ 同形，覆盖第三条入口（P2-1 同一族）。
	//
	// complete 的请求体排在会话租约/闸门之后，但仍在预算之内 —— 挂载点被挪到读体之后时，
	// 读体 3 s 会整个跑到预算之外，结论落在 ≈5 s 而不是 ≈3 s。
	t.Run("complete 慢请求体：读体吃掉总预算（位置纪律 N2）", func(t *testing.T) {
		sess := env.createUpload(env.tokens["alice"], "budget-slow-complete", "1.0.0",
			int64(len(spin)), limits.UploadChunkMinBytes)
		env.putChunk(env.tokens["alice"], sess.UploadID, 0, spin)
		raw, merr := json.Marshal(completeBody("预算应用", goodConfig()))
		if merr != nil {
			t.Fatalf("序列化请求体失败: %v", merr)
		}
		req := httptest.NewRequest(http.MethodPost, completePath(sess.UploadID),
			io.MultiReader(&slowStartReader{d: readDelay}, strings.NewReader(string(raw))))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+env.tokens["alice"])
		w := httptest.NewRecorder()
		start := time.Now()
		env.r.ServeHTTP(w, req)
		elapsed := time.Since(start)
		assertBudgetOutcome(t, w, elapsed, readDelay-200*time.Millisecond, readDelay+effective/2)
	})
}

// TestUploadCompleteBudgetCoversLeaseWait 闭合 complete 入口**内部更晚**的位置纪律
// （P2-1 的另一半）：总预算必须从"请求进入平台"那一刻起算 —— 包括在会话租约上排队等
// 前一次 complete 的那段时间。
//
// 为什么慢请求体单独不够：complete 的读体排在会话租约（`BeginComplete`）**之后**，把挂载点
// 从"入口"挪到"读体之前"时读体仍在预算内 ⇒ 上一条用例（⑥）照样绿。走出预算的是**租约排队**
// 那一段，所以本用例用两个 complete 把这段等待造出来：
//
//	A：慢请求体（`holdRead` 秒）—— 它在读完之前一直持有会话租约；
//	B：同一会话的第二次 complete（瞬时体）—— 必然排在 A 后面（同会话串行，FIX-45 的租约）。
//
// 判据 = **B 拿到租约之后必须立刻给出结论**（它的总预算早在排队时就到期了）：
//   - 基线：B 在 A 释放租约后几十毫秒内回 504 `phase=publish_budget`；
//   - 变异（挂载挪到租约之后）：B 拿到租约后才开始计时 ⇒ 又跑满一个完整预算
//     （永不返回的 `_start` 只能被预算结束）⇒ 拿到租约后又花掉一整个 effective ⇒ 红。
//
// 前置判据（自校准）：B 必须真的在租约上等过（等待 < holdRead/2 即判夹具几何不成立），
// 否则本用例会退化成"两条互不相干的请求"并静默通过。
func TestUploadCompleteBudgetCoversLeaseWait(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const effective = 2 * time.Second
	const holdRead = effective + 2*time.Second // A 持租约读完体的时长
	// B 拿到租约之后允许花掉的时间：基线实测几十毫秒；变异体是 ≈effective。
	const afterLeaseBudget = 900 * time.Millisecond
	offset := limits.PublishTotalBudget - effective
	env := newUploadEnv(t, func(o *Options) {
		o.Now = func() time.Time { return time.Now().UTC().Add(-offset) }
	})
	spin := spinningModule()
	const appID = "budget-lease-position"
	sess := env.createUpload(env.tokens["alice"], appID, "1.0.0", int64(len(spin)), limits.UploadChunkMinBytes)
	env.putChunk(env.tokens["alice"], sess.UploadID, 0, spin)

	raw, merr := json.Marshal(completeBody("预算应用", goodConfig()))
	if merr != nil {
		t.Fatalf("序列化 complete 请求体失败: %v", merr)
	}
	body := string(raw)
	completeReq := func(r io.Reader) *http.Request {
		req := httptest.NewRequest(http.MethodPost, completePath(sess.UploadID), r)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+env.tokens["alice"])
		return req
	}

	slow := newSignallingSlowReader(holdRead)
	wA := httptest.NewRecorder()
	doneA := make(chan struct{})
	go func() {
		defer close(doneA)
		env.r.ServeHTTP(wA, completeReq(io.MultiReader(slow, strings.NewReader(body))))
	}()

	// "A 开始读体" = A 已经持有会话租约（BeginComplete 在读体之前）⇒ 这一刻起 B 只能排队。
	select {
	case <-slow.started:
	case <-time.After(10 * time.Second):
		t.Fatal("A 未在 10 s 内进入读体：夹具没有走到租约之后，本用例测不到临界区")
	}

	wB := httptest.NewRecorder()
	doneB := make(chan struct{})
	startB := time.Now()
	go func() {
		defer close(doneB)
		env.r.ServeHTTP(wB, completeReq(strings.NewReader(body)))
	}()

	// A 读完体 ⇒ 租约即将释放 ⇒ B 紧接着拿到它。
	select {
	case <-slow.finished:
	case <-time.After(30 * time.Second):
		t.Fatal("A 的慢请求体没有在 30 s 内读完")
	}
	leaseFreed := time.Now()
	<-doneA
	<-doneB
	endB := time.Now()

	// 前置判据（自校准）：B 必须真的在租约上等过 —— 否则本用例测的不是临界区。
	if waited := leaseFreed.Sub(startB); waited < holdRead/2 {
		t.Fatalf("B 只等了 %s 就（疑似）拿到租约（期望 ≥ %s）：两个 complete 没有真的抢占，"+
			"本用例的几何不成立 —— 不要让它静默通过", waited, holdRead/2)
	}
	// 主判据：排队等待吃掉的那部分额度**不能补回来**（预算起算点 = 请求进入平台那一刻）。
	if after := endB.Sub(leaseFreed); after > afterLeaseBudget {
		t.Fatalf("B 拿到租约后又花了 %s（上界 %s）：总预算没有罩住租约排队那一段 —— "+
			"complete 的挂载点被挪到了租约之后（位置纪律是**入口**，不是「读体之前」）",
			after, afterLeaseBudget)
	}
	// A（读体吃掉预算）与 B（排队吃掉预算）都必须是**结构化**预算结论，而不是笼统超时。
	for name, w := range map[string]*httptest.ResponseRecorder{"A（慢请求体）": wA, "B（租约排队）": wB} {
		if w.Code != http.StatusGatewayTimeout {
			t.Fatalf("%s 状态 = %d（%s），期望 504 结构化预算结论", name, w.Code, w.Body.String())
		}
		eb := env.decodeErr(w, http.StatusGatewayTimeout)
		if eb.Error.Code != string(apperr.CodeRuntimeTimeout) || eb.Error.Details["phase"] != "publish_budget" {
			t.Fatalf("%s 的结论不是「平台侧总预算用尽」：code=%s details=%v msg=%s",
				name, eb.Error.Code, eb.Error.Details, eb.Error.Message)
		}
	}
}

// installSlowCommitTrigger 让 `app_releases` 的 INSERT **之前**睡 `sleep`。
//
// 用**序列**记录"触发器确实被走到了"：`nextval` 不受事务回滚影响 ⇒ 即使这次 INSERT 随后
// 被 ctx 取消，标记仍然留下 —— 这是"这条用例确实打在落库窗口"的凭据（否则冷编译恰好超预算
// 时，用例会安静地变成在测编译阶段）。
func installSlowCommitTrigger(t *testing.T, e *testEnv, appID string, sleep time.Duration) {
	t.Helper()
	drop := func() {
		_, _ = e.db.Exec(`DROP TRIGGER IF EXISTS fw2_slow_commit_trg ON app_releases`)
		_, _ = e.db.Exec(`DROP FUNCTION IF EXISTS fw2_slow_commit()`)
		_, _ = e.db.Exec(`DROP SEQUENCE IF EXISTS fw2_commit_reached`)
	}
	drop()
	t.Cleanup(drop)
	if _, err := e.db.Exec(`CREATE SEQUENCE fw2_commit_reached`); err != nil {
		t.Fatalf("建序列: %v", err)
	}
	secs := int(sleep / time.Second)
	if _, err := e.db.Exec(`CREATE OR REPLACE FUNCTION fw2_slow_commit() RETURNS trigger AS $$
		BEGIN
			PERFORM nextval('fw2_commit_reached');
			PERFORM pg_sleep(` + strconv.Itoa(secs) + `);
			RETURN NEW;
		END $$ LANGUAGE plpgsql`); err != nil {
		t.Fatalf("建触发器函数: %v", err)
	}
	if _, err := e.db.Exec(`CREATE TRIGGER fw2_slow_commit_trg BEFORE INSERT ON app_releases
		FOR EACH ROW WHEN (NEW.app_id = '` + appID + `') EXECUTE FUNCTION fw2_slow_commit()`); err != nil {
		t.Fatalf("建触发器: %v", err)
	}
}

// commitMarkerSet 报告落库触发器是否被走到（见 installSlowCommitTrigger）。
func commitMarkerSet(t *testing.T, e *testEnv) bool {
	t.Helper()
	var called bool
	if err := e.db.QueryRow(`SELECT is_called FROM fw2_commit_reached`).Scan(&called); err != nil {
		t.Fatalf("读序列标记失败: %v", err)
	}
	return called
}

// TestPublishBudgetExpiryOutsideStagesIsStructured 闭合 N1：总预算在**阶段之外**到点。
//
// 两个窗口各一条判据：
//   - **落库窗口**（本用例主体，确定性做法）：`app_releases` 的 INSERT 前睡 12 s，注入时钟
//     把总预算压到 5 s ⇒ 预算必在 INSERT 期间到点。判据 = 504 + `phase=publish_budget`
//     （而不是 `500 INTERNAL「版本保存失败」`，那是验证方 `commit-window.log` 里的
//     `slack=900ms` 形态）+ 序列标记证明"确实打在落库"+ 事务回滚（没有版本行）；
//   - **前置读窗口**：见 TestRealEntriesHonorTotalBudget 的 validate 子用例（读体吃掉预算
//     之后，第一条前置读就撞到已到点的 ctx）。
func TestPublishBudgetExpiryOutsideStagesIsStructured(t *testing.T) {
	const budget = 5 * time.Second
	const sleep = 12 * time.Second
	var shift time.Duration // 0 = 真实时钟（暖缓存阶段用）
	env := newTestEnv(t, func(o *Options) {
		o.Now = func() time.Time { return time.Now().UTC().Add(-shift) }
	})
	const appID = "budget-commit-app"
	guest := testGuestModule(t)

	// ① 暖：真实时钟下先成功发一版 —— 判据是"落库窗口"，不能让冷编译把预算吃在编译阶段
	//    （模块 3.6 MiB，冷编译 3–11 s ≫ 本用例的 5 s 预算）。
	env.publishOK(env.tokens["alice"], appID, "1.0.0", guest, goodConfig())

	// ② 让落库变慢（并对"真的走到了落库"留凭据）。
	installSlowCommitTrigger(t, env, appID, sleep)
	shift = limits.PublishTotalBudget - budget

	start := time.Now()
	w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", env.tokens["alice"],
		env.payload(appID, "2.0.0", guest, goodConfig()))
	elapsed := time.Since(start)

	if !commitMarkerSet(t, env) {
		t.Fatal("落库触发器没有被走到：这次失败发生在别的阶段（预算太小/缓存未暖），" +
			"本用例测不到落库窗口 —— 必须调整预算而不是让它静默通过")
	}
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("落库期间预算到点 = %d %s, want 504 结构化结论（N1：不得退化成 500 INTERNAL）",
			w.Code, w.Body.String())
	}
	eb := env.decodeErr(w, http.StatusGatewayTimeout)
	if eb.Error.Code != string(apperr.CodeRuntimeTimeout) || eb.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("落库期间到点必须归一成预算结论：code=%s details=%v msg=%s",
			eb.Error.Code, eb.Error.Details, eb.Error.Message)
	}
	// 触发器睡了 12 s；预算 5 s ⇒ 结论必须远早于睡眠结束（ctx 取消了那条语句）。
	if elapsed >= sleep {
		t.Fatalf("耗时 %s ≥ 触发器睡眠 %s：INSERT 没有被 ctx 取消（预算没接上落库）", elapsed, sleep)
	}
	// 事务回滚：被取消的 INSERT 不得留下版本行。
	var exists bool
	if err := env.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM app_releases WHERE kind = $1 AND app_id = $2 AND version = $3)`,
		serverstore.AppKindWasmApp, appID, "2.0.0").Scan(&exists); err != nil {
		t.Fatalf("查版本行失败: %v", err)
	}
	if exists {
		t.Fatal("落库被取消后仍留下版本行：事务没有回滚")
	}
}
