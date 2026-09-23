# 诊断参考

> 诊断的**第一消费者是 AI**：接口返回的不是"失败了"，而是 `reason_code` + 可操作的
> `hints`。排障的正确姿势是"先读诊断，再改代码"，不要靠猜。

## 1. 信息源与各自的出口（先看清哪一样真的能读到）

| 来源 | 有什么 | 出口 | 保留 |
| --- | --- | --- | --- |
| 调用事件 | 每次请求的 `outcome` / `reason_code` / CPU / 峰值内存 / 队列等待 / 宿主调用次数与耗时 / 返回字节 / 数据库读写行数与字节 | 诊断接口（本文件） | 7 天（有界内存缓冲，批量落表；超期丢最旧并计数） |
| `log` 宿主调用 | 应用自己打的日志（单条不超过 4 KiB，每请求最多 100 条，超出丢弃并计数；换行/控制字符会被转义） | **只有服务端运维日志**（`wasm-app[<app_id>] …`），平台**没有**日志查询接口 | 随宿主日志，平台不承诺保留期 |
| 数据面 | 表结构（表/列/行数/占用）、每张表的一页行数据 | `GET …/schema`、`GET …/rows`（见 §4） | 库文件本身（100 MB/应用） |

诊断接口：`GET /api/client/v2/apps/wasm/:app_id/diagnostics`

- 缺省返回 50 条，最多 200 条（`limit` 参数）。
- 响应是**两层包装**：`{"diagnostics":{"app_id":…,"app_enabled":…,"app_frozen":…,
  "app_deleted":…,"since":…,"window_minutes":…,"retention_days":…,
  "summary":{…},"failures":[…],"hints":[…]}}` —— 概览在 `diagnostics.summary`、
  单条在 `diagnostics.failures[]`、建议在 `diagnostics.hints`（**不在** summary 里）。
- 概览字段：`total` / `ok` / `error` / `killed` / `failed`、按次数降序的 `reasons[]`
  （每条带 `reason_code`、`count`、`hints`）、去重后的 `hints[]`、
  `max_cpu_ms` / `max_peak_memory_bytes` / `max_queue_wait_ms` / `last_failure_at`。
- 单条失败记录：`created_at` / `outcome` / `reason_code` / `guest_exit_code` /
  `stderr_tail`（最多 2 KiB）/ `evidence`（分类依据，见 §3 的 `RUNTIME_MEMORY`）/
  `cpu_ms` / `peak_memory_bytes` / **`db_rows` / `db_bytes`**（这次请求的应用库读写量
  ——"写没写进去、写了几行"的直接判据）。

`outcome` 的三种取值：`ok`（正常返回）、`error`（应用或宿主报错）、`killed`
（预算耗尽/被取消/被杀）。**`error` 与 `killed` 都是失败**，不要只看 `error`。

## 2. 读诊断的固定顺序

1. 看 `reasons[0]`（次数最多那个码）——多数情况下它一个人就解释了绝大多数失败。
2. 读它的 `hints`：那是"下一步改什么"，不是错误码释义。
3. 只有 hints 不够时才下沉到单条记录：`guest_exit_code` + `stderr_tail` 能区分
   "应用自己退出"与"平台把它杀了"。
4. 改完再发布；**失败不占版本号**，可以放心用同一个号重发直到通过。

## 3. 常见 `reason_code` 怎么处理

| `reason_code` | 先看什么 | 通常怎么改 |
| --- | --- | --- |
| `RUNTIME_TIMEOUT` | `cpu_ms` 是否贴近 guest 预算（10 秒） | 拆成多次请求；检查不收敛的循环/重试；`db.query` 是分页而非全量 |
| `RUNTIME_MEMORY` | `peak_memory_bytes` 是否贴近 64 MiB | 别把大结果集一次读进内存；先 `WHERE` 收窄再聚合 |
| `RUNTIME_GUEST_EXIT` | `guest_exit_code` 与 `stderr_tail` | Go 里 `panic` 先 `recover` 再写错误响应；`os.Exit(非零)` 前必须已经写过响应帧 |
| `RUNTIME_OUTPUT_OVERRUN` | 单次响应字节数 | 单帧不超过 1 MiB，而**保证可交付**的响应体只有 168 KiB（最坏 JSON 转义下仍要装进一帧；见 `references/abi.md` §4）；大列表要分页 |
| `RUNTIME_NO_RESPONSE` | 是否有提前 `return` 的分支没写响应 | 每个分支都写且只写一帧 |
| `RUNTIME_TRAP` | `stderr_tail` 的 trap 信息 | 越界/除零/`unreachable`；加边界检查 |
| `HOST_CALL_OVER_BUDGET` | 哪一类宿主调用 | 单条 SQL 不超过 5 秒；把长任务拆开 |
| `DB_DENIED` | 具体被拒的语句，以及 `details.reason` | 一次只发一条语句；只用 `SELECT`/`INSERT`/`UPDATE`/`DELETE`；建表走 `db.define`；不碰保留行号列。**参数化不是平台检查项**：字面量 SQL 一样通过，值要用 `args` 占位自己挡住注入。`reason = statement_timeout` 时**不是 SQL 写错**，而是单语句超过 5 秒（加条件/加 `LIMIT`，或拆成多次调用） |
| `DB_LIMIT` | 是不是「库写满」（507 **只有**这一个含义，外加单行超过 168 KiB 这一种"一行都返回不了"） | 库满 100 MB 是硬上限（平台不给扩容旋钮）⇒ 清理历史数据或做汇总表。**行数/字节超限不报错**：`db.query` 截断并置 `truncated=true` ⇒ 按它分页（`LIMIT`/`OFFSET`）；语句超时看上一行的 `DB_DENIED` |
| `APP_QUEUE_FULL` | `max_queue_wait_ms` | 应用侧并发压到 1；收到 429 按 `Retry-After`（1 秒）退避，不要立刻重试；把多次小请求合并 |
| 客户端 AI loop 错误码（`app_ai_denied` / `app_ai_unavailable` / `app_ai_invalid` / `ai_balance_insufficient` / `ai_rate_limited` / `ai_cancelled`） | 应用前端的 `fetch('/__picoaide/ai/chat')` 返回（**不是** wasm 的 `reason_code`：wasm 侧没有任何 AI 能力，日志里不会出现 AI 宿主错误码） | 未授权 ⇒ 引导使用者到**应用详情页的 AI 面板**点「撤销授权」旁边的授权入口重新授权（撤销入口只有这一个，设置页里没有）；宿主不可用 ⇒ 提示稍后重试，**不要绕回 wasm 侧自己实现**；请求体不合法 ⇒ 检查 `messages` 条数与单条长度；余额不足 ⇒ 提示去桌面客户端看余额，**不显示金额、不要重试**；限流 ⇒ 稍后重试、不要在循环里猛调；`ai_cancelled` ⇒ 页面关闭/主动取消导致的正常收尾，不要当故障 |
| `AUTH_REQUIRED` | `auth.mode` / 请求是否来自登录态 | 平台一律要求登录（没有匿名面；历史 `public` 配置读取侧按 `login` 处理）：确认请求来自已登录的客户端，或引导用户先登录 |
| `MODULE_KILLED` | 请求是否被取消（用户关页面/超时） | 与超时同处理：拆小、缩短单次工作 |

平台侧与发布侧的错误码（`IMPORT_*`、`SECTION_*`、`COMPILE_*`、`APP_CONFIG_INVALID`、
`VERSION_*` 等）见 `references/abi.md` 的失败语义表 —— 它们大多在**预检**阶段就会返回，
改完直接重发即可。

## 4. 别把这些当"偶发"

- 同一个 `reason_code` 反复出现：**它一定是确定性的**，改动代码而不是重试。
- 只在人多的时候失败：先看队列（`APP_QUEUE_FULL` / 429）与单语句耗时，
  不要靠"调大并发"解决 —— 并发对作者不可调（运维可在控制台「应用中心 → 限制项」改全局值）：
  同一应用默认最多 4 个请求并发（读并发；**写仍串行**），但单个用户在同一应用内默认只有 1 路；
  队列 32、每用户同应用排队 4 个、每用户跨应用在跑 4 个、全局实例 32 都是**默认值**，
  不是固定值（队列可调到 4096、全局实例可调到 256），队列满即 429。
- 只在某些人身上失败：先看"无权限页显示的那个账号"是否与白名单拼写一致
  （平台不校验账号是否存在）。

## 4. 看数据：schema 与 rows（2026-09-21 新增）

"数据对不对"这一类问题，诊断答不了（它只有失败码与计量）。平台补了**只读数据面**，
两条都是**仅发布者本人**（他人一律 404，与"应用不存在"同形），且每次调用写审计：

| 接口 / 工具 | 用途 |
| --- | --- |
| `GET …/wasm/:app_id/schema` / 工具 `wasm_app_schema` | 表名 / 列名与类型 / 行数 / 库体积与上限。**先跑它**：`db.define` 没生效、列名拼错、表名大小写不符都在这里现形 |
| `GET …/wasm/:app_id/rows?table=&limit=&offset=&unmask=` / 工具 `wasm_app_rows` | 某张表的一页行（缺省 50、最多 200）。返回 `total_rows` / `has_more` / `truncated_values`，翻页与截断都以这三个字段为准 |
| 工具 `wasm_app_diagnostics` | 就是本文件第 1 节的诊断接口（AI 侧的入口） |
| 客户端「应用中心 → 详情 → 数据」 | 人在图形界面里做同样的事，多一个「显示原值」按钮 |

**脱敏口径（必须知道，否则会以为数据丢了）**：服务端按列名启发式把敏感列
（`password` / `token` / `secret` / `phone` / `email` / `id_card` …）的值替换成
星号。**原值只能由人**在客户端面板里点「显示原值（会记审计）」——
`wasm_app_rows` 工具**没有** `unmask` 参数，模型自己解不掉这层保护。
看到星号不等于"没写进去"：先看 `total_rows` 与同一行的其它列。

**分页语义**：不保证稳定排序（平台不暴露内部行号列给应用，因此无法 `ORDER BY` 它）。
浏览/对账够用，但**不要**把它当作"导出/全量遍历"的接口（当前没有导出数据的端点）。
