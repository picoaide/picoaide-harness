package appserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/applimits"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
)

// ===== §4.5 句柄池：同应用复用 / 跨应用不共享 / 淘汰策略 =====

func TestAppDBPool_ReusesHandleForSameApp(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("dbreuse")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("第一次请求应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	first := e.srv.appdbs.lookup(appID)
	if first == nil {
		t.Fatal("首请求后池里应有该应用的句柄")
	}
	wantPath := filepath.Join(e.root, limits.AppsDirName, appID, "app.db")
	if first.db.Path() != wantPath {
		t.Fatalf("句柄库路径应由宿主推导为 %q，得到 %q", wantPath, first.db.Path())
	}

	if rec := e.get(appID, "/seed?n=3"); rec.Code != http.StatusOK {
		t.Fatalf("第二次请求应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	second := e.srv.appdbs.lookup(appID)
	if second == nil {
		t.Fatal("第二次请求后句柄不应消失")
	}
	if first != second {
		t.Fatal("同一应用的连续请求必须复用同一个句柄（一应用一 driver 实例，§4.5）")
	}
	if e.srv.appdbs.size() != 1 {
		t.Fatalf("池里应只有 1 个句柄，得到 %d", e.srv.appdbs.size())
	}

	// 数据落在同一个库里（同一句柄 ⇒ 同一连接组）：第二次请求写入的行在第三次能看到。
	rec := e.get(appID, "/q?sql="+urlQueryEscape("SELECT id, v FROM t ORDER BY id"))
	if rec.Code != http.StatusOK {
		t.Fatalf("查询应 200，得到 %d", rec.Code)
	}
	body := decodeJSON(t, rec.Body)
	if body["ok"] != true {
		t.Fatalf("查询应成功: %v", body)
	}
	if got, _ := body["row_count"].(float64); int(got) != 3 {
		t.Fatalf("应查到 3 行（同一应用库），得到 %v", body["row_count"])
	}
}

func TestAppDBPool_DoesNotShareAcrossApps(t *testing.T) {
	e := newEnv(t)
	appA := e.appID("dbshare-a")
	appB := e.appID("dbshare-b")
	e.publishApp(appSpec{appID: appA, wasm: appBinary(t, "dbapp")})
	e.publishApp(appSpec{appID: appB, wasm: appBinary(t, "dbapp")})

	if rec := e.get(appA, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("A 建表应 200，得到 %d", rec.Code)
	}
	if rec := e.get(appB, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("B 建表应 200，得到 %d", rec.Code)
	}
	ha, hb := e.srv.appdbs.lookup(appA), e.srv.appdbs.lookup(appB)
	if ha == nil || hb == nil {
		t.Fatal("两个应用都应有自己的句柄")
	}
	if ha == hb || ha.db.Path() == hb.db.Path() {
		t.Fatalf("不同应用绝不能共享句柄或库文件: %q vs %q", ha.db.Path(), hb.db.Path())
	}
	if e.srv.appdbs.size() != 2 {
		t.Fatalf("池里应有 2 个句柄，得到 %d", e.srv.appdbs.size())
	}

	// 数据隔离：B 的库里没有 A 写的行。
	if rec := e.get(appA, "/seed?n=2"); rec.Code != http.StatusOK {
		t.Fatalf("A 写入应 200，得到 %d", rec.Code)
	}
	rec := e.get(appB, "/q?sql="+urlQueryEscape("SELECT id FROM t"))
	body := decodeJSON(t, rec.Body)
	if got, _ := body["row_count"].(float64); int(got) != 0 {
		t.Fatalf("B 的库必须看不到 A 的数据（跨应用隔离），得到 %v 行", body["row_count"])
	}
}

func TestAppDBPool_IdleEvictionReopensFreshHandle(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("dbidle")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	first := e.srv.appdbs.lookup(appID)
	if first == nil {
		t.Fatal("应有句柄")
	}

	// 推进注入时钟越过空闲阈值 ⇒ 下一次 acquire 顺手淘汰旧句柄（并关掉它）。
	e.advance(appDBIdleTimeout + time.Minute)
	if rec := e.get(appID, "/q?sql="+urlQueryEscape("SELECT 1")); rec.Code != http.StatusOK {
		t.Fatalf("空闲回收后应能重开并成功，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	second := e.srv.appdbs.lookup(appID)
	if second == nil {
		t.Fatal("重开后池里应有新句柄")
	}
	if first == second {
		t.Fatal("空闲超过阈值后必须回收旧句柄（不得长期占着 fd）")
	}
	if e.srv.appdbs.size() != 1 {
		t.Fatalf("回收+重开后仍应只有 1 个句柄，得到 %d", e.srv.appdbs.size())
	}
}

func TestAppDBPool_CapEvictsLeastRecentlyUsed(t *testing.T) {
	e := newEnv(t)
	e.srv.appdbs.max = 1 // 池容量 1：模拟"很多人建了很多应用"的 fd 压力
	appA := e.appID("dbcap-a")
	appB := e.appID("dbcap-b")
	e.publishApp(appSpec{appID: appA, wasm: appBinary(t, "dbapp")})
	e.publishApp(appSpec{appID: appB, wasm: appBinary(t, "dbapp")})

	if rec := e.get(appA, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("A 应 200，得到 %d", rec.Code)
	}
	if rec := e.get(appB, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("B 应 200，得到 %d", rec.Code)
	}
	if e.srv.appdbs.size() != 1 {
		t.Fatalf("容量 1 时池里应只有 1 个句柄，得到 %d", e.srv.appdbs.size())
	}
	if e.srv.appdbs.lookup(appA) != nil {
		t.Fatal("最久未用的 A 应被淘汰")
	}
	if e.srv.appdbs.lookup(appB) == nil {
		t.Fatal("最近使用的 B 应留在池里")
	}
	// 被淘汰的应用再次访问：重开即可用（淘汰是缓存策略，不是功能降级）。
	if rec := e.get(appA, "/q?sql="+urlQueryEscape("SELECT 1")); rec.Code != http.StatusOK {
		t.Fatalf("被淘汰的应用应能重开，得到 %d body=%s", rec.Code, rec.Body.String())
	}
}

// ===== 只读连接数（app_db_readers）：1 写 + N 读的真实连接数 + 单飞 =====
//
// 这两条用例把"配置面 → 运行期"的最后一跳钉死：池把 app_db_readers 交给 appdb.Open，
// 而 appdb 真的开出 1 + N 条 SQLite 连接（用 /proc/self/fd 观测，不依赖 appdb 暴露
// 新接口 —— 它刚落定，接口面不动）。

// countOpenFiles 数出本进程里指向 path 的打开文件描述符个数（Linux /proc/self/fd）。
//
// 为什么用 fd 而不是 sql.DB.Stats().OpenConnections：appdb 的 *sql.DB 是包内私有，
// capapi.DBStats 里没有连接数；而"这个库文件被打开了几次"正是要断言的**外部事实**
// （1 写 + N 读各持一条连接）。非 Linux 环境直接 Skip（CI 与开发机都是 Linux）。
func countOpenFiles(t *testing.T, path string) int {
	t.Helper()
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		t.Skipf("读 /proc/self/fd 不可用（非 Linux？）：%v", err)
	}
	n := 0
	for _, e := range entries {
		target, err := os.Readlink(filepath.Join("/proc/self/fd", e.Name()))
		if err != nil {
			continue // 连接已被关闭（ReadDir 与 Readlink 之间）
		}
		if target == path {
			n++
		}
	}
	return n
}

// TestAppDBPool_HandleOpensOneWriterPlusReadersConnections：一个句柄恰好持有
// 1 + app_db_readers 条指向库文件的连接（写 1 + 读 N）。
//
// 变异：把 acquire 里的 `Readers: readers` 去掉（回到 appdb 默认 4）⇒ 显式配
// app_db_readers=1 时本用例必红（实测 5 条而不是 2 条）。
func TestAppDBPool_HandleOpensOneWriterPlusReadersConnections(t *testing.T) {
	e := newEnv(t)
	// 先把只读连接数改成 1（走真实的控制台下发路径 ApplyLimits），证明它是**可达**的。
	l := applimits.Defaults()
	l.AppDBReaders = 1
	if restart := e.srv.ApplyLimits(l); len(restart) != 0 {
		t.Fatalf("app_db_readers 不该要求重启，得到 %v", restart)
	}
	appID := e.appID("dbfds")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})
	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	h := e.srv.appdbs.lookup(appID)
	if h == nil {
		t.Fatal("首请求后池里应有该应用的句柄")
	}
	if got, want := countOpenFiles(t, h.db.Path()), 2; got != want {
		t.Fatalf("app_db_readers=1 时库文件的打开数 = %d，want %d（1 写 + 1 读）", got, want)
	}

	// 复位到默认：**已有句柄不受影响**（语义=下一个句柄），空闲回收后才跟上。
	l = applimits.Defaults()
	if restart := e.srv.ApplyLimits(l); len(restart) != 0 {
		t.Fatalf("复位不该要求重启，得到 %v", restart)
	}
	if got := countOpenFiles(t, h.db.Path()); got != 2 {
		t.Fatalf("已有句柄不该被改动：打开数 = %d，want 2（下一个句柄才拿新值）", got)
	}
	e.advance(appDBIdleTimeout + time.Minute)
	if rec := e.get(appID, "/q?sql="+urlQueryEscape("SELECT 1")); rec.Code != http.StatusOK {
		t.Fatalf("空闲回收后应能重开，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	h2 := e.srv.appdbs.lookup(appID)
	if h2 == nil || h2 == h {
		t.Fatal("空闲回收后应是一个**新**句柄（旧句柄已关闭）")
	}
	if got, want := countOpenFiles(t, h2.db.Path()), 1+limits.AppDBReaders; got != want {
		t.Fatalf("下一个句柄的打开数 = %d，want %d（1 写 + %d 读）", got, want, limits.AppDBReaders)
	}
}

// TestAppDBPool_ConcurrentFirstRequestsShareOneOpen：冷应用的并发首屏只开一次库，
// 且**每个请求都成功**（不是"一条成功、其余 500"）。
//
// 为什么单列一条（实测踩到）：`appdb.Open` 里的 `PRAGMA journal_mode=WAL` 需要库级写锁，
// 而 SQLite 对改 journal_mode 不套用 busy_timeout 重试 ⇒ 并发 Open 同一个库时，
// 一条成功、另一条直接 SQLITE_BUSY → 500「应用执行失败」。app_running 默认 1 时队列
// 把同应用请求串行化，这条路径走不到；默认 4 之后冷应用的并发首屏必然踩到。
// 修法=池里的同应用单飞（appDBOpenFlight）；本用例是它的护栏。
//
// 变异：去掉 acquire 里的 opening 分支 ⇒ 本用例出现 500（且 fd 数 > 1+N）。
func TestAppDBPool_ConcurrentFirstRequestsShareOneOpen(t *testing.T) {
	// ⚠️ 单用户同应用同时运行数默认是 1（§4.6）⇒ 四个请求必须来自**四个不同员工**，
	// 否则它们被队列串行化，本用例的前提（并发 Open 撞 WAL 写锁）就消失了（2026-09-19
	// W4 身份一律注入后实测：同用户会被串行）。这里用 4 个员工恢复真实并发。
	e := newEnv(t, func(o *Options) {
		o.Scheduler = queue.New(queue.Options{PerUserPerAppRunning: 4, PerUserPerAppQueued: 4, PerUserGlobalRunning: 4})
	})
	appID := e.appID("dbopenflight")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	const n = 4
	var wg sync.WaitGroup
	codes := make([]int, n)
	bodies := make([]string, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			rec := e.get(appID, "/q?sql="+urlQueryEscape("SELECT 1"))
			codes[i], bodies[i] = rec.Code, rec.Body.String()
		}(i)
	}
	close(start)
	wg.Wait()

	for i := 0; i < n; i++ {
		if codes[i] != http.StatusOK {
			t.Fatalf("并发首屏第 %d 个请求应 200，得到 %d body=%s（并发 Open 同一库撞 WAL 写锁？）",
				i, codes[i], bodies[i])
		}
	}
	if size := e.srv.appdbs.size(); size != 1 {
		t.Fatalf("并发首屏后池里应有 1 个句柄，得到 %d（各开一份 = 连接与 fd 白翻 N 倍）", size)
	}
	h := e.srv.appdbs.lookup(appID)
	if h == nil {
		t.Fatal("应留下一个句柄")
	}
	if got, want := countOpenFiles(t, h.db.Path()), 1+limits.AppDBReaders; got != want {
		t.Fatalf("库文件的打开数 = %d，want %d（只开了一次：1 写 + %d 读）", got, want, limits.AppDBReaders)
	}
	if h.inflight != 0 {
		t.Fatalf("请求都结束后句柄引用应归零，得到 %d（引用预约协议漏还）", h.inflight)
	}
}

// ===== 事务所有权（app_running>1 打开的正确性边界）=====
//
// 缺陷形态（appdb 作者在交付时点名）：事务挂在句柄的读写连接上，而 db.exec 没有
// "事务令牌" —— appdb 区分不了"事务持有者的写"与"别的请求的写"。于是同应用另一个
// 请求的 db.exec 会落进别人已打开的事务里：持有者一回滚，那个写就被**静默丢掉**
// （数据丢失，不是报错）。app_running=1 时队列串行 + 句柄整请求互斥让这条路径不可达；
// 默认值调到 4 之后它就是默认行为。
//
// **事务出口**（tx_commit / tx_rollback）是同一类越权的第二个入口（2026-09-19
// 独立验证 F1 补上）：`abi.TxParams.TxID` 是**可选**字段，而 appdb 的串号校验是
// `if p.TxID != 0 && p.TxID != tx.id` ⇒ 传 0（或干脆不传）即跳过校验。出口原先在
// 包装层是**直接透传**，于是外来请求可以提交别人的未提交写、或把别人的写回滚掉。
//
// 下面三条用例从三个层次闭合它：
//   - TestAppDBConn_ForeignWriteIsRejectedWhileAnotherRequestHoldsTransaction：包装层
//     （两个请求 = 两份 appDBConn，共用同一句柄）的**确定性**判据；
//   - TestAppDBConn_ForeignTxFinishIsRejected：包装层的事务**出口**判据（commit 与
//     rollback 各一档，含 tx_id 省略 / 0 / 真 id 三种形态）；
//   - TestServe_ForeignWriteDuringTransactionIsRejected 与
//     TestServe_ForeignTxFinishDuringTransactionIsRejected：端到端（真 wasm 应用开事务、
//     真 HTTP 请求来写 / 来 commit）—— 证明接线真的在服务路径上。
//
// 变异验证：去掉 Exec/Define/Commit/Rollback 的 lockTxGate（回到直接透传）⇒ 上述用例的
// "必须被拒"断言立刻变红；端到端那两条还能直接观察到"B 的写随 A 的回滚一起消失"与
// "B 把 A 的事务提前提交/回滚掉"（见测试里的数据断言）。

// assertDBDenied 断言错误是 DB_DENIED/foreign_transaction（事务所有权拒绝）。
func assertDBDenied(t *testing.T, err error, what string) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s：必须被拒（否则会落进别人的事务，随对方回滚被静默丢弃）", what)
	}
	e, ok := apperr.As(err)
	if !ok {
		t.Fatalf("%s：错误类型不是 *apperr.Error：%T %v", what, err, err)
	}
	if e.Code != apperr.CodeDBDenied {
		t.Fatalf("%s：错误码 = %s，want DB_DENIED（%v）", what, e.Code, e)
	}
	if got, _ := e.Details["reason"].(string); got != "foreign_transaction" {
		t.Fatalf("%s：details.reason = %q，want foreign_transaction", what, got)
	}
	if e.Status() != http.StatusForbidden {
		t.Fatalf("%s：HTTP = %d，want 403（DB_DENIED）", what, e.Status())
	}
}

func TestAppDBConn_ForeignWriteIsRejectedWhileAnotherRequestHoldsTransaction(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("txguard")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})
	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("建表应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	handle := e.srv.appdbs.lookup(appID)
	if handle == nil {
		t.Fatal("首请求后池里应有该应用的句柄")
	}

	ctx := context.Background()
	// 两个"请求"：serveWasm 每请求构造一份 appDBConn，这里如实复制这个形态。
	a := &appDBConn{DB: handle.db, handle: handle}
	b := &appDBConn{DB: handle.db, handle: handle}

	tx, err := a.Begin(ctx)
	if err != nil {
		t.Fatalf("A 开事务失败：%v", err)
	}
	if tx.TxID == 0 {
		t.Fatal("tx_begin 应返回非零 tx_id")
	}
	if _, err := a.Exec(ctx, abi.SQLParams{
		SQL:  "INSERT INTO t (id, v) VALUES (?, ?)",
		Args: []any{9001, "from-A"},
	}); err != nil {
		t.Fatalf("A 在事务里写失败：%v", err)
	}
	// A 自己读得到自己未提交的写（事务语义不变）。
	if res, err := a.Query(ctx, abi.SQLParams{SQL: "SELECT id, v FROM t"}); err != nil {
		t.Fatalf("A 在事务里读失败：%v", err)
	} else if len(res.Rows) == 0 {
		t.Fatal("事务持有者应能看到自己未提交的写")
	}

	// ① 外来写必须被拒（核心判据）。
	_, werr := b.Exec(ctx, abi.SQLParams{
		SQL:  "INSERT INTO t (id, v) VALUES (?, ?)",
		Args: []any{7, "from-B"},
	})
	assertDBDenied(t, werr, "事务期间的另一请求 db.exec")
	// ② 外来 DDL 同样被拒（define 也走写路径）。
	_, derr := b.Define(ctx, abi.DBDefineParams{Table: "t2", Columns: []abi.ColumnDef{{Name: "id", Type: "int"}}})
	assertDBDenied(t, derr, "事务期间的另一请求 db.define")
	// ③ 外来读也被拒：不能让别的请求把未提交数据当已提交读走。
	_, qerr := b.Query(ctx, abi.SQLParams{SQL: "SELECT id, v FROM t"})
	assertDBDenied(t, qerr, "事务期间的另一请求 db.query")
	// ④ 外来 begin 也被拒（appdb 的"同时最多一个事务"在包装层同样成立）。
	if _, berr := b.Begin(ctx); berr == nil {
		t.Fatal("事务期间另一个请求不该能再开一个事务")
	} else {
		assertDBDenied(t, berr, "事务期间的另一请求 tx_begin")
	}

	// ⑤ A 回滚 ⇒ B 立即恢复（不依赖任何超时/看门狗）。
	if err := a.Rollback(ctx, abi.TxParams{TxID: tx.TxID}); err != nil {
		t.Fatalf("A 回滚失败：%v", err)
	}
	if _, err := b.Exec(ctx, abi.SQLParams{
		SQL:  "INSERT INTO t (id, v) VALUES (?, ?)",
		Args: []any{7, "from-B"},
	}); err != nil {
		t.Fatalf("事务结束后 B 应能写：%v", err)
	}
	// 数据判据：A 的行被回滚掉、B 的行在 —— 这正是"没有静默丢写"的形态。
	res, err := b.Query(ctx, abi.SQLParams{SQL: "SELECT id, v FROM t ORDER BY id"})
	if err != nil {
		t.Fatalf("B 查询失败：%v", err)
	}
	if len(res.Rows) != 1 {
		t.Fatalf("表里应只剩 B 的 1 行（A 的写被回滚），得到 %d 行：%v", len(res.Rows), res.Rows)
	}
	if got := res.Rows[0][1]; got != "from-B" {
		t.Fatalf("留下的一行应是 from-B，得到 %v", got)
	}
}

// TestAppDBConn_ForeignTxFinishIsRejected 闭合**事务出口**这一类越权（独立验证 F1）。
//
// 缺陷形态（加闸前稳定复现）：A 开着事务并写了未提交的行，B（同应用另一个请求）
// 调 `tx_commit`，`tx_id` **省略或传 0** ⇒ appdb 的串号校验被跳过 ⇒ A 的未提交数据
// 被 B 提交、对全应用可见；调 `tx_rollback` 则 A 的写被第三方丢弃。
//
// 判据（每个形态都独立取一档 subtest，变异时能看到各自变红）：
//   - B 的 commit / rollback 在三种 tx_id 形态（省略 / 0 / A 的真 id）下全部
//     `DB_DENIED` / `reason=foreign_transaction`；
//   - A 的事务**仍然活着**：`InTx()` 仍为真、持有者标记没被改写、A 自己还看得见
//     自己的未提交写；
//   - 最后由 A 自己收尾：commit 档里写落库、rollback 档里写消失（都是 A 的行为，
//     不是第三方的）。
//
// 变异验证：把 Commit/Rollback 的 lockTxGate 去掉（回到直接透传）⇒ 本用例必红
// （B 的第一次出口调用就会成功提交/回滚 A 的事务）。
func TestAppDBConn_ForeignTxFinishIsRejected(t *testing.T) {
	for _, tc := range []struct {
		name string
		// commit=true 走 Commit，false 走 Rollback（包装层两种出口都要覆盖）。
		commit bool
		// wantRows 是 A 自己收尾后表里应有的行数（commit ⇒ 1，rollback ⇒ 0）。
		wantRows int
	}{
		{name: "commit", commit: true, wantRows: 1},
		{name: "rollback", commit: false, wantRows: 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newEnv(t)
			appID := e.appID("txexit")
			e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})
			if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
				t.Fatalf("建表应 200，得到 %d body=%s", rec.Code, rec.Body.String())
			}
			handle := e.srv.appdbs.lookup(appID)
			if handle == nil {
				t.Fatal("首请求后池里应有该应用的句柄")
			}

			ctx := context.Background()
			a := &appDBConn{DB: handle.db, handle: handle}
			b := &appDBConn{DB: handle.db, handle: handle}
			// 一次"事务出口"调用（tx_commit / tx_rollback）。
			finish := func(c *appDBConn, p abi.TxParams) error {
				if tc.commit {
					return c.Commit(ctx, p)
				}
				return c.Rollback(ctx, p)
			}

			tx, err := a.Begin(ctx)
			if err != nil {
				t.Fatalf("A 开事务失败：%v", err)
			}
			if _, err := a.Exec(ctx, abi.SQLParams{
				SQL:  "INSERT INTO t (id, v) VALUES (?, ?)",
				Args: []any{9001, "from-A"},
			}); err != nil {
				t.Fatalf("A 在事务里写失败：%v", err)
			}

			// ① 外来出口的三种 tx_id 形态全部必须被拒（tx_id 省略 = 漏洞入口）。
			assertDBDenied(t, finish(b, abi.TxParams{}), "事务期间的另一请求 tx_"+tc.name+"（tx_id 省略）")
			assertDBDenied(t, finish(b, abi.TxParams{TxID: 0}), "事务期间的另一请求 tx_"+tc.name+"（tx_id=0）")
			assertDBDenied(t, finish(b, abi.TxParams{TxID: tx.TxID}), "事务期间的另一请求 tx_"+tc.name+"（tx_id=A 的真 id）")

			// ② A 的事务必须**原封不动地活着**（被拒的出口调用不能有副作用）。
			if !handle.db.InTx() {
				t.Fatal("B 的出口调用被拒后，A 的事务必须仍然存在（不能被提前收掉）")
			}
			if got := handle.txOwner.Load(); got != a {
				t.Fatalf("事务持有者标记不该被外来调用改写：%v", got)
			}
			res, err := a.Query(ctx, abi.SQLParams{SQL: "SELECT id, v FROM t"})
			if err != nil {
				t.Fatalf("A 在事务里读失败：%v", err)
			}
			if len(res.Rows) != 1 || res.Rows[0][1] != "from-A" {
				t.Fatalf("A 自己的未提交写必须还在（也没被第三方提交成可见）：%v", res.Rows)
			}

			// ③ 由 A 自己收尾：写落库 / 写消失，都是持有者的行为。
			if err := finish(a, abi.TxParams{TxID: tx.TxID}); err != nil {
				t.Fatalf("A 自己 %s 失败：%v", tc.name, err)
			}
			if handle.db.InTx() {
				t.Fatal("A 收尾后底层不应仍有事务")
			}
			if handle.txOwner.Load() != nil {
				t.Fatal("A 收尾后持有者标记应被清空（否则后续请求会被无谓拒绝）")
			}
			res, err = b.Query(ctx, abi.SQLParams{SQL: "SELECT id, v FROM t ORDER BY id"})
			if err != nil {
				t.Fatalf("B 查询失败：%v", err)
			}
			if len(res.Rows) != tc.wantRows {
				t.Fatalf("A 自己 %s 后表里应有 %d 行，得到 %d 行：%v", tc.name, tc.wantRows, len(res.Rows), res.Rows)
			}
			if tc.wantRows == 1 && res.Rows[0][1] != "from-A" {
				t.Fatalf("留下的应是 A 提交的那一行，得到 %v", res.Rows[0])
			}
		})
	}
}

// TestServe_ForeignWriteDuringTransactionIsRejected 是上面那条的**端到端**版本：
// 真 wasm 应用（dbapp 的 /slowtx）开事务并持有，另一个真实 HTTP 请求来写 —— 必须拿到
// 403 DB_DENIED，而不是 200（200 意味着写进了别人的事务，对方一回滚就没了）。
//
// 行为判据（不依赖墙钟）：
//   - A 进入事务由平台自省面确认（句柄的 InTx()）；
//   - B 的写/读都是 403 + DB_DENIED/foreign_transaction；
//   - A 回滚后 B 立刻能写，且库里只有 B 的行（A 的写确实被回滚，没有"B 的写被带走"）。
func TestServe_ForeignWriteDuringTransactionIsRejected(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("txe2e")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})
	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("建表应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	handle := e.srv.appdbs.lookup(appID)
	if handle == nil {
		t.Fatal("首请求后池里应有该应用的句柄")
	}

	// A：开事务 → 写一行 → 持有 1.2 s → 回滚（远小于 appdb 的 5 s 事务硬超时）。
	//
	// ⚠️ B 必须注入**另一个员工**：队列的"单用户同应用同时运行数 = 1"（§4.6）会把同一
	// 员工的 B 排队到 A 结束之后 —— 那样 B 永远见不到 A 的事务，本用例会退化成"顺序
	// 请求"（2026-09-19 W4 身份一律注入后实测：B 拿到的 body 是 null/空）。
	// 本用例要验证的是**句柄层**的事务所有权守卫，与"谁发起的请求"无关。
	bob := e.clientUser("bob-txe2e")
	aDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { aDone <- e.get(appID, "/slowtx?ms=1200&v=from-A") }()
	waitFor(t, func() bool { return handle.db.InTx() }, "A 进入事务（平台自省面可见）")

	// B：写 → 必须被拒。
	//
	// 判据看**应用看到的错误码**而不是 HTTP 状态：dbapp 夹具把宿主调用的错误回显进
	// 200 响应体（它刻意演示"应用自己决定怎么处理宿主错误"）；平台侧的码是 DB_DENIED，
	// 一个正常应用会把它映射成 403（apperr.StatusOf(DB_DENIED) = 403）。
	rec := e.doClient(appID, bob, http.MethodGet,
		"/exec?sql="+urlQueryEscape("INSERT INTO t (id, v) VALUES (7, 'from-B')"), "", "")
	b := decodeJSON(t, rec.Body)
	if got, _ := b["code"].(string); got != "DB_DENIED" {
		t.Fatalf("A 持有事务期间，B 的 db.exec 必须拿到 DB_DENIED（否则写会落进别人的事务），"+
			"得到 code=%q body=%s", got, rec.Body.String())
	}
	if got, _ := b["message"].(string); !strings.Contains(got, "事务") {
		t.Fatalf("拒绝文案应说明「另一个请求正在事务中」，得到 %q", got)
	}
	// B：读 → 同样被拒（不把未提交数据当已提交返回）。
	rec = e.doClient(appID, bob, http.MethodGet, "/q?sql="+urlQueryEscape("SELECT id, v FROM t"), "", "")
	b = decodeJSON(t, rec.Body)
	if got, _ := b["code"].(string); got != "DB_DENIED" {
		t.Fatalf("A 持有事务期间，B 的 db.query 必须拿到 DB_DENIED，得到 code=%q body=%s",
			got, rec.Body.String())
	}

	// A 正常结束（回滚）。
	aRec := <-aDone
	if aRec.Code != http.StatusOK {
		t.Fatalf("A 的慢事务请求应 200，得到 %d body=%s", aRec.Code, aRec.Body.String())
	}
	body := decodeJSON(t, aRec.Body)
	if got, _ := body["write_code"].(string); got != "" {
		t.Fatalf("A 在事务里的写应成功（write_code 空），得到 %q", got)
	}
	if got, _ := body["finish_code"].(string); got != "" {
		t.Fatalf("A 的回滚应成功（finish_code 空），得到 %q", got)
	}

	// B 现在能写（事务结束 ⇒ 立刻恢复，不等任何超时）。
	rec = e.get(appID, "/exec?sql="+urlQueryEscape("INSERT INTO t (id, v) VALUES (7, 'from-B')"))
	if rec.Code != http.StatusOK {
		t.Fatalf("事务结束后 B 的写应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	// 数据判据：只有 B 的行（A 的写随回滚消失，且没有把 B 的写一起带走）。
	q := e.get(appID, "/q?sql="+urlQueryEscape("SELECT id, v FROM t ORDER BY id"))
	if q.Code != http.StatusOK {
		t.Fatalf("查询应 200，得到 %d body=%s", q.Code, q.Body.String())
	}
	qb := decodeJSON(t, q.Body)
	if n, _ := qb["row_count"].(float64); int(n) != 1 {
		t.Fatalf("库里应只有 B 的 1 行（A 的行被回滚），得到 %v 行：%v", n, qb)
	}
	first, _ := qb["first_row"].([]any)
	if len(first) != 2 || first[1] != "from-B" {
		t.Fatalf("留下的行应是 from-B，得到 %v", first)
	}
}

// TestServe_ForeignTxFinishDuringTransactionIsRejected 是事务**出口**越权的端到端版本
// （独立验证 F1）：真 wasm 应用 A 开着事务并写了一行，另一个真实 HTTP 请求 B 只调
// `tx_commit` / `tx_rollback`（夹具路由 `/txfin`，**不** begin）—— 必须拿到 DB_DENIED，
// 而不是"提交/回滚成功"（成功 = B 把 A 的事务收掉了：未提交数据被第三方变可见，
// 或 A 的写被第三方丢弃）。
//
// 判据（不依赖墙钟）：
//   - A 进入事务由平台自省面确认（句柄的 InTx()）；
//   - B 的两种出口调用（tx_id 省略 = 加闸前的越权入口）都拿到 DB_DENIED/foreign_transaction；
//   - 每次被拒之后 A 的事务**仍然活着**（InTx 仍为真）；
//   - A 自己的收尾仍然成功（finish_code 空）⇒ 事务没有被第三方提前结束；
//   - 数据判据：A 回滚后表里没有 from-A 的行（写是被 A 回滚的，不是被 B 提交的）。
func TestServe_ForeignTxFinishDuringTransactionIsRejected(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("txfine2e")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})
	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("建表应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	handle := e.srv.appdbs.lookup(appID)
	if handle == nil {
		t.Fatal("首请求后池里应有该应用的句柄")
	}

	// A：开事务 → 写一行 → 持有 1.2 s → 回滚（远小于 appdb 的 5 s 事务硬超时）。
	// B 用另一个员工（理由同 TestServe_ForeignWriteDuringTransactionIsRejected：
	// 单用户同应用并发为 1，同一员工会被队列串行化）。
	bob := e.clientUser("bob-txfin")
	aDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { aDone <- e.get(appID, "/slowtx?ms=1200&v=from-A") }()
	waitFor(t, func() bool { return handle.db.InTx() }, "A 进入事务（平台自省面可见）")

	// B：只调事务出口，且**不带 tx_id**（tx_id 是可选字段 ⇒ appdb 侧跳过串号校验）。
	for _, op := range []string{"commit", "rollback"} {
		rec := e.doClient(appID, bob, http.MethodGet, "/txfin?op="+op, "", "")
		// 先取原始 body 再解析：decodeJSON 会把 body 读空，之后 String() 拿不到内容。
		raw := rec.Body.String()
		b := decodeJSONBytes(t, []byte(raw))
		if got, _ := b["code"].(string); got != "DB_DENIED" {
			t.Fatalf("A 持有事务期间，B 的 tx_%s 必须拿到 DB_DENIED（否则 A 的事务被第三方收掉），"+
				"得到 HTTP %d code=%q body=%s", op, rec.Code, got, raw)
		}
		if got, _ := b["message"].(string); !strings.Contains(got, "事务") {
			t.Fatalf("拒绝文案应说明「另一个请求正在事务中」，得到 %q", got)
		}
		if !handle.db.InTx() {
			t.Fatalf("B 的 tx_%s 被拒后，A 的事务必须仍然存在（被拒调用不能有副作用）", op)
		}
	}

	// A 正常结束（回滚）—— 事务没被 B 提前收掉，所以 A 自己的出口仍然成功。
	aRec := <-aDone
	if aRec.Code != http.StatusOK {
		t.Fatalf("A 的慢事务请求应 200，得到 %d body=%s", aRec.Code, aRec.Body.String())
	}
	body := decodeJSON(t, aRec.Body)
	if got, _ := body["finish_code"].(string); got != "" {
		t.Fatalf("A 自己的回滚应成功（finish_code 空）；非空说明事务已被 B 收掉，得到 %q（%v）",
			got, body["finish_message"])
	}
	if handle.db.InTx() {
		t.Fatal("A 回滚后底层不应仍有事务")
	}

	// 数据判据：表里没有 from-A（A 的写随 A 的回滚消失，而不是被 B 提交成可见）。
	q := e.get(appID, "/q?sql="+urlQueryEscape("SELECT id, v FROM t ORDER BY id"))
	if q.Code != http.StatusOK {
		t.Fatalf("查询应 200，得到 %d body=%s", q.Code, q.Body.String())
	}
	qb := decodeJSON(t, q.Body)
	if n, _ := qb["row_count"].(float64); int(n) != 0 {
		t.Fatalf("A 回滚后库里不应有行（有行 ⇒ 未提交数据被第三方提交了），得到 %v 行：%v", n, qb)
	}
}

// ===== 连接污染：句柄必须回收重建（appdb 侧已可按语句/按会话恢复，池侧仍保守回收）=====
func TestAppDBPool_PoisonedHandleIsRecycled(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("dbpoison")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	if rec := e.get(appID, "/define?table=t"); rec.Code != http.StatusOK {
		t.Fatalf("建表应 200，得到 %d", rec.Code)
	}
	if rec := e.get(appID, "/seed?n=20"); rec.Code != http.StatusOK {
		t.Fatalf("灌数据应 200，得到 %d body=%s", rec.Code, rec.Body.String())
	}
	healthy := e.srv.appdbs.lookup(appID)
	if healthy == nil {
		t.Fatal("应有句柄")
	}

	// 笛卡尔积自杀查询：20^7 = 12.8 亿行，远超单语句 5 s 硬预算（limits.SQLStatementBudget）。
	//
	// ⚠️ 观察到的行为（跨模块事实，已写进交付说明）：`db.query` 的**宿主调用预算**
	// 也是 5 s（limits.HostCallBudgetDefault），而它比语句预算早几微秒开始计时 ⇒
	// 外层先到点，请求以 HOST_CALL_OVER_BUDGET(504) 被运行时收掉，应用拿不到
	// appdb 的 DB_DENIED(statement_timeout)（"合法但很慢的查询"因此无法在应用侧优雅降级）。
	// 本用例因此断言"请求被杀 + 句柄被回收 + 下一个请求正常"，而不是断言 DB_DENIED。
	heavy := "SELECT count(*) FROM t a, t b, t c, t d, t e, t f, t g"
	rec := e.get(appID, "/api/q?sql="+urlQueryEscape(heavy))
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("慢查询应被预算收掉（504），得到 %d body=%s", rec.Code, rec.Body.String())
	}
	code := errorCodeOf(t, rec.Body)
	if code != "HOST_CALL_OVER_BUDGET" && code != "RUNTIME_TIMEOUT" {
		t.Fatalf("应为宿主调用超预算或 guest 超时，得到 %q", code)
	}

	// 关键断言：句柄已被回收（请求被杀时 appdb 来不及返回错误，池侧按"可能被放弃语句"
	// 主动标脏；这也是 §11「每应用最多 1 个僵尸查询 ⇒ 有界」的落地点）。
	if e.srv.appdbs.lookup(appID) != nil {
		t.Fatal("语句被放弃的请求结束后必须回收句柄（dirty ⇒ release 时关闭并从池中移除）")
	}
	_ = healthy
	// 而且下一个请求必须成功 —— 这是"一次慢查询不会永久打死应用"的判据。
	rec2 := e.get(appID, "/q?sql="+urlQueryEscape("SELECT count(*) FROM t"))
	if rec2.Code != http.StatusOK {
		t.Fatalf("回收后应能重开并成功，得到 %d body=%s", rec2.Code, rec2.Body.String())
	}
	body2 := decodeJSON(t, rec2.Body)
	if body2["ok"] != true {
		t.Fatalf("污染回收后的查询必须成功，得到 %v", body2)
	}
	if got, _ := body2["row_count"].(float64); int(got) != 1 {
		t.Fatalf("COUNT(*) 应返回 1 行，得到 %v", body2["row_count"])
	}
}

// ===== 应用日志（logbuf → 平台日志出口）=====

func TestServe_AppLogsGoToPlatformLog(t *testing.T) {
	e := newEnv(t)
	appID := e.appID("dblog")
	e.publishApp(appSpec{appID: appID, wasm: appBinary(t, "dbapp")})

	rec := e.get(appID, "/log?msg="+urlQueryEscape("hello-from-app")+"&level=warn")
	if rec.Code != http.StatusOK {
		t.Fatalf("应 200，得到 %d", rec.Code)
	}
	body := decodeJSON(t, rec.Body)
	if body["ok"] != true {
		t.Fatalf("log 调用应成功: %v", body)
	}
	logs := e.logs.String()
	if !strings.Contains(logs, "hello-from-app") {
		t.Fatalf("应用日志必须出现在平台日志出口（带 app 前缀），日志=%q", logs)
	}
	if !strings.Contains(logs, "wasm-app["+appID+"] warn:") {
		t.Fatalf("应用日志应带 app 前缀与级别，日志=%q", logs)
	}
}

// urlQueryEscape 是 url.QueryEscape 的薄封装（让测试里的 SQL 参数写法短一点）。
func urlQueryEscape(s string) string { return url.QueryEscape(s) }

// ===== 污染探测与"可能被放弃语句"判定 =====
//
// 判据必须来自 appdb 的**真错误**（不是构造串）：审计 P0-2 的根因就是"两端各写一个
// 字符串"（生产者 transaction_timeout、消费者只认 tx_timeout，后者全仓无生产者），
// 而 dbpool 自己的单测当年正是用构造串把这条死分支钉成了"预期"。

// TestAppDBConn_PoisonMarkersFromRealErrors 用**真跑出来的** appdb 错误驱动 notePoison：
//   - 单语句超时（真驱动路径：ctx 已取消 ⇒ mapStmtErrorLocked 产出 statement_timeout）；
//   - 事务硬超时（真等 5 s 看门狗：Commit 回放 transaction_timeout）；
//   - 语法错误（真 SQLite 错误，不应标脏）。
func TestAppDBConn_PoisonMarkersFromRealErrors(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := appdb.Open(ctx, appdb.Options{DataRoot: root, AppID: "poison-real"})
	if err != nil {
		t.Fatalf("appdb.Open 失败：%v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, derr := db.Define(ctx, abi.DBDefineParams{Table: "items", Columns: []abi.ColumnDef{{Name: "v", Type: "text"}}}); derr != nil {
		t.Fatalf("define 失败：%v", derr)
	}
	h := &appDBHandle{appID: "poison-real", db: db}
	conn := &appDBConn{DB: db, handle: h}

	// (1) 真·语法错误 ⇒ 不脏（连接仍可用）。
	if _, qerr := conn.Query(ctx, abi.SQLParams{SQL: "SELECT FROM WHERE"}); qerr == nil {
		t.Fatal("语法错误应报错")
	}
	if h.dirty.Load() {
		t.Fatal("语法错误不该把句柄标脏（连接仍可用）")
	}

	// (2) 真·单语句超时：用一个**已经到期**的 ctx 走真实映射路径，
	// 拿到的是 appdb 生产的 statement_timeout（不是构造串）。
	dead, cancel := context.WithCancel(ctx)
	cancel()
	if _, qerr := conn.Query(dead, abi.SQLParams{SQL: "SELECT 1"}); qerr == nil {
		t.Fatal("已取消的 ctx 应报错")
	} else if e, ok := apperr.As(qerr); !ok {
		t.Fatalf("应是 apperr，实际 %T", qerr)
	} else if reason, _ := e.Details["reason"].(string); reason != appdb.ReasonStatementTimeout {
		t.Fatalf("真·语句超时的 reason 应为 %q（appdb 导出常量），实际 %q", appdb.ReasonStatementTimeout, reason)
	}
	if !h.dirty.Load() {
		t.Fatal("真·单语句超时后句柄必须被标脏（dirty ⇒ release 时回收重建）")
	}

	// (3) 真·事务硬超时：Begin 之后真等 5 s 看门狗，再 Commit —— 拿到的
	// transaction_timeout 必须被消费者认出来（老实现只认不存在的 tx_timeout）。
	h.dirty.Store(false)
	if _, berr := conn.Begin(ctx); berr != nil {
		t.Fatalf("Begin 失败：%v", berr)
	}
	time.Sleep(limits.SQLStatementBudget + 300*time.Millisecond)
	cerr := conn.Commit(ctx, abi.TxParams{})
	if cerr == nil {
		t.Fatal("硬超时后的 Commit 必须报错")
	}
	e, ok := apperr.As(cerr)
	if !ok {
		t.Fatalf("应是 apperr，实际 %T", cerr)
	}
	if reason, _ := e.Details["reason"].(string); reason != appdb.ReasonTransactionTimeout {
		t.Fatalf("真·事务超时的 reason 应为 %q（appdb 导出常量），实际 %q", appdb.ReasonTransactionTimeout, reason)
	}
	if !h.dirty.Load() {
		t.Fatal("真·事务超时后句柄必须被标脏 —— 老实现正是这里漏掉，导致一次超时永久打死应用")
	}
}

// TestPoisonReasonsAreSharedConstants 钉住"生产者与消费者共用同一个值"这条结构性保证：
// dbpool 的匹配分支直接引用 appdb 的导出常量（编译期绑定），本用例再显式断言
// 这两个常量就是 appdb 生产侧写进 details 的那两个值。
//
// 变异方式：把 dbpool 的 switch 改回字面量 "tx_timeout" ⇒ 本用例与
// TestAppDBConn_PoisonMarkersFromRealErrors 一起变红。
func TestPoisonReasonsAreSharedConstants(t *testing.T) {
	if appdb.ReasonStatementTimeout != "statement_timeout" {
		t.Fatalf("ReasonStatementTimeout 的值变了：%q（需同步审计/文档口径）", appdb.ReasonStatementTimeout)
	}
	if appdb.ReasonTransactionTimeout != "transaction_timeout" {
		t.Fatalf("ReasonTransactionTimeout 的值变了：%q（老消费者写的是不存在的 tx_timeout）", appdb.ReasonTransactionTimeout)
	}
	if appdb.ReasonTransactionTimeout == "tx_timeout" {
		t.Fatal("transaction_timeout 与 tx_timeout 是两个值：生产者一直写前者")
	}
}

// TestAppDBPool_TxTimeoutIsRecycledByThePool 是 P0-2 的池级回归（真跑一次事务超时）：
// 一次硬超时之后，句柄必须被识别为脏 → release 时回收 → 下一次请求恢复正常。
//
// 变异方式：把 appDBConn.notePoison 的常量匹配改回只认 "tx_timeout"
// ⇒ 句柄不会被回收，第二次 acquire 拿到的仍是污染句柄，本用例红。
func TestAppDBPool_TxTimeoutIsRecycledByThePool(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	p := newAppDBPool(nil)

	h, aerr := p.acquire(ctx, root, "txtimeout-app")
	if aerr != nil {
		t.Fatalf("acquire: %v", aerr)
	}
	conn := &appDBConn{DB: h.db, handle: h}
	if _, err := conn.Define(ctx, abi.DBDefineParams{Table: "items", Columns: []abi.ColumnDef{{Name: "v", Type: "text"}}}); err != nil {
		t.Fatalf("define: %v", err)
	}
	if _, err := conn.Begin(ctx); err != nil {
		t.Fatalf("begin: %v", err)
	}
	time.Sleep(limits.SQLStatementBudget + 300*time.Millisecond) // 真等看门狗强制回滚

	// 超时后的第一次调用：如实返回 transaction_timeout，并被消费者标脏。
	if err := conn.Commit(ctx, abi.TxParams{}); err == nil {
		t.Fatal("硬超时后的 Commit 必须报错")
	} else if e, ok := apperr.As(err); !ok {
		t.Fatalf("应是 apperr，实际 %T", err)
	} else if reason, _ := e.Details["reason"].(string); reason != appdb.ReasonTransactionTimeout {
		t.Fatalf("reason 应为 %q，实际 %q", appdb.ReasonTransactionTimeout, reason)
	}
	if !h.dirty.Load() {
		t.Fatal("事务超时后句柄必须被标脏")
	}
	p.release(h, h.dirty.Load())

	h2, aerr2 := p.acquire(ctx, root, "txtimeout-app")
	if aerr2 != nil {
		t.Fatalf("re-acquire: %v", aerr2)
	}
	defer p.release(h2, h2.dirty.Load())
	if h2 == h {
		t.Fatal("被污染的句柄必须已被回收重建（否则一次超时永久打死该应用）")
	}
	if _, err := (&appDBConn{DB: h2.db, handle: h2}).Query(ctx, abi.SQLParams{SQL: "SELECT 1"}); err != nil {
		t.Fatalf("回收重建后应用必须恢复：%v", err)
	}
}

func TestAbandonedStatementPossible(t *testing.T) {
	for _, code := range []apperr.Code{
		apperr.CodeRuntimeTimeout, apperr.CodeModuleKilled, apperr.CodeHostCallOverBudget,
	} {
		if !abandonedStatementPossible(code) {
			t.Fatalf("%s 应判为可能放弃语句", code)
		}
	}
	for _, code := range []apperr.Code{
		apperr.CodeRuntimeNoResponse, apperr.CodeRuntimeTrap, apperr.CodeRuntimeOutputOverrun,
		apperr.CodeDBDenied,
	} {
		if abandonedStatementPossible(code) {
			t.Fatalf("%s 不应触发句柄回收", code)
		}
	}
}
