package serverstore

// 员工可见性的「下架」闸门必须**两种 kind 一致**（2026-09-15）。
//
// 背景：智能体侧在 2026-09-13 P2-1 补了 apps.enabled=0 ⇒ 员工面等同不存在；
// 技能侧当时漏了，于是同一个"下架"动作在两面行为不同（技能仍可列出/下载）。
// 这条测试是**跨 kind 的对拍门禁**：任何一侧把 enabled 过滤摘掉都会在这里变红，
// 而不是等到客户现场发现"下架了还能装"。
//
// 断言层次选在 DAO（ListVisibleSharedSkills / ListVisibleAgentPresets），因为两条
// 员工清单（/api/client/v2/capabilities 与 /api/client/v2/shared-skills）都走它们；
// 面层的端到端链路另有 internal/capabilities/skill_lifecycle_test.go。

import (
	"testing"
)

func TestVisibleListingsExcludeDisabledAppsBothKinds(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()

	// 两边各造一条 approved 的种子（CreateSharedSkill / CreateAgentPreset 都是
	// 保留的测试播种 API），再各自造一条**已下架**的。
	seed := []struct {
		kind   string
		name   string
		create func(name string) error
	}{
		{AppKindSkill, "live-skill", func(name string) error {
			_, err := CreateSharedSkill(db, &SharedSkill{
				Name: name, DisplayName: name, Version: "1.0.0",
				Author: "alice", Status: SharedSkillApproved, Archive: []byte("zip"),
			})
			return err
		}},
		{AppKindSkill, "off-skill", func(name string) error {
			_, err := CreateSharedSkill(db, &SharedSkill{
				Name: name, DisplayName: name, Version: "1.0.0",
				Author: "alice", Status: SharedSkillApproved, Archive: []byte("zip"),
			})
			return err
		}},
		{AppKindAgent, "live-agent", func(name string) error {
			_, err := CreateAgentPreset(db, &AgentPreset{
				Name: name, DisplayName: name, Version: "1.0.0",
				Author: "alice", Status: AgentPresetApproved, Archive: []byte("zip"),
			})
			return err
		}},
		{AppKindAgent, "off-agent", func(name string) error {
			_, err := CreateAgentPreset(db, &AgentPreset{
				Name: name, DisplayName: name, Version: "1.0.0",
				Author: "alice", Status: AgentPresetApproved, Archive: []byte("zip"),
			})
			return err
		}},
	}
	for _, s := range seed {
		if err := s.create(s.name); err != nil {
			t.Fatalf("seed %s/%s: %v", s.kind, s.name, err)
		}
	}
	// 只下架 off-*（作者是 alice，下面用 bob + 全员授权来验证"非作者"路径）。
	for _, kind := range []string{AppKindSkill, AppKindAgent} {
		name := "off-" + map[string]string{AppKindSkill: "skill", AppKindAgent: "agent"}[kind]
		if err := SetAppEnabled(db, kind, name, false); err != nil {
			t.Fatalf("disable %s: %v", name, err)
		}
	}

	for _, kind := range []string{AppKindSkill, AppKindAgent} {
		live := "live-" + map[string]string{AppKindSkill: "skill", AppKindAgent: "agent"}[kind]
		off := "off-" + map[string]string{AppKindSkill: "skill", AppKindAgent: "agent"}[kind]
		// bob 未授权、也不是作者：两条都不可见（授权门由别处覆盖）。
		// 这里给 bob 全员授权，把"下架门"单独隔离出来。
		granted := []string{live, off}

		if kind == AppKindSkill {
			rows, err := ListVisibleSharedSkills(db, "bob", granted)
			if err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for _, r := range rows {
				seen[r.Name] = true
			}
			if !seen[live] {
				t.Fatalf("已上架技能应可见: %+v", seen)
			}
			if seen[off] {
				t.Fatal("技能侧：apps.enabled=0 的技能仍出现在员工可见清单（下架不生效）")
			}
		} else {
			rows, err := ListVisibleAgentPresets(db, "bob", granted)
			if err != nil {
				t.Fatal(err)
			}
			seen := map[string]bool{}
			for _, r := range rows {
				seen[r.Name] = true
			}
			if !seen[live] {
				t.Fatalf("已上架智能体应可见: %+v", seen)
			}
			if seen[off] {
				t.Fatal("智能体侧：apps.enabled=0 的预设在员工可见清单里（P2-1 回归）")
			}
		}
	}
}
