package serverauth

// S3-03 的判据（审计 2026-10-04，P2）：**被拒的登录尝试不得清空该来源 IP 的失败预算**，
// 成功登录只允许**归还自己那一格**。
//
// 缺陷现场（PRE-EXISTING，本区间的 E-01 把"判定即记账"改强后触发链变实）：
// `loginSucceeded` 同时 reset 三个桶（`ip|username`、`u:username`、**IP 桶**），而它的
// 调用点在 `handler.go` 里排在"账号已禁用 / 审计账号 / 身份冲突 / 签发失败"四个拒绝
// 分支**之前**。于是：
//
//  1. 一个**密码正确但根本登不进来**的凭证（禁用账号、审计账号）也会把该 IP 的失败
//     预算清空 —— 它们连 token 都拿不到；
//  2. 更一般地：IP 桶是 `allow`（判定即记账）的**尝试桶**，键在全出口/NAT 下共用，
//     整键清空 ⇒ 持**任一**有效凭证的人可以"59 次随机用户名错密 + 1 次自己的成功
//     登录"反复把 P1-2 的 argon2 放大防护洗掉（一名员工的正常登录也会洗掉同网段
//     所有人的失败预算）。
//
// 修法：清桶挪到"登录真的完成（账号可用 + token 已签发）"之后；IP 桶由 reset 改为
// **refund（只归还本次尝试那一格）**。两条目标同时满足：
//   - 正常用户不被误伤：成功的那一次不消耗预算（这是原先"成功即清空"要解决的问题）；
//   - 洗预算失效：成功不再把先前累积的失败抹掉，60/5min 的总量上限重新生效。
//
// 判据分四组（缺一不可）：
//   - TestRejectedLoginsDoNotClearLoginIPBudget：被拒（禁用/审计）不得清桶（原缺陷形态）；
//   - TestSuccessfulLoginDoesNotWashLoginIPBudget：成功登录后**上限仍然咬得住**
//     （把桶垫到"距上限一格"⇒ 成功一次 ⇒ 再失败一次即 429）；
//   - TestSuccessfulLoginsDoNotAccumulateInLoginIPBudget：反方向 —— 不能因为修这条
//     就把正常用户的成功登录变成"消耗预算"（同 NAT 连续成功必须不堆积）；
//   - TestAdminLoginSuccessDoesNotClearSharedLoginIPBudget：管理面**同形**（两个入口
//     共用 sharedLoginIPLimiter 与同一个键构造点，只修一侧等于没修）。

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

// loginIPBucketFor 返回某个来源 IP 在共享 IP 桶里的键（测试只用同一条键构造点）。
func loginIPBucketFor(db *sql.DB, host string) string {
	return loginIPBudgetKeyForHost(db, host)
}

// seedLoginIPFailure 直接往共享 IP 桶垫一次失败（避免为了造"距上限一格"而真跑 59 次
// argon2 校验；键与判定/记账同源）。
func seedLoginIPFailure(db *sql.DB, host string, n int) {
	lim := sharedLoginIPLimiter()
	for i := 0; i < n; i++ {
		lim.record(loginIPBucketFor(db, host))
	}
}

// TestRejectedLoginsDoNotClearLoginIPBudget 是 S3-03 的**原缺陷形态**：口令正确但
// 账号不可用（已禁用 / 审计账号）的登录尝试必须**原样保留**该 IP 的失败预算。
func TestRejectedLoginsDoNotClearLoginIPBudget(t *testing.T) {
	cases := []struct {
		name     string
		username string
		password string
		mutate   func(t *testing.T, db *sql.DB, username string)
		why      string
	}{
		{
			name: "已禁用账号", username: "disableduser", password: "pw123456",
			mutate: func(t *testing.T, db *sql.DB, username string) {
				u, err := serverstore.GetUserByUsername(db, username)
				if err != nil {
					t.Fatalf("读用户: %v", err)
				}
				u.Status = 0
				if err := serverstore.UpdateUser(db, u); err != nil {
					t.Fatalf("禁用用户: %v", err)
				}
			},
			why: "禁用账号拿不到 token，却把该 IP 的失败预算洗掉",
		},
		{
			name: "审计账号", username: "auditoruser", password: "pw123456",
			mutate: func(t *testing.T, db *sql.DB, username string) {
				u, err := serverstore.GetUserByUsername(db, username)
				if err != nil {
					t.Fatalf("读用户: %v", err)
				}
				u.Role = serverstore.RoleAuditor
				if err := serverstore.UpdateUser(db, u); err != nil {
					t.Fatalf("改角色: %v", err)
				}
			},
			why: "审计账号在员工面被显式拒绝（AUDITOR_NOT_ALLOWED），同样不该清桶",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, db, cleanup := newTestAPI(t)
			defer cleanup()
			createUser(t, db, tc.username, tc.password, false)
			tc.mutate(t, db, tc.username)

			const host = "198.51.100.11"
			const addr = host + ":41001"
			ipKey := loginIPBucketFor(db, host)

			// 前置：同 IP 先累积 3 次随机用户名的错密（这就是 IP 桶要防的 argon2 放大）。
			for i := 0; i < 3; i++ {
				if code := loginStatus(r, "ghost-"+string(rune('a'+i)), "x", addr); code != http.StatusUnauthorized {
					t.Fatalf("第 %d 次随机用户名错密 = %d, want 401", i+1, code)
				}
			}
			if got := ipBucketCount(ipKey); got != 3 {
				t.Fatalf("前置不成立：IP 桶 = %d, want 3（失败预算没有被记账）", got)
			}

			// 被拒的登录（口令正确、账号不可用）。
			if code := loginStatus(r, tc.username, tc.password, addr); code != http.StatusUnauthorized {
				t.Fatalf("%s 的正确口令登录 = %d, want 401（判据的前提坏了）", tc.name, code)
			}

			// 关键断言：桶**不得**被清空。它应当再加上本次尝试（allow 判定即记账）
			// 那一格 —— 修复前这里恒为 0（整键清空）。
			if got := ipBucketCount(ipKey); got == 0 {
				t.Fatalf("被拒的登录清空了 IP 失败预算（%s：%s）—— 持任一有效凭证即可反复洗掉 "+
					"argon2 放大的 IP 维度上限（S3-03 原缺陷形态）", tc.name, tc.why)
			}
			if got := ipBucketCount(ipKey); got != 4 {
				t.Fatalf("被拒的登录后 IP 桶 = %d, want 4（3 次失败 + 本次尝试；本次不得被归还，"+
					"因为登录没有成功）", got)
			}
			// 同族：按账号的两个桶同样不得在这条被拒路径上被清（它们是"密码对了"的证明，
			// 而这次登录被拒 ≠ 这个账号可以登录）。
			if got := bucketLen(sharedLoginLimiter(), dbLimiterScope(db)+"u:"+tc.username); got != 1 {
				t.Fatalf("被拒的登录清空了账号桶 u:%s = %d, want 1（拒绝分支不得清任何桶）", tc.username, got)
			}
		})
	}
}

// TestSuccessfulLoginDoesNotWashLoginIPBudget：成功登录只能**归还自己那一格**，
// 先前累积的失败必须原样留下 ⇒ 把桶垫到"距上限一格"后，一次成功 + 一次失败即打满，
// 下一次必须 429（修复前成功会把桶清零，上限再也咬不住）。
func TestSuccessfulLoginDoesNotWashLoginIPBudget(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "washers", "pw1234567890", false)

	const host = "198.51.100.21"
	const addr = host + ":41011"
	ipKey := loginIPBucketFor(db, host)
	seedLoginIPFailure(db, host, loginIPMaxAttempts-1)
	if got := ipBucketCount(ipKey); got != loginIPMaxAttempts-1 {
		t.Fatalf("前置不成立：IP 桶 = %d, want %d", got, loginIPMaxAttempts-1)
	}

	// 攻击者用自己**有效且可用**的凭证成功登录一次（旧实现会把桶整键清零）。
	if code := loginStatus(r, "washers", "pw1234567890", addr); code != http.StatusOK {
		t.Fatalf("有效凭证在距上限一格时被拒 = %d（限流把正常用户锁死）", code)
	}
	if got := ipBucketCount(ipKey); got == 0 {
		t.Fatalf("成功登录把 IP 桶整键清空 —— 「失败×%d + 成功×1」的循环可以把 P1-2 的 "+
			"argon2 放大防护无限洗掉（S3-03 的核心）", loginIPMaxAttempts-1)
	}
	if got := ipBucketCount(ipKey); got != loginIPMaxAttempts-1 {
		t.Fatalf("成功登录后 IP 桶 = %d, want %d（成功只归还自己那一格）", got, loginIPMaxAttempts-1)
	}

	// 上限仍然咬得住：再失败一次即打满，下一次尝试必须被 429。
	if code := loginStatus(r, "washers", "wrong-password", addr); code != http.StatusUnauthorized {
		t.Fatalf("打满前的最后一次错密 = %d, want 401", code)
	}
	if code := loginStatus(r, "washers", "wrong-password", addr); code != http.StatusTooManyRequests {
		t.Fatalf("洗预算后 IP 维度上限失效：第 %d 次尝试 = %d, want 429"+
			"（修复前成功登录已把桶清零，这里会一路 401）", loginIPMaxAttempts+1, code)
	}
}

// TestSuccessfulLoginsDoNotAccumulateInLoginIPBudget 是反方向判据：修 S3-03 不许把
// 正常用户变成"成功登录也消耗 IP 预算"（那会让同 NAT 的正常用户互相锁死 —— 这正是
// 原先"成功即清空"要解决的问题）。成功一次归还一格 ⇒ 连续成功不堆积；但先前的失败
// 仍然留着。
func TestSuccessfulLoginsDoNotAccumulateInLoginIPBudget(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "natty", "pw1234567890", false)

	const host = "203.0.113.31"
	const addr = host + ":41021"
	ipKey := loginIPBucketFor(db, host)

	// ① 起始为空：连续 5 次成功登录后桶必须仍是 0。
	for i := 0; i < 5; i++ {
		if code := loginStatus(r, "natty", "pw1234567890", addr); code != http.StatusOK {
			t.Fatalf("第 %d 次正常登录 = %d, want 200（配额/限流误伤）", i+1, code)
		}
	}
	if got := ipBucketCount(ipKey); got != 0 {
		t.Fatalf("连续成功登录在 IP 桶里累积了 %d 格 —— 同 NAT 的正常用户会互相锁死", got)
	}

	// ② 先有 3 次失败：再成功 3 次之后，那 3 次失败必须**仍在**（成功不洗别人的失败），
	//    但成功的这 3 次不额外增加。
	seedLoginIPFailure(db, host, 3)
	for i := 0; i < 3; i++ {
		if code := loginStatus(r, "natty", "pw1234567890", addr); code != http.StatusOK {
			t.Fatalf("第 %d 次正常登录 = %d, want 200", i+1, code)
		}
	}
	if got := ipBucketCount(ipKey); got != 3 {
		t.Fatalf("IP 桶 = %d, want 3（先前的失败不得被成功登录洗掉，成功也不得额外累积）", got)
	}
}

// TestAdminLoginSuccessDoesNotClearSharedLoginIPBudget：管理面**同形**回归。
//
// 两个入口共用 `sharedLoginIPLimiter()` 与同一个键构造点 `loginIPBudgetKey` ——
// 只修客户端面等于没修：任何持有效**管理员**凭证的人同样能通过 /api/server/admin/login
// 把整个出口 IP 的 argon2 预算清零（而该 IP 桶正是客户端面在用的那一个）。
func TestAdminLoginSuccessDoesNotClearSharedLoginIPBudget(t *testing.T) {
	r, db := adminRouter(t)
	const host = "198.51.100.41"
	ipKey := loginIPBucketFor(db, host)
	seedLoginIPFailure(db, host, 3)
	if got := ipBucketCount(ipKey); got != 3 {
		t.Fatalf("前置不成立：IP 桶 = %d, want 3", got)
	}

	req := httptest.NewRequest("POST", "/api/server/admin/login",
		strings.NewReader(`{"username":"boss","password":"pw123456"}`))
	req.Header.Set("Content-Type", "application/json")
	req.RemoteAddr = host + ":41031"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("管理员登录 = %d, want 200（%s）", w.Code, w.Body.String())
	}
	if got := ipBucketCount(ipKey); got != 3 {
		t.Fatalf("管理面成功登录把共享 IP 桶清成了 %d 格（want 3）—— 两个入口共用同一个桶，"+
			"只修客户端面等于没修", got)
	}
}

// TestLoginLimiterRefundRemovesExactlyOneAttempt 是 refund 的单元级边界（空桶 / 单格 /
// 多格），并钉住它**不是** reset：
func TestLoginLimiterRefundRemovesExactlyOneAttempt(t *testing.T) {
	l := &loginLimiter{
		attempts:    map[string][]time.Time{},
		maxEntries:  8,
		maxAttempts: 3,
		window:      time.Minute,
	}
	l.refund("missing") // 空桶：不得 panic、不得建键
	if got := bucketLen(l, "missing"); got != 0 {
		t.Fatalf("空桶 refund 后 = %d, want 0", got)
	}

	l.record("K")
	l.refund("K")
	if got := bucketLen(l, "K"); got != 0 {
		t.Fatalf("单格 refund 后 = %d, want 0（只剩一格时删键）", got)
	}

	l.record("K")
	l.record("K")
	l.record("K")
	l.refund("K")
	if got := bucketLen(l, "K"); got != 2 {
		t.Fatalf("三格 refund 后 = %d, want 2（只归还一格，不是 reset）", got)
	}
	// 归还后预算恢复一格：上限 3 的桶里现在 2 格，仍可再尝试一次。
	if !l.allow("K") {
		t.Fatal("refund 之后应当还能再尝试一次（归还的那一格真的还回去了）")
	}
}
