package serverstore

import (
	"database/sql"
	"strings"
	"time"
)

// AuditLogEntry is one audit log row (sensitive admin operations).
// json tag 必须是小写字段名:webadmin Audit.tsx 的 LogRow 读取
// id/username/action/detail/created_at,缺 tag 会输出大写字段名导致前端全空。
type AuditLogEntry struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Action    string    `json:"action"`
	Detail    string    `json:"detail"`
	CreatedAt time.Time `json:"created_at"`
}

// AuditLog appends an audit entry (用户/部门/技能/令牌等敏感操作).
func AuditLog(db *sql.DB, username, action, detail string) error {
	_, err := db.Exec("INSERT INTO audit_logs (username, action, detail) VALUES (?, ?, ?)", username, action, detail)
	return err
}

// ListAuditLogs returns the most recent audit entries (limit <= 0: 50).
func ListAuditLogs(db *sql.DB, limit int) ([]AuditLogEntry, error) {
	if limit <= 0 {
		limit = 50
	}
	logs, _, err := ListAuditLogsPaged(db, 0, limit)
	return logs, err
}

// ListAuditLogsPaged returns one page of audit entries (newest first) and the
// total count.
func ListAuditLogsPaged(db *sql.DB, offset, limit int) ([]AuditLogEntry, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query("SELECT id, username, action, detail, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var l AuditLogEntry
		var created string
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// ListAuditLogsPagedFiltered returns one page of audit entries (newest
// first) optionally filtered by action/username (审计 M8), plus the total
// for the filtered set.
func ListAuditLogsPagedFiltered(db *sql.DB, offset, limit int, action, username string) ([]AuditLogEntry, int64, error) {
	where := ""
	args := []any{}
	if action != "" {
		where += " AND action = ?"
		args = append(args, action)
	}
	if username != "" {
		where += " AND username = ?"
		args = append(args, username)
	}
	where = strings.TrimPrefix(where, " AND ")
	var total int64
	countQ := "SELECT COUNT(*) FROM audit_logs"
	if where != "" {
		countQ += " WHERE " + where
	}
	if err := db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := "SELECT id, username, action, detail, created_at FROM audit_logs"
	if where != "" {
		q += " WHERE " + where
	}
	q += " ORDER BY id DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var l AuditLogEntry
		var created string
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// PurgeOldAuditLogs deletes audit entries older than cutoff (audit
// retention housekeeping, run at startup; 90 days by default).
func PurgeOldAuditLogs(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec("DELETE FROM audit_logs WHERE created_at < ?", cutoff.Format(sqliteTimeFmt))
	return err
}
