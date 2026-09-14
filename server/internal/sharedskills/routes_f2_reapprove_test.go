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
