package serverstore

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/util"
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
	// AppID 是 wasm 应用维度(0069,可空):非应用审计为空串(库里 NULL)。
	AppID string `json:"app_id"`
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
	return auditLog(db, "", username, action, detail)
}

// AuditLogTx 在**调用方事务**内追加一条审计条目(2026-09-23,P0-2)。
//
// 为什么需要它:异步 worker(AuditLog/auditLog)自带事务,业务写与审计写必然
// 分成两次提交 —— 业务写成功而审计写失败,就出现"库改了、审计零痕迹";反过来
// 业务写回滚而审计已提交,就出现"审计说改了、其实没改"。管理端
// PUT /api/server/admin/providers/:id 这类「改配置即改钱」的路径不允许这两种
// 不一致,所以它的审计必须与业务写同事务。
//
// 链口径与 AuditLog 完全一致(v1,hash_version=1,app_id 为 NULL):同一个
// sha256(prev|username|action|detail|created_at),同一个固定 advisory lock
// (事务级,事务结束自动释放)串行化「读链尾 → 计算 → 插入」。detail 与
// AuditLog 一样先过 util.EscapeControl(入口唯一,保证"落库内容 == 计算哈希
// 的输入",否则 VerifyAuditChain 会报断链)。
//
// 与异步 worker 的无死锁论证:本函数在事务**末尾**取审计锁,此前只持有
// gateway_providers/models 的行锁;worker 持有审计锁时只插 audit_logs(新行),
// 不碰我们的行 ⇒ 不存在环。
func AuditLogTx(tx *sql.Tx, username, action, detail string) error {
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
	now := time.Now().UTC().Format(time.RFC3339)
	detail = util.EscapeControl(detail)
	sum := sha256.Sum256([]byte(auditHashPayload(prevHash, username, action, detail, now)))
	_, err := tx.Exec("INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at, app_id, hash_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
		username, action, detail, prevHash, hex.EncodeToString(sum[:]), now, nil, auditHashVersionLegacy)
	return err
}

// AuditLogApp 与 AuditLog 相同,但把条目关联到一个 **wasm 应用**(迁移 0069
// 新增的 audit_logs.app_id,§4.9「审计的 app 维度」):发布/上下架/冻结/删除/
// 换票签发这类操作必须答得出"谁在什么时候用了哪个应用"。
//
// 链口径版本化(0069,只是**追加**一种口径,老调用点行为逐字节不变):
//   - hash_version=1(0048 老口径,不含 app_id):老行与所有非应用审计仍写 1;
//   - hash_version=2:链输入末尾追加 "|app_id"。
//
// 加列不会改变老行的链输入,老行天然仍可校验;VerifyAuditChain 按 hash_version
// 选算法,所以新旧行可以在同一条链里共存,而篡改 app_id 会立刻被链校验发现。
func AuditLogApp(db *sql.DB, appID, username, action, detail string) error {
	// app_id 即域名标签(§4.1/§4.8),不区分大小写 ⇒ 入链前统一小写,
	// 否则 ListAuditLogsByApp 的小写查询会查不到同一应用的历史条目。
	return auditLog(db, strings.ToLower(strings.TrimSpace(appID)), username, action, detail)
}

// auditLog 是 AuditLog / AuditLogApp 的共同实现(appID 为空 = 0048 老口径)。
func auditLog(db *sql.DB, appID, username, action, detail string) error {
	// F16(审计 2026-09-11):审计写路径改为**每 DB 单 worker 串行 + 批量**。
	// 旧实现每次审计都单独开事务、取全局 advisory lock、读链尾、插入、提交;
	// 高并发登录/管理操作会在这把全局锁上排队,把请求延迟整体拉高。
	// 现在请求仍同步等待结果(错误语义不变),但 N 条审计合并为一个事务、
	// 一次锁获取,DB 往返与锁竞争降为 1/N;worker 空闲 60s 自动退出,
	// 测试的多临时库不会积累常驻 goroutine。
	w := auditWorkerFor(db)
	// 审计明细里拼着**应用作者可控**的字符串（`app:<id> 「<title>」` 的 title 由作者自填，
	// 见 internal/wasmapp/api/handlers.go 与 rows.go）。消费端（psql、日志查看器、
	// 导出脚本）按"一条审计 = 一行"读，作者在 title 里放一个 `\n` 就能凭空造出一行
	// 伪造记录（例如伪造一条管理员操作）。入口处统一转义 CR/LF/控制字符：
	// 内容不丢、行结构不可伪造（判据 = 落库 detail 的换行数为 0）。
	// 实现与日志侧同一份（util.EscapeControl），避免两处对"哪些字符算控制字符"漂移。
	req := auditRequest{appID: appID, username: username, action: action, detail: util.EscapeControl(detail), done: make(chan error, 1)}
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
	// appID 非空时本条目带应用维度(§4.9):链口径升到 hash_version=2。
	appID string
	done  chan error
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
//
// R4-C-5(审计 2026-09-23,P2):"部分成功"只在**事务仍然可用**时成立。事务一旦
// 被判废(SAVEPOINT 本身发不出去 / `ROLLBACK TO SAVEPOINT` 也失败),函数虽然
// 返回逐条错误,`defer tx.Rollback()` 会把**此前已经插入的行一起丢弃** —— 那些
// 行的 errs[i] 仍是 nil,调用方(worker → r.done)因此被告知"这几条审计写成功了",
// 实际一条都没落库。方向恰好与 FIX-12 的目标("审计丢失必须可观测")相反,而且
// 既不计数(auditDroppedEntries 只在 worker 收到逐条错误时 +1)也不打日志。
//
// 修法:事务不可用 ⇒ **整批**报失败(failAll(...,0))。"要么全部成功、要么如实
// 报告失败"这个语义与返回值一致;部分成功路径(errs[i]!=nil 只标记第 i 条、
// 其余照常提交)保持不变。
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
		if fn := auditBatchFaultHook.Load(); fn != nil {
			// 仅测试注入：在**建立保存点之前**对事务做一步（例如发一条必然报错的
			// 语句把事务打成 aborted），用来确定性地构造"SAVEPOINT 发不出去"这
			// 条路径。生产恒为 nil（见 audit_batch_fault_test.go 的口径说明）。
			(*fn)(auditBatchExecer{tx: tx}, i)
		}
		// 保存点名固定:PG 里重名 SAVEPOINT 会替换旧的,ROLLBACK TO 之后
		// 保存点仍然存在,可继续复用。
		if _, err := tx.Exec("SAVEPOINT audit_row"); err != nil {
			// 事务已不可用(通常是被 PG 判废)。此处**必须整批报失败**:函数随即
			// return、`defer tx.Rollback()` 会把 errs[0..i-1] 那几条已插入的行一起
			// 丢弃 —— 若只标 errs[i..] 为失败,调用方会把 0..i-1 当成"写成功"
			// (R4-C-5:报成功但实际丢失,且零日志、零 dropped 计数)。
			log.Printf("audit: batch aborted at entry %d/%d, whole batch rolled back: %v", i, len(batch), err)
			return failAll(err, 0)
		}
		now := time.Now().UTC().Format(time.RFC3339)
		// 链口径按行选择(0069):带应用维度的行写 v2,其余保持 v1 —— 同一批
		// 里两种口径可以混排,prevHash 的推进与口径无关(链只认上一行的 hash)。
		payload := auditHashPayload(prevHash, r.username, r.action, r.detail, now)
		version := auditHashVersionLegacy
		if r.appID != "" {
			payload = auditHashPayloadV2(prevHash, r.username, r.action, r.detail, now, r.appID)
			version = auditHashVersionApp
		}
		sum := sha256.Sum256([]byte(payload))
		hash := hex.EncodeToString(sum[:])
		if _, err := tx.Exec("INSERT INTO audit_logs (username, action, detail, prev_hash, hash, created_at, app_id, hash_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			r.username, r.action, r.detail, prevHash, hash, now, nullIfEmpty(r.appID), version); err != nil {
			// 回滚这一条,保住此前已插入的条目;失败则整批作废(同上的理由:
			// 事务不可用时已插入的行会被 defer 的 Rollback 丢掉,不能报成功)。
			if _, rbErr := tx.Exec("ROLLBACK TO SAVEPOINT audit_row"); rbErr != nil {
				log.Printf("audit: rollback to savepoint failed at entry %d/%d, whole batch rolled back: %v", i, len(batch), rbErr)
				return failAll(errors.Join(err, rbErr), 0)
			}
			errs[i] = err
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

// auditHashVersionLegacy / auditHashVersionApp 是链接口径版本(0069):
// v1 = 0048 的 sha256(prev|username|action|detail|created_at);
// v2 = 在末尾追加 app_id(链输入变化 ⇒ 篡改 app_id 会断链)。
const (
	auditHashVersionLegacy int16 = 1
	auditHashVersionApp    int16 = 2
)

// auditBatchExecer 是故障注入钩子能看到的事务能力面(**只有 Exec**):
// 让测试能在建立保存点之前把事务打成 aborted(例如 `SELECT 1/0`),不夸大面。
type auditBatchExecer struct{ tx *sql.Tx }

func (e auditBatchExecer) Exec(query string, args ...any) (sql.Result, error) {
	return e.tx.Exec(query, args...)
}

// auditBatchFaultHook 是**仅测试**的故障注入点(生产恒为 nil)。
//
// 为什么要它:writeAuditBatch 的"SAVEPOINT 失败"路径无法在真实驱动上确定性构造
// —— SAVEPOINT 是事务里的第一条语句,只有事务**已经**被 PG 判废时才会失败,而要
// 把事务打成 aborted 就必须先发一条会报错的语句(它自己会在事务里留下错误状态)。
// 钩子在"建立保存点之前"执行,测试注入 `SELECT 1/0` 即可确定性地走到那条路径;
// 判据见 audit_batch_fault_test.go(修法前的 failAll(err,i) 会让该用例红)。
//
// 与 files_reaper.go 的 reapAfterListHook/reapRecheckHook 同一范式:atomic.Pointer
// 存函数值,避免 worker goroutine 与测试之间的 DATA RACE。
var auditBatchFaultHook atomic.Pointer[func(auditBatchExecer, int)]

// auditHashPayload mirrors the payload used at write time (same layout).
func auditHashPayload(prevHash, username, action, detail, createdAt string) string {
	return prevHash + "|" + username + "|" + action + "|" + detail + "|" + createdAt
}

// auditHashPayloadV2 是 0069 之后的带应用维度口径:老口径 + "|" + app_id。
func auditHashPayloadV2(prevHash, username, action, detail, createdAt, appID string) string {
	return auditHashPayload(prevHash, username, action, detail, createdAt) + "|" + appID
}

// VerifyAuditChain walks the audit log from oldest to newest and verifies
// every hash link. Returns the first broken entry id (or 0 if intact).
// Rows written before the 0048 migration have hash=” and are skipped
// (the chain starts at the first post-migration entry).
// P2-1:保留策略清理后,链的起点是 PurgeOldAuditLogs 保留的「锚」(其
// prev_hash 指向已删除的更早条目),故第一个条目只校验自身哈希、不校验
// 链尾衔接;其后每条仍必须与上一条 hash 严格衔接。
func VerifyAuditChain(db *sql.DB) (int64, error) {
	rows, err := db.Query("SELECT id, username, action, detail, prev_hash, hash, created_at, hash_version, app_id FROM audit_logs ORDER BY id ASC")
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
		// hash_version/app_id 由 0069 加入:老行是 1/NULL,v2 行带 app_id。
		var version int16
		var appID sql.NullString
		if err := rows.Scan(&id, &username, &action, &detail, &rowPrev, &rowHash, &createdAny, &version, &appID); err != nil {
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
		// 按行的链接口径版本选算法(0069):不认识的高版本必须报错而不是
		// 静默按 v1 算 —— 后者会把"无法校验"伪装成"链完好"。
		var payload string
		switch version {
		case auditHashVersionApp:
			payload = auditHashPayloadV2(rowPrev, username, action, detail, created, appID.String)
		case auditHashVersionLegacy:
			payload = auditHashPayload(rowPrev, username, action, detail, created)
		default:
			return id, fmt.Errorf("unsupported audit hash version %d", version)
		}
		sum := sha256.Sum256([]byte(payload))
		if hex.EncodeToString(sum[:]) != rowHash {
			return id, errors.New("audit hash mismatch")
		}
		prevHash = rowHash
	}
	return 0, rows.Err()
}

// ListAuditLogsPagedFiltered returns one page of audit entries (newest
// first) optionally filtered by action/username (审计 M8), plus the total
// for the filtered set.
func ListAuditLogsPagedFiltered(db *sql.DB, offset, limit int, action, username string) ([]AuditLogEntry, int64, error) {
	return listAuditLogs(db, offset, limit, action, username, "")
}

// ListAuditLogsByApp 返回某个 wasm 应用的审计条目(最新在前),§4.9「审计的
// app 维度」的读取入口:发布/上下架/冻结/删除/换票这类操作按应用可查。
// appID 为空即拒(空串聚合全部应用 = 会把应用维度静默变成全局视图)。
func ListAuditLogsByApp(db *sql.DB, appID string, limit int) ([]AuditLogEntry, error) {
	if strings.TrimSpace(appID) == "" {
		return nil, errors.New("audit by app: app_id 不能为空")
	}
	if limit <= 0 {
		limit = 100
	}
	logs, _, err := listAuditLogs(db, 0, limit, "", "", strings.ToLower(strings.TrimSpace(appID)))
	return logs, err
}

// listAuditLogs 是所有审计分页查询的唯一实现(action/username/appID 为空 =
// 不过滤;appID 的过滤走 0069 的 idx_audit_logs_app)。
func listAuditLogs(db *sql.DB, offset, limit int, action, username, appID string) ([]AuditLogEntry, int64, error) {
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
	if appID != "" {
		where += " AND app_id = ?"
		args = append(args, appID)
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
	q := "SELECT id, username, action, detail, prev_hash, hash, created_at, app_id FROM audit_logs"
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
		var appIDAny sql.NullString
		if err := rows.Scan(&l.ID, &l.Username, &l.Action, &l.Detail, &l.PrevHash, &l.Hash, &created, &appIDAny); err != nil {
			return nil, 0, err
		}
		l.CreatedAt = parseSQLTime(created)
		l.AppID = appIDAny.String
		out = append(out, l)
	}
	return out, total, rows.Err()
}

// PurgeOldAuditLogs deletes audit entries older than cutoff (audit
// retention housekeeping, run at startup; 90 days by default).
// P2-1:保留被删批次中**最新的一条**作为「锚」——链中下一行的 prev_hash 指向
// 它,整批删掉会让 VerifyAuditChain 在保留边界处必然报断链。锚行自身的哈希
// 仍会被校验,锚之前的条目(超出保留期)才真正消失。
// R4-D-4(审计 2026-09-23,P2):返回值从 error 变成 (删除行数, error) —— 保留策略
// 现在有一个**周期执行者**(`internal/auditretention`),它需要"这次清了什么"才能
// 打出一条可观测的日志(否则只能证明"跑过了",不能证明"清掉了")。
func PurgeOldAuditLogs(db *sql.DB, cutoff time.Time) (int64, error) {
	// cutoff 是绝对瞬时:用会话时区无关的瞬时字面量(裸墙钟字符串会被按 PG
	// 会话时区解释,进程 TZ 与会话时区不同时保留边界会偏 8 小时)。
	res, err := db.Exec(`DELETE FROM audit_logs a
		WHERE a.created_at < ?::timestamptz AND EXISTS (
			SELECT 1 FROM audit_logs b WHERE b.created_at < ?::timestamptz AND b.id > a.id)`,
		pgInstantArg(cutoff), pgInstantArg(cutoff))
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, nil
}
