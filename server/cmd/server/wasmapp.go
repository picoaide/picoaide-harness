package main

import (
	"context"
	"database/sql"
	"log"
	"net"
	"net/url"
	"os"
	"strings"

	"github.com/picoaide/picoaide/internal/channel"
	"github.com/picoaide/picoaide/internal/clientrelease"
	"github.com/picoaide/picoaide/internal/serverauth"
	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/wasmapp/aichat"
	"github.com/picoaide/picoaide/internal/wasmapp/anonlimit"
	wasmapi "github.com/picoaide/picoaide/internal/wasmapp/api"
	"github.com/picoaide/picoaide/internal/wasmapp/apperr"
	"github.com/picoaide/picoaide/internal/wasmapp/appserver"
	"github.com/picoaide/picoaide/internal/wasmapp/compile"
	"github.com/picoaide/picoaide/internal/wasmapp/edge"
	"github.com/picoaide/picoaide/internal/wasmapp/events"
	"github.com/picoaide/picoaide/internal/wasmapp/memprofile"
	"github.com/picoaide/picoaide/internal/wasmapp/queue"
	"github.com/picoaide/picoaide/internal/wasmapp/readyz"
	"github.com/picoaide/picoaide/internal/wasmapp/session"
	"github.com/picoaide/picoaide/internal/wasmapp/upload"
)

// 环境变量（部署面）——设计基线 R29：企业自备通配域名与证书、管理员配置 Caddy，
// 平台不做证书自动化。因此"应用基域"是**部署配置**而不是运行期设置项：
// 改它等于换域名，必须同时改 DNS 与证书。
const (
	// EnvAppsBaseDomain 是应用基域（如 `apps.example.com`）。
	//
	// **留空 = 未启用应用子域**：不挂 HostGate（全部主机名走主站路由），
	// 不注册 `/app-ticket`。平台的发布/校验链路仍然可用 —— 这样"先让员工把
	// 应用建起来、再配通配域名"是可行顺序，而不是必须一次配齐。
	EnvAppsBaseDomain = "PICOAI_APPS_BASE_DOMAIN"
	// EnvAppsExtraReserved 是部署期注入的**企业既有主机名**（逗号分隔，§4.1）：
	// 基域是平台资产，应用不得占用这些名字（如 intranet、oa）。
	EnvAppsExtraReserved = "PICOAI_APPS_EXTRA_RESERVED"
)

// publicMainOrigin 返回**服务端配置**的本服务对外地址（主站源），未配置返回空串。
//
// 真源与客户端下载地址完全相同（不新造一套），优先级也照抄 clientrelease.resolveOrigin：
// `PICOAI_PUBLIC_BASE_URL`（显式配置即唯一权威）→ settings `server.base_url`
// （管理员在控制台配置，main.go 装进 clientrelease.PublicBaseResolver）。
//
// 为什么要有它：员工浏览器会话（/login、/app-ticket）的主站源**只能来自配置**。
// 留空时 session.checkMainOrigin 会按请求 Host 推导，而 Host 是攻击者可选的 ——
// 任何别名主机名（IP 直连/旧域名/反代域名/渠道第二域名）都会被 edge.HostGate 判成
// HostMain 并照常拿到票，同时换票的 nonce（浏览器持有性证明）若按请求 Host 判定
// 还会被"按请求降级"关掉（R1-sec-1 回归审计 P0）。返回空串时换票端点会 fail-closed
// 拒绝签发票，并在启动日志里点名要配哪一项。
func publicMainOrigin() string {
	if raw := strings.TrimSpace(os.Getenv(clientrelease.PublicBaseURLEnv)); raw != "" {
		return raw
	}
	if clientrelease.PublicBaseResolver != nil {
		return strings.TrimSpace(clientrelease.PublicBaseResolver())
	}
	return ""
}

// wasmPlatform 汇聚 WASM 应用平台的全部运行期组件。
type wasmPlatform struct {
	// Enabled 表示是否启用了应用子域（配置了 EnvAppsBaseDomain）。
	Enabled bool
	// AppServer 是应用子域请求管线（HostGate 的 Apps 分支）。
	AppServer *appserver.Server
	// HostGate 是主机名门控（**总是非 nil**：基域可在运行期启用，见
	// setupWasmPlatform 里的注释 —— 按启动期 enabled 决定装不装会让控制台
	// 改完必须重启）。
	HostGate *edge.HostGate
	// BaseDomain 是应用基域的运行期持有者（控制台保存后同步生效）。
	BaseDomain *baseDomainHolder
	// API 是操作面 handler 集合（§8）。
	API *wasmapi.Handlers
	// Session 是员工浏览器会话与一次性换票（R12/R16）。
	Session *session.Manager
	// Checker 是 /readyz 水位探针（§4.9）。
	Checker *readyz.Checker
	// Events 是调用事件 sink（§4.9）。
	Events *events.Sink
	// EventCleanup 是调用事件的 7 天保留期清理调度（§4.9/§5.3）。
	EventCleanup *events.CleanupScheduler
	// UploadCleanup 是分片上传会话的保留期回收调度（§4.2：会话有效期 30 分钟）。
	//
	// 不挂它的后果是**静默的**：断线客户端留下的会话目录会一直占盘，
	// 直到恰好有人再用同一个 upload_id 触发惰性回收。
	UploadCleanup *upload.CleanupScheduler
	// Compiler 是编译子系统（R31）。
	Compiler *compile.Compiler
	// Scheduler 是请求排队/准入（§4.6）。
	Scheduler *queue.Scheduler
	// Limiter 是匿名限流（R35）。
	Limiter *anonlimit.Limiter
	// AI 是 ai.chat 客户端（§4.7）。
	AI *aichat.Client
	// Limits 是平台限制项的运行期持有者（控制台设置 > 部署档位 > 默认）。
	//
	// 暴露它是为了**装配级断言**（P0-2）：单实例内存上限这类字段只在装配期写一次，
	// 没有持有者就只能断言源码字符串（而字符串断言分不清"接上了但值是错的"）。
	Limits *wasmLimitsHolder

	lock *readyz.InstanceLock
}

// normalizeLoopbackBaseURL 把监听地址变成宿主可用的回环基址。
//
// 为什么必须回环：`ai.chat` 由宿主用 http.Client 直调服务端自己的 `/v1`
// （§4.7 / D3.1「身份注入，不是令牌传递」）。走公网域名会白绕一圈 DNS/证书/反代，
// 既慢、又把内部调用放到链路上；走回环最短且不经任何前置代理。
func normalizeLoopbackBaseURL(addr string) string {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "http://127.0.0.1:8080"
	}
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

// compileUnavailableDetail 是编译子系统不可用时**对外**（/readyz 是未认证端点）
// 暴露的说明：只给一句定性，不回显底层错误（错误里带编译子进程路径与数据根路径）。
// 完整原因由启动日志承担。
const compileUnavailableDetail = "编译子系统不可用（发布链路已禁用），详见服务端启动日志"

// checkStartupMemory 执行 §4.3 的内存四笔账启动自检（返回非 nil ⇒ 调用方 log.Fatalf）。
//
// 为什么按 enabled 分档（审计 P2-8）：四笔账算的是**运行期**的实例池/编译峰值/上传峰值/
// 缓存驻留 —— 应用子域没启用时这些资源一分都不会被用到，却按默认档要求机器
// `MemAvailable ≥ 3.56 GiB`（total 2550 MB ÷ 70%）："没用到这个功能也被它挡住启动"。
// 未启用时只记一行日志。
//
// ⚠️ 启用时判据**一点没放宽**：仍然是 fail-closed（§4.3 原话"拒绝启动而不是等 OOM"）；
// 2026-09-18 起账本按**部署声明的内存档位**算（plan），而同一份档位也喂给 appserver
// 强制并发/实例上限/模块缓存/库句柄 —— 因此"自检算的账"与"实际跑的账"是同一份。
//
// 参数显式传入**读取结果**（而不是函数内部读 /proc）：让"极小 cgroup 剩余 ⇒ 拒绝启动 /
// 读不到 ⇒ 跳过"都能被确定性测到，不必真改 /proc/meminfo 或真造 cgroup。
//
// 读不到可用内存（Source=none）时**跳过判定但大声说**：这是"保留可部署性"的一半
// （非 Linux 开发机/受限容器不能让整个平台起不来），另一半是"绝不与内存充足同形"——
// 旧实现只做到前一半，于是读不到时控制台与 /readyz 都看不到任何异常（R1-rt-1）。
func checkStartupMemory(enabled bool, avail readyz.MemoryAvailability, plan readyz.MemoryPlan, logf func(format string, args ...any)) *apperr.Error {
	if !enabled {
		logf("wasm: 应用平台未启用（未配置 %s），跳过内存四笔账自检"+
			"（实例池/编译峰值/上传峰值/缓存驻留都不会被用到）", EnvAppsBaseDomain)
		return nil
	}
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
// **失败策略：装配期一律 log.Fatalf，绝不静默降级。** 设计里有四处明确的
// fail-closed，都在这里做：
//   - R35 可信代理自检（启用子域却未显式配置 ⇒ 拒绝启动）；
//   - §4.3 内存四笔账自检（**启用子域时**理论峰值 > 可用内存 70% ⇒ 拒绝启动）；
//   - `PICOAI_COMPILE_ISOLATION=require` 且隔离不可用 ⇒ 拒绝启动（R31 的严格档）；
//   - §15.1 第 9 条 / R20 单实例自检（advisory lock）。
//
// 理由：这几处的失败形态都是**静默的**（匿名流量坍缩进同一桶、OOM 才崩、
// 带着无隔离的编译进程对外服务、两个副本各持一半票），"暂时跑起来但语义已坏"
// 比"起不来"危险得多。
func setupWasmPlatform(ctx context.Context, db *sql.DB, authAPI *serverauth.API, dataDir, addr string) *wasmPlatform {
	// 应用基域：**管理端可配置**（2026-09-18 用户要求「应用名 + 泛域名 = 应用访问
	// 地址」）。优先级：控制台保存过（含显式清空）> 环境变量。取值走 holder
	// （原子读）—— HostGate 每请求都要判一次，而写路径只有控制台保存。
	base := newBaseDomainHolder(db, os.Getenv(EnvAppsBaseDomain))
	baseDomain := func() string { return base.Get() }
	extraReserved := splitCSV(os.Getenv(EnvAppsExtraReserved))
	enabled := baseDomain() != ""

	// ---- 内存档位（2026-09-18）：数值同时驱动下面的启动自检与运行期强制 ----
	// 未知档位名**拒绝启动**（静默回落默认会让小机器在"以为已降档"的状态下 OOM）。
	prof, perr := memprofile.FromEnv(os.Getenv)
	if perr != nil {
		log.Fatalf("WASM 应用平台内存档位配置错误：%v", perr)
	}
	// 平台限制项（并发/内存）：控制台设置 > 部署档位 > 编译期默认。
	// 自检与运行期强制都用**这一份**（见 wasmLimitsHolder 的注释）。
	limitsHolder := newWasmLimitsHolder(db, prof)
	// 启用子域的合法性自检与控制台/启动自检共用同一份账（见 baseDomainHolder.plan）。
	base.SetPlanProvider(limitsHolder.Plan)
	plan := limitsHolder.Plan()
	log.Printf("wasm: 内存档位 %s；平台限制项来源=%s %s", prof.Report(), limitsHolder.Source(), limitsHolder.Get().Encode())

	// ---- R35：可信代理自检（未启用子域时不校验，既有部署行为不变）----
	if err := anonlimit.CheckTrustedProxies(os.Getenv, enabled); err != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", err)
	}

	// ---- §4.3：内存四笔账（实例池 + 编译峰值 + 上传峰值 + 缓存驻留）----
	// 只在启用应用子域时校验（见 checkStartupMemory 的注释：未启用时这四笔账不会被用到）。
	// 账本按**本部署声明的档位**算：同一份数值也喂给 appserver（队列并发/实例上限/
	// 模块缓存/库句柄），因此"自检算的账"与"实际跑的账"是同一份。
	if berr := checkStartupMemory(enabled, readMemoryAvailability(), plan, log.Printf); berr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", berr)
	}

	// ---- §15.1 第 9 条 / R20：单实例（多副本的失败形态是静默的）----
	lock, lerr := readyz.AcquireInstanceLock(dataDir)
	if lerr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", lerr)
	}

	limiter := anonlimit.New(anonlimit.DefaultOptions())
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

	ai := aichat.New(aichat.Options{
		BaseURL: normalizeLoopbackBaseURL(addr),
		DB:      db,
	})

	// 员工浏览器会话（R16）：**复用** serverauth 的 provider 链（local/LDAP 顺序
	// 与客户端面一致），不复制认证逻辑；审计走高频道 serverstore.AuditLog，
	// 与既有审计同一条哈希链。
	//
	// Auth 回调返回 userID=0：serverauth.UserInfo 不带本地行 id，session.Manager
	// 会按 username 从 users 表解析（见其 Options.Auth 契约）。
	authFn := func(username, password string) (string, int64, error) {
		if authAPI == nil {
			return "", 0, session.ErrAuthUnavailable
		}
		ui, err := authAPI.AuthenticatePassword(username, password)
		if err != nil {
			return "", 0, err
		}
		return ui.Username, 0, nil
	}
	// 登录失败预算：**必须**注入（见 session.Options.Throttle 的注释）——
	// 员工浏览器登录页是与客户端面 /auth/login 并列的第二个密码入口，
	// 这里复用 serverauth 的同一套三个桶，两处入口共享同一份失败预算。
	loginThrottle := sessionLoginThrottle{authAPI}
	sessMgr := session.New(session.Options{
		DB:         db,
		BaseDomain: baseDomain,
		Auth:       authFn,
		Audit:      func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
		Throttle:   loginThrottle,
		// ⚠️ 主站源必须**由配置固定**（R1-sec-1 回归审计 P0）：留空会让
		// checkMainOrigin 按请求 Host 推导，而 Host 是攻击者可选的 —— 任何别名主机名
		// （IP 直连/旧域名/反代域名）都能拿到票，且换票 nonce（浏览器持有性证明）会被
		// "按请求降级"关掉。publicMainOrigin 读的是**与客户端下载地址同一份真源**。
		MainOriginResolver: publicMainOrigin,
		ProductName:        channel.Load().Identity.DisplayName,
		// 与 appserver.Options 同源：换票端点的 app 形态校验也要挡住企业既有主机名。
		AppIDExtraReserved: extraReserved,
		// 应用子域会话被吊销时，丢掉 aichat 在该会话下的在手令牌（§4.7 登出即吊销）。
		OnAppSessionRevoked: func(key string) { ai.RevokeSession(key) },
	})
	// 启用应用子域却没有配置对外地址 ⇒ **启动期说清**（R1-sec-1 回归审计加固）：
	// 换票按**应用基域**推导主站源（`<基域 scheme>://<基域>`），与 edge.MatchHost 的
	// 「基域主机 == 主站」模型一致 ⇒ 功能不受影响；但推导值不如显式配置可审计，
	// 所以这里点明建议配置哪一项（现网 .env / compose 的默认都没配，不能因此判成故障）。
	if baseDomain() != "" && publicMainOrigin() == "" {
		log.Printf("wasm: 未配置服务端对外地址（控制台设置 server.base_url 或环境变量 %s）；"+
			"员工换票将按应用基域推导主站源（%s，与「基域主机即主站」的既有模型一致）⇒ "+
			"换票功能不受影响；建议显式配置对外地址以消除歧义",
			clientrelease.PublicBaseURLEnv, baseDomain())
	}

	appSrv, aerr := appserver.New(appserver.Options{
		DB:                 db,
		DataRoot:           dataDir,
		BaseDomain:         baseDomain,
		Sessions:           sessMgr,
		Limiter:            limiter,
		Scheduler:          scheduler,
		Events:             eventSink,
		Compiler:           compiler,
		AppIDExtraReserved: extraReserved,
		AIBaseURL:          normalizeLoopbackBaseURL(addr),
		Logger:             log.Printf,
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
		BaseDomain:         baseDomain,
		BaseDomainSource:   base.Source,
		ApplyBaseDomain:    base.Apply,
		AppIDExtraReserved: extraReserved,
		Audit:              func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
		// 发布面的 fail-closed 闸门（审计 P1-1：AllowPublish 此前零调用方）。
		Ready: checker,
		// 下架/冻结/删除后立即释放进程内驻留（模块 + 库句柄，见 api.Options.OnAppEvict）。
		OnAppEvict: newWasmAppEvictor(appSrv),
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

	p := &wasmPlatform{
		Enabled:       enabled,
		BaseDomain:    base,
		AppServer:     appSrv,
		API:           api,
		Session:       sessMgr,
		Checker:       checker,
		Events:        eventSink,
		UploadCleanup: uploadCleanup,
		EventCleanup:  eventCleanup,
		Compiler:      compiler,
		Scheduler:     scheduler,
		Limiter:       limiter,
		AI:            ai,
		Limits:        limitsHolder,
		lock:          lock,
	}
	// HostGate **无条件常挂**：空基域时 MatchHost 对所有主机名返回 HostMain ⇒
	// ServeHTTP 直接交主站，与"没挂门控"逐字节等价；非空时才把应用子域分流。
	// Main 由 main.go 在拿到 *gin.Engine 后回填。
	// ExtraMainHosts 与员工会话的主站源**同源**：R1-sec-3 之后 MatchHost 把"不是本基域的
	// 主机名"判成 HostUnknown ⇒ 404（不再回落主站），而"主站 Host ≠ 应用基域"是**存量**
	// 部署可能存在的形态（历史上 `.env.example` 就是基域 apps.example.com + 主站
	// example.com；该示例已改为两者同域，因为这种组合下登录可见应用**无法**换票，见
	// extraMainHosts 的部署约束）⇒ 不显式声明就会升级后主站/管理台 404。
	_, baseHostAtStartup := session.ParseBaseDomain(baseDomain())
	p.HostGate = newHostGate(baseDomain, baseHostAtStartup, appSrv)
	log.Printf("wasm: platform ready (subdomain=%v base_domain=%q source=%s extra_reserved=%d extra_main_hosts=%v)",
		baseDomain() != "", baseDomain(), base.Source(), len(extraReserved), p.HostGate.ExtraMainHosts)
	return p
}

// newHostGate 构造主机名门控（**唯一装配点**）。
//
// 单独成函数的原因：`ExtraMainHosts` 必须与"主站源"**同源**（同一个 extraMainHosts），
// 而"装配时忘了传这个字段"的后果是主站/管理台静默 404 —— 抽成函数后测试可以直接驱动
// 生产用的这段装配代码（见 wasmapp_hostgate_test.go），而不是靠人读代码。
func newHostGate(baseDomain func() string, baseHostAtStartup string, apps edge.AppHandler) *edge.HostGate {
	return &edge.HostGate{
		BaseDomain:     baseDomain,
		Apps:           apps,
		ExtraMainHosts: extraMainHosts(baseHostAtStartup),
	}
}

// extraMainHosts 返回要显式声明"也当主站处理"的额外主机名（edge.HostGate.ExtraMainHosts）。
//
// 为什么需要它（R1-sec-3 的配套装配）：edge.MatchHost 现在只认两支 —— 主站（`host == 基域`）
// 与应用子域（`<label>.<基域>`）；**其余主机名一律 HostUnknown ⇒ 404**（不再回落主站，
// 否则任意域名都能镜像门户与管理台登录页）。而"主站主机名 ≠ 应用基域"是**存量**部署可能
// 存在的形态（历史上 server/.env.example 的示例就是基域 `apps.example.com`、主站
// `example.com`）⇒ 必须显式把主站主机名列进来，否则这类部署升级后主站与管理台全部 404。
//
// 真源与主站源完全相同，**绝不看请求 Host**（请求 Host 是攻击者可选的，见
// session.Options.MainOriginResolver 的注释）：
//   - 对外地址已配置 ⇒ 取它的 host（`PICOAI_PUBLIC_BASE_URL` > 控制台 `server.base_url`）；
//   - 未配置/不可解析 ⇒ 与 session.ticketNonceDecision 同口径，按**应用基域**推导
//     （此时清单项与基域相同，MatchHost 的 `h == b` 本来就判主站 —— 留着只是让规则统一，
//     并让"主站源"只有一份推导口径）；
//   - 基域也未配置 ⇒ 空清单（MatchHost 全判主站，门控不涉及，行为与升级前逐字节相同）。
//
// ⚠️ 这是**启动期快照**：控制台运行期改基域不会更新它。后果可接受（旧主站主机名继续服务主站，
// 新基域主机名走 `h == b`），但若将来"对外地址"也变成运行期可改、且主站域与基域不同域，
// 这里要改成函数形式（与 BaseDomain 同形）。
//
// ⚠️ 部署约束（要认账）：主站域 ≠ 应用基域的部署**必须**把对外地址配成主站域 —— 否则本函数
// 只能推导出基域主机名，真正的主站会被 R1-sec-3 的门控 404 掉；而配了主站域之后，换票又会因
// "对外地址与基域不同域"被 fail-closed 拒绝签发（**没有**运维开关可以放开：
// `Options.AllowTicketWithoutNonce` 是 Go 字段，只服务内嵌方）。⇒ 这类部署要么把应用基域
// 改成主站主机本身（主站是基域、应用是它的子域），要么停用应用子域。可执行的配置动作见
// session 包的 ticketNonceRemedyAlignOrigin；历史记录 temp/wasm-review-r1/fix-sec1b.md。
func extraMainHosts(baseHost string) []string {
	host := configuredMainHost()
	if host == "" {
		host = strings.TrimSuffix(strings.ToLower(strings.TrimSpace(baseHost)), ".")
	}
	if host == "" {
		return nil
	}
	return []string{host}
}

// configuredMainHost 从**配置的对外地址**里取主机名（空 = 未配置或取不出主机名）。
//
// 与 session.configuredMainOrigin 同口径：必须有 scheme（`url.Parse("h.example.com")` 的
// Host 为空 ⇒ 当作未配置），端口剥掉（Cookie/Host 匹配都不看端口），IPv6 字面量视为不可用。
func configuredMainHost() string {
	raw := strings.TrimSpace(publicMainOrigin())
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return ""
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if host == "" || strings.Contains(host, ":") { // 剩下的 ':' 只可能是 IPv6 字面量
		return ""
	}
	return host
}

// Close 释放平台资源。
//
// 顺序有讲究：先摘掉应用子域入口（新请求一律 404），再关管线（排空在飞请求），
// 然后停清理调度、停子进程与事件落库，最后放实例锁 —— 反过来会让"锁已释放但进程
// 还在"变成一个可以被第二个实例抢占的窗口。
func (p *wasmPlatform) Close() {
	if p == nil {
		return
	}
	if p.HostGate != nil {
		p.HostGate.Apps = nil
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

// sessionLoginThrottle 把 serverauth 的登录失败预算适配成 session.LoginThrottle。
//
// 为什么需要适配而不是让 session 直接依赖 serverauth：session 是平台无关的
// HTTP 组件（它只知道"有一个预算"，不知道预算怎么实现），而 serverauth 的实现
// 走 gin/dbLimiterScope。中间的这层薄适配保证两处入口**共享同一份桶**。
type sessionLoginThrottle struct{ api *serverauth.API }

func (t sessionLoginThrottle) Allow(username, host string) bool {
	if t.api == nil {
		return true // 未装配认证时不可能走到登录（Auth 已返回 ErrAuthUnavailable）
	}
	return t.api.AllowLoginAttempt(username, host)
}

func (t sessionLoginThrottle) Failure(username, host string) {
	if t.api != nil {
		t.api.RecordLoginFailure(username, host)
	}
}

func (t sessionLoginThrottle) Success(username, host string) {
	if t.api != nil {
		t.api.ResetLoginSuccess(username, host)
	}
}

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
