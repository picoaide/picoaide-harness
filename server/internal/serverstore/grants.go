package serverstore

import (
	"database/sql"
	"strings"
)

// GranteeType distinguishes a direct user grant from a group grant.
type GranteeType string

const (
	GranteeUser  GranteeType = "user"
	GranteeGroup GranteeType = "group"
)

// Grant is one ACL row: a resource granted to a user or a group.
type Grant struct {
	GranteeType GranteeType `json:"grantee_type"`
	Grantee     string      `json:"grantee"`
}

// validGrantee enforces a plain, conflict-free subject name (no separators
// or path-ish characters); group names may carry an optional '@' prefix the
// webadmin sends, stripped before storage.
func validGrantee(g string) (string, bool) {
	g = strings.TrimPrefix(g, "@")
	if g == "" || strings.ContainsAny(g, "/\\\t\n") {
		return "", false
	}
	return g, true
}

// ---- skills ----

// GrantSkill gives a user or group access to a skill (idempotent).
func GrantSkill(db queryer, skillName, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	stmt := "INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES ('skill', ?, ?, ?) ON CONFLICT DO NOTHING"
	_, err := db.Exec(stmt, skillName, t, g)
	return err
}

// RevokeSkill removes a grant (idempotent; missing row is not an error).
func RevokeSkill(db queryer, skillName, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	_, err := db.Exec("DELETE FROM app_grants WHERE kind = 'skill' AND app_id = ? AND grantee_type = ? AND grantee = ?", skillName, t, g)
	return err
}

// ListSkillGrants returns every grant on a skill.
func ListSkillGrants(db *sql.DB, skillName string) ([]Grant, error) {
	rows, err := db.Query("SELECT grantee_type, grantee FROM app_grants WHERE kind = 'skill' AND app_id = ? ORDER BY grantee_type, grantee", skillName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.GranteeType, &g.Grantee); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// AccessibleSkillNames returns the skill names granted to a user directly
// or through any of their groups. Single query, no N+1; a user with no
// grants gets an empty set (strict default: nothing is implicitly visible).
func AccessibleSkillNames(db *sql.DB, username string, groups []string) ([]string, error) {
	var sb strings.Builder
	sb.WriteString("SELECT DISTINCT app_id FROM app_grants WHERE kind = 'skill' AND ((grantee_type = 'user' AND grantee = ?)")
	args := []any{username}
	if len(groups) > 0 {
		// COLLATE NOCASE: LDAP 组名与手输组名大小写差异不得导致授权静默失效
		sb.WriteString(" OR (grantee_type = 'group' AND (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(" OR ")
			}
			sb.WriteString(CaseInsensitiveCmp("grantee"))
			args = append(args, g)
		}
		sb.WriteString("))")
	}
	sb.WriteString(")")
	rows, err := db.Query(sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// DeleteSkillGrants removes all grants of a skill (resource deletion
// cascades; old grants must never resurrect a re-created resource).
func DeleteSkillGrants(db queryer, skillName string) error {
	_, err := db.Exec("DELETE FROM app_grants WHERE kind = 'skill' AND app_id = ?", skillName)
	return err
}

// ---------------------------------------------------------------------------
// 共享技能/Agent 授权(0036):与 skill_grants 同模型,资源按 name 授权。
// 表名/资源列是编译期常量(grantTable),无用户输入拼接。
// ---------------------------------------------------------------------------

// SharedGrantableTable names one grant table plus the row scope inside it.
//
// P2(迁移 0053):三张旧授权表(skill_grants / shared_skill_grants /
// agent_preset_grants)合并为 app_grants,靠 kind 区分技能与智能体。
// 表名/列名/kind 都是编译期常量,不接受用户输入拼接。
type SharedGrantableTable struct {
	Table string // 统一为 "app_grants"
	Col   string // 资源名列("app_id")
	Kind  string // 行作用域:"skill" | "agent"(空 = 不加 kind 条件)
}

// scope 返回附加的 kind 条件与参数(kind 为空时不加条件)。
func (t SharedGrantableTable) scope() (string, []any) {
	if t.Kind == "" {
		return "", nil
	}
	return " AND kind = ?", []any{t.Kind}
}

var (
	// SharedSkillGrantTable: 技能授权(市场与组织共用一个命名空间)。
	SharedSkillGrantTable = SharedGrantableTable{Table: "app_grants", Col: "app_id", Kind: "skill"}
	// SharedPresetGrantTable: 智能体授权。
	SharedPresetGrantTable = SharedGrantableTable{Table: "app_grants", Col: "app_id", Kind: "agent"}
)

// GrantSharedResource gives a user or group access to a shared skill/preset
// (idempotent). The table must be one of the compile-time constants above.
func GrantSharedResource(db queryer, table SharedGrantableTable, resourceName, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	stmt := "INSERT INTO " + table.Table + " (kind, " + table.Col + ", grantee_type, grantee) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
	_, err := db.Exec(stmt, table.Kind, resourceName, t, g)
	return err
}

// RevokeSharedResource removes a grant (idempotent).
func RevokeSharedResource(db queryer, table SharedGrantableTable, resourceName, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	cond, args := table.scope()
	args = append([]any{resourceName, t, g}, args...)
	_, err := db.Exec("DELETE FROM "+table.Table+" WHERE "+table.Col+" = ? AND grantee_type = ? AND grantee = ?"+cond, args...)
	return err
}

// ListSharedResourceGrants returns every grant on a shared skill/preset.
func ListSharedResourceGrants(db *sql.DB, table SharedGrantableTable, resourceName string) ([]Grant, error) {
	cond, extra := table.scope()
	rows, err := db.Query("SELECT grantee_type, grantee FROM "+table.Table+" WHERE "+table.Col+" = ?"+cond+" ORDER BY grantee_type, grantee",
		append([]any{resourceName}, extra...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Grant
	for rows.Next() {
		var g Grant
		if err := rows.Scan(&g.GranteeType, &g.Grantee); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}

// DeleteSharedResourceGrants removes all grants of a resource (delete
// cascades; old grants must never resurrect a re-created resource).
func DeleteSharedResourceGrants(db queryer, table SharedGrantableTable, resourceName string) error {
	cond, extra := table.scope()
	_, err := db.Exec("DELETE FROM "+table.Table+" WHERE "+table.Col+" = ?"+cond, append([]any{resourceName}, extra...)...)
	return err
}

// ReplaceSharedGroups sets the full group-grant set of a shared resource in
// one transaction (existing group grants dropped; user grants untouched).
// Every name must reference an existing department.
func ReplaceSharedGroups(db *sql.DB, table SharedGrantableTable, resourceName string, groups []string) error {
	cond, extra := table.scope()
	return replaceGroupGrants(db,
		"DELETE FROM "+table.Table+" WHERE "+table.Col+" = ? AND grantee_type = 'group'"+cond,
		append([]any{resourceName}, extra...),
		func(tx *sql.Tx, name string) error {
			_, err := tx.Exec("INSERT INTO "+table.Table+" (kind, "+table.Col+", grantee_type, grantee) VALUES (?, ?, 'group', ?)",
				table.Kind, resourceName, name)
			return err
		},
		groups)
}

// AccessibleSharedResourceNames returns the shared skill/preset names granted
// to a user directly or through any of their groups (strict default).
func AccessibleSharedResourceNames(db *sql.DB, table SharedGrantableTable, username string, groups []string) ([]string, error) {
	var sb strings.Builder
	sb.WriteString("SELECT DISTINCT " + table.Col + " FROM " + table.Table + " WHERE ")
	args := []any{}
	if cond, extra := table.scope(); cond != "" {
		sb.WriteString("kind = ? AND ")
		args = append(args, extra...)
	}
	sb.WriteString("((grantee_type = 'user' AND grantee = ?)")
	args = append(args, username)
	if len(groups) > 0 {
		sb.WriteString(" OR (grantee_type = 'group' AND (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(" OR ")
			}
			sb.WriteString(CaseInsensitiveCmp("grantee"))
			args = append(args, g)
		}
		sb.WriteString("))")
	}
	sb.WriteString(")")
	rows, err := db.Query(sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// ---- 整组替换(多部门批量授权,原子) ----

// replaceGroupGrants replaces all group grants of a resource in one
// transaction: existing group grants are dropped, the given department
// names become the full group-grant set (user grants untouched).
// Every name must reference an existing department (typos fail fast).
func replaceGroupGrants(db *sql.DB, deleteSQL string, deleteArgs []any, insert func(tx *sql.Tx, name string) error, groups []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 部门存在性校验放事务内(审计 A5-L9):与写入同事务,消除
	// 「校验通过后、写事务前部门被删」的 TOCTOU 窗口,不留孤儿授权行。
	// 只接受已存在部门,防拼错隐式建组;重复/空名直接拒绝。
	seen := map[string]bool{}
	for _, g := range groups {
		if g == "" || seen[g] {
			return ErrValidation
		}
		seen[g] = true
		var n int
		if err := tx.QueryRow("SELECT COUNT(*) FROM groups WHERE "+CaseInsensitiveCmp("name"), g).Scan(&n); err != nil {
			return err
		}
		if n == 0 {
			return ErrNotFound
		}
	}
	if _, err := tx.Exec(deleteSQL, deleteArgs...); err != nil {
		return err
	}
	for _, g := range groups {
		if err := insert(tx, g); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// ReplaceSkillGroupGrants sets the full department-grant set of a skill.
func ReplaceSkillGroupGrants(db *sql.DB, skillName string, groups []string) error {
	return replaceGroupGrants(db,
		"DELETE FROM app_grants WHERE kind = 'skill' AND app_id = ? AND grantee_type = 'group'", []any{skillName},
		func(tx *sql.Tx, name string) error {
			_, err := tx.Exec("INSERT INTO app_grants (kind, app_id, grantee_type, grantee) VALUES ('skill', ?, 'group', ?)", skillName, name)
			return err
		},
		groups)
}
