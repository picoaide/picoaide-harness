# API 参考(服务端 HTTP)

> 所有端点以代码为准(`internal/**/routes.go`、`cmd/server/main.go`)。错误统一信封 `{"error":{"code":"ERR_CODE","message":"..."}}`。
>
> **2026-08-19**:自研 Electron 客户端已下线,服务端接口全部保留,供第三方/自研客户端接入。

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
| POST | `/api/client/v2/auth/login` | 无 | 密码登录(local/LDAP);body `{server_url?, username, password}` → `{token}` |
| POST | `/api/client/v2/auth/logout` | Bearer | 吊销当前 token |
| GET | `/api/client/v2/auth/me` | Bearer | 当前用户 `{id, username, display_name, email, is_admin, source}` |
| GET | `/api/client/v2/auth/usage` | Bearer | 员工用量概览(自查询):`{is_admin, quota_tokens, quota_money, monthly_usage/cost, remaining_tokens/money(不限=null), today_usage/cost, yesterday_usage/cost, total_usage/cost, dept_budgets[]}`;有效配额 = 个人覆盖→全局默认,admin 豁免 |
| GET | `/api/client/v2/auth/oidc/login` | 无 | 跳转 OIDC 授权页(配置后启用) |
| GET | `/api/client/v2/auth/oidc/callback` | 无 | OIDC 回调,换取服务端 token |

## 4. 管理端(webadmin,全部 session 鉴权)

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/server/admin/login` | 管理员登录(仅 `is_admin=1` 用户;非管理员 → 403) |
| GET | `/api/server/admin/me` | 当前管理员信息 |
| POST | `/api/server/admin/logout` | 登出(清 session) |
| GET | `/api/server/admin/users` | 用户列表(附带 `quota_tokens`/`quota_money` 与 `monthly_usage`/`monthly_cost` 本月用量/费用) |
| POST | `/api/server/admin/users` | 创建用户 `{username, password?, display_name?, email?, is_admin?, source?}` |
| PUT | `/api/server/admin/users/:id` | 更新用户(改密/管理员/启用停用);`quota_tokens`/`quota_money` 设置月度配额(0=不限),`quota_clear:true`/`quota_money_clear:true` 恢复跟随全局默认 |
| DELETE | `/api/server/admin/users/:id` | 删除用户 |
| GET | `/api/server/admin/usage` | 用量汇总(按用户/模型/时间;`group=user` 展示用户名) |
| GET | `/api/server/admin/providers` | 网关上游列表(含 `protocol`:openai/anthropic) |
| POST | `/api/server/admin/providers` | 添加上游 `{name, base_url, api_key, models, enabled, protocol?, channel?}`(api_key 服务端加密存储;protocol 缺省 openai,anthropic 供 /v1/messages 代理) |
| PUT | `/api/server/admin/providers/:id` | 更新上游(protocol 可切换) |
| DELETE | `/api/server/admin/providers/:id` | 删除上游 |
| GET | `/api/server/admin/models` | 模型列表 |
| POST | `/api/server/admin/models` | 创建模型 `{name, provider_id, display_name?, default_params?, input_price_per_1m?, output_price_per_1m?, offpeak_discount?}`(价格 = 元/百万 token,缺省 = 未定价;offpeak_discount 0<d≤1 低谷折扣) |
| PUT | `/api/server/admin/models/:id` | 更新模型(价格/折扣留空不覆盖;修改只影响之后产生的费用) |
| DELETE | `/api/server/admin/models/:id` | 删除模型 |
| GET | `/api/server/admin/audit` | 审计日志分页 `?page=&size=&action=&username=`(用户/部门/技能等敏感操作,90 天保留) |
| GET | `/api/server/admin/gateway` | 网关配置:`{rate_limit, monthly_quota, monthly_quota_money, peak_windows, default_model, retention_months, default_thinking_level, server_base_url}` |
| PUT | `/api/server/admin/gateway` | 写网关配置(settings:`gateway.rate_limit`、`gateway.default_model`、`usage.monthly_quota`(员工默认月 token 配额)、`usage.monthly_quota_money`(员工默认月金额配额)、`usage.peak_windows`(高峰时段 JSON,北京时间,空=无峰谷)、`usage.retention_months`、`web.default_thinking_level`、`server.base_url`) |

## 5. AI 网关(客户端用,Bearer)

### POST `/v1/chat/completions`

OpenAI 兼容请求体 `{model, messages, stream?, ...}`。服务端按模型匹配上游 provider(protocol=`openai`)代理转发;非流式/流式(SSE)均支持;响应按 per-user 令牌桶限流(`gateway.rate_limit`,默认 60/min),计量写入 usage 表(含按模型定价折算的 `cost` 费用,元;配置 `usage.peak_windows` 后,高峰窗口外按模型 `offpeak_discount` 打折);转发前按**月度 token 配额 / 金额配额 / 部门预算**检查(`EffectiveQuota` / `EffectiveMoneyQuota` / `EffectiveDeptBudget`),任一超限返回 429 `QUOTA_EXCEEDED`(admin 豁免)。

### POST `/v1/messages`(0043,Anthropic 兼容——web_search 服务端代理)

Anthropic Messages 兼容请求体 `{model, max_tokens, messages, stream?, tools?, ...}`,头部携带 `anthropic-version`。**用途:web_search 工具的服务端代理路径**——服务端按模型匹配 protocol=`anthropic` 的 provider,把请求 `Authorization/x-api-key` 替换为服务端持有的上游 key 后转发官方 Anthropic 兼容端点(如 `https://api.deepseek.com/anthropic/v1/messages`)。客户端全程只持有网关登录 token,官方 key 不出服务端。鉴权/限流/配额/计量与 `/v1/chat/completions` 完全一致;usage 以 `kind='search'` 单独记账(流式按 message_start/message_delta 的 input/output tokens 合并回填,缓存命中按 cache_read 计费)。同一模型名可同时由 openai 与 anthropic 两个 provider 承载(provider 表 `protocol` 列区分,webadmin 上游表单可配)。

### GET `/v1/models`

`[{id, display_name, ...}]` 可用模型列表(仅 enabled provider 的模型)。

## 6. 商城(客户端用,Bearer)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/marketplace/skills` | 技能建议清单 `[{name, version, description, author}]` |
| GET | `/api/client/v2/marketplace/skills/updates?installed=name:ver,...` | 技能版本检测(客户端自动升级):上报已装 `name:version`(逗号分隔,≤100 项),返回服务端较新的技能 `{updates:[{name, version, description, author, archive_url}], count}`;授权/下架技能不返回 |
| GET | `/api/client/v2/marketplace/skills/:name` | 单个技能详情 |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | 下载技能包(上传模式:DB 归档;git 模式:`cacheDir/<name>-<version>.tar.gz`);成功累加 `downloads` |
| POST | `/api/client/v2/telemetry/skill-call` | 客户端上报技能调用 `{name, version?}` → 服务端累加 `calls`(shared_skills 优先,回退 market) |

## 7. 商城管理端(Admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/server/admin/skills` | 列表/上架技能(`{name, version, description, author, git_url, git_ref}`) |
| PUT/DELETE | `/api/server/admin/skills/:name` | 更新/下架(置 enabled=0,不删行) |
| POST | `/api/server/admin/skills/:name/archive` | 上传新版压缩包(0040):body `{version, archive(base64 tar.gz)}` → 切换上传模式,归档存 DB;校验顶层 `SKILL.md`,≤16MB |

## 8. 共享 Agent(客户端用,Bearer)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/agent-presets` | 可见清单:approved(全员)+ 自己上传的全部状态;返回 `{presets:[{name, display_name, description, version, author, status, reason, created_at}]}`(reason 仅自己 rejected 行非空) |
| POST | `/api/client/v2/agent-presets` | 上传:body `{name, display_name?, description?, version?(默认 1.0.0), archive(base64 tar.gz)}` → 201 `{preset:{name, version, status:"pending"}}`;归档 ≤16MB、须含顶层 `agent.cordis.yml`、拒绝越界/链接;归档**直存 DB**(0041 不落盘);display_name/描述 ≤500 字;同名同版本 pending/approved → 409;rejected 可重提;每用户待审上限 10 → 429 |
| GET | `/api/client/v2/agent-presets/:name/archive` | 下载归档(仅 approved;其余与不存在同 404);从 DB 出(0041);附 `X-Preset-Checksum` / `X-Preset-Version` |

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
| GET | `/api/client/v2/shared-skills` | 可见清单:approved(全员)+ 自己上传的全部状态;返回 `{skills:[{name, display_name, version, description, author, status, reason, downloads, calls, created_at}]}` |
| POST | `/api/client/v2/shared-skills` | 上传:body `{name, display_name?, version, description?, archive(base64 tar.gz)}` → 201 `{skill:{name, version, status:"pending"}}`;归档 ≤16MB、须含顶层 `SKILL.md`、拒绝越界/链接;归档直存 DB(0040);UNIQUE(name, version) 多版本并存;同名同版本 pending/approved → 409;rejected 可重提;每用户待审上限 10 → 429 |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | 下载归档(仅 approved);附 `X-Skill-Checksum` / `X-Skill-Version` |

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
  "web": { "default_thinking_level": "max" }
}
```

客户端 `BootstrapConfig` 与之严格对齐;`default_model` 不在启用模型时自动回退到第一个可用模型。

## 10. 其他

| 路径 | 说明 |
|------|------|
| `/admin/` | webadmin SPA(未构建返回 "webadmin 未构建") |
| 其他 | 404 "not found" |

## 11. 客户端 IPC(renderer ↔ main)

| 通道 | 方向 | 说明 |
|------|------|------|
| `auth:login` / `auth:loadSession` / `auth:logout` / `auth:refreshBootstrap` / `auth:oidcLogin` | invoke | 会话管理 |
| `chat:new` / `chat:ask` / `chat:continue` / `chat:approvePlan` / `chat:cancel` / `chat:list` / `chat:listRunning` / `chat:messages` / `chat:artifacts` / `chat:delete` | invoke | 对话生命周期 |
| `agent:confirm` | invoke | 审批回执 `{requestId, ok}` |
| `agent:event` | 事件 | 引擎事件流(见 01-architecture.md §4) |
| `artifact:showInFolder` | invoke | 在系统文件管理器中显示产物 |
| `picoaide:version` / `picoaide:rendererReady` | invoke | 版本/就绪握手 |
| `workspace:setAllowedDirs` 等 | invoke | 设置页:可访问目录(安全边界)+ 建议安装管理 + 刷新 |

## 12. 浏览器插件桥(CDP,JSON-RPC over WebSocket)

固定 `ws://127.0.0.1:54321`,方法:`browser.tabInfo` / `getContent` / `click` / `type` / `navigate` / `scroll` / `executeScript`。无 method 的消息 = 插件回执,原样透传给请求方;未知方法返回 `-32601`。
