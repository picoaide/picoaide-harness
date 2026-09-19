# 诊断参考

> 诊断的**第一消费者是 AI**：接口返回的不是"失败了"，而是 `reason_code` + 可操作的
> `hints`。排障的正确姿势是"先读诊断，再改代码"，不要靠猜。

## 1. 三个信息源

| 来源 | 有什么 | 保留 |
| --- | --- | --- |
| `log` 宿主调用 | 应用自己打的日志（单条不超过 4 KiB，每请求最多 100 条，超出丢弃并计数） | 7 天 |
| 调用事件 | 每次请求的 `outcome` / `reason_code` / CPU / 峰值内存 / 队列等待 / 宿主调用次数与耗时 / 返回字节 / 数据库读写行数与字节 | 7 天（有界内存缓冲，批量落表；超期丢最旧并计数） |
| 诊断接口 | 上面两者的聚合视图：最近的失败与被杀记录（含 guest 退出码与 stderr 尾巴） | 随调用事件 |

诊断接口：`GET /api/client/v2/apps/wasm/:app_id/diagnostics`

- 缺省返回 50 条，最多 200 条（`limit` 参数）。
- 概览字段：`total` / `ok` / `error` / `killed` / `failed`、按次数降序的 `reasons[]`
  （每条带 `reason_code`、`count`、`hints`）、去重后的 `hints[]`、
  `max_cpu_ms` / `max_peak_memory_bytes` / `max_queue_wait_ms` / `last_failure_at`。
- 单条失败记录：`created_at` / `outcome` / `reason_code` / `guest_exit_code` /
  `stderr_tail`（最多 2 KiB）/ `cpu_ms` / `peak_memory_bytes`。

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
| `RUNTIME_OUTPUT_OVERRUN` | 单次响应字节数 | 单帧不超过 1 MiB、响应体不超过 8 MiB；大列表要分页 |
| `RUNTIME_NO_RESPONSE` | 是否有提前 `return` 的分支没写响应 | 每个分支都写且只写一帧 |
| `RUNTIME_TRAP` | `stderr_tail` 的 trap 信息 | 越界/除零/`unreachable`；加边界检查 |
| `HOST_CALL_OVER_BUDGET` | 哪一类宿主调用 | 单条 SQL 不超过 5 秒；把长任务拆开 |
| `DB_DENIED` | 具体被拒的语句 | 一次只发一条语句；只用 `SELECT`/`INSERT`/`UPDATE`/`DELETE`；建表走 `db.define`；不碰保留行号列。**参数化不是平台检查项**：字面量 SQL 一样通过，值要用 `args` 占位自己挡住注入 |
| `DB_LIMIT` | 是"库满"还是"行数/字节超" | 库满 100 MB 是硬上限（平台不给扩容旋钮）⇒ 清理历史数据或做汇总表；返回超 5000 行 / 8 MiB ⇒ 加 `LIMIT` 分页 |
| `APP_QUEUE_FULL` | `max_queue_wait_ms` | 应用侧并发压到 1；收到 429 按 `Retry-After`（1 秒）退避，不要立刻重试；把多次小请求合并 |
| 前端桥错误码（`app_ai_denied` / `app_ai_unavailable` / `ai_balance_insufficient` / `ai_rate_limited` / `ai_cancelled`） | 应用前端的 `fetch` 返回（**不是** wasm 的 `reason_code`：wasm 侧已随服务端删除，日志里不会再出现 `AI_*` 宿主错误码） | 未授权 ⇒ 引导使用者完成一次性授权（授权按 使用者 × 应用 记录，可在客户端设置里撤销）；宿主不可用 ⇒ 提示稍后重试，不要绕回 wasm 侧自己实现；余额不足 ⇒ 提示去桌面客户端看余额，**不显示金额、不要重试**；限流 ⇒ 稍后重试、不要在循环里猛调；`ai_cancelled` ⇒ 页面关闭/主动取消导致的正常收尾，不要当故障 |
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
