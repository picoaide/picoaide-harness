package serverstore

import (
	"database/sql"
	"errors"
	"time"
)

// AgentPresetStatus is the review state of one shared agent preset.
type AgentPresetStatus string

const (
	// AgentPresetPending awaits an admin review decision.
	AgentPresetPending AgentPresetStatus = "pending"
	// AgentPresetApproved is visible and installable by every employee.
	AgentPresetApproved AgentPresetStatus = "approved"
	// AgentPresetRejected is invisible to everyone but its author, who may
	// resubmit the same name (the row is reused, reset to pending).
	AgentPresetRejected AgentPresetStatus = "rejected"
)

// AgentPreset is one shared agent preset row.
type AgentPreset struct {
	ID          int64
	Name        string
	DisplayName string
	Description string
	Version     string
	Author      string
	Checksum    string
	Status      AgentPresetStatus
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func scanAgentPreset(row interface{ Scan(...any) error }) (*AgentPreset, error) {
	var p AgentPreset
	var createdAt, updatedAt any
	if err := row.Scan(&p.ID, &p.Name, &p.DisplayName, &p.Description, &p.Version,
		&p.Author, &p.Checksum, &p.Status, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	p.CreatedAt = parseSQLTime(createdAt)
	p.UpdatedAt = parseSQLTime(updatedAt)
	return &p, nil
}

const agentPresetColumns = "id, name, display_name, description, version, author, checksum, status, created_at, updated_at"

// CreateAgentPreset inserts a pending row; returns ErrDuplicate for an
// existing name (any status: pending/approved/rejected all occupy the name).
func CreateAgentPreset(db *sql.DB, p *AgentPreset) (int64, error) {
	id, err := InsertID(db, `INSERT INTO agent_presets (name, display_name, description, version, author, checksum, status)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		p.Name, p.DisplayName, p.Description, p.Version, p.Author, p.Checksum, p.Status)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// GetAgentPreset returns the row by name or ErrNotFound.
func GetAgentPreset(db *sql.DB, name string) (*AgentPreset, error) {
	p, err := scanAgentPreset(db.QueryRow(`SELECT `+agentPresetColumns+` FROM agent_presets WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return p, err
}

// ListAgentPresets returns every row (admin view), oldest first, optionally
// filtered by status ("" = all).
func ListAgentPresets(db *sql.DB, status string) ([]AgentPreset, error) {
	q := `SELECT ` + agentPresetColumns + ` FROM agent_presets`
	args := []any{}
	if status != "" {
		q += " WHERE status = ?"
		args = append(args, status)
	}
	q += " ORDER BY id"
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentPreset
	for rows.Next() {
		p, err := scanAgentPreset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// ListVisibleAgentPresets returns the rows an employee may see: every
// approved preset plus the caller's own rows in any status. Own rows are
// listed even while rejected or pending so the author sees the review state;
// nobody else's non-approved rows are ever visible.
func ListVisibleAgentPresets(db *sql.DB, author string) ([]AgentPreset, error) {
	rows, err := db.Query(`SELECT `+agentPresetColumns+` FROM agent_presets
		WHERE status = ? OR author = ? ORDER BY id`, AgentPresetApproved, author)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentPreset
	for rows.Next() {
		p, err := scanAgentPreset(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *p)
	}
	return out, rows.Err()
}

// SetAgentPresetStatus transitions the row to status (approve/reject/back to
// pending on resubmit). Returns ErrNotFound when the row is absent.
func SetAgentPresetStatus(db *sql.DB, name string, status AgentPresetStatus) error {
	_, err := db.Exec(`UPDATE agent_presets SET status=?, updated_at=`+NowExpr()+` WHERE name=?`, status, name)
	if err != nil {
		return err
	}
	return nil
}

// UpdateAgentPresetResubmit resets a rejected row to pending for resubmission
// of the same name, replacing the description and archive checksum.
func UpdateAgentPresetResubmit(db *sql.DB, name, description, checksum string) error {
	_, err := db.Exec(`UPDATE agent_presets SET description=?, checksum=?, status=?, updated_at=`+NowExpr()+`
		WHERE name=? AND status=?`,
		description, checksum, AgentPresetPending, name, AgentPresetRejected)
	return err
}

// DeleteAgentPreset removes the row; returns ErrNotFound when absent.
func DeleteAgentPreset(db *sql.DB, name string) error {
	res, err := db.Exec(`DELETE FROM agent_presets WHERE name=?`, name)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
