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
	"fmt"
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
//
// `reap_gen` 语义（R4-C-1，审计 2026-09-23）：行世代号，登记路径 +1。世代是回收器的
// **fencing token** —— 认领时也会 +1，回收器持有自己那一代；任何让"这份对象该不该被删"
// 的归属发生变化的写（转手/续期/重新认领）都会推进世代，让在飞的删除权立即失效。
//
// **认领在租约内时拒绝转手**（R4-C-1 的核心）：`reaping_at` 落在租约内的行正被回收器
// 删除上游对象，此时把行转给新的上传者，会让"新上传者的上游对象被删掉、台账却说他有效"
// —— 所以 WHERE 追加租约判据，命中即 0 行并返回 `ErrGatewayFileReapClaimed`，由上传
// 路径放弃这个 id（回落 base64 内联 / 重新上传）。租约过期后的转手照旧允许（认领方
// 崩溃的自愈窗口），此时世代已被推进，回收器会在 DELETE 前后两次校验里放弃删除。
func RecordGatewayFileSize(db *sql.DB, fileID string, userID int64, expiresAt *time.Time, sizeBytes int64) error {
	if sizeBytes < 0 {
		sizeBytes = 0
	}
	// 认领租约在 WHERE 里出现两次判据（"标记仍在租约内"），用同一个真源常量。
	lease := ReapClaimLease.Seconds()
	for attempt := 0; attempt < 2; attempt++ {
		res, err := db.Exec(
			`INSERT INTO gateway_files (file_id, user_id, expires_at, size_bytes) VALUES (?, ?, ?, ?)
			 ON CONFLICT (file_id) DO UPDATE
			   SET expires_at = EXCLUDED.expires_at, user_id = EXCLUDED.user_id,
			       -- 重新登记 = 这份文件又有主了 ⇒ 必须清掉回收标记，否则回收器仍以为自己在删
			       -- 一个"没人要"的对象（审计 R7 N11 的续期侧；SQL 里少这一句就退化成
			       -- "续期后仍被回收"，判据 TestReaperAbandonsIfRenewedDuringReap 会红）。
			       reaping_at = NULL,
			       -- 世代推进：在飞的回收权（持旧世代的回收器）从这一刻起失效。
			       reap_gen = gateway_files.reap_gen + 1,
			       created_at = CASE WHEN gateway_files.expires_at <= now() THEN now()
			                         ELSE gateway_files.created_at END,
			       size_bytes = CASE WHEN EXCLUDED.size_bytes > 0 THEN EXCLUDED.size_bytes
			                         ELSE gateway_files.size_bytes END
			 WHERE (gateway_files.user_id = EXCLUDED.user_id
			        OR gateway_files.expires_at <= now())
			   -- R4-C-1：认领在租约内的行不得转手（上游对象正在被删）。
			   AND (gateway_files.reaping_at IS NULL
			        OR gateway_files.reaping_at < now() - make_interval(secs => ?))`,
			fileID, userID, expiresAt, sizeBytes, lease,
		)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			return nil
		}
		// 0 行的两种成因语义完全不同，必须区分：
		//   (a) 该 id 仍属于**别人**且未过期 —— "存活行不转手"的既定规则，不是错误；
		//   (b) 该行正被回收器认领（租约内）—— 上游对象正在被删，绝不能把这个 id
		//       交给上传者（R4-C-1），必须让调用方放弃它。
		claimed, err := gatewayFileReapClaimActive(db, fileID)
		if err != nil {
			return err
		}
		if claimed {
			return fmt.Errorf("%w: %s", ErrGatewayFileReapClaimed, fileID)
		}
		// 未认领：也可能是"认领刚被释放/租约刚过期"的竞态 ⇒ 再试一次即可收敛
		// （第二次仍 0 行就只可能是 (a)）。
	}
	return nil
}

// ErrGatewayFileReapClaimed 表示目标 `file_id` 正被回收器认领（标记在租约内）：
// 上游对象正在被删除，登记路径**拒绝转手**，调用方必须放弃这个 id
// （llmgateway 的上传路径据此回错误，让客户端回落 base64 内联 / 重新上传）。
//
// 判据见 serverstore 的 TestRecordGatewayFileRefusesTransferDuringActiveClaim 与
// llmgateway 的 TestReaperFencesRegistrationDuringUpstreamDelete（确定性交错）。
var ErrGatewayFileReapClaimed = errors.New("gateway file has an active reap claim")

// gatewayFileReapClaimActive 报告该行是否正被回收器认领（标记在租约内）。
func gatewayFileReapClaimActive(db *sql.DB, fileID string) (bool, error) {
	var active bool
	switch err := db.QueryRow(
		`SELECT reaping_at IS NOT NULL AND reaping_at >= now() - make_interval(secs => ?)
		   FROM gateway_files WHERE file_id = ?`, ReapClaimLease.Seconds(), fileID).Scan(&active); {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return active, nil
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
	// 排序子句是**常量**（白名单 → 固定字符串），SQL 里不拼接任何变量：
	// 位置下标或字符串拼接都出过问题（下标的静默错位见 R6 P1-C；拼接则是 CodeQL
	// `go/sql-injection` 的判据面 —— 即使来源已白名单，也不给它留这个面）。
	orderClause := gatewayFileOrderClause(q.Sort, q.Desc)
	query := `SELECT g.file_id, g.user_id, COALESCE(u.username, ''), COALESCE(u.display_name, ''),
	                 g.size_bytes, g.created_at, g.expires_at,
	                 (g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired
	            FROM gateway_files g LEFT JOIN users u ON u.id = g.user_id` + where +
		` ` + orderClause + ` LIMIT ? OFFSET ?`
	args = append(args, q.Limit, q.Offset)
	rows, err := db.Query(query, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	// 容量不吃用户可控的 Limit（CodeQL `go/uncontrolled-allocation-size`）：
	// 从一个小常量起步，靠 append 增长即可。
	out := make([]GatewayFileRow, 0, gatewayFilePageMaxCapped)
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

// gatewayFileOrderClause 把（白名单内的）排序键与方向映射成**固定 SQL 常量**。
// 任何输入都只会落到下列字面量之一，默认 created_at DESC。
func gatewayFileOrderClause(sort string, desc bool) string {
	switch sort {
	case "expires_at":
		if desc {
			return "ORDER BY g.expires_at DESC NULLS LAST, g.file_id ASC"
		}
		return "ORDER BY g.expires_at ASC NULLS LAST, g.file_id ASC"
	case "size_bytes":
		if desc {
			return "ORDER BY g.size_bytes DESC, g.file_id ASC"
		}
		return "ORDER BY g.size_bytes ASC, g.file_id ASC"
	case "username":
		if desc {
			return "ORDER BY u.username DESC, g.file_id ASC"
		}
		return "ORDER BY u.username ASC, g.file_id ASC"
	default: // created_at
		if desc {
			return "ORDER BY g.created_at DESC, g.file_id ASC"
		}
		return "ORDER BY g.created_at ASC, g.file_id ASC"
	}
}

// gatewayFileSummaryOrderClause 同上（按员工汇总的三个排序键）。
func gatewayFileSummaryOrderClause(sort string, desc bool) string {
	switch sort {
	case "files":
		if desc {
			return "ORDER BY files DESC NULLS LAST, g.user_id ASC"
		}
		return "ORDER BY files ASC NULLS LAST, g.user_id ASC"
	case "username":
		if desc {
			return "ORDER BY username DESC NULLS LAST, g.user_id ASC"
		}
		return "ORDER BY username ASC NULLS LAST, g.user_id ASC"
	default: // bytes
		if desc {
			return "ORDER BY bytes DESC NULLS LAST, g.user_id ASC"
		}
		return "ORDER BY bytes ASC NULLS LAST, g.user_id ASC"
	}
}

// gatewayFilePageMaxCapped 是列表查询的起始切片容量（小常量，避免按用户输入预分配）。
const gatewayFilePageMaxCapped = 32

// GatewayFileSummary 按员工汇总占用（文件数 / 字节数 / 其中已过期数 / 最早过期时刻）。
//
// 排序用**输出列名**（PG 允许 ORDER BY 输出列），不要用位置下标：位置在改 SELECT
// 列表时会静默错位（审计 2026-09-22 R6 P1-C 实测三档全部错位一列，`sort=bytes`
// 的首行不是占用最大的人）。
func GatewayFileSummary(db *sql.DB, sort string, desc bool) ([]GatewayFileSummaryRow, error) {
	orderClause := gatewayFileSummaryOrderClause(sort, desc)
	rows, err := db.Query(`SELECT g.user_id, COALESCE(u.username, '') AS username,
	                              COALESCE(u.display_name, '') AS display_name,
	                              count(*) AS files,
	                              COALESCE(sum(g.size_bytes), 0) AS bytes,
	                              count(*) FILTER (WHERE g.expires_at IS NOT NULL AND g.expires_at <= now()) AS expired_files,
	                              min(g.expires_at) AS earliest_expires_at
	                         FROM gateway_files g LEFT JOIN users u ON u.id = g.user_id
	                        GROUP BY g.user_id, u.username, u.display_name
	                        ` + orderClause)
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

// ListExpiredGatewayFiles 取一批已过期行（自动回收/管理端清理用）。
//
// 排序 = **尝试次数升序**（`reap_gen`），再按过期时间升序（R5-A-12，审计 2026-09-23，P1）。
//
// 缺陷形态（修复前只按 `expires_at ASC`）：单条上游 DELETE 永久失败（典型：轮换上游
// key 后旧对象对新 key 返回 403、或个别 id 被上游拒绝）时，回收器释放认领 ⇒ 该行下轮
// **同时**满足"已过期 + 标记不在租约内"，而 `expires_at` 不变 ⇒ 重新排回最前。于是
// ≥批次上限（500）条永久失败行把每一轮的批次占满，更晚过期的文件**永不进入候选**，
// 上游共享配额（每 key 25 GiB / 10000 文件）单调泄漏，日志固定是
// `500 expired file(s) reclaimed, 500 failed`，不会自己好。
//
// 为什么用 `reap_gen` 而不是新列：它就是**单调递增的尝试次数**（每次认领 +1，见
// `ClaimExpiredGatewayFile`；同时充当 R4-C-1 的 fencing token），所以分层排序不需要
// 新列、新状态或新迁移。语义保证：**从未失败过的行（gen=0）永远排在失败过的行之前**
// —— 新过期的文件因此绝不会被永久失败行挡住；失败行只在"没有更低世代的候选"时才占
// 批次位，且每被尝试一次世代 +1 ⇒ 最坏情况下健康行也只被推迟一轮。
//
// 注意：这一列是**两用**的（fencing token + 尝试次数），改认领语义时必须同时看这里。
func ListExpiredGatewayFiles(db *sql.DB, limit int) ([]string, error) {
	if limit <= 0 || limit > 2000 {
		limit = 500
	}
	rows, err := db.Query(`SELECT file_id FROM gateway_files
	                        WHERE expires_at IS NOT NULL AND expires_at <= now()
	                          AND (reaping_at IS NULL OR reaping_at < now() - make_interval(secs => ?))
	                        ORDER BY reap_gen ASC, expires_at ASC LIMIT ?`, ReapClaimLease.Seconds(), limit)
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

// GatewayFileReapStuckThreshold 是"进入人工处置清单"的尝试次数阈值：一条已过期行被
// 认领（= 尝试删上游）达到这个次数还在，说明上游在持续拒绝它，自动回收救不回来。
const GatewayFileReapStuckThreshold = 5

// gatewayFileStuckSampleLimit 是"点名"时最多列出的行数（日志可读性；计数不受它限制）。
const gatewayFileStuckSampleLimit = 10

// GatewayFileReapStuck 是被点名的一条"回收不动"的行。
type GatewayFileReapStuck struct {
	FileID   string
	Attempts int64
}

// GatewayFileReapBacklog 是回收积压的**可观测口径**（R5-A-12）：用于把"上游在持续
// 拒绝的对象"从"只是还没轮到"里分出来 —— 后者会自愈，前者只能人工处置（管理端的
// 单条删除/按条件清理）。
//
// 全部字段都是"已过期行"（`expires_at <= now()`）上的统计，与回收器的候选集合同源。
type GatewayFileReapBacklog struct {
	// Expired 是已过期行总数（含正在被认领的）。
	Expired int64
	// Retrying 是至少被尝试过一次（reap_gen > 0）的行数。
	Retrying int64
	// Stuck 是尝试次数 ≥ GatewayFileReapStuckThreshold 的行数（需人工处置）。
	Stuck int64
	// MaxAttempts 是单行最大尝试次数。
	MaxAttempts int64
	// StuckSample 是按尝试次数降序的前若干条（最多 gatewayFileStuckSampleLimit 条），
	// 供日志/管理面**点名**；为空表示没有达到阈值的行。
	StuckSample []GatewayFileReapStuck
}

// GatewayFileReapBacklogStats 采集回收积压口径（回收器每轮调用一次，只读）。
func GatewayFileReapBacklogStats(db *sql.DB) (GatewayFileReapBacklog, error) {
	var out GatewayFileReapBacklog
	if err := db.QueryRow(`SELECT count(*),
	                              count(*) FILTER (WHERE reap_gen > 0),
	                              count(*) FILTER (WHERE reap_gen >= ?),
	                              COALESCE(max(reap_gen), 0)
	                         FROM gateway_files
	                        WHERE expires_at IS NOT NULL AND expires_at <= now()`,
		GatewayFileReapStuckThreshold).Scan(&out.Expired, &out.Retrying, &out.Stuck, &out.MaxAttempts); err != nil {
		return GatewayFileReapBacklog{}, err
	}
	if out.Stuck == 0 {
		return out, nil
	}
	rows, err := db.Query(`SELECT file_id, reap_gen FROM gateway_files
	                        WHERE expires_at IS NOT NULL AND expires_at <= now() AND reap_gen >= ?
	                        ORDER BY reap_gen DESC, expires_at ASC LIMIT ?`,
		GatewayFileReapStuckThreshold, gatewayFileStuckSampleLimit)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var s GatewayFileReapStuck
		if err := rows.Scan(&s.FileID, &s.Attempts); err != nil {
			return out, err
		}
		out.StuckSample = append(out.StuckSample, s)
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

// GatewayFileForReap 是回收器认领一行时的快照。
//
// 回收路径只用 `ok` 判定（认领成功后行仍在、无需写回），快照字段供**测试与诊断**
// 消费（例如断言 created_at 不丢、管理端上传时间口径）；保留它们是为了让"认领拿到了
// 什么"可被断言，而不是给生产路径回写用。
//
// `CreatedAt` 必须一起带走：写回是"补回一行"，若不带原始上传时间就只能记成 now()，
// 台账会丢掉真实上传时间（审计 2026-09-22 N10）。
//
// `ReapGeneration` 是本次认领拿到的**世代号**（R4-C-1 的 fencing token）：认领时
// 行世代 +1，回收器据此在"发上游 DELETE 之前"与"收尾删行之前"各校验一次自己的
// 删除权是否仍然有效（`GatewayFileReapClaimHeld` / `FinishReapedGatewayFile`）。
type GatewayFileForReap struct {
	FileID         string
	UserID         int64
	CreatedAt      time.Time
	ExpiresAt      *time.Time
	SizeBytes      int64
	ReapGeneration int64
}

// ClaimExpiredGatewayFile 在一个事务里"认领"一行已过期记录：锁行、复检**此刻仍然过期**、
// 打上回收标记（`reaping_at = now()`）并把行世代 +1，提交。**不删行**。
//
// 为什么是"标记"而不是"删行"（审计 2026-09-22 R7 N11）：认领后要发一次上游删除，
// 若中间进程死掉，删掉的行会让那个上游对象**再无凭据**（配额静默泄漏）；保留行 + 标记
// 则可以让下一轮重新认领、重删（404 = 成功）再收尾，天然可重入。
//
// 租约（`ReapClaimLease`）：标记早于租约时长的行可被重新认领 —— 认领方崩溃的自愈窗口，
// 比回收间隔略长，避免正常在跑的批次被下一轮抢走。重新认领会**再次推进世代**，因此
// 老认领方的在飞删除权自动失效（R4-C-1 的 fencing 语义）。
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
	// 世代号在**同一条语句**里 +1 并回读（RETURNING），避免"先读后写"的竞态。
	err = tx.QueryRow(`UPDATE gateway_files SET reaping_at = now(), reap_gen = reap_gen + 1
	                    WHERE file_id = ?
	                      AND (reaping_at IS NULL OR reaping_at < now() - make_interval(secs => ?))
	                    RETURNING reap_gen`,
		fileID, ReapClaimLease.Seconds()).Scan(&snap.ReapGeneration)
	if errors.Is(err, sql.ErrNoRows) {
		return GatewayFileForReap{}, false, nil // 别的批次正持有标记（租约内）
	}
	if err != nil {
		return GatewayFileForReap{}, false, err
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

// GatewayFileReapClaimHeld 报告该行的回收权是否仍由**本次认领**（世代 generation）持有。
//
// 判据是"标记还在**且**世代未变**且**仍在租约内"（R4-C-1 的 fencing token 语义）：
//   - 重新登记（转手/续期）会清空 `reaping_at` 并推进世代 ⇒ false；
//   - 行被别的路径删掉 ⇒ 查不到 ⇒ false；
//   - 认领已过租约（认领方卡住超过租约）⇒ false —— 此时别的批次随时可以重新认领并
//     推进世代，甚至上传者可以合法转手，所以本世代**没有**删除权；
//   - 行被重新认领（多实例/崩溃自愈）⇒ 世代不同 ⇒ false。
//
// 任何一种为 false 都意味着调用方必须**放弃删上游对象**（对象可能已属于新一代）。
func GatewayFileReapClaimHeld(db *sql.DB, fileID string, generation int64) (bool, error) {
	var held bool
	switch err := db.QueryRow(
		`SELECT reaping_at IS NOT NULL AND reap_gen = ?
		          AND reaping_at >= now() - make_interval(secs => ?)
		   FROM gateway_files WHERE file_id = ?`,
		generation, ReapClaimLease.Seconds(), fileID).Scan(&held); {
	case errors.Is(err, sql.ErrNoRows):
		return false, nil
	case err != nil:
		return false, err
	}
	return held, nil
}

// FinishReapedGatewayFile 收尾：删掉仍带**本世代**回收标记的行（上游对象已经删掉了）。
//
// 带世代谓词 ⇒ 若期间被重新登记（转手会清空标记并推进世代）或已被重新认领，
// 这里不会误删新一代的行。返回 finished=false 表示"这一行已经不归本世代处置"
// —— 调用方必须把这次删除如实记为"对象已删、台账行留给新一代"（并打日志）。
func FinishReapedGatewayFile(db *sql.DB, fileID string, generation int64) (bool, error) {
	res, err := db.Exec(
		`DELETE FROM gateway_files WHERE file_id = ? AND reaping_at IS NOT NULL AND reap_gen = ?`,
		fileID, generation)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
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
