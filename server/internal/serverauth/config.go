package serverauth

import (
	"database/sql"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ConfigureProviders reads auth settings and returns the password providers
// and optional browser providers to register on the API. Settings:
//
//	auth.enabled      local,ldap,openid,oidc (逗号分隔;优先级高于 auth.mode)
//	auth.mode         local | ldap | both | oidc | openid (向后兼容,enabled 缺失时推导)
//	ldap.*            server_url/bind_dn/bind_password/base_dn/user_filter/group_filter/group_attr
//	oidc.*            issuer/client_id/client_secret/redirect_url
//	openid.*          issuer/client_id/client_secret/redirect_url (独立两套 IdP)
//
// Unconfigured providers are omitted; a broken ldap/oidc/openid config
// degrades to nothing rather than failing startup.
//
// 强制本地 admin:任何模式下都注册 local provider(管理员回退),保证
// 切换认证方式后本地 admin 仍能登录管理后台(审计 2026-08-29)。
func ConfigureProviders(db *sql.DB) ([]PasswordProvider, []BrowserProvider) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, nil
	}
	mode := settings["auth.mode"]
	if mode == "" {
		mode = "local"
	}
	enabled := enabledProviderNames(settings)
	has := func(name string) bool {
		for _, e := range enabled {
			if e == name {
				return true
			}
		}
		return false
	}
	var pwds []PasswordProvider
	if has("local") {
		pwds = append(pwds, NewLocalProvider(db))
	}
	if has("ldap") {
		if p := ldapFromSettings(settings); p != nil {
			pwds = append(pwds, p)
		}
	}
	// 强制本地 admin:无论 enabled 是否含 local,恒注册 local(管理员回退)
	if !has("local") {
		pwds = append([]PasswordProvider{NewLocalProvider(db)}, pwds...)
	}
	var browsers []BrowserProvider
	// 两套 IdP 可独立配置并存(openid.* 与 oidc.*)
	if has("oidc") {
		if p := browserFromSettings(settings, "oidc", "oidc"); p != nil {
			browsers = append(browsers, p)
		}
	}
	if has("openid") {
		if p := browserFromSettings(settings, "openid", "openid"); p != nil {
			browsers = append(browsers, p)
		}
	}
	return pwds, browsers
}

// browserFromSettings builds a browser (OIDC) provider from settings with the
// given key prefix ("oidc." / "openid."); name is its protocol identity.
func browserFromSettings(s map[string]string, prefix, name string) BrowserProvider {
	p := &OIDCProvider{name: name}
	if err := p.Configure(stripPrefix(s, prefix+".")); err != nil {
		return nil
	}
	return p
}

func ldapFromSettings(s map[string]string) PasswordProvider {
	p := &LDAPProvider{}
	if err := p.Configure(stripPrefix(s, "ldap.")); err != nil {
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

// enabledProviderNames resolves auth.enabled (falling back to auth.mode).
// Single source for both ConfigureProviders and the client login order
// (2026-09-08 P1-5).
func enabledProviderNames(settings map[string]string) []string {
	if raw := strings.TrimSpace(settings["auth.enabled"]); raw != "" {
		out := make([]string, 0, 4)
		for _, p := range strings.Split(raw, ",") {
			if p = strings.TrimSpace(p); p != "" {
				out = append(out, p)
			}
		}
		return out
	}
	// 向后兼容:由 auth.mode 推导
	switch settings["auth.mode"] {
	case "ldap", "both":
		return []string{"local", "ldap"}
	case "oidc":
		return []string{"local", "oidc"}
	case "openid":
		return []string{"local", "openid"}
	default:
		return []string{"local"}
	}
}

// EnabledProviderNames reads the enabled provider list from settings (used to
// pin the client-surface login order).
func EnabledProviderNames(db *sql.DB) []string {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil
	}
	return enabledProviderNames(settings)
}

// ConfiguredAPI bundles the auth API with its configured browser providers.
type ConfiguredAPI struct {
	API      *API
	Browsers []BrowserProvider
}

// NewConfiguredAPI builds the auth API registering exactly the providers that
// ConfigureProviders returns. local provider 恒注册(admin 回退)。
func NewConfiguredAPI(db *sql.DB) *ConfiguredAPI {
	api := New(db)
	pwds, browsers := ConfigureProviders(db)
	for _, p := range pwds {
		api.RegisterProvider(p)
	}
	// 客户端登录只允许 auth.enabled 里的密码方式(2026-09-08 P1-5);
	// local provider 仍注册,供管理后台回退(AuthenticateConfiguredAdmin)。
	api.SetEnabledProviders(EnabledProviderNames(db))
	return &ConfiguredAPI{API: api, Browsers: browsers}
}
