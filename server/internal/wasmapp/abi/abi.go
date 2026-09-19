// Package abi 是 WASM 应用平台的**应用契约（帧协议）唯一真源**：
// 设计基线 §7（请求帧 / 协议帧 / 计时规则 / 失败语义）。
//
// 帧格式（§7.1，唯一真源）：
//
//	RS(0x1e) + 十进制长度 + '\n' + UTF-8 JSON
//
// 长度 = JSON 负载的**字节**数。读取方必须**一次读满**，不得用会预读的
// JSON 流式解码器——实测会吞掉后续 RPC 应答（§7.1 原话）。
//
// 这一份实现被三处共用（§11 第 2 项）：
//  1. 宿主（internal/wasmapp/runtime）；
//  2. skill references 的样例代码（server/internal/wasmapp/refapp 的 Go 实现）；
//  3. validate 的干跑判据。
package abi

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// FrameMagic 是帧起始字节：ASCII RS（Record Separator）= 0x1e（设计文档写作 "RS"）。
const FrameMagic byte = 0x1e

// ABIVersion 是帧内 abi 字段的取值（§7.1）。
//
// ⚠️ **为什么 2026-09-18 把 auth.mode 收敛成三取值却没有 bump 到 /2**（有意决定，
// 不是漏改）：这个字符串的语义是"**帧的形状与宿主调用面**"，而不是"载荷里每个
// 字段的取值范围"。那次改动是后者 —— 帧的字节布局、方法名、导入面、错误码集合
// 一个都没动，变的只是 `auth.mode` 这个**被传进去的数据**。且平台尚未发布、
// 线上零个已编译产物（编译发生在作者机器上、发布即替换），所以不存在"按 /1 编译
// 却读到新取值"的模块。
//
// ⚠️ **2026-09-19 W4 删掉了宿主方法 `ai.chat`，同样不 bump**（总纲 §8.3 明确
// "`abi.ABIVersion` 本身不得改"，§21.3 给了替代处置）：调 `ai.chat` 的**老应用**
// 在**导入期/发布校验**就被判 `IMPORT_NOT_ALLOWED` 并附迁移指引（"改成前端调 AI →
// 结果回传 wasm 落库"），**不静默**；而帧的字节布局、长度前缀语义、其余方法名与
// 错误码集合一字未动 ⇒ 按 /1 编译且**不用** ai.chat 的应用行为逐字节不变。
// bump 的代价反而更大：它会让所有合法老应用在"什么都没坏"的情况下被拒。
//
// 反过来说清楚**其余什么时候必须 bump**：帧头/长度前缀语义、导入面、错误码取值、
// 或任何"按 /1 写的 guest 会读错"的结构性变化 —— 那时 bump 到 `picoaide-app/2`
// 并同步 SKILL 的 `references/abi.md`、`examples/`、预览脚本
// （`examples/go/preview.mjs`）。这条口径与 `AuthMode` 的类型注释成对。
const ABIVersion = "picoaide-app/1"

// MaxFrameBytes 是单帧 JSON 负载上限（§4.6：协议帧单行上限 1 MiB）。
const MaxFrameBytes = limits.ProtocolLineMaxBytes

// 帧解析错误（宿主一侧把它们映射为 RUNTIME_OUTPUT_OVERRUN / SECTION_MALFORMED 类错误）。
var (
	// ErrFrameTooLarge 表示帧确实超限（长度前缀合法但超过 MaxFrameBytes）。
	ErrFrameTooLarge = errors.New("abi: frame exceeds max length")
	// ErrFrameMalformed 表示帧结构非法（缺魔数 / 长度前缀非十进制 / JSON 非法）。
	ErrFrameMalformed = errors.New("abi: malformed frame")
	// ErrFrameTruncated 表示帧未读满即 EOF。
	ErrFrameTruncated = errors.New("abi: truncated frame")
	// ErrNotFrame 表示流起始字节不是帧魔数（§7.2：非 RS 起始的输出一律视为日志）。
	ErrNotFrame = errors.New("abi: not a frame")
)

// WriteFrame 写出一个帧：RS + 十进制长度 + '\n' + 负载。
// 负载为空是合法的（长度 0），但平台侧不会产生空帧。
//
// ⚠️ 这里曾经有一个 P0 bug（模块 A 审计发现）：实现写成
// `n := strconv.AppendInt(hdr[1:1], …)` —— 返回的切片从 hdr[1] 开始，
// 于是 hdr[0] 里的魔数被丢掉，实际写出的是 `7\n{…}`（首字节 0x37）。
// 该错误在"两端都用 EncodeFrame/ReadFrame"的测试里**测不出来**，
// 只有 WriteFrame 写 → ReadFrame 读的**往返测试**才能抓到 ⇒ 见 abi_test.go
// 的 TestFrameRoundTrip。改本函数时不要再对 hdr 做偏移切片。
func WriteFrame(w io.Writer, payload []byte) error {
	hdr := make([]byte, 0, 12)
	hdr = append(hdr, FrameMagic)
	hdr = strconv.AppendInt(hdr, int64(len(payload)), 10)
	hdr = append(hdr, '\n')
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if len(payload) == 0 {
		return nil
	}
	_, err := w.Write(payload)
	return err
}

// EncodeFrame 把负载编码成一个完整帧（便于一次性写入与测试）。
func EncodeFrame(payload []byte) []byte {
	out := make([]byte, 0, len(payload)+12)
	out = append(out, FrameMagic)
	out = strconv.AppendInt(out, int64(len(payload)), 10)
	out = append(out, '\n')
	return append(out, payload...)
}

// PeekIsFrame 判断流的下一字节是否为帧魔数（不消费）。
// 非帧起始 ⇒ 调用方按日志处理（§7.2 / §5.4「stdout 打日志毁协议」）。
func PeekIsFrame(r *bufio.Reader) (bool, error) {
	b, err := r.Peek(1)
	if err != nil {
		return false, err
	}
	return b[0] == FrameMagic, nil
}

// ReadFrame 从 r 读出一个完整帧并返回 JSON 负载。
//
// 语义（§7.1）：
//   - 起始字节必须是 FrameMagic，否则 ErrNotFrame（调用方转日志）；
//   - 长度前缀是十进制 ASCII，以 '\n' 结束；
//   - 必须一次读满（io.ReadFull），不得预读；
//   - 负载长度 > MaxFrameBytes ⇒ ErrFrameTooLarge；
//   - EOF 且未读到任何字节 ⇒ io.EOF（正常结束）。
func ReadFrame(r *bufio.Reader) ([]byte, error) {
	first, err := r.ReadByte()
	if err != nil {
		return nil, err
	}
	if first != FrameMagic {
		// 把这一字节还回去，让调用方按日志行读取完整内容。
		if uerr := r.UnreadByte(); uerr != nil {
			return nil, uerr
		}
		return nil, ErrNotFrame
	}
	// 长度前缀：最多 10 位十进制（1 MiB 只有 7 位）。
	var digits []byte
	for {
		b, err := r.ReadByte()
		if err != nil {
			if err == io.EOF && len(digits) > 0 {
				return nil, ErrFrameTruncated
			}
			return nil, err
		}
		if b == '\n' {
			break
		}
		if b < '0' || b > '9' || len(digits) >= 10 {
			return nil, fmt.Errorf("%w: bad length prefix", ErrFrameMalformed)
		}
		digits = append(digits, b)
	}
	if len(digits) == 0 {
		return nil, fmt.Errorf("%w: empty length prefix", ErrFrameMalformed)
	}
	n, err := strconv.Atoi(string(digits))
	if err != nil {
		return nil, fmt.Errorf("%w: bad length prefix", ErrFrameMalformed)
	}
	if n > MaxFrameBytes {
		return nil, fmt.Errorf("%w: %d > %d", ErrFrameTooLarge, n, MaxFrameBytes)
	}
	payload := make([]byte, n)
	if n > 0 {
		if _, err := io.ReadFull(r, payload); err != nil {
			if err == io.EOF || err == io.ErrUnexpectedEOF {
				return nil, ErrFrameTruncated
			}
			return nil, err
		}
	}
	return payload, nil
}

// ===== 宿主 → 应用：请求帧（§7.1）=====

// AuthMode 是 auth.mode 的取值（取自应用配置文件的 `access` 字段，§4.2 / R25）。
//
// ⚠️ **跨语言契约**（2026-09-18 用户拍板收敛为三模式）：取值只有下面三个 ——
// 应用、SKILL 模板与示例里的 mode 分支必须按这三个值写，**不得再出现
// `login_required`**（它已降级为配置文件的兼容 shim，不再是帧内取值）。
//
// ⚠️ 2026-09-19 W4：服务端**不再产生 `public`**（平台没有匿名面，历史 `access=public`
// 在读取侧即 login ⇒ `appcfg.Config.AuthMode()` 只回 login/whitelist）。
// `AuthModePublic` 作为**契约常量**保留：它是老应用/老示例里仍在分支判断的取值，
// 删掉常量会让"历史形态"在代码里无处安放（总纲 §8.4 未列它）。
type AuthMode string

const (
	// AuthModePublic 表示允许匿名（未登录时帧内 user 为 null，身份相关宿主调用 AUTH_REQUIRED）。
	AuthModePublic AuthMode = "public"
	// AuthModeLogin 表示要求登录（缺省）：未登录 302 主站换票，登录后**全员可用**。
	AuthModeLogin AuthMode = "login"
	// AuthModeWhitelist 表示要求登录 + 名单准入：**平台不比对名单**（R24）——
	// 它只把模式告诉应用；名单在应用配置文件的 `whitelist` 里，由应用
	// `assets.read("picoaide.app.json")` 读出来自己判。
	AuthModeWhitelist AuthMode = "whitelist"
)

// AuthInfo 是帧内 auth 字段。
type AuthInfo struct {
	Mode AuthMode `json:"mode"`
	// Verified 表示宿主已验证身份：mode=login/whitelist 下恒为 true 才会进 wasm；
	// 匿名（mode=public 且未登录）时为 false —— 应用据此区分"验证过的空用户"。
	Verified bool `json:"verified"`
}

// User 是帧内身份（§7.1「身份契约」3：只给本人信息；不含名单、不含平台角色）。
type User struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"display_name"`
	Dept        string `json:"dept"`
	// IsPublisher 是当前使用者是否为本应用发布者（R27）。
	IsPublisher bool `json:"is_publisher"`
}

// Request 是宿主构造的请求帧（§7.1）。
// 每一帧都带完整身份 —— guest 无状态、实例每请求新建，身份不是会话状态。
type Request struct {
	ABI     string   `json:"abi"`
	AppID   string   `json:"app_id"`
	Version string   `json:"version"`
	Auth    AuthInfo `json:"auth"`
	// User 在 mode=public 且未登录时为 nil（§7.1 第 4 条：不得渲染任何账号信息）。
	User    *User             `json:"user"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]string `json:"query"`
	Headers map[string]string `json:"headers"`
	// Body 是原始请求体（字符串；二进制上传在应用 API 上不存在，体积上限 1 MiB）。
	Body string `json:"body"`
}

// ===== 应用 → 宿主：JSON-RPC 2.0 请求（§7.2）=====

// RPCRequest 是应用发给宿主的一行 JSON-RPC 2.0 请求。
type RPCRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

// RPCResponse 是宿主回给应用的一行 JSON-RPC 2.0 响应。
type RPCResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *RPCErrorBody   `json:"error,omitempty"`
}

// RPCErrorBody 是宿主错误的 JSON-RPC 形态（§7.4：code 用平台错误码字符串）。
type RPCErrorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// NewRPCResult 构造成功响应。
func NewRPCResult(id json.RawMessage, result any) RPCResponse {
	return RPCResponse{JSONRPC: "2.0", ID: normalizeRPCID(id), Result: result}
}

// NewRPCError 构造失败响应。
func NewRPCError(id json.RawMessage, code, msg string) RPCResponse {
	return RPCResponse{JSONRPC: "2.0", ID: normalizeRPCID(id), Error: &RPCErrorBody{Code: code, Message: msg}}
}

func normalizeRPCID(id json.RawMessage) json.RawMessage {
	if len(id) == 0 {
		return json.RawMessage("null")
	}
	return id
}

// ===== 应用 → 宿主：最终响应信封（§7.2）=====

// Response 是应用返回的最终响应信封。
//
// 判别规则（§7.2 两类帧共用同一帧格式）：含 "jsonrpc" 字段 ⇒ RPC 请求；
// 含 "status" 字段 ⇒ 最终响应；两者都不含 ⇒ 协议错误（RUNTIME_NO_RESPONSE 语义）。
type Response struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

// FrameKind 是应用输出帧的判别结果。
type FrameKind int

const (
	// FrameUnknown 表示既不是 RPC 也不是响应。
	FrameUnknown FrameKind = iota
	// FrameRPC 表示这是一条 JSON-RPC 请求。
	FrameRPC
	// FrameResponse 表示这是最终响应信封。
	FrameResponse
)

// Classify 判别一行帧负载的类型（只看顶层字段是否存在，不解析值）。
func Classify(payload []byte) FrameKind {
	var probe map[string]json.RawMessage
	if err := json.Unmarshal(payload, &probe); err != nil {
		return FrameUnknown
	}
	if _, ok := probe["jsonrpc"]; ok {
		return FrameRPC
	}
	if _, ok := probe["status"]; ok {
		return FrameResponse
	}
	return FrameUnknown
}

// ===== 宿主能力面（§5.1 封闭清单）=====

// 宿主调用方法名（§5.1 的七个原语 → ABI 九个方法：db.tx 展开为三个）。
const (
	MethodDBDefine   = "db.define"
	MethodDBQuery    = "db.query"
	MethodDBExec     = "db.exec"
	MethodTxBegin    = "tx_begin"
	MethodTxCommit   = "tx_commit"
	MethodTxRollback = "tx_rollback"
	MethodLog        = "log"
	MethodAssetsRead = "assets.read"
	// ⚠️ `MethodAIChat = "ai.chat"` 已随 W4 **删除**（总纲 §21.3）：服务端 wasm
	// 不再具备任何 AI 能力；应用要调模型必须走"前端 JS → 宿主保留路径
	// `/__picoaide/ai/chat` → 结果回传 wasm 落库"（客户端 AI loop，§21.2）。
	// 老应用在**导入期/发布校验**即被拒（`IMPORT_NOT_ALLOWED` + 迁移指引），不静默。
	// MethodPing 仅供 validate 干跑使用：不属于能力面（见 HostMethods）。
	MethodPing = "abi.ping"
)

// HostMethods 是宿主注册的**全部**方法（§5.1 封闭清单 + 干跑探针）。
// 顺序即文档顺序；capabilities.go 一致性门禁要求注册集合与本清单逐项一致
// （多一个即测试红，§5.5）。
var HostMethods = []string{
	MethodDBDefine,
	MethodDBQuery,
	MethodDBExec,
	MethodTxBegin,
	MethodTxCommit,
	MethodTxRollback,
	MethodLog,
	MethodAssetsRead,
}

// Primitives 是 §5.1 的**六个**原语（作者面），门禁要求 ABI 方法与之一一对应。
//
// ⚠️ W4：原第七个原语 `ai.chat` 已删除（总纲 §21.3），六个原语 = db.define /
// db.query / db.exec / db.tx / log / assets.read。
var Primitives = []string{
	"db.define", "db.query", "db.exec", "db.tx", "log", "assets.read",
}

// PrimitiveOf 把 ABI 方法映射回它所属的作者面原语。
func PrimitiveOf(method string) string {
	switch method {
	case MethodDBDefine, MethodDBQuery, MethodDBExec:
		return method
	case MethodTxBegin, MethodTxCommit, MethodTxRollback:
		return "db.tx"
	default:
		return method
	}
}

// TxAllowedWhileInTx 判定**事务已打开时**还允许调用的方法。
//
// 这是事务允许集的**唯一**定义：hostcap.Dispatch 直接调用本函数，不再自持一份
// 局部集合（模块 H 审计：两处真源必然漂移）。abi 里曾有一个把 `tx_begin` 也算作
// "事务控制"的导出判定函数（新调用点照名字选它就会复活"允许嵌套事务"的旧 bug），
// 已**删除** —— 事务允许集只留这一处。
//
// 允许集 = db.query / db.exec（数据库读写）+ tx_commit / tx_rollback（事务出口）。
//
// 为什么事务内**允许**数据库读写：§5.1 那句「事务内**禁止**调用任何其他宿主
// 函数」的**意图**由 §4.4 给出依据 ——「事务内宿主调用 | **禁止**（`db.tx` 内调
// `log`/`assets.read` 直接报错）| 防事务长期持锁 + 占满执行槽」。这条理由只适用于
// **会长时间阻塞 / 占满执行槽**的能力，不适用于同一条连接上的快 SQL。反过来，
// 若把 db.query/db.exec 一并禁掉，db.tx 就退化成"begin 完立刻 commit"、
// §5.1 的 db.tx 原语等于不存在（模块 H 审计实测：事务内当时 7 个方法全被拒，
// 参考样例也只演示了零 SQL 的 begin→commit，所以缺陷长期隐形）。
//
// 禁止的三类（错误文案由 hostcap.txDenied 按类给出）：
//   - `tx_begin`：事务不可嵌套 —— 同时最多一个事务（每应用并发布放后，
//     宿主按请求校验事务所有权：非持有者的读写**与事务出口**
//     （`tx_commit`/`tx_rollback`）都会被拒，不再靠"并发恒为 1"兜底 ——
//     出口必须一起管：`TxParams.tx_id` 是**可省略**字段，只靠它判不出"这是谁的事务"），
//     且 5 s 硬超时该算在谁身上没有答案（本函数的前身曾把 `tx_begin` 算作
//     "事务控制"，属已修 bug）；
//   - `log` / `assets.read`：长时间阻塞或占执行槽（§4.4 的理由）；
//   - `db.define`：DDL，建表请在事务外做。
func TxAllowedWhileInTx(method string) bool {
	switch method {
	case MethodDBQuery, MethodDBExec, MethodTxCommit, MethodTxRollback:
		return true
	}
	return false
}

// ProbeMethods 是**不属于能力面**的协议内建方法（§5.1 封闭清单之外）。
//
// 目前只有 abi.ping：validate 的合成帧干跑需要一个"活着"的应答来判断
// guest 是否真的跑起来了（§4.2 validate 含干跑）。它必须被排除在
// §5.5「能力清单一致性」门禁之外 —— 门禁比的是 HostMethods，不是全部可达方法。
var ProbeMethods = []string{MethodPing}

// IsProbeMethod 判定是否为协议内建探针方法。
func IsProbeMethod(method string) bool {
	for _, m := range ProbeMethods {
		if m == method {
			return true
		}
	}
	return false
}

// ===== 参数与结果结构 =====

// ColumnDef 是 db.define 的列声明（§5.1：列类型枚举封闭）。
type ColumnDef struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// DBDefineParams 是 db.define 的参数。
type DBDefineParams struct {
	Table   string      `json:"table"`
	Columns []ColumnDef `json:"columns"`
}

// DBDefineResult 是 db.define 的结果（重复调用幂等）。
type DBDefineResult struct {
	Created bool     `json:"created"`
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
}

// SQLParams 是 db.query / db.exec 的参数（单语句 + 参数化）。
type SQLParams struct {
	SQL  string `json:"sql"`
	Args []any  `json:"args"`
}

// QueryResult 是 db.query 的结果。
// Rows 是按列顺序的值数组；Truncated 表示命中返回行数/字节上限（§4.5）。
type QueryResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated,omitempty"`
}

// ExecResult 是 db.exec 的结果。
type ExecResult struct {
	RowsAffected int64 `json:"rows_affected"`
}

// TxParams 是 tx_commit / tx_rollback 的参数（tx_id 可选；提供即校验）。
type TxParams struct {
	TxID int64 `json:"tx_id,omitempty"`
}

// TxResult 是 tx_begin 的结果。
type TxResult struct {
	TxID int64 `json:"tx_id"`
}

// ⚠️ W4 删除（总纲 §21.3）：消息 / 参数 / 结果 / 用量四个 ABI 载荷类型随服务端
// 宿主 AI 能力一起消失（它们只在那一个方法的参数与结果里出现）。应用侧的新形态是
// **客户端 AI loop**（§21.2）：请求/响应结构由宿主保留路径 `/__picoaide/ai/chat`
// 定义，不经过帧协议，因此这里不再有任何 AI 载荷类型。
//
// 注意：本注释**刻意不写被删类型的标识符** —— 同一个包里的
// `TestABIParamsCarryNoHostPath` 会扫描 abi 的**源码文本**找 `*Params` 类型，
// 注释里留下名字会让"已删除的类型"继续出现在覆盖性断言里（真红过一次）。

// LogParams 是 log 的参数（单条 ≤ 4 KiB，每请求 ≤ 100 条，§5.1）。
type LogParams struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

// LogResult 是 log 的结果（Dropped 表示被丢弃的条数，§5.1「超出丢弃并计数」）。
type LogResult struct {
	Accepted int `json:"accepted"`
	Dropped  int `json:"dropped,omitempty"`
}

// AssetsReadParams 是 assets.read 的参数（无文件系统语义、无路径穿越，§5.1）。
type AssetsReadParams struct {
	Path string `json:"path"`
}

// AssetsReadResult 是 assets.read 的结果。
//
// Encoding 是**判别字段**（必填）："text" ⇒ 读 Text；"base64" ⇒ 读 Base64；
// "empty" ⇒ 零字节资源（此时 Text/Base64 都为空串）。
//
// 为什么必须有 Encoding：Text/Base64 都是 omitempty，零字节资源两个字段都会
// 消失，应用只能靠 Size==0 猜 —— 而"内容恰好是空串的文本资源"与"零字节资源"
// 在 JSON 上无法区分。判别字段把这个歧义消灭在 ABI 层（模块 D 审计发现）。
type AssetsReadResult struct {
	ContentType string `json:"content_type"`
	Size        int    `json:"size"`
	Encoding    string `json:"encoding"`
	Text        string `json:"text,omitempty"`
	Base64      string `json:"base64,omitempty"`
}

// 资源编码判别值（abi.AssetsReadResult.Encoding）。
const (
	EncodingText   = "text"
	EncodingBase64 = "base64"
	EncodingEmpty  = "empty"
)

// ===== 帧内长度编码辅助（供参考实现与测试使用）=====

// FrameHeader 返回一个帧的长度前缀（RS + 十进制长度 + '\n'）。
func FrameHeader(payloadLen int) []byte {
	out := make([]byte, 0, 12)
	out = append(out, FrameMagic)
	out = strconv.AppendInt(out, int64(payloadLen), 10)
	return append(out, '\n')
}

// ParseFrameHeader 解析长度前缀，返回负载长度与消耗的字节数。
func ParseFrameHeader(b []byte) (length int, consumed int, err error) {
	if len(b) == 0 || b[0] != FrameMagic {
		return 0, 0, ErrNotFrame
	}
	i := 1
	for i < len(b) && b[i] != '\n' {
		if b[i] < '0' || b[i] > '9' {
			return 0, 0, ErrFrameMalformed
		}
		i++
	}
	if i >= len(b) {
		return 0, 0, ErrFrameTruncated
	}
	n, err := strconv.Atoi(string(b[1:i]))
	if err != nil {
		return 0, 0, ErrFrameMalformed
	}
	return n, i + 1, nil
}

// TrimLogLine 把非帧输出规整成一条日志行（去尾部换行、按上限截断）。
func TrimLogLine(b []byte) string {
	s := strings.TrimRight(string(b), "\r\n")
	if len(s) > limits.LogMaxLineBytes {
		s = s[:limits.LogMaxLineBytes]
	}
	return s
}
