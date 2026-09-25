package serverstore

// R15C-R-01（审计 2026-09-25，P1）的 DAO 级判据：
//   - 分页读取面**有界**（分页函数与兼容函数都必须带 LIMIT，绝不随总行数增长）；
//   - 过期回收真的删行、且**只删过期行**（有效/已撤销未过期的行必须留下）。
//
// 变异即红：
//   - 去掉 ListTokensByUserPage 的 LIMIT ⇒ TestR15CTokenPageIsBounded 红；
//   - 去掉 PurgeExpiredTokens 的 `expires_at < now()` 谓词 ⇒
//     TestR15CPurgeExpiredTokensKeepsLiveRows 红（有效行被删）。

import (
	"fmt"
	"testing"
	"time"
)

func TestR15CTokenPageIsBounded(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "r15c-page", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO api_tokens (user_id, token_hash, name, expires_at)
		SELECT ?, 'r15c-page-' || g, 'desktop', now() + interval '90 days'
		FROM generate_series(1, 500) g`, uid); err != nil {
		t.Fatal(err)
	}

	// ① 缺省页
	page, total, err := ListTokensByUserPage(db, uid, TokenListDefaultPageSize, 0)
	if err != nil {
		t.Fatal(err)
	}
	if total != 500 {
		t.Fatalf("total = %d, want 500", total)
	}
	if len(page) != TokenListDefaultPageSize {
		t.Fatalf("缺省页应 %d 条, 实得 %d（LIMIT 被拆掉即红）", TokenListDefaultPageSize, len(page))
	}
	// ② 防御性收敛：limit 超上限必须被夹到 TokenListMaxPageSize（handler 之外的第二道闸）
	big, _, err := ListTokensByUserPage(db, uid, 1000000, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(big) != TokenListMaxPageSize {
		t.Fatalf("超大 limit 应被收敛到 %d, 实得 %d", TokenListMaxPageSize, len(big))
	}
	// ③ 兼容入口（测试镜像树用）也必须有界
	legacy, _, err := ListTokensByUser(db, uid, TokenListMax)
	if err != nil {
		t.Fatal(err)
	}
	if len(legacy) > TokenListMax {
		t.Fatalf("兼容入口返回 %d 条, 上限 %d", len(legacy), TokenListMax)
	}
	// ④ 翻页不重不漏（id 倒序）
	second, _, err := ListTokensByUserPage(db, uid, 50, 50)
	if err != nil {
		t.Fatal(err)
	}
	if len(second) != 50 {
		t.Fatalf("第二页应 50 条, 实得 %d", len(second))
	}
	if page[len(page)-1].ID <= second[0].ID {
		t.Fatalf("分页顺序断裂: 第一页最小 id=%d, 第二页最大 id=%d", page[len(page)-1].ID, second[0].ID)
	}
	// ⑤ 列表永不外泄 token_hash
	for _, tk := range append(append([]Token{}, page...), second...) {
		if tk.TokenHash != "" {
			t.Fatalf("列表泄漏了 token_hash: %q", tk.TokenHash)
		}
	}
}

func TestR15CPurgeExpiredTokensKeepsLiveRows(t *testing.T) {
	db := openTestDB(t)
	defer db.Close()
	if err := ApplyMigrations(db); err != nil {
		t.Fatal(err)
	}
	uid, err := CreateUser(db, &User{Username: "r15c-purge", Source: "local", Status: 1})
	if err != nil {
		t.Fatal(err)
	}
	// 3 条已过期 + 2 条有效（其中一条已撤销但未过期：撤销不是"可以遗忘"）
	for i := 0; i < 3; i++ {
		if _, err := CreateToken(db, uid, fmt.Sprintf("expired-%d", i), time.Now().Add(-time.Hour)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := CreateToken(db, uid, "live-1", time.Now().Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	revoked, err := CreateToken(db, uid, "live-revoked", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if err := RevokeTokenByID(db, revoked); err != nil {
		t.Fatal(err)
	}

	expiredBefore, err := CountExpiredTokens(db)
	if err != nil {
		t.Fatal(err)
	}
	if expiredBefore != 3 {
		t.Fatalf("过期行数 = %d, want 3", expiredBefore)
	}

	removed, err := PurgeExpiredTokens(db, 100)
	if err != nil {
		t.Fatal(err)
	}
	if removed != 3 {
		t.Fatalf("本轮应删 3 行（删除计数是日志与判据的口径）, 实得 %d", removed)
	}
	rows, _, err := ListTokensByUserPage(db, uid, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("有效行必须留下: 期望 2 行, 实得 %d", len(rows))
	}
	if after, _ := CountExpiredTokens(db); after != 0 {
		t.Fatalf("回收后过期行数应为 0, 实得 %d", after)
	}
	// 幂等：再跑一轮不再删任何行（判据不能靠"删过就算"）
	if again, err := PurgeExpiredTokens(db, 100); err != nil || again != 0 {
		t.Fatalf("第二轮应删 0 行, 实得 %d (err=%v)", again, err)
	}
}
