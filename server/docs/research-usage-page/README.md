# LLM 用量/费用统计页面 — 开源项目调研报告

> 调研方式说明:web_search 因缺 API key 不可用,改用 **GitHub REST API(文件树)+ raw.githubusercontent.com(源码全文)** 直接核验,以下所有结论均出自真实仓库源码,非二手资料。源码快照存放在本目录 `src/<project>/` 下可复核。

---

## 1. OpenWebUI(open-webui/open-webui)

- **仓库**:https://github.com/open-webui/open-webui
- **用量页源码**:`src/lib/components/admin/Analytics/Dashboard.svelte`(admin 设置内嵌 Analytics 面板)、后端 `backend/open_webui/routers/analytics.py`(`/api/v1/analytics/summary|models|users|daily|tokens`)
- **统计卡片/图表**:
  - 顶部汇总行:total messages / total tokens / total chats / total users(纯文本 KPI 行,非卡片)
  - **趋势线**:`ChartLine.svelte` 每日/每小时 Messages 多模型折线图(取 TOP 8 模型、8 色板)
  - **两张表格并排**(`md:grid-cols-2`):Model Usage 表(# / Model(头像) / Messages / Users / Chats / Tokens / % 占比,列头可排序)+ User Activity 表(# / User / Messages / Tokens)
  - 行点击钻取:Model 行 → `AnalyticsModelModal` 弹窗看该模型明细
  - 时间粒度:24h 按小时、其余按天;支持自定义日期区间;**用户组(group)下拉过滤**;选择持久化到 localStorage
- **预算/额度**:无。OpenWebUI 核心**没有**按用户 token 额度/金额预算;token 数标注"估测,可能与实际 API 用量不符";仅通用限流 `backend/open_webui/utils/rate_limit.py`
- **费用计算**:无 cost 概念
- **布局亮点**:设置页内嵌式面板 + 顶部时间/组过滤器 + 可排序表格 + 行级钻取弹窗
- **可借鉴性**:高(信息架构与钻取交互),但缺费用与预算维度

## 2. LibreChat(danny-avila/LibreChat)

- **仓库**:https://github.com/danny-avila/LibreChat
- **相关源码**:`client/src/components/Nav/SettingsTabs/Balance/TokenCreditsItem.tsx`、`packages/data-schemas/src/schema/transaction.ts`、`packages/api/src/middleware/checkBalance.ts`、`client/src/components/Chat/Input/TokenUsage/Gauge.tsx`
- **统计卡片/图表**:无 admin 用量仪表盘;用户侧有 TokenCreditsItem(设置页 Balance 项显示余额,`toFixed(2)` 小数位)与聊天输入框内**上下文窗口用量环形仪表**(Gauge,>75% 警告色、>90% 错误色)
- **预算/额度**:有 **TokenCredits 余额体系**(单位:内部积分 credits,非美元直读):
  - `Transaction` 表:`tokenType: prompt|completion|credits`、`rate`、`rawAmount`、`tokenValue`,每模型配置 multiplier(价值系数)
  - `checkBalance.ts`:`tokenCost = amount × multiplier`,余额不足拒发请求;支持 `startBalance`(新用户初始余额)、**auto-refill**(自动充值:额度+间隔+阈值)
  - 服务端限流中间件按 user 维度(`messageLimiters` 等)
- **费用计算**:按模型 multiplier 将 token 折算成 credits,credits 与美元挂勾(admin 配置)
- **布局亮点**:Balance 设置在用户设置导航内;用量仪表做在输入框上(实时、不打断)
- **可借鉴性**:中高(余额/自动续费机制值得抄,但缺少统计图表)

## 3. One API(songquanpeng/one-api)

- **仓库**:https://github.com/songquanpeng/one-api
- **相关源码**:`web/default/src/pages/Token/index.js`、`web/default/src/pages/Token/EditToken.js`、`web/default/src/components/TokensTable.js`、`web/default/src/helpers/render.js`
- **统计卡片/图表**:无图表;令牌列表表格为主(名称/模型/状态/已用额度/剩余额度/创建时间),状态徽标含 **enabled / disabled / expired / depleted(额度耗尽)** 四态
- **预算/额度(单位:内部 quota → 货币)**:
  - `remain_quota` 默认 500000,可勾选 **unlimited_quota(不限额度)**;`render.js`:`显示金额 = quota ÷ quota_per_unit`(如 500000÷100000=$5.00,单位随配置为 USD/CNY)
  - 附加:过期时间(快捷按钮 1 个月/1 天/1 小时/1 分钟/永不过期)、IP 子网限制、可指定模型集合
  - 用户页也有"我的额度"入口,admin 可给用户调整额度
- **费用计算**:每模型配 `ratio`(倍率),一次调用按 token 数 × ratio 计 quota
- **布局亮点**:经典后台表格 + 编辑弹窗/独立编辑页;额度字段带货币换算提示文案
- **可借鉴性**:高(额度字段、不限额度开关、耗尽状态、货币换算展示)

## 4. new-api(QuantumNous/new-api,one-api 的活跃 fork)

- **仓库**:https://github.com/QuantumNous/new-api
- **相关源码**:`web/src/features/usage-logs/`(index / table / common-logs-stats / log-cost-display / user-quota-cell / user-quota-dialog)、`web/src/features/users/components/user-quota-dialog.tsx`
- **统计卡片/图表**:
  - `CommonLogsStats`:三条 StatBadge —— **Usage(总消耗额度)/ RPM / TPM**,`sensitiveVisible` 开关时金额显示 `••••` 脱敏
  - 日志表格(`usage-logs-table.tsx`)按 section 分区:Common Logs / Drawing Logs / Task Logs,带过滤工具栏、详情弹窗
  - `LogCostDisplay`:单条日志的额度徽标(如 `¥0.42`,前缀+金额分段渲染)、订阅抵扣徽标、工具调用加价角标(+ 带 tooltip)
- **预算/额度(单位:货币或 tokens 可切换)**:
  - **用户列表每行 `UserQuotaCell`**:两列 `剩余额度 | 总额度` + **Progress 进度条**(剩余 ≤10% 红、≤30% 琥珀、其余绿)+ tooltip 显示 Used/Remaining/Total/Percentage
  - **`UserQuotaDialog`「Adjust Quota」**:模式 `add / subtract / override`,输入金额(或 tokens 模式),**实时预览算术**「当前:X +Y = Z」;`parseQuotaFromDollars` 表明以美元输入、内部换算
  - 系统设置 `quota-settings-section.tsx`:新用户初始额度、免费模型预扣、外部充值链接;货币体系 `currencyMeta.kind === 'tokens'` 时切换为纯 token 单位
- **费用计算**:模型配置单价(每 1k token / 图像 / 调用),请求按用量×单价结算扣额度
- **布局亮点**:侧边栏 section 导航 + 表格 + 顶部统计徽标;**单元格内进度条 + 悬停明细**是额度展示的最佳范例
- **可借鉴性**:极高(额度进度条、调整对话框、脱敏、货币/token 双模式全部现成)

## 5. LiteLLM Proxy(BerriAI/litellm)

- **仓库**:https://github.com/BerriAI/litellm
- **相关源码**:`ui/litellm-dashboard/src/app/(dashboard)/usage/page.tsx` + `UsagePageView.tsx` + `EntityUsage/*`;`app/(dashboard)/budgets/*`(page / BudgetTableColumns / budget_modal);`components/shared/table_cells/spend_budget_cell.tsx`;模型计价 `model_prices_and_context_window.json`
- **统计卡片/图表**(Cost Tab 最全):
  - **KPI 卡片栅格**:Total Requests / Successful(green)/ Failed(red,均带 info tooltip 说明口径)/ **Average Cost per Request** / **Total Tokens(点击展开 Input / Output / Cache Read / Cache Write 四个 token 卡片)**
  - **Daily Spend 柱状图**(每日费用,自定义 tooltip 展示 spend/requests/success/failed/tokens)
  - **Gateway Requests by Endpoint** 堆叠柱状图(成功/失败)
  - **Top Virtual Keys** 与 **Top Models**(水平条形图,TOP 5/10/20 切换、模型名/模型组视图切换)
  - **Spend by Provider**(供应商费用占比)
  - Tabs 切换:Cost / Model Activity / Key Activity / MCP Server Activity / Endpoint Activity
  - 顶部:**UsageViewSelect(global / my-usage / user / tag 作用域)+ AdvancedDatePicker + UserDropdown(按用户过滤)**;大数据分页拉取带进度 Alert 与"Stop"
  - 导出按钮(Export Data)+ Ask AI 按钮
- **预算/额度(单位:USD)**:
  - **Budgets 页**:表格列 Budget ID / **Max Budget($)** / TPM / RPM / **Reset(budget_duration:24h/7d/30d)** / Created,行操作编辑/删除;`budget_modal` 字段:tpm_limit、rpm_limit、max_budget(USD)、budget_duration,可展开可选(soft_budget、model_max_budget、max_parallel_requests)
  - 数据模型 `litellm/models/budget.py`:`soft_budget / max_budget / max_parallel_requests / tpm_limit / rpm_limit / model_max_budget / budget_duration`
  - 预算可挂到 **user / team / key 三层**,子实体可继承父级预算(`InheritedBudgetHint`)
  - **`SpendBudgetCell`(表格内嵌)**:`$spend of $budget` + 进度条,`>100% → over(红)、≥80% → warning(琥珀)`;无预算显示 "· Unlimited"
  - 强制:超预算经 `max_budget_limiter` 拦截请求,Slack 告警(`budget_alert_types.py`)
- **费用计算**:`model_prices_and_context_window.json` 每模型 `input_cost_per_token / output_cost_per_token`(及缓存档位),cost = Σ token × 单价;支持每模型倍率/自定义价格
- **布局亮点**:单一 Usage 页内 Tabs 组织全部维度;KPI 卡 + 柱状图 + 排行条 + 表格混合;预算贯穿"列表→详情→单元格"
- **可借鉴性**:极高(费用维度的完整仪表盘 + 三层预算体系都是直接范本)

## 6. Langfuse(langfuse/langfuse)

- **仓库**:https://github.com/langfuse/langfuse
- **相关源码**:`web/src/features/dashboard/components/ModelCostTable.tsx`、`ModelUsageChart.tsx`、`TracesTimeSeriesChart.tsx`、`web/src/components/token-usage-badge.tsx`、`web/src/server/api/routers/users.ts`
- **统计卡片/图表**:
  - Dashboard 网格卡片(**DashboardCard 瓦片**):ModelCostTable(Model / Tokens / **USD** 三列,行 collapse 5→20,**底部 TotalMetric 合计**)、ModelUsageChart(按模型拆分的时间序列)、TracesTimeSeriesChart、LatencyChart、ScoresTable 等
  - Trace 行内 **TokenUsageBadge**:`input → output (∑ total)` 徽标;usage 表支持按用户/会话聚合
  - **Users 页按用户聚合**:`totalPromptTokens / totalCompletionTokens / totalTokens / sumCalculatedTotalCost`
- **预算/额度**:无(可观测平台,非网关);配额仅存在于其云版 billing
- **费用计算**:模型定义里配 cost per token,cost = tokens × cost-per-token(**官方文案:"Calculated multiplying the number of tokens with cost per token for each model"**),支持自定义模型价格
- **布局亮点**:瓦片化仪表盘 + 每个瓦片独立加载态/折叠;时间序列图 + 占比排行表组合;费用列与合计行是成本表的标准形态
- **可借鉴性**:高(成本表/合计/瓦片布局),无预算交互

## 7. Lunary 与 Helicone

### Lunary(lunary-ai/lunary)
- **仓库状态**:主仓库已不可访问(GitHub API 404,**已闭源/下架**,仅存 SDK 仓库 `lunary-ai/lunary-js`、`lunary-ai/lunary-py`,镜像 `api-evangelist/lunary` 仅 68 个文件无 UI 源码)。其 SaaS 功能描述见 https://docs.lunary.ai —— 有 Usage(按用户/模型/日期聚合)+ 每用户 budget(额度+周期)。**UI 源码无法核验,不建议作为借鉴对象**

### Helicone(Helicone/helicone)
- **仓库**:https://github.com/Helicone/helicone
- **相关源码**:`packages/cost/`(Cost.ts / costCalc.ts)、`bifrost/app/stats/ModelUsageChart.tsx`、`ProviderUsageChart.tsx`
- **统计卡片/图表**:stat 页 Model/Provider 用量图;主页 BigDashboard;llm-cost 模型价格计算器。**其 SaaS 主应用 UI 闭源**,开源部分主要为 `packages/cost` 计价引擎与市场页图表
- **费用计算(最细粒度)**:`ModelRow.cost` 含 `prompt_token / completion_token / per_image / per_call / prompt_cache_write_token / prompt_cache_read_token / prompt_audio_token / completion_audio_token`(anthropic 缓存档 5m/1h),COST_PRECISION_MULTIPLIER 定点存储
- **可借鉴性**:计价引擎(含缓存档位)值得抄,页面 UI 借鉴价值低

## 8. Dify 与 FastGPT

### Dify(langgenius/dify)
- **仓库**:https://github.com/langgenius/dify
- **相关源码**:`web/app/components/billing/usage-info/index.tsx`(UsageInfo 卡片)、`apps-info.tsx`、`vector-space-info.tsx`
- **统计卡片/图表**:Billing 页 = 一排**配额卡片**:图标 + 名称 + tooltip + **`usage / total`(带单位)+ 底部 Meter 进度条**;tone:`≥100% error、≥80% warning、其余 neutral`;**unlimited 显示 "Unlimited"**;右缘显示 **"resets in N days" 重置提示**;`<50MB` 等存储阈值有特殊"装饰条"处理
- **预算/额度**:套餐配额(按 token/存储空间),非按用户设置
- **布局亮点**:`UsageInfo` 卡片组件(单卡 = 名称+数值+进度+重置提示)是**配额展示的最小完备单元**
- **可借鉴性**:极高(配额卡片 UI),无按员工维度

### FastGPT(labring/FastGPT)
- **仓库**:https://github.com/labring/FastGPT
- **相关源码**:`projects/app/src/pages/account/usage/index.tsx`、`pageComponents/account/usage/Dashboard.tsx`、`DashboardChart.tsx`、`UsageTable.tsx`、`UsageRechargeModal.tsx`;`packages/global/support/wallet/usage/constants.ts`
- **统计卡片/图表**:
  - Tabs:**usage_detail(明细表)/ dashboard(仪表盘)**
  - 过滤器:**DateRangePicker + 成员多选(头像下拉,管理员可见)+ 用量来源多选 + 应用名搜索**
  - Dashboard:**总用量(积分)+ 每日积分 LineChart**(recharts,424px 高,自定义 tooltip);"查看剩余积分"按钮 → 充值弹窗
  - Detail:表格按日期行聚合 `total_points` 等
- **预算/额度(单位:积分 points)**:钱包制(充值/订阅/账单),**团队管理员可看全成员用量并按成员过滤**;额度为预充值余额而非周期性预算
- **费用计算**:每次调用按模块/模型换算成积分扣减
- **布局亮点**:Tab 双视图 + 多维度过滤器(成员×来源×时间)是"按员工看用量"的直接范本;`UsageSourceEnum`(fastgpt/app/API/分享链接/数据集训练/定时任务/企微/飞书/钉钉/微信公众号/mcp/evaluation 等)展示了**按入口聚合**的维度设计

## 9. 其他参考(简评)

- **Casdoor(casdoor/casdoor)**:https://github.com/casdoor/casdoor —— IAM 侧参考,`web/src/PlanListPage.js` / `PlanEditPage.js` 是 SaaS 套餐+配额管理(非 LLM 用量),可参考"套餐→配额→用户"的层级建模
- **Portkey-AI/gateway**:https://github.com/Portkey-AI/gateway —— 开源网关但**管理台闭源**,仓库内仅有 token 计数 handler,无用量 UI
- 均**不建议**作为用量页 UI 参考

---

## 综合结论(企业端用量页设计建议)

**推荐信息架构**:左侧导航分组「用量总览 / 日志明细 / 预算管理 / 模型与价格」,总览页顶部一行全局过滤器(**时间范围 24h/7d/30d/自定义 + 部门/员工下拉 + 模型/来源多选**,参照 OpenWebUI 组过滤与 LiteLLM UserDropdown),其下依次:KPI 卡片行(总费用/请求数/成功率/总 tokens,可点击展开输入输出缓存拆分,LiteLLM 式)→ **每日费用趋势柱状图** → 双栏「TOP 模型费用排行(横条,TOP5/10/20)+ 供应商/入口占比」→ **按员工费用表(每行内嵌剩余额度进度条)**,再钻取到员工详情(时间序列+模型构成)。成本口径统一为**金额**:内部按模型 `input/output 每百万 token 单价`(含缓存档,参照 LiteLLM model_prices JSON 与 Helicone cost 包)折算,支持 CNY/USD/tokens 三种展示模式(new-api 做法)。

**金额预算的展示与交互**:
1. **设置入口**:员工维度上「设定月度预算(金额)」+ 可选 TPM/RPM 与每模型上限(LiteLLM budget 字段);支持 add/subtract/override 三种调整模式并实时预览算术结果(new-api UserQuotaDialog);可设 unlimited 开关(one-api)。
2. **展示**:表格单元格内 `已用 $X of $Y` + 进度条,阈值 80% 琥珀 / 100% 红(new-api 为剩余≤10%红;Dify Meter 同语义),悬停 tooltip 展示 Used/Remaining/Total/Percentage;超限标"Depleted"状态徽标(one-api);周期预算显示"距重置 N 天"(Dify resetHint)。
3. **联动**:超预算自动拦截 + 管理员告警(LiteLLM max_budget_limiter/Slack);预算继承(部门→员工,LiteLLM team→user 继承 + InheritedBudgetHint);金额敏感列支持脱敏切换(new-api `••••`)。

**可直接开源的借鉴组合**:new-api 的 UserQuotaCell/Dialog + LiteLLM 的 UsagePageView 结构 + OpenWebUI 的排序表格与模型钻取弹窗 + Dify 的 UsageInfo 配额卡。注意:OpenWebUI/LibreChat 均无金额费用维度,费用与预算必须自建(计价表 + 结算流水表,可仿 LiteLLM spend_logs + budget 模型)。
