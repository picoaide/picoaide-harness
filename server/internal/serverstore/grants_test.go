package serverstore

import (
	"testing"
)

func TestSkillGrantsLifecycle(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	// grant user + group (idempotent)
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	// '@' prefix is stripped (webadmin convention)
	if err := GrantSkill(db, "data-extract", "@bob", GranteeUser); err != nil {
		t.Fatal(err)
	}

	grants, err := ListSkillGrants(db, "data-extract")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 3 {
		t.Fatalf("grants = %+v, want 3", grants)
	}

	// accessible: direct user + group membership
	names, err := AccessibleSkillNames(db, "alice", []string{"研发部"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "data-extract" {
		t.Fatalf("accessible = %v", names)
	}
	// group-only access
	names, err = AccessibleSkillNames(db, "carl", []string{"研发部"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("group member accessible = %v", names)
	}
	// no grants at all → empty (strict default)
	names, err = AccessibleSkillNames(db, "nobody", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("strict default violated: %v", names)
	}

	// revoke: takes effect immediately
	if err := RevokeSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	names, err = AccessibleSkillNames(db, "alice", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 0 {
		t.Fatalf("after revoke alice still sees: %v", names)
	}

	// invalid grantee rejected
	if err := GrantSkill(db, "data-extract", "", GranteeUser); err != ErrValidation {
		t.Fatalf("empty grantee err = %v, want ErrValidation", err)
	}
	if err := GrantSkill(db, "data-extract", "a/b", GranteeUser); err != ErrValidation {
		t.Fatalf("path grantee err = %v, want ErrValidation", err)
	}

	// delete cascades (no resurrection on re-create)
	if err := DeleteSkillGrants(db, "data-extract"); err != nil {
		t.Fatal(err)
	}
	grants, _ = ListSkillGrants(db, "data-extract")
	if len(grants) != 0 {
		t.Fatalf("grants survived delete: %+v", grants)
	}
}

// 组名大小写归一:授权 "Finance",用户组 "finance" 必须解析到
func TestGrantGroupCaseInsensitive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "Finance", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	names, err := AccessibleSkillNames(db, "alice", []string{"finance"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "data-extract" {
		t.Fatalf("case-insensitive group grant failed: %v", names)
	}
	// GetOrCreateGroup 不新建大小写变体
	gid, err := GetOrCreateGroup(db, "FINANCE")
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM groups WHERE LOWER(name) = LOWER('finance')").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("groups rows = %d, want 1 (no casing variant)", count)
	}
	_ = gid
}

// 整组替换:多部门批量授权,原子替换组授权(用户授权保留)
func TestReplaceGroupGrants(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "人事部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	// 用户授权不受整组替换影响
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	// 多部门授权(共享)
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{"研发部", "人事部"}); err != nil {
		t.Fatal(err)
	}
	groups, err := ListSkillGrants(db, "data-extract")
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 3 { // 2 部门 + 1 用户
		t.Fatalf("grants = %+v", groups)
	}
	// 两部门成员都可见(共享,无需重复上传)
	names, _ := AccessibleSkillNames(db, "dev", []string{"研发部"})
	if len(names) != 1 || names[0] != "data-extract" {
		t.Fatalf("dev member: %v", names)
	}
	names, _ = AccessibleSkillNames(db, "hr", []string{"人事部"})
	if len(names) != 1 {
		t.Fatalf("hr member: %v", names)
	}
	// 整组替换(移除人事部)
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	groups, _ = ListSkillGrants(db, "data-extract")
	if len(groups) != 2 { // 研发部 + 用户
		t.Fatalf("after replace grants = %+v", groups)
	}
	names, _ = AccessibleSkillNames(db, "hr", []string{"人事部"})
	if len(names) != 0 {
		t.Fatalf("hr member still sees: %v", names)
	}
	// 不存在的部门 → ErrNotFound(防拼错)
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{"不存在的部门"}); err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	// 空列表 = 清空组授权
	if err := ReplaceSkillGroupGrants(db, "data-extract", nil); err != nil {
		t.Fatal(err)
	}
	groups, _ = ListSkillGrants(db, "data-extract")
	if len(groups) != 1 || groups[0].Grantee != "alice" {
		t.Fatalf("after clear grants = %+v", groups)
	}
}

// 审计 A5-L9: 整组替换校验与写入同事务 —— 部门不存在时失败且既有授权不被清空
// (无 TOCTOU 窗口,不留孤儿授权行)。
func TestReplaceGroupGrantsRollbackOnUnknownDept(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	// 替换为「研发部 + 不存在的部门」:整组失败,研发部授权必须原样保留
	err := ReplaceSkillGroupGrants(db, "data-extract", []string{"研发部", "幽灵部门"})
	if err != ErrNotFound {
		t.Fatalf("err = %v, want ErrNotFound", err)
	}
	groups, _ := ListSkillGrants(db, "data-extract")
	if len(groups) != 2 { // 研发部 + alice
		t.Fatalf("grants after failed replace = %+v, want intact", groups)
	}
	// 重复/空名同样被拒(事务内校验)
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{"研发部", "研发部"}); err != ErrValidation {
		t.Fatalf("duplicate dept err = %v, want ErrValidation", err)
	}
	if err := ReplaceSkillGroupGrants(db, "data-extract", []string{""}); err != ErrValidation {
		t.Fatalf("empty dept err = %v, want ErrValidation", err)
	}
}

func TestSharedResourceGrantsLifecycle(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	// Grant a shared skill to a user + a group (idempotent).
	if err := GrantSharedResource(db, SharedSkillGrantTable, "codeql", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	if err := GrantSharedResource(db, SharedSkillGrantTable, "codeql", "@研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	grants, err := ListSharedResourceGrants(db, SharedSkillGrantTable, "codeql")
	if err != nil {
		t.Fatal(err)
	}
	if len(grants) != 2 || grants[0].Grantee != "研发部" || grants[1].Grantee != "alice" {
		t.Fatalf("grants = %+v", grants)
	}

	// Accessible by direct user and by group membership.
	names, err := AccessibleSharedResourceNames(db, SharedSkillGrantTable, "alice", nil)
	if err != nil || len(names) != 1 || names[0] != "codeql" {
		t.Fatalf("alice names = %v err=%v", names, err)
	}
	names, err = AccessibleSharedResourceNames(db, SharedSkillGrantTable, "bob", []string{"研发部"})
	if err != nil || len(names) != 1 || names[0] != "codeql" {
		t.Fatalf("bob group names = %v err=%v", names, err)
	}
	// Unrelated user sees nothing.
	names, _ = AccessibleSharedResourceNames(db, SharedSkillGrantTable, "charlie", []string{"市场部"})
	if len(names) != 0 {
		t.Fatalf("charlie names = %v, want none", names)
	}

	// Revoke user grant; group grant remains.
	if err := RevokeSharedResource(db, SharedSkillGrantTable, "codeql", "alice", GranteeUser); err != nil {
		t.Fatal(err)
	}
	names, _ = AccessibleSharedResourceNames(db, SharedSkillGrantTable, "alice", nil)
	if len(names) != 0 {
		t.Fatalf("alice after revoke = %v, want none", names)
	}

	// Agent preset grants use their own table (independent namespace).
	if err := GrantSharedResource(db, SharedPresetGrantTable, "ppt-gen", "bob", GranteeUser); err != nil {
		t.Fatal(err)
	}
	pg, _ := ListSharedResourceGrants(db, SharedPresetGrantTable, "ppt-gen")
	if len(pg) != 1 || pg[0].Grantee != "bob" {
		t.Fatalf("preset grants = %+v", pg)
	}
	// Skill grants unaffected.
	skills, _ := ListSharedResourceGrants(db, SharedSkillGrantTable, "codeql")
	if len(skills) != 1 || skills[0].Grantee != "研发部" {
		t.Fatalf("skill grants after preset grant = %+v", skills)
	}

	// Delete cascades.
	if err := DeleteSharedResourceGrants(db, SharedSkillGrantTable, "codeql"); err != nil {
		t.Fatal(err)
	}
	names, _ = AccessibleSharedResourceNames(db, SharedSkillGrantTable, "bob", []string{"研发部"})
	if len(names) != 0 {
		t.Fatalf("names after delete = %v", names)
	}
}
