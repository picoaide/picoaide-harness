// 继承基线 = **最新 approved 版本**的 config_json（审计 2026-09-19 §1.2 / §1.4），
// 在**生产挂载路径**（HTTP 端点 + 真库）上的行为级护栏。
//
// 为什么单独一个文件：本组判据全部关于"基线取自哪一列/哪一版"，与
// publish_inherit_test.go 的"字段缺席才继承"是两条独立命题 —— 把基线的真源改回
// `apps.config_json`（或改成"最新一次提交"）时，那个文件里的用例**全都还是绿的**，
// 只有这里会红。
//
// 判据：
//
//	① 首版待审 ⇒ apps 行的投影列**保持空/占位**（配置三列 = "没有可交付配置"，
//	   title = app_id 占位、description 空；R2-1）；owner/enabled 等平台列照写；
//	   approve 后由审核分支把配置与显示面一起写进去
//	② 首版被拒（没有任何 approved 版本）⇒ 下一版省略 access **不得**继承被拒版本的
//	   配置：即使 apps.config_json 里还留着那行（老实现/人工改动的形态），也必须落 login
//	③ 已有 approved 版本 ⇒ 更新省略 access 继承的是**那一版**：
//	   - 不是 apps.config_json（脏投影时两者不同）；
//	   - 不是"最新一次提交"（更新的待审版本不作数）
//	④ 基线**不可用**（生效版本 config_json 是坏行）⇒ 拒绝发布**并点名是哪一版**，
//	   不落行；预检（validate）与发布同口径
//	⑤ 生效版本没有配置（空 config_json）不算"坏基线"：按无基线处理（缺省 login）
//
// 变异验证（实跑记录见交付报告）：
//   - inheritBase 改回 `existing.ConfigJSON`（apps.config_json）⇒ ②③ 红；
//   - 基线改成"最新一次发布（含待审）"⇒ ③ 的第二半红；
//   - E1 的 UPSERT 改回无条件写 config_json/purpose/data_sensitivity ⇒ ① 红；
//   - 去掉"基线不可用 ⇒ 拒绝"（回落 login）⇒ ④ 红。
package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
)

// releaseConfig 读某个版本行的**权威配置**（= 应用 assets.read 读到的那一份同源）。
func (e *testEnv) releaseConfig(appID, version string) appcfg.Config {
	e.t.Helper()
	rel, err := serverstore.GetWasmRelease(e.ctx(), e.db, appID, version)
	if err != nil {
		e.t.Fatalf("读版本 %s v%s 失败: %v", appID, version, err)
	}
	var cfg appcfg.Config
	if jerr := json.Unmarshal([]byte(rel.ConfigJSON), &cfg); jerr != nil {
		e.t.Fatalf("版本 config_json 不是合法 JSON: %q", rel.ConfigJSON)
	}
	return cfg
}

// appRow 读 apps 行（投影三列 + 身份列）。
func (e *testEnv) appRow(appID string) *serverstore.WasmApp {
	e.t.Helper()
	app, err := serverstore.GetWasmApp(e.ctx(), e.db, appID)
	if err != nil {
		e.t.Fatalf("读应用 %s 失败: %v", appID, err)
	}
	return app
}

// declarationsOnly 是"AI 照工具契约省略未改动字段"的提交形态（三个声明照给）。
func declarationsOnly() map[string]any {
	return map[string]any{"purpose": "值班排班", "data_sensitivity": "internal", "owner": "张伟"}
}

// whitelistConfig 是"线上是白名单应用"的基线形态。
func whitelistConfig() map[string]any {
	return map[string]any{
		"access":           "whitelist",
		"whitelist":        []string{"alice", "bob"},
		"purpose":          "值班排班",
		"data_sensitivity": "internal",
		"owner":            "张伟",
	}
}

// TestPendingFirstReleaseDoesNotSeedAppsConfigProjection 覆盖判据 ①：
// 首版待审时 apps 行的配置投影必须**保持空**（"没有可交付配置"），
// 而应用身份列仍要能被列表/详情读到；approve 时由审核分支按最新 approved 版本写入。
//
// 变异：E1 的 UPSERT 改回无条件写 config_json/purpose/data_sensitivity ⇒ 本例第一条断言红。
func TestPendingFirstReleaseDoesNotSeedAppsConfigProjection(t *testing.T) {
	e := newTestEnv(t)
	e.setReviewRequired(true)
	guest := testGuestModule(t)

	rel := e.publishOK(e.tokens["alice"], "seed-tool", "1.0.0", guest, cfgWith(map[string]any{
		"access": "public", "purpose": "值班排班", "data_sensitivity": "internal", "owner": "张伟",
	}))
	if rel["status"] != serverstore.ReleaseStatusPending {
		t.Fatalf("审核开启时首版应停在 pending，得到 %v", rel["status"])
	}

	app := e.appRow("seed-tool")
	// 待审版本的配置**不是**可交付配置（它没有经过任何人批准）⇒ 三列都不得落值。
	if app.ConfigJSON != "" || app.Purpose != "" || app.DataSensitivity != "" {
		t.Fatalf("首版待审不得把未生效配置写进 apps 行（老实现会，且它随后会成为继承基线）: "+
			"config=%q purpose=%q sensitivity=%q", app.ConfigJSON, app.Purpose, app.DataSensitivity)
	}
	// 身份列也要按同一条纪律处理（R2-1，2026-09-19 第二轮审计 §1.1）：待审版本的
	// title/description **不进投影**，首版用 app_id 占位（非空 —— read.go 对 title
	// 没有兜底，空标题会先出现在管理面/导出里）。owner/enabled 是平台归属与上架位，
	// 与"内容是否过审"无关，照写。
	if app.Title != "seed-tool" || app.Description != "" || app.Owner != "alice" || !app.Enabled {
		t.Fatalf("首版待审的显示面投影应停在 app_id 占位（不写待审标题/描述），实际: %+v", app)
	}
	// 空投影下的读取兜底必须成立：access 回落 login（不是"未知"、更不是 public），负责人回落平台归属。
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessLogin {
		t.Fatalf("空 config_json 的 access 兜底 = %q，want login", got)
	}
	// 版本行自己保留提交的配置（批准后由它生效）—— "不投影"不等于"不保存"。
	if cfg := e.releaseConfig("seed-tool", "1.0.0"); cfg.Access != appcfg.AccessPublic {
		t.Fatalf("版本行应保留提交的 access=public，得到 %q", cfg.Access)
	}

	// approve ⇒ 审核分支把投影按最新 approved 版本写入（那条路径本就存在，不能被这次收口破坏）。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/seed-tool/releases/1.0.0/approve", "", nil), http.StatusOK, &struct{}{})
	after := e.appRow("seed-tool")
	if got := appcfg.AccessOfConfigJSON(after.ConfigJSON); got != appcfg.AccessPublic {
		t.Fatalf("通过审核后投影 access = %q，want public（审核分支必须补上投影）", got)
	}
	if after.Purpose != "值班排班" || after.DataSensitivity != "internal" {
		t.Fatalf("通过审核后声明投影 = (%q, %q)，want (值班排班, internal)", after.Purpose, after.DataSensitivity)
	}
	// 显示面投影也由审核分支落到该版本行上（R2-1 —— 待审期间它们是占位/空）。
	if after.Title != "示例应用 seed-tool" || after.Description != "值班排班" {
		t.Fatalf("通过审核后显示面投影 = (%q, %q)，want (示例应用 seed-tool, 值班排班)：%+v",
			after.Title, after.Description, after)
	}
}

// TestRejectedFirstReleaseConfigIsNotInherited 覆盖判据 ②（审计 §1.2 的 P1 主场景）：
// 首版（access=public）被管理员拒 ⇒ 作者再发一版、按工具契约省略 access ⇒
// 必须落缺省 login，**不能**继承那份被拒的 public。
//
// 判据的分辨力来自"脏投影"这一步：它正是老实现留在升级上来的库里的形态
// （首版待审时 E1 就把 config 写进了 apps.config_json）。基线若取自那一列，
// 本例必然继承到 public —— 也就是"没人批准过的配置成了后续版本的默认值"。
func TestRejectedFirstReleaseConfigIsNotInherited(t *testing.T) {
	e := newTestEnv(t)
	e.setReviewRequired(true)
	guest := testGuestModule(t)

	// v1：首版提交 access=public（待审）。
	e.publishOK(e.tokens["alice"], "poison-tool", "1.0.0", guest, cfgWith(map[string]any{
		"access": "public", "purpose": "先别上线", "data_sensitivity": "public", "owner": "张伟",
	}))
	// 管理员拒绝：首版被拒 ⇒ 该应用**没有任何** approved 版本。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/poison-tool/releases/1.0.0/reject", "",
		map[string]any{"reason": "先别上线"}), http.StatusOK, &struct{}{})
	if e.countReleases("poison-tool") != 1 {
		t.Fatalf("前置失败：被拒版本应仍占行，实际 %d 行", e.countReleases("poison-tool"))
	}
	// 模拟"老实现留下的列状态"：被拒版本的配置曾躺在 apps.config_json 里
	// （审计实测：E1 的 INSERT 分支写过它，reject 路径在无 approved 版本时不重算）。
	e.dirtyProjection("poison-tool",
		`{"access":"public","whitelist":[],"purpose":"先别上线","data_sensitivity":"public","owner":"张伟"}`,
		"先别上线", "public")

	// v2：省略 access（工具契约允许"未改动的可以省略"）。
	e.publishOK(e.tokens["alice"], "poison-tool", "1.1.0", guest, declarationsOnly())

	if cfg := e.releaseConfig("poison-tool", "1.1.0"); cfg.Access != appcfg.AccessLogin {
		t.Fatalf("v2 省略 access 继承了**被拒版本**的 %q —— 未经批准的配置成了后续版本的默认值（应落缺省 login）",
			cfg.Access)
	}
	if cfg := e.releaseConfig("poison-tool", "1.1.0"); len(cfg.Whitelist) != 0 {
		t.Fatalf("v2 不该继承任何名单，得到 %v", cfg.Whitelist)
	}
	// 待审提交同样不改投影（这一行脏值不会因此"转正"）。
	if got := appcfg.AccessOfConfigJSON(e.appRow("poison-tool").ConfigJSON); got != appcfg.AccessPublic {
		t.Fatalf("待审提交不该改投影，得到 %q", got)
	}
	// 审计不得把这次"没发生的变更"记成一次访问级别变更：继承基线仍是"没有生效版本"
	// ⇒ 旧值 = login（缺省），新值也是 login ⇒ 无记录。
	if got := e.auditDetails("poison-tool", "wasm_app_access_change"); len(got) != 0 {
		t.Fatalf("没有生效版本时的缺省 login 不该被记成一次访问级别变更，得到 %v", got)
	}
}

// TestUpdateInheritsLatestApprovedNotAppsProjection 覆盖判据 ③ 的第一半：
// 已有 approved 版本时，继承基线是**那一版**，不是 apps.config_json 投影列。
//
// 变异：inheritBase 改回 `existing.ConfigJSON` ⇒ 本例红（继承到脏投影里的 public）。
func TestUpdateInheritsLatestApprovedNotAppsProjection(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "base-tool", "1.0.0", guest, whitelistConfig())

	// 脏投影：把显示列改成 public（老实现/人工改动留下的形态）。
	e.dirtyProjection("base-tool",
		`{"access":"public","whitelist":[],"purpose":"脏投影","data_sensitivity":"public","owner":"张伟"}`,
		"脏投影", "public")

	// 纯代码更新：省略 access/whitelist，只给三个声明。
	e.publishOK(e.tokens["alice"], "base-tool", "1.1.0", guest, declarationsOnly())

	cfg := e.releaseConfig("base-tool", "1.1.0")
	if cfg.Access != appcfg.AccessWhitelist {
		t.Fatalf("省略 access 的更新继承到 %q，want whitelist（基线应是生效版本，而不是脏投影）", cfg.Access)
	}
	if len(cfg.Whitelist) != 2 || cfg.Whitelist[0] != "alice" || cfg.Whitelist[1] != "bob" {
		t.Fatalf("名单应沿用生效版本，得到 %v", cfg.Whitelist)
	}
	// 生效之后投影被 G1 重写成"本次合并结果"（同一份配置），目录徽标回到 whitelist。
	if got := appcfg.AccessOfConfigJSON(e.appRow("base-tool").ConfigJSON); got != appcfg.AccessWhitelist {
		t.Fatalf("生效版本的投影 access = %q，want whitelist", got)
	}
}

// TestUpdateInheritsFromApprovedNotFromPendingNewer 覆盖判据 ③ 的第二半：
// 基线的真源是"最新 approved"，**不是**"最新一次提交" —— 一个更新的待审版本
// （没人批准过）不得成为下一版的默认值。
func TestUpdateInheritsFromApprovedNotFromPendingNewer(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "mix-tool", "1.0.0", guest, whitelistConfig())
	e.setReviewRequired(true)

	// v1.1.0 待审：提交成了 public（没人批准）。
	e.publishOK(e.tokens["alice"], "mix-tool", "1.1.0", guest, goodConfig())

	// v1.2.0 省略 access ⇒ 只能沿用 approved 的 v1.0.0（whitelist + 名单）。
	e.publishOK(e.tokens["alice"], "mix-tool", "1.2.0", guest, declarationsOnly())

	cfg := e.releaseConfig("mix-tool", "1.2.0")
	if cfg.Access != appcfg.AccessWhitelist {
		t.Fatalf("基线取成了待审版本（access=%q）：未审核配置被洗成默认值", cfg.Access)
	}
	if len(cfg.Whitelist) != 2 {
		t.Fatalf("名单应沿用 approved 的 v1.0.0，得到 %v", cfg.Whitelist)
	}
	// 生效版本仍是 v1.0.0（待审不影响交付），投影也不动。
	app := e.appRow("mix-tool")
	versions, verr := serverstore.WasmAppCurrentVersions(e.ctx(), e.db, []int64{app.CurrentReleaseID})
	if verr != nil {
		t.Fatalf("读生效版本失败: %v", verr)
	}
	if versions[app.CurrentReleaseID] != "1.0.0" {
		t.Fatalf("待审期间的生效版本 = %q，want 1.0.0", versions[app.CurrentReleaseID])
	}
	if got := appcfg.AccessOfConfigJSON(app.ConfigJSON); got != appcfg.AccessWhitelist {
		t.Fatalf("待审期间目录徽标 = %q，want whitelist（生效版本未被替换）", got)
	}
}

// TestUnusableBaselineRefusesPublishAndValidate 覆盖判据 ④：
// 生效版本的 config_json 是坏行 ⇒ 拒绝发布（不是回落 login），并点名是哪一版。
//
// 为什么方向是"拒发"而不是"回落 login"：whitelist = 登录 + 名单、login = 登录后全员，
// 所以坏基线回落 login 对白名单应用是**放宽**；而拒绝当场告诉作者"继承没有发生"。
// 这条分支只能由手工改库或迁移 0071 明确跳过的坏行触发（生产写入路径全部经
// appcfg.Parse），因此不会打死合法链路 —— 正向对照见下一条用例。
func TestUnusableBaselineRefusesPublishAndValidate(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "corrupt-tool", "1.0.0", guest, goodConfig())

	// 制造"更新的 approved 版本是坏行"（迁移 0071 对坏 JSON 只 RAISE WARNING 并跳过）。
	relID, err := serverstore.CreateWasmRelease(e.ctx(), e.db, serverstore.WasmRelease{
		AppID: "corrupt-tool", Version: "2.0.0", Title: "坏配置版本",
		Description: "手工写入的坏行", Changelog: "坏行",
		Publisher: "alice", Checksum: strings.Repeat("a", 64),
		Status: serverstore.ReleaseStatusApproved, ConfigJSON: `{"access":`,
	})
	if err != nil {
		t.Fatalf("造坏行失败: %v", err)
	}
	if err := serverstore.SetWasmAppCurrentRelease(e.ctx(), e.db, "corrupt-tool", relID); err != nil {
		t.Fatalf("指向坏行失败: %v", err)
	}

	before := e.countReleases("corrupt-tool")
	p := e.payload("corrupt-tool", "3.0.0", guest, declarationsOnly())
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/corrupt-tool/releases", e.tokens["alice"], p)
	eb := e.decodeErr(w, http.StatusUnprocessableEntity)
	if eb.Error.Code != "APP_CONFIG_INVALID" {
		t.Fatalf("坏基线应以 APP_CONFIG_INVALID 拒发，得到 %s: %s", eb.Error.Code, eb.Error.Message)
	}
	if eb.Error.Details["reason"] != "baseline_unusable" {
		t.Fatalf("details.reason = %v，want baseline_unusable", eb.Error.Details["reason"])
	}
	if eb.Error.Details["baseline_version"] != "2.0.0" {
		t.Fatalf("错误必须点名坏的是哪一版（否则作者/管理员无从下手）: %v", eb.Error.Details)
	}
	hints := strings.Join(eb.Error.Hints, " ")
	if !strings.Contains(hints, "config_json") || !strings.Contains(hints, "恢复路径") {
		t.Fatalf("错误提示必须给出可操作的恢复路径，得到 %v", eb.Error.Hints)
	}
	if got := e.countReleases("corrupt-tool"); got != before {
		t.Fatalf("被拒的发布不得落行（R18），%d → %d", before, got)
	}
	if !contains(e.auditActions("corrupt-tool"), "wasm_app_release_failed") {
		t.Fatalf("失败也要留痕（发布者要能在诊断里看到它）: %v", e.auditActions("corrupt-tool"))
	}
	// 显式给全 access 也照样拒：平台不对坏行做猜测（避免"这次凑巧没事"的错觉）。
	p2 := e.payload("corrupt-tool", "3.0.0", guest, goodConfig())
	e.decodeErr(e.req(http.MethodPost, "/api/client/v2/apps/wasm/corrupt-tool/releases", e.tokens["alice"], p2),
		http.StatusUnprocessableEntity)

	// 预检与发布同口径：否则 AI 会看到"预检通过、发布被拒"（预检不落行、不消耗额度）。
	vp := e.payload("corrupt-tool", "3.0.0", guest, declarationsOnly())
	veb := e.decodeErr(e.req(http.MethodPost, "/api/client/v2/apps/wasm/validate", e.tokens["alice"], vp),
		http.StatusUnprocessableEntity)
	if veb.Error.Code != "APP_CONFIG_INVALID" || veb.Error.Details["reason"] != "baseline_unusable" {
		t.Fatalf("validate 必须与 publish 给出同一个结论，得到 %s / %v", veb.Error.Code, veb.Error.Details)
	}
}

// TestEmptyApprovedConfigIsNoBaselineNotACorruptOne 覆盖判据 ⑤（边界）：
// 生效版本**没有**配置（空 config_json，历史行）⇒ 按"没有基线"处理（缺省 login），
// 不是"坏基线"⇒ 不拦发布。理由：这样的版本按 AccessOfConfigJSON 也是 login，
// "缺省 = login"与它自身一致，不构成任何放宽。
func TestEmptyApprovedConfigIsNoBaselineNotACorruptOne(t *testing.T) {
	e := newTestEnv(t)
	guest := testGuestModule(t)
	e.publishOK(e.tokens["alice"], "empty-cfg-tool", "1.0.0", guest, goodConfig())

	relID, err := serverstore.CreateWasmRelease(e.ctx(), e.db, serverstore.WasmRelease{
		AppID: "empty-cfg-tool", Version: "2.0.0", Title: "无配置版本",
		Description: "历史行", Changelog: "无配置",
		Publisher: "alice", Checksum: strings.Repeat("b", 64),
		Status: serverstore.ReleaseStatusApproved, ConfigJSON: "",
	})
	if err != nil {
		t.Fatalf("造历史行失败: %v", err)
	}
	if err := serverstore.SetWasmAppCurrentRelease(e.ctx(), e.db, "empty-cfg-tool", relID); err != nil {
		t.Fatalf("指向历史行失败: %v", err)
	}

	e.publishOK(e.tokens["alice"], "empty-cfg-tool", "3.0.0", guest, declarationsOnly())
	if cfg := e.releaseConfig("empty-cfg-tool", "3.0.0"); cfg.Access != appcfg.AccessLogin {
		t.Fatalf("无配置的历史生效版本 ⇒ 省略 access 落缺省 login，得到 %q", cfg.Access)
	}
}
