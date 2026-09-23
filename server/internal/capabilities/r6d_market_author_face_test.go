package capabilities

// R6-D P2-2（审计 2026-09-23，P2）：市场渠道的**作者面**。
//
// 修前形态：第五轮 R5-B-1 定案的「下架 = 作者面仍可见 + `delisted=true`」只实现在
// **org** 渠道 ——「我的」分区取的是 `ListOwnedSharedSkills` / `ListOwnedAgentPresets`
// （两者的 SQL 都只认 `channel='org'`），而市场渠道的两条读侧都按下架过滤
// （`capabilities.go` 的市场智能体分支 `a.Enabled != 1`、市场技能走
// `ListSkills(enabledOnly=true)`）⇒ **上架时**市场行就不进「我的」，**下架后**员工面
// market/org/own/合并四个视图同时为空：归属人对市场行既看不到状态、也发不出新版
// （409 APP_DELISTED），管控动作在作者面没有任何反馈闭环。
//
// 可达性不是假设：`PUT /apps/:kind/:app_id/owner`（`router.go` → `appstore/admin.go`）
// **不限渠道**，管理员可以把一个市场行转给普通员工 —— 那一刻起他/她就是归属人，
// 却在自己的能力中心里看不到这一行（`is_owner` 也只在分发面的行上出现）。
//
// 定案语义（与 org 渠道同构，语义权威 `serverstore/distribution.go`）：
//   · 「我的」= 归属人自己的行（任意状态 + 下架标记），**渠道无关** —— 市场行与
//     org 行一视同仁；
//   · 分发面（market/org 分区）口径**完全不变**：下架行不列、别人的行不列
//     （本文件最后一条用例把"不扩大可见面"钉死）。
//
// 变异验证（任一改动都必须让本文件红）：
//   · 删掉 2b/3b 分支里的市场取数块 ⇒ ①②③ 全红（这就是 R6-D 的原形态）；
//   · 把 `dist.OwnedBy(u.Username)` 换成 `u.IsAdmin || ...` ⇒ ④ 红（非归属人看得到）；
//   · 把作者面的 `dist.Delisted()` 传成常量 false ⇒ ①③ 红（下架成不了状态）。

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
)

// r6dItem 是能力中心条目的投影（比共享夹具多带 is_owner/delisted/source）。
type r6dItem struct {
	Kind     string `json:"kind"`
	Name     string `json:"name"`
	Source   string `json:"source"`
	IsOwner  bool   `json:"is_owner"`
	Delisted bool   `json:"delisted"`
}

// r6dRows 取某来源分区里指定名字的行（可能 0 行；同一次响应里同名多行都返回）。
func r6dRows(t *testing.T, r *gin.Engine, hdr map[string]string, source, name string) []r6dItem {
	t.Helper()
	w := doGet(t, r, "/api/client/v2/capabilities?source="+source, hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("capabilities(source=%s) = %d %s", source, w.Code, w.Body.String())
	}
	var body struct {
		Items []r6dItem `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	out := []r6dItem{}
	for _, it := range body.Items {
		if it.Name == name {
			out = append(out, it)
		}
	}
	return out
}

// seedR6DMarketSkill 播种一个市场渠道技能（apps 行 + approved 版本），归属 = owner，
// 并授权给 viewer。生产可达路径：管理员上传市场技能 + PUT …/owner 转移归属。
func seedR6DMarketSkill(t *testing.T, db *sql.DB, name, owner, viewer string) {
	t.Helper()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: name, Title: "市场技能",
		Owner: owner, Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateRelease(db, &serverstore.Release{
		Kind: serverstore.AppKindSkill, AppID: name, Version: "1.0.0", Title: "市场技能",
		Author: owner, Publisher: owner, Status: serverstore.ReleaseStatusApproved,
		Archive: []byte("PK\x03\x04"),
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindSkill, name, viewer, "user"); err != nil {
		t.Fatal(err)
	}
}

// seedR6DMarketAgent 同上，播种市场渠道智能体（走 UpsertAppAndCreateRelease 的事务路径）。
func seedR6DMarketAgent(t *testing.T, db *sql.DB, name, owner, viewer string) {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.UpsertAppAndCreateReleaseOn(tx, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: "市场智能体",
		Owner: owner, Channel: serverstore.AppChannelMarket, Enabled: 1,
	}, &serverstore.Release{
		Kind: serverstore.AppKindAgent, AppID: name, Version: "1.0.0", Title: "市场智能体",
		Author: owner, Publisher: owner, Status: string(serverstore.AgentPresetApproved),
		Archive: []byte("PK\x03\x04"),
	}); err != nil {
		_ = tx.Rollback()
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, viewer, "user"); err != nil {
		t.Fatal(err)
	}
}

func TestMarketDelistedRowsReachTheirOwner(t *testing.T) {
	r, db, _, userTokens := setupRouter(t)
	defer db.Close()
	alice := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	bob := map[string]string{"Authorization": "Bearer " + userTokens["bob"]}

	seedR6DMarketSkill(t, db, "r6d-mkt-skill", "alice", "alice")
	seedR6DMarketAgent(t, db, "r6d-mkt-agent", "alice", "alice")

	// ② 上架时：归属人在「我的」里看得到自己拥有的**市场行**（is_owner=true、
	//    未下架），且不需要任何授权关系（作者面不看 grants）。
	for _, tc := range []struct{ source, name string }{
		{"own", "r6d-mkt-skill"},
		{"own", "r6d-mkt-agent"},
	} {
		rows := r6dRows(t, r, alice, tc.source, tc.name)
		if len(rows) != 1 {
			t.Fatalf("上架时归属人的「我的」应含市场行 %s：实得 %d 行 %+v", tc.name, len(rows), rows)
		}
		if !rows[0].IsOwner || rows[0].Delisted {
			t.Fatalf("%s 的作者行应 is_owner=true / delisted=false：%+v", tc.name, rows[0])
		}
		if rows[0].Source != string(SourceMarket) {
			t.Fatalf("%s 的来源必须是 market（作者面不改变来源归属）：%+v", tc.name, rows[0])
		}
	}

	// 管理员下架（生产端点：市场渠道上下架）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, "r6d-mkt-skill", false); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, "r6d-mkt-agent", false); err != nil {
		t.Fatal(err)
	}

	// ① 关键断言：下架后**归属人仍看得到**自己的市场行，并带权威 delisted=true
	//    —— 与 org 渠道（R5-B-1 的用例）同构。
	for _, tc := range []struct{ source, name string }{
		{"own", "r6d-mkt-skill"},
		{"own", "r6d-mkt-agent"},
	} {
		rows := r6dRows(t, r, alice, tc.source, tc.name)
		if len(rows) != 1 {
			t.Fatalf("R6-D：下架的市场行必须仍出现在归属人的「我的」里（%s）：实得 %d 行 %+v",
				tc.name, len(rows), rows)
		}
		if !rows[0].Delisted {
			t.Fatalf("下架的作者行必须带 delisted=true（管控动作要在作者面有反馈）：%+v", rows[0])
		}
		if !rows[0].IsOwner {
			t.Fatalf("作者行必须 is_owner=true：%+v", rows[0])
		}
	}

	// ③ 非归属人（哪怕有授权）看不到下架行，也看不到上架行之外的任何东西：
	//    分发面口径不变 —— 下架 = 不可分发。
	for _, tc := range []struct{ source, name string }{
		{"market", "r6d-mkt-skill"},
		{"market", "r6d-mkt-agent"},
		{"own", "r6d-mkt-skill"},
		{"own", "r6d-mkt-agent"},
	} {
		if rows := r6dRows(t, r, bob, tc.source, tc.name); len(rows) != 0 {
			t.Fatalf("非归属人不得看到下架的市场行（source=%s name=%s）：%+v", tc.source, tc.name, rows)
		}
	}
}

// TestMarketOwnerFaceDoesNotWidenOthersVisibility：④ 归属转移前/后都不给非归属人扩面。
//
// 具体钉两件事：
//   - 「我的」的成员判据是 **apps.owner**（与发布权同源，R5-B-2），不是"我上传过"
//     —— 归属转给 bob 之后 alice 立刻看不到、bob 立刻看得到（分发面两侧都不变）；
//   - 下架期间**没有任何非归属人**能看到这一行（管理员在员工面也不扩面：管理端有
//     独立的审批/市场面）。
func TestMarketOwnerFaceDoesNotWidenOthersVisibility(t *testing.T) {
	r, db, adminHdr, userTokens := setupRouter(t)
	defer db.Close()
	alice := map[string]string{"Authorization": "Bearer " + userTokens["alice"]}
	bob := map[string]string{"Authorization": "Bearer " + userTokens["bob"]}
	// 员工面走 Bearer（`/api/client/v2/capabilities`），所以管理员也要一把令牌才能
	// 从**员工面**看 —— 共享夹具只给了 boss 的会话（管理端登录），这里补签发一把。
	bossUser, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	bossTok, err := serverauth.IssueToken(db, bossUser.ID)
	if err != nil {
		t.Fatal(err)
	}
	boss := map[string]string{"Authorization": "Bearer " + bossTok}

	seedR6DMarketAgent(t, db, "r6d-transfer", "alice", "bob")
	// 下架（归属不变）。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindAgent, "r6d-transfer", false); err != nil {
		t.Fatal(err)
	}

	// alice 仍是归属人 ⇒ 只有她看得到。
	if rows := r6dRows(t, r, alice, "own", "r6d-transfer"); len(rows) != 1 || !rows[0].Delisted {
		t.Fatalf("归属人应看到自己名下的下架行：%+v", rows)
	}
	if rows := r6dRows(t, r, bob, "own", "r6d-transfer"); len(rows) != 0 {
		t.Fatalf("被授权但非归属人的员工不得出现在「我的」：%+v", rows)
	}
	// 管理员（boss）同样不因管理员身份在**员工面**看到别人的下架行。
	if rows := r6dRows(t, r, boss, "own", "r6d-transfer"); len(rows) != 0 {
		t.Fatalf("员工面不为管理员扩面（管理端有独立的市场/审批面）：%+v", rows)
	}

	// 归属转移：生产入口是 `PUT /api/server/admin/apps/:kind/:app_id/owner`
	// （internal/router → appstore/admin.go 的 transferOwner），它的**写路径**就是
	// `serverstore.SetAppOfficial(db, kind, appID, false, owner)` —— 本包的路由树里没挂
	// appstore 的管理端点（`setupRouter` 只注册 serverauth/marketplace/capabilities），
	// 所以这里直接调同一个写路径（不另造一份"改 owner"的 SQL）。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindAgent, "r6d-transfer", false, "bob"); err != nil {
		t.Fatal(err)
	}
	_ = adminHdr
	if rows := r6dRows(t, r, alice, "own", "r6d-transfer"); len(rows) != 0 {
		t.Fatalf("归属转移后旧归属人不得再出现在「我的」（与发布权同源）：%+v", rows)
	}
	if rows := r6dRows(t, r, bob, "own", "r6d-transfer"); len(rows) != 1 || !rows[0].Delisted || !rows[0].IsOwner {
		t.Fatalf("归属转移后新归属人应立刻看到该行（带 delisted/is_owner）：%+v", rows)
	}
}
