package appserver

import (
	"context"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/appdb"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
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
