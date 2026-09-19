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
	CodeAIBalanceInsufficient   Code = "AI_BALANCE_INSUFFICIENT"
	CodeAIRateLimited           Code = "AI_RATE_LIMITED"
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
	CodeAIBalanceInsufficient:   http.StatusPaymentRequired,     // 402
	CodeAIRateLimited:           http.StatusTooManyRequests,     // 429
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
	CodeAIBalanceInsufficient: {
		"使用者余额不足：请在桌面客户端查看余额，或联系管理员充值",
	},
	CodeAIRateLimited: {
		"使用者触发了平台既有用户级限流，请稍后重试",
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
