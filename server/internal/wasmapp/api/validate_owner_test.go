// A-2（2026-09-23 R3-A 审计，P1）的回归用例：`wasm/validate` 的归属校验。
//
// 修复前的现场：任意已登录员工用一个**只带 app_id 的最简载荷**调 validate，就能读回
// 他人应用的**生效配置**（继承基线被原样回显在 `validation.config`）——`whitelist`
// 准入名单、`purpose`、`data_sensitivity`、`owner`、`sensitive_columns` —— 外加一个
// `first_release` 存在性 oracle。
//
// 判据（三条，缺一条都不算闭合）：
//
//	① 非归属人 ⇒ 404 NOT_FOUND，响应体里**一个字节**的配置内容都没有；
//	② 该 404 与**同族只读端点**（owner-only 的 `/schema`）对同一应用给出的
//	   "不存在/不是你的" 404 **逐字节相同** ⇒ 外人无法用响应差异探测归属；
//	③ 反向用例：归属人自己、首版新标识、管理员兜底都**照旧可用**（不过度修复）。
//
// 变异验证（实跑对照见交付报告）：
//   - 删掉 `validate` 里的 `checkValidateOwner` 调用 ⇒ 本文件第 ① 条红（读到 whitelist）；
//   - 把 `checkValidateOwner` 的拒绝改成 `checkOwner`（409 NAME_TAKEN）⇒ 第 ① 条红
//     （status 409 ≠ 404）；
//   - 让拒绝分支回显"存在但非归属"的不同文案/不同 code ⇒ 第 ② 条红。
package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// foreignSecretConfig 是"别人应用里本不该外泄"的全部字段（A-2 列举的清单）。
func foreignSecretConfig() map[string]any {
	return map[string]any{
		"access":            "whitelist",
		"whitelist":         []string{"alice", "carol"},
		"purpose":           "财务对账（涉密用途说明）",
		"data_sensitivity":  "confidential",
		"owner":             "张伟",
		"sensitive_columns": []string{"bonus_amount"},
	}
}

// foreignSecretMarkers 是响应体里一旦出现就说明泄露了的字面量。
var foreignSecretMarkers = []string{
	"whitelist", "carol", "confidential", "bonus_amount", "张伟", "财务对账",
	// first_release 是版本数 oracle：非归属人连"这个应用有没有版本"都不该知道。
	"first_release", "validation",
}

// TestValidateRejectsForeignAppWithoutLeakingConfig 覆盖判据 ①②。
func TestValidateRejectsForeignAppWithoutLeakingConfig(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "secret-tool", "1.0.0", guest, foreignSecretConfig())

	auditBefore := e.countAudit()
	releasesBefore := e.countReleases("secret-tool")

	// 最简载荷：app_id + 制品 + 一个字段的 config —— 修复前它足够换回他人生效配置的
	// **其余全部字段**（缺席字段从他人应用的生效版本继承过来再原样回显）。
	p := e.payload("secret-tool", "1.1.0", guest, map[string]any{"access": "whitelist"})
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["bob"], p)

	eb := e.decodeErr(w, http.StatusNotFound)
	if eb.Error.Code != "NOT_FOUND" {
		t.Fatalf("非归属人应拿到 NOT_FOUND，实得 %s: %s", eb.Error.Code, w.Body.String())
	}
	body := w.Body.String()
	for _, marker := range foreignSecretMarkers {
		if strings.Contains(body, marker) {
			t.Fatalf("validate 的回绝对非归属人泄露了 %q：%s", marker, body)
		}
	}
	// 拒绝必须发生在任何实际工作之前：不落审计、不落版本行。
	if after := e.countAudit(); after != auditBefore {
		t.Fatalf("被拒的预检不得写审计：before=%d after=%d", auditBefore, after)
	}
	if after := e.countReleases("secret-tool"); after != releasesBefore {
		t.Fatalf("被拒的预检不得落版本行：before=%d after=%d", releasesBefore, after)
	}

	// ② 与同族 owner-only 只读端点的 404 逐字节同形（同一应用、同一调用者）。
	ownerOnly := e.req(http.MethodGet, "/api/client/v2/apps/wasm/secret-tool/schema", e.tokens["bob"], nil)
	if ownerOnly.Code != http.StatusNotFound {
		t.Fatalf("对照端点应 404，实得 %d: %s", ownerOnly.Code, ownerOnly.Body.String())
	}
	if got, want := body, ownerOnly.Body.String(); got != want {
		t.Fatalf("validate 的 404 与同族 owner-only 404 不同形（可用响应差异探测归属）：\n validate=%s\n schema  =%s", got, want)
	}

	// 同一份 404 与"应用真的不存在"的 404 在除 app_id 之外**完全一致**。
	ghost := e.req(http.MethodGet, "/api/client/v2/apps/wasm/ghost-tool/schema", e.tokens["bob"], nil)
	ghostBody := e.decodeErr(ghost, http.StatusNotFound)
	if ghostBody.Error.Code != eb.Error.Code || ghostBody.Error.Message != eb.Error.Message {
		t.Fatalf("不存在与不属于你必须同码同文案：%+v vs %+v", ghostBody.Error, eb.Error)
	}
	if strings.Join(ghostBody.Error.Hints, "|") != strings.Join(eb.Error.Hints, "|") {
		t.Fatalf("不存在与不属于你必须同 hints：%v vs %v", ghostBody.Error.Hints, eb.Error.Hints)
	}
	if len(eb.Error.Details) != 1 || eb.Error.Details["app_id"] != "secret-tool" {
		t.Fatalf("404 的 details 只允许回显调用者自己给的 app_id，实得 %v", eb.Error.Details)
	}
}

// TestValidateOwnerPathStillWorks 是判据 ③（**反向用例**，防过度修复）：
// 归属人、管理员兜底、首版新标识三条合法路径都不受影响，且归属人的继承基线照旧回显。
func TestValidateOwnerPathStillWorks(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "mine-tool", "1.0.0", guest, foreignSecretConfig())

	type validationOut struct {
		Validation struct {
			AppID        string          `json:"app_id"`
			OK           bool            `json:"ok"`
			FirstRelease bool            `json:"first_release"`
			Config       json.RawMessage `json:"config"`
		} `json:"validation"`
	}

	// ③-1 归属人自己：预检通过，且继承基线（whitelist 名单）**照旧**回显给自己。
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"],
		e.payload("mine-tool", "1.1.0", guest, map[string]any{"access": "whitelist"}))
	var owner validationOut
	e.decodeJSON(w, http.StatusOK, &owner)
	if !owner.Validation.OK || owner.Validation.FirstRelease {
		t.Fatalf("归属人预检应通过且 first_release=false: %+v", owner.Validation)
	}
	if !strings.Contains(string(owner.Validation.Config), `"carol"`) {
		t.Fatalf("归属人必须仍能拿到继承基线（否则作者看不到自己应用的生效配置）：%s", owner.Validation.Config)
	}

	// ③-2 管理员兜底接管（与 checkOwner/ownedApp 同一判据）。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["boss"],
		e.payload("mine-tool", "1.2.0", guest, map[string]any{"access": "whitelist"})); w.Code != http.StatusOK {
		t.Fatalf("管理员应能预检他人应用（R23 兜底），实得 %d: %s", w.Code, w.Body.String())
	}

	// ③-3 首版新标识：没有 apps 行 ⇒ 放行，first_release=true（validate 的主要用途）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["bob"],
		e.payload("fresh-tool", "1.0.0", guest, goodConfig()))
	var fresh validationOut
	e.decodeJSON(w, http.StatusOK, &fresh)
	if !fresh.Validation.OK || !fresh.Validation.FirstRelease {
		t.Fatalf("首版新标识必须照旧可预检: %+v", fresh.Validation)
	}
}
