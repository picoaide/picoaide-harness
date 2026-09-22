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
| `BALANCE_EXHAUSTED` | 429 | 员工账户余额已用尽(2026-09-11 起唯一的额度闸门;admin 豁免,未开通余额账户的员工不受约束) |
| `INTERNAL` | 500 | 内部错误 |

## 2. 鉴权方式

| 方式 | 说明 |
|------|------|
| **Bearer token** | `Authorization: Bearer <api_token>`;`POST /api/client/v2/auth/login` 签发,90 天过期,哈希存储 |
| **管理端 session** | Cookie `picoaide_session`(HttpOnly, SameSite=Lax;12h 硬上限 + 60min 空闲滑动到期);写操作需 header `X-CSRF-Token`(登录响应返回) |

## 3. 认证

| 方法 | 路径 | 鉴权 | 说明 |
|------|------|------|------|
| POST | `/api/client/v2/auth/login` | 无 | 密码登录(local/LDAP);body `{username, password}` → `{token, user, must_change_password}`(0057:must_change_password=true 时客户端进入强制改密页,改密前业务 API 均 403 `PASSWORD_CHANGE_REQUIRED`) |
| POST | `/api/client/v2/auth/password` | Bearer | 员工自助改密(0057):body `{old_password, new_password}` → `{ok}`;仅本地认证(`source=local`)用户;成功后吊销该用户全部 api_tokens 与 admin_sessions(含当前),客户端须重新登录 |
| POST | `/api/client/v2/auth/logout` | Bearer | 吊销当前 token |
| GET | `/api/client/v2/auth/me` | Bearer | 当前用户 `{user:{id, username, display_name, email, is_admin, role, permissions, status, balance_money, balance_activated, source, password_changeable, password_must_change, password_changed_at, mfa_enabled}}`(0057 起 source/password_changeable 供客户端判断改密入口;mfa_enabled 供管理端列表。**2026-09-11 起不再下发 `quota_tokens`/`quota_money`** —— token/金额配额已下线,余额是唯一闸门) |
| GET | `/api/client/v2/auth/usage` | Bearer | 员工用量概览(自查询):`{balance_money, balance_activated, balance_enabled, balance_monthly, balance_mode, is_admin, monthly_usage, monthly_cost, today_usage, today_cost, yesterday_usage, yesterday_cost, total_usage, total_cost}`。`balance_activated=false`(从未入账)时客户端**不展示**余额行(与网关"未开通不拦"同判据);字段集合是**跨语言契约**,由 `internal/serverauth/usage_contract_test.go` 与 `packages/client/account-card/src/usage-contract.ts` 对拍 |
| GET | `/api/client/v2/auth/methods` | 无 | 登录方式发现(`public methods`,登录页未登录时探测) |
| GET | `/api/client/v2/auth/oidc/login`、`/api/client/v2/auth/openid/login` | 无 | 跳转 OIDC/OpenID 授权页。两条路由是**固定注册**的(provider 在请求时按配置解析),不是 `:provider` 通配 —— 只有已注册的这两条存在 |
| GET | `/api/client/v2/auth/oidc/callback`、`/api/client/v2/auth/openid/callback` | 无 | OIDC 回调,换取服务端 token(失败回调同样计入限流桶) |

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
| GET | `/api/server/admin/users` | 用户列表(附带 `role`、余额字段与 `monthly_usage`/`monthly_cost` 本月用量/费用。**2026-09-11 起不再含 `quota_tokens`/`quota_money`** —— 员工配额已下线) |
| POST | `/api/server/admin/users` | 创建用户 `{username, password?, display_name?, email?, role?\|is_admin?, source?}`(role ∈ super_admin/auditor/user;is_admin 为兼容别名) |
| PUT | `/api/server/admin/users/:id` | 更新用户(改密/角色/启用停用;改密/降权/禁用自动吊销 token)。⚠️ **`quota_tokens`/`quota_money`/`quota_clear`/`quota_money_clear` 已被 handler 显式忽略:请求照常 200,但零写入**(2026-09-11 配额下线;列与这些字段保留只是为了不砸旧客户端)。要控额度请用余额:`POST /users/:id/balance` 与 `PUT /balance` |
| DELETE | `/api/server/admin/users/:id` | 删除用户 |
| PUT | `/api/server/admin/users/:id/department` | 设置用户部门归属(2026-09 多部门):body `{group_ids:[n1,n2,...]}`(空=清空);兼容旧 `{group_id:n}`。授权 = 全部所属部门+祖先链同时生效 |
| GET | `/api/server/admin/users/:id/groups` | 用户组/部门列表 |
| GET/PUT | `/api/server/admin/departments`、`/departments/:id` | 部门树 CRUD(parent/leader;`budget_money` 已随部门预算下线,请求体里该字段被忽略) |
| GET | `/api/server/admin/users/:id/tokens` | 用户 token 列表 |
| POST | `/api/server/admin/tokens/:id/revoke` | 吊销指定 token |
| GET | `/api/server/admin/usage` | 用量汇总(按用户/模型/时间;`group=user` 展示用户名) |
| GET | `/api/server/admin/server-info` | 版本/数据库驱动(PG)/迁移版本/运行环境摘要 + `update_check`(实时更新服务器版本检查:current/latest/update_available/image_tag/manifest_url,失败为 null) |
| GET | `/api/server/admin/concurrency` | 按模型并发状态(2026-08-31):当前 in-flight + 90 天峰值(`model_concurrency_stats`)+ 目标(`default_params.concurrency_target`),扩容申请依据 |
| GET | `/api/server/admin/providers` | 网关上游列表(含 `protocol`:openai/anthropic/both) |
| POST | `/api/server/admin/providers` | 添加上游 `{name, base_url, api_key, models, enabled, protocol?, channel?}`(api_key 服务端加密存储;protocol 缺省 openai) |
| PUT | `/api/server/admin/providers/:id` | 更新上游(protocol 可切换) |
| DELETE | `/api/server/admin/providers/:id` | 删除上游 |
| POST | `/api/server/admin/providers/:id/sync` `providers/sync-all` | 模型同步 |
| GET | `/api/server/admin/models` | 模型列表 |
| POST | `/api/server/admin/models` | 创建模型 `{name, provider_id, display_name?, default_params?, input_modalities?(['text'/'image' 数组,0058,缺省仅 text]), input_price_per_1m?, output_price_per_1m?, cache_input_price_per_1m?, offpeak_discount?}`(价格 = 元/百万 token,缺省 = 未定价;0029 缓存命中输入价) |
| PUT | `/api/server/admin/models/:id` | 更新模型(价格/折扣留空不覆盖;修改只影响之后产生的费用)。`input_modalities`(0058)显式数组 = 设置、缺省 = 不覆盖;name 改名受保护(有用量记录/渠道同步模型拒绝);`offpeak_discount` 0<d≤1 |
| DELETE | `/api/server/admin/models/:id` | 删除模型 |
| GET | `/api/server/admin/gateway` | 网关配置:`{rate_limit, peak_windows, retention_months, default_model, default_thinking_level, server_base_url, error_reporting_dsn/enabled/level/heartbeat, glitchtip_base_url, glitchtip_organization}`(**2026-09-11 起不含 `monthly_quota`/`monthly_quota_money`** —— 员工配额已下线) |
| PUT | `/api/server/admin/gateway` | 写网关配置(settings:`gateway.rate_limit`、`gateway.default_model`、`usage.peak_windows`、`usage.retention_months`、`web.default_thinking_level`、`server.base_url`、`web.error_reporting_*`、`web.glitchtip_*`)。⚠️ 请求体里的 `monthly_quota`/`monthly_quota_money`(旧文档曾写作 `usage.monthly_quota*`)**已不在请求结构里 ⇒ 被 JSON 绑定直接忽略:返回 200 但零写入** —— 保留这些键的说法只是为了不砸旧客户端;控额度请用余额端点(`PUT /balance`、`POST /users/:id/balance`) |
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
| POST | `/v1/files` | DeepSeek Files API 上传(multipart,2026-09-22) |
| GET | `/v1/files` | 文件列表(query 透传) |
| GET/DELETE | `/v1/files/{file_id}` | 检索/删除文件 |

> 无 `/v1` 前缀的官方原生变体(`/chat/completions`、`/completions`、`/responses`、`/embeddings`、`/models`、`/messages`、`/files`、`/files/{file_id}`)同样挂载(base_url=server 使用)。

### POST `/v1/chat/completions`

OpenAI 兼容请求体 `{model, messages, stream?, ...}`。服务端按模型匹配上游 provider(protocol=`openai`|`anthropic`|`both`,0043/0044)代理转发;非流式/流式(SSE)均支持;响应按 per-user 令牌桶限流(`gateway.rate_limit`,**默认 0 = 不限制**——与官方口径一致:官方只限账号级并发、不设请求速率上限;需要限速时用该设置显式开启,2026-09-22 前缺省为 60/min),计量写入 usage 表(含按模型定价折算的 `cost` 费用,元;配置 `usage.peak_windows` 后,高峰窗口外按模型 `offpeak_discount` 打折;缓存命中输入 token 按 `cache_input_price_per_1m`,0029);转发前按**账户余额闸门**检查:已开通余额账户(`balance_activated_at` 非空)且余额分位口径 ≤0 时返回 429 `BALANCE_EXHAUSTED`(admin 豁免;未开通者不受约束)。2026-09-11 起月度 token 配额、金额配额与部门预算已下线。

请求体上限:chat/FIM/messages/responses 各 64MiB(2026-09-22 由 16MiB 提高),embeddings 4MiB。**读请求体的时间预算是 1 小时**(按路由放宽,与全局 `http.Server.ReadTimeout` 的 60s slowloris 防护解耦):超时返回 `503` + `code=SERVER`(可重试),而不是旧版的 `400 请求体格式错误`(客户端会归类为不可重试的 `INVALID_REQUEST`)。

**出站体加工(2026-09-22)**:四个聊天入口在转发前解析请求体做两件事——
1. **按员工注入官方用户标识**:`chat/completions` 写顶层 `user_id`、`/responses` 写官方 create-response 的顶层 `user`、Anthropic `messages` 写 `metadata.user_id`,值为平台侧稳定标识 `u<users.id>`(非用户名/邮箱等隐私信息),并**覆盖**客户端自带值(否则第三方客户端可伪造他人身份做上游 KVCache 投毒/隔离逃逸)。官方用它做 KVCache / 调度 / 内容安全三重隔离——不注入则全公司落进同一个"空 user_id"域。`/completions`(FIM,官方文档只有 prompt/echo 等字段)与 `/v1/embeddings`(客户端体不转发)**不注入**。
2. **校验 `file_id` 引用归属**:请求体里任何 `file_id`(聊天内容部件 `{"type":"file","file_id":…}`、Anthropic `source.file_id` 等)都必须是**调用者自己**上传的文件(台账 `gateway_files`,迁移 0077);未登记/他人的 id、或形状非法的 id 一律 `404 NOT_FOUND`(与"不存在"同形),**整条请求不发往上游**。原因:Files API 的文件落在同一个上游账号(全组织共用一个 provider key),不校验就等于"知道 id 就能读别人的图"。字符串正文里出现的 `file_id` 文本不算引用(不误伤工具参数等);工具/schema 子树(`tools`/`functions`/`function`/`tool_choice`/`response_format`)不参与收集;单次请求引用数上限缺省 600 个(与官方"单请求最多 600 张图"对齐,可配;超出 `400 VALIDATION`)。

**文件保留上限与回收(2026-09-22)**:`gateway.file_expiry_days`(缺省 **7 天**,范围 1~30)是网关**强制执行**的保留上限 ——
上传时若客户端没带 `expires_after`、或要得比上限更久,台账一律按上限记录(更早的保留期尊重客户端),到点即拒绝授权,
并由 5 分钟一轮的回收器在上游删除(上游配额是**每 API key**、全组织共享 25 GiB / 10000 文件)。
管理后台「网关文件」页按员工展示占用(文件数/字节/其中已过期),支持按员工过滤、`file_id` 搜索、排序与按条件清理;
接口:`GET /api/server/admin/gateway/files|/files/summary`(gateway:read)、`DELETE /api/server/admin/gateway/files/:file_id`
与 `POST /api/server/admin/gateway/files/purge`(gateway:write;批量清理**必须**带 `user` 或 `state`,单次最多 500 条)。

**两个可配闸门(2026-09-22,管理后台「网关 → 网关防护」)**:
`gateway.max_file_refs`(单请求 `file_id` 引用数上限,缺省 **600** = 官方 vision 文档的"单请求最多 600 张图",范围 1~4096 —— 本平台的归属校验只会比上游更松,绝不会更严)与
`gateway.body_parse_budget_mb`(全进程**同时在加工**的请求体字节预算,缺省 128MiB,范围 64~8192)。
后者是内存闸门:整 body 的 map 往返实测总分配 ≈28× 请求体、峰值活跃堆约 6~8×,预算打满时新的慢路径请求直接
`503` + `code=SERVER`(可重试),**不排队、不无上限叠加**。两个值都走进程内 10s TTL 缓存,管理端保存后立即失效。

**失败语义(fail-closed)**:请求体不是合法 JSON 对象(含 `1e999` 这类解析分歧体)、`metadata` 存在但不是对象 ⇒ **本地 400,绝不原样转发**。原因:任何一个"解析失败就放行"的闸门都会成为绕过全部校验的入口(2026-09-22 审计实测:同一构造体让 file_id 归属、user_id 覆盖、`dsh_` 私有字段剔除三处同时失效)。转发体因此不再保证与客户端字节逐字相同;**计量仍按客户端原始字节估算** prompt(用 `usage.estimated` 标注),前缀缓存不受影响(同一输入每轮产出相同字节)。

### POST `/v1/messages`(0043,Anthropic 兼容——web_search 服务端代理)

Anthropic Messages 兼容请求体 `{model, max_tokens, messages, stream?, tools?, ...}`,头部携带 `anthropic-version`。**用途:web_search 工具的服务端代理路径**——服务端按模型匹配 protocol=`anthropic` 的 provider,把请求 `Authorization/x-api-key` 替换为服务端持有的上游 key 后转发官方 Anthropic 兼容端点(如 `https://api.deepseek.com/anthropic/v1/messages`)。客户端全程只持有网关登录 token,官方 key 不出服务端。鉴权/限流/配额/计量与 `/v1/chat/completions` 完全一致;usage 以 `kind='search'` 单独记账(流式按 message_start/message_delta 的 input/output tokens 合并回填,缓存命中按 cache_read 计费)。同一模型名可同时由 openai 与 anthropic 两个 provider 承载(provider 表 `protocol` 列区分,webadmin 上游表单可配)。

### GET `/v1/models`

`[{id, display_name, ...}]` 可用模型列表(仅 enabled provider 的模型)。

### Files API(`/v1/files*`,2026-09-22)

DeepSeek Files API 直通。**用途**:桌面客户端默认把会话里的图片先上传一次、后续请求只引用 `file_id`(拿不到 `file_id` 才回落成把图片 base64 内联进每一个请求,请求体因此长期偏大)。语义:

- **只转发给 DeepSeek**:请求里没有 model 字段,无法按模型选上游 —— 只认 deepseek 系 provider(`base_url` 或 `name` 含 `deepseek`,与 `GET /providers/:id/balance` 同一判据),一个都没有时返回 503 `UPSTREAM`。注意这是**路由判据、不是安全边界**:能改 provider 配置的人(`gateway:write`,仅 super_admin)本就能把 base_url 指向任意地址;
- **归属隔离**:上传成功后在网关侧台账 `gateway_files`(迁移 0077)记 `(file_id, user_id, expires_at)`;`GET|DELETE /files/{id}` 非本人 ⇒ 404(与"不存在"同形,不泄露存在性)且不触达上游;`GET /files` 只回自己的 id;聊天请求里引用的 `file_id` 同样按归属校验(详见 §5 的「出站体加工」)。上游删除/过期由"删除成功或上游 404 ⇒ 删行"与 `expires_at` 过期清理两条路径收敛;
- 上传体上限 **64MiB**(官方 Files API 口径:单文件 ≤64 MiB 且须在 10 分钟内传完)，**流式**转发(不整段读进内存);元数据响应上限 4MiB;
- **仅限流**:不计 token、不落 usage、不写审计(官方也不按 token 计费文件);仍受 `gateway.rate_limit` 与单用户并发闸门约束;
- 上游非 2xx 时保留状态码并收敛成统一错误信封(`{"error":{code,message,...}}`),客户端据此回落到 base64 内联,不会因文件接口异常而发不出图。

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
| PUT | `/api/server/admin/agent-presets/:name/enabled` | 组织共享智能体上下架(2026-09-17,SG-4):body `{enabled: true\|false}` → `{ok, enabled}`;语义与共享技能的 `/:name/enabled` 对称(apps.enabled),但**只作用于 org 渠道行**(市场智能体由 marketplace 的 `POST /agents/:name/enable` 管,跨渠道写 404);下架后员工目录不可见、归档下载 404,管理端仍可审核/预览/下载核查;审计 `agent_preset_enable` / `agent_preset_disable` |

## 8b. 共享技能(客户端用,Bearer,多版本)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/shared-skills` | 可见清单:approved 且**已授权** 且**已上架**(apps.enabled=1) + 自己上传的全部状态(同样受上下架约束);返回 `{skills:[{name, display_name, version, description, author, status, reason, downloads, calls, created_at}]}` |
| POST | `/api/client/v2/shared-skills` | 上传:body `{name, display_name?, version, description?, archive(base64 zip)}` → 201 `{skill:{name, version, status:"pending"}}`;归档 ≤16MB、须含顶层 `SKILL.md`、拒绝越界/链接;归档直存 DB(0040);UNIQUE(name, version) 多版本并存;同名同版本 pending/approved → 409;rejected 可重提;每用户待审上限 10 → 429 |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | 下载归档(三重闸门:approved + 已上架 + 已授权/作者本人,任一不过同 404);附 `X-Skill-Checksum` / `X-Skill-Version` |

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
| PUT | `/api/server/admin/shared-skills/:name/enabled` | 组织共享技能上下架(2026-09-15):body `{enabled: true\|false}` → `{ok, enabled}`;语义同市场技能(apps.enabled),但**只作用于 org 渠道行**(市场行由 marketplace 端点管,跨渠道写 404);下架后员工目录不可见、归档下载 404,管理端仍可审核/预览/下载核查;审计 `shared_skill_enable` / `shared_skill_disable` |

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
| GET | `/api/server/admin/capabilities/approvals?status=&type=` | 归并 shared-skills 与 agent-presets 的队列 `{approvals:[ApprovalRow]}`;`status` 缺省=`pending`,`all`=全量,或 `pending\|approved\|rejected`;`type=skill\|agent`(缺省全部);行含 `kind/name/version/display_name/description/author/status/reason/quality/downloads/calls(技能)/created_at/conflict/enabled`(上下架状态,两种 kind 都下发,2026-09-17 起) 与 `base_path`/`preview_path`/`grants_base`(原域端点,均为 `/api/server/admin/*` 前缀);`conflict=true` = 该共享技能与市场 skills 同名(approve 将被 409 阻断) |

## 8d. 内置技能(客户端用,Bearer,随服务端镜像发布)

> 「技能内置到服务端、客户端按需安装」：技能内容放在**镜像层**的
> `/opt/picoaide/skills/<name>/`(Dockerfile 逐技能 COPY **服务端仓库内的 `server/skills/<name>/`**，
> 可用 `PICOAI_SKILL_SEED_DIR` 覆盖；2026-09-19 起源码就在这里，不再从客户端 vendored 包取)，
> 服务端直接把它打包下发 —— 内容随镜像升级而更新，客户端**不自动安装**，
> 员工在能力中心的「平台内置技能」区点一次安装(复用市场那条安装链路:
> 下载 → sha256 对照 → 整树解包 → `<dshHome>/skills`)。实现见 `internal/wasmapp/skillseed`。
> 当前内置一个技能:`app-builder`(WASM 应用平台作者手册；2026-09-19 由 `picoaide-app-builder` 改名)。
> 与 §6/§8b 的差别只有一处:**没有授权门**(平台自带、对全部登录员工可见)，
> 认证口径与它们完全一致(BearerAuth)。

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/skills/builtin` | 清单 `{skills:[{name, version, title, description, author, category, sha256, size, files, source:"builtin"}]}`;`sha256`/`size` 描述的是**打包后的 tar.gz**;资产目录不存在或全部不合格时返回空数组(不报错) |
| GET | `/api/client/v2/skills/builtin/:name/archive` | tar.gz 包;附 `X-Skill-Checksum`(sha256,与清单同值)与 `X-Skill-Version`;未知名 404 JSON 信封 |

包格式:根部 `SKILL.md`(frontmatter 必须含 `name`/`version`(严格 semver)/`title`/`description`/`author`/`category`)，
与管理员上传技能包走**同一套**校验(`archiveutil` + `skillmanifest`)，不合规的内置技能在服务端
启动扫描时被丢弃并记日志,不会以"能装上一个坏技能"的形式下发。**注意目录名必须等于 frontmatter 的
`name`**(`skillseed` 用目录名当 declaredAppID 调 `Parse`)—— 不一致会让整条技能被静默跳过
(客户端接口 200 + 空数组),这正是下面这条管理端诊断面要回答的问题。

### 管理端只读诊断面(Admin,会话 + CSRF,`capability:read`)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/server/admin/skills/builtin` | `{dir, dir_exists, skills:[…与客户端清单同形状…], problems:[{name, reason}], counts:{skills, problems}, load_error?}`;**只读**:内置技能是镜像资产,没有上架/授权/审批/owner 语义(故无对应写端点);扫描失败与"有技能被跳过"一律 200 + 原因(客户端面仍 401/5xx 口径不变)。`problems` 覆盖两类:**坏技能目录**(frontmatter 缺字段/目录名≠name/…)与**资产根目录里的散文件**(放错层的 SKILL.md、notes.txt 等 —— 它们不会被打包下发,但必须可见;2026-09-19 R2-SK-2) |

> ⚠️ 路径与市场技能的 `GET /skills/:name` 同级(gin 静态段优先):名字恰为 `builtin`
> 的市场技能在这一条 GET 上不可达,其余 `/skills/:name/*` 端点不受影响。

### 客户端侧(本地回环代理,不是服务端端点)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/pico/skills/builtin` | 透传服务端清单并附本机 `installed` 目录名列表 |
| POST | `/api/pico/skills/builtin/:name/install` | 下载 + 校验 + 装到 `<dshHome>/skills/<name>`;**宿主只按 pathname 分发、不读 query**(`?force=1` 已于 2026-09-19 移除:重装/更新靠安装器的整树替换语义,同名覆盖确认是纯客户端交互);**缺 `x-skill-checksum`/`x-skill-version` 一律拒绝**(502) |

## 9. Bootstrap

### GET `/api/client/v2/config/bootstrap`(Bearer)

登录后统一下发启动配置,字段固定:

```json
{
  "default_model": "deepseek-chat",
  "models": [{ "id": "deepseek-chat", "display_name": "DeepSeek Chat", "input_modalities": ["text"] }],
  "skills": [{ "name": "invoice-helper", "version": "1.0.0", "description": "..." }],
  "web": { "default_thinking_level": "max" },
  "connectors": [{ "id": "example-org", "name": "示例企业 HR 智能体", "auth_mode": "oauth", "definition": { ... } }]
}
```

`models[].input_modalities`(0058)为模型接受的输入模态数组(`text`/`image`),客户端据此允许/拒绝图片上传;缺省/非法值客户端回落仅 `text`。`/v1/models` 同字段。

客户端 `BootstrapConfig` 与之严格对齐;`default_model` 不在启用模型时自动回退到第一个可用模型。`connectors`(0042 起)为服务端连接器目录,客户端按目录渲染连接器中心(glitchtip 0045 已下架,不下发)。

## 10. 其他

| 路径 | 说明 |
|------|------|
| `/`、`/portal` | 门户首页(首屏 = 三平台客户端下载,其后是客户端功能说明;**管理后台入口只在页脚**一行低调文字链接,`portal.public` 控制开放性;产品 HTML 面) |
| `/admin/` | webadmin SPA(未构建返回 "webadmin 未构建") |
| `/healthz` | 健康探针(JSON,DB Ping,503=DB 不可用) |
| `/api/client/v2/channel`、`/api/client/v2/channel/{logo,logo-dark,favicon}` | 渠道内容公开端点(未认证,登录页登录前就要用)。`/channel` 是 JSON;三个素材端点是**二进制**(`image/*`,未配置时 404 JSON 信封),属"API 强制 JSON"的**声明式例外** —— 权威例外表与逐条断言见 `cmd/server/api_sweep_test.go` |
| 其他 | 404 JSON 信封 "not found" |

## 11. 渠道与门户(公开)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/client/v2/channel` | 渠道内容(公开:登录页在未登录时就要拿到名称/标语/欢迎语/主题色/logo 相对地址)。唯一真源是镜像内 `/opt/picoaide/channel/`(构建期由私有渠道仓注入),**没有在线编辑接口** —— 改内容 = 改渠道配置并重新构建镜像,这样内容可审计 |
| GET/HEAD | `/api/client/v2/channel/logo`、`/api/client/v2/channel/logo-dark`、`/api/client/v2/channel/favicon` | 渠道素材(**二进制** `image/*`;未配置时 404 JSON 信封)。三张图是**各自独立**的端点:曾把三张图都指向 `/channel/logo` 且恒发浅色版,导致 favicon 与暗色 logo 的字节永远下发不了(客户端深色主题因此只能显示浅色标) |

管理端点:`GET/PUT /api/server/admin/portal`(门户公开开关/下载地址覆盖/说明文字)。

> **2026-09-10 起 `brand:*` 已全线下线**:品牌与门户的名称/标语/欢迎语/标识只来自**渠道配置**,
> `/api/client/v2/brand`、`/api/client/v2/brand/logo/:name`、`/api/client/v2/portal` 与
> `/api/server/admin/brand*` 均已删除。按旧文档对接这些路径会拿到 404 JSON 信封。

## 11b. WASM 应用(客户端专属,自定义协议面)

员工应用**只在桌面客户端内**以 `<渠道 app 源 scheme>://<app_id>/` 打开(渠道包 `desktop.app_origin_scheme`,官方/预发渠道取值 `picoaide-app`),由客户端协议 handler 转发到下列**唯一入口**;服务端**不存在**应用子域、换票、应用侧 Cookie 或 `entry_url`(2026-09-19「客户端专属」改造,设计总纲 `../../docs/planning/2026-09-19-wasm-client-only-design.md`)。

| 方法 | 路径 | 认证 | 说明 |
|------|------|------|------|
| POST | `/api/client/v2/apps/wasm/:app_id/request` | Bearer + `X-Pico-App-Proof` | **唯一应用请求入口**。信封 `{method,path,query,host,headers,body}`,其中 `host` 只接受 `<app-scheme>://<app_id>` 或裸 `app_id`;`headers` 白名单 = `origin`/`content-type`/`accept`/`accept-language`/`if-none-match`/`if-modified-since`/`user-agent`/`x-requested-with`(≤24 条、单值 ≤8 KiB;客户端必须转发**同一份**,跨端真源 `internal/wasmapp/api/wasm-app-headers.json`)。非幂等请求按 `Origin == <app-scheme>://<app_id>` 校验跨源写;响应 `{status,headers,body,truncated}`,`Set-Cookie` 整条丢弃、成功响应带 `X-PicoAide-App-Version` |
| GET | `/api/client/v2/apps/wasm/catalog` | Bearer | 应用中心目录：全部**未删除、有生效版本、未冻结**的应用（名称/一句话/负责人/访问级别 `access`/是否下架 `enabled`/当前版本/窗口规格）。**不按可见性过滤**（R34/R38 变更），也不含任何额度/用量字段（R36） |
| GET | `/api/client/v2/apps/wasm/:app_id/diagnostics` | Bearer（发布者本人或超管） | 运行诊断：`{diagnostics:{summary{total,ok,error,killed,failed,reasons[],hints[],max_*},failures[{created_at,outcome,reason_code,guest_exit_code,stderr_tail,evidence,cpu_ms,peak_memory_bytes,db_rows,db_bytes}],hints[]}}`。缺省 50 条、最多 200 条；窗口缺省 24 h、上限 = 调用事件保留期（7 天） |
| GET | `/api/client/v2/apps/wasm/:app_id/schema` | Bearer（发布者本人或超管） | 表结构自省：表名/列（名/类型/not_null/pk）/每表行数/库体积与页数/上限/使用率。**写审计** `wasm_app_schema_view` |
| GET | `/api/client/v2/apps/wasm/:app_id/rows?table=&limit=&offset=&unmask=` | Bearer（发布者本人或超管） | **作者数据面**：某张表的一页行（`limit` 缺省 50、上限 200；`offset` 上限 100 万）。默认按列名启发式**脱敏**敏感列（值替换为 `***`），`unmask=1` 才给原值。响应 `{rows:{app_id,table,columns[{name,type,sensitive}],rows[][],limit,offset,returned,total_rows,has_more,truncated,truncated_values,unmasked,masked_columns,value_max_bytes}}`。**写审计**：`wasm_app_rows_view`（`unmask=1` 时是 `wasm_app_rows_view_unmasked`），审计只记表名与分页、不记行内容。库文件不存在 ⇒ 404（**不会**为了读一次把库建出来） |
| GET | `/api/client/v2/apps/wasm/:app_id/export` | Bearer（发布者本人或超管） | 控制面快照 JSON（应用 + 全部版本元数据 + 保留期说明）。**`database.included=false`**：不含任何使用者数据 |
| POST | `/api/client/v2/apps/wasm/:app_id/open` | Bearer + `X-Pico-App-Proof` | **每次「打开」动作**调一次:校验当前生效版本并**记一次打开**(PV 式,不去重;UV 由按 user 去重的聚合承担)。请求 `{current_version}`;响应 `{version,release_id,title,changed,opens:{today:{pv,uv}}}`(`changed=true` ⇒ 客户端清该应用当前 session-scope 下的全部版本缓存;**计数 best-effort ⇒ 计数失败时 `opens` 缺省,客户端不得显示 0**) |
| POST | `/api/client/v2/apps/wasm/proof` | Bearer + **安装签名** | 签发持有性证明。proof 绑 `(user_id, bearer hash, install_id, serverURL, app_id, exp, jti)`,默认 15 min;非幂等请求做 jti 去重。安装公钥注册是 **TOFU**(任何持有效 bearer 者可为**尚未注册**的 install_id 注册自己的公钥,注册需一次性 nonce 签名)⇒ 该机制使 proof **不可跨应用/跨用户搬运、不可重放**,但**不**把"bearer 泄露"变成"不可用"(认账见设计总纲 §17)。**签名消息是 `appproof-install-v1` 五段换行串**(`install_id`/`nonce`/`ts`(秒)/`serverURL`),公钥必须是**原始 32 字节** Ed25519(不是 SPKI/DER),请求体**只允许** `install_id`/`public_key`/`nonce`/`ts`/`signature`/`app_id` 六个键。签发失败的 `401` 带 `details.reason`,取值:`decode_failed`(JSON 解码失败或含未知字段)/ `invalid_public_key`(公钥不是 base64 或不是**原始 32 字节** Ed25519)/ `signature_malformed`(签名为空/纯空白/不是 base64/长度不符)/ `invalid_timestamp`(`ts` 缺失或 `<= 0`)/ `nonce_replayed` / `timestamp_skew`(超时间窗)/ `install_key_mismatch`(该 install_id 已注册过**别的**公钥)/ `signature_invalid`。**认账**:`install_id`/`nonce` 的**形状**失败目前仍落在 `signature_invalid`,所以该码应读作"最后兜底档",**不能**读成"验签一定不过"——排障时先看前面几档 |
| **错误码分层** | — | — | 对接方按**外层优先**分流。**传输层（外层 HTTP）**：`401 AUTH_REQUIRED` / `401 AUTH_FAILED` / **`401 PROOF_REQUIRED`**（缺证明）/ **`401 PROOF_EXPIRED`**（证明过期）/ **`401 PROOF_MISMATCH`**（绑定或结构/签名不符）/ **`401 PROOF_REPLAYED`**（非幂等请求的 jti 重放）/ `403`（审计账号或权限）/ `400 VALIDATION`（信封或 host 形态）/ `413 BODY_TOO_LARGE` / `429 RATE_LIMITED` / `503`（关停中）。**应用管线（内层信封 `status`）**：`404 NOT_FOUND`（不存在/未登记/软删/**冻结**，冻结时带 `reason=app_frozen`）/ `410`（已下架，`code` 复用 `NOT_FOUND`）/ `403 FORBIDDEN`（跨源写）/ `502`/`504`（运行时无响应或超时）/ `500 RUNTIME_OUTPUT_OVERRUN`。**`X-Pico-App-Proof` 的 401 一律用 `proof_*` 前缀**（客户端据此只在该前缀上自动重签一次） |
| GET | `/api/server/admin/wasm-apps/:app_id/opens?from=&to=&granularity=day\|dept` | 管理会话 + `capability:read` | 打开计数运营视图(PV/UV 日趋势、按部门聚合;明细保留 90 天、日汇总长期)。缺少该端点时管理端显示"接口尚不可用"而**不是 0** |
| GET | `/api/server/admin/wasm-apps/opens/summary?days=` | 管理会话 + `capability:read` | 运营看板总览:`today`/`totals`/`trend[]`/`apps[]`/`top_apps[]`/`capped`/`detail_retention_days`。**读源是有意分开的**:`apps[]`/`today`/`totals` 与 `trend[].uv` 读**明细**,`trend[].pv` 读**日汇总**(曲线长期不断档)。**UV 一律 `count(DISTINCT user_id)`**:禁止把各应用或各日的 `uv` 相加。窗口长于 90 天明细保留期时 `capped=true`,且早于保留期的日期 **UV 如实为 0**(PV 仍真实) |
| GET | `/api/server/admin/wasm-apps/:app_id/ai-usage?days=` | 管理会话 + `capability:read` | 应用维度 AI 用量:`days[]`/`total`/`attribution_available`。`attribution_available=false` 表示**该窗口内没有可归因调用**(与"端点不支持"区分) |
| GET | `/api/server/admin/wasm-apps/:app_id/schema` | 管理会话 + `capability:read` | 管理面的表结构自省（与员工面同 payload、同实现；差别只有鉴权与操作者账号进审计） |
| GET | `/api/server/admin/wasm-apps/:app_id/rows` | 管理会话 + `capability:read` | 管理面的行浏览（与员工面同形；管理员排障与合规用，同样默认脱敏并写审计） |
| GET | `/api/server/admin/wasm-apps/limits` | 管理会话 + `capability:read` | 应用平台限制项(11 个字段)+ 生效来源(`source`:部署档位/控制台保存)+ 四笔账预览(`budget`)+ 需重启字段(`restart_pending`) |
| PUT | `/api/server/admin/wasm-apps/limits` | 管理会话 + `capability:write` | 保存限制项。**信封强制**:必须 `{"limits":{…完整字段…}}` —— 未知顶层键或缺 `limits` 键一律 `400 VALIDATION`(闸门在落库之前 ⇒ 不落库/不写审计/不改运行时);**回落部署档位是显式动作** `{"limits":null}`;越界/缺字段/未知字段各自 `400`;`instance_memory_mb` 属运行时不可变项 ⇒ 保存后进 `restart_pending` |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/reject` | 管理会话 + `capability:write` | 拒绝该版本。`reason` **必填**(归一后为空/纯空白即 `400 VALIDATION`,`field=reason`);理由会写进审计与**作者客户端**(作者据此改后再发)。闸门**先于**版本状态检查 |
| GET/POST | `/api/server/admin/wasm-apps?status=&access=&q=`、`…/:app_id/{publish,unpublish,freeze,owner}` | 管理会话 | 应用中心管理面(`status` 支持 `all/pending/published/unpublished/frozen/deleted`;`access` 支持 `all/login/whitelist`,**`login` 会连同历史 `public` 行一起返回**)。上下架/冻结/归属转移均写审计(含哈希链字段) |

**应用能力边界**:应用内**无 cookie**(自定义协议下 `document.cookie` 恒空)、`localStorage`/`IndexedDB` 可用但**`Cache Storage` 不可用**(`cache.put` 抛 `TypeError: Request scheme … is unsupported`);**服务端 `ai.chat` 宿主能力已删除** —— 需要 AI 的应用改为**前端调客户端 AI loop**(保留路径 `POST /__picoaide/ai/chat`,由客户端协议 handler 本地处理)再把结果回传 wasm 落库。

> 已删除(2026-09-19,照旧文档对接会拿到 404 JSON 信封):应用子域的 `/login`、`/logout`、`/app-ticket`、`/domain` 与应用子域路由树;目录/发布/上下架响应里的 `entry_url`;`access` 取值 `public`(写侧拒绝,存量由迁移 0074 改写为 `login`)。

## 12. 连接器(admin)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/server/admin/connectors`、`/connectors/:id` | 连接器目录 CRUD;`PUT /connectors/:id/enabled` 下架/上架 |

员工面不直接调连接器端点:目录经 bootstrap `connectors[]` 下发;OAuth/设备/令牌授权由客户端本地代理(`/api/pico/connectors/...`,loopback guard)与服务端 `serverauth` 会话协同。
