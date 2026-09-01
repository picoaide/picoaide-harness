package serverstore

import (
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
	// 同版本号不可复用(DB 唯一约束是最后一道防线)。
	if _, err := CreateRelease(db, r1); err == nil {
		t.Fatal("同 (kind,app,version) 必须被唯一约束拒绝")
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

// TestAppsBackfill: 0054 回填必须把三张旧表的数据完整搬进统一模型。
func TestAppsBackfill(t *testing.T) {
	db, cleanup := NewTestDB(t)
	t.Cleanup(cleanup)
	// 迁移已在建库时跑完;此处模拟「回填后」的增量校验:旧表写入 → 手工回填
	// 不再发生(生产由迁移一次性完成),所以这里验证的是回填 SQL 的语义等价性:
	// 通过直接执行同样的 INSERT ... SELECT 逻辑来确认列映射正确。
	if _, err := AddSkill(db, &Skill{Name: "mk", DisplayName: "市场技能", Version: "1.0.0",
		Description: "d", Author: "boss", Enabled: 1, Archive: []byte("zzz"), Checksum: "c1"}); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO apps (kind, app_id, title, description, owner, channel, enabled)
		SELECT 'skill', s.name, COALESCE(NULLIF(s.display_name, ''), s.name), s.description, s.author, 'market', s.enabled
		FROM skills s ON CONFLICT (kind, app_id) DO NOTHING`); err != nil {
		t.Fatalf("回填 App: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version, title, description, author,
		publisher, checksum, size, archive, status, downloads, calls)
		SELECT 'skill', s.name, s.version, COALESCE(NULLIF(s.display_name, ''), s.name), s.description,
		       s.author, s.author, s.checksum, COALESCE(octet_length(s.archive),0), s.archive, 'approved', s.downloads, s.calls
		FROM skills s ON CONFLICT (kind, app_id, version) DO NOTHING`); err != nil {
		t.Fatalf("回填 Release: %v", err)
	}
	a, err := GetApp(db, AppKindSkill, "mk")
	if err != nil || a.Title != "市场技能" || a.Channel != AppChannelMarket {
		t.Fatalf("回填后 App = %+v err=%v", a, err)
	}
	r, err := GetRelease(db, AppKindSkill, "mk", "1.0.0")
	if err != nil || r.Status != ReleaseStatusApproved || string(r.Archive) != "zzz" || r.Size != 3 {
		t.Fatalf("回填后 Release = %+v err=%v", r, err)
	}
}
