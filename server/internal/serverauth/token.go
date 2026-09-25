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
//
// R15C-R-01（审计 2026-09-25，P1）：每次登录都会 INSERT 一条 90 天有效令牌，
// 而这张表此前**没有任何回收者**（只有改密/禁用/删用户三处按 user_id 删），
// 过期行永久堆积 ⇒ 管理面列表把它一次性搬进内存（实测 1.0M 行 → 130 MiB 响应、
// 在堆 +656 MB）。这里在签发前顺带清扫一批过期行（有界、走 idx_tokens_expires），
// 与 admin_session.go 的 C-15「每次登录顺带清扫过期行，防表无界增长」同形 ——
// 增长由登录驱动，回收也挂在登录路径上。清理失败与 C-15 同口径地 fail-loud
// （不静默跳过：静默会让"无回收者"这个缺陷无声回归）。
func IssueToken(db *sql.DB, userID int64) (string, error) {
	if _, err := serverstore.PurgeExpiredTokens(db, 200); err != nil {
		return "", err
	}
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
