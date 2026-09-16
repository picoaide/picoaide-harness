package serverstore

import (
	"database/sql"
	"testing"
)

// seedAppRelease 用**生产入口**播种「占名 + 建版本」:UpsertAppAndCreateReleaseOn
// 需要调用方提供事务(N-2:发布锁与落库同事务同连接),旧的 db 包装已随死代码删除。
func seedAppRelease(t *testing.T, db *sql.DB, app *App, rel *Release) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertAppAndCreateReleaseOn(tx, app, rel); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

// N4（R7 复核 F2 §N4）：渠道闸门必须落在 DAO 层——`ListAgentPresets` /
// `ListVisibleAgentPresets` 是「组织·共享 Agent」的**唯一**取数口，第一轮只在
// agentshare 的端点上加闸门，于是 internal/capabilities（能力中心 + 审批队列）
// 继续把市场渠道的行当成组织共享：市场下架（enabled=0）后仍出现在员工清单里。
// 对照技能侧：`ListSharedSkills` 一直走 `orgSkillReleases`（DAO 层过滤）。
func TestListAgentPresetsRejectsMarketChannelRows(t *testing.T) {
	db := openTestDB(t)

	// 组织渠道（CreateAgentPreset 走 AppChannelOrg）
	if _, err := CreateAgentPreset(db, &AgentPreset{Name: "org-agent", Version: "1.0.0", Author: "alice", Status: AgentPresetApproved}); err != nil {
		t.Fatal(err)
	}
	// 市场渠道（显式 channel=market）
	seedAppRelease(t, db, &App{
		Kind: AppKindAgent, AppID: "mkt-agent", Title: "市场智能体",
		Owner: "boss", Channel: AppChannelMarket, Enabled: 1,
	}, &Release{
		Kind: AppKindAgent, AppID: "mkt-agent", Version: "1.0.0", Title: "市场智能体",
		Author: "boss", Publisher: "boss", Status: ReleaseStatusApproved,
	})
	if err := GrantApp(db, AppKindAgent, "mkt-agent", "alice", "user"); err != nil {
		t.Fatal(err)
	}

	names := func(ps []AgentPreset) []string {
		out := []string{}
		for _, p := range ps {
			out = append(out, p.Name)
		}
		return out
	}

	all, err := ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range names(all) {
		if n == "mkt-agent" {
			t.Fatalf("管理端清单含市场行：%v", names(all))
		}
	}

	visible, err := ListVisibleAgentPresets(db, "alice", []string{"mkt-agent"})
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range names(visible) {
		if n == "mkt-agent" {
			t.Fatalf("员工可见清单含市场行（即使已授权）：%v", names(visible))
		}
	}

	// 组织行不受影响（positive control）
	found := false
	for _, n := range names(all) {
		if n == "org-agent" {
			found = true
		}
	}
	if !found {
		t.Fatalf("组织渠道行被误过滤：%v", names(all))
	}
}

// 下架市场行前后行为一致：DAO 不再返回它，enabled 状态与渠道语义无关。
func TestListAgentPresetsMarketDisableDoesNotChangeOrgView(t *testing.T) {
	db := openTestDB(t)
	seedAppRelease(t, db, &App{
		Kind: AppKindAgent, AppID: "mkt-down", Title: "市场下架",
		Owner: "boss", Channel: AppChannelMarket, Enabled: 1,
	}, &Release{
		Kind: AppKindAgent, AppID: "mkt-down", Version: "1.0.0", Title: "市场下架",
		Author: "boss", Publisher: "boss", Status: ReleaseStatusApproved,
	})
	before, err := ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := SetAppEnabled(db, AppKindAgent, "mkt-down", false); err != nil {
		t.Fatal(err)
	}
	after, err := ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != len(after) {
		t.Fatalf("下架改变了组织清单长度：before=%d after=%d", len(before), len(after))
	}
	for _, p := range after {
		if p.Name == "mkt-down" {
			t.Fatal("下架后市场行仍出现在组织清单")
		}
	}
}
