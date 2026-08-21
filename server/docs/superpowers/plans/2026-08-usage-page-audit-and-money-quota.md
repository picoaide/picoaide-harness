# 用量页审计 + 金额配额重构(2026-08)

> **2026-08-19 注记**:自研 Electron 客户端(desktop/)与浏览器插件已下线删除,仓库仅保留服务端接口与 webadmin 管理端。本文档为历史设计与计划,服务端相关部分仍有效,客户端相关部分不再适用。

> 范围:审计已提交的 usage 相关 7 个版本(221060f → ca27a93);调研 GitHub 企业级
> LLM 用量统计页;补齐「按员工单独设置金额(费用)配额」能力;重构 admin/usage 页为
> 企业端 UI。TDD 红-绿-commit。

## 1. 已提交版本审计(221060f → ca27a93)

| 版本 | 内容 | 审计结论 |
|------|------|----------|
| `221060f` feat: per-user monthly traffic quota and metering fix | 0021 迁移 `users.quota_tokens`;`EffectiveQuota`(admin 豁免 → 个人覆盖 → 全局默认 `usage.monthly_quota`);网关转发前检查,超限 429 `QUOTA_EXCEEDED`;用户更新 API `quota_tokens`/`quota_clear`;Users 页配额对话框 | ✅ 符合预期:按员工设置 token 月配额 + 全局默认,网关强制,admin 豁免。测试齐全(EffectiveQuota 三态、handler 四用例)。 |
| `ab665aa` feat: admin usage dashboard with VChart analytics and quota view | 引入 VChart;统计卡(请求/tokens/输入/输出);趋势/占比/排行三图;配额占用面板(进度条) | ⚠️ 首版可用但粗:饼图 NaN 标签、时区 off-by-one、VChart 全量打入主包(2.6MB)。 |
| `60eb20e` feat: usage dashboard hardening and bundle split | 抽 `lib/format.ts` 共享;VChart 懒加载(354KB);CSV 导出;Top-N+其他桶;按日补零;progressbar aria | ✅ 工程加固到位,包体大幅下降。 |
| `963b591` feat: usage time granularity, kind split, drill-down, polling | 服务端 week/month 分组+补零、embedding kind 拆分、username 过滤钻取;客户端粒度下拉、chat/embedding 拆分统计、用户钻取弹窗、60s 静默轮询、环比 delta | ✅ 功能维度齐全,钻取/轮询/环比均符合企业面板预期;测试 132(server)+42(client)。 |
| `e698f05` fix: usage aggregation edge cases from round-3 review | monthFill 月初归一防溢出;to+1 天用 AddDate 防 DST;username 过滤改相关子查询避免双 JOIN 别名冲突 | ✅ 边界修复正确,均有回归测试。 |
| `ca27a93` fix: skip compare query on polling, stable polling timer | 环比只在手动/首次加载查;轮询 timer 不随击键重建 | ✅ 性能修复合理。 |
| `f8bfdfe` fix(webadmin): usage date filter, grant dialog race, mask API keys | usage 日期过滤、授权对话框竞态、API key 掩码 | ✅ 前置修复。 |

**审计结论(是否符合预期)**:
- **符合**:token 维度配额体系(个人/全局默认/admin 豁免/网关 429 强制)完整闭环;
  用量聚合(day/week/month/model/user + kind 拆分 + 补零 + 钻取)数据正确性经三轮审计打磨。
- **不符合预期(3 处)**:
  1. **没有金额(费用)维度** —— 全链路只有 token 计数,无模型定价、无费用计算、无按员工金额配额。用户明确要求「每个员工都单独可以设置使用的金额」,这是核心缺口。
  2. **页面不够直观** —— 首页信息密度低:配额面板与用量查询分离、无费用汇总卡、无部门维度;交互偏数据报表而非企业面板(缺少预算/剩余/警告分级、员工卡片式概览)。
  3. **无「未定价」提示与兜底** —— 一旦引入费用,未配置价格的模型必须明确标注,避免费用为 0 造成配额失效。

## 2. GitHub 企业级用量页调研(子代理产出,见文末结论)

> 调研 OpenWebUI / LibreChat / One API(new-api)/ LiteLLM / Langfuse / Lunary /
> Helicone / Dify / FastGPT 等开源 admin 用量页。详细对比见 §4。

## 3. 目标设计

### 3.1 费用(金额)计算
- 定价模型:**每模型 input/output 每百万 token 价格**(单位:元 ¥,可配置),
  存 `models` 表新列 `input_price_per_1m` / `output_price_per_1m`(REAL,元/百万 token);
  embedding 复用 input 价(或单独列,设计取 input 价,标注即可)。
- 费用 = `prompt_tokens/1e6*input_price + completion_tokens/1e6*output_price`。
- 未定价模型(价格列 NULL/0)→ 费用计 0,页面标注「未定价」,配额面板提示「该员工使用含未定价模型,金额配额可能低估」。

### 3.2 按员工金额配额
- `users.quota_money`(REAL,元/月):NULL=跟随全局默认 `usage.monthly_quota_money`,
  0=不限,>0=按月金额上限;admin 豁免(与 quota_tokens 同构)。
- 网关强制:转发前同时检查 token 配额与金额配额,任一超限 → 429 `QUOTA_EXCEEDED`。
- Users 页配额对话框:token + 金额两个输入;Gateway 页全局设置加「默认月金额配额」。

### 3.3 用量页企业端重构
- **汇总卡**:总费用(¥)、总 tokens、请求数、环比 —— 费用为第一指标。
- **预算概览**:本月各员工金额占用进度条(超额红/临近黄),点击跳用户明细。
- **趋势/占比/排行**保留,新增「金额」切换(显示费用而非 tokens)。
- **明细表**加金额列;用户钻取弹窗加费用。
- **未定价提示**:模型价格未配置时 Badge 标注。

### 3.4 API 变更
- `GET /api/admin/usage` 行加 `cost`(该桶费用)。
- `GET /api/admin/users` 用户加 `quota_money`、`monthly_cost`。
- `PUT /api/admin/users/:id` 支持 `quota_money`/`quota_money_clear`。
- `GET/PUT /api/admin/gateway` 加 `monthly_quota_money`(全局默认金额配额)。
- 模型 CRUD 支持价格字段(Gateway 页模型管理编辑)。

### 3.5 迁移
- 0022: `users.quota_money REAL`;`models.input_price_per_1m REAL` / `output_price_per_1m REAL`。

## 4. 调研对比(子代理报告摘要)

> 完整报告与源码快照:`docs/research-usage-page/README.md`(全部结论经 GitHub API + raw 源码核验)。

| 项目 | 费用维度 | 按员工预算 | 可直接借鉴的 UI |
|------|----------|-----------|-----------------|
| OpenWebUI | ✗ | ✗ | KPI 行、趋势线、可排序双表、行级钻取弹窗、时间/组过滤器 |
| LibreChat | credits 折算 | 余额+自动续费 | 输入框用量仪表(Gauge 色阶) |
| One API | quota→货币 | 令牌额度+unlimited | 额度字段、耗尽状态徽标、货币换算 |
| **new-api** | 单价×用量 | **用户额度进度条(≤10%红/≤30%琥珀)+ Adjust 弹窗(加减覆盖+实时预览)+ 金额脱敏** | ⭐ 额度单元格/对话框最佳范例 |
| **LiteLLM** | **input/output 每百万 token 单价** | **user/team/key 三层预算,max_budget/soft_budget/重置周期** | ⭐ 费用仪表盘(KPI 卡+Daily Spend 柱状+Top Models 横条+Tab 组织) |
| Langfuse | token×cost | ✗ | ModelCostTable(合计行)、瓦片布局 |
| Helicone | cost 包(含缓存档) | ✗ | 计价引擎参考 |
| Dify | 套餐配额 | 套餐非员工 | ⭐ UsageInfo 卡(数值+进度+重置提示) |
| FastGPT | 积分钱包 | 充值余额 | 成员多选过滤、双视图(Tab 明细/仪表盘) |

**综合结论**:费用 = 每模型 input/output 每百万 token 单价 × token 数;预算 = 员工月度金额上限,
展示为「已用 ¥X of ¥Y + 进度条(80% 琥珀/100% 红)+ 剩余明细 tooltip」;页面信息架构 =
全局过滤器 → KPI 卡(费用为第一指标)→ 每日费用趋势 → Top 模型/用户排行 → 明细表(含金额列) →
员工钻取弹窗。未定价模型显式标注「未定价」避免金额配额被低估。

**本项目落地组合**(结合现有 shadcn 组件):KPI 卡栅格(费用/请求/输入/输出)→ VChart 趋势(金额/tokens 切换)
→ 本月费用预算面板(每员工进度条,超额红/临近琥珀,对齐 new-api 语义)→ 明细表(金额列)→ 用户钻取。

