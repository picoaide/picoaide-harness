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

// CreateAdminSession stores a session and returns its id and a CSRF token.
func CreateAdminSession(db *sql.DB, userID int64) (*AdminSession, string, error) {
	id, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	csrfKey, err := randomHex(24)
	if err != nil {
		return nil, "", err
	}
	s := &AdminSession{ID: id, UserID: userID, CSRFKey: csrfKey, ExpiresAt: time.Now().Add(AdminSessionTTL), LastUsedAt: time.Now()}
	// C-15: sweep already-expired sessions on every login so the table cannot
	// grow without bound from abandoned logins.
	if _, err := db.Exec("DELETE FROM admin_sessions WHERE expires_at < ?", time.Now().UTC().Format(time.RFC3339)); err != nil {
		return nil, "", err
	}
	if _, err := db.Exec(`INSERT INTO admin_sessions (id, user_id, csrf_key, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?)`,
		id, userID, csrfKey, s.ExpiresAt.UTC().Format(time.RFC3339), s.LastUsedAt.UTC().Format(time.RFC3339)); err != nil {
		return nil, "", err
	}
	return s, IssueCSRF(csrfKey, time.Now()), nil
}

// GetAdminSession loads a session row.
func GetAdminSession(db *sql.DB, id string) (*AdminSession, error) {
	var s AdminSession
	var expiresAt, lastUsedAt string
	err := db.QueryRow(`SELECT id, user_id, csrf_key, expires_at, last_used_at FROM admin_sessions WHERE id = ?`, id).
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

// DeleteAdminSession removes a session.
func DeleteAdminSession(db *sql.DB, id string) error {
	_, err := db.Exec("DELETE FROM admin_sessions WHERE id = ?", id)
	return err
}

// ValidateAdminSession checks expiry (hard TTL + idle timeout) and that the
// user has management access (super_admin or auditor; plain user is rejected).
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
	if _, err := db.Exec("UPDATE admin_sessions SET last_used_at = ? WHERE id = ?",
		time.Now().UTC().Format(time.RFC3339), id); err != nil {
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
