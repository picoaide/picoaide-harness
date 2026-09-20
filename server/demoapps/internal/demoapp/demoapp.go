// Package demoapp 是内置演示应用（`server/demoapps/*`）共用的**运行时底座**。
//
// 它只做三件事，每件都只允许有一份实现：
//
//  1. **协议**：读一个请求帧（`RS` + 十进制长度 + `\n` + JSON）、写回响应帧。
//     帧格式与判别规则的事实标准在 `internal/wasmapp/abi`，这里不重新定义，
//     只把它包成"一次请求一个 App 对象"的形状。
//  2. **宿主能力**：`db.define/db.query/db.exec/db.tx/log/assets.read` 的类型化包装。
//     参数与结果 JSON 直接复用 `abi` 的结构体，**不手抄字段名** —— 抄一遍就会在
//     平台改字段时静默失配（症状是应用一直等响应直到 RUNTIME_TIMEOUT）。
//  3. **前端与后端的接缝**：静态前端资源由**宿主**按路径直出（`/static/*` 不经过
//     wasm），只有入口 `/` 与 `/api/*` 会到这里。因此本包提供
//     `EntryHTML()`（读包内 index.html）与 `JSON()` / `Fail()`（统一错误信封）。
//
// 演示应用的职责是"照着文档长"，所以这里连**错误信封的形状**也照平台那一份写：
// `{"error":{"code","message"}}`（与 `/v1/*`、`/api/*` 同一个信封）。
//
// @module demoapp
package demoapp

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

// nowMicros 是单调时钟读数（微秒），只用来算"这一跳花了多久"。
//
// 单独抽出来是为了让 `time` 的 import 只出现一次，也让"演示里的耗时数字确实来自
// 计时器"这件事在代码里看得见（不是编出来的数字）。
func nowMicros() int64 { return time.Since(bootAt).Microseconds() }

// bootAt 是进程内的计时基准（每次请求都是新实例，所以基准就是本请求开始附近）。
var bootAt = time.Now()

/** 应用配置文件在包内的逻辑路径（平台保留资源，永不被宿主直出）。 */
const AppConfigPath = "picoaide.app.json"

/** 入口 HTML 在包内的逻辑路径（由 {@link App.EntryHTML} 读出，不交给宿主直出）。 */
const EntryAssetPath = "index.html"

/** 入口的备选路径：作者可能把页面放在 index.htm。 */
const entryAssetPathAlt = "index.htm"

// Request 是请求帧（别名，免得每个演示应用都 import abi 只为拿类型）。
type Request = abi.Request

// User 是帧内的使用者身份。
type User = abi.User

// Response 是一次响应。
type Response = abi.Response

// HostError 是一次宿主调用失败（JSON-RPC 错误码 + 平台给的可执行提示）。
//
// 演示应用把它**如实显示在页面上**：能力集合这个 demo 的一半价值就是让客户看到
// "平台拒绝时给的是什么"（`DB_DENIED` 的 hints 比一句"操作失败"有用得多）。
type HostError struct {
	Method  string
	Code    string
	Message string
	Details map[string]any
}

// Error 实现 error。
func (e *HostError) Error() string {
	if e == nil {
		return ""
	}
	return fmt.Sprintf("%s: %s: %s", e.Method, e.Code, e.Message)
}

// Trace 是一条宿主调用记录（演示页面把它渲染成"能力调用时间线"）。
type Trace struct {
	Method string `json:"method"`
	OK     bool   `json:"ok"`
	Note   string `json:"note,omitempty"`
	// Micros 是这一跳的耗时（微秒）。用 `time.Since` 在 guest 内测——
	// wasip1 上 time 走 WASI clock，做相对耗时足够。
	Micros int64 `json:"micros"`
}

// App 是一次请求的执行上下文。
type App struct {
	Req abi.Request

	in     *bufio.Reader
	out    *bufio.Writer
	nextID int64
	traces []Trace
}

// Main 是演示应用的入口：读一帧 → 交给 handler → 写回响应。
//
// handler 返回 Response 即可；返回 error 时本函数写一个 500 JSON 信封并把错误
// 打到 stderr（宿主会把 stderr 记进应用日志，是排障第一手材料）。
func Main(handler func(*App) Response) {
	if err := run(handler); err != nil {
		fmt.Fprintf(os.Stderr, "demoapp: %v\n", err)
		os.Exit(1)
	}
}

func run(handler func(*App) Response) error {
	// ⚠️ wasip1 上 stdin/stdout 可能是**非阻塞**的（本地预览用的 `node:wasi` 就是这样）：
	// 应用写完一帧宿主调用后立刻去读响应，只要宿主还没写完，`fd_read` 就立刻返回
	// EAGAIN，在 Go 里表现为 `read /dev/stdin: Try again` —— 症状是**第一个宿主调用
	// 必然失败**（请求帧本身读得到，因为宿主在 spawn 前就写了），页面上只剩一句莫名其妙的
	// 「应用配置读不到」。
	//
	// 平台宿主的管道本来就是阻塞的（`internal/wasmapp/runtime` 用 wazero 的 WithStdin
	// 直接阻塞读），所以这两行在平台上是**幂等的空操作**，在预览宿主上正好补掉那个竞态。
	// 收在这里而不是每个应用各写一遍：这是**底座该管的事** —— 漏掉它的应用会在本地
	// 预览里诡异地失败（三个演示里就有一个漏了）。返回值不检查：拿不到
	// FDSTAT_SET_FLAGS 权限时保持原样，与平台行为一致。
	_ = syscall.SetNonblock(int(os.Stdin.Fd()), false)
	_ = syscall.SetNonblock(int(os.Stdout.Fd()), false)

	in := bufio.NewReader(os.Stdin)
	out := bufio.NewWriter(os.Stdout)

	payload, err := abi.ReadFrame(in)
	if err != nil {
		_ = writeFrame(out, abi.Response{Status: 500, Headers: textHeaders(), Body: `{"error":{"code":"BAD_FRAME","message":"读请求帧失败"}}`})
		return fmt.Errorf("读请求帧: %w", err)
	}
	var req abi.Request
	if err := json.Unmarshal(payload, &req); err != nil {
		_ = writeFrame(out, abi.Response{Status: 500, Headers: textHeaders(), Body: `{"error":{"code":"BAD_FRAME","message":"请求帧不是合法 JSON"}}`})
		return fmt.Errorf("解析请求帧: %w", err)
	}

	app := &App{Req: req, in: in, out: out}
	resp := handler(app)
	if resp.Headers == nil {
		resp.Headers = map[string]string{}
	}
	if resp.Status == 0 {
		resp.Status = 200
	}
	return writeFrame(out, resp)
}

func writeFrame(out *bufio.Writer, resp abi.Response) error {
	payload, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	if err := abi.WriteFrame(out, payload); err != nil {
		return err
	}
	// ⚠️ `abi.WriteFrame` **不 flush**（它只写缓冲）：漏掉这一句宿主永远看不到响应，
	// 症状是 guest 一直等到 10s 预算耗尽、报 RUNTIME_TIMEOUT，而 host_call_count=0 ——
	// 看起来像环境坏了 —— 平台的 ABI 文档（references/abi.md）把这条列为头号坑。
	return out.Flush()
}

func textHeaders() map[string]string {
	return map[string]string{"content-type": "text/plain; charset=utf-8"}
}

// ---------------------------------------------------------------------------
// 宿主调用
// ---------------------------------------------------------------------------

// Call 调一次宿主能力，把结果解到 out（可为 nil）。
//
// 返回的 *HostError 是**平台给出的业务失败**（DB_DENIED / IMPORT_NOT_ALLOWED 之类），
// 与"协议层坏了"（error）分开：演示页面要把前者当成一等公民展示。
func (a *App) Call(method string, params any, out any) *HostError {
	started := nowMicros()
	err := a.call(method, params, out)
	a.traces = append(a.traces, Trace{
		Method: method,
		OK:     err == nil,
		Note:   noteOf(err),
		Micros: nowMicros() - started,
	})
	return err
}

func noteOf(err *HostError) string {
	if err == nil {
		return ""
	}
	// hints 单独拼出来：它是平台给模型的"下一步"，演示时要看得见。
	if hint, ok := err.Details["hint"].(string); ok && hint != "" {
		return err.Code + ": " + err.Message + " · " + hint
	}
	if h, ok := err.Details["hints"].([]any); ok && len(h) > 0 {
		parts := make([]string, 0, len(h))
		for _, v := range h {
			if s, ok := v.(string); ok {
				parts = append(parts, s)
			}
		}
		if len(parts) > 0 {
			return err.Code + ": " + err.Message + " · " + strings.Join(parts, " / ")
		}
	}
	return err.Code + ": " + err.Message
}

func (a *App) call(method string, params any, out any) *HostError {
	a.nextID++
	id, _ := json.Marshal(a.nextID)
	rawParams, err := json.Marshal(params)
	if err != nil {
		return &HostError{Method: method, Code: "MARSHAL", Message: err.Error()}
	}
	reqPayload, err := json.Marshal(abi.RPCRequest{JSONRPC: "2.0", ID: id, Method: method, Params: rawParams})
	if err != nil {
		return &HostError{Method: method, Code: "MARSHAL", Message: err.Error()}
	}
	if err := abi.WriteFrame(a.out, reqPayload); err != nil {
		return &HostError{Method: method, Code: "WRITE_FRAME", Message: err.Error()}
	}
	if err := a.out.Flush(); err != nil {
		return &HostError{Method: method, Code: "FLUSH", Message: err.Error()}
	}
	respPayload, err := abi.ReadFrame(a.in)
	if err != nil {
		return &HostError{Method: method, Code: "READ_FRAME", Message: err.Error()}
	}
	var resp struct {
		Result json.RawMessage   `json:"result"`
		Error  *abi.RPCErrorBody `json:"error"`
	}
	if err := json.Unmarshal(respPayload, &resp); err != nil {
		return &HostError{Method: method, Code: "BAD_RESPONSE", Message: err.Error()}
	}
	if resp.Error != nil {
		return &HostError{Method: method, Code: resp.Error.Code, Message: resp.Error.Message, Details: resp.Error.Details}
	}
	if out != nil {
		if err := json.Unmarshal(resp.Result, out); err != nil {
			return &HostError{Method: method, Code: "BAD_RESULT", Message: err.Error()}
		}
	}
	return nil
}

// Column 是一列的定义（类型枚举：text/int/real/bool/datetime）。
type Column struct {
	Name string
	Type string
}

// Define 建表（幂等；平台只允许通过它做 DDL）。
func (a *App) Define(table string, cols []Column) (bool, *HostError) {
	defs := make([]abi.ColumnDef, 0, len(cols))
	for _, c := range cols {
		defs = append(defs, abi.ColumnDef{Name: c.Name, Type: c.Type})
	}
	var res abi.DBDefineResult
	herr := a.Call("db.define", abi.DBDefineParams{Table: table, Columns: defs}, &res)
	return res.Created, herr
}

// Rows 是查询结果（列名 + 行；行里的值一律原样给出，由调用方按需投影）。
type Rows struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated"`
}

// Query 跑一条 SELECT。
func (a *App) Query(sql string, args ...any) (Rows, *HostError) {
	if args == nil {
		args = []any{}
	}
	var res Rows
	herr := a.Call("db.query", abi.SQLParams{SQL: sql, Args: args}, &res)
	return res, herr
}

// Exec 跑一条 INSERT/UPDATE/DELETE，返回受影响行数。
func (a *App) Exec(sql string, args ...any) (int64, *HostError) {
	if args == nil {
		args = []any{}
	}
	var res abi.ExecResult
	herr := a.Call("db.exec", abi.SQLParams{SQL: sql, Args: args}, &res)
	return res.RowsAffected, herr
}

// Tx 在事务里跑 fn：fn 返回 nil ⇒ commit，返回 error ⇒ rollback。
//
// 事务内**只允许** db.query / db.exec 与两个出口（log / assets.read / db.define
// 一律 DB_DENIED + details.kind），所以把日志与读配置放在事务外是这个包装的默认姿势。
func (a *App) Tx(fn func() error) *HostError {
	var begin abi.TxResult
	if herr := a.Call("tx_begin", struct{}{}, &begin); herr != nil {
		return herr
	}
	if err := fn(); err != nil {
		var rolled abi.TxResult
		if herr := a.Call("tx_rollback", abi.TxParams{TxID: begin.TxID}, &rolled); herr != nil {
			return herr
		}
		return &HostError{Method: "tx_commit", Code: "ROLLED_BACK", Message: err.Error()}
	}
	var committed abi.TxResult
	return a.Call("tx_commit", abi.TxParams{TxID: begin.TxID}, &committed)
}

// Log 写一行应用日志（单条 ≤4 KiB，每请求 ≤100 条）。
func (a *App) Log(level, message string) {
	var res abi.LogResult
	_ = a.Call("log", abi.LogParams{Level: level, Message: message}, &res)
}

// Asset 是包内资源（encoding 决定 text / base64 哪个有值）。
type Asset struct {
	ContentType string `json:"content_type"`
	Size        int    `json:"size"`
	Encoding    string `json:"encoding"`
	Text        string `json:"text"`
	Base64      string `json:"base64"`
}

// AssetRead 读一个包内逻辑路径（无文件系统语义，不能列目录/穿越）。
func (a *App) AssetRead(path string) (Asset, *HostError) {
	var res Asset
	herr := a.Call("assets.read", abi.AssetsReadParams{Path: path}, &res)
	return res, herr
}

// EntryHTML 读入口页（包内 index.html / index.htm）。
//
// **必须由 wasm 读**：入口 `/` 会走到应用，而 `/static/*` 这类非保留资源由宿主
// 按路径直出、根本不经过这里 —— 所以"先判名单再给页面"只有这一条路。
func (a *App) EntryHTML() (string, *HostError) {
	asset, herr := a.AssetRead(EntryAssetPath)
	if herr != nil {
		alt, altErr := a.AssetRead(entryAssetPathAlt)
		if altErr != nil {
			return "", herr
		}
		return alt.Text, nil
	}
	return asset.Text, nil
}

// ---------------------------------------------------------------------------
// 身份、准入与配置
// ---------------------------------------------------------------------------

// Username 返回使用者账号（无登录面时为空串；客户端专属下正常路径恒非空）。
func (a *App) Username() string {
	if a.Req.User == nil {
		return ""
	}
	return a.Req.User.Username
}

// DisplayName 返回展示名（缺失时回落账号）。
func (a *App) DisplayName() string {
	if a.Req.User == nil {
		return ""
	}
	if strings.TrimSpace(a.Req.User.DisplayName) != "" {
		return a.Req.User.DisplayName
	}
	return a.Req.User.Username
}

// Config 是应用配置（只取演示会用到的字段；完整字段表见平台文档）。
type Config struct {
	Access          string   `json:"access"`
	Whitelist       []string `json:"whitelist"`
	Purpose         string   `json:"purpose"`
	DataSensitivity string   `json:"data_sensitivity"`
	Owner           string   `json:"owner"`
}

// ReadConfig 读自己的 `picoaide.app.json`。
//
// 它是**平台保留资源**：宿主永不直出，只有应用自己读得到 —— 所以名单可以放这里
// （放进非保留资源等于对任何能打开应用的人公开）。
func (a *App) ReadConfig() (Config, *HostError) {
	var cfg Config
	asset, herr := a.AssetRead(AppConfigPath)
	if herr != nil {
		return cfg, herr
	}
	if err := json.Unmarshal([]byte(asset.Text), &cfg); err != nil {
		return cfg, &HostError{Method: "assets.read", Code: "CONFIG_MALFORMED", Message: err.Error()}
	}
	return cfg, nil
}

// AccessAllowed 判定本次请求能不能继续（**R24：平台不比对名单，由应用自己判**）。
//
// 返回 (是否放行, 原因)。原因直接渲染给用户：不在名单里时必须显示**本人账号**，
// 那是作者发现名单拼错的唯一途径。
func (a *App) AccessAllowed() (bool, string, Config) {
	cfg, herr := a.ReadConfig()
	if herr != nil {
		// 读不到配置**绝不**按匿名放行：宁可 500（可见的故障）也不要静默降级。
		return false, "应用配置读不到：" + herr.Error(), cfg
	}
	if a.Req.User == nil {
		return false, "这次请求没有身份（平台一律要求登录）", cfg
	}
	if cfg.Access != "whitelist" {
		return true, "", cfg
	}
	me := strings.ToLower(strings.TrimSpace(a.Username()))
	for _, allowed := range cfg.Whitelist {
		if strings.ToLower(strings.TrimSpace(allowed)) == me {
			return true, "", cfg
		}
	}
	return false, "你的账号不在这个应用的名单里", cfg
}

// Traces 返回本次请求已经发生的宿主调用（渲染"能力时间线"用）。
func (a *App) Traces() []Trace {
	return append([]Trace(nil), a.traces...)
}

// ---------------------------------------------------------------------------
// 响应构造
// ---------------------------------------------------------------------------

// JSON 返回一个 JSON 响应。
func JSON(status int, body any) Response {
	raw, err := json.Marshal(body)
	if err != nil {
		return Fail(500, "MARSHAL", err.Error())
	}
	return Response{
		Status:  status,
		Headers: map[string]string{"content-type": "application/json; charset=utf-8"},
		Body:    string(raw),
	}
}

// HTML 返回一个 HTML 响应。
func HTML(status int, markup string) Response {
	return Response{
		Status:  status,
		Headers: map[string]string{"content-type": "text/html; charset=utf-8"},
		Body:    markup,
	}
}

// Fail 返回平台口径的错误信封 `{"error":{"code","message"}}`。
//
// 与宿主/服务端同一个形状：前端只要写一套错误处理就能同时吃"应用自己的错"和
// "平台拒绝的错"。
func Fail(status int, code, message string) Response {
	return JSON(status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

// Text 返回纯文本响应（调试用）。
func Text(status int, body string) Response {
	return Response{Status: status, Headers: textHeaders(), Body: body}
}

// BodyJSON 把请求体解成 v（失败时返回 false，调用方给 400）。
func (a *App) BodyJSON(v any) bool {
	body := strings.TrimSpace(a.Req.Body)
	if body == "" {
		return false
	}
	return json.Unmarshal([]byte(body), v) == nil
}

// Query 取查询串参数（缺失返回空串）。
func (a *App) QueryParam(key string) string {
	if a.Req.Query == nil {
		return ""
	}
	return a.Req.Query[key]
}

// Path 是本次请求的应用内路径。
func (a *App) Path() string {
	return a.Req.Path
}

// DecodeBase64 是给"上传图片"这类演示用的解码入口（失败回 nil）。
func DecodeBase64(s string) []byte {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil
	}
	return raw
}

// ErrNotFound 是"这个路径应用没实现"的哨兵错误（调用方据此给 404 信封）。
var ErrNotFound = errors.New("demoapp: 未实现的路径")

// ReadAllStrings 是一个方便的小工具：把查询结果投影成"每行一个字符串切片"。
func (r Rows) ReadAllStrings() [][]string {
	out := make([][]string, 0, len(r.Rows))
	for _, row := range r.Rows {
		line := make([]string, 0, len(row))
		for _, cell := range row {
			line = append(line, Stringify(cell))
		}
		out = append(out, line)
	}
	return out
}

// Stringify 把查询结果里的一个值渲染成字符串（NULL 渲染成空串）。
func Stringify(v any) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		// 平台按 SQLite 的原生类型返回：整数也走 float64，这里去掉无意义的小数尾巴。
		if t == float64(int64(t)) {
			return fmt.Sprintf("%d", int64(t))
		}
		return strings.TrimRight(strings.TrimRight(fmt.Sprintf("%.6f", t), "0"), ".")
	default:
		return fmt.Sprintf("%v", t)
	}
}

// WriteStderr 打一行到 stderr（宿主会把 stderr 收进应用日志，排障用）。
func WriteStderr(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
}

// DrainInput 在收尾时把 stdin 读空，避免宿主写端阻塞（正常路径不需要调用）。
func DrainInput(r io.Reader) { _, _ = io.Copy(io.Discard, r) }
