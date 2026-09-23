// A-1（2026-09-23 R3-A 审计，P1）在 **runtime 层**的回归门禁。
//
// abi 的用例钉的是"编码出来的字节不超帧"，本文件钉的是**宿主真的写出去的东西**：
// 走真管道、真 `abi.WriteFrame`/`ReadFrame` 往返，并覆盖宿主 → guest 的**两条**返回路径
// （§7.1 请求信封、§7.2 RPC 应答）。
//
// 枚举（本包内 host→guest 的全部返回路径，`abi.WriteFrame` 只有一处调用点，
// 由 TestHostToGuestFramesHaveOneWritePath 从源码层钉住）：
//  1. `Serve` 的请求信封（`abi.Request` → 一帧）—— 超限**按预算拒绝**（BODY_TOO_LARGE 413，
//     调用方拿到可行动错误），不实例化、不写超帧；
//  2. `writeRPC` 的 RPC 应答（全部宿主能力的结果 + 宿主错误信封）—— 超限由 abi 归一成
//     "截断的 QueryResult（truncated=true）"或结构化错误（DB_LIMIT / ASSET_OVERSIZE /
//     RESULT_TOO_LARGE），**永不**写超帧。
package runtime

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
)

// bigQueryHost 是返回**超大 db.query 结果**的假宿主能力面（A-1 的现场形态）。
type bigQueryHost struct {
	result abi.QueryResult
}

func (h *bigQueryHost) Dispatch(_ context.Context, method string, _ json.RawMessage) (any, *apperr.Error) {
	switch method {
	case abi.MethodDBQuery:
		return h.result, nil
	case abi.MethodLog:
		return abi.LogResult{Accepted: 1}, nil
	default:
		return map[string]any{"method": method}, nil
	}
}

// writeRPCThroughPipe 用真管道跑一次 writeRPC，返回 guest 侧读到的第一帧。
//
// 判据的关键：修复前这里 `abi.ReadFrame` 会返回 `ErrFrameTooLarge`（宿主写出了超帧），
// 修复后必须读到一条合法负载。
func writeRPCThroughPipe(t *testing.T, resp abi.RPCResponse) []byte {
	t.Helper()
	pr, pw := io.Pipe()
	gw := &guestWriter{w: pw}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = (&Runtime{}).writeRPC(context.Background(), gw, resp)
		_ = pw.Close()
	}()
	payload, err := abi.ReadFrame(bufio.NewReader(pr))
	if err != nil {
		t.Fatalf("guest 侧读帧失败（宿主写出了超帧或畸形帧）：%v", err)
	}
	<-done
	if len(payload) > abi.MaxFrameBytes {
		t.Fatalf("宿主写出的帧 %d 字节超过单帧上限 %d", len(payload), abi.MaxFrameBytes)
	}
	return payload
}

// wireFrame 是应答的线格式（Result 取 RawMessage 再二次解码成具体类型）。
type wireFrame struct {
	JSONRPC string            `json:"jsonrpc"`
	ID      json.RawMessage   `json:"id"`
	Result  json.RawMessage   `json:"result"`
	Error   *abi.RPCErrorBody `json:"error"`
}

// TestWriteRPCOversizeQueryResultFitsInOneFrame 覆盖路径 ② 的"多行结果"形态：
// 1.5 MiB 的 db.query 结果必须裁到帧内送达（truncated=true，行是前缀），
// 而不是写出超帧让 guest 拿到传输错误 / 一直等到预算耗尽。
func TestWriteRPCOversizeQueryResultFitsInOneFrame(t *testing.T) {
	const rows = 1500
	q := abi.QueryResult{Columns: []string{"body"}}
	for i := 0; i < rows; i++ {
		q.Rows = append(q.Rows, []any{strings.Repeat("a", 1024)})
	}
	payload := writeRPCThroughPipe(t, abi.NewRPCResult(json.RawMessage(`9`), q))

	var f wireFrame
	if err := json.Unmarshal(payload, &f); err != nil {
		t.Fatalf("帧不是合法应答：%v", err)
	}
	if f.Error != nil {
		t.Fatalf("有截断这条出路，不该退化成正错误：code=%s", f.Error.Code)
	}
	var got abi.QueryResult
	if err := json.Unmarshal(f.Result, &got); err != nil {
		t.Fatalf("result 不是 QueryResult：%v", err)
	}
	if !got.Truncated || len(got.Rows) == 0 || len(got.Rows) >= rows {
		t.Fatalf("应裁到帧内并置 truncated：truncated=%v rows=%d/%d", got.Truncated, len(got.Rows), rows)
	}
	if string(f.ID) != "9" {
		t.Fatalf("id 必须保留（guest 靠它配对），实得 %s", f.ID)
	}
}

// TestWriteRPCSingleOversizeRowBecomesDBLimit 覆盖路径 ② 的"单行超帧"形态：
// 一行都留不下时必须是结构化 **DB_LIMIT**（可行动：分页/减少列数），
// 不能静默回一个空结果，也不能写超帧。
func TestWriteRPCSingleOversizeRowBecomesDBLimit(t *testing.T) {
	q := abi.QueryResult{Columns: []string{"blob"}, Rows: [][]any{{strings.Repeat("x", 2<<20)}}}
	payload := writeRPCThroughPipe(t, abi.NewRPCResult(json.RawMessage(`10`), q))

	var f wireFrame
	if err := json.Unmarshal(payload, &f); err != nil {
		t.Fatalf("帧不是合法应答：%v", err)
	}
	if f.Error == nil || f.Error.Code != abi.CodeDBLimit {
		t.Fatalf("应回 DB_LIMIT，实得 code=%v（result 长度 %d）", f.Error, len(f.Result))
	}
	if !strings.Contains(f.Error.Message, "分页") {
		t.Fatalf("DB_LIMIT 文案必须可行动（分页指引），实得 %q", f.Error.Message)
	}
	if got, _ := f.Error.Details["encoded_bytes"].(float64); int(got) <= abi.MaxFrameBytes {
		t.Fatalf("details.encoded_bytes = %v 应记录**超限前**的体量", f.Error.Details["encoded_bytes"])
	}
}

// TestWriteRPCNormalResultUnchanged 是**反向对照**（防过度修复）：
// 装得下的小结果必须一字不改地送达（截断/改写只是超限路径的事）。
func TestWriteRPCNormalResultUnchanged(t *testing.T) {
	q := abi.QueryResult{Columns: []string{"n"}, Rows: [][]any{{int64(1)}, {int64(2)}}}
	payload := writeRPCThroughPipe(t, abi.NewRPCResult(json.RawMessage(`1`), q))
	want, _ := json.Marshal(abi.NewRPCResult(json.RawMessage(`1`), q))
	if string(payload) != string(want) {
		t.Fatalf("小结果不得被改写：\n got=%s\nwant=%s", payload, want)
	}
}

// TestServeRejectsOversizeRequestEnvelope 覆盖路径 ①：
// 请求信封（含 JSON 转义）装不进一帧时，必须**在实例化之前**按预算拒绝，
// 给调用方可行动的 413 BODY_TOO_LARGE —— 而不是把超帧写进 stdin 让应用"什么都没收到、
// 等到预算耗尽"，现场只看到 RUNTIME_TIMEOUT。
func TestServeRejectsOversizeRequestEnvelope(t *testing.T) {
	req := testRequest("/echo", newFakeHost())
	// 200 KiB 的 `<`：原始远小于请求体上限（1 MiB），但 JSON 转义后 ≈1.2 MiB > 单帧。
	req.Envelope.Body = strings.Repeat("<", 200<<10)

	res, err := sharedRuntime(t).Serve(context.Background(), appModule(t), req)
	if err != nil {
		t.Fatalf("Serve 返回装配错误: %v", err)
	}
	if res.KillReason == nil {
		t.Fatal("超帧请求信封必须被拒（修复前这里会一路写进 guest）")
	}
	if res.KillReason.Code != apperr.CodeBodyTooLarge {
		t.Fatalf("code = %s, want BODY_TOO_LARGE", res.KillReason.Code)
	}
	if got := res.KillReason.Status(); got != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", got)
	}
	if len(res.KillReason.Hints) == 0 {
		t.Fatal("必须带可行动 hints（第一消费者是 AI）")
	}
	frameBytes, _ := res.KillReason.Details["frame_bytes"].(int)
	if frameBytes <= abi.MaxFrameBytes {
		t.Fatalf("details.frame_bytes = %v 应记录超限后的真实体量（> %d）", res.KillReason.Details["frame_bytes"], abi.MaxFrameBytes)
	}
	// 反向对照：同样形态的小请求必须照旧成功（不是"大 body 一律拒"）。
	ok := testRequest("/echo", newFakeHost())
	ok.Envelope.Body = strings.Repeat("<", 4<<10)
	res2, err := sharedRuntime(t).Serve(context.Background(), appModule(t), ok)
	if err != nil {
		t.Fatalf("Serve 返回装配错误: %v", err)
	}
	if res2.KillReason != nil {
		t.Fatalf("4 KiB 的请求体必须照旧成功，实得 %s", res2.KillReason.Code)
	}
}

// TestHostToGuestFramesHaveOneWritePath 是"枚举清单"的源码级守卫：
// 宿主 → guest 的帧只允许从 `guestWriter.writeFrame` 一个出口写出（`abi.WriteFrame`
// 在本包内唯一调用点）。新增第二条写入路径（绕过单帧闸门）会让本用例红。
func TestHostToGuestFramesHaveOneWritePath(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("读包目录失败: %v", err)
	}
	hits := map[string]int{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		src, rerr := os.ReadFile(filepath.Clean(name))
		if rerr != nil {
			t.Fatalf("读 %s 失败: %v", name, rerr)
		}
		text := string(src)
		for _, marker := range []string{"abi.WriteFrame" + "(", "abi.EncodeFrame" + "("} {
			hits[name] += strings.Count(text, marker)
		}
	}
	total := 0
	for _, n := range hits {
		total += n
	}
	if total != 1 || hits["runtime.go"] != 1 {
		t.Fatalf("宿主 → guest 的帧写入点必须恰好一处（guestWriter.writeFrame @ runtime.go），实得 %v", hits)
	}
}
