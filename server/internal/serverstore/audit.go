package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
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
	PrevHash  string    `json:"prev_hash"`  // 0048 哈希链
	Hash      string    `json:"hash"`       // 0048 本条目 sha256(省略响应)
	CreatedAt time.Time `json:"created_at"`
}

// AuditLog appends an audit entry with a tamper-evident hash chain
// (0048): the entry's hash = sha256(prev_hash | username | action | detail
// | created_at), and prev_hash carries the previous entry's hash. Mutating
// any row breaks every subsequent chain link.
func AuditLog(db *sql.DB, username, action, detail string) error {
	var prevHash string
	if err := db.QueryRow("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1").Scan(&prevHash); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		prevHash = ""
	}
	now := time.Now().UTC().Format(time.RFC3339)
	payload := prevHash + "|" + username + "|" + action + "|" + detail + "|" + now
	sum := sha256.Sum256([]byte(payload))
	hash := hex.EncodeToString(sum[:])
	_, err := db.Exec("INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
		username, action, detail, prevHash, hash, now)
	return err
}

// auditHashPayload mirrors the payload used at write time (same layout).
func auditHashPayload(prevHash, username, action, detail, createdAt string) string {
	return prevHash + "|" + username + "|" + action + "|" + detail + "|" + createdAt
}

// VerifyAuditChain walks the audit log from oldest to newest and verifies
// every hash link. Returns the first broken entry id (or 0 if intact).
// Rows written before the 0048 migration have hash='' and are skipped
// (the chain starts at the first post-migration entry).
func VerifyAuditChain(db *sql.DB) (int64, error) {
	rows, err := db.Query("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id ASC")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	prevHash := ""
	for rows.Next() {
		var id int64
		var username, action, detail, rowPrev, rowHash, created string
		created = ""
		var createdAny any
		if err := rows.Scan(&id, &username, &action, &detail, &rowPrev, &rowHash, &createdAny); err != nil {
			return 0, err
		}
		if s, ok := createdAny.(string); ok {
			created = s
		} else if t, ok := createdAny.(time.Time); ok {
			created = t.UTC().Format(time.RFC3339)
		}
		// Legacy rows (pre-0048) carry an empty hash: skip link checks but
		// note that a legacy row may sit mid-chain; validate only post-0048.
		if rowHash == "" {
			continue
		}
		if rowPrev != prevHash {
			return id, errors.New("audit chain broken at entry")
		}
		sum := sha256.Sum256([]byte(auditHashPayload(rowPrev, username, action, detail, created)))
		if hex.EncodeToString(sum[:]) != rowHash {
			return id, errors.New("audit hash mismatch")
		}
		prevHash = rowHash
	}
	return 0, rows.Err()
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
	rows, err := db.Query("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var l AuditLogEntry
		var created any
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &l.PrevHash, &l.Hash, &created); err != nil {
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
	q := "SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs"
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
		var created any
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &l.PrevHash, &l.Hash, &created); err != nil {
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
	_, err := db.Exec("DELETE FROM audit_logs WHERE created_at < ?", cutoff.Format(pgTimeFmt))
	return err
}
