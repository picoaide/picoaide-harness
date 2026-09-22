// Package serverstore — 网关 Files API 直通的归属台账 DAO（迁移 0077）。
//
// 为什么需要它：上游 DeepSeek Files API 按 **API key** 划分文件命名空间，而本平台
// 全组织共用一个上游 key ⇒ 文件天然落在同一账号下。网关若把 list/retrieve/delete
// 原样透传，任一登录员工就能列出/删除全公司的文件（审计 2026-09-22 已探针复现），
// 且上游官方客户端在配额不足时会删最旧的 `dsh-` 文件（不分上传者）——正常使用也会
// 误删他人的图片。本表记录"哪个员工上传了哪个 file_id"，网关据此做归属判定。
//
// 语义边界：
//   - 台账是**本地事实**，不是上游状态的镜像；上游删了/过期了本行可能还在，
//     由 `expires_at` 过期清理与"上游 404 时顺手删行"两个兜底收敛；
//   - **过期行允许被重新占用**（与"过期 = 不存在"同一口径）：上游若按内容去重、
//     把同一个 file_id 再发给第二个上传者，而该行已过期时，归属必须能转给新的
//     上传者；否则第二个上传者引用自己刚传的文件会 404（审计 2026-09-22 R4 N-3）。
//   - 只存归属与过期时刻，**不存文件内容、也不存文件名**（文件名可能含业务信息）；
//   - 未登记的文件 id 一律按"不存在"处理（404，与真的不存在同形，不泄露存在性）。
package serverstore

import (
	"database/sql"
	"errors"
	"strings"
	"time"
)

// RecordGatewayFile 记录一次成功的上传归属。
//
// **存活行不转手、过期行可重新占用**：
//   - 同一 file_id 再次上传（上游若对相同内容返回既有 id —— 官方文档未承诺，但要有
//     防线）而该行**仍然有效**时只刷新 `expires_at`，`user_id` 不动。"最后上传者胜"
//     是可被利用的：知道目标图片字节的人重传一次就能把归属抢走、让原主的聊天引用整体
//     404；而首次胜的失败面是第二个上传者退回 base64 内联（安全、自动恢复）。
//   - 该行**已过期**时必须允许转手，否则上游按内容去重返回同一 id 时，第二个上传者
//     引用自己刚上传的文件会被判 404（审计 2026-09-22 R4 N-3：判据与
//     `GatewayFileOwner` 的"过期 = 不存在"曾相反）。永久文件（expires_at IS NULL）
//     永不转手。
func RecordGatewayFile(db *sql.DB, fileID string, userID int64, expiresAt *time.Time) error {
	return RecordGatewayFileSize(db, fileID, userID, expiresAt, 0)
}

// RecordGatewayFileSize 同上，并记录文件字节数（管理端容量统计用；0 = 未知）。
func RecordGatewayFileSize(db *sql.DB, fileID string, userID int64, expiresAt *time.Time, sizeBytes int64) error {
	if sizeBytes < 0 {
		sizeBytes = 0
	}
	_, err := db.Exec(
		`INSERT INTO gateway_files (file_id, user_id, expires_at, size_bytes) VALUES (?, ?, ?, ?)
		 ON CONFLICT (file_id) DO UPDATE
		   SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id,
		       size_bytes = CASE WHEN EXCLUDED.size_bytes > 0 THEN EXCLUDED.size_bytes
		                         ELSE gateway_files.size_bytes END
		 WHERE gateway_files.user_id = EXCLUDED.user_id
		    OR gateway_files.expires_at <= now()`,
		fileID, userID, expiresAt, sizeBytes,
	)
	return err
}

// GatewayFileOwner 返回 file_id 的归属用户；ok=false 表示台账里没有这个**有效**文件
// （未登记 / 已被删除 / 已过期）。
//
// 过期行按"不存在"处理：上游对过期文件同样返回 404，若本地还认它是"自己的"，
// 只会让调用方拿到一个上游 404 而不是干净的"文件不存在"（口径与列表过滤一致 ——
// 审计 2026-09-22 G-6 指出两处口径曾相反）。
func GatewayFileOwner(db *sql.DB, fileID string) (userID int64, ok bool, err error) {
	row := db.QueryRow(
		`SELECT user_id FROM gateway_files
		 WHERE file_id = ? AND (expires_at IS NULL OR expires_at > now())`, fileID)
	switch err := row.Scan(&userID); {
	case errors.Is(err, sql.ErrNoRows):
		return 0, false, nil
	case err != nil:
		return 0, false, err
	}
	return userID, true, nil
}

// GatewayFileOwnedBy 判定 file_id 是否属于该用户（未登记/他人 ⇒ false）。
func GatewayFileOwnedBy(db *sql.DB, fileID string, userID int64) (bool, error) {
	owner, ok, err := GatewayFileOwner(db, fileID)
	if err != nil {
		return false, err
	}
	return ok && owner == userID, nil
}

// GatewayFilesOwnedBy 批量判定：返回 ids 中**确实属于该用户**且未过期的那些 id。
//
// 单次往返（`IN (...)` 展开）：审计 2026-09-22 F 路 P2-3 实测逐个 `GatewayFileOwnedBy`
// 在 100 个引用时约 49ms、1000 个约 113ms，全是串行 DB 往返；而请求体上限 64MiB 足够
// 塞进远多于 1000 个 `file_id`，等于把"闸门前的排队时间"交给调用方控制。调用方据此
// 把引用数压在上限内（见 llmgateway 的 `max_file_refs` 设置），本函数只负责一次问清。
func GatewayFilesOwnedBy(db *sql.DB, ids []string, userID int64) (map[string]struct{}, error) {
	owned := make(map[string]struct{}, len(ids))
	if len(ids) == 0 {
		return owned, nil
	}
	args := make([]any, 0, len(ids)+1)
	args = append(args, userID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := db.Query(
		`SELECT file_id FROM gateway_files
		 WHERE user_id = ? AND (expires_at IS NULL OR expires_at > now())
		   AND file_id IN (`+qmarks(len(ids))+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		owned[id] = struct{}{}
	}
	return owned, rows.Err()
}

// DeleteGatewayFileRow 删除归属行（上游删除成功、或已确认上游 404 时调用）。
func DeleteGatewayFileRow(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM gateway_files WHERE file_id = ?`, fileID)
	return err
}

// GatewayFile 台账的单次查询上限：官方 Files API 每账号最多 10000 个文件，
// 单个员工自己的文件只会更少；这里加 LIMIT 只是防"异常数据把整表读进内存"。
const gatewayFilesListLimit = 20000

// ListGatewayFileIDs 返回该用户登记的**未过期** file_id 集合（列表过滤用）。
func ListGatewayFileIDs(db *sql.DB, userID int64) (map[string]struct{}, error) {
	rows, err := db.Query(
		`SELECT file_id FROM gateway_files
		 WHERE user_id = ? AND (expires_at IS NULL OR expires_at > now())
		 ORDER BY created_at DESC
		 LIMIT ?`,
		userID, gatewayFilesListLimit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]struct{}{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}

// PurgeExpiredGatewayFiles 清掉已过期的归属行（上游对此类文件返回 404，
// 行留着只会让"归属判定"变成永不收敛的垃圾）。limit<=0 时取默认批量。
//
// 为什么是**两步同事务**而不是一条 `DELETE ... IN (SELECT ...)`：单语句在子查询
// 快照与删除之间留窗口 —— 并发续期（`RecordGatewayFile` 把 `expires_at` 推到未来
// 并先提交）的行会被按旧快照删掉（2026-09-22 审计确定性复现：受害者随后的聊天
// 引用该 file_id 会整体 404）。先 `SELECT ... FOR UPDATE SKIP LOCKED` 锁住候选
// （被并发事务持有行锁的直接跳过，下轮再处理），再按 id 删；同事务内持锁 ⇒
// 不可能删到刚被续期的活行。三种单语句修法（外层重述谓词 / ctid / 子查询
// `FOR UPDATE SKIP LOCKED`）经审计实测均无效，别再往那个方向改。
func PurgeExpiredGatewayFiles(db *sql.DB, limit int) (int64, error) {
	if limit <= 0 {
		limit = 500
	}
	tx, err := db.Begin()
	if err != nil {
		return 0, err
	}
	// 提交成功后 Rollback 返回 ErrTxDone，忽略即可。
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.Query(
		`SELECT file_id FROM gateway_files
		 WHERE expires_at IS NOT NULL AND expires_at <= now()
		 ORDER BY expires_at
		 LIMIT ? FOR UPDATE SKIP LOCKED`, limit,
	)
	if err != nil {
		return 0, err
	}
	ids := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	if len(ids) == 0 {
		return 0, tx.Commit()
	}
	args := make([]any, 0, len(ids))
	for _, id := range ids {
		args = append(args, id)
	}
	res, err := tx.Exec(`DELETE FROM gateway_files WHERE file_id IN (`+qmarks(len(ids))+`)`, args...)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return n, nil
}

// ---------------------------------------------------------------------------
// 管理端：网关文件的容量视图与清理（2026-09-22）
// ---------------------------------------------------------------------------

// GatewayFileRow 是管理端列表的一行（含归属员工的展示名）。
type GatewayFileRow struct {
	FileID      string     `json:"file_id"`
	UserID      int64      `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	SizeBytes   int64      `json:"size_bytes"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   *time.Time `json:"expires_at"`
	Expired     bool       `json:"expired"`
}

// GatewayFileQuery 是管理端列表的过滤/排序/分页条件。
//
// 白名单式排序键（不接受任意列名）：`created_at` / `expires_at` / `size_bytes` /
// `username`；顺序只接受 asc|desc。`UserID > 0` 时按员工过滤，`UserID < 0` 表示
// "指定的员工不存在"⇒ 恒空集，`Search` 匹配 file_id 子串（大小写不敏感），
// `OnlyExpired` / `OnlyActive` 二选一（都为假 = 全部）。
type GatewayFileQuery struct {
	UserID      int64
	Search      string
	OnlyExpired bool
	OnlyActive  bool
	Sort        string
	Desc        bool
	Offset      int
	Limit       int
}

// GatewayFileSummaryRow 是"按员工看占用"的一行。
type GatewayFileSummaryRow struct {
	UserID      int64      `json:"user_id"`
	Username    string     `json:"username"`
	DisplayName string     `json:"display_name"`
	Files       int64      `json:"files"`
	Bytes       int64      `json:"bytes"`
	Expired     int64      `json:"expired_files"`
	Earliest    *time.Time `json:"earliest_expires_at"`
}

func normalizeGatewayFileQuery(q GatewayFileQuery) GatewayFileQuery {
	switch q.Sort {
	case "created_at", "expires_at", "size_bytes", "username":
	default:
		q.Sort = "created_at"
	}
	if q.Limit <= 0 || q.Limit > 200 {
		q.Limit = 50
	}
	if q.Offset < 0 {
		q.Offset = 0
	}
	if q.OnlyExpired && q.OnlyActive {
		q.OnlyActive = false
	}
	return q
}

// gatewayFileWhere 生成列表与计数的共用 WHERE 子句与参数。
func gatewayFileWhere(q GatewayFileQuery) (string, []any) {
	where := " WHERE 1=1"
	args := []any{}
	switch {
	case q.UserID < 0:
		// 负数 = "按查不到的用户名过滤" ⇒ 恒空集（不能退化成"不过滤"，
		// 否则管理员会以为过滤生效了，实际看到的是全量）。
		where += " AND 1=0"
	case q.UserID > 0:
		where += " AND g.user_id = ?"
		args = append(args, q.UserID)
	}
	if s := strings.TrimSpace(q.Search); s != "" {
		where += " AND g.file_id ILIKE ?"
		args = append(args, "%"+escapeLike(s)+"%")
	}
	if q.OnlyExpired {
		where += " AND g.expires_at IS NOT NULL AND g.expires_at <= now()"
	}
	if q.OnlyActive {
		where += " AND (g.expires_at IS NULL OR g.expires_at > now())"
	}
	return where, args
}

// escapeLike 转义 LIKE 通配符（用户输入里的 % _ \ 只按字面匹配）。
func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`)
	return r.Replace(s)
}

// ListGatewayFiles 分页查询台账（管理端「网关文件」页）。
func ListGatewayFiles(db *sql.DB, q GatewayFileQuery) ([]GatewayFileRow, int64, error) {
	q = normalizeGatewayFileQuery(q)
	where, args := gatewayFileWhere(q)
	var total int64
	if err := db.QueryRow(`SELECT count(*) FROM gateway_files g`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	order := q.Sort
	dir := "ASC"
	if q.Desc {
		dir = "DESC"
	}
	// 排序键来自白名单（normalizeGatewayFileQuery），可安全拼接。
	if order == "username" {
		order = "u.username"
	} else {
		order = "g." + order
	}
	query := `SELECT g.file_id, g.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''),
	                 g.size_bytes, g.created_at, g.expires_at,
	                 (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired
	            FROM gateway_files g LEFT JOIN users u ON u.id = g.user_id` + where +
		` ORDER BY ` + order + ` ` + dir + `, g.file_id ASC LIMIT ? OFFSET ?`
	args = append(args, q.Limit, q.Offset)
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	out := make([]GatewayFileRow, 0, q.Limit)
	for rows.Next() {
		var r GatewayFileRow
		if err := rows.Scan(&r.FileID, &r.UserID, &r.Username, &r.DisplayName,
			&r.SizeBytes, &r.CreatedAt, &r.ExpiresAt, &r.Expired); err != nil {
			return nil, 0, err
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// GatewayFileSummary 按员工汇总占用（文件数 / 字节数 / 其中已过期数 / 最早过期时刻）。
func GatewayFileSummary(db *sql.DB, sort string, desc bool) ([]GatewayFileSummaryRow, error) {
	order := "bytes"
	switch sort {
	case "files", "bytes", "username":
		order = sort
	}
	dir := "DESC"
	if !desc {
		dir = "ASC"
	}
	if order == "username" {
		order = "3"
	} else if order == "files" {
		order = "5"
	} else {
		order = "6"
	}
	rows, err := db.Query(`SELECT g.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''),
	                              count(*) AS files,
	                              COALESCE(sum(g.size_bytes), 0) AS bytes,
	                              count(*) FILTER (WHERE g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired,
	                              min(g.expires_at) AS earliest
	                         FROM gateway_files g LEFT JOIN users u ON u.id = g.user_id
	                        GROUP BY g.user_id, u.username, u.display_name
	                        ORDER BY ` + order + ` ` + dir + `, g.user_id ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []GatewayFileSummaryRow{}
	for rows.Next() {
		var r GatewayFileSummaryRow
		if err := rows.Scan(&r.UserID, &r.Username, &r.DisplayName, &r.Files, &r.Bytes, &r.Expired, &r.Earliest); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GatewayFileTotals 返回全量合计（文件数 / 字节数 / 已过期数）。
func GatewayFileTotals(db *sql.DB) (files, bytes, expired int64, err error) {
	err = db.QueryRow(`SELECT count(*), COALESCE(sum(size_bytes), 0),
	                          count(*) FILTER (WHERE expires_at IS NOT NULL AND expires_at <= now())
	                     FROM gateway_files`).Scan(&files, &bytes, &expired)
	return files, bytes, expired, err
}

// ListExpiredGatewayFiles 取一批已过期行（自动回收/管理端清理用），按过期时间升序。
func ListExpiredGatewayFiles(db *sql.DB, limit int) ([]string, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := db.Query(`SELECT file_id FROM gateway_files
	                        WHERE expires_at IS NOT NULL AND expires_at <= now()
	                        ORDER BY expires_at ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ListGatewayFilesForPurge 取一批"按条件可清理"的行（管理端按员工/状态清理用）。
func ListGatewayFilesForPurge(db *sql.DB, q GatewayFileQuery, limit int) ([]string, error) {
	q = normalizeGatewayFileQuery(q)
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	where, args := gatewayFileWhere(q)
	args = append(args, limit)
	rows, err := db.Query(`SELECT g.file_id FROM gateway_files g`+where+` ORDER BY g.created_at ASC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
