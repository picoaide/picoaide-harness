package serverstore

import (
	"database/sql"
	"errors"
	"time"

	"github.com/picoaide/picoaide/internal/util"
)

// AgentPresetStatus is the review state of one shared agent preset.
type AgentPresetStatus string

const (
	// AgentPresetPending awaits an admin review decision.
	AgentPresetPending AgentPresetStatus = "pending"
	// AgentPresetApproved is visible and installable by every employee.
	AgentPresetApproved AgentPresetStatus = "approved"
	// AgentPresetRejected is invisible to everyone but its author, who may
	// resubmit the same name+version (the row is reused, reset to pending).
	AgentPresetRejected AgentPresetStatus = "rejected"
)

// AgentPreset is one shared agent preset row (unique by name+version).
type AgentPreset struct {
	ID          int64
	Name        string
	DisplayName string
	Description string
	Version     string
	Author      string
	Checksum    string
	Status      AgentPresetStatus
	// Reason is the admin's rejection reason; empty unless the row is
	// rejected. Visible only to the author (and admins).
	Reason    string
	CreatedAt time.Time
	UpdatedAt time.Time
}

func scanAgentPreset(row interface{ Scan(...any) error }) (*AgentPreset, error) {
	var p AgentPreset
	var createdAt, updatedAt any
	if err := row.Scan(&p.ID, &p.Name, &p.DisplayName, &p.Description, &p.Version,
		&p.Author, &p.Checksum, &p.Status, &p.Reason, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	p.CreatedAt = parseSQLTime(createdAt)
	p.UpdatedAt = parseSQLTime(updatedAt)
	return &p, nil
}

const agentPresetColumns = "id, name, display_name, description, version, author, checksum, status, reason, created_at, updated_at"

// CreateAgentPreset inserts a pending row; returns ErrDuplicate for an
// existing name+version (any status).
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

// CreateAgentPresetCapped inserts a fresh pending row when the author is
// below pendingCap, atomically: the INSERT itself re-counts the author's
// pending rows, so concurrent uploads can never exceed the cap. Returns
// ErrTooManyPending when the author is at the cap and ErrDuplicate when the
// name+version is taken (any status).
func CreateAgentPresetCapped(db *sql.DB, p *AgentPreset, pendingCap int) (int64, error) {
	q := `INSERT INTO agent_presets (name, display_name, description, version, author, checksum, status)
		SELECT ?, ?, ?, ?, ?, ?, ?
		WHERE (SELECT COUNT(*) FROM agent_presets WHERE author = ? AND status = ?) < ?`
	args := []any{
		p.Name, p.DisplayName, p.Description, p.Version, p.Author, p.Checksum, p.Status,
		p.Author, AgentPresetPending, pendingCap,
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

// GetAgentPreset returns the row by name (latest version when multiple).
// 审计 2026-08-25 D-1:SQL 的 `ORDER BY version DESC` 是字符串字典序
// ("1.9.0" > "1.10.0" 错序);改为 Go 层按 CompareSemVer 数字感知比较取最大。
func GetAgentPreset(db *sql.DB, name string) (*AgentPreset, error) {
	rows, err := db.Query(`SELECT `+agentPresetColumns+` FROM agent_presets WHERE name = ?`, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var best *AgentPreset
	for rows.Next() {
		p, err := scanAgentPreset(rows)
		if err != nil {
			return nil, err
		}
		if best == nil || util.CompareSemVer(p.Version, best.Version) > 0 {
			best = p
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if best == nil {
		return nil, ErrNotFound
	}
	return best, nil
}

// GetAgentPresetByVersion returns the row by name+version or ErrNotFound.
func GetAgentPresetByVersion(db *sql.DB, name, version string) (*AgentPreset, error) {
	p, err := scanAgentPreset(db.QueryRow(`SELECT `+agentPresetColumns+` FROM agent_presets WHERE name = ? AND version = ?`, name, version))
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
	q += " ORDER BY name, version"
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

// ListVisibleAgentPresets returns the rows an employee may see: approved
// rows the caller is GRANTED plus the caller's own rows in any status
// (nobody else's non-approved rows are ever visible). Strict default:
// approved but not granted stays invisible.
func ListVisibleAgentPresets(db *sql.DB, author string, granted []string) ([]AgentPreset, error) {
	rows, err := db.Query(`SELECT `+agentPresetColumns+` FROM agent_presets
		WHERE author = ?
		OR (status = ? AND name IN (`+qmarks(len(granted))+`))
		ORDER BY name, version`, append([]any{author, AgentPresetApproved}, toStringArgs(granted)...)...)
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
// pending on resubmit) in one atomic UPDATE. Approving clears any stored
// rejection reason; rejecting stores the admin's reason, which is returned
// to the author and cleared again on resubmit. Updates the name's LATEST
// version only (legacy single-param callers).
func SetAgentPresetStatus(db *sql.DB, name string, status AgentPresetStatus, reason string) error {
	_, err := db.Exec(`UPDATE agent_presets SET status=?, reason=?, updated_at=`+NowExpr()+`
		WHERE id = (SELECT id FROM agent_presets WHERE name=? ORDER BY version DESC, id DESC LIMIT 1)`,
		status, reason, name)
	return err
}

// SetAgentPresetStatusByVersion transitions one name+version row.
func SetAgentPresetStatusByVersion(db *sql.DB, name, version string, status AgentPresetStatus, reason string) error {
	_, err := db.Exec(`UPDATE agent_presets SET status=?, reason=?, updated_at=`+NowExpr()+` WHERE name=? AND version=?`,
		status, reason, name, version)
	return err
}

// UpdateAgentPresetResubmit resets a rejected row to pending for resubmission
// of the same name, replacing display metadata, archive checksum, and clearing
// the stored rejection reason. Updates the name's LATEST version only.
func UpdateAgentPresetResubmit(db *sql.DB, name, displayName, description, checksum string) error {
	_, err := db.Exec(`UPDATE agent_presets SET display_name=?, description=?, checksum=?, status=?, reason='',
		updated_at=`+NowExpr()+`
		WHERE id = (SELECT id FROM agent_presets WHERE name=? ORDER BY version DESC, id DESC LIMIT 1) AND status=?`,
		displayName, description, checksum, AgentPresetPending, name, AgentPresetRejected)
	return err
}

// UpdateAgentPresetResubmitByVersion resets one rejected name+version row
// owned by the given author (author 校验,审计 2026-08-25 G1 深度防御)。
func UpdateAgentPresetResubmitByVersion(db *sql.DB, name, version, displayName, description, checksum, author string) error {
	res, err := db.Exec(`UPDATE agent_presets SET display_name=?, description=?, checksum=?, status=?, reason='',
		updated_at=`+NowExpr()+`
		WHERE name=? AND version=? AND status=? AND author=?`,
		displayName, description, checksum, AgentPresetPending, name, version, AgentPresetRejected, author)
	if err != nil {
		return err
	}
	// 审计 2026-08-25 复查【2】:0 行 = 行被并发 approve/rejected 状态已变,
	// 静默 201 会掩盖状态不一致;返回 ErrNotFound 让路由明确报错。
	if n, err2 := res.RowsAffected(); err2 == nil && n == 0 {
		return ErrNotFound
	}
	return nil
}

// DeleteAgentPreset removes ALL rows of the name; returns ErrNotFound when
// none existed.
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

// DeleteAgentPresetByVersion removes one name+version row; returns
// ErrNotFound when absent.
func DeleteAgentPresetByVersion(db *sql.DB, name, version string) error {
	res, err := db.Exec(`DELETE FROM agent_presets WHERE name=? AND version=?`, name, version)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
