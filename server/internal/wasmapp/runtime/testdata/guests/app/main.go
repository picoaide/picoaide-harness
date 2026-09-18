// Command app 是 runtime 测试用的**最小应用**：自实现 §7 帧协议（读请求帧 → 调宿主
// 函数 → 写响应帧），行为按请求路径分派。
//
// 为什么自己实现帧协议而不 import 服务端的 abi 包：这是"应用侧"代码，必须站在
// 应用作者的位置验证契约（应用只会拿到 skill 里的样板，不会拿到平台的内部包）。
//
// 构建：GOOS=wasip1 GOARCH=wasm go build -o app.wasm ./app（见 runtime 包的测试助手）。
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

const frameMagic = 0x1e

// stdinReader 是**唯一**的 stdin 读取器（§7.1：长度前缀 + 一次读满，不得预读后丢弃）。
// 每帧新建 bufio.Reader 是错的：预读到的后续帧字节会随旧 reader 一起被丢掉。
var stdinReader = bufio.NewReader(os.Stdin)

// sink 防止分配被优化掉。
var sink []byte

type request struct {
	ABI    string `json:"abi"`
	AppID  string `json:"app_id"`
	Method string `json:"method"`
	Path   string `json:"path"`
	Body   string `json:"body"`
	User   *struct {
		ID       int64  `json:"id"`
		Username string `json:"username"`
	} `json:"user"`
}

type rpcError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func main() {
	payload, err := readFrame(stdinReader)
	if err != nil {
		fmt.Fprintf(os.Stderr, "read request frame: %v\n", err)
		os.Exit(3)
	}
	var req request
	if err := json.Unmarshal(payload, &req); err != nil {
		fmt.Fprintf(os.Stderr, "bad request json: %v\n", err)
		os.Exit(3)
	}

	path, query := splitQuery(req.Path)
	switch path {
	case "/ok":
		doOK(req)
	case "/echo":
		respond(200, map[string]any{"echo": req.Body, "user": req.User, "abi": req.ABI, "app": req.AppID})
	case "/logs":
		doLogs(req)
	case "/hostblock":
		// 调一个会超预算的宿主方法，然后**无视错误**照常返回 200：
		// 宿主侧必须仍然把它变成失败（§7.4 硬断言 / §10.3 第 26 项）。
		_, code := call("db.query", map[string]any{"sql": "SELECT 1"})
		respond(200, map[string]any{"ignored_host_error": code})
	case "/hostpanic":
		_, code := call("ai.chat", map[string]any{"messages": []any{}})
		respond(200, map[string]any{"host_error": code})
	case "/rpcerr":
		_, code := call("db.exec", map[string]any{"sql": "DROP TABLE t"})
		respond(200, map[string]any{"host_error": code})
	case "/unknownmethod":
		_, code := call("net.fetch", map[string]any{"url": "https://example.invalid"})
		respond(200, map[string]any{"host_error": code})
	case "/paused":
		doPaused(req)
	case "/sleep":
		// time.Sleep(ms) 后返回 200：WASI 侧对应 poll_oneoff/usleep。
		// 判据必须是**CPU 时间**（Go 的 wasip1 等待是忙等循环 ⇒ 假睡眠的墙钟不变、CPU 爆掉），
		// 见 TestServe_NanosleepDoesNotBurnCPU。
		ms := queryInt(query, "ms", 300)
		time.Sleep(time.Duration(ms) * time.Millisecond)
		respond(200, map[string]any{"slept_ms": ms})
	case "/respond-spin":
		// 先写**合法最终响应帧**，再自旋 ms 毫秒（可远超 guest 预算）：
		// 判据是"收到响应帧即结论已定"—— 立即按该响应返回成功，不等 guest 退出。
		respond(200, map[string]any{"spin_ok": true})
		spinMS(query, 5000)
	case "/timeout":
		busyForever()
	case "/recurse":
		recurse(0)
	case "/alloc":
		doAlloc(query)
	case "/exit":
		code, _ := strconv.Atoi(query["code"])
		if code == 0 {
			code = 7
		}
		os.Exit(code)
	case "/silent":
		// 什么都不写就正常退出：宿主必须报 RUNTIME_NO_RESPONSE（绝不 200）。
		return
	case "/spam":
		// 单行都合法（1 KiB），但**总量**超过总输出上限：触发总输出方向的
		// RUNTIME_OUTPUT_OVERRUN（与 /flood 的单行方向是两条代码路径）。
		line := make([]byte, 1024)
		for i := range line {
			line[i] = 'B'
		}
		line[len(line)-1] = '\n'
		for i := 0; i < 9*1024; i++ {
			if _, err := os.Stdout.Write(line); err != nil {
				fmt.Fprintf(os.Stderr, "spam write stopped: %v\n", err)
				return
			}
		}
	case "/bigframe":
		// 响应帧本身超过单帧上限（1 MiB）：ReadFrame 侧报 ErrFrameTooLarge。
		big := strings.Repeat("C", 2<<20)
		respond(200, map[string]any{"big": big})
	case "/flood":
		// 非帧起始、且单行远超 1 MiB：RUNTIME_OUTPUT_OVERRUN。
		buf := make([]byte, 2<<20)
		for i := range buf {
			buf[i] = 'A'
		}
		_, _ = os.Stdout.Write(buf)
	case "/readmore":
		// 读第二帧（宿主不会再写）：验证"卡在 fd_read 的 guest 也能被预算收掉"。
		_, _ = readFrame(stdinReader)
	case "/stderr":
		writeStderr()
		respond(200, map[string]any{"stderr": "written"})
	default:
		respond(404, map[string]any{"error": "unknown path", "path": req.Path})
	}
}

func doOK(req request) {
	logRes, logCode := call("log", map[string]any{"level": "info", "message": "hello from app"})
	dbRes, dbCode := call("db.query", map[string]any{"sql": "SELECT 1", "args": []any{}})
	body := map[string]any{
		"log_code": logCode,
		"db_code":  dbCode,
		"log":      rawString(logRes),
		"db":       rawString(dbRes),
		"username": username(req),
	}
	respond(200, body)
}

func doLogs(req request) {
	fmt.Println("plain stdout line 1")
	fmt.Println("plain stdout line 2")
	os.Stderr.WriteString("this is stderr\n")
	_, code := call("log", map[string]any{"level": "warn", "message": "after logs"})
	respond(200, map[string]any{"log_code": code})
}

func doPaused(req request) {
	// 宿主睡 400ms（guest 计时必须被暂停），随后 guest 自己再忙 400ms。
	// GuestBudget=600ms 时，只有"暂停计时"成立才会成功；否则必然 RUNTIME_TIMEOUT。
	call("log", map[string]any{"level": "info", "message": "sleep"})
	deadline := nowMS() + 400
	for nowMS() < deadline {
	}
	respond(200, map[string]any{"paused": true})
}

func doAlloc(query map[string]string) {
	mib := 24
	if v, err := strconv.Atoi(query["mib"]); err == nil && v > 0 {
		mib = v
	}
	sink = make([]byte, mib<<20)
	for i := 0; i < len(sink); i += 4096 {
		sink[i] = byte(i)
	}
	fmt.Fprintf(os.Stderr, "allocated %d bytes\n", len(sink))
	respond(200, map[string]any{"allocated": len(sink)})
}

func writeStderr() {
	marker := strings.Repeat("x", 512)
	for i := 0; i < 12; i++ {
		fmt.Fprintf(os.Stderr, "[stderr-%02d]%s\n", i, marker)
	}
}

func busyForever() {
	for {
	}
}

// spinMS 自旋 ms 毫秒（纯 CPU 忙等，不调宿主、不看时间以外的任何东西）。
//
// 为什么用自旋而不是 time.Sleep 来测"响应帧之后不退出"：Sleep 会让出时间片、可能被
// 预算时钟的关闭路径提前结束，判据不干净；自旋是"应用赖着不走"的最强形态。
func spinMS(query map[string]string, def int) {
	ms := queryInt(query, "ms", def)
	deadline := nowMS() + int64(ms)
	for nowMS() < deadline {
	}
}

// queryInt 取查询参数里的整数，缺省或非法时用 def。
func queryInt(query map[string]string, key string, def int) int {
	if v, err := strconv.Atoi(query[key]); err == nil {
		return v
	}
	return def
}

func recurse(n int) int {
	if n < 0 {
		return 0
	}
	return recurse(n+1) + 1
}

func username(req request) string {
	if req.User == nil {
		return ""
	}
	return req.User.Username
}

// ===== 帧协议（§7.1/§7.2）=====

func readFrame(br *bufio.Reader) ([]byte, error) {
	first, err := br.ReadByte()
	if err != nil {
		return nil, err
	}
	if first != frameMagic {
		return nil, fmt.Errorf("not a frame (first byte %#x)", first)
	}
	var digits []byte
	for {
		b, err := br.ReadByte()
		if err != nil {
			return nil, err
		}
		if b == '\n' {
			break
		}
		digits = append(digits, b)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return nil, err
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(br, buf); err != nil {
		return nil, err
	}
	return buf, nil
}

func writeFrame(w io.Writer, payload []byte) error {
	hdr := []byte{frameMagic}
	hdr = strconv.AppendInt(hdr, int64(len(payload)), 10)
	hdr = append(hdr, '\n')
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result"`
	Error   *rpcError       `json:"error"`
}

var rpcID int

// call 发一条 JSON-RPC 请求并读回应答，返回 (result JSON, 错误码)。
func call(method string, params any) (json.RawMessage, string) {
	rpcID++
	p, _ := json.Marshal(params)
	req := map[string]any{"jsonrpc": "2.0", "id": rpcID, "method": method, "params": json.RawMessage(p)}
	payload, _ := json.Marshal(req)
	if err := writeFrame(os.Stdout, payload); err != nil {
		return nil, "WRITE_FAILED"
	}
	respPayload, err := readFrame(stdinReader)
	if err != nil {
		return nil, "READ_FAILED"
	}
	var resp rpcResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return nil, "BAD_RESPONSE"
	}
	if resp.Error != nil {
		return nil, resp.Error.Code
	}
	return resp.Result, ""
}

func respond(status int, body any) {
	b, _ := json.Marshal(body)
	payload, _ := json.Marshal(map[string]any{
		"status":  status,
		"headers": map[string]string{"content-type": "application/json"},
		"body":    string(b),
	})
	if err := writeFrame(os.Stdout, payload); err != nil {
		fmt.Fprintf(os.Stderr, "write response frame: %v\n", err)
		os.Exit(4)
	}
}

func rawString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	return string(raw)
}

func nowMS() int64 { return time.Now().UnixMilli() }

func splitQuery(path string) (string, map[string]string) {
	query := map[string]string{}
	i := strings.IndexByte(path, '?')
	if i < 0 {
		return path, query
	}
	for _, kv := range strings.Split(path[i+1:], "&") {
		if kv == "" {
			continue
		}
		k, v, _ := strings.Cut(kv, "=")
		query[k] = v
	}
	return path[:i], query
}
