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
