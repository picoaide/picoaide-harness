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
		Author: "pico", GitURL: "https://example.com/demo.git", GitRef: "main", Enabled: 1,
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

	if _, err := AddSkill(db, &Skill{Name: "off", Version: "1.0.0", GitURL: "x"}); err != nil {
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
