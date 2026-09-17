# WASM 应用平台规划（实施基线）

- 版本：**v2（2026-09-17 重写）**。v1 备份在 `temp/domain-scrub/plan-v1-backup.md`
- 状态：**设计定稿待 V0 验证**（有 12 项标记 `[V0]` 的假设必须在技术验证阶段实测确认）
- 配套：`docs/planning/2026-09-17-wasm-app-platform-review.md`（六路对抗审查报告，455 行，本文件的每条护栏都可溯源到其中某条发现）
- 原则：**每个能力都有上限，每个上限都有数值，每个数值都有测试**。设计目标是"即使员工故意写恶意应用、或其 AI 被诱导生成恶意代码，也无法越权、无法拖垮服务、无法烧钱"。

---

## 1. 一句话定义

员工（或代表员工的 AI）把一个小应用编译成**单个 `.wasm` 文件**（静态资源全部编入），上传到平台；平台在**无网络、无文件系统**的沙箱里运行它，只给它**一个本应用专属的 SQLite 数据库**（100 MB 硬限）和受控的宿主能力；其他员工登录后通过浏览器打开 `<slug>.<基域>` 使用。**应用代表当前登录用户调用平台 AI，费用记在该使用者账上。**

**员工只描述"想要什么"，AI 负责写代码、本机编译、上传、自修、发布。**

---

## 2. 需求基线（已拍板，不再讨论）

| # | 决策 | 日期 |
|---|---|---|
| **R1** | **每个应用一个独立数据库**（不是每用户一个） | 2026-09-17 |
| **R2** | **每个应用数据库 100 MB 硬上限**（**不可由用户配置**） | 2026-09-17 |
| **R3** | 访问标识用**子域名** `<slug>.<基域>`（通配 DNS + 通配证书） | 2026-09-17 |
| **R4** | 应用可用**当前登录用户**身份调 AI，费用扣该使用者 | 2026-09-17 |
| **R5** | **无人类管理后台**；所有操作走 API，由 AI 驱动 | 2026-09-17 |
| **R6** | **发布者即该应用的管理员**（仅管理平面） | 2026-09-17 |
| **R7** | **无合规限制**；"数据不得离开受控端点"不适用 | 2026-09-17 |
| **R8** | **静态资源编译进 WASM**（单文件交付） | 2026-09-17 |
| **R9** | 对外通讯默认全禁（应用无网络能力） | 2026-09-17 |
| **R10** | **接受窄语言面，维持 wazero**（Rust / Go / Zig） | 2026-09-17 |
| **R11** | **员工本机编译，平台只收 wasm**（不建平台侧构建服务） | 2026-09-17 |
| **R12** | **会话走一次性换票**（主站 302 带 code → 应用子域 host-only Cookie） | 2026-09-17 |
| **R13** | **SQL 层用 `SQLITE_LIMIT_*` 编译期拦截**，超时仅兜底 | 2026-09-17 |
| **R14** | **每个点都要有护栏，防止被滥用** | 2026-09-17 |

---

## 3. 威胁模型

### 3.1 对手与动机

| 对手 | 能力 | 动机 |
|---|---|---|
| **恶意员工** | 可写任意 wasm、可发任意 HTTP 请求、持有自己的合法账号、可开多个浏览器会话 | 读别人数据、薅 AI 额度、探测平台、报复 |
| **被诱导的 AI** | 同上（代表员工操作），可能生成有漏洞或含后门的代码 | 无恶意但会犯系统性错误 |
| **粗心的作者** | 无恶意 | 写出死循环、全表扫、无限递归、把状态放全局变量 |
| **外部攻击者** | 无账号 | 通过应用子域探测平台、走私响应头、跨应用攻击 |

### 3.2 资产

平台凭据与令牌 · 平台数据库（用户/余额/审计/用量） · 各应用的数据 · AI 额度与上游成本 · 服务可用性 · 审计完整性

### 3.3 六条不可逾越的红线

> 任何设计取舍与此冲突时，以红线为准。

1. **应用读不到平台数据**（用户表、令牌、余额、审计、用量）
2. **应用读不到其他应用的数据**
3. **应用拿不到可用于调平台的凭证**（浏览器侧与沙箱内均不得出现）
4. **应用不能出站**（无网络能力，非策略拦截）
5. **应用不能读宿主文件系统**
6. **单个应用无法拖垮平台**（CPU/内存/磁盘/队列/AI 额度全部有界）

---

## 4. 护栏总表（**唯一真源**）

> 实现要求：所有数值集中在一个 `limits.go`（Go 侧）与一份机器可读的 `limits.json`（供 SKILL.md 与作者文档生成）。**禁止在别处硬编码任何上限数值**；构建期门禁校验"文档/技能/错误文案里的数字与代码一致"。

### 4.1 命名与标识

| 项 | 值 | 依据 |
|---|---|---|
| `app_id` 正则 | `^[a-z0-9]+(?:-[a-z0-9]+)*$`（**严格 kebab-case**） | `skillmanifest/manifest.go:243`（既有实现） |
| `app_id` 长度 | 2–64 | `manifest.go:60-61` |
| 版本号 | 严格 `^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`，且必须严格递增 | `manifest.go:248` + `publish.go:145-160` |
| 非首版 changelog | 必填（空即拒） | `publish.go:243` |
| `slug` | ASCII `[a-z0-9-]`，3–40，**独立列且全局唯一**（不可复用 `app_id`） | `apps` 的 PK 是 `(kind, app_id)`，非全局唯一 |
| slug 保留字 | `www api admin portal updates static cdn mail ns ns1 ns2 dns ftp vpn sso login auth` | 防子域冲突与钓鱼 |

### 4.2 上传与包

| 项 | 值 | 说明 |
|---|---|---|
| `.wasm` 体积上限 | **32 MiB** | 窄语言面下足够 |
| 上传请求体上限 | **48 MiB** | 必须**加入 `largeBodyRoutes` 白名单**（`router.go:101-108`），否则被 1 MB 中间件拦成无指向性的 400 |
| 导入面白名单 | **仅 `wasi_snapshot_preview1`**，且函数名逐个枚举 | 实测 Go 只用 7 个、Zig 只用 3 个；`env.*` / `js.*` 一律拒 |
| 编译超时 | **60 s** | 实测：2.63 MB 模块首次编译 **967 ms**，按体积外推 32 MiB 可达 10 s+ ⇒ 10 s 会误杀 |
| **上传即预编译** | 上传接受后**后台异步编译并写入缓存**；预编译成功才允许发布 | **首次请求不等编译**；预编译失败 = 发布失败（错误码 + hints 回给 AI） |
| 预编译失败重试 | 最多 2 次，退避 5 s / 20 s | 防瞬时资源争抢 |
| 上传期静态校验 | 导入面 + 导出面（`_start`/`memory`）+ 结构 + 体积 | 恶意包在编译期就拒，不进运行期 |

### 4.3 WASM 运行时（全部为**必须显式配置**项）

> 警告：以下多数是"不设置就是危险的默认值"。已实测的默认值陷阱标 ⚠️。

| 项 | 配置 | 依据 |
|---|---|---|
| 上下文取消 | ⚠️ **必须** `WithCloseOnContextDone(true)` | 实测：不开则 context 超时**完全不生效**，死循环永久占住 goroutine |
| 随机源 | ⚠️ **必须** `WithRandSource(rand.Reader)` | 源码 `internal/sys/sys.go:151-152`：默认 `NewFakeRandSource()` ⇒ **全零** |
| 墙钟 | ⚠️ **必须** `WithSysWalltime()` | `config.go:582`：默认**不是** `time.Now` |
| 单调时钟 | ⚠️ **必须** `WithSysNanotime()` | 同上 |
| 睡眠 | ⚠️ **必须** `WithNanosleep(真实实现)` | 默认 fake |
| 文件系统 | ⚠️ **零 preopen**（不调任何 `WithDirMount`/`WithFSMount`） | 实测：有 preopen ⇒ 挂载点下全部可读 |
| 参数 | **不传 args**（`WithArgs()` 空） | 实测默认安全，但需显式声明不传 |
| 环境变量 | **不传任何 env**（`WithEnv()` 空） | 同上；传 env = 把部署环境交进沙箱 |
| stdin | 宿主构造的**请求帧**（管道，宿主可控） | 见 §6 帧协议 |
| stdout/stderr | 宿主捕获到内存缓冲，**绝不落宿主 stdout** | 实测默认 `io.Discard`，但要显式接管 |
| 实例内存 | `WithMemoryLimitPages(256)` = **16 MiB/实例** | `[V0]` 需实测 Go 2.6 MB 模块的基线占用 |
| 实例策略 | **只缓存编译结果，每请求新实例**；**禁止实例复用** | 复用 ⇒ 跨用户状态残留，且不报错 |
| 编译缓存 | LRU，**128 条 / 512 MiB**；键 `release_id + checksum`；**上传预编译即写入** | wazero 的 `NewCompilationCache()` **无容量机制**（`cache.go:40-42`）；淘汰后运行期需重编译（60 s 预算内） |
| 驱动与连接 | **一应用一 driver 实例 + 一应用一连接，不复用** | `vtab` 包级注册是**进程全局**、"reach every Driver" |

### 4.4 宿主能力调用

| 项 | 值 | 说明 |
|---|---|---|
| 硬规则 | **宿主函数不得阻塞超过其预算**；每个宿主函数**必须**使用传入的 `ctx` | 实测：宿主阻塞时 guest 超时**完全失效**（预算 300 ms 实际跑满 3 s，且返回 `err=nil`） |
| 宿主调用返回后 | **强制复检** `ctx` 与 module 状态，已取消即按超时处理 | 否则"被杀"会返回成功（静默失败） |
| `ai.chat` | `http.NewRequestWithContext`；**单独预算 30 s**；**不在 guest 计时内** | 见 §7.3 计时规则 |
| 宿主函数参数 | **任何宿主函数不得接受文件路径**；`db.*` 只用逻辑标识 | 路径由宿主按 `app_id` 查表推导 |
| 事务内宿主调用 | **禁止**（`db.tx` 内调 `ai.chat`/`log` 直接报错） | 防事务长期持锁 + 占满执行槽 |
| 兜底 | 每个宿主调用额外包 `recover()` 边界 | wazero 会 recover 宿主 panic，但那是实现细节不是契约 |

### 4.5 SQL / 数据层

| 项 | 值 | 依据 |
|---|---|---|
| 数据库粒度 | **每应用一个 `.db`**（`<data_root>/apps/<app_id>/app.db`） | R1 |
| **数据库体积上限** | **100 MB**（`PRAGMA max_page_count = 25600`，页 4096 B） | R2；**写满即 SQLite 返回 `SQLITE_FULL`**，是引擎级硬限而非事后统计 |
| 单语句 | **强制单语句**：分号须位于字符串字面量之外；其后除空白/注释外有内容即拒 | 实测：多语句让 `db.query`/`db.exec` 区分形同虚设（`INSERT …; SELECT …` 回读到别人的行） |
| schema 白名单 | **仅 `main`**（任何 `ATTACH` 一律拒） | 实测：一条 `ATTACH` 即可跨应用读 |
| 语句种类白名单 | 仅 `SELECT` / `INSERT` / `UPDATE` / `DELETE`；**禁全部 DDL**、禁 `ATTACH`/`DETACH`/`VACUUM`/`PRAGMA`/`WITH RECURSIVE` | `CREATE TABLE` 可建无 owner 列的表绕过隔离；`DROP TABLE` 可毁数据；**`VACUUM INTO` 是独立于 ATTACH 的任意文件写原语**（实测可写 `/tmp`） |
| 连接级只读分层 | `SELECT` 走 `_pragma=query_only(1)` 连接；写走读写连接且每次调用前重置连接状态 | 防连接级状态粘连（ATTACH/PRAGMA 残留在池化连接上） |
| `SQLITE_LIMIT_SQL_LENGTH` | 64 KiB | 单条 SQL 文本上限 |
| `SQLITE_LIMIT_LENGTH` | 1 MiB | 单值/单行字节上限 |
| `SQLITE_LIMIT_COLUMN` | 128 | 结果集列数 |
| `SQLITE_LIMIT_EXPR_DEPTH` | 32 | 表达式/子查询/视图嵌套深度 |
| `SQLITE_LIMIT_PARSER_DEPTH` | 32 | 解析器栈深 |
| `SQLITE_LIMIT_COMPOUND_SELECT` | 8 | 复合 SELECT 项数 |
| `SQLITE_LIMIT_VDBE_OP` | 50 000 | 单语句字节码指令数（**挡病态查询的主力**） |
| `SQLITE_LIMIT_FUNCTION_ARG` | 16 | |
| `SQLITE_LIMIT_ATTACHED` | **0** | 引擎层否决 ATTACH |
| `SQLITE_LIMIT_LIKE_PATTERN_LENGTH` | 512 | 防 LIKE 模式爆炸 |
| `SQLITE_LIMIT_VARIABLE_NUMBER` | 128 | |
| `SQLITE_LIMIT_TRIGGER_DEPTH` | 8 | |
| `SQLITE_LIMIT_WORKER_THREADS` | **0** | 禁辅助线程 |
| 返回行数上限 | 10 000 行 | 超出即截断并报错 |
| 返回字节上限 | 8 MiB | 同上 |
| 单语句时长 | 5 s（**独立于 guest 超时**） | 见 §11 风险登记中的"中断缺口" |
| `PRAGMA` 白名单 | **仅宿主内部可用**；应用提交的 PRAGMA 一律拒 | 应用可 `PRAGMA writable_schema=ON`、`PRAGMA database_list` 探测 |

### 4.6 请求与队列

| 项 | 值 | 说明 |
|---|---|---|
| 请求体上限 | 1 MiB | 应用 API（非上传路径） |
| 响应体上限 | 8 MiB | |
| 协议帧单行上限 | 1 MiB | 超限即 `RUNTIME_OUTPUT_OVERRUN` 并杀 |
| guest 执行预算 | **10 s**（进入宿主调用时**暂停计时**） | 防 `ai.chat` 阻塞被误判为超时 |
| 宿主调用预算 | 30 s（`ai.chat`） | |
| 请求端到端墙钟 | **60 s**（含排队等待） | 到点即拒 |
| 每应用队列长度 | **32** | 超出返回 429 + `Retry-After` |
| 每用户占槽 | 同时最多 1 个在跑，队列中最多 4 个 | 防单用户占满该应用队列 |
| 每应用并发 | **恒为 1**（串行执行，Durable Objects 式） | 与"每应用一连接"一致 |
| 全局并发实例 | 32 | 防跨应用耗尽 |
| 响应缓存 | 仅缓存 `assets.read` 的**静态资源**；键 `app_id + version + path`；**动态响应一律不缓存** | 原设计键缺 `app_id` ⇒ 跨用户泄漏 |

### 4.7 账号、AI 与额度

| 项 | 值 | 说明 |
|---|---|---|
| 应用子域会话 | **一次性换票**（code 单次、60 s 有效、绑定 `(user, app)`）；应用子域 Cookie **host-only + HttpOnly + Secure + SameSite=Lax**，TTL 8 h | R12；应用 JS 读不到凭证 |
| AI 令牌 | 宿主为 `(user, app)` 铸一张 45 min 令牌，**按 `(user, app)` UPSERT 复用同一行**；`api_tokens` 加 `app_id` + `session_id` | 防令牌暴涨 + 支持登出批量吊销 |
| 令牌铸造审计 | **每次铸造与吊销各记一条审计** | 原设计零留痕 |
| AI 调用预算 | 每应用：500 次/天、¥50/天；每用户：100 次/天（可配） | 防一个应用烧掉部门预算 |
| AI 并发 | 复用 `InFlightGuard`（每用户 32） | 应用侧不额外放宽 |
| **余额预留** | 应用发起的调用**必须先预留预估额度**再转发 | 既有系统缺陷：`handler.go:1391` 只判余额 >0，结算在上游调用**之后** ⇒ 余额 1 元可并发打满 32 个高价请求，上游成本平台自负 |
| 模型准入 | 服务端按管理员配置 + 用户权限裁决 | |
| 提示隔离 | `ai.chat` 的 `messages` 由应用自建，**平台不注入任何系统提示**；返回体不透出内部错误/上游原文 | 防请求信封里的 `dept/username` 被喂给上游 |

### 4.8 响应与浏览器侧

| 项 | 值 | 说明 |
|---|---|---|
| 响应头白名单 | `content-type`（限定集合）、`cache-control`、`content-disposition`（仅 `inline`）、`x-content-type-options` | 原设计**无任何响应头约束** |
| CR/LF | 头值中出现即拒 | 防响应拆分 |
| 应用子域 Cookie 写入 | 宿主独占；**应用返回的 `Set-Cookie` 一律剥离** | |
| CSP | `default-src 'none'` + 仅放行自身源的 `script`/`style`/`img`；`frame-ancestors 'none'` | 应用内容独立源，禁外链 |
| `X-Content-Type-Options` | `nosniff` | |
| 主机名反查 | `Host` → `apps.slug`，查不到**直接 404**，绝不回落主站内容 | 防钓鱼 |
| 引擎隔离 | 应用子域**独立子路由树**；未匹配 `/api/*` 一律 404 | 主站有无前缀路由（`/models`、`/chat/completions`）与免认证的 `/updates/client/*`，共用引擎会外溢 |

### 4.9 审计与可观测

| 项 | 记录内容 | 说明 |
|---|---|---|
| 审计（高频不可） | 上传 / 校验失败 / 上下架 / 删除 / 铸造与吊销令牌 / 配额超限 | 审计写路径是**单 worker 串行**（入队等 5 s、等结果 15 s，同步阻塞）⇒ **不得每次调用都记** |
| 调用事件（必记） | `app_id / user_id / outcome / reason_code / cpu_ms / peak_memory_bytes / host_call_count / host_call_ms / queue_wait_ms / response_bytes / db_rows / db_bytes` | 用于回答"这个应用刚才为什么被杀" |
| 诊断 API | 按应用聚合最近 N 条失败与被杀记录，**结构化错误码 + hints**（第一消费者是 AI） | 见 §7 |

---

## 5. 受控能力面（**核心设计原则：不给自由度，只给铺好的路**）

> 前提：**不能假设用户或 AI 会正确使用平台。** 目标不是"设上限然后拒绝滥用"，而是**让越界在结构上表达不出来**（pit of success）。应用只有少数几个受控原语，且每个原语的能力面是**封闭枚举**的。

### 5.1 应用能用的全部原语（封闭清单）

| 原语 | 用途 | 固定约束 |
|---|---|---|
| `db.define(table, columns[])` | **声明**一张表（平台唯一的建表入口） | 表名/列名 `^[a-z][a-z0-9_]{0,30}$`；列类型枚举见下；列数 ≤ 16；每应用表数 ≤ 16；禁止指定主键/外键/索引/触发器（平台统一处理） |
| `db.query(sql, args)` | 单条 SELECT | 单语句、参数化、`SQLITE_LIMIT_*`、返回 ≤ 5 000 行 / 8 MiB |
| `db.exec(sql, args)` | 单条写语句 | 仅 INSERT/UPDATE/DELETE；禁 DDL；禁含保留列 |
| `db.tx(fn)` | 事务 | 内**禁止**调用任何其他宿主函数；硬超时 5 s 强制回滚 |
| `ai.chat(messages, model?)` | 调 AI | 模型由服务端裁决；预算 30 s；平台不注入系统提示 |
| `log(level, msg)` | 写日志 | 单条 ≤ 4 KiB；每请求 ≤ 100 条；超出丢弃并计数 |
| `assets.read(path)` | 读包内资源 | 资源已编入 wasm；无文件系统语义 |

**列类型枚举（封闭）**：`text` / `int` / `real` / `bool` / `datetime`。
**没有任何其他能力**——无文件、无网络、无线程、无子进程、无环境变量、无时钟配置、无随机源选择、无 PRAGMA、无 ATTACH、无 DDL、无扩展加载。

### 5.2 平台保留列（应用不可见、不可写、不可指定）

| 列 | 说明 |
|---|---|
| `owner_user_id` | `data_scope=per_user` 时由宿主在 `db.define` 时**自动追加**，并自动创建按用户视图 `v_<table>` + `INSTEAD OF` 触发器注入该列 |
| `_row_id` | 平台主键（应用不指定主键，避免自增/冲突语义被滥用） |

**应用侧的可见世界只有视图**：连接 `search_path` 指向视图 ⇒ 应用写 `SELECT * FROM items` 得到的是**它自己的行**，且**看不到 `owner_user_id` 这一列**（也无法在 SQL 里提到它——提到即拒）。

### 5.3 容量与配额清单（全部平台固定，**用户不可配置**）

| 项 | 值 | 归属 |
|---|---|---|
| 数据库体积 | **100 MB / 应用** | R2 |
| 表数 | 16 / 应用 | 平台固定 |
| 列数 | 16 / 表 | 平台固定 |
| 单值长度 | 1 MiB | `SQLITE_LIMIT_LENGTH` |
| 返回行数 / 字节 | 5 000 行 / 8 MiB | 平台固定 |
| 保留版本数 | 最近 3 版（更早的软删、归档置空） | 平台固定 |
| 应用数 | 不限（但受"每应用 ≤100 MB"与磁盘容量约束） | 平台固定 |
| AI 配额 | 500 次/天、¥50/天（应用级）；100 次/天（用户级） | 组织可调，**应用侧不可配** |
| 日志保留 | 7 天 | 平台固定 |

**应用需要更多容量时的唯一途径**：联系平台管理员（不是应用作者可以自己调的旋钮）。

### 5.4 把"会用错"消灭在流程里

| 用户/AI 容易做错的事 | 平台如何让它不可能发生 |
|---|---|
| 忘记建表 / 表结构不一致 | 表结构**声明在应用元数据里**；发布时平台比对并**自动迁移**（加列/删列/建视图），作者不写迁移脚本 |
| 忘记给 owner 列 | 平台自动追加；应用即使想提也提不到 |
| 自己写用户过滤 | 平台已强制 ⇒ skill 明写"不要自己过滤"，且 SQL 含保留列即拒 |
| 用全局变量存状态 | 实例每请求新建 ⇒ 用了也不生效；skill 明写无状态 |
| stdout 打日志毁协议 | 非 `RS` 开头的内容一律当日志捕获，不算协议帧 |
| 用错编译目标 | 上传期导入面白名单直接拒 + hints 指明 `wasm32-wasip1` |
| 版本号写错 / 忘写 changelog | 预检接口明确拒 + 结构化 hints |
| 写出慢查询 | `SQLITE_LIMIT_*` 编译期拒 + 请求路径超时放弃 + 诊断事件 |
| 并发/队列参数想调优 | **没有这类参数**——串行执行、队列 32、占槽 4 全部平台固定 |

### 5.5 自动化约束（防止"护栏写在文档里但代码里没有"）

| 门禁 | 内容 |
|---|---|
| **能力清单一致性** | `capabilities.go` 里注册的宿主函数集合，必须与 §5.1 表格逐项一致；多一个即测试红 |
| **列类型枚举一致性** | `db.define` 接受的类型集合与文档表格一致 |
| **无路径参数** | 枚举所有宿主函数签名，断言**没有任何一个**参数语义是文件路径 |
| **数值单一真源** | `limits.go` 是唯一数值来源；SKILL.md / 作者文档 / 错误文案**从它生成**，构建期比对 |
| **变异验证** | 任一限制改回"无上限"，对应 §9 用例必须变红 |


---

## 6. 系统架构

### 6.1 请求链路

```
员工浏览器
  │  ① 访问 https://<slug>.<基域>/
  │     无有效应用子域 Cookie ⇒ 302 到主站换票
  ▼
主站 https://<基域>/app-ticket?app=<slug>&next=/
  │  ② 主站验员工会话 → 生成一次性 code（60s，绑 user+app）
  │  ③ 302 回 https://<slug>.<基域>/?ticket=<code>
  ▼
应用子域
  │  ④ 宿主用 code 换 host-only + HttpOnly Cookie，再 302 回干净 URL
  ▼
┌─────────────────────────────────────────────────────────┐
│ 平台主服务（Go 单二进制，CGO_ENABLED=0）                  │
│  会话与票务 · 应用路由 · 静态资源缓存 · 宿主能力           │
│  护栏（limits.go）· 计量 · 审计 · 队列                    │
└──────┬───────────────────────────────┬──────────────────┘
       │ stdin/stdout 帧协议            │ 内部 /v1（BearerAuth + InFlightGuard）
       │ （每请求新实例）                │ + 余额预留
       ▼                               ▼
┌────────────────────┐        ┌────────────────────┐
│ WASM 实例（沙箱）    │        │ 平台 LLM 网关       │
│ 无网络 · 无文件系统  │        │ → 上游模型          │
│ 无 args/env · 假零   │        └────────────────────┘
│ 随机已换真源         │
└─────────┬──────────┘
          │ 宿主 SQL 闸门：单语句 + schema 白名单 + 语句种类 + SQLITE_LIMIT_*
          ▼
/data/apps/<app_id>/app.db      ← 每应用一个，100 MB 硬限
（平台自身仍在 PostgreSQL，应用进程对其无任何可达路径）
```

### 6.2 编译与发布链路（R11：员工本机编译）

```
员工 → AI（客户端内）
  ① 员工描述需求
  ② AI 生成代码 + 在本机编译（Rust/Go/Zig 工具链，版本矩阵见 §9.2）
  ③ AI 调 POST …/wasm/validate（**只校验不落版本号**）
       ├─ 通过 → ④
       └─ 失败 → 结构化 {code, details, hints} → AI 自修 → 回到 ②
  ④ AI 调 POST …/wasm/publish（构造等价 Manifest：version/title/changelog）
  ⑤ 按组织开关：直接生效 或 进待审队列（待审期间线上仍旧版本）
```

### 6.3 数据隔离（R1：每应用一个数据库）

**诚实说明**：每应用一个数据库意味着**同一应用内所有用户共享一个库**。因此"应用内按用户隔离"不能靠文件边界，必须由宿主实施：

| 层 | 机制 |
|---|---|
| **应用之间** | 文件边界 + `ATTACH` 被 `SQLITE_LIMIT_ATTACHED=0` 与语句白名单双重否决 + 数据目录 `0700` + 文件名由宿主推导 |
| **用户之间（`data_scope=per_user`）** | 宿主生成的**按用户视图**（`v_<table>` 带 `WHERE owner_user_id = ?`）+ `INSTEAD OF` 触发器注入 owner 列 + 连接级 `search_path` 指向视图；应用**看不到也写不到** owner 列。`[V0]` **必须实测**：视图可更新性、触发器注入、`search_path` 优先级 |
| **用户之间（`data_scope=shared`）** | 不设视图，应用内全员共享（部门台账类）；由发布者在元数据里声明，**发布后不可改** |

> **红线 2/3 的落地判据**：`per_user` 下，应用提交 `SELECT * FROM items` 只能看到自己的行；提交 `UPDATE items SET owner_user_id=…` 必须在闸门层被拒（语句含 owner 列即拒）。这两条进 §9 验证矩阵。

---

## 7. 应用契约（ABI）

### 7.1 请求帧（宿主 → 应用，写入 stdin）

```json
{"abi":"picoaide-app/2","app_id":"expense-note","version":"1.0.0",
 "user":{"id":"u001","username":"zhang","display_name":"张伟","dept":"研发"},
 "method":"POST","path":"/api/save","query":{},
 "headers":{"content-type":"application/json"},
 "body":"{\"amount\":100}"}
```

### 7.2 协议帧（应用 → 宿主）

**改用显式定界，不用"最后一行"**（原设计脆弱：语言运行时打一行 debug 就毁掉解析）。

- 应用 → 宿主：`RS(0x1e)` + 一行 JSON-RPC 2.0 请求，或 `RS` + 最终响应信封
- 宿主 → 应用：`RS` + 一行 JSON-RPC 响应
- **非 `RS` 起始的输出一律视为日志**，被宿主捕获（不污染 ABI），并计入"stdout 净化"统计回给作者

宿主调用方法：`db.query` / `db.exec` / `db.tx` / `ai.chat` / `log` / `assets.read`

### 7.3 计时规则（关键）

```
请求到达 → 开始"端到端墙钟"（60 s，含排队）
  进入 guest 执行 → 开始"guest 预算"（10 s）
    调宿主函数 → 【暂停 guest 计时】+ 开始"宿主预算"（ai.chat 30 s）
    宿主返回   → 恢复 guest 计时 + 强制复检 ctx/module 状态
  离开 guest → 停止
```

**为什么必须分开**：原设计用单一 CPU 超时，会让任何使用 `ai.chat` 的应用被误杀。

### 7.4 失败语义（**绝不把失败报成成功**）

| 码 | 触发 | HTTP |
|---|---|---|
| `RUNTIME_TIMEOUT` | guest 预算耗尽 | 504 |
| `RUNTIME_TRAP` | `unreachable`/非法访问 | 500 |
| `RUNTIME_MEMORY` | 内存页超限 | 500 |
| `RUNTIME_OUTPUT_OVERRUN` | 单行/总输出超限 | 500 |
| `RUNTIME_NO_RESPONSE` | 无响应帧即退出 | 502 |
| `HOST_CALL_OVER_BUDGET` | 宿主调用超预算 | 504 |
| `MODULE_KILLED` | 已取消/module 已关闭 | 504 |
| `DB_LIMIT` | 100 MB 满 / 行数超 / 字节超 | 507 |
| `DB_DENIED` | 语句白名单/SQLITE_LIMIT 拒绝 | 403 |
| `APP_QUEUE_FULL` | 队列满 | 429 + `Retry-After` |

**硬断言**：`Call` 返回 `err=nil` 但 module 已被关闭或响应帧缺失时，**必须映射为 `MODULE_KILLED`/`RUNTIME_NO_RESPONSE`，绝不返回 200**。（实测：超时后宿主函数正常返回时 `Call` 返回 `err=nil`。）

---

## 8. AI 操作面（无人类后台）

| 能力 | 端点（示意） | 要点 |
|---|---|---|
| 预检 | `POST /api/client/v2/apps/wasm/validate` | **只校验不落版本号**（R11 后升为 P0） |
| 发布 | `POST /api/client/v2/apps/wasm/publish` | 需构造等价 `Manifest`（version/title/changelog）；复用既有 `Publish` 检查点 **+ 新增 kind 白名单** |
| 上下架 | `POST …/wasm/:app_id/publish\|unpublish` | 发布者自主，不走审批 |
| 删除 | `DELETE …/wasm/:app_id` | 标记 + N 天后真删 |
| 诊断 | `GET …/wasm/:app_id/diagnostics` | 最近失败与被杀记录，结构化 |
| 自省 | `GET …/wasm/:app_id/schema` | 表结构与占用（**仅发布者** + 审计） |

**错误响应格式（第一消费者是 AI）**：

```json
{"error":{"code":"IMPORT_NOT_ALLOWED",
 "message":"模块导入了不允许的命名空间",
 "details":{"imports":["env.abort"],"allowed":["wasi_snapshot_preview1"]},
 "hints":["必须编译到 wasm32-wasip1 目标（不是 wasm32-unknown-unknown）",
          "Rust: rustup target add wasm32-wasip1 && cargo build --target wasm32-wasip1",
          "若用了 wasm-bindgen 请去掉——那是浏览器目标"]}}
```

**身份语义**：AI 只是编辑器，`publisher` 记**发起操作的员工**；**禁止 AI 持共享高权限账号代发**。

---

## 9. 语言支持与作者侧

### 9.1 语言矩阵（R10：窄语言面）

| 档 | 语言 | 判据 |
|---|---|---|
| **Tier 1（官方支持，进 CI）** | **Rust**（`wasm32-wasip1`）、**Go**（`GOOS=wasip1`）、**Zig**（`wasm32-wasi`） | 实测/官方文档确认可产出 WASI p1 **core module**，导入面干净 |
| 待验证 | TinyGo、C/C++（wasi-sdk） | 需单独验证 ABI（TinyGo 的 stdout 缓冲差异） |
| **不支持（文档明确写"不支持"）** | Python / Java / Kotlin / C# / JS-TS / Swift / AssemblyScript | 工具链只出**组件模型**（wazero 不支持），或导入面含 `env.*` 会被白名单拒 |

**硬判据**：能产出 `wasm32-wasip1` core module 且导入面仅 `wasi_snapshot_preview1`。逐语言用同一探针在 V0 验证并进 CI。

**风险要认账**：Rust 官方文档称 `wasm32-wasip1` *"is intended for historical compatibility"*，WASIp1 syscalls *"no longer receiving any maintenance"* ⇒ **语言支持面是时间递减的**。

### 9.2 编译器版本矩阵（R11 的必然产物）

由于平台不做构建，**"本地过 ≠ 线上过"**必须靠契约管理：随 skill 发布受支持的编译器版本区间（如 `rustc 1.7x–1.8x`、`go 1.22+`、`zig 0.1x`），版本不匹配时**预检接口直接拒**并给出 `hints`。

### 9.3 SKILL.md（AI 的操作手册）

- 位置：随客户端分发的内置技能（`skills/picoaide-app-builder/`）
- 结构：小 `SKILL.md`（何时用 + 黄金路径 + 硬约束）+ `references/`（ABI、宿主函数、`limits`、发布、诊断、语言）+ `examples/`（Tier1 各一份，**进 CI 真编译**）
- **单一真源**：约束表与 ABI 参考**从 `limits.go` / 契约定义生成**，构建期门禁校验；skill 带 `x-abi-version`
- **ABI 锁定前不发正式 skill**（否则 AI 按旧 skill 生成一堆要重写的代码）
- ⚠️ skill 是**客户可见交付物**：不得出现真实客户域名（用占位符）

### 9.4 作者必须知道的六条（写进 skill 首屏）

1. 编译目标是 **`wasm32-wasip1`**（不是 `wasm32-unknown-unknown`）
2. **无状态**：不要用全局变量存用户/会话状态——实例每请求新建
3. **`data_scope=per_user` 时不要自己写 owner 过滤**——平台已强制，重复过滤会导致查不到数据
4. **stdout 只用于协议帧**（`RS` + 一行 JSON）；日志请走 `log` 宿主函数
5. **`ai.chat` 是阻塞的**（非流式），UI 要显示等待态
6. **不能联网、不能读文件、不能开线程**；外部资源（CDN/字体/外链图片）必须内联

---

## 10. 验证矩阵（每条护栏一个用例）

> 全部为"期望被拒绝/被限制"。**变异验证**：把某条限制改回"无上限"，对应用例必须变红。

### 10.1 越权（红线 1/2/3）

```
① SELECT * FROM public.users                    → 不可达（平台表在 PG，应用进程无路径）
② ATTACH DATABASE '<别的应用>/app.db' AS b       → 拒（语句白名单 + SQLITE_LIMIT_ATTACHED=0）[V0]
③ SELECT v FROM b.secrets（跨应用读）             → 拒（同上）
④ INSERT …; SELECT …（多语句）                   → 拒（单语句闸门）[V0]
⑤ CREATE TABLE leak(x)                          → 拒（禁 DDL）[V0]
⑥ DROP TABLE items                              → 拒（禁 DDL）[V0]
⑦ VACUUM INTO '/tmp/x'                          → 拒（禁 VACUUM）[V0]
⑧ PRAGMA writable_schema=ON                     → 拒（PRAGMA 一律拒）[V0]
⑨ CREATE VIEW v AS SELECT * FROM items          → 拒（禁 DDL）[V0]
⑩ per_user：以 A 身份 SELECT → 只见 A 的行        → 成立（视图 + search_path）[V0]
⑪ per_user：UPDATE items SET owner_user_id=…    → 拒（含 owner 列即拒）[V0]
⑫ 连接复用后 database_list 只剩 main            → 成立（每应用一连接 + 每次调用重置）[V0]
```

### 10.2 沙箱逃逸（红线 4/5）

```
⑬ os.Open("/etc/passwd") 等全部文件操作          → DENIED（零 preopen）✅ 已实测
⑭ ReadDir("/")                                  → DENIED ✅ 已实测
⑮ 任意出站（socket/DNS）                          → 不可达（preview1 无 sock_open + host 未配置监听）✅ 已实测
⑯ 导入面含 env.* / js.*                          → 上传期拒（导入白名单）[V0]
⑰ random_get 两次结果不同且非全零                  → 成立（WithRandSource(rand.Reader)）[V0]
⑱ clock_time_get 返回真实时间                     → 成立（WithSysWalltime）[V0]
⑲ args_get / environ_get 读到宿主内容             → 空（不传 args/env）[V0]
```

### 10.3 资源耗尽（红线 6）

```
⑳ 死循环                                        → 10s 后 RUNTIME_TIMEOUT ✅ 已实测（超时机制有效）
㉑ 无限递归（栈耗尽）                              → stack overflow error，宿主存活 ✅ 已实测
㉒ 宿主函数阻塞 3s（预算 300ms）                   → 【已知缺口】预算失效且 err=nil
                                                   ⇒ 靠"宿主函数必须用 ctx + 返回后复检"兜底 [V0]
㉓ 内存 grow 超 16 MiB                            → RUNTIME_MEMORY [V0]
㉔ 单行输出 1 GiB                                 → RUNTIME_OUTPUT_OVERRUN，宿主不 OOM [V0]
㉕ 响应体超 8 MiB                                 → 拒 [V0]
㉖ 数据库写满 100 MB                              → SQLITE_FULL → DB_LIMIT（507）[V0]
㉗ 无界递归 CTE                                   → SQLITE_LIMIT_VDBE_OP/EXPR_DEPTH 拒 [V0]
㉘ 同应用 100 并发请求                             → 队列 32，其余 429 [V0]
㉙ 单用户占满队列                                  → 每用户上限 4，超出 429 [V0]
㉚ 编译缓存超 128 条                               → LRU 淘汰 [V0]
㉛ 应用调 ai.chat 死循环刷额度                      → 应用/用户日限 + 余额预留拦截 [V0]
```

### 10.4 会话与凭据

```
㉜ 未登录访问应用子域                              → 302 换票 → 主站登录
㉝ 重放 ticket（第二次使用）                        → 拒（一次性）[V0]
㉞ 跨应用使用 ticket（app=A 的票换 app=B）          → 拒（绑定 user+app）[V0]
㉟ 应用 JS 读 document.cookie                     → 空（HttpOnly）[V0]
㊱ 恶意应用代用户调 /api/client/v2/*               → 无凭证可用（host-only + HttpOnly）[V0]
㊲ 员工登出后旧应用令牌                             → 立即失效（按 session_id 批量吊销）[V0]
㊳ 应用返回 Set-Cookie / 任意响应头                 → 剥离 / 白名单拒 [V0]
㊴ Host 反查到不存在的 slug                        → 404（绝不回落主站）[V0]
㊵ <slug>.<基域>/updates/client/… 或 /models       → 404（独立路由树）[V0]
```

### 10.5 发布链路

```
㊶ app_id 含大写/下划线/连续横线                     → 400 INVALID_APP_ID
㊷ 版本号 1.0（非 x.y.z）                           → 拒
㊸ 非首版缺 changelog                              → 拒（422）
㊹ 上传 40 MiB wasm                                → 拒（32 MiB 上限）且错误可读
㊺ 上传 5 MiB wasm（超过 1 MB 中间件）               → 成功（已进 largeBodyRoutes 白名单）[V0]
㊻ 员工 B 更新员工 A 的应用                          → 拒（owner 检查）
㊼ AI 持共享账号代发                                → 架构禁止（身份必须记发起员工）
㊽ 更新审批开关缺配置                                → **默认需审批**（fail-closed，不得 fail-open）
```

### 10.6 受控能力面（§5）

```
㊾ 注册一个不在 §5.1 清单里的宿主函数               → 能力清单一致性测试红
㊿ db.define 用非法表名/列名（大写、连字符、超长）        → 拒（命名规范）
①  db.define 第 17 张表 / 第 17 列                     → 拒（表数/列数上限）
②  db.define 指定列类型不在枚举内（如 blob）            → 拒
③  db.define 试图指定主键/索引/触发器                   → 拒（平台保留）
④  SQL 中提到 owner_user_id 或 _row_id                → 拒（保留列）
⑤  应用元数据声明表后发布，平台自动建表并建视图            → 成立；应用 SQL 只见自己的行 [V0]
⑥  改应用元数据的表结构后发布，平台自动迁移                → 成立（加列/删列）[V0]
⑦  应用试图调用不存在的宿主函数（如 db.attach）           → 拒（未注册即不存在）
```

---

## 11. 分期与验收

| 阶段 | 内容 | 估算 | 验收 |
|---|---|---|---|
| **V0 技术验证** | 钉死 12 项 `[V0]` 假设 | 5–8 人日 | §10 中所有 `[V0]` 用例跑通并有实测记录 |
| **V1 最小闭环** | 运行时可跑 + 会话 + 数据层 + 上传/预检/发布 + AI 调用 + 基础护栏 | 40–55 人日 | AI 能独立完成"建应用→预检→发布"；员工能打开使用；§10 全部用例通过 |
| **V2 可用性** | 队列与配额完善、诊断与自省、独立进程、备份导出 | 25–35 人日 | 可给真实部门试点 |
| **V3 增强** | 组织级策略、应用目录、`ai.embed`、FTS5 | 15–25 人日 | 规模化推广 |

**V0 必须回答的 12 项**（不通过就改设计，不是改测试）：

1. `per_user` 的视图 + `INSTEAD OF` 触发器 + `search_path` 是否真能隔离（**核心**）
2. `SQLITE_LIMIT_*` 是否真能挡住递归 CTE 与深嵌套
3. 100 MB `max_page_count` 触发时错误码是否为 `SQLITE_FULL`
4. 单语句闸门的词法器能否正确处理字符串字面量/注释里的分号
5. `WithRandSource` / `WithSysWalltime` 注入后 guest 行为符合预期
6. 16 MiB 内存页是否够 Go/Rust/Zig 三类模块的基线
7. 宿主阻塞期间超时失效的兜底方案（宿主函数强制 ctx + 返回后复检）是否足够
8. 每请求新实例的实例化成本（Go 2.6 MB 模块）
9. 编译缓存 LRU 的实际淘汰行为
10. `largeBodyRoutes` 加白名单后 32 MiB 上传是否成功
11. 一次性换票的 302 往返与 Cookie 落地
12. 独立进程运行时的必要性与形态（是否 V1 就要）
13. 上传预编译：后台编译写入缓存后发布，首请求是否真的不等编译
14. `db.define` 自动建表 + 自动建视图 + 自动迁移（加列/删列）是否可靠

---

## 12. 风险登记（认账项）

| 风险 | 影响 | 缓解 |
|---|---|---|
| **语言面时间递减** | 今天支持的 3 种语言可能变少 | 契约里写明；升级 wazero 时重审（preview2 有 `wasi:sockets`） |
| **本地过 ≠ 线上过** | AI 生成的包在平台被拒 | 编译器版本矩阵 + 预检接口（P0） |
| **SQL 查询中断缺口** | "合法但很慢"的查询占满执行槽 | 队列/占槽上限 + 端到端预算 + 未来的 progress handler fork |
| **每应用一库 = 应用内共享** | 无法用文件边界做用户隔离 | 视图 + 触发器方案（`[V0]` 验证）；`shared` 语义要求在元数据里显式声明 |
| **100 MB 是硬限** | 应用写满后写入失败 | 明确错误码 + 告警；发布者可见占用 |
| **审计单 worker 串行** | 高频审计会阻塞请求 | 只记关键动作，不记每次调用 |
| **无人类后台** | 发布者离职后应用无人能改 | 平台管理员接管（super_admin） |

---

## 13. 与现有系统的对接（已逐条核对代码）

| 复用项 | 现状 | 需要新增 |
|---|---|---|
| 应用与版本 | `apps`/`app_releases`（migration 0053） | **迁移：`kind` CHECK 加 `wasm_app`**、`apps.slug` + 唯一约束、`apps.data_scope`、`apps.schema_version` |
| 归属与审批 | `appstore.Publish`（owner 首占、锁定名、跨渠道同名、`PendingCap`） | **入口加 kind 白名单**；**审批开关必须在配置缺失时 fail-closed**；需构造等价 `Manifest` |
| 员工令牌 | `serverauth.IssueToken`/`VerifyToken`/`CreateToken(expiresAt)` | `api_tokens` 加 `app_id` + `session_id`；铸造/吊销审计 |
| AI 网关 | `/v1` + `BearerAuth` + `InFlightGuard` | **余额预留**（现状只判 >0）；`usage` 归因需 4 步改造（加列 + token 行入 context + `RecordUsageKind*` 加参数 + 日/月账维度决策） |
| 路由 | `internal/router` 集中声明 | 应用子域**独立路由树**；上传路由进 `largeBodyRoutes`；**补反向断言** |
| 反代与证书 | `Caddyfile.autocert`/`manual`（站点标签 = `{$DOMAIN}`） | **模板零改动**，只需 `.env` 写 `harness.example.com, *.harness.example.com`；**HTTP-01 签不了通配符** ⇒ 需 DNS-01 或手工证书 |
| 数据卷 | `picoaide-data` + `entrypoint.sh` 启动 `chown` | 新增 `apps/` 子目录，权限 `0700` |
| 审计 | `AuditLog(db, username, action, detail)` | app_id 只能编码进 `detail`；**不得按 app_id 过滤**（除非加列） |
| RBAC | 资源类别级（无实例级） | 沿用粗粒度点 + **应用层 owner 比较**，不要造实例级权限点 |

---

## 14. 参考

- 六路对抗审查报告：`docs/planning/2026-09-17-wasm-app-platform-review.md`
- 实测探针：`temp/wasm-probe/`（文件访问）、`temp/wasm-crash/`（崩溃隔离与超时）、`temp/sqlaudit2/`（ATTACH 与 VACUUM INTO）
- 权威依据：[SQLite set_authorizer](https://www.sqlite.org/c3ref/set_authorizer.html) · [SQLite run-time limits](https://www.sqlite.org/c3ref/limit.html) · [wazero FSConfig](https://github.com/wazero/wazero/blob/v1.3.0/fsconfig.go) · [Cloudflare Durable Objects 规则](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
