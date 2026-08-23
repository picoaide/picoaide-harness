package serverauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TokenTTL is the default token lifetime (90 days).
const TokenTTL = 90 * 24 * time.Hour

// IssueToken creates a random 32-byte token, stores its SHA-256 hash, and
// returns the raw token to hand to the client.
func IssueToken(db *sql.DB, userID int64) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	raw := base64.RawURLEncoding.EncodeToString(buf)
	if _, err := serverstore.CreateToken(db, userID, raw, time.Now().Add(TokenTTL)); err != nil {
		return "", err
	}
	return raw, nil
}

// VerifyToken validates a raw token and returns the associated user.
// It checks existence, revocation, expiry and that the user is active.
func VerifyToken(db *sql.DB, raw string) (*serverstore.User, error) {
	if raw == "" {
		return nil, errors.New("empty token")
	}
	tok, err := serverstore.GetTokenByHash(db, serverstore.TokenHash(raw))
	if errors.Is(err, serverstore.ErrNotFound) {
		return nil, errors.New("token not found")
	}
	if err != nil {
		return nil, err
	}
	if tok.Revoked != 0 {
		return nil, errors.New("token revoked")
	}
	if time.Now().After(tok.ExpiresAt) {
		return nil, errors.New("token expired")
	}
	u, err := serverstore.GetUserByID(db, tok.UserID)
	if errors.Is(err, serverstore.ErrNotFound) {
		return nil, errors.New("user not found")
	}
	if err != nil {
		return nil, err
	}
	if u.Status != 1 {
		return nil, errors.New("user disabled")
	}
	_ = serverstore.TouchTokenLastUsed(db, tok.ID)
	return u, nil
}

// RevokeToken revokes the token whose hash matches raw.
func RevokeToken(db *sql.DB, raw string) error {
	return serverstore.RevokeToken(db, serverstore.TokenHash(raw))
}
