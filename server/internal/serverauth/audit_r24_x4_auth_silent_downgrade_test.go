package serverauth

// R24-X4 两条 P1 的判据(泳道 FIX-23;审计报告 temp/r24/X4-fresh/REPORT.md B1/B2)。
//
// B1 LDAP 未配 group_filter 时**每次登录清空该用户全部组归属**(静默降权、
//    不自愈):`GroupsPresent` 旧实现恒 true,而未配过滤器时根本没查组 ⇒
//    `SyncUserGroups(nil)` 全量替换成空。
// B2 保存认证配置时 IdP discovery 失败 ⇒ 运行期 provider 被**静默摘除**,
//    而 `/auth/methods` 仍报 `configured=true`、保存回 200 `{"ok":true}`、
//    零日志零审计 ⇒ 登录页留一颗点到 404 的 SSO 按钮。
//
// 每条用例都对应审计给出的判据编号(①~④),并且都能被"把修复回退掉"杀死:
//   - B1:把 `GroupsPresent: syncGroups` 改回恒 true ⇒ A1 红;
//   - B1:把 dirsync 的 `prov.syncsGroups()` 改回 `prov.GroupFilter != ""` 之外的
//     写法(或删掉登录侧守卫) ⇒ A1/A2 的跨路径对拍红;
//   - B2:去掉"保留旧 provider" ⇒ B1 红(登录路由 404);
//   - B2:保存接口回 200 ⇒ B1 红(判据明确禁止"保存成功但 SSO 已死");
//   - B2:configured 退回只看 settings ⇒ B3(router 层,两条 methods 路由)红。

import (
	"bytes"
	"database/sql"
	"log"
	"net/http"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/go-ldap/ldap/v3"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// ---------------------------------------------------------------------------
// B1 LDAP 组同步的唯一判据
// ---------------------------------------------------------------------------

// r24x4LDAPFake 构造一个"登录 + 全量同步"两条路径都能走的假目录:
// 服务账号可 bind、alice(uid=alice)可 bind、全量用户扫描 3 人、
// 全量组扫描与单用户组查询按 groupEntries 决定。
//
// 真实企业目录的最小形态就是它:group_attr=cn,group_filter=(member=%s)。
func r24x4LDAPFake(userGroupEntries []*ldap.Entry) *fakeLDAPConn {
	aliceDN := "uid=alice,ou=people,dc=example"
	return &fakeLDAPConn{
		passwords: map[string]string{
			"cn=svc,ou=system,dc=example": "svcpass",
			aliceDN:                       "pw",
		},
		searchResults: map[string]*ldap.SearchResult{
			// 登录:按用户名检索(过滤器 = user_filter 的 %s 替换)
			"(uid=alice)": {Entries: []*ldap.Entry{
				dirUser(aliceDN, "alice", "Alice", "alice@example.com"),
			}},
			// 全量同步:用户扫描(user_filter %s → *)
			"(uid=*)": {Entries: []*ldap.Entry{
				dirUser(aliceDN, "alice", "Alice", "alice@example.com"),
				dirUser("uid=bob,ou=people,dc=example", "bob", "Bob", "bob@example.com"),
				dirUser("uid=carol,ou=people,dc=example", "carol", "Carol", "carol@example.com"),
			}},
			// 全量同步:组扫描(group_filter %s → *)
			"(member=*)": {Entries: []*ldap.Entry{
				dirGroup("cn=admins,ou=groups,dc=example", "admins"),
				dirGroup("cn=devs,ou=groups,dc=example", "devs"),
			}},
			// 单用户组查询:本次用例的输入(空列表 = 目录说"该用户不属于任何组")
			"(member=" + aliceDN + ")": {Entries: userGroupEntries},
		},
	}
}

// userGroupRows 读该用户在 user_groups 里的**原始行**(判据要求"逐行相等",
// 不用名字集合代替:行身份也要一致)。
func userGroupRows(t *testing.T, db *sql.DB, userID int64) []string {
	t.Helper()
	rows, err := db.Query(`SELECT user_id::text || ':' || group_id::text FROM user_groups
		WHERE user_id = $1 ORDER BY group_id`, userID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		if err := rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out = append(out, s)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestR24X4LDAPLoginWithoutGroupFilterKeepsGroups 对应审计判据 ①/④:
// 未配 group_filter 时登录**不得**改 user_groups(真 PG,登录前后逐行相等),
// 且同一次配置下目录同步路径给出**同一结论**。
func TestR24X4LDAPLoginWithoutGroupFilterKeepsGroups(t *testing.T) {
	db := mustDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,ldap"); err != nil {
		t.Fatal(err)
	}
	// group_filter 留空 —— webadmin 的字段标签就是「组过滤器(可选)」,
	// 只填必填项的最小可用配置正是这个形态。
	prov := newLDAPProvider(t, r24x4LDAPFake(nil), map[string]string{"group_filter": ""})
	if prov.syncsGroups() {
		t.Fatal("前置不成立:group_filter 为空时 syncsGroups() 仍为 true")
	}

	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	api.RegisterProvider(prov)
	api.SetEnabledProviders([]string{"local", "ldap"})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	login := func(step string) {
		t.Helper()
		w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"alice","password":"pw"}`, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: 登录 = %d %s", step, w.Code, w.Body.String())
		}
	}
	login("首次登录(建行)")
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if u.Source != "external" {
		t.Fatalf("前置不成立:alice 的 Source = %q, want external", u.Source)
	}
	// 模拟管理员在「用户」页手工分配的部门 + 历史上由 group_filter 同步来的组。
	if err := serverstore.SyncUserGroups(db, u.ID, []string{"engineering", "hand-made"}); err != nil {
		t.Fatal(err)
	}
	before := userGroupRows(t, db, u.ID)
	if len(before) != 2 {
		t.Fatalf("前置不成立:预置组 = %v", before)
	}

	// ---- 判据 ①:登录不得改动 user_groups ----------------------------------
	login("复登(判据)")
	after := userGroupRows(t, db, u.ID)
	if strings.Join(before, ",") != strings.Join(after, ",") {
		t.Fatalf("未配 group_filter 时登录改动了组归属(静默降权、且同步侧守卫使其不自愈):\n"+
			"  登录前 user_groups = %v\n  登录后 user_groups = %v", before, after)
	}

	// ---- 判据 ④:目录同步路径对同一输入给出同一结论 -------------------------
	if _, err := SyncDirectoryRun(db, prov); err != nil {
		t.Fatalf("目录同步: %v", err)
	}
	afterSync := userGroupRows(t, db, u.ID)
	if strings.Join(before, ",") != strings.Join(afterSync, ",") {
		t.Fatalf("同一配置下两条路径结论不一致(登录保留组、同步却改了):\n"+
			"  同步前 = %v\n  同步后 = %v", before, afterSync)
	}

	// 机制级:提供方必须**如实**声明"本次没有组声明"(GroupsPresent=false),
	// 而不是靠消费方猜。恒真会让任何调用方(含未来的第三条路径)重新踩坑。
	ui, err := prov.Authenticate("alice", "pw")
	if err != nil {
		t.Fatalf("直接认证: %v", err)
	}
	if ui.GroupsPresent {
		t.Fatal("未配 group_filter 时 GroupsPresent 仍为 true —— 消费方会把 Groups=nil 当成" +
			"「该用户不属于任何组」并全量替换成空")
	}
}

// TestR24X4LDAPGroupFilterEmptyResultStillReclaims 对应审计判据 ③:
// **配了** group_filter 且目录返回空组列表 ⇒ 按既有语义("空组即回收",
// server/AGENTS.md §2.3)应当回收 —— 这条必须与 ① 区分开,不能把正当回收也挡掉。
func TestR24X4LDAPGroupFilterEmptyResultStillReclaims(t *testing.T) {
	db := mustDB(t)
	if err := serverstore.SetSetting(db, "auth.enabled", "local,ldap"); err != nil {
		t.Fatal(err)
	}
	// group_filter 已配置;目录对 alice 的组查询**成功**但返回空列表。
	prov := newLDAPProvider(t, r24x4LDAPFake([]*ldap.Entry{}), nil)
	if !prov.syncsGroups() {
		t.Fatal("前置不成立:配置了 group_filter 时 syncsGroups() 为 false")
	}

	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	api.RegisterProvider(prov)
	api.SetEnabledProviders([]string{"local", "ldap"})
	gin.SetMode(gin.TestMode)
	r := gin.New()
	api.RegisterRoutes(r)

	login := func(step string) {
		t.Helper()
		w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", `{"username":"alice","password":"pw"}`, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("%s: 登录 = %d %s", step, w.Code, w.Body.String())
		}
	}
	login("首次登录")
	u, err := serverstore.GetUserByUsername(db, "alice")
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SyncUserGroups(db, u.ID, []string{"engineering"}); err != nil {
		t.Fatal(err)
	}
	if rows := userGroupRows(t, db, u.ID); len(rows) != 1 {
		t.Fatalf("前置不成立:预置组 = %v", rows)
	}

	// 判据 ③:查询过且结果为空 ⇒ 回收(登录路径)
	login("复登(回收判据)")
	if rows := userGroupRows(t, db, u.ID); len(rows) != 0 {
		t.Fatalf("配了 group_filter 且目录返回空组时没有回收:user_groups = %v"+
			"(空组即回收是对外承诺的语义,修复 ① 不得把它一起挡掉)", rows)
	}

	// 判据 ④:同步路径同一结论(重新分配后再同步 ⇒ 同样回收)
	if err := serverstore.SyncUserGroups(db, u.ID, []string{"engineering"}); err != nil {
		t.Fatal(err)
	}
	if _, err := SyncDirectoryRun(db, prov); err != nil {
		t.Fatalf("目录同步: %v", err)
	}
	if rows := userGroupRows(t, db, u.ID); len(rows) != 0 {
		t.Fatalf("同步路径未回收空组:user_groups = %v", rows)
	}

	// 机制级:查询过 ⇒ GroupsPresent=true(与 ① 的 false 形成对照)
	ui, err := prov.Authenticate("alice", "pw")
	if err != nil {
		t.Fatalf("直接认证: %v", err)
	}
	if !ui.GroupsPresent || len(ui.Groups) != 0 {
		t.Fatalf("配了 group_filter 时应当声明「查询过且为空」:GroupsPresent=%v Groups=%v",
			ui.GroupsPresent, ui.Groups)
	}
}

// ---------------------------------------------------------------------------
// B2 OIDC 构建失败不得静默摘除 provider,保存接口不得回 200 ok
// ---------------------------------------------------------------------------

// TestR24X4OIDCDiscoveryFailureKeepsWorkingProvider 对应审计判据 ①/②:
// 保存那一刻 IdP discovery 不可达 ⇒ 旧 provider 仍可用(登录路由不再 404)、
// 有日志、有审计、响应如实(不得回 200 ok);而 discovery 正常时集合被正确替换。
func TestR24X4OIDCDiscoveryFailureKeepsWorkingProvider(t *testing.T) {
	ensureTestMasterKey(t)
	db := mustDB(t)
	idp := newFakeIDP(t)

	// ---- 保存前的状态:上一次成功保存留下的、**正在工作**的 provider -------
	if err := serverstore.SetSetting(db, "auth.enabled", "local,oidc"); err != nil {
		t.Fatal(err)
	}
	working := newOIDCProvider(t, idp)
	working.name = "oidc"

	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	api.RegisterBrowser(working)
	api.SetEnabledProviders([]string{"local", "oidc"})

	// 采集日志:审计判据要求"有日志"(旧实现 0 条)。
	var logBuf bytes.Buffer
	prevOut := log.Writer()
	log.SetOutput(&logBuf)
	t.Cleanup(func() { log.SetOutput(prevOut) })

	admin := &AdminAPI{DB: db, ReloadAuth: func() error { return api.ReloadProviders(db) }}
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.PUT("/api/server/admin/auth", admin.Handlers().SetAuthConfig)
	client := api.Handlers()
	r.GET("/api/client/v2/auth/oidc/login", client.BrowserLogin("oidc"))
	r.GET("/api/client/v2/auth/methods", client.PublicMethods)

	// 判据 ① 的起点:provider 已在运行期注册,SSO 登录入口不是 404
	if w, _ := doJSON(t, r, "GET", "/api/client/v2/auth/oidc/login", "", nil); w.Code == http.StatusNotFound {
		t.Fatalf("前置不成立:保存前 oidc 登录入口就是 404(%d %s)", w.Code, w.Body.String())
	}

	// ---- 保存:issuer 指向一个必然不可达的地址(discovery 失败) ------------
	deadIssuer := "http://127.0.0.1:1"
	body := `{"mode":"oidc","enabled":"local,oidc","oidc":{"issuer":"` + deadIssuer + `",` +
		`"client_id":"test-client","redirect_url":"` + testRedirectURI + `","client_secret":"***"}}`
	w, out := doJSON(t, r, "PUT", "/api/server/admin/auth", body, nil)

	// 判据:响应**如实**——设置确实落库了,但新配置未生效,绝不回 200 ok。
	if w.Code == http.StatusOK {
		t.Fatalf("discovery 失败时保存仍回 200(%s)—— 管理员会把「保存成功」读成「SSO 正常」,"+
			"而实际登录页那颗按钮点到 404;body=%s", w.Body.String(), out)
	}
	msg, _ := out["error"].(map[string]any)
	if msg == nil || !strings.Contains(msg["message"].(string), "未生效") {
		t.Fatalf("失败响应没有说明「配置已保存但未生效」:%s", w.Body.String())
	}

	// 判据:旧 provider **仍可用**(登录路由不再 404)。
	wLogin, _ := doJSON(t, r, "GET", "/api/client/v2/auth/oidc/login", "", nil)
	if wLogin.Code == http.StatusNotFound {
		t.Fatalf("discovery 失败后旧 provider 被摘除:oidc 登录入口 = 404 %s"+
			"(hide_local=true 的部署里员工端就此无路可进)", wLogin.Body.String())
	}
	if wLogin.Code != http.StatusFound && wLogin.Code != http.StatusOK {
		t.Fatalf("oidc 登录入口 = %d %s, want 302/200(旧实例应当继续工作)", wLogin.Code, wLogin.Body.String())
	}

	// 判据:日志 + 审计留痕(旧实现两者皆零)。
	if !strings.Contains(logBuf.String(), "oidc") {
		t.Fatalf("discovery 失败没有留下任何日志(旧缺陷形态):log=%q", logBuf.String())
	}
	var detail string
	if err := db.QueryRow(`SELECT detail FROM audit_logs WHERE action = 'auth_config'
		ORDER BY id DESC LIMIT 1`).Scan(&detail); err != nil {
		t.Fatalf("没有 auth_config 审计条目: %v", err)
	}
	if !strings.Contains(detail, "apply_failed") {
		t.Fatalf("审计没有记录「新配置未生效」:detail=%q", detail)
	}

	// 判据 ②(正向):discovery 正常时集合被**正确替换**为新的 IdP。
	idp2 := newFakeIDP(t)
	bodyOK := `{"mode":"oidc","enabled":"local,oidc","oidc":{"issuer":"` + idp2.srv.URL + `",` +
		`"client_id":"client-b","redirect_url":"` + testRedirectURI + `","client_secret":"***"}}`
	wOK, _ := doJSON(t, r, "PUT", "/api/server/admin/auth", bodyOK, nil)
	if wOK.Code != http.StatusOK {
		t.Fatalf("discovery 正常时保存 = %d %s, want 200", wOK.Code, wOK.Body.String())
	}
	cur, ok := api.browserProvider("oidc").(*OIDCProvider)
	if !ok || cur == nil {
		t.Fatal("discovery 正常时 provider 没有被替换(仍为空)")
	}
	if cur.cfg.ClientID != "client-b" {
		t.Fatalf("provider 没有被替换成新配置:client_id = %q, want client-b", cur.cfg.ClientID)
	}
}
