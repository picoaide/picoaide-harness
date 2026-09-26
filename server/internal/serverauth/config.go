package serverauth

import (
	"database/sql"
	"fmt"
	"log"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ProviderBuildFailure 描述"配置里启用了、但**构建失败**"的一个登录方式
// (R24-X4-B2)。
//
// 为什么必须把它当一等公民回报:构建是**有副作用的动作**(OIDC 要打 IdP 的
// discovery、LDAP 要必填项齐全),失败时 settings 依然"配置齐全" —— 于是
// `/auth/methods` 会照旧报 `configured:true`、登录页渲染一颗点到 404 的按钮、
// 保存接口回 200 `{"ok":true}`,而 **0 条日志**。旧实现(`browserFromSettings`
// 直接 return nil)正是这个形态。
type ProviderBuildFailure struct {
	// Name 是运行期注册名(local/ldap/oidc/openid),也是"保留旧实例"的键。
	Name string
	// Kind 区分两类 provider(kindPassword / kindBrowser)。
	Kind string
	// Err 是构建错误(如 discovery 失败)。
	Err error
}

func (f ProviderBuildFailure) Error() string {
	return fmt.Sprintf("%s(%s): %v", f.Name, f.Kind, f.Err)
}

func (f ProviderBuildFailure) Unwrap() error { return f.Err }

const (
	kindPassword = "password"
	kindBrowser  = "browser"
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
// 构建失败的登录方式**不在返回值里**,失败原因见 configureProvidersDetailed /
// configureProvidersFromSettings —— 运行期热加载(API.ReloadProviders)必须
// 据此**保留旧实例**并如实回报,不能静默摘除。
//
// 强制本地 admin:任何模式下都注册 local provider(管理员回退),保证
// 切换认证方式后本地 admin 仍能登录管理后台(审计 2026-08-29)。
func ConfigureProviders(db *sql.DB) ([]PasswordProvider, []BrowserProvider) {
	pwds, browsers, _ := configureProvidersDetailed(db)
	return pwds, browsers
}

// configureProvidersDetailed 是 ConfigureProviders 的带错误版本(唯一实现)。
// 读设置失败 ⇒ (nil, nil, nil):整表不可用由调用方处置(ReloadProviders 会
// 保留旧集合;启动期由 NewConfiguredAPI 记日志),这里不假装"没有配置"。
func configureProvidersDetailed(db *sql.DB) ([]PasswordProvider, []BrowserProvider, []ProviderBuildFailure) {
	settings, err := serverstore.GetAllSettings(db)
	if err != nil {
		return nil, nil, nil
	}
	return configureProvidersFromSettings(settings, db)
}

// configureProvidersFromSettings 是纯函数形式(测试可注入 settings,不必真库);
// db 只用于 local provider(它按用户名查 users 表)。
func configureProvidersFromSettings(settings map[string]string, db *sql.DB) ([]PasswordProvider, []BrowserProvider, []ProviderBuildFailure) {
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
	var failures []ProviderBuildFailure
	var pwds []PasswordProvider
	if has("local") {
		pwds = append(pwds, NewLocalProvider(db))
	}
	if has("ldap") {
		p, err := ldapFromSettings(settings)
		if err != nil {
			failures = append(failures, ProviderBuildFailure{Name: "ldap", Kind: kindPassword, Err: err})
		} else {
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
		if p, err := browserFromSettings(settings, "oidc", "oidc"); err != nil {
			failures = append(failures, ProviderBuildFailure{Name: "oidc", Kind: kindBrowser, Err: err})
		} else {
			browsers = append(browsers, p)
		}
	}
	if has("openid") {
		if p, err := browserFromSettings(settings, "openid", "openid"); err != nil {
			failures = append(failures, ProviderBuildFailure{Name: "openid", Kind: kindBrowser, Err: err})
		} else {
			browsers = append(browsers, p)
		}
	}
	return pwds, browsers, failures
}

// browserFromSettings builds a browser (OIDC) provider from settings with the
// given key prefix ("oidc." / "openid."); name is its protocol identity.
// 构建失败**必须**把原因交给调用方(见 ProviderBuildFailure),不得吞成 nil。
func browserFromSettings(s map[string]string, prefix, name string) (BrowserProvider, error) {
	p := &OIDCProvider{name: name}
	if err := p.Configure(stripPrefix(s, prefix+".")); err != nil {
		return nil, err
	}
	return p, nil
}

// ldapFromSettings 构建 LDAP 密码方式(唯一实现:登录/同步/热加载共用)。
// 构建失败(缺 server_url/base_dn 等必填项)必须把原因交给调用方,
// 不得吞成 nil —— 否则"配置不全"会静默退化成"没有这种登录方式"。
func ldapFromSettings(s map[string]string) (*LDAPProvider, error) {
	p := &LDAPProvider{}
	if err := p.Configure(stripPrefix(s, "ldap.")); err != nil {
		return nil, err
	}
	return p, nil
}

// logProviderBuildFailures 把构建失败写进启动日志(R24-X4-B2:旧实现零日志)。
//
// 启动期与运行期分开处置:启动期没有"旧实例"可保留(Provider 集合本来就没建
// 起来),所以只能如实记日志;运行期由 ReloadProviders 保留旧实例并把错误
// 一路回给保存接口(见 setAuthConfig)。
func logProviderBuildFailures(failures []ProviderBuildFailure) {
	for _, f := range failures {
		log.Printf("auth: 登录方式 %s 已启用但构建失败,当前**不可用**:%v", f.Name, f.Err)
	}
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
//
// 构建失败的登录方式在启动期**只能记日志**(此时没有旧实例可保留),所以这里
// 必须把原因写进启动日志 —— 旧实现零日志,现场只表现为"某种登录方式没有"
// (R24-X4-B2)。运行期保存配置时同一失败会经 ReloadProviders 保留旧实例并把
// 错误回给保存接口,见 AdminAPI.setAuthConfig。
func NewConfiguredAPI(db *sql.DB) *ConfiguredAPI {
	api := New(db)
	pwds, browsers, failures := configureProvidersDetailed(db)
	logProviderBuildFailures(failures)
	for _, p := range pwds {
		api.RegisterProvider(p)
	}
	// 客户端登录只允许 auth.enabled 里的密码方式(2026-09-08 P1-5);
	// local provider 仍注册,供管理后台回退(AuthenticateConfiguredAdmin)。
	api.SetEnabledProviders(EnabledProviderNames(db))
	return &ConfiguredAPI{API: api, Browsers: browsers}
}
