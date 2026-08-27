package serverstore

import (
	"errors"
	"testing"
)

func TestSkills(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := AddSkill(db, &Skill{
		Name: "demo", Version: "1.0.0", Description: "demo skill",
		Author: "pico", GitURL: "https://example.com/demo.git", GitRef: "main", Enabled: 1, Source: "git",
	})
	if err != nil || id == 0 {
		t.Fatalf("AddSkill: id=%d err=%v", id, err)
	}
	if _, err := AddSkill(db, &Skill{Name: "demo", Version: "2.0.0", GitURL: "x"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("duplicate AddSkill err = %v, want ErrDuplicate", err)
	}

	s, err := GetSkill(db, "demo")
	if err != nil {
		t.Fatal(err)
	}
	if s.Version != "1.0.0" || s.Enabled != 1 || s.Description != "demo skill" {
		t.Fatalf("GetSkill = %+v", s)
	}

	s.Version = "1.1.0"
	s.GitRef = "dev"
	if err := UpdateSkill(db, s); err != nil {
		t.Fatal(err)
	}
	s, _ = GetSkill(db, "demo")
	if s.Version != "1.1.0" || s.GitRef != "dev" {
		t.Fatalf("after update = %+v", s)
	}

	if _, err := AddSkill(db, &Skill{Name: "off", Version: "1.0.0", GitURL: "x", Source: "git"}); err != nil {
		t.Fatal(err)
	}
	if _, err := SetSkillEnabled(db, "off", false); err != nil {
		t.Fatal(err)
	}
	list, err := ListSkills(db, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 1 || list[0].Name != "demo" {
		t.Fatalf("enabled list = %+v", list)
	}
	all, err := ListSkills(db, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 2 {
		t.Fatalf("all list = %+v", all)
	}
}

// TestSkillUploadArchive: 0040 upload mode — ReplaceSkillArchive switches the
// row to Source=upload, stores the blob, clears git fields; GetSkill returns
// the archive; increments work on name only.
func TestSkillUploadArchive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := AddSkill(db, &Skill{Name: "up", Version: "0.1.0", GitURL: "https://example.com/up.git", GitRef: "main", Enabled: 1, Source: "git"}); err != nil {
		t.Fatal(err)
	}
	blob := []byte("fake-gzip-tar")
	if err := ReplaceSkillArchive(db, "up", "1.0.0", "abc123", blob); err != nil {
		t.Fatal(err)
	}
	s, err := GetSkill(db, "up")
	if err != nil {
		t.Fatal(err)
	}
	if s.Source != "upload" || string(s.Archive) != string(blob) || s.Checksum != "abc123" || s.Version != "1.0.0" {
		t.Fatalf("after replace = %+v", s)
	}
	if s.GitURL != "" || s.GitRef != "" {
		t.Fatalf("git fields should be cleared, got %+v", s)
	}
	// ListSkills (list columns) must not load the blob.
	list, err := ListSkills(db, false)
	if err != nil || len(list) != 1 || len(list[0].Archive) != 0 {
		t.Fatalf("list = %+v err=%v (blob must be excluded)", list, err)
	}
	// Download counter increments.
	if ok, err := IncrementSkillDownload(db, "up"); err != nil || !ok {
		t.Fatalf("download inc: ok=%v err=%v", ok, err)
	}
	s, _ = GetSkill(db, "up")
	if s.Downloads != 1 {
		t.Fatalf("downloads = %d, want 1", s.Downloads)
	}
	// Call counter targets shared first then market by name.
	if ok, err := IncrementSkillCall(db, "up", ""); err != nil || !ok {
		t.Fatalf("call inc: ok=%v err=%v", ok, err)
	}
	s, _ = GetSkill(db, "up")
	if s.Calls != 1 {
		t.Fatalf("calls = %d, want 1", s.Calls)
	}
	// Unknown name: no row matched, no error.
	if ok, err := IncrementSkillCall(db, "nope", ""); err != nil || ok {
		t.Fatalf("unknown call: ok=%v err=%v", ok, err)
	}
}

// TestSkillUpdateKeepsArchive: UpdateSkill must preserve the archive blob
// when the updater does not carry it (git-mode metadata edit on upload row).
func TestSkillUpdateKeepsArchive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := AddSkill(db, &Skill{Name: "up2", Version: "0.1.0", GitURL: "x", GitRef: "main", Enabled: 1, Source: "git"}); err != nil {
		t.Fatal(err)
	}
	blob := []byte("data")
	if err := ReplaceSkillArchive(db, "up2", "1.0.0", "sum", blob); err != nil {
		t.Fatal(err)
	}
	s, _ := GetSkill(db, "up2")
	s.Description = "edited"
	if err := UpdateSkill(db, s); err != nil {
		t.Fatal(err)
	}
	s, _ = GetSkill(db, "up2")
	if s.Description != "edited" || string(s.Archive) != string(blob) {
		t.Fatalf("after update = %+v", s)
	}
}
