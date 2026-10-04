package api

import (
	"encoding/json"
	"go/ast"
	"go/token"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
)

// 本文件是审计 FW-D §5 与 FW-E §6.2 登记的**两块地面**的判据（2026-10-04，修复代理 P2，服务端 WASM 发布链）：
//
//	① `uploadComplete` 的「**重放缓存命中段**」：一条**已成功 complete** 的重发请求必须走缓存
//	   命中、**零成本**返回 —— 不读请求体、不编译、不落版本行、不写审计、不烧上传额度、
//	   不占编译槽，且**不得**被"平台此刻水位偏低"变成一个 503（`upload.go` 的注释逐字写着：
//	   「让'平台此刻水位偏低'把一个已经成功的结果变成 503，只会逼客户端重传 32 MiB」）。
//	② 「**重放缓存查表 vs 拒绝闸门**」的**优先级**（FW-E §6.2 / FW-F §6.2 都判定"不是缺陷"，
//	   但**今天没有任何判据钉住**它）—— 本文件把它钉成设计：**拒绝优先**
//	   （极小声明预算的重发 ⇒ 504 结构化结论，**不是**回放的 201）。
//
// # 为什么②是"拒绝优先"而不是"重放优先"（实测口径，不是照抄报告）
//
// `uploadComplete` 的语句顺序（`upload.go`；本文件的 Test 2 逐条钉住）是：
//
//	挂载总预算 → requireCompiler → currentUser → **拒绝闸门** → upload_id 形状 →
//	**重放缓存查表** → complete 租约（锁内再查一次重放）→ Content-Length → 发布水位闸门 →
//	`acquireUpload` → 读请求体 → 拼装 + 发布
//
// 于是"客户端声明自己只剩 1 s（< 传输余量 15 s）"的重发拿到的是 **504
// `RUNTIME_TIMEOUT` + `phase=publish_budget`**，而不是回放的 201。这不是缺陷，三条理由：
//
//  1. **结论必须落在客户端放弃之前**（FW-2 的本体）：客户端自称只等 1 s，平台此刻**任何**
//     工作都在它的出站预算之外。当场给结论（含"带同一个 upload_id 重发"的 hints）比让它在
//     租约/查表里等更符合承诺 —— 而且拒绝路径本身是零成本的（不占锁、不烧额度、不读体）。
//  2. **恢复路径是活的，且 Test 3 会证明它**：照 hints 做（同一个 `upload_id`、新的一次调用
//     = 完整 90 s 预算）⇒ 同一条缓存命中、**逐字相同的 201**，分片不重传。所以"被拒"不等于
//     "结果丢了"：客户端不会在"其实已经成功"这件事上走进死路。
//  3. **重放缓存 TTL 与会话有效期同源（30 min）**，远长于任何一次工具调用的重试间隔 ⇒
//     上面那条恢复路径在任何现实时序里都还在有效期内。
//
// ⚠️ 若主控日后决定改成"**重放优先**"（FW-E §6.2 的评论认为"回放一个已成功的 201 优于给
// 预算不足结论"），那是**行为变更**：必须同时改生产代码（把重放查表挪到拒绝闸门之前）、
// 本文件 Test 2 的 `refusalIdx < cacheIdx` 断言与 Test 3，并在发布说明登记。两份判据一起红
// 就是这次"钉成设计"的可见性 —— 不要只改一处让它变绿。
//
// # 关于①的一条**实测负面结论**（认账，避免下一轮把它当缺口重复报）
//
// 只把 `h.uploads().Completed(...)` 这一个**快速路径**删掉/挪后，**行为上不可观测**：
// `h.uploads().BeginComplete(...)` 在会话锁内会再查一次同一份缓存，且它同样排在拒绝闸门
// 之后的**同一位置**（发布水位闸门 / 额度闸门 / 读体之前）。实测：把快速路径整块删掉之后
// Test 1（零成本 + 关闸门仍回放 201）与 Test 3（优先级）**全绿**（见交付报告 §变异矩阵）。
// 所以①拆成两半交付，各自有牙：
//
//   - **行为面**（Test 1）：重放零成本、且在水位闸门关掉时仍然回放 —— 它咬的是"把**整段**
//     重放挪到工作闸门之后"（那时 201 会变成 503）；
//   - **结构面**（Test 2）：重放查表**存在且排在**发布水位闸门 / 额度闸门 / 读请求体之前 ——
//     它咬的是"删掉这一个查表点"与"把它挪到后面"（这两种形态里锁内那份兜底会让行为面
//     保持绿，只有结构面能看见）。
//
// 这条冗余本身也是发现（两份重放点 = 两处必须同步维护的位置纪律）；处置（合并成一处，或给
// 快速路径补一条只有它能满足的判据）要动生产代码 ⇒ 已登记进交付报告，未擅自改。

// ---------------------------------------------------------------------------
// 1. 重放是零成本的，且不依赖发布水位闸门
// ---------------------------------------------------------------------------

// TestCompleteReplayIsZeroCostAndSurvivesClosedGate：一条已成功 complete 的重发请求
// 必须走重放缓存、零成本返回，**且在水位闸门关掉时照样**回放（而不是 503）。
//
// 观测面（全部是"用户可见 / 资源可计"的量，不读内部字段）：
//   - 状态码 + 响应体**逐字**（与首次 201 相同）；
//   - 请求体**一个字节都没被读**（`signallingSlowReader` 的 `started` 不闭合）、
//     耗时远小于读体延迟（读体是"零成本"最直接的观测面）；
//   - 不落版本行、不写审计、不烧上传小时额度、不占编译槽（`Compiler.UploadState`）。
//
// 自校准两条（本仓纪律：判据先自问"我的量具在本环境真的咬得到吗"）：
//   - 额度计量真的会动（一次成功 complete 之后 `used == 1`、`inflight == 0`）；
//   - 闸门**真的**关上了（同一个装配下"新发布"必须 503）。
//
// 变异验证（实跑见交付报告 temp/audit-v282/fixes/P2.md）：
//   - 把 `h.publishGate()` 那一块从"重放查表 + 租约之后"挪到"重放查表之前" ⇒
//     闸门关掉时重发变 503 ⇒ 本用例红；
//   - 删掉快速路径查表**单独一条不红**（见文件头部的实测负面结论）。
func TestCompleteReplayIsZeroCostAndSurvivesClosedGate(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const readDelay = 3 * time.Second
	// 交付树实测是毫秒量级；上界给 1 s（≈ 三个数量级余量），读体真被读的话至少多 3 s。
	const elapsedUpperBound = time.Second

	// 可变磁盘水位：同一个装配里"先正常发布、再把闸门关掉"。
	// `publishGate()` → `readyz.AllowPublish()` 是 api 层唯一的发布水位入口，注入可翻转的
	// `DiskFree` 就能确定性地开关它（与 readygate_test.go 同一条接缝）。
	free := new(atomic.Int64)
	const openWater = int64(readyz.MinDiskFreeBytes) * 4
	free.Store(openWater)
	gate := readyz.New(readyz.Options{
		DataRoot: t.TempDir(),
		DiskFree: func(string) (int64, error) { return free.Load(), nil },
	})
	env := newUploadEnv(t, func(o *Options) { o.Ready = gate })

	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()
	token := env.tokens["alice"]
	const appID = "replay-cost-app"

	sess := env.createUpload(token, appID, "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	first := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("重放零成本", cfg))
	if first.Code != http.StatusCreated {
		t.Fatalf("首次 complete = %d %s（前置条件：会话可用 + 3 片到位 + 闸门开着）",
			first.Code, first.Body.String())
	}
	firstBody := first.Body.String()
	releases, audits := env.countReleases(appID), env.countAudit()
	usedBefore, inflightBefore := env.compiler.UploadState(env.ids["alice"], time.Now())

	// 自校准①：额度计量真的会动 —— 否则下面"请求前后不变"的两条断言都是恒真。
	if usedBefore != 1 {
		t.Fatalf("自校准失败：一次成功 complete 之后 used = %d, want 1"+
			"（量具坏了 ⇒ 本用例的额度断言会退化成恒真）", usedBefore)
	}
	if inflightBefore != 0 {
		t.Fatalf("自校准失败：请求返回后 inflight = %d, want 0（成功路径必须释放并发占位）", inflightBefore)
	}
	if releases != 1 {
		t.Fatalf("自校准失败：首次 complete 之后版本行 = %d, want 1", releases)
	}

	// 关闸门（磁盘余量 1 字节 « 1 GiB 红线），并自校准"真的关上了"。
	free.Store(1)
	probeClosedGate := func(t *testing.T, probeApp string) {
		t.Helper()
		w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/"+probeApp+"/releases", token,
			env.payload(probeApp, "1.0.0", wasm, cfg))
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("自校准失败：磁盘余量 = 1 字节时新发布 = %d（%s），want 503 —— "+
				"闸门没关上的话，下面「重放不被水位影响」这条断言就没有判别力", w.Code, w.Body.String())
		}
	}
	probeClosedGate(t, "replay-gate-probe")

	// 重发：请求体**故意慢 3 s**（读体 = 零成本最直接的观测面），且**不带**预算声明
	// （老客户端/第三方客户端的形态：平台用默认总预算，而闸门仍关着）。
	slow := newSignallingSlowReader(readDelay)
	req := httptest.NewRequest(http.MethodPost, completePath(sess.UploadID),
		io.MultiReader(slow, strings.NewReader(string(replayJSON(t, completeBody("换个标题也不影响", cfg))))))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()

	start := time.Now()
	env.r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	if rec.Code != http.StatusCreated {
		t.Fatalf("已成功 complete 的重发 = %d（%s），want 201：重放缓存必须排在发布水位闸门**之前**"+
			"（`upload.go` 的注释逐字写着「让'平台此刻水位偏低'把一个已经成功的结果变成 503，"+
			"只会逼客户端重传 32 MiB」）。把 `h.publishGate()` 挪到重放查表之前即复现本红。",
			rec.Code, rec.Body.String())
	}
	if rec.Body.String() != firstBody {
		t.Fatalf("重放体必须与首次 201 **逐字**相同（客户端可能就是丢了首次响应才重发的）:\n first=%s\nsecond=%s",
			firstBody, rec.Body.String())
	}
	// 零成本①：请求体一个字节都没读。
	select {
	case <-slow.started:
		t.Errorf("重放读了请求体：重放必须排在读体之前")
	default:
	}
	// 零成本②：毫秒级返回。
	if elapsed >= elapsedUpperBound {
		t.Errorf("重放耗时 %s ≥ %s：重放路径上出现了非零成本的工作", elapsed, elapsedUpperBound)
	}
	// 零成本③：不落版本行、不写审计、不烧上传小时额度、不占编译槽。
	if got := env.countReleases(appID); got != releases {
		t.Errorf("重放又落了版本行：%d → %d", releases, got)
	}
	if got := env.countAudit(); got != audits {
		t.Errorf("重放又写了审计：%d → %d", audits, got)
	}
	usedAfter, inflightAfter := env.compiler.UploadState(env.ids["alice"], time.Now())
	if usedAfter != usedBefore || inflightAfter != inflightBefore {
		t.Errorf("重放消耗了上传额度/占用了编译槽：used %d → %d、inflight %d → %d",
			usedBefore, usedAfter, inflightBefore, inflightAfter)
	}
	// 归因：上面那个 201 只能来自重放路径 —— 闸门此刻仍然是关着的（再探一次）。
	probeClosedGate(t, "replay-gate-probe-2")

	// 恢复路径（与 Test 3 的后半段同源）：闸门重新打开后用**同一个** upload_id 重发，
	// 仍逐字相同 ⇒ 缓存 TTL（= 会话有效期 30 min）之内结果一直取得到。
	free.Store(openWater)
	final := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("再来一次", cfg))
	if final.Code != http.StatusCreated || final.Body.String() != firstBody {
		t.Fatalf("闸门恢复后重放应仍逐字相同：%d %s", final.Code, final.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 2. 重放查表的**位置**（结构判据；行为面被"锁内那份兜底"掩住 ⇒ 只有结构面看得见）
// ---------------------------------------------------------------------------

// replayStep 是 `uploadComplete` 的一条顶层语句（判据只需要序号、原文与被调用者集合）。
type replayStep struct {
	idx   int
	text  string
	calls []string
}

// TestCompleteReplayCacheLookupPrecedesWorkGates 钉住 `uploadComplete` 里重放查表的
// **存在**与**位置**：它必须在发布水位闸门（`h.publishGate`）、上传额度闸门
// （`h.acquireUpload`）与读请求体（`bindJSONLimited`）**之前**，且在拒绝闸门
// （`h.publishBudgetRefusal`）**之后**（= 文件头部 §② 的"拒绝优先"优先级）。
//
// 为什么用结构判据（本仓纪律："能力级判据 > 源码字符串判据"，这里是**有意的例外**，
// 理由必须写在代码里）：`h.uploads().BeginComplete(...)` 在会话锁内会再查一次同一份缓存，
// 且位置相同 ⇒ 只删/只挪**快速路径**那个查表点在行为上不可观测（实测见文件头部）。
// 要覆盖"删掉/挪后"这一族，只能在语句顺序上钉。
//
// 判据读的是 **AST 顶层语句顺序**（不是字符串 contains）：语句被删、被挪到别处、或被换成
// 别的调用都会让某条断言红；注释、空行、换行、gofmt 不动它。
//
// 变异验证（实跑见交付报告）：
//   - 删掉 `if body, ok := h.uploads().Completed(...)` 整块 ⇒ "查表点缺失"红；
//   - 把它整块挪到 `h.publishGate()` 之后 ⇒ "排在水位闸门之前"红；
//   - 把它挪到拒绝闸门之前 ⇒ 优先级断言红（Test 3 同时红）。
func TestCompleteReplayCacheLookupPrecedesWorkGates(t *testing.T) {
	const rel = "upload.go"
	fset, file := parseGoFile(t, rel)
	fn := findFuncDecl(t, file, "uploadComplete")
	if fn.Body == nil {
		t.Fatalf("%s 的 uploadComplete 没有函数体（判据的扫描面缺失，拒绝静默通过）", rel)
	}

	steps := make([]replayStep, 0, len(fn.Body.List))
	for i, stmt := range fn.Body.List {
		steps = append(steps, replayStep{idx: i, text: compactNode(t, fset, stmt), calls: calledFuns(t, fset, stmt)})
	}
	where := func(t *testing.T, want string) int {
		t.Helper()
		hit := -1
		hitText := ""
		for _, s := range steps {
			for _, c := range s.calls {
				if c != want {
					continue
				}
				if hit >= 0 {
					t.Fatalf("`%s` 在 uploadComplete 里出现了多次（语句 #%d 与 #%d）："+
						"多一个查表/闸门点 = 多一处必须同步维护的位置纪律；本条判据要求恰好一次。\n"+
						"  语句 #%d: %s\n  语句 #%d: %s",
						want, hit, s.idx, hit, hitText, s.idx, s.text)
				}
				hit, hitText = s.idx, s.text
			}
		}
		if hit < 0 {
			t.Fatalf("在 %s 的 uploadComplete 里找不到 `%s` —— 判据的扫描面缺失（被删除/改名？），"+
				"拒绝静默通过。\n  当前顶层语句：\n%s", rel, want, dumpReplaySteps(steps))
		}
		return hit
	}

	refusalIdx := where(t, "h.publishBudgetRefusal")
	cacheIdx := where(t, "h.uploads().Completed")
	gateIdx := where(t, "h.publishGate")
	quotaIdx := where(t, "h.acquireUpload")
	bodyIdx := where(t, "bindJSONLimited[uploadPayload]")

	if !(refusalIdx < cacheIdx) {
		t.Errorf("重放查表（语句 #%d）排在拒绝闸门（语句 #%d）**之前**：优先级被反转成「重放优先」。\n"+
			"  当前设计是**拒绝优先**（见文件头部 §②：客户端自称只等 1 s ⇒ 平台必须当场给结论；"+
			"恢复路径 = 带同一个 upload_id 重新发起一次调用，Test 3 会证明缓存与逐字相同的 201 都还在）。\n"+
			"  若这是**有意**的行为变更：请同时改生产代码、Test 3 与发布说明，不要只让判据变绿。",
			cacheIdx, refusalIdx)
	}
	if !(cacheIdx < gateIdx) {
		t.Errorf("重放查表（语句 #%d）没有排在发布水位闸门（语句 #%d）**之前**："+
			"平台水位偏低时一个**已经成功**的结果会变成 503，逼客户端重传整个模块。"+
			"（upload.go 的注释把这条位置纪律写死了。）", cacheIdx, gateIdx)
	}
	if !(cacheIdx < quotaIdx) {
		t.Errorf("重放查表（语句 #%d）没有排在上传额度闸门（语句 #%d）**之前**："+
			"一次重放不该烧掉用户的小时额度。", cacheIdx, quotaIdx)
	}
	if !(cacheIdx < bodyIdx) {
		t.Errorf("重放查表（语句 #%d）没有排在读请求体（语句 #%d）**之前**："+
			"重发的体可能几十 MiB（客户端形态），重放必须一个字节都不读。", cacheIdx, bodyIdx)
	}
}

// ---------------------------------------------------------------------------
// 3. 重放 vs 拒绝闸门：优先级端到端（钉成设计）
// ---------------------------------------------------------------------------

// TestCompleteReplayPriorityIsRefusalFirst 把「重放缓存查表 vs 拒绝闸门」的优先级
// **端到端钉成设计**：一条**已经成功**的 complete，被客户端以"这一跳只剩 1 s"重发时，
// 平台给的是 **504 结构化结论**（不是回放的 201）。
//
// 三段（缺一不可）：
//
//	① 当前优先级：极小声明 + **已成功**的会话 ⇒ 504 `RUNTIME_TIMEOUT` + `phase=publish_budget`
//	   + `client_declared_budget_seconds=1` + 含 `upload_id` 的 hints，且请求体未被读；
//	   **显式断言它不是 201** —— 把重放查表挪到拒绝闸门之前（或把闸门挪到租约之后）就会变 201。
//	② 恢复路径可达：照 hints 做（同一个 `upload_id` + 完整预算）⇒ 回放的 201 与首次**逐字相同**
//	   ⇒ "拒绝"没有把已成功的结果变成死路（这正是判定②"不是缺陷"的判据）。
//	③ 优先级与缓存状态无关：成功回放之后再发一次极小声明 ⇒ 又是 504（不是"缓存有了就优先回放"）。
//
// 变异验证（实跑见交付报告）：把 `if body, ok := h.uploads().Completed(...)` 整块挪到
// `h.publishBudgetRefusal(...)` 之前 ⇒ ①与③拿到 201 ⇒ 本用例红（Test 2 的优先级断言同时红）。
func TestCompleteReplayPriorityIsRefusalFirst(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const readDelay = 3 * time.Second
	const refusalUpperBound = time.Second
	// 声明 1 s：不足传输余量（`limits.PublishTransferReserve` = 15 s）⇒ 有效预算 0。
	const tinyBudget = "1000"
	// 满额声明（= 客户端出站预算本身）⇒ 平台用默认总预算，行为与"不带这个头"逐字相同。
	const fullBudget = "90000"

	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()
	token := env.tokens["alice"]
	const appID = "replay-priority-app"

	sess := env.createUpload(token, appID, "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	first := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("优先级", cfg))
	if first.Code != http.StatusCreated {
		t.Fatalf("首次 complete = %d %s", first.Code, first.Body.String())
	}
	firstBody := first.Body.String()

	// 极小声明 + 慢请求体：拒绝必须在读体之前给出（位置纪律由 publish_refusal_position_test.go
	// 覆盖；这里用它一并钉住"结论是毫秒级"，避免把"等 3 s 后的 504"误读成优先级正确）。
	slow := newSignallingSlowReader(readDelay)
	req := httptest.NewRequest(http.MethodPost, completePath(sess.UploadID),
		io.MultiReader(slow, strings.NewReader(string(replayJSON(t, completeBody("优先级", cfg))))))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set(ClientBudgetHeader, tinyBudget)
	rec := httptest.NewRecorder()
	start := time.Now()
	env.r.ServeHTTP(rec, req)
	elapsed := time.Since(start)

	if rec.Code == http.StatusCreated {
		t.Fatalf("极小声明预算的重发拿到了 201（回放）：**当前设计不是这个优先级** —— " +
			"`h.uploads().Completed(...)` 排在 `h.publishBudgetRefusal(...)` 之后，所以拒绝先发生。\n" +
			"  若这是有意改成「重放优先」（FW-E §6.2 认为那更好）：请同时改生产代码、本用例、" +
			"Test 2 的 `refusalIdx < cacheIdx` 断言与发布说明（行为变更登记）。")
	}
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("极小声明预算的重发 = %d（%s），want 504 结构化预算结论", rec.Code, rec.Body.String())
	}
	if elapsed >= refusalUpperBound {
		t.Errorf("拒绝耗时 %s ≥ %s（请求体要 %s 才到达）：拒绝发生在读请求体之后", elapsed, refusalUpperBound, readDelay)
	}
	select {
	case <-slow.started:
		t.Errorf("请求体在结论之前被读了：拒绝闸门排在了读请求体之后")
	default:
	}
	var eb errBody
	if err := json.Unmarshal(rec.Body.Bytes(), &eb); err != nil {
		t.Fatalf("响应不是 JSON 错误信封: %v; body=%s", err, rec.Body.String())
	}
	if eb.Error.Code != string(apperr.CodeRuntimeTimeout) || eb.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("结论形态不对：code=%s details=%v（拒绝必须与 FW-2 的其余入口同形）",
			eb.Error.Code, eb.Error.Details)
	}
	if got := eb.Error.Details["client_declared_budget_seconds"]; got != float64(1) {
		t.Fatalf("details.client_declared_budget_seconds = %v, want 1", got)
	}
	// **续传把手必须进 `details`**（审计 V-P2P7 的 F-A，P1）：这条路径上唯一的调用方是 AI 的
	// 分片链，而模型只能从 `error.details.upload_id` 取值（工具面 `UPLOAD_ID_DESCRIPTION`
	// 逐字如此）—— 只把 "upload_id" 这个词写在**静态 hints 文案**里等于没给 id。
	//
	// ⚠️ 本断言**不许**退化成 `strings.Contains(hints, "upload_id")`：那种写法对**常量字符串**
	// 成立，会把"结果拿不回来"这个缺口假设掉（这正是 F-A 的成因）。
	if got, ok := eb.Error.Details["upload_id"]; !ok {
		t.Fatalf("预算拒绝的 details 里没有 upload_id（只有静态 hints 里出现过这个词）："+
			"模型拿不到续传把手就会重开会话、分片全部重传。details=%v; hints=%v",
			eb.Error.Details, eb.Error.Hints)
	} else if got != sess.UploadID {
		t.Fatalf("details.upload_id = %v, want %q（**真实会话 id**，不是文案）：details=%v",
			got, sess.UploadID, eb.Error.Details)
	}

	// ② 恢复路径：同一个 upload_id + 完整预算 ⇒ 与首次**逐字相同**的 201。
	back := env.completeWithBudget(t, token, sess.UploadID, fullBudget, completeBody("恢复", cfg), 0)
	if back.Code != http.StatusCreated {
		t.Fatalf("按 hints 重发（同一个 upload_id、完整预算）= %d %s，want 201 —— "+
			"恢复路径不可达的话，「拒绝优先」就不再是「可接受的优先级」而是缺陷",
			back.Code, back.Body.String())
	}
	if back.Body.String() != firstBody {
		t.Fatalf("恢复路径的回放体必须与首次 201 逐字相同:\n first=%s\n  back=%s", firstBody, back.Body.String())
	}

	// ③ 优先级与"缓存里有没有东西"无关：再发一次极小声明 ⇒ 仍是 504。
	again := env.completeWithBudget(t, token, sess.UploadID, tinyBudget, completeBody("再来", cfg), 0)
	if again.Code != http.StatusGatewayTimeout {
		t.Fatalf("缓存已命中之后再发极小声明 = %d（%s），want 504 —— "+
			"「拒绝优先」是**闸门位置**决定的不变量，不是「缓存命中就翻面」的偶然顺序",
			again.Code, again.Body.String())
	}
}

// ---------------------------------------------------------------------------
// 1.2.2 预算结论必须携带**续传把手**（审计 V-P2P7 的 F-A，P1）
// ---------------------------------------------------------------------------

// TestCompleteBudgetConclusionCarriesUploadID：`complete` 这一跳的**预算结论**
// （入口拒绝 + 阶段之内到点，同族两个出口）必须在 `details` 里带**真实会话 id**。
//
// 缺陷形态（V-P2P7 §1.3(b) 的 F-A）：原先 `upload_id` 只在**静态 hints 文案**里作为
// 一个词出现，`details` 里没有任何会话 id；而这条路径上唯一的调用方是 AI 的
// `wasm_app_publish` 分片链，工具面（`UPLOAD_ID_DESCRIPTION`）逐字要求模型
//
//	「把它从 `error.details.upload_id` 原样填回来」
//
// ⇒ 模型拿不到 id ⇒ 只能重开一次会话 ⇒ 分片全部重传（"白传一遍几百 MB"）——
// 与 P7 修掉的"客户端 complete 跳传输失败不带 upload_id"是**同一个后果**。
// 可达性也不是边角：`perCallBudget() = max(1000, 链预算 − 已用)`，所有分片传完时剩余
// ≤ 传输余量（15 s）就落进拒绝区。
//
// 三段（第 ③ 段是**负向**，防止修法被放宽成"给所有错误都撒 id"）：
//
//	① 入口拒绝（极小声明）⇒ `details.upload_id == sess.UploadID`；
//	② 阶段之内到点（不声明预算、但平台侧总预算已被注入时钟压到 ≈2 s，模块 `_start` 永不
//	   返回）⇒ 同族出口同样带 `upload_id`（`budgetExclusion*` 的两条路径都要有）；
//	③ 业务拒绝（config 拼错字段 ⇒ 422 `APP_CONFIG_INVALID`）**不得**带该字段 ——
//	   "用同一个 upload_id 重发"对业务拒绝不是正确的下一步，撒 id 只会误导模型。
//
// 为什么断言写在 `details` 而不是 `hints`：见 §1.2 —— `strings.Contains(hints, "upload_id")`
// 对**常量字符串**成立，会把 F-A 这类缺口整体假设掉（这正是它当初漏掉的原因）。
//
// 变异验证（实跑见交付报告「核验后收口」）：把两个调用点的
// `budgetConclusionWithUploadID(...)` 换回裸 `rerr` / `cerr` ⇒ ① 与 ② 红；
// 把 helper 的 `phase != "publish_budget"` 判据删掉（改成无条件加）⇒ ③ 红。
func TestCompleteBudgetConclusionCarriesUploadID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 声明 1 s：不足传输余量（`limits.PublishTransferReserve` = 15 s）⇒ 有效预算 0。
	const tinyBudget = "1000"
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)

	// ---- ① 入口拒绝 ----
	env := newUploadEnv(t)
	cfg := goodConfig()
	token := env.tokens["alice"]
	sess := env.createUpload(token, "upload-id-refusal-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess.UploadID, i, part)
	}
	w := env.completeWithBudget(t, token, sess.UploadID, tinyBudget, completeBody("F-A 入口拒绝", cfg), 0)
	eb := env.decodeErr(w, http.StatusGatewayTimeout)
	if eb.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("前置条件不成立：details.phase = %v, want publish_budget（%s）",
			eb.Error.Details["phase"], w.Body.String())
	}
	if got := eb.Error.Details["upload_id"]; got != sess.UploadID {
		t.Fatalf("入口拒绝的 details.upload_id = %v, want %q（真实会话 id）。\n"+
			"  这条路径上唯一的调用方是 AI 分片链，模型只能从 error.details.upload_id 取续传把手\n"+
			"  （工具面 UPLOAD_ID_DESCRIPTION 逐字如此）⇒ 只写在 hints 文案里等于没给 id。\n"+
			"  details=%v，hints=%v", got, sess.UploadID, eb.Error.Details, eb.Error.Hints)
	}

	// ---- ② 阶段之内到点（同族第二个出口）----
	//
	// 注入时钟把平台侧总预算压到 effective=2 s，并用 `_start` 永不返回的模块 ⇒ 只有总预算
	// 能结束它（与 publish_budget_test.go 的 TestRealEntriesHonorTotalBudget 同一条姿势）。
	// **不带**预算声明 ⇒ 入口拒绝闸门是 no-op ⇒ 结论来自阶段之内，必须同样带 upload_id。
	const effective = 2 * time.Second
	expired := newUploadEnv(t, func(o *Options) {
		o.Now = func() time.Time { return time.Now().UTC().Add(-(limits.PublishTotalBudget - effective)) }
	})
	// `spinningModule()` 只有 ~133 字节（`_start` 永不返回）：切成"1 片"（尾片豁免下限），
	// 与 publish_budget_test.go 的 complete 子用例同一条姿势。
	spin := spinningModule()
	sess2 := expired.createUpload(expired.tokens["alice"], "upload-id-stage-app", "1.0.0",
		int64(len(spin)), limits.UploadChunkMinBytes)
	expired.putChunk(expired.tokens["alice"], sess2.UploadID, 0, spin)
	w2 := expired.req(http.MethodPost, completePath(sess2.UploadID), expired.tokens["alice"],
		completeBody("F-A 阶段到点", cfg))
	eb2 := expired.decodeErr(w2, http.StatusGatewayTimeout)
	if eb2.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("前置条件不成立：阶段到点的结论 details.phase = %v, want publish_budget（%s）",
			eb2.Error.Details["phase"], w2.Body.String())
	}
	if got := eb2.Error.Details["upload_id"]; got != sess2.UploadID {
		t.Fatalf("阶段之内到点的预算结论 details.upload_id = %v, want %q ——\n"+
			"  同族两个出口（入口拒绝 / 阶段到点）都必须带续传把手；分片在两种情况下都还在服务端。\n"+
			"  details=%v", got, sess2.UploadID, eb2.Error.Details)
	}

	// ---- ③ 负向：非预算结论不得被撒上 upload_id ----
	badCfg := goodConfig()
	badCfg["visable"] = true // 拼错的字段名 ⇒ 422 APP_CONFIG_INVALID（业务拒绝）
	sess3 := env.createUpload(token, "upload-id-business-app", "1.0.0", int64(len(wasm)), chunk)
	for i, part := range parts {
		env.putChunk(token, sess3.UploadID, i, part)
	}
	w3 := env.req(http.MethodPost, completePath(sess3.UploadID), token, completeBody("业务拒绝", badCfg))
	eb3 := env.decodeErr(w3, http.StatusUnprocessableEntity)
	if eb3.Error.Code != "APP_CONFIG_INVALID" {
		t.Fatalf("前置条件不成立：code = %s, want APP_CONFIG_INVALID（%s）", eb3.Error.Code, w3.Body.String())
	}
	if got, ok := eb3.Error.Details["upload_id"]; ok {
		t.Errorf("业务拒绝（%s）的 details 里出现了 upload_id = %v：预算结论才需要续传把手 ——\n"+
			"  业务拒绝用同一个 upload_id 重发不是正确的下一步，撒 id 会误导模型。"+
			"（修法：`budgetConclusionWithUploadID` 必须保留 `phase == \"publish_budget\"` 这道过滤。）",
			eb3.Error.Code, got)
	}
}

// ---------------------------------------------------------------------------
// 1.2.3 **不得**携带 `details.upload_id` 的五类出口（核验探针 → 仓内长期判据）
// ---------------------------------------------------------------------------
//
// 来自订正验证 P13-P1 §8 的建议项：核验方用**探针**实测了 5 类"不得携带 `details.upload_id`"
// 的出口（业务 422 / 未知会话 404 / **形态非法 id 的预算 504** / 水位 503 / 限流 429），
// 结论全部正确 —— 但那些断言**只活在探针里**（探针不进仓）⇒ 下一个人把 `uploadComplete`
// 的出口顺手接上 `budgetConclusionWithUploadID`、或把 `completeUploadID` 的形态校验删掉，
// 都不会红。本节把它们搬进仓内长期判据。
//
// 为什么"不带"也必须钉（正向判据钉不出这件事）：`budgetConclusionWithUploadID` 是**按调用点**
// 生效的（`publish.go` 的 helper 只认 `phase == "publish_budget"`，`upload.go` 只包了两处出口）。
// 两边的"过度应用"都会造成真实误导：
//
//   - **回显非法输入**：路由参数直接进 `details` ⇒ 把调用方给的任意字符串反射进 JSON 信封
//     （`completeUploadID` 的 `upload.ValidID` 就是为了这条；它**只回显、不做形态判定**，
//     形态闸门仍在 `uploadIDParam`）；
//   - **把续传把手撒到不该续传的出口**：未知会话 404 / 水位 503 / 限流 429 / 业务 422 上，
//     模型该做的分别是"新开会话""等水位""退避""改载荷"，而不是"拿同一个 upload_id 重发"
//     —— 给出 upload_id 会把它引向错误动作（这正是 §1.2.3 的 F-A 的反面）。
//
// 两个观测面（都断言）：① `details` 里**没有** `upload_id` 这个键；② **整份响应体**里
// 不出现给定的秘密串（真实会话 id / 非法输入）—— 后者是"回显"这条的**能力级**判据：
// 不管 id 从哪个字段漏出去都会红。
//
// 变异验证（实跑见交付报告「核验后收口」§8.8，每条一个变异）：
//   - 删掉 `completeUploadID` 的 `upload.ValidID` 校验 ⇒ ②（非法 id）红；
//   - 把 `BeginComplete` 的 404 出口也包一层 ⇒ ① 红；
//   - 把 `publishGate` 的 503 出口包一层 ⇒ ③ 红；
//   - 把 `acquireUpload` 的 429 出口包一层 ⇒ ④ 红；
//   - 把 helper 的 `phase` 过滤删掉（对所有错误生效）⇒ ⑤ 红（§8.2 的 N2 同形）。
func TestCompleteNonBudgetExitsCarryNoUploadID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 声明 1 s：不足传输余量（`limits.PublishTransferReserve` = 15 s）⇒ 有效预算 0 ⇒ 入口拒绝。
	const tinyBudget = "1000"
	wasm := testGuestModule(t)
	chunk, parts := planThree(t, wasm)
	cfg := goodConfig()

	// assertNoUploadID 是本节共用的判定（两个观测面，见上）。
	assertNoUploadID := func(t *testing.T, w *httptest.ResponseRecorder, wantStatus int, secret, what string) {
		t.Helper()
		if w.Code != wantStatus {
			t.Fatalf("%s：status = %d（%s），want %d —— 前置条件不成立（这条出口没走到）",
				what, w.Code, w.Body.String(), wantStatus)
		}
		var eb errBody
		if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
			t.Fatalf("%s：响应不是 JSON 错误信封: %v; body=%s", what, err, w.Body.String())
		}
		if got, ok := eb.Error.Details["upload_id"]; ok {
			t.Errorf("%s 的 details 里出现了 upload_id = %v：**只有预算结论**才带续传把手 —— 这条出口上"+
				"正确的下一步不是「拿同一个 upload_id 重发」，给出 id 会误导模型。"+
				"（修法：`budgetConclusionWithUploadID` 只在 `phase == \"publish_budget\"` 时生效；"+
				"且只包 `uploadComplete` 的两处**预算**出口。）", what, got)
		}
		if secret != "" && strings.Contains(w.Body.String(), secret) {
			t.Errorf("%s 的**整份响应体**里回显了 %q：续传把手（以及调用方给的原始输入）不得出现在这条"+
				"出口上 —— 尤其不得把非法路径参数反射进信封。body=%s", what, secret, w.Body.String())
		}
	}

	// 建一个"片已齐"的可用会话（多条子用例共用这段姿势）。
	withSession := func(t *testing.T, env *testEnv, appID string) uploadCreated {
		t.Helper()
		sess := env.createUpload(env.tokens["alice"], appID, "1.0.0", int64(len(wasm)), chunk)
		for i, part := range parts {
			env.putChunk(env.tokens["alice"], sess.UploadID, i, part)
		}
		return sess
	}

	t.Run("① 未知会话 404 不带 upload_id", func(t *testing.T) {
		env := newUploadEnv(t)
		// **形态合法**但库里不存在（64 位小写十六进制）。
		ghost := strings.Repeat("a", 64)
		w := env.req(http.MethodPost, completePath(ghost), env.tokens["alice"], completeBody("未知会话", cfg))
		assertNoUploadID(t, w, http.StatusNotFound, ghost, "未知会话 404")
	})

	t.Run("② 形态非法 id 的预算 504 不回显非法输入", func(t *testing.T) {
		env := newUploadEnv(t)
		// 形态非法（大写 + 连字符 + 长度不符）⇒ `completeUploadID` 必须返回 ""（不补字段），
		// 而**拒绝闸门仍然照常工作**（它排在形态闸门之前，那是位置纪律的一部分）⇒ 504 预算结论。
		const malformed = "NOT-HEX-upload-id"
		w := env.reqWithBudget(http.MethodPost, "/api/client/v2/apps/wasm/uploads/"+malformed+"/complete",
			env.tokens["alice"], completeBody("非法 id", cfg), tinyBudget)
		assertNoUploadID(t, w, http.StatusGatewayTimeout, malformed, "形态非法 id 的预算 504")
		// 结论形态仍必须是**预算结论**（别把这条子用例写成"随便一个 4xx 就算过"）。
		var eb errBody
		if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
			t.Fatalf("响应不是 JSON 错误信封: %v", err)
		}
		if eb.Error.Details["phase"] != "publish_budget" {
			t.Fatalf("details.phase = %v, want publish_budget（拒绝闸门仍须排在形态闸门之前）: %s",
				eb.Error.Details["phase"], w.Body.String())
		}
	})

	t.Run("③ 水位 503 不带 upload_id", func(t *testing.T) {
		// 闸门关着（磁盘余量 1 字节 < 1 GiB 红线）；预算声明**正常**（不带头）⇒ 走到发布水位闸门。
		env := newUploadEnv(t, func(o *Options) { o.Ready = lowDiskChecker(t) })
		sess := withSession(t, env, "nonbudget-water-app")
		w := env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["alice"], completeBody("水位", cfg))
		assertNoUploadID(t, w, http.StatusServiceUnavailable, sess.UploadID, "水位 503")
	})

	t.Run("④ 限流 429 不带 upload_id", func(t *testing.T) {
		// 把该用户的"每小时上传次数"压到 1：一次成功 complete 之后，第二次必然 429。
		// 用独立的编译器实例（`compile.Options.UploadRatePerHour`）—— 夹具的 mutator 只覆盖
		// api 层的 `Options`，所以这里显式构造一个"限流到 1"的编译器装进去。
		var limited *compile.Compiler
		env := newUploadEnv(t, func(o *Options) {
			comp, err := compile.New(compile.Options{
				DataRoot:          sharedCacheRoot(t),
				ChildBinary:       testCompileChild(t),
				Isolation:         compile.IsolationOff,
				Logger:            testLogger{t},
				UploadRatePerHour: 1,
			})
			if err != nil {
				t.Fatalf("构造限流编译器失败: %v", err)
			}
			limited = comp
			o.Compiler = comp
		})
		t.Cleanup(func() {
			if limited != nil {
				_ = limited.Close()
			}
		})
		first := withSession(t, env, "nonbudget-rate-app-1")
		if w := env.req(http.MethodPost, completePath(first.UploadID), env.tokens["alice"],
			completeBody("限流前", cfg)); w.Code != http.StatusCreated {
			t.Fatalf("前置条件不成立：第一次 complete = %d %s（配额 1 必须允许第一次）", w.Code, w.Body.String())
		}
		second := withSession(t, env, "nonbudget-rate-app-2")
		w := env.req(http.MethodPost, completePath(second.UploadID), env.tokens["alice"], completeBody("限流", cfg))
		assertNoUploadID(t, w, http.StatusTooManyRequests, second.UploadID, "限流 429")
	})

	t.Run("⑤ 业务 422 不带 upload_id", func(t *testing.T) {
		env := newUploadEnv(t)
		sess := withSession(t, env, "nonbudget-business-app")
		badCfg := goodConfig()
		badCfg["visable"] = true // 拼错的字段名 ⇒ 422 APP_CONFIG_INVALID
		w := env.req(http.MethodPost, completePath(sess.UploadID), env.tokens["alice"],
			completeBody("业务拒绝", badCfg))
		assertNoUploadID(t, w, http.StatusUnprocessableEntity, sess.UploadID, "业务 422")
	})
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

// replayJSON 序列化请求体（失败即 Fatal：请求体造不出来时判据必须红而不是静默跳过）。
func replayJSON(t *testing.T, v any) []byte {
	t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		t.Fatalf("序列化请求体失败: %v", err)
	}
	return raw
}

// calledFuns 返回 stmt 这棵子树里所有调用表达式的**被调用者**文本（归一化空白）：
// `h.uploads().Completed`、`h.publishGate`、`bindJSONLimited[uploadPayload]` …
//
// 用"整条被调用者链"而不是"函数名字面量"：`h.uploads().Completed` 这种经方法链抵达的
// 调用点在"只钉名字"的实现里是盲区（本仓已登记的假绿形态）。
func calledFuns(t *testing.T, fset *token.FileSet, stmt ast.Stmt) []string {
	t.Helper()
	var out []string
	ast.Inspect(stmt, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		out = append(out, compactNode(t, fset, call.Fun))
		return true
	})
	return out
}

// dumpReplaySteps 把顶层语句顺序渲染进失败文案（人一眼能看出被删/被挪的是哪一句）。
func dumpReplaySteps(steps []replayStep) string {
	var sb strings.Builder
	for _, s := range steps {
		sb.WriteString("  #")
		sb.WriteString(strconv.Itoa(s.idx))
		sb.WriteString(": ")
		sb.WriteString(s.text)
		sb.WriteString("\n")
	}
	return sb.String()
}
