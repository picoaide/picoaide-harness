package capabilities

// 第五轮复审 B-N3（P3，2026-09-23）：市场分区的 `is_owner` 必须与技能/智能体
// 两侧**同源** —— 唯一归属判据是 serverstore 的具名判据
// （`Distribution.OwnedBy` → `AppOwnedByOwner`，语义权威见
// serverstore/distribution.go），而不是就地写的第二个表达式。
//
// 现场（修复前）：
//
//	技能侧 `s.Author == u.Username`（s 是市场适配层 DTO，`Author` 由
//	       `appToSkill` 映射自 `apps.owner`）；
//	智能体侧 `a.Owner == u.Username`（直接读 App 行）。
//
// 两条**当前恰好等价**（都落在 apps.owner 上），所以这里补的是**等价性**判据：
// 它钉住「is_owner 跟 apps.owner，不跟版本行的 author/publisher」这条语义。
// 一旦有人把归属来源换成版本行（`app_releases.publisher` —— 历史上正是这一对
// 判据的分叉点，R5-B-2 修的就是它），本文件两条用例立刻变红；而改走具名判据
// 之后，那段映射再怎么变都不再影响 `is_owner`。
//
// 变异对照（实跑见报告 §B-N3）：
//   - `appToSkill` 的 `Author` 改成 `r.Publisher`（漂移的**完整形态**：就地表达式
//     + 归属来源换到版本行）⇒ 本文件两条用例红；
//   - 只把 `appToSkill` 改成 `r.Publisher`、`is_owner` 仍走具名 `OwnedBy` ⇒ 绿
//     —— 证明修好之后 is_owner 不再依赖那段映射（这正是本 finding 要消灭的耦合）。

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// bn3MarketItem 取市场分区里指定 kind+name 的行（不存在返回 ok=false）。
type bn3MarketItem struct {
	Kind    string `json:"kind"`
	Name    string `json:"name"`
	Author  string `json:"author"`
	IsOwner bool   `json:"is_owner"`
}

func bn3MarketOwner(t *testing.T, r *gin.Engine, hdr map[string]string, kind, name string) (bn3MarketItem, bool) {
	t.Helper()
	w := doGet(t, r, "/api/client/v2/capabilities?source=market", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities(market) = %d %s", w.Code, w.Body.String())
	}
	var body struct {
		Items []bn3MarketItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	for _, it := range body.Items {
		if it.Kind == kind && it.Name == name {
			return it, true
		}
	}
	return bn3MarketItem{}, false
}

// bn3FlipOwnership 直接把 `apps.owner` 改成 newOwner，并把版本行的
// `app_releases.publisher` 改成 releasePublisher —— 两个字段**故意相反**，
// 于是"归属判据读的是哪一边"在行为上可判。
func TestMarketSkillIsOwnerFollowsAppsOwnerNotReleasePublisher(t *testing.T) {
	r, db, _, tokens := setupRouter(t)
	const name = "bn3-mkt-skill"

	if _, err := serverstore.AddSkill(db, &serverstore.Skill{
		Name: name, Version: "1.0.0", Author: "alice", Enabled: 1, Archive: []byte("pkg"),
	}); err != nil {
		t.Fatal(err)
	}
	// 市场分发面要求授权（归属人不豁免 —— 与读侧严格默认一致），两个账号都授权，
	// 这样"看得见"与"是不是归属人"两件事互不干扰。
	for _, who := range []string{"alice", "bob"} {
		if err := serverstore.GrantApp(db, serverstore.AppKindSkill, name, who, string(serverstore.GranteeUser)); err != nil {
			t.Fatal(err)
		}
	}

	// 正对照：owner=alice ⇒ alice 是归属人，bob 不是。
	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["alice"]}, "skill", name); !ok || !it.IsOwner {
		t.Fatalf("正对照失败：alice 应为归属人（ok=%v item=%+v）", ok, it)
	}
	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["bob"]}, "skill", name); !ok || it.IsOwner {
		t.Fatalf("正对照失败：bob 不应是归属人（ok=%v item=%+v）", ok, it)
	}

	// 漂移点：apps.owner → bob，而版本行 publisher → alice（两边故意相反）。
	// 归属判据必须跟 apps.owner：bob=true、alice=false。
	if _, err := db.Exec(`UPDATE apps SET owner = ? WHERE kind = ? AND app_id = ?`,
		"bob", serverstore.AppKindSkill, name); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_releases SET publisher = ? WHERE kind = ? AND app_id = ?`,
		"alice", serverstore.AppKindSkill, name); err != nil {
		t.Fatal(err)
	}

	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["bob"]}, "skill", name); !ok || !it.IsOwner {
		t.Fatalf("apps.owner=bob 后 bob 必须是归属人（ok=%v item=%+v）—— is_owner 不得跟 app_releases.publisher", ok, it)
	}
	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["alice"]}, "skill", name); !ok || it.IsOwner {
		t.Fatalf("apps.owner=bob 后 alice（仅版本行 publisher）不得是归属人（ok=%v item=%+v）", ok, it)
	}
}

func TestMarketAgentIsOwnerFollowsAppsOwnerNotReleasePublisher(t *testing.T) {
	r, db, _, tokens := setupRouter(t)
	const name = "bn3-mkt-agent"

	// 市场渠道智能体：owner=alice，版本行 publisher=alice。
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.UpsertAppAndCreateReleaseOn(tx, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: "B N3 市场智能体",
		Owner: "alice", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: "1.0.0", Title: "B N3 市场智能体",
		Author: "alice", Publisher: "alice", Status: string(serverstore.AgentPresetApproved),
		Archive: []byte("PK\x03\x04"),
	}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	for _, who := range []string{"alice", "bob"} {
		if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, who, string(serverstore.GranteeUser)); err != nil {
			t.Fatal(err)
		}
	}

	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["alice"]}, "agent", name); !ok || !it.IsOwner {
		t.Fatalf("正对照失败：alice 应为归属人（ok=%v item=%+v）", ok, it)
	}
	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["bob"]}, "agent", name); !ok || it.IsOwner {
		t.Fatalf("正对照失败：bob 不应是归属人（ok=%v item=%+v）", ok, it)
	}

	// 与技能侧同一条漂移：owner → bob，版本行 publisher → alice。
	if _, err := db.Exec(`UPDATE apps SET owner = ? WHERE kind = ? AND app_id = ?`,
		"bob", serverstore.AppKindAgent, name); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE app_releases SET publisher = ? WHERE kind = ? AND app_id = ?`,
		"alice", serverstore.AppKindAgent, name); err != nil {
		t.Fatal(err)
	}

	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["bob"]}, "agent", name); !ok || !it.IsOwner {
		t.Fatalf("apps.owner=bob 后 bob 必须是归属人（ok=%v item=%+v）", ok, it)
	}
	if it, ok := bn3MarketOwner(t, r, map[string]string{"Authorization": "Bearer " + tokens["alice"]}, "agent", name); !ok || it.IsOwner {
		t.Fatalf("apps.owner=bob 后 alice（仅版本行 publisher）不得是归属人（ok=%v item=%+v）", ok, it)
	}
}
