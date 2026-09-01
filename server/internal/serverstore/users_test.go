package serverstore

import (
	"errors"
	"sync"
	"testing"
	"time"
)

func TestUsers(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateUser(db, &User{Username: "alice", DisplayName: "Alice", Source: "local", IsAdmin: true, Status: 1})
	if err != nil {
		t.Fatalf("CreateUser: %v", err)
	}
	if id == 0 {
		t.Fatal("id = 0")
	}

	// duplicate username
	if _, err := CreateUser(db, &User{Username: "alice", Source: "local"}); !errors.Is(err, ErrDuplicate) {
		t.Fatalf("want ErrDuplicate, got %v", err)
	}

	u, err := GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatalf("GetUserByUsername: %v", err)
	}
	if u.Username != "alice" || u.DisplayName != "Alice" || !u.IsAdmin || u.Status != 1 {
		t.Fatalf("user mismatch: %+v", u)
	}
	if u.CreatedAt.IsZero() {
		t.Fatal("created_at not parsed")
	}

	// update
	u.DisplayName = "Alice2"
	u.Status = 0
	if err := UpdateUser(db, u); err != nil {
		t.Fatalf("UpdateUser: %v", err)
	}
	u2, _ := GetUserByUsername(db, "alice")
	if u2.DisplayName != "Alice2" || u2.Status != 0 {
		t.Fatalf("update not applied: %+v", u2)
	}

	// not found
	if _, err := GetUserByUsername(db, "nobody"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("want ErrNotFound, got %v", err)
	}

	// pagination
	for i := 0; i < 5; i++ {
		CreateUser(db, &User{Username: "u" + string(rune('a'+i)), Source: "local"})
	}
	users, total, err := ListUsers(db, 0, 3, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 3 || total != 6 {
		t.Fatalf("list: len=%d total=%d", len(users), total)
	}

	// search filter
	users, total, err = ListUsers(db, 0, 20, "ali")
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || users[0].Username != "alice" {
		t.Fatalf("search: total=%d users=%+v", total, users)
	}
}

func TestAuthenticateLocal(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateUserWithPassword(db, "bob", "pw123456"); err != nil {
		t.Fatal(err)
	}
	u, err := GetUserByUsername(db, "bob")
	if err != nil {
		t.Fatal(err)
	}
	if u.PasswordHash == "" || u.PasswordHash == "pw123456" {
		t.Fatal("password not hashed")
	}
	if _, err := AuthenticateLocal(db, "bob", "pw123456"); err != nil {
		t.Fatalf("correct password rejected: %v", err)
	}
	if _, err := AuthenticateLocal(db, "bob", "bad"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("wrong password: want ErrNotFound got %v", err)
	}
	if _, err := AuthenticateLocal(db, "nobody", "pw123456"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user: want ErrNotFound got %v", err)
	}
}

func TestDeleteUserWithReferencedRows(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	id, err := CreateUserWithPassword(db, "carol", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	// 一个登录用户必然持有:api_token、usage、admin_session、user_groups
	if _, err := CreateToken(db, id, "raw-token", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := RecordUsage(db, id, "m", 1, 2); err != nil {
		t.Fatal(err)
	}
	adminSessID := "session-" + time.Now().Format("150405")
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at) VALUES (?, ?, ?, ?)`,
		adminSessID, id, "csrf", time.Now().Add(time.Hour).UTC().Format(time.RFC3339)); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, id, []string{"g1"}); err != nil {
		t.Fatal(err)
	}

	if err := DeleteUser(db, id); err != nil {
		t.Fatalf("DeleteUser with referenced rows failed: %v", err)
	}
	// 用户及其全部关联行都应消失
	if _, err := GetUserByID(db, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user still present: %v", err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM api_tokens WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("tokens left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM usage WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("usage left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM admin_sessions WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("sessions left: %d err=%v", n, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM user_groups WHERE user_id = ?", id).Scan(&n); err != nil || n != 0 {
		t.Fatalf("user_groups left: %d err=%v", n, err)
	}
}

// 审计修复 2026-P (H1): 0036 共享资源授权(user 级)必须随用户删除级联,
// 同名用户重建不得继承上一同名用户对共享技能/Agent 的授权。
func TestDeleteUserCascadesSharedGrants(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	id, err := CreateUserWithPassword(db, "grace", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	// shared_skill_grants 资源列 = skill_name;agent_preset_grants = preset_name
	for _, tbl := range []struct{ table, col string }{
		{"shared_skill_grants", "skill_name"},
		{"agent_preset_grants", "preset_name"},
	} {
		if _, err := db.Exec("INSERT INTO "+tbl.table+" ("+tbl.col+", grantee_type, grantee) VALUES (?, 'user', ?)", "acme", "grace"); err != nil {
			t.Fatalf("seed %s: %v", tbl.table, err)
		}
	}
	if err := DeleteUser(db, id); err != nil {
		t.Fatalf("DeleteUser with shared grants failed: %v", err)
	}
	// P2:三张授权表已合并为 app_grants(kind 区分技能/智能体)。
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM app_grants WHERE grantee = 'grace'").Scan(&n); err != nil || n != 0 {
		t.Fatalf("app_grants grants left after delete: %d err=%v", n, err)
	}
}

// C-17: deleting the last admin rolls the delete back (guard lives inside the
// transaction, so the count-then-delete TOCTOU is closed).
func TestDeleteUserLastAdminGuard(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	aID, err := CreateUserWithPassword(db, "adminA", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	bID, err := CreateUserWithPassword(db, "adminB", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{aID, bID} {
		u, _ := GetUserByID(db, id)
		u.IsAdmin = true
		if err := UpdateUser(db, u); err != nil {
			t.Fatal(err)
		}
	}
	if err := DeleteUser(db, aID); err != nil {
		t.Fatalf("delete adminA with adminB left: %v", err)
	}
	if err := DeleteUser(db, bID); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("last admin delete err = %v, want ErrLastAdmin", err)
	}
	if _, err := GetUserByUsername(db, "adminB"); err != nil {
		t.Fatalf("last admin wrongly deleted: %v", err)
	}
}

// C-17b: the same guard survives a double-delete race — exactly one of the
// two concurrent deletes wins and at least one admin remains.
func TestDeleteUserLastAdminConcurrent(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	ids := make([]int64, 2)
	for i, name := range []string{"adminX", "adminY"} {
		id, err := CreateUserWithPassword(db, name, "pw123456")
		if err != nil {
			t.Fatal(err)
		}
		u, _ := GetUserByID(db, id)
		u.IsAdmin = true
		if err := UpdateUser(db, u); err != nil {
			t.Fatal(err)
		}
		ids[i] = id
	}
	start := make(chan struct{})
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(i int, id int64) {
			defer wg.Done()
			<-start
			errs[i] = DeleteUser(db, id)
		}(i, id)
	}
	close(start)
	wg.Wait()

	ok := 0
	for _, e := range errs {
		if e == nil {
			ok++
		}
	}
	if ok != 1 {
		t.Fatalf("successful deletes = %d, want exactly 1 (errs=%v)", ok, errs)
	}
	var admins int
	if err := db.QueryRow("SELECT COUNT(*) FROM users WHERE is_admin = 1").Scan(&admins); err != nil {
		t.Fatal(err)
	}
	if admins != 1 {
		t.Fatalf("admins left = %d, want 1", admins)
	}
}

// 0017: quota_tokens tri-state — nil (follow global) / 0 (unlimited) / >0 (cap).
func TestUserQuotaTriState(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	i64p := func(n int64) *int64 { return &n }

	id, err := CreateUser(db, &User{Username: "quota-tri", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	u, _ := GetUserByID(db, id)
	if u.QuotaTokens != nil {
		t.Fatalf("default quota_tokens = %d, want nil (follow global)", *u.QuotaTokens)
	}

	u.QuotaTokens = i64p(0) // explicit unlimited
	if err := UpdateUser(db, u); err != nil {
		t.Fatal(err)
	}
	u2, _ := GetUserByID(db, id)
	if u2.QuotaTokens == nil || *u2.QuotaTokens != 0 {
		t.Fatalf("unlimited quota_tokens = %v, want 0", u2.QuotaTokens)
	}

	u2.QuotaTokens = i64p(5000) // explicit cap
	if err := UpdateUser(db, u2); err != nil {
		t.Fatal(err)
	}
	u3, _ := GetUserByID(db, id)
	if u3.QuotaTokens == nil || *u3.QuotaTokens != 5000 {
		t.Fatalf("capped quota_tokens = %v, want 5000", u3.QuotaTokens)
	}

	u3.QuotaTokens = nil // back to follow-global
	if err := UpdateUser(db, u3); err != nil {
		t.Fatal(err)
	}
	u4, _ := GetUserByID(db, id)
	if u4.QuotaTokens != nil {
		t.Fatalf("nil quota_tokens read back as %d, want nil", *u4.QuotaTokens)
	}
}

func TestSettings(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	if _, ok, err := GetSetting(db, "a"); err != nil || ok {
		t.Fatalf("missing key: ok=%v err=%v", ok, err)
	}
	if err := SetSetting(db, "a", "1"); err != nil {
		t.Fatal(err)
	}
	// overwrite
	if err := SetSetting(db, "a", "2"); err != nil {
		t.Fatal(err)
	}
	v, ok, err := GetSetting(db, "a")
	if err != nil || !ok || v != "2" {
		t.Fatalf("get: %q ok=%v err=%v", v, ok, err)
	}
	if err := SetSetting(db, "b", "x"); err != nil {
		t.Fatal(err)
	}
	all, err := GetAllSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	if all["a"] != "2" || all["b"] != "x" || len(all) != 2 {
		t.Fatalf("all: %v", all)
	}
}

// 删除担任部门主管的用户:groups.leader_id 必须清零(审计 M1),
// 否则残留悬空主管 → 该部门后续任何 UpdateDepartment 都报「主管不存在」。
func TestDeleteUserClearsDeptLeadership(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	leadID, err := CreateUserWithPassword(db, "lead", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	deptID, err := CreateDepartment(db, "研发部", 0, leadID, "")
	if err != nil {
		t.Fatal(err)
	}
	// 删除主管
	if err := DeleteUser(db, leadID); err != nil {
		t.Fatalf("delete leader user: %v", err)
	}
	var leaderID int64
	if err := db.QueryRow("SELECT leader_id FROM groups WHERE id = ?", deptID).Scan(&leaderID); err != nil {
		t.Fatal(err)
	}
	if leaderID != 0 {
		t.Fatalf("groups.leader_id = %d after leader delete, want 0", leaderID)
	}
	// 部门仍可正常更新(不再被悬空主管卡死)
	if err := UpdateDepartment(db, deptID, "技术中心", 0, 0, ""); err != nil {
		t.Fatalf("update dept after leader delete: %v", err)
	}
}

// 用户名搜索必须转义 LIKE 通配符(审计 L5):搜 "%"/"_" 不得匹配全部/任意单字符
func TestListUsersEscapesLikeWildcards(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alice_1", "bob1", "100%", "carol"} {
		if _, err := CreateUserWithPassword(db, name, "pw123456"); err != nil {
			t.Fatal(err)
		}
	}
	// 搜 "%" → 只应命中含字面 % 的 "100%"
	users, total, err := ListUsers(db, 0, 20, "%")
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || len(users) != 1 || users[0].Username != "100%" {
		t.Fatalf("search '%%' total=%d users=%+v, want only 100%%", total, users)
	}
	// 搜 "_" → 不应命中任意单字符(alice_1 含字面下划线,可命中)
	users, total, err = ListUsers(db, 0, 20, "_")
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 || users[0].Username != "alice_1" {
		t.Fatalf("search '_' total=%d users=%+v, want only alice_1", total, users)
	}
	// 搜 "1" 正常子串仍命中(alice_1/bob1/100% 都含 '1')
	users, total, err = ListUsers(db, 0, 20, "1")
	if err != nil {
		t.Fatal(err)
	}
	if total != 3 {
		t.Fatalf("search '1' total=%d, want 3 (alice_1, bob1, 100%%)", total)
	}
}

func TestParseSQLTimeLocalZone(t *testing.T) {
	// 数据库写 datetime('now','localtime') 无时区串;解析必须按本地时区,
	// 否则 CST(+08:00) 下 time.Since 为负,孤儿文档回收等按年龄的逻辑失效。
	orig := time.Local
	loc, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skipf("no Asia/Shanghai tzdata: %v", err)
	}
	time.Local = loc
	defer func() { time.Local = orig }()

	now := time.Now()
	got := parseSQLTime(now.Format(sqlTimeFormat))
	if got.Location() != loc {
		t.Fatalf("parseSQLTime location = %v, want %v", got.Location(), loc)
	}
	if d := now.Sub(got); d > 2*time.Second || d < -2*time.Second {
		t.Fatalf("parseSQLTime(%q) = %v, now.Sub = %v, want ~0", now.Format(sqlTimeFormat), got, d)
	}
	if !got.Equal(now) && !got.After(now.Add(-2*time.Second)) {
		t.Fatalf("parseSQLTime(%q) = %v, want near %v", now.Format(sqlTimeFormat), got, now)
	}

	// RFC3339 带时区串不受 local 影响
	rfc, err := time.Parse(time.RFC3339, "2026-08-01T12:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	gotRFC := parseSQLTime(rfc.Format(time.RFC3339))
	if !gotRFC.Equal(rfc) {
		t.Fatalf("parseSQLTime RFC3339 = %v, want %v", gotRFC, rfc)
	}
}
