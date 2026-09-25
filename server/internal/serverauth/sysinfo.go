package serverauth

import (
	"context"
	"database/sql"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/picoaide/picoaide/internal/serverstore"
	"github.com/picoaide/picoaide/internal/updatecheck"
)

// sysinfoResponse 是 /api/server/admin/server-info 的响应体。
// 系统信息来自 runtime/stdlib+Linux /proc(不引入 gopsutil 依赖);
// 数据库统计按驱动(SQLite/PG)查询行数与磁盘大小。
// 2026-08-31 起含 update_check 字段(服务端代理的 GitHub Releases 版本检查)。
type sysinfoResponse struct {
	UptimeSec   int64      `json:"uptime_sec"`
	UptimeHuman string     `json:"uptime_human"`
	GoVersion   string     `json:"go_version"`
	NumCPU      int        `json:"num_cpu"`
	GOMAXPROCS  int        `json:"gomaxprocs"`
	Goroutines  int        `json:"goroutines"`
	Mem         memInfo    `json:"mem"`
	LoadAvg     [3]float64 `json:"load_avg"` // 1/5/15 分钟
	Disk        diskInfo   `json:"disk"`
	DB          dbStats    `json:"db"`
	Version     string     `json:"version"`
	// UpdateCheck 是实时版本检查结果(2026-08-31 新增);服务不可达/非
	// SemVer 时为 null,前端静默降级(绝不因版本检查失败打扰管理员)。
	UpdateCheck *updatecheck.Result `json:"update_check"`
	// Balance 是**余额闸门准入侧**的拒绝证据(R16C-02,审计 2026-09-25,P1)。
	//
	// 修前:余额 0.01 的账号可以无限次请求 —— 每次都已真实调用上游、随后结算失败
	// 整笔回滚,usage/余额/流水一行不动、管理端零痕迹。现在被拒的请求走准入闸门
	// (不转发上游)并**留下计数与最近一条的形状**,让"谁在被拒、依据是什么
	// (non_positive | learned_floor | min_billable | unpriced_model | unbillable_price)、
	// 差多少钱"可检索。
	Balance balanceHealth `json:"balance"`
	// Audit 是审计链与审计写入的健康状态(FIX-12,审计 2026-09-12 P1)。
	//
	// 为什么挂在这里而不是新开一个 admin 端点:审计写入失败以前**完全不可
	// 见**(80 个调用点都是 `_ = serverstore.AuditLog`),而 VerifyAuditChain
	// 在生产里零调用 —— "哈希链防篡改"是一条没有执行者的不变式。给它执行者
	// 的同时**不能再引入新路由**(`internal/router` 是路由唯一真源,增删路由
	// 会让 test mirror 与生产路由表失配,parity 测试直接红),所以复用**已
	// 注册**的 server-info。
	Audit auditHealth `json:"audit"`
}

// auditHealth 是审计子系统的健康快照(只读,不含任何审计内容)。
type auditHealth struct {
	// ChainChecked 为 false 表示本进程尚未做过链校验。
	// 校验在启动时执行一次(cmd/server),结果由 serverstore 缓存。
	ChainChecked bool `json:"chain_checked"`
	// ChainIntact:链完整;ChainBrokenID:第一处断链/哈希不符的条目 id。
	ChainIntact   bool  `json:"chain_intact"`
	ChainBrokenID int64 `json:"chain_broken_id"`
	// ChainCheckedAt 是最近一次校验的时刻(RFC3339)。
	ChainCheckedAt string `json:"chain_checked_at"`
	// R16C-03(审计 2026-09-25,P2):**新鲜度**与执行者。修前这里只有启动那一刻的
	// 结论,长跑实例把过期的 true 当当前状态对外(篡改不重启就零告警)。
	//   - ChainAgeSeconds:最近一次校验距今多少秒(-1 = 本进程还没校验过);
	//   - ChainStale:结论是否已过期(超过 serverstore.AuditChainStaleAfter);
	//     过期结论不得看起来像实时结论 —— 判据由 serverstore 唯一实现,这里只投影;
	//   - ChainSource:执行者(startup | periodic);
	//   - ChainChecks:本进程累计校验次数(周期执行者真的在跑吗);
	//   - ChainRows / ChainDurationMS:最近一轮扫描规模与耗时(全表扫描的开销可见);
	//   - ChainError:校验**本身**的失败原因(与"链断了"是两件事)。
	ChainAgeSeconds int64  `json:"chain_age_seconds"`
	ChainStale      bool   `json:"chain_stale"`
	ChainSource     string `json:"chain_source,omitempty"`
	ChainChecks     int64  `json:"chain_checks"`
	ChainRows       int64  `json:"chain_rows"`
	ChainDurationMS int64  `json:"chain_duration_ms"`
	ChainError      string `json:"chain_error,omitempty"`
	// WriteFailures / DroppedEntries / Retries 是**进程内**累计计数:
	// dropped_entries 是彻底丢失、从未落库的审计条目数。两者非零即说明审计
	// 有缺口,应立刻排查(日志里同时有 `ERROR audit: ...` 行)。
	WriteFailures  int64 `json:"write_failures"`
	DroppedEntries int64 `json:"dropped_entries"`
	Retries        int64 `json:"retries"`
	// LastFailure 是最近一次审计写入失败的**原因**(R16C-05,审计 2026-09-25,P2):
	// 修前 worker 只打 "entry dropped after retries action=… username=…",不带底层
	// 错误,而全仓 90+ 个调用点写的是 `_ = AuditLog(...)` ⇒ 错误在每一处被丢掉,
	// 运维只知"丢了几条"不知"为什么丢"。现在原因随日志(`cause=`)一起进进程内快照,
	// 直接在这里可读(含 `cause_class=sqlstate:<码>`)。
	LastFailure *serverstore.AuditFailureInfo `json:"last_failure,omitempty"`
}

// balanceHealth 是余额准入闸门的拒绝证据快照(进程内计数,重启归零)。
type balanceHealth struct {
	// AdmissionRejections 是准入处被余额闸门拒绝的累计次数(每次都不产生上游调用)。
	AdmissionRejections int64 `json:"admission_rejections"`
	// LastRejection 是最近一条拒绝的形状(用户/端点/模型/依据/要求金额/当时余额)。
	LastRejection *serverstore.BalanceAdmissionRejection `json:"last_rejection,omitempty"`
}

type memInfo struct {
	AllocatedMB    float64 `json:"allocated_mb"`
	TotalSystemMB  float64 `json:"total_system_mb"`
	SystemMemoryMB float64 `json:"system_memory_mb"` // 宿主机(读 /proc/meminfo)
}

type diskInfo struct {
	DataPath string  `json:"data_path"`
	TotalGB  float64 `json:"total_gb"`
	UsedGB   float64 `json:"used_gb"`
	FreeGB   float64 `json:"free_gb"`
	UsedPct  float64 `json:"used_pct"`
}

// dbStats 是数据库统计(行数按表/磁盘大小按后端)。
type dbStats struct {
	Driver       string           `json:"driver"` // sqlite | pg
	BuildVersion string           `json:"-"`      // 内部
	Tables       map[string]int64 `json:"tables"` // 表名 -> 行数
	TotalRows    int64            `json:"total_rows"`
	DiskBytes    int64            `json:"disk_bytes"`
	DiskHuman    string           `json:"disk_human"`
	SchemaMig    int64            `json:"schema_migrations"` // 迁移版本
}

// statTables 的行数统计口径已内联进 collectDBStats（R14-K · D-02）：
// 表名不再是**变量**——语句必须是字面量，否则守卫的 SQL 尺子看不见（旧形态
// `db.QueryRow("SELECT COUNT(*) FROM " + t)` 就是靠这一点逃逸的）。

// handleServerInfo 返回服务器系统信息 + 数据库统计(AdminAuth 保护)。
func (a *AdminAPI) handleServerInfo(c *gin.Context) {
	resp := sysinfoResponse{
		UptimeSec:   int64(time.Since(startTime).Seconds()),
		UptimeHuman: humanDuration(time.Since(startTime)),
		GoVersion:   runtime.Version(),
		NumCPU:      runtime.NumCPU(),
		GOMAXPROCS:  runtime.GOMAXPROCS(0),
		Goroutines:  runtime.NumGoroutine(),
		LoadAvg:     [3]float64{0, 0, 0},
		Version:     buildVersion,
	}

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	resp.Mem = memInfo{
		AllocatedMB:    round1(float64(ms.Alloc) / 1024 / 1024),
		TotalSystemMB:  round1(float64(ms.Sys) / 1024 / 1024),
		SystemMemoryMB: hostMemoryMB(),
	}

	resp.LoadAvg = hostLoadAvg()

	resp.Disk = hostDisk("/data")

	// 数据库统计
	dbStats, err := collectDBStats(a.DB)
	if err != nil {
		writeError(c, http.StatusInternalServerError, "INTERNAL", "统计失败: "+err.Error())
		return
	}
	resp.DB = dbStats

	// FIX-12:审计链校验结果(启动 + **周期** 两个执行者,结果缓存在 serverstore)
	// + 进程内写入计数。R16C-03:结论带**新鲜度**(age/stale)与执行者,
	// 过期结论不再看起来像实时结论。R16C-05:最近一次写入失败的原因也在这一块。
	chain := serverstore.AuditChainStatusDetail()
	failures, dropped, retries := serverstore.AuditWriteStats()
	resp.Audit = auditHealth{
		ChainChecked:    chain.Checked,
		ChainIntact:     chain.Intact,
		ChainBrokenID:   chain.BrokenID,
		ChainCheckedAt:  chain.CheckedAt,
		ChainAgeSeconds: chain.AgeSeconds,
		ChainStale:      chain.Stale,
		ChainSource:     chain.Source,
		ChainChecks:     chain.Checks,
		ChainRows:       chain.Rows,
		ChainDurationMS: chain.DurationMS,
		ChainError:      chain.Err,
		WriteFailures:   failures,
		DroppedEntries:  dropped,
		Retries:         retries,
	}
	if last, ok := serverstore.AuditWriteLastFailure(); ok {
		resp.Audit.LastFailure = &last
	}

	// R16C-02:余额闸门准入侧的拒绝证据(进程内计数 + 最近一条)。
	if n, last, ok := serverstore.BalanceAdmissionStats(); ok {
		resp.Balance = balanceHealth{AdmissionRejections: n, LastRejection: &last}
	}

	// 实时版本检查(2026-08-31):查询 GitHub Releases latest,对比当前版本。
	// 结果失败时留 nil(JSON null),前端静默降级——版本提示是增强体验,
	// 绝不能让外网 API 故障影响服务器信息页正常展示。
	// AdminAPI.UpdateChecker 可注入 mock(测试);nil 时用包级缓存 checker。
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	checker := a.UpdateChecker
	if checker == nil {
		checker = defaultUpdateChecker()
	}
	if uc, uerr := checker.Check(ctx, buildVersion); uerr == nil {
		resp.UpdateCheck = uc
	}

	c.JSON(http.StatusOK, resp)
}

// ---- 启动时间(包级,进程启动时设置) ----
var startTime = time.Now()

// buildVersion 是 server-info 上报与版本检查对比的当前版本。
// 由 main 在启动时注入与 --version 相同的版本(单一来源:避免两处
// ldflags 注入漂移;旧行为恒为 "dev" 导致 ServerInfo 页版本恒 dev,
// 2026-08-31 修复)。
var buildVersion = "dev"

// SetBuildVersion 注入运行时版本(main 启动时调用一次)。
func SetBuildVersion(v string) { buildVersion = v }

// BuildVersion 返回当前运行时版本(bootstrap 下发、门户页脚等处共用单一来源)。
func BuildVersion() string { return buildVersion }

// defaultUpdateChecker 是生产用包级缓存 checker(单例,跨请求共享缓存)。
var defaultUpdateCheckOnce sync.Once
var defaultUpdateCheckVal *updatecheck.CachedChecker

func defaultUpdateChecker() *updatecheck.CachedChecker {
	defaultUpdateCheckOnce.Do(func() {
		defaultUpdateCheckVal = updatecheck.NewCached()
	})
	return defaultUpdateCheckVal
}

// collectDBStats 按驱动收集行数与磁盘大小。
//
// R14-K（D-02）：**表名与语句都必须是字面量，且每条读经 serverstore 的唯一 pin
// 实现**。旧实现是 `statTables []string` + `db.QueryRow("SELECT COUNT(*) FROM " + t)`：
//
//	① 表名来自变量 ⇒ 守卫的 SQL 尺子（"SQL 关键字后紧跟**字面**表名"）零命中，
//	   于是 `server/` 的读面收口在这条路径上整片失效（正/负对照：同样的
//	   `SELECT COUNT(*) FROM usage` 写成字面量会立刻打红守卫，写成拼接则完全看不见）；
//	② 裸池 + 未限定名 ⇒ 连接/角色/库级 `search_path` 前置同名 shadow schema 时，
//	   `settings` / `gateway_providers` / `models` / `usage` / `audit_logs` 这 5 张
//	   **族内关系**的行数读自 shadow（运行期实测：旁路池 `usage=3 / audit_logs=5`，
//	   而 public 是 `1 / 1`）。这正是当年把 `audit_logs` 纳入族内集合的理由
//	   ——"审计 0 条看不出是读错了对象"——只是这条路径没被覆盖。
//
// 现在：语句在函数内的字面量表里逐条写死（`t.count` 只是**取用**，值域封闭在本
// 函数的字面量集合里），每条读各自经 `serverstore.NewUsageReadConn` 开一个**已钉**
// 只读事务 —— 串行、用完即还，既不会"持有一条再向池要第二条"（R14-K 的池自锁判据），
// 也不会读到 shadow。表缺失（旧库）仍逐条跳过，与旧实现逐字一致。
func collectDBStats(db *sql.DB) (dbStats, error) {
	s := dbStats{Tables: map[string]int64{}}
	// PG-only(2026-08 SQLite 已下线):驱动固定 pg,磁盘大小查 pg_database_size
	s.Driver = "pg"

	statTables := []struct {
		name  string
		count string
	}{
		{"users", `SELECT COUNT(*) FROM users`},
		{"groups", `SELECT COUNT(*) FROM groups`},
		{"user_groups", `SELECT COUNT(*) FROM user_groups`},
		{"settings", `SELECT COUNT(*) FROM settings`},
		{"api_tokens", `SELECT COUNT(*) FROM api_tokens`},
		// P5:旧的 skills/skill_grants 已下线,统计改为统一应用模型的三张表。
		{"gateway_providers", `SELECT COUNT(*) FROM gateway_providers`},
		{"models", `SELECT COUNT(*) FROM models`},
		{"usage", `SELECT COUNT(*) FROM usage`},
		{"apps", `SELECT COUNT(*) FROM apps`},
		{"app_releases", `SELECT COUNT(*) FROM app_releases`},
		{"app_grants", `SELECT COUNT(*) FROM app_grants`},
		{"audit_logs", `SELECT COUNT(*) FROM audit_logs`},
		{"admin_sessions", `SELECT COUNT(*) FROM admin_sessions`},
	}
	for _, t := range statTables {
		rd, err := serverstore.NewUsageReadConn(db)
		if err != nil {
			// 连"已钉只读事务"都开不出来：这不是"表缺失"，如实失败
			// （旧实现这里是 continue ⇒ 连接坏了会渲染成"所有表 0 行"）。
			return dbStats{}, err
		}
		var n int64
		err = rd.QueryRow(t.count).Scan(&n)
		_ = rd.Close() //nolint:errcheck // 只读事务回滚
		if err != nil {
			continue // 表不存在(旧库可能缺)跳过
		}
		s.Tables[t.name] = n
		s.TotalRows += n
	}
	s.SchemaMig = schemaVersion(db)

	// PG: 数据库大小
	var bytes int64
	_ = db.QueryRow("SELECT pg_database_size(current_database())").Scan(&bytes)
	s.DiskBytes = bytes
	s.DiskHuman = humanBytes(bytes)
	return s, nil
}

// schemaVersion 读 schema_migrations 最新版本。
func schemaVersion(db *sql.DB) int64 {
	var v int64
	_ = db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").Scan(&v)
	return v
}

// ---- Linux /proc 读取(标准库,无额外依赖) ----

// hostMemoryMB 读 /proc/meminfo 的 MemTotal。
func hostMemoryMB() float64 {
	b, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				kb, _ := strconv.ParseFloat(fields[1], 64)
				return round1(kb / 1024)
			}
		}
	}
	return 0
}

// hostLoadAvg 读 /proc/loadavg。
func hostLoadAvg() [3]float64 {
	b, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return [3]float64{0, 0, 0}
	}
	fields := strings.Fields(string(b))
	var out [3]float64
	for i := 0; i < 3 && i < len(fields); i++ {
		out[i], _ = strconv.ParseFloat(fields[i], 64)
	}
	return out
}

// hostDisk 读 path 所在文件系统的磁盘统计(syscall.Statfs)。
func hostDisk(path string) diskInfo {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return diskInfo{DataPath: path}
	}
	total := st.Blocks * uint64(st.Bsize)
	free := st.Bavail * uint64(st.Bsize)
	used := total - (st.Bfree * uint64(st.Bsize))
	pct := 0.0
	if total > 0 {
		pct = round1(float64(used) / float64(total) * 100)
	}
	return diskInfo{
		DataPath: path,
		TotalGB:  round1(float64(total) / 1024 / 1024 / 1024),
		UsedGB:   round1(float64(used) / 1024 / 1024 / 1024),
		FreeGB:   round1(float64(free) / 1024 / 1024 / 1024),
		UsedPct:  pct,
	}
}

// ---- 工具 ----

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

func humanBytes(n int64) string {
	if n >= 1024*1024*1024 {
		return strconv.FormatFloat(float64(n)/1024/1024/1024, 'f', 1, 64) + "GB"
	}
	if n >= 1024*1024 {
		return strconv.FormatFloat(float64(n)/1024/1024, 'f', 1, 64) + "MB"
	}
	return strconv.FormatFloat(float64(n)/1024, 'f', 1, 64) + "KB"
}

func humanDuration(d time.Duration) string {
	sec := int64(d.Seconds())
	day := sec / 86400
	h := (sec % 86400) / 3600
	m := (sec % 3600) / 60
	if day > 0 {
		return strconv.FormatInt(day, 10) + "天" + strconv.FormatInt(h, 10) + "时" + strconv.FormatInt(m, 10) + "分"
	}
	if h > 0 {
		return strconv.FormatInt(h, 10) + "时" + strconv.FormatInt(m, 10) + "分"
	}
	return strconv.FormatInt(m, 10) + "分" + strconv.FormatInt(sec%60, 10) + "秒"
}
