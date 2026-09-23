package limits

import (
	"fmt"
	"time"
)

// Entry 是一条可枚举的上限（§4 护栏总表 / §5.5「数值单一真源」）。
//
// 生成物（limits.json 与 limits.md）由本表产出，SKILL.md / 作者文档 / 错误文案
// 的数字一律从这里来；构建期门禁（limits_gen_test.go）比对提交的生成物与实时
// 生成结果，不一致即红 —— 这样"文档里的数字与代码不一致"变成编译期错误。
type Entry struct {
	// Key 是机器可读名（limits.json 的键，蛇形）。
	Key string
	// Value 是数值的字符串形态（int / 秒 / MiB / 布尔 / 枚举）。
	Value string
	// Unit 是单位（bytes / seconds / count / pages / percent / 空）。
	Unit string
	// Section 对应设计文档的章节（如 §4.2）。
	Section string
	// Title 是中文名。
	Title string
	// Note 是补充说明（可空）。
	Note string
}

// Table 返回全部上限条目（**顺序即文档顺序**，生成物按此顺序输出）。
//
// 维护规则：新增/修改任何上限数值时，必须同步更新本表；忘更新会被
// limits_gen_test.go 的"表覆盖全部导出常量"用例抓住（见该测试）。
func Table() []Entry {
	return []Entry{
		// ===== §4.1 命名与标识 =====
		{"max_app_id_len", itoa(MaxAppIDLen), "count", "§4.1", "app_id 长度上限", "DNS label 上限；app_id 是应用标识（客户端内即 `<渠道 app 源 scheme>://<app_id>` 的 host 段）"},
		{"app_id_pattern", AppIDPattern, "", "§4.1", "app_id 规则", "小写、无连续/首尾连字符"},
		{"version_pattern", VersionPattern, "", "§4.1", "版本号规则", "严格 x.y.z（可带 -prerelease），必须严格递增"},
		{"retained_versions", itoa(RetainedVersions), "count", "§5.3", "保留版本数", "最近 N 个曾生效版本；更早的软删并归档置空"},
		{"artifact_quota_per_user_bytes", itoa(ArtifactQuotaPerUserBytes), "bytes", "§5.3", "每用户制品总量", "PG BYTEA 口径，含全部版本"},
		{"reserved_app_ids", joinCSV(ReservedAppIDs), "", "§4.1", "app_id 保留字", "另有部署期注入的企业已知主机名"},

		// ===== §4.2 上传与包 =====
		{"wasm_max_bytes", itoa(WasmMaxBytes), "bytes", "§4.2", ".wasm 体积上限", ""},
		{"upload_body_max_bytes", itoa(UploadBodyMaxBytes), "bytes", "§4.2", "上传请求体上限", "base64 JSON；必须进 largeBodyRoutes 且 handler 自套 MaxBytesReader"},
		{"client_upload_timeout", secs(ClientUploadTimeout), "seconds", "§4.2", "客户端上传超时", "必须大于服务端 ReadTimeout（§10.5 第 58 项是配置断言）"},
		{"server_read_timeout", secs(ServerReadTimeout), "seconds", "§4.2", "服务端 ReadTimeout", "48 MiB 需约 6.7 Mbps 保底"},
		{"section_total_max_bytes", itoa(SectionTotalMaxBytes), "bytes", "§4.2", "自定义段总量上限", "超限 SECTION_OVERRIDE_OVERSIZE"},
		{"app_config_max_bytes", itoa(AppConfigMaxBytes), "bytes", "§4.2", "应用配置文件上限", "picoaide.app.json，不计入 wasm 上限"},
		{"app_config_whitelist_max", itoa(AppConfigWhitelistMax), "count", "§4.2", "白名单条目上限", "平台不校验账号是否存在（否则等于账号枚举接口）"},
		{"app_config_sensitive_columns_max", itoa(AppConfigSensitiveColumnsMax), "count", "§4.2", "作者声明敏感列上限", "sensitive_columns：默认启发式之外**由作者补充**的脱敏列；条目去重按大小写不敏感"},
		{"app_config_sensitive_column_max_bytes", itoa(AppConfigSensitiveColumnMaxBytes), "bytes", "§4.2", "声明敏感列名单项字节上限", "单条列名超过它只可能是走样输入（整行/整段被粘进来），且永远匹配不到任何一列"},
		{"compile_timeout", secs(CompileTimeout), "seconds", "§4.2", "编译超时", "同步 publish 在 60 s 预算内完成"},
		{"dry_run_budget", secs(DryRunBudget), "seconds", "§4.2", "合成帧干跑预算", "编译通过 ≠ 能跑（签名不匹配编译期全绿）"},
		{"compile_queue_depth", itoa(CompileQueueDepth), "count", "§4.3", "编译队列深度", "满则拒绝"},
		{"compile_concurrency", itoa(CompileConcurrency), "count", "§4.3", "编译并发", "单进程串行"},
		{"upload_chunk_max_bytes", itoa(UploadChunkMaxBytes), "bytes", "§4.2", "分片上传单片上限", "载荷超过它就走分片 + 续传"},
		{"upload_chunk_min_bytes", itoa(UploadChunkMinBytes), "bytes", "§4.2", "分片上传单片下限", "防把载荷切成海量碎片"},
		{"upload_max_chunks", itoa(UploadMaxChunks), "count", "§4.2", "单会话片数上限", "片数是有界资源"},
		{"upload_session_ttl", secs(UploadSessionTTL), "seconds", "§4.2", "分片上传会话有效期", "过期整会话作废并回收磁盘"},
		{"upload_sessions_per_user", itoa(UploadSessionsPerUser), "count", "§4.2", "每用户并发上传会话数", ""},
		{"upload_disk_quota_per_user_bytes", itoa(UploadDiskQuotaPerUserBytes), "bytes", "§4.2", "每用户在飞上传磁盘配额", "按未过期会话的声明总量（预留）判定；预留恒 ≥ 实际 ⇒ 真空上界"},
		{"upload_rate_per_hour", itoa(UploadRatePerHour), "count", "§4.3", "每用户上传频率", "validate + publish 合计"},
		{"upload_concurrent_compiles", itoa(UploadConcurrentCompiles), "count", "§4.3", "同时编译中的上传数", ""},
		{"wasm_import_module", WasmImportModule, "", "§4.2", "唯一允许的导入模块", "env.* / js.* 一律拒"},
		{"required_exports", joinCSV(RequiredExports), "", "§4.2", "必须导出", "额外导出忽略"},
		{"asset_max_path_bytes", itoa(AssetMaxPathBytes), "bytes", "§4.2", "包内资源路径上限", "assets.read 的逻辑路径，不是宿主文件路径"},
		{"asset_max_segment_bytes", itoa(AssetMaxSegmentBytes), "bytes", "§4.2", "资源路径单段上限", "POSIX NAME_MAX；不检查会退化成不可读的 ENAMETOOLONG"},
		{"asset_max_list_entries", itoa(AssetMaxListEntries), "count", "§4.2", "资源清单条数上限", "自省/诊断接口"},

		// ===== §4.3 WASM 运行时 =====
		{"instance_memory_pages", itoa(InstanceMemoryPages), "pages", "§4.3", "单实例线性内存页", fmt.Sprintf("%d MiB", InstanceMemoryPages*WasmPageSize/(1<<20))},
		{"instance_memory_bytes", itoa(InstanceMemoryPages * WasmPageSize), "bytes", "§4.3", "单实例内存上限", "WithMemoryLimitPages"},
		{"global_instances", itoa(GlobalInstances), "count", "§4.6", "全局并发实例", "≈ 2 GiB 上界"},
		{"compile_cache_max_bytes", itoa(CompileCacheMaxBytes), "bytes", "§4.3", "编译缓存体积上限", "wazero 磁盘缓存，按 mtime 回收"},
		{"compile_cache_max_entries", itoa(CompileCacheMaxEntries), "count", "§4.3", "编译缓存条目上限", ""},
		{"module_cache_max_bytes", itoa(ModuleCacheMaxBytes), "bytes", "§4.3", "进程内编译模块缓存上限", "与磁盘缓存解耦；按部署内存档位可缩放"},
		{"module_cache_max_entries", itoa(ModuleCacheMaxEntries), "count", "§4.3", "进程内编译模块条目上限", ""},
		{"module_cache_idle_ttl", secs(ModuleCacheIdleTTL), "seconds", "§4.3", "编译模块空闲淘汰", "空闲即逐出并归还 OS（几百个应用的常驻上界）"},
		{"release_cache_max_bytes", itoa(ReleaseCacheMaxBytes), "bytes", "§4.3", "静态资源缓存字节上限", "(app_id, release_id) 级缓存；304 复验不读盘、不算哈希（单条超一半只缓存元数据）"},
		{"release_cache_max_releases", itoa(ReleaseCacheMaxReleases), "count", "§4.3", "静态资源缓存条目上限", "按 (app_id, release_id) 计数；下架/冻结/删除/逐出与换版本都失效"},
		{"memory_peak_guard_percent", itoa(MemoryPeakGuardPercent), "percent", "§4.3", "启动自检内存水位", "理论峰值超过可用内存该比例即拒绝启动"},
		{"upload_peak_per_upload_bytes", itoa(UploadPeakPerUploadBytes), "bytes", "§4.3", "单次上传峰值内存账", "base64 单次 ≈ 32+43+43 MB"},

		// ===== §4.4 宿主能力 =====
		{"host_call_budget_default", secs(HostCallBudgetDefault), "seconds", "§4.4", "宿主调用兜底预算", ""},

		// ===== §21.2 客户端 AI 桥（跨端冻结契约）=====
		// 桥由客户端协议 handler 实现，但形状是跨端契约；作者文档/技能的数字必须
		// 来自本表（§5.5），否则技能里的"单条 16 KiB"会与实现漂移。
		{"ai_bridge_max_messages", itoa(AIBridgeMaxMessages), "count", "§21.2", "AI 桥消息条数上限", "应用前端 fetch('/__picoaide/ai/chat') 的 messages 数组长度"},
		{"ai_bridge_message_max_bytes", itoa(AIBridgeMessageMaxBytes), "bytes", "§21.2", "AI 桥单条消息上限", "单条 message.content 的字节上限（应用侧据此截断/切分）"},

		// ===== §4.5 SQL / 数据层 =====
		{"app_db_page_size", itoa(AppDBPageSize), "bytes", "§4.5", "应用库页大小", ""},
		{"app_db_max_page_count", itoa(AppDBMaxPageCount), "pages", "§4.5", "应用库 max_page_count", "PRAGMA max_page_count，连接级不持久 ⇒ 每条连接重设"},
		{"app_db_max_bytes", itoa(AppDBMaxBytes), "bytes", "§4.5", "应用库体积上限", "100 MB 硬限（平台固定，用户无旋钮）"},
		{"sql_limit_sql_length", itoa(SQLLimitSQLLength), "bytes", "§4.5", "SQLITE_LIMIT_SQL_LENGTH", "单条 SQL"},
		{"sql_limit_length", itoa(SQLLimitLength), "bytes", "§4.5", "SQLITE_LIMIT_LENGTH", "单值"},
		{"sql_limit_column", itoa(SQLLimitColumn), "count", "§4.5", "SQLITE_LIMIT_COLUMN", "结果集列数"},
		{"sql_limit_expr_depth", itoa(SQLLimitExprDepth), "count", "§4.5", "SQLITE_LIMIT_EXPR_DEPTH", ""},
		{"sql_limit_parser_depth", itoa(SQLLimitParserDepth), "count", "§4.5", "SQLITE_LIMIT_PARSER_DEPTH", ""},
		{"sql_limit_compound_select", itoa(SQLLimitCompoundSelect), "count", "§4.5", "SQLITE_LIMIT_COMPOUND_SELECT", ""},
		{"sql_limit_vdbe_op", itoa(SQLLimitVDBEOp), "count", "§4.5", "SQLITE_LIMIT_VDBE_OP", "挡编译期巨型语句；不是运行期护栏"},
		{"sql_limit_function_arg", itoa(SQLLimitFunctionArg), "count", "§4.5", "SQLITE_LIMIT_FUNCTION_ARG", ""},
		{"sql_limit_variable_number", itoa(SQLLimitVariableNumber), "count", "§4.5", "SQLITE_LIMIT_VARIABLE_NUMBER", ""},
		{"sql_limit_attached", itoa(SQLLimitAttached), "count", "§4.5", "SQLITE_LIMIT_ATTACHED", "0 = 引擎层否决 ATTACH，也是 VACUUM INTO 的唯一闸门"},
		{"sql_limit_like_pattern_length", itoa(SQLLimitLikePatternLength), "count", "§4.5", "SQLITE_LIMIT_LIKE_PATTERN_LENGTH", ""},
		{"sql_limit_trigger_depth", itoa(SQLLimitTriggerDepth), "count", "§4.5", "SQLITE_LIMIT_TRIGGER_DEPTH", ""},
		{"sql_limit_worker_threads", itoa(SQLLimitWorkerThreads), "count", "§4.5", "SQLITE_LIMIT_WORKER_THREADS", "禁辅助线程"},
		{"sql_max_rows", itoa(SQLMaxRows), "count", "§4.5", "返回行数上限", "只截断并置 QueryResult.Truncated，不报错（分页信号；见 appdb/stmt.go）"},
		{"sql_max_result_bytes", itoa(SQLMaxResultBytes), "bytes", "§4.5", "返回字节上限", ""},
		{"sql_statement_budget", secs(SQLStatementBudget), "seconds", "§4.5", "单语句硬超时", "独立于 guest 超时；驱动取消时 sqlite3_interrupt"},
		{"app_db_readers", itoa(AppDBReaders), "count", "§4.5", "每应用只读连接数", "WAL 下并发读；写仍只由一个写者串行"},
		{"app_db_readers_max", itoa(AppDBReadersMax), "count", "§4.5", "只读连接数上限", "配置注入的钳位（超出即钳到该值）"},
		{"app_db_busy_timeout", secs(AppDBBusyTimeout), "seconds", "§4.5", "应用库连接 busy_timeout", "连接级不持久 ⇒ 每条连接重设；必须小于 sql_statement_budget"},
		{"app_db_handle_max", itoa(AppDBHandleMax), "count", "§4.5", "同时持有的应用库句柄上限", "每句柄 (1 + app_db_readers) 条 SQLite 连接 ⇒ fd 硬上界"},
		{"max_tables_per_app", itoa(MaxTablesPerApp), "count", "§4.5", "每应用表数上限", "由 db.define 强制"},
		{"max_columns_per_table", itoa(MaxColumnsPerTable), "count", "§4.5", "每表列数上限", "由 db.define 强制"},
		{"table_name_pattern", TableNamePattern, "", "§4.5", "表名规则", ""},
		{"column_name_pattern", ColumnNamePattern, "", "§4.5", "列名规则", ""},
		{"reserved_row_id_column", ReservedRowIDColumn, "", "§5.2", "平台保留列", "应用提到即拒"},
		{"sql_column_types", joinCSV(SQLColumnTypes), "", "§4.5", "列类型枚举", "封闭集合"},
		{"allowed_statement_kinds", joinCSV(AllowedStatementKinds), "", "§4.5", "语句种类白名单", "其余一律拒（含全部 DDL）"},

		// ===== §4.6 请求与队列 =====
		{"app_request_body_max_bytes", itoa(AppRequestBodyMaxBytes), "bytes", "§4.6", "应用 API 请求体上限", "客户端请求信封自带上限；管线仍自套 MaxBytesReader 兜住 chunked/长度撒谎"},
		{"app_response_body_max_bytes", itoa(AppResponseBodyMaxBytes), "bytes", "§4.6", "应用响应体上限", ""},
		{"protocol_line_max_bytes", itoa(ProtocolLineMaxBytes), "bytes", "§4.6", "协议帧单行上限", "超限 RUNTIME_OUTPUT_OVERRUN"},
		{"guest_budget", secs(GuestBudget), "seconds", "§4.6", "guest 执行预算", "进入宿主调用时暂停计时"},
		{"request_wall_clock", secs(RequestWallClock), "seconds", "§4.6", "请求端到端墙钟", "含排队等待，到点即拒"},
		{"app_queue_depth", itoa(AppQueueDepth), "count", "§4.6", "每应用队列长度", "超出 429 + Retry-After"},
		{"user_per_app_running", itoa(UserPerAppRunning), "count", "§4.6", "单用户同应用在跑", ""},
		{"user_per_app_queued", itoa(UserPerAppQueued), "count", "§4.6", "单用户同应用排队", ""},
		{"user_global_running", itoa(UserGlobalRunning), "count", "§4.6", "单用户跨应用全局在跑", ""},
		{"app_concurrency", itoa(AppConcurrency), "count", "§4.6", "每应用并发", "同一应用最多 N 个请求同时在跑（控制台对应 app_running）；读并发，写仍串行"},
		{"retry_after_seconds", itoa(RetryAfterSeconds), "seconds", "§4.6", "Retry-After", ""},

		// ===== §4.7 账号与额度 =====
		// ⚠️ W4：换票 / 应用会话 / AI 令牌 / 匿名面 / 员工浏览器表单的数值已随它们的
		// 对象一起删除（总纲 §8.4 + §21.3）；这张表只保留**仍然生效**的数值。

		// ===== §4.9 / §5.1 / §5.3 =====
		{"call_event_retention_days", itoa(CallEventRetentionDays), "days", "§4.9", "调用事件保留", ""},
		{"call_event_ring_size", itoa(CallEventRingSize), "count", "§4.9", "调用事件环形内存容量", ""},
		{"call_event_flush_interval", secs(CallEventFlushInterval), "seconds", "§4.9", "调用事件批量落库间隔", ""},
		{"call_event_batch_max", itoa(CallEventBatchMax), "count", "§4.9", "调用事件单批上限", ""},
		{"diagnostics_default_limit", itoa(DiagnosticsDefaultLimit), "count", "§4.9", "诊断默认条数", ""},
		{"diagnostics_max_limit", itoa(DiagnosticsMaxLimit), "count", "§4.9", "诊断条数上限", ""},
		{"stderr_tail_bytes", itoa(StderrTailBytes), "bytes", "§4.9", "stderr 尾巴上限", "诊断回给作者"},
		{"readyz_snapshot_ttl", secs(ReadyzSnapshotTTL), "seconds", "§4.9", "/readyz 快照缓存时长", "未认证端点；缓存整次采集（目录 walk + statfs + db.Ping）"},
		{"retirement_snapshot_retention_days", itoa(RetirementSnapshotRetentionDays), "days", "§5.3", "退役快照保留", "冻结/退役后保留快照的时长；到期由平台回收"},
		{"log_max_line_bytes", itoa(LogMaxLineBytes), "bytes", "§5.1", "单条日志上限", ""},
		{"log_max_per_request", itoa(LogMaxPerRequest), "count", "§5.1", "每请求日志条数上限", "超出丢弃并计数"},
	}
}

// JSON 是生成物的机器可读形态（供 SKILL.md 与作者文档生成）。
type JSONDoc struct {
	// Version 是 limits 表的结构版本（加字段/改语义时递增）。
	Version int `json:"version"`
	// Generated 由生成器写入（提交的产物里是"由 limits.go 生成"的说明占位，
	// 不写时间戳 —— 否则每次生成都会产生 diff，门禁比对会假红）。
	Source string  `json:"source"`
	Items  []Entry `json:"items"`
}

// Doc 返回机器可读文档。
func Doc() JSONDoc {
	return JSONDoc{Version: 1, Source: "server/internal/wasmapp/limits/limits.go", Items: Table()}
}

func itoa(v int) string { return fmt.Sprintf("%d", v) }

func secs(d time.Duration) string { return fmt.Sprintf("%g", d.Seconds()) }

func joinCSV(xs []string) string {
	out := ""
	for i, x := range xs {
		if i > 0 {
			out += ", "
		}
		out += x
	}
	return out
}
