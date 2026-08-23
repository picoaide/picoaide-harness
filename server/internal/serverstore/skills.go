package serverstore

import (
	"database/sql"
	"errors"
	"time"
)

// Skill is a marketplace skill row.
type Skill struct {
	ID          int64
	Name        string
	Version     string
	Description string
	Author      string
	GitURL      string
	GitRef      string
	Checksum    string
	Enabled     int
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

func scanSkill(row interface{ Scan(...any) error }) (*Skill, error) {
	var s Skill
	var createdAt, updatedAt any
	if err := row.Scan(&s.ID, &s.Name, &s.Version, &s.Description, &s.Author,
		&s.GitURL, &s.GitRef, &s.Checksum, &s.Enabled, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	s.CreatedAt = parseSQLTime(createdAt)
	s.UpdatedAt = parseSQLTime(updatedAt)
	return &s, nil
}

const skillColumns = "id, name, version, description, author, git_url, git_ref, checksum, enabled, created_at, updated_at"

// AddSkill inserts a skill row; returns ErrDuplicate for an existing name.
func AddSkill(db *sql.DB, s *Skill) (int64, error) {
	id, err := InsertID(db, `INSERT INTO skills (name, version, description, author, git_url, git_ref, checksum, enabled)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		s.Name, s.Version, s.Description, s.Author, s.GitURL, s.GitRef, s.Checksum, s.Enabled)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// GetSkill returns the skill by unique name or ErrNotFound.
func GetSkill(db *sql.DB, name string) (*Skill, error) {
	s, err := scanSkill(db.QueryRow(`SELECT `+skillColumns+` FROM skills WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return s, err
}

// UpdateSkill updates all mutable fields by id; returns ErrNotFound.
func UpdateSkill(db *sql.DB, s *Skill) error {
	res, err := db.Exec(`UPDATE skills SET version=?, description=?, author=?, git_url=?, git_ref=?, checksum=?, enabled=?, updated_at=`+NowExpr()+`
		WHERE id=?`,
		s.Version, s.Description, s.Author, s.GitURL, s.GitRef, s.Checksum, s.Enabled, s.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetSkillEnabled enables/disables a skill (下架 = enabled 0, row kept).
// Returns the skill id or ErrNotFound.
func SetSkillEnabled(db *sql.DB, name string, enabled bool) (int64, error) {
	var id int64
	err := db.QueryRow(`UPDATE skills SET enabled=?, updated_at=`+NowExpr()+` WHERE name=? RETURNING id`,
		boolInt(enabled), name).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return id, err
}

// ListSkills returns all skills, filtered to enabled ones when enabledOnly.
func ListSkills(db *sql.DB, enabledOnly bool) ([]Skill, error) {
	q := `SELECT ` + skillColumns + ` FROM skills`
	if enabledOnly {
		q += ` WHERE enabled = 1`
	}
	q += ` ORDER BY name`
	rows, err := db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Skill
	for rows.Next() {
		s, err := scanSkill(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}
