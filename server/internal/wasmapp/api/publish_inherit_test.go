// 更新发布的配置语义（R1-pm-10 / R1-uxc-8）与"待审版本不投影"（R1-pm-9 /
// R1-pm-2 的入口链接）在**生产挂载路径**上的行为级护栏。
//
// 这里刻意全部走 HTTP 端点（同 helpers_test.go 的 mount：与 internal/router 逐条一致），
// 而不是直调内部函数：审计查出的缺陷都出现在"链路把两份配置的关系搞错"这一层。
//
// 判据与变异验证（改回旧实现必红，实跑对照见交付报告）：
//
//	① 更新时省略 access ⇒ 沿用上一版（whitelist 白名单**不放开**）
//	② 更新时显式 access=login ⇒ 真的改成 login（含目录徽标与审计）
//	③ 省略 purpose/data_sensitivity/owner ⇒ 沿用（apps 行三列不被清空）
//	④ 首版省略 access ⇒ 仍是 login（不回归）
//	⑤ 待审版本（status != approved）**不改** apps 行的配置投影（目录徽标不得提前变）
//	⑥ approve 与 reject 两条路径都把投影重算为"最新 approved 版本"的配置
//
// ⚠️ 原第 ⑦ 条（"基域未配置 ⇒ entry_url 省略"）已随 W4 作废：`entry_url` 字段本身
// 被删除（总纲 §8.4 / §5.2 冻结契约），判据改为"全仓零命中 + 响应里没有该键"。
package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// cfgWith 是"AI 照工具描述只给要改的字段"的载荷形态（其余字段**缺席**）。
func cfgWith(kv map[string]any) map[string]any { return kv }

// catalogAccess 读目录里某个应用的 access（员工视角；读的是 apps.config_json 投影）。
func (e *testEnv) catalogAccess(token, appID string) string {
	e.t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", token, nil)
	var out struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	for _, row := range out.Apps {
		if row["app_id"] == appID {
			got, _ := row["access"].(string)
			return got
		}
	}
	e.t.Fatalf("目录里没有 %s: %s", appID, w.Body.String())
	return ""
}

// TestPublishUpdateInheritsOmittedAccessFields 覆盖判据 ①③：
// 一个 access=whitelist 的应用发"纯代码更新"（config 只给三个声明）后，
// 线上访问级别与名单必须**一字不动**（旧实现会落成 login 并清空名单）。
func TestPublishUpdateInheritsOmittedAccessFields(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	base := cfgWith(map[string]any{
		"access":           "whitelist",
		"whitelist":        []string{"alice"},
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	})
	e.publishOK(e.tokens["alice"], "inherit-tool", "1.0.0", guest, base)

	// 更新版：只给三个声明 —— 完全不提 access / whitelist。
	p := e.payload("inherit-tool", "1.1.0", guest, cfgWith(map[string]any{
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}))
	p["changelog"] = "只修了一个 bug"
	e.decodeJSON(e.req(http.MethodPost, "/api/client/v2/apps/wasm/inherit-tool/releases",
		e.tokens["alice"], p), http.StatusCreated, &struct{}{})

	app, err := serverstore.GetWasmApp(t.Context(), e.db, "inherit-tool")
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessWhitelist {
		t.Fatalf("省略 access 的更新把线上访问级别改成了 %q（want whitelist）—— 白名单应用被静默放宽", got)
	}
	var stored appcfg.Config
	if jerr := json.Unmarshal([]byte(app.ConfigJSON), &stored); jerr != nil {
		t.Fatalf("apps.config_json 不是合法 JSON: %v", jerr)
	}
	if len(stored.Whitelist) != 1 || stored.Whitelist[0] != "alice" {
		t.Fatalf("缺席的 whitelist 应沿用上一版名单，得到 %v（旧实现清空名单）", stored.Whitelist)
	}
	// ③ 三个声明列也必须沿用（旧实现把它们清空）。
	if app.Purpose != "值班排班" || app.DataSensitivity != "internal" {
		t.Fatalf("缺席的声明列被清空: purpose=%q data_sensitivity=%q", app.Purpose, app.DataSensitivity)
	}

	// 版本行（交付给应用读的那份）与 apps 投影必须一致。
	rel, rerr := serverstore.GetWasmRelease(t.Context(), e.db, "inherit-tool", "1.1.0")
	if rerr != nil {
		t.Fatalf("读版本失败: %v", rerr)
	}
	var relCfg appcfg.Config
	if jerr := json.Unmarshal([]byte(rel.ConfigJSON), &relCfg); jerr != nil {
		t.Fatalf("版本 config_json 不是合法 JSON: %v", jerr)
	}
	if relCfg.Access != appcfg.AccessWhitelist || len(relCfg.Whitelist) != 1 {
		t.Fatalf("新版本的权威配置丢了访问级别/名单: %+v", relCfg)
	}
	// 应用自己读到的那份（assets/picoaide.app.json）同样必须带名单。
	raw, ferr := os.ReadFile(filepath.Join(e.dataRoot, limits.AppsDirName, "inherit-tool",
		assets.AssetsDirName, fmt.Sprint(rel.ID), limits.AppConfigFileName))
	if ferr != nil {
		t.Fatalf("读随包配置失败: %v", ferr)
	}
	var assetCfg appcfg.Config
	if jerr := json.Unmarshal(raw, &assetCfg); jerr != nil {
		t.Fatalf("随包配置不是合法 JSON: %v", jerr)
	}
	if assetCfg.Access != appcfg.AccessWhitelist {
		t.Fatalf("应用读到的 picoaide.app.json access = %q，want whitelist", assetCfg.Access)
	}
	if got := e.catalogAccess(e.tokens["bob"], "inherit-tool"); got != string(appcfg.AccessWhitelist) {
		t.Fatalf("目录徽标 access = %q，want whitelist", got)
	}
}

// TestPublishUpdateExplicitAccessReallyChanges 覆盖判据 ②：
// 显式写 access=login 必须真的改（继承不得覆盖显式值），并留一条访问模式变更审计。
func TestPublishUpdateExplicitAccessReallyChanges(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	base := cfgWith(map[string]any{
		"access":           "whitelist",
		"whitelist":        []string{"alice"},
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	})
	e.publishOK(e.tokens["alice"], "flip-tool", "1.0.0", guest, base)

	p := e.payload("flip-tool", "1.1.0", guest, cfgWith(map[string]any{
		"access":           "login", // 显式：登录后全员可用
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}))
	p["changelog"] = "放开给全员"
	e.decodeJSON(e.req(http.MethodPost, "/api/client/v2/apps/wasm/flip-tool/releases",
		e.tokens["alice"], p), http.StatusCreated, &struct{}{})

	app, err := serverstore.GetWasmApp(t.Context(), e.db, "flip-tool")
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessLogin {
		t.Fatalf("显式 access=login 没有生效（得到 %q）—— 继承覆盖了作者显式给的值", got)
	}
	if got := e.catalogAccess(e.tokens["bob"], "flip-tool"); got != string(appcfg.AccessLogin) {
		t.Fatalf("目录徽标 access = %q，want login", got)
	}
	details := e.auditDetails("flip-tool", "wasm_app_access_change")
	if len(details) != 1 {
		t.Fatalf("显式改访问级别应恰好写一条 wasm_app_access_change，得到 %v", details)
	}
	// 纯代码更新（省略 access）不该产生访问模式变更审计 —— 见下一条用例。
}

// TestPublishUpdateWithoutAccessChangeWritesNoAccessAudit 是 ① 的审计面：
// 沿用上一版 ⇒ 没有"变更"，因此不得写 wasm_app_access_change（旧实现会写一条
// whitelist→login 的变更，把一次静默放宽记录成"作者改了访问级别"）。
func TestPublishUpdateWithoutAccessChangeWritesNoAccessAudit(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "quiet-tool", "1.0.0", guest, cfgWith(map[string]any{
		"access":           "whitelist",
		"whitelist":        []string{"alice"},
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}))
	p := e.payload("quiet-tool", "1.1.0", guest, cfgWith(map[string]any{
		"purpose": "值班排班", "data_sensitivity": "internal", "owner": "张伟",
	}))
	p["changelog"] = "只修 bug"
	e.decodeJSON(e.req(http.MethodPost, "/api/client/v2/apps/wasm/quiet-tool/releases",
		e.tokens["alice"], p), http.StatusCreated, &struct{}{})
	if got := e.auditDetails("quiet-tool", "wasm_app_access_change"); len(got) != 0 {
		t.Fatalf("沿用上一版不该产生访问模式变更审计，得到 %v", got)
	}
}

// TestPublishFirstReleaseStillDefaultsToLogin 覆盖判据 ④：首版没有可继承的基线，
// 省略 access 仍落 login（"缺省=沿用上一版"不得改变首版语义）。
func TestPublishFirstReleaseStillDefaultsToLogin(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	p := e.payload("first-tool", "1.0.0", guest, cfgWith(map[string]any{
		"purpose": "新应用", "data_sensitivity": "internal", "owner": "张伟",
	}))
	e.decodeJSON(e.req(http.MethodPost, "/api/client/v2/apps/wasm/first-tool/releases",
		e.tokens["alice"], p), http.StatusCreated, &struct{}{})

	app, err := serverstore.GetWasmApp(t.Context(), e.db, "first-tool")
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessLogin {
		t.Fatalf("首版省略 access 应落缺省 login，得到 %q", got)
	}
	rel, rerr := serverstore.GetWasmRelease(t.Context(), e.db, "first-tool", "1.0.0")
	if rerr != nil {
		t.Fatalf("读版本失败: %v", rerr)
	}
	var cfg appcfg.Config
	if jerr := json.Unmarshal([]byte(rel.ConfigJSON), &cfg); jerr != nil {
		t.Fatalf("版本 config_json 不是合法 JSON: %v", jerr)
	}
	if cfg.Access != appcfg.AccessLogin {
		t.Fatalf("首版版本的权威配置 access = %q，want login", cfg.Access)
	}
}

// TestPendingReleaseDoesNotProjectConfigToCatalog 覆盖判据 ⑤（R1-pm-9）：
// 审核开启时，待审版本（access 改动）**不得**改 apps 行的配置投影 ——
// 目录对全员的徽标必须仍是生效版本（login）。
//
// 2026-09-19 契约 §4.4 起匿名面被删除，可写取值只剩 login|whitelist，
// 因此这里的"待审改动"用 whitelist（生效版本是 login）。
func TestPendingReleaseDoesNotProjectConfigToCatalog(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	live := cfgWith(map[string]any{
		"access":           "login",
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	})
	e.publishOK(e.tokens["alice"], "pending-tool", "1.0.0", guest, live)
	e.setReviewRequired(true)

	p := e.payload("pending-tool", "1.1.0", guest, cfgWith(map[string]any{
		"access":           "whitelist", // 待审：改成名单准入
		"whitelist":        []string{"alice"},
		"purpose":          "改成名单准入",
		"data_sensitivity": "public",
		"owner":            "张伟",
	}))
	p["changelog"] = "想改成名单准入"
	var out struct {
		Release map[string]any `json:"release"`
	}
	e.decodeJSON(e.req(http.MethodPost, "/api/client/v2/apps/wasm/pending-tool/releases",
		e.tokens["alice"], p), http.StatusCreated, &out)
	if out.Release["status"] != serverstore.ReleaseStatusPending || out.Release["current"] != false {
		t.Fatalf("审核开启时应停在 pending 且不生效: %+v", out.Release)
	}

	app, err := serverstore.GetWasmApp(t.Context(), e.db, "pending-tool")
	if err != nil {
		t.Fatalf("读应用失败: %v", err)
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessLogin {
		t.Fatalf("待审版本的 access 被提前投影到目录：投影=%q，而线上生效版本仍是 login", got)
	}
	if app.Purpose != "值班排班" || app.DataSensitivity != "internal" {
		t.Fatalf("待审版本的声明被提前投影: purpose=%q data_sensitivity=%q", app.Purpose, app.DataSensitivity)
	}
	if got := e.catalogAccess(e.tokens["bob"], "pending-tool"); got != string(appcfg.AccessLogin) {
		t.Fatalf("目录徽标 access = %q，want login（待审配置尚未生效）", got)
	}
	// 版本行自身仍要保留提交的配置（批准后由它生效）。
	rel, rerr := serverstore.GetWasmRelease(t.Context(), e.db, "pending-tool", "1.1.0")
	if rerr != nil {
		t.Fatalf("读版本失败: %v", rerr)
	}
	if got := appcfg.AccessOfConfigJSON(rel.ConfigJSON); got != appcfg.AccessWhitelist {
		t.Fatalf("待审版本自己的 config_json 应为提交值 whitelist，得到 %q", got)
	}
	// 审计口径：这不是"已生效"的变更（写"随 v1.1.0 生效"会让运维面读错）。
	details := e.auditDetails("pending-tool", "wasm_app_access_change")
	if len(details) != 1 || !strings.Contains(details[0], "待审") || !strings.Contains(details[0], "尚未生效") {
		t.Fatalf("待审版本的访问级别变更审计必须写明未生效，得到 %v", details)
	}
}

// TestReviewDecisionRecomputesProjectionFromLatestApproved 覆盖判据 ⑥：
// approve 与 reject 两条路径都把 apps 行的配置投影重算为"最新 approved 版本"。
//
// 为什么要在投影里先制造"脏"状态：这正是旧实现留下的形态（G1 无条件写投影）。
// 断言"审核之后投影 == 最新 approved 版本的配置"同时钉住两条路径 ——
// 少了 reject 侧的重算，被拒版本的配置会永久留在目录上。
func TestReviewDecisionRecomputesProjectionFromLatestApproved(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "proj-tool", "1.0.0", guest, cfgWith(map[string]any{
		"access":           "login",
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}))
	e.setReviewRequired(true)

	pendingJSON := `{"access":"login","whitelist":[],"purpose":"改成公开","data_sensitivity":"public","owner":"张伟"}`
	// ① reject：待审版本被拒 ⇒ 投影回到仍在生效的 1.0.0。
	e.publishOK(e.tokens["alice"], "proj-tool", "1.1.0", guest, cfgWith(map[string]any{
		"access": "login", "purpose": "改成公开", "data_sensitivity": "public", "owner": "张伟",
	}))
	e.dirtyProjection("proj-tool", pendingJSON, "改成公开", "public")
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/proj-tool/releases/1.1.0/reject", "", map[string]any{"reason": "再想想"}),
		http.StatusOK, &struct{}{})
	e.assertProjection("proj-tool", appcfg.AccessLogin, "值班排班", "internal")
	if got := e.catalogAccess(e.tokens["bob"], "proj-tool"); got != string(appcfg.AccessLogin) {
		t.Fatalf("拒绝后目录徽标 access = %q，want login（被拒版本从未生效）", got)
	}

	// ② approve：再审一个版本并通过 ⇒ 投影切到它（access/声明一起走）。
	e.publishOK(e.tokens["alice"], "proj-tool", "1.2.0", guest, cfgWith(map[string]any{
		"access": "login", "purpose": "改成公开", "data_sensitivity": "public", "owner": "张伟",
	}))
	e.dirtyProjection("proj-tool", `{"access":"login","whitelist":[],"purpose":"又改回去","data_sensitivity":"internal","owner":"张伟"}`,
		"又改回去", "internal")
	var decided struct {
		Status         string `json:"status"`
		CurrentVersion string `json:"current_version"`
	}
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/proj-tool/releases/1.2.0/approve", "", nil), http.StatusOK, &decided)
	if decided.Status != serverstore.ReleaseStatusApproved || decided.CurrentVersion != "1.2.0" {
		t.Fatalf("通过后的响应不对: %+v", decided)
	}
	e.assertProjection("proj-tool", appcfg.AccessLogin, "改成公开", "public")
	if got := e.catalogAccess(e.tokens["bob"], "proj-tool"); got != string(appcfg.AccessLogin) {
		t.Fatalf("通过后目录徽标 access = %q，want public", got)
	}

	// ③ 审批一个**更旧**的待审版本：不变量仍是"最新 approved"（不是本次审批的版本）。
	e.publishOK(e.tokens["alice"], "proj-tool", "1.3.0", guest, cfgWith(map[string]any{
		"access": "whitelist", "whitelist": []string{"alice"},
		"purpose": "只给白名单", "data_sensitivity": "internal", "owner": "张伟",
	}))
	e.dirtyProjection("proj-tool", `{"access":"login","whitelist":[],"purpose":"脏投影","data_sensitivity":"public","owner":"张伟"}`,
		"脏投影", "public")
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/proj-tool/releases/1.3.0/approve", "", nil), http.StatusOK, &decided)
	e.assertProjection("proj-tool", appcfg.AccessWhitelist, "只给白名单", "internal")
}

// dirtyProjection 直接改写 apps 行的配置投影，模拟旧实现（G1 无条件执行）留下的状态。
func (e *testEnv) dirtyProjection(appID, configJSON, purpose, sensitivity string) {
	e.t.Helper()
	if err := serverstore.SetWasmAppConfig(e.ctx(), e.db, appID, configJSON, purpose, sensitivity); err != nil {
		e.t.Fatalf("制造脏投影失败: %v", err)
	}
}

// assertProjection 断言 apps 行的三个投影列与期望一致。
func (e *testEnv) assertProjection(appID string, wantAccess appcfg.Access, wantPurpose, wantSensitivity string) {
	e.t.Helper()
	app, err := serverstore.GetWasmApp(e.ctx(), e.db, appID)
	if err != nil {
		e.t.Fatalf("读应用失败: %v", err)
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != wantAccess {
		e.t.Fatalf("%s 的 access 投影 = %q, want %q（审核必须把投影重算为最新 approved 版本）",
			appID, got, wantAccess)
	}
	if app.Purpose != wantPurpose || app.DataSensitivity != wantSensitivity {
		e.t.Fatalf("%s 的声明投影 = (%q, %q), want (%q, %q)",
			appID, app.Purpose, app.DataSensitivity, wantPurpose, wantSensitivity)
	}
}

// ⚠️ `TestEntryURLIsAbsentWhenBaseDomainUnset` 已随 W4 删除：`entry_url` 不再存在
// （总纲 §8.4 / §5.2 冻结契约），因此"基域未配置时省略字段 / 配好后给出链接"这一对
// 判据整体作废。替代判据 = 全仓 `entry_url` 零命中（L4 的
// `scripts/wasm/check-old-model-residue.mjs`，分类 `entry-url`）+ 本包
// `TestPublishResponseHasNoEntryURL`（正向断言响应里没有该键，见 publish_test.go）。
