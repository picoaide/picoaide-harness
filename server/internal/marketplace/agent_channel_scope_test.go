package marketplace

// A-8（第三轮审计 2026-09-23）：市场命名空间 /api/server/admin/agents/* 的渠道守卫。
//
// 缺陷现场：5 个逐名端点（preview / file / grants 读 / grants 整组替换 /
// grant 单条增删）只做 GetApp 存在性判断、不看渠道 ⇒ 一条 `channel='org'` 的行
// 在这个命名空间下可被预览、逐文件读出、读授权，甚至被增删授权；而技能侧的
// 孪生端点（serverstore.GetSkill 自带 channel='market' 过滤）与组织侧的孪生
// 端点（agentshare.requireOrgAgent）都正确 404。
//
// 本文件的三层判据：
//
//  1. **逐端点**（10 条逐名路由，每条路由**一个独立用例**，不许一个用例覆盖五个）：
//     org 行 ⇒ 404，且与「该名字不存在」**逐字节同形**（不泄露存在性），并断言
//     org 行零副作用；market 行 ⇒ 行为不变（状态码 + 载荷 + 真实落库副作用）。
//     update/delete/enable/archive 四条是 2026-09-23 复审 F2 补上的 —— 清单里标了
//     `market-only/guard` 只是**标签，不是判据**：摘掉 `downloadAgentArchiveAdmin`
//     的守卫时，原先 8 条用例全绿（复审 MG6）。
//  2. **反向**：market 行在全部逐名路由上照常工作 —— 反向判据内联在每条逐端点
//     用例里（同一夹具、同一时刻对拍），不是另写一份乐观断言。
//  3. **顺序契约**（F3）：守卫必须**先于 body 解析 / 主体校验**。写面用例各带一个
//     「坏 body」与「不存在的授权主体」变体 —— 两者都不得成为"org 行存在"的
//     oracle。复审判定：把守卫挪到 body 解析之后（复审 MG2）在原 8 条用例下**全绿**，
//     而该形态下 `PUT /agents/<org>/grant {"username":"ghost"}` ⇒ 400、
//     `PUT /agents/<不存在>/grant …` ⇒ 404，**存在性可被区分**（真泄露）。
//     `PUT /agents/:name`（updateAgentAdmin）是唯一的顺序例外：它先解析 body、后过
//     守卫，实测仍然两侧同形（复审 F6）—— 那一条由 `assertBadBodyIsIndistinguishable`
//     单独钉住，口径见 `agent_api.go` 的注释。
//  4. **完整性**：市场命名空间的智能体路由集合与显式清单
//     `marketAgentRoutePolicy` **双向**相等 —— 新增路由不登记即红，
//     跨渠道条目必须写依据（既防「漏一个端点没人发现」，也防日后给
//     跨渠道面误加守卫）。
//
// **判据的枚举面**：本文件全部走 `marketplace.RegisterAdminRoutes`（**测试镜像树**）。
// 生产真源是 `internal/router/router.go`，那一面由该包的
// `TestProductionAgentRoutesMatchMarketplacePolicy` 对拍（复审 F1/MG1）。

import (
	"database/sql"
	"encoding/base64"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/agentshare"
	"github.com/picoaide/picoaide/internal/appstore"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

const (
	// orgAgentName 是夹具里的**组织渠道**行（由发布内核写入 apps.channel='org'）。
	orgAgentName = "org-secret-agent"
	// marketAgentName 是夹具里的**市场渠道**行（反向判据）。
	marketAgentName = "market-agent"
	// missingAgentName 是「该名字不存在」的对照 —— org 行必须与它同形。
	missingAgentName = "no-such-agent"
)

// seedPublishedAgent 用**发布内核**（appstore.Publish）造一条 name@1.0.0、
// status=approved 的智能体，渠道由参数指定。
//
// 刻意不手写 UpsertApp + CreateRelease：marketplace.uploadAgentArchiveAdmin 与
// agentshare 的员工上传路径共用这一个内核，夹具一旦与生产落库形态分叉，
// 「org 行确实存在且确实有可读归档」这条前提就失真了（守卫的 404 会被
// 「反正也读不到」蒙混过去）。
func seedPublishedAgent(t *testing.T, db *sql.DB, name, channel string) {
	t.Helper()
	raw := agentArchive(t, "1.0.0", "渠道守卫夹具智能体")
	checksum, err := agentshare.ValidatePresetArchive(raw)
	if err != nil {
		t.Fatalf("夹具归档校验失败: %v", err)
	}
	entries, composition, err := agentshare.ListArchiveContents(raw)
	if err != nil {
		t.Fatalf("夹具归档解析失败: %v", err)
	}
	if err := agentshare.ValidateAgentComposition(composition); err != nil {
		t.Fatalf("夹具编排校验失败: %v", err)
	}
	presetYML, err := archEntryText(raw, skillmanifest.PresetMetaFile)
	if err != nil {
		t.Fatalf("夹具 preset.yml 读取失败: %v", err)
	}
	man, manErr := skillmanifest.ParseAgent(entries, presetYML, name)
	if manErr != nil {
		t.Fatalf("夹具 preset.yml 解析失败: %v", manErr)
	}
	if _, err := appstore.Publish(db, appstore.PublishRequest{
		Kind: serverstore.AppKindAgent, AppID: name, Channel: channel, Archive: raw,
		Publisher: "boss", AdminPublish: true,
		Manifest: appstore.FromSkillManifest(man), Checksum: checksum,
	}); err != nil {
		t.Fatalf("夹具发布 %s(%s) 失败: %v", name, channel, err)
	}
	// 前提自证：org 行必须有可读的展示版本 —— 否则后面的 404 可能只是
	// 「没有版本」而不是「渠道守卫」（假绿）。
	r, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, name, true)
	if err != nil || r == nil || len(r.Archive) == 0 {
		t.Fatalf("夹具前提不成立：%s 没有可读归档 (release=%v err=%v)", name, r, err)
	}
}

// agentChannelFixture 是所有逐端点用例共用的现场：
//   - 组织行 org-secret-agent（已发布 1.0.0）
//   - 市场行 market-agent（已发布 1.0.0）
//   - 存在的用户 carol 与部门「研发部」（授权主体校验用）
func agentChannelFixture(t *testing.T) (http.Handler, *sql.DB, map[string]string) {
	t.Helper()
	r, db, hdr := marketAdminSetup(t)
	t.Cleanup(func() { db.Close() })
	seedPublishedAgent(t, db, orgAgentName, serverstore.AppChannelOrg)
	seedPublishedAgent(t, db, marketAgentName, serverstore.AppChannelMarket)
	if _, err := serverstore.CreateUserWithPassword(db, "carol", "carolpw"); err != nil {
		t.Fatalf("夹具用户 carol: %v", err)
	}
	if _, err := serverstore.GetOrCreateGroup(db, "研发部"); err != nil {
		t.Fatalf("夹具部门: %v", err)
	}
	return r, db, hdr
}

// assertOrgRowIsHidden 是逐端点用例的核心判据：同一请求打在 org 行与
// 「该名字不存在」上，必须得到**逐字节相同**的响应（状态码 + body）。
//
// 为什么必须同形而不是"只要不是 200"：把 404 改成 403（或换个错误码/文案）
// 同样是"拒绝了"，但它泄露了「这个名字在组织库里存在」—— 本仓的严格默认
// 纪律（见 server/AGENTS.md §2.2）要求存在性与不存在同响应。
func assertOrgRowIsHidden(t *testing.T, r http.Handler, hdr map[string]string, method, pathTmpl, body string) {
	t.Helper()
	orgPath := strings.ReplaceAll(pathTmpl, "{name}", orgAgentName)
	missingPath := strings.ReplaceAll(pathTmpl, "{name}", missingAgentName)
	orgW, _ := mreq(t, r, method, orgPath, body, hdr)
	missingW, _ := mreq(t, r, method, missingPath, body, hdr)
	// ① 同形判据**先跑**：状态码与 body 都必须逐字节相同。403 / 换错误码 / 换文案
	//    同样是"拒绝了"，但它泄露了「这个名字在组织库里存在」—— 判据落在这一条上，
	//    变异验证 M2（org ⇒ 403）才会打在这里。
	if orgW.Code != missingW.Code || orgW.Body.String() != missingW.Body.String() {
		t.Fatalf("%s %s：org 行与「不存在的名字」响应不同形（泄露存在性）:\n org     = %d %s\n missing = %d %s",
			method, orgPath, orgW.Code, orgW.Body.String(), missingW.Code, missingW.Body.String())
	}
	// ② 再钉死这对响应必须是 404（同形也可能是"两边都 500"这种退化）
	if orgW.Code != http.StatusNotFound {
		t.Fatalf("org 行经市场命名空间 %s %s = %d %s，want 404（A-8 渠道守卫缺失）",
			method, orgPath, orgW.Code, orgW.Body.String())
	}
	if missingW.Code != http.StatusNotFound {
		t.Fatalf("对照「不存在的名字」%s %s = %d %s，want 404（夹具/路由不对）",
			method, missingPath, missingW.Code, missingW.Body.String())
	}
}

// assertOrgRowUntouched 断言组织行在拒绝后**零副作用**：行本身未被改、授权表里
// 没有它的任何授权（写面守卫的另一半判据 —— 只看状态码会漏掉
// 「先写后 404」这类实现）。
func assertOrgRowUntouched(t *testing.T, db *sql.DB) {
	t.Helper()
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, orgAgentName)
	if err != nil {
		t.Fatalf("读取组织行: %v", err)
	}
	if a.Channel != serverstore.AppChannelOrg || a.Enabled != 1 {
		t.Fatalf("组织行被市场命名空间改动: %+v", a)
	}
	grants, err := serverstore.ListAppGrants(db, serverstore.AppKindAgent, orgAgentName)
	if err != nil {
		t.Fatalf("读取组织行授权: %v", err)
	}
	if len(grants) != 0 {
		t.Fatalf("组织行被市场命名空间写入授权: %+v", grants)
	}
}

// grantSubjects 返回某 App 的授权主体集合（"用户:carol" / "部门:研发部"）。
func grantSubjects(t *testing.T, db *sql.DB, appID string) map[string]bool {
	t.Helper()
	grants, err := serverstore.ListAppGrants(db, serverstore.AppKindAgent, appID)
	if err != nil {
		t.Fatalf("读取 %s 授权: %v", appID, err)
	}
	out := make(map[string]bool, len(grants))
	for _, g := range grants {
		out[string(g.GranteeType)+":"+g.Grantee] = true
	}
	return out
}

// assertBadBodyIsIndistinguishable 断言**坏 body**（或坏授权主体）下 org 行与
// 「该名字不存在」的响应逐字节相同，并返回这对响应共有的状态码。
//
// 与 `assertOrgRowIsHidden` 的唯一区别是"必须是什么码"：
//   - 守卫在前的路由，坏 body 也必须是 404（body 根本不该被解析）；
//   - `updateAgentAdmin`（`PUT /agents/:name`）是**先解析 body、后过守卫**的顺序例外
//     （复审 F6；口径与理由写在 `agent_api.go` 的注释里），坏 body 下两侧同为
//     400 `{"code":"VALIDATION","message":"请求体错误"}`。
//
// 所以本助手只钉两条不变量：①**两侧逐字节同形**（这就是"防日后漂移成可探测"的判据）；
// ②同形响应是一个**干净的拒绝码**（400 body 解析拒绝 / 404 守卫拒绝），不是 2xx/5xx。
// **刻意不钉"必须是 400"**：把守卫提到 body 解析之前（两侧一起变 404）是收紧，不该被
// 本用例判红；会红的只有"org 行与不存在的名字走了不同分支"这类**不对称**漂移。
func assertBadBodyIsIndistinguishable(t *testing.T, r http.Handler, hdr map[string]string, method, pathTmpl, body string) int {
	t.Helper()
	orgPath := strings.ReplaceAll(pathTmpl, "{name}", orgAgentName)
	missingPath := strings.ReplaceAll(pathTmpl, "{name}", missingAgentName)
	orgW, _ := mreq(t, r, method, orgPath, body, hdr)
	missingW, _ := mreq(t, r, method, missingPath, body, hdr)
	if orgW.Code != missingW.Code || orgW.Body.String() != missingW.Body.String() {
		t.Fatalf("%s %s：坏 body %q 下 org 行与「不存在的名字」响应不同形（这本身就是存在性泄露）:\n org     = %d %s\n missing = %d %s",
			method, orgPath, body, orgW.Code, orgW.Body.String(), missingW.Code, missingW.Body.String())
	}
	if orgW.Code != http.StatusBadRequest && orgW.Code != http.StatusNotFound {
		t.Fatalf("%s %s：坏 body %q 下同形响应 = %d %s，既不是 400（body 解析拒绝）也不是 404（守卫拒绝）—— 要么引入了新故障，要么判据失效",
			method, orgPath, body, orgW.Code, orgW.Body.String())
	}
	return orgW.Code
}

// ---------------------------------------------------------------------------
// 1. 逐端点：org 行 ⇒ 404 同形；market 行 ⇒ 行为不变（反向判据内联）
// ---------------------------------------------------------------------------

// A-8-①：GET /agents/:name/preview
func TestAgentPreviewHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "GET", "/api/server/admin/agents/{name}/preview", "")

	// 反向：市场行照常预览（文件清单 + 编排 + 版本）
	w, out := mreq(t, r, "GET", "/api/server/admin/agents/"+marketAgentName+"/preview", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("market 行 preview = %d %s", w.Code, w.Body.String())
	}
	files, _ := out["files"].([]any)
	composition, _ := out["composition"].(string)
	if len(files) != 2 || !strings.Contains(composition, "dsh-persona") {
		t.Fatalf("market 行 preview 载荷变了: %v", out)
	}
	if out["version"] != "1.0.0" {
		t.Fatalf("market 行 preview 版本 = %v", out["version"])
	}
	assertOrgRowUntouched(t, db)
}

// A-8-②：GET /agents/:name/file
func TestAgentFileContentHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "GET",
		"/api/server/admin/agents/{name}/file?path=preset.yml", "")

	// 反向：市场行照常逐文件读出（组织行的 preset.yml 若从市场 URL 漏出，
	// 上面的同形断言就是它唯一的闸门）
	w, out := mreq(t, r, "GET",
		"/api/server/admin/agents/"+marketAgentName+"/file?path=preset.yml", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("market 行 file = %d %s", w.Code, w.Body.String())
	}
	content, _ := out["content"].(string)
	if !strings.Contains(content, "渠道守卫夹具智能体") {
		t.Fatalf("market 行 file 载荷变了: %v", out)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-③：GET /agents/:name/grants（授权**读**）
func TestAgentListGrantsHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	// 给市场行放一条授权，证明读面真的在服务市场行（而不是"两边都空"的假通过）。
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, marketAgentName, "carol", string(serverstore.GranteeUser)); err != nil {
		t.Fatalf("夹具授权: %v", err)
	}
	assertOrgRowIsHidden(t, r, hdr, "GET", "/api/server/admin/agents/{name}/grants", "")

	w, out := mreq(t, r, "GET", "/api/server/admin/agents/"+marketAgentName+"/grants", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("market 行 grants = %d %s", w.Code, w.Body.String())
	}
	grants, _ := out["grants"].([]any)
	if len(grants) != 1 || !strings.Contains(w.Body.String(), "carol") {
		t.Fatalf("market 行 grants 载荷变了: %v", out)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-④：PUT /agents/:name/grants（授权整组替换，**写**面）
func TestAgentReplaceGrantsHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grants",
		`{"groups":["研发部"]}`)

	// 顺序契约（F3）：守卫先于 body 解析与主体校验 —— 坏 body 与"不存在的部门"都
	// 不得成为 org 行存在性的 oracle。MG2（守卫挪到 body 解析/主体校验之后）下
	// 这里会变成 400，本断言即红。
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grants",
		`{"groups":[`)
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grants",
		`{"groups":["不存在的部门"]}`)

	// 反向：市场行的整组替换照常生效
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/"+marketAgentName+"/grants",
		`{"groups":["研发部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行 replace grants = %d %s", w.Code, w.Body.String())
	}
	subjects := grantSubjects(t, db, marketAgentName)
	if !subjects[string(serverstore.GranteeGroup)+":研发部"] {
		t.Fatalf("market 行部门授权未落库: %v", subjects)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑤：PUT /agents/:name/grant（单条授权，**写**面）
func TestAgentSetGrantHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grant",
		`{"username":"carol"}`)

	// 顺序契约（F3）：这一对正是复审 MG2 泄露形态的判据 —— 守卫挪到主体校验之后时
	// org ⇒ 400「用户不存在: ghost」、不存在 ⇒ 404，两侧不同形，本断言红。
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grant",
		`{`)
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}/grant",
		`{"username":"ghost"}`)

	// 反向：市场行的单条授权照常生效
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/"+marketAgentName+"/grant",
		`{"username":"carol"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行 set grant = %d %s", w.Code, w.Body.String())
	}
	subjects := grantSubjects(t, db, marketAgentName)
	if !subjects[string(serverstore.GranteeUser)+":carol"] {
		t.Fatalf("market 行用户授权未落库: %v", subjects)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑥：DELETE /agents/:name/grant（撤销授权，**写**面）
func TestAgentRemoveGrantHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	// 市场行预置一条授权，DELETE 才有东西可撤（否则 200 也可能是"本来就没有"）。
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, marketAgentName, "carol", string(serverstore.GranteeUser)); err != nil {
		t.Fatalf("夹具授权: %v", err)
	}
	assertOrgRowIsHidden(t, r, hdr, "DELETE", "/api/server/admin/agents/{name}/grant",
		`{"username":"carol"}`)

	// 顺序契约（F3）：DELETE 也带 body —— 坏 body 与不存在的授权主体同样不得泄露
	// org 行的存在性（守卫在 body 解析之前）。
	assertOrgRowIsHidden(t, r, hdr, "DELETE", "/api/server/admin/agents/{name}/grant",
		`{`)
	assertOrgRowIsHidden(t, r, hdr, "DELETE", "/api/server/admin/agents/{name}/grant",
		`{"username":"ghost"}`)

	// 反向：市场行的撤销照常生效
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/"+marketAgentName+"/grant",
		`{"username":"carol"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行 remove grant = %d %s", w.Code, w.Body.String())
	}
	if subjects := grantSubjects(t, db, marketAgentName); subjects[string(serverstore.GranteeUser)+":carol"] {
		t.Fatalf("market 行授权未被撤销: %v", subjects)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑦：GET /agents/:name/archive（归档下载；F2 补的行为用例）
//
// 复审实测（MG6）：这条路由在清单里被标为 `market-only/guard`，但**登记类别是标签、
// 不是判据** —— 摘掉 `downloadAgentArchiveAdmin` 的渠道守卫后，原先 8 条用例全绿，
// 只有复审自写探针红。本用例把那个标签变成行为判据。
func TestAgentArchiveHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "GET", "/api/server/admin/agents/{name}/archive", "")

	// 反向：市场行照常下发归档（真二进制流 + 版本/校验和头 + 字节可解析）
	w, _ := mreq(t, r, "GET", "/api/server/admin/agents/"+marketAgentName+"/archive", "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("market 行 archive = %d %s", w.Code, w.Body.String())
	}
	if ct := w.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/zip") {
		t.Fatalf("market 行 archive content-type = %q，want application/zip", ct)
	}
	if v := w.Header().Get("X-Preset-Version"); v != "1.0.0" {
		t.Fatalf("market 行 archive 版本头 = %q，want 1.0.0", v)
	}
	if w.Header().Get("X-Preset-Checksum") == "" {
		t.Fatal("market 行 archive 缺少校验和头（客户端安装器靠它做 sha256 对照）")
	}
	if _, _, err := agentshare.ListArchiveContents(w.Body.Bytes()); err != nil {
		t.Fatalf("market 行 archive 字节不可解析（空流/半截也算通过？）: %v", err)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑧：PUT /agents/:name（元数据更新；F2 补行为用例 + F6 钉住顺序例外）
func TestAgentUpdateMetaHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "PUT", "/api/server/admin/agents/{name}",
		`{"description":"组织行不得被市场命名空间改写"}`)

	// 反向：市场行元数据照常更新并落库
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/"+marketAgentName,
		`{"description":"市场行新描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行 update = %d %s", w.Code, w.Body.String())
	}
	market, err := serverstore.GetApp(db, serverstore.AppKindAgent, marketAgentName)
	if err != nil {
		t.Fatalf("读取市场行: %v", err)
	}
	if market.Description != "市场行新描述" {
		t.Fatalf("market 行描述未落库: %q", market.Description)
	}

	// F6：updateAgentAdmin 是**先 body 解析、后过守卫**（9 条逐名端点里唯一的顺序
	// 例外，理由写在 agent_api.go）。实测不泄露：坏 body 下 org 与"不存在"同为
	// 400 同形。本断言把那一条口径钉住 —— 任何"按行是否存在分流"的漂移
	// （例如先查行、org 行回 404、不存在的名字仍走 body 解析回 400）立刻红。
	if code := assertBadBodyIsIndistinguishable(t, r, hdr, "PUT",
		"/api/server/admin/agents/{name}", `{"description":`); code != http.StatusBadRequest {
		t.Logf("updateAgentAdmin 的坏 body 口径已变（%d，不再是 body 先解析的 400）—— 属收紧，本用例仍绿", code)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑨：DELETE /agents/:name（下架；F2 补行为用例）
func TestAgentDeleteHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	assertOrgRowIsHidden(t, r, hdr, "DELETE", "/api/server/admin/agents/{name}", "")

	// 反向：市场行照常下架并落库（org 行仍上架 —— 同形断言不是"两边都没动"）
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/"+marketAgentName, "", hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行下架 = %d %s", w.Code, w.Body.String())
	}
	market, err := serverstore.GetApp(db, serverstore.AppKindAgent, marketAgentName)
	if err != nil {
		t.Fatalf("读取市场行: %v", err)
	}
	if market.Enabled != 0 {
		t.Fatalf("market 行未被下架: enabled=%d", market.Enabled)
	}
	assertOrgRowUntouched(t, db)
}

// A-8-⑩：POST /agents/:name/enable（重新上架；F2 补行为用例）
func TestAgentEnableHidesOrgChannelRow(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)
	// 市场行先下架，"重新上架"才有可断言的落库副作用（否则 200 也可能是幂等空转）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, marketAgentName, false); err != nil {
		t.Fatalf("夹具下架: %v", err)
	}
	assertOrgRowIsHidden(t, r, hdr, "POST", "/api/server/admin/agents/{name}/enable", "")

	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/"+marketAgentName+"/enable", "", hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行重新上架 = %d %s", w.Code, w.Body.String())
	}
	market, err := serverstore.GetApp(db, serverstore.AppKindAgent, marketAgentName)
	if err != nil {
		t.Fatalf("读取市场行: %v", err)
	}
	if market.Enabled != 1 {
		t.Fatalf("market 行未被重新上架: enabled=%d", market.Enabled)
	}
	assertOrgRowUntouched(t, db)
}

// ---------------------------------------------------------------------------
// 2. 显式清单（"哪些面跨渠道"的唯一真源）的运行时判据
// ---------------------------------------------------------------------------

// TestAgentNameExclusionRoutesStayCrossChannel 钉住清单里**跨渠道**那两条的语义：
// 登记（POST /agents）与上传新版（POST /agents/:name/archive）对 org 行**必须**
// 回 409 跨源同名互斥，而不是 404。
//
// 为什么不能给它们加市场守卫：跨渠道同名互斥是产品语义（同 kind 同名只能存在于
// 一个渠道，见 appstore.Publish 的 `existing.Channel != req.Channel ⇒ 409
// NAME_TAKEN`），它**必须读到 org 行**才能拒绝；加守卫会把它降级成 404
// 「智能体不存在」，管理员会以为自己名字打错了。
//
// 本用例就是那条"应当跨渠道"的判据 —— 日后有人顺手补守卫，这里立刻红。
func TestAgentNameExclusionRoutesStayCrossChannel(t *testing.T) {
	r, db, hdr := agentChannelFixture(t)

	// 登记：org 行同名 ⇒ 409（不是 404，也不是静默创建）
	w, _ := mreq(t, r, "POST", "/api/server/admin/agents",
		`{"name":"`+orgAgentName+`"}`, hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("POST /agents 撞 org 同名 = %d %s，want 409（跨源同名互斥）", w.Code, w.Body.String())
	}
	// 对照：全新名字仍可登记（不是"登记面坏掉了"）
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"brand-new-agent"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("POST /agents 新名字 = %d %s，want 200", w.Code, w.Body.String())
	}

	// 上传新版：org 行同名 ⇒ 409 NAME_TAKEN（appstore.Publish 的渠道判据）
	archive := agentArchive(t, "2.0.0", "撞名上传")
	body := `{"version":"2.0.0","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	w, out := mreq(t, r, "POST", "/api/server/admin/agents/"+orgAgentName+"/archive", body, hdr)
	if w.Code != http.StatusConflict {
		t.Fatalf("POST /agents/%s/archive = %d %s，want 409", orgAgentName, w.Code, w.Body.String())
	}
	if code := errorCode(out); code != appstore.CodeNameTaken {
		t.Fatalf("撞名上传错误码 = %q，want %q（跨渠道同名互斥的真源在 appstore.Publish）",
			code, appstore.CodeNameTaken)
	}
	// 对照：市场行的上传路径照常工作
	okArchive := agentArchive(t, "2.0.0", "市场行新版")
	okBody := `{"version":"2.0.0","archive":"` + base64.StdEncoding.EncodeToString(okArchive) + `"}`
	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents/"+marketAgentName+"/archive", okBody, hdr); w.Code != http.StatusOK {
		t.Fatalf("market 行上传新版 = %d %s，want 200", w.Code, w.Body.String())
	}
	// org 行在两次失败之后仍是 1.0.0（没被写进市场版本）
	rel, err := serverstore.CurrentMarketReleaseFor(db, serverstore.AppKindAgent, orgAgentName, false)
	if err != nil || rel == nil || rel.Version != "1.0.0" {
		t.Fatalf("org 行版本被改动: %+v err=%v", rel, err)
	}
	assertOrgRowUntouched(t, db)
}

// errorCode 从统一错误信封里取 code（无信封返回空串）。
func errorCode(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	if e == nil {
		return ""
	}
	code, _ := e["code"].(string)
	return code
}

// TestAgentAdminRoutesAreMarketOnlyOrRegistered 是清单的**完整性**判据：
// 运行时路由表（含方法）与 marketAgentRoutePolicy 双向相等。
//
// 它抓的是"漏一个端点没人发现"：新增一条 /api/server/admin/agents* 路由却既没加
// requireMarketAgent、也没在本清单登记 ⇒ 红；反过来清单里留了已删路由 ⇒ 也红。
//
// **注意本用例的枚举面**：`marketAdminSetup` 建的是 `RegisterAdminRoutes` 的
// **测试镜像树**。生产真源是 `internal/router/router.go`，镜像守门对"只在生产树里
// 加一条未登记路由"是**盲**的（复审 MG1）—— 那一面由 `internal/router` 的
// `TestProductionAgentRoutesMatchMarketplacePolicy` 对拍生产路由表补齐，两处共用
// 同一个 `MarketAgentRouteViolations` 实现（不各写一份判据）。
func TestAgentAdminRoutesAreMarketOnlyOrRegistered(t *testing.T) {
	h, db, _ := marketAdminSetup(t)
	defer db.Close()
	engine, ok := h.(*gin.Engine)
	if !ok {
		t.Fatalf("marketAdminSetup 返回的不是 *gin.Engine（%T），无法枚举路由", h)
	}

	got := []string{}
	for _, rt := range engine.Routes() {
		if strings.HasPrefix(rt.Path, "/api/server/admin/agents") {
			got = append(got, rt.Method+" "+rt.Path)
		}
	}
	if len(got) == 0 {
		t.Fatal("运行时路由表里没有任何 /api/server/admin/agents* 路由（枚举方式坏了，判据失效）")
	}
	if violations := MarketAgentRouteViolations(got); len(violations) > 0 {
		t.Fatalf("测试镜像树与渠道口径清单不一致（%d 条）：\n  %s",
			len(violations), strings.Join(violations, "\n  "))
	}
	// 全部 10 条逐名路由必须在清单里体现为守卫类（防止有人把某一条悄悄改成
	// 清单过滤或跨渠道而用例还在测 404 —— 那种改动会先在这里红）。
	for _, key := range []string{
		"PUT /api/server/admin/agents/:name",
		"DELETE /api/server/admin/agents/:name",
		"POST /api/server/admin/agents/:name/enable",
		"GET /api/server/admin/agents/:name/preview",
		"GET /api/server/admin/agents/:name/file",
		"GET /api/server/admin/agents/:name/archive",
		"GET /api/server/admin/agents/:name/grants",
		"PUT /api/server/admin/agents/:name/grants",
		"PUT /api/server/admin/agents/:name/grant",
		"DELETE /api/server/admin/agents/:name/grant",
	} {
		rule, ok := marketAgentRoutePolicy[key]
		if !ok {
			t.Fatalf("逐名守卫路由 %s 不在清单里", key)
		}
		if rule.Policy != policyMarketOnlyByGuard {
			t.Fatalf("逐名守卫路由 %s 渠道口径 = %q，want %q", key, rule.Policy, policyMarketOnlyByGuard)
		}
	}
	// 反向：跨渠道那两条必须仍是跨渠道（它们靠读 org 行回 409，加守卫会把 409 降级
	// 成 404 —— `TestAgentNameExclusionRoutesStayCrossChannel` 是行为判据，这里是清单判据）。
	for _, key := range []string{
		"POST /api/server/admin/agents",
		"POST /api/server/admin/agents/:name/archive",
	} {
		if rule, ok := marketAgentRoutePolicy[key]; !ok || rule.Policy != policyCrossChannelNameExclusion {
			t.Fatalf("跨源同名互斥路由 %s 的渠道口径 = %q，want %q", key, rule.Policy, policyCrossChannelNameExclusion)
		}
	}
}
