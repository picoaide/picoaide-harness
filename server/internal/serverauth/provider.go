package serverauth

// UserInfo is the normalized identity returned by providers.
type UserInfo struct {
	Username    string
	DisplayName string
	Email       string
	Groups      []string
	// Source identifies the identity source: "local" for the local users
	// table, "external" for ldap/oidc. provisionUser refuses to let an
	// external identity adopt a local account row.
	Source string
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
	AuthURL(state string) (string, error)
	HandleCallback(code, state string) (UserInfo, error)
	Configure(cfg map[string]string) error
}
