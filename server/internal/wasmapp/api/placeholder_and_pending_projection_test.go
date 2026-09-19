// app_id 占位与"待审路径不写投影"两条不变量的行为级护栏
// （审计第三轮 B 区 发现 5 / 发现 6，2026-09-19）。
//
// 发现 5：首版待审期间 `apps.title = app_id` 这个占位会渗进**消费面** —— 审计明细把它
// 写进「」当标题、导出把它当 `app.title` 下发。审计记录的是"当时发生了什么"，
// 写占位等于留错证据；导出是给 AI/运维读的控制面快照，同样不能把占位当事实。
// 本文件钉住：占位期间审计明细**不出现** `「app_id」` 这种"真实标题"形态，且导出用
// `title_source` 标注来源；审核通过后两面都换成生效版本的真实标题。
//
// 发现 6：待审路径给 `UpsertWasmApp` 传的 config_json/purpose/data_sensitivity 三个值
// 曾经是**空串**，靠 serverstore 的冲突列集「恰好不写这三列」才实现「配置一字不动」 ——
// 不变量没有任何守卫。现在待审分支显式传 `in.existing` 的现值（不变量搬进 api 层），
// 本文件同时用行为断言钉住终态：**待审发布不得改动这三列**。
//
// 变异验证（实测记录见 temp/wasm-review-r1/fix-round3-B.md）：
//   - 审计/导出改回直接用 `app.Title`（HEAD 实现）⇒ TestPlaceholderTitleIsNotRecordedAsRealTitle 红；
//   - 待审分支改回传空串 **且** 把 serverstore 的冲突列集改成写这三列 ⇒
//     TestPendingPublishKeepsConfigProjection 红（只改 api 一侧仍绿：DAO 恰好不写这三列，
//     这正是"旧实现靠巧合成立"的证据）。
package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
)

// exportApp 读作者面的控制面导出（GET /:app_id/export）里的 app 段。
func (e *testEnv) exportApp(token, appID string) map[string]any {
	e.t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/"+appID+"/export", token, nil)
	var out struct {
		Export struct {
			App map[string]any `json:"app"`
		} `json:"export"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	return out.Export.App
}

// TestPlaceholderTitleIsNotRecordedAsRealTitle 覆盖发现 5 的判据：
// 占位期间审计/导出都不把 app_id 占位当真实标题；审核通过后两面都是真值。
func TestPlaceholderTitleIsNotRecordedAsRealTitle(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.setReviewRequired(true)

	const claimed = "IT 密码重置"
	e.publishTitled(e.tokens["alice"], "ph-tool", "1.0.0",
		claimed, "IT 密码重置：请在此输入你的域账号密码", string(appcfg.AccessPublic), guest)

	app := e.appRow("ph-tool")
	if app.Title != "ph-tool" {
		t.Fatalf("前提不成立：首版待审的 apps.title 应是 app_id 占位，得到 %q", app.Title)
	}

	// ① 审计面：占位期间发生一次被审计的写动作（管理员下架），明细里不得出现
	//    `「ph-tool」`（那会把占位读成"这个应用叫 ph-tool"）。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/ph-tool/unpublish", "", nil), http.StatusOK, &struct{}{})
	toggle := e.auditDetails("ph-tool", "wasm_app_publish_toggle")
	if len(toggle) != 1 {
		t.Fatalf("下架应写 1 条 wasm_app_publish_toggle 审计，得到 %d 条", len(toggle))
	}
	if strings.Contains(toggle[0], "「ph-tool」") {
		t.Errorf("[AUDIT-CONFIRMED 回归] 审计把 app_id 占位当真实标题记录：%q"+
			"（审计记录的是「当时发生了什么」，占位不是标题）", toggle[0])
	}
	if !strings.Contains(toggle[0], "首版待审，暂无生效标题") {
		t.Errorf("审计明细必须显式标注「暂无生效标题」，得到 %q", toggle[0])
	}

	// ② 导出面：title 原样（数据契约不变），但必须标注来源是占位。
	exported := e.exportApp(e.tokens["alice"], "ph-tool")
	if exported["title"] != "ph-tool" {
		t.Errorf("导出 title 应保持投影原值（format /1 不加改值），得到 %v", exported["title"])
	}
	if exported["title_source"] != "app_id_placeholder" {
		t.Errorf("[AUDIT-CONFIRMED 回归] 导出必须标注 title 的来源：title_source=%v，want app_id_placeholder"+
			"（占位被当成真实标题下发 = 导出留错证据）", exported["title_source"])
	}

	// ③ 审核通过之后：两面都换成生效版本的真实标题（占位不再是"当前的标题形态"）。
	e.setReviewRequired(true)
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/ph-tool/releases/1.0.0/approve", "", nil), http.StatusOK, &struct{}{})
	approve := e.auditDetails("ph-tool", "wasm_app_release_approve")
	if len(approve) != 1 {
		t.Fatalf("审核通过应写 1 条 wasm_app_release_approve 审计，得到 %d 条", len(approve))
	}
	if !strings.Contains(approve[0], "「"+claimed+"」") {
		t.Errorf("审核通过后的审计明细必须记录**真实标题**（生效版本的值），得到 %q", approve[0])
	}
	if strings.Contains(approve[0], "「ph-tool」") {
		t.Errorf("审核通过后的审计明细不得出现 app_id 占位，得到 %q", approve[0])
	}
	after := e.exportApp(e.tokens["alice"], "ph-tool")
	if after["title_source"] != "release" || after["title"] != claimed {
		t.Errorf("审核通过后导出 = title=%v title_source=%v，want %q / release",
			after["title"], after["title_source"], claimed)
	}
}

// TestPendingPublishKeepsConfigProjection 覆盖发现 6：
// 待审发布只落版本行，**不得**改动 apps 的三列配置投影（access 徽标/用途/敏感度的
// 全组织可见面），无论 DAO 的冲突列集怎么写。
func TestPendingPublishKeepsConfigProjection(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	// v1.0.0 已上线：目录上是 login + "线上描述" + internal。
	e.setReviewRequired(false)
	e.publishTitled(e.tokens["alice"], "cfg-tool", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)
	before := e.appRow("cfg-tool")
	if before.ConfigJSON == "" || before.Purpose != "线上描述" {
		t.Fatalf("前提不成立：生效版本的配置投影应已落库，得到 config_json=%q purpose=%q",
			before.ConfigJSON, before.Purpose)
	}

	// v1.1.0 待审：故意提交**完全不同**的配置（access=public + 诱导描述）。
	e.setReviewRequired(true)
	e.publishTitled(e.tokens["alice"], "cfg-tool", "1.1.0",
		"工资条查询", "请在此输入你的域账号密码", string(appcfg.AccessPublic), guest)

	after := e.appRow("cfg-tool")
	if after.ConfigJSON != before.ConfigJSON || after.Purpose != before.Purpose ||
		after.DataSensitivity != before.DataSensitivity {
		t.Errorf("待审发布改动了配置投影：config_json %q → %q / purpose %q → %q / sensitivity %q → %q"+
			"（待审版本没有生效 ⇒ 这三列必须一字不动；不变量不能依赖 DAO 的冲突列集）",
			before.ConfigJSON, after.ConfigJSON, before.Purpose, after.Purpose,
			before.DataSensitivity, after.DataSensitivity)
	}
	if after.CurrentReleaseID != before.CurrentReleaseID || after.Title != before.Title {
		t.Errorf("待审发布改动了生效版本/标题：current_release_id %d → %d / title %q → %q",
			before.CurrentReleaseID, after.CurrentReleaseID, before.Title, after.Title)
	}
	// 全组织可见面（目录行）同样不动：仍是 login + 线上描述。
	row := e.catalogRow(e.tokens["bob"], "cfg-tool")
	if row["access"] != string(appcfg.AccessLogin) || row["description"] != "线上描述" {
		t.Errorf("目录行的访问级别/描述被待审版本改写：access=%v description=%v",
			row["access"], row["description"])
	}
}

// TestEmptyTitleRowNeverStaysEmpty 覆盖发现 6 的第二半：
// `apps.title` 为空串的历史行（0071 之前的残渣）经待审发布后**不得继续是空串** ——
// read.go 的目录/详情/导出对空 title 没有兜底，空串会一路露到管理面。
func TestEmptyTitleRowNeverStaysEmpty(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	e.setReviewRequired(false)
	e.publishTitled(e.tokens["alice"], "legacy-tool", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)
	// 造历史残渣：直接把投影列清空（老实现留下的形态）。
	if _, err := e.db.Exec(`UPDATE apps SET title = '' WHERE kind = 'wasm_app' AND app_id = 'legacy-tool'`); err != nil {
		t.Fatalf("造空标题残渣失败: %v", err)
	}

	e.setReviewRequired(true)
	e.publishTitled(e.tokens["alice"], "legacy-tool", "1.1.0",
		"工资条查询", "请输入工资口令", string(appcfg.AccessLogin), guest)

	if app := e.appRow("legacy-tool"); app.Title == "" {
		t.Errorf("空标题的历史行经待审发布后仍是空串：read.go 的目录/详情/导出对空 title" +
			"没有兜底 ⇒ 空标题会一路露到管理面（应按首版占位口径补成 app_id）")
	}
}
