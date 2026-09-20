// Package appdb 实现 §5.1 的 `db.define` / `db.query` / `db.exec` / `db.tx` 四个原语，
// 是设计基线 §4.5（SQL/数据层）、§5.2（保留列）与红线 1/2（应用间隔离、数据边界）的落地点。
//
// 三条结构性不变量（§15.1 第 4/5 条，实测依据见 §15.2）：
//
//  1. **库文件路径由宿主推导**：`<data_root>/apps/<app_id>/app.db`（limits.AppsDirName），
//     数据目录 0700（limits.DataDirMode，§6.3）。任何宿主函数都不接受路径（§4.4），
//     app_id 必须先过 limits.AppIDPattern 校验，杜绝 `../` 之类的路径穿越。
//
//  2. **max_page_count 与全部 SQLITE_LIMIT_\* 是连接级且不持久的**：实测同一进程里
//     未设限额的新连接读回 LENGTH=1000000000 / SQL_LENGTH=1000000000 / ATTACHED=10 /
//     COLUMN=2000 / PARSER_DEPTH=2500（见 §15.2「max_page_count 持久性」），
//     同时实测：只给读写连接设 LIMIT_ATTACHED=0 时，只读连接上的 `ATTACH ':memory:'`
//     **成功**（err=nil）——漏设一条连接即静默失去 ATTACH 否决。因此：
//     每条连接（只读 + 读写 + 任何后来新建的连接钩子）都必须重设，并在设完后跑 fail-closed 金丝雀。
//
//     ⚠️ 驱动连接钩子拿到的只有 `sqlite.ExecQuerierContext`（**不是** `*sql.Conn`），
//     而 `sqlite.Limit` 只接受 `*sql.Conn` ⇒ **钩子里设不了 SQLITE_LIMIT_\***，只能设
//     `PRAGMA max_page_count`。审计 P1-3 因此确认"任何绕过 hardenConnLocked 的新连接
//     都失去 ATTACH 否决"。本包选择的闭合方式是**四层**（见 connectionGuard 段落）：
//     L1 全部 1+N 条持有连接逐条显式加固 + 金丝雀（只读连接**每一条**都要单独跑，
//     只加固第一条就等于给后面几条留了默认 ATTACHED=10）；
//     L2 池容量恒为 1+N 且 1+N 条全部被持有（第 2+N 条拿不到）；
//     L3 进程级连接钩子对**未持一次性令牌**的应用库连接 fail-closed 拒绝（只放行
//     引擎层只读的平台自省连接）；L4 每条语句执行前复检"即将使用的那条连接"仍带全套
//     限额（读回 max_page_count + LIMIT_ATTACHED），不成立即报错而不是带着默认限额跑。
//
//     由此推出一条硬约束：**只读连接数只能在 connectLocked 的一次性令牌窗口内一次建满**
//     （窗口关闭后新建的连接开不出来）⇒ 不做"按负载弹性扩缩连接"。
//
//  3. **语句在进入驱动之前就被闸门拦下**（sqlgate.go）：单语句 + 语句种类白名单 +
//     保留列（含 SQLite 别名 rowid/_rowid_/oid）拒绝；`ATTACH`/`VACUUM INTO` 的真正闸门是
//     LIMIT_ATTACHED=0（金丝雀校验），语句白名单是纵深（§15.1 第 5 条）。
//
// 连接布局（§4.5「连接级只读分层」）：
//
//	rw  = 读写                       → db.exec / db.define / db.tx / 宿主内部 PRAGMA
//	ros = PRAGMA query_only(1) × N   → 只跑 db.query 的 SELECT（N = limits.AppDBReaders）
//
// 1+N 条连接在 Open（以及每次按需重连）时**一次建满并全程持有**
// （`db.SetMaxOpenConns(1+N)`，池子里没有第 2+N 条）。之所以不是「一应用一连接」的字面
// 实现：§4.5 明确要求 SELECT 与写走**分层**连接，而「不复用」指的是不复用**驱动/库实例**
// （跨应用绝不共享），不是禁止同库多条连接。
//
// 并发语义（2026-09-19，"多读者并发 + 单写者串行"）：
//
//   - **库开 WAL**：connectLocked 断言 `PRAGMA journal_mode` 读回 == "wal"（只判 err==nil
//     会漏掉"返回 delete 却不报错"的静默降级）。WAL 下读不阻塞写、写不阻塞读 —— 这正是
//     分层连接想要的形态。每条连接另设 busy_timeout（limits.AppDBBusyTimeout，必须 <
//     单语句 5 s 预算）吸收 WAL 检查点与写事务的正常争用。
//   - **读**：从只读槽 roSlots 取一条空闲连接，**不持锁执行**（stateMu 只在"判定 + 取槽"
//     的瞬间持有，语句执行期间没有任何锁）。槽位取不到时**阻塞等待**（受调用方 ctx 约束），
//     而不是退化成串行：退化路径要拿 writeMu，会让一次高并发读被写者的 5 s 语句拖住。
//   - **写**：writeMu 独占（Exec / Define / Begin / Commit / Rollback / 超时回滚），
//     同一时刻只有一条语句能碰 rw ⇒ 单写者语义与改造前完全一致。
//   - **事务内读**走 rw（必须看到未提交的写），此时它与写者共用 writeMu。
//
// 关连接的不变式（破坏它就是 use-after-close）：
// **任何会走 closeLocked() 的路径都必须先独占全部只读槽（排空在途读者）**。
// 落地点是 closeLocked 里对 roSlots 的"排空 N 次 + 关闭"；readers 在途的凭据就是
// "手里拿着一个槽"。写者靠 writeMu 与关连接路径互斥，所以没有第二条排空协议。
//
// Close 语义：Close 释放全部连接与池子且**幂等**；之后再调用任何 db.\* 会按需重连
// （重连同样走全套限额 + 金丝雀，fail-closed）。这是对 capapi.DB 注释
// （「每请求结束后由运行时调用」）与 §4.5「一应用一连接」两种生命周期的兼容取舍——
// 每请求 Close 不会把对象变成不可用，但每次重连都要重付一次加固与金丝雀的代价，
// 运行时应当按应用实例持有本对象。
package appdb

import (
	"context"
	"crypto/rand"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// DB 实现 capapi.DB：一个 *DB 对应**一个应用的一个库文件**。
var _ capapi.DB = (*DB)(nil)

// reason 常量是 appdb 与消费者（appserver 的句柄池）之间的**唯一真源**。
//
// 为什么必须是导出常量而不是字面量（审计 P0-2，P0）：
// 生产侧写 `"transaction_timeout"`、消费侧只认 `"tx_timeout"` —— 后者**全仓没有
// 生产者**（只有 dbpool 自己的构造串单测把这条死分支钉成"预期"）。后果是一次事务
// 超时不会被句柄池识别为"该回收"，而 appdb 的污染标记又是对象级的 ⇒ 该应用直到
// 进程重启都返回 `DB_DENIED: 事务超过 5s 硬预算`。两端共用同一个常量后，
// "各写一个字符串"在类型层面就不可能再发生。
const (
	// ReasonStatementTimeout 是单语句硬超时/取消的 details.reason（§4.5 单语句 5 s）。
	ReasonStatementTimeout = "statement_timeout"
	// ReasonTransactionTimeout 是事务硬超时的 details.reason（§5.1 事务 5 s 强制回滚）。
	ReasonTransactionTimeout = "transaction_timeout"
)

// reasonOf 取出 *apperr.Error 的 details.reason（非 apperr / 无 reason 返回空串）。
func reasonOf(err *apperr.Error) string {
	if err == nil {
		return ""
	}
	reason, _ := err.Details["reason"].(string)
	return reason
}

// appDBFileName 是库文件名（宿主推导，应用无法指定，§4.4/§6.3）。
const appDBFileName = "app.db"

// dbFileMode 是库文件权限。目录已是 0700（limits.DataDirMode），这里再加一道
// 文件级 0600，避免运维日后放宽目录权限时把应用数据暴露出去。
const dbFileMode = 0o600

// canaryDBName 是金丝雀 ATTACH 用的库名（只出现在宿主内部，绝不落到磁盘）。
const canaryDBName = "picoaide_canary"

// canaryAttachErrFragment 是 LIMIT_ATTACHED=0 时引擎给出的原始错误片段
// （实测：`SQL logic error: too many attached databases - max 0 (1)`）。
// 金丝雀要求错误串必须包含它：如果 ATTACH 因为别的原因失败（例如 query_only），
// 就不能算「限额生效」，必须 fail-closed（§15.1 第 4/5 条）。
const canaryAttachErrFragment = "too many attached databases"

// Open 的默认值。唯一真源仍是 limits 包；声明为变量只为让测试注入更小的上限
// （§10.3 第 30 项不必真写 100 MB；§10.3 第 31 项不必真等 5 s），生产路径不得改写。
var (
	defaultMaxPageCount = limits.AppDBMaxPageCount
	defaultStmtBudget   = limits.SQLStatementBudget
)

// Options 是 Open 的入参。
type Options struct {
	// DataRoot 是平台数据根 `<data_root>`（库落在 <DataRoot>/AppsDirName/<AppID>/app.db）。
	DataRoot string
	// AppID 是应用标识（域名标签规则，limits.AppIDPattern）。
	AppID string
	// Readers 是只读连接数（0 = limits.AppDBReaders；上限 limits.AppDBReadersMax）。
	//
	// 为什么是"建库时的快照"而不是可热改：只读连接必须在 connectLocked 的**一次性令牌
	// 窗口**内一次建满（窗口关闭后新建的连接会被连接钩子 fail-closed 拒绝，见
	// connectionGuard）⇒ 只读连接数不可能按负载弹性扩缩。改这个值的语义是
	// "下一次建连生效"（句柄池的空闲回收 / 污染回收都会重建连接）。
	Readers int
}

// normalizeReaders 把注入的只读连接数钳到 [1, limits.AppDBReadersMax]（0 = 默认）。
func normalizeReaders(n int) int {
	if n <= 0 {
		n = limits.AppDBReaders
	}
	if n > limits.AppDBReadersMax {
		n = limits.AppDBReadersMax
	}
	if n < 1 {
		n = 1
	}
	return n
}

// newReadSlots 建一个容量 n 的只读槽通道，并**预填 n 个空槽（nil）**。
//
// 为什么预填空槽而不是"建连时再填"：槽位数量守恒（通道内 + 在途 = n）是"关连接路径
// 靠收齐 n 个槽来排空在途读者"这条不变式的前提。连接还没建好（或刚被关闭）时，
// 通道里必须是 n 个**空槽**占位 —— 否则第一次建连失败时 closeLocked 的 drainReadSlots
// 会在"这一代根本没有连接"的状态下永远等下去（实测就是这么死锁的）。
// 空槽的语义是"这一代没有可用连接"：读者取到它必须**立刻放回**再改走串行路径。
func newReadSlots(n int) chan *sql.Conn {
	ch := make(chan *sql.Conn, n)
	for i := 0; i < n; i++ {
		ch <- nil
	}
	return ch
}

// DB 是 capapi.DB 的实现。
//
// 锁的分工（两把锁的获取顺序恒为 writeMu → stateMu，绝不反向）：
//
//	stateMu —— 短临界区：连接/事务状态的判定与字段读写（ros/rw/sqlDB/closed/tx/
//	           poisoned/deadTx/genClosed/nextTxID）。**绝不在持锁期间执行语句**。
//	writeMu —— 写者独占：写原语（exec/define/tx）与**所有会关连接/重建连接的路径**
//	           （Close / 污染恢复 / 按需重连）都持它。读者在正常路径上不碰它。
//
// 计数类字段（rows/bytes/tables）用原子量：Stats 在请求路径上被调用，不能去抢锁。
type DB struct {
	appID string
	dir   string
	path  string

	// maxPageCount / budget / readers 在 Open 时从默认值快照，保证同一对象的加固参数稳定。
	maxPageCount int
	budget       time.Duration
	readers      int

	stateMu sync.Mutex
	sqlDB   *sql.DB
	rw      *sql.Conn // 读写：exec / define / tx
	// ros 是这一代**全部**只读连接（元素与 roSlots 的内容一一对应，仅用于诊断/关连接）。
	ros []*sql.Conn
	// roSlots 是空闲只读连接的槽位（容量 = readers，由 connectLocked 一次填满）。
	//
	// 槽位同时是"读者在途"的凭据：关连接路径必须先把 N 个槽全部收回（见 closeLocked），
	// 才能保证"拿到全部槽时没有任何读者正在执行语句"。
	roSlots chan *sql.Conn
	// genClosed 在**这一代连接被关闭**时关闭（读者在 select 里等它 ⇒ 从"等槽"里醒过来
	// 改走串行路径，而不是永远等一个不会回来的槽）。重连时换成新的 channel。
	genClosed chan struct{}
	closed    bool
	// retired 是**终态**：句柄被池淘汰（或服务端关停）之后置位，此后**不再重连**。
	//
	// 为什么需要它（审计 R1-rt-5）：Close 的语义是"之后按需重连"，而句柄池把
	// `delete(handles) + Close` 当终态。被放弃的宿主调用 goroutine（runtime.callHost 的
	// 预算到点即返回，Dispatch 仍在跑）能在 Close **之后**才走到 appdb ⇒ ensureConnLocked
	// 建一组新连接 ⇒ 这一代 1+N 条连接永久无人回收（评审实测 Close 后 fd 0→7），
	// 而池的 size() 只看得到 1，运维面完全不可见。
	//
	// 语义：retired 一旦置位**永不清除**；此后任何 db.* 调用返回一条明确错误
	// （见 retiredError），绝不静默复活。重连能力只属于"会话内恢复"
	// （污染回收 / 事务超时），与"句柄已被回收"是两件事。
	retired bool

	tx       *txSession
	nextTxID int64
	// poisoned 是超时/取消后的「连接污染标记」（§11 V1 两层兜底里的第二层）：
	// 被中断的语句可能仍在跑，此时**绝不复用**该连接。
	//
	// 实测结论（审计 P2-6，modernc.org/sqlite **v1.55.0**，本机 4 vCPU；
	// 观测方法：同一进程内跑无界递归 CTE，三个独立量同时看 ——
	//  ① runtime.NumGoroutine() 在返回时 / +2s / +5s 三点采样；
	//  ② 读 /proc/self/stat 的 utime+stime 看进程 CPU 增量；
	//  ③ 超时后在**独立连接**上写库看是否 SQLITE_BUSY，并直接在持有的连接上再跑 SELECT 1）：
	// 实测 goroutine 数回到基线、CPU +0ms、无残留读锁、持有连接立即可复用
	// ⇒ 设计 §15.2 引用的「被放弃的查询仍在跑」在本机**不可复现**，
	// 也就是说污染标记当前是**纯可用性代价**（换来的是保守）。
	//
	// 因此保留标记，但把恢复路径从"永久不可用"改成**按语句/按会话可恢复**
	// （见 ensureReadyLocked 与 Close）：被污染时丢弃整组连接重开（绝不复用被中断的
	// 连接），而不是让应用直到进程重启都失败。恢复规则的完整口径写在 ensureReadyLocked。
	poisoned *apperr.Error
	// deadTx 是**事务硬超时**留下的"写闸"（只由 poisonLocked 在 reason=transaction_timeout
	// 时置位，随 Close 清除）。
	//
	// 为什么事务超时不能像单语句超时那样"下次调用直接重连继续"：看门狗已经强制回滚、
	// `d.tx` 已清空，而**应用可能仍以为自己在事务里**（guest 侧的 db.tx 糖没有超时感知）。
	// 此时若让它继续跑 db.exec，写就会落到自动提交模式 —— tx.go 头注释明确禁止
	// "超时后继续以自动提交模式写"。所以：读可以立即恢复（重连后继续），
	// 写/建表/新事务继续返回同一条超时错误，直到会话边界（Close / 句柄池回收）清掉。
	deadTx *apperr.Error

	// writeMu 是写者独占锁。见类型注释的锁分工。
	writeMu sync.Mutex

	// tables 是应用表数（db.define 与建连时更新；Stats 只读缓存，不查库 —— 它在
	// 请求路径上被调用，不能在写事务 / 慢查询后面排队）。
	tables atomic.Int64

	rows  atomic.Int64
	bytes atomic.Int64
}

// Path 返回某应用库的**文件路径**（纯函数，无副作用：不建目录、不连库）。
//
// 存在的理由（2026-09-21，作者数据面端点）：调用方常常需要先回答"这个应用**有没有**
// 库文件"再决定要不要连 —— 而 `Open` 会建目录并连库（SQLite 在 rwc 模式下会把
// 不存在的库**建出来**）。"读一次数据顺便把库建出来"是不可接受的副作用：
// 它会让"应用还没被用过"这个事实消失，也会让一个只读端点产生写行为。
//
// 库布局的唯一权威仍然是本包（`<DataRoot>/<AppsDirName>/<AppID>/app.db`）：
// 调用方不得自己拼这个路径，否则布局一变就会出现"自省与运行期读的不是同一个库"。
func Path(dataRoot, appID string) (string, *apperr.Error) {
	if strings.TrimSpace(dataRoot) == "" {
		return "", apperr.New(apperr.CodeInternal, "appdb: DataRoot 为空").
			WithHint("平台启动配置缺少数据根目录")
	}
	if !validAppID(appID) {
		return "", apperr.Newf(apperr.CodeInvalidAppID, "appdb: 非法 app_id %q", appID).
			WithDetail("pattern", limits.AppIDPattern).
			WithDetail("max_len", limits.MaxAppIDLen)
	}
	path := filepath.Join(dataRoot, limits.AppsDirName, appID, appDBFileName)
	// DSN 里 `?` 之后是查询参数（驱动与 mattn 同源行为），路径含 `?`/`#` 会被误解析；
	// 路径全部由宿主推导，这里对不可控的 DataRoot 做一次 fail-closed 检查。
	if strings.ContainsAny(path, "?#") {
		return "", apperr.New(apperr.CodeInternal, "appdb: 数据根路径含非法字符（? 或 #）").
			WithCause(errors.New(path)).
			WithHint("请把数据根换成不含 ? 与 # 的路径")
	}
	return path, nil
}

// Open 打开（必要时创建）某个应用的库，并完成连接加固。
//
// 失败一律 fail-closed：任一限额设不上、任一金丝雀不成立，都返回错误而不是降级运行。
func Open(ctx context.Context, opt Options) (*DB, error) {
	if strings.TrimSpace(opt.DataRoot) == "" {
		return nil, apperr.New(apperr.CodeInternal, "appdb: DataRoot 为空").
			WithHint("平台启动配置缺少数据根目录")
	}
	if !validAppID(opt.AppID) {
		return nil, apperr.Newf(apperr.CodeInvalidAppID, "appdb: 非法 app_id %q", opt.AppID).
			WithDetail("pattern", limits.AppIDPattern).
			WithDetail("max_len", limits.MaxAppIDLen).
			WithHint("app_id 只能是小写字母/数字/单个连字符，且不超过平台配置的长度上限")
	}

	dir := filepath.Join(opt.DataRoot, limits.AppsDirName, opt.AppID)
	// 目录 0700（§6.3/§4.3）：MkdirAll 受 umask 影响，显式 Chmod 兜底。
	if err := os.MkdirAll(dir, limits.DataDirMode); err != nil {
		return nil, apperr.New(apperr.CodeInternal, "appdb: 创建应用数据目录失败").WithCause(err)
	}
	if err := os.Chmod(dir, limits.DataDirMode); err != nil {
		return nil, apperr.New(apperr.CodeInternal, "appdb: 设置应用数据目录权限失败").WithCause(err)
	}
	path, perr := Path(opt.DataRoot, opt.AppID)
	if perr != nil {
		return nil, perr
	}

	// 把这个应用目录登记进"受保护目录"：从此刻起，任何**不带一次性令牌**且不是
	// 引擎层只读的连接都不允许打开本应用库（连接钩子里 fail-closed，见 connectionGuard）。
	registerGuardedAppDir(dir)
	registerMaxPageCountHook()

	d := &DB{
		appID:        opt.AppID,
		dir:          dir,
		path:         path,
		maxPageCount: defaultMaxPageCount,
		budget:       defaultStmtBudget,
		readers:      normalizeReaders(opt.Readers),
		roSlots:      newReadSlots(normalizeReaders(opt.Readers)),
		genClosed:    make(chan struct{}),
	}
	if err := d.connectLocked(ctx); err != nil {
		_ = d.closeLocked()
		return nil, err
	}
	return d, nil
}

// connectLocked 建立 1 条读写 + N 条只读连接，逐条加固，并把库切到 WAL。
// 调用方必须持有 writeMu（或处于构造期）。
//
// 顺序是有讲究的（WAL 是**库级持久**设置，而且只读连接上改它会 SQLITE_READONLY）：
//
//  1. 建 sql.DB（池容量 = 1+N）与**读写连接**；
//  2. 在读写连接上先设 busy_timeout（否则一次瞬时锁争用就会让下一步的 journal_mode
//     切换拿到 SQLITE_BUSY），再 `PRAGMA journal_mode=WAL` 并**断言读回 == "wal"**；
//  3. 加固读写连接，再建满 N 条只读连接并**逐条**加固（每条都跑 ATTACH/query_only 金丝雀）；
//  4. 一次性把这一代连接发布到 d 上（stateMu 下），最后把 N 个槽填进 roSlots。
//
// 任一步失败都会把半成品连接关掉并让对象保持「已关闭」：绝不留一条没加固的连接，
// 也绝不在下次重连时漏掉上一次的池子。
//
// DSN 带一个**一次性令牌**（本包私有参数，驱动会原样忽略未知参数、但连接钩子能读到）：
// 令牌只在"本函数正在创建这 1+N 条连接"的窗口内有效，函数返回前即回收
// ⇒ 任何**后来**用同一个 DSN（哪怕是本条 DSN 字符串）新建的连接都会被钩子 fail-closed
// 拒绝。这是 FIX-12 的 L3：把"新连接没加固"从"静默带默认限额跑"变成"根本开不出来"。
// 也正是这条约束决定了只读连接数只能在**这里**一次建满（不能弹性扩缩）。
func (d *DB) connectLocked(ctx context.Context) (err error) {
	defer func() {
		if err != nil {
			_ = d.closeLocked()
		}
	}()
	token, terr := newConnToken()
	if terr != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 生成连接令牌失败").WithCause(terr)
	}
	allowConnToken(token)
	// 一次性：本函数返回时（1+N 条连接都已建好）立刻回收。
	defer revokeConnToken(token)

	sqlDB, err := sql.Open("sqlite", appDBDSN(d.path, token))
	if err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 打开应用数据库失败").WithCause(err)
	}
	// 池子恰好 1+N 条：本对象只会持有 rw 一条 + readers 条只读。任何误用
	// db.QueryContext 的代码会因为拿不到连接而立即暴露（而不是静默走一条没加固的连接）。
	sqlDB.SetMaxOpenConns(1 + d.readers)
	sqlDB.SetMaxIdleConns(1 + d.readers)
	sqlDB.SetConnMaxLifetime(0)
	sqlDB.SetConnMaxIdleTime(0)

	// (1) 读写连接先建：WAL 与 busy_timeout 都在它上面先落地（这两条都是"库级/连接级
	// 且必须在只读连接之前"的设置）。
	rw, err := sqlDB.Conn(ctx)
	if err != nil {
		_ = sqlDB.Close()
		return apperr.New(apperr.CodeInternal, "appdb: 获取读写连接失败").WithCause(err)
	}
	if _, err := rw.ExecContext(ctx,
		fmt.Sprintf("PRAGMA busy_timeout = %d", limits.AppDBBusyTimeout.Milliseconds())); err != nil {
		_ = rw.Close()
		_ = sqlDB.Close()
		return apperr.New(apperr.CodeInternal, "appdb: 设置 busy_timeout 失败").WithCause(err)
	}
	if err := enableWALLocked(ctx, rw); err != nil {
		_ = rw.Close()
		_ = sqlDB.Close()
		return err
	}
	// (2) 逐条加固（rw 先，只读连接随后；hardenConnLocked 里还会再设一遍 busy_timeout，
	// 因为它是连接级参数，对每条新连接都必须在场）。
	if err := d.hardenConnLocked(ctx, rw, false); err != nil {
		_ = rw.Close()
		_ = sqlDB.Close()
		return err
	}
	ros := make([]*sql.Conn, 0, d.readers)
	for i := 0; i < d.readers; i++ {
		conn, cerr := sqlDB.Conn(ctx)
		if cerr != nil {
			for _, c := range ros {
				_ = c.Close()
			}
			_ = rw.Close()
			_ = sqlDB.Close()
			return apperr.Newf(apperr.CodeInternal, "appdb: 获取只读连接失败（第 %d/%d 条）", i+1, d.readers).
				WithCause(cerr)
		}
		// 每条只读连接都要单独跑全套加固 + 金丝雀：漏一条就等于给那一条留下
		// 驱动默认的 LIMIT_ATTACHED=10（§15.1 第 4/5 条，实测依据见包注释）。
		if herr := d.hardenConnLocked(ctx, conn, true); herr != nil {
			_ = conn.Close()
			for _, c := range ros {
				_ = c.Close()
			}
			_ = rw.Close()
			_ = sqlDB.Close()
			return herr
		}
		ros = append(ros, conn)
	}
	if n, cerr := d.countTablesOn(ctx, rw); cerr == nil {
		d.tables.Store(int64(n))
	}

	// (3) 防御性兜底：上一代若留下未排空的槽（不应发生：closeLocked 已排空），
	// 这里必须清掉，否则下面的填充会超容阻塞。
	for {
		select {
		case c := <-d.roSlots:
			if c != nil {
				_ = c.Close()
			}
			continue
		default:
		}
		break
	}
	// (4) 一次性发布这一代连接：关连接路径持同一把 writeMu，读者在 stateMu 下判定
	// ready 之后才可能取槽 ⇒ 这里不会与"半建好的一代"交错。
	d.stateMu.Lock()
	d.sqlDB = sqlDB
	d.rw = rw
	d.ros = ros
	d.genClosed = make(chan struct{})
	d.closed = false
	d.stateMu.Unlock()
	for _, c := range ros {
		d.roSlots <- c
	}
	if err = d.chmodDBFile(); err != nil {
		return err
	}
	return nil
}

// enableWALLocked 把库切到 WAL（库级持久设置）并**断言读回字符串 == "wal"**。
//
// 为什么必须断言读回值：`PRAGMA journal_mode=WAL` 在库所在文件系统不支持 WAL
// （例如某些网络文件系统 / 共享内存不可用）时会**静默返回 delete 而 err == nil**——
// 只判 err 会让"以为开了 WAL"变成一个永不报警的假设，而多读者并发正是建立在 WAL 上
// （delete 日志下读者与写者互斥，并发读会退化成 SQLITE_BUSY）。
// 因此这里 fail-closed：宁可不提供服务，也不要带着"其实是 delete 日志"的库跑并发。
//
// 该 PRAGMA 必须在**任何 query_only 连接存在之前**执行：只读连接上改 journal_mode
// 会直接 SQLITE_READONLY，所以它在 connectLocked 里排在"建只读连接"之前。
func enableWALLocked(ctx context.Context, conn *sql.Conn) error {
	var mode string
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&mode); err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 开启 WAL 失败").WithCause(err)
	}
	if !strings.EqualFold(strings.TrimSpace(mode), "wal") {
		return apperr.Newf(apperr.CodeInternal, "appdb: 开启 WAL 失败（journal_mode 读回 %q）", mode).
			WithDetail("want", "wal").
			WithDetail("got", mode).
			WithHint("WAL 是多读者并发的前提；库所在文件系统不支持 WAL 时平台拒绝提供服务")
	}
	return nil
}

// chmodDBFile 把库文件与 WAL sidecar 的权限收紧到 0600（文件在 sql.Open 后即已创建）。
//
// `-wal` / `-shm` 与主库同口径：它们是**应用数据**的一部分（WAL 里可能有尚未检查点的
// 已提交事务），目录虽已是 0700，但主库单独收紧了 0600 而 sidecar 只靠 umask
// 就会在"运维放宽目录权限"时把数据暴露出去。文件不存在时跳过（WAL 由连接创建，
// 干净关闭后 SQLite 会删掉它们）。
func (d *DB) chmodDBFile() error {
	for _, p := range []string{d.path, d.path + "-wal", d.path + "-shm"} {
		if err := os.Chmod(p, dbFileMode); err != nil && !os.IsNotExist(err) {
			return apperr.New(apperr.CodeInternal, "appdb: 设置应用数据库文件权限失败").WithCause(err)
		}
	}
	return nil
}

// appConnCacheKiB 是**每条连接**的 SQLite 页缓存上限（KiB，正数即"多少 KiB"）。
//
// 为什么收紧（2026-09-18，"几百个应用 + 小内存机器"目标）：SQLite 默认 cache_size
// 是 -2000（2 MiB/连接），一个应用库句柄持有 1 + limits.AppDBReaders 条连接
// （1 写 + N 读）⇒ 默认就是 (1+N) × 2 MiB/应用的常驻页缓存；几百个应用被访问过
// 一轮就会叠成几百 MiB（甚至上 GiB）。
// 限到 1 MiB/连接（默认配置下 (1+N) MiB/句柄，见 appserver 的
// appDBHandleBookkeepingBytes）对应用查询的影响可忽略（单次查询结果上限 8 MiB，
// 但工作集是几十 KB 级的行集），换来的常驻下降是线性的。
const appConnCacheKiB = 1024

// connCacheKiB 是**当前**每连接页缓存上限（控制台可改；0 = 用编译期默认）。
// 用原子量：写它的可能是管理端请求 goroutine，读它的是每个新连接的加固路径。
var connCacheKiB atomic.Int64

// SetConnCacheKiB 设置每连接页缓存上限（KiB）；<=0 表示回到默认。
//
// 生效范围：**之后新建的连接**（PRAGMA cache_size 是连接级参数）。已有句柄在
// 空闲回收后重建时自然拿到新值——因此控制台保存不需要重启，也不打断在途请求。
func SetConnCacheKiB(kib int) {
	if kib <= 0 {
		connCacheKiB.Store(0)
		return
	}
	connCacheKiB.Store(int64(kib))
}

// ConnCacheKiB 返回当前生效值（诊断/控制台回读用）。
func ConnCacheKiB() int {
	if v := connCacheKiB.Load(); v > 0 {
		return int(v)
	}
	return appConnCacheKiB
}

// hardenConnLocked 对**一条**连接施加全套连接级限额，然后跑两条金丝雀。
//
// 顺序有讲究：先 max_page_count（纯连接参数），再 SQLITE_LIMIT_\*，最后 query_only(1)。
// 实测确认：query_only 不会拦 ATTACH，所以只读连接上的 ATTACH 金丝雀仍然能验到
// LIMIT_ATTACHED=0 本身（而不是被只读属性顺带挡住）。
//
// 这份清单是**每连接**的（连接级参数不持久）：调用方必须对池里 1+N 条连接**逐条**调用，
// 漏一条就等于给那一条留下驱动默认值（§15.1 第 4 条）。
func (d *DB) hardenConnLocked(ctx context.Context, conn *sql.Conn, readonly bool) error {
	if conn == nil {
		return apperr.New(apperr.CodeInternal, "appdb: 连接为空")
	}
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA max_page_count = %d", d.maxPageCount)); err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 设置 max_page_count 失败").WithCause(err).
			WithDetail("max_page_count", d.maxPageCount)
	}
	// busy_timeout（连接级、不持久）：WAL 下写者/读者/检查点之间的瞬时争用是常态，
	// 没有它一次正常争用就会变成应用可见的 database_busy。数值必须 < 单语句预算
	// （limits.AppDBBusyTimeout 的注释里有完整理由）。
	if _, err := conn.ExecContext(ctx,
		fmt.Sprintf("PRAGMA busy_timeout = %d", limits.AppDBBusyTimeout.Milliseconds())); err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 设置 busy_timeout 失败").WithCause(err).
			WithDetail("busy_timeout_ms", limits.AppDBBusyTimeout.Milliseconds())
	}
	// 页缓存上限（连接级；负值表示 KiB）。放在 LIMIT 之前：它是纯连接参数，
	// 不影响后面两条金丝雀的判定。
	if _, err := conn.ExecContext(ctx, fmt.Sprintf("PRAGMA cache_size = -%d", ConnCacheKiB())); err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 设置 cache_size 失败").WithCause(err).
			WithDetail("cache_size_kib", ConnCacheKiB())
	}
	for _, lim := range connectionLimits() {
		if _, err := sqlite.Limit(conn, lim.id, lim.value); err != nil {
			return apperr.Newf(apperr.CodeInternal, "appdb: 设置 SQLITE_LIMIT_%s 失败", lim.name).WithCause(err)
		}
	}
	if readonly {
		if _, err := conn.ExecContext(ctx, "PRAGMA query_only = 1"); err != nil {
			return apperr.New(apperr.CodeInternal, "appdb: 设置 query_only 失败").WithCause(err)
		}
	}

	// 读回复检（与每条语句前的 L4 复检共用同一份实现，避免两处口径漂移）。
	if err := d.verifyConnLocked(ctx, conn, readonly); err != nil {
		return err
	}

	// 金丝雀 2：ATTACH 必须被引擎拒绝，且错误必须是「挂载数超限」。
	// 去掉限额施加代码后 ATTACHED 回到默认 10，这里立刻变红（§10.1 第 12/13 项）。
	if _, err := conn.ExecContext(ctx, "ATTACH ':memory:' AS "+canaryDBName); err == nil {
		return apperr.New(apperr.CodeInternal, "appdb: ATTACH 金丝雀失败（限额未生效）").
			WithDetail("canary", "attach_allowed").
			WithHint("SQLITE_LIMIT_ATTACHED 必须为 0，否则应用可跨库读别的应用数据")
	} else if !strings.Contains(err.Error(), canaryAttachErrFragment) {
		return apperr.New(apperr.CodeInternal, "appdb: ATTACH 金丝雀失败（错误原因不是挂载数超限）").
			WithCause(err).
			WithDetail("canary", "unexpected_error")
	}
	return nil
}

// verifyConnLocked 复检**即将使用的那条连接**仍带全套限额（FIX-12 的 L4，fail-closed）。
//
// 为什么每条语句前都要跑一次：驱动钩子设不了 SQLITE_LIMIT_\*，"新连接没加固"在
// 类型层面无法在钩子里拦住；能拦住的位置只有"真正要执行语句的这条连接"。
// 这里读回两个**最关键的**限额（体积上限 + ATTACH 否决）与只读标志：
//   - max_page_count 是 100 MB 硬边界；
//   - LIMIT_ATTACHED=0 是 ATTACH 与 VACUUM INTO 的**唯一真闸门**（§15.1 第 5 条）。
//
// 任一项读回不一致 ⇒ 返回错误而**不是**带着默认限额继续跑。代价是每条语句多两次
// 进程内读回（真跑量化见交付说明：`BenchmarkQuerySelectOne` 在本机 4 vCPU 上
// 从 ~24 µs/次 升到 ~85 µs/次，即每条语句 +~60 µs；相对于"每请求新建 WASM 实例
// 2.78 ms"与"单语句 5 s 预算"，这是可接受的固定成本，换来的是"限额丢失时绝不静默"）。
func (d *DB) verifyConnLocked(ctx context.Context, conn *sql.Conn, readonly bool) error {
	if conn == nil {
		return apperr.New(apperr.CodeInternal, "appdb: 连接不可用（内部状态异常）")
	}
	var got int64
	if err := conn.QueryRowContext(ctx, "PRAGMA max_page_count").Scan(&got); err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 连接级限额复检失败（读回 max_page_count）").WithCause(err)
	}
	if got != int64(d.maxPageCount) {
		return apperr.New(apperr.CodeInternal, "appdb: 连接级限额未生效（max_page_count 读回不一致）").
			WithDetail("want", d.maxPageCount).
			WithDetail("got", got).
			WithHint("应用数据库体积上限是硬边界，读回不一致时拒绝提供服务")
	}
	attached, err := sqlite.Limit(conn, sqlite3.SQLITE_LIMIT_ATTACHED, -1)
	if err != nil {
		return apperr.New(apperr.CodeInternal, "appdb: 连接级限额复检失败（读回 LIMIT_ATTACHED）").WithCause(err)
	}
	if attached != limits.SQLLimitAttached {
		return apperr.New(apperr.CodeInternal, "appdb: 连接级限额未生效（LIMIT_ATTACHED 读回不一致）").
			WithDetail("want", limits.SQLLimitAttached).
			WithDetail("got", attached).
			WithHint("ATTACH 否决是跨应用隔离的唯一真闸门（§15.1 第 5 条），不一致时拒绝提供服务")
	}
	if readonly {
		// 用读回 pragma 而不是试写：试写一旦真的成功就会往应用库里塞垃圾表。
		var qo int64
		if err := conn.QueryRowContext(ctx, "PRAGMA query_only").Scan(&qo); err != nil {
			return apperr.New(apperr.CodeInternal, "appdb: 读回 query_only 失败").WithCause(err)
		}
		if qo != 1 {
			return apperr.New(apperr.CodeInternal, "appdb: 只读金丝雀失败（query_only 未生效）").
				WithDetail("canary", "readonly_not_query_only").
				WithDetail("query_only", qo)
		}
	}
	return nil
}

// ===== 连接选取（读快路径 / 写与退化串行路径）=====

// withReadConn 选出一条"已确认加固"的读连接执行 fn。这是 db.query 的唯一入口路径。
//
// 快路径（绝大多数调用）：无事务、未污染、未关闭 ⇒ 从只读槽取一条空闲连接，
// **不持任何锁执行**（stateMu 只在判定与取槽的瞬间持有）。槽位同时是"读者在途"的凭据：
// 关连接路径会先把 N 个槽全部收回，才动手关连接（见 closeLocked 的不变式）。
//
// 退化路径（保持既有语义的**串行**）：
//   - 事务内读：必须走读写连接才能看到未提交的写（§5.1 db.tx 语义）；
//   - 连接被污染 / 已关闭 / 正好落在关连接的窗口里（genClosed 已关）：先按
//     ensureReadyLocked 的规则恢复连接，再在 writeMu 下执行。
//
// 为什么"取不到槽位"选择**阻塞等待**而不是"立刻退化成串行"：退化路径要抢 writeMu，
// 而写者可能正在跑一条最长 5 s 的语句 —— 那样一次高并发读会被写者拖住。只读槽的
// 持有者只受自己的单语句 5 s 预算约束，等它更短也更公平；等待本身受调用方 ctx 约束
// （ctx 到期就落到退化路径，由 stmtContext 立刻报 statement_timeout）。
func (d *DB) withReadConn(ctx context.Context, fn func(*sql.Conn) error) error {
	if conn, ok := d.takeReadSlot(ctx); ok {
		defer d.putReadSlot(conn)
		return d.runVerified(ctx, conn, true, fn)
	}
	return d.withSerialConn(ctx, true, fn)
}

// takeReadSlot 尝试从只读池取一条连接。ok=false 表示"不该走快路径或这一代正在关闭"，
// 调用方应改用 withSerialConn（它会按需重连）。
func (d *DB) takeReadSlot(ctx context.Context) (*sql.Conn, bool) {
	d.stateMu.Lock()
	// 事务内读必须走 rw（看未提交写）；污染/已关闭时连接不可信 ⇒ 交给退化路径恢复。
	degraded := d.tx != nil || d.closed || d.retired || d.poisoned != nil
	gen := d.genClosed
	d.stateMu.Unlock()
	if degraded || gen == nil {
		return nil, false
	}
	select {
	case conn := <-d.roSlots:
		if conn == nil {
			// 空槽（这一代没有可用连接，或连接正在重建）：**必须立刻放回**再退化 ——
			// 槽位数量守恒是关连接路径能收齐 n 个槽的前提，把空槽带走会让
			// closeLocked 永远等下去（而退化路径要抢的 writeMu 正握在关连接者手里）。
			d.roSlots <- nil
			return nil, false
		}
		return conn, true
	case <-gen:
		// 这一代连接正在被关闭：不要拿一条马上要被关掉的连接。
		return nil, false
	case <-ctx.Done():
		return nil, false
	}
}

// putReadSlot 归还一条只读连接（**不取任何锁**；nil 是空槽，同样要放回）。
//
// 归还路径一旦取锁就会和关连接路径互锁（关连接要在持有 writeMu 的同时等槽归还），
// 所以这里必须是纯 channel 操作。这个 send **不会阻塞**：槽位数量守恒
// （通道容量 = readers，且在途槽位数 + 通道内槽位数恒等于 readers），
// 关连接路径每取走一个槽都会在收齐后重新填满。
func (d *DB) putReadSlot(conn *sql.Conn) {
	d.roSlots <- conn
}

// withSerialConn 在**写者锁**下选连接并执行 fn。
//
// 三类调用者：写原语（exec/define/tx 语句本身）、事务内读、以及需要按规则恢复连接的
// 退化读路径。持 writeMu 执行的原因：
//   - 写原语天然要串行（同一时刻只有一条语句能碰 rw）；
//   - **所有**关连接/重建连接的路径也持 writeMu ⇒ 这里取到的连接不会在语句执行期间
//     被关掉，不需要只读槽那套排空协议。
func (d *DB) withSerialConn(ctx context.Context, readonly bool, fn func(*sql.Conn) error) error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	if err := d.ensureReadyLocked(!readonly); err != nil {
		return err
	}
	conn := d.writeConn()
	verifyReadonly := false
	if readonly && !d.inTx() {
		// 无事务的退化读：ensureReadyLocked 之后池里必然有连接；持 writeMu ⇒
		// 不会有并发的关连接者把这些连接关掉。
		conn = <-d.roSlots
		verifyReadonly = true
		defer d.putReadSlot(conn)
	}
	return d.runVerified(ctx, conn, verifyReadonly, fn)
}

// runVerified 做 L4 复检后执行 fn（复检用**独立于调用方 ctx** 的预算：调用方 ctx 可能
// 已经到期，但"这条连接是否还安全"的判断不能因此被跳过）。
//
// readonly 语义：true = 只读原语（db.query），false = 写原语（db.exec/define/tx）。
// 事务内 db.query 走的是读写连接（要看得到未提交的写），此时不校验 query_only。
func (d *DB) runVerified(ctx context.Context, conn *sql.Conn, readonly bool, fn func(*sql.Conn) error) error {
	if conn == nil {
		return apperr.New(apperr.CodeInternal, "appdb: 连接不可用（内部状态异常）")
	}
	vctx, cancel := context.WithTimeout(context.Background(), d.budget)
	defer cancel()
	if err := d.verifyConnLocked(vctx, conn, readonly); err != nil {
		return apperr.From(err)
	}
	return fn(conn)
}

// writeConn 返回读写连接（值在 stateMu 下取快照）。
func (d *DB) writeConn() *sql.Conn {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.rw
}

// checkedWriteConn 取读写连接并做 L4 复检（FIX-12），返回**已确认加固**的连接。
// 调用方必须持有 writeMu。
func (d *DB) checkedWriteConn(ctx context.Context) (*sql.Conn, *apperr.Error) {
	conn := d.writeConn()
	if conn == nil {
		return nil, apperr.New(apperr.CodeInternal, "appdb: 连接不可用（内部状态异常）")
	}
	vctx, cancel := context.WithTimeout(context.Background(), d.budget)
	defer cancel()
	if err := d.verifyConnLocked(vctx, conn, false); err != nil {
		return nil, apperr.From(err)
	}
	return conn, nil
}

// inTx 报告当前是否有打开的事务（值在 stateMu 下取快照）。
func (d *DB) inTx() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.tx != nil
}

// readonly 语义：true = 只读原语（db.query），false = 写原语（db.exec/define/tx）。
// 事务内 db.query 走的是读写连接（要看得到未提交的写），此时不校验 query_only。
//
// ===== 连接守卫（FIX-12，§15.1 第 4/5 条）=====
//
// 背景：驱动连接钩子的签名是 `func(conn sqlite.ExecQuerierContext, dsn string) error`，
// 拿不到 `*sql.Conn`，而 `sqlite.Limit` 只接受 `*sql.Conn` ⇒ **钩子里设不了
// SQLITE_LIMIT_\***。所以"新建连接也带全套限额"在驱动 API 上做不到；本包的做法是
// 让**不可能是全套限额的连接根本开不出来**，并在每条语句前复检实际使用的那条连接。
//
// 三条规则：
//  1. DSN 带本包私有的一次性令牌（`_picoaide_appdb=<随机>`，驱动忽略未知查询参数、
//     但钩子能读到 dsn 原文）且令牌仍在有效窗口内 ⇒ 放行，并兜底设 max_page_count；
//  2. 不带令牌 / 令牌已回收 ⇒ 只有**引擎层只读**（`PRAGMA query_only` 读回 1）的连接
//     才放行（平台自省路径 `internal/wasmapp/api/read.go` 的
//     `file:…?mode=ro&_pragma=query_only(1)`，它不执行应用提供的 SQL）；
//     其余一律返回错误 —— 连接创建失败，绝不"带着默认限额跑"；
//  3. 路径不在受保护目录里的连接（别的包自己的 SQLite、`:memory:` 等）本包不管。
//
// 残留风险（如实认账）：
//   - 规则 2 的只读例外只保证"写不进去"（实测该连接上 INSERT/UPDATE/
//     `VACUUM INTO` 均 SQLITE_READONLY），**不阻止 ATTACH 别的文件**（实测 ATTACH
//     会成功并创建目标文件，但对挂上的库写入同样只读）；这是平台自省路径的既有权能，
//     应用侧不可达（应用没有 SQL 之外的能力，拿不到这条连接）。
//   - 守卫按**路径**匹配：数据根先被替换成符号链接时（需要"能写数据根"的本地攻击者，
//     应用自身无文件能力）匹配会落空 —— 与审计 UNVERIFIED-4 的边界相同。
const (
	// dsnConnTokenParam 是本包私有 DSN 令牌的参数名。用 `_` 前缀与驱动的
	// `_pragma` / `_txlock` 同风格；驱动对未知参数直接忽略（v1.55.0 实测）。
	dsnConnTokenParam = "_picoaide_appdb"
	// connTokenBytes 是一次性令牌的随机字节数（hex 编码后 32 字符，不可猜）。
	connTokenBytes = 16
)

var (
	connGuardMu     sync.Mutex
	connGuardDirs   = map[string]struct{}{} // 受保护的应用目录（绝对路径，含库文件所在目录）
	connGuardTokens = map[string]struct{}{} // 仍在有效窗口内的一次性令牌
)

// registerGuardedAppDir 登记一个受保护的应用目录（幂等）。由 Open 调用。
func registerGuardedAppDir(dir string) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		abs = dir
	}
	connGuardMu.Lock()
	connGuardDirs[filepath.Clean(abs)] = struct{}{}
	connGuardMu.Unlock()
}

// isGuardedAppDBPath 判断一个已归一化的路径是否落在任一受保护应用目录内。
func isGuardedAppDBPath(path string) bool {
	connGuardMu.Lock()
	defer connGuardMu.Unlock()
	for dir := range connGuardDirs {
		if path == dir || strings.HasPrefix(path, dir+string(filepath.Separator)) {
			return true
		}
	}
	return false
}

// newConnToken 生成一个不可猜的一次性令牌。
func newConnToken() (string, error) {
	var buf [connTokenBytes]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf[:]), nil
}

func allowConnToken(token string) {
	connGuardMu.Lock()
	connGuardTokens[token] = struct{}{}
	connGuardMu.Unlock()
}

func revokeConnToken(token string) {
	connGuardMu.Lock()
	delete(connGuardTokens, token)
	connGuardMu.Unlock()
}

func connTokenValid(token string) bool {
	if token == "" {
		return false
	}
	connGuardMu.Lock()
	defer connGuardMu.Unlock()
	_, ok := connGuardTokens[token]
	return ok
}

// appDBDSN 拼接带令牌的 DSN（路径不含 `?`/`#` 已由 Open 保证）。
func appDBDSN(path, token string) string {
	return path + "?" + dsnConnTokenParam + "=" + token
}

// registerMaxPageCountHook 注册进程级连接钩子（幂等）。
//
// 钩子是「防回归 + fail-closed 门」而不是主闸门：主闸门是 Open 时对两条持有连接的
// 显式加固 + 金丝雀（L1/L4），以及"池里只有这两条"（L2）。
func registerMaxPageCountHook() {
	hookOnce.Do(func() {
		sqlite.RegisterConnectionHook(func(conn sqlite.ExecQuerierContext, dsn string) error {
			path, ok := dsnDatabaseFile(dsn)
			if !ok || !isGuardedAppDBPath(path) {
				// 不是本包托管的应用库：不碰别人的连接（不改限额、不拒绝）。
				return nil
			}
			if connTokenValid(dsnParamValue(dsn, dsnConnTokenParam)) {
				return backstopMaxPageCount(conn)
			}
			// 未带有效令牌：只有引擎层只读的连接才放行（平台自省路径）。
			qo, err := connQueryOnly(conn)
			if err != nil {
				return fmt.Errorf("appdb: 无法确认该连接是只读（拒绝打开应用库 %s）：%w", filepath.Base(path), err)
			}
			if qo != 1 {
				return fmt.Errorf("appdb: 拒绝打开应用库 %s：连接没有经过 appdb.Open 加固（缺少一次性连接令牌）", filepath.Base(path))
			}
			return backstopMaxPageCount(conn)
		})
	})
}

// backstopMaxPageCount 给允许创建的连接兜底设置体积上限。
// 只读连接上这条 PRAGMA 同样有效（它是连接级参数，不写库文件）。
func backstopMaxPageCount(conn sqlite.ExecQuerierContext) error {
	_, err := conn.ExecContext(context.Background(),
		fmt.Sprintf("PRAGMA max_page_count = %d", limits.AppDBMaxPageCount), nil)
	return err
}

// connQueryOnly 在钩子里读回 `PRAGMA query_only`（ExecQuerierContext 同时提供
// QueryContext，实测钩子内可用）。
func connQueryOnly(conn sqlite.ExecQuerierContext) (int64, error) {
	rows, err := conn.QueryContext(context.Background(), "PRAGMA query_only", nil)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	dest := make([]driver.Value, len(rows.Columns()))
	for {
		if err := rows.Next(dest); err != nil {
			if errors.Is(err, io.EOF) {
				return 0, nil
			}
			return 0, err
		}
		if v, ok := dest[0].(int64); ok {
			return v, nil
		}
	}
}

// dsnParamValue 取 DSN 查询串里某个参数的值（不存在返回空串）。
func dsnParamValue(dsn, key string) string {
	i := strings.IndexByte(dsn, '?')
	if i < 0 {
		return ""
	}
	q, err := url.ParseQuery(dsn[i+1:])
	if err != nil {
		return ""
	}
	return q.Get(key)
}

// dsnDatabaseFile 把 DSN 归一化成宿主文件系统的绝对路径；
// 内存库（`:memory:` / `file::memory:`）与无法解析的形态返回 ok=false。
func dsnDatabaseFile(dsn string) (string, bool) {
	p := dsn
	if i := strings.IndexByte(p, '?'); i >= 0 {
		p = p[:i]
	}
	if p == "" || strings.HasPrefix(p, ":") {
		return "", false
	}
	if rest, ok := strings.CutPrefix(p, "file:"); ok {
		switch {
		case strings.HasPrefix(rest, "//"):
			// file://host/path（host 必须为空或 localhost）或 file:///abs/path
			u, err := url.Parse(p)
			if err != nil || (u.Host != "" && !strings.EqualFold(u.Host, "localhost")) {
				return "", false
			}
			rest = u.Path
		case strings.HasPrefix(rest, "/"):
			// file:/abs/path
		default:
			// file:relative/path 与 file::memory: 等特殊形态：只接受不含 `:` 的相对路径。
			if strings.Contains(rest, ":") {
				return "", false
			}
		}
		p = rest
	}
	if p == "" {
		return "", false
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", false
	}
	return filepath.Clean(abs), true
}

var hookOnce sync.Once

// connectionLimit 是「SQLITE_LIMIT_\* 常量 → 设计文档给定值」的一行。
type connectionLimit struct {
	id    int
	value int
	name  string
}

// connectionLimits 的每一个值都取自 limits 包（数值单一真源，§5.5）。
// 顺序即 §4.5 表格顺序；测试逐条读回比对。
func connectionLimits() []connectionLimit {
	return []connectionLimit{
		{sqlite3.SQLITE_LIMIT_LENGTH, limits.SQLLimitLength, "LENGTH"},
		{sqlite3.SQLITE_LIMIT_SQL_LENGTH, limits.SQLLimitSQLLength, "SQL_LENGTH"},
		{sqlite3.SQLITE_LIMIT_COLUMN, limits.SQLLimitColumn, "COLUMN"},
		{sqlite3.SQLITE_LIMIT_EXPR_DEPTH, limits.SQLLimitExprDepth, "EXPR_DEPTH"},
		{sqlite3.SQLITE_LIMIT_COMPOUND_SELECT, limits.SQLLimitCompoundSelect, "COMPOUND_SELECT"},
		{sqlite3.SQLITE_LIMIT_VDBE_OP, limits.SQLLimitVDBEOp, "VDBE_OP"},
		{sqlite3.SQLITE_LIMIT_FUNCTION_ARG, limits.SQLLimitFunctionArg, "FUNCTION_ARG"},
		// ATTACHED=0 同时是 ATTACH 与 VACUUM INTO 的唯一闸门（实测，§15.2）。
		{sqlite3.SQLITE_LIMIT_ATTACHED, limits.SQLLimitAttached, "ATTACHED"},
		{sqlite3.SQLITE_LIMIT_LIKE_PATTERN_LENGTH, limits.SQLLimitLikePatternLength, "LIKE_PATTERN_LENGTH"},
		{sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, limits.SQLLimitVariableNumber, "VARIABLE_NUMBER"},
		{sqlite3.SQLITE_LIMIT_TRIGGER_DEPTH, limits.SQLLimitTriggerDepth, "TRIGGER_DEPTH"},
		{sqlite3.SQLITE_LIMIT_WORKER_THREADS, limits.SQLLimitWorkerThreads, "WORKER_THREADS"},
		{sqlite3.SQLITE_LIMIT_PARSER_DEPTH, limits.SQLLimitParserDepth, "PARSER_DEPTH"},
	}
}

// Path 返回库文件的绝对路径（诊断/备份用；路径由宿主推导，不接受应用输入）。
func (d *DB) Path() string { return d.path }

// Dir 返回应用数据目录（诊断用）。
func (d *DB) Dir() string { return d.dir }

// Close 释放 1+N 条连接与池子。幂等；之后再调用 db.\* 会按需重连（重连同样加固 + 金丝雀）。
//
// ⚠️ "可重连"是**会话边界**的语义。句柄生命周期终点请用 Retire（不可重连的终态）——
// 句柄池的淘汰/关停路径一律走它，否则被放弃的宿主调用能在回收之后把库复活（R1-rt-5）。
//
// **Close 会清掉污染标记与事务写闸**（审计 P0-2 的第二半）：Close 之后对象只剩磁盘上的
// 库文件，下一次调用走的是全新连接 + 全套加固 + 金丝雀 ⇒ 污染所约束的那条连接已经
// 不存在了，继续拒绝服务没有任何安全收益，只会把"一次超时"放大成"进程重启前永久不可用"。
// 这与本包头部注释（「Close 之后按需重连」）以及 capapi.DB 的生命周期口径一致。
//
// 关连接前**先排空在途读者**（见 closeLocked 的不变式）：Close 会阻塞到所有正在执行的
// 只读语句结束（它们各自受单语句 5 s 硬预算约束），绝不在读者脚下关连接。
func (d *DB) Close() error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	d.clearPoisonLocked()
	d.stateMu.Lock()
	closed := d.closed
	d.stateMu.Unlock()
	if closed {
		return nil
	}
	return d.closeLocked()
}

// Retire 把句柄置为**终态**并关闭连接：此后**不可能**再建立连接，db.\* 一律返回
// ErrRetired 语义的错误（apperr.CodeDBDenied）。
//
// 与 Close 的分工（审计 R1-rt-5）：
//   - Close  = 会话边界：释放连接，但"之后按需重连"（污染恢复、下一次调用都会用到它）；
//   - Retire = 生命周期终点：句柄已从池里摘除 / 服务端关停 ⇒ 谁还持有这个对象的引用
//     （最典型的是被放弃的宿主调用 goroutine）都只会拿到一次明确报错。
//
// 幂等；Retire 之后 Close 是 no-op。关连接前同样**先排空在途读者**（见 closeLocked
// 的不变式），所以 Retire 可能阻塞到在途只读语句结束（它们各自受单语句 5 s 预算约束）。
func (d *DB) Retire() error {
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	d.clearPoisonLocked()
	d.stateMu.Lock()
	already := d.retired
	d.retired = true
	closed := d.closed
	d.stateMu.Unlock()
	if already || closed {
		return nil
	}
	return d.closeLocked()
}

// Retired 报告句柄是否已进入终态（诊断/测试断言用）。
func (d *DB) Retired() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.retired
}

// retiredError 是终态句柄上任何调用的统一错误。
//
// 为什么是 DB_DENIED 而不是 INTERNAL：这不是平台内部故障，而是"这个库句柄已经结束了"，
// 应用侧的应对是**重试请求**（下一个请求会拿到全新句柄）。文案与 hints 都按这个口径写，
// 绝不 panic（被放弃的 goroutine 里 panic 会打穿宿主边界）。
func (d *DB) retiredError() *apperr.Error {
	return apperr.New(apperr.CodeDBDenied, "应用库句柄已被平台回收，本次调用不再执行").
		WithDetail("reason", "appdb_retired").
		WithDetail("app_id", d.appID).
		WithHint("这是宿主调用的兜底路径（原请求已超过预算并被放弃）：重试该请求即可，" +
			"新请求会拿到全新的应用库句柄")
}

// clearPoisonLocked 清掉污染标记与事务写闸（幂等）。
func (d *DB) clearPoisonLocked() {
	d.stateMu.Lock()
	d.poisoned = nil
	d.deadTx = nil
	d.stateMu.Unlock()
}

// closeLocked 关闭这一代全部连接与池子。调用方必须持有 writeMu。
//
// **不变式（破坏它就是 use-after-close 或 fd 泄漏）：任何会走 closeLocked() 的路径
// 都必须先独占全部只读槽 —— 排空在途读者。** 落地顺序：
//
//  1. stateMu 下把这一代标成已关闭并 `close(genClosed)`：① 让**新**读者不再走
//     "取槽执行"的快路径（它们会退化成串行路径并在 writeMu 上排队）；② 让卡在
//     "等一个槽"上的读者立刻醒过来改走串行路径（否则它们会等一个永远不回来的槽）。
//  2. 排空 roSlots 的 N 个槽：这一步会**阻塞到每一个在途读者归还它的槽**，
//     所以收齐 N 个槽之后可以保证没有任何读者正在执行语句。
//  3. 关连接（rw + N 条只读 + sql.DB）。rw 由 writeMu 独占，不需要第 2 步那套协议。
//
// 注意步骤 1 之后仍可能有读者"已经拿到槽、正在执行"—— 那正是步骤 2 要等的东西；
// 也仍可能有读者"在 select 里同时看到空槽与 genClosed"而拿到一个槽，那同样会被
// 步骤 2 等回来（它执行完必然归还）。
func (d *DB) closeLocked() error {
	d.stateMu.Lock()
	gen := d.genClosed
	d.genClosed = nil
	d.closed = true
	tx := d.tx
	d.tx = nil
	d.stateMu.Unlock()
	if gen != nil {
		// 只关一次：上面已经把字段置空，重复进入 closeLocked 不会再关同一个 channel。
		close(gen)
	}

	// 排空在途读者（收齐 N 个槽才继续）。读者语句有 5 s 硬预算 ⇒ 这一步有界。
	slots := d.drainReadSlots()

	d.stateMu.Lock()
	ros := d.ros
	d.ros = nil
	rw := d.rw
	d.rw = nil
	sqlDB := d.sqlDB
	d.sqlDB = nil
	d.stateMu.Unlock()

	var first error
	if tx != nil {
		// 事务未结束就关闭：强制回滚（fail-closed，绝不留下半开事务）。
		if tx.timer != nil {
			tx.timer.Stop()
		}
		if tx.cancel != nil {
			tx.cancel()
		}
		if rw != nil {
			ctx, cancel := context.WithTimeout(context.Background(), d.budget)
			_, _ = rw.ExecContext(ctx, "ROLLBACK")
			cancel()
		}
	}
	// 这里刻意不再补跑统计查询：关库路径不能被任何（可能还在跑的）查询拖住；
	// Stats 的 Tables 用最近一次观测值（connectLocked / db.define 维护）。
	for _, c := range slots {
		if c == nil {
			continue // 空槽：这一代从未建满过（例如建连中途失败）
		}
		if err := c.Close(); err != nil && first == nil {
			first = err
		}
	}
	// 收齐的槽位**原样填回**（含空槽）：槽位数量守恒是"下一次关连接仍能收齐 n 个槽"
	// 的前提。此刻通道里的槽已被我们全部取走、且 closed=true（新读者只会退化），
	// 所以这里的 n 次 send 不会阻塞。
	for range slots {
		d.roSlots <- nil
	}
	_ = ros // ros 与 slots 是同一批指针；这里只用 slots（它是"收齐"的证据）
	if rw != nil {
		if err := rw.Close(); err != nil && first == nil {
			first = err
		}
	}
	if sqlDB != nil {
		if err := sqlDB.Close(); err != nil && first == nil {
			first = err
		}
	}
	return first
}

// drainReadSlots 收齐这一代的 N 个只读槽（排空在途读者）。调用方必须持有 writeMu。
//
// 为什么可以无条件等：每个在途读者的语句都套着单语句硬预算（stmtContext），
// 到点由驱动中断并归还槽位；而"归还槽位"是纯 channel 操作（不取锁）⇒ 不会与
// 持 writeMu 的关连接路径互锁。
func (d *DB) drainReadSlots() []*sql.Conn {
	out := make([]*sql.Conn, 0, d.readers)
	for i := 0; i < d.readers; i++ {
		out = append(out, <-d.roSlots)
	}
	return out
}

// Stats 返回本次请求累计的行数/字节与库结构信息（§4.9 调用事件字段）。
//
// Stats 永不返回错误、**也不查库**：它在请求路径上被调用（serve.go 收尾），
// 改造前它持对象锁跑一条 count(*) —— 一次 5 s 的写事务/慢查询会把计量统计一起拖住。
// 现在只读原子计数（Tables 由 connectLocked 与 db.define 维护）与文件的 stat。
//
// SizeBytes 是**主库 + WAL 的和**：WAL 下已提交数据可能还躺在 -wal 里（未检查点），
// 只 stat 主库会系统性低估用量；100 MB 硬限（max_page_count）本来就是按逻辑页数算的，
// 两者口径因此一致。
func (d *DB) Stats() capapi.DBStats {
	return capapi.DBStats{
		Rows:      d.rows.Load(),
		Bytes:     d.bytes.Load(),
		Tables:    int(d.tables.Load()),
		SizeBytes: d.diskSizeBytes(),
	}
}

// diskSizeBytes 返回主库 + WAL 的字节数（都不可读时返回 0）。
func (d *DB) diskSizeBytes() int64 {
	var total int64
	for _, p := range []string{d.path, d.path + "-wal"} {
		if fi, err := os.Stat(p); err == nil {
			total += fi.Size()
		}
	}
	return total
}

// countTablesLocked 统计应用自己的表数（排除 sqlite_ 内部表：AUTOINCREMENT 会建
// sqlite_sequence）。调用方必须持有 writeMu（它跑在 rw 上）。
func (d *DB) countTablesLocked(ctx context.Context) (int, error) {
	return d.countTablesOn(ctx, d.writeConn())
}

// countTablesOn 在指定连接上统计应用表数。
//
// 为什么要能指定连接：connectLocked 里这一代连接**还没发布**到 d 上（发布是最后一步，
// 见那里的注释），所以只能用局部变量 rw —— 用 d.writeConn() 会拿到 nil 并把表数记成 0
// （实测：重开既有库时 cachedTables 变成 0，TestOpenReopensExistingDB 因此变红）。
func (d *DB) countTablesOn(ctx context.Context, conn *sql.Conn) (int, error) {
	if conn == nil {
		return int(d.tables.Load()), nil
	}
	var n int
	// 用 substr 而不是 LIKE 'sqlite_%'：LIKE 的 `_` 是单字符通配符。
	err := conn.QueryRowContext(ctx,
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_'`).Scan(&n)
	if err != nil {
		return int(d.tables.Load()), d.mapStmtError(ctx, err)
	}
	return n, nil
}

// ensureReadyLocked 是所有对外方法的入口守卫：闭库则按需重连，污染则按规则恢复。
//
// 注意签名里**没有 ctx**：连接建立/重建/污染恢复都是宿主侧维护动作，用独立的宿主预算
// 完成（与 rollbackLocked 同一口径）。理由：单语句超时往往正是"调用方 ctx 到期"造成的，
// 若维护动作也吃调用方 ctx，同一个请求里的下一次调用会拿到"获取连接失败"这种误导性
// 错误，而它应得的是 statement_timeout；调用方 ctx 只约束**语句本身**。
//
// write 表示本次调用**可能写入**（db.exec / db.define / tx）：事务硬超时后的写闸
// （deadTx）只对写生效 —— 读可以在重连后立刻恢复，写绝不能在应用以为自己在事务里时
// 落到自动提交模式（tx.go 头注释）。
//
// 污染恢复规则（FIX-10 / FIX-15.4，把"对象级永久污染"改成"按语句 / 按会话可恢复"）：
//   - **事务内**语句超时（d.tx != nil）：不在这里静默重连 —— 那等于把事务体后半段的
//     写降级成自动提交。如实返回污染错误，让事务看门狗（5 s）走完它自己的回滚 + 置位；
//   - **单语句**超时（无事务）：丢弃整组连接（**绝不复用**被中断的那条）后立即重连，
//     本次调用继续 ⇒ 一次超时的代价是一次重连（毫秒级），不是"永久打死应用"；
//   - **事务硬超时**（看门狗置位）：同样丢弃整组连接后重连，但**读**继续、**写**继续
//     返回超时错误（deadTx 写闸），直到会话边界（Close / 句柄池回收句柄）清掉。
//
// 调用方必须持有 writeMu：本函数可能在 dropPoisonedConnectionsLocked 里**关掉并重建**
// 全部 1+N 条连接（那正是"排空在途读者"的那条路径），必须与所有关连接路径互斥。
func (d *DB) ensureReadyLocked(write bool) error {
	d.stateMu.Lock()
	retired := d.retired
	poisoned := d.poisoned
	inTx := d.tx != nil
	deadTx := d.deadTx
	d.stateMu.Unlock()
	// 终态优先于一切恢复路径（R1-rt-5）：它**不**允许重连，也不允许污染恢复
	// （恢复的第一件事就是重连，那正是漏洞本身）。
	if retired {
		return d.retiredError()
	}
	if poisoned != nil {
		if inTx {
			// 事务内不在这里静默重连（那等于把事务体后半段的写降级成自动提交）。
			return poisoned
		}
		d.dropPoisonedConnectionsLocked()
	}
	if deadTx != nil && write {
		return deadTx
	}
	return d.ensureConnLocked()
}

// ensureConnLocked 在闭库/缺连接时用**独立宿主预算**建立连接（调用方必须持有 writeMu）。
func (d *DB) ensureConnLocked() error {
	// 防御性复检（R1-rt-5）：调用方是持 writeMu 的恢复路径，而"终态"与"关闭态"的唯一
	// 区别就是**不许重连** —— 这条判据必须落在真正建连的函数上，而不是只在 ensureReadyLocked
	// （将来新增一条恢复路径忘了过闸时，这里仍然 fail-closed）。
	if d.isRetired() {
		return d.retiredError()
	}
	if d.ready() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), d.budget)
	defer cancel()
	return d.connectLocked(ctx)
}

// ready 报告这一代连接是否已就绪（stateMu 下判定；调用方须持有 writeMu 才不会与
// connectLocked/closeLocked 的发布动作交错）。
func (d *DB) ready() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return !d.closed && !d.retired && d.sqlDB != nil && d.rw != nil && len(d.ros) == d.readers && d.genClosed != nil
}

// isRetired 报告终态（stateMu 下判定；与 ready 同一把锁的顺序）。
func (d *DB) isRetired() bool {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	return d.retired
}

// dropPoisonedConnectionsLocked 丢弃被污染的一整代连接（含强制回滚）并清掉污染标记。
//
// "不复用"的落地点就是 closeLocked：**全部 1+N 条**连接（含被中断的那条）一起关闭，
// 而且关之前会排空在途读者（closeLocked 的不变式）—— 绝不在别的请求脚下关连接；
// 重连由调用方接着走 ensureConnLocked（全新的 sql.DB + 全套限额 + 金丝雀，fail-closed）。
// deadTx 不在这里清（它是"写闸"，只由 Close 清）。调用方必须持有 writeMu。
func (d *DB) dropPoisonedConnectionsLocked() {
	// closeLocked 的返回值刻意忽略：关库失败不应阻止恢复；重连失败会由 ensureConnLocked 如实返回。
	_ = d.closeLocked()
	d.stateMu.Lock()
	d.poisoned = nil
	d.stateMu.Unlock()
}

// poisonLocked 打上连接污染标记（超时/取消后绝不复用连接，§11）。
// 事务硬超时额外置"写闸" deadTx（见 DB.deadTx 的注释）。
func (d *DB) poisonLocked(err *apperr.Error) {
	d.stateMu.Lock()
	defer d.stateMu.Unlock()
	if d.poisoned == nil {
		d.poisoned = err
	}
	if reasonOf(err) == ReasonTransactionTimeout && d.deadTx == nil {
		d.deadTx = err
	}
}

// stmtContext 给单条语句套上预算：事务内额外受事务 ctx 约束（两者取更早的截止）。
//
// 调用方必须持有 writeMu（所有语句都跑在串行路径上）；d.tx 的发布/清除在 stateMu 下，
// 这里取一次快照。
func (d *DB) stmtContext(ctx context.Context) (context.Context, context.CancelFunc) {
	d.stateMu.Lock()
	tx := d.tx
	d.stateMu.Unlock()
	if tx != nil {
		return context.WithTimeout(tx.ctx, d.budget)
	}
	return context.WithTimeout(ctx, d.budget)
}

// mapStmtError 把驱动错误映射成平台错误码（§7.4）。
//
// 超时/取消 → DB_DENIED + reason=ReasonStatementTimeout：
// 设计 §7.4 没有单独的「SQL 超时」码，只有 DB_LIMIT（507）与 DB_DENIED（403，语句被拒类）。
// 语句超时属于「这条语句不被允许执行完」，因此用 DB_DENIED，并在 details 里给出
// `reason` 供 AI/作者与**句柄池**判别（常量是两端唯一真源，见 ReasonStatementTimeout）。
//
// 错误码归属（已与模块负责人确认，属 §7.4 的缺码项）：
//   - DB_DENIED(403) = 语句被闸门拒 / 超时 / 语法或约束错误 —— 即「这条语句没被执行」；
//   - DB_LIMIT(507)  **只**表示「库写满」（SQLITE_FULL ⇒ 100 MB 上限）；
//     返回超行/超字节不走错误码，而是按 §4.5 截断 + QueryResult.Truncated 表达。
func (d *DB) mapStmtError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) ||
		errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(ctx.Err(), context.Canceled) {
		e := apperr.Newf(apperr.CodeDBDenied,
			"SQL 语句超时：单语句硬预算 %s，已中断该语句", limits.SQLStatementBudget).
			WithDetail("reason", ReasonStatementTimeout).
			WithDetail("budget_ms", limits.SQLStatementBudget.Milliseconds()).
			WithCause(err).
			WithHint("请缩小查询范围（加条件/加 LIMIT）、避免无界递归，或把大查询拆成多次调用")
		d.poisonLocked(e)
		return e
	}
	var se *sqlite.Error
	if errors.As(err, &se) {
		// 按**主码**分支：modernc 返回的是扩展码（唯一约束冲突 = SQLITE_CONSTRAINT_PRIMARYKEY
		// 1555），精确等于 SQLITE_CONSTRAINT(19) 永远不成立 ⇒ 老实现的约束分支是死代码，
		// 应用只拿到"SQLite 错误码 1555"这种没有信息量的文案（审计 P2-4）。扩展码另放进
		// details.sqlite_code，便于作者/平台排查；文案统一用引擎原文（scrub 过宿主路径）。
		extended := se.Code()
		switch extended & 0xff {
		case sqlite3.SQLITE_FULL:
			// 100 MB 满（max_page_count 生效）：507（§7.4 DB_LIMIT）。
			return apperr.Newf(apperr.CodeDBLimit,
				"应用数据库已满（上限 %d MB），本次写入被拒绝", limits.AppDBMaxBytes>>20).
				WithDetail("reason", "database_full").
				WithDetail("limit_bytes", limits.AppDBMaxBytes).
				WithCause(err).
				WithHint("请清理历史数据，或联系平台管理员扩容")
		case sqlite3.SQLITE_TOOBIG:
			return apperr.New(apperr.CodeDBDenied, "单值超过 1 MiB 上限（SQLITE_LIMIT_LENGTH）").
				WithDetail("reason", "value_too_large").
				WithDetail("limit_bytes", limits.SQLLimitLength).
				WithCause(err)
		case sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED:
			return apperr.New(apperr.CodeDBDenied, "应用数据库正被占用，请稍后重试").
				WithDetail("reason", "database_busy").
				WithCause(err)
		case sqlite3.SQLITE_AUTH, sqlite3.SQLITE_READONLY, sqlite3.SQLITE_PERM:
			return apperr.New(apperr.CodeDBDenied, "该语句被数据库拒绝（只读连接或权限不足）").
				WithDetail("reason", "readonly").
				WithCause(err)
		case sqlite3.SQLITE_INTERRUPT, sqlite3.SQLITE_ABORT:
			return apperr.New(apperr.CodeDBDenied, "SQL 语句被中断（超时或模块被取消）").
				WithDetail("reason", "interrupted").
				WithCause(err)
		case sqlite3.SQLITE_CONSTRAINT:
			// 约束违例（唯一/主键/非空/检查/外键）：用**扩展码的主码**分支（见上），
			// 并单独给一个 reason，让 AI 作者能区分"SQL 写错了"（sql_error）与
			// "数据冲突了"（constraint_violation）；引擎原文必须保留
			// （哪条约束、哪个值冲突）。应用无法指定主键，所以这条路径今天主要由
			// `INSERT INTO t SELECT * FROM t` 之类的自冲突触发。
			return apperr.Newf(apperr.CodeDBDenied, "SQL 约束违例：%s", d.scrubLocked(se.Error())).
				WithDetail("reason", "constraint_violation").
				WithDetail("sqlite_code", extended).
				WithCause(err).
				WithHint("约束冲突不会改坏库：请先查询现有数据，再改写成不冲突的语句")
		default:
			// 其它语句级错误（语法/参数/其它）：同样保留引擎原文（§7.4 首句：
			// 错误的第一消费者是 AI 作者），且只涉及应用自己的库；仍要过一遍脱敏，
			// 避免 I/O 类消息里带上宿主路径。
			return apperr.Newf(apperr.CodeDBDenied, "SQL 执行失败：%s", d.scrubLocked(se.Error())).
				WithDetail("reason", "sql_error").
				WithDetail("sqlite_code", extended).
				WithCause(err)
		}
	}
	return apperr.New(apperr.CodeDBDenied, "SQL 执行失败").WithCause(err)
}

// scrubLocked 从驱动错误文本里抹掉宿主路径（数据根/应用目录/库文件），
// 保证应用侧错误不泄露文件系统布局（§4.4：宿主函数无路径语义）。
func (d *DB) scrubLocked(msg string) string {
	for _, p := range []string{d.path, d.dir, filepath.Dir(d.dir)} {
		if p == "" || p == "/" {
			continue
		}
		msg = strings.ReplaceAll(msg, p, "<app-data>")
	}
	return msg
}

// validAppID 校验 app_id（唯一真源：limits.AppIDPattern + limits.MaxAppIDLen）。
// 这条校验是路径推导的安全前提：app_id 会拼进文件路径，绝不能让 `..`/`/` 进来。
func validAppID(id string) bool {
	if id == "" || len(id) > limits.MaxAppIDLen {
		return false
	}
	return appIDRe.MatchString(id)
}
