package serverauth

import (
	"errors"
	"net"
	"strings"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// ldapTimeout bounds every LDAP connection (C-7): connect, bind and search.
// A hung directory server must never hold a login goroutine forever.
const ldapTimeoutDefault = 5 * time.Second

// ldapTimeout is test-injectable.
var ldapTimeout = ldapTimeoutDefault

// ldapConn is the subset of *ldap.Conn used by LDAPProvider; it exists so
// tests can substitute an in-memory fake.
type ldapConn interface {
	Bind(dn, password string) error
	Search(req *ldap.SearchRequest) (*ldap.SearchResult, error)
	Close() error
}

// LDAPProvider authenticates against an LDAP directory.
// Config keys: server_url, bind_dn, bind_password, base_dn, user_filter,
// group_filter, group_attr. Filters are templates where %s is replaced with
// the escaped username (user_filter) or escaped user DN (group_filter).
type LDAPProvider struct {
	ServerURL    string
	BindDN       string
	BindPassword string
	BaseDN       string
	UserFilter   string
	GroupFilter  string
	GroupAttr    string

	dial func(url string) (ldapConn, error)
}

func (p *LDAPProvider) Name() string { return "ldap" }

func (p *LDAPProvider) Configure(cfg map[string]string) error {
	p.ServerURL = cfg["server_url"]
	p.BindDN = cfg["bind_dn"]
	p.BindPassword = cfg["bind_password"]
	p.BaseDN = cfg["base_dn"]
	p.UserFilter = cfg["user_filter"]
	if p.UserFilter == "" {
		p.UserFilter = "(uid=%s)"
	}
	p.GroupFilter = cfg["group_filter"]
	p.GroupAttr = cfg["group_attr"]
	if p.GroupAttr == "" {
		p.GroupAttr = "cn"
	}
	if p.ServerURL == "" || p.BaseDN == "" {
		return errors.New("ldap: server_url and base_dn are required")
	}
	return nil
}

func (p *LDAPProvider) dialConn() (ldapConn, error) {
	if p.dial != nil {
		return p.dial(p.ServerURL)
	}
	conn, err := ldap.DialURL(p.ServerURL, ldap.DialWithDialer(&net.Dialer{Timeout: ldapTimeout}))
	if err != nil {
		return nil, err
	}
	// read/write deadline so a silent server cannot block bind/search forever
	conn.SetTimeout(ldapTimeout)
	return conn, nil
}

// Authenticate verifies the password via a user bind and resolves groups:
// bind (service account or anonymous) -> search user (escaped username) ->
// user bind -> group search.
func (p *LDAPProvider) Authenticate(username, password string) (UserInfo, error) {
	if username == "" || password == "" {
		return UserInfo{}, errors.New("invalid credentials")
	}
	conn, err := p.dialConn()
	if err != nil {
		return UserInfo{}, err
	}
	defer conn.Close()
	if err := conn.Bind(p.BindDN, p.BindPassword); err != nil {
		return UserInfo{}, errors.New("ldap bind failed")
	}
	res, err := conn.Search(&ldap.SearchRequest{
		BaseDN:     p.BaseDN,
		Scope:      ldap.ScopeWholeSubtree,
		Filter:     strings.ReplaceAll(p.UserFilter, "%s", ldap.EscapeFilter(username)),
		Attributes: []string{"uid", "cn", "mail"},
	})
	if err != nil {
		return UserInfo{}, err
	}
	if len(res.Entries) != 1 {
		return UserInfo{}, errors.New("user not found")
	}
	entry := res.Entries[0]
	if err := conn.Bind(entry.DN, password); err != nil {
		return UserInfo{}, errors.New("invalid credentials")
	}
	// 用户名取目录条目的 uid 属性(规范化大小写):LDAP 绑定大小写不敏感,
	// 用户手输 "Alice"/"alice" 必须落到同一本地账号,否则授权/token 分裂
	canonical := entry.GetAttributeValue("uid")
	if canonical == "" {
		canonical = username
	}
	ui := UserInfo{
		Username:    canonical,
		DisplayName: entry.GetAttributeValue("cn"),
		Email:       entry.GetAttributeValue("mail"),
		Source:      "external",
	}
	if p.GroupFilter != "" {
		gres, err := conn.Search(&ldap.SearchRequest{
			BaseDN:     p.BaseDN,
			Scope:      ldap.ScopeWholeSubtree,
			Filter:     strings.ReplaceAll(p.GroupFilter, "%s", ldap.EscapeFilter(entry.DN)),
			Attributes: []string{p.GroupAttr},
		})
		if err != nil {
			return UserInfo{}, err
		}
		for _, e := range gres.Entries {
			if name := e.GetAttributeValue(p.GroupAttr); name != "" {
				ui.Groups = append(ui.Groups, name)
			}
		}
	}
	return ui, nil
}
