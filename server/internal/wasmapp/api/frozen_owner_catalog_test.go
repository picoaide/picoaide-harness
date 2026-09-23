package api

// R6-B-3（审计 2026-09-23，P2）：冻结行的**作者面**必须可达。
//
// 修前形态：目录（`GET /api/client/v2/apps/wasm/catalog`，客户端应用中心的**唯一**
// 数据源）对**所有人**跳过 `frozen_at` 非空的行（`read.go` 的 `a.FrozenAt != nil ||
// a.CurrentReleaseID <= 0`），而客户端面板每次挂载（以及每一次发布之后）都会重新拉
// 目录 ⇒ 发布者"在应用中心里解冻"这条路径在任何一次重载之后都没有可依附的行：
//
//   - 解冻端点本身对发布者是可用的（`ownedApp` 放行发布者本人，见 release.go），
//     后端能力在，缺的只是**可达面**；
//   - 同一时刻 `GET /:app_id/availability` 仍回 `reason=frozen, owned_by_you=true`
//     —— 唯一还在指路"去解冻"的出口，指向的正是目录里不存在的行；
//   - 客户端字典与作者手册因此互相矛盾（一边承诺"发布者本人在应用中心里就能解冻"，
//     一边只说"找管理员解冻"）。
//
// 定案语义（与"下架 = 作者仍可见（带标记）"同口径，R5-B-1）：
//   · **归属人**在目录里看得到自己冻结的应用（行带 `frozen:true`、`enabled:false`），
//     于是面板能标「已冻结」、禁用打开、给出「解冻」动作；
//   · 其他员工看到的是"不存在"（不列该行，不泄露存在性）；
//   · 归属判据 = **严格归属**（`apps.owner == 调用者`），不含超管兜底 —— 管理员面在
//     webadmin（`?filter=frozen` + 管理端点 freeze/unfreeze）。
//
// 变异验证（任一改动都必须让本文件红）：
//   · 把 `read.go` 的冻结跳过条件改回 `a.FrozenAt != nil || a.CurrentReleaseID <= 0`
//     ⇒ ①②③ 全红（这就是 R6-B-3 的原形态）；
//   · 把 `ownedByViewer` 换成含超管兜底的 `isOwner` ⇒ ④ 红（管理员在员工面扩面）；
//   · 行里去掉 `"frozen"` 键 ⇒ ①②③ 红（客户端区分不出"冻结"与"下架"）。

import (
	"net/http"
	"testing"
)

// r6bFrozenRow 取目录里指定 app_id 的行；不存在 ⇒ ok=false。
func r6bFrozenRow(t *testing.T, e *testEnv, token, appID string) (map[string]any, bool) {
	t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", token, nil)
	var out struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	for _, a := range out.Apps {
		if a["app_id"] == appID {
			return a, true
		}
	}
	return nil, false
}

func TestCatalogKeepsFrozenRowForItsOwner(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	cfg := goodConfig()
	e.publishOK(e.tokens["alice"], "r6b-frozen", "1.0.0", guest, cfg)

	// 冻结前：作者行在，且 frozen 必须是**明确的 false**（不是缺字段：
	// "没说" 与 "没冻结" 不能同形 —— 客户端按 `entry.frozen === true` 判）。
	before, ok := r6bFrozenRow(t, e, e.tokens["alice"], "r6b-frozen")
	if !ok {
		t.Fatalf("冻结前归属人应能在目录里看到自己的应用")
	}
	if before["frozen"] != false || before["enabled"] != true {
		t.Fatalf("冻结前的行应带 frozen=false / enabled=true: %+v", before)
	}

	// 作者冻结自己的应用（服务端 ownedApp 放行发布者本人）。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/r6b-frozen/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("作者冻结自己的应用应 200: %s", w.Body.String())
	}

	// ① 归属人**仍能看到**自己的冻结行，且行里带着区分"冻结"与"下架"所需的两个标记。
	owner, ok := r6bFrozenRow(t, e, e.tokens["alice"], "r6b-frozen")
	if !ok {
		t.Fatal("R6-B-3：归属人必须能在目录里看到自己冻结的应用 —— 否则" +
			"「在应用中心里解冻」这条路径在每一次面板重载后都不可达")
	}
	if owner["frozen"] != true {
		t.Fatalf("冻结行必须带 frozen=true（客户端据此标「已冻结」并给出解冻动作）: %+v", owner)
	}
	if owner["enabled"] != false {
		t.Fatalf("冻结会顺带下架 ⇒ enabled 必须是 false: %+v", owner)
	}
	if owner["is_owner"] != true {
		t.Fatalf("归属人看到的自己那一行必须 is_owner=true: %+v", owner)
	}

	// ② 其他员工**看不到**这一行（与"不存在"同形，不泄露存在性）。
	if bob, ok := r6bFrozenRow(t, e, e.tokens["bob"], "r6b-frozen"); ok {
		t.Fatalf("非归属人不得看到他人的冻结行（不泄露存在性）: %+v", bob)
	}

	// ③ 同一端点解冻之后，行仍在目录里、标记变回 frozen=false（数据与标识都还在，
	//    只是"解冻不会自动上架" ⇒ enabled 仍为 false，需要作者显式重新上架）。
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/r6b-frozen/freeze", e.tokens["alice"],
		map[string]any{"frozen": false}); w.Code != http.StatusOK {
		t.Fatalf("解冻应 200: %s", w.Body.String())
	}
	after, ok := r6bFrozenRow(t, e, e.tokens["alice"], "r6b-frozen")
	if !ok {
		t.Fatal("解冻后归属人仍应看到该行")
	}
	if after["frozen"] != false {
		t.Fatalf("解冻后 frozen 必须回 false: %+v", after)
	}
	if after["enabled"] != false {
		t.Fatalf("解冻不会自动上架 ⇒ enabled 仍是 false（要作者显式上架）: %+v", after)
	}
	// 解冻之后该应用回到"已下架"这一档：**下架行对所有人列出**（带 enabled=false，
	// R34/R38）—— 与冻结期"对非归属人不列"形成对照，说明两档的可见性口径确实不同。
	if bob, ok := r6bFrozenRow(t, e, e.tokens["bob"], "r6b-frozen"); !ok {
		t.Fatal("解冻后（= 已下架）该行应回到分发面：下架行对所有人列出并带 enabled=false")
	} else if bob["enabled"] != false || bob["frozen"] != false {
		t.Fatalf("解冻后的行对非归属人应显示 enabled=false / frozen=false: %+v", bob)
	}
}

// TestCatalogDoesNotWidenFrozenVisibilityForAdmin：④ 员工面不为管理员扩面。
//
// 判据：超管**不是**该应用的归属人时，员工面目录里同样没有这一行 —— 管理员处置冻结
// 走 webadmin（`?filter=frozen` 清单 + 管理端点），员工面扩面会让"谁看得见冻结内容"
// 多出一条与归属无关的规则（而 `is_owner` 的宽松判据只用于发布权，见 read.go）。
func TestCatalogDoesNotWidenFrozenVisibilityForAdmin(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "r6b-frozen-admin", "1.0.0", guest, goodConfig())
	e.publishOK(e.tokens["alice"], "r6b-live-admin", "1.0.0", guest, goodConfig())
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/r6b-frozen-admin/freeze", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("冻结失败: %s", w.Body.String())
	}
	// 反向对照：同一个管理员**看得到**同一位作者没冻结的另一行
	// （证明"看不到"不是因为整个目录对他为空）。
	if _, ok := r6bFrozenRow(t, e, e.tokens["boss"], "r6b-live-admin"); !ok {
		t.Fatal("前置条件错误：管理员应当看得到没冻结的行")
	}
	if row, ok := r6bFrozenRow(t, e, e.tokens["boss"], "r6b-frozen-admin"); ok {
		t.Fatalf("超管（非归属人）不得在员工面看到他人的冻结行: %+v", row)
	}
}
