package serverauth

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// EnsureBootstrapAdmin creates the first admin from --bootstrap-admin and
// PICOAI_ADMIN_PASSWORD when no admin exists yet. It fails when the env
// password is missing (never prints or randomizes the password).
func EnsureBootstrapAdmin(db *sql.DB, username string) error {
	users, _, err := serverstore.ListUsers(db, 0, 100000, "")
	if err != nil {
		return err
	}
	for _, u := range users {
		if u.IsSuperAdmin() {
			return nil // super_admin exists; ignore
		}
	}
	password := os.Getenv("PICOAI_ADMIN_PASSWORD")
	if password == "" {
		return fmt.Errorf("PICOAI_ADMIN_PASSWORD environment variable is required to bootstrap admin %q", username)
	}
	// C-16: enforce the same policy as admin-created users, or the
	// --bootstrap-admin path would be a weak-password backdoor.
	if utf8.RuneCountInString(password) < serverstore.AuthMinPasswordLength(db) {
		return fmt.Errorf("PICOAI_ADMIN_PASSWORD must be at least %d characters", serverstore.AuthMinPasswordLength(db))
	}
	_, err = serverstore.GetUserByUsername(db, username)
	if err == nil {
		return errors.New("bootstrap admin username already exists but is not an admin")
	}
	// 单步创建(含 is_admin):创建与提权之间的崩溃窗口不再留下
	// "同名非管理员用户阻塞下次启动"的残局(审计2026-L15)
	hash, err := util.HashPassword(password)
	if err != nil {
		return err
	}
	if _, err := serverstore.CreateUser(db, &serverstore.User{Username: username, PasswordHash: hash, Source: "local", Status: 1, IsAdmin: true}); err != nil {
		return err
	}
	return nil
}
