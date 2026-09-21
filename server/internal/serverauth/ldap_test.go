package serverauth

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode"
	"unicode/utf8"

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

// TestRedactCredentialStripsBindPassword:对端可以任意变形回显 bind 口令
// (2026-09-17 审计 N1 实测:大小写/base64/URL 编码都是现成绕过),落日志前
// 必须把常见编码形态也擦掉;空口令不动,避免把空串替换成噪声。
func TestRedactCredentialStripsBindPassword(t *testing.T) {
	const pw = "S3cr3t-Bind-Pw"
	variants := map[string]string{
		"原样":     pw,
		"小写":     strings.ToLower(pw),
		"大写":     strings.ToUpper(pw),
		"base64": base64.StdEncoding.EncodeToString([]byte(pw)),
		"URL编码":  url.QueryEscape(pw),
	}
	for name, v := range variants {
		got := redactCredential("ldap: bind failed (echo="+v+")", pw)
		if strings.Contains(got, v) {
			t.Fatalf("%s 形态未被擦除: %q", name, got)
		}
		if !strings.Contains(got, "***") {
			t.Fatalf("%s 形态必须被替换, got %q", name, got)
		}
	}
	if plain := "no secret here"; redactCredential(plain, "") != plain {
		t.Fatalf("空口令必须原样返回")
	}
}

// TestRedactCredentialEscapesControlChars(CWE-117):对端在错误文本里塞 CR/LF
// 可以伪造整行日志;落盘前必须转义成可见形式。同时超长文本要截断。
func TestRedactCredentialEscapesControlChars(t *testing.T) {
	got := redactCredential("oops\n2026/09/17 audit: username=root action=login_success\r\tx", "")
	if strings.ContainsAny(got, "\n\r\t") {
		t.Fatalf("控制字符未被转义(可伪造日志行): %q", got)
	}
	if !strings.Contains(got, `\n`) || !strings.Contains(got, `\r`) {
		t.Fatalf("应转义成可见 \\n/\\r, got %q", got)
	}
	long := redactCredential(strings.Repeat("A", 1000), "")
	if len(long) > 320 {
		t.Fatalf("超长文本必须截断, got %d 字节", len(long))
	}
}

// TestRedactCredentialEscapesBidiAndKeepsUTF8Valid(2026-09-17 独立验证 P3/P4):
//   - 双向/零宽格式字符(U+202A-U+202E、U+2066-U+2069、U+200B-U+200F)不产生换行,
//     但会改变日志的**显示顺序** —— 对端可借此把 "gnp.exe" 读成 "exe.png";
//   - 截断在转义之后按字节切,会切出半个多字节字符,而 log.Printf 把非法 UTF-8
//     原样写盘(不净化成 U+FFFD),下游日志采集看到乱码。
func TestRedactCredentialEscapesBidiAndKeepsUTF8Valid(t *testing.T) {
	got := redactCredential("ok\u202egnp.exe\u202c end", "")
	for _, r := range got {
		if unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			t.Fatalf("格式字符未转义(显示顺序可被对端改动): %q", got)
		}
	}
	if !strings.Contains(got, `\u202e`) {
		t.Fatalf("应转义成可见 \\u202e, got %q", got)
	}

	// 截断必须落在 rune 边界。多种形状一起钉:纯 3 字节汉字、带 1 字节前缀(300
	// 不是 3 的倍数偏移 ⇒ 按字节切必切出半个字)、4 字节 emoji 及其前缀形态。
	for _, in := range []string{
		strings.Repeat("啊", 1000),
		"x" + strings.Repeat("啊", 1000),
		"日志: " + strings.Repeat("错误", 400),
		strings.Repeat("😀", 300),
		"a" + strings.Repeat("😀", 300),
	} {
		got := redactCredential(in, "")
		if len(got) > 320 {
			t.Fatalf("超长文本必须截断, got %d 字节", len(got))
		}
		if !utf8.ValidString(got) {
			t.Fatalf("截断切出了非法 UTF-8(输入 %d 字节): %q", len(in), got)
		}
	}
	// 转义会变长,再叠一层:转义后的中文串也要保持合法。
	mixed := redactCredential(strings.Repeat("啊\\x01", 200), "")
	if !utf8.ValidString(mixed) {
		t.Fatalf("转义+截断后不是合法 UTF-8: %q", mixed)
	}
}

// TestRedactCredentialEscapesAllC1AndFormatChars 是"ldap 与 logbuf 共用同一份转义
// 策略"的判据（2026-09-21 审计 A-P2-1 收口）：
//
// 旧本地实现 `sanitizeLogLine` 逐码点判 `r < 0x20 || r == 0x7f`，**不含 C1 段
// U+0080–U+009F**（`unicode.Cf` 也不覆盖 C1），而 U+0085 NEL 就落在 C1 里 ——
// 部分查看器与 JS 把它当换行。换成薄包装（唯一实现在 `util.EscapeControl`）之后，
// 经 ldap 脱敏路径输出的文本里不得残留任何 C1 / Cf / Zl / Zp 码点，且换行数为 0。
//
// 变异验证：把 ldap 侧改回旧实现（或让 sanitizeLogLine 原样返回）⇒ 本用例即红。
func TestRedactCredentialEscapesAllC1AndFormatChars(t *testing.T) {
	var payload strings.Builder
	payload.WriteString("ldap: bind failed (secret=hunter2) echo=")
	for r := rune(0x80); r <= 0x9f; r++ { // 整个 C1 段，逐个码点
		payload.WriteRune(r)
	}
	// Cf / Zl / Zp 代表 + 惯用转义。
	for _, r := range []rune{'\u2028', '\u2029', '\u200b', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\ufeff', '\n', '\r', '\t'} {
		payload.WriteRune(r)
	}
	payload.WriteString(" end")

	got := redactCredential(payload.String(), "hunter2")
	if n := strings.Count(got, "\n"); n != 0 {
		t.Fatalf("脱敏后的文本含 %d 个真换行（可凭空伪造一行日志）：%q", n, got)
	}
	for _, r := range got {
		if r >= 0x80 && r <= 0x9f {
			t.Fatalf("残留裸 C1 码点 %U（C1 里含 NEL U+0085 —— 部分查看器当换行）：%q", r, got)
		}
		if unicode.In(r, unicode.Cf, unicode.Zl, unicode.Zp) {
			t.Fatalf("残留裸格式/分隔字符 %U（可重排显示顺序或当换行）：%q", r, got)
		}
	}
	// 逐个点名：C1 段的每一个码点都必须是可见转义（`\xNN`），不是被删掉。
	for r := rune(0x80); r <= 0x9f; r++ {
		want := fmt.Sprintf(`\x%02x`, r)
		if !strings.Contains(got, want) {
			t.Fatalf("C1 码点 %U 应转义成 %q（转义而不是删除）：%q", r, want, got)
		}
	}
	for _, want := range []string{`\u2028`, `\u2029`, `\u202e`, `\u2066`, `\ufeff`, `\n`, `\r`, `\t`} {
		if !strings.Contains(got, want) {
			t.Fatalf("应出现可见转义序列 %q：%q", want, got)
		}
	}
	// 凭据擦除必须照常工作（转义是后加的一层，不能把替换挤掉）。
	if strings.Contains(got, "hunter2") {
		t.Fatalf("凭据未被擦除：%q", got)
	}
}

// TestRedactCredentialKeepsPrintableTextVerbatim 是上面那条判据的**反向对照**：
// 只断言"不含某类字符"的话，把 sanitizeLogLine 改成 `return ""` 也会绿。可打印内容
// （中文/ASCII/常见标点）必须逐字保留。
func TestRedactCredentialKeepsPrintableTextVerbatim(t *testing.T) {
	const plain = "ldap: bind failed code=49 用户不存在 user=张三 host=ldap.example.com:636 (tls=starttls)"
	if got := redactCredential(plain, "hunter2"); got != plain {
		t.Fatalf("可打印内容必须逐字保留（不得被改写/清空）：\n got=%q\nwant=%q", got, plain)
	}
	if got := sanitizeLogLine(plain); got != plain {
		t.Fatalf("sanitizeLogLine 不得改动可打印内容：%q", got)
	}
}

// partialEscapeTail 报告 s 结尾是否为**不完整**的转义序列（`\`、`\x`、`\xN`、
// `\u`、`\uNNN`）；完整形态是 `\n`/`\r`/`\t`/`\xNN`/`\uNNNN`。
//
// 与 internal/util/control_test.go、wasmapp/logbuf/logbuf_test.go 里同名判据是同一条
// 规则的三处测试辅助（三个包无法共享 test-only 代码）；此处必须完整到 `\xN`/`\uNNN`，
// 否则"截断把转义切成半截"的变异体会漏网（例如正文以 `\u20` 结尾）。
func partialEscapeTail(s string) string {
	isHex := func(b byte) bool {
		return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F')
	}
	i := len(s)
	for i > 0 && isHex(s[i-1]) {
		i--
	}
	digits := len(s) - i
	switch {
	case digits == 0:
		if strings.HasSuffix(s, `\`) {
			return `\`
		}
		if strings.HasSuffix(s, `\x`) || strings.HasSuffix(s, `\u`) {
			return s[len(s)-2:]
		}
		return ""
	case i >= 1 && s[i-1] == '\\':
		return s[i-1:] // `\` + 1..4 位十六进制 = 半个 `\xNN`/`\uNNNN`
	case i >= 2 && s[i-2] == '\\' && (s[i-1] == 'x' || s[i-1] == 'u'):
		width := 2
		if s[i-1] == 'u' {
			width = 4
		}
		if digits < width {
			return s[i-2:]
		}
	}
	return ""
}

// TestRedactCredentialTruncationKeepsEscapesWhole 钉住"截断必须落在转义边界上"：
// 超过 300 字节的文本会截断，若按字节硬切（旧 truncateUTF8 就是在转义之后切字节），
// 第 300 字节可能正好落在 `\u2028` 这类转义序列中间，输出就会以 `\u`/`\u202`（半截
// 转义）结尾 —— 下游做一次反转义的消费端会把紧随其后的宿主换行当成续行符。
//
// 参数化：让边界在 290..306 之间滑动，覆盖 `\n`（2 字符）、`\x85`（4 字符）与
// `\u2028`（6 字符）三种宽度的所有切点。
func TestRedactCredentialTruncationKeepsEscapesWhole(t *testing.T) {
	for n := 290; n <= 306; n++ {
		for _, tail := range []string{"\n", "\x01", "\u0085", "\u2028", "\u202e"} {
			in := strings.Repeat("A", n) + strings.Repeat(tail, 40)
			got := redactCredential(in, "")
			if !utf8.ValidString(got) {
				t.Fatalf("n=%d tail=%q 截断切出非法 UTF-8：%q", n, tail, got)
			}
			if len(got) > 320 {
				t.Fatalf("n=%d tail=%q 超出长度上限：%d 字节", n, tail, len(got))
			}
			body := strings.TrimSuffix(got, "…")
			if bad := partialEscapeTail(body); bad != "" {
				t.Fatalf("n=%d tail=%q 截断落在转义序列中间（正文以 %q 结尾）：%q",
					n, tail, bad, got)
			}
		}
	}
}

// TestLDAPDialerWiresControl(审计 N6 回归网有洞):*行为*测试只测 `ldapDialControl`
// 纯函数,把 `ldapDialer()` 里的 `Control:` 接线摘掉后既有用例**仍全绿**。这里钉接线本身。
func TestLDAPDialerWiresControl(t *testing.T) {
	d := ldapDialer()
	if d.Control == nil {
		t.Fatal("ldapDialer() 必须挂上 Control(连接期 IP 复检),否则 check-then-dial 窗口重新打开")
	}
	if reflect.ValueOf(d.Control).Pointer() != reflect.ValueOf(ldapDialControl).Pointer() {
		t.Fatal("Control 必须是 ldapDialControl 本身(不要换成一个不检查的实现)")
	}
	if d.Timeout != ldapTimeout {
		t.Fatalf("Timeout = %v, want %v", d.Timeout, ldapTimeout)
	}
}
