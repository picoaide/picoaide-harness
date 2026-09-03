package serverstore

import (
	"fmt"
	"testing"
)

func newAgentPreset(name, author string) *AgentPreset {
	return &AgentPreset{Name: name, Author: author, Status: AgentPresetPending, Version: "1.0.0"}
}

func TestAgentPresetCRUD(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateAgentPreset(db, newAgentPreset("coding-agent", "alice"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id <= 0 {
		t.Fatalf("id = %d", id)
	}

	p, err := GetAgentPreset(db, "coding-agent")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if p.Author != "alice" || p.Status != AgentPresetPending || p.DisplayName != "" {
		t.Fatalf("row = %+v", p)
	}

	if _, err := CreateAgentPreset(db, newAgentPreset("coding-agent", "bob")); err != ErrDuplicate {
		t.Fatalf("duplicate = %v, want ErrDuplicate", err)
	}

	if err := SetAgentPresetStatus(db, "coding-agent", AgentPresetApproved, ""); err != nil {
		t.Fatalf("approve: %v", err)
	}
	p, _ = GetAgentPreset(db, "coding-agent")
	if p.Status != AgentPresetApproved {
		t.Fatalf("status = %q", p.Status)
	}

	// Rejection stores the admin's reason; approving clears it.
	if err := SetAgentPresetStatus(db, "coding-agent", AgentPresetRejected, "缺少 skills/"); err != nil {
		t.Fatalf("reject: %v", err)
	}
	p, _ = GetAgentPreset(db, "coding-agent")
	if p.Status != AgentPresetRejected || p.Reason != "缺少 skills/" {
		t.Fatalf("rejected row = %+v", p)
	}
	if err := SetAgentPresetStatus(db, "coding-agent", AgentPresetApproved, ""); err != nil {
		t.Fatalf("approve again: %v", err)
	}
	p, _ = GetAgentPreset(db, "coding-agent")
	if p.Reason != "" {
		t.Fatalf("reason not cleared on approve: %q", p.Reason)
	}

	if err := DeleteAgentPreset(db, "coding-agent"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := GetAgentPreset(db, "coding-agent"); err != ErrNotFound {
		t.Fatalf("after delete = %v, want ErrNotFound", err)
	}
	if err := DeleteAgentPreset(db, "coding-agent"); err != ErrNotFound {
		t.Fatalf("delete missing = %v, want ErrNotFound", err)
	}
}

func TestAgentPresetResubmit(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	p := newAgentPreset("resubmit-me", "alice")
	if _, err := CreateAgentPreset(db, p); err != nil {
		t.Fatal(err)
	}
	if err := SetAgentPresetStatus(db, "resubmit-me", AgentPresetRejected, "测试拒绝"); err != nil {
		t.Fatal(err)
	}
	if err := UpdateAgentPresetResubmit(db, "resubmit-me", "新标题", "新描述", "abc123"); err != nil {
		t.Fatalf("resubmit: %v", err)
	}
	got, err := GetAgentPreset(db, "resubmit-me")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != AgentPresetPending || got.Description != "新描述" || got.Checksum != "abc123" || got.DisplayName != "新标题" || got.Reason != "" {
		t.Fatalf("resubmit row = %+v", got)
	}
	// 非 rejected 行不满足 resubmit 条件:0 行受影响但不报错
	if err := UpdateAgentPresetResubmit(db, "resubmit-me", "x", "x", "y"); err != nil {
		t.Fatalf("no-op resubmit: %v", err)
	}
}

func TestAgentPresetVisibleFilter(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	mustCreate := func(name, author string, status AgentPresetStatus) {
		t.Helper()
		p := newAgentPreset(name, author)
		p.Status = status
		if _, err := CreateAgentPreset(db, p); err != nil {
			t.Fatal(err)
		}
	}
	mustCreate("approved-a", "alice", AgentPresetApproved)
	mustCreate("approved-b", "bob", AgentPresetApproved)
	mustCreate("pending-alice", "alice", AgentPresetPending)
	mustCreate("pending-bob", "bob", AgentPresetPending)
	mustCreate("rejected-alice", "alice", AgentPresetRejected)
	mustCreate("rejected-bob", "bob", AgentPresetRejected)

	// 授权制:approved 需授权才可见,但作者始终可见自己的;未授权者只见自己的。
	vis, err := ListVisibleAgentPresets(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"approved-a":    true,                         // alice 自己上传的 approved
		"pending-alice": true, "rejected-alice": true, // 自己的任意状态
	}
	for _, p := range vis {
		if !want[p.Name] {
			t.Fatalf("alice sees %s, not expected", p.Name)
		}
		delete(want, p.Name)
	}
	if len(want) != 0 {
		t.Fatalf("missing for alice: %v", want)
	}
	// bob 未授权:看不见别人的 approved-a;自己上传的 approved-b 应可见。
	visBob, err := ListVisibleAgentPresets(db, "bob", nil)
	if err != nil {
		t.Fatal(err)
	}
	sawOwn := false
	for _, p := range visBob {
		if p.Name == "approved-a" || p.Name == "pending-alice" {
			t.Fatalf("bob sees %s (not granted)", p.Name)
		}
		if p.Name == "approved-b" {
			sawOwn = true
		}
	}
	if !sawOwn {
		t.Fatalf("bob does not see own approved-b")
	}
	// alice 被授予 approved-a:可见。
	visGranted, err := ListVisibleAgentPresets(db, "alice", []string{"approved-a"})
	if err != nil {
		t.Fatal(err)
	}
	seenApproved := false
	for _, p := range visGranted {
		if p.Name == "approved-a" && p.Status == AgentPresetApproved {
			seenApproved = true
		}
	}
	if !seenApproved {
		t.Fatalf("granted alice does not see approved-a")
	}

	all, err := ListAgentPresets(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 6 {
		t.Fatalf("admin list = %d, want 6", len(all))
	}
	pending, err := ListAgentPresets(db, "pending")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending list = %d, want 2", len(pending))
	}
}

func TestAgentPresetCappedAtomically(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	// Fill to cap.
	for i := 0; i < 2; i++ {
		p := newAgentPreset(fmt.Sprintf("cap-%d", i), "alice")
		if _, err := CreateAgentPresetCapped(db, p, 2); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	// At cap: the INSERT must refuse without erroring (0 rows).
	p := newAgentPreset("cap-over", "alice")
	if _, err := CreateAgentPresetCapped(db, p, 2); err != ErrTooManyPending {
		t.Fatalf("over cap = %v, want ErrTooManyPending", err)
	}
	// Another author is unaffected.
	b := newAgentPreset("bob-one", "bob")
	if _, err := CreateAgentPresetCapped(db, b, 2); err != nil {
		t.Fatalf("bob create: %v", err)
	}
	// Duplicate name surfaces as ErrDuplicate.
	d := newAgentPreset("cap-0", "bob")
	if _, err := CreateAgentPresetCapped(db, d, 2); err != ErrDuplicate {
		t.Fatalf("duplicate = %v, want ErrDuplicate", err)
	}
}

func TestAgentPresetStatusValidate(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	// 非法 status 被 CHECK 拒绝
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version, status) VALUES ('agent', 'x', '1.0.0', 'bogus')`); err == nil {
		t.Fatal("bogus status accepted")
	}
	// 空 author 拒绝(NOT NULL)
	if _, err := db.Exec(`INSERT INTO app_releases (kind, app_id, version) VALUES ('bogus-kind', 'x', '1.0.0')`); err == nil {
		t.Fatal("null author accepted")
	}
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("re-apply (idempotent) failed: %v", err)
	}
}

func TestAgentPresetQuality(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	// 0037 quality 列:仅 approved 行可设置;非法值拒绝。
	p := newAgentPreset("qual", "alice")
	if _, err := CreateAgentPreset(db, p); err != nil {
		t.Fatal(err)
	}
	if err := SetAgentPresetQuality(db, "qual", "1.0.0", "featured"); err != ErrNotFound {
		t.Fatalf("quality on pending = %v, want ErrNotFound", err)
	}
	if err := SetAgentPresetStatusByVersion(db, "qual", "1.0.0", AgentPresetApproved, ""); err != nil {
		t.Fatal(err)
	}
	if err := SetAgentPresetQuality(db, "qual", "1.0.0", "featured"); err != nil {
		t.Fatalf("set featured: %v", err)
	}
	if err := SetAgentPresetQuality(db, "qual", "1.0.0", "pro"); err != ErrValidation {
		t.Fatalf("bad quality = %v, want ErrValidation", err)
	}
	got, err := GetAgentPresetByVersion(db, "qual", "1.0.0")
	if err != nil || got.Quality != "featured" {
		t.Fatalf("row = %+v err=%v", got, err)
	}
	if err := SetAgentPresetQuality(db, "qual", "1.0.0", ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = GetAgentPresetByVersion(db, "qual", "1.0.0")
	if got.Quality != "" {
		t.Fatalf("after clear quality=%q", got.Quality)
	}
	if err := SetAgentPresetQuality(db, "nope", "1.0.0", "featured"); err != ErrNotFound {
		t.Fatalf("missing = %v, want ErrNotFound", err)
	}
}

// TestAgentPresetArchiveDB: 0041 — CreateAgentPresetCapped stores the archive
// blob; SetAgentPresetArchive updates it; GetAgentPresetArchive reads it;
// IncrementAgentPresetDownload bumps the counter; list views exclude the blob.
func TestAgentPresetArchiveDB(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	blob := []byte("gz-tar-preset")
	p := &AgentPreset{Name: "arch", Version: "1.0.0", Author: "alice", Status: AgentPresetPending, Archive: blob, Checksum: "sum1"}
	if _, err := CreateAgentPresetCapped(db, p, 10); err != nil {
		t.Fatal(err)
	}
	got, err := GetAgentPresetArchive(db, "arch", "1.0.0")
	if err != nil || string(got) != string(blob) {
		t.Fatalf("archive = %q err=%v", got, err)
	}
	// 单行读带 Archive;列表读不带 blob。
	row, err := GetAgentPresetByVersion(db, "arch", "1.0.0")
	if err != nil || string(row.Archive) != string(blob) {
		t.Fatalf("row archive = %q err=%v", row.Archive, err)
	}
	all, err := ListAgentPresets(db, "")
	if err != nil || len(all) != 1 || len(all[0].Archive) != 0 {
		t.Fatalf("list = %+v err=%v (blob must be excluded)", all, err)
	}
	// 下载计数。
	if ok, err := IncrementAgentPresetDownload(db, "arch", "1.0.0"); err != nil || !ok {
		t.Fatalf("download inc: ok=%v err=%v", ok, err)
	}
	row, _ = GetAgentPresetByVersion(db, "arch", "1.0.0")
	if row.Downloads != 1 {
		t.Fatalf("downloads = %d, want 1", row.Downloads)
	}
	// 覆盖归档(重提路径)。
	if err := SetAgentPresetArchive(db, "arch", "1.0.0", []byte("v2")); err != nil {
		t.Fatal(err)
	}
	got, _ = GetAgentPresetArchive(db, "arch", "1.0.0")
	if string(got) != "v2" {
		t.Fatalf("after overwrite = %q", got)
	}
	// 清除归档(删除路径)。
	if err := ClearAgentPresetArchive(db, "arch", "1.0.0"); err != nil {
		t.Fatal(err)
	}
	got, err = GetAgentPresetArchive(db, "arch", "1.0.0")
	if err != nil || got != nil {
		t.Fatalf("after clear = %q err=%v", got, err)
	}
}
