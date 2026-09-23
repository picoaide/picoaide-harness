// Package apperr 是 WASM 应用平台的**错误码唯一真源**：
// 失败语义表见设计基线 §7.4，错误响应格式见 §8。
//
// 硬规则（§7.4 末尾「硬断言」）：
//   - 绝不把失败报成成功：Call 返回 err=nil 但 module 已关闭 / 无响应帧时，
//     必须映射为 MODULE_KILLED / RUNTIME_NO_RESPONSE，绝不返回 200；
//   - 错误响应的第一消费者是 AI ⇒ 必须带 code + message + hints（可操作）。
package apperr

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// Code 是结构化错误码（§7.4 全表）。
type Code string

// §7.4 失败语义表（本清单即文档表格，门禁测试逐条比对）。
const (
	CodeRuntimeTimeout          Code = "RUNTIME_TIMEOUT"
	CodeRuntimeTrap             Code = "RUNTIME_TRAP"
	CodeRuntimeMemory           Code = "RUNTIME_MEMORY"
	CodeRuntimeOutputOverrun    Code = "RUNTIME_OUTPUT_OVERRUN"
	CodeRuntimeNoResponse       Code = "RUNTIME_NO_RESPONSE"
	CodeRuntimeGuestExit        Code = "RUNTIME_GUEST_EXIT"
	CodeHostCallOverBudget      Code = "HOST_CALL_OVER_BUDGET"
	CodeAuthRequired            Code = "AUTH_REQUIRED"
	CodeModuleKilled            Code = "MODULE_KILLED"
	CodeDBLimit                 Code = "DB_LIMIT"
	CodeDBDenied                Code = "DB_DENIED"
	CodeAppQueueFull            Code = "APP_QUEUE_FULL"
	CodeImportNotAllowed        Code = "IMPORT_NOT_ALLOWED"
	CodeImportSignatureMismatch Code = "IMPORT_SIGNATURE_MISMATCH"
	CodeComponentModelUnsupport Code = "COMPONENT_MODEL_UNSUPPORTED"
	CodeSectionMalformed        Code = "SECTION_MALFORMED"
	CodeSectionOversize         Code = "SECTION_OVERSIZE"
	CodeSectionOverrideOversize Code = "SECTION_OVERRIDE_OVERSIZE"
	CodeCompileTimeout          Code = "COMPILE_TIMEOUT"
	CodeCompileOOM              Code = "COMPILE_OOM"

	// 发布链路（§4.1/§4.2/§10.5）。
	CodeInvalidAppID    Code = "INVALID_APP_ID"
	CodeNameTaken       Code = "NAME_TAKEN"
	CodeVersionInvalid  Code = "VERSION_INVALID"
	CodeVersionNotNewer Code = "VERSION_NOT_NEWER"
	CodeMissingField    Code = "MISSING_FIELD"
	CodeAppConfigBad    Code = "APP_CONFIG_INVALID"
	CodeWasmTooLarge    Code = "WASM_TOO_LARGE"
	CodeBodyTooLarge    Code = "BODY_TOO_LARGE"
	CodeValidateFailed  Code = "VALIDATE_FAILED"
	CodeForbidden       Code = "FORBIDDEN"
	CodeNotFound        Code = "NOT_FOUND"
	CodeRateLimited     Code = "RATE_LIMITED"
	CodeAppFrozen       Code = "APP_FROZEN"
	CodeCompileBusy     Code = "COMPILE_BUSY"
	CodeInternal        Code = "INTERNAL"
	CodeValidation      Code = "VALIDATION"
	CodeUnauthorized    Code = "UNAUTHORIZED"
	CodeBalanceExhaust  Code = "BALANCE_EXHAUSTED"

	// ===== 以下是 §7.4 失败语义表**未列出**的补充码 =====
	//
	// 设计文档 §7.4 是失败语义的唯一权威表，但它没有覆盖下面四类失败。
	// 把它们硬塞进既有的码会造成误诊（例如把"方法名不存在"报成 IMPORT_NOT_ALLOWED
	// 或 DB_DENIED，作者会往完全错误的方向排查）。因此这里**显式扩充**并在
	// 设计一致性报告里记为"文档缺口 + 实现补充"，而不是静默复用别的码。
	//
	// 判据：第一消费者是 AI（§8 原话）⇒ 错误码必须能指向正确的修法。

	// CodeHostMethodUnknown 应用调用了不存在的宿主方法（§10.6 第 68 项）。
	CodeHostMethodUnknown Code = "HOST_METHOD_UNKNOWN"
	// CodeAssetDenied 资源路径被拒（越界 / 符号链接 / 非法段 / 抽取根逃逸）。
	// 注意：**资源不存在**仍回 §7.4 表里的 404 NOT_FOUND（不并入本码）——
	// 两者的可操作修法不同（改路径 vs 检查发布产物）。
	CodeAssetDenied Code = "ASSET_DENIED"
	// CodeAssetOversize 单个资源超过自定义段总量上限（§4.2 同源）。
	CodeAssetOversize Code = "ASSET_OVERSIZE"
	// CodeAssetExists 资源已存在（发布期抽取只写一次，拒绝覆盖）。
	CodeAssetExists Code = "ASSET_EXISTS"
	// CodeResultTooLarge 宿主结果装不进一个协议帧（单帧上限 1 MiB）。
	//
	// 2026-09-23 审计 A-1（P1）新增：`db.query` 之外的能力结果（以及"连丢掉全部行都
	// 装不下"的 `db.query` 之外的兜底形态）编码后超过单帧时，宿主回这个码 —— 见
	// `abi.RPCResponse.MarshalJSON` 的 `oversizeErrorShape`。它与 `ASSET_OVERSIZE`
	// （单个资源超限）和 `DB_LIMIT`（行数/结果超限）并列：三个码各自指向**不同的修法**
	// （拆资源 / 分页 / 缩小本次调用的返回内容），合并成一个会让作者改错地方。
	CodeResultTooLarge Code = "RESULT_TOO_LARGE"

	// ===== 客户端持有性证明（app-proof，契约 §20.1/§23.1）=====
	//
	// ⚠️ 这四个码的**字面值是小写**，与上面所有码的大小写风格不同 —— 这是契约
	// 给定的线格式（§20.1 原文：缺失 ⇒ 401 `proof_required`；过期 ⇒ 401
	// `proof_expired`；绑定不匹配 ⇒ 401 `proof_mismatch`），客户端按字面值分流。
	// 不要为了"统一风格"改成大写：那会静默改变对外契约。

	// CodeProofRequired 请求缺少 proof（端点要求持有性证明）。
	CodeProofRequired Code = "proof_required"
	// CodeProofExpired proof 已过期（客户端应重新签发）。
	CodeProofExpired Code = "proof_expired"
	// CodeProofMismatch proof 与本请求的绑定不符（用户/bearer/安装/服务端/应用）。
	CodeProofMismatch Code = "proof_mismatch"
	// CodeProofReplayed 一次性 nonce 或 proof 的 jti 已被使用过（重放）。
	//
	// 契约只点名了前三个码；重放是**第四种**独立失败（绑定完全正确、只是用过了），
	// 把它并进 proof_mismatch 会让客户端与排障都把"客户端在重试同一个请求"
	// 误判成"配置/环境不符"。因此显式扩充，并在 L1 status 文件里记为文档缺口 +
	// 实现补充（不是静默复用别的码）。
	CodeProofReplayed Code = "proof_replayed"
)

// Error 是可结构化的平台错误（实现 error，可直接进 JSON 信封）。
type Error struct {
	Code    Code
	Message string
	Details map[string]any
	Hints   []string
	// HTTP 是建议的状态码；零值表示由 StatusOf 推导。
	HTTP int
	// cause 仅用于日志（不外泄给应用/客户端，§8 只透出可操作信息）。
	cause error
}

func (e *Error) Error() string {
	if e == nil {
		return "<nil>"
	}
	if e.cause != nil {
		return fmt.Sprintf("%s: %s: %v", e.Code, e.Message, e.cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

func (e *Error) Unwrap() error { return e.cause }

// WithCause 附加内部原因（只进日志，不进响应体）。
func (e *Error) WithCause(err error) *Error {
	e.cause = err
	return e
}

// WithDetail 追加一条结构化明细。
func (e *Error) WithDetail(k string, v any) *Error {
	if e.Details == nil {
		e.Details = map[string]any{}
	}
	e.Details[k] = v
	return e
}

// WithHint 追加一条可操作提示。
func (e *Error) WithHint(hints ...string) *Error {
	e.Hints = append(e.Hints, hints...)
	return e
}

// New 构造一个错误。
func New(code Code, msg string) *Error {
	return &Error{Code: code, Message: msg}
}

// Newf 构造一个带格式化消息的错误。
func Newf(code Code, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// As 提取 *Error（errors.As 的语法糖）。
func As(err error) (*Error, bool) {
	var e *Error
	if errors.As(err, &e) {
		return e, true
	}
	return nil, false
}

// From 把任意 error 规整为 *Error（未知错误一律 INTERNAL，不泄露内部细节）。
func From(err error) *Error {
	if err == nil {
		return nil
	}
	if e, ok := As(err); ok {
		return e
	}
	return New(CodeInternal, "内部错误").WithCause(err)
}

// StatusOf 返回该错误码对应的 HTTP 状态（§7.4 表：未列出的取兜底）。
func StatusOf(code Code) int {
	if s, ok := codeStatus[code]; ok {
		return s
	}
	return http.StatusInternalServerError
}

// Status 返回该错误的 HTTP 状态。
func (e *Error) Status() int {
	if e == nil {
		return http.StatusOK
	}
	if e.HTTP != 0 {
		return e.HTTP
	}
	return StatusOf(e.Code)
}

// WithStatus 覆盖建议状态码（返回自身，便于链式构造）。
//
// 存在的理由（契约 §5.1b）：同一个**码**在不同入口可以有不同的 HTTP 状态 ——
// "应用已下架"在 open 端点按 410 返回（客户端据此显示"已下架"而不是"不存在"），
// 而复用的是 §7.4 表里语义最接近的 `NOT_FOUND`。没有它就只能要么新增一个码
// （契约没点名）、要么在 handler 里手写 c.JSON（绕过统一信封）。
func (e *Error) WithStatus(status int) *Error {
	e.HTTP = status
	return e
}

// codeStatus 是 §7.4 表里显式给出的 code → HTTP 映射。
var codeStatus = map[Code]int{
	CodeRuntimeTimeout:          http.StatusGatewayTimeout,      // 504
	CodeRuntimeTrap:             http.StatusInternalServerError, // 500
	CodeRuntimeMemory:           http.StatusInternalServerError, // 500
	CodeRuntimeOutputOverrun:    http.StatusInternalServerError, // 500
	CodeRuntimeNoResponse:       http.StatusBadGateway,          // 502
	CodeRuntimeGuestExit:        http.StatusInternalServerError, // 500
	CodeHostCallOverBudget:      http.StatusGatewayTimeout,      // 504
	CodeAuthRequired:            http.StatusUnauthorized,        // 401
	CodeModuleKilled:            http.StatusGatewayTimeout,      // 504
	CodeDBLimit:                 http.StatusInsufficientStorage, // 507
	CodeDBDenied:                http.StatusForbidden,           // 403
	CodeAppQueueFull:            http.StatusTooManyRequests,     // 429
	CodeImportNotAllowed:        http.StatusUnprocessableEntity, // 422
	CodeImportSignatureMismatch: http.StatusUnprocessableEntity, // 422
	CodeComponentModelUnsupport: http.StatusUnprocessableEntity, // 422
	CodeSectionMalformed:        http.StatusUnprocessableEntity, // 422
	CodeSectionOverrideOversize: http.StatusUnprocessableEntity, // 422
	CodeSectionOversize:         http.StatusUnprocessableEntity, // 422
	CodeCompileTimeout:          http.StatusGatewayTimeout,      // 504
	CodeCompileOOM:              http.StatusInternalServerError, // 500

	CodeInvalidAppID:    http.StatusBadRequest,          // 400
	CodeNameTaken:       http.StatusConflict,            // 409
	CodeVersionInvalid:  http.StatusBadRequest,          // 400
	CodeVersionNotNewer: http.StatusBadRequest,          // 400
	CodeMissingField:    http.StatusUnprocessableEntity, // 422
	CodeAppConfigBad:    http.StatusUnprocessableEntity, // 422
	CodeWasmTooLarge:    http.StatusRequestEntityTooLarge,
	CodeBodyTooLarge:    http.StatusRequestEntityTooLarge,
	CodeValidateFailed:  http.StatusUnprocessableEntity,
	CodeForbidden:       http.StatusForbidden,
	CodeNotFound:        http.StatusNotFound,
	CodeRateLimited:     http.StatusTooManyRequests,
	CodeAppFrozen:       http.StatusForbidden,
	CodeCompileBusy:     http.StatusTooManyRequests,
	CodeInternal:        http.StatusInternalServerError,
	CodeValidation:      http.StatusBadRequest,
	CodeUnauthorized:    http.StatusUnauthorized,
	CodeBalanceExhaust:  http.StatusTooManyRequests,

	CodeHostMethodUnknown: http.StatusBadRequest,          // 400
	CodeAssetDenied:       http.StatusForbidden,           // 403
	CodeAssetOversize:     http.StatusUnprocessableEntity, // 422
	CodeAssetExists:       http.StatusConflict,            // 409
	// 结果装不进单帧同样是"请求得太宽"（422），与 ASSET_OVERSIZE 同档：
	// 修法是应用侧改查询/分页，不是平台故障（那不是 5xx）。
	CodeResultTooLarge: http.StatusUnprocessableEntity, // 422

	// 四个 proof 码一律 401（契约 §20.1：缺失/过期/绑定不符 ⇒ 401；
	// 重放同属"这份证明对本次请求无效"，也用 401 —— 403 会被客户端当成"权限不足"
	// 而不是"重新签发"）。
	CodeProofRequired: http.StatusUnauthorized,
	CodeProofExpired:  http.StatusUnauthorized,
	CodeProofMismatch: http.StatusUnauthorized,
	CodeProofReplayed: http.StatusUnauthorized,
}

// Envelope 是 §8 的错误响应格式：
//
//	{"error":{"code":"…","message":"…","details":{…},"hints":[…]}}
type Envelope struct {
	Error Body `json:"error"`
}

// Body 是错误信封的内层。
type Body struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
	Hints   []string       `json:"hints,omitempty"`
}

// EnvelopeOf 把错误装进响应信封。
func EnvelopeOf(e *Error) Envelope {
	if e == nil {
		e = New(CodeInternal, "内部错误")
	}
	return Envelope{Error: Body{Code: e.Code, Message: e.Message, Details: e.Details, Hints: e.Hints}}
}

// JSON 序列化信封（测试与日志用）。
func (e *Error) JSON() string {
	b, _ := json.Marshal(EnvelopeOf(e))
	return string(b)
}

// RPCError 是宿主→应用的 JSON-RPC 错误对象（§7.2）。
// code 用平台错误码字符串（不走 JSON-RPC 数字码，避免两套语义）。
type RPCError struct {
	Code    Code           `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// RPC 把 *Error 转成 JSON-RPC 错误对象。
func (e *Error) RPC() *RPCError {
	if e == nil {
		return nil
	}
	return &RPCError{Code: e.Code, Message: e.Message, Details: e.Details}
}

// CommonHints 是跨场景复用的提示文案（保持可操作、不泄露内部机制）。
var CommonHints = map[Code][]string{
	CodeImportNotAllowed: {
		"只允许导入 wasi_snapshot_preview1（不得使用 env.* / js.* / 其他模块）",
		"编译目标必须是 wasm32-wasip1（Go: GOOS=wasip1 GOARCH=wasm）",
	},
	CodeImportSignatureMismatch: {
		"按 skill 提供的 read_request()/write_response() 样板生成代码",
		"编译目标必须是 wasm32-wasip1（Go: GOOS=wasip1 GOARCH=wasm）",
	},
	CodeComponentModelUnsupport: {
		"平台只支持 core module（wasm32-wasip1），不支持组件模型",
	},
	CodeAuthRequired: {
		"该能力需要登录身份：应用应在 access=login（缺省）或 access=whitelist 下使用，或先引导用户登录",
	},
	CodeDBDenied: {
		"只允许单条 SELECT/INSERT/UPDATE/DELETE；建表请用 db.define",
	},
	CodeDBLimit: {
		"应用数据库为 100 MB 硬上限，请清理历史数据或联系平台管理员",
	},
	CodeAppQueueFull: {
		"应用当前请求过多（该应用的并发与队列都已占满），请稍后重试",
	},
}
