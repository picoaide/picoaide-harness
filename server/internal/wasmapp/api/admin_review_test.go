package api

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// ctx / auditDetails 是本文件用到的两个薄封装（其余夹具在 helpers_test.go）。
func (e *testEnv) ctx() context.Context { return context.Background() }

// auditDetails 返回某应用下某动作的全部审计明细（按写入顺序）。
func (e *testEnv) auditDetails(appID, action string) []string {
	e.t.Helper()
	logs, err := serverstore.ListAuditLogsByApp(e.db, appID, 500)
	if err != nil {
		e.t.Fatalf("读审计失败: %v", err)
	}
	out := []string{}
	for _, l := range logs {
		if l.Action == action {
			out = append(out, l.Detail)
		}
	}
	return out
}

// ===========================================================================
// 审核队列（P0-1，2026-09-19 审计）
//
// 现场：publish.go 在 wasm.review_required 为真时把新版本落库为 pending，
// webadmin 的开关承诺"开启:新版本需审核"，但管理面**没有任何审批端点** ——
// 打开开关 = 全组织再也发不出新版本，且列表里看不到任何积压。
//
// 本文件是"闭环"的回归网，四个判据缺一不可：
//  1. 积压可见（adminList 的 pending_count/pending_releases + 待审清单端点）；
//  2. 通过 ⇒ 版本变 approved **且** current_release_id 跟着走（投影与交付同口径）；
//  3. 拒绝 ⇒ 与"释放归档"在同一条 UPDATE 里完成（复用 SetReleaseStatusForReview，
//     拒绝即释放存储），当前生效版本**不动**；
//  4. 审计动作按既有风格落库，且明细里没有应用内容（换行被折平、超长被收敛）。
//
// 变异方式（改回旧实现必红）：
//   - 去掉 router/api 里的三条审核路由（或 NewHandlers 里不接三个 handler）
//     ⇒ 本文件全部用例 404；
//   - 把 approve 的状态写入换成 serverstore.SetReleaseStatus（不判定归档）
//     ⇒ TestAdminReviewApproveAfterRejectIsRefused 失去 409（N-4 回归）；
//   - 去掉 approve 后的 current_release_id 同步 ⇒
//     TestAdminReviewApproveFlipsCurrentVersion 红（列表/交付两侧版本号分叉）；
//   - 拒绝线上生效版本不做守卫 ⇒ TestAdminRejectLiveReleaseIsRefused 红
//     （应用当场没有可交付版本）。
// ---------------------------------------------------------------------------

// setReviewRequired 切换审核开关（**组织级**设置，每个用例自己开/关）。
//
// 开关是组织级的：打开之后**所有应用**（含首次发布）的新版本都停在 pending ——
// 这正是 P0 的现场形态（"全组织无法上线"），因此夹具必须显式开关，
// 而不是"发布前先开开关"（那会让基线版本也变成待审，测不出"线上仍旧版本"）。
func (e *testEnv) setReviewRequired(required bool) {
	e.t.Helper()
	var out struct {
		ReviewRequired bool `json:"review_required"`
		Changed        bool `json:"changed"`
	}
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{"required": required})
	e.decodeJSON(w, http.StatusOK, &out)
	if out.ReviewRequired != required {
		e.t.Fatalf("切换审核开关失败: %+v", out)
	}
}

// reviewEnv：开关已打开的环境（需要"线上已有一个版本"的用例自己先发基线版本，
// 见 TestAdminReviewApproveFlipsCurrentVersion）。
func reviewEnv(t *testing.T) *testEnv {
	t.Helper()
	e := newTestEnv(t)
	e.setReviewRequired(false) // 显式关一次：证明"关→开"的切换真的发生（而不是本来就开着）
	e.setReviewRequired(true)
	return e
}

// adminAppRow 读管理面列表里某个应用的那一行。
type adminAppRow struct {
	AppID           string   `json:"app_id"`
	Enabled         bool     `json:"enabled"`
	CurrentVersion  string   `json:"current_version"`
	PendingReleases []string `json:"pending_releases"`
	PendingCount    int      `json:"pending_count"`
}

type adminListView struct {
	Apps           []adminAppRow `json:"apps"`
	ReviewRequired bool          `json:"review_required"`
	PendingCount   int           `json:"pending_count"`
}

func (e *testEnv) adminList() adminListView {
	e.t.Helper()
	var out adminListView
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil), http.StatusOK, &out)
	return out
}

func (e *testEnv) adminAppRow(appID string) adminAppRow {
	e.t.Helper()
	for _, a := range e.adminList().Apps {
		if a.AppID == appID {
			return a
		}
	}
	e.t.Fatalf("管理面列表里没有 %s", appID)
	return adminAppRow{}
}

// releaseRows 是待审清单的响应形状（跨语言契约，webadmin 按它渲染）。
type releaseRows struct {
	AppID          string `json:"app_id"`
	Status         string `json:"status"`
	CurrentVersion string `json:"current_version"`
	PendingCount   int    `json:"pending_count"`
	Releases       []struct {
		Version   string `json:"version"`
		Status    string `json:"status"`
		Publisher string `json:"publisher"`
		Size      int64  `json:"size"`
		CreatedAt string `json:"created_at"`
		Current   bool   `json:"current"`
		Changelog string `json:"changelog"`
		// 审核结论（被拒理由）。R1-uxw-4：审批面必须能回看自己写过的理由 ——
		// 在此之前它只落在审计详情里，连管理员自己都读不回来。
		Reason string `json:"reason"`
	} `json:"releases"`
}

func (e *testEnv) releaseRows(appID, query string) releaseRows {
	e.t.Helper()
	var out releaseRows
	path := "/api/server/admin/wasm-apps/" + appID + "/releases"
	if query != "" {
		path += "?" + query
	}
	e.decodeJSON(e.req(http.MethodGet, path, "", nil), http.StatusOK, &out)
	return out
}

// releaseState 直读库里该版本的状态与字节是否已被释放。
func (e *testEnv) releaseState(appID, version string) (status string, archiveEmpty bool, size int64) {
	e.t.Helper()
	var archiveLen *int64
	if err := e.db.QueryRow(`SELECT status, octet_length(archive), size FROM app_releases
		WHERE kind = $1 AND app_id = $2 AND version = $3`,
		serverstore.AppKindWasmApp, appID, version).Scan(&status, &archiveLen, &size); err != nil {
		e.t.Fatalf("读版本行失败: %v", err)
	}
	return status, archiveLen == nil, size
}

// TestAdminReviewFirstReleaseOfNewAppCanGoLive：P0 的最小复现场景 ——
// 开关打开后**一个新应用的首个版本**也停在 pending（current_version 为空 =
// 应用子域访问不到任何内容），此时管理面的审批出口是它唯一的上线途径。
//
// 这条路径是审计里"全组织无法上线"的最直接证据：开关是组织级的，没人审批
// 就永远没有 approved 版本可以服务。
func TestAdminReviewFirstReleaseOfNewAppCanGoLive(t *testing.T) {
	e := reviewEnv(t)
	rel := e.publishOK(e.tokens["alice"], "brand-new-tool", "1.0.0", testGuestModule(t), goodConfig())
	if rel["status"] != serverstore.ReleaseStatusPending {
		t.Fatalf("开关打开时首个版本也应停在 pending，得到 %v", rel["status"])
	}
	row := e.adminAppRow("brand-new-tool")
	if row.CurrentVersion != "" || row.PendingCount != 1 {
		t.Fatalf("待审且无生效版本（这就是「全组织无法上线」）：%+v", row)
	}
	// 没有审批出口时：没有任何 approved 版本 ⇒ 应用子域无内容可交付。
	if _, err := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "brand-new-tool"); err == nil {
		t.Fatal("待审期间不应存在 approved 版本（否则审批开关没有意义）")
	}
	// 管理员通过 ⇒ 应用可以上线了。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/brand-new-tool/releases/1.0.0/approve", "", nil),
		http.StatusOK, &struct{}{})
	latest, err := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "brand-new-tool")
	if err != nil || latest.Version != "1.0.0" {
		t.Fatalf("通过后应存在 approved 版本 1.0.0，得到 %+v err=%v", latest, err)
	}
	if row := e.adminAppRow("brand-new-tool"); row.CurrentVersion != "1.0.0" || row.PendingCount != 0 {
		t.Fatalf("通过后列表应显示当前版本、且无积压：%+v", row)
	}
	if list := e.adminList(); list.PendingCount != 0 {
		t.Fatalf("全部审批完成后顶层积压应为 0，得到 %d", list.PendingCount)
	}
}

// TestAdminReviewApproveFlipsCurrentVersion：开关打开 ⇒ 积压可见 ⇒ 通过 ⇒ 生效版本跟着走。
func TestAdminReviewApproveFlipsCurrentVersion(t *testing.T) {
	e := newTestEnv(t)
	// 开关关闭时发布的版本直接生效（基线）。
	e.publishOK(e.tokens["alice"], "review-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.setReviewRequired(true)

	// 开关打开后新版本停在 pending（publish 侧既有语义，本用例只做前置）。
	rel := e.publishOK(e.tokens["alice"], "review-tool", "1.1.0", testGuestModule(t), goodConfig())
	if rel["status"] != serverstore.ReleaseStatusPending {
		t.Fatalf("审核开关打开后新版本应停在 pending，得到 %v", rel["status"])
	}

	// ① 积压可见：列表行 + 顶层总数。
	list := e.adminList()
	if !list.ReviewRequired {
		t.Fatal("列表必须回显审核开关状态")
	}
	row := e.adminAppRow("review-tool")
	if row.PendingCount != 1 || len(row.PendingReleases) != 1 || row.PendingReleases[0] != "1.1.0" {
		t.Fatalf("列表行应下发积压（pending_count=1 / pending_releases=[1.1.0]），得到 %+v", row)
	}
	if row.CurrentVersion != "1.0.0" {
		t.Fatalf("待审期间当前生效版本应仍是 1.0.0，得到 %q", row.CurrentVersion)
	}
	if list.PendingCount != 1 {
		t.Fatalf("顶层 pending_count = %d, want 1（开关的后果必须在开关旁边可见）", list.PendingCount)
	}

	// ② 待审清单：谁、什么时候、多大、当前生效版本。
	rows := e.releaseRows("review-tool", "status=pending")
	if rows.Status != "pending" || rows.CurrentVersion != "1.0.0" || len(rows.Releases) != 1 {
		t.Fatalf("待审清单形状不对: %+v", rows)
	}
	got := rows.Releases[0]
	if got.Version != "1.1.0" || got.Status != serverstore.ReleaseStatusPending ||
		got.Publisher != "alice" || got.Size <= 0 || got.CreatedAt == "" || got.Current {
		t.Fatalf("待审行内容不对: %+v", got)
	}
	// 缺省（不带 status）就是待审队列。
	if rows2 := e.releaseRows("review-tool", ""); len(rows2.Releases) != 1 {
		t.Fatalf("缺省应列出待审版本，得到 %+v", rows2.Releases)
	}
	// 非法 status 必须被拒（拼错的值不该静默当成 pending）。
	eb := e.decodeErr(e.req(http.MethodGet, "/api/server/admin/wasm-apps/review-tool/releases?status=bogus", "", nil), http.StatusBadRequest)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Fatalf("非法 status 应回 VALIDATION，得到 %+v", eb.Error)
	}

	// ③ 通过 ⇒ approved + 生效版本投影同步。
	var decided struct {
		Version        string `json:"version"`
		Status         string `json:"status"`
		Changed        bool   `json:"changed"`
		CurrentVersion string `json:"current_version"`
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/review-tool/releases/1.1.0/approve", "", nil),
		http.StatusOK, &decided)
	if decided.Status != serverstore.ReleaseStatusApproved || !decided.Changed || decided.CurrentVersion != "1.1.0" {
		t.Fatalf("通过后的响应不对: %+v", decided)
	}
	if status, _, _ := e.releaseState("review-tool", "1.1.0"); status != serverstore.ReleaseStatusApproved {
		t.Fatalf("库里状态应为 approved，得到 %q", status)
	}
	// 交付面的真源（appserver 走的就是它）也必须是 1.1.0。
	latest, err := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "review-tool")
	if err != nil || latest.Version != "1.1.0" {
		t.Fatalf("交付面生效版本 = %+v err=%v, want 1.1.0", latest, err)
	}
	if got := e.adminAppRow("review-tool"); got.CurrentVersion != "1.1.0" || got.PendingCount != 0 {
		t.Fatalf("通过后列表应无积压且当前版本为 1.1.0，得到 %+v", got)
	}

	// ④ 幂等：重复通过不再改动、不再写审计。
	before := len(e.auditDetails("review-tool", "wasm_app_release_approve"))
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/review-tool/releases/1.1.0/approve", "", nil),
		http.StatusOK, &decided)
	if decided.Changed {
		t.Fatal("重复通过必须是幂等的（changed=false）")
	}
	if after := len(e.auditDetails("review-tool", "wasm_app_release_approve")); after != before {
		t.Fatalf("幂等路径不应写审计：%d → %d", before, after)
	}
	// ⑤ 审计：动作名 + 明细形态（申请人/版本，无应用内容）。
	details := e.auditDetails("review-tool", "wasm_app_release_approve")
	if len(details) != 1 {
		t.Fatalf("通过应恰好写一条 wasm_app_release_approve 审计，得到 %v", details)
	}
	assertAuditHasNoAppContent(t, details[0])
	if !strings.Contains(details[0], "v1.1.0") {
		t.Fatalf("审计明细必须点名版本：%q", details[0])
	}
}

// TestAdminRejectReleaseClearsArchiveAndKeepsCurrent：拒绝 = 置 rejected + 释放归档
// （同一条语句），当前生效版本不动。
func TestAdminRejectReleaseClearsArchiveAndKeepsCurrent(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "reject-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.setReviewRequired(true)
	e.publishOK(e.tokens["alice"], "reject-tool", "1.1.0", testGuestModule(t), goodConfig())

	var decided struct {
		Status         string `json:"status"`
		Changed        bool   `json:"changed"`
		CurrentVersion string `json:"current_version"`
		Reason         string `json:"reason"`
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/reject-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": "需要补充\n数据来源说明"}), http.StatusOK, &decided)
	if decided.Status != serverstore.ReleaseStatusRejected || !decided.Changed {
		t.Fatalf("拒绝响应不对: %+v", decided)
	}
	if decided.CurrentVersion != "1.0.0" {
		t.Fatalf("拒绝不能动当前生效版本（应仍 1.0.0），得到 %q", decided.CurrentVersion)
	}
	status, archiveEmpty, size := e.releaseState("reject-tool", "1.1.0")
	if status != serverstore.ReleaseStatusRejected || !archiveEmpty || size != 0 {
		t.Fatalf("拒绝即释放存储：status=%q archiveEmpty=%v size=%d", status, archiveEmpty, size)
	}
	// 线上交付仍是 1.0.0。
	latest, err := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "reject-tool")
	if err != nil || latest.Version != "1.0.0" {
		t.Fatalf("拒绝后交付面应仍是 1.0.0，得到 %+v err=%v", latest, err)
	}
	// 审计：理由进详情（折成单行），且不含应用内容。
	details := e.auditDetails("reject-tool", "wasm_app_release_reject")
	if len(details) != 1 {
		t.Fatalf("拒绝应恰好写一条审计，得到 %v", details)
	}
	if !strings.Contains(details[0], "数据来源说明") || strings.Contains(details[0], "\n") {
		t.Fatalf("拒绝理由必须进审计且被折成单行：%q", details[0])
	}
	assertAuditHasNoAppContent(t, details[0])

	// 积压清零。
	if got := e.adminAppRow("reject-tool"); got.PendingCount != 0 {
		t.Fatalf("拒绝后不应再有积压：%+v", got)
	}
}

// TestAdminReviewApproveAfterRejectIsRefused：拒绝已释放归档 ⇒ 再通过必须 409
// （N-4：approved 必须有归档字节；这里证明管理面复用的就是那条原子语义）。
func TestAdminReviewApproveAfterRejectIsRefused(t *testing.T) {
	e := reviewEnv(t)
	e.publishOK(e.tokens["alice"], "race-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.publishOK(e.tokens["alice"], "race-tool", "1.1.0", testGuestModule(t), goodConfig())
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/race-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": "先拒一版，用例要验的是 approve-after-reject 的语义"}),
		http.StatusOK, &struct{}{})

	eb := e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/race-tool/releases/1.1.0/approve", "", nil),
		http.StatusConflict)
	if len(eb.Error.Hints) == 0 {
		t.Fatalf("409 必须带 hints（告诉管理员下一步怎么办）：%+v", eb.Error)
	}
	if status, archiveEmpty, _ := e.releaseState("race-tool", "1.1.0"); status != serverstore.ReleaseStatusRejected || !archiveEmpty {
		t.Fatalf("被拒版本不得被改成 approved：status=%q archiveEmpty=%v", status, archiveEmpty)
	}
}

// TestAdminRejectApprovedReleaseIsRefused：审核拒绝**不是**下架/撤回手段 ——
// 拒绝与释放归档是同一条 UPDATE（N-4），所以拒绝一个已通过审核的版本会**永久**
// 销毁它的字节：对线上版本是"应用当场没有可交付版本"，对历史版本是"不可恢复地
// 丢掉一个可回滚点"。两条都必须被拒。
func TestAdminRejectApprovedReleaseIsRefused(t *testing.T) {
	e := newTestEnv(t) // 开关关闭：发布的版本直接生效
	e.publishOK(e.tokens["alice"], "live-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.publishOK(e.tokens["alice"], "live-tool", "1.1.0", testGuestModule(t), goodConfig())

	// ① 线上生效版本（current）。
	e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/live-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": "用例要验的是「拒绝线上版本」必须被拒，理由先给足"}),
		http.StatusConflict)
	// ② 历史 approved 版本（不是 current，但仍是可回滚点）。
	e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/live-tool/releases/1.0.0/reject", "",
		map[string]any{"reason": "同上：历史 approved 也是可回滚点"}),
		http.StatusConflict)

	for _, v := range []string{"1.0.0", "1.1.0"} {
		status, archiveEmpty, size := e.releaseState("live-tool", v)
		if status != serverstore.ReleaseStatusApproved || archiveEmpty {
			t.Fatalf("v%s 必须原样保留：status=%q archiveEmpty=%v", v, status, archiveEmpty)
		}
		if size <= 0 {
			t.Fatalf("v%s 的 size 不应被清零：%d", v, size)
		}
	}
	// 线上交付不受影响。
	latest, err := serverstore.LatestApprovedWasmReleaseMeta(e.ctx(), e.db, "live-tool")
	if err != nil || latest.Version != "1.1.0" {
		t.Fatalf("交付面应仍是 1.1.0，得到 %+v err=%v", latest, err)
	}
}

// TestAdminReviewUnknownVersionAndDeletedApp：404 语义（版本不存在 / 应用已删除）。
func TestAdminReviewUnknownVersionAndDeletedApp(t *testing.T) {
	e := reviewEnv(t)
	e.publishOK(e.tokens["alice"], "gone-tool", "1.0.0", testGuestModule(t), goodConfig())

	e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/gone-tool/releases/9.9.9/approve", "", nil),
		http.StatusNotFound)
	e.decodeErr(e.req(http.MethodGet, "/api/server/admin/wasm-apps/no-such-app/releases", "", nil),
		http.StatusNotFound)

	// 软删的应用不可再审批（adminApp 的统一守卫）。
	if w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/gone-tool", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("删除失败: %s", w.Body.String())
	}
	e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/gone-tool/releases/1.0.0/reject", "",
		map[string]any{"reason": "用例要验的是软删应用不可审批"}),
		http.StatusNotFound)
}

// TestAdminReviewReasonTooLong：拒绝理由进哈希链（写进去改不掉）⇒ 入口必须收敛。
func TestAdminReviewReasonTooLong(t *testing.T) {
	e := reviewEnv(t)
	e.publishOK(e.tokens["alice"], "long-reason", "1.0.0", testGuestModule(t), goodConfig())
	e.publishOK(e.tokens["alice"], "long-reason", "1.1.0", testGuestModule(t), goodConfig())
	eb := e.decodeErr(e.req(http.MethodPost, "/api/server/admin/wasm-apps/long-reason/releases/1.1.0/reject", "",
		map[string]any{"reason": strings.Repeat("长", maxReviewReasonLen+1)}), http.StatusBadRequest)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Fatalf("超长理由应回 VALIDATION，得到 %+v", eb.Error)
	}
}

// TestAdminReviewStatusAllListsEveryVersion：status=all 给"审批时看全貌"用。
func TestAdminReviewStatusAllListsEveryVersion(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "all-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.setReviewRequired(true)
	e.publishOK(e.tokens["alice"], "all-tool", "1.1.0", testGuestModule(t), goodConfig())
	rows := e.releaseRows("all-tool", "status=all")
	if len(rows.Releases) != 2 {
		t.Fatalf("status=all 应列出全部版本，得到 %+v", rows.Releases)
	}
	if !rows.Releases[0].Current {
		t.Fatalf("当前生效版本必须被标记（前端据此禁用拒绝按钮）：%+v", rows.Releases[0])
	}
	if rows.Releases[1].Current {
		t.Fatalf("待审版本不应被标记为 current：%+v", rows.Releases[1])
	}
}

// TestAdminReleasesRowCarriesRejectReason：审批队列的**每一行**都带审核结论
// （R1-uxw-4）—— 之前理由只落审计详情，管理端自己都回看不了「我上次为什么拒的」，
// 发布者更是无从得知。判据三条：rejected 行有理由、approved 行空理由、
// status=rejected 正是管理端「最近被拒」子清单的数据源。
func TestAdminReleasesRowCarriesRejectReason(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "reason-tool", "1.0.0", testGuestModule(t), goodConfig())
	e.setReviewRequired(true)
	e.publishOK(e.tokens["alice"], "reason-tool", "1.1.0", testGuestModule(t), goodConfig())

	const reason = "访问范围声明过宽：请改成登录后使用"
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/reason-tool/releases/1.1.0/reject", "",
		map[string]any{"reason": reason}), http.StatusOK, &struct {
		Reason string `json:"reason"`
	}{})

	rows := e.releaseRows("reason-tool", "status=rejected")
	if len(rows.Releases) != 1 {
		t.Fatalf("status=rejected 应列出被拒版本（管理端「最近被拒」子清单的数据源）：%+v", rows.Releases)
	}
	if got := rows.Releases[0].Reason; got != reason {
		t.Fatalf("被拒行的 reason = %q, want %q", got, reason)
	}
	if rows.Releases[0].Status != serverstore.ReleaseStatusRejected {
		t.Fatalf("状态应为 rejected：%+v", rows.Releases[0])
	}
	// approved 行不得带理由（数据库在通过时把 reason 清成空串）。
	all := e.releaseRows("reason-tool", "status=all")
	for _, r := range all.Releases {
		if r.Version == "1.0.0" && r.Reason != "" {
			t.Fatalf("approved 行不应有审核理由：%+v", r)
		}
	}
	// 待审队列（缺省视图）本身不含被拒版本，理由由 rejected 视图承载。
	pending := e.releaseRows("reason-tool", "")
	if len(pending.Releases) != 0 {
		t.Fatalf("拒绝后待审队列应为空：%+v", pending.Releases)
	}
}

// assertAuditHasNoAppContent：审计明细只写"谁对哪个版本的什么处置"，
// **不含**制品内容与变更说明（审计面是运维可读的，不是内容仓库）。
func assertAuditHasNoAppContent(t *testing.T, detail string) {
	t.Helper()
	if detail == "" {
		t.Fatal("审计明细为空")
	}
	if len([]rune(detail)) > 400 {
		t.Fatalf("审计明细过长（疑似把整份内容写进去了）：%d 字", len([]rune(detail)))
	}
	if strings.Contains(detail, "首版") {
		t.Fatalf("审计明细不得含应用的 changelog 内容：%q", detail)
	}
	if strings.Contains(detail, base64.StdEncoding.EncodeToString([]byte("AGFzbQ"))) {
		t.Fatalf("审计明细不得含制品字节：%q", detail)
	}
}

// TestAdminRejectRequiresReason 钉住 P2-5（2026-09-20 本机全功能实测）：
// `POST …/releases/<v>/reject` 曾经允许不带理由 —— `'{}'` ⇒
// `200 {"status":"rejected","reason":""}`，作者侧拿到的 `reason` 是空串。
//
// 为什么这是缺陷而不是"可选字段"：拒绝理由是这条通道**唯一**的反馈载体（同一条
// 字符串同时进审计、管理端"最近被拒"清单与作者客户端 `GET …/releases` 的 `reason`），
// 空理由 ⇒ 作者只知道"被拒了"，不知道改什么，只能反复重发。
//
// 判据（四态，全部走**生产路径**）：
//   - `{}`（实测形态）/ 无 body / 空白字符串 / `null` / 只有别的键 ⇒ 400 VALIDATION
//     且 `field=reason`，**且状态未被改动**（仍 pending，没有被"拒掉"）；
//   - 给足理由 ⇒ 200 且作者侧读得到同一句。
//
// 变异验证：把 `adminLimitsPut` 那条"reason == \"\" ⇒ 400"的闸门去掉
// ⇒ 前四个子用例红（正是 P2-5 的现场）。
func TestAdminRejectRequiresReason(t *testing.T) {
	e := reviewEnv(t)
	e.publishOK(e.tokens["alice"], "reason-required", "1.0.0", testGuestModule(t), goodConfig())
	e.publishOK(e.tokens["alice"], "reason-required", "1.1.0", testGuestModule(t), goodConfig())

	reject := func(body any) *httptest.ResponseRecorder {
		t.Helper()
		return e.req(http.MethodPost,
			"/api/server/admin/wasm-apps/reason-required/releases/1.1.0/reject", "", body)
	}
	stillPending := func() {
		t.Helper()
		// 用 releaseState 而不是 status=pending 的清单：审核开关打开时 1.0.0 也待审，
		// 「清单里有 1 行」这种断言会把前置状态算进来（判据必须只钉被拒的那一版）。
		status, _, size := e.releaseState("reason-required", "1.1.0")
		if status != serverstore.ReleaseStatusPending || size <= 0 {
			t.Fatalf("被拒的 400 不得改动状态（1.1.0 应仍待审、归档字节仍在）：status=%q size=%d", status, size)
		}
	}

	for _, tc := range []struct {
		name string
		body any
	}{
		{"空对象（实测形态）", map[string]any{}},
		{"没有请求体", nil},
		{"空白理由", map[string]any{"reason": "   \n\t "}},
		{"显式 null", map[string]any{"reason": nil}},
		{"只有别的键", map[string]any{"note": "忘了写 reason"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			eb := e.decodeErr(reject(tc.body), http.StatusBadRequest)
			if eb.Error.Code != string(apperr.CodeValidation) {
				t.Fatalf("error.code = %q, want %q", eb.Error.Code, apperr.CodeValidation)
			}
			if got, _ := eb.Error.Details["field"].(string); got != "reason" {
				t.Fatalf("details.field = %q, want reason", got)
			}
			if len(eb.Error.Hints) == 0 {
				t.Fatal("400 必须带 hint（告诉调用方理由会流向哪里、为什么不能空）")
			}
			stillPending()
		})
	}

	// 正例：给足理由 ⇒ 200，且作者侧（员工面 MyReleases）读到同一句。
	const reason = "用途与数据敏感度不匹配：请补充数据流向与存放位置后再发"
	var decided struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	}
	e.decodeJSON(reject(map[string]any{"reason": reason}), http.StatusOK, &decided)
	if decided.Status != serverstore.ReleaseStatusRejected || decided.Reason != reason {
		t.Fatalf("正例响应 = %+v, want status=rejected + reason 原样回显", decided)
	}
	after := e.myReleases("reason-required", e.tokens["alice"])
	row := after.row(t, "1.1.0")
	if row.Status != serverstore.ReleaseStatusRejected || row.Reason != reason {
		t.Fatalf("作者侧必须读到同一句理由：status=%q reason=%q", row.Status, row.Reason)
	}
}
