package serverauth

import (
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/go-ldap/ldap/v3"
)

// fakeLDAPConn is an in-memory stand-in for *ldap.Conn exercising the
// ldapConn seam: bind, search (user vs group), paging, close.
type fakeLDAPConn struct {
	userDN       string
	userPassword string
	userAttrs    map[string][]string
	groupEntries []*ldap.Entry
	passwords    map[string]string
	filters      []string
	binds        []string
	paged        bool
	// searchResults: filter → 精确返回值(优先命中;否则回退旧单用户行为)。
	searchResults map[string]*ldap.SearchResult
}

func (f *fakeLDAPConn) Bind(dn, password string) error {
	f.binds = append(f.binds, dn)
	if dn == "" {
		return nil
	}
	if want, ok := f.passwords[dn]; ok {
		if want != password {
			return errors.New("invalid credentials")
		}
		return nil
	}
	return errors.New("bind not permitted")
}

func (f *fakeLDAPConn) Search(req *ldap.SearchRequest) (*ldap.SearchResult, error) {
	f.filters = append(f.filters, req.Filter)
	// 精确命中 map(目录扫描/组枚举测试用)
	if f.searchResults != nil {
		if r, ok := f.searchResults[req.Filter]; ok {
			return r, nil
		}
	}
	if strings.HasPrefix(req.Filter, "(uid=") {
		if f.userDN == "" {
			return &ldap.SearchResult{}, nil
		}
		return &ldap.SearchResult{Entries: []*ldap.Entry{{
			DN:         f.userDN,
			Attributes: attrsOf(f.userAttrs),
		}}}, nil
	}
	return &ldap.SearchResult{Entries: f.groupEntries}, nil
}

// SearchWithPaging 与 Search 同语义(fake 不分页):委托给 Search,
// 并记录调用了 paging 接口(目录扫描路径必须走分页)。
func (f *fakeLDAPConn) SearchWithPaging(req *ldap.SearchRequest, _ uint32) (*ldap.SearchResult, error) {
	f.paged = true
	return f.Search(req)
}

func (f *fakeLDAPConn) Close() error { return nil }

func attrsOf(m map[string][]string) []*ldap.EntryAttribute {
	out := make([]*ldap.EntryAttribute, 0, len(m))
	for k, v := range m {
		out = append(out, &ldap.EntryAttribute{Name: k, Values: v})
	}
	return out
}

const testUserDN = "uid=alice,ou=people,dc=example"

func newLDAPProvider(t *testing.T, f *fakeLDAPConn, extra map[string]string) *LDAPProvider {
	t.Helper()
	cfg := map[string]string{
		"server_url":    "ldap://fake",
		"bind_dn":       "cn=svc,ou=system,dc=example",
		"bind_password": "svcpass",
		"base_dn":       "ou=people,dc=example",
		"user_filter":   "(uid=%s)",
		"group_filter":  "(member=%s)",
		"group_attr":    "cn",
	}
	for k, v := range extra {
		cfg[k] = v
	}
	p := &LDAPProvider{}
	if err := p.Configure(cfg); err != nil {
		t.Fatal(err)
	}
	p.dial = func(string) (ldapConn, error) { return f, nil }
	return p
}

func defaultFake() *fakeLDAPConn {
	return &fakeLDAPConn{
		userDN:       testUserDN,
		userPassword: "pw",
		userAttrs: map[string][]string{
			"cn":   {"Alice"},
			"mail": {"alice@example.com"},
		},
		groupEntries: []*ldap.Entry{
			{DN: "cn=admins,ou=groups,dc=example", Attributes: []*ldap.EntryAttribute{{Name: "cn", Values: []string{"admins"}}}},
			{DN: "cn=devs,ou=groups,dc=example", Attributes: []*ldap.EntryAttribute{{Name: "cn", Values: []string{"devs"}}}},
		},
		passwords: map[string]string{
			"cn=svc,ou=system,dc=example": "svcpass",
			testUserDN:                    "pw",
		},
	}
}

func TestLDAPConfigure(t *testing.T) {
	p := &LDAPProvider{}
	if err := p.Configure(map[string]string{}); err == nil {
		t.Fatal("expected error with missing config")
	}
	if err := p.Configure(map[string]string{"server_url": "ldap://x", "base_dn": "dc=x"}); err != nil {
		t.Fatalf("configure with required keys: %v", err)
	}
	if p.UserFilter != "(uid=%s)" || p.GroupAttr != "cn" {
		t.Fatalf("defaults not applied: %+v", p)
	}
}

func TestLDAPAuthenticateSuccess(t *testing.T) {
	f := defaultFake()
	p := newLDAPProvider(t, f, nil)

	ui, err := p.Authenticate("alice", "pw")
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if ui.Username != "alice" || ui.DisplayName != "Alice" || ui.Email != "alice@example.com" {
		t.Fatalf("ui = %+v", ui)
	}
	if len(ui.Groups) != 2 || ui.Groups[0] != "admins" || ui.Groups[1] != "devs" {
		t.Fatalf("groups = %v", ui.Groups)
	}
	// flow: svc bind -> user search -> user bind -> group search
	if len(f.binds) != 2 || f.binds[0] != "cn=svc,ou=system,dc=example" || f.binds[1] != testUserDN {
		t.Fatalf("binds = %v", f.binds)
	}
	if len(f.filters) != 2 || f.filters[0] != "(uid=alice)" {
		t.Fatalf("filters = %v", f.filters)
	}
	if f.filters[1] != "(member="+ldap.EscapeFilter(testUserDN)+")" {
		t.Fatalf("group filter = %q", f.filters[1])
	}
}

func TestLDAPAuthenticateWrongPassword(t *testing.T) {
	f := defaultFake()
	p := newLDAPProvider(t, f, nil)
	if _, err := p.Authenticate("alice", "wrong"); err == nil {
		t.Fatal("expected auth error on wrong password")
	}
}

func TestLDAPAuthenticateServiceBindFailure(t *testing.T) {
	f := defaultFake()
	delete(f.passwords, "cn=svc,ou=system,dc=example")
	p := newLDAPProvider(t, f, nil)
	if _, err := p.Authenticate("alice", "pw"); err == nil {
		t.Fatal("expected error on service bind failure")
	}
}

func TestLDAPAuthenticateAnonymousBind(t *testing.T) {
	f := defaultFake()
	p := newLDAPProvider(t, f, map[string]string{"bind_dn": "", "bind_password": ""})
	if _, err := p.Authenticate("alice", "pw"); err != nil {
		t.Fatalf("anonymous bind auth: %v", err)
	}
}

func TestLDAPAuthenticateEmptyPassword(t *testing.T) {
	f := defaultFake()
	p := newLDAPProvider(t, f, nil)
	if _, err := p.Authenticate("alice", ""); err == nil {
		t.Fatal("expected error on empty password")
	}
	if len(f.binds) != 0 {
		t.Fatalf("no bind should occur: %v", f.binds)
	}
}

func TestLDAPUsernameEscaped(t *testing.T) {
	f := defaultFake()
	f.userDN = "uid=u1,ou=people,dc=example"
	f.passwords["uid=u1,ou=people,dc=example"] = "pw"
	p := newLDAPProvider(t, f, nil)

	username := `al*ce)(|&`
	if _, err := p.Authenticate(username, "pw"); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	want := "(uid=" + ldap.EscapeFilter(username) + ")"
	if f.filters[0] != want {
		t.Fatalf("user filter = %q, want %q", f.filters[0], want)
	}
	if strings.Contains(f.filters[0], "al*ce") {
		t.Fatal("username leaked into filter unescaped")
	}
}

func TestLDAPUserNotFound(t *testing.T) {
	f := defaultFake()
	f.userDN = ""
	p := newLDAPProvider(t, f, nil)
	if _, err := p.Authenticate("nobody", "pw"); err == nil {
		t.Fatal("expected error when user not found")
	}
}

func TestLDAPNoGroupFilter(t *testing.T) {
	f := defaultFake()
	p := newLDAPProvider(t, f, map[string]string{"group_filter": ""})
	ui, err := p.Authenticate("alice", "pw")
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if len(ui.Groups) != 0 {
		t.Fatalf("groups = %v, want none", ui.Groups)
	}
	if len(f.filters) != 1 {
		t.Fatalf("only user search expected, got %v", f.filters)
	}
}

// C-7: a hung LDAP server must not block login forever; dialConn applies a
// bounded timeout to both connect and read phases.
func TestLDAPDialTimeoutApplies(t *testing.T) {
	prev := ldapTimeout
	ldapTimeout = 200 * time.Millisecond
	defer func() { ldapTimeout = prev }()

	// listener that accepts connections but never answers the LDAP bind
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) { time.Sleep(2 * time.Second); c.Close() }(c)
		}
	}()

	p := &LDAPProvider{ServerURL: "ldap://" + ln.Addr().String()}
	start := time.Now()
	if _, err := p.Authenticate("alice", "pw"); err == nil {
		t.Fatal("expected error from timed-out LDAP connection")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("auth took %v, want ~%v timeout", d, ldapTimeout)
	}
}

// TestLDAPDialControlBlocksMetadata(2026-09-17 审计,LDAP check-then-dial):
// 连接期复检必须作用在**真正要拨的 IP** 上 —— 只检查 CheckOutboundTarget 的
// 主机解析结果会留下 rebinding 窗口(两次解析之间换掉答案)。
func TestLDAPDialControlBlocksMetadata(t *testing.T) {
	cases := []struct {
		name    string
		address string
		wantErr bool
	}{
		{"云 metadata", "169.254.169.254:389", true},
		{"阿里云 metadata", "100.100.100.200:389", true},
		{"IPv6 链路本地", "[fe80::1]:389", true},
		{"企业私网目录(放行)", "10.1.2.3:389", false},
		{"公网目录(放行)", "203.0.113.7:636", false},
		{"形状异常不误伤", "not-a-host-port", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ldapDialControl("tcp", tc.address, nil)
			if tc.wantErr && err == nil {
				t.Fatalf("ldapDialControl(%q) = nil, want refusal", tc.address)
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("ldapDialControl(%q) = %v, want nil (私网/公网必须放行)", tc.address, err)
			}
		})
	}
}

// TestRedactCredentialStripsBindPassword:对端可以把 bind 口令原样回显在错误文本里,
// 落日志前必须擦掉(空口令不动,避免把空串替换成噪声)。
func TestRedactCredentialStripsBindPassword(t *testing.T) {
	const pw = "S3cr3t-Bind-Pw"
	got := redactCredential("ldap: invalid credentials (bind pw="+pw+")", pw)
	if strings.Contains(got, pw) {
		t.Fatalf("password leaked into log text: %q", got)
	}
	if !strings.Contains(got, "***") {
		t.Fatalf("password must be replaced, got %q", got)
	}
	if plain := "no secret here"; redactCredential(plain, "") != plain {
		t.Fatalf("empty password must leave the text untouched")
	}
}
