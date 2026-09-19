package main

import (
	"context"
	"database/sql"
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/picoaide/picoaide/internal/serverstore"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/appproof"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/opens"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/upload"
)

// 环境变量（部署面）。
const (
	// EnvAppsExtraReserved 是部署期注入的**企业既有主机名 / 标识**（逗号分隔，§4.1）：
	// 应用标识曾等于域名标签，因此这些名字（如 intranet、oa）不得被应用占用。
	EnvAppsExtraReserved = "PICOAI_APPS_EXTRA_RESERVED"
)

// wasmPlatform 汇聚 WASM 应用平台的全部运行期组件。
type wasmPlatform struct {
	// AppServer 是客户端专属应用请求管线（身份由客户端注入）。
	AppServer *appserver.Server
	// API 是操作面 handler 集合（§8）。
	API *wasmapi.Handlers
	// Checker 是 /readyz 水位探针（§4.9）。
	Checker *readyz.Checker
	// Events 是调用事件 sink（§4.9）。
	Events *events.Sink
	// EventCleanup 是调用事件的 7 天保留期清理调度（§4.9/§5.3）。
	EventCleanup *events.CleanupScheduler
	// OpensCleanup 是打开计数的日汇总/过期清理调度（F16/§8.9）。
	OpensCleanup *opens.Scheduler
	// UploadCleanup 是分片上传会话的保留期回收调度（§4.2：会话有效期 30 分钟）。
	//
	// 不挂它的后果是**静默的**：断线客户端留下的会话目录会一直占盘，
	// 直到恰好有人再用同一个 upload_id 触发惰性回收。
	UploadCleanup *upload.CleanupScheduler
	// Compiler 是编译子系统（R31）。
	Compiler *compile.Compiler
	// Scheduler 是请求排队/准入（§4.6）。
	Scheduler *queue.Scheduler
	// Limits 是平台限制项的运行期持有者（控制台设置 > 部署档位 > 默认）。
	//
	// 暴露它是为了**装配级断言**（P0-2）：单实例内存上限这类字段只在装配期写一次，
	// 没有持有者就只能断言源码字符串（而字符串断言分不清"接上了但值是错的"）。
	Limits *wasmLimitsHolder

	lock *readyz.InstanceLock
}

// ⚠️ `normalizeLoopbackBaseURL` 已随 W4 删除：它唯一的消费者是服务端 `ai.chat`
// （宿主用 http.Client 直调本机 `/v1`）。服务端 AI 按总纲 §21 彻底删除之后，
// 平台上不再有任何"服务端自己调自己"的链路。

// compileUnavailableDetail 是编译子系统不可用时**对外**（/readyz 是未认证端点）
// 暴露的说明：只给一句定性，不回显底层错误（错误里带编译子进程路径与数据根路径）。
// 完整原因由启动日志承担。
const compileUnavailableDetail = "编译子系统不可用（发布链路已禁用），详见服务端启动日志"

// checkStartupMemory 执行 §4.3 的内存四笔账启动自检（返回非 nil ⇒ 调用方 log.Fatalf）。
//
// ⚠️ W4 起**没有"未启用"这一档**（审计 P2-8 的按 enabled 分档随应用子域一起删除）：
// 应用平台始终在服务（`/api/client/v2/apps/wasm/*` 无条件挂载），四笔账算的实例池/
// 编译峰值/上传峰值/缓存驻留随时会被用到 ⇒ 判据**全量生效**，这正是 §4.3 的原话
// "拒绝启动而不是等 OOM"。
//
// 判据**一点没放宽**：仍然是 fail-closed；
// 2026-09-18 起账本按**部署声明的内存档位**算（plan），而同一份档位也喂给 appserver
// 强制并发/实例上限/模块缓存/库句柄 —— 因此"自检算的账"与"实际跑的账"是同一份。
//
// 参数显式传入**读取结果**（而不是函数内部读 /proc）：让"极小 cgroup 剩余 ⇒ 拒绝启动 /
// 读不到 ⇒ 跳过"都能被确定性测到，不必真改 /proc/meminfo 或真造 cgroup。
//
// 读不到可用内存（Source=none）时**跳过判定但大声说**：这是"保留可部署性"的一半
// （非 Linux 开发机/受限容器不能让整个平台起不来），另一半是"绝不与内存充足同形"——
// 旧实现只做到前一半，于是读不到时控制台与 /readyz 都看不到任何异常（R1-rt-1）。
func checkStartupMemory(avail readyz.MemoryAvailability, plan readyz.MemoryPlan, logf func(format string, args ...any)) *apperr.Error {
	if !avail.Known() {
		logf("wasm: ⚠️ 未取到可用内存，跳过内存自检（来源=%s：%s）—— 保留可部署性，"+
			"但 /readyz 的 mem_source=none 与这条日志会如实反映它；"+
			"请核对部署真的给了 /proc/meminfo 或 cgroup 限额（读不到时四笔账不再判定）",
			avail.Source, avail.Detail)
		return nil
	}
	budget, berr := readyz.CheckStartupMemoryFor(avail.BudgetBytes(), plan)
	if berr != nil {
		return berr
	}
	logf("wasm: memory budget profile=%s instances=%dMB compile_peak=%dMB upload_peak=%dMB cache_resident=%dMB appdb_cache=%dMB total=%dMB available=%dMB limit=%dMB mem_source=%s（%s）",
		budget.Profile, budget.Instances>>20, budget.CompilePeak>>20, budget.UploadPeak>>20,
		budget.CacheResident>>20, budget.AppDBCache>>20, budget.Total>>20, budget.Available>>20,
		budget.Limit>>20, avail.Source, avail.Detail)
	return nil
}

// mustRefuseStartupForIsolation 判定"require 档但隔离不可用"（⇒ 调用方拒绝启动）。
//
// 判据用**结构化**字段（compile.IsolationStatus）而不是描述文案：require 的全部价值
// 就是 fail-closed，若判据建立在 `IsolationPlan()` 的措辞上，改一句话就会静默退化成
// "照常启动"（审计 P2-1 的现场形态：文档三处写"拒绝启动"，实际只有一行日志）。
func mustRefuseStartupForIsolation(mode compile.IsolationMode, usable bool) bool {
	return mode == compile.IsolationRequire && !usable
}

// wasmAppEvictor 是 OnAppEvict 需要的最小依赖面（*appserver.Server 满足它）。
//
// 抽成接口 + 具名构造函数（而不是内联闭包）是为了**可行为断言**：装配级用例可以
// 用一个记账假实现验证"钩子真的把处置转发了出去"，而不是像旧门禁那样 grep 源码里
// 有没有那行字符串 —— 字符串断言分不清"接上了"与"handler 从不调用"（P1-8 的现场）。
type wasmAppEvictor interface {
	EvictApp(appID string) (int, int64)
}

// newWasmAppEvictor 返回 api.Options.OnAppEvict 的装配实现：应用被下架/冻结/删除
// **成功之后**，立即丢掉它的进程内驻留（编译模块 + 库句柄），把内存还给 OS。
//
// 幂等与容错：空 app_id 直接忽略（不把空串送进缓存查找）；被逐出对象为空时
// EvictApp 自身是 no-op（见 appserver.EvictApp）。
func newWasmAppEvictor(srv wasmAppEvictor) func(string) {
	return func(appID string) {
		if srv == nil || strings.TrimSpace(appID) == "" {
			return
		}
		srv.EvictApp(appID)
	}
}

// setupWasmPlatform 装配 WASM 应用平台。
//
// **失败策略：装配期一律 log.Fatalf，绝不静默降级。** 设计里明确的 fail-closed
// 都在这里做：
//   - §4.3 内存四笔账自检（理论峰值 > 可用内存 70% ⇒ 拒绝启动）；
//   - `PICOAI_COMPILE_ISOLATION=require` 且隔离不可用 ⇒ 拒绝启动（R31 的严格档）；
//   - §15.1 第 9 条 / R20 单实例自检（advisory lock）；
//   - 渠道 `app_origin_scheme` 缺失/非法 ⇒ 拒绝启动（§8.3/§10，由调用方校验）。
//
// 理由：这几处的失败形态都是**静默的**（OOM 才崩、带着无隔离的编译进程对外服务、
// 两个副本各持一半票），"暂时跑起来但语义已坏"比"起不来"危险得多。
//
// ⚠️ W4 删除的三项装配：应用基域 holder（`EnvAppsBaseDomain` / 控制台设置）、
// R35 可信代理自检（`anonlimit`）、员工浏览器会话与换票（`session`）—— 它们都属于
// "应用有对外主机名"的旧模型；客户端专属模型下应用请求由客户端的协议 handler 合成。
func setupWasmPlatform(ctx context.Context, db *sql.DB, dataDir string) *wasmPlatform {
	// 客户端持有性证明（契约 §20/§23.1 A′）：签名密钥**启动期按部署生成、落数据根
	// 0600、绝不编入镜像**（appproof.KeyFileName）。失败即拒绝启动：拿不到签名密钥
	// 就无法签发 proof ⇒ 客户端**所有**应用请求 401，而"为什么"只会出现在启动日志里
	// （§23.1「启动期自检：私钥可读」）。
	proofSvc, perr := appproof.New(appproof.Options{DataRoot: dataDir})
	if perr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：持有性证明不可用：%v", perr)
	}
	log.Printf("app-proof: 签名密钥就绪 kid=%s（%s，0600；每部署一份，不随镜像分发）",
		proofSvc.KID(), filepath.Join(dataDir, appproof.KeyFileName))
	extraReserved := splitCSV(os.Getenv(EnvAppsExtraReserved))

	// ---- 内存档位（2026-09-18）：数值同时驱动下面的启动自检与运行期强制 ----
	// 未知档位名**拒绝启动**（静默回落默认会让小机器在"以为已降档"的状态下 OOM）。
	prof, perr := memprofile.FromEnv(os.Getenv)
	if perr != nil {
		log.Fatalf("WASM 应用平台内存档位配置错误：%v", perr)
	}
	// 平台限制项（并发/内存）：控制台设置 > 部署档位 > 编译期默认。
	// 自检与运行期强制都用**这一份**（见 wasmLimitsHolder 的注释）。
	limitsHolder := newWasmLimitsHolder(db, prof)
	plan := limitsHolder.Plan()
	log.Printf("wasm: 内存档位 %s；平台限制项来源=%s %s", prof.Report(), limitsHolder.Source(), limitsHolder.Get().Encode())

	// ---- §4.3：内存四笔账（实例池 + 编译峰值 + 上传峰值 + 缓存驻留）----
	// 账本按**本部署声明的档位**算：同一份数值也喂给 appserver（队列并发/实例上限/
	// 模块缓存/库句柄），因此"自检算的账"与"实际跑的账"是同一份。
	if berr := checkStartupMemory(readMemoryAvailability(), plan, log.Printf); berr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", berr)
	}

	// ---- §15.1 第 9 条 / R20：单实例（多副本的失败形态是静默的）----
	lock, lerr := readyz.AcquireInstanceLock(dataDir)
	if lerr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", lerr)
	}

	// 队列的全局并发取自档位（不是编译期常量）：声明与执行同一份数。
	qopt := queue.DefaultOptions()
	qopt.GlobalRunning = limitsHolder.Get().MaxInstances
	qopt.PerAppRunning = limitsHolder.Get().AppRunning
	qopt.PerAppQueue = limitsHolder.Get().AppQueue
	qopt.PerUserGlobalRunning = limitsHolder.Get().UserGlobalRunning
	qopt.PerUserPerAppRunning = limitsHolder.Get().UserPerAppRunning
	qopt.PerUserPerAppQueued = limitsHolder.Get().UserPerAppQueued
	scheduler := queue.New(qopt)
	eventSink := events.NewSink(db, events.Options{})
	eventSink.Start(ctx)

	// ---- §4.9/§5.3：调用事件的 7 天保留 ----
	// 这是平台**唯一**的无界磁盘增长路径（每应用请求一行，永不删除）：`Cleanup` 的 SQL
	// 一直是对的，但在本调度器出现前没有任何生产调用方（审计 P1-2）。启动即清一次 +
	// 每小时一次；删除计数进日志（可观测）。
	eventCleanup := events.NewCleanupScheduler(eventSink, events.CleanupSchedulerOptions{Logger: log.Printf})
	eventCleanup.Start(ctx)

	// 编译子系统缺一个可选的辅助二进制（picoaide-app-compile）不该让**整个**
	// 服务端起不来 —— 登录/网关/审计/客户端面都与它无关。因此这里**不 Fatalf**：
	// 失败时把 compiler 留 nil，发布链路会以可读的错误 fail-closed
	// （api.requireReady 对 nil Compiler 返回明确信封 + AllowPublish 还会因
	// compile_available=false 拒绝发布），其余功能照常。
	// ⚠️ 部署面必须构建该二进制并与 server 放在同一目录（见 Dockerfile/Makefile）：
	// 不修交付链 = 发布功能静默不可用（会在日志里"大声"记录 + /readyz 上可见）。
	//
	// 例外：**显式要求隔离的档位**（PICOAI_COMPILE_ISOLATION=require）必须 fail-closed ——
	// 该档位的唯一语义就是"隔离不可用就拒绝启动"（compile.IsolationRequire 的注释、
	// docker-compose.yml、.env.example 三处一致）。从前这里只打一行日志就继续跑，
	// 等于把运维的加固开关变成装饰（审计 P2-1）。
	isoMode := compile.IsolationFromEnv()
	var compiler *compile.Compiler
	compiler, cerr := compile.New(compile.Options{
		DataRoot:  dataDir,
		Isolation: isoMode,
		// 生效的单实例内存上限（R1-rt-7b）：编译子进程要按它与执行侧**同一份**上限校验
		// 模块声明的线性内存。取值来源与下面 appserver 的 `lim` 完全同一个 holder
		// （控制台设置 > 部署档位 > 编译期默认），因此"调小 ⇒ 发布期就拦、调大 ⇒ 不再误拒"。
		// 它是 wazero 的 RuntimeConfig 项 ⇒ 与执行侧同语义：保存后需重启生效。
		MemoryPages: limitsHolder.Get().InstanceMemoryPages(),
	})
	if cerr != nil {
		if isoMode == compile.IsolationRequire {
			// require 档的语义是"编译链路必须 fail-closed"：连编译器都构造不出来时
			// 隔离更无从谈起 ⇒ 直接拒绝启动（含"编译子进程缺失"这类非隔离原因，
			// 因为把"发布被静默禁用"当成 hardened 部署的结果同样是误导）。
			log.Fatalf("wasm: PICOAI_COMPILE_ISOLATION=require 要求编译链路 fail-closed，"+
				"但编译子系统不可用（隔离无从谈起），拒绝启动：%v", cerr)
		}
		log.Printf("wasm: ⚠️ 编译子系统不可用，发布链路将被禁用（其余功能正常）：%v", cerr)
		log.Printf("wasm: ⚠️ 修复方式：构建 cmd/picoaide-app-compile 并与 picoaide-server 放在同一目录；" +
			"生产镜像还需安装 bubblewrap（见 server/Dockerfile）")
		compiler = nil
	} else {
		// 结构化兜底：即使 New 没报错，require 档也不接受"未生效的隔离"
		//（未来若新增"计划可用但实际降级"的后端，这里仍然守住 fail-closed）。
		mode, usable, detail := compiler.IsolationStatus()
		if mustRefuseStartupForIsolation(mode, usable) {
			log.Fatalf("wasm: PICOAI_COMPILE_ISOLATION=require 但隔离未生效，拒绝启动：%s", detail)
		}
		log.Printf("wasm: compile isolation = %s", compiler.IsolationPlan())
	}

	// ⚠️ W4 删除的三段装配（总纲 §8.4 / §21）：
	//   - `aichat.New(...)`：服务端 AI 能力彻底删除，应用改走客户端 AI loop；
	//   - `session.New(...)` + `sessionLoginThrottle`：员工浏览器会话与一次性换票
	//     （`/login`、`/logout`、`/app-ticket`）随"应用有对外主机名"的旧模型一起删除；
	//   - `publicMainOrigin` / `baseDomainHolder`：应用基域配置面删除。
	// 身份一律由桌面客户端持员工 bearer 注入（见 appserver/client.go）。

	appSrv, aerr := appserver.New(appserver.Options{
		DB:                 db,
		DataRoot:           dataDir,
		Scheduler:          scheduler,
		Events:             eventSink,
		Compiler:           compiler,
		AppIDExtraReserved: extraReserved,
		// 应用 origin scheme（契约 §8.3/§10）：唯一来源 = 渠道包
		// `desktop.app_origin_scheme`。启动期已由 resolveStartupChannel 的
		// validateAppOriginScheme 做 fail-loud 校验，这里取值不会再失败；
		// 兜底默认值只覆盖"渠道目录缺失"（本地开发）那一种情形。
		AppScheme: appOriginScheme(),
		Logger:    log.Printf,
		// 内存档位：**降级为默认值来源**（P0-2）。真正生效的是下面 Limits
		//（控制台设置 > 档位 > 默认），它同时驱动队列并发、实例内存上限、
		// 模块缓存上限与库句柄上限 —— 装配期就必须是同一份数。
		MemoryProfile: prof,
		Limits:        limitsHolder.Get(),
	})
	if aerr != nil {
		log.Fatalf("wasm 应用子域管线装配失败：%v", aerr)
	}
	// 限制项接到运行态：①注入下发钩子（控制台保存后即时生效）
	// ②首次下发一次（幂等：把档位折算值之外的可热改字段对齐到当前生效值）。
	//
	// ③把返回值**回写持有者**（P0-2）：不回写的话，装配期"仍需重启"的判断只进日志
	//（界面显示"无需重启"），而实际生效值可能仍与设置值不一致 —— 于是重启也修不好，
	// 且 nobody 看得见。回写之后：重启后 restart 为空是**被断言过的事实**，
	// 不为空则如实显示在控制台上。
	limitsHolder.SetApplier(appSrv.ApplyLimits)
	restart := appSrv.ApplyLimits(limitsHolder.Get())
	limitsHolder.ApplyStartup(restart)
	if len(restart) > 0 {
		log.Printf("wasm: ⚠️ 平台限制项里有需重启才生效的字段：%v（当前进程仍按启动时的值跑）", restart)
	}

	checker := readyz.New(readyz.Options{
		DataRoot: dataDir,
		Compiler: func() readyz.CompilerStatsSnapshot {
			if compiler == nil {
				// 编译子系统不可用时**不**在探针里伪造健康水位：让 /readyz 的
				// 相关字段为 0（并靠下面的 CompileAvailability 把"不可用"这件事
				// 显式说出来 —— 零水位与"空闲"同形，光看它区分不出来）。
				return readyz.CompilerStatsSnapshot{}
			}
			st := compiler.Stats()
			return readyz.CompilerStatsSnapshot{
				QueueDepth: st.QueueDepth,
				InFlight:   boolToInt(st.Compiling),
				CacheBytes: st.CacheBytes,
				CacheFiles: st.CacheEntries,
				Running:    st.ChildRunning,
			}
		},
		// 编译可用性是**是非题**（审计 P2-2：编译器缺失时 /readyz 与健康态逐字段同形，
		// 编排发现不了"发布已禁用"）。它还会让 AllowPublish 拒绝发布（没有编译器就没有发布）。
		CompileAvailability: func() readyz.CompileAvailability {
			if compiler == nil {
				return readyz.CompileAvailability{Available: false, Detail: compileUnavailableDetail}
			}
			return readyz.CompileAvailability{Available: true}
		},
		// 调用事件的丢弃/失败/成功计数（审计 P2-7：计数必须有人看得见）。
		Events: func() readyz.EventsStats {
			return readyz.EventsStats{
				Dropped: eventSink.Dropped(),
				Failed:  eventSink.Failed(),
				Written: eventSink.Written(),
			}
		},
		Scheduler: scheduler,
		Ping:      db.Ping,
		// 可用内存的来源与数值必须出现在 /readyz 上（R1-rt-1）：这里显式注入与启动自检
		// **同一个**读取实现，避免"日志读 cgroup、探针读宿主"这种两套口径。
		MemAvailable: readMemoryAvailability,
		// 内存档位/理论峰值也必须出现在 /readyz 上（R1-rt-10）：这里注入的是**控制台
		// 保存后生效的那一份**（limitsHolder.Plan 读的是 h.Get()），因此探针上的
		// profile/budget 与"实际跑的账"同源 —— 不会出现"界面按档位显示、实际按设置跑"。
		MemoryPlan: limitsHolder.Plan,
	})

	api := wasmapi.NewHandlers(wasmapi.Options{
		DB:                 db,
		DataRoot:           dataDir,
		Compiler:           compiler,
		Events:             eventSink,
		AppIDExtraReserved: extraReserved,
		Audit:              func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
		// 发布面的 fail-closed 闸门（审计 P1-1：AllowPublish 此前零调用方）。
		Ready: checker,
		// 下架/冻结/删除后立即释放进程内驻留（模块 + 库句柄，见 api.Options.OnAppEvict）。
		OnAppEvict: newWasmAppEvictor(appSrv),
		// 客户端专属访问模型的执行入口（2026-09-19 决策）：客户端的本机代理把应用请求
		// 包成信封送进来，本钩子把它交给**与旧应用子域路径共用**的 serveApp 管线执行
		// （身份由客户端注入，见 appserver/client.go）。
		ServeClientRequest: appSrv.ServeClientRequest,
		// 渠道参数化的应用 origin（契约 §8.3/R2I-9）：api 层拿不到 *Server，
		// 因此把 appserver 的唯一构造点作为函数注入（两边同源，只有一个实现）。
		AppOrigin: appSrv.AppOrigin,
		AppScheme: appOriginScheme(),
		// 客户端持有性证明（契约 §20/§23.1）：签发/校验/jti 去重全在 appproof 包。
		// 它**必须**装配到生产（nil ⇒ 两个应用端点 fail-closed 401）。
		Proof: proofSvc,
		// 打开计数（F16/§8.9）：best-effort 写明细，失败只 warn。
		// 部门取"打开时刻的主部门"；拿不到就记无部门（绝不因此丢掉整次计数）。
		Opens: func(ctx context.Context, appID string, userID int64, clientVersion string) error {
			return serverstore.RecordWasmAppOpen(ctx, db, serverstore.WasmAppOpen{
				AppID:         appID,
				UserID:        userID,
				DeptID:        serverstore.PrimaryDeptID(ctx, db, userID),
				ClientVersion: clientVersion,
			})
		},
		// 平台限制项（并发/内存）：读写闭包；校验与下发都在 wasmLimitsHolder/ApplyLimits。
		Limits:        limitsHolder.Get,
		LimitsSource:  limitsHolder.Source,
		LimitsProfile: limitsHolder.ProfileName,
		LimitsApply:   limitsHolder.Apply,
		LimitsRestart: limitsHolder.RestartPending,
		// 诊断面要的是**运行时生效**的单实例内存上限，不是"控制台已保存值"（R2-DG-2）：
		// 保存 instance_memory_mb 之后要重启才生效，在重启窗口里两者可以差出几十上百 MiB
		//（审计实测：保存 32 MiB / 实际按 128 MiB 跑），而诊断 hints 与发布干跑说的必须是
		// "这次运行的上限"。appserver.InstanceMemoryPages() 优先问 runtime（来源纪律见
		// appserver/limits_apply.go）。控制台的 limits 视图与"待重启"判定仍读 Limits
		//（它要如实显示**已保存值**与 restart_pending）。
		EffectiveMemoryPages: appSrv.InstanceMemoryPages,
		// 控制台的四笔账预览也要"读不到就如实说"：BudgetBytes() 在未知时给
		// readyz.MemoryUnknown（<0）⇒ 预览只算不判（Known=false 会显示在响应里），
		// 而不是拿 0 当"内存充足"。
		MemoryAvailable: func() int64 { return readMemoryAvailability().BudgetBytes() },
	})

	// 分片上传会话的保留期回收（§4.2）：与调用事件同款调度器（启动即清一次 + 周期）。
	uploadCleanup := upload.NewCleanupScheduler(api.UploadCleaner(),
		upload.CleanupSchedulerOptions{Logger: log.Printf})
	uploadCleanup.Start(ctx)

	// 打开计数维护（F16/§8.9）：日汇总 upsert + 明细 90 天清理（**先汇总后清理**）。
	// 与调用事件同款调度器（启动即跑一次 + 周期），随 wasm ctx 一起退出。
	opensSched := opens.NewScheduler(db, opens.DefaultTick(), nil)
	opensSched.Start(ctx)

	p := &wasmPlatform{
		AppServer:     appSrv,
		API:           api,
		Checker:       checker,
		Events:        eventSink,
		UploadCleanup: uploadCleanup,
		EventCleanup:  eventCleanup,
		OpensCleanup:  opensSched,
		Compiler:      compiler,
		Scheduler:     scheduler,
		Limits:        limitsHolder,
		lock:          lock,
	}
	log.Printf("wasm: platform ready (client-only model; extra_reserved=%d)", len(extraReserved))
	return p
}

// ⚠️ `newHostGate` / `extraMainHosts` / `configuredMainHost` 已随 W4 删除
// （总纲 §8.4）：它们唯一的用途是把"也当主站处理的主机名"喂给 `edge.HostGate`，
// 而主机名门控整体不存在了 —— 应用请求由客户端的协议 handler 合成并带 app_id
// 进入 `/api/client/v2/apps/wasm/:app_id/request`，不再按 Host 分流。

// Close 释放平台资源。
//
// 顺序有讲究：先摘掉应用子域入口（新请求一律 404），再关管线（排空在飞请求），
// 然后停清理调度、停子进程与事件落库，最后放实例锁 —— 反过来会让"锁已释放但进程
// 还在"变成一个可以被第二个实例抢占的窗口。
func (p *wasmPlatform) Close() {
	if p == nil {
		return
	}
	if p.AppServer != nil {
		if err := p.AppServer.Close(); err != nil {
			log.Printf("wasm: appserver close: %v", err)
		}
	}
	// 先停清理调度再关 sink：调度器持有 sink，反过来会让"最后一轮"打在一个已关闭的
	// 对象上（Cleanup 本身对已关闭 sink 仍可用，但顺序明确更省心）。
	if p.EventCleanup != nil {
		p.EventCleanup.Close()
	}
	if p.UploadCleanup != nil {
		p.UploadCleanup.Close()
	}
	if p.Compiler != nil {
		if err := p.Compiler.Close(); err != nil {
			log.Printf("wasm: compiler close: %v", err)
		}
	}
	if p.Events != nil {
		if err := p.Events.Close(); err != nil {
			log.Printf("wasm: events close: %v", err)
		}
	}
	if p.lock != nil {
		p.lock.Release()
	}
}

// ⚠️ `sessionLoginThrottle` 已随 W4 删除：它把 serverauth 的登录失败预算适配给
// 员工登录页（`session.LoginThrottle`），而那套入口与 session 包一起消失了。
// 员工/管理端登录面（`/api/client/v2/auth/login` 与 `/api/server/admin/login`）
// 各自持有 serverauth 的限流，未受影响。

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// readMemoryAvailability 是**可用内存的唯一读取入口**（cgroup 感知 + 宿主回落）。
//
// 为什么不再只看 /proc/meminfo（P0-1 / R1-rt-1）：容器里 MemAvailable 是**宿主**的
// 可用内存，与 cgroup 限额无关 ⇒ `mem_limit: 2g` 的容器按默认档（需 3.6 GiB 可用）
// 自检通过，随后被内核 OOM-kill。现在取 min(宿主可用, cgroup 剩余)，并把来源
// （host / cgroup / none）与数值一起带出来。
//
// 读不到（Source=none）**不等于**内存充足：调用方必须显式说明"跳过内存自检"
// （见 checkStartupMemory 与 /readyz 的 mem_source 字段），保留可部署性但不许静默。
func readMemoryAvailability() readyz.MemoryAvailability {
	return readyz.ReadMemoryAvailability()
}

func splitCSV(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
