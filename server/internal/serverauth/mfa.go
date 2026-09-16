package serverauth

import (
	"crypto/subtle"
	"database/sql"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/pquerna/otp/totp"

	"github.com/picoaide/picoaide/internal/channel"
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
//
// **必须跟随渠道**:管理员在手机验证器里看到的是"哪个产品要求绑定动态码",
// 渠道客户不该在这里看到厂商名 —— 这是整个白标面里唯一逃出应用之外的一处
// (审计 2026-09-10)。渠道名来自镜像内的渠道配置,与门户/登录页同一份。
func mfaTOTPIssuer() string {
	if name := strings.TrimSpace(channel.Load().Identity.DisplayName); name != "" {
		return name
	}
	return channelFallbackIssuer
}

// channelFallbackIssuer 渠道配置缺失时的中性兜底。
//
// 刻意**不含厂商品牌**:缺渠道配置属交付事故(CI 在构建期强制 channel.json
// 存在),此时宁可显示中性名,也不要把厂商名贴到客户管理员的验证器里。
const channelFallbackIssuer = "Harness"

// ---- TOTP 工具(pquerna/otp: SHA1/6 位/30s 周期/±1 步容差默认) ----

// genTOTPSecret 生成新的 TOTP 密钥与 otpauth:// URL。accountName 通常为
// 管理员用户名(验证器中可辨识)。明文密钥仅此一次返回给前端(enable 响应)。
func genTOTPSecret(accountName string) (secret, otpauthURL string, err error) {
	key, err := totp.Generate(totp.GenerateOpts{Issuer: mfaTOTPIssuer(), AccountName: accountName})
	if err != nil {
		return "", "", err
	}
	return key.Secret(), key.URL(), nil
}

// nowFn 是 TOTP 校验的时间源(生产 = time.Now;测试可覆盖以跨越 30s 步长,
// 否则重放防护会让同一窗口内的第二次操作无法测试)。
var nowFn = time.Now

// totpStepValid 返回**匹配到的时间步**(±1 步容差内)与是否有效。
//
// 为什么需要步号(审计 2026-09-13 P2-3):pquerna 的 Validate 只回 bool,
// 无法知道这次命中的是哪个 30s 步 ⇒ 无法做重放防护(实测同一动态码在窗口内
// 可重复用于两个票据)。这里显式枚举 -1/0/+1 三个步并用常量时间比较,把步号
// 交给调用方落库(totp_replay 表),同一 (user, step) 只能成功一次。
//
// 校验完成后立即"占用"该步(serverstore.ConsumeTOTPStep),因此并发重放只会有
// 一个请求成功。
func totpStepValid(secret, code string, at time.Time) (int64, bool) {
	code = strings.TrimSpace(code)
	if secret == "" || len(code) != 6 {
		return 0, false
	}
	current := at.Unix() / 30
	for _, delta := range []int64{-1, 0, 1} {
		step := current + delta
		want, err := totp.GenerateCode(secret, time.Unix(step*30, 0))
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(want), []byte(code)) == 1 {
			return step, true
		}
	}
	return 0, false
}

// verifyAndConsumeTOTP 是登录/关闭/开启 MFA 三个入口共用的校验:验证动态码并
// 原子占用其时间步(重放防护 + 并发只放行一个)。
// @returns ok=false 表示动态码错误、或该步已被使用过(重放)。
func verifyAndConsumeTOTP(db *sql.DB, userID int64, secret, code string) bool {
	step, ok := totpStepValid(secret, code, nowFn())
	if !ok {
		return false
	}
	consumed, err := serverstore.ConsumeTOTPStep(db, userID, step)
	if err != nil {
		log.Printf("mfa: consume totp step failed user=%d step=%d: %v", userID, step, err)
		return false
	}
	return consumed
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

// reserveMFAChallenge 原子地"占用一次尝试":未消费、未过期、未超次时才把
// attempts+1,并把该行的 user_id/secret 一并返回。
//
// 审计 2026-09-13 P1-1:旧实现是 getMFAChallenge(SELECT) → 判 attempts<5 →
// 失败后 bumpMFAChallengeAttempts(UPDATE),**检查与自增分离** —— 并发请求
// 都读到 attempts=0,实测同一票据 40 并发有 10 个穿过"最多 5 次"的门。
// 现在一条 UPDATE ... RETURNING 完成"检查+占用",上限是硬的。
func reserveMFAChallenge(db *sql.DB, id, kind string) (*mfaChallenge, error) {
	var m mfaChallenge
	var secret sql.NullString
	var expiresAt any
	err := db.QueryRow(`UPDATE admin_mfa_challenges
		SET attempts = attempts + 1
		WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > now() AND attempts < ?
		RETURNING user_id, secret, expires_at`, id, kind, mfaChallengeMaxFailed).
		Scan(&m.UserID, &secret, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, serverstore.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	m.ID = id
	m.Kind = kind
	m.Secret = secret.String
	m.ExpiresAt = parseChallengeTime(expiresAt)
	return &m, nil
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

func parseChallengeTime(v any) time.Time {
	if t, ok := v.(time.Time); ok {
		return t
	}
	return time.Time{}
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
