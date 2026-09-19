package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

// 本文件是本机（Linux 原生）对参考实现的**真跑**测试：一个假宿主按 §7.2 驱动它走完整轮次。
//
// 为什么必须真跑而不是只编译：refapp 同时是 skill 的教学样例与导入白名单的来源，
// 它的帧收发一旦写错（忘 Flush / 用会预读的解码器 / 少调一个宿主方法），
// 作者照抄就会踩坑；本机原生跑一遍是唯一能低成本发现这类错误的办法
// （wasm 侧的编译判据在 wasmmod/imports_gen_test.go）。
//
// 变异验证（§5.5）：
//   - 让 callHosts 少调任一宿主方法        → TestRunCallsEveryHostMethod 必红；
//   - 把 writeFrame 的 Flush 去掉          → 全部用例挂死（宿主永远等不到帧）；
//   - 把 readFrame 换成 json.Decoder       → 第二次宿主调用起必红（预读吞掉后续帧）；
//   - 让 run 不写最终响应帧                → TestRunCallsEveryHostMethod 在 EOF 处必红。

// 期望的宿主调用序列：两个事务各演示一条出口，**事务体里有真实 SQL**
// （tx#1 = begin→exec→query→commit；tx#2 = begin→exec→rollback）。
// 这条序列本身就是"db.tx 可用"的证据：把 db.query/db.exec 从事务允许集里去掉，
// 参考实现的这两条调用会拿到 host_call_in_tx，TestRunTxBodySQLActuallySucceeds 红。
var expectedCallSequence = []string{
	abi.MethodDBDefine,
	abi.MethodTxBegin,
	abi.MethodDBExec,
	abi.MethodDBQuery,
	abi.MethodTxCommit,
	abi.MethodTxBegin,
	abi.MethodDBExec,
	abi.MethodTxRollback,
	abi.MethodLog,
	abi.MethodAssetsRead,
}

// fakeHostResult 让假宿主按方法返回一个贴合该方法的成功结果。
func fakeHostResult(method string) any {
	switch method {
	case abi.MethodDBDefine:
		return abi.DBDefineResult{Created: true, Table: "notes", Columns: []string{"title", "body"}}
	case abi.MethodDBQuery:
		return abi.QueryResult{Columns: []string{"title"}, Rows: [][]any{{"第一条"}}}
	case abi.MethodDBExec:
		return abi.ExecResult{RowsAffected: 1}
	case abi.MethodTxBegin:
		return abi.TxResult{TxID: 7}
	case abi.MethodTxCommit, abi.MethodTxRollback:
		return map[string]any{"ok": true}
	case abi.MethodLog:
		return abi.LogResult{Accepted: 1}
	case abi.MethodAssetsRead:
		return abi.AssetsReadResult{ContentType: "application/json", Size: 2, Text: "{}"}
	default:
		return map[string]any{}
	}
}

// drive 以假宿主身份驱动 refapp：先发请求帧，然后逐个应答它的 JSON-RPC 请求，直到拿到最终响应帧。
//
// 返回值：最终响应、被调用的方法序列、被当成日志捕获的非帧输出行、
// 以及每条 RPC 请求的原始 params（便于断言参数形状）。
func drive(t *testing.T, req abi.Request, respond func(method string, params json.RawMessage) (any, *abi.RPCErrorBody)) (abi.Response, []string, []string, map[string]json.RawMessage) {
	t.Helper()
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	defer outR.Close() // 测试中途失败时让应用侧写管道立即报错，避免 goroutine 永久阻塞
	defer inW.Close()

	done := make(chan error, 1)
	go func() {
		done <- run(inR, outW)
		outW.Close()
	}()

	reqPayload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("编码请求帧: %v", err)
	}
	if _, err := inW.Write(abi.EncodeFrame(reqPayload)); err != nil {
		t.Fatalf("写请求帧: %v", err)
	}

	reader := bufio.NewReader(outR)
	var (
		methods []string
		logs    []string
		params  = map[string]json.RawMessage{}
	)
	for {
		// 宿主侧判别：首字节不是 RS ⇒ 非帧输出，按日志整行读走（§7.2 / §5.4）。
		isFrame, err := abi.PeekIsFrame(reader)
		if err != nil {
			t.Fatalf("应用输出在没有最终响应帧前结束: %v（已收到方法 %v）", err, methods)
		}
		if !isFrame {
			line, err := reader.ReadString('\n')
			if err != nil {
				t.Fatalf("读非帧输出行: %v", err)
			}
			logs = append(logs, strings.TrimRight(line, "\n"))
			continue
		}
		payload, err := abi.ReadFrame(reader)
		if err != nil {
			t.Fatalf("读帧: %v", err)
		}
		switch abi.Classify(payload) {
		case abi.FrameRPC:
			var rpc abi.RPCRequest
			if err := json.Unmarshal(payload, &rpc); err != nil {
				t.Fatalf("解析 RPC 请求: %v", err)
			}
			if rpc.JSONRPC != "2.0" {
				t.Fatalf("RPC 请求缺 jsonrpc=2.0: %s", payload)
			}
			if len(rpc.ID) == 0 {
				t.Fatalf("RPC 请求缺 id: %s", payload)
			}
			methods = append(methods, rpc.Method)
			params[rpc.Method] = rpc.Params
			result, rpcErr := respond(rpc.Method, rpc.Params)
			var resp abi.RPCResponse
			if rpcErr != nil {
				resp = abi.NewRPCError(rpc.ID, rpcErr.Code, rpcErr.Message)
			} else {
				resp = abi.NewRPCResult(rpc.ID, result)
			}
			encoded, err := json.Marshal(resp)
			if err != nil {
				t.Fatalf("编码 RPC 响应: %v", err)
			}
			if _, err := inW.Write(abi.EncodeFrame(encoded)); err != nil {
				t.Fatalf("写 RPC 响应: %v", err)
			}
		case abi.FrameResponse:
			var final abi.Response
			if err := json.Unmarshal(payload, &final); err != nil {
				t.Fatalf("解析最终响应: %v", err)
			}
			if err := <-done; err != nil {
				t.Fatalf("run 返回错误: %v", err)
			}
			return final, methods, logs, params
		default:
			t.Fatalf("应用输出了既不是 RPC 也不是响应的帧: %s", payload)
		}
	}
}

func TestRunCallsEveryHostMethod(t *testing.T) {
	final, methods, logs, params := drive(t, abi.Request{
		ABI:    abi.ABIVersion,
		AppID:  "demo",
		Method: "POST",
		Path:   "/",
	}, func(method string, _ json.RawMessage) (any, *abi.RPCErrorBody) {
		return fakeHostResult(method), nil
	})

	// 调用序列必须与文档顺序一致（tx_begin 两次）。
	if len(methods) != len(expectedCallSequence) {
		t.Fatalf("宿主调用次数 = %d，期望 %d：%v", len(methods), len(expectedCallSequence), methods)
	}
	for i, want := range expectedCallSequence {
		if methods[i] != want {
			t.Fatalf("第 %d 次宿主调用 = %s，期望 %s（完整序列 %v）", i, methods[i], want, methods)
		}
	}
	// 封闭清单全覆盖（§5.1）：abi.HostMethods 里的每一个都必须被调到。
	called := map[string]bool{}
	for _, m := range methods {
		called[m] = true
	}
	for _, m := range abi.HostMethods {
		if !called[m] {
			t.Fatalf("参考实现没有调用宿主方法 %s（§5.1 封闭清单必须全部演示）", m)
		}
	}

	// 参数形状：db.define 声明表结构；db.exec 用参数化 SQL（不拼字符串）；tx_commit 带上 tx_id。
	var define abi.DBDefineParams
	if err := json.Unmarshal(params[abi.MethodDBDefine], &define); err != nil {
		t.Fatalf("db.define 参数不是 DBDefineParams: %v", err)
	}
	if define.Table != "notes" || len(define.Columns) != 2 {
		t.Fatalf("db.define 参数 = %+v", define)
	}
	var exec abi.SQLParams
	if err := json.Unmarshal(params[abi.MethodDBExec], &exec); err != nil {
		t.Fatalf("db.exec 参数不是 SQLParams: %v", err)
	}
	if !strings.Contains(exec.SQL, "?") || len(exec.Args) != 2 {
		t.Fatalf("db.exec 应当是参数化 SQL: %+v", exec)
	}
	var commit abi.TxParams
	if err := json.Unmarshal(params[abi.MethodTxCommit], &commit); err != nil {
		t.Fatalf("tx_commit 参数不是 TxParams: %v", err)
	}
	if commit.TxID != 7 {
		t.Fatalf("tx_commit 应带上 tx_begin 返回的 tx_id，实际 %d", commit.TxID)
	}

	// 演示用的非帧输出必须被宿主当日志捕获，且不能破坏协议。
	if len(logs) == 0 || !strings.Contains(logs[0], "refapp: start") {
		t.Fatalf("应有一条非帧输出演示行，实际 %v", logs)
	}

	// 最终响应信封。
	if final.Status != 200 {
		t.Fatalf("最终响应 status = %d，期望 200（body=%s）", final.Status, final.Body)
	}
	if ct := final.Headers["Content-Type"]; !strings.Contains(ct, "application/json") {
		t.Fatalf("Content-Type = %q（必须在 §4.8 允许集合内）", ct)
	}

	var summary responseSummary
	if err := json.Unmarshal([]byte(final.Body), &summary); err != nil {
		t.Fatalf("响应体不是合法 JSON: %v（body=%s）", err, final.Body)
	}
	if summary.ABI != abi.ABIVersion || summary.AppID != "demo" || summary.Method != "POST" {
		t.Fatalf("响应体没有回显请求身份: %+v", summary)
	}
	if len(summary.HostCalls) != len(methods) {
		t.Fatalf("响应体里的 host_calls 条数 = %d，期望 %d", len(summary.HostCalls), len(methods))
	}
	for _, rec := range summary.HostCalls {
		if !rec.OK || rec.Error != nil {
			t.Fatalf("宿主调用 %s 在成功路径上应为 OK: %+v", rec.Method, rec)
		}
	}

	// WASI 面取证字段（§10.2 第 21/22/23 项）：字段必须在，值由运行环境决定。
	if len(summary.Runtime.RandomHex) != 16 {
		t.Fatalf("random_hex = %q，期望 16 个十六进制字符", summary.Runtime.RandomHex)
	}
	if summary.Runtime.NowUnix <= 0 {
		t.Fatalf("now_unix = %d，期望真实墙钟", summary.Runtime.NowUnix)
	}
	// 本机原生跑时 args/env 来自测试进程；线上（wasip1 + 平台）两者必须为 0（§10.2 第 23 项）。
	// 这里断言"字段真的被读取了"：原生环境下 args 至少有测试二进制名。
	if summary.Runtime.ArgsCount < 1 {
		t.Fatalf("本机原生跑应有至少 1 个 args（说明 os.Args 确实被读取）: %+v", summary.Runtime)
	}
}

// TestRunTxBodySQLActuallySucceeds 是"参考实现里的事务体真的在做数据库读写"的判据
// （模块 H 审计 P0-1：样例此前是 begin→commit，事务体零 SQL，所以缺陷隐形）。
//
// 假宿主**复刻 hostcap 的事务闸门**（唯一真源 abi.TxAllowedWhileInTx）：事务内
// 出现任何不在允许集里的调用就回 DB_DENIED/host_call_in_tx。于是这条用例同时断言：
//   - 参考实现的调用序列是**事务合法**的（没有一条落在闸门上）；
//   - tx#1 的事务体里恰好是 db.exec + db.query，tx#2 的事务体里有 db.exec。
//
// 变异验证：把 db.query/db.exec 从 abi.TxAllowedWhileInTx 去掉（缺陷原状）⇒
// 本用例红（参考实现的 SQL 会被自己复刻的闸门拒掉）。
func TestRunTxBodySQLActuallySucceeds(t *testing.T) {
	var inTx bool
	final, _, _, _ := drive(t, abi.Request{ABI: abi.ABIVersion, AppID: "demo"},
		func(method string, _ json.RawMessage) (any, *abi.RPCErrorBody) {
			if inTx && !abi.TxAllowedWhileInTx(method) {
				return nil, &abi.RPCErrorBody{
					Code:    "DB_DENIED",
					Message: "事务内不允许调用 " + method,
					Details: map[string]any{"reason": "host_call_in_tx", "method": method},
				}
			}
			switch method {
			case abi.MethodTxBegin:
				inTx = true
			case abi.MethodTxCommit, abi.MethodTxRollback:
				inTx = false
			}
			return fakeHostResult(method), nil
		})

	var summary responseSummary
	if err := json.Unmarshal([]byte(final.Body), &summary); err != nil {
		t.Fatalf("响应体解析失败: %v", err)
	}
	// 事务体必须是合法的：任何 host_call_in_tx 都说明样例还在教错的用法。
	var bodies [][]callRecord
	for _, rec := range summary.HostCalls {
		if rec.Error != nil && rec.Error.Details["reason"] == "host_call_in_tx" {
			t.Fatalf("参考实现在事务内调了被禁能力 %s（事务允许集 = db.query/db.exec + 两个出口）", rec.Method)
		}
		switch rec.Method {
		case abi.MethodTxBegin:
			bodies = append(bodies, nil)
		case abi.MethodTxCommit, abi.MethodTxRollback:
			// 出口调用本身不入事务体。
		default:
			if len(bodies) > 0 {
				bodies[len(bodies)-1] = append(bodies[len(bodies)-1], rec)
			}
		}
	}
	if len(bodies) != 2 {
		t.Fatalf("应当演示两个事务，实际 %d", len(bodies))
	}
	// 事务体内的每一次调用都必须**成功**（这是"db.tx 可用"的判据本身）：
	// 允许集一旦被改回只留 commit/rollback，这里的 db.exec/db.query 就会带错误。
	// 注意 abi.NewRPCError 不带 details，所以只判"有没有错"，不依赖 reason。
	for i, body := range bodies {
		for _, rec := range body {
			if !rec.OK || rec.Error != nil {
				t.Fatalf("tx#%d 事务体内的 %s 失败了: %+v（事务内只允许数据库读写：db.query/db.exec）", i+1, rec.Method, rec.Error)
			}
		}
	}
	if got := bodyMethods(bodies[0]); got != abi.MethodDBExec+","+abi.MethodDBQuery {
		t.Fatalf("tx#1 的事务体 = %v, want [db.exec db.query]（begin → 写 → 读 → commit）", got)
	}
	if len(bodies[1]) == 0 || bodies[1][0].Method != abi.MethodDBExec {
		t.Fatalf("tx#2 的事务体 = %v, want 以 db.exec 开头（写一份随后被回滚的数据）", bodyMethods(bodies[1]))
	}
}

// bodyMethods 把事务体的方法名拼成逗号串（断言用）。
func bodyMethods(body []callRecord) string {
	out := make([]string, 0, len(body))
	for _, rec := range body {
		out = append(out, rec.Method)
	}
	return strings.Join(out, ",")
}

func TestRunReportsHostErrorsWithoutFailingBusiness(t *testing.T) {
	// 宿主函数失败必须原样记进响应体，且应用仍给出 200 —— 业务成败由应用决定。
	//
	// ⚠️ 夹具从 DB_LIMIT 取（原用已删除的 AI 能力）：`db.exec` 是参考实现真正会调的
	// 宿主方法，用它才**真的**走到"业务继续、错误被记录"那条路径。
	final, _, _, _ := drive(t, abi.Request{ABI: abi.ABIVersion, AppID: "demo"},
		func(method string, _ json.RawMessage) (any, *abi.RPCErrorBody) {
			if method == abi.MethodDBExec {
				return nil, &abi.RPCErrorBody{Code: "DB_LIMIT", Message: "应用库已满"}
			}
			return fakeHostResult(method), nil
		})
	if final.Status != 200 {
		t.Fatalf("宿主业务错误不应让应用崩掉，status = %d", final.Status)
	}
	var summary responseSummary
	if err := json.Unmarshal([]byte(final.Body), &summary); err != nil {
		t.Fatalf("响应体解析失败: %v", err)
	}
	var found bool
	for _, rec := range summary.HostCalls {
		if rec.Method != abi.MethodDBExec {
			continue
		}
		found = true
		if rec.OK || rec.Error == nil || rec.Error.Code != "DB_LIMIT" {
			t.Fatalf("db.exec 的宿主错误没有被记录: %+v", rec)
		}
	}
	if !found {
		t.Fatalf("响应体缺少 db.exec 记录: %+v", summary.HostCalls)
	}
}

func TestRunWithoutRequestFrameStillWritesResponse(t *testing.T) {
	// 没有请求帧时也必须给宿主一个合法响应帧（否则宿主只能报 RUNTIME_NO_RESPONSE，§7.4）。
	var out bytes.Buffer
	err := run(strings.NewReader(""), &out)
	if err == nil {
		t.Fatalf("空 stdin 应当报错（同时仍写出 500 响应帧）")
	}
	payload, ferr := abi.ReadFrame(bufio.NewReader(&out))
	if ferr != nil {
		t.Fatalf("应写出一个可解析的响应帧: %v", ferr)
	}
	var resp abi.Response
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("响应帧不是 Response: %v", err)
	}
	if resp.Status != 500 {
		t.Fatalf("无请求帧时应回 500，实际 %d", resp.Status)
	}
}

func TestRunRejectsNonFrameOnStdin(t *testing.T) {
	// stdin 上出现非帧字节 ⇒ 协议层错误（不是"当成请求"）。
	var out bytes.Buffer
	err := run(strings.NewReader("not a frame\n"), &out)
	if err == nil || !strings.Contains(err.Error(), "非帧字节") {
		t.Fatalf("应报非帧字节错误，实际 %v", err)
	}
}

func TestFakeHostResultCoversEveryHostMethod(t *testing.T) {
	// 假宿主必须对封闭清单里的每个方法都有结果，否则测试会静默退化成"空结果也是成功"。
	for _, m := range abi.HostMethods {
		if res := fakeHostResult(m); res == nil {
			t.Fatalf("假宿主缺少 %s 的结果", m)
		}
	}
}
