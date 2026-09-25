package serverauth

// R15C-R-01（审计 2026-09-25，P1）：`api_tokens` 没有回收者 + 管理面令牌列表
// 全量返回。
//
// 事实链（审计实测，见 temp/r15C 报告）：
//   - 每次员工登录都 `IssueToken` → `INSERT` 一条 90 天有效令牌（不去重、不轮换），
//     成功登录还会清空失败预算 ⇒ 行由任何持证员工自造且**不限次**（实测 9.0 次/秒 ×
//     32 线程，外推 77.6 万行/天）；
//   - 全仓只有 `DELETE … WHERE user_id = ?`（改密/禁用/删用户）三处，**没有一处按
//     expires_at** —— 0031 建好的 `idx_tokens_expires` 实测 `idx_scan=0`；
//   - 管理面 `GET /users/:id/tokens` 的 SQL 无 LIMIT、handler 全量 JSON、webadmin
//     整个数组进 React state ⇒ 1,001,883 行时单请求 **137 MB**、在飞堆 +656 MB、
//     3 并发 1.5 GB。
//
// 本文件钉两条判据：
//   1) 登录路径顺带回收**已过期**行（与 admin_session 的 C-15 同形）；
//   2) 列表**有界返回**且把"还有更多"如实披露（total / truncated）——不静默截断。
//
// 变异方向：删掉 `IssueToken` 里的 `PurgeExpiredTokens` 调用 ⇒ 用例 1 必红；
// 把 `ListTokensByUser` 的 `LIMIT ?` 去掉（或放大）⇒ 用例 2 必红。

import (
	"database/sql"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/serverstore"
)

func TestR15CIssueTokenPurgesExpiredRows(t *testing.T) {
	r, db, cleanup := newTestAPI(t)
	defer cleanup()
	createUser(t, db, "r15c-tok", "pw1234567890", false)
	u, err := serverstore.GetUserByUsername(db, "r15c-tok")
	if err != nil {
		t.Fatal(err)
	}

	// 3 条早已过期的令牌 + 1 条仍然有效的令牌。
	seed := func(hash string, expiresAt time.Time) {
		t.Helper()
		if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at, created_at)
			VALUES (?, ?, 'probe', ?, now())`, u.ID, hash, expiresAt.UTC().Format(time.RFC3339)); err != nil {
			t.Fatalf("seed token: %v", err)
		}
	}
	for i := 0; i < 3; i++ {
		seed(fmt.Sprintf("expired-%d", i), time.Now().Add(-time.Duration(i+1)*24*time.Hour))
	}
	seed("still-valid", time.Now().Add(24*time.Hour))

	countExpired := func() int {
		t.Helper()
		var n int
		if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ? AND expires_at < now()`, u.ID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	if got := countExpired(); got != 3 {
		t.Fatalf("前置夹具不对：过期行=%d（期望 3）", got)
	}

	// 一次普通登录（= IssueToken）。
	_ = loginToken(t, r, "r15c-tok", "pw1234567890")

	if got := countExpired(); got != 0 {
		t.Errorf("登录没有回收过期令牌：仍剩 %d 条（回归形态：表无界增长，列表把它全量搬进内存）", got)
	}
	var valid, total int
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ? AND token_hash = 'still-valid'`, u.ID).Scan(&valid); err != nil {
		t.Fatal(err)
	}
	if valid != 1 {
		t.Errorf("回收误删了未过期的令牌（still-valid 行=%d）", valid)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, u.ID).Scan(&total); err != nil {
		t.Fatal(err)
	}
	if total != 2 { // still-valid + 本次登录签发的那条
		t.Errorf("回收后总行数=%d（期望 2：1 条未过期 + 1 条新签发）", total)
	}
}

func TestR15CListUserTokensIsBoundedAndDisclosesTotal(t *testing.T) {
	r, db := adminRouter(t)
	ensureTestMasterKey(t)
	hdr, uid := adminSessionHeaders(t, db, "boss")

	// 灌入远超上限的令牌行（模拟"多年无回收"的等价量级；这里只到 600 行，
	// 判据是"返回值有界 + 如实披露"，与行数规模无关）。
	const seeded = 600
	for i := 0; i < seeded; i++ {
		if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at, created_at)
			VALUES (?, ?, 'probe', now() + interval '90 days', now())`, uid, fmt.Sprintf("r15c-hash-%06d", i)); err != nil {
			t.Fatalf("seed token %d: %v", i, err)
		}
	}
	// ① 存储面判据（本半句的判据，与 HTTP 路由形态解耦）：固定上限的单页视图
	//    必须**恰好**给出上限条、报出总行数、且最近的在前。
	tokens, total, err := serverstore.ListTokensByUser(db, uid, serverstore.TokenListMax)
	if err != nil {
		t.Fatalf("ListTokensByUser: %v", err)
	}
	if len(tokens) != serverstore.TokenListMax {
		t.Errorf("单页视图返回 %d 条（期望有界在 %d 条；无 LIMIT 时会返回全部 %d 条）",
			len(tokens), serverstore.TokenListMax, seeded)
	}
	if total != seeded {
		t.Errorf("total=%d（期望 %d —— 截断必须能算出还剩多少）", total, seeded)
	}
	maxID := uidMaxTokenID(t, db, uid)
	if len(tokens) > 0 && tokens[0].ID != maxID {
		t.Errorf("首条令牌 id=%d ≠ 最大 id %d（应当最近的在前）", tokens[0].ID, maxID)
	}

	// ② HTTP 面判据：无论生产入口是"固定单页"还是"page/size 分页"，响应体都必须
	//    **有界**（这里放宽到"不超过存储层上限"，把具体分页契约留给分页那一半），
	//    且响应字节远小于"全量返回"的量级。修复前 600 行 ≈ 80 KB 全量返回；
	//    这里断言的是"不随总行数线性增长"的形状。
	w, out := doAdmin(t, r, "GET", fmt.Sprintf("/api/server/admin/users/%d/tokens", uid), "", hdr)
	if w.Code != http.StatusOK {
		t.Fatalf("tokens: %d %s", w.Code, w.Body.String())
	}
	got, _ := out["tokens"].([]any)
	if len(got) > serverstore.TokenListMax {
		t.Errorf("HTTP 列表返回 %d 条 > 上限 %d（无界返回；修复前实测 1,001,883 行 → 137 MB）",
			len(got), serverstore.TokenListMax)
	}
	if len(got) == 0 {
		t.Errorf("HTTP 列表返回 0 条（夹具灌了 %d 条）", seeded)
	}
	if total, ok := out["total"].(float64); ok && int(total) != seeded {
		t.Errorf("HTTP total=%v（期望 %d）", out["total"], seeded)
	}
}

func uidMaxTokenID(t *testing.T, db *sql.DB, uid int64) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow(`SELECT COALESCE(MAX(id),0) FROM api_tokens WHERE user_id = ?`, uid).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
