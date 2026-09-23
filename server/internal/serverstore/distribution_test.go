package serverstore

// 分发状态（下架）与归属判据的**唯一权威** —— 行为级判据（第五轮审计 R5-B-1/
// R5-B-2/R5-B-5，2026-09-23）。
//
// 语义定案见 distribution.go 的文件头。这里钉住 DAO 层的两条面：
//
//	ListOwned*（作者面）：apps.owner == viewer，**任意状态 + 忽略下架**；
//	ListVisible*（分发面）：只有可分发的东西 —— approved ∧ 已授权 ∧ 已上架，
//	                        外加「归属人自己的、已上架的」行。
//
// 变异验证：把 Delivered()/OwnedBy() 的任一处换回 publisher 判据或去掉下架
// 过滤，本文件的用例必须变红（对照见报告 fix-r5b-server-semantics.md）。

import "testing"

// TestDistributionPredicates 钉住唯一判据本身（纯函数，不需要 DB）：
// 「App 行不存在」与「下架」是两件不同的事 —— 前者不阻断首版发布，后者冻结
// 内容；作者面恒可见；空 owner 不属于任何人。
func TestDistributionPredicates(t *testing.T) {
	missing := Distribution{AppID: "new"}
	if missing.Delivered() {
		t.Fatal("App 行不存在不得被当成可分发（不存在 ⇒ 不可见）")
	}
	if !missing.Writable() {
		t.Fatal("App 行不存在 = 首版发布，必须放行写入面")
	}
	if missing.Delisted() {
		t.Fatal("App 行不存在不等于已下架（不得在作者面渲染「已下架」）")
	}

	live := Distribution{AppID: "x", Owner: "alice", Enabled: true, Exists: true}
	if !live.Delivered() || !live.Writable() || live.Delisted() {
		t.Fatalf("上架行判定错误: %+v", live)
	}
	if !live.AuthorVisible() {
		t.Fatal("作者面恒可见（AuthorVisible 是 R5-B-1 的语义落点）")
	}

	off := Distribution{AppID: "x", Owner: "alice", Enabled: false, Exists: true}
	if off.Delivered() {
		t.Fatal("下架行不得进入分发面")
	}
	if off.Writable() {
		t.Fatal("下架行必须冻结写入面（发布/审批一律拒绝）")
	}
	if !off.Delisted() || !off.AuthorVisible() {
		t.Fatal("下架行必须带 delisted 标记，且作者面照旧可见")
	}

	// OwnedBy 与发布权同源：空 owner（官方内容 / 2026-09-02 之前的历史行）
	// 不属于任何人。
	cases := []struct {
		owner, viewer string
		want          bool
	}{
		{"", "alice", false},
		{"alice", "", false},
		{"alice", "alice", true},
		{"alice", "bob", false},
	}
	for _, c := range cases {
		if got := AppOwnedByOwner(c.owner, c.viewer); got != c.want {
			t.Fatalf("AppOwnedByOwner(%q,%q) = %v, want %v", c.owner, c.viewer, got, c.want)
		}
		if got := (Distribution{Owner: c.owner}).OwnedBy(c.viewer); got != c.want {
			t.Fatalf("Distribution.OwnedBy(%q) = %v, want %v", c.viewer, got, c.want)
		}
	}

	// DistributionMap.Of：未知 App ⇒ 未下架（不阻断写入），不可分发。
	m := DistributionMap{}
	if got := m.Of("ghost"); got.Delivered() || !got.Writable() {
		t.Fatalf("DistributionMap.Of(未知) = %+v", got)
	}
}

func TestOwnedFaceUsesOwnerNotPublisher(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := CreateSharedSkill(db, &SharedSkill{
		Name: "r5b-owned", Version: "1.0.0", Author: "alice",
		Status: SharedSkillApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	app, err := GetApp(db, AppKindSkill, "r5b-owned")
	if err != nil {
		t.Fatal(err)
	}
	if app.Owner != "alice" || app.Enabled != 1 {
		t.Fatalf("夹具 app = %+v, want owner=alice enabled=1", app)
	}

	// 作者面：owner == viewer 才在自己的「我的」里（下架前）。
	for _, who := range []string{"alice", "bob"} {
		rows, err := ListOwnedSharedSkills(db, who)
		if err != nil {
			t.Fatal(err)
		}
		if want := who == "alice"; (len(rows) == 1) != want {
			t.Fatalf("ListOwnedSharedSkills(%s) = %d 行, want %v", who, len(rows), want)
		}
	}

	// 下架：作者面仍可见（R5-B-1 的核心），分发面对**所有人**关门（含已授权者）。
	if err := SetAppEnabled(db, AppKindSkill, "r5b-owned", false); err != nil {
		t.Fatal(err)
	}
	owned, err := ListOwnedSharedSkills(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if len(owned) != 1 {
		t.Fatalf("下架后作者面 %d 行, want 1（作者必须能看到「已下架」状态）", len(owned))
	}
	for _, who := range []string{"alice", "bob"} {
		vis, err := ListVisibleSharedSkills(db, who, []string{"r5b-owned"})
		if err != nil {
			t.Fatal(err)
		}
		if len(vis) != 0 {
			t.Fatalf("下架后 %s 的分发面仍有 %d 行（下架 = 与不存在同语义）", who, len(vis))
		}
	}

	// 归属转移：判据是 apps.owner，**与发布权同源** —— 旧作者立刻看不到，
	// 新归属人立刻看得到（下架态也不例外：作者面忽略下架）。
	if err := SetAppOfficial(db, AppKindSkill, "r5b-owned", false, "bob"); err != nil {
		t.Fatal(err)
	}
	if rows, err := ListOwnedSharedSkills(db, "alice"); err != nil {
		t.Fatal(err)
	} else if len(rows) != 0 {
		t.Fatalf("归属转移后旧作者仍看到 %d 行（R5-B-2 回归）", len(rows))
	}
	if rows, err := ListOwnedSharedSkills(db, "bob"); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("归属转移后新归属人看到 %d 行, want 1（他是唯一有权续传的人）", len(rows))
	}

	// 重新上架：分发面恢复（归属人无需授权；其他人仍需授权）。
	if err := SetAppEnabled(db, AppKindSkill, "r5b-owned", true); err != nil {
		t.Fatal(err)
	}
	if rows, err := ListVisibleSharedSkills(db, "bob", nil); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("上架后归属人分发面 %d 行, want 1", len(rows))
	}
	if rows, err := ListVisibleSharedSkills(db, "alice", []string{"r5b-owned"}); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("上架+授权后同事分发面 %d 行, want 1", len(rows))
	}
}

// 智能体侧与技能侧**逐条同形**（同一份判据、同一种面拆分）。
func TestOwnedFaceParityForAgents(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if _, err := CreateAgentPreset(db, &AgentPreset{
		Name: "r5b-agent", Version: "1.0.0", Author: "alice",
		Status: AgentPresetApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := SetAppEnabled(db, AppKindAgent, "r5b-agent", false); err != nil {
		t.Fatal(err)
	}
	if rows, err := ListOwnedAgentPresets(db, "alice"); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("下架后作者面（agent）%d 行, want 1", len(rows))
	}
	if rows, err := ListVisibleAgentPresets(db, "alice", []string{"r5b-agent"}); err != nil {
		t.Fatal(err)
	} else if len(rows) != 0 {
		t.Fatalf("下架后分发面（agent）%d 行, want 0", len(rows))
	}
	if err := SetAppOfficial(db, AppKindAgent, "r5b-agent", false, "bob"); err != nil {
		t.Fatal(err)
	}
	if rows, err := ListOwnedAgentPresets(db, "alice"); err != nil {
		t.Fatal(err)
	} else if len(rows) != 0 {
		t.Fatalf("转移后旧作者（agent）仍看到 %d 行", len(rows))
	}
	if rows, err := ListOwnedAgentPresets(db, "bob"); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("转移后新归属人（agent）看到 %d 行, want 1", len(rows))
	}
}

// 空 owner（官方内容 / 2026-09-02 之前的历史行）不属于任何人：既不在任何人的
// 「我的」里，也不受「下架」的可见性影响（它照旧按 approved+授权分发）。
// 这条与 appstore.Publish 的既有规则逐字同义：空 owner 一律视同占名，非管理员
// 不得接管发布 ⇒ 也就没人该在「我的」里看到它。
func TestEmptyOwnerBelongsToNobody(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	if err := UpsertApp(db, &App{
		Kind: AppKindSkill, AppID: "legacy-official", Title: "legacy-official",
		Channel: AppChannelOrg, Enabled: 1, Owner: "", Official: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, &Release{
		Kind: AppKindSkill, AppID: "legacy-official", Version: "1.0.0",
		Publisher: "boss", Status: ReleaseStatusApproved, Archive: []byte("zip"),
	}); err != nil {
		t.Fatal(err)
	}
	for _, who := range []string{"boss", "alice"} {
		rows, err := ListOwnedSharedSkills(db, who)
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) != 0 {
			t.Fatalf("空 owner 的行出现在 %s 的「我的」里（%d 行）", who, len(rows))
		}
	}
	// 分发面照旧：已授权即可见。
	if rows, err := ListVisibleSharedSkills(db, "alice", []string{"legacy-official"}); err != nil {
		t.Fatal(err)
	} else if len(rows) != 1 {
		t.Fatalf("空 owner 的已授权行在分发面 %d 行, want 1", len(rows))
	}
	// 未授权者不可见（严格默认拒绝，不因为 owner 为空而放宽）。
	if rows, err := ListVisibleSharedSkills(db, "alice", nil); err != nil {
		t.Fatal(err)
	} else if len(rows) != 0 {
		t.Fatalf("未授权的空 owner 行在分发面 %d 行, want 0", len(rows))
	}
}
