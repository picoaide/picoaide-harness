package serverauth

import (
	"database/sql"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func newStoreDB(t *testing.T) *sql.DB {
	t.Helper()
	db, cleanup := serverstore.NewTestDB(t)
	t.Cleanup(cleanup)
	return db
}

func TestConfigureProvidersEmptySettings(t *testing.T) {
	db := newStoreDB(t)
	pwds, browsers := ConfigureProviders(db)
	if len(pwds) != 1 || pwds[0].Name() != "local" {
		t.Fatalf("pwds = %v, want [local]", pwds)
	}
	if len(browsers) != 0 {
		t.Fatalf("browsers = %v, want none", browsers)
	}
}

func TestConfigureProvidersLDAPMode(t *testing.T) {
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.mode", "ldap"); err != nil {
		t.Fatal(err)
	}
	// missing ldap config -> only local (admin 回退恒存在)
	if pwds, _ := ConfigureProviders(db); len(pwds) != 1 || pwds[0].Name() != "local" {
		t.Fatalf("pwds = %v, want [local] (admin fallback)", pwds)
	}
	if err := serverstore.SetSetting(db, "ldap.server_url", "ldap://x"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.base_dn", "dc=x"); err != nil {
		t.Fatal(err)
	}
	pwds, _ := ConfigureProviders(db)
	if len(pwds) != 2 || pwds[0].Name() != "local" || pwds[1].Name() != "ldap" {
		t.Fatalf("pwds = %v, want [local ldap]", pwds)
	}
}

func TestConfigureProvidersBothMode(t *testing.T) {
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.mode", "both"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.server_url", "ldap://x"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.base_dn", "dc=x"); err != nil {
		t.Fatal(err)
	}
	pwds, _ := ConfigureProviders(db)
	if len(pwds) != 2 || pwds[0].Name() != "local" || pwds[1].Name() != "ldap" {
		t.Fatalf("pwds = %v, want [local ldap]", pwds)
	}
}

// TestLDAPModeKeepsLocalAdminFallback verifies local provider 恒注册:
// ldap 模式下本地 admin 永远可以登录管理后台(审计 2026-08-29)。
func TestLDAPModeKeepsLocalAdminFallback(t *testing.T) {
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.mode", "ldap"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.server_url", "ldap://x"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.base_dn", "dc=x"); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateUserWithPassword(db, "legacy", "pw123456"); err != nil {
		t.Fatal(err)
	}
	cfg := NewConfiguredAPI(db)
	// local provider 必须注册(admin 回退)
	if _, ok := cfg.API.providers["local"]; !ok {
		t.Fatal("local provider not registered in ldap mode")
	}
	// 本地账号仍可认证(管理后台登录用)
	if _, err := cfg.API.authenticate("legacy", "pw123456"); err != nil {
		t.Fatal("local account cannot authenticate in ldap mode:", err)
	}
}

func TestConfigureProvidersOIDC(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,oidc"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "oidc.issuer", idp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "oidc.client_id", "test-client"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "oidc.redirect_url", "http://localhost/api/auth/oidc/callback"); err != nil {
		t.Fatal(err)
	}
	_, browsers := ConfigureProviders(db)
	if len(browsers) != 1 || browsers[0].Name() != "oidc" {
		t.Fatalf("browsers = %v, want [oidc]", browsers)
	}
}
