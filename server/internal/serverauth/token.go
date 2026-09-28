package serverauth

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
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

// ErrAuthRejected 标记"**凭证本身被拒**"的判定结果：令牌不存在 / 已被吊销 / 已过期 /
// 用户不存在 / 用户已停用。与"依赖不可用"（存储查询失败、连接池耗尽、语句超时、
// 上下文取消）**严格区分**（A2-01，审计 2026-09-26，P2）：
//
//   - 凭证被拒 ⇒ 401（客户端据此清会话并删掉磁盘上的令牌 `$DSH_HOME/session.json`）；
//   - 依赖故障 ⇒ **5xx**（客户端必须保留令牌重试）。
//
// 修前 `BearerAuth` 把 `VerifyToken` 的**任何** error 都回 401 `AUTH_FAILED`：一次
// PG 抖动（重启 / 连接池耗尽 / 语句超时 / 卷切换）就等于让**全体在线员工**被登出，
// 而客户端无法区分"令牌真的无效"与"服务端查不了"。方向仍是 fail-closed
// （不会越权），错的是分类与它的破坏性副作用。
var ErrAuthRejected = errors.New("authentication rejected")

// VerifyToken validates a raw token and returns the associated user.
// It checks existence, revocation, expiry and that the user is active.
//
// 返回的错误分两类（调用方用 `IsAuthRejection` 区分；两类的 HTTP 语义见
// `ErrAuthRejected` 的注释）：
//   - `ErrAuthRejected`（包装）—— 凭证被拒 ⇒ 401；
//   - 其余（驱动错误 / 上下文错误，原样返回）—— 依赖不可用 ⇒ 500。
func VerifyToken(db *sql.DB, raw string) (*serverstore.User, error) {
	if raw == "" {
		return nil, fmt.Errorf("%w: empty token", ErrAuthRejected)
	}
	tok, err := serverstore.GetTokenByHash(db, serverstore.TokenHash(raw))
	if errors.Is(err, serverstore.ErrNotFound) {
		return nil, fmt.Errorf("%w: token not found", ErrAuthRejected)
	}
	if err != nil {
		// 存储层故障：**不**包装成 ErrAuthRejected —— 分类错会让一次 PG 抖动
		// 把全体在线员工登出。
		return nil, err
	}
	if tok.Revoked != 0 {
		return nil, fmt.Errorf("%w: token revoked", ErrAuthRejected)
	}
	if time.Now().After(tok.ExpiresAt) {
		return nil, fmt.Errorf("%w: token expired", ErrAuthRejected)
	}
	u, err := serverstore.GetUserByID(db, tok.UserID)
	if errors.Is(err, serverstore.ErrNotFound) {
		return nil, fmt.Errorf("%w: user not found", ErrAuthRejected)
	}
	if err != nil {
		return nil, err
	}
	if u.Status != 1 {
		return nil, fmt.Errorf("%w: user disabled", ErrAuthRejected)
	}
	_ = serverstore.TouchTokenLastUsed(db, tok.ID)
	return u, nil
}

// IsAuthRejection 报告 err 是不是"**凭证被拒**"（⇒ 401）而不是依赖故障（⇒ 5xx）。
//
// 唯一实现：`BearerAuth` 与各资源面的 viewer 都走它 —— 判定/分类不得各写一份，
// 否则会出现"这一面 401、那一面 500"的口径分裂（正是 A2-01 的同族形态）。
func IsAuthRejection(err error) bool {
	return errors.Is(err, ErrAuthRejected)
}

// RevokeToken revokes the token whose hash matches raw.
func RevokeToken(db *sql.DB, raw string) error {
	return serverstore.RevokeToken(db, serverstore.TokenHash(raw))
}
