// Package diag 是 WASM 应用平台**诊断 API 的数据面**(设计基线 §4.9 / §8):
// 按应用聚合最近的失败与被杀记录,把结构化错误码 + 可操作 hints 交给调用方。
//
// 为什么 hints 是产品的一部分而不是文案:§4.9 明写"第一消费者是 AI" ——
// 应用作者(或替他排障的 AI)拿到的不是"失败了",而是"下一步改什么"。
// 因此 hint 里出现的数值一律引用 limits 常量(数值单一真源,§5.5),
// 不在这里手写"10 秒""5000 行"。
package diag

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/limits"
)

// Failure 是一条失败/被杀记录(§4.9:诊断必须带 guest exit code 与 stderr 尾巴)。
type Failure struct {
	CreatedAt     time.Time `json:"created_at"`
	Outcome       string    `json:"outcome"`
	ReasonCode    string    `json:"reason_code"`
	GuestExitCode int32     `json:"guest_exit_code"`
	StderrTail    string    `json:"stderr_tail"`
	CPUMs         int64     `json:"cpu_ms"`
	PeakMemory    int64     `json:"peak_memory_bytes"`
}

// ReasonCount 是一个失败码的计数 + 它的可操作 hints。
type ReasonCount struct {
	ReasonCode string   `json:"reason_code"`
	Count      int64    `json:"count"`
	Hints      []string `json:"hints"`
}

// AppSummary 是一个应用在时间窗口内的失败概览。
//
// 类型名不叫 Summary 是因为 Go 不允许**类型与函数同名**,而函数名
// Summary 是模块间约定的调用入口(调用方通常用 `:=` 接结果,不显式写类型名)。
type AppSummary struct {
	AppID string    `json:"app_id"`
	Since time.Time `json:"since"`
	// Total 是窗口内全部调用数;Failed = Error + Killed(非 ok 即失败)。
	Total  int64 `json:"total"`
	OK     int64 `json:"ok"`
	Error  int64 `json:"error"`
	Killed int64 `json:"killed"`
	Failed int64 `json:"failed"`
	// Reasons 按次数降序(次数相同按错误码升序,保证输出稳定可比)。
	Reasons []ReasonCount `json:"reasons"`
	// Hints 是按 Reasons 顺序去重后的可操作建议(去重:同一 hint 不重复刷屏)。
	Hints              []string   `json:"hints"`
	MaxCPUMs           int64      `json:"max_cpu_ms"`
	MaxPeakMemoryBytes int64      `json:"max_peak_memory_bytes"`
	MaxQueueWaitMS     int64      `json:"max_queue_wait_ms"`
	LastFailureAt      *time.Time `json:"last_failure_at"`
}

// clampLimit 把调用方给的条数收敛到 limits 声明的默认值/上限:
// limit ≤ 0 = 默认,超过上限 = 上限(诊断接口绝不能因为一次 limit=1e9 拉全表)。
func clampLimit(limit int) int {
	if limit <= 0 {
		return limits.DiagnosticsDefaultLimit
	}
	if limit > limits.DiagnosticsMaxLimit {
		return limits.DiagnosticsMaxLimit
	}
	return limit
}

// requireAppID 拦住空 app_id:调用事件表按 app_id 分区语义查询,空串会把
// "某个应用的诊断"静默变成"全局诊断"(跨应用泄露 + 结果无意义)。
func requireAppID(appID string) error {
	if appID == "" {
		return errors.New("diag: app_id 不能为空")
	}
	return nil
}

// RecentFailures 返回某个应用最近的失败与被杀记录(最新在前)。
// limit ≤ 0 取 limits.DiagnosticsDefaultLimit,超过 limits.DiagnosticsMaxLimit 截断。
func RecentFailures(ctx context.Context, db *sql.DB, appID string, limit int) ([]Failure, error) {
	if err := requireAppID(appID); err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT created_at, outcome, reason_code, guest_exit_code,
		stderr_tail, cpu_ms, peak_memory_bytes
		FROM wasm_call_events
		WHERE app_id = $1 AND outcome <> $2
		ORDER BY created_at DESC, id DESC
		LIMIT $3`, appID, outcomeOK, clampLimit(limit))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Failure{}
	for rows.Next() {
		var f Failure
		var created time.Time
		if err := rows.Scan(&created, &f.Outcome, &f.ReasonCode, &f.GuestExitCode,
			&f.StderrTail, &f.CPUMs, &f.PeakMemory); err != nil {
			return nil, err
		}
		f.CreatedAt = created
		out = append(out, f)
	}
	return out, rows.Err()
}

// outcomeOK 是"成功"的唯一判定值(diag 只看"是不是 ok",其余一律算失败 ——
// 调用事件表刻意没有 outcome 的 CHECK 枚举,词汇表漂移时也要能看见)。
const outcomeOK = "ok"

// Summary 聚合某个应用自 since 以来的调用结果(§4.9 诊断 API)。
// since 必须由调用方显式给出:诊断窗口是审计口径的一部分,不能隐式取 now。
func Summary(ctx context.Context, db *sql.DB, appID string, since time.Time) (AppSummary, error) {
	out := AppSummary{AppID: appID, Since: since, Reasons: []ReasonCount{}, Hints: []string{}}
	if err := requireAppID(appID); err != nil {
		return out, err
	}
	rows, err := db.QueryContext(ctx, `SELECT outcome, reason_code, count(*),
		max(cpu_ms), max(peak_memory_bytes), max(queue_wait_ms), max(created_at)
		FROM wasm_call_events
		WHERE app_id = $1 AND created_at >= $2
		GROUP BY outcome, reason_code`, appID, since.UTC())
	if err != nil {
		return out, err
	}
	defer rows.Close()
	// reasons 先按错误码累积(同一错误码可能出现在 error 与 killed 两种 outcome 上),
	// 最后统一排序,避免"同一个码在列表里出现两次"。
	type bucket struct {
		count int64
	}
	perReason := map[string]*bucket{}
	for rows.Next() {
		var outcome, reason string
		var n, maxCPU, maxMem, maxQueue int64
		var last time.Time
		if err := rows.Scan(&outcome, &reason, &n, &maxCPU, &maxMem, &maxQueue, &last); err != nil {
			return out, err
		}
		out.Total += n
		switch outcome {
		case outcomeOK:
			out.OK += n
		case "killed":
			out.Killed += n
		default:
			out.Error += n
		}
		if outcome != outcomeOK {
			out.Failed += n
			if out.LastFailureAt == nil || last.After(*out.LastFailureAt) {
				t := last
				out.LastFailureAt = &t
			}
			if b, ok := perReason[reason]; ok {
				b.count += n
			} else {
				perReason[reason] = &bucket{count: n}
			}
		}
		if maxCPU > out.MaxCPUMs {
			out.MaxCPUMs = maxCPU
		}
		if maxMem > out.MaxPeakMemoryBytes {
			out.MaxPeakMemoryBytes = maxMem
		}
		if maxQueue > out.MaxQueueWaitMS {
			out.MaxQueueWaitMS = maxQueue
		}
	}
	if err := rows.Err(); err != nil {
		return out, err
	}
	for code, b := range perReason {
		out.Reasons = append(out.Reasons, ReasonCount{ReasonCode: code, Count: b.count, Hints: HintsFor(code)})
	}
	// 次数降序、同次数按错误码升序:输出稳定,便于 AI 与页面直接对比两次诊断。
	sortReasons(out.Reasons)
	seen := map[string]bool{}
	unmapped := false
	for _, r := range out.Reasons {
		if len(r.Hints) == 0 {
			unmapped = true
		}
		for _, h := range r.Hints {
			if !seen[h] {
				seen[h] = true
				out.Hints = append(out.Hints, h)
			}
		}
	}
	if unmapped {
		out.Hints = append(out.Hints,
			"有失败码没有对应的内置提示:把 stderr_tail 与 reason_code 一起交给 AI,并对照设计基线 §7.4 失败语义表")
	}
	return out, nil
}

func sortReasons(rs []ReasonCount) {
	for i := 1; i < len(rs); i++ {
		for j := i; j > 0; j-- {
			if rs[j-1].Count > rs[j].Count ||
				(rs[j-1].Count == rs[j].Count && rs[j-1].ReasonCode <= rs[j].ReasonCode) {
				break
			}
			rs[j-1], rs[j] = rs[j], rs[j-1]
		}
	}
}

// HintsFor 返回某个失败码的可操作提示(§4.9「结构化错误码 + hints」)。
// 未覆盖的码返回 nil(Summary 会补一条通用建议),不返回空串占位。
func HintsFor(reasonCode string) []string {
	hints, ok := hintTable[apperr.Code(reasonCode)]
	if !ok {
		return nil
	}
	out := make([]string, len(hints))
	copy(out, hints)
	return out
}

// hintTable 是失败码 → 可操作建议的唯一真源。每条都说"下一步改什么",
// 而不是复述错误码含义;涉及上限的数值一律由 limits 求值(§5.5 数值单一真源)。
var hintTable = map[apperr.Code][]string{
	apperr.CodeRuntimeTimeout: {
		fmt.Sprintf("guest 执行预算是 %s:把长任务拆成多次请求,不要在单次请求里做整批计算", limits.GuestBudget),
		"宿主调用(db.* / ai.chat)期间不计入 guest 计时 ⇒ 超时基本都是应用自己的循环没有收敛",
		"检查有没有无退出的重试循环;请求超时后实例被销毁,内存里的中间状态不会保留",
	},
	apperr.CodeRuntimeMemory: {
		fmt.Sprintf("单实例线性内存上限 %d MiB:不要一次性把大结果集读进内存", limits.InstanceMemoryPages*limits.WasmPageSize>>20),
		fmt.Sprintf("db.query 单次最多返回 %d 行 / %d MiB,更大的结果要分页(LIMIT/OFFSET)", limits.SQLMaxRows, limits.SQLMaxResultBytes>>20),
		"Go 运行时自身常驻数 MiB 堆,留给业务数据的内存比预期少;先在 db.query 里 WHERE 收窄再聚合",
	},
	apperr.CodeRuntimeGuestExit: {
		"guest 以非零码退出且没有写出响应帧:在返回/panic 之前用 log() 打点,定位最后执行到哪一步",
		"stderr_tail 里有原始输出;Go 的 os.Exit(非零) 与未 recover 的 panic 都会走到这里",
		"响应必须由应用写到 stdout 的协议帧里 —— 只 exit 不写帧等于把失败报成空响应",
	},
	apperr.CodeDBLimit: {
		fmt.Sprintf("触到 SQL 硬限(单语句 %s / %d 行 / %d MiB):先加 WHERE 与 LIMIT,再考虑分页", limits.SQLStatementBudget, limits.SQLMaxRows, limits.SQLMaxResultBytes>>20),
		fmt.Sprintf("应用库体积上限 %d MB:平台不提供扩容旋钮,需要自己删旧数据或做汇总表", limits.AppDBMaxBytes>>20),
		"一次只发一条语句(多语句一定被拒),复杂查询拆成多次 db.query",
	},
	apperr.CodeDBDenied: {
		"语句种类只允许 SELECT / INSERT / UPDATE / DELETE:DDL(建表/改表)一律拒,建表只能走 db.define",
		fmt.Sprintf("保留列 %s 由平台维护,应用提到即拒;每个应用的表数和列数都有上限", limits.ReservedRowIDColumn),
		"PRAGMA / ATTACH / 多语句 / 参数化缺失都会被拒:按 db.query(sql, args) 的参数化写法改",
	},
	apperr.CodeAppQueueFull: {
		fmt.Sprintf("每应用队列 %d、每用户同应用同时 1 个在跑 + 队列 %d 个、每用户跨应用在跑 %d 个:应用侧并发压到 1",
			limits.AppQueueDepth, limits.UserPerAppQueued, limits.UserGlobalRunning),
		fmt.Sprintf("收到 429 不要立刻重试(只会继续撞队列):按 Retry-After 退避,默认 %d 秒", limits.RetryAfterSeconds),
		"把多次小请求合并成一次请求,或在页面上提示稍后重试",
	},
	apperr.CodeAIBalanceInsufficient: {
		"使用者自己的余额不足:应用不要重试,直接在页面上提示本人去桌面客户端查看余额与用量",
		"平台不做应用级额度,AI 费用记在登录员工头上;提示语不要暴露具体余额数值",
		"确需继续使用:让使用者充值,或把 ai.chat 换成不必调模型的本地逻辑",
	},
	apperr.CodeRuntimeTrap: {
		"wasm trap(越界访问 / 除零 / unreachable):先看 stderr_tail 的原始 trap 信息",
		"Go 里 panic 必须先 recover 再写错误响应,否则 panic 直接变成 guest 退出",
	},
	apperr.CodeRuntimeNoResponse: {
		"guest 正常退出但没有写出响应帧:检查写响应的那条路径是否真的被执行(fd_write 的返回值是否被忽略)",
		"每个请求都必须写且只写一帧;提前 return 的分支同样要写",
	},
	apperr.CodeRuntimeOutputOverrun: {
		fmt.Sprintf("协议帧单行上限 %d MiB:不要把大对象一次性写进响应,分页或改走 db 查询", limits.ProtocolLineMaxBytes>>20),
		"应用响应体上限 %d MiB,超出的部分客户端也拿不到",
	},
	apperr.CodeHostCallOverBudget: {
		fmt.Sprintf("宿主调用超过预算(ai.chat %s):缩小输入或拆成多次调用", limits.HostAIChatBudget),
		"宿主调用必须带 ctx,超时后平台按失败处理且不会返回部分结果",
	},
	apperr.CodeAIRateLimited: {
		fmt.Sprintf("平台每用户 %d 次/分的网关限流:应用侧应串行 + 退避,不要并发扇出", limits.AIUserRatePerMin),
		fmt.Sprintf("每用户在途上限 %d:并发请求会被网关挡住,页面要给可读提示而不是白屏", limits.AIInFlightPerUser),
	},
	apperr.CodeAuthRequired: {
		"当前请求是匿名的(未登录):身份相关能力一律不可用",
		"需要身份时把应用配置的 access 设为 login 或 whitelist(改配置 = 发新版),或在页面上引导登录",
	},
	apperr.CodeAppFrozen: {
		"应用已被冻结(只读快照):这是平台管理员的处置动作,应用侧无法自行恢复",
		"需要解冻/导出请联系平台管理员;冻结期内请求一律被拒",
	},
	apperr.CodeModuleKilled: {
		"请求被宿主强制终止(超时或平台取消):按 RUNTIME_TIMEOUT 的路径排查,不要把它当成页面错误",
		"被杀的请求没有响应帧,客户端应显示可重试的提示",
	},
}
