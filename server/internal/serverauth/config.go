package serverauth

import (
	"database/sql"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ConfigureProviders reads auth settings and returns the password providers
// and optional browser provider to register on the API. Settings:
//
//	auth.mode        local | ldap | both (default local)
//	ldap.*           server_url/bind_dn/bind_password/base_dn/user_filter/group_filter/group_attr
//	oidc.*           issuer/client_id/client_secret/redirect_url
//
// Unconfigured providers are omitted; a broken ldap/oidc config degrades to
// nothing rather than failing startup.
func ConfigureProviders(db *sql.DB) ([]PasswordProvider, BrowserProvider) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, nil
	}
	mode := settings["auth.mode"]
	if mode == "" {
		mode = "local"
	}
	var pwds []PasswordProvider
	switch mode {
	case "local":
		pwds = append(pwds, NewLocalProvider(db))
	case "ldap":
		if p := ldapFromSettings(settings); p != nil {
			pwds = append(pwds, p)
		}
	case "both":
		pwds = append(pwds, NewLocalProvider(db))
		if p := ldapFromSettings(settings); p != nil {
			pwds = append(pwds, p)
		}
	case "oidc":
		// OIDC 纯浏览器登录:保留本地密码 provider 作为回退(管理员/断网场景),
		// 浏览器 OIDC flow 由 RegisterOIDC 单独启用。
		pwds = append(pwds, NewLocalProvider(db))
	}
	var browser BrowserProvider
	if p := oidcFromSettings(settings); p != nil {
		browser = p
	}
	return pwds, browser
}

func ldapFromSettings(s map[string]string) PasswordProvider {
	p := &LDAPProvider{}
	if err := p.Configure(stripPrefix(s, "ldap.")); err != nil {
		return nil
	}
	return p
}

func oidcFromSettings(s map[string]string) BrowserProvider {
	p := &OIDCProvider{}
	if err := p.Configure(stripPrefix(s, "oidc.")); err != nil {
		return nil
	}
	return p
}

func stripPrefix(m map[string]string, prefix string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		if strings.HasPrefix(k, prefix) {
			out[strings.TrimPrefix(k, prefix)] = v
		}
	}
	return out
}

// ConfiguredAPI bundles the auth API with its configured browser provider.
type ConfiguredAPI struct {
	API  *API
	OIDC BrowserProvider
}

// NewConfiguredAPI builds the auth API registering exactly the providers that
// ConfigureProviders returns. In ldap-only mode the local provider is NOT
// registered, so stale local accounts cannot log in.
func NewConfiguredAPI(db *sql.DB) *ConfiguredAPI {
	api := New(db)
	pwds, browser := ConfigureProviders(db)
	for _, p := range pwds {
		api.RegisterProvider(p)
	}
	return &ConfiguredAPI{API: api, OIDC: browser}
}
