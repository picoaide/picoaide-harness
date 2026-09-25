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
	// BalanceMoney is the prepaid balance in yuan (0061): admin-adjustable,
	// monthly-grant target, and deducted by usage.cost. When balance.enabled
	// is on, a non-positive balance blocks gateway requests.
	BalanceMoney float64
	// BalanceActivatedAt is when the balance account was opened (0062: set on
	// the first credit). Zero = never credited: the user is neither charged
	// nor blocked by the balance gate (设计文档 §4.3 开通语义).
	BalanceActivatedAt time.Time
	CreatedAt          time.Time
	UpdatedAt          time.Time
	// PasswordChangedAt is the last password set/reset time (0057).
	// Zero = never changed (created with an initial password).
	PasswordChangedAt time.Time
	// PasswordMustChange forces the next login to end in a password change
	// (0057: set by admin password reset; cleared on successful change).
	PasswordMustChange bool
	// TotpSecret is the AES-GCM ciphertext of the admin TOTP secret (0057);
	// "" = not configured. Never returned to clients in plaintext.
	TotpSecret string
	// TotpEnabled reports whether MFA is active for this admin (webadmin login).
	TotpEnabled bool
	// ExternalID 是 IdP 主体标识(OIDC sub / LDAP DN);external_source 是哪套
	// IdP(ldap/oidc/openid)。空 = 未绑定(存量行首登时认领)。审计 2026-09-13 P2-9。
	ExternalID     string
	ExternalSource string
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
const userCols = "id, username, display_name, email, password_hash, source, is_admin, role, status, created_at, updated_at, quota_tokens, quota_money, password_changed_at, password_must_change, totp_secret, totp_enabled, balance_money, balance_activated_at, external_id, external_source"

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
	var displayName, email, passwordHash, role, totpSecret, externalID, externalSource sql.NullString
	var quota sql.NullInt64
	var quotaMoney, balanceMoney sql.NullFloat64
	var createdAt, updatedAt, passwordChangedAt any
	var balanceActivatedAt any
	var mustChange, totpEnabled int
	if err := row.Scan(&u.ID, &u.Username, &displayName, &email, &passwordHash, &u.Source, &isAdmin, &role, &status, &createdAt, &updatedAt, &quota, &quotaMoney, &passwordChangedAt, &mustChange, &totpSecret, &totpEnabled, &balanceMoney, &balanceActivatedAt, &externalID, &externalSource); err != nil {
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
	if balanceMoney.Valid {
		u.BalanceMoney = balanceMoney.Float64
	}
	u.BalanceActivatedAt = parseSQLTime(balanceActivatedAt)
	u.PasswordChangedAt = parseSQLTime(passwordChangedAt)
	u.PasswordMustChange = mustChange == 1
	u.TotpSecret = totpSecret.String
	u.TotpEnabled = totpEnabled == 1
	u.ExternalID = externalID.String
	u.ExternalSource = externalSource.String
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

// MaxUsernameBytes 是用户名的**唯一**长度上限（字节）。
//
// 两个消费端必须同源（R17A-09，审计 2026-09-25，P3）：
//   - 写入侧：CreateUser 拒绝超长用户名（ErrUsernameTooLong）；
//   - 登录侧：serverauth 的凭据长度闸（超过即 400，防线从未变过）。
//
// 另外它是审计可追溯性的前提：审计行里的 username 走
// `util.EscapeControlLimit(name, 128)`，上限内逐字原样、超限**静默截断** ——
// 只有"库里的用户名永远不超过它"，审计行的 username 才与 users.username 逐字相等。
const MaxUsernameBytes = 128

// CreateUser inserts a user row and returns its id.
// 用户名大小写不敏感唯一(F9):先按 lower(username) 查重(干净库另有唯一索引
// 兜底并发),LDAP/本地同名异大小写不再产生影子账号。
func CreateUser(db *sql.DB, u *User) (int64, error) {
	username := strings.TrimSpace(u.Username)
	if username == "" {
		return 0, ErrValidation
	}
	// R17A-09:与登录路径同一上限（见 MaxUsernameBytes）。放在 DAO 的唯一写入口
	// 是为了覆盖**全部**建号路径（管理端建号 / LDAP-OIDC 首次登录 provision /
	// bootstrap-admin / 内部工具），而不是只堵管理端那一处。
	if len(username) > MaxUsernameBytes {
		return 0, ErrUsernameTooLong
	}
	var exists int
	if err := db.QueryRow(`SELECT 1 FROM users WHERE lower(username) = lower(?) LIMIT 1`, username).Scan(&exists); err == nil {
		return 0, ErrDuplicate
	} else if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	role := resolveRole(u.Role, u.IsAdmin)
	id, err := InsertID(db, `INSERT INTO users (username, display_name, email, password_hash, source, is_admin, role, status, quota_tokens, quota_money, balance_money, external_id, external_source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		username, nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		u.Source, boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney),
		roundMoney(u.BalanceMoney), u.ExternalID, u.ExternalSource)
	if err != nil {
		if isUniqueViolation(err) {
			return 0, ErrDuplicate
		}
		return 0, err
	}
	return id, nil
}

// GetUserByUsername returns the user or ErrNotFound.
// F9: 大小写不敏感(与 groups 的 NOCASE 口径一致);LIMIT 1 + id 排序在历史
// 脏数据(大小写重复行)下保持确定性,新数据由应用检查 + 唯一索引保证唯一。
func GetUserByUsername(db *sql.DB, username string) (*User, error) {
	row := db.QueryRow(`SELECT `+userCols+`
FROM users WHERE lower(username) = lower(?) ORDER BY id LIMIT 1`, strings.TrimSpace(username))
	u, err := scanUser(row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return u, err
}

// CheckUsernameCaseConflicts 返回大小写重复的用户名组(启动告警用)。
// 干净库上恒为空;历史脏数据需管理员人工合并。
func CheckUsernameCaseConflicts(db *sql.DB) ([]string, error) {
	rows, err := db.Query(`SELECT lower(username) FROM users GROUP BY lower(username) HAVING COUNT(*) > 1 ORDER BY 1`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
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

// UpdateUser updates display_name/email/password_hash/is_admin/role/status
// plus the 0057 password bookkeeping columns (kept consistent via the loaded
// row; totp_secret/totp_enabled are managed by SetUserMFA/ClearUserMFA only).
func UpdateUser(db *sql.DB, u *User) error {
	role := resolveRole(u.Role, u.IsAdmin)
	res, err := db.Exec(`UPDATE users SET display_name=?, email=?, password_hash=?, is_admin=?, role=?, status=?, quota_tokens=?, quota_money=?, password_changed_at=?, password_must_change=?, updated_at=`+NowExpr()+`
		WHERE id=?`,
		nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney),
		nilIfZeroTime(u.PasswordChangedAt), boolInt(u.PasswordMustChange), u.ID)
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
	res, err := tx.Exec(`UPDATE users SET display_name=?, email=?, password_hash=?, is_admin=?, role=?, status=?, quota_tokens=?, quota_money=?, password_changed_at=?, password_must_change=?, updated_at=`+NowExpr()+`
		WHERE id=?`,
		nullIfEmpty(u.DisplayName), nullIfEmpty(u.Email), nullIfEmpty(u.PasswordHash),
		boolInt(u.IsAdmin), role, u.Status, nilIfNilInt64(u.QuotaTokens), nilIfNilFloat64(u.QuotaMoney),
		nilIfZeroTime(u.PasswordChangedAt), boolInt(u.PasswordMustChange), u.ID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec("DELETE FROM api_tokens WHERE user_id = ?", u.ID); err != nil {
		return err
	}
	// 2026-09-04: 降权/禁用/改密同样吊销管理会话(旧 session 即使通过
	// ValidateAdminSession 的 role/status 复查, 也不留存量登录面)。
	if _, err := tx.Exec("DELETE FROM admin_sessions WHERE user_id = ?", u.ID); err != nil {
		return err
	}
	return tx.Commit()
}

// UpdateUserPassword 改密专用(0057): 事务内更新 password_hash + 改密时间 +
// 强制改密标志, 并吊销该用户全部 api_tokens 与 admin_sessions —— 安全决策
// (2026-09-04 评审): 改密后全部踢掉(含当前会话), 客户端必须重新登录。
func UpdateUserPassword(db *sql.DB, userID int64, newHash string, mustChange bool) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	res, err := tx.Exec(`UPDATE users SET password_hash=?, password_must_change=?, password_changed_at=`+NowExpr()+`, updated_at=`+NowExpr()+`
		WHERE id=?`, newHash, boolInt(mustChange), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	if _, err := tx.Exec("DELETE FROM api_tokens WHERE user_id = ?", userID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM admin_sessions WHERE user_id = ?", userID); err != nil {
		return err
	}
	return tx.Commit()
}

// SetUserMFA 登记 TOTP 配置(secret 为 AES-GCM 密文; enabled=1 仅由 verify
// 成功后写入)。
//
// R15C-02(审计 2026-09-25,P1):守卫写进 UPDATE 本身 —— **仅当该用户尚未开启
// MFA 时**才允许写入。这是"不变量必须在唯一写入口成立"的纪律(与 wasmapps 的
// owner 守卫同精神):陈旧或并发的 enable 挑战到达这里时不会覆盖已登记的密钥
// (旧验证器不会被动失效)。要更换验证器必须先走 disableMyMFA(主密码 + 当前
// 动态码双验),再由用户重新开启。
//
// @returns ErrMFAAlreadyEnabled = 该用户已开启 MFA(0 行命中且用户存在)。
func SetUserMFA(db *sql.DB, userID int64, totpSecretCipher string, enabled bool) error {
	res, err := db.Exec(`UPDATE users SET totp_secret=?, totp_enabled=?, updated_at=`+NowExpr()+`
		WHERE id=? AND totp_enabled=0`,
		totpSecretCipher, boolInt(enabled), userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		// 0 行有两个成因:用户不存在 / 已开启(谓词未命中)。必须分开报,
		// 否则"已开启"会被误诊成 500 或"用户不存在"。
		var current bool
		if err := db.QueryRow(`SELECT totp_enabled FROM users WHERE id = ?`, userID).Scan(&current); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		return ErrMFAAlreadyEnabled
	}
	return nil
}

// ClearUserMFA 关闭/重置 TOTP(管理员自助关闭或他人重置)。
func ClearUserMFA(db *sql.DB, userID int64) error {
	res, err := db.Exec(`UPDATE users SET totp_secret='', totp_enabled=0, updated_at=`+NowExpr()+` WHERE id=?`, userID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeAllUserSessions 吊销用户全部 api_tokens 与 admin_sessions(不改任何
// 用户字段; 供 MFA 重置等独立场景)。
func RevokeAllUserSessions(db *sql.DB, userID int64) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("DELETE FROM api_tokens WHERE user_id = ?", userID); err != nil {
		return err
	}
	if _, err := tx.Exec("DELETE FROM admin_sessions WHERE user_id = ?", userID); err != nil {
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

// isUniqueViolation 报告 err 是否为唯一约束冲突（PG 23505）。
//
// SQLSTATE 判定走 pg.go 的 pgErrorCode（`errors.As` 优先，回落错误串）；
// 后面那三条**文本**判定是 SQLite 时代的回落，PG-only 迁移后已无生产者。
// 它们比 `errors.As` **更宽**，删掉属于**行为收紧**、不是重构，故保留并在此标明来源：
//   - PG: ERROR: duplicate key value violates unique constraint "x" (SQLSTATE 23505)
//   - SQLite: UNIQUE constraint failed: users.username
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	if pgErrorCodeIs(err, pgSQLStateUniqueViolation) {
		return true
	}
	msg := err.Error()
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

// nilIfZeroTime maps a zero time.Time to SQL NULL (password_changed_at unset).
func nilIfZeroTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

// ErasedUserLedgers 汇总删除用户时**被抹除**的账目（调用方写审计留痕用）。
//
// R15C-01（审计 2026-09-25，P1）：DeleteUser 是"删即消失"的抹除动作 —— 它删掉的
// 用量金额与资金流水金额必须能说清，否则历史报表对不上时无从解释。这些数字在
// **同一事务内、删除之前**读出（与抹除动作看到同一个快照），由调用方写进 0048
// 哈希链审计。
type ErasedUserLedgers struct {
	UsageCost     float64 // 用量明细费用合计（元）
	UsageRequests int64   // 用量明细记录数
	BalanceAmount float64 // 资金流水净额（元，= 该用户全部流水之和）
	BalanceRows   int64   // 资金流水条数
}

// DeleteUser removes a user and all their ledger rows
// (api_tokens, usage, usage_daily, usage_monthly, balance_ledger,
// balance_grant_items, admin_sessions, user_groups) in a single transaction
// so deletion never trips the FK constraint and never leaves half-erased
// books. Deleting the last remaining admin rolls back with ErrLastAdmin
// (C-17: the guard runs inside the transaction, closing the count-then-delete
// TOCTOU).
//
// 语义（R15C-01，审计 2026-09-25，P1）：**删除 = 抹除**。用户行被物理删除时，
// 其用量**明细**与**日/月汇总**、资金**流水**与发放锚必须同事务一并清除。
// 此前只删明细，留下三处不可自愈的分叉：
//   - 日/月汇总仍持有被删用户的金额（同月 `明细 ≠ 日账 ≠ 月账`）；
//   - 读面按"该月是否还有明细行"逐月切读源（usage_ledger.go 的
//     usageAggregateSegments）⇒ 该月明细一旦归零（删掉该月仅有的用量用户即可，
//     不必等保留期 DROP），被删用户的费用会**回涨**，并出现 label 为数字 user_id
//     的幽灵行；
//   - 永久账本**没有任何回收路径**，启动补算又是纯 UPSERT、只从明细算 ⇒ 那些行
//     永远不会被纠正；
//   - `balance_ledger` 留下孤儿流水，`SUM(balance_ledger.amount) ≠
//     SUM(users.balance_money)`（AGENTS.md §7 的硬不变量），且没有任何界面出口。
//
// 被抹除的金额由返回值交给调用方写审计（见 ErasedUserLedgers）。若产品日后需要
// "保留历史 + 匿名化"（而不是抹除），那要改的是 users 行的墓碑态与这三个关系的
// 口径，不能只改这一处。
func DeleteUser(db *sql.DB, id int64) (ErasedUserLedgers, error) {
	var erased ErasedUserLedgers
	// R13-GE（V2-2）：本事务里带 `DELETE FROM usage WHERE user_id = ?`（族内关系）
	// ⇒ 事务本身必须钉 search_path（否则删的是 shadow 的用量行，public 一行不动）。
	tx, err := usageWriteTx(db)
	if err != nil {
		return erased, err
	}
	defer tx.Rollback()
	var username string
	var role string
	if err := tx.QueryRow("SELECT username, role FROM users WHERE id = ?", id).Scan(&username, &role); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return erased, ErrNotFound
		}
		return erased, err
	}
	wasSuperAdmin := role == RoleSuperAdmin
	// 最后管理员保护(C-17 + 2026-09 并发修复):两个管理员并发互相删除时,
	// READ COMMITTED 下各自事务 DELETE 后 count 可能都看到"还有 1 个"——
	// 双双 commit,清空全部管理员。先对全部 super_admin 行加 FOR UPDATE 锁,
	// 串行化该检查:第二个事务须等第一个 commit 后再 count(此时已只剩 0 或 1)。
	if wasSuperAdmin {
		if _, err := tx.Exec("SELECT id FROM users WHERE role = ? FOR UPDATE", RoleSuperAdmin); err != nil {
			return erased, err
		}
	}
	// 抹除前读数（审计凭据）：与下面的删除同事务、同快照。
	if err := tx.QueryRow(`SELECT COALESCE(SUM(cost),0), COUNT(*) FROM usage WHERE user_id = ?`, id).
		Scan(&erased.UsageCost, &erased.UsageRequests); err != nil {
		return erased, err
	}
	if err := tx.QueryRow(`SELECT COALESCE(SUM(amount),0), COUNT(*) FROM balance_ledger WHERE user_id = ?`, id).
		Scan(&erased.BalanceAmount, &erased.BalanceRows); err != nil {
		return erased, err
	}
	// cascade stmts keyed by user id
	for _, stmt := range []string{
		"DELETE FROM api_tokens WHERE user_id = ?",
		"DELETE FROM usage WHERE user_id = ?",
		// 0041/0039 的日账与月账：不删就会在明细归零后"回涨"（见函数头）。
		"DELETE FROM usage_daily WHERE user_id = ?",
		"DELETE FROM usage_monthly WHERE user_id = ?",
		// 0062 的资金账本与发放锚：不删就留下孤儿流水（I1 不变量）。
		"DELETE FROM balance_ledger WHERE user_id = ?",
		"DELETE FROM balance_grant_items WHERE user_id = ?",
		"DELETE FROM admin_sessions WHERE user_id = ?",
		"DELETE FROM user_groups WHERE user_id = ?",
	} {
		if _, err := tx.Exec(stmt, id); err != nil {
			return erased, err
		}
	}
	// 同名用户重建不得继承旧授权(权限体系:用户级授权随用户删除级联)
	if _, err := tx.Exec("DELETE FROM app_grants WHERE grantee_type = 'user' AND lower(grantee) = lower(?)", username); err != nil {
		return erased, err
	}
	// 审计修复 2026-P (H1): 0036 共享资源授权表同样随用户删除级联——
	// shared_skill_grants / agent_preset_grants 的 user 级授权若不清除,
	// 同名用户重建后会继承上一同名用户对共享技能/Agent 的授权(越权)。
	// P2:三张授权表已合并为 app_grants,上面的 DELETE 已覆盖全部能力类型。
	// 删除担任部门主管的用户:清空其主管身份(审计 M1),否则悬空
	// leader_id 会卡死该部门的后续更新(UpdateDepartment 校验主管存在)。
	if _, err := tx.Exec("UPDATE groups SET leader_id = 0 WHERE leader_id = ?", id); err != nil {
		return erased, err
	}
	res, err := tx.Exec("DELETE FROM users WHERE id = ?", id)
	if err != nil {
		return erased, err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return erased, ErrNotFound
	}
	// C-17: guard runs after the delete inside the same transaction; if the
	// deleted row was a super_admin and none remain, roll back (v3b: count
	// by role column, not the legacy is_admin boolean).
	if wasSuperAdmin {
		var admins int
		if err := tx.QueryRow("SELECT COUNT(*) FROM users WHERE role = ?", RoleSuperAdmin).Scan(&admins); err != nil {
			return erased, err
		}
		if admins == 0 {
			return erased, ErrLastAdmin
		}
	}
	if err := tx.Commit(); err != nil {
		return erased, err
	}
	return erased, nil
}

// BindExternalIdentity 把本地行绑定到 IdP 主体(审计 2026-09-13 P2-9)。
// 仅当该行尚未绑定(external_id=”)或绑定值一致时成功;不一致返回 ErrConflictLike
// 由调用方拒绝登录(绝不静默改写别人的绑定)。
func BindExternalIdentity(db *sql.DB, userID int64, externalID, externalSource string) error {
	if externalID == "" {
		return nil
	}
	res, err := db.Exec(`UPDATE users SET external_id = ?, external_source = ?, updated_at = `+NowExpr()+`
		WHERE id = ? AND (external_id = '' OR external_id = ?)`, externalID, externalSource, userID, externalID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		// 已被其它 IdP 主体占用 → 调用方拒绝登录(专用哨兵,便于映射 401 而非 500)。
		return ErrIdentityConflict
	}
	return nil
}

// ConsumeTOTPStep 原子占用一个 TOTP 时间步(重放防护,审计 2026-09-13 P2-3)。
//
// 语义:仅当该步**新于**该用户已成功使用过的最大步时才成功(单条 UPDATE 即
// check-and-set)。并发重放同一 (user, step) 只会有一次 RowsAffected=1。
// @returns true = 本次占用成功(动态码首次使用);false = 该步或更早的步已用过。
func ConsumeTOTPStep(db *sql.DB, userID, step int64) (bool, error) {
	res, err := db.Exec(`UPDATE users SET last_totp_step = ? WHERE id = ? AND last_totp_step < ?`,
		step, userID, step)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n > 0, nil
}
