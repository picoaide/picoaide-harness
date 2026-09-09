// IdP 凭据的静态加密(2026-09-08 审计 P1-1)。
//
// ldap.bind_password / oidc.client_secret / openid.client_secret 与上游 API
// key(llmgateway)同口径:用 master key 做 AES-GCM,落库形如 enc:v1:<b64>。
// 读取侧兼容历史明文值(无 enc:v1: 前缀时原样返回),因此升级无需数据迁移。
package serverauth

import (
	"strings"

	"github.com/picoaide/picoaide/internal/util"
)

// encryptSettingSecret seals a credential for storage. An empty value stays
// empty (empty means "clear the setting"), matching the upsert semantics.
func encryptSettingSecret(plaintext string) (string, error) {
	if plaintext == "" {
		return "", nil
	}
	key, err := util.GetMasterKey()
	if err != nil {
		return "", err
	}
	return util.Encrypt(key, plaintext), nil
}

// decryptSettingSecret opens a stored credential. Values written before
// 2026-09-08 are plaintext and are returned unchanged; an undecryptable
// ciphertext degrades to "" (the provider then behaves as unconfigured rather
// than authenticating with garbage).
func decryptSettingSecret(raw string) string {
	if raw == "" || !strings.HasPrefix(raw, util.EncPrefix) {
		return raw
	}
	key, err := util.GetMasterKey()
	if err != nil {
		return ""
	}
	plain, err := util.Decrypt(key, raw)
	if err != nil {
		return ""
	}
	return plain
}
