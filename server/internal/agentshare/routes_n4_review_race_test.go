package agentshare

import (
	"fmt"
	"net/http"
	"sync"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// N-4 永久回归(2026-09-13 三轮):审批守卫必须是「写入时原子判定」,
// 不能是「先读归档长度、再改状态」的 check-then-act。
//
// 两个管理员同时对同一 pending 版本操作(一个通过、一个拒绝)时的交错:
//
//	approve: 读到 archive 非空 → 通过守卫
//	reject:  置 rejected 并释放归档
//	approve: 置 approved            ⇒ approved + archive_bytes=0 坏行
//
// 实测(修复前)12 轮里 6~7 轮留下坏行:员工清单可见、下载 500。
// 修复:SetReleaseStatusForReview 把「状态 = approved」与「archive 非空」放进
// 同一条条件 UPDATE,而「置 rejected」与「释放归档」也合并成同一条 —— 于是
// PostgreSQL 的行级锁 + READ COMMITTED 重求值(EPQ)让任何交错都产不出坏行。
//
// 本文件用**真并发**(同一版本上 approve/reject 同时发)多轮验证。
// ---------------------------------------------------------------------------

// uploadPendingPreset 上传一个待审预设,返回 (name, archive 字节数)。
func uploadPendingPreset(t *testing.T, r http.Handler, userHdr map[string]string, name string) {
	t.Helper()
	archive := makeArchive(t, map[string]string{
		"agent.cordis.yml": testComposition,
		"preset.yml":       presetMeta("并发审核", "1.0.0"),
	})
	if code, body := userDo(t, r, userHdr, "POST", "/api/client/v2/agent-presets",
		uploadBody(name, "", "", archive)); code != http.StatusCreated {
		t.Fatalf("upload = %d %s", code, body)
	}
}

// TestReviewRaceApproveVsRejectNeverLeavesBrokenRow:N-4 的核心断言 ——
// 真并发多轮,任何一轮都不允许出现 `approved + 空归档` 的坏行。
func TestReviewRaceApproveVsRejectNeverLeavesBrokenRow(t *testing.T) {
	const rounds = 12
	bad := 0
	for i := 0; i < rounds; i++ {
		func() {
			r, db, adminHdr, userHdr, _ := setup(t)
			defer db.Close()
			name := fmt.Sprintf("n4-race-%d", i)
			uploadPendingPreset(t, r, userHdr, name)

			var wg sync.WaitGroup
			start := make(chan struct{})
			codes := make([]int, 2)
			wg.Add(2)
			go func() {
				defer wg.Done()
				<-start
				codes[0], _ = adminDo(t, r, adminHdr, "POST",
					"/api/server/admin/agent-presets/"+name+"/1.0.0/approve", "")
			}()
			go func() {
				defer wg.Done()
				<-start
				codes[1], _ = adminDo(t, r, adminHdr, "POST",
					"/api/server/admin/agent-presets/"+name+"/1.0.0/reject", rejectBody("并发拒绝"))
			}()
			close(start)
			wg.Wait()

			row, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
			if err != nil {
				t.Fatalf("round %d: %v", i, err)
			}
			// 唯一允许的两个终态:approved+有归档、rejected+无归档。
			switch {
			case row.Status == serverstore.AgentPresetApproved && len(row.Archive) == 0:
				bad++
				t.Errorf("round %d: 坏行 approved + archive_bytes=0(codes=%v)", i, codes)
			case row.Status == serverstore.AgentPresetApproved && len(row.Archive) > 0:
				if code, body := userDo(t, r, userHdr, "GET",
					"/api/client/v2/agent-presets/"+name+"/1.0.0/archive", ""); code != http.StatusOK {
					t.Errorf("round %d: approved 行下载 = %d %s", i, code, body)
				}
			case row.Status == serverstore.AgentPresetRejected:
				// 拒绝终态:行必须不可下载(404),且不能出现在员工清单里。
			default:
				t.Errorf("round %d: 终态既不是 approved 也不是 rejected: %s", i, row.Status)
			}
			for _, c := range codes {
				if c != http.StatusOK && c != http.StatusConflict {
					t.Errorf("round %d: 审核响应码 %d 不在 {200,409} 内(codes=%v)", i, c, codes)
				}
			}
			t.Logf("round %d: codes=%v status=%s archive=%d", i, codes, row.Status, len(row.Archive))
		}()
	}
	if bad > 0 {
		t.Fatalf("%d/%d 轮留下 approved+空归档的坏行(N-4 守卫仍可被并发绕过)", bad, rounds)
	}
}

// TestApproveAfterRejectSequentialIs409:顺序路径(误拒后点通过)的文案与状态。
// 这是 F2-N3 的原始不变量,修复 N-4 时不能把它丢掉。
func TestApproveAfterRejectSequentialIs409(t *testing.T) {
	r, db, adminHdr, userHdr, _ := setup(t)
	defer db.Close()
	const name = "n4-seq"
	uploadPendingPreset(t, r, userHdr, name)

	if code, body := adminDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.0.0/reject", rejectBody("误拒")); code != http.StatusOK {
		t.Fatalf("reject = %d %s", code, body)
	}
	code, body := adminDo(t, r, adminHdr, "POST",
		"/api/server/admin/agent-presets/"+name+"/1.0.0/approve", "")
	t.Logf("re-approve -> %d %s", code, body)
	if code != http.StatusConflict {
		t.Fatalf("误拒后再通过 = %d, want 409(ARCHIVE_CLEARED)", code)
	}
	row, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if row.Status != serverstore.AgentPresetRejected || len(row.Archive) != 0 {
		t.Fatalf("误拒后再通过改变了行: status=%s archive=%d", row.Status, len(row.Archive))
	}
	// 员工下载必须 404(不再有「可见但 500」的坏行)。
	if code, body := userDo(t, r, userHdr, "GET",
		"/api/client/v2/agent-presets/"+name+"/1.0.0/archive", ""); code == http.StatusOK {
		t.Fatalf("被拒版本仍可下载: %d %s", code, body)
	}
}

// TestRejectThenRejectAndConcurrentRejectsAreIdempotent:两个 reject 并发、
// 或重复 reject,都不能 500,也不能把归档留在 rejected 行上(存储上界)。
func TestRejectThenRejectAndConcurrentRejectsAreIdempotent(t *testing.T) {
	for round := 0; round < 4; round++ {
		func() {
			r, db, adminHdr, userHdr, _ := setup(t)
			defer db.Close()
			name := fmt.Sprintf("n4-double-reject-%d", round)
			uploadPendingPreset(t, r, userHdr, name)

			var wg sync.WaitGroup
			start := make(chan struct{})
			codes := make([]int, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					codes[i], _ = adminDo(t, r, adminHdr, "POST",
						"/api/server/admin/agent-presets/"+name+"/1.0.0/reject", rejectBody("并发拒绝"))
				}(i)
			}
			close(start)
			wg.Wait()

			row, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("round %d: codes=%v status=%s archive=%d", round, codes, row.Status, len(row.Archive))
			if row.Status != serverstore.AgentPresetRejected {
				t.Errorf("round %d: 并发 reject 后 status=%s", round, row.Status)
			}
			if len(row.Archive) != 0 {
				t.Errorf("round %d: rejected 行仍留着 %d 字节归档(存储上界被绕过)", round, len(row.Archive))
			}
			for _, c := range codes {
				if c == http.StatusInternalServerError {
					t.Errorf("round %d: 并发 reject 出现 500(codes=%v)", round, codes)
				}
			}
		}()
	}
}

// TestConcurrentApprovesKeepArchive:两个 approve 并发时,赢家必须留下完整归档,
// 且两边的响应码都在 {200,409}(不能出现 500)。
func TestConcurrentApprovesKeepArchive(t *testing.T) {
	for round := 0; round < 4; round++ {
		func() {
			r, db, adminHdr, userHdr, _ := setup(t)
			defer db.Close()
			name := fmt.Sprintf("n4-double-approve-%d", round)
			uploadPendingPreset(t, r, userHdr, name)

			var wg sync.WaitGroup
			start := make(chan struct{})
			codes := make([]int, 2)
			for i := 0; i < 2; i++ {
				wg.Add(1)
				go func(i int) {
					defer wg.Done()
					<-start
					codes[i], _ = adminDo(t, r, adminHdr, "POST",
						"/api/server/admin/agent-presets/"+name+"/1.0.0/approve", "")
				}(i)
			}
			close(start)
			wg.Wait()

			row, err := serverstore.GetAgentPresetByVersion(db, name, "1.0.0")
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("round %d: codes=%v status=%s archive=%d", round, codes, row.Status, len(row.Archive))
			if row.Status != serverstore.AgentPresetApproved || len(row.Archive) == 0 {
				t.Errorf("round %d: 并发 approve 后 status=%s archive=%d", round, row.Status, len(row.Archive))
			}
			if code, body := userDo(t, r, userHdr, "GET",
				"/api/client/v2/agent-presets/"+name+"/1.0.0/archive", ""); code != http.StatusOK {
				t.Errorf("round %d: 员工下载 = %d %s", round, code, body)
			}
			for _, c := range codes {
				if c != http.StatusOK && c != http.StatusConflict {
					t.Errorf("round %d: 响应码 %d 不在 {200,409}(codes=%v)", round, c, codes)
				}
			}
		}()
	}
}
