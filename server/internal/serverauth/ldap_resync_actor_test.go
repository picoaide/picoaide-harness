package serverauth

import (
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// FIX-07(审计 2026-09-12,CC-P1-1):LDAP 重同步 goroutine 读已回收的 *gin.Context。
//
// 缺陷形态:setAuthConfig 保存成功后在 `go func()` **内部**调
// currentAdminUsername(c)(= c.Get("admin_user")),而本函数随即 c.JSON 返回。
// gin 会把 *gin.Context 归还 sync.Pool,下一个请求拿到同一个对象并 reset()
// 之后,c.Keys 就成了**另一个请求**的键值 —— 审计条目记到别人头上,或落到
// reset() 之后的回退字面量 "admin"。
//
// 审计员实测:audit_logs action=ldap_sync 的 username="admin",而真实发起人
// 是 "boss"(attributed to the real actor = 0 ; MISATTRIBUTED = 1)。
//
// 修法:`go func()` **之前**取 `actor := currentAdminUsername(c)`,闭包只捕获
// 字符串。本测试就是行为级断言 —— 审计员特别指出 -race 系统性掩盖这类池化
// 对象逃逸,只有「真实 handler + 真实 PG + 断言 audit_logs.username」能测出来。
//
// 复现要点:
//   - 用**真实** admin router(RegisterAdminRoutes)+ 真实会话/CSRF,不用
//     手搓 gin.Context;
//   - LDAP 指向一个必然失败的地址,让 SyncDirectoryOnce 返回 error,从而走到
//     写 audit_logs 的那一行(成功路径不写审计);
//   - 发起人刻意**不是** "boss"(回退字面量是 "admin"),这样"落错人"和
//     "落到回退值"两种失真都能被抓到。
func TestLdapResyncAuditAttributesRealActor(t *testing.T) {
	// ldapTimeout 是 test-injectable 的包级变量:用黑洞监听器(accept 后不回
	// 任何数据)把 bind 卡住,goroutine 就会在 **Context 已被复用之后**才读到
	// 发起人。这正是缺陷的触发条件 —— 用快速失败的地址(connection refused)
	// goroutine 会在复用发生前就跑完,测试会"假绿"。
	oldTimeout := ldapTimeout
	ldapTimeout = 3 * time.Second
	t.Cleanup(func() { ldapTimeout = oldTimeout })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, aerr := ln.Accept()
			if aerr != nil {
				return
			}
			// 接受但永不响应:让客户端阻塞到 SetTimeout 到期。
			_ = c
		}
	}()

	ensureTestMasterKey(t)
	r, db := adminRouter(t)

	// 真实发起人:一个名为 eve 的管理员(既不是回退字面量 "admin",也不是
	// adminRouter 预建的 "boss")。
	eveID, err := createUserDB(db, "eve", "pw123456", true)
	if err != nil {
		t.Fatal(err)
	}
	sess, csrf, err := CreateAdminSession(db, eveID)
	if err != nil {
		t.Fatal(err)
	}
	hdr := map[string]string{"Cookie": sessionCookieName + "=" + sess.ID, "X-CSRF-Token": csrf}

	body := `{"mode":"ldap","enabled":"local,ldap","ldap":{` +
		`"server_url":"ldap://` + ln.Addr().String() + `","bind_dn":"cn=admin,dc=example,dc=com",` +
		`"bind_password":"pw","base_dn":"dc=example,dc=com","user_filter":"(uid=%s)","user_attr":"uid"}}`
	if w, _ := doAdmin(t, r, "PUT", "/api/server/admin/auth", body, hdr); w.Code != 200 {
		t.Fatalf("setAuthConfig status = %d (%s)", w.Code, w.Body.String())
	}

	// 后台同步被打断在 bind 上(约 3s)。立刻用**其它**管理员的会话打满请求,
	// 迫使 gin 回收并复用 *gin.Context —— 修复前 goroutine 随后读到的就是
	// 这些请求的 c.Keys(或 reset() 之后的回退字面量 "admin")。
	boss, err := serverstore.GetUserByUsername(db, "boss")
	if err != nil {
		t.Fatal(err)
	}
	bossSess, bossCSRF, err := CreateAdminSession(db, boss.ID)
	if err != nil {
		t.Fatal(err)
	}
	bossHdr := map[string]string{"Cookie": sessionCookieName + "=" + bossSess.ID, "X-CSRF-Token": bossCSRF}
	for i := 0; i < 300; i++ {
		doAdmin(t, r, "GET", "/api/server/admin/auth", "", bossHdr)
	}

	// 等异步同步超时并写出 ldap_sync 审计条目。
	var actor string
	deadline := time.Now().Add(20 * time.Second)
	for {
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM audit_logs WHERE action = 'ldap_sync'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		if n > 0 {
			if err := db.QueryRow(`SELECT username FROM audit_logs WHERE action = 'ldap_sync' ORDER BY id DESC LIMIT 1`).Scan(&actor); err != nil {
				t.Fatal(err)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("ldap_sync 审计条目未出现(同步未触发或未失败)")
		}
		time.Sleep(100 * time.Millisecond)
	}

	if actor != "eve" {
		t.Fatalf("audit_logs.username = %q, want %q —— goroutine 读到了回收后复用的 gin.Context"+
			"(修复前会落到另一个请求的用户或回退字面量 \"admin\")", actor, "eve")
	}
}

// TestNoGoroutineTouchesGinContext 是静态守卫(审计建议):禁止 serverauth
// 里任何 `go func()` 块内触碰 *gin.Context。
//
// 为什么必须静态化:这类缺陷在 `-race` 下**系统性不可见**(池化对象逃逸不是
// 数据竞争),单元测试也很难稳定复现(要恰好命中 Context 被复用)。上面的
// TestLdapResyncAuditAttributesRealActor 是行为级回归锁,本测试是结构性防线:
// 只要有人在 goroutine 里再写一次 `c.Get(...)` / `currentAdmin(c)`,立刻红。
func TestNoGoroutineTouchesGinContext(t *testing.T) {
	forbidden := []string{
		"currentAdminUsername(c)", "currentAdmin(c)",
		"c.Get(", "c.Keys", "c.Param(", "c.Query(", "c.PostForm(",
		"c.Request", "c.Writer", "c.JSON(", "c.Abort",
	}
	scanGoroutineBodies(t, "admin.go", forbidden)
}

// scanGoroutineBodies 扫描 src 里每个 `go func()` 的**函数体**(按花括号配对),
// 断言其中不出现 forbidden 片段。
func scanGoroutineBodies(t *testing.T, src string, forbidden []string) {
	t.Helper()
	data, err := os.ReadFile(src)
	if err != nil {
		t.Fatal(err)
	}
	// 先剥掉行注释再扫,避免注释里举反例("如 actor := currentAdminUsername(c)")
	// 造成假阳性。
	var kept []string
	for _, ln := range strings.Split(string(data), "\n") {
		if i := strings.Index(ln, "//"); i >= 0 {
			ln = ln[:i]
		}
		kept = append(kept, ln)
	}
	text := strings.Join(kept, "\n")
	for off := 0; ; {
		i := strings.Index(text[off:], "go func()")
		if i < 0 {
			return
		}
		start := off + i
		off = start + len("go func()")
		// 定位函数体的第一个 '{' 并按花括号配对找到结束位置。
		open := strings.IndexByte(text[off:], '{')
		if open < 0 {
			t.Fatalf("go func() at offset %d has no body", start)
		}
		bodyStart := off + open
		depth := 0
		end := -1
		for j := bodyStart; j < len(text); j++ {
			switch text[j] {
			case '{':
				depth++
			case '}':
				depth--
				if depth == 0 {
					end = j
				}
			}
			if end >= 0 {
				break
			}
		}
		if end < 0 {
			t.Fatalf("go func() at offset %d: unbalanced braces", start)
		}
		body := text[bodyStart : end+1]
		line := 1 + strings.Count(text[:start], "\n")
		for _, f := range forbidden {
			if strings.Contains(body, f) {
				t.Errorf("%s:%d: `go func()` 块内出现 %q —— gin.Context 会被 gin 回收并复用,"+
					"goroutine 里读到的是**另一个请求**的键值。必须在 go func() 之前取出需要的值(如 actor := currentAdminUsername(c))。",
					src, line, f)
			}
		}
	}
}
