package serverstore

import (
	"database/sql"
	"errors"
	"time"
)

// Skill is a marketplace skill row.
type Skill struct {
	ID   int64
	Name string
	// DisplayName 是展示名(0051):来自包内 SKILL.md 的 frontmatter title,
	// 空值时读侧回退 Name。
	DisplayName string
	Version     string
	Description string
	Author      string
	Checksum    string
	Enabled     int
	// Archive holds the uploaded archive bytes (归档上传是唯一入口)。
	Archive []byte
	// Downloads counts successful archive downloads.
	Downloads int64
	// Calls counts skill invocations reported by clients (telemetry).
	Calls int64
	// DownloadedAt/updated overlay created/updated.
	CreatedAt time.Time
	UpdatedAt time.Time
}

// skillColumns includes the archive blob; used by single-row reads
// (GetSkill) where the archive may be needed. List queries must use
// skillListColumns (no blob) so the catalog never loads every archive.
const skillColumns = "id, name, display_name, version, description, author, checksum, enabled, archive, downloads, calls, created_at, updated_at"

const skillListColumns = "id, name, display_name, version, description, author, checksum, enabled, downloads, calls, created_at, updated_at"

func scanSkill(row interface{ Scan(...any) error }) (*Skill, error) {
	var s Skill
	var createdAt, updatedAt any
	if err := row.Scan(&s.ID, &s.Name, &s.DisplayName, &s.Version, &s.Description, &s.Author,
		&s.Checksum, &s.Enabled, &s.Archive,
		&s.Downloads, &s.Calls, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	s.CreatedAt = parseSQLTime(createdAt)
	s.UpdatedAt = parseSQLTime(updatedAt)
	return &s, nil
}

func scanSkillList(row interface{ Scan(...any) error }) (*Skill, error) {
	var s Skill
	var createdAt, updatedAt any
	if err := row.Scan(&s.ID, &s.Name, &s.DisplayName, &s.Version, &s.Description, &s.Author,
		&s.Checksum, &s.Enabled,
		&s.Downloads, &s.Calls, &createdAt, &updatedAt); err != nil {
		return nil, err
	}
	s.CreatedAt = parseSQLTime(createdAt)
	s.UpdatedAt = parseSQLTime(updatedAt)
	return &s, nil
}

// SkillNameExists reports whether the marketplace skills table has a row
// with the given name (any status/enabled state). Used by the shared-skill
// store's upload/approve conflict check (决策 2026-08-25:市场与组织合并为
// 「市场」后,同名技能跨源互斥——shared_skills 上传/approve 前须确认
// marketplace 无同名)。
func SkillNameExists(db *sql.DB, name string) (bool, error) {
	var n int
	err := db.QueryRow(`SELECT COUNT(*) FROM skills WHERE name = ?`, name).Scan(&n)
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

// AddSkill inserts a skill row; returns ErrDuplicate for an existing name.
// 决策 2026-08-25:双向互斥——shared_skills 已存在同名技能(任意状态)时
// 返回 ErrConflict(admin 上架市场技能前检测)。
func AddSkill(db *sql.DB, s *Skill) (int64, error) {
	if conflict, err := SharedSkillNameExists(db, s.Name); err != nil {
		return 0, err
	} else if conflict {
		return 0, ErrConflict
	}
	id, err := InsertID(db, `INSERT INTO skills (name, display_name, version, description, author, checksum, enabled, archive, downloads, calls)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
		s.Name, s.DisplayName, s.Version, s.Description, s.Author, s.Checksum, s.Enabled, s.Archive)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// GetSkill returns the skill by unique name or ErrNotFound. The row carries
// the archive blob (single-row read; list reads use
// ListSkills which skips the blob).
func GetSkill(db *sql.DB, name string) (*Skill, error) {
	s, err := scanSkill(db.QueryRow(`SELECT `+skillColumns+` FROM skills WHERE name = ?`, name))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return s, err
}

// UpdateSkill updates all mutable fields by id; returns ErrNotFound. Archive
// is written only when non-nil(元数据编辑不得清空已上传的归档)。
func UpdateSkill(db *sql.DB, s *Skill) error {
	res, err := db.Exec(`UPDATE skills SET display_name=?, version=?, description=?, author=?, checksum=?, enabled=?, archive=COALESCE(?, archive), updated_at=`+NowExpr()+`
		WHERE id=?`,
		s.DisplayName, s.Version, s.Description, s.Author, s.Checksum, s.Enabled,
		anyBytes(s.Archive), s.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// ReplaceSkillArchive stores a new archive with its version/checksum
// (归档是唯一内容来源)。Returns ErrNotFound when the name is absent.
func ReplaceSkillArchive(db *sql.DB, name, version, checksum string, archive []byte) error {
	res, err := db.Exec(`UPDATE skills SET version=?, checksum=?, archive=?,
		updated_at=`+NowExpr()+` WHERE name=?`,
		version, checksum, archive, name)
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
// The list query excludes the archive blob (catalog reads must not load
// every upload into memory).
func ListSkills(db *sql.DB, enabledOnly bool) ([]Skill, error) {
	q := `SELECT ` + skillListColumns + ` FROM skills`
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
		s, err := scanSkillList(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *s)
	}
	return out, rows.Err()
}

// IncrementSkillDownload bumps the marketplace download counter by name.
// Returns whether a row matched (best effort: the header is authoritative).
func IncrementSkillDownload(db *sql.DB, name string) (bool, error) {
	res, err := db.Exec(`UPDATE skills SET downloads = downloads + 1 WHERE name=?`, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// IncrementSkillCall bumps the call counter: shared_skills by name+version
// when present, otherwise the marketplace row by name. Returns whether any
// row matched (unknown/local skills are ignored by design).
func IncrementSkillCall(db *sql.DB, name, version string) (bool, error) {
	if version != "" {
		res, err := db.Exec(`UPDATE shared_skills SET calls = calls + 1 WHERE name=? AND version=?`, name, version)
		if err != nil {
			return false, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return true, nil
		}
	}
	res, err := db.Exec(`UPDATE skills SET calls = calls + 1 WHERE name=?`, name)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// anyBytes converts a nil byte slice to nil (SQL NULL) for the CASE guard.
func anyBytes(b []byte) any {
	if b == nil {
		return nil
	}
	return b
}

// SetSkillDisplayName 写入市场技能的展示名(0051)。发布/规范化时从包内
// SKILL.md 的 frontmatter title 取值——「包内即真相」在读侧的落点。
func SetSkillDisplayName(db *sql.DB, name, displayName string) error {
	res, err := db.Exec(`UPDATE skills SET display_name=?, updated_at=`+NowExpr()+` WHERE name=?`,
		displayName, name)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
