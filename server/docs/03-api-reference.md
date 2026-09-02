# API 参考(服务端 HTTP)

> 所有端点以代码为准(`internal/router` 包集中声明;业务包 handler 集合见 `internal/*/handlers.go`)。错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。
>
> 命名空间:`/api/server/*` 管理面、`/api/client/v2/*` 客户端员工面、`/v1/*` LLM 网关(独立命名空间,Bearer)。旧前缀(`/api/admin`、`/api/marketplace`、`/api/auth`、`/v2/api/*` 等)均已移除。

## 1. 错误码

| code | HTTP | 说明 |
|------|------|------|
| `AUTH_REQUIRED` | 401 | 缺少认证令牌 |
| `AUTH_FAILED` | 401 | 令牌无效或已过期 / 凭证错误 |
| `FORBIDDEN` | 403 | 管理端权限不足 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `VALIDATION` | 400 | 参数校验失败 |
| `UPSTREAM` | 502 | 上游 LLM 错误 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `PASSWORD_CHANGE_REQUIRED` | 403 | 密码被管理员重置后强制改密:改密完成前仅放行改密/me/logout(0057) |
| `QUOTA_EXCEEDED` | 429 | 员工本月 token 或金额配额已用尽(admin 豁免;每用户配额见 users.quota_tokens / users.quota_money,全局默认见 usage.monthly_quota / usage.monthly_quota_money) |
| `INTERNAL` | 500 | 内部错误 |

## 2. 鉴权方式

| 方式 | 说明 |
|------|------|
| **Bearer token** | `Authorization: Bearer <api_token>`;`POST /api/client/v2/auth/login` 签发,90 天过期,哈希存储 |
| **管理端 session** | Cookie `picoaide_session`(HttpOnly, SameSite=Lax, 24h);写操作需 header `X-CSRF-Token`(登录响应返回) |

## 3. 认证

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/client/v2/auth/login` | 无 | 密码登录(local/LDAP);body `{username, password}` → `{token, user, must_change_password}`(0057:must_change_password=true 时客户端进入强制改密页,改密前业务 API 均 403 `PASSWORD_CHANGE_REQUIRED`) |
| POST | `/api/client/v2/auth/password` | Bearer | 员工自助改密(0057):body `{old_password, new_password}` → `{ok}`;仅本地认证(`source=local`)用户;成功后吊销该用户全部 api_tokens 与 admin_sessions(含当前),客户端须重新登录 |
| POST | `/api/client/v2/auth/logout` | Bearer | 吊销当前 token |
| GET | `/api/client/v2/auth/me` | Bearer | 当前用户 `{user:{id, username, display_name, email, is_admin, role, permissions, status, quota_tokens, quota_money, source, password_changeable, password_must_change, password_changed_at, mfa_enabled}}`(0057 起 source/password_changeable 供客户端判断改密入口;mfa_enabled 供管理端列表) |
| GET | `/api/client/v2/auth/usage` | Bearer | 员工用量概览(自查询):`{is_admin, quota_tokens, quota_money, monthly_usage/cost, remaining_tokens/money(不限=null), today_usage/cost, yesterday_usage/cost, total_usage/cost, dept_budgets[]}`;有效配额 = 个人覆盖→全局默认,admin 豁免 |
| GET | `/api/client/v2/auth/methods` | 无 | 登录方式发现(`public methods`,登录页未登录时探测) |
| GET | `/api/client/v2/auth/:provider/login` | 无 | 跳转 OIDC/OpenID 授权页(provider 由配置注册,如 `oidc`、`openid`) |
| GET | `/api/client/v2/auth/:provider/callback` | 无 | OIDC 回调,换取服务端 token |

## 4. 管理端(webadmin,全部 session 鉴权 + RBAC)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/server/admin/login` | 管理员登录(仅 `super_admin`/`auditor` 角色;`user` → 403;本地账号;0057 起已开启 MFA 时返回 `{mfa_required:true, mfa_ticket}` 而非直接建会话) |
| POST | `/api/server/admin/login/mfa` | 两步登录第二步(0057,公开):body `{mfa_ticket, code}`(TOTP 6 位码)→ 与一步登录相同响应 `{csrf_token, user, must_change_password}`;挑战 5 分钟有效、失败 ≥5 次作废、一次性消费 |
| POST | `/api/server/admin/me/password` | 改自己密码(0057):body `{old_password, new_password}`;校验旧密码;成功后吊销其全部 api_tokens 与 admin_sessions(含当前),webadmin 强制登出 |
| GET | `/api/server/admin/me/mfa` | 当前管理员 MFA 状态 `{enabled}`(0057) |
| POST | `/api/server/admin/me/mfa/enable` | 开启 MFA(0057,第一步):body `{password}`(主密码)→ `{secret, otpauth_url, ticket}`(密钥仅此一次下发;60s 内完成 verify) |
| POST | `/api/server/admin/me/mfa/verify` | 开启 MFA(0057,第二步):body `{ticket, code}` 验证通过 → 启用并吊销该管理员其他已登录会话(当前保留) |
| POST | `/api/server/admin/me/mfa/disable` | 关闭 MFA(0057):body `{password, code}` 主密码+当前动态码双验 → 吊销其他会话(当前保留) |
| PUT | `/api/server/admin/users/:id/mfa` | 重置(关闭)其他管理员的 MFA(0057,`PermUserWrite`):清空密钥并吊销其全部会话;不能对自己操作 |
| GET | `/api/server/admin/auth/methods` | 登录方式发现(公开) |
| GET | `/api/server/admin/me` | 当前管理员信息(含 role/permissions) |
| POST | `/api/server/admin/logout` | 登出(清 session) |
| GET | `/api/server/admin/users` | 用户列表(附带 `quota_tokens`/`quota_money`/`role` 与 `monthly_usage`/`monthly_cost` 本月用量/费用) |
| POST | `/api/server/admin/users` | 创建用户 `{username, password?, display_name?, email?, role?|is_admin?, source?}`(role ∈ super_admin/auditor/user;is_admin 为兼容别名) |
| PUT | `/api/server/admin/users/:id` | 更新用户(改密/角色/启用停用;`quota_tokens`/`quota_money` 设置月度配额(0=不限),`quota_clear:true`/`quota_money_clear:true` 恢复跟随全局默认;改密/降权/禁用自动吊销 token) |
| DELETE | `/api/server/admin/users/:id` | 删除用户 |
| PUT | `/api/server/admin/users/:id/department` | 设置用户部门归属(2026-09 多部门):body `{group_ids:[n1,n2,...]}`(空=清空);兼容旧 `{group_id:n}`。预算 = 全部所属部门+祖先链同时生效,任一超限即拦(429) |
| GET | `/api/server/admin/users/:id/groups` | 用户组/部门列表 |
| GET/PUT | `/api/server/admin/departments`、`/departments/:id` | 部门树 CRUD(含预算 `budget_money`、parent/leader) |
| GET | `/api/server/admin/users/:id/tokens` | 用户 token 列表 |
| POST | `/api/server/admin/tokens/:id/revoke` | 吊销指定 token |
| GET | `/api/server/admin/usage` | 用量汇总(按用户/模型/时间;`group=user` 展示用户名) |
| GET | `/api/server/admin/server-info` | 版本/数据库驱动(PG)/迁移版本/运行环境摘要 + `update_check`(实时 GitHub Releases 版本检查,失败为 null) |
| GET | `/api/server/admin/concurrency` | 按模型并发状态(2026-08-31):当前 in-flight + 90 天峰值(`model_concurrency_stats`)+ 目标(`default_params.concurrency_target`),扩容申请依据 |
| GET | `/api/server/admin/providers` | 网关上游列表(含 `protocol`:openai/anthropic/both) |
| POST | `/api/server/admin/providers` | 添加上游 `{name, base_url, api_key, models, enabled, protocol?, channel?}`(api_key 服务端加密存储;protocol 缺省 openai) |
| PUT | `/api/server/admin/providers/:id` | 更新上游(protocol 可切换) |
| DELETE | `/api/server/admin/providers/:id` | 删除上游 |
| POST | `/api/server/admin/providers/:id/sync` `providers/sync-all` | 模型同步 |
| GET | `/api/server/admin/models` | 模型列表 |
| POST | `/api/server/admin/models` | 创建模型 `{name, provider_id, display_name?, default_params?, input_price_per_1m?, output_price_per_1m?, cache_input_price_per_1m?, offpeak_discount?}`(价格 = 元/百万 token,缺省 = 未定价;0029 缓存命中输入价) |
| PUT | `/api/server/admin/models/:id` | 更新模型(价格/折扣留空不覆盖;修改只影响之后产生的费用) |
| DELETE | `/api/server/admin/models/:id` | 删除模型 |
| GET | `/api/server/admin/gateway` | 网关配置:`{rate_limit, monthly_quota, monthly_quota_money, peak_windows, retention_months, default_model, default_thinking_level, server_base_url, error_reporting_dsn/enabled/level, glitchtip_base_url/organization}` |
| PUT | `/api/server/admin/gateway` | 写网关配置(settings:`gateway.rate_limit`、`gateway.default_model`、`usage.monthly_quota`、`usage.monthly_quota_money`、`usage.peak_windows`、`usage.retention_months`、`web.default_thinking_level`、`server.base_url`、`web.error_reporting_*`、`web.glitchtip_*`) |
| GET | `/api/server/admin/channels` | 渠道列表 |
| GET/PUT | `/api/server/admin/connectors`、`/connectors/:id` | 连接器目录 CRUD(0042;示例企业/sales-easy 等定义服务端下发) |
| GET | `/api/server/admin/audit` | 审计日志分页 `?page=&size=&action=&username=`(90 天保留 → 默认 180 天,settings `audit.retention_days`;0048 起哈希链) |
| GET/PUT | `/api/server/admin/auth`、`POST /auth/test` | 认证配置(脱敏读/写/连接测试;LDAP 测试连接返回目录统计 `{ok, message, users, groups, sample[5]}`;密码传 `***`/空 = 用已保存值测试) |

> **LDAP 目录自动同步(2026-09)**:LDAP 配置保存后立即触发一轮全量同步,此后服务端每 1 小时自动一轮。同步语义:目录存在的用户自动创建/更新(显示名/邮箱/组,组全量替换)/重新启用;目录已消失的外部用户自动停用 + 吊销全部 token;同名本地账号绝不被外部身份接管;空目录(0 用户)拒绝执行(防误停用全部外部用户)。

## 5. AI 网关(客户端用,Bearer;独立命名空间 `/v1/*`,另有无 `/v1` 官方原生变体)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/chat/completions` | OpenAI 兼容 chat 代理(下方详述) |
| POST | `/v1/completions` / `/v1/responses` / `/v1/embeddings` | 原生/兼容形态(同网关计量) |
| POST | `/v1/messages` | Anthropic Messages 兼容(0043,web_search 服务端代理) |
| GET | `/v1/models` | 可用模型列表 |

> 无 `/v1` 前缀的官方原生变体(`/chat/completions`、`/completions`、`/responses`、`/embeddings`、`/models`、`/messages`)同样挂载(base_url=server 使用)。

### POST `/v1/chat/completions`

OpenAI 兼容请求体 `{model, messages, stream?, ...}`。服务端按模型匹配上游 provider(protocol=`openai`|`anthropic`|`both`,0043/0044)代理转发;非流式/流式(SSE)均支持;响应按 per-user 令牌桶限流(`gateway.rate_limit`,默认 60/min),计量写入 usage 表(含按模型定价折算的 `cost` 费用,元;配置 `usage.peak_windows` 后,高峰窗口外按模型 `offpeak_discount` 打折;缓存命中输入 token 按 `cache_input_price_per_1m`,0029);转发前按**月度 token 配额 / 金额配额 / 部门预算**检查(`EffectiveQuota` / `EffectiveMoneyQuota` / `EffectiveDeptBudget`),任一超限返回 429 `QUOTA_EXCEEDED`(admin 豁免)。

### POST `/v1/messages`(0043,Anthropic 兼容——web_search 服务端代理)

Anthropic Messages 兼容请求体 `{model, max_tokens, messages, stream?, tools?, ...}`,头部携带 `anthropic-version`。**用途:web_search 工具的服务端代理路径**——服务端按模型匹配 protocol=`anthropic` 的 provider,把请求 `Authorization/x-api-key` 替换为服务端持有的上游 key 后转发官方 Anthropic 兼容端点(如 `https://api.deepseek.com/anthropic/v1/messages`)。客户端全程只持有网关登录 token,官方 key 不出服务端。鉴权/限流/配额/计量与 `/v1/chat/completions` 完全一致;usage 以 `kind='search'` 单独记账(流式按 message_start/message_delta 的 input/output tokens 合并回填,缓存命中按 cache_read 计费)。同一模型名可同时由 openai 与 anthropic 两个 provider 承载(provider 表 `protocol` 列区分,webadmin 上游表单可配)。

### GET `/v1/models`

`[{id, display_name, ...}]` 可用模型列表(仅 enabled provider 的模型)。

## 6. 商城(客户端用,Bearer)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/marketplace/skills` | 技能建议清单 `[{name, version, description, author}]`(仅 enabled 且已授权) |
| GET | `/api/client/v2/marketplace/skills/:name` | 单个技能详情 |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | 下载技能包(上传模式:DB 归档;git 模式老行:`cacheDir/<name>-<version>.zip` 只读回退);成功累加 `downloads`(0040) |
| POST | `/api/client/v2/telemetry/skill-call` | 客户端上报技能调用 `{name, version?}` → 服务端累加 `calls`(shared_skills 优先,回退 market) |

## 7. 商城管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/server/admin/skills` | 列表/上架技能(`{name, description, author}`;内容经 `POST /skills/:name/archive` 上传,元数据以包内 SKILL.md 为准) |
| PUT/DELETE | `/api/server/admin/skills/:name` | 更新/下架(置 enabled=0,不删行) |
| POST | `/api/server/admin/skills/:name/archive` | 上传新版压缩包(0040):body `{version, archive(base64 zip)}` → 切换上传模式,归档存 DB;校验顶层 `SKILL.md`,≤16MB |

## 8. 共享 Agent(客户端用,Bearer,多版本)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/agent-presets` | 可见清单:approved 且**已授权** + 自己上传的全部状态;返回 `{presets:[{name, display_name, description, version, author, status, reason, created_at}]}`(reason 仅自己 rejected 行非空) |
| POST | `/api/client/v2/agent-presets` | 上传:body `{name, display_name?, description?, version?(默认 1.0.0), archive(base64 zip)}` → 201 `{preset:{name, version, status:"pending"}}`;归档 ≤16MB、须含顶层 `agent.cordis.yml`、拒绝越界/链接;归档**直存 DB**(0041 不落盘);display_name/描述 ≤500 字;同名同版本 pending/approved → 409;rejected 可重提;每用户待审上限 10 → 429 |
| GET | `/api/client/v2/agent-presets/:name/:version/archive` | 下载归档(仅 approved 且已授权;旧路径 `/:name/archive` 取最高版本);从 DB 出(0041);附 `X-Preset-Checksum` / `X-Preset-Version` |

### 管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/server/admin/agent-presets?status=` | 全部清单(可选 status 过滤) |
| GET | `/api/server/admin/agent-presets/:name/archive` | 管理员下载归档核查(任意版本,兼容旧路径) |
| GET | `/api/server/admin/agent-presets/:name/preview` | 审核预览:`{files:[...], composition}`(顶层 agent.cordis.yml 内容 + 全文件清单;兼容旧路径) |
| POST | `/api/server/admin/agent-presets/:name/approve` | 通过(兼容旧路径,版本取最高) |
| POST | `/api/server/admin/agent-presets/:name/reject` | 拒绝:body `{reason}`(必填,≤500 字);仅上传者可见可重提 |
| DELETE | `/api/server/admin/agent-presets/:name` | 删除记录与归档(全版本;兼容旧路径) |
| GET | `/api/server/admin/agent-presets/:name/:version/archive` | 指定版本归档下载核查 |
| GET | `/api/server/admin/agent-presets/:name/:version/preview` | 指定版本审核预览:`{files:[...], composition}` |
| POST | `/api/server/admin/agent-presets/:name/:version/approve` | 通过该版本(清空 reason) |
| POST | `/api/server/admin/agent-presets/:name/:version/reject` | 拒绝该版本:body `{reason}`(必填,≤500 字) |
| DELETE | `/api/server/admin/agent-presets/:name/:version` | 删除该版本记录与归档 |
| PUT | `/api/server/admin/agent-presets/:name/:version/quality` | 质量标记(0037):body `{quality}` ∈ `""`\|`official`\|`featured`;仅 approved 行,互斥,审计 `agent_preset_qualify` |
| GET | `/api/server/admin/agent-presets/:name/:version/file?path=` | 归档单文件内容:`{path, size, binary, too_large, content}`(文本内联,二进制/超大标记) |
| GET | `/api/server/admin/agent-presets/:name/grants` | 授权清单(按 name,同名多版本共享) |
| PUT | `/api/server/admin/agent-presets/:name/grants` | 整组替换部门授权(body `{groups:[...]}`;用户授权保留) |
| PUT/DELETE | `/api/server/admin/agent-presets/:name/grant` | 增/删单条授权(body `{username}` 或 `{group}`) |

## 8b. 共享技能(客户端用,Bearer,多版本)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/shared-skills` | 可见清单:approved 且**已授权** + 自己上传的全部状态;返回 `{skills:[{name, display_name, version, description, author, status, reason, downloads, calls, created_at}]}` |
| POST | `/api/client/v2/shared-skills` | 上传:body `{name, display_name?, version, description?, archive(base64 zip)}` → 201 `{skill:{name, version, status:"pending"}}`;归档 ≤16MB、须含顶层 `SKILL.md`、拒绝越界/链接;归档直存 DB(0040);UNIQUE(name, version) 多版本并存;同名同版本 pending/approved → 409;rejected 可重提;每用户待审上限 10 → 429 |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | 下载归档(仅 approved 且已授权);附 `X-Skill-Checksum` / `X-Skill-Version` |

### 管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/server/admin/shared-skills?status=` | 全部清单(含版本) |
| GET | `/api/server/admin/shared-skills/:name/:version/archive` | 管理员下载归档核查 |
| GET | `/api/server/admin/shared-skills/:name/:version/preview` | 审核预览:`{files:[...], skill_md}`(顶层 SKILL.md 内容 + 全文件清单) |
| POST | `/api/server/admin/shared-skills/:name/:version/approve` | 通过该版本(全员可见可安装);市场同名将 409(CONFLICT) |
| POST | `/api/server/admin/shared-skills/:name/:version/reject` | 拒绝:body `{reason}`(必填);仅上传者可见可重提 |
| DELETE | `/api/server/admin/shared-skills/:name/:version` | 删除该版本记录与归档 |
| PUT | `/api/server/admin/shared-skills/:name/:version/quality` | 质量标记(0037):body `{quality}` ∈ `""`\|`official`\|`featured`;仅 approved 行,互斥,审计 `shared_skill_qualify` |
| GET | `/api/server/admin/shared-skills/:name/:version/file?path=` | 归档单文件内容:`{path, size, binary, too_large, content}`(文本内联,二进制/超大标记) |
| GET | `/api/server/admin/shared-skills/:name/grants` | 授权清单(按 name,同名多版本共享) |
| PUT | `/api/server/admin/shared-skills/:name/grants` | 整组替换部门授权(body `{groups:[...]}`) |
| PUT/DELETE | `/api/server/admin/shared-skills/:name/grant` | 增/删单条授权(body `{username}` 或 `{group}`) |

## 8c. 能力中心(统一目录与审批队列)

> 读侧 facade(决策 2026-08-25):员工侧把「市场技能(授权制) + 组织共享技能/Agent(审核+授权)」聚合为一个目录视图;管理侧为共享技能与共享 Agent 提供**统一审批队列**(只读,动作仍走 §8/§8b 原域端点)。

### 员工聚合(Bearer)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/capabilities?source=&type=&q=` | 统一目录 `{items:[CapabilityItem]}`;`source=market`(默认)返回市场+组织合并(同名 market 优先折叠,org 版本入 versions),`source=org` 仅组织,`source=local` 仅本地(host 代理合并);`type=skill\|agent\|all`;`installed`/`hasUpdate` 由 host 代理按本地磁盘补齐 |

`CapabilityItem`:`{kind: skill\|agent, source: market\|org, name, display_name, version, description, author, status, reason?, quality?, versions[]}`。可见性语义各自保留:market=enabled+授权;org=作者 own(任意状态,仅「我的」展示)OR approved+授权;admin 恒全量。

### 管理端统一审批队列(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/server/admin/capabilities/approvals?status=&type=` | 归并 shared-skills 与 agent-presets 的队列 `{approvals:[ApprovalRow]}`;`status` 缺省=`pending`,`all`=全量,或 `pending\|approved\|rejected`;`type=skill\|agent`(缺省全部);行含 `kind/name/version/display_name/description/author/status/reason/quality/downloads/calls(技能)/created_at/conflict` 与 `base_path`/`preview_path`(原域端点,均为 `/api/server/admin/*` 前缀);`conflict=true` = 该共享技能与市场 skills 同名(approve 将被 409 阻断) |

## 9. Bootstrap

### GET `/api/client/v2/config/bootstrap`(Bearer)

登录后统一下发启动配置,字段固定:

```json
{
  "default_model": "deepseek-chat",
  "models": [{ "id": "deepseek-chat", "display_name": "DeepSeek Chat" }],
  "skills": [{ "name": "invoice-helper", "version": "1.0.0", "description": "..." }],
  "web": { "default_thinking_level": "max" },
  "connectors": [{ "id": "example-org", "name": "示例企业 HR 智能体", "auth_mode": "oauth", "definition": { ... } }]
}
```

客户端 `BootstrapConfig` 与之严格对齐;`default_model` 不在启用模型时自动回退到第一个可用模型。`connectors`(0042 起)为服务端连接器目录,客户端按目录渲染连接器中心(glitchtip 0045 已下架,不下发)。

## 10. 其他

| 路径 | 说明 |
|------|------|
| `/`、`/portal` | 门户首页(品牌 + 三平台客户端下载,`portal.public` 控制开放性;产品 HTML 面) |
| `/admin/` | webadmin SPA(未构建返回 "webadmin 未构建") |
| `/healthz` | 健康探针(JSON,DB Ping,503=DB 不可用) |
| `/api/client/v2/brand`、`/api/client/v2/brand/logo/:name`、`/api/client/v2/portal` | 品牌/门户公开端点(未认证) |
| 其他 | 404 JSON 信封 "not found" |

## 11. 品牌与门户(公开)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/brand` | 公开品牌配置 `{enabled, login:{logo_url, display_name, tagline, welcome}, client:{logo_url, display_name, tagline}, favicon_url, title}`(无 accent 主题色) |
| GET/HEAD | `/api/client/v2/brand/logo/:name` | logo 文件(name ∈ login/client/favicon,白名单 + SVG sanitize + ETag) |
| GET | `/api/client/v2/portal` | 公开门户首页配置 `{enabled, public, welcome, subtitle, client_download_linux/mac/win, client_download_note, landing_path}` |

管理端点:`GET/PUT /api/server/admin/brand`、`POST/DELETE /api/server/admin/brand/logo`、`GET /api/server/admin/brand/snapshots`、`POST /api/server/admin/brand/restore`(0047 快照)、`GET/PUT /api/server/admin/portal`。

## 12. 连接器(admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/server/admin/connectors`、`/connectors/:id` | 连接器目录 CRUD;`PUT /connectors/:id/enabled` 下架/上架 |

员工面不直接调连接器端点:目录经 bootstrap `connectors[]` 下发;OAuth/设备/令牌授权由客户端本地代理(`/api/pico/connectors/...`,loopback guard)与服务端 `serverauth` 会话协同。
