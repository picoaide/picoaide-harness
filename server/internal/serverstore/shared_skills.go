package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// qmarks builds an n-item comma-separated `?,?` list for IN clauses.
func qmarks(n int) string {
	if n <= 0 {
		return "''"
	}
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// toStringArgs converts a string slice to []any (IN clause args).
func toStringArgs(names []string) []any {
	out := make([]any, len(names))
	for i, n := range names {
		out[i] = n
	}
	return out
}

// SharedSkillStatus is the review state of one shared skill row.
type SharedSkillStatus string

const (
	// SharedSkillPending awaits an admin review decision.
	SharedSkillPending SharedSkillStatus = "pending"
	// SharedSkillApproved is visible and installable by every employee.
	SharedSkillApproved SharedSkillStatus = "approved"
	// SharedSkillRejected is invisible to everyone but its author, who may
	// resubmit the same name+version (the row is reused, reset to pending).
	SharedSkillRejected SharedSkillStatus = "rejected"
)

// SharedSkill is one shared skill row (unique by name+version).
type SharedSkill struct {
	ID          int64
	Name        string
	DisplayName string
	Version     string
	Description string
	Author      string
	Checksum    string
	Status      SharedSkillStatus
	// Reason is the admin's rejection reason; empty unless rejected.
	Reason    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func scanSharedSkill(row interface{ Scan(...any) error }) (*SharedSkill, error) {
	var s SharedSkill
	var createdAt, updatedAt any
	if err := row.Scan(&s.ID, &s.Name, &s.DisplayName, &s.Version, &s.Description,
		&s.Author, &s.Checksum, &s.Status, &s.Reason, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	s.CreatedAt = parseSQLTime(createdAt)
	s.UpdatedAt = parseSQLTime(updatedAt)
	return &s, nil
}

const sharedSkillColumns = "id, name, display_name, version, description, author, checksum, status, reason, created_at, updated_at"

// CreateSharedSkill inserts a pending row (unique name+version); returns
// ErrDuplicate when that exact version already exists in any status.
func CreateSharedSkill(db *sql.DB, s *SharedSkill) (int64, error) {
	id, err := InsertID(db, `INSERT INTO shared_skills (name, display_name, version, description, author, checksum, status)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		s.Name, s.DisplayName, s.Version, s.Description, s.Author, s.Checksum, s.Status)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// CreateSharedSkillCapped inserts a fresh pending row when the author is below
// pendingCap, atomically (the INSERT re-counts pending rows for the author).
// Returns ErrTooManyPending when at the cap; ErrDuplicate when name+version
// exist (any status).
func CreateSharedSkillCapped(db *sql.DB, s *SharedSkill, pendingCap int) (int64, error) {
	q := `INSERT INTO shared_skills (name, display_name, version, description, author, checksum, status)
		SELECT ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM shared_skills WHERE author = ? AND status = ?) < ?`
	args := []any{
		s.Name, s.DisplayName, s.Version, s.Description, s.Author, s.Checksum, s.Status,
		s.Author, SharedSkillPending, pendingCap,
	}
	if currentDriver == DriverPG {
		var id int64
		err := db.QueryRow(q+" RETURNING id", args...).Scan(&id)
		if errors.Is(err, sql.ErrNoRows) {
			return 0, ErrTooManyPending
		}
		if err != nil {
			if isUniqueViolation(err) {
				return 0, ErrDuplicate
			}
			return 0, err
		}
		return id, nil
	}
	res, err := db.Exec(q, args...)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	if n, err := res.RowsAffected(); err == nil && n == 0 {
		return 0, ErrTooManyPending
	}
	return res.LastInsertId()
}

// GetSharedSkill returns the row by name+version or ErrNotFound.
func GetSharedSkill(db *sql.DB, name, version string) (*SharedSkill, error) {
	s, err := scanSharedSkill(db.QueryRow(`SELECT `+sharedSkillColumns+` FROM shared_skills WHERE name = ? AND version = ?`, name, version))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return s, err
}

// ListSharedSkills returns every row (admin view), oldest first, optionally
// filtered by status ("" = all).
func ListSharedSkills(db *sql.DB, status string) ([]SharedSkill, error) {
	q := `SELECT ` + sharedSkillColumns + ` FROM shared_skills`
	args := []any{}
	if status != "" {
		q += " WHERE status = ?"
		args = append(args, status)
	}
	q += " ORDER BY name, version"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SharedSkill
	for rows.Next() {
		s, err := scanSharedSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// ListVisibleSharedSkills returns the rows an employee may see: approved
// rows the caller is GRANTED (user or via groups) plus the caller's own rows
// in any status (an author always sees their own submissions). Strict
// default: approved but not granted stays invisible.
func ListVisibleSharedSkills(db *sql.DB, author string, granted []string) ([]SharedSkill, error) {
	rows, err := db.Query(`SELECT `+sharedSkillColumns+` FROM shared_skills
		WHERE author = ?
		OR (status = ? AND name IN (`+qmarks(len(granted))+`))
		ORDER BY name, version`, append([]any{author, SharedSkillApproved}, toStringArgs(granted)...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SharedSkill
	for rows.Next() {
		s, err := scanSharedSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// SetSharedSkillStatus transitions the row (approve/reject/resubmit) and
// stores/clears the rejection reason in one atomic UPDATE.
func SetSharedSkillStatus(db *sql.DB, name, version string, status SharedSkillStatus, reason string) error {
	_, err := db.Exec(`UPDATE shared_skills SET status=?, reason=?, updated_at=`+NowExpr()+`
		WHERE name=? AND version=?`, status, reason, name, version)
	return err
}

// UpdateSharedSkillResubmit resets a rejected row to pending for resubmission
// of the same name+version, replacing metadata/checksum and clearing reason.
// author 校验(审计 2026-08-25 G1 深度防御):只有行作者本人可重提。
func UpdateSharedSkillResubmit(db *sql.DB, name, version, displayName, description, checksum, author string) error {
	_, err := db.Exec(`UPDATE shared_skills SET display_name=?, description=?, checksum=?, status=?, reason='',
		updated_at=`+NowExpr()+`
		WHERE name=? AND version=? AND status=? AND author=?`,
		displayName, description, checksum, SharedSkillPending, name, version, SharedSkillRejected, author)
	return err
}

// DeleteSharedSkill removes the row; returns ErrNotFound when absent.
func DeleteSharedSkill(db *sql.DB, name, version string) error {
	res, err := db.Exec(`DELETE FROM shared_skills WHERE name=? AND version=?`, name, version)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SharedSkillPendingCount returns the author's pending row count.
func SharedSkillPendingCount(db *sql.DB, author string) (int, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM shared_skills WHERE author=? AND status=?`, author, SharedSkillPending).Scan(&n)
	return n, err
}
