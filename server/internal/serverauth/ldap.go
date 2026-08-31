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
// user_attr(用户名属性,默认 uid;cn/sAMAccountName/mail 等),group_filter,
// group_attr. Filters are templates where %s is replaced with the escaped
// username (user_filter) or escaped user DN (group_filter).
type LDAPProvider struct {
	ServerURL    string
	BindDN       string
	BindPassword string
	BaseDN       string
	UserFilter   string
	// UserAttr 是目录中"登录用户名"的属性名(如 uid/cn/sAMAccountName)。
	// 各厂商目录命名不同:OpenLDAP 常用 uid,AD 常用 sAMAccountName,
	// 部分企业目录只有 cn/mail(如 mokahr 系)。默认 uid,管理员可配置。
	// 生效范围:登录用户规范化、目录同步、测试连接的 username 字段。
	UserAttr    string
	GroupFilter string
	GroupAttr   string

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
	p.UserAttr = cfg["user_attr"]
	if p.UserAttr == "" {
		p.UserAttr = "uid"
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

// ldapDisplayName 取条目的显示名:sn(真实姓名,如 "zhangsan")→ cn 兜底——
// 部分目录 cn 是登录名(如 mokahr 系 "alice"),显示名应取 sn。
func ldapDisplayName(e *ldap.Entry) string {
	if v := e.GetAttributeValue("sn"); v != "" {
		return strings.TrimSpace(v)
	}
	return strings.TrimSpace(e.GetAttributeValue("cn"))
}

// uniqAttrs 去重属性列表(如 UserAttr 与 GroupAttr 同名时),保持顺序。
func uniqAttrs(attrs []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(attrs))
	for _, a := range attrs {
		if a == "" || seen[a] {
			continue
		}
		seen[a] = true
		out = append(out, a)
	}
	return out
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
	users, err := p.scanEntries(conn, p.userScanFilter(), uniqAttrs([]string{p.UserAttr, "cn", "sn", "mail", p.GroupAttr}))
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
			Username:    p.usernameOf(e),
			DisplayName: ldapDisplayName(e),
			Email:       e.GetAttributeValue("mail"),
			Groups:      gres,
		})
	}
	return report, nil
}

// usernameOf 取条目的规范用户名(同步/探测/登录共用):
// 1. 配置的 user_attr(默认 uid;支持 cn/sAMAccountName/mail 等);
// 2. 缺失时回退 cn → mail(兼容只有 cn/mail 的目录);
// 3. 再回退 DN 首个 RDN 值。
// 此前仅取 uid,无 uid 目录同步全部跳过(用户报告"配置 LDAP 后用户没同步")。
func (p *LDAPProvider) usernameOf(e *ldap.Entry) string {
	attr := p.UserAttr
	if attr == "" {
		attr = "uid"
	}
	if v := e.GetAttributeValue(attr); v != "" {
		return strings.TrimSpace(v)
	}
	for _, a := range []string{"cn", "mail"} {
		if v := e.GetAttributeValue(a); v != "" {
			return strings.TrimSpace(v)
		}
	}
	if dn := e.DN; dn != "" {
		if i := strings.Index(dn, "="); i > 0 {
			if j := strings.Index(dn[i:], ","); j > 0 {
				return strings.TrimSpace(dn[i+1 : i+j])
			}
			return strings.TrimSpace(dn[i+1:])
		}
	}
	return ""
}

// entryUserName 保留的自由函数(测试/兼容):默认属性链 uid → cn → mail → DN RDN。
func entryUserName(e *ldap.Entry, dst string) string {
	p := &LDAPProvider{UserAttr: "uid"}
	if v := p.usernameOf(e); v != "" {
		return v
	}
	return dst
}

// loginUsername 规范登录用户名(登录时):只取配置的 user_attr 属性
// (默认 uid;可配 cn/sAMAccountName 等)的值——大小写规范化,防
// "Alice"/"alice" 分裂。配置属性缺失时回退用户输入(过滤器已按输入匹配,
// 此时绝不能改用 cn 的值,否则用户输入 "alice" 会落成 "Alice")。
func (p *LDAPProvider) loginUsername(e *ldap.Entry, dst string) string {
	attr := p.UserAttr
	if attr == "" {
		attr = "uid"
	}
	if v := e.GetAttributeValue(attr); v != "" {
		return strings.TrimSpace(v)
	}
	return strings.TrimSpace(dst)
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
		Attributes: []string{p.UserAttr, "cn", "sn", "mail"},
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
	// 用户名取目录 user_attr(默认 uid;可配 cn/sAMAccountName 等),缺失回退
	// 用户输入——统一走 p.loginUsername(与 sync/探测同一规范化规则)。
	canonical := p.loginUsername(entry, username)
	ui := UserInfo{
		Username:    canonical,
		DisplayName: ldapDisplayName(entry),
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
