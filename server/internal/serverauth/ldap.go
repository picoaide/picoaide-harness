package serverauth

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/go-ldap/ldap/v3"

	"github.com/picoaide/picoaide/internal/util"
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
	// 部分企业目录只有 cn/mail(如 某些企业目录)。默认 uid,管理员可配置。
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
	p.BindPassword = decryptSettingSecret(cfg["bind_password"])
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
	// P2-7(审计 2026-09-13):LDAP 出站同样做连接期 IP 复检(与网关上游/
	// OIDC/余额查询同一护栏):目录地址由管理员配置且运行期可能被 DNS
	// rebinding 指向链路本地/云 metadata。私网照旧放行(企业目录常在 10.x)。
	u, err := url.Parse(p.ServerURL)
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("ldap: invalid server_url")
	}
	ctx, cancel := context.WithTimeout(context.Background(), ldapTimeout)
	defer cancel()
	if err := util.CheckOutboundTarget(ctx, u.Hostname()); err != nil {
		return nil, err
	}
	conn, err := ldap.DialURL(p.ServerURL, ldap.DialWithDialer(ldapDialer()))
	if err != nil {
		return nil, err
	}
	// read/write deadline so a silent server cannot block bind/search forever
	conn.SetTimeout(ldapTimeout)
	return conn, nil
}

// ldapDialControl 是 LDAP 出站的**连接期**复检:它拿到的是拨号器**真正要连**的
// 地址,因此不存在"先解析一次做检查、再解析一次去连接"的 check-then-dial 窗口
// (2026-09-17 独立审计:此前只有 CheckOutboundTarget 的主机解析结果做检查,
// ldap.DialURL 内部会再解析一次,DNS rebinding 可在两次解析之间换掉答案)。
//
// 只拦链路本地/云 metadata(util.IsBlockedOutboundIP);私网照旧放行 ——
// 企业目录常在 10.x/172.16.x,不能一刀切禁私网。
func ldapDialControl(_, address string, _ syscall.RawConn) error {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		// 形状异常时交回默认语义(不静默放行"任意目标"—— 这里只是拿不到 IP)。
		return nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return nil
	}
	if util.IsBlockedOutboundIP(ip) {
		return fmt.Errorf("ldap: refused to connect to link-local/metadata address %s", ip)
	}
	return nil
}

// ldapDialer 是 LDAP 连接用的 dialer(超时 + 连接期复检)。测试注入点见 ldapDialerFn。
func ldapDialer() *net.Dialer {
	return &net.Dialer{Timeout: ldapTimeout, Control: ldapDialControl}
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
// 部分目录 cn 是登录名(如 "alice"),显示名应取 sn。
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
		// P2-9:DN 是目录内的稳定主体标识(用户名可能被改名/复用)。
		ExternalID:     entry.DN,
		ExternalSource: "ldap",
		// 目录是组的权威源:即使这次没查到任何组也要回收(空组即回收),
		// 所以这里恒为 true。
		GroupsPresent: true,
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

// redactCredential 把**已知凭据**从待落日志的文本里擦掉,并转义控制字符。
//
// 为什么不能只做一次精确子串替换(2026-09-17 独立审计 N1):
//   - 错误文本来自对端(不可信):目录服务在 bind 请求里就拿到了明文口令,
//     可以任意变形回显 —— 实测大小写、base64、URL 编码都是现成的绕过;
//   - 所以这里擦**常见编码形态**(原样/小写/大写/base64/URL 编码),并承认
//     "部分回显/插入分隔符"这类变形仍可能漏(残余风险,已在发布说明认账);
//   - 另外对端可在文本里塞 CR/LF 伪造整行日志(CWE-117),所以控制字符一律
//     转成可见转义,保证一条错误只占一行。
func redactCredential(text, secret string) string {
	out := text
	if secret != "" {
		variants := []string{
			secret,
			strings.ToLower(secret),
			strings.ToUpper(secret),
			base64.StdEncoding.EncodeToString([]byte(secret)),
			url.QueryEscape(secret),
		}
		for _, v := range variants {
			if v == "" {
				continue
			}
			out = strings.ReplaceAll(out, v, "***")
		}
	}
	// 转义与截断都走 `internal/util` 的**同一份**实现（sanitizeLogLine 是
	// util.EscapeControl 的薄包装，与 wasmapp/logbuf 的 sanitizeLogField 同款）：
	//   - **先转义、再按转义边界截断** ⇒ 既不会切出半个多字节字符（中文错误消息
	//     很常见），也不会留下 `\x8`/`\u202` 这类**半截转义序列** —— 半截序列会被
	//     任何做一次反转义的消费端当成续行符，从而吞掉紧随其后的那一行宿主日志
	//     （2026-09-21 审计 A-P2-2；log.Printf 也会把非法字节原样写盘）；
	//   - 被截断时补一个省略号，"文本被截过"这件事对排障者可见。
	// 注意这里必须用**未转义**的 out 再做一次有界转义，不能对已转义文本再转一次。
	const maxLogText = 300
	escaped := sanitizeLogLine(out)
	if len(escaped) > maxLogText {
		return util.EscapeControlLimit(out, maxLogText) + "…"
	}
	return escaped
}

// sanitizeLogLine 把 CR/LF/Tab、控制字符与**双向/零宽格式字符**转成可见转义
// (CWE-117:对端文本不能伪造日志行)。
//
// 实现唯一在 `internal/util` 的 EscapeControl（本函数只是薄包装，与 wasmapp/logbuf
// 的 sanitizeLogField 同款写法，2026-09-21 审计 A-P2-1）—— 本地再留一份策略，
// "哪些字符算控制字符"必然在模块间漂移。
//
// 为什么连格式字符也要转(2026-09-17 独立验证 P3):U+202E(U+202A-U+202E)、
// U+2066-U+2069、U+200B-U+200F 这类字符不产生换行,但会**改变显示顺序**
// (实测 "ok\u202egnp.exe\u202c end" 在编辑器里读成 "ok exe.png end")——
// 管理员看日志会被误导;U+2028/U+2029 在部分查看器里还是换行。
//
// 相比换过来之前的本地实现，本包装**更严一档**：旧版逐码点判 `r < 0x20 || r == 0x7f`，
// 不覆盖 C1 段 U+0080–U+009F（U+0085 NEL 就在其中，部分查看器与 JS 把它当换行）；
// util 侧按 `unicode.Cc` 判定，覆盖整个 C1 段。方向是"更严"，不是放宽。
func sanitizeLogLine(text string) string { return util.EscapeControl(text) }
