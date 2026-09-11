package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"
)

// AuditLogEntry is one audit log row (sensitive admin operations).
// json tag 必须是小写字段名:webadmin Audit.tsx 的 LogRow 读取
// id/username/action/detail/created_at,缺 tag 会输出大写字段名导致前端全空。
type AuditLogEntry struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Action    string    `json:"action"`
	Detail    string    `json:"detail"`
	PrevHash  string    `json:"prev_hash"` // 0048 哈希链
	Hash      string    `json:"hash"`      // 0048 本条目 sha256(省略响应)
	CreatedAt time.Time `json:"created_at"`
}

// AuditLog appends an audit entry with a tamper-evident hash chain
// (0048): the entry's hash = sha256(prev_hash | username | action | detail
// | created_at), and prev_hash carries the previous entry's hash. Mutating
// any row breaks every subsequent chain link.
// auditChainLockKey 审计哈希链写入的 PG advisory lock key(固定常量,
// 同一数据库内的所有实例共享):串行化「读最后一行 → 计算 → 插入」。
const auditChainLockKey = int64(0x5069636F) // "Pico"

// AuditLog appends an audit entry with a tamper-evident hash chain
// (0048): the entry's hash = sha256(prev_hash | username | action | detail
// | created_at), and prev_hash carries the previous entry's hash. Mutating
// any row breaks every subsequent chain link.
// P2-1:链的写入必须串行——并发插入若都读到同一个 prev_hash,后写者即形成
// 分叉链(VerifyAuditChain 报断链)。事务 + pg_advisory_xact_lock 让
// 「读尾 + 插入」原子且跨实例互斥(事务结束自动释放锁)。
func AuditLog(db *sql.DB, username, action, detail string) error {
	// F16(审计 2026-09-11):审计写路径改为**每 DB 单 worker 串行 + 批量**。
	// 旧实现每次审计都单独开事务、取全局 advisory lock、读链尾、插入、提交;
	// 高并发登录/管理操作会在这把全局锁上排队,把请求延迟整体拉高。
	// 现在请求仍同步等待结果(错误语义不变),但 N 条审计合并为一个事务、
	// 一次锁获取,DB 往返与锁竞争降为 1/N;worker 空闲 60s 自动退出,
	// 测试的多临时库不会积累常驻 goroutine。
	w := auditWorkerFor(db)
	req := auditRequest{username: username, action: action, detail: detail, done: make(chan error, 1)}
	enqueue := func(worker *auditWorker) bool {
		select {
		case worker.ch <- req:
			return true
		case <-time.After(5 * time.Second):
			return false
		}
	}
	if !enqueue(w) {
		// worker 可能恰在空闲退出;重取(必要时新建)后重试一次。
		if !enqueue(auditWorkerFor(db)) {
			return errors.New("audit queue timeout")
		}
	}
	select {
	case err := <-req.done:
		return err
	case <-time.After(15 * time.Second):
		return errors.New("audit write timeout")
	}
}

// ---- F16: 审计写入 worker ----

type auditRequest struct {
	username, action, detail string
	done                     chan error
}

type auditWorker struct {
	db *sql.DB
	ch chan auditRequest
}

var auditWorkers sync.Map // *sql.DB -> *auditWorker

func auditWorkerFor(db *sql.DB) *auditWorker {
	if v, ok := auditWorkers.Load(db); ok {
		return v.(*auditWorker)
	}
	w := &auditWorker{db: db, ch: make(chan auditRequest, 256)}
	actual, loaded := auditWorkers.LoadOrStore(db, w)
	if loaded {
		return actual.(*auditWorker)
	}
	go w.run()
	return w
}

// run 串行消费审计请求;攒批(最多 20 条或 2ms)后一次事务写入。
func (w *auditWorker) run() {
	idle := time.NewTimer(60 * time.Second)
	defer idle.Stop()
	for {
		select {
		case req := <-w.ch:
			batch := []auditRequest{req}
			// 攒批:等待极短窗口吸收并发请求(不引入可感知延迟)。
		collect:
			for len(batch) < 20 {
				t := time.NewTimer(2 * time.Millisecond)
				select {
				case r := <-w.ch:
					batch = append(batch, r)
					t.Stop()
				case <-t.C:
					break collect
				}
			}
			err := writeAuditBatch(w.db, batch)
			for _, r := range batch {
				r.done <- err
			}
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(60 * time.Second)
		case <-idle.C:
			// 空闲退出:先从注册表摘除;若已被并发重取(CompareAndDelete
			// 失败)说明有新请求指向我们,继续服务。
			if auditWorkers.CompareAndDelete(w.db, w) {
				return
			}
			idle.Reset(60 * time.Second)
		}
	}
}

// writeAuditBatch 在一个事务内串行追加一批审计条目,保持哈希链不分叉。
// advisory lock 仍保留(跨实例互斥),但每批只获取一次。
func writeAuditBatch(db *sql.DB, batch []auditRequest) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec("SELECT pg_advisory_xact_lock(?)", auditChainLockKey); err != nil {
		return err
	}
	var prevHash string
	if err := tx.QueryRow("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1").Scan(&prevHash); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		prevHash = ""
	}
	for _, r := range batch {
		now := time.Now().UTC().Format(time.RFC3339)
		payload := prevHash + "|" + r.username + "|" + r.action + "|" + r.detail + "|" + now
		sum := sha256.Sum256([]byte(payload))
		hash := hex.EncodeToString(sum[:])
		if _, err := tx.Exec("INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			r.username, r.action, r.detail, prevHash, hash, now); err != nil {
			return err
		}
		prevHash = hash
	}
	return tx.Commit()
}

// auditHashPayload mirrors the payload used at write time (same layout).
func auditHashPayload(prevHash, username, action, detail, createdAt string) string {
	return prevHash + "|" + username + "|" + action + "|" + detail + "|" + createdAt
}

// VerifyAuditChain walks the audit log from oldest to newest and verifies
// every hash link. Returns the first broken entry id (or 0 if intact).
// Rows written before the 0048 migration have hash=” and are skipped
// (the chain starts at the first post-migration entry).
// P2-1:保留策略清理后,链的起点是 PurgeOldAuditLogs 保留的「锚」(其
// prev_hash 指向已删除的更早条目),故第一个条目只校验自身哈希、不校验
// 链尾衔接;其后每条仍必须与上一条 hash 严格衔接。
func VerifyAuditChain(db *sql.DB) (int64, error) {
	rows, err := db.Query("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id ASC")
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	prevHash := ""
	first := true
	for rows.Next() {
		var id int64
		var username, action, detail, rowPrev, rowHash, created string
		created = ""
		var createdAny any
		if err := rows.Scan(&id, &username, &action, &detail, &rowPrev, &rowHash, &createdAny); err != nil {
			return 0, err
		}
		if s, ok := createdAny.(string); ok {
			created = s
		} else if t, ok := createdAny.(time.Time); ok {
			created = t.UTC().Format(time.RFC3339)
		}
		// Legacy rows (pre-0048) carry an empty hash: skip link checks but
		// note that a legacy row may sit mid-chain; validate only post-0048.
		if rowHash == "" {
			continue
		}
		if first {
			first = false // 链起点(可能是清理后的锚):只校验自身哈希
		} else if rowPrev != prevHash {
			return id, errors.New("audit chain broken at entry")
		}
		sum := sha256.Sum256([]byte(auditHashPayload(rowPrev, username, action, detail, created)))
		if hex.EncodeToString(sum[:]) != rowHash {
			return id, errors.New("audit hash mismatch")
		}
		prevHash = rowHash
	}
	return 0, rows.Err()
}

// ListAuditLogs returns the most recent audit entries (limit <= 0: 50).
func ListAuditLogs(db *sql.DB, limit int) ([]AuditLogEntry, error) {
	if limit <= 0 {
		limit = 50
	}
	logs, _, err := ListAuditLogsPaged(db, 0, limit)
	return logs, err
}

// ListAuditLogsPaged returns one page of audit entries (newest first) and the
// total count.
func ListAuditLogsPaged(db *sql.DB, offset, limit int) ([]AuditLogEntry, int64, error) {
	var total int64
	if err := db.QueryRow("SELECT COUNT(*) FROM audit_logs").Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := db.Query("SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var l AuditLogEntry
		var created any
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &l.PrevHash, &l.Hash, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// ListAuditLogsPagedFiltered returns one page of audit entries (newest
// first) optionally filtered by action/username (审计 M8), plus the total
// for the filtered set.
func ListAuditLogsPagedFiltered(db *sql.DB, offset, limit int, action, username string) ([]AuditLogEntry, int64, error) {
	where := ""
	args := []any{}
	if action != "" {
		where += " AND action = ?"
		args = append(args, action)
	}
	if username != "" {
		where += " AND username = ?"
		args = append(args, username)
	}
	where = strings.TrimPrefix(where, " AND ")
	var total int64
	countQ := "SELECT COUNT(*) FROM audit_logs"
	if where != "" {
		countQ += " WHERE " + where
	}
	if err := db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	q := "SELECT id, username, action, detail, prev_hash, hash, created_at FROM audit_logs"
	if where != "" {
		q += " WHERE " + where
	}
	q += " ORDER BY id DESC LIMIT ? OFFSET ?"
	args = append(args, limit, offset)
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var out []AuditLogEntry
	for rows.Next() {
		var l AuditLogEntry
		var created any
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &l.PrevHash, &l.Hash, &created); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// PurgeOldAuditLogs deletes audit entries older than cutoff (audit
// retention housekeeping, run at startup; 90 days by default).
// P2-1:保留被删批次中**最新的一条**作为「锚」——链中下一行的 prev_hash 指向
// 它,整批删掉会让 VerifyAuditChain 在保留边界处必然报断链。锚行自身的哈希
// 仍会被校验,锚之前的条目(超出保留期)才真正消失。
func PurgeOldAuditLogs(db *sql.DB, cutoff time.Time) error {
	// cutoff 是绝对瞬时:用会话时区无关的瞬时字面量(裸墙钟字符串会被按 PG
	// 会话时区解释,进程 TZ 与会话时区不同时保留边界会偏 8 小时)。
	_, err := db.Exec(`DELETE FROM audit_logs a
		WHERE a.created_at < ?::timestamptz AND EXISTS (
			SELECT 1 FROM audit_logs b WHERE b.created_at < ?::timestamptz AND b.id > a.id)`,
		pgInstantArg(cutoff), pgInstantArg(cutoff))
	return err
}
