package util

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCryptoRoundTrip(t *testing.T) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		t.Fatal(err)
	}
	ct := Encrypt(key, "hello 世界")
	if !strings.HasPrefix(ct, "enc:v1:") {
		t.Fatalf("ciphertext %q missing enc:v1: prefix", ct)
	}
	pt, err := Decrypt(key, ct)
	if err != nil || pt != "hello 世界" {
		t.Fatalf("round trip = %q, %v", pt, err)
	}
	// random nonce -> different ciphertexts for the same plaintext
	if Encrypt(key, "hello") == Encrypt(key, "hello") {
		t.Fatal("ciphertexts identical, nonce reuse")
	}

	other := make([]byte, 32)
	if _, err := rand.Read(other); err != nil {
		t.Fatal(err)
	}
	if _, err := Decrypt(other, ct); err == nil {
		t.Fatal("wrong key accepted")
	}
	if _, err := Decrypt(key, "enc:v1:!!!not-base64!!!"); err == nil {
		t.Fatal("garbage ciphertext accepted")
	}
	if _, err := Decrypt(key, "no-prefix"); err == nil {
		t.Fatal("non-prefixed value accepted")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(ct, "enc:v1:"))
	if err != nil {
		t.Fatal(err)
	}
	raw[12] ^= 0xff // tamper with the ciphertext
	if _, err := Decrypt(key, "enc:v1:"+base64.StdEncoding.EncodeToString(raw)); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}

	// 16/24-byte keys are valid AES key lengths
	for _, n := range []int{16, 24} {
		k := make([]byte, n)
		if _, err := rand.Read(k); err != nil {
			t.Fatal(err)
		}
		c := Encrypt(k, "x")
		p, err := Decrypt(k, c)
		if err != nil || p != "x" {
			t.Fatalf("%d-byte key round trip = %q, %v", n, p, err)
		}
	}
}

func TestEnsureMasterKeyFile(t *testing.T) {
	dir := t.TempDir()
	key, err := EnsureMasterKey(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(key) != 32 {
		t.Fatalf("key length = %d, want 32", len(key))
	}
	info, err := os.Stat(filepath.Join(dir, "master.key"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0600 {
		t.Fatalf("master.key perms = %o, want 0600", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm != 0700 {
		t.Fatalf("dataDir perms = %o, want 0700", perm)
	}
	// idempotent across restarts
	key2, err := EnsureMasterKey(dir)
	if err != nil || !bytes.Equal(key, key2) {
		t.Fatalf("second EnsureMasterKey differs: %v", err)
	}
	got, err := GetMasterKey()
	if err != nil || !bytes.Equal(key, got) {
		t.Fatalf("GetMasterKey = %v, %v", got, err)
	}
	// master key never lands in the DB (nothing to assert here; the file
	// based flow above is the only persistence)
}

func TestEnsureMasterKeyEnv(t *testing.T) {
	envKey := "0123456789abcdef0123456789abcdef" // 32 bytes
	t.Setenv("PICOAI_MASTER_KEY", envKey)
	dir := t.TempDir()
	key, err := EnsureMasterKey(dir)
	if err != nil || string(key) != envKey {
		t.Fatalf("EnsureMasterKey env = %q, %v", key, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "master.key")); !os.IsNotExist(err) {
		t.Fatal("master.key written despite env key")
	}
	got, err := GetMasterKey()
	if err != nil || string(got) != envKey {
		t.Fatalf("GetMasterKey env = %q, %v", got, err)
	}

	t.Setenv("PICOAI_MASTER_KEY", "short")
	if _, err := EnsureMasterKey(t.TempDir()); err == nil {
		t.Fatal("invalid env key length accepted")
	}
}

func TestGetMasterKeyUninitialized(t *testing.T) {
	restore := masterKeyFile
	masterKeyFile = ""
	defer func() { masterKeyFile = restore }()
	if _, err := GetMasterKey(); err == nil {
		t.Fatal("GetMasterKey before EnsureMasterKey should error")
	}
}
