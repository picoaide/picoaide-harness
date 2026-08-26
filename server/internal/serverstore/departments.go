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
	if currentDriver == DriverPG {
		return "LOWER(" + colA + ") = LOWER(" + colB + ")"
	}
	return colA + " = " + colB + " COLLATE NOCASE"
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
	// BudgetMoney 部门月度金额预算(元,0024);nil = 未配置(不限)。
	BudgetMoney *float64 `json:"budget_money"`
	// MonthlyCost 部门树当月累计费用 SUM(cost)(元,0024)。
	MonthlyCost float64 `json:"monthly_cost"`
}

// ListDepartments returns every department with admin-view fields.
func ListDepartments(db *sql.DB) ([]DepartmentInfo, error) {
	rows, err := db.Query(`SELECT g.id, g.name, g.parent_id, g.leader_id, g.description,
		COALESCE(u.username, ''),
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM skill_grants sg WHERE sg.grantee_type = 'group' AND ` + ciColumnCmp("sg.grantee", "g.name") + `),
		g.budget_money
		FROM groups g LEFT JOIN users u ON u.id = g.leader_id
		ORDER BY g.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DepartmentInfo
	for rows.Next() {
		var d DepartmentInfo
		var b sql.NullFloat64
		if err := rows.Scan(&d.ID, &d.Name, &d.ParentID, &d.LeaderID, &d.Description,
			&d.LeaderName, &d.MemberCount, &d.ChildCount, &d.GrantedCount, &b); err != nil {
			return nil, err
		}
		if b.Valid {
			d.BudgetMoney = &b.Float64
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	// 批量附部门树当月费用(单次查询,避免 N+1)
	ids := make([]int64, 0, len(out))
	for i := range out {
		ids = append(ids, out[i].ID)
	}
	costs, err := DeptMonthlyCostBatch(db, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].MonthlyCost = costs[out[i].ID]
	}
	return out, nil
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
	return id, nil
}

// UpdateDepartment renames/reparents/re-leads a department.
// Guards: parent must exist and not be the department itself or a
// descendant (cycle); leader must exist. Renames cascade to the grant
// tables so existing grants keep resolving (授权按组名,改名不得静默失效).
func UpdateDepartment(db *sql.DB, id int64, name string, parentID, leaderID int64, description string) error {
	return updateDepartment(db, id, name, parentID, leaderID, description, nil)
}

// UpdateDepartmentWithBudget 与 UpdateDepartment 同语义,额外在同一事务内
// 设置部门月度金额预算(budget nil = 不变,0 = 清除,>0 = 设置;负值 = ErrValidation)。
// 预算与改名/改上级原子生效,失败整体回滚,不留半更新状态(审计 M2)。
func UpdateDepartmentWithBudget(db *sql.DB, id int64, name string, parentID, leaderID int64, description string, budget *float64) error {
	return updateDepartment(db, id, name, parentID, leaderID, description, budget)
}

func updateDepartment(db *sql.DB, id int64, name string, parentID, leaderID int64, description string, budget *float64) error {
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
		if _, err := tx.Exec("UPDATE skill_grants SET grantee = ? WHERE grantee_type = 'group' AND "+CaseInsensitiveCmp("grantee"), name, g.Name); err != nil {
			return err
		}
		// 审计修复 2026-P (H1): 0036 共享资源授权表同样级联改名,否则被授权
		// 部门改名后共享技能/Agent 授权静默失效(陈旧 grantee)。
		for _, grantTable := range []string{"shared_skill_grants", "agent_preset_grants"} {
			if _, err := tx.Exec("UPDATE "+grantTable+" SET grantee = ? WHERE grantee_type = 'group' AND "+CaseInsensitiveCmp("grantee"), name, g.Name); err != nil {
				return err
			}
		}
	}
	_, err = tx.Exec(`UPDATE groups SET name = ?, parent_id = ?, leader_id = ?, description = ? WHERE id = ?`,
		name, parentID, leaderID, description, id)
	if err != nil {
		if isUniqueViolation(err) {
			return ErrDuplicate
		}
		return err
	}
	// 预算并入同一事务(审计 M2):预算失败回滚整个部门更新
	if budget != nil {
		if *budget < 0 {
			return ErrValidation
		}
		if *budget <= 0 {
			if _, err := tx.Exec("UPDATE groups SET budget_money = NULL WHERE id = ?", id); err != nil {
				return err
			}
		} else if _, err := tx.Exec("UPDATE groups SET budget_money = ? WHERE id = ?", *budget, id); err != nil {
			return err
		}
	}
	return tx.Commit()
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
	var memberCount, childCount, grantCount, sharedGrantCount, presetGrantCount int64
	if err := tx.QueryRow(`SELECT
		(SELECT COUNT(*) FROM user_groups ug WHERE ug.group_id = g.id),
		(SELECT COUNT(*) FROM groups c WHERE c.parent_id = g.id),
		(SELECT COUNT(*) FROM skill_grants sg WHERE sg.grantee_type = 'group' AND `+ciColumnCmp("sg.grantee", "g.name")+`),
		(SELECT COUNT(*) FROM shared_skill_grants ssg WHERE ssg.grantee_type = 'group' AND `+ciColumnCmp("ssg.grantee", "g.name")+`),
		(SELECT COUNT(*) FROM agent_preset_grants apg WHERE apg.grantee_type = 'group' AND `+ciColumnCmp("apg.grantee", "g.name")+`)
		FROM groups g WHERE g.id = ?`, id).Scan(&memberCount, &childCount, &grantCount, &sharedGrantCount, &presetGrantCount); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if memberCount > 0 || childCount > 0 || grantCount > 0 || sharedGrantCount > 0 || presetGrantCount > 0 {
		return ErrDepartmentInUse
	}
	if _, err := tx.Exec("DELETE FROM groups WHERE id = ?", id); err != nil {
		return err
	}
	return tx.Commit()
}

// subtreeGroupIDs returns the department id plus all descendant ids
// (in-memory walk; the tree is small).
func subtreeGroupIDs(db *sql.DB, rootID int64) ([]int64, error) {
	rows, err := db.Query("SELECT id, parent_id FROM groups")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	children := map[int64][]int64{}
	for rows.Next() {
		var id, parent int64
		if err := rows.Scan(&id, &parent); err != nil {
			return nil, err
		}
		children[parent] = append(children[parent], id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := []int64{rootID}
	stack := []int64{rootID}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		for _, c := range children[cur] {
			out = append(out, c)
			stack = append(stack, c)
		}
	}
	return out, nil
}
