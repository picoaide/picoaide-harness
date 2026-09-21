package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// ===========================================================================
// 应用标识唯一性预查：GET /apps/wasm/:app_id/availability
// ===========================================================================
//
// 这条端点回答**一个**问题："我现在能用这个 app_id 吗？"——发布表单在用户
// 敲字时异步问它（不占版本号、不编译、不写盘），提交前再问一次。
//
// 为什么不能拿目录（`catalog`）当答案（本文件最主要的一组用例）：
// 目录**故意**不列冻结应用、也不列"占名但从未发布成功"的行，而这两类都实打实
// 占着标识（R6/§4.1："发布即占名…被拒/软删也不释放"）。用目录判唯一性会给出
// "这个标识没人用"的**反向**结论，用户填完一整个 32 MiB 的包才在最后一步拿到
// 409 —— 这正是本端点要消灭的形态。

// availabilityOut 是端点响应体（字段名是跨端契约：客户端 PublishForm 按它渲染）。
type availabilityOut struct {
	AppID      string   `json:"app_id"`
	Valid      bool     `json:"valid"`
	Available  bool     `json:"available"`
	OwnedByYou bool     `json:"owned_by_you"`
	Exists     bool     `json:"exists"`
	Reason     string   `json:"reason"`
	Code       string   `json:"code"`
	Message    string   `json:"message"`
	Hints      []string `json:"hints"`
}

func (e *testEnv) availability(token, appID string) availabilityOut {
	e.t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/"+appID+"/availability", token, nil)
	var out availabilityOut
	e.decodeJSON(w, http.StatusOK, &out)
	return out
}

// TestAvailabilityReportsTakenByOthersWithoutLeakingOwner 覆盖"名字被别人占了"：
// 必须给出与发布同码的 NAME_TAKEN，且**不得**回显是谁占的、叫什么内容
// （docs/07 §"明确告知占用关系,不泄露是谁/什么内容"）。
func TestAvailabilityReportsTakenByOthersWithoutLeakingOwner(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "taken-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/taken-tool/availability", e.tokens["bob"], nil)
	var out availabilityOut
	e.decodeJSON(w, http.StatusOK, &out)

	if out.Available {
		t.Fatalf("他人已发布的名字不得报 available: %+v", out)
	}
	if out.OwnedByYou {
		t.Fatalf("bob 不是 taken-tool 的发布者: %+v", out)
	}
	if out.Reason != "taken" {
		t.Fatalf("reason = %q, want taken", out.Reason)
	}
	// 与发布路径**同码**：客户端因此可以对两条链路用同一个分支渲染。
	if out.Code != string(apperr.CodeNameTaken) {
		t.Fatalf("code = %q, want %q（与 publish 的 409 同码）", out.Code, string(apperr.CodeNameTaken))
	}
	if out.Exists != true {
		t.Fatalf("exists = false，但这一行确实在库里: %+v", out)
	}
	// 不泄露归属：响应体里不得出现发布者的用户名或标题。
	body := w.Body.String()
	for _, secret := range []string{"alice", "Alice"} {
		if strings.Contains(body, secret) {
			t.Fatalf("响应体泄露了归属人 %q: %s", secret, body)
		}
	}
}

// TestAvailabilityCountsFrozenAndOfflineAsTaken 是本端点存在的**主要理由**：
// 目录不列冻结/占名行，但它俩都占着标识。目录回答不了的问题必须由这里回答。
func TestAvailabilityCountsFrozenAndOfflineAsTaken(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "frozen-tool", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "offline-tool", "1.0.0", guest, goodConfig())
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/frozen-tool/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/offline-tool/unpublish", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("下架失败: %s", w.Body.String())
	}

	// 先钉住前提：目录里确实**看不到** frozen-tool（否则这组用例没有判别力）。
	var catalog struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", e.tokens["bob"], nil), http.StatusOK, &catalog)
	for _, a := range catalog.Apps {
		if a["app_id"] == "frozen-tool" {
			t.Fatalf("前提不成立：冻结应用不该出现在目录里（用例失去判别力）")
		}
	}

	for _, appID := range []string{"frozen-tool", "offline-tool"} {
		out := e.availability(e.tokens["bob"], appID)
		if out.Available || out.Reason != "taken" {
			t.Fatalf("%s 仍占名，但 availability 说可用: %+v", appID, out)
		}
	}
}

// TestAvailabilityRecognisesOwnApp 覆盖"自己的应用发新版"：标识当然不 available，
// 但必须告诉调用方"这是你的"，否则发布表单会把正常的新版发布拦下来。
func TestAvailabilityRecognisesOwnApp(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "my-tool", "1.0.0", testGuestModule(t), goodConfig())

	out := e.availability(e.tokens["alice"], "my-tool")
	if out.Available {
		t.Fatalf("自己的应用标识同样不空闲: %+v", out)
	}
	if !out.OwnedByYou {
		t.Fatalf("发布者本人必须拿到 owned_by_you=true（否则发新版被误拦）: %+v", out)
	}
	if out.Reason != "yours" {
		t.Fatalf("reason = %q, want yours", out.Reason)
	}
}

// TestAvailabilityReportsFreeName 覆盖空闲标识：available=true，且不带任何错误码。
func TestAvailabilityReportsFreeName(t *testing.T) {
	e := newTestEnv(t)
	out := e.availability(e.tokens["alice"], "brand-new-tool")
	if !out.Available || !out.Valid || out.Exists {
		t.Fatalf("空闲标识应 available=true/valid=true/exists=false: %+v", out)
	}
	if out.Reason != "available" {
		t.Fatalf("reason = %q, want available", out.Reason)
	}
	if out.Code != "" {
		t.Fatalf("空闲标识不该带错误码: %+v", out)
	}
}

// TestAvailabilityAnswersInvalidAsVerdictNotAsError 是**刻意的形态选择**：
// "这个名字非法"是对"能不能用"的正常回答，不是一次失败的请求 —— 因此 200 +
// 结构化判词（valid=false，且 available 恒为 false 的 fail-closed 方向），
// 而不是 400。客户端因此只有一条解析路径，不必为"查重失败"再写一套错误处理。
func TestAvailabilityAnswersInvalidAsVerdictNotAsError(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	// 占用一个合法的，确保"invalid"不是被"占名"顺带染上的。
	e.publishOK(e.tokens["alice"], "occupied-tool", "1.0.0", guest, goodConfig())

	for _, tc := range []struct {
		name  string
		appID string
	}{
		{"大写（平台不做静默小写）", "Uppercase-Tool"},
		{"下划线非法", "under_score"},
		{"纯数字", "12345"},
		{"punycode 前缀", "xn--fiqs8s"},
		{"平台保留字", "admin"},
	} {
		out := e.availability(e.tokens["alice"], tc.appID)
		if out.Valid {
			t.Fatalf("%s：%q 应判 valid=false: %+v", tc.name, tc.appID, out)
		}
		if out.Available {
			// fail-closed：非法名字绝不能报"可用"，否则表单会放行一次注定失败的发布。
			t.Fatalf("%s：非法名字必须 available=false（fail-closed）: %+v", tc.name, out)
		}
		if out.Reason != "invalid" {
			t.Fatalf("%s：reason = %q, want invalid", tc.name, out.Reason)
		}
		if out.Code != string(apperr.CodeInvalidAppID) {
			t.Fatalf("%s：code = %q, want %q", tc.name, out.Code, string(apperr.CodeInvalidAppID))
		}
		if out.Message == "" {
			t.Fatalf("%s：非法判定必须带可读原因", tc.name)
		}
		if len(out.Hints) == 0 {
			t.Fatalf("%s：非法判定必须带 hints（第一消费者是 AI 与表单提示）", tc.name)
		}
	}
}

// TestAvailabilityRequiresLogin：查重是员工面端点，未登录不得回答
// （否则它就成了一个免费的"标识是否被占用"探测器）。
func TestAvailabilityRequiresLogin(t *testing.T) {
	e := newTestEnv(t)
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/whatever/availability", "", nil)
	if w.Code == http.StatusOK {
		t.Fatalf("未登录不得拿到查重结论: %d %s", w.Code, w.Body.String())
	}
}
