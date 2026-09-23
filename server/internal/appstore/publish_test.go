package appstore

import (
	"errors"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func req(appID, version, checksum, publisher string) PublishRequest {
	return PublishRequest{
		Kind: serverstore.AppKindSkill, AppID: appID, Channel: serverstore.AppChannelOrg,
		Archive: []byte("zip-" + version), Publisher: publisher, Checksum: checksum,
		PendingCap: 10,
		// 非首个版本必须带 changelog(决策 §5.2),夹具统一带上;
		// 「缺 changelog 被拒」由专门的用例覆盖。
		Manifest: Manifest{Version: version, Title: appID + " 技能",
			Description: "足够长的技能描述用于测试。", Author: publisher, Category: "测试",
			Changelog: "测试用更新说明。"},
	}
}

// agentReq 与 req 同构,仅 kind=agent(智能体与技能共用同一发布内核,
// 本夹具用于验证「同样策略」的显式回归)。
func agentReq(appID, version, checksum, publisher string) PublishRequest {
	r := req(appID, version, checksum, publisher)
	r.Kind = serverstore.AppKindAgent
	r.Manifest.Title = appID + " 智能体"
	return r
}

func code(t *testing.T, err error) string {
	t.Helper()
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("want *appstore.Error, got %v", err)
	}
	return e.Code
}

func TestPublishVersionSemantics(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, req("demo", "1.0.0", "c1", "alice")); err != nil {
		t.Fatalf("首次发布: %v", err)
	}
	// 同版本号不可复用。
	if _, err := Publish(db, req("demo", "1.0.0", "c2", "alice")); code(t, err) != CodeVersionExists {
		t.Fatalf("同版本 = %v", err)
	}
	// 内容未变更(同 checksum + 同发布者)。
	if _, err := Publish(db, req("demo", "2.0.0", "c1", "alice")); code(t, err) != CodeContentUnchanged {
		t.Fatalf("同内容 = %v", err)
	}
	// 版本倒挂。
	if _, err := Publish(db, req("demo", "0.9.0", "c3", "alice")); code(t, err) != CodeVersionNotIncreasing {
		t.Fatalf("倒挂 = %v", err)
	}
	// 正常升版本。
	if r, err := Publish(db, req("demo", "1.1.0", "c3", "alice")); err != nil || r.Version != "1.1.0" {
		t.Fatalf("升版本 = %+v %v", r, err)
	}
	// 被拒版本同样永久占位。
	if err := serverstore.SetReleaseStatus(db, serverstore.AppKindSkill, "demo", "1.1.0",
		serverstore.ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("demo", "1.1.0", "c4", "alice")); code(t, err) != CodeVersionExists {
		t.Fatalf("被拒版本重用 = %v", err)
	}
	// 软删版本也占位。
	if err := serverstore.SoftDeleteRelease(db, serverstore.AppKindSkill, "demo", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("demo", "1.0.0", "c5", "alice")); code(t, err) != CodeVersionExists {
		t.Fatalf("软删版本重用 = %v", err)
	}
}

func TestPublishLockAndOwnership(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 预锁定尚不存在的名字:员工不可发布,管理员可以。
	if err := serverstore.LockCapability(db, serverstore.AppKindSkill, "official-app", "官方维护", "admin"); err != nil {
		t.Fatal(err)
	}
	_, err := Publish(db, req("official-app", "1.0.0", "c1", "alice"))
	if code(t, err) != CodeAppLocked {
		t.Fatalf("锁定 = %v", err)
	}
	var e *Error
	errors.As(err, &e)
	if e.Message == "" || !contains(e.Message, "官方维护") {
		t.Fatalf("必须回显管理员理由: %q", e.Message)
	}
	adminReq := req("official-app", "1.0.0", "c1", "admin")
	adminReq.AdminPublish = true
	adminReq.Channel = serverstore.AppChannelMarket
	r, err := Publish(db, adminReq)
	if err != nil || r.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("管理员发布 = %+v %v(应直接 approved)", r, err)
	}

	// 跨渠道同名互斥。
	orgReq := req("official-app", "2.0.0", "c9", "admin")
	orgReq.AdminPublish = true
	if _, err := Publish(db, orgReq); code(t, err) != CodeNameTaken {
		t.Fatalf("跨渠道同名 = %v", err)
	}

	// 归属保护:他人的组织 App,别人不能接管发布。
	if _, err := Publish(db, req("alice-app", "1.0.0", "a1", "alice")); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("alice-app", "2.0.0", "b1", "bob")); code(t, err) != CodeNameTaken {
		t.Fatalf("跨作者接管 = %v", err)
	}
	// 明确告知占用(2026-09-02 用户拍板:409 冲突语义,不返回 404);
	// 文案只说明「已被占用」,不暴露被占名者是谁。
	_, err = Publish(db, req("alice-app", "2.0.0", "b1", "bob"))
	errors.As(err, &e)
	if e.Message != "名称已被占用，无法上传：请更换名称或联系管理员" {
		t.Fatalf("拒绝文案 = %q", e.Message)
	}
}

// 空 owner 的历史行(0054 回填边缘)必须同样受归属保护:员工不能发布,
// 管理员可以(并成为 owner)——防止员工「接管」成新归属人。
func TestPublishEmptyOwnerBlocked(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindSkill, AppID: "legacy-orphan", Title: "历史技能",
		Description: "旧数据回填行", Owner: "", Channel: serverstore.AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("legacy-orphan", "1.0.0", "o1", "alice")); code(t, err) != CodeNameTaken {
		t.Fatalf("空 owner 未被拦截 = %v", err)
	}
	adminReq := req("legacy-orphan", "1.0.0", "o1", "admin")
	adminReq.AdminPublish = true
	if _, err := Publish(db, adminReq); err != nil {
		t.Fatalf("管理员发布空 owner 行: %v", err)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "legacy-orphan")
	if err != nil || app.Owner != "admin" {
		t.Fatalf("owner = %q err=%v, want admin", app.Owner, err)
	}
}

// 被拒后归属仍保留(占名与版本号永久占位同一精神):他人任何状态都不能
// 上传同名,本人可升版本重提。
func TestPublishOwnershipPersistsAfterReject(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, req("persist", "1.0.0", "p1", "alice")); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetReleaseStatus(db, serverstore.AppKindSkill, "persist", "1.0.0",
		serverstore.ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("persist", "2.0.0", "p2", "bob")); code(t, err) != CodeNameTaken {
		t.Fatalf("他人接管被拒行的名字 = %v", err)
	}
	if _, err := Publish(db, req("persist", "1.1.0", "p3", "alice")); err != nil {
		t.Fatalf("本人升版重提: %v", err)
	}
}

// 归属转移(管理员指定):转移后新归属者获得续传权,旧归属者 404;
// 相同归属幂等成功。
func TestPublishAfterOwnerTransfer(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if _, err := Publish(db, req("transfer-me", "1.0.0", "t1", "alice")); err != nil {
		t.Fatal(err)
	}
	// 生产归属转移端点(appstore/admin.go)只调 SetAppOfficial(非官方 + 新归属)。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "transfer-me", false, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, req("transfer-me", "2.0.0", "t2", "bob")); err != nil {
		t.Fatalf("新归属者续传: %v", err)
	}
	if _, err := Publish(db, req("transfer-me", "3.0.0", "t3", "alice")); code(t, err) != CodeNameTaken {
		t.Fatalf("旧归属者续传 = %v", err)
	}
	// 幂等:再次转移为同一归属不报错。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "transfer-me", false, "bob"); err != nil {
		t.Fatal(err)
	}
}

// 智能体与技能执行同一套归属/锁定/版本策略(2026-09-02 用户要求):
// 每条规则各断言一次,防止未来某条路径再次分叉。
func TestPublishAgentSamePolicyAsSkill(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// 1) 首次发布 → pending 即占名并注册 owner。
	if _, err := Publish(db, agentReq("agent-own", "1.0.0", "g1", "alice")); err != nil {
		t.Fatalf("agent 首次发布: %v", err)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindAgent, "agent-own")
	if err != nil || app.Owner != "alice" {
		t.Fatalf("agent owner = %q err=%v, want alice", app.Owner, err)
	}

	// 2) 他人同名(任意版本)→ 409 NAME_TAKEN + 明确文案(与技能同码)。
	_, err = Publish(db, agentReq("agent-own", "2.0.0", "g2", "bob"))
	if code(t, err) != CodeNameTaken {
		t.Fatalf("agent 跨作者接管 = %v", err)
	}
	var e *Error
	errors.As(err, &e)
	if e.Message != "名称已被占用，无法上传：请更换名称或联系管理员" {
		t.Fatalf("agent 拒绝文案 = %q", e.Message)
	}

	// 3) 版本语义:同名同版本不可复用、版本只能递增。
	if _, err := Publish(db, agentReq("agent-own", "1.0.0", "g3", "alice")); code(t, err) != CodeVersionExists {
		t.Fatalf("agent 同版本 = %v", err)
	}
	if _, err := Publish(db, agentReq("agent-own", "0.9.0", "g4", "alice")); code(t, err) != CodeVersionNotIncreasing {
		t.Fatalf("agent 版本倒挂 = %v", err)
	}
	// 4) 本人升版本续传 → 成功。
	if _, err := Publish(db, agentReq("agent-own", "1.1.0", "g5", "alice")); err != nil {
		t.Fatalf("agent 本人升版: %v", err)
	}

	// 5) 管理员改归属后:新归属者可续传、旧归属者 409、管理员可发布被锁名。
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindAgent, "agent-own", false, "bob"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, agentReq("agent-own", "1.2.0", "g6", "bob")); err != nil {
		t.Fatalf("agent 新归属者续传: %v", err)
	}
	if _, err := Publish(db, agentReq("agent-own", "1.3.0", "g7", "alice")); code(t, err) != CodeNameTaken {
		t.Fatalf("agent 旧归属者 = %v", err)
	}
	// 6) 锁定(占名)对智能体同样生效。
	if err := serverstore.LockCapability(db, serverstore.AppKindAgent, "agent-official", "官方维护", "admin"); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, agentReq("agent-official", "1.0.0", "g8", "alice")); code(t, err) != CodeAppLocked {
		t.Fatalf("agent 锁定 = %v", err)
	}
	adminReq := agentReq("agent-official", "1.0.0", "g8", "admin")
	adminReq.AdminPublish = true
	if r, err := Publish(db, adminReq); err != nil || r.Status != serverstore.ReleaseStatusApproved {
		t.Fatalf("agent 管理员发布锁定名 = %+v %v", r, err)
	}
}

// 空 owner 历史行:智能体同样禁止员工接管(2026-09-02 收紧)。
func TestPublishAgentEmptyOwnerBlocked(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	if err := serverstore.UpsertApp(db, &serverstore.App{
		Kind: serverstore.AppKindAgent, AppID: "agent-legacy", Title: "历史智能体",
		Description: "旧数据回填行", Owner: "", Channel: serverstore.AppChannelOrg, Enabled: 1,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := Publish(db, agentReq("agent-legacy", "1.0.0", "h1", "alice")); code(t, err) != CodeNameTaken {
		t.Fatalf("agent 空 owner 未被拦截 = %v", err)
	}
}

// 非首个版本缺 changelog 必须被拒(首版不要求)。
func TestPublishRequiresChangelogAfterFirstVersion(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	first := req("cl", "1.0.0", "c1", "alice")
	first.Manifest.Changelog = ""
	if _, err := Publish(db, first); err != nil {
		t.Fatalf("首版不应要求 changelog: %v", err)
	}
	second := req("cl", "1.1.0", "c2", "alice")
	second.Manifest.Changelog = ""
	if _, err := Publish(db, second); code(t, err) != "MISSING_FIELD" {
		t.Fatalf("非首版缺 changelog = %v, want MISSING_FIELD", err)
	}
	if _, err := Publish(db, req("cl", "1.1.0", "c2", "alice")); err != nil {
		t.Fatalf("带 changelog 应通过: %v", err)
	}
}

func TestPublishPendingCap(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	for i, v := range []string{"1.0.0", "1.1.0"} {
		r := req("capped", v, "c"+v, "alice")
		r.PendingCap = 2
		if _, err := Publish(db, r); err != nil {
			t.Fatalf("第 %d 次发布: %v", i+1, err)
		}
	}
	r := req("capped", "1.2.0", "cx", "alice")
	r.PendingCap = 2
	if _, err := Publish(db, r); code(t, err) != CodePendingLimit {
		t.Fatalf("配额 = %v", err)
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

// TestPublishKeepsOfficialOwnership 覆盖 P2-21:管理员给「官方」App 发版后,
// 归属仍是官方(owner=”),不得被改写成发布者。
func TestPublishKeepsOfficialOwnership(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	official := req("official-keep", "1.0.0", "c1", "admin")
	official.Channel = serverstore.AppChannelMarket
	official.AdminPublish = true
	if _, err := Publish(db, official); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetAppOfficial(db, serverstore.AppKindSkill, "official-keep", true, ""); err != nil {
		t.Fatal(err)
	}
	next := req("official-keep", "2.0.0", "c2", "admin")
	next.Channel = serverstore.AppChannelMarket
	next.AdminPublish = true
	if _, err := Publish(db, next); err != nil {
		t.Fatalf("admin publish official v2: %v", err)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, "official-keep")
	if err != nil {
		t.Fatal(err)
	}
	if app.Official != 1 || app.Owner != "" {
		t.Fatalf("after admin publish: official=%d owner=%q, want official=1 owner=''", app.Official, app.Owner)
	}
}

// TestPublishPendingCapPerKindAndAuthor 由已删除的 DAO 配额用例迁移而来
// (2026-09-15 死代码审计):CreateAgentPresetCapped / CreateSharedSkillCapped 的
// ErrTooManyPending 分支已不存在,配额检查的唯一生产落点是 Publish 的
// PendingCap → serverstore.PendingReleaseCountOn(publish.go:248)。
//
// 原用例断言:①填满配额 ②超配额被拒 ③他人不受影响 ④(智能体侧)重名/重复版本
// 的冲突语义。这里逐条落在生产入口上。
func TestPublishPendingCapPerKindAndAuthor(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)

	// ①+② 智能体与技能共用**同一份**待审计数(publisher 维度,不分 kind):
	// alice 已有 1 个 pending 技能,再发布 pending 智能体即占满配额 2。
	if _, err := Publish(db, req("cap-skill", "1.0.0", "k1", "alice")); err != nil {
		t.Fatalf("第 1 个待审: %v", err)
	}
	if _, err := Publish(db, agentReq("cap-agent", "1.0.0", "k2", "alice")); err != nil {
		t.Fatalf("第 2 个待审: %v", err)
	}
	over := agentReq("cap-over", "1.0.0", "k3", "alice")
	over.PendingCap = 2
	if _, err := Publish(db, over); code(t, err) != CodePendingLimit {
		t.Fatalf("超配额 = %v, want PENDING_LIMIT", err)
	}
	// ③ 另一个作者不受影响。
	other := agentReq("cap-other", "1.0.0", "k4", "bob")
	other.PendingCap = 2
	if _, err := Publish(db, other); err != nil {
		t.Fatalf("他人发布受 alice 配额影响: %v", err)
	}
	// ④ 重复版本的生产冲突语义:同名同版本再发 → VERSION_EXISTS(发布内核把
	// 旧 DAO 的 ErrDuplicate 细分成 VERSION_EXISTS / NAME_TAKEN 两个码,版本
	// 永久占位)。注:配额先于版本检查,所以这里把配额放宽以便观察冲突码。
	dup := agentReq("cap-agent", "1.0.0", "k5", "alice")
	if _, err := Publish(db, dup); code(t, err) != CodeVersionExists {
		t.Fatalf("同版本重复 = %v, want VERSION_EXISTS", err)
	}
	// 他人抢同名(同版本)→ NAME_TAKEN,归属保护优先于版本检查。
	steal := agentReq("cap-agent", "1.0.0", "k6", "bob")
	steal.PendingCap = 2
	if _, err := Publish(db, steal); code(t, err) != CodeNameTaken {
		t.Fatalf("他人抢同名 = %v, want NAME_TAKEN", err)
	}
}

// ---------------------------------------------------------------------------
// G-P2-3(审计 2026-09-23):待审/被拒版本的 title/description 不得进入 `apps`
// 投影行,且 approve/reject 之后必须按「最新 approved」重算投影。
//
// 背景:apps 行是**目录对全员下发的投影**,版本行才是真相。修复前 `appstore.Publish`
// 对待审版本照写投影(作者提交一个"改名成 IT 密码重置"的待审版本,全公司立刻在
// 目录里看到它),而 approve/reject 都不回填 ⇒ 被拒的标题永久留在投影行上、没有
// 自愈路径。WASM 面早已用守卫 + recomputeProjection 闭合,这条共用内核从未修。
//
// 变异验证:
//   - 让 Publish 重新投影待审元数据 ⇒ 第②步红;
//   - 摘掉 RecomputeAppProjection 调用(或把它改成"取最新版本")⇒ 第③④步红。
// ---------------------------------------------------------------------------
func TestPendingReleaseDoesNotPolluteProjection(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	const name = "proj-skill"

	// ① 首版待审:投影 = app_id 占位(不是包内标题,也不是空串)。
	r1 := raceReq(name, "1.0.0", "alice", "真实标题")
	if _, err := Publish(db, r1); err != nil {
		t.Fatalf("publish v1: %v", err)
	}
	app, err := serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if err != nil {
		t.Fatal(err)
	}
	if app.Title != name || app.Description != "" {
		t.Fatalf("首版待审投影 = %q/%q, want %q/空(待审版本没有生效)", app.Title, app.Description, name)
	}

	// ② 通过 v1 → 投影切到 v1 的元数据(approve 必须回填,否则"批准了也看不到")。
	if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill, name, "1.0.0",
		serverstore.ReleaseStatusApproved, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecomputeAppProjection(db, serverstore.AppKindSkill, name); err != nil {
		t.Fatal(err)
	}
	app, _ = serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if app.Title != "真实标题" {
		t.Fatalf("approve 后投影 = %q, want 真实标题", app.Title)
	}

	// ③ v2 待审(改名 + 换描述):投影必须**一字不动**。
	r2 := raceReq(name, "2.0.0", "alice", "UNAPPROVED Renamed")
	r2.Manifest.Description = "未审核的描述"
	if _, err := Publish(db, r2); err != nil {
		t.Fatalf("publish v2: %v", err)
	}
	app, _ = serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if app.Title != "真实标题" {
		t.Fatalf("待审版本污染了投影: title=%q(目录会对全员显示未审核的标题)", app.Title)
	}

	// ④ 拒绝 v2 → 投影回到 v1(被拒元数据不得留下)。
	if err := serverstore.SetReleaseStatusForReview(db, serverstore.AppKindSkill, name, "2.0.0",
		serverstore.ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.RecomputeAppProjection(db, serverstore.AppKindSkill, name); err != nil {
		t.Fatal(err)
	}
	app, _ = serverstore.GetApp(db, serverstore.AppKindSkill, name)
	if app.Title != "真实标题" || app.Description == "未审核的描述" {
		t.Fatalf("拒绝后投影 = %q/%q, want 真实标题 + v1 描述", app.Title, app.Description)
	}

	// ⑤ 员工可见的目录行(真相面)始终是 v1 的标题。
	rels, err := serverstore.ListReleases(db, serverstore.AppKindSkill, name)
	if err != nil {
		t.Fatal(err)
	}
	for _, rel := range rels {
		if rel.Status == serverstore.ReleaseStatusApproved && rel.Title != "真实标题" {
			t.Fatalf("已通过版本行标题 = %q", rel.Title)
		}
	}
}
