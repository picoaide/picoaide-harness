package serverstore

import (
	"fmt"
	"testing"
)

func newSharedSkill(name, version, author string) *SharedSkill {
	return &SharedSkill{Name: name, Version: version, Author: author, Status: SharedSkillPending}
}

func TestSharedSkillCRUD(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateSharedSkill(db, newSharedSkill("codeql-audit", "1.0.0", "alice"))
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id <= 0 {
		t.Fatalf("id = %d", id)
	}
	s, err := GetSharedSkill(db, "codeql-audit", "1.0.0")
	if err != nil || s.Author != "alice" || s.Status != SharedSkillPending || s.DisplayName != "" {
		t.Fatalf("row = %+v err=%v", s, err)
	}

	// Same name different version is allowed (multi-version).
	if _, err := CreateSharedSkill(db, newSharedSkill("codeql-audit", "1.1.0", "alice")); err != nil {
		t.Fatalf("second version: %v", err)
	}
	// Same name+version duplicate refused.
	if _, err := CreateSharedSkill(db, newSharedSkill("codeql-audit", "1.0.0", "bob")); err != ErrDuplicate {
		t.Fatalf("duplicate = %v, want ErrDuplicate", err)
	}

	if err := SetSharedSkillStatus(db, "codeql-audit", "1.0.0", SharedSkillApproved, ""); err != nil {
		t.Fatalf("approve: %v", err)
	}
	s, _ = GetSharedSkill(db, "codeql-audit", "1.0.0")
	if s.Status != SharedSkillApproved {
		t.Fatalf("status = %q", s.Status)
	}
	// Reject stores reason; approve clears it.
	if err := SetSharedSkillStatus(db, "codeql-audit", "1.1.0", SharedSkillRejected, "缺 SKILL.md"); err != nil {
		t.Fatalf("reject: %v", err)
	}
	s, _ = GetSharedSkill(db, "codeql-audit", "1.1.0")
	if s.Status != SharedSkillRejected || s.Reason != "缺 SKILL.md" {
		t.Fatalf("rejected row = %+v", s)
	}

	if err := DeleteSharedSkill(db, "codeql-audit", "1.0.0"); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, err := GetSharedSkill(db, "codeql-audit", "1.0.0"); err != ErrNotFound {
		t.Fatalf("after delete = %v, want ErrNotFound", err)
	}
	// 1.1.0 remains (multi-version independence).
	if _, err := GetSharedSkill(db, "codeql-audit", "1.1.0"); err != nil {
		t.Fatalf("1.1.0 should remain: %v", err)
	}
}

func TestSharedSkillVisibleFilter(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	mustCreate := func(name, version, author string, status SharedSkillStatus) {
		t.Helper()
		s := newSharedSkill(name, version, author)
		s.Status = status
		if _, err := CreateSharedSkill(db, s); err != nil {
			t.Fatal(err)
		}
	}
	mustCreate("approve-a", "1.0.0", "alice", SharedSkillApproved)
	mustCreate("pending-alice", "1.0.0", "alice", SharedSkillPending)
	mustCreate("pending-bob", "1.0.0", "bob", SharedSkillPending)
	mustCreate("rejected-alice", "1.0.0", "alice", SharedSkillRejected)

	// 授权制:approved 需授权才可见,但作者始终可见自己的;未授权者只见自己的。
	vis, err := ListVisibleSharedSkills(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"approve-a":     true, // alice 自己上传的 approved
		"pending-alice": true, "rejected-alice": true,
	}
	for _, s := range vis {
		if !want[s.Name] {
			t.Fatalf("alice sees %s, not expected", s.Name)
		}
		delete(want, s.Name)
	}
	if len(want) != 0 {
		t.Fatalf("missing for alice: %v", want)
	}
	// 授权 approve-a 后 alice 仍可见(作者+授权不冲突)。
	visGranted, err := ListVisibleSharedSkills(db, "alice", []string{"approve-a"})
	if err != nil {
		t.Fatal(err)
	}
	seenApproved := false
	for _, s := range visGranted {
		if s.Name == "approve-a" && s.Status == SharedSkillApproved {
			seenApproved = true
		}
	}
	if !seenApproved {
		t.Fatalf("granted alice does not see approve-a")
	}

	all, err := ListSharedSkills(db, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 4 {
		t.Fatalf("admin list = %d, want 4", len(all))
	}
	pending, err := ListSharedSkills(db, "pending")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending list = %d, want 2", len(pending))
	}
}

func TestSharedSkillCappedAtomically(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		s := newSharedSkill(fmt.Sprintf("cap-%d", i), "1.0.0", "alice")
		if _, err := CreateSharedSkillCapped(db, s, 2); err != nil {
			t.Fatalf("create %d: %v", i, err)
		}
	}
	s := newSharedSkill("cap-over", "1.0.0", "alice")
	if _, err := CreateSharedSkillCapped(db, s, 2); err != ErrTooManyPending {
		t.Fatalf("over cap = %v, want ErrTooManyPending", err)
	}
	// Same name new version not blocked by cap (different row keys).
	s2 := newSharedSkill("cap-over", "1.1.0", "alice")
	if _, err := CreateSharedSkillCapped(db, s2, 2); err != ErrTooManyPending {
		t.Fatalf("second row same author = %v, want ErrTooManyPending", err)
	}
	// Another author unaffected.
	b := newSharedSkill("bob-one", "1.0.0", "bob")
	if _, err := CreateSharedSkillCapped(db, b, 2); err != nil {
		t.Fatalf("bob create: %v", err)
	}
}

func TestSharedSkillQuality(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	// 0037 quality 列:仅 approved 行可设置;非法值拒绝。
	s := newSharedSkill("qual", "1.0.0", "alice")
	if _, err := CreateSharedSkill(db, s); err != nil {
		t.Fatal(err)
	}
	// pending 行设置 quality -> ErrNotFound(仅 approved 可标记)。
	if err := SetSharedSkillQuality(db, "qual", "1.0.0", "official"); err != ErrNotFound {
		t.Fatalf("quality on pending = %v, want ErrNotFound", err)
	}
	if err := SetSharedSkillStatus(db, "qual", "1.0.0", SharedSkillApproved, ""); err != nil {
		t.Fatal(err)
	}
	if err := SetSharedSkillQuality(db, "qual", "1.0.0", "official"); err != nil {
		t.Fatalf("set official: %v", err)
	}
	// 非法 quality -> ErrValidation。
	if err := SetSharedSkillQuality(db, "qual", "1.0.0", "pro"); err != ErrValidation {
		t.Fatalf("bad quality = %v, want ErrValidation", err)
	}
	// approved 行读取 quality。
	got, err := GetSharedSkill(db, "qual", "1.0.0")
	if err != nil || got.Quality != "official" {
		t.Fatalf("row = %+v err=%v", got, err)
	}
	// 清除(空串)。
	if err := SetSharedSkillQuality(db, "qual", "1.0.0", ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _ = GetSharedSkill(db, "qual", "1.0.0")
	if got.Quality != "" {
		t.Fatalf("after clear quality=%q", got.Quality)
	}
	// 不存在版本 -> ErrNotFound。
	if err := SetSharedSkillQuality(db, "nope", "1.0.0", "official"); err != ErrNotFound {
		t.Fatalf("missing = %v, want ErrNotFound", err)
	}
}
