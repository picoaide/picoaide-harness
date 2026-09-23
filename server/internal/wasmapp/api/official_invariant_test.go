package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// 官方归属不变量：official=1 ⇒ owner=''（R3-A A-9）
// ===========================================================================
//
// 缺陷形态（审计第三轮 A-9）：`commitRelease` 无条件把 `Owner: in.publisher`
// 交给 `UpsertWasmApp`，而 DAO 的冲突分支是
// `owner = COALESCE(NULLIF(apps.owner,''), excluded.owner)` ——
// 官方应用的 owner 本来就是空串，于是**一次普通的管理员发版就把归属从"官方"
// 改写成发布者个人**，造出 `official=1 ∧ owner≠''`。
//
// 为什么这是缺陷而不是"无所谓"：
//   - 这个组合是 `serverstore.SetAppOfficial` **显式拒绝**的状态
//     （转官方 = official=1 + owner 清空），技能/智能体面由 `appstore.Publish`
//     的 official 分支守住；只有 wasm 面漏了 ⇒ 同一条不变量在两个面上
//     一正一反；
//   - 官方内容"归属恒为官方"是产品语义（蓝标 + 员工端不可上传新版），
//     被改写成个人后，员工端会把它当"某个人的应用"（`is_owner` 对 owner 为真
//     而发布仍被拒），客户端预检与服务端判定分叉。

// appOfficialAndOwner 直接读 apps 行的 official/owner。
//
// 为什么不用 DTO：`WasmApp` 这一列在本次修复前**根本不存在**（这正是"共享端点
// 能写一个 wasm 面读不到的列"的旁证）。原始 SQL 读的是**库里的事实**，
// 不受 DTO 列集影响 —— 判据必须钉在库上。
func appOfficialAndOwner(t *testing.T, e *testEnv, appID string) (int, string) {
	t.Helper()
	var official int
	var owner string
	if err := e.db.QueryRow(`SELECT official, owner FROM apps WHERE kind = $1 AND app_id = $2`,
		serverstore.AppKindWasmApp, appID).Scan(&official, &owner); err != nil {
		t.Fatalf("读 apps 行失败(%s): %v", appID, err)
	}
	return official, owner
}

// markOfficialViaAdminEndpoint 走**生产端点**把 wasm 应用标记为官方
// （`PUT /api/server/admin/apps/:kind/:app_id/owner {"official":true}`）。
//
// 为什么不用 DAO 直调：归属转移是一个**需要审计**的动作，而审计写在端点里
// （`appstore.TransferOwnerAuditDetail` + `AuditLog`）。用例走端点才能同时证明
// "状态正确"与"这一步有审计行"—— DAO 直调会把审计缺口藏起来。
func markOfficialViaAdminEndpoint(t *testing.T, e *testEnv, appID string) {
	t.Helper()
	w := e.req(http.MethodPut, "/api/server/admin/apps/"+serverstore.AppKindWasmApp+"/"+appID+"/owner",
		e.tokens["boss"], map[string]any{"official": true})
	e.decodeJSON(w, http.StatusOK, &struct {
		OK       bool `json:"ok"`
		Official bool `json:"official"`
	}{})
}

// TestOfficialWasmAppKeepsEmptyOwnerAfterPublish 是本条缺陷的**主判据**。
//
// 红/绿对照（修复前 ⇒ 第 ③ 组断言红在 `official=1 owner="boss"`）。
func TestOfficialWasmAppKeepsEmptyOwnerAfterPublish(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	e.publishOK(e.tokens["alice"], "official-app", "1.0.0", guest, goodConfig())

	// ①标记官方（归属：alice → 官方）。
	markOfficialViaAdminEndpoint(t, e, "official-app")
	off1, own1 := appOfficialAndOwner(t, e, "official-app")
	if off1 != 1 || own1 != "" {
		t.Fatalf("前置条件不成立：标记官方后应 official=1 owner=\"\"，实得 official=%d owner=%q", off1, own1)
	}

	// ②管理员发新版 —— 这正是缺陷发生的那一步。
	e.publishOK(e.tokens["boss"], "official-app", "1.1.0", guest, goodConfig())

	off2, own2 := appOfficialAndOwner(t, e, "official-app")
	if off2 != 1 {
		t.Fatalf("发新版不得改变官方属性：official=%d（want 1）", off2)
	}
	if own2 != "" {
		t.Fatalf("BUG: 官方应用发新版后出现被 SetAppOfficial 明确禁止的状态 "+
			"official=1 ∧ owner=%q（管理员发版把官方归属改写成了个人）", own2)
	}

	// ④发版本身仍要留痕（修归属不能顺手把发布审计也改掉）。
	assertAuditAction(t, e, "official-app", "wasm_app_release")
}

// TestOfficialOwnershipTransferIsAuditedPerApp 钉住 A-9 的**第二半**：
// "标记官方"是一次归属转移（归属 alice → 官方），它必须留下
// `app_owner_transfer` 审计行，而且必须**按应用可检索**
// （`ListAuditLogsByApp` 走 0069 的 app_id 列）。
//
// 为什么"按应用可检索"是判据的一部分：wasm 面自己的归属转移端点
// （`adminTransferOwner`）用 `AuditLogApp` 写，而共享端点
// `PUT /api/server/admin/apps/:kind/:app_id/owner` 用的是不带 app 维度的
// `AuditLog` ⇒ 同一种动作在两条路径上的可检索性不一致，应用维度的审计视图
// （`/api/server/admin/audit?…` 与导出）看不到这次转移。A-9 的"无审计"现场
// 判据就是按应用查不到 —— 修的是可检索性，不是"补一行日志"。
func TestOfficialOwnershipTransferIsAuditedPerApp(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "audited-official", "1.0.0", testGuestModule(t), goodConfig())

	markOfficialViaAdminEndpoint(t, e, "audited-official")
	assertAuditAction(t, e, "audited-official", "app_owner_transfer")
}

// TestOfficialWasmAppOnboardingKeepsOfficialOwner 覆盖**首次发布**这条路径：
// 一个已被标记官方的标识（历史行：管理员先建了官方占位，owner=”）在有人发布
// 首版时同样不得被占名（"发布即占名"对官方行不适用 —— 官方不是某个人）。
func TestOfficialWasmAppOnboardingKeepsOfficialOwner(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	// 造一个"官方但还没有任何版本"的行（管理员在能力面建官方条目的形态）。
	if err := serverstore.UpsertWasmApp(t.Context(), e.db, serverstore.WasmApp{
		AppID: "official-fresh", Title: "官方占位", Enabled: true,
	}); err != nil {
		t.Fatalf("建占位行失败: %v", err)
	}
	markOfficialViaAdminEndpoint(t, e, "official-fresh")

	e.publishOK(e.tokens["boss"], "official-fresh", "1.0.0", guest, goodConfig())
	if off, own := appOfficialAndOwner(t, e, "official-fresh"); off != 1 || own != "" {
		t.Fatalf("官方应用的首版发布同样不得占名：official=%d owner=%q", off, own)
	}
}

// TestNonOfficialWasmAppStillClaimsOwner 是**反向用例**（防过度修复）：
// 非官方应用的归属语义必须一字不变 —— 首个发布者占名、后续发布不得改写归属。
//
// 没有这条，"把所有应用的 owner 都清空"也能让主判据变绿，而那会把"发布者即
// 管理员"（§4.1/R6）整体打掉：任何人都能接管他人应用。
func TestNonOfficialWasmAppStillClaimsOwner(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	e.publishOK(e.tokens["alice"], "plain-tool", "1.0.0", guest, goodConfig())
	if off, own := appOfficialAndOwner(t, e, "plain-tool"); off != 0 || own != "alice" {
		t.Fatalf("首个发布者必须占名：official=%d owner=%q（want 0/alice）", off, own)
	}

	// 管理员代发新版（兜底接管）同样不得改写归属。
	e.publishOK(e.tokens["boss"], "plain-tool", "1.1.0", guest, goodConfig())
	if off, own := appOfficialAndOwner(t, e, "plain-tool"); off != 0 || own != "alice" {
		t.Fatalf("非官方应用的归属一经写入不可被改写：official=%d owner=%q（want 0/alice）", off, own)
	}
}

// assertAuditAction 断言某应用的审计流里出现过该动作（带可读的失败信息）。
func assertAuditAction(t *testing.T, e *testEnv, appID, action string) {
	t.Helper()
	actions := e.auditActions(appID)
	for _, a := range actions {
		if a == action {
			return
		}
	}
	t.Fatalf("应用 %s 的审计流里没有 %q（实得 %v）", appID, action, actions)
}

// TestAdminOwnerTransferRefusesOfficialApp 钉住**同一不变量的第二个写入口**
// （实现 A-9 的 DAO 守卫时顺带发现的同族缺口）。
//
// wasm 管理面的归属转移端点（`PUT /api/server/admin/wasm-apps/:app_id/owner` →
// `TransferWasmAppOwner`）只做 `UPDATE apps SET owner = $1`，**不看 official**
// ⇒ 管理员对官方应用点一次"转移归属"就能造出 `official=1 ∧ owner≠”`，
// 与发布路径是同一个禁止状态、同一个审计动作，只是换了个入口。
//
// 修法：显式拒绝并指路（归属官方是一次性转移，共享端点
// `PUT /api/server/admin/apps/:kind/:app_id/owner` 的 official/owner 二选一
// 已经覆盖"取消官方 + 指定新负责人"这个组合），绝不静默降级成"改归属"。
func TestAdminOwnerTransferRefusesOfficialApp(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)

	e.publishOK(e.tokens["alice"], "official-transfer", "1.0.0", guest, goodConfig())
	markOfficialViaAdminEndpoint(t, e, "official-transfer")

	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/official-transfer/owner", "",
		map[string]any{"owner": "bob"})
	eb := e.decodeErr(w, http.StatusForbidden)
	if !strings.Contains(eb.Error.Message, "官方") {
		t.Fatalf("拒绝理由必须点名「官方归属」: %q", eb.Error.Message)
	}
	if len(eb.Error.Hints) == 0 {
		t.Fatal("拒绝必须给可行动 hints（归属官方要走官方的取消/转移语义）")
	}
	if off, own := appOfficialAndOwner(t, e, "official-transfer"); off != 1 || own != "" {
		t.Fatalf("被拒的转移不得落库：official=%d owner=%q（want 1/\"\"）", off, own)
	}

	// 反向（防过度修复）：非官方应用的归属转移必须照常可用 —— 否则管理员
	// 再也无法接管离职者的应用（§11 第 17 项）。
	e.publishOK(e.tokens["alice"], "plain-transfer", "1.0.0", guest, goodConfig())
	e.decodeJSON(e.req(http.MethodPut, "/api/server/admin/wasm-apps/plain-transfer/owner", "",
		map[string]any{"owner": "bob"}), http.StatusOK, &struct {
		App struct {
			AppID   string `json:"app_id"`
			Owner   string `json:"owner"`
			Changed bool   `json:"changed"`
		} `json:"app"`
	}{})
	if off, own := appOfficialAndOwner(t, e, "plain-transfer"); off != 0 || own != "bob" {
		t.Fatalf("非官方应用的归属转移被误伤：official=%d owner=%q（want 0/bob）", off, own)
	}
}
