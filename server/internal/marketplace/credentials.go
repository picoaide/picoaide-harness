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

// MaskPlaceholder marks a masked credential value in admin responses. The
// webadmin edit form sends it back unchanged for values the admin did not
// retype; the server treats it as "keep the stored value".
const MaskPlaceholder = "***"

// mergeEnvValues merges incoming (possibly masked) env/headers into the
// stored values (审计 A5-H2 更新契约):
//
//   - incoming 为 nil  → 返回空 map(调用方应跳过,整体不变);
//   - 值为 MaskPlaceholder 或 enc:v1: 前缀 → 保持 stored 中该 key 的现有值
//     (key 不存在则忽略,防止伪造密文注入);
//   - 其它值 → 覆盖该 key(调用方随后按敏感度加密);
//   - 请求 map 中未出现的 key → 从结果中移除(整 map 语义 = 期望的完整 key 集合,
//     编辑表单回传完整 key 集即可实现删除)。
func mergeEnvValues(stored, incoming map[string]string) map[string]string {
	out := make(map[string]string, len(incoming))
	for k, v := range incoming {
		if v == MaskPlaceholder || strings.HasPrefix(v, util.EncPrefix) {
			if cur, ok := stored[k]; ok {
				out[k] = cur
			}
			continue
		}
		out[k] = v
	}
	return out
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
