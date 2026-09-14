package telemetry

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// R7-F3-N2(P2,复核 2026-09-13):srvcore-2 的修复把上报端点变成**比读侧更强**的
// 技能存在性预言机。修复只对齐了"未授权"这一半:
//
//	存在但对自己不可见 -> 404(修复新增)
//	平台上不存在       -> 200(既有"静默忽略"语义)
//
// 两点可分 ⇒ 任意登录员工可枚举平台上的技能名(含他人未审核/被拒的组织共享技能
// 版本)。读侧(marketplace.GetSkill / DownloadArchive / sharedskills.download)
// 刻意让"未授权"与"不存在"**同码 404**(不泄露资源存在性,AGENTS.md §2.1/§2.2)。
//
// 回归判据(两条必须同时成立):
//  1. 不可见技能的 calls 不变(srvcore-2 修好的那一半:计数不得落到不可见目标);
//  2. 不可见与不存在的响应**逐字节相同**(状态码/正文/Content-Type)——
//     对外表现与"这个技能不存在"不可区分,回到端点既有的"静默忽略"语义。
//
// 同时钉住"不误伤":授权之后同一请求必须照旧 200 且计数。
func TestReportSkillCallDoesNotRevealInvisibleTargetExistence(t *testing.T) {
	r, db, token := newTestEnv(t)
	withLimits(t, 100, 100) // 限流不是本用例的考点:给足预算,避免同名桶干扰

	// 存在但 alice 无任何授权(市场技能:严格默认拒绝)。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "internal-secret", Version: "1.0.0", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	invisible := post(r, token, skillCallPath, `{"name":"internal-secret"}`)
	unknown := post(r, token, skillCallPath, `{"name":"no-such-skill-xyz"}`)
	assertIndistinguishable(t, "不可见技能 vs 不存在", invisible, unknown)

	// 带 version 的精确目标同理(修复自己也覆盖了这条路径)。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "internal-secret-versioned", Version: "2.0.0", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	invisibleVersion := post(r, token, skillCallPath, `{"name":"internal-secret-versioned","version":"2.0.0"}`)
	unknownVersion := post(r, token, skillCallPath, `{"name":"no-such-skill-xyz","version":"9.9.9"}`)
	assertIndistinguishable(t, "不可见版本 vs 不存在版本", invisibleVersion, unknownVersion)

	// 他人**未审核**的组织共享技能版本:读侧不可见(作者以外),写侧同样不得可探。
	if _, err := serverstore.CreateSharedSkill(db, &serverstore.SharedSkill{
		Name: "bob-draft", Version: "1.0.0", Author: "bob", Status: serverstore.SharedSkillPending,
	}); err != nil {
		t.Fatal(err)
	}
	draft := post(r, token, skillCallPath, `{"name":"bob-draft","version":"1.0.0"}`)
	unknownDraft := post(r, token, skillCallPath, `{"name":"no-such-draft-xyz","version":"1.0.0"}`)
	assertIndistinguishable(t, "他人待审组织技能 vs 不存在", draft, unknownDraft)

	// srvcore-2 修好的那一半不得回退:计数一个都没落。
	if got := marketSkillCalls(t, db, "internal-secret"); got != 0 {
		t.Fatalf("invisible skill calls = %d, want 0", got)
	}
	rel, err := serverstore.GetRelease(db, serverstore.AppKindSkill, "internal-secret-versioned", "2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if rel.Calls != 0 {
		t.Fatalf("invisible version calls = %d, want 0", rel.Calls)
	}
	if ss, err := serverstore.GetSharedSkill(db, "bob-draft", "1.0.0"); err != nil {
		t.Fatal(err)
	} else if ss.Calls != 0 {
		t.Fatalf("unapproved shared skill calls = %d, want 0", ss.Calls)
	}

	// 不误伤:授权之后同一请求必须 200 且计数(第一轮修好的合法路径)。
	grantSkill(t, db, "internal-secret", "alice")
	if w := post(r, token, skillCallPath, `{"name":"internal-secret"}`); w.Code != http.StatusOK {
		t.Fatalf("granted skill report = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "internal-secret"); got != 1 {
		t.Fatalf("granted skill calls = %d, want 1", got)
	}
}

// assertIndistinguishable 断言两个响应逐字节相同 —— 存在性不可从响应区分。
func assertIndistinguishable(t *testing.T, label string, got, want *httptest.ResponseRecorder) {
	t.Helper()
	if got.Code != want.Code {
		t.Fatalf("%s: 状态码可区分(%d vs %d)—— 端点泄露技能存在性(读侧两者同码)",
			label, got.Code, want.Code)
	}
	if got.Body.String() != want.Body.String() {
		t.Fatalf("%s: 正文可区分(%q vs %q)", label, got.Body.String(), want.Body.String())
	}
	if ct, ctWant := got.Header().Get("Content-Type"), want.Header().Get("Content-Type"); ct != ctWant {
		t.Fatalf("%s: Content-Type 可区分(%q vs %q)", label, ct, ctWant)
	}
}
