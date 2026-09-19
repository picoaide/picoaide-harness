// 审核端点的"请重试一次"必须真的可重试（审计第三轮 B 区 CONFIRMED，2026-09-19）。
//
// 现场：reviewRelease 的三步写入是顺序、非事务的 ——
//
//	① SetReleaseStatusForReview（状态落库，不可回滚）
//	② 投影重算（SetWasmAppCurrentRelease / SetWasmAppConfig / SetWasmAppDisplay）
//
// ②任一步失败时端点回 500「审核结果已落库，但…更新失败（请重试一次）」。但重试时版本
// 行**已经是终态** —— 老实现命中幂等早退分支直接 200 `changed=false`，一次都不再跑投影，
// 于是目录标题/描述/生效版本永久停在旧值（首版待审则永远顶着 app_id 占位）；而那条早退
// 的注释还写着"重复调用本端点幂等（会再走一次投影同步）"—— 与实现相反。
//
// 本文件把"①成功、②没跑"的部分完成态**用生产 DAO 造出来**（不是手写 SQL，也不是让
// UPDATE 失败），然后照端点的错误提示重试，钉住三件事：
//
//	① 重试 ⇒ 200 且**投影被补齐**（apps 行 + 员工面目录行 + 生效版本，全部追上版本行）；
//	② 重试不产生副作用：不再写审计（approve/reject 各只一条），再调一次连一行都不写；
//	③ reject 路径同样能自愈（被拒版本从未生效 ⇒ 投影回到仍在生效的那一版）。
//
// 变异验证（改回旧实现必红）：把终态分支改回"直接 200 早退、不调 syncAppProjection"
// ⇒ TestApproveRetryRepairsProjection / TestRejectRetryRepairsProjection 的投影断言红。
package api

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
)

// approveCount / rejectCount 统计某应用的审核审计条数（重试不得再写一条）。
func (e *testEnv) reviewAuditCount(appID, action string) int {
	e.t.Helper()
	return len(e.auditDetails(appID, action))
}

// TestApproveRetryRepairsProjection 覆盖判据 ①②。
func TestApproveRetryRepairsProjection(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	// v1.0.0 已上线（审核关着 ⇒ 直接 approved），目录上是"报销助手"。
	e.setReviewRequired(false)
	e.publishTitled(e.tokens["alice"], "retry-tool", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)
	e.setReviewRequired(true)
	// v1.1.0 待审：真值在版本行里（标题"工资条查询"）。
	e.publishTitled(e.tokens["alice"], "retry-tool", "1.1.0",
		"工资条查询", "请输入工资口令", string(appcfg.AccessLogin), guest)

	// 部分完成态：①落库成功（端点用的那一个生产 DAO），②投影没跑。
	if err := serverstore.SetReleaseStatusForReview(e.db, serverstore.AppKindWasmApp,
		"retry-tool", "1.1.0", serverstore.ReleaseStatusApproved, ""); err != nil {
		t.Fatalf("置 approved 失败: %v", err)
	}
	if app := e.appRow("retry-tool"); app.Title != "报销助手" {
		t.Fatalf("前提不成立：投影应停在 v1.0.0，得到 title=%q current_release_id=%d", app.Title, app.CurrentReleaseID)
	}
	v1, rerr := serverstore.GetWasmRelease(e.ctx(), e.db, "retry-tool", "1.0.0")
	if rerr != nil {
		t.Fatalf("读 v1.0.0 失败: %v", rerr)
	}
	if app := e.appRow("retry-tool"); app.CurrentReleaseID != v1.ID {
		t.Fatalf("前提不成立：投影应停在 v1.0.0（release_id=%d），得到 %d", v1.ID, app.CurrentReleaseID)
	}

	// 管理员照错误提示重试：状态已是终态 ⇒ changed=false，但投影必须被补齐。
	w := e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/retry-tool/releases/1.1.0/approve", "", nil)
	var out struct {
		Status         string `json:"status"`
		Changed        bool   `json:"changed"`
		CurrentVersion string `json:"current_version"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Changed {
		t.Fatalf("已终态的重复 approve 不得再改状态（changed 必须为 false），得到 %+v", out)
	}
	if out.CurrentVersion != "1.1.0" {
		t.Errorf("重试响应里的 current_version = %q，want 1.1.0（响应也要反映自愈后的生效版本）", out.CurrentVersion)
	}

	latest, lerr := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "retry-tool")
	if lerr != nil {
		t.Fatalf("读最新 approved 失败: %v", lerr)
	}
	app := e.appRow("retry-tool")
	if app.Title != latest.Title || app.Description != latest.Description {
		t.Errorf("[AUDIT-CONFIRMED 回归] 重试没有补齐显示面投影：apps title=%q description=%q，"+
			"而生效版本 v%s 的真值是 title=%q description=%q（老实现在这里早退 ⇒ 目录永久停在旧值）",
			app.Title, app.Description, latest.Version, latest.Title, latest.Description)
	}
	if app.CurrentReleaseID != latest.ID {
		t.Errorf("重试没有补齐生效版本投影：current_release_id=%d，want %d", app.CurrentReleaseID, latest.ID)
	}
	row := e.catalogRow(e.tokens["bob"], "retry-tool")
	if row == nil {
		t.Fatal("目录里应有 retry-tool")
	}
	if row["title"] != latest.Title || row["description"] != latest.Description || row["current_version"] != latest.Version {
		t.Errorf("员工面目录没有追上生效版本：title=%v description=%v current_version=%v，want %q / %q / %q",
			row["title"], row["description"], row["current_version"], latest.Title, latest.Description, latest.Version)
	}
	// 状态审计**不被重试追加**：本用例的部分完成态是直接调 DAO 造的（端点没跑过),
	// 所以基线是 0 条；重试/再重试都不得让它变成 1（幂等不得重复副作用）。
	auditBefore := e.reviewAuditCount("retry-tool", "wasm_app_release_approve")
	if auditBefore != 0 {
		t.Fatalf("前提不成立：直接调 DAO 造的部分完成态不该有审核审计，得到 %d 条", auditBefore)
	}

	// 判据 ②：再调一次 —— 连一行都不写（updated_at 不跳、审计不增）。
	before := e.appRow("retry-tool")
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/retry-tool/releases/1.1.0/approve", "", nil), http.StatusOK, &struct{}{})
	after := e.appRow("retry-tool")
	if !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("第二次重复 approve 仍写了 apps 行（updated_at %v → %v）：幂等自愈必须是**最小写入**",
			before.UpdatedAt, after.UpdatedAt)
	}
	if n := e.reviewAuditCount("retry-tool", "wasm_app_release_approve"); n != auditBefore {
		t.Errorf("重复 approve 追加了审核审计（%d → %d 条）：幂等不得重复副作用", auditBefore, n)
	}
}

// TestFirstApproveWritesExactlyOneAudit 是上面那条的**正向对照**：真正的首审只写一条
// 审核审计，重复调用不追加（"自愈"不得变成"每次重试都记一笔审核"）。
func TestFirstApproveWritesExactlyOneAudit(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.setReviewRequired(true)
	e.publishTitled(e.tokens["alice"], "audit-once", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)

	path := "/api/server/admin/wasm-apps/audit-once/releases/1.0.0/approve"
	e.decodeJSON(e.req(http.MethodPost, path, "", nil), http.StatusOK, &struct{}{})
	if n := e.reviewAuditCount("audit-once", "wasm_app_release_approve"); n != 1 {
		t.Fatalf("首审应写 1 条审核审计，得到 %d 条", n)
	}
	e.decodeJSON(e.req(http.MethodPost, path, "", nil), http.StatusOK, &struct{}{})
	if n := e.reviewAuditCount("audit-once", "wasm_app_release_approve"); n != 1 {
		t.Errorf("重复 approve 追加了审核审计（共 %d 条），want 1", n)
	}
}

// TestRejectRetryRepairsProjection 覆盖判据 ③（reject 路径的自愈）。
func TestRejectRetryRepairsProjection(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	e.setReviewRequired(false)
	e.publishTitled(e.tokens["alice"], "reject-retry", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)
	e.setReviewRequired(true)
	e.publishTitled(e.tokens["alice"], "reject-retry", "1.1.0",
		"工资条查询", "请输入工资口令", string(appcfg.AccessLogin), guest)

	// 部分完成态 + 脏投影（老实现会让待审标题当场进目录）：状态已是 rejected。
	if err := serverstore.SetReleaseStatusForReview(e.db, serverstore.AppKindWasmApp,
		"reject-retry", "1.1.0", serverstore.ReleaseStatusRejected, "不是 IT 发的"); err != nil {
		t.Fatalf("置 rejected 失败: %v", err)
	}
	if err := serverstore.SetWasmAppDisplay(e.ctx(), e.db, "reject-retry", "工资条查询", "请输入工资口令"); err != nil {
		t.Fatalf("制造脏显示面投影失败: %v", err)
	}

	w := e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/reject-retry/releases/1.1.0/reject", "", map[string]any{"reason": "不是 IT 发的"})
	var out struct {
		Changed bool `json:"changed"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.Changed {
		t.Fatalf("已终态的重复 reject 不得再改状态，得到 changed=true")
	}
	app := e.appRow("reject-retry")
	if app.Title != "报销助手" || app.Description != "线上描述" {
		t.Errorf("重试 reject 没有把脏投影治好：title=%q description=%q，want 报销助手 / 线上描述",
			app.Title, app.Description)
	}
	v1, rerr := serverstore.GetWasmRelease(e.ctx(), e.db, "reject-retry", "1.0.0")
	if rerr != nil {
		t.Fatalf("读 v1.0.0 失败: %v", rerr)
	}
	if app.CurrentReleaseID != v1.ID {
		t.Errorf("重试 reject 不得改动生效版本：current_release_id=%d，want %d", app.CurrentReleaseID, v1.ID)
	}
	row := e.catalogRow(e.tokens["bob"], "reject-retry")
	if row["title"] != "报销助手" || row["current_version"] != "1.0.0" {
		t.Errorf("目录行 = %v / %v，want 报销助手 / 1.0.0", row["title"], row["current_version"])
	}
	if n := e.reviewAuditCount("reject-retry", "wasm_app_release_reject"); n != 0 {
		t.Errorf("重试 reject 写了 %d 条审核审计，want 0（部分完成态是直接调 DAO 造的，重试不得追加）", n)
	}

	before := e.appRow("reject-retry")
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/reject-retry/releases/1.1.0/reject", "", map[string]any{"reason": "不是 IT 发的"}),
		http.StatusOK, &struct{}{})
	if after := e.appRow("reject-retry"); !after.UpdatedAt.Equal(before.UpdatedAt) {
		t.Errorf("第二次重复 reject 仍写了 apps 行（updated_at %v → %v）", before.UpdatedAt, after.UpdatedAt)
	}
}
