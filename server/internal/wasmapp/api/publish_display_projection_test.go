// 待审版本不得投影**显示面**（title/description）到应用目录（R2-1，2026-09-19 第二轮
// 对抗审计 §1.1）—— 在**生产挂载路径**（HTTP 端点 + 真库）上的行为级护栏。
//
// 为什么单独一个文件：apps.title / apps.description 是 read.go 的目录行**直接下发**的
// 两列，而员工面目录对全组织可见（客户端应用中心把它们渲染成卡片标题与描述）。
// R1-pm-9 的守卫只罩住了 config_json/purpose/data_sensitivity —— 同一次 status=pending
// 的提交仍会无条件改写这两列 ⇒ 已上线应用可以"不过审就改名"（审计实测：标题改成
// "IT 密码重置"、描述写诱导文案，而 current_version/access 停在已审核版本，员工点进去
// 执行的仍是旧代码）。仿冒因此不需要过审。
//
// 判据：
//
//	① 已上线应用发待审版本（改标题/描述）⇒ apps 行与目录行都停在**已审核版本**的值，
//	   current_version / access 同样不动（既有守卫不回归）
//	② approve ⇒ 显示面与目录**立刻**变成新版本的（审核分支重算；漏掉它就越审越旧）
//	③ reject  ⇒ 目录保持旧值，且老实现留下的脏标题投影会被治好
//	④ 首版待审 ⇒ 目录不列它，且 apps.title 落在 **app_id 占位**（不能是空串：
//	   read.go 的目录/详情/导出读的就是这一列，对空 title 没有任何兜底）
//
// 变异验证（实跑记录见 temp/wasm-review-r1/fix-audit2.md）：
//   - E1 的 UPSERT 改回无条件写 title/description ⇒ ① 红；
//   - admin.go 的重算分支去掉 SetWasmAppDisplay ⇒ ② 红（③ 仍绿：待审本就不写）。
package api

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/appcfg"
)

// catalogRow 读员工面目录里某个应用的行（不存在返回 nil）。
//
// 与 catalogAccess 同一条生产路径（GET /api/client/v2/apps/wasm/catalog，员工 token）——
// 目录是"全组织可见"的那个面，显示面缺陷只有在这里断言才有意义。
func (e *testEnv) catalogRow(token, appID string) map[string]any {
	e.t.Helper()
	w := e.req(http.MethodGet, "/api/client/v2/apps/wasm/catalog", token, nil)
	var out struct {
		Apps []map[string]any `json:"apps"`
	}
	e.decodeJSON(w, http.StatusOK, &out)
	for _, row := range out.Apps {
		if row["app_id"] == appID {
			return row
		}
	}
	return nil
}

// publishTitled 发一个**自选标题/用途**的版本（生产挂载路径）。
//
// e.payload 的标题是固定模板（"示例应用 <app_id>"），而本组判据的攻防就是"改标题" ⇒
// 必须能自选标题/描述才测得出。描述的真源是配置里的 purpose（apps.description 与
// apps.purpose 在发布路径上同源，见 publish.go 的 E1）。
func (e *testEnv) publishTitled(token, appID, version, title, purpose, access string, wasm []byte) map[string]any {
	e.t.Helper()
	p := e.payload(appID, version, wasm, cfgWith(map[string]any{
		"access": access, "whitelist": []string{}, "purpose": purpose,
		"data_sensitivity": "internal", "owner": "张伟",
	}))
	p["title"] = title
	w := e.req(http.MethodPost, "/api/client/v2/apps/wasm/"+appID+"/releases", token, p)
	if w.Code != http.StatusCreated {
		e.t.Fatalf("发布 %s v%s 失败: %d %s", appID, version, w.Code, w.Body.String())
	}
	var out struct {
		Release map[string]any `json:"release"`
	}
	e.decodeJSON(w, http.StatusCreated, &out)
	return out.Release
}

// TestPendingUpdateCannotRenameLiveApp 覆盖判据 ①②⑤（审计 §1.1 的主场景）。
func TestPendingUpdateCannotRenameLiveApp(t *testing.T) {
	e := newTestEnv(t)
	e.setReviewRequired(false) // 基线版本走 approved（"已上线应用"的现场形态）
	guest := testGuestModule(t)

	// v1 上线：目录上的标题/描述 = 这一版**经过审核**的值。
	live := e.publishTitled(e.tokens["alice"], "phish-tool", "1.0.0",
		"报销助手", "线上描述", string(appcfg.AccessLogin), guest)
	if live["status"] != serverstore.ReleaseStatusApproved {
		t.Fatalf("审核关闭时首版应直接 approved，得到 %v", live["status"])
	}
	e.setReviewRequired(true)

	// v2 待审：标题/描述换成仿冒文案（access 也一并放宽，顺带钉住既有三列守卫）。
	e.publishTitled(e.tokens["alice"], "phish-tool", "1.1.0",
		"IT 密码重置", "IT 密码重置：请在此输入你的域账号密码", string(appcfg.AccessLogin), guest)

	// ① apps 行：显示面一字不动。
	app := e.appRow("phish-tool")
	if app.Title != "报销助手" || app.Description != "线上描述" {
		t.Fatalf("待审版本改写了已上线应用的显示面投影: title=%q description=%q（老实现会让未审核标题对全组织可见）",
			app.Title, app.Description)
	}
	// 目录行（员工视角）：显示的必须是已审核版本的值；生效版本/访问级别同理。
	row := e.catalogRow(e.tokens["bob"], "phish-tool")
	if row == nil {
		t.Fatal("目录里应有 phish-tool（它有生效版本）")
	}
	if row["title"] != "报销助手" || row["description"] != "线上描述" {
		t.Fatalf("目录行读到了待审版本的标题/描述: title=%v description=%v", row["title"], row["description"])
	}
	if row["current_version"] != "1.0.0" || row["access"] != string(appcfg.AccessLogin) {
		t.Fatalf("待审期间 current_version/access 不得提前切走: %v / %v", row["current_version"], row["access"])
	}
	// 版本行自己保留提交值（"不投影"不等于"不保存"）—— 批准后由它生效。
	rel, rerr := serverstore.GetWasmRelease(e.ctx(), e.db, "phish-tool", "1.1.0")
	if rerr != nil {
		t.Fatalf("读版本行失败: %v", rerr)
	}
	if rel.Title != "IT 密码重置" || rel.Description != "IT 密码重置：请在此输入你的域账号密码" {
		t.Fatalf("版本行必须保留提交的标题/描述，得到 %q / %q", rel.Title, rel.Description)
	}

	// ② approve ⇒ 显示面（与 access/生效版本一起）切到新版本。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/phish-tool/releases/1.1.0/approve", "", nil), http.StatusOK, &struct{}{})
	after := e.catalogRow(e.tokens["bob"], "phish-tool")
	if after["title"] != "IT 密码重置" || after["description"] != "IT 密码重置：请在此输入你的域账号密码" {
		t.Fatalf("审核通过后目录必须切到新版本的标题/描述，得到 title=%v description=%v"+
			"（审核分支漏了显示面重算 ⇒ 批准了却永远看不到新标题）", after["title"], after["description"])
	}
	if after["current_version"] != "1.1.0" || after["access"] != string(appcfg.AccessLogin) {
		t.Fatalf("审核通过后 current_version/access 应随生效版本切走: %v / %v", after["current_version"], after["access"])
	}
	if appAfter := e.appRow("phish-tool"); appAfter.Title != "IT 密码重置" || appAfter.Description != "IT 密码重置：请在此输入你的域账号密码" {
		t.Fatalf("apps 行的显示面也应切到新版本: %+v", appAfter)
	}
}

// TestRejectedPendingUpdateKeepsApprovedDisplay 覆盖判据 ③（含"治好脏投影"）。
//
// 脏投影步骤模拟**老实现**在库里的形态（待审提交当场改写 apps 行的 title/description）：
// 拒绝之后必须回到仍在生效的那一版，而不是把被拒版本的标题永久留在目录上。
func TestRejectedPendingUpdateKeepsApprovedDisplay(t *testing.T) {
	e := newTestEnv(t)
	e.setReviewRequired(false)
	guest := testGuestModule(t)
	e.publishTitled(e.tokens["alice"], "reject-tool", "1.0.0", "报销助手", "线上描述", string(appcfg.AccessLogin), guest)

	e.setReviewRequired(true)
	e.publishTitled(e.tokens["alice"], "reject-tool", "1.1.0", "工资条查询", "请输入工资查询口令", string(appcfg.AccessLogin), guest)

	// 制造脏投影（老实现留下的形态），再 reject：显示面必须回到 1.0.0 的值。
	if err := serverstore.SetWasmAppDisplay(e.ctx(), e.db, "reject-tool", "工资条查询", "请输入工资查询口令"); err != nil {
		t.Fatalf("制造脏显示面投影失败: %v", err)
	}
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/reject-tool/releases/1.1.0/reject", "", map[string]any{"reason": "不是 IT 发的"}),
		http.StatusOK, &struct{}{})

	app := e.appRow("reject-tool")
	if app.Title != "报销助手" || app.Description != "线上描述" {
		t.Fatalf("拒绝待审版本后显示面必须回到仍在生效的版本: title=%q description=%q", app.Title, app.Description)
	}
	row := e.catalogRow(e.tokens["bob"], "reject-tool")
	if row["title"] != "报销助手" || row["description"] != "线上描述" {
		t.Fatalf("拒绝后目录显示面 = %v / %v，want 报销助手 / 线上描述", row["title"], row["description"])
	}
	if row["current_version"] != "1.0.0" {
		t.Fatalf("拒绝待审版本不得改动生效版本，得到 %v", row["current_version"])
	}
}

// TestPendingFirstReleaseUsesAppIDPlaceholder 覆盖判据 ④。
//
// 首版待审的 apps 行既不能带待审标题（未审核内容不进投影），也不能是空串
// （read.go 的目录/详情/导出读的就是这一列，没有 title 兜底 —— 空标题会先出现在
// 管理面与导出里）。口径：用 app_id 占位；目录此时不列它（current_release_id = 0）。
func TestPendingFirstReleaseUsesAppIDPlaceholder(t *testing.T) {
	e := newTestEnv(t)
	e.setReviewRequired(true)
	guest := testGuestModule(t)

	e.publishTitled(e.tokens["alice"], "brand-new-tool", "1.0.0",
		"IT 密码重置", "IT 密码重置：请在此输入你的域账号密码", string(appcfg.AccessLogin), guest)

	app := e.appRow("brand-new-tool")
	if app.Title != "brand-new-tool" || app.Description != "" {
		t.Fatalf("首版待审的显示面应是 app_id 占位 + 空描述（不写待审标题/描述），得到 title=%q description=%q",
			app.Title, app.Description)
	}
	if app.Title == "" {
		t.Fatal("首版待审不得落空标题：read.go 的目录/详情/导出对空 title 没有兜底")
	}
	if row := e.catalogRow(e.tokens["bob"], "brand-new-tool"); row != nil {
		t.Fatalf("首版待审不得出现在目录里（没有生效版本），得到 %v", row)
	}

	// approve ⇒ 目录出现，且标题/描述是那一版经过审核的值（占位被真值替掉）。
	e.decodeJSON(e.req(http.MethodPost,
		"/api/server/admin/wasm-apps/brand-new-tool/releases/1.0.0/approve", "", nil), http.StatusOK, &struct{}{})
	row := e.catalogRow(e.tokens["bob"], "brand-new-tool")
	if row == nil {
		t.Fatal("通过审核后应用必须出现在目录里")
	}
	if row["title"] != "IT 密码重置" || row["description"] != "IT 密码重置：请在此输入你的域账号密码" {
		t.Fatalf("通过审核后目录显示面 = %v / %v，want 版本行的真值（app_id 占位必须被替掉）",
			row["title"], row["description"])
	}
}
