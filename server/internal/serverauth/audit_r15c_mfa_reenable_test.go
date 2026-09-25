package serverauth

// R15C-02（审计 2026-09-25，P1）：已开启 MFA 的管理员只凭主密码就能把既有
// TOTP 密钥**换掉**。
//
// 形态：enableMyMFA 原先只校验「source=local + 主密码」，没有 `u.TotpEnabled`
// 判定；与之对称的 disableMyMFA 既有 `if !u.TotpEnabled` 又要求主密码 + 动态码
// **双验**（决策 2026-09-04）。于是"移除/替换第二因子"这个**更强的动作**被
// **更弱的闸门**守着：拿到管理员密码（钓鱼/复用）的人不必知道当前动态码，就能
// 把第二因子换成自己的验证器（旧验证器立即失效、其他会话被踢）。
//
// 触发面在 webadmin：`GET /me/mfa` 失败时把"未知"谎报成"未开启"并摆出「开启」
// 按钮（同轮 R15C-W-01）—— 管理员照常操作即自伤。
//
// 本文件钉两条判据：
//   1) 已开启后再次 enable（只给主密码）必须**非 200**，且密钥一字不变；
//   2) 写入侧的不变量：陈旧 enable 挑战到达 verify 时不得覆盖已登记的密钥
//      （`SetUserMFA` 的 UPDATE 自带 `totp_enabled = 0` 谓词）。

import (
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// startEnable 走 enable 第一步（主密码 → secret + ticket）。
func startEnable(t *testing.T, r http.Handler, hdr map[string]string, password string) (string, string) {
	t.Helper()
	w, out := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/enable", fmt.Sprintf(`{"password":%q}`, password), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", w.Code, w.Body.String())
	}
	secret, _ := out["secret"].(string)
	ticket, _ := out["ticket"].(string)
	if secret == "" || ticket == "" {
		t.Fatalf("enable response missing secret/ticket: %v", out)
	}
	return secret, ticket
}

// completeEnable 走完 enable 第二步（动态码 → enabled=1）。
func completeEnable(t *testing.T, r http.Handler, hdr map[string]string, secret, ticket string) {
	t.Helper()
	w, _ := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/verify",
		fmt.Sprintf(`{"ticket":%q,"code":%q}`, ticket, genTOTPCodeFor(t, secret)), hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("verify: %d %s", w.Code, w.Body.String())
	}
}

func TestR15CEnableMyMFARejectsAlreadyEnabled(t *testing.T) {
	advance := useFakeTOTPClock(t)
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	hdr, uid := adminSessionHeaders(t, db, "boss")

	// 1) 正常开启一次，得到第一把密钥（S1）。
	secret1, ticket1 := startEnable(t, r, hdr, "pw123456")
	advance()
	completeEnable(t, r, hdr, secret1, ticket1)
	u, err := serverstore.GetUserByID(db, uid)
	if err != nil || !u.TotpEnabled || u.TotpSecret == "" {
		t.Fatalf("MFA 未持久化: %+v err=%v", u, err)
	}
	cipher1 := u.TotpSecret

	// 对照（现状即如此）：更强的动作 disable 只给主密码 → 401。
	w, _ := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/disable", `{"password":"pw123456"}`, hdr)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("对照失效：disable 只给主密码返回 %d（期望 401）", w.Code)
	}

	// 2) 已开启后再 enable（只给主密码）→ 必须被拒。
	w, out := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/enable", `{"password":"pw123456"}`, hdr)
	if w.Code == http.StatusOK {
		t.Fatalf("R15C-02 未修：已开启 MFA 仍可用主密码换取新密钥（200，下发 secret=%v）", out["secret"])
	}
	if w.Code != http.StatusConflict {
		t.Fatalf("期望 409（MFA_ALREADY_ENABLED），实得 %d %s", w.Code, w.Body.String())
	}
	if code := errCode(t, out); code != "MFA_ALREADY_ENABLED" {
		t.Fatalf("期望错误码 MFA_ALREADY_ENABLED，实得 %q（%s）", code, w.Body.String())
	}
	if _, handed := out["secret"]; handed {
		t.Fatalf("被拒的 enable 不得下发新密钥: %v", out)
	}

	// 3) 既有密钥一字不变。
	u2, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u2.TotpSecret != cipher1 || !u2.TotpEnabled {
		t.Fatalf("既有 TOTP 密钥被改写: %q → %q (enabled=%v)", cipher1, u2.TotpSecret, u2.TotpEnabled)
	}

	// 4) 旧验证器仍然可用（第二步登录用 S1 的动态码）。
	w, out = doAdmin(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK || out["mfa_required"] != true {
		t.Fatalf("login: %d %v", w.Code, out)
	}
	mfaTicket, _ := out["mfa_ticket"].(string)
	advance()
	w, out = doAdmin(t, r, "POST", "/api/server/admin/login/mfa",
		fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, mfaTicket, genTOTPCodeFor(t, secret1)), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("旧验证器失效（期望 200，实得 %d %s）", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Header().Get("Set-Cookie"), sessionCookieName+"=") {
		t.Fatalf("第二步登录未下发会话 Cookie: %v", w.Header())
	}
}

// TestR15CVerifyMyMFARejectsStaleTicketAfterEnabled 钉住**写入侧**的不变量：
// 挑战是「未开启」时签发的，等它到达 verify 时该账号已经开启了 MFA —— 此时
// 绝不能覆盖已登记的密钥（并发双开 / 陈旧 ticket 的确定性复现）。
//
// 判据强度：先拿 T1（此时未开启），再拿 T2 并正常开启（S2），最后用 T1 的码
// 去 verify —— 必须被拒且 S2 一字不变。修前这里会返回 200 且密钥被换成 S1。
func TestR15CVerifyMyMFARejectsStaleTicketAfterEnabled(t *testing.T) {
	advance := useFakeTOTPClock(t)
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	hdr, uid := adminSessionHeaders(t, db, "boss")

	secret1, ticket1 := startEnable(t, r, hdr, "pw123456") // 陈旧挑战：签发时未开启
	advance()
	secret2, ticket2 := startEnable(t, r, hdr, "pw123456")
	advance()
	completeEnable(t, r, hdr, secret2, ticket2) // 正常开启（S2）

	u, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	cipher2 := u.TotpSecret
	if u.TotpSecret == "" || !u.TotpEnabled {
		t.Fatalf("前置未达成：MFA 未开启 %+v", u)
	}

	// 陈旧挑战到达 verify。
	advance()
	w, out := doAdmin(t, r, "POST", "/api/server/admin/me/mfa/verify",
		fmt.Sprintf(`{"ticket":%q,"code":%q}`, ticket1, genTOTPCodeFor(t, secret1)), hdr)
	if w.Code == http.StatusOK {
		t.Fatalf("陈旧 enable 挑战覆盖了已登记的密钥（200）: %v", out)
	}
	if w.Code != http.StatusConflict {
		t.Fatalf("期望 409，实得 %d %s", w.Code, w.Body.String())
	}
	u2, err := serverstore.GetUserByID(db, uid)
	if err != nil {
		t.Fatal(err)
	}
	if u2.TotpSecret != cipher2 {
		t.Fatalf("写入侧守卫缺失：密钥被陈旧挑战改写 %q → %q", cipher2, u2.TotpSecret)
	}
	// 账户必须仍能用 S2 登录第二步（证明"被拒"没有把已开启的账号弄坏）。
	w, out = doAdmin(t, r, "POST", "/api/server/admin/login", `{"username":"boss","password":"pw123456"}`, nil)
	if w.Code != http.StatusOK || out["mfa_required"] != true {
		t.Fatalf("login: %d %v", w.Code, out)
	}
	mfaTicket, _ := out["mfa_ticket"].(string)
	advance()
	w, _ = doAdmin(t, r, "POST", "/api/server/admin/login/mfa",
		fmt.Sprintf(`{"mfa_ticket":%q,"code":%q}`, mfaTicket, genTOTPCodeFor(t, secret2)), nil)
	if w.Code != http.StatusOK {
		t.Fatalf("开启后的密钥不可用: %d %s", w.Code, w.Body.String())
	}
}

// errCode 从错误信封里取 error.code（测试助手）。
func errCode(t *testing.T, out map[string]any) string {
	t.Helper()
	env, ok := out["error"].(map[string]any)
	if !ok {
		return ""
	}
	code, _ := env["code"].(string)
	return code
}
