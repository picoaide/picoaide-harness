package main

// S3-02 的**对账判据**（审计 2026-10-04，P2）：启动路径上被启动的调度器集合，必须与
// 调度器状态表（scheduler_status.go 的 registry）的登记集合**双向相等**。
//
// 缺陷现场：`main.go` 启动了 9 条周期执行者，而状态表只有 6 条 —— 启动/关停日志的注释
// 却写着"**全部**后台调度器"。运维据此做"调度器是不是都起来了"的一次性核对会拿到
// **错误的全集**，而漏掉的三条（网关文件回收 / 审计保留 / usage 保留）恰好都是
// "死了只有沉默"的清理类：不作声、不报错，与"本来就没变化"在运维面上同形。
//
// 为什么需要这样一条判据（而不是各写各的用例）：R19B-05 与 R6-A-2 两次修复都只覆盖
// **当次发现的那几条**（reports/balance 有 assertRegistered，model_sync/directory_sync
// 各自有用例），没有任何一条判据回答"**还有没有下一条**"。本用例把判据面提到集合层：
//
//	方向 1（缺项 ⇒ 红）：`main()` 里每个 `start*Scheduler` / `start*Reaper` 调用
//	                     都必须有一条对应的登记实现；
//	方向 2（死条目 ⇒ 红）：登记表里的每一条都必须在 `main()` 里真的被调用；
//	方向 3（接线 ⇒ 红）：逐条**真的调用**那个接缝（构造点换成桩），断言它确实往
//	                     registry 里登记了声明中的名字 / tick / 读数来源 ——
//	                     "函数存在"不等于"它登记了"（本仓登记过的"有能力没接线"形态）。
//
// 判据自己也不许静默空转：`main()` 里一条 start* 调用都扫不到时**直接红**（扫描面为空
// 是失败，不是通过）。

import (
	"context"
	"database/sql"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/picoaide/picoaide/internal/auditchain"
	"github.com/picoaide/picoaide/internal/auditretention"
	"github.com/picoaide/picoaide/internal/llmgateway"
	"github.com/picoaide/picoaide/internal/tokenretention"
	"github.com/picoaide/picoaide/internal/usageretention"
)

// schedulerSeamPattern 匹配"启动一条后台周期执行者"的装配接缝名。
//
// 判据面 = 名字形状（`start…Scheduler` / `start…Reaper`）+ 调用点（main() 体内）。
// 新加的调度器接缝若**不叫这个名字**，方向 1 看不见它 —— 这是本判据已知的边界，
// 所以其它守卫（route/装配类）仍然保留各自的"禁裸循环"断言；这里只保证
// "按既有命名惯例新增的调度器"不会漏登记。
var schedulerSeamPattern = regexp.MustCompile(`^start[A-Za-z0-9]*(Scheduler|Reaper)$`)

// schedulerSeamCase 是一条装配接缝与它在状态表里的登记之间的**声明式**对应。
type schedulerSeamCase struct {
	fn      string                                        // main.go 里的装配调用名
	name    string                                        // schedulerStatuses() 里的登记名
	tick    time.Duration                                 // 装配传入的间隔常量
	start   func(context.Context, *sql.DB, time.Duration) // 接缝本体
	metrics bool                                          // 该子系统是否发布运行读数
	source  string                                        // 声明中的读数来源
	stub    func(t *testing.T)                            // 把构造点换成桩（避免真起后台循环）
}

// stubSchedulerStarter 是 schedulerStarter 的测试桩（auditretention / usageretention
// 的构造点返回这个最小面）。
type stubSchedulerStarter struct{ calls int }

func (s *stubSchedulerStarter) Start(context.Context) { s.calls++ }

// swapVar 临时替换一个包级构造点（用例结束自动还原）。
func swapVar[T any](t *testing.T, target *T, replacement T) {
	t.Helper()
	prev := *target
	*target = replacement
	t.Cleanup(func() { *target = prev })
}

// schedulerSeams 是全部**启动路径上**的调度器接缝（新增一条必须同时加进这里，
// 否则方向 1 报红）。
var schedulerSeams = []schedulerSeamCase{
	{
		fn: "startGatewayFileReaper", name: schedulerGatewayFileReaper, tick: llmgateway.FileReaperInterval,
		start: startGatewayFileReaper, metrics: false, source: schedulerSourceStartOnly,
		stub: func(t *testing.T) {
			swapVar(t, &startFileReaper, func(context.Context, *sql.DB, time.Duration) {})
		},
	},
	{
		fn: "startReportsScheduler", name: schedulerReports, tick: reportsSchedulerTick,
		start: startReportsScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newReportsScheduler,
				func(*sql.DB, time.Duration, func() time.Time) observableScheduler {
					return &stubObservableScheduler{tick: reportsSchedulerTick, start: make(chan struct{})}
				})
		},
	},
	{
		fn: "startBalanceScheduler", name: schedulerBalance, tick: balanceSchedulerTick,
		start: startBalanceScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newBalanceScheduler,
				func(*sql.DB, time.Duration, func() time.Time) observableScheduler {
					return &stubObservableScheduler{tick: balanceSchedulerTick, start: make(chan struct{})}
				})
		},
	},
	{
		fn: "startModelSyncScheduler", name: schedulerModelSync, tick: modelSyncTick,
		start: startModelSyncScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newModelSyncScheduler, func(*sql.DB, time.Duration) observableScheduler {
				return &stubObservableScheduler{tick: modelSyncTick, start: make(chan struct{})}
			})
		},
	},
	{
		fn: "startDirectorySyncScheduler", name: schedulerDirectorySync, tick: directorySyncTick,
		start: startDirectorySyncScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newDirectorySyncScheduler, func(*sql.DB, time.Duration) observableScheduler {
				return &stubObservableScheduler{tick: directorySyncTick, start: make(chan struct{})}
			})
		},
	},
	{
		fn: "startAuditRetentionScheduler", name: schedulerAuditRetention, tick: auditretention.DefaultTick,
		start: startAuditRetentionScheduler, metrics: false, source: schedulerSourceStartOnly,
		stub: func(t *testing.T) {
			swapVar(t, &newAuditRetentionScheduler,
				func(*sql.DB, time.Duration, func() time.Time) schedulerStarter { return &stubSchedulerStarter{} })
		},
	},
	{
		fn: "startUsageRetentionScheduler", name: schedulerUsageRetention, tick: usageretention.DefaultTick,
		start: startUsageRetentionScheduler, metrics: true, source: schedulerSourceUsageRetention,
		stub: func(t *testing.T) {
			swapVar(t, &newUsageRetentionScheduler,
				func(*sql.DB, time.Duration) schedulerStarter { return &stubSchedulerStarter{} })
		},
	},
	{
		fn: "startTokenRetentionScheduler", name: schedulerTokenRetention, tick: tokenretention.DefaultTick,
		start: startTokenRetentionScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newTokenRetentionScheduler, func(*sql.DB, time.Duration) observableScheduler {
				return &stubObservableScheduler{tick: tokenretention.DefaultTick, start: make(chan struct{})}
			})
		},
	},
	{
		fn: "startAuditChainScheduler", name: schedulerAuditChain, tick: auditchain.DefaultTick,
		start: startAuditChainScheduler, metrics: true, source: schedulerSourceSelf,
		stub: func(t *testing.T) {
			swapVar(t, &newAuditChainScheduler, func(*sql.DB, time.Duration) observableScheduler {
				return &stubObservableScheduler{tick: auditchain.DefaultTick, start: make(chan struct{})}
			})
			// 该接缝的间隔可被 env 覆盖 —— 判据不依赖运行环境（t.Setenv 会被
			// t.Cleanup 还原，顺序晚于 swapVar 也无妨：只影响解析结果）。
			t.Setenv(auditChainIntervalEnv, "")
		},
	},
}

// schedulersStartedOnMainPath 从 main.go 的 AST 枚举 `func main()` 里被调用的调度器接缝。
func schedulersStartedOnMainPath(t *testing.T) map[string]bool {
	t.Helper()
	src, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, "main.go", src, 0)
	if err != nil {
		t.Fatalf("parse main.go: %v", err)
	}
	var body *ast.BlockStmt
	for _, decl := range f.Decls {
		fd, ok := decl.(*ast.FuncDecl)
		if ok && fd.Recv == nil && fd.Name.Name == "main" {
			body = fd.Body
		}
	}
	if body == nil {
		t.Fatal("main.go 里找不到 func main() 的函数体 —— 判据的锚点漂移，不得静默通过")
	}
	out := map[string]bool{}
	ast.Inspect(body, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		id, ok := call.Fun.(*ast.Ident)
		if !ok {
			return true
		}
		if schedulerSeamPattern.MatchString(id.Name) {
			out[id.Name] = true
		}
		return true
	})
	return out
}

// TestSchedulerRegistryReconcilesWithStartupAssembly 是 S3-02 的对账判据（详见文件头）。
func TestSchedulerRegistryReconcilesWithStartupAssembly(t *testing.T) {
	started := schedulersStartedOnMainPath(t)
	if len(started) == 0 {
		t.Fatal("main() 里一条 start*Scheduler / start*Reaper 调用都扫不到 —— 扫描面为空，" +
			"本判据会退化成恒真，绝不当通过（要么装配真的没了，要么命名惯例变了，两种都要人来看）")
	}

	declared := map[string]bool{}
	for _, tc := range schedulerSeams {
		declared[tc.fn] = true
	}

	// 方向 1：启动路径上的每条接缝都必须进登记表。
	var missing []string
	for fn := range started {
		if !declared[fn] {
			missing = append(missing, fn)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Fatalf("main() 启动了这些调度器接缝，但登记表（schedulerSeams）里没有：%s\n"+
			"  后果：它们的运行状态**不进** schedulerStatuses()，启动/关停日志里的『全部调度器』"+
			"是错误的全集（S3-02 的原缺陷形态）。请在 schedulerSeams 里补一条（含登记名/间隔/"+
			"读数来源），并确认接缝真的调用 registerSchedulerStatus 或 registerStartOnlyScheduler。",
			strings.Join(missing, ", "))
	}

	// 方向 2：登记表里不许有"死条目"（登记了却没被启动）+ 每条都必须落在 main() 的
	// **静态可达**路径上（`if false { … }` 里的调用不算 —— R21C-04 的教训）。
	var dead []string
	for _, tc := range schedulerSeams {
		if !started[tc.fn] {
			dead = append(dead, tc.fn)
		}
	}
	sort.Strings(dead)
	if len(dead) > 0 {
		t.Fatalf("登记表里的这些接缝在 main() 里**没有被调用**（死条目）：%s\n"+
			"  要么补回装配调用，要么从登记表里删掉 —— 死条目会让本判据空转。",
			strings.Join(dead, ", "))
	}
	for _, tc := range schedulerSeams {
		requireAssemblyOnMainPath(t, tc.fn+"(", "调度器接缝不在启动路径上")
	}

	// 方向 2 的时序面：每条接缝都必须排在 `logSchedulerStatuses("startup")` **之前** ——
	// 启动日志是运维重启后第一眼核对"调度器是不是都起来了"的那份快照，排在它后面的
	// 登记不会出现在快照里（R6-A-2 的可观测面正好丢掉要观测的东西）。
	text := mainGoCodeOnly(t)
	startupLogAt := strings.Index(text, `logSchedulerStatuses("startup")`)
	if startupLogAt < 0 {
		t.Fatal("main.go 里找不到 logSchedulerStatuses(\"startup\") —— 调度器状态没有启动出口")
	}
	for _, tc := range schedulerSeams {
		at := strings.Index(text, tc.fn+"(")
		if at < 0 {
			t.Fatalf("main() 里找不到 %s 的调用（装配源码判据与 AST 判据不一致）", tc.fn)
		}
		if at > startupLogAt {
			t.Fatalf("%s 排在 logSchedulerStatuses(\"startup\") 之后 —— 启动状态快照会漏掉它"+
				"（运维核对『全部调度器』时看不到这一条）", tc.fn)
		}
	}

	// 方向 3：逐条**真的调用**接缝，断言它登记出了声明中的那一条。
	seenNames := map[string]bool{}
	for _, tc := range schedulerSeams {
		tc := tc
		t.Run(tc.fn, func(t *testing.T) {
			if seenNames[tc.name] {
				t.Fatalf("登记名 %q 被两条接缝共用 —— 后登记的那条会覆盖前一条的读数", tc.name)
			}
			seenNames[tc.name] = true

			resetSchedulerStatus(t)
			tc.stub(t)
			db := placeholderDB(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()

			tc.start(ctx, db, tc.tick)

			statuses := schedulerStatuses()
			if len(statuses) != 1 {
				t.Fatalf("调用接缝后状态表条目数 = %d, want 1（接缝没有登记，或登记了多余条目）", len(statuses))
			}
			st := statuses[0]
			if st.Name != tc.name {
				t.Fatalf("登记名 = %q, want %q（接缝与登记表漂移）", st.Name, tc.name)
			}
			if st.Tick != tc.tick {
				t.Fatalf("%s: tick = %v, want %v（登记的不是装配真正传进去的间隔）", tc.name, st.Tick, tc.tick)
			}
			if !st.Started {
				t.Fatalf("%s: started=false —— 接缝登记了却没有真的启动它（S3-02 要防的正是这个）", tc.name)
			}
			if st.StartedAt.IsZero() {
				t.Fatalf("%s: started_at 为空 —— 启动时刻没有记账", tc.name)
			}
			if st.MetricsAvailable != tc.metrics {
				t.Fatalf("%s: metrics_available = %v, want %v —— 读数可得性必须如实登记"+
					"（子系统不发布读数时填 0 冒充 = 把『读不到』伪装成『没跑过』）",
					tc.name, st.MetricsAvailable, tc.metrics)
			}
			if st.Source != tc.source {
				t.Fatalf("%s: readings 来源 = %q, want %q", tc.name, st.Source, tc.source)
			}
			// 读数不可得的条目：日志里必须渲染 unavailable，而不是 0。
			line := schedulerStatusLine("startup", st)
			if !st.MetricsAvailable && !strings.Contains(line, "runs=unavailable") {
				t.Fatalf("%s: 读数不可得，但日志行把它渲染成了具体数字（运维会读成『跑过 0 轮』）：%s",
					tc.name, line)
			}
			if st.MetricsAvailable && !strings.Contains(line, "runs=") {
				t.Fatalf("%s: 日志行缺 runs 字段：%s", tc.name, line)
			}

			// nil db：与其它装配接缝同口径（无 DB 启动不 panic，也不留一条假装在跑的条目）。
			tc.start(context.Background(), nil, tc.tick)
			if got := len(schedulerStatuses()); got != 1 {
				t.Fatalf("nil db 下接缝又登记了一条（条目数 = %d, want 1）—— 无 DB 启动会多出幽灵条目", got)
			}
		})
	}
}
