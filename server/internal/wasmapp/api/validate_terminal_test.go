// validate 的**终态闸门**：与 publish 共用 `publishBlockOf`（R3-A 复审 F1）。
//
// 缺陷形态（复审实测，非推断）：availability（A-4 已修）与 publish 已经同源，唯独
// **第三个消费面** `POST /apps/wasm/validate` 没接上 —— 对冻结/退役的应用：
//
//	POST …/wasm/validate          → 200 {"validation":{…,"ok":true,"dry_run":"ok"}}
//	POST …/wasm/<frozen>/releases → 403 APP_FROZEN  应用已冻结，不能发布新版本
//	POST …/wasm/validate          → 200 {"validation":{…,"ok":true,"dry_run":"ok"}}
//	DELETE …/wasm/<retired>       → 200（退役）
//	POST …/wasm/<retired>/releases→ 404 NOT_FOUND   应用已退役（已删除）
//
// 这正是 A-4 要消灭的"预检说可以、发布被拒"：`validate` 的头部注释自己写着
// "基线不可用时预检也必须给出与发布**同一个**结论"，而 AI 的第一动作就是先预检
// （`server/skills/app-builder/references/publishing.md` 的发布链路）。第三个面没接
// 上，等于把同一个分叉换了个入口留下，还白烧一次真编译与 validate/publish 合计
// 30 次/小时的额度。
//
// 判据（四条，缺一条都不算闭合）：
//
//	① 冻结/退役：validate 的错误响应与**真发一次发布**得到的错误响应**逐字节相同**
//	   （同一处判据、同一份 code/message/details/hints）—— 客户端只需要一套渲染分支，
//	   这条同时是"谁在 validate 里另写一份文案/另判一次"的判据（会立刻红）；
//	② 非终态对照：本人的正常应用（yours）、下架（enabled=false）、空闲标识都必须照旧
//	   放行 —— 把整条端点变成"什么都不许发"也能让 ① 变绿，却会直接打断发布流程；
//	③ 归属优先：外人对他人**终态**应用的预检仍是 404「应用不存在」（A-2 的反 oracle
//	   口径），不得被终态闸门改写成"这个应用冻着/退役了"的状态探测器；
//	④ 被拒的预检零副作用：不落版本行、不写审计、不消耗编译产物。
//
// 顺序（第 ⑤ 条判据）**不在本用例里**：①②③④ 对"闸门在编译之前还是之后"全都无感
// —— 闸门无论如何都会在响应前生效，逐字节同形只证明"判据同源"。顺序判据是
// TestValidateTerminalAppsNeverReachCompile（同一文件下半部分）。
//
// 变异验证（实跑对照见交付报告）：
//   - 删掉 `validate` 里新加的 `publishBlockOf` 闸门 ⇒ ① 两条子用例红
//     （validate 回 200 `ok:true`，与 publish 的 403/404 不同形）；
//   - 把闸门挪到 `isFirstRelease`/`prepare` **之后** ⇒ ①②③④ 仍绿（这就是复审 F-1），
//     ⑤ 红 —— 由 `TestValidateTerminalAppsNeverReachCompile` 的编译计数与
//     "编译之后才会失败"的载荷两条观测面钉住；
//   - 把闸门改成也拦 `enabled=false` ⇒ ② 的红（下架不是终态）。
package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// validateRaw 发一次真实预检，回**原始响应**（判定要的是逐字节，不是 DTO）。
func (e *testEnv) validateRaw(token, appID, version string, wasm []byte, cfg map[string]any) *httptest.ResponseRecorder {
	e.t.Helper()
	return e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", token,
		e.payload(appID, version, wasm, cfg))
}

// publishRawErr 真发一次发布并回**原始响应**（预期必须失败）。
//
// 与 `publishErrEnvelope` 的差别：那个解析成 DTO（判 code/message），这个保留字节
// —— 逐字节同形是本次修复的核心承诺（"客户端只需要一套渲染分支"）。
func (e *testEnv) publishRawErr(token, appID, version string, wasm []byte, cfg map[string]any) *httptest.ResponseRecorder {
	e.t.Helper()
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", token,
		e.payload(appID, version, wasm, cfg))
	if w.Code < 400 {
		e.t.Fatalf("预期发布失败，实际 %d %s", w.Code, w.Body.String())
	}
	return w
}

// TestValidateAgreesWithPublishOnTerminalApps 是 F1 的**主判据**（判据 ①③④）。
func TestValidateAgreesWithPublishOnTerminalApps(t *testing.T) {
	// 应用标识刻意避开 "frozen"/"retired" 字面量：下面的反 oracle 判据按**子串**扫
	// 响应体，标识里带上这几个词会让判据自己被夹具"命中"（假红）。
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "ice-own", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "ash-own", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["bob"], "ice-foreign", "1.0.0", guest, goodConfig())
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/ice-own/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/ash-own", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("退役失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/ice-foreign/freeze", e.tokens["bob"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结他人应用失败: %s", w.Body.String())
	}

	cases := []struct {
		appID       string
		wantStatus  int
		wantCode    apperr.Code
		wantMessage string
	}{
		{appID: "ice-own", wantStatus: http.StatusForbidden, wantCode: apperr.CodeAppFrozen,
			wantMessage: "应用已冻结，不能发布新版本"},
		{appID: "ash-own", wantStatus: http.StatusNotFound, wantCode: apperr.CodeNotFound,
			wantMessage: "应用已退役（已删除）"},
	}
	for _, tc := range cases {
		t.Run(tc.appID, func(t *testing.T) {
			// 参考信封先取：**真发一次发布**（这条路径会写一条 auditDenied，属发布面的
			// 既有语义）。之后才量预检的零副作用基线 —— 否则会把发布那一条算到预检头上。
			pw := e.publishRawErr(e.tokens["alice"], tc.appID, "2.0.0", guest, goodConfig())
			auditBefore := e.countAudit()
			releasesBefore := e.countReleases(tc.appID)

			vw := e.validateRaw(e.tokens["alice"], tc.appID, "2.0.0", guest, goodConfig())

			// ①-a 状态与判词：预检必须回终态错误，而不是 200 ok:true。
			if vw.Code != tc.wantStatus {
				t.Fatalf("validate status = %d, want %d（预检不得对终态应用回 200）: %s",
					vw.Code, tc.wantStatus, vw.Body.String())
			}
			if strings.Contains(vw.Body.String(), `"ok":true`) {
				t.Fatalf("validate 对终态应用回放了 ok:true（缺陷本体）: %s", vw.Body.String())
			}
			var vb errBody
			if err := json.Unmarshal(vw.Body.Bytes(), &vb); err != nil {
				t.Fatalf("validate 响应不是错误信封: %v; body=%s", err, vw.Body.String())
			}
			if vb.Error.Code != string(tc.wantCode) {
				t.Fatalf("validate code = %q, want %q", vb.Error.Code, string(tc.wantCode))
			}
			if vb.Error.Message != tc.wantMessage {
				t.Fatalf("validate message = %q, want %q", vb.Error.Message, tc.wantMessage)
			}
			if len(vb.Error.Hints) == 0 {
				t.Fatal("终态拒绝必须带可行动 hints（第一消费者是 AI）")
			}

			// ①-b **逐字节同形**：与真发一次发布拿到的错误响应完全相同。
			if vw.Body.String() != pw.Body.String() {
				t.Fatalf("validate 与 publish 的错误响应不同形（判据必须同源）:\nvalidate=%s\npublish =%s",
					vw.Body.String(), pw.Body.String())
			}
			if vw.Code != pw.Code {
				t.Fatalf("status 不同形：validate=%d publish=%d", vw.Code, pw.Code)
			}

			// ④ 零副作用：被拒的预检不落版本行、不写审计。
			if after := e.countReleases(tc.appID); after != releasesBefore {
				t.Fatalf("被拒的预检不得落版本行：before=%d after=%d", releasesBefore, after)
			}
			if after := e.countAudit(); after != auditBefore {
				t.Fatalf("被拒的预检不得写审计：before=%d after=%d", auditBefore, after)
			}
		})
	}

	// ③ 归属优先（反 oracle）：外人对他人**终态**应用拿到的仍是"应用不存在"，
	// 消息不得出现"冻结/退役"这类状态判词——否则冻结动作会变成可被外人探测的信号。
	vw := e.validateRaw(e.tokens["alice"], "ice-foreign", "2.0.0", guest, goodConfig())
	eb := e.decodeErr(vw, http.StatusNotFound)
	if eb.Error.Code != "NOT_FOUND" || eb.Error.Message != "应用不存在" {
		t.Fatalf("外人预检他人终态应用必须走归属口径的 404：%s", vw.Body.String())
	}
	for _, marker := range []string{"冻结", "退役", "frozen", "retired", "APP_FROZEN"} {
		if strings.Contains(vw.Body.String(), marker) {
			t.Fatalf("外人预检不得拿到终态状态判词 %q（那是一个冻结状态探测器）: %s", marker, vw.Body.String())
		}
	}
}

// TestValidateStillGreenForNonTerminalApps 是**反向用例**（判据 ②，防过度修复）。
//
// 三个非终态都必须照旧放行：本人的正常应用（yours）、**下架**（enabled=false，R37
// 的三态语义里它不是终态）、空闲标识（首版预检是 validate 的主要用途）。
func TestValidateStillGreenForNonTerminalApps(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "healthy-own", "1.0.0", guest, goodConfig())

	assertValidateOK := func(t *testing.T, appID string, firstRelease bool) {
		t.Helper()
		w := e.validateRaw(e.tokens["alice"], appID, "2.0.0", guest, goodConfig())
		if w.Code != http.StatusOK {
			t.Fatalf("%s 的预检必须放行，实得 %d: %s", appID, w.Code, w.Body.String())
		}
		var out struct {
			Validation map[string]any `json:"validation"`
		}
		e.decodeJSON(w, http.StatusOK, &out)
		if out.Validation["ok"] != true {
			t.Fatalf("%s 的预检必须回 ok:true: %s", appID, w.Body.String())
		}
		if out.Validation["first_release"] != firstRelease {
			t.Fatalf("%s first_release = %v, want %v", appID, out.Validation["first_release"], firstRelease)
		}
	}

	// 本人的正常应用（yours）。
	assertValidateOK(t, "healthy-own", false)

	// 下架：**不是终态**，预检与发布都不拦（把它一并拦掉就是过度修复）。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/healthy-own/unpublish", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("下架失败: %s", w.Body.String())
	}
	assertValidateOK(t, "healthy-own", false)

	// 空闲标识：首版预检（validate 的主要用途）。
	assertValidateOK(t, "brand-new-one", true)

	// 非归属人（taken）走的是归属口径的 404，**不是**终态判词 —— 与 publish 的
	// 409 NAME_TAKEN 不同码是有意的（A-2：validate 不得回显他人配置与存在性之外的
	// 任何东西），这里只钉住"不得出现终态判词"。
	w := e.validateRaw(e.tokens["bob"], "healthy-own", "2.0.0", guest, goodConfig())
	e.decodeErr(w, http.StatusNotFound)
	for _, marker := range []string{"冻结", "退役", "frozen", "retired", "APP_FROZEN"} {
		if strings.Contains(w.Body.String(), marker) {
			t.Fatalf("非终态的他人应用不得触发终态判词 %q: %s", marker, w.Body.String())
		}
	}
}

// compileJobs 返回该用例自己的编译器已执行的**编译任务数**（成功 + 失败）。
//
// 为什么用 compile 包自己的运行指标（`Stats().Compiles/Failures`，与 `/readyz`
// 同一份数据）而不新加替身计数器：
//
//   - 它是"有没有走到**真编译**"的**精确**观测面：`runJob` 每执行一个编译任务就推进
//     其中之一，而缓存命中**照样**要走子进程（命中判定在子进程返回之后按条目 mtime
//     推定，见 compileOne）—— 所以"缓存命中"不会让计数停在 0（换成"冷编译次数"
//     就会假绿）；
//   - 计数器是**每 testEnv 一份**（newTestEnv 各建一个 *compile.Compiler），且本包
//     用例都不并行（全包无 t.Parallel）⇒ "调用前后取差"是确定的。
//
// 走 `Prepare` 的其它步骤（解码 / 配置校验 / 抽取 / 干跑）都**不**经过这个计数器：
// 干跑走 runtime.New 的进程内装载，与 Compiler 的编译子进程是两条路。
func (e *testEnv) compileJobs() int64 {
	st := e.compiler.Stats()
	return st.Compiles + st.Failures
}

// TestValidateTerminalAppsNeverReachCompile 钉住 A-4 修法的**顺序收益**（复审 F-1）。
//
// 缺口形态（复审实测，非推断）：把 `validate` 里的 `publishBlockOf` 闸门挪到
// `prepare()`（静态校验 + 真编译 + 抽取 + 干跑）**之后**，同文件的
// TestValidateAgreesWithPublishOnTerminalApps 与 TestValidateStillGreenForNonTerminalApps
// **全部存活** —— 闸门无论如何都会在响应前生效，"逐字节同形"只证明了判据同源，对
// 位置无感。于是修复理由里明确写出的收益（"终态应用不再白白消耗一次真编译"）在一次
// "为了重构而挪位置"里可以静默丢失，没有任何用例会红。
//
// 观测面选型（两条**互相独立**的通道，每条都自带正控，防恒真假绿）：
//
//	A 编译计数·正控：一次非终态预检必须**恰好**推进 1 个编译任务 —— 没有这条，B 的
//	  `delta == 0` 在"计数器没接线 / 编译入口被换掉 / 走不到 Compiler"时恒真；
//	B 编译计数·主判据：冻结/退役预检推进 **0** 个编译任务（"闸门在编译前"的直接观测）；
//	C 失败形态·正控 + 主判据：载荷 = 参考实现 + 一个 `__picoaide/` 前缀的自定义段。
//	  `wasmmod` 静态校验不看段名（`checkReservedPathPrefix` 只住在 api 包的 prepare 里，
//	  位置在**真编译之后**），所以这个载荷的失败点天然在编译之后。
//	  正控：它在**非终态**应用上必须"先真的编译过一次、再被 ASSET_DENIED 拒"——若哪天
//	  它变成能被静态校验提前拒，正控立刻红，本判据不会悄悄退化成同义反复；
//	  主判据：同一载荷在**终态**应用上必须回与 publish **逐字节同形**的终态错误。
//	  C 完全不依赖 Stats()：即使 A/B 的观测面被绕过，C 仍能区分闸门位置。
//
// 边界（本用例**不**主张的）：30 次/小时的额度**不在**这条判据的保护范围内 ——
// `acquireUpload` 位于闸门**之前**（publish.go 的 validate 里，终态闸门在其后），
// 所以终态应用的预检今天照样消耗一次额度。要钉住额度只能另立判据，且那是行为变更
// （限流语义："试错次数本身就是限流对象"，见 acquireUpload 的 hints），不在本修之内。
func TestValidateTerminalAppsNeverReachCompile(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	// 三个应用：冻结、退役、以及一个**非终态对照**（两条正控都跑在它身上）。
	// 标识刻意不带 frozen/retired 字面量（同 TestValidateAgreesWithPublishOnTerminalApps
	// 的理由：反 oracle 判据按子串扫响应体）。
	e.publishOK(e.tokens["alice"], "ice-seq", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "ash-seq", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "live-seq", "1.0.0", guest, goodConfig())
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/ice-seq/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/ash-seq", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("退役失败: %s", w.Body.String())
	}

	terminal := []struct {
		appID       string
		wantStatus  int
		wantCode    apperr.Code
		wantMessage string
	}{
		{appID: "ice-seq", wantStatus: http.StatusForbidden, wantCode: apperr.CodeAppFrozen,
			wantMessage: "应用已冻结，不能发布新版本"},
		{appID: "ash-seq", wantStatus: http.StatusNotFound, wantCode: apperr.CodeNotFound,
			wantMessage: "应用已退役（已删除）"},
	}

	// ---- A 正控：编译计数必须能被一次**非终态**预检推进 ----
	before := e.compileJobs()
	if w := e.validateRaw(e.tokens["alice"], "live-seq", "2.0.0", guest, goodConfig()); w.Code != http.StatusOK {
		t.Fatalf("正控：非终态预检必须放行，实得 %d %s", w.Code, w.Body.String())
	}
	if got := e.compileJobs() - before; got != 1 {
		t.Fatalf("正控失败：一次非终态预检应恰好推进 1 个编译任务，实得 %d —— 观测面已失效，"+
			"下面 B/C 的『0 次』会退化成恒真假绿", got)
	}

	// ---- B 主判据：终态预检不推进编译计数 ----
	for _, tc := range terminal {
		t.Run("no-compile/"+tc.appID, func(t *testing.T) {
			before := e.compileJobs()
			w := e.validateRaw(e.tokens["alice"], tc.appID, "2.0.0", guest, goodConfig())
			if got := e.compileJobs() - before; got != 0 {
				t.Fatalf("终态应用 %s 的预检触发了 %d 个编译任务：闸门必须在编译之前"+
					"（A-4 的修法收益，复审 F-1）", tc.appID, got)
			}
			// 同时它必须仍是**终态错误** —— 否则"把整条端点关掉/一律报错"也能让上面那条
			// `delta == 0` 变绿。
			if w.Code != tc.wantStatus {
				t.Fatalf("validate status = %d, want %d: %s", w.Code, tc.wantStatus, w.Body.String())
			}
			var eb errBody
			if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
				t.Fatalf("validate 响应不是错误信封: %v; body=%s", err, w.Body.String())
			}
			if eb.Error.Code != string(tc.wantCode) || eb.Error.Message != tc.wantMessage {
				t.Fatalf("validate 错误 = %s/%q, want %s/%q",
					eb.Error.Code, eb.Error.Message, string(tc.wantCode), tc.wantMessage)
			}
		})
	}

	// ---- C 失败形态：失败点在**编译之后**的载荷，在终态应用上必须先回终态错误 ----
	reserved := withCustomSections(t, guest, map[string][]byte{"__picoaide/hijack.txt": []byte("x")})
	beforeC := e.compileJobs()
	cw := e.validateRaw(e.tokens["alice"], "live-seq", "2.0.0", reserved, goodConfig())
	if got := e.compileJobs() - beforeC; got != 1 {
		t.Fatalf("正控失败：保留前缀载荷必须在被拒**之前**真的编译过一次，实得 %d 个编译任务"+
			"（若该载荷已能被静态校验提前拒，本判据会退化成同义反复，须换载荷）", got)
	}
	ceb := e.decodeErr(cw, http.StatusForbidden)
	if ceb.Error.Code != string(apperr.CodeAssetDenied) {
		t.Fatalf("正控失败：保留前缀载荷应停在 prepare 的 C2 闸门（%s），实得 %s: %s",
			apperr.CodeAssetDenied, ceb.Error.Code, cw.Body.String())
	}

	for _, tc := range terminal {
		t.Run("post-compile-payload/"+tc.appID, func(t *testing.T) {
			// 参考信封：真发一次发布（同载荷）。发布侧的终态闸门在解码/编译之前，给出的
			// 就是"闸门在编译前"的权威答复；预检必须与它逐字节同形。
			//
			// 顺序有意：**形态判据先跑**——它是本判据不依赖 Stats() 的那条通道，闸门后置时
			// 必须先由它变红（失败信息里带着"实际回了 ASSET_DENIED"），不能被下面的计数
			// 断言先拦住，否则两条通道的独立性就看不出来了。
			pw := e.publishRawErr(e.tokens["alice"], tc.appID, "2.0.0", reserved, goodConfig())
			before := e.compileJobs()
			vw := e.validateRaw(e.tokens["alice"], tc.appID, "2.0.0", reserved, goodConfig())
			if vw.Code != pw.Code || vw.Body.String() != pw.Body.String() {
				t.Fatalf("终态应用必须**先**回终态错误（编译之前），实际 validate=%d %s / publish=%d %s",
					vw.Code, vw.Body.String(), pw.Code, pw.Body.String())
			}
			if vw.Code != tc.wantStatus {
				t.Fatalf("validate status = %d, want %d", vw.Code, tc.wantStatus)
			}
			if got := e.compileJobs() - before; got != 0 {
				t.Fatalf("终态应用 %s 收到了『编译之后才会失败』的载荷，预检触发了 %d 个编译任务",
					tc.appID, got)
			}
		})
	}
}
