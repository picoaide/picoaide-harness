package appserver

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== §4.5「一应用一 driver 实例 + 一应用一连接，不复用」的落地点 =====
//
// 语义（不要把"不复用"读成"每请求新建"）：
//
//   - **一应用一份**：同一应用的所有请求共用**同一个** `*appdb.DB`（一个 driver 实例、
//     一组持有连接），跨应用**绝不共享**。这正是 §4.5 那行表格要保证的：
//     modernc 的 `vtab` 注册是**进程全局**的，跨应用共享 driver/连接就可能把
//     另一个应用的库暴露给错误的语句上下文；
//   - **不复用**指的是"不跨应用复用"，不是"不复用同一个句柄"；
//   - 同一应用的两个请求绝不并发使用同一句柄：§4.6 的每应用并发恒为 1 已经排除了它，
//     但这里仍用**每句柄互斥量**把它升级成结构保证（队列实现出问题、或有人直接调
//     ServeApp 时也不会并发共享连接）。
//
// 为什么不是每请求 Open/Close（曾实现过，已改）：`Open+Close` 实测 1.7–3.2 ms，
// 且每个句柄在池子里有两条 SQLite 连接 —— 每请求新建既白付"加固 + 金丝雀"的代价，
// 也会让同应用的两个请求各开一组连接。句柄池把这份代价摊到"首次请求 + 空闲回收"。

const (
	// appDBHandleMax 是进程内**同时持有**的应用库句柄上限。
	//
	// 数值来源：limits.AppDBHandleMax（= GlobalInstances，32）。理由：每请求必须先拿到
	// 执行槽才会用到库 ⇒ 同一时刻最多 32 个应用在跑；句柄上限取同一量级既不会误伤
	// （不会因为上限去关正在用的句柄），又给 fd 一个硬上界（每句柄 2 条 SQLite 连接 ⇒ 64 条）。
	appDBHandleMax = limits.AppDBHandleMax

	// appDBIdleTimeout 是句柄空闲回收时间。
	//
	// 它是**实现参数**（不是 §4 的平台上限，故不进 limits）：太久不用就释放 2 条连接
	// 与 SQLite 页缓存。2026-09-18 从 10 分钟收紧到 3 分钟 —— 理由是"几百个应用 +
	// 小内存机器"这个目标场景：每句柄 2 条连接各带一份页缓存，10 分钟意味着
	// "每个被访问过一次的应用"都会长期占着这份常驻；3 分钟仍覆盖"用户在一个应用里
	// 连续操作"的节奏（重开代价实测 1.7–3.2 ms），但把"偶尔用一次"的尾巴收得更紧。
	// 另有一条事件驱动的立即回收：应用下架/冻结/删除时 Server.EvictApp。
	appDBIdleTimeout = 3 * time.Minute
)

// appDBHandle 是池中的一条应用库句柄。
//
// 生命周期：acquire（返回时 mu 已被持有）→ 使用 → release。
// 只有 inflight == 0 的句柄才可被淘汰或关闭。
type appDBHandle struct {
	appID string
	db    *appdb.DB

	// mu 把"一应用一连接"从"队列保证"升级为"结构保证"。
	// acquire 返回前加锁、release 解锁 ⇒ 句柄在**使用期间**不可能被第二个请求拿到。
	mu sync.Mutex

	// inflight 是正在使用该句柄的请求数（正常恒为 0 或 1；>1 只可能出现在
	// 队列被绕开的防御性场景里，此时第二个请求会阻塞在 mu 上）。
	inflight int
	// lastUsed 是最近一次 acquire 的时刻（LRU/空闲淘汰依据，由池的时钟提供）。
	lastUsed time.Time
	// dirty 表示这条句柄必须在 release 时回收重建（见 appDBConn 的注释）。
	//
	// 用原子量而不是普通 bool：写它的可能是**宿主调用 goroutine**
	//（runtime 把 Dispatch 放进独立 goroutine 跑，见 runtime.callHost），
	// 而读它的可能是请求 goroutine —— 两者不共享锁，普通字段会被 race detector
	// 判为数据竞争（实测）。
	dirty atomic.Bool
	// uncached 表示这是"池满且无可淘汰"时的降级路径：用完即关、不进池。
	uncached bool
}

// appDBPool 是应用库句柄池（键 = app_id）。
type appDBPool struct {
	mu      sync.Mutex
	handles map[string]*appDBHandle
	now     func() time.Time
	// max 是池容量（缺省 appDBHandleMax；测试可调小）。
	max int
	// idle 是空闲回收阈值（缺省 appDBIdleTimeout；控制台可调，见 SetLimits）。
	idle time.Duration
}

func newAppDBPool(now func() time.Time) *appDBPool {
	return newAppDBPoolWithMax(now, appDBHandleMax)
}

// newAppDBPoolWithMax 用指定容量构造句柄池（生产走内存档位的并发数；测试可调小）。
func newAppDBPoolWithMax(now func() time.Time, max int) *appDBPool {
	if now == nil {
		now = time.Now
	}
	if max <= 0 {
		max = appDBHandleMax
	}
	return &appDBPool{handles: map[string]*appDBHandle{}, now: now, max: max, idle: appDBIdleTimeout}
}

// SetLimits 热替换池容量与空闲回收阈值（控制台保存后即时生效）。
//
// 收紧容量时不打断在途请求：超出部分按"最久未用且 inflight==0"逐个关闭，
// 全部在用则暂时超限（与 acquire 的降级路径同一精神：缓存策略不得让用户请求失败）。
func (p *appDBPool) SetLimits(max int, idle time.Duration) {
	if p == nil {
		return
	}
	if max <= 0 {
		max = appDBHandleMax
	}
	if idle <= 0 {
		idle = appDBIdleTimeout
	}
	p.mu.Lock()
	p.max = max
	p.idle = idle
	var closing []*appdb.DB
	for len(p.handles) > p.max {
		victim := p.oldestIdleLocked()
		if victim == nil {
			break
		}
		delete(p.handles, victim.appID)
		closing = append(closing, victim.db)
	}
	p.mu.Unlock()
	p.closeAllDBs(closing)
}

// Limits 返回当前容量与空闲阈值（控制台回读/测试断言用）。
func (p *appDBPool) Limits() (max int, idle time.Duration) {
	if p == nil {
		return 0, 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.max, p.idle
}

// sweepIdle 回收空闲超过 appDBIdleTimeout 的句柄，返回 (句柄数, 记账字节数)。
//
// 与 acquire 里的"顺手回收"是同一判据的**时间驱动**版本：acquire 只在有请求时才
// 扫描，几百个应用里"没人再访问"的那些句柄会一直留到下一次同应用请求（可能永远
// 不来）。后台 sweep 让它们按时归还（连接 + 页缓存 + driver 实例）。
func (p *appDBPool) sweepIdle() (int, int64) {
	if p == nil {
		return 0, 0
	}
	cutoff := p.now().Add(-p.idle)
	p.mu.Lock()
	var closing []*appdb.DB
	var freed int64
	for key, h := range p.handles {
		if h.inflight == 0 && h.lastUsed.Before(cutoff) {
			delete(p.handles, key)
			closing = append(closing, h.db)
			freed += appDBHandleBookkeepingBytes
		}
	}
	p.mu.Unlock()
	p.closeAllDBs(closing)
	return len(closing), freed
}

// evictApp 立即回收某应用的句柄（下架/冻结/删除时调用）；在用的句柄跳过。
func (p *appDBPool) evictApp(appID string) (int, int64) {
	if p == nil || appID == "" {
		return 0, 0
	}
	p.mu.Lock()
	h, ok := p.handles[appID]
	if !ok || h.inflight != 0 {
		p.mu.Unlock()
		return 0, 0
	}
	delete(p.handles, appID)
	p.mu.Unlock()
	p.closeAllDBs([]*appdb.DB{h.db})
	return 1, appDBHandleBookkeepingBytes
}

// appDBHandleBookkeepingBytes 是"一个应用库句柄被回收"的**记账量**（供日志与
// 归还 OS 的触发条件使用，不是精确值）：两条 SQLite 连接各一份页缓存
// （appdb 里把 cache_size 限到 1 MiB）= 2 MiB。
const appDBHandleBookkeepingBytes = 2 << 20

// acquire 取得某应用的句柄，返回时该句柄已被**独占**（h.mu 已加锁）。
//
// 未命中则打开并做"打开后校验"（归属 + 可用性）。打开在池锁内进行：
// 打开约 1.7–3.2 ms 且只在"首次请求 / 空闲回收之后"发生（10 分钟一次量级），
// 用池锁换掉一整套 singleflight 复杂度是划算的；句柄**使用期间**不持池锁。
//
// 上限处理：池满时按 LRU 淘汰空闲句柄；若全部在用（理论上不会发生：全局并发 32
// 与池容量同值），退化为"临时句柄、用完即关"而不是报错 —— 不因为缓存策略失败
// 就让用户的请求失败。
func (p *appDBPool) acquire(ctx context.Context, dataRoot, appID string) (*appDBHandle, *apperr.Error) {
	var closing []*appdb.DB

	// 空闲阈值先算出来：**本次请求的应用**如果也空闲超时了，同样要回收重建
	//（"空闲"的判据是"距上次使用超过阈值"，与"是不是这次要用的应用"无关）。
	cutoff := p.now().Add(-p.idle)

	p.mu.Lock()
	if h, ok := p.handles[appID]; ok {
		// 只有 inflight == 0 时才读 h.dirty：正在被使用的句柄，其 dirty 由当前持有者
		// 在 h.mu 下写（并发读会构成数据竞争）。而"未被使用"的句柄，其 dirty 的写
		// 发生在持有者 release 取 p.mu 之前 ⇒ 这里（拿 p.mu 之后）读它是有序的。
		if h.inflight == 0 && (h.dirty.Load() || h.lastUsed.Before(cutoff)) {
			// 标脏（连接污染 / 请求被杀）或空闲过久 ⇒ 关掉重建，绝不复用。
			delete(p.handles, appID)
			closing = append(closing, h.db)
		} else {
			h.inflight++
			h.lastUsed = p.now()
			h.mu.Lock()
			p.mu.Unlock()
			p.closeAllDBs(closing)
			return h, nil
		}
	}
	// 其余句柄的空闲回收（顺手做，代价是遍历 ≤32 个键）。
	for key, h := range p.handles {
		if h.inflight == 0 && h.lastUsed.Before(cutoff) {
			delete(p.handles, key)
			closing = append(closing, h.db)
		}
	}
	uncached := false
	if len(p.handles) >= p.max {
		if victim := p.oldestIdleLocked(); victim != nil {
			delete(p.handles, victim.appID)
			closing = append(closing, victim.db)
		} else {
			// 池满且全在用：降级为临时句柄（不进池），绝不报错。
			uncached = true
		}
	}
	p.mu.Unlock()
	p.closeAllDBs(closing)

	// 打开（不持池锁：它可能要几毫秒，且失败路径也要走这里）。
	db, err := appdb.Open(ctx, appdb.Options{DataRoot: dataRoot, AppID: appID})
	if err != nil {
		return nil, apperr.From(err)
	}
	if verr := verifyAppDBHandle(ctx, dataRoot, appID, db); verr != nil {
		_ = db.Close()
		return nil, verr
	}

	h := &appDBHandle{appID: appID, db: db, inflight: 1, lastUsed: p.now(), uncached: uncached}
	if uncached {
		h.mu.Lock()
		return h, nil
	}

	p.mu.Lock()
	// 竞争窗口：期间已有别的请求把同一应用的句柄放进池（队列被绕开时的并发 acquire）。
	if exist, ok := p.handles[appID]; ok && !exist.dirty.Load() {
		exist.inflight++
		exist.lastUsed = p.now()
		exist.mu.Lock()
		p.mu.Unlock()
		go func() { _ = db.Close() }() // 多打开的那一份立刻关掉（它从未被使用）
		return exist, nil
	}
	p.handles[appID] = h
	p.mu.Unlock()

	h.mu.Lock()
	return h, nil
}

// release 归还句柄：解锁、减计数，并按需回收（脏句柄 / 池满降级的临时句柄）。
//
// **只在 inflight 归零时才关闭**：正常路径下"释放句柄"必然早于"释放队列槽位"
// （defer 的 LIFO 顺序），所以此时不可能有别的请求在用同一句柄；但队列若被绕开
// （直接调 ServeApp / 队列实现出错），第二个请求可能已经 acquire 了同一个句柄 ——
// 那时把句柄关掉就是"关掉正在使用的连接"。这种情况留给**最后一个**使用者去回收。
func (p *appDBPool) release(h *appDBHandle, recycle bool) {
	if h == nil {
		return
	}
	dirty := recycle || h.dirty.Load()
	h.mu.Unlock()

	p.mu.Lock()
	if h.inflight > 0 {
		h.inflight--
	}
	var closeDB *appdb.DB
	switch {
	case h.uncached:
		// 降级句柄从不进池：最后一个使用者负责关闭。
		if h.inflight == 0 {
			closeDB = h.db
		}
	case dirty && h.inflight == 0:
		if cur, ok := p.handles[h.appID]; ok && cur == h {
			delete(p.handles, h.appID)
		}
		closeDB = h.db
	}
	p.mu.Unlock()

	if closeDB != nil {
		_ = closeDB.Close()
	}
}

// oldestIdleLocked 返回最久未用的空闲句柄（调用方持锁）。
func (p *appDBPool) oldestIdleLocked() *appDBHandle {
	var victim *appDBHandle
	for _, h := range p.handles {
		if h.inflight > 0 {
			continue
		}
		if victim == nil || h.lastUsed.Before(victim.lastUsed) {
			victim = h
		}
	}
	return victim
}

// closeAll 关闭全部句柄（Server.Close 调用）。
func (p *appDBPool) closeAll() error {
	p.mu.Lock()
	dbs := make([]*appdb.DB, 0, len(p.handles))
	for key, h := range p.handles {
		dbs = append(dbs, h.db)
		delete(p.handles, key)
	}
	p.mu.Unlock()
	return p.closeAllDBs(dbs)
}

func (p *appDBPool) closeAllDBs(dbs []*appdb.DB) error {
	var first error
	for _, db := range dbs {
		if err := db.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// size 返回池中句柄数（诊断/测试断言用）。
func (p *appDBPool) size() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.handles)
}

// lookup 返回某应用当前的句柄（**不**加锁、不增引用；测试断言用）。
func (p *appDBPool) lookup(appID string) *appDBHandle {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.handles[appID]
}

// verifyAppDBHandle 是"打开后立即做一次校验"（归属 + 可用性），fail-closed。
//
//  1. **归属**：句柄的库文件必须落在 `<DataRoot>/apps/<app_id>/` 下 —— 路径由宿主推导
//     （§4.4：宿主函数不得接受路径），这里断言一次，防止池的键写错把别的应用的库
//     交给本应用（§4.5 的核心不变量，属于"越权级"错误，必须 fail-loud）；
//  2. **可用性**：真的跑一条 `SELECT 1`。它同时验证了连接加固 + 金丝雀之后的
//     查询路径是通的（打开成功不等于能查）。
func verifyAppDBHandle(ctx context.Context, dataRoot, appID string, db *appdb.DB) *apperr.Error {
	if db == nil {
		return apperr.New(apperr.CodeInternal, "应用库句柄为空（平台缺陷）")
	}
	wantDir := filepath.Join(dataRoot, limits.AppsDirName, appID)
	if !samePath(filepath.Dir(db.Path()), wantDir) {
		return apperr.New(apperr.CodeInternal, "应用库路径与应用标识不一致（平台缺陷）").
			WithDetail("app_id", appID).
			WithHint("这是平台装配缺陷（句柄键与库路径不符），已按 fail-closed 拒绝使用该句柄")
	}
	res, err := db.Query(ctx, abi.SQLParams{SQL: "SELECT 1"})
	if err != nil {
		return apperr.From(err)
	}
	if len(res.Rows) != 1 {
		return apperr.New(apperr.CodeInternal, "应用库打开后自检失败（平台缺陷）").
			WithDetail("rows", len(res.Rows))
	}
	return nil
}

// appDBConn 是交给 hostcap 的 capapi.DB：包一层只做一件事 —— 记下"这条连接已被污染"
// 的信号，供 release 决定**回收句柄**（把 appdb 的永久 poison 变成一次性的请求级代价）。
//
// # 为什么必须回收（跨模块耦合，已在交付说明里点名）
//
// appdb 在单语句超时/取消时打 `poisoned` 标记，而它的恢复路径要么是"下一次调用重连"
// （单语句超时）、要么是**会话边界**（Close / 句柄回收；事务超时还带写闸 deadTx）。
// 句柄池不回收，被污染的那条句柄就会一直留在池里 —— 一次慢查询/一次事务超时至少
// 要多付一次失败请求，极端情况下"应用直到进程重启都不可用"（审计 P0-2 的现场）。
//
// 判据是 **appdb 导出的 reason 常量**（不是字面量）：生产者与消费者共用同一个值，
// "两端各写一个字符串"在类型层面不可能再发生 —— 老实现的生产者是
// `transaction_timeout` 而消费者只认 `tx_timeout`，后者全仓没有生产者，
// 于是事务超时永远不被回收（审计 P0-2）。
// 另外在请求被杀时也回收（见 serveWasm：abandonedStatementPossible），
// 覆盖"语句被放弃但 appdb 来不及返回错误"的入口。
type appDBConn struct {
	*appdb.DB
	handle *appDBHandle
}

func (c *appDBConn) Define(ctx context.Context, p abi.DBDefineParams) (abi.DBDefineResult, error) {
	res, err := c.DB.Define(ctx, p)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Query(ctx context.Context, p abi.SQLParams) (abi.QueryResult, error) {
	res, err := c.DB.Query(ctx, p)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Exec(ctx context.Context, p abi.SQLParams) (abi.ExecResult, error) {
	res, err := c.DB.Exec(ctx, p)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Begin(ctx context.Context) (abi.TxResult, error) {
	res, err := c.DB.Begin(ctx)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Commit(ctx context.Context, p abi.TxParams) error {
	err := c.DB.Commit(ctx, p)
	c.notePoison(err)
	return err
}

func (c *appDBConn) Rollback(ctx context.Context, p abi.TxParams) error {
	err := c.DB.Rollback(ctx, p)
	c.notePoison(err)
	return err
}

// notePoison 识别 appdb 的污染标记（只标记，不改变错误本身）。
//
// 判据是 appdb 的导出常量（唯一真源），不做字面量匹配：见 appDBConn 的注释。
func (c *appDBConn) notePoison(err error) {
	if err == nil || c == nil || c.handle == nil {
		return
	}
	e, ok := apperr.As(err)
	if !ok {
		return
	}
	reason, _ := e.Details["reason"].(string)
	switch reason {
	case appdb.ReasonStatementTimeout, appdb.ReasonTransactionTimeout:
		c.handle.dirty.Store(true)
	}
}

// 编译期断言：包装类型仍然是 hostcap 需要的能力面。
var _ capapi.DB = (*appDBConn)(nil)
