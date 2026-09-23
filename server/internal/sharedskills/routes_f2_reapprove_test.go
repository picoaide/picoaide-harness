package sharedskills

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N3,共享技能侧)的永久回归
//
// 与 agentshare 同源:reject 清掉归档(agentshare-5 的存储上界),而 approve
// 没有守卫 —— 误拒后改判通过会得到 status=approved + archive_bytes=0 的坏行:
// 员工清单可见、下载 500「归档数据缺失」。不变量:approved 行必须有归档字节。
// ---------------------------------------------------------------------------

func TestSharedSkillRejectedVersionCannotBeApprovedWithoutArchive(t *testing.T) {
	r, db, adminHdr, userHdr, otherHdr := setup(t)
	defer db.Close()

	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills", skillUpload(t, "reapprove-guard", "1.0.0", "误拒技能")); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST", "/api/server/admin/shared-skills/reapprove-guard/1.0.0/reject", rejectBody("误拒")); code != http.StatusOK {
		t.Fatalf("reject = %d %s", code, body)
	}
	cleared, err := serverstore.GetSharedSkill(db, "reapprove-guard", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.Archive) != 0 {
		t.Fatalf("precondition: reject 应当释放归档字节,仍有 %d 字节", len(cleared.Archive))
	}

	code, body := skAdminDo(t, r, adminHdr, "POST", "/api/server/admin/shared-skills/reapprove-guard/1.0.0/approve", "")
	t.Logf("RE-APPROVE -> %d %s", code, body)
	if code != http.StatusConflict {
		t.Errorf("re-approve = %d %s, want 409(归档已清理,不能置为 approved)", code, body)
	}
	row, err := serverstore.GetSharedSkill(db, "reapprove-guard", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != serverstore.SharedSkillRejected {
		t.Fatalf("status = %s, want rejected", row.Status)
	}
	// 未授权的员工看不到它;作者本人看到的状态仍是 rejected。
	if code, body := skUserDo(t, r, otherHdr, "GET", "/api/client/v2/shared-skills", ""); code != http.StatusOK || strings.Contains(body, "reapprove-guard") {
		t.Fatalf("other employee list = %d %s, want 200 without the broken version", code, body)
	}
	if code, body := skUserDo(t, r, userHdr, "GET", "/api/client/v2/shared-skills", ""); code != http.StatusOK || !strings.Contains(body, "\"status\":\"rejected\"") {
		t.Fatalf("author list = %d %s, want the row still reported as rejected", code, body)
	}
}

// ---------------------------------------------------------------------------
// ID-01(审计 2026-09-23,P0):对**已通过审核**的版本点「拒绝」必须 409 且归档
// 字节原封不动 —— 拒绝与释放归档是同一条 UPDATE,对在服务的版本执行它会
// 不可恢复地销毁归档、让该版本对全员 404、并烧掉版本号(同版本号永久占位)。
//
// 修法:前置条件下沉到 DAO(唯一实现),handler 只把 sentinel 映射成 409。
// 变异验证:去掉 serverstore/apps.go rejected 分支的 `AND status <> ?` ⇒ 本用例红。
// ---------------------------------------------------------------------------
func TestSharedSkillRejectApprovedVersionKeepsArchive(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	const name = "id01-approved"

	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		skillUpload(t, name, "1.0.0", "已发布技能")); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	// 待审期间 apps 投影行必须是 app_id 占位(待审版本没有生效),approve 之后
	// 必须回填成生效版本的标题(G-P2-3:漏掉回填就是"批准了却看不到新标题")。
	if app, err := serverstore.GetApp(db, serverstore.AppKindSkill, name); err != nil || app.Title != name {
		t.Fatalf("待审投影 = %+v err=%v, want title=app_id 占位", app, err)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+name+"/1.0.0/approve", ""); code != http.StatusOK {
		t.Fatalf("approve = %d %s", code, body)
	}
	proj, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil {
		t.Fatal(err)
	}
	if proj.Title == name || proj.Title == "" {
		t.Fatalf("approve 后投影未回填: title=%q", proj.Title)
	}
	before, err := serverstore.GetSharedSkill(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Archive) == 0 {
		t.Fatal("precondition: 通过审核的版本必须有归档字节")
	}

	// 核心断言:拒绝已通过版本 → 409 + 明确指路,且**行一字不动**。
	code, body := skAdminDo(t, r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+name+"/1.0.0/reject", rejectBody("管理员想停服务"))
	t.Logf("REJECT-APPROVED -> %d %s", code, body)
	if code != http.StatusConflict {
		t.Fatalf("拒绝已通过版本 = %d %s, want 409(ID-01 的 P0:会不可恢复销毁归档)", code, body)
	}
	if !strings.Contains(body, "已通过审核") || !strings.Contains(body, "下架") {
		t.Errorf("409 文案必须说清「已通过不可拒绝」并指路「下架」: %s", body)
	}
	after, err := serverstore.GetSharedSkill(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != serverstore.SharedSkillApproved {
		t.Fatalf("status = %s, want approved", after.Status)
	}
	if len(after.Archive) != len(before.Archive) || len(after.Archive) == 0 {
		t.Fatalf("归档被销毁: archive=%d→%d", len(before.Archive), len(after.Archive))
	}
	// 该版本必须仍对员工可下载(没有被"销毁 ⇒ 404")。
	if code, body := skUserDo(t, r, userHdr, "GET",
		"/api/client/v2/shared-skills/"+name+"/1.0.0/archive", ""); code != http.StatusOK {
		t.Fatalf("已通过版本下载 = %d %s, want 200", code, body)
	}

	// 控制组:待审的新版本仍必须可被正常拒绝(修复不能把"拒绝"整个关掉)。
	if code, body := skUserDo(t, r, userHdr, "POST", "/api/client/v2/shared-skills",
		skillUpload(t, name, "1.1.0", "待审技能")); code != http.StatusCreated {
		t.Fatalf("upload v1.1.0 = %d %s", code, body)
	}
	if code, body := skAdminDo(t, r, adminHdr, "POST",
		"/api/server/admin/shared-skills/"+name+"/1.1.0/reject", rejectBody("不合规")); code != http.StatusOK {
		t.Fatalf("拒绝待审版本 = %d %s, want 200", code, body)
	}
	rejected, _ := serverstore.GetSharedSkill(db, name, "1.1.0")
	if rejected.Status != serverstore.SharedSkillRejected || len(rejected.Archive) != 0 {
		t.Fatalf("待审版本的拒绝语义被破坏: status=%s archive=%d", rejected.Status, len(rejected.Archive))
	}
}
