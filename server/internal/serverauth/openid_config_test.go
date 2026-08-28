package serverauth

import (
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// TestConfigureProvidersOpenID verifies openid.* settings configure a
// separate browser provider (独立于 oidc.*,两套 IdP 可并存)。
func TestConfigureProvidersOpenID(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,openid"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.issuer", idp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.client_id", "test-client"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.redirect_url", "http://localhost/api/auth/openid/callback"); err != nil {
		t.Fatal(err)
	}
	_, browsers := ConfigureProviders(db)
	// openid 配置存在时应返回一个名为 openid 的 browser provider
	if len(browsers) != 1 || browsers[0].Name() != "openid" {
		t.Fatalf("browsers = %v, want [openid]", browsers)
	}
}

// TestConfigureProvidersOpenIDIndependent ensures openid and oidc settings
// are independent: configuring one does not imply the other.
func TestConfigureProvidersOpenIDIndependent(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,openid"); err != nil {
		t.Fatal(err)
	}
	// 只配 openid,不配 oidc
	if err := serverstore.SetSetting(db, "openid.issuer", idp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.client_id", "oc"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.redirect_url", "http://localhost/api/auth/openid/callback"); err != nil {
		t.Fatal(err)
	}
	_, browsers := ConfigureProviders(db)
	if len(browsers) != 1 || browsers[0].Name() != "openid" {
		t.Fatalf("browsers = %v, want [openid only]", browsers)
	}
}

// TestConfigureProvidersOpenIDAndOIDCBoth allows both IdPs simultaneously.
func TestConfigureProvidersOpenIDAndOIDCBoth(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,oidc,openid"); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"oidc", "openid"} {
		if err := serverstore.SetSetting(db, key+".issuer", idp.srv.URL); err != nil {
			t.Fatal(err)
		}
		if err := serverstore.SetSetting(db, key+".client_id", "c-"+key); err != nil {
			t.Fatal(err)
		}
		if err := serverstore.SetSetting(db, key+".redirect_url", "http://localhost/api/auth/"+key+"/callback"); err != nil {
			t.Fatal(err)
		}
	}
	_, browsers := ConfigureProviders(db)
	if len(browsers) != 2 || browsers[0].Name() != "oidc" || browsers[1].Name() != "openid" {
		t.Fatalf("browsers = %v, want [oidc openid]", browsers)
	}
}

// TestConfigureProvidersAuthModeOpenID verifies local fallback (admin access)
// in openid mode.
func TestConfigureProvidersAuthModeOpenID(t *testing.T) {
	idp := newFakeIDP(t)
	db := newStoreDB(t)
	if err := serverstore.SetSetting(db, "auth.mode", "openid"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.issuer", idp.srv.URL); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.client_id", "oc"); err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetSetting(db, "openid.redirect_url", "http://localhost/api/auth/openid/callback"); err != nil {
		t.Fatal(err)
	}
	pwds, browsers := ConfigureProviders(db)
	// admin 回退:本地 provider 必须注册
	foundLocal := false
	for _, p := range pwds {
		if p.Name() == "local" {
			foundLocal = true
		}
	}
	if !foundLocal {
		t.Fatalf("pwds = %v, want local fallback in openid mode", pwds)
	}
	if len(browsers) != 1 || browsers[0].Name() != "openid" {
		t.Fatalf("browsers = %v, want [openid]", browsers)
	}
}
