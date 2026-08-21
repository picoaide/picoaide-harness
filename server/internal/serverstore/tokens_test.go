package serverstore

import (
	"testing"
	"time"
)

func TestTokens(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "tokuser", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}

	id, err := CreateToken(db, uid, "raw-token-abc", time.Now().Add(90*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	got, err := GetTokenByHash(db, TokenHash("raw-token-abc"))
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != id || got.UserID != uid || got.Revoked != 0 || got.ExpiresAt.IsZero() {
		t.Fatalf("token mismatch: %+v", got)
	}

	// revoke
	if err := RevokeToken(db, TokenHash("raw-token-abc")); err != nil {
		t.Fatal(err)
	}
	got2, _ := GetTokenByHash(db, TokenHash("raw-token-abc"))
	if got2.Revoked != 1 {
		t.Fatal("not revoked")
	}

	// expired detection: token with past expiry
	if _, err := CreateToken(db, uid, "expired-token", time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	exp, err := GetTokenByHash(db, TokenHash("expired-token"))
	if err != nil {
		t.Fatal(err)
	}
	if !exp.ExpiresAt.Before(time.Now()) {
		t.Fatal("expired token should be before now")
	}
}

func TestListTokensByUser(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "toklist1", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}

	// empty
	toks, err := ListTokensByUser(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(toks) != 0 {
		t.Fatalf("want 0 tokens, got %d", len(toks))
	}

	now := time.Now()
	id1, err := CreateToken(db, uid, "list-tok-1", now.Add(90*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	id2, err := CreateToken(db, uid, "list-tok-2", now.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := RevokeToken(db, TokenHash("list-tok-2")); err != nil {
		t.Fatal(err)
	}

	toks, err = ListTokensByUser(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if len(toks) != 2 {
		t.Fatalf("want 2 tokens, got %d", len(toks))
	}
	for _, tk := range toks {
		if tk.TokenHash != "" {
			t.Fatal("token hash leaked in listing")
		}
		if tk.ID == id1 && tk.Revoked != 0 {
			t.Fatal("tok1 should be active")
		}
		if tk.ID == id2 && tk.Revoked != 1 {
			t.Fatal("tok2 should be revoked")
		}
		if tk.ExpiresAt.IsZero() || tk.CreatedAt == "" {
			t.Fatal("missing dates")
		}
	}

	// other users' tokens excluded
	uid2, err := CreateUser(db, &User{Username: "toklist2", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateToken(db, uid2, "list-tok-3", now.Add(90*24*time.Hour)); err != nil {
		t.Fatal(err)
	}
	toks, _ = ListTokensByUser(db, uid)
	if len(toks) != 2 {
		t.Fatalf("other user token leaked: %d", len(toks))
	}
}

func TestRevokeTokenByID(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "tokrev", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := CreateToken(db, uid, "revoke-by-id", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}

	if err := RevokeTokenByID(db, id); err != nil {
		t.Fatal(err)
	}
	got, _ := GetTokenByHash(db, TokenHash("revoke-by-id"))
	if got.Revoked != 1 {
		t.Fatal("not revoked")
	}
	// idempotent
	if err := RevokeTokenByID(db, id); err != nil {
		t.Fatalf("second revoke: %v", err)
	}
	// nonexistent
	if err := RevokeTokenByID(db, 999999); err != ErrNotFound {
		t.Fatalf("want ErrNotFound, got %v", err)
	}
}

func TestTouchTokenLastUsed(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "toktouch", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := CreateToken(db, uid, "touch-tok", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := TouchTokenLastUsed(db, id); err != nil {
		t.Fatal(err)
	}
	got, _ := GetTokenByHash(db, TokenHash("touch-tok"))
	if got.LastUsedAt.IsZero() {
		t.Fatal("last_used_at not set")
	}
}

// 审计 5#3: repeated verifications must not rewrite last_used_at more than
// once per tokenTouchInterval (write-amplification throttle).
func TestTouchTokenLastUsedThrottle(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "tokthrottle", Source: "local"})
	if err != nil {
		t.Fatal(err)
	}
	id, err := CreateToken(db, uid, "throttle-tok", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := TouchTokenLastUsed(db, id); err != nil {
		t.Fatal(err)
	}
	// simulate a later moment still inside the throttle window: the row must
	// not be rewritten by a second touch
	future := time.Now().Add(30 * time.Second).UTC().Format(time.RFC3339)
	if _, err := db.Exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", future, id); err != nil {
		t.Fatal(err)
	}
	if err := TouchTokenLastUsed(db, id); err != nil {
		t.Fatal(err)
	}
	var got string
	if err := db.QueryRow("SELECT last_used_at FROM api_tokens WHERE id = ?", id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	// 驱动在 _timezone=Local 下以本地时区表示同一时刻(如 "…+08:00"),
	// 字符串格式不再等于写入时的 UTC RFC3339,须按绝对时刻比较。
	wantT, err := time.Parse(time.RFC3339, future)
	if err != nil {
		t.Fatal(err)
	}
	gotT, err := time.Parse(time.RFC3339, got)
	if err != nil || !gotT.Equal(wantT) {
		t.Fatalf("throttled touch rewrote the row: %q (parsed %v) != %q (%v)", got, gotT, future, wantT)
	}
	// outside the window the touch writes again
	old := time.Now().Add(-5 * time.Minute).UTC().Format(time.RFC3339)
	if _, err := db.Exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", old, id); err != nil {
		t.Fatal(err)
	}
	if err := TouchTokenLastUsed(db, id); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT last_used_at FROM api_tokens WHERE id = ?", id).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got == old {
		t.Fatal("touch outside the throttle window was skipped")
	}
}
