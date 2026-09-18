package main

import (
	"context"
	"database/sql"
	"log"
	"net"
	"os"
	"strings"

	"github.com/picoaide/picoaide/internal/channel"
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

// wasmPlatform 汇聚 WASM 应用平台的全部运行期组件。
type wasmPlatform struct {
	// Enabled 表示是否启用了应用子域（配置了 EnvAppsBaseDomain）。
	Enabled bool
	// AppServer 是应用子域请求管线（HostGate 的 Apps 分支）。
	AppServer *appserver.Server
	// HostGate 是主机名门控（只有启用子域时才非 nil）。
	HostGate *edge.HostGate
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
// 为什么按 enabled 分档（审计 P2-8）：四笔账算的是**运行期**的实例池（32×64 MiB）/
// 编译峰值/上传峰值/缓存驻留 —— 应用子域没启用时这些资源一分都不会被用到，却要求
// 机器 `MemAvailable ≥ 3.56 GiB`（total 2550 MB ÷ 70%），4 GiB 容器直接起不来：
// "没用到这个功能也被它挡住启动"。未启用时只记一行日志。
//
// ⚠️ 启用时判据**一点没放宽**：仍然是 fail-closed（§4.3 原话"拒绝启动而不是等 OOM"）。
//
// 参数显式传入 availableBytes（而不是函数内部读 /proc）：让"极小 MemAvailable ⇒
// 拒绝启动 / 不 Fatalf"能被确定性测到，不必真改 /proc/meminfo。
func checkStartupMemory(enabled bool, availableBytes int64, logf func(format string, args ...any)) *apperr.Error {
	if !enabled {
		logf("wasm: 应用平台未启用（未配置 %s），跳过内存四笔账自检"+
			"（实例池/编译峰值/上传峰值/缓存驻留都不会被用到）", EnvAppsBaseDomain)
		return nil
	}
	budget, berr := readyz.CheckStartupMemory(availableBytes)
	if berr != nil {
		return berr
	}
	logf("wasm: memory budget instances=%dMB compile_peak=%dMB upload_peak=%dMB cache_resident=%dMB total=%dMB available=%dMB limit=%dMB",
		budget.Instances>>20, budget.CompilePeak>>20, budget.UploadPeak>>20,
		budget.CacheResident>>20, budget.Total>>20, budget.Available>>20, budget.Limit>>20)
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
	baseDomain := strings.TrimSpace(os.Getenv(EnvAppsBaseDomain))
	extraReserved := splitCSV(os.Getenv(EnvAppsExtraReserved))
	enabled := baseDomain != ""

	// ---- R35：可信代理自检（未启用子域时不校验，既有部署行为不变）----
	if err := anonlimit.CheckTrustedProxies(os.Getenv, enabled); err != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", err)
	}

	// ---- §4.3：内存四笔账（实例池 + 编译峰值 + 上传峰值 + 缓存驻留）----
	// 只在启用应用子域时校验（见 checkStartupMemory 的注释：未启用时这四笔账不会被用到）。
	if berr := checkStartupMemory(enabled, readMemAvailable(), log.Printf); berr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", berr)
	}

	// ---- §15.1 第 9 条 / R20：单实例（多副本的失败形态是静默的）----
	lock, lerr := readyz.AcquireInstanceLock(dataDir)
	if lerr != nil {
		log.Fatalf("WASM 应用平台启动自检失败：%v", lerr)
	}

	limiter := anonlimit.New(anonlimit.DefaultOptions())
	scheduler := queue.New(queue.DefaultOptions())
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
		DB:          db,
		BaseDomain:  baseDomain,
		Auth:        authFn,
		Audit:       func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
		Throttle:    loginThrottle,
		ProductName: channel.Load().Identity.DisplayName,
		// 与 appserver.Options 同源：换票端点的 app 形态校验也要挡住企业既有主机名。
		AppIDExtraReserved: extraReserved,
		// 应用子域会话被吊销时，丢掉 aichat 在该会话下的在手令牌（§4.7 登出即吊销）。
		OnAppSessionRevoked: func(key string) { ai.RevokeSession(key) },
	})

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
	})
	if aerr != nil {
		log.Fatalf("wasm 应用子域管线装配失败：%v", aerr)
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
	})

	api := wasmapi.NewHandlers(wasmapi.Options{
		DB:                 db,
		DataRoot:           dataDir,
		Compiler:           compiler,
		Events:             eventSink,
		BaseDomain:         baseDomain,
		AppIDExtraReserved: extraReserved,
		Audit:              func(username, action, detail string) { _ = serverstore.AuditLog(db, username, action, detail) },
		// 发布面的 fail-closed 闸门（审计 P1-1：AllowPublish 此前零调用方）。
		Ready: checker,
	})

	// 分片上传会话的保留期回收（§4.2）：与调用事件同款调度器（启动即清一次 + 周期）。
	uploadCleanup := upload.NewCleanupScheduler(api.UploadCleaner(),
		upload.CleanupSchedulerOptions{Logger: log.Printf})
	uploadCleanup.Start(ctx)

	p := &wasmPlatform{
		Enabled:       enabled,
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
		lock:          lock,
	}
	if enabled {
		// Main 由 main.go 在拿到 *gin.Engine 后回填（HostGate 需要主站 handler）。
		p.HostGate = &edge.HostGate{BaseDomain: baseDomain, Apps: appSrv}
	}
	log.Printf("wasm: platform ready (subdomain=%v base_domain=%q extra_reserved=%d)",
		enabled, baseDomain, len(extraReserved))
	return p
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

// readMemAvailable 读可用内存；读不到返回 0（readyz 对 ≤0 的语义是"不判定"，
// 这样容器/受限环境不会因为 /proc/meminfo 不可读而无法部署）。
func readMemAvailable() int64 {
	v, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(v), "\n") {
		if !strings.HasPrefix(line, "MemAvailable:") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			break
		}
		var kb int64
		for _, c := range fields[1] {
			if c < '0' || c > '9' {
				break
			}
			kb = kb*10 + int64(c-'0')
		}
		return kb * 1024
	}
	return 0
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
