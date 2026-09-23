package serverauth

// UserInfo is the normalized identity returned by providers.
type UserInfo struct {
	Username    string
	DisplayName string
	Email       string
	Groups      []string
	// GroupsPresent 表示本次认证**确实拿到了组声明**(哪怕为空数组)。
	// 用于区分"IdP 说该用户不属于任何组"(要回收)与"这次没下发组 claim"
	// (不能回收 —— 否则会清掉另一套 IdP/LDAP 同步来的组,审计 2026-09-13 P2-9)。
	GroupsPresent bool
	// ExternalID 是 IdP 侧的主体标识(OIDC 的 sub;LDAP 的 entry DN)。
	// 外部身份按 (ExternalID) 绑定到本地行,而不是只按用户名 —— 否则同名
	// 外部身份互相接管(审计 2026-09-13 P2-9)。local 身份为空。
	ExternalID string
	// Source identifies the identity source: "local" for the local users
	// table, "external" for ldap/oidc. provisionUser refuses to let an
	// external identity adopt a local account row.
	Source string
	// ExternalSource 是哪套 IdP(ldap/oidc/openid);仅 external 有值。
	ExternalSource string
}

// PasswordProvider authenticates via username/password (local/ldap).
type PasswordProvider interface {
	Name() string
	Authenticate(username, password string) (UserInfo, error)
	Configure(cfg map[string]string) error
}

// BrowserProvider authenticates via browser redirect flow (oidc).
type BrowserProvider interface {
	Name() string
	// AuthURL starts the browser redirect. `returnServer` is the client's
	// server address recorded from the login page (callback deep link回跳用);
	// `clientIP` 是发起流程的来源 IP(按信任边界解析),供实现在途流程配额用
	// (审计 2026-09-23 R5-A-18)。实现可忽略任一参数,接口统一签名。
	AuthURL(state, returnServer, clientIP string) (string, error)
	HandleCallback(code, state string) (UserInfo, error)
	Configure(cfg map[string]string) error
}
