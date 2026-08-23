package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

// TokenHash returns the SHA-256 hex digest of a raw token.
func TokenHash(raw string) string {
	sum := sha256.Sum256([]byte(raw))
	return hex.EncodeToString(sum[:])
}

// CreateToken stores a hashed token with expiresAt (UTC) and returns its id.
func CreateToken(db *sql.DB, userID int64, raw string, expiresAt time.Time) (int64, error) {
	res, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		userID, TokenHash(raw), expiresAt.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// GetTokenByHash returns the token row by hashed value.
func GetTokenByHash(db *sql.DB, hash string) (*Token, error) {
	var t Token
	var expiresAt, lastUsed sql.NullString
	err := db.QueryRow(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE token_hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &t.CreatedAt, &expiresAt, &lastUsed, &t.Revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt.String)
	if lastUsed.Valid {
		t.LastUsedAt, _ = time.Parse(time.RFC3339, lastUsed.String)
	}
	return &t, nil
}

// RevokeToken revokes a token by hash.
func RevokeToken(db *sql.DB, hash string) error {
	res, err := db.Exec("UPDATE api_tokens SET revoked = 1 WHERE token_hash = ?", hash)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// RevokeAllUserTokens deletes every api token of a user (password change /
// admin demotion / disable: old credentials must die immediately).
func RevokeAllUserTokens(db *sql.DB, userID int64) error {
	_, err := db.Exec("DELETE FROM api_tokens WHERE user_id = ?", userID)
	return err
}

// RevokeTokenByID revokes a token by id. Idempotent: revoking an
// already-revoked token succeeds.
func RevokeTokenByID(db *sql.DB, tokenID int64) error {
	res, err := db.Exec("UPDATE api_tokens SET revoked = 1 WHERE id = ?", tokenID)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// tokenTouchInterval throttles last_used_at rewrites (审计 5#3): every
// successful verification would otherwise write the api_tokens row.
const tokenTouchInterval = time.Minute

// TouchTokenLastUsed records the last successful verification time, at most
// once per tokenTouchInterval per token.
func TouchTokenLastUsed(db *sql.DB, tokenID int64) error {
	var lastUsed sql.NullString
	if err := db.QueryRow("SELECT last_used_at FROM api_tokens WHERE id = ?", tokenID).Scan(&lastUsed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if lastUsed.Valid {
		if t, err := time.Parse(time.RFC3339, lastUsed.String); err == nil && time.Since(t) < tokenTouchInterval {
			return nil // throttled
		}
	}
	_, err := db.Exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
		time.Now().UTC().Format(time.RFC3339), tokenID)
	return err
}

// ListTokensByUser returns the non-sensitive view of a user's tokens
// (id/name/created/expiry/last used/revoked; never the hash).
func ListTokensByUser(db *sql.DB, userID int64) ([]Token, error) {
	rows, err := db.Query(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE user_id = ? ORDER BY id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var expiresAt, lastUsed sql.NullString
		if err := rows.Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &t.CreatedAt, &expiresAt, &lastUsed, &t.Revoked); err != nil {
			return nil, err
		}
		t.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt.String)
		if lastUsed.Valid {
			t.LastUsedAt, _ = time.Parse(time.RFC3339, lastUsed.String)
		}
		t.TokenHash = "" // never expose the hash in listings
		out = append(out, t)
	}
	return out, rows.Err()
}

type Token struct {
	ID         int64
	UserID     int64
	TokenHash  string
	Name       string
	CreatedAt  string
	ExpiresAt  time.Time
	LastUsedAt time.Time
	Revoked    int
}
