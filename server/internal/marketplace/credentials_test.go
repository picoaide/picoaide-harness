package marketplace

import (
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/util"
)

func TestEncryptEnvSensitiveKeys(t *testing.T) {
	key, err := util.EnsureMasterKey(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	encrypted := func(v string) bool { return strings.HasPrefix(v, util.EncPrefix) }
	env := map[string]string{
		"Authorization": "Bearer tok",
		"X-API-KEY":     "k123",
		"client_secret": "cs",
		"APP_ID":        "pub",
		"TIMEOUT":       "30",
		"API_KEY":       "ak",
		"TOKEN":         "tk",
		"PASSWORD":      "pw",
		"URL":           "http://x",
		"ENDPOINT":      "plain",
	}
	enc := EncryptEnv(key, env)
	for _, k := range []string{"Authorization", "X-API-KEY", "client_secret", "API_KEY", "TOKEN", "PASSWORD"} {
		if got := enc[k]; !encrypted(got) {
			t.Fatalf("%s = %q, want encrypted", k, got)
		}
	}
	for _, k := range []string{"APP_ID", "TIMEOUT", "URL", "ENDPOINT"} {
		if got := enc[k]; encrypted(got) {
			t.Fatalf("%s = %q, should not be encrypted", k, got)
		}
	}
	// decrypt round-trip restores the original values
	dec, err := DecryptEnv(key, enc)
	if err != nil {
		t.Fatal(err)
	}
	if dec["Authorization"] != "Bearer tok" || dec["X-API-KEY"] != "k123" {
		t.Fatalf("round trip mismatch: %+v", dec)
	}
}

// 审计 6-M5: a value that fails to decrypt must surface as an error — never
// return the ciphertext as if it were the credential.
func TestDecryptEnvFailureReturnsError(t *testing.T) {
	key, err := util.EnsureMasterKey(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bad := map[string]string{"API_KEY": util.EncPrefix + "not-valid-ciphertext"}
	dec, err := DecryptEnv(key, bad)
	if err == nil {
		t.Fatal("expected decrypt error for corrupted ciphertext")
	}
	if dec != nil {
		t.Fatalf("dec = %v, want nil on error", dec)
	}
	// plaintext (non-encrypted) values pass through untouched
	dec, err = DecryptEnv(key, map[string]string{"TIMEOUT": "30"})
	if err != nil || dec["TIMEOUT"] != "30" {
		t.Fatalf("plaintext passthrough: %v %v", dec, err)
	}
}
