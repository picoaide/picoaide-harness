# 余额 / 配额 / 预算 整体重构设计（2026-09-11）

> 状态：**已实施**（服务端 + webadmin + 客户端，2026-09-11）。
> 触发：2026-09-11 对服务端「钱」相关实现的专项审计（本文 §1 是审计结论的存档）。
>
> **范围修订（用户 2026-09-11 拍板）**：不仅部门预算，**员工 token 配额与金额配额也一并删除** ——
> 员工侧只保留「账户余额」与「按月发放余额」两个概念。§2 起按此口径描述，§14 是实施记录。
> 关联：`docs/decisions/2026-09-02-usage-center-redesign.md`（用量中心 IA）、
> `docs/decisions/2026-09-11-balance-and-audit-fixes.md`（0061 初版余额与第一轮修正）。
> 实施记录在本文 §12 按阶段追加。

---

## 1. 问题（为什么必须重构）

现状同时存在 **4 套"员工能花多少钱"的机制 + 1 个同名的"渠道余额"**：

| # | 概念 | 存储 | 口径 | 记账 | 拦人 | 编辑入口 | 员工可见 |
|---|---|---|---|---|---|---|---|
| 1 | 员工余额 | `users.balance_money` | 存量、跨月 | 与 usage 同事务扣（**仅闸门开启时**） | 硬 429 | `/users` 顶部卡片 | 账户卡主数字 |
| 2 | 员工金额配额 | `users.quota_money` / `usage.monthly_quota_money` | 北京月流量上限 | 请求前比对 `SUM(cost)` | 软 | `/usage/quota` | 有余额时**整块消失** |
| 3 | 部门预算 | `groups.budget_money` | 月、部门树合计 | 请求前比对 | 软 | `/departments` | **结构性不可见** |
| 4 | token 配额 | `users.quota_tokens` / `usage.monthly_quota` | 月 token | 请求前比对 | 软 | `/usage/quota` | 账户卡 |
| 5 | 渠道余额 | 上游 `/user/balance` | 账户级实时 | HTTP 拉取 | 否（展示） | 无 | 否 |

审计确认的问题（P=问题编号，实施时按此对照）：

**A. 确定性缺陷**

- **P1 ✅ 实测** 「设为 0」被服务端拒绝但 UI 允许：`serverauth/admin.go:1885` 对所有 mode 统一 `amount <= 0 → 400`，
  而 `webadmin/src/pages/Users.tsx:441,447,965` 允许并提示「例如 0」。实测 `{"mode":"set","amount":0}` → 400 `VALIDATION`。
- **P2 ✅ 实测** 分以下残值无法清零：记账微元（`serverstore/balance.go:288`）vs 展示 2 位小数（`webadmin/src/lib/format.ts:45`），
  扣减不允许结果为负（`balance.go:225`）→ 余额 0.004（显示 `¥0.00`）时扣 0.01 报 `ErrValidation`。
- **P3** 三层精度不一致 → 判定与展示必然错位：记账 `1e-6` / 网关闸门 `moneyEpsilon=0.005`（`llmgateway/handler.go:720,745`）/
  客户端转红阈值 `<= 0`（`packages/client/account-card/src/client/AccountCard.tsx:381`）。余额 0.004 时服务端已 429，卡片仍是正常色 `¥0.00`。
- **P4** 网关余额闸门零回归测试：`QUOTA_EXCEEDED` 断言只覆盖 token/金额配额与 embedding，没有任何用例开关 `balance.enabled` 断言 429。
- **P5** webadmin 文案与实现相反：闸门关闭写「仅记账不拦截」（`Users.tsx:572`），实际关闭时**完全不扣余额**（`serverstore/usage.go:239,299`）。
- **P6** 审计动作未登记：`webadmin/src/pages/Audit.tsx:23-52` 缺 `balance_adjust` / `balance_settings` / `balance_grant` /
  `quota_default_change` → 审计页筛选下拉选不到、列表显示英文原文（审计员角色的全部职责就是读它）。
- **P7** 抢发放锚点失败时返回 `grant=nil`（`serverstore/balance.go:185-192` 先 Rollback 再读），
  `admin.go:1997` 回 `{already:true,grant:null}` → 前端渲染「本月已发放过()」。
- **P8** 扣减只减不补：`deductBalance` 对 `amount <= 0` 直接返回（`balance.go:284`），而 `usage.cost` 可被重算下调
  （`updateUsageTokensAtCached` → `usage.go:286`）→ 任何向下修正都会让 usage 与余额永久不一致。

**B. 结构性问题**

- **P9** 两套"每人每月 X 元"，语义正交、长得一样、分居两页：`usage.monthly_quota_money`（软上限）vs `balance.monthly_amount`（发放额度）。
  典型事故：闸门配 100 + 全局金额配额配 100 → 花到 100 两层同时见底；管理员**手动充 500** 后员工仍被软配额拦住 →「我明明充了钱为什么还被拦」。
- **P10** "是否发放"与"是否拦截"强行耦合：`balance/scheduler.go:62` 闸门关闭即 return → 「每月发钱但不拦人」（试点期最常见）做不到。
- **P11** `cover` 模式静默抹掉手工充值（`balance.go:196-198`），一个字段承载"预付充值"与"月度津贴"两种语义；现有测试把抹除行为锁死（`balance_test.go:139-146`）。
- **P12** 余额不是账、不可对账：无流水表，且关闭期间不扣费 → `balance_money ≠ Σ发放 + Σ调整 − Σ消耗`。无法回答"这个人的 37 块怎么来的"。
- **P13** 月中入职的新员工拿不到钱：发放范围固定 `status=1 AND role='user'` 且每北京月只跑一次 → 2 号入职 + 闸门开启 = 第一次调用即 429。
- **P14** 客户端结构性看不见部门预算，且四种超限共用一个错误码（`handler.go:746/787/800/810` 全是 `429 QUOTA_EXCEEDED`，
  只有中文 message 不同），而 `dept_budgets` 已从 usage 接口删除（`handler.go:536`）→ 被部门预算拦住时界面零线索。
- **P15** 客户端契约缺位：`/auth/usage` 的 4 个 balance 字段在唯一的 `UsagePayload`（`account-card/src/usage-service.ts:13-29`）里一个都没有，
  `balance_money/balance_enabled` 是 UI 组件就地加的可选字段，`balance_monthly/balance_mode` 全客户端零消费；`fetchJSON` 返回 `any`，无运行时校验。
- **P16** 余额展示零单测；唯一覆盖是 E2E 断言 `includes('88.5')`，而 `formatMoney(88.5)` 输出 `¥88.50` 天然包含该子串 → 对格式化回归不敏感。

**C. "看着乱"的来源**（命名与位置）

- 同一个词"余额"指三件事：员工余额、**渠道余额**（`usage/Overview.tsx:109`）、客户端把"剩余额度"也叫余额。
- 客户端账户卡是**互斥分支**（`AccountCard.tsx:378-419`）：有余额时月度配额、进度条整块消失。
- `/usage/quota` 的黄色提示条把管理员指向另一个顶级模块（`Quota.tsx:159-162`）：「需要严格硬预算，请在**用户管理 → 月度余额发放**开启余额闸门」。
- 部门预算同一数据三处出现：`/departments`（可编辑）、`/usage/quota`（只读表）、`/usage/depts`（使用率）。
- 全局金额配额 UI 已迁到用量中心，但仍写在 `PUT /api/server/admin/gateway` 上（`llmgateway/admin.go:937-941`，需 `gateway:write`）。
- 措辞四套：员工端「请联系管理员**充值**」、管理端「**调整余额**」、自动任务「**发放**」、模式「**增加/覆盖**」。

---

## 2. 设计目标与不变量

**目标**

1. 员工侧的额度概念**只剩两个**：账户余额（唯一闸门）+ 按月发放余额（唯一入账动作）。
   部门预算、员工 token 配额、员工金额配额**全部下线**（数据保留、不再读写/拦截）。
2. 余额成为**可对账的账本**：任何时点 `users.balance_money == SUM(balance_ledger.amount)`。
3. 员工看到的数字、网关判定用的数字、管理员看到的数字**同源同阈值**。
4. 每个"钱"的配置**只有一个编辑入口**，每个词**只有一个含义**。
5. 超限拦截**可解释**：客户端能区分是谁把请求拦下的。
6. 升级零事故：存量部署开启闸门不会误拦，历史消费不会凭空产生欠款。

**不变量（实施后必须有测试守卫）**

- I1 账本守恒：`users.balance_money == Σ balance_ledger.amount`（每个用户、任意时点）。
- I2 幂等发放：同一用户同一北京月最多一条 `balance_grant_items`，最多一次入账。
- I3 展示一致：对外 JSON 的 `balance_money` 一律 quantize 到分；闸门判定用同一个 quantize 后的值。
- I4 单位一义：`users.balance_money` 只表示"账户里的钱（元）"，不再承载"本月还剩多少"。
- I5 未开通不扣不拦：`balance_activated_at IS NULL` 的用户既不扣余额也不被余额闸门拦截。

---

## 3. 术语表（词的唯一含义，UI 文案与代码标识都按此对齐）

| 术语 | 英文/标识 | 含义 | 闸门性质 |
|---|---|---|---|
| 账户余额 | `balance_money` / Balance | 员工账上的钱，存量、跨月、可充可扣，消费即减 | **硬**：≤0 且已开通 → 429 |
| 月度额度 | `balance.monthly_amount` / Monthly Allowance | 每月自动发到余额里的金额 | 不是闸门，是入账动作 |
| 发放 | Grant | 把月度额度记入余额（`add`=累加 / `cover`=清零后重发） | — |
| 月度消费上限 | ~~`quota_money`~~ | **已下线**（2026-09-11）：列保留、不再读写与拦截 | — |
| 部门预算 | ~~`groups.budget_money`~~ | **已下线**：列保留、不再读写与拦截 | — |
| 流量配额 | ~~`quota_tokens`~~ | **已下线**：列保留、不再读写与拦截 | — |
| 上游账户余额 | Provider Balance | 服务端在模型服务商处的账户余额 | 只展示 |

**停用词**：不再使用"渠道余额"（→ 上游账户余额）、不再用"余额"指代"配额剩余"（→ 本月剩余额度）。

---

## 4. 数据模型

### 4.1 新增 `balance_ledger`（追加型流水，账本真源）

```sql
CREATE TABLE balance_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL,
  kind          TEXT NOT NULL,             -- grant | reset | adjust | consume | refund
  amount        DOUBLE PRECISION NOT NULL, -- 带符号:正=入账,负=出账(微元精度)
  balance_after DOUBLE PRECISION NOT NULL, -- 该笔之后的账户余额(微元)
  reason        TEXT NOT NULL DEFAULT '',
  actor         TEXT NOT NULL DEFAULT '',  -- 管理员用户名 / 'system'
  usage_id      BIGINT,                    -- consume/refund 关联 usage.id
  month         TEXT NOT NULL DEFAULT '',  -- 发放批次(北京月 YYYYMM),非发放为 ''
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_balance_ledger_user ON balance_ledger (user_id, id DESC);
CREATE UNIQUE INDEX idx_balance_ledger_usage ON balance_ledger (usage_id, kind)
  WHERE usage_id IS NOT NULL;
```

- `kind` 语义：`grant` 月度发放入账；`reset` 覆盖模式把余额清零（负数，差额）；
  `adjust` 管理员手工增减/设为；`consume` 消费扣减；`refund` 费用向下修正的回补。
- `usage_id + kind` 唯一 → 同一 usage 行的扣减/回补各只能记一次（幂等）。
- `balance_after` 用于人工核对与断点排查；**对账以 I1 的求和为准**。

### 4.2 新增 `balance_grant_items`（逐人发放幂等锚）

```sql
CREATE TABLE balance_grant_items (
  user_id    BIGINT NOT NULL,
  month      TEXT NOT NULL,       -- 北京月 YYYYMM(与 balance_grants.month 同键)
  amount     DOUBLE PRECISION NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'add',  -- 入账时的发放方式
  actor      TEXT NOT NULL DEFAULT '',     -- 'system' | 管理员用户名
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, month)
);
```

- 取代"`balance_grants.month` 单锚 + 一条全体 UPDATE"：幂等锚下沉到**人·月**，
  新员工/漏发/重新启用自动被下一次 tick 补齐（P13），并天然产出逐人明细（P12）。
- `balance_grants`（批次表，month 主键）**保留**为发放批次台账（mode/amount/affected/actor），手动"立即发放"仍产生一条批次记录。

### 4.3 `users` 增列

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_activated_at TIMESTAMPTZ;
```

- **开通语义**：首次入账（发放或管理员充值）时置位。未开通用户不扣余额、不被余额闸门拦（I5）。
  这一条同时解决 P5/P10/P12 的历史包袱：存量部署开启闸门不会误拦（余额全 0 但从未入账），
  关闭闸门期间的消费也不会凭空产生欠款。
- 已开通的用户，**无论闸门开关，消费都扣减**（余额是真实账户）；开关只决定"拦不拦"（修 P5）。

### 4.4 迁移回填（0062，必须幂等且可重跑）

1. 建三张表/列（`IF NOT EXISTS`）。
2. 回填开通态与初始余额：对 `balance_money <> 0` 的用户置 `balance_activated_at = now()`，
   并写一条 `adjust`（`actor='system'`, `reason='迁移初始化'`, `amount = balance_money`, `balance_after = balance_money`）。
3. 回填当月发放锚：若 `balance_grants` 中存在**当前北京月**的批次，则为当时符合条件的全体用户
   （`status=1 AND role='user'`）插入 `balance_grant_items`，避免迁移后调度器重复发放。
   历史月份不回填（无实际影响：调度器只对当月补发）。
4. 不删除 `quota_money` / `usage.monthly_quota_money`（兼容保留，见 §6.3）。

**回填顺序（有测试钉住，见 §9 `migration_0062_test.go`）**：

1. 先按当月 `balance_grants` 批次补逐人锚，且只补 `users.created_at <= balance_grants.created_at` 的启用员工
   —— 批次执行时"在场"的人补锚（**不会被重复发放**），批次之后入职的人不补（**会被下一轮正常补发**，这正是逐人锚的意义）；
2. 再回填账本：当期有锚 A、余额 B 的用户写 `adjust(B−A)` + `grant(A)`（期初 + 当月发放，合计 = B）；
   无锚用户只写 `adjust(B)`；B=0 且无锚（未入账的新人）不写流水 → 保持"未开通"；
3. 最后置开通位（有流水即已开通）。

---

## 5. 语义规则（服务端唯一实现点）

### 5.1 记账

所有余额变动只经一个入口（`serverstore` 内部函数 `applyBalanceTx`）：

```
applyBalanceTx(tx, userID, delta, kind, reason, actor, usageID, month) (balanceAfter, error)
```

- 内部：`UPDATE users SET balance_money = balance_money + $delta,
  balance_activated_at = COALESCE(balance_activated_at, now()) WHERE id=$uid RETURNING balance_money`，
  随后 `INSERT INTO balance_ledger ...`（同事务）。消费路径额外带 `AND balance_activated_at IS NOT NULL`（I5）。
- 冲突/并发：行锁串行化，`balance_after` 为该事务视角值；**守恒以 I1 为准**。
- 消费（`RecordUsage*` / `UpdateUsageTokens*`）传 `delta = -(newCost - oldCost)`，可正可负 →
  向下修正自动产生 `refund`（修 P8），并靠 `(usage_id, kind)` 唯一索引防重复。

### 5.2 闸门优先级（`quotaBlocked`）

**只剩一条规则**（修 P9/P14 的根因 —— 不再有多套机制互相打架）：

| 判据 | 错误码 |
|---|---|
| 闸门开启 且 已开通余额账户 且 `QuantizeMoney(balance) <= 0` | `BALANCE_EXHAUSTED`（HTTP 429） |

- 管理员豁免；未开通余额账户（从未入账）不受约束 —— 存量部署开启闸门不会误拦全员。
- 查询失败 fail-closed（计费强制路径上 DB 瞬时故障不得放行）。
- 旧客户端只透传 message，错误码变化对它们无影响。

### 5.3 精度（修 P2/P3）

| 层 | 精度 | 实现 |
|---|---|---|
| 存储/账本 | 微元 `1e-6` | 现状保留（`deductBalance` 的取整规则上移为 `roundMicro`） |
| 判定 | 分位四舍五入后比较 | `roundToCent(balance) <= 0` |
| 对外 JSON | 分位四舍五入 | 输出前统一 `roundToCent`（`userJSON` / `/auth/usage` / `/balance` / ledger 分页） |

→ 展示值 == 判定值 == 客户端转红阈值（客户端 `balanceMoney <= 0`），三处同源。

### 5.4 管理员操作（修 P1/P2）

- `POST /users/:id/balance` 的 `mode` 扩展为 `add | deduct | set | clear`：
  - `set`：`amount >= 0`（**允许 0**）；
  - `clear`：等价 `set 0`，语义化提供（UI「清零」按钮）；
  - `deduct`：允许扣到 0（`delta = -min(amount, balance)`），不再出现"扣不动"的死角。
- 每次操作写一条 `adjust` 流水（含 `reason`），审计明细用**完整精度**（不再 `%.2f` 丢精度）。
- 用户删除/禁用不影响账本（保留历史）。

### 5.5 发放（修 P7/P11/P13）

- 调度器 `internal/balance`：tick 由 1 小时改为 **10 分钟**；每 tick 执行 `RunMonthlyGrants`：
  1. 读配置；`balance.enabled == false` 时**仍然发放**（解耦，修 P10）——配置项 `monthly_amount > 0` 是唯一开关；
  2. 取北京月 `m`；`INSERT INTO balance_grant_items (user_id, month, amount) SELECT id, m, amount FROM users
     WHERE status=1 AND role='user' AND NOT EXISTS(...) ON CONFLICT DO NOTHING RETURNING user_id`（抢人·月锚，幂等）；
  3. 对抢到的用户批量入账：`add` → `+amount`；`cover` → 先写 `reset`（`-old`）再写 `grant`（`+amount`）；
  4. 写批次行 `balance_grants`（含 actor/mode/amount/affected）与审计。
- **停发/启用的即时性**：用户创建、启用、以及管理员手动触发时调用同一 `RunMonthlyGrantsFor(userID)`，
  新员工当天即可用（修 P13）。
- `cover` 的界面上必须明示「覆盖会清零全部结余与手工充值」，且被清零的金额**在流水里可见**（`reset` 行，修 P11）。
- 手动「立即发放本月」改为：对"本月尚无 item"的用户补发（不再是一次全体 UPDATE），返回 `{granted: n, skipped: m}`。

---

## 6. API 契约

### 6.1 服务端管理面（`/api/server/admin/*`）

| 方法 | 路径 | 变更 |
|---|---|---|
| GET | `/balance` | 响应增加 `activated_users`（已开通人数）、`month_granted`（本月已发人数）、`pending_users`（本月未发人数）；`total_balance` 输出 quantize |
| PUT | `/balance` | 语义不变（保存后自动补发本月未发用户），响应 `auto_grant` 改为 `{granted, skipped}` |
| POST | `/balance/grant` | 改为逐人补发；响应 `{granted, skipped, already}`；**不再是"要么全发要么全跳过"** |
| POST | `/users/:id/balance` | `mode` 增加 `clear`；`set` 允许 0 |
| GET | `/users/:id/balance/ledger` | **新增**：`?page=&size=&kind=` → `{items:[{id,kind,amount,balance_after,reason,actor,usage_id,month,created_at}],total,ledger_sum,balance_money}` |
| GET | `/users` | `balance_money` 输出 quantize；增加 `balance_activated`（bool）；**移除** `quota_*` / `effective_quota_*` |
| PUT | `/users/:id` | 请求体里的 `quota_*` 字段被忽略（字段与列保留，不再读写） |
| PUT | `/gateway` | **移除** `monthly_quota` / `monthly_quota_money`（全局默认配额下线） |
| POST/PUT | `/departments` | **移除** `budget_money`（部门预算下线） |
| GET | `/providers/:id/balance` | 语义不变（上游账户余额，只读） |

### 6.2 客户端面（`/api/client/v2/auth/usage`）

保留既有键（老客户端不受影响），**新增/明确**：

```
balance_money          number    账户余额(已 quantize 到分)
balance_activated      bool      是否已开通余额账户(未开通时客户端不渲染余额行)
balance_enabled        bool      闸门是否开启(仅用于文案)
balance_monthly        number    每月发放额度(0=未配置)
balance_mode           string    add | cover
is_admin, monthly_usage, monthly_cost, today_*, yesterday_*, total_*
```

- **`quota_tokens` / `quota_money` / `remaining_tokens` / `remaining_money` 已删除** ——
  员工侧不再有第二个"还剩多少"的数字。

### 6.3 兼容与退役

- `users.quota_tokens` / `users.quota_money` / `groups.budget_money` 三列与
  `usage.monthly_quota` / `usage.monthly_quota_money` 两个 settings 键**保留在库中**，
  代码不再读写（不做破坏性 DROP）；webadmin 也不再有编辑入口。
  需要彻底清理时另开一个迁移（本文不排期）。

---

## 7. 客户端契约（修 P15/P16）

- 新增 `packages/client/account-card/src/usage-contract.ts`：**唯一** `UsagePayload` 类型 +
  `USAGE_PAYLOAD_KEYS` 常量 + `parseUsagePayload(raw): UsagePayload | null`（逐字段运行时校验，未知字段忽略、类型不符返回 null）。
- `usage-service.ts` 与 `AccountCard.tsx` 删除各自的手写 interface，统一 import 契约。
- **跨语言守卫**：服务端加测试读取 `usage-contract.ts` 的 `USAGE_PAYLOAD_KEYS`，与 `/auth/usage` 实际输出的键集合做集合相等断言
  （任一侧增删字段未同步 → 测试红）。
- 账户卡改为**同屏**：主数字=账户余额（未开通则不渲染该行），副行=本月已用/月消费上限（含进度条），
  余额告警文案与闸门语义对齐（「余额不足，将无法调用」），月上限告警用另一文案（「本月额度接近上限」）。
- 429 处理：按 `error.code` 给中文引导（`BALANCE_EXHAUSTED` → 联系管理员充值；`DEPT_BUDGET_EXHAUSTED` → 联系部门管理员；配额类 → 提示本月额度）。
- 单测：契约解析（缺失/类型错/多余字段）、同屏渲染、阈值配色、未开通回落、错误码文案。

---

## 8. 管理端信息架构（修 §1.C）

```
用量中心
├── 总览          渠道余额卡 → 改名「上游账户余额」
├── 部门用量      区间费用 + 成员(预算列删除)
├── 成员用量      账户余额列(配额列删除)
├── 模型分析
├── 请求日志
└── 余额          ← 原「配额与预算」整页重写(/usage/balance)
    ├── ① 按月发放余额:闸门开关 / 发放方式(累加·覆盖) / 每人每月额度 / 立即补发本月 / 本月发放进度
    ├── ② 员工余额表:余额 · 本月消费 · 本月 tokens + 行内「调整」「流水」
    ├── ③ 调整弹窗:充值 / 扣减 / 设为 / **清零** + 实时预览 + 备注
    └── ④ 余额流水弹窗:发放/清零/调整/消费/回补逐笔可追溯 + 流水合计对账

用户管理 (/users)
├── 移除「月度余额发放」卡片(整体迁入余额页)与「配额」按钮
├── 余额列只读 + 行内「余额」按钮 → 跳转 /usage/balance?user=<用户名> 并自动打开调整弹窗
└── 「本月流量」列简化为「本月消费」(金额 + tokens)

部门管理 (/departments)  移除预算列与预算输入(只保留结构/主管/成员)
```

**编辑入口唯一**:余额策略与单人调整只在 `/usage/balance`;`/users` 只做跳转。
`/usage/quota` 路由与页面已删除(旧链接回落到用量中心)。

- 审计页 `ACTION_LABEL` 补 `balance_adjust` / `balance_grant` / `balance_settings`,
  并注明 `quota_change` / `dept_budget_change` / `quota_default_change` 随功能下线不再产生;
  加**契约守卫**:`usage-contract.ts` 的键集合 ↔ Go handler 键集合集合相等(见 §9)。

## 9. 测试与守卫（对应 §2 不变量）

| 层 | 用例 |
|---|---|
| serverstore | I1 账本守恒（发放/调整/消费/回补后 `SUM(amount) == balance_money`）；I2 逐人发放幂等与跨月补发；cover 的 reset 可见；`set 0` / `clear` / 残值清零；quantize 输出；**0062 存量库回填**（`migration_0062_test.go`：期初+当月发放解释、批次后入职者不补锚且被正常补发、升级后不重复发放、重放幂等） |
| llmgateway | **余额闸门 429**（新，`balance_gate_test.go`）：已开通且余额 0 → `BALANCE_EXHAUSTED`；余额 0.004（显示 ¥0.00）→ 拦、0.006 → 放行；未开通 → 放行；闸门关闭 → 不拦但照扣；管理员豁免；embedding 路径同样受闸门约束；发放后即可调用 |
| serverauth | ledger 分页与权限；`/balance` 汇总字段；审计明细精度；**契约键集合与 `usage-contract.ts` 集合相等**（`usage_contract_test.go`） |
| webadmin | 额度页发放策略卡片；users 页无残留；清零按钮；审计筛选含余额动作 |
| client | `usage-contract.test.ts`：合法载荷归一化、未知字段忽略、缺字段/类型错 → null、未开通形状；账户卡只渲染余额/未开通 |
| 静态守卫 | 审计动作全覆盖；`usage-contract.ts` ↔ Go handler 键集合 |

---

## 10. 迁移、发布与回滚

- **迁移**：`server/internal/serverstore/migrations-pg/0062_balance_ledger.sql`（幂等，可重跑；回填见 §4.4）。
- **发布顺序**：服务端先行（新增列/表 + 新错误码），客户端与 webadmin 随后同仓发布；
  老客户端连新服务端 → 忽略新字段、只透传 message，行为不变。
- **回滚**：服务端回滚到旧版本时，新表/新列无副作用（旧代码不读）；`balance_grant_items`
  的当月锚在旧版本不生效 → 旧版本可能重复发放一次当月额度，回滚 runbook 需写明"回滚后当日不要手动触发发放"。
- **生产检查**（测试环境 101.42.228.128 / 正式 10.88.7.35）：
  升级后 `GET /api/server/admin/balance` 应满足 `Σ balance_ledger.amount == users.balance_money`
  （提供 `picoaide-server --check-balance` CLI 或运维 SQL，二选一，实施阶段 5 决定）。

---

## 11. 决策点（已定，可在评审时否决）

| # | 决策 | 备选 | 影响 |
|---|---|---|---|
| D1 | 员工额度统一到**余额**；金额配额保留但"余额闸门开启期间不生效" | ① 彻底删除金额配额（破坏存量配置）② 两层都生效（回到"充了钱还被拦"） | UI 文案与 `quotaBlocked` 分支 |
| D2 | 引入**开通语义**（`balance_activated_at`）：未开通不扣不拦 | ① 全员一律扣（升级事故复发）② 只靠"默认关闸门" | 升级安全与语义清晰度 |
| D3 | `cover` 保留，但清零差额**记流水并在 UI 明示** | ① 取消 cover ② 分"津贴池/充值池"双余额 | 管理员认知成本 vs 数据模型复杂度 |
| D4 | 发放幂等锚下沉到**人·月**，调度器 10 分钟一轮 | 保持"每北京月一次全体 UPDATE" | 新员工可用性、可观测性、SQL 复杂度 |
| D5 | ~~错误码拆分（4 个）~~ → **最终只保留 `BALANCE_EXHAUSTED` 一个**（其余机制已删除） | 保持单一 `QUOTA_EXCEEDED` | 客户端可解释性；老客户端兼容（已验证只透传 message） |
| D6 | **员工 token 配额与金额配额也一并删除**（用户 2026-09-11 追加拍板） | ① 保留 token 配额 ② 收进高级设置折叠区 | 模型只剩「余额 + 按月发放」；存量配额配置停止生效（数据保留） |

## 12. 不做（边界）

- 不做"余额 → 部门预算"的转账/借用；不做发票、账单、对公结算。
- 不做配额/预算的请求内实时预留（reservation）——仍是"请求前校验 + 事后记账"，
  余额侧靠"扣减原子 + 准入闸门"提供近似硬约束，不承诺严格不超支。
- 不引入第二个组织维度（项目/成本中心）的预算。

## 13. 分期实施计划（全部完成）

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 迁移 0062 + 账本 DAO + 逐人发放/补发 + 开通语义 + 精度统一 | ✅ `serverstore` 全绿(I1/I2/I5 用例) |
| 2 | 网关闸门收敛为余额一条 + `BALANCE_EXHAUSTED` + 余额闸门回归测试 | ✅ `llmgateway` 全绿(新增 balance_gate_test.go) |
| 3 | 管理 API(ledger/clear/set0)+ webadmin IA 收敛 + 审计标签 | ✅ `make check`(Go + webadmin 111 测试) |
| 4 | 客户端契约唯一化 + 只展示余额 + 单测 | ✅ `account-card` 23 测试 + 跨语言契约守卫 |
| 5 | 迁移回填验证、全量门禁、部署与回滚说明 | ✅ 见 §14 |

## 14. 实施记录（2026-09-11）

### 数据层
- `server/internal/serverstore/migrations-pg/0062_balance_ledger.sql`：
  `balance_ledger`(账本)、`balance_grant_items`(逐人·月幂等锚)、`users.balance_activated_at`(开通位)；
  回填分三步:先按当月批次补逐人锚(仅 `created_at <= 批次时间` 的启用员工),再用**单条 UNION ALL 语句**
  写账本(`期初(B-A) + 发放(A)`,合计 = B = I1),最后置开通位。
  实证:`migration_0062_test.go` 在真实的"0061 旧库 + 存量余额 + 当月批次 + 批次后入职新人"上验证
  ——升级后老员工**不重复发放**、新人被正常补发、I1 成立、重放幂等。
- `serverstore/balance.go` 重写：`settleUsageCostTx`(按 usage 行结算差额，支持回补)、
  `adjustBalanceTx`(唯一入账口，首次入账即开通)、`GrantMonthlyBalance`(逐人锚 + 分批入账 + 批次台账)、
  `BalanceLedgerPage/Sum`、`BalanceBlocked`、`GetGrantStatus`、`QuantizeMoney`。
- 删除：`budget.go` 整文件；`EffectiveQuota` / `EffectiveMoneyQuota` / `MonthUsageByUsers` /
  `DeptMonthlyCost*` / `DeptMemberIDs` / `SetDeptBudget` / `GetDeptBudget` / `UpdateDepartmentWithBudget`。
- `usage.go`：写入与回填都改为「结算到目标 cost」（`FOR UPDATE` 锁行），未开通用户不扣不记；
  费用向下修正自动记 `refund`（修 P8）。

### 网关
- `quotaBlocked` 收敛为一条余额规则；`BALANCE_EXHAUSTED` 取代四种 `QUOTA_EXCEEDED`；
  删除 `moneyEpsilon` / `deptMemberIDsFn` 与部门预算/配额校验分支。
- 新增 `internal/llmgateway/balance_gate_test.go`（P4：唯一的硬闸门此前零覆盖）。

### 管理面 / webadmin
- 新端点 `GET /api/server/admin/users/:id/balance/ledger`（含 `ledger_sum` 对账）；
  `mode` 增加 `clear`，`set` 允许 0（修 P1/P2，实测「设为 0」从 400 变为 200）。
- `/api/server/admin/gateway` 删除 `monthly_quota*`；`/departments` 删除 `budget_money/monthly_cost`；
  `/users` 删除 `quota_*`、增加 `balance_activated`。
- webadmin：`/usage/quota` → `/usage/balance`（整页重写为「余额」：发放策略 + 员工余额表 + 调整/清零 + 流水）；
  `/users` 去掉发放卡片与配额列/按钮（余额按钮跳转余额页）；`/departments`、`/usage/depts`、`/usage/members`
  去掉预算与配额；总览「渠道余额」改名「上游账户余额」；审计标签补 `balance_*`。

### 客户端
- 新增唯一契约 `packages/client/account-card/src/usage-contract.ts`（类型 + 键集合 + 运行时校验），
  `usage-service.ts` / `AccountCard.tsx` 删除各自重复声明；载荷形状不符时保持空态而不是渲染 `undefined`。
- 账户卡只渲染账户余额（未开通显示「余额未开通」），月度配额分支与进度条删除。
- 服务端新增 `usage_contract_test.go` 读取 TS 契约做键集合对拍（跨语言守卫）。

### 验证
- `go test ./... -count=1`（PG 容器）全绿；`server make check`（gofmt + vet + 全包测试 + webadmin）全绿。
- webadmin：`tsc --noEmit` 干净、`vitest` 111/111、`npm run build` 成功。
- account-card：typecheck 干净、`vitest` 23/23。
- E2E fixture 与断言同步（`¥88.50` 精确匹配 + `balance_activated`）。

### 已知边界
- 存量 `quota_*` / `budget_money` 数据保留在库中但不再生效；如需彻底清理另开迁移。
- 余额仍是"请求前校验 + 事后记账"的准入闸门，不承诺单次请求绝不透支。
- 回滚到旧版本时新表无副作用，但当月已发放的逐人锚在旧代码里不被识别，
  旧版本可能重复发放一次当月额度 —— 回滚 runbook 需注明"回滚当日不要手动触发发放"。
