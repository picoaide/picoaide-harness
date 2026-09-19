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
//     一组持有连接：1 写 + limits.AppDBReaders 读），跨应用**绝不共享**。这正是 §4.5
//     那行表格要保证的：modernc 的 `vtab` 注册是**进程全局**的，跨应用共享 driver/连接
//     就可能把另一个应用的库暴露给错误的语句上下文；
//   - **不复用**指的是"不跨应用复用"，不是"不复用同一个句柄"；
//   - **句柄可以被同应用的多个请求同时使用**（2026-09-19 起）：并发控制下沉到 appdb
//     —— 读走只读连接池（WAL 下真正并发），写由 appdb 的 writeMu 串行。句柄本身只保证
//     "在用的句柄不会被关掉"（inflight 计数 + dirty 标记，见 acquire/release）。
//
// 为什么不是每请求 Open/Close（曾实现过，已改）：`Open+Close` 实测 1.7–3.2 ms，
// 且每个句柄在池子里有 1+N 条 SQLite 连接 —— 每请求新建既白付"加固 + 金丝雀"的代价，
// 也会让同应用的两个请求各开一组连接。句柄池把这份代价摊到"首次请求 + 空闲回收"。

const (
	// appDBHandleMax 是进程内**同时持有**的应用库句柄上限。
	//
	// 数值来源：limits.AppDBHandleMax（= GlobalInstances，32）。理由：每请求必须先拿到
	// 执行槽才会用到库 ⇒ 同一时刻最多 32 个应用在跑；句柄上限取同一量级既不会误伤
	// （不会因为上限去关正在用的句柄），又给 fd 一个硬上界
	// （每句柄 1 + AppDBReaders 条 SQLite 连接 ⇒ 默认 32 × 5 = 160 条）。
	appDBHandleMax = limits.AppDBHandleMax

	// appDBIdleTimeout 是句柄空闲回收时间。
	//
	// 它是**实现参数**（不是 §4 的平台上限，故不进 limits）：太久不用就释放 1+N 条连接
	// 与 SQLite 页缓存。2026-09-18 从 10 分钟收紧到 3 分钟 —— 理由是"几百个应用 +
	// 小内存机器"这个目标场景：每句柄多条连接各带一份页缓存，10 分钟意味着
	// "每个被访问过一次的应用"都会长期占着这份常驻；3 分钟仍覆盖"用户在一个应用里
	// 连续操作"的节奏（重开代价实测 1.7–3.2 ms），但把"偶尔用一次"的尾巴收得更紧。
	// 另有一条事件驱动的立即回收：应用下架/冻结/删除时 Server.EvictApp。
	appDBIdleTimeout = 3 * time.Minute
)

// appDBHandle 是池中的一条应用库句柄。
//
// 生命周期：acquire（返回时 inflight 已 +1）→ 使用 → release。
// 只有 inflight == 0 的句柄才可被淘汰或关闭。
//
// 2026-09-19：这里**没有**"整请求互斥量"了。老实现用 h.mu 覆盖整个 wasm 执行期，
// 把"一应用一连接"从队列保证升级成结构保证；但那样同应用的第二个请求必须等第一个
// 跑完 —— 与"WAL 下多读者并发"直接冲突。现在：
//   - 并发控制归 appdb（读 → 只读连接池；写 → writeMu）；
//   - 句柄只需要"在用就不能被关"这一条，由 inflight（p.mu 保护）提供。
type appDBHandle struct {
	appID string
	db    *appdb.DB

	// inflight 是正在使用该句柄的请求数（0..N，受 p.mu 保护）。
	// 它取代了老实现的"整请求互斥量"：只要 inflight > 0，句柄就不会被淘汰/关闭。
	inflight int
	// lastUsed 是最近一次 acquire 的时刻（LRU/空闲淘汰依据，由池的时钟提供）。
	lastUsed time.Time
	// dirty 表示这条句柄必须在 release 时回收重建（见 appDBConn 的注释）。
	//
	// 用原子量而不是普通 bool：写它的可能是**宿主调用 goroutine**
	//（runtime 把 Dispatch 放进独立 goroutine 跑，见 runtime.callHost），
	// 而读它的可能是请求 goroutine 或**并发的另一个请求**（2026-09-19 起同一句柄
	// 可能被多个请求同时持有，不能再靠"整请求互斥量提供 happens-before"）。
	// 同步依据就是 atomic.Bool 自身：dirty 的写/读都是顺序一致的原子操作，
	// 与 p.mu/inflight 一起构成"谁负责回收"的判据（最后一个 release 的人关库）。
	dirty atomic.Bool
	// uncached 表示这是"池满且无可淘汰"时的降级路径：用完即关、不进池。
	uncached bool

	// txGate 是"事务所有权判定 + 写/begin 调用"的闸（见 appDBConn 的注释）：
	// 同应用的写彼此本来就由 appdb 的 writeMu 串行，这把闸只额外保证
	// "所有权检查"与"调用 appdb"之间没有插入窗口。读不经过它。
	txGate sync.Mutex
	// txOwner 是**当前持有事务的那个请求**（`*appDBConn`；nil = 没有/已释放）。
	//
	// 它只用来放行持有者自己：安全判定永远看 appdb 的 `InTx()`（见 foreignTxError），
	// 所以这个标记陈旧或丢失只会让调用被拒（fail-closed），不会放行。
	txOwner atomic.Pointer[appDBConn]
}

// appDBPool 是应用库句柄池（键 = app_id）。
type appDBPool struct {
	mu      sync.Mutex
	handles map[string]*appDBHandle
	// opening 是"正在打开中"的应用（同应用单飞，见 appDBOpenFlight）。
	opening map[string]*appDBOpenFlight
	now     func() time.Time
	// max 是池容量（缺省 appDBHandleMax；测试可调小）。
	max int
	// idle 是空闲回收阈值（缺省 appDBIdleTimeout；控制台可调，见 SetLimits）。
	idle time.Duration
	// readers 是**新建句柄**要开的只读连接数（0 = limits.AppDBReaders；控制台可调，
	// 见 SetReaders）。它只在 acquire 里读一次交给 appdb.Open ⇒ 已建好的句柄不受影响
	//（appdb 的只读连接必须在建库窗口内一次建满，见 appdb.Options.Readers）。
	readers int
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
	return &appDBPool{
		handles: map[string]*appDBHandle{},
		opening: map[string]*appDBOpenFlight{},
		now:     now,
		max:     max,
		idle:    appDBIdleTimeout,
	}
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

// SetReaders 热替换"新建句柄的只读连接数"（控制台保存后即时生效，语义=**下一个句柄**）。
//
// 为什么不重建已有句柄：只读连接必须在 appdb 建库的**一次性令牌窗口**内一次建满，
// 运行中的句柄没有"加几条只读连接"这条路径（窗口早已关闭，新连接会被连接钩子
// fail-closed 拒绝）。因此这里的语义与 appdb_cache_kib 同档：
//   - 保存不阻塞、不打断在途请求、不需要重启；
//   - **下一个新建的应用库句柄**（首次请求 / 空闲回收后重建 / 污染回收后重建）
//     按新值建连。已有句柄在 appdb_idle_min 到点被回收后自然跟上。
//
// 收紧（例如 16 → 4）同样只对下一个句柄生效：在途读者不会被抽走连接。
func (p *appDBPool) SetReaders(n int) {
	if p == nil {
		return
	}
	p.mu.Lock()
	p.readers = n
	p.mu.Unlock()
}

// Readers 返回**下一个新建句柄**将使用的只读连接数（0 = limits.AppDBReaders 缺省；
// 控制台回读/测试断言用）。
//
// 注意它不能回答"池里已有句柄当前开了几条只读连接"——那些句柄建连时的值没有被记账
// （池只保存"下一个"这一份），所以诊断面要看连接实数应看 /proc/self/fd 或 appdb。
func (p *appDBPool) Readers() int {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.readers
}

// handleBookkeepingBytes 返回"一个应用库句柄被回收"的**记账量**：1 + N 条 SQLite
// 连接各一份页缓存（appdb 把 cache_size 限到 1 MiB）= (1+N) MiB。
//
// 随池当前的 readers 变化（老口径是固定 2 MiB 的"两条连接"；2026-09-19 多读者改造后
// 变成 (1+N)，控制台可调 app_db_readers ⇒ 这里必须跟着它走，否则日志与"归还 OS"的
// 触发阈值会低估/高估）。0（未显式设置）按默认 readers 记账。
func (p *appDBPool) handleBookkeepingBytes() int64 {
	n := p.Readers()
	if n <= 0 {
		n = limits.AppDBReaders
	}
	return int64(1+n) << 20
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
	per := p.handleBookkeepingBytes()
	p.mu.Lock()
	var closing []*appdb.DB
	var freed int64
	for key, h := range p.handles {
		if h.inflight == 0 && h.lastUsed.Before(cutoff) {
			delete(p.handles, key)
			closing = append(closing, h.db)
			freed += per
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
	return 1, p.handleBookkeepingBytes()
}

// appDBHandleBookkeepingBytes 的旧形态（编译期常量 (1+默认 readers) MiB）已改为
// appDBPool.handleBookkeepingBytes()：控制台可改 app_db_readers ⇒ 记账量必须跟着
// 池里"新建句柄将用的 readers"走，而不是永远按编译期默认值。
// 句柄数与连接数的**硬上界**仍在 limits（app_db_handle_max × (1 + app_db_readers)）。

// ===== 同应用"首次打开"单飞（2026-09-19，app_running>1 暴露出来的必须项）=====
//
// 为什么必须有它（实测，不是理论担忧）：`appdb.Open` 要跑 `PRAGMA journal_mode=WAL`，
// 而这条语句需要**库级写锁**，且 SQLite 对"改 journal_mode"并不套用 busy_timeout
// 重试 —— 两个请求同时为同一个冷应用 Open 时，一条成功、另一条直接
// `database is locked (5) (SQLITE_BUSY)` ⇒ 用户看到 500「应用执行失败」。
//
// 老默认（app_running=1）下队列把同应用请求串行化，这条路径**根本走不到**；
// 并发上限放开之后，"冷应用的并发首屏"必然踩到它（本改动新增的
// TestServe_SameAppRequestsRunConcurrentlyByDefault 一跑就红，就是它）。
//
// 设计：每个 app_id 同时只允许**一个** Open 在飞，其余同应用请求等待它的结果
// （成功共享句柄、失败共享错误）。等待者与被等到的句柄之间用"引用预约"交接
// （见 finishOpen / awaitOpen），保证等待者拿到的是**已 +1 引用**的句柄 —— 不会出现
// "leader 的请求先结束并把临时句柄关掉，等待者拿到已关闭的句柄"这种竞态。
//
// 为什么修在这里而不是改 appdb：`appDBPool.acquire` 是生产的**唯一** Open 调用点
// （appdb 接口不变），而"同应用同一时刻只开一次库"本来就是池该提供的性质；
// appdb 侧的 WAL 争用仍按原样记录在报告里（属其 owner 的输入）。
type appDBOpenFlight struct {
	// done 关闭即表示结果已发布（h/err 在 p.mu 下写入，关闭后只读）。
	done chan struct{}
	h    *appDBHandle
	err  *apperr.Error
	// refs 是**已经决定等待**的请求数（p.mu 保护）。
	// 发布者把这些引用一次性记进 h.inflight；等待者超时离开时把它减回去
	// （两者都在 p.mu 下，先看 published 再决定是减 refs 还是释放引用）。
	refs      int
	published bool
}

// awaitOpen 等一次"同应用首次打开"的结果。
//
// 返回值与直接 acquire 同语义：成功时句柄的 inflight 已经包含**本次**引用。
func (p *appDBPool) awaitOpen(ctx context.Context, f *appDBOpenFlight) (*appDBHandle, *apperr.Error) {
	select {
	case <-f.done:
		if f.err != nil {
			return nil, f.err
		}
		return f.h, nil
	case <-ctx.Done():
		p.mu.Lock()
		if !f.published {
			// 还没发布：撤回预约，发布者之后不会再给本次记引用。
			f.refs--
			p.mu.Unlock()
		} else {
			h := f.h
			p.mu.Unlock()
			// 已发布：引用已经记在本请求头上，必须还回去（否则句柄永不回收）。
			if h != nil {
				p.release(h, false)
			}
		}
		return nil, apperr.New(apperr.CodeAppQueueFull, "等待应用库打开超时（端到端墙钟）").
			WithDetail("reason", "wall_clock_exceeded").
			WithHint("稍后重试；该应用正在首次打开应用库")
	}
}

// finishOpen 发布一次打开的结果并唤醒等待者。必须与 acquire 的每个出口配对调用。
//
// 关键顺序（都在 p.mu 下）：先把等待者的引用一次性记进句柄，再置 published，
// 最后在锁外 close(done) —— 于是在 done 关闭后醒来的等待者，其引用已经记好。
func (p *appDBPool) finishOpen(appID string, f *appDBOpenFlight, h *appDBHandle, err *apperr.Error) {
	p.mu.Lock()
	delete(p.opening, appID)
	f.h, f.err = h, err
	if h != nil && f.refs > 0 {
		h.inflight += f.refs
		f.refs = 0
	}
	f.published = true
	p.mu.Unlock()
	close(f.done)
}

// acquire 取得某应用的句柄，返回时该句柄的 inflight 已 +1。
//
// **不再独占**（2026-09-19）：同一句柄可以被同应用的多个请求同时持有 —— 并发控制
// 下沉到 appdb（读 → 只读连接池；写 → appdb.writeMu）。句柄只保证"在用就关不掉"。
//
// 未命中则打开并做"打开后校验"（归属 + 可用性）。打开在池锁外进行（约 1.7–3.2 ms，
// 只在"首次请求 / 空闲回收之后"发生），但**同应用并发时合流成一次**（见
// appDBOpenFlight：并发 Open 同一库会撞 WAL 的库级写锁）；句柄**使用期间**不持池锁。
//
// 上限处理：池满时按 LRU 淘汰空闲句柄；若全部在用（全局并发 32 与池容量同值，
// 正常不会发生），退化为"临时句柄、用完即关"而不是报错 —— 不因为缓存策略失败
// 就让用户的请求失败。
func (p *appDBPool) acquire(ctx context.Context, dataRoot, appID string) (*appDBHandle, *apperr.Error) {
	var closing []*appdb.DB

	// 空闲阈值先算出来：**本次请求的应用**如果也空闲超时了，同样要回收重建
	//（"空闲"的判据是"距上次使用超过阈值"，与"是不是这次要用的应用"无关）。
	cutoff := p.now().Add(-p.idle)

	p.mu.Lock()
	for key, h := range p.handles {
		// inflight == 0 才能淘汰：在用句柄的关库会把并发请求的连接抽走。
		//
		// h.dirty 的同步依据是 atomic.Bool 本身（不是"整请求互斥量"提供 happens-before
		// —— 那个互斥量 2026-09-19 已删除）：标脏发生在持有者的宿主调用 goroutine 里，
		// 读它的是这里的请求 goroutine，原子读写保证可见性；而"谁负责关库"由
		// p.mu 下的 inflight 判定（最后一个 release 的人关）。
		wanted := key == appID
		if h.inflight == 0 && (wanted && h.dirty.Load() || h.lastUsed.Before(cutoff)) {
			// 标脏（连接污染 / 请求被杀）或空闲过久 ⇒ 关掉重建，绝不复用。
			delete(p.handles, key)
			closing = append(closing, h.db)
			continue
		}
		if wanted {
			h.inflight++
			h.lastUsed = p.now()
			p.mu.Unlock()
			p.closeAllDBs(closing)
			return h, nil
		}
	}
	// 同应用已有一次 Open 在飞 ⇒ 预约引用并等它的结果（不再各开一份库）。
	if f, ok := p.opening[appID]; ok {
		f.refs++
		p.mu.Unlock()
		p.closeAllDBs(closing)
		return p.awaitOpen(ctx, f)
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
	// readers 与"谁在开"一起在锁内取快照：readers 只在建库窗口内有效
	//（语义=下一个句柄，见 SetReaders）。
	readers := p.readers
	flight := &appDBOpenFlight{done: make(chan struct{})}
	p.opening[appID] = flight
	p.mu.Unlock()
	p.closeAllDBs(closing)

	db, err := appdb.Open(ctx, appdb.Options{DataRoot: dataRoot, AppID: appID, Readers: readers})
	if err != nil {
		aerr := apperr.From(err)
		p.finishOpen(appID, flight, nil, aerr)
		return nil, aerr
	}
	if verr := verifyAppDBHandle(ctx, dataRoot, appID, db); verr != nil {
		_ = db.Close()
		p.finishOpen(appID, flight, nil, verr)
		return nil, verr
	}

	h := &appDBHandle{appID: appID, db: db, inflight: 1, lastUsed: p.now(), uncached: uncached}
	if uncached {
		// 降级句柄不进池，但**可以被同应用的等待者共享**：引用由 finishOpen 记齐，
		// 最后一个 release 的人关库（release 里的 uncached 分支）。
		p.finishOpen(appID, flight, h, nil)
		return h, nil
	}

	// 防御性检查：单飞期间理论上不会有人把同一应用的句柄放进池（同一 app_id 只允许
	// 一个 opener），但保留它 —— "重复插库"必须无害，否则将来放宽单飞就是静默串库。
	p.mu.Lock()
	if exist, ok := p.handles[appID]; ok && !exist.dirty.Load() {
		exist.inflight++
		exist.lastUsed = p.now()
		p.mu.Unlock()
		go func() { _ = db.Close() }() // 多打开的那一份立刻关掉（它从未被使用）
		p.finishOpen(appID, flight, exist, nil)
		return exist, nil
	}
	p.handles[appID] = h
	p.mu.Unlock()
	p.finishOpen(appID, flight, h, nil)

	return h, nil
}

// release 归还句柄：减计数，并按需回收（脏句柄 / 池满降级的临时句柄）。
//
// **只在 inflight 归零时才关闭**：同一句柄现在可能被多个请求同时持有（多读者并发），
// 中途关库会把别的请求脚下的连接抽走 —— 所以由**最后一个** release 的人负责回收
// （dirty 是句柄级粘性标记，前面任何一个请求标脏都会被后面的人看到）。
func (p *appDBPool) release(h *appDBHandle, recycle bool) {
	if h == nil {
		return
	}
	dirty := recycle || h.dirty.Load()

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

// appDBConn 是交给 hostcap 的 capapi.DB：包两层职责 ——
//
//  1. 记下"这条连接已被污染"的信号，供 release 决定**回收句柄**（把 appdb 的永久 poison
//     变成一次性的请求级代价）；
//  2. **事务所有权校验**（2026-09-19，见下）：把"别的请求的写落进我打开的事务里"这件事
//     在每请求的包装层挡掉。
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
//
// # 事务所有权（app_running>1 打开的正确性边界）
//
// 问题（appdb 的作者在交付时点名）：事务挂在**句柄的读写连接**上（`d.tx`），而
// `db.exec` 没有"事务令牌" —— appdb 只看"当前有没有事务"，不知道写的人是**谁**。
// 于是同一个应用的另一个请求的 `db.exec` 会落进**别人已打开的事务**里：
// 事务持有者一回滚，那个请求的写就被静默丢掉（数据丢失，不是报错）。
//
// 改造前这条路径不可达（队列 app_running=1 串行 + 句柄整请求互斥）；2026-09-19
// 把 app_running 默认调到 4 之后它就是**默认行为**，必须闭合。这里用每请求一份的
// `appDBConn` 当"请求身份"（serveWasm 每请求 `&appDBConn{…}`），规则：
//
//   - **判据是 appdb 的权威状态**：`InTx()` 为真 且 事务持有者不是本请求 ⇒ 拒绝。
//     不信任句柄上的 owner 标记做安全判定（标记只用来放行持有者自己），
//     因此"标记陈旧/丢失"只会让调用被拒（fail-closed），绝不会放行；
//   - **写路径（exec/define）与 begin 走同一把 `txGate`**：检查与"调用 appdb"是一个
//     原子段 ⇒ 不存在"检查时无事务、执行时已有事务"的插入窗口（这是写丢失的唯一
//     真实入口，必须原子）；
//   - **读路径（query）不加闸**（否则读会被写串行化，正好毁掉本轮并发收益），改为
//     **执行前后各查一次**：与外来事务重叠的读会被报成拒绝，而不是把未提交数据当
//     已提交返回。残留：事务的打开与提交都恰好落在两条 query 之间的窗口读不到
//     （不构成数据损坏，如实认账）；
//   - **自愈**：事务被 appdb 的硬超时看门狗回滚、或持有者请求异常结束之后，
//     `InTx()` 转假 ⇒ 后续请求自动恢复，不需要重启或人工干预（marker 只影响"谁是
//     持有者"，安全判定始终看 InTx）。
type appDBConn struct {
	*appdb.DB
	handle *appDBHandle
}

// foreignTxError 判断"底层正处在**别的请求**的事务里"。
//
// 返回非 nil ⇒ 本次调用必须被拒（fail-closed，DB_DENIED + 可操作 hint）。
// 语义细节：`InTx()` 是权威（它由 appdb 在 BEGIN/COMMIT/ROLLBACK/超时回滚处维护），
// `handle.txOwner` 只用于识别"持有者是不是我" —— 它不是安全依据。
func (c *appDBConn) foreignTxError() *apperr.Error {
	if c == nil || c.handle == nil || c.DB == nil {
		return nil
	}
	if !c.DB.InTx() {
		return nil // 底层没有事务 ⇒ 谁都可以正常读写
	}
	if c.handle.txOwner.Load() == c {
		return nil // 本请求就是事务持有者（事务内的 query/exec 由 appdb 自己放行）
	}
	return apperr.New(apperr.CodeDBDenied,
		"另一个请求正在事务中：本请求的数据库调用被拒绝，以免落进别人的事务").
		WithDetail("reason", "foreign_transaction").
		WithHint("应用内并发请求共享同一个库句柄，事务是**请求级**的：请稍后重试").
		WithHint("事务期间只允许持有它的那个请求读写；本调用没有被执行，可以安全重试")
}

// endRequest 在请求结束时清掉本请求留下的事务状态（serveWasm 的 defer 调用）。
//
// 职责**只有一个方向**：把"本请求是不是持有者"这件事收干净，并且在有事务残留时
// 尽力回滚一次（比等 appdb 的 5 s 硬超时看门狗更快恢复）。安全性不依赖它：
// 即使这里什么都没做，外来写也会因为 `InTx()` 为真被拒（fail-closed），
// 直到看门狗把事务收掉。
func (c *appDBConn) endRequest() {
	if c == nil || c.handle == nil || c.DB == nil {
		return
	}
	if c.handle.txOwner.Load() != c {
		return // 本请求没开过事务（或已被别人接走：不需要也不该动）
	}
	if c.DB.InTx() {
		// 应用在事务里结束（崩溃/超时/忘了 commit）：尽力回滚一次。
		// 失败不改安全性（看门狗兜底），但要留痕给排查。
		if err := c.DB.Rollback(context.Background(), abi.TxParams{}); err != nil {
			c.notePoison(err)
		}
	}
	c.handle.txOwner.CompareAndSwap(c, nil)
}

func (c *appDBConn) Define(ctx context.Context, p abi.DBDefineParams) (abi.DBDefineResult, error) {
	if err := c.lockTxGate(); err != nil {
		return abi.DBDefineResult{}, err
	}
	defer c.unlockTxGate()
	res, err := c.DB.Define(ctx, p)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Query(ctx context.Context, p abi.SQLParams) (abi.QueryResult, error) {
	// 读不加闸（见 appDBConn 的注释）：执行前后各查一次，把"与外来事务重叠的读"
	// 变成明确的拒绝，而不是把未提交数据当已提交返回。
	if err := c.foreignTxError(); err != nil {
		return abi.QueryResult{}, err
	}
	res, err := c.DB.Query(ctx, p)
	c.notePoison(err)
	if err == nil {
		if ferr := c.foreignTxError(); ferr != nil {
			return abi.QueryResult{}, ferr
		}
	}
	return res, err
}

func (c *appDBConn) Exec(ctx context.Context, p abi.SQLParams) (abi.ExecResult, error) {
	if err := c.lockTxGate(); err != nil {
		return abi.ExecResult{}, err
	}
	defer c.unlockTxGate()
	res, err := c.DB.Exec(ctx, p)
	c.notePoison(err)
	return res, err
}

func (c *appDBConn) Begin(ctx context.Context) (abi.TxResult, error) {
	if err := c.lockTxGate(); err != nil {
		return abi.TxResult{}, err
	}
	defer c.unlockTxGate()
	res, err := c.DB.Begin(ctx)
	c.notePoison(err)
	if err == nil {
		// 成为事务持有者。CAS 失败说明另一个请求先占住了（appdb 的
		// "同时最多一个事务"让它几乎不可达，这里按 fail-closed 处理：立刻回滚刚开的事务，
		// 绝不出现"事务是我的、标记是别人的"这种分叉）。
		if !c.handle.txOwner.CompareAndSwap(nil, c) {
			_ = c.DB.Rollback(context.Background(), abi.TxParams{TxID: res.TxID})
			return abi.TxResult{}, apperr.New(apperr.CodeDBDenied, "另一个请求正在事务中，本次 tx_begin 已回滚").
				WithDetail("reason", "foreign_transaction").
				WithHint("同一应用同一时刻只允许一个事务（且只属于发起它的那个请求），请稍后重试")
		}
	}
	return res, err
}

func (c *appDBConn) Commit(ctx context.Context, p abi.TxParams) error {
	err := c.DB.Commit(ctx, p)
	c.notePoison(err)
	c.releaseTxOwnership()
	return err
}

func (c *appDBConn) Rollback(ctx context.Context, p abi.TxParams) error {
	err := c.DB.Rollback(ctx, p)
	c.notePoison(err)
	c.releaseTxOwnership()
	return err
}

// lockTxGate 取句柄的"事务闸"并做所有权校验；返回非 nil 表示调用必须被拒（且未持锁）。
//
// 为什么 Begin 与写共用一把闸：见 appDBConn 的注释 —— "检查无事务"与"调用 appdb"
// 之间必须没有窗口，否则外来写可以挤进刚打开的事务。写本来就由 appdb 的 writeMu
// 串行，所以这把闸不引入额外的吞吐代价；读**不**经过它。
func (c *appDBConn) lockTxGate() *apperr.Error {
	if c == nil || c.handle == nil {
		return nil
	}
	c.handle.txGate.Lock()
	if err := c.foreignTxError(); err != nil {
		c.handle.txGate.Unlock()
		return err
	}
	return nil
}

func (c *appDBConn) unlockTxGate() {
	if c == nil || c.handle == nil {
		return
	}
	c.handle.txGate.Unlock()
}

// releaseTxOwnership 在 commit/rollback 返回后释放持有者标记。
//
// 只在"底层事务确实已经结束"时释放：若 appdb 仍认为事务在（例如 COMMIT 失败、
// 或者只是超时回滚之外的部分失败形态），标记留着 ⇒ 外来写继续被拒（fail-closed），
// 直到看门狗/下一次 rollback 把事务收掉。反过来，标记残留绝不会导致永久拒绝：
// foreignTxError 的第一判据是 `InTx()`。
func (c *appDBConn) releaseTxOwnership() {
	if c == nil || c.handle == nil || c.DB == nil {
		return
	}
	if !c.DB.InTx() {
		c.handle.txOwner.CompareAndSwap(c, nil)
	}
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
