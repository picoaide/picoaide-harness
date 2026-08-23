package serverstore

import (
	"testing"
)

func TestGroups(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	gid, err := GetOrCreateGroup(db, "devs")
	if err != nil || gid == 0 {
		t.Fatalf("GetOrCreateGroup: %v %v", gid, err)
	}
	gid2, err := GetOrCreateGroup(db, "devs")
	if err != nil || gid2 != gid {
		t.Fatalf("second GetOrCreateGroup: %v %v", gid2, err)
	}

	uid, err := CreateUser(db, &User{Username: "grpuser", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, uid, []string{"devs", "ops"}); err != nil {
		t.Fatal(err)
	}
	got, err := UserGroups(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "devs" || got[1] != "ops" {
		t.Fatalf("groups = %v", got)
	}
	// resync replaces
	if err := SyncUserGroups(db, uid, []string{"ops"}); err != nil {
		t.Fatal(err)
	}
	got, _ = UserGroups(db, uid)
	if len(got) != 1 || got[0] != "ops" {
		t.Fatalf("after resync groups = %v", got)
	}
}

func TestUserGroupsBatch(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	aID, _ := CreateUserWithPassword(db, "alice", "pw123456")
	bID, _ := CreateUserWithPassword(db, "bob", "pw123456")
	if err := SyncUserGroups(db, aID, []string{"研发部", "安全组"}); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, bID, []string{"人事部"}); err != nil {
		t.Fatal(err)
	}
	users := []User{{ID: aID}, {ID: bID}}
	got, err := UserGroupsBatch(db, users)
	if err != nil {
		t.Fatal(err)
	}
	if len(got[aID]) != 2 || got[aID][0] != "安全组" || got[aID][1] != "研发部" {
		t.Fatalf("alice groups = %v", got[aID])
	}
	if len(got[bID]) != 1 || got[bID][0] != "人事部" {
		t.Fatalf("bob groups = %v", got[bID])
	}
}
