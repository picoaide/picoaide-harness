package serverstore

import (
	"database/sql"
	"errors"
	"testing"
)

func TestAppReleaseLifecycle(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	app := &App{Kind: AppKindSkill, AppID: "demo-skill", Title: "演示技能",
		Description: "描述", Owner: "alice", Channel: AppChannelOrg, Enabled: 1}
	if err := UpsertApp(db, app); err != nil {
		t.Fatal(err)
	}
	// 幂等:重复 upsert 更新展示元数据,但不改渠道与已有归属。
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: "demo-skill", Title: "新标题",
		Owner: "bob", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	got, err := GetApp(db, AppKindSkill, "demo-skill")
	if err != nil || got.Title != "新标题" || got.Owner != "alice" {
		t.Fatalf("app = %+v err=%v (owner 必须保持首个发布者)", got, err)
	}
	// kind 隔离:同名 agent 是另一个 App。
	if _, err := GetApp(db, AppKindAgent, "demo-skill"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("kind 未隔离: %v", err)
	}

	r1 := &Release{Kind: AppKindSkill, AppID: "demo-skill", Version: "1.0.0", Title: "演示技能",
		Description: "描述", Author: "alice", Publisher: "alice", Checksum: "aa",
		Archive: []byte("zip-bytes"), Tags: []string{"hr", "报销"}, Status: ReleaseStatusPending}
	if _, err := CreateRelease(db, r1); err != nil {
		t.Fatal(err)
	}
	full, err := GetRelease(db, AppKindSkill, "demo-skill", "1.0.0")
	if err != nil || string(full.Archive) != "zip-bytes" || full.Size != int64(len("zip-bytes")) {
		t.Fatalf("release = %+v err=%v", full, err)
	}
	if len(full.Tags) != 2 || full.Tags[0] != "hr" {
		t.Fatalf("tags 未往返: %v", full.Tags)
	}
	// 同版本号不可复用(DB 唯一约束是最后一道防线;B7:必须映射 ErrDuplicate)。
	if _, err := CreateRelease(db, r1); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("同 (kind,app,version) 必须被唯一约束拒绝为 ErrDuplicate, got %v", err)
	}

	// 审核:只改状态,不碰内容。
	if err := SetReleaseStatus(db, AppKindSkill, "demo-skill", "1.0.0", ReleaseStatusApproved, ""); err != nil {
		t.Fatal(err)
	}
	if err := SetReleaseQuality(db, AppKindSkill, "demo-skill", "1.0.0", "official"); err != nil {
		t.Fatal(err)
	}
	full, _ = GetRelease(db, AppKindSkill, "demo-skill", "1.0.0")
	if full.Status != ReleaseStatusApproved || full.Quality != "official" || string(full.Archive) != "zip-bytes" {
		t.Fatalf("审核不得改动内容: %+v", full)
	}
	// 拒绝时清空质量标记。
	if err := SetReleaseStatus(db, AppKindSkill, "demo-skill", "1.0.0", ReleaseStatusRejected, "不合规"); err != nil {
		t.Fatal(err)
	}
	full, _ = GetRelease(db, AppKindSkill, "demo-skill", "1.0.0")
	if full.Quality != "" || full.Reason != "不合规" {
		t.Fatalf("reject 后 = %+v", full)
	}
	// 非 approved 版本不可设质量。
	if err := SetReleaseQuality(db, AppKindSkill, "demo-skill", "1.0.0", "featured"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("非 approved 设质量 = %v, want ErrNotFound", err)
	}

	// 软删:归档清空,但版本号仍占位(列表可见 → 判重仍能看到)。
	if err := SoftDeleteRelease(db, AppKindSkill, "demo-skill", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	list, err := ListReleases(db, AppKindSkill, "demo-skill")
	if err != nil || len(list) != 1 || list[0].DeletedAt == nil {
		t.Fatalf("软删后列表 = %+v err=%v", list, err)
	}
	if _, err := CreateRelease(db, r1); err == nil {
		t.Fatal("软删的版本号仍不可复用")
	}
}

func TestAppGrantsVisibility(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: "granted", Channel: AppChannelMarket, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: "ungranted", Channel: AppChannelMarket, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if err := GrantApp(db, AppKindSkill, "granted", "alice", "user"); err != nil {
		t.Fatal(err)
	}
	if err := GrantApp(db, AppKindSkill, "granted", "Eng", "group"); err != nil {
		t.Fatal(err)
	}
	// 严格默认:只返回被授权的。
	names, err := AccessibleAppIDs(db, AppKindSkill, "alice", nil)
	if err != nil || len(names) != 1 || names[0] != "granted" {
		t.Fatalf("user 授权 = %v err=%v", names, err)
	}
	// 部门组大小写不敏感(沿用旧语义)。
	names, _ = AccessibleAppIDs(db, AppKindSkill, "bob", []string{"eng"})
	if len(names) != 1 || names[0] != "granted" {
		t.Fatalf("group 授权(大小写不敏感) = %v", names)
	}
	names, _ = AccessibleAppIDs(db, AppKindSkill, "carol", []string{"other"})
	if len(names) != 0 {
		t.Fatalf("未授权用户应看不到任何 App, got %v", names)
	}
	grants, _ := ListAppGrants(db, AppKindSkill, "granted")
	if len(grants) != 2 {
		t.Fatalf("grants = %v", grants)
	}
	if err := RevokeApp(db, AppKindSkill, "granted", "alice", "user"); err != nil {
		t.Fatal(err)
	}
	if names, _ := AccessibleAppIDs(db, AppKindSkill, "alice", nil); len(names) != 0 {
		t.Fatalf("撤销后仍可见: %v", names)
	}
}

// TestAppMarketProjection: 市场技能经统一模型往返后,展示投影必须保持一致
// (P5 后旧 skills 表已下线,回填 SQL 的语义由生产迁移一次性验证过)。
func TestAppMarketProjection(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	if _, err := AddSkill(db, &Skill{Name: "mk", DisplayName: "市场技能", Version: "1.0.0",
		Description: "d", Author: "boss", Enabled: 1, Archive: []byte("zzz"), Checksum: "c1"}); err != nil {
		t.Fatal(err)
	}
	a, err := GetApp(db, AppKindSkill, "mk")
	if err != nil || a.Title != "市场技能" || a.Channel != AppChannelMarket {
		t.Fatalf("App = %+v err=%v", a, err)
	}
	r, err := GetRelease(db, AppKindSkill, "mk", "1.0.0")
	if err != nil || r.Status != ReleaseStatusApproved || string(r.Archive) != "zzz" || r.Size != 3 {
		t.Fatalf("Release = %+v err=%v", r, err)
	}
	// 旧 DTO 投影:展示版本 = 最高 approved。
	s, err := GetSkill(db, "mk")
	if err != nil || s.Version != "1.0.0" || s.DisplayName != "市场技能" || string(s.Archive) != "zzz" {
		t.Fatalf("Skill 投影 = %+v err=%v", s, err)
	}
}

// TestUpsertAppAndCreateReleaseAtomic 覆盖 P2-3:占名 + 建版本必须原子。
// CreateRelease 失败时不得留下「占名无版本」的悬挂 App。
//
// 生产入口是 UpsertAppAndCreateReleaseOn(与发布锁同事务,N-2);这里用显式
// 事务复刻调用方的 Commit/Rollback,原子性断言与旧 db 版逐条对应。
func TestUpsertAppAndCreateReleaseAtomic(t *testing.T) {
	db, cleanup := NewTestDB(t)
	defer cleanup()
	// 1) 版本插入失败(status 违反 CHECK 约束)→ 占名也必须回滚
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	_, err = UpsertAppAndCreateReleaseOn(tx, &App{
		Kind: AppKindSkill, AppID: "ghost", Title: "ghost", Owner: "alice", Channel: AppChannelOrg, Enabled: 1,
	}, &Release{Kind: AppKindSkill, AppID: "ghost", Version: "1.0.0", Publisher: "alice", Status: "bogus"})
	if err == nil {
		_ = tx.Rollback()
		t.Fatal("want release insert error, got nil")
	}
	_ = tx.Rollback()
	if _, err := GetApp(db, AppKindSkill, "ghost"); err != ErrNotFound {
		t.Fatalf("dangling app left after rollback (err=%v)", err)
	}
	// 2) 成功路径:App 与版本都在
	tx2, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UpsertAppAndCreateReleaseOn(tx2, &App{
		Kind: AppKindSkill, AppID: "atomic", Title: "atomic", Owner: "alice", Channel: AppChannelOrg, Enabled: 1,
	}, &Release{Kind: AppKindSkill, AppID: "atomic", Version: "1.0.0", Publisher: "alice"}); err != nil {
		_ = tx2.Rollback()
		t.Fatalf("atomic publish: %v", err)
	}
	if err := tx2.Commit(); err != nil {
		t.Fatal(err)
	}
	if _, err := GetApp(db, AppKindSkill, "atomic"); err != nil {
		t.Fatalf("app missing after atomic publish: %v", err)
	}
	if _, err := GetRelease(db, AppKindSkill, "atomic", "1.0.0"); err != nil {
		t.Fatalf("release missing after atomic publish: %v", err)
	}
	// 3) 版本唯一冲突 → 占名侧的标题更新一并回滚
	tx3, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	_, err = UpsertAppAndCreateReleaseOn(tx3, &App{
		Kind: AppKindSkill, AppID: "atomic", Title: "改了标题", Owner: "alice", Channel: AppChannelOrg, Enabled: 1,
	}, &Release{Kind: AppKindSkill, AppID: "atomic", Version: "1.0.0", Publisher: "alice"})
	_ = tx3.Rollback()
	if !errors.Is(err, ErrDuplicate) {
		t.Fatalf("err = %v, want ErrDuplicate", err)
	}
	app, err := GetApp(db, AppKindSkill, "atomic")
	if err != nil {
		t.Fatal(err)
	}
	if app.Title != "atomic" {
		t.Fatalf("app title = %q, want unchanged (事务回滚)", app.Title)
	}
}

// TestAppEnabledLookupAndBatchMap(P2-1,审计 2026-09-13):下架是 App 级状态,
// 读取侧需要「单个查询」与「一次批量」两种形态——批量形态供清单过滤,
// 避免逐行 N+1;App 不存在与下架同语义(false),不泄露存在性。
func TestAppEnabledLookupAndBatchMap(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	for _, a := range []*App{
		{Kind: AppKindAgent, AppID: "live-agent", Channel: AppChannelOrg, Enabled: 1},
		{Kind: AppKindAgent, AppID: "pulled-agent", Channel: AppChannelMarket, Enabled: 0},
		{Kind: AppKindSkill, AppID: "live-skill", Channel: AppChannelMarket, Enabled: 1},
	} {
		if err := UpsertApp(db, a); err != nil {
			t.Fatal(err)
		}
	}

	for _, tc := range []struct {
		kind, appID string
		want        bool
	}{
		{AppKindAgent, "live-agent", true},
		{AppKindAgent, "pulled-agent", false},
		{AppKindSkill, "live-agent", false}, // kind 隔离:同名 skill 不存在
	} {
		got, err := AppEnabled(db, tc.kind, tc.appID)
		if err != nil {
			t.Fatalf("AppEnabled(%s,%s): %v", tc.kind, tc.appID, err)
		}
		if got != tc.want {
			t.Fatalf("AppEnabled(%s,%s) = %v, want %v", tc.kind, tc.appID, got, tc.want)
		}
	}

	agents, err := EnabledAppIDs(db, AppKindAgent)
	if err != nil {
		t.Fatal(err)
	}
	if !agents["live-agent"] || agents["pulled-agent"] {
		t.Fatalf("EnabledAppIDs(agent) = %v, want 只有 live-agent", agents)
	}
	skills, err := EnabledAppIDs(db, AppKindSkill)
	if err != nil {
		t.Fatal(err)
	}
	if !skills["live-skill"] || len(skills) != 1 {
		t.Fatalf("EnabledAppIDs(skill) = %v, want 只有 live-skill", skills)
	}
}

// TestSetAppTitleKeepsOwnershipAndFlags(P2-6,审计 2026-09-13):发布后回写
// 包内展示名只允许改 title——owner/官方属性/渠道/上下架都不受触碰
// (owner 只认登录态,包内 author 是不可信输入)。
func TestSetAppTitleKeepsOwnershipAndFlags(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)

	if err := UpsertApp(db, &App{Kind: AppKindAgent, AppID: "official-agent",
		Title: "旧名", Description: "旧描述", Owner: "bob",
		Channel: AppChannelMarket, Enabled: 0}); err != nil {
		t.Fatal(err)
	}
	// 官方属性挂 App 级且不由 UpsertApp 写入:转官方 = official=1 + owner=''。
	if err := SetAppOfficial(db, AppKindAgent, "official-agent", true, ""); err != nil {
		t.Fatal(err)
	}
	if err := SetAppTitle(db, AppKindAgent, "official-agent", "包内新名"); err != nil {
		t.Fatal(err)
	}
	got, err := GetApp(db, AppKindAgent, "official-agent")
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "包内新名" {
		t.Fatalf("title = %q, want 包内新名", got.Title)
	}
	if got.Owner != "" || got.Official != 1 || got.Description != "旧描述" ||
		got.Channel != AppChannelMarket || got.Enabled != 0 {
		t.Fatalf("SetAppTitle 触碰了非展示名字段: %+v", got)
	}
	if err := SetAppTitle(db, AppKindAgent, "missing", "x"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing app err = %v, want ErrNotFound", err)
	}
}

// ---------------------------------------------------------------------------
// ID-01(审计 2026-09-23,P0):「审核拒绝一个版本」在三个面上三份实现,只有
// WASM 面带前置条件 —— 组织面对**已通过且在服务中**的版本点「拒绝」会走
// `archive = NULL, size = 0` 这条无前置条件的 UPDATE,不可恢复地销毁归档字节、
// 让该版本对全员 404、并烧掉版本号(同版本号永久占位,不能重提)。
//
// 修法:前置条件下沉到 DAO(全仓唯一实现),三个审核面都只把 sentinel 映射成
// 409。本用例是**跨面一致性**判据 —— 三种 kind 走同一组 (status, action)
// 矩阵,结论必须逐条一致;这正是此前缺失的那条对拍。
//
// 变异验证:去掉 rejected 分支的 `AND status <> ?`(或把它恒真)⇒ 本用例红。
// ---------------------------------------------------------------------------

// reviewFaces 是共享审核内核的三个消费面(技能 / 智能体 / wasm 应用)。
var reviewFaces = []struct {
	name string
	kind string
}{
	{"skill", AppKindSkill},
	{"agent", AppKindAgent},
	{"wasm_app", AppKindWasmApp},
}

func TestRejectGuardIsSharedByAllReviewFaces(t *testing.T) {
	for _, face := range reviewFaces {
		t.Run(face.name, func(t *testing.T) {
			db, cleanup := NewTestDB(t)
			t.Cleanup(cleanup)
			appID := "id01-" + face.name

			// wasm 应用不经 UpsertApp(skill/agent 专用入口,kind 白名单),但它
			// 与技能/智能体共用 apps/app_releases 两张表,所以这里直接落一行占位
			// (app_releases 有指向 (kind,app_id) 的外键)。
			if _, err := db.Exec(`INSERT INTO apps (kind, app_id, title, owner, channel, enabled)
				VALUES (?, ?, 'T', 'alice', ?, 1)`, face.kind, appID, AppChannelOrg); err != nil {
				t.Fatal(err)
			}
			// v1:待审 → 通过(成为"在服务中"的版本)。
			if _, err := CreateRelease(db, &Release{Kind: face.kind, AppID: appID, Version: "1.0.0",
				Title: "T", Publisher: "alice", Status: ReleaseStatusPending,
				Archive: []byte("v1-bytes")}); err != nil {
				t.Fatal(err)
			}
			if err := SetReleaseStatusForReview(db, face.kind, appID, "1.0.0", ReleaseStatusApproved, ""); err != nil {
				t.Fatalf("approve v1: %v", err)
			}

			// 核心断言①:拒绝一个已 approved 的版本必须被拒,且**不动归档**。
			err := SetReleaseStatusForReview(db, face.kind, appID, "1.0.0", ReleaseStatusRejected, "误点拒绝")
			if !errors.Is(err, ErrReleaseApprovedNotRejectable) {
				t.Fatalf("reject approved = %v, want ErrReleaseApprovedNotRejectable", err)
			}
			row, err := GetRelease(db, face.kind, appID, "1.0.0")
			if err != nil {
				t.Fatal(err)
			}
			if row.Status != ReleaseStatusApproved {
				t.Fatalf("status = %s, want approved(拒绝不得改变已生效版本的状态)", row.Status)
			}
			if len(row.Archive) == 0 || row.Size == 0 {
				t.Fatalf("归档被销毁: archive=%d size=%d(ID-01 的 P0 后果)", len(row.Archive), row.Size)
			}

			// 核心断言②:判定函数与 SQL 同源(Go 侧唯一判定)。
			if ReleaseRejectable(row.Status) {
				t.Fatalf("ReleaseRejectable(%s) = true,与 DAO 的判定分叉", row.Status)
			}

			// 控制组:待审版本仍必须可被正常拒绝(修复不能把"拒绝"整个关掉 ——
			// 「拒绝即释放归档」是 agentshare-5 的存储上界)。
			if _, err := CreateRelease(db, &Release{Kind: face.kind, AppID: appID, Version: "2.0.0",
				Title: "T2", Publisher: "alice", Status: ReleaseStatusPending,
				Archive: []byte("v2-bytes")}); err != nil {
				t.Fatal(err)
			}
			if err := SetReleaseStatusForReview(db, face.kind, appID, "2.0.0", ReleaseStatusRejected, "不合规"); err != nil {
				t.Fatalf("reject pending = %v, want nil", err)
			}
			pending, err := GetRelease(db, face.kind, appID, "2.0.0")
			if err != nil {
				t.Fatal(err)
			}
			if pending.Status != ReleaseStatusRejected || len(pending.Archive) != 0 || pending.Size != 0 {
				t.Fatalf("待审版本的拒绝语义被破坏: status=%s archive=%d size=%d",
					pending.Status, len(pending.Archive), pending.Size)
			}
			// 已拒绝的行重复拒绝仍幂等(不是"0 行 ⇒ 一律报已通过")。
			if err := SetReleaseStatusForReview(db, face.kind, appID, "2.0.0", ReleaseStatusRejected, "再拒"); err != nil {
				t.Fatalf("re-reject rejected = %v, want nil(幂等)", err)
			}
			// 不存在的版本仍是 ErrNotFound(不能与"已通过不可拒"混淆)。
			if err := SetReleaseStatusForReview(db, face.kind, appID, "9.9.9", ReleaseStatusRejected, "x"); !errors.Is(err, ErrNotFound) {
				t.Fatalf("reject missing = %v, want ErrNotFound", err)
			}
		})
	}
}

// TestRecomputeAppProjectionFollowsLatestApproved 钉住投影重算的唯一判据
// (审计 2026-09-23 G-P2-3):apps.title/description 必须**恒等于**"最新
// approved 版本"的值;没有任何 approved 版本时回落 app_id 占位。
//
// 变异验证:把 RecomputeAppProjection 改成"取最新版本"(丢掉 status 过滤)⇒ 红。
func TestRecomputeAppProjectionFollowsLatestApproved(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	const appID = "proj-app"

	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: appID, Title: appID,
		Description: "", Owner: "alice", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	// v1 通过。
	if _, err := CreateRelease(db, &Release{Kind: AppKindSkill, AppID: appID, Version: "1.0.0",
		Title: "V1 标题", Description: "v1 描述", Publisher: "alice",
		Status: ReleaseStatusApproved, Archive: []byte("a")}); err != nil {
		t.Fatal(err)
	}
	if v, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil || v != "1.0.0" {
		t.Fatalf("recompute v1 = %q err=%v", v, err)
	}
	app, _ := GetApp(db, AppKindSkill, appID)
	if app.Title != "V1 标题" || app.Description != "v1 描述" {
		t.Fatalf("投影未切到 v1: %+v", app)
	}

	// 幂等且最小写入:值没变时不得触碰 updated_at。
	if _, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil {
		t.Fatal(err)
	}
	before := rawUpdatedAt(t, db, appID)
	if _, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil {
		t.Fatal(err)
	}
	if after := rawUpdatedAt(t, db, appID); after != before {
		t.Fatalf("值未变时仍写了行: updated_at %s → %s", before, after)
	}

	// v2 待审(发布内核不投影它)⇒ 再重算仍必须回到 v1。
	if _, err := CreateRelease(db, &Release{Kind: AppKindSkill, AppID: appID, Version: "2.0.0",
		Title: "V2 未审", Description: "v2 描述", Publisher: "alice",
		Status: ReleaseStatusPending, Archive: []byte("b")}); err != nil {
		t.Fatal(err)
	}
	if v, err := RecomputeAppProjection(db, AppKindSkill, appID); err != nil || v != "1.0.0" {
		t.Fatalf("recompute with pending v2 = %q err=%v, want 1.0.0", v, err)
	}
	app, _ = GetApp(db, AppKindSkill, appID)
	if app.Title != "V1 标题" {
		t.Fatalf("待审版本污染了投影: %q", app.Title)
	}

	// v3 通过 ⇒ 投影切到 v3;软删 v3 ⇒ 回落到 v1(仍是 approved 的最高版本)。
	if _, err := CreateRelease(db, &Release{Kind: AppKindSkill, AppID: appID, Version: "3.0.0",
		Title: "V3 标题", Description: "v3 描述", Publisher: "alice",
		Status: ReleaseStatusApproved, Archive: []byte("c")}); err != nil {
		t.Fatal(err)
	}
	if v, _ := RecomputeAppProjection(db, AppKindSkill, appID); v != "3.0.0" {
		t.Fatalf("recompute v3 = %q", v)
	}
	if err := SoftDeleteRelease(db, AppKindSkill, appID, "3.0.0"); err != nil {
		t.Fatal(err)
	}
	if v, _ := RecomputeAppProjection(db, AppKindSkill, appID); v != "1.0.0" {
		t.Fatalf("软删后 recompute = %q, want 1.0.0", v)
	}
	app, _ = GetApp(db, AppKindSkill, appID)
	if app.Title != "V1 标题" {
		t.Fatalf("软删后投影 = %q, want V1 标题", app.Title)
	}

	// 首版待审被拒(没有任何 approved 版本)⇒ app_id 占位,不是空标题。
	const freshID = "proj-fresh"
	if err := UpsertApp(db, &App{Kind: AppKindAgent, AppID: freshID, Title: "脏标题",
		Description: "脏描述", Owner: "alice", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateRelease(db, &Release{Kind: AppKindAgent, AppID: freshID, Version: "1.0.0",
		Title: "脏标题", Description: "脏描述", Publisher: "alice",
		Status: ReleaseStatusRejected, Archive: nil}); err != nil {
		t.Fatal(err)
	}
	if v, err := RecomputeAppProjection(db, AppKindAgent, freshID); err != nil || v != "" {
		t.Fatalf("recompute without approved = %q err=%v, want 空版本号", v, err)
	}
	fresh, _ := GetApp(db, AppKindAgent, freshID)
	if fresh.Title != freshID || fresh.Description != "" {
		t.Fatalf("无 approved 版本时投影 = %q/%q, want app_id 占位", fresh.Title, fresh.Description)
	}
}

// rawUpdatedAt 读 apps.updated_at 的文本形态(精确到 PG 的微秒精度,不受
// Go 侧时间解析截断影响),用于断言"值没变就不写"。
func rawUpdatedAt(t *testing.T, db *sql.DB, appID string) string {
	t.Helper()
	var s string
	if err := db.QueryRow(`SELECT updated_at::text FROM apps WHERE kind = ? AND app_id = ?`,
		AppKindSkill, appID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSetAppOfficialRejectsForbiddenState 钉住官方归属的唯一合法形态
// (审计 2026-09-23 G-P2-1):`official=1 ∧ owner≠''` 是禁止状态 —— 它会让
// is_owner 对 owner 为 true 而发布仍被 OFFICIAL_LOCKED 拒,客户端预检与
// 服务端判定分叉。守卫放在唯一的写入点,任何未来调用者都造不出来。
func TestSetAppOfficialRejectsForbiddenState(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	if err := UpsertApp(db, &App{Kind: AppKindSkill, AppID: "official-guard",
		Title: "T", Owner: "alice", Channel: AppChannelOrg, Enabled: 1}); err != nil {
		t.Fatal(err)
	}
	if err := SetAppOfficial(db, AppKindSkill, "official-guard", true, "alice"); !errors.Is(err, ErrValidation) {
		t.Fatalf("official=1 ∧ owner≠'' = %v, want ErrValidation", err)
	}
	if app, _ := GetApp(db, AppKindSkill, "official-guard"); app.Official != 0 || app.Owner != "alice" {
		t.Fatalf("被拒的写入改变了行: %+v", app)
	}
	// 两种合法形态仍照常工作。
	if err := SetAppOfficial(db, AppKindSkill, "official-guard", true, ""); err != nil {
		t.Fatal(err)
	}
	if app, _ := GetApp(db, AppKindSkill, "official-guard"); app.Official != 1 || app.Owner != "" {
		t.Fatalf("转官方 = %+v", app)
	}
	if err := SetAppOfficial(db, AppKindSkill, "official-guard", false, "bob"); err != nil {
		t.Fatal(err)
	}
	if app, _ := GetApp(db, AppKindSkill, "official-guard"); app.Official != 0 || app.Owner != "bob" {
		t.Fatalf("转用户 = %+v", app)
	}
}
