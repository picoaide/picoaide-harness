package serverauth

import (
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strconv"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// AdminSessionTTL is the admin web session hard lifetime (v3b: 12h).
const AdminSessionTTL = 12 * time.Hour

// AdminIdleTimeout is the sliding idle timeout: a session untouched for this
// long is expired on next use (v3b). Kept short for the management plane.
const AdminIdleTimeout = 60 * time.Minute

// CSRF window is one hour; tokens from the previous window still verify.
const csrfWindow = time.Hour

type AdminSession struct {
	ID         string
	UserID     int64
	CSRFKey    string
	ExpiresAt  time.Time
	LastUsedAt time.Time
}

// sessionSecretHash 返回 cookie 值的 SHA-256(库中只存哈希,P2-2)。
func sessionSecretHash(secret string) string {
	sum := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(sum[:])
}

// CreateAdminSession stores a session and returns it (ID = cookie 值) plus a
// CSRF token.
//
// P2-2(审计 2026-09-13):下发给浏览器的 cookie 值**不再原样入库** —— 库中只存
// SHA-256(secret_hash),id 退回为纯内部主键。任何读到 DB 的人拿不到可用会话。
func CreateAdminSession(db *sql.DB, userID int64) (*AdminSession, string, error) {
	rowID, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	secret, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	csrfKey, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	s := &AdminSession{ID: secret, UserID: userID, CSRFKey: csrfKey, ExpiresAt: time.Now().Add(AdminSessionTTL), LastUsedAt: time.Now()}
	// C-15: sweep already-expired sessions on every login so the table cannot
	// grow without bound from abandoned logins.
	if _, err := db.Exec("DELETE FROM admin_sessions WHERE expires_at < ?", time.Now().UTC().Format(time.RFC3339)); err != nil {
		return nil, "", err
	}
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at, last_used_at, secret_hash) VALUES (?, ?, ?, ?, ?, ?)`,
		rowID, userID, csrfKey, s.ExpiresAt.UTC().Format(time.RFC3339), s.LastUsedAt.UTC().Format(time.RFC3339),
		sessionSecretHash(secret)); err != nil {
		return nil, "", err
	}
	return s, IssueSessionCSRF(csrfKey, secret), nil
}

// GetAdminSession loads a session row **by cookie value**(内部按哈希查,P2-2)。
func GetAdminSession(db *sql.DB, cookieSecret string) (*AdminSession, error) {
	var s AdminSession
	var expiresAt, lastUsedAt string
	err := db.QueryRow(`SELECT id, user_id, csrf_key, expires_at, last_used_at FROM admin_sessions WHERE secret_hash = ?`,
		sessionSecretHash(cookieSecret)).
		Scan(&s.ID, &s.UserID, &s.CSRFKey, &expiresAt, &lastUsedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serverstore.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	s.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	if lastUsedAt != "" {
		s.LastUsedAt, _ = time.Parse(time.RFC3339, lastUsedAt)
	} else {
		s.LastUsedAt = s.ExpiresAt // legacy rows: treat creation as last use
	}
	return &s, nil
}

// DeleteAdminSession removes a session **by cookie value**(内部按哈希定位,P2-2)。
func DeleteAdminSession(db *sql.DB, cookieSecret string) error {
	_, err := db.Exec("DELETE FROM admin_sessions WHERE secret_hash = ?", sessionSecretHash(cookieSecret))
	return err
}

// ValidateAdminSession checks expiry (hard TTL + idle timeout) and that the
// user has management access (super_admin or auditor; plain user is rejected).
// 入参是 **cookie 值**(内部按哈希定位,P2-2)。
func ValidateAdminSession(db *sql.DB, id string) (*serverstore.User, error) {
	s, err := GetAdminSession(db, id)
	if err != nil {
		return nil, err
	}
	if time.Now().After(s.ExpiresAt) {
		return nil, errors.New("session expired")
	}
	// Idle timeout: a session untouched for AdminIdleTimeout is expired.
	if time.Since(s.LastUsedAt) > AdminIdleTimeout {
		return nil, errors.New("session idle expired")
	}
	u, err := serverstore.GetUserByID(db, s.UserID)
	if err != nil {
		return nil, err
	}
	if !u.HasManagementAccess() || u.Status != 1 {
		return nil, errors.New("not an active admin")
	}
	// Sliding idle window: refresh last_used_at on each validated use.
	if _, err := db.Exec("UPDATE admin_sessions SET last_used_at = ? WHERE secret_hash = ?",
		time.Now().UTC().Format(time.RFC3339), sessionSecretHash(id)); err != nil {
		return nil, err
	}
	return u, nil
}

// IssueCSRF produces the HMAC-SHA256 token for the given time's window.
func IssueCSRF(key string, at time.Time) string {
	window := strconv.FormatInt(at.UTC().Truncate(csrfWindow).Unix(), 10)
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte(window))
	return hex.EncodeToString(mac.Sum(nil))
}

// IssueSessionCSRF 是与会话同寿命的 CSRF token(F1,审计 2026-09-11):
// HMAC(CSRFKey, "session:"+sessionID)。旧的小时窗口 token 最多活 2 小时,
// 而管理会话 12 小时、webadmin 又只在挂载时取一次 token —— 长开页签的
// 写操作必然 403。绑定会话后 token 在会话有效期内一直可用。
func IssueSessionCSRF(key, sessionID string) string {
	mac := hmac.New(sha256.New, []byte(key))
	mac.Write([]byte("session:" + sessionID))
	return hex.EncodeToString(mac.Sum(nil))
}

// VerifySessionCSRF 常量时间校验会话绑定 token。
func VerifySessionCSRF(key, sessionID, token string) bool {
	if token == "" || sessionID == "" {
		return false
	}
	return hmac.Equal([]byte(IssueSessionCSRF(key, sessionID)), []byte(token))
}

// VerifyCSRF accepts tokens from the current or previous window.
func VerifyCSRF(key, token string, at time.Time) bool {
	if token == "" {
		return false
	}
	for _, w := range []time.Time{at, at.Add(-csrfWindow)} {
		if hmac.Equal([]byte(IssueCSRF(key, w)), []byte(token)) {
			return true
		}
	}
	return false
}
