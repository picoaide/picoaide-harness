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
	pwds, browser := ConfigureProviders(db)
	if len(pwds) != 1 || pwds[0].Name() != "local" {
		t.Fatalf("pwds = %v, want [local]", pwds)
	}
	if browser != nil {
		t.Fatalf("browser = %v, want nil", browser)
	}
}

func TestConfigureProvidersLDAPMode(t *testing.T) {
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.mode", "ldap"); err != nil {
		t.Fatal(err)
	}
	// missing ldap config -> no providers at all
	if pwds, _ := ConfigureProviders(db); len(pwds) != 0 {
		t.Fatalf("pwds = %v, want none", pwds)
	}
	if err := serverstore.SetSetting(db, "ldap.server_url", "ldap://x"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "ldap.base_dn", "dc=x"); err != nil {
		t.Fatal(err)
	}
	pwds, _ := ConfigureProviders(db)
	if len(pwds) != 1 || pwds[0].Name() != "ldap" {
		t.Fatalf("pwds = %v, want [ldap]", pwds)
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

// TestLDAPModeExcludesLocal verifies the wiring used by cmd/server/main.go:
// the API registers exactly what ConfigureProviders returns. In ldap mode a
// stale local account must not be able to log in.
func TestLDAPModeExcludesLocal(t *testing.T) {
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
	// local provider must NOT be registered in ldap-only mode
	if _, ok := cfg.API.providers["local"]; ok {
		t.Fatal("local provider registered in ldap mode")
	}
	// and the legacy local account cannot authenticate
	if _, err := cfg.API.authenticate("legacy", "pw123456"); err == nil {
		t.Fatal("local account authenticated in ldap-only mode")
	}
}

func TestConfigureProvidersOIDC(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "oidc.issuer", idp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "oidc.client_id", "test-client"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "oidc.redirect_url", "http://localhost/api/auth/oidc/callback"); err != nil {
		t.Fatal(err)
	}
	_, browser := ConfigureProviders(db)
	if browser == nil || browser.Name() != "oidc" {
		t.Fatalf("browser = %v, want oidc", browser)
	}
}
