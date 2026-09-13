package serverauth

// 审计 2026-09-13 P1-1/P1-2/P1-3/P1-4/P2-4/P2-7/P3-2 的永久回归测试
// (取代 temp/audit-20260913/ 里的临时探针)。

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/pquerna/otp/totp"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// P1-1:同一票据的"最多 5 次"必须是硬上限 —— 旧实现 SELECT 判 attempts 后再
// UPDATE 自增,40 并发实测有 10 个穿过门。现在占用与自增是一条 UPDATE。
func TestAuditFixMFAChallengeAttemptsAreAtomic(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	ticket, err := createMFAChallenge(db, uid, "login", "", mfaTicketTTL)
	if err != nil {
		t.Fatal(err)
	}
	const workers = 40
	var wg sync.WaitGroup
	var mu sync.Mutex
	reserved := 0
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, rerr := reserveMFAChallenge(db, ticket, "login"); rerr == nil {
				mu.Lock()
				reserved++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	if reserved != mfaChallengeMaxFailed {
		t.Fatalf("并发占用次数 = %d, want %d(上限必须是硬的)", reserved, mfaChallengeMaxFailed)
	}
}

// P1-1:第二步必须限流(旧实现零限流:密码正确即可无限重签票据 + 每票 5 次猜测,
// 实测 3 轮 15 次猜测 0 次 429)。
func TestAuditFixMFALoginIsRateLimited(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	ensureTestMasterKey(t)
	// 注意顺序:adminRouter 自己会把阈值放宽到 10000,必须在它之后覆盖。
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "3")

	u, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := genTOTPSecret("boss")
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryptMFASecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetUserMFA(db, u.ID, cipher, true); err != nil {
		t.Fatal(err)
	}

	login := func() string {
		w, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
		if w.Code != http.StatusOK {
			t.Fatalf("login: %d %s", w.Code, w.Body.String())
		}
		tk, _ := out["mfa_ticket"].(string)
		if tk == "" {
			t.Fatalf("no ticket: %v", out)
		}
		return tk
	}
	got429 := false
	// 5 轮 × 5 次错误码 = 25 次猜测;阈值 3 时必然出现 429。
	for round := 0; round < 5 && !got429; round++ {
		tk := login()
		for i := 0; i < 5; i++ {
			w, _ := doJSON(t, r, "POST", "/api/server/admin/login/mfa",
				fmt.Sprintf(`{"mfa_ticket":%q,"code":"000000"}`, tk), nil)
			if w.Code == http.StatusTooManyRequests {
				got429 = true
				break
			}
		}
	}
	if !got429 {
		t.Fatal("第二步 25 次错误动态码后仍未限流(可无限爆破 TOTP)")
	}
}

// P2-3:同一动态码在有效窗口内不可重放(旧实现实测:两个票据都 200)。
func TestAuditFixTOTPReplayRejected(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	ensureTestMasterKey(t)
	// 固定时钟:同一 30s 步内两次提交同一码
	orig := nowFn
	fixed := time.Now()
	nowFn = func() time.Time { return fixed }
	t.Cleanup(func() { nowFn = orig })

	u, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	secret, _, err := genTOTPSecret("boss")
	if err != nil {
		t.Fatal(err)
	}
	cipher, err := encryptMFASecret(secret)
	if err != nil {
		t.Fatal(err)
	}
	if err := serverstore.SetUserMFA(db, u.ID, cipher, true); err != nil {
		t.Fatal(err)
	}
	code, err := totp.GenerateCode(secret, fixed)
	if err != nil {
		t.Fatal(err)
	}
	login := func() string {
		_, out := doJSON(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
		tk, _ := out["mfa_ticket"].(string)
		return tk
	}
	if w, _ := doJSON(t, r, "POST", "/api/server/admin/login/mfa",
		fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, login(), code), nil); w.Code != http.StatusOK {
		t.Fatalf("第一次使用动态码应成功: %d", w.Code)
	}
	if w, _ := doJSON(t, r, "POST", "/api/server/admin/login/mfa",
		fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, login(), code), nil); w.Code == http.StatusOK {
		t.Fatal("同一动态码被重放成功(重放防护失效)")
	}
}

// P1-2:随机用户名不再能无限触发 argon2 —— 单 IP 桶必须在 60 次失败内生效。
func TestAuditFixRandomUsernameStillRateLimitedByIP(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "victim", "pw1234567890", false)

	got429 := false
	for i := 0; i < loginIPMaxAttempts+5; i++ {
		body := fmt.Sprintf(`{"username":"ghost-%d","password":"x"}`, i)
		w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", body, nil)
		if w.Code == http.StatusTooManyRequests {
			got429 = true
			t.Logf("第 %d 个随机用户名请求被 IP 桶拦下", i+1)
			break
		}
	}
	if !got429 {
		t.Fatalf("%d 次随机用户名登录后仍无限流(IP 桶未生效)", loginIPMaxAttempts+5)
	}
}

// P1-2:密码校验并发闸存在且有界(单次 argon2id 需 64MiB,未限并发即 OOM 面)。
func TestAuditFixPasswordVerifyGateIsBounded(t *testing.T) {
	slots := passwordVerifyMaxConcurrent()
	if slots < 1 || slots > 32 {
		t.Fatalf("并发槽位 = %d, want 1..32", slots)
	}
	releases := make([]func(), 0, slots)
	for i := 0; i < slots; i++ {
		rel, ok := acquirePasswordVerify()
		if !ok {
			t.Fatalf("第 %d 个槽位应立即可得", i+1)
		}
		releases = append(releases, rel)
	}
	if _, ok := acquirePasswordVerify(); ok {
		t.Fatal("槽位用满后仍能取得槽位(闸门失效)")
	}
	for _, rel := range releases {
		rel()
	}
	if rel, ok := acquirePasswordVerify(); !ok {
		t.Fatal("释放后应可再次取得槽位")
	} else {
		rel()
	}
}

// P1-3:OIDC 回调桶键必须按**真实客户端 IP**(可信代理下的 XFF),而不是
// 反代容器 IP —— 否则 60 次失败回调即可锁死全组织 SSO。
func TestAuditFixOIDCCallbackKeyUsesClientIP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	// 必须走**真实引擎**(ClientIP 依赖引擎的 trustedProxies 配置;用
	// CreateTestContext 会落到 gin 的默认"信任所有代理",测不出真实语义)。
	// 这里复刻生产 compose 的配置:信任 Caddy 容器 IP。
	engine := gin.New()
	if err := engine.SetTrustedProxies([]string{"127.0.0.1", "172.28.0.2"}); err != nil {
		t.Fatal(err)
	}
	var lastKey string
	engine.GET("/key", func(c *gin.Context) {
		lastKey = clientIPKey(c)
		c.Status(http.StatusOK)
	})
	keyOf := func(remote, xff string) string {
		req := httptest.NewRequest(http.MethodGet, "/key", nil)
		req.RemoteAddr = remote
		if xff != "" {
			req.Header.Set("X-Forwarded-For", xff)
		}
		engine.ServeHTTP(httptest.NewRecorder(), req)
		return lastKey
	}
	viaProxyA := keyOf("172.28.0.2:44321", "203.0.113.7")
	viaProxyB := keyOf("172.28.0.2:44321", "198.51.100.9")
	if viaProxyA == viaProxyB {
		t.Fatalf("不同真人共用同一个桶键 %q(反代下桶坍缩 = 全组织 SSO 可被一人锁死)", viaProxyA)
	}
	if !strings.Contains(viaProxyA, "203.0.113.7") {
		t.Fatalf("桶键未使用 XFF 中的真实客户端 IP: %q", viaProxyA)
	}
	// 不可信来源伪造 XFF 不得影响桶键(仍按 RemoteAddr)
	spoof := keyOf("198.51.100.200:5555", "203.0.113.7")
	if strings.Contains(spoof, "203.0.113.7") {
		t.Fatalf("不可信来源的 XFF 被采信: %q", spoof)
	}
}

// P1-4:issuer 保存必须过与"测试连接"相同的校验(旧实现只 TrimSpace,
// 保存即触发 discovery,形同给 metadata 地址开 SSRF 面)。
func TestAuditFixIssuerValidationRejectsMetadataAndBadSchemes(t *testing.T) {
	bad := []string{
		"http://169.254.169.254",
		"https://169.254.169.254",
		"http://metadata.google.internal",
		"http://[fd00:ec2::254]",
		"http://evil.example.com", // 非 https 且非回环
		"file:///etc/passwd",
		"https://user@evil.example.com", // userinfo
	}
	for _, issuer := range bad {
		if err := validateIssuerURL(issuer); err == nil {
			t.Fatalf("issuer %q 未被拒绝", issuer)
		}
	}
	good := []string{"https://idp.example.com", "https://idp.example.com/realms/x", "http://localhost:5556/dex"}
	for _, issuer := range good {
		if err := validateIssuerURL(issuer); err != nil {
			t.Fatalf("issuer %q 被误拒: %v", issuer, err)
		}
	}
}

// P2-7:明文 ldap:// 默认拒绝(可用环境变量显式放行),ldaps 放行。
func TestAuditFixPlaintextLDAPRejectedByDefault(t *testing.T) {
	if err := validateLDAPServerURL("ldap://dir.corp:389"); err == nil {
		t.Fatal("明文 ldap:// 非回环地址未被拒绝(bind 密码会明文过网)")
	}
	if err := validateLDAPServerURL("ldap://localhost:389"); err != nil {
		t.Fatalf("回环 ldap:// 应放行: %v", err)
	}
	if err := validateLDAPServerURL("ldaps://dir.corp:636"); err != nil {
		t.Fatalf("ldaps:// 应放行: %v", err)
	}
	t.Setenv("PICOAI_LDAP_ALLOW_PLAINTEXT", "1")
	if err := validateLDAPServerURL("ldap://dir.corp:389"); err != nil {
		t.Fatalf("显式逃生阀下明文 ldap:// 应放行: %v", err)
	}
}

// P3-2:两个登录入口必须共享同一失败预算(旧实现键命名空间不同,实测客户端面
// 3 次失败后管理面仍可继续尝试)。
func TestAuditFixLoginBudgetSharedAcrossSurfaces(t *testing.T) {
	t.Setenv("PICOAI_LOGIN_MAX_ATTEMPTS", "3")
	db := mustDB(t)
	defer db.Close()
	if _, err := createUserDB(db, "boss", "pw123456", true); err != nil {
		t.Fatal(err)
	}
	api := New(db)
	api.RegisterProvider(NewLocalProvider(db))
	r := gin.New()
	api.RegisterRoutes(r)
	RegisterAdminRoutes(r, db)

	bad := `{"username":"boss","password":"wrong-password"}`
	for i := 0; i < 3; i++ {
		if w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", bad, nil); w.Code == http.StatusTooManyRequests {
			t.Fatalf("第 %d 次客户端失败不应该已经 429", i+1)
		}
	}
	w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login", bad, nil)
	if w.Code != http.StatusTooManyRequests {
		t.Fatalf("客户端面第 4 次失败应 429, got %d", w.Code)
	}
	// 同一账号在管理面必须立刻吃到同一预算
	w2, _ := doJSON(t, r, "POST", "/api/server/admin/login", bad, nil)
	if w2.Code != http.StatusTooManyRequests {
		t.Fatalf("管理面未共享失败预算: %d(旧缺陷:两入口各 10 次)", w2.Code)
	}
}

// P2-4:OIDC 流程表满时必须拒绝新流程,而不是驱逐在途流程。
func TestAuditFixOIDCFlowTableFullFailsClosed(t *testing.T) {
	p := &OIDCProvider{name: "oidc"}
	p.flows = map[string]*oidcFlow{}
	for i := 0; i < oidcMaxFlows; i++ {
		p.flows[fmt.Sprintf("s%d", i)] = &oidcFlow{verifier: "v", nonce: "n", createdAt: time.Now()}
	}
	if _, err := p.AuthURL("new-state", ""); err == nil {
		t.Fatal("流程表满时仍接受新流程(会驱逐真人在途流程)")
	} else if !strings.Contains(err.Error(), "in-flight") {
		t.Fatalf("错误类型不对: %v", err)
	}
}

// 保留断言:出站 client 必须装护栏(元数据拦截)。
func TestAuditFixOIDCOutboundClientGuardsMetadata(t *testing.T) {
	if oidcOutboundClient.Transport == nil {
		t.Fatal("OIDC 出站 client 未装 SafeOutboundTransport")
	}
	if err := util.CheckOutboundTarget(t.Context(), "169.254.169.254"); err == nil {
		t.Fatal("护栏未拦截 metadata 地址")
	}
}

// P2-2:管理会话的 cookie 值只以 SHA-256 入库(库读面拿不到可用会话)。
func TestAuditFixAdminSessionStoresOnlyHash(t *testing.T) {
	db := mustDB(t)
	uid, err := createUserDB(db, "boss", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if csrf == "" {
		t.Fatal("empty csrf")
	}
	var bySecret int
	if err := db.QueryRow(`SELECT COUNT(*) FROM admin_sessions WHERE id = ?`, sess.ID).Scan(&bySecret); err != nil {
		t.Fatal(err)
	}
	if bySecret != 0 {
		t.Fatal("cookie 值仍以明文作为行主键入库(P2-2 未修)")
	}
	var byHash int
	if err := db.QueryRow(`SELECT COUNT(*) FROM admin_sessions WHERE secret_hash = ?`, sessionSecretHash(sess.ID)).Scan(&byHash); err != nil {
		t.Fatal(err)
	}
	if byHash != 1 {
		t.Fatalf("按哈希查不到会话行: %d", byHash)
	}
	// 校验/删除仍按 cookie 值工作
	if _, err := ValidateAdminSession(db, sess.ID); err != nil {
		t.Fatalf("按 cookie 校验失败: %v", err)
	}
	if err := DeleteAdminSession(db, sess.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := ValidateAdminSession(db, sess.ID); err == nil {
		t.Fatal("删除后仍能校验通过")
	}
}

// P2-9:外部身份按 IdP 主体绑定;同名但不同主体必须拒绝(不静默接管)。
func TestAuditFixExternalIdentityIsBoundToSubject(t *testing.T) {
	db := mustDB(t)
	base := UserInfo{Username: "zhang", Source: "external", ExternalID: "sub-1", ExternalSource: "oidc", GroupsPresent: true}
	u1, err := provisionUser(db, base)
	if err != nil {
		t.Fatal(err)
	}
	if u1.ExternalID != "sub-1" || u1.ExternalSource != "oidc" {
		t.Fatalf("首次登录未绑定主体: %+v", u1)
	}
	// 同名同主体 → 正常登录
	if _, err := provisionUser(db, base); err != nil {
		t.Fatalf("同主体再登录被拒: %v", err)
	}
	// 同名不同主体 → 拒绝(这是 P2-9 的核心:旧实现直接复用整行)
	evil := base
	evil.ExternalID = "sub-999"
	if _, err := provisionUser(db, evil); err == nil {
		t.Fatal("同名不同 IdP 主体被接受 → 外部身份互相接管(P2-9 未修)")
	}
	// 外部身份仍不得接管本地账号
	if _, err := createUserDB(db, "localuser", "pw123456", false); err != nil {
		t.Fatal(err)
	}
	if _, err := provisionUser(db, UserInfo{Username: "localuser", Source: "external", ExternalID: "sub-x"}); err == nil {
		t.Fatal("外部身份接管了本地账号行")
	}
}

// P2-9:OIDC 未下发 groups claim 时不得清空既有组(否则会删掉 LDAP 同步的组)。
func TestAuditFixGroupsOnlySyncedWhenClaimPresent(t *testing.T) {
	db := mustDB(t)
	// 先建一个已绑定且有组的用户
	ui := UserInfo{Username: "li", Source: "external", ExternalID: "sub-7", ExternalSource: "ldap", GroupsPresent: true, Groups: []string{"rd"}}
	u, err := provisionUser(db, ui)
	if err != nil {
		t.Fatal(err)
	}
	groups, err := serverstore.UserGroups(db, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) != 1 || groups[0] != "rd" {
		t.Fatalf("初始组 = %v", groups)
	}
	// 同主体、group claim 缺失(如 OIDC 未下发)→ 组必须保留
	if _, err := provisionUser(db, UserInfo{Username: "li", Source: "external", ExternalID: "sub-7", ExternalSource: "oidc", GroupsPresent: false}); err != nil {
		t.Fatal(err)
	}
	if groups, _ = serverstore.UserGroups(db, u.ID); len(groups) != 1 {
		t.Fatalf("groups claim 缺失时组被清空: %v(会误删另一套 IdP 同步的组)", groups)
	}
	// 明确下发空组 → 回收(空组即回收语义保留)
	if _, err := provisionUser(db, UserInfo{Username: "li", Source: "external", ExternalID: "sub-7", ExternalSource: "ldap", GroupsPresent: true, Groups: nil}); err != nil {
		t.Fatal(err)
	}
	if groups, _ = serverstore.UserGroups(db, u.ID); len(groups) != 0 {
		t.Fatalf("明确空组时未回收: %v", groups)
	}
}

// P2-7:LDAP 拨号同样做连接期 IP 复检(metadata/链路本地必须拒绝)。
func TestAuditFixLDAPDialGuardsMetadata(t *testing.T) {
	p := &LDAPProvider{ServerURL: "ldap://169.254.169.254:389", BaseDN: "dc=x"}
	if _, err := p.dialConn(); err == nil {
		t.Fatal("LDAP 拨号未拦截云 metadata 地址")
	}
	if _, err := (&LDAPProvider{ServerURL: "not-a-url", BaseDN: "dc=x"}).dialConn(); err == nil {
		t.Fatal("畸形 server_url 未拒绝")
	}
}
