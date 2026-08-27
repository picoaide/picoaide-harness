# 数据库

## 1. 服务端(PostgreSQL,PG-only 2026-08)

> 2026-08 起 SQLite 已全面下线:服务端数据库为 PostgreSQL(内置容器或外部实例)。
> 迁移在 `internal/serverstore/migrations-pg/`(0001–0039;0007 已废弃;0028 下线
> 知识库/MCP 表并独立审计表 audit_logs;0039 usage 按月原生分区 + 日/月账本)。

迁移在 `internal/serverstore/migrations/`(0001–0027,**0007 已废弃**;0028 下线知识库/MCP 表并独立审计表 audit_logs)。

### users(0001)
| 列 | 说明 |
|----|------|
| id | PK 自增 |
| username | 唯一,登录名 |
| display_name / email | 显示名/邮箱 |
| password_hash | argon2id 哈希(local 模式) |
| source | `local` \| `ldap` \| `oidc`,默认 local |
| is_admin | 0/1 |
| status | 1=启用 |
| quota_tokens | 0021 新增,月流量配额三态:NULL=跟随全局默认(`usage.monthly_quota`),0=不限,>0=按月限额;admin 一律豁免(网关强制) |
| quota_money | 0022 新增,月金额配额三态:NULL=跟随全局默认(`usage.monthly_quota_money`),0=不限,>0=按月金额上限(元);admin 一律豁免(网关强制) |
| created_at / updated_at | datetime,localtime |

### groups + user_groups(0001)
`groups(id, name 唯一, created_at)`;`user_groups(user_id, group_id, PK 复合)`。组用于技能授权(本地账号无组映射,以用户级授权兜底)。
- 0024 新增 `budget_money REAL`(部门月度金额预算,元):约束该部门树(含全部子部门)成员当月费用合计;员工生效预算 = 归属部门 + 祖先链(链上全部预算都约束,父部门 = 子树封顶);任一超限网关 429。费用聚合 `DeptMonthlyCost`/`DeptMonthlyCostBatch`(部门树 SUM(cost))。

### settings(0001)
`settings(key PK, value)`。键: `auth.mode` / `ldap.*` / `oidc.*` / `gateway.default_model` / `gateway.rate_limit` / `usage.monthly_quota`(员工默认月 token 配额,0=不限)/ `usage.monthly_quota_money`(员工默认月金额配额,元,0=不限)/ `usage.peak_windows`(高峰时段 JSON,北京时间,空=无峰谷价)/ `web.allow_private` / `web.search_endpoint` 等(见 04-auth.md、03-api-reference.md)。

### api_tokens(0002)
`id, user_id→users, token_hash(唯一), name(默认 'desktop'), created_at, expires_at(NOT NULL), last_used_at, revoked(0/1)`;索引 `idx_tokens_user`。明文 token 不落库,只存哈希;90 天过期。

### gateway_providers + models(0003)
- `gateway_providers(id, name 唯一, base_url, api_key_enc, models JSON '[]', enabled 0/1)`——`api_key_enc` 为 AES-GCM 密文(`enc:v1:`)。
- `models(id, name 唯一, provider_id→providers, display_name, default_params JSON '{}')`。
- 0022 新增 `input_price_per_1m REAL` / `output_price_per_1m REAL`(元/百万 token):NULL/0 = 未定价,费用按 0 计(页面标注「未定价」);embedding 复用 input 价。
- 0023 新增 `offpeak_discount REAL`(低谷折扣率):0<d<1 = 高峰窗口外费用 × d;nil/1 = 无峰谷价。

### usage(0004, 0039 起按月原生分区)

`usage` 主表 `PARTITION BY RANGE (created_at)`(PK 含 created_at),按月份分区
`usage_YYYYMM`(ensureUsagePartition 幂等创建);主表索引 PG16 自动传播。
列: `id, user_id, model, prompt_tokens(BIGINT), completion_tokens(BIGINT),
cache_prompt_tokens(BIGINT), kind, cost(DOUBLE), created_at`;索引
`idx_usage_user_time / idx_usage_time / idx_usage_model_time / idx_usage_kind /
idx_usage_user_cost`。写路径 `RecordUsage*` 先 ensure 当月分区。

**保留策略**: settings `usage.retention_months`(默认 6,0=永久,1~120);
`CleanupUsageRetention` 校验对应月日账已生成后 `DETACH PARTITION + DROP TABLE`
秒删过期明细。网关每次调用计量写入;`CleanupPendingUsage` 清理挂起记录(全零待定行)。月度聚合:`UserMonthlyUsage`(当月 SUM,走索引)/ `UserMonthlyUsageBatch`(管理页批量附用量);配额判定 `EffectiveQuota`(admin 豁免 → 个人覆盖 → 全局默认),网关转发前检查,超限 429 `QUOTA_EXCEEDED`。
- 0022 新增 `cost REAL DEFAULT 0`:记录时按模型定价折算的金额(元),后续改价/删模型不重写历史;金额配额与统计统一读 `SUM(cost)`。月度费用聚合:`UserMonthlyCost`/`UserMonthlyCostBatch`;金额配额判定 `EffectiveMoneyQuota`(admin 豁免 → 个人覆盖 → 全局默认 `usage.monthly_quota_money`),网关转发前检查,超限 429。
- 0023 新增 `models.offpeak_discount REAL`(低谷折扣率):结合 settings `usage.peak_windows`(高峰时段 JSON,北京时间,如 `[{"start":"09:00","end":"12:00"},{"start":"14:00","end":"18:00"}]`)——高峰窗口外(空闲时段)费用 × 折扣率;DeepSeek 官方当前政策(2026-08-16 生效)高峰 = 北京 09:00-12:00、14:00-18:00,空闲价 = 高峰价 × 50%(含缓存命中价)。历史 16:30-00:30 错峰政策已废弃,可在网关页自行配置。

### skills(0005)
`id, name 唯一, version, description, author, git_url, git_ref(默认 main), checksum, enabled(0/1,下架置 0 不删行), created_at, updated_at`。bootstrap 建议清单只返回 enabled=1。

### agent_presets(0032, 0033, 0035, 0037 + agent_preset_grants 0036)
`id, name, display_name, version(0035 起多版本), description, author, checksum, status('pending'|'approved'|'rejected'), reason, quality(0037:''|'official'|'featured'), created_at, updated_at`;0035 改 `UNIQUE(name, version)`(重建表,旧行 version='1.0.0');0036 新增 `agent_preset_grants(name, grantee_type user|group, grantee)`;0037 新增 quality 列(组织库质量标记,仅 approved 行可设置,reject/pending 清空)。状态机:上传 → pending;admin approve → approved(**授权后才可见可装**,作者可见自己的);reject(必填 reason)→ 仅作者可见可重提。归档存 `data/agent-presets-cache/<name>-<version>.tar.gz`。

### shared_skills(0034, 0037 + shared_skill_grants 0036)
`id, name, display_name, version, description, author, checksum, status('pending'|'approved'|'rejected'), reason, quality(0037:''|'official'|'featured'), created_at, updated_at`,`UNIQUE(name, version)` 多版本并存;0036 新增 `shared_skill_grants(skill_name, grantee_type, grantee)`;0037 新增 quality 列(组织库质量标记,仅 approved 行可设置,reject/pending 清空)。状态机同 agent_presets(上传 → 审核 → **授权后可见可装**);同名不同版本独立审核。归档存 `data/shared-skills-cache/<name>-<version>.tar.gz`。


`id(PK, 随机), user_id, csrf_key, expires_at`。管理端 24h 会话 + CSRF 校验(见 04-auth.md §4)。

### audit_logs(0028)
`id, username, action, detail, created_at`——用户/部门/技能/令牌等敏感操作审计(90 天保留,启动时清理)。由 0008 的 `kb_audit_logs` 迁入数据后清除旧表。

## 2. 客户端(已下线 2026-08:better-sqlite3 客户端存储的历史说明)

> 自研桌面客户端已下线,本仓库不再包含 `desktop/`(旧版:用户数据目录下 SQLite,4 张业务表 + schema_migrations):

| 表 | 列 | 说明 |
|----|----|------|
| conversations | id, title(默认 ''), mode(默认 'ask'), status(默认 'done'), model(默认 ''), workspace(默认 ''), created_at, updated_at | 会话;status 为中断恢复标记 |
| messages | id, conversation_id(CASCADE), role, content, reasoning(默认 ''), tool_calls JSON '[]', tool_call_id, tool_name, is_error(0/1), created_at | 消息;工具调用链与错误标记;索引 idx_messages_conv |
| artifacts | id, conversation_id(CASCADE), path, type(默认 'file'), size, created_at | 产物登记(磁盘产物路径) |
| settings | key PK, value | 可访问目录/建议安装管理等(键见 08-development.md) |
| schema_migrations | version PK, applied_at | 迁移记录 |

客户端迁移为数组顺序执行(`migrations[i]` 对应 version i+1),事务包裹。

### usage_daily / usage_monthly(0039,永久账本)

- **usage_daily 日账**: `PARTITION BY RANGE (day)` 按年分区(`usage_daily_YYYY`),
  `UNIQUE(user_id, model, day)`;列 `prompt_tokens/completion_tokens/cache_prompt_tokens/requests/cost`。
  **永久保留**(不随明细删)。
- **usage_monthly 月账**: 普通表 `UNIQUE(user_id, model, month)`(月初日期),
  聚合日账生成,**永久保留**(最终兜底,10 年 + 不删)。
- **生成**: `RebuildUsageLedger(from,to)` 从 usage 明细 UPSERT 日账/月账
  (幂等,可重算);启动时补算最近 N 个月(自愈),每日任务亦可调用。
- **查询路由**: 保留窗口内(近 N 月)查 usage 明细(分区裁剪);窗口外历史
  查 usage_daily/usage_monthly;用户全历史累计查 usage_monthly。
- **部门归因**: 账本仅存 user_id(无部门快照),按当前部门树
  (user_groups + groups.parent_id)现场计算。
