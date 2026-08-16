package marketplace

import (
	"fmt"
	"strings"

	"github.com/picoaide/picoaide/internal/util"
)

// sensitiveEnvKeys: values under these keys (case-insensitive) are encrypted
// at rest. Empty values are left untouched.
//
// 用包含式匹配而非精确 key 集合:授权头(Authorization/x-api-key)、
// client_secret 等常见凭证命名若不在精确集合里会明文落库;任何含
// "key"/"secret"/"token"/"password"/"authorization" 的 key 一律加密。
func sensitiveEnvKey(k string) bool {
	lower := strings.ToLower(k)
	for _, sub := range []string{"authorization", "api_key", "token", "password", "secret", "key"} {
		if strings.Contains(lower, sub) {
			return true
		}
	}
	return false
}

// EncryptEnv encrypts sensitive values with the master key; values already
// carrying the "enc:v1:" prefix pass through unchanged.
func EncryptEnv(key []byte, env map[string]string) map[string]string {
	out := make(map[string]string, len(env))
	for k, v := range env {
		if v != "" && !strings.HasPrefix(v, util.EncPrefix) && sensitiveEnvKey(k) {
			out[k] = util.Encrypt(key, v)
		} else {
			out[k] = v
		}
	}
	return out
}

// DecryptEnv reverses EncryptEnv. A value that fails to decrypt returns an
// error (审计 6-M5) — the ciphertext must never be handed out as if it were
// the credential.
func DecryptEnv(key []byte, env map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(env))
	for k, v := range env {
		if strings.HasPrefix(v, util.EncPrefix) {
			pt, err := util.Decrypt(key, v)
			if err != nil {
				return nil, fmt.Errorf("marketplace: decrypt %s: %w", k, err)
			}
			out[k] = pt
		} else {
			out[k] = v
		}
	}
	return out, nil
}
