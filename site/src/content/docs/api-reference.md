---
title: API 参考
description: PicoAide Harness 服务端 HTTP API 参考：认证、LLM 网关、启动配置、渠道与客户端分发、商城与共享内容、管理端点。
---

> 本页是服务端 HTTP 接口的公开摘要。所有端点以代码为准（`server/internal/router` 是路由唯一真源）。
> 失败统一返回错误信封 `{"error":{"code":"ERR_CODE","message":"..."}}`；除产品 HTML 面（门户、管理后台）与文件下载外，所有端点返回 JSON。

**命名空间**：

- `/api/server/*` — 管理面（webadmin / 运维 / 审计；session + CSRF + RBAC）
- `/api/client/v2/*` — 客户端员工面（企业客户端与第三方接入；Bearer）
- `/v1/*` — LLM 网关（OpenAI / Anthropic 兼容，Bearer；另有官方原生无 `/v1` 变体）
- `/updates/client/*` — 客户端安装包下载（根路径，非 API：大文件 + Range 语义）

## 错误码

| code | HTTP | 说明 |
|---|---|---|
| `AUTH_REQUIRED` | 401 | 缺少认证令牌 |
| `AUTH_FAILED` | 401 | 令牌无效或已过期 / 凭证错误 |
| `FORBIDDEN` | 403 | 权限不足（管理端） |
| `NOT_FOUND` | 404 | 资源不存在（含"未授权即不可见"的严格默认拒绝） |
| `VALIDATION` | 400 | 参数校验失败 |
| `UPSTREAM` | 502 | 上游 LLM 错误 |
| `RATE_LIMITED` | 429 | 触发限流 |
| `QUOTA_EXCEEDED` | 429 | 本月 token / 金额配额、部门预算或余额不足（admin 豁免） |
| `INTERNAL` | 500 | 内部错误 |

## 认证（员工面）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/client/v2/auth/login` | 密码登录（local / LDAP）：`{username, password}` → `{token}` |
| POST | `/api/client/v2/auth/logout` | 吊销当前 token |
| GET | `/api/client/v2/auth/me` | 当前用户（含 `role` / `permissions`） |
| GET | `/api/client/v2/auth/usage` | 员工用量概览：余额、今日/昨日/本月/累计 tokens + 费用、部门预算链 |
| POST | `/api/client/v2/auth/password` | 员工自助改密（本地用户；改密后全部令牌吊销，需重新登录） |
| GET | `/api/client/v2/auth/methods` | 登录方式发现（公开） |
| GET | `/api/client/v2/auth/oidc/login` `/callback`（OpenID 同） | 浏览器授权登录；provider 在请求时从认证配置解析，保存即生效 |

## LLM 网关（`/v1/*`，Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 兼容 chat 代理（stream 可选） |
| POST | `/v1/embeddings` | 向量接口 |
| POST | `/v1/completions` / `/v1/responses` | 原生/兼容形态 |
| POST | `/v1/messages` | Anthropic Messages 兼容（web_search 服务端代理） |
| GET | `/v1/models` | 可用模型列表（仅 enabled provider，含输入模态） |

> 无 `/v1` 前缀的官方原生变体同样挂载（`base_url=server` 使用）；鉴权 / 限流 / 配额 / 计量与 `/v1/chat/completions` 一致。

## 启动配置

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/config/bootstrap` | 登录后统一下发：`{default_model, models, skills, web, connectors}` |

## 渠道内容与客户端分发（公开）

客户端登录页在未登录时就要拿品牌与安装包，所以这一组不需要认证：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/channel` | 渠道内容：渠道 id、标题、登录页/客户端名称与标语、主题色 |
| GET/HEAD | `/api/client/v2/channel/logo` | 渠道 logo（亮色版） |
| GET/HEAD | `/api/client/v2/channel/logo-dark` | 渠道 logo（暗色版） |
| GET/HEAD | `/api/client/v2/channel/favicon` | 渠道 favicon |
| GET | `/api/client/v2/updates/manifest` | 客户端版本清单：`{schema, channel_id, server:{version}, client:{version, assets}}`；给不出绝对 https 地址时返回 `client_unavailable` 原因 |
| GET/HEAD | `/updates/client/<文件名>` | 安装包下载（扩展名白名单；`Range` 断点续传；长缓存） |
| GET | `/`、`/portal` | 门户首页（纯 HTML，无脚本）：品牌 + 三平台下载入口 |

> 客户端据此升级：清单 `channel_id` 必须与服务端一致，安装包地址必须是绝对 https，下载后按清单中的 SHA-256 校验。

## 市场与共享内容（员工面）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/client/v2/marketplace/skills` | 技能目录（授权可见） |
| GET | `/api/client/v2/marketplace/skills/:name` `/:name/archive` | 技能详情 / 下载技能包 |
| GET | `/api/client/v2/shared-skills` | 共享技能清单（approved 且已授权 + 自己上传的全部状态） |
| POST | `/api/client/v2/shared-skills` | 上传共享技能（归档 base64，≤16MB，含顶层 `SKILL.md`），直存 DB |
| GET | `/api/client/v2/shared-skills/:name/:version/archive` | 下载共享技能包 |
| GET | `/api/client/v2/agent-presets` | 共享 Agent 清单（同上双门制） |
| POST | `/api/client/v2/agent-presets` | 上传共享 Agent（含顶层 `agent.cordis.yml`） |
| GET | `/api/client/v2/agent-presets/:name/archive` `/:name/:version/archive` | 下载共享 Agent 包 |
| GET | `/api/client/v2/capabilities?source=market\|org&type=&q=` | 能力中心统一目录：市场 + 组织合并视图 |
| POST | `/api/client/v2/telemetry/skill-call` | 上报技能调用（累加 `calls`，限流可配） |

> 共享内容可见性 = **审核通过 + 授权**（用户/部门）双门制；admin 恒全量；未授权 404 不泄露存在性。

## 管理端（`/api/server/admin/*`，session + CSRF + RBAC）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/server/admin/login` | 管理员登录（`super_admin` / `auditor`；`user` → 403） |
| GET | `/me` `/logout` | 当前管理员 / 登出 |
| POST | `/me/password` | 修改自己的密码（改后吊销全部会话） |
| GET/POST | `/me/mfa` `/me/mfa/enable` `/me/mfa/verify` `/me/mfa/disable` | 管理员 TOTP 动态码（查看 / 开启 / 验证 / 关闭） |
| GET/POST/PUT/DELETE | `/users` `/users/:id` | 用户 CRUD（配额、角色、状态、重置密码、重置 MFA） |
| PUT | `/users/:id/department` | 设置部门归属（`group_ids` 数组，支持多部门） |
| GET/POST/PUT/DELETE | `/departments` `/departments/:id` | 部门树与预算 |
| POST | `/users/:id/balance` | 员工余额调整（增加 / 扣减 / 设为，写审计） |
| GET/PUT/POST | `/balance` `/balance/grant` | 余额闸门与月度发放配置 / 手动发放（幂等） |
| GET | `/users/:id/tokens`、POST `/tokens/:id/revoke` | 登录令牌查看与吊销 |
| GET | `/usage` `/usage/overview` `/usage/requests` | 用量汇总 / 总览 / 明细（分页、窗口上限 90 天） |
| GET/POST/PUT/DELETE | `/report-subscriptions` `/:id` `/:id/test` | 用量报表订阅与测试推送 |
| GET | `/server-info` `/concurrency` `/audit` `/audit/settings` | 服务器信息 / 模型并发 / 审计日志 / 审计保留策略 |
| GET/PUT/POST | `/auth` `/auth/test` | 认证配置与连通性测试（LDAP 目录统计 / OIDC 发现文档） |
| GET/POST/PUT/DELETE | `/providers` `/providers/:id` `/models` `/gateway` | 网关上游、模型（定价 / 缓存价 / 峰谷折扣 / 输入模态）、网关配置 |
| GET | `/providers/:id/balance` `/channels` | 上游账号余额（如支持）/ 渠道列表 |
| GET/POST/PUT/DELETE | `/skills` `/agents` 及其归档与授权端点 | 技能商城与 Agent 目录管理 |
| GET/POST | `/shared-skills/*` `/agent-presets/*` | 共享内容审核（approve / reject / delete / quality / grants） |
| GET | `/capabilities/approvals` | 能力中心统一审批队列（只读，动作走原域端点） |
| PUT | `/apps/:kind/:app_id/owner` | 转移能力归属（负责人） |
| GET/PUT | `/portal` | 门户页配置（是否公开、下载地址覆盖、说明文字） |
| GET/PUT | `/connectors` | 连接器目录管理 |

## 其他

| 路径 | 说明 |
|---|---|
| `/`、`/portal` | 门户首页（产品 HTML 面，纯 HTML + CSS） |
| `/admin/` | webadmin SPA（go:embed 内嵌） |
| `/healthz` | 健康探针（JSON，DB Ping，503 = DB 不可用） |

> 未列出的端点与完整字段说明见仓库 `server/docs/03-api-reference.md`。
