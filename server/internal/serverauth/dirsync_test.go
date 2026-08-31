package serverauth

import (
	"strings"
	"testing"

	"github.com/go-ldap/ldap/v3"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// dirUser 构造一个目录用户条目(uid + cn + mail)。
func dirUser(dn, uid, cn, mail string) *ldap.Entry {
	return &ldap.Entry{
		DN: dn,
		Attributes: []*ldap.EntryAttribute{
			{Name: "uid", Values: []string{uid}},
			{Name: "cn", Values: []string{cn}},
			{Name: "mail", Values: []string{mail}},
		},
	}
}

func dirGroup(dn, cn string) *ldap.Entry {
	return &ldap.Entry{
		DN: dn,
		Attributes: []*ldap.EntryAttribute{
			{Name: "cn", Values: []string{cn}},
		},
	}
}

// fakeDir returns a provider whose fake connection enumerates 3 users and
// 2 groups; group membership resolvable via (member=<userDN>).
func fakeDir(t *testing.T) (*LDAPProvider, *fakeLDAPConn) {
	f := &fakeLDAPConn{
		passwords: map[string]string{"cn=svc,ou=system,dc=example": "svcpass"},
		searchResults: map[string]*ldap.SearchResult{
			// 全量用户扫描(user_filter %s → *)
			"(uid=*)": {Entries: []*ldap.Entry{
				dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
				dirUser("uid=bob,ou=people,dc=example", "bob", "Bob", "bob@example.com"),
				dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
			}},
			// 全量组扫描(group_filter %s → *)
			"(member=*)": {Entries: []*ldap.Entry{
				dirGroup("cn=admins,ou=groups,dc=example", "admins"),
				dirGroup("cn=devs,ou=groups,dc=example", "devs"),
			}},
			// 单用户组查询
			"(member=uid=alice,ou=people,dc=example)": {Entries: []*ldap.Entry{
				dirGroup("cn=admins,ou=groups,dc=example", "admins"),
			}},
			"(member=uid=bob,ou=people,dc=example)": {Entries: []*ldap.Entry{
				dirGroup("cn=devs,ou=groups,dc=example", "devs"),
			}},
			"(member=uid=carol,ou=people,dc=example)": {Entries: []*ldap.Entry{}},
		},
	}
	p := newLDAPProvider(t, f, nil) // 该 helper 需要 *testing.T
	return p, f
}

// TestProbeDirectory:测试连接返回用户/组统计与前 5 样例。
func TestProbeDirectory(t *testing.T) {
	p, f := fakeDir(t) // 注意: 3 用户仅占样例(≤5),组数 2
	report, err := p.ProbeDirectory()
	if err != nil {
		t.Fatalf("probe: %v", err)
	}
	if report.Users != 3 || report.Groups != 2 {
		t.Fatalf("report = %d users %d groups, want 3/2", report.Users, report.Groups)
	}
	if len(report.Sample) != 3 {
		t.Fatalf("sample = %d, want 3", len(report.Sample))
	}
	if report.Sample[0].Username != "alice" || report.Sample[0].DisplayName != "Alice" {
		t.Fatalf("sample[0] = %+v", report.Sample[0])
	}
	if len(report.Sample[0].Groups) != 1 || report.Sample[0].Groups[0] != "admins" {
		t.Fatalf("sample[0].groups = %v, want [admins]", report.Sample[0].Groups)
	}
	if !f.paged {
		t.Fatal("probe must use paged search")
	}
}

// TestSyncDirectoryOnce:一轮同步创建 3 用户 + 组,第二次同步不再新增。
func TestSyncDirectoryOnce(t *testing.T) {
	db := mustDB(t)
	p, _ := fakeDir(t)
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Added != 3 {
		t.Fatalf("added = %d, want 3", res.Added)
	}
	if res.Groups != 2 {
		t.Fatalf("groups = %d, want 2", res.Groups)
	}
	// 用户存在且组正确
	for _, u := range []struct{ name, group string }{
		{"alice", "admins"}, {"bob", "devs"}, {"carol", ""},
	} {
		user, err := serverstore.GetUserByUsername(db, u.name)
		if err != nil {
			t.Fatalf("get %s: %v", u.name, err)
		}
		if user.Source != "external" || user.Status != 1 {
			t.Fatalf("%s = source=%s status=%d, want external/1", u.name, user.Source, user.Status)
		}
		groups, err := serverstore.UserGroups(db, user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if u.group == "" {
			if len(groups) != 0 {
				t.Fatalf("%s groups = %v, want none", u.name, groups)
			}
		} else if len(groups) != 1 || groups[0] != u.group {
			t.Fatalf("%s groups = %v, want [%s]", u.name, groups, u.group)
		}
	}
	// 第二次同步:幂等,无新增
	res2, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync2: %v", err)
	}
	if res2.Added != 0 {
		t.Fatalf("added2 = %d, want 0", res2.Added)
	}
}

// TestSyncDirectoryDeactivatesMissing:目录中消失的外部用户被停用+吊销令牌;
// 本地账号不受影响。
func TestSyncDirectoryDeactivatesMissing(t *testing.T) {
	db := mustDB(t)
	p, f := fakeDir(t)
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	// 给 bob 记一个 token(受吊销验证),给 alice 也记一个(应保留)
	bob, _ := serverstore.GetUserByUsername(db, "bob")
	alice, _ := serverstore.GetUserByUsername(db, "alice")
	if _, err := serverstore.CreateToken(db, bob.ID, "raw-bob-token", bob.UpdatedAt.AddDate(0, 0, 1)); err != nil {
		t.Fatal(err)
	}
	if _, err := serverstore.CreateToken(db, alice.ID, "raw-alice-token", alice.UpdatedAt.AddDate(0, 0, 1)); err != nil {
		t.Fatal(err)
	}
	// bob 从目录消失(bob 不再由 (uid=*) 返回)
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{
		dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
		dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
	}}
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Deact != 1 {
		t.Fatalf("deactivated = %d, want 1", res.Deact)
	}
	bob, _ = serverstore.GetUserByUsername(db, "bob")
	if bob.Status != 0 {
		t.Fatalf("bob status = %d, want 0 (deactivated)", bob.Status)
	}
	// bob 的 token 被吊销删除;alice 的 token 保留
	if _, err := serverstore.GetTokenByHash(db, serverstore.TokenHash("raw-bob-token")); err == nil {
		t.Fatal("bob token should be revoked (deleted) with user deactivation")
	}
	if _, err := serverstore.GetTokenByHash(db, serverstore.TokenHash("raw-alice-token")); err != nil {
		t.Fatalf("alice token should be kept: %v", err)
	}
	alice, _ = serverstore.GetUserByUsername(db, "alice")
	if alice.Status != 1 {
		t.Fatalf("alice should stay active: %d", alice.Status)
	}
}

// TestSyncDirectoryRefusesEmpty:空目录拒绝执行(防误停用全部外部用户)。
func TestSyncDirectoryRefusesEmpty(t *testing.T) {
	db := mustDB(t)
	p, f := fakeDir(t)
	// 先正常同步一个用户,再清空目录
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{}}
	if _, err := SyncDirectoryRun(db, p); err == nil || !strings.Contains(err.Error(), "refusing") {
		t.Fatalf("expected refusal on empty directory, got %v", err)
	}
	user, _ := serverstore.GetUserByUsername(db, "alice")
	if user.Status != 1 {
		t.Fatalf("alice deactivated despite refusal: %d", user.Status)
	}
}

// TestSyncDirectorySkipsLocal:同名本地账号不被外部同步接管。
func TestSyncDirectorySkipsLocal(t *testing.T) {
	db := mustDB(t)
	if _, err := serverstore.CreateUserWithPassword(db, "alice", "pw12345678"); err != nil {
		t.Fatal(err)
	}
	p, _ := fakeDir(t)
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	// 目录 3 用户,其中 alice 与本地冲突 → 只建 2 个外部行
	if res.Added != 2 {
		t.Fatalf("added = %d, want 2 (alice skipped)", res.Added)
	}
	u, _ := serverstore.GetUserByUsername(db, "alice")
	if u.Source != "local" {
		t.Fatalf("alice source = %s, want local (must not be adopted)", u.Source)
	}
}

// TestSyncDirectoryLoopNoLDAP:LDAP 未启用时 Run no-op。
func TestDirectorySyncDisabled(t *testing.T) {
	db := mustDB(t)
	res, err := NewDirectorySync().Run(db)
	if err != nil {
		t.Fatalf("disabled run: %v", err)
	}
	if res.Added != 0 || res.Deact != 0 {
		t.Fatalf("expected no-op, got %+v", res)
	}
}

// TestSyncDirectoryUpdatesProfile:目录改显示名/邮箱后同步更新;停用的外部
// 用户回到目录后重新启用。
func TestSyncDirectoryUpdatesProfile(t *testing.T) {
	db := mustDB(t)
	p, f := fakeDir(t)
	if _, err := SyncDirectoryRun(db, p); err != nil {
		t.Fatal(err)
	}
	// 停用 alice(模拟离职→再入职)
	alice, _ := serverstore.GetUserByUsername(db, "alice")
	upd := *alice
	upd.Status = 0
	if err := serverstore.UpdateUser(db, &upd); err != nil {
		t.Fatal(err)
	}
	// 目录改 alice 信息(显示名 + 邮箱)
	f.searchResults["(uid=*)"] = &ldap.SearchResult{Entries: []*ldap.Entry{
		dirUser("uid=alice,ou=people,dc=example", "alice", "Alice Wang", "aw@example.com"),
		dirUser("uid=bob,ou=people,dc=example", "bob", "Bob", "bob@example.com"),
		dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
	}}
	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatal(err)
	}
	if res.Updated == 0 {
		t.Fatal("expected profile update/re-enable in result")
	}
	alice, _ = serverstore.GetUserByUsername(db, "alice")
	if alice.Status != 1 || alice.DisplayName != "Alice Wang" || alice.Email != "aw@example.com" {
		t.Fatalf("alice after sync = %+v", alice)
	}
}

// TestDirectorySyncRunFromSettings:LDAPDirectorySync.Run 从 settings 读配置
// 全量同步(经 ldapFromSettings 路径)——验证默认 runner 的端到端。
func TestDirectorySyncRunFromSettings(t *testing.T) {
	db := mustDB(t)
	f := &fakeLDAPConn{
		passwords: map[string]string{"cn=svc,ou=system,dc=example": "svcpass"},
		searchResults: map[string]*ldap.SearchResult{
			"(uid=*)": {Entries: []*ldap.Entry{
				dirUser("uid=alice,ou=people,dc=example", "alice", "Alice", "alice@example.com"),
			}},
		},
	}
	// 写 settings(与 setAuthConfig 落盘一致)
	for k, v := range map[string]string{
		"auth.enabled":       "local,ldap",
		"ldap.server_url":    "ldap://fake",
		"ldap.bind_dn":       "cn=svc,ou=system,dc=example",
		"ldap.bind_password": "svcpass",
		"ldap.base_dn":       "dc=example",
		"ldap.user_filter":   "(uid=%s)",
	} {
		if err := serverstore.SetSetting(db, k, v); err != nil {
			t.Fatal(err)
		}
	}
	res, err := SyncDirectoryOnce(db, LDAPDirectorySync{Dial: func(string) (ldapConn, error) { return f, nil }})
	if err != nil {
		t.Fatalf("run: %v", err)
	}
	if res.Added != 1 {
		t.Fatalf("added = %d, want 1", res.Added)
	}
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil || u.Source != "external" {
		t.Fatalf("alice = %+v %v", u, err)
	}
}

// TestSyncDirectoryNoUid:目录条目无 uid(如 mokahr 系,只有 cn/mail)——
// 同步必须回退 cn 作为用户名,不能把全部用户跳过(用户 2026-09 生产实例
// 报告"配置 LDAP 后用户没同步":447 用户全部因 username 为空被跳过)。
func TestSyncDirectoryNoUid(t *testing.T) {
	db := mustDB(t)
	users := []*ldap.Entry{
		dirUser("cn=alice,ou=users,dc=mokahr,dc=com", "alice", "alice", "alice@mokahr.com"),
		dirUser("cn=bob,ou=users,dc=mokahr,dc=com", "bob", "bob", "bob@mokahr.com"),
	}
	// 构造无 uid 的条目(仅 cn/mail)
	for _, u := range users {
		attrs := []*ldap.EntryAttribute{}
		for _, a := range u.Attributes {
			if a.Name != "uid" {
				attrs = append(attrs, a)
			}
		}
		u.Attributes = attrs
	}
	f := &fakeLDAPConn{
		passwords: map[string]string{"cn=admin,dc=mokahr,dc=com": "pw", "cn=alice,ou=people,dc=mokahr,dc=com": "pw"},
		searchResults: map[string]*ldap.SearchResult{
			"(&(cn=*)(objectClass=inetOrgPerson))": {Entries: users},
		},
	}
	p := &LDAPProvider{ServerURL: "ldap://fake", BindDN: "cn=admin,dc=mokahr,dc=com", BindPassword: "pw", BaseDN: "dc=mokahr,dc=com", UserFilter: "(&(cn=%s)(objectClass=inetOrgPerson))", GroupAttr: "cn"}
	p.dial = func(string) (ldapConn, error) { return f, nil }

	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Added != 2 {
		t.Fatalf("added = %d, want 2 (no-uid users must sync via cn)", res.Added)
	}
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil || u.Source != "external" || u.DisplayName != "alice" {
		t.Fatalf("alice = %+v %v (username must fall back to cn)", u, err)
	}
	// entryUserName 规则:uid→cn→mail→DN RND
	e := dirUser("cn=alice,ou=x,dc=y", "ignored", "cnname", "m@x")
	if got := entryUserName(e, "fallback"); got != "ignored" {
		t.Fatalf("uid priority: got %q", got)
	}
	e2 := dirUser("cn=alice,ou=x,dc=y", "", "cnname", "m@x")
	if got := entryUserName(e2, "fallback"); got != "cnname" {
		t.Fatalf("cn fallback: got %q", got)
	}
	e3 := dirUser("cn=alice,ou=x,dc=y", "", "", "m@x")
	if got := entryUserName(e3, "fallback"); got != "m@x" {
		t.Fatalf("mail fallback: got %q", got)
	}
	e4 := &ldap.Entry{DN: "uid=alice,ou=x,dc=y"}
	if got := entryUserName(e4, "fallback"); got != "alice" {
		t.Fatalf("DN RDN fallback: got %q", got)
	}
}

// TestSyncDirectoryUserAttrCn:user_attr=cn 的目录(如 mokahr 系,无 uid)——
// 同步回退到配置的 cn 属性,目录全部用户都能同步;且登录用户规范化一致。
func TestSyncDirectoryUserAttrCn(t *testing.T) {
	db := mustDB(t)
	f := &fakeLDAPConn{
		passwords: map[string]string{"cn=admin,dc=mokahr,dc=com": "pw", "cn=alice,ou=people,dc=mokahr,dc=com": "pw"},
		searchResults: map[string]*ldap.SearchResult{
			// user_filter=(&(cn=%s)(objectClass=inetOrgPerson));扫描替换 %s→*
			"(&(cn=*)(objectClass=inetOrgPerson))": {Entries: []*ldap.Entry{
				{ // 无 uid,仅 cn/mail/sn(与生产 mokahr 目录一致)
					DN: "cn=alice,ou=people,dc=mokahr,dc=com",
					Attributes: []*ldap.EntryAttribute{
						{Name: "cn", Values: []string{"alice"}},
						{Name: "sn", Values: []string{"zhangsan"}},
						{Name: "mail", Values: []string{"alice@mokahr.com"}},
					},
				},
				{
					DN: "cn=bob,ou=people,dc=mokahr,dc=com",
					Attributes: []*ldap.EntryAttribute{
						{Name: "cn", Values: []string{"bob"}},
						{Name: "sn", Values: []string{"谢迪"}},
						{Name: "mail", Values: []string{"bob@mokahr.com"}},
					},
				},
			}},
			"(&(cn=alice)(objectClass=inetOrgPerson))": {Entries: []*ldap.Entry{
				{DN: "cn=alice,ou=people,dc=mokahr,dc=com",
					Attributes: []*ldap.EntryAttribute{
						{Name: "cn", Values: []string{"alice"}}, {Name: "sn", Values: []string{"zhangsan"}}, {Name: "mail", Values: []string{"alice@mokahr.com"}},
					}},
			}},
			"(member=cn=alice,ou=people,dc=mokahr,dc=com)": {Entries: []*ldap.Entry{
				{DN: "cn=SSC,ou=groups,dc=mokahr,dc=com", Attributes: []*ldap.EntryAttribute{{Name: "cn", Values: []string{"SSC"}}}},
			}},
		},
	}
	p := &LDAPProvider{
		ServerURL: "ldap://fake", BindDN: "cn=admin,dc=mokahr,dc=com", BindPassword: "pw",
		BaseDN: "dc=mokahr,dc=com", UserFilter: "(&(cn=%s)(objectClass=inetOrgPerson))",
		UserAttr: "cn", GroupFilter: "(member=%s)", GroupAttr: "cn",
	}
	p.dial = func(string) (ldapConn, error) { return f, nil }

	res, err := SyncDirectoryRun(db, p)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Added != 2 {
		t.Fatalf("added = %d, want 2 (cn-based users)", res.Added)
	}
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil || u.Source != "external" || u.DisplayName != "zhangsan" {
		t.Fatalf("alice = %+v %v", u, err)
	}
	groups, err := serverstore.UserGroups(db, u.ID)
	if err != nil || len(groups) != 1 || groups[0] != "SSC" {
		t.Fatalf("alice groups = %v %v", groups, err)
	}
	// 登录:user_attr=cn → canonical 取 cn(alice)
	ui, err := p.Authenticate("alice", "pw")
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if ui.Username != "alice" {
		t.Fatalf("login username = %q, want alice (user_attr=cn)", ui.Username)
	}
}
