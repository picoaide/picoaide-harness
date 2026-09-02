# 用量中心重构设计（2026-09-02）

> 决策文档。背景：企业视角功能审计（.smoke/ENTERPRISE-FEATURE-AUDIT-2026-09-02.md）后，用户拍板本轮唯一重点是**用量统计**：
> - 现状：850 行单页（webadmin `src/pages/Usage.tsx`）把 7 个互不相关区块挤在一起（筛选、统计卡、图表三 Tab、配额占用面板、部门预算面板、明细表、用户钻取弹窗）。
> - 诉求：主页面 = 企业整体消耗（剩余金额、消耗金额、最近几天消耗、哪些模型消耗多少）；能按部门维度看；能看个人单独消耗；参考 new-api 等 AI 网关的计费展示；拆成多个二级页面，每页功能不要太多。

---

## 1. 现状问题（为什么挤）

`Usage.tsx` 单页同时承载了**两类性质完全不同的事物**：

| 区块 | 性质 | 问题 |
|---|---|---|
| 统计卡 / 图表明细 | 统计（任意时间区间查询） | 查询区间、分组维度、口径三套状态互相纠缠（`group×chartTab×metric`） |
| 本月配额占用面板 | **管理**（自然月、与查询区间无关、可写配置） | 假装是统计，实际是"设置员工配额"的入口，还 load 前 200 人 |
| 部门月度预算面板 | **管理**（自然月、只读预算状态） | 同上；且与"部门用量统计分析"无关 |
| 用户钻取弹窗 | 统计 | 弹窗里塞了"个人趋势"，本该是一级页面 |
| 导出 CSV | 统计 | 只能导出当前聚合行，导出不了明细 |

另外两个硬缺口：
1. **无部门维度**：`/api/server/admin/usage` 聚合白名单只有 `day|week|month|model|user`（`admin.go:674-678`），过滤只支持单用户（`WithUsername`）——部门看不了。
2. **无个人独立页**：只有"按用户分组"的表格 + 钻取弹窗，没有某个员工的完整画像（近30天趋势+模型构成+明细）。
3. **无渠道余额**：用户明确要"通过 deepseek 的 API 看剩余金额"——当前 llmgateway 不做上游余额查询。

---

## 2. 标杆怎么做（调研结论）

### 2.1 DeepSeek 开放平台（用户直接点名的"剩余金额"）
- 余额接口 `GET /user/balance`（Bearer）：`{is_available, balance_infos:[{currency(CNY/USD), total_balance, granted_balance(赠金), topped_up_balance(充值)}]}`。参考自 [官方文档](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)。
- 控制台：余额卡（总余额/赠金/充值分列 + 可用性）→ 用量页（按天消耗、模型/场景拆分）。**"余额是账户级、消耗是时间序列"** 分块呈现。

### 2.2 new-api（one-api 最活跃 fork，本项目已调研，见 `server/docs/research-usage-page/README.md`）
- **两个页面**：
  - `/console` 数据看板：全平台**消耗趋势折线** + **各用户消耗占比分布**（参照 [New API 文档](https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/log)）。
  - `/console/log` 日志页：顶部统计徽标（总消耗 / RPM / TPM，`CommonLogsStats`）+ 过滤条（时间/用户名/模型/渠道/令牌名）+ 明细表（管理员多"用户名、渠道名"列）+ 行详情弹窗。**统计与明细天生一对，放一页**。
- 用户管理页行内 `UserQuotaCell`：`剩余额度 | 总额度` + 进度条（≤10% 红 / ≤30% 琥珀）+ tooltip；`UserQuotaDialog`「Adjust Quota」：add/subtract/override 三模式 + **实时预览算术**（当前 X +Y = Z）。

### 2.3 LiteLLM Dashboard（费用维度最全，见 research README）
- 单页 5 个 Tab：Cost / Model Activity / Key Activity / MCP / Endpoint Activity；顶部全局过滤器：**作用域（global/my-usage/user/tag）+ 日期 + 用户下拉**。
- KPI 卡：Total Requests / Success / Failed / **Average Cost per Request** / Total Tokens（可展开 Input/Output/Cache Read/Cache Write）。
- 图表：Daily Spend 柱状图、Top Models / Top Keys 水平条（TOP5/10/20）、Spend by Provider 占比。
- **Budgets 独立页**：表 = Max Budget($) / TPM / RPM / Reset(24h/7d/30d)；预算挂 user/team/key 三层、子实体继承（`InheritedBudgetHint`）；单元格内嵌 `$spend of $budget` 进度条（≥80% 琥珀、>100% 红）。

### 2.4 综合结论（信息架构共识）
- **统计**与**配额/预算（管理）**是两个域，必须分页（new-api 日志 vs 用户管理；LiteLLM Usage vs Budgets）。
- **总览 = KPI 行 + 时间序列 + 维度排行**（LiteLLM/OpenWebUI/new-api 共识）。
- **明细日志**单独一页，配统计徽标 + 多条件过滤（new-api 共识）。
- **按实体下钻**（模型/用户/部门）做成行→详情页/弹窗（OpenWebUI 弹窗、FastGPT 成员多选）。
- **余额 = 账户级信息**，独立卡片呈现（DeepSeek 控制台）。

---

## 3. 目标信息架构：左侧导航「用量中心」下 6 个页面

```
用量中心
├── ① 总览        /usage            ← 主页面：企业整体消耗（默认落地页）
├── ② 部门用量    /usage/depts      ← 部门维度（含预算使用率）
├── ③ 成员用量    /usage/members    ← 个人维度；:/usage/members/:id 个人详情
├── ④ 模型分析    /usage/models     ← 模型/渠道维度
├── ⑤ 请求日志    /usage/logs       ← 原始请求明细（含导出）
└── ⑥ 配额与预算  /usage/quota      ← 管理（原"配额占用+部门预算"区块搬家 + 网关页全局默认配额迁入）
```

设计原则：
1. **统计与配置分离**：⑥ 承载所有可写配置（用户配额调整、部门预算设置、全局默认值）；①-⑤ 纯只读统计。
2. **每页一主题**：每页 = 顶部一行全局过滤 + 1 组 KPI/卡片 + 1 个主图 + 1 张明细表（至多 2 个图表/表）。
3. **金额为第一指标**：默认"金额(¥)"口径（用户明确要"消耗金额"），tokens 作为可从总览/模型页切换的口径（保留，但默认金额）。
4. **统一"自然月 vs 查询区间"口径**：统计页=任意区间；配额/预算页=自然月（页面内说明），不再混。

### 3.1 ① 总览（主页面，企业整体消耗）

布局（自上而下，整页无表格）：

```
┌─────────────────────────────────────────────────────────┐
│ 时间范围: [近7天|近30天|本月|自定义]        [查询]           │
├─────────────────────────────────────────────────────────┤
│ ① 渠道余额卡（每行一个 provider）                          │
│    DeepSeek(官方)   ¥110.00   [赠金¥10 充值¥100]  [刷新]    │
│    Anthropic        ¥0.00（不可查询→置灰"不开放余额API"）   │
├─────────────────────────────────────────────────────────┤
│ ② KPI 行（5 张卡）                                        │
│ 本月消耗 ¥12,340.50 | 今日消耗 ¥203.20 | 本月请求 1,204    │
│ | 区间消耗（=查询区间）¥8,900.00 | 平均每请求 ¥1.03         │
├─────────────────────────────────────────────────────────┤
│ ③ 消耗趋势（查询区间内按天柱状图，默认近30天）              │
├─────────────────────────────────────────────────────────┤
│ ④ 模型消耗 TOP 10（水平条形图，金额；点击→跳模型分析）      │
└─────────────────────────────────────────────────────────┘
```

- ①=渠道余额：服务端新增 `GET /api/server/admin/providers/:id/balance`（见 §5），DeepSeek 系 provider 调用上游 `/user/balance` 拿 `total/granted/topped_up`；协议不支持者返回 `supported:false` 置灰并给"该服务商不开放余额查询"说明。余额是**账户级**，放总览顶部而非 KPI 里。
- ②=KPI：本月/今日/区间三个时间口径 + 请求数 + 平均每请求成本（LiteLLM 的 Average Cost per Request）。
- ③=趋势：区间内按天费用柱状图（默认近30天），环比 delta 挪到 KPI"区间消耗"卡的 desc 里。
- ④=模型 TOP：近 30 天模型费用排行条（TOP10），点击进入模型分析页。

### 3.2 ② 部门用量（部门维度）

```
┌────────────────────────────┬──────────────────────────────┐
│ 部门表（左，主表）           │ 部门详情（右侧，选中后出现）    │
│ 名称 | 本月费用 | 预算       │ 近30天消耗曲线               │
│ | 使用率进度条 | 成员数      │ 成员消费排行 TOP10           │
│ | 上月环比                   │ 模型花费 TOP5                │
│ （部门树按缩进展示）          │ [导出本部门 CSV]             │
└────────────────────────────┴──────────────────────────────┘
```

- 数据来自 `group=dept` 聚合（§5 API-2）+ `ListDepartments`（含 budget_money、member_count、整树当月费用已有）。
- 部门树缩进展示，**预算使用率**直接从部门表可见（`已用/预算` 进度条，≥90% 琥珀、超支红——把现在埋在页面底部的"部门月度预算面板"变成有上下文的行内指标）。
- 详情=该部门下钻：成员排行 + 模型拆分 + 趋势（new-api"占比分布"与 OpenWebUI 钻取的合体）。**部门领导视角**（员工侧）后续复用同一数据面，本设计先做管理端。

### 3.3 ③ 成员用量（个人维度）

```
成员表（主）                         成员详情 :/usage/members/:id（独立二级页）
搜索框  [用户名/ID]                   姓名 | 部门 | 本月费用/配额 | 状态
表格: 用户名 | 部门 | 本月费用          ┌───────────────────────────┐
     | 本月配额 | 使用率 | 状态         │ 近30天按天曲线（金额）       │
（行点击 → 详情页）                    │ 模型花费 TOP5              │
                                     │ 请求日志（近30天，前50条）   │
                                     │ [导出 CSV]                 │
                                     └───────────────────────────┘
```

- 这是对现有"按用户分组表格 + 钻取弹窗"的升级：弹窗 → 独立二级页，内容从"只有日趋势"扩到"趋势+模型构成+最近请求"。
- 新增"部门"列：用户→部门（`GetUserGroups`）直接展示，报表归属口径与配额 enforcement 一致（当前归属链）。
- 成员表带搜索（替代现在配额面板里的搜索，配额搜索挪去 ⑥）。

### 3.4 ④ 模型分析（模型/渠道维度）

```
模型表（主）                    | 金额占比环形图（右侧）
模型 | 请求数 | 输入/输出       | （点击扇区 = 过滤该模型）
    | 缓存 | embed | 费用      | 渠道(provider)消耗表（下方）
    | 单价(¥/1M 输入/输出)      |
```

- 数据和现有 `group=model` 聚合一致，但**拆出价格列**（模型定价已在 llmgateway 管理，仅展示）。
- 下方"渠道消耗"= 按 provider 聚合（需在 usage 聚合 join provider——当前 usage 只存 model；**新增 `group=provider`**，或模型页展示模型→provider 映射的浅表。设计上建议 `group=provider`，成本低：模型表 JOIN provider）。
- 用途：回答"哪些模型消耗了多少""贵模型被哪个部门/谁用得多"——此页管"哪些模型"，"谁/哪个部门用得贵"留给部门/成员页的模型拆分。

### 3.5 ⑤ 请求日志（明细）

```
[统计徽标行] 区间请求总数 | 区间总消耗 | 平均每请求成本   （new-api CommonLogsStats 式）
[过滤条] 时间范围 | 用户名 | 模型 | 类型(chat/embedding/search) | [查询] [导出CSV]
[明细表] 时间 | 用户 | 模型 | 类型 | 输入 | 输出 | 缓存 | embed | 费用
         （分页 20/页，服务端分页；倒序）
```

- 新端点：`GET /api/server/admin/usage/requests`（分页 + 过滤，§5 API-3）。这是把"数据本来就在 usage 明细表里、却只有聚合面"的缺口补上（审计发现的"模型调用无明细面"）。
- 类型列对应用户的 `kind`（chat/embedding/search，搜索记账已有 kind='search'）。
- 无内容留底（合规决定），详情行不做弹窗，字段即所见。

### 3.6 ⑥ 配额与预算（管理，从统计页搬走 + 全局默认配额迁入）

```
[全局默认配额卡] 每用户默认月 token 配额 | 每用户默认月金额配额   （本页直接编辑）
[用户配额表] 搜索 + 表: 用户 | 月token配额 | 月金额配额 | 本月已用 | 使用率
             （行内: 调整按钮 → Adjust Quota 弹窗[add/subtract/override+实时预览,
               new-api UserQuotaDialog 式]）
[部门预算表] 部门 | 预算(''=不限) | 本月已用 | 使用率 | [设置/清空]
```

- **全局默认配额从网关页迁入**：现状在网关「全局设置 → 配额与用量」小节（`Gateway.tsx` 表单字段 `monthly_quota` / `monthly_quota_money`，解释文案为"可在用户页单独覆盖"）。三个配额层级（全局默认/用户/部门预算）属于同一个业务域，集中一页管理；网关页只保留与网关运行相关的配置（默认模型/思考强度、限流、峰谷、保留时长、对外地址）。迁移方式 = **纯 UI 搬家**：存储不变（settings `usage.monthly_quota` / `usage.monthly_quota_money`，`serverstore/usage.go:16-20`），接口不变（仍 `PUT /api/server/admin/gateway`，字段为 `*FlexibleString`，指针语义 null 不覆盖——网关页表单删除这两个字段后互不干扰）；网关页删除这两个字段（**不留双入口**，避免再次出现"两个地方都能改配额"的混乱）。
- **调用明细保留时长（`usage.retention_months`）不动**：它属于"服务端数据策略"而非配额域，且与请求日志页的保留语义联动，留在网关页。
- 功能全部是**现有能力搬家**（配额面板 loadQuota、部门预算 deptBudgets、`PUT /users/:id` 配额字段），缺的只有"调整弹窗交互升级"（add/subtract/override + 预览）与表格化。
- 配额/预算变更**补审计**（现缺，审计发现项）：`quota_change` / `dept_budget_change` 写 audit_logs。

---

## 4. 路由与菜单

- webadmin 侧边栏：原「用量」菜单项 → 分组「用量中心」（子菜单 6 项），`/usage` 重定向到 `/usage/overview`（或总览就挂在 /usage）。
- 页面组件：`pages/usage/{Overview,Departments,Members,MemberDetail,Models,Logs,Quota}.tsx`，共享一个 `useUsageRange` 过滤器 hook 与 `ChartLazy`/表格组件；旧 `Usage.tsx` 删除（测试迁移见 §6）。
- 每页"功能不要太多"的硬约束：页面验收标准 = 顶部过滤行 + 主体区块 ≤3 个，超出即拆页。

---

## 5. 服务端 API 设计（新增/扩展）

### API-1（扩展）`GET /api/server/admin/usage`
- `group` 白名单增加 **`dept`**（和 `provider`）。
- 过滤增加：`dept`（部门名，树内成员均计入——沿用 `EffectiveDeptBudget` 的"树内合计"口径）；`WithUsername` 保留。
- 语义：`group=dept` 时每行 = 部门（含祖先归并：成员归属的祖先链都要计入，即"部门树内 SUM"，与预算 enforcement 口径一致）。
- 聚合实现提示：先查区间内 `usage JOIN users JOIN user_groups` 取归属组集合，再对每组祖先链展开归并（`loadGroupTree` + `ancestorsOf` 已有）；大数据量走 `usage_daily` 账本（按 day 已有，dept 需 join 用户归属——**注意**：账本只有 user_id 粒度，join 一次即可，避免扫 usage 明细）。

### API-2（新）`GET /api/server/admin/providers/:id/balance`
- 只读 provider 配置 → 若 `protocol/base_url` 命中已知余额协议（MVP：DeepSeek 原生 `GET {base}/user/balance`；预留 Anthropic `GET /v1/organizations/balance` 等），用该 provider 的 key 调上游，返回 `{supported:true, is_available, infos:[{currency,total_balance,granted_balance,topped_up_balance}], fetched_at}`；不支持返回 `{supported:false}`。
- 永不缓存过期余额：前端手动刷新 + 页面加载时拉一次；**不落库**（余额是上游账户状态，快照进 audit 无意义；如需历史可后续加 balance_snapshots 表）。
- 注意按上游速率限制节流：每个 provider 的余额按钮独立请求，避免 key 被限流。

### API-3（新）`GET /api/server/admin/usage/requests`
- 参数：`page,size(默认20,≤100),from,to,username,model,kind`。
- 返回：`{rows:[{id,time,username,model,kind,prompt_tokens,completion_tokens,cache_tokens,embed_tokens,cost}], total, page, size}`。
- 范围：默认近 7 天；超过 90 天拒绝（与聚合接口默认窗口一致，防扫全表）；按 id 倒序。走 usage 分区表（索引 `(user_id, created_at)`/`created_at` 已有）。
- 权限：`PermUsageRead`（同聚合）。

### API-4（新，可选简化版）`GET /api/server/admin/usage/overview`
- 一次返回总览页所需：`{month_cost, month_usage, today_cost, range_cost, range_requests, trend:[{day,cost}], top_models:[{model,cost}], provider_balances}` —— 避免总览页 4 个并行请求；实现 = 现有聚合函数组合，无新 SQL。
- 若团队倾向轻改，前端并行调 `usage?group=day` + `usage?group=model` + `providers/:id/balance` 也可，overview 是可选优化。

---

## 6. 工程与测试注意事项

1. **迁移测试**：现有 `Usage.test.tsx`（多处断言旧页面 DOM：stat-cards/quota-list 等）需按新页面拆分重写；`make check` 的 87 个 webadmin 测试要全绿。
2. **路由集中**：新端点必须经 `internal/router.Register` 声明（`PermUsageRead`），走 `AdminRoute`，勿在业务包自挂路由（fall-open 防护）。
3. **group=dept 聚合性能**：部门树归并在内存做（组树不大），SQL 只按 `user_id IN (…)` 聚合；超大部门用户数 >1000 时退化为分布式聚合（本期不做，监控即可）。
4. **口径说明位**：每页页眉放一行口径说明（费用=按模型定价折算、含 embedding、未定价模型计 0；与配额 enforcement 同口径），把现在散落的注释收敛为可见文案。
5. **导出**：每页导出 = 当前页数据集的 CSV（BOM + 公式注入转义沿用现有 `csvCell`）；请求日志页导出走服务端分页全量（循环拉取拼 CSV）。
6. **配额配置迁移的测试影响**：`Gateway.test.tsx` 断言含 `monthly-quota` / `monthly-quota-money` 输入框的用例需随字段下架调整；`Usage.test.tsx` 中"默认配额文案（跟随网关全局设置）"断言迁到新配额页。
7. **员工侧**（后续）：账户卡渲染 `dept_budgets`（现有死字段）→ 员工点开"部门预算"详情；部门领导视图复用 API-1 `group=dept` + `dept` 过滤，客户端加"我的部门"入口。本设计不含员工侧 UI，只保证数据面就绪。

---

## 7. 实施阶段

| 阶段 | 内容 | 预估改动面 |
|---|---|---|
| **Phase 1（信息架构+分页）** | 前端拆 6 页（总览/部门/成员/模型/日志/配额）；部门聚合 `group=dept`+`dept` 过滤；请求日志 API-3 + 日志页；成员详情独立页；配额/预算管理页（现有能力搬家） | webadmin 大改 + serverstore/路由小改 |
| **Phase 2（总览增强）** | provider 余额 API-2 + 渠道余额卡；overview API-4；模型页价格列、`group=provider` | llmgateway 小改（余额协议适配） |
| **Phase 3（管理闭环）** | Adjust Quota 弹窗（add/subtract/override+预览）、部门预算表编辑、配额/预算变更审计、导出增强（Excel 可选） | webadmin + serverauth/admin.go |

> 建议 Phase 1 完成即发版：统计变清晰是用户的直接诉求；Phase 2/3 是锦上添花。

---

## 8. P1 后续实施(2026-09-02 完成):审计补全 + 报表订阅

### 8.1 审计补全(此前 llmgateway 零审计)
| 动作 | 触发点 | 明细 |
|---|---|---|
| `quota_change` | PUT /users/:id 配额字段/清除 | `alice: token 默认→1000, money 60.00→26.50`(null=默认,0=不限) |
| `dept_budget_change` | PUT /departments/:id budget_money(与 dept_update 并存) | `研发部: 预算 unset→500.00`(旧值须在事务前捕获) |
| `quota_default_change` | PUT /gateway monthly_quota/_money | `默认token配额:1000000→1200000` |
| `gateway_config` | PUT /gateway 其余字段 | 字段级旧→新列表(限流/峰谷/保留/错误上报/思考强度/对外地址/默认模型) |
| `provider_create/update/delete` | providers CRUD | update 为字段级变更(密钥只记"已更换",不落明文) |
| `model_create/update/delete` | models CRUD | 价格(input/output/cache/offpeak)旧→新;改名受存在性保护 |
| `report_subscription_create/update/delete` | 报表订阅 CRUD | 名称+地址 |

### 8.2 报表订阅(月度推送)
- 数据:`report_subscriptions`(0056 迁移:name/enabled/hook_url/last_run_at/last_error)。
- 生成:`internal/reports.GenerateMonthlyReport` —— 上月闭区间(聚合层 to 语义=截止日含当天,故传 本月1日前一天),总量(费用/请求/tokens)+ 模型TOP10 + 用户TOP10 + 部门汇总(≤20)。
- 推送:POST JSON 到 webhook(10s 超时,非 2xx=失败);`MarkReportRun` 记 last_run_at/last_error。
- 调度:`reports.Scheduler` 每小时检查,`ShouldRunMonthly` = last_run 月份早于当前月份(停机跨月/新部署自动补跑,幂等)。
- 端点:GET(读=usage:read)/POST/PUT/DELETE/:id/test(写=新权限点 `report:write`,super_admin 授予)。
- webadmin:「用量中心→报表订阅」页(列表/启停开关/测试推送/增删改;测试推送产生真实报表但不落 last_run_at)。

---

## 附录 A：参考

- 本项目历史调研（源码级，8 个开源项目）：`server/docs/research-usage-page/README.md`
- DeepSeek 查询余额：https://api-docs.deepseek.com/zh-cn/api/get-user-balance/
- new-api 日志与统计：https://docs.newapi.pro/zh/docs/guide/feature-guide/admin/log
- 现状代码：`server/webadmin/src/pages/Usage.tsx`（850 行）、`server/internal/serverauth/admin.go:642-696`、`server/internal/serverstore/usage_ledger.go:197`
