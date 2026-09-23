package agentshare

import (
	"database/sql"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// F4（独立复审 2026-09-23）：管理面归档下载的**反方向**跨渠道面。
//
// 缺陷现场：`/api/server/admin/agent-presets/:name[/:version]/archive` 两条路由都传
// `admin=true`，而 `serveArchive` 在 admin=true 时**完全不做渠道判定** ⇒ 组织命名空间
// 把**市场行**的归档也服务了（复审实测 `GET /api/server/admin/agent-presets/<market>/archive`
// → `200 application/zip`），而同命名空间的孪生端点 `<market>/preview`
// （`requireOrgAgent`）已经是 404。市场侧当时没有管理面归档端点，所以"管理员需要它"是
// 唯一可能的理由；2026-09-23 起市场行有了自己的 `GET /api/server/admin/agents/:name/archive`
// （marketplace/downloadAgentArchiveAdmin），该理由消失 ⇒ 主控裁决加 `requireOrgAgent`。
//
// 本文件钉住三条：
//  1. 管理面（旧路径 + 版本级路径）对**市场行** ⇒ 404，且与「该名字不存在」**逐字节同形**
//     （不泄露存在性）；
//  2. 管理面对**组织行**照常 200 + 真 zip 字节（拒绝面没有把正路一起关掉）；
//  3. **反向**：员工面 `/api/client/v2/agent-presets/:name/archive` 仍然两种渠道都服务
//     —— 那是市场智能体的安装通路，加固管理面不得把它一起改坏（改坏了能力中心的
//     「安装」按钮整片失效）。
//
// 变异验证（MF4）：摘掉 `download`/`downloadVersioned` 里的 `admin && !requireOrgAgent(...)`
// ⇒ 用例 1 红（市场行重新变 200），用例 2/3 保持绿。
func TestAdminArchiveScopeServesOrgRowsOnly(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	// 组织行：员工上传 + 管理员审核通过。
	orgArchive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("组织预设", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody("org-preset", "组织预设", "组织预设", orgArchive)); code != 201 {
		t.Fatalf("组织行上传 = %d %s", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/org-preset/approve", ""); code != 200 {
		t.Fatalf("组织行审核 = %d %s", code, body)
	}
	// 市场行：走发布内核写 channel='market'（与 marketplace 侧同一落库形态）。
	seedMarketAgent(t, db, "mkt-agent")

	// ---- 1. 管理面对市场行 = 与「不存在」逐字节同形 -------------------------------
	for _, tc := range []struct {
		method, path, missingPath string
	}{
		{
			"GET", "/api/server/admin/agent-presets/mkt-agent/archive",
			"/api/server/admin/agent-presets/no-such-preset/archive",
		},
		{
			"GET", "/api/server/admin/agent-presets/mkt-agent/1.0.0/archive",
			"/api/server/admin/agent-presets/no-such-preset/1.0.0/archive",
		},
	} {
		marketCode, marketBody := adminDo(t, r, adminHdr, tc.method, tc.path, "")
		missingCode, missingBody := adminDo(t, r, adminHdr, tc.method, tc.missingPath, "")
		if marketCode != missingCode || marketBody != missingBody {
			t.Fatalf("%s %s：市场行与「不存在的名字」响应不同形（泄露存在性）:\n market  = %d %s\n missing = %d %s",
				tc.method, tc.path, marketCode, marketBody, missingCode, missingBody)
		}
		if marketCode != 404 {
			t.Fatalf("%s %s = %d %s，want 404（管理面归档只服务组织行）", tc.method, tc.path, marketCode, marketBody)
		}
	}

	// ---- 2. 管理面对组织行照常下发（拒绝面不能把正路一起关掉）----------------------
	code, body := adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets/org-preset/archive", "")
	if code != 200 {
		t.Fatalf("组织行管理面归档 = %d %s，want 200", code, body)
	}
	if body != string(orgArchive) {
		t.Fatalf("组织行下发字节与上传归档不一致：%d vs %d 字节", len(body), len(orgArchive))
	}
	if code, body := adminDo(t, r, adminHdr, "GET", "/api/server/admin/agent-presets/org-preset/1.0.0/archive", ""); code != 200 {
		t.Fatalf("组织行版本级归档 = %d %s，want 200", code, body)
	}

	// ---- 3. 反向：员工面仍两渠道都服务（市场智能体的安装通路）---------------------
	// 市场行对员工可见需已授权（serveArchive 的授权闸门；作者或授权主体）。
	if err := grantPresetForTest(db, "mkt-agent"); err != nil {
		t.Fatalf("夹具授权: %v", err)
	}
	if code, body := userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets/mkt-agent/archive", ""); code != 200 {
		t.Fatalf("员工面市场行归档 = %d %s，want 200（能力中心安装通路不得被加固误伤）", code, body)
	}
	if code, body := userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets/mkt-agent/1.0.0/archive", ""); code != 200 {
		t.Fatalf("员工面市场行版本级归档 = %d %s，want 200", code, body)
	}
}

// grantPresetForTest 给 alice（`setup` 的 userHdr 身份）授权一个智能体预设 ——
// 员工面归档下载的授权闸门（serveArchive 的 admin=false 分支）。
func grantPresetForTest(db *sql.DB, name string) error {
	return serverstore.GrantApp(db, serverstore.AppKindAgent, name, "alice", string(serverstore.GranteeUser))
}
