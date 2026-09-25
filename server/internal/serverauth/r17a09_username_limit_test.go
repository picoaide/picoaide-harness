package serverauth

// R17A-09（审计 2026-09-25，P3）：用户名长度上限**两端必须同源**。
//
// 缺陷形态：`util.EscapeControlLimit(username, 128)`（R16C-04 给审计行加的字节上限）
// 对 >128 字节的用户名**静默截断**（探针实测 143 → 128），而 128 上限此前只在
// **登录**路径（本包 login 的凭据长度闸），**建号路径没有**（admin 建号只判非空；
// LDAP/OIDC provision 也没有）⇒ `audit_logs.username` 与 `users.username` 不再
// 逐字相等（按用户名筛选/对账会漏），且库里会出现一个**永远登不进来**的账号。
//
// 修法：上限收敛到唯一真源 `serverstore.MaxUsernameBytes`，写入侧在 DAO 的**唯一**
// 建号入口（CreateUser）拒绝 ⇒ 覆盖全部建号路径（管理端 / LDAP-OIDC provision /
// bootstrap-admin / 内部工具）。
//
// 判据（本文件）：
//  1. 143 字节用户名走管理端建号 ⇒ 400（修前 = 201 且库里真有一行）；
//  2. 上限内（含恰好 128 字节）⇒ 201，且**审计行里的 username 与 users.username
//     逐字相等**（= 转义函数不发生截断，这正是这条缺陷要保住的不变量）；
//  3. 登录侧同一上限：129 字节用户名 ⇒ 400「用户名或密码过长」（与建号同值）。

import (
	"database/sql"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/util"
)

// longUsername 造一个恰好 n 字节的合法用户名（ASCII，避开转义面）。
func longUsername(n int) string {
	const base = "user-"
	if n <= len(base) {
		return base[:n]
	}
	return base + strings.Repeat("a", n-len(base))
}

// waitForAuditDetail 轮询等审计行落地并返回 detail。
//
// 必须轮询而不是固定 sleep：审计走**异步批处理 worker**（serverstore.auditWorker，
// 攒批 2ms/20 条后提交），固定 sleep 在 CI 负载下会先于落盘完成（本仓已两次踩过）。
//
// 注意列语义：`user_create` 的 **username 列是操作者（管理员）**，被创建的用户名在
// **detail** 列 —— 所以这条判据查 detail 而不是 username 列。
func waitForAuditDetail(t *testing.T, db *sql.DB, action, detail string) string {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		var got string
		err := db.QueryRow(
			`SELECT detail FROM audit_logs WHERE action = ? AND detail = ? ORDER BY id DESC LIMIT 1`,
			action, detail).Scan(&got)
		if err == nil {
			return got
		}
		if err != sql.ErrNoRows {
			t.Fatalf("读审计行: %v", err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("15s 内没有等到 action=%s detail=%d字节 的审计行", action, len(detail))
	return ""
}

func TestAdminCreateUserRejectsOverlongUsername(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	// 143 字节：修前 201（且库里真的多一行，而那一行永远登不进来）。
	long := longUsername(143)
	if len(long) != 143 {
		t.Fatalf("夹具长度 = %d, want 143", len(long))
	}
	w, out := doJSON(t, r, "POST", "/api/server/admin/users",
		fmt.Sprintf(`{"username":%q,"password":"pw12345678"}`, long), hdr)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("超长用户名建号 status = %d %s, want 400（修前 = 201）", w.Code, w.Body.String())
	}
	if code, _ := out["error"].(map[string]any)["code"].(string); code != "VALIDATION" {
		t.Fatalf("error.code = %q, want VALIDATION", code)
	}
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM users WHERE username = ?`, long).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("超长用户名仍然落库 %d 行（审计行会被截断、账号永远登不进来）", n)
	}
}

func TestAdminCreateUserAcceptsBoundaryUsernameAndAuditMatches(t *testing.T) {
	r, db := adminRouter(t)
	defer db.Close()
	hdr := adminSession(t, r)

	for _, n := range []int{serverstore.MaxUsernameBytes - 1, serverstore.MaxUsernameBytes} {
		name := longUsername(n)
		w, _ := doJSON(t, r, "POST", "/api/server/admin/users",
			fmt.Sprintf(`{"username":%q,"password":"pw12345678"}`, name), hdr)
		if w.Code != http.StatusCreated {
			t.Fatalf("%d 字节用户名 status = %d %s, want 201", n, w.Code, w.Body.String())
		}
		// 不变量：审计转义对**上限内**的用户名逐字原样 —— 审计行的 username 与
		// users.username 必须相等（这正是 R17A-09 打掉的那条）。
		if got := util.EscapeControlLimit(name, serverstore.MaxUsernameBytes); got != name {
			t.Fatalf("%d 字节用户名被审计转义改写（%d → %d 字节）", n, len(name), len(got))
		}
		var stored string
		if err := db.QueryRow(`SELECT username FROM users WHERE username = ?`, name).Scan(&stored); err != nil {
			t.Fatalf("%d 字节用户名没有落库: %v", n, err)
		}
		if stored != name {
			t.Fatalf("库中用户名被改写: %d → %d 字节", len(name), len(stored))
		}
		// 审计行里的用户名（detail 列）必须与 users.username 逐字相等 —— 修复前
		// 写入侧没有长度闸，143 字节的账号会落库，而**证据面**（llmgateway 的准入
		// 拒绝记录走 EscapeControlLimit(...,128)）只留 128 字节 ⇒ 两个面对不上。
		auditDetail := waitForAuditDetail(t, db, "user_create", name)
		if auditDetail != stored {
			t.Fatalf("审计行里的用户名与 users.username 不再逐字相等: audit=%d字节 user=%d字节", len(auditDetail), len(stored))
		}
	}
}

// 登录侧与建号侧同值：129 字节 ⇒ 登录 400（这条修前就有，钉的是"上限没有被
// 修复单方面改动"——改任一侧而不同步另一侧即红）。
func TestLoginRejectsOverlongUsernameAtSameBound(t *testing.T) {
	r, _, cleanup := newTestAPI(t)
	defer cleanup()

	for _, n := range []int{serverstore.MaxUsernameBytes, serverstore.MaxUsernameBytes + 1} {
		name := longUsername(n)
		w, _ := doJSON(t, r, "POST", "/api/client/v2/auth/login",
			fmt.Sprintf(`{"username":%q,"password":"pw12345678"}`, name), nil)
		if n > serverstore.MaxUsernameBytes {
			if w.Code != http.StatusBadRequest {
				t.Fatalf("%d 字节用户名登录 status = %d, want 400", n, w.Code)
			}
			continue
		}
		// 上限内：不是被长度闸拦下的（401 用户名/密码错），证明闸门位置正确。
		if w.Code == http.StatusBadRequest {
			t.Fatalf("%d 字节用户名被登录长度闸误拦（应只拦 > %d 字节）", n, serverstore.MaxUsernameBytes)
		}
	}
}

// DAO 层（唯一写入口）：>128 字节一律 ErrUsernameTooLong，与调用方无关。
func TestCreateUserRejectsOverlongUsernameAtDAO(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	_ = r

	if _, err := serverstore.CreateUser(db, &serverstore.User{
		Username: longUsername(serverstore.MaxUsernameBytes), Source: "external", Status: 1,
	}); err != nil {
		t.Fatalf("恰好 %d 字节应被接受: %v", serverstore.MaxUsernameBytes, err)
	}
	_, err := serverstore.CreateUser(db, &serverstore.User{
		Username: longUsername(serverstore.MaxUsernameBytes + 1), Source: "external", Status: 1,
	})
	if err != serverstore.ErrUsernameTooLong {
		t.Fatalf(">%d 字节 err = %v, want ErrUsernameTooLong", serverstore.MaxUsernameBytes, err)
	}
}
