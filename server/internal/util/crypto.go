package util

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EncPrefix marks AES-GCM encrypted values: "enc:v1:<base64(nonce+ciphertext)>".
const EncPrefix = "enc:v1:"

const masterKeyEnv = "PICOAI_MASTER_KEY"

// masterKeyFile is the path written by EnsureMasterKey; GetMasterKey reads it.
var masterKeyFile string

// EnsureMasterKey returns the master key: PICOAI_MASTER_KEY env when set,
// otherwise a 32-byte random key written to dataDir/master.key (0600).
// The master key is never stored in the database.
func EnsureMasterKey(dataDir string) ([]byte, error) {
	if k := os.Getenv(masterKeyEnv); k != "" {
		return parseKey(k)
	}
	path := filepath.Join(dataDir, "master.key")
	if b, err := os.ReadFile(path); err == nil {
		masterKeyFile = path
		return parseKey(string(b))
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dataDir, 0700); err != nil { // enforce perms on existing dirs
		return nil, err
	}
	if err := os.WriteFile(path, key, 0600); err != nil {
		return nil, err
	}
	masterKeyFile = path
	return key, nil
}

// GetMasterKey returns the master key from the environment or the file
// written by EnsureMasterKey.
func GetMasterKey() ([]byte, error) {
	if k := os.Getenv(masterKeyEnv); k != "" {
		return parseKey(k)
	}
	if masterKeyFile == "" {
		return nil, errors.New("master key not initialized")
	}
	b, err := os.ReadFile(masterKeyFile)
	if err != nil {
		return nil, err
	}
	return parseKey(string(b))
}

func parseKey(s string) ([]byte, error) {
	switch len(s) {
	case 16, 24, 32:
		return []byte(s), nil
	}
	return nil, fmt.Errorf("master key must be 16/24/32 bytes, got %d", len(s))
}

// Encrypt returns "enc:v1:<base64(nonce||ciphertext)>" with a fresh random
// nonce per call.
func Encrypt(key []byte, plaintext string) string {
	gcm, err := newGCM(key)
	if err != nil {
		panic(err) // key length is validated by EnsureMasterKey/GetMasterKey
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		panic(err)
	}
	return EncPrefix + base64.StdEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(plaintext), nil))
}

// Decrypt reverses Encrypt; any malformed, tampered or foreign-key value
// returns an error.
func Decrypt(key []byte, s string) (string, error) {
	gcm, err := newGCM(key)
	if err != nil {
		return "", err
	}
	if len(s) < len(EncPrefix) || s[:len(EncPrefix)] != EncPrefix {
		return "", errors.New("not an encrypted value")
	}
	raw, err := base64.StdEncoding.DecodeString(s[len(EncPrefix):])
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(raw) <= ns {
		return "", errors.New("ciphertext too short")
	}
	pt, err := gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
