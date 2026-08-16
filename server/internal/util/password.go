package util

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
)

const (
	argonMemory      = 64 * 1024 // 64MB
	argonIterations  = 3
	argonParallelism = 2
	argonKeyLen      = 32
	argonSaltLen     = 16
)

// HashPassword hashes pw with argon2id and returns the encoded string
// "$argon2id$v=19$m=65536,t=3,p=2$<salt_b64>$<hash_b64>".
func HashPassword(pw string) (string, error) {
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	hash := argon2.IDKey([]byte(pw), salt, argonIterations, argonMemory, argonParallelism, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=19$m=%d,t=%d,p=%d$%s$%s",
		argonMemory, argonIterations, argonParallelism,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(hash)), nil
}

// VerifyPassword reports whether pw matches the encoded argon2id hash.
func VerifyPassword(hash, pw string) bool {
	parts := strings.Split(hash, "$")
	// $argon2id$v=19$m=...,t=...,p=...$salt$hash
	if len(parts) != 6 || parts[1] != "argon2id" {
		return false
	}
	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil {
		return false
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil {
		return false
	}
	var mem, iter, par int
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &mem, &iter, &par); err != nil {
		return false
	}
	if iter == 0 || par == 0 || mem == 0 {
		return false
	}
	got := argon2.IDKey([]byte(pw), salt, uint32(iter), uint32(mem), uint8(par), uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1
}
