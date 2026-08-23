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
	_, err := db.Exec("INSERT OR IGNORE INTO skill_grants (skill_name, grantee_type, grantee) VALUES (?, ?, ?)", skillName, t, g)
	return err
}

// RevokeSkill removes a grant (idempotent; missing row is not an error).
func RevokeSkill(db queryer, skillName, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	_, err := db.Exec("DELETE FROM skill_grants WHERE skill_name = ? AND grantee_type = ? AND grantee = ?", skillName, t, g)
	return err
}

// ListSkillGrants returns every grant on a skill.
func ListSkillGrants(db *sql.DB, skillName string) ([]Grant, error) {
	rows, err := db.Query("SELECT grantee_type, grantee FROM skill_grants WHERE skill_name = ? ORDER BY grantee_type, grantee", skillName)
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
	sb.WriteString("SELECT DISTINCT skill_name FROM skill_grants WHERE (grantee_type = 'user' AND grantee = ?)")
	args := []any{username}
	if len(groups) > 0 {
		// COLLATE NOCASE: LDAP 组名与手输组名大小写差异不得导致授权静默失效
		sb.WriteString(" OR (grantee_type = 'group' AND (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(" OR ")
			}
			sb.WriteString("grantee = ? COLLATE NOCASE")
			args = append(args, g)
		}
		sb.WriteString("))")
	}
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

// ---- mcp ----

// GrantMCP gives a user or group access to an MCP server (idempotent).
func GrantMCP(db queryer, mcpID int64, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	_, err := db.Exec("INSERT OR IGNORE INTO mcp_grants (mcp_id, grantee_type, grantee) VALUES (?, ?, ?)", mcpID, t, g)
	return err
}

// RevokeMCP removes a grant (idempotent).
func RevokeMCP(db queryer, mcpID int64, grantee string, t GranteeType) error {
	g, ok := validGrantee(grantee)
	if !ok {
		return ErrValidation
	}
	_, err := db.Exec("DELETE FROM mcp_grants WHERE mcp_id = ? AND grantee_type = ? AND grantee = ?", mcpID, t, g)
	return err
}

// ListMCPGrants returns every grant on an MCP server.
func ListMCPGrants(db *sql.DB, mcpID int64) ([]Grant, error) {
	rows, err := db.Query("SELECT grantee_type, grantee FROM mcp_grants WHERE mcp_id = ? ORDER BY grantee_type, grantee", mcpID)
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

// AccessibleMCPSet returns the mcp ids granted to a user directly or
// through their groups (strict default: empty set = nothing visible).
func AccessibleMCPSet(db *sql.DB, username string, groups []string) (map[int64]bool, error) {
	var sb strings.Builder
	sb.WriteString("SELECT DISTINCT mcp_id FROM mcp_grants WHERE (grantee_type = 'user' AND grantee = ?)")
	args := []any{username}
	if len(groups) > 0 {
		sb.WriteString(" OR (grantee_type = 'group' AND (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(" OR ")
			}
			sb.WriteString("grantee = ? COLLATE NOCASE")
			args = append(args, g)
		}
		sb.WriteString("))")
	}
	rows, err := db.Query(sb.String(), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]bool)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// DeleteSkillGrants removes all grants of a skill (resource deletion
// cascades; old grants must never resurrect a re-created resource).
func DeleteSkillGrants(db queryer, skillName string) error {
	_, err := db.Exec("DELETE FROM skill_grants WHERE skill_name = ?", skillName)
	return err
}

// DeleteMCPGrants removes all grants of an MCP server.
func DeleteMCPGrants(db queryer, mcpID int64) error {
	_, err := db.Exec("DELETE FROM mcp_grants WHERE mcp_id = ?", mcpID)
	return err
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
		if err := tx.QueryRow("SELECT COUNT(*) FROM groups WHERE name = ? COLLATE NOCASE", g).Scan(&n); err != nil {
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
		"DELETE FROM skill_grants WHERE skill_name = ? AND grantee_type = 'group'", []any{skillName},
		func(tx *sql.Tx, name string) error {
			_, err := tx.Exec("INSERT INTO skill_grants (skill_name, grantee_type, grantee) VALUES (?, 'group', ?)", skillName, name)
			return err
		},
		groups)
}

// ReplaceMCPGroupGrants sets the full department-grant set of an MCP.
func ReplaceMCPGroupGrants(db *sql.DB, mcpID int64, groups []string) error {
	return replaceGroupGrants(db,
		"DELETE FROM mcp_grants WHERE mcp_id = ? AND grantee_type = 'group'", []any{mcpID},
		func(tx *sql.Tx, name string) error {
			_, err := tx.Exec("INSERT INTO mcp_grants (mcp_id, grantee_type, grantee) VALUES (?, 'group', ?)", mcpID, name)
			return err
		},
		groups)
}

// ReplaceFolderGroupGrants sets the full department-grant set of a folder.
func ReplaceFolderGroupGrants(db *sql.DB, folderID int64, groups []string) error {
	return replaceGroupGrants(db,
		"DELETE FROM kb_folder_groups WHERE folder_id = ?", []any{folderID},
		func(tx *sql.Tx, name string) error {
			gid, err := GetOrCreateGroup(tx, name)
			if err != nil {
				return err
			}
			_, err = tx.Exec("INSERT OR IGNORE INTO kb_folder_groups (folder_id, group_id) VALUES (?, ?)", folderID, gid)
			return err
		},
		groups)
}
