# WASM 应用：每应用并发默认值 1 → 4（配置面接线），2026-09-19

> 用户问题原文（第 3/4 条）：「你需要检查一下，wasm 应用怎么支持高并发，不应该是每个请求串行。」
> 「sqlite 应该是支持并发读取的。高并发读取情况下会有问题，写入确实需要串行。」
>
> 本文记录**最后一公里**的决策：底层（appdb）在 2026-09-19 已改造成 WAL + 1 写 N 读 + 锁拆分，
> 但配置面与队列默认值仍然把同应用请求钉成串行 —— 默认部署下用户看到的依旧是"每个请求串行"。
> 底层改造本身见 `docs/planning/2026-09-19-wasm-platform-round2.md` §2。

## 1. 改了什么（一句话）

`limits.AppRuntimeConcurrency`（控制台字段 `app_running`）的默认值 **1 → 4**，并把只读连接数
（`app_db_readers`）接进平台限制项（`applimits`）+ 下发到运行期（`appDBPool.SetReaders`）。

## 2. 为什么是 1 → 4

### 2.1 四层串行里，队列是最后一层

"同应用串行"过去由四层叠加保证：队列 `app_running=1`、句柄池整请求互斥量、appdb 一把读写共用
的大锁、池容量 2。2026-09-19 的 appdb 改造解开了后三层（WAL + 1 写 N 读连接池 + `stateMu`/`writeMu`
拆分），实测并发读 2.2–2.4×（`BenchmarkQuerySelectParallel` 36.7µs → 16.5µs）。

此时继续把队列的 `app_running` 留在 1，用户看到的就只是**人为排队**：底层能吃并发，默认部署
却仍每请求串行。所以这一项必须与底层改造同时落地 —— 否则"支持高并发"在默认部署下不成立。

### 2.2 为什么取 4，而不是 8/16

- **与只读连接数同量级**：`limits.AppDBReaders = 4`，即"同一应用能同时跑 4 条 SELECT"是底层
  已承诺的能力；队列放行超过它只会把请求堆在 appdb 的只读槽上（没有收益，还多占实例内存）。
- **不增加内存上界**：四笔账（`readyz.MemoryPlan`）里与并发相关的只有实例池那一笔，乘数是
  **`max_instances`（全局并发，默认 32）**，不是 `app_running`；而 `Validate` 强制
  `app_running ≤ max_instances`。因此 1 → 4 **移动不了任何一笔账**（`applimits.Budget` 的
  注释 + `TestBudgetIgnoresAppRunning` 把这条钉死）。
- **全局仍然是硬闸**：全局 32 个执行槽不变，`user_global_running=4`、`user_per_app_running=1`
  不变 ⇒ 单用户仍不能靠"打同一个应用"绕过自己的并发上限。

### 2.3 写仍然串行（这是设计，不是妥协）

SQLite 单写者 + `BEGIN IMMEDIATE`：appdb 的 `writeMu` 保证同一应用同一时刻只有一条写语句在跑。
`app_running` 放宽的是**读者**，不是写者 —— 高并发读 + 串行写正是用户第 4 条要求的形态。

## 3. 对内存 / CPU 的影响

| 资源 | 影响 | 说明 |
|---|---|---|
| 实例内存（四笔账的实例池） | **不变** | 乘数是 `max_instances`，与 `app_running` 无关 |
| 实例数（同时驻留的 wasm 实例） | **不变** | 仍由全局 32 个执行槽封顶；改的只是"这 32 个槽允许有多少个落在同一个应用上"（≤4） |
| SQLite 页缓存 | **默认不变**；调 `app_db_readers` 才线性上涨 | 每连接 1 MiB（`appdb_cache_kib`），句柄上限 × (1+readers)。**这笔账不在四笔账里**（见 §5） |
| 文件描述符 | 默认不变 | 每句柄 1+N 条连接 ⇒ 默认 32 × 5 = 160 的硬上界（`limits.AppDBHandleMax` 的注释） |
| CPU | 同应用并发读会真的并行占用多核（原本被排队压成单核串行） | 这是性能收益的来源；上限仍是全局 32 |

一句话：**这项改动的代价不是内存，而是"同一个应用可以同时吃掉更多 CPU"**；内存上界由全局并发
与四笔账独立封顶。

## 4. 小机器（`small` 档）下的表现

`PICOAI_WASM_MEMORY_PROFILE=small`：全局并发 3、单实例 64 MiB、模块缓存 64 MiB（四笔账 630 MiB，
适配 2 GB 级机器）。两个连带处理：

1. **档位折算必须自洽**（本次修）：`app_running` 默认 4 > 全局 3，若不钳位，`FromProfile` 会给出
   `app_running=4 > max_instances=3` 这种**自身非法**的组合 —— 控制台 GET 出来的对象原样保存
   会被 `Validate` 拒（"单应用并发必须在 1 与全局并发之间"），即"看得见、存不回去"。
   现在 `FromProfile` 走 `clampCrossField()`：`app_running`/`user_global_running` 被压到
   `max_instances` 之内（small 档 ⇒ 3），`TestFromProfileStaysSelfConsistent` 断言三个档位
   折算后 `Validate()==nil` 且 Encode→Parse 往返成功。
2. **small 档的实际并发是 3（不是 4）**：全局槽只有 3 个，同应用最多也只能有 3 个在跑。
   语义上"每应用上限"是 3，与全局一致 —— 这是钳位的正确结果，也说明小机器不需要额外调参。

## 5. 配置面新增：`app_db_readers`（并说明页缓存这笔账的去向）

| 字段 | 默认 | 范围 | 生效方式 |
|---|---|---|---|
| `app_db_readers` | `limits.AppDBReaders` = 4 | 1 – `limits.AppDBReadersMax` = 16 | **下一个新建的应用库句柄** |

"下一个句柄生效"是**硬约束**不是偷懒：只读连接必须在 appdb 建库的**一次性令牌窗口**内一次建满
（窗口关闭后新建的连接会被连接钩子 fail-closed 拒绝，见 `appdb.Options.Readers`）⇒ 运行中的句柄
没有"加几条读者"的路径。因此它既不阻塞保存、也不要求重启（与 `appdb_cache_kib` 同档），
已有句柄在空闲回收（`appdb_idle_min`）或污染回收重建时自然跟上。

**没有新增 `app_db_busy_timeout_ms` 旋钮**（规划里曾列为可选项），理由三条：

1. 落它必须改 `appdb`：busy_timeout 目前直接读编译期常量（`limits.AppDBBusyTimeout`），
   appdb 只有 `SetConnCacheKiB` 这类 setter 的先例、没有 busy_timeout 的；本次约定不动 appdb。
2. 它与 `limits.SQLStatementBudget`（5 s 单语句硬预算）存在**硬序关系**：busy_timeout 必须严格
   小于单语句预算，否则"等待"会吃掉整条语句的预算、应用看到 `statement_timeout` 而不是"库忙"。
   把这个约束暴露成 0–5000 的自由旋钮，等于给运维一个能自伤的开关。
3. 3 s 已覆盖 WAL 下写者/读者/检查点的正常瞬时争用；观察到的真实争用都在毫秒级。

**页缓存这笔账的去向（不静默漏掉）**：四笔账只有"实例池 + 编译峰值 + 上传峰值 + 模块缓存"，
**从来不含** SQLite 页缓存（`appdb_cache_kib` 当初也不在）。它的独立上界是

```
appdb_cache_kib × (1 + app_db_readers) × 应用库句柄数（≤ max_instances）
```

默认（1024 KiB × 5 × ≤32）= 160 MiB 最坏情况常驻，且只在"这么多应用同时被访问过"时才可能达到
（句柄按 `appdb_idle_min` 空闲回收）。它不进四笔账的理由：它是**可回收的缓存**而不是实例，
不构成 OOM 的直接原因，与其它三笔也不同量级。这条口径写在 `applimits.Budget` 的注释里，
并在 `app_db_readers` 的校验 hint 里提示"调大会线性抬高这条上界"。
⚠️ 把 `app_db_readers` 调到 16 时最坏上界变成 544 MiB —— 控制台改这一项时应当同时看页缓存。

## 6. 怎么改回 1（回退路径）

按影响面从小到大：

1. **控制台**：运维 → 应用中心 → 限制项 → 把「单应用并发」改成 1 保存（`settings.wasm.limits`，
   即时生效、不重启）。适合单次观察/临时救火。
2. **环境变量/代码**（全局默认）：把 `server/internal/wasmapp/limits/limits.go` 的
   `AppConcurrency` 改回 1 —— `AppRuntimeConcurrency` 是它的别名，队列默认值、控制台默认值
   （`applimits.Defaults()`）、生成物（`limits.json`/`limits.md`/SKILL references）都跟着它走；
   改完必须重跑 `cd server && go generate ./internal/wasmapp/limits`，否则构建期门禁
   （`limits_gen_test.go` 的逐字节比对）会红。
3. **只读连接数**（与第 2 条配套）：`app_db_readers` 改回 4（或更小）；它只影响下一个句柄，
   回退不需要重启。

回退**不需要**动 appdb、不需要重启服务端；若同应用并发回退到 1，"冷应用并发首屏只开一次库"
的单飞（§7）仍然保留（它是正确性修复，不是优化）。

## 7. 同应用事务边界：**已闭合**（方案 A：每请求事务所有权校验）

### 7.1 触发条件与后果（闭合前的真实缺陷）

事务挂在**句柄的读写连接**上（appdb 的 `d.tx`），而 `db.exec` 没有"事务令牌"——
appdb 只知道"当前有没有事务"，不知道写的人是**谁**。于是：

- **触发条件**：`app_running > 1`（本改动的默认值 4）且同一应用有两个并发请求，
  其中一个开了事务（`db.tx`/`tx_begin`）而另一个在事务存续期间执行 `db.exec`。
- **后果**：第二个请求的写落进**别人的事务**里；事务持有者一回滚，那个写就被
  **静默丢掉**（第二个请求拿到的是成功）。不是报错，是数据丢失。
- 改造前不可达（队列 `app_running=1` 串行 + 句柄整请求互斥双重保证）；把默认值
  调大之后它就是默认行为 —— 所以这条边界必须在同一个改动里闭合，否则"支持高并发"
  换来的是静默丢数据。

### 7.2 闭合方式（`server/internal/wasmapp/appserver/dbpool.go` 的 `appDBConn`）

每请求一份 `appDBConn`（`serveWasm` 里 `&appDBConn{…}`）就是天然的"请求身份"，
在它上面做三件事：

1. **判据用 appdb 的权威状态**：`InTx()` 为真 **且** 事务持有者不是本请求 ⇒ 拒绝
   （`DB_DENIED` / `reason=foreign_transaction`，HTTP 403，hint 明说"另一个请求正在事务中，
   请稍后重试"）。句柄上的 `txOwner` 只用于**放行持有者自己**，不参与安全判定 ——
   所以它陈旧或丢失只会让调用被拒（fail-closed），绝不会放行。
2. **写路径（`exec`/`define`）与 `begin` 共用一把 `txGate`**：所有权检查与"调用 appdb"
   是一个原子段 ⇒ 不存在"检查时无事务、执行时已有事务"的插入窗口（那是写丢失的唯一真实入口）。
   写本来就由 appdb 的 `writeMu` 串行，所以这把闸不引入额外吞吐代价。
3. **读路径（`query`）不加闸**（加了会把读重新串行化，正好毁掉本轮并发收益），改为
   **执行前后各查一次**：与外来事务重叠的读被报成拒绝，而不是把未提交数据当已提交返回。
   残留（如实认账）：事务的打开与提交都恰好落在两条 query 之间的窗口读不到 ——
   不构成数据损坏。

**自愈**：持有者请求结束时会 `endRequest()`（尽力回滚 + 清标记，比 appdb 的 5 s 硬超时
看门狗更快），而安全判定始终看 `InTx()` ⇒ 事务被看门狗收掉后，后续请求自动恢复，
不需要重启或人工干预。

**没有改 appdb**（接口与语义不变）：修的是"谁来调用它"这一层，`db.exec` 的
"没有事务令牌"这一事实本身仍然成立 —— 只是现在**只有持有者**能走到它。

### 7.3 判据（两层，均有变异验证）

| 层次 | 用例 | 判据 |
|---|---|---|
| 包装层（确定性） | `TestAppDBConn_ForeignWriteIsRejectedWhileAnotherRequestHoldsTransaction` | A 开事务并写；B 的 `exec`/`define`/`query`/`begin` 全部 `DB_DENIED`；A 回滚后 B 立刻能写；库里只剩 B 的行（A 的被回滚） |
| 端到端（真 wasm + 真 HTTP） | `TestServe_ForeignWriteDuringTransactionIsRejected` | dbapp 的 `/slowtx` 开事务持有 1.2 s；另一个真实请求的写/读都拿到 `DB_DENIED`；A 回滚后 B 能写、库里只有 B 的行 |

**变异验证（实跑）**：把 `foreignTxError` 改成直接 `return nil`（去掉校验）⇒
①两条用例立刻变红；②临时探针复现**静默丢写**：`B 的 db.exec → rows=1 err=<nil>`，
`A 回滚后表里的行：[]`（B 的写随 A 的事务消失）。还原后同一探针给出
`rows=0 err=DB_DENIED` 与"B 的写没有丢"。

### 7.4 连带修掉的两个真实缺陷（都是 app_running>1 才暴露的）

1. **冷应用并发首屏 500（P0）**：`appdb.Open` 的 `PRAGMA journal_mode=WAL` 需要库级写锁，而
   SQLite 对"改 journal_mode"**不套用 busy_timeout 重试** ⇒ 两个请求同时为同一个冷应用 Open 时，
   一条成功、另一条 `database is locked (5) (SQLITE_BUSY)` → 500「应用执行失败」。
   老默认（`app_running=1`）下队列把同应用请求串行化，这条路径根本走不到；并发一放开，
   冷应用的并发首屏必然踩到（本改动的并发用例一跑就红）。
   修法：`appDBPool` 每个 app_id **同应用单飞**（`appDBOpenFlight`），等待者以"引用预约"的方式
   共享 leader 的句柄（不会出现"leader 先结束并关掉临时句柄、等待者拿到已关闭句柄"）。
   appdb 接口未动；WAL 争用本身已作为输入记录给 appdb owner。
2. **单用户单应用并发在 >1 时静默失效**：队列的 `appState` 原来只记**最后一个**在跑发起者
   （`runningUser int64` + "PerAppRunning 恒为 1 ⇒ 单值即可"）。`app_running=4` 之后，
   用户 B 的授权会覆盖 `runningUser` ⇒ 再查用户 A 的在跑数读到 0 ⇒ A 的第二个请求被直接放行，
   `user_per_app_running=1` 对**先来的**用户失效。修法：改成 `runningUsers map[int64]int`
   计数表（随应用条目一起回收），回归用例
   `TestSameUserCannotExceedPerAppRunningNowThatAppsRunConcurrently`。

## 8. 验证（判据与变异）

- **行为判据**（不靠墙钟比大小）：`appserver.TestServe_SameAppRequestsRunConcurrentlyByDefault`
  —— 默认装配下同应用两个慢请求：①调度器**持续**观测到该应用在跑数 == 2（重叠窗口 ≥ 单次
  hold 的一半）；②该应用**从未出现排队**（采样 `waiting` 始终为 0）⇒ 第二个请求不是
  "排队等到第一个跑完"才进的执行。实测：请求[发起→返回] 2.248 s / 2.248 s，
  `max_running=2`、`max_waiting=0`、重叠窗口 2.227 s（1964 次采样）、`max(queue_wait_ms)=0`
  （事件遥测只作观测，不作判据 —— 事件写入是旁路批量 flush，不该决定这条用例的红绿）。
  > ⚠️ 判据**不能**写成"[发起,返回] 两个区间相交"（本用例第一版就是那样）：排队等待也算在
  > "返回"里 ⇒ 串行实现下两个区间依然相交，那条断言恒真（假绿）。执行区间必须以"真的持有
  > 执行槽"为准（`max_running`/重叠窗口），并用调度器的 `waiting` 排除"等待造成的假重叠"。
- **连接数判据**：`TestAppDBPool_HandleOpensOneWriterPlusReadersConnections` 用 `/proc/self/fd`
  数出库文件被打开 **1 + app_db_readers** 次（配 1 ⇒ 2 条；默认 ⇒ 5 条），并断言"已有句柄不受
  新设置影响、下一个句柄才拿到新值"。
- **单飞判据**：`TestAppDBPool_ConcurrentFirstRequestsShareOneOpen`（4 个并发冷首屏全 200、
  池里只有 1 个句柄、fd 数 = 1+N、请求结束后引用归零）。
- **事务边界判据**：见 §7.3（包装层 + 端到端两条）。
- **升级连续性判据**：`cmd/server.TestWasmSavedLimitsFromOlderBuildStillApplies` —— 旧字段
  集合的 `settings.wasm.limits`（缺 `app_db_readers`）在真装配下仍来源=setting、已知字段逐字
  生效（128 MiB 真的进了 runtime）、缺字段补默认、无"待重启"残留。
- **变异验证（实跑）**：
  1. `limits.AppRuntimeConcurrency` 改回 1 ⇒ 并发判据必红：前置守卫先红
     （"默认每应用并发 = 1"）；把守卫摘掉后行为判据也红，现场形态为
     `max_running=0、max_waiting=1、重叠窗口 0s、queue_wait_ms=2138`；
     同一变异还让 `limits` 包的生成物门禁变红（单源纪律生效）。
  2. `foreignTxError` 直接 `return nil` ⇒ 两条事务用例变红 + 临时探针复现静默丢写
     （见 §7.3）。

## 9. 待接线清单（含 webadmin，另一代理负责，勿在本改动里重复改）

### 9.1 webadmin 表单（`server/webadmin/src/pages/app-center/Limits.tsx`）

① 新增 `app_db_readers`（并发分组或内存分组，hint 写"下一个应用库句柄生效"）；
② `app_running` 的 hint 现在是「同一应用同时处理的请求数（应用库是一应用一连接，串行执行）」——
"串行执行"已过时，应改为「同一应用最多 N 个并发请求（读并发；**写仍串行**；事务期间的
外部读写会被拒）」；
③ `user_per_app_running` 的 hint「通常为 1：一个用户在同一应用内串行」改为「通常为 1：单个用户
在同一应用内仍串行（每应用并发放宽的是不同用户/读并发）」；
④ 类型定义与测试夹具（`Limits.tsx` 的 `Limits` 接口、`AppPlatform.test.tsx` /
`AppCenterLayout.test.tsx` 的 fixture）补 `app_db_readers`，并把 `app_running` 的 fixture 值
从 1 更新为新默认 4（否则表单会把默认值渲染成 1）。

表单顺序由服务端 `applimits.FieldNames()` 决定（已把 `app_db_readers` 排在 `appdb_cache_kib`
之后），页面若硬编码顺序需同步。

### 9.2 服务端文案（本轮**未改**的文件，按硬约束属其他 owner 的面）

| 位置 | 现状 | 应改为 |
|---|---|---|
| `server/internal/wasmapp/apperr/apperr.go` 的 `CommonHints[CodeAppQueueFull]` | 「应用当前请求过多（每应用并发 1、队列 32），请稍后重试」 | 不要硬写并发数：「应用当前请求过多（队列 32），请稍后重试」——并发上限现在由控制台 `app_running` 决定 |
| `server/internal/wasmapp/readyz/readyz_test.go`（三处） | 注释「每应用并发恒为 1（§4.6）⇒ 占满全局槽必须用不同应用」 | 行为仍然正确（那些用例本就一应用一槽），但注释已过时：改为「占满全局槽用不同应用（与每应用上限无关）」 |
| `server/internal/wasmapp/abi/abi.go:368` 的注释 | 「`tx_begin`：事务不可嵌套 —— "每应用一连接 + 并发恒为 1"的前提会失效」 | 前提已变（并发默认 4）：事务不可嵌套的理由改为"同时最多一个事务"，并说明**事务所有权按请求隔离**（见 dbpool.go 的 appDBConn） |

## 9.3 测试纪律（默认值变更的必要配套）

**默认值变更后，凡验证队列/排队语义的测试都必须显式声明上限（`queue.Options{PerAppRunning: …}`），
不得依赖默认值。** 依赖默认值的用例会与"默认值"这一事实互斥：`appserver` 的
`TestServe_QueueFullIs429WithRetryAfter` 原来靠"默认 1"才能让第二个请求进队列，默认改 4 之后
第二请求直接开跑、用例等不到入队（实测红）。本次已把它显式改成 `PerAppRunning: 1`
（判据仍是"队列满如何表现"，语义不变），并逐个核对了同族用例：

| 用例 | 依赖形态 | 处置 |
|---|---|---|
| `queue.TestPerAppConcurrencyLimit` | 用 `o.PerAppRunning`（自适应默认值） | 保留 + 前置断言"默认值必须 > 1" |
| `queue.TestPerAppSerialWhenLimitIsOne` | 显式 `Options{PerAppRunning: 1}` | 保留（钉住"上限可配成 1 时仍串行"） |
| `queue.TestAppQueueFull` / `TestPerUserPerAppQueued` / `TestQueuedRequestRunsAfterRelease` / `TestHeadOfLineSkipped` | 用 `o.PerAppRunning` 个不同用户**占满在跑槽** | 逐个改为显式占满（语义不变） |
| `appserver.TestServe_QueueFullIs429WithRetryAfter` | 原来隐含依赖"默认 1" | 显式 `PerAppRunning: 1` |
| `readyz.TestSnapshotExecutorFull` 等三条 | 用不同应用占满**全局**槽（与每应用上限无关） | 行为不受影响；注释"每应用并发恒为 1"已过时，列入 §9.2 待接线 |

## 10. 升级连续性（本轮顺带闭合）

字段集合会随版本增长（本轮新增 `app_db_readers`），而**读取**已落库设置这条路径原先沿用
控制台 PUT 的严格解析（"字段必须完整"）。已发布的 v2.7.6-beta.4 里
`settings.wasm.limits` 存的是旧字段集合 ⇒ 升级后会被判非法、整体回落部署档位
（管理员看到的是"我的设置没了"，日志只有一条 warning）。

现改为读取路径前向兼容（`applimits.ParseStored`，只服务读取）：

- **缺失字段 ⇒ 补默认**（新版本新增的字段在老设置里必然缺失；显式保存过的值照旧生效）；
- **未知字段 ⇒ 忽略**（回滚场景：新二进制不认识的字段不该让整份设置作废）；
- **校验不打折**：补齐后的整份值仍走 `Validate()`；控制台 PUT 仍走严格 `Parse`
  （"必须提交完整对象"的纪律只属于写入侧）。

判据：`applimits.TestParseStoredIsForwardCompatible`（旧设置读出、已知字段保留、未知字段忽略、
补齐后仍非法要拒、严格 Parse 仍拒片段）+ `cmd/server.TestWasmSavedLimitsFromOlderBuildStillApplies`
（真装配：来源仍是 setting、128 MiB 进了 runtime、缺字段补默认、无待重启残留）。
