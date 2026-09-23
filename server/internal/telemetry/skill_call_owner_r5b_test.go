package telemetry

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// R5-B-2 的遥测孪生（跨泳道补齐 2026-09-23）：作者例外的判据从
// `app_releases.publisher`（上传者）同源到 `apps.owner`（归属人）——归属转移后
// 只有**新归属人**仍可在没有授权的情况下给自己负责的内容上报计数，旧上传者按
// 普通同事规则（未授权 ⇒ 静默不计数）。
//
// 影响面**仅限计数**：本判据只决定 `calls` 是否 +1，不改变任何内容的可见性与
// 分发路径（读侧列表/详情与归档下载各自的判据未变），因此既有计数语义只在
// 「归属被转移」这一种情形下改变。
//
// 判据的可打坏性：把 skillCallTargetAllowed 的 dist.OwnedBy 改回
// `rel.Publisher == u.Username` 即红（转移后 alice 会重新计数、bob 不再计数）。
func TestReportSkillCallOwnerExemptionFollowsOwnership(t *testing.T) {
	r, db, aliceToken := newTestEnv(t)

	// bob：第二个账号 —— 既不是上传者，也没有被授权。
	bobID, err := serverstore.CreateUserWithPassword(db, "bob", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	bobToken, err := serverauth.IssueToken(db, bobID)
	if err != nil {
		t.Fatal(err)
	}

	// 市场技能：上传者（= 首版归属人）alice，未给任何人授权。
	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "owner-skill", Version: "1.0.0", Author: "alice", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}

	// 正对照①：归属人无需授权即可上报（作者例外本身不得被改坏）。
	if w := post(r, aliceToken, skillCallPath, `{"name":"owner-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("归属人上报 = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "owner-skill"); got != 1 {
		t.Fatalf("归属人上报后 calls = %d, want 1（作者例外）", got)
	}

	// 正对照②：非归属人且未授权 ⇒ 严格默认拒绝，计数不落（既有语义不变）。
	if w := post(r, bobToken, skillCallPath, `{"name":"owner-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("未授权同事上报 = %d body=%s, want 200（静默忽略，不给不可见目标计数）", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "owner-skill"); got != 1 {
		t.Fatalf("未授权同事上报后 calls = %d, want 1（不得计数）", got)
	}

	// 归属转移：alice → bob（与发布权 / 归档下载豁免同一事实源 apps.owner）。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "owner-skill", false, "bob"); err != nil {
		t.Fatal(err)
	}

	// ① 新归属人：豁免立即生效（无需授权）。
	if w := post(r, bobToken, skillCallPath, `{"name":"owner-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("新归属人上报 = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "owner-skill"); got != 2 {
		t.Fatalf("新归属人上报后 calls = %d, want 2（豁免必须跟随 apps.owner）", got)
	}

	// ② 旧上传者：失去豁免 ⇒ 与普通未授权同事同语义（200 静默、不计数）。
	if w := post(r, aliceToken, skillCallPath, `{"name":"owner-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("旧上传者上报 = %d body=%s, want 200（与不可见目标同语义）", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "owner-skill"); got != 2 {
		t.Fatalf("旧上传者上报后 calls = %d, want 2（转移后不再有作者例外）", got)
	}
}
