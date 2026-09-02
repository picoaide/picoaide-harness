package serverauth

import (
	"database/sql"
	"errors"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// MFA challenge 生命周期(规划 2026-09-04):
//   - login:  两步登录, 密码通过后签发, 5 分钟有效, attempts>=5 作废, 一次消费
//   - enable: 开启 MFA 的密钥暂存(明文密钥只经 enable 响应一次性下发前端,
//     库中一律 AES-GCM 密文, 绝不落明文)。
const (
	mfaTicketTTL          = 5 * time.Minute
	mfaChallengeMaxFailed = 5
	mfaEnableTicketTTL    = 60 * time.Second
)

// mfaTOTPIssuer 是 otpauth:// URL 的 issuer 参数(验证器显示名称)。
const mfaTOTPIssuer = "PicoAide"

// ---- TOTP 工具(pquerna/otp: SHA1/6 位/30s 周期/±1 步容差默认) ----

// genTOTPSecret 生成新的 TOTP 密钥与 otpauth:// URL。accountName 通常为
// 管理员用户名(验证器中可辨识)。明文密钥仅此一次返回给前端(enable 响应)。
func genTOTPSecret(accountName string) (secret, otpauthURL string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: mfaTOTPIssuer, AccountName: accountName})
	if err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

// totpValid 校验 6 位动态码(默认 ±1 步容差, 即 ±30s 时钟漂移容忍)。
func totpValid(secret, code string) bool {
	if secret == "" || code == "" {
		return false
	}
	return totp.Validate(code, secret)
}

// encryptMFASecret / decryptMFASecret 用 master key(AES-GCM)封装 TOTP 密钥。
func encryptMFASecret(plaintext string) (string, error) {
	key, err := util.GetMasterKey()
	if err != nil {
		return "", err
	}
	return util.Encrypt(key, plaintext), nil
}

func decryptMFASecret(cipher string) (string, error) {
	key, err := util.GetMasterKey()
	if err != nil {
		return "", err
	}
	return util.Decrypt(key, cipher)
}

// ---- admin_mfa_challenges DAO ----

type mfaChallenge struct {
	ID        string
	UserID    int64
	Kind      string // "login" | "enable"
	Secret    string // kind=enable 时的密钥密文; 其余空
	Attempts  int
	ExpiresAt time.Time
	UsedAt    *time.Time
}

// createMFAChallenge 创建一次性挑战并清理已过期/作废/已消费的旧行(防表膨胀)。
func createMFAChallenge(db *sql.DB, userID int64, kind, secretCipher string, ttl time.Duration) (string, error) {
	id, err := randomHex(24)
	if err != nil {
		return "", err
	}
	if _, err := db.Exec(`DELETE FROM admin_mfa_challenges
		WHERE expires_at < now() OR attempts >= ? OR used_at IS NOT NULL`, mfaChallengeMaxFailed); err != nil {
		return "", err
	}
	_, err = db.Exec(`INSERT INTO admin_mfa_challenges (id, user_id, kind, secret, expires_at)
		VALUES (?, ?, ?, ?, ?)`,
		id, userID, kind, secretCipher, time.Now().Add(ttl).UTC())
	return id, err
}

func getMFAChallenge(db *sql.DB, id string) (*mfaChallenge, error) {
	var m mfaChallenge
	var expiresAt, usedAt any
	err := db.QueryRow(`SELECT id, user_id, kind, secret, attempts, expires_at, used_at
		FROM admin_mfa_challenges WHERE id = ?`, id).
		Scan(&m.ID, &m.UserID, &m.Kind, &m.Secret, &m.Attempts, &expiresAt, &usedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serverstore.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.ExpiresAt = parseChallengeTime(expiresAt)
	if v, ok := usedAt.(time.Time); ok && !v.IsZero() {
		t := v
		m.UsedAt = &t
	}
	return &m, nil
}

func parseChallengeTime(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	return time.Time{}
}

// bumpMFAChallengeAttempts 失败计数+1。
func bumpMFAChallengeAttempts(db *sql.DB, id string) error {
	_, err := db.Exec("UPDATE admin_mfa_challenges SET attempts = attempts + 1 WHERE id = ?", id)
	return err
}

// consumeMFAChallenge 消费挑战(幂等: 已消费/过期/作废返回 ErrNotFound)。
func consumeMFAChallenge(db *sql.DB, id string) error {
	res, err := db.Exec(`UPDATE admin_mfa_challenges SET used_at = now()
		WHERE id = ? AND used_at IS NULL AND expires_at > now() AND attempts < ?`, id, mfaChallengeMaxFailed)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return serverstore.ErrNotFound
	}
	return nil
}
