// refapp 是 WASM 应用平台的**参考实现**：一份可以整份抄走的 Go 应用骨架。
//
// 它同时承担三个角色（§4.2 / §5.5 / §9.3）：
//  1. **导入白名单的唯一来源**：cmd/picoaide-wasm-imports-gen 真编译本包
//     （GOOS=wasip1 GOARCH=wasm）后 dump 导入集，生成 wasmmod/imports_gen.go——白名单不手写；
//  2. **ABI 的活文档**：read_request → call_host ×N → write_response 三层，就是应用的全部流程；
//  3. **skill 的 examples/ 基础**：作者与 AI 直接以本文件为模板改。
//
// 它刻意是**纯 portable Go**（只用标准库）：
//   - 在 Linux 上 `go build` 直接过，可以在本机原生跑自测（不需要 wasm 运行时）；
//   - `GOOS=wasip1 GOARCH=wasm go build` 即得平台接受的应用产物（Tier 1 语言，§9.1）。
//
// 应用必须知道的六件事（§9.4 十一条的地面实现）：
//  1. 目标平台 **wasm32-wasip1**；入口是导出的 `_start`，线性内存必须导出为 `memory`；
//  2. **无状态**：实例每请求新建，全局变量存不住任何东西——所有状态都在本次请求的局部变量里；
//  3. **同一应用内所有用户共享数据**；要区分用户请自己加业务字段（宿主只注入身份，不隔离数据）；
//  4. **stdout 只用于协议帧**（RS + 十进制长度 + '\n' + JSON）；日志走 log 宿主调用。
//     本文件仍演示了一条"非帧输出"——宿主会把它当日志捕获，但那不是推荐做法；
//  5. **不能联网、不能读文件、不能开线程**；宿主能力只有封闭清单里的七个原语：
//     db.define / db.query / db.exec / db.tx / ai.chat / log / assets.read，走 stdin/stdout 的 JSON-RPC；
//  6. 宿主调用是**阻塞**的（含 ai.chat，非流式）：界面要显示等待态。
//
// ⚠️ 注意：宿主能力调用**不是 wasm 导入**（走 JSON-RPC），所以真正的 wasm 导入面只有
// Go wasip1 运行时的 WASI 符号（fd_read / fd_write / random_get / clock_time_get / …）。
// 本文件触碰 crypto/rand、time.Now、time.Sleep、os.Args、os.Environ，正是这些 WASI 面的实证来源。
package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

// protocolErrorCode 仅用于示例：把"协议层失败"（帧读不出来）与宿主返回的平台错误码区分开。
// 平台错误码见设计基线 §7.4，由宿主在 RPCError.Code 里给出。
const protocolErrorCode = "PROTOCOL"

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		// stderr 不参与帧协议：宿主只把它当诊断尾巴捕获（§4.9 StderrTailBytes）。
		fmt.Fprintf(os.Stderr, "refapp: %v\n", err)
		os.Exit(1)
	}
}

// run 是应用的全部流程，显式分三层：
//
//	第 1 层 read_request   —— 从 stdin 读**一个**请求帧；
//	第 2 层 call_host ×N   —— 每次「写一帧 JSON-RPC 请求 → 读一帧响应」；
//	第 3 层 write_response —— 写**一个**最终响应信封帧，之后不再写任何帧。
//
// 入参是 io.Reader/io.Writer 而不是直接写死 os.Stdin/os.Stdout，是为了本机原生自测时
// 可以塞进假宿主（见 main_test.go）。
func run(stdin io.Reader, stdout io.Writer) error {
	in := bufio.NewReader(stdin)
	out := bufio.NewWriter(stdout)

	// ---- 第 1 层：读请求 ----
	req, err := readRequest(in)
	if err != nil {
		// 连请求帧都没有时也要给宿主一个**合法响应帧**，否则宿主只能报 RUNTIME_NO_RESPONSE。
		_ = writeResponse(out, 500, `{"error":"refapp: 读请求帧失败"}`)
		return fmt.Errorf("读请求帧: %w", err)
	}

	// 演示：stdout 上的**非帧输出**（首字节不是 RS）——宿主按日志捕获（§7.2）。
	// 真实应用请用 log 宿主调用（下面 callHosts 里有），那样日志才有级别、条数与保留期管理。
	fmt.Fprintf(out, "refapp: start abi=%s app=%s method=%s\n", req.ABI, req.AppID, req.Method)
	if err := out.Flush(); err != nil {
		return fmt.Errorf("写演示日志: %w", err)
	}

	// ---- 第 2 层：调宿主 ----
	client := &hostClient{in: in, out: out}
	records := callHosts(client)

	// ---- 第 3 层：写最终响应 ----
	summary := responseSummary{
		ABI:       req.ABI,
		AppID:     req.AppID,
		Version:   req.Version,
		Method:    req.Method,
		Path:      req.Path,
		HostCalls: records,
		Runtime:   collectRuntimeEvidence(),
	}
	body, err := json.Marshal(summary)
	if err != nil {
		return fmt.Errorf("编码响应体: %w", err)
	}
	return writeResponse(out, 200, string(body))
}

// ===== 第 1 层：读请求 =====

// readRequest 从 stdin 读一个请求帧并解析（§7.1）。
//
// 宿主 → 应用的请求帧带完整身份（app_id/auth/user/method/path/…），
// 每一帧都是全量的 —— 实例每请求新建，身份不是会话状态。
func readRequest(in *bufio.Reader) (*abi.Request, error) {
	payload, err := readFrame(in)
	if err != nil {
		return nil, err
	}
	var req abi.Request
	if err := json.Unmarshal(payload, &req); err != nil {
		return nil, fmt.Errorf("解析请求帧: %w", err)
	}
	return &req, nil
}

// readFrame 读一个完整帧。
//
// ⚠️ 必须**一次读满**（abi.ReadFrame 内部用 io.ReadFull）：任何会预读的 JSON 流式解码器
// 都会把紧随其后的 RPC 响应帧吞掉，症状是"第二个宿主调用永远等不到响应"（§7.1 原话）。
func readFrame(in *bufio.Reader) ([]byte, error) {
	payload, err := abi.ReadFrame(in)
	if err != nil {
		if errors.Is(err, abi.ErrNotFrame) {
			return nil, fmt.Errorf("%w：stdin 上出现非帧字节（stdin 只用于接收宿主帧）", err)
		}
		return nil, err
	}
	return payload, nil
}

// ===== 第 2 层：调宿主（JSON-RPC over stdin/stdout）=====

// hostClient 封装一次「写请求帧 → 读响应帧」的往返（§7.2）。
type hostClient struct {
	in     *bufio.Reader
	out    *bufio.Writer
	nextID int64
}

// rpcResponse 是宿主回给应用的响应（读入时保留 result 的原始 JSON，便于原样回填 summary）。
type rpcResponse struct {
	JSONRPC string            `json:"jsonrpc"`
	ID      json.RawMessage   `json:"id"`
	Result  json.RawMessage   `json:"result"`
	Error   *abi.RPCErrorBody `json:"error"`
}

// call 发起一次宿主调用。
//
// 返回的 error 只表示**协议层**失败（帧写不出去 / 等不到响应 / 响应不是 JSON）；
// 宿主函数自身的失败在 *abi.RPCErrorBody 里（如 DB_DENIED / AI_BALANCE_INSUFFICIENT），
// 算不算业务失败由应用自己决定 —— 平台绝不像"失败报成成功"（§7.4 硬断言）。
func (c *hostClient) call(method string, params any) (json.RawMessage, *abi.RPCErrorBody, error) {
	c.nextID++
	id, err := json.Marshal(c.nextID)
	if err != nil {
		return nil, nil, fmt.Errorf("编码 %s 的 id: %w", method, err)
	}
	rawParams, err := json.Marshal(params)
	if err != nil {
		return nil, nil, fmt.Errorf("编码 %s 参数: %w", method, err)
	}
	payload, err := json.Marshal(abi.RPCRequest{JSONRPC: "2.0", ID: id, Method: method, Params: rawParams})
	if err != nil {
		return nil, nil, fmt.Errorf("编码 %s 请求: %w", method, err)
	}
	if err := writeFrame(c.out, payload); err != nil {
		return nil, nil, fmt.Errorf("发送 %s 请求: %w", method, err)
	}
	respPayload, err := readFrame(c.in)
	if err != nil {
		return nil, nil, fmt.Errorf("等待 %s 响应: %w", method, err)
	}
	var resp rpcResponse
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return nil, nil, fmt.Errorf("解析 %s 响应: %w", method, err)
	}
	if resp.Error != nil {
		return nil, resp.Error, nil
	}
	return resp.Result, nil, nil
}

// callRecord 是一条宿主调用的结果记录（回填进最终响应，便于作者与 AI 排查"哪一步失败了"）。
type callRecord struct {
	Method string            `json:"method"`
	OK     bool              `json:"ok"`
	Result json.RawMessage   `json:"result,omitempty"`
	Error  *abi.RPCErrorBody `json:"error,omitempty"`
}

// record 调一次宿主方法并把结果记成一条 callRecord（协议层失败也记，不中断流程）。
func (c *hostClient) record(method string, params any) callRecord {
	result, rpcErr, err := c.call(method, params)
	switch {
	case err != nil:
		return callRecord{Method: method, Error: &abi.RPCErrorBody{Code: protocolErrorCode, Message: err.Error()}}
	case rpcErr != nil:
		return callRecord{Method: method, Error: rpcErr}
	default:
		return callRecord{Method: method, OK: true, Result: result}
	}
}

// callHosts 依次调用**全部**宿主方法（abi.HostMethods 的封闭清单，§5.1）。
//
// 顺序即 §5.1 的文档顺序；两个事务各演示一条出口：
//   - tx#1 = begin → db.exec（写）→ db.query（读，能看到本事务未提交的写）→ tx_commit；
//   - tx#2 = begin → db.exec（写一份随后被丢弃的数据）→ tx_rollback。
//
// ⚠️ 为什么事务体里**必须有真实 SQL**：`db.tx` 的语义就是"事务内的数据库读写"，
// 事务内只允许 db.query / db.exec（+ 两个出口），ai.chat / log / assets.read /
// db.define / 嵌套 tx_begin 一律被拒（§4.4 的意图是防长期持锁与占执行槽）。
// 早先的样例写的是"begin 完立刻 commit"（事务体零 SQL），于是"事务内 SQL 全被拒"
// 这个缺陷在样例与作者文档里都看不出来（模块 H 审计 P0-1）—— 别再把事务写空。
//
// 宿主能力**不是 wasm 导入**：它们在 stdout 上是 JSON-RPC 请求帧，在 stdin 上是响应帧。
func callHosts(c *hostClient) []callRecord {
	records := make([]callRecord, 0, len(abi.HostMethods)+1)

	// db.define：声明表结构（DDL 只允许平台代执行，应用写不出 CREATE TABLE）。
	// 必须在事务外：db.define 是 DDL，事务内被拒。
	records = append(records, c.record(abi.MethodDBDefine, abi.DBDefineParams{
		Table: "notes",
		Columns: []abi.ColumnDef{
			{Name: "title", Type: "text"},
			{Name: "body", Type: "text"},
		},
	}))

	// db.tx 的第一条出口：begin → 写 → 读 → commit。
	// db.exec / db.query 在事务内是**允许**的（只做数据库读写），这才是 db.tx 的用法。
	begin := c.record(abi.MethodTxBegin, abi.TxParams{})
	records = append(records, begin)
	records = append(records, c.record(abi.MethodDBExec, abi.SQLParams{
		SQL:  "INSERT INTO notes (title, body) VALUES (?, ?)",
		Args: []any{"第一条", "hello picoaide"},
	}))
	records = append(records, c.record(abi.MethodDBQuery, abi.SQLParams{
		SQL:  "SELECT title FROM notes",
		Args: []any{},
	}))
	records = append(records, c.record(abi.MethodTxCommit, abi.TxParams{TxID: txIDOf(begin)}))

	// db.tx 的第二条出口：begin → 写 → rollback（这一条 INSERT 不会生效）。
	begin = c.record(abi.MethodTxBegin, abi.TxParams{})
	records = append(records, begin)
	records = append(records, c.record(abi.MethodDBExec, abi.SQLParams{
		SQL:  "INSERT INTO notes (title, body) VALUES (?, ?)",
		Args: []any{"会被回滚", "rollback 演示"},
	}))
	records = append(records, c.record(abi.MethodTxRollback, abi.TxParams{TxID: txIDOf(begin)}))

	// ai.chat：用**当前使用者**的身份与额度调平台既有 /v1 网关（密钥永不出服务端，§4.7）。
	// 非流式、阻塞；余额不足是 AI_BALANCE_INSUFFICIENT，限流是 AI_RATE_LIMITED。
	// 必须在事务外（事务内禁止会阻塞的能力，§4.4）。
	records = append(records, c.record(abi.MethodAIChat, abi.AIChatParams{
		Messages: []abi.ChatMessage{
			{Role: "user", Content: "用一句话说明这个应用在做什么。"},
		},
	}))

	// log：应用日志（单条 ≤ 4 KiB、每请求 ≤ 100 条，超出丢弃并计数）。同样在事务外。
	records = append(records, c.record(abi.MethodLog, abi.LogParams{
		Level:   "info",
		Message: "refapp 参考实现跑通了全部宿主调用",
	}))

	// assets.read：读随包静态资源（发布期从 wasm 自定义段抽出来的 picoaide.app.json）。
	records = append(records, c.record(abi.MethodAssetsRead, abi.AssetsReadParams{
		Path: "picoaide.app.json",
	}))

	return records
}

// txIDOf 从 tx_begin 的结果里取事务号（拿不到就返回 0，宿主会按"无事务"报错——错误可见好过静默）。
func txIDOf(rec callRecord) int64 {
	if len(rec.Result) == 0 {
		return 0
	}
	var res abi.TxResult
	if err := json.Unmarshal(rec.Result, &res); err != nil {
		return 0
	}
	return res.TxID
}

// ===== 第 3 层：写响应 =====

// writeResponse 写最终响应信封帧（§7.2）。写完这一帧后不得再写任何帧。
//
// Content-Type 必须在平台允许的集合内（§4.8）；Cookie 由宿主独占，应用设不了。
func writeResponse(out *bufio.Writer, status int, body string) error {
	env := abi.Response{
		Status:  status,
		Headers: map[string]string{"Content-Type": "application/json; charset=utf-8"},
		Body:    body,
	}
	payload, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("编码响应信封: %w", err)
	}
	return writeFrame(out, payload)
}

// writeFrame 用**规范实现**（abi.WriteFrame）写一帧，并立刻 Flush。
//
// ⚠️ 不 Flush 就是死锁：宿主正等着读这一帧，而它还躺在 bufio 缓冲里。
// 写帧只允许有一个实现（abi.WriteFrame）——曾经有一版参考实现为了绕开 abi.WriteFrame
// 丢魔数的 bug 而改走 EncodeFrame，那是临时规避，bug 修好后必须回到规范路径：
// 否则"参考实现能用、别人不能用"的偏差会一直藏在样例里（详见 abi.go 的历史注释）。
func writeFrame(out *bufio.Writer, payload []byte) error {
	if err := abi.WriteFrame(out, payload); err != nil {
		return err
	}
	return out.Flush()
}

// ===== WASI 面（导入白名单的实证来源，§10.2 第 21/22/23 项）=====

// responseSummary 是回给宿主的响应体：把"这一轮做了什么"结构化回传。
// 对作者是示例（响应体就是应用的界面数据源），对平台是取证载体。
type responseSummary struct {
	ABI       string          `json:"abi"`
	AppID     string          `json:"app_id"`
	Version   string          `json:"version"`
	Method    string          `json:"method"`
	Path      string          `json:"path"`
	HostCalls []callRecord    `json:"host_calls"`
	Runtime   runtimeEvidence `json:"runtime"`
}

// runtimeEvidence 是"平台必须显式注入的四项"的取证（§15.1 第 1 条）：
//
//	RandomHex — crypto/rand → random_get：平台注入 rand.Reader；
//	            默认实现是**固定种子 42 的确定性伪随机**，两次独立实例会给出同一串（§10.2 第 21 项）；
//	NowUnix   — time.Now → clock_time_get：平台注入真实墙钟（默认是 2022-01-01 的假时钟）；
//	SleptMS   — time.Sleep → poll_oneoff / nanosleep；
//	ArgsCount / EnvCount — os.Args / os.Environ → args_get / environ_get：
//	            平台**不传 args、不传任何 env**，所以线上这两个值必须是 0（§10.2 第 23 项）。
type runtimeEvidence struct {
	RandomHex string `json:"random_hex"`
	NowUnix   int64  `json:"now_unix"`
	SleptMS   int64  `json:"slept_ms"`
	ArgsCount int    `json:"args_count"`
	EnvCount  int    `json:"env_count"`
}

// collectRuntimeEvidence 触碰 WASI 面并回报结果。保持 1 ms 睡眠：干跑预算只有 2 s（§4.2）。
func collectRuntimeEvidence() runtimeEvidence {
	var buf [8]byte
	_, _ = rand.Read(buf[:]) // random_get
	now := time.Now()        // clock_time_get
	start := time.Now()
	time.Sleep(time.Millisecond) // poll_oneoff / nanosleep
	return runtimeEvidence{
		RandomHex: hex.EncodeToString(buf[:]),
		NowUnix:   now.Unix(),
		SleptMS:   time.Since(start).Milliseconds(),
		ArgsCount: len(os.Args),      // args_get：线上必须为 0
		EnvCount:  len(os.Environ()), // environ_get：线上必须为 0
	}
}
