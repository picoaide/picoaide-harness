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
// tests can substitute an in-memory fake. SearchWithPaging backs the
// directory-wide sync/probe (large directories exceed a server's default
// size limit; go-ldap handles the paging control transparently).
type ldapConn interface {
	Bind(dn, password string) error
	Search(req *ldap.SearchRequest) (*ldap.SearchResult, error)
	SearchWithPaging(req *ldap.SearchRequest, size uint32) (*ldap.SearchResult, error)
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

// ldapSearchPagingSize bounds each LDAP page during full-directory scans
// (sync/probe). Small pages keep memory flat and avoid server-side
// size-limit rejections on very large directories.
const ldapSearchPagingSize = 200

// DirectoryUser is one directory entry captured by a full-directory scan.
type DirectoryUser struct {
	Username    string   `json:"username"`
	DisplayName string   `json:"display_name"`
	Email       string   `json:"email"`
	Groups      []string `json:"groups"`
}

// DirectoryReport summarizes a full-directory scan (webadmin 测试连接).
type DirectoryReport struct {
	Users  int             `json:"users"`
	Groups int             `json:"groups"`
	Sample []DirectoryUser `json:"sample"`
}

// scanEntries runs a paged full-subtree search on an already-bound conn.
func (p *LDAPProvider) scanEntries(conn ldapConn, filter string, attrs []string) ([]*ldap.Entry, error) {
	req := &ldap.SearchRequest{
		BaseDN:     p.BaseDN,
		Scope:      ldap.ScopeWholeSubtree,
		Filter:     filter,
		Attributes: attrs,
	}
	res, err := conn.SearchWithPaging(req, ldapSearchPagingSize)
	if err != nil {
		return nil, err
	}
	return res.Entries, nil
}

// userScanFilter 把用户过滤器里的 %s 占位替换为 *:登录时 %s=用户名,全量
// 扫描时没有单用户概念,应匹配"所有满足该结构过滤器的条目"。管理员若无
// 占位(如 (objectClass=person)),原样使用。* 由过滤器结构保证不在
// 参数位置(过滤器整体是管理员配置,占位符位置才是值),无需转义。
func (p *LDAPProvider) userScanFilter() string {
	if strings.Contains(p.UserFilter, "%s") {
		return strings.ReplaceAll(p.UserFilter, "%s", "*")
	}
	return p.UserFilter
}

// groupScanFilter 把组过滤器里的 %s(成员占位,如 (member=%s))替换为 *:
// (member=*) 是合法存在性断言,匹配所有含 member 属性的条目(即组对象)。
func (p *LDAPProvider) groupScanFilter() string {
	if strings.Contains(p.GroupFilter, "%s") {
		return strings.ReplaceAll(p.GroupFilter, "%s", "*")
	}
	return p.GroupFilter
}

// ProbeDirectory 绑定服务账号后统计目录规模:用户数、组数与用户样例(前 5,
// 含每个样例用户的组)。用于 webadmin「测试连接」,让管理员在保存前就能
// 看到 LDAP 连通 + 过滤器匹配结果。单个连接完成,避免每样例用户重复 bind。
func (p *LDAPProvider) ProbeDirectory() (*DirectoryReport, error) {
	conn, err := p.dialConn()
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	if err := conn.Bind(p.BindDN, p.BindPassword); err != nil {
		return nil, errors.New("ldap bind failed")
	}
	users, err := p.scanEntries(conn, p.userScanFilter(), []string{"uid", "cn", "mail", p.GroupAttr})
	if err != nil {
		return nil, err
	}
	report := &DirectoryReport{Users: len(users)}
	if p.GroupFilter != "" {
		groups, gerr := p.scanEntries(conn, p.groupScanFilter(), []string{p.GroupAttr})
		if gerr != nil {
			return nil, gerr
		}
		report.Groups = len(groups)
	}
	for i, e := range users {
		if i >= 5 {
			break
		}
		gres, gerr := p.groupsOfEntry(conn, e.DN)
		if gerr != nil {
			gres = nil // 组解析失败不影响整体报告(样例组显示为无)
		}
		report.Sample = append(report.Sample, DirectoryUser{
			Username:    entryUserName(e, ""),
			DisplayName: e.GetAttributeValue("cn"),
			Email:       e.GetAttributeValue("mail"),
			Groups:      gres,
		})
	}
	return report, nil
}

// entryUserName 取条目的 uid 属性作为规范用户名(与 Authenticate 同一规则),
// 缺失时回退 dst。
func entryUserName(e *ldap.Entry, dst string) string {
	if name := e.GetAttributeValue("uid"); name != "" {
		return name
	}
	return dst
}

// groupsOfEntry 查询某用户/条目的全部组(复用 group_filter 单用户语义)。
func (p *LDAPProvider) groupsOfEntry(conn ldapConn, dn string) ([]string, error) {
	if p.GroupFilter == "" {
		return nil, nil
	}
	res, err := conn.Search(&ldap.SearchRequest{
		BaseDN:     p.BaseDN,
		Scope:      ldap.ScopeWholeSubtree,
		Filter:     strings.ReplaceAll(p.GroupFilter, "%s", ldap.EscapeFilter(dn)),
		Attributes: []string{p.GroupAttr},
	})
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range res.Entries {
		if name := e.GetAttributeValue(p.GroupAttr); name != "" {
			out = append(out, name)
		}
	}
	return out, nil
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
		groups, err := p.groupsOfEntry(conn, entry.DN)
		if err != nil {
			return UserInfo{}, err
		}
		ui.Groups = groups
	}
	return ui, nil
}
