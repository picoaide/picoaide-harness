// Package capapi 定义 WASM 应用平台内部各模块之间的**稳定接口契约**：
// 宿主能力面（§5.1）的实现方与调用方只依赖本包，便于分模块并行实现与替换。
//
// 依赖方向（单向，不得成环）：
//
//	abi / limits / apperr        （无依赖，基础契约）
//	   ↑
//	capapi                       （本包：模块间接口 + 计量结构）
//	   ↑
//	appdb / aichat / assets / appcfg / wasmmod / compile  （能力实现）
//	   ↑
//	runtime                      （wazero 宿主，按 capapi 接口调用能力）
//	   ↑
//	edge / api / queue           （HTTP 面）
package capapi

import (
	"context"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
)

// DB 是应用数据库能力（§4.5/§5.1：db.define / db.query / db.exec / db.tx）。
//
// 实现方必须保证：
//   - **每条连接**都设全套 SQLITE_LIMIT_* 与 max_page_count（连接级、不持久，§15.1 第 4 条）；
//   - 单语句闸门 + 语句种类白名单 + 保留列拒绝（§4.5）；
//   - 单语句 5 s 硬超时（limits.SQLStatementBudget），取消时中断驱动。
type DB interface {
	// Define 建表（宿主代执行 CREATE TABLE IF NOT EXISTS，重复调用幂等，§5.1/R32）。
	Define(ctx context.Context, p abi.DBDefineParams) (abi.DBDefineResult, error)
	// Query 执行单条 SELECT（query_only 连接，§4.5「连接级只读分层」）。
	Query(ctx context.Context, p abi.SQLParams) (abi.QueryResult, error)
	// Exec 执行单条写语句（仅 INSERT/UPDATE/DELETE）。
	Exec(ctx context.Context, p abi.SQLParams) (abi.ExecResult, error)
	// Begin 开启事务并返回事务标识（同时最多一个事务；每应用并发布放后，宿主按请求
	// 校验事务所有权 —— 非持有者的读写会被拒绝，见 appserver 的每请求包装层）。
	Begin(ctx context.Context) (abi.TxResult, error)
	// Commit 提交当前事务；p.TxID 非零时校验一致性。
	Commit(ctx context.Context, p abi.TxParams) error
	// Rollback 回滚当前事务；p.TxID 非零时校验一致性。
	Rollback(ctx context.Context, p abi.TxParams) error
	// InTx 报告当前是否有打开的事务（事务内禁止其他宿主调用，§4.4）。
	InTx() bool
	// Close 关闭连接（每请求结束后由运行时调用；实现可做连接复用策略由实现决定）。
	Close() error
	// Stats 返回本次请求累计的行数/字节计量（§4.9 调用事件字段 db_rows/db_bytes）。
	Stats() DBStats
}

// DBStats 是应用库的本次请求计量与结构信息。
type DBStats struct {
	// Rows 是本次请求返回的行数累计。
	Rows int64
	// Bytes 是本次请求返回的字节数累计。
	Bytes int64
	// Tables 是库内表数（db.define 上限检查用）。
	Tables int
	// SizeBytes 是库文件当前体积（诊断用）。
	SizeBytes int64
}

// AI 是 ai.chat 能力（§4.7：走平台既有 /v1 路径，按使用者身份计费与限流，R36）。
//
// 实现方必须保证：
//   - 匿名（user == nil）⇒ 返回 apperr.CodeAuthRequired；
//   - 用 http.NewRequestWithContext + 独立预算（limits.HostAIChatBudget）；
//   - 余额不足 ⇒ AI_BALANCE_INSUFFICIENT（402 语义，不暴露具体余额）；
//   - 限流 ⇒ AI_RATE_LIMITED；上游错误原文不透出。
type AI interface {
	Chat(ctx context.Context, user *abi.User, p abi.AIChatParams) (abi.AIChatResult, error)
}

// Assets 是包内资源读取能力（§5.1：无文件系统语义、无路径穿越）。
//
// 资源已在发布期从 wasm 自定义段抽到宿主磁盘（§4.2），应用与宿主读同一份。
// 实现方必须保证 Path 只在「本应用 + 本版本」的抽取目录内解析
// （拒绝空路径、绝对路径、`..`、符号链接逃逸）。
type Assets interface {
	// Read 返回资源内容与 content-type。路径不存在 ⇒ apperr.CodeNotFound。
	Read(path string) (contentType string, data []byte, err error)
	// List 返回已抽取资源的相对路径列表（诊断/自省用）。
	List() []string
}

// LogSink 接收应用通过 log 宿主函数写出的日志（§5.1：单条 ≤ 4 KiB、每请求 ≤ 100 条）。
type LogSink interface {
	// Log 写入一条日志；超出条数上限时实现方自行丢弃并计数。
	Log(level, message string)
	// Dropped 返回被丢弃的条数（回给应用的结果字段）。
	Dropped() int
}

// HostCall 是一次宿主调用的计量记录（§4.9 调用事件字段）。
type HostCall struct {
	// Method 是 ABI 方法名（abi.Method*）。
	Method string
	// DurationMS 是宿主侧耗时（毫秒）。
	DurationMS int64
	// Failed 表示该次调用返回了错误。
	Failed bool
	// Code 是失败时的平台错误码（成功为空串）。
	Code string
}

// CallMetrics 是一次应用请求的完整计量（§4.9「调用事件」字段集合）。
// 字段名与设计文档 §4.9 一一对应，落库列名由 events 包负责映射。
type CallMetrics struct {
	AppID        string
	UserID       int64
	Outcome      string // ok / error / killed
	ReasonCode   string // 平台错误码（成功为空）
	CPUMs        int64
	PeakMemory   int64
	HostCalls    int64
	HostCallMS   int64
	QueueWaitMS  int64
	ResponseSize int64
	DBRows       int64
	DBBytes      int64
	// GuestExitCode 在 guest 非零退出且无响应帧时记录（§7.4 RUNTIME_GUEST_EXIT）。
	GuestExitCode int32
	// StderrTail 是 guest stderr 尾巴（诊断用，上限 limits.StderrTailBytes）。
	StderrTail string
	// StdoutLogs 是被判定为日志的 stdout 行数（§7.2「stdout 净化」统计）。
	StdoutLogs int
}

// Outcome 取值（§4.9 调用事件 outcome 列）。
const (
	OutcomeOK     = "ok"
	OutcomeError  = "error"
	OutcomeKilled = "killed"
)
