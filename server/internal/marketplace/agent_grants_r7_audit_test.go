package marketplace

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/skillmanifest"
)

// ---------------------------------------------------------------------------
// R7 审计回归(marketplace-1/2/3/5/6/7/8/9)
// ---------------------------------------------------------------------------

// grantSet 直接读 app_grants,返回 "type:grantee" 集合(顺序无关)。
func grantSet(t *testing.T, db *sql.DB, kind, appID string) map[string]bool {
	t.Helper()
	grants, err := serverstore.ListAppGrants(db, kind, appID)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, g := range grants {
		out[string(g.GranteeType)+":"+g.Grantee] = true
	}
	return out
}

func sameGrantSet(a, b map[string]bool) bool {
	if len(a) != len(b) {
		return false
	}
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

func seedAgentWithGrants(t *testing.T, db *sql.DB, name string) {
	t.Helper()
	if _, err := serverstore.GetOrCreateGroup(db, "研发部"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.GetOrCreateGroup(db, "人事部"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: name, Title: name,
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, "研发部", "group"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantApp(db, serverstore.AppKindAgent, name, "carol", "user"); err != nil {
		t.Fatal(err)
	}
}

// marketplace-1:整组替换只能替换「组」这一维,用户级授权必须保留
// (webadmin 弹窗明确写着「用户授权不受影响」)。
func TestReplaceAgentGrantsKeepsUserGrants(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	seedAgentWithGrants(t, db, "bot-a")

	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-a/grants", `{"groups":["人事部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("replace grants = %d %s", w.Code, w.Body.String())
	}
	want := map[string]bool{"group:人事部": true, "user:carol": true}
	if got := grantSet(t, db, serverstore.AppKindAgent, "bot-a"); !sameGrantSet(got, want) {
		t.Fatalf("grants after replace = %v, want %v(用户级授权被误删)", got, want)
	}
	// 对照:技能侧同语义。
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "skill-a", Title: "skill-a",
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.GrantSkill(db, "skill-a", "carol", serverstore.GranteeUser); err != nil {
		t.Fatal(err)
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/skills/skill-a/grants", `{"groups":["人事部"]}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("skill replace = %d", w.Code)
	}
	if got := grantSet(t, db, serverstore.AppKindSkill, "skill-a"); !sameGrantSet(got, map[string]bool{"group:人事部": true, "user:carol": true}) {
		t.Fatalf("skill control grants = %v", got)
	}
}

// marketplace-1(同源):未知字段必须 400,而不是「静默清空」。
func TestReplaceAgentGrantsRejectsUnknownFields(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	seedAgentWithGrants(t, db, "bot-b")

	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-b/grants", `{"departments":["人事部"]}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("unknown field = %d %s, want 400", w.Code, w.Body.String())
	}
	if got := grantSet(t, db, serverstore.AppKindAgent, "bot-b"); !sameGrantSet(got, map[string]bool{"group:研发部": true, "user:carol": true}) {
		t.Fatalf("grants mutated by an unknown-field request: %v", got)
	}
}

// marketplace-2:GET grants 必须与技能侧同形状(单层 {"grants":[...]}),
// 多包一层会让 webadmin 授权弹窗读不动并在保存时清空全部授权。
func TestAgentGrantsResponseMatchesSkillShape(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	seedAgentWithGrants(t, db, "bot-c")

	_, agentOut := mreq(t, r, "GET", "/api/server/admin/agents/bot-c/grants", "", hdr)
	agentGrants, ok := agentOut["grants"].([]any)
	if !ok {
		t.Fatalf("agent grants = %#v, want a flat array like the skill side", agentOut["grants"])
	}
	if len(agentGrants) != 2 {
		t.Fatalf("agent grants = %v, want 2 rows", agentGrants)
	}
	_, skillOut := mreq(t, r, "GET", "/api/server/admin/skills/skill-c/grants", "", hdr)
	if _, ok := skillOut["grants"].([]any); !ok && skillOut["grants"] != nil {
		t.Fatalf("skill grants shape changed: %#v", skillOut["grants"])
	}
}

// marketplace-3:上传归档不得把 App 级描述清空(技能侧保留包内描述)。
func TestAgentUploadKeepsDescription(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"desc-agent","description":"管理员填写的智能体描述"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("create failed")
	}
	archive := agentArchive(t, "1.0.0", "描述测试智能体")
	body := `{"version":"1.0.0","archive":"` + base64.StdEncoding.EncodeToString(archive) + `"}`
	if w, out := mreq(t, r, "POST", "/api/server/admin/agents/desc-agent/archive", body, hdr); w.Code != http.StatusOK {
		t.Fatalf("upload: %d %v", w.Code, out)
	}
	a, err := serverstore.GetApp(db, serverstore.AppKindAgent, "desc-agent")
	if err != nil {
		t.Fatal(err)
	}
	// marketplace-3:上传归档**不得把 App 级描述清成空串** —— 原缺陷是处理器的
	// 第二次 UpsertApp 带着零值 Description 覆写,把描述清成 ""。
	//
	// 正确口径与**技能侧一致**:App 级描述取自**包内**(appstore.Publish 按
	// req.Manifest.Description 写),所以这里断言它等于包内描述,而不是管理员
	// 登记时随手填的那句。断言"非空"是最低要求,断言"等于包内"才能区分
	// 「被清空」与「被正确覆盖」两种形态。
	// R7 audit 2026-09-13 P2-6 进一步收紧:回写只走 SetAppTitle —— 包内 author
	// 是不可信输入,不能用来覆盖 owner(官方 App 的空归属=蓝标语义)。
	const pkgDescription = "一个用于演示市场智能体管理的测试智能体"
	if a.Description != pkgDescription {
		t.Fatalf("App description = %q, want 包内描述 %q(上传不得清空/改写为其它值)", a.Description, pkgDescription)
	}
	if a.Title != "描述测试智能体" {
		t.Fatalf("App title = %q, want the package title", a.Title)
	}
}

// marketplace-5:授权主体必须存在;'@部门' 前缀必须与技能侧同口径剥掉。
func TestAgentGrantValidatesSubjectAndStripsAtPrefix(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if _, err := serverstore.GetOrCreateGroup(db, "研发部"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: "bot-d", Title: "bot-d",
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}

	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-d/grant", `{"username":"ghost-user"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("ghost user = %d, want 400", w.Code)
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-d/grant", `{"group":"ghost-dept"}`, hdr); w.Code != http.StatusBadRequest {
		t.Fatalf("ghost group = %d, want 400", w.Code)
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-d/grant", `{"group":"@研发部"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("@group = %d, want 200", w.Code)
	}
	got := grantSet(t, db, serverstore.AppKindAgent, "bot-d")
	if !sameGrantSet(got, map[string]bool{"group:研发部": true}) {
		t.Fatalf("grants = %v, want the '@' prefix stripped like the skill side", got)
	}
}

// marketplace-6:整组替换必须原子 —— 中途失败不得留半套授权。
func TestReplaceAgentGrantsIsAtomic(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	seedAgentWithGrants(t, db, "bot-e")
	before := grantSet(t, db, serverstore.AppKindAgent, "bot-e")

	// NUL 字节组名:PG 必然拒绝(NUL 不是合法 text),用于制造「写完第一组后失败」。
	body, _ := json.Marshal(map[string]any{"groups": []string{"人事部", "\u0000bad"}})
	w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-e/grants", string(body), hdr)
	if w.Code < 400 {
		t.Fatalf("failing replace = %d, want an error", w.Code)
	}
	after := grantSet(t, db, serverstore.AppKindAgent, "bot-e")
	if !sameGrantSet(before, after) {
		t.Fatalf("grants after failed replace = %v, want unchanged %v(半套授权残留)", after, before)
	}
}

// marketplace-7:撤销必须记 revoke(技能侧 skill_grant/skill_revoke 成对)。
func TestAgentRevokeIsAuditedAsRevoke(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	// 单条授权现在校验主体存在性(marketplace-5),先建出被授权用户。
	if _, err := serverstore.CreateUserWithPassword(db, "carol", "carolpw"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: "bot-f", Title: "bot-f",
		Owner: "boss", Channel: serverstore.AppChannelMarket, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if w, _ := mreq(t, r, "PUT", "/api/server/admin/agents/bot-f/grant", `{"username":"carol"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("grant failed")
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/bot-f/grant", `{"username":"carol"}`, hdr); w.Code != http.StatusOK {
		t.Fatal("revoke failed")
	}
	logs, _, err := serverstore.ListAuditLogsPagedFiltered(db, 0, 50, "", "")
	if err != nil {
		t.Fatal(err)
	}
	var grants, revokes int
	for _, l := range logs {
		switch l.Action {
		case "agent_grant":
			grants++
		case "agent_revoke":
			revokes++
		}
	}
	if grants != 1 || revokes != 1 {
		t.Fatalf("audit agent_grant=%d agent_revoke=%d, want 1/1(撤销被记成授权)", grants, revokes)
	}
}

// marketplace-8:市场技能端点不得改动组织渠道行(智能体侧对照 404)。
func TestMarketSkillEndpointsRejectOrgChannelRows(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()
	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "org-only", Title: "org-only",
		Owner: "boss", Channel: serverstore.AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/skills/org-only", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("DELETE org skill via market endpoint = %d, want 404", w.Code)
	}
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills/org-only/enable", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("enable org skill via market endpoint = %d, want 404", w.Code)
	}
	a, err := serverstore.GetApp(db, serverstore.AppKindSkill, "org-only")
	if err != nil || a.Enabled != 1 || a.Channel != serverstore.AppChannelOrg {
		t.Fatalf("org skill damaged: %+v err=%v", a, err)
	}
	// 对照:智能体侧对 org 行本来就 404。
	if w, _ := mreq(t, r, "DELETE", "/api/server/admin/agents/org-only", "", hdr); w.Code != http.StatusNotFound {
		t.Fatalf("agent control = %d, want 404", w.Code)
	}
}

// marketplace-9:登记端点必须与上传用同一套名字口径,不能接受「永远无法
// 上传内容」的名字(My_Skill / 中文名),否则会留下 releases=0 的空壳 App。
func TestCreateEndpointsRejectUnusableNames(t *testing.T) {
	r, db, hdr := marketAdminSetup(t)
	defer db.Close()

	for _, name := range []string{"My_Skill", "我的技能", "bad--name", "-lead"} {
		if w, _ := mreq(t, r, "POST", "/api/server/admin/skills", `{"name":"`+name+`"}`, hdr); w.Code != http.StatusBadRequest {
			t.Errorf("create skill %q = %d, want 400", name, w.Code)
		}
	}
	for _, name := range []string{"My_Agent", "我的智能体"} {
		if w, _ := mreq(t, r, "POST", "/api/server/admin/agents", `{"name":"`+name+`"}`, hdr); w.Code != http.StatusBadRequest {
			t.Errorf("create agent %q = %d, want 400", name, w.Code)
		}
	}
	if _, err := serverstore.GetApp(db, serverstore.AppKindSkill, "My_Skill"); err == nil {
		t.Fatal("unusable skill name was registered")
	}
	// 合法 kebab-case 仍然可以登记与上传。
	if w, _ := mreq(t, r, "POST", "/api/server/admin/skills", `{"name":"good-name"}`, hdr); w.Code != http.StatusOK {
		t.Fatalf("valid name rejected: %d", w.Code)
	}
}

// 控制组:上传路径与登记路径使用同一个 skillmanifest.IsAppID 口径。
func TestCreateNameRuleMatchesUploadRule(t *testing.T) {
	if !skillmanifest.IsAppID("good-name") || skillmanifest.IsAppID("My_Skill") {
		t.Fatal("skillmanifest.IsAppID contract changed; update the create-endpoint gate")
	}
}
