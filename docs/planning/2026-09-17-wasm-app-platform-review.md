# WASM 应用平台设计审查报告

- 日期：2026-09-17
- 对象：`docs/planning/2026-09-17-wasm-app-platform.md`（740 行规划）
- 方法：6 路独立子代理交叉审查（沙箱逃逸 / AI 与凭据 / 数据隔离 / 资源边界 / 多语言与 AI 工作流 / 与现有系统集成）+ 主控的实测与权威资料核查
- 目的：**在实施前找出不合理的设计**，收敛成待用户拍板的问题清单

> 本报告只收录**能指认证据**的问题（实测输出、官方文档原文、仓库代码行号）。泛泛的"建议加固"不收。

---

## 一、主控实测/核查发现（已验证）

### M1【阻塞级】纯 Go 驱动未暴露 authorizer，而它是 SQLite 方案的核心闸门

`sqlite3_set_authorizer` **不在** `modernc.org/sqlite` 的 Go 层 API 里。该驱动公开的顶层函数只有：

| 已暴露 | 用途 |
|---|---|
| `Limit(conn, sqlite3.SQLITE_LIMIT_X, val)` | **运行时资源上限**（可用） |
| `RegisterScalarFunction(...)` / `RegisterCollationUtf8(...)` | 接收 `*conn` 注册自定义函数/排序 |
| `(*Driver).RegisterConnectionHook(fn)` | 连接钩子 |
| `(*conn).ColumnInfo(query)` | 列信息 |

`Authorizer` / `SetAuthorizer` 在驱动内**零命中**（只存在于 vendored C 层 `lib/`）。
证据：`/root/go/pkg/mod/modernc.org/sqlite@v1.55.0/`，`grep -rn "Authorizer" --include=*.go . | grep -v "^./lib/"` 为空。

**但这条有救**：`RegisterScalarFunction` 已经证明"接收 `*conn`、内部取 `sqlite3*` 指针、调用 C API"这个模式在该驱动里可行（`sqlite.go:649`）。加一个同构的 `SetAuthorizer` 是**同一模式**，属于可控工作量——但它是**我们必须自己写并测试的代码**，而不是"用驱动现成的能力"。

**为什么这是阻塞级**：§D1.2 的三道闸门里，第②道（authorizer）现在没有可用实现。

### M2【设计错误】authorizer 只能做**列级**控制，做不了行级——而我们的 per_user 隔离是行级

SQLite 官方文档（[set_authorizer](https://www.sqlite.org/c3ref/set_authorizer.html)）原文：

> *"If the action code is SQLITE_READ and the callback returns SQLITE_IGNORE then the prepared statement statement is constructed to substitute a NULL value in place of the table column that would have been read... The SQLITE_IGNORE return can be used to deny an untrusted user access to individual columns of a table."*

即 `SQLITE_READ` + `SQLITE_IGNORE` 的效果是**把该列替换成 NULL**，不是过滤行。

而规划 §D1.4 写的是 *"authorizer 在 `SQLITE_READ`/`SQLITE_UPDATE` 上校验 owner 列"* 来实现 per_user 隔离——**这是行级需求，authorizer 表达不出来**。

⇒ per_user 隔离必须改成**每用户一个数据库文件**（`u/<user_id>.db`），把行级问题降成文件边界问题；authorizer 退化为只做危险动作拦截。

### M3【设计缺口】未使用 SQLite 官方的资源上限接口

官方对"处理不可信 SQL"的权威建议（同上文档原文）：

> *"Applications that need to process SQL from untrusted sources might also consider lowering resource limits using `sqlite3_limit()` and limiting database size using the `max_page_count` PRAGMA in addition to using an authorizer."*

可用的限制类别（[c_limit_attached](https://www.sqlite.org/c3ref/c_limit_attached.html)）：
`SQLITE_LIMIT_LENGTH`（单值/行字节）、`SQL_LENGTH`、`COLUMN`、`EXPR_DEPTH`、`COMPOUND_SELECT`、`VDBE_OP`（单语句字节码指令数）、`FUNCTION_ARG`、**`ATTACHED`（附加库数量）**、`LIKE_PATTERN_LENGTH`、`VARIABLE_NUMBER`、`TRIGGER_DEPTH`、`WORKER_THREADS`、`PARSER_DEPTH`。

**`SQLITE_LIMIT_ATTACHED = 0` 是把 `ATTACH` 从"被 authorizer 拦"降级为"数据库层面不可能"的更强做法**，且 `Limit()` 在 Go 层已可用（M1）。

规划文档**通篇未提** `sqlite3_limit` / `max_page_count`，而当前用户要求正是"资源界限要清晰，超过了直接杀死"。

### M4【必须写进实现约束】authorizer 的已知限制（官方明示）

| 限制 | 原文/含义 | 对我们的影响 |
|---|---|---|
| **只在 prepare 期触发** | *"the authorizer callback is invoked only during sqlite3_prepare()... Authorization is not performed during statement evaluation in sqlite3_step()"* | 授权是编译期检查，不是执行期 |
| **可能重新 prepare** | *"the statement might be re-prepared during sqlite3_step() due to a schema change. Hence, the application should ensure that the correct authorizer callback remains in place during sqlite3_step()"* | 回调必须在整个执行期保持挂载；schema 变更路径要单独测 |
| **回调内不得改连接** | *"must not do anything that will modify the database connection"*，且明确 *"sqlite3_prepare_v2() and sqlite3_step() both modify their database connections for the meaning of 'modify'"* | 若在回调里做嵌套查询/建表，直接违规 |
| **连接级单一** | *"Only a single authorizer can be in place on a database connection at a time"* | 一连接一策略，利于按应用隔离，但复用连接时要注意 |

---

## 二、6 路子代理审查结论

### 2.1 AI 集成与凭据泄漏审查（子代理 a6e272ab）

**P0-1【设计互斥，阻塞】** §D2 约束 3 要求主站会话 Cookie 为 host-only，浏览器不会把它发给 `<slug>.<基域>`；而 §D3.1 时序第 1 步是从 Cookie 解析用户。两者互斥，铸造链第一步不成立。文档只给应用子域写了"自己的 host-only 会话范围"，**从未定义该会话如何产生**。
- 二选一：**A** 把 Cookie 扩到 `Domain=.<基域>` ⇒ 每个应用 Origin 都持有用户会话 Cookie，应用页面 JS（作者可控代码）可直接对平台/网关发带 Cookie 的写请求（confused deputy），且"不需要 CORS/CSRF 风险最小"的前提失效；**B** 主站 302 带短时效一次性 code 换应用子域 Cookie。
- 附带事实：员工面目前**零 CSRF 保护**（`router.go`/`handler.go` grep csrf 无命中，全靠 `BearerAuth`），CSRF 只在管理面存在（`admin.go:257` `adminAuth` + `X-CSRF-Token`）。走 Cookie 路线 = 新建一类攻击面。

**P0-2 应用令牌无会话绑定** `api_tokens` 表（`migrations-pg/0002_tokens.sql:1-11`）只有 `id/user_id/token_hash/name/created_at/expires_at/last_used_at/revoked`，**无 session/device 绑定列**。员工登出只吊销当前那张 Bearer（`handler.go:533-538`）。§D3.1 为每个 (会话,用户,应用) 各铸一张 ⇒ 登出时无法枚举这 N 张，登出后 45 分钟内仍可重放。另一洞：登出再登入会铸新令牌，旧的不受影响。
- 建议：`api_tokens` 加 `session_id`（或 scope）按下发会话批量吊销；或 TTL 压到分钟级 + 与 `(user_id, session_nonce, app_id)` 强绑定、宿主自验。
- 确认文档"坑 1"成立：`CreateToken`（`serverstore/tokens.go:19`）只 INSERT 三列，`name` 写不了，应用令牌会落成默认 `'desktop'`。

**P0-3 铸造应用令牌无审计埋点** `AuditLog` 只出现在登录/admin 操作（`handler.go:311`、`admin.go:373-1020`）。§D3.1 铸造路径无任何审计点 ⇒ 每天凭空产生大量凭据却零留痕。

**P0-4 余额闸门只判"余额>0"而非预留** `handler.go:1391` 用 `serverstore.BalanceBlocked`（只看是否 >0），结算在**上游调用之后**（`balance_settlement.go:29-40` 自述：余额 1.00 过闸 → 上游被真调用 → 结算 8.00 失败 → 回滚）。叠加 `InFlightGuard` 每用户 32 并发（`handlers.go:129-149`）⇒ 余额 1 元可并发打满 32 个高价请求，**上游成本先发生**，平台实际承担。§D3 把"费用扣使用者"当已闭环，实际缺预留/并发口径。

**P1-5 `appstore.Publish` 无 `kind` 白名单校验** `publish.go` 全文无 kind 取值校验（grep `AppKindSkill|AppKindAgent|validKind` 零命中），kind 全靠调用方传常量（`agentshare/routes.go:405`、`sharedskills/routes.go:256`）。新增 `wasm_app` 沿用该模式 ⇒ 未来任一调用点写错 kind 即可跨 kind 命名空间（PK 是 `(kind, app_id)`）。建议入口加白名单 + 测试。

**P1-6「更新需审批」开关是 fail-open** `PendingCap` 由调用方传入（`publish.go:245-255`：`!req.AdminPublish && req.PendingCap > 0` 才限流）；`PendingCap == 0` = 不限待审。§D4.3 要求"默认开（需审批）"，实现语义却是漏传即免审批自助发布，且无护栏。

**P1-7 归因无法"不动 usage 表"实现** `usage` INSERT 是固定列清单（`serverstore/usage.go:269`），**无 app_id**；且 `usage` 是 `PARTITION BY RANGE (created_at)` 且 PK 含 `created_at`（`0004_usage.sql`/`0039`）⇒ 加列要动分区主表 + 已有各月分区。§D3.1"usage 表不动"与"网关/计量/余额闸门均不改动"**不成立**。建议改口径：接受一条分区迁移，或降级为近似归因并写明精度损失。

**P2-8 应用子域与主站共用 gin 引擎会路由外溢** 引擎级路由不都在 `/api` 下：`router.go:219` 的 `gw := r.Group("", BearerAuth, InFlightGuard)` 注册了无前缀 `/chat/completions`、`/models`、`/messages`；`router.go:89-90` 的 `/updates/client/*file` 在根且**无需认证**。若应用子域复用同一引擎 ⇒ `<slug>.<基域>/updates/client/...` 会下发客户端安装包。必须定死：应用子域**独立子路由树**，未匹配 `/api/*` 一律 404。

**P2-9 文档代码行号错误** §D3.1 两处写 `handler.go:301-303` 为审计员硬拦，实际 `RoleAuditor` 判断在 `handler.go:301`（返回至 304）。同文档另处引用 `:305` 正确。统一为 `301-304`。

**P2-10 令牌清理策略与短时效不匹配** `0031_indexes.sql:4` 的 `idx_tokens_expires` 注释是"90 天过期清理"。应用令牌 TTL 45 分钟却同表同索引，且 §D3.1 只写"到期静默重铸"、**未写服务端清理** ⇒ 令牌行长期堆积，扩大重放面。建议按 `app_id IS NOT NULL` 独立更短保留窗，或对同 (user,app,session) UPSERT 复用行。

**P2-11 `ai.chat` 提示注入的平台侧约束缺失** 请求信封含 `app_id/version/user{id,username,display_name,dept}`（§6.3）。若应用整包塞进 `messages`，就有把内部标识与组织结构喂给上游的路径。建议：`ai.chat` 的 messages 由应用自建、平台**不注入系统提示**，且返回体不得透出内部错误/上游原文（网关已有 4xx 只透传 `error.message/type/code` 的口径可复用）。

**查证无问题（各一行）**：用户名不可改（`0001*.sql:3` UNIQUE + `users.go:265/289/320` UPDATE 列集不含 username）⇒ `Publisher: u.Username` 无法伪造；应用自报 app_id 不成立（由宿主上下文提供）；沙箱文件越权与跨应用 SQL 结构上成立；`app_id` 加列不破坏既有清理；模型准入走既有逻辑无新缺口。


#### 主控对 P0-1 的补充分析（决定修复方案形状）

关键不只是"Cookie 怎么传到应用子域"，而是：**只要应用页面的 JS 能读到用户凭证，恶意应用就能冒充该用户去调平台 API**。因为应用页面的 JS 完全由应用作者控制（编译进 wasm、由宿主原样下发的 HTML/JS）。所以方案必须同时满足两条：
1. 应用子域能识别用户（否则应用用不了）
2. 应用 JS **拿不到**可用于调平台的凭证

三条候选路线对比：

| 路线 | 用户识别 | 应用 JS 能否拿到凭证 | 代价 |
|---|---|---|---|
| **A. 父域 Cookie**（`Domain=.<基域>`） | ✅ | ❌ **能**（Cookie 对该域所有子域可读，且可被 XSS 拿去调平台 API）= confused deputy | 还需新建整套 CSRF 防护（员工面目前零 CSRF） |
| **B. 一次性换票**（主站 302 带 code 换应用子域 **host-only + HttpOnly** Cookie） | ✅ | ✅ **不能**（HttpOnly ⇒ JS 读不到；host-only ⇒ 只作用于该子域） | 要做 302 往返 + code 单次性/时效/防重放 + 会话终止语义 |
| **C. 主站 API + CORS** | ✅ | ❌ **能**（authorization 响应头里的令牌 JS 可读） | 还要 CORS 白名单 + 凭证跨域 |

**推荐 B**，且建议把 B 简化：**不为每个 (会话,用户,应用) 造 api_tokens 行**，而是：
- 应用子域的 host-only Cookie 本身就是"这个用户已在这个应用上登录"的凭证（由一次性换票产生）
- 宿主据该 Cookie 解析用户 → 只铸**一张**短时效（45 分钟）**AI 网关令牌**，按 `(user, app)` 复用同一行（UPSERT），登出/换票失败即批量吊销

这样能同时收敛第 2 条（令牌暴涨且无法枚举）与第 10 条（清理口径不匹配）。

### 2.2 资源边界与运行时健壮性审查（子代理 9ddf2cdf）

**新实测证据（wazero v1.12.0，探针 temp/wasm-crash/ ⑦⑧）**
```
⑦ 宿主函数尊重 ctx、阻塞 5s，guest 预算 1s → 1s 返回，但 err=nil（不是错误！）
⑧ 宿主函数无视 ctx、阻塞 5s，guest 预算 1s → 实际耗时 5s，预算完全失效，err=nil
```
源码佐证：`callGoFunc`（`internal/wasm/gofunc.go:84`）把宿主函数**同步跑在 guest 的执行 goroutine 上**；`CloseModuleOnCanceledOrTimeout`（`internal/wasm/module_instance.go:33`）只把 module 标记为 closed，**guest 要回到执行边界才看得到**。

**P0-①【推翻核心承诺】「超时直接杀死」在宿主调用期间不成立。**
场景：guest 调 `db.query`，宿主阻塞 —— 实测预算被拖到 5s 且杀不掉。**SQLite 正落在这个缺口里**：`modernc.org/sqlite@v1.55.0` 顶层 Go API **无** `SetAuthorizer`/`Interrupt`/progress handler 导出（已 grep）⇒ 一次全表扫的 SELECT 会让执行槽长期占死、队列积压、WAL 锁不释放、且无法终止。
需定成：硬规则「**宿主能力调用不得阻塞超过预算**」——(a) 每个宿主函数必须用传入 ctx；(b) `ai.chat` 用 `http.NewRequestWithContext`；(c) **SQLite 路径必须有独立的语句级超时**；(d) 宿主调用返回后强制复检 ctx/module 状态；(e) 写进 F-18 验收。**不解决这条，其余所有闸门都是纸的。**

**P0-②【静默失败】「杀死」返回的却是成功。** 超时关掉 module 后若宿主函数正常返回，`Call` 返回 **err=nil**（⑦⑧ 实测）⇒ 应用看到 200、body 是截断或垃圾，使用者与作者 AI 都拿不到信号。
需定成：统一错误码 `RUNTIME_TIMEOUT/TRAP/MEMORY/NO_RESPONSE/HOST_CALL_OVER_BUDGET` + 固定状态映射；断言「**响应帧缺失或 module 因超时被关闭时，绝不返回 200**」。

**P0-③ 内存页上限无数值** F-21（:398）/§6.4（:574）只说"内存页上限"，全文无数字。需定成 `WithMemoryLimitPages(256)`（=16 MiB/实例）进 `limits.go` + 测试断言。

**P0-④ 编译缓存无界** F-22（:399）未给上限，而 **wazero 的 `NewCompilationCache()` 无任何容量/淘汰机制**（`cache.go:40-42`，已读源码）⇒ 100 应用 × 2.6 MB ≈ 数百 MB 常驻只增不减。需定成 LRU 128 条 / 512 MiB。

**P1-⑤ 响应输出无尺寸上限** F-37（:427）只有"请求体上限"。协议帧是行分隔 JSON，宿主逐行读 guest stdout ⇒ 单行 1 GiB 即可让**宿主**先 OOM。需定成单行 1 MiB / 总响应 8 MiB，超限即杀。

**P1-⑥ 队列与总延迟无界** D1.3/F-28c 只说"请求排队"，队列长度、满了怎么办、排队是否计入超时**全部未定义**。按 30s/请求算，100 并发 → 第 100 位等约 50 分钟。需定成：每应用队列上限 32（超出 429 + `Retry-After`）+ **到达时算总 deadline（35s）**。

**P1-⑦ 资源缓存键缺用户维度（跨用户泄漏）** F-20（:397）/§6.1（:504）明确按 `(app_version, path)` 缓存。应用对同一路径按用户返回不同内容（"你好 张三"）时 **B 拿到 A 的缓存**。需定成：只缓存**声明为静态**的 `assets.read` 路径、键加 `app_id`、动态响应一律不进缓存。

**P1-⑧ 实例复用未定义，「无状态」没有着落** F-22「实例池预热」/§6.4「每应用并发实例上限」与 D1.3「每应用串行」**互相矛盾**，全文无一句写明每请求新实例还是复用。需定成：**只缓存编译结果、不缓存实例**，删"实例池预热"，把"禁止跨请求状态"写进作者契约。

**P1-⑨ 所有边界的数值都缺失** 除 `.wasm` 32 MiB（F-07/D6）与库 256 MiB（F-31）外，CPU/墙钟超时、内存页、调用栈深度、响应体、并发、队列、编译耗时、AI 上限、查询时长**全部无值**。需定成**单一 `limits.go`** 作唯一真源，runtime 配置/错误文案/作者文档/SKILL.md 全从它投影 + 构建期门禁。

**P2-⑩ 可观测性缺口** F-57（:472）只列审计动作，**无触发限制时的用量**，答不出"这个应用刚才为什么被杀"。需每次调用落结构化事件：`app_id/user_id/outcome/reason_code/cpu_ms/peak_memory_bytes/host_call_count/host_call_ms/queue_wait_ms/response_bytes`。

**P2-⑪ SQLite 层时间与数量边界无定义** 单查询时长、最大行数、结果集字节、连接数全无；"只读放大攻击"不受限且正好落在 ① 的缺口里。

**P2-⑫ 强制下线/请求取消的收尾未定义** F-56 有"强制下线"，但进行中请求是否取消、队列如何处理、连接与令牌是否释放均未定义。需：下线即取消所有 in-flight 与其 ctx、清空队列并给排队者明确错误、关闭连接、立即吊销应用令牌。

**零散矛盾**：
- §6.4 :574「每应用并发上限」与 D1.3「每应用串行」冲突 ⇒ 删前者，改"**并发度恒为 1**"。
- F-22「实例池预热」与"无状态"冲突 ⇒ 见 ⑧。
- **32 MiB 模块上限与"语言支持越全面越好"冲突**：带 runtime 的语言（Python/C#/Java）单文件可达数十 MB，该上限**先把它们挡在门外** ⇒ 需与语言矩阵一起重定，且必须同时给出 ③ 的内存上限。

### 2.3 与现有系统集成审查（子代理 23a1f613）

**P0-1 `app_id` 校验比文档假设严得多** `skillmanifest/manifest.go:243` — `appIDRe = ^[a-z0-9]+(?:-[a-z0-9]+)*$`（**不允许大写、点、下划线、连续横线**）；`:60-61` MinLen=2/MaxLen=64；由 `appstore/publish.go:121` 强制，不过即 400 INVALID_APP_ID。文档 F-03 写的"3–40"与真实 2–64 不符，且 AI 极易生成 `my_app`/`MyTool`/`report--v2` ⇒ **每次 400，而这是上传的第一个动作**。

**P0-2【改设计】32 MiB 的 .wasm 会被 1 MB 中间件拦掉** `router.go:95` `maxJSONBody = 1<<20`；`:119-126` `bodyLimitMiddleware` 套在 `cli := r.Group(NamespaceClientV2, ...)`（`:72`）下**每个**端点；`:101-108` 的 `largeBodyRoutes` 是**手写精确匹配白名单**，只有 4 条。新上传路由若忘记进白名单 ⇒ >1 MB 上传报 `request body too large`，且被各 handler 压成 **400 VALIDATION**（`:114-117`），**错误完全不指向体积上限，AI 无从自修**。

**P0-3 `apps.kind` 的 CHECK 约束会拒绝 wasm_app** `0053_apps.sql:18` — `kind TEXT NOT NULL CHECK (kind IN ('skill','agent'))`（PG 层约束，INSERT 直接报表约束冲突）。文档 D4.4 说对了但只当"待办"，**没进功能表** ⇒ 排期会漏。

**P0-4 版本号与 changelog 的硬要求文档未写** `manifest.go:248` `versionRe = ^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$`（`v1.0`/`1.0`/`v1.0.0` 全拒）；`publish.go:125` 校验格式、`:145-160` 必须严格递增、`:243` **非首个版本 changelog 为空即 422**。AI 每次迭代都要过这三关，且 422 文案是给人看的、不是修复指令。

**P0-5【改设计，最严重】`picoaide_session` 是管理员专属，员工浏览器会话不存在**
`admin.go:28` `sessionCookieName = "picoaide_session"`；`:440-457` 的 `issueAdminSession` 只在**管理员登录**路径调用，且是**唯一**设置该 Cookie 的地方；员工登录 `handler.go:305-316` 只返回 `{"token": ...}` 的 Bearer 明文。
⇒ F-35「应用主机入口 → 未登录跳主站登录页，登录后回跳」**需要一套目前不存在的员工侧浏览器 Cookie 会话**。全仓无"员工浏览器登录"可用面（`/api/client/v2/auth/oidc|openid/*` 路由存在但产物形态未核，不可假定是 Cookie 会话）。
**这条与 §2.1 的 P0-1 是同一堵墙的两面**：一个从"应用子域拿不到 Cookie"看，一个从"员工侧压根没有浏览器会话"看。
**附带好消息**：Cookie 当前**没有 Domain 属性**（`admin.go:449-457` 未设置），已是 host-only + HttpOnly + SameSite=Lax + 条件 Secure ⇒ **F-05 是"保持"而不是"加固"**。

**P1-6 `publish` 复用需构造等价 Manifest** `publish.go:84-90` 的 `PublishRequest.Manifest` 是**必需字段**（注释明写"技能来自 SKILL.md frontmatter"），`:130` 起全部校验读 `req.Manifest.*`。wasm 单文件无 frontmatter ⇒ 必须由调用方构造清单（版本/标题/changelog 从哪来要定）。

**P1-7 `app_id` 不是全局唯一** `0053_apps.sql:27` `PRIMARY KEY (kind, app_id)`，注释明写"技能与智能体允许同名"；另有 `channel CHECK IN ('market','org')` 与 `apps.official`。⇒ **slug 必须是独立列 + 自带全局唯一约束**（文档方向对但没点出"不能复用 app_id"）；且 wasm 应用必须落 `channel='org'`，`Publish` 在 `:205-209` 会因渠道不一致返回 409 ⇒ **与既有 skill/agent 同名会互斥**。

**P1-8 usage 归因改动量远超 2 人日** `usage` 列（`0039:23-34` + `0063` + `0065`）**无 app_id**，`usage_daily`/`usage_monthly`（`:48-73`）同无；归因入口 `serverstore/usage.go:211/217/224` 的 `RecordUsageKind*` 签名只吃 `userID/model/tokens/kind`。且查 token 行的是 `serverauth/token.go:36` 的 `VerifyToken`，它只把 `*User` 放进 gin context，**网关层完全没有 token 行对象**。落地需 4 步：①`api_tokens` 加列 ②改 `VerifyToken` 把 token 行塞进 context（或网关二次查 hash）③给 `RecordUsageKind*` 加参数并改全部调用点 ④日/月账 PK `(user_id,model,day)` 不含 app_id ⇒ 加维度成本高或按需查明细。

**P1-9 RBAC 是资源类别级，不支持"按应用逐个判定"** `rbac.go:23-48` 的 `Perm*` 全是类别级；`AdminRoute` 只接受一个 perm；生产树里应用相关唯一路由是 `router.go:358` 的 `PUT /apps/:kind/:app_id/owner`（用 `PermCapabilityWrite`），而"发布者即管理员"是 `publish.go:207-214` 的 **owner 相等检查**实现的，**不是 RBAC**。⇒ F-59 应明确"沿用粗粒度点 + 应用层 owner 比较"，不要造按应用粒度的权限点。

**P1-10 审计链的两个硬约束** `serverstore/audit.go:136-166` 签名 `AuditLog(db, username, action, detail string)`，**detail 是自由字符串** ⇒ 应用级审计只能把 app_id 编码进文本，**无法按 app_id 过滤/聚合**；且写路径是**每 DB 单 worker 串行 + 批量**（入队等 5s、等结果 15s，**同步阻塞请求**）⇒ 不能"每次应用调用都记审计"，应在 F-57 明确只记上传/上下架/删除。

**P1-11【好消息，F-02 可下调】通配站点不用改 Caddy 模板** `Caddyfile.autocert:13` / `Caddyfile.manual:21` 的站点标签都是 `{$DOMAIN}`（环境变量），而 Caddyfile 站点地址按逗号分隔 ⇒ 只需把 `.env` 的 `DOMAIN` 改成 `harness.example.com, *.harness.example.com`，**模板零改动**；`header_up Host {host}`（`:16`）已满足 Host 透传。真正阻塞仍是 autocert 走 HTTP-01 签不了通配符。

**P2-12 归档读取的性能生死线 + 已有可复用范式** `serverstore/apps.go:95-103` 的 `scanRelease(..., withArchive bool)` 在 `withArchive=true` 时把 `archive BYTEA` 扫进内存；`:77` 注释"清单查询绝不加载全部归档"（**清单不含，单条会含**）。若宿主按请求调 `GetRelease`，32 MiB 每请求从 PG 拉一次。**现成范式**：`marketplace/admin.go:177-184` 的磁盘缓存 + `invalidateSkillCache(cacheDir, name)`，以及 `cmd/server/main.go:199-202` 把缓存目录注入各 handler——文档完全没提。

**P2-13 `router_test` 无反向完整性断言** `router_test.go` 仅 6 个测试，其中 `TestLargeBodyRoutesExist`（`:297-308`）方向是"白名单每条必须在生产树注册"，**没有**"需要大体积上传的路由必须进白名单"的反向断言；`TestLargeBodyRoutesExemptions`（`:271-296`）是硬编码枚举 ⇒ P0-2 那个坑**现有门禁抓不到**。

**核对无误的部分**：owner 首占/OFFICIAL_LOCKED/跨渠道同名/归属保护的行号全部准确；`TokenTTL=90d`、`IssueToken`、`CreateToken(expiresAt)` 准确；`/v1` 是 `BearerAuth + InFlightGuard` 且默认 32 准确；`Dockerfile:45` `CGO_ENABLED=0` 准确 ⇒ **wazero 纯 Go 选型成立**；`picoaide-data` 卷存在且 `entrypoint.sh:24-27` 每次启动 `chown -R picoaide:picoaide /data` ⇒ **落 SQLite 无权限问题**。

### 2.4 数据隔离与越权审查（子代理 54061832）——**本轮最严重**

**总判：§D1.2 的主闸门（authorizer）在选定的 Go 驱动上不存在，三条"结构性闸门"实际只剩一条半。** 所有结论经本机实测（modernc.org/sqlite v1.55.0，探针在 `temp/sqlaudit/`）。

**P0-1 authorizer 主闸门不存在** 驱动全部非测试导出符号中**无任何 authorizer 相关导出**（可用的是 `RegisterFunction/RegisterScalarFunction/RegisterConnectionHook/PreUpdateHookFn/Limit`）；`sqlite3_set_authorizer` 只在 vendored ccgo 代码 `lib/sqlite.go:11819`，Go 层不可达。⇒ F-28b / F-28d / §D1.4 的 per_user 方案(a) / §D1.6 的 ①②③④⑤ **全部没有实现载体**。
附带：官方文档确认 authorizer **只在 prepare 期调用**，且第 4/5/6 参数只给**表名/列名、不给值**（https://www.sqlite.org/c3ref/set_authorizer.html）。

**P0-2【实测 LEAK】多语句让 `db.query`/`db.exec` 的区分形同虚设**
实测：`db.Query` 执行 `INSERT …; SELECT secret FROM items WHERE owner_user_id='bob'` **成功回读 `B-SECRET`**；`db.Exec` 执行 `INSERT …; DROP TABLE items` **两条都执行了**（`sqlite_master` 里 items 已消失）。
⇒ 推翻 §D1.2 的"让引擎判定，宿主只做结构收窄"。**宿主必须自己拒绝多语句**——而分号判定要排除字符串字面量内的 `;`，需要一个小词法扫描（**不是完整 SQL 解析**，可控）。

**P0-3【实测】只要不阻止 ATTACH，跨应用/跨用户读只差一条语句**
实测：`ATTACH DATABASE '<合法 sqlite 文件>' AS b` **成功**，随后 `SELECT v FROM b.secrets` 与 `SELECT name FROM b.sqlite_master` 均成功。**defensive 模式下 `ATTACH '/etc/passwd'` 被拒只是因为那不是合法 SQLite 文件**（`file is not a database`），**defensive 不拦合法库文件**。
⇒ 宿主必须**只允许 schemaname ∈ {main, temp}**。

**P0-4【实测】`_defensive` DSN 参数不存在；且 defensive 本身不阻 DDL/temp 表/owner 改写**
实测：`_defensive` / `_defensive=1` / `_pragma=defensive(1)` / 无参数**四种连接行为完全相同**（`CREATE TABLE` 与 `PRAGMA writable_schema=ON` **均允许**）——`_defensive` 被当普通查询参数忽略。驱动 `driver.go:40-100` 列出的完整支持参数为 `_pragma/_busy_timeout/_foreign_keys/_journal_mode/_synchronous/_auto_vacuum/**_query_only**` + `_time_*`，**没有 `_defensive`**。
**唯一有效的只读闸门是 `_pragma=query_only(1)`**（实测：`CREATE TABLE` 被拒 `attempt to write a readonly database`）。
⇒ 文档 §D1.2 的"退回 DSN 防御模式"**退路不存在**，必须改写为 `query_only` + 宿主侧 PRAGMA 白名单。

**P0-5【实测 LEAK】owner 列可被应用自由改写 ⇒ per_user 隔离被绕过**
实测：`UPDATE items SET owner_user_id='attacker' WHERE owner_user_id='bob'` **ALLOWED**，随后 `SELECT secret FROM items WHERE owner_user_id='attacker'` **返回 1 行（bob 的秘密）**。
**根因（关键）**：authorizer 回调**只给表名/列名、不给写入的值** ⇒ "校验 owner 必须等于当前用户"**在引擎层无法表达**。**即便 authorizer 可用也拦不住。**
⇒ per_user **必须放弃"单文件 + owner 列"路线**，改为 `u/<user_id>.db` 按用户分文件（文件系统即边界）。

**P0-6【实测】连接级状态跨请求粘连，把 ATTACH 攻击变成两段式**
实测依据：ATTACH 是**连接级**状态（官方 §lang_attach）；驱动有连接池（`_txlock`）。请求 1 `ATTACH … AS b`，请求 2 直接 `SELECT … FROM b.secrets`。
⇒ 闸门必须在**每次调用开始重置连接级状态**（检查 `PRAGMA database_list` 只允许 main/temp，或每次调用用新连接），并把 `database_list` 列入被拒 PRAGMA。

**P0-7【实测 LEAK】视图绕过"按表名过滤"**
实测：`CREATE VIEW v AS SELECT * FROM items` **ALLOWED** → `SELECT * FROM v` **ALLOWED，返回 1 行**。
⇒ 宿主若按表名白名单过滤会被视图绕过；应**运行期完全禁 DDL**（视图/触发器只在发布时迁移阶段可建）。

**P0-8【实测】运行期 DDL 完全未被约束**
实测：`CREATE TABLE leak(x)` ALLOWED（该表**没有 owner_user_id 列** ⇒ 任何"按列过滤"的 per_user 实现对它无效）；`DROP TABLE items` ALLOWED（可毁数据）；`ALTER TABLE … ADD COLUMN` 允许。
§D1.5 声称"运行期无 DDL"但**没给实现方式**（SQLite 无权限/角色概念）。
⇒ 运行期连接**禁用所有 DDL**（语句种类白名单：仅 SELECT/INSERT/UPDATE/DELETE），迁移只在发布阶段独立连接执行 + 留存 diff 供审批 + 校验"新建表必须含 owner_user_id"。

**P1-9 元数据与错误信息泄漏** `SELECT name FROM sqlite_master` 实测 ALLOWED ⇒ 泄漏全部表名与结构；且 `shared` 表上靠 `UNIQUE` 冲突报错可**枚举其他用户占用的键**。§6.3 的响应信封会把 SQL 错误文本回给应用→AI→可能显示给使用者。⇒ F-33 自省只对发布者开放且审计；错误文本回传前做归一化（表名/列名/约束名替换为占位）。

**P1-10 配额只定义了"文件体积"** F-31 只有 256 MiB；§6.4 同。缺返回行数/字节上限、每语句时长上限、读放大上限。⇒ 给 `db.query` 加返回行数与字节上限（超限截断并报错）+ 语句时长上限，并把"不得无 LIMIT 全表扫"写进作者约束与 skill。

**P1-11 `db.tx` + 每应用串行 + AI 阻塞叠加成 DoS** 应用 `BEGIN` → 调 `ai.chat`（同步阻塞秒级到十几秒）→ 期间执行槽被占满；若持 SQLite 写锁还阻碍 WAL checkpoint 使 .wal 膨胀逼近上限。⇒ **事务内禁止宿主调用**（`ai.chat`/`log` 在 tx 内直接报错）+ 事务硬超时强制 ROLLBACK + 队列公平性与每用户配额。

**P1-12 导出/删除/备份的权限模型缺失** F-32"导出＝打包该目录"拿到的是**整个应用全量数据（含所有人的行）**且**未绑定任何权限点**；per_user 下"导出/删除我的数据"无实现；§D1.4 `shared` 的"不注入范围"与 per_user 的"宿主注入 WHERE"**在"不解析 SQL"前提下如何实现未定义**（又一处在依赖已不存在的 authorizer/解析能力）。⇒ 导出绑定平台管理员 + 写审计；用户级导出/删除靠 per_user 分文件天然实现（删/导出 `u/<user_id>.db`）。

**文档自相矛盾（本次确认）**
1. §5.2 F-14（:386）残留 PG 表述："本地 PG（或与应用等价的 schema 模拟）" —— 生产已回退 SQLite，**会造成"本地 PG 开发、线上 SQLite 跑"的语义不一致**。
2. §5.4 F-34（:418）"需落实 modernc 构建是否含 FTS5" —— **本次结案：含**（`lib/sqlite_linux_*.go` 生成参数有 `-DSQLITE_ENABLE_FTS5`），可删掉"需落实"（语法未实测）。
3. §8 风险表"三道结构性闸门：文件边界 + authorizer + 宿主推导路径" —— authorizer 不存在，随 P0-1 一起改。

**方向级结论（无问题）**：文件边界成立（平台表不在应用 .db 里）；每应用串行本身不是 DoS 面（同应用内平等排队），问题在与 `db.tx`+`ai.chat` 叠加；WASI 无文件系统（前已实测）；§D1.6 九条边界测试**覆盖面不足**，缺 ATTACH 到合法 SQLite 文件、多语句、视图、temp 表、owner 列改写、运行期 DDL、连接级状态粘连、错误信息泄漏共 **8 类**。

### 2.5 多语言与 AI 生成工作流审查（子代理 a7f43836）

**总判：用户两个前提里，"产物大小无所谓"成立（实测 5.3 KB vs 2.6 MB 不影响架构）；"语言支持越全面越好"与当前选型（wazero + preview1）直接冲突。**

**阻塞-1【实测】wazero 完全不支持组件模型与 WASI preview2** 实测 v1.12.0 模块缓存：**无 component 相关目录，全仓 grep `preview2`/`wasi:sockets` 零命中**；README 只声明 WebAssembly **Core** 1.0/2.0 合规，全文不提组件模型；生态侧存在 issue #2200「Plans to support component model?」⇒ 尚未支持。**⇒ 所有组件模型产物一个都跑不了**，而新兴语言的 WASI 路径几乎全是组件模型（见矩阵）。

**阻塞-2 WASIp1 已进"历史兼容"通道** Rust 官方平台支持文档原话：WASI 标准"已被 rebase 到组件模型之上"，2024-01 发布 0.2.0（WASIp2），`wasm32-wasip1` **"is intended for historical compatibility with WASIp1"**，且 WASIp1 syscalls **"no longer receiving any maintenance (no new APIs, no new documentation)"**。该目标 Tier 2、**无线程**（spawn thread 恒失败）、**无进程**、默认 `-Cpanic=abort`。
⇒ **语言支持面是时间递减的，不是递增的。**

**阻塞-3 真实语言矩阵比规划窄**

| 语言 | 能上？ | 阻塞点 |
|---|---|---|
| Rust | ✅ | `wasm32-wasip1` Tier 2；无线程/无进程；panic=abort |
| Go | ✅ | `GOOS=wasip1` 官方目标；**已实测编译+运行成功** |
| Zig | ✅ | **已实测** 5.3 KB、导入面仅 `wasi_snapshot_preview1`；注意 ziglang #19581 正议把 `wasi` 改名 `wasip1`，**工具链改名会打断构建脚本** |
| C/C++ | ⚠️ | 需 wasi-sdk + wasi-libc；Emscripten 产物导入面巨大（`env.*`）**会被导入白名单拒** |
| TinyGo | ⚠️ | 有 wasi 目标，但调度器/GC/**stdout 缓冲**与标准 Go 不同，需单独验证 ABI |
| C# | ❌ | .NET 的 WASI 是**实验性 workload**，官方示例走 **component** 路径 |
| Python | ❌ | 唯一现实路径 `componentize-py` → **输出组件** |
| Java/Kotlin | ❌ | **找不到任何产出 WASI p1 core module 的官方/成熟工具链**；JVM 无 WASI 移植 |
| Swift | ❌ | SwiftWasm 路线图"Officialization… 尚未完成"，"Component Model & WASI Preview 2"仍是 What's Next |
| AssemblyScript | ⚠️ | 需 wasi-shim；未关闭 issue #1098「编译产物发出错误的 WASI 模块名」、#2703（`console.log` 是否合规）——正是白名单会卡的形态 |
| JS/TS | ❌ | `componentize-js`（StarlingMonkey）**输出组件** |

⇒ 硬判据应收敛为"**能产出 WASI p1 core module 且导入面干净**"，逐语言用同一探针在 V0 验证并进 CI。

**成本被低估-4 AI 在哪里编译，规划里完全没有** `AI（唯一操作者）` 职责写的是"建应用→**编译**→上传→发布"（:52），但全仓 `wasip1|wasm32-wasi|tinygo|wasi-sdk` 在客户端/配置里**零命中**；server 23 个 internal 包**无任何构建服务**。且 R4/:53 明确"作者不装工具链、不碰服务器"。
⇒ 二选一：(a) 平台侧构建服务（新增组件 + 沙箱编译 + 语言镜像 = **第二套"运行不可信代码"系统**）；(b) 明确"AI 在员工本机编译，平台只收 wasm" + 发布编译器版本矩阵作为契约。

**成本被低估-5 没有"干跑/预检"接口，F-53 错误格式对 AI 不可用** 全文搜 `干跑|dry-run|预检` **零命中**；F-53 只说"回传可操作的错误"，无错误码契约；上传即发布路径无"只校验不落版本"分支。
⇒ AI 每次试错都占一个版本号（F-09 软删仍永久占版本号）+ 一条审计，且拿不到结构化错误无法自修。建议新增 `POST …/wasm/validate`。

**成本被低估-6【协议脆性】stdout"最后一行"在多语言下会被普通调试输出打断** ABI（:551-557）规定"最终响应 = stdout **最后一行** JSON"，但语言运行时/库普遍会往 stdout 打警告/进度/debug。**脆性随语言数线性上升，正好与"越全越好"冲突**；且失败形态是"解析不到信封"，AI 拿到的是含糊错误而不是"你多打了一行"。
⇒ 改为显式定界（magic 前缀 + 长度 / `\x1e` 起始）或响应走独立通道 + 校验期 stdout 净化检查。

**总判-7 CPU 超时与阻塞式 `ai.chat` 互相打架** F-21 用 CPU 超时硬杀，F-42 的 `ai.chat` 是宿主侧**阻塞**调用（非流式）。若 10 秒 guest 预算覆盖整次调用，**任何用 AI 的应用都会被误杀**。
⇒ guest 计时与宿主调用分开计账（进宿主调用时暂停计时），或给 `ai.chat` 单独预算。

**8 F-14 存储口径已漂移** F-14（:386）仍写"本地起服务 + 热重载 + **本地 PG（或与应用等价的 schema 模拟）**"，而方案已改回"一应用一 SQLite"。且员工机器无 WASI 工具链时，"本地跑通"只能跑**已编好的 wasm**，帮不了"写代码"。⇒ F-14 应重定义为"**执行宿主**"，不要承诺"本地能开发"。

**长期失控-9 skill 不存在且无漂移防护** 全文搜 `skill|SKILL` 在功能表出现 **0 次**（用户口头要求，规划里没有条目）。典型失效：skill 写超时 30 秒、runtime 配 10 秒 ⇒ AI 按 skill 写、runtime 按配置杀，**员工看到"AI 写的代码莫名其妙失败"，两边都不报错**。⇒ skill 约束表**从 `limits.go` 生成** + 构建期门禁 + `x-abi-version` 绑定；ABI 未锁前不发正式 skill。

**10 导入白名单按现状写法会拒掉大量工具链** F-08（:380）写"无 `sock_*`、无 fd 类"，但没说**允许什么**。实测 Go 探针只用 7 个 WASI 调用、Zig 只用 3 个（都干净）；但 AssemblyScript 发 `env.abort`、Emscripten 发一大片 `env.*`、旧版 Go 也发 `env.*`。⇒ 白名单写成**命名空间+函数名双允许清单**，并把"被拒导入 + 每条 hint"作为校验输出喂 AI。
**要问用户**：允许清单是否包含非 wasi 命名空间？（若包含 = 给沙箱开新面，需单独安全评审）

**11【最隐蔽】平台要求无状态，但 ABI 与 skill 都没写** 全文搜 `无状态|stateless|状态传递|全局变量|实例复用` **零命中**。而 AI 作者会自然而然用全局变量存"当前用户/会话状态"——**实例一旦复用就是跨用户数据泄漏，而且不报错**。⇒ ABI 增加"状态如何传递"的显式通道；skill 第一条规则写"无服务端会话状态"；F-22 若做实例池必须写明"复用时如何保证不串数据"。

**12 十语言 = 十份示例 + 十份 CI + 十套排障知识** F-13 只写"Rust、TinyGo 至少各一份 = 5 人日"；但示例价值在于**AI 抄错率最低**，每加一种语言就要多一份"可编译 + 与 ABI 同步 + 进 CI"，ABI 每变一次乘 N。⇒ 收敛点 Tier1 只保 Rust/Go/Zig 进 CI，其余"文档说明不支持"而非"支持但不测"。

### 2.6 WASM 沙箱逃逸审查（子代理 2cf6e562）——含主控独立复核

**P0-1 authorizer 在选定驱动上不可实现** 与 M1/2.4-P0-1 同一结论（三路独立命中）。驱动真正支持的 DSN 参数只有 `_busy_timeout/_auto_vacuum/_foreign_keys/_journal_mode/_synchronous/_query_only/_txlock/_pragma/_time_*`；**无 `_defensive`**。可用的是 `sqlite.Limit(*sql.Conn,id,val)`（= 官方 `sqlite3_limit()`）与 `Driver.RegisterConnectionHook`——**文档都没提**。

**P0-2 跨应用窃取与破坏完整跑通（"文件边界"这道闸门不成立）**
五步全 `<nil>`：`ATTACH … AS b` → `INSERT INTO loot SELECT payload FROM b.secrets` → `DROP TABLE b.secrets` → `VACUUM INTO '<应用目录外>'`。
**文档判断的错误点**：§D1.2 闸门①的推理"平台表不在这个文件里，SQL 再怎么注入也够不着"**只对平台 PG 表成立**——**其他应用的 `.db` 对宿主进程是普通可读写文件**，`ATTACH` 就是打开它的合法 SQL 入口。

**P0-3【主控已源码复核】wazero 默认随机源是确定性假源**
`internal/sys/sys.go:151-152`：`if randSource == nil { sysCtx.randSource = platform.NewFakeRandSource() }`；`config.go:652` 注释 "deterministic source. You might override this with crypto/rand.Reader"。
⇒ 任何用 `random_get` 的应用（token/密钥/nonce）**全部可预测**；**并且我们自己的设计也会中招**。
**同类**：时钟也不是真实时间——`config.go:582` 注释 "This does not default to time.Now as that violates sandboxing"。
**必须显式注入**：`WithRandSource(rand.Reader)` + `WithSysWalltime()` + `WithSysNanotime()` + `WithNanosleep(...)`（方法名已核实：`config.go:802/815/820/839`）。

**P0-4【主控已实测复核】`VACUUM INTO` 是独立于 ATTACH 的任意文件写原语**
`SQLITE_ATTACH` 是独立 action code；`VACUUM INTO '<file>'` 打开目标文件写库，**不经过 ATTACH 授权路径**。
⇒ **即便将来 authorizer 可用，只按文档拒 `ATTACH` 也拦不住它**。语句白名单必须显式禁 `VACUUM`。

**P1-5 `_defensive` 退路不存在**（同 M1/2.4-P0-4）⇒ 改写为 `_pragma=query_only(1)`。

**P1-6 缺 SQLite 层资源限** 官方 `set_authorizer` 文档原话建议 "lowering resource limits using `sqlite3_limit()` and limiting database size using the `max_page_count` PRAGMA **in addition to** using an authorizer"。实跑佐证：无界递归 CTE **3 秒预算内不返回**（但 context 可取消 ⇒ 是"可中断"而非"杀不掉"，比宿主阻塞那条好）。

**P1-7 串行队列无公平性/时限** 一个用户的昂贵查询让该应用**所有**用户排队；配合全局排队可外溢。

**P1-8【主控已实测复核】§D1.6 测试清单打偏了**
实测 `SELECT readfile('/etc/passwd')` / `writefile(...)` → **`no such function`**（modernc 未编译 fileio 扩展）。⇒ 文档列的 ②③ 是**不存在的攻击面**，而真实的 `ATTACH`/`VACUUM INTO` 一条都没测。应把"函数不存在"记为**依赖构建配置的属性**（换驱动/构建标志就可能出现）。

**P1-9 进程级共享可变状态** `vtab.RegisterModule` 的包级注册是**进程全局**且 "reach every Driver"；`RegisterConnectionHook` 是连接级。⇒ 必须定「一应用一 driver + 一应用一连接、不复用」，并禁止注册进程级虚拟表模块。

**P2-10 响应头未校验** ABI 让 guest 返回 `{"headers":{...}}`，§6.4 边界表**只约束请求方向**，没有响应头白名单。⇒ 应用子域上可 `Set-Cookie`、可设任意 `Content-Type`/`Content-Disposition`。必须做响应头白名单 + 拒 CR/LF。

**P2-11 §D5「preview1 无 socket 接口」表述不准** wazero 有 `imports/wasi_snapshot_preview1/sock.go`（`sockAccept/Recv/Send/Shutdown`，部分返 `ENOTSUP`），但**无 `sock_open`（无出站拨号）**且 host 侧未配置监听。⇒ **实践结论一致（应用无法出站），但理由要改**——这个区别在**升级 wazero / 换 preview2** 时会立刻变成真实风险。

**已查证无问题（各一行）**：`args_get` 不泄露宿主 argv（默认不传）；`environ_get` 不泄露宿主环境（默认不传，但**设计里要明写"不传任何 env"**）；`fd_write` 到 stderr 默认 `io.Discard`；`proc_exit` 表现为 `sys.ExitError`；`assets.read` 无路径穿越（资源编进 wasm 字节）；畸形 wasm 在编译期以 error 返回（宿主存活）。


### 2.7 主控独立复核记录（不采信单一来源）

三条最严重的发现由主控**独立复现**（探针 `temp/sqlaudit2/`）：

```
ATTACH 跨应用读取     → "B-CONFIDENTIAL-SALARY-999" 外泄闭环成功（INSERT INTO loot SELECT … FROM b.secrets）
VACUUM INTO 写应用外  → ESCAPED.db (8192B) 成功 + 写入 /tmp 成功
readfile/writefile    → no such function（证实 §D1.6 测的是不存在的攻击面）
```

wazero 两处默认值由主控**源码复核**（非转述）：
- `internal/sys/sys.go:151-152` ⇒ 默认 `platform.NewFakeRandSource()`（**全零**）
- `config.go:582` ⇒ 时钟 "does not default to time.Now"
- 必须显式调用的方法：`WithRandSource` / `WithSysWalltime` / `WithSysNanotime` / `WithNanosleep`（`config.go:802/815/820/839`）

---

## 六、用户已拍板的四项决策（2026-09-17）

| # | 决策 | 影响 |
|---|---|---|
| **1** | **接受窄语言面，维持 wazero** | 语言面 = Rust / Go / Zig（+C/C++、TinyGo 待验证）；接受"语言面时间递减"；32 MiB 模块上限可保留 |
| **2** | **员工本机编译，平台只收 wasm** | 平台不建构建服务；**必须发布"编译器版本矩阵"作为契约**；需接受"本地过≠线上过" |
| **3** | **会话走 B：一次性换票** | 主站 302 带短时效一次性 code → 换应用子域 host-only + HttpOnly Cookie；应用 JS 拿不到凭证 ⇒ 恶意应用无法冒充用户 |
| **4** | **SQL 超时先上 B3：`SQLITE_LIMIT_*` 编译期拦截** | 用 `VDBE_OP`/`EXPR_DEPTH`/`PARSER_DEPTH`/`COMPOUND_SELECT`/`LENGTH`/`SQL_LENGTH`/`ATTACHED` 把病态查询挡在编译期；超时仅兜底；**不动驱动**（authorizer/interrupt 的 fork 留作后续） |

### 决策带来的连锁结论（必须随文档一并改）

1. **决策 4 不解决 SQL 查询中断**：`SQLITE_LIMIT_*` 挡的是"病态/超大"查询，**挡不住"合法但很慢"的查询**（如大表全扫）。⇒ 仍需「单用户占槽上限 + 单请求端到端预算（含排队）」兜底；且**宿主阻塞期间 guest 超时失效**这条（2.2 P0-①）依然存在，必须规定"宿主能力调用不得阻塞超过预算"。
2. **决策 1 + 3 叠加**：窄语言面下 wazero 默认假随机源**不会**影响我们的会话（换票走服务端 CSPRNG），但**应用自己**若用 `random_get` 生成 token 会全零 ⇒ 仍必须 `WithRandSource(rand.Reader)`。
3. **决策 2 使校验前置成为关键路径**：AI 在本机编译后上传，平台只能"上传即校验"。⇒ **预检接口（只校验不落版本号）从 P1 升为 P0**。
4. **决策 1 使 §D6.1 语言矩阵定稿**：Tier1 = Rust/Go/Zig 进 CI；其余语言文档明确"不支持"，不写"暂不支持"。



---


---

## 四、跨路重复发现（同一问题被多路独立命中 ⇒ 判定为真问题）

| 问题 | 命中路径 | 判定 |
|---|---|---|
| **员工侧浏览器会话不存在** | 2.1 P0-1（应用子域拿不到 Cookie）+ 2.3 P0-5（`picoaide_session` 是管理员专属） | **同一堵墙的两面，最严重**：§D2 与 §D3.1 互斥，且根因是"员工从来只有 Bearer、没有浏览器会话" |
| **SQLite 查询无法中断** | 2.2 P0-①（超时在宿主调用期间失效）+ M1（驱动无 authorizer）+ M3（未用 limit 接口） | **三方独立命中**：驱动缺的是一整组安全相关 API（authorizer / interrupt / progress handler），不是单个 |
| **usage 归因改动被低估** | 2.1 P1-7 + 2.3 P1-8（各自独立读代码得出同样的 4 步改造） | 成立，"不动 usage 表"不成立 |
| **计数器/上限无数值** | 2.2 ③④⑤⑥⑨⑪ | 成立，且与用户"边界要清晰、超限直接杀"的要求直接冲突 |
| **实例复用未定义 / 与串行矛盾** | 2.2 ⑧ + 主控核对（§6.4:574 vs D1.3:86） | 成立，文档自相矛盾 |
| **资源缓存键缺用户维度** | 2.2 ⑦ + 主控核对（F-20:397 / §6.1:504） | 成立，跨用户泄漏通道 |

**主控已回查原文确认的三处文档自相矛盾**（不是子代理误报）：
1. §6.4:574「每应用并发上限」 vs D1.3:86「每应用串行执行」
2. F-22:399「实例池预热」 vs 无状态要求（全文未写每请求新实例还是复用）
3. F-20:397「按 `(app_version, path)` 缓存」 vs 按用户差异化内容（B 会拿到 A 的缓存）


---

## 五、收敛：按根因归并（同一根因的多种表现）

把五路报告归并后，**18 条不同表现收敛到 6 个根因**。这比逐条修更重要——逐条修会漏，修根因不会。

### 根因 A：**"员工浏览器会话"这套东西不存在，而整个访问面假设它存在**
- 表现 1（2.1 P0-1）：§D2 要求 host-only Cookie ⇒ 应用子域拿不到
- 表现 2（2.3 P0-5）：`picoaide_session` 只发给管理员，**员工面只有 Bearer**
- 表现 3（2.3 P1-11）：F-05「Cookie 加固」其实是"保持"——现有 Cookie 本来就 host-only
- **结论**：这不是"改个 Cookie 属性"，而是**缺一整套员工浏览器会话机制**（F-35/F-36 的工作量被严重低估）。

### 根因 B：**选定的 Go 驱动缺一整组安全相关 API**
- 表现 1（M1 / 2.4 P0-1）：无 authorizer ⇒ §D1.2 主闸门没有实现载体
- 表现 2（2.2 P0-①）：无 interrupt/progress handler ⇒ **SQL 查询无法中断**
- 表现 3（2.4 P0-4）：`_defensive` DSN 参数**不存在** ⇒ §D1.2 的"退路"也不存在
- **结论**：缺的不是一个函数，而是**授权 + 中断 + 防御模式**三件套。可行路径已找到：`RegisterConnectionHook` + trampoline 模式（`vtab.go:26,153-159`）可自己补，但**必须自己写并测试**。

### 根因 C：**per_user 隔离选错了实现层，而正确的层是文件系统**
- 表现 1（2.4 P0-5）：owner 列可被应用自由改写（实测 LEAK）
- 表现 2（M2）：authorizer 回调**看不到写入的值** ⇒ "校验 owner"引擎层表达不出来
- 表现 3（2.4 P0-8a）：应用可建**没有 owner 列的表**，按列过滤对它无效
- **结论**：**唯一可靠的是按用户分文件 `u/<user_id>.db`**。文件系统即边界，不需要校验任何值。

### 根因 D：**"不做 SQL 解析"这个决定与安全要求冲突**
- 表现 1（2.4 P0-2）：多语句让 `db.query`/`db.exec` 区分形同虚设（实测 LEAK + DROP）
- 表现 2（2.4 P0-3）：一条 `ATTACH` 即可跨应用读（实测 LEAK）
- 表现 3（2.4 P0-7）：视图绕过按表名过滤（实测 LEAK）
- 表现 4（2.4 P0-8）：运行期 DDL 无约束（实测 ALLOWED）
- **结论**：必须做**最小词法检查**（分号须在字符串外、schemaname 白名单、语句种类白名单、禁 DDL）。**这不是完整 SQL 解析**——是可控的小词法器，成本远低于 SQL 解析器。

### 根因 E：**"资源界限清晰"只写在要求里，没落成数值与机制**
- 表现：2.2 的 ③④⑤⑥⑨⑪（内存页/编译缓存/响应体/队列/全部数值/SQL 层边界）
- 表现：2.4 P1-10（配额只有文件体积）
- 表现：wazero 必须显式 `WithCloseOnContextDone(true)`（已实测，否则超时无效）
- **结论**：建**单一 `limits.go`** 作唯一真源，runtime 配置/错误文案/作者文档/SKILL.md 全从它投影 + 构建期门禁 + 变异验证。

### 根因 F：**"语言越全越好"与运行时选型直接冲突**
- 表现 1（2.5 阻塞-1）：wazero **不支持组件模型**
- 表现 2（2.5 阻塞-2）：WASIp1 已进"历史兼容"通道，**语言面时间递减**
- 表现 3（2.5 阻塞-3）：Java/Kotlin/Python/C#/JS **只出组件或不支持**
- 表现 4（2.5 成本-4）：**编译器跑在哪，规划里完全没有**
- 表现 5（2.2 零散矛盾）：32 MiB 模块上限把带 runtime 的语言挡在门外
- **结论**：这是**前提级冲突**，必须由用户拍板（换运行时 / 接受窄语言面）。

### 附：不依赖上述根因的独立问题（需单独处置）
| 来源 | 问题 | 性质 |
|---|---|---|
| 2.1 | 应用令牌无会话绑定 ⇒ "登出即撤销"做不到 | 缺列 + 缺吊销路径 |
| 2.1 | 铸造应用令牌无审计 | 缺埋点 |
| 2.1 P0-4 | 余额闸门只判 >0 不预留 + 32 并发 ⇒ 并发放大烧钱 | **既有系统问题**，被应用场景放大 |
| 2.3 P0-1/2/3/4 | app_id 正则严 / 1 MB 体积中间件 / kind CHECK 迁移 / 版本+changelog 硬要求 | 全在"AI 第一步就撞墙" |
| 2.3 P1-8 | usage 归因需 4 步改造，2 人日低估 | 估算问题 |
| 2.3 P1-9 | RBAC 无实例级粒度，D4.1 表述误导 | 表述问题 |
| 2.3 P2-13 | router_test 无反向断言 ⇒ 体积坑抓不到 | 门禁缺口 |
| 2.5 成本-5 | 无预检接口，AI 试错占版本号 | 缺接口 |
| 2.5 成本-6 | stdout"最后一行"协议脆（已实测通道行为） | ABI 设计 |
| 2.4 P1-11 | 事务内调 `ai.chat` 造成应用级 DoS | 需禁止 + 硬超时 |


## 三、合并记录

（子代理报告回收后在此汇总，并按严重性归并、去重）
