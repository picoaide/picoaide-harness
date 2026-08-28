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
	enabledRaw := settings["auth.enabled"]
	var enabled []string
	if strings.TrimSpace(enabledRaw) != "" {
		for _, p := range strings.Split(enabledRaw, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				enabled = append(enabled, p)
			}
		}
	} else {
		// 向后兼容:由 auth.mode 推导
		switch mode {
		case "ldap", "both":
			enabled = []string{"local", "ldap"}
		case "oidc":
			enabled = []string{"local", "oidc"}
		case "openid":
			enabled = []string{"local", "openid"}
		default:
			enabled = []string{"local"}
		}
	}
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
	return &ConfiguredAPI{API: api, Browsers: browsers}
}
