// A-1（2026-09-23 R3-A 审计，P1）的回归门禁：**宿主 → guest 的每一条返回路径**都必须在
// 单帧预算内交付，超预算时给出**可行动**的结果（分页信号或结构化错误），绝不让应用拿到
// 传输层错误 / 挂死。
//
// 修复前的现场（探针实测）：`db.query` 结果 1–8 MiB（平台自己允许）被宿主写成**超帧**
// ⇒ 官方技能骨架的读帧器（超限即失败、不排空）拿到传输错误后应用什么都没答，宿主那条写
// 又因没人读而阻塞到 guest 预算耗尽 ⇒ 应用表现为 **10 s `RUNTIME_TIMEOUT` 且自己写好的
// 响应被丢弃**；换成 `abi.ReadFrame` 形态的读帧器则退化成一条裸协议错误、0 行数据。
//
// 本文件钉住三层判据（与 frame_budget_test.go 的 ABI-1 判据互补，不重叠）：
//  1. `db.query` 超限 ⇒ **按帧预算丢尾行 + `truncated=true`**（数据保住、分页信号在）；
//  2. 连"丢掉全部行"都装不下（单行或列名本身超帧）⇒ 结构化 **DB_LIMIT**；
//  3. 其它任何超限结果 ⇒ 结构化 **RESULT_TOO_LARGE**；且**永不**返回 > MaxFrameBytes 的
//     字节（guest 把 id 写成近 1 MiB 时退化为 `id:null`）。
package abi

import (
	"bufio"
	"bytes"
	"encoding/json"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// rpcFrame 是测试侧的应答线格式：`Result` 取 `json.RawMessage` 再二次解码成具体类型
// （`RPCResponse.Result` 是 any，直接反序列化只会得到 map[string]any，取不到 QueryResult）。
type rpcFrame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *RPCErrorBody   `json:"error"`
}

// decodeQueryResult 从一帧负载里取出 db.query 结果（断言它确实是查询结果）。
func decodeQueryResult(t *testing.T, frame []byte) (rpcFrame, QueryResult) {
	t.Helper()
	var f rpcFrame
	if err := json.Unmarshal(frame, &f); err != nil {
		t.Fatalf("帧不是合法应答：%v", err)
	}
	if f.Error != nil {
		t.Fatalf("应答是错误信封：code=%s", f.Error.Code)
	}
	var q QueryResult
	if err := json.Unmarshal(f.Result, &q); err != nil {
		t.Fatalf("result 不是 QueryResult：%v", err)
	}
	return f, q
}

// queryResultOfRows 造一个 Encoded 大小可调的 db.query 结果（每行一个字符串列）。
func queryResultOfRows(rows int, cell string) QueryResult {
	out := QueryResult{Columns: []string{"body"}, Rows: make([][]any, 0, rows)}
	for i := 0; i < rows; i++ {
		out.Rows = append(out.Rows, []any{cell})
	}
	return out
}

// TestOversizeQueryResultIsTruncatedToFrameBudget 覆盖判据 ①：
// 装不进一帧的 db.query 结果必须**裁到帧内**并置 truncated=true（数据保住、分页信号在），
// 而不是写成超帧。
func TestOversizeQueryResultIsTruncatedToFrameBudget(t *testing.T) {
	q := queryResultOfRows(2000, strings.Repeat("a", 1024)) // ≈2 MiB > 1 MiB 帧
	if plain, err := json.Marshal(q); err != nil || len(plain) <= MaxFrameBytes {
		t.Fatalf("前置条件不成立：结果应当装不进一帧（len=%d err=%v）", len(plain), err)
	}

	frame, err := json.Marshal(NewRPCResult(json.RawMessage(`11`), q))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("宿主写出了超帧：%d > %d", len(frame), MaxFrameBytes)
	}
	back, got := decodeQueryResult(t, frame)
	if !got.Truncated {
		t.Fatal("裁过行必须置 truncated=true（§4.5 的分页信号，绝不静默丢结果）")
	}
	if len(got.Rows) == 0 || len(got.Rows) >= len(q.Rows) {
		t.Fatalf("保留行数 = %d，应当 >0 且 <%d", len(got.Rows), len(q.Rows))
	}
	// 保留的是**前缀**（分页语义）：逐行与原文对拍。
	for i, row := range got.Rows {
		if len(row) != 1 || row[0] != q.Rows[i][0] {
			t.Fatalf("第 %d 行与原文不一致：%v", i, row)
		}
	}
	if len(got.Columns) != 1 || got.Columns[0] != "body" {
		t.Fatalf("列必须原样保留，实得 %v", got.Columns)
	}
	if string(back.ID) != "11" {
		t.Fatalf("id 必须保留（guest 靠它配对），实得 %s", back.ID)
	}

	// 端到端：这一帧与下一条帧都必须在 guest 侧可解析（不失同步）。
	var stream bytes.Buffer
	stream.Write(EncodeFrame(frame))
	stream.Write(EncodeFrame([]byte(`{"status":204}`)))
	r := bufio.NewReader(&stream)
	if _, err := ReadFrame(r); err != nil {
		t.Fatalf("裁剪后的帧必须可读：%v", err)
	}
	if second, err := ReadFrame(r); err != nil || string(second) != `{"status":204}` {
		t.Fatalf("下一帧解析失败（失同步）：%q %v", second, err)
	}
}

// TestOversizeTruncationMeasuresEncodedBytes 是 A-6 教训在 A-1 上的落地：
// 裁剪判据必须量**编码后**的字节，而不是原始字节 —— `<` 在 JSON 里膨胀 6 倍，
// 按原始字节裁会让结果照样装不进帧（这正是"512 KiB 保证可交付"被证伪的同一处陷阱）。
func TestOversizeTruncationMeasuresEncodedBytes(t *testing.T) {
	q := queryResultOfRows(4000, strings.Repeat("<", 1024)) // 原始 4 MiB，编码后 ≈24 MiB
	frame, err := json.Marshal(NewRPCResult(json.RawMessage(`7`), q))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("高转义结果仍是超帧：%d > %d（裁剪按原始字节算的？）", len(frame), MaxFrameBytes)
	}
	_, got := decodeQueryResult(t, frame)
	if !got.Truncated || len(got.Rows) == 0 {
		t.Fatalf("高转义结果必须同样裁到帧内并置 truncated：truncated=%v rows=%d", got.Truncated, len(got.Rows))
	}
}

// TestOversizeQueryResultWithHugeSingleRowBecomesDBLimit 覆盖判据 ②：
// 单行（或列名）本身就超过整帧预算时，裁无可裁 ⇒ 回结构化 **DB_LIMIT**
// （与 appdb 对"单行吃掉整份预算"的既有口径同码），而不是超帧。
func TestOversizeQueryResultWithHugeSingleRowBecomesDBLimit(t *testing.T) {
	q := QueryResult{Columns: []string{"blob"}, Rows: [][]any{{strings.Repeat("x", 2<<20)}}}
	frame, err := json.Marshal(NewRPCResult(json.RawMessage(`3`), q))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("宿主写出了超帧：%d > %d", len(frame), MaxFrameBytes)
	}
	var back RPCResponse
	if err := json.Unmarshal(frame, &back); err != nil {
		t.Fatalf("改写后的应答不是合法 RPCResponse：%v", err)
	}
	if back.Error == nil {
		// 只打形状，不把 2 MiB 的行内容打进日志。
		t.Fatalf("单行超帧必须回结构化错误，实得 result 类型 %T（error=nil）", back.Result)
	}
	if back.Error.Code != CodeDBLimit || CodeDBLimit != string(apperr.CodeDBLimit) {
		t.Fatalf("错误码 = %q，abi 字面量 %q，apperr 真源 %q", back.Error.Code, CodeDBLimit, apperr.CodeDBLimit)
	}
	if !strings.Contains(back.Error.Message, "分页") {
		t.Fatalf("DB_LIMIT 的文案必须给出可行动指引（分页），实得 %q", back.Error.Message)
	}
	if got, _ := back.Error.Details["max"].(float64); int(got) != MaxFrameBytes {
		t.Fatalf("details.max = %v，want %d", back.Error.Details["max"], MaxFrameBytes)
	}
	if string(back.ID) != "3" {
		t.Fatalf("id 必须保留，实得 %s", back.ID)
	}
}

// TestOversizeNonQueryResultBecomesResultTooLarge 覆盖判据 ③：
// 既不是 assets.read 也不是 db.query 的结果超限时，回兜底码 RESULT_TOO_LARGE
// （不静默、不写超帧、不误报成 DB_DENIED/INTERNAL 这类"改错地方"的码）。
func TestOversizeNonQueryResultBecomesResultTooLarge(t *testing.T) {
	// 用一条真实存在的"其它结果"形态：db.define 的结果被塞进一个超大列表。
	type payload struct {
		Big []string `json:"big"`
	}
	big := make([]string, 0, 4096)
	for i := 0; i < 4096; i++ {
		big = append(big, strings.Repeat("y", 512))
	}
	frame, err := json.Marshal(NewRPCResult(json.RawMessage(`4`), DBDefineResult{Created: true, Table: "t", Columns: big}))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("宿主写出了超帧：%d > %d", len(frame), MaxFrameBytes)
	}
	var back RPCResponse
	if err := json.Unmarshal(frame, &back); err != nil {
		t.Fatalf("改写后的应答不是合法 RPCResponse：%v", err)
	}
	if back.Error == nil || back.Error.Code != CodeResultTooLarge {
		t.Fatalf("应回 RESULT_TOO_LARGE，实得 code=%v（result 类型 %T）", back.Error, back.Result)
	}
	if CodeResultTooLarge != string(apperr.CodeResultTooLarge) {
		t.Fatalf("abi.CodeResultTooLarge 字面量 %q 与 apperr 真源 %q 漂移",
			CodeResultTooLarge, apperr.CodeResultTooLarge)
	}
	_ = payload{}
}

// TestOversizeErrorEnvelopeAlwaysFitsEvenWithHugeID 钉住兜底不变量：
// guest 可以把 JSON-RPC 的 `id` 写成接近 1 MiB 的值（它自己的请求帧也受 1 MiB 上限，
// 所以这是可达形态）。错误信封照抄 id 会再次超限 ⇒ 必须退化为 `id:null` 的错误，
// **绝不**返回超帧。
func TestOversizeErrorEnvelopeAlwaysFitsEvenWithHugeID(t *testing.T) {
	// 900 KiB 其实还塞得下（信封只有几百字节）⇒ 用接近单帧上限的 id 才是真形态：
	// guest 自己的请求帧受 1 MiB 上限约束，所以 id 可以长到这个量级。
	hugeID := json.RawMessage(`"` + strings.Repeat("i", (1<<20)-128) + `"`)
	q := QueryResult{Columns: []string{"blob"}, Rows: [][]any{{strings.Repeat("x", 2<<20)}}}
	frame, err := json.Marshal(NewRPCResult(hugeID, q))
	if err != nil {
		t.Fatalf("编码失败：%v", err)
	}
	if len(frame) > MaxFrameBytes {
		t.Fatalf("宿主写出了超帧：%d > %d", len(frame), MaxFrameBytes)
	}
	var back RPCResponse
	if err := json.Unmarshal(frame, &back); err != nil {
		t.Fatalf("改写后的应答不是合法 RPCResponse：%v", err)
	}
	if back.Error == nil || back.Error.Code != CodeDBLimit {
		t.Fatalf("应回 DB_LIMIT 错误，实得 code=%v（result 类型 %T）", back.Error, back.Result)
	}
	if string(back.ID) != "null" {
		t.Fatalf("装不下时必须退化为 id:null，实得 %d 字节的 id", len(back.ID))
	}
}

// TestOverBudgetPayloadBudgetDerivationIsWorstCaseSafe 钉住 A-6 的取值推导：
// 对外承诺"保证可交付"的字节量（MaxResponseBodyBytes）在最坏 JSON 转义下仍装得进一帧，
// 且它就是 limits 里那一份推导（不允许两处各写一个数）。
func TestOverBudgetPayloadBudgetDerivationIsWorstCaseSafe(t *testing.T) {
	if MaxResponseBodyBytes != limits.MaxDeliverablePayloadBytes {
		t.Fatalf("MaxResponseBodyBytes=%d 与 limits.MaxDeliverablePayloadBytes=%d 漂移（必须同源）",
			MaxResponseBodyBytes, limits.MaxDeliverablePayloadBytes)
	}
	if got := MaxResponseBodyBytes * limits.MaxJSONEscapeExpansion; got > MaxFrameBytes {
		t.Fatalf("最坏转义后 %d 字节 > 单帧上限 %d（该数字不再是\"保证可交付\"）", got, MaxFrameBytes)
	}
	// 逐形态实测：`<`（6×）、控制字符（6×）、`"`（2×）三种最坏形态都要装得下。
	for name, filler := range map[string]string{
		"html-lt": "<",
		"control": "\u0001",
		"quote":   "\"",
	} {
		body := strings.Repeat(filler, MaxResponseBodyBytes)
		enc, err := json.Marshal(NewRPCResult(json.RawMessage(`1`), Response{
			Status:  200,
			Headers: map[string]string{"content-type": "text/html; charset=utf-8"},
			Body:    body,
		}))
		if err != nil {
			t.Fatalf("%s: 编码失败：%v", name, err)
		}
		if len(enc) > MaxFrameBytes {
			t.Fatalf("%s: 声明为可交付的体量编码后 %d > 单帧上限 %d", name, len(enc), MaxFrameBytes)
		}
	}
}

// TestSQLResultBudgetIsFrameConsistent 钉住生产者侧（appdb 的预算）与消费者的同源性：
// 达到 limits.SQLMaxResultBytes 的结果，最坏转义后仍必须装得进一帧。
func TestSQLResultBudgetIsFrameConsistent(t *testing.T) {
	if limits.SQLMaxResultBytes != limits.MaxDeliverablePayloadBytes {
		t.Fatalf("SQLMaxResultBytes=%d 必须与 MaxDeliverablePayloadBytes=%d 同源",
			limits.SQLMaxResultBytes, limits.MaxDeliverablePayloadBytes)
	}
	if got := limits.SQLMaxResultBytes * limits.MaxJSONEscapeExpansion; got > MaxFrameBytes {
		t.Fatalf("SQL 结果预算 %d 在最坏转义后 %d 字节 > 单帧上限 %d（8 MiB 时代的同一处不自洽）",
			limits.SQLMaxResultBytes, got, MaxFrameBytes)
	}
}
