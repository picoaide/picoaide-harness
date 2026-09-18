// 变异验证方式（CONTEXT §4.3；每条用例都是"闸门去掉即变红"）：
//   - 删掉 Dispatch 里的 `c.User == nil` 检查 → TestAnonymousIdentityGate 红；
//   - 把 db.query/db.exec 从 abi.TxAllowedWhileInTx 的允许集里去掉（缺陷原状）
//     → TestTxAllowsDBReadWriteInsideTransaction 红；
//   - 删掉事务闸门（或把 ping 分支挪回闸门之前）→ TestTxBlocksNonDBHostCalls 红；
//   - 把 abi.AssetsReadResult.Encoding 恒置空（或只填两个分支）
//     → TestAssetsReadEncodingDiscriminatesOnWire 红；
//   - 删掉"调用返回后强制复检 ctx" → TestCancelledAfterCallIsModuleKilled 红；
//   - 把 log 的每请求上限检查删掉 → TestLogPerRequestCap 红；
//   - 把 log 的 4 KiB 截断删掉（改成拒绝或原样写入）→ TestLogTruncatesLongLines 红；
//   - 把 decodeParams 的 DisallowUnknownFields 去掉 → TestParamStrictness 红；
//   - 删掉 recover 边界 → TestPanicBecomesInternalError 红（测试进程会崩）。
package hostcap

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// ===== 假能力实现 =====

type fakeDB struct {
	inTx      bool
	defined   []abi.DBDefineParams
	queries   []abi.SQLParams
	execs     []abi.SQLParams
	begins    int
	commits   int
	rollbacks int
	err       error
	onQuery   func(ctx context.Context) error
}

func (d *fakeDB) Define(_ context.Context, p abi.DBDefineParams) (abi.DBDefineResult, error) {
	d.defined = append(d.defined, p)
	if d.err != nil {
		return abi.DBDefineResult{}, d.err
	}
	return abi.DBDefineResult{Created: true, Table: p.Table}, nil
}

func (d *fakeDB) Query(ctx context.Context, p abi.SQLParams) (abi.QueryResult, error) {
	d.queries = append(d.queries, p)
	if d.onQuery != nil {
		if err := d.onQuery(ctx); err != nil {
			return abi.QueryResult{}, err
		}
	}
	if d.err != nil {
		return abi.QueryResult{}, d.err
	}
	return abi.QueryResult{Columns: []string{"a"}, Rows: [][]any{{1}}}, nil
}

func (d *fakeDB) Exec(_ context.Context, p abi.SQLParams) (abi.ExecResult, error) {
	d.execs = append(d.execs, p)
	if d.err != nil {
		return abi.ExecResult{}, d.err
	}
	return abi.ExecResult{RowsAffected: 1}, nil
}

func (d *fakeDB) Begin(context.Context) (abi.TxResult, error) {
	d.begins++
	d.inTx = true
	return abi.TxResult{TxID: 1}, nil
}

func (d *fakeDB) Commit(context.Context, abi.TxParams) error {
	d.commits++
	d.inTx = false
	return nil
}

func (d *fakeDB) Rollback(context.Context, abi.TxParams) error {
	d.rollbacks++
	d.inTx = false
	return nil
}

func (d *fakeDB) InTx() bool            { return d.inTx }
func (d *fakeDB) Close() error          { return nil }
func (d *fakeDB) Stats() capapi.DBStats { return capapi.DBStats{} }

type fakeAI struct {
	calls  int
	user   *abi.User
	params abi.AIChatParams
	panic  bool
	err    error
}

func (a *fakeAI) Chat(_ context.Context, u *abi.User, p abi.AIChatParams) (abi.AIChatResult, error) {
	a.calls++
	a.user = u
	a.params = p
	if a.panic {
		panic("db password=hunter2 leaked in panic value")
	}
	if a.err != nil {
		return abi.AIChatResult{}, a.err
	}
	return abi.AIChatResult{Content: "ok", Model: "m"}, nil
}

type fakeAssets struct {
	types map[string]string
	files map[string][]byte
	err   error
	path  string
}

func (a *fakeAssets) Read(p string) (string, []byte, error) {
	a.path = p
	if a.err != nil {
		return "", nil, a.err
	}
	data, ok := a.files[p]
	if !ok {
		return "", nil, apperr.New(apperr.CodeNotFound, "资源不存在")
	}
	return a.types[p], data, nil
}

func (a *fakeAssets) List() []string { return nil }

type fakeSink struct {
	mu      sync.Mutex
	levels  []string
	lines   []string
	dropped int
}

func (s *fakeSink) Log(level, message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.levels = append(s.levels, level)
	s.lines = append(s.lines, message)
}

func (s *fakeSink) Dropped() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.dropped
}

func (s *fakeSink) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.lines)
}

func (s *fakeSink) last() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.lines) == 0 {
		return ""
	}
	return s.lines[len(s.lines)-1]
}

func loggedIn() *abi.User {
	return &abi.User{ID: 7, Username: "zhangwei", DisplayName: "张伟", Dept: "研发部"}
}

func params(t *testing.T, v any) json.RawMessage {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func mustDispatch(t *testing.T, c *Capabilities, method string, p json.RawMessage) any {
	t.Helper()
	out, e := c.Dispatch(context.Background(), method, p)
	if e != nil {
		t.Fatalf("Dispatch(%s) = %v", method, e)
	}
	return out
}

func dispatchErr(t *testing.T, c *Capabilities, method string, p json.RawMessage) *apperr.Error {
	t.Helper()
	out, e := c.Dispatch(context.Background(), method, p)
	if e == nil {
		t.Fatalf("Dispatch(%s) = %#v, want error", method, out)
	}
	return e
}

// ===== 身份闸门 =====

func TestAnonymousIdentityGate(t *testing.T) {
	ai := &fakeAI{}
	c := &Capabilities{AI: ai, Assets: sampleAssets(), DB: &fakeDB{}, Logs: &fakeSink{}}
	// 匿名 + ai.chat ⇒ AUTH_REQUIRED，且**不得**触达 AI 实现。
	e := dispatchErr(t, c, abi.MethodAIChat, params(t, abi.AIChatParams{
		Messages: []abi.ChatMessage{{Role: "user", Content: "hi"}},
	}))
	if e.Code != apperr.CodeAuthRequired || e.Status() != 401 {
		t.Fatalf("code/status = %s/%d, want AUTH_REQUIRED/401", e.Code, e.Status())
	}
	if ai.calls != 0 {
		t.Fatal("匿名调用不得触达 AI 实现")
	}
	// 匿名可用的能力：log / assets.read / db.*（R15：应用内数据全员共享）。
	if _, e := c.Dispatch(context.Background(), abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "hi"})); e != nil {
		t.Fatalf("匿名 log 应当可用: %v", e)
	}
	if _, e := c.Dispatch(context.Background(), abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "index.html"})); e != nil {
		t.Fatalf("匿名 assets.read 应当可用: %v", e)
	}
	if _, e := c.Dispatch(context.Background(), abi.MethodDBQuery, params(t, abi.SQLParams{SQL: "SELECT 1"})); e != nil {
		t.Fatalf("匿名 db.query 应当可用: %v", e)
	}
	// 身份注入：登录后调 ai.chat，用的是帧内身份（不是应用自报的）。
	c.User = loggedIn()
	mustDispatch(t, c, abi.MethodAIChat, params(t, abi.AIChatParams{
		Messages: []abi.ChatMessage{{Role: "user", Content: "hi"}},
	}))
	if ai.calls != 1 || ai.user == nil || ai.user.ID != 7 {
		t.Fatalf("AI 收到的身份 = %+v, want 帧内身份(id=7)", ai.user)
	}
}

// sampleAssets 是一个"有一个可读文本资源"的假资源目录。
func sampleAssets() *fakeAssets {
	return &fakeAssets{
		types: map[string]string{"index.html": "text/html", "a.txt": "text/plain"},
		files: map[string][]byte{"index.html": []byte("<h1>hi</h1>"), "a.txt": []byte("x")},
	}
}

// ===== 事务隔离（§4.4：事务内只允许数据库读写）=====

// TestTxAllowsDBReadWriteInsideTransaction 是 FIX-1 的**正向**判据（模块 H 审计 P0）：
// 事务内 db.exec + db.query 必须**成功**，且真的抵达能力实现。
//
// 缺陷原状：允许集只有 tx_commit/tx_rollback ⇒ 事务内一切 SQL 被 host_call_in_tx 拒，
// db.tx 退化成"begin 完立刻 commit"，§5.1 的 db.tx 原语等于不存在。
// 变异验证：把 db.query/db.exec 从 abi.TxAllowedWhileInTx 的允许集里去掉 ⇒ 本用例红。
func TestTxAllowsDBReadWriteInsideTransaction(t *testing.T) {
	db := &fakeDB{inTx: true}
	sink := &fakeSink{}
	c := &Capabilities{
		User:   loggedIn(),
		DB:     db,
		AI:     &fakeAI{},
		Assets: sampleAssets(),
		Logs:   sink,
	}
	mustDispatch(t, c, abi.MethodDBExec, params(t, abi.SQLParams{
		SQL: "INSERT INTO notes (title) VALUES (?)", Args: []any{"第一条"},
	}))
	mustDispatch(t, c, abi.MethodDBQuery, params(t, abi.SQLParams{
		SQL: "SELECT title FROM notes", Args: []any{},
	}))
	if len(db.execs) != 1 || len(db.queries) != 1 {
		t.Fatalf("事务内的 SQL 没有被交给实现：execs=%d queries=%d", len(db.execs), len(db.queries))
	}
	if db.execs[0].SQL != "INSERT INTO notes (title) VALUES (?)" || len(db.execs[0].Args) != 1 {
		t.Fatalf("事务内 db.exec 的参数被改写: %+v", db.execs[0])
	}
	if db.queries[0].SQL != "SELECT title FROM notes" {
		t.Fatalf("事务内 db.query 的参数被改写: %+v", db.queries[0])
	}
	// 事务出口照常可用，且事务结束之后其它能力恢复。
	out := mustDispatch(t, c, abi.MethodTxCommit, params(t, abi.TxParams{TxID: 1}))
	if res, ok := out.(txDoneResult); !ok || !res.Committed {
		t.Fatalf("tx_commit 结果 = %#v", out)
	}
	if db.commits != 1 || db.InTx() {
		t.Fatalf("tx_commit 未生效: %+v", db)
	}
	mustDispatch(t, c, abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "after tx"}))
	if sink.count() != 1 {
		t.Fatalf("事务结束后 log 应当恢复可用，sink=%d", sink.count())
	}
	// 在事务里回滚同样是合法出口（不需要先有 SQL）。
	db.inTx = true
	mustDispatch(t, c, abi.MethodTxRollback, params(t, abi.TxParams{TxID: 1}))
	if db.rollbacks != 1 || db.InTx() {
		t.Fatalf("tx_rollback 未生效: %+v", db)
	}
}

// TestTxBlocksNonDBHostCalls 是 FIX-1 的**反向**判据：事务内逐类拒绝
// （嵌套事务 / 会阻塞或占槽的能力 / DDL / 协议探针），并逐个断言
// 错误码、reason、kind 与"怎么改"，同时断言底层能力**零触达**。
func TestTxBlocksNonDBHostCalls(t *testing.T) {
	cases := []struct {
		method string
		p      json.RawMessage
		kind   string
		hint   string // hints 里必须出现的关键词（"怎么改"）
	}{
		{abi.MethodTxBegin, nil, "nested_tx", "tx_commit"},
		{abi.MethodAIChat, params(t, abi.AIChatParams{Messages: []abi.ChatMessage{{Role: "user", Content: "x"}}}), "blocking_capability", "tx_commit"},
		{abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "x"}), "blocking_capability", "tx_commit"},
		{abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "a.txt"}), "blocking_capability", "tx_commit"},
		{abi.MethodDBDefine, params(t, abi.DBDefineParams{Table: "t"}), "ddl", "事务外"},
		{abi.MethodPing, nil, "probe_method", "tx_commit"},
	}
	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
			db := &fakeDB{inTx: true}
			ai := &fakeAI{}
			sink := &fakeSink{}
			assets := sampleAssets()
			c := &Capabilities{User: loggedIn(), DB: db, AI: ai, Assets: assets, Logs: sink}

			out, e := c.Dispatch(context.Background(), tc.method, tc.p)
			if e == nil {
				t.Fatalf("事务内 %s 竟然成功: %#v", tc.method, out)
			}
			if e.Code != apperr.CodeDBDenied || e.Status() != 403 {
				t.Fatalf("%s code/status = %s/%d, want DB_DENIED/403", tc.method, e.Code, e.Status())
			}
			if e.Details["reason"] != "host_call_in_tx" {
				t.Fatalf("%s reason = %v, want host_call_in_tx", tc.method, e.Details["reason"])
			}
			if e.Details["kind"] != tc.kind {
				t.Fatalf("%s kind = %v, want %s（必须指明哪一类被禁）", tc.method, e.Details["kind"], tc.kind)
			}
			if e.Details["method"] != tc.method {
				t.Fatalf("%s details.method = %v", tc.method, e.Details["method"])
			}
			if len(e.Hints) == 0 || !strings.Contains(strings.Join(e.Hints, "\n"), tc.hint) {
				t.Fatalf("%s hints 必须给出改法（含 %q）: %v", tc.method, tc.hint, e.Hints)
			}
			// 拒在宿主层：底层能力一次都没被调用。
			if len(db.queries) != 0 || len(db.execs) != 0 || len(db.defined) != 0 || db.begins != 0 || db.commits != 0 {
				t.Fatalf("事务内的 %s 触达了 DB: %+v", tc.method, db)
			}
			if ai.calls != 0 || sink.count() != 0 || assets.path != "" {
				t.Fatalf("事务内的 %s 触达了 ai/log/assets: ai=%d sink=%d path=%q", tc.method, ai.calls, sink.count(), assets.path)
			}
		})
	}
}

// 事务内调用**不存在**的方法必须仍然报 HOST_METHOD_UNKNOWN（§10.6 第 68 项），
// 不能被事务闸门改写成 host_call_in_tx —— 错误码不准等于把 AI 指错方向（§8）。
func TestTxKeepsUnknownMethodSemantics(t *testing.T) {
	c := &Capabilities{DB: &fakeDB{inTx: true}}
	e := dispatchErr(t, c, "db.attach", nil)
	if e.Code != apperr.CodeHostMethodUnknown || e.Details["reason"] != "unknown_method" {
		t.Fatalf("事务内未知方法 = %s/%v, want HOST_METHOD_UNKNOWN/unknown_method", e.Code, e.Details)
	}
	// 事务允许集之外的**协议探针**走的是另一条路：ping 是已知方法，只是事务内不许。
	if abi.TxAllowedWhileInTx(abi.MethodPing) {
		t.Fatal("abi.ping 不得在事务允许集里")
	}
}

// 非事务路径不受影响：没有打开事务时，全部方法照常（放行集只描述"事务内"）。
func TestOutsideTxEverythingIsAllowed(t *testing.T) {
	db := &fakeDB{}
	ai := &fakeAI{}
	sink := &fakeSink{}
	c := &Capabilities{User: loggedIn(), DB: db, AI: ai, Assets: sampleAssets(), Logs: sink}
	for _, m := range abi.HostMethods {
		var p json.RawMessage
		switch m {
		case abi.MethodAIChat:
			p = params(t, abi.AIChatParams{Messages: []abi.ChatMessage{{Role: "user", Content: "x"}}})
		case abi.MethodDBDefine:
			p = params(t, abi.DBDefineParams{Table: "t"})
		case abi.MethodDBQuery, abi.MethodDBExec:
			p = params(t, abi.SQLParams{SQL: "SELECT 1"})
		case abi.MethodLog:
			p = params(t, abi.LogParams{Message: "x"})
		case abi.MethodAssetsRead:
			p = params(t, abi.AssetsReadParams{Path: "a.txt"})
		}
		if _, e := c.Dispatch(context.Background(), m, p); e != nil && e.Details["reason"] == "host_call_in_tx" {
			t.Fatalf("没有事务时 %s 被事务闸门误伤: %v", m, e)
		}
	}
}

// ===== log =====

func TestLogTruncatesLongLines(t *testing.T) {
	sink := &fakeSink{}
	c := &Capabilities{Logs: sink}

	long := strings.Repeat("a", limits.LogMaxLineBytes*2)
	if _, e := c.Dispatch(context.Background(), abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: long})); e != nil {
		t.Fatalf("超长日志应当**截断**而不是拒: %v", e)
	}
	if n := len(sink.last()); n != limits.LogMaxLineBytes {
		t.Fatalf("截断长度 = %d, want %d", n, limits.LogMaxLineBytes)
	}

	// 多字节字符不得被切一半（否则作者看到的是 U+FFFD 乱码）。
	cjk := strings.Repeat("中", limits.LogMaxLineBytes)
	if _, e := c.Dispatch(context.Background(), abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: cjk})); e != nil {
		t.Fatal(e)
	}
	got := sink.last()
	if len(got) > limits.LogMaxLineBytes {
		t.Fatalf("截断后长度 = %d > %d", len(got), limits.LogMaxLineBytes)
	}
	if !utf8.ValidString(got) {
		t.Fatal("截断切断了 UTF-8 字符")
	}
	if strings.ContainsRune(got, '\uFFFD') {
		t.Fatal("截断产生了替换字符")
	}

	// 空 level 回落默认级别（不拒）。
	if _, e := c.Dispatch(context.Background(), abi.MethodLog, params(t, abi.LogParams{Message: "x"})); e != nil {
		t.Fatal(e)
	}
	if got := sink.levels[len(sink.levels)-1]; got != DefaultLogLevel {
		t.Fatalf("level = %q, want %q", got, DefaultLogLevel)
	}
}

func TestLogPerRequestCap(t *testing.T) {
	sink := &fakeSink{}
	c := &Capabilities{Logs: sink}
	msg := params(t, abi.LogParams{Level: "info", Message: "x"})

	for i := 0; i < limits.LogMaxPerRequest; i++ {
		out := mustDispatch(t, c, abi.MethodLog, msg)
		res, ok := out.(abi.LogResult)
		if !ok {
			t.Fatalf("log 结果类型 = %T", out)
		}
		if res.Accepted != 1 || res.Dropped != 0 {
			t.Fatalf("第 %d 条: %+v, want accepted=1 dropped=0", i+1, res)
		}
	}
	if sink.count() != limits.LogMaxPerRequest {
		t.Fatalf("sink 收到 %d 条, want %d", sink.count(), limits.LogMaxPerRequest)
	}
	// 第 101 条：**丢弃并计数**（不报错，否则应用的日志量会变成业务失败）。
	out := mustDispatch(t, c, abi.MethodLog, msg)
	res := out.(abi.LogResult)
	if res.Accepted != 0 || res.Dropped != 1 {
		t.Fatalf("超出上限: %+v, want accepted=0 dropped=1", res)
	}
	if sink.count() != limits.LogMaxPerRequest {
		t.Fatalf("超限日志被写进了 sink: %d", sink.count())
	}
	// 再写几条，Dropped 继续累计（应用能看出自己在丢日志）。
	out = mustDispatch(t, c, abi.MethodLog, msg)
	if res := out.(abi.LogResult); res.Dropped != 2 {
		t.Fatalf("dropped = %d, want 2（累计）", res.Dropped)
	}
}

// 没有日志目的地：调用仍然成功，但计数为 dropped（不假装写成功了）。
func TestLogWithoutSinkCountsDropped(t *testing.T) {
	c := &Capabilities{}
	out := mustDispatch(t, c, abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "x"}))
	res := out.(abi.LogResult)
	if res.Accepted != 1 || res.Dropped != 1 {
		t.Fatalf("%+v, want accepted=1 dropped=1（没地方写的日志必须计入 dropped）", res)
	}
}

// 请求级计数不跨请求：两个 Capabilities 实例互不影响（每请求新建，§5.1）。
func TestLogCountersArePerCapabilities(t *testing.T) {
	sink := &fakeSink{}
	a := &Capabilities{Logs: sink}
	b := &Capabilities{Logs: sink}
	for i := 0; i < limits.LogMaxPerRequest; i++ {
		mustDispatch(t, a, abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "x"}))
	}
	out := mustDispatch(t, b, abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "x"}))
	if res := out.(abi.LogResult); res.Accepted != 1 || res.Dropped != 0 {
		t.Fatalf("另一个请求的日志计数被污染: %+v", res)
	}
}

// ===== assets.read =====

func TestAssetsReadTextAndBase64(t *testing.T) {
	assets := &fakeAssets{
		types: map[string]string{
			"picoaide.app.json": "application/json",
			"index.html":        "text/html",
			"logo.png":          "image/png",
			"broken.txt":        "text/plain",
		},
		files: map[string][]byte{
			"picoaide.app.json": []byte(`{"login_required":false}`),
			"index.html":        []byte("<h1>hi</h1>"),
			"logo.png":          {0x89, 'P', 'N', 'G'},
			"broken.txt":        {0xff, 0xfe}, // 文本类型但不是合法 UTF-8
		},
	}
	c := &Capabilities{Assets: assets}

	out := mustDispatch(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "index.html"}))
	res, ok := out.(abi.AssetsReadResult)
	if !ok {
		t.Fatalf("结果类型 = %T", out)
	}
	if res.ContentType != "text/html" || res.Text != "<h1>hi</h1>" || res.Base64 != "" {
		t.Fatalf("文本资源 = %+v", res)
	}
	if res.Encoding != abi.EncodingText {
		t.Fatalf("文本资源 encoding = %q, want %q", res.Encoding, abi.EncodingText)
	}
	if res.Size != len("<h1>hi</h1>") {
		t.Fatalf("size = %d", res.Size)
	}

	out = mustDispatch(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "logo.png"}))
	res = out.(abi.AssetsReadResult)
	if res.Base64 == "" || res.Text != "" {
		t.Fatalf("二进制资源 = %+v（必须二选一：给 base64）", res)
	}
	if res.Encoding != abi.EncodingBase64 {
		t.Fatalf("二进制资源 encoding = %q, want %q", res.Encoding, abi.EncodingBase64)
	}
	if res.Base64 != "iVBORw==" {
		t.Fatalf("base64 = %q", res.Base64)
	}

	// 非 UTF-8 的"文本"退回 base64（不能把坏字节替换成 U+FFFD 交给应用）。
	out = mustDispatch(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "broken.txt"}))
	res = out.(abi.AssetsReadResult)
	if res.Base64 == "" || res.Text != "" {
		t.Fatalf("非 UTF-8 文本 = %+v, want base64", res)
	}
	if res.Encoding != abi.EncodingBase64 {
		t.Fatalf("非 UTF-8 文本 encoding = %q, want %q", res.Encoding, abi.EncodingBase64)
	}

	// 零字节资源：Encoding=empty（判别字段），Text/Base64 都为空。
	empty := &fakeAssets{types: map[string]string{"empty.txt": "text/plain"}, files: map[string][]byte{"empty.txt": {}}}
	ec := &Capabilities{Assets: empty}
	out = mustDispatch(t, ec, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "empty.txt"}))
	res = out.(abi.AssetsReadResult)
	if res.Size != 0 || res.Text != "" || res.Base64 != "" || res.ContentType != "text/plain" {
		t.Fatalf("零字节资源 = %+v", res)
	}
	if res.Encoding != abi.EncodingEmpty {
		t.Fatalf("零字节资源 encoding = %q, want %q", res.Encoding, abi.EncodingEmpty)
	}

	// 路径原样传给实现（实现方负责逻辑路径校验）。
	if assets.path != "broken.txt" {
		t.Fatalf("实现收到的 path = %q", assets.path)
	}
}

// TestAssetsReadEncodingDiscriminatesOnWire 是 FIX-3 的 **wire 级**判据
// （模块 H 审计 P1-2：Encoding 自称必填却从未被填充，wire 上恒为 ""，
// 于是"零字节资源"与"内容为空串的文本资源"返回逐字节相同的 JSON）。
//
// 断言的是 Dispatch 返回结构 **序列化之后**的 JSON：三种形态的 encoding 值不同、
// 与内容分支一致，且零字节形态不再与"空内容文本"混淆。
// 变异验证：把 res.Encoding 恒置空（或只填两个分支）⇒ 本用例红。
func TestAssetsReadEncodingDiscriminatesOnWire(t *testing.T) {
	c := &Capabilities{Assets: &fakeAssets{
		types: map[string]string{
			"index.html": "text/html",
			"logo.png":   "image/png",
			"empty.txt":  "text/plain",
			"blank.txt":  "text/plain",
		},
		files: map[string][]byte{
			"index.html": []byte("<h1>hi</h1>"),
			"logo.png":   {0x89, 'P', 'N', 'G'},
			// empty.txt 与 blank.txt 都是零字节：ABI 必须能一眼看出"没有负载"，
			// 而不是让应用去猜该读 text 还是 base64。
			"empty.txt": {},
			"blank.txt": {},
		},
	}}

	cases := []struct {
		path         string
		wantEncoding string
		wantText     string
		wantBase64   string
	}{
		{"index.html", abi.EncodingText, "<h1>hi</h1>", ""},
		{"logo.png", abi.EncodingBase64, "", "iVBORw=="},
		{"empty.txt", abi.EncodingEmpty, "", ""},
	}
	wires := map[string]string{}
	for _, tc := range cases {
		out := mustDispatch(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: tc.path}))
		res, ok := out.(abi.AssetsReadResult)
		if !ok {
			t.Fatalf("%s 结果类型 = %T", tc.path, out)
		}
		if res.Encoding != tc.wantEncoding {
			t.Fatalf("%s encoding = %q, want %q", tc.path, res.Encoding, tc.wantEncoding)
		}
		if res.Text != tc.wantText || res.Base64 != tc.wantBase64 {
			t.Fatalf("%s 内容分支 = text:%q base64:%q, want text:%q base64:%q",
				tc.path, res.Text, res.Base64, tc.wantText, tc.wantBase64)
		}
		wire, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		wires[tc.path] = string(wire)
		if !strings.Contains(string(wire), `"encoding":"`+tc.wantEncoding+`"`) {
			t.Fatalf("%s wire 上缺 encoding=%s: %s", tc.path, tc.wantEncoding, wire)
		}
		// encoding 是必填字段，不允许被 omitempty 抹掉。
		if strings.Contains(string(wire), `"encoding":""`) {
			t.Fatalf("%s wire 上 encoding 为空（正是被审计的缺陷形态）: %s", tc.path, wire)
		}
	}
	if wires["index.html"] == wires["empty.txt"] || wires["logo.png"] == wires["empty.txt"] {
		t.Fatalf("不同形态的 wire JSON 不能相同（判别字段必须有效）:\n%s\n%s\n%s",
			wires["index.html"], wires["logo.png"], wires["empty.txt"])
	}
	// 零字节形态：两个可选负载字段都被省略，只有 encoding=empty 表达"没有负载"。
	if strings.Contains(wires["empty.txt"], `"text"`) || strings.Contains(wires["empty.txt"], `"base64"`) {
		t.Fatalf("零字节资源的 wire 里不应出现 text/base64: %s", wires["empty.txt"])
	}
	// 内容恰为空串的文本资源与零字节资源在字节上无法区分（同一份文件），
	// ABI 的口径是：**任何**零字节资源都是 encoding=empty，而不是靠猜分支。
	blank := mustDispatch(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "blank.txt"}))
	if got := blank.(abi.AssetsReadResult).Encoding; got != abi.EncodingEmpty {
		t.Fatalf("空内容文本资源 encoding = %q, want %q", got, abi.EncodingEmpty)
	}
}

func TestAssetsReadRejectsEmptyPathAndPropagatesErrors(t *testing.T) {
	c := &Capabilities{Assets: &fakeAssets{}}
	e := dispatchErr(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "  "}))
	if e.Code != apperr.CodeValidation || e.Details["field"] != "path" {
		t.Fatalf("空 path = %s/%v, want VALIDATION/path", e.Code, e.Details)
	}

	// 实现方的 *apperr.Error 必须原样透出（NOT_FOUND / DB_DENIED / SECTION_OVERSIZE…）。
	c = &Capabilities{Assets: &fakeAssets{err: apperr.New(apperr.CodeNotFound, "资源不存在")}}
	if e := dispatchErr(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "nope"})); e.Code != apperr.CodeNotFound {
		t.Fatalf("code = %s, want NOT_FOUND", e.Code)
	}
	c = &Capabilities{Assets: &fakeAssets{err: apperr.New(apperr.CodeDBDenied, "路径被拒").
		WithDetail("reason", "path_denied")}}
	if e := dispatchErr(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "../x"})); e.Code != apperr.CodeDBDenied {
		t.Fatalf("code = %s, want DB_DENIED", e.Code)
	}

	// 纵深防御：实现方返回超限资源也要被拦（Assets 是可替换接口），
	// 且错误码与实现方同码（ASSET_OVERSIZE）。
	big := &fakeAssets{types: map[string]string{"big.bin": "application/octet-stream"},
		files: map[string][]byte{"big.bin": make([]byte, limits.SectionTotalMaxBytes+1)}}
	c = &Capabilities{Assets: big}
	if e := dispatchErr(t, c, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "big.bin"})); e.Code != apperr.CodeAssetOversize {
		t.Fatalf("code = %s, want ASSET_OVERSIZE", e.Code)
	}
}

// ===== 参数严格性 =====

func TestParamStrictness(t *testing.T) {
	db := &fakeDB{}
	c := &Capabilities{User: loggedIn(), DB: db, Assets: &fakeAssets{}, Logs: &fakeSink{}}

	bad := []struct {
		name   string
		method string
		raw    string
		field  string
	}{
		{"JSON 非法", abi.MethodDBQuery, `{"sql":`, ""},
		{"未知字段", abi.MethodDBQuery, `{"sqls":"SELECT 1"}`, "sqls"},
		{"类型不符", abi.MethodDBQuery, `{"sql":42}`, "sql"},
		{"SQL 参数类型不符", abi.MethodDBExec, `{"sql":"DELETE FROM t","args":{"a":1}}`, "args"},
		{"尾部多余内容", abi.MethodLog, `{"level":"info","message":"x"} {"level":"info"}`, ""},
		{"tx_begin 带参数", abi.MethodTxBegin, `{"unexpected":1}`, "unexpected"},
		{"顶层是数组", abi.MethodLog, `["info"]`, ""},
		{"顶层是字符串", abi.MethodLog, `"info"`, ""},
	}
	for _, tc := range bad {
		t.Run(tc.name, func(t *testing.T) {
			out, e := c.Dispatch(context.Background(), tc.method, json.RawMessage(tc.raw))
			if e == nil {
				t.Fatalf("Dispatch(%s, %s) = %#v, want error", tc.method, tc.raw, out)
			}
			if e.Code != apperr.CodeValidation {
				t.Fatalf("code = %s, want VALIDATION", e.Code)
			}
			if e.Details["method"] != tc.method {
				t.Fatalf("details.method = %v, want %s", e.Details["method"], tc.method)
			}
			if tc.field != "" && e.Details["field"] != tc.field {
				t.Fatalf("details.field = %v, want %q", e.Details["field"], tc.field)
			}
		})
	}
	if len(db.queries) != 0 || len(db.execs) != 0 {
		t.Fatal("被拒的调用不得触达 DB 实现")
	}

	// 合法的空参数形态（tx_begin 不带参数）必须放行。
	// 每次用新的 Capabilities/DB：Begin 之后 InTx() 为真，事务内不允许再 begin
	// （这条由 TestTxBlocksOtherHostCalls 覆盖）。
	for _, raw := range []json.RawMessage{nil, json.RawMessage(`{}`), json.RawMessage(`null`), json.RawMessage("  ")} {
		fresh := &Capabilities{User: loggedIn(), DB: &fakeDB{}, Assets: sampleAssets(), Logs: &fakeSink{}}
		if _, e := fresh.Dispatch(context.Background(), abi.MethodTxBegin, raw); e != nil {
			t.Fatalf("tx_begin(%q) = %v, want ok", raw, e)
		}
	}
}

// ===== panic / 装配缺陷 / 取消 =====

func TestPanicBecomesInternalError(t *testing.T) {
	const secret = "hunter2"
	c := &Capabilities{
		User: loggedIn(),
		AI:   &fakeAI{panic: true},
	}
	e := dispatchErr(t, c, abi.MethodAIChat, params(t, abi.AIChatParams{
		Messages: []abi.ChatMessage{{Role: "user", Content: "x"}},
	}))
	if e.Code != apperr.CodeInternal || e.Status() != 500 {
		t.Fatalf("code/status = %s/%d, want INTERNAL/500", e.Code, e.Status())
	}
	if e.Details["method"] != abi.MethodAIChat {
		t.Fatalf("details.method = %v", e.Details)
	}
	// panic 值可能带内部细节（DSN、路径、口令）⇒ 绝不进给应用的错误体。
	if blob := e.JSON(); strings.Contains(blob, secret) || strings.Contains(blob, "panic") {
		t.Fatalf("panic 细节泄露给应用: %s", blob)
	}
	// 宿主仍然活着：后续调用照常。
	if _, e := c.Dispatch(context.Background(), abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "after panic"})); e != nil {
		t.Fatalf("panic 之后宿主不可用: %v", e)
	}
}

func TestMissingCapabilitiesAreInternal(t *testing.T) {
	cases := []struct {
		name   string
		c      *Capabilities
		method string
		p      json.RawMessage
	}{
		{"无 DB", &Capabilities{}, abi.MethodDBQuery, params(t, abi.SQLParams{SQL: "SELECT 1"})},
		{"无 DB(tx)", &Capabilities{}, abi.MethodTxBegin, nil},
		{"无 AI", &Capabilities{User: loggedIn()}, abi.MethodAIChat, params(t, abi.AIChatParams{
			Messages: []abi.ChatMessage{{Role: "user", Content: "x"}}})},
		{"无 Assets", &Capabilities{}, abi.MethodAssetsRead, params(t, abi.AssetsReadParams{Path: "a.txt"})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			e := dispatchErr(t, tc.c, tc.method, tc.p)
			if e.Code != apperr.CodeInternal {
				t.Fatalf("code = %s, want INTERNAL（装配缺陷不是应用的错）", e.Code)
			}
			if e.Details["method"] != tc.method {
				t.Fatalf("details = %v", e.Details)
			}
		})
	}
}

func TestCapabilityErrorsAreConverted(t *testing.T) {
	// 普通 error ⇒ INTERNAL（不泄露内部细节）。
	c := &Capabilities{DB: &fakeDB{err: fmt.Errorf("pq: relation \"users\" does not exist (dsn=postgres://u:p@h/db)")}}
	e := dispatchErr(t, c, abi.MethodDBQuery, params(t, abi.SQLParams{SQL: "SELECT 1"}))
	if e.Code != apperr.CodeInternal {
		t.Fatalf("code = %s, want INTERNAL", e.Code)
	}
	if blob := e.JSON(); strings.Contains(blob, "dsn=") || strings.Contains(blob, "relation") {
		t.Fatalf("内部错误细节泄露: %s", blob)
	}
	// *apperr.Error ⇒ 原样透出（DB_DENIED/DB_LIMIT 等语义必须保住）。
	want := apperr.New(apperr.CodeDBLimit, "应用数据库已满").
		WithDetail("reason", "db_full").
		WithHint("清理历史数据")
	c = &Capabilities{DB: &fakeDB{err: want}}
	got := dispatchErr(t, c, abi.MethodDBExec, params(t, abi.SQLParams{SQL: "DELETE FROM t"}))
	if got.Code != apperr.CodeDBLimit || got.Details["reason"] != "db_full" || len(got.Hints) == 0 {
		t.Fatalf("平台错误被吞: %+v", got)
	}
}

func TestCancelledAfterCallIsModuleKilled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	db := &fakeDB{onQuery: func(context.Context) error {
		cancel() // 宿主调用途中请求被杀（guest 超时 / 模块关闭）
		return nil
	}}
	c := &Capabilities{DB: db}
	_, e := c.Dispatch(ctx, abi.MethodDBQuery, params(t, abi.SQLParams{SQL: "SELECT 1"}))
	if e == nil {
		t.Fatal("调用返回成功但请求已被取消时必须报错（绝不返回 200）")
	}
	if e.Code != apperr.CodeModuleKilled {
		t.Fatalf("code = %s, want MODULE_KILLED（§7.4 硬断言）", e.Code)
	}
}

func TestCancelledAtEntryIsModuleKilled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	c := &Capabilities{Logs: &fakeSink{}}
	if _, e := c.Dispatch(ctx, abi.MethodLog, params(t, abi.LogParams{Level: "info", Message: "x"})); e == nil ||
		e.Code != apperr.CodeModuleKilled {
		t.Fatalf("err = %v, want MODULE_KILLED", e)
	}
}

// ===== 其它 =====

// abi.ping 是 validate 干跑探针：能被应答，但**不进能力清单**（见 gate_test.go）。
func TestPingAnswersDryRunProbe(t *testing.T) {
	c := &Capabilities{}
	out, e := c.Dispatch(context.Background(), abi.MethodPing, nil)
	if e != nil {
		t.Fatalf("Dispatch(%s) = %v", abi.MethodPing, e)
	}
	res, ok := out.(pingResult)
	if !ok || !res.Pong || res.ABI != abi.ABIVersion {
		t.Fatalf("ping 结果 = %#v", out)
	}
}

// db.* / 事务控制的正常路径（证明分发确实把参数交给了实现）。
func TestDBAndTxHappyPath(t *testing.T) {
	db := &fakeDB{}
	c := &Capabilities{DB: db}
	out := mustDispatch(t, c, abi.MethodDBDefine, params(t, abi.DBDefineParams{
		Table: "items", Columns: []abi.ColumnDef{{Name: "title", Type: "text"}},
	}))
	if res, ok := out.(abi.DBDefineResult); !ok || res.Table != "items" {
		t.Fatalf("define 结果 = %#v", out)
	}
	mustDispatch(t, c, abi.MethodDBQuery, params(t, abi.SQLParams{SQL: "SELECT 1", Args: []any{1, "a"}}))
	mustDispatch(t, c, abi.MethodDBExec, params(t, abi.SQLParams{SQL: "DELETE FROM items"}))
	mustDispatch(t, c, abi.MethodTxBegin, nil)
	mustDispatch(t, c, abi.MethodTxRollback, params(t, abi.TxParams{TxID: 1}))
	if len(db.defined) != 1 || len(db.queries) != 1 || len(db.execs) != 1 || db.begins != 1 || db.rollbacks != 1 {
		t.Fatalf("分发没有把调用交给实现: %+v", db)
	}
	if len(db.queries[0].Args) != 2 {
		t.Fatalf("SQL 参数被改写: %+v", db.queries[0])
	}
}

// 能力实现返回的 AI 结果原样透出（应用侧契约）。
func TestAIChatResultPassthrough(t *testing.T) {
	ai := &fakeAI{}
	c := &Capabilities{User: loggedIn(), AI: ai}
	out := mustDispatch(t, c, abi.MethodAIChat, params(t, abi.AIChatParams{
		Messages: []abi.ChatMessage{{Role: "user", Content: "hi"}}, Model: "m1",
	}))
	res, ok := out.(abi.AIChatResult)
	if !ok || res.Content != "ok" || res.Model != "m" {
		t.Fatalf("结果 = %#v", out)
	}
	if ai.params.Model != "m1" || len(ai.params.Messages) != 1 {
		t.Fatalf("参数被改写: %+v", ai.params)
	}
}
