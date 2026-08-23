package util

import (
	"strings"
	"testing"
)

func TestPasswordRoundTrip(t *testing.T) {
	hash, err := HashPassword("S3cret!pw")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(hash, "$argon2id$") {
		t.Fatalf("hash prefix = %q", hash)
	}
	if !VerifyPassword(hash, "S3cret!pw") {
		t.Fatal("VerifyPassword rejected correct password")
	}
	if VerifyPassword(hash, "wrong") {
		t.Fatal("VerifyPassword accepted wrong password")
	}
	if VerifyPassword(hash, "") {
		t.Fatal("VerifyPassword accepted empty")
	}
}

func TestHashSaltRandom(t *testing.T) {
	h1, _ := HashPassword("same")
	h2, _ := HashPassword("same")
	if h1 == h2 {
		t.Fatal("two hashes identical; salt not random")
	}
}

func TestVerifyMalformed(t *testing.T) {
	for _, h := range []string{"", "plain", "$argon2id$v=19$x$y", "$argon2id$v=19$m=1,t=0,p=1$c2FsdA$aGFzaA"} {
		if VerifyPassword(h, "x") {
			t.Fatalf("VerifyPassword accepted malformed hash %q", h)
		}
	}
}
