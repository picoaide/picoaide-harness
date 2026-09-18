package api

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// ===========================================================================
// §8 管理面（R23 最小运维面）
// ===========================================================================

// TestAdminListIncludesReviewSwitch 管理面列表：应用 + 审核开关状态一次取回
// （webadmin 的应用页要能直接渲染它，R17）。
func TestAdminListIncludesReviewSwitch(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "admin-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil)
	var out struct {
		Apps []struct {
			AppID   string `json:"app_id"`
			Owner   string `json:"owner"`
			Enabled bool   `json:"enabled"`
		} `json:"apps"`
		ReviewRequired bool   `json:"review_required"`
		SettingKey     string `json:"setting_key"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.ReviewRequired || out.SettingKey != SettingReviewRequired {
		t.Fatalf("审核开关缺省必须关且回显键名: %+v", out)
	}
	found := false
	for _, a := range out.Apps {
		if a.AppID == "admin-tool" {
			found = true
			if a.Owner != "alice" || !a.Enabled {
				t.Fatalf("列表行不对: %+v", a)
			}
		}
	}
	if !found {
		t.Fatalf("列表应包含刚发布的应用: %+v", out.Apps)
	}
	// 已删除的应用默认不列，include_deleted=1 才列。
	if w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/admin-tool", e.tokens["alice"], nil); w.Code != http.StatusOK {
		t.Fatalf("删除失败: %s", w.Body.String())
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps", "", nil), http.StatusOK, &out)
	for _, a := range out.Apps {
		if a.AppID == "admin-tool" {
			t.Fatal("默认不应列出已删除的应用")
		}
	}
	var withDeleted struct {
		Apps []struct {
			AppID     string `json:"app_id"`
			DeletedAt any    `json:"deleted_at"`
		} `json:"apps"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps?include_deleted=1", "", nil), http.StatusOK, &withDeleted)
	found = false
	for _, a := range withDeleted.Apps {
		if a.AppID == "admin-tool" && a.DeletedAt != nil {
			found = true
		}
	}
	if !found {
		t.Fatal("include_deleted=1 应列出已删除的应用及其时间戳")
	}
}

// TestAdminUnpublish 管理员下架任意应用（R23）。
func TestAdminUnpublish(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "ops-tool", "1.0.0", testGuestModule(t), goodConfig())

	var out struct {
		App struct {
			Enabled bool `json:"enabled"`
			Changed bool `json:"changed"`
		} `json:"app"`
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/ops-tool/unpublish", "", nil), http.StatusOK, &out)
	if out.App.Enabled || !out.App.Changed {
		t.Fatalf("管理员下架结果不对: %+v", out.App)
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "ops-tool")
	if app.Enabled {
		t.Fatal("apps.enabled 应为 0")
	}
	// 归属仍是原发布者（管理员处置不改归属）。
	if app.Owner != "alice" {
		t.Fatalf("管理员处置不得改写归属: %s", app.Owner)
	}
	if !contains(e.auditActions("ops-tool"), "wasm_app_publish_toggle") {
		t.Fatalf("管理员下架要留痕: %v", e.auditActions("ops-tool"))
	}
	// 幂等。
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/ops-tool/unpublish", "", nil), http.StatusOK, &out)
	if out.App.Changed {
		t.Fatal("状态未变更时 changed 应为 false")
	}
}

// TestAdminTransferOwner 转移归属（§11 第 17 项：离职/接管）。
func TestAdminTransferOwner(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "handover-tool", "1.0.0", testGuestModule(t), goodConfig())

	var out struct {
		App struct {
			Owner   string `json:"owner"`
			Changed bool   `json:"changed"`
		} `json:"app"`
	}
	e.decodeJSON(e.req(http.MethodPut, "/api/server/admin/wasm-apps/handover-tool/owner", "",
		map[string]any{"owner": "bob"}), http.StatusOK, &out)
	if out.App.Owner != "bob" || !out.App.Changed {
		t.Fatalf("转移结果不对: %+v", out.App)
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "handover-tool")
	if app.Owner != "bob" {
		t.Fatalf("归属未落库: %s", app.Owner)
	}
	// 审计用与技能/智能体同一套动作名与明细格式（审计页可读）。
	logs, _, err := serverstore.ListAuditLogsPagedFiltered(e.db, 0, 20, "app_owner_transfer", "")
	if err != nil || len(logs) != 1 {
		t.Fatalf("归属转移必须写 app_owner_transfer 审计: %v %d", err, len(logs))
	}
	if logs[0].Detail == "" || !contains([]string{logs[0].AppID}, "handover-tool") {
		t.Fatalf("审计应带 app 维度与明细: %+v", logs[0])
	}
	// 转移后：原归属者发布被拒，新归属者可发布。
	p := e.payload("handover-tool", "1.1.0", testGuestModule(t), goodConfig())
	p["changelog"] = "换人后继续"
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/handover-tool/releases", e.tokens["alice"], p)
	e.decodeErr(w, http.StatusConflict)
	if w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/handover-tool/releases", e.tokens["bob"], p); w.Code != http.StatusCreated {
		t.Fatalf("新归属者应能发布: %d %s", w.Code, w.Body.String())
	}

	// 目标用户不存在 ⇒ 400；空 owner ⇒ 400；同归属 ⇒ 幂等。
	e.decodeErr(e.req(http.MethodPut, "/api/server/admin/wasm-apps/handover-tool/owner", "",
		map[string]any{"owner": "ghost"}), http.StatusBadRequest)
	e.decodeErr(e.req(http.MethodPut, "/api/server/admin/wasm-apps/handover-tool/owner", "",
		map[string]any{"owner": "  "}), http.StatusBadRequest)
	e.decodeJSON(e.req(http.MethodPut, "/api/server/admin/wasm-apps/handover-tool/owner", "",
		map[string]any{"owner": "bob"}), http.StatusOK, &out)
	if out.App.Changed {
		t.Fatal("同归属应幂等（changed=false）")
	}
}

// TestAdminFreezeUnfreeze 管理员冻结/解冻。
func TestAdminFreezeUnfreeze(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "ops-freeze", "1.0.0", testGuestModule(t), goodConfig())

	var out struct {
		App struct {
			Frozen  bool `json:"frozen"`
			Enabled bool `json:"enabled"`
		} `json:"app"`
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/ops-freeze/freeze", "", nil), http.StatusOK, &out)
	if !out.App.Frozen || out.App.Enabled {
		t.Fatalf("冻结应同时下架: %+v", out.App)
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "ops-freeze")
	if app.FrozenAt == nil {
		t.Fatal("frozen_at 未落库")
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/ops-freeze/freeze", "",
		map[string]any{"frozen": false}), http.StatusOK, &out)
	if out.App.Frozen {
		t.Fatal("解冻后 frozen 应为 false")
	}
	app, _ = serverstore.GetWasmApp(t.Context(), e.db, "ops-freeze")
	if app.FrozenAt != nil {
		t.Fatal("frozen_at 应被清空")
	}
}

// TestAdminReviewSwitchValidation 审核开关的入参校验（写路径只认显式布尔）。
func TestAdminReviewSwitchValidation(t *testing.T) {
	e := newTestEnv(t)
	w := e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", map[string]any{})
	eb := e.decodeErr(w, http.StatusBadRequest)
	if eb.Error.Code != "VALIDATION" {
		t.Fatalf("缺 required 应回 VALIDATION: %s", w.Body.String())
	}
	// 非法 JSON 也是 400（不是 500）。
	w = e.req(http.MethodPut, "/api/server/admin/wasm-apps/review", "", "{not json")
	e.decodeErr(w, http.StatusBadRequest)
}

// TestAppstoreTransferOwnerAcceptsWasmApp 是 §11 第 17 项的授权改动判据：
// `appstore/admin.go` 的 kind 白名单放开到含 wasm_app（此前硬写 skill/agent ⇒ 400）。
//
// 该端点属于 appstore（模块归属不在本包），但白名单是本模块的交付内容之一，
// 因此这里挂**生产路径**做端到端断言：不再 400，且归属真的改了。
func TestAppstoreTransferOwnerAcceptsWasmApp(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "shared-admin-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodPut, "/api/server/admin/apps/wasm_app/shared-admin-tool/owner", "", map[string]any{"owner": "bob"})
	if w.Code == http.StatusBadRequest {
		t.Fatalf("wasm_app 不该再因 kind 白名单被 400: %s", w.Body.String())
	}
	e.decodeJSON(w, http.StatusOK, &struct {
		OK    bool   `json:"ok"`
		Owner string `json:"owner"`
	}{})
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "shared-admin-tool")
	if app.Owner != "bob" {
		t.Fatalf("归属未转移: %s", app.Owner)
	}
	// 未知 kind 仍被拒（白名单没有变成"什么都收"）。
	e.decodeErr(e.req(http.MethodPut, "/api/server/admin/apps/bogus_kind/shared-admin-tool/owner", "",
		map[string]any{"owner": "bob"}), http.StatusBadRequest)
}

// TestAdminBaseDomainGetPut 覆盖「管理端配置应用泛域名」的读写面
// （2026-09-18 用户要求：应用名 + 泛域名 = 应用访问地址）。
//
// 判据：
//   - GET 回控制台要用的完整视图（当前值 / 来源 / 是否启用 / 可直接展示的 URL 模板）；
//   - PUT 保存后立即回读新值，并写**组织级**审计（基域是组织级配置，没有 app 维度）；
//   - 校验失败与"注入侧拒绝"都必须原样回 §8 信封（带 code/hints），不能吞成 500；
//   - 缺 body 字段要 400 而不是静默清空（清空 = 关闭子域，必须显式）。
func TestAdminBaseDomainGetPut(t *testing.T) {
	applied := ""
	rejectNext := false
	e := newTestEnv(t, func(o *Options) {
		o.BaseDomain = func() string { return applied }
		o.BaseDomainSource = func() string {
			if applied == "" {
				return "none"
			}
			return "setting"
		}
		o.ApplyBaseDomain = func(next string) *apperr.Error {
			if rejectNext {
				return apperr.New(apperr.CodeValidation, "模拟注入侧拒绝").
					WithDetail("reason", "guard_failed").
					WithHint("这条 hint 必须原样到控制台")
			}
			applied = next
			return nil
		}
	})

	// ① 初始（未启用）：enabled=false，url_pattern 为空。
	var got struct {
		BaseDomain string `json:"base_domain"`
		Source     string `json:"source"`
		Enabled    bool   `json:"enabled"`
		URLPattern string `json:"url_pattern"`
		SettingKey string `json:"setting_key"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/server/admin/wasm-apps/domain", "", nil), http.StatusOK, &got)
	if got.Enabled || got.URLPattern != "" || got.Source != "none" || got.SettingKey != SettingAppsBaseDomain {
		t.Fatalf("未启用时的视图不对: %+v", got)
	}

	// ② 保存：回读新值 + 可直接展示的 URL 模板。
	e.decodeJSON(e.req(http.MethodPut, "/api/server/admin/wasm-apps/domain", "", map[string]any{
		"base_domain": "apps.example.com",
	}), http.StatusOK, &got)
	if got.BaseDomain != "apps.example.com" || !got.Enabled || got.Source != "setting" {
		t.Fatalf("保存后视图不对: %+v", got)
	}
	if got.URLPattern != "https://<app_id>.apps.example.com" {
		t.Fatalf("URL 模板不对: %q", got.URLPattern)
	}
	// 审计：组织级动作（wasm_apps_base_domain_change），明细带旧值→新值。
	logs, _, err := serverstore.ListAuditLogsPagedFiltered(e.db, 0, 50, "wasm_apps_base_domain_change", "")
	if err != nil {
		t.Fatalf("读审计失败: %v", err)
	}
	if len(logs) == 0 {
		t.Fatal("基域变更必须写审计")
	}
	if !strings.Contains(logs[0].Detail, "apps.example.com") {
		t.Fatalf("审计明细应含新值: %q", logs[0].Detail)
	}

	// ③ 缺字段 ⇒ 400（清空必须显式传空串，不能靠漏传）。
	eb := e.decodeErr(e.req(http.MethodPut, "/api/server/admin/wasm-apps/domain", "", map[string]any{}), http.StatusBadRequest)
	if eb.Error.Code != string(apperr.CodeValidation) {
		t.Fatalf("缺 base_domain 的 code = %s", eb.Error.Code)
	}

	// ④ 注入侧拒绝 ⇒ 原样透传（code/details/hints）。
	rejectNext = true
	eb = e.decodeErr(e.req(http.MethodPut, "/api/server/admin/wasm-apps/domain", "", map[string]any{
		"base_domain": "apps.example.com",
	}), http.StatusBadRequest)
	if reason, _ := eb.Error.Details["reason"].(string); reason != "guard_failed" {
		t.Fatalf("注入侧拒绝的 details 丢了: %+v", eb.Error.Details)
	}
	if len(eb.Error.Hints) == 0 || !strings.Contains(eb.Error.Hints[0], "原样到控制台") {
		t.Fatalf("注入侧拒绝的 hints 丢了: %+v", eb.Error.Hints)
	}
	if applied != "apps.example.com" {
		t.Fatalf("被拒的保存不该生效: %q", applied)
	}
}

// TestAdminPublishIsSymmetricToUnpublish 管理面必须能"上架"（2026-09-18 补）。
//
// 为什么要有：下架是管理员的**处置**动作，处置完必须能恢复；只给下架等于让管理员
// 把应用"关掉就再也打不开"（客户端面的上架只有发布者能调）。与下架严格对称：
// 同一审计动作名、同样幂等（未变更 ⇒ changed:false 且不写第二条审计）。
func TestAdminPublishIsSymmetricToUnpublish(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "revive-tool", "1.0.0", testGuestModule(t), goodConfig())
	toggle := func() bool {
		var out struct {
			App struct {
				Enabled bool `json:"enabled"`
				Changed bool `json:"changed"`
			} `json:"app"`
		}
		e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/revive-tool/unpublish", "", nil), http.StatusOK, &out)
		if out.App.Enabled || !out.App.Changed {
			t.Fatalf("管理员下架结果不对: %+v", out.App)
		}
		app, _ := serverstore.GetWasmApp(t.Context(), e.db, "revive-tool")
		if app.Enabled {
			t.Fatal("下架后 apps.enabled 应为 0")
		}
		// 上架：回到可用状态，归属不变。
		e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/revive-tool/publish", "", nil), http.StatusOK, &out)
		if !out.App.Enabled || !out.App.Changed {
			t.Fatalf("管理员上架结果不对: %+v", out.App)
		}
		app, _ = serverstore.GetWasmApp(t.Context(), e.db, "revive-tool")
		if !app.Enabled {
			t.Fatal("上架后 apps.enabled 应为 1")
		}
		if app.Owner != "alice" {
			t.Fatalf("管理员处置不得改写归属: %s", app.Owner)
		}
		// 幂等：已是上架时 changed=false（且不重复写审计）。
		e.decodeJSON(e.req(http.MethodPost, "/api/server/admin/wasm-apps/revive-tool/publish", "", nil), http.StatusOK, &out)
		return out.App.Changed
	}
	if changed := toggle(); changed {
		t.Fatal("状态未变更时 changed 应为 false")
	}
	actions := e.auditActions("revive-tool")
	n := 0
	for _, a := range actions {
		if a == "wasm_app_publish_toggle" {
			n++
		}
	}
	// 一上一下 = 两条；幂等那次不写。
	if n != 2 {
		t.Fatalf("上架/下架各写一条审计（幂等不写），实际 %d 条: %v", n, actions)
	}
}
