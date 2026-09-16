# 2026-09-16 内置浏览器「一连串 tool call timed out after 30000ms」诊断报告（用户闸预算 vs 工具预算）

诊断对象：客户渠道桌面客户端 **v2.7.4（macOS）**。
数据源：客户会话包 `dsh-session-session-88502514-b5ac-4e41-be91-765db8b96fc1.zip`
（`session.v3.jsonl`，394 行，2026-09-15 20:25:34 → 21:01:55，中文时区）+ 本仓源码对拍。

## 一句话结论

**不是页面卡死、不是 CDP 断线、不是网络慢：用户在内置浏览器里点了「我来操作」拿走控制权之后
没有交还**（AI 在 20:30:18 主动 `browser_takeover` 把控制权交给用户去登录销售易，用户登录完只在
聊天里说"我已经登录"），于是 agent 的每一次浏览器调用都排在**用户闸**后面等 —— 而闸门预算是
**300s**、工具预算是 **30s**，上游 `guard/timeout-policy` 先把整个调用替换成了
`Error: tool call timed out after 30000ms`，2026-09-15 特意加的明确错误
（`window-controlled`「等待用户交还浏览器超时」）**一次都没能送达模型**。会话里 13 次超时全部
落在走闸门的工具上，纯读元数据的 `browser_list_tabs` 反而 0 秒返回。

## 1. 现场证据

### 1.1 超时分布（13 次）

| 时间 | 工具 | 结果 |
| --- | --- | --- |
| 20:27:05 | `browser_get_snapshot` | 30s 超时 |
| 20:27:40 | `browser_navigate` | 30s 超时 |
| 20:45:11 | `browser_screenshot` | 30s 超时 |
| 20:52:32 / 20:53:04 / 20:53:46 | `browser_eval` / `browser_get_text` / `browser_wait_for` | 30s / 30s / 40s 超时 |
| 20:54:18 → 20:57:37 | `browser_eval` / `browser_navigate` / `browser_reload` / `browser_open` / `browser_close_tab` / `browser_open` / `browser_open` | 各 30s 超时 |

同一时段内 **0 秒返回**的调用：`browser_list_tabs`（6 次）、`browser_bookmarks_list`、
`browser_history_search`、`browser_credentials_list`。

判据：超时的全是经 `runtime.withAgentAttribution → TabPool.withOperation` 走全局互斥与用户闸的工具；
秒回的全是只读 store / 池子元数据、**不经过闸门**的工具（`tools.ts` 里它们的 run 不调 `agentRun`）。

### 1.2 排他性证据

- `browser_open`（只新建一个空白标签，不碰页面渲染）与 `browser_close_tab` 同样卡满 30s
  ⇒ 排除"页面死循环 / 渲染进程忙 / CDP 断线"（这两条都不需要页面主线程）。
- 同一时间 `browser_list_tabs` 里标签标题仍在更新（`Login | Neocrm` → `首页-销售易`）
  ⇒ 浏览器进程、CDP、事件通道都活着。
- 唯一能同时解释以上两点的机制就是**用户闸门**（`pool.controlled === true` 时 agent 操作只轮询等待）。

### 1.3 用户确实持有控制权

- 20:30:18 `browser_takeover` → 工具返回 `Control handed to the user.`。
- 遮罩模式下整窗上锁、只有 pill 可点（`runtime.effectiveOverlayMode()`：`!controlled ⇒ 'mask'`），
  而 20:45 → 20:52 之间标签从登录页变成 `首页-销售易`、可见标签由 2 切到 3
  ⇒ 当时窗口是解锁的，即 `controlled === true`（用户在用浏览器）。

### 1.4 客户端版本指纹：v2.7.4

用会话内 system prompt / 工具描述与各 tag 源码对拍：

- system prompt 第 4 条 `only the user gives control back (交给 AI) — never ask for it back…`
  只存在于 ≥ `v2.7.4-beta.5`；
- `browser_wait_for` 的 `bounded at 40000 ms`、`browser_eval` 的 `the refusal is receiver-aware`
  同样只在 v2.7.4 线出现。

⇒ `v2.7.4-beta.1` 修的"蒙版分区导致点『我来操作』整轮 401"（PR #68）**不在本次嫌疑范围**：
按设计用户点「交给 AI」是有效的，本次更像是用户没有点。

## 2. 根因链（代码锚点）

1. 用户持有控制权 ⇒ `TabPool.windowControlled = true`（`pool.ts`）。
2. agent 操作 `TabPool.withOperation` → `PoolMutex.run(work, gate, signal, gateBudgetMs)`，
   `gate()` 就是 `() => this.windowControlled`；闸门关闭时每 120ms 轮询一次。
3. 闸门预算来自 `POOL_DEFAULTS.userGateTimeoutMs`，原值 **300_000ms**；
   而每个 `browser_*` 工具注册的 `timeoutMs` 是 **30_000ms**（`browser_wait_for` 40_000ms）。
4. 30s 一到，上游 `deepseek-harness/packages/guard/timeout-policy/src/index.ts:42` 把结果替换成
   `Error: tool call timed out after 30000ms` —— **工具内部再清楚的错误也没有机会送达**。
5. 模型拿到的是"超时"，只能猜：先怀疑 SPA 无限重渲染，再怀疑 CDP 卡死，重试 10 次、耗时 25 分钟，
   最后用 bash + CDP 直连**用户自己的 Chrome**（`127.0.0.1:9333`，lsof 证实是 Google Chrome）才把数据取出来。

## 3. 修复（本仓库）

| 缺陷 | 修法 |
| --- | --- |
| 预算倒挂（P0） | 新增 `src/budgets.ts` 作为唯一真源：`BROWSER_TOOL_TIMEOUT_MS = 30_000`、`USER_GATE_RESERVE_MS = 20_000`、`USER_GATE_TIMEOUT_MS = 10_000`；`POOL_DEFAULTS.userGateTimeoutMs` 改用它。闸门拒绝文案统一为「用户正在操作浏览器（我来操作）—— 请在浏览器窗口点「交给 AI」交还控制权后重试」 |
| 状态对模型不可见（P0） | `browser_list_tabs` 增加 `control` 字段（`controlled/busy/busyTool/awaitingRelease/awaitingReleaseTool`），渲染时在有控制权争议时追加一行 `USER HOLDS CONTROL…`；system prompt 第 4 条同步说明"这不是页面坏了" |
| 状态对用户不可见（P0） | runtime 记录"被闸门挡住"这一状态（`gateBlock`，一次控制权周期只记一条 op + 一条 `state` 事件），随 `/api/pico/browser/state` 的 `awaitingRelease` 下发；侧边栏浏览器入口在等待时着色 + 警示圆点 + 文案/tooltip「AI 正在等你交还浏览器控制权…」 |
| `controlled` 比池子活得久（P1） | `TabPool.clear()`（关闭浏览器 / 窗口销毁 / 切换会话或分区 / 清数据）同时 `setUserControl(false)`，与 2026-09-15 P1-1 的会话切换修复同一口径 |

测试：`tests/audit-0916-user-gate.spec.ts`（预算不变量 / list_tabs 模型面 / 侧边栏投影）、
`tests/pool.spec.ts`（默认预算取自 budgets、拒绝文案可执行、clear 复位）、
`tests/runtime.spec.ts`（`awaitingRelease` 上报、一次周期只记一条 op、交还即清除）。
三条修复都做了变异验证（把缺省改回 300s / 去掉渲染提示 / 去掉状态记录，对应用例必红）。

## 4. 仍然要认账的部分

- **不弹窗**：本次没有让被挡住的 AI 主动把浏览器窗口弹到前台，也没有发系统通知 —— 提示只落在
  侧边栏入口与工具错误里。是否要更"打扰"的提示留给产品决策。
- **无法从会话包证明用户是否点过「交给 AI」**：会话日志只有模型侧记录，浏览器 op log 不落盘。
  可复核对证：客户机 `<userData>/browser-store/<user>/history.jsonl`（该时段 `actor:"user"` 的访问）
  与 `<userData>/logs/dsh-*.log`（同窗口是否出现 `refused a local write without browser proof`）。
  若曾出现拒绝日志 ⇒ 那是"点了但没生效"的另一个 bug，需要单独跟进。
- **模型绕道用户个人 Chrome（CDP 9333）取数成功**：绕过内置浏览器的准入/脱敏/审计。本次用户
  自己开了远程调试端口且数据属于该用户，但这个边界（是否允许、是否在沙箱/网络层收敛）仍需拍板。
- `browser_eval` 会把长得像密钥的长十六进制串（如钉钉转写 URL）整串打成 `****`，本次让模型两次
  误判页面内容 —— 误报，未在本次修改。
