package serverstore

import (
	"database/sql"
	"strings"
)

// queryer matches both *sql.DB and *sql.Tx.
type queryer interface {
	QueryRow(query string, args ...any) *sql.Row
	Exec(query string, args ...any) (sql.Result, error)
}

// GetOrCreateGroup returns a group id by name, creating it if missing.
// Lookup is case-insensitive (COLLATE NOCASE): LDAP cn "Finance" and a
// hand-typed "finance" are the same group, so grants never silently fail
// to resolve. The stored name keeps its first-seen casing.
func GetOrCreateGroup(db queryer, name string) (int64, error) {
	var id int64
	err := db.QueryRow("SELECT id FROM groups WHERE name = ? COLLATE NOCASE", name).Scan(&id)
	if err == nil {
		return id, nil
	}
	if err != sql.ErrNoRows {
		return 0, err
	}
	res, err := db.Exec("INSERT INTO groups (name) VALUES (?)", name)
	if err != nil {
		// concurrent insert or a historical casing variant; re-read nocase
		if err2 := db.QueryRow("SELECT id FROM groups WHERE name = ? COLLATE NOCASE", name).Scan(&id); err2 == nil {
			return id, nil
		}
		return 0, err
	}
	return res.LastInsertId()
}

// UserGroups returns the group names for a user.
func UserGroups(db *sql.DB, userID int64) ([]string, error) {
	rows, err := db.Query(`SELECT g.name FROM groups g
		JOIN user_groups ug ON ug.group_id = g.id
		WHERE ug.user_id = ? ORDER BY g.name`, userID)
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

// UserGroupsBatch returns user_id → group names for a set of users in one
// query (admin user listing; avoids N+1).
func UserGroupsBatch(db *sql.DB, users []User) (map[int64][]string, error) {
	out := make(map[int64][]string, len(users))
	if len(users) == 0 {
		return out, nil
	}
	ids := make([]any, len(users))
	for i, u := range users {
		ids[i] = u.ID
		out[u.ID] = nil
	}
	ph := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := db.Query(`SELECT ug.user_id, g.name FROM user_groups ug
		JOIN groups g ON g.id = ug.group_id
		WHERE ug.user_id IN (`+ph+`) ORDER BY g.name`, ids...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid int64
		var name string
		if err := rows.Scan(&uid, &name); err != nil {
			return nil, err
		}
		out[uid] = append(out[uid], name)
	}
	return out, rows.Err()
}

// SyncUserGroups replaces the user's group membership with the given names.
func SyncUserGroups(db *sql.DB, userID int64, names []string) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM user_groups WHERE user_id = ?", userID); err != nil {
		return err
	}
	for _, n := range names {
		gid, err := GetOrCreateGroup(tx, n)
		if err != nil {
			return err
		}
		if _, err := tx.Exec("INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)", userID, gid); err != nil {
			return err
		}
	}
	return tx.Commit()
}
