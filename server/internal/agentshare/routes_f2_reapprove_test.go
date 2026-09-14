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
