package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/picoaide/picoaide/internal/util"
)

type User struct {
	ID           int64
	Username     string
	DisplayName  string
	Email        string
	PasswordHash string
	Source       string
	// Role is the RBAC role: "super_admin" | "auditor" | "user".
	// Replaces the legacy is_admin boolean (which remains in the schema
	// for historical dump compatibility but is never written with new values).
	Role    string
	IsAdmin bool
	Status  int
	// QuotaTokens is the per-user monthly traffic quota in tokens (0017):
	// nil = follow the global default, 0 = unlimited, >0 = capped.
	// Admins are always unlimited regardless of this value.
	QuotaTokens *int64
	// QuotaMoney is the per-user monthly traffic quota in yuan (0022):
	// nil = follow the global default (usage.monthly_quota_money), 0 = unlimited,
	// >0 = capped. Admins are always unlimited regardless of this value.
	QuotaMoney *float64
	CreatedAt  time.Time
	UpdatedAt  time.Time
}

// Role constants (RBAC, design v3b).
const (
	RoleSuperAdmin = "super_admin"
	RoleAuditor    = "auditor"
	RoleUser       = "user"
)

// ValidRole reports whether role is one of the known RBAC roles.
func ValidRole(role string) bool {
	return role == RoleSuperAdmin || role == RoleAuditor || role == RoleUser
}

// IsAdminRole reports whether the role grants webadmin access (admin session).
// auditor is allowed into the portal (read-only), user is not.
func IsAdminRole(role string) bool {
	return role == RoleSuperAdmin || role == RoleAuditor
}

// userCols is the canonical user column list (kept in sync with scanUser).
const userCols = "id, username, display_name, email, password_hash, source, is_admin, role, status, created_at, updated_at, quota_tokens, quota_money"

// CreateUserWithPassword creates a local user, hashing the plaintext password.
func CreateUserWithPassword(db *sql.DB, username, password string) (int64, error) {
	hash, err := util.HashPassword(password)
	if err != nil {
		return 0, err
	}
	return CreateUser(db, &User{Username: username, PasswordHash: hash, Source: "local", Status: 1})
}

// dummyPasswordHash is verified against when the account is missing,
// non-local, or disabled, so response time does not reveal username/state.
var dummyPasswordHash = func() string {
	h, err := util.HashPassword("picoaide-dummy-constant")
	if err != nil {
		panic(err)
	}
	return h
}()

// AuthenticateLocal verifies username/password against the users table.
// Returns ErrNotFound for unknown users or wrong password.
func AuthenticateLocal(db *sql.DB, username, password string) (User, error) {
	u, err := GetUserByUsername(db, username)
	if err != nil {
		util.VerifyPassword(dummyPasswordHash, password)
		return User{}, ErrNotFound
	}
	if u.Source != "local" || u.PasswordHash == "" || u.Status != 1 {
		util.VerifyPassword(dummyPasswordHash, password)
		return User{}, ErrNotFound
	}
	if !util.VerifyPassword(u.PasswordHash, password) {
		return User{}, ErrNotFound
	}
	return *u, nil
}

func scanUser(row interface{ Scan(...any) error }) (*User, error) {
	var u User
	var isAdmin, status int
	var displayName, email, passwordHash, role sql.NullString
	var quota sql.NullInt64
	var quotaMoney sql.NullFloat64
	var createdAt, updatedAt any
	if err := row.Scan(&u.ID, &u.Username, &displayName, &email, &passwordHash, &u.Source, &isAdmin, &role, &status, &createdAt, &updatedAt, &quota, &quotaMoney); err != nil {
		return nil, err
	}
	u.CreatedAt = parseSQLTime(createdAt)
	u.UpdatedAt = parseSQLTime(updatedAt)
	u.DisplayName = displayName.String
	u.Email = email.String
	u.PasswordHash = passwordHash.String
	u.Role = role.String
	if u.Role == "" {
		// Fallback for rows created before the role migration: derive from
		// the legacy flag so IsSuperAdmin() stays correct during the window.
		if u.IsAdmin {
			u.Role = RoleSuperAdmin
		} else {
			u.Role = RoleUser
		}
	}
	// Keep the legacy field in sync with the RBAC role (dump compatibility).
	u.IsAdmin = u.Role == RoleSuperAdmin
	u.Status = status
	if quota.Valid {
		u.QuotaTokens = &quota.Int64
	}
	if quotaMoney.Valid {
		u.QuotaMoney = &quotaMoney.Float64
	}
	return &u, nil
}

// IsSuperAdmin reports whether the role is super_admin (RBAC single source).
// Prefer this over the legacy IsAdmin field for authorization decisions.
func (u *User) IsSuperAdmin() bool { return u.Role == RoleSuperAdmin }

// HasManagementAccess reports whether the role may enter the webadmin portal.
func (u *User) HasManagementAccess() bool { return IsAdminRole(u.Role) }

// resolveRole derives the RBAC role for writes. The legacy IsAdmin flag is
// the compatibility source of truth for existing callers (all of which toggle
// IsAdmin, not Role): IsAdmin=true always maps to super_admin; IsAdmin=false
// keeps an explicit valid Role (auditor) or falls back to user.
func resolveRole(role string, isAdmin bool) string {
	if isAdmin {
		return RoleSuperAdmin
	}
	if ValidRole(role) {
		return role
	}
	return RoleUser
}

// CreateUser inserts a user row and returns its id.
func CreateUser(db *sql.DB, u *User) (int64, error) {
	role := resolveRole(u.Role, u.IsAdmin)
	id, err := InsertID(db, `INSERT INTO users (username, display_name, email, password_hash, source, is_admin, role, status, quota_tokens, quota_money)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		u.Username, nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		u.Source, boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney))
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// GetUserByUsername returns the user or ErrNotFound.
func GetUserByUsername(db *sql.DB, username string) (*User, error) {
	row := db.QueryRow(`SELECT `+userCols+`
		FROM users WHERE username = ?`, username)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

func GetUserByID(db *sql.DB, id int64) (*User, error) {
	row := db.QueryRow(`SELECT `+userCols+`
		FROM users WHERE id = ?`, id)
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// UpdateUser updates display_name/email/password_hash/is_admin/role/status.
func UpdateUser(db *sql.DB, u *User) error {
	role := resolveRole(u.Role, u.IsAdmin)
	res, err := db.Exec(`UPDATE users SET display_name=?, email=?, password_hash=?, is_admin=?, role=?, status=?, quota_tokens=?, quota_money=?, updated_at=`+NowExpr()+`
		WHERE id=?`,
		nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney), u.ID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// UpdateUserRevokingTokens 在同一事务内更新用户并吊销其全部 token:
// 改密/降权/禁用后旧凭证必须与权限变更原子生效(审计2026-L16)
func UpdateUserRevokingTokens(db *sql.DB, u *User) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	role := resolveRole(u.Role, u.IsAdmin)
	res, err := tx.Exec(`UPDATE users SET display_name=?, email=?, password_hash=?, is_admin=?, role=?, status=?, quota_tokens=?, quota_money=?, updated_at=`+NowExpr()+`
		WHERE id=?`,
		nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney), u.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec("DELETE FROM api_tokens WHERE user_id = ?", u.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// ListUsers returns a page of users and the total count. q filters by
// username substring (empty q = all users).
//
// NOTE(审计 L5):搜索词含 LIKE 通配符(%/_)时不得按通配匹配全部/任意单字符;
// 故用
// POSITION(lower(?) IN lower(username)) > 0:纯子串匹配、无通配符语义,
// 大小写不敏感(PG 端 POSITION/LOWER 组合)。
func ListUsers(db *sql.DB, offset, limit int, q string) ([]User, int64, error) {
	q = strings.TrimSpace(q)
	var total int64
	var rows *sql.Rows
	var err error
	if q == "" {
		if err = db.QueryRow("SELECT COUNT(*) FROM users").Scan(&total); err != nil {
			return nil, 0, err
		}
		rows, err = db.Query(`SELECT `+userCols+`
			FROM users ORDER BY id LIMIT ? OFFSET ?`, limit, offset)
	} else {
		if err = db.QueryRow("SELECT COUNT(*) FROM users WHERE POSITION(lower(?) IN lower(username)) > 0", q).Scan(&total); err != nil {
			return nil, 0, err
		}
		rows, err = db.Query(`SELECT `+userCols+`
			FROM users WHERE POSITION(lower(?) IN lower(username)) > 0 ORDER BY id LIMIT ? OFFSET ?`, q, limit, offset)
	}
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var users []User = []User{}
	for rows.Next() {
		u, err := scanUser(rows)
		if err != nil {
			return nil, 0, err
		}
		users = append(users, *u)
	}
	return users, total, rows.Err()
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	// PG: ERROR: duplicate key value violates unique constraint "x" (SQLSTATE 23505)
	// SQLite: UNIQUE constraint failed: users.username
	if strings.Contains(msg, "SQLSTATE 23505") || strings.Contains(msg, "23505") {
		return true
	}
	return strings.Contains(msg, "UNIQUE") || strings.Contains(msg, "unique constraint") || strings.Contains(msg, "duplicate key")
}

const sqlTimeFormat = "2006-01-02 15:04:05"

// formatTimeString normalizes a scanned timestamp value into the SQLite
// wall-clock string format ("2006-01-02 15:04:05", local time). PG scans
// TIMESTAMPTZ as time.Time; SQLite returns / the driver yields the stored
// string. Used to back the Token.CreatedAt string field (API contract).
func formatTimeString(v any) string {
	switch x := v.(type) {
	case time.Time:
		return x.In(time.Local).Format(sqlTimeFormat)
	case string:
		return x
	case []byte:
		return string(x)
	}
	return ""
}

// parseSQLTime parses a SQLite DATETIME / PG TIMESTAMPTZ value into a local
// time.Time. SQLite writes datetime('now','localtime') — wall-clock strings
// with no zone — so bare strings must be interpreted in the local timezone:
// time.Parse would treat them as UTC, making time.Since() negative in non-UTC
// environments and breaking age-based logic such as the KB queue orphan
// sweep. RFC3339 values carry their own offset and are unaffected by the
// location argument. PG scans TIMESTAMPTZ directly as a time.Time (already
// UTC), so passthrough-and-In(Local) keeps the local-time semantics.
func parseSQLTime(s any) time.Time {
	switch v := s.(type) {
	case time.Time:
		return v.In(time.Local)
	case string:
		for _, f := range []string{sqlTimeFormat, time.RFC3339} {
			if t, err := time.ParseInLocation(f, v, time.Local); err == nil {
				return t
			}
		}
	case []byte:
		str := string(v)
		for _, f := range []string{sqlTimeFormat, time.RFC3339} {
			if t, err := time.ParseInLocation(f, str, time.Local); err == nil {
				return t
			}
		}
	}
	return time.Time{}
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// nilIfNilInt64 maps a nil *int64 to SQL NULL (tri-state quota_tokens).
func nilIfNilInt64(v *int64) any {
	if v == nil {
		return nil
	}
	return *v
}

// nilIfNilFloat64 maps a nil *float64 to SQL NULL (tri-state quota_money).
func nilIfNilFloat64(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

// DeleteUser removes a user and all their FK-referenced rows
// (api_tokens, usage, admin_sessions, user_groups) in a single transaction
// so deletion never trips the FK constraint. Deleting the last remaining
// admin rolls back with ErrLastAdmin (C-17: the guard runs inside the
// transaction, closing the count-then-delete TOCTOU).
//
// 权衡(审计 L4):usage 为计费原始记录,删除用户会物理删除其全部用量/费用,
// 历史统计与部门预算成本随之减少、不可追溯。当前采用硬删以保证 FK 完整与
// 「删即消失」的管理语义;如后续需要计费审计留存,应改为软删(users.status
// 墓碑态 + usage 保留),本函数签名与调用方需同步调整。
func DeleteUser(db *sql.DB, id int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var username string
	var role string
	if err := tx.QueryRow("SELECT username, role FROM users WHERE id = ?", id).Scan(&username, &role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	wasSuperAdmin := role == RoleSuperAdmin
	// 最后管理员保护(C-17 + 2026-09 并发修复):两个管理员并发互相删除时,
	// READ COMMITTED 下各自事务 DELETE 后 count 可能都看到"还有 1 个"——
	// 双双 commit,清空全部管理员。先对全部 super_admin 行加 FOR UPDATE 锁,
	// 串行化该检查:第二个事务须等第一个 commit 后再 count(此时已只剩 0 或 1)。
	if wasSuperAdmin {
		if _, err := tx.Exec("SELECT id FROM users WHERE role = ? FOR UPDATE", RoleSuperAdmin); err != nil {
			return err
		}
	}
	// cascade stmts keyed by user id
	for _, stmt := range []string{
		"DELETE FROM api_tokens WHERE user_id = ?",
		"DELETE FROM usage WHERE user_id = ?",
		"DELETE FROM admin_sessions WHERE user_id = ?",
		"DELETE FROM user_groups WHERE user_id = ?",
	} {
		if _, err := tx.Exec(stmt, id); err != nil {
			return err
		}
	}
	// 同名用户重建不得继承旧授权(权限体系:用户级授权随用户删除级联)
	if _, err := tx.Exec("DELETE FROM app_grants WHERE grantee_type = 'user' AND grantee = ?", username); err != nil {
		return err
	}
	// 审计修复 2026-P (H1): 0036 共享资源授权表同样随用户删除级联——
	// shared_skill_grants / agent_preset_grants 的 user 级授权若不清除,
	// 同名用户重建后会继承上一同名用户对共享技能/Agent 的授权(越权)。
	// P2:三张授权表已合并为 app_grants,上面的 DELETE 已覆盖全部能力类型。
	// 删除担任部门主管的用户:清空其主管身份(审计 M1),否则悬空
	// leader_id 会卡死该部门的后续更新(UpdateDepartment 校验主管存在)。
	if _, err := tx.Exec("UPDATE groups SET leader_id = 0 WHERE leader_id = ?", id); err != nil {
		return err
	}
	res, err := tx.Exec("DELETE FROM users WHERE id = ?", id)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	// C-17: guard runs after the delete inside the same transaction; if the
	// deleted row was a super_admin and none remain, roll back (v3b: count
	// by role column, not the legacy is_admin boolean).
	if wasSuperAdmin {
		var admins int
		if err := tx.QueryRow("SELECT COUNT(*) FROM users WHERE role = ?", RoleSuperAdmin).Scan(&admins); err != nil {
			return err
		}
		if admins == 0 {
			return ErrLastAdmin
		}
	}
	return tx.Commit()
}
