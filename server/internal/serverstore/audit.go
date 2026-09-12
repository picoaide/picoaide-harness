package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ---- FIX-12(审计 2026-09-12,P1):审计丢失必须可观测 + 不变式必须有执行者 ----
//
// 缺陷形态(两半):
//  1. **丢失不被发现**:80 个调用点全是 `_ = serverstore.AuditLog(...)`,
//     失败分支既不写日志也不计数;worker 里任何一条失败都会让整批回滚
//     (20 条里坏 1 条 = 丢 20 条),而且不重试。安全审计里"静默丢条目"
//     等价于"没有审计"。
//  2. **不变式没有执行者**:VerifyAuditChain(链校验器)在生产代码里零调用
//     —— 只有测试调它。哈希链算法是对的,但没有任何运行路径会去验证它。
//
// 这里补上三件事(按代价从低到高):
//   - 每次失败都打 ERROR 日志(只记 action/username,**不记 detail** ——
//     detail 里可能有敏感值,不能复制进日志)+ 进程内计数器;
//   - worker 对失败条目做**有界重试**,批量写改成 SAVEPOINT 逐条隔离的
//     「允许部分成功」;
//   - 给 VerifyAuditChain 两个执行者:启动校验(cmd/server)+ admin 只读端点。
//
// 计数器是进程内的(不落库):它的用途是"让丢失立刻可见"——运维在日志里
// 看到 ERROR、在 /server-info 与 /audit/verify 里看到非零计数。故意不落库,
// 避免"审计写入失败时还要再写一次审计"的循环依赖。
var (
	// auditWriteFailures 累计失败的审计写入次数(含超时/入队失败/逐条失败)。
	auditWriteFailures atomic.Int64
	// auditDroppedEntries 累计**彻底没落库**的条目数(重试后仍失败)。
	auditDroppedEntries atomic.Int64
	// auditRetries 累计重试次数(可观测重试是否真的在发生)。
	auditRetries atomic.Int64
)

// AuditWriteStats 返回进程内审计写入失败计数(FIX-12 可观测性)。
// failures = 失败事件数,dropped = 彻底丢失的条目数,retries = 重试次数。
func AuditWriteStats() (failures, dropped, retries int64) {
	return auditWriteFailures.Load(), auditDroppedEntries.Load(), auditRetries.Load()
}

// auditWriteFailure 记录一次审计写入失败:ERROR 日志 + 计数。
// 只记 action/username 与计数,detail 一律不进日志。
func auditWriteFailure(reason, username, action string, dropped int64) {
	failures := auditWriteFailures.Add(1)
	if dropped > 0 {
		auditDroppedEntries.Add(dropped)
	}
	log.Printf("ERROR audit: %s action=%q username=%q dropped_entries=%d total_failures=%d total_dropped=%d",
		reason, action, username, dropped, failures, auditDroppedEntries.Load())
}

// ---- FIX-12:VerifyAuditChain 的执行者(启动校验 + 结果缓存) ----
//
// 链校验是对整个审计表的全表扫描,不能挂在每个请求上;而"启动时校验一次、
// 结果对外可查"既给了不变式一个执行者,又不引入新路由(路由唯一真源是
// internal/router,增删路由会让 test mirror 与生产路由表失配)。
// 这里保存最近一次校验的结果,由已注册的 admin server-info 端点读出
// (见 serverauth/sysinfo.go 的 auditHealth)。
var (
	auditChainMu      sync.Mutex
	auditChainChecked bool
	auditChainBroken  int64
	auditChainAt      string
	auditChainErr     string
)

// RecordAuditChainCheck 记录一次链校验结果(由启动路径调用;重复调用覆盖为
// 最新结果)。
func RecordAuditChainCheck(brokenID int64, err error) {
	auditChainMu.Lock()
	defer auditChainMu.Unlock()
	auditChainChecked = true
	auditChainBroken = brokenID
	auditChainAt = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		auditChainErr = err.Error()
	} else {
		auditChainErr = ""
	}
}

// AuditChainStatus 返回最近一次链校验的结果。checked=false 表示本进程还没
// 校验过(例如测试直接构造 handler,或启动路径提前退出)。
func AuditChainStatus() (checked bool, intact bool, brokenID int64, checkedAt, errMsg string) {
	auditChainMu.Lock()
	defer auditChainMu.Unlock()
	intact = auditChainChecked && auditChainBroken == 0 && auditChainErr == ""
	return auditChainChecked, intact, auditChainBroken, auditChainAt, auditChainErr
}

// RunAndRecordAuditChainCheck 执行一次链校验并记录结果(FIX-12 启动执行者)。
// 返回 brokenID 与 error,便于调用方打日志。
func RunAndRecordAuditChainCheck(db *sql.DB) (int64, error) {
	brokenID, err := VerifyAuditChain(db)
	RecordAuditChainCheck(brokenID, err)
	return brokenID, err
}

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
			auditWriteFailure("queue timeout", username, action, 1)
			return errors.New("audit queue timeout")
		}
	}
	select {
	case err := <-req.done:
		// FIX-12:失败已经由 worker 打点("entry dropped after retries",含
		// action/username 与重试结果)。这里**不重复计数** —— 否则同一条丢失
		// 会在 failures/dropped 上被记两次,计数器就不可信了。
		return err
	case <-time.After(15 * time.Second):
		// worker 还没回话:这一条的结果未知(可能稍后写成功)。按"失败事件"
		// 计数但**不**计入 dropped —— 宁可少报丢失,也不能虚报(虚报会掩盖
		// 真实的丢失)。
		auditWriteFailure("write timeout (outcome unknown)", username, action, 0)
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
			err := w.writeBatchWithRetry(batch)
			for i, r := range batch {
				if err[i] != nil {
					// 权威的"丢失"打点在这里:worker 是唯一知道"重试过、
					// 仍然失败"的地方,所以 dropped 计数只在这里 +1。
					auditWriteFailure("entry dropped after retries", r.username, r.action, 1)
				}
				r.done <- err[i]
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

// auditWriteAttempts 是一批审计写失败后的额外重试轮数(FIX-12)。
const auditWriteAttempts = 2

// auditRetryBackoff 是重试之间的退避(连接类故障通常瞬时,给一点时间)。
const auditRetryBackoff = 20 * time.Millisecond

// writeBatchWithRetry 写一批审计条目,**只重试失败的那些**并返回逐条错误。
//
// 为什么只重试失败的行:writeAuditBatch 现在允许部分成功(见其注释),成功
// 的行已经提交。若把整批重投,审计链里就会出现两条同样内容的记录 ——
// 重复条目比丢失更难解释,也破坏了"一条操作一条审计"的语义。
func (w *auditWorker) writeBatchWithRetry(batch []auditRequest) []error {
	errs := writeAuditBatch(w.db, batch)
	for attempt := 0; attempt < auditWriteAttempts; attempt++ {
		var retry []auditRequest
		var idx []int
		for i, e := range errs {
			if e != nil {
				retry = append(retry, batch[i])
				idx = append(idx, i)
			}
		}
		if len(retry) == 0 {
			return errs
		}
		auditRetries.Add(int64(len(retry)))
		time.Sleep(auditRetryBackoff)
		again := writeAuditBatch(w.db, retry)
		for k, e := range again {
			errs[idx[k]] = e
		}
	}
	return errs
}

// writeAuditBatch 在一个事务内串行追加一批审计条目,保持哈希链不分叉。
// advisory lock 仍保留(跨实例互斥),但每批只获取一次。
//
// FIX-12:返回**逐条**错误(长度恒为 len(batch)),并且**允许部分成功** ——
// 每条用 SAVEPOINT 隔离,单条失败只回滚它自己,其余照常提交。此前任何一条
// 失败都走 `defer tx.Rollback()` 丢掉整批:一批最多 20 条,坏 1 条 = 丢 20 条。
func writeAuditBatch(db *sql.DB, batch []auditRequest) []error {
	errs := make([]error, len(batch))
	failAll := func(e error, from int) []error {
		for i := from; i < len(errs); i++ {
			errs[i] = e
		}
		return errs
	}
	tx, err := db.Begin()
	if err != nil {
		return failAll(err, 0)
	}
	defer tx.Rollback()
	if _, err := tx.Exec("SELECT pg_advisory_xact_lock(?)", auditChainLockKey); err != nil {
		return failAll(err, 0)
	}
	var prevHash string
	if err := tx.QueryRow("SELECT hash FROM audit_logs ORDER BY id DESC LIMIT 1").Scan(&prevHash); err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			return failAll(err, 0)
		}
		prevHash = ""
	}
	inserted := 0
	for i, r := range batch {
		// 保存点名固定:PG 里重名 SAVEPOINT 会替换旧的,ROLLBACK TO 之后
		// 保存点仍然存在,可继续复用。
		if _, err := tx.Exec("SAVEPOINT audit_row"); err != nil {
			// 事务已不可用(通常是被 PG 判废):剩余条目一并失败。
			return failAll(err, i)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		payload := prevHash + "|" + r.username + "|" + r.action + "|" + r.detail + "|" + now
		sum := sha256.Sum256([]byte(payload))
		hash := hex.EncodeToString(sum[:])
		if _, err := tx.Exec("INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			r.username, r.action, r.detail, prevHash, hash, now); err != nil {
			errs[i] = err
			// 回滚这一条,保住此前已插入的条目;失败则整批作废。
			if _, rbErr := tx.Exec("ROLLBACK TO SAVEPOINT audit_row"); rbErr != nil {
				errs[i] = err
				return failAll(rbErr, i+1)
			}
			continue
		}
		prevHash = hash
		inserted++
	}
	if inserted == 0 {
		// 全部失败:交给 defer 的 Rollback,不必 Commit。
		return errs
	}
	if err := tx.Commit(); err != nil {
		return failAll(err, 0)
	}
	return errs
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
