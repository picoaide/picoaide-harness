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
//   - 只存归属与过期时刻，**不存文件内容、也不存文件名**（文件名可能含业务信息）；
//   - 未登记的文件 id 一律按"不存在"处理（404，与真的不存在同形，不泄露存在性）。
package serverstore

import (
	"database/sql"
	"errors"
	"time"
)

// RecordGatewayFile 记录一次成功的上传归属（同一 file_id 重复上传时覆盖归属，
// 上游对相同内容可能返回既有 id，此时以最后一次成功上传者为准）。
func RecordGatewayFile(db *sql.DB, fileID string, userID int64, expiresAt *time.Time) error {
	_, err := db.Exec(
		`INSERT INTO gateway_files (file_id, user_id, expires_at) VALUES (?, ?, ?)
		 ON CONFLICT (file_id) DO UPDATE SET user_id = EXCLUDED.user_id, expires_at = EXCLUDED.expires_at`,
		fileID, userID, expiresAt,
	)
	return err
}

// GatewayFileOwner 返回 file_id 的归属用户；ok=false 表示台账里没有这个文件
// （未登记 / 已被删除 / 已过期清理）。
func GatewayFileOwner(db *sql.DB, fileID string) (userID int64, ok bool, err error) {
	row := db.QueryRow(`SELECT user_id FROM gateway_files WHERE file_id = ?`, fileID)
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

// DeleteGatewayFileRow 删除归属行（上游删除成功、或已确认上游 404 时调用）。
func DeleteGatewayFileRow(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM gateway_files WHERE file_id = ?`, fileID)
	return err
}

// ListGatewayFileIDs 返回该用户登记的**未过期** file_id 集合（列表过滤用）。
func ListGatewayFileIDs(db *sql.DB, userID int64) (map[string]struct{}, error) {
	rows, err := db.Query(
		`SELECT file_id FROM gateway_files
		 WHERE user_id = ? AND (expires_at IS NULL OR expires_at > now())`,
		userID,
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
func PurgeExpiredGatewayFiles(db *sql.DB, limit int) (int64, error) {
	if limit <= 0 {
		limit = 500
	}
	res, err := db.Exec(
		`DELETE FROM gateway_files WHERE file_id IN (
		     SELECT file_id FROM gateway_files WHERE expires_at IS NOT NULL AND expires_at <= now() LIMIT ?
		 )`, limit,
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
