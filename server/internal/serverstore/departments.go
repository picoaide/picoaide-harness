package serverstore

import (
	"database/sql"
	"errors"
)

// ciColumnCmp returns a case-insensitive equality comparison between two
// columns (not a bound parameter). Unlike CaseInsensitiveCmp, both sides are
// column references (e.g. sg.grantee = g.name inside a correlated subquery),
// so there is no `?` placeholder. SQLite uses COLLATE NOCASE; PG folds both
// sides with LOWER.
func ciColumnCmp(colA, colB string) string {
	return "LOWER(" + colA + ") = LOWER(" + colB + ")"
}

// Group is an organization unit: a department with optional parent
// (pyramid) and leader (department head).
type Group struct {
	ID          int64
	Name        string
	ParentID    int64
	LeaderID    int64
	Description string
}

// DepartmentInfo is the admin-view shape of a department.
type DepartmentInfo struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	ParentID    int64  `json:"parent_id"`
	LeaderID    int64  `json:"leader_id"`
	LeaderName  string `json:"leader_name,omitempty"`
	Description string `json:"description"`
	MemberCount int64  `json:"member_count"`
	ChildCount  int64  `json:"child_count"`
	// GrantedCount counts grant references (skill) — deletion guard.
	GrantedCount int64 `json:"granted_count"`
}

// ListDepartments returns every department with admin-view fields.
func ListDepartments(db *sql.DB) ([]DepartmentInfo, error) {
	rows, err := db.Query(`SELECT g.id, g.name, g.parent_id, g.leader_id, g.description,
		COALESCE(u.username, ''),
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM app_grants sg WHERE sg.grantee_type = 'group' AND ` + ciColumnCmp("sg.grantee", "g.name") + `)
		FROM groups g LEFT JOIN users u ON u.id = g.leader_id
		ORDER BY g.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DepartmentInfo
	for rows.Next() {
		var d DepartmentInfo
		if err := rows.Scan(&d.ID, &d.Name, &d.ParentID, &d.LeaderID, &d.Description,
			&d.LeaderName, &d.MemberCount, &d.ChildCount, &d.GrantedCount); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GroupByID returns one group.
func GroupByID(db *sql.DB, id int64) (*Group, error) {
	row := db.QueryRow(`SELECT id, name, parent_id, leader_id, description FROM groups WHERE id = ?`, id)
	var g Group
	err := row.Scan(&g.ID, &g.Name, &g.ParentID, &g.LeaderID, &g.Description)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &g, err
}

// CreateDepartment inserts a department (parent_id 0 = top level).
// The parent must exist; duplicate names are rejected (UNIQUE, NOCASE since 0019).
// leader 必须存在(与 UpdateDepartment 同口径,防悬空主管静默落库)。
func CreateDepartment(db *sql.DB, name string, parentID, leaderID int64, description string) (int64, error) {
	if name == EveryoneGroupName {
		return 0, ErrValidation // 保留名:隐式全员组不可重建/改名占用
	}
	if name == "" {
		return 0, ErrValidation
	}
	if parentID != 0 {
		if _, err := GroupByID(db, parentID); err != nil {
			return 0, err
		}
	}
	if leaderID != 0 {
		if _, err := GetUserByID(db, leaderID); err != nil {
			return 0, err
		}
	}
	id, err := InsertID(db, `INSERT INTO groups (name, parent_id, leader_id, description) VALUES (?, ?, ?, ?)`,
		name, parentID, leaderID, description)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	InvalidateGroupTree() // F3: 新部门立即进入组织树(环检测/授权/预算链)
	return id, nil
}

// UpdateDepartment renames/reparents/re-leads a department.
// Guards: parent must exist and not be the department itself or a
// descendant (cycle); leader must exist. Renames cascade to the grant
// tables so existing grants keep resolving (授权按组名,改名不得静默失效).
//
// 2026-09-11:部门预算(budget_money)下线(钱只由余额闸门管),本函数不再带预算
// 参数;数据库列保留但不再读写,避免破坏性迁移。
func UpdateDepartment(db *sql.DB, id int64, name string, parentID, leaderID int64, description string) error {
	g, err := GroupByID(db, id)
	if err != nil {
		return err
	}
	if parentID != 0 {
		if parentID == id {
			return ErrValidation
		}
		sub, err := subtreeGroupIDs(db, id)
		if err != nil {
			return err
		}
		for _, s := range sub {
			if s == parentID {
				return ErrValidation
			}
		}
		if _, err := GroupByID(db, parentID); err != nil {
			return err
		}
	}
	if leaderID != 0 {
		if _, err := GetUserByID(db, leaderID); err != nil {
			return err
		}
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 保留名:全员行不可改名(隐式全员授权按名解析,改名会静默失效;
	// 迁移 0018 一次性 seed,无启动自愈)。
	if g.Name == EveryoneGroupName {
		return ErrValidation
	}
	if name == EveryoneGroupName {
		return ErrValidation // 保留名
	}
	if name == "" {
		return ErrValidation // 空名会把全部授权级联写成空串,store 层兜底拒绝
	}
	if name != "" && name != g.Name {
		// COLLATE NOCASE 与授权解析一致:授权存储大小写异于组名的(手输/LDAP)改名后不失效
		if _, err := tx.Exec("UPDATE app_grants SET grantee = ? WHERE grantee_type = 'group' AND "+CaseInsensitiveCmp("grantee"), name, g.Name); err != nil {
			return err
		}
		// 审计修复 2026-P (H1): 0036 共享资源授权表同样级联改名,否则被授权
		// 部门改名后共享技能/Agent 授权静默失效(陈旧 grantee)。
		// P2:授权已统一到 app_grants,上面的 UPDATE 已覆盖全部能力类型。
	}
	_, err = tx.Exec(`UPDATE groups SET name = ?, parent_id = ?, leader_id = ?, description = ? WHERE id = ?`,
		name, parentID, leaderID, description, id)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateGroupTree() // F3: 改名/改父级/换主管立即生效
	return nil
}

// DeleteDepartment removes a department. Guard: departments with members,
// child departments or grant references cannot be deleted — the operator
// must move members/children and clear grants first (避免误删权限黑洞).
// 守卫计数与删除同事务(TOCTOU);授权引用按 NOCASE 计数(与解析口径一致,
// 大小写变体的授权不得绕过守卫导致孤儿授权/后续复活)。
func DeleteDepartment(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if g, err := GroupByID(db, id); err == nil && g.Name == EveryoneGroupName {
		return ErrValidation // 保留名
	}
	// P2 后三张授权表合并为 app_grants:此处从「数三张表」收敛为一次统计
	// (此前第三项仍落在旧表 agent_preset_grants 上,是三表合并时的漏改)。
	var memberCount, childCount, grantCount int64
	if err := tx.QueryRow(`SELECT
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM app_grants ag WHERE ag.grantee_type = 'group' AND `+ciColumnCmp("ag.grantee", "g.name")+`)
		FROM groups g WHERE g.id = ?`, id).Scan(&memberCount, &childCount, &grantCount); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if memberCount > 0 || childCount > 0 || grantCount > 0 {
		return ErrDepartmentInUse
	}
	if _, err := tx.Exec("DELETE FROM groups WHERE id = ?", id); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	InvalidateGroupTree() // F3: 删除后立刻从树中移除
	return nil
}

// subtreeGroupIDs returns the department id plus all descendant ids
// (in-memory walk; the tree is small). 复用 loadGroupTree 的缓存:
// 不再每次全表 SELECT groups(与 EffectiveDeptBudget 共用同一缓存树,
// 变更后应失效组织树缓存(当前依赖 TTL 兜底)。
func subtreeGroupIDs(db *sql.DB, rootID int64) ([]int64, error) {
	nodes, err := loadGroupTree(db)
	if err != nil {
		return nil, err
	}
	children := map[int64][]int64{}
	for _, n := range nodes {
		children[n.parent] = append(children[n.parent], n.id)
	}
	// visited 兜底(F3):迁移/手工数据可能留下环,绝不让配额热路径死循环。
	seen := map[int64]bool{rootID: true}
	out := []int64{rootID}
	stack := []int64{rootID}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, c := range children[cur] {
			if seen[c] {
				continue
			}
			seen[c] = true
			out = append(out, c)
			stack = append(stack, c)
		}
	}
	return out, nil
}
