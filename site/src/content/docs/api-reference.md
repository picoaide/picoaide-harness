---
title: API 参考
description: PicoAide Harness 服务端 HTTP API：命名空间、认证与会话、按功能分组的端点表、错误信封，以及版本与兼容承诺。
---

本页是服务端 HTTP 接口的公开参考。**唯一真源是代码**——全部路径、方法与鉴权集中声明在 `server/internal/router/router.go` 一处；本页与该文件不一致时以代码为准。

除产品 HTML 面（门户页 `/`、`/portal`、管理后台 `/admin/*`）与文件下载（安装包、归档、渠道素材）外，所有端点返回 JSON；失败统一是错误信封 `{"error":{"code":"...","message":"..."}}`。

## 命名空间总览

| 命名空间 | 用途 | 鉴权 |
|---|---|---|
| `/api/client/v2/*` | 员工面：桌面客户端与第三方接入 | Bearer 令牌（少数端点公开，见各表） |
| `/api/server/admin/*` | 管理面：管理后台、运维与审计 | 管理端会话 cookie + CSRF + RBAC 权限点 |
| `/v1/*` | 模型网关：OpenAI 兼容、Anthropic 兼容与 Files API | Bearer 令牌 + 单用户并发闸门 |
| `/updates/client/*` | 客户端安装包下载（根路径，非 API：大文件 + `Range` 语义） | 公开 |
| `/healthz`、`/readyz` | 健康探针 | 公开 |

两个业务命名空间都挂了 **1 MiB 请求体上限**（含未认证的登录端点）。少数路由显式豁免并在 handler 内部自己限体：归档上传、WASM 应用上传、分片上传的单片、应用请求信封。

网关另有**不带 `/v1` 前缀**的官方原生变体（`base_url` 直接填服务端地址）：`/chat/completions`、`/completions`、`/responses`、`/messages`、`/embeddings`、`/models`、`/files*`。它们的鉴权、限流、闸门与计量与 `/v1` 版本完全一致。

## 认证与会话

### 员工面：Bearer 令牌

| 项 | 语义 |
|---|---|
| 取得方式 | `POST /api/client/v2/auth/login`（local / LDAP 账号密码），或浏览器授权登录（OIDC / OpenID）后由客户端换取 |
| 携带方式 | 请求头 `Authorization: Bearer <token>` |
| 生命周期 | 有效期 90 天；服务端**只存哈希**，签发时顺带清理过期行 |
| 吊销 | 登出吊销当前令牌；改密 / 降权 / 禁用会在**同一个事务**里吊销该用户全部令牌；管理员也可在管理后台按令牌单独吊销 |
| 强制改密 | 被管理员重置密码后，除改密、`/auth/me` 与登出外的业务端点返回 `403 PASSWORD_CHANGE_REQUIRED` |
| 令牌失效 vs 服务端故障 | 凭证被拒 → `401 AUTH_FAILED`（客户端清会话并删除本地令牌）；依赖不可用（存储故障、连接池耗尽、语句超时）→ `500 INTERNAL`（客户端保留令牌重试）。这条区分是刻意设计的：把 PG 抖动报成 401 会让全体在线员工被登出 |

### 管理面：会话 cookie + CSRF

| 项 | 语义 |
|---|---|
| 取得方式 | `POST /api/server/admin/login`；开启 TOTP 的账号返回 `mfa_required`，第二步调 `POST /api/server/admin/login/mfa` |
| 携带方式 | HttpOnly cookie（`SameSite=Lax`，`Secure` 按部署协议判定） |
| 生命周期 | **12 小时硬上限** + **60 分钟空闲滑动过期**；服务端只存会话密钥的哈希 |
| CSRF | **所有非 GET/HEAD 请求**必须带 `X-CSRF-Token`；校验失败返回 `403 CSRF_EXPIRED`（独立错误码，前端据此刷新令牌重试一次，而不是把它显示成「没有权限」） |
| RBAC | 每个管理端点申报一个权限点（`user:read` / `gateway:write` …）。角色 `super_admin` 全量、`auditor` 只读子集、`user` 无管理权限；判定在服务端，前端隐藏菜单只是体验层 |

### 错误信封与错误码

失败响应恒为：

```json
{ "error": { "code": "AUTH_FAILED", "message": "令牌无效或已过期" } }
```

| code | HTTP | 说明 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 缺少认证令牌 / 未登录 |
| `AUTH_FAILED` | 401 | 令牌无效或已过期 / 凭证错误 |
| `CSRF_EXPIRED` | 403 | CSRF 校验失败（管理面非 GET 请求） |
| `FORBIDDEN` | 403 | 权限不足（管理端 RBAC 或角色限制） |
| `PASSWORD_CHANGE_REQUIRED` | 403 | 处于强制改密态，业务端点被拦截 |
| `NOT_FOUND` | 404 | 资源不存在（含「未授权即不可见」的严格默认拒绝，不泄露存在性） |
| `VALIDATION` | 400 | 参数校验失败 |
| `RATE_LIMITED` | 429 | 触发限流或超过单用户并发上限 |
| `BALANCE_EXHAUSTED` | 429 | 余额闸门拒绝：余额不足、余额校验不可用，或余额盖不住本次请求的最小计费额（管理员豁免） |
| `MODEL_NOT_PRICED` | 429 | 模型无法计费（输入价与输出价都为空/≤0，或最小应付额折算后为 0）；管理员可用策略开关放行 |
| `UPSTREAM` | 502 | 上游模型错误 |
| `INTERNAL` | 500 | 内部错误（含依赖暂时不可用） |

> `/api/`、`/v1/` 前缀下的未匹配路由（含 405）一律返回 JSON `NOT_FOUND`，不会回落到 HTML 或空响应。带尾斜杠的 API 请求同样返回 404，而不是重定向。

## 端点

鉴权列的含义：**公开** = 无需认证；**Bearer** = 员工令牌；**会话** = 管理端会话 + CSRF + 列出的权限点。

### 认证（员工面）

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| POST | `/api/client/v2/auth/login` | 公开 | 密码登录（local / LDAP）。请求 `{username, password}`；响应 `{token, user, must_change_password}` |
| POST | `/api/client/v2/auth/logout` | Bearer | 吊销当前令牌，响应 `{ok:true}` |
| GET | `/api/client/v2/auth/me` | Bearer | 当前用户：`{user:{id, username, display_name, email, role, permissions, status, source, password_changeable, password_must_change, mfa_enabled, balance_money, balance_activated}}` |
| POST | `/api/client/v2/auth/password` | Bearer | 员工自助改密（仅本地认证账号）。改密后**全部令牌吊销**，客户端需重新登录 |
| GET | `/api/client/v2/auth/methods` | 公开 | 登录方式发现：`{methods:[{name, configured, browser, hidden}]}`。`configured` 以**运行期** provider 注册表为准，不只是配置项存在 |
| GET | `/api/client/v2/auth/oidc/login`、`/api/client/v2/auth/oidc/callback` | 公开 | 浏览器授权登录；provider 在**请求时**从当前认证配置解析，保存后立即生效 |
| GET | `/api/client/v2/auth/openid/login`、`/api/client/v2/auth/openid/callback` | 公开 | 同上（另一套命名空间） |

### 启动配置与用量

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Bearer | 登录后统一下发：`{default_model, models[], skills[], web{}, connectors[], server_version}`。`models[]` 只含已启用 provider 下的可用模型，带 `input_modalities`；`connectors[]` 是连接器**定义**（`{id, name, description, auth_mode, definition}`），不含凭据 |
| GET | `/api/client/v2/auth/usage` | Bearer | 员工用量概览：`balance_money`、`balance_activated`、`balance_enabled`、`balance_monthly`、`balance_mode`，以及 `today_*` / `yesterday_*` / `monthly_*` / `total_*` 的 tokens 与费用 |

> 服务端**没有**会话端点：会话、上下文与审批都在客户端本地（见[系统架构](/architecture/)）。

### 渠道内容与客户端分发（公开）

登录页在**未登录**时就要拿到品牌与安装包，所以这一组不需要认证。

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/client/v2/channel` | 公开 | 渠道内容：渠道 id、标题、登录页/客户端名称与标语、主题色 |
| GET / HEAD | `/api/client/v2/channel/logo` | 公开 | 渠道 logo（亮色版）；未配置时 404 JSON 信封 |
| GET / HEAD | `/api/client/v2/channel/logo-dark` | 公开 | 渠道 logo（暗色版）；未配置时 404 |
| GET / HEAD | `/api/client/v2/channel/favicon` | 公开 | 渠道 favicon；未配置时 404 |
| GET | `/api/client/v2/updates/manifest` | 公开 | 客户端版本清单：`{schema:1, channel_id, server:{version}, client:{version, assets}}`；资产按 `mac-universal` / `win-x64` / `linux-x64` 索引，每项 `{url, sha256, size}`。给不出绝对 https 地址时返回 `client_unavailable` 原因。响应 `Cache-Control: no-store` |
| GET / HEAD | `/updates/client/<文件名>` | 公开 | 安装包下载：扩展名白名单、只服务资产目录内的普通文件、显式 `Content-Type` + `Content-Disposition: attachment` + `nosniff`、`Range` 断点续传、长缓存；该路由单独放宽写截止时间，慢链路也能下完 |

### 能力中心：技能与智能体

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | Bearer | 市场技能目录（按授权可见） |
| GET | `/api/client/v2/marketplace/skills/:name` | Bearer | 市场技能详情 |
| GET | `/api/client/v2/marketplace/skills/:name/archive` | Bearer | 下载市场技能包；响应头 `X-Skill-Checksum` / `X-Skill-Version` 供客户端做完整性对照 |
| GET | `/api/client/v2/skills/builtin` | Bearer | 平台内置技能清单（随服务端镜像发布，客户端按需安装） |
| GET | `/api/client/v2/skills/builtin/:name/archive` | Bearer | 下载内置技能包 |
| GET | `/api/client/v2/shared-skills` | Bearer | 组织共享技能清单：已审核且已授权的内容，加上自己上传的全部状态 |
| POST | `/api/client/v2/shared-skills` | Bearer | 上传共享技能（归档 base64，含顶层 `SKILL.md`），进入待审核 |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | Bearer | 下载共享技能包 |
| GET | `/api/client/v2/agent-presets` | Bearer | 组织共享智能体清单（与共享技能同一套可见性规则） |
| POST | `/api/client/v2/agent-presets` | Bearer | 上传共享智能体（含顶层 `agent.cordis.yml`） |
| GET | `/api/client/v2/agent-presets/:name/archive`、`/api/client/v2/agent-presets/:name/:version/archive` | Bearer | 下载共享智能体包（最新版 / 指定版本） |
| GET | `/api/client/v2/capabilities` | Bearer | 能力中心统一目录；查询参数 `source=own\|market\|org`、`type=`、`q=`。市场与组织合并为一条权威行（市场优先） |
| POST | `/api/client/v2/telemetry/skill-call` | Bearer | 上报技能调用（累加计数，限流可配） |
| POST | `/api/client/v2/telemetry/error-reporting` | Bearer | 客户端回报自身错误上报的初始化结果；未知状态静默接受且不写库 |

> 共享内容的可见性是**双门制**：审核通过 **且** 被授权（授权对象可以是用户或部门）。未授权一律 404，不泄露存在性；管理员恒全量。

### 连接器

员工面通过 bootstrap 拿到连接器**定义**；凭据由客户端在本地按用户 scope 收集与加密存储，服务端不接收也不下发凭据值。连接器的增删改与启停都在管理面。

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | Bearer | 连接器目录的唯一来源（见上表 `connectors[]`） |

### 应用中心（WASM 应用，员工面）

应用只在桌面客户端内打开：客户端把 `<app 源 scheme>://<app_id>/…` 上的请求包成信封发到唯一入口执行。

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/client/v2/apps/wasm/catalog` | Bearer | 应用目录：只滤「未删除 / 非冻结 / 有生效版本」，下发 `access` 与 `enabled`（下架的应用仍展示但标记） |
| POST | `/api/client/v2/apps/wasm/validate` | Bearer | 校验 `.wasm` 制品（不发布、不占版本号、不消耗上传额度），返回结构化结论 |
| POST | `/api/client/v2/apps/wasm/:app_id/releases` | Bearer | 发布一个新版本（单发路径）；按管理端开关直接生效或落为待审核 |
| POST | `/api/client/v2/apps/wasm/uploads` | Bearer | 分片上传：开会话，返回 `upload_id` |
| PUT | `/api/client/v2/apps/wasm/uploads/:upload_id/chunks/:index` | Bearer | 上传第 `index` 片（`application/octet-stream`，单片有上限） |
| GET | `/api/client/v2/apps/wasm/uploads/:upload_id` | Bearer | 续传查询：已收到哪些片 |
| POST | `/api/client/v2/apps/wasm/uploads/:upload_id/complete` | Bearer | 拼装并走发布链路；客户端可在这一跳声明本跳预算（请求头），平台只许缩小、永不放大 |
| DELETE | `/api/client/v2/apps/wasm/uploads/:upload_id` | Bearer | 主动放弃并回收磁盘 |
| POST | `/api/client/v2/apps/wasm/:app_id/request` | Bearer | **应用执行的唯一入口**：应用请求信封在此被解码并执行，身份由客户端注入 |
| POST | `/api/client/v2/apps/wasm/proof` | Bearer | 签发持有性证明（绑定「哪个员工 + 哪把令牌 + 哪个应用」） |
| POST | `/api/client/v2/apps/wasm/:app_id/open` | Bearer | 打开校验与计数；响应头 `X-PicoAide-App-Version` 是客户端内容缓存键的唯一来源 |
| GET | `/api/client/v2/apps/wasm/:app_id/availability` | Bearer | 标识唯一性预查（只读，不编译、不占版本号） |
| GET | `/api/client/v2/apps/wasm/:app_id/releases` | Bearer | 发布者本人的版本历史与审核结论（含被拒理由）。非发布者一律 404，且与「应用不存在」逐字节同形 |
| POST | `/api/client/v2/apps/wasm/:app_id/publish`、`/api/client/v2/apps/wasm/:app_id/unpublish` | Bearer | 上架 / 下架（发布者本人） |
| POST | `/api/client/v2/apps/wasm/:app_id/freeze` | Bearer | 冻结 |
| GET | `/api/client/v2/apps/wasm/:app_id/diagnostics` | Bearer | 运行诊断（仅发布者本人） |
| GET | `/api/client/v2/apps/wasm/:app_id/schema` | Bearer | 应用库的表结构、列、行数与占用（不含行值） |
| GET | `/api/client/v2/apps/wasm/:app_id/rows` | Bearer | 只读浏览应用库的行（仅发布者本人；默认脱敏，显式取原值时写不同审计动作） |
| GET | `/api/client/v2/apps/wasm/:app_id/export` | Bearer | 导出应用 |
| DELETE | `/api/client/v2/apps/wasm/:app_id` | Bearer | 删除应用 |

### 管理面：认证与会话

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| POST | `/api/server/admin/login` | 公开 | 管理员登录。响应 `{csrf_token, user, must_change_password}`；开启 TOTP 时返回 `{mfa_required:true, mfa_ticket}` |
| POST | `/api/server/admin/login/mfa` | 公开 | 两步验证第二步：`{mfa_ticket, code}` |
| GET | `/api/server/admin/auth/methods` | 公开 | 登录方式发现；与员工面**同一条判定**，同一台服务端不会出现两种说法 |
| GET | `/api/server/admin/me` | 会话 | 当前管理员 + 当前会话的 CSRF token（刷新页面后可直接续用） |
| POST | `/api/server/admin/logout` | 会话 | 登出 |
| POST | `/api/server/admin/me/password` | 会话 | 修改自己的密码（旧密码 + 动态码双验；成功后吊销全部会话） |
| GET | `/api/server/admin/me/mfa` | 会话 | 查看自己的 MFA 状态 |
| POST | `/api/server/admin/me/mfa/enable`、`/me/mfa/verify`、`/me/mfa/disable` | 会话 | 开启 / 验证 / 关闭 TOTP；关闭需要主密码 + 动态码双验 |

### 管理面：用户与部门

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/users` | 会话 + `user:read` | 用户列表（含角色、状态、余额、改密与 MFA 标记） |
| POST | `/api/server/admin/users` | 会话 + `user:write` | 新建用户 |
| PUT | `/api/server/admin/users/:id` | 会话 + `user:write` | 更新用户（角色、状态、显示名、邮箱、重置密码）。请求体里的配额字段已下线，会被忽略 |
| DELETE | `/api/server/admin/users/:id` | 会话 + `user:write` | 删除用户 |
| PUT | `/api/server/admin/users/:id/mfa` | 会话 + `user:write` | 重置他人 MFA（不能对自己；重置后吊销其全部会话） |
| GET | `/api/server/admin/users/:id/groups` | 会话 + `user:read` | 用户所属部门 |
| PUT | `/api/server/admin/users/:id/department` | 会话 + `dept:write` | 设置部门归属（`group_ids` 数组，支持多部门） |
| GET | `/api/server/admin/departments` | 会话 + `dept:read` | 部门树 |
| POST | `/api/server/admin/departments` | 会话 + `dept:write` | 新建部门 |
| PUT | `/api/server/admin/departments/:id` | 会话 + `dept:write` | 更新部门 |
| DELETE | `/api/server/admin/departments/:id` | 会话 + `dept:write` | 删除部门 |
| GET | `/api/server/admin/users/:id/tokens` | 会话 + `user:read` | 该用户的登录令牌列表 |
| POST | `/api/server/admin/tokens/:id/revoke` | 会话 + `user:write` | 吊销指定令牌 |

### 管理面：余额与用量

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| POST | `/api/server/admin/users/:id/balance` | 会话 + `user:write` | 调整员工余额（增加 / 扣减 / 设为），写审计 |
| GET | `/api/server/admin/users/:id/balance/ledger` | 会话 + `user:read` | 该用户的余额流水账本 |
| GET | `/api/server/admin/balance` | 会话 + `user:read` | 余额闸门与月度发放配置 |
| PUT | `/api/server/admin/balance` | 会话 + `user:write` | 修改余额配置 |
| POST | `/api/server/admin/balance/grant` | 会话 + `user:write` | 手动触发发放（跨实例/重启幂等） |
| GET | `/api/server/admin/usage` | 会话 + `usage:read` | 用量汇总 |
| GET | `/api/server/admin/usage/overview` | 会话 + `usage:read` | 用量中心总览（按天趋势、部门、成员、模型） |
| GET | `/api/server/admin/usage/requests` | 会话 + `usage:read` | 请求级明细（分页，窗口有上限） |
| GET | `/api/server/admin/report-subscriptions` | 会话 + `report:read` | 用量报表订阅列表。**列表含 webhook 凭据本体**，因此用独立权限点，只读审计角色默认拿不到 |
| POST | `/api/server/admin/report-subscriptions` | 会话 + `report:write` | 新建订阅 |
| PUT / DELETE | `/api/server/admin/report-subscriptions/:id` | 会话 + `report:write` | 更新 / 删除订阅 |
| POST | `/api/server/admin/report-subscriptions/:id/test` | 会话 + `report:write` | 测试推送 |

### 管理面：认证配置

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/auth` | 会话 + `auth:read` | 认证配置（敏感字段脱敏） |
| PUT | `/api/server/admin/auth` | 会话 + `auth:write` | 保存认证配置（含 client_secret）。保存后立即生效，无需重启 |
| POST | `/api/server/admin/auth/test` | 会话 + `auth:write` | 连通性测试（LDAP 目录统计 / OIDC 发现文档） |

### 管理面：网关与模型

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/providers` | 会话 + `gateway:read` | 上游 provider 列表 |
| POST | `/api/server/admin/providers` | 会话 + `gateway:write` | 新建 provider（API Key 加密存储） |
| PUT / DELETE | `/api/server/admin/providers/:id` | 会话 + `gateway:write` | 更新 / 删除 provider |
| GET | `/api/server/admin/providers/:id/balance` | 会话 + `gateway:read` | 上游账号余额（供应商支持时） |
| POST | `/api/server/admin/providers/:id/sync`、`/api/server/admin/providers/sync-all` | 会话 + `gateway:write` | 从上游同步模型目录（停用而非删除，以保住定价） |
| GET | `/api/server/admin/models` | 会话 + `gateway:read` | 模型列表（含定价、缓存价、峰谷折扣、输入模态） |
| POST | `/api/server/admin/models` | 会话 + `gateway:write` | 新建模型 |
| PUT / DELETE | `/api/server/admin/models/:id` | 会话 + `gateway:write` | 更新 / 删除模型 |
| GET | `/api/server/admin/gateway` | 会话 + `gateway:read` | 网关配置（默认模型、限流、高峰窗口、用量策略、未定价模型策略） |
| PUT | `/api/server/admin/gateway` | 会话 + `gateway:write` | 修改网关配置；改价与改窗口只影响之后产生的费用 |
| GET | `/api/server/admin/gateway/files` | 会话 + `gateway:read` | Files API 归属台账：按员工看占用、搜索与排序 |
| GET | `/api/server/admin/gateway/files/summary` | 会话 + `gateway:read` | 台账汇总 |
| DELETE | `/api/server/admin/gateway/files/:file_id` | 会话 + `gateway:write` | 删除单个上游文件 |
| POST | `/api/server/admin/gateway/files/purge` | 会话 + `gateway:write` | 批量清理 |
| POST | `/api/server/admin/gateway/error-reporting/test` | 会话 + `gateway:write` | 服务端代发一条测试事件（验证错误追踪链路） |
| GET | `/api/server/admin/gateway/error-reporting/clients` | 会话 + `gateway:read` | 客户端上报状态聚合（N 台已启用 / M 台失败） |
| GET | `/api/server/admin/channels` | 会话 + `gateway:read` | 渠道列表（只读诊断；渠道内容来自构建期注入，不能在线改） |
| GET | `/api/server/admin/concurrency` | 会话 + `gateway:read` | 按模型的并发状态：当前 + 历史峰值 + 目标 |

### 管理面：能力中心与审批

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/capabilities/approvals` | 会话 + `capability:read` | 能力中心统一审批队列（只读，动作走各自的域端点） |
| GET | `/api/server/admin/skills` | 会话 + `market:read` | 市场技能列表 |
| POST | `/api/server/admin/skills` | 会话 + `market:write` | 新建市场技能 |
| POST | `/api/server/admin/skills/:name/archive` | 会话 + `market:write` | 上传技能归档（新版本） |
| GET | `/api/server/admin/skills/:name/archive` | 会话 + `market:read` | 下载技能归档 |
| PUT / DELETE | `/api/server/admin/skills/:name` | 会话 + `market:write` | 更新 / 删除市场技能 |
| POST | `/api/server/admin/skills/:name/enable` | 会话 + `market:write` | 上架 / 下架 |
| POST | `/api/server/admin/skills/:name/normalize` | 会话 + `market:write` | 规范化技能归档 |
| GET | `/api/server/admin/skills/:name/preview`、`/skills/:name/file` | 会话 + `market:read` | 预览 / 读取单个文件内容 |
| GET | `/api/server/admin/skills/builtin` | 会话 + `capability:read` | 平台内置技能（只读诊断面；路径与 `/skills/:name` 同级，静态段优先） |
| GET / PUT | `/api/server/admin/skills/:name/grants` | 会话 + `market:read` / `market:write` | 列出 / 整体替换授权 |
| PUT / DELETE | `/api/server/admin/skills/:name/grant` | 会话 + `market:write` | 增加 / 移除一条授权 |
| GET | `/api/server/admin/agents` | 会话 + `market:read` | 市场智能体列表 |
| POST | `/api/server/admin/agents` | 会话 + `market:write` | 新建市场智能体 |
| POST | `/api/server/admin/agents/:name/archive` | 会话 + `market:write` | 上传智能体归档 |
| GET | `/api/server/admin/agents/:name/archive` | 会话 + `market:read` | 下载智能体归档 |
| PUT / DELETE | `/api/server/admin/agents/:name` | 会话 + `market:write` | 更新 / 删除 |
| POST | `/api/server/admin/agents/:name/enable` | 会话 + `market:write` | 上架 / 下架 |
| GET | `/api/server/admin/agents/:name/preview`、`/agents/:name/file` | 会话 + `market:read` | 预览 / 读取文件内容 |
| GET / PUT | `/api/server/admin/agents/:name/grants` | 会话 + `market:read` / `market:write` | 列出 / 整体替换授权 |
| PUT / DELETE | `/api/server/admin/agents/:name/grant` | 会话 + `market:write` | 增加 / 移除一条授权 |
| GET | `/api/server/admin/shared-skills` | 会话 + `capability:read` | 组织共享技能全量（含待审） |
| GET | `/api/server/admin/shared-skills/:name/:version/archive`、`/preview`、`/file` | 会话 + `capability:read` | 下载 / 预览 / 读取文件 |
| POST | `/api/server/admin/shared-skills/:name/:version/approve`、`/reject` | 会话 + `capability:write` | 审核通过 / 拒绝（拒绝必须给理由） |
| DELETE | `/api/server/admin/shared-skills/:name/:version` | 会话 + `capability:write` | 删除某个版本 |
| PUT | `/api/server/admin/shared-skills/:name/:version/quality` | 会话 + `capability:write` | 打质量标记（官方 / 精选） |
| PUT | `/api/server/admin/shared-skills/:name/enabled` | 会话 + `capability:write` | 组织共享技能上架 / 下架 |
| GET / PUT | `/api/server/admin/shared-skills/:name/grants` | 会话 + `capability:read` / `capability:write` | 列出 / 整体替换授权 |
| PUT / DELETE | `/api/server/admin/shared-skills/:name/grant` | 会话 + `capability:write` | 增加 / 移除一条授权 |
| GET | `/api/server/admin/agent-presets` | 会话 + `capability:read` | 组织共享智能体全量 |
| GET | `/api/server/admin/agent-presets/:name/archive`、`/:name/preview`、`/:name/:version/archive`、`/:name/:version/preview`、`/:name/:version/file` | 会话 + `capability:read` | 下载 / 预览 / 读取文件 |
| POST | `/api/server/admin/agent-presets/:name/approve`、`/reject`、`/:name/:version/approve`、`/:name/:version/reject` | 会话 + `capability:write` | 审核通过 / 拒绝 |
| DELETE | `/api/server/admin/agent-presets/:name`、`/:name/:version` | 会话 + `capability:write` | 删除智能体 / 某个版本 |
| PUT | `/api/server/admin/agent-presets/:name/:version/quality` | 会话 + `capability:write` | 打质量标记 |
| PUT | `/api/server/admin/agent-presets/:name/enabled` | 会话 + `capability:write` | 组织共享智能体上架 / 下架 |
| GET / PUT | `/api/server/admin/agent-presets/:name/grants` | 会话 + `capability:read` / `capability:write` | 列出 / 整体替换授权 |
| PUT / DELETE | `/api/server/admin/agent-presets/:name/grant` | 会话 + `capability:write` | 增加 / 移除一条授权 |
| GET | `/api/server/admin/capability-locks` | 会话 + `capability:read` | 能力锁定名单（仅管理员可发布的技能 / 智能体；支持对尚不存在的名字预锁定） |
| PUT / DELETE | `/api/server/admin/capability-locks/:kind/:name` | 会话 + `capability:write` | 增加 / 移除锁定 |
| PUT | `/api/server/admin/apps/:kind/:app_id/owner` | 会话 + `capability:write` | 转移能力归属（负责人）。归属是应用级、与版本无关，因此挂在 `apps` 基路径 |

### 管理面：连接器、门户与服务器信息

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/connectors` | 会话 + `connector:read` | 连接器目录（定义、认证模式、启用状态） |
| GET | `/api/server/admin/connectors/:id` | 会话 + `connector:read` | 单个连接器 |
| POST | `/api/server/admin/connectors` | 会话 + `connector:write` | 新建。服务端在写入路径把输入归一成规范定义（含凭据字段形状校验） |
| PUT / DELETE | `/api/server/admin/connectors/:id` | 会话 + `connector:write` | 更新 / 删除 |
| PUT | `/api/server/admin/connectors/:id/enabled` | 会话 + `connector:write` | 下发开关 |
| GET | `/api/server/admin/portal` | 会话 + `portal:read` | 门户页配置（是否公开、下载地址覆盖、说明文字）。**品牌名称与文案不在这里**——它们来自渠道内容 |
| PUT | `/api/server/admin/portal` | 会话 + `portal:write` | 修改门户页配置 |
| GET | `/api/server/admin/server-info` | 会话 + `server-info:read` | 服务器信息：版本与更新提示、数据库与迁移、模型并发、错误监控配置面 |

### 管理面：审计

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/audit` | 会话 + `audit:read` | 审计日志（哈希链，防篡改） |
| GET | `/api/server/admin/audit/settings` | 会话 + `audit:read` | 审计保留策略 |
| PUT | `/api/server/admin/audit/settings` | 会话 + `audit:retention:write` | 修改保留策略（仅超管） |

### 管理面：应用平台（WASM）

挂载在 `/api/server/admin/wasm-apps`。读端点用 `capability:read`，写端点用 `capability:write`。

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| GET | `/api/server/admin/wasm-apps` | 会话 + `capability:read` | 应用列表 |
| POST | `/api/server/admin/wasm-apps/:app_id/publish`、`/unpublish` | 会话 + `capability:write` | 上架 / 下架（管理端处置，与员工面本人上下架对称） |
| POST | `/api/server/admin/wasm-apps/:app_id/freeze` | 会话 + `capability:write` | 冻结 |
| PUT | `/api/server/admin/wasm-apps/:app_id/owner` | 会话 + `capability:write` | 转移归属 |
| GET | `/api/server/admin/wasm-apps/:app_id/releases` | 会话 + `capability:read` | 该应用的版本与审核队列 |
| POST | `/api/server/admin/wasm-apps/:app_id/releases/:version/approve`、`/reject` | 会话 + `capability:write` | 审批某个版本 |
| PUT | `/api/server/admin/wasm-apps/review` | 会话 + `capability:write` | 发布审核总开关 |
| GET / PUT | `/api/server/admin/wasm-apps/limits` | 会话 + `capability:read` / `capability:write` | 平台限制项（并发、实例内存、时间预算等）。多数即时生效，实例内存需重启 |
| GET | `/api/server/admin/wasm-apps/runtime` | 会话 + `capability:read` | 平台级运行时水位：编译队列与缓存、执行槽、调用事件丢包计数、磁盘余量 |
| GET | `/api/server/admin/wasm-apps/:app_id/diagnostics` | 会话 + `capability:read` | 应用诊断（管理员排障出口） |
| GET | `/api/server/admin/wasm-apps/:app_id/schema`、`/rows` | 会话 + `capability:read` | 应用库表结构与行浏览（与员工面同实现，差别在鉴权与操作者账号进审计） |
| GET | `/api/server/admin/wasm-apps/:app_id/opens` | 会话 + `capability:read` | 应用打开计数（长期保留的日汇总 + 明细） |
| GET | `/api/server/admin/wasm-apps/opens/summary` | 会话 + `capability:read` | 运营看板概览（静态段，比 `/:app_id/opens` 更具体，优先匹配） |
| GET | `/api/server/admin/wasm-apps/:app_id/ai-usage` | 会话 + `capability:read` | 应用维度的 AI 用量 |

### 模型网关（`/v1/*`）

| 方法 | 路径 | 鉴权 | 说明与关键字段 |
|---|---|---|---|
| POST | `/v1/chat/completions` | Bearer + 并发闸门 | OpenAI 兼容对话（`stream` 可选） |
| POST | `/v1/embeddings` | Bearer + 并发闸门 | 向量接口 |
| POST | `/v1/completions` | Bearer + 并发闸门 | 补全 |
| POST | `/v1/responses` | Bearer + 并发闸门 | 兼容形态（用量字段同时认两套命名） |
| POST | `/v1/messages` | Bearer + 并发闸门 | Anthropic Messages 兼容 |
| GET | `/v1/models` | Bearer + 并发闸门 | 可用模型列表（只列已启用 provider 下、目录未缺失的模型，含输入模态） |
| POST | `/v1/files` | Bearer + 并发闸门 | 上传文件，返回 `file_id` |
| GET | `/v1/files` | Bearer + 并发闸门 | 列出文件 |
| GET | `/v1/files/:file_id` | Bearer + 并发闸门 | 查询文件元数据 |
| DELETE | `/v1/files/:file_id` | Bearer + 并发闸门 | 删除文件 |

> `Authorization: Bearer` 是唯一认证方式。无 `/v1` 前缀的原生变体（`/chat/completions`、`/completions`、`/responses`、`/messages`、`/embeddings`、`/models`、`/files*`）同样挂载，行为一致。

### 门户与健康探针

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/`、`/portal` | 公开 | 门户首页：渠道品牌 + 三平台客户端下载入口（纯 HTML，无脚本） |
| GET | `/admin/` | 公开（页面自身再要求登录） | 管理后台 SPA（构建产物内嵌在服务端二进制里） |
| GET | `/healthz` | 公开 | 健康探针：JSON，含数据库连通性；数据库不可用返回 503 |
| GET | `/readyz` | 公开 | 就绪探针：在健康检查之外补充磁盘余量、执行与编译队列水位、保留清理的过程事实；未认证端点因此只给短语，明细进服务端日志 |

## 版本与兼容承诺

**稳定契约**（可以依赖）：

- 命名空间划分：`/api/client/v2/*` 是员工面、`/api/server/admin/*` 是管理面、`/v1/*` 是模型网关；
- 认证方式与令牌语义（Bearer 的位置、管理端 CSRF 头名 `X-CSRF-Token`）；
- 错误信封 `{"error":{"code","message"}}` 与上表的错误码集合；
- 更新清单的 `schema` / `channel_id` / `assets[].url|sha256|size` 形状——它是客户端与更新服务器之间的升级契约；
- `/v1/*` 的 OpenAI / Anthropic 兼容形态。

**可能变化**：

- 管理面端点的请求体与响应体字段。管理后台与它**同版本发布**，两者一起演进；第三方直接对接管理面需要按版本对齐；
- 新增字段是向后兼容的（客户端忽略未知字段），已有字段的语义变更是行为变更，会写进发布说明；
- `bootstrap.server_version` 是**诊断/溯源**字段，目前没有任何客户端消费方——它不是版本错配提示的来源（版本检查走更新清单）。

**已经下线，不要再用**：

- 旧命名空间 `/api/*`（历史管理面与员工面路由）、`/v2/api/*`、`/v2/v1/*`。现在的 `/v1/*` 是模型网关，不是旧管理面；
- 员工浏览器会话与一次性换票链路：`/login`、`/logout`、`/app-ticket` 已随「应用只在桌面客户端内打开」的改造整体删除；
- 旧的品牌与门户端点 `/api/client/v2/brand`、`/api/client/v2/portal`：品牌与门户内容改由 `/api/client/v2/channel` 与门户 HTML 提供；
- 员工侧的 token 配额、金额配额与部门预算接口字段：余额是唯一计费闸门，请求体里的相关字段会被忽略。

**已知未实现**（与官方模型 API 文档的差异，按官方文档接入会失败）：

- `/beta` 前缀（前缀续写与 FIM）未实现；
- Anthropic 兼容的 `/anthropic/v1/*` 前缀与 `x-api-key` 认证未实现（`/v1/messages` 走 Bearer）；
- `GET /user/balance`（密钥持有人视角）未实现，只有管理面的 `providers/:id/balance`；
- 官方 429 表示「账号级并发上限」，本产品的 429 表示余额不足或本地限流——语义不同。

> 带尾斜杠的 API 请求返回 404 JSON，而不是 307 重定向：语义可预测，且与请求体上限的判定一致。

## 相关

- [系统架构](/architecture/) — 三层职责、装配方式、数据落点与扩展点
- [管理后台](/admin/) — 与这些管理端点一一对应的页面
- [桌面客户端](/desktop/) — 员工侧功能与调用这些接口的时机
- [私有化部署](/deployment/) — 端口、证书与反向代理注意事项
