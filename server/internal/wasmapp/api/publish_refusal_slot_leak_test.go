package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// 本文件是审计 FW-F §6.1 登记的**第二半**缺口的判据（2026-10-04，修复代理 P2）：
//
//	「**拒绝闸门 + `defer ReleaseUpload` 一起挪** ⇒ `inflight` 永久泄漏」
//
// # 缺陷形态（FW-F §6.1 逐字登记）
//
// 三条发布入口（`validate` / `publish` / `uploadComplete`）的拒绝路径都必须"不占编译槽、
// 不烧上传额度、不读请求体"（`publish.go` 的注释把这条写死了）。FW-F 已为"**额度**被吃掉"
// 这一半补了判据（`publish_refusal_position_test.go` 的 ④：请求前后 `used` 不变）。
// 剩下的一半是**并发占位**：若有人把 `acquireUpload` 连同它下面的
// `defer h.opt.Compiler.ReleaseUpload(u.ID)` **一起**挪到拒绝闸门之前、而拒绝的那条
// `return` 落在 `defer` 注册**之前**（= 三条语句被重排成 `acquireUpload` → 拒绝 → `defer`），
// 那么被拒的请求会**永久**留下一个 `inflight`：
//
//   - `used` 已经 +1（既有判据 ④ 会红，这一半不重复发明）；
//   - `inflight` 是 `AllowUpload` 的"同时 1 次编译中"占位（`compile/compiler.go` 的
//     `st.inflight`），只有 `ReleaseUpload` 会减它 ⇒ **占位不还**；
//   - 后果是**用户可见**的：该用户此后**每一次**发布/预检都撞 `st.inflight >= 1` ⇒
//     429 `COMPILE_BUSY`（`writeErrWithRetry` + `Retry-After`），而客户端没有任何自愈路径
//     —— 它只会一直重试同一条被占满的通道。属"一次畸形请求把账号锁死"的形态。
//
// # 为什么既有判据咬不到这一半
//
// `inflight` 在**正常**的两条路径上都被 `defer` 复位（成功路径、以及"闸门仍在
// `acquireUpload` 之前"的拒绝路径）⇒ 在 FW-F 实跑的那一族变异（只挪拒绝闸门，`defer`
// 不动）里"请求返回后 `inflight` 未变"是**恒真**的，所以 FW-F 明确把它降级成诊断信息、
// 不做断言（"不要为了凑三条而写恒真断言"）。本文件的做法不同：**先自校准计量**（成功一次 ⇒
// `used` 必须 +1），再断言"拒绝之后 `inflight` 回到请求前的值"，最后加一条**能力级**判据
// （拒绝之后紧接着一次合法请求必须成功）—— 计数器可能骗人，429 骗不了人。
//
// 判据（三条入口**同形**，每条走"成功 → 拒绝 → 成功"三段）：
//
//	① 成功一次 ⇒ `used` +1（**自校准**：计量真的会动，否则后面两条是恒真断言）；
//	② 极小声明预算被拒（504 结构化结论）⇒ `used` 不变（既有覆盖面）**且 `inflight` 回到
//	   请求前的值**（本判据的覆盖面：泄漏检测）；
//	③ 紧接着一次合法请求仍必须**成功**（能力级后果：槽位真的还回去了；泄漏形态下这里是
//	   429 `COMPILE_BUSY`）。
//
// 变异验证（实跑见交付报告 temp/audit-v282/fixes/P2.md）：把任一条入口的三条语句重排成
// `acquireUpload` → 拒绝闸门 → `defer ReleaseUpload` ⇒ 该入口的子用例 ②③ 同时红
// （`used` 那一半也会红，与既有判据 ④ 重叠 —— 重叠是有意的：同一族两个观测面各自独立成立）。
func TestBudgetRefusalLeavesNoCompileSlotLeaked(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 声明 1 s：不足传输余量（`limits.PublishTransferReserve` = 15 s）⇒ 有效预算 0
	// ⇒ 入口立刻给结构化结论（`publishBudgetRefusal`）。
	const tinyBudget = "1000"

	env := newUploadEnv(t)
	wasm := testGuestModule(t)
	cfg := goodConfig()
	token := env.tokens["alice"]
	alice := env.ids["alice"]

	// 自校准：`UploadState` 的 `used` 真的会随成功请求 +1（否则"不变"的断言是恒真）。
	// 同时确认起点 `inflight == 0`（每个用例一份独立 PG 库 + 独立 Compiler ⇒ 起点干净）。
	state := func() (used, inflight int) { return env.compiler.UploadState(alice, time.Now()) }
	if used, inflight := state(); used != 0 || inflight != 0 {
		t.Fatalf("起点计量不干净：used=%d inflight=%d（want 0/0）", used, inflight)
	}

	// drive 跑"成功 → 拒绝 → 成功"三段；`ok(n)` 的第 n 次成功请求必须用**不同的应用/版本**，
	// 避免撞名（NAME_TAKEN）或撞会话。
	drive := func(t *testing.T, name string, ok func(t *testing.T, n int), refuse func(t *testing.T)) {
		t.Helper()
		used0, inflight0 := state()

		// ① 成功一次：自校准（计量真的会动）+ 确认成功路径会还槽。
		ok(t, 1)
		used1, inflight1 := state()
		if used1 != used0+1 {
			t.Fatalf("[%s] 自校准失败：一次成功请求之后 used %d → %d（want +1）——"+
				"量具坏了 ⇒ 本用例的额度断言会退化成恒真", name, used0, used1)
		}
		if inflight1 != inflight0 {
			t.Fatalf("[%s] 成功路径没有释放并发占位：inflight %d → %d", name, inflight0, inflight1)
		}

		// ② 极小声明预算 ⇒ 入口拒绝（结构化 504）。
		refuse(t)
		used2, inflight2 := state()
		if used2 != used1 {
			t.Errorf("[%s] 拒绝吃掉了上传小时额度：used %d → %d —— 拒绝闸门排在了 `acquireUpload` 之后"+
				"（该计数按设计**不回退**，只能等一小时窗口滑出）", name, used1, used2)
		}
		if inflight2 != inflight0 {
			t.Errorf("[%s] 拒绝**永久泄漏**了编译槽：inflight %d → %d（请求前 = %d）——"+
				"并发占位不还 ⇒ 该用户此后每一次发布/预检都会撞「同时 1 次编译中」并拿 429 COMPILE_BUSY，"+
				"而客户端没有自愈路径。修法：`defer h.opt.Compiler.ReleaseUpload(u.ID)` 必须排在"+
				"**所有** `return` 之前（或把拒绝闸门挪回 `acquireUpload` 之前）",
				name, inflight0, inflight2, inflight0)
		}

		// ③ 能力级：紧接着一次合法请求必须成功（槽位真的还回去了）。
		ok(t, 2)
		used3, inflight3 := state()
		if used3 != used2+1 {
			t.Errorf("[%s] 拒绝之后的合法请求之后 used %d → %d（want +1）", name, used2, used3)
		}
		if inflight3 != inflight0 {
			t.Errorf("[%s] 连着两次成功之后 inflight = %d, want %d", name, inflight3, inflight0)
		}
	}

	// ---- validate：拒绝闸门在 publishGate/currentUser 之后、acquireUpload 之前 ----
	t.Run("validate", func(t *testing.T) {
		ok := func(t *testing.T, n int) {
			t.Helper()
			app := "leak-validate-" + strconv.Itoa(n)
			w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", token,
				env.payload(app, "1.0.0", wasm, cfg))
			if w.Code != http.StatusOK {
				t.Fatalf("validate 应 200：%d %s（若有 429 COMPILE_BUSY：上一次拒绝泄漏了编译槽）"+
					"—— 这是用户可见后果，不是判据噪音", w.Code, w.Body.String())
			}
		}
		refuse := func(t *testing.T) {
			t.Helper()
			w := env.reqWithBudget(http.MethodPost, "/api/client/v2/apps/wasm/validate", token,
				env.payload("leak-validate-refuse", "1.0.0", wasm, cfg), tinyBudget)
			assertBudgetRefusal(t, w, "validate")
		}
		drive(t, "validate", ok, refuse)
	})

	// ---- publish：同一条位置纪律（拒绝闸门在 acquireUpload 之前）----
	t.Run("publish", func(t *testing.T) {
		ok := func(t *testing.T, n int) {
			t.Helper()
			app := "leak-publish-" + strconv.Itoa(n)
			w := env.req(http.MethodPost, "/api/client/v2/apps/wasm/"+app+"/releases", token,
				env.payload(app, "1.0.0", wasm, cfg))
			if w.Code != http.StatusCreated {
				t.Fatalf("publish 应 201：%d %s（若有 429 COMPILE_BUSY：上一次拒绝泄漏了编译槽）",
					w.Code, w.Body.String())
			}
		}
		refuse := func(t *testing.T) {
			t.Helper()
			w := env.reqWithBudget(http.MethodPost, "/api/client/v2/apps/wasm/leak-publish-refuse/releases", token,
				env.payload("leak-publish-refuse", "1.0.0", wasm, cfg), tinyBudget)
			assertBudgetRefusal(t, w, "publish")
		}
		drive(t, "publish", ok, refuse)
	})

	// ---- uploadComplete：这一条最容易泄漏（拒绝闸门之前还有重放缓存与 complete 租约）
	t.Run("uploadComplete", func(t *testing.T) {
		ok := func(t *testing.T, n int) {
			t.Helper()
			app := "leak-complete-" + strconv.Itoa(n)
			chunk, parts := planThree(t, wasm)
			sess := env.createUpload(token, app, "1.0.0", int64(len(wasm)), chunk)
			for i, part := range parts {
				env.putChunk(token, sess.UploadID, i, part)
			}
			w := env.req(http.MethodPost, completePath(sess.UploadID), token, completeBody("槽位不泄漏", cfg))
			if w.Code != http.StatusCreated {
				t.Fatalf("complete 应 201：%d %s（若有 429 COMPILE_BUSY：上一次拒绝泄漏了编译槽）",
					w.Code, w.Body.String())
			}
		}
		refuse := func(t *testing.T) {
			t.Helper()
			// 拒绝请求必须落在**真实可用**的会话上：这样"拒绝闸门被挪到 `acquireUpload` 之后"
			// 的变异体仍会走到闸门并给 504（而不是先在会话反查上变成 404，让红的原因变成别的）。
			chunk, parts := planThree(t, wasm)
			sess := env.createUpload(token, "leak-complete-refuse", "1.0.0", int64(len(wasm)), chunk)
			for i, part := range parts {
				env.putChunk(token, sess.UploadID, i, part)
			}
			w := env.completeWithBudget(t, token, sess.UploadID, tinyBudget, completeBody("拒绝", cfg), 0)
			assertBudgetRefusal(t, w, "uploadComplete")
		}
		drive(t, "uploadComplete", ok, refuse)
	})
}

// assertBudgetRefusal 断言"入口拒绝"的信封形态（与三个入口的既有判据同形；只做必要校验，
// 位置/耗时/读体那几条由 publish_refusal_position_test.go 与 publish_client_budget_test.go 覆盖）。
func assertBudgetRefusal(t *testing.T, w *httptest.ResponseRecorder, entry string) {
	t.Helper()
	if w.Code != http.StatusGatewayTimeout {
		t.Fatalf("[%s] 极小声明预算的请求 = %d（%s），want 504 结构化预算结论"+
			"（前置条件：拒绝闸门在入口、声明 < 传输余量）", entry, w.Code, w.Body.String())
	}
	var eb errBody
	if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
		t.Fatalf("[%s] 响应不是 JSON 错误信封: %v; body=%s", entry, err, w.Body.String())
	}
	if eb.Error.Details["phase"] != "publish_budget" {
		t.Fatalf("[%s] details.phase = %v, want publish_budget（结论必须说明是预算而不是别的失败）: %s",
			entry, eb.Error.Details["phase"], w.Body.String())
	}
}

// reqWithBudget 发一个带 `ClientBudgetHeader` 的 JSON 请求（与 `env.req` 同一条序列化路径）。
//
// 放在本文件（拒绝路径判据的集中地）：`publish_complete_replay_test.go` 用
// `completeWithBudget`（既有的、带"慢请求体"能力的夹具），本文件需要的是**任意入口**都能
// 带这个头的最小夹具。
func (e *testEnv) reqWithBudget(method, path, token string, body any, budget string) *httptest.ResponseRecorder {
	e.t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(replayJSON(e.t, body)))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	req.Header.Set(ClientBudgetHeader, budget)
	w := httptest.NewRecorder()
	e.r.ServeHTTP(w, req)
	return w
}
