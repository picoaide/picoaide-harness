package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"sync"
	"time"
)

// KBFolder is a knowledge base folder.
type KBFolder struct {
	ID        int64
	Name      string
	ParentID  int64
	CreatedAt time.Time
}

// KBDocument is a knowledge base document.
type KBDocument struct {
	ID          int64
	FolderID    int64
	Title       string
	Content     string
	ContentType string
	Size        int64
	Source      string
	CreatedBy   string
	CreatedAt   time.Time
	Status      string // ready | pending | error
	Error       string
}

// KBAuditLog is one knowledge base audit entry.
type KBAuditLog struct {
	ID        int64
	Username  string
	Action    string
	Detail    string
	CreatedAt time.Time
}

// CreateKBFolder creates a folder (parentID 0 = root) and returns its id.
func CreateKBFolder(db *sql.DB, name string, parentID int64) (int64, error) {
	res, err := db.Exec("INSERT INTO kb_folders (name, parent_id) VALUES (?, ?)", name, parentID)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// ListKBFolders returns all folders ordered by id.
func ListKBFolders(db *sql.DB) ([]KBFolder, error) {
	rows, err := db.Query("SELECT id, name, parent_id, created_at FROM kb_folders ORDER BY id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBFolder
	for rows.Next() {
		var f KBFolder
		var created string
		if err := rows.Scan(&f.ID, &f.Name, &f.ParentID, &created); err != nil {
			return nil, err
		}
		f.CreatedAt = parseSQLTime(created)
		out = append(out, f)
	}
	return out, rows.Err()
}

// CreateKBDocument inserts a document and returns its id. size 0 means
// derive from content length. FTS index is synced by trigger kb_ai.
func CreateKBDocument(db *sql.DB, folderID int64, title, content, contentType string, size int64, source, createdBy string) (int64, error) {
	if size == 0 {
		size = int64(len(content))
	}
	res, err := db.Exec(`INSERT INTO kb_documents (folder_id, title, content, content_type, size, source, created_by)
		VALUES (?, ?, ?, ?, ?, ?, ?)`, folderID, title, content, contentType, size, source, createdBy)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// CreatePendingKBDocument inserts a document awaiting async extraction
// (status=pending, empty content, size = raw file size).
func CreatePendingKBDocument(db *sql.DB, folderID int64, title, contentType string, size int64, source, createdBy string) (int64, error) {
	res, err := db.Exec(`INSERT INTO kb_documents (folder_id, title, content, content_type, size, source, created_by, status)
		VALUES (?, ?, '', ?, ?, ?, ?, 'pending')`, folderID, title, contentType, size, source, createdBy)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// claimMu serializes claims: SELECT + UPDATE + return must be one critical
// section so each claimed row has exactly one owner (see ClaimPendingKBDocument).
var claimMu sync.Mutex

// ClaimPendingKBDocument exclusively claims the oldest upload awaiting
// extraction: the row moves pending → processing atomically, so concurrent
// workers can never extract the same document twice — each claimed row has
// exactly one owner. Returns ErrNotFound when the queue is empty.
//
// The whole claim runs under claimMu: SELECT the oldest pending row, then
// UPDATE it to processing, then return that exact row. Re-selecting the
// "oldest processing" row after the UPDATE would race — another worker may
// have claimed a different row whose processing timestamp is older, and
// this worker would steal it, orphaning its own claim.
func ClaimPendingKBDocument(db *sql.DB) (*KBDocument, error) {
	claimMu.Lock()
	defer claimMu.Unlock()
	row := db.QueryRow(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents WHERE status = 'pending' ORDER BY id LIMIT 1`)
	var d KBDocument
	var created string
	err := row.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &created, &d.Status, &d.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	res, err := db.Exec("UPDATE kb_documents SET status = 'processing' WHERE id = ?", d.ID)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound // defensive: row state changed outside the claim path
	}
	d.CreatedAt = parseSQLTime(created)
	d.Status = "processing"
	return &d, nil
}

// ListPendingKBDocuments returns every pending row (oldest first) so the
// upload queue can detect orphans (missing raw files) and claim by id
// without letting one bad row block the head forever (审计 H2).
func ListPendingKBDocuments(db *sql.DB) ([]KBDocument, error) {
	rows, err := db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents WHERE status = 'pending' ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KBDocument
	for rows.Next() {
		var d KBDocument
		var created string
		if err := rows.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &created, &d.Status, &d.Error); err != nil {
			return nil, err
		}
		d.CreatedAt = parseSQLTime(created)
		out = append(out, d)
	}
	return out, rows.Err()
}

// ClaimPendingKBDocumentByID claims one specific pending row (CAS), the
// per-row variant of ClaimPendingKBDocument: the queue first verifies the
// raw file exists, then claims by id so a stale list entry (already claimed
// by another worker) fails with ErrNotFound instead of being stolen.
func ClaimPendingKBDocumentByID(db *sql.DB, id int64) (*KBDocument, error) {
	claimMu.Lock()
	defer claimMu.Unlock()
	res, err := db.Exec("UPDATE kb_documents SET status = 'processing' WHERE id = ? AND status = 'pending'", id)
	if err != nil {
		return nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return nil, ErrNotFound
	}
	return GetKBDocument(db, id)
}

// ReleaseClaim returns a claimed-but-unprocessable row to the queue
// (pending) so another worker can pick it up; no-op when the row was
// already completed by its owner.
func ReleaseClaim(db *sql.DB, id int64) error {
	_, err := db.Exec("UPDATE kb_documents SET status = 'pending' WHERE id = ? AND status = 'processing'", id)
	return err
}

// ResetProcessingClaims moves every processing row back to pending —
// called at startup so claims held by a crashed process are retried.
func ResetProcessingClaims(db *sql.DB) error {
	_, err := db.Exec("UPDATE kb_documents SET status = 'pending' WHERE status = 'processing'")
	return err
}

// CompleteKBDocument finishes an async upload: errMsg == "" marks the doc
// ready with extracted content (FTS synced by trigger kb_au); otherwise the
// doc is marked error with the message and the raw file is kept for OCR.
// Completions are CAS-guarded on the claimed state: a stale worker
// finishing a row another worker already completed is ignored (C-3) — an
// error must never clobber a ready extraction and a late success must
// never resurrect an error row.
func CompleteKBDocument(db *sql.DB, id int64, content, errMsg string) error {
	if errMsg == "" {
		_, err := db.Exec("UPDATE kb_documents SET content = ?, size = ?, status = 'ready', error = '' WHERE id = ? AND status = 'processing'", content, len(content), id)
		return err
	}
	doc, err := GetKBDocument(db, id)
	if err != nil {
		return err
	}
	if doc.Status != "processing" && doc.Status != "pending" {
		return nil // already completed by another worker
	}
	_, err = db.Exec("UPDATE kb_documents SET status = 'error', error = ? WHERE id = ? AND status IN ('processing','pending')", errMsg, id)
	return err
}

// PurgeOldAuditLogs deletes kb audit entries older than cutoff (审计 6-K6,
// retention housekeeping, run at startup).
func PurgeOldAuditLogs(db *sql.DB, cutoff time.Time) error {
	_, err := db.Exec("DELETE FROM kb_audit_logs WHERE created_at < ?", cutoff.Format(sqliteTimeFmt))
	return err
}

// RetryKBDocument re-queues a failed upload for extraction.
func RetryKBDocument(db *sql.DB, id int64) error {
	// 状态守卫(审计2026-L10):仅 error/pending 可重排;processing 行由 worker
	// 独占声明(CAS),重排会破坏排他性导致双重提取/文件竞态删除
	res, err := db.Exec("UPDATE kb_documents SET status = 'pending', error = '' WHERE id = ? AND status IN ('error', 'pending')", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetKBDocument returns a document or ErrNotFound.
func GetKBDocument(db *sql.DB, id int64) (*KBDocument, error) {
	row := db.QueryRow(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents WHERE id = ?`, id)
	var d KBDocument
	var created string
	err := row.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &created, &d.Status, &d.Error)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	d.CreatedAt = parseSQLTime(created)
	return &d, nil
}

// DeleteKBDocument removes a document (FTS row removed by trigger kb_ad).
func DeleteKBDocument(db *sql.DB, id int64) error {
	res, err := db.Exec("DELETE FROM kb_documents WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GrantFolderUser grants folder access to a username (idempotent). An '@'
// group prefix (webadmin convention) is stripped for consistency with the
// marketplace grant API.
func GrantFolderUser(db *sql.DB, folderID int64, username string) error {
	_, err := db.Exec("INSERT OR IGNORE INTO kb_folder_users (folder_id, username) VALUES (?, ?)", folderID, strings.TrimPrefix(username, "@"))
	return err
}

// GrantFolderGroup grants folder access to a group by name (idempotent).
// 组必须已存在(不自动创建):拼错的部门名不得静默建幽灵部门/永不生效
func GrantFolderGroup(db *sql.DB, folderID int64, groupName string) error {
	gid, err := GroupByName(db, groupName)
	if err != nil {
		return err
	}
	_, err = db.Exec("INSERT OR IGNORE INTO kb_folder_groups (folder_id, group_id) VALUES (?, ?)", folderID, gid)
	return err
}

// RevokeFolderUser removes a username grant (idempotent). Permission checks
// run at query time, so revoking takes effect immediately.
func RevokeFolderUser(db *sql.DB, folderID int64, username string) error {
	_, err := db.Exec("DELETE FROM kb_folder_users WHERE folder_id = ? AND username = ?", folderID, username)
	return err
}

// RevokeFolderGroup removes a group grant by name (idempotent).
// 组名匹配 NOCASE:与授权解析口径一致,大小写变体的 revoke 不得静默失效
func RevokeFolderGroup(db *sql.DB, folderID int64, groupName string) error {
	_, err := db.Exec("DELETE FROM kb_folder_groups WHERE folder_id = ? AND group_id = (SELECT id FROM groups WHERE name = ? COLLATE NOCASE)", folderID, groupName)
	return err
}

// ListKBFolderGrants returns usernames and group names granted on a folder.
func ListKBFolderGrants(db *sql.DB, folderID int64) (users, groups []string, err error) {
	rows, err := db.Query("SELECT username FROM kb_folder_users WHERE folder_id = ? ORDER BY username", folderID)
	if err != nil {
		return nil, nil, err
	}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			rows.Close()
			return nil, nil, err
		}
		users = append(users, u)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows, err = db.Query(`SELECT g.name FROM kb_folder_groups kfg JOIN groups g ON g.id = kfg.group_id
		WHERE kfg.folder_id = ? ORDER BY g.name`, folderID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var g string
		if err := rows.Scan(&g); err != nil {
			return nil, nil, err
		}
		groups = append(groups, g)
	}
	return users, groups, rows.Err()
}

// UpdateKBDocument overwrites title/content/content_type and recomputes size.
// The FTS index is synced by trigger kb_au; ErrNotFound when id is missing.
func UpdateKBDocument(db *sql.DB, id int64, title, content, contentType string) error {
	res, err := db.Exec(`UPDATE kb_documents SET title = ?, content = ?, content_type = ?, size = ?
		WHERE id = ?`, title, content, contentType, len(content), id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// GetAccessibleFolderIDs returns folder ids the user can access: direct user
// grants and grants through the given groups. Strict default: folder 0
// (global root) is NOT implicitly accessible — every folder, root included,
// must be explicitly granted (permission round: 部门隔离). Admins bypass
// this via the admin search/upload APIs, not through this helper.
func GetAccessibleFolderIDs(db *sql.DB, username string, groups []string) ([]int64, error) {
	var sb strings.Builder
	sb.WriteString("SELECT folder_id FROM kb_folder_users WHERE username = ?")
	args := []any{username}
	if len(groups) > 0 {
		sb.WriteString(" UNION SELECT folder_id FROM kb_folder_groups WHERE group_id IN (SELECT id FROM groups WHERE name IN (")
		for i, g := range groups {
			if i > 0 {
				sb.WriteString(",")
			}
			sb.WriteString("?")
			args = append(args, g)
		}
		sb.WriteString("))")
	}
	rows, err := db.Query("SELECT DISTINCT folder_id FROM ("+sb.String()+")", args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// AuditLog appends a knowledge base audit entry.
func AuditLog(db *sql.DB, username, action, detail string) error {
	_, err := db.Exec("INSERT INTO kb_audit_logs (username, action, detail) VALUES (?, ?, ?)", username, action, detail)
	return err
}

// ListAuditLogs returns the most recent audit entries (limit <= 0: 50).
func ListAuditLogs(db *sql.DB, limit int) ([]KBAuditLog, error) {
	if limit <= 0 {
		limit = 50
	}
	logs, _, err := ListAuditLogsPaged(db, 0, limit)
	return logs, err
}

// ListAuditLogsPaged returns one page of audit entries (newest first) and the
// total count.
func ListAuditLogsPaged(db *sql.DB, offset, limit int) ([]KBAuditLog, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_audit_logs").Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query("SELECT id, username, action, detail, created_at FROM kb_audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []KBAuditLog
	for rows.Next() {
		var l KBAuditLog
		var created string
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// ListKBDocuments returns documents in a folder ordered by id desc.
func ListKBDocuments(db *sql.DB, folderID int64) ([]KBDocument, error) {
	docs, _, err := ListKBDocumentsPaged(db, folderID, 0, 100000)
	return docs, err
}

// CountKBDocumentsByStatus returns per-status document counts for a folder
// (folderID 0 = all folders) plus the newest error rows (maxErrors <= 0: 20)
// — the ingestion progress dashboard (batch import).
func CountKBDocumentsByStatus(db *sql.DB, folderID int64, maxErrors int) (map[string]int64, []KBDocument, error) {
	if maxErrors <= 0 {
		maxErrors = 20
	}
	where := ""
	args := []any{}
	if folderID > 0 {
		where = " WHERE folder_id = ?"
		args = append(args, folderID)
	}
	rows, err := db.Query("SELECT status, COUNT(*) FROM kb_documents"+where+" GROUP BY status", args...)
	if err != nil {
		return nil, nil, err
	}
	counts := map[string]int64{}
	for rows.Next() {
		var status string
		var n int64
		if err := rows.Scan(&status, &n); err != nil {
			rows.Close()
			return nil, nil, err
		}
		counts[status] = n
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	rows, err = db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents WHERE status = 'error'`+where+` ORDER BY id DESC LIMIT ?`, append(args, maxErrors)...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var errs []KBDocument
	for rows.Next() {
		var d KBDocument
		var created string
		if err := rows.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &created, &d.Status, &d.Error); err != nil {
			return nil, nil, err
		}
		d.CreatedAt = parseSQLTime(created)
		errs = append(errs, d)
	}
	return counts, errs, rows.Err()
}

// ListKBDocumentsPaged returns one page of documents (newest first) and the
// total count for the folder.
func ListKBDocumentsPaged(db *sql.DB, folderID int64, offset, limit int) ([]KBDocument, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_documents WHERE folder_id = ?", folderID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents WHERE folder_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, folderID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []KBDocument
	for rows.Next() {
		var d KBDocument
		var createdAt string
		if err := rows.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &createdAt, &d.Status, &d.Error); err != nil {
			return nil, 0, err
		}
		d.CreatedAt = parseSQLTime(createdAt)
		out = append(out, d)
	}
	return out, total, rows.Err()
}

// ListAllKBDocumentsPaged returns one page of documents across every folder
// (folder_id=-1 admin view, 审计 M4), newest first.
func ListAllKBDocumentsPaged(db *sql.DB, offset, limit int) ([]KBDocument, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM kb_documents").Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query(`SELECT id, folder_id, title, content, content_type, size, source, created_by, created_at, status, error
		FROM kb_documents ORDER BY id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []KBDocument
	for rows.Next() {
		var d KBDocument
		var createdAt string
		if err := rows.Scan(&d.ID, &d.FolderID, &d.Title, &d.Content, &d.ContentType, &d.Size, &d.Source, &d.CreatedBy, &createdAt, &d.Status, &d.Error); err != nil {
			return nil, 0, err
		}
		d.CreatedAt = parseSQLTime(createdAt)
		out = append(out, d)
	}
	return out, total, rows.Err()
}

// ListAuditLogsPagedFiltered returns one page of audit entries (newest
// first) optionally filtered by action/username (审计 M8), plus the total
// for the filtered set.
func ListAuditLogsPagedFiltered(db *sql.DB, offset, limit int, action, username string) ([]KBAuditLog, int64, error) {
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
	countQ := "SELECT COUNT(*) FROM kb_audit_logs"
	if where != "" {
		countQ += " WHERE " + where
	}
	if err := db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := "SELECT id, username, action, detail, created_at FROM kb_audit_logs"
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
	var out []KBAuditLog
	for rows.Next() {
		var l KBAuditLog
		var created string
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}
