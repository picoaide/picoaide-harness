package compile

import (
	"encoding/json"
	"strings"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// 父子协议的操作白名单（fail-closed：子进程只认这两个 op，其余一律拒）。
const (
	// OpCompile 是编译一个模块。
	OpCompile = "compile"
	// OpPing 是探活/版本（父侧启动自检与排障用）。
	OpPing = "ping"
)

// ProcVersion 是编译子进程的协议版本（ping 应答里回给父侧）。
//
// 独立于 abi.ABIVersion：父子之间用**单行 JSON**（不是应用 ABI 的 RS 帧），
// 两套协议不得混用——混用的后果是"编译进程的输出被当成应用输出"。
const ProcVersion = "picoaide-app-compile/1"

// Request 是父 → 子的一行 JSON 请求。
//
// 只有两个操作。子进程**只允许**读 ModulePath 指向的文件与写 CacheDir 目录
// （§4.3.1-d：缓存目录是信任边界，写面只有编译进程）。
//
// ⚠️ 这是**跨进程数据契约**（cmd/picoaide-app-compile 与本包两侧各自解析同一份
// JSON），不是同进程的函数调用：改字段名必须同时改两侧，且旧版父侧兼容性由
// ProcVersion 负责（版本不等 ⇒ 父侧拒用该二进制）。
type Request struct {
	Op         string `json:"op"`
	ModulePath string `json:"module_path,omitempty"`
	CacheDir   string `json:"cache_dir,omitempty"`
}

// Symbol 是一条导入或导出符号（父侧 Result 与子侧 Report 共用）。
//
// Kind 取 wasm 外部类型（func/memory/table/global）；Signature 是**规范化签名**
// （见 normalizeFuncSig），判据是"符号 + 类型"（§4.2）——只比符号名会漏掉
// "编译期全绿、实例化才炸"的签名不匹配（§15.1 第 11 条）。
type Symbol struct {
	Module    string `json:"module,omitempty"`
	Name      string `json:"name"`
	Kind      string `json:"kind"`
	Signature string `json:"signature,omitempty"`
}

// Report 是子进程静态校验 + 编译的结果（父侧 Result 是它的超集）。
type Report struct {
	Imports []Symbol
	Exports []Symbol
	// CustomBytes 是全部自定义段的原始字节合计（§4.2 上限 4 MiB 由 wasmmod 判）。
	CustomBytes int64
	// CustomSections 是自定义段名（诊断用，不含内容）。
	CustomSections []string
	// SectionNames 是模块内出现的段名（诊断用）。
	SectionNames []string
	// ComponentModel 表示这是组件模型产物（layer=1）⇒ COMPONENT_MODEL_UNSUPPORTED。
	ComponentModel bool
}

// Response 是子 → 父的一行 JSON 应答。
//
// 成功与失败共用同一结构（失败带 code/message/details），父侧据此构造
// apperr.Error（§7.4/§8：第一消费者是 AI，必须给 code + 可操作 message）。
type Response struct {
	OK bool `json:"ok"`
	// Version 只在 op=ping 的成功应答里出现。
	Version string `json:"version,omitempty"`
	// Message 是失败的人类可读说明。
	Message string `json:"message,omitempty"`
	// Code 是平台错误码字符串（父侧会用 protocolErrorCode 归并，不透传任意串）。
	Code    string         `json:"code,omitempty"`
	Details map[string]any `json:"details,omitempty"`

	Imports     []Symbol `json:"imports,omitempty"`
	Exports     []Symbol `json:"exports,omitempty"`
	CustomBytes int64    `json:"custom_bytes,omitempty"`
	// CompileMS 是 wazero 真编译耗时（毫秒；缓存命中时=命中后的耗时）。
	CompileMS int64 `json:"compile_ms,omitempty"`
	// Cached 表示本次编译是否命中磁盘缓存。**子进程恒为 false**：wazero 不暴露
	// "是否命中"的 API，判据由父侧给出（条目存在性 + 首编译耗时对比）。
	Cached bool `json:"cached,omitempty"`

	// 以下字段供父侧诊断（不进对外 Result 的固定字段）。
	SectionNames   []string `json:"section_names,omitempty"`
	CustomSections []string `json:"custom_sections,omitempty"`
	ComponentModel bool     `json:"component_model,omitempty"`
}

// protocolErrorCode 把子进程上报的码字符串收敛回平台错误码枚举。
//
// 为什么需要：子进程处理的是**攻击者的字节**，它的应答即使 JSON 合法也可能带任意
// code 字符串（例如被诱导打印一行伪造应答）。这里做一次白名单归并，保证父侧
// 永远不会把子进程编造的码透给上层（不透传 = 不放大攻击面）。
func protocolErrorCode(code string) apperr.Code {
	switch c := apperr.Code(strings.TrimSpace(code)); c {
	case apperr.CodeCompileTimeout,
		apperr.CodeCompileOOM,
		apperr.CodeSectionMalformed,
		apperr.CodeImportNotAllowed,
		apperr.CodeImportSignatureMismatch,
		apperr.CodeComponentModelUnsupport,
		apperr.CodeSectionOversize,
		apperr.CodeSectionOverrideOversize,
		apperr.CodeWasmTooLarge,
		apperr.CodeInternal:
		return c
	default:
		return apperr.CodeInternal
	}
}

// encodeLine 把结构体编码成不含换行的 JSON（协议要求"一行一个请求/响应"）。
//
// 用 json.Marshal 而不是 json.Encoder：Marshal 不会插入换行，
// 也不会因为将来加了 SetIndent 而在协议里塞进多行。
func encodeLine(v any) ([]byte, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	// 字符串字段里的 \n 会被 Marshal 转义成 \\n，所以这里只是兜底断言：
	// 触发即说明协议被破坏（不允许把多行写进一行协议）。
	if strings.ContainsRune(string(b), '\n') {
		return nil, errProtocolLine
	}
	return b, nil
}

// errProtocolLine 表示编码结果含换行（协议自检失败，不应发生）。
var errProtocolLine = apperr.New(apperr.CodeInternal, "协议行编码失败：结果含换行符")

// maxModuleBytes 是子进程读取模块文件的上限（= §4.2 的 32 MiB）。
//
// 放在读取之前判定：不给"超限文件先整体读进内存再判"的机会。
const maxModuleBytes = int64(limits.WasmMaxBytes)
