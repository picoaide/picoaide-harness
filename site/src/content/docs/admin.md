---
title: 管理后台
description: PicoAide Harness 管理后台（webadmin）功能指南：用户与部门、网关与限流、用量计费、市场与能力中心、审计与服务器信息。
---

管理后台（webadmin）是 Go 服务端内嵌的单页应用，通过浏览器访问 `/admin/`。它负责**管控**：账号、部门、模型网关、计量计费、市场与共享内容审批、审计。员工接触不到它——所有管控决策都在这里收口。

> 会话与安全：管理员登录使用 session + CSRF 防护；登录限流（10 次/5 分钟/键）；错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`；健康探针 `/healthz`。

## 导航总览

| 菜单 | 路径 | 职责 |
|---|---|---|
| 用户 | `/users` | 账号、角色、状态、配额 |
| 部门 | `/departments` | 部门树、成员、预算 |
| 网关 | `/gateway` | 上游供应商、默认模型、限流、高峰时段、登录模式 |
| 用量 | `/usage` | 费用、请求数、Token 明细、图表 |
| 市场 · 技能 | `/marketplace` | 商城技能管理、分级与授权 |
| 能力中心 | `/capabilities` | 共享技能/智能体统一审批队列（官方/精选标记、授权） |
| 审计 | `/audit` | 关键操作全程留痕 |
| 服务器信息 | `/server-info` | 版本、数据库驱动、构建信息 |

## 用户管理

- **创建用户**：用户名 + 密码 + 是否管理员（`is_admin`）；
- **状态**：启用 / 禁用——禁用**立即吊销该用户全部 API 令牌**，客户端需重新登录（与用户更新同事务）；
- **删除**：双重确认（明示会清除全部 API 令牌、用量记录与组归属，不可恢复）；
- **配额**：`quota_tokens`（月 token 上限：null=跟随全局默认，0=不限，>0=月上限）与 `quota_money`（月金额上限，语义相同）；表格展示**解析后生效配额**（跟随默认=全局值，admin=0）；
- **部门与角色**：用户归属部门，部门预算沿祖先链生效；
- 登录模式相关字段（local/LDAP/OIDC）见网关页。

## 部门管理

- 部门树形结构，成员归属于部门；
- **部门预算**（`groups.budget_money`）：归属部门 + 祖先链全部生效，预算内 SUM(cost) 计入部门用量；
- 授权对象：市场/组织内容可授权给**用户或部门**（NOCASE 匹配）。

## 网关配置

- **上游供应商（providers）**：渠道（channel 选择，如 deepseek）、名称、base URL、API key（SecretInput 显隐切换）、模型列表（保存后自动同步或手填）、启用开关；
- **默认模型**：全局选择（下拉）；
- **限流**：per-user 限流策略；
- **高峰时段**：多段高峰窗口（`usage.peak_windows`，北京时间），支持每周几选择 + 开始/结束时间；高峰外按模型 `offpeak_discount` 折算计价；
- **模型定价**：每模型 input/output 单价（元/M tokens，`input_price_per_1m` / `output_price_per_1m`），另有**缓存命中输入价**（`cache_input_price_per_1m`）与**低谷折扣率**（`offpeak_discount`，0-1）——未定价模型费用按 0 计；修改价格/折扣只影响之后产生的费用（历史费用按记录时定价留存）；
- **缓存命中计费**：命中缓存的输入 token 按缓存价计费，未配置缓存价时回退输入价（DeepSeek 缓存价）；
- **峰谷折算**：高峰窗口外（空闲时段）且模型配置了低谷折扣率时，费用 = 标准价 × 折扣率；高峰时段按标准价；DeepSeek 官方当前政策（2026-08 起）= 周一至周五 09:00-12:00、14:00-18:00 为高峰，其余（含周末）为空闲，空闲价 = 高峰价 × 50%。
- **登录模式**：`local` / `ldap` / `oidc` / `both`（local+ldap）切换：
  - LDAP：`ldap_url`、`ldap_bind_dn`、`ldap_base_dn`、`ldap_user_filter`（如 `(uid=%s)`）、`ldap_group_filter`（如 `(memberOf=cn=%s)`）；
  - OIDC：`oidc_issuer`、`oidc_redirect_url`（如 `https://picoaide.example.com/api/auth/oidc/callback`）。

## 用量统计

- **统计卡**：总费用、请求数（chat/embedding 分类）、总 tokens；
- **维度**：按用户 / 按模型 / 按日期；费用（money）与 token 两套口径切换；
- **图表**：柱状图（费用/tokens 趋势）、饼图（模型分布）、钻取（drill-down：筛选用户 → 看其模型构成）；
- **明细**：行级费用、prompt/completion tokens、请求数；缓存命中计费在明细中体现（按缓存价）；
- **余额**：`GET /api/auth/usage` 员工自查询——剩余额度（配额−本月已用；不限=null）、今日/昨日/本月/累计 tokens 与费用、部门预算链。

## 市场 · 技能（商城）

- 技能 CRUD（上架/编辑/下架/重新上架），技能来源为建议清单（bootstrap 推荐清单）或管理员录入（Git 地址，支持 http/https 远程仓库）；
- **授权制**：技能市场按用户/部门授权（GrantDialog），未授权一律 404（严格默认拒绝，不泄露存在性），admin 恒全量不落授权表；授权变更写入审计日志；
- **分级语义预留**：市场端「免费版 / 专业版」分级词已定名（与组织库「官方/精选」质量标记两套词表隔离），当前版本分级字段随商城分级演进在后续版本落地。

## 能力中心（统一审批队列）

共享技能（`shared_skills`）与共享智能体（`agent_presets`）在此统一审批：

- **只读队列**：聚合两域 pending/approved/rejected，列表展示作者、版本、状态；操作走原域端点（`/api/server/admin/shared-skills/...`、`/api/server/admin/agent-presets/...`）；
- **筛选**：状态 Tab（待审核/已通过/已拒绝/全部）+ 类型筛选（技能/智能体）；
- **审批动作**：approve / reject（reject 必填 reason，员工端展示「未通过原因」） / delete；**名称冲突**：与市场技能同名时显示警告，approve 将 409 阻断（需先删/改市场技能或驳回共享技能）；
- **质量标记**：`quality` = 官方（official）/ 精选（featured）——**仅 approved 可设**，reject/pending 自动清空；互斥；
- **授权弹窗**：复用 GrantDialog——approved 后仍需按用户/部门授权才可见可装（**双门制**，与市场同构）；admin 恒可全量；
- **统计**：下载/调用计数（技能含 calls）随审批队列展示；
- 审计动作名如 `skill_approve` / `*_qualify`。

> 历史：早期独立页面 `/shared-skills`、`/agent-presets` 及其导航已并入「能力中心」（2026-09），路由不再保留。

## 审计日志

- 覆盖：用户、部门、配额、网关定价、高峰窗口、商城 CRUD、共享内容审批与授权、quality 标记、密钥变更等关键操作；
- 记录内容：操作者、动作名（如 `skill_approve`、`user_update`、`usage_peak_update`、`provider_update`）、目标、时间、前后值摘要；
- 筛选：按动作类型/目标/时间范围过滤，全程留痕可回溯。

## 服务器信息

- 展示当前服务端版本、数据库驱动（PostgreSQL）、构建信息；健康检查状态（`/healthz`）与运行环境摘要。

## 部署相关

服务端以单二进制运行，也可走 Docker Compose（Caddy 反代 + 私有网段固定 IP + 非 root + bind mount 数据目录）；数据库为 PostgreSQL（内置或外部实例，PG-only）。详见[私有化部署指南](./deployment)。
