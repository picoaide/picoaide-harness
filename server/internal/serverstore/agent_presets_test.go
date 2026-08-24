package serverstore

import (
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

	if err := SetAgentPresetStatus(db, "coding-agent", AgentPresetApproved); err != nil {
		t.Fatalf("approve: %v", err)
	}
	p, _ = GetAgentPreset(db, "coding-agent")
	if p.Status != AgentPresetApproved {
		t.Fatalf("status = %q", p.Status)
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
	if err := SetAgentPresetStatus(db, "resubmit-me", AgentPresetRejected); err != nil {
		t.Fatal(err)
	}
	if err := UpdateAgentPresetResubmit(db, "resubmit-me", "新描述", "abc123"); err != nil {
		t.Fatalf("resubmit: %v", err)
	}
	got, err := GetAgentPreset(db, "resubmit-me")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != AgentPresetPending || got.Description != "新描述" || got.Checksum != "abc123" {
		t.Fatalf("resubmit row = %+v", got)
	}
	// 非 rejected 行不满足 resubmit 条件:0 行受影响但不报错
	if err := UpdateAgentPresetResubmit(db, "resubmit-me", "x", "y"); err != nil {
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

	vis, err := ListVisibleAgentPresets(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{
		"approved-a": true, "approved-b": true, // approved: 全员可见
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

func TestAgentPresetStatusValidate(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	// 非法 status 被 CHECK 拒绝
	if _, err := db.Exec(`INSERT INTO agent_presets (name, author, status) VALUES ('x', 'y', 'bogus')`); err == nil {
		t.Fatal("bogus status accepted")
	}
	// 空 author 拒绝(NOT NULL)
	if _, err := db.Exec(`INSERT INTO agent_presets (name, author) VALUES ('x', NULL)`); err == nil {
		t.Fatal("null author accepted")
	}
	if err := ApplyMigrations(db); err != nil {
		t.Fatalf("re-apply (idempotent) failed: %v", err)
	}
}
