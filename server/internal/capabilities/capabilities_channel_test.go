package capabilities

import (
	"database/sql"
	"encoding/json"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// seedMarketAgent 播种一个市场渠道的已上架智能体，并授权给 alice。
func seedMarketAgent(t *testing.T, db *sql.DB, name string) {
	t.Helper()
	// 生产入口 UpsertAppAndCreateReleaseOn 需调用方事务(N-2:与发布锁同事务)。
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.UpsertAppAndCreateReleaseOn(tx, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: "市场智能体",
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: "1.0.0", Title: "市场智能体",
		Author: "boss", Publisher: "boss", Status: string(serverstore.AgentPresetApproved),
		Archive: []byte("PK\x03\x04"),
	}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, "alice", "user"); err != nil {
		t.Fatal(err)
	}
}

// N4（R7 复核 F2 §N4）：`internal/capabilities` 是 agentshare-2 的**同根因落点**。
// 第一轮把渠道闸门加在 agentshare 的每个端点上，而「组织·共享 Agent」分区与
// 审批队列直接吃 `serverstore.ListAgentPresets` / `ListVisibleAgentPresets`，
// 于是市场渠道的行以 `source=org` 出现在员工能力中心（市场下架后依然如此，
// 点安装才 404），管理端审批队列也把市场行渲染成 org 行（死按钮）。
//
// 对照技能侧：渠道过滤在 DAO 层（`orgSkillReleases`），所以技能从来不受影响。
// 本用例钉住的是**消费者口径**：市场行不得经 capabilities 的任何入口泄露。
func TestCapabilitiesOrgSectionExcludesMarketChannelAgent(t *testing.T) {
	r, db, adminHdr, userTokens := setupRouter(t)
	defer db.Close()
	alice := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}

	// 组织渠道智能体（approved + 授权给 alice）——必须照常出现。
	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{
		Name: "org-agent", DisplayName: "组织智能体", Version: "1.0.0",
		Author: "alice", Status: serverstore.AgentPresetApproved,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, "org-agent", "alice", "user"); err != nil {
		t.Fatal(err)
	}
	// 市场渠道智能体（approved + enabled + 同样授权给 alice）——必须被挡在门外。
	seedMarketAgent(t, db, "mkt-leak")

	itemsOf := func(path string) []string {
		w := doGet(t, r, path, alice)
		if w.Code != 200 {
			t.Fatalf("%s status=%d body=%s", path, w.Code, w.Body.String())
		}
		var out struct {
			Items []struct {
				Source string `json:"source"`
				Name   string `json:"name"`
			} `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, it := range out.Items {
			got = append(got, it.Source+":"+it.Name)
		}
		return got
	}

	// source=org（桌面客户端 auth-gate 显式请求的那条）必须只有组织渠道行。
	orgItems := itemsOf("/api/client/v2/capabilities?source=org&type=agent")
	joined := strings.Join(orgItems, ",")
	if strings.Contains(joined, "mkt-leak") {
		t.Fatalf("source=org 泄露市场智能体：%v", orgItems)
	}
	if !strings.Contains(joined, "org:org-agent") {
		t.Fatalf("source=org 丢失组织智能体（positive control）：%v", orgItems)
	}

	// 不限制 source 的合并视图允许市场行出现，但**来源徽章必须是 market**——
	// 被误标成 org 正是员工把市场内容看成「组织共享」的那一步。
	allItems := itemsOf("/api/client/v2/capabilities?type=agent")
	for _, item := range allItems {
		if strings.HasSuffix(item, ":mkt-leak") && item != "market:mkt-leak" {
			t.Fatalf("市场智能体被误标来源：%v", allItems)
		}
	}

	// 市场下架前后行为一致（下架不是挡板，渠道才是）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, "mkt-leak", false); err != nil {
		t.Fatal(err)
	}
	after := itemsOf("/api/client/v2/capabilities?source=org&type=agent")
	if strings.Contains(strings.Join(after, ","), "mkt-leak") {
		t.Fatalf("下架后仍泄露：%v", after)
	}

	// 审批队列（管理端）：市场行不得出现，组织行必须保留。
	w := doGet(t, r, "/api/server/admin/capabilities/approvals?status=all&type=agent", adminHdr)
	if w.Code != 200 {
		t.Fatalf("approvals status=%d body=%s", w.Code, w.Body.String())
	}
	body := w.Body.String()
	if strings.Contains(body, "mkt-leak") {
		t.Fatalf("审批队列泄露市场智能体：%s", body)
	}
	if !strings.Contains(body, "org-agent") {
		t.Fatalf("审批队列丢失组织智能体（positive control）：%s", body)
	}
}

// 审计 2026-09-15 S11-2（agent 半边，与技能面同根因）：组织智能体的下架对
// **管理员**同样要生效。客户端安装通路的归档端点恒以 admin=false 构造（与调用者
// 是否管理员无关），而聚合面的 admin 分支此前只按审核状态过滤，于是管理员在
// 客户端看到可点但下载必 404 的行；agentshare.listVisible 早已按 enabled 过滤
// （P2-1，审计 2026-09-13），聚合面漏了。
func TestAgentDisabledHiddenFromAdminCapabilitiesOrgSection(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	bossHdr := adminBearer(t, db)
	alice := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}

	if _, err := serverstore.CreateAgentPreset(db, &serverstore.AgentPreset{
		Name: "org-agent", DisplayName: "组织智能体", Version: "1.0.0",
		Author: "alice", Status: serverstore.AgentPresetApproved,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, "org-agent", "alice", "user"); err != nil {
		t.Fatal(err)
	}

	orgAgentNames := func(hdr map[string]string) []string {
		w := doGet(t, r, "/api/client/v2/capabilities?source=org&type=agent", hdr)
		if w.Code != 200 {
			t.Fatalf("capabilities source=org status=%d body=%s", w.Code, w.Body.String())
		}
		var out struct {
			Items []struct {
				Name string `json:"name"`
			} `json:"items"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		got := []string{}
		for _, it := range out.Items {
			got = append(got, it.Name)
		}
		return got
	}
	callers := map[string]map[string]string{"管理员": bossHdr, "员工": alice}

	// 正对照：上架时两种角色都能看到（夹具本身可见）。
	for who, hdr := range callers {
		if !containsStr(orgAgentNames(hdr), "org-agent") {
			t.Fatalf("上架时%s在能力中心组织分区看不到组织智能体（正对照失败）", who)
		}
	}

	if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, "org-agent", false); err != nil {
		t.Fatal(err)
	}

	for who, hdr := range callers {
		if containsStr(orgAgentNames(hdr), "org-agent") {
			t.Fatalf("下架后%s仍能在能力中心组织分区看到组织智能体", who)
		}
	}
}
