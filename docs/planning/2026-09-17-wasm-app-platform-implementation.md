# WASM 应用平台 —— 实施与设计一致性报告

> ## ⛔ 历史归档：**已废弃，不得据此实施**
>
> 本文件记录的是 2026-09-19 之前那一版访问模型（浏览器 + 应用子域 + 换票）与旧 AI 能力（服务端
> `ai.chat`）下的实施与验收结果。**两者均已被「客户端专属」改造整体删除**（访问模型：总纲 §8.4 / §12；
> AI：总纲 §21）。文中凡出现"应用子域 / 换票 / `/app-ticket` / 会话 Cookie / 基域 / `entry_url` /
> `ai.chat` / 匿名面"的行，**不是现状、不是待办、也不得作为实施依据**；保留它们只为记录当时的偏差裁定过程。
>
> **权威文档**：`docs/planning/2026-09-19-wasm-client-only-design.md`（设计总纲，§16 是唯一权威波次表）。
> 现行契约：`docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

- 设计基线：`docs/planning/2026-09-17-wasm-app-platform.md`（**已废弃，见其文首横幅**）
- 本文件回答三个问题：**实现了什么 / 与设计哪里不一致 / 哪些仍是缺口**。
- 结论口径：`COVERED` = 有测试且做过变异验证；`PARTIAL` = 实现了但覆盖不全；
  `MISSING` = 未实现；`DEVIATION` = 实现与文档字面不同（含裁定理由）。

---

## 1. 实现清单（模块 → 文件 → 对应设计条款）

| # | 模块 | 主要文件 | 设计条款 |
|---|---|---|---|
| 1 | 数值单一真源 | `internal/wasmapp/limits/{limits,limitsspec}.go`、`limits.json`、`limits.md`、`cmd/picoaide-limits-gen` | §4 全表、§5.5「数值单一真源」 |
| 2 | 错误码与失败语义 | `internal/wasmapp/apperr/apperr.go` | §7.4、§8 |
| 3 | 应用契约（帧协议） | `internal/wasmapp/abi/abi.go` | §7.1、§7.2、§5.1 |
| 4 | 模块间接口契约 | `internal/wasmapp/capapi/capapi.go` | §5.1、§4.9 |
| 5 | wasm 静态校验 + 导入白名单 | `internal/wasmapp/wasmmod/*`、`cmd/picoaide-wasm-imports-gen` | §4.2、§5.5「导入面生成」 |
| 6 | 参考实现（教学样例） | `internal/wasmapp/refapp/*` | §9.1、§9.3 |
| 7 | 应用数据库与 SQL 闸门 | `internal/wasmapp/appdb/*` | §4.5、§5.2、§6.3、§10.1 |
| 8 | wazero 运行时（沙箱） | `internal/wasmapp/runtime/*` | §4.3、§4.4、§7、§10.2、§10.3 |
| 9 | 宿主能力面（封闭清单） | `internal/wasmapp/hostcap/*` | §5.1、§5.5、§10.6 |
| ~~10~~ | ~~AI 调用（身份注入）~~ **2026-09-19 删除** | ~~`internal/wasmapp/aichat/*`~~（整包删除，总纲 §21.3） | ~~§4.7、R36、D3.1~~ |
| 11 | 包内资源与配置 | `internal/wasmapp/{assets,appcfg}/*` | §4.2、§5.1 |
| 12 | 编译进程与隔离 | `internal/wasmapp/compile/*`、`cmd/picoaide-app-compile` | R19/R31、§4.3、§15.1 第 14 条 |
| 13 | 请求准入与排队 | `internal/wasmapp/queue/*` | §4.6、§10.3 第 32–34 项 |
| ~~14~~ | ~~匿名限流与可信代理自检~~ **2026-09-19 删除** | ~~`internal/wasmapp/anonlimit/*`~~（随匿名面一并删除，总纲 §8.4） | ~~R35、§4.6~~ |
| ~~15~~ | ~~主机名门控与安全头~~ **2026-09-19 删除** | ~~`internal/wasmapp/edge/*`~~（HostGate 子域门控删除；安全头改由调用方传入 selfOrigin，总纲 §8.4） | ~~§4.8、§15.1 第 2/3/13 条、§10.1 13a–13d~~ |
| 16 | 应用请求管线（客户端协议出口复用同一 `serveApp`） | `internal/wasmapp/appserver/*` | §6.1、§7.3、§4.6 |
| 18 | 操作面 API | `internal/wasmapp/api/*` | §8 全表、R17/R18/R23/R30/R37 |
| 19 | 调用事件与诊断 | `internal/wasmapp/{events,diag}/*` | §4.9、§10.3 |
| 20 | 运维探针与启动自检 | `internal/wasmapp/readyz/*` | §4.3 内存四笔账、§4.9 `/readyz`、§15.1 第 9 条 |
| 21 | 每请求日志缓冲 | `internal/wasmapp/logbuf/*` | §5.1 `log` |
| 22 | 标识与版本规则 | `internal/wasmapp/registry/*` | §4.1、§10.5、§5.3 |
| 23 | 数据模型与审计 app 维度 | `serverstore/wasmapps.go` + 迁移 `0069` + `audit.go`（追加） | §4.9、§5.3、§13 |
| 24 | 路由与装配 | `internal/router/router.go`（追加）、`cmd/server/{main,wasmapp}.go` | §8、§6.1 |
| 25 | AI 操作手册与作者文档 | `server/skills/app-builder/*`（2026-09-19 从 `packages/vendor/memory-evolve/skills/picoaide-app-builder/*` 迁入并改名）、`docs/wasm-app-authoring.md` | §9.3、§9.4、R40/R42 |

> 🗑️ **浏览器链路条目已删除（2026-09-19）**：原模块 17「员工浏览器会话与换票」（`internal/wasmapp/session/*` + 迁移 `0070`）与模块 16 的「应用子域」措辞已随「客户端专属」改造整体删除。
> 现行口径：应用只在桌面客户端内经 `<渠道 app 源 scheme>://<app_id>/` 打开（渠道参数化：§10/F15；official/beta 取值才是 `picoaide-app`），请求统一走 `POST /api/client/v2/apps/wasm/:app_id/request`（`BearerAuth` 必需）后复用同一 `serveApp`。
> 冻结契约见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

---

## 2. 与设计文档的**偏差**（DEVIATION，逐条给裁定理由）

> 这些不是 bug，是"文档字面与可实现语义冲突"时的取舍。每一条都写清了依据。

| # | 文档位置 | 文档字面 | 实现 | 裁定理由 |
|---|---|---|---|---|
| D1 | §4.2 vs §7.4 | §4.2 表格写超限码 `SECTION_OVERSIZE`，§7.4 表与 §10.2 第 20 项写 `SECTION_OVERRIDE_OVERSIZE` | 只用 `SECTION_OVERRIDE_OVERSIZE`（422）；`SECTION_OVERSIZE` 常量保留但不使用 | §7.4 是**失败语义唯一权威表**（文档自称），§4.2 是护栏表；以失败语义表为准 |
| D2 | §7.3 | `客户端 90 s > 服务端 ReadTimeout 60 s > 编译 60 s` | 断言为 `90 s > 60 s >= 60 s` | 60 与 60 之间不可能是严格大于；原式不可满足 |
| D3 | §7.2 | 宿主调用方法表**未列** `db.define` | ABI 方法集合 = `abi.HostMethods`（含 `db.define`，共 9 个 = §5.1 的 7 个原语，`db.tx` 展开为 3 个） | §5.1 是能力面唯一清单且明确含 `db.define`；§7.2 列表漏写 |
| D4 | §7.4 | 表里没有"未知宿主方法 / 资源路径被拒 / 资源超限 / 资源已存在"四类 | 新增 `HOST_METHOD_UNKNOWN`(400) / `ASSET_DENIED`(403) / `ASSET_OVERSIZE`(422) / `ASSET_EXISTS`(409)，在代码注释里标为"§7.4 未列出的补充码" | 第一消费者是 AI（§8 原话）⇒ 复用 `DB_DENIED`/`IMPORT_NOT_ALLOWED` 会把作者引向完全错误的排查方向 |
| D5 | §4.5 | 「一应用一 driver 实例 + 一应用一连接，不复用」 | 每应用 **两条**长持有连接（`query_only` 只读 + 读写），池上限恰好 2；跨应用绝不共享驱动/库实例 | 同节下一行同时要求「SELECT 走 `query_only(1)` 连接；写走读写连接」⇒ 两条连接是**同节内的硬要求**；"不复用"指不复用驱动/库实例 |
| D6 | §4.5 | 「返回 ≤ 5000 行 / 8 MiB，超出即截断**并报错**」 | 截断并置 `QueryResult.Truncated=true`，**不返回错误** | §7.4 硬断言「绝不把失败报成成功」的反面同样成立：截断是**成功但有损**，报成错误会让应用无法分页读取 |
| D7 | §4.5 | 单语句时长 5 s 独立于 guest 超时 | 用 `DB_DENIED`(403) + `details.reason="statement_timeout"` | §7.4 无 SQL 超时码；见 D4 的同一理由 |
| D8 | §4.5 | 禁用清单只列语句关键字（DDL/ATTACH/VACUUM/PRAGMA/`WITH RECURSIVE`） | **额外**拒绝任何 `sqlite_` / `pragma_` 前缀标识符 | **实测两个真洞**：① `UPDATE sqlite_dbpage SET data=…` 在 modernc v1.55.0 上执行成功（可改写库物理页，绕开 `db.define` 的全部结构约束并毁库）；② `SELECT file FROM pragma_database_list` 返回宿主侧库文件**绝对路径**（等价于 §4.5 明确要防的 `database_list` 探测）。禁用清单按"语句关键字"枚举必然漏掉"引擎内部虚拟表"这一整类 |
| D9 | §4.2 | 白名单"由参考实现构建期生成"（隐含=教学样例的导入面） | 生成器 dump **教学样例 ∪ WASI 面探测程序**的并集 | 实测：同一工具链下教学样例 17 条/16 名，而多调一行 `os.Stat` 的 guest 是 26 条/23 名 ⇒ 只按教学样例生成会让**任何用了一行 `os.Stat` 的合法 Go 应用**被 `IMPORT_NOT_ALLOWED` 拒（Go 是 R39 的 Tier 1 语言）。白名单的正确语义是 Go 可发出的 **WASI 面（保守超集）**，红线 5 由**零 preopen** 保证而非白名单 |
| D10 | §4.3 | 「32×64 MiB 实例 + 编译峰值 + 上传峰值 + 缓存驻留」四笔账 | 实现为 `readyz.ComputeMemoryBudget`；后两笔的倍数文档未给，取保守值并注明依据 | 文档给了构成没给倍数；数值写在 `readyz` 并注明"非应用可见上限，故不属于 limits" |
| D11 | §4.3.1-b | 缓存目录按 `wazero-v<ver>-<os>-<arch>` 分片 | 目录再套一层 `limits.CompileCacheRevision`（`r1`） | 实测：`version.GetWazeroVersion()` 在依赖方取到 **`dev`** ⇒ 目录名与条目内版本戳**都无法区分 wazero 版本**；而缓存字节会被 mmap 成机器码执行（§4.3.1-d）⇒ 升级 wazero 后旧条目被当命中 = 执行旧编译器产物。故必须有我们自己的分代标记 |
| D12 | §4.4 / §5.1 | §5.1 字面写「事务内**禁止**调用**任何其他**宿主函数」；§4.4 的依据是「（`db.tx` 内调 `ai.chat`/`log` 直接报错）｜防事务长期持锁 + 占满执行槽」 | 事务内**允许** `db.query`/`db.exec`（+ 两个出口）；**禁止** `tx_begin`（嵌套）、`log`、`assets.read`、`db.define`、探针 `abi.ping`（原禁令里的 `ai.chat` 随总纲 §21 删除，该能力已不存在）。允许集**唯一真源** = `abi.TxAllowedWhileInTx`，`hostcap` 调用它 | §4.4 给的理由只覆盖"会长时间阻塞/占槽"的能力，不覆盖同一条连接上的快 SQL；按 §5.1 字面实现会让 **`db.tx` 完全不可用**（只能 begin→立刻 commit）—— 这正是初版实现的实际后果，被独立审计以 P0 确认（FIX-1）。嵌套事务仍禁（会让"每应用一连接 + ~~并发恒 1~~ **该数值已于 2026-09-19 改为 4**"的旧前提失效，5 s 硬超时归属不明；现行并发口径见 `docs/decisions/2026-09-19-wasm-app-concurrency-default.md`） |
| D13 | §4.8 | 应用响应头白名单含 `content-disposition`（仅 `inline`） | 白名单外的头一律剥离；`Set-Cookie` 永不透出（Cookie 由宿主独占） | §4.8 同句已写「Cookie 由宿主独占」 |
| D14 | §5.2 | 「应用看不到 `_row_id`（提到即拒）」 | 提到即拒 **+ `db.query` 结果投影层剥列** | 只靠"提到即拒"挡不住 `SELECT *`；剥列只在结果投影层做，不影响 `INSERT INTO b SELECT * FROM a` 的列数语义（那是 `db.exec` 路径） |
| D15 | §4.2 | 「`validate` 含一次真实编译 + 合成帧干跑」 | 干跑用 `abi.ping` 探针方法；探针**不属于能力面**（`abi.ProbeMethods`，排除在 §5.5 清单一致性门禁之外） | 干跑需要一个"活着"的应答判断 guest 是否真跑起来；把探针塞进 §5.1 清单会让"封闭清单"失真 |
| ~~D16~~ | ~~§4.9~~ | ~~`usage` 表不改、不做应用维度归因（R36）~~ | **2026-09-19 作废**（总纲 §21.4）：服务端 `ai.chat` 已删除，本行描述的"复用 `api_tokens` + `CreateToken` 铸造应用 AI 令牌"整条不再存在；`usage` 反而**新增应用维度**用于管理端 AI 用量面板 | 已废除（保留作历史裁定记录） |
| D17 | §4.1 | `apps.channel` "CHECK 放开"（未说取值） | 新增独立值 `wasm`（`serverstore.AppChannelWasm`） | 应用的分发面是客户端内的应用协议，与 market/org 正交；既有按 channel 过滤的查询全部显式传 `market|org` ⇒ 天然排除 wasm 行，不会被当成技能/智能体展示 |
| D18 | §11 第 3 项 | "只放开 CHECK，不新增标识列" | 另加**状态投影列**（purpose/data_sensitivity/config_json/~~visible~~/current_release_id/frozen_at/deleted_at）+ `app_releases.config_json/assets_dir`。⚠️ **勘误（2026-09-18）**：`apps.visible` 已在第三轮（迁移 **0071**）**删除** —— 访问模式收敛为单一 `access` 枚举，可见性布尔不再存在（见 §6.8）；制品字节复用既有 `app_releases.archive` | 任务所需的字段**没有列就无处存**；这些都不是"标识列"（域名标签仍是 `app_id`，唯一性仍由 `(kind,app_id)` 主键保证）。复用 `archive` 让审核不变量「approved 必须有归档字节」对 wasm 自动成立 |

### 2.1 门禁本身的已知弱点（审计发现，已记录待改进）

| # | 弱点 | 影响 | 现状 |
|---|---|---|---|
| G1 | `limits` 数值门禁的"数字+单位"正则会把 **HTTP 状态码**误判成上限（另一代理新写的「404/403 页面」被判成「403 页」） | 作者文档措辞被误伤 | 已改措辞规避；**判据一个字未放宽**。建议单位词前置加 `(?<![0-9/])` |
| G2 | 数值门禁只校验"同量纲存在这个数"，不校验"对应哪条上限"（SKILL 里 4 KiB→8 KiB 全绿，因为 8192 恰是另一条上限） | 文档数字可能指向错误的上限 | 未修（报告已记） |
| G3 | 无路径参数门禁的两处枚举盲区（嵌套类型 / abi 包第二个文件） | 可能漏掉新增的路径语义参数 | 已修（FIX-8：`ParseDir` 全包 + 递归展开 + 文件集合对拍） |
| G4 | §5.5「能力清单一致性」在"多一个"方向曾**恒真** | 影子方法不会让门禁红 | 已修（FIX-2：枚举 `table` 键 + 双向对拍） |

---

## 3. §10 验证矩阵覆盖表

`COVERED` = 有**真实执行**的测试且做过变异验证（拆掉闸门 ⇒ 用例红）；`PARTIAL` = 有实现但覆盖不全；
`MISSING` = 未实现；`N/A` = 设计明确声明"不是边界"。

### 3.1 端到端验收（浏览器链路，已删除）

> 🗑️ **整节删除（2026-09-19）**：本节原有的端到端验收（`temp/wasm-e2e-run.sh`，真 PG + 真服务端 + 真 wasm + 真 https 子域，
> 含未登录 302 换票、`/app-ticket` 兑换、会话 Cookie 断言、`access=public` 匿名 200 等断言）以已删除的浏览器访问模型为前提。
> 现行验收判据 = 真客户端协议 handler + 真 wasm（契约 §6 的 W2/W5 波次）；冻结契约见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

### 3.2 §10.1 越权（红线 1/2）

| 项 | 状态 | 证据 |
|---|---|---|
| 1 平台表（PG）不可达 | COVERED | 应用进程只有 SQLite；架构性隔离 + appdb 测试 |
| 2 ATTACH 别的应用库 | COVERED | `SQLITE_LIMIT_ATTACHED=0` 金丝雀 + 目标文件不生成 |
| 3 跨应用读 | COVERED | 同上 + 文件边界 |
| 4 多语句 | COVERED | 自写词法扫描 + 表驱动绕过 payload |
| 5/6/9 DDL（CREATE/DROP/ALTER/VIEW） | COVERED | 语句种类白名单 |
| 7 VACUUM INTO | COVERED | 与 ATTACH 同闸门（`LIMIT_ATTACHED`） |
| 8 PRAGMA | COVERED | PRAGMA 关键字 + `pragma_*` 标识符双拒 |
| 10 应用内跨用户读 | N/A | R15 明确声明不是边界 |
| 11 应用 A 读 B 的库 | COVERED | 文件边界 + ATTACH 否决 |
| 12 连接状态不粘连 | COVERED | 两条固定连接 + 只读连接 `query_only` |
| 13 新连接仍带全套限额 | COVERED | 连接钩子 + 金丝雀（max_page_count 读回 + ATTACH 被拒） |
| ~~13a–13d 子域主站路由不可达~~ **已废弃** | ~~COVERED~~ | **对象已随 W4 删除**（总纲 §8.4）：`internal/router/subdomain_test.go` 与本行引用的端到端 14 条路径断言**都将被删除**，本行不得再作为覆盖证据引用。现行判据 = 总纲 §13（I1「公网无应用 origin ⇒ 404 且不返回应用内容」+ 部署级「未配置任何基域变量时客户端内打开应用仍成功」） |
| **额外（文档未覆盖）** | COVERED | `UPDATE sqlite_dbpage` 与 `SELECT file FROM pragma_database_list` 两个真洞（B6/B7）已封 |

### 3.3 §10.2 沙箱逃逸（红线 4/5）

| 项 | 状态 | 证据 |
|---|---|---|
| 14/15 文件操作 DENIED | COVERED | 零 preopen；实测 errno=**EBADF(8)**（不是文档写的 ENOSYS —— 见 D-口径） |
| 16 任意出站不可达 | COVERED（**结论仍成立，措辞已订正**） | preview1 无 `sock_*`；~~宿主零网络能力~~ ⇒ **正确说法 = 沙箱内无出站 `sock_*`，应用不能主动发起 `XHR`/`fetch` 型网络请求**（⚠️ **不得对外宣称"不能联网"**：CSP 不管顶层导航与弹窗，总纲 §6 / RED-9）；导入面白名单反向断言 |
| 17 导入面 env.*/js.* | COVERED | 白名单只允许 `wasi_snapshot_preview1` + 安全边界反向断言 |
| 18 导入签名不符 | COVERED | `IMPORT_SIGNATURE_MISMATCH` + 干跑（编译期不报，实测） |
| 19 组件模型 | COVERED | layer 字段检测 ⇒ `COMPONENT_MODEL_UNSUPPORTED` |
| 20 自定义段超 4 MiB | COVERED | `SECTION_OVERRIDE_OVERSIZE`（按 §7.4 用名） |
| 21 随机源两次不同 | COVERED | 实测默认值是固定种子 42（`dfd79b4d…` 两实例一致）；注入 `rand.Reader` 后互不相同 |
| 22 真实时钟 | COVERED | 与宿主差 ≤3 s；拆掉 `WithSysWalltime` 后读到 2022-01-01 |
| 23 args/env 为空 | COVERED | `[]`/`[]` |

### 3.4 §10.3 资源耗尽（红线 6）

| 项 | 状态 | 证据 |
|---|---|---|
| 24 死循环 10 s 超时 | COVERED | 预算 700 ms → 实测 701.8 ms；纯 wasm 500 ms → 500.8 ms；卡 fd_read 600 ms → 600.1 ms |
| 25 无限递归 | COVERED | Go 走 `proc_exit(2)`；真正 wasm 栈溢出用手写模块 ⇒ `RUNTIME_TRAP`（92 ms）；宿主存活 |
| 26 宿主不传 ctx | COVERED | 阻塞 1.5 s + 预算 200 ms ⇒ 213 ms 返回 `HOST_CALL_OVER_BUDGET`（去掉硬闸变 3.2 s） |
| 27 内存 grow 超限 | COVERED（口径已修正） | 声明式超限在**编译期**被拒；Go 应用只能走 `RUNTIME_GUEST_EXIT(2)`（见 D-口径） |
| 28 Go OOM | COVERED | `RUNTIME_GUEST_EXIT(2)` + `GuestExitCode=2`，**不是** `RUNTIME_NO_RESPONSE` |
| 29 输出/响应超限 | COVERED | 单行 1 MiB ⇒ `RUNTIME_OUTPUT_OVERRUN`；响应体 8 MiB 截断 |
| 30 数据库写满 | COVERED | `SQLITE_FULL` ⇒ `DB_LIMIT`(507)（用注入的小上限测） |
| 31 无界递归 CTE | COVERED | 实测 **5.00 s** 准时中断（`context.DeadlineExceeded`） |
| 32 同应用 100 并发 | COVERED | 队列 32，其余 429 + Retry-After |
| 33 单用户占满队列 | COVERED | 每用户同应用排队上限 4 |
| 34 单用户 20 个应用 | COVERED | 每用户全局在跑 4（含跨应用唤醒） |
| 35 缓存回收 | COVERED | 体积 + 条目双上限，按 mtime 从旧到新 |
| 36 上传 30 次/小时 + 并发 1 | COVERED | 第 31 次 429；失败路径也释放占位 |
| 37 垃圾包连续上传 | PARTIAL | 单次编译 CPU/缓存受限已测；"连续填满"未做端到端压测 |
| ~~38 ai.chat 死循环刷额度~~ **已废弃** | ~~PARTIAL~~ | **对象已随 W4 删除**（总纲 §21）：服务端无 `ai.chat`。替代判据 = 总纲 §21.6（客户端 AI 链路的余额闸门 + 页面关闭即取消） |
| ~~38b 余额不足~~ **已废弃** | ~~COVERED~~ | **对象已随 W4 删除**（总纲 §21）：402 `AI_BALANCE_INSUFFICIENT` 不再由应用请求管线返回；现行错误码 = 客户端 AI 链路的 `ai_balance_insufficient` |
| ~~38c 应用侧不显示额度~~ | **仍成立** | 现行口径不变：catalog/portal 与应用页面都不含额度字段（额度只在桌面客户端可见） |

### 3.5 §10.4 会话、身份与准入

| 项 | 状态 | 证据 |
|---|---|---|
| 43 应用凭证不能调 `/api/client/v2/*` | COVERED（**结论仍成立**） | 真跑 `BearerAuth`：~~把两种 Cookie 当 Bearer 发全部 401~~ **已废弃（对象已删除，W4）**——那两种 Cookie 是员工会话 Cookie，随浏览器链路删除；现行等价判据 = 无 bearer ⇒ 401（总纲 §13 I2） |
| 44 跨应用写 | COVERED（**结论仍成立**） | 端到端 403（有效）+ ~~前缀相似域拒~~ **已废弃（对象已删除，W4）**——前缀相似域判据属已删除的 HostGate；现行等价判据 = 跨源写要求 `Origin == <app scheme>://<app_id>`（总纲 §8.3 / §13 I3） |
| 45 伪造帧内 user | COVERED | 帧由宿主构造；应用无法注入 |
| 46 登出后旧令牌立即失效 | COVERED（**结论仍成立**） | 内存令牌回收钩子（有效）+ ~~SQL 层级联（`employee_sessions` 已 DROP）+ 端到端 302（换票重定向）~~ **已废弃（对象已删除，W4）**；现行等价判据 = 撤销后应用请求 401（`serverauth.BearerAuth` 承担，总纲 §13 I2） |
| 51 未授权员工打开应用 | N/A | R24 明确声明不是边界（由应用返回 403） |

> 🗑️ **换票 / Cookie / 匿名条目已删除（2026-09-19）**：原第 39/40/41 项（未登录 302 换票、ticket 重放与跨应用、第三方触发换票）、
> 第 42/49 项（Cookie 属性、非 https 不签发 Cookie）与第 47/48 项（匿名响应体、匿名限流桶）都以已删除的浏览器访问模型为前提。
> 现行口径：一律要求登录（无匿名）、自定义协议下无 cookie，准入由 bearer 身份投影判定 —— 见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §4.4。

### 3.6 §10.5 发布链路

COVERED：52 / 53 / 53b / 53c / 53d / 54 / 55 / 56 / 57 / 56b / 56c / 56d / 56f / 59 / 60
（含"失败发布不占版本号"= §10.5 第 59 项、"员工 B 更新员工 A 的应用被拒"= 第 60 项）。
PARTIAL：56e（目录侧覆盖）、58（服务端不变量覆盖；客户端分片在客户端仓库）、
61（转移归属/冻结的手动出路已就位；离职钩子级联仍是 §11 第 17 项缺口）。

### 3.7 §10.6 受控能力面

| 项 | 状态 | 证据 |
|---|---|---|
| 62 注册不在清单里的宿主函数 | COVERED | `RegisteredMethods()` 与 `abi.HostMethods` 逐项相等门禁 |
| 63 手写导入白名单 | COVERED | 生成器真编译两份参考实现后 dump 并集；手改一条 ⇒ 门禁红 + `-check` 非零退出 |
| 64 非法表名/第 17 张表/第 17 列 | COVERED | `db.define` 校验 |
| 65 列类型不在枚举内 | COVERED | 封闭枚举 |
| 66 指定主键/索引/触发器 | COVERED | 结构里没有这些字段；`_row_id` 列名拒绝 |
| 67 SQL 提到 `_row_id` | COVERED | 提到即拒（含引号/别名/表达式形态）+ 结果投影剥列 |
| 68 调不存在的宿主函数 | COVERED | `HOST_METHOD_UNKNOWN`(400) + 可用清单 hints |

---

## 4. §11 缺口清单状态

| 项 | 状态 | 说明 |
|---|---|---|
| 1 导入白名单由参考实现生成 | **COVERED** | 生成器真编译 `refapp` ∪ `refapp/wasiprobe`（30 条）；并修正了"白名单恰好等于最小样例"的 P0（D9） |
| 2 帧格式 + 应用配置文件落到示例 | **COVERED** | `abi` + SKILL `examples/go`（真编译、真跑通帧协议）+ `picoaide.app.json` schema |
| 3 迁移一件 | **COVERED** | `0069_wasm_apps.sql`（kind/channel 放开 + 状态投影列 + 审计 app_id/哈希链版本化 + `wasm_call_events`） |
| 4 `kind` 影响面审计 | **COVERED** | `appstore/admin.go` 白名单放开（§11 明确点名）+ **两个未知值回落点都加了 wasm 分支**（`channelLabel` / `kindLabelOf`） |
| 8 编译进程隔离 | **PARTIAL** | bwrap 读白名单 + 私有 netns + RLIMIT_AS/CPU + env 白名单**已落地并有正反用例**；**seccomp 未做**（bwrap 未暴露该能力；建议部署面叠加 cgroup） |
| 9 内存四笔账 + 启动自检 | **COVERED** | `readyz.ComputeMemoryBudget` + 启动路径 `log.Fatalf` |
| 10 客户端创作链路 + 应用中心页 | **PARTIAL**（第二轮补齐） | 已落地：应用中心页（真机 CDP 验证可达）、本地路由与**发布编排**（90 s 预算 / >8 MiB 自动分片 + 续传 / 错误信封逐字段透传）、服务端**分片上传与续传**（5 端点，与一次性上传行为等价）。**仍缺**（第二轮时）：**AI 的发布路径**（`wasm_app_*` 宿主工具面未落地，见 §6.5b）—— 面板内发布入口已在 H6 补齐并有真机证据（见 §6.7）。⚠️ **2026-09-18 第三轮已补齐**：3 个宿主工具落地且与本地路由共用同一份编排（见 §6.8） |
| 11 缓存跨进程收益与占用 | **COVERED** | 冷 1099 ms → 热 34 ms（32.3×）；条目 8.37 MB（3.63× 模块）；**新增分代目录**（D11）解决 wazero 版本不可辨 |
| 12 32 MiB 模块 60 s 内编译 | **UNVERIFIED** | 实测最大 2.31 MiB（1099 ms）；线性外推 ≈15 s，但未实测 |
| 13 64 MiB 实例下 8 MiB 结果余量 | **COVERED** | 64 MiB 上限 + 24 MiB 堆 ⇒ peak 27.5 MiB |
| 14 `db.define` 幂等与并发 | **COVERED**（**并发前提已过时**，见右列） | 幂等 + 加列 + 上限（有效）；~~并发由"每应用并发恒 1"保证~~ **该数值已过时**：2026-09-19 起 `app_concurrency` 默认为 **4**（读并发、写仍串行），见 `docs/decisions/2026-09-19-wasm-app-concurrency-default.md`；`db.define` 的幂等结论不受影响 |
| 16 版本 GC + 制品配额 | **PARTIAL** | DAO 就绪（`PruneWasmReleases` / `CountUserArtifactBytes`）+ 发布后自动 prune；**无后台清理任务**（§11 原文即列为缺口） |
| 17 离职/转移归属 | **PARTIAL** | 转移归属已放开 kind 并可用（管理面）；**离职钩子级联 `apps` 未做** |
| 18 可接手材料（源码/重建说明） | **MISSING** | 仍只有二进制 + 用途/负责人字段 |
| 19 备份与恢复口径 | **MISSING** | 未做逐库 `VACUUM INTO` 与冷备口径 |
| 21 可观测 `/readyz` + 低水位拒绝发布 | **COVERED** | `/readyz` 已注册；`AllowPublish` 是 fail-closed 闸门（发布前调用）|
| 22 余额预留扩到既有桌面路径 | **MISSING** | 未做（设计说"一次做掉更省"，属平台既有缺口） |
| 23 证据探针入库 | **PARTIAL** | `docs/evidence/2026-09-17-wasm-app-platform/` 原有 3 个；本轮新增的探针在 `temp/audit-wasm/*`（未入库） |
| 24 缓存目录信任边界拍板 | **PARTIAL** | 已按"认账 + 空钩子"处理（`compile/doc.go` 的认账说明 + `VerifyCacheEntry` 占位），**未加校验方案** —— 仍需拍板 |

> 🗑️ **浏览器链路缺口项已删除（2026-09-19）**：原第 5/6/7 项（host 门控与子域路由树、换票端点改造、匿名限流重做）、
> 第 15 项（子域 Origin 校验覆盖率）与第 20 项（部署文档的应用子域章节 + 通配证书指引）都以已删除的浏览器访问链路为前提。
> 现行端点/准入与部署前置（不再需要通配域名、通配证书、Caddy 通配站点块）见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md` §4、§5。

---

## 5. 实施中发现并修复的**真实缺陷**

> 本节只列**实现过程中**（模块之间的交叉审计）发现的缺陷，按发现顺序，每条都有复现与变异证据。
> **独立审计轮**（5 个身份）发现的缺陷（P0×3 / P1×10 / P2×30+）在 §6.2 逐条列出、§6.3/§6.4 给出修复与复核 ——
> 那一轮的发现密度与严重度都高于本节，其中三条 P0（`db.tx` 完全不可用、事务超时永久打死应用、
> 导入白名单缺 4 条导致用 `html/template` 的合法应用被拒）**都不是靠模块自测能发现的**，
> 这正是"独立身份审计 + 变异验证"这套流程的价值所在。

| # | 缺陷 | 严重度 | 发现者 | 状态 |
|---|---|---|---|---|
| B1 | `abi.WriteFrame` 用 `strconv.AppendInt(hdr[1:1], …)` 导致 RS 魔数**从未写出**（实测输出 `"7\n{…}"`，首字节 0x37）。宿主→guest 的请求帧与 guest→宿主的一切帧都走这条 ⇒ 整条链路在集成时才炸 | **P0** | 模块 A 交叉审计 | 已修 + `TestFrameRoundTrip`（WriteFrame→ReadFrame 往返 + 与 EncodeFrame 逐字节一致）；变异验证：改回偏移切片 ⇒ 报 `首字节=0x37` |
| B2 | `queue.Scheduler` 只在**被释放的那个应用**的等待队列里唤醒 ⇒ 用户占满自己的 4 个全局槽后，其第 5 个应用的排队请求**永远不会被唤醒** | P1 | 主控（自身实现自审） | 已修（`pumpAllLocked` 跨应用唤醒）+ `TestHeadOfLineSkipped` |
| ~~B3~~ | ~~`anonlimit` 每 IP 桶数上限差一位（插入后可达 `MaxIPBuckets+1`）~~ **已废弃（对象随 W4 删除）** | P2 | 主控 | ~~已修 + `TestIPBucketsBounded`~~ 随包删除，不再作为现行证据 |
| B4 | `abi.TxIsolationMethod` 把 `tx_begin` 也算作"事务控制" ⇒ 照它实现等于**允许嵌套事务** | P1 | 模块 D 审计 | 已修（拆为 `TxControlMethod` / `TxAllowedWhileInTx`，后者只有 commit/rollback） |
| B5 | `abi.AssetsReadResult` 的 `Text`/`Base64` 都是 `omitempty` ⇒ 零字节资源与"内容为空串"在 JSON 上无法区分 | P2 | 模块 D 审计 | 已修（新增必填判别字段 `Encoding`：text/base64/empty） |
| B6 | `UPDATE sqlite_dbpage SET data=…` 在 modernc v1.55.0 上**执行成功** ⇒ 应用可改写库物理页，绕开 `db.define` 的全部结构约束（表/列上限、保留列、类型）并写坏库 | **P0** | 模块 B 探针 | 已修（`sqlite_` 前缀标识符一律拒）+ 变异验证 |
| B7 | `SELECT file FROM pragma_database_list` 返回宿主侧库文件**绝对路径** | **P0** | 模块 B 探针 | 已修（`pragma_` 前缀标识符一律拒） |
| B8 | `compile` 的 bwrap 包装在**常驻子进程**形态下必然失败（从 argv 反解 cache_dir，而常驻 argv 里没有它）⇒ `IsolationAuto` 在本机直接报错 | P1 | 模块 E 自审 | 已修（`-cache-dir` 显式 flag + 子进程侧"请求 cache_dir 必须等于启动声明值"自检，fail-closed） |
| B9 | `compile` 超时清理时 `kill` 死锁 5 s（`cmd.Wait()` goroutine 要抢 `p.mu`，而 `killLocked` 持锁等 `exitCh`） | P1 | 模块 E 自审 | 已修（`close(exitCh)` 建 happens-before） |
| B10 | `compile` 把 OOM 误报成 `INTERNAL`（读 EOF 与 exitCh 关闭竞态） | P2 | 模块 E 自审 | 已修（`waitExited(500ms)` 宽限后归类） |
| B11 | 运行时手写 wasm 夹具不合法（`_start` 带返回值 ⇒ `too many results`）；自递归夹具 `call $self` 的 i32 未 `drop` | P1（门禁红） | 模块 C 自审 | 已修 + 夹具格式说明写进测试文件头 |
| B12 | `runtime` 的默认随机源实测确认是**固定种子 42 的确定性伪随机**（两个独立 Runtime 的 guest 首读完全相同 `dfd79b4d76429b617a0c9f9f0d3ba55b`，与设计文档记录逐字节吻合） | 设计已覆盖（§4.3 ⚠️） | 模块 C | 已按 §4.3 注入 `rand.Reader`；变异 M1 复现危险默认值 |
| B13 | `SELECT *` 会把 `_row_id` 返回给应用（违反 §5.2「应用看不到」） | P1 | 模块 B 审计 | 见 D14（结果投影层剥列） |
| B14 | `appserver` 每请求 `appdb.Open` + `Close`（实测 1.7–3.2 ms / 次，同应用并发可出现 4 条连接），不符合 §4.5「一应用一 driver 实例」 | P2 | 模块 B 审计 | 见 §6 修复记录 |
| B15 | 编译缓存目录**无法区分 wazero 版本**（`GetWazeroVersion()` 取到 `dev`），而缓存字节会被 mmap 执行 ⇒ 升级 wazero 后旧条目可能被当命中 | P1 | 模块 C 实测 | 见 D11（`limits.CompileCacheRevision` 分代） |

---

## 6. 审计与修复记录

### 6.1 审计编制

**5 个独立身份审计员**（各自独立会话、独立判据、**只读**、零产品代码改动；变异验证走 `go test -overlay` 虚拟挂载）：

| 身份 | 范围 | 结论 |
|---|---|---|
| `sandbox` | runtime / wasmmod / refapp | 见 §6.2 |
| `sqldb` | appdb | **P0=2 / P1=3 / P2=6 / NOT_A_BUG=7** |
| `identity` | ~~session~~ / hostcap / ~~aichat~~ / ~~edge~~（三者**均随 W4 删除**，总纲 §8.4 / §21.3）/ 现行 = `appserver` + `api` + `hostcap` | 见 §6.2 |
| `resource` | queue / ~~anonlimit~~（**随 W4 删除**）/ compile / events / readyz | **P0=0 / P1=2 / P2=12 / NOT_A_BUG=5** |
| `caps` | hostcap / abi / SKILL / 文档 | **P0=0 / P1=2 / P2=7 / NOT_A_BUG=10** |

报告落盘在 `temp/audit-wasm/<身份>/REPORT.md`（含逐条复现命令与变异脚本）。
共同纪律写在 `temp/wasm-brief/AUDIT-CHECKLIST.md`：只读不改；每条发现必须给「设计条款 + 文件:符号 +
可复现方式 + 实际/期望 + 变异验证」；区分 `CONFIRMED` / `UNVERIFIED` / `NOT_A_BUG`；
**不许把设计取舍报成 bug**（R15 应用内跨用户读、R24 未授权访问、R36 无应用级额度都是设计声明）。

### 6.2 审计结论

**`sqldb`（数据隔离）**
- **P0-1** 事务内 `db.query`/`db.exec` 被一概拒绝 ⇒ **`db.tx` 原语完全不可用**（同一闸门的 hint 自己写着"db.tx 内只能做数据库读写"）。放大因素：refapp 演示的事务体是空的 ⇒ 所有门禁都抓不到。
- **P0-2** 事务超时的 reason 生产者（`transaction_timeout`）与消费者（`tx_timeout`）**不一致**，且 `appdb` 的 `poisoned` 标记 `Close()` 也不清 ⇒ **一次事务超时把该应用永久打死直到进程重启**。
- **P1-1** `rowid` / `_rowid_` / `oid` 是保留列的未声明别名 ⇒ 闸门与结果投影**双绕过**（可读回平台主键、可改写 `_row_id` 并推进 `sqlite_sequence`）。
- **P1-2** 嵌套 `SELECT … FROM (WITH RECURSIVE …)` 过闸门（只挡首关键字）。
- **P1-3** 连接钩子只设 `max_page_count`，**新连接的 12 个 `SQLITE_LIMIT_*` 全是驱动默认**（实测 ATTACH 成功并生成目标文件）⇒ §15.1 第 4 条 / §10.1 第 13 项不成立。今天在池约束下不可达（属纵深缺口），但**实现者的单测把缺口断言成了预期**。
- **P2**：`SELECT * FROM dbstat` 可达（非前缀的同族引擎自省虚表 ⇒ **按前缀拦 ≠ 按能力拦**）、`load_extension` 过闸门、`db.define` 列上限两条路径不一致（一次建表 16 列 / 逐次加列只到 14）、`SQLITE_CONSTRAINT` 扩展码分支不可达、变异对照表引用不存在的用例名。
- **重要机理性结论**：116 条 payload **没有任何一条到达宿主副作用或别的应用/平台数据**；**§15.2「被放弃的查询仍在跑」在本机 modernc v1.55.0 上不可复现**（三重观测：goroutine 回基线、CPU +0 ms、无残留读锁、连接立即可复用）⇒ 污染标记当前是**纯可用性代价**，设计文档该条需按引用纪律更新。

**`caps`（能力面封闭性）**
- **P1-1** §5.5「能力清单一致性」门禁在"**多一个**"方向**恒真**：`RegisteredMethods()` 用 `abi.HostMethods` 过滤 `table` ⇒ 多出的注册项结构上不可见；变异（往 `table` 加 `secret.read`）后**整棵 25 包全绿**。今天无能力泄漏（runtime 另有一道 `abi.HostMethods` 白名单），但"多一个即测试红"这条判据**不成立**。
- **P1-2** `abi.AssetsReadResult.Encoding` 自称"必填判别字段"却**从未被填充**（wire 上恒为 `""`）⇒ 零字节资源与空串文本资源的 JSON **逐字节相同**（正是该字段要消灭的歧义）。
- **P2**：无路径参数门禁两处枚举盲区（嵌套类型 / abi 包第二个文件）、数值门禁只比"同量纲存在"（SKILL 里 4 KiB→8 KiB 全绿，因为 8192 恰是另一条上限）、`ASSET_*` 三码定义了零调用、`assets.Open` 接受抽取目录本身是软链（实测读到宿主 `/etc/passwd`，**当前攻击者模型下不可达**）、事务内 `abi.ping` 可应答、`abi.TxControlMethod`/`TxAllowedWhileInTx` 无调用者（脚枪）。
- **已核实为真且真会红**：limits/SKILL 六条门禁（四种变异全红）、`assets.read` 32 条 payload 无穿越、~~匿名语义~~（**已废弃：匿名面随 W4 删除**）、log 限额与 `Dropped`、appcfg 的 R25/R26/R38（**全树无查 users 表路径**）、SKILL 示例真编译 3.65 MiB 且导入面全命中白名单、事务严格集合（把 `tx_begin` 放回 ⇒ 用例红）。

**`identity`（身份与凭证）**
- **P1-1 `edge.SelfOrigin` 把端口剥掉**（浏览器链路专有：该判据已随该链路删除）。**教训保留**：源判据的归一化必须与请求里实际出现的 `Origin` 逐字符相等（默认端口省略、非默认端口保留），不能"截到源再比"、也不能自作主张剥掉或补上端口 —— 现行 Origin 判据见契约 §4.3（`Origin: <渠道 app 源 scheme>://<app_id>`，渠道参数化：§10/F15，由 handler 合成，服务端按 `app_id` 推导自源）。
- **P1-2 平台保留资源被静态面公开直出**：`GET /picoaide.app.json` **无需任何应用侧授权即可 200**，body 含完整 `whitelist` —— 与 §10.5 第 56d 项"平台不校验名单以免变成账号枚举接口"、R24（准入由应用判）与 R26（不提供员工目录）的意图冲突，且作者文档零提示。
- **红线 3 其余各条全部实测通过（每条带反向对照）**：帧内 `user` 宿主构造（guest 伪造被拒）、~~ai.chat 令牌不进帧/响应体/响应头/平台日志、ai.chat 错误映射~~（**已废弃：对象随 W4 删除**，总纲 §21）、~~登出吊销链端到端~~（**已废弃：`session` 随 W4 删除**）、15 条跨应用写 Origin 表（**现行：Origin 由协议 handler 合成，见总纲 §8.3**）。
- **登录失败预算两入口共享**已被独立验证（双向各打满 3 次后另一端立刻 429）⇒ 集成期补的那条修复**有效**。

> 🗑️ **换票 / Cookie / 匿名条目已删除（2026-09-19）**：原 P2 的换票端点三项（`app` 形态不校验、`HostGate.ExtraMainHosts` 死配置、`TicketSubmit` 缺 `secureRequest`）
> 与"`document.cookie` 为空 / 反代 `X-Forwarded-Proto` 下换出会话"两条残留风险，都以已删除的浏览器访问链路为前提。
> 现行契约见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md`（§4.3 Origin 判据、§4.4 身份与准入）。

**`sandbox`（沙箱运行时）**
- **P0-1 导入白名单仍缺 4 个符号 ⇒ 用 `html/template`/`text/template` 渲染页面的合法 Go 应用被 `IMPORT_NOT_ALLOWED` 拒**：实测 `template.Execute` 会导入 `sock_accept`/`sock_shutdown`（Go 运行时的 fd 操作路径），`(*os.File).ReadAt/WriteAt` 会导入 `fd_pread`/`fd_pwrite`；而"渲染 HTML 页面"恰是本平台最主要的用法（R8）。Skill 与作者文档**从未提示** template 会中招。
- **P1-1 `WithNanosleep(真实实现)` 没有仓库门禁**：拆掉后仓库自带用例**全绿**——因为 Go 的 wasip1 等待是**忙等循环**，墙钟不变（~305ms），**CPU 从 5ms 涨到 ~300ms** ⇒ 判据必须是 CPU 时间，任何耗时断言都测不出。
- **P1-2 红线 4/5 的论证与实现不符**：① 零 preopen 的真实 errno **不是 `ENOSYS`**（实测 EBADF(8)/EPERM(63)/ENOTDIR(54)，`ENOSYS`/`ENOTCAPABLE` 一次都没出现）；② preview1 宿主模块**导出 46 个函数，含 `sock_accept`/`sock_recv`/`sock_send`/`sock_shutdown`**（只是没有 `sock_open`/`bind`/`listen`/`connect`）⇒ "preview1 根本没有 socket"这句话是错的。红线 4 真正成立的理由是"**没有任何途径得到一个 socket fd**"（`syscall.Socket` → Not implemented；`sock_accept(0..10)` 全 EBADF）。
- **P1-3 `CompileCacheRevision` 解决的不是它声称的问题**：**"wazero 版本返回 dev"只对 `go test` 二进制成立**；`go build` 出来的 main 二进制里 `debug.ReadBuildInfo().Deps` 有 wazero、`GetWazeroVersion()` 返回 `v1.12.0` ⇒ wazero 自己就会按版本分片，升级后旧条目本就不会命中。该常量于是只是"需要人记得的保险"，而仓库**没有任何门禁**在 wazero 版本变化时要求改它。
- **P2**：收到**合法最终响应帧**但 guest 未在预算内退出 ⇒ 响应被丢弃、请求报 504 且占满预算（文档没规定这种情形）；旧分代缓存目录不被回收（回收只看当前 revision）；`runtime.PruneCompilationCache` 生产零调用点（与 `compile.ReclaimCache` 重复实现）。
- **已核实为真**：226 条自写断言通过；独立 wasm 解析器复核"白名单 == 两个来源的并集"双向零差异；零 preopen 的护栏本身**有**门禁（拆掉 `WithFSConfig` 即全红）。

**`resource`（资源边界）**
- **P1-1** `readyz.AllowPublish` **零生产调用方** ⇒ §4.9「低水位拒绝发布（fail-closed）」只写在注释里。
- **P1-2** `events.Sink.Cleanup` **零生产调用方** ⇒ §4.9/§5.3 的「7 天保留」未生效，`wasm_call_events` 是平台**唯一的无界磁盘增长路径**。
- **P2**：`PICOAI_COMPILE_ISOLATION=require` 与三处文档"拒绝启动"不符（实际只禁用发布链路）；编译器缺失时 `/readyz` 与健康态**逐字段同形**（降级不可见）；`queue` 的 app 表只增不减 + 每次 Release 全表遍历（20000 应用时 **516–811 µs/请求且持全局锁**）；匿名桶满后每个新 IP 做两次 O(8192) 扫描（**865 µs/次**）~~匿名桶满后每个新 IP 做两次 O(8192) 扫描（**865 µs/次**）~~（**已废弃：匿名桶随 W4 删除**）；`main.go` 硬编码 `ReadTimeout 60s`（未用 `limits.ServerReadTimeout`）；内存四笔账自检**无条件**执行（原要求 MemAvailable ≥ 3.56 GiB ⇒ 4 GiB 容器起不来；与子域无关，子域已删除）；调用事件计数无出口。
- **已核实为真**：跨应用唤醒成立、等待者不泄漏（取消 1000 个后计数归零且占位额度真的归还）、bwrap 隔离**真的生效**（差分对照：唯一可写面写成功 / 只读绑定 EROFS / 数据根 `master.key` 不可读 / netns inode 变化 / PID=2）、编译缓存**跨进程命中 41×**。
- **压力复跑（4 核 ×3 轮 ×4 lane，峰值 12 个测试二进制）**：queue 12/12、readyz 12/12、events **9/12** —— 唯一失败 `TestFlushPersistsBatchFields` 判定为**测试不稳**（`waitRows` 写死 5s 而批次预算只有 50ms；确定性探针证明产品行为是"丢批但计数可见"，**非静默失败**）。
- **§11 第 12 项补充**：本仓造不出合法 32 MiB 模块（自定义段上限 4 MiB），实测 2.20 MiB 冷编译 2451 ms（空载）；按代码体积线性外推 **32 MiB ≈ 36 s（空载）～59 s（负载）** ⇒ 60 s 编译预算在负载下余量接近 0。

### 6.3 修复批次

| 批次 | 范围 | 内容 |
|---|---|---|
| **H1** | `hostcap` / `abi` / `assets` / SKILL | FIX-1（事务内允许 db 读写 —— `db.tx` 可用性 P0）、FIX-2（能力清单门禁双向）、FIX-3（`Encoding` 填充）、FIX-4（事务允许集单一真源）、FIX-5（事务内 ping）、FIX-6（`ASSET_*` 码接线 + SKILL 补充码）、FIX-7（`assets.Open` 根包含断言）、FIX-8（无路径参数门禁枚举盲区） |
| **H2** | `appdb` / `appserver.dbpool` | FIX-9（`rowid`/`_rowid_`/`oid` 别名）、FIX-10（reason 常量单一真源 + `Close` 清毒 + 用真错误做用例）、FIX-11（嵌套 `WITH` 改词级判定）、FIX-12（新建连接限额 fail-closed）、FIX-13（`dbstat`/`load_extension` 显式拒绝集）、FIX-14（define 列上限口径）、FIX-15（扩展码 / 变异表用例名 / §15.2 实测结论） |
| ~~**H3**~~ | ~~`readyz` / `events` / `queue` / `anonlimit` / `api` / `cmd/server`~~ ⚠️ **`anonlimit` 随 W4 整包删除**（总纲 §8.4），本行其余模块仍为现役 | FIX-16（`AllowPublish` 接线）、FIX-17（事件保留期调度 + 计数出口）、FIX-18（`IsolationRequire` 真 fail-closed）、FIX-19（`/readyz` 暴露编译可用性）、FIX-20（事件水位进 `/readyz`）、FIX-21（queue app 表摊销清理）、~~FIX-22（匿名桶摊销淘汰）~~ **已废弃（对象随 W4 删除）**、FIX-23（`ReadTimeout` 单一真源）、FIX-24（内存自检只在启用时执行）、FIX-25（注释与文档口径） |

### 6.4 修复后复核

**修复批次实际产出（每个批次都做了变异验证：拆掉修复 ⇒ 对应用例变红）**

| 批次 | 结果 | 关键证据 |
|---|---|---|
| **H1** | FIX-1..8 全部落地；`./internal/wasmapp/...` 25 包全绿；`imports-gen -check` exit 0；`grep TxControlMethod\|TxIsolationMethod` 全仓为空 | FIX-1 有**guest 级端到端**证据（真编译 refapp → 真 wazero → 真 SQLite）：事务内 exec+query 成功、事务内读到未提交的写 `[[第一条]]`、commit 落盘、rollback 不落盘。变异：允许集去掉两条 SQL ⇒ 6 条用例红 |
| **H2** | FIX-9..15 全部落地；`appdb` 63 顶层用例、`appserver` 全绿；`./internal/wasmapp/...` 24 包全绿 | FIX-9 端到端断言宿主 `_row_id` 与 `sqlite_sequence.seq` 一字未变；FIX-10 用**真 5s 看门狗错误**替代构造串；FIX-12 改四层闭合（池容量 2 + 私有 DSN 令牌 + 未加固连接 fail-closed + 每语句复检），并**删掉了"断言 attached==10"的缺口断言** |
| **H3** | FIX-16..25 全部落地；7/7 包绿；**11/11 变异全红**；审计方原始探针 overlay 复跑 4/4 ok | FIX-16 低水位 ⇒ 503 且 **0 release 行 + 0 审计增量**；FIX-17 保留期调度真删 8 天前旧行；~~FIX-21/22~~ FIX-21（**FIX-22 的对象 `anonlimit` 随 W4 删除，该条判据作废**）性能判据用**遍历/操作次数计数器**（不用绝对耗时）；FIX-23 源码级断言 `ReadTimeout == limits.ServerReadTimeout` |

**修复过程中发现并一并处理的测试不稳（非产品 bug）**
- `appserver` 的 `waitForEvents` 预算 3s < events 批量落库周期在高负载下的实际耗时（20 包并行时红、单跑绿）。已把预算提到 30s 并写明理由：**等待仍是确定性条件轮询**（条件不成立时 30s 后返回真实条数 ⇒ 断言照样红），放大预算不掩盖缺陷。同一族问题在 `events` 包的 `TestFlushPersistsBatchFields`（审计在 4 路压力下 9/12）也记录在案。

**修复后仍存在的已知项（如实认账）**
1. `compile` 的 bwrap 隔离用 `--ro-bind-try /etc /etc` ⇒ 整个 `/etc` 对**编译进程**可读（收窄需显式清单 + 同步 argv 形状测试，属独立排期）。
2. bwrap 在嵌套容器里回落 `--ro-bind-try /proc`（可读宿主进程列表；只读，写面不放宽）。
3. `appdb` 的 L4 只复检 3 项最关键限额；只读例外连接上 `ATTACH` 仍会成功（平台自省路径，应用不可达）。
4. §11 第 12 项按结论记录：32 MiB 模块编译预算外推 ≈36 s（空载）～59 s（负载），60 s 预算在负载下余量接近 0。
5. §11 第 10 项（客户端创作链路 + 应用中心页）仍是本实现**最大的未闭合项**。

**H4 / H5 两个批次（身份/边缘 与 沙箱运行时）**

| 批次 | 结果 | 关键证据 |
|---|---|---|
| **H4** | FIX-26..30 全部落地；6/6 变异红；审计员探针 27 PASS/3 FAIL → **29 PASS/1 FAIL**（唯一 FAIL 经反证变异证明是探针判据误报）。⚠️ **本批 FIX-26 的证据对象已删除**（见右列） | ~~FIX-26 有 12 行表断言 `SelfOrigin` 与浏览器实际会发的 `Origin` 逐字符相等~~ **已废弃（对象已删除，W4）**：`edge.SelfOrigin` 与 HostGate 随总纲 §8.4 删除，现行 Origin 判据见总纲 §8.3（由 `app_id` 推导 `<app scheme>://<app_id>`，由 handler 补头）；**FIX-27..30 与 H4 其余结论不受影响**；FIX-27 保留资源不直出（8 种路径形态含 `%70` 解码）+ **反向对照**：非保留资源仍直出 200+ETag（保住 R8 的缓存收益） |
| **H5** | FIX-31..37 全部落地；审计员探针 226 PASS/1 FAIL → **241 PASS/0 FAIL**；白名单 **30 → 34** | 新增第三份来源程序 `refapp/stdprobe`（template Execute + ReadAt/WriteAt + 一批常见 std），并新增**独立于生成来源**的覆盖性门禁 `wasmmod/imports_coverage_test.go` + 夹具 `wasmmod/testdata/stdrender` —— 来源程序退化时白名单会跟着变小，只有这条独立判据会红 |

**H4/H5 顺带发现并修掉的真实缺陷（不在原审计清单内）**
- **源比较不能"截到源再比"**（原 `edge.CheckOrigin` 的缺陷，该函数已随浏览器链路删除）：带路径的 `Origin` 会被当成合法源放行。**教训保留**：Origin 判据必须整串相等，先截断再比等于放开一批异源写法 —— 现行判据见契约 §4.3。
- `net.SplitHostPort` 对 `a.example.com:8443.`（尾点）的解析会把尾点切进 port；已在 `NormalizeOrigin` 里处理。

> 🗑️ **登录页 / 换票页条目已删除（2026-09-19）**：原「登录页与换票页内联样式渲染成 `ZgotmplZ`」一条（及 `TestLoginAndTicketPagesRenderInlineCSS`）针对的两个页面已随浏览器链路删除。
> 现行契约见 `docs/decisions/2026-09-19-wasm-client-internal-origin.md`。

**最终验收（全部在本轮修复之后复跑）**

| 项 | 结果 |
|---|---|
| `go build ./...`（服务端全量） | **exit 0** |
| `gofmt -l .` / `go vet ./...` | **空 / exit 0** |
| `go test ./internal/... ./cmd/... -count=1 -p 2` | **全绿，零 FAIL 行** |
| ~~端到端验收 `temp/wasm-e2e-run.sh`（真 PG + 真服务端 + 真 wasm + 真 https 子域）~~ | ~~**61/61 PASS**~~ **已废弃（对象已删除，W4）：该脚本断言的是 https 子域 + 换票 + 匿名链路，现行判据见总纲 §13** |
| 根守卫 7 个（layout/workflows/ci-scripts/patches/patch-resolutions/inventories/check-workspaces） | **全部 OK** |
| desktop `verify-packaged-runtime.spec.ts`（随包技能清单） | **46/46 PASS** |
| `memory-evolve` 的 `coi.test.js`（BUILTIN_SKILLS 冻结清单） | **70/70 PASS** |
| 5 个审计身份的自写探针（overlay 复跑，不改产品代码） | sandbox **241 PASS/0 FAIL**、`sqldb` P0-2 与 P1-1/P1-2 判据转绿、`resource` 4/4 探针 ok、`caps` 两条 P1 转绿 —— **以上四行对象仍有效**；~~`identity` 3 条 CONFIRMED 全转绿~~ **已废弃（对象已删除，W4）**：`identity` 身份覆盖的 `session` / `aichat` / `edge` 三个包均随总纲 §8.4 / §21.3 删除（该身份只余 `hostcap` 相关结论，复核前不得作为现行证据） |

### 6.5b AI 发布路径：定案（模块 L 审计暴露）——**第三轮已落地**

设计 §6.2 的链路是「**AI 调** `POST …/wasm/validate` → `POST …/wasm/:app_id/releases`」，
但客户端的本地写面要求**浏览器持有性证明**（上游 `connection.requestRejection()` —— 验
`dsh-auth-<authority>` cookie：HttpOnly + SameSite=Strict + HMAC，只有"由本进程服务、
经 launch token 换过票的浏览器页面"才持有）。**AI 的 bash/curl 拿不到它**，
所以现状是：**AI 无法独立完成一次发布**（模块 L 在交付说明里点名，独立审计员 L1 复核）。

**三条候选路径的判定**

| 路径 | 判定 |
|---|---|
| ① AI 直接 curl 服务端 `/api/client/v2/apps/wasm/*` | **不可行**：需要 Bearer 令牌，而设计 D3.1 明确令牌只在宿主内存、不进浏览器/不进帧（红线 3） |
| ② AI 直接 curl 本地 `/api/pico/apps/wasm/publish` | **不可行**：过不了持有性证明（这是**有意**的围栏，不是缺陷） |
| ③ **AI 走宿主侧工具（host tool）** | **选它**。与产品里既有的 `browser_*` / `cron_*` / 连接器工具面同构：工具在宿主进程内执行，直接调用与本地路由**同一个**内部函数，不经 HTTP ⇒ 不需要持有性证明，也不需要把令牌交出去 |

**为什么 ③ 不削弱安全模型**：围栏保护的是"浏览器侧 CSRF / DNS-rebinding / 伪造 Origin 的本机裸 curl"；
而 `$DSH_HOME/session.json` 本来就以 0600 明文存着企业登录令牌 —— 任何**同 uid** 的进程
早就能直接以该用户身份打服务端。所以"同 uid 进程可读"不是本围栏要挡的威胁；
把发布能力交给宿主进程内的工具，不改变这条既有边界。

**当前状态（2026-09-18 更新）**：**已落地**。本节原先如实认账的"未落地"已由第三轮工作流 N 关闭 —— 见 §6.8「N（AI 发布工具面）」。下面保留当时的候选判定与最小实现范围作为决策留痕（历史原文，不再代表现状）。

> 第二轮结束时的状态（历史）：**未落地**。
- 已落地：本地 HTTP 写面（`/api/pico/apps/wasm/*`，浏览器/UI 路径）+ 服务端分片上传与续传。
- 未落地：宿主侧工具面（`wasm_app_*`）。在此之前，AI 只能把"编译 + 准备载荷"做完，
  由**员工在应用中心点发布**，或由员工把令牌/持有性证明交给 AI —— 两条都不理想。
- 最小实现范围（下一轮）：在 `packages/host/enterprise` 注册 3 个工具
  （`wasm_app_validate` / `wasm_app_publish` / `wasm_app_list`），内部调用与本地路由
  共用的同一个函数（**不要复制编排逻辑**）；同步更新 SKILL 的 `references/publishing.md`
  让 AI 知道"用工具而不是 curl"。

### 6.7 第二轮：分片上传 + 客户端创作链路（模块 K / L）与它们的审计

第一轮把**服务端核心**做完并闭环后，§11 第 10 项（客户端创作链路与应用中心页）仍是最大缺口。
第二轮补上它，并同样走"实现 → 独立身份审计 → 修复"。

| 模块 | 产出 | 关键设计约束 |
|---|---|---|
| **K（服务端分片上传）** | `internal/wasmapp/upload/*`（会话存储 + 回收调度）、`api/upload.go`（5 个 handler）、router 5 条路由 + 1 条 `largeBodyRoutes` | §4.2「>8 MiB 走分片 + 续传」；`.wasm ≤ 32 MiB`／请求体 ≤ 48 MiB **不因分片放宽且增量生效**；会话绑发起者、过期回收；`complete` **复用同一个**发布实现（抽 `publishFromBytes`，不是复制） |
| **L（客户端链路）** | `packages/host/enterprise/src/wasm-apps.ts`（本地路由 + 发布编排）、`packages/client/wasm-apps/**`（应用中心插件） | §4.2 客户端 90 s 预算（取代既有 30 s）、>8 MiB 自动分片 + 续传；写面一律 `requireWriteProof`；§4.7/R36 浏览器侧无额度；§4.8 错误信封逐字段透传 |

**模块 L 的四个装配点已补齐**（`check-workspaces.mjs` PACKAGES/PATH_OWNERS、`prebuild-workspace-deps.ts`、desktop `devDeps`、`profile.ts` 的 patch 载入）**外加两个审计/门禁抓出来的**：
`.gitignore` 的 `packages/client/wasm-apps/lib/`**与 `.github/workflows/ci.yml` 的 workspace-build 归档清单**
—— 后者是 `scripts/verify-inventories.mjs` **实测拦下的**（漏带 = CI 三平台打包拿到旧包/缺 lib，而本地 prebuild 一切正常，属典型"本地绿、CI 红"）。

**模块 K 的一处装配由主控补**：`upload.CleanupScheduler` 的构造 + `Start` + `Close`
（审计员 K1 的 P1-1 正是"过期会话回收**零生产调用点**"，审计期间被并发补上；已按要求补**装配级回归断言**防止"构造了但没 Start"静默回归）。

**第二轮审计结论**（两个独立身份，只读、overlay 注入探针、产品代码零改动）

| 身份 | 结论 | 最有价值的发现 |
|---|---|---|
| `chunkupload`（K1） | **P0=0 / P1=1（审计期间已修）/ P2=3** | **每用户磁盘配额闸门算术上永不可达**（`N×32 MiB < N×48 MiB` 对任何 N 成立 ⇒ 换任何数字都不行，必须改公式）；并发重复 `complete` 不回放（得 429 而非 201）；`POST /uploads` 的 413 提示语错用了 base64 直传模板 |
| `clientchain`（L1） | **P0=1 / P1=1 / P2=4** | **发布链路无人可达**：面板没有发布入口、`wasm_app_*` 工具零实现、skill 却指向"在应用中心发布"⇒ `/api/pico/apps/wasm/publish` **0 个调用方**，那段被反复验证的 90 s/分片/续传编排**在产品里不可达**；`wasm_path` 允许面覆盖整个数据根 ⇒ 可把 `session.json`（明文令牌）当上传源 |

**两条审计都独立复现为"正确"的部分**（带反向变异）：写面围栏（10 种非 GET 组合缺证明全 403、`connection` 缺席时 503 fail-closed）、错误信封逐字节透传、90 s 行为级断言（30 s 不 abort / 90 s 才 abort）、8 MiB 边界与**实际发出的每一片都落在服务端 `[64 KiB, 8 MiB]` 内**、续传只补缺失片（PUT 序列 `[0,1,1,2,3]`）、`wasm_path` 越界矩阵全拒、红线 3 无令牌泄漏；服务端侧：**增量总量闸门**（33 MiB 在越界那一片被拒且不落盘）、**先查头再读体**（413 读 0 字节）、26 种非法 `upload_id` 同一个 404 体、32 goroutine 并发 PUT 不丢 meta、**分片与一次性上传的行为等价性成立**（release 行 / apps 行 / 磁盘 assets sha256 / 审计序列全等）。

**第二轮的修复批次**

| 批次 | 范围 | 结果 |
|---|---|---|
| **H6** | 客户端链路（`wasm-apps.ts` + `packages/client/wasm-apps`） | FIX-38（**P0：面板加发布入口**，页面上下文直发 `/api/pico/apps/wasm/publish` ⇒ 那段 90 s/分片/续传编排终于可达）、FIX-39（`wasm_path` 允许面收敛到工作区 + `<数据根>/apps`，不再能把 `session.json` 明文令牌当上传源）、FIX-40/41（畸形百分号转义与目录路径 ⇒ 结构化 400 而不是空 body）、FIX-42（取数链路用例并入产品测试 —— 原面板单测走 `renderToStaticMarkup` 不跑 `useEffect`，取数从未被执行）、FIX-43（分片字段契约跨端对拍） |
| **H7** | 服务端分片上传（`upload` + `api/upload.go`） | FIX-44（**每用户磁盘配额闸门算术上永不可达** → 改为按未过期会话的**声明总量（预留）**判定，新增 `limits.UploadDiskQuotaPerUserBytes`；预留恒 ≥ 实际 ⇒ 真空上界，且两条闸门都活）、FIX-45（并发/交错重复 `complete` 改为**在会话锁内**先查重放 ⇒ 逐字回放 201，不再 429）、FIX-46（`POST /uploads` 的 413 提示语不再错用 base64 直传模板）、FIX-47（`CleanupScheduler.Running()` + `cmd/server` 装配级断言，防"构造了但没 Start"静默回归） |

**H6 的真机证据（打包版、无注入）**：`temp/fix-h6/probe-real6.txt` —— 真包（宿主路由与客户端插件都在包里）下 12 项全绿：
入口在 DOM 且可见可点 → **真宿主路由返回的目录被面板渲染**（当时含 `visible=false` 行，即"目录不过滤"；2026-09-18 起该行改为 `access`/`enabled`，口径不变）→ 面板无任何额度/用量字段（R36）→
**宿主路由真的出站**（假网关收到 catalog，带 Bearer）→ 发布入口真按钮 → 真鼠标点击出表单 → **假网关收到
`POST /api/client/v2/apps/wasm/shift-notes/releases`，字节数与磁盘逐字节相同** → 结果显示"版本/已生效/~~入口链接~~"（**入口链接列已随 W4 删除**，总纲 §8.4 / F14；本项为历史验收记录） →
**17 MiB 与 9 MiB 载荷：面板仍只发一次 `/publish`，切分由宿主的同一份编排完成**（`POST /uploads` + N 片 `PUT` + `complete`）。

**第二轮修复后的门禁**

| 项 | 结果 |
|---|---|
| `gofmt` / `go vet` / `go build ./...`（服务端） | 空 / exit 0 / exit 0 |
| `go test ./internal/... ./cmd/...` | **零 FAIL** |
| 根守卫 7 个 | **全部 OK**（其中 `verify-inventories.mjs` 在第二轮**实测拦下**了 CI 归档清单漏带新包 lib 的问题） |
| `@picoaide/dsh-wasm-apps` check（build+typecheck+test） | **63/63 PASS** |
| `@picoaide/dsh-enterprise` test | **435/435 PASS** |
| ~~端到端验收 `temp/wasm-e2e-run.sh`~~ | ~~**61/61 PASS**~~ **已废弃（对象已删除，W4）：该脚本断言的是 https 子域 + 换票 + 匿名链路，现行判据见总纲 §13**（同桌 `gofmt`/`go test`/根守卫/包 check 各行**仍然有效，不受影响**） |
| 审计员复跑脚本 | `chunkupload` 的两条独立发现双双转绿；`clientchain` 的 3 条 CONFIRMED 转绿 |

**第二轮结束时仍开着的项（如实）**
1. ~~**AI 发布路径（`wasm_app_*` 宿主工具面）未落地**~~ —— **已由第三轮关闭**（§6.8 的 N；见 §6.5b 的定案与最小实现范围）。
2. FIX-48（把上传清理调度器的计数接进 `/readyz`）未做 —— 计数已在日志里，且"接线缺失"已被 FIX-47 的门禁挡住，属运维可见性增强。
3. 审计列的若干 P2 未处置或已认账：`wasm_path` 的 realpath→open TOCTOU（同 uid 本就能读，无增量收益）、`complete` 全程持会话锁（含最长 60 s 编译 ⇒ 同会话 PUT 阻塞）、片字节数按目录 stat 计算未缓存、PUT 无速率限流（需新 limits 数值）、重放缓为进程内存（重启/多副本退化）。

**AI 发布路径的定案**见 §6.5b：候选三条里选"宿主侧工具面"。第二轮结束时**未落地**（当时最明确的剩余工作项），**第三轮已落地**（§6.8 的 N）。

### 6.6 审计对设计论证的更正

> 来源：`sandbox` 审计员（`temp/audit-wasm/sandbox/REPORT.md` P1-2 / P1-3）+ 修复批 H5 的实测复跑
> （wazero v1.12.0 / Go 1.26.x）。**设计结论（红线 4/5 成立）不变**，但**论证与判据写错了**。
> 判据写错有两个坏结果：门禁要么**永远无法通过**（照原判据写断言），要么**形同虚设**。

| # | 文档/注释原话 | 实测事实 | 影响与处置 |
|---|---|---|---|
| 1 | §10.2 第 14/15 项与多处注释写"零 preopen 下 `path_open` 拿到 `ENOSYS`/`ENOTCAPABLE`" | 零 preopen 的真实 errno：Go `os.Open/Stat/ReadDir/...` → **`EBADF(8)`**（Go 的 wasip1 syscall 层先 `fd_prestat_get` 找 preopen）；原生 `path_open(fd, "/etc/passwd")` → **`EPERM(63)`**（wazero `atPath` 里 `fs.ValidPath` 先否决前导 `/`）；相对路径 → **`EBADF(8)`**；stdio fd（0/1/2）→ **`ENOTDIR(54)`**；`fd_prestat_get(3..12)` → `EBADF(8)`。**`ENOSYS(52)` / `ENOTCAPABLE(76)` 一次都没出现** | 结论不变（一律 DENIED）；**判据改写成**"DENIED（errno 视调用层与路径形态为 EBADF/EPERM/ENOTDIR）"。已改：`wasmmod.go`、生成器模板 + 重生成的 `imports_gen.go`、`refapp/wasiprobe`、`runtime/runtime.go` 的注释，以及作业指导书 `temp/wasm-brief/AUDIT-CHECKLIST.md` §3-A 第 4 条 |
| 2 | §3.3 / §10.2 第 16 项表述为"白名单不含 `sock_*` + preview1 无 `sock_open`" | preview1 宿主模块**导出 46 个函数，其中含 `sock_accept` / `sock_recv` / `sock_send` / `sock_shutdown`**（**没有** `sock_open` / `sock_bind` / `sock_listen` / `sock_connect`）；且 Go 运行时**会真的发出**其中两个 —— 经 `text/template` / `html/template` 的 **`Execute`（渲染）** 可达（审计 P0-1） | 红线 4 真正的理由是"**没有任何途径得到一个 socket fd**"（`syscall.Socket` → "Not implemented on wasip1"；`sock_accept(0..10)`、`sock_shutdown(3)` 全 `EBADF(8)`）+"白名单只放行不造 fd 的 socket 符号 + 拒绝非 preview1 模块"。已改：四处生产注释 + 生成产物模板 + `imports_gen_test.go` 的安全边界判据（由"禁一切 `sock_*` 前缀"改为"禁造 fd 的 `sock_open`/`sock_bind`/`sock_listen`/`sock_connect`，socket 面精确到 `sock_accept`/`sock_shutdown` 两条"） |
| 3 | §4.3.1-a/b 的隐含前提与 `limits.CompileCacheRevision` 的长注释写"`GetWazeroVersion()` 在依赖方返回 `dev` ⇒ 目录分片与条目版本戳都区分不了 wazero 版本，所以升级必须手工 +1" | **"返回 dev" 只对 `go test` 二进制成立**：`go build` 出来的 main 二进制（服务端进程与 `cmd/picoaide-app-compile` 子进程都是这种形态）`debug.ReadBuildInfo().Deps` 里有 wazero ⇒ 分代名就是 `v1.12.0`（本次新增探针实测：test 二进制 `r1` / 生产形态 `v1.12.0`，两侧一致） | 分代改为"**优先用 wazero 真实版本，拿不到版本（test 二进制）才回落到手写常量**"（`runtime.CompileCacheDir` 与 `compile.CompileCacheDir` 同算法，配交叉断言用例 + 生产装配点校验）。§4.3.1-b 的"同 wazero 版本"因此**自动满足**，`CompileCacheRevision` 降级为"版本不可知构建"的回落位（不再是"必须记得改"的人肉约束） |

**三条都不影响红线成立**，改的是"为什么成立"与"用什么判据"。两条方法论结论值得留下：

1. **审计结论要落到"判据"这一层再复核一次**：同一条护栏在实现里正确、在注释里写错 errno，
   会让下一个写门禁的人写出永远无法通过的断言 —— 门禁红久了就会被绕过。
2. **"能力不存在"的论证必须区分"符号存在"与"fd 可得"**：preview1 有 4 个 socket 函数与
   "不能出站"并不矛盾；把论证简化成"根本没有 `sock_*`"，会让 P0-1（模板渲染被拒）在修复时
   看起来与"安全边界"冲突，而实际上两者无关（`sock_accept` 需要一个已存在的监听 fd，
   而平台没有任何途径造出 socket fd）。

### 6.8 第三轮：用户新增要求（~~access 三模式~~ **access 两值**（2026-09-19 订正，总纲 §6/I6）/ AI 发布 / 技能内置 / 字段规格单一真源）

> 来源：用户 2026-09-18 的两条要求 + 追问后拍板。**这是本轮的最高判据**，与旧设计文本
> 冲突处按用户口径执行，并就地勘误设计基线（`docs/planning/2026-09-17-wasm-app-platform.md`
> 的 15 处 `⚠️ 变更（2026-09-18，用户拍板）`）。
>
> 用户原话：「应用中心里无论是否公开的，或者没权限的都应该展示出来。然后应用部署时候，
> 配置文件的权限里，应该支持几种，公开，登陆后使用（默认全员），白名单用户。」
> 以及「AI 应该能编译，能发布……skill 应该是内置到服务端，客户端可以按需安装」。

**四条口径（拍板结果）**

| # | 口径 | 落地要点 |
|---|---|---|
| 1 | 权限**收敛成单一 `access` 枚举**：`login`（缺省，登录后全员）/ `whitelist`；**删掉 `visible`**。⚠️ **2026-09-19 订正（I6）**：本行原把 `public` 也列为枚举取值之一，现已**废止** —— 写侧只接受 `login` / `whitelist` 两值；历史配置里的 `public` 只在**读取侧按 `login`** 处理（迁移期 shim，不是第三种模式，总纲 §8.4 / 迁移 0074） | `appcfg.Config` 去掉 `Visible`/`LoginRequired`；迁移 **0071** 删列 + 就地改写两个 `config_json`；后续迁移 **0074** 把存量 `access='public'` 改写为 `login` |
| 2 | **准入仍由应用判定**（R24 不动）：平台只注入身份 + 访问模式 | 平台**不比对名单**；帧内 `auth.mode` 取值（⚠️ **2026-09-19 订正**：此处原写"**三取值**"，现为 `login` / `whitelist` **两值** —— `public` 已作废，见总纲 §6 / §13.1 I6），名单由应用自己 `assets.read("picoaide.app.json")` 读 |
| 3 | **应用中心展示全部应用** | catalog 去掉可见性过滤；行 `visible` → `access` + 新增 `enabled` |
| 4 | **AI 能编译、能发布**；表单字段**AI 知道该填什么** | 3 个宿主工具；字段规格做成机器可读单一真源，工具参数/UI/SKILL 三处对拍 |

**四个工作流（各自独立子代理实现）**

| 模块 | 范围 | 关键交付 |
|---|---|---|
| **M** | 服务端访问模型 + 迁移 + 字段规格真源 | `appcfg` **两模式**（`login` / `whitelist`；⚠️ **2026-09-19 订正**：本行原写"三模式"并把 `public` 算作一种，已废止；历史 `public` 只是读取侧按 `login` 的迁移期 shim）+ **旧 schema 兼容 shim**（`login_required=false`→public；`true`+有名单→whitelist；`true`+空名单→login；`visible` 忽略；旧字段不报 unknown，canonical 只写新 schema）；`abi.AuthMode` 三取值；`RequiresLogin()` 取代旧布尔；迁移 **0071**（DROP COLUMN `visible` + 改写 `apps.config_json`/`app_releases.config_json`，幂等可重放，坏 JSON 跳过并 WARNING，自检段 fail-loud）；`appcfgspec.go` → 生成器新增 `appcfg.json` 与 SKILL `references/app-config.md` |
| **N** | 发布编排解耦 + 宿主工具面 | `wasm-apps.ts` 把编排从 `ServerResponse` 解耦成可复用函数（`publishApp`/`validateApp`/`listCatalog`），HTTP 路由退化成薄壳；新增 `wasm-app-tools.ts` 的 `wasm_app_list`/`wasm_app_validate`/`wasm_app_publish` |
| **O** | 技能内置到服务端 + 客户端按需安装 | 技能进版本控制；`skillseed` 包把镜像内 `/opt/picoaide/skills` 打包下发（`GET /api/client/v2/skills/builtin[/:name/archive]`，确定性 tar.gz + sha256 头）；客户端两条代理分支 → `installSkillArchive()` → `<dshHome>/skills/<name>`；能力中心「平台内置技能」区 + 一键安装 |
| **P** | 客户端 UI（发布表单 + 应用中心） | 三选一 `access` 选择器（缺省 `login`，选 `whitelist` 才出名单且必填）；提交体**不发** `visible`/`login_required`；catalog **不二次过滤**（下架项也展示并标"已下架"）；11 条本地预校验 |

**两处「本可以静默出错」的收口（parent 在四个模块交付后补）**

1. **技能没装时工具必须指路**：用户要求「skill 内置到服务端、客户端按需安装」⇒ 技能是**随需的**，
   模型不能假设它在本机。`wasm-app-tools.ts` 的写面工具在失败时会附一条安装指路
   （`resolveSkillHint`，**每次调用重新判定**磁盘事实，禁止模块级冻结）；`hints` 追加在**末尾**
   （服务端自己的 hints 是主证据）；**401/403 不指路**（身份问题装手册解决不了）；
   成功路径零多余 stat。6 条用例锁死，双向变异（去掉指路 / 冻结判定）各 2 条变红。
2. **宿主测试夹具跟进新契约**：`tests/wasm-apps.spec.ts` 的载荷夹具原先还是旧的
   `visible`/`login_required` 形状。因为宿主是**原样透传**，旧夹具不会红 —— 属**契约半失效**
   （测试看起来在验字段，其实验的是一组服务端已经不接受的字段名）。已改成
   `access`/`whitelist` 形状，并把目录用例改成"**下架条目也照列**"的正向断言。

**`abi.ABIVersion` 的有意决定（不是漏改）**：帧内 `auth.mode` 的**取值集合**变了
（`login_required` → `login`/`whitelist`），但帧形状、方法名集合、导入面、错误码集合一个都没动；
且平台尚未发布、线上零个已编译产物。因此**保持 `picoaide-app/1`**，并把"什么时候必须 bump 到 /2"
写进 `abi.ABIVersion` 的注释（帧头/方法名/导入面/错误码取值等结构性变化）。

> **"零个已编译产物"的取证**（`access` 审计把这条记为 UNVERIFIED：它无法访问部署环境，
> 只能提出"若已流出旧模板产物就应 bump 到 /2"）。本仓可自查：`git log -- server/internal/wasmapp`
> 与 `git log -- packages/client/wasm-apps` **均为空**（整个平台在本轮之前从未提交），
> 且最近三个发布 tag（`v2.7.5-beta.3/4/5`）的树里 `server/internal/wasmapp/` 与
> `packages/client/wasm-apps/` 条目数都是 **0** ⇒ 不可能存在按旧取值编译的线上产物。
> 结论：**UNVERIFIED 关闭，保持 `/1` 成立**。

**设计基线勘误**：`docs/planning/2026-09-17-wasm-app-platform.md` 就地改了 **15 处**
（R25、R38、§4.2 配置文件行、§4.7、§6.1/§6.2、§7.1 帧示例与 `auth.mode`、§8 应用中心行、
§9 硬约束 7、§10.4 第 39/51 项、§10.5 第 56c/56e 项、§11 第 9 项、§12），全部标
`⚠️ 变更（2026-09-18，用户拍板）`；**未重写全文**（保留"当时为什么这么写"的留痕）。

**第三轮门禁（§6.8 交付时点）**

| 项 | 结果 |
|---|---|
| `gofmt` / `go vet` / `go build ./...` | 空 / exit 0 / exit 0 |
| `picoaide-limits-gen -check`（5 个生成产物逐字节） | 一致（103 条目 / 配置 5 字段 / 发布 6 字段） |
| 服务端 `go test ./internal/... ./cmd/...` | 见 §6.9 的门禁表（第三轮结束时的实测） |
| `@picoaide/dsh-wasm-apps` check | **100/100 PASS**（63 → 100） |
| `@picoaide/dsh-enterprise` test | **509 passed / 1 skipped**（H9 之后） |
| 根守卫（layout/workflows/ci-scripts/patches/patch-resolutions/inventories/check-workspaces） | **全部 OK** |
| 变异验证 | M 七种、N 六种、O 六种、P 十二种，全部实跑变红后复原；H8 修复批另有 12 组变异（见 §6.9 表内逐条） |

### 6.9 第三轮的独立审计与修复（H8 批）

四个身份**并行**审计（只读、自写探针、产品代码零改动；探针与报告在
`temp/wasm-audit-r3/<身份>/`）。判据 = `temp/wasm-brief/AUDIT-CHECKLIST-R2.md`
的 §0 用户口径 + §1 各身份作业清单 + §2 两条跨身份联查。

| 身份 | 判据 | 结论 | 计数 |
|---|---|---|---|
| `access` | A1–A5 | ⚠️ **部分对象已删除（W4）**：本身份覆盖访问模型，其中 **`access=public` 与匿名面已随总纲 §8.4 删除** ⇒ 涉及 public/匿名的条目**已废弃**；**A3 PARTIAL（"平台不比对白名单"仍成立）与登录/白名单语义的条目仍然有效**。原始判据清单 `temp/wasm-brief/AUDIT-CHECKLIST-R2.md` **已不在工作树**（temp 被清理）⇒ 无法逐条判定 A1/A2/A4/A5 是否含 public/匿名，**复核前不得整体作为现行证据** | P0=0 / P1=1 / P2=5 / NOT_A_BUG=5 |
| `aitools` | B1–B6 | **全部 COVERED**（B2 用独立计数法复核，不用实施者的 spy） | P0=0 / P1=1 / P2=2 / P3=3 / NOT_A_BUG=3 |
| `skilldist` | C1–C6 | C1 / C2 / C4 / C5 **COVERED**；**C3 PARTIAL**（按需安装被开机自动同步架空）；**C6 PARTIAL**（内部机制措辞） | P0=0 / P1=1 / P2=5 / NOT_A_BUG=6 / UNVERIFIED=1 |
| `clientui` | A2 + 六条 | ⚠️ **部分对象已删除（W4）**：本身份覆盖客户端面，其中 **"入口链接"列/深链展示的相关条目已随总纲 §8.4 删除**（见本文件 §7 第 3 条的就地标注）；**其余（发布表单预填、错误信封、体积闸门、四方契约对拍）仍然有效** | P0=0 / P1=2 / P2=3 / NOT_A_BUG=5 |

**两条跨身份联查（四人各自独立复现）**：① **四方字段契约逐字一致** ——
服务端 `appcfg.Config` / 生成物 `appcfg.json` / 客户端提交体 / 宿主工具 `parameters`
（16 个维度：配置 5 字段 × 5 处、发布 6 字段 × 2 处、~~access 三取值~~ **access 两值**（2026-09-19 订正，总纲 §6/I6）× 4 处、缺省 × 4 处、
白名单上限、首版必填；`visible`/`login_required` 在八处字段集合里均不存在）。
② **白名单空名单的拒绝路径三面一致**：UI 拦在前且给可读提示（零出站）、服务端 422
带 `empty_whitelist` details、宿主工具**不拦**、把服务端信封原样带回 —— 三者行为不同，
但**没有"看起来成功了其实没发"**。`access=login` + 空名单三面都放行（A4 成立）。

**H8 修复批（按发现来源排序；每条都有"拆掉闸门必红"的变异记录）**

| # | 来源 | 问题 | 修法 |
|---|---|---|---|
| 1 | `clientui` P1-1 | 客户端对拍只查 `access`/`whitelist` 在不在，`purpose`/`data_sensitivity`/`owner`/`publish_fields` 被改名时**闸全绿** | 两张表各自与客户端真源做**全集合相等**（`config_fields` ↔ `APP_CONFIG_FIELDS`、`publish_fields` ↔ `PUBLISH_PAYLOAD_FIELDS`），宿主侧同补发布表集合断言；变异：单字段改名 ⇒ 两侧各红 |
| 2 | `clientui` P1-2 | `appcfg.json` 被删/改名 ⇒ 两端对拍**静默 skip**，`yarn check` 依旧绿 | 缺席即红（`expect(missing).toBeNull()` / `expect(appcfg.exists).toBe(true)`）；变异：把文件移走 ⇒ 客户端 1 红 + 宿主 2 红 |
| 3 | `access` P1-1 + `clientui` P2-2 | "下架应用 URL 直达仍可用"与实现相反（实测 **410 Gone**），而它是"下架也列进目录"的唯一书面理由；R38 又用"死链"作为排除冻结的理由 ⇒ 同一判据两种结论 | **行为不动**（与用户口径一致）；改说法：列出下架条目的理由 = **下架是可逆的发布者动作、应用与数据都还在**，~~子域返回 410~~（**子域已随 W4 删除；现行由应用请求管线按 `enabled` 返回 410**）说明"已下架但数据保留"。改了 5 处（`api/read.go`、`appserver/respond.go`、~~`session/store.go`~~、`read_test.go`、设计基线 §10.5 第 56e 项） |
| 4 | `clientui` P2-a | `resolveAccess` 对**非法** `access` 值会落进旧字段分支，`access:'org' + login_required:false` 被渲染成「公开」= **放大权限** | 非法值（有值但不认识）一律回落缺省 `login`；旧字段分支**只在 `access` 缺失**时生效；DOM 级用例锁死 |
| 5 | `aitools` P1-1 | `readWasmFromPath` 的允许面（工作区 ∪ `<数据根>/apps`）没减掉数据根子树：工作区**等于/是祖先/软链指向**数据根时，`session.json`（明文员工令牌）、`.credentials.yaml`、`data/master.key` 都成了合法上传源 | 新增"数据根子树整体否决（`apps/` 除外）"；三种形态各一条用例 + 反向对照（数据根之外的产物照常放行）；变异：删掉否决块 ⇒ 3 红 |
| 6 | `aitools` P2-1 | 分片链路每条出站各拿 90 s，聚合最坏 5×90=450 s ≫ 工具 deadline 120 s；传输失败回笼统网关信封 ⇒ **`upload_id` 送不到模型，续传失明** | 整条链路共用一个总预算（`CHUNKED_PUBLISH_BUDGET_MS`，每次出站只用**剩余额度**），且**会话已开之后的传输失败改为可续传的 `UPLOAD_INCOMPLETE`**（带 `upload_id`/`received`/`transport_code`）；源级门禁断言 `publishChunked` 内不得出现裸 `CLIENT_UPLOAD_TIMEOUT_MS`；变异：改回网关信封 ⇒ 红 |
| 7 | `aitools` P2-2 | 技能安装指路**适用面过宽**：网关 502（网络不可达）与本地 400（路径被拒）也提示"去装作者手册"，把网络故障引向装技能 | `skillHintAppliesTo(status, code)`：排除 401/403、`GATEWAY_*`、本地前置闸门（`WASM_PATH_*`/`UPLOAD_*`/`MISSING_FIELD`/`INVALID_JSON`）；两次变异各咬住 2 条 |
| 8 | `skilldist` P1-1 | 随包副本与服务端副本落在**同一个根**且开机无条件同步 ⇒ 员工没点任何按钮技能已在库中、面板显示「已安装」，**「按需安装」名存实亡**，UI 文案"不自动安装"与事实相反 | 把平台技能从随包同步清单里摘出（`BUILTIN_SKILLS` 只留本插件自己的 5 个），新增 `PLATFORM_SKILLS` 作为唯一真源 + 同步循环里的**纵深防御**跳过；用例改写为"平台技能在两种开关下都不得被装上"，并保留一条"源目录必须留在包里"（服务端镜像的构建上下文）；变异：加回清单 + 摘掉纵深防御 ⇒ 2 红，冻结清单门禁 1 红 |
| 9 | `skilldist` P2-2 / P2-3 | `tar.gz` 路径**没有条目数上限**（zip 有；注释却声称与 Go 侧 10000 对齐，实测 10050 条被接受并落盘）；tar 的 FIFO/设备条目未被拒 | tar 分支加同口径计数（>10000 拒）+ `LINK_TYPES` 扩到 `CharacterDevice`/`BlockDevice`/`FIFO`；边界用例（10000 放行）+ 三类特殊文件用例；变异：回退两处 ⇒ 2 红 |
| 10 | `skilldist` P2-4 | 客户可见技能正文含内部机制措辞（"审计查出的真实不一致"、`§9.4`、"不在设计基线的失败语义表里"） | 改掉四处过程措辞（含生成器模板并重新生成，`-check` 逐字节一致）；**保留** 生成表里的 `§x.y` 追溯列（见认账 A6） |
| 11 | `access` P2-1 | 迁移 0071 的**自检条件与 UPDATE 幂等条件不一致**：同时带 `access` 与旧键的行被 UPDATE 跳过、却被自检算作"未改写" ⇒ **升级直接失败**（真 PG 复现，事务回滚） | 自检补上同一条件 `NOT jsonb_exists(config_json::jsonb,'access')`（apps 与 app_releases 两处）；新增"混合形状"用例，变异回退自检 ⇒ 红（复现出原始 RAISE） |
| 12 | `access` P2-2 | 迁移里的 `RAISE WARNING '跳过 N 行…'` 服务端**收不到**（pgconn 只在给了非 nil `OnNotice` 时才转发）⇒ 数据不丢但报告静默 | `newPGConnector` 接上 `cfg.OnNotice`（严重级别 + message + detail/hint），经 `pgNoticeSink` 落服务端日志；真 PG 用例跑 `RAISE WARNING` 断言到达 sink；变异：摘掉转发 ⇒ 红 |
| 13 | `access` P2-3 | **A3 的核心性质没有回归网**：造一个"平台自己拦白名单（403）"的变异后，既有 appserver **74 个用例仍全绿** | 新增 `TestServe_WhitelistOutsiderStillReachesWasm`（名单 `["alice"]` + 登录 `bob` ⇒ 必须 200 + 帧内 `auth.mode=whitelist` + 身份是 bob）；变异：加回平台拦截 ⇒ **只有它红**（其余仍绿，正是审计指出的缺口） |
| 14 | `access` P2-4 / P2-5 | 变异指南引用了 5 个已改名的用例；`wasm_app_access_change` 审计**零回归网** | 指南按实际用例名更新并补一条对拍命令；新增"改访问模式才记、不改不记、明细带旧值→新值与版本号"的用例；变异：关掉审计写入 ⇒ 红 |
| 18 | `skilldist` P2-5 | 内置技能区用**一个全局** `failed` 字符串：任意一行安装失败后，**所有**未安装/可更新的行都被替换成同一句错误文案、连按钮都没了 —— 一次网络抖动把整块区域变成死墙，用户看不出是哪一行失败、也无法重试 | 失败态改为**按行**（`{name, message}`）：失败行就地显示原因 + 「重试」按钮，其余行不受影响；把"哪一行显示什么"抽成纯函数 `builtinRowState` 并加三条用例（**不依赖 jsdom**：该包没有 jsdom，这也正是审计把渲染态记为 UNVERIFIED 的原因）；变异：把判定改回"只要有人失败就全是 failed" ⇒ 1 红 |
| 17 | 门禁实测（本轮 `yarn check`） | 新增 UI 引用了 **3 个不存在的主题 token**（`--dsw-alias-separator-secondary` / `--dsw-alias-bg-invert` / `--dsw-alias-label-invert`）—— 带字面量兜底的 `var()` 不会报错，但那些颜色**不跟随明暗主题**（`check-theme-tokens` 守卫拦住） | 换成上游真实 token：分隔线 `--dsw-alias-border-l2`；主按钮 `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground`（与同仓其它主按钮一致）。守卫复跑：517 文件 / 0 提示 / 0 阻断 |
| 16 | 门禁实测（本轮 `yarn check`） | `@picoaide/dsh-wasm-apps` 的「1 MiB 载荷不爆栈」用例在空载 ~2.4s、并发下 4s+，撞上 vitest 默认 5s `testTimeout` ⇒ **门禁随机红灯**（"慢"被判成"失败"） | 该包 `vitest.config.ts` 加 `testTimeout: 30_000`（与 `@picoaide/dsh-connectors` 的同名取舍一致：只影响"真挂了要等多久才报"，不影响断言强度） |
| 15 | parent（模块交付后自查） | 技能没装时 `wasm_app_*` 失败不指路；宿主 `wasm-apps.spec.ts` 夹具仍是旧 `visible`/`login_required` 形状（契约半失效）；三处作者提示仍写 `login_required`；`THIRD_PARTY_NOTICES.md` 过期 | 见 §6.8「两处收口」+ 三处提示改写 + `verify:notices:write` 重新生成（新增 `@picoaide/dsh-wasm-apps` 条目） |

### 6.10 修复批的**独立验证**（H9）：验证发现了什么，以及门禁红过一次

H8 的 18 条由**修复者自己**做变异验证 —— 本仓纪律明确"改的人自己判自己"无效，所以另起一个
**独立验证代理**（未参与任何修复）只读复核：18 条逐条判定 + 自挑 20 组变异重做 + 五项回归检查 +
认账复核 + 第四遍四方契约对拍。报告：`temp/wasm-audit-r3/verify-h8/REPORT.md`（423 行，
证据在 `logs/`、`probes/`、`mut-*/`、`overlay/`）。

**18 条判定**：`VERIFIED_FIXED` **16** 条；`PARTIAL` 1 条（#14 变异指南还留 2 个失效用例名）；
`FIX_INTRODUCED_NEW_ISSUE` 1 条（#15 的四项自述全部成立，但**同一批的作者文档改写让服务端门禁硬红**）；
`NOT_FIXED` 0；`SELF_REPORT_INACCURATE` 0。变异 20 组全部实跑变红并逐字复原
（含四条最关键的：数据根子树否决 3 红、分片回 `UPLOAD_INCOMPLETE` 1 红、平台技能加回清单 3 红、
迁移 0071 自检对齐在真 PG 上复现出原始 `RAISE`）。

> ⚠️ **必须记住的一条**：本轮 6.9 的门禁表里写的"服务端 `go test` 零 FAIL"，是在**作者文档改写之前**
> 跑的；那次改写（§6.1 新增 + §11 改写）引入了「写 5 个产物」这句话，被 `TestSkillDiscipline` 的
> "数字必须来自 limits 表"门禁命中 ⇒ **交付面红了一段时间**（其余 gofmt/vet/limits-gen -check/
> `yarn check` 全绿，只有这一条红）。教训：（a）**改文档也会红 Go 门禁**，文档改动后必须重跑服务端套件；
> （b）"门禁绿"是有时间戳的事实，不能跨改动引用。已在 H9 修复并重跑。

**H9 修复批（验证发现 → 修法；全部带变异或复跑证据）**

| # | 来源 | 问题 | 修法 |
|---|---|---|---|
| 19 | 验证 P1-1 | 作者文档里的「写 5 个产物」被 `TestSkillDiscipline` 的"数字必须来自 limits 表"门禁命中 ⇒ **服务端套件红**，而 §6.9 自称零 FAIL | 改成逐一点名五个生成物的完整路径（不写数量），并**在文档里写明这条纪律**（"数字+量词"必须能在 limits 表里找到同量纲条目）；复跑 `go test ./internal/wasmapp/limits/` 绿 |
| 20 | 验证 P2-1 | `publishChunked` 的 `if (transportFailure !== null) break` 把**快速**传输错误（ECONNRESET，几乎不耗预算）的免费自愈也掐掉了（A/B：现状 502/1 次 PUT，去掉该行 200/4 次 PUT）；且持续断网时"刷新已收片"失败会回笼统网关信封、再次丢掉 `upload_id` | 两处一起改：①`refreshReceived` 三态化（`ok`/`response`/`transport`），传输失败不再直接回信封而是落 `UPLOAD_INCOMPLETE`；②提前退出只在 `budgetLeft() <= 0` 或**超时类**失败时发生，快速错误保留重试（"聚合墙钟有界"不变，因为单次预算就是剩余额度） |
| 21 | 验证 P2-2 | `appserver/helpers_test.go` 的变异指南仍有 2 个失效用例名（我上一轮只修了 5 个里的 4 个……实际是漏了 2 个） | 按实际用例名改（`TestClientIP` / `TestAppDBConn_PoisonMarkersFromRealErrors`），并把文件头那条自检命令写成可复制的一行 |
| 22 | 验证 P2-3 | A6 认账说过头了：客户可见的 `references/limits.md` 说明列里还有 `（R2）` 与 `R37` | 从 `limitsspec.go` 的两个说明字段里删掉需求编号（改成中性描述），重新生成；A6 措辞按实际改正 |
| 23 | 验证 P2-4 | `appcfg-contract.ts` / `.spec.ts` 的注释仍写"文件不存在时 skip"，与已修好的"缺席即红"相反 | 注释改为"缺席/改名 ⇒ 直接失败"，并把"为什么要参数化 root"的理由重写 |
| 24 | 验证 P3-1/P3-2 | 工具描述写"**本会话**已登记的工作区"比实现窄；`RATE_LIMITED`/`COMPILE_BUSY` 也会追加技能指路（那是"服务端忙"，不是作者写错） | 描述改成"已登记的工作区（本会话或同机其它已登记工作区）"；排除清单补 `RATE_LIMITED`/`COMPILE_BUSY`，但保留 `COMPILE_TIMEOUT`/`COMPILE_OOM`（产物本身的问题要指路） |
| 25 | 验证 P3-4 | `PLATFORM_SKILLS.includes(name)` 这句纵深防御单独摘掉**不会**被任何用例咬住（只有冻结清单在挡） | 新增"清单被改坏（运行时 push 平台技能）时同步仍不得把它装上"的用例（带 finally 复原导出数组 + 反向对照证明这一轮同步确实跑了）；变异：摘掉那一行 ⇒ 1 红 |
| 26 | 自查 R-1（验证前就发现、刻意等验证跑完再改） | 认不出业务信封（反代 HTML 502 / 空 body）时仍追加"去装作者手册"，与 P2-2 的"网关误指路"同类 | `skillHintAppliesTo` 无 `code` 时返回 `false`；非信封分支不再追加指路；新增"上游返回 HTML 502 ⇒ 结果里没有技能名"的用例 |

**验证的可信度旁证**：`corepack yarn check` 19/19、`check-theme-tokens` 517 文件 0 阻断、
`verify:notices` 一致、wasm-apps 100/100、enterprise 508+1 skip、`gofmt`/`vet`/`limits-gen -check` 干净；
契约四方对拍 **20 个维度 0 不一致**（验证代理自写 `contract-crosscheck.py`）；
`appcfg.json` 临时改名后**客户端 1 红 + 宿主 2 红**、还原 sha256 逐字节相同（`2853584962629c28…`/5472 B）；
`OnNotice` 噪声实测热路径 0 行、启动 1 行、冷启动 19 行（不会灌爆日志）；按行失败态无状态残留。

**验证自己记的 `UNVERIFIED`**（无复现方式，不计入结论）：真实部署环境上的端到端（无真实员工令牌）；
Windows/macOS 的 realpath 与符号链接语义（本机 Linux）；`access` 为 `null` 的畸形目录行经真实链路不可达。

**第三轮结束时的门禁（实测）**

| 项 | 结果 |
|---|---|
| `gofmt` / `go vet` / `go build ./...` | 空 / exit 0 / exit 0 |
| `picoaide-limits-gen -check`（5 个生成产物逐字节） | 一致 |
| 服务端 `go test ./internal/... ./cmd/...`（PG_DSN_TEST） | **零 FAIL** |
| `@picoaide/dsh-wasm-apps` check | **100/100 PASS** |
| `@picoaide/dsh-enterprise` test | **509 passed / 1 skipped** |
| 根守卫（layout/workflows/ci-scripts/patches/patch-resolutions/inventories/check-workspaces + `check-theme-tokens`） | **全部 OK** |
| ~~端到端验收 `temp/wasm-e2e-run.sh`（真 PG + 真服务端 + 真 wasm + 真 https 子域）~~ | ~~**68/68 PASS**（较第二轮 +7：A2 目录契约、A4 空名单正反例、A5 旧 schema 端到端 + 落库 canonical 改写）~~ **已废弃（对象已删除，W4）；现行判据见总纲 §13** |
| **`corepack yarn check`（全仓 19 个任务）** | **19 通过 / 0 失败 / 0 跳过**（含 desktop 打包门禁、connectors 真实 socket 套件、`verify-licenses/notices`） |

**H9（独立验证后的修复）之后的门禁复跑**（同一批修复全部落地后重跑，用于替换上面那张"第三轮结束时"的表）：

| 项 | 结果 |
|---|---|
| `gofmt` / `go vet` / `picoaide-limits-gen -check` | 空 / 空 / 一致（103 条目 / 配置 5 字段 / 发布 6 字段） |
| 服务端 `go test ./internal/... ./cmd/...`（PG_DSN_TEST，`-p 2`） | **零 FAIL**（含被验证指出的 `TestSkillDiscipline`——H9 #19 修好后复绿） |
| `corepack yarn check` | **19 通过 / 0 失败 / 0 跳过**（205 s） |
| `@picoaide/dsh-enterprise` / `@picoaide/dsh-wasm-apps` | **509+1skip / 100** |
| memory-evolve（coi + decoupled + plugin） | **110/110**（+1：纵深防御用例） |
| desktop 技能门禁（rank + packaged-runtime） | **48/48** |
| ~~端到端 `temp/wasm-e2e-run.sh`（真 PG + 真 wasm + 真 https 子域）~~ | ~~**68/68 PASS**~~ **已废弃（对象已删除，W4）；现行判据见总纲 §13** |

---

## 7. §12 风格认账项（H3 修复批补充，2026-09-18）

> 这些不是"待办"，而是**已知且接受**的边界 —— 写在这里是为了让评审不必读源码才发现
> 它们（本仓纪律：认账要落在纸面上，不留在注释里）。

| # | 认账项 | 事实 | 为什么接受 / 出路 |
|---|---|---|---|
| A1 | **bwrap 在嵌套容器里回落只读绑定宿主 `/proc`**（审计 P2-9） | `--proc /proc` 挂新 procfs 被内核拒（"Operation not permitted"）时回落到 `--ro-bind-try /proc /proc`：编译进程**能读到宿主进程列表**（`/proc/<pid>` 的 cmdline 等可读部分，只读，不能发信号）。回落信息进 `plan.describe()` 与启动日志，不静默 | 写面**不放宽**（沙箱内 `/` 仍是空 tmpfs、宿主文件系统不可见、netns 独立），且编译进程本来就以攻击者字节为输入、已被假设可能被攻破（§15.1 第 14 条）。出路：特权容器/宿主上跑时 procfs 回落不会发生；需要更强保证时在部署面叠加 cgroup + 专用 uid。**代码侧已在 `compile/doc.go` 的认账段写明** |
| A2 | **"唯一可写面 = 缓存目录"的准确口径是"唯一宿主可写面"**（审计 P2-11） | 沙箱内还有一块**私有 `/tmp` tmpfs** 可写（`--tmpfs /tmp`）：写入随命名空间释放，宿主字节不可见（探针实测：未绑定宿主路径写入"成功"但宿主文件内容未变） | 安全上可接受（私有、随进程消失、受 `RLIMIT_AS` 兜底）。措辞已按实际改写（`compile/doc.go` / `isolate_linux.go` / `env.go`），避免"声明比事实更强"误导评审 |
| A3 | **env 白名单在 bwrap 路径下实际是 5 项**（审计 P2-12） | 白名单本身是 4 项（PATH/TMPDIR/TZ/LANG）；bwrap 的 `--chdir /` 会**自己注入 `PWD=/`**（实测：父侧传 `PWD=/some/host/dir`，子进程读到的仍是 `/`） | 不是继承、值固定为 `/`、不含宿主信息。已在 `env.go` 的注释里如实注明，探针把它钉成"若出现则值必须是 `/`" |
| A4 | **编译缓存超上限期间发布会被拒（fail-closed）** | `AllowPublish` 把 `cache_bytes > 512 MiB` 当阻塞理由；而缓存回收（`ReclaimCache`）只在**编译后**（30 s 节流）与启动时触发。正常路径下该状态是瞬态（下一次编译收尾就回收），但**若回收持续失败**，该状态会一直拦住发布 | 这是设计要求的 fail-closed（磁盘/缓存水位不足时不接受发布）。运维可见：`/readyz` 报红灯 + 编译日志有"缓存回收失败（下次继续尝试）"。出路：修权限（缓存目录属主）/ 人工清理后重启（重启即回收） |
| A5 | **32 MiB 模块的 60 s 编译预算未实测**（§11 第 12 项） | 本仓造不出合法 32 MiB 模块（自定义段上限 4 MiB，填充放大被 `SECTION_OVERRIDE_OVERSIZE` 拒）；实测最大 2.20 MiB 冷编译 2451 ms（空载），线性外推 **32 MiB ≈ 36 s（空载）～59 s（负载）** | 结论：**60 s 预算在负载下余量接近 0**。本轮不为此造假模块（按 H3 任务口径只记录结论）；要收口需一次真 32 MiB 代码模块的专项实测，或按实测重定预算 |
| A6 | **生成的技能参考表里保留 `§x.y` 追溯列**（`skilldist` 审计 C6/P2-4；独立验证 P2-3 补正） | `references/limits.md` 的「章节」列有 74+ 处 `§4.x`/`§5.x`（指向内部设计基线）。**过程措辞已清掉**（"审计查出的真实不一致"、`§9.4`、"不在设计基线的失败语义表里"），**说明列里的需求编号也已清掉**（原 `100 MB 硬限（R2）` 与 `R37` 两处，独立验证 P2-3 指出我上一版认账说得过头了），只剩「章节」这一列 | 这一列不是"内部机制"，而是**维护者可核对的追溯标记**：同一个数字同时出现在 `limits.go`、生成物与设计文档三处，删掉它等于放弃"数值单一真源"的人工可核对面。它对客户是无害噪声（无客户名、无内部流程、无私有仓信息）。**若客户合规评审要求零内部引用**：删 `limitsspec.go` 的 `Section` 字段 + 生成器表头并重新生成即可，代价是同时失去数值↔章节的对拍门禁（需另建） |
| A7 | **`aitools` 的三条 P3 未处置**（P3 定义 = 体验/一致性微瑕；独立验证有补正） | ①上游 401/403 时白查一次 `stat`（技能安装判定在信封解析之前）②工具对 `version`/`appId`/`wasmPath`/`uploadId` 做 `trim()`，**直传**路由不 trim（分片路径对 `version` 也 trim ⇒ "两条调用面载荷不同"只在 ≤8 MiB 直传时成立，独立验证 P3-3 指出我上一版措辞过宽）③工具描述写"会话工作区内"但实现允许**全部已登记工作区** | 三条都不改变安全边界与功能正确性。②是有意的（模型常带空白，路由的调用方是 UI 表单；顺带说明"同一输入两个面载荷不同"的边界）；③描述已改成"**已登记的工作区**（本会话或同机其它已登记工作区）"；①的一次 stat 成本可忽略 |
| A8 | **FIX-48 仍未做**（上传清理调度器的计数接进 `/readyz`） | 计数已在日志里；"构造了但没 Start"已被 FIX-47 的装配级断言挡住 | 属运维可见性增强，不影响正确性。与 §6.8 的第三轮改造无关，继续挂在待办上 |
