// Package hostcap 实现 §5.1 的**宿主能力面**：把一次请求的全部能力与身份装进
// Capabilities，并按 ABI 方法名分发（实现 runtime.HostFuncs）。
//
// # 封闭清单（§5.1 / §5.5）
//
// 注册的方法集合**恰好**等于 abi.HostMethods：db.define / db.query / db.exec /
// tx_begin / tx_commit / tx_rollback / log / assets.read（**八个**）。
// 没有文件、网络、线程、子进程、环境变量、PRAGMA、ATTACH、DDL、扩展；也没有
// 任何员工目录能力（R26）。**多一个即测试红**（gate_test.go）。
//
// ⚠️ W4：原第九个方法 `ai.chat` 已删除（总纲 §21.3）—— 服务端 wasm 不再具备任何
// AI 能力，应用改走客户端 AI loop（§21.2）。老应用在导入期/发布校验即被拒
// （`IMPORT_NOT_ALLOWED` + 迁移指引），不静默。
//
// # 身份（R24–R27）
//
// 身份由调用方（runtime）注入 `User`：帧由宿主构造，应用无法伪造。
// 平台**没有匿名面**（一律要求登录，见 appserver 的准入）：`User == nil` 只可能来自
// 装配/测试错误，需要身份的能力一律回 AUTH_REQUIRED（fail-closed）。
//
// # 事务（§4.4 + §5.1，模块 H 审计裁定）
//
// 事务内**只允许数据库读写**：`db.query` / `db.exec` 与 `tx_commit` / `tx_rollback`。
// 禁止的是三类，每类都给出可操作错误（见 txDenied）：
//   - 嵌套事务：`tx_begin`；
//   - 会长时间阻塞 / 占执行槽的能力：`log` / `assets.read`；
//   - DDL：`db.define`（建表请在事务外做）。
//
// 「允不允许」的**唯一**定义在 abi.TxAllowedWhileInTx（本包不再自持局部集合：
// 两处真源必然漂移，而且 abi 里曾有一个把 `tx_begin` 当成事务控制的错误形态判定
// 函数，会让新调用点复活"允许嵌套事务"的旧 bug，已删除）。§5.1「事务内**禁止**
// 调用任何其他宿主函数」按 §4.4 给出的**意图**解释 —— §4.4 的理由是「防事务长期
// 持锁 + 占满执行槽」，只覆盖长时间阻塞/占槽的能力，不覆盖同一条连接上的快 SQL；
// 把 db.query/db.exec 也禁掉会让 db.tx 退化成"begin 完立刻 commit"（模块 H 审计
// 实测：当时事务内 7 个方法全被拒，参考样例只演示零 SQL 的 begin→commit，
// 所以缺陷长期隐形）。
package hostcap

import (
	"bytes"
	"context"
	"encoding/json"
	"log"
	"regexp"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/picoaide/picoaide/internal/wasmapp/abi"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/assets"
	"github.com/picoaide/picoaide/internal/wasmapp/capapi"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// DefaultLogLevel 是 log 调用未给 level 时的兜底级别。
//
// 不拒"空 level"：日志是诊断面，为了一个可读性问题让应用整体失败不划算；
// 但也不静默丢弃（写进 sink 的永远是明确级别）。
const DefaultLogLevel = "info"

// Capabilities 装配**一次请求**的全部能力与身份。
//
// 每请求新建一个实例：log 的条数计数是请求级状态（§5.1「每请求 ≤ 100 条」），
// 与 guest 实例"每请求新建、禁止复用"（§4.3）同一口径。
type Capabilities struct {
	AppID   string
	Version string
	// User 是帧内身份（§7.1 身份契约）；nil 只可能来自装配/测试错误
	//（平台没有匿名面 ⇒ 需要身份的能力一律 AUTH_REQUIRED）。
	// is_publisher 等身份事实由调用方写在 User 里（宿主注入，应用伪造不了）。
	User *abi.User
	// DB 可为 nil（未打开 ⇒ 宿主内部错误）。
	DB capapi.DB
	// Assets 是 assets.read 的实现；nil ⇒ 宿主内部错误。
	Assets capapi.Assets
	// Logs 是日志出口；nil 视为"没有日志目的地"（调用仍成功，但计入 dropped，
	// 让应用能看出日志正在被丢弃，而不是以为写成功了）。
	Logs capapi.LogSink

	mu          sync.Mutex
	logAccepted int
	logDropped  int
}

// handler 是单个宿主函数的实现（方法表达式：第一个参数是接收者）。
type handler func(c *Capabilities, ctx context.Context, params json.RawMessage) (any, *apperr.Error)

// table 是能力面注册表：**唯一**的方法集合来源（RegisteredMethods 与 Dispatch
// 都从这里取，杜绝"分发支持了但清单没写"的漂移）。
var table = map[string]handler{
	abi.MethodDBDefine:   (*Capabilities).callDBDefine,
	abi.MethodDBQuery:    (*Capabilities).callDBQuery,
	abi.MethodDBExec:     (*Capabilities).callDBExec,
	abi.MethodTxBegin:    (*Capabilities).callTxBegin,
	abi.MethodTxCommit:   (*Capabilities).callTxCommit,
	abi.MethodTxRollback: (*Capabilities).callTxRollback,
	abi.MethodLog:        (*Capabilities).callLog,
	abi.MethodAssetsRead: (*Capabilities).callAssetsRead,
}

// RegisteredMethods 返回本包注册的**全部**方法（§5.5 一致性门禁用），按字典序。
//
// ⚠️ 实现必须是**枚举 table 的键**，绝不能写成"用 abi.HostMethods 过滤 table"
// （模块 H 审计 P1-1）：那样一来"注册了但不在清单里"的方法**结构上不可能**出现在
// 返回值里，门禁拿它与清单自比恒等 ⇒ "多一个即测试红"（§5.5 / §10.6 第 62 项）
// 这条判据恒真、形同虚设。而 Dispatch 查的是 `table[method]`，多出来的方法**真的
// 会被分发** ⇒ 门禁必须在两个方向都有效（少一个红、多一个也红）。
//
// 返回值是副本且已排序：调用方不得依赖注册顺序（§5.1 的文档顺序由 abi.HostMethods
// 表达，门禁用集合比较加上"表里每一项都在清单里"双向对拍）。
func RegisteredMethods() []string {
	out := make([]string, 0, len(table))
	for m := range table {
		out = append(out, m)
	}
	sort.Strings(out)
	return out
}

// Dispatch 分发一次宿主调用（实现 runtime.HostFuncs）。
//
// 分层顺序（顺序本身是语义，不要调整）：
//  1. recover 边界：任何 panic 都变成 INTERNAL，绝不让宿主进程/请求崩掉（§4.4）；
//  2. 未注册即不存在：先判方法是否存在，再判它此刻允不允许 —— 方法名根本不存在时
//     必须回 HOST_METHOD_UNKNOWN（§10.6 第 68 项），而不是被事务闸门改写成"事务内禁用"；
//  3. 事务隔离：事务内只允许数据库读写（abi.TxAllowedWhileInTx 是唯一真源）。
//     **闸门在 abi.ping 之前** —— ping 也不在允许集里，"事务内只允许数据库读写"
//     这条不变量没有例外（模块 H 审计 P2-5：此前 ping 分支在闸门之前，事务内可 ping）；
//  4. 身份闸门 + 参数严格解析（capability 不合法/类型不符都不 panic）；
//  5. 调用能力实现；
//  6. 返回后**强制复检 ctx**：调用返回成功但请求/模块已被取消时按
//     MODULE_KILLED 处理，绝不把"被杀"报成成功（§4.4 / §7.4 硬断言）。
func (c *Capabilities) Dispatch(ctx context.Context, method string, params json.RawMessage) (result any, failure *apperr.Error) {
	defer func() {
		if r := recover(); r != nil {
			// panic 值可能带内部细节（驱动错误里的 DSN、文件路径等），
			// 只进宿主日志，**不进回给应用的错误体**。
			log.Printf("wasmapp/hostcap: panic in host call %q (app=%s): %v", method, c.AppID, r)
			result = nil
			failure = apperr.New(apperr.CodeInternal, "宿主能力内部错误").
				WithDetail("method", method).
				WithHint("这是平台缺陷；请在诊断页查看该应用的失败记录并反馈")
		}
	}()

	// abi.ping 是 **validate 干跑**用的存活探针（abi 包自带说明："不属于能力面"），
	// 因此它**不在** table 里，也不出现在 §5.1 封闭清单中 —— 但它同样要过事务闸门。
	var h handler
	if method != abi.MethodPing {
		var ok bool
		if h, ok = table[method]; !ok {
			return nil, unknownMethod(method)
		}
	}

	if c.DB != nil && c.DB.InTx() && !abi.TxAllowedWhileInTx(method) {
		return nil, txDenied(method)
	}

	if method == abi.MethodPing {
		return pingResult{Pong: true, ABI: abi.ABIVersion}, nil
	}

	out, e := h(c, ctx, params)
	if e != nil {
		return nil, e
	}
	if err := ctx.Err(); err != nil {
		return nil, apperr.New(apperr.CodeModuleKilled, "宿主调用返回时请求已被取消").
			WithDetail("method", method).
			WithCause(err)
	}
	return out, nil
}

// txDenied 是"事务内调用了不允许的能力"的拒绝形态（§4.4）。
//
// 错误码/文案要求（模块 H 审计）：必须指明**哪一类被禁**与**怎么改**。
//   - details.kind 是机器可读的分类（nested_tx / blocking_capability / ddl / probe_method / unknown）；
//   - details.reason 保持 host_call_in_tx（审计与本包既有用例的判据）；
//   - hints 给出该类别的具体出路，并统一回述允许集。
//
// 分类必须**覆盖全部被禁方法**（由 gate_test.go 的 TestTxDenialClassificationIsTotal
// 对拍 abi.HostMethods 断言）：新增宿主函数时若忘了想"它在事务里算什么"，门禁会红，
// 而不是静默回落到一句笼统的 unknown。
func txDenied(method string) *apperr.Error {
	kind := txDeniedKind(method)
	e := apperr.Newf(apperr.CodeDBDenied, "事务内不允许调用 %s", method).
		WithDetail("method", method).
		WithDetail("reason", "host_call_in_tx").
		WithDetail("kind", kind)
	switch kind {
	case txDeniedNested:
		e.WithHint("事务不可嵌套：先用 tx_commit / tx_rollback 结束当前事务，再开新事务")
	case txDeniedDDL:
		e.WithHint("db.define（DDL）请在事务外做：事务内只允许 db.query / db.exec")
	case txDeniedBlocking:
		e.WithHint("log / assets.read 会长时间阻塞或占满执行槽（§4.4）：先 tx_commit / tx_rollback 再做这些事")
	case txDeniedProbe:
		e.WithHint("abi.ping 是 validate 干跑探针（不属于能力面），事务内同样不允许：先 tx_commit / tx_rollback")
	default:
		e.WithHint("事务内只允许数据库读写：db.query / db.exec 与 tx_commit / tx_rollback")
	}
	return e.WithHint("db.tx 内只允许数据库读写：db.query / db.exec + tx_commit / tx_rollback")
}

// 事务内拒绝的类别（错误文案与 details.kind 用）。
const (
	txDeniedNested   = "nested_tx"
	txDeniedBlocking = "blocking_capability"
	txDeniedDDL      = "ddl"
	txDeniedProbe    = "probe_method"
	txDeniedUnknown  = "unknown"
)

// txDeniedKind 把"被禁方法"归类（见 txDenied 的覆盖性要求）。
func txDeniedKind(method string) string {
	switch method {
	case abi.MethodTxBegin:
		return txDeniedNested
	case abi.MethodLog, abi.MethodAssetsRead:
		return txDeniedBlocking
	case abi.MethodDBDefine:
		return txDeniedDDL
	case abi.MethodPing:
		// 协议内建探针：不是"能力"，但同样受事务闸门约束（§4.4 无例外）。
		return txDeniedProbe
	default:
		// 兜底：正常路径到不了（未注册方法在闸门之前就被 HOST_METHOD_UNKNOWN 拒了）。
		return txDeniedUnknown
	}
}

// pingResult 是 abi.ping 的应答（干跑用它验证"能读帧、能应答"）。
type pingResult struct {
	Pong bool   `json:"pong"`
	ABI  string `json:"abi"`
}

// unknownMethod 是"应用调用了不存在的宿主函数"的拒绝形态（§10.6 第 68 项）。
//
// 错误码选择：设计文档的 §7.4 表**没有**为这一项规定错误码（见交付说明）。
// 这里用 VALIDATION（400 语义）：调用方给的方法名不合法，属于"请求内容错"，
// 而不是权限/资源问题；并把方法名放进 details.method，让 AI 一眼看出拼错在哪。
func unknownMethod(method string) *apperr.Error {
	// 用专属码 HOST_METHOD_UNKNOWN（§10.6 第 68 项）：§7.4 表里没有这一行，
	// 但把它压成通用 VALIDATION 会让应用无法区分"我调错了方法名"与"我的参数不合法"，
	// 而错误码的第一消费者是 AI（§8）—— 指错方向就等于没有提示。
	return apperr.Newf(apperr.CodeHostMethodUnknown, "不存在的宿主函数 %q", method).
		WithDetail("method", method).
		WithDetail("reason", "unknown_method").
		WithHint("可用能力只有：" + strings.Join(abi.HostMethods, ", ")).
		WithHint("平台不提供文件、网络、PRAGMA、ATTACH、DDL、员工目录等能力（§5.1 封闭清单）")
}

// ===== 参数解析 =====

// decodeParams 严格解析宿主调用参数。
//
// 严格体现在两点：**未知字段即拒**（拼错 `sqls` 不会被静默忽略成空 SQL）、
// **类型不符即拒**（不 panic、也不做隐式转换）。两者都给出可读错误 + 字段名。
func decodeParams[T any](method string, raw json.RawMessage) (T, *apperr.Error) {
	var v T
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || string(trimmed) == "null" {
		return v, nil
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		return v, badParams(method, "参数字段不合法", err)
	}
	// 顶层多余内容（两个 JSON 值）也拒：说明应用把两个请求粘在了一起。
	if dec.More() {
		return v, badParams(method, "参数在 JSON 值之后还有多余内容", nil)
	}
	return v, nil
}

func badParams(method, msg string, cause error) *apperr.Error {
	e := apperr.New(apperr.CodeValidation, msg).
		WithDetail("method", method).
		WithHint("参数是一个 JSON 对象，字段名见 skill 里的宿主函数清单")
	if cause != nil {
		e.WithCause(cause)
		if f := fieldFromJSONError(cause.Error()); f != "" {
			e.WithDetail("field", f)
		}
	}
	return e
}

var (
	unknownFieldRe = regexp.MustCompile(`unknown field "([^"]+)"`)
	structFieldRe  = regexp.MustCompile(`struct field [^. ]+\.([A-Za-z0-9_]+)`)
)

// fieldFromJSONError 从 encoding/json 的英文错误里抠出字段名（只为让报错可读；
// 抠不出来就不带 field，不影响拒绝本身）。
func fieldFromJSONError(msg string) string {
	if m := unknownFieldRe.FindStringSubmatch(msg); len(m) == 2 {
		return m[1]
	}
	if m := structFieldRe.FindStringSubmatch(msg); len(m) == 2 {
		return m[1]
	}
	return ""
}

// ===== 各能力实现 =====

func (c *Capabilities) callDBDefine(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	p, e := decodeParams[abi.DBDefineParams](abi.MethodDBDefine, raw)
	if e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodDBDefine)
	}
	res, err := c.DB.Define(ctx, p)
	if err != nil {
		return nil, apperr.From(err)
	}
	return res, nil
}

func (c *Capabilities) callDBQuery(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	p, e := decodeParams[abi.SQLParams](abi.MethodDBQuery, raw)
	if e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodDBQuery)
	}
	res, err := c.DB.Query(ctx, p)
	if err != nil {
		return nil, apperr.From(err)
	}
	return res, nil
}

func (c *Capabilities) callDBExec(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	p, e := decodeParams[abi.SQLParams](abi.MethodDBExec, raw)
	if e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodDBExec)
	}
	res, err := c.DB.Exec(ctx, p)
	if err != nil {
		return nil, apperr.From(err)
	}
	return res, nil
}

func (c *Capabilities) callTxBegin(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	// tx_begin 不带参数：给空结构体做严格解析，多余字段即拒。
	if _, e := decodeParams[struct{}](abi.MethodTxBegin, raw); e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodTxBegin)
	}
	res, err := c.DB.Begin(ctx)
	if err != nil {
		return nil, apperr.From(err)
	}
	return res, nil
}

func (c *Capabilities) callTxCommit(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	p, e := decodeParams[abi.TxParams](abi.MethodTxCommit, raw)
	if e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodTxCommit)
	}
	if err := c.DB.Commit(ctx, p); err != nil {
		return nil, apperr.From(err)
	}
	return txDoneResult{Committed: true}, nil
}

func (c *Capabilities) callTxRollback(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	p, e := decodeParams[abi.TxParams](abi.MethodTxRollback, raw)
	if e != nil {
		return nil, e
	}
	if c.DB == nil {
		return nil, capabilityUnavailable(abi.MethodTxRollback)
	}
	if err := c.DB.Rollback(ctx, p); err != nil {
		return nil, apperr.From(err)
	}
	return txDoneResult{Committed: false}, nil
}

// txDoneResult 是 tx_commit / tx_rollback 的应答（abi 只给 TxParams/TxResult，
// 没有为控制类方法定义结果结构；这里回一个最小、稳定的对象）。
type txDoneResult struct {
	Committed bool `json:"committed"`
}

// ⚠️ `callAIChat` 已随 W4 删除（总纲 §21.3）：它是 `ai.chat` 的宿主实现，
// 连同 `Capabilities.AI` 字段、`capapi.AI` 接口与 internal/wasmapp/aichat 整包一起消失。
// 应用侧的新形态见 abi.go 的 `MethodAIChat` 删除注释（客户端 AI loop，§21.2）。

func (c *Capabilities) callLog(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	if err := ctx.Err(); err != nil {
		return nil, apperr.New(apperr.CodeModuleKilled, "请求已取消").WithCause(err)
	}
	p, e := decodeParams[abi.LogParams](abi.MethodLog, raw)
	if e != nil {
		return nil, e
	}
	level := strings.TrimSpace(p.Level)
	if level == "" {
		level = DefaultLogLevel
	}
	// 单条 ≤ 4 KiB：**截断而不是拒**（§5.1）—— 为了日志太长让应用失败不划算。
	msg := truncateUTF8(p.Message, limits.LogMaxLineBytes)

	c.mu.Lock()
	defer c.mu.Unlock()
	accepted := 0
	if c.logAccepted >= limits.LogMaxPerRequest {
		// 每请求 ≤ 100 条：超出丢弃并计数（§5.1）。
		c.logDropped++
	} else {
		c.logAccepted++
		accepted = 1
		if c.Logs != nil {
			c.Logs.Log(level, msg)
		} else {
			// 没有日志目的地：调用成功但计入 dropped，应用据此能看出日志被丢。
			c.logDropped++
		}
	}
	dropped := c.logDropped
	if c.Logs != nil && c.Logs.Dropped() > dropped {
		// sink 自己也丢（缓冲区满等）：回给应用的数字取两者较大值 ——
		// 绝不报告"比实际丢弃更少"的条数。
		dropped = c.Logs.Dropped()
	}
	return abi.LogResult{Accepted: accepted, Dropped: dropped}, nil
}

func (c *Capabilities) callAssetsRead(ctx context.Context, raw json.RawMessage) (any, *apperr.Error) {
	if err := ctx.Err(); err != nil {
		return nil, apperr.New(apperr.CodeModuleKilled, "请求已取消").WithCause(err)
	}
	p, e := decodeParams[abi.AssetsReadParams](abi.MethodAssetsRead, raw)
	if e != nil {
		return nil, e
	}
	if strings.TrimSpace(p.Path) == "" {
		return nil, apperr.New(apperr.CodeValidation, "assets.read 的 path 不能为空").
			WithDetail("method", abi.MethodAssetsRead).
			WithDetail("field", "path").
			WithHint("path 是包内逻辑路径，如 picoaide.app.json / index.html / static/app.css")
	}
	if c.Assets == nil {
		return nil, capabilityUnavailable(abi.MethodAssetsRead)
	}
	contentType, data, err := c.Assets.Read(p.Path)
	if err != nil {
		return nil, apperr.From(err)
	}
	// 纵深防御：单文件上限与自定义段总量同源（§4.2）；实现方（内存资源集 assets.Set）
	// 已经拦过一次，这里再拦一次是因为 Assets 是可替换的接口。
	// 错误码与实现方**同码**（ASSET_OVERSIZE）：同一个条件不能因为"谁先发现"
	// 而给出两个不同的码（模块 H 审计 FIX-6 的同族问题就是码与现实脱节）。
	if len(data) > limits.SectionTotalMaxBytes {
		return nil, apperr.New(apperr.CodeAssetOversize, "资源超过单文件上限").
			WithDetail("path", p.Path).
			WithDetail("size", len(data)).
			WithDetail("max", limits.SectionTotalMaxBytes)
	}
	// abi.AssetsReadResult 的 Encoding 是**判别字段（必填）**，必须在这里落定
	// （模块 H 审计 P1-2：此前从不写 ⇒ wire 上恒为 ""，于是"零字节资源"与
	// "内容为空串的文本资源"返回逐字节相同的 JSON，正是该字段要消灭的歧义）。
	//
	// 三分支与 abi.Encoding* 常量一一对应：零字节 ⇒ empty（此时 Text/Base64 都是
	// 空串，靠 Encoding 才能与"空文本"区分）；文本 ⇒ text；其余 ⇒ base64。
	res := abi.AssetsReadResult{ContentType: contentType, Size: len(data)}
	switch {
	case len(data) == 0:
		res.Encoding = abi.EncodingEmpty
	case assets.TextPayload(contentType, data):
		res.Encoding = abi.EncodingText
		res.Text = string(data)
	default:
		res.Encoding = abi.EncodingBase64
		res.Base64 = assets.Base64(data)
	}
	return res, nil
}

// capabilityUnavailable 是"宿主没装配该能力"的形态：属于平台装配缺陷，
// 不是应用的错 ⇒ INTERNAL（绝不伪装成"应用无权"或"资源不存在"）。
func capabilityUnavailable(method string) *apperr.Error {
	return apperr.New(apperr.CodeInternal, "宿主能力未装配").
		WithDetail("method", method).
		WithHint("这是平台装配缺陷（runtime 未注入该能力）；请反馈给平台维护者")
}

// truncateUTF8 按**字节**上限截断，但不切断 UTF-8 字符（截到字符边界，
// 否则 JSON 编码会把半个字符换成 U+FFFD，作者看到的日志尾部是乱码）。
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := s[:max]
	for len(cut) > 0 && !utf8.ValidString(cut) {
		cut = cut[:len(cut)-1]
	}
	return cut
}
