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
//
// `created_at` 语义：**行还活着**时是"首次上传时间"，续期不改写；行**已过期**时
// 这次登记等于一次全新上传（过期 = 不存在），`created_at` 必须跟着刷新 —— 否则
// 台账会把新上传的文件记成上一个归属人几十天前的上传时间，管理端显示的上传时间
// 失真，`ListGatewayFilesForPurge` 的"最旧优先"清理还会把刚上传的文件排在最前面
// （审计 2026-09-22 L1 实测：30 天前的老行被 B 重新占用后 created_at 仍是 30 天前）。
//
// `size_bytes` 语义：0 = 上游没回大小 ⇒ 保留已知值（不清零）；>0 ⇒ 覆盖。
func RecordGatewayFileSize(db *sql.DB, fileID string, userID int64, expiresAt *time.Time, sizeBytes int64) error {
	if sizeBytes < 0 {
		sizeBytes = 0
	}
	_, err := db.Exec(
		`INSERT INTO gateway_files (file_id, user_id, expires_at, size_bytes) VALUES (?, ?, ?, ?)
		 ON CONFLICT (file_id) DO UPDATE
		   SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id,
		       -- 重新登记 = 这份文件又有主了 ⇒ 必须清掉回收标记，否则回收器仍以为自己在删
		       -- 一个"没人要"的对象（审计 R7 N11 的续期侧；SQL 里少这一句就退化成
		       -- "续期后仍被回收"，判据 TestReaperAbandonsIfRenewedDuringReap 会红）。
		       reaping_at = NULL,
		       created_at = CASE WHEN gateway_files.expires_at <= now() THEN now()
		                         ELSE gateway_files.created_at END,
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

// gatewayFilesOwnedByChunk 是 `IN (...)` 展开的分片大小。
//
// 为什么必须分片：PostgreSQL 扩展协议一条语句最多 65535 个绑定参数（`IN` 还会带上
// user_id，所以实际上限是 65534 个 id），超了直接报 "extended protocol limited to
// 65535 parameters"（审计 2026-09-22 L1 实测：70000 个 id 必现；本函数是对外可达的，
// 引用上限 `max_file_refs` 运行期可配到 4096，且将来可能放宽）。分片只多几次往返，
// 语义不变：缺省引用上限 600 ⇒ 常规路径仍然正好一条查询。
const gatewayFilesOwnedByChunk = 5000

// GatewayFilesOwnedBy 批量判定：返回 ids 中**确实属于该用户**且未过期的那些 id。
//
// 单次往返（`IN (...)` 展开）：审计 2026-09-22 F 路 P2-3 实测逐个 `GatewayFileOwnedBy`
// 在 100 个引用时约 49ms、1000 个约 113ms，全是串行 DB 往返；而请求体上限 64MiB 足够
// 塞进远多于 1000 个 `file_id`，等于把"闸门前的排队时间"交给调用方控制。调用方据此
// 把引用数压在上限内（见 llmgateway 的 `max_file_refs` 设置），本函数只负责一次问清。
// 超出分片大小时按 gatewayFilesOwnedByChunk 分批（见该常量注释）。
func GatewayFilesOwnedBy(db *sql.DB, ids []string, userID int64) (map[string]struct{}, error) {
	owned := make(map[string]struct{}, len(ids))
	if len(ids) == 0 {
		return owned, nil
	}
	for start := 0; start < len(ids); start += gatewayFilesOwnedByChunk {
		end := start + gatewayFilesOwnedByChunk
		if end > len(ids) {
			end = len(ids)
		}
		batch := ids[start:end]
		args := make([]any, 0, len(batch)+1)
		args = append(args, userID)
		for _, id := range batch {
			args = append(args, id)
		}
		rows, err := db.Query(
			`SELECT file_id FROM gateway_files
			 WHERE user_id = ? AND (expires_at IS NULL OR expires_at > now())
			   AND file_id IN (`+qmarks(len(batch))+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			owned[id] = struct{}{}
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return owned, nil
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
		// 口径比另外两处**更严**：只要带回收标记就跳过（不看租约）。
		//
		// 为什么更严（审计 R8 P3 的口径差异，这里说明为有意）：本函数只清**台账行**、
		// 不删上游对象，而行是回收器唯一的"清理责任"凭据 —— 把一个正在被认领的行删掉，
		// 万一回收器随后崩溃/中断，那份上游对象就再无凭据（配额静默泄漏）。候选列表与
		// 管理端清理允许处理"租约过期的标记行"，是因为它们各自都还有别的收敛路径
		// （列表：重新认领；管理端：管理员显式删除）。
		//
		// 上游那份对象由回收器负责删除；上传重写把新上传的 `expires_after` 收敛到平台
		// 上限后，上游对象会自己到期，所以"台账行先清、上游自清"不会长期泄漏配额。
		// **例外**是改造前的"永久"老行（上游无过期时间）：靠回收器的
		// `NormalizeLegacyPermanentGatewayFiles` 补上过期时间后再删上游；若本函数先一步
		// 清了行，那份对象就再无凭据（已认账的残留，见 06-database.md）。
		`SELECT file_id FROM gateway_files
		 WHERE expires_at IS NOT NULL AND expires_at <= now()
		   AND reaping_at IS NULL
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
		// NUL 字节（`?q=%00` 一个 URL 就够）必须在这里拦下：PG 的 text 参数不能含
		// NUL，原样送进去会得到 SQLSTATE 22021（invalid byte sequence for encoding
		// "UTF8": 0x00）⇒ 管理端 500（审计 2026-09-22 L1 实测）。而 text 列里本来
		// 也**存不了** NUL ⇒ 唯一的正确语义是"无命中"：既不是 500，也**不能**退化成
		// "丢掉搜索条件后按其它过滤返回全量"。
		if strings.IndexByte(s, 0) >= 0 {
			where += " AND 1=0"
		} else {
			where += " AND g.file_id ILIKE ?"
			args = append(args, "%"+escapeLike(s)+"%")
		}
	}
	if q.OnlyExpired {
		where += " AND g.expires_at IS NOT NULL AND g.expires_at <= now()"
		// 正在被回收器认领（标记在租约内）的行不参与管理端清理：删掉行会让上游对象
		// 失去清理凭据；等回收器收尾（或租约过期）后自然会被清掉。租约常量只有一处真源
		// （`ReapClaimLease`），这里通过参数传入而不是再写一个字面量。
		where += " AND (g.reaping_at IS NULL OR g.reaping_at < now() - make_interval(secs => ?))"
		args = append(args, ReapClaimLease.Seconds())
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
//
// 排序用**输出列名**（PG 允许 ORDER BY 输出列），不要用位置下标：位置在改 SELECT
// 列表时会静默错位（审计 2026-09-22 R6 P1-C 实测三档全部错位一列，`sort=bytes`
// 的首行不是占用最大的人）。
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
	rows, err := db.Query(`SELECT g.user_id, COALESCE(u.username, '') AS username,
	                              COALESCE(u.display_name, '') AS display_name,
	                              count(*) AS files,
	                              COALESCE(sum(g.size_bytes), 0) AS bytes,
	                              count(*) FILTER (WHERE g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired_files,
	                              min(g.expires_at) AS earliest_expires_at
	                         FROM gateway_files g LEFT JOIN users u ON u.id = g.user_id
	                        GROUP BY g.user_id, u.username, u.display_name
	                        ORDER BY ` + order + ` ` + dir + ` NULLS LAST, g.user_id ASC`)
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
	                          AND (reaping_at IS NULL OR reaping_at < now() - make_interval(secs => ?))
	                        ORDER BY expires_at ASC LIMIT ?`, ReapClaimLease.Seconds(), limit)
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

// GatewayFileRowExists 判定台账里是否存在该 file_id（**不看过期**）。
//
// 管理端的单条删除用它：过期行也允许管理员按 id 删掉（列表里"已过期"那一行同样有
// 删除按钮；审计 2026-09-22 R6 P2 实测旧实现走 GatewayFileOwner ⇒ 过期行 404）。
func GatewayFileRowExists(db *sql.DB, fileID string) (bool, error) {
	var one int
	switch err := db.QueryRow(`SELECT 1 FROM gateway_files WHERE file_id = ?`, fileID).Scan(&one); {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return true, nil
}

// GatewayFileForReap 是回收器认领一行时的快照（用于上游删除失败后**原样写回**）。
//
// `CreatedAt` 必须一起带走：写回是"补回一行"，若不带原始上传时间就只能记成 now()，
// 台账会丢掉真实上传时间（审计 2026-09-22 N10）。
type GatewayFileForReap struct {
	FileID    string
	UserID    int64
	CreatedAt time.Time
	ExpiresAt *time.Time
	SizeBytes int64
}

// ClaimExpiredGatewayFile 在一个事务里"认领"一行已过期记录：锁行、复检**此刻仍然过期**、
// 打上回收标记（`reaping_at = now()`）并提交。**不删行**。
//
// 为什么是"标记"而不是"删行"（审计 2026-09-22 R7 N11）：认领后要发一次上游删除，
// 若中间进程死掉，删掉的行会让那个上游对象**再无凭据**（配额静默泄漏）；保留行 + 标记
// 则可以让下一轮重新认领、重删（404 = 成功）再收尾，天然可重入。
//
// 租约（`reapClaimLease`）：标记早于租约时长的行可被重新认领 —— 认领方崩溃的自愈窗口，
// 比回收间隔略长，避免正常在跑的批次被下一轮抢走。
//
// 返回 ok=false 表示"已经不过期 / 已被别的路径处理 / 标记仍在租约内"（调用方跳过）。
func ClaimExpiredGatewayFile(db *sql.DB, fileID string) (GatewayFileForReap, bool, error) {
	tx, err := db.Begin()
	if err != nil {
		return GatewayFileForReap{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	var snap GatewayFileForReap
	row := tx.QueryRow(`SELECT file_id, user_id, created_at, expires_at, size_bytes FROM gateway_files
	                     WHERE file_id = ? AND expires_at IS NOT NULL AND expires_at <= now()
	                     FOR UPDATE`, fileID)
	switch err := row.Scan(&snap.FileID, &snap.UserID, &snap.CreatedAt, &snap.ExpiresAt, &snap.SizeBytes); {
	case errors.Is(err, sql.ErrNoRows):
		return GatewayFileForReap{}, false, nil // 已续期/已被处理
	case err != nil:
		return GatewayFileForReap{}, false, err
	}
	res, err := tx.Exec(`UPDATE gateway_files SET reaping_at = now()
	                      WHERE file_id = ?
	                        AND (reaping_at IS NULL OR reaping_at < now() - make_interval(secs => ?))`,
		fileID, ReapClaimLease.Seconds())
	if err != nil {
		return GatewayFileForReap{}, false, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return GatewayFileForReap{}, false, nil // 别的批次正持有标记（租约内）
	}
	if err := tx.Commit(); err != nil {
		return GatewayFileForReap{}, false, err
	}
	return snap, true, nil
}

// ReapClaimLease 是回收标记的租约（唯一真源）：早于它的标记可被重新认领
// （认领方崩溃后的自愈窗口，略长于回收间隔 5 分钟，避免正常在跑的批次被下一轮抢走）。
// `ClaimExpiredGatewayFile` 与 `ListExpiredGatewayFiles` 共用它，llmgateway 侧不再自持常量。
const ReapClaimLease = 10 * time.Minute

// GatewayFileReapClaimHeld 报告该行的回收标记是否仍由**本次认领**持有。
//
// 判据是"标记还在"：重新登记（并发上传转手过期行）会清空 `reaping_at`，
// 行被别的路径删掉则查不到 ⇒ 两种情况都返回 false，调用方必须**放弃删上游对象**。
func GatewayFileReapClaimHeld(db *sql.DB, fileID string) (bool, error) {
	var held bool
	switch err := db.QueryRow(
		`SELECT reaping_at IS NOT NULL FROM gateway_files WHERE file_id = ?`, fileID).Scan(&held); {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return held, nil
}

// FinishReapedGatewayFile 收尾：删掉仍带回收标记的行（上游对象已经删掉了）。
// 带标记谓词 ⇒ 若期间被重新登记（标记被清空），这里不会误删活行。
func FinishReapedGatewayFile(db *sql.DB, fileID string) error {
	_, err := db.Exec(`DELETE FROM gateway_files WHERE file_id = ? AND reaping_at IS NOT NULL`, fileID)
	return err
}

// ReleaseReapClaim 放弃回收标记（上游删除失败时调用）：下一轮立刻可以重试，
// 不必等租约过期。
func ReleaseReapClaim(db *sql.DB, fileID string) error {
	_, err := db.Exec(`UPDATE gateway_files SET reaping_at = NULL WHERE file_id = ?`, fileID)
	return err
}

// NormalizeLegacyPermanentGatewayFiles 把"没有过期时间"的存量行按上限补齐
// （`expires_at = created_at + cap`），使它们也能被回收。
//
// 背景：平台改造前，客户端不带 expires_after 的上传在上游是**永久**的，台账记 NULL；
// 只靠新上传路径收敛管不到这些老行（审计 2026-09-22 R6 P2："存量永久行永不收敛"）。
// 幂等（只动 NULL 行）、批量有上限，返回本次补齐行数。
func NormalizeLegacyPermanentGatewayFiles(db *sql.DB, cap time.Duration, limit int) (int64, error) {
	if cap <= 0 {
		return 0, nil
	}
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	// 用 make_interval(secs => ?) 而不是 `created_at + ?`：Go 的 time.Duration 不是
	// PG 的 interval，直接传会被驱动拒绝（实测 500）。秒数走 float8。
	seconds := cap.Seconds()
	res, err := db.Exec(`UPDATE gateway_files SET expires_at = created_at + make_interval(secs => ?)
	                      WHERE file_id IN (
	                        SELECT file_id FROM gateway_files WHERE expires_at IS NULL LIMIT ?
	                      )`, seconds, limit)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
