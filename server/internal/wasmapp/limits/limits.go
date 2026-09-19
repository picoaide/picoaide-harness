// Package limits 是 WASM 应用平台**全部上限数值的唯一真源**
// （设计基线 docs/planning/2026-09-17-wasm-app-platform.md §4）。
//
// 铁律（§4 开头 / §5.5「数值单一真源」）：
//   - 禁止在别处硬编码任何上限数值：其他包一律 import 本包常量；
//   - SKILL.md / 作者文档 / 错误文案里的数字由本包生成（见 limitsspec.go），
//     构建期门禁逐条比对（limits_gen_test.go）；
//   - 每个数值都在 §10 验证矩阵里有对应用例，变异验证要求"改回无上限即变红"。
//
// 本文件只放常量；可枚举的说明表在 limitsspec.go。
package limits

import "time"

// ===== §4.1 命名与标识 =====

const (
	// MaxAppIDLen 是 app_id 长度上限（DNS label 上限，R3）。
	MaxAppIDLen = 63
	// AppIDPattern 是平台既有标识规则（manifest.go 同源）：小写、无连续/首尾连字符。
	AppIDPattern = `^[a-z0-9]+(?:-[a-z0-9]+)*$`
	// VersionPattern 是严格版本号规则（§4.1）。
	VersionPattern = `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`
	// RetainedVersions 是「最近 N 个曾生效版本」的保留数（§5.3）。
	RetainedVersions = 3
	// ArtifactQuotaPerUserBytes 是每用户制品总量上限（PG BYTEA 口径，§5.3）：1 GiB。
	ArtifactQuotaPerUserBytes = 1 << 30
)

// ReservedAppIDs 是 app_id 保留字（§4.1）。
// 这些名字是平台/企业既有主机名，占用即等于抢走企业域名资产。
// 部署期可另外注入企业已知主机名（见 ReservedExtra）。
var ReservedAppIDs = []string{
	"www", "api", "admin", "portal", "app", "apps", "updates", "static", "cdn",
	"mail", "ns", "ns1", "ns2", "dns", "ftp", "vpn", "sso", "login", "auth",
	"autodiscover", "autoconfig", "mta-sts", "dmarc", "acme", "_acme-challenge",
}

// ===== §4.2 上传与包 =====

const (
	// WasmMaxBytes 是 .wasm 体积上限（R33）：32 MiB。
	WasmMaxBytes = 32 << 20
	// UploadBodyMaxBytes 是上传请求体上限（base64 JSON，R21）：48 MiB。
	UploadBodyMaxBytes = 48 << 20
	// ClientUploadTimeout 是客户端上传超时（§4.2）：90 s。
	// 必须 > ServerReadTimeout（§10.5 第 58 项是配置断言）。
	ClientUploadTimeout = 90 * time.Second
	// ServerReadTimeout 是服务端 http.Server.ReadTimeout：60 s。
	ServerReadTimeout = 60 * time.Second
	// SectionTotalMaxBytes 是 wasm 自定义段总量上限（§4.2）：4 MiB。
	SectionTotalMaxBytes = 4 << 20
	// AppConfigMaxBytes 是 picoaide.app.json 上限（§4.2）：64 KiB（不计入 wasm 上限）。
	AppConfigMaxBytes = 64 << 10
	// AppConfigWhitelistMax 是白名单条目上限（§4.2）：2 000 条。
	AppConfigWhitelistMax = 2000
	// CompileTimeout 是单次编译超时（§4.2/§4.3）：60 s。
	CompileTimeout = 60 * time.Second
	// DryRunBudget 是上传期合成帧干跑预算（§4.2）：2 s。
	DryRunBudget = 2 * time.Second
	// CompileQueueDepth 是编译队列深度（§4.3，R31）：64，满则 429。
	CompileQueueDepth = 64
	// CompileConcurrency 是编译进程并发度（§4.3，R31）：恒为 1（单进程串行）。
	CompileConcurrency = 1
	// UploadChunkMaxBytes 是分片上传的单片上限（§4.2「>8 MiB 走分片 + 续传」）：
	// 客户端在载荷超过这个值时切分；同时它也是服务端接受单片的上限。
	UploadChunkMaxBytes = 8 << 20
	// UploadChunkMinBytes 是分片上传的单片下限（防"把 32 MiB 切成 32 万片"这种
	// 元数据攻击：片数本身也要有界，见 UploadMaxChunks）。
	UploadChunkMinBytes = 64 << 10
	// UploadMaxChunks 是单个上传会话的片数上限：48 MiB / 64 KiB = 768，
	// 取 1024 留余量。片数是**有界资源**（每片一次请求 + 一份元数据）。
	UploadMaxChunks = 1024
	// UploadSessionTTL 是分片上传会话的有效期：超过即整会话作废（磁盘回收）。
	UploadSessionTTL = 30 * time.Minute
	// UploadSessionsPerUser 是每用户**同时**允许的分片上传会话数。
	UploadSessionsPerUser = 4
	// UploadDiskQuotaPerUserBytes 是每用户在**在飞上传**上的磁盘配额：
	// 未过期会话的**声明总量（预留）+ 本次声明**不得超过它。
	//
	// 为什么不复用 `UploadBodyMaxBytes`：那个是"单次请求体上限（base64）"，
	// 与"磁盘配额"是两个语义轴 —— 共用会让改前者静默改掉后者。
	// 为什么按**声明量（预留）**而不是实际落盘字节：Create 判定时实际字节还不存在，
	// 先开 4 个各 32 MiB 的空会话再慢慢填满 ⇒ 实际占用可以远超配额，闸门形同虚设；
	// 预留恒 ≥ 实际，因此 Σ实际 ≤ Σ声明 ≤ 本值 是真空上界。
	// 为什么不是 `UploadBodyMaxBytes × UploadSessionsPerUser`（192 MiB）：
	// 那个值**算术上不可达**（声明量上界恒为 会话数 × WasmMaxBytes < 会话数 × UploadBodyMaxBytes），
	// 是一条永远不触发的死闸门（独立审计实测）。
	// 取 48 MiB 让**两条闸门都活着**：大会话（32+32）先撞配额，小会话（4×8）先撞会话数。
	UploadDiskQuotaPerUserBytes = 48 << 20

	// UploadRatePerHour 是每用户上传频率上限（validate + publish 合计，§4.3）：30 次/小时。
	UploadRatePerHour = 30
	// UploadConcurrentCompiles 是同一用户同时编译中的上传上限（§4.3）：1。
	UploadConcurrentCompiles = 1
)

// WasmImportModule 是唯一允许的导入模块名（§10.2 第 17 项：env.* / js.* 一律拒）。
const WasmImportModule = "wasi_snapshot_preview1"

// RequiredExports 是导出面必须包含的符号（§4.2：额外导出忽略，如 Rust 的 __main_void）。
var RequiredExports = []string{"_start", "memory"}

// AppConfigFileName 是随包提交的应用配置文件名（§4.2）。
const AppConfigFileName = "picoaide.app.json"

// ===== §4.3 WASM 运行时 =====

const (
	// InstanceMemoryPages 是单实例线性内存页上限（R22）：1024 页 = 64 MiB。
	InstanceMemoryPages = 1024
	// WasmPageSize 是 wasm 线性内存页大小（规范固定 64 KiB，用于换算与文档生成）。
	WasmPageSize = 64 << 10
	// GlobalInstances 是全局并发实例上限（§4.6）：32（≈ 2 GiB 上界）。
	GlobalInstances = 32
	// CompileCacheMaxBytes 是 wazero 磁盘编译缓存回收阈值（§10.3 第 35 项）：512 MiB。
	CompileCacheMaxBytes = 512 << 20
	// CompileCacheMaxEntries 是缓存条目数上限（§10.3 第 35 项「或超条数」；
	// 文档未给具体数字，这里取固定值并作为唯一真源）。
	CompileCacheMaxEntries = 4096
	// ModuleCacheMaxBytes 是**进程内**编译模块缓存的记账上限（§4.3 第一笔账）。
	//
	// 与 CompileCacheMaxBytes（**磁盘**缓存）刻意解耦：磁盘可以留 512 MiB，
	// 进程内驻留必须按机器内存设。旧实现直接复用磁盘上限（512 MiB 记账，
	// 即最多 ≈128 MiB wasm 常驻），对"几百个应用 + 小内存机器"是危险默认。
	// 依据 2026-09-18 实测（temp/wasm-mem-probe）：3.45 MiB Go 应用编译后存活
	// ≈6 MiB（≈1.8×）、峰值 RSS ≈25 MB/应用。
	ModuleCacheMaxBytes = 128 << 20
	// ModuleCacheMaxEntries 是**进程内**编译模块缓存的条目数上限。
	//
	// 与磁盘缓存的 4096 条解耦：进程内条目受 ModuleCacheMaxBytes 约束更紧，
	// 条目上限只防"一堆极小模块把索引/元数据撑大"。
	ModuleCacheMaxEntries = 128
	// ModuleCacheIdleTTL 是**进程内**编译模块的空闲淘汰时间（§4.3）。
	//
	// 为什么必须有时间维度（而不只是 LRU 容量）：几百个应用里每个都可能被用过
	// 一次，容量未满时 LRU 永不淘汰 ⇒ 内存只涨不落（2026-09-18 实测：全部
	// Close 后 RSS 只归还约 20%）。空闲即逐出，并触发一次归还 OS。
	ModuleCacheIdleTTL = 10 * time.Minute
	// ReleaseCacheMaxBytes 是宿主**静态资源/应用配置**进程内缓存的字节上限（R1-rt-3）。
	//
	// 缓存键是 `(app_id, release_id)`（外加资源逻辑路径）：资源在 (app, version, path)
	// 三元组下**不可变**（§4.2「要改内容只能发新版」，assets.Write 拒绝覆盖），因此
	// 命中即可直出 —— 包括 `If-None-Match` 复验：304 只需要 ETag，而 ETag 与
	// content-type 都在缓存里 ⇒ **不读盘、不算哈希**（R1-rt-2）。
	//
	// 记账边界（**必须保持有界**）：它是**单一全局** LRU，硬上界 =
	//
	//	本值 + 单个 release 的资源总量（≤ SectionTotalMaxBytes，4 MiB）
	//	    + ReleaseCacheMaxReleases × 每条元数据（几百字节量级）
	//
	// 越界即按 LRU 整条释放；单条资源超过本值一半时只缓存元数据（不缓存字节）。
	// 之所以不进「内存四笔账」：那几笔是"并发 × 实例 / 单次峰值"型的常驻或瞬时上界，
	// 而本项与 ModuleCacheMaxBytes 同性质 —— 有界、可逐出、随访问增长但有硬顶。
	// 若将来把它调大或改成多份实例，必须回到 readyz 的记账边界注释重新算账
	//（见 readyz.MemoryBudget 的「记账边界」段）。
	ReleaseCacheMaxBytes = 32 << 20
	// ReleaseCacheMaxReleases 是上述缓存的 `(app_id, release_id)` 条目数上限：
	// 防"一堆极小应用把索引/元数据撑大"（与 ModuleCacheMaxEntries 同一考虑）。
	ReleaseCacheMaxReleases = 256
	// MemoryPeakGuardPercent 是启动自检的内存水位（§4.3）：理论峰值 > 可用内存 70% ⇒ 拒绝启动。
	MemoryPeakGuardPercent = 70
	// UploadPeakPerUploadBytes 是单次上传的峰值内存账（§4.3「内存四笔账」）：
	// base64 单次 ≈ 32+43+43 = 118 MB。
	UploadPeakPerUploadBytes = 118 << 20
	// DataDirMode 是应用数据目录权限（§6.3：数据目录 0700）。
	DataDirMode = 0o700
)

// ===== §4.5 SQL / 数据层 =====

const (
	// AppDBPageSize 是应用库页大小（§4.5）：4096 B。
	AppDBPageSize = 4096
	// AppDBMaxPageCount 是 100 MB 硬限对应的 max_page_count（§4.5，R2）：25600 页。
	AppDBMaxPageCount = 25600
	// AppDBMaxBytes 是应用库体积上限（R2）：100 MB。
	AppDBMaxBytes = AppDBMaxPageCount * AppDBPageSize
	// AppDBReaders 是每个应用库句柄持有的**只读连接数**（§4.5「连接级只读分层」）。
	//
	// 为什么要有它（2026-09-19，WAL + 多读者）：SQLite 在 WAL 下允许 N 个读者与
	// 1 个写者并发，只读连接数决定了"同一应用能同时跑多少条 SELECT"。取 4 的
	// 理由：每条只读连接都占一份页缓存（appdb 的 appConnCacheKiB）与一个 fd，
	// 4 在"单应用 4 路并发读"与"每句柄 (1+4) MiB 页缓存"之间取平衡；写路径仍只有一个
	// 写者（appdb 的 writeMu），所以这里加的是**读者**，不是写者。
	AppDBReaders = 4
	// AppDBReadersMax 是只读连接数的上限（注入值超过它即钳到它）。
	//
	// 它只是"配置注入的钳位"，不是 SQLite 的能力边界（连接数与 LIMIT_ATTACHED 无关）；
	// 给出上界是为了让"控制台填了 1000"退化成可诊断的 16，而不是直接把 fd 打满。
	AppDBReadersMax = 16
	// AppDBBusyTimeout 是每条应用库连接的 busy_timeout（SQLITE_BUSY 的重试等待）。
	//
	// 为什么不是驱动默认的 0（2026-09-19，WAL）：WAL 下写者与读者、检查点与写事务的
	// 瞬时争用是**正常现象**，busy_timeout=0 会把一次正常争用直接变成应用可见的
	// database_busy 失败。取 3 s 的理由：必须严格小于 SQLStatementBudget（5 s 单语句
	// 硬预算）—— 否则"等待"本身会吃掉整条语句的预算，应用看到的是 statement_timeout
	// 而不是"库忙，稍后重试"。⚠️ 连接级且不持久 ⇒ 每条连接都要重设（与 §15.1 第 4 条
	// 的 max_page_count 同一纪律）。
	AppDBBusyTimeout = 3000 * time.Millisecond

	// SQLLimitSQLLength 是单条 SQL 字节上限（§4.5，SQLITE_LIMIT_SQL_LENGTH）：64 KiB。
	SQLLimitSQLLength = 64 << 10
	// SQLLimitLength 是单值字节上限（§4.5，SQLITE_LIMIT_LENGTH）：1 MiB。
	SQLLimitLength = 1 << 20
	// SQLLimitColumn 是结果集列数上限（SQLITE_LIMIT_COLUMN）：128。
	SQLLimitColumn = 128
	// SQLLimitExprDepth 是表达式嵌套深度（SQLITE_LIMIT_EXPR_DEPTH）：32。
	SQLLimitExprDepth = 32
	// SQLLimitParserDepth 是解析栈深（SQLITE_LIMIT_PARSER_DEPTH）：32。
	SQLLimitParserDepth = 32
	// SQLLimitCompoundSelect 是复合 SELECT 上限（SQLITE_LIMIT_COMPOUND_SELECT）：8。
	SQLLimitCompoundSelect = 8
	// SQLLimitVDBEOp 是编译期 VDBE 指令上限（SQLITE_LIMIT_VDBE_OP）：50 000。
	// ⚠️ 不是运行期护栏（实测无界递归 CTE 只有 32 条指令）⇒ 运行期靠 SQLStatementBudget。
	SQLLimitVDBEOp = 50000
	// SQLLimitFunctionArg 是函数参数个数上限（SQLITE_LIMIT_FUNCTION_ARG）：16。
	SQLLimitFunctionArg = 16
	// SQLLimitVariableNumber 是绑定参数个数上限（SQLITE_LIMIT_VARIABLE_NUMBER）：128。
	SQLLimitVariableNumber = 128
	// SQLLimitAttached 是允许挂载的附加库数量（SQLITE_LIMIT_ATTACHED）：0。
	// ⚠️ 连接级且不持久 ⇒ 每条连接都要重设（漏设即 ATTACH 与 VACUUM INTO 同时复活）。
	SQLLimitAttached = 0
	// SQLLimitLikePatternLength 是 LIKE 模式长度上限（SQLITE_LIMIT_LIKE_PATTERN_LENGTH）：512。
	SQLLimitLikePatternLength = 512
	// SQLLimitTriggerDepth 是触发器嵌套深度（SQLITE_LIMIT_TRIGGER_DEPTH）：8。
	SQLLimitTriggerDepth = 8
	// SQLLimitWorkerThreads 是辅助线程数（SQLITE_LIMIT_WORKER_THREADS）：0。
	SQLLimitWorkerThreads = 0

	// SQLMaxRows 是单次查询返回行数上限（§4.5）：5 000 行，超出即截断并报错。
	SQLMaxRows = 5000
	// SQLMaxResultBytes 是单次查询返回字节上限（§4.5/§4.6）：8 MiB。
	SQLMaxResultBytes = 8 << 20
	// SQLStatementBudget 是单语句硬超时（R13/§4.5）：5 s（独立于 guest 超时）。
	SQLStatementBudget = 5 * time.Second

	// AppDBHandleMax 是进程内**同时持有**的应用库句柄上限。
	//
	// 取与 GlobalInstances 同值：每请求必须先拿到执行槽才会用到应用库 ⇒ 同一时刻
	// 最多 32 个应用在跑。每句柄 (1 + AppDBReaders) 条 SQLite 连接（1 写 + N 读）
	// ⇒ 默认配置下最多 32 × 5 = 160 条连接，给文件描述符一个硬上界。
	AppDBHandleMax = GlobalInstances

	// MaxTablesPerApp 是每应用表数上限（§4.5/§5.3）：16。
	MaxTablesPerApp = 16
	// MaxColumnsPerTable 是每表列数上限（§4.5/§5.3）：16。
	MaxColumnsPerTable = 16
	// TableNamePattern / ColumnNamePattern 是 db.define 的标识规则（§5.1）。
	TableNamePattern  = `^[a-z][a-z0-9_]{0,30}$`
	ColumnNamePattern = `^[a-z][a-z0-9_]{0,30}$`

	// ReservedRowIDColumn 是平台保留列（§5.2）：应用提到即拒。
	ReservedRowIDColumn = "_row_id"
)

// SQLColumnTypes 是封闭的列类型枚举（§4.5/§5.1）。
// 顺序即文档顺序，门禁测试要求与 SKILL/文档表格一致（§5.5）。
var SQLColumnTypes = []string{"text", "int", "real", "bool", "datetime"}

// SQLColumnTypeToSQLite 把枚举映射到 SQLite 列类型（db.define 宿主代执行用）。
var SQLColumnTypeToSQLite = map[string]string{
	"text":     "TEXT",
	"int":      "INTEGER",
	"real":     "REAL",
	"bool":     "INTEGER",
	"datetime": "TEXT",
}

// AllowedStatementKinds 是语句种类白名单（§4.5）：仅 SELECT/INSERT/UPDATE/DELETE。
var AllowedStatementKinds = []string{"SELECT", "INSERT", "UPDATE", "DELETE"}

// DeniedStatementKinds 是显式永久禁用的语句种类（§4.5/§10.1）。
// 不是因为"不在白名单"而拒，而是要在错误文案里给出可操作的提示，故单列。
var DeniedStatementKinds = []string{
	"CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "VACUUM", "PRAGMA",
	"REPLACE", "TRUNCATE", "GRANT", "REINDEX", "ANALYZE", "SAVEPOINT", "RELEASE",
}

// ===== §4.6 请求与队列 =====

const (
	// AppRequestBodyMaxBytes 是应用 API 请求体上限（§4.6）：1 MiB。
	// ⚠️ 子域路由树不在两个 1 MB 中间件分组里 ⇒ 必须自己实现。
	AppRequestBodyMaxBytes = 1 << 20
	// AppResponseBodyMaxBytes 是应用响应体上限（§4.6，R22）：8 MiB。
	AppResponseBodyMaxBytes = 8 << 20
	// ProtocolLineMaxBytes 是协议帧单行上限（§4.6）：1 MiB，超限 RUNTIME_OUTPUT_OVERRUN。
	ProtocolLineMaxBytes = 1 << 20
	// GuestBudget 是 guest 执行预算（§4.6）：10 s（进入宿主调用时暂停计时）。
	GuestBudget = 10 * time.Second
	// HostAIChatBudget 是 ai.chat 宿主预算（§4.4/§4.6）：30 s。
	HostAIChatBudget = 30 * time.Second
	// RequestWallClock 是请求端到端墙钟（含排队，§4.6）：60 s，到点即拒。
	RequestWallClock = 60 * time.Second
	// AppQueueDepth 是每应用队列长度（§4.6）：32，超出 429 + Retry-After。
	AppQueueDepth = 32
	// UserPerAppRunning 是单用户在**同一应用**内同时运行数（§4.6）：1。
	UserPerAppRunning = 1
	// UserPerAppQueued 是单用户在同一应用队列中的占位上限（§4.6）：4。
	UserPerAppQueued = 4
	// UserGlobalRunning 是单用户跨应用全局在跑上限（§4.6）：4。
	UserGlobalRunning = 4
	// AppConcurrency 是每应用并发（§4.6）：同一应用最多 4 个请求同时在跑（读并发）。
	//
	// 为什么从 1 改成 4（2026-09-19，第二轮「怎么支持高并发」的最后一公里）：
	// 「同应用串行」过去有四层叠加 —— 队列（本常量）、句柄池的整请求互斥量、
	// appdb 的一把大锁（读写共用）、以及池容量 2。2026-09-19 的 appdb 改造
	// （WAL + 1 写 N 读连接池 + stateMu/writeMu 拆分）把后三层解开了：同应用并发读
	// 已经是**真实能力**（BenchmarkQuerySelectParallel 36.7µs → 16.5µs，约 2.2–2.4×）。
	// 此时队列层继续把并发钉在 1，用户看到的就只剩"人为排队"——底层能吃并发，
	// 默认部署却仍然每请求串行。
	//
	// 为什么调大它**不增加内存上界**：实例池那笔账是 max_instances × 单实例内存上限
	// （见 readyz 的四笔账），与每应用并发无关；而 Validate 强制
	// app_running ≤ max_instances，全局并发仍由 max_instances（默认 32）封顶。
	// 需要额外留意的是 SQLite 页缓存这笔**不进四笔账**的常驻
	// （appdb_cache_kib × (1 + app_db_readers) × 句柄数），它的去向写在
	// applimits.Budget 的注释里。
	//
	// 写仍然是串行的（appdb 的 writeMu）：这一项放宽的是**读者**，不是写者。
	AppConcurrency = 4
	// RetryAfterSeconds 是队列满/限流时的 Retry-After 秒数（§4.6/§7.4）。
	RetryAfterSeconds = 1

	// AnonGlobalRatePerMin 是全局匿名令牌桶速率（R35/§4.6）：3000 次/分。
	AnonGlobalRatePerMin = 3000
	// AnonGlobalBurst 是全局匿名桶容量（与速率同量级，取 1 分钟配额）。
	AnonGlobalBurst = AnonGlobalRatePerMin
	// AnonPerIPRatePerMin 是每 IP 匿名速率（R35/§4.6）：60 次/分。
	AnonPerIPRatePerMin = 60
	// AnonPerIPBurst 是每 IP 匿名桶容量。
	AnonPerIPBurst = AnonPerIPRatePerMin

	// AppRuntimeConcurrency 是每应用运行槽（= AppConcurrency，语义别名，供队列实现引用）。
	//
	// 控制台把这一项叫 app_running（applimits.Limits.AppRunning），默认值即本常量：
	// 调大 ⇒ 同应用更多请求并发进入执行（读并发），**写仍串行**；
	// 超出它的请求进队列（app_queue，默认 32），队列再满才 429。
	AppRuntimeConcurrency = AppConcurrency
)

// ===== §4.7 账号、AI 与额度 =====

const (
	// TicketTTL 是一次性换票 code 的有效期（R12/§4.7）：60 s。
	TicketTTL = 60 * time.Second
	// AppSessionTTL 是应用子域会话 Cookie 的 TTL（R12/§4.7）：8 h。
	AppSessionTTL = 8 * time.Hour
	// AITokenTTL 是宿主为员工浏览器会话铸造的用户令牌有效期（§4.7）：45 min。
	AITokenTTL = 45 * time.Minute
	// AITokenRenewBefore 是令牌续期提前量（到期前多久重铸）。
	AITokenRenewBefore = 5 * time.Minute

	// AIUserRatePerMin 是平台既有用户级限流（网关已有，§4.7）：60 次/分。
	AIUserRatePerMin = 60
	// AIInFlightPerUser 是平台既有在途上限（InFlightGuard，§4.7）：32。
	AIInFlightPerUser = 32
)

// ===== §4.8 响应与浏览器侧 =====

// AppResponseHeaderAllowlist 是应用可设置的响应头白名单（§4.8）。
// 键为小写头名；Cookie 由宿主独占，不在白名单内。
var AppResponseHeaderAllowlist = []string{
	"content-type", "cache-control", "content-disposition", "x-content-type-options",
}

// AppResponseContentTypes 是允许的 content-type 集合（§4.8「限定集合」）。
var AppResponseContentTypes = []string{
	"text/html", "text/plain", "text/css", "text/javascript", "application/javascript",
	"application/json", "image/png", "image/jpeg", "image/gif", "image/svg+xml",
	"image/webp", "image/x-icon", "font/woff2", "font/woff", "application/octet-stream",
}

// AppContentSecurityPolicy 是宿主强制写入应用的 CSP（§4.8）。
// default-src 'none' + 自身源 script/style/img；frame-ancestors 'none'。
// 应用自带的同名头一律剥离（宿主独占，含 4xx/5xx）。
func AppContentSecurityPolicy(selfOrigin string) string {
	return "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self' data:; connect-src 'self'; form-action 'self'; " +
		"base-uri 'none'; frame-ancestors 'none'"
}

// ===== §4.9 审计与可观测 =====

const (
	// CallEventRetentionDays 是调用事件保留天数（§4.9/§5.3）：7 天。
	CallEventRetentionDays = 7
	// CallEventRingSize 是有界环形内存的容量（§4.9「有界环形内存 → 批量落独立表」）。
	CallEventRingSize = 4096
	// CallEventFlushInterval 是环形缓冲批量落库间隔。
	CallEventFlushInterval = 2 * time.Second
	// CallEventBatchMax 是单次批量落库的最大条数。
	CallEventBatchMax = 512
	// DiagnosticsDefaultLimit 是诊断 API 默认返回条数。
	DiagnosticsDefaultLimit = 50
	// DiagnosticsMaxLimit 是诊断 API 上限。
	DiagnosticsMaxLimit = 200
	// StderrTailBytes 是诊断里回给作者的 stderr 尾巴上限（§4.9/§7.4）。
	StderrTailBytes = 2 << 10
	// ReadyzSnapshotTTL 是 `/readyz` **快照缓存**的有效期（R1-rt-4）。
	//
	// 为什么必须有：一次采集要做编译缓存目录**全量递归 walk**（≤ CompileCacheMaxEntries
	// 条；实测 4096 条目 ≈9.5–14 ms）+ statfs + db.Ping，而 `/readyz` 是**未认证**端点、
	// 监控/编排通常每 1–5 s 打一次 ⇒ 未认证的放大面（每 1 s 一次 ≈1% 单核常驻 + 每秒
	// 4096 次 Lstat + 每秒一次 DB 往返）。缓存后稳态单次成本退化为一次内存拷贝。
	//
	// 取舍（认账）：`ok` 与各水位读数最多滞后本值；**发布闸门**（AllowPublish）与
	// 控制台内存预览走不缓存的 `Snapshot()`，不受影响 —— 那条路径要的是"此刻"。
	ReadyzSnapshotTTL = 5 * time.Second
)

// RetirementSnapshotRetentionDays 是退役快照保留天数（R37/§5.3）：90 天。
const RetirementSnapshotRetentionDays = 90

// ===== §5.1 宿主能力面 =====

const (
	// LogMaxLineBytes 是单条日志上限（§5.1）：4 KiB。
	LogMaxLineBytes = 4 << 10
	// LogMaxPerRequest 是每请求日志条数上限（§5.1）：100，超出丢弃并计数。
	LogMaxPerRequest = 100
	// HostCallBudgetDefault 是未单列预算的宿主调用的兜底预算。
	HostCallBudgetDefault = 5 * time.Second
	// AIChatMaxMessages 是 ai.chat 单次消息条数上限（防单次调用构造超巨载荷）。
	AIChatMaxMessages = 128
	// AIChatMaxBodyBytes 是 ai.chat 请求体上限。
	AIChatMaxBodyBytes = 1 << 20
)

// ===== §4.2 静态资源（assets.read / 发布期抽取）=====

const (
	// AssetMaxPathBytes 是包内资源逻辑路径的字节上限（§5.1「无路径穿越」的实现前提）。
	AssetMaxPathBytes = 256
	// AssetMaxSegmentBytes 是路径单段上限：POSIX NAME_MAX = 255。
	// 不做这个检查，256 字节的单段名会以 ENAMETOOLONG 变成一句不可读的 INTERNAL。
	AssetMaxSegmentBytes = 255
	// AssetMaxListEntries 是资源清单（自省/诊断）返回的条数上限。
	AssetMaxListEntries = 10000
)

// ===== §4.7 员工浏览器会话的输入形状 =====

const (
	// SessionMaxFormBytes 是员工登录 / 换票表单的请求体上限（形状约束：
	// 这两个表单只有几个短字段）。
	SessionMaxFormBytes = 8 << 10
	// SessionMaxUsernameBytes 与客户端面登录同口径（serverauth 的账号上限）。
	SessionMaxUsernameBytes = 128
	// SessionMaxPasswordBytes 与客户端面登录同口径。
	SessionMaxPasswordBytes = 1024
	// SessionMaxNextBytes 是换票 `next` 参数的长度上限（§4.7「next 只接受
	// 同基域相对路径」，长度上限是它的一部分）。
	SessionMaxNextBytes = 512
)

// ===== §4.3.1 编译缓存 =====

const (
	// CompileCacheDirName 是编译缓存目录名（数据根下）。
	CompileCacheDirName = "_compile-cache"
	// CompileCacheRevision 是编译缓存分代的**回落常量**：只有在拿不到 wazero 真实版本时
	// 才进缓存目录路径（`<dataRoot>/_compile-cache/<分代>/…`）。
	//
	// ⚠️ 事实更正（审计 P1-3，2026-09-18）：**"依赖方拿到的 wazero 版本是 dev" 只对
	// `go test` 二进制成立**。`go build` 出来的 main 二进制（服务端进程与
	// cmd/picoaide-app-compile 子进程都是这种形态）里 `debug.ReadBuildInfo().Deps` **有**
	// wazero，`version.GetWazeroVersion()` 返回真实版本（实测 v1.12.0）⇒ wazero 自己就会按
	// `wazero-v1.12.0-<os>-<arch>` 分片，升级 wazero 后旧条目本来就不会被命中。
	//
	// 所以分代的正确实现是：**优先用 wazero 的真实版本，只在拿不到版本（test 二进制 ⇒ "dev"）
	// 时回落到本常量** —— 唯一实现是 runtime.cacheNamespace() 与 compile.cacheNamespaceFor()
	// （两侧由一条交叉断言用例比对），它们同时决定缓存目录名。本常量因此只承担一件事：
	// 给"版本不可知的构建"一个可手工 +1 的隔离位。**升级 wazero 不必再改它**（生产形态自带真版本）。
	CompileCacheRevision = "r1"
	// AppsDirName 是应用数据根下的子目录名（库 + assets）。
	AppsDirName = "apps"
)
