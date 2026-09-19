# WASM 应用平台上限表

本文件由 `go generate ./internal/wasmapp/limits` 生成，不要手改。

单一真源：`server/internal/wasmapp/limits/limits.go`（含 `limitsspec.go` 的表定义）。改任何上限数值请改源码后重新生成——本表里的每个数字都必须与代码一致。

| 键 | 值 | 单位 | 章节 | 名称 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `max_app_id_len` | 63 | count | §4.1 | app_id 长度上限 | DNS label 上限；app_id 本身就是域名标签 |
| `app_id_pattern` | ^[a-z0-9]+(?:-[a-z0-9]+)*$ |  | §4.1 | app_id 规则 | 小写、无连续/首尾连字符 |
| `version_pattern` | ^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$ |  | §4.1 | 版本号规则 | 严格 x.y.z（可带 -prerelease），必须严格递增 |
| `retained_versions` | 3 | count | §5.3 | 保留版本数 | 最近 N 个曾生效版本；更早的软删并归档置空 |
| `artifact_quota_per_user_bytes` | 1073741824 | bytes | §5.3 | 每用户制品总量 | PG BYTEA 口径，含全部版本 |
| `reserved_app_ids` | `www, api, admin, portal, app, apps, updates, static, cdn, mail, ns, ns1, ns2, dns, ftp, vpn, sso, login, auth, autodiscover, autoconfig, mta-sts, dmarc, acme, _acme-challenge` |  | §4.1 | app_id 保留字 | 另有部署期注入的企业已知主机名 |
| `wasm_max_bytes` | 33554432 | bytes | §4.2 | .wasm 体积上限 |  |
| `upload_body_max_bytes` | 50331648 | bytes | §4.2 | 上传请求体上限 | base64 JSON；必须进 largeBodyRoutes 且 handler 自套 MaxBytesReader |
| `client_upload_timeout` | 90 | seconds | §4.2 | 客户端上传超时 | 必须大于服务端 ReadTimeout（§10.5 第 58 项是配置断言） |
| `server_read_timeout` | 60 | seconds | §4.2 | 服务端 ReadTimeout | 48 MiB 需约 6.7 Mbps 保底 |
| `section_total_max_bytes` | 4194304 | bytes | §4.2 | 自定义段总量上限 | 超限 SECTION_OVERRIDE_OVERSIZE |
| `app_config_max_bytes` | 65536 | bytes | §4.2 | 应用配置文件上限 | picoaide.app.json，不计入 wasm 上限 |
| `app_config_whitelist_max` | 2000 | count | §4.2 | 白名单条目上限 | 平台不校验账号是否存在（否则等于账号枚举接口） |
| `compile_timeout` | 60 | seconds | §4.2 | 编译超时 | 同步 publish 在 60 s 预算内完成 |
| `dry_run_budget` | 2 | seconds | §4.2 | 合成帧干跑预算 | 编译通过 ≠ 能跑（签名不匹配编译期全绿） |
| `compile_queue_depth` | 64 | count | §4.3 | 编译队列深度 | 满则拒绝 |
| `compile_concurrency` | 1 | count | §4.3 | 编译并发 | 单进程串行 |
| `upload_chunk_max_bytes` | 8388608 | bytes | §4.2 | 分片上传单片上限 | 载荷超过它就走分片 + 续传 |
| `upload_chunk_min_bytes` | 65536 | bytes | §4.2 | 分片上传单片下限 | 防把载荷切成海量碎片 |
| `upload_max_chunks` | 1024 | count | §4.2 | 单会话片数上限 | 片数是有界资源 |
| `upload_session_ttl` | 1800 | seconds | §4.2 | 分片上传会话有效期 | 过期整会话作废并回收磁盘 |
| `upload_sessions_per_user` | 4 | count | §4.2 | 每用户并发上传会话数 |  |
| `upload_disk_quota_per_user_bytes` | 50331648 | bytes | §4.2 | 每用户在飞上传磁盘配额 | 按未过期会话的声明总量（预留）判定；预留恒 ≥ 实际 ⇒ 真空上界 |
| `upload_rate_per_hour` | 30 | count | §4.3 | 每用户上传频率 | validate + publish 合计 |
| `upload_concurrent_compiles` | 1 | count | §4.3 | 同时编译中的上传数 |  |
| `wasm_import_module` | wasi_snapshot_preview1 |  | §4.2 | 唯一允许的导入模块 | env.* / js.* 一律拒 |
| `required_exports` | `_start, memory` |  | §4.2 | 必须导出 | 额外导出忽略 |
| `asset_max_path_bytes` | 256 | bytes | §4.2 | 包内资源路径上限 | assets.read 的逻辑路径，不是宿主文件路径 |
| `asset_max_segment_bytes` | 255 | bytes | §4.2 | 资源路径单段上限 | POSIX NAME_MAX；不检查会退化成不可读的 ENAMETOOLONG |
| `asset_max_list_entries` | 10000 | count | §4.2 | 资源清单条数上限 | 自省/诊断接口 |
| `instance_memory_pages` | 1024 | pages | §4.3 | 单实例线性内存页 | 64 MiB |
| `instance_memory_bytes` | 67108864 | bytes | §4.3 | 单实例内存上限 | WithMemoryLimitPages |
| `global_instances` | 32 | count | §4.6 | 全局并发实例 | ≈ 2 GiB 上界 |
| `compile_cache_max_bytes` | 536870912 | bytes | §4.3 | 编译缓存体积上限 | wazero 磁盘缓存，按 mtime 回收 |
| `compile_cache_max_entries` | 4096 | count | §4.3 | 编译缓存条目上限 |  |
| `module_cache_max_bytes` | 134217728 | bytes | §4.3 | 进程内编译模块缓存上限 | 与磁盘缓存解耦；按部署内存档位可缩放 |
| `module_cache_max_entries` | 128 | count | §4.3 | 进程内编译模块条目上限 |  |
| `module_cache_idle_ttl` | 600 | seconds | §4.3 | 编译模块空闲淘汰 | 空闲即逐出并归还 OS（几百个应用的常驻上界） |
| `memory_peak_guard_percent` | 70 | percent | §4.3 | 启动自检内存水位 | 理论峰值超过可用内存该比例即拒绝启动 |
| `upload_peak_per_upload_bytes` | 123731968 | bytes | §4.3 | 单次上传峰值内存账 | base64 单次 ≈ 32+43+43 MB |
| `host_call_budget_default` | 5 | seconds | §4.4 | 宿主调用兜底预算 |  |
| `ai_chat_max_messages` | 128 | count | §4.4 | ai.chat 消息条数上限 |  |
| `ai_chat_max_body_bytes` | 1048576 | bytes | §4.4 | ai.chat 请求体上限 |  |
| `app_db_page_size` | 4096 | bytes | §4.5 | 应用库页大小 |  |
| `app_db_max_page_count` | 25600 | pages | §4.5 | 应用库 max_page_count | PRAGMA max_page_count，连接级不持久 ⇒ 每条连接重设 |
| `app_db_max_bytes` | 104857600 | bytes | §4.5 | 应用库体积上限 | 100 MB 硬限（平台固定，用户无旋钮） |
| `sql_limit_sql_length` | 65536 | bytes | §4.5 | SQLITE_LIMIT_SQL_LENGTH | 单条 SQL |
| `sql_limit_length` | 1048576 | bytes | §4.5 | SQLITE_LIMIT_LENGTH | 单值 |
| `sql_limit_column` | 128 | count | §4.5 | SQLITE_LIMIT_COLUMN | 结果集列数 |
| `sql_limit_expr_depth` | 32 | count | §4.5 | SQLITE_LIMIT_EXPR_DEPTH |  |
| `sql_limit_parser_depth` | 32 | count | §4.5 | SQLITE_LIMIT_PARSER_DEPTH |  |
| `sql_limit_compound_select` | 8 | count | §4.5 | SQLITE_LIMIT_COMPOUND_SELECT |  |
| `sql_limit_vdbe_op` | 50000 | count | §4.5 | SQLITE_LIMIT_VDBE_OP | 挡编译期巨型语句；不是运行期护栏 |
| `sql_limit_function_arg` | 16 | count | §4.5 | SQLITE_LIMIT_FUNCTION_ARG |  |
| `sql_limit_variable_number` | 128 | count | §4.5 | SQLITE_LIMIT_VARIABLE_NUMBER |  |
| `sql_limit_attached` | 0 | count | §4.5 | SQLITE_LIMIT_ATTACHED | 0 = 引擎层否决 ATTACH，也是 VACUUM INTO 的唯一闸门 |
| `sql_limit_like_pattern_length` | 512 | count | §4.5 | SQLITE_LIMIT_LIKE_PATTERN_LENGTH |  |
| `sql_limit_trigger_depth` | 8 | count | §4.5 | SQLITE_LIMIT_TRIGGER_DEPTH |  |
| `sql_limit_worker_threads` | 0 | count | §4.5 | SQLITE_LIMIT_WORKER_THREADS | 禁辅助线程 |
| `sql_max_rows` | 5000 | count | §4.5 | 返回行数上限 | 超出即截断并报错 |
| `sql_max_result_bytes` | 8388608 | bytes | §4.5 | 返回字节上限 |  |
| `sql_statement_budget` | 5 | seconds | §4.5 | 单语句硬超时 | 独立于 guest 超时；驱动取消时 sqlite3_interrupt |
| `app_db_readers` | 4 | count | §4.5 | 每应用只读连接数 | WAL 下并发读；写仍只由一个写者串行 |
| `app_db_readers_max` | 16 | count | §4.5 | 只读连接数上限 | 配置注入的钳位（超出即钳到该值） |
| `app_db_busy_timeout` | 3 | seconds | §4.5 | 应用库连接 busy_timeout | 连接级不持久 ⇒ 每条连接重设；必须小于 sql_statement_budget |
| `app_db_handle_max` | 32 | count | §4.5 | 同时持有的应用库句柄上限 | 每句柄 (1 + app_db_readers) 条 SQLite 连接 ⇒ fd 硬上界 |
| `max_tables_per_app` | 16 | count | §4.5 | 每应用表数上限 | 由 db.define 强制 |
| `max_columns_per_table` | 16 | count | §4.5 | 每表列数上限 | 由 db.define 强制 |
| `table_name_pattern` | ^[a-z][a-z0-9_]{0,30}$ |  | §4.5 | 表名规则 |  |
| `column_name_pattern` | ^[a-z][a-z0-9_]{0,30}$ |  | §4.5 | 列名规则 |  |
| `reserved_row_id_column` | _row_id |  | §5.2 | 平台保留列 | 应用提到即拒 |
| `sql_column_types` | `text, int, real, bool, datetime` |  | §4.5 | 列类型枚举 | 封闭集合 |
| `allowed_statement_kinds` | `SELECT, INSERT, UPDATE, DELETE` |  | §4.5 | 语句种类白名单 | 其余一律拒（含全部 DDL） |
| `app_request_body_max_bytes` | 1048576 | bytes | §4.6 | 应用 API 请求体上限 | 子域路由树不在两个 1 MB 中间件分组里 ⇒ 必须自己实现 |
| `app_response_body_max_bytes` | 8388608 | bytes | §4.6 | 应用响应体上限 |  |
| `protocol_line_max_bytes` | 1048576 | bytes | §4.6 | 协议帧单行上限 | 超限 RUNTIME_OUTPUT_OVERRUN |
| `guest_budget` | 10 | seconds | §4.6 | guest 执行预算 | 进入宿主调用时暂停计时 |
| `host_ai_chat_budget` | 30 | seconds | §4.6 | ai.chat 宿主预算 |  |
| `request_wall_clock` | 60 | seconds | §4.6 | 请求端到端墙钟 | 含排队等待，到点即拒 |
| `app_queue_depth` | 32 | count | §4.6 | 每应用队列长度 | 超出 429 + Retry-After |
| `user_per_app_running` | 1 | count | §4.6 | 单用户同应用在跑 |  |
| `user_per_app_queued` | 4 | count | §4.6 | 单用户同应用排队 |  |
| `user_global_running` | 4 | count | §4.6 | 单用户跨应用全局在跑 |  |
| `app_concurrency` | 4 | count | §4.6 | 每应用并发 | 同一应用最多 N 个请求同时在跑（控制台对应 app_running）；读并发，写仍串行 |
| `retry_after_seconds` | 1 | seconds | §4.6 | Retry-After |  |
| `anon_global_rate_per_min` | 3000 | count | §4.6 | 全局匿名令牌桶 | 次/分 |
| `anon_global_burst` | 3000 | count | §4.6 | 全局匿名桶容量 |  |
| `anon_per_ip_rate_per_min` | 60 | count | §4.6 | 每 IP 匿名速率 | 次/分 |
| `anon_per_ip_burst` | 60 | count | §4.6 | 每 IP 匿名桶容量 |  |
| `ticket_ttl` | 60 | seconds | §4.7 | 一次性换票有效期 | code 单次、绑 (user, app) |
| `app_session_ttl` | 28800 | seconds | §4.7 | 应用子域会话 TTL | Cookie host-only + HttpOnly + Secure + SameSite=Strict |
| `ai_token_ttl` | 2700 | seconds | §4.7 | AI 令牌有效期 | 宿主内存持有、到期重铸、登出吊销 |
| `ai_token_renew_before` | 300 | seconds | §4.7 | AI 令牌续期提前量 |  |
| `ai_user_rate_per_min` | 60 | count | §4.7 | 用户级限流 | 平台既有，应用无独立额度 |
| `ai_in_flight_per_user` | 32 | count | §4.7 | 在途上限 | 平台既有 InFlightGuard |
| `session_max_form_bytes` | 8192 | bytes | §4.7 | 员工会话表单体上限 | 登录/换票两个表单只有几个短字段 |
| `session_max_username_bytes` | 128 | bytes | §4.7 | 账号字段上限 | 与客户端面登录同口径 |
| `session_max_password_bytes` | 1024 | bytes | §4.7 | 密码字段上限 | 与客户端面登录同口径 |
| `session_max_next_bytes` | 512 | bytes | §4.7 | 换票 next 长度上限 | §4.7「next 只接受同基域相对路径」的一部分 |
| `call_event_retention_days` | 7 | days | §4.9 | 调用事件保留 |  |
| `call_event_ring_size` | 4096 | count | §4.9 | 调用事件环形内存容量 |  |
| `call_event_flush_interval` | 2 | seconds | §4.9 | 调用事件批量落库间隔 |  |
| `call_event_batch_max` | 512 | count | §4.9 | 调用事件单批上限 |  |
| `diagnostics_default_limit` | 50 | count | §4.9 | 诊断默认条数 |  |
| `diagnostics_max_limit` | 200 | count | §4.9 | 诊断条数上限 |  |
| `stderr_tail_bytes` | 2048 | bytes | §4.9 | stderr 尾巴上限 | 诊断回给作者 |
| `retirement_snapshot_retention_days` | 90 | days | §5.3 | 退役快照保留 | 冻结/退役后保留快照的时长；到期由平台回收 |
| `log_max_line_bytes` | 4096 | bytes | §5.1 | 单条日志上限 |  |
| `log_max_per_request` | 100 | count | §5.1 | 每请求日志条数上限 | 超出丢弃并计数 |
