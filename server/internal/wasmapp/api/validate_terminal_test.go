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
// 变异验证（实跑对照见交付报告）：
//   - 删掉 `validate` 里新加的 `publishBlockOf` 闸门 ⇒ ① 两条子用例红
//     （validate 回 200 `ok:true`，与 publish 的 403/404 不同形）；
//   - 把闸门挪到 `isFirstRelease`/`prepare` **之后** ⇒ ① 仍绿但④的"不消耗资源"面
//     失去意义（本轮不以此为判据，位置由注释与 ④ 的版本/审计计数间接钉住）；
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
