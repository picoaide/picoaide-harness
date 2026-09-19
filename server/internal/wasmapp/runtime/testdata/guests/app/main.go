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
	case "/alloc-chunks":
		// 分块累积分配（每块 1 MiB、保留引用）：与 /alloc 的"一次性巨块"是**两种真实形态**。
		// 判据（R1-e2e-1）：一次性巨块的 grow 请求一步就越限 ⇒ 线性内存停在初始大小，
		// 宿主看不到"贴近上限"的证据；分块累积会一路涨到上限才失败 ⇒ 峰值 = 上限
		//（这正是现场 `hog?mb=80` 的形态：诊断里 peak_memory_bytes=67108864=上限）。
		doAllocChunks(query)
	case "/exit":
		code, _ := strconv.Atoi(query["code"])
		if code == 0 {
			code = 7
		}
		os.Exit(code)
	case "/stderr-then-alloc":
		// 第三轮审计 P2-1 的行为级护栏：先往 stderr 写 noise 字节**普通日志**，再做
		// 一次性巨块分配（真 Go 运行时 OOM ⇒ proc_exit(2)）。
		//
		// 旧实现的判据绑在"stderr 开头 2 KiB 窗口"上：应用在 OOM 前打 ≥ ~2 KiB 日志就把
		// 运行时的特征行挤出窗口 ⇒ 退回 RUNTIME_GUEST_EXIT（hints 把作者引向 os.Exit，
		// 方向错）。改成滚动匹配后，noise 取多少都必须仍是 RUNTIME_MEMORY。
		noise := queryInt(query, "noise", 0)
		if noise > 0 {
			blob := make([]byte, noise)
			for i := range blob {
				blob[i] = 'L'
			}
			blob[len(blob)-1] = '\n' // 噪声结束在行尾（运行时的输出从行首开始）
			if _, err := os.Stderr.Write(blob); err != nil {
				os.Exit(9)
			}
		}
		doAlloc(query)
	case "/panic-oom":
		// 第三轮审计 P2-2 的行为级护栏：普通 panic，消息里**恰好含** "out of memory"
		// （非恶意：包装一句上游错误串是常见写法）。未 recover 的 panic 与运行时 OOM
		// **共用退出码 2**，所以判据只能是"运行时形态的特征行"而不是裸子串 ——
		// 这一档必须仍是 RUNTIME_GUEST_EXIT。
		panic("tool failed: upstream returned: out of memory while reading resultset")
	case "/forge-oom":
		// 伪造形态（审计探针）：打印**裸的** "out of memory" 再 os.Exit(2)。
		// 旧判据（子串命中）会把它归成 RUNTIME_MEMORY；收紧到运行时前缀后它必须仍是
		// GUEST_EXIT。⚠️ 逐字打印运行时那一行仍然可以伪造成功（guest 控制 stderr，
		// wazero 没有宿主侧分配失败回调）—— 这条边界在 errors.go 的 stderrOOMEvidence
		// 注释里如实记着，不在本用例的断言范围内。
		fmt.Fprintf(os.Stderr, "out of memory\n")
		os.Exit(2)
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
		writeOversizedFrame()
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

// doAllocChunks 按 1 MiB 一块累积分配（每块都保留引用 ⇒ 线性内存只能一路增长）。
//
// 与 doAlloc 的区别就是"grow 的粒度"：Go 的 wasip1 运行时按需向 wasm 申请内存，
// 一次性巨块会让**单次** grow 越限而立刻失败（内存停在初始页数），分块则是一路涨到
// 上限、下一次 grow 才失败（内存停在**上限**）。
func doAllocChunks(query map[string]string) {
	mib := 200
	if v, err := strconv.Atoi(query["mib"]); err == nil && v > 0 {
		mib = v
	}
	chunks := make([][]byte, 0, mib)
	for i := 0; i < mib; i++ {
		chunk := make([]byte, 1<<20)
		for j := 0; j < len(chunk); j += 4096 {
			chunk[j] = byte(i)
		}
		chunks = append(chunks, chunk)
	}
	sink = chunks[len(chunks)-1]
	fmt.Fprintf(os.Stderr, "allocated %d chunks\n", len(chunks))
	respond(200, map[string]any{"allocated_mib": len(chunks)})
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

// writeOversizedFrame 写一个**声明长度超过单帧上限**的响应帧（§4.6：单帧 1 MiB）：
// 形状与 respond 一致（同一个响应信封的 JSON 文本），但**先写帧头、再分块流式写载荷**，
// 不把整帧物化到内存里。
//
// ⚠️ 为什么必须流式（2026-09-19 缺陷定位，见 docs/AUDIT-2026-09-19-WASM-FRAME-LIMIT.md）：
// "strings.Repeat 造 2 MiB 字符串 + 两次 json.Marshal"在 wasm 里要烧 **1.4–2.4 s** 的
// guest CPU（实测 inner 0.9–1.2 s、outer 1.1–1.2 s），而这条用例的 guest 预算是**墙钟**
// 3 s（见 testRequest）⇒ 机器一有负载，guest 光"造帧"就把预算烧完，宿主的单帧判据
// 根本来不及被触发，结论被洗成 RUNTIME_TIMEOUT（现场必现，见该报告的复现命令）。
//
// 判据在宿主的 abi.ReadFrame：读到长度前缀 n > 1 MiB 立即返回 ErrFrameTooLarge
// （pump ⇒ RUNTIME_OUTPUT_OVERRUN），**不会读载荷** ⇒ 这里载荷写多少都不影响结论；
// 写失败（管道已被宿主关闭）是预期结局，不报错、不退出。
func writeOversizedFrame() {
	const (
		total = 2 << 20
		// 与 respond 的信封逐字节同形：body 是内层 JSON 的**转义后**文本。
		head = `{"status":200,"headers":{"content-type":"application/json"},"body":"{\"big\":\"`
		tail = `\"}"}`
	)
	hdr := []byte{frameMagic}
	hdr = strconv.AppendInt(hdr, int64(total), 10)
	hdr = append(hdr, '\n')
	if _, err := os.Stdout.Write(hdr); err != nil {
		return
	}
	if _, err := os.Stdout.Write([]byte(head)); err != nil {
		return
	}
	chunk := make([]byte, 64<<10)
	for i := range chunk {
		chunk[i] = 'C'
	}
	for pad := total - len(head) - len(tail); pad > 0; {
		n := len(chunk)
		if pad < n {
			n = pad
		}
		if _, err := os.Stdout.Write(chunk[:n]); err != nil {
			return
		}
		pad -= n
	}
	_, _ = os.Stdout.Write([]byte(tail))
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
