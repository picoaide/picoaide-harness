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
	_, err := db.Exec(
		`INSERT INTO gateway_files (file_id, user_id, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT (file_id) DO UPDATE
		   SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id
		 WHERE gateway_files.user_id = EXCLUDED.user_id
		    OR gateway_files.expires_at <= now()`,
		fileID, userID, expiresAt,
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
// 把引用数压在上限内（见 maxFileRefsPerRequest），本函数只负责一次问清。
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
