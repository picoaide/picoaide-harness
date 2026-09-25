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
	id, err := InsertID(db, `INSERT INTO api_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)`,
		userID, TokenHash(raw), expiresAt.UTC().Format(time.RFC3339))
	if err != nil {
		return 0, err
	}
	return id, nil
}

// GetTokenByHash returns the token row by hashed value.
func GetTokenByHash(db *sql.DB, hash string) (*Token, error) {
	var t Token
	var expiresAt, lastUsed sql.NullTime
	var createdAny any
	err := db.QueryRow(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE token_hash = ?`, hash).
		Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &createdAny, &expiresAt, &lastUsed, &t.Revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	t.CreatedAt = formatTimeString(createdAny)
	if expiresAt.Valid {
		t.ExpiresAt = expiresAt.Time
	}
	if lastUsed.Valid {
		t.LastUsedAt = lastUsed.Time
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
	var lastUsed sql.NullTime
	if err := db.QueryRow("SELECT last_used_at FROM api_tokens WHERE id = ?", tokenID).Scan(&lastUsed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	}
	if lastUsed.Valid {
		if time.Since(lastUsed.Time) < tokenTouchInterval {
			return nil // throttled
		}
	}
	_, err := db.Exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?",
		time.Now().UTC().Format(time.RFC3339), tokenID)
	return err
}

// TokenListMax 是管理面「用户令牌」列表的单次返回上限（R15C-R-01，审计
// 2026-09-25，P1）。取值理由：每次员工登录都会 INSERT 一条 90 天有效令牌
// （IssueToken，不去重不轮换），长期累积后"全量返回"实测可达 130 MiB/请求
// （1.0M 行 → 137 MB、在飞堆 +656 MB、3 并发 1.5 GB）。列表面是给人看的运维面，
// 最近 500 条足够定位"哪台设备在登"；超出部分由 total/truncated **显式披露**，
// 绝不静默截断。
const TokenListMax = 500

// PurgeExpiredTokens 删除至多 limit 条**已过期**令牌（按 expires_at，走
// 0031 建好却从未被使用的 idx_tokens_expires），返回删除条数。
//
// 为什么必须有回收者（R15C-R-01）：api_tokens 的行由任何持证员工自造
// （每次登录一条），而此前全仓只有 `DELETE … WHERE user_id = ?`（改密/禁用/删用户）
// 三处，**没有一处按 expires_at** —— 过期行永久留在表里，管理面列表把它一次性
// 搬进内存与浏览器。同仓三个"回收者家族"成员（auditretention / usageretention /
// files_reaper）此前一个都没覆盖这张表；本函数与 IssueToken 的调用点就是它的回收者
// （与 admin_session.go 的 C-15「每次登录顺带清扫过期行」同形：增长由登录驱动，
// 回收也挂在登录路径上）。
func PurgeExpiredTokens(db *sql.DB, limit int) (int64, error) {
	if limit <= 0 {
		limit = 200
	}
	res, err := db.Exec(`DELETE FROM api_tokens WHERE id IN (
		SELECT id FROM api_tokens WHERE expires_at < now() LIMIT ?)`, limit)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}

// ListTokensByUser returns the non-sensitive view of a user's tokens
// (id/name/created/expiry/last used/revoked; never the hash).
//
// R15C-R-01：返回**最近 limit 条**（id 倒序，上限 TokenListMax）与**总行数**；
// 调用方必须把 `total > len(rows)` 作为"还有更多"如实披露给用户，不得假装这就是全部。
func ListTokensByUser(db *sql.DB, userID int64, limit int) ([]Token, int64, error) {
	if limit <= 0 || limit > TokenListMax {
		limit = TokenListMax
	}
	var total int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE user_id = ? ORDER BY id DESC LIMIT ?`, userID, limit)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var expiresAt, lastUsed sql.NullTime
		var createdAny any
		if err := rows.Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &createdAny, &expiresAt, &lastUsed, &t.Revoked); err != nil {
			return nil, 0, err
		}
		t.CreatedAt = formatTimeString(createdAny)
		if expiresAt.Valid {
			t.ExpiresAt = expiresAt.Time
		}
		if lastUsed.Valid {
			t.LastUsedAt = lastUsed.Time
		}
		t.TokenHash = "" // never expose the hash in listings
		out = append(out, t)
	}
	return out, total, rows.Err()
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
