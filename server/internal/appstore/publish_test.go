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
		Manifest: Manifest{Version: version, Title: appID + " 技能",
			Description: "足够长的技能描述用于测试。", Author: publisher, Category: "测试"},
	}
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
	if _, err := Publish(db, req("alice-app", "2.0.0", "b1", "bob")); code(t, err) != CodeNotFound {
		t.Fatalf("跨作者接管 = %v", err)
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

func TestVisibleReleasesRespectsGrants(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	if _, err := Publish(db, req("shared", "1.0.0", "s1", "alice")); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetReleaseStatus(db, serverstore.AppKindSkill, "shared", "1.0.0",
		serverstore.ReleaseStatusApproved, ""); err != nil {
		t.Fatal(err)
	}
	// 未授权:bob 看不到(严格默认)。
	list, _, err := VisibleReleases(db, serverstore.AppKindSkill, "bob", nil, false)
	if err != nil || len(list) != 0 {
		t.Fatalf("未授权可见 = %v err=%v", list, err)
	}
	// 作者可见自己的。
	list, _, _ = VisibleReleases(db, serverstore.AppKindSkill, "alice", nil, false)
	if len(list) != 1 {
		t.Fatalf("作者不可见自己的 App: %v", list)
	}
	// 授权后 bob 可见。
	if err := serverstore.GrantApp(db, serverstore.AppKindSkill, "shared", "bob", "user"); err != nil {
		t.Fatal(err)
	}
	list, _, _ = VisibleReleases(db, serverstore.AppKindSkill, "bob", nil, false)
	if len(list) != 1 || list[0].Version != "1.0.0" {
		t.Fatalf("授权后 = %v", list)
	}
	// 下架后员工不可见,管理员仍可见。
	if err := serverstore.SetAppEnabled(db, serverstore.AppKindSkill, "shared", false); err != nil {
		t.Fatal(err)
	}
	list, _, _ = VisibleReleases(db, serverstore.AppKindSkill, "bob", nil, false)
	if len(list) != 0 {
		t.Fatalf("下架后仍可见: %v", list)
	}
	list, _, _ = VisibleReleases(db, serverstore.AppKindSkill, "admin", nil, true)
	if len(list) != 1 {
		t.Fatalf("管理员应恒全量: %v", list)
	}
}

func TestApprovedVersionsSorted(t *testing.T) {
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	// 按递增顺序发布(递增校验本身已被上面的用例覆盖);这里验证的是
	// ApprovedVersions 的排序是数值感知的:1.10.0 必须排在 1.2.0 之后。
	for _, v := range []string{"1.0.0", "1.2.0", "1.10.0"} {
		if _, err := Publish(db, req("multi", v, "c"+v, "alice")); err != nil {
			t.Fatalf("publish %s: %v", v, err)
		}
		if err := serverstore.SetReleaseStatus(db, serverstore.AppKindSkill, "multi", v,
			serverstore.ReleaseStatusApproved, ""); err != nil {
			t.Fatal(err)
		}
	}
	got, err := ApprovedVersions(db, serverstore.AppKindSkill, "multi")
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"1.0.0", "1.2.0", "1.10.0"} // 数值感知排序,不是字典序
	if len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("versions = %v, want %v", got, want)
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
