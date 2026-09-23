package telemetry

import (
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// R5-B-1 的计数面闸门（2026-09-23 第五轮复审 B-N1）：`apps.enabled` 这一维此前
// **只在读侧生效** —— `skillCallTargetAllowed` 只判归属与授权，从不看 `enabled`，
// 而函数注释自称"口径与读侧一致：已上架 ∧ 已授权"。实测下架后归属人与已授权同事
// 上报仍然计 calls（0→1→2），而同刻读侧已按 `Delivered()` 隐藏（列表不列、详情/下载
// 404，admin 也不例外）。
//
// 本用例钉住修好之后的三件事，缺一即红：
//  1. **已上架仍计数**（正对照）：归属人 +1、已授权同事 +1 —— 闸门不得误伤正常上报；
//  2. **下架后不计数**：归属人与已授权同事上报仍 200（与"不存在"同语义，不泄露
//     存在性）但 `calls` 不再增长；
//  3. **可逆**：重新上架后同一请求立刻恢复计数（闸门读的是当下状态，不是快照）。
//
// 判据的可打坏性：把 `if !dist.Delivered()` 那一段删掉（= 修复前形态）⇒ 第 2 步红。
func TestReportSkillCallDoesNotCountDelistedSkill(t *testing.T) {
	r, db, aliceToken := newTestEnv(t)

	// carol：已授权同事（归属人之外的第二条合法计数路径）。
	carolID, err := serverstore.CreateUserWithPassword(db, "carol", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	carolToken, err := serverauth.IssueToken(db, carolID)
	if err != nil {
		t.Fatal(err)
	}

	// admin：读侧对已下架内容给 admin 的同样是 404（授权免、上下架不免）。
	adminHash, err := util.HashPassword("root123456")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: "root", PasswordHash: adminHash, Source: "local", Status: 1,
		IsAdmin: true, Role: serverstore.RoleSuperAdmin,
	}); err != nil {
		t.Fatal(err)
	}
	root, err := serverstore.GetUserByUsername(db, "root")
	if err != nil {
		t.Fatal(err)
	}
	adminToken, err := serverauth.IssueToken(db, root.ID)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: "delist-skill", Version: "1.0.0", Author: "alice", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	grantSkill(t, db, "delist-skill", "carol")

	// 1) 已上架：归属人 + 已授权同事各计一次（正对照）。
	for _, tc := range []struct{ label, token string }{
		{"归属人", aliceToken}, {"已授权同事", carolToken},
	} {
		if w := post(r, tc.token, skillCallPath, `{"name":"delist-skill"}`); w.Code != http.StatusOK {
			t.Fatalf("%s 上报 = %d body=%s, want 200", tc.label, w.Code, w.Body.String())
		}
	}
	if got := marketSkillCalls(t, db, "delist-skill"); got != 2 {
		t.Fatalf("已上架时 calls = %d, want 2（已上架仍计数：闸门不得误伤正常上报）", got)
	}

	// 2) 下架：三条路径（归属人 / 已授权同事 / admin）都不得再计数，
	//    响应仍是 200 + {"ok":true}（与"不存在"逐字节同语义，不泄露存在性）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, "delist-skill", false); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ label, token string }{
		{"归属人", aliceToken}, {"已授权同事", carolToken}, {"admin", adminToken},
	} {
		w := post(r, tc.token, skillCallPath, `{"name":"delist-skill"}`)
		if w.Code != http.StatusOK {
			t.Fatalf("下架后 %s 上报 = %d body=%s, want 200（静默忽略，不得给已下架内容计数）",
				tc.label, w.Code, w.Body.String())
		}
		if got := marketSkillCalls(t, db, "delist-skill"); got != 2 {
			t.Fatalf("下架后 %s 上报后 calls = %d, want 2（下架 = 不得分发 ⇒ 计数面同闸）", tc.label, got)
		}
	}

	// 3) 重新上架：同一请求立刻恢复计数（闸门读当下状态，可逆）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, "delist-skill", true); err != nil {
		t.Fatal(err)
	}
	if w := post(r, aliceToken, skillCallPath, `{"name":"delist-skill"}`); w.Code != http.StatusOK {
		t.Fatalf("重新上架后上报 = %d body=%s, want 200", w.Code, w.Body.String())
	}
	if got := marketSkillCalls(t, db, "delist-skill"); got != 3 {
		t.Fatalf("重新上架后 calls = %d, want 3（闸门必须可逆）", got)
	}
}

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
