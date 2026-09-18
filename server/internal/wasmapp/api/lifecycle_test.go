package api

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ===========================================================================
// §8 上下架 / 冻结 / 删除 / 导出（R37）
// ===========================================================================

// TestSetPublishedToggle 覆盖上下架（复用 apps.enabled，发布者自主）。
func TestSetPublishedToggle(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "toggle-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/toggle-tool/unpublish", e.tokens["alice"], nil)
	var out struct {
		App struct {
			Enabled bool `json:"enabled"`
			Changed bool `json:"changed"`
		} `json:"app"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if out.App.Enabled || !out.App.Changed {
		t.Fatalf("下架结果不对: %+v", out.App)
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "toggle-tool")
	if app.Enabled {
		t.Fatal("apps.enabled 应为 0")
	}
	if !contains(e.auditActions("toggle-tool"), "wasm_app_publish_toggle") {
		t.Fatalf("上下架要留痕: %v", e.auditActions("toggle-tool"))
	}

	// 幂等：再下架一次不报错、不重复写审计。
	before := len(e.auditActions("toggle-tool"))
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/toggle-tool/unpublish", e.tokens["alice"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if out.App.Changed {
		t.Fatal("状态未变更时 changed 应为 false")
	}
	if after := len(e.auditActions("toggle-tool")); after != before {
		t.Fatalf("幂等调用不该新增审计: %d → %d", before, after)
	}

	// 重新上架。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/toggle-tool/publish", e.tokens["alice"], nil)
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.App.Enabled || !out.App.Changed {
		t.Fatalf("上架结果不对: %+v", out.App)
	}

	// 他人不得上下架（管理平面：非发布者 ⇒ 与不存在同形）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/toggle-tool/unpublish", e.tokens["bob"], nil)
	eb := e.decodeErr(w, http.StatusNotFound)
	if eb.Error.Code != "NOT_FOUND" {
		t.Fatalf("code = %s, want NOT_FOUND（不泄露存在性）", eb.Error.Code)
	}
	// 管理员可以（R23 兜底）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/toggle-tool/unpublish", e.tokens["boss"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("管理员应能下架: %d %s", w.Code, w.Body.String())
	}
}

// TestFreezeAlsoUnpublishesAndBlocksPublish 是"冻结是否同时下架"这条决定的判据：
// 冻结 = 停止服务 ⇒ 同时把 enabled 置 0（否则只查 enabled 的读取路径会继续服务）；
// 解冻**不**自动上架（fail-closed：不能让一次解冻把发布者主动下架的应用恢复）。
func TestFreezeAlsoUnpublishesAndBlocksPublish(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "freeze-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/freeze-tool/freeze", e.tokens["alice"], nil)
	var out struct {
		App struct {
			Frozen  bool `json:"frozen"`
			Enabled bool `json:"enabled"`
			Changed bool `json:"changed"`
		} `json:"app"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	if !out.App.Frozen || out.App.Enabled || !out.App.Changed {
		t.Fatalf("冻结应同时下架: %+v", out.App)
	}
	app, _ := serverstore.GetWasmApp(t.Context(), e.db, "freeze-tool")
	if app.FrozenAt == nil {
		t.Fatal("frozen_at 必须落库（appserver 据此停止服务）")
	}
	if !contains(e.auditActions("freeze-tool"), "wasm_app_freeze") {
		t.Fatalf("冻结要留痕: %v", e.auditActions("freeze-tool"))
	}

	// 冻结期间不得发布新版本（R37：冻结即停服）。
	p := e.payload("freeze-tool", "1.1.0", testGuestModule(t), goodConfig())
	p["changelog"] = "试试"
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/freeze-tool/releases", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusForbidden)
	if eb.Error.Code != "APP_FROZEN" {
		t.Fatalf("code = %s, want APP_FROZEN", eb.Error.Code)
	}
	if n := e.countReleases("freeze-tool"); n != 1 {
		t.Fatalf("冻结期间发布不得落行: %d", n)
	}

	// 解冻：清 frozen_at，但**不**自动上架。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/freeze-tool/freeze", e.tokens["alice"],
		map[string]any{"frozen": false})
	e.decodeJSON(w, http.StatusOK, &out)
	if out.App.Frozen || out.App.Enabled {
		t.Fatalf("解冻不应自动上架: %+v", out.App)
	}
	app, _ = serverstore.GetWasmApp(t.Context(), e.db, "freeze-tool")
	if app.FrozenAt != nil {
		t.Fatal("frozen_at 应被清空")
	}
	// 解冻后可以发布新版本，但 enabled 不变（发布 ≠ 上架，§8）。
	p = e.payload("freeze-tool", "1.1.0", testGuestModule(t), goodConfig())
	p["changelog"] = "解冻后再发一版"
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/freeze-tool/releases", e.tokens["alice"], p)
	if w.Code != http.StatusCreated {
		t.Fatalf("解冻后应能发布: %d %s", w.Code, w.Body.String())
	}
	app, _ = serverstore.GetWasmApp(t.Context(), e.db, "freeze-tool")
	if app.Enabled {
		t.Fatal("发布新版本不得顺手把应用上架（上下架是独立动作）")
	}
}

// TestDeleteIsSoftAndExportStillWorks 覆盖 R37 的删除语义：软删（标识/版本号永久
// 占位）+ 冻结时间锚点 + 保留期内仍可导出。
func TestDeleteIsSoftAndExportStillWorks(t *testing.T) {
	e := newTestEnv(t)
	rel := e.publishOK(e.tokens["alice"], "retire-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodDelete, "/api/client/v2/apps/wasm/retire-tool", e.tokens["alice"], nil)
	var del struct {
		App struct {
			Deleted bool `json:"deleted"`
		} `json:"app"`
		RetentionDays int `json:"retention_days"`
	}
	e.decodeJSON(w, http.StatusOK, &del)
	if !del.App.Deleted || del.RetentionDays == 0 {
		t.Fatalf("删除响应不对: %+v", del)
	}
	app, err := serverstore.GetWasmApp(t.Context(), e.db, "retire-tool")
	if err != nil || app.DeletedAt == nil {
		t.Fatalf("应是软删（行还在）：%+v %v", app, err)
	}
	if app.FrozenAt == nil {
		t.Fatal("删除必须留下冻结时间锚点（R37 的保留期从冻结时刻算）")
	}
	if app.Enabled {
		t.Fatal("已删除的应用必须处于下架状态")
	}
	if !contains(e.auditActions("retire-tool"), "wasm_app_delete") {
		t.Fatalf("删除要留痕: %v", e.auditActions("retire-tool"))
	}
	// 版本号与标识永久占位：新发布被拒。
	p := e.payload("retire-tool", "2.0.0", testGuestModule(t), goodConfig())
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/retire-tool/releases", e.tokens["alice"], p)
	e.decodeErr(w, http.StatusNotFound)
	// 重复删除 ⇒ 与不存在同形。
	w = e.req(http.MethodDelete, "/api/client/v2/apps/wasm/retire-tool", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusNotFound)
	// 目录不再列出。
	var cat struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", e.tokens["alice"], nil), http.StatusOK, &cat)
	for _, a := range cat.Apps {
		if a["app_id"] == "retire-tool" {
			t.Fatal("已删除的应用不得出现在目录里")
		}
	}
	// 但保留期内仍可导出（R37 的"冻结 → 90 天内可导出"）。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/retire-tool/export", e.tokens["alice"], nil)
	if w.Code != http.StatusOK {
		t.Fatalf("已退役应用在保留期内必须可导出: %d %s", w.Code, w.Body.String())
	}
	// 已退役应用不能再被处置（写动作）。
	w = e.req(http.MethodPost, "/api/client/v2/apps/wasm/retire-tool/freeze", e.tokens["alice"], nil)
	e.decodeErr(w, http.StatusNotFound)
	_ = rel
}

// TestManagementPlaneOwnerIsolation 把"非发布者一律 404"这条规则在**全部**
// 管理动作上钉死（只读 + 写）。
func TestManagementPlaneOwnerIsolation(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "mine-tool", "1.0.0", testGuestModule(t), goodConfig())
	cases := []struct{ method, path string }{
		{http.MethodGet, "/api/client/v2/apps/wasm/mine-tool/export"},
		{http.MethodGet, "/api/client/v2/apps/wasm/mine-tool/diagnostics"},
		{http.MethodGet, "/api/client/v2/apps/wasm/mine-tool/schema"},
		{http.MethodPost, "/api/client/v2/apps/wasm/mine-tool/freeze"},
		{http.MethodPost, "/api/client/v2/apps/wasm/mine-tool/unpublish"},
		{http.MethodDelete, "/api/client/v2/apps/wasm/mine-tool"},
	}
	for _, tc := range cases {
		w := e.req(tc.method, tc.path, e.tokens["bob"], nil)
		eb := e.decodeErr(w, http.StatusNotFound)
		if eb.Error.Code != "NOT_FOUND" {
			t.Fatalf("%s %s: code = %s, want NOT_FOUND", tc.method, tc.path, eb.Error.Code)
		}
		if w.Body.String() == "" {
			t.Fatalf("%s %s: 404 必须有 JSON 信封", tc.method, tc.path)
		}
	}
	// 不存在的应用与"不是你的"必须**同形**（同状态、同 code）。
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/no-such-app/export", e.tokens["bob"], nil)
	missing := e.decodeErr(w, http.StatusNotFound)
	if missing.Error.Code != "NOT_FOUND" {
		t.Fatalf("不存在的应用 code = %s", missing.Error.Code)
	}
}

// TestExportContentsAndBoundaries 覆盖 R37 的导出：只读快照（控制面元数据），
// 只对发布者/管理员开放，且**不含任何使用者数据**。
func TestExportContentsAndBoundaries(t *testing.T) {
	e := newTestEnv(t)
	e.publishOK(e.tokens["alice"], "exp-tool", "1.0.0", testGuestModule(t), goodConfig())

	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/exp-tool/export", e.tokens["alice"], nil)
	if ct := w.Header().Get("Content-Disposition"); ct == "" {
		t.Fatal("导出应带 Content-Disposition（attachment）")
	}
	var doc struct {
		Export struct {
			Format string `json:"format"`
			App    struct {
				AppID          string          `json:"app_id"`
				Owner          string          `json:"owner"`
				CurrentVersion string          `json:"current_version"`
				Config         json.RawMessage `json:"config"`
			} `json:"app"`
			Releases []struct {
				Version string `json:"version"`
				Status  string `json:"status"`
				Current bool   `json:"current"`
				Config  json.RawMessage
			} `json:"releases"`
			Database struct {
				Included bool   `json:"included"`
				Why      string `json:"why"`
			} `json:"database"`
			Retention struct {
				SnapshotDays int `json:"snapshot_days"`
			} `json:"retention"`
		} `json:"export"`
	}
	e.decodeJSON(w, http.StatusOK, &doc)
	if doc.Export.Format != "picoaide.wasm-app-export/1" {
		t.Fatalf("format = %q", doc.Export.Format)
	}
	if doc.Export.App.AppID != "exp-tool" || doc.Export.App.Owner != "alice" || doc.Export.App.CurrentVersion != "1.0.0" {
		t.Fatalf("app 段不对: %+v", doc.Export.App)
	}
	if len(doc.Export.Releases) != 1 || !doc.Export.Releases[0].Current {
		t.Fatalf("releases 段不对: %+v", doc.Export.Releases)
	}
	if len(doc.Export.App.Config) == 0 {
		t.Fatal("导出应包含生效配置")
	}
	// 边界：应用库（使用者数据）必须**不在**导出里，只给获取说明。
	if doc.Export.Database.Included {
		t.Fatal("导出不得包含应用库内容（可能是使用者的个人信息）")
	}
	if doc.Export.Database.Why == "" {
		t.Fatal("应说明为什么不含库内容")
	}
	if doc.Export.Retention.SnapshotDays == 0 {
		t.Fatal("应给出 R37 的快照保留期")
	}
	if !contains(e.auditActions("exp-tool"), "wasm_app_export") {
		t.Fatalf("导出要留痕: %v", e.auditActions("exp-tool"))
	}
	// 管理员可导出（R37 原话："管理员可导出"）。
	if w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/exp-tool/export", e.tokens["boss"], nil); w.Code != http.StatusOK {
		t.Fatalf("管理员应可导出: %d", w.Code)
	}
	// 他人不可。
	w = e.req(http.MethodGet, "/api/client/v2/apps/wasm/exp-tool/export", e.tokens["bob"], nil)
	e.decodeErr(w, http.StatusNotFound)
}
