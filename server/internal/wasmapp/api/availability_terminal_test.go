package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// ===========================================================================
// availability 的**终态**判词：冻结 / 退役（R3-A A-4）
// ===========================================================================
//
// 缺陷形态（审计第三轮 A-4）：`availability` 只看"行存在 + 归属"，从不看
// `frozen_at` / `deleted_at`，于是对**已冻结/已退役**的应用回
// `exists=true available=false can_publish=true reason="yours"` ——
// 响应自身就自相矛盾（`available=false` 与 `can_publish=true` 同时为真），
// 而真正提交时 publish 会 403 `APP_FROZEN` / 404 `NOT_FOUND`。
//
// 这个端点的存在理由恰恰是"让注定失败的提交在填表阶段就可见"（见
// availability_test.go 的头部注释）⇒ 它在两种终态上给出相反答案是**契约分叉**：
// 预查说可以、发布被拒。
//
// 修法（本文件钉住的就是它）：`can_publish` 与 publish **共用同一处判据**
// （`publishBlockedReason`），冻结/退役时返回同一个 `*apperr.Error`
// —— 因此 code/message/hints 与 publish 的响应**逐字相同**，并给出可行动的 reason。

// publishErrEnvelope 真发一次发布并返回错误信封（用于与 availability 的判词对拍）。
func (e *testEnv) publishErrEnvelope(token, appID, version string) errBody {
	e.t.Helper()
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", token,
		e.payload(appID, version, testGuestModule(e.t), goodConfig()))
	if w.Code < 400 {
		e.t.Fatalf("预期发布失败，实际 %d %s", w.Code, w.Body.String())
	}
	var eb errBody
	if err := json.Unmarshal(w.Body.Bytes(), &eb); err != nil {
		e.t.Fatalf("响应不是错误信封: %v; body=%s", err, w.Body.String())
	}
	return eb
}

// TestAvailabilityRefusesFrozenAndRetired 是 A-4 的**主判据**。
//
// 红/绿对照（修复前 ⇒ 两组断言都红在 can_publish=true / reason="yours"）。
func TestAvailabilityRefusesFrozenAndRetired(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "frozen-own", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "retired-own", "1.0.0", guest, goodConfig())
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/frozen-own/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/retired-own", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("退役失败: %s", w.Body.String())
	}

	cases := []struct {
		appID      string
		wantReason string
		wantCode   apperr.Code
	}{
		{appID: "frozen-own", wantReason: "frozen", wantCode: apperr.CodeAppFrozen},
		{appID: "retired-own", wantReason: "retired", wantCode: apperr.CodeNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.appID, func(t *testing.T) {
			// 判据 ①：can_publish 必须为 false（"存在性断言冒充能力断言"的修复点）。
			out := e.availability(e.tokens["alice"], tc.appID)
			if out.CanPublish {
				t.Fatalf("%s 是终态，availability 不得说 can_publish=true: %+v", tc.appID, out)
			}
			if out.Available {
				t.Fatalf("%s 的标识被永久占用，available 必须为 false: %+v", tc.appID, out)
			}
			// 判据 ②：reason 必须是**可判别的终态**（不是笼统的 yours / taken）。
			if out.Reason != tc.wantReason {
				t.Fatalf("reason = %q, want %q（终态必须有各自的判词）", out.Reason, tc.wantReason)
			}

			// 判据 ③：与真正提交时的拒绝**逐字同源** —— code 与 message 必须一致。
			// 这条同时是"抽公共函数"的判据：谁在 availability 里另写一份文案，它立刻红。
			pe := e.publishErrEnvelope(e.tokens["alice"], tc.appID, "2.0.0")
			if out.Code != pe.Error.Code {
				t.Fatalf("availability.code = %q，但 publish 回 %q（判据必须同源）", out.Code, pe.Error.Code)
			}
			if out.Code != string(tc.wantCode) {
				t.Fatalf("code = %q, want %q", out.Code, string(tc.wantCode))
			}
			if out.Message == "" || out.Message != pe.Error.Message {
				t.Fatalf("availability.message = %q，publish.message = %q（必须逐字相同）", out.Message, pe.Error.Message)
			}
			// 判据 ④：可行动 —— hints 必须给出去路（解冻 / 新建）。
			if len(out.Hints) == 0 {
				t.Fatalf("%s 的终态判词必须带可行动 hints: %+v", tc.appID, out)
			}
		})
	}
}

// TestAvailabilityStillGreenForNormalStates 是**反向用例**（防过度修复）：
// 空闲标识与"自己的正常应用"必须仍然是 can_publish=true —— 把整条端点变成
// "什么都不许发"也能让主判据变绿，却会直接打断发布流程。
func TestAvailabilityStillGreenForNormalStates(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "healthy-own", "1.0.0", testGuestModule(t), goodConfig())

	if out := e.availability(e.tokens["alice"], "healthy-own"); !out.CanPublish || out.Reason != "yours" {
		t.Fatalf("正常应用（发布者本人）必须 can_publish=true / reason=yours: %+v", out)
	}
	if out := e.availability(e.tokens["alice"], "brand-new-one"); !out.CanPublish || out.Reason != "available" {
		t.Fatalf("空闲标识必须 can_publish=true / reason=available: %+v", out)
	}
	// 下架（未冻结、未退役）**不影响**发布能力：那是发布者自己的独立开关，
	// 不是终态（R37 的三态语义：enabled / frozen / deleted 互相独立）。
	e.req(http.MethodPost, "/api/client/v2/apps/wasm/healthy-own/unpublish", e.tokens["alice"], nil)
	if out := e.availability(e.tokens["alice"], "healthy-own"); !out.CanPublish {
		t.Fatalf("下架不是终态，can_publish 必须仍为 true: %+v", out)
	}
	// 小写归一化后的普通应用，非归属人看到的仍是 taken（不是终态判词）。
	if out := e.availability(e.tokens["bob"], "healthy-own"); out.CanPublish || out.Reason != "taken" {
		t.Fatalf("他人应用必须 can_publish=false / reason=taken: %+v", out)
	}
}
