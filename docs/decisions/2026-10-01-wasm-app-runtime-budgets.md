# WASM 应用的时间预算收进控制台（2026-10-01）

> 决策记录。起因是现场一个用户自建的「PDF 打水印」应用：单次请求要解析并重新编码
> 整份文档、启动阶段本身就要十几秒，而平台的 guest 执行预算当时是 **10 s**、
> 发布/预检的干跑预算是 **2 s** —— 前者让正常请求被超时杀掉，后者让它**根本发不出去**。
> 状态：**已实施**；判据与验证链见文末。

## 背景：数值为什么在编译期

`internal/wasmapp/limits` 是平台全部上限的**单一真源**（§5.5），时间预算自然也在那里：
`GuestBudget` / `DryRunBudget` / `RequestWallClock` / `HostCallBudgetDefault` /
`SQLStatementBudget` / `CompileTimeout`。这套做法对**协议常量与安全不变量**是对的
（改一次就该重新评审），但对"某个应用就是慢"这类**部署差异**是错的：线上遇到慢应用，
过去唯一的出路是重新构建镜像。

2026-09-19 已经为**并发与内存**解决过同一个问题（`applimits` + 控制台「运维 → 应用平台」，
11 项，控制台 > 部署档位 > 编译期默认）。这次是把**时间预算**按同一条路收进去 ——
不是新机制，是同一机制补齐一个轴。

## 裁决一：默认值放宽（guest 10 s → 30 s，干跑 2 s → 30 s）

- `GuestBudget` **10 s → 30 s**。端到端墙钟仍是 60 s ⇒ 序关系 `墙钟 > guest` 留有一倍余量。
- `DryRunBudget` **2 s → 30 s**，**与 guest 预算同值**。

第二条是本裁决的关键：干跑存在的理由是回答"**这次运行到底能不能跑起来**"
（编译通过 ≠ 能跑）。它的预算比真实执行**更短**时，它就不再回答那个问题，而是变成
"预检拒绝了一个线上其实跑得动的应用" —— 现场正是这个形态。因此判据里加了一条
**默认值必须相等**的断言（`limits_gen_test.go`），而不是各写各的。

## 裁决二：六项全部做成后台可配置，粒度=全局一套

新增六个控制台字段（`applimits.Limits`，与既有 11 项同形）：

| 字段 | 默认 | 语义 |
|---|---|---|
| `guest_budget_seconds` | 30 | 应用单次请求里真正执行的时长上限（等宿主调用时暂停计时） |
| `dry_run_budget_seconds` | 30 | 发布/预检期合成帧干跑的 guest 预算 |
| `host_call_budget_seconds` | 5 | `db.*` / `log` / `assets.read` 的兜底预算（**不被**暂停计时覆盖） |
| `request_wall_clock_seconds` | 60 | 请求端到端墙钟（含排队），到点即拒 |
| `sql_statement_budget_seconds` | 5 | 单条 SQL 硬超时（到点回滚 + 打污染标记） |
| `compile_timeout_seconds` | 60 | 单次编译（含执行侧装载模块）超时 |

**为什么不做成"每个应用一套"**：平台的并发模型是全局槽位（`max_instances`），
按应用放开预算等于让"谁的应用更慢"决定谁能占住槽位；全局一套 + 明确的默认值
在语义上可解释，也与既有 11 项一致。真需要按应用放开时，那是另一个决策。

## 裁决三：序关系必须在**保存路径**上再判一遍

这五条序关系过去只写在编译期测试里：`墙钟 > guest`、`干跑 ≤ guest`、`宿主调用 ≤ guest`、
`单条 SQL ≤ 墙钟`、`编译 ≤ ReadTimeout`。数值一旦可由控制台改，**编译期断言就管不到线上
组合了** —— 控制台完全可以把 guest 调到 120 s 而墙钟留在 60 s，于是每个慢应用都被墙钟
先拒，而界面上一切正常。

因此 `applimits.Validate()` 里按同一批判据重判（保存时 fail-loud，错误信封点名字段），
`clampCrossField()` 同步扩展（它只**向下取小**，绝不放宽用户设的值）。
两处读的都是 `limits` 包的常量，不是两份独立规则。

**上界的取舍**：通用上限 300 s，guest 单独 120 s。理由不是"机器扛不住"，而是
**槽位占用**——单次请求最长就是这个数，而全局并发有限（小机器 3），5 分钟已经能让
三个慢请求把平台占满；再往上应当改应用设计（拆成多次请求），而不是继续放宽闸门。

## 裁决四：控制台的值必须真的到达**每一个**消费点

这是本次最容易做成"半生效"的地方，逐点核对过：

| 消费点 | 取值来源 | 生效时机 |
|---|---|---|
| 应用请求的 guest 预算 | `appserver.serveWasm` → `CurrentLimits().GuestBudget()` | 每次请求 |
| 请求端到端墙钟 | `appserver.serveWasm` 的入口 ctx | 每次请求 |
| 发布/预检干跑预算 | `api.publish` → 注入的 `Options.Limits` 闭包 | 每次发布 |
| 发布期编译超时（外层 ctx） | 同上 | 每次发布 |
| 执行侧冷编译超时 | `appserver.compileRelease` → `CurrentLimits()` | 每次冷编译 |
| **编译子进程 argv `-timeout`** | `compile.Compiler.SetTimeout`（原子） | 下一次编译 |
| 单条 SQL 硬超时 | `appdb.SetStatementBudget`（原子） | **下一个应用库句柄** |
| 墙钟错误明细 `wall_clock_ms` | `queue.Options.WallClock` | 保存即生效 |

三处**看起来能省、实际会静默失效**的点，各留了说明：

1. **编译子进程的 `-timeout`**：编译超时进的是子进程 argv。只在构造期固化的话，
   控制台调大之后子进程仍按旧值自杀 —— 界面上是新值、实际按旧值跑。现由
   `cmd/server` 的 `applyAll` 用**同一份 Limits** 同时下发给编译器与 appserver。
2. **单条 SQL 超时**：预算在 `Open` 时固化进应用库句柄，所以语义是"下一个句柄生效"
   （与 `appdb_cache_kib` 同档），控制台文案照此写，不宣称即时。
3. **错误文案里的数字**：`diag` 的三条建议与 `appdb` 的超时明细过去直接引用编译期常量。
   现在 `diag` 用占位符 + 按生效值渲染（`HintsForLimits`，与既有的
   `HintsForMemoryPages` 同形），`appdb` 用**句柄自己的预算**。留一个旧数字在提示里，
   作者会按过期的数字去优化（R1-rt-25 的同一形态）。

## 判据（每条都能真的红）

- `applimits`：默认值等于 `limits` 常量（含 guest==30s、干跑==guest）、六项的取值区间、
  **六条序关系的保存期拒绝**（逐条子用例 + 点名 `details.field`）、往返编解码、
  `clampCrossField` 只收不放；正控是"默认值必须合法"（防"Validate 恒拒"的假绿）。
- `limits`：`TestCriticalValuesAndOrdering` 增加"干跑预算 == guest 预算"的默认值断言；
  `TestSkillDiscipline` 守着作者手册里的每个数字都必须来自 limits 表。
- `diag`：新增 `TestBudgetTokensAppearInTable` —— 占位符是两处字面量（渲染器常量 +
  表里的 token），只改一处时替换静默无效、其余断言全绿，所以这条必须单独钉。
- 生成物：`limits.json` / `limits.md` / 内置技能 `references/limits.md` 由
  `cmd/picoaide-limits-gen` 重生成，`limits_gen_test` 逐字节对拍。
- 作者手册（`server/skills/app-builder/`）里引用这几个数字的 5 处一并更新，
  并注明"默认值、控制台可调"；技能内容变 ⇒ `SKILL.md` version 2.10.0 → **2.11.0**
  + `seededSkillDigests` / `seededSkillVersion` 同步（R1-pm-8，四处缺一即红）。

## 未做（明确认账）

- **不做每应用覆盖**（见裁决二）。
- **`client_upload_timeout`（90 s）与 `server_read_timeout`（60 s）不进控制台**：
  它们是 HTTP 传输层常量，且 `客户端上传超时 > 服务端 ReadTimeout` 是 §10.5 第 58 项的
  配置断言；`compile_timeout_seconds` 的上界直接取 `ServerReadTimeout`，所以用户仍然
  改不动这条关系。
- **预算不随部署档位（memprofile）缩放**：档位管的是内存四笔账，与时间无关；
  `FromProfile` 不动这六项。
