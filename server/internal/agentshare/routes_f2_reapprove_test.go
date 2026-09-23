package agentshare

import (
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// R7 二轮复核(F2-N3)的永久回归
//
// 一轮的 agentshare-5 修复让 reject 清掉归档字节(存储上界),但 decide
// (Approved) 对 rejected → approved 没有任何守卫,而 webadmin 对每一行
// status != 'approved' 都渲染「通过」按钮(Capabilities.tsx):
// 误拒后再点「通过」,行变成 approved、员工清单可见(授权仍在),归档却是空的
// —— 员工下载 500「归档数据缺失」、管理员预览 404。基点(不清归档)时这条
// 「改判」路径是可用的,所以这是修复引入的回归。
//
// 不变量:approved 行必须有归档字节。两条审核端点(按版本 / 按最新)都要守。
// ---------------------------------------------------------------------------

func TestRejectedVersionCannotBeApprovedWithoutArchive(t *testing.T) {
	r, db, adminHdr, userHdr, otherHdr := setup(t)
	defer db.Close()

	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("误拒预设", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("reapprove-guard", "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/reapprove-guard/1.0.0/reject", rejectBody("误拒")); code != http.StatusOK {
		t.Fatalf("reject = %d %s", code, body)
	}
	cleared, err := serverstore.GetAgentPresetByVersion(db, "reapprove-guard", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(cleared.Archive) != 0 {
		t.Fatalf("precondition: reject 应当释放归档字节,仍有 %d 字节", len(cleared.Archive))
	}

	for _, path := range []string{
		"/api/server/admin/agent-presets/reapprove-guard/1.0.0/approve", // 按版本
		"/api/server/admin/agent-presets/reapprove-guard/approve",       // 按最新未审行(旧 UI)
	} {
		code, body := adminDo(t, r, adminHdr, "POST", path, "")
		t.Logf("RE-APPROVE %s -> %d %s", path, code, body)
		if code != http.StatusConflict {
			t.Errorf("re-approve %s = %d %s, want 409(归档已清理,不能置为 approved)", path, code, body)
		}
		if !strings.Contains(body, "归档") {
			t.Errorf("re-approve %s 的错误信息没有说明归档已清理: %s", path, body)
		}
	}

	// 行必须仍是 rejected —— 不能留下「approved 却下载不了」的坏行。
	row, err := serverstore.GetAgentPresetByVersion(db, "reapprove-guard", "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != serverstore.AgentPresetRejected {
		t.Fatalf("status = %s, want rejected(无归档的版本不得变成 approved)", row.Status)
	}
	// 别的员工(未授权)看不到它;作者本人看到的状态必须是 rejected。
	code, body := userDo(t, r, otherHdr, "GET", "/api/client/v2/agent-presets", "")
	if code != http.StatusOK || strings.Contains(body, "reapprove-guard") {
		t.Fatalf("other employee list = %d %s, want 200 without the broken version", code, body)
	}
	code, body = userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets", "")
	if code != http.StatusOK || !strings.Contains(body, "\"status\":\"rejected\"") {
		t.Fatalf("author list = %d %s, want the row still reported as rejected", code, body)
	}
	if code, body := userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets/reapprove-guard/1.0.0/archive", ""); code == http.StatusOK {
		t.Fatalf("employee download = %d %s, want a refusal", code, body)
	}
}

// TestApproveKeepsWorkingWhenArchiveIsPresent:控制组 —— 守卫不能把正常的
// 「待审 → 通过」路径一起挡掉(第一轮的修复不能退化)。
func TestApproveKeepsWorkingWhenArchiveIsPresent(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()

	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("正常通过", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets", uploadBody("normal-approve", "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "POST", "/api/server/admin/agent-presets/normal-approve/1.0.0/approve", ""); code != http.StatusOK {
		t.Fatalf("approve = %d %s, want 200", code, body)
	}
	if code, body := userDo(t, r, userHdr, "GET", "/api/client/v2/agent-presets/normal-approve/1.0.0/archive", ""); code != http.StatusOK {
		t.Fatalf("employee download after approve = %d %s, want 200", code, body)
	}
}

// ---------------------------------------------------------------------------
// ID-01(审计 2026-09-23,P0)—— 智能体面的同一条不变量(与 sharedskills 同源):
// 已通过审核的版本不可被「拒绝」,否则归档字节被不可恢复地销毁、该版本对全员
// 404、版本号烧毁。修法在 DAO(唯一实现),本用例钉住 handler 的 409 映射。
// ---------------------------------------------------------------------------
func TestRejectApprovedVersionKeepsArchive(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	const name = "id01-approved-agent"

	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("已发布智能体", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody(name, "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
	if code, body := adminDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.0.0/approve", ""); code != http.StatusOK {
		t.Fatalf("approve = %d %s", code, body)
	}
	before, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if len(before.Archive) == 0 {
		t.Fatal("precondition: 通过审核的版本必须有归档字节")
	}

	// 按版本拒绝已通过版本 → 409 + 归档不变 + 状态不变。
	code, body := adminDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.0.0/reject", rejectBody("想停服务"))
	t.Logf("REJECT-APPROVED(versioned) -> %d %s", code, body)
	if code != http.StatusConflict {
		t.Fatalf("拒绝已通过版本 = %d %s, want 409", code, body)
	}
	if !strings.Contains(body, "已通过审核") {
		t.Errorf("409 文案没有说明「已通过不可拒绝」: %s", body)
	}
	after, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != serverstore.AgentPresetApproved || len(after.Archive) != len(before.Archive) {
		t.Fatalf("拒绝改变了已通过版本: status=%s archive=%d→%d",
			after.Status, len(before.Archive), len(after.Archive))
	}
	if code, body := userDo(t, r, userHdr, "GET",
		"/api/client/v2/agent-presets/"+name+"/1.0.0/archive", ""); code != http.StatusOK {
		t.Fatalf("已通过版本下载 = %d %s, want 200", code, body)
	}

	// name 级(旧 UI 的"最新未审行")路径不能把已通过版本打掉:此时没有待审行,
	// 必须是"找不到待审版本"而不是销毁已上架的那一版。
	code, body = adminDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/reject", rejectBody("旧 UI 路径"))
	if code == http.StatusOK {
		t.Fatalf("name 级 reject 打掉了已通过版本: %d %s", code, body)
	}
	final, _ := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
	if final.Status != serverstore.AgentPresetApproved || len(final.Archive) == 0 {
		t.Fatalf("name 级 reject 破坏了已通过版本: status=%s archive=%d", final.Status, len(final.Archive))
	}
}
