package serverstore

// 令牌列表的**分页**读取面（R15C-R-01 ②，审计 2026-09-25，P1）。
//
// 与同包的 `ListTokensByUser(db, userID, limit)`（只取"最近 N 条"、无偏移）的分工：
//   - `ListTokensByUser`   —— 兼容/测试镜像树入口，固定上限的单页视图；
//   - `ListTokensByUserPage` —— 生产管理端入口（`serverauth.listUserTokensPaged`），
//     带 `?page=&size=`、返回总数，可翻页。
//
// 两者的**共同不变量**（也是本条审计的核心）：无论调用方要多少，返回的行数都有硬
// 上限（`TokenListMaxPageSize` / `TokenListMax`），SQL 一定带 LIMIT ⇒ 单次响应体与
// 进程堆不再随 `api_tokens` 总行数线性增长（修复前实测 1,001,883 行 → 单请求
// 137,148,812 B / 堆 +656 MB / 3 并发 1,585.9 MB）。
//
// 单独成文件的原因：`tokens.go` 正被另一条修复泳道并发修改（R15C-R-01 的另一半），
// 把新增读取面放在新文件里可以让两边的改动互不覆盖（本仓共享工作树的既有纪律：
// 并发写者各自落在不同文件，冲突在评审时按语义收口）。

import "database/sql"

// TokenListDefaultPageSize 是管理端令牌列表的**缺省**页大小（不带 ?size= 时）。
const TokenListDefaultPageSize = 50

// TokenListMaxPageSize 是管理端令牌列表允许的**最大**页大小：`?size=` 超过它即 400
// （见 serverauth.parseTokenPageQuery —— 本端点此前没有分页参数，越界取值只可能是
// 写错或试图要一个超大页，而后者正是本条的放大面，必须显式拒绝而不是静默钳制）。
//
// 取值 200：一页 200 条的响应体约 27 KiB（实测 134 B/条），比修复前的 130 MiB 小
// 四个数量级，同时足够运维定位"哪台设备在登"。
const TokenListMaxPageSize = 200

// ListTokensByUserPage 返回某用户令牌的**一页**（id 倒序）与该用户令牌总数。
//
// 防御性收敛（即便 handler 已校验）：limit 落到 [1, TokenListMaxPageSize]，
// offset 不为负 —— 保证任何调用方都拿不到无界结果。
//
// 走 `idx_tokens_user`（0002 建）+ `ORDER BY id DESC LIMIT/OFFSET`：排序在 PG 内
// 是 top-N heapsort（内存有界，实测 100,500 行时 25 kB，而修复前的无 LIMIT 形态是
// 3,073 kB quicksort 且随行数线性增长）。再加 `(user_id, id DESC)` 复合索引可以让
// 计划退化成"索引上取满一页即停"（连堆扫描都省掉），但那需要新迁移 + 同步
// `server/AGENTS.md` 的迁移区间行；本泳道不改那个文件，故留作后续优化（见报告
// "诚实边界"）。
func ListTokensByUserPage(db *sql.DB, userID int64, limit, offset int) ([]Token, int64, error) {
	if limit < 1 {
		limit = TokenListDefaultPageSize
	}
	if limit > TokenListMaxPageSize {
		limit = TokenListMaxPageSize
	}
	if offset < 0 {
		offset = 0
	}
	var total int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE user_id = ?`, userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query(`SELECT id, user_id, token_hash, name, created_at, expires_at, last_used_at, revoked
		FROM api_tokens WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`, userID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var expiresAt, lastUsed sql.NullTime
		var createdAny any
		if err := rows.Scan(&t.ID, &t.UserID, &t.TokenHash, &t.Name, &createdAny, &expiresAt, &lastUsed, &t.Revoked); err != nil {
			return nil, 0, err
		}
		t.CreatedAt = formatTimeString(createdAny)
		if expiresAt.Valid {
			t.ExpiresAt = expiresAt.Time
		}
		if lastUsed.Valid {
			t.LastUsedAt = lastUsed.Time
		}
		t.TokenHash = "" // never expose the hash in listings
		out = append(out, t)
	}
	return out, total, rows.Err()
}

// CountExpiredTokens 返回当前已过期令牌行数（运维读数 / 判据用）。
//
// 走 `idx_tokens_expires`（0031 建）—— 与 PurgeExpiredTokens 同一访问路径，
// 不做全表扫描：这条查询的意义是让"还有多少该被回收的行"成为可观测事实，
// 而不是只能靠"表在长"反推。
func CountExpiredTokens(db *sql.DB) (int64, error) {
	var n int64
	err := db.QueryRow(`SELECT COUNT(*) FROM api_tokens WHERE expires_at < now()`).Scan(&n)
	return n, err
}
