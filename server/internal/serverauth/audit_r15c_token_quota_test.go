package serverauth

// R15C-R-01 ③（审计 2026-09-25，P1）的判据：**员工自助签发令牌必须有配额**。
//
// 修复前的实测形态：客户端登录每次成功都签一条 90 天令牌、不去重不轮换不限次，
// 且成功登录会清空失败预算（不限次）；真 HTTP 实测 32 线程 30 s 拿到 279 次成功
// （9.0 次/秒）⇒ 77.6 万行/天。行数没有上界，与"管理端列表无分页"叠加就是
// 任何员工可单方面触发的全站 OOM 面。
//
// 判据（变异即红）：
//   - 把 issueTokenForLogin 里的 tokenIssueAllowed 去掉 ⇒ 第 21 次登录不再被拒，
//     TestR15CSelfServiceTokenIssuanceIsQuotaLimited 红（它会一直 200）。

import (
	"fmt"
	"net/http"
	"testing"
)

func TestR15CSelfServiceTokenIssuanceIsQuotaLimited(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "quota", "Quota@12345", false)
	createUser(t, db, "quota-other", "Quota@12345", false)

	login := func(username string) (int, string) {
		t.Helper()
		w, out := doJSON(t, r, "POST", "/api/client/v2/auth/login",
			fmt.Sprintf(`{"username":%q,"password":"Quota@12345"}`, username), nil)
		code := ""
		if e, ok := out["error"].(map[string]any); ok {
			code, _ = e["code"].(string)
		}
		return w.Code, code
	}

	okCount, limited := 0, 0
	for i := 0; i < tokenIssueMaxPerWindow+5; i++ {
		code, errCode := login("quota")
		switch code {
		case http.StatusOK:
			okCount++
		case http.StatusTooManyRequests:
			if errCode != "RATE_LIMITED" {
				t.Fatalf("第 %d 次登录被拒但错误码 = %q, 应为 RATE_LIMITED", i+1, errCode)
			}
			limited++
		default:
			t.Fatalf("第 %d 次登录意外状态 %d", i+1, code)
		}
	}
	if okCount != tokenIssueMaxPerWindow {
		t.Fatalf("窗口内应恰好放行 %d 次签发, 实得 %d（配额闸被拆掉时会远超此值）",
			tokenIssueMaxPerWindow, okCount)
	}
	if limited != 5 {
		t.Fatalf("超出配额的 5 次必须全部被拒, 实得 %d 次", limited)
	}

	// 配额与**被保护资源同键**（api_tokens.user_id）：另一个用户不受影响。
	if code, _ := login("quota-other"); code != http.StatusOK {
		t.Fatalf("另一个用户不应被前一个用户的配额牵连, 实得 %d", code)
	}

	// 行数确实被配额封顶（配额闸的意义就在这里：行数不再无界）。
	var rows int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens t JOIN users u ON u.id = t.user_id
		WHERE u.username = 'quota'`).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != int64(tokenIssueMaxPerWindow) {
		t.Fatalf("被拒的签发不得留行: 应 %d 行, 实得 %d", tokenIssueMaxPerWindow, rows)
	}
}

// TestR15CTokenIssueQuotaIsPerUserWindow 验证配额按用户隔离、且**成功签发**消耗
// 预算（而不是像登录失败预算那样"成功即清空"）。
func TestR15CTokenIssueQuotaIsPerUserWindow(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "qa", "Quota@12345", false)
	createUser(t, db, "qb", "Quota@12345", false)
	api := &API{DB: db}

	keyA := tokenIssueBudgetKey(db, 1)
	keyB := tokenIssueBudgetKey(db, 2)
	if keyA == keyB {
		t.Fatal("不同 user_id 的配额桶键必须不同（否则一个用户会吃掉别人的预算）")
	}
	for i := 0; i < tokenIssueMaxPerWindow; i++ {
		if !api.tokenIssueAllowed(1) {
			t.Fatalf("第 %d 次应在配额内", i+1)
		}
	}
	if api.tokenIssueAllowed(1) {
		t.Fatal("打满配额后必须拒绝（成功签发消耗预算，窗口滑出前不恢复）")
	}
	if !api.tokenIssueAllowed(2) {
		t.Fatal("用户 2 的配额必须独立")
	}
	_ = r
}
