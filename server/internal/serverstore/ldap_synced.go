// ldap_synced_users DAO(2026-09-08 审计 P1-4)。
//
// LDAP 目录同步用它记录"见过"的用户名,停用对账只针对这些用户名,避免把
// 同为 Source=external 的 OIDC 用户一起停用。
package serverstore

import (
	"database/sql"
)

// MarkLDAPSynced upserts the usernames seen in the last LDAP directory scan.
func MarkLDAPSynced(db *sql.DB, usernames []string) error {
	if len(usernames) == 0 {
		return nil
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, name := range usernames {
		if name == "" {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO ldap_synced_users (username, synced_at) VALUES (?, now())
			 ON CONFLICT (username) DO UPDATE SET synced_at = now()`, name); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// LDAPSyncedUsers returns the set of usernames previously seen by LDAP sync.
func LDAPSyncedUsers(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`SELECT username FROM ldap_synced_users`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}

// UnmarkLDAPSynced drops a username after it was deactivated (it left the
// directory, so a later re-appearance must be treated as a fresh LDAP user).
func UnmarkLDAPSynced(db *sql.DB, username string) error {
	_, err := db.Exec(`DELETE FROM ldap_synced_users WHERE username = ?`, username)
	return err
}
