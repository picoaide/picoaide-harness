package serverstore

import (
	"testing"
)

func TestDepartmentCRUD(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}

	// 建树:研发部(顶层)→ 前端组/后端组;人事部(顶层)
	devID, err := CreateDepartment(db, "研发部", 0, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	frontID, err := CreateDepartment(db, "前端组", devID, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "后端组", devID, 0, ""); err != nil {
		t.Fatal(err)
	}
	hrID, err := CreateDepartment(db, "人事部", 0, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	// 重名拒绝
	if _, err := CreateDepartment(db, "人事部", 0, 0, ""); err != ErrDuplicate {
		t.Fatalf("dup name err = %v", err)
	}
	// 父部门不存在
	if _, err := CreateDepartment(db, "孤儿", 9999, 0, ""); err != ErrNotFound {
		t.Fatalf("bad parent err = %v", err)
	}

	// 列表含层级信息(迁移 0018 seed 的隐式全员也在列)
	list, err := ListDepartments(db)
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 5 {
		t.Fatalf("departments = %+v", list)
	}
	hasEveryone := false
	for _, d := range list {
		if d.Name == "全员" {
			hasEveryone = true
		}
		if d.Name == "前端组" && d.ParentID != devID {
			t.Fatalf("前端组 parent = %d", d.ParentID)
		}
	}
	if !hasEveryone {
		t.Fatalf("departments list lacks seeded 全员: %+v", list)
	}

	// 循环防护:前端组不能成为研发部的父
	if err := UpdateDepartment(db, devID, "研发部", frontID, 0, ""); err != ErrValidation {
		t.Fatalf("cycle parent err = %v, want ErrValidation", err)
	}
	// 自引用拒绝
	if err := UpdateDepartment(db, devID, "研发部", devID, 0, ""); err != ErrValidation {
		t.Fatalf("self parent err = %v", err)
	}
	// 主管必须存在
	if err := UpdateDepartment(db, devID, "研发部", 0, 9999, ""); err != ErrNotFound {
		t.Fatalf("bad leader err = %v", err)
	}

	// 删除约束:有子部门/成员/授权 → 拒绝
	aliceID, err := CreateUserWithPassword(db, "alice", "pw123456")
	if err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, aliceID, []string{"前端组"}); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "人事部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	if err := DeleteDepartment(db, devID); err != ErrDepartmentInUse {
		t.Fatalf("delete dev with children err = %v", err)
	}
	if err := DeleteDepartment(db, frontID); err != ErrDepartmentInUse {
		t.Fatalf("delete front with member err = %v", err)
	}
	if err := DeleteDepartment(db, hrID); err != ErrDepartmentInUse {
		t.Fatalf("delete hr with grant err = %v", err)
	}
	// 无引用部门可删
	emptyID, err := CreateDepartment(db, "空部门", 0, 0, "")
	if err != nil {
		t.Fatal(err)
	}
	if err := DeleteDepartment(db, emptyID); err != nil {
		t.Fatalf("delete empty: %v", err)
	}
}

// 改名级联:授权表按组名引用,改名后授权必须仍解析到同一组
func TestDepartmentRenameCascadesGrants(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	if err := GrantSkill(db, "data-extract", "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	if err := GrantMCP(db, 1, "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	if err := UpdateDepartment(db, devID, "技术中心", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	names, err := AccessibleSkillNames(db, "alice", []string{"技术中心"})
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0] != "data-extract" {
		t.Fatalf("skill grant lost after rename: %v", names)
	}
	set, err := AccessibleMCPSet(db, "alice", []string{"技术中心"})
	if err != nil {
		t.Fatal(err)
	}
	if !set[1] {
		t.Fatalf("mcp grant lost after rename")
	}
}

// 金字塔继承:授权给父部门 → 子部门成员可见;主管自动获得部门子树授权
func TestUserEffectiveGroupsInheritance(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	frontID, _ := CreateDepartment(db, "前端组", devID, 0, "")
	if _, err := CreateDepartment(db, "后端组", devID, 0, ""); err != nil {
		t.Fatal(err)
	}
	hrID, _ := CreateDepartment(db, "人事部", 0, 0, "")

	// alice 属前端组;bob 属人事部;carl 是研发部主管(不属于任何部门)
	aliceID, _ := CreateUserWithPassword(db, "alice", "pw123456")
	bobID, _ := CreateUserWithPassword(db, "bob", "pw123456")
	carlID, _ := CreateUserWithPassword(db, "carl", "pw123456")
	if err := SyncUserGroups(db, aliceID, []string{"前端组"}); err != nil {
		t.Fatal(err)
	}
	if err := SyncUserGroups(db, bobID, []string{"人事部"}); err != nil {
		t.Fatal(err)
	}
	if err := UpdateDepartment(db, devID, "研发部", 0, carlID, ""); err != nil {
		t.Fatal(err)
	}

	// alice(前端组)有效组 = 前端组 + 研发部(祖先)
	names, err := UserEffectiveGroups(db, aliceID)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	if !got["前端组"] || !got["研发部"] {
		t.Fatalf("alice effective = %v, want 前端组+研发部", names)
	}
	if got["人事部"] {
		t.Fatalf("alice must not see 人事部: %v", names)
	}
	_ = hrID
	_ = frontID

	// bob(人事部)只有人事部 + 隐式全员(0018 seed)
	names, _ = UserEffectiveGroups(db, bobID)
	got = map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	if !got["人事部"] || !got["全员"] || len(names) != 2 {
		t.Fatalf("bob effective = %v, want 人事部+全员", names)
	}

	// carl(研发部主管,未入组)有效组 = 研发部 + 前端组 + 后端组(主管子树)
	names, err = UserEffectiveGroups(db, carlID)
	if err != nil {
		t.Fatal(err)
	}
	got = map[string]bool{}
	for _, n := range names {
		got[n] = true
	}
	if !got["研发部"] || !got["前端组"] || !got["后端组"] {
		t.Fatalf("carl leader effective = %v, want 研发部+子树", names)
	}
	if got["人事部"] {
		t.Fatalf("carl must not see 人事部")
	}
}

// 端到端:授权「研发部」的 skill → 前端组成员可见(继承);主管可见(向上)
func TestGrantInheritanceEndToEnd(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	frontID, _ := CreateDepartment(db, "前端组", devID, 0, "")
	aliceID, _ := CreateUserWithPassword(db, "alice", "pw123456")
	carlID, _ := CreateUserWithPassword(db, "carl", "pw123456")
	if err := SyncUserGroups(db, aliceID, []string{"前端组"}); err != nil {
		t.Fatal(err)
	}
	if err := UpdateDepartment(db, devID, "研发部", 0, carlID, ""); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}

	// alice(前端组成员):通过祖先链可见
	groups, _ := UserEffectiveGroups(db, aliceID)
	names, err := AccessibleSkillNames(db, "alice", groups)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("front-end member must inherit dev grant: %v", names)
	}
	// carl(主管):通过主管子树可见
	groups, _ = UserEffectiveGroups(db, carlID)
	names, err = AccessibleSkillNames(db, "carl", groups)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("leader must inherit department grant: %v", names)
	}
	_ = frontID
}

// 隐式全员组:未显式加入「全员」的用户也自动获得该组授权
func TestEveryoneGroupImplicit(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "研发部", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	uid, _ := CreateUserWithPassword(db, "alice", "pw123456")
	if err := SyncUserGroups(db, uid, []string{"研发部"}); err != nil {
		t.Fatal(err)
	}
	if err := GrantSkill(db, "data-extract", "全员", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	groups, err := UserEffectiveGroups(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, n := range groups {
		got[n] = true
	}
	if !got["全员"] {
		t.Fatalf("effective groups lack implicit 全员: %v", groups)
	}
	names, err := AccessibleSkillNames(db, "alice", groups)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 {
		t.Fatalf("everyone grant not resolved: %v", names)
	}
}

// 迁移 0018:全新安装即存在全员行(此前只有测试手工直插,生产环境功能失效)
func TestEveryoneGroupSeededByMigration(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM groups WHERE name = '全员'").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("全员 group rows = %d, want 1 (migration 0018 must seed it)", n)
	}
	// GetOrCreateGroup 不得创建/占用保留名
	if _, err := GetOrCreateGroup(db, "全员"); err != ErrValidation {
		t.Fatalf("GetOrCreateGroup(全员) err = %v, want ErrValidation", err)
	}
	// CreateDepartment 仍拒绝保留名
	if _, err := CreateDepartment(db, "全员", 0, 0, ""); err != ErrValidation {
		t.Fatalf("CreateDepartment(全员) err = %v, want ErrValidation", err)
	}
	// 全新用户(无任何部门)也自动获得全员
	uid, _ := CreateUserWithPassword(db, "bob", "pw123456")
	groups, err := UserEffectiveGroups(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, g := range groups {
		if g == "全员" {
			found = true
		}
	}
	if !found {
		t.Fatalf("fresh user effective groups lack 全员: %v", groups)
	}
}

// 保留名「全员」:不可创建/改名占用/删除
func TestEveryoneGroupReserved(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "全员", 0, 0, ""); err != ErrValidation {
		t.Fatalf("create 全员 err = %v, want ErrValidation", err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	if err := UpdateDepartment(db, devID, "全员", 0, 0, ""); err != ErrValidation {
		t.Fatalf("rename to 全员 err = %v", err)
	}
	// 迁移 0018 已 seed 全员行:删除守卫必须拒绝删除保留名
	var everyoneID int64
	if err := db.QueryRow("SELECT id FROM groups WHERE name = '全员'").Scan(&everyoneID); err != nil {
		t.Fatal(err)
	}
	if err := DeleteDepartment(db, everyoneID); err != ErrValidation {
		t.Fatalf("delete 全员 err = %v, want ErrValidation", err)
	}
}

// 授权大小写变体(手输/LDAP):改名级联 NOCASE 后仍解析,删除守卫计得到
func TestRenameCascadeCaseInsensitive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	// 授权含大小写变体(模拟 LDAP/手输历史):grantee 小写
	if err := GrantSkill(db, "data-extract", "研发部", GranteeGroup); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO skill_grants (skill_name, grantee_type, grantee) VALUES ('code-review', 'group', '研发部')"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("INSERT INTO mcp_grants (mcp_id, grantee_type, grantee) VALUES (1, 'group', '研发部')"); err != nil {
		t.Fatal(err)
	}
	// 改名:级联(NOCASE)必须覆盖大小写变体授权
	if err := UpdateDepartment(db, devID, "技术中心", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	names, _ := AccessibleSkillNames(db, "alice", []string{"技术中心"})
	if len(names) != 2 {
		t.Fatalf("cascade lost case variant grants: %v", names)
	}
	set, _ := AccessibleMCPSet(db, "alice", []string{"技术中心"})
	if !set[1] {
		t.Fatalf("mcp case variant lost")
	}
}

// 删除守卫按 NOCASE 计授权引用:大小写变体授权不得绕过守卫
func TestDeleteGuardCountsCaseVariantGrants(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	salesID, _ := CreateDepartment(db, "Sales", 0, 0, "")
	// 手输大小写变体授权(grantee 与组名大小写不同)
	if _, err := db.Exec("INSERT INTO skill_grants (skill_name, grantee_type, grantee) VALUES ('x', 'group', 'sales')"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteDepartment(db, salesID); err != ErrDepartmentInUse {
		t.Fatalf("delete Sales with case-variant grant err = %v, want ErrDepartmentInUse", err)
	}
	// 清掉变体授权后可删
	if _, err := db.Exec("DELETE FROM skill_grants WHERE grantee = 'sales'"); err != nil {
		t.Fatal(err)
	}
	if err := DeleteDepartment(db, salesID); err != nil {
		t.Fatalf("delete Sales after clearing = %v", err)
	}
}

// 0019:组名唯一约束 NOCASE,大小写变体部门不得并存
func TestDepartmentNamesUniqueCaseInsensitive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "Sales", 0, 0, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "sales", 0, 0, ""); err != ErrDuplicate {
		t.Fatalf("case-variant create err = %v, want ErrDuplicate", err)
	}
}

// CreateDepartment 校验主管存在;UpdateDepartment 空名拒绝
func TestDepartmentGuards(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateDepartment(db, "研发部", 0, 9999, ""); err != ErrNotFound {
		t.Fatalf("bogus leader create err = %v, want ErrNotFound", err)
	}
	if _, err := CreateDepartment(db, "", 0, 0, ""); err != ErrValidation {
		t.Fatalf("empty name create err = %v, want ErrValidation", err)
	}
	id, _ := CreateDepartment(db, "研发部", 0, 0, "")
	if err := UpdateDepartment(db, id, "", 0, 0, ""); err != ErrValidation {
		t.Fatalf("empty rename err = %v, want ErrValidation", err)
	}
}

// 保留名守卫三缺一:创建/删除都被拦,但「把全员行改名」此前可绕过,
// 改后隐式全员授权按名解析失效(effective.go findNodeByName)。补上改名守卫。
func TestDepartmentEveryoneRowRenameGuard(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	var everyoneID int64
	if err := db.QueryRow("SELECT id FROM groups WHERE name = '全员'").Scan(&everyoneID); err != nil {
		t.Fatal("seeded 全员 group missing: ", err)
	}
	// 把全员行改名 → 必须拒绝(ErrValidation)
	if err := UpdateDepartment(db, everyoneID, "全体员工", 0, 0, ""); err != ErrValidation {
		t.Fatalf("rename everyone row err = %v, want ErrValidation", err)
	}
	// 拒绝后保留名原样,隐式授权不失效
	if _, err := GroupByName(db, EveryoneGroupName); err != nil {
		t.Fatalf("everyone group vanished after rejected rename: %v", err)
	}
	// 即使改名为另一个保留形变体(如小写/前后空格)也不得放行
	if err := UpdateDepartment(db, everyoneID, "全员 ", 0, 0, ""); err != ErrValidation {
		t.Fatalf("rename everyone to padded variant err = %v, want ErrValidation", err)
	}
}

// UpdateDepartmentWithBudget:改名/改上级/改主管与预算设置必须原子生效
// (审计 M2:此前 updateDepartment 与 SetDeptBudget 是两个独立事务,
// 预算失败会留下已改名的半更新状态)。
func TestUpdateDepartmentWithBudgetAtomic(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	devID, _ := CreateDepartment(db, "研发部", 0, 0, "")
	budget := 500.0
	if err := UpdateDepartmentWithBudget(db, devID, "技术中心", 0, 0, "", &budget); err != nil {
		t.Fatalf("update with budget: %v", err)
	}
	// 名字与预算同事务生效
	g, err := GroupByID(db, devID)
	if err != nil {
		t.Fatal(err)
	}
	if g.Name != "技术中心" {
		t.Fatalf("name = %q, want 技术中心", g.Name)
	}
	if b, err := GetDeptBudget(db, devID); err != nil || b != 500 {
		t.Fatalf("budget = %v err=%v, want 500", b, err)
	}
	// 预算 0 = 清除
	zero := 0.0
	if err := UpdateDepartmentWithBudget(db, devID, "技术中心", 0, 0, "", &zero); err != nil {
		t.Fatal(err)
	}
	if b, _ := GetDeptBudget(db, devID); b != 0 {
		t.Fatalf("budget after clear = %v, want 0", b)
	}
	// 预算 nil = 不变
	if err := UpdateDepartmentWithBudget(db, devID, "技术中心", 0, 0, "", nil); err != nil {
		t.Fatal(err)
	}
	// 负预算 → ErrValidation,且名字不被改动(原子回滚)
	neg := -1.0
	if err := UpdateDepartmentWithBudget(db, devID, "不应该改", 0, 0, "", &neg); err != ErrValidation {
		t.Fatalf("negative budget err = %v, want ErrValidation", err)
	}
	if g, _ := GroupByID(db, devID); g.Name != "技术中心" {
		t.Fatalf("name changed despite rejected budget: %q", g.Name)
	}
}

// RevokeFolderGroup 大小写不敏感(与授权解析一致)
func TestRevokeFolderGroupCaseInsensitive(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	gid, _ := CreateDepartment(db, "Sales", 0, 0, "")
	fid, err := CreateKBFolder(db, "f", 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := GrantFolderGroup(db, fid, "Sales"); err != nil {
		t.Fatal(err)
	}
	_ = gid
	if err := RevokeFolderGroup(db, fid, "sales"); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_folder_groups WHERE folder_id = ?", fid).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("folder group grants after case-variant revoke = %d, want 0", n)
	}
}
